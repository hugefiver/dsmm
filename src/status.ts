import type { DshAgent } from "./dsh-types.js";
import { classifyModelFamily } from "./model-family.js";
import type { DsmmModelFamily } from "./model-family.js";
import { DSMM_ROLES, isDsmmRoleId } from "./roles.js";
import type { DsmmRoleId } from "./roles.js";
import { roleRouteRuntimeState } from "./role-routing.js";
import { resolveSelectedAgentPreset } from "./session-scope.js";
import { resolveAdmittedDsmmRole as resolveEffectiveDsmmRole } from "./role-policy.js";
import { resolveRoleRuntimePolicy } from "./routing-policy.js";
import type { DsmmModelRoute, DsmmProfileAdmission, DsmmSettings } from "./settings.js";
import type { DsmmRateLimitPolicy, DsmmRoutingStrategy } from "./routing-policy.js";
import type { DsmmRoleAvailabilityState, DsmmRoleRuntimeState, SubagentRuntimeAdmissionView, ProfileDiagnostic } from "./profile-types.js";
import type { DsmmLspRuntimeState } from "./lsp.js";
import type { DsmmModuleState } from "./modules.js";

export const DSMM_STATUS_VERSION = 1 as const;

export interface DsmmStatusSnapshot {
  roles?: DsmmRoleAvailabilityState[];
  warnings?: ProfileDiagnostic[];
  subagentRuntime?: SubagentRuntimeAdmissionView;
  locale?: { value: NonNullable<DsmmSettings["locale"]>; source: string; capture: string };
  version: typeof DSMM_STATUS_VERSION;
  modules?: DsmmModuleState[];
  admission?: Pick<DsmmProfileAdmission, "profile" | "epoch" | "scope">;
  profileStore?: DsmmProfileAdmission["store"];
  deployment?: { globalRevision: string; nativeRevision: string; entryId: string; hostProfileKey: string; restartRequired: readonly string[]; sources: Record<string, string>; sourceCaptures?: { fields: Record<string, string>; startup?: { globalRevision: string; nativeRevision: string } } };
  mode: {
    name: string;
    active: boolean;
    selectedPreset?: string;
    dsmmPreset: boolean;
    inScope: boolean;
  };
  route: {
    provider?: string;
    model?: string;
    family: DsmmModelFamily;
    currentReasoningEffort?: string;
  };
  rolePolicy: {
    role?: DsmmRoleId;
    applies: boolean;
    primary?: DsmmModelRoute;
    fallbackRoutes: DsmmModelRoute[];
    fallbackSource: "role" | "global" | "disabled";
    strategy: DsmmRoutingStrategy;
    rateLimit: DsmmRateLimitPolicy;
    runtimeState?: DsmmRoleRuntimeState;
    diagnostic?: "invalid-child-descriptor";
  };
  runtimeRecovery: {
    enabled: boolean;
    applies: boolean;
    fallbackRouteCount: number;
    maxFallbackAttempts: number;
    idleContinuation: {
      enabled: boolean;
      maxContinuations: number;
    };
  };
  effectiveSettings: DsmmSettings;
  lspRuntime?: DsmmLspRuntimeState;
}

interface DsmmStatusRouteInput {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

export function createDsmmStatusSnapshot(input: {
  agent: DshAgent;
  settings: DsmmSettings;
  modeActive: boolean;
  admission?: DsmmProfileAdmission;
  subagentRuntime?: SubagentRuntimeAdmissionView;
  roleRuntimeState?: DsmmRoleRuntimeState;
  modules?: DsmmModuleState[];
}): DsmmStatusSnapshot {
  const { agent, settings } = input;
  const modeActive = settings.modules.deepwork.enabled && input.modeActive;
  const ordinaryRoot = agent.session.header?.origin !== "subagent";
  const selectedPreset = resolveSelectedAgentPreset(agent.session);
  const dsmmPreset = isDsmmRoleId(selectedPreset);
  let role: DsmmRoleId | undefined;
  let invalidDescriptor = false;
  try { role = resolveEffectiveDsmmRole(agent, settings, modeActive); }
  catch { invalidDescriptor = true; }
  const inScope = modeActive || role !== undefined;
  const policy = ordinaryRoot || role === undefined ? undefined : settings.roleRouting[role];
  const runtimePolicy = resolveRoleRuntimePolicy(settings, role);
  const roleRuntimeState = input.roleRuntimeState ?? (input.admission === undefined || invalidDescriptor ? undefined
    : roleRouteRuntimeState(agent, settings, role, input.admission.epoch));
  const fallbacks = ordinaryRoot || invalidDescriptor ? [] : runtimePolicy.fallbackRoutes;
  const selectedRoute = resolveRoute(agent);
  const family = classifyModelFamily({
    providerID: selectedRoute.provider,
    modelID: selectedRoute.model
  });

  return {
    version: DSMM_STATUS_VERSION,
    ...(input.admission?.roleAvailability === undefined ? {} : { roles: structuredClone(input.admission.roleAvailability) }),
    ...(input.admission?.warnings === undefined ? {} : { warnings: structuredClone(input.admission.warnings) }),
    ...(input.subagentRuntime === undefined && input.admission?.subagentRuntime === undefined ? {} : { subagentRuntime: { ...(input.subagentRuntime ?? input.admission!.subagentRuntime!) } }),
    ...(settings.locale === undefined ? {} : { locale: { value: settings.locale, source: input.admission?.sources?.locale ?? "defaults", capture: input.admission?.sourceCaptures?.fields.locale ?? "admission" } }),
    ...(input.modules === undefined ? {} : { modules: structuredClone(input.modules) }),
    ...(input.admission?.store === undefined ? {} : { profileStore: { ...input.admission.store } }),
    ...(input.admission?.deployment === undefined ? {} : { deployment: {
      globalRevision: input.admission.deployment.globalRevision, nativeRevision: input.admission.deployment.nativeRevision,
      entryId: input.admission.deployment.entryId, hostProfileKey: input.admission.deployment.hostProfileKey,
      restartRequired: [...input.admission.restartRequired ?? []], sources: readOnlySettingSources(input.admission.sources ?? {}),
      ...(input.admission.sourceCaptures === undefined ? {} : { sourceCaptures: {
        fields: readOnlySettingSources(input.admission.sourceCaptures.fields), ...(input.admission.sourceCaptures.startup === undefined ? {} : { startup: { ...input.admission.sourceCaptures.startup } })
      } })
    } }),
    ...(input.admission === undefined ? {} : { admission: {
      profile: input.admission.profile === null ? null : { ...input.admission.profile },
      epoch: input.admission.epoch,
      scope: input.admission.scope
    } }),
    mode: {
      name: settings.modeName,
      active: modeActive,
      ...(selectedPreset === undefined ? {} : { selectedPreset }),
      dsmmPreset,
      inScope
    },
    route: {
      ...(selectedRoute.provider === undefined ? {} : { provider: selectedRoute.provider }),
      ...(selectedRoute.model === undefined ? {} : { model: selectedRoute.model }),
      family,
      ...(selectedRoute.reasoningEffort === undefined ? {} : { currentReasoningEffort: selectedRoute.reasoningEffort })
    },
    rolePolicy: {
      ...(role === undefined ? {} : { role }),
      applies: inScope && !invalidDescriptor,
      ...(policy?.primary === undefined ? {} : { primary: { ...policy.primary } }),
      fallbackRoutes: fallbacks.map((route) => ({ ...route })),
      fallbackSource: ordinaryRoot || invalidDescriptor ? "disabled" : runtimePolicy.fallbackSource,
      strategy: ordinaryRoot ? "startup-lock" : runtimePolicy.strategy,
      rateLimit: { ...runtimePolicy.rateLimit },
      ...(roleRuntimeState === undefined ? {} : { runtimeState: {
        ...roleRuntimeState,
        ...(ordinaryRoot ? { strategy: "startup-lock" } : {}),
        rateLimit: { ...roleRuntimeState.rateLimit },
        ...(roleRuntimeState.route === undefined ? {} : { route: { ...roleRuntimeState.route } })
      } }),
      ...(invalidDescriptor ? { diagnostic: "invalid-child-descriptor" as const } : {})
    },
    runtimeRecovery: {
      enabled: settings.runtimeRecovery.enabled,
      applies: settings.runtimeRecovery.enabled && inScope && !invalidDescriptor,
      fallbackRouteCount: fallbacks.length,
      maxFallbackAttempts: settings.runtimeRecovery.maxFallbackAttempts,
      idleContinuation: {
        enabled: settings.runtimeRecovery.idleContinuation.enabled,
        maxContinuations: settings.runtimeRecovery.idleContinuation.maxContinuations
      }
    },
    effectiveSettings: readOnlySettings(settings),
    ...(agent.ctx?.get?.<() => DsmmLspRuntimeState>("dsmmLspState") === undefined ? {} : { lspRuntime: agent.ctx.get!<() => DsmmLspRuntimeState>("dsmmLspState")!() })
  };
}

export function formatDsmmStatus(snapshot: DsmmStatusSnapshot): string {
  const displayRole = (id: string | undefined): string => DSMM_ROLES.find((role) => role.id === id)?.name ?? id ?? "none";
  const scope = snapshot.rolePolicy.role !== undefined && snapshot.rolePolicy.role !== "dsmm-orchestrator"
    && snapshot.rolePolicy.role !== snapshot.mode.selectedPreset
    ? `${displayRole(snapshot.rolePolicy.role)} role`
    : snapshot.mode.inScope && snapshot.mode.dsmmPreset && snapshot.mode.selectedPreset
    ? `${displayRole(snapshot.mode.selectedPreset)} preset`
    : snapshot.mode.inScope
      ? "active deepwork"
      : "out of scope";
  const provider = snapshot.route.provider ?? "unavailable";
  const model = snapshot.route.model ?? "unavailable";
  const currentReasoningEffort = snapshot.route.currentReasoningEffort ?? "provider default";

  return [
    "Deepwork status",
    `Mode: ${snapshot.mode.active ? "active" : "inactive"} (${snapshot.mode.name})`,
    ...snapshot.modules?.map((module) => `Module ${module.descriptor.id}: desired=${module.desired.enabled} (${module.desired.source}, ${module.desired.capture}); startup-mounted=${module.startupMounted}; admitted=${module.admitted}; next-root=${module.nextRoot.admitted}; pending=${module.pending}; reason=${module.reason ?? "none"}; host-bundle-enabled=${module.hostBundleEnabled}`) ?? [],
    ...(snapshot.subagentRuntime === undefined ? [] : [`Native subagents: binding=${snapshot.subagentRuntime.binding}; admission-ready=${snapshot.subagentRuntime.deliveryFenceReady}; restart-required=${snapshot.subagentRuntime.restartRequired}; reason=${snapshot.subagentRuntime.reason ?? "none"}`]),
    `Scope: ${scope}`,
    ...(snapshot.admission === undefined ? [] : [`Profile admission: ${snapshot.admission.scope}; profile=${snapshot.admission.profile?.id ?? "deployment baseline"}; epoch=${snapshot.admission.epoch}`]),
    ...(snapshot.deployment === undefined ? [] : [`Deployment capture: global=${snapshot.deployment.globalRevision}; native=${snapshot.deployment.nativeRevision}; restart-required=${snapshot.deployment.restartRequired.join(",") || "none"}`]),
    ...(snapshot.deployment?.sourceCaptures?.startup === undefined ? [] : [`Startup-pinned sources: global=${snapshot.deployment.sourceCaptures.startup.globalRevision}; native=${snapshot.deployment.sourceCaptures.startup.nativeRevision}`]),
    ...(snapshot.profileStore === undefined ? [] : [`Named store: ${snapshot.profileStore.origin}; ${snapshot.profileStore.readOnly ? "read-only" : "writable"}${snapshot.profileStore.writeRestriction === undefined ? "" : `; ${snapshot.profileStore.writeRestriction}`}`]),
    `Workflow policy: ${snapshot.effectiveSettings.workflow.policy}`,
    `Route: ${provider}/${model} [${snapshot.route.family}]`,
    `Role policy: ${displayRole(snapshot.rolePolicy.role)}; strategy=${snapshot.rolePolicy.strategy}; primary=${snapshot.rolePolicy.primary === undefined ? "inherit" : `${snapshot.rolePolicy.primary.provider}/${snapshot.rolePolicy.primary.model}`}; fallbacks=${snapshot.rolePolicy.fallbackSource}; retries=${snapshot.rolePolicy.rateLimit.maxRetries}; threshold=${snapshot.rolePolicy.rateLimit.switchAfterRateLimits}; switches=${snapshot.rolePolicy.rateLimit.maxSwitches}`,
    ...(snapshot.rolePolicy.runtimeState === undefined ? [] : [`Retry state: retries=${snapshot.rolePolicy.runtimeState.retries}; rate limits=${snapshot.rolePolicy.runtimeState.rateLimitFailures}; switches=${snapshot.rolePolicy.runtimeState.switches}; delay ms=${snapshot.rolePolicy.runtimeState.totalDelayMs}`]),
    `Reasoning: current=${currentReasoningEffort}`,
    `Runtime recovery: ${snapshot.runtimeRecovery.enabled ? "enabled" : "disabled"}; applies=${snapshot.runtimeRecovery.applies ? "yes" : "no"}; fallbacks=${snapshot.runtimeRecovery.fallbackRouteCount}; max attempts=${snapshot.runtimeRecovery.maxFallbackAttempts}`,
    `Idle continuation: ${snapshot.runtimeRecovery.idleContinuation.enabled ? "enabled" : "disabled"}; max=${snapshot.runtimeRecovery.idleContinuation.maxContinuations}`,
    "Effective settings: use /dsmm-status json for the normalized snapshot"
  ].join("\n");
}

function resolveRoute(agent: DshAgent): DsmmStatusRouteInput {
  const requestHeader = agent.session.requestHeader?.();
  if (requestHeader !== undefined) {
    const config = requestHeader?.config;
    return {
      provider: readString(config?.provider),
      model: readString(config?.model),
      reasoningEffort: readString(config?.reasoningEffort)
    };
  }

  return {
    provider: readString(agent.options?.provider),
    model: readString(agent.options?.model),
    reasoningEffort: readString(agent.options?.reasoningEffort)
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Read-only diagnostics only; never use this copy as configuration input. */
export function readOnlySettings(settings: DsmmSettings): DsmmSettings {
  return {
    permissionControl: structuredClone(settings.permissionControl),
    modelParameters: { ...settings.modelParameters },
    modules: { deepwork: { enabled: settings.modules.deepwork.enabled } },
    ...(settings.locale === undefined ? {} : { locale: settings.locale }),
    modeName: settings.modeName,
    defaultActive: settings.defaultActive,
    promptOrder: settings.promptOrder,
    skills: { ...settings.skills },
    roles: { ...settings.roles },
    roleRouting: Object.fromEntries(Object.entries(settings.roleRouting).map(([role, policy]) => [role, {
      ...(policy.primary === undefined ? {} : { primary: { ...policy.primary } }),
      ...(policy.fallbackRoutes === undefined ? {} : { fallbackRoutes: policy.fallbackRoutes.map((route) => ({ ...route })) }),
      ...(policy.strategy === undefined ? {} : { strategy: policy.strategy }),
      ...(policy.rateLimit === undefined ? {} : { rateLimit: { ...policy.rateLimit } }),
      ...(policy.levels === undefined ? {} : { levels: structuredClone(policy.levels) })
    }])),
    runtimePolicy: { strategy: settings.runtimePolicy.strategy, rateLimit: { ...settings.runtimePolicy.rateLimit } },
    presets: { ...settings.presets, ...(settings.presets.root === undefined ? {} : { root: "<configured>" }) },
    subagents: { ...settings.subagents },
    workflow: { ...settings.workflow },
    guards: {
      ...settings.guards,
      toolOutputTruncation: { ...settings.guards.toolOutputTruncation },
      questionLabelHelper: { ...settings.guards.questionLabelHelper }
    },
    runtimeRecovery: {
      ...settings.runtimeRecovery,
      retryOnStatusCodes: [...settings.runtimeRecovery.retryOnStatusCodes],
      retryOnCodes: [...settings.runtimeRecovery.retryOnCodes],
      fallbackRoutes: settings.runtimeRecovery.fallbackRoutes.map((route) => ({ ...route })),
      idleContinuation: { ...settings.runtimeRecovery.idleContinuation, prompt: settings.runtimeRecovery.idleContinuation.prompt === "" ? "" : "<configured>" }
    },
    lsp: {
      enabled: settings.lsp.enabled,
      serverName: settings.lsp.serverName,
      command: settings.lsp.command === "" ? "" : "<configured>",
      args: settings.lsp.args.map(() => "<configured>"),
      cwd: settings.lsp.cwd === "" ? "" : "<configured>",
      env: Object.fromEntries(Object.keys(settings.lsp.env).map((_key, index) => [`variable-${index + 1}`, "<redacted>"])),
      toolCallTimeoutMs: settings.lsp.toolCallTimeoutMs,
      failOnStartupError: settings.lsp.failOnStartupError
    }
  };
}

/** Environment key names may themselves contain private data. */
export function readOnlySettingSources(fields: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {}, environment = new Set<string>();
  for (const [path, value] of Object.entries(fields)) {
    if (path === "lsp.env" || path.startsWith("lsp.env.")) environment.add(value);
    else result[path] = value;
  }
  if (environment.size) result["lsp.env"] = environment.size === 1 ? [...environment][0] : "mixed";
  return result;
}
