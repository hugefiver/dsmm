import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { getTraceable, symbols } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { SubagentError, delegationDepthOf } from "@deepseek-ai/dsh-subagent";
import type { SubagentProvider, SubagentActivation, ContinuableCreateRequest } from "@deepseek-ai/dsh-subagent";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { DshAgent } from "./dsh-types.js";
import type { DsmmProfileRuntime } from "./profile-runtime.js";
import type { DsmmProfileAdmission, DsmmSettingsGetter } from "./settings.js";
import { freezeSettings } from "./settings.js";
import type { ResolvedRoleInvocation } from "./role-invocation.js";
import type { DsmmRolePolicy } from "./role-policy.js";
import { scopeLifetime } from "./lifetime.js";
import { sessionEvents } from "./session-scope.js";
import { scopeParentOf } from "./native-scope.js";
import { DsmmProfileError } from "./profiles.js";
import type { SessionActionUnavailableReason } from "./profile-types.js";
import { roleProviderName } from "./roles.js";
import { resolveRoleInvocation } from "./role-invocation.js";
import { resolvedModelParameterPolicy } from "./model-parameter-policy.js";

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
  readonly presetScope: object;
  readonly signal: AbortSignal;
  readonly maxDepth?: number;
  readonly toolFilter: import("@deepseek-ai/dsh-tools").ToolRestriction;
}
interface Live { readonly admission: DsmmProfileAdmission; readonly preset?: string; readonly scopeParent?: object; readonly parent?: Agent; readonly invocation?: ResolvedRoleInvocation }
declare module "@deepseek-ai/cordis" { interface Context { dsmmNativeAdmission: NativeAdmission } }

/** Short-lived creation correlations and exact live bindings, never an execution queue. */
export class NativeAdmission {
  readonly lifetime = new AbortController();
  private readonly pending = new Map<SessionId, Pending>();
  private readonly live = new WeakMap<Agent, Live>();
  private readonly candidates = new WeakMap<Agent, DsmmProfileAdmission>();
  private readonly agents = new Set<Agent>();
  private readonly activations = new Set<SubagentActivation>();
  private readonly activities = new Map<Promise<unknown>, Agent>();
  private readonly calls = new Map<Agent, number>();
  private readonly rebindings = new WeakMap<Agent, Promise<void>>();
  private readonly guardedTools = new WeakMap<Agent, Set<object>>();
  private readonly agentLifetimes = new WeakMap<Agent, AbortController>();
  private readonly retirements = new WeakMap<Agent, Promise<void>>();
  private readonly installing = new AsyncLocalStorage<{ agent: Agent; admission: DsmmProfileAdmission }>();
  private readonly selecting = new WeakSet<Agent>();
  private readonly failedInstallations = new WeakSet<Agent>();
  private readonly blankUpdates = new WeakMap<Agent, Promise<void>>();
  private readonly getters = new WeakMap<Agent, DsmmSettingsGetter>();
  private readonly executions = new WeakMap<Agent, Set<ToolExecution["token"]>>();
  private ready = false;
  private install?: (agent: Agent, getSettings: DsmmSettingsGetter) => Promise<void>;
  constructor(readonly ctx: Context, readonly profiles: DsmmProfileRuntime, readonly policy: DsmmRolePolicy) {
    scopeLifetime(ctx, "dsmm: close admission before owner teardown", () => {
      this.lifetime.abort(); this.pending.clear();
      for (const agent of this.agents) agent.cancel({ kind: "disposed" });
    });
    ctx.effect(() => async () => {
      const results = await Promise.allSettled([...this.activations].map(activation => activation.dispose()));
      await Promise.allSettled(this.activities.keys());
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Native activation teardown failed");
    });
    ctx.on("agent/created", async frame => { await this.created(frame.agent, frame.source, frame.signal); }, { global: true, prepend: true });
    ctx.on("agent/disposed", ({ agent }) => {
      void this.retireAgent(agent).catch(() => {});
      this.live.delete(agent); this.candidates.delete(agent); this.agents.delete(agent);
      for (const activation of this.activations) if (activation.childId === agent.id) this.activations.delete(activation);
      profiles.release(agent as DshAgent); policy.release(agent as DshAgent);
    }, { global: true });
    // Only exact DSMM captures are guarded; native reconstruction is not an admission request.
    ctx.on("agent/pre-step", async (frame, next) => { await this.guardExecution(frame.agent); return next(); }, { global: true, prepend: true });
    ctx.on("agent/request", async (frame, next) => { await this.guardExecution(frame.agent); return next(); }, { global: true, prepend: true });
    ctx.on("tools/execute", async (exec, next) => {
      if (exec.agent && await this.guardExecution(exec.agent) === "native") return next();
      return policy.duringToolExecution(exec, next);
    }, { global: true, prepend: true });
    ctx.on("tools/pre-execute", async (exec, next) => {
      if (exec.agent) {
        if (await this.guardExecution(exec.agent) === "native") return next();
        const active = this.executions.get(exec.agent) ?? new Set<ToolExecution["token"]>();
        active.add(exec.token); this.executions.set(exec.agent, active);
      }
      return next();
    }, { global: true, prepend: true });
    ctx.on("tools/result", exec => { if (exec.agent) this.executions.get(exec.agent)?.delete(exec.token); }, { global: true });
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
  get isReady(): boolean {
    const current = this.ctx.get("dsmmNativeAdmission");
    return this.ready && !this.lifetime.signal.aborted && current !== undefined && original(current) === original(this);
  }
  /** Exact process-local capture, retained after retirement so stale objects never become native. */
  owns(agent: Agent): boolean { return this.agentLifetimes.has(agent); }
  async guardExecution(agent: Agent): Promise<"native" | "dsmm"> {
    if (!this.owns(agent)) return "native";
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
  async ensure(agent: Agent): Promise<DsmmProfileAdmission> { await this.rebindings.get(agent); return this.assert(agent); }
  assert(agent: Agent): DsmmProfileAdmission {
    this.lifetime.signal.throwIfAborted();
    this.agentLifetimes.get(agent)?.signal.throwIfAborted();
    const live = this.live.get(agent);
    if (this.failedInstallations.has(agent)) throw new SubagentError("Session configuration restoration failed; create a new session", "UNAUTHORIZED");
    if (this.selecting.has(agent)) throw new SubagentError("Session configuration maintenance is in progress", "UNAUTHORIZED");
    if (!this.isReady || !live || this.ctx.agents.get(agent.id) !== agent) throw new SubagentError("No trusted live admission; create a new session", "UNAUTHORIZED");
    if (live.preset !== agent.ctx.get("agentPresets")?.composedPreset(agent.ctx) || live.scopeParent !== scopeParentOf(agent)) throw new SubagentError("Preset composition changed; create a new session", "UNAUTHORIZED");
    if (live.parent && (this.ctx.agents.get(live.parent.id) !== live.parent || !this.ctx.agents.isOwnedBy(agent.id, live.parent))) throw new SubagentError("Parent residency changed", "UNAUTHORIZED");
    if (live.parent) this.assert(live.parent);
    this.policy.assertModuleAdmission(agent as DshAgent); return live.admission;
  }
  blankReason(agent: Agent, allowQueued = false): SessionActionUnavailableReason | undefined {
    if (!this.isReady || this.failedInstallations.has(agent) || this.ctx.agents.get(agent.id) !== agent || !this.ctx.agents.roots().includes(agent) || this.dependencies(agent).some(value => value === undefined)) return "runtime-unavailable";
    const live = this.live.get(agent);
    if (!live || live.parent || agent.session.header.origin === "subagent" || agent.session.header.isSeeded
      || sessionEvents(agent.session).some(event => ["turn/start", "step/start", "request/header", "assistant/message", "tool/call"].includes(event.type))) return "new-session-required";
    if (agent.status !== "idle" || (this.calls.get(agent) ?? 0) !== 0 || (this.executions.get(agent)?.size ?? 0) !== 0 || [...this.pending.values()].some(row => row.parent === agent)
      || this.ctx.agents.list().some(child => this.ctx.agents.isOwnedBy(child.id, agent))
      || this.selecting.has(agent) && !allowQueued
      || !allowQueued && (agent.inbox.nextTurn.length !== 0 || agent.inbox.nextStep.length !== 0)) return "busy";
    if (agent.runMaintenance === undefined) return "maintenance";
    if (live.preset !== agent.ctx.get("agentPresets")?.composedPreset(agent.ctx) || live.scopeParent !== scopeParentOf(agent)
      || this.agentLifetimes.get(agent)?.signal.aborted) return "runtime-unavailable";
    return undefined;
  }
  /** Reserved by runMaintenance; newly queued input belongs to the accepted choice. */
  beginBlank(agent: Agent, signal: AbortSignal, assertAuthority: () => void): { assertCurrent(): void; prepare(admission: DsmmProfileAdmission, describe: () => void): Promise<void>; committed(): void; close(): Promise<void> } {
    const reason = this.blankReason(agent);
    if (reason !== undefined) throw new DsmmProfileError(reason === "busy" ? "busy" : "unavailable", "Only an unstarted live session can select its configuration.");
    const previous = this.live.get(agent)!;
    this.assert(agent);
    const captured = this.dependencies(agent);
    const preparationSignal = AbortSignal.any([signal, this.lifetime.signal, this.agentLifetimes.get(agent)!.signal]);
    this.selecting.add(agent);
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    this.blankUpdates.set(agent, completion);
    let prepared = false, committed = false;
    let publication!: Live;
    let providers: ReadonlyMap<string, SubagentProvider> = new Map();
    const assertCurrent = () => {
      assertAuthority();
      preparationSignal.throwIfAborted();
      if (this.live.get(agent) !== previous || this.blankReason(agent, true) !== undefined || this.dependencies(agent).some((value, index) => value !== captured[index])) {
        throw new DsmmProfileError("conflict", "The session owner or composition changed before configuration commit.");
      }
      for (const [name, expected] of providers) {
        const current = agent.ctx.get("subagents")?.getProvider(name);
        if (current === undefined || original(current) !== original(expected) || current.capabilities.depthLimit !== true) {
          throw new DsmmProfileError("conflict", "A required native provider changed before configuration commit.");
        }
      }
    };
    const install = (admission: DsmmProfileAdmission) => this.installing.run({ agent, admission }, () => this.install!(agent, this.getter(agent)));
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
          for (const role of targets) {
            const routing = admission.settings.roleRouting[role];
            if (routing?.primary !== undefined || routing?.fallbackRoutes !== undefined) {
              await resolveRoleInvocation(agent, role, admission.settings, preparationSignal, {}, undefined, resolvedModelParameterPolicy(admission)); assertCurrent();
            }
            for (const level of ["low", "high", "max"] as const) if (routing?.levels?.[level] !== undefined) {
              await resolveRoleInvocation(agent, role, admission.settings, preparationSignal, { level }, undefined, resolvedModelParameterPolicy(admission)); assertCurrent();
            }
          }
        });
        assertCurrent();
        prepared = true;
        await install(admission); assertCurrent();
        this.installing.run({ agent, admission }, describe);
        publication = Object.freeze({ ...previous, admission });
      },
      committed: () => { this.live.set(agent, publication); committed = true; },
      close: async () => {
        try { if (prepared && !committed && this.ctx.agents.get(agent.id) === agent && !this.lifetime.signal.aborted) await install(previous.admission); }
        catch (error) {
          this.failedInstallations.add(agent);
          const refusal = new DsmmProfileError("activation", "Session configuration restoration failed. Execution is disabled; create a new session.");
          refusal.cause = error;
          throw refusal;
        }
        finally { this.selecting.delete(agent); this.blankUpdates.delete(agent); finish(); }
      },
    };
  }
  async reserve(exec: Readonly<ToolExecution>, invocation: ResolvedRoleInvocation, provider: SubagentProvider, maxDepth?: number): Promise<{ childId: SessionId; release(): Promise<void>; signal: AbortSignal }> {
    const parent = exec.agent; if (!parent) throw new SubagentError("Calling Agent required", "UNAUTHORIZED");
    const parentAdmission = this.assert(parent);
    this.policy.assertDelegation(parent as DshAgent, invocation.target);
    const toolFilter = this.policy.delegationToolFilter(exec);
    const presets = this.ctx.get("agentPresets");
    if (!presets) throw new SubagentError("Native preset registry unavailable", "UNSUPPORTED_CAPABILITY");
    // The child shares the parent's standing composition; its role is carried
    // by the admitted invocation, not by an own registered preset.
    const expectedPreset = presets.composedPreset(parent.ctx);
    const lease = await presets.acquireScope(expectedPreset);
    try {
      exec.signal.throwIfAborted(); this.assert(parent);
      const currentProvider = this.ctx.get("subagents")?.getProvider(provider.name);
      if (!currentProvider || original(currentProvider) !== original(provider) || this.get(parent) !== parentAdmission) throw new SubagentError("Creation dependencies changed", "UNAUTHORIZED");
      const childId = SessionId(randomUUID()), signal = AbortSignal.any([exec.signal, this.lifetime.signal, this.agentLifetimes.get(parent)!.signal]);
      const admission = freezeSettings({ ...parentAdmission, settings: structuredClone(parentAdmission.settings) });
      const pending: Pending = Object.freeze({ childId, parent, parentAdmission, callId: exec.callId, invocation, admission, provider, expectedPreset, presetScope: lease.key, signal, maxDepth, toolFilter });
      this.pending.set(childId, pending);
      const revoke = () => { if (this.pending.get(childId) === pending) this.pending.delete(childId); };
      signal.addEventListener("abort", revoke, { once: true });
      return { childId, signal, release: async () => { revoke(); signal.removeEventListener("abort", revoke); await lease[Symbol.asyncDispose](); } };
    } catch (error) { await lease[Symbol.asyncDispose](); throw error; }
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
    void activation.result.finally(() => { if (!this.ctx.agents.get(activation.childId)) this.activations.delete(activation); }).catch(() => {});
    if (this.lifetime.signal.aborted) void activation.dispose().catch(error => this.ctx.logger.error(error));
  }
  private guardTools(agent: Agent): void {
    const tools = agent.ctx.get("agentPresets")?.serviceFor(agent, "tools") ?? agent.ctx.get("tools");
    if (!tools) return;
    const identity = original(tools), installed = this.guardedTools.get(agent) ?? new Set<object>();
    if (installed.has(identity)) return;
    installed.add(identity); this.guardedTools.set(agent, installed);
    getTraceable(agent.ctx, tools).guard(exec => {
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
    const children = new Set([...this.agents].filter(child => this.live.get(child)?.parent === agent));
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
    if (previous.parent || (this.calls.get(agent) ?? 0) !== 0 || [...this.pending.values()].some(row => row.parent === agent)
      || this.ctx.agents.list().some(child => this.ctx.agents.isOwnedBy(child.id, agent)) || sessionEvents(agent.session).some(event => event.type === "turn/start")) throw new SubagentError("Preset change requires a new session", "UNAUTHORIZED");
    this.policy.validateRootRole(agent as DshAgent, previous.admission);
    const preset = agent.ctx.get("agentPresets")?.composedPreset(agent.ctx), scopeParent = scopeParentOf(agent);
    this.guardTools(agent);
    await this.install!(agent, this.getter(agent));
    this.lifetime.signal.throwIfAborted();
    this.agentLifetimes.get(agent)!.signal.throwIfAborted();
    if (!this.isReady || this.ctx.agents.get(agent.id) !== agent || this.live.get(agent) !== previous || scopeParentOf(agent) !== scopeParent) throw new SubagentError("Composition changed during blank admission", "UNAUTHORIZED");
    this.live.set(agent, Object.freeze({ ...previous, preset, scopeParent }));
  }
  private async created(agent: Agent, source: string, creationSignal?: AbortSignal): Promise<void> {
    if (this.owns(agent)) { this.assert(agent); return; }
    const pending = this.pending.get(agent.id);
    // Native resume, promotion and durable provider recovery do not restore a DSMM role grant.
    if (source === "resume" && pending === undefined) return;
    if (pending && source !== "startup") throw new SubagentError("Role creation requires its first pending call", "UNAUTHORIZED");
    if (!this.isReady || !this.install) throw new SubagentError("DSMM admission is initializing", "UNAUTHORIZED");
    const signal = AbortSignal.any([...creationSignal ? [creationSignal] : [], this.lifetime.signal]);
    signal.throwIfAborted();
    const parents = this.ctx.agents.list().filter(parent => parent !== agent && this.ctx.agents.isOwnedBy(agent.id, parent));
    const parent = parents[0], preset = agent.ctx.get("agentPresets")?.composedPreset(agent.ctx), presetScope = scopeParentOf(agent);
    if (parents.length > 1 || this.ctx.agents.get(agent.id) !== agent) throw new SubagentError("Invalid native ownership", "UNAUTHORIZED");
    if (!pending && (parent && !this.owns(parent) || !parent && agent.session.header.origin === "subagent")) return;
    let admission: DsmmProfileAdmission;
    if (parent) {
      const parentAdmission = this.assert(parent), controlled = this.policy.identity(parent as DshAgent).role !== undefined;
      if (agent.session.header.parentSession !== parent.id || agent.session.header.origin !== "subagent") throw new SubagentError("Invalid native child header", "UNAUTHORIZED");
      if (pending) {
        this.check(pending);
        if (pending.parent !== parent || pending.parentAdmission !== parentAdmission || preset !== pending.expectedPreset || agent.session.header.isSeeded
          || scopeParentOf(agent) !== pending.presetScope) throw new SubagentError("Child does not match the pending invocation", "UNAUTHORIZED");
        if (pending.maxDepth !== undefined && delegationDepthOf(agent) > pending.maxDepth) throw new SubagentError("Child exceeds depth ceiling", "UNAUTHORIZED");
        admission = pending.admission;
      } else {
        if (controlled || preset?.startsWith("dsmm-")) throw new SubagentError("Use an admitted DSMM role tool", "UNAUTHORIZED");
        admission = parentAdmission;
      }
    } else {
      if (pending) throw new SubagentError("Missing exact parent", "UNAUTHORIZED");
      admission = await this.profiles.prepareRoot(agent as DshAgent, signal);
      this.policy.validateRootRole(agent as DshAgent, admission);
    }
    this.agentLifetimes.set(agent, new AbortController());
    scopeLifetime(agent.ctx, "dsmm: retire exact Agent work", () => { void this.retireAgent(agent).catch(() => {}); });
    agent.ctx.effect(() => async () => {
      try { await this.retireAgent(agent); }
      finally {
        this.live.delete(agent); this.candidates.delete(agent); this.agents.delete(agent);
        this.profiles.release(agent as DshAgent); this.policy.release(agent as DshAgent);
      }
    });
    this.candidates.set(agent, admission);
    this.agents.add(agent);
    // These registrations belong to the Agent, not the plugin owner. Revocation remains effective after unload.
    agent.ctx.on("agent/pre-step", async (frame, next) => { if (frame.agent === agent) await this.ensure(agent); return next(); }, { prepend: true });
    agent.ctx.on("agent/request", async (frame, next) => { if (frame.agent === agent) await this.ensure(agent); return next(); }, { prepend: true });
    agent.ctx.on("tools/pre-execute", async (exec, next) => { if (exec.agent === agent) { await this.ensure(agent); const denial = this.policy.preToolDenial(agent as DshAgent, exec.name, undefined, exec); if (denial) return { kind: "deny" as const, reason: denial }; } return next(); }, { prepend: true });
    this.guardTools(agent);
    try {
      if (pending) this.policy.bindChild(agent as DshAgent, parent! as DshAgent, admission, pending.invocation, pending.maxDepth, pending.toolFilter);
      else if (parent) this.policy.bindInheritedChild(agent as DshAgent, parent as DshAgent, admission);
      await this.install(agent, this.getter(agent));
      signal.throwIfAborted();
      this.agentLifetimes.get(agent)!.signal.throwIfAborted();
      if (pending) this.check(pending);
      if (parent) this.assert(parent);
      if (!this.isReady || this.ctx.agents.get(agent.id) !== agent || preset !== agent.ctx.get("agentPresets")?.composedPreset(agent.ctx)
        || presetScope !== scopeParentOf(agent) || parent && !this.ctx.agents.isOwnedBy(agent.id, parent)) throw new SubagentError("Agent changed during initialization", "UNAUTHORIZED");
      this.profiles.publish(agent as DshAgent, admission);
      const published = this.profiles.admission(agent as DshAgent);
      this.live.set(agent, Object.freeze({ admission: published, preset, scopeParent: scopeParentOf(agent), parent, invocation: pending?.invocation }));
      if (pending) this.pending.delete(agent.id);
    } catch (error) { this.policy.release(agent as DshAgent); throw error; }
    finally { this.candidates.delete(agent); }
  }
}

function original(value: object): object { return Reflect.get(value, symbols.original) ?? value; }
