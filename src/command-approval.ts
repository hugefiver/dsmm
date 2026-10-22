import { isDeepStrictEqual } from "node:util";
import { symbols } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import { PermissionRefusal } from "./permission-errors.js";

type Approval = Context["approval"];
type Outcome = Awaited<ReturnType<Approval["request"]>>;
const original = (value: object): object => Reflect.get(value, symbols.original) ?? value;

/** A matcher supplies the whole rule semantics, not a command/reason-derived permission. */
export interface CommandRuleContribution {
  readonly kind: "git" | "shell" | "native-command";
  readonly semantics: unknown;
  readonly reusable?: boolean;
}
export interface CommandApprovalScope {
  /** Managed entry points commit only after their stronger final integrity check. */
  readonly deferredCommit?: boolean;
  readonly source?: object;
  sourceCurrent?(): object;
  readonly owner?: object;
  readonly ownerGeneration?: string | number;
  readonly realm?: object;
  assertCurrent?(): void;
}
interface RememberedRule {
  readonly rule: CommandRuleContribution;
  readonly tools: object;
  readonly definition: object;
  readonly source?: object;
  readonly owner: object;
  readonly ownerGeneration?: string | number;
  readonly realm: object;
}
interface SessionRuleApprovals { readonly session: Agent["session"]; readonly rules: RememberedRule[] }
export interface CommandApprovalBinding {
  readonly missing: readonly CommandRuleContribution[];
  readonly signal: AbortSignal;
  assertCurrent(): void;
  /** Only the caller awaiting its own complete service request may supply this outcome. */
  resolved(outcome: Outcome): void;
}
interface Invocation extends CommandApprovalBinding { readonly deferredCommit: boolean; commit(): void }

/** Core-owned memory. Invocation records never serve as reusable native target grants. */
export class CommandApprovals {
  private memory = new WeakMap<Agent, SessionRuleApprovals>();
  private invocations = new WeakMap<object, Invocation[]>();
  private readonly retiredAgents = new WeakSet<Agent>();
  private generation: object = {};
  private readonly lifetime = new AbortController();
  constructor(private readonly ctx: Context) {
    ctx.inject(["tools"], scope => { scope.tools.guard(exec => this.guard(exec)); });
    ctx.on("tools/execute", async (exec, next) => { this.commit(exec, false); return next(); }, { global: true, prepend: true });
    ctx.on("tools/result", exec => { this.finish(exec); }, { global: true });
    ctx.on("agent/disposed", ({ agent }) => { this.revokeAgent(agent); }, { global: true });
    ctx.effect(() => () => this.retire());
  }

  capture(exec: Readonly<ToolExecution>, contributions: readonly CommandRuleContribution[], scope: CommandApprovalScope = {}): CommandApprovalBinding | undefined {
    const agent = exec.agent;
    if (agent === undefined || this.retiredAgents.has(agent)) return undefined;
    const resolveTools = () => agent.ctx.get("agentPresets")?.serviceFor(agent, "tools") ?? agent.ctx.get("tools");
    const tools = resolveTools(), definition = tools?.get(exec.name, agent), registry = agent.ctx.get("agents");
    if (tools === undefined || definition === undefined || registry === undefined || registry.get(agent.id) !== agent) return undefined;
    const session = agent.session, workspace = session.header.cwd, context = agent.ctx, token = exec.token, args = exec.arguments;
    const values: unknown = structuredClone(args), name = exec.name, callId = exec.callId;
    const owner = scope.owner ?? this, realm = scope.realm ?? context, generation = this.generation;
    const signal = AbortSignal.any([exec.signal, this.lifetime.signal]);
    const rules = contributions.map(rule => ({ ...rule, semantics: structuredClone(rule.semantics) }));
    let approved = false;
    const assertCurrent = (): void => {
      const currentTools = resolveTools(), currentRegistry = agent.ctx.get("agents");
      if (signal.aborted || exec.signal.aborted || this.retiredAgents.has(agent)) throw new PermissionRefusal("cancelled");
      if (agent.session !== session || agent.ctx !== context
        || currentTools === undefined || original(currentTools) !== original(tools) || currentTools.get(name, agent) !== definition
        || currentRegistry === undefined || original(currentRegistry) !== original(registry) || currentRegistry.get(agent.id) !== agent) {
        this.memory.delete(agent); throw new PermissionRefusal("stale");
      }
      if (exec.token !== token || exec.arguments !== args || !isDeepStrictEqual(exec.arguments, values)
        || exec.agent !== agent || exec.name !== name || exec.callId !== callId || session.header.cwd !== workspace) throw new PermissionRefusal("stale");
      try { scope.assertCurrent?.(); } catch (error) { this.memory.delete(agent); throw error; }
    };
    const sourceCurrent = (): boolean => {
      try { return generation === this.generation && (scope.sourceCurrent === undefined || scope.sourceCurrent() === scope.source); }
      catch { return false; }
    };
    const policyAllows = (): boolean => {
      const approval = this.ctx.get("approval");
      return approval !== undefined && (approval.overrideOf(session) ?? approval.config.policy ?? "ask") !== "never";
    };
    const previous = this.memory.get(agent);
    if (previous !== undefined && previous.session !== session) this.memory.delete(agent);
    const remembered = previous?.session === session ? previous.rules : [];
    const missing = rules.filter(rule => rule.reusable === false || !sourceCurrent() || !policyAllows() || !remembered.some(item =>
      item.tools === original(tools) && item.definition === definition && item.source === scope.source && item.owner === owner
      && item.ownerGeneration === scope.ownerGeneration && item.realm === realm && isDeepStrictEqual(item.rule, rule)));
    const binding: Invocation = {
      missing, signal, assertCurrent, deferredCommit: scope.deferredCommit === true,
      resolved: outcome => { assertCurrent(); approved = outcome === "allowed-once"; },
      commit: () => {
        assertCurrent();
        if (!approved || !sourceCurrent() || !policyAllows()) return;
        approved = false;
        let state = this.memory.get(agent);
        if (state?.session !== session) { state = { session, rules: [] }; this.memory.set(agent, state); }
        for (const rule of missing) {
          if (rule.reusable === false) continue;
          const item = { rule, tools: original(tools), definition, source: scope.source, owner, ownerGeneration: scope.ownerGeneration, realm };
          if (!state.rules.some(previous => previous.tools === item.tools && previous.definition === definition && previous.source === item.source
            && previous.owner === owner && previous.ownerGeneration === item.ownerGeneration && previous.realm === realm && isDeepStrictEqual(previous.rule, rule))) state.rules.push(item);
        }
      },
    };
    assertCurrent();
    const bindings = this.invocations.get(exec) ?? [];
    bindings.push(binding); this.invocations.set(exec, bindings);
    return binding;
  }

  /** Generic guard-owned request, including no-target calls and independent downstream asks. */
  async decide(exec: Readonly<ToolExecution>, binding: CommandApprovalBinding | undefined, next: () => Promise<PreToolDecision>, reason: string): Promise<PreToolDecision> {
    const downstream = await next();
    if (exec.signal.aborted || binding?.signal.aborted) return { kind: "cancel" };
    binding?.assertCurrent();
    if (downstream.kind === "deny" || downstream.kind === "cancel" || binding?.missing.length === 0) return downstream;
    const combined = [downstream.kind === "ask" ? downstream.reason : undefined, reason].filter(Boolean).join("\n");
    if (binding === undefined) return downstream.kind === "allow" ? { kind: "ask", reason: combined } : downstream;
    const approval = this.ctx.get("approval");
    if (approval === undefined || exec.agent === undefined) return { kind: "deny", reason: "Command approval is unavailable." };
    const displayReason = Object.freeze({ en: combined, zh: combined,
      ...downstream.kind === "ask" && downstream.displayReason !== undefined
        ? Object.fromEntries(Object.entries(downstream.displayReason).map(([locale, text]) => [locale, `${text}\n${reason}`])) : {} });
    const outcome = await approval.request({ agent: exec.agent, callId: exec.callId, toolName: exec.name, signal: binding.signal, reason: combined, displayReason });
    if (exec.signal.aborted || binding.signal.aborted) return { kind: "cancel" };
    binding.resolved(outcome);
    return outcome === "allowed-once" ? { kind: "allow" } : { kind: outcome === "cancelled" ? "cancel" : "deny", reason: "Command approval was not granted." };
  }
  check(exec: Readonly<ToolExecution>): void { for (const binding of this.invocations.get(exec) ?? []) binding.assertCurrent(); }
  commit(exec: Readonly<ToolExecution>, includeDeferred = true): void {
    this.check(exec);
    for (const binding of this.invocations.get(exec) ?? []) if (includeDeferred || !binding.deferredCommit) binding.commit();
  }
  guard(exec: Readonly<ToolExecution>): string | undefined {
    try { this.check(exec); return undefined; }
    catch { return "Command execution identity is no longer current."; }
  }
  finish(exec: Readonly<ToolExecution>): void { this.invocations.delete(exec); }
  invalidate(): void { this.generation = {}; this.memory = new WeakMap(); }
  revokeAgent(agent: Agent): void { this.retiredAgents.add(agent); this.memory.delete(agent); }
  retire(): void { this.lifetime.abort(); this.invalidate(); }
}
