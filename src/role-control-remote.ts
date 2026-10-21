import type { InvocationDescriptor, RemoteResult, TypertCodec, TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";
import type { TypertContribution } from "@deepseek-ai/dsh-typert-registry";
import { parseDsmmInvocationView, parseDsmmRoleRouteComparison, parseSubagentRuntimeAdmissionView, isNativeSessionId } from "./profile-remote.js";
import { ROLE_CONTROL_DISABLED_REASONS, ROLE_CONTROL_ERROR_CODES, ROLE_CONTROL_ERROR_FIELDS } from "./role-control-types.js";
import type { ChildSessionSnapshot, RoleControlAvailability, RoleControlCapabilities, RoleControlChildView, RoleControlDescendantsSnapshot, RoleControlErrorInfo, RoleControlInterruptRequest, SubagentInterruptReceipt, SubagentPromptReceipt, SubagentPromptRequest } from "./role-control-types.js";

export interface DsmmChildrenRemote {
  describe(sessionId: string): Promise<RemoteResult<ChildSessionSnapshot>>;
  descendants(sessionId: string): Promise<RemoteResult<RoleControlDescendantsSnapshot>>;
  prompt(sessionId: string, request: SubagentPromptRequest): Promise<RemoteResult<SubagentPromptReceipt>>;
  interrupt(sessionId: string, request: RoleControlInterruptRequest): Promise<RemoteResult<SubagentInterruptReceipt>>;
}
declare module "@deepseek-ai/dsh-typert-protocol/types" {
  interface TypertRemoteMap {
    "dsmmChildren/describe": DsmmChildrenRemote["describe"];
    "dsmmChildren/descendants": DsmmChildrenRemote["descendants"];
    "dsmmChildren/prompt": DsmmChildrenRemote["prompt"];
    "dsmmChildren/interrupt": DsmmChildrenRemote["interrupt"];
  }
  interface TypertRemoteNamespaceMap { dsmmChildren: DsmmChildrenRemote }
  interface RemoteErrorDetailsMap { "dsmm-children/refused": RoleControlErrorInfo }
}

function fail(): never { throw new TypeError("Invalid Deepwork child control DTO."); }
/** Reject executable/non-JSON shapes before accessing any properties. */
function json(value: unknown, depth = 0, active = new Set<object>()): unknown {
  if (depth > 24) fail();
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || active.has(value)) fail();
  const isArray = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype) && (isArray || Object.getPrototypeOf(value) !== null)) fail();
  if (Object.getOwnPropertySymbols(value).length) fail();
  for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (isArray && key === "length") continue;
    if (!Object.hasOwn(property, "value") || !property.enumerable || ["__proto__", "prototype", "constructor"].includes(key)
      || isArray && !/^(0|[1-9][0-9]*)$/u.test(key)) fail();
  }
  if (isArray && Object.keys(value).length !== value.length) fail();
  active.add(value);
  const result = isArray ? value.map(child => json(child, depth + 1, active)) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, json(child, depth + 1, active)]));
  active.delete(value);
  return result;
}
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) fail();
  return row;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T { if (!choices.includes(value as T)) fail(); return value as T; }
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)
    || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(value)) !== value) fail();
  return value;
}
function identity(value: unknown): string { if (!isNativeSessionId(value)) fail(); return value; }
function epoch(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(); return value; }
function array(value: unknown, max = 4096): unknown[] { if (!Array.isArray(value) || value.length > max) fail(); return value; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") fail(); return value; }
function depth(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 4096) fail(); return value; }
function availability(value: unknown): RoleControlAvailability {
  const row = object(value, ["enabled"], ["reason"]);
  if (row.enabled === true && !Object.hasOwn(row, "reason")) return { enabled: true };
  if (row.enabled !== false) fail();
  return { enabled: false, reason: choice(row.reason, ROLE_CONTROL_DISABLED_REASONS) };
}
function capabilities(value: unknown): RoleControlCapabilities {
  const row = object(value, ["prompt", "interrupt", "images", "runtime"]);
  return { prompt: availability(row.prompt), interrupt: availability(row.interrupt), images: availability(row.images), runtime: parseSubagentRuntimeAdmissionView(row.runtime) };
}
function child(value: unknown): RoleControlChildView {
  const row = object(value, ["id", "parentSessionId", "mode", "activity", "readonly", "controls"], ["label", "invocation", "routeComparison"]);
  const controls = object(row.controls, ["prompt", "interrupt"]);
  const mode = choice(row.mode, ["one-shot", "continuable", "unknown"] as const);
  const prompt = availability(controls.prompt), interrupt = availability(controls.interrupt);
  const readonly = bool(row.readonly);
  if (readonly !== (!prompt.enabled && !interrupt.enabled) || mode !== "continuable" && (prompt.enabled || interrupt.enabled)) fail();
  const invocation = Object.hasOwn(row, "invocation") ? parseDsmmInvocationView(row.invocation) : undefined;
  const routeComparison = Object.hasOwn(row, "routeComparison") ? parseDsmmRoleRouteComparison(row.routeComparison) : undefined;
  const id = identity(row.id);
  if (invocation !== undefined && (invocation.childId !== id || invocation.mode !== mode)) fail();
  if (routeComparison !== undefined && routeComparison.childId !== id) fail();
  return { id, parentSessionId: identity(row.parentSessionId), mode, activity: choice(row.activity, ["running", "inactive"] as const), readonly,
    controls: { prompt, interrupt }, ...(Object.hasOwn(row, "label") ? { label: text(row.label, 120) } : {}),
    ...(invocation === undefined ? {} : { invocation }), ...(routeComparison === undefined ? {} : { routeComparison }) };
}
function snapshot(value: unknown): ChildSessionSnapshot {
  const row = object(value, ["sessionId", "admissionEpoch", "children", "capabilities"]);
  const sessionId = identity(row.sessionId), admissionEpoch = epoch(row.admissionEpoch), children = array(row.children).map(child);
  if (children.some(child => child.parentSessionId !== sessionId)) fail();
  return { sessionId, admissionEpoch, children, capabilities: capabilities(row.capabilities) };
}
function descendants(value: unknown): RoleControlDescendantsSnapshot {
  const row = object(value, ["sessionId", "admissionEpoch", "descendants"]);
  const sessionId = identity(row.sessionId), admissionEpoch = epoch(row.admissionEpoch);
  const entries: RoleControlDescendantsSnapshot["descendants"] = array(row.descendants).map(value => {
    const entry = object(value, ["kind", "depth"], ["child", "hasChildren", "id", "parentSessionId", "reason"]);
    if (entry.kind === "child") {
      object(entry, ["kind", "depth", "child", "hasChildren"]);
      const projected = child(entry.child);
      if (entry.depth !== 1 && (projected.controls.prompt.enabled || projected.controls.interrupt.enabled)) fail();
      return { kind: "child" as const, depth: depth(entry.depth), child: projected, hasChildren: bool(entry.hasChildren) };
    }
    object(entry, ["kind", "depth", "id", "parentSessionId", "reason"]);
    if (entry.kind !== "diagnostic") fail();
    return { kind: "diagnostic" as const, depth: depth(entry.depth), id: identity(entry.id), parentSessionId: identity(entry.parentSessionId), reason: choice(entry.reason, ["corrupt", "unsupported", "unavailable"] as const) };
  });
  for (const entry of entries) {
    const parent = entry.kind === "child" ? entry.child.parentSessionId : entry.parentSessionId;
    if ((entry.depth === 1) !== (parent === sessionId)) fail();
  }
  return { sessionId, admissionEpoch, descendants: entries };
}
function promptRequest(value: unknown): SubagentPromptRequest {
  const row = object(value, ["requestId", "parentSessionId", "childSessionId", "mode", "delivery", "content"], ["clientTimeZone"]);
  if (row.mode !== "continuable") fail();
  const content = array(row.content, Number.MAX_SAFE_INTEGER).map(value => {
    const part = object(value, ["type"], ["text", "mediaType", "data", "name"]);
    if (part.type === "text") {
      object(part, ["type", "text"]);
      if (typeof part.text !== "string") fail();
      return { type: "text" as const, text: part.text };
    }
    object(part, ["type", "mediaType", "data"], ["name"]);
    if (part.type !== "image" || typeof part.data !== "string") fail();
    return { type: "image" as const, mediaType: choice(part.mediaType, ["image/png", "image/jpeg", "image/webp", "image/gif"] as const), data: part.data,
      ...(Object.hasOwn(part, "name") ? { name: text(part.name, 256) } : {}) };
  });
  if (content.length === 0) fail();
  return { requestId: identity(row.requestId) as SubagentPromptRequest["requestId"], parentSessionId: identity(row.parentSessionId) as SubagentPromptRequest["parentSessionId"],
    childSessionId: identity(row.childSessionId) as SubagentPromptRequest["childSessionId"], mode: "continuable", delivery: choice(row.delivery, ["queue", "steer"] as const), content,
    ...(Object.hasOwn(row, "clientTimeZone") ? { clientTimeZone: text(row.clientTimeZone, 128) } : {}) };
}
function interruptRequest(value: unknown): RoleControlInterruptRequest {
  const row = object(value, ["parentSessionId", "childSessionId", "mode"]);
  if (row.mode !== "continuable") fail();
  return { parentSessionId: identity(row.parentSessionId), childSessionId: identity(row.childSessionId), mode: "continuable" };
}
function promptReceipt(value: unknown): SubagentPromptReceipt { const row = object(value, ["messageId"]); return { messageId: identity(row.messageId) as SubagentPromptReceipt["messageId"] }; }
function interruptReceipt(value: unknown): SubagentInterruptReceipt { const row = object(value, ["accepted"]); if (row.accepted !== true) fail(); return { accepted: true }; }
function errorInfo(value: unknown): RoleControlErrorInfo {
  const row = object(value, ["code"], ["field", "reason"]);
  return { code: choice(row.code, ROLE_CONTROL_ERROR_CODES), ...(Object.hasOwn(row, "field") ? { field: choice(row.field, ROLE_CONTROL_ERROR_FIELDS) } : {}),
    ...(Object.hasOwn(row, "reason") ? { reason: choice(row.reason, ROLE_CONTROL_DISABLED_REASONS) } : {}) };
}
export const parseRoleControlErrorInfo = (value: unknown): RoleControlErrorInfo => errorInfo(json(value));
export const parseChildSessionSnapshot = (value: unknown): ChildSessionSnapshot => snapshot(json(value));
export const parseRoleControlDescendants = (value: unknown): RoleControlDescendantsSnapshot => descendants(json(value));
export const parseRoleControlPromptRequest = (value: unknown): SubagentPromptRequest => promptRequest(json(value));
export const parseRoleControlInterruptRequest = (value: unknown): RoleControlInterruptRequest => interruptRequest(json(value));
export const parseRoleControlCapabilities = (value: unknown): RoleControlCapabilities => capabilities(json(value));
export const parseRoleControlSessionId = (value: unknown): string => identity(value);

function codec(symbol: string, parse: (value: unknown) => unknown): TypertCodec {
  return { mode: "strict", typeSymbol: `@dsmm/dsmm#${symbol}`, create: () => ({ parse: value => parse(json(value)) }) };
}
function descriptor(method: string, result: TypertCodec, request?: TypertCodec): InvocationDescriptor {
  return { id: `@dsmm/dsmm-children#dsmmChildren/${method}`, service: "dsmmChildren", namespace: "dsmmChildren", method, invocation: { kind: "direct" },
    parameters: [{ name: "sessionId", wire: "sessionId", source: "json", codec: codec("ChildControlSessionId", identity) },
      ...(request === undefined ? [] : [{ name: "request", wire: "request", source: "json" as const, codec: request }])], result };
}
/** Separate package identity prevents replacing the Profiles contribution. */
export const ROLE_CONTROL_REMOTE: TypertRemoteContribution = { package: "@dsmm/dsmm-children", descriptors: [
  descriptor("describe", codec("ChildSessionSnapshot", snapshot)),
  descriptor("descendants", codec("RoleControlDescendantsSnapshot", descendants)),
  descriptor("prompt", codec("SubagentPromptReceipt", promptReceipt), codec("SubagentPromptRequest", promptRequest)),
  descriptor("interrupt", codec("SubagentInterruptReceipt", interruptReceipt), codec("RoleControlInterruptRequest", interruptRequest)),
] };
export const ROLE_CONTROL_HOST: TypertContribution = { package: ROLE_CONTROL_REMOTE.package, face: "host", schemas: [], model: { services: [], events: [], objects: [] }, invocations: ROLE_CONTROL_REMOTE.descriptors };
export default ROLE_CONTROL_REMOTE;
