import type { DshAgent, DshContext, DshLlmRuntime } from "./dsh-types.js";
import { applyModelRoute, clearRoleRouteLock, effectiveRoleFallbackRoutes, establishRolePolicy, latestNativeModelSelection, nativeModelSelectionWasAccepted, orderedModelRoutes, persistedRoleRoute, pinRoleRoute, roleRouteLock, selectInitialModelRoute, sameExactModelRoute, sameModelRoute, takeAdmittedRecoveryRoute } from "./role-routing.js";
import type { NativeModelSelectionIntent } from "./role-routing.js";
import { resolveAdmittedDsmmRole } from "./role-policy.js";
import { childOwnedSessionEvents, sessionEvents } from "./session-scope.js";
import { isCurrentRecoveryStep } from "./recovery-policy.js";
import type { DsmmSettingsGetter } from "./settings.js";
import type { DeepworkModeController } from "./state.js";
import { capturedRoleInvocation } from "./role-invocation.js";
import { modelRouteFromCall } from "./role-llm.js";
import type { DsmmLlmRouteResolver } from "./role-llm.js";
import { configuredModelParameterPolicy, resolvedModelParameterPolicy } from "./model-parameter-policy.js";
import { registerRuntimeRecovery } from "./runtime-recovery.js";

export function registerModelRouting(ctx: DshContext, controller: DeepworkModeController, getSettings: DsmmSettingsGetter): void {
  const installedContexts = new WeakSet<DshContext>();
  const install = (readyCtx: DshContext): void => {
    if (installedContexts.has(readyCtx) || readyCtx.on === undefined) return;
    installedContexts.add(readyCtx);
    const lockedAgents = new Set<DshAgent>();
    const assembledSelections = new WeakMap<DshAgent, { signal: AbortSignal; intent?: NativeModelSelectionIntent }>();
    let dispose: unknown, disposeAgent: unknown, disposeAssembly: unknown;
    try {
      registerRuntimeRecovery(readyCtx, controller, getSettings);
      disposeAssembly = readyCtx.on("system-prompt/assemble", async (_assembly, context: { agent?: DshAgent; signal?: AbortSignal }, next) => {
        if (context.agent !== undefined && context.signal !== undefined) assembledSelections.set(context.agent, { signal: context.signal, intent: latestNativeModelSelection(context.agent) });
        return next();
      }, { prepend: true });
      dispose = readyCtx.on("agent/request", async (frame, next) => {
        const downstream = await next();
        if (frame.signal.aborted) return downstream;
        const settings = getSettings(frame.agent), admission = getSettings.admission?.(frame.agent);
        const parameterPolicy = admission === undefined ? configuredModelParameterPolicy(settings) : resolvedModelParameterPolicy(admission);
        if (!settings.modules.deepwork.enabled) return downstream;
        const ordinaryRoot = frame.agent.session.header?.origin !== "subagent";
        const admitted = takeAdmittedRecoveryRoute(frame);
        const role = resolveAdmittedDsmmRole(frame.agent, settings, controller.active(frame.agent, settings.defaultActive));
        const policy = role === undefined ? undefined : settings.roleRouting[role];
        const invocation = capturedRoleInvocation(frame.agent);
        const primary = invocation?.initialRoute ?? policy?.primary;
        const identity = await establishRolePolicy(frame, settings, role, readyCtx, admission?.epoch);
        frame.signal.throwIfAborted();
        const fallbacks = effectiveRoleFallbackRoutes(settings, role);
        const currentStep = isCurrentRecoveryStep(ordinaryRoot ? sessionEvents(frame.agent.session) : childOwnedSessionEvents(frame.agent.session), frame.turn, frame.step);
        if (role === undefined || identity === undefined || !currentStep) return downstream;
        let lock = roleRouteLock(frame.agent, identity);
        const exactPolicy = invocation === undefined ? primary !== undefined || policy?.fallbackRoutes !== undefined || fallbacks.length > 0
          : invocation.routeSource !== "inherited" || invocation.exactEffort || fallbacks.length > 0;
        const captured = assembledSelections.get(frame.agent);
        const manual = captured?.signal === frame.signal ? captured.intent : undefined;
        if (ordinaryRoot) {
          const selected = modelRouteFromCall(downstream);
          if (lock === undefined || !sameExactModelRoute(lock.route, selected) || lock.manualSelectionSeq !== manual?.seq) {
            const generation = (lock?.generation ?? -1) + 1;
            lock = pinRoleRoute(frame.agent, identity, selected, [selected]);
            lock.manualSelectionSeq = manual?.seq; lock.generation = generation;
            lockedAgents.add(frame.agent);
          }
          return downstream;
        }
        const llm = frame.agent.ctx?.get?.<DshLlmRuntime>("llm") ?? readyCtx.get?.<DshLlmRuntime>("llm") ?? readyCtx.llm;
        if (manual !== undefined && lock?.manualSelectionSeq !== manual.seq
          && (sameModelRoute(downstream, manual.route) && downstream.reasoningEffort === manual.route.reasoningEffort || nativeModelSelectionWasAccepted(frame.agent, manual))) {
          const selected = modelRouteFromCall(downstream);
          const generation = (lock?.generation ?? -1) + 1;
          lock = pinRoleRoute(frame.agent, identity, selected, [selected, ...fallbacks], { preserveCandidates: parameterPolicy.mode === "native-defaults" });
          lock.manualSelectionSeq = manual.seq; lock.generation = generation;
          lockedAgents.add(frame.agent);
        }
        // A consumed explicit selection must not undo an admitted fallback.
        if (lock?.manualSelectionSeq !== undefined) return applyModelRoute(downstream, lock.route);
        if (admitted !== undefined) return applyModelRoute(downstream, admitted);
        const accepted = persistedRoleRoute(frame, primary, fallbacks, identity);
        if (lock !== undefined && accepted !== undefined && !sameExactModelRoute(accepted, lock.route)) {
          lock.route = { ...accepted };
          lock.candidateIndex = lock.candidates.findIndex(candidate => sameExactModelRoute(candidate, accepted));
          lock.generation += 1; lock.startupSettled = true; lock.retries = 0; lock.rateLimits = 0;
        }
        if (lock === undefined) {
          const inherited = modelRouteFromCall(downstream);
          const candidates = invocation?.candidates ?? orderedModelRoutes([primary ?? inherited, ...fallbacks]);
          const selected = accepted ?? invocation?.initialRoute ?? (exactPolicy ? await selectInitialModelRoute(llm ?? {} as DshLlmRuntime, candidates, frame.signal,
            parameterPolicy.mode === "passthrough" ? readyCtx.get?.<DsmmLlmRouteResolver>("dsmmLlmRoutes") : undefined) : inherited);
          frame.signal.throwIfAborted();
          lock = pinRoleRoute(frame.agent, identity, selected, candidates, { preserveCandidates: parameterPolicy.mode === "native-defaults", initialCandidate: accepted ?? invocation?.selectedCandidate });
          if (accepted !== undefined) lock.startupSettled = true;
          lockedAgents.add(frame.agent);
        }
        return applyModelRoute(downstream, lock.route);
      }, { prepend: true });
      disposeAgent = readyCtx.on("agent/disposed", ({ agent }: { agent: DshAgent }) => { lockedAgents.delete(agent); clearRoleRouteLock(agent); }, { global: true });
    } catch (error) {
      installedContexts.delete(readyCtx);
      if (typeof dispose === "function") dispose();
      if (typeof disposeAssembly === "function") disposeAssembly();
      throw error;
    }
    readyCtx.effect?.(() => () => {
      for (const agent of lockedAgents) clearRoleRouteLock(agent);
      lockedAgents.clear(); installedContexts.delete(readyCtx);
      if (typeof disposeAgent === "function") disposeAgent();
      if (typeof disposeAssembly === "function") disposeAssembly();
      if (typeof dispose === "function") dispose();
    });
  };
  if (ctx.get !== undefined) install(ctx);
  else if (ctx.inject !== undefined) ctx.inject(["llm"], install);
  else if (Object.prototype.hasOwnProperty.call(ctx, "llm") && Object.prototype.hasOwnProperty.call(ctx, "on")) install(ctx);
}
