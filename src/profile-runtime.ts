import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Context } from "@deepseek-ai/cordis";
import type { DshAgent, DshContext, DshLlmRuntime } from "./dsh-types.js";
import { ProfileStore, validateSessionProfileId } from "./profile-store.js";
import type { LoadedProfileSelection, LoadedSessionProfileSelection, ProfileCommit, SessionProfileCommit } from "./profile-store.js";
import type { ProfileReadResult, ProfileSaveRequest, ProfileSelectRequest, ProfileSelectionState, ProfileSnapshot, SessionModeSelectRequest, SessionProfileSelectRequest, SessionProfileSnapshot, DeploymentAdmissionView, SubagentRuntimeAdmissionView, DsmmRoleAvailabilityState } from "./profile-types.js";
import { DsmmProfileError, parseProfileDocument, profileDocumentWarnings, requiredReason, resolveProfileSettings, validateProfileId } from "./profiles.js";
import type { DsmmProfileDocument } from "./profiles.js";
import { DSMM_ROLES, isDsmmRoleId } from "./roles.js";
import type { DsmmPluginConfig, DsmmProfileAdmission, DsmmSettings, DsmmSettingsGetter, DsmmDeploymentSnapshot } from "./settings.js";
import { freezeSettings, isRootRoleEnabled } from "./settings.js";
import { roleRouteRuntimeState } from "./role-routing.js";
import { resolveAdmittedDsmmRole } from "./role-policy.js";
import { resolveSelectedAgentPreset, sessionEvents } from "./session-scope.js";
import { DeepworkModeController, hasOpenTurn } from "./state.js";
import { resolveDshHome } from "./dsh-home.js";
import { projectDsmmModules } from "./modules.js";
import type { DsmmMountedPermissionGetter } from "./modules.js";
import { readOnlySettings, readOnlySettingSources } from "./status.js";
import { resolvedModelParameterPolicy } from "./model-parameter-policy.js";
import { scopeLifetime } from "./lifetime.js";
import type { NativeAdmission } from "./native-admission.js";
import type { Agent } from "@deepseek-ai/dsh-agent";

export interface DsmmProfileRuntimeStore {
  readonly profileDir?: string;
  readonly readOnly?: boolean;
  readonly origin?: "central" | "legacy" | "explicit";
  readonly writeRestriction?: string;
  loadSelection(): Promise<LoadedProfileSelection>;
  describe(): Promise<ProfileSnapshot>;
  read(id: string): Promise<ProfileReadResult>;
  save(request: ProfileSaveRequest, assertCurrent?: () => void): Promise<ProfileReadResult>;
  select<T>(request: ProfileSelectRequest, validate: (document: DsmmProfileDocument | null) => T | Promise<T>, commit?: ProfileCommit<T>, assertCurrent?: () => void): Promise<{ selection: ProfileSelectionState; prepared: T }>;
  loadSessionSelection(id: string): Promise<LoadedSessionProfileSelection>;
  selectSession<T>(request: SessionProfileSelectRequest, epoch: string, validate: (document: DsmmProfileDocument | null) => T | Promise<T>, commit: SessionProfileCommit<T>): Promise<{ selection: LoadedSessionProfileSelection; prepared: T }>;
}
export interface DsmmProfileRuntimeOptions {
  runtimeView?: () => SubagentRuntimeAdmissionView;
  validateCandidate?: (settings: DsmmSettings) => void | Promise<void>;
  modeController?: DeepworkModeController;
  readDesired?: () => Promise<DsmmDeploymentSnapshot>;
  startup?: DsmmDeploymentSnapshot;
  getMountedPermission?: DsmmMountedPermissionGetter;
}
export type DsmmSessionActionUnavailableReason = import("./profile-types.js").SessionActionUnavailableReason;
export type DsmmSessionProfileSnapshot = SessionProfileSnapshot;
interface AdmittedProfile extends ProfileSelectionState, DsmmProfileAdmission { baseline: DsmmSettings }
export interface PreparedHistoryProfile {
  readonly admission: DsmmProfileAdmission;
  readonly label?: string;
  assertCurrent(): undefined;
  revalidate(signal: AbortSignal): Promise<void>;
}
function newEpoch(): string { return randomBytes(32).toString("hex"); }
function selectionState(selection: ProfileSelectionState): ProfileSelectionState {
  return { selectedId: selection.selectedId, appliedRevision: selection.appliedRevision, selectionRevision: selection.selectionRevision,
    ...(selection.sourceRevision === undefined ? {} : { sourceRevision: selection.sourceRevision }),
    ...(selection.refreshRequired || selection.selectionRevision === "unavailable" ? { refreshRequired: true } : {}) };
}
function deploymentAdmissionView(admission: DsmmProfileAdmission): DeploymentAdmissionView {
  return { modelParameterPolicy: resolvedModelParameterPolicy(admission), settings: { ...readOnlySettings(admission.settings) }, sources: readOnlySettingSources(admission.sources ?? {}),
    captures: readOnlySettingSources(admission.sourceCaptures?.fields ?? {}), restartRequired: [...admission.restartRequired ?? []], named: admission.profile === null ? null : { ...admission.profile } };
}

/** Configuration transactions and immutable snapshots; native admission owns Agent binding. */
export class DsmmProfileRuntime {
  readonly getSettings: DsmmSettingsGetter = agent => this.admission(agent).settings;
  private readonly baseline: DsmmSettings;
  private current: AdmittedProfile;
  private document: DsmmProfileDocument | null = null;
  private readonly bound = new WeakMap<DshAgent, AdmittedProfile>();
  private readonly observations = new WeakMap<AdmittedProfile, ProfileSelectionState>();
  private readonly historyAdmissions = new WeakSet<DsmmProfileAdmission>();
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly mode: DeepworkModeController;
  constructor(private readonly ctx: DshContext, baseline: DsmmSettings, private readonly store: DsmmProfileRuntimeStore, private readonly options: DsmmProfileRuntimeOptions = {}) {
    this.baseline = freezeSettings(baseline);
    this.mode = options.modeController ?? new DeepworkModeController(ctx, agent => this.getSettings(agent).modules.deepwork.enabled);
    this.current = this.prepare(null, { selectedId: null, appliedRevision: null, selectionRevision: "absent" });
    this.getSettings.admission = agent => this.admission(agent);
    this.getSettings.moduleStates = agent => { const admission = this.admission(agent); return projectDsmmModules(this.baseline, admission.deployment, admission, false, options.getMountedPermission); };
    this.getSettings.subagentRuntime = () => this.runtimeView();
  }
  async initialize(): Promise<void> {
    const retire = () => { this.disposed = true; };
    if (Context.is(this.ctx)) scopeLifetime(this.ctx, "dsmm: retire profile writes", retire);
    else this.ctx.effect?.(() => retire);
    const selection = await this.store.loadSelection();
    this.assertCurrent();
    this.document = selection.document === null ? null : freezeSettings(selection.document);
    this.current = this.prepare(this.document, selection);
  }
  private assertCurrent(): void { if (this.disposed) throw new DsmmProfileError("disposed", "DSMM profile owner is retired."); }
  admission(agent?: DshAgent): AdmittedProfile {
    this.assertCurrent();
    if (agent === undefined) return this.current;
    const admission = this.bound.get(agent);
    if (admission === undefined || !this.hasAdmission(agent)) throw new DsmmProfileError("activation", "Agent has no completed live native admission.");
    return admission;
  }
  hasAdmission(agent: DshAgent): boolean {
    const owner = this.ctx.get?.<{ lifetime: { signal: AbortSignal } }>("dsmmNativeAdmission");
    return !this.disposed && owner?.lifetime.signal.aborted !== true && this.bound.has(agent) && agent.id !== undefined
      && this.ctx.get?.<{ get(id: string): DshAgent | undefined }>("agents")?.get(agent.id) === agent;
  }
  /** Called only by the awaited native creation owner after all Agent-scoped installation. */
  publish(agent: DshAgent, admission: DsmmProfileAdmission): void {
    this.assertCurrent();
    if (this.bound.has(agent)) throw new DsmmProfileError("conflict", "Agent admission is immutable.");
    if (!("baseline" in admission) || !("selectedId" in admission) || !("appliedRevision" in admission) || !("selectionRevision" in admission)) {
      throw new DsmmProfileError("activation", "Publication requires the complete configuration candidate.");
    }
    this.bound.set(agent, admission as AdmittedProfile);
  }
  release(agent: DshAgent): void { this.bound.delete(agent); }
  /** Prepare an explicit current choice; historical selection files and epochs are not read. */
  async prepareHistory(profileId: string | null, signal: AbortSignal): Promise<PreparedHistoryProfile> {
    this.assertCurrent(); signal.throwIfAborted();
    if (profileId !== null) validateProfileId(profileId);
    const directory = profileId === null ? undefined : this.store.profileDir;
    if (profileId !== null && directory === undefined) throw new DsmmProfileError("unavailable", "History continuation requires an observable saved-profile store.");
    const path = directory === undefined ? undefined : join(directory, `${profileId}.jsonc`);
    const observe = () => {
      if (path === undefined) return undefined;
      const stat = lstatSync(path, { bigint: true }), parent = lstatSync(directory!, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()) throw new DsmmProfileError("unsafe-path", "The saved profile source is not a regular file.");
      return [realpathSync(directory!), parent.dev, parent.ino, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs];
    };
    const source = observe();
    const saved = profileId === null ? null : await this.store.read(profileId);
    const deployment = await this.options.readDesired?.();
    const document = saved === null ? null : parseProfileDocument(saved.content, saved.id);
    const candidate = this.prepare(document, { selectedId: profileId, appliedRevision: saved?.revision ?? null,
      selectionRevision: "unavailable", ...(saved === null ? {} : { sourceRevision: saved.revision }) }, newEpoch(), profileId === null ? "deployment-baseline" : "session-override", deployment);
    const assertCurrent = (): undefined => {
      this.assertCurrent(); signal.throwIfAborted();
      if (!isDeepStrictEqual(source, observe())) throw new DsmmProfileError("conflict", "The saved profile changed during history continuation.");
    };
    await this.validate(candidate.settings); assertCurrent();
    this.historyAdmissions.add(candidate);
    return { admission: candidate, ...(saved?.label === undefined ? {} : { label: saved.label }), assertCurrent,
      revalidate: async currentSignal => {
        currentSignal.throwIfAborted(); assertCurrent();
        const desired = await this.options.readDesired?.();
        if (!isDeepStrictEqual(desired, deployment)) throw new DsmmProfileError("conflict", "Deployment changed during history continuation.");
        await this.validate(candidate.settings); currentSignal.throwIfAborted(); assertCurrent();
      } };
  }
  async prepareRoot(agent: DshAgent, signal: AbortSignal): Promise<AdmittedProfile> {
    this.assertRoot(agent); signal.throwIfAborted();
    const deployment = await this.options.readDesired?.();
    const selection = await this.store.loadSessionSelection(agent.id!);
    this.assertRoot(agent); signal.throwIfAborted();
    const candidate = selection.admissionEpoch === null
      ? this.prepare(this.document, this.observedSelection(this.current), newEpoch(), "global-default", deployment)
      : this.prepare(selection.document, selection, selection.admissionEpoch, selection.selectedId === null ? "deployment-baseline" : "session-override", deployment);
    const role = agent.ctx?.get?.<{ composedPreset(ctx: unknown): string | undefined }>("agentPresets")?.composedPreset(agent.ctx) ?? resolveSelectedAgentPreset(agent.session);
    if (role?.startsWith("dsmm-") && (!isDsmmRoleId(role) || !isRootRoleEnabled(candidate.settings, role))) throw new DsmmProfileError("activation", "Preset is not eligible for a root Agent.");
    await this.validate(candidate.settings);
    this.assertRoot(agent); signal.throwIfAborted();
    return candidate;
  }
  async getSession(agent: DshAgent): Promise<DsmmSessionProfileSnapshot> {
    this.assertRoot(agent);
    const admitted = this.admission(agent);
    const disk = await this.store.loadSessionSelection(agent.id!);
    await this.ctx.get?.<{ ensure?(agent: DshAgent): Promise<DsmmProfileAdmission> }>("dsmmNativeAdmission")?.ensure?.(agent);
    this.assertRoot(agent);
    if (this.admission(agent) !== admitted || !this.historyAdmissions.has(admitted) && ((disk.admissionEpoch === null && admitted.scope !== "global-default")
      || (disk.admissionEpoch !== null && (disk.admissionEpoch !== admitted.epoch || disk.selectedId !== admitted.selectedId || disk.appliedRevision !== admitted.appliedRevision)))) {
      throw new DsmmProfileError("conflict", "The session choice changed outside this owner; its admitted configuration was retained.");
    }
    if (disk.admissionEpoch === admitted.epoch) this.observations.set(admitted, selectionState(disk));
    return this.sessionSnapshot(agent, admitted, disk);
  }
  private sessionSnapshot(agent: DshAgent, admitted: AdmittedProfile, disk: LoadedSessionProfileSelection, inMaintenance = false): SessionProfileSnapshot {
    const role = resolveAdmittedDsmmRole(agent, admitted.settings, this.mode.active(agent, admitted.settings.defaultActive));
    const profileModel = role === undefined ? undefined : admitted.settings.roleRouting[role]?.primary;
    const deepwork = this.mode.describe(agent, admitted.settings.defaultActive);
    return { sessionId: agent.id!, globalDefault: this.observedSelection(this.current), selection: selectionState(disk), admittedSelection: this.observedSelection(admitted), scope: admitted.scope,
      rolePolicy: structuredClone(roleRouteRuntimeState(agent, admitted.settings, role, admitted.epoch)), deepwork,
      modules: projectDsmmModules(this.baseline, admitted.deployment, admitted, false, this.options.getMountedPermission), configuration: deploymentAdmissionView(admitted),
      warnings: structuredClone(admitted.warnings ?? []), roles: structuredClone(admitted.roleAvailability ?? []), subagentRuntime: this.runtimeView(),
      ...(profileModel === undefined ? {} : { profileModel: structuredClone(profileModel) }), admissionEpoch: admitted.epoch,
      ...this.sessionActions(agent, admitted, deepwork, profileModel !== undefined, inMaintenance), switchAllowed: false, switchUnavailableReason: "unavailable" };
  }
  async selectMode(request: SessionModeSelectRequest, agent: DshAgent, signal?: AbortSignal, authority?: () => void): Promise<DsmmSessionProfileSnapshot> {
    this.assertRoot(agent);
    if (request.sessionId !== agent.id) throw new DsmmProfileError("not-owned", "The native session does not match the captured Agent.");
    const admitted = this.admission(agent);
    const check = (maintenanceSignal?: AbortSignal): void => {
      this.assertRoot(agent);
      if (signal?.aborted || maintenanceSignal?.aborted) throw new DsmmProfileError("cancelled", "The Deepwork change was cancelled.");
      if (this.admission(agent) !== admitted || admitted.epoch !== request.expectedAdmissionEpoch || this.mode.describe(agent, admitted.settings.defaultActive).revision !== request.expectedModeRevision) throw new DsmmProfileError("conflict", "The session profile, preset or mode changed.");
      authority?.();
    };
    check();
    if (request.active && !admitted.settings.modules.deepwork.enabled) throw new DsmmProfileError("unavailable", "A mode intent cannot enable an unmounted Deepwork module.");
    if (agent.status === "running") throw new DsmmProfileError("busy", "Wait for the session to become idle.");
    if (agent.runMaintenance === undefined) throw new DsmmProfileError("unavailable", "Native idle maintenance is unavailable.");
    const before = await this.getSession(agent);
    check();
    try {
      return await agent.runMaintenance(async maintenanceSignal => {
        check(maintenanceSignal);
        if (hasOpenTurn(sessionEvents(agent.session))) throw new DsmmProfileError("busy", "A session turn is still open.");
        await this.mode.selectIdle(agent, request.active, admitted.settings.defaultActive);
        const role = resolveAdmittedDsmmRole(agent, admitted.settings, this.mode.active(agent, admitted.settings.defaultActive));
        const profileModel = role === undefined ? undefined : admitted.settings.roleRouting[role]?.primary;
        const deepwork = this.mode.describe(agent, admitted.settings.defaultActive);
        const { profileModel: _previous, selectModelUnavailableReason: _modelReason, toggleModeUnavailableReason: _modeReason, applyOverlayUnavailableReason: _overlayReason, ...snapshot } = before;
        return { ...snapshot, deepwork, ...this.sessionActions(agent, admitted, deepwork, profileModel !== undefined),
          rolePolicy: structuredClone(roleRouteRuntimeState(agent, admitted.settings, role, admitted.epoch)), ...(profileModel === undefined ? {} : { profileModel: structuredClone(profileModel) }) };
      });
    } catch (error) {
      if (error instanceof DsmmProfileError) throw error;
      throw new DsmmProfileError("maintenance", "The native session refused the Deepwork change.");
    }
  }
  async selectSession(request: SessionProfileSelectRequest, agent: DshAgent, signal?: AbortSignal, authority?: () => void): Promise<SessionProfileSnapshot> {
    this.assertRoot(agent);
    if (this.historyAdmissions.has(this.admission(agent))) throw new DsmmProfileError("unavailable", "A continued historical Agent is not a blank configuration target.");
    if (request.sessionId !== agent.id) throw new DsmmProfileError("not-owned", "The native session does not match the captured Agent.");
    const previous = this.admission(agent);
    const owner = this.ctx.get?.<NativeAdmission>("dsmmNativeAdmission");
    const check = (maintenanceSignal?: AbortSignal): void => {
      this.assertRoot(agent);
      if (signal?.aborted || maintenanceSignal?.aborted) throw new DsmmProfileError("cancelled", "The session configuration change was cancelled.");
      if (this.admission(agent) !== previous || previous.epoch !== request.expectedAdmissionEpoch || this.ctx.get?.("dsmmNativeAdmission") !== owner) {
        throw new DsmmProfileError("conflict", "The admitted session configuration changed; refresh before selecting again.");
      }
      authority?.();
    };
    check();
    if (owner?.beginBlank === undefined || agent.runMaintenance === undefined) throw new DsmmProfileError("unavailable", "Native blank-session configuration maintenance is unavailable.");
    if (agent.status === "running") throw new DsmmProfileError("busy", "Wait for the session to become idle.");
    try {
      return await agent.runMaintenance(async maintenanceSignal => {
        check(maintenanceSignal);
        const transaction = owner.beginBlank(agent as Agent, signal === undefined ? maintenanceSignal : AbortSignal.any([maintenanceSignal, signal]), () => check(maintenanceSignal));
        const assertCurrent = () => transaction.assertCurrent();
        let next!: AdmittedProfile, response!: SessionProfileSnapshot;
        try {
          const epoch = newEpoch();
          const result = await this.store.selectSession(request, epoch, async document => {
            const deployment = await this.options.readDesired?.(); assertCurrent();
            const candidate = this.prepare(document, { selectedId: request.id, appliedRevision: null, selectionRevision: "unavailable" }, epoch,
              request.id === null ? "deployment-baseline" : "session-override", deployment ?? previous.deployment);
            await this.validate(candidate.settings); assertCurrent();
            return { candidate, document };
          }, {
            assertCurrent,
            prepare: async (selection, prepared) => {
              assertCurrent();
              const candidate = prepared.candidate;
              next = this.profileAdmission(selection, candidate.settings, selection.admissionEpoch!, candidate.scope,
                candidate.baseline, candidate.deployment, candidate.restartRequired, prepared.document, selection.warnings);
              await transaction.prepare(next, () => { response = this.sessionSnapshot(agent, next, selection, true); }); assertCurrent();
            },
            committed: () => { this.bound.set(agent, next); transaction.committed(); },
          });
          this.observations.set(next, selectionState(result.selection));
          return { ...response, selection: selectionState(result.selection), admittedSelection: selectionState(result.selection),
            ...(result.selection.refreshRequired ? { refreshRequired: true } : {}) };
        } finally { await transaction.close(); }
      });
    } catch (error) {
      if (error instanceof DsmmProfileError) throw error;
      throw new DsmmProfileError("maintenance", "The native session refused the configuration change.");
    }
  }
  private assertRoot(agent: DshAgent): void {
    this.assertCurrent(); validateSessionProfileId(agent.id);
    const agents = this.ctx.get?.<{ get(id: string): DshAgent | undefined; roots(): DshAgent[] }>("agents");
    if (agents?.get(agent.id) !== agent || !agents.roots().includes(agent) || agent.session.header?.origin === "subagent") throw new DsmmProfileError("not-owned", "The exact live root Agent is required.");
  }
  async describe(): Promise<ProfileSnapshot> {
    this.assertCurrent(); const disk = await this.store.describe(); this.assertCurrent();
    const current = this.current;
    const changed = disk.selectedId !== current.selectedId || disk.appliedRevision !== current.appliedRevision
      || (this.observedSelection(current).selectionRevision !== "unavailable" && disk.selectionRevision !== this.observedSelection(current).selectionRevision);
    if (!changed && disk.selectionError === undefined) this.observations.set(current, selectionState(disk));
    const { sourceRevision: _source, ...snapshot } = disk;
    return { ...snapshot, selectedId: current.selectedId, appliedRevision: current.appliedRevision,
      ...(current.sourceRevision === undefined ? {} : { sourceRevision: current.sourceRevision }),
      selectedWarnings: structuredClone(current.warnings ?? []), editorDefaults: structuredClone(this.baseline.runtimePolicy), roles: this.editorRoles(current),
      ...(disk.selectionError === undefined && changed ? { selectionError: { code: "conflict", message: "The persisted selection changed outside this Host. Reapply the desired profile or restart; the admitted policy was retained." } } : {}) };
  }
  read(id: string): Promise<ProfileReadResult> { this.assertCurrent(); return this.store.read(id); }
  save(request: ProfileSaveRequest, authority?: () => void): Promise<ProfileReadResult> {
    const assertCurrent = (): void => { this.assertCurrent(); authority?.(); };
    assertCurrent();
    return this.store.save(request, assertCurrent);
  }
  getStartupSettings(): DsmmSettings { return this.baseline; }
  previewDeployment(desired: DsmmDeploymentSnapshot): DeploymentAdmissionView { return deploymentAdmissionView(this.prepare(this.document, this.current, newEpoch(), "global-default", desired)); }
  async describeDeployment(agent?: DshAgent) {
    this.assertCurrent(); const desired = await this.options.readDesired?.(); this.assertCurrent();
    return { startup: this.options.startup ?? null, desired: desired ?? null, admission: agent === undefined ? null : this.admission(agent) };
  }
  select(request: ProfileSelectRequest, authority?: () => void): Promise<ProfileSnapshot> {
    const assertCurrent = (): void => { this.assertCurrent(); authority?.(); };
    const operation = this.queue.then(async () => {
      assertCurrent();
      const before = await this.describe();
      assertCurrent();
      const baseline = this.current.baseline;
      let document: DsmmProfileDocument | null = null;
      let next!: AdmittedProfile;
      let response!: ProfileSnapshot;
      const result = await this.store.select(request, async value => {
        document = value === null ? null : freezeSettings(value);
        const settings = freezeSettings(resolveProfileSettings(baseline as DsmmPluginConfig, value?.settings ?? {}));
        await this.validate(settings); assertCurrent(); return settings;
      }, { prepare: (selection, settings) => {
          assertCurrent(); next = this.profileAdmission(selection, settings, newEpoch(), "global-default", baseline, this.current.deployment, this.current.restartRequired, document, selection.warnings);
          const { selectionError: _error, sourceRevision: _source, refreshRequired: _refresh, ...snapshot } = before;
          response = { ...snapshot, ...selectionState(selection), selectedWarnings: structuredClone(next.warnings ?? []), roles: this.editorRoles(next) };
        },
        committed: () => { this.current = next; this.document = document; } }, assertCurrent);
      this.observations.set(next, selectionState(result.selection));
      const { refreshRequired: _refresh, ...snapshot } = response;
      return { ...snapshot, ...selectionState(result.selection) };
    });
    this.queue = operation.catch(() => undefined); return operation;
  }
  private prepare(document: DsmmProfileDocument | null, selection: ProfileSelectionState, epoch = newEpoch(), scope: DsmmProfileAdmission["scope"] = "global-default", deployment = this.options.startup): AdmittedProfile {
    const desired = deployment?.settings ?? this.baseline, effective = structuredClone(desired), restartRequired: string[] = [];
    effective.modules.deepwork.enabled &&= this.baseline.modules.deepwork.enabled;
    effective.subagents.allowRouteOverride &&= this.baseline.subagents.allowRouteOverride;
    if (desired.modules.deepwork.enabled && !this.baseline.modules.deepwork.enabled) restartRequired.push("modules.deepwork.enabled");
    if (desired.subagents.allowRouteOverride && !this.baseline.subagents.allowRouteOverride) restartRequired.push("subagents.allowRouteOverride");
    if (this.baseline.subagents.maxDepth !== undefined && (desired.subagents.maxDepth === undefined || desired.subagents.maxDepth > this.baseline.subagents.maxDepth)) { effective.subagents.maxDepth = this.baseline.subagents.maxDepth; restartRequired.push("subagents.maxDepth"); }
    for (const role of DSMM_ROLES) { if (desired.roles[role.id] && !this.baseline.roles[role.id]) restartRequired.push(`roles.${role.id}`); effective.roles[role.id] &&= this.baseline.roles[role.id]; }
    for (const key of ["modeName", "promptOrder", "presets", "lsp"] as const) {
      if (JSON.stringify(desired[key]) !== JSON.stringify(this.baseline[key])) restartRequired.push(key);
      Object.assign(effective, { [key]: this.baseline[key] });
    }
    if (desired.permissionControl.enabled !== this.baseline.permissionControl.enabled) restartRequired.push("permissionControl.enabled");
    effective.permissionControl = { ...effective.permissionControl, enabled: this.baseline.permissionControl.enabled };
    if (deployment !== undefined && this.options.startup !== undefined && (deployment.profile.section ?? deployment.global.section) !== (this.options.startup.profile.section ?? this.options.startup.global.section)) restartRequired.push("section");
    const baseline = freezeSettings(effective);
    return this.profileAdmission(selection, freezeSettings(resolveProfileSettings(baseline as DsmmPluginConfig, document?.settings ?? {})), epoch, scope, baseline, deployment, restartRequired, document, (selection as LoadedProfileSelection).warnings);
  }
  private profileAdmission(selection: ProfileSelectionState, settings: DsmmSettings, epoch: string, scope: DsmmProfileAdmission["scope"], baseline: DsmmSettings, deployment?: DsmmDeploymentSnapshot, restartRequired: readonly string[] = [], document: DsmmProfileDocument | null = null, warnings = profileDocumentWarnings(document)): AdmittedProfile {
    const sources: NonNullable<DsmmProfileAdmission["sources"]> = { ...deployment?.sources };
    const fields: NonNullable<DsmmProfileAdmission["sourceCaptures"]>["fields"] = Object.fromEntries(Object.keys(sources).map(path => [path, "deployment"]));
    for (const prefix of ["modeName", "promptOrder", "presets", "lsp", "permissionControl.enabled", ...restartRequired]) {
      for (const path of Object.keys(sources).filter(path => path === prefix || path.startsWith(`${prefix}.`))) { delete sources[path]; delete fields[path]; }
      for (const [path, source] of Object.entries(this.options.startup?.sources ?? {}).filter(([path]) => path === prefix || path.startsWith(`${prefix}.`))) { sources[path] = source; fields[path] = "startup"; }
    }
    const mark = (value: unknown, path: string[]): void => {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) for (const [key, child] of Object.entries(value)) mark(child, [...path, key]);
      else { sources[path.join(".")] = "named-session"; fields[path.join(".")] = "named-session"; }
    };
    for (const [role, policy] of Object.entries(document?.settings.roleRouting ?? {})) {
      const prefixes = [...policy?.primary === undefined ? [] : [`roleRouting.${role}.primary.`], ...Object.keys(policy?.levels ?? {}).map(level => `roleRouting.${role}.levels.${level}.`)];
      for (const prefix of prefixes) for (const path of Object.keys(sources).filter(path => path.startsWith(prefix))) { delete sources[path]; delete fields[path]; }
    }
    mark(document?.settings ?? {}, []);
    return freezeSettings({ ...selectionState(selection), settings, baseline, epoch, scope, ...(deployment === undefined ? {} : { deployment }),
      warnings, restartRequired: [...restartRequired], sources, sourceCaptures: { fields, ...(this.options.startup === undefined ? {} : { startup: { globalRevision: this.options.startup.globalRevision, nativeRevision: this.options.startup.nativeRevision } }) }, subagentRuntime: this.runtimeView(),
      ...(this.store.origin === undefined ? {} : { store: { origin: this.store.origin, readOnly: this.store.readOnly === true, ...(this.store.writeRestriction === undefined ? {} : { writeRestriction: this.store.writeRestriction }) } }),
      roleAvailability: this.roleAvailability(settings, baseline, deployment, document),
      profile: selection.selectedId === null || selection.appliedRevision === null ? null : { id: selection.selectedId, revision: selection.appliedRevision } });
  }
  private roleAvailability(settings: DsmmSettings, baseline: DsmmSettings, deployment?: DsmmDeploymentSnapshot, document?: DsmmProfileDocument | null): DsmmRoleAvailabilityState[] {
    return DSMM_ROLES.map(role => {
      const required = requiredReason(settings, role.id), named = document?.settings.roles?.[role.id];
      const startup = this.baseline.roles[role.id], desired = deployment?.settings.roles[role.id] ?? baseline.roles[role.id];
      const reason = !settings.modules.deepwork.enabled ? "module-off" : !desired ? "deployment-disabled" : !startup ? "startup-unavailable" : named === false ? "profile-disabled" : undefined;
      const startupCeiling = !startup && desired;
      return { id: role.id, required: required !== undefined, ...(required === undefined ? {} : { requiredReason: required }), startupAvailable: startup, deploymentEnabled: desired,
        ...(named === undefined ? {} : { namedEnabled: named }), admitted: settings.modules.deepwork.enabled && settings.roles[role.id], ...(reason === undefined ? {} : { reason }),
        source: named !== undefined ? "named-session" : startupCeiling ? this.options.startup?.sources[`roles.${role.id}`] ?? "defaults" : deployment?.sources[`roles.${role.id}`] ?? "defaults",
        capture: named !== undefined ? "named-session" : startupCeiling ? "startup" : "deployment" };
    });
  }
  private editorRoles(admission: AdmittedProfile): NonNullable<ProfileSnapshot["roles"]> {
    return DSMM_ROLES.map(role => {
      const configured = this.baseline.roleRouting[role.id];
      const runtimePolicy = { ...(configured?.strategy === undefined ? {} : { strategy: configured.strategy }), ...(configured?.rateLimit === undefined ? {} : { rateLimit: structuredClone(configured.rateLimit) }) };
      return { id: role.id, label: role.name, enabled: admission.settings.roles[role.id], availability: admission.roleAvailability?.find(row => row.id === role.id), ...(Object.keys(runtimePolicy).length === 0 ? {} : { runtimePolicy }) };
    });
  }
  private sessionActions(agent: DshAgent, admission: DsmmProfileAdmission, mode: NonNullable<SessionProfileSnapshot["deepwork"]>, hasProfileModel: boolean, inMaintenance = false): Pick<DsmmSessionProfileSnapshot, "canSelectModel" | "selectModelUnavailableReason" | "canToggleMode" | "toggleModeUnavailableReason" | "canApplyOverlay" | "applyOverlayUnavailableReason"> {
    const llm = agent.ctx?.get?.<DshLlmRuntime>("llm") ?? this.ctx.get?.<DshLlmRuntime>("llm");
    const selectModelUnavailableReason = !hasProfileModel ? "model-unconfigured" : llm?.resolveCallConfig === undefined ? "model-service-unavailable" : undefined;
    const owner = this.ctx.get?.<NativeAdmission>("dsmmNativeAdmission");
    const ready = owner?.isReady === true && this.ctx.get?.("subagents") !== undefined && this.ctx.get?.("agentPresets") !== undefined;
    const toggleModeUnavailableReason = agent.status === "running" || hasOpenTurn(sessionEvents(agent.session)) ? "busy"
      : agent.runMaintenance === undefined ? "maintenance" : !mode.active && (!this.baseline.modules.deepwork.enabled || !admission.settings.modules.deepwork.enabled) ? "module-off"
      : mode.locked || !mode.active && !ready ? "runtime-unavailable" : undefined;
    const applyOverlayUnavailableReason = this.historyAdmissions.has(admission) ? "new-session-required" : this.store.readOnly ? "runtime-unavailable" : owner?.blankReason?.(agent as Agent, inMaintenance) ?? (owner?.blankReason === undefined ? "runtime-unavailable" : undefined);
    return { canSelectModel: selectModelUnavailableReason === undefined, ...(selectModelUnavailableReason === undefined ? {} : { selectModelUnavailableReason }),
      canToggleMode: toggleModeUnavailableReason === undefined, ...(toggleModeUnavailableReason === undefined ? {} : { toggleModeUnavailableReason }),
      canApplyOverlay: applyOverlayUnavailableReason === undefined, ...(applyOverlayUnavailableReason === undefined ? {} : { applyOverlayUnavailableReason }) };
  }
  private async validate(settings: DsmmSettings): Promise<void> {
    if (!settings.modules.deepwork.enabled) return;
    if (this.options.validateCandidate !== undefined) { await this.options.validateCandidate(settings); return; }
    if (this.options.runtimeView !== undefined && !this.runtimeView().deliveryFenceReady) return;
    const registry = this.ctx.get?.<{ resolve(id: string): Promise<{ broken?: string }> }>("agentPresets");
    if (registry !== undefined) for (const role of DSMM_ROLES.filter(role => isRootRoleEnabled(settings, role.id))) {
      try { if ((await registry.resolve(role.id)).broken !== undefined) throw new Error("unusable root preset"); }
      catch { throw new DsmmProfileError("activation", "An enabled root preset is unavailable.", role.id); }
    }
  }
  private observedSelection(admission: AdmittedProfile): ProfileSelectionState { return this.observations.get(admission) ?? selectionState(admission); }
  private runtimeView(): SubagentRuntimeAdmissionView { return this.options.runtimeView?.() ?? { binding: "unavailable", deliveryFenceReady: false, restartRequired: true, reason: "authority-not-ready" }; }
}

export async function createProfileRuntime(ctx: DshContext, baseline: DsmmSettings, options: DsmmProfileRuntimeOptions = {}): Promise<DsmmProfileRuntime> {
  const profile = ctx.get?.<{ dir?: string; home?: string }>("profileContext");
  if (!profile?.dir) throw new DsmmProfileError("activation", "Profiles require an exact native profile directory.");
  const legacy = join(profile.dir, "dsmm-profiles");
  let exists = false;
  try { lstatSync(legacy); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const entry = options.startup?.entryId ?? (Context.is(ctx) ? ctx.fiber.entry?.id : undefined) ?? "trusted-direct";
  const store = exists ? ProfileStore.fromLegacy(legacy) : ProfileStore.fromCentral(resolveDshHome(profile.home), profile.dir, entry);
  const runtime = new DsmmProfileRuntime(ctx, baseline, store, options); await runtime.initialize(); return runtime;
}
