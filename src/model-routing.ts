import { LlmError } from "@deepseek-ai/dsh-llm";
import type { AgentRequestFrame, DshLlmCallConfig, DshAgent, DshContext, DshLlmRuntime, DshModelSelection } from "./dsh-types.js";
import { DsmmAwareLlmRuntime } from "./host-llm.js";
import { applyModelRoute, clearRoleRouteLock, currentRolePolicyState, currentRoleRouteLock, effectiveRoleFallbackRoutes, establishRolePolicy, hostModelSelection, latestModelSelectionSeq, latestNativeModelSelection, liveRolePolicyIdentity, nativeModelSelectionWasAccepted, orderedModelRoutes, persistedRoleRoute, pinRoleRoute, restoreRolePolicyAndLock, roleRouteLock, selectInitialModelRoute, selectInitialModelRouteChoice, selectModelRouteForNextStep, sameExactModelRoute, sameModelRoute, takeAdmittedRecoveryRoute } from "./role-routing.js";
import type { NativeModelSelectionIntent } from "./role-routing.js";
import { childOwnedSessionEvents, sessionEvents } from "./session-scope.js";
import { isCurrentRecoveryStep } from "./recovery-policy.js";
import type { DsmmSettingsGetter, DsmmSettings, DsmmProfileAdmission, DsmmModelRoute } from "./settings.js";
import type { DeepworkModeController } from "./state.js";
import { capturedRoleInvocation } from "./role-invocation.js";
import { resolveAdmittedDsmmRole } from "./role-policy.js";
import type { DsmmRoleId } from "./roles.js";
import { modelRouteFromCall, modelRouteToCall, projectModelRouteParameters } from "./role-llm.js";
import type { DsmmLlmRouteResolver } from "./role-llm.js";
import { configuredModelParameterPolicy, resolvedModelParameterPolicy } from "./model-parameter-policy.js";
import { registerRuntimeRecovery } from "./runtime-recovery.js";
import { captureRequestRouting, captureRequestRoute } from "./request-routing.js";

type RequestPreparation = (frame: AgentRequestFrame, proposal: DshLlmCallConfig, assertCurrent?: () => void) => Promise<DshLlmCallConfig>;
const preparations = new WeakMap<DshAgent, RequestPreparation>();
export async function prepareDsmmRequest(frame: AgentRequestFrame, proposal: DshLlmCallConfig, assertCurrent: () => void): Promise<DshLlmCallConfig> {
  const prepare = preparations.get(frame.agent);
  if (!prepare) throw new Error("Admitted Agent has no request preparation binding");
  return prepare(frame, proposal, assertCurrent);
}
export function registerModelRouting(ctx: DshContext, controller: DeepworkModeController, getSettings: DsmmSettingsGetter, agent?: DshAgent): void {
  const installedContexts = new WeakSet<DshContext>();
  const install = (readyCtx: DshContext): void => {
    if (installedContexts.has(readyCtx) || readyCtx.on === undefined) return;
    installedContexts.add(readyCtx);
    const lockedAgents = new Set<DshAgent>();
    let active = true;
    const assembledSelections = new WeakMap<DshAgent, { signal: AbortSignal; intent?: NativeModelSelectionIntent }>();
    let dispose: unknown, disposeAgent: unknown, disposeAssembly: unknown, disposeFence: unknown;
    try {
      const owned = agent !== undefined && readyCtx.get?.("llm") instanceof DsmmAwareLlmRuntime;
      let recovery: RequestPreparation | undefined;
      registerRuntimeRecovery(readyCtx, controller, getSettings, prepare => { recovery = prepare; });
      disposeAssembly = readyCtx.on("system-prompt/assemble", async (_assembly, context: { agent?: DshAgent; signal?: AbortSignal }, next) => {
        if (context.agent !== undefined && context.signal !== undefined) assembledSelections.set(context.agent, { signal: context.signal, intent: latestNativeModelSelection(context.agent) });
        return next();
      }, { prepend: true });
      const prepare: RequestPreparation = async (frame, proposal, assertCurrent = () => frame.signal.throwIfAborted()) => {
        if (frame.signal.aborted) return proposal;
        const decision = captureRequestRouting(frame, readyCtx, controller, getSettings, () => {
          if (!active) throw new Error("DSMM routing owner retired");
          assertCurrent();
        });
        const downstream = recovery === undefined ? proposal : await recovery(frame, proposal);
        if (frame.signal.aborted) return downstream;
        decision.assertCurrent();
        const { settings, admission, role, configuredRoot } = decision;
        const parameterPolicy = admission === undefined ? configuredModelParameterPolicy(settings) : resolvedModelParameterPolicy(admission);
        const projectedRoute = (route: DsmmModelRoute, effortSource: "native" | "dsmm-config" = "dsmm-config") =>
          modelRouteFromCall(projectModelRouteParameters(route, effortSource, parameterPolicy.mode === "passthrough"));
        const assertFixedRoute = (config: DshLlmCallConfig, route: DsmmModelRoute): void => {
          if (hostModelSelection(frame.agent) !== undefined
            && (!sameModelRoute(config, route) || config.reasoningEffort !== route.reasoningEffort)) {
            throw new LlmError("The request route differs from the model fixed for this step", "INVALID_PREPARED_CALL");
          }
        };
        const matchingRouteResult = (config: DshLlmCallConfig, route: DsmmModelRoute, effortSource: "native" | "dsmm-config" = "dsmm-config"): DshLlmCallConfig => {
          const projected = projectedRoute(route, effortSource);
          assertFixedRoute(config, projected);
          const { provider: _provider, model: _model, reasoningEffort: _effort, ...requestControls } = config;
          const normalized = modelRouteFromCall({ ...requestControls, provider: projected.provider, model: projected.model,
            ...(projected.reasoningEffort === undefined ? {} : { reasoningEffort: projected.reasoningEffort }) });
          const { provider: _normalizedProvider, model: _normalizedModel, reasoningEffort: _normalizedEffort, ...controls } = normalized;
          return modelRouteToCall({ ...controls, ...projected });
        };
        const replacementRouteResult = (config: DshLlmCallConfig, route: DsmmModelRoute, effortSource?: "native" | "dsmm-config"): DshLlmCallConfig => {
          const projected = projectedRoute(route, effortSource);
          assertFixedRoute(config, projected);
          return applyModelRoute(config, projected);
        };
        if (!settings.modules.deepwork.enabled) { captureRequestRoute(frame, decision); return downstream; }
        const ordinaryRoot = frame.agent.session.header?.origin !== "subagent";
        const admitted = takeAdmittedRecoveryRoute(frame);
        const policy = role === undefined ? undefined : settings.roleRouting[role];
        const invocation = capturedRoleInvocation(frame.agent);
        const primary = invocation?.initialRoute ?? policy?.primary;
        const identity = await establishRolePolicy(frame, settings, role, readyCtx, admission?.epoch);
        decision.assertCurrent();
        frame.signal.throwIfAborted();
        const fallbacks = effectiveRoleFallbackRoutes(settings, role);
        const currentStep = isCurrentRecoveryStep(ordinaryRoot ? sessionEvents(frame.agent.session) : childOwnedSessionEvents(frame.agent.session), frame.turn, frame.step);
        if (configuredRoot && !currentStep) throw new Error("Configured root has no current request step");
        if (role === undefined || identity === undefined || !currentStep) { captureRequestRoute(frame, decision); return downstream; }
        let lock = roleRouteLock(frame.agent, identity);
        const exactPolicy = invocation === undefined ? primary !== undefined || policy?.fallbackRoutes !== undefined || fallbacks.length > 0
          : invocation.routeSource !== "inherited" || invocation.exactEffort || fallbacks.length > 0;
        const captured = assembledSelections.get(frame.agent);
        const manual = captured?.signal === frame.signal ? captured.intent : undefined;
        if (ordinaryRoot && !configuredRoot) {
          const selected = modelRouteFromCall(downstream);
          if (lock === undefined || !sameExactModelRoute(lock.route, selected) || lock.manualSelectionSeq !== manual?.seq) {
            const generation = (lock?.generation ?? -1) + 1;
            lock = pinRoleRoute(frame.agent, identity, selected, [selected]);
            lock.manualSelectionSeq = manual?.seq; lock.generation = generation;
            lockedAgents.add(frame.agent);
          }
          captureRequestRoute(frame, decision, "native");
          return downstream;
        }
        const llm = frame.agent.ctx?.get?.<DshLlmRuntime>("llm") ?? readyCtx.get?.<DshLlmRuntime>("llm") ?? readyCtx.llm;
        const assembledManual = manual !== undefined && sameModelRoute(downstream, manual.route) && downstream.reasoningEffort === manual.route.reasoningEffort;
        if (!configuredRoot && manual !== undefined && lock?.manualSelectionSeq !== manual.seq
          && (assembledManual || nativeModelSelectionWasAccepted(frame.agent, manual))) {
          const selected = assembledManual ? modelRouteFromCall(downstream) : manual.route;
          const generation = (lock?.generation ?? -1) + 1;
          lock = pinRoleRoute(frame.agent, identity, selected, [selected, ...fallbacks], { preserveCandidates: parameterPolicy.mode === "native-defaults" });
          lock.manualSelectionSeq = manual.seq; lock.generation = generation;
          lockedAgents.add(frame.agent);
        }
        // A consumed explicit selection must not undo an admitted fallback.
        if (!configuredRoot && lock?.manualSelectionSeq !== undefined) {
          captureRequestRoute(frame, decision, "native");
          return lock.candidateIndex > 0 ? replacementRouteResult(downstream, lock.route, "native") : matchingRouteResult(downstream, lock.route, "native");
        }
        if (admitted !== undefined) { captureRequestRoute(frame, decision, lock?.effortSource); return replacementRouteResult(downstream, admitted, lock?.effortSource); }
        const accepted = persistedRoleRoute(frame, primary, fallbacks, identity, configuredRoot);
        if (lock !== undefined && accepted !== undefined && !sameExactModelRoute(accepted, lock.route)) {
          lock.route = { ...accepted };
          lock.candidateIndex = lock.candidates.findIndex(candidate => sameExactModelRoute(candidate, accepted));
          lock.generation += 1; lock.startupSettled = true; lock.retries = 0; lock.rateLimits = 0;
        }
        if (lock === undefined) {
          const inherited = primary === undefined ? modelRouteFromCall(downstream) : undefined;
          const candidates = invocation?.candidates ?? orderedModelRoutes([primary ?? inherited!, ...fallbacks]);
          const resolver = parameterPolicy.mode === "passthrough" ? readyCtx.get?.<DsmmLlmRouteResolver>("dsmmLlmRoutes") : undefined;
          const choice = configuredRoot ? await selectInitialModelRouteChoice(llm ?? {} as DshLlmRuntime, candidates, frame.signal, resolver,
            parameterPolicy.mode === "native-defaults" ? route => modelRouteFromCall(projectModelRouteParameters(route, primary === undefined && sameExactModelRoute(route, inherited!) ? "native" : "dsmm-config", false)) : undefined, decision.assertCurrent) : undefined;
          const selected = choice?.proposal ?? accepted ?? invocation?.initialRoute ?? (exactPolicy ? await selectInitialModelRoute(llm ?? {} as DshLlmRuntime, candidates, frame.signal, resolver, decision.assertCurrent) : inherited!);
          decision.assertCurrent();
          frame.signal.throwIfAborted();
          lock = pinRoleRoute(frame.agent, identity, selected, candidates, { preserveCandidates: parameterPolicy.mode === "native-defaults", initialCandidate: choice?.requestedRoute ?? accepted ?? invocation?.selectedCandidate });
          if (configuredRoot) lock.effortSource = primary === undefined && lock.candidateIndex === 0 ? "native" : "dsmm-config";
          if (accepted !== undefined) lock.startupSettled = true;
          lockedAgents.add(frame.agent);
        }
        captureRequestRoute(frame, decision, configuredRoot ? lock.effortSource : undefined);
        return lock.candidateIndex > 0
          ? replacementRouteResult(downstream, lock.route, lock.effortSource)
          : matchingRouteResult(downstream, lock.route, lock.effortSource);
      };
      if (owned) {
        preparations.set(agent, prepare);
        dispose = () => { if (preparations.get(agent) === prepare) preparations.delete(agent); };
        disposeFence = readyCtx.on("agent/request", async (frame, next) => {
          const settings = getSettings(frame.agent), admission = getSettings.admission?.(frame.agent);
          const configuredRoot = admission !== undefined && frame.agent.session.header?.origin !== "subagent"
            && settings.modules.deepwork.enabled && settings.rootModelPolicy === "configured"
            && resolveAdmittedDsmmRole(frame.agent, settings, controller.active(frame.agent, settings.defaultActive)) !== undefined;
          const expected = configuredRoot && hostModelSelection(frame.agent) !== undefined ? currentRoleRouteLock(frame.agent) : undefined;
          const proposal = await next();
          if (expected !== undefined && (currentRoleRouteLock(frame.agent) !== expected || !sameModelRoute(proposal, expected.route)
            || proposal.reasoningEffort !== expected.route.reasoningEffort)) {
            throw new LlmError("The request route differs from the model fixed for this step", "INVALID_PREPARED_CALL");
          }
          return proposal;
        }, { prepend: true });
      } else dispose = readyCtx.on("agent/request", async (frame, next) => prepare(frame, await next()), { prepend: true });
      disposeAgent = readyCtx.on("agent/disposed", ({ agent }: { agent: DshAgent }) => { lockedAgents.delete(agent); clearRoleRouteLock(agent); }, { global: true });
    } catch (error) {
      installedContexts.delete(readyCtx);
      if (typeof dispose === "function") dispose();
      if (typeof disposeAssembly === "function") disposeAssembly();
      if (typeof disposeFence === "function") disposeFence();
      throw error;
    }
    readyCtx.effect?.(() => () => {
      active = false;
      for (const agent of lockedAgents) clearRoleRouteLock(agent);
      lockedAgents.clear(); installedContexts.delete(readyCtx);
      if (typeof disposeAgent === "function") disposeAgent();
      if (typeof disposeAssembly === "function") disposeAssembly();
      if (typeof disposeFence === "function") disposeFence();
      if (typeof dispose === "function") dispose();
    });
  };
  if (ctx.get !== undefined) install(ctx);
  else if (ctx.inject !== undefined) ctx.inject(["llm"], install);
  else if (Object.prototype.hasOwnProperty.call(ctx, "llm") && Object.prototype.hasOwnProperty.call(ctx, "on")) install(ctx);
}

export interface DsmmAdmissionRouteInfo {
  readonly settings: DsmmSettings;
  readonly epoch?: string;
  readonly admission?: DsmmProfileAdmission;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export interface DsmmAdmissionRouteInstallation {
  readonly selection: DshModelSelection;
  rollback(): void;
}

export interface DsmmPreparedAdmissionRoute {
  readonly admission?: DsmmProfileAdmission;
  readonly role: DsmmRoleId;
  readonly restoresConfiguredPrimary: boolean;
  readonly preflightFailure?: unknown;
  install(currentAdmission?: DsmmProfileAdmission): DsmmAdmissionRouteInstallation | undefined;
}

/** Preflight immutable route metadata without materializing adapter defaults as Agent selection. */
export async function prepareAdmissionModelRoute(ctx: DshContext, controller: DeepworkModeController, agent: DshAgent, info: DsmmAdmissionRouteInfo): Promise<DsmmPreparedAdmissionRoute | undefined> {
  const model = hostModelSelection(agent), { settings } = info;
  if (model === undefined || !settings.modules.deepwork.enabled) return undefined;
  const subagent = agent.session.header?.origin === "subagent";
  const configuredRoot = !subagent && settings.rootModelPolicy === "configured";
  if (!subagent && !configuredRoot) return undefined;
  const activeRole = resolveAdmittedDsmmRole(agent, settings, controller.active(agent, settings.defaultActive));
  const role = activeRole ?? (configuredRoot ? resolveAdmittedDsmmRole(agent, settings, true) : undefined);
  if (role === undefined) return undefined;
  const parameterPolicy = info.admission === undefined ? configuredModelParameterPolicy(settings) : resolvedModelParameterPolicy(info.admission);
  const invocation = capturedRoleInvocation(agent);
  const fallbacks = effectiveRoleFallbackRoutes(settings, role);
  const primary = invocation?.initialRoute ?? settings.roleRouting[role]?.primary;
  if (configuredRoot && primary === undefined || subagent && invocation === undefined) return undefined;
  const candidates = invocation?.candidates ?? orderedModelRoutes([primary!, ...fallbacks]);
  let choice: Awaited<ReturnType<typeof selectInitialModelRouteChoice>> | undefined;
  let unavailable: unknown;
  try {
    if (configuredRoot) {
      const llm = agent.ctx?.get?.<DshLlmRuntime>("llm") ?? ctx.get?.<DshLlmRuntime>("llm") ?? ctx.llm;
      const resolver = parameterPolicy.mode === "passthrough" ? ctx.get?.<DsmmLlmRouteResolver>("dsmmLlmRoutes") : undefined;
      choice = await selectInitialModelRouteChoice(llm ?? {} as DshLlmRuntime, candidates, info.signal, resolver,
        configuredRoot && parameterPolicy.mode === "native-defaults"
          ? route => modelRouteFromCall(projectModelRouteParameters(route, "dsmm-config", false))
          : undefined,
        info.assertCurrent);
    }
  } catch (error) {
    if (!configuredRoot || activeRole !== undefined) throw error;
    unavailable = error;
  }
  info.assertCurrent();
  info.signal.throwIfAborted();
  const proposal = choice?.proposal ?? invocation?.initialRoute;
  const requested = choice?.requestedRoute ?? invocation?.selectedCandidate;
  const effortSource = configuredRoot ? "dsmm-config" : invocation?.effortSource ?? "dsmm-config";
  const prepared: DsmmPreparedAdmissionRoute = Object.freeze({ admission: info.admission, role,
    restoresConfiguredPrimary: configuredRoot && primary !== undefined,
    ...(unavailable === undefined ? {} : { preflightFailure: unavailable }),
    install(currentAdmission?: DsmmProfileAdmission): DsmmAdmissionRouteInstallation | undefined {
      if (currentAdmission !== info.admission) return undefined;
      const currentRole = resolveAdmittedDsmmRole(agent, settings, controller.active(agent, settings.defaultActive));
      if (currentRole !== role) return undefined;
      if (unavailable !== undefined) throw unavailable;
      if (proposal === undefined) return undefined;
      const previousPolicy = currentRolePolicyState(agent), previousLock = currentRoleRouteLock(agent), previousSelection = model.current();
      const identity = liveRolePolicyIdentity(agent, settings, role, info.epoch);
      if (identity === undefined) return undefined;
      const installedPolicy = currentRolePolicyState(agent)!;
      let lock = roleRouteLock(agent, identity);
      if (lock === undefined || !sameExactModelRoute(lock.route, proposal)) {
        lock = pinRoleRoute(agent, identity, proposal, candidates, { preserveCandidates: parameterPolicy.mode === "native-defaults",
          initialCandidate: requested });
      }
      lock.effortSource = effortSource;
      const selection = { provider: proposal.provider, model: proposal.model,
        ...(proposal.reasoningEffort === undefined ? {} : { reasoningEffort: proposal.reasoningEffort }) };
      selectModelRouteForNextStep(agent, selection);
      const installedSelectionSeq = latestModelSelectionSeq(agent);
      let rolledBack = false;
      return Object.freeze({ selection, rollback() {
        if (rolledBack) return;
        rolledBack = true;
        const current = model.current();
        let selectionFailure: unknown;
        try {
          if (current !== undefined && latestModelSelectionSeq(agent) === installedSelectionSeq && sameExactModelRoute(current, selection)) {
            if (previousSelection === undefined) throw new LlmError("The prior model selection cannot be restored", "INVALID_PREPARED_CALL");
            selectModelRouteForNextStep(agent, previousSelection);
          }
        } catch (error) { selectionFailure = error; }
        finally { restoreRolePolicyAndLock(agent, installedPolicy, lock!, previousPolicy, previousLock); }
        if (selectionFailure !== undefined) throw selectionFailure;
      } });
    },
  });
  return prepared;
}
