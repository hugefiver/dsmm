import { createUserMessage, expandAssistantStream } from "@deepseek-ai/dsh-llm";
import type { AssistantStreamRecord } from "@deepseek-ai/dsh-llm";
import type { AssistantStreamFrame } from "@deepseek-ai/dsh-agent";
import type { AgentRequestErrorFrame, DshAgent, DshAgentsRegistry, DshContext, DshEpochHeader, DshLlmFailure, DshLlmRuntime } from "./dsh-types.js";
import { foldDurableRecoveryWork, isCurrentRecoveryStep } from "./recovery-policy.js";
import { isDsmmRoleId } from "./roles.js";
import type { DsmmRoleId } from "./roles.js";
import { applyModelRoute, isUnavailableRouteFailure, latestNativeModelSelection, liveRolePolicyIdentity, recordAdmittedRecoveryRoute, roleRouteLock, sameExactModelRoute, selectInitialModelRouteChoice } from "./role-routing.js";
import { modelRouteFromCall, modelRouteFromHeader, projectModelRouteParameters } from "./role-llm.js";
import type { DsmmLlmRouteResolver } from "./role-llm.js";
import { childOwnedSessionEvents, resolveSelectedAgentPreset, sessionEvents } from "./session-scope.js";
import { resolveAdmittedDsmmRole as resolveEffectiveDsmmRole } from "./role-policy.js";
import { resolveRoleRuntimePolicy } from "./routing-policy.js";
import type { DsmmRecoveryRoute, DsmmSettingsGetter } from "./settings.js";
import type { DeepworkModeController } from "./state.js";
import { configuredModelParameterPolicy, resolvedModelParameterPolicy } from "./model-parameter-policy.js";

interface PendingRecoveryRoute {
  turn: number;
  step: number;
  route: DsmmRecoveryRoute;
  role?: DsmmRoleId;
  policy?: string;
  generation: number;
  failedRoute: DsmmRecoveryRoute;
  attempt: AttemptEvidence;
  manualSelectionSeq?: number;
}

interface AttemptEvidence {
  id: string;
  turn: number;
  step: number;
  revision: number;
  chunks: number;
  route: DsmmRecoveryRoute;
  header: DshEpochHeader;
  policy?: string;
  generation?: number;
  manualSelectionSeq?: number;
  valid: boolean;
  output: boolean;
  consumed: boolean;
  failure?: DshLlmFailure;
  seq?: number;
  eventType?: string;
}

interface ContinuationCounter {
  turn: number;
  count: number;
}

const installedContexts = new WeakSet<DshContext>();
const RECOVERY_WARNING = "dsmm runtime recovery refused an unproven or exhausted retry";
const CONTINUATION_WARNING = "dsmm runtime recovery continuation steering failed for turn";

function warnSafely(ctx: DshContext, message: string): void {
  try {
    ctx.logger?.warn(message);
  } catch {}
}

function recoveryEvents(agent: DshAgent): ReturnType<typeof sessionEvents> {
  return agent.session.header?.origin === "subagent" ? childOwnedSessionEvents(agent.session) : sessionEvents(agent.session);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRateLimit(failure: DshLlmFailure): boolean {
  if (["AUTH", "MISSING_CREDENTIAL", "INVALID_CREDENTIAL", "QUOTA", "ACCOUNT_QUOTA", "CONTEXT_WINDOW_EXCEEDED", "INVALID_ARGS", "CANCELLED", "ABORTED"].includes(failure.code) || failure.status === 402) return false;
  return failure.code === "RATE_LIMIT" || failure.status === 429;
}

function outputChunk(chunk: { type: string }): boolean {
  // Block boundaries and even empty fragments are protocol output, not proof of absence.
  return chunk.type !== "usage" && chunk.type !== "finish";
}

function positiveNoOutput(frame: AgentRequestErrorFrame, attempt: AttemptEvidence | undefined, consumed = false): attempt is AttemptEvidence {
  if (attempt === undefined || !attempt.valid || attempt.output || (attempt.consumed && !consumed) || attempt.failure !== frame.failure
    || attempt.turn !== frame.turn || attempt.step !== frame.step || attempt.eventType !== "assistant/attempt"
    || attempt.seq === undefined || attempt.route.provider !== frame.provider) return false;
  const events = recoveryEvents(frame.agent);
  if (frame.agent.session.requestHeader?.() !== attempt.header) return false;
  const settlements = events.filter((event) => "seq" in event && event.seq === attempt.seq);
  if (settlements.length !== 1) return false;
  const settlement = settlements[0];
  if (settlement?.type !== "assistant/attempt" || !isRecord(settlement.data)
    || settlement.data.turn !== frame.turn || settlement.data.step !== frame.step || !Array.isArray(settlement.data.stream)) return false;
  const later = events.slice(events.indexOf(settlement) + 1);
  if (later.some((event) => ["assistant/attempt", "assistant/message", "tool/call", "tool/result", "request/header", "step/start", "step/end", "turn/end"].includes(event.type))) return false;
  try {
    const chunks = expandAssistantStream(settlement.data.stream as AssistantStreamRecord[]);
    const finish = chunks.at(-1)?.chunk;
    return chunks.length === attempt.chunks && chunks.every(({ chunk }) => !outputChunk(chunk))
      && finish?.type === "finish" && finish.reason.kind === "error"
      && JSON.stringify(finish.reason.failure) === JSON.stringify(frame.failure);
  } catch { return false; }
}

export function registerRuntimeRecovery(ctx: DshContext, controller: DeepworkModeController, getSettings: DsmmSettingsGetter): void {
  if (installedContexts.has(ctx) || ctx.on === undefined) return;

  installedContexts.add(ctx);
  let pendingByAgent = new WeakMap<DshAgent, PendingRecoveryRoute>();
  let attemptsByAgent = new WeakMap<DshAgent, AttemptEvidence>();
  let continuationsByAgent = new WeakMap<DshAgent, ContinuationCounter>();
  const waits = new Set<AbortController>();
  let active = true;
  let disposeRequest: unknown;
  let disposeRequestError: unknown;
  let disposeTurnStopping: unknown;
  let disposeAssistantStream: unknown;
  const live = (agent: DshAgent): boolean => {
    const agents = ctx.get?.<DshAgentsRegistry>("agents");
    return agents === undefined || agent.id !== undefined && agents.get(agent.id) === agent;
  };

  const reset = (): void => {
    const request = disposeRequest;
    const requestError = disposeRequestError;
    const turnStopping = disposeTurnStopping;
    const assistantStream = disposeAssistantStream;
    active = false;
    for (const wait of waits) wait.abort();
    disposeRequest = undefined;
    disposeRequestError = undefined;
    disposeTurnStopping = undefined;
    pendingByAgent = new WeakMap<DshAgent, PendingRecoveryRoute>();
    attemptsByAgent = new WeakMap<DshAgent, AttemptEvidence>();
    continuationsByAgent = new WeakMap<DshAgent, ContinuationCounter>();
    installedContexts.delete(ctx);
    if (typeof assistantStream === "function") assistantStream();
    if (typeof turnStopping === "function") turnStopping();
    if (typeof requestError === "function") requestError();
    if (typeof request === "function") request();
  };

  try {
    disposeAssistantStream = ctx.on("agent/assistant-stream", ({ agent, frame }: { agent: DshAgent; frame: AssistantStreamFrame }) => {
      if (!active || !live(agent) || !getSettings(agent).modules.deepwork.enabled) return;
      if (frame.type === "start") {
        const settings = getSettings(agent);
        const role = resolveEffectiveDsmmRole(agent, settings, controller.active(agent, settings.defaultActive));
        const policy = liveRolePolicyIdentity(agent, settings, role, getSettings.admission?.(agent).epoch);
        const lock = policy === undefined ? undefined : roleRouteLock(agent, policy);
        const header = agent.session.requestHeader?.();
        if (header === undefined) { attemptsByAgent.delete(agent); return; }
        const previous = attemptsByAgent.get(agent);
        const attempt: AttemptEvidence = { id: frame.attemptId, turn: frame.turn, step: frame.step, revision: frame.revision, chunks: 0,
          route: modelRouteFromHeader(header), header, policy, generation: lock?.generation, manualSelectionSeq: lock?.manualSelectionSeq,
          valid: Number.isSafeInteger(frame.revision) && frame.revision >= 1 && (previous === undefined || frame.revision === previous.revision + 1), output: false, consumed: false };
        attemptsByAgent.set(agent, attempt);
        if (lock !== undefined) lock.attempts += 1;
        return;
      }
      const attempt = attemptsByAgent.get(agent);
      if (attempt === undefined) return;
      if (attempt.id !== frame.attemptId || frame.revision !== attempt.revision + 1 || frame.index !== attempt.chunks || attempt.seq !== undefined) {
        attempt.valid = false;
        return;
      }
      attempt.revision = frame.revision;
      if (frame.type === "chunk") {
        attempt.chunks += 1;
        attempt.output ||= outputChunk(frame.chunk);
        if (frame.chunk.type === "finish" && (frame.chunk.reason.kind === "error" || frame.chunk.reason.kind === "aborted")) attempt.failure = frame.chunk.reason.failure;
        return;
      }
      if (frame.outcome.kind !== "committed") { attempt.valid = false; return; }
      attempt.seq = frame.outcome.seq;
      attempt.eventType = frame.outcome.eventType;
      const lock = attempt.policy === undefined ? undefined : roleRouteLock(agent, attempt.policy);
      if (lock !== undefined && (attempt.output || frame.outcome.eventType === "assistant/message")) {
        lock.startupSettled = true;
        if (frame.outcome.eventType === "assistant/message") { lock.retries = 0; lock.rateLimits = 0; }
      }
    }, { prepend: true });
    disposeRequest = ctx.on("agent/request", async (frame, next) => {
      const downstream = await next();
      if (!active || !live(frame.agent)) return downstream;
      const pending = pendingByAgent.get(frame.agent);
      if (pending === undefined || !getSettings(frame.agent).modules.deepwork.enabled) return downstream;
      if (latestNativeModelSelection(frame.agent)?.seq !== pending.manualSelectionSeq) {
        pendingByAgent.delete(frame.agent);
        throw new Error("dsmm retry was superseded by an explicit native model selection");
      }
      if (frame.signal.aborted || !isCurrentRecoveryStep(recoveryEvents(frame.agent), pending.turn, pending.step)) {
        pendingByAgent.delete(frame.agent);
        return downstream;
      }
      if (pending.turn !== frame.turn || pending.step !== frame.step) return downstream;

      if (pending.policy !== undefined) {
        const settings = getSettings(frame.agent);
        const role = resolveEffectiveDsmmRole(frame.agent, settings, controller.active(frame.agent, settings.defaultActive));
        if (role !== pending.role || liveRolePolicyIdentity(frame.agent, settings, role, getSettings.admission?.(frame.agent).epoch) !== pending.policy) {
          pendingByAgent.delete(frame.agent);
          return downstream;
        }
      }

      const accepted = frame.agent.session.requestHeader?.();
      const lock = pending.policy === undefined ? undefined : roleRouteLock(frame.agent, pending.policy);
      if (!active || lock === undefined || lock.generation !== pending.generation || attemptsByAgent.get(frame.agent) !== pending.attempt
        || accepted === undefined || !sameExactModelRoute(modelRouteFromHeader(accepted), pending.failedRoute)) {
        pendingByAgent.delete(frame.agent);
        return downstream;
      }

      pendingByAgent.delete(frame.agent);
      if (frame.agent.session.header?.origin !== "subagent") return downstream;
      lock.route = { ...pending.route };
      recordAdmittedRecoveryRoute(frame, pending.route);
      return applyModelRoute(downstream, pending.route);
    }, { prepend: true });
    disposeRequestError = ctx.on("agent/request-error", async (frame, next) => {
      if (!active || !live(frame.agent) || frame.signal.aborted) return undefined;
      let settings;
      let role;
      try {
        settings = getSettings(frame.agent);
        if (!settings.modules.deepwork.enabled) return await next();
        role = resolveEffectiveDsmmRole(frame.agent, settings, controller.active(frame.agent, settings.defaultActive));
      } catch {
        const prior = attemptsByAgent.get(frame.agent);
        return isRateLimit(frame.failure) && prior?.policy !== undefined ? undefined : await next();
      }
      const unavailable = isUnavailableRouteFailure(frame.failure, true);
      if (role === undefined || (!isRateLimit(frame.failure) && !unavailable)) return await next();
      try {
        const policy = liveRolePolicyIdentity(frame.agent, settings, role, getSettings.admission?.(frame.agent).epoch);
        const lock = policy === undefined ? undefined : roleRouteLock(frame.agent, policy);
        const attempt = attemptsByAgent.get(frame.agent);
        const header = frame.agent.session.requestHeader?.();
        if (!active || frame.signal.aborted || lock === undefined || header === undefined
          || header.config.provider !== frame.provider || !sameExactModelRoute(modelRouteFromHeader(header), lock.route)
          || attempt === undefined || attempt.policy !== policy || attempt.generation !== lock.generation
          || latestNativeModelSelection(frame.agent)?.seq !== attempt.manualSelectionSeq
          || !isCurrentRecoveryStep(recoveryEvents(frame.agent), frame.turn, frame.step) || !positiveNoOutput(frame, attempt)) return undefined;
        attempt.consumed = true;
        const resolved = resolveRoleRuntimePolicy(settings, role);
        const bounds = resolved.rateLimit;
        let route = lock.route;
        let candidateIndex = lock.candidateIndex;
        let switching = false;
        if (unavailable) {
          if (lock.startupSettled || lock.attempts !== 1) return undefined;
          switching = true;
        } else {
          lock.startupSettled = true;
          lock.rateLimits += 1;
          switching = frame.agent.session.header?.origin === "subagent"
            && resolved.strategy === "rate-limit-fallback" && lock.rateLimits >= bounds.switchAfterRateLimits;
          if (!switching && lock.retries >= bounds.maxRetries) return undefined;
        }
        if (switching) {
          if (!unavailable && lock.switches >= bounds.maxSwitches) return undefined;
          const index = lock.candidateIndex;
          const candidates = lock.candidates.slice(index + 1);
          if (index < 0 || candidates.length === 0) return undefined;
          const llm = frame.agent.ctx?.get?.<DshLlmRuntime>("llm") ?? ctx.get?.<DshLlmRuntime>("llm") ?? ctx.llm;
          const admission = getSettings.admission?.(frame.agent);
          const parameterPolicy = admission === undefined ? configuredModelParameterPolicy(settings) : resolvedModelParameterPolicy(admission);
          const selected = await selectInitialModelRouteChoice(llm ?? {} as DshLlmRuntime, candidates, frame.signal,
            parameterPolicy.mode === "passthrough" ? ctx.get?.<DsmmLlmRouteResolver>("dsmmLlmRoutes") : undefined);
          route = parameterPolicy.mode === "native-defaults"
            ? modelRouteFromCall(projectModelRouteParameters(selected.route, selected.requestedRoute.reasoningEffort === undefined ? "dsmm-config" : "native", false))
            : selected.route;
          candidateIndex = index + 1 + candidates.findIndex(candidate => sameExactModelRoute(candidate, selected.requestedRoute));
        }
        const serverMinimum = frame.failure.providerRetryAfterMs;
        if (serverMinimum !== undefined && (!Number.isSafeInteger(serverMinimum) || serverMinimum < 0)) return undefined;
        const delay = unavailable ? 0 : Math.max(Math.min(bounds.maxDelayMs, bounds.initialDelayMs * 2 ** lock.retries), serverMinimum ?? 0);
        if (delay > bounds.maxDelayMs || delay > bounds.maxTotalDelayMs - lock.totalDelayMs) return undefined;
        lock.totalDelayMs += delay;
        const expectedGeneration = lock.generation;
        if (delay > 0) {
          const wait = new AbortController();
          waits.add(wait);
          try {
            const signal = AbortSignal.any([frame.signal, wait.signal]);
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
              const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("dsmm retry delay aborted")); };
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            });
          } finally { waits.delete(wait); }
        }
        const currentSettings = getSettings(frame.agent);
        const currentRole = resolveEffectiveDsmmRole(frame.agent, currentSettings, controller.active(frame.agent, currentSettings.defaultActive));
        if (!active || !live(frame.agent) || frame.signal.aborted || currentRole !== role
          || liveRolePolicyIdentity(frame.agent, currentSettings, currentRole, getSettings.admission?.(frame.agent).epoch) !== policy
          || roleRouteLock(frame.agent, policy!) !== lock || lock.generation !== expectedGeneration
          || attemptsByAgent.get(frame.agent) !== attempt || !isCurrentRecoveryStep(recoveryEvents(frame.agent), frame.turn, frame.step)
          || latestNativeModelSelection(frame.agent)?.seq !== attempt.manualSelectionSeq
          || !positiveNoOutput(frame, attempt, true)
          || !sameExactModelRoute(modelRouteFromHeader(frame.agent.session.requestHeader?.()), attempt.route)) return undefined;
        if (switching) {
          lock.candidateIndex = candidateIndex;
          lock.generation += 1;
          if (!unavailable) lock.switches += 1;
          lock.retries = 0;
          lock.rateLimits = 0;
        } else lock.retries += 1;
        pendingByAgent.set(frame.agent, { turn: frame.turn, step: frame.step, route: { ...route }, role, policy,
          generation: lock.generation, failedRoute: attempt.route, attempt, manualSelectionSeq: attempt.manualSelectionSeq });
        return { kind: "retry" };
      } catch {
        warnSafely(ctx, RECOVERY_WARNING);
        return undefined;
      }
    }, { prepend: true });
    disposeTurnStopping = ctx.on("agent/turn-stopping", async (frame) => {
      try {
        const settings = getSettings(frame.agent);
        const continuation = settings.runtimeRecovery.idleContinuation;
        if (!active || !live(frame.agent) || !settings.modules.deepwork.enabled || !settings.runtimeRecovery.enabled || !continuation.enabled || frame.signal.aborted) return;

        const preset = resolveSelectedAgentPreset(frame.agent.session);
        const inScope = controller.active(frame.agent, settings.defaultActive) || isDsmmRoleId(preset);
        if (!inScope || typeof frame.agent.steer !== "function") return;

        const work = foldDurableRecoveryWork(sessionEvents(frame.agent.session));
        if (!work.incompleteTodo && !work.activeGoal) return;

        const cap = continuation.maxContinuations;
        if (cap <= 0) return;
        const previous = continuationsByAgent.get(frame.agent);
        const count = previous?.turn === frame.turn ? previous.count : 0;
        if (count >= cap) return;
        continuationsByAgent.set(frame.agent, { turn: frame.turn, count: count + 1 });

        await frame.agent.steer(createUserMessage({
          content: [{ type: "text", text: continuation.prompt }],
          source: { kind: "user" }
        }));
      } catch {
        warnSafely(ctx, `${CONTINUATION_WARNING} ${frame.turn}`);
      }
    });
    ctx.effect?.(() => () => {
      reset();
    });
  } catch (error) {
    reset();
    throw error;
  }
}
