/** Browser-safe child control vocabulary; no Host or filesystem authority. */
import type { DsmmInvocationLevel } from "./settings.js";
import type { DsmmInvocationView, DsmmRoleRouteComparison, DsmmRouteSource, SubagentRuntimeAdmissionView } from "./profile-types.js";
import type { SubagentPromptReceipt, SubagentPromptRequest, SubagentInterruptReceipt } from "@deepseek-ai/dsh-subagent";

export type { DsmmInvocationView, DsmmRoleRouteComparison, SubagentPromptRequest, SubagentPromptReceipt, SubagentInterruptReceipt };

export const ROLE_CALL_PHASES = ["reserved", "active", "settled"] as const;
export const ROLE_CALL_DELIVERIES = ["caller", "parent"] as const;
export const ROLE_CALL_STOP_REASONS = ["completed", "aborted", "error", "max-tokens", "refusal"] as const;
export type RoleCallPhase = typeof ROLE_CALL_PHASES[number];
export type RoleCallDelivery = typeof ROLE_CALL_DELIVERIES[number];
export type RoleCallStopReason = typeof ROLE_CALL_STOP_REASONS[number];
export type RoleCallModelRoute = {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
};
export type RoleCallInitialRoute =
  | { readonly status: "known"; readonly source: "invocation-capture"; readonly route: RoleCallModelRoute }
  | { readonly status: "unknown"; readonly reason: "missing-invocation-capture" };
export type RoleCallActualRoute =
  | { readonly status: "known"; readonly source: "own-native-request-header"; readonly route: RoleCallModelRoute }
  | { readonly status: "unknown"; readonly reason: "no-own-request-header" | "invalid-own-request-header" | "not-observed" };
export interface RoleCallObservation {
  readonly parentSessionId: string;
  readonly parentAdmissionEpoch: string;
  readonly childAdmissionEpoch?: string;
  readonly callId: string;
  readonly rootCallId: string;
  readonly childId: string;
  readonly runId?: string;
  readonly role: Exclude<import("./roles.js").DsmmRoleId, "dsmm-orchestrator">;
  readonly level: DsmmInvocationLevel;
  readonly routeSource: DsmmRouteSource;
  readonly initialRoute: RoleCallInitialRoute;
  readonly actualRoute: RoleCallActualRoute;
  readonly phase: RoleCallPhase;
  readonly delivery: RoleCallDelivery;
  readonly stopReason?: RoleCallStopReason;
}
export type RoleCallObservationFrame =
  | { readonly type: "snapshot"; readonly sessionId: string; readonly admissionEpoch: string; readonly calls: readonly RoleCallObservation[] }
  | { readonly type: "update"; readonly sessionId: string; readonly admissionEpoch: string; readonly call: RoleCallObservation }
  | { readonly type: "remove"; readonly sessionId: string; readonly admissionEpoch: string; readonly callId: string };

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
