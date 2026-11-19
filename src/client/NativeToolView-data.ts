import type { RoleCallObservation } from "../role-control-types.js";

export interface NativeActivationIdentity {
  readonly kind: "name" | "id";
  readonly value: string;
}

export function nativeActivationIdentity(meta: unknown): NativeActivationIdentity | undefined {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const value = meta as Record<string, unknown>;
  if (value.kind !== "activation") return undefined;
  if (typeof value.subagentId === "string" && value.subagentId.trim() !== "") return { kind: "id", value: value.subagentId };
  if (typeof value.name === "string" && value.name.trim() !== "") return { kind: "name", value: value.name };
  return undefined;
}

export function observedNativeTool(toolName: string, callId: string, identity: NativeActivationIdentity | undefined, observation: RoleCallObservation | undefined) {
  if (identity === undefined || observation?.kind !== "native" || observation.toolName !== toolName || observation.callId !== callId) return undefined;
  const observedIdentity = identity.kind === "name" ? observation.nativeName : observation.childId;
  return observedIdentity === identity.value ? observation : undefined;
}
