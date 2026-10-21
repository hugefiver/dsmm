import type { ConfigForms } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { DeploymentController } from "./deployment-controller.js";
import type { PermissionController } from "./permission-controller.js";
import type { ConfigModule } from "./deployment-modules.js";
import { CONFIG_MODULES, moduleFields } from "./deployment-modules.js";
import { scopeSchema } from "./deployment-data.js";
export type ConfigScope = "global" | "profile";
interface Destination { scope: ConfigScope; module: ConfigModule | null }
interface WorkspaceView extends Destination { pending: Destination | null; native: DeploymentController | null; revision: number }
/** Contribution-owned memory only. Navigation never saves, applies, or rebases drafts. */
export class DeploymentWorkspace {
  private state: WorkspaceView = { scope: "global", module: null, pending: null, native: null, revision: 0 };
  private listeners = new Set<() => void>();
  private visited: Record<ConfigScope, ConfigModule | null> = { global: null, profile: null };
  private forms: ConfigForms | null = null;
  private profiles = new Map<string, DeploymentController>();
  private stopForm?: () => void;
  private stopNative?: () => void;
  private stopCore: () => void;
  private stopPermissions?: () => void;
  private identity: string | null = null;
  private globalVersion?: string;
  private sourceBlocked = false;
  private attachCurrentForm?: () => void;
  constructor(readonly core: DeploymentController, readonly permissions?: PermissionController) {
    this.stopCore = core.subscribe(() => { this.sync(); this.changed(); });
    this.stopPermissions = permissions?.store.subscribe(() => this.changed());
    this.sync();
  }
  readonly getSnapshot = (): WorkspaceView => this.state;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private changed(patch: Partial<WorkspaceView> = {}): void { this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }; for (const listener of this.listeners) listener(); }
  bindForms(forms: ConfigForms | null): void { if (this.forms === forms) return; this.forms = forms; this.identity = null; this.sync(); this.changed(); }
  private sync(): void {
    const snapshot = this.core.getSnapshot().snapshot;
    const issue = this.core.getSnapshot().issue, blocked = issue === "unavailable" || issue === "not-owned" || issue === "transport", restored = this.sourceBlocked && !blocked; this.sourceBlocked = blocked;
    const key = snapshot?.namespace == null ? null : JSON.stringify([snapshot.hostProfileKey, snapshot.entryId, snapshot.namespace]);
    const changedGlobal = snapshot?.globalRevision !== this.globalVersion; this.globalVersion = snapshot?.globalRevision;
    if (key === this.identity) {
      if (blocked) this.state.native?.attachForm(null); else if (restored) this.attachCurrentForm?.();
      if (!blocked && changedGlobal && this.state.native !== null && !this.state.native.getSnapshot().busy) void this.state.native.refresh(); return;
    }
    this.identity = key; this.stopForm?.(); this.stopNative?.(); this.attachCurrentForm = undefined;
    let native: DeploymentController | null = null;
    if (key !== null && snapshot !== null) {
      native = this.profiles.get(key) ?? this.core.forProfile(snapshot.namespace!); this.profiles.set(key, native);
      this.stopNative = native.subscribe(() => this.changed());
      if (this.forms !== null) {
        const form = this.forms.get<Record<string, unknown>>(snapshot.namespace!);
        const attach = () => { native!.attachForm(this.sourceBlocked ? null : { state: form.getSnapshot(), mutate: (ops, revision) => form.mutate(ops, revision) }); this.changed(); if (!this.sourceBlocked && !native!.getSnapshot().busy) void native!.refresh(); };
        this.attachCurrentForm = attach;
        this.stopForm = form.subscribe(attach); attach();
      } else native.attachForm(null);
      if (native.getSnapshot().snapshot === null) void native.refresh();
    }
    this.changed({ native });
  }
  controller(scope = this.state.scope): DeploymentController | null { return scope === "global" ? this.core : this.state.native; }
  /** First visit opens the first section with editable fields; afterwards the last viewed section. */
  private defaultSection(scope: ConfigScope): ConfigModule {
    const restored = this.visited[scope];
    if (restored !== null) return restored;
    const snapshot = this.controller(scope)?.getSnapshot().snapshot;
    if (snapshot !== null && snapshot !== undefined) {
      const schema = scopeSchema(snapshot, scope);
      for (const module of CONFIG_MODULES) if (module !== "state" && moduleFields(schema, module, scope).length > 0) return module;
    }
    return "state";
  }
  hasPending(): boolean { return this.controller()?.getSnapshot().dirty === true || this.state.module === "permissions" && this.permissions?.store.getSnapshot().dirty === true; }
  request(destination: Destination): void {
    const switched = destination.scope !== this.state.scope;
    const leaving = switched || this.state.module !== null && destination.module !== null && destination.module !== this.state.module;
    if (leaving && this.hasPending()) { this.changed({ pending: destination }); return; }
    const module = destination.module ?? this.defaultSection(destination.scope);
    this.visited[destination.scope] = module;
    this.changed({ scope: destination.scope, module, pending: null });
    if (switched) void this.controller()?.refresh();
  }
  continueEditing(): void { this.changed({ pending: null }); }
  /** Explicitly keep every draft and move anyway; the draft stays in contribution memory. */
  keepAndNavigate(): void {
    const target = this.state.pending; if (target === null) return;
    const module = target.module ?? this.defaultSection(target.scope);
    this.visited[target.scope] = module;
    const switched = target.scope !== this.state.scope;
    this.changed({ scope: target.scope, module, pending: null });
    if (switched) void this.controller()?.refresh();
  }
  async discardAndNavigate(): Promise<void> {
    const destination = this.state.pending; if (destination === null) return;
    const controller = this.controller();
    if (controller?.getSnapshot().dirty) { await controller.refresh(true); if (controller.getSnapshot().dirty || controller.getSnapshot().issue !== null) return; }
    if (this.state.module === "permissions" && this.permissions?.store.getSnapshot().dirty) {
      const permissions = this.permissions.store.getSnapshot();
      await this.permissions.refresh(permissions.generation, true);
      if (this.permissions.store.getSnapshot().dirty) return;
    }
    if (this.state.pending === destination) this.request(destination);
  }
  async save(): Promise<void> { const controller = this.controller(); if (controller === null) return; await controller.save(); if (controller !== this.core && controller.getSnapshot().saved) await this.core.refresh(); }
  dispose(): void { this.stopCore(); this.stopForm?.(); this.stopNative?.(); this.stopPermissions?.(); for (const controller of this.profiles.values()) controller.dispose(); this.listeners.clear(); }
}
const workspaces = new WeakMap<DeploymentController, DeploymentWorkspace>();
export function deploymentWorkspace(core: DeploymentController, permissions?: PermissionController): DeploymentWorkspace {
  let workspace = workspaces.get(core); if (workspace === undefined) { workspace = new DeploymentWorkspace(core, permissions); workspaces.set(core, workspace); } return workspace;
}
