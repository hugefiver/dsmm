import { getNodeValue } from "jsonc-parser";
import { DSMM_ROLE_IDS } from "./roles.js";
import { copyJson, DSMM_LOCALES, resolveConfig, normalizeLevelOverride } from "./settings.js";
import type { DsmmPluginConfig, DsmmSettings } from "./settings.js";
import type { ProfileErrorCode, ProfileErrorInfo } from "./profile-types.js";
import { DSMM_RATE_LIMIT_BOUNDS, normalizeRateLimitOverrides, normalizeRoutingStrategy, normalizeRuntimePolicy } from "./routing-policy.js";
import { DEPRECATED_DSMM_FIELDS, diagnostic, diagnosticSourcePath, DsmmConfigValidationError, fieldLocation, inspectJsonDocument } from "./profile-diagnostics.js";
import type { ProfileDiagnostic, ProfileDiagnosticCode, ProfileDiagnosticLocation } from "./profile-diagnostics.js";
import type { DsmmRoleId } from "./roles.js";
import { normalizeModelRouteJson } from "./route-json.js";

export const MAX_PROFILE_BYTES = 128 * 1024;
export const MAX_PROFILE_COUNT = 128;
export const MAX_PROFILE_DIRECTORY_ENTRIES = 1024;
export const MAX_PROFILE_REVISIONS = 1024;

export type DsmmProfileOverlay = Pick<DsmmPluginConfig,
  "modelParameters" | "defaultActive" | "roleRouting" | "runtimePolicy" | "workflow" | "guards" | "runtimeRecovery"
  | "roles" | "locale"> & { subagents?: Pick<NonNullable<DsmmPluginConfig["subagents"]>, "toolTopology"> };

export interface DsmmProfileDocument {
  version: 1;
  id: string;
  label?: string;
  settings: DsmmProfileOverlay;
}

export class DsmmProfileError extends Error {
  readonly code: ProfileErrorCode;
  readonly field?: string;
  readonly reason?: ProfileDiagnosticCode;
  readonly location?: ProfileDiagnosticLocation;

  constructor(code: ProfileErrorCode, message: string, field?: string, reason?: ProfileDiagnosticCode, location?: ProfileDiagnosticLocation) {
    super(message);
    this.name = "DsmmProfileError";
    this.code = code;
    this.field = field;
    this.reason = reason;
    this.location = location;
  }

  toInfo(): ProfileErrorInfo {
    return { code: this.code, message: this.message, ...(this.field === undefined ? {} : { field: this.field }), ...(this.reason === undefined ? {} : { reason: this.reason }), ...(this.location === undefined ? {} : { location: this.location }) };
  }
}

export function profileErrorInfo(error: unknown, fallback: ProfileErrorCode = "io"): ProfileErrorInfo {
  if (error instanceof DsmmConfigValidationError) return { code: "validation", message: error.message, field: error.diagnostic.field, reason: error.diagnostic.code, ...(error.diagnostic.location === undefined ? {} : { location: error.diagnostic.location }) };
  return error instanceof DsmmProfileError ? error.toInfo() : { code: fallback, message: "Deepwork profile operation failed; the previous selection and files were retained." };
}

export function validateProfileId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(id) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(id)) {
    throw new DsmmProfileError("validation", "Profile ID must be 1–64 lowercase ASCII letters, digits, hyphens or underscores, and not a Windows reserved name.", "id");
  }
}

export function validateProfileRevision(revision: unknown, field = "expectedRevision"): asserts revision is string {
  if (!isConfigRevision(revision)) invalid(field, "must be a configuration version");
}

export { isConfigRevision, isProfileReference } from "./config-revision.js";
import { isConfigRevision } from "./config-revision.js";
export function validateAdmissionEpoch(value: unknown, field = "admissionEpoch"): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalid(field, "must be an admission identity");
}

const OVERLAY_FIELDS = ["modelParameters", "defaultActive", "roleRouting", "runtimePolicy", "workflow", "guards", "runtimeRecovery", "roles", "locale", "subagents"];

export function parseProfileDocument(content: string, expectedId?: string): DsmmProfileDocument {
  const result = validateProfileDocument(content, expectedId);
  const error = result.diagnostics.find(item => item.severity === "error");
  if (error !== undefined) throw new DsmmProfileError("validation", `${error.field}: ${error.reason}`, error.field, error.code, error.location);
  return result.document!;
}

export function validateProfileDocument(content: string, expectedId?: string): { document?: DsmmProfileDocument; diagnostics: ProfileDiagnostic[] } {
  if (typeof content !== "string") return { diagnostics: [diagnostic("invalid-type", "content")] };
  if (content.length > MAX_PROFILE_BYTES) throw new DsmmProfileError("limit", "Profile files must not exceed 128 KiB.", "content");
  const encoded = new TextEncoder().encode(content);
  if (encoded.byteLength > MAX_PROFILE_BYTES) throw new DsmmProfileError("limit", "Profile files must not exceed 128 KiB.", "content");
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded) !== content) return { diagnostics: [diagnostic("invalid-type", "content")] };
  const inspected = inspectJsonDocument(content);
  if (inspected.diagnostics.length) return { diagnostics: inspected.diagnostics };
  const tree = inspected.tree!;
  try {
    const document = record(getNodeValue(tree), "document");
    keys(document, ["version", "id", "label", "settings"], "document");
    if (document.version !== 1) invalid("version", "must be 1", "unsupported-value");
    validateProfileId(document.id);
    if (expectedId !== undefined && document.id !== expectedId) invalid("id", "must match the profile filename ID");
    if (Object.hasOwn(document, "label")) {
      if (typeof document.label !== "string" || document.label.length > 120 || /[\u0000-\u001F\u007F]/u.test(document.label)
        || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(document.label)) !== document.label) invalid("label", "must be valid bounded text without controls");
    }
    const overlay = record(document.settings, "settings");
    validateProfileOverlay(overlay);
    const result = clone(document) as DsmmProfileDocument;
    return { document: result, diagnostics: profileDocumentWarnings(result).map(info => ({ ...info, location: fieldLocation(content, tree, info.field) })) };
  } catch (error) {
    if (!(error instanceof DsmmProfileError) && !(error instanceof DsmmConfigValidationError)) throw error;
    const code = error instanceof DsmmConfigValidationError ? error.diagnostic.code : error.reason ?? "invalid-type";
    const field = error instanceof DsmmConfigValidationError ? error.diagnostic.field : error.field ?? "document";
    return { diagnostics: [diagnostic(code, field, fieldLocation(content, tree, field, diagnosticSourcePath(error)))] };
  }
}

export function profileDocumentWarnings(document: DsmmProfileDocument | null): ProfileDiagnostic[] {
  return document?.label !== undefined && document.label.trim() === "" ? [diagnostic("blank-label", "label")] : [];
}

export function validateProfileOverlay(input: unknown): asserts input is DsmmProfileOverlay {
  let plain: unknown;
  try { plain = copyJson(input); } catch { invalid("settings", "must be plain JSON"); }
  const overlay = record(plain, "settings");
  keys(overlay, OVERLAY_FIELDS, "settings");
  optional(overlay, "defaultActive", bool, "settings");
  optional(overlay, "modelParameters", (value, field) => {
    const parameters = record(value, field);
    keys(parameters, ["passthrough"], field);
    optional(parameters, "passthrough", bool, field);
  }, "settings");
  optional(overlay, "roleRouting", roleRouting, "settings");
  optional(overlay, "runtimePolicy", runtimePolicy, "settings");
  optional(overlay, "workflow", workflow, "settings");
  optional(overlay, "guards", guards, "settings");
  optional(overlay, "runtimeRecovery", recovery, "settings");
  optional(overlay, "locale", (value, field) => enumeration(value, DSMM_LOCALES, field), "settings");
  optional(overlay, "roles", (value, field) => {
    const roles = record(value, field);
    keys(roles, DSMM_ROLE_IDS, field);
    for (const [role, enabled] of Object.entries(roles)) bool(enabled, `${field}.${role}`);
  }, "settings");
  optional(overlay, "subagents", (value, field) => {
    const settings = record(value, field);
    keys(settings, ["toolTopology"], field);
    optional(settings, "toolTopology", (value, path) => enumeration(value, ["per-role", "parameterized"], path), field);
  }, "settings");
  const settings = resolveConfig(overlay as DsmmProfileOverlay);
  for (const role of requiredDeepworkRoles(settings)) if ((overlay.roles as Record<string, unknown> | undefined)?.[role] === false) invalid(`settings.roles.${role}`, "is required", "required-role");
}

export function mergeProfileConfig(baseline: DsmmPluginConfig, overlay: DsmmProfileOverlay): DsmmPluginConfig {
  return mergeRecords(copyJson(baseline) as Record<string, unknown>, copyJson(overlay) as Record<string, unknown>) as DsmmPluginConfig;
}

export function resolveProfileSettings(baseline: DsmmPluginConfig, overlay: DsmmProfileOverlay): DsmmSettings {
  const ceiling = resolveConfig(baseline);
  const settings = resolveConfig(mergeProfileConfig(baseline, overlay));
  for (const role of requiredDeepworkRoles(settings)) if (overlay.roles?.[role] === false) invalid(`settings.roles.${role}`, "is required", "required-role");
  for (const [role, enabled] of Object.entries(overlay.roles ?? {})) if (enabled && (!ceiling.modules.deepwork.enabled || !ceiling.roles[role as DsmmRoleId])) invalid(`settings.roles.${role}`, "exceeds captured deployment", "deployment-ceiling");
  return settings;
}

export function requiredDeepworkRoles(settings: Pick<DsmmSettings, "workflow">): DsmmRoleId[] {
  const required: DsmmRoleId[] = ["dsmm-orchestrator", "dsmm-planner", "dsmm-plan-critic"];
  if (settings.workflow.policy === "legacy") {
    if (settings.workflow.finalReviewPolicy !== "off") required.push("dsmm-reviewer");
    if (settings.workflow.finalReviewPolicy === "simple-oracle-complex-reviewer") required.push("dsmm-oracle");
  }
  return required;
}
export function requiredReason(settings: Pick<DsmmSettings, "workflow">, role: DsmmRoleId): "deepwork-planning" | "legacy-review" | undefined {
  if (!requiredDeepworkRoles(settings).includes(role)) return undefined;
  return ["dsmm-orchestrator", "dsmm-planner", "dsmm-plan-critic"].includes(role) ? "deepwork-planning" : "legacy-review";
}

function mergeRecords(baseline: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(baseline)) result[key] = clone(value);
  for (const [key, value] of Object.entries(overlay)) {
    // Routes are complete values, whereas each role's policy keys merge independently.
    result[key] = !["primary", "low", "high", "max"].includes(key) && isRecord(value) && isRecord(result[key]) ? mergeRecords(result[key], value) : clone(value);
  }
  return result;
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  return isRecord(value) ? mergeRecords({}, value) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(field, "must be an object");
  return value;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], field: string, _extra = "Remove unsupported fields before saving."): void {
  for (const key of DEPRECATED_DSMM_FIELDS) if (Object.hasOwn(value, key)) throw new DsmmConfigValidationError("deprecated-field", [...field === "document" ? [] : field.split("."), key]);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new DsmmConfigValidationError("unknown-field", [...field === "document" ? [] : field.split("."), key]);
  }
}

function optional(value: Record<string, unknown>, key: string, validator: (value: unknown, field: string) => void, field: string): void {
  if (Object.hasOwn(value, key)) validator(value[key], `${field}.${key}`);
}

function invalid(field: string, _message: string, code: ProfileDiagnosticCode = "invalid-type"): never {
  const info = diagnostic(code, field);
  throw new DsmmProfileError("validation", `${info.field}: ${info.reason}`, info.field, code);
}

function bool(value: unknown, field: string): void {
  if (typeof value !== "boolean") invalid(field, "must be true or false");
}

function string(value: unknown, field: string, maximum: number): void {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum || /[\u0000-\u001F\u007F]/u.test(value)) invalid(field, `must be nonempty text of at most ${maximum} characters without control characters`);
}

function enumeration(value: unknown, allowed: readonly string[], field: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) invalid(field, `must be one of ${allowed.join(", ")}`, "unsupported-value");
}

function integer(value: unknown, field: string, minimum: number, maximum: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(field, `must be an integer from ${minimum} to ${maximum}`);
}

function array(value: unknown, field: string, maximum: number, validator: (value: unknown, field: string) => void): void {
  if (!Array.isArray(value) || value.length > maximum) invalid(field, `must be an array with at most ${maximum} entries`);
  value.forEach((item, index) => validator(item, `${field}[${index}]`));
}

function route(value: unknown, field: string): void {
  try { normalizeModelRouteJson(value); } catch { invalid(field, "must be a valid model route", "invalid-route"); }
}

function routeList(value: unknown, field: string): void {
  array(value, field, 32, route);
}

function roleRouting(value: unknown, field: string): void {
  const item = record(value, field);
  keys(item, DSMM_ROLE_IDS, field);
  for (const [role, raw] of Object.entries(item)) {
    const path = `${field}.${role}`;
    const policy = record(raw, path);
    keys(policy, ["primary", "fallbackRoutes", "strategy", "rateLimit", "levels"], path);
    optional(policy, "levels", (value, field) => {
      if (role === "dsmm-orchestrator") invalid(field, "root model is native-owned", "unsupported-value");
      const levels = record(value, field);
      if (Object.hasOwn(levels, "normal")) invalid(`${field}.normal`, "normal is a read-only default alias", "unsupported-value");
      keys(levels, ["low", "high", "max"], field);
      for (const [level, override] of Object.entries(levels)) {
        const at = `${field}.${level}`;
        normalizeLevelOverride(override, at);
        if (isRecord(override) && (Object.hasOwn(override, "provider") || Object.hasOwn(override, "model"))) route(override, at);
        else string((override as Record<string, unknown>).reasoningEffort, `${at}.reasoningEffort`, 64);
      }
    }, path);
    optional(policy, "primary", route, path);
    optional(policy, "fallbackRoutes", routeList, path);
    optional(policy, "strategy", strategy, path);
    optional(policy, "rateLimit", rateLimit, path);
  }
}

function strategy(value: unknown, field: string): void {
  try { normalizeRoutingStrategy(value); }
  catch { invalid(field, "must be startup-lock or rate-limit-fallback", "unsupported-value"); }
}

function rateLimit(value: unknown, field: string): void {
  const item = record(value, field);
  keys(item, Object.keys(DSMM_RATE_LIMIT_BOUNDS), field);
  for (const [key, value] of Object.entries(item)) {
    const [min, max] = DSMM_RATE_LIMIT_BOUNDS[key as keyof typeof DSMM_RATE_LIMIT_BOUNDS];
    integer(value, `${field}.${key}`, min, max);
  }
  try { normalizeRateLimitOverrides(value); }
  catch { invalid(field, "must contain only bounded integer retry, delay, threshold and switch fields"); }
}

function runtimePolicy(value: unknown, field: string): void {
  const item = record(value, field);
  keys(item, ["strategy", "rateLimit"], field);
  optional(item, "strategy", strategy, field);
  optional(item, "rateLimit", rateLimit, field);
  try { normalizeRuntimePolicy(value); }
  catch { invalid(field, "must contain a valid strategy and bounded rateLimit policy"); }
}

function workflow(value: unknown, field: string): void {
  const item = record(value, field);
  keys(item, ["policy", "strictGates", "reviewCap", "finalReviewPolicy"], field);
  optional(item, "policy", (policy, path) => enumeration(policy, ["risk-based", "legacy"], path), field);
  optional(item, "strictGates", bool, field);
  optional(item, "reviewCap", (cap, path) => integer(cap, path, 0, 10), field);
  optional(item, "finalReviewPolicy", (policy, path) => enumeration(policy, ["simple-oracle-complex-reviewer", "reviewer-only", "off"], path), field);
}

function guards(value: unknown, field: string): void {
  const item = record(value, field);
  keys(item, ["scope", "shellCommandSafety", "gitWriteGuard", "toolOutputTruncation", "planFormatValidation", "questionLabelHelper", "todoDisciplineHelper"], field);
  optional(item, "scope", (scope, path) => enumeration(scope, ["deepwork-or-dsmm-agent", "always", "off"], path), field);
  optional(item, "gitWriteGuard", (policy, path) => enumeration(policy, ["ask", "deny", "off"], path), field);
  for (const key of ["shellCommandSafety", "planFormatValidation", "todoDisciplineHelper"]) optional(item, key, bool, field);
  optional(item, "toolOutputTruncation", (raw, path) => {
    const nested = record(raw, path);
    keys(nested, ["enabled", "maxInlineBytes"], path);
    optional(nested, "enabled", bool, path);
    optional(nested, "maxInlineBytes", (bytes, at) => integer(bytes, at, 1, 1024 * 1024), path);
  }, field);
  optional(item, "questionLabelHelper", (raw, path) => {
    const nested = record(raw, path);
    keys(nested, ["enabled", "maxLabelChars"], path);
    optional(nested, "enabled", bool, path);
    optional(nested, "maxLabelChars", (chars, at) => integer(chars, at, 1, 256), path);
  }, field);
}

function recovery(value: unknown, field: string): void {
  const item = record(value, field);
  keys(item, ["enabled", "retryOnStatusCodes", "retryOnCodes", "fallbackRoutes", "maxFallbackAttempts", "idleContinuation"], field);
  optional(item, "enabled", bool, field);
  optional(item, "retryOnStatusCodes", (raw, path) => array(raw, path, 64, (status, at) => integer(status, at, 100, 599)), field);
  optional(item, "retryOnCodes", (raw, path) => array(raw, path, 64, (code, at) => string(code, at, 128)), field);
  optional(item, "fallbackRoutes", routeList, field);
  optional(item, "maxFallbackAttempts", (attempts, path) => integer(attempts, path, 0, 10), field);
  optional(item, "idleContinuation", (raw, path) => {
    const nested = record(raw, path);
    keys(nested, ["enabled", "maxContinuations", "prompt"], path);
    optional(nested, "enabled", bool, path);
    optional(nested, "maxContinuations", (count, at) => integer(count, at, 0, 10), path);
    optional(nested, "prompt", (prompt, at) => {
      if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > 8192 || prompt.includes("\0")) invalid(at, "must be nonempty text of at most 8192 characters without NUL");
    }, path);
  }, field);
}
