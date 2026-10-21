import type { PermissionControlSettings } from "../permission-settings.js";
import type { PermissionRuleDraft, PermissionRulesSaveRequest, PermissionRulesSaveResult } from "../permission-rules.js";
import { PermissionClientError } from "./permission-client.js";
import type { PermissionInvoker, PermissionIssue } from "./permission-client.js";

export interface PermissionDraft {
  outsideReads: PermissionControlSettings["outsideReads"];
  webSearch: PermissionControlSettings["webSearch"];
  webFetch: PermissionControlSettings["webFetch"];
  upsert: readonly PermissionRuleDraft[];
  revoke: readonly string[];
  editor: PermissionRuleDraft | null;
}
export interface PermissionView {
  generation: number;
  sessionId: string | null;
  scope: "unknown" | "root" | "child";
  connected: boolean;
  /** Visible first load or explicit refresh only; background revalidation never sets it. */
  reading: boolean;
  /** Silent background revalidation of an already trusted snapshot; not a busy state. */
  revalidating: boolean;
  busy: "save" | null;
  /** Current-fence authority observation; only a fresh successful read/save may set it. */
  rules: PermissionRulesSaveResult | null;
  /**
   * Last successful observation kept for display across a same-session scope gap,
   * owner rebind or connection change. Never a base or mutation authority.
   */
  display: PermissionRulesSaveResult | null;
  /** Last observed C state; only a successful clean read/save may become the mutation baseline. */
  base: PermissionRulesSaveResult["snapshot"] | null;
  draft: PermissionDraft | null;
  rulesIssue: PermissionIssue | null;
  dirty: boolean;
  notice: "saved" | null;
}
const draftOf = (policy: PermissionControlSettings): PermissionDraft => ({ outsideReads: policy.outsideReads, webSearch: { ...policy.webSearch }, webFetch: { ...policy.webFetch }, upsert: [], revoke: [], editor: null });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export function permissionChanges(view: PermissionView): PermissionRulesSaveRequest | null {
  const { base, draft } = view;
  if (base === null || draft === null) return null;
  const changes = Object.fromEntries((["outsideReads", "webSearch", "webFetch"] as const).filter(key => !same(base.policy[key], draft[key])).map(key => [key, draft[key]]));
  if (Object.keys(changes).length === 0 && draft.upsert.length === 0 && draft.revoke.length === 0) return null;
  return { expectedRevision: base.revision, ...(Object.keys(changes).length ? { changes } : {}), ...(draft.upsert.length ? { upsert: draft.upsert } : {}), ...(draft.revoke.length ? { revoke: draft.revoke } : {}) };
}
const empty = (): PermissionView => ({ generation: 0, sessionId: null, scope: "unknown", connected: false, reading: false, revalidating: false, busy: null,
  rules: null, display: null, base: null, draft: null, rulesIssue: null, dirty: false, notice: null });
/** Policy, records, coverage and runtime may render from this observation; authority stays in `rules`. */
export const observedRules = (view: PermissionView): PermissionRulesSaveResult | null => view.rules ?? view.display;
/** The projection is older than the current fence and the current policy is unconfirmed. */
export const displayUnconfirmed = (view: PermissionView): boolean => view.display !== null && view.rules === null;

/** Borrowed native selection plus last-observed C state; never a Root or policy authority. */
export class PermissionController {
  private state = empty();
  private listeners = new Set<() => void>();
  private invoke: PermissionInvoker | null = null;
  private connection: unknown;
  private owner: object | null = null;
  private request = new AbortController();
  private requestSequence = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private watchers = 0;
  private disposed = false;
  /** A successful read/save exists for the current scope fence; not mutation authority. */
  private observed = false;
  readonly store = { getSnapshot: (): PermissionView => this.state, subscribe: (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; } };
  private publish(patch: Partial<PermissionView>): void { if (this.disposed) return; this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private cancel(): void { this.request.abort(); this.request = new AbortController(); this.requestSequence++; clearTimeout(this.timer); }
  /** An observed snapshot exists for this fence; background work must stay invisible until it changes what is possible. */
  private trusted(): boolean { return this.observed; }
  private fence(preserveDraft: boolean, preserveBase = preserveDraft, preserveDisplay = true): void {
    this.cancel();
    this.observed = false;
    this.publish({ generation: this.state.generation + 1, reading: false, revalidating: false, busy: null, notice: null, rules: null, rulesIssue: null,
      ...preserveDisplay ? {} : { display: null }, ...preserveDraft ? {} : { draft: null, dirty: false }, ...preserveBase ? {} : { base: null } });
  }
  bindConnection(invoke: PermissionInvoker | null, generation?: unknown): void {
    if (this.disposed || this.invoke === invoke && this.connection === generation) return;
    this.invoke = invoke; this.connection = generation; this.fence(true); this.publish({ connected: invoke !== null }); this.schedule();
  }
  bindScope(sessionId: string | null, owner: object | null, scope: PermissionView["scope"]): void {
    if (this.disposed || this.state.sessionId === sessionId && this.owner === owner && this.state.scope === scope) return;
    const sameSession = sessionId !== null && sessionId === this.state.sessionId;
    this.owner = owner;
    // A replaced owner invalidates the old base even when the session ID is unchanged;
    // only the draft and the read-only display projection may survive for explicit recovery.
    this.fence(sameSession, false, sameSession);
    this.publish({ sessionId, scope }); this.schedule();
  }
  watch(): () => void {
    this.watchers++; if (this.watchers === 1) this.schedule();
    let active = true;
    return () => { if (!active) return; active = false; this.watchers--; if (this.watchers === 0) this.fence(true); };
  }
  dispose(): void { if (this.disposed) return; this.fence(false, false, false); this.disposed = true; this.listeners.clear(); this.invoke = null; this.owner = null; }
  private live(generation: number): boolean { return !this.disposed && generation === this.state.generation && this.owner !== null && this.invoke !== null && this.state.scope === "root" && this.state.sessionId !== null; }
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.watchers === 0 || !this.live(this.state.generation)) return;
    this.timer = setTimeout(() => { void this.revalidate(this.state.generation); }, 0);
    this.timer.unref?.();
  }
  private issue(error: unknown): PermissionIssue { return error instanceof PermissionClientError ? error.code : "transport"; }
  private synchronized(): boolean {
    const value = this.state.rules;
    return value !== null && value.runtime.state === "synced" && value.runtime.savedRevision === value.snapshot.revision && value.runtime.runtimeRevision === value.snapshot.revision;
  }
  /** A background request in flight never disables editing or saving; only its own save/authority does. */
  canEdit(generation: number): boolean { return this.live(generation) && this.state.rulesIssue === null && this.synchronized() && this.state.busy === null; }
  canSave(generation: number): boolean { return this.canEdit(generation) && this.state.dirty && this.state.draft?.editor === null; }
  /** User-triggered refresh: visible busy state on this transaction only. */
  async refresh(generation: number, discard = false): Promise<void> { await this.load(generation, discard, false); }
  /** Watch-driven revalidation. Invisible once a trusted snapshot exists. */
  private async revalidate(generation: number): Promise<void> { await this.load(generation, false, true); }
  private async load(generation: number, discard: boolean, background: boolean): Promise<void> {
    if (!this.live(generation) || this.state.busy !== null || this.state.reading) return;
    if (background && this.state.revalidating) return;
    // A user-triggered refresh upgrades an in-flight silent read into its visible own request.
    if (!background && this.state.revalidating) this.cancel();
    // An automatic read over an existing display projection is silent; a first load stays visible.
    const visible = !background || !this.trusted() && this.state.display === null;
    const sequence = ++this.requestSequence, signal = this.request.signal, id = this.state.sessionId!;
    this.publish(visible ? { reading: true, revalidating: false } : { revalidating: true });
    try {
      const value = await this.invoke!("describeRules", [id], signal);
      if (!this.live(generation) || signal.aborted || sequence !== this.requestSequence) return;
      this.observed = true;
      const retain = this.state.dirty && !discard;
      this.publish({ rules: value, display: value, rulesIssue: retain && this.state.base?.revision !== value.snapshot.revision ? "stale" : null,
        ...retain ? {} : { base: value.snapshot, draft: draftOf(value.snapshot.policy), dirty: false } });
    } catch (error) {
      if (!this.live(generation) || signal.aborted || sequence !== this.requestSequence) return;
      // Keep the last trusted projection (current or display-only) visible; only its mutation authority is withdrawn.
      this.publish({ rulesIssue: this.issue(error) });
    } finally {
      if (this.live(generation) && sequence === this.requestSequence) this.publish({ reading: false, revalidating: false });
    }
  }
  edit(generation: number, patch: Partial<PermissionDraft>): void {
    if (!this.canEdit(generation) || this.state.draft === null) return;
    const draft = { ...this.state.draft, ...patch };
    this.publish({ draft, notice: null }); this.publish({ dirty: draft.editor !== null || permissionChanges(this.state) !== null });
  }
  stageRule(generation: number): void {
    const draft = this.state.draft, editor = draft?.editor;
    if (editor == null || !editor.id || editor.id.length > 256 || editor.id.includes("\0")) return;
    const match = editor.match;
    if (match.kind === "outside-read" && !match.path || match.kind === "shell" && (!match.executable || !match.command || !match.workingDirectory)) return;
    this.edit(generation, { upsert: [...draft!.upsert.filter(row => row.id !== editor.id), structuredClone(editor)], revoke: draft!.revoke.filter(id => id !== editor.id), editor: null });
  }
  stageRevoke(generation: number, id: string): void {
    const draft = this.state.draft;
    if (draft === null || !this.state.base?.policy.rules.some(rule => rule.id === id)) return;
    this.edit(generation, { upsert: draft.upsert.filter(row => row.id !== id), revoke: [...new Set([...draft.revoke, id])], editor: draft.editor?.id === id ? null : draft.editor });
  }
  private begin(busy: NonNullable<PermissionView["busy"]>): { signal: AbortSignal; id: string } {
    // Invalidate and abort unfinished reads so a late response cannot overwrite the save result.
    this.cancel();
    this.publish({ busy, reading: false, revalidating: false, notice: null });
    return { signal: this.request.signal, id: this.state.sessionId! };
  }
  async save(generation: number): Promise<void> {
    const request = permissionChanges(this.state);
    if (!this.canSave(generation) || request === null) return;
    const current = this.begin("save");
    try {
      const result = await this.invoke!("saveRules", [current.id, request], current.signal);
      if (this.live(generation)) { this.observed = true; this.publish({ rules: result, display: result, base: result.snapshot, draft: draftOf(result.snapshot.policy), dirty: false, rulesIssue: null, notice: "saved" }); }
    } catch (error) { if (this.live(generation)) this.publish({ rulesIssue: this.issue(error) }); }
    finally { if (this.live(generation)) this.publish({ busy: null }); }
  }
}
