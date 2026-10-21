import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import { PERMISSION_REMOTE } from "../permission-remote.js";
import type { PermissionRemote } from "../permission-remote.js";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";

export type PermissionMethod = keyof PermissionRemote;
export type PermissionValue<M extends PermissionMethod> = Awaited<ReturnType<PermissionRemote[M]>> extends RemoteResult<infer Value> ? Value : never;
export type PermissionIssue = "not-owned" | "stale" | "cancelled" | "unavailable" | "validation" | "not-found" | "scope-unavailable" | "replayed" | "denied" | "transport" | "protocol";
export class PermissionClientError extends Error {
  constructor(readonly code: PermissionIssue) { super("Permission operation unavailable."); }
}
export interface PermissionInvoker {
  <M extends PermissionMethod>(method: M, args: Parameters<PermissionRemote[M]>, signal: AbortSignal): Promise<PermissionValue<M>>;
}
const codes = new Set<PermissionIssue>(["not-owned", "stale", "cancelled", "unavailable", "validation", "not-found", "scope-unavailable", "replayed", "denied"]);

/** The public Connection carrier supplies cancellation; C owns wire codecs and authority. */
export function permissionClient(connection: ConnectionHandle): PermissionInvoker {
  return async <M extends PermissionMethod>(method: M, args: Parameters<PermissionRemote[M]>, signal: AbortSignal): Promise<PermissionValue<M>> => {
    const descriptor = PERMISSION_REMOTE.descriptors.find(item => item.method === method)!;
    const payload: Record<string, unknown> = {};
    descriptor.parameters.forEach((parameter, index) => { payload[parameter.wire] = args[index]; });
    let result;
    try { result = await connection.rpc.call("/api", `dsmmPermissions/${method}`, { args: payload }, signal); }
    catch { throw new PermissionClientError(signal.aborted ? "cancelled" : "transport"); }
    if (!result.ok) {
      const code = Reflect.get(result.error.details, "code");
      throw new PermissionClientError(result.error.code === "dsmm-permissions/refused" && codes.has(code) ? code as PermissionIssue : "unavailable");
    }
    signal.throwIfAborted();
    try {
      if (descriptor.result.mode !== "strict") throw new Error("Strict permission codec required.");
      return descriptor.result.create().parse(result.value) as PermissionValue<M>;
    } catch { throw new PermissionClientError("protocol"); }
  };
}
