import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import { ROLE_CONTROL_REMOTE, parseChildSessionSnapshot, parseRoleControlDescendants, parseRoleControlErrorInfo, parseRoleControlPromptRequest } from "../role-control-remote.js";
import type { DsmmChildrenRemote } from "../role-control-remote.js";
import type { ChildSessionSnapshot, RoleControlAvailability, RoleControlChildView, RoleControlDescendantsSnapshot, RoleControlErrorInfo, SubagentInterruptReceipt, SubagentPromptReceipt, SubagentPromptRequest } from "../role-control-types.js";

export interface ChildrenIssue extends Partial<RoleControlErrorInfo> { kind: "domain" | "transport" | "protocol" | "local"; code: RoleControlErrorInfo["code"]; unknown?: boolean }
export type ChildImage = Extract<SubagentPromptRequest["content"][number], { type: "image" }>;
export interface ChildDraft { text: string; delivery: "queue" | "steer"; images: readonly ChildImage[]; imageBusy: boolean; uncertain: boolean }
export type ChildOutcome = { kind: "prompt"; receipt: SubagentPromptReceipt } | { kind: "interrupt"; receipt: SubagentInterruptReceipt };
export interface ChildrenSnapshot {
  sessionId: string | null;
  generation: number;
  snapshot: ChildSessionSnapshot | null;
  descendants: RoleControlDescendantsSnapshot | null;
  fresh: boolean;
  reading: boolean;
  issue: ChildrenIssue | null;
  descendantIssue: ChildrenIssue | null;
  drafts: ReadonlyMap<string, ChildDraft>;
  pending: ReadonlyMap<string, "prompt" | "interrupt">;
  issues: ReadonlyMap<string, ChildrenIssue>;
  outcomes: ReadonlyMap<string, ChildOutcome>;
}
export interface ChildrenActions {
  refresh(generation: number): Promise<void>;
  prompt(generation: number, childId: string): Promise<void>;
  interrupt(generation: number, childId: string): Promise<void>;
  editText(generation: number, childId: string, text: string): void;
  setDelivery(generation: number, childId: string, delivery: "queue" | "steer"): void;
  addImages(generation: number, childId: string, files: readonly File[]): Promise<void>;
  removeImage(generation: number, childId: string, image: ChildImage): void;
  acknowledgeUnknown(generation: number, childId: string): void;
}
export const EMPTY_CHILD_DRAFT: ChildDraft = { text: "", delivery: "queue", images: [], imageBusy: false, uncertain: false };
export const childActionKey = (childId: string): string => `child:${childId}`;
export function enabled(availability: RoleControlAvailability | undefined): boolean { return availability?.enabled === true; }
class ControlFailure extends Error { constructor(readonly safe: ChildrenIssue) { super("Child control refused."); } }

/** Client presentation/draft state only. Host owns all run, inbox and admission authority. */
export class ChildrenController {
  private current: ChildrenSnapshot = { sessionId: null, generation: 0, snapshot: null, descendants: null, fresh: false, reading: false,
    issue: null, descendantIssue: null, drafts: new Map(), pending: new Map(), issues: new Map(), outcomes: new Map() };
  private owner: object | null = null;
  private connection: object | null = null;
  private connectionGeneration: unknown;
  private observedAdmission: string | null = null;
  private disposed = false;
  private listeners = new Set<() => void>();
  readonly store = {
    getSnapshot: (): ChildrenSnapshot => this.current,
    subscribe: (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; },
  };
  readonly actions: ChildrenActions = {
    refresh: generation => this.refresh(generation),
    prompt: (generation, child) => this.prompt(generation, child), interrupt: (generation, child) => this.interrupt(generation, child),
    editText: (generation, child, text) => this.editDraft(generation, child, { text }),
    setDelivery: (generation, child, delivery) => this.editDraft(generation, child, { delivery }),
    addImages: (generation, child, files) => this.addImages(generation, child, files),
    removeImage: (generation, child, image) => { const draft = this.draft(child); if (!draft.imageBusy) this.editDraft(generation, child, { images: draft.images.filter(part => part !== image) }); },
    acknowledgeUnknown: (generation, child) => { if (this.available(generation)) this.editDraft(generation, child, { uncertain: false }); },
  };
  constructor(private readonly remote: DsmmChildrenRemote) {}
  dispose(): void { if (this.disposed) return; this.owner = null; this.connection = null; this.fence(false); this.disposed = true; this.listeners.clear(); }
  bindConnection(connection: object | null, generation?: unknown): void {
    if (this.disposed || connection === this.connection && generation === this.connectionGeneration) return;
    this.connection = connection; this.connectionGeneration = generation; this.fence(true);
    if (connection !== null) void this.refresh(this.current.generation);
  }
  bindScope(sessionId: string | null, owner: object | null): void {
    if (this.disposed || sessionId === this.current.sessionId && owner === this.owner) return;
    this.owner = owner; this.observedAdmission = null; this.fence(false, sessionId);
    if (sessionId !== null && owner !== null) void this.refresh(this.current.generation);
  }
  observeAdmission(sessionId: string, epoch: string): void {
    if (this.disposed || sessionId !== this.current.sessionId || epoch === this.observedAdmission) return;
    this.observedAdmission = epoch;
    if (this.current.snapshot?.admissionEpoch === epoch) return;
    this.fence(true); void this.refresh(this.current.generation);
  }
  private publish(patch: Partial<ChildrenSnapshot>): void {
    if (this.disposed) return;
    this.current = { ...this.current, ...patch }; for (const listener of this.listeners) listener();
  }
  private fence(preserveDrafts: boolean, sessionId = this.current.sessionId): void {
    const drafts = new Map<string, ChildDraft>();
    if (preserveDrafts) for (const [id, draft] of this.current.drafts) drafts.set(id, { ...draft, imageBusy: false,
      uncertain: draft.uncertain || this.current.pending.get(childActionKey(id)) === "prompt" });
    this.publish({ sessionId, generation: this.current.generation + 1, snapshot: preserveDrafts ? this.current.snapshot : null,
      fresh: false, descendants: null, reading: false, drafts, pending: new Map(), issues: new Map(), outcomes: new Map(), issue: null, descendantIssue: null });
  }
  private live(generation: number): boolean { return !this.disposed && generation === this.current.generation && this.owner !== null && this.connection !== null && this.current.sessionId !== null; }
  private available(generation: number): boolean { return this.live(generation) && this.current.fresh && !this.current.reading; }
  private draft(id: string): ChildDraft { return this.current.drafts.get(id) ?? EMPTY_CHILD_DRAFT; }
  private child(id: string): RoleControlChildView | undefined { return this.current.snapshot?.children.find(child => child.id === id && child.parentSessionId === this.current.sessionId); }
  private editDraft(generation: number, id: string, patch: Partial<ChildDraft>): void {
    if (this.disposed || generation !== this.current.generation || this.child(id)?.mode !== "continuable" || this.current.pending.has(childActionKey(id))) return;
    this.publishDraft(id, patch);
  }
  private publishDraft(id: string, patch: Partial<ChildDraft>): void {
    const drafts = new Map(this.current.drafts); drafts.set(id, { ...this.draft(id), ...patch }); this.publish({ drafts });
  }
  private issue(error: unknown): ChildrenIssue {
    if (error instanceof ControlFailure) return error.safe;
    return { kind: "transport", code: "unavailable", unknown: true };
  }
  private async unwrap<T>(method: string, call: () => Promise<RemoteResult<T>>): Promise<T> {
    const result = await call();
    if (!result.ok) {
      if (result.error.code === "dsmm-children/refused") {
        let info: RoleControlErrorInfo;
        try { info = parseRoleControlErrorInfo(result.error.details); }
        catch { throw new ControlFailure({ kind: "protocol", code: "unavailable", unknown: true }); }
        throw new ControlFailure({ kind: "domain", ...info });
      }
      throw new ControlFailure({ kind: "transport", code: "unavailable", unknown: true });
    }
    try {
      const codec = ROLE_CONTROL_REMOTE.descriptors.find(row => row.method === method)!.result;
      if (codec.mode !== "strict") throw new TypeError("Child result requires a strict codec.");
      return codec.create().parse(result.value) as T;
    }
    catch { throw new ControlFailure({ kind: "protocol", code: "unavailable", unknown: true }); }
  }
  async refresh(generation: number): Promise<void> {
    if (!this.live(generation) || this.current.reading || this.current.pending.size > 0 || [...this.current.drafts.values()].some(draft => draft.imageBusy)) return;
    const id = this.current.sessionId!; this.publish({ reading: true, issue: null, descendantIssue: null, fresh: false });
    const [description, descendants] = await Promise.allSettled([this.unwrap("describe", () => this.remote.describe(id)), this.unwrap("descendants", () => this.remote.descendants(id))]);
    if (!this.live(generation)) return;
    if (description.status === "rejected") { this.publish({ reading: false, issue: this.issue(description.reason), descendants: null }); return; }
    const snapshot = parseChildSessionSnapshot(description.value);
    if (snapshot.sessionId !== id) { this.publish({ reading: false, issue: { kind: "protocol", code: "not-owned" }, descendants: null }); return; }
    if (this.observedAdmission !== null && snapshot.admissionEpoch !== this.observedAdmission) {
      this.publish({ reading: false, issue: { kind: "protocol", code: "conflict" }, descendants: null }); return;
    }
    let tree: RoleControlDescendantsSnapshot | null = null, descendantIssue: ChildrenIssue | null = null;
    if (descendants.status === "rejected") descendantIssue = this.issue(descendants.reason);
    else {
      tree = parseRoleControlDescendants(descendants.value);
      if (tree.sessionId !== id || tree.admissionEpoch !== snapshot.admissionEpoch) { tree = null; descendantIssue = { kind: "protocol", code: "conflict" }; }
    }
    this.publish({ snapshot, descendants: tree, descendantIssue, fresh: true, reading: false, generation: generation + 1 });
  }
  private begin(key: string, kind: "prompt" | "interrupt"): void {
    const pending = new Map(this.current.pending), issues = new Map(this.current.issues), outcomes = new Map(this.current.outcomes);
    pending.set(key, kind); issues.delete(key); outcomes.delete(key); this.publish({ pending, issues, outcomes });
  }
  private finish(key: string): void { const pending = new Map(this.current.pending); pending.delete(key); this.publish({ pending }); }
  private refuse(key: string, error: unknown): void { const issues = new Map(this.current.issues); issues.set(key, this.issue(error)); this.publish({ issues }); }
  private accepted(key: string, outcome: ChildOutcome): void { const outcomes = new Map(this.current.outcomes); outcomes.set(key, outcome); this.publish({ outcomes }); }
  private canControl(generation: number, id: string, action: "prompt" | "interrupt"): boolean {
    const child = this.child(id);
    return this.available(generation) && !this.current.pending.has(childActionKey(id)) && child?.mode === "continuable" && !child.readonly
      && enabled(child.controls[action]) && enabled(this.current.snapshot?.capabilities[action]);
  }
  async prompt(generation: number, id: string): Promise<void> {
    const draft = this.draft(id), key = childActionKey(id);
    if (!this.canControl(generation, id, "prompt") || draft.uncertain || draft.imageBusy || draft.text.trim() === "" && draft.images.length === 0
      || draft.images.length > 0 && !enabled(this.current.snapshot?.capabilities.images)) return;
    this.begin(key, "prompt");
    try {
      let clientTimeZone: string | undefined;
      try { clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* Omission delegates to native zone handling. */ }
      let request: SubagentPromptRequest;
      try { request = parseRoleControlPromptRequest({ requestId: crypto.randomUUID(), parentSessionId: this.current.sessionId!, childSessionId: id, mode: "continuable", delivery: draft.delivery,
        content: [...(draft.text === "" ? [] : [{ type: "text", text: draft.text }]), ...draft.images], ...(clientTimeZone === undefined ? {} : { clientTimeZone }) }); }
      catch { throw new ControlFailure({ kind: "local", code: "invalid-content" }); }
      const receipt = await this.unwrap("prompt", () => this.remote.prompt(this.current.sessionId!, request));
      if (!this.live(generation)) return;
      this.accepted(key, { kind: "prompt", receipt });
      const drafts = new Map(this.current.drafts); drafts.set(id, { ...draft, text: "", images: [], uncertain: false }); this.publish({ drafts });
    } catch (error) {
      if (this.live(generation)) {
        const issue = this.issue(error); this.refuse(key, error);
        if (issue.unknown) { const drafts = new Map(this.current.drafts); drafts.set(id, { ...this.draft(id), uncertain: true }); this.publish({ drafts }); }
      }
    } finally { if (this.live(generation)) this.finish(key); }
  }
  async interrupt(generation: number, id: string): Promise<void> {
    if (!this.canControl(generation, id, "interrupt")) return;
    const key = childActionKey(id); this.begin(key, "interrupt");
    try {
      const receipt = await this.unwrap("interrupt", () => this.remote.interrupt(this.current.sessionId!, { parentSessionId: this.current.sessionId!, childSessionId: id, mode: "continuable" }));
      if (this.live(generation)) this.accepted(key, { kind: "interrupt", receipt });
    } catch (error) { if (this.live(generation)) this.refuse(key, error); }
    finally { if (this.live(generation)) this.finish(key); }
  }
  async addImages(generation: number, id: string, files: readonly File[]): Promise<void> {
    if (!this.canControl(generation, id, "prompt") || !enabled(this.current.snapshot?.capabilities.images) || this.draft(id).imageBusy || files.length === 0) return;
    this.editDraft(generation, id, { imageBusy: true });
    try {
      const images: ChildImage[] = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!this.live(generation)) return;
        let body = ""; for (const byte of bytes) body += String.fromCharCode(byte);
        const parsed = parseRoleControlPromptRequest({ requestId: "image-intake", parentSessionId: this.current.sessionId!, childSessionId: id, mode: "continuable", delivery: "queue",
          content: [{ type: "image", mediaType: file.type, data: btoa(body), name: file.name }] });
        images.push(parsed.content[0] as ChildImage);
      }
      if (this.live(generation)) this.publishDraft(id, { images: [...this.draft(id).images, ...images] });
    } catch { if (this.live(generation)) this.refuse(childActionKey(id), new ControlFailure({ kind: "local", code: "invalid-content" })); }
    finally { if (this.live(generation)) this.publishDraft(id, { imageBusy: false }); }
  }
}
