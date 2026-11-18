import { getTraceable, symbols } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SubagentError } from "@deepseek-ai/dsh-subagent";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { scopeLifetime } from "./lifetime.js";
import type { NativeAdmission } from "./native-admission.js";
import { scopeOf, scopeParentOf } from "./native-scope.js";

interface ResidentBinding {
  readonly version: 1;
  readonly root: boolean;
  readonly registry: object;
  readonly sessions: object;
  readonly session: Agent["session"];
  readonly presets?: object;
  readonly profile?: object;
  deploymentKey?: string;
  loaderEntry?: { readonly name: string; readonly profileDir: string } | null;
  readonly home?: string;
  preset?: string;
  scopeParent?: object;
  owner?: NativeAdmission;
  published: boolean;
  active: boolean;
  disposed: boolean;
  readonly tools: WeakSet<object>;
  readonly tokens: Set<ToolExecution["token"]>;
  afterDrain?: () => void;
  detachOwner?: () => void;
}

// Reloaded ESM graphs share only exact resident objects, never session-id authority.
const key = Symbol.for("@dsmm/dsmm/resident-roots");
const records: WeakMap<Agent, ResidentBinding> = Reflect.get(globalThis, key) ?? new WeakMap();
if (!Reflect.has(globalThis, key)) Object.defineProperty(globalThis, key, { value: records });
const original = (value: object | undefined): object | undefined => value && (Reflect.get(value, symbols.original) ?? value);
const deny = (): never => { throw new SubagentError("Resident root has no current DSMM admission", "UNAUTHORIZED"); };

function current(record: ResidentBinding): NativeAdmission {
  if (record.version !== 1 || !record.active || !record.owner?.isReady) return deny();
  return record.owner;
}

export function assertResidentRootCurrent(agent: Agent, owner: NativeAdmission | undefined): void {
  const record = records.get(agent);
  if (record && original(current(record)) !== original(owner)) deny();
}

function claim(record: ResidentBinding, owner: NativeAdmission): void {
  record.owner = owner;
  const revoke = () => {
    if (record.owner !== owner) return;
    record.active = false;
    record.owner = undefined;
    record.afterDrain = undefined;
    record.detachOwner = undefined;
  };
  owner.lifetime.signal.addEventListener("abort", revoke, { once: true });
  record.detachOwner = () => owner.lifetime.signal.removeEventListener("abort", revoke);
}

export function markResidentAgent(agent: Agent, owner: NativeAdmission, root: boolean, publication?: Promise<void>): void {
  if (records.has(agent)) deny();
  const deployment = owner.ctx.get("dsmmDeploymentConfig");
  const record: ResidentBinding = { version: 1, root, registry: original(owner.ctx.agents)!, sessions: original(owner.ctx.get("sessions"))!,
    deploymentKey: deployment?.hostProfileKey, home: deployment?.home,
    session: agent.session, presets: original(agent.ctx.get("agentPresets")), profile: original(owner.ctx.get("profileContext")),
    active: false, published: false, disposed: false,
    tools: new WeakSet(), tokens: new Set() };
  records.set(agent, record);
  scopeLifetime(agent.ctx, "dsmm: revoke resident root", () => {
    record.detachOwner?.(); record.detachOwner = undefined;
    record.active = false; record.disposed = true; record.owner = undefined; record.afterDrain = undefined;
  });
  agent.ctx.on("agent/pre-step", async (frame, next) => {
    if (frame.agent === agent) {
      if (!record.published && publication) await publication;
      await current(record).ensure(agent);
    }
    return next();
  }, { prepend: true });
  agent.ctx.on("agent/request", async (frame, next) => {
    if (frame.agent === agent) {
      if (!record.published && publication) await publication;
      await current(record).ensure(agent);
    }
    return next();
  }, { prepend: true });
  agent.ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.agent === agent) {
      if (!record.published && publication) await publication;
      const owner = current(record);
      record.tokens.add(exec.token);
      await owner.ensure(agent);
    }
    return next();
  }, { prepend: true });
  agent.ctx.on("tools/execute", async (exec, next) => {
    if (exec.agent === agent) { current(record).assert(agent); if (!record.tokens.has(exec.token)) deny(); }
    return next();
  }, { prepend: true });
  agent.ctx.on("tools/result", exec => {
    if (exec.agent === agent && record.tokens.delete(exec.token) && !record.tokens.size) record.afterDrain?.();
  });
  claim(record, owner);
  guardResidentRealm(agent);
}

export function captureResidentTool(agent: Agent, owner: NativeAdmission, token: ToolExecution["token"]): void {
  const record = records.get(agent);
  if (!record) return;
  assertResidentRootCurrent(agent, owner);
  record.tokens.add(token);
}

export function guardResidentRealm(agent: Agent): void {
  const record = records.get(agent);
  const tools = agent.ctx.get("agentPresets")?.serviceFor(agent, "tools") ?? agent.ctx.get("tools");
  if (!record || !tools) return;
  const realm = original(tools)!;
  if (record.tools.has(realm)) return;
  getTraceable(agent.ctx, tools).guard(exec => {
    if (exec.agent !== agent) return;
    current(record).assert(agent);
    if (!record.tokens.has(exec.token) || realm !== original(agent.ctx.get("agentPresets")?.serviceFor(agent, "tools") ?? agent.ctx.get("tools"))) deny();
  });
  record.tools.add(realm);
}

function loaderEntry(owner: NativeAdmission): ResidentBinding["loaderEntry"] {
  const entry = owner.ctx.fiber.entry, profileDir = owner.ctx.get("profileContext")?.dir;
  return entry && profileDir ? { name: entry.options.name, profileDir } : null;
}

function sameDeployment(record: ResidentBinding, owner: NativeAdmission): boolean {
  const deployment = owner.ctx.get("dsmmDeploymentConfig");
  if (!deployment || record.home !== deployment.home) return false;
  const entry = loaderEntry(owner);
  if (record.loaderEntry && entry) {
    // Reinstalling a plugin mints a new Loader entry ID within the same physical profile.
    return record.loaderEntry.name === entry.name && record.loaderEntry.profileDir === entry.profileDir;
  }
  if (record.loaderEntry === undefined && record.profile && entry) return true;
  return record.deploymentKey === deployment.hostProfileKey && (record.loaderEntry === undefined || record.loaderEntry === entry);
}

export function publishResidentAgent(agent: Agent, owner: NativeAdmission): void {
  const record = records.get(agent)!;
  if (record.disposed || original(record.owner) !== original(owner) || !owner.isReady) deny();
  record.loaderEntry = loaderEntry(owner);
  record.deploymentKey = owner.ctx.get("dsmmDeploymentConfig")?.hostProfileKey;
  record.scopeParent = scopeParentOf(agent);
  record.preset = agent.ctx.get("agentPresets")?.composedPreset(agent.ctx);
  record.published = record.active = true;
}

export function restoreResidentRoot(agent: Agent, owner: NativeAdmission, install: (signal: AbortSignal) => Promise<void>): Promise<void> | undefined {
  const record = records.get(agent);
  if (!record || record.version !== 1 || !record.root || record.disposed || !record.published || record.owner) return;
  const valid = () => record.profile === original(owner.ctx.get("profileContext")) && record.registry === original(owner.ctx.agents) && record.registry === original(agent.ctx.get("agents"))
    && sameDeployment(record, owner)
    && record.sessions === original(owner.ctx.get("sessions")) && record.session === agent.session && owner.ctx.get("sessions")?.get(agent.id) === record.session
    && record.presets === original(agent.ctx.get("agentPresets")) && record.preset === agent.ctx.get("agentPresets")?.composedPreset(agent.ctx)
    && record.scopeParent === scopeParentOf(agent) && scopeOf(agent.ctx) === agent && owner.ctx.agents.get(agent.id) === agent;
  if (!valid()) deny();
  claim(record, owner);
  const admit = (signal: AbortSignal) => {
    if (record.owner !== owner || !owner.isReady || !valid()) deny();
    return install(signal);
  };
  const report = (error: unknown) => { if (!owner.lifetime.signal.aborted) owner.ctx.logger.warn("Resident root %s remains revoked: %s", agent.id, error); };
  const start = (): Promise<void> | undefined => {
    record.afterDrain = undefined;
    if (record.disposed || record.owner !== owner) return;
    // Ordinary tool calls can outlive both the turn and the retiring plugin.
    // A busy Agent/maintenance task also has to converge before taking its place.
    try { return agent.runMaintenance(admit); }
    catch {
      void agent.whenIdle().then(() => {
        if (!record.disposed && record.owner === owner) return agent.runMaintenance(admit);
      }).catch(report);
    }
  };
  if (!record.tokens.size) return start();
  record.afterDrain = () => { void start()?.catch(report); };
}
