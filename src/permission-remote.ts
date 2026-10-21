import type { InvocationDescriptor, RemoteResult, TypertCodec, TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";
import type { TypertContribution } from "@deepseek-ai/dsh-typert-registry";
import { parsePermissionRulesSave, permissionRevision, permissionRuleRow } from "./permission-rules.js";
import type { PermissionRulesSaveRequest, PermissionRulesSaveResult } from "./permission-rules.js";
import { resolvePermissionControl } from "./permission-settings.js";
import type { NativePermissionCapabilityView } from "./permission-native-rules.js";

export interface PermissionRemote {
  describeRules(sessionId: string): Promise<RemoteResult<PermissionRulesSaveResult>>;
  saveRules(sessionId: string, request: PermissionRulesSaveRequest): Promise<RemoteResult<PermissionRulesSaveResult>>;
}
declare module "@deepseek-ai/dsh-typert-protocol/types" {
  interface TypertRemoteMap {
    "dsmmPermissions/describeRules": PermissionRemote["describeRules"];
    "dsmmPermissions/saveRules": PermissionRemote["saveRules"];
  }
  interface TypertRemoteNamespaceMap { dsmmPermissions: PermissionRemote }
  interface RemoteErrorDetailsMap { "dsmm-permissions/refused": { code: string } }
}
function fail(): never { throw new TypeError("Invalid permission DTO."); }
function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail();
  return value;
}
export function parsePermissionSessionId(value: unknown): string { return text(value, 256); }
function parseRuntime(value: unknown): PermissionRulesSaveResult["runtime"] {
  const runtime = permissionRuleRow(value, ["savedRevision", "runtimeRevision", "state", "mounted", "restartRequired"]);
  if (!["synced", "updating", "unsynced"].includes(runtime.state as string) || typeof runtime.mounted !== "boolean" || typeof runtime.restartRequired !== "boolean") fail();
  return { savedRevision: permissionRevision(runtime.savedRevision), runtimeRevision: permissionRevision(runtime.runtimeRevision), state: runtime.state as PermissionRulesSaveResult["runtime"]["state"], mounted: runtime.mounted, restartRequired: runtime.restartRequired };
}
function parseCapabilities(value: unknown): NativePermissionCapabilityView {
  const input = permissionRuleRow(value, ["limits", "runtime", "tools"]);
  const limits = permissionRuleRow(input.limits, ["outsideReads", "finalInode", "scopedMemory", "webFetch", "webSearchDestinations", "proxyAddressBinding", "shellSockets", "providerAuthMcp"]);
  if (limits.outsideReads !== "tool-call-boundary" || limits.finalInode !== false || limits.scopedMemory !== "not-provided-by-native-rules"
    || limits.webFetch !== "native-public-only" || limits.webSearchDestinations !== "unsupported" || limits.proxyAddressBinding !== "native-proxy-dependent"
    || limits.shellSockets !== "native-executor-dependent" || limits.providerAuthMcp !== "not-covered") fail();
  if (!Array.isArray(input.tools) || input.tools.length > 1024) fail();
  const tools: NativePermissionCapabilityView["tools"][number][] = [];
  const names = new Set<string>();
  for (const value of input.tools) {
    const tool = permissionRuleRow(value, ["name", "kind", "approval", "scopedMemory"]), name = text(tool.name);
    if (!["read", "glob", "grep", "shell", "webSearch", "webFetch"].includes(tool.kind as string) || tool.approval !== "native-once" || tool.scopedMemory !== false || names.has(name)) fail();
    names.add(name);
    tools.push({ name, kind: tool.kind as NativePermissionCapabilityView["tools"][number]["kind"], approval: "native-once", scopedMemory: false });
  }
  return { limits: { outsideReads: "tool-call-boundary", finalInode: false, scopedMemory: "not-provided-by-native-rules", webFetch: "native-public-only",
    webSearchDestinations: "unsupported", proxyAddressBinding: "native-proxy-dependent", shellSockets: "native-executor-dependent", providerAuthMcp: "not-covered" }, runtime: parseRuntime(input.runtime), tools };
}
export function parsePermissionRulesResult(value: unknown): PermissionRulesSaveResult {
  const input = permissionRuleRow(value, ["snapshot", "runtime"], ["capabilities"]), snapshot = permissionRuleRow(input.snapshot, ["revision", "policy"]);
  return { snapshot: { revision: permissionRevision(snapshot.revision), policy: resolvePermissionControl(snapshot.policy as never) }, runtime: parseRuntime(input.runtime),
    ...Object.hasOwn(input, "capabilities") ? { capabilities: parseCapabilities(input.capabilities) } : {} };
}
const codec = (name: string, parse: (value: unknown) => unknown): TypertCodec => ({ mode: "strict", typeSymbol: `@dsmm/dsmm#${name}`, create: () => ({ parse }) });
function descriptor(method: string, result: TypertCodec, request?: TypertCodec): InvocationDescriptor {
  return { id: `@dsmm/dsmm-permissions#dsmmPermissions/${method}`, service: "dsmmPermissions", namespace: "dsmmPermissions", method, invocation: { kind: "direct" },
    parameters: [{ name: "sessionId", wire: "sessionId", source: "json", codec: codec("PermissionSessionId", parsePermissionSessionId) },
      ...request === undefined ? [] : [{ name: "request", wire: "request", source: "json" as const, codec: request }]], result };
}
export const PERMISSION_REMOTE: TypertRemoteContribution = { package: "@dsmm/dsmm-permissions", descriptors: [
  descriptor("describeRules", codec("PermissionRulesResult", parsePermissionRulesResult)),
  descriptor("saveRules", codec("PermissionRulesResult", parsePermissionRulesResult), codec("PermissionRulesSaveRequest", parsePermissionRulesSave)),
] };
export const PERMISSION_HOST: TypertContribution = { package: PERMISSION_REMOTE.package, face: "host", schemas: [], model: { services: [], events: [], objects: [] }, invocations: PERMISSION_REMOTE.descriptors };
