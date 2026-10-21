/** Browser-safe child control vocabulary; no Host or filesystem authority. */
import type { DsmmInvocationView, DsmmRoleRouteComparison, SubagentRuntimeAdmissionView } from "./profile-types.js";
import type { SubagentPromptReceipt, SubagentPromptRequest, SubagentInterruptReceipt } from "@deepseek-ai/dsh-subagent";

export type { DsmmInvocationView, DsmmRoleRouteComparison, SubagentPromptRequest, SubagentPromptReceipt, SubagentInterruptReceipt };

export const ROLE_CONTROL_DISABLED_REASONS = [
  "module-off", "role-disabled", "read-only", "one-shot", "unknown-mode", "not-direct-child",
  "evidence-unavailable", "unavailable",
] as const;
export type RoleControlDisabledReason = typeof ROLE_CONTROL_DISABLED_REASONS[number];
export type RoleControlAvailability = { enabled: true } | { enabled: false; reason: RoleControlDisabledReason };

export interface RoleControlCapabilities {
  prompt: RoleControlAvailability;
  interrupt: RoleControlAvailability;
  /** The native attachment/model admission still validates each image. */
  images: RoleControlAvailability;
  runtime: SubagentRuntimeAdmissionView;
}
export interface RoleControlChildView {
  id: string;
  parentSessionId: string;
  mode: "one-shot" | "continuable" | "unknown";
  activity: "running" | "inactive";
  label?: string;
  readonly: boolean;
  invocation?: DsmmInvocationView;
  routeComparison?: DsmmRoleRouteComparison;
  controls: { prompt: RoleControlAvailability; interrupt: RoleControlAvailability };
}
export interface ChildSessionSnapshot {
  sessionId: string;
  admissionEpoch: string;
  children: RoleControlChildView[];
  capabilities: RoleControlCapabilities;
}
export type RoleControlDescendantView =
  | { kind: "child"; depth: number; hasChildren: boolean; child: RoleControlChildView }
  | { kind: "diagnostic"; id: string; parentSessionId: string; depth: number; reason: "corrupt" | "unsupported" | "unavailable" };
export interface RoleControlDescendantsSnapshot {
  sessionId: string;
  admissionEpoch: string;
  descendants: RoleControlDescendantView[];
}
export interface RoleControlInterruptRequest {
  parentSessionId: string;
  childSessionId: string;
  mode: "continuable";
}
export const ROLE_CONTROL_ERROR_CODES = ["validation", "not-owned", "unavailable", "cancelled", "conflict", "not-found", "not-resumable", "invalid-content", "invalid-time-zone", "disabled"] as const;
export const ROLE_CONTROL_ERROR_FIELDS = ["sessionId", "parentSessionId", "childSessionId", "request", "content", "clientTimeZone"] as const;
export interface RoleControlErrorInfo {
  code: typeof ROLE_CONTROL_ERROR_CODES[number];
  field?: typeof ROLE_CONTROL_ERROR_FIELDS[number];
  reason?: RoleControlDisabledReason;
}
