import type { InvocationDescriptor, RemoteResult, TypertCodec, TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";
import type { TypertContribution } from "@deepseek-ai/dsh-typert-registry";
import type { DsmmRoleRuntimeState, ProfileErrorInfo, ProfileReadResult, ProfileSaveRequest, ProfileSelectRequest, ProfileSelectionState, ProfileSnapshot, SessionModeSelectRequest, SessionProfileSelectRequest, SessionProfileSnapshot } from "./profile-types.js";
import { DSMM_RATE_LIMIT_BOUNDS, normalizeRateLimitOverrides, normalizeRateLimitPolicy, normalizeRoutingStrategy } from "./routing-policy.js";
import type { DsmmRoleId } from "./roles.js";
import type { DsmmModelRoute } from "./settings.js";
import type { GlobalConfigSaveRequest, GlobalConfigSnapshot } from "./deployment-config.js";
import type { DsmmModuleState } from "./modules.js";
import { DSMM_MODULE_DESCRIPTORS } from "./modules.js";
import type { DeploymentEditorSnapshot, DeploymentAdmissionView } from "./profile-types.js";
import { parseModelParameterPolicy } from "./model-parameter-policy.js";
import type { DsmmRoleAvailabilityState, ProfileDiagnostic, ProfileDiagnosticLocation, SubagentRuntimeAdmissionView } from "./profile-types.js";
import { DSMM_ROUTE_SOURCES } from "./profile-types.js";
import type { DsmmInvocationView, DsmmInitialRoleRoute, DsmmLiveRoleRoute, DsmmRoleRouteComparison } from "./profile-types.js";
import { diagnostic, isSafeDiagnosticField, PROFILE_DIAGNOSTIC_REASONS } from "./profile-diagnostics.js";
import { normalizeModelRouteJson } from "./route-json.js";
import { isConfigRevision, isProfileReference } from "./config-revision.js";

export interface DsmmConfigRemote {
  describe(): Promise<RemoteResult<GlobalConfigSnapshot>>;
  save(request: GlobalConfigSaveRequest): Promise<RemoteResult<GlobalConfigSnapshot>>;
  describeModules(): Promise<RemoteResult<DsmmModuleState[]>>;
  describeSettings(): Promise<RemoteResult<DeploymentEditorSnapshot>>;
}

export interface DsmmProfilesRemote {
  describe(): Promise<RemoteResult<ProfileSnapshot>>;
  read(id: string): Promise<RemoteResult<ProfileReadResult>>;
  save(request: ProfileSaveRequest): Promise<RemoteResult<ProfileReadResult>>;
  select(request: ProfileSelectRequest): Promise<RemoteResult<ProfileSnapshot>>;
  describeSession(sessionId: string): Promise<RemoteResult<SessionProfileSnapshot>>;
  selectSession(sessionId: string, request: SessionProfileSelectRequest): Promise<RemoteResult<SessionProfileSnapshot>>;
  selectMode?(sessionId: string, request: SessionModeSelectRequest): Promise<RemoteResult<SessionProfileSnapshot>>;
}

declare module "@deepseek-ai/dsh-typert-protocol/types" {
  interface TypertRemoteMap {
    "dsmmConfig/describe": () => Promise<RemoteResult<GlobalConfigSnapshot>>;
    "dsmmConfig/save": (request: GlobalConfigSaveRequest) => Promise<RemoteResult<GlobalConfigSnapshot>>;
    "dsmmConfig/describeModules": () => Promise<RemoteResult<DsmmModuleState[]>>;
    "dsmmConfig/describeSettings": DsmmConfigRemote["describeSettings"];
    "dsmmProfiles/describe": DsmmProfilesRemote["describe"];
    "dsmmProfiles/read": DsmmProfilesRemote["read"];
    "dsmmProfiles/save": DsmmProfilesRemote["save"];
    "dsmmProfiles/select": DsmmProfilesRemote["select"];
    "dsmmProfiles/describeSession": DsmmProfilesRemote["describeSession"];
    "dsmmProfiles/selectSession": DsmmProfilesRemote["selectSession"];
    "dsmmProfiles/selectMode": NonNullable<DsmmProfilesRemote["selectMode"]>;
  }
  interface TypertRemoteNamespaceMap {
    dsmmProfiles: DsmmProfilesRemote;
    dsmmConfig: DsmmConfigRemote;
  }
  interface RemoteErrorDetailsMap {
    "dsmm-profiles/refused": ProfileErrorInfo;
    "dsmm-profiles/peer-required": {};
  }
}

const errorCodes = new Set(["validation", "conflict", "not-found", "lock-timeout", "unsafe-path", "io", "activation", "corrupt-selection", "limit", "busy", "maintenance", "disposed", "not-owned", "unavailable", "cancelled"]);
const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const revisionPattern = /^[a-f0-9]{64}$/u;
const rolePattern = /^dsmm-(?:orchestrator|planner|plan-critic|builder|reviewer|oracle|oracle-2nd|creative|code-search|doc-search|clarifier|media-reader|frontend|hard-reasoning|research|quick|coding|normal-task|complex|deep|documenting|cross-cutting)$/u;

/** Shared wire grammar for native codec validation and local form feedback. */
export function isProfileId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value)
    && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(value);
}

function fail(field: string): never { throw new TypeError(`Invalid Deepwork profile wire field: ${field}`); }
function text(value: unknown, field: string, maximum = 1024): string {
  if (typeof value !== "string" || value.length > maximum) fail(field);
  return value;
}
function id(value: unknown): string {
  const result = text(value, "id", 64);
  if (!isProfileId(result)) fail("id");
  return result;
}
function revision(value: unknown): string {
  const result = text(value, "revision", 128);
  if (!isConfigRevision(result)) fail("revision");
  return result;
}
function epoch(value: unknown): string {
  if (typeof value !== "string" || !revisionPattern.test(value)) fail("epoch");
  return value;
}
function reference(value: unknown): string {
  if (!isProfileReference(value)) fail("reference");
  return value;
}
function modeRevision(value: unknown): string {
  if (typeof value !== "string" || !(/^(?:[a-f0-9]{64}|mode-v1-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u).test(value)) fail("mode revision");
  return value;
}
function refresh(value: unknown): true { if (value !== true) fail("refreshRequired"); return true; }
function observedRevision(value: unknown, row: Record<string, unknown>): string {
  return value === "unavailable" && row.refreshRequired === true ? value : selectionRevision(value);
}
function selectionRevision(value: unknown): string { return value === "absent" ? value : revision(value); }
/** Opaque native identities are never interpreted as paths. */
export function isNativeSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value;
}
function sessionId(value: unknown): string {
  if (!isNativeSessionId(value)) fail("sessionId");
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field);
  return value;
}
function integer(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) fail(field);
  return value;
}
function role(value: unknown): DsmmRoleId {
  if (typeof value !== "string" || !rolePattern.test(value)) fail("role");
  return value as DsmmRoleId;
}
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("object");
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null || Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some(property => !Object.hasOwn(property, "value") || !property.enumerable)) fail("object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !required.includes(key) && !optional.includes(key))
    || required.some((key) => !Object.hasOwn(result, key))) fail("object keys");
  return result;
}
function optional<T>(value: Record<string, unknown>, key: string, parse: (input: unknown) => T): Record<string, T> {
  return Object.hasOwn(value, key) ? { [key]: parse(value[key]) } : {};
}
export function parseProfileErrorInfo(value: unknown): ProfileErrorInfo {
  const item = object(value, ["code", "message"], ["field", "reason", "location"]);
  const code = text(item.code, "code");
  if (!errorCodes.has(code)) fail("code");
  const reason = item.reason === undefined ? undefined : text(item.reason, "reason", 64);
  if (reason !== undefined && (!Object.hasOwn(PROFILE_DIAGNOSTIC_REASONS, reason) || reason === "blank-label")) fail("reason");
  const field = item.field === undefined ? undefined : diagnosticField(item.field);
  return { code: code as ProfileErrorInfo["code"], message: reason === undefined ? text(item.message, "message", 4096) : `${field ?? "document"}: ${diagnostic(reason as ProfileDiagnostic["code"], field ?? "document").reason}`,
    ...(field === undefined ? {} : { field }), ...(reason === undefined ? {} : { reason: reason as ProfileDiagnostic["code"] }), ...optional(item, "location", diagnosticPosition) };
}
const errorInfo = parseProfileErrorInfo;
function diagnosticField(value: unknown): string { if (!isSafeDiagnosticField(value)) fail("field"); return value; }
function diagnosticPosition(value: unknown): ProfileDiagnosticLocation {
  const item = object(value, ["offset", "length", "line", "column"]);
  const result = { offset: integer(item.offset, "offset", 128 * 1024), length: integer(item.length, "length", 128 * 1024), line: integer(item.line, "line", 128 * 1024 + 1), column: integer(item.column, "column", 128 * 1024 + 1) };
  if (result.line < 1 || result.column < 1 || result.offset + result.length > 128 * 1024) fail("location");
  return result;
}
export function parseProfileDiagnostic(value: unknown): ProfileDiagnostic {
  const row = object(value, ["severity", "code", "field", "reason"], ["location"]);
  if (typeof row.code !== "string" || !Object.hasOwn(PROFILE_DIAGNOSTIC_REASONS, row.code)) fail("diagnostic code");
  const result = diagnostic(row.code as ProfileDiagnostic["code"], diagnosticField(row.field));
  if (row.severity !== result.severity || row.reason !== result.reason) fail("diagnostic severity/reason");
  return { ...result, ...optional(row, "location", diagnosticPosition) };
}
function warnings(value: unknown): ProfileDiagnostic[] {
  if (!Array.isArray(value) || value.length > 1) fail("warnings");
  return value.map(value => {
    const result = parseProfileDiagnostic(value);
    if (result.severity !== "warning" || result.code !== "blank-label" || result.field !== "label") fail("warning");
    return result;
  });
}
export function parseRoleAvailability(value: unknown): DsmmRoleAvailabilityState {
  const row = object(value, ["id", "required", "startupAvailable", "deploymentEnabled", "admitted", "source", "capture"], ["requiredReason", "namedEnabled", "reason"]);
  if (typeof row.source !== "string" || !["defaults", "global", "profile", "named-session"].includes(row.source) || typeof row.capture !== "string" || !["startup", "deployment", "named-session"].includes(row.capture)) fail("role source/capture");
  if (row.reason !== undefined && (typeof row.reason !== "string" || !["module-off", "deployment-disabled", "startup-unavailable", "profile-disabled", "required-role", "current-root-disabled"].includes(row.reason))) fail("role reason");
  if (row.requiredReason !== undefined && (typeof row.requiredReason !== "string" || !["deepwork-planning", "legacy-review"].includes(row.requiredReason))) fail("requiredReason");
  return { id: role(row.id), required: boolean(row.required, "required"), startupAvailable: boolean(row.startupAvailable, "startupAvailable"), deploymentEnabled: boolean(row.deploymentEnabled, "deploymentEnabled"), admitted: boolean(row.admitted, "admitted"), source: row.source as DsmmRoleAvailabilityState["source"], capture: row.capture as DsmmRoleAvailabilityState["capture"],
    ...optional(row, "namedEnabled", value => boolean(value, "namedEnabled")), ...(row.reason === undefined ? {} : { reason: row.reason as DsmmRoleAvailabilityState["reason"] }), ...(row.requiredReason === undefined ? {} : { requiredReason: row.requiredReason as DsmmRoleAvailabilityState["requiredReason"] }) };
}
function roleAvailabilityList(value: unknown): DsmmRoleAvailabilityState[] {
  if (!Array.isArray(value) || value.length > 22) fail("roles");
  const result = value.map(parseRoleAvailability);
  if (new Set(result.map(role => role.id)).size !== result.length) fail("roles");
  return result;
}
export function parseSubagentRuntimeAdmissionView(value: unknown): SubagentRuntimeAdmissionView {
  const row = object(value, ["binding", "deliveryFenceReady", "restartRequired"], ["reason"]);
  if (typeof row.binding !== "string" || !["stock", "unavailable"].includes(row.binding) || row.reason !== undefined && row.reason !== "authority-not-ready") fail("subagentRuntime");
  const ready = boolean(row.deliveryFenceReady, "deliveryFenceReady");
  if (ready && (row.binding === "unavailable" || row.reason !== undefined)) fail("subagentRuntime readiness");
  return { binding: row.binding as SubagentRuntimeAdmissionView["binding"], deliveryFenceReady: ready, restartRequired: boolean(row.restartRequired, "restartRequired"), ...(row.reason === undefined ? {} : { reason: row.reason as SubagentRuntimeAdmissionView["reason"] }) };
}
function readResult(value: unknown): ProfileReadResult {
  const item = object(value, ["id", "revision", "content"], ["label", "warnings", "refreshRequired"]);
  return { id: id(item.id), revision: item.revision === "unavailable" && item.refreshRequired === true ? "unavailable" : revision(item.revision), content: content(item.content), ...optional(item, "refreshRequired", refresh), ...optional(item, "label", (input) => text(input, "label", 120)), ...optional(item, "warnings", warnings) };
}
function content(value: unknown): string {
  const result = text(value, "content", 128 * 1024);
  if (new TextEncoder().encode(result).byteLength > 128 * 1024) fail("content");
  return result;
}
function snapshot(value: unknown): ProfileSnapshot {
  const item = object(value, ["profiles", "selectedId", "appliedRevision", "selectionRevision"], ["selectionError", "roles", "editorDefaults", "origin", "readOnly", "writeRestriction", "selectedWarnings", "sourceRevision", "refreshRequired"]);
  if (!Array.isArray(item.profiles) || item.profiles.length > 128) fail("profiles");
  return {
    profiles: item.profiles.map((input) => {
      const row = object(input, ["id", "revision"], ["label", "error", "warnings"]);
      return { id: text(row.id, "id", 64), revision: row.revision === null ? null : revision(row.revision), ...optional(row, "label", (input) => text(input, "label", 120)), ...optional(row, "error", errorInfo), ...optional(row, "warnings", warnings) };
    }),
    selectedId: item.selectedId === null ? null : id(item.selectedId),
    appliedRevision: item.appliedRevision === null ? null : reference(item.appliedRevision),
    selectionRevision: item.selectionRevision === "unavailable" && Object.hasOwn(item, "selectionError") ? "unavailable" : observedRevision(item.selectionRevision, item),
    ...optional(item, "sourceRevision", revision), ...optional(item, "refreshRequired", refresh),
    ...optional(item, "selectionError", errorInfo),
    ...optional(item, "selectedWarnings", warnings),
    ...optional(item, "roles", (input) => {
      if (!Array.isArray(input) || input.length > 22) fail("roles");
      const result = input.map((value) => {
        const row = object(value, ["id", "label", "enabled"], ["runtimePolicy", "availability"]);
        return { id: role(row.id), label: text(row.label, "label", 120), enabled: boolean(row.enabled, "enabled"), ...optional(row, "availability", parseRoleAvailability), ...optional(row, "runtimePolicy", (input) => {
          const policy = object(input, [], ["strategy", "rateLimit"]);
          return { ...optional(policy, "strategy", normalizeRoutingStrategy), ...optional(policy, "rateLimit", normalizeRateLimitOverrides) };
        }) };
      });
      if (new Set(result.map((row) => row.id)).size !== result.length) fail("roles");
      return result;
    }),
    ...optional(item, "editorDefaults", runtimePolicy),
    ...optional(item, "origin", (input) => { if (typeof input !== "string" || !["central", "legacy", "explicit"].includes(input)) fail("origin"); return input as "central" | "legacy" | "explicit"; }),
    ...optional(item, "readOnly", (input) => boolean(input, "readOnly")),
    ...optional(item, "writeRestriction", (input) => text(input, "writeRestriction", 1024)),
  };
}
function rateLimit(value: unknown): DsmmRoleRuntimeState["rateLimit"] {
  const item = object(value, Object.keys(DSMM_RATE_LIMIT_BOUNDS));
  return normalizeRateLimitPolicy(item);
}
function runtimePolicy(value: unknown): Pick<DsmmRoleRuntimeState, "strategy" | "rateLimit"> {
  const item = object(value, ["strategy", "rateLimit"]);
  return { strategy: normalizeRoutingStrategy(item.strategy), rateLimit: rateLimit(item.rateLimit) };
}
function rolePolicy(value: unknown): DsmmRoleRuntimeState {
  const item = object(value, ["strategy", "rateLimit", "retries", "rateLimitFailures", "switches", "totalDelayMs"], ["role", "route"]);
  return {
    ...runtimePolicy({ strategy: item.strategy, rateLimit: item.rateLimit }),
    retries: integer(item.retries, "retries", 10),
    rateLimitFailures: integer(item.rateLimitFailures, "rateLimitFailures"),
    switches: integer(item.switches, "switches", 10),
    totalDelayMs: integer(item.totalDelayMs, "totalDelayMs", 120000),
    ...optional(item, "role", role),
    ...optional(item, "route", modelRoute),
  };
}
function modelRoute(value: unknown): DsmmModelRoute {
  return normalizeModelRouteJson(value);
}
function initialRoleRoute(value: unknown): DsmmInitialRoleRoute {
  const row = object(value, ["status"], ["source", "route", "reason"]);
  if (row.status === "known") {
    object(row, ["status", "source", "route"]);
    if (row.source !== "invocation-capture") fail("initialRoute source");
    return { status: "known", source: "invocation-capture", route: modelRoute(row.route) };
  }
  object(row, ["status", "reason"]);
  if (row.status !== "unknown" || row.reason !== "missing-invocation-capture") fail("initialRoute reason");
  return { status: "unknown", reason: "missing-invocation-capture" };
}
function liveRoleRoute(value: unknown): DsmmLiveRoleRoute {
  const row = object(value, ["status"], ["source", "route", "reason"]);
  if (row.status === "known") {
    object(row, ["status", "source", "route"]);
    if (row.source !== "own-native-request-header") fail("liveRoute source");
    return { status: "known", source: "own-native-request-header", route: modelRoute(row.route) };
  }
  object(row, ["status", "reason"]);
  if (row.status !== "unknown" || typeof row.reason !== "string" || !["no-own-request-header", "invalid-own-request-header", "not-observed"].includes(row.reason)) fail("liveRoute reason");
  return { status: "unknown", reason: row.reason as Extract<DsmmLiveRoleRoute, { status: "unknown" }>["reason"] };
}
export function parseDsmmRoleRouteComparison(value: unknown): DsmmRoleRouteComparison {
  const row = object(jsonData(value), ["childId", "initialRoute", "liveRoute"]);
  return { childId: sessionId(row.childId), initialRoute: initialRoleRoute(row.initialRoute), liveRoute: liveRoleRoute(row.liveRoute) };
}
export function parseDsmmInvocationView(value: unknown): DsmmInvocationView {
  const row = object(jsonData(value), ["role", "label", "level", "routeSource", "mode"], ["route", "runId", "childId", "jobId", "routeComparison"]);
  if (typeof row.level !== "string" || !["normal", "low", "high", "max"].includes(row.level) || !(DSMM_ROUTE_SOURCES as readonly unknown[]).includes(row.routeSource) || typeof row.mode !== "string" || !["one-shot", "continuable"].includes(row.mode)) fail("invocation");
  const target = role(row.role);
  if (target === "dsmm-orchestrator") fail("invocation target");
  const routeComparison = Object.hasOwn(row, "routeComparison") ? parseDsmmRoleRouteComparison(row.routeComparison) : undefined;
  if (routeComparison !== undefined && (!Object.hasOwn(row, "childId") || routeComparison.childId !== row.childId)) fail("invocation routeComparison childId");
  return { role: target, label: text(row.label, "label", 120), level: row.level as DsmmInvocationView["level"], routeSource: row.routeSource as DsmmInvocationView["routeSource"], mode: row.mode as DsmmInvocationView["mode"], ...optional(row, "route", modelRoute), ...optional(row, "runId", sessionId), ...optional(row, "childId", sessionId), ...optional(row, "jobId", sessionId), ...(routeComparison === undefined ? {} : { routeComparison }) };
}
function selectionState(value: unknown): ProfileSelectionState {
  const item = object(value, ["selectedId", "appliedRevision", "selectionRevision"], ["sourceRevision", "refreshRequired"]);
  return { selectedId: item.selectedId === null ? null : id(item.selectedId), appliedRevision: item.appliedRevision === null ? null : reference(item.appliedRevision), selectionRevision: observedRevision(item.selectionRevision, item), ...optional(item, "sourceRevision", revision), ...optional(item, "refreshRequired", refresh) };
}
function actionUnavailableReason(value: unknown): NonNullable<SessionProfileSnapshot["selectModelUnavailableReason"]> {
  if (typeof value !== "string" || !["busy", "maintenance", "module-off", "runtime-unavailable", "model-unconfigured", "model-service-unavailable", "new-session-required"].includes(value)) fail("actionUnavailableReason");
  return value as NonNullable<SessionProfileSnapshot["selectModelUnavailableReason"]>;
}
function sessionSnapshot(value: unknown): SessionProfileSnapshot {
  const item = object(value, ["sessionId", "globalDefault", "selection", "scope", "admissionEpoch", "switchAllowed", "canSelectModel", "canToggleMode", "canApplyOverlay"], ["admittedSelection", "switchUnavailableReason", "selectModelUnavailableReason", "toggleModeUnavailableReason", "applyOverlayUnavailableReason", "rolePolicy", "profileModel", "deepwork", "modules", "configuration", "warnings", "roles", "subagentRuntime", "refreshRequired"]);
  if (typeof item.scope !== "string" || !["global-default", "session-override", "deployment-baseline"].includes(item.scope)) fail("scope");
  return {
    sessionId: sessionId(item.sessionId), globalDefault: selectionState(item.globalDefault), selection: selectionState(item.selection),
    scope: item.scope as SessionProfileSnapshot["scope"], admissionEpoch: epoch(item.admissionEpoch), switchAllowed: boolean(item.switchAllowed, "switchAllowed"),
    canSelectModel: boolean(item.canSelectModel, "canSelectModel"),
    canToggleMode: boolean(item.canToggleMode, "canToggleMode"),
    canApplyOverlay: boolean(item.canApplyOverlay, "canApplyOverlay"),
    ...optional(item, "selectModelUnavailableReason", actionUnavailableReason),
    ...optional(item, "toggleModeUnavailableReason", actionUnavailableReason),
    ...optional(item, "applyOverlayUnavailableReason", actionUnavailableReason),
    ...optional(item, "refreshRequired", refresh),
    ...optional(item, "admittedSelection", selectionState),
    ...optional(item, "switchUnavailableReason", (input) => {
      if (typeof input !== "string" || !["busy", "maintenance", "disposed", "not-owned", "unavailable"].includes(input)) fail("switchUnavailableReason");
      return input as NonNullable<SessionProfileSnapshot["switchUnavailableReason"]>;
    }),
    ...optional(item, "rolePolicy", rolePolicy),
    ...optional(item, "profileModel", modelRoute),
    ...optional(item, "modules", moduleStates),
    ...optional(item, "configuration", admissionView),
    ...optional(item, "warnings", warnings),
    ...optional(item, "roles", roleAvailabilityList),
    ...optional(item, "subagentRuntime", parseSubagentRuntimeAdmissionView),
    ...optional(item, "deepwork", (input) => {
      const mode = object(input, ["active", "explicit", "locked", "revision"]);
      return { active: boolean(mode.active, "active"), explicit: boolean(mode.explicit, "explicit"), locked: boolean(mode.locked, "locked"), revision: modeRevision(mode.revision) };
    }),
  };
}
function saveRequest(value: unknown): ProfileSaveRequest {
  const item = object(value, ["id", "content", "expectedRevision"]);
  return { id: id(item.id), content: content(item.content), expectedRevision: item.expectedRevision === null ? null : revision(item.expectedRevision) };
}
function selectRequest(value: unknown): ProfileSelectRequest {
  const item = object(value, ["id", "expectedSelectionRevision"], ["expectedRevision"]);
  const result: ProfileSelectRequest = { id: item.id === null ? null : id(item.id), expectedSelectionRevision: selectionRevision(item.expectedSelectionRevision), ...optional(item, "expectedRevision", revision) };
  if (result.id !== null && result.expectedRevision === undefined) fail("expectedRevision");
  if (result.id === null && result.expectedRevision !== undefined) fail("expectedRevision");
  return result;
}
function sessionSelectRequest(value: unknown): SessionProfileSelectRequest {
  const item = object(value, ["sessionId", "id", "expectedSelectionRevision", "expectedAdmissionEpoch"], ["expectedRevision"]);
  const { sessionId: inputSessionId, expectedAdmissionEpoch, ...profileRequest } = item;
  return { ...selectRequest(profileRequest), sessionId: sessionId(inputSessionId), expectedAdmissionEpoch: epoch(expectedAdmissionEpoch) };
}
function modeSelectRequest(value: unknown): SessionModeSelectRequest {
  const item = object(value, ["sessionId", "active", "expectedModeRevision", "expectedAdmissionEpoch"]);
  return { sessionId: sessionId(item.sessionId), active: boolean(item.active, "active"), expectedModeRevision: modeRevision(item.expectedModeRevision), expectedAdmissionEpoch: epoch(item.expectedAdmissionEpoch) };
}
function codec(symbol: string, parse: (value: unknown) => unknown): TypertCodec {
  return { mode: "strict", typeSymbol: `@dsmm/dsmm#${symbol}`, create: () => ({ parse: value => parse(jsonData(value)) }) };
}
function descriptor(method: string, result: TypertCodec, parameter?: { name: string; codec: TypertCodec }): InvocationDescriptor {
  return { id: `@dsmm/dsmm#dsmmProfiles/${method}`, service: "dsmmProfiles", namespace: "dsmmProfiles", method, invocation: { kind: "direct" }, parameters: parameter === undefined ? [] : [{ name: parameter.name, wire: parameter.name, source: "json", codec: parameter.codec }], result };
}

function jsonData(value: unknown, depth = 0, active = new Set<object>()): unknown {
  if (depth > 32) fail("JSON depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || active.has(value)) fail("JSON value");
  if (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype : Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("JSON object");
  if (Object.getOwnPropertySymbols(value).length) fail("JSON symbols");
  const properties = Object.getOwnPropertyDescriptors(value);
  for (const [key, property] of Object.entries(properties)) {
    if (Array.isArray(value) && key === "length") continue;
    if (!Object.hasOwn(property, "value") || !property.enumerable || Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(key)) fail("JSON property");
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) fail("JSON array holes");
  active.add(value);
  const result = Array.isArray(value) ? value.map((child) => jsonData(child, depth + 1, active)) : Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (["__proto__", "prototype", "constructor"].includes(key)) fail("JSON key");
    return [key, jsonData(child, depth + 1, active)];
  }));
  active.delete(value);
  return result;
}
function globalSnapshot(value: unknown): GlobalConfigSnapshot {
  const row = object(value, ["config", "revision"], ["refreshRequired"]);
  object(row.config, [], Object.keys(row.config as object));
  return { config: jsonData(row.config) as GlobalConfigSnapshot["config"], revision: observedRevision(row.revision, row), ...optional(row, "refreshRequired", refresh) };
}
function admissionView(value: unknown): DeploymentAdmissionView {
  const row = object(value, ["settings", "sources", "captures", "restartRequired", "named"], ["modelParameterPolicy"]);
  object(row.settings, [], Object.keys(row.settings as object));
  for (const key of ["sources", "captures"] as const) {
    const map = object(row[key], [], Object.keys(row[key] as object));
    for (const [path, value] of Object.entries(map)) { if (path.startsWith("lsp.env.")) fail("private environment field"); text(value, key, 128); }
  }
  if (!Array.isArray(row.restartRequired) || row.restartRequired.length > 256) fail("restartRequired");
  const named = row.named === null ? null : object(row.named, ["id", "revision"]);
  return { ...optional(row, "modelParameterPolicy", value => parseModelParameterPolicy(jsonData(value))), settings: readOnlySettingsData(row.settings), sources: jsonData(row.sources) as Record<string, string>,
    captures: jsonData(row.captures) as Record<string, string>, restartRequired: row.restartRequired.map(value => text(value, "field", 256)),
    named: named === null ? null : { id: id(named.id), revision: reference(named.revision) } };
}
function readOnlySettingsData(value: unknown): Record<string, unknown> {
  const settings = jsonData(value) as Record<string, unknown>;
  const configured = (value: unknown): void => { if (value !== "" && value !== "<configured>") fail("private configured value"); };
  if (settings.lsp !== undefined) {
    const lsp = object(settings.lsp, ["enabled", "serverName", "command", "args", "cwd", "env", "toolCallTimeoutMs", "failOnStartupError"]);
    configured(lsp.command); configured(lsp.cwd);
    if (!Array.isArray(lsp.args) || lsp.args.some(value => value !== "<configured>")) fail("private arguments");
    const env = object(lsp.env, [], Object.keys(lsp.env as object));
    for (const [key, value] of Object.entries(env)) if (!/^variable-[1-9][0-9]*$/u.test(key) || value !== "<redacted>") fail("private environment");
  }
  if (settings.presets !== undefined) {
    const presets = object(settings.presets, ["materialize"], ["root"]);
    if (presets.root !== undefined && presets.root !== "<configured>") fail("private directory");
  }
  if (settings.runtimeRecovery !== undefined) {
    const recovery = object(settings.runtimeRecovery, ["enabled", "retryOnStatusCodes", "retryOnCodes", "fallbackRoutes", "maxFallbackAttempts", "idleContinuation"]);
    const idle = object(recovery.idleContinuation, ["enabled", "maxContinuations", "prompt"]); configured(idle.prompt);
  }
  return settings;
}
function editorSnapshot(value: unknown): DeploymentEditorSnapshot {
  const row = object(value, ["entryId", "namespace", "hostProfileKey", "global", "globalRevision", "profile", "nativeRevision", "nativeFormRevision", "nativeForm", "desired", "sources", "startup", "defaults", "schema", "nextRoot", "modules"], ["startupSources", "nativeSchema", "subagentRuntime"]);
  const result = jsonData(row) as DeploymentEditorSnapshot;
  text(row.entryId, "entryId", 256); if (row.namespace !== null) text(row.namespace, "namespace", 256);
  epoch(row.hostProfileKey); selectionRevision(row.globalRevision);
  if (row.nativeRevision !== "unavailable" && (typeof row.nativeRevision !== "string" || !/^native-v1-\d+$/u.test(row.nativeRevision))) fail("nativeRevision");
  if (row.nativeFormRevision !== null) integer(row.nativeFormRevision, "nativeFormRevision");
  for (const key of ["global", "profile", "desired", "sources", "startup", "defaults", "schema"]) object(row[key], [], Object.keys(row[key] as object));
  if (row.nativeForm !== null) object(row.nativeForm, ["base", "user"]);
  if (row.nextRoot !== null) result.nextRoot = admissionView(row.nextRoot);
  result.desired = readOnlySettingsData(row.desired); result.startup = readOnlySettingsData(row.startup);
  result.schema = schemaNode(row.schema);
  if (row.nativeSchema !== undefined) result.nativeSchema = schemaNode(row.nativeSchema);
  if (row.subagentRuntime !== undefined) result.subagentRuntime = parseSubagentRuntimeAdmissionView(row.subagentRuntime);
  for (const map of [result.sources, result.startupSources]) {
    if (map === undefined) continue;
    object(map, [], Object.keys(map));
    for (const [path, value] of Object.entries(map)) { if (path.startsWith("lsp.env.")) fail("private environment field"); text(value, "source", 128); }
  }
  result.modules = moduleStates(row.modules);
  return result;
}
function schemaNode(value: unknown): DeploymentEditorSnapshot["schema"] {
  const row = object(value, ["type"], ["fields", "inner", "alternatives", "value", "min", "max", "step", "required", "keys", "nonempty", "additionalProperties"]);
  if (typeof row.type !== "string" || !["object", "dict", "array", "union", "const", "string", "number", "boolean"].includes(row.type)) fail("schema type");
  const node = { type: row.type } as DeploymentEditorSnapshot["schema"];
  if (row.fields !== undefined) node.fields = Object.fromEntries(Object.entries(object(row.fields, [], Object.keys(row.fields as object))).map(([key, child]) => [key, schemaNode(child)]));
  if (row.inner !== undefined) node.inner = schemaNode(row.inner);
  if (row.alternatives !== undefined) { if (!Array.isArray(row.alternatives)) fail("schema alternatives"); node.alternatives = row.alternatives.map(schemaNode); }
  if (Object.hasOwn(row, "value")) { if (!["string", "number", "boolean"].includes(typeof row.value)) fail("schema value"); node.value = row.value as string | number | boolean; }
  for (const key of ["min", "max", "step"] as const) if (row[key] !== undefined) { if (typeof row[key] !== "number" || !Number.isFinite(row[key])) fail("schema bound"); node[key] = row[key]; }
  if (row.required !== undefined) node.required = boolean(row.required, "schema required");
  if (row.nonempty !== undefined) { if (row.type !== "string") fail("schema nonempty"); node.nonempty = boolean(row.nonempty, "schema nonempty"); }
  if (Object.hasOwn(row, "additionalProperties")) { if (row.type !== "object" || row.additionalProperties !== "json") fail("schema additionalProperties"); node.additionalProperties = "json"; }
  if (row.keys !== undefined) { if (row.type !== "dict" || !Array.isArray(row.keys) || row.keys.length > 64) fail("schema keys"); node.keys = row.keys.map(key => text(key, "schema key", 128)); }
  return node;
}
function globalSaveRequest(value: unknown): GlobalConfigSaveRequest {
  const row = object(value, ["expectedRevision", "edits"]);
  if (!Array.isArray(row.edits) || row.edits.length > 128) fail("edits");
  return { expectedRevision: selectionRevision(row.expectedRevision), edits: row.edits.map((value) => {
    const edit = object(value, ["op", "path"], ["value"]);
    if (!Array.isArray(edit.path) || edit.path.length < 1 || edit.path.length > 8) fail("field path");
    const path = edit.path.map((part) => { const key = text(part, "field", 128); if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/u.test(key) || ["constructor", "prototype", "__proto__"].includes(key)) fail("field"); return key; });
    if (edit.op === "unset" && !Object.hasOwn(edit, "value")) return { op: "unset" as const, path };
    if (edit.op !== "set" || !Object.hasOwn(edit, "value")) fail("edit");
    return { op: "set" as const, path, value: jsonData(edit.value) };
  }) };
}
function configDescriptor(method: string, parameter?: TypertCodec): InvocationDescriptor {
  return { id: `@dsmm/dsmm#dsmmConfig/${method}`, service: "dsmmConfig", namespace: "dsmmConfig", method, invocation: { kind: "direct" },
    parameters: parameter === undefined ? [] : [{ name: "request", wire: "request", source: "json", codec: parameter }], result: codec("GlobalConfigSnapshot", globalSnapshot) };
}

function moduleStates(value: unknown): DsmmModuleState[] {
  if (!Array.isArray(value) || value.length !== DSMM_MODULE_DESCRIPTORS.length) fail("modules");
  const ids = new Set<string>();
  return value.map((value) => {
    const row = object(value, ["descriptor", "hostBundleEnabled", "desired", "startupMounted", "admitted", "nextRoot", "reason", "pending"]);
    const descriptor = object(row.descriptor, ["id", "label", "key"]);
    const known = DSMM_MODULE_DESCRIPTORS.find(known => known.id === descriptor.id);
    if (known === undefined || descriptor.label !== known.label || descriptor.key !== known.key || row.hostBundleEnabled !== "unknown" || ids.has(known.id)) fail("module descriptor");
    ids.add(known.id);
    const desired = object(row.desired, ["enabled", "source", "capture"]), next = object(row.nextRoot, ["admitted", "reason"]);
    if (typeof desired.source !== "string" || !["defaults", "global", "profile"].includes(desired.source) || typeof desired.capture !== "string" || !["current-global", "admission", "startup"].includes(desired.capture)
      || ![null, "global-disabled", "restart-required"].includes(next.reason as string | null)
      || ![null, "global-disabled", "restart-required", "captured-off"].includes(row.reason as string | null)) fail("module state");
    return { descriptor: { ...known }, hostBundleEnabled: "unknown",
      desired: { enabled: boolean(desired.enabled, "desired.enabled"), source: desired.source as DsmmModuleState["desired"]["source"], capture: desired.capture as DsmmModuleState["desired"]["capture"] },
      startupMounted: row.startupMounted === null ? null : boolean(row.startupMounted, "startupMounted"), admitted: row.admitted === null ? null : boolean(row.admitted, "admitted"),
      nextRoot: { admitted: next.admitted === null ? null : boolean(next.admitted, "nextRoot.admitted"), reason: next.reason as DsmmModuleState["nextRoot"]["reason"] },
      reason: row.reason as DsmmModuleState["reason"], pending: boolean(row.pending, "pending") };
  });
}

/** Explicit strict Host contract; no SRC fallback or browser-supplied authority. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: "@dsmm/dsmm",
  descriptors: [
    configDescriptor("describe"),
    configDescriptor("save", codec("GlobalConfigSaveRequest", globalSaveRequest)),
    { ...configDescriptor("describeModules"), result: codec("DsmmModuleStateArray", moduleStates) },
    { ...configDescriptor("describeSettings"), result: codec("DeploymentEditorSnapshot", editorSnapshot) },
    {
      ...descriptor("selectMode", codec("SessionProfileSnapshot", sessionSnapshot)),
      parameters: [
        { name: "sessionId", wire: "sessionId", source: "json", codec: codec("NativeSessionId", sessionId) },
        { name: "request", wire: "request", source: "json", codec: codec("SessionModeSelectRequest", modeSelectRequest) },
      ],
    },
    descriptor("describe", codec("ProfileSnapshot", snapshot)),
    descriptor("read", codec("ProfileReadResult", readResult), { name: "id", codec: codec("ProfileId", id) }),
    descriptor("save", codec("ProfileReadResult", readResult), { name: "request", codec: codec("ProfileSaveRequest", saveRequest) }),
    descriptor("select", codec("ProfileSnapshot", snapshot), { name: "request", codec: codec("ProfileSelectRequest", selectRequest) }),
    {
      ...descriptor("describeSession", codec("SessionProfileSnapshot", sessionSnapshot)),
      parameters: [{ name: "sessionId", wire: "sessionId", source: "json", codec: codec("NativeSessionId", sessionId) }],
    },
    {
      ...descriptor("selectSession", codec("SessionProfileSnapshot", sessionSnapshot)),
      parameters: [
        { name: "sessionId", wire: "sessionId", source: "json", codec: codec("NativeSessionId", sessionId) },
        { name: "request", wire: "request", source: "json", codec: codec("SessionProfileSelectRequest", sessionSelectRequest) },
      ],
    },
  ],
};

export const TYPERT_HOST: TypertContribution = {
  package: "@dsmm/dsmm", face: "host", schemas: [],
  model: { services: [], events: [], objects: [] }, invocations: TYPERT_REMOTE.descriptors,
};

export default TYPERT_REMOTE;
