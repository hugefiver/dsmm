import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { ConfigFormSnapshot, ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { ConnectionGenerationState } from "@deepseek-ai/dsh-client-connection/client";
import type { DsmmConfigRemote } from "../profile-remote.js";
import type { DeploymentEditorSnapshot, SessionProfileSnapshot } from "../profile-types.js";
import type { DeploymentPathEdit } from "../deployment-config.js";
import type { RouteJson as JsonValue } from "../route-json.js";
import { equal, editLayer, layerDiff, mergeLayer, record, scopeSchema, validateEditorValue } from "./deployment-data.js";

export type DeploymentIssue = "unavailable" | "not-owned" | "conflict" | "validation" | "transport" | "unconfirmed";
export interface DeploymentView {
  snapshot: DeploymentEditorSnapshot | null;
  draft: Record<string, unknown>;
  dirty: boolean;
  busy: boolean;
  issue: DeploymentIssue | null;
  saved: boolean;
  session: SessionProfileSnapshot | null;
  raw: Readonly<Record<string, { text: string; invalid: boolean }>>;
  invalidFields: readonly string[];
  refreshRequired: boolean;
}
export interface NativePageForm {
  state: ConfigFormSnapshot<Record<string, unknown>>;
  mutate: ConfigForm<Record<string, unknown>>["mutate"];
}
class Refusal extends Error { constructor(readonly code: DeploymentIssue) { super(code); } }
/** Native wire shape only; schema semantics remain independently validated. */
function isNativeJson(value: unknown, active = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || active.has(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  active.add(value);
  const properties = Object.getOwnPropertyDescriptors(value);
  const valid = Object.entries(properties).every(([key, descriptor]) => array && key === "length" || descriptor.enumerable
    && Object.hasOwn(descriptor, "value") && (!array || /^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length)
    && isNativeJson(descriptor.value, active));
  active.delete(value);
  return valid && (!array || Object.keys(properties).length === value.length + 1);
}
function nativePathEdit(edit: DeploymentPathEdit): Parameters<NativePageForm["mutate"]>[0][number] {
  if (edit.op === "unset") return edit;
  if (!isNativeJson(edit.value)) throw new Refusal("validation");
  return { op: "set", path: edit.path, value: edit.value };
}
async function unwrap<T>(promise: Promise<RemoteResult<T>>): Promise<T> {
  const result = await promise;
  if (result.ok) return result.value;
  if (result.error.code === "dsmm-profiles/refused") {
    const code = result.error.details.code;
    throw new Refusal(["conflict", "validation", "not-owned"].includes(code) ? code as DeploymentIssue : "unavailable");
  }
  throw new Refusal("transport");
}

/** Drafts and CAS baselines, never a second configuration authority. */
export class DeploymentController {
  private state: DeploymentView = { snapshot: null, draft: {}, dirty: false, busy: false, issue: null, saved: false, session: null, raw: {}, invalidFields: [], refreshRequired: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  private baseline: Record<string, unknown> = {};
  private form: NativePageForm | null = null;
  private invalid = new Set<string>();
  private connection: ConnectionGenerationState | null = null;
  private connectionBaseline: unknown;
  private stopConnection: (() => void) | null = null;
  private children = new Set<DeploymentController>();
  constructor(private readonly remote: DsmmConfigRemote, readonly layer: "global" | "profile", readonly rowNamespace: string | null = null) {}
  readonly getSnapshot = (): DeploymentView => this.state;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  dispose(): void { this.disposed = true; this.generation++; this.stopConnection?.(); this.listeners.clear(); this.form = null; }
  bindConnection(source: ConnectionGenerationState): void {
    this.stopConnection?.(); this.connection = source;
    for (const child of this.children) child.bindConnection(source);
    this.stopConnection = source.subscribe(() => {
      if (this.disposed) return;
      this.generation++;
      this.publish({ busy: false, issue: source.getSnapshot() === undefined ? "transport" : "conflict", saved: false });
    });
  }
  forProfile(namespace: string): DeploymentController {
    const controller = new DeploymentController(this.remote, "profile", namespace);
    if (this.connection !== null) controller.bindConnection(this.connection);
    this.children.add(controller);
    return controller;
  }
  private currentConnection(): boolean { return this.connection === null || this.connection.getSnapshot() !== undefined && this.connection.getSnapshot() === this.connectionBaseline; }
  setSession(session: SessionProfileSnapshot | null): void { this.publish({ session }); }
  private publish(patch: Partial<DeploymentView>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener();
  }
  attachForm(form: NativePageForm | null): void { this.form = form; }
  setInvalid(path: string, invalid: boolean): void {
    if (this.invalid.has(path) === invalid) return;
    if (invalid) this.invalid.add(path); else this.invalid.delete(path);
    this.publish({ invalidFields: [...this.invalid], dirty: this.invalid.size > 0 || !equal(this.baseline, this.state.draft), saved: false });
  }
  setRaw(path: string, text: string, invalid: boolean): void {
    if (!this.canEdit()) return;
    this.publish({ raw: { ...this.state.raw, [path]: { text, invalid } } });
    this.setInvalid(path, invalid);
  }
  clearRaw(prefix: string): void {
    if (!this.canEdit()) return;
    const raw = Object.fromEntries(Object.entries(this.state.raw).filter(([path]) => path !== prefix && !path.startsWith(`${prefix}.`)));
    for (const path of [...this.invalid]) if (path === prefix || path.startsWith(`${prefix}.`)) this.invalid.delete(path);
    this.publish({ raw, invalidFields: [...this.invalid], dirty: this.invalid.size > 0 || !equal(this.baseline, this.state.draft) });
  }
  canEdit(): boolean { return !this.disposed && !this.state.busy && !this.state.refreshRequired && this.state.snapshot !== null && this.state.snapshot.globalRevision !== "unavailable" && (this.layer === "global" || this.state.snapshot.nativeRevision !== "unavailable") && this.currentConnection() && (this.state.issue === null || this.state.issue === "validation") && (this.layer === "global" || this.canWriteProfile()); }
  canSave(): boolean { return this.canEdit() && this.state.issue === null && this.state.dirty && this.invalid.size === 0; }
  pendingPaths(): readonly string[] { return [...new Set([...layerDiff(this.baseline, this.state.draft).map(edit => edit.path.join(".")), ...this.invalid])]; }
  canWriteProfile(snapshot = this.state.snapshot): boolean {
    const native = this.form?.state;
    return this.currentConnection() && snapshot !== null && this.rowNamespace !== null && this.rowNamespace === snapshot.namespace
      && native?.status === "ready" && native.writable
      && native.revision === snapshot.nativeFormRevision && snapshot.nativeForm !== null
      && equal(native.base ?? null, snapshot.nativeForm.base) && equal(native.user ?? null, snapshot.nativeForm.user);
  }
  edit(path: readonly string[], value: unknown): void {
    if (!this.canEdit()) return;
    const draft = editLayer(this.state.draft, path, value);
    this.publish({ draft, dirty: this.invalid.size > 0 || !equal(this.baseline, draft), issue: null, saved: false });
  }
  async refresh(discard = false): Promise<void> {
    if (this.disposed || this.state.busy) return;
    const generation = ++this.generation;
    const connection = this.connection?.getSnapshot();
    this.publish({ busy: true, saved: false });
    try {
      if (this.connection !== null && connection === undefined) throw new Refusal("transport");
      const snapshot = await unwrap(this.remote.describeSettings());
      if (this.disposed || generation !== this.generation) return;
      if (snapshot.globalRevision === "unavailable" || this.layer === "profile" && snapshot.nativeRevision === "unavailable") throw new Refusal("unavailable");
      const old = this.state.snapshot;
      if (old !== null && (old.entryId !== snapshot.entryId || old.hostProfileKey !== snapshot.hostProfileKey)) throw new Refusal("unavailable");
      if (this.state.dirty && !discard) {
        const stale = !this.currentConnection() || (this.layer === "global" ? old?.globalRevision !== snapshot.globalRevision : old?.nativeRevision !== snapshot.nativeRevision || old?.globalRevision !== snapshot.globalRevision);
        this.publish({ issue: stale ? "conflict" : null });
      } else {
        this.invalid.clear();
        this.connectionBaseline = connection;
        this.baseline = this.layer === "global" ? snapshot.global : record(snapshot.nativeForm?.user) ? snapshot.nativeForm.user : {};
        this.publish({ snapshot, draft: structuredClone(this.baseline), raw: {}, invalidFields: [], dirty: false, issue: null, refreshRequired: false });
      }
    } catch (error) { if (!this.disposed && generation === this.generation) this.publish({ issue: error instanceof Refusal ? error.code : "transport" }); }
    finally { if (!this.disposed && generation === this.generation) this.publish({ busy: false }); }
  }
  async save(): Promise<void> {
    const { snapshot, draft, dirty, busy, issue } = this.state;
    if (!this.canSave() || snapshot === null || !dirty || busy || issue !== null) return;
    if (snapshot.globalRevision === "unavailable" || this.layer === "profile" && snapshot.nativeRevision === "unavailable") { this.publish({ issue: "unavailable" }); return; }
    const selectedSchema = scopeSchema(snapshot, this.layer);
    const schema = { ...selectedSchema, fields: Object.fromEntries(Object.entries(selectedSchema.fields ?? {}).filter(([key]) => key !== (this.layer === "global" ? "runtime" : "modules"))) };
    const mergedSchema = { ...snapshot.schema, fields: { ...snapshot.schema.fields, ...snapshot.nativeSchema?.fields } };
    const editable = { ...draft };
    const lower = this.layer === "global" ? snapshot.defaults : mergeLayer(mergeLayer(snapshot.defaults, snapshot.global), snapshot.nativeForm?.base ?? {});
    const candidate = mergeLayer(lower, editable);
    const merged = (this.layer === "global" ? mergeLayer(candidate, snapshot.profile) : candidate) as Record<string, unknown>;
    if (!validateEditorValue(editable, schema, true) || !validateEditorValue(merged, mergedSchema)) { this.publish({ issue: "validation" }); return; }
    const edits = layerDiff(this.baseline, draft);
    if (edits.length > 128) { this.publish({ issue: "validation" }); return; }
    const generation = ++this.generation;
    this.publish({ busy: true, saved: false });
    try {
      const current = await unwrap(this.remote.describeSettings());
      if (this.disposed || generation !== this.generation) return;
      if (current.entryId !== snapshot.entryId || current.hostProfileKey !== snapshot.hostProfileKey || current.globalRevision !== snapshot.globalRevision) throw new Refusal("conflict");
      let acceptedRefreshRequired = false;
      if (this.layer === "global") { const accepted = await unwrap(this.remote.save({ expectedRevision: snapshot.globalRevision, edits })); acceptedRefreshRequired = accepted.refreshRequired === true || accepted.revision === "unavailable"; }
      else {
        if (current.nativeRevision !== snapshot.nativeRevision || !this.canWriteProfile(current)) throw new Refusal("conflict");
        const form = this.form!;
        if (!await form.mutate(edits.map(nativePathEdit), snapshot.nativeFormRevision!)) throw new Refusal("unconfirmed");
      }
      if (this.disposed || generation !== this.generation) return;
      this.baseline = structuredClone(draft);
      this.invalid.clear();
      this.publish({ dirty: false, saved: true, issue: null, raw: {}, invalidFields: [], refreshRequired: true });
      // A successful durable save remains successful even if the follow-up read fails.
      if (acceptedRefreshRequired) return;
      try {
        const next = await unwrap(this.remote.describeSettings());
        if (!this.disposed && generation === this.generation) {
          if (next.entryId !== snapshot.entryId || next.hostProfileKey !== snapshot.hostProfileKey || next.globalRevision === "unavailable" || this.layer === "profile" && next.nativeRevision === "unavailable") this.publish({ refreshRequired: true });
          else {
            this.baseline = structuredClone(this.layer === "global" ? next.global : record(next.nativeForm?.user) ? next.nativeForm.user : {});
            this.publish({ snapshot: next, draft: structuredClone(this.baseline), refreshRequired: false });
          }
        }
      } catch { if (!this.disposed && generation === this.generation) this.publish({ refreshRequired: true }); }
    } catch (error) { if (!this.disposed && generation === this.generation) this.publish({ issue: error instanceof Refusal ? error.code : "transport" }); }
    finally { if (!this.disposed && generation === this.generation) this.publish({ busy: false }); }
  }
}
