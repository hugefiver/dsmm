import type { DshContext } from "./dsh-types.js";
import { Context as NativeContext, getTraceable } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { DSMM_ROLES, DSMM_ROLE_IDS, rolePluginRows } from "./roles.js";
import type { DsmmRoleId } from "./roles.js";
import { enabledSkillNames } from "./skills.js";
import type { DsmmSettings } from "./settings.js";
import { isRootRoleEnabled } from "./settings.js";
import { allowedRoleChildren, readonlyRoleTool, roleFromToolName, READONLY_ROLE_DENIED_TOOLS } from "./role-policy.js";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import { nativeStandingFullAccess } from "./permission-native-access.js";
import { scopeParentOf } from "./native-scope.js";

interface NativePresetRegistry {
  register(definition: {
    id: string;
    name: string;
    description: string;
    order: number;
    plugins: ReturnType<typeof rolePluginRows>;
  }): Promise<() => Promise<void>>;
  composedPreset(ctx: unknown): string | undefined;
  serviceFor?(agent: NativeAgent, name: "tools"): NativeScopedTools | undefined;
}

interface NativeScopedTools {
  get(name: string, scope?: object): unknown;
  restrict(filter: { deny: string[] }): () => void;
}

interface NativeAgent {
  ctx: { tools?: NativeScopedTools; get?<T>(name: string): T | undefined };
  id?: string;
}

interface NativeAgentRegistry {
  list(): NativeAgent[];
  get(id: string): NativeAgent | undefined;
  isOwnedBy(childId: string, parent: NativeAgent): boolean;
}

/**
 * Declare the selectable dispatcher composition to DSH 0.2's native registry;
 * directories are not discovery inputs. `roleIdentity` reports the admitted
 * delegation role of an Agent, whose composition is shared with its parent.
 */
export function registerRolePresets(ctx: DshContext, getSettings: () => DsmmSettings, roleIdentity?: (agent: NativeAgent) => string | undefined): void | Promise<void> {
  const install = async (readyCtx: DshContext): Promise<void> => {
    const registry = readyCtx.get?.<NativePresetRegistry>("agentPresets")
      ?? (readyCtx as DshContext & { agentPresets?: NativePresetRegistry }).agentPresets;
    if (registry === undefined) throw new Error("dsmm requires the native DSH agentPresets registry");
    const settings = getSettings();
    // Only the dispatcher is a user-selectable composition. Delegation targets
    // share their parent's standing composition and carry their role entirely
    // through the admitted invocation and per-Agent registrations.
    // Only the dispatcher is a user-selectable composition. Delegation targets
    // share their parent's standing composition and carry their role entirely
    // through the admitted invocation and per-Agent registrations.
    const active = DSMM_ROLES.filter((role) => isRootRoleEnabled(settings, role.id));
    const disposers: Array<() => Promise<void>> = [];
    try {
      for (const role of active) {
        disposers.push(await registry.register({
          id: role.id,
          name: role.name,
          description: role.description,
          order: role.order,
          // Profiles do not replace standing native compositions. Child routes
          // are admitted by the role provider from the parent's fixed snapshot.
          plugins: rolePluginRows(role, enabledSkillNames(settings), DSMM_ROLE_IDS.filter((id) => settings.modules.deepwork.enabled && settings.roles[id]))
        }));
      }

      // A directly selected read-only preset and a delegated read-only child
      // must both be restricted at the Agent scope: preset-local fs
      // registrations cannot be filtered within their own layer. Delegation
      // children share their parent's composition, so their role comes from
      // the admitted invocation identity, not from composedPreset.
      const roleOf = (agent: NativeAgent): string | undefined => roleIdentity?.(agent) ?? registry.composedPreset(agent.ctx);
      const agents = readyCtx.get?.<NativeAgentRegistry>("agents")
        ?? (readyCtx as DshContext & { agents?: NativeAgentRegistry }).agents;
      if (agents === undefined) throw new Error("dsmm native preset restriction requires DSH Agent registry");
      const states = new WeakMap<NativeAgent, { role: string | undefined; disposeRestriction?: () => void; pending?: boolean }>();
      const restrictedAgents = new Set<NativeAgent>();
      const denial = (agent: NativeAgent, name: string): string | undefined => {
        const role = roleOf(agent);
        if (!isReadonlyRole(role)) return undefined;
        const target = roleFromToolName(name);
        return target === undefined ? readonlyRoleTool(name, settings) ? undefined : "dsmm read-only role does not permit this tool"
          : allowedRoleChildren(role).includes(target) && settings.roles[target] ? undefined : "dsmm read-only role does not permit this delegation";
      };
      const reconcile = (agent: NativeAgent): void => {
        const identityRole = roleIdentity?.(agent);
        // A delegation child's identity is bound by native admission's created
        // guard, which may still be in flight during this synchronous
        // reconcile. A parented agent with no bound identity stays pending
        // instead of concluding "not read-only" from a not-yet-bound role.
        const agentId = agent.id;
        const parented = agentId !== undefined && agents.list().some(other => other !== agent && agents.isOwnedBy(agentId, other));
        const pendingIdentity = roleIdentity !== undefined && identityRole === undefined && parented;
        const selected = pendingIdentity ? undefined : identityRole ?? registry.composedPreset(agent.ctx);
        const previous = states.get(agent);
        if (previous !== undefined && previous.role === selected && (previous.pending || !isReadonlyRole(selected) || previous.disposeRestriction !== undefined)) return;
        states.set(agent, { role: selected, pending: pendingIdentity || undefined });
        previous?.disposeRestriction?.();
        restrictedAgents.delete(agent);
        if (pendingIdentity) return;
        if (!isReadonlyRole(selected)) {
          states.set(agent, { role: selected });
          return;
        }
        const raw = registry.serviceFor?.(agent, "tools");
        // Cordis throws on an uninjected direct property read. Prefer the
        // selected preset's raw service and trace it into this Agent scope;
        // an unrelated Host tools service may coexist in another realm.
        const tools = raw !== undefined ? getTraceable(agent.ctx as Context, raw)
          : agent.ctx.get?.<NativeScopedTools>("tools")
            ?? (agent.ctx.get === undefined ? agent.ctx.tools : undefined);
        try {
          if (tools?.restrict === undefined) throw new Error(`dsmm read-only role requires DSH tools restrict: ${selected}`);
          restrictedAgents.add(agent);
          // A delegation child shares its parent's standing composition realm,
          // where a realm-level restriction would also mask the writable
          // parent. Such children are fenced per-Agent through the runtime
          // denial above instead; schema masking applies only to a directly
          // selected read-only composition with its own realm.
          const inheritedScope = scopeParentOf(agent);
          const sharedRealmChild = roleIdentity !== undefined && roleIdentity(agent) === selected;
          const maskable = READONLY_ROLE_DENIED_TOOLS.filter(name => tools.get(name, inheritedScope) !== undefined);
          const disposeRestriction = sharedRealmChild || maskable.length === 0 ? () => {} : tools.restrict({ deny: maskable });
          states.set(agent, { role: selected, disposeRestriction });
        } catch (error) {
          states.set(agent, { role: selected });
          restrictedAgents.delete(agent);
          throw error;
        }
      };
      const onPreExecute = readyCtx.on?.("tools/pre-execute", async (execution: Readonly<ToolExecution>, next: () => Promise<PreToolDecision>) => {
        const agent = execution.agent;
        if (agent === undefined || agents.get(agent.id) !== agent) return next();
        const full = NativeContext.is(readyCtx) && nativeStandingFullAccess(readyCtx, agent);
        if (full && !(READONLY_ROLE_DENIED_TOOLS as readonly string[]).includes(execution.name)) return next();
        const reason = denial(agent, execution.name);
        return reason === undefined ? next() : { kind: "deny", reason };
      }, { global: true, prepend: true });
      const onCreated = readyCtx.on?.("agent/created", ({ agent }: { agent: NativeAgent }) => reconcile(agent), { global: true });
      const onToolChange = readyCtx.on?.("tools/change", () => {
        for (const agent of agents.list()) reconcile(agent);
      }, { global: true });
      const onSelection = readyCtx.on?.("agent-preset/selected", (sessionId: string) => {
        const agent = agents.get(sessionId);
        if (agent !== undefined) reconcile(agent);
      }, { global: true });
      const onDisposed = readyCtx.on?.("agent/disposed", ({ agent }: { agent: NativeAgent }) => {
        states.get(agent)?.disposeRestriction?.();
        states.delete(agent);
        restrictedAgents.delete(agent);
      }, { global: true });

      readyCtx.effect?.(() => () => {
        if (typeof onCreated === "function") onCreated();
        if (typeof onPreExecute === "function") onPreExecute();
        if (typeof onToolChange === "function") onToolChange();
        if (typeof onSelection === "function") onSelection();
        if (typeof onDisposed === "function") onDisposed();
        for (const agent of restrictedAgents) {
          states.get(agent)?.disposeRestriction?.();
        }
        restrictedAgents.clear();
        for (const dispose of disposers.reverse()) void dispose();
      });
    } catch (error) {
      for (const dispose of disposers.reverse()) await dispose();
      throw error;
    }
  };

  if (ctx.inject !== undefined) {
    if (ctx.get?.("agentPresets") !== undefined) return install(ctx);
    return Promise.resolve(ctx.inject(["agentPresets"], install)).then(() => undefined);
  } else if (ctx.get?.("agentPresets") !== undefined || (ctx as DshContext & { agentPresets?: NativePresetRegistry }).agentPresets !== undefined) {
    void install(ctx).catch((error: unknown) => ctx.logger?.warn(`dsmm native preset registration failed: ${String(error)}`));
  }
}

function isReadonlyRole(id: string | undefined): id is DsmmRoleId {
  return DSMM_ROLES.some((role) => role.id === id && role.access === "read-only");
}
