import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { ConnectionGenerationState } from "@deepseek-ai/dsh-client-connection/client";
import type { ComposerBlock, ComposerBlocks } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionEventSource, SessionEventWindow } from "@deepseek-ai/dsh-api-session-controller/client";
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
import { editStructuredPath, moveFallback } from "./structured.js";
import type { JsonPath } from "./structured.js";

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
  session: SessionProfileSnapshot | null;
  sessionChoice: string | null;
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
  discardAndOpen(): Promise<void>;
  cancelDiscard(): void;
  editPath(path: JsonPath, value: unknown): void;
  editRoute(path: JsonPath, provider: string, model: string): void;
  moveFallback(role: string, from: number, to: number): void;
  refreshCatalog(): Promise<void>;
  refreshSession(): Promise<void>;
  chooseSessionProfile(id: string | null): void;
  applySession(options?: SessionApplyOptions): Promise<void>;
  resetSession(): Promise<void>;
  setDeepwork(active: boolean): Promise<void>;
  useSessionProfileModel(): Promise<void>;
  setFieldInvalid(field: string, invalid: boolean): void;
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
export const NEW_PROFILE_CONTENT = '{\n  "version": 1,\n  "id": "new-profile",\n  "label": "New profile",\n  "settings": {\n    // Runtime overlay only. Omitted fields inherit the deployment baseline.\n    "defaultActive": true\n  }\n}\n';

/** A valid external CAS conflict is reconcilable; corruption is never reset implicitly. */
export function canReconcileSelection(snapshot: ProfileSnapshot | null): boolean {
  return snapshot !== null && !snapshot.refreshRequired && writableSelectionVersion(snapshot.selectionRevision)
    && (snapshot.selectionError === undefined || snapshot.selectionError.code === "conflict");
}

/** Stable native Store seat, with no filesystem or transport authority. */
export class ProfilesController {
  private current: ProfilesViewSnapshot = { snapshot: null, editor: null, dirty: false, busy: null, issue: null, notice: null, pendingEditor: null,
    catalog: null, catalogBusy: false, catalogUnavailable: true, currentSessionId: null, sessionViewEpoch: 0, sessionUnconfirmed: false, session: null, sessionChoice: null, sessionBusy: null, sessionIssue: null, sessionNotice: null, invalidFields: [], editorEpoch: 0, validationEpoch: 0 };
  private accepted: ProfileEditor | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  private sessionGeneration = 0;
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
    discardAndOpen: () => this.discardAndOpen(), cancelDiscard: () => this.publish({ pendingEditor: null }),
    editPath: (path, value) => this.editPath(path, value), moveFallback: (role, from, to) => this.editFallbackOrder(role, from, to),
    editRoute: (path, provider, model) => this.editRoute(path, provider, model),
    refreshCatalog: () => this.refreshCatalog(), refreshSession: () => this.refreshSession(),
    chooseSessionProfile: (id) => { if (!this.disposed && this.connectionCurrent() && !this.current.sessionUnconfirmed && this.current.sessionBusy === null && this.current.busy === null && !this.current.dirty && this.current.pendingEditor === null && this.current.invalidFields.length === 0) this.publish({ sessionChoice: id, sessionNotice: null }); },
    applySession: (options) => this.selectSession(false, options), resetSession: () => this.selectSession(true),
    setDeepwork: (active) => this.setDeepwork(active), useSessionProfileModel: () => this.selectSession(false, { useProfileModel: true }, true),
    setFieldInvalid: (field, invalid) => {
      if (this.disposed) return;
      const invalidFields = this.current.invalidFields.filter((candidate) => candidate !== field);
      if (invalid) invalidFields.push(field);
      if (invalidFields.join("\n") !== this.current.invalidFields.join("\n")) this.publish({ invalidFields, ...(invalid ? { dirty: true } : {}) });
    },
  };
  constructor(private readonly remote: DsmmProfilesRemote) {}
  dispose(): void { this.releaseComposerBlock(); this.stopConnection?.(); this.disposed = true; this.generation += 1; this.sessionGeneration += 1; this.catalogGeneration += 1; this.modelSelectorGeneration += 1; this.modelSelectionGeneration += 1; this.stopModelSelection?.(); this.stopModelEvents?.(); this.stopModelInteraction?.(); this.stopModelSelection = null; this.stopModelEvents = null; this.stopModelInteraction = null; this.modelSelectionSource = null; this.modelEvents = null; this.modelInteraction = null; this.catalogRemote = null; this.modelSelector = null; this.listeners.clear(); }
  bindConnection(source: ConnectionGenerationState | null): void {
    if (this.disposed) return;
    const replacement = this.connectionBound && (source !== this.connection || source?.getSnapshot() !== this.connectionBaseline);
    this.stopConnection?.();
    this.connection = source;
    this.connectionBound = true;
    this.connectionBaseline = source?.getSnapshot();
    const invalidate = () => {
      this.connectionBaseline = source?.getSnapshot();
      this.generation += 1;
      this.sessionGeneration += 1;
      this.modelSelectorGeneration += 1;
      // A replaced connection only discards what it observed. It never records a
      // durable refusal for the session: an unread configuration is read again
      // by the next refresh, and typing stays available in the meantime.
      this.publish({ session: null, sessionBusy: null, sessionNotice: null, sessionUnconfirmed: false,
        sessionViewEpoch: this.current.sessionViewEpoch + 1, busy: null, issue: { kind: "transport", code: "unavailable" } });
    };
    if (replacement || source === null || this.connectionBaseline === undefined) invalidate();
    this.stopConnection = source?.subscribe(() => {
      invalidate();
      if (this.connectionCurrent()) { void this.refresh(); void this.refreshSession(); }
    }) ?? null;
  }
  private connectionCurrent(): boolean {
    return !this.connectionBound || this.connectionBaseline !== undefined && this.connection?.getSnapshot() === this.connectionBaseline;
  }
  attachComposerBlocks(blocks: ComposerBlocks | null, reason?: () => string): void {
    if (this.disposed) return;
    this.releaseComposerBlock();
    this.composerBlocks = blocks;
    this.composerReason = reason ?? null;
    this.syncComposerBlock();
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
    this.sessionGeneration += 1;
    this.modeRefreshPending = false;
    if (id !== this.modelSelectionSessionId) this.attachModelSelectionSource(null, null);
    if (id !== this.modelEventsSessionId) this.attachModelEventSource(null, null);
    if (id !== this.modelInteractionSessionId) this.attachModelInteractionSource(null, null);
    this.publish({ currentSessionId: id, sessionViewEpoch: this.current.sessionViewEpoch + 1, sessionUnconfirmed: id !== null && this.pendingSessionSelections.has(id), session: null, sessionChoice: null, sessionBusy: null, sessionIssue: null, sessionNotice: null });
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
    if (this.disposed || !this.connectionCurrent() || id === null || this.current.sessionBusy !== null) return;
    this.modeRefreshPending = false;
    const generation = ++this.sessionGeneration;
    const live = () => !this.disposed && this.connectionCurrent() && generation === this.sessionGeneration && id === this.current.currentSessionId;
    this.publish({ sessionBusy: "read", ...(preserveFeedback ? {} : { sessionIssue: null, sessionNotice: null }) });
    try {
      const session = await this.unwrap(this.remote.describeSession(id));
      if (session.sessionId !== id) throw { kind: "assembly", code: "unavailable" };
      if (live()) this.publish({ session, sessionChoice: (session.admittedSelection ?? session.selection).selectedId, sessionUnconfirmed: this.pendingSessionSelections.has(id) });
    } catch (error) { if (live()) this.publish({ sessionIssue: this.issue(error) }); }
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
    } catch (error) { if (live()) this.publish({ sessionIssue: this.issue(error) }); }
    finally { if (live()) { this.publish({ sessionBusy: null }); this.refreshObservedMode(); } }
  }
  private async selectSession(reset: boolean, options?: SessionApplyOptions, modelOnly = false): Promise<void> {
    const { currentSessionId: id, session, sessionChoice, snapshot } = this.current;
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
    await this.perform("refresh", async (live) => {
      const snapshot = await this.unwrap(this.remote.describe());
      if (live()) this.publish({ snapshot });
    });
  }
  async open(id: string): Promise<void> {
    if (this.disposed || this.current.busy !== null || this.current.pendingEditor !== null) return;
    if (id !== NEW_EDITOR && this.current.editor?.id === id) return;
    if (this.current.dirty) { this.publish({ pendingEditor: id }); return; }
    await this.loadEditor(id);
  }
  async reload(): Promise<void> {
    const editor = this.current.editor;
    if (editor === null || editor.revision === null || this.current.busy !== null || this.current.pendingEditor !== null) return;
    if (this.current.dirty) { this.publish({ pendingEditor: editor.id }); return; }
    await this.loadEditor(editor.id);
  }
  private async loadEditor(id: string): Promise<void> {
    if (id === NEW_EDITOR) {
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
    // Only explicit confirmation clears a draft; a failed read restores it.
    const previous = this.current.editor;
    const accepted = this.accepted;
    await this.loadEditor(wanted);
    if (this.current.issue !== null && previous !== null) {
      this.accepted = accepted;
      this.publish({ editor: previous, dirty: true });
    }
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
    this.publish({ editor: { ...editor, content }, dirty: this.accepted === null || this.accepted.content !== content || this.accepted.id !== editor.id, issue: null, notice: null });
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
    const { editor, snapshot, dirty } = this.current;
    if (editor?.refreshRequired || !isConfigRevision(editor?.revision) || !canReconcileSelection(snapshot) || dirty) return;
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
