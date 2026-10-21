import { AsyncLocalStorage } from "node:async_hooks";
import { SubagentError, delegationDepthOf } from "@deepseek-ai/dsh-subagent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Context, symbols } from "@deepseek-ai/cordis";
import type { ToolRestriction, ToolRuntime, ToolDefinition, ToolExecution } from "@deepseek-ai/dsh-tools";
import type { DshAgent, DshContext, DshAgentsRegistry } from "./dsh-types.js";
import { DSMM_ROLES, allowedRoleChildren, isDsmmRoleId } from "./roles.js";
export { allowedRoleChildren } from "./roles.js";
import type { DsmmRoleId } from "./roles.js";
import type { DsmmProfileAdmission, DsmmSettings, DsmmSettingsGetter } from "./settings.js";
import { isRootRoleEnabled } from "./settings.js";
import { bindRoleInvocation } from "./role-invocation.js";
import type { ResolvedRoleInvocation } from "./role-invocation.js";
import { captureRoleRuntimePolicy } from "./routing-policy.js";
import type { DeepworkModeController } from "./state.js";
import { resolveEffectiveDsmmRole, resolveSelectedAgentPreset } from "./session-scope.js";
import { scopeParentOf } from "./native-scope.js";

export interface DsmmRoleIdentity {
  readonly role?: DsmmRoleId;
  readonly child: boolean;
  readonly epoch: string;
  readonly parent?: DshAgent;
  readonly readOnly?: boolean;
  readonly toolFilter?: ToolRestriction;
  readonly preset?: string;
}
const liveIdentities = new WeakMap<DshAgent, DsmmRoleIdentity>();
const toolIdentities = new WeakMap<DshAgent, { realm: object; definitions: Map<string, ToolDefinition> }>();
const controlledDefinitions = new WeakSet<ToolDefinition>();
export const READONLY_ROLE_DENIED_TOOLS = ["write", "edit", "bash", "pwsh"] as const;
const readTools = new Set(["read", "glob", "grep", "read_image", "web_search", "web_fetch", "skill", "load_skill", "structured_output", "send_message", "interrupt_agent", "exit_plan_mode", "ask_user_question", "todo_write", "job_output", "job_list", "job_kill"]);
const readLsp = new Set(["status", "diagnostics", "goto_definition", "find_references", "find_symbol_related", "symbols", "prepare_rename"]);
export function roleToolName(role: DsmmRoleId): string { return role.replace(/-/gu, "_"); }
export function roleFromToolName(name: string): DsmmRoleId | undefined { return name === "explore" ? "dsmm-code-search" : DSMM_ROLES.find(row => roleToolName(row.id) === name)?.id; }
export function readonlyRoleTool(name: string, settings: DsmmSettings): boolean { return readTools.has(name) || name === `mcp__${settings.lsp.serverName}__${name.split("__").at(-1)}` && readLsp.has(name.split("__").at(-1)!); }
export function inheritToolFilter(parent?: ToolRestriction, requested?: ToolRestriction): ToolRestriction | undefined {
  if (parent === undefined && requested === undefined) return undefined;
  const allow = parent?.allow === undefined ? requested?.allow : requested?.allow === undefined ? parent.allow : parent.allow.filter(name => requested.allow!.includes(name));
  return Object.freeze({ ...(allow === undefined ? {} : { allow: Object.freeze([...allow]) }), deny: Object.freeze([...new Set([...parent?.deny ?? [], ...requested?.deny ?? []])]) });
}
export function resolveAdmittedDsmmRole(agent: DshAgent, settings: DsmmSettings, active: boolean): DsmmRoleId | undefined {
  const identity = liveIdentities.get(agent);
  if (identity !== undefined) return identity.role;
  if (Context.is(agent.ctx)) {
    if (!settings.modules.deepwork.enabled || !agent.ctx.get("dsmmNativeAdmission")?.owns(agent as Agent) || agent.session.header?.origin === "subagent") return undefined;
    const preset = agent.ctx.get("agentPresets")?.composedPreset(agent.ctx);
    const role = isDsmmRoleId(preset) ? preset : active ? "dsmm-orchestrator" : undefined;
    return role !== undefined && settings.roles[role] ? role : undefined;
  }
  return resolveEffectiveDsmmRole(agent, settings, active);
}
interface ToolCall {
  readonly agent: Agent; readonly context: Context; readonly registry: object; readonly realm?: object;
  readonly scopeParent?: object; readonly parents: readonly Agent[]; readonly parentSession?: string;
  readonly name: string; readonly args: unknown; readonly callId: ToolExecution["callId"]; readonly signal: AbortSignal;
  readonly definition?: ToolDefinition; readonly body?: ToolDefinition["execute"]; readonly argumentsJson?: string;
  readonly toolFilter: ToolRestriction;
}

/** Role and exact-call restrictions; no child creation or execution owner. */
export class DsmmRolePolicy {
  private readonly executions = new AsyncLocalStorage<Readonly<ToolExecution>>();
  private readonly toolCalls = new WeakMap<object, ToolCall>();
  constructor(private readonly ctx: DshContext, private readonly getSettings: DsmmSettingsGetter, private readonly mode: DeepworkModeController) {}
  private agents(): DshAgentsRegistry { const agents = this.ctx.get?.<DshAgentsRegistry>("agents"); if (!agents) throw new SubagentError("Native registry unavailable", "UNAUTHORIZED"); return agents; }
  assertLive(agent: DshAgent): void { if (!agent.id || this.agents().get(agent.id) !== agent) throw new SubagentError("Exact live Agent required", "UNAUTHORIZED"); }
  private selected(agent: DshAgent): string | undefined {
    return Context.is(agent.ctx) ? agent.ctx.get("agentPresets")?.composedPreset(agent.ctx) : resolveSelectedAgentPreset(agent.session);
  }
  validateRootRole(agent: DshAgent, admission: DsmmProfileAdmission): void {
    this.assertLive(agent);
    const selected = this.selected(agent);
    if (selected?.startsWith("dsmm-") && (!isDsmmRoleId(selected) || !isRootRoleEnabled(admission.settings, selected))) throw new SubagentError("Preset is not eligible as a root", "UNAUTHORIZED");
  }
  bindChild(agent: DshAgent, parent: DshAgent, admission: DsmmProfileAdmission, invocation: ResolvedRoleInvocation, maximum: number | undefined, toolFilter: ToolRestriction): void {
    this.assertLive(agent); this.assertLive(parent); this.assertDelegation(parent, invocation.target);
    if (!this.agents().isOwnedBy(agent.id!, parent) || agent.session.header?.parentSession !== parent.id || this.selected(agent) !== this.selected(parent)) throw new SubagentError("Child lineage or composition mismatch", "UNAUTHORIZED");
    if (maximum !== undefined && delegationDepthOf(agent as Agent) > maximum) throw new SubagentError("Delegation depth exceeded", "UNAUTHORIZED");
    const upstream = this.identity(parent);
    liveIdentities.set(agent, Object.freeze({ role: invocation.target, child: true, parent, preset: this.selected(agent), epoch: admission.epoch,
      readOnly: this.readOnly(upstream) || DSMM_ROLES.find(row => row.id === invocation.target)!.access === "read-only",
      toolFilter: inheritToolFilter(inheritToolFilter(upstream.toolFilter, toolFilter), this.visibleToolCeiling(parent)) }));
    bindRoleInvocation(agent, invocation);
    captureRoleRuntimePolicy(admission.settings, invocation.target, invocation.policy);
  }
  /** Ordinary native inheritance captures ceilings without inventing a role invocation. */
  bindInheritedChild(agent: DshAgent, parent: DshAgent, admission: DsmmProfileAdmission): void {
    this.assertLive(agent); this.assertModuleAdmission(parent);
    const upstream = this.identity(parent), preset = this.selected(agent);
    if (upstream.role !== undefined || preset?.startsWith("dsmm-") || !this.agents().isOwnedBy(agent.id!, parent)
      || agent.session.header?.origin !== "subagent" || agent.session.header.parentSession !== parent.id) throw new SubagentError("Ordinary inheritance requires its exact non-controlled parent", "UNAUTHORIZED");
    liveIdentities.set(agent, Object.freeze({ child: true, parent, preset, epoch: admission.epoch,
      readOnly: this.readOnly(upstream), toolFilter: inheritToolFilter(upstream.toolFilter, this.visibleToolCeiling(parent)) }));
  }
  release(agent: DshAgent): void { liveIdentities.delete(agent); toolIdentities.delete(agent); }
  assertModuleAdmission(agent: DshAgent): void {
    this.assertLive(agent);
    const settings = this.getSettings(agent), identity = liveIdentities.get(agent), selected = this.selected(agent);
    if (identity?.child) {
      this.assertLive(identity.parent!);
      if (!this.agents().isOwnedBy(agent.id!, identity.parent!) || selected !== identity.preset
        || identity.role !== undefined && selected !== this.selected(identity.parent!)) throw new SubagentError("Child admission no longer matches composition", "UNAUTHORIZED");
    } else if (agent.session.header?.origin !== "subagent") this.validateRootRole(agent, this.getSettings.admission!(agent));
    const role = identity?.role ?? (isDsmmRoleId(selected) ? selected : undefined);
    if (role && (!settings.modules.deepwork.enabled || !settings.roles[role])) throw new SubagentError("Role is disabled in the immutable admission", "UNAUTHORIZED");
  }
  identity(agent: DshAgent): DsmmRoleIdentity {
    this.assertLive(agent);
    const existing = liveIdentities.get(agent); if (existing) return existing;
    const settings = this.getSettings(agent), selected = this.selected(agent);
    const parent = this.agents().list().find(row => row !== agent && this.agents().isOwnedBy(agent.id!, row));
    if (!parent) this.validateRootRole(agent, this.getSettings.admission!(agent));
    const role = parent ? undefined : isDsmmRoleId(selected) ? selected : settings.modules.deepwork.enabled && this.mode.active(agent, settings.defaultActive) ? "dsmm-orchestrator" : undefined;
    return Object.freeze({ role, child: parent !== undefined, parent, epoch: this.getSettings.admission!(agent).epoch });
  }
  admit(agent: DshAgent): DsmmRoleIdentity { return this.identity(agent); }
  private readOnly(identity: DsmmRoleIdentity): boolean { return identity.readOnly === true || DSMM_ROLES.find(row => row.id === identity.role)?.access === "read-only"; }
  targets(agent: DshAgent): readonly DsmmRoleId[] {
    const identity = this.identity(agent), settings = this.getSettings(agent);
    if (!settings.modules.deepwork.enabled || !identity.role || !settings.roles[identity.role]) return [];
    return allowedRoleChildren(identity.role, identity.child).filter(role => settings.roles[role] && (!this.readOnly(identity) || DSMM_ROLES.find(row => row.id === role)!.access === "read-only")
      && (identity.toolFilter?.allow === undefined || [roleToolName(role), DSMM_ROLES.find(row => row.id === role)?.kind === "category" ? "dsmm_category" : "dsmm_role"].some(name => identity.toolFilter!.allow!.includes(name)))
      && !identity.toolFilter?.deny?.includes(roleToolName(role)));
  }
  assertDelegation(parent: DshAgent, role: DsmmRoleId) {
    this.assertModuleAdmission(parent);
    if (!this.targets(parent).includes(role)) throw new SubagentError("Role delegation is not admitted", "UNAUTHORIZED");
    return { parent, role, epoch: this.identity(parent).epoch };
  }
  captureTools(agent: DshAgent, tools: ToolRuntime, names: readonly string[] = [], reset = false): void {
    const realm: object = Reflect.get(tools, symbols.original) ?? tools, previous = toolIdentities.get(agent);
    const definitions = previous === undefined || reset || previous.realm !== realm ? new Map<string, ToolDefinition>() : previous.definitions;
    for (const schema of tools.schemas(agent as Agent)) if (!previous || reset || previous.realm !== realm || names.includes(schema.name)) {
      const definition = tools.get(schema.name, agent as Agent)!; definitions.set(schema.name, definition); if (names.includes(schema.name)) controlledDefinitions.add(definition);
    }
    toolIdentities.set(agent, { realm, definitions });
  }
  toolBlacklistDenial(agent: DshAgent, name: string, execution?: Readonly<ToolExecution>): string | undefined { return this.preToolDenial(agent, name, undefined, execution); }
  captureToolExecution(execution: Readonly<ToolExecution>, _full: boolean): void {
    const agent = execution.agent; if (!agent) return;
    if (this.toolCalls.has(execution)) return;
    this.assertLive(agent as DshAgent);
    const agents = agent.ctx.get("agents")!, tools = agent.ctx.get("agentPresets")?.serviceFor(agent, "tools") ?? agent.ctx.get("tools"), definition = tools?.get(execution.name, agent);
    this.toolCalls.set(execution, { agent, context: agent.ctx, registry: Reflect.get(agents, symbols.original) ?? agents,
      realm: tools === undefined ? undefined : Reflect.get(tools, symbols.original) ?? tools, scopeParent: scopeParentOf(agent),
      parents: agents.list().filter(parent => parent !== agent && agents.isOwnedBy(agent.id, parent)), parentSession: agent.session.header.parentSession,
      name: execution.name, args: execution.arguments, callId: execution.callId, signal: execution.signal,
      toolFilter: this.visibleToolCeiling(agent as DshAgent),
      ...(definition === undefined || !controlledDefinitions.has(definition) ? {} : { definition, body: definition.execute, argumentsJson: JSON.stringify(execution.arguments) }) });
  }
  /** Visible native names are a narrowing ceiling, never permission to execute a definition. */
  private visibleToolCeiling(agent: DshAgent): ToolRestriction {
    const native = agent.ctx as Context, tools = native.get("agentPresets")?.serviceFor(agent as Agent, "tools") ?? native.get("tools");
    if (!tools) throw new SubagentError("Native tools unavailable", "UNAUTHORIZED");
    return Object.freeze({ allow: Object.freeze(tools.schemas(agent as Agent).map(tool => tool.name)) });
  }
  delegationToolFilter(execution: Readonly<ToolExecution>): ToolRestriction {
    this.assertToolExecution(execution);
    const call = this.toolCalls.get(execution);
    if (!call) throw new SubagentError("Native tool execution capture required", "UNAUTHORIZED");
    return call.toolFilter;
  }
  assertToolExecution(execution: Readonly<ToolExecution>): void {
    execution.signal.throwIfAborted(); const agent = execution.agent; if (!agent) return;
    this.assertModuleAdmission(agent as DshAgent);
    const call = this.toolCalls.get(execution); if (!call) return;
    call.signal.throwIfAborted();
    const agents = agent.ctx.get("agents")!, tools = agent.ctx.get("agentPresets")?.serviceFor(agent, "tools") ?? agent.ctx.get("tools");
    const parents = agents.list().filter(parent => parent !== agent && agents.isOwnedBy(agent.id, parent));
    if (agent !== call.agent || agent.ctx !== call.context || (Reflect.get(agents, symbols.original) ?? agents) !== call.registry
      || (tools === undefined ? undefined : Reflect.get(tools, symbols.original) ?? tools) !== call.realm || scopeParentOf(agent) !== call.scopeParent
      || agent.session.header.parentSession !== call.parentSession || parents.length !== call.parents.length || parents.some(parent => !call.parents.includes(parent))) throw new SubagentError("Tool caller ownership changed", "UNAUTHORIZED");
    if (call.definition && (execution.name !== call.name || execution.arguments !== call.args || execution.callId !== call.callId || JSON.stringify(execution.arguments) !== call.argumentsJson
      || call.definition.execute !== call.body || tools?.get(call.name, agent) !== call.definition)) throw new SubagentError("Tool invocation changed", "UNAUTHORIZED");
  }
  beforeToolDecision<T>(operation: () => T): T { return this.executions.exit(operation); }
  duringToolExecution<T>(execution: Readonly<ToolExecution>, operation: () => Promise<T>): Promise<T> { this.assertToolExecution(execution); return this.executions.run(execution, operation); }
  toolDenial(agent: DshAgent, name: string, tools?: ToolRuntime, execution?: Readonly<ToolExecution>): string | undefined { return this.preToolDenial(agent, name, tools, execution); }
  preToolDenial(agent: DshAgent, name: string, tools?: ToolRuntime, execution?: Readonly<ToolExecution>): string | undefined {
    const identity = this.identity(agent), settings = this.getSettings(agent);
    const native = agent.ctx as Context, realm = tools ?? native.get("agentPresets")?.serviceFor(agent as Agent, "tools") ?? native.get("tools");
    const definition = realm?.get(name, agent as Agent), owned = definition !== undefined && controlledDefinitions.has(definition);
    const target = owned ? roleFromToolName(name) : undefined, merged = owned && ["dsmm_role", "dsmm_category"].includes(name);
    if (tools && (this.readOnly(identity) || target || merged)) {
      const admitted = toolIdentities.get(agent);
      if (!admitted || admitted.realm !== (Reflect.get(tools, symbols.original) ?? tools) || admitted.definitions.get(name) !== definition) return "Tool definition was not admitted in this Agent realm";
    }
    const nativeOutput = name === "structured_output" && definition !== undefined && toolIdentities.get(agent)?.definitions.get(name) === definition;
    if (identity.toolFilter?.allow !== undefined && !identity.toolFilter.allow.includes(name) && !nativeOutput || identity.toolFilter?.deny?.includes(name)) return "Tool exceeds inherited filter";
    if (identity.toolFilter && identity.parent && name !== "structured_output") {
      const parent = identity.parent as Agent, parentTools = parent.ctx.get("agentPresets")?.serviceFor(parent, "tools") ?? parent.ctx.get("tools");
      if (!parentTools?.get(name, parent)) return "Parent no longer exposes this capability";
      const denied = this.preToolDenial(identity.parent, name, undefined, execution);
      if (denied) return denied;
    }
    if (target) return this.targets(agent).includes(target) ? undefined : "Role delegation is not permitted";
    if (merged) {
      const kind = name === "dsmm_role" ? "role" : "category", args = execution?.arguments as Record<string, unknown> | undefined;
      if (!this.targets(agent).some(id => DSMM_ROLES.find(row => row.id === id)?.kind === kind)) return "Delegation entry is not admitted";
      const requested = args?.[kind]; return isDsmmRoleId(requested) && !this.targets(agent).includes(requested) ? "Requested role is not admitted" : undefined;
    }
    if (this.readOnly(identity) && !readonlyRoleTool(name, settings)) return "Read-only role does not permit this tool";
    if (identity.role && ["subagent", "spawn", "fork"].includes(name)) return "Use admitted DSMM role tools";
    return undefined;
  }
}
