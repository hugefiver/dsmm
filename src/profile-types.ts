/** Wire-only profile data: safe to import from the native browser client. */
import type { DsmmRoleId } from "./roles.js";
import type { DsmmModuleState } from "./modules.js";
import type { DsmmInvocationLevel, DsmmModelRoute, DsmmProfileScope } from "./settings.js";
import type { ProfileDiagnostic, ProfileDiagnosticCode, ProfileDiagnosticLocation } from "./profile-diagnostics.js";
export type { ProfileDiagnostic, ProfileDiagnosticCode, ProfileDiagnosticLocation } from "./profile-diagnostics.js";

export const DSMM_ROUTE_SOURCES = ["inherited", "primary", "level", "invocation-route"] as const;
export type DsmmRouteSource = typeof DSMM_ROUTE_SOURCES[number];
export type DsmmInitialRoleRoute =
  | { readonly status: "known"; readonly source: "invocation-capture"; readonly route: Readonly<DsmmModelRoute> }
  | { readonly status: "unknown"; readonly reason: "missing-invocation-capture" };
export type DsmmLiveRoleRoute =
  | { readonly status: "known"; readonly source: "own-native-request-header"; readonly route: Readonly<DsmmModelRoute> }
  | { readonly status: "unknown"; readonly reason: "no-own-request-header" | "invalid-own-request-header" | "not-observed" };
/** Exact child capture and own request observation; neither substitutes for the other. */
export type DsmmRoleRouteComparison = {
  readonly childId: string;
  readonly initialRoute: DsmmInitialRoleRoute;
  readonly liveRoute: DsmmLiveRoleRoute;
};
export interface DsmmInvocationView {
  role: DsmmRoleId;
  label: string;
  level: DsmmInvocationLevel;
  routeSource: DsmmRouteSource;
  /** Preflighted/actual native route, never inferred from raw wire arguments. */
  route?: DsmmModelRoute;
  mode: "one-shot" | "continuable";
  runId?: string;
  childId?: string;
  jobId?: string;
  routeComparison?: DsmmRoleRouteComparison;
}

export interface SubagentRuntimeAdmissionView {
  binding: "stock" | "unavailable";
  /** Native execution admission readiness; not an inbox-acceptance veto. */
  deliveryFenceReady: boolean;
  restartRequired: boolean;
  reason?: "authority-not-ready";
}
export interface DsmmRoleAvailabilityState {
  id: DsmmRoleId;
  required: boolean;
  requiredReason?: "deepwork-planning" | "legacy-review";
  startupAvailable: boolean;
  deploymentEnabled: boolean;
  namedEnabled?: boolean;
  admitted: boolean;
  reason?: "module-off" | "deployment-disabled" | "startup-unavailable" | "profile-disabled" | "required-role" | "current-root-disabled";
  source: "defaults" | "global" | "profile" | "named-session";
  capture: "startup" | "deployment" | "named-session";
}

/** Non-executable schema projection for the native deployment editor. */
export interface DeploymentSchemaNode {
  type: string;
  fields?: Record<string, DeploymentSchemaNode>;
  inner?: DeploymentSchemaNode;
  alternatives?: DeploymentSchemaNode[];
  value?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  keys?: readonly string[];
  nonempty?: boolean;
  additionalProperties?: "json";
}
export interface DeploymentAdmissionView {
  /** Captured execution semantics, not proof of a ready raw executor. */
  modelParameterPolicy?: import("./model-parameter-policy.js").ResolvedModelParameterPolicy;
  /** Host-redacted read-only view, never raw editor input or actual runtime settings. */
  settings: Record<string, unknown>;
  sources: Record<string, string>;
  captures: Record<string, string>;
  restartRequired: readonly string[];
  named: { id: string; revision: string } | null;
}
export interface DeploymentEditorSnapshot {
  entryId: string;
  namespace: string | null;
  hostProfileKey: string;
  global: Record<string, unknown>;
  globalRevision: string;
  profile: Record<string, unknown>;
  nativeRevision: string;
  nativeFormRevision: number | null;
  nativeForm: { base: unknown; user: unknown } | null;
  /** Host-redacted inspector layers. global/profile/nativeForm remain C0 editor input. */
  desired: Record<string, unknown>;
  sources: Record<string, string>;
  startup: Record<string, unknown>;
  startupSources?: Record<string, string>;
  defaults: Record<string, unknown>;
  schema: DeploymentSchemaNode;
  nativeSchema?: DeploymentSchemaNode;
  subagentRuntime?: SubagentRuntimeAdmissionView;
  nextRoot: DeploymentAdmissionView | null;
  modules: DsmmModuleState[];
}
import type { DsmmRateLimitPolicy, DsmmRoutingStrategy, DsmmRuntimePolicyConfig, DsmmRuntimePolicySettings } from "./routing-policy.js";

export type ProfileErrorCode = "validation" | "conflict" | "not-found" | "lock-timeout" | "unsafe-path" | "io" | "activation" | "corrupt-selection" | "limit"
  | "busy" | "maintenance" | "disposed" | "not-owned" | "unavailable" | "cancelled";

export interface ProfileErrorInfo {
  reason?: ProfileDiagnosticCode;
  location?: ProfileDiagnosticLocation;
  code: ProfileErrorCode;
  message: string;
  field?: string;
}

export interface ProfileSummary {
  warnings?: ProfileDiagnostic[];
  id: string;
  label?: string;
  revision: string | null;
  error?: ProfileErrorInfo;
}

export interface ProfileSelectionState {
  sourceRevision?: string;
  refreshRequired?: true;
  selectedId: string | null;
  appliedRevision: string | null;
  selectionRevision: string;
}

export interface ProfileSnapshot extends ProfileSelectionState {
  selectedWarnings?: ProfileDiagnostic[];
  profiles: ProfileSummary[];
  selectionError?: ProfileErrorInfo;
  /** Native deployment role inventory; excludes provider accounts and auth data. */
  roles?: ProfileRoleMetadata[];
  editorDefaults?: DsmmRuntimePolicySettings;
  origin?: "central" | "legacy" | "explicit";
  readOnly?: boolean;
  writeRestriction?: string;
}

export interface ProfileReadResult {
  refreshRequired?: true;
  warnings?: ProfileDiagnostic[];
  id: string;
  label?: string;
  revision: string;
  content: string;
}

export interface ProfileSaveRequest {
  id: string;
  content: string;
  expectedRevision: string | null;
}

export interface ProfileSelectRequest {
  id: string | null;
  expectedRevision?: string;
  expectedSelectionRevision: string;
}

export interface ProfileRoleMetadata {
  availability?: DsmmRoleAvailabilityState;
  id: DsmmRoleId;
  label: string;
  enabled: boolean;
  /** Explicit deployment overrides inherited by a profile's omitted role fields. */
  runtimePolicy?: DsmmRuntimePolicyConfig;
}

export interface DsmmRoleRuntimeState {
  role?: DsmmRoleId;
  strategy: DsmmRoutingStrategy;
  rateLimit: DsmmRateLimitPolicy;
  route?: DsmmModelRoute;
  retries: number;
  rateLimitFailures: number;
  switches: number;
  totalDelayMs: number;
}

export type SessionActionUnavailableReason = "busy" | "maintenance" | "module-off" | "runtime-unavailable" | "model-unconfigured" | "model-service-unavailable" | "new-session-required";

export interface SessionProfileSnapshot {
  refreshRequired?: true;
  warnings?: ProfileDiagnostic[];
  roles?: DsmmRoleAvailabilityState[];
  subagentRuntime?: SubagentRuntimeAdmissionView;
  sessionId: string;
  globalDefault: ProfileSelectionState;
  /** Current selection state: the authority for session-selection CAS. */
  selection: ProfileSelectionState;
  /** Exact live admission, for display only; may differ from the future global default. */
  admittedSelection?: ProfileSelectionState;
  scope: DsmmProfileScope;
  admissionEpoch: string;
  switchAllowed: boolean;
  switchUnavailableReason?: "busy" | "maintenance" | "disposed" | "not-owned" | "unavailable";
  canSelectModel: boolean;
  selectModelUnavailableReason?: SessionActionUnavailableReason;
  canToggleMode: boolean;
  toggleModeUnavailableReason?: SessionActionUnavailableReason;
  /** Host-authoritative blank-session choice; never started-session hot Apply. */
  canApplyOverlay: boolean;
  applyOverlayUnavailableReason?: SessionActionUnavailableReason;
  rolePolicy?: DsmmRoleRuntimeState;
  /** Declared profile primary for the current ordinary root role, not an applied native selection. */
  profileModel?: DsmmModelRoute;
  /** Explicit session intent always beats defaults. */
  deepwork?: SessionDeepworkState;
  /** Safe captured module admission; not a read of the current global editor. */
  modules?: DsmmModuleState[];
  configuration?: DeploymentAdmissionView;
}

export interface SessionDeepworkState {
  active: boolean;
  explicit: boolean;
  /** Standing DW presets own their composition; only ordinary presets toggle. */
  locked: boolean;
  revision: string;
}

export interface SessionModeSelectRequest {
  sessionId: string;
  active: boolean;
  expectedModeRevision: string;
  expectedAdmissionEpoch: string;
}

export interface SessionProfileSelectRequest extends ProfileSelectRequest {
  sessionId: string;
  expectedAdmissionEpoch: string;
}

export const ABSENT_PROFILE_SELECTION_REVISION = "absent";
