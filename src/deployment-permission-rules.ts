import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-settings";
import { PermissionRefusal, permissionOriginal } from "./permission-control.js";
import { applyPermissionRulesSave, importPermissionRules, operatorPermissionRulesSource, parsePermissionRules, parsePermissionRulesSave, PermissionRulesRuntimeSync } from "./permission-rules.js";
import type { PermissionRulesBackend, PermissionRulesSaveAuthority, PermissionRulesSaveRequest, PermissionRuleSnapshot, PermissionRulesStatus, PermissionRulesUpdate } from "./permission-rules.js";
import { copyJson, validateSparseConfig, validateNativeConfig } from "./settings.js";
import type { DsmmPluginConfig } from "./settings.js";
import type { DsmmDeploymentConfig, GlobalConfigSaveRequest } from "./deployment-config.js";
import { parseHostNativeCommands } from "./permission-native-command.js";

type NativeEntry = ReturnType<Context["loader"]["resolve"]>;
/** Structural projection of the SDK's public ConfigEditor.edit; the façade retains all other members. */
export interface PermissionConfigEditor {
  edit(entry: NativeEntry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>;
}
type NativeEdit = PermissionConfigEditor["edit"];
const entries = new WeakMap<object, DeploymentPermissionRules>();
const claimed = new WeakSet<object>();
const homes = new Map<string, Set<DeploymentPermissionRules>>();

export interface DeploymentPermissionRulesOptions {
  readonly deployment: Pick<DsmmDeploymentConfig, "nativeEntry" | "home" | "coordinateWrites" | "permissionSource" | "saveGlobal">;
  /** Core readonly/effective-policy check; must not require idle or DW delivery readiness. */
  readonly assertWritable: (root: Agent) => void;
  /** Synchronous revocation of every pending/grant consumer in this owner. */
  readonly revoke: () => void;
  readonly notify: (snapshot: PermissionRuleSnapshot) => Promise<void>;
}

function imported(config: DsmmPluginConfig, label: string, global: boolean): DsmmPluginConfig {
  if (config.permissionControl?.rules === undefined) return config;
  const rules = parsePermissionRules(config.permissionControl.rules).map(rule => ({
    ...importPermissionRules([{ id: rule.id, action: rule.action, match: rule.match }], label, rule.revision)[0]!, revoked: rule.revoked
  }));
  return validateSparseConfig({ ...config, permissionControl: { ...config.permissionControl, rules } }, global);
}

/** Source checks complement in-process generation revocation; a serialized token is never authority. */
class SourceBoundRulesRuntime extends PermissionRulesRuntimeSync {
  private projection?: { snapshot: PermissionRuleSnapshot; value: PermissionRuleSnapshot };
  constructor(initial: PermissionRuleSnapshot, revoke: () => void, private readonly source: () => PermissionRuleSnapshot,
    private readonly refreshSource: () => Promise<void>) { super(initial, revoke); }
  override async refresh(): Promise<PermissionRuleSnapshot> { await this.refreshSource(); return this.getPolicy(); }
  override status(): PermissionRulesStatus {
    const current = super.status();
    let source: PermissionRuleSnapshot;
    try { source = this.source(); }
    catch {
      if (current.state === "synced") this.invalidate();
      return Object.freeze({ ...super.status(), state: "unsynced" });
    }
    if (current.state === "synced" && current.savedRevision !== source.revision) this.invalidate();
    return Object.freeze({ ...super.status(), savedRevision: source.revision, restartRequired: source.policy.enabled !== current.mounted });
  }
  override getPolicy(): PermissionRuleSnapshot {
    const policy = super.getPolicy();
    try { if (this.source().revision !== policy.revision) throw new PermissionRefusal("stale"); }
    catch (error) { this.invalidate(); throw error; }
    if (this.projection?.snapshot !== policy) this.projection = { snapshot: policy,
      value: Object.freeze({ revision: policy.revision, policy: Object.freeze({ ...policy.policy, enabled: super.status().mounted }) }) };
    return this.projection.value;
  }
}

/** Canonical Rules RPC writes the global layer; native overrides remain independently owned. */
export class DeploymentPermissionRules implements PermissionRulesBackend {
  readonly runtime: PermissionRulesRuntimeSync;
  readonly initial: PermissionRuleSnapshot;
  private readonly lifetime = new AbortController();
  private readonly operatorWrites = new WeakMap<GlobalConfigSaveRequest, PermissionRulesSaveAuthority>();
  private readonly nativeFiber: Context["fiber"] | undefined;
  private readonly registry: object;
  private busy = false;
  private refreshing?: Promise<void>;
  constructor(private readonly ctx: Context, private readonly options: DeploymentPermissionRulesOptions) {
    this.nativeFiber = options.deployment.nativeEntry?.fiber;
    this.registry = permissionOriginal(ctx.agents);
    this.initial = this.snapshot();
    this.runtime = new SourceBoundRulesRuntime(this.initial, options.revoke, () => this.snapshot(), () => this.refresh());
    const deployment = options.deployment, entry = deployment.nativeEntry;
    if (entry !== undefined) {
      if (entry.fiber?.ctx.root !== ctx.root) throw new PermissionRefusal("not-owned");
      if (entries.has(entry)) throw new PermissionRefusal("unavailable");
    }
    const homeKey = process.platform === "win32" ? deployment.home.toLowerCase() : deployment.home;
    const family = homes.get(homeKey) ?? new Set<DeploymentPermissionRules>();
    if ([...family].some(owner => owner.busy || owner.runtime.status().state === "updating")) throw new PermissionRefusal("unavailable");
    const remove = deployment.coordinateWrites({ global: async (request, config, assertAuthority, write) => {
      const operator = this.operatorWrites.get(request);
      const rulesInput = request.edits.some(edit => edit.path[0] === "permissionControl" && (edit.path.length === 1 || edit.path[1] === "rules"));
      const candidate = operator !== undefined || !rulesInput ? config : imported(config, "global-settings", true);
      return this.transaction([...family], async () => { assertAuthority(); return write(candidate); });
    } });
    if (entry !== undefined) { entries.set(entry, this); claimed.add(entry); }
    family.add(this); homes.set(homeKey, family);
    ctx.effect(() => () => {
      this.lifetime.abort(); remove(); family.delete(this);
      if (family.size === 0) homes.delete(homeKey);
      if (entry !== undefined) entries.delete(entry);
      this.runtime.retire();
    });
  }
  private snapshot(): PermissionRuleSnapshot {
    this.lifetime.signal.throwIfAborted();
    if (this.options.deployment.nativeEntry?.fiber !== this.nativeFiber) throw new PermissionRefusal("unavailable");
    const source = this.options.deployment.permissionSource();
    return Object.freeze({ revision: source.revision, policy: source.policy });
  }
  assertWritable(root: Agent): void {
    this.lifetime.signal.throwIfAborted();
    const registry = this.ctx.agents;
    if (permissionOriginal(registry) !== this.registry || registry.get(root.id) !== root || root.session.id !== root.id || root.session.header.origin === "subagent"
      || !registry.roots().includes(root) || registry.list().some(owner => owner !== root && registry.isOwnedBy(root.id, owner))) throw new PermissionRefusal("not-owned");
    this.options.assertWritable(root);
  }
  private check(authority: PermissionRulesSaveAuthority): void {
    authority.signal.throwIfAborted(); authority.assertCurrent(); this.assertWritable(authority.root);
  }
  async read(authority: PermissionRulesSaveAuthority): Promise<PermissionRuleSnapshot> {
    this.check(authority);
    await this.refresh(); this.check(authority);
    const snapshot = this.snapshot();
    if (this.runtime.status().state === "synced" && this.runtime.status().savedRevision !== snapshot.revision) this.runtime.invalidate();
    this.check(authority); return snapshot;
  }
  async save(request: PermissionRulesSaveRequest, authority: PermissionRulesSaveAuthority) {
    this.check(authority);
    request = parsePermissionRulesSave(request);
    const source = this.options.deployment.permissionSource();
    if (request.expectedRevision !== source.revision) throw new PermissionRefusal("stale");
    if (Object.keys(source.profile.permissionControl ?? {}).some(key => key !== "enabled")) {
      const error = new PermissionRefusal("unavailable");
      error.message = "Native profile overrides the global permission policy; edit or unset that native override first.";
      throw error;
    }
    const proposed = applyPermissionRulesSave({ revision: source.revision, policy: source.policy }, request, operatorPermissionRulesSource(authority));
    const edits: GlobalConfigSaveRequest["edits"] = Object.entries(request.changes ?? {}).map(([key, value]) => ({ op: "set", path: ["permissionControl", key], value }));
    if (request.upsert !== undefined || request.revoke !== undefined) edits.push({ op: "set", path: ["permissionControl", "rules"], value: proposed.rules });
    const write = { expectedRevision: source.globalRevision, edits };
    this.operatorWrites.set(write, authority);
    try {
      await this.options.deployment.saveGlobal(write, () => {
        this.check(authority);
        const current = this.options.deployment.permissionSource();
        if (current.revision !== source.revision) throw new PermissionRefusal("stale");
      });
      this.check(authority);
      return { snapshot: this.snapshot(), runtime: this.runtime.status() };
    } finally { this.operatorWrites.delete(write); }
  }
  private readonly notify = async (snapshot: PermissionRuleSnapshot): Promise<void> => {
    this.lifetime.signal.throwIfAborted();
    await this.options.notify(snapshot);
    this.lifetime.signal.throwIfAborted();
    if (this.snapshot().revision !== snapshot.revision) throw new PermissionRefusal("stale");
  };
  /** Host recovery re-reads storage and never revives a former signal or grant. */
  async reconcile(): Promise<void> {
    if (this.busy) throw new PermissionRefusal("stale");
    if (this.runtime.status().state === "synced") this.runtime.invalidate();
    await this.runtime.recover(undefined, this.snapshot(), this.notify);
  }
  /** Next actual consumption observes disk/native edits without requiring a UI save. */
  private async refresh(): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    if (this.refreshing !== undefined) return this.refreshing;
    if (this.runtime.status().state === "synced") return;
    if (this.busy) throw new PermissionRefusal("unavailable");
    const refreshing = this.reconcile(); this.refreshing = refreshing;
    try { await refreshing; this.lifetime.signal.throwIfAborted(); }
    finally { if (this.refreshing === refreshing) this.refreshing = undefined; }
  }
  private async synchronize(updates: ReadonlyMap<DeploymentPermissionRules, PermissionRulesUpdate>, recovery: boolean): Promise<void> {
    let rows: { owner: DeploymentPermissionRules; update: PermissionRulesUpdate; snapshot: PermissionRuleSnapshot }[];
    try { rows = [...updates].map(([owner, update]) => ({ owner, update, snapshot: owner.snapshot() })); }
    catch (error) { for (const owner of updates.keys()) owner.runtime.invalidate(); throw error; }
    const acknowledged = Promise.all(rows.map(row => row.owner.notify(row.snapshot))).then(() => {
      for (const row of rows) if (row.owner.snapshot().revision !== row.snapshot.revision) throw new PermissionRefusal("stale");
    });
    const settled = await Promise.allSettled([acknowledged, ...rows.map(({ owner, update, snapshot }) => recovery
      ? owner.runtime.recover(update, snapshot, () => acknowledged) : owner.runtime.commit(update, snapshot, () => acknowledged))]);
    const failures = [...new Set(settled.flatMap(result => result.status === "rejected" ? [result.reason] : []))];
    if (failures.length) throw new AggregateError(failures, "Permission configuration is not synchronized.");
  }
  private async transaction<T>(participants: DeploymentPermissionRules[], write: (begin: () => void) => Promise<T>, deferBegin = false): Promise<T> {
    for (const participant of participants) {
      if (participant.busy) throw new PermissionRefusal("stale");
      if (participant.runtime.status().state !== "synced" || participant.runtime.status().savedRevision !== participant.snapshot().revision) await participant.reconcile();
    }
    const updates = new Map<DeploymentPermissionRules, PermissionRulesUpdate>();
    const locked = new Set<DeploymentPermissionRules>();
    try {
      let result: T;
      try {
        for (const participant of participants) {
          if (participant.busy) throw new PermissionRefusal("stale");
          participant.busy = true; locked.add(participant);
        }
        const begin = (): void => {
          for (const participant of participants) if (!updates.has(participant)) updates.set(participant, participant.runtime.begin(participant.snapshot().revision));
        };
        if (!deferBegin) begin();
        result = await write(begin);
      }
      catch (error) {
        try { await this.synchronize(updates, true); }
        catch (recovery) { throw new AggregateError([error, recovery], "Permission write and authoritative recovery failed."); }
        throw error;
      }
      await this.synchronize(updates, false);
      // A deferred native edit still observes source/lifetime changes before returning.
      for (const participant of participants) if (!updates.has(participant)) participant.runtime.getPolicy();
      return result;
    } finally { for (const participant of locked) participant.busy = false; }
  }
  async editNative(editor: PermissionConfigEditor, entry: NativeEntry, change: Parameters<NativeEdit>[1]): Promise<void> {
    await this.transaction([this], begin => editor.edit(entry, (current, inherited) => {
      const next = validateNativeConfig(change(current, inherited));
      if (next.permissionControl?.nativeCommands !== undefined) parseHostNativeCommands(next.permissionControl.nativeCommands);
      validateNativeConfig(current);
      begin();
      if (JSON.stringify(next.permissionControl?.rules) === JSON.stringify(current.permissionControl && typeof current.permissionControl === "object" ? Reflect.get(current.permissionControl, "rules") : undefined)) return copyJson(next) as Record<string, unknown>;
      return copyJson(imported(next, "native-profile-settings", false)) as Record<string, unknown>;
    }), true);
  }
}

/** Install in the owned Core fiber with the public `agents` service injected. */
export function installDeploymentPermissionRules(ctx: Context, options: DeploymentPermissionRulesOptions): DeploymentPermissionRules {
  return new DeploymentPermissionRules(ctx, options);
}

/** Scoped to the ordinary SettingsForms owner; never replaces a global instance or registry. */
export function permissionConfigEditorFacade<T extends PermissionConfigEditor>(editor: T): T {
  const methods = new Map<PropertyKey, { original: unknown; bound: unknown }>();
  return new Proxy(editor, { get(target, key) {
    if (key !== "edit") {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const previous = methods.get(key);
      if (previous?.original === value) return previous.bound;
      const bound = value.bind(target); methods.set(key, { original: value, bound }); return bound;
    }
    return (entry: NativeEntry, change: Parameters<NativeEdit>[1]): Promise<void> => {
      const backend = entries.get(entry);
      if (backend !== undefined) return backend.editNative(target, entry, change);
      if (claimed.has(entry)) return Promise.reject(new PermissionRefusal("unavailable"));
      return target.edit(entry, change);
    };
  } });
}
