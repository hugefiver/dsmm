import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { ConnectionGenerationState } from "@deepseek-ai/dsh-client-connection/client";
import type { ComposerBlock, ComposerBlocks } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionEventSource, SessionEventWindow, SessionSnapshot } from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-agent-preset-registry";
import type { ModelDirectoryState } from "@deepseek-ai/dsh-client-ui-model-selection/client";
import type { DsmmProfilesRemote } from "../profile-remote.js";
import { isProfileId } from "../profile-remote.js";
import type { ProfileDiagnostic, ProfileDiagnosticCode, ProfileDiagnosticLocation, ProfileErrorInfo, ProfileReadResult, ProfileSnapshot } from "../profile-types.js";
import { safeIssue } from "./diagnostics.js";
import { isConfigRevision } from "../config-revision.js";
import { writableSelectionVersion } from "./configuration-display.js";
import type { SessionProfileSnapshot } from "../profile-types.js";
import type { ModelCatalog, SessionSelectModelRequest, SessionSelectModelValue } from "@deepseek-ai/dsh-api-session-controller";
import { editStructuredPath, moveFallback, structuredDocument } from "./structured.js";
import type { JsonPath } from "./structured.js";
import type { ProfileBlankNative, ProfileWorkspace } from "./profile-blank.js";

export interface ProfileEditor { id: string; content: string; revision: string | null; warnings?: ProfileDiagnostic[]; refreshRequired?: true }
export interface ProfilesNotice { key: "saved" | "applied" | "reset"; id?: string }
export interface ProfilesIssue { kind: "domain" | "transport" | "assembly"; code: string; message?: string; field?: string; reason?: ProfileDiagnosticCode; location?: ProfileDiagnosticLocation; source?: "selection" | "profile-model" }
export interface SessionApplyOptions { useProfileModel?: boolean }
export interface ProfilesViewSnapshot {
  snapshot: ProfileSnapshot | null;
  editor: ProfileEditor | null;
  dirty: boolean;
  busy: "refresh" | "read" | "save" | "apply" | "reset" | null;
  issue: ProfilesIssue | null;
  notice: ProfilesNotice | null;
  pendingEditor: string | null;
  catalog: ModelCatalog | null;
  catalogBusy: boolean;
  catalogUnavailable: boolean;
  currentSessionId: string | null;
  sessionViewEpoch: number;
  sessionUnconfirmed: boolean;
  sessionReadinessPending: boolean;
  session: SessionProfileSnapshot | null;
  sessionChoice: string | null;
  sessionWorkspaces: readonly ProfileWorkspace[];
  sessionWorkspaceId: string | null;
  sessionPreparationAvailable: boolean;
  sessionPreparationPending: boolean;
  sessionBusy: "read" | "apply" | "reset" | "mode" | null;
  sessionIssue: ProfilesIssue | null;
  sessionNotice: "applied" | "reset" | "applied-with-model" | "mode-on" | "mode-off" | null;
  invalidFields: string[];
  editorEpoch: number;
  validationEpoch: number;
}
export interface ProfilesActions {
  readProfileView(): ProfilesViewSnapshot;
  refresh(): Promise<void>;
  open(id: string): Promise<void>;
  create(): Promise<void>;
  reload(): Promise<void>;
  editId(id: string): void;
  editContent(content: string): void;
  save(): Promise<void>;
  apply(): Promise<void>;
  reset(): Promise<void>;
  discard(): void;
  discardAndOpen(): Promise<void>;
  cancelDiscard(): void;
  editPath(path: JsonPath, value: unknown): void;
  editRoute(path: JsonPath, provider: string, model: string): void;
  moveFallback(role: string, from: number, to: number): void;
  refreshCatalog(): Promise<void>;
  refreshSession(): Promise<void>;
  chooseSessionProfile(id: string | null): void;
  chooseSessionWorkspace(id: string): Promise<void>;
  applySession(options?: SessionApplyOptions): Promise<void>;
  resetSession(): Promise<void>;
  setDeepwork(active: boolean): Promise<void>;
  useSessionProfileModel(): Promise<void>;
  setFieldInvalid(field: string, invalid: boolean): void;
  setNumberDraft(key: string, entry: NumberDraftState | null): void;
  getNumberDraft(key: string): NumberDraftState | undefined;
}
export interface NumberDraftState {
  draft: string;
  invalid: boolean;
  sourceValue: number | undefined;
}
export interface ModelCatalogRemote { modelCatalog(): Promise<RemoteResult<ModelCatalog>> }
export interface ProfileModelSelectorRemote { selectModel(request: SessionSelectModelRequest): Promise<RemoteResult<SessionSelectModelValue>> }
type ModelInteractionSource = HostObservable<Pick<ModelDirectoryState, "status">>;
function modelSelectionWatermark(window: SessionEventWindow): number {
  let watermark = -1;
  for (const entry of window.entries) if (entry.type === "event" && entry.event.type === "model/selection") watermark = Math.max(watermark, Number(entry.event.seq));
  return watermark;
}
function modeIntentWatermark(window: SessionEventWindow): number {
  let watermark = -1;
  for (const entry of window.entries) if (entry.type === "event" && (entry.event.type === "deepwork/mode" || entry.event.type === "agent-preset/selected")) watermark = Math.max(watermark, Number(entry.event.seq));
  return watermark;
}

const NEW_EDITOR = "";
interface BlankPreparation {
  native: ProfileBlankNative;
  navigation: AbortSignal;
  workspaceId: string;
  selectedId: string | null;
  revision: string | null;
  id: SessionId | null;
  reference: ReturnType<ProfileBlankNative["retain"]> | null;
  held: { blocks: ComposerBlocks; store: ReturnType<ComposerBlocks["storeFor"]>; block: ComposerBlock } | null;
  confirmed: boolean;
  opening: boolean;
  stop: () => void;
}
export const NEW_PROFILE_CONTENT = '{\n  "version": 1,\n  "id": "new-profile",\n  "label": "New profile",\n  "settings": {\n    // Runtime overlay only. Omitted fields inherit the deployment baseline.\n    "defaultActive": true\n  }\n}\n';

/** A valid external CAS conflict is reconcilable; corruption is never reset implicitly. */
export function canReconcileSelection(snapshot: ProfileSnapshot | null): boolean {
  return snapshot !== null && !snapshot.refreshRequired && writableSelectionVersion(snapshot.selectionRevision)
    && (snapshot.selectionError === undefined || snapshot.selectionError.code === "conflict");
}

/** Stable native Store seat, with no filesystem or transport authority. */
export class ProfilesController {
  private current: ProfilesViewSnapshot = { snapshot: null, editor: null, dirty: false, busy: null, issue: null, notice: null, pendingEditor: null,
    catalog: null, catalogBusy: false, catalogUnavailable: true, currentSessionId: null, sessionViewEpoch: 0, sessionUnconfirmed: false, sessionReadinessPending: false, session: null, sessionChoice: null, sessionWorkspaces: [], sessionWorkspaceId: null, sessionPreparationAvailable: false, sessionPreparationPending: false, sessionBusy: null, sessionIssue: null, sessionNotice: null, invalidFields: [], editorEpoch: 0, validationEpoch: 0 };
  private accepted: ProfileEditor | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  private sessionGeneration = 0;
  private blankNative: ProfileBlankNative | null = null;
  private stopWorkspaces: (() => void) | null = null;
  private preparation: BlankPreparation | null = null;
  private pendingSessionSelections = new Set<string>();
  private connection: ConnectionGenerationState | null = null;
  private connectionBaseline: ReturnType<ConnectionGenerationState["getSnapshot"]>;
  private connectionBound = false;
  private stopConnection: (() => void) | null = null;
  private composerBlocks: ComposerBlocks | null = null;
  private composerReason: (() => string) | null = null;
  private composerBlock: { id: SessionId; block: ComposerBlock; store: ReturnType<ComposerBlocks["storeFor"]> } | null = null;
  private catalogGeneration = 0;
  private catalogRemote: ModelCatalogRemote | null = null;
  private modelSelectorGeneration = 0;
  private modelSelector: ProfileModelSelectorRemote | null = null;
  private modelSelectionSource: HostObservable<unknown> | null = null;
  private modelSelectionSessionId: string | null = null;
  private modelSelectionGeneration = 0;
  private stopModelSelection: (() => void) | null = null;
  private modelEvents: SessionEventSource | null = null;
  private modelEventsSessionId: string | null = null;
  private modelEventsGeneration = 0;
  private modelEventsWatermark = -1;
  private modeEventsWatermark = -1;
  private modeRefreshPending = false;
  private sessionSource: HostObservable<SessionSnapshot> | null = null;
  private sessionSourceId: string | null = null;
  private sessionBinding: object | null = null;
  private agentAvailable: boolean | undefined;
  private availabilityEpoch = 0;
  private availabilityReadSucceeded = false;
  private initialSessionRead = true;
  private sessionReadIssue: ProfilesIssue | null = null;
  private readinessTimer: ReturnType<typeof setTimeout> | null = null;
  private stopSessionSource: (() => void) | null = null;
  private stopModelEvents: (() => void) | null = null;
  private modelInteraction: ModelInteractionSource | null = null;
  private modelInteractionSessionId: string | null = null;
  private modelInteractionGeneration = 0;
  private stopModelInteraction: (() => void) | null = null;
  readonly store = {
    getSnapshot: (): ProfilesViewSnapshot => this.current,
    subscribe: (listener: () => void): (() => void) => {
      this.listeners.add(listener);
      return () => { this.listeners.delete(listener); };
    },
  };
  readonly actions: ProfilesActions = {
    readProfileView: () => this.store.getSnapshot(),
    refresh: () => this.refresh(), open: (id) => this.open(id), create: () => this.open(NEW_EDITOR), reload: () => this.reload(),
    editId: (id) => this.editId(id), editContent: (content) => this.editContent(content),
    save: () => this.save(), apply: () => this.apply(), reset: () => this.reset(),
    discard: () => this.discard(),
    discardAndOpen: () => this.discardAndOpen(), cancelDiscard: () => this.publish({ pendingEditor: null }),
    editPath: (path, value) => this.editPath(path, value), moveFallback: (role, from, to) => this.editFallbackOrder(role, from, to),
    editRoute: (path, provider, model) => this.editRoute(path, provider, model),
    refreshCatalog: () => this.refreshCatalog(), refreshSession: () => this.refreshSession(),
    chooseSessionProfile: (id) => { if (!this.disposed && this.connectionCurrent() && !this.current.sessionUnconfirmed && this.current.sessionBusy === null && this.current.busy === null && !this.current.dirty && this.current.pendingEditor === null && this.current.invalidFields.length === 0) this.publish({ sessionChoice: id, sessionNotice: null }); },
    chooseSessionWorkspace: id => this.chooseSessionWorkspace(id),
    applySession: (options) => this.selectSession(false, options), resetSession: () => this.selectSession(true),
    setDeepwork: (active) => this.setDeepwork(active), useSessionProfileModel: () => this.selectSession(false, { useProfileModel: true }, true),
    setFieldInvalid: (field, invalid) => {
      if (this.disposed) return;
      const invalidFields = this.current.invalidFields.filter((candidate) => candidate !== field);
      if (invalid) invalidFields.push(field);
      if (invalidFields.join("\n") !== this.current.invalidFields.join("\n")) this.publish({ invalidFields, ...(invalid ? { dirty: true } : {}) });
    },
    setNumberDraft: (key, entry) => {
      if (this.disposed) return;
      if (entry === null) {
        this.numberDrafts.delete(key);
      } else {
        this.numberDrafts.set(key, entry);
      }
    },
    getNumberDraft: (key) => this.numberDrafts.get(key),
  };
  private numberDrafts = new Map<string, NumberDraftState>();
  constructor(private readonly remote: DsmmProfilesRemote) {}
  dispose(): void { this.endReadiness(); this.releasePreparation(); this.stopWorkspaces?.(); this.releaseComposerBlock(); this.numberDrafts.clear(); this.stopConnection?.(); this.stopSessionSource?.(); this.sessionSource = null; this.disposed = true; this.generation += 1; this.sessionGeneration += 1; this.catalogGeneration += 1; this.modelSelectorGeneration += 1; this.modelSelectionGeneration += 1; this.stopModelSelection?.(); this.stopModelEvents?.(); this.stopModelInteraction?.(); this.stopModelSelection = null; this.stopModelEvents = null; this.stopModelInteraction = null; this.modelSelectionSource = null; this.modelEvents = null; this.modelInteraction = null; this.catalogRemote = null; this.modelSelector = null; this.listeners.clear(); }
  bindConnection(source: ConnectionGenerationState | null): void {
    if (this.disposed) return;
    const replacement = this.connectionBound && (source !== this.connection || source?.getSnapshot() !== this.connectionBaseline);
    this.stopConnection?.();
    this.connection = source;
    this.connectionBound = true;
    this.connectionBaseline = source?.getSnapshot();
    const invalidate = () => {
      this.resetReadiness();
      this.releasePreparation();
      this.connectionBaseline = source?.getSnapshot();
      this.generation += 1;
      this.sessionGeneration += 1;
      this.modeRefreshPending = false;
      this.modelSelectorGeneration += 1;
      // A replaced connection only discards what it observed. It never records a
      // durable refusal for the session: an unread configuration is read again
      // by the next refresh, and typing stays available in the meantime.
      this.publish({ session: null, sessionBusy: null, sessionIssue: null, sessionNotice: null, sessionUnconfirmed: false,
        sessionViewEpoch: this.current.sessionViewEpoch + 1, sessionWorkspaceId: null, sessionPreparationPending: false, busy: null, issue: { kind: "transport", code: "unavailable" } });
    };
    if (replacement || source === null || this.connectionBaseline === undefined) invalidate();
    this.stopConnection = source?.subscribe(() => {
      invalidate();
      if (this.connectionCurrent()) void this.refresh();
    }) ?? null;
  }
  private connectionCurrent(): boolean {
    return !this.connectionBound || this.connectionBaseline !== undefined && this.connection?.getSnapshot() === this.connectionBaseline;
  }
  attachBlankNative(native: ProfileBlankNative | null): void {
    if (this.disposed) return;
    this.cancelPreparation();
    this.stopWorkspaces?.();
    this.blankNative = native;
    const update = () => {
      const sessionWorkspaces = native?.workspaces.getSnapshot() ?? [];
      const sessionWorkspaceId = sessionWorkspaces.some(item => item.id === this.current.sessionWorkspaceId) ? this.current.sessionWorkspaceId : null;
      if (this.preparation !== null && sessionWorkspaceId !== this.preparation.workspaceId) this.cancelPreparation();
      this.publish({ sessionWorkspaces, sessionWorkspaceId, sessionPreparationAvailable: native !== null && this.composerBlocks !== null });
    };
    this.stopWorkspaces = native?.workspaces.subscribe(update) ?? null;
    update();
  }
  private releasePreparation(): void {
    const task = this.preparation;
    this.preparation = null;
    if (task === null) return;
    task.stop();
    const held = task.held;
    if (held !== null && task.id !== null && held.blocks.storeFor(task.id) === held.store && held.store.getSnapshot() === held.block) held.blocks.set(task.id, undefined);
    task.reference?.release();
  }
  private cancelPreparation(): void {
    if (this.preparation === null) return;
    this.releasePreparation();
    this.sessionGeneration += 1;
    this.publish({ sessionBusy: null, sessionUnconfirmed: false, sessionPreparationPending: false, sessionNotice: null });
  }
  private async chooseSessionWorkspace(id: string): Promise<void> {
    if (this.disposed || !this.connectionCurrent() || this.current.currentSessionId !== null || !this.current.sessionWorkspaces.some(item => item.id === id)
      || this.current.dirty || this.current.invalidFields.length > 0 || this.current.pendingEditor !== null || this.current.busy !== null) return;
    const pending = this.current.sessionPreparationPending;
    if (id !== this.current.sessionWorkspaceId) this.cancelPreparation();
    this.publish({ sessionWorkspaceId: id, sessionIssue: null });
    if (pending) await this.prepareSession();
  }
  private preparationOwned(task: BlankPreparation): boolean {
    return !this.disposed && this.connectionCurrent() && this.preparation === task
      && this.current.currentSessionId === null && this.current.sessionWorkspaceId === task.workspaceId;
  }
  private preparationCurrent(task: BlankPreparation): boolean {
    return this.preparationOwned(task) && !task.navigation.aborted;
  }
  private preparationConfirmed(task: BlankPreparation, session: SessionProfileSnapshot): boolean {
    const selection = session.admittedSelection;
    return selection !== undefined && !selection.refreshRequired && session.sessionId === task.id && !session.refreshRequired && !session.selection.refreshRequired
      && writableSelectionVersion(session.selection.selectionRevision) && selection.selectedId === task.selectedId && selection.appliedRevision === task.revision
      && session.selection.selectedId === task.selectedId && session.selection.appliedRevision === task.revision;
  }
  private openPrepared(task: BlankPreparation, explicit = false): void {
    if (!this.preparationOwned(task) || !explicit && task.navigation.aborted || task.id === null || this.current.busy !== null || this.current.dirty || this.current.invalidFields.length > 0 || this.current.pendingEditor !== null) return;
    task.opening = true;
    try {
      this.publish({ sessionUnconfirmed: true });
      if (this.preparationOwned(task)) task.native.openSession(task.id);
    }
    finally { task.opening = false; }
  }
  private async prepareSession(refreshOnly = false): Promise<void> {
    const { sessionWorkspaceId: workspaceId, sessionChoice: selectedId, snapshot } = this.current;
    const native = this.blankNative;
    if (this.disposed || !this.connectionCurrent() || native === null || this.composerBlocks === null || this.composerReason === null
      || this.current.currentSessionId !== null || this.current.sessionBusy !== null || this.current.busy !== null
      || this.current.dirty || this.current.invalidFields.length > 0 || this.current.pendingEditor !== null || snapshot === null) return;
    if (workspaceId === null) { if (!refreshOnly) this.publish({ sessionPreparationPending: true }); return; }
    if (this.current.sessionUnconfirmed && !refreshOnly) return;
    const profile = snapshot.profiles.find(item => item.id === selectedId), revision = selectedId === null ? null : profile?.revision;
    if (!refreshOnly && selectedId !== null && (!isConfigRevision(revision) || profile?.error !== undefined)) return;
    let task = this.preparation;
    const openOnly = !refreshOnly && task?.confirmed === true && task.selectedId === selectedId && task.revision === (revision ?? null);
    if (task === null) {
      if (refreshOnly) return;
      const navigation = native.beginNavigation();
      task = { native, navigation, workspaceId, selectedId, revision: revision ?? null, id: null, reference: null, held: null, confirmed: false, opening: false, stop: () => {} };
      this.preparation = task;
    } else if (!refreshOnly && !openOnly) {
      task.selectedId = selectedId;
      task.revision = revision ?? null;
      task.confirmed = false;
    }
    if (!refreshOnly && !openOnly) {
      task.stop();
      if (task.navigation.aborted) task.navigation = native.beginNavigation();
      const navigation = task.navigation;
      const owned = task;
      const abort = () => { if (this.preparation === owned && !owned.opening) this.cancelPreparation(); };
      navigation.addEventListener("abort", abort, { once: true });
      task.stop = () => navigation.removeEventListener("abort", abort);
    }
    const owned = task;
    const live = () => refreshOnly ? this.preparationOwned(owned) : this.preparationCurrent(owned);
    this.publish({ sessionBusy: refreshOnly ? "read" : "apply", sessionPreparationPending: false, sessionIssue: null, sessionNotice: null });
    try {
      if (openOnly) { this.openPrepared(task, true); return; }
      if (!live()) return;
      if (task.id === null) {
        if (refreshOnly) throw { kind: "transport", code: "unavailable" };
        const id = await native.connectWorkspace(workspaceId);
        if (!live()) return;
        task.id = id;
      }
      const id = task.id;
      if (task.reference === null) {
        task.reference = native.retain(id);
        if (!live()) { task.reference.release(); return; }
        if (task.reference.sessionId !== id) throw { kind: "assembly", code: "unavailable" };
      }
      if (task.held === null) {
        // Occupy the empty native seat synchronously, before awaiting readiness.
        const blocks = this.composerBlocks, store = blocks.storeFor(id);
        if (store.getSnapshot() !== undefined) throw { kind: "domain", code: "busy" };
        const block = { reason: this.composerReason() };
        task.held = { blocks, store, block };
        blocks.set(id, block);
      }
      const binding = await task.reference.ready;
      if (!live()) return;
      if (binding.sessionId !== id) throw { kind: "assembly", code: "unavailable" };
      const session = await this.unwrap(this.remote.describeSession(id));
      if (!live()) return;
      if (session.sessionId !== id) throw { kind: "assembly", code: "unavailable" };
      if (refreshOnly) {
        task.confirmed = this.preparationConfirmed(task, session);
        if (task.confirmed) {
          this.publish({ sessionUnconfirmed: false });
          this.openPrepared(task);
          return;
        }
        const uncertain = session.refreshRequired === true || session.selection.refreshRequired === true;
        this.publish({ sessionUnconfirmed: uncertain, sessionIssue: { kind: "domain", code: uncertain ? "unavailable" : "conflict" } });
        return;
      }
      if (session.refreshRequired || session.selection.refreshRequired || !writableSelectionVersion(session.selection.selectionRevision)) throw { kind: "domain", code: "conflict" };
      if (session.canApplyOverlay !== true || session.applyOverlayUnavailableReason === "new-session-required") throw { kind: "domain", code: session.applyOverlayUnavailableReason ?? "unavailable" };
      const held = task.held;
      if (held === null || held.blocks.storeFor(id) !== held.store || held.store.getSnapshot() !== held.block) throw { kind: "domain", code: "busy" };
      if (this.current.dirty || this.current.invalidFields.length > 0 || this.current.pendingEditor !== null) throw { kind: "domain", code: "conflict" };
      this.pendingSessionSelections.add(id);
      const accepted = await this.unwrap(this.remote.selectSession(id, { sessionId: id, id: task.selectedId,
        ...(task.selectedId === null ? {} : { expectedRevision: task.revision! }), expectedSelectionRevision: session.selection.selectionRevision, expectedAdmissionEpoch: session.admissionEpoch }));
      if (!live()) return;
      if (!this.preparationConfirmed(task, accepted)) {
        this.publish({ sessionUnconfirmed: true });
        return;
      }
      task.confirmed = true;
      this.openPrepared(task);
    } catch (error) {
      if (this.preparationOwned(task)) {
        const issue = this.issue(error), uncertain = task.confirmed || issue.kind !== "domain" || issue.code === "cancelled";
        this.publish({ sessionIssue: task.id === null && uncertain ? { kind: "assembly", code: "blank-identity-unconfirmed" } : issue, sessionUnconfirmed: uncertain });
        // A definite pre-commit refusal needs no task-owned send block or retain.
        if (!uncertain) this.releasePreparation();
      }
    } finally {
      if (task.id !== null) this.pendingSessionSelections.delete(task.id);
      if (this.preparationOwned(task)) this.publish({ sessionBusy: null });
      else if (!this.disposed && this.current.currentSessionId === null && this.preparation === null) this.publish({ sessionBusy: null });
      else if (!this.disposed && this.connectionCurrent() && task.id === this.current.currentSessionId) { this.modeRefreshPending = true; this.refreshObservedMode(); }
    }
  }
  attachComposerBlocks(blocks: ComposerBlocks | null, reason?: () => string): void {
    if (this.disposed) return;
    if (blocks !== this.composerBlocks && this.preparation !== null) this.cancelPreparation();
    this.releaseComposerBlock();
    this.composerBlocks = blocks;
    this.composerReason = reason ?? null;
    this.publish({ sessionPreparationAvailable: this.blankNative !== null && blocks !== null });
  }
  private releaseComposerBlock(): void {
    const held = this.composerBlock;
    this.composerBlock = null;
    // Native blocks have no owner token. Only release the exact object and
    // store we installed into an empty seat; never forget or clear another owner.
    if (held !== null && this.composerBlocks?.storeFor(held.id) === held.store && held.store.getSnapshot() === held.block) this.composerBlocks.set(held.id, undefined);
  }
  private syncComposerBlock(): void {
    const { currentSessionId, sessionBusy, sessionUnconfirmed, session } = this.current;
    const wanted = currentSessionId !== null && (sessionBusy === "apply" || sessionBusy === "reset" || sessionUnconfirmed || session?.refreshRequired || session?.selection.refreshRequired);
    if (!wanted || this.composerBlock?.id !== currentSessionId) this.releaseComposerBlock();
    if (!wanted || this.composerBlock !== null || this.composerBlocks === null || this.composerReason === null) return;
    const id = currentSessionId as SessionId, store = this.composerBlocks.storeFor(id);
    if (store.getSnapshot() !== undefined) return;
    const block = { reason: this.composerReason() };
    this.composerBlock = { id, store, block };
    this.composerBlocks.set(id, block);
  }
  attachModelSelector(remote: ProfileModelSelectorRemote | null): void {
    if (this.disposed) return;
    this.modelSelectorGeneration += 1;
    this.modelSelector = remote;
  }
  attachModelSelectionSource(sessionId: string | null, source: HostObservable<unknown> | null): void {
    if (this.disposed || (sessionId === this.modelSelectionSessionId && source === this.modelSelectionSource)) return;
    this.modelSelectionGeneration += 1;
    this.stopModelSelection?.();
    this.modelSelectionSessionId = sessionId;
    this.modelSelectionSource = source;
    this.stopModelSelection = source?.subscribe(() => { this.modelSelectionGeneration += 1; }) ?? null;
  }
  attachSessionSource(sessionId: string | null, source: HostObservable<SessionSnapshot> | null, binding: object | null = source): void {
    if (this.disposed || sessionId === this.sessionSourceId && source === this.sessionSource && binding === this.sessionBinding) return;
    this.resetReadiness();
    this.stopSessionSource?.();
    this.sessionSourceId = sessionId;
    this.sessionSource = source;
    this.sessionBinding = binding;
    let running = source?.getSnapshot().running;
    const current = () => !this.disposed && sessionId !== null && sessionId === this.current.currentSessionId && source === this.sessionSource && binding === this.sessionBinding;
    this.stopSessionSource = source?.subscribe(() => {
      if (!current()) return;
      if (this.connectionCurrent() && this.sessionSourceFailed()) return;
      const next = source.getSnapshot().running;
      if (next === running) return;
      running = next;
      if (!this.connectionCurrent()) return;
      // Running is an invalidation signal, never permission to apply an overlay.
      this.modeRefreshPending = true;
      this.refreshObservedMode();
    }) ?? null;
    if (current()) {
      this.sessionGeneration += 1;
      this.modeRefreshPending = source !== null;
      this.publish({ session: null, sessionBusy: null, sessionIssue: null, sessionNotice: null, sessionViewEpoch: this.current.sessionViewEpoch + 1,
        sessionUnconfirmed: this.pendingSessionSelections.has(sessionId!) });
      this.refreshObservedMode();
    }
  }
  private endReadiness(): void {
    if (this.readinessTimer !== null) clearTimeout(this.readinessTimer);
    this.readinessTimer = null;
    if (this.current.sessionReadinessPending) this.publish({ sessionReadinessPending: false });
  }
  private resetReadiness(): void {
    this.endReadiness();
    this.agentAvailable = undefined;
    this.availabilityEpoch += 1;
    this.availabilityReadSucceeded = false;
    this.initialSessionRead = true;
    this.sessionReadIssue = null;
  }
  private sessionSourceFailed(): boolean {
    const source = this.sessionSource?.getSnapshot();
    if (source === undefined || !source.removed && source.openError === null) return false;
    this.endReadiness();
    this.initialSessionRead = false;
    this.availabilityEpoch += 1;
    this.availabilityReadSucceeded = false;
    this.sessionGeneration += 1;
    this.modeRefreshPending = false;
    const issue: ProfilesIssue = source.removed ? { kind: "domain", code: "disposed", field: "sessionId" }
      : { kind: "transport", code: source.openError!.code };
    this.sessionReadIssue = issue;
    const { currentSessionId: id, session, sessionUnconfirmed } = this.current;
    this.publish({ session: null, sessionBusy: null, sessionIssue: issue,
      sessionUnconfirmed: sessionUnconfirmed || id !== null && this.pendingSessionSelections.has(id)
        || session?.refreshRequired === true || session?.selection.refreshRequired === true });
    return true;
  }
  observeSessionAvailability(id: string, source: HostObservable<SessionSnapshot>, available: boolean): void {
    if (this.disposed || !this.connectionCurrent() || id !== this.current.currentSessionId || id !== this.sessionSourceId || source !== this.sessionSource || this.sessionSourceFailed()) return;
    const changed = available !== this.agentAvailable;
    this.agentAvailable = available;
    if (!available) {
      this.availabilityEpoch += 1;
      this.availabilityReadSucceeded = false;
      return;
    }
    if (changed || !this.availabilityReadSucceeded) {
      this.modeRefreshPending = true;
      this.refreshObservedMode();
    }
  }
  attachModelEventSource(sessionId: string | null, source: SessionEventSource | null): void {
    if (this.disposed || (sessionId === this.modelEventsSessionId && source === this.modelEvents)) return;
    this.modelEventsGeneration += 1;
    this.stopModelEvents?.();
    this.modelEventsSessionId = sessionId;
    this.modelEvents = source;
    this.modelEventsWatermark = source === null ? -1 : modelSelectionWatermark(source.getSnapshot());
    this.modeEventsWatermark = source === null ? -1 : modeIntentWatermark(source.getSnapshot());
    this.stopModelEvents = source?.subscribe(() => {
      const window = source.getSnapshot(), change = window.change;
      if (change.kind === "settle-assistant") return;
      let watermark = change.kind === "replace" ? -1 : this.modelEventsWatermark;
      for (const entry of change.entries) if (entry.type === "event" && entry.event.type === "model/selection") watermark = Math.max(watermark, Number(entry.event.seq));
      if (watermark !== this.modelEventsWatermark) { this.modelEventsWatermark = watermark; this.modelEventsGeneration += 1; }
      let modeWatermark = change.kind === "replace" ? -1 : this.modeEventsWatermark;
      for (const entry of change.entries) if (entry.type === "event" && (entry.event.type === "deepwork/mode" || entry.event.type === "agent-preset/selected")) modeWatermark = Math.max(modeWatermark, Number(entry.event.seq));
      if (modeWatermark !== this.modeEventsWatermark) {
        this.modeEventsWatermark = modeWatermark;
        if (sessionId === this.current.currentSessionId) { this.modeRefreshPending = true; this.refreshObservedMode(); }
      }
    }) ?? null;
  }
  attachModelInteractionSource(sessionId: string | null, source: ModelInteractionSource | null): void {
    if (this.disposed || (sessionId === this.modelInteractionSessionId && source === this.modelInteraction)) return;
    this.modelInteractionGeneration += 1;
    this.stopModelInteraction?.();
    this.modelInteractionSessionId = sessionId;
    this.modelInteraction = source;
    this.stopModelInteraction = source?.subscribe(() => { if (source.getSnapshot().status === "selecting") this.modelInteractionGeneration += 1; }) ?? null;
  }
  attachCatalog(remote: ModelCatalogRemote | null): void {
    if (this.disposed) return;
    this.catalogGeneration += 1;
    this.catalogRemote = remote;
    this.publish({ catalogBusy: false, catalogUnavailable: remote === null });
    if (remote !== null) void this.refreshCatalog();
  }
  setSession(id: string | null): void {
    if (this.disposed || id === this.current.currentSessionId) return;
    this.resetReadiness();
    const task = this.preparation;
    const preparationUnconfirmed = task?.id === id && this.current.sessionUnconfirmed;
    if (task?.id === id && task.held !== null && id !== null) {
      // The native current binding has retained this exact target. Transfer our
      // block to the ordinary current-session lifecycle without an empty seat.
      this.composerBlock = { id: id as SessionId, store: task.held.store, block: task.held.block };
      task.held = null;
    }
    this.releasePreparation();
    this.sessionGeneration += 1;
    this.modeRefreshPending = false;
    if (id !== this.sessionSourceId) this.attachSessionSource(null, null);
    if (id !== this.modelSelectionSessionId) this.attachModelSelectionSource(null, null);
    if (id !== this.modelEventsSessionId) this.attachModelEventSource(null, null);
    if (id !== this.modelInteractionSessionId) this.attachModelInteractionSource(null, null);
    this.publish({ currentSessionId: id, sessionViewEpoch: this.current.sessionViewEpoch + 1, sessionPreparationPending: false, sessionUnconfirmed: id !== null && (preparationUnconfirmed || this.pendingSessionSelections.has(id)), session: null, sessionChoice: null, sessionBusy: null, sessionIssue: null, sessionNotice: null });
    if (id !== null) void this.refreshSession();
  }
  async refreshCatalog(): Promise<void> {
    if (this.disposed || this.current.catalogBusy || this.catalogRemote === null) return;
    const remote = this.catalogRemote, generation = ++this.catalogGeneration;
    this.publish({ catalogBusy: true });
    try {
      const catalog = await this.unwrap(remote.modelCatalog());
      if (!this.disposed && generation === this.catalogGeneration) this.publish({ catalog, catalogUnavailable: false });
    } catch {
      if (!this.disposed && generation === this.catalogGeneration) this.publish({ catalogUnavailable: true });
    } finally { if (!this.disposed && generation === this.catalogGeneration) this.publish({ catalogBusy: false }); }
  }
  private refreshObservedMode(): void {
    if (!this.disposed && this.modeRefreshPending && this.current.sessionBusy === null) void this.refreshSession(true);
  }
  async refreshSession(preserveFeedback = false): Promise<void> {
    const id = this.current.currentSessionId;
    if (id === null && this.preparation !== null) { await this.prepareSession(true); return; }
    if (this.disposed || !this.connectionCurrent() || id === null || this.current.sessionBusy !== null || this.sessionSourceId === id && this.sessionSource === null) return;
    if (this.sessionSourceFailed()) return;
    const initial = this.initialSessionRead;
    const availabilityEpoch = this.availabilityEpoch;
    this.initialSessionRead = false;
    this.modeRefreshPending = false;
    const generation = ++this.sessionGeneration;
    const live = () => !this.disposed && this.connectionCurrent() && generation === this.sessionGeneration && id === this.current.currentSessionId;
    this.publish({ sessionBusy: "read" });
    try {
      const session = await this.unwrap(this.remote.describeSession(id));
      if (session.sessionId !== id) throw { kind: "assembly", code: "unavailable" };
      if (live()) {
        if (availabilityEpoch === this.availabilityEpoch && this.agentAvailable !== false) this.availabilityReadSucceeded = true;
        this.endReadiness();
        this.publish({ session, sessionChoice: (session.admittedSelection ?? session.selection).selectedId, sessionUnconfirmed: this.pendingSessionSelections.has(id),
          ...(this.current.sessionIssue === this.sessionReadIssue ? { sessionIssue: null } : {}) });
        this.sessionReadIssue = null;
      }
    } catch (error) { if (live()) {
      const issue = this.issue(error);
      const waiting = (initial || this.current.sessionReadinessPending) && this.sessionSourceId === id && this.sessionSource !== null && this.current.session === null
        && this.sessionSource.getSnapshot().sessionId === id
        && issue.kind === "domain" && issue.code === "unavailable" && issue.field === "sessionId";
      if (!waiting) this.endReadiness();
      if (!preserveFeedback || this.current.sessionIssue === null || this.current.sessionIssue === this.sessionReadIssue) this.publish({ sessionIssue: issue });
      this.sessionReadIssue = issue;
      if (waiting && this.readinessTimer === null) {
        const source = this.sessionSource, connection = this.connectionBaseline;
        const timer = setTimeout(() => {
          if (this.readinessTimer !== timer || this.disposed || source !== this.sessionSource || id !== this.current.currentSessionId || connection !== this.connectionBaseline) return;
          this.readinessTimer = null;
          this.publish({ sessionReadinessPending: false });
        }, 10_000);
        this.readinessTimer = timer;
        this.publish({ sessionReadinessPending: true });
      }
    } }
    finally { if (live()) { this.publish({ sessionBusy: null }); this.refreshObservedMode(); } }
  }
  private async setDeepwork(active: boolean): Promise<void> {
    const { currentSessionId: id, session } = this.current;
    if (this.disposed || !this.connectionCurrent() || this.current.sessionUnconfirmed || id === null || session?.deepwork === undefined || session.refreshRequired || session.selection.refreshRequired || session.deepwork.locked || session.canToggleMode !== true
      || this.current.sessionBusy !== null || this.current.busy !== null || this.remote.selectMode === undefined) return;
    const generation = ++this.sessionGeneration;
    const live = () => !this.disposed && this.connectionCurrent() && generation === this.sessionGeneration && id === this.current.currentSessionId;
    this.publish({ sessionBusy: "mode", sessionIssue: null, sessionNotice: null });
    try {
      if (!live()) return;
      const accepted = await this.unwrap(this.remote.selectMode(id, { sessionId: id, active,
        expectedModeRevision: session.deepwork.revision, expectedAdmissionEpoch: session.admissionEpoch }));
      if (accepted.sessionId !== id || accepted.deepwork?.active !== active || !accepted.deepwork.explicit) throw { kind: "assembly", code: "unavailable" };
      if (live()) this.publish({ session: accepted, sessionNotice: active ? "mode-on" : "mode-off" });
    } catch (error) { if (live()) {
      const issue = this.issue(error);
      if (["busy", "maintenance", "conflict"].includes(issue.code)) this.modeRefreshPending = true;
      this.publish({ sessionIssue: issue });
    } }
    finally { if (live()) { this.publish({ sessionBusy: null }); this.refreshObservedMode(); }
      else if (!this.disposed && this.connectionCurrent() && id === this.current.currentSessionId) {
        this.modeRefreshPending = true;
        this.refreshObservedMode();
      }
    }
  }
  private async selectSession(reset: boolean, options?: SessionApplyOptions, modelOnly = false): Promise<void> {
    const { currentSessionId: id, session, sessionChoice, snapshot } = this.current;
    if (id === null && !reset && !modelOnly && options?.useProfileModel !== true) { await this.prepareSession(); return; }
    if (this.disposed || !this.connectionCurrent() || this.current.sessionUnconfirmed || id === null || session === null || session.refreshRequired || session.selection.refreshRequired || !writableSelectionVersion(session.selection.selectionRevision)
      || (modelOnly ? session.canSelectModel !== true : session.canApplyOverlay !== true || session.applyOverlayUnavailableReason === "new-session-required") || this.current.sessionBusy !== null
      || this.current.busy !== null || this.current.dirty || this.current.invalidFields.length > 0 || this.current.pendingEditor !== null) return;
    const selectedId = reset ? null : sessionChoice;
    const profile = snapshot?.profiles.find((profile) => profile.id === selectedId), revision = profile?.revision;
    if (!modelOnly && selectedId !== null && (!isConfigRevision(revision) || profile?.error !== undefined)) return;
    const generation = ++this.sessionGeneration;
    const useProfileModel = !reset && options?.useProfileModel === true;
    const selector = this.modelSelector, selectorGeneration = this.modelSelectorGeneration;
    const modelSource = this.modelSelectionSource, modelGeneration = this.modelSelectionGeneration;
    const modelSnapshot = modelSource?.getSnapshot();
    const eventSource = this.modelEvents, eventGeneration = this.modelEventsGeneration;
    const eventWatermark = eventSource === null ? -1 : modelSelectionWatermark(eventSource.getSnapshot());
    const modeWatermark = eventSource === null ? -1 : modeIntentWatermark(eventSource.getSnapshot());
    const interaction = this.modelInteraction, interactionGeneration = this.modelInteractionGeneration;
    const pendingNativeChoice = interaction?.getSnapshot().status === "selecting";
    const live = () => !this.disposed && this.connectionCurrent() && generation === this.sessionGeneration && id === this.current.currentSessionId;
    const selectorLive = () => live() && selector !== null && selector === this.modelSelector && selectorGeneration === this.modelSelectorGeneration;
    if (!modelOnly) this.pendingSessionSelections.add(id);
    this.publish({ sessionBusy: reset ? "reset" : "apply", sessionIssue: null, sessionNotice: null });
    try {
      if (!live()) return;
      const accepted = await this.unwrap(modelOnly ? this.remote.describeSession(id) : this.remote.selectSession(id, {
        sessionId: id, id: selectedId, ...(selectedId === null ? {} : { expectedRevision: revision! }),
        expectedSelectionRevision: session.selection.selectionRevision, expectedAdmissionEpoch: session.admissionEpoch,
      }));
      if (accepted.sessionId !== id) throw { kind: "assembly", code: "unavailable" };
      if (modelOnly && (accepted.admissionEpoch !== session.admissionEpoch || accepted.deepwork?.revision !== session.deepwork?.revision)) throw { kind: "domain", code: "conflict" };
      if (!live()) return;
      this.publish({ session: accepted, sessionChoice: (accepted.admittedSelection ?? accepted.selection).selectedId,
        sessionNotice: useProfileModel || accepted.refreshRequired || accepted.selection.refreshRequired ? null : reset ? "reset" : "applied" });
      if (!useProfileModel || accepted.refreshRequired || accepted.selection.refreshRequired || !live()) return;
      if (accepted.canSelectModel !== true || !writableSelectionVersion(accepted.selection.selectionRevision)) {
        this.publish({ sessionIssue: { kind: "assembly", code: accepted.selectModelUnavailableReason ?? "unavailable", source: "profile-model" } });
        return;
      }
      if (accepted.profileModel === undefined) {
        this.publish({ sessionIssue: { kind: "assembly", code: "model-unconfigured", source: "profile-model" } });
        return;
      }
      if (!selectorLive()) {
        this.publish({ sessionIssue: { kind: "assembly", code: "model-service-unavailable", source: "profile-model" } });
        return;
      }
      if (modelSource === null || modelSnapshot === undefined || this.modelSelectionSessionId !== id || modelSource !== this.modelSelectionSource || modelSource.getSnapshot() === undefined) {
        this.publish({ sessionIssue: { kind: "assembly", code: "model-observation-unavailable", source: "profile-model" } });
        return;
      }
      // Projection fences cover observed view changes, including a frame whose
      // notification has not fired. The raw sequence fence below covers deduped intent.
      if (modelGeneration !== this.modelSelectionGeneration || !Object.is(modelSnapshot, modelSource.getSnapshot())) {
        this.publish({ sessionIssue: { kind: "assembly", code: "model-choice-changed", source: "profile-model" } });
        return;
      }
      if (eventSource === null || eventSource !== this.modelEvents || this.modelEventsSessionId !== id
        || interaction === null || interaction !== this.modelInteraction || this.modelInteractionSessionId !== id) {
        this.publish({ sessionIssue: { kind: "assembly", code: "model-observation-unavailable", source: "profile-model" } });
        return;
      }
      if (eventGeneration !== this.modelEventsGeneration || eventWatermark !== modelSelectionWatermark(eventSource.getSnapshot())
        || (modelOnly && modeWatermark !== modeIntentWatermark(eventSource.getSnapshot()))
        || interactionGeneration !== this.modelInteractionGeneration || pendingNativeChoice || interaction.getSnapshot().status === "selecting") {
        this.publish({ sessionIssue: { kind: "assembly", code: "model-choice-changed", source: "profile-model" } });
        return;
      }
      try {
        // The accepted DTO and current native view have the same validated ID;
        // native strict codecs remain authoritative for its branded wire type.
        const { provider, model, reasoningEffort } = accepted.profileModel;
        await this.unwrap(selector!.selectModel({ sessionId: id as SessionSelectModelRequest["sessionId"], provider, model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }));
        // Never echo the returned model locally: native projections own the
        // actual picker, and a later native Models-tab selection must win.
        if (live()) this.publish(selectorLive() && modelSource === this.modelSelectionSource && this.modelSelectionSessionId === id ? { sessionNotice: "applied-with-model" }
          : { sessionIssue: { kind: "assembly", code: "model-service-unavailable", source: "profile-model" } });
      } catch {
        if (live()) this.publish({ sessionIssue: { kind: "assembly", code: selectorLive() ? "model-selection-failed" : "model-service-unavailable", source: "profile-model" } });
      }
    } catch (error) { if (live()) {
      const issue = this.issue(error);
      if (["busy", "maintenance", "conflict"].includes(issue.code)) this.modeRefreshPending = true;
      this.publish({ sessionIssue: issue, sessionUnconfirmed: !modelOnly && (issue.kind !== "domain" || issue.code === "cancelled") });
    } }
    finally {
      if (!modelOnly) this.pendingSessionSelections.delete(id);
      if (live()) { this.publish({ sessionBusy: null }); this.refreshObservedMode(); }
      else if (!modelOnly && !this.disposed && this.connectionCurrent() && id === this.current.currentSessionId) {
        this.modeRefreshPending = true;
        this.refreshObservedMode();
      }
    }
  }
  private publish(patch: Partial<ProfilesViewSnapshot>): void {
    if (this.disposed) return;
    this.current = { ...this.current, ...patch };
    this.syncComposerBlock();
    for (const listener of this.listeners) listener();
  }
  private accept(document: ProfileEditor): void {
    this.numberDrafts.clear();
    this.accepted = { ...document };
    this.publish({ editor: { ...document }, dirty: false, pendingEditor: null, invalidFields: [], editorEpoch: this.current.editorEpoch + 1 });
  }
  private async unwrap<T>(request: Promise<RemoteResult<T>>, field?: string): Promise<T> {
    const result = await request;
    if (result.ok) return result.value;
    if (result.error.code === "dsmm-profiles/refused") {
      throw safeIssue(result.error.details);
    }
    if (["gateway/input-invalid", "gateway/arguments-invalid"].includes(String(result.error.code))) {
      throw { kind: "domain", code: "validation", field, message: "The native Host rejected a request field. Check the profile ID and document size before retrying." } satisfies ProfilesIssue;
    }
    throw { kind: "transport", code: result.error.code } satisfies ProfilesIssue;
  }
  private issue(error: unknown): ProfilesIssue {
    if (typeof error === "object" && error !== null && "kind" in error && (error.kind === "domain" || error.kind === "transport")) return error as ProfilesIssue;
    return { kind: "assembly", code: "unavailable" };
  }
  private async perform(busy: NonNullable<ProfilesViewSnapshot["busy"]>, operation: (live: () => boolean) => Promise<void>): Promise<void> {
    if (this.disposed || !this.connectionCurrent() || this.current.busy !== null || this.current.sessionBusy === "apply" || this.current.sessionBusy === "reset" || this.current.pendingEditor !== null) return;
    const generation = ++this.generation;
    const live = (): boolean => !this.disposed && this.connectionCurrent() && generation === this.generation;
    this.publish({ busy, issue: null, notice: null });
    try { await operation(live); }
    catch (error) { if (live()) {
      const issue = this.issue(error);
      this.publish({ issue, ...(busy === "save" && issue.kind === "domain" && issue.code === "validation" ? { validationEpoch: this.current.validationEpoch + 1 } : {}) });
    } }
    finally { if (live()) this.publish({ busy: null }); }
  }
  async refresh(): Promise<void> {
    const session = this.refreshSession();
    await Promise.all([session, this.perform("refresh", async (live) => {
      const snapshot = await this.unwrap(this.remote.describe());
      if (live()) this.publish({ snapshot });
    })]);
  }
  async open(id: string): Promise<void> {
    if (this.disposed || this.current.busy !== null || this.current.pendingEditor !== null) return;
    if (id !== NEW_EDITOR && this.current.editor?.id === id) return;
    if (this.current.dirty || this.current.invalidFields.length > 0) { this.publish({ pendingEditor: id }); return; }
    await this.loadEditor(id);
  }
  async reload(): Promise<void> {
    const editor = this.current.editor;
    if (editor === null || editor.revision === null || this.current.busy !== null || this.current.pendingEditor !== null) return;
    if (this.current.dirty || this.current.invalidFields.length > 0) { this.publish({ pendingEditor: editor.id }); return; }
    await this.loadEditor(editor.id);
  }
  discard(): void {
    const editor = this.current.editor;
    if (this.disposed || editor === null || this.current.busy !== null || this.current.pendingEditor !== null) return;
    if (!this.current.dirty && this.current.invalidFields.length === 0) return;
    this.publish({ pendingEditor: editor.revision === null ? NEW_EDITOR : editor.id });
  }
  private async loadEditor(id: string): Promise<void> {
    if (id === NEW_EDITOR) {
      this.numberDrafts.clear();
      this.accepted = null;
      this.publish({ editor: { id: "new-profile", content: NEW_PROFILE_CONTENT, revision: null }, dirty: true, issue: null, notice: null, pendingEditor: null, invalidFields: [], editorEpoch: this.current.editorEpoch + 1 });
      return;
    }
    await this.perform("read", async (live) => {
      const document = await this.unwrap(this.remote.read(id), "id");
      if (live()) this.accept(document);
    });
  }
  async discardAndOpen(): Promise<void> {
    const wanted = this.current.pendingEditor;
    if (wanted === null || this.current.busy !== null) return;
    this.publish({ pendingEditor: null });
    await this.loadEditor(wanted);
  }
  private editId(id: string): void {
    const editor = this.current.editor;
    if (editor === null || editor.revision !== null || this.current.busy !== null || this.current.pendingEditor !== null) return;
    const content = editStructuredPath(editor.content, ["id"], id);
    if (content === null) { this.publish({ issue: { kind: "domain", code: "validation", field: "content" }, notice: null }); return; }
    this.publish({ editor: { ...editor, id, content }, dirty: true, issue: null, notice: null });
  }
  private editContent(content: string): void {
    const editor = this.current.editor;
    if (editor === null || editor.refreshRequired || this.current.busy !== null || this.current.pendingEditor !== null) return;
    const document = structuredDocument(content);
    let invalidFields = this.current.invalidFields;
    if (document !== null) {
      for (const [key, draft] of this.numberDrafts) {
        let value: unknown = document;
        for (const segment of key.split(".")) {
          value = value !== null && typeof value === "object" && Object.hasOwn(value, segment) ? (value as Record<string, unknown>)[segment] : undefined;
        }
        if (value !== draft.sourceValue) {
          this.numberDrafts.delete(key);
          invalidFields = invalidFields.filter(field => field !== key);
        }
      }
    }
    this.publish({ editor: { ...editor, content }, invalidFields, dirty: this.accepted === null || this.accepted.content !== content || this.accepted.id !== editor.id, issue: null, notice: null });
  }
  private editPath(path: JsonPath, value: unknown): void {
    const editor = this.current.editor;
    if (editor === null || editor.refreshRequired || this.current.busy !== null || this.current.pendingEditor !== null) return;
    const content = editStructuredPath(editor.content, path, value);
    if (content === null) { this.publish({ issue: { kind: "domain", code: "validation", field: "content" }, notice: null }); return; }
    this.editContent(content);
  }
  private editRoute(path: JsonPath, provider: string, model: string): void {
    const editor = this.current.editor;
    if (editor === null || editor.refreshRequired || this.current.busy !== null || this.current.pendingEditor !== null) return;
    let content: string | null = editor.content;
    for (const [key, value] of [["provider", provider], ["model", model], ["reasoningEffort", undefined]] as const) {
      content = editStructuredPath(content, [...path, key], value);
      if (content === null) { this.publish({ issue: { kind: "domain", code: "validation", field: "content" }, notice: null }); return; }
    }
    this.editContent(content);
  }
  private editFallbackOrder(role: string, from: number, to: number): void {
    const editor = this.current.editor;
    if (editor === null || editor.refreshRequired || this.current.busy !== null || this.current.pendingEditor !== null) return;
    const content = moveFallback(editor.content, role, from, to);
    if (content !== null) this.editContent(content);
  }
  async save(): Promise<void> {
    const editor = this.current.editor;
    if (editor === null || editor.refreshRequired || editor.revision !== null && !isConfigRevision(editor.revision) || !this.current.dirty || this.current.snapshot === null || this.current.busy !== null || this.current.pendingEditor !== null || this.current.invalidFields.length > 0) return;
    if (!isProfileId(editor.id)) {
      this.publish({ issue: { kind: "domain", code: "validation", field: "id" }, notice: null, validationEpoch: this.current.validationEpoch + 1 });
      return;
    }
    await this.perform("save", async (live) => {
      const document = await this.unwrap(this.remote.save({ id: editor.id, content: editor.content, expectedRevision: editor.revision }), "content");
      if (!live()) return;
      this.accept(document);
      // The accepted response proves save; applying remains a separate commit.
      const old = this.current.snapshot!;
      const profiles = old.profiles.filter((item) => item.id !== document.id);
      profiles.push({ id: document.id, revision: document.revision, ...(document.label === undefined ? {} : { label: document.label }), ...(document.warnings === undefined ? {} : { warnings: document.warnings }) });
      profiles.sort((a, b) => a.id.localeCompare(b.id));
      this.publish({ snapshot: { ...old, profiles }, notice: { key: "saved", id: document.id } });
    });
  }
  async apply(): Promise<void> {
    const { editor, snapshot, dirty, invalidFields } = this.current;
    if (editor?.refreshRequired || !isConfigRevision(editor?.revision) || !canReconcileSelection(snapshot) || dirty || invalidFields.length > 0) return;
    await this.perform("apply", async (live) => {
      const accepted = await this.unwrap(this.remote.select({ id: editor.id, expectedRevision: editor.revision!, expectedSelectionRevision: snapshot!.selectionRevision }));
      if (live()) this.acceptSelection(accepted, { key: "applied", id: accepted.selectedId ?? undefined });
    });
  }
  async reset(): Promise<void> {
    const snapshot = this.current.snapshot;
    if (!canReconcileSelection(snapshot)) return;
    await this.perform("reset", async (live) => {
      const accepted = await this.unwrap(this.remote.select({ id: null, expectedSelectionRevision: snapshot!.selectionRevision }));
      if (live()) this.acceptSelection(accepted, { key: "reset" });
    });
  }
  private acceptSelection(snapshot: ProfileSnapshot, notice: ProfilesNotice): void {
    this.publish({ snapshot, notice: snapshot.selectionError === undefined ? notice : null,
      issue: snapshot.selectionError === undefined ? null : { ...safeIssue(snapshot.selectionError), source: "selection" } });
  }
}

export type { ProfileErrorInfo, ProfileReadResult };
