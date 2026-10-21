import Schema from "@deepseek-ai/schemastery";
import type { DshAgent, DshContext } from "./dsh-types.js";
import { DEFAULT_DSMM_LSP_SETTINGS, resolveLspSettings } from "./lsp.js";
import type { DsmmLspSettings } from "./lsp.js";
import { DSMM_DISPATCHER_ROLE, DSMM_ROLES, DSMM_ROLE_IDS } from "./roles.js";
import type { DsmmRoleId } from "./roles.js";
import { DSMM_SKILL_NAMES } from "./skills.js";
import type { DsmmSkillName } from "./skills.js";
import { DEFAULT_DSMM_RUNTIME_POLICY, DSMM_RATE_LIMIT_BOUNDS, normalizeRateLimitOverrides, normalizeRoutingStrategy, normalizeRuntimePolicy, resolveRoleRuntimePolicy } from "./routing-policy.js";
import type { DsmmRateLimitPolicy, DsmmRoutingStrategy, DsmmRuntimePolicyConfig, DsmmRuntimePolicySettings } from "./routing-policy.js";
import type { DeploymentSchemaNode } from "./profile-types.js";
import { DEPRECATED_DSMM_FIELDS, DsmmConfigValidationError, safeDiagnosticField } from "./profile-diagnostics.js";
import { DSMM_LOCALES } from "./profile-locale.js";
import type { DsmmLocale } from "./profile-locale.js";
import { normalizeModelRouteJson, validateModelRouteFieldName } from "./route-json.js";
import type { ModelRouteJson } from "./route-json.js";
import { DEFAULT_PERMISSION_CONTROL, nativeCommandEntrySchema, nativeCommandMatchSchema, permissionControlSchema, resolvePermissionControl } from "./permission-settings.js";
import type { PermissionControlSchemaInput, PermissionControlSettings } from "./permission-settings.js";

export { DSMM_LOCALES } from "./profile-locale.js";
export type { DsmmLocale } from "./profile-locale.js";

export type { DsmmRateLimitPolicy, DsmmRoutingStrategy, DsmmRuntimePolicyConfig, DsmmRuntimePolicySettings } from "./routing-policy.js";
export { resolveRoleRuntimePolicy } from "./routing-policy.js";

export { DSMM_SKILL_NAMES, MVP_SKILL_NAMES } from "./skills.js";
export type { DsmmSkillName, MvpSkillName } from "./skills.js";

export type DsmmFinalReviewPolicy = "simple-oracle-complex-reviewer" | "reviewer-only" | "off";
export type DsmmGuardScope = "deepwork-or-dsmm-agent" | "always" | "off";
export type DsmmGitWritePolicy = "ask" | "deny" | "off";
export type DsmmInvocationLevel = "normal" | "low" | "high" | "max";
export type DsmmLevelOverride = { reasoningEffort: string; provider?: never; model?: never } | DsmmModelRoute;
export interface DsmmInvocationOptions { level?: DsmmInvocationLevel; route?: DsmmLevelOverride }
export type DsmmToolTopology = "per-role" | "parameterized";

export interface DsmmWorkflowSettings {
  policy: "risk-based" | "legacy";
  strictGates: boolean;
  reviewCap: number;
  finalReviewPolicy: DsmmFinalReviewPolicy;
}

export interface DsmmPresetSettings {
  materialize: boolean;
  root?: string;
}

export interface DsmmSubagentSettings {
  toolTopology: DsmmToolTopology;
  allowRouteOverride: boolean;
  enableRunInBackground: boolean;
  backgroundMode: "one-shot" | "continuable";
  /** Omitted delegates to the native host limit (rc.2 default 1). */
  maxDepth?: number;
}

export interface DsmmGuardSettings {
  scope: DsmmGuardScope;
  shellCommandSafety: boolean;
  gitWriteGuard: DsmmGitWritePolicy;
  toolOutputTruncation: {
    enabled: boolean;
    maxInlineBytes: number;
  };
  planFormatValidation: boolean;
  questionLabelHelper: {
    enabled: boolean;
    maxLabelChars: number;
  };
  todoDisciplineHelper: boolean;
}

export type DsmmModelRoute = ModelRouteJson;

export type DsmmRecoveryRoute = DsmmModelRoute;

export interface DsmmRoleRoutingConfig {
  levels?: Partial<Record<Exclude<DsmmInvocationLevel, "normal">, DsmmLevelOverride>>;
  primary?: DsmmModelRoute;
  fallbackRoutes?: DsmmModelRoute[];
  strategy?: DsmmRoutingStrategy;
  rateLimit?: Partial<DsmmRateLimitPolicy>;
}

export type DsmmRoleRouting = Partial<Record<DsmmRoleId, DsmmRoleRoutingConfig>>;

export interface DsmmRuntimeRecoverySettings {
  enabled: boolean;
  retryOnStatusCodes: number[];
  retryOnCodes: string[];
  fallbackRoutes: DsmmRecoveryRoute[];
  maxFallbackAttempts: number;
  idleContinuation: {
    enabled: boolean;
    maxContinuations: number;
    prompt: string;
  };
}

type DsmmGuardConfig = Partial<Omit<DsmmGuardSettings, "toolOutputTruncation" | "questionLabelHelper">> & {
  toolOutputTruncation?: Partial<DsmmGuardSettings["toolOutputTruncation"]>;
  questionLabelHelper?: Partial<DsmmGuardSettings["questionLabelHelper"]>;
};

type DsmmRuntimeRecoveryConfig = Partial<Omit<DsmmRuntimeRecoverySettings, "fallbackRoutes" | "idleContinuation">> & {
  fallbackRoutes?: DsmmRecoveryRoute[];
  idleContinuation?: Partial<DsmmRuntimeRecoverySettings["idleContinuation"]>;
};

export interface DsmmPluginConfig {
  /** Deployment-only; the mounted permission owner retains its cold-start policy. */
  permissionControl?: PermissionControlSchemaInput;
  modelParameters?: { passthrough?: boolean };
  locale?: DsmmLocale;
  /** Only global deployment input; native/legacy profile transport rejects it. */
  modules?: { deepwork?: { enabled?: boolean } };
  modeName?: string;
  section?: string;
  defaultActive?: boolean;
  promptOrder?: number;
  skills?: Partial<Record<DsmmSkillName, boolean>>;
  roles?: Partial<Record<DsmmRoleId, boolean>>;
  roleRouting?: DsmmRoleRouting;
  runtimePolicy?: DsmmRuntimePolicyConfig;
  presets?: Partial<DsmmPresetSettings>;
  subagents?: Partial<DsmmSubagentSettings>;
  workflow?: Partial<DsmmWorkflowSettings>;
  guards?: DsmmGuardConfig;
  runtimeRecovery?: DsmmRuntimeRecoveryConfig;
  lsp?: Partial<DsmmLspSettings>;
}

export type DsmmNativeConfig = DsmmPluginConfig;

export interface DsmmSettings {
  permissionControl: PermissionControlSettings;
  modelParameters: { passthrough: boolean };
  locale?: DsmmLocale;
  modules: { deepwork: { enabled: boolean } };
  modeName: string;
  defaultActive: boolean;
  promptOrder: number;
  skills: Record<DsmmSkillName, boolean>;
  roles: Record<DsmmRoleId, boolean>;
  roleRouting: DsmmRoleRouting;
  runtimePolicy: DsmmRuntimePolicySettings;
  presets: DsmmPresetSettings;
  subagents: DsmmSubagentSettings;
  workflow: DsmmWorkflowSettings;
  guards: DsmmGuardSettings;
  runtimeRecovery: DsmmRuntimeRecoverySettings;
  lsp: DsmmLspSettings;
}

export type DsmmProfileScope = "global-default" | "session-override" | "deployment-baseline";

export interface DsmmProfileAdmission {
  childCapture?: import("./child-capture.js").ChildAdmissionCapture;
  childEvidence?: import("./child-capture.js").ChildAdmissionEvidenceView;
  warnings?: import("./profile-diagnostics.js").ProfileDiagnostic[];
  roleAvailability?: import("./profile-types.js").DsmmRoleAvailabilityState[];
  subagentRuntime?: import("./profile-types.js").SubagentRuntimeAdmissionView;
  settings: DsmmSettings;
  profile: { id: string; revision: string } | null;
  readonly epoch: string;
  scope: DsmmProfileScope;
  deployment?: DsmmDeploymentSnapshot;
  restartRequired?: readonly string[];
  sources?: Record<string, "defaults" | "global" | "profile" | "named-session">;
  sourceCaptures?: {
    startup?: { globalRevision: string; nativeRevision: string };
    /** Deployment refers to this admission's captured desired snapshot, never latest disk. */
    fields: Record<string, "startup" | "deployment" | "named-session">;
  };
  store?: { origin: "central" | "legacy" | "explicit"; readOnly: boolean; writeRestriction?: string };
}

export interface DsmmDeploymentSnapshot {
  settings: DsmmSettings;
  global: DsmmPluginConfig;
  profile: DsmmPluginConfig;
  globalRevision: string;
  nativeRevision: string;
  /** Native configForms CAS when its public descriptor is available; raw hash is not that CAS. */
  nativeFormRevision?: number;
  nativeNamespace?: string;
  /** Public native base/user provenance; profile above is the assembled explicit entry layer. */
  nativeForm?: { base?: unknown; user?: unknown };
  entryId: string;
  hostProfileKey: string;
  sources: Record<string, "defaults" | "global" | "profile">;
}

/** Runtime consumers pass their Agent so immutable profile admission is retained. */
export type DsmmSettingsGetter = ((agent?: DshAgent) => DsmmSettings) & {
  admission?: (agent?: DshAgent) => DsmmProfileAdmission;
  moduleStates?: (agent?: DshAgent) => import("./modules.js").DsmmModuleState[];
  subagentRuntime?: () => import("./profile-types.js").SubagentRuntimeAdmissionView;
};

export interface DsmmResolvedRoleRuntimePolicy {
  readonly strategy: DsmmRoutingStrategy;
  readonly rateLimit: Readonly<DsmmRateLimitPolicy>;
  readonly primary?: Readonly<DsmmModelRoute>;
  readonly fallbackRoutes: readonly Readonly<DsmmModelRoute>[];
  readonly fallbackSource: "role" | "global";
}

export const DSMM_STATUS_COMMAND = "dsmm-status";

export interface RegisterSettingsOptions {
  /** Already resolved/captured internal settings, never external profile input. */
  resolved?: DsmmSettings;
  onChange?: (settings: DsmmSettings) => void;
  install?: (readyCtx: DshContext, getSettings: () => DsmmSettings) => void;
}

export const DEFAULT_DSMM_SETTINGS: DsmmSettings = {
  permissionControl: DEFAULT_PERMISSION_CONTROL,
  modelParameters: { passthrough: true },
  modules: { deepwork: { enabled: true } },
  modeName: "deepwork",
  defaultActive: false,
  promptOrder: 50,
  skills: createDefaultSkillSettings(),
  roles: createDefaultRoleSettings(),
  roleRouting: {},
  runtimePolicy: DEFAULT_DSMM_RUNTIME_POLICY,
  presets: {
    materialize: false
  },
  subagents: { enableRunInBackground: false, backgroundMode: "one-shot", toolTopology: "per-role", allowRouteOverride: false },
  workflow: {
    policy: "risk-based",
    strictGates: true,
    reviewCap: 5,
    finalReviewPolicy: "simple-oracle-complex-reviewer"
  },
  guards: {
    scope: "deepwork-or-dsmm-agent",
    shellCommandSafety: true,
    gitWriteGuard: "ask",
    toolOutputTruncation: {
      enabled: true,
      maxInlineBytes: 12000
    },
    planFormatValidation: true,
    questionLabelHelper: {
      enabled: true,
      maxLabelChars: 30
    },
    todoDisciplineHelper: true
  },
  runtimeRecovery: {
    enabled: false,
    retryOnStatusCodes: [429, 500, 502, 503, 504],
    retryOnCodes: [],
    fallbackRoutes: [],
    maxFallbackAttempts: 2,
    idleContinuation: {
      enabled: false,
      maxContinuations: 3,
      prompt: "Continue the current task from the durable goal or unfinished todo list. Do not repeat completed work."
    }
  },
  lsp: DEFAULT_DSMM_LSP_SETTINGS
};

function normalizeModeName(modeName: string | undefined): string {
  return modeName === DSMM_STATUS_COMMAND ? DEFAULT_DSMM_SETTINGS.modeName : modeName ?? DEFAULT_DSMM_SETTINGS.modeName;
}

function createDefaultSkillSettings(): Record<DsmmSkillName, boolean> {
  return Object.fromEntries(DSMM_SKILL_NAMES.map((id) => [id, true])) as Record<DsmmSkillName, boolean>;
}

function createDefaultRoleSettings(): Record<DsmmRoleId, boolean> {
  return Object.fromEntries(DSMM_ROLES.map((role) => [role.id, role.enabledByDefault])) as Record<DsmmRoleId, boolean>;
}

const SKILLS_SCHEMA = Schema.object(Object.fromEntries(
  DSMM_SKILL_NAMES.map((name) => [name, Schema.boolean().default(DEFAULT_DSMM_SETTINGS.skills[name])])
)) as Schema<Partial<Record<DsmmSkillName, boolean>>>;

const ROLES_SCHEMA = Schema.object(Object.fromEntries(
  DSMM_ROLE_IDS.map((id) => [id, Schema.boolean().default(DEFAULT_DSMM_SETTINGS.roles[id])])
)) as Schema<Partial<Record<DsmmRoleId, boolean>>>;

const MODEL_ROUTE_FIELDS_SCHEMA = Schema.object({
  provider: Schema.string().required(),
  model: Schema.string().required(),
  reasoningEffort: Schema.string(),
  temperature: Schema.number(),
  maxTokens: Schema.number().step(1).min(1),
  stop: Schema.array(Schema.string())
});
const MODEL_ROUTE_SCHEMA = Schema.transform(Schema.any(), (input: unknown) => normalizeModelRouteJson(input, true, true));
const LEVEL_OVERRIDE_SCHEMA = Schema.union([MODEL_ROUTE_SCHEMA, Schema.object({ reasoningEffort: Schema.string().required() })]);
const LEVELS_SCHEMA = Schema.object({ low: LEVEL_OVERRIDE_SCHEMA, high: LEVEL_OVERRIDE_SCHEMA, max: LEVEL_OVERRIDE_SCHEMA });
const LOCALE_SCHEMA = Schema.union(DSMM_LOCALES.map(locale => Schema.const(locale)));
const RATE_LIMIT_CONFIG_SCHEMA = Schema.object(Object.fromEntries(Object.keys(DEFAULT_DSMM_RUNTIME_POLICY.rateLimit).map((key) => [key, Schema.number()])));
const ROUTING_STRATEGY_CONFIG_SCHEMA = Schema.union([Schema.const("startup-lock"), Schema.const("rate-limit-fallback")]);
const RUNTIME_POLICY_CONFIG_SCHEMA = Schema.object({ strategy: ROUTING_STRATEGY_CONFIG_SCHEMA, rateLimit: RATE_LIMIT_CONFIG_SCHEMA });
const ROLE_FALLBACK_ROUTE_LIMIT = 32;
const ROLE_FALLBACK_ROUTES_SCHEMA = Schema.array(MODEL_ROUTE_SCHEMA);

// A dictionary retains unknown keys for fail-closed validation by the resolver.
const ROLE_ROUTING_SCHEMA = Schema.dict(Schema.object({
  levels: LEVELS_SCHEMA,
  primary: Schema.union([Schema.const(undefined), MODEL_ROUTE_SCHEMA]),
  fallbackRoutes: Schema.union([Schema.const(undefined), ROLE_FALLBACK_ROUTES_SCHEMA]),
  strategy: ROUTING_STRATEGY_CONFIG_SCHEMA,
  rateLimit: RATE_LIMIT_CONFIG_SCHEMA
}).required()).default({}) as Schema<DsmmRoleRouting>;

// Schemastery treats null like an omitted default. Validate the untouched map
// before object defaults can erase an explicitly malformed routing policy.
const ROLE_ROUTING_VALIDATION_SCHEMA = Schema.transform(Schema.any(), (input: unknown) => {
  if (!isRoutingRecord(input)) return input;
  rejectDeprecatedFields(input);
  if (Object.hasOwn(input, "locale")) validateLocale(input.locale);
  if (isRoutingRecord(input.runtimeRecovery) && Array.isArray(input.runtimeRecovery.fallbackRoutes)) {
    for (const route of input.runtimeRecovery.fallbackRoutes) {
      normalizeExplicitRoute(route);
    }
  }
  const roleRouting = resolveRoleRouting(input.roleRouting as DsmmRoleRouting | undefined);
  const runtimePolicy = normalizeRuntimePolicy(Object.hasOwn(input, "runtimePolicy") ? validatePresentRuntimePolicy(input.runtimePolicy) : undefined);
  return { roleRouting, runtimePolicy };
});

const PRESETS_SCHEMA = Schema.object({
  materialize: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.presets.materialize),
  root: Schema.string()
});
const SUBAGENTS_SCHEMA = Schema.object({
  toolTopology: Schema.union([Schema.const("per-role"), Schema.const("parameterized")]).default("per-role"),
  allowRouteOverride: Schema.boolean().default(false),
  enableRunInBackground: Schema.boolean().default(false),
  backgroundMode: Schema.union([Schema.const("one-shot"), Schema.const("continuable")]).default("one-shot"),
  maxDepth: Schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER)
});

const FINAL_REVIEW_POLICY_SCHEMA = Schema.union([
  Schema.const("simple-oracle-complex-reviewer"),
  Schema.const("reviewer-only"),
  Schema.const("off")
]).default(DEFAULT_DSMM_SETTINGS.workflow.finalReviewPolicy);

const WORKFLOW_SCHEMA = Schema.object({
  policy: Schema.union([Schema.const("risk-based"), Schema.const("legacy")]).default(DEFAULT_DSMM_SETTINGS.workflow.policy),
  strictGates: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.workflow.strictGates),
  reviewCap: Schema.number().default(DEFAULT_DSMM_SETTINGS.workflow.reviewCap),
  finalReviewPolicy: FINAL_REVIEW_POLICY_SCHEMA
});

const WORKFLOW_CONFIG_SCHEMA = Schema.object({
  policy: Schema.union([Schema.const("risk-based"), Schema.const("legacy")]),
  strictGates: Schema.boolean(),
  reviewCap: Schema.number(),
  finalReviewPolicy: Schema.union([
    Schema.const("simple-oracle-complex-reviewer"), Schema.const("reviewer-only"), Schema.const("off")
  ])
});

const GUARD_SCOPE_SCHEMA = Schema.union([
  Schema.const("deepwork-or-dsmm-agent"),
  Schema.const("always"),
  Schema.const("off")
]).default(DEFAULT_DSMM_SETTINGS.guards.scope);

const GIT_WRITE_POLICY_SCHEMA = Schema.union([
  Schema.const("ask"),
  Schema.const("deny"),
  Schema.const("off")
]).default(DEFAULT_DSMM_SETTINGS.guards.gitWriteGuard);

const TOOL_OUTPUT_TRUNCATION_SCHEMA = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.guards.toolOutputTruncation.enabled),
  maxInlineBytes: Schema.number().default(DEFAULT_DSMM_SETTINGS.guards.toolOutputTruncation.maxInlineBytes)
});

const QUESTION_LABEL_HELPER_SCHEMA = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.guards.questionLabelHelper.enabled),
  maxLabelChars: Schema.number().default(DEFAULT_DSMM_SETTINGS.guards.questionLabelHelper.maxLabelChars)
});

const GUARDS_SCHEMA = Schema.object({
  scope: GUARD_SCOPE_SCHEMA,
  shellCommandSafety: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.guards.shellCommandSafety),
  gitWriteGuard: GIT_WRITE_POLICY_SCHEMA,
  toolOutputTruncation: TOOL_OUTPUT_TRUNCATION_SCHEMA,
  planFormatValidation: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.guards.planFormatValidation),
  questionLabelHelper: QUESTION_LABEL_HELPER_SCHEMA,
  todoDisciplineHelper: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.guards.todoDisciplineHelper)
});

const RUNTIME_RECOVERY_IDLE_CONTINUATION_SCHEMA = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.runtimeRecovery.idleContinuation.enabled),
  maxContinuations: Schema.number().default(DEFAULT_DSMM_SETTINGS.runtimeRecovery.idleContinuation.maxContinuations),
  prompt: Schema.string().default(DEFAULT_DSMM_SETTINGS.runtimeRecovery.idleContinuation.prompt)
});

const RUNTIME_RECOVERY_SCHEMA = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.runtimeRecovery.enabled),
  retryOnStatusCodes: Schema.array(Number).default([...DEFAULT_DSMM_SETTINGS.runtimeRecovery.retryOnStatusCodes]),
  retryOnCodes: Schema.array(String).default([...DEFAULT_DSMM_SETTINGS.runtimeRecovery.retryOnCodes]),
  fallbackRoutes: Schema.array(MODEL_ROUTE_SCHEMA).max(ROLE_FALLBACK_ROUTE_LIMIT).default(DEFAULT_DSMM_SETTINGS.runtimeRecovery.fallbackRoutes.map((route) => ({ ...route }))),
  maxFallbackAttempts: Schema.number().default(DEFAULT_DSMM_SETTINGS.runtimeRecovery.maxFallbackAttempts),
  idleContinuation: RUNTIME_RECOVERY_IDLE_CONTINUATION_SCHEMA
});

const LSP_SCHEMA = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.lsp.enabled),
  serverName: Schema.string().default(DEFAULT_DSMM_SETTINGS.lsp.serverName),
  command: Schema.string().default(DEFAULT_DSMM_SETTINGS.lsp.command),
  args: Schema.array(String).default([...DEFAULT_DSMM_SETTINGS.lsp.args]),
  cwd: Schema.string().default(DEFAULT_DSMM_SETTINGS.lsp.cwd),
  env: Schema.dict(String).default({ ...DEFAULT_DSMM_SETTINGS.lsp.env }),
  toolCallTimeoutMs: Schema.number().default(DEFAULT_DSMM_SETTINGS.lsp.toolCallTimeoutMs),
  failOnStartupError: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.lsp.failOnStartupError)
});

const CONFIG_FIELDS_SCHEMA = Schema.object({
  permissionControl: permissionControlSchema,
  modelParameters: Schema.object({ passthrough: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.modelParameters.passthrough) }),
  locale: LOCALE_SCHEMA,
  modeName: Schema.string().default(DEFAULT_DSMM_SETTINGS.modeName),
  section: Schema.string(),
  defaultActive: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.defaultActive),
  promptOrder: Schema.number().default(DEFAULT_DSMM_SETTINGS.promptOrder),
  skills: SKILLS_SCHEMA,
  roles: ROLES_SCHEMA,
  roleRouting: ROLE_ROUTING_SCHEMA,
  runtimePolicy: RUNTIME_POLICY_CONFIG_SCHEMA,
  presets: PRESETS_SCHEMA,
  subagents: SUBAGENTS_SCHEMA,
  workflow: WORKFLOW_CONFIG_SCHEMA,
  guards: GUARDS_SCHEMA,
  runtimeRecovery: RUNTIME_RECOVERY_SCHEMA,
  lsp: LSP_SCHEMA
});

const MODULES_SCHEMA = Schema.object({ deepwork: Schema.object({ enabled: Schema.boolean() }) });
const GLOBAL_FIELDS_SCHEMA = Schema.object({ ...CONFIG_FIELDS_SCHEMA.dict, modules: MODULES_SCHEMA });
const NATIVE_FIELDS_SCHEMA = CONFIG_FIELDS_SCHEMA;

/** Only data is transported. Defaults remain resolved by the existing authority. */
export function deploymentEditorSchema(native = false): DeploymentSchemaNode {
  const project = (schema: Schema): DeploymentSchemaNode => schema === permissionControlSchema && schema.type === "transform"
    ? project(schema.inner!) : schema === permissionControlSchema.inner!.dict!.rules
    ? { type: "array", inner: { type: "object", fields: {}, additionalProperties: "json" } } : schema === MODEL_ROUTE_SCHEMA
    ? { ...project(MODEL_ROUTE_FIELDS_SCHEMA), additionalProperties: "json" } : ({
    type: schema.type,
    ...(schema.dict === undefined ? {} : { fields: Object.fromEntries(Object.entries(schema.dict).map(([key, child]) => {
      const node = project(child);
      if (schema === MODEL_ROUTE_FIELDS_SCHEMA && ["provider", "model", "reasoningEffort"].includes(key)) node.nonempty = true;
      if (schema === RATE_LIMIT_CONFIG_SCHEMA) {
        const [min, max] = DSMM_RATE_LIMIT_BOUNDS[key as keyof DsmmRateLimitPolicy];
        Object.assign(node, { min, max, step: 1 });
      }
      return [key, node];
    })) }),
    ...(schema.inner === undefined ? {} : { inner: project(schema.inner) }),
    ...(schema.list === undefined ? {} : { alternatives: schema.list.map(project) }),
    ...(["string", "number", "boolean"].includes(typeof schema.value) ? { value: schema.value as string | number | boolean } : {}),
    ...(typeof schema.meta.min === "number" ? { min: schema.meta.min } : {}),
    ...(typeof schema.meta.max === "number" ? { max: schema.meta.max } : {}),
    ...(typeof schema.meta.step === "number" ? { step: schema.meta.step } : {}),
    ...(schema.meta.required === true ? { required: true } : {}),
    ...(schema === ROLE_ROUTING_SCHEMA ? { keys: [...DSMM_ROLE_IDS] } : {}),
    ...(schema === ROLE_FALLBACK_ROUTES_SCHEMA ? { max: ROLE_FALLBACK_ROUTE_LIMIT } : {})
  });
  return project(native ? NATIVE_FIELDS_SCHEMA : GLOBAL_FIELDS_SCHEMA);
}

/** Transport nodes carry no business defaults. Only deployment input is volatile. */
function sparseSchema(schema: Schema): Schema {
  if (schema === permissionControlSchema && schema.type === "transform") return sparseSchema(schema.inner!);
  // Whole command entries are never partial overlays; retain the match's required fields.
  if (schema === nativeCommandMatchSchema || schema === nativeCommandEntrySchema) return schema;
  const { default: _default, required: _required, ...meta } = schema.meta;
  return new Schema({ ...schema, meta,
    ...(schema.dict === undefined ? {} : { dict: Object.fromEntries(Object.entries(schema.dict).map(([key, child]) => [key, sparseSchema(child)])) }),
    ...(schema.inner === undefined ? {} : { inner: sparseSchema(schema.inner) }),
    ...(schema.list === undefined ? {} : { list: schema.list.map(sparseSchema) }) });
}
const TRANSPORT_FIELDS_SCHEMA = sparseSchema(NATIVE_FIELDS_SCHEMA);
export const DSMM_CONFIG_SCHEMA = Schema.intersect([
  Schema.transform(Schema.any(), (input: unknown) => { resolveConfig(validateNativeConfig(input ?? {})); return {}; }),
  sparseSchema(NATIVE_FIELDS_SCHEMA)
]).default({}) as Schema<DsmmNativeConfig>;
for (const [key, schema] of Object.entries(TRANSPORT_FIELDS_SCHEMA.dict!)) {
  TRANSPORT_FIELDS_SCHEMA.set(key, schema.volatile());
}
// Native forms require a fixed object root: volatile nodes cannot sit under an
// intersection. Keep that schema intact and validate through the public protocol.
export const DSMM_NATIVE_CONFIG_SCHEMA = new Proxy(TRANSPORT_FIELDS_SCHEMA.default({}), {
  apply(target, receiver, args) {
    validateNativeConfig(args[0] ?? {});
    return Reflect.apply(target, receiver, args);
  },
  get(target, key, receiver) {
    if (key !== "~standard") return Reflect.get(target, key, receiver);
    return { version: 1, vendor: "schemastery", validate(input: unknown) {
      validateNativeConfig(input ?? {});
      return target["~standard"].validate(input);
    } };
  }
}) as unknown as Schema<DsmmNativeConfig>;

export function validateNativeConfig(input: unknown): DsmmNativeConfig {
  const config = copyJson(input) as DsmmNativeConfig;
  if (typeof config === "object" && config !== null) rejectDeprecatedFields(config);
  validateShape(config, NATIVE_FIELDS_SCHEMA);
  validateSparseConfig(config);
  return config;
}

export const DSMM_SETTINGS_SCHEMA = Schema.intersect([ROLE_ROUTING_VALIDATION_SCHEMA, Schema.object({
  permissionControl: permissionControlSchema,
  modelParameters: Schema.object({ passthrough: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.modelParameters.passthrough) }),
  locale: LOCALE_SCHEMA,
  modules: Schema.object({ deepwork: Schema.object({ enabled: Schema.boolean().default(true) }) }),
  modeName: Schema.string().default(DEFAULT_DSMM_SETTINGS.modeName),
  defaultActive: Schema.boolean().default(DEFAULT_DSMM_SETTINGS.defaultActive),
  promptOrder: Schema.number().default(DEFAULT_DSMM_SETTINGS.promptOrder),
  skills: SKILLS_SCHEMA,
  roles: ROLES_SCHEMA as Schema<Record<DsmmRoleId, boolean>>,
  roleRouting: ROLE_ROUTING_SCHEMA,
  runtimePolicy: Schema.any(),
  presets: PRESETS_SCHEMA,
  subagents: SUBAGENTS_SCHEMA,
  workflow: WORKFLOW_SCHEMA,
  guards: GUARDS_SCHEMA,
  runtimeRecovery: RUNTIME_RECOVERY_SCHEMA,
  lsp: LSP_SCHEMA
})]).default({}) as Schema<DsmmSettings>;

export function resolveConfig(config: DsmmPluginConfig = {}): DsmmSettings {
  rejectDeprecatedFields(config);
  if (Object.hasOwn(config, "locale")) validateLocale(config.locale);
  if (config.subagents !== undefined) validateShape(config.subagents, SUBAGENTS_SCHEMA, ["subagents"]);
  if (config.modelParameters !== undefined) validateShape(config.modelParameters, CONFIG_FIELDS_SCHEMA.dict!.modelParameters!, ["modelParameters"]);
  if (config.permissionControl !== undefined) validateShape(config.permissionControl, permissionControlSchema, ["permissionControl"]);
  const settings: DsmmSettings = {
    permissionControl: resolvePermissionControl(config.permissionControl),
    modelParameters: { passthrough: config.modelParameters?.passthrough ?? DEFAULT_DSMM_SETTINGS.modelParameters.passthrough },
    ...(config.locale === undefined ? {} : { locale: config.locale }),
    modules: { deepwork: { enabled: config.modules?.deepwork?.enabled ?? DEFAULT_DSMM_SETTINGS.modules.deepwork.enabled } },
    modeName: normalizeModeName(config.modeName),
    defaultActive: config.defaultActive ?? DEFAULT_DSMM_SETTINGS.defaultActive,
    promptOrder: config.promptOrder ?? DEFAULT_DSMM_SETTINGS.promptOrder,
    skills: { ...DEFAULT_DSMM_SETTINGS.skills, ...config.skills },
    roles: { ...DEFAULT_DSMM_SETTINGS.roles, ...config.roles },
    roleRouting: resolveRoleRouting(config.roleRouting),
    runtimePolicy: normalizeRuntimePolicy(Object.hasOwn(config, "runtimePolicy") ? validatePresentRuntimePolicy(config.runtimePolicy) : undefined),
    presets: resolvePresetSettings(config.presets),
    subagents: SUBAGENTS_SCHEMA(config.subagents ?? {}) as DsmmSubagentSettings,
    workflow: resolveWorkflowSettings(config.workflow),
    guards: resolveGuardSettings(config.guards),
    runtimeRecovery: resolveRuntimeRecoverySettings(config.runtimeRecovery),
    lsp: resolveLspSettings(config.lsp)
  };
  for (const role of DSMM_ROLE_IDS) resolveRoleRuntimePolicy(settings, role);
  return settings;
}

/** Reject references, accessors, prototypes and non-JSON data before any merge. */
export function copyJson<T>(input: T): T {
  const active = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (depth > 32) throw new TypeError("Deepwork configuration nesting is too deep");
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null || active.has(value)) throw new TypeError("Deepwork configuration must be plain JSON data");
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new TypeError("Deepwork configuration must use plain objects");
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("Deepwork configuration must not contain symbols");
    active.add(value);
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === "length") continue;
      if (["__proto__", "prototype", "constructor"].includes(key) || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new TypeError("Deepwork configuration contains an unsafe property");
      if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(key)) throw new TypeError("Deepwork configuration arrays must contain only elements");
      Reflect.set(result, key, copy(descriptor.value, depth + 1));
    }
    if (Array.isArray(value) && Object.keys(result).length !== value.length) throw new TypeError("Deepwork configuration arrays must not have holes");
    active.delete(value);
    return result;
  };
  return copy(input, 0) as T;
}

export function freezeSettings<T>(input: T): T {
  const result = copyJson(input);
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(result);
  return result;
}

function validateShape(value: unknown, schema: Schema, path: (string | number)[] = []): void {
  const fail = (code: import("./profile-diagnostics.js").ProfileDiagnosticCode = "invalid-type"): never => { throw new DsmmConfigValidationError(code, path); };
  if (schema === MODEL_ROUTE_SCHEMA) {
    try { normalizeModelRouteJson(value, true, true); } catch { fail("invalid-route"); }
    return;
  }
  if (value === null || value === undefined) fail();
  if (schema.type === "transform") {
    validateShape(value, schema.inner!, path);
  } else if (schema.type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) fail();
    for (const [key, child] of Object.entries(value as object)) {
      const field = schema.dict !== undefined && Object.hasOwn(schema.dict, key) ? schema.dict[key] : undefined;
      if (field === undefined) throw new DsmmConfigValidationError("unknown-field", [...path, key]);
      validateShape(child, field, [...path, key]);
    }
  } else if (schema.type === "dict") {
    if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("Deepwork configuration field must be an object");
    for (const [key, child] of Object.entries(value as object)) validateShape(child, schema.inner!, [...path, key]);
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new TypeError("Deepwork configuration field must be an array");
    value.forEach((child, index) => validateShape(child, schema.inner!, [...path, index]));
  } else if (schema.type === "union") {
    for (const child of schema.list ?? []) {
      try { validateShape(value, child, path); return; } catch { /* Try the other declared alternatives. */ }
    }
    fail("unsupported-value");
  } else {
    try { schema(value); } catch { fail(); }
  }
}

/** Sparse grammar and full semantic validation are separate from native refs. */
export function validateSparseConfig(input: unknown, global = false): DsmmPluginConfig {
  if (isRoutingRecord(input)) rejectDeprecatedFields(input);
  const config = copyJson(input) as DsmmPluginConfig;
  if (isRoutingRecord(config.roleRouting)) {
    for (const [role, policy] of Object.entries(config.roleRouting)) if (isRoutingRecord(policy) && Object.hasOwn(policy, "levels")) {
      if (!(DSMM_ROLE_IDS as readonly string[]).includes(role)) throw new DsmmConfigValidationError("unknown-field", ["roleRouting", role]);
      if (role === "dsmm-orchestrator") throw new DsmmConfigValidationError("unsupported-value", `roleRouting.${role}.levels`);
      if (!isRoutingRecord(policy.levels)) throw new DsmmConfigValidationError("invalid-type", `roleRouting.${role}.levels`);
      for (const [level, value] of Object.entries(policy.levels)) {
        const field = safeDiagnosticField(["roleRouting", role, "levels", level]);
        if (!["low", "high", "max"].includes(level)) throw new DsmmConfigValidationError("unsupported-value", ["roleRouting", role, "levels", level]);
        normalizeLevelOverride(value, field);
      }
    }
  }
  validateShape(config, global ? GLOBAL_FIELDS_SCHEMA : CONFIG_FIELDS_SCHEMA);
  // A deployment layer may override one primary-route member and inherit the
  // others. Validate its present members here; resolveDeployment validates the
  // complete route only after both sparse layers have merged.
  const routing = config.roleRouting === undefined ? undefined : copyJson(config.roleRouting);
  for (const policy of Object.values(routing ?? {})) {
    if (policy?.primary !== undefined && (!Object.hasOwn(policy.primary, "provider") || !Object.hasOwn(policy.primary, "model"))) delete policy.primary;
  }
  const settings = resolveConfig({ ...config, ...(routing === undefined ? {} : { roleRouting: routing }) });
  DSMM_SETTINGS_SCHEMA(settings);
  return config;
}

export function validateDeploymentPath(path: readonly string[]): void {
  const deprecated = path.find(key => (DEPRECATED_DSMM_FIELDS as readonly string[]).includes(key));
  if (deprecated !== undefined) throw new DsmmConfigValidationError("deprecated-field", path);
  let schema: Schema = GLOBAL_FIELDS_SCHEMA;
  if (path.length === 0) throw new TypeError("Not an editable deployment field");
  for (const key of path) {
    if (schema.type === "union") schema = schema.list?.find((node) => node === MODEL_ROUTE_SCHEMA || node.type === "object") ?? schema;
    if (schema === MODEL_ROUTE_SCHEMA) {
      if (path.some(part => ["__proto__", "prototype", "constructor"].includes(part))) throw new DsmmConfigValidationError("invalid-route", path);
      try { validateModelRouteFieldName(key); } catch { throw new DsmmConfigValidationError("invalid-route", path); }
      const field = MODEL_ROUTE_FIELDS_SCHEMA.dict![key];
      if (Object.hasOwn(MODEL_ROUTE_FIELDS_SCHEMA.dict!, key)) { schema = field; continue; }
      return;
    }
    while (schema.type === "transform") schema = schema.inner!;
    const child = schema.type === "object" ? schema.dict !== undefined && Object.hasOwn(schema.dict, key) ? schema.dict[key] : undefined : schema.type === "dict" ? schema.inner : undefined;
    if (child === undefined) throw new DsmmConfigValidationError("unknown-field", path);
    schema = child;
  }
}

export function mergeConfigLayers(...layers: DsmmPluginConfig[]): DsmmPluginConfig {
  const merge = (base: Record<string, unknown>, overlay: Record<string, unknown>, path: string[] = []): Record<string, unknown> => {
    const result = copyJson(base);
    for (const [key, value] of Object.entries(overlay)) {
      const previous = result[key];
      result[key] = path.at(-1) !== "levels" && value !== null && typeof value === "object" && !Array.isArray(value)
        && previous !== null && typeof previous === "object" && !Array.isArray(previous)
        ? merge(previous as Record<string, unknown>, value as Record<string, unknown>, [...path, key]) : copyJson(value);
    }
    return result;
  };
  return layers.reduce((base, layer) => merge(base as Record<string, unknown>, copyJson(layer) as Record<string, unknown>), {});
}

export function resolveDeployment(global: DsmmPluginConfig, profile: DsmmPluginConfig): DsmmSettings {
  const merged = mergeConfigLayers(validateSparseConfig(global, true), validateSparseConfig(profile));
  const settings = resolveConfig(merged);
  validateResolvedSettings(settings);
  return freezeSettings(settings);
}

export function validateResolvedSettings(settings: DsmmSettings): DsmmSettings {
  const plain = copyJson(settings);
  validateShape(plain, GLOBAL_FIELDS_SCHEMA);
  DSMM_SETTINGS_SCHEMA(plain);
  return plain;
}

function validatePresentRuntimePolicy(value: unknown): unknown {
  if (value === undefined) throw new TypeError("dsmm runtimePolicy must be an object when present");
  return value;
}

export function rejectDeprecatedFields(input: object, prefix = ""): void {
  for (const key of DEPRECATED_DSMM_FIELDS) if (Object.hasOwn(input, key)) throw new DsmmConfigValidationError("deprecated-field", `${prefix}${key}`);
}
export function validateLocale(value: unknown, field = "locale"): asserts value is DsmmLocale {
  if (typeof value !== "string" || !(DSMM_LOCALES as readonly string[]).includes(value)) throw new DsmmConfigValidationError("unsupported-value", field);
}
export function normalizeLevelOverride(value: unknown, field = "route"): DsmmLevelOverride {
  try { value = copyJson(value); } catch { throw new DsmmConfigValidationError("invalid-route", field); }
  if (!isRoutingRecord(value)) throw new DsmmConfigValidationError("invalid-route", field);
  if (Object.hasOwn(value, "provider") || Object.hasOwn(value, "model")) {
    try {
      const route = normalizeExplicitRoute(value);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(route.provider) || route.model.length > 512 || route.model.includes("://") || /[\u0000-\u001f\u007f]/u.test(route.model) || route.reasoningEffort !== undefined && (route.reasoningEffort.length > 64 || /[\u0000-\u001f\u007f]/u.test(route.reasoningEffort))) throw new Error("Invalid bounded route");
      return route;
    } catch { throw new DsmmConfigValidationError("invalid-route", field); }
  }
  for (const key of Object.keys(value)) if (key !== "reasoningEffort") throw new DsmmConfigValidationError("unknown-field", [...field.split("."), key]);
  if (typeof value.reasoningEffort !== "string" || value.reasoningEffort.trim() === "" || value.reasoningEffort.length > 64 || /[\u0000-\u001f\u007f]/u.test(value.reasoningEffort)) throw new DsmmConfigValidationError("invalid-route", `${field}.reasoningEffort`);
  return { reasoningEffort: value.reasoningEffort };
}

export function resolveRoleRouting(input: DsmmRoleRouting | undefined): DsmmRoleRouting {
  if (input === undefined) return {};
  input = copyJson(input);
  if (!isRoutingRecord(input)) throw new TypeError("dsmm roleRouting must be an object");
  const result: DsmmRoleRouting = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(DSMM_ROLE_IDS as readonly string[]).includes(key)) throw new DsmmConfigValidationError("unknown-field", ["roleRouting", key]);
    if (!isRoutingRecord(value) || Object.keys(value).some((field) => !["primary", "fallbackRoutes", "strategy", "rateLimit", "levels"].includes(field))) {
      if (!isRoutingRecord(value)) throw new DsmmConfigValidationError("invalid-type", `roleRouting.${key}`);
      throw new DsmmConfigValidationError("unknown-field", ["roleRouting", key, Object.keys(value).find(field => !["primary", "fallbackRoutes", "strategy", "rateLimit", "levels"].includes(field))!]);
    }
    const policy: DsmmRoleRoutingConfig = {};
    if (Object.hasOwn(value, "levels")) {
      const field = `roleRouting.${key}.levels`;
      if (key === "dsmm-orchestrator") throw new DsmmConfigValidationError("unsupported-value", field);
      if (!isRoutingRecord(value.levels)) throw new DsmmConfigValidationError("invalid-type", field);
      policy.levels = {};
      for (const [level, override] of Object.entries(value.levels)) {
        if (!["low", "high", "max"].includes(level)) throw new DsmmConfigValidationError("unsupported-value", `${field}.${level}`);
        policy.levels[level as "low" | "high" | "max"] = normalizeLevelOverride(override, `${field}.${level}`);
      }
    }
    if (Object.hasOwn(value, "strategy")) policy.strategy = normalizeRoutingStrategy(value.strategy);
    if (Object.hasOwn(value, "rateLimit")) policy.rateLimit = normalizeRateLimitOverrides(value.rateLimit);
    if (Object.hasOwn(value, "primary")) {
      try { policy.primary = normalizeExplicitRoute(value.primary); }
      catch { throw new DsmmConfigValidationError("invalid-route", `roleRouting.${key}.primary`); }
    }
    if (Object.hasOwn(value, "fallbackRoutes")) {
      if (!Array.isArray(value.fallbackRoutes) || value.fallbackRoutes.length > ROLE_FALLBACK_ROUTE_LIMIT) throw new TypeError("dsmm roleRouting fallbackRoutes must be an array with at most 32 entries");
      policy.fallbackRoutes = [];
      for (const [index, entry] of value.fallbackRoutes.entries()) {
        let route: DsmmModelRoute;
        try { route = normalizeExplicitRoute(entry); } catch { throw new DsmmConfigValidationError("invalid-route", `roleRouting.${key}.fallbackRoutes[${index}]`); }
        policy.fallbackRoutes.push(route);
      }
    }
    result[key as DsmmRoleId] = policy;
  }
  return result;
}

function isRoutingRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeExplicitRoute(value: unknown): DsmmModelRoute {
  const route = normalizeModelRouteJson(value, false, true);
  return { ...route, provider: route.provider.trim(), model: route.model.trim() };
}

export function isRoleEnabled(settings: DsmmSettings, role: DsmmRoleId): boolean {
  return settings.roles[role];
}

/** Only the dispatcher is a selectable standing root; every other role stays an internal delegation target. */
export function isRootRoleEnabled(settings: DsmmSettings, id: DsmmRoleId): boolean {
  return id === DSMM_DISPATCHER_ROLE && settings.modules.deepwork.enabled && settings.roles[id];
}

function resolvePresetSettings(config: DsmmPluginConfig["presets"]): DsmmPresetSettings {
  if (config !== undefined) validateShape(config, PRESETS_SCHEMA, ["presets"]);
  return {
    materialize: config?.materialize ?? DEFAULT_DSMM_SETTINGS.presets.materialize,
    ...(config?.root === undefined ? {} : { root: config.root })
  };
}

function resolveWorkflowSettings(config: DsmmPluginConfig["workflow"]): DsmmWorkflowSettings {
  const legacy = config !== undefined && (config.strictGates !== undefined || config.reviewCap !== undefined || config.finalReviewPolicy !== undefined);
  return {
    ...DEFAULT_DSMM_SETTINGS.workflow,
    ...config,
    policy: config?.policy ?? (legacy ? "legacy" : "risk-based")
  };
}

export function resolveGuardSettings(config: DsmmPluginConfig["guards"]): DsmmGuardSettings {
  const defaults = DEFAULT_DSMM_SETTINGS.guards;

  return {
    ...defaults,
    ...config,
    toolOutputTruncation: {
      ...defaults.toolOutputTruncation,
      ...config?.toolOutputTruncation,
      maxInlineBytes: normalizePositiveInteger(
        config?.toolOutputTruncation?.maxInlineBytes,
        defaults.toolOutputTruncation.maxInlineBytes
      )
    },
    questionLabelHelper: {
      ...defaults.questionLabelHelper,
      ...config?.questionLabelHelper,
      maxLabelChars: normalizePositiveInteger(config?.questionLabelHelper?.maxLabelChars, defaults.questionLabelHelper.maxLabelChars)
    }
  };
}

function resolveRuntimeRecoverySettings(config: DsmmPluginConfig["runtimeRecovery"]): DsmmRuntimeRecoverySettings {
  const defaults = DEFAULT_DSMM_SETTINGS.runtimeRecovery;

  return {
    enabled: config?.enabled ?? defaults.enabled,
    retryOnStatusCodes: normalizeStatusCodes(config?.retryOnStatusCodes, defaults.retryOnStatusCodes),
    retryOnCodes: normalizeRetryCodes(config?.retryOnCodes, defaults.retryOnCodes),
    fallbackRoutes: normalizeRecoveryRoutes(config?.fallbackRoutes, defaults.fallbackRoutes),
    maxFallbackAttempts: normalizeBoundedInteger(config?.maxFallbackAttempts, defaults.maxFallbackAttempts),
    idleContinuation: {
      enabled: config?.idleContinuation?.enabled ?? defaults.idleContinuation.enabled,
      maxContinuations: normalizeBoundedInteger(
        config?.idleContinuation?.maxContinuations,
        defaults.idleContinuation.maxContinuations
      ),
      prompt: config?.idleContinuation?.prompt ?? defaults.idleContinuation.prompt
    }
  };
}

function normalizeStatusCodes(input: readonly number[] | undefined, defaults: readonly number[]): number[] {
  const normalized: number[] = [];

  for (const status of input ?? defaults) {
    if (Number.isInteger(status) && status >= 100 && status <= 599 && !normalized.includes(status)) normalized.push(status);
  }

  return normalized;
}

function normalizeRetryCodes(input: readonly string[] | undefined, defaults: readonly string[]): string[] {
  const normalized: string[] = [];

  for (const code of input ?? defaults) {
    const normalizedCode = code.trim().toLowerCase();
    if (normalizedCode !== "" && !normalized.includes(normalizedCode)) normalized.push(normalizedCode);
  }

  return normalized;
}

function normalizeRecoveryRoutes(input: readonly DsmmRecoveryRoute[] | undefined, defaults: readonly DsmmRecoveryRoute[]): DsmmRecoveryRoute[] {
  const normalized: DsmmRecoveryRoute[] = [];
  const routes = copyJson(input ?? defaults);
  if (!Array.isArray(routes) || routes.length > ROLE_FALLBACK_ROUTE_LIMIT) throw new TypeError("dsmm recovery fallbackRoutes must contain at most 32 routes");
  for (const route of routes) {
    const candidate = normalizeExplicitRoute(route);
    normalized.push(candidate);
  }

  return normalized;
}

function normalizeBoundedInteger(value: number | undefined, defaultValue: number): number {
  if (value === undefined || !Number.isFinite(value)) return defaultValue;
  return Math.min(10, Math.max(0, Math.floor(value)));
}

function normalizePositiveInteger(value: number | undefined, defaultValue: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return defaultValue;
  return Math.floor(value);
}

export function registerSettings(ctx: DshContext, config: DsmmPluginConfig = {}, options: RegisterSettingsOptions = {}): () => DsmmSettings {
  // Loader owns entry identity, Config validation, revision and persistent patch.
  // Each non-volatile reload receives a new deployment baseline. Profiles stay
  // on the existing immutable admission path, never a parallel settings store.
  const base = freezeSettings(options.resolved === undefined ? resolveConfig(validateSparseConfig(config)) : validateResolvedSettings(options.resolved));
  const getSettings = (): DsmmSettings => base;
  options.onChange?.(base);
  options.install?.(ctx, getSettings);
  return getSettings;
}
