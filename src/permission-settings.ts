import { parsePermissionRules, permissionRuleRow } from "./permission-rules.js";
import type { PermissionRule } from "./permission-rules.js";
import { PermissionRefusal } from "./permission-errors.js";

export type PermissionRuleAction = "inherit" | "allow" | "ask" | "deny";
export interface PermissionWebPolicy { readonly enabled: boolean; readonly rule: PermissionRuleAction }
export interface NativeCommandMatch {
  readonly tool: "bash" | "pwsh";
  readonly workingDirectory: string;
  readonly commandPattern: string;
}
export interface NativeCommandEntry {
  readonly id: string;
  readonly mode: "ask" | "allow";
  readonly match: NativeCommandMatch;
  readonly sandboxMode: "workspace-write" | "danger-full-access";
}
export type NativeCommandRule = string | NativeCommandEntry;
export interface NativeCommandsSettings { readonly enabled: boolean; readonly entries: readonly NativeCommandRule[] }
/** Only enabled is deployment-only. Rules are independently synchronized at runtime. */
export interface PermissionControlSettings {
  readonly enabled: boolean;
  readonly outsideReads: PermissionRuleAction;
  readonly webSearch: PermissionWebPolicy;
  readonly webFetch: PermissionWebPolicy;
  readonly rules: readonly PermissionRule[];
  readonly nativeCommands: NativeCommandsSettings;
}
export interface PermissionControlSchemaInput {
  readonly enabled?: boolean;
  readonly outsideReads?: PermissionRuleAction;
  readonly webSearch?: Partial<PermissionWebPolicy>;
  readonly webFetch?: Partial<PermissionWebPolicy>;
  readonly rules?: readonly PermissionRule[];
  readonly nativeCommands?: Partial<NativeCommandsSettings>;
}
export interface NativeCommandPattern { readonly executable: string; readonly subcommands: readonly string[] }
/** Bounded static prefix grammar; the optional final star always denotes the whole argv tail. */
export function parseNativeCommandPattern(input: unknown): NativeCommandPattern {
  if (typeof input !== "string" || input.length > 32768) throw new PermissionRefusal("validation");
  const tokens = input.replace(/^[ \t]+|[ \t]+$/gu, "").split(/[ \t]+/u);
  if (tokens.length !== 2 && (tokens.length !== 3 || tokens[2] !== "*")
    || tokens[0].length === 0 || /[^\p{L}\p{M}\p{N}_./:=+%\\\-]/u.test(tokens[0])) throw new PermissionRefusal("validation");
  const subcommands = tokens[1].split("|");
  if (subcommands.some(value => value.length === 0 || /[^\p{L}\p{M}\p{N}_./:=+%\-]/u.test(value))) throw new PermissionRefusal("validation");
  return Object.freeze({ executable: tokens[0], subcommands: Object.freeze(subcommands) });
}
/** Literal token prefixes; only the second token may contain alternatives. */
export function parseSimpleCommandPattern(input: unknown): readonly (readonly string[])[] {
  if (typeof input !== "string" || input.length > 32768) throw new PermissionRefusal("validation");
  const tokens = input.replace(/^[ \t]+|[ \t]+$/gu, "").split(/[ \t]+/u);
  if (tokens.at(-1) === "*") tokens.pop();
  if (!tokens.length) throw new PermissionRefusal("validation");
  return Object.freeze(tokens.map((token, index) => {
    const values = index === 1 ? token.split("|") : [token];
    if (values.some(value => !value.length || /[^\p{L}\p{M}\p{N}_./:=+%\\\-]/u.test(value))) throw new PermissionRefusal("validation");
    return Object.freeze(values);
  }));
}
export function parseNativeCommands(input: unknown = {}): NativeCommandsSettings {
  const row = permissionRuleRow(input, [], ["enabled", "entries"]);
  if (row.enabled !== undefined && typeof row.enabled !== "boolean" || row.entries !== undefined && (!Array.isArray(row.entries) || row.entries.length > 1024)) throw new PermissionRefusal("validation");
  const text = (value: unknown): string => { if (typeof value !== "string" || value.trim().length === 0 || value.length > 32768 || value.includes("\0")) throw new PermissionRefusal("validation"); return value; };
  const ids = new Set<string>();
  const entries = (row.entries as unknown[] | undefined ?? []).map(value => {
    if (typeof value === "string") { parseSimpleCommandPattern(value); return value; }
    const entry = permissionRuleRow(value, ["id", "mode", "match", "sandboxMode"]);
    const match = permissionRuleRow(entry.match, ["tool", "workingDirectory", "commandPattern"]);
    const id = text(entry.id), cwd = text(match.workingDirectory);
    if (ids.has(id) || !["ask", "allow"].includes(entry.mode as string) || !["bash", "pwsh"].includes(match.tool as string)
      || !["workspace-write", "danger-full-access"].includes(entry.sandboxMode as string)
      // Wire paths belong to the Host, not the browser's platform. The Host validates and canonicalizes them before use.
      || !/^(?:\/|[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/iu.test(cwd)) throw new PermissionRefusal("validation");
    ids.add(id);
    parseNativeCommandPattern(match.commandPattern);
    const parsed: NativeCommandMatch = { tool: match.tool as NativeCommandMatch["tool"], workingDirectory: cwd, commandPattern: match.commandPattern as string };
    return Object.freeze({ id, mode: entry.mode as NativeCommandEntry["mode"], sandboxMode: entry.sandboxMode as NativeCommandEntry["sandboxMode"], match: Object.freeze(parsed) });
  });
  return Object.freeze({ enabled: row.enabled as boolean | undefined ?? false, entries: Object.freeze(entries) });
}
const webDefault = Object.freeze({ enabled: true, rule: "inherit" as const });
export const DEFAULT_PERMISSION_CONTROL: PermissionControlSettings = Object.freeze({ enabled: true, outsideReads: "inherit", webSearch: webDefault, webFetch: webDefault, rules: Object.freeze([]), nativeCommands: parseNativeCommands() });
function enabled(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "boolean") return value;
  throw new PermissionRefusal("validation");
}
function action(value: unknown): PermissionRuleAction {
  if (value == null) return "inherit";
  if (value === "inherit" || value === "allow" || value === "ask" || value === "deny") return value;
  throw new PermissionRefusal("validation");
}
function webPolicy(input: unknown): PermissionWebPolicy {
  if (input === undefined) return webDefault;
  const row = permissionRuleRow(input, [], ["enabled", "rule"]);
  return Object.freeze({ enabled: enabled(row.enabled), rule: action(row.rule) });
}
export function resolvePermissionControl(input: PermissionControlSchemaInput = {}): PermissionControlSettings {
  const row = permissionRuleRow(input, [], ["enabled", "outsideReads", "webSearch", "webFetch", "rules", "nativeCommands"]);
  return Object.freeze({ enabled: enabled(row.enabled), outsideReads: action(row.outsideReads), webSearch: webPolicy(row.webSearch),
    webFetch: webPolicy(row.webFetch), rules: parsePermissionRules(row.rules ?? []), nativeCommands: parseNativeCommands(row.nativeCommands) });
}
