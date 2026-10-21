import type { Agent } from "@deepseek-ai/dsh-agent";
import type { NativePermissionCapabilityView } from "./permission-native-rules.js";
import { PermissionRefusal } from "./permission-errors.js";
import { resolvePermissionControl } from "./permission-settings.js";
import type { PermissionControlSettings, PermissionRuleAction, PermissionWebPolicy } from "./permission-settings.js";

export type PermissionRuleMatch =
  | { readonly kind: "outside-read"; readonly path: string; readonly scope: "exact" | "tree" }
  | { readonly kind: "shell"; readonly executable: string; readonly command: string; readonly workingDirectory: string }
  | { readonly kind: "webSearch" | "webFetch" };
export interface PermissionRuleDraft { readonly id: string; readonly action: Exclude<PermissionRuleAction, "inherit">; readonly match: PermissionRuleMatch }
export type PermissionRuleSource = { readonly kind: "operator"; readonly sessionId: string; readonly savedAt: number }
  | { readonly kind: "user-import"; readonly label: string };
export interface PermissionRule extends PermissionRuleDraft { readonly source: PermissionRuleSource; readonly revision: number; readonly revoked: boolean }
export interface PermissionRuleSnapshot { readonly revision: string; readonly policy: PermissionControlSettings }
export interface PermissionRulesStatus {
  readonly savedRevision: string;
  readonly runtimeRevision: string;
  readonly state: "synced" | "updating" | "unsynced";
  readonly mounted: boolean;
  readonly restartRequired: boolean;
}
export interface PermissionRulesSaveRequest {
  readonly expectedRevision: string;
  readonly changes?: { readonly outsideReads?: PermissionRuleAction; readonly webSearch?: PermissionWebPolicy; readonly webFetch?: PermissionWebPolicy };
  readonly upsert?: readonly PermissionRuleDraft[];
  readonly revoke?: readonly string[];
}
export interface PermissionRulesSaveAuthority {
  readonly root: Agent;
  readonly peer: object;
  readonly signal: AbortSignal;
  /** Backend calls this after awaits and immediately before its durable CAS. Includes readonly. */
  assertCurrent(): void;
}
/** One central backend only. Every permission-affecting save (including imports) uses sync. */
export interface PermissionRulesBackend {
  assertWritable(root: Agent): void;
  read(authority: PermissionRulesSaveAuthority): Promise<PermissionRuleSnapshot>;
  save(request: PermissionRulesSaveRequest, authority: PermissionRulesSaveAuthority): Promise<PermissionRulesSaveResult>;
}
export interface PermissionRulesSaveResult { readonly snapshot: PermissionRuleSnapshot; readonly runtime: PermissionRulesStatus; readonly capabilities?: NativePermissionCapabilityView }

function invalid(): never { throw new PermissionRefusal("validation"); }
export function permissionRuleRow(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.hasOwn(fields, key)) || Object.values(fields).some(field => !Object.hasOwn(field, "value") || !field.enumerable)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 32768): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) invalid();
  return value;
}
/** Persistent backend source identity, not a counter or a prescribed hash format. */
export function permissionRevision(value: unknown): string { return text(value, 4096); }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(); return value; }
function ruleAction(value: unknown, inherit = false): PermissionRuleAction {
  if (typeof value !== "string" || !(inherit ? ["inherit", "allow", "ask", "deny"] : ["allow", "ask", "deny"]).includes(value)) invalid();
  return value as PermissionRuleAction;
}
function draft(value: unknown, persisted = false): PermissionRuleDraft {
  const input = permissionRuleRow(value, ["id", "action", "match", ...persisted ? ["source", "revision", "revoked"] : []]);
  const kind = permissionRuleRow(input.match, ["kind"], ["path", "scope", "executable", "command", "workingDirectory"]).kind;
  let match: PermissionRuleMatch;
  if (kind === "outside-read") {
    const row = permissionRuleRow(input.match, ["kind", "path", "scope"]);
    if (row.scope !== "exact" && row.scope !== "tree") invalid();
    match = { kind, path: text(row.path), scope: row.scope };
  } else if (kind === "shell") {
    const row = permissionRuleRow(input.match, ["kind", "executable", "command", "workingDirectory"]);
    match = { kind, executable: text(row.executable), command: text(row.command), workingDirectory: text(row.workingDirectory) };
  } else if (kind === "webSearch" || kind === "webFetch") { permissionRuleRow(input.match, ["kind"]); match = { kind }; }
  else invalid();
  return Object.freeze({ id: text(input.id, 256), action: ruleAction(input.action) as PermissionRuleDraft["action"], match: Object.freeze(match) });
}
export function parsePermissionRules(value: unknown): readonly PermissionRule[] {
  if (!Array.isArray(value) || value.length > 1024) invalid();
  const ids = new Set<string>();
  return Object.freeze(value.map(item => {
    const parsed = draft(item, true), row = item as Record<string, unknown>;
    if (ids.has(parsed.id) || typeof row.revoked !== "boolean") invalid(); ids.add(parsed.id);
    const sourceRow = permissionRuleRow(row.source, ["kind"], ["sessionId", "savedAt", "label"]);
    let source: PermissionRuleSource;
    if (sourceRow.kind === "operator") {
      permissionRuleRow(row.source, ["kind", "sessionId", "savedAt"]);
      source = { kind: "operator", sessionId: text(sourceRow.sessionId, 256), savedAt: integer(sourceRow.savedAt) };
    } else if (sourceRow.kind === "user-import") {
      permissionRuleRow(row.source, ["kind", "label"]); source = { kind: "user-import", label: text(sourceRow.label, 512) };
    } else invalid();
    return Object.freeze({ ...parsed, source: Object.freeze(source), revision: integer(row.revision), revoked: row.revoked });
  }));
}
export function parsePermissionRulesSave(value: unknown): PermissionRulesSaveRequest {
  const row = permissionRuleRow(value, ["expectedRevision"], ["changes", "upsert", "revoke"]);
  let changes: PermissionRulesSaveRequest["changes"];
  if (row.changes !== undefined) {
    const input = permissionRuleRow(row.changes, [], ["outsideReads", "webSearch", "webFetch"]);
    const web = (value: unknown): PermissionWebPolicy => { const row = permissionRuleRow(value, ["enabled", "rule"]); if (typeof row.enabled !== "boolean") invalid(); return Object.freeze({ enabled: row.enabled, rule: ruleAction(row.rule, true) }); };
    changes = Object.freeze({ ...input.outsideReads === undefined ? {} : { outsideReads: ruleAction(input.outsideReads, true) },
      ...input.webSearch === undefined ? {} : { webSearch: web(input.webSearch) }, ...input.webFetch === undefined ? {} : { webFetch: web(input.webFetch) } });
  }
  if (row.upsert !== undefined && (!Array.isArray(row.upsert) || row.upsert.length > 1024)
    || row.revoke !== undefined && (!Array.isArray(row.revoke) || row.revoke.length > 1024)) invalid();
  const upsert = (row.upsert as unknown[] | undefined)?.map(item => draft(item)), revoke = (row.revoke as unknown[] | undefined)?.map(item => text(item, 256));
  const ids = [...upsert?.map(item => item.id) ?? [], ...revoke ?? []];
  if (ids.length !== new Set(ids).size || ids.length === 0 && (changes === undefined || Object.keys(changes).length === 0)) invalid();
  return Object.freeze({ expectedRevision: permissionRevision(row.expectedRevision), ...changes === undefined ? {} : { changes },
    ...upsert === undefined ? {} : { upsert: Object.freeze(upsert) }, ...revoke === undefined ? {} : { revoke: Object.freeze(revoke) } });
}

/** Backend derives provenance from its verified Host authority, never from a client rule. */
export function applyPermissionRulesSave(previous: PermissionRuleSnapshot, input: PermissionRulesSaveRequest, source: PermissionRuleSource): PermissionControlSettings {
  const request = parsePermissionRulesSave(input);
  if (permissionRevision(previous.revision) !== request.expectedRevision) throw new PermissionRefusal("stale");
  const policy = resolvePermissionControl(previous.policy), rules = new Map(policy.rules.map(rule => [rule.id, rule]));
  for (const id of request.revoke ?? []) {
    const existing = rules.get(id); if (existing === undefined) throw new PermissionRefusal("not-found");
    rules.set(id, { ...existing, revision: integer(existing.revision + 1), revoked: true, source });
  }
  for (const rule of request.upsert ?? []) rules.set(rule.id, { ...rule, revision: integer((rules.get(rule.id)?.revision ?? 0) + 1), revoked: false, source });
  return resolvePermissionControl({ ...policy, ...request.changes, rules: [...rules.values()] });
}
export function operatorPermissionRulesSource(authority: PermissionRulesSaveAuthority): PermissionRuleSource {
  authority.signal.throwIfAborted(); authority.assertCurrent();
  return Object.freeze({ kind: "operator", sessionId: authority.root.id, savedAt: Date.now() });
}
/** Import paths explicitly re-stamp all records; imported operator claims are not ACKs. */
export function importPermissionRules(input: readonly PermissionRuleDraft[], label: string, revision: number): readonly PermissionRule[] {
  return parsePermissionRules(input.map(item => ({ ...draft(item), source: { kind: "user-import", label: text(label, 512) }, revision: integer(revision), revoked: false })));
}

export interface PermissionRulesUpdate { readonly expectedRevision: string }
interface Update extends PermissionRulesUpdate { readonly generation: object }
/** In-process protocol owned by A's single CAS backend. No file watcher or persistence. */
export class PermissionRulesRuntimeSync {
  private snapshot: PermissionRuleSnapshot;
  private savedRevision: string;
  private state: PermissionRulesStatus["state"] = "synced";
  private update?: Update;
  private lifetime = new AbortController();
  private retired = false;
  private readonly mounted: boolean;
  private desiredEnabled: boolean;
  constructor(initial: PermissionRuleSnapshot, private readonly revoke: () => void) {
    this.snapshot = this.validate(initial); this.savedRevision = initial.revision;
    this.mounted = initial.policy.enabled; this.desiredEnabled = initial.policy.enabled;
  }
  private validate(value: PermissionRuleSnapshot): PermissionRuleSnapshot {
    const revision = permissionRevision(value.revision), policy = resolvePermissionControl(value.policy);
    return Object.freeze({ revision, policy });
  }
  status(): PermissionRulesStatus { return Object.freeze({ savedRevision: this.savedRevision, runtimeRevision: this.snapshot.revision,
    state: this.state, mounted: this.mounted, restartRequired: this.desiredEnabled !== this.mounted }); }
  getPolicy(): PermissionRuleSnapshot {
    if (this.retired || this.state !== "synced" || this.lifetime.signal.aborted) throw new PermissionRefusal("unavailable");
    return this.snapshot;
  }
  get signal(): AbortSignal { return this.lifetime.signal; }
  /** Source backends override this entry; consumers never reconcile storage themselves. */
  async refresh(): Promise<PermissionRuleSnapshot> { return this.getPolicy(); }
  invalidate(): void {
    if (this.retired) return;
    this.state = "unsynced"; this.update = undefined; this.lifetime.abort();
    if (!this.retired) this.revoke();
  }
  private assertLive(): void { if (this.retired) throw new PermissionRefusal("unavailable"); }
  begin(expectedRevision: string): PermissionRulesUpdate {
    this.assertLive();
    if (this.state === "updating" || permissionRevision(expectedRevision) !== this.savedRevision) throw new PermissionRefusal("stale");
    const update: Update = Object.freeze({ expectedRevision, generation: {} }); this.update = update; this.state = "updating";
    this.lifetime.abort();
    try { this.revoke(); this.check(update); } catch (error) {
      if (this.update === update) { this.state = "unsynced"; this.update = undefined; }
      throw error;
    }
    return update;
  }
  private check(update: PermissionRulesUpdate): void { this.assertLive(); if (update !== this.update) throw new PermissionRefusal("stale"); }
  /** Called only after CAS succeeded. notify must acknowledge all runtime revocation consumers. */
  async commit(update: PermissionRulesUpdate, saved: PermissionRuleSnapshot, notify: (snapshot: PermissionRuleSnapshot) => Promise<void>): Promise<PermissionRulesStatus> {
    this.check(update);
    const snapshot = this.validate(saved);
    this.savedRevision = snapshot.revision; this.desiredEnabled = snapshot.policy.enabled;
    try {
      await notify(snapshot); this.check(update);
      this.snapshot = snapshot; this.state = "synced"; this.update = undefined; this.lifetime = new AbortController();
    } catch (error) { if (this.update === update) { this.state = "unsynced"; this.update = undefined; } throw error; }
    return this.status();
  }
  /** CAS failure or failed notification: reread authoritative storage, never publish the rejected request. */
  async recover(update: PermissionRulesUpdate | undefined, authoritative: PermissionRuleSnapshot, notify: (snapshot: PermissionRuleSnapshot) => Promise<void>): Promise<PermissionRulesStatus> {
    this.assertLive();
    if (update !== undefined) this.check(update);
    else if (this.state !== "unsynced") throw new PermissionRefusal("stale");
    const snapshot = this.validate(authoritative);
    const recovery: Update = Object.freeze({ expectedRevision: snapshot.revision, generation: {} }); this.update = recovery; this.state = "updating";
    try {
      this.lifetime.abort(); this.check(recovery);
      this.revoke(); this.check(recovery);
      this.savedRevision = snapshot.revision; this.desiredEnabled = snapshot.policy.enabled;
      await notify(snapshot); this.check(recovery); this.snapshot = snapshot; this.state = "synced"; this.update = undefined; this.lifetime = new AbortController();
    }
    catch (error) { if (this.update === recovery) { this.state = "unsynced"; this.update = undefined; } throw error; }
    return this.status();
  }
  retire(): void {
    if (this.retired) return;
    this.retired = true; this.state = "unsynced"; this.update = undefined; this.lifetime.abort(); this.revoke();
  }
}

export function intersectPermissionActions(actions: readonly PermissionRuleAction[]): PermissionRuleAction {
  return actions.includes("deny") ? "deny" : actions.includes("ask") ? "ask" : actions.includes("allow") ? "allow" : "inherit";
}
