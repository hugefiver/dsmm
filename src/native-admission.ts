import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { getTraceable, symbols } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { SubagentError, delegationDepthOf, foldSubagentDescriptor } from "@deepseek-ai/dsh-subagent";
import type { SubagentProvider, SubagentActivation, ContinuableCreateRequest, SubagentRunInfo, SubagentRunEndInfo } from "@deepseek-ai/dsh-subagent";
import type { ToolDefinition, ToolExecution, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import type { DshAgent } from "./dsh-types.js";
import type { DsmmAdmissionRouteInfo, DsmmAdmissionRouteInstallation, DsmmPreparedAdmissionRoute } from "./model-routing.js";
import type { DsmmProfileRuntime } from "./profile-runtime.js";
import type { DsmmModelRoute, DsmmProfileAdmission, DsmmSettingsGetter } from "./settings.js";
import { freezeSettings } from "./settings.js";
import type { ResolvedRoleInvocation } from "./role-invocation.js";
import { invocationView } from "./role-invocation.js";
import type { DsmmRolePolicy } from "./role-policy.js";
import { scopeLifetime } from "./lifetime.js";
import { assertResidentRootCurrent, captureResidentTool, guardResidentRealm, markResidentAgent, publishResidentAgent, restoreResidentRoot } from "./resident-root.js";
import { sessionEvents, childOwnedSessionEvents } from "./session-scope.js";
import { scopeParentOf, scopeOf } from "./native-scope.js";
import { bindNativeParent, nativeIsOwnedBy, nativeRoots, nativeTreeRoot } from "./native-ownership.js";
import { appendDelegationCeiling, readDelegationCeiling } from "./session-metadata.js";
import { listNativeChildren } from "./native-subagents.js";
import { DsmmProfileError } from "./profiles.js";
import type { SessionActionUnavailableReason } from "./profile-types.js";
import { roleProviderName } from "./roles.js";
import { resolveRoleInvocation } from "./role-invocation.js";
import { resolvedModelParameterPolicy } from "./model-parameter-policy.js";
import { roleFromProviderName } from "./role-providers.js";
import { isDsmmRoleId } from "./roles.js";
import type { DsmmRoleId } from "./roles.js";
import { captureSetupModelSelections, latestModelSelectionSeq, latestNativeModelSelection } from "./role-routing.js";
import { hasOpenTurn } from "./state.js";
import { modelRouteFromCall } from "./role-llm.js";
import type { DsmmInvocationView } from "./profile-types.js";
import { ROLE_CALL_STOP_REASONS } from "./role-control-types.js";
import type { RoleCallActualRoute, RoleCallDelivery, RoleCallModelRoute, RoleCallObservation, RoleCallObservationFrame, RoleCallStopReason } from "./role-control-types.js";

interface CallRecordBase {
  readonly parent: Agent;
  readonly parentAdmission: DsmmProfileAdmission;
  readonly token: ToolExecution["token"];
  readonly callId: string;
  readonly rootCallId: string;
  readonly childId: SessionId;
  readonly provider: string;
  readonly delivery: RoleCallDelivery;
  child?: Agent;
  childAdmission?: DsmmProfileAdmission;
  runId?: string;
  phase: "reserved" | "active" | "settled";
  actualRoute: RoleCallActualRoute;
  stopReason?: RoleCallStopReason;
}

interface RoleCallRecord extends CallRecordBase {
  readonly kind: "role";
  readonly invocation: ResolvedRoleInvocation;
  readonly role: Exclude<DsmmRoleId, "dsmm-orchestrator">;
  readonly label: string;
}
interface NativeCallRecord extends CallRecordBase {
  readonly kind: "native";
  readonly toolName: string;
  readonly nativeName?: string;
}
type CallRecord = RoleCallRecord | NativeCallRecord;
interface NativeActivationEvidence {
  readonly info: SubagentRunInfo;
  readonly child: Agent;
  readonly childAdmission?: DsmmProfileAdmission;
  header?: { readonly config: unknown };
  end?: SubagentRunEndInfo;
}
interface NativeToolObservation {
  readonly parent: Agent;
  readonly admission: DsmmProfileAdmission;
  readonly definition: ToolDefinition;
  readonly execute: ToolDefinition["execute"];
  readonly activations: Map<SessionId, NativeActivationEvidence>;
}

type RoleCallSubscriberChange = { readonly type: "update"; readonly call: RoleCallObservation } | { readonly type: "remove"; readonly callId: string };
class RoleCallSubscriber {
  private readonly pending = new Map<string, RoleCallSubscriberChange>();
  private wake?: () => void;
  constructor(readonly parent: Agent, readonly admission: DsmmProfileAdmission) {}
  push(call: RoleCallObservation): void {
    this.pending.set(call.callId, { type: "update", call });
    this.wake?.();
  }
  remove(callId: string): void {
    this.pending.set(callId, { type: "remove", callId });
    this.wake?.();
  }
  take(): RoleCallSubscriberChange[] {
    const changes = [...this.pending.values()];
    this.pending.clear();
    return changes;
  }
  async changed(signal: AbortSignal): Promise<void> {
    if (this.pending.size > 0) return;
    await new Promise<void>(resolve => {
      const wake = () => { signal.removeEventListener("abort", wake); if (this.wake === wake) this.wake = undefined; resolve(); };
      this.wake = wake;
      signal.addEventListener("abort", wake, { once: true });
      if (signal.aborted || this.pending.size > 0) wake();
    });
  }
  notify(): void { this.wake?.(); }
}

interface Pending {
  readonly childId: SessionId;
  readonly parent: Agent;
  readonly parentAdmission: DsmmProfileAdmission;
  readonly callId: ToolExecution["callId"];
  readonly invocation: ResolvedRoleInvocation;
  readonly admission: DsmmProfileAdmission;
  readonly provider: SubagentProvider;
  /** Standing composition the child shares with its parent; delegation roles are not own presets. */
  readonly expectedPreset: string | undefined;
  readonly presetScope: object | undefined;
  readonly signal: AbortSignal;
  readonly maxDepth?: number;
  readonly toolFilter: import("@deepseek-ai/dsh-tools").ToolRestriction;
  readonly observation: RoleCallRecord;
}
interface Live { readonly admission: DsmmProfileAdmission; readonly preset?: string; readonly scopeParent?: object; readonly parent?: Agent; readonly owner?: Agent; readonly creatorId?: string; readonly invocation?: ResolvedRoleInvocation; readonly dependencies?: readonly (object | undefined)[]; readonly provider?: SubagentProvider }
interface AwaitingPublication {
  readonly source: string;
  readonly signal?: AbortSignal;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  started: boolean;
}
interface AdmissionRouteCache { readonly candidate?: DsmmPreparedAdmissionRoute }
interface AdmissionRouteFailure { readonly cache: AdmissionRouteCache; readonly error: unknown }
declare module "@deepseek-ai/cordis" { interface Context { dsmmNativeAdmission: NativeAdmission } }

/** Short-lived creation correlations and exact live bindings, never an execution queue. */
export class NativeAdmission {
  readonly lifetime = new AbortController();
  private readonly pending = new Map<SessionId, Pending>();
  private readonly providers = new Map<string, SubagentProvider>();
  registerProvider(provider: SubagentProvider): void { this.providers.set(provider.name, provider); }
  private readonly live = new WeakMap<Agent, Live>();
  private readonly candidates = new WeakMap<Agent, DsmmProfileAdmission>();
  private readonly agents = new Set<Agent>();
  private readonly activations = new Set<SubagentActivation>();
  private readonly activities = new Map<Promise<unknown>, Agent>();
  private readonly calls = new Map<Agent, number>();
  private readonly rebindings = new WeakMap<Agent, Promise<void>>();
  private readonly awaitingPublication = new WeakMap<Agent, AwaitingPublication>();
  private readonly guardedTools = new WeakMap<Agent, Set<object>>();
  private readonly agentLifetimes = new WeakMap<Agent, AbortController>();
  private readonly retirements = new WeakMap<Agent, Promise<void>>();
  private readonly installing = new AsyncLocalStorage<{ agent: Agent; admission: DsmmProfileAdmission }>();
  private readonly selecting = new WeakSet<Agent>();
  private readonly failedInstallations = new WeakSet<Agent>();
  private readonly blankUpdates = new WeakMap<Agent, Promise<void>>();
  private readonly getters = new WeakMap<Agent, DsmmSettingsGetter>();
  private readonly executions = new WeakMap<Agent, Set<ToolExecution["token"]>>();
  private readonly observedCalls = new WeakMap<Agent, Map<string, CallRecord>>();
  private readonly observedCallRecords = new WeakMap<Agent, Set<CallRecord>>();
  private readonly ambiguousCallIds = new WeakMap<Agent, Set<string>>();
  private readonly observedCallTokens = new Map<ToolExecution["token"], RoleCallRecord>();
  private readonly observedCallChildren = new Map<SessionId, CallRecord>();
  private readonly nativeToolObservations = new Map<ToolExecution["token"], NativeToolObservation>();
  private readonly nativeToolExecution = new AsyncLocalStorage<ToolExecution["token"]>();
  private readonly observedCallRuns = new Map<string, CallRecord>();
  private readonly callSubscribers = new Set<RoleCallSubscriber>();
  private readonly admissionRoutes = new WeakMap<Agent, AdmissionRouteCache>();
  private readonly admissionRouteFailures = new WeakMap<Agent, AdmissionRouteFailure>();
  private readonly setupSelectionCursors = new WeakMap<object, number>();
  private ready = false;
  private readonly scopes = new Map<Agent, Context>();
  private install?: (agent: Agent, getSettings: DsmmSettingsGetter, scope: Context) => Promise<void>;
  private admissionModelSelection?: (agent: Agent, info: DsmmAdmissionRouteInfo) => Promise<DsmmPreparedAdmissionRoute | undefined>;
  constructor(readonly ctx: Context, readonly profiles: DsmmProfileRuntime, readonly policy: DsmmRolePolicy,
    private readonly configurationCommitted: (agents: readonly Agent[]) => void = () => {}) {
    scopeLifetime(ctx, "dsmm: close admission before owner teardown", () => {
      this.lifetime.abort(); this.pending.clear();
      for (const subscriber of this.callSubscribers) subscriber.notify();
      this.observedCallTokens.clear(); this.observedCallChildren.clear(); this.observedCallRuns.clear(); this.nativeToolObservations.clear();
      for (const agent of this.agents) agent.cancel({ kind: "disposed" });
    });
    ctx.effect(() => async () => {
      const results = await Promise.allSettled([...this.activations].map(activation => activation.dispose()));
      const scopes = await Promise.allSettled([...this.scopes.values()].map(scope => scope.fiber.dispose()));
      results.push(...scopes);
      await Promise.allSettled(this.activities.keys());
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Native activation teardown failed");
    });
    ctx.on("subagent/start", info => { this.admitPublishedChild(info); this.startObservedActivation(info); }, { global: true });
    ctx.on("subagent/end", info => { this.endObservedActivation(info); }, { global: true });
    ctx.on("session/created", session => {
      this.setupSelectionCursors.set(session, latestModelSelectionSeq({ session } as unknown as DshAgent));
    }, { global: true });
    ctx.on("session/disposed", session => { this.setupSelectionCursors.delete(session); }, { global: true });
    ctx.on("agent/created", async frame => {
      if (typeof ctx.agents.isOwnedBy !== "function" && frame.agent.session.header.origin === "subagent") {
        this.awaitChildPublication(frame.agent, frame.source, frame.signal);
      } else await this.created(frame.agent, frame.source, frame.signal);
    }, { global: true, prepend: true });
    ctx.on("agent/status", ({ agent, status }) => { if (status === "running") this.installCachedAdmissionRouteSafely(agent); }, { global: true });
    ctx.on("agent/inbox/claimed", ({ agent }) => { this.installCachedAdmissionRouteSafely(agent); }, { global: true });
    ctx.on("session/event", (session, event) => {
      if (event.type === "request/header") this.observeCallRequestHeader(session, event.data.header.config);
      if (event.type !== "model/selection") return;
      const agent = this.ctx.agents.get(session.id), cache = agent === undefined ? undefined : this.admissionRoutes.get(agent);
      if (agent === undefined || agent.session !== session || cache?.candidate?.restoresConfiguredPrimary !== true) return;
      queueMicrotask(() => {
        try {
          if (this.lifetime.signal.aborted || this.agentLifetimes.get(agent)?.signal.aborted || this.selecting.has(agent)
            || this.admissionRoutes.get(agent) !== cache) return;
          this.installCachedAdmissionRouteSafely(agent, cache);
        } catch (error) {
          if (this.admissionRoutes.get(agent) === cache) this.admissionRouteFailures.set(agent, { cache, error });
        }
      });
    }, { global: true });
    ctx.on("agent/disposed", ({ agent }) => {
      void this.retireAgent(agent).catch(() => {});
      this.retireObservedParent(agent);
      this.live.delete(agent); this.candidates.delete(agent); this.admissionRoutes.delete(agent); this.admissionRouteFailures.delete(agent); this.agents.delete(agent);
      for (const activation of this.activations) if (activation.childId === agent.id) this.activations.delete(activation);
      profiles.release(agent as DshAgent); policy.release(agent as DshAgent);
    }, { global: true });
    // Exact admitted and failed-admission objects stay guarded through retirement.
    ctx.on("agent/pre-step", async (frame, next) => { await this.guardExecution(frame.agent); return next(); }, { global: true, prepend: true });
    ctx.on("agent/request", async (frame, next) => { await this.guardExecution(frame.agent); return next(); }, { global: true, prepend: true });
    ctx.on("tools/execute", async (exec, next) => {
      const native = exec.agent && await this.guardExecution(exec.agent) === "native";
      if (native) return this.nativeToolExecution.run(exec.token, next);
      const caller = exec.signal;
      if (exec.agent) exec.signal = AbortSignal.any([caller, this.lifetime.signal, this.agentLifetimes.get(exec.agent)!.signal]);
      try { return await this.nativeToolExecution.run(exec.token, () => policy.duringToolExecution(exec, next)); }
      finally { exec.signal = caller; }
    }, { global: true, prepend: true });
    ctx.on("tools/pre-execute", async (exec, next) => {
      if (exec.agent) {
        const publication = !this.live.has(exec.agent) && this.awaitingPublication.get(exec.agent);
        if (publication) await publication.promise;
        captureResidentTool(exec.agent, this, exec.token);
        this.trackExecution(exec);
        await this.guardExecution(exec.agent);
        this.beginNativeToolObservation(exec);
      }
      return next();
    }, { global: true, prepend: true });
    ctx.on("tools/result", (exec, result) => {
      if (exec.agent) this.executions.get(exec.agent)?.delete(exec.token);
      this.finishObservedTool(exec, result);
    }, { global: true });
    ctx.on("agent-preset/selected", id => {
      const agent = ctx.agents.get(id);
      if (!agent || !this.live.has(agent)) return;
      const binding = this.rebindBlank(agent);
      this.rebindings.set(agent, binding);
      void binding.catch(() => {});
    }, { global: true });
  }
  activate(install: NonNullable<NativeAdmission["install"]>): void {
    this.lifetime.signal.throwIfAborted(); this.install = install; this.ready = true;
  }
  async restoreResidentRoots(): Promise<void> {
    if (this.ctx.fiber.state === 1) {
      // Own services become visible on ACTIVE, after the apply callback returns.
      // Claim idle roots' native maintenance slots in that same status dispatch.
      const detach = this.ctx.on("internal/status", fiber => {
        if (fiber.ctx !== this.ctx.fiber.ctx || fiber.state !== 2) return;
        detach(); return this.restoreResidentRoots();
      }, { global: true });
      return;
    }
    if (!this.isReady) throw new SubagentError("DSMM owner is not ready for resident admission", "UNAUTHORIZED");
    await Promise.all(nativeRoots(this.ctx.agents).map(async agent => {
      try { await restoreResidentRoot(agent, this, signal => this.created(agent, "startup", signal, true)); }
      catch (error) { if (!this.lifetime.signal.aborted) this.ctx.logger.warn("Resident root %s remains revoked: %s", agent.id, error); }
    }));
  }
  /** Bind asynchronous metadata preparation; later lifecycle callbacks only install its immutable result. */
  bindAdmissionModelSelection(hook: (agent: Agent, info: DsmmAdmissionRouteInfo) => Promise<DsmmPreparedAdmissionRoute | undefined>): void {
    this.admissionModelSelection = hook;
  }
  private callsFor(parent: Agent): Map<string, CallRecord> {
    let calls = this.observedCalls.get(parent);
    if (calls === undefined) { calls = new Map(); this.observedCalls.set(parent, calls); }
    return calls;
  }
  private recordsFor(parent: Agent): Set<CallRecord> {
    let records = this.observedCallRecords.get(parent);
    if (records === undefined) { records = new Set(); this.observedCallRecords.set(parent, records); }
    return records;
  }
  private observationRoute(route: DsmmModelRoute): RoleCallModelRoute {
    return Object.freeze({ provider: route.provider, model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) });
  }
  private observedCall(record: CallRecord): RoleCallObservation {
    const common = { parentSessionId: record.parent.id, parentAdmissionEpoch: record.parentAdmission.epoch,
      ...(record.childAdmission === undefined ? {} : { childAdmissionEpoch: record.childAdmission.epoch }),
      callId: record.callId, rootCallId: record.rootCallId, childId: record.childId,
      ...(record.runId === undefined ? {} : { runId: record.runId }),
      actualRoute: record.actualRoute, phase: record.phase, delivery: record.delivery,
      ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }) };
    return record.kind === "native"
      ? Object.freeze({ ...common, kind: "native", toolName: record.toolName, provider: record.provider,
        ...(record.nativeName === undefined ? {} : { nativeName: record.nativeName }),
        initialRoute: Object.freeze({ status: "unknown", reason: "missing-invocation-capture" }) })
      : Object.freeze({ ...common, role: record.role, level: record.invocation.effectiveLevel, routeSource: record.invocation.routeSource,
        initialRoute: Object.freeze({ status: "known", source: "invocation-capture", route: this.observationRoute(record.invocation.initialRoute) }) });
  }
  private publishObservedCall(record: CallRecord): void {
    if (this.observedCalls.get(record.parent)?.get(record.callId) !== record || this.ambiguousCallIds.get(record.parent)?.has(record.callId)) return;
    const call = this.observedCall(record);
    for (const subscriber of this.callSubscribers) {
      if (subscriber.parent === record.parent && subscriber.admission === record.parentAdmission) subscriber.push(call);
    }
  }
  private publishObservedRemoval(parent: Agent, admission: DsmmProfileAdmission, callId: string): void {
    for (const subscriber of this.callSubscribers) {
      if (subscriber.parent === parent && subscriber.admission === admission) subscriber.remove(callId);
    }
  }
  private observedInvocation(record: RoleCallRecord): DsmmInvocationView {
    const call = this.observedCall(record);
    return { ...invocationView(record.invocation, record.label, "continuable", { childId: record.childId, ...(record.runId === undefined ? {} : { runId: record.runId }) }),
      role: record.role, route: this.observationRoute(record.invocation.initialRoute),
      routeComparison: { childId: record.childId, initialRoute: call.initialRoute, liveRoute: call.actualRoute },
      delivery: record.delivery, phase: record.phase, ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }) };
  }
  private awaitChildPublication(agent: Agent, source: string, signal?: AbortSignal): void {
    if (this.awaitingPublication.has(agent)) throw new SubagentError("Child publication is already pending", "UNAUTHORIZED");
    let resolve!: () => void, rejectAdmission!: (error: unknown) => void;
    const promise = new Promise<void>((done, reject) => { resolve = done; rejectAdmission = reject; });
    const waiting: AwaitingPublication = { source, signal, promise, resolve, reject: rejectAdmission, started: false };
    this.awaitingPublication.set(agent, waiting);
    void waiting.promise.catch(() => {});
    const closed = AbortSignal.any([this.lifetime.signal, ...signal ? [signal] : []]);
    const reject = () => waiting.reject(new SubagentError("Child admission was cancelled", "UNAUTHORIZED"));
    closed.addEventListener("abort", reject, { once: true });
    if (closed.aborted) reject();
    scopeLifetime(agent.ctx, "dsmm: reject unpublished child admission", reject);
    void waiting.promise.finally(() => closed.removeEventListener("abort", reject)).catch(() => {});
    // The native manager publishes ancestry after agent/created returns. No
    // model request or tool can cross that interval, including after owner unload.
    agent.ctx.on("agent/pre-step", async (frame, next) => { if (frame.agent === agent) await waiting.promise; return next(); }, { prepend: true });
    agent.ctx.on("agent/request", async (frame, next) => { if (frame.agent === agent) await waiting.promise; return next(); }, { prepend: true });
    agent.ctx.on("tools/pre-execute", async (exec, next) => { if (exec.agent === agent) await waiting.promise; return next(); }, { prepend: true });
  }
  private admitPublishedChild(info: SubagentRunInfo & { readonly parentSessionId?: SessionId }): void {
    if (!info.local) return;
    const child = this.ctx.agents.get(info.id), waiting = child && this.awaitingPublication.get(child);
    if (!child || !waiting || waiting.started) return;
    waiting.started = true;
    const admission = async () => {
      this.lifetime.signal.throwIfAborted(); waiting.signal?.throwIfAborted();
      const parent = info.parentSessionId === undefined ? undefined : this.ctx.agents.get(info.parentSessionId);
      const pending = this.pending.get(child.id);
      if (pending && (pending.parent !== parent || pending.provider.name !== info.provider)) throw new SubagentError("Published child differs from its pending invocation", "UNAUTHORIZED");
      if (parent !== undefined) bindNativeParent(this.ctx.agents, child, parent);
      else {
        const ceiling = readDelegationCeiling(child.session);
        if (waiting.source !== "resume" || ceiling === undefined || ceiling.creatorId !== info.parentSessionId
          || ceiling.provider !== info.provider) throw new SubagentError("Child requires its verified creator evidence", "UNAUTHORIZED");
      }
      await this.created(child, waiting.source, waiting.signal);
    };
    void admission().then(waiting.resolve, error => {
      this.failedInstallations.add(child);
      waiting.reject(error);
      child.cancel({ kind: "disposed" });
    });
  }
  private startObservedActivation(info: SubagentRunInfo): void {
    const child = this.ctx.agents.get(info.id), token = this.nativeToolExecution.getStore();
    const pending = token === undefined ? undefined : this.nativeToolObservations.get(token);
    const parentId = (info as SubagentRunInfo & { readonly parentSessionId?: SessionId }).parentSessionId;
    if (info.local && child !== undefined && pending !== undefined && pending.admission === this.get(pending.parent)
      && (parentId === undefined || parentId === pending.parent.id)
      && child.session.header.origin === "subagent" && child.session.header.parentSession === pending.parent.id
      && nativeIsOwnedBy(this.ctx.agents, child.id, pending.parent) && !pending.activations.has(info.id)) {
      pending.activations.set(info.id, { info, child, childAdmission: this.get(child) });
    }
    const record = this.observedCallChildren.get(info.id);
    if (record === undefined || info.provider !== record.provider || !info.local || record.phase === "settled") return;
    if (record.runId !== undefined && record.runId !== info.runId) return;
    record.runId = info.runId; record.phase = "active";
    this.observedCallRuns.set(info.runId, record);
    this.publishObservedCall(record);
  }
  private endObservedActivation(info: SubagentRunEndInfo): void {
    const parentId = (info as SubagentRunEndInfo & { readonly parentSessionId?: SessionId }).parentSessionId;
    for (const pending of this.nativeToolObservations.values()) {
      const evidence = pending.activations.get(info.id);
      if (evidence?.info.runId === info.runId && evidence.info.provider === info.provider && info.local
        && (parentId === undefined || parentId === pending.parent.id)) evidence.end = info;
    }
    const record = this.observedCallRuns.get(info.runId);
    if (record === undefined || record.childId !== info.id || record.provider !== info.provider || !info.local
      || parentId !== undefined && parentId !== record.parent.id) return;
    this.settleObservedActivation(record, info.stopReason);
  }
  private settleObservedActivation(record: CallRecord, stopReason?: string): void {
    if (record.phase === "settled") return;
    record.phase = "settled";
    if ((ROLE_CALL_STOP_REASONS as readonly string[]).includes(stopReason ?? "")) record.stopReason = stopReason as RoleCallStopReason;
    if (record.runId !== undefined && this.observedCallRuns.get(record.runId) === record) this.observedCallRuns.delete(record.runId);
    if (this.observedCallChildren.get(record.childId) === record) this.observedCallChildren.delete(record.childId);
    this.publishObservedCall(record);
  }
  private bindObservedChild(record: RoleCallRecord, child: Agent, admission: DsmmProfileAdmission): void {
    if (record.phase === "settled" || record.parentAdmission !== this.get(record.parent)
      || this.observedCallChildren.get(record.childId) !== record || child.id !== record.childId) return;
    record.child = child; record.childAdmission = admission;
    if (record.actualRoute.status === "unknown" && record.actualRoute.reason === "not-observed") record.actualRoute = Object.freeze({ status: "unknown", reason: "no-own-request-header" });
    this.publishObservedCall(record);
  }
  private observeCallRequestHeader(session: Agent["session"], value: unknown): void {
    const record = this.observedCallChildren.get(session.id), child = this.ctx.agents.get(session.id);
    for (const pending of this.nativeToolObservations.values()) {
      const evidence = pending.activations.get(session.id);
      if (evidence !== undefined && evidence.end === undefined && evidence.child === child && child.session === session
        && pending.admission === this.get(pending.parent)) evidence.header = { config: value };
    }
    if (record === undefined || child === undefined || child !== record.child || child.session !== session
      || record.parentAdmission !== this.get(record.parent) || record.childAdmission !== this.get(child) || record.phase === "settled") return;
    this.setObservedRoute(record, value);
    this.publishObservedCall(record);
  }
  private setObservedRoute(record: CallRecord, value: unknown): void {
    const config = typeof value === "object" && value !== null ? value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown } : undefined;
    if (typeof config?.provider !== "string" || typeof config.model !== "string"
      || config.reasoningEffort !== undefined && typeof config.reasoningEffort !== "string") {
      record.actualRoute = Object.freeze({ status: "unknown", reason: "invalid-own-request-header" });
    } else {
      try {
        const route = modelRouteFromCall({ provider: config.provider, model: config.model,
          ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) }) });
        record.actualRoute = Object.freeze({ status: "known", source: "own-native-request-header", route: Object.freeze(route) });
      } catch { record.actualRoute = Object.freeze({ status: "unknown", reason: "invalid-own-request-header" }); }
    }
  }
  private beginNativeToolObservation(exec: Readonly<ToolExecution>): void {
    const parent = exec.agent, admission = parent && this.get(parent);
    if (parent === undefined || admission === undefined) return;
    const tools = this.ctx.get("agentPresets")?.serviceFor(parent, "tools") ?? parent.ctx.tools;
    const definition = tools.get(exec.name, parent), schema = definition?.output.schema;
    const identity = schema?.properties?.name !== undefined ? "name" : "subagentId";
    if (definition === undefined || schema?.type !== "object" || schema.additionalProperties !== false
      || schema.properties?.kind?.const !== "activation" || schema.properties[identity]?.type !== "string"
      || !schema.required?.includes("kind") || !schema.required.includes(identity)
      || Object.keys(schema.properties).length !== 2) return;
    this.nativeToolObservations.set(exec.token, { parent, admission, definition, execute: definition.execute, activations: new Map() });
  }
  private async finishNativeToolObservation(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>, pending: NativeToolObservation): Promise<void> {
    try {
      if (pending.activations.size === 0 || result.isError || typeof result.value !== "object" || result.value === null || Array.isArray(result.value)
        || result.value.kind !== "activation") return;
      const nativeName = typeof result.value.name === "string" && result.value.name.length > 0 ? result.value.name : undefined;
      const runtime = this.ctx.get("subagents") as (Context["subagents"] & {
        resolveName?(parent: Agent, name: string, signal: AbortSignal): Promise<SessionId>;
      }) | undefined;
      const childId = nativeName === undefined
        ? typeof result.value.subagentId === "string" && result.value.subagentId.length > 0 ? SessionId(result.value.subagentId) : undefined
        : await runtime?.resolveName?.(pending.parent, nativeName, this.lifetime.signal);
      const tools = this.ctx.get("agentPresets")?.serviceFor(pending.parent, "tools") ?? pending.parent.ctx.tools;
      const evidence = childId === undefined ? undefined : pending.activations.get(childId);
      if (this.nativeToolObservations.get(exec.token) !== pending || this.lifetime.signal.aborted
        || this.get(pending.parent) !== pending.admission || this.ctx.agents.get(pending.parent.id) !== pending.parent
        || exec.agent !== pending.parent || tools.get(exec.name, pending.parent) !== pending.definition
        || pending.definition.execute !== pending.execute || evidence === undefined || childId === undefined) return;
      if (evidence.end === undefined && (this.ctx.agents.get(childId) !== evidence.child
        || !nativeIsOwnedBy(this.ctx.agents, childId, pending.parent))) return;
      const record: NativeCallRecord = { kind: "native", parent: pending.parent, parentAdmission: pending.admission,
        token: exec.token, callId: String(exec.callId), rootCallId: String(exec.rootCallId), childId,
        toolName: exec.name, provider: evidence.info.provider, ...(nativeName === undefined ? {} : { nativeName }),
        child: evidence.child, childAdmission: this.get(evidence.child) ?? evidence.childAdmission,
        runId: evidence.info.runId, phase: "active", delivery: "parent", actualRoute: { status: "unknown", reason: "no-own-request-header" } };
      if (evidence.header !== undefined) this.setObservedRoute(record, evidence.header.config);
      const calls = this.callsFor(pending.parent);
      let ambiguous = this.ambiguousCallIds.get(pending.parent);
      if (ambiguous === undefined) { ambiguous = new Set(); this.ambiguousCallIds.set(pending.parent, ambiguous); }
      const duplicate = calls.has(record.callId) || ambiguous.has(record.callId);
      this.recordsFor(pending.parent).add(record);
      if (duplicate) { ambiguous.add(record.callId); calls.delete(record.callId); this.publishObservedRemoval(pending.parent, pending.admission, record.callId); }
      else calls.set(record.callId, record);
      if (evidence.end !== undefined) this.settleObservedActivation(record, evidence.end.stopReason);
      else {
        this.observedCallChildren.set(childId, record); this.observedCallRuns.set(evidence.info.runId, record);
        this.publishObservedCall(record);
      }
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.ctx.logger.debug("Native call observation unavailable: %s", error instanceof Error ? error.message : String(error));
    } finally { if (this.nativeToolObservations.get(exec.token) === pending) this.nativeToolObservations.delete(exec.token); }
  }
  private finishObservedTool(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    const native = this.nativeToolObservations.get(exec.token);
    if (native !== undefined) void this.finishNativeToolObservation(exec, result, native);
    const record = this.observedCallTokens.get(exec.token);
    if (record === undefined) return;
    this.observedCallTokens.delete(exec.token);
    if (record.phase === "reserved" || record.delivery === "caller" && record.phase === "active"
      || record.delivery === "parent" && result.isError && record.runId === undefined) {
      this.settleObservedActivation(record, result.isError ? undefined : "completed");
    }
  }
  private retireObservedParent(parent: Agent): void {
    for (const [token, pending] of this.nativeToolObservations) if (pending.parent === parent) this.nativeToolObservations.delete(token);
    for (const record of this.observedCallRecords.get(parent) ?? []) {
      this.observedCallTokens.delete(record.token);
      if (this.observedCallChildren.get(record.childId) === record) this.observedCallChildren.delete(record.childId);
      if (record.runId !== undefined && this.observedCallRuns.get(record.runId) === record) this.observedCallRuns.delete(record.runId);
    }
    this.observedCalls.delete(parent); this.observedCallRecords.delete(parent); this.ambiguousCallIds.delete(parent);
    for (const subscriber of this.callSubscribers) if (subscriber.parent === parent) subscriber.notify();
  }
  async *observeRoleCalls(parent: Agent, admission: DsmmProfileAdmission, signal: AbortSignal, check: () => void): AsyncIterable<RoleCallObservationFrame> {
    const subscriber = new RoleCallSubscriber(parent, admission);
    this.callSubscribers.add(subscriber);
    try {
      const assertCurrent = () => {
        signal.throwIfAborted(); check();
        if (this.assert(parent) !== admission) throw new SubagentError("Call observation admission changed", "UNAUTHORIZED");
      };
      assertCurrent();
      const calls = [...this.observedCalls.get(parent)?.values() ?? []]
        .filter(record => record.parentAdmission === admission).map(record => this.observedCall(record));
      const snapshot: RoleCallObservationFrame = Object.freeze({ type: "snapshot", sessionId: parent.id,
        admissionEpoch: admission.epoch, calls: Object.freeze(calls) });
      yield snapshot;
      while (!signal.aborted) {
        await subscriber.changed(signal); assertCurrent();
        for (const change of subscriber.take()) {
          assertCurrent();
          const update: RoleCallObservationFrame = change.type === "update"
            ? Object.freeze({ type: "update", sessionId: parent.id, admissionEpoch: admission.epoch, call: change.call })
            : Object.freeze({ type: "remove", sessionId: parent.id, admissionEpoch: admission.epoch, callId: change.callId });
          yield update;
        }
      }
    } finally { this.callSubscribers.delete(subscriber); }
  }
  private notifyObservedParent(parent: Agent): void {
    for (const subscriber of this.callSubscribers) if (subscriber.parent === parent) subscriber.notify();
  }
  private installCachedAdmissionRoute(agent: Agent, expected?: AdmissionRouteCache): DsmmAdmissionRouteInstallation | undefined {
    const cache = expected ?? this.admissionRoutes.get(agent), live = this.live.get(agent);
    if (cache === undefined || cache !== this.admissionRoutes.get(agent) || live === undefined || this.failedInstallations.has(agent)
      || !this.isReady || this.ctx.agents.get(agent.id) !== agent || this.agentLifetimes.get(agent)?.signal.aborted) return undefined;
    return cache.candidate?.install(live.admission);
  }
  private installCachedAdmissionRouteSafely(agent: Agent, expected?: AdmissionRouteCache): void {
    const cache = expected ?? this.admissionRoutes.get(agent);
    if (cache?.candidate?.restoresConfiguredPrimary !== true || this.admissionRouteFailures.get(agent)?.cache === cache) return;
    try { this.installCachedAdmissionRoute(agent, cache); }
    catch (error) {
      if (this.admissionRoutes.get(agent) === cache) this.admissionRouteFailures.set(agent, { cache, error });
    }
  }
  get isReady(): boolean {
    const current = this.ctx.get("dsmmNativeAdmission");
    return this.ready && !this.lifetime.signal.aborted && current !== undefined && original(current) === original(this);
  }
  /** Exact process-local capture, retained after retirement so stale objects never become native. */
  owns(agent: Agent): boolean { return this.agentLifetimes.has(agent); }
  async guardExecution(agent: Agent): Promise<"native" | "dsmm"> {
    const publication = this.awaitingPublication.get(agent);
    if (publication) await publication.promise;
    assertResidentRootCurrent(agent, this);
    if (!this.owns(agent)) {
      const registry = agent.ctx.get("agents");
      if (registry && original(registry) === original(this.ctx.agents) && scopeOf(agent.ctx) === agent && registry.get(agent.id) !== agent
        || this.ctx.agents.list().some(parent => this.owns(parent) && nativeIsOwnedBy(this.ctx.agents, agent.id, parent))) {
        throw new SubagentError("Native child admission is incomplete", "UNAUTHORIZED");
      }
      return "native";
    }
    await this.ensure(agent);
    return "dsmm";
  }
  isSelecting(agent: Agent): boolean { return this.selecting.has(agent); }
  get(agent: Agent): DsmmProfileAdmission | undefined { return this.live.get(agent)?.admission; }
  configuration(agent: Agent): DsmmProfileAdmission {
    const preview = this.installing.getStore();
    const value = preview?.agent === agent ? preview.admission : this.candidates.get(agent) ?? this.get(agent);
    if (!value) throw new SubagentError("No trusted live admission", "UNAUTHORIZED");
    return value;
  }
  private getter(agent: Agent): DsmmSettingsGetter {
    let getter = this.getters.get(agent);
    if (getter === undefined) {
      getter = () => this.configuration(agent).settings;
      getter.admission = () => this.configuration(agent);
      this.getters.set(agent, getter);
    }
    return getter;
  }
  private dependencies(agent: Agent): Array<object | undefined> {
    const presets = agent.ctx.get("agentPresets");
    return [presets, agent.ctx.get("subagents"), agent.ctx.get("llm"),
      presets?.serviceFor(agent, "tools") ?? agent.ctx.get("tools"),
      presets?.serviceFor(agent, "systemPrompt") ?? agent.ctx.get("systemPrompt"),
      presets?.serviceFor(agent, "skills") ?? agent.ctx.get("skills")].map(service => service === undefined ? undefined : original(service));
  }
  invocation(agent: Agent): ResolvedRoleInvocation | undefined { return this.live.get(agent)?.invocation; }
  async ensure(agent: Agent): Promise<DsmmProfileAdmission> { await this.awaitingPublication.get(agent)?.promise; await this.rebindings.get(agent); return this.assert(agent); }
  assert(agent: Agent): DsmmProfileAdmission {
    return this.assertBinding(agent);
  }
  private assertBinding(agent: Agent, maintenanceRoot?: Agent): DsmmProfileAdmission {
    this.lifetime.signal.throwIfAborted();
    this.agentLifetimes.get(agent)?.signal.throwIfAborted();
    const live = this.live.get(agent);
    if (this.failedInstallations.has(agent)) throw new SubagentError("Session configuration restoration failed; create a new session", "UNAUTHORIZED");
    if (this.selecting.has(agent) && agent !== maintenanceRoot) throw new SubagentError("Session configuration maintenance is in progress", "UNAUTHORIZED");
    if (!this.isReady || !live || this.ctx.agents.get(agent.id) !== agent) throw new SubagentError("No trusted live admission; create a new session", "UNAUTHORIZED");
    const routeFailure = this.admissionRouteFailures.get(agent);
    if (routeFailure !== undefined && routeFailure.cache === this.admissionRoutes.get(agent)) {
      throw new SubagentError("Configured model selection installation failed; create a new session", "UNAUTHORIZED");
    }
    if (this.ctx.get("sessions")?.get(agent.id) !== agent.session || agent.session.id !== agent.id || agent.session.header.id !== agent.id
      || scopeOf(agent.ctx) !== agent || original(agent.ctx.get("agents")!) !== original(this.ctx.agents)
      || live.dependencies && this.dependencies(agent).some((value, index) => value !== live.dependencies![index])
      || live.provider && this.ctx.get("subagents")?.getProvider(live.provider.name) !== live.provider) throw new SubagentError("Native admission dependencies changed", "UNAUTHORIZED");
    if (live.preset !== agent.ctx.get("agentPresets")?.composedPreset(agent.ctx) || live.scopeParent !== scopeParentOf(agent)) throw new SubagentError("Preset composition changed; create a new session", "UNAUTHORIZED");
    const owner = live.owner ?? live.parent;
    if (owner) {
      const root = nativeTreeRoot(this.ctx.agents, agent);
      if (this.ctx.agents.get(owner.id) !== owner || (root === undefined ? !nativeIsOwnedBy(this.ctx.agents, agent.id, owner) : root !== owner)
        || agent.session.header.parentSession !== live.creatorId) throw new SubagentError("Admission owner changed", "UNAUTHORIZED");
      this.assertBinding(owner, maintenanceRoot);
    }
    this.policy.assertModuleAdmission(agent as DshAgent); return live.admission;
  }
  private residentTree(agent: Agent): Agent[] {
    const residents = this.ctx.agents.list();
    if (nativeTreeRoot(this.ctx.agents, agent) === agent) {
      return [agent, ...residents.filter(member => member !== agent && nativeTreeRoot(this.ctx.agents, member) === agent).sort((a, b) => a.id.localeCompare(b.id))];
    }
    const tree = [agent];
    for (let index = 0; index < tree.length; index++) {
      for (const child of residents.filter(child => nativeIsOwnedBy(this.ctx.agents, child.id, tree[index])).sort((a, b) => a.id.localeCompare(b.id))) {
        if (tree.includes(child)) throw new SubagentError("Invalid native ownership tree", "UNAUTHORIZED");
        tree.push(child);
      }
    }
    return tree;
  }
  blankReason(agent: Agent, allowQueued = false): SessionActionUnavailableReason | undefined {
    if (!this.isReady || this.failedInstallations.has(agent) || this.ctx.agents.get(agent.id) !== agent || !nativeRoots(this.ctx.agents).includes(agent) || this.dependencies(agent).some(value => value === undefined)) return "runtime-unavailable";
    const live = this.live.get(agent);
    if (!live || live.parent || agent.session.header.origin === "subagent") return "runtime-unavailable";
    if (this.selecting.has(agent) && !allowQueued) return "busy";
    try {
      for (const member of this.residentTree(agent)) {
        this.assertBinding(member, allowQueued ? agent : undefined);
        if (this.dependencies(member).some(value => value === undefined)) return "runtime-unavailable";
        if (member.status !== "idle" || hasOpenTurn(sessionEvents(member.session)) || (this.calls.get(member) ?? 0) !== 0
          || (this.executions.get(member)?.size ?? 0) !== 0 || [...this.pending.values()].some(row => row.parent === member)
          || !allowQueued && (member.inbox.nextTurn.length !== 0 || member.inbox.nextStep.length !== 0)) return "busy";
        if (member.runMaintenance === undefined) return "maintenance";
      }
    } catch { return "runtime-unavailable"; }
    return undefined;
  }
  /** Reserved by runMaintenance; newly queued input belongs to the accepted choice. */
  async beginBlank(agent: Agent, signal: AbortSignal, assertAuthority: () => void): Promise<{ assertCurrent(): void; prepare(admission: DsmmProfileAdmission, describe: () => void): Promise<void>; committed(): void; close(): Promise<void> }> {
    const reason = this.blankReason(agent);
    if (reason !== undefined) throw new DsmmProfileError(reason === "busy" ? "busy" : "unavailable", "A trusted quiescent native session subtree is required.");
    const previous = this.live.get(agent)!;
    this.assert(agent);
    const captured = this.dependencies(agent);
    const tree = this.residentTree(agent), bindings = tree.map(member => this.live.get(member));
    const preparationSignal = AbortSignal.any([signal, this.lifetime.signal, this.agentLifetimes.get(agent)!.signal]);
    this.selecting.add(agent);
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    this.blankUpdates.set(agent, completion);
    const reservations: Promise<void>[] = [], maintenanceSignals: AbortSignal[] = [];
    try {
      for (const child of tree.slice(1)) {
        reservations.push(child.runMaintenance(childSignal => { maintenanceSignals.push(childSignal); return completion; }));
      }
    } catch (error) {
      this.selecting.delete(agent); this.blankUpdates.delete(agent); finish();
      await Promise.allSettled(reservations);
      throw new DsmmProfileError("maintenance", "A resident descendant refused configuration maintenance.");
    }
    let prepared = false, committed = false;
    let publication!: Live;
    const previousRouteCache = this.admissionRoutes.get(agent), previousRouteFailure = this.admissionRouteFailures.get(agent);
    let installedRouteCache: AdmissionRouteCache | undefined, routeInstallation: DsmmAdmissionRouteInstallation | undefined;
    let providers: ReadonlyMap<string, SubagentProvider> = new Map();
    const assertCurrent = () => {
      assertAuthority();
      preparationSignal.throwIfAborted();
      for (const childSignal of maintenanceSignals) childSignal.throwIfAborted();
      const currentTree = this.residentTree(agent);
      if (this.live.get(agent) !== previous || this.blankReason(agent, true) !== undefined || this.dependencies(agent).some((value, index) => value !== captured[index])
        || currentTree.length !== tree.length || currentTree.some((member, index) => member !== tree[index] || this.live.get(member) !== bindings[index])) {
        throw new DsmmProfileError("conflict", "The session owner or composition changed before configuration commit.");
      }
      for (const [name, expected] of providers) {
        const current = agent.ctx.get("subagents")?.getProvider(name);
        if (current === undefined || original(current) !== original(expected) || current.capabilities.depthLimit !== true) {
          throw new DsmmProfileError("conflict", "A required native provider changed before configuration commit.");
        }
      }
    };
    const install = (admission: DsmmProfileAdmission) => this.installing.run({ agent, admission }, () => this.install!(agent, this.getter(agent), this.scopes.get(agent)!));
    return {
      assertCurrent,
      prepare: async (admission, describe) => {
        assertCurrent(); this.policy.validateRootRole(agent as DshAgent, admission);
        await this.installing.run({ agent, admission }, async () => {
          const targets = this.policy.targets(agent as DshAgent);
          providers = new Map([...targets.map(roleProviderName), ...targets.length === 0 ? [] : ["spawn"]].map(name => {
            const provider = agent.ctx.get("subagents")?.getProvider(name);
            if (provider?.capabilities.depthLimit !== true) throw new DsmmProfileError("activation", "An enabled role has no admitted native provider.");
            return [name, provider];
          }));
        });
        assertCurrent();
        const candidate = await this.admissionModelSelection?.(agent, { settings: admission.settings, epoch: admission.epoch,
          admission, signal: preparationSignal, assertCurrent });
        assertCurrent();
        prepared = true;
        installedRouteCache = Object.freeze({ candidate });
        this.admissionRoutes.set(agent, installedRouteCache);
        this.admissionRouteFailures.delete(agent);
        try { routeInstallation = candidate?.install(admission); }
        catch (error) {
          if (candidate?.preflightFailure !== error) this.failedInstallations.add(agent);
          throw error;
        }
        await install(admission); assertCurrent();
        this.installing.run({ agent, admission }, describe);
        publication = Object.freeze({ ...previous, admission });
      },
      committed: () => { this.live.set(agent, publication); committed = true; this.notifyObservedParent(agent); this.configurationCommitted(tree); },
      close: async () => {
        try {
          if (prepared && !committed) {
            const errors: unknown[] = [];
            const canRestore = this.ctx.agents.get(agent.id) === agent && !this.lifetime.signal.aborted;
            if (canRestore) {
              try { await install(previous.admission); } catch (error) { errors.push(error); }
              try { routeInstallation?.rollback(); } catch (error) { errors.push(error); }
            }
            if (installedRouteCache !== undefined && this.admissionRoutes.get(agent) === installedRouteCache) {
              if (previousRouteCache === undefined) this.admissionRoutes.delete(agent); else this.admissionRoutes.set(agent, previousRouteCache);
              if (previousRouteFailure !== undefined && previousRouteFailure.cache === previousRouteCache) this.admissionRouteFailures.set(agent, previousRouteFailure);
              else this.admissionRouteFailures.delete(agent);
            }
            if (errors.length > 0) {
              this.failedInstallations.add(agent);
              const refusal = new DsmmProfileError("activation", "Session configuration restoration failed. Execution is disabled; create a new session.");
              refusal.cause = errors.length === 1 ? errors[0] : new AggregateError(errors, "Session configuration restoration failed");
              throw refusal;
            }
          }
        } finally {
          this.selecting.delete(agent); this.blankUpdates.delete(agent); finish();
          await Promise.allSettled(reservations);
        }
      },
    };
  }
  private trackExecution(exec: Readonly<ToolExecution>): void {
    if (!exec.agent || !this.owns(exec.agent)) return;
    const active = this.executions.get(exec.agent) ?? new Set<ToolExecution["token"]>();
    active.add(exec.token); this.executions.set(exec.agent, active);
  }
  async reserve(exec: Readonly<ToolExecution>, invocation: ResolvedRoleInvocation, provider: SubagentProvider, label: string,
    delivery: RoleCallDelivery, maxDepth?: number): Promise<{ childId: SessionId; release(): Promise<void>; signal: AbortSignal; view(): DsmmInvocationView }> {
    const parent = exec.agent; if (!parent) throw new SubagentError("Calling Agent required", "UNAUTHORIZED");
    const parentAdmission = this.assert(parent), role = invocation.target;
    if (role === "dsmm-orchestrator") throw new SubagentError("Orchestrator is not a delegated role", "UNAUTHORIZED");
    this.policy.assertDelegation(parent as DshAgent, role);
    const toolFilter = this.policy.delegationToolFilter(exec);
    const presets = this.ctx.get("agentPresets");
    if (!presets) throw new SubagentError("Native preset registry unavailable", "UNSUPPORTED_CAPABILITY");
    // The child shares the parent's standing composition; its role is carried
    // by the admitted invocation, not by an own registered preset.
    const expectedPreset = presets.composedPreset(parent.ctx);
    const lease = expectedPreset === undefined ? undefined : await presets.acquireScope(expectedPreset);
    const presetScope = expectedPreset === undefined ? scopeParentOf(parent) : lease!.key;
    try {
      exec.signal.throwIfAborted(); this.assert(parent);
      const currentProvider = this.ctx.get("subagents")?.getProvider(provider.name);
      if (!currentProvider || original(currentProvider) !== original(provider) || this.get(parent) !== parentAdmission) throw new SubagentError("Creation dependencies changed", "UNAUTHORIZED");
      const childId = SessionId(randomUUID()), signal = AbortSignal.any([exec.signal, this.lifetime.signal, this.agentLifetimes.get(parent)!.signal]);
      const admission = freezeSettings({ ...parentAdmission, settings: structuredClone(parentAdmission.settings) });
      const callId = String(exec.callId), rootCallId = String(exec.rootCallId), calls = this.callsFor(parent);
      let ambiguous = this.ambiguousCallIds.get(parent);
      if (ambiguous === undefined) { ambiguous = new Set(); this.ambiguousCallIds.set(parent, ambiguous); }
      const duplicate = calls.has(callId) || ambiguous.has(callId);
      if (duplicate) { ambiguous.add(callId); calls.delete(callId); }
      const observation: RoleCallRecord = { kind: "role", parent, parentAdmission, token: exec.token, callId, rootCallId, childId, invocation, role,
        label, provider: provider.name, delivery, phase: "reserved", actualRoute: Object.freeze({ status: "unknown", reason: "not-observed" }) };
      const pending: Pending = Object.freeze({ childId, parent, parentAdmission, callId: exec.callId, invocation, admission, provider, expectedPreset, presetScope, signal, maxDepth, toolFilter, observation });
      this.recordsFor(parent).add(observation);
      if (!duplicate) calls.set(callId, observation);
      this.observedCallTokens.set(exec.token, observation); this.observedCallChildren.set(childId, observation);
      this.pending.set(childId, pending);
      if (duplicate) this.publishObservedRemoval(parent, parentAdmission, callId); else this.publishObservedCall(observation);
      const revoke = () => { if (this.pending.get(childId) === pending) this.pending.delete(childId); };
      signal.addEventListener("abort", revoke, { once: true });
      return { childId, signal, view: () => this.observedInvocation(observation),
        release: async () => { revoke(); signal.removeEventListener("abort", revoke); await lease?.[Symbol.asyncDispose](); } };
    } catch (error) { await lease?.[Symbol.asyncDispose](); throw error; }
  }
  async duringCall<T>(agent: Agent, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assert(agent);
    const merged = AbortSignal.any([signal, this.lifetime.signal, this.agentLifetimes.get(agent)!.signal]);
    const task = Promise.resolve().then(() => operation(merged));
    this.calls.set(agent, (this.calls.get(agent) ?? 0) + 1);
    this.activities.set(task, agent);
    try { return await task; } finally { this.activities.delete(task); const remaining = this.calls.get(agent)! - 1; if (remaining) this.calls.set(agent, remaining); else this.calls.delete(agent); }
  }
  prepare(request: ContinuableCreateRequest, provider: SubagentProvider): void {
    const pending = this.pending.get(request.sessionId);
    if (!pending || pending.parent !== request.parent || original(pending.provider) !== original(provider)) throw new SubagentError("Role creation requires its exact pending call", "UNAUTHORIZED");
    this.check(pending); request.signal.throwIfAborted();
  }
  private check(pending: Pending): void {
    pending.signal.throwIfAborted(); this.lifetime.signal.throwIfAborted();
    const provider = this.ctx.get("subagents")?.getProvider(pending.provider.name);
    if (this.pending.get(pending.childId) !== pending || this.assert(pending.parent) !== pending.parentAdmission || provider === undefined || original(provider) !== original(pending.provider)) throw new SubagentError("Pending call lost its owner", "UNAUTHORIZED");
  }
  track(activation: SubagentActivation): void {
    this.activations.add(activation);
    const observation = this.observedCallChildren.get(activation.childId);
    void activation.result.then(result => { if (observation !== undefined) this.settleObservedActivation(observation, result.stopReason); }, () => {
      if (observation !== undefined) this.settleObservedActivation(observation);
    }).finally(() => { if (!this.ctx.agents.get(activation.childId)) this.activations.delete(activation); }).catch(() => {});
    if (this.lifetime.signal.aborted) void activation.dispose().catch(error => this.ctx.logger.error(error));
  }
  private guardTools(agent: Agent, scope: Context): void {
    const tools = agent.ctx.get("agentPresets")?.serviceFor(agent, "tools") ?? agent.ctx.get("tools");
    if (!tools) return;
    const identity = original(tools), installed = this.guardedTools.get(agent) ?? new Set<object>();
    if (installed.has(identity)) return;
    installed.add(identity); this.guardedTools.set(agent, installed);
    getTraceable(scope, tools).guard(exec => {
      if (exec.agent !== agent) return;
      this.assert(agent);
      const current = agent.ctx.get("agentPresets")?.serviceFor(agent, "tools") ?? agent.ctx.get("tools");
      if (!current || original(current) !== identity) return "The tool realm is no longer the admitted composition";
      this.policy.assertToolExecution(exec);
      return this.policy.preToolDenial(agent as DshAgent, exec.name, undefined, exec);
    });
  }
  private retireAgent(agent: Agent): Promise<void> {
    const existing = this.retirements.get(agent);
    if (existing) return existing;
    this.agentLifetimes.get(agent)?.abort();
    const children = new Set([...this.agents].filter(child => {
      const live = this.live.get(child);
      return (live?.owner ?? live?.parent) === agent;
    }));
    for (const child of children) child.cancel({ kind: "disposed" });
    const receipts = [...this.activations].filter(activation => [...children].some(child => child.id === activation.childId));
    const retirement = Promise.allSettled(receipts.map(activation => activation.dispose())).then(results => {
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Native descendants failed to retire");
    });
    const settled = retirement.then(async () => { await Promise.allSettled([...this.activities].filter(([, actor]) => actor === agent).map(([activity]) => activity)); });
    this.retirements.set(agent, settled);
    return settled;
  }
  private async rebindBlank(agent: Agent): Promise<void> {
    await this.blankUpdates.get(agent);
    this.lifetime.signal.throwIfAborted();
    if (!this.isReady) throw new SubagentError("DSMM owner is no longer current", "UNAUTHORIZED");
    const previous = this.live.get(agent);
    if (previous === undefined) throw new SubagentError("The blank Agent owner was retired", "UNAUTHORIZED");
    if (previous.preset === agent.ctx.get("agentPresets")?.composedPreset(agent.ctx) && previous.scopeParent === scopeParentOf(agent)) return;
    if (this.selecting.has(agent)) throw new SubagentError("Session configuration maintenance owns the blank composition", "UNAUTHORIZED");
    if (previous.parent || previous.owner || (this.calls.get(agent) ?? 0) !== 0 || [...this.pending.values()].some(row => row.parent === agent)
      || this.ctx.agents.list().some(child => nativeIsOwnedBy(this.ctx.agents, child.id, agent)) || sessionEvents(agent.session).some(event => event.type === "turn/start")) throw new SubagentError("Preset change requires a new session", "UNAUTHORIZED");
    this.policy.validateRootRole(agent as DshAgent, previous.admission);
    const preset = agent.ctx.get("agentPresets")?.composedPreset(agent.ctx), scopeParent = scopeParentOf(agent);
    const scope = this.scopes.get(agent)!;
    guardResidentRealm(agent);
    this.guardTools(agent, scope);
    await this.install!(agent, this.getter(agent), scope);
    this.lifetime.signal.throwIfAborted();
    this.agentLifetimes.get(agent)!.signal.throwIfAborted();
    if (!this.isReady || this.ctx.agents.get(agent.id) !== agent || this.live.get(agent) !== previous || scopeParentOf(agent) !== scopeParent) throw new SubagentError("Composition changed during blank admission", "UNAUTHORIZED");
    this.live.set(agent, Object.freeze({ ...previous, preset, scopeParent, dependencies: this.dependencies(agent) }));
    publishResidentAgent(agent, this);
  }
  private async created(agent: Agent, source: string, creationSignal?: AbortSignal, restoring = false): Promise<void> {
    if (this.owns(agent)) { this.assert(agent); return; }
    const pending = this.pending.get(agent.id);
    if (pending && source !== "startup") throw new SubagentError("Role creation requires its first pending call", "UNAUTHORIZED");
    if (!this.isReady || !this.install) throw new SubagentError("DSMM admission is initializing", "UNAUTHORIZED");
    let signal = AbortSignal.any([...creationSignal ? [creationSignal] : [], this.lifetime.signal]);
    signal.throwIfAborted();
    const parents = this.ctx.agents.list().filter(parent => parent !== agent && nativeIsOwnedBy(this.ctx.agents, agent.id, parent));
    const parent = parents[0], preset = agent.ctx.get("agentPresets")?.composedPreset(agent.ctx), presetScope = scopeParentOf(agent);
    if (parents.length > 1 || this.ctx.agents.get(agent.id) !== agent || this.ctx.get("sessions")?.get(agent.id) !== agent.session
      || agent.session.id !== agent.id || agent.session.header.id !== agent.id || scopeOf(agent.ctx) !== agent
      || original(agent.ctx.get("agents")!) !== original(this.ctx.agents)) throw new SubagentError("Invalid native ownership", "UNAUTHORIZED");
    const setupCursor = this.setupSelectionCursors.get(agent.session);
    this.setupSelectionCursors.delete(agent.session);
    if (setupCursor !== undefined) captureSetupModelSelections(agent as DshAgent, setupCursor);
    const own = childOwnedSessionEvents(agent.session);
    const descriptor = foldSubagentDescriptor(own as Parameters<typeof foldSubagentDescriptor>[0]);
    if (!pending && parent && !this.owns(parent)) {
      if (descriptor && roleFromProviderName(descriptor.provider) || isDsmmRoleId(preset)
        || source === "resume" && await this.profiles.readChildIdentity(agent.id, parent.id)) throw new SubagentError("Role continuation requires an admitted parent", "UNAUTHORIZED");
      return;
    }
    const ceiling = source === "resume" ? readDelegationCeiling(agent.session) : undefined;
    const root = nativeTreeRoot(this.ctx.agents, agent);
    const owner = parent ? root ?? parent : ceiling !== undefined && root !== agent ? root : undefined;
    if (ceiling !== undefined && (root?.id !== ceiling.rootId || agent.id !== ceiling.childId
      || agent.session.header.parentSession !== ceiling.creatorId || descriptor?.provider !== ceiling.provider
      || (roleFromProviderName(descriptor.provider) ?? null) !== ceiling.role)) throw new SubagentError("Delegation ceiling identity mismatch", "UNAUTHORIZED");
    if (!parent && !owner && (!nativeRoots(this.ctx.agents).includes(agent) || agent.session.header.origin === "subagent" || descriptor !== undefined)) throw new SubagentError("Child requires its native creator or ceiling", "UNAUTHORIZED");
    const isRoot = !owner && !parent;
    if (restoring && !isRoot) throw new SubagentError("Resident root ownership changed", "UNAUTHORIZED");
    if (owner) this.assert(owner);
    if (restoring) guardResidentRealm(agent);
    else markResidentAgent(agent, this, isRoot, this.awaitingPublication.get(agent)?.promise);
    const scope = agent.ctx.plugin(function dsmmAgentGeneration() {}).ctx;
    this.scopes.set(agent, scope);
    this.agentLifetimes.set(agent, new AbortController());
    signal = AbortSignal.any([signal, this.agentLifetimes.get(agent)!.signal, ...owner ? [this.agentLifetimes.get(owner)!.signal] : []]);
    scopeLifetime(scope, "dsmm: retire exact Agent work", () => { void this.retireAgent(agent).catch(() => {}); });
    scope.effect(() => async () => {
      try { await this.retireAgent(agent); }
      finally {
        this.scopes.delete(agent); this.live.delete(agent); this.candidates.delete(agent); this.admissionRoutes.delete(agent); this.admissionRouteFailures.delete(agent); this.agents.delete(agent);
        this.profiles.release(agent as DshAgent); this.policy.release(agent as DshAgent);
      }
    });
    const dependencies = this.dependencies(agent);
    const parentAdmission = parent ? this.assert(parent) : undefined;
    const ownerAdmission = owner ? this.assert(owner) : undefined;
    const check = () => {
      signal.throwIfAborted(); this.agentLifetimes.get(agent)!.signal.throwIfAborted();
      if (!this.isReady || this.ctx.agents.get(agent.id) !== agent || this.ctx.get("sessions")?.get(agent.id) !== agent.session
        || scopeOf(agent.ctx) !== agent || original(agent.ctx.get("agents")!) !== original(this.ctx.agents)
        || this.dependencies(agent).some((value, index) => value !== dependencies[index]) || scopeParentOf(agent) !== presetScope || preset !== agent.ctx.get("agentPresets")?.composedPreset(agent.ctx)
        || isRoot && !nativeRoots(this.ctx.agents).includes(agent)
        || owner && (this.assert(owner) !== ownerAdmission || (root === undefined ? !nativeIsOwnedBy(this.ctx.agents, agent.id, owner) : nativeTreeRoot(this.ctx.agents, agent) !== owner))
        || pending && parent && (this.assert(parent) !== parentAdmission || !nativeIsOwnedBy(this.ctx.agents, agent.id, parent))) throw new SubagentError("Activation owner changed", "UNAUTHORIZED");
    };
    let continuation: ResolvedRoleInvocation | undefined, independent = false, continuationProvider: SubagentProvider | undefined;
    let admission: DsmmProfileAdmission;
    if (ceiling !== undefined) {
      if (!owner || descriptor?.mode !== "continuable" || agent.session.header.origin !== "subagent") throw new SubagentError("Cold child is not continuable", "NOT_RESUMABLE");
      const subagents = this.ctx.get("subagents")!;
      const rows = await subagents.listDescendants(owner.id, signal);
      check();
      const row = rows.find(row => row.id === agent.id);
      if (!row || row.kind === "diagnostic" || row.parentId !== ceiling.creatorId || row.mode !== "continuable") throw new SubagentError("Native child catalog mismatch", "UNAUTHORIZED");
      const metadata = { childSessionId: ceiling.childId, parentSessionId: ceiling.creatorId, role: ceiling.role,
        profileId: ceiling.profileId, level: ceiling.level };
      const previous = await this.profiles.readChildIdentity(agent.id, ceiling.creatorId);
      if (previous && (previous.role !== metadata.role || previous.profileId !== metadata.profileId || previous.level !== metadata.level)) throw new SubagentError("Child selection identity conflict", "UNAUTHORIZED");
      const ownPreset = own.find(event => event.type === "agent-preset/selected" || event.type === "subagent/descriptor");
      independent = ownPreset?.type === "agent-preset/selected";
      if (!independent && (preset !== owner.ctx.get("agentPresets")?.composedPreset(owner.ctx) || presetScope !== scopeParentOf(owner))) throw new SubagentError("Inherited composition changed", "UNAUTHORIZED");
      continuationProvider = ceiling.role === null ? subagents.getProvider(ceiling.provider) : this.providers.get(roleProviderName(ceiling.role));
      const currentProvider = continuationProvider && subagents.getProvider(continuationProvider.name);
      if (!continuationProvider || !currentProvider || original(currentProvider) !== original(continuationProvider)) throw new SubagentError("Native provider is unavailable", "UNAUTHORIZED");
      admission = await this.profiles.prepareChild(agent as DshAgent, ownerAdmission!, signal, { profileId: ceiling.profileId });
      check();
      if (ceiling.role !== null) {
        if (!admission.settings.modules.deepwork.enabled || !admission.settings.roles[ceiling.role]) throw new SubagentError("Role is disabled", "UNAUTHORIZED");
        this.policy.assertDelegation(owner as DshAgent, ceiling.role);
        const manual = latestNativeModelSelection(agent as DshAgent)?.route;
        continuation = await resolveRoleInvocation(owner, ceiling.role, admission.settings, signal, { level: ceiling.level },
          manual === undefined ? undefined : { provider: manual.provider, model: manual.model,
            ...(manual.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(manual.reasoningEffort) }) }, resolvedModelParameterPolicy(admission));
        check();
      } else if (isDsmmRoleId(preset)) throw new SubagentError("Native continuation cannot acquire a DSMM role", "UNAUTHORIZED");
    } else if (parent) {
      const parentAdmission = this.assert(parent), controlled = this.policy.identity(parent as DshAgent).role !== undefined;
      if (agent.session.header.parentSession !== parent.id || agent.session.header.origin !== "subagent") throw new SubagentError("Invalid native child header", "UNAUTHORIZED");
      if (pending) {
        this.check(pending);
        if (pending.parent !== parent || pending.parentAdmission !== parentAdmission || preset !== pending.expectedPreset || agent.session.header.isSeeded
          || scopeParentOf(agent) !== pending.presetScope) throw new SubagentError("Child does not match the pending invocation", "UNAUTHORIZED");
        if (pending.maxDepth !== undefined && delegationDepthOf(agent) > pending.maxDepth) throw new SubagentError("Child exceeds depth ceiling", "UNAUTHORIZED");
        admission = pending.admission;
      } else if (source === "resume") {
        if (descriptor?.mode !== "continuable") throw new SubagentError("Native child is not continuable", "NOT_RESUMABLE");
        const subagents = this.ctx.get("subagents")!;
        const rows = await listNativeChildren(subagents, parent.id, signal);
        check();
        const row = rows.find(row => row.id === agent.id);
        if (!row || row.mode !== "continuable") throw new SubagentError("Native child catalog mismatch", "UNAUTHORIZED");
        const metadata = await this.profiles.readChildIdentity(agent.id, parent.id);
        check();
        const ownPreset = own.find(event => event.type === "agent-preset/selected" || event.type === "subagent/descriptor");
        independent = ownPreset?.type === "agent-preset/selected";
        if (!independent && (preset !== parent.ctx.get("agentPresets")?.composedPreset(parent.ctx) || presetScope !== scopeParentOf(parent))) throw new SubagentError("Inherited composition changed", "UNAUTHORIZED");
        const nativeRole = roleFromProviderName(descriptor.provider) ?? (independent && isDsmmRoleId(preset) ? preset : undefined);
        if (metadata && nativeRole && metadata.role !== nativeRole) throw new SubagentError("Child role identity conflict", "UNAUTHORIZED");
        const role = nativeRole ?? metadata?.role;
        if (!role) {
          admission = await this.profiles.prepareChild(agent as DshAgent, parentAdmission, signal);
          check();
        } else {
          continuationProvider = this.providers.get(roleProviderName(role));
          const currentProvider = continuationProvider && subagents.getProvider(continuationProvider.name);
          if (!continuationProvider || !currentProvider || original(currentProvider) !== original(continuationProvider)) throw new SubagentError("Role provider is unavailable", "UNAUTHORIZED");
          admission = await this.profiles.prepareChild(agent as DshAgent, parentAdmission, signal, metadata);
          check();
          if (!admission.settings.modules.deepwork.enabled || !admission.settings.roles[role]) throw new SubagentError("Role is disabled", "UNAUTHORIZED");
          this.policy.assertDelegation(parent as DshAgent, role);
          const manual = latestNativeModelSelection(agent as DshAgent)?.route;
          continuation = await resolveRoleInvocation(parent, role, admission.settings, signal, metadata ? { level: metadata.level } : {},
            manual === undefined ? undefined : { provider: manual.provider, model: manual.model,
              ...(manual.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(manual.reasoningEffort) }) },
            resolvedModelParameterPolicy(admission));
          check();
        }
      } else {
        if (controlled || preset?.startsWith("dsmm-")) throw new SubagentError("Use an admitted DSMM role tool", "UNAUTHORIZED");
        admission = parentAdmission;
      }
    } else {
      if (pending) throw new SubagentError("Missing exact parent", "UNAUTHORIZED");
      admission = await this.profiles.prepareRoot(agent as DshAgent, signal);
      check();
      this.policy.validateRootRole(agent as DshAgent, admission);
    }
    this.candidates.set(agent, admission);
    this.agents.add(agent);
    this.guardTools(agent, scope);
    try {
      if (pending) this.policy.bindChild(agent as DshAgent, parent! as DshAgent, admission, pending.invocation, pending.maxDepth, pending.toolFilter);
      else if (ceiling) this.policy.bindContinuedChild(agent as DshAgent, owner! as DshAgent, admission, continuation,
        ceiling, ceiling.role === null ? admission.settings.subagents.maxDepth : this.ctx.get("subagents")!.resolveMaxDepth(admission.settings.subagents.maxDepth), independent);
      else if (continuation) this.policy.bindChild(agent as DshAgent, parent! as DshAgent, admission, continuation,
        this.ctx.get("subagents")!.resolveMaxDepth(admission.settings.subagents.maxDepth), this.policy.visibleToolCeiling(parent! as DshAgent), independent);
      else if (parent) this.policy.bindInheritedChild(agent as DshAgent, parent as DshAgent, admission, source === "resume", admission.settings.subagents.maxDepth);
      if (parent && root && source !== "resume" && descriptor) {
        const provider = this.ctx.get("subagents")!.getProvider(descriptor.provider);
        if (!provider) throw new SubagentError("Native provider is unavailable", "UNAUTHORIZED");
        if (!pending) continuationProvider = provider;
        appendDelegationCeiling(agent.session, { version: 1, childId: agent.id, creatorId: parent.id, rootId: root.id,
          provider: descriptor.provider, ...(pending ? { role: pending.invocation.target, level: pending.invocation.effectiveLevel } : { role: null, level: null }),
          profileId: admission.profile?.id ?? null, ...this.policy.delegationCeiling(agent as DshAgent) });
      }
      await this.install(agent, this.getter(agent), scope);
      check();
      // Occupancy precedes the installed guards' async policy and approval work.
      scope.on("tools/pre-execute", async (exec, next) => {
        if (exec.agent === agent) {
          const publication = !this.live.has(agent) && this.awaitingPublication.get(agent);
          if (publication) await publication.promise;
          captureResidentTool(agent, this, exec.token);
          this.trackExecution(exec); await this.ensure(agent);
          const denial = this.policy.preToolDenial(agent as DshAgent, exec.name, undefined, exec);
          if (denial) return { kind: "deny" as const, reason: denial };
        }
        return next();
      }, { prepend: true });
      await this.profiles.revalidateActivation(admission);
      check();
      if (pending) this.check(pending);
      if (continuationProvider && this.ctx.get("subagents")!.getProvider(continuationProvider.name) !== continuationProvider) throw new SubagentError("Role provider changed", "UNAUTHORIZED");
      const routeCandidate = await this.admissionModelSelection?.(agent, {
        settings: admission.settings, epoch: admission.epoch, admission, signal, assertCurrent: check,
      });
      check();
      const routeCache = Object.freeze({ candidate: routeCandidate });
      this.admissionRoutes.set(agent, routeCache);
      this.admissionRouteFailures.delete(agent);
      routeCandidate?.install(admission);
      check();
      this.profiles.publish(agent as DshAgent, admission);
      const published = this.profiles.admission(agent as DshAgent);
      this.live.set(agent, Object.freeze({ admission: published, preset, scopeParent: scopeParentOf(agent), parent, owner, creatorId: agent.session.header.parentSession,
        invocation: pending?.invocation ?? continuation, dependencies, provider: pending?.provider ?? continuationProvider }));
      publishResidentAgent(agent, this);
      if (pending) { this.bindObservedChild(pending.observation, agent, published); this.pending.delete(agent.id); }
    } catch (error) {
      this.failedInstallations.add(agent);
      this.admissionRoutes.delete(agent); this.admissionRouteFailures.delete(agent); this.policy.release(agent as DshAgent);
      await scope.fiber.dispose();
      throw error;
    }
    finally { this.candidates.delete(agent); }
  }
}

function original(value: object): object { return Reflect.get(value, symbols.original) ?? value; }
