import { AsyncLocalStorage } from "node:async_hooks";
import { symbols } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { TOOL_ABORTED } from "@deepseek-ai/dsh-tools";
import type { PreToolDecision, ToolDefinition, ToolExecution, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { NativeCommandEntry } from "./permission-settings.js";
import { PermissionRefusal, permissionOutcome } from "./permission-errors.js";
import { nativeStandingFullAccess } from "./permission-native-access.js";
import type { NativePermissionMode } from "./permission-native-access.js";
import { CommandApprovals } from "./command-approval.js";
import type { CommandApprovalBinding, CommandApprovalScope, CommandRuleContribution } from "./command-approval.js";
export { PermissionRefusal } from "./permission-errors.js";

export interface PermissionExecutionAuthority {
  readonly agent: Agent; readonly root: Agent; readonly realm: object;
  readonly admissionRevision: string; readonly permissionRevision: string;
  readonly owner: object; readonly ownerGeneration: string | number;
  readonly signal: AbortSignal;
}
export type PermissionRootApprovalAuthority = Pick<PermissionExecutionAuthority, "root" | "realm" | "admissionRevision" | "permissionRevision" | "owner" | "ownerGeneration" | "signal">;
export interface PermissionExecutionIntegrity {
  readonly signal?: AbortSignal;
  assertCurrent(): void;
}
export interface PermissionControlCollaborators {
  current(exec: Readonly<ToolExecution>): PermissionExecutionAuthority;
  rootCurrent?(root: Agent, exec: Readonly<ToolExecution>): PermissionRootApprovalAuthority;
  assertCurrent(authority: PermissionExecutionAuthority, exec: Readonly<ToolExecution>): void;
  /** Physical ownership and real scope lifetime only; never permission/admission epochs. */
  captureIntegrity?(exec: Readonly<ToolExecution>): PermissionExecutionIntegrity;
}
export interface PermissionRegistration {
  readonly definition: ToolDefinition; readonly registered: ToolDefinition;
  readonly body: ToolDefinition["execute"]; readonly identity: object; readonly signal?: AbortSignal;
  readonly wrapper?: ToolDefinition["execute"];
  readonly simpleOnly?: boolean;
  assertCurrent?(execution: Readonly<ToolExecution>): void;
  assertIntegrity?(execution: Readonly<ToolExecution>): void;
  approval(): Context["approval"] | undefined;
  standingMode(execution: Readonly<ToolExecution>): string | undefined;
  unchanged(): boolean; active: boolean;
}
export function permissionOriginal(value: object): object { return Reflect.get(value, symbols.original) ?? value; }
type Request = Parameters<Context["approval"]["request"]>[0];
type Outcome = Awaited<ReturnType<Context["approval"]["request"]>>;
/** Explicitly audited DSMM approval adapters retain identity through the patched dispatcher. */
export function permissionApprovalAdapter(ctx: Context, listener: (request: Request, next: () => Promise<Outcome>) => Promise<Outcome>): typeof listener {
  const approval = ctx.get("approval"), factory: unknown = approval && Reflect.get(approval, "createForwarder");
  if (typeof factory !== "function") return listener;
  return Reflect.apply(factory, approval, [listener]) as typeof listener;
}
interface Binding {
  readonly token: ToolExecution["token"]; readonly session?: Agent["session"];
  readonly exec: Readonly<ToolExecution>; readonly registration: PermissionRegistration;
  readonly args: unknown; readonly agent: ToolExecution["agent"]; readonly callId: ToolExecution["callId"]; readonly name: string;
  readonly root?: Agent; readonly integrity: PermissionExecutionIntegrity;
  signal: AbortSignal;
  readonly entry?: NativeCommandEntry; readonly reason: string;
  readonly simple: boolean;
  readonly officialMode?: NativePermissionMode; readonly target?: NativePermissionMode;
  readonly ask: boolean; readonly lifetime: AbortController;
  readonly rules?: CommandApprovalBinding;
  askSatisfied: boolean;
  entered: boolean; nativeRequest: boolean;
  approvedTarget?: NativePermissionMode; mode?: NativePermissionMode;
}
interface RequestBinding { readonly binding: Binding; readonly allow: boolean }
export function isSandboxWidening(requested: NativeCommandEntry["sandboxMode"], standing: string | undefined): boolean {
  return standing === "read-only" || standing === "workspace-write" && requested === "danger-full-access";
}

/** Permission admission precedes native approval; subsequent checks enforce execution integrity only. */
export class PermissionControl {
  private readonly lifetime = new AbortController();
  private readonly bindings = new Map<Readonly<ToolExecution>, Binding>();
  private readonly requests = new WeakMap<object, RequestBinding>();
  private readonly execution = new AsyncLocalStorage<Binding>();
  readonly commandApprovals: CommandApprovals;
  constructor(private readonly ctx: Context, private readonly collaborators: PermissionControlCollaborators, approvals?: CommandApprovals) {
    this.commandApprovals = approvals ?? new CommandApprovals(ctx);
  }

  async compose(exec: Readonly<ToolExecution>, registration: PermissionRegistration, entry: NativeCommandEntry | undefined,
    action: "inherit" | "allow" | "ask", next: () => Promise<PreToolDecision>, cwd: string, simple = false,
    contributions: readonly CommandRuleContribution[] = [], source: CommandApprovalScope = {}): Promise<PreToolDecision> {
    const previous = this.bindings.get(exec);
    if (simple && previous?.simple) { this.checkIntegrity(previous); return this.composeDecision(previous, next, false); }
    const nativeOnly = !simple && nativeStandingFullAccess(this.ctx, exec.agent);
    const authority = nativeOnly ? undefined : this.collaborators.current(exec);
    if (authority !== undefined) { registration.assertCurrent?.(exec); this.collaborators.assertCurrent(authority, exec); }
    const agent = exec.agent, realm = agent?.ctx;
    const integrity = this.collaborators.captureIntegrity?.(exec) ?? { assertCurrent: () => {
      if (agent !== undefined && (this.ctx.agents.get(agent.id) !== agent || agent.ctx !== realm)) throw new PermissionRefusal("not-owned");
      if (authority === undefined) return;
      const current = this.collaborators.current(exec);
      if (current.signal.aborted || current.agent !== authority.agent || current.root !== authority.root || current.realm !== authority.realm
        || current.owner !== authority.owner || current.ownerGeneration !== authority.ownerGeneration) throw new PermissionRefusal("not-owned");
    } };
    const args = exec.arguments as Record<string, unknown>;
    const officialMode = !nativeOnly && (args.sandbox_permissions === "workspace-write" || args.sandbox_permissions === "danger-full-access") ? args.sandbox_permissions : undefined;
    const standing = registration.standingMode(exec);
    const target = simple ? "danger-full-access" : officialMode ?? (entry === undefined ? undefined : isSandboxWidening(entry.sandboxMode, standing) ? entry.sandboxMode : entry.mode === "allow" ? standing ?? entry.sandboxMode : undefined);
    const rules = simple || nativeOnly || contributions.length === 0 ? undefined : this.commandApprovals.capture(exec, contributions, {
      ...source, deferredCommit: true, owner: authority?.owner, ownerGeneration: authority?.ownerGeneration, realm: authority?.realm, assertCurrent: () => integrity.assertCurrent(),
    });
    const ask = !simple && (rules === undefined ? action === "ask" || entry?.mode === "ask" : rules.missing.length > 0);
    const ruleNames = (rules?.missing ?? contributions).map(rule => {
      const semantics = rule.semantics;
      return semantics !== null && typeof semantics === "object" && "id" in semantics ? `${rule.kind}:${String(semantics.id)}` : rule.kind;
    });
    const reason = `DSMM command: ${String(args.command)}\nWorking directory: ${cwd}\n${ruleNames.length === 0 ? "" : `Command rules: ${ruleNames.join(", ")}\n`}Sandbox mode: ${target ?? "native standing policy"}. ${target === "danger-full-access" ? "Command execution may write outside the workspace to any OS-permitted location; this is not a cache-only or path-whitelist grant." : "Exact native tool invocation under the stated native sandbox policy."}`;
    const lifetime = new AbortController();
    const binding: Binding = { exec, token: exec.token, session: exec.agent?.session, args: exec.arguments, agent: exec.agent, callId: exec.callId, name: exec.name,
      registration, root: authority?.root, integrity, entry, officialMode, simple,
      target: target === "workspace-write" || target === "danger-full-access" ? target : undefined,
      reason, ask, rules, lifetime,
      signal: AbortSignal.any([exec.signal, lifetime.signal, this.lifetime.signal,
        ...integrity.signal === undefined ? [] : [integrity.signal], ...registration.signal === undefined ? [] : [registration.signal]]),
      entered: false, nativeRequest: false, askSatisfied: !ask };
    this.checkIntegrity(binding); this.bindings.set(exec, binding);
    return this.composeDecision(binding, next, nativeOnly);
  }
  private async composeDecision(binding: Binding, next: () => Promise<PreToolDecision>, nativeOnly: boolean): Promise<PreToolDecision> {
    const { exec, registration, reason } = binding;
    const downstream = await next();
    if (exec.signal.aborted) return { kind: "cancel" };
    this.checkIntegrity(binding);
    if (downstream.kind === "deny" || downstream.kind === "cancel") return downstream;
    if (nativeOnly) return downstream;
    const needsAsk = downstream.kind === "ask" || binding.ask && (binding.entry === undefined || binding.officialMode !== undefined);
    if (!needsAsk) return downstream;
    const reasons = [downstream.kind === "ask" ? downstream.reason : undefined, reason].filter(Boolean).join("\n");
    const displayReason = Object.freeze({ en: reasons, zh: reasons,
      ...downstream.kind === "ask" && downstream.displayReason !== undefined ? Object.fromEntries(Object.entries(downstream.displayReason).map(([locale, text]) => [locale, `${text}\n${reason}`])) : {} });
    if (binding.target === undefined && !binding.ask) return { kind: "ask", reason: reasons, displayReason };
    const approval = registration.approval();
    if (approval === undefined || exec.agent === undefined) return { kind: "deny", reason: "Native approval is unavailable for this command." };
    const request: Request = { agent: exec.agent, callId: exec.callId, toolName: exec.name, reason: reasons, displayReason, signal: binding.signal };
    const outcome = binding.simple ? await this.request(binding, request, approval, true) : await approval.request(request);
    if (exec.signal.aborted) return { kind: "cancel" };
    this.checkIntegrity(binding);
    if (outcome !== "allowed-once") return { kind: "deny", reason: `Native command approval ${outcome}.` };
    binding.rules?.resolved(outcome);
    binding.askSatisfied = true;
    binding.approvedTarget = binding.target;
    return { kind: "allow" };
  }

  private checkIntegrity(binding: Binding): void {
    if (binding.signal.aborted || binding.exec.signal.aborted) throw new HarnessError("Permission-controlled call cancelled.", TOOL_ABORTED);
    const { exec, registration } = binding;
    if (exec.token !== binding.token || exec.agent?.session !== binding.session || exec.arguments !== binding.args || exec.agent !== binding.agent || exec.callId !== binding.callId || exec.name !== binding.name
      || !registration.active || !registration.unchanged() || registration.definition.execute !== (registration.wrapper ?? registration.body)
      || this.ctx.tools.get(binding.name, binding.agent) !== registration.registered) throw new PermissionRefusal("stale");
    binding.integrity.assertCurrent();
    registration.assertIntegrity?.(exec);
    binding.rules?.assertCurrent();
  }
  guard(exec: Readonly<ToolExecution>): string | undefined {
    const binding = this.bindings.get(exec);
    if (binding === undefined) return undefined;
    try { this.checkIntegrity(binding); return undefined; }
    catch { return "Native command execution identity is no longer current."; }
  }
  async answerer(request: Request, next: () => Promise<Outcome>): Promise<Outcome> {
    const owned = this.requests.get(request);
    if (owned === undefined) {
      const binding = this.execution.getStore();
      if (binding === undefined || !binding.simple || binding.nativeRequest || request.agent !== binding.agent
        || request.callId !== binding.callId || request.toolName !== binding.name || request.signal !== binding.signal) return next();
      this.checkIntegrity(binding); binding.nativeRequest = true; binding.approvedTarget = binding.target;
      return "allowed-once";
    }
    this.checkIntegrity(owned.binding);
    return owned.allow ? "allowed-once" : permissionOutcome(next, owned.binding.signal, "cancelled");
  }
  isSimple(exec: Readonly<ToolExecution>): boolean {
    const binding = this.bindings.get(exec);
    if (binding?.simple !== true) return false;
    this.checkIntegrity(binding); return true;
  }
  pending(registration: PermissionRegistration): boolean { return [...this.bindings.values()].some(binding => binding.registration === registration); }
  async run<T>(exec: ToolRunContext, args: unknown, registration: PermissionRegistration, body: (signal: AbortSignal, args: unknown) => Promise<T>): Promise<T> {
    const binding = this.bindings.get(exec);
    if (binding === undefined && registration.simpleOnly) return body(exec.signal, args);
    if (binding === undefined || binding.registration !== registration || binding.entered || args !== binding.args) throw new PermissionRefusal("stale");
    binding.signal = AbortSignal.any([binding.signal, exec.signal]); this.checkIntegrity(binding); binding.entered = true;
    try {
      if (binding.entry !== undefined && (binding.target !== undefined || !binding.askSatisfied) && binding.officialMode === undefined && !nativeStandingFullAccess(this.ctx, exec.agent)) {
        if (binding.approvedTarget === undefined) {
          const approval = registration.approval();
          if (approval === undefined || exec.agent === undefined) throw new PermissionRefusal("unavailable");
          const request: Request = { agent: exec.agent, toolName: exec.name, callId: exec.callId, signal: binding.signal, reason: binding.reason };
          const outcome = await this.request(binding, request, approval, binding.entry.mode === "allow" && !binding.ask);
          if (outcome === "cancelled") throw new HarnessError("Native permission request cancelled.", TOOL_ABORTED);
          if (outcome !== "allowed-once") throw new PermissionRefusal(outcome === "unavailable" ? "unavailable" : "denied");
          binding.rules?.resolved(outcome);
          binding.askSatisfied = true;
          binding.approvedTarget = binding.target;
        }
        binding.mode = binding.approvedTarget;
      }
      this.commandApprovals.commit(binding.exec);
      return await this.execution.run(binding, () => body(binding.signal, binding.simple ? Object.freeze({ ...args as Record<string, unknown>,
        sandbox_permissions: "danger-full-access", justification: binding.reason }) : args));
    } finally { this.finish(binding.exec); }
  }
  private async request(binding: Binding, request: Request, service: Context["approval"], allow: boolean): Promise<Outcome> {
    this.requests.set(request, { binding, allow });
    try { const result = await service.request(request); this.checkIntegrity(binding); return result; }
    finally { this.requests.delete(request); }
  }
  /** Scoped original native body; a target fact is consumed only for its exact official request. */
  async nativeApproval(request: Request, service: Context["approval"]): Promise<Outcome> {
    const binding = this.execution.getStore();
    if (binding?.simple) return service.request(request);
    if (binding === undefined || binding.officialMode === undefined || binding.nativeRequest || request.agent !== binding.agent
      || request.callId !== binding.callId || request.toolName !== binding.registration.definition.name || request.signal !== binding.signal) return service.request(request);
    this.checkIntegrity(binding); binding.nativeRequest = true;
    if (binding.approvedTarget === binding.officialMode) { binding.approvedTarget = undefined; return "allowed-once"; }
    const actual: Request = { ...request, reason: [request.reason, binding.reason].filter(Boolean).join("\n") };
    const covers = binding.entry !== undefined && (binding.entry.sandboxMode === "danger-full-access" || binding.officialMode === "workspace-write");
    const outcome = await this.request(binding, actual, service, covers && binding.entry!.mode === "allow" && !binding.ask);
    binding.rules?.resolved(outcome);
    if (outcome === "allowed-once") this.commandApprovals.commit(binding.exec);
    return outcome;
  }
  approvedTarget(exec: Readonly<ToolExecution>): NativePermissionMode | undefined {
    const binding = this.bindings.get(exec); if (binding === undefined) return undefined;
    this.checkIntegrity(binding); return binding.approvedTarget;
  }
  sandboxMode(): NativePermissionMode | undefined {
    const binding = this.execution.getStore(); if (binding === undefined || binding.mode === undefined) return undefined;
    this.checkIntegrity(binding); const mode = binding.mode; binding.mode = undefined; binding.approvedTarget = undefined; return mode;
  }
  finish(exec: Readonly<ToolExecution>): void {
    const binding = this.bindings.get(exec);
    if (binding !== undefined) { binding.mode = undefined; binding.approvedTarget = undefined; binding.lifetime.abort(); }
    this.bindings.delete(exec); this.commandApprovals.finish(exec);
  }
  revokePolicy(): void { this.commandApprovals.invalidate(); }
  revokeRegistration(registration: PermissionRegistration): void { registration.active = false; }
  revokeAgent(agent: Agent): void { this.commandApprovals.revokeAgent(agent); for (const binding of this.bindings.values()) if (binding.agent === agent || binding.root === agent) this.finish(binding.exec); }
  retire(): void { this.lifetime.abort(); this.commandApprovals.invalidate(); for (const binding of this.bindings.values()) { binding.lifetime.abort(); binding.mode = undefined; binding.approvedTarget = undefined; } }
}
