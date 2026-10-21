import { AsyncLocalStorage } from "node:async_hooks";
import type { Agent, AgentOptions } from "@deepseek-ai/dsh-agent";
import { parentAgentOptionsForDelegation, SubagentError } from "@deepseek-ai/dsh-subagent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { DshAgent, DshLlmRuntime } from "./dsh-types.js";
import type { DsmmRoleId } from "./roles.js";
import { isDsmmRoleId } from "./roles.js";
import type { DsmmInvocationOptions, DsmmInvocationLevel, DsmmModelRoute, DsmmSettings, DsmmResolvedRoleRuntimePolicy } from "./settings.js";
import { freezeSettings, normalizeLevelOverride } from "./settings.js";
import type { DsmmRouteSource, DsmmInvocationView } from "./profile-types.js";
import type { ChildAdmissionCapture } from "./child-capture.js";
import { resolveRoleRuntimePolicy } from "./routing-policy.js";
import { selectInitialModelRouteChoice, sameExactModelRoute } from "./role-routing.js";
import { modelRouteFromCall, modelRouteToCall, projectModelRouteParameters, withRouteEffort } from "./role-llm.js";
import { configuredModelParameterPolicy, resolvedModelParameterPolicy } from "./model-parameter-policy.js";
import type { ResolvedModelParameterPolicy } from "./model-parameter-policy.js";

export interface ResolvedRoleInvocation {
  readonly target: DsmmRoleId;
  readonly requestedLevel?: DsmmInvocationLevel;
  readonly effectiveLevel: DsmmInvocationLevel;
  readonly routeSource: DsmmRouteSource;
  readonly initialRoute: DsmmModelRoute;
  readonly candidates: readonly DsmmModelRoute[];
  readonly policy: DsmmResolvedRoleRuntimePolicy;
  readonly exactEffort: boolean;
  readonly requestedRoute?: DsmmModelRoute;
  readonly selectedCandidate?: DsmmModelRoute;
  readonly requestedPolicy?: DsmmResolvedRoleRuntimePolicy;
  readonly modelParameterPolicy?: ResolvedModelParameterPolicy;
  readonly effortSource?: "native" | "dsmm-config";
}
const scoped = new AsyncLocalStorage<{ parent: DshAgent; invocation: ResolvedRoleInvocation }>();
const captured = new WeakMap<DshAgent, ResolvedRoleInvocation>();
const originalCaptures = new WeakMap<DshAgent, ChildAdmissionCapture>();
export function duringRoleInvocation<T>(parent: DshAgent, invocation: ResolvedRoleInvocation, operation: () => T): T {
  return scoped.run({ parent, invocation }, operation);
}
export function currentRoleInvocation(parent: DshAgent, target: DsmmRoleId): ResolvedRoleInvocation | undefined {
  const current = scoped.getStore();
  return current?.parent === parent && current.invocation.target === target ? current.invocation : undefined;
}
export function bindRoleInvocation(agent: DshAgent, invocation: ResolvedRoleInvocation, original?: ChildAdmissionCapture): void {
  captured.set(agent, invocation);
  if (original === undefined) originalCaptures.delete(agent); else originalCaptures.set(agent, original);
}
export function capturedRoleInvocation(agent: DshAgent): ResolvedRoleInvocation | undefined { return captured.get(agent); }
export function capturedOriginalRoleInvocation(agent: DshAgent): ChildAdmissionCapture["invocation"] | undefined { return originalCaptures.get(agent)?.invocation; }

/** Complete selections replace model and effort together; effort-only selections narrow candidates. */
export async function resolveRoleInvocation(parent: Agent, target: DsmmRoleId, settings: DsmmSettings, signal: AbortSignal, options: DsmmInvocationOptions = {}, nativeOptions?: AgentOptions, parameterPolicy?: ResolvedModelParameterPolicy): Promise<ResolvedRoleInvocation> {
  if (!isDsmmRoleId(target) || target === "dsmm-orchestrator") throw new SubagentError("Unknown DSMM delegation target", "UNAUTHORIZED");
  if (Object.keys(options).some(key => key !== "level" && key !== "route")) throw new SubagentError("Unknown DSMM invocation parameter", "UNSUPPORTED_CAPABILITY");
  const level = options.level ?? "normal";
  if (!["normal", "low", "high", "max"].includes(level)) throw new SubagentError("Unsupported DSMM invocation level", "UNSUPPORTED_CAPABILITY");
  if (options.route !== undefined && !settings.subagents.allowRouteOverride) throw new SubagentError("DSMM invocation route override is not admitted", "UNAUTHORIZED");
  const inherited = parentAgentOptionsForDelegation(parent);
  if (inherited.provider === undefined || inherited.model === undefined) throw new Error("DSMM role delegation requires an inherited provider/model");
  let route: DsmmModelRoute = { provider: inherited.provider, model: inherited.model, ...(inherited.reasoningEffort === undefined ? {} : { reasoningEffort: inherited.reasoningEffort }) };
  let source: DsmmRouteSource = "inherited";
  let effortSource: "native" | "dsmm-config" = "native";
  const policy = resolveRoleRuntimePolicy(settings, target);
  if (policy.primary !== undefined) { route = { ...policy.primary }; source = "primary"; effortSource = "dsmm-config"; }
  let exactEffort = false;
  let fixed = false;
  let candidateEffort: string | undefined;
  const apply = (raw: unknown, nextSource: DsmmRouteSource): void => {
    const override = normalizeLevelOverride(raw);
    if (override.provider !== undefined) route = { ...override };
    else { route = withRouteEffort(route, override.reasoningEffort); candidateEffort = override.reasoningEffort; }
    exactEffort = override.reasoningEffort !== undefined;
    source = nextSource;
    effortSource = "dsmm-config";
  };
  if (level !== "normal") {
    const override = settings.roleRouting[target]?.levels?.[level];
    if (override === undefined) throw new SubagentError("DSMM invocation level has no configured route", "UNSUPPORTED_CAPABILITY");
    apply(override, "level");
  }
  // Native host AgentOptions remain an explicit selection, not a model-facing permission grant.
  if (nativeOptions?.provider !== undefined || nativeOptions?.model !== undefined) {
    route = { provider: nativeOptions.provider ?? route.provider, model: nativeOptions.model ?? route.model,
      ...(nativeOptions.reasoningEffort === undefined ? {} : { reasoningEffort: nativeOptions.reasoningEffort }) };
    fixed = true; candidateEffort = undefined;
    effortSource = "native";
  } else if (nativeOptions?.reasoningEffort !== undefined) {
    route = withRouteEffort(route, nativeOptions.reasoningEffort); candidateEffort = nativeOptions.reasoningEffort;
    effortSource = "native";
  }
  if (options.route !== undefined) { apply(options.route, "invocation-route"); fixed = options.route.provider !== undefined; }
  const initialFallbacks = policy.fallbackRoutes.map(fallback => candidateEffort === undefined ? { ...fallback } : withRouteEffort(fallback, candidateEffort));
  const initialCandidates = [route, ...fixed ? [] : initialFallbacks];
  const llm = parent.ctx.get("llm") as DshLlmRuntime | undefined;
  if (llm === undefined) throw new Error("DSMM invocation requires the parent's native LLM service");
  const admission = parent.ctx.get("dsmmProfileRuntime")?.admission(parent as unknown as DshAgent);
  const modelParameterPolicy = parameterPolicy ?? capturedRoleInvocation(parent as unknown as DshAgent)?.modelParameterPolicy
    ?? (admission === undefined ? configuredModelParameterPolicy(settings) : resolvedModelParameterPolicy(admission));
  const project = (candidate: DsmmModelRoute, source: "native" | "dsmm-config") => modelRouteFromCall(projectModelRouteParameters(candidate, source, modelParameterPolicy.mode !== "native-defaults"));
  const projected = initialCandidates.map((candidate, index) => project(candidate, index === 0 || candidateEffort !== undefined ? effortSource : "dsmm-config"));
  const rawResolver = modelParameterPolicy.mode === "passthrough" ? parent.ctx.get("dsmmLlmRoutes") : undefined;
  const selected = await selectInitialModelRouteChoice(llm, projected, signal, rawResolver === undefined ? undefined : {
    async resolveRoute(candidate, signal) {
      const checked = await rawResolver.resolveRoute(candidate, signal);
      const index = projected.findIndex(route => sameExactModelRoute(route, candidate));
      if ((index === 0 || candidateEffort !== undefined) && effortSource === "native") {
        const { customParameters: _parameters, ...native } = modelRouteToCall(candidate);
        if (llm.resolveCallConfig === undefined) throw new Error("Native model intent requires native metadata preparation");
        await llm.resolveCallConfig(native, signal);
      }
      return checked;
    },
  });
  const selectedIndex = projected.findIndex(candidate => sameExactModelRoute(candidate, selected.requestedRoute));
  if (selectedIndex < 0) throw new Error("DSMM selected route has no original candidate");
  signal.throwIfAborted();
  const fallbackRoutes = options.route?.provider !== undefined ? [] : level === "normal" && options.route === undefined ? policy.fallbackRoutes : initialFallbacks;
  const effectiveFallbacks = fallbackRoutes.map(candidate => project(candidate, candidateEffort !== undefined ? effortSource : "dsmm-config"));
  const candidates = [project(route, effortSource), ...effectiveFallbacks];
  const selectedSource = selectedIndex === 0 || candidateEffort !== undefined ? effortSource : "dsmm-config";
  return freezeSettings({ target, ...(options.level === undefined ? {} : { requestedLevel: options.level }), effectiveLevel: level,
    routeSource: source, initialRoute: project(selected.route, selectedSource), selectedCandidate: selected.requestedRoute, requestedRoute: initialCandidates[selectedIndex], candidates, exactEffort,
    effortSource: selectedSource, modelParameterPolicy,
    requestedPolicy: { ...policy, primary: route, fallbackRoutes },
    policy: { ...policy, primary: project(route, effortSource), fallbackRoutes: effectiveFallbacks } });
}
export function invocationAgentOptions(invocation: ResolvedRoleInvocation, options?: AgentOptions): AgentOptions {
  const route = invocation.initialRoute;
  return { ...options, ...route, reasoningEffort: route.reasoningEffort === undefined ? undefined : ReasoningEffortId(route.reasoningEffort) };
}
export function invocationView(invocation: ResolvedRoleInvocation, label: string, mode: DsmmInvocationView["mode"], ids: Pick<DsmmInvocationView, "runId" | "childId" | "jobId"> = {}) {
  return { role: invocation.target, label, level: invocation.effectiveLevel, routeSource: invocation.routeSource, route: { ...invocation.initialRoute }, mode, ...ids };
}
