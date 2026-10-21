import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { scopeLifetime } from "./lifetime.js";
import type { DshAgent } from "./dsh-types.js";
import { PermissionRefusal, permissionOriginal } from "./permission-control.js";
import type { PermissionControlCollaborators, PermissionExecutionAuthority } from "./permission-control.js";
import type { DsmmRolePolicy } from "./role-policy.js";
import { DSMM_DISPATCHER_ROLE, DSMM_ROLES, isRootRole } from "./roles.js";
import type { NativeAdmission } from "./native-admission.js";
import { capturedRoleInvocation } from "./role-invocation.js";
import type { DsmmProfileAdmission, DsmmSettingsGetter } from "./settings.js";

export interface CorePermissionAuthorityOptions {
  readonly getSettings: DsmmSettingsGetter;
  readonly rolePolicy: DsmmRolePolicy;
  /** Borrowed actual Core lifetime, in addition to the calling fiber's lifetime. */
  readonly signal: AbortSignal;
}

export interface CorePermissionAuthority {
  readonly authority: PermissionControlCollaborators;
  assertWritable(root: Agent): void;
}

/** Public SandboxPolicyService.resolve projection; no dependency on a concrete provider. */
interface NativeSandboxPolicy {
  resolve(request?: { session?: Agent["session"] }): {
    mode: "read-only" | "workspace-write" | "danger-full-access";
    workspaceRoot: string;
    sessionId?: Agent["id"];
  };
}

interface Generation {
  readonly native: boolean;
  readonly controlled: boolean;
  readonly integration?: object;
  readonly admission?: DsmmProfileAdmission;
  readonly facts: readonly unknown[];
  readonly authority: PermissionExecutionAuthority;
  revoke(): void;
}

function sameFacts(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Live Core admissions and native realm facts; the calling fiber owns every observer. */
export function createCorePermissionAuthority(ctx: Context, options: CorePermissionAuthorityOptions): CorePermissionAuthority {
  const { getSettings, rolePolicy } = options;
  const coreOwner = ctx.fiber.ctx;
  const lifetime = new AbortController();
  const lifetimeSignal = AbortSignal.any([lifetime.signal, options.signal]);
  const generations = new Map<Agent, Generation>();
  const physicalLifetimes = new WeakMap<Agent, AbortSignal>();
  const revokeAll = (): void => { for (const generation of [...generations.values()]) generation.revoke(); };
  scopeLifetime(ctx, "dsmm.permissionAuthority: release live generations", () => { lifetime.abort(); revokeAll(); });
  ctx.on("agent/disposed", ({ agent }) => generations.get(agent)?.revoke(), { global: true, prepend: true });

  const integration = (): NativeAdmission | undefined => {
    if (lifetimeSignal.aborted) throw new PermissionRefusal("cancelled");
    return ctx.get("dsmmNativeAdmission");
  };

  /** Registry ownership is direct, so each physical edge must be walked independently. */
  const ancestry = (exec: Readonly<ToolExecution>): Agent[] => {
    const agents = ctx.get("agents"), agent = exec.agent;
    const realmAgents = agent?.ctx.get("agents");
    if (agents === undefined || agent === undefined || agents.get(agent.id) !== agent
      || realmAgents === undefined || permissionOriginal(realmAgents) !== permissionOriginal(agents)) throw new PermissionRefusal("not-owned");
    const chain: Agent[] = [], seen = new Set<Agent>(), residents = agents.list();
    let current = agent;
    while (true) {
      if (seen.has(current) || agents.get(current.id) !== current) throw new PermissionRefusal("not-owned");
      seen.add(current); chain.push(current);
      const owners = residents.filter(candidate => candidate !== current && agents.isOwnedBy(current.id, candidate));
      if (owners.length === 0) {
        if (!agents.roots().includes(current) || current.session.header.origin === "subagent") throw new PermissionRefusal("not-owned");
        return chain;
      }
      if (owners.length !== 1 || current.session.header.parentSession !== owners[0].id) throw new PermissionRefusal("not-owned");
      current = owners[0];
    }
  };

  const coreDomain = (agent: Agent) => {
    const core = ctx.get("dsmmCoreLlmOwner"), profiles = ctx.get("dsmmProfileRuntime");
    const ownerCore = coreOwner.get("dsmmCoreLlmOwner"), realmCore = agent.ctx.get("dsmmCoreLlmOwner");
    if (core === undefined || ownerCore === undefined || realmCore === undefined || profiles === undefined
      || permissionOriginal(core) !== permissionOriginal(ownerCore) || permissionOriginal(core) !== permissionOriginal(realmCore)) throw new PermissionRefusal("unavailable");
    return profiles;
  };

  const coreAdmission = (agent: Agent): DsmmProfileAdmission => {
    const profiles = coreDomain(agent), structural = agent as unknown as DshAgent, admission = getSettings.admission?.(structural);
    if (admission === undefined || profiles.admission(structural) !== admission || getSettings(structural) !== admission.settings) throw new PermissionRefusal("stale");
    return admission;
  };

  const local = (host: NativeAdmission | undefined, agent: Agent, root: Agent, parent?: Generation): Generation => {
    const previous = generations.get(agent);
    try {
      const structural = agent as unknown as DshAgent;
      const profiles = coreDomain(agent);
      const captured = host?.owns(agent) === true || capturedRoleInvocation(structural) !== undefined;
      const native = !captured && !profiles.hasAdmission(structural);
      if (native && parent?.controlled) throw new PermissionRefusal("not-owned");
      if (captured) {
        if (host === undefined) throw new PermissionRefusal("unavailable");
        host.assert(agent);
      }
      if (!native) rolePolicy.assertModuleAdmission(structural);
      // Unadmitted native calls retain physical authority, never DSMM role rights.
      const admission = native ? parent?.admission : coreAdmission(agent);
      const identity = native ? undefined : rolePolicy.identity(structural);
      const tools = agent.ctx.get("tools"), approval = agent.ctx.get("approval");
      if (tools === undefined || !native && (identity?.epoch !== admission!.epoch
        || (parent === undefined ? agent !== root || identity.child : identity.parent !== parent.authority.agent || !identity.child))) throw new PermissionRefusal("not-owned");
      const nativePolicy = approval === undefined ? undefined : approval.overrideOf(agent.session) ?? approval.config.policy;
      if (approval !== undefined && nativePolicy !== "ask" && nativePolicy !== "never") throw new PermissionRefusal("unavailable");
      const managed = parent !== undefined && identity?.role !== undefined;
      if (managed && host === undefined) throw new PermissionRefusal("unavailable");
      const entry = managed ? permissionOriginal(host!) : undefined;
      const owner = managed ? host! : coreOwner;
      const facts = [root, agent.ctx, parent?.authority.signal, permissionOriginal(ctx.get("dsmmCoreLlmOwner")!),
        permissionOriginal(ctx.get("dsmmProfileRuntime")!), permissionOriginal(tools),
        approval === undefined ? undefined : permissionOriginal(approval),
        admission?.settings, native, captured, identity?.role, identity?.child, identity?.parent, identity?.epoch, identity?.readOnly,
        JSON.stringify(identity?.toolFilter)];
      if (previous !== undefined && !previous.authority.signal.aborted && previous.integration === entry
        && previous.authority.owner === owner && previous.admission === admission && sameFacts(previous.facts, facts)) {
        if (managed) host!.assert(agent);
        return previous;
      }
      previous?.revoke();
      if (managed && host!.assert(agent) !== admission) throw new PermissionRefusal("not-owned");
      const revision = admission?.epoch ?? randomUUID();
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, lifetimeSignal, ...parent === undefined ? [] : [parent.authority.signal]]);
      const detach: Array<() => void> = [];
      let revoked = false;
      const generation: Generation = { native, controlled: managed || identity?.role !== undefined, integration: entry, admission, facts,
        authority: Object.freeze({ agent, root, realm: agent.ctx, owner, ownerGeneration: revision,
          admissionRevision: revision, permissionRevision: randomUUID(), signal }),
        revoke() {
          if (revoked) return;
          revoked = true; controller.abort();
          if (generations.get(agent) === generation) generations.delete(agent);
          for (const dispose of detach) dispose();
        } };
      generations.set(agent, generation);
      const revoke = () => generation.revoke();
      signal.addEventListener("abort", revoke, { once: true });
      detach.push(() => signal.removeEventListener("abort", revoke));
      try {
        detach.push(scopeLifetime(agent.ctx, "dsmm.permissionAuthority: exact Agent realm lifetime", revoke));
        if (signal.aborted) throw new PermissionRefusal("cancelled");
        return generation;
      } catch (error) { generation.revoke(); throw error; }
    } catch (error) { previous?.revoke(); throw error; }
  };

  const current: PermissionControlCollaborators["current"] = exec => {
    const host = integration(), chain = ancestry(exec), root = chain.at(-1)!;
    let parent: Generation | undefined, generation!: Generation;
    for (const agent of [...chain].reverse()) { generation = local(host, agent, root, parent); if (agent !== exec.agent) parent = generation; }
    return generation.authority;
  };

  const authority: PermissionControlCollaborators = {
    current,
    captureIntegrity(exec) {
      const chain = ancestry(exec), realms = chain.map(agent => agent.ctx);
      const signals = chain.map(agent => {
        let signal = physicalLifetimes.get(agent);
        if (signal === undefined) {
          const controller = new AbortController(); signal = controller.signal;
          physicalLifetimes.set(agent, signal);
          scopeLifetime(agent.ctx, "dsmm.permissionIntegrity: physical Agent lifetime", () => controller.abort());
        }
        return signal;
      });
      const signal = AbortSignal.any([lifetimeSignal, ...signals]);
      return { signal, assertCurrent() {
        if (exec.signal.aborted || signal.aborted) throw new PermissionRefusal("cancelled");
        const live = ancestry(exec);
        if (live.length !== chain.length || live.some((agent, index) => agent !== chain[index] || agent.ctx !== realms[index])) throw new PermissionRefusal("not-owned");
      } };
    },
    rootCurrent(root, exec) {
      const host = integration(), chain = ancestry(exec);
      const agents = ctx.get("agents");
      if (chain.at(-1) !== root || agents?.get(root.id) !== root || !agents.roots().includes(root)) throw new PermissionRefusal("not-owned");
      const generation = local(host, root, root);
      if (root.ctx.get("approval") === undefined) throw new PermissionRefusal("unavailable");
      return generation.authority;
    },
    assertCurrent(authority, exec) {
      if (exec.signal.aborted || authority.signal.aborted) throw new PermissionRefusal("cancelled");
      const live = current(exec);
      if (authority.agent !== live.agent || authority.root !== live.root || authority.realm !== live.realm || authority.owner !== live.owner
        || authority.ownerGeneration !== live.ownerGeneration || authority.admissionRevision !== live.admissionRevision
        || authority.permissionRevision !== live.permissionRevision || authority.signal !== live.signal) throw new PermissionRefusal("stale");
      const tools = live.agent.ctx.get("tools");
      if (tools?.get(exec.name, live.agent) === undefined
        || !generations.get(live.agent)?.native && rolePolicy.toolDenial(live.agent as unknown as DshAgent, exec.name, tools, exec) !== undefined) throw new PermissionRefusal("denied");
    },
  };
  return { authority,
    assertWritable(root) {
      if (lifetimeSignal.aborted) throw new PermissionRefusal("cancelled");
      const agents = ctx.get("agents"), realmAgents = root.ctx.get("agents");
      if (agents === undefined || realmAgents === undefined || permissionOriginal(agents) !== permissionOriginal(realmAgents)
        || agents.get(root.id) !== root || root.session.id !== root.id || !agents.roots().includes(root)
        || root.session.header.origin === "subagent" || agents.list().some(agent => agent !== root && agents.isOwnedBy(root.id, agent))) throw new PermissionRefusal("not-owned");
      const seen = new Set<Context>();
      for (let fiber = root.ctx.fiber; !seen.has(fiber.ctx); fiber = fiber.parent.fiber) {
        if (fiber.uid === null || fiber.state === 4 || fiber.state === 5) throw new PermissionRefusal("cancelled");
        seen.add(fiber.ctx);
      }
      const structural = root as unknown as DshAgent, profiles = coreDomain(root), host = integration();
      const captured = host?.owns(root) === true || capturedRoleInvocation(structural) !== undefined;
      const native = !captured && !profiles.hasAdmission(structural);
      if (native) {
        const preset = root.ctx.get("agentPresets")?.composedPreset(root.ctx);
        if (preset?.startsWith("dsmm-")) {
          const definition = DSMM_ROLES.find(role => role.id === preset);
          if (preset !== DSMM_DISPATCHER_ROLE || definition === undefined || !isRootRole(definition) || definition.access !== "write") throw new PermissionRefusal("denied");
        }
      }
      if (captured) {
        if (host === undefined) throw new PermissionRefusal("unavailable");
        host.assert(root);
      }
      if (!native) {
        const admission = coreAdmission(root);
        rolePolicy.assertModuleAdmission(structural);
        const identity = rolePolicy.identity(structural);
        if (identity.child || identity.parent !== undefined || identity.epoch !== admission.epoch) throw new PermissionRefusal("not-owned");
        if (identity.readOnly === true || DSMM_ROLES.find(role => role.id === identity.role)?.access === "read-only") throw new PermissionRefusal("denied");
      }
      const sandbox = root.ctx.get("sandboxPolicy") as NativeSandboxPolicy | undefined;
      if (sandbox === undefined) throw new PermissionRefusal("unavailable");
      const policy = sandbox.resolve({ session: root.session });
      if (policy.mode === "read-only") throw new PermissionRefusal("denied");
      if (policy.mode !== "workspace-write" && policy.mode !== "danger-full-access") throw new PermissionRefusal("unavailable");
    },
  };
}
