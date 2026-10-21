import { findNodeAtLocation, parseTree } from "jsonc-parser";
import type { Node, ParseError } from "jsonc-parser";
import { DSMM_RATE_LIMIT_BOUNDS } from "./routing-policy.js";
import { permissionControlSchema } from "./permission-settings.js";
import type Schema from "@deepseek-ai/schemastery";

export const PROFILE_DIAGNOSTIC_REASONS = {
  "invalid-jsonc": "Use one valid document with supported JSON syntax.",
  "duplicate-field": "Remove the duplicate field.",
  "unsafe-field": "Unsafe object fields are not supported.",
  "unknown-field": "This field is not supported; installation and private configuration belong in native deployment configuration.",
  "deprecated-field": "This retired field is not supported; configure explicit role levels instead.",
  "invalid-type": "Use the declared field type and bounded value.",
  "unsupported-value": "Use one of the explicitly supported values.",
  "invalid-route": "Use a complete provider/model route or a nonempty reasoning-effort override.",
  "required-role": "This role is required by the selected Deepwork policy.",
  "deployment-ceiling": "A named profile cannot enable capabilities outside its captured deployment ceiling.",
  "blank-label": "The label is blank; the profile ID is used for display."
} as const;
export type ProfileDiagnosticCode = keyof typeof PROFILE_DIAGNOSTIC_REASONS;
export interface ProfileDiagnosticLocation { offset: number; length: number; line: number; column: number }
export interface ProfileDiagnostic {
  severity: "error" | "warning";
  code: ProfileDiagnosticCode;
  field: string;
  reason: string;
  location?: ProfileDiagnosticLocation;
}
export const DEPRECATED_DSMM_FIELDS = ["deepseekV4ProMaxReasoningPresets", "deepseekFlashMaxReasoningPresets", "deepseekV4ProCalibration", "deepseekV4ProDefaultReasoningEffort", "deepseekFlashCalibration", "deepseekFlashDefaultReasoningEffort"] as const;
type FieldShape = { [key: string]: FieldShape } | readonly [FieldShape] | "roles" | "role-routing" | "skills" | null;
function schemaFieldShape(schema: Schema): FieldShape {
  if (schema.type === "transform") return schemaFieldShape(schema.inner!);
  if (schema.type === "object") return Object.fromEntries(Object.entries(schema.dict ?? {}).map(([key, child]) => [key, schemaFieldShape(child)]));
  if (schema.type === "array") return [schemaFieldShape(schema.inner!)];
  return null;
}
// Closed wire grammar: dynamic role/skill names are declared identifiers, not arbitrary object keys.
const roleId = /^dsmm-(?:orchestrator|planner|plan-critic|builder|reviewer|oracle|oracle-2nd|creative|code-search|doc-search|clarifier|media-reader|frontend|hard-reasoning|research|quick|coding|normal-task|complex|deep|documenting|cross-cutting)$/u;
const skillId = /^(?:brainstorming|writing-plans|requesting-code-review|receiving-code-review|subagent-driven-development|dispatching-parallel-agents|remove-ai-slops|debugging|frontend|git-master|ast-grep|coding-agent-sessions|init-deep|using-git-worktrees)$/u;
const route: FieldShape = { provider: null, model: null, reasoningEffort: null };
const rateLimit: FieldShape = Object.fromEntries(Object.keys(DSMM_RATE_LIMIT_BOUNDS).map(key => [key, null]));
const roleRouting: FieldShape = { primary: route, fallbackRoutes: [route], strategy: null, rateLimit, levels: { low: route, high: route, max: route } };
const configFields: Record<string, FieldShape> = {
  permissionControl: schemaFieldShape(permissionControlSchema),
  modelParameters: { passthrough: null },
  locale: null, modeName: null, section: null, defaultActive: null, promptOrder: null,
  deepseekV4ProCalibration: null, deepseekV4ProDefaultReasoningEffort: null, deepseekFlashCalibration: null, deepseekFlashDefaultReasoningEffort: null,
  deepseekV4ProMaxReasoningPresets: null, deepseekFlashMaxReasoningPresets: null,
  modules: { deepwork: { enabled: null } },
  skills: "skills", roles: "roles", roleRouting: "role-routing", runtimePolicy: { strategy: null, rateLimit },
  presets: { materialize: null, root: null }, subagents: { toolTopology: null, allowRouteOverride: null, enableRunInBackground: null, backgroundMode: null, maxDepth: null },
  workflow: { policy: null, strictGates: null, reviewCap: null, finalReviewPolicy: null },
  guards: { scope: null, shellCommandSafety: null, gitWriteGuard: null, toolOutputTruncation: { enabled: null, maxInlineBytes: null }, planFormatValidation: null, questionLabelHelper: { enabled: null, maxLabelChars: null }, todoDisciplineHelper: null },
  runtimeRecovery: { enabled: null, retryOnStatusCodes: [null], retryOnCodes: [null], fallbackRoutes: [route], maxFallbackAttempts: null, idleContinuation: { enabled: null, maxContinuations: null, prompt: null } },
  lsp: { enabled: null, serverName: null, command: null, args: [null], cwd: null, env: {}, toolCallTimeoutMs: null, failOnStartupError: null }
};
const documentFields: FieldShape = { version: null, id: null, label: null, settings: configFields };
const rootFields: FieldShape = { ...configFields, ...documentFields as Record<string, FieldShape>, document: documentFields, content: null, expectedRevision: null, expectedSelectionRevision: null, expectedAdmissionEpoch: null, expectedModeRevision: null, sessionId: null, route };
function childShape(shape: FieldShape | undefined, key: string | number): FieldShape | undefined {
  if (typeof key === "number") return Number.isSafeInteger(key) && key >= 0 && key <= 999999 && Array.isArray(shape) ? shape[0] : undefined;
  if (shape === rootFields && roleId.test(key)) return null;
  if (shape === "roles") return roleId.test(key) ? null : undefined;
  if (shape === "role-routing") return roleId.test(key) ? roleRouting : undefined;
  if (shape === "skills") return skillId.test(key) ? null : undefined;
  return shape !== null && typeof shape === "object" && !Array.isArray(shape) && Object.hasOwn(shape, key) ? (shape as Record<string, FieldShape>)[key] : undefined;
}
function fieldParts(field: string): (string | number)[] {
  return field.replace(/\[([0-9]+)\]/gu, ".$1").split(".").map(part => /^\d+$/u.test(part) ? Number(part) : part);
}
const sourcePaths = new WeakMap<object, readonly (string | number)[]>();
/** Host parser location provenance only; never serialized on an error or DTO. */
export function diagnosticSourcePath(error: object): readonly (string | number)[] | undefined { return sourcePaths.get(error); }
export function safeDiagnosticField(parts: readonly (string | number)[]): string {
  let result = "";
  let shape: FieldShape | undefined = rootFields;
  for (const part of parts.slice(0, 16)) {
    const declared = childShape(shape, part);
    const key = declared !== undefined ? part : "[unknown]";
    const next = typeof key === "number" ? `[${key}]` : `${result === "" ? "" : "."}${key}`;
    if (result.length + next.length > 256) break;
    result += next;
    shape = declared;
  }
  return result || "document";
}
export function isSafeDiagnosticField(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256
    && /^(?:[a-zA-Z][a-zA-Z0-9_-]{0,63}|\[unknown\])(?:\.(?:[a-zA-Z][a-zA-Z0-9_-]{0,63}|\[unknown\])|\[(?:0|[1-9][0-9]{0,5})\])*$/u.test(value)
    && safeDiagnosticField(fieldParts(value)) === value;
}
export function diagnostic(code: ProfileDiagnosticCode, field: string, location?: ProfileDiagnosticLocation): ProfileDiagnostic {
  const reason = code === "unsupported-value" && (field === "locale" || field === "settings.locale")
    ? "Supported locales: en, zh-Hans, zh-Hant, ja, ko, de, fr, es, pt-BR, ru."
    : PROFILE_DIAGNOSTIC_REASONS[code];
  return { severity: code === "blank-label" ? "warning" : "error", code, field: safeDiagnosticField(fieldParts(field)), reason, ...(location === undefined ? {} : { location }) };
}
export class DsmmConfigValidationError extends TypeError {
  readonly diagnostic: ProfileDiagnostic;
  constructor(code: ProfileDiagnosticCode, field: string | readonly (string | number)[]) {
    const path = typeof field === "string" ? fieldParts(field) : [...field];
    const info = diagnostic(code, safeDiagnosticField(path));
    super(`${info.field}: ${info.reason}`);
    this.diagnostic = info;
    sourcePaths.set(this, Object.freeze([...path]));
  }
}
export function diagnosticLocation(content: string, offset: number, length: number): ProfileDiagnosticLocation {
  const before = content.slice(0, offset).split(/\r\n|\r|\n/u);
  return { offset, length, line: before.length, column: before.at(-1)!.length + 1 };
}
export function fieldLocation(content: string, tree: Node, field: string, sourcePath?: readonly (string | number)[]): ProfileDiagnosticLocation | undefined {
  const path = sourcePath !== undefined ? [...sourcePath] : field === "document" || field === "content" ? [] : fieldParts(field);
  let node = findNodeAtLocation(tree, path);
  while (node === undefined && path.length) { path.pop(); node = findNodeAtLocation(tree, path); }
  if (node === undefined) return undefined;
  const selected = node.parent?.type === "property" ? node.parent.children![0] : node;
  return diagnosticLocation(content, selected.offset, selected.length);
}
export function inspectJsonDocument(content: string, jsonc = true): { tree?: Node; diagnostics: ProfileDiagnostic[] } {
  const errors: ParseError[] = [];
  // Replace, rather than remove, the BOM so offsets still address original bytes/text.
  const tree = parseTree(content.replace(/^\uFEFF/u, " "), errors, { allowTrailingComma: jsonc, disallowComments: !jsonc, allowEmptyContent: false });
  if (tree === undefined || errors.length) return { tree, diagnostics: [diagnostic("invalid-jsonc", "content", diagnosticLocation(content, errors[0]?.offset ?? 0, errors[0]?.length ?? 0))] };
  const diagnostics: ProfileDiagnostic[] = [];
  const walk = (node: Node, path: (string | number)[], depth: number): void => {
    if (depth > 32) { diagnostics.push(diagnostic("invalid-type", safeDiagnosticField(path), diagnosticLocation(content, node.offset, node.length))); return; }
    if (node.type === "object") {
      const found = new Set<string>();
      for (const property of node.children ?? []) {
        const keyNode = property.children![0], key = String(keyNode.value), next = [...path, key];
        const code = ["__proto__", "constructor", "prototype"].includes(key) ? "unsafe-field" : found.has(key) ? "duplicate-field" : undefined;
        if (code !== undefined) diagnostics.push(diagnostic(code, safeDiagnosticField(next), diagnosticLocation(content, keyNode.offset, keyNode.length)));
        found.add(key);
        walk(property.children![1], next, depth + 1);
      }
    } else if (node.type === "array") (node.children ?? []).forEach((child, index) => walk(child, [...path, index], depth + 1));
  };
  walk(tree, [], 0);
  return { tree, diagnostics };
}
