import { Context, symbols } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-api-gateway";
import type { DshAgent, DshContext } from "./dsh-types.js";
import { registerDeepworkCommand, registerDsmmStatusCommand } from "./commands.js";
import { registerSafetyGuards } from "./guards.js";
import { registerDeepworkPrompt } from "./mode.js";
import { registerAgentSkills } from "./preset-skills.js";
import { registerModelRouting } from "./model-routing.js";
import { registerHeadlessRoleTools, registerNativeSubagentControls } from "./role-subagents.js";
import { registerRolePresets } from "./preset-registry.js";
import { registerRoleProviders } from "./role-providers.js";
import { DsmmRolePolicy } from "./role-policy.js";
import { createProfileRuntime } from "./profile-runtime.js";
import { DsmmProfilesHost, registerConfigRpc } from "./profile-rpc.js";
import { DSMM_CONFIG_SCHEMA, DSMM_NATIVE_CONFIG_SCHEMA } from "./settings.js";
import type { DsmmNativeConfig, DsmmSettingsGetter } from "./settings.js";
import { DeepworkModeController } from "./state.js";
import { DsmmDeploymentConfig } from "./deployment-config.js";
import { NativeAdmission } from "./native-admission.js";
import { scopeLifetime } from "./lifetime.js";
import { runtimeAdmissionView, assertSupportedHostStartup } from "./runtime-integration.js";
import type { DsmmHostStartupOptions } from "./runtime-integration.js";
import { createCorePermissionAuthority } from "./core-permission-authority.js";
import { installCorePermissions } from "./core-permissions.js";
import { registerRoleControlRpc } from "./role-control-rpc.js";
import { nativeStandingFullAccess } from "./permission-native-access.js";
import { DsmmProfileError } from "./profiles.js";
import { registerLspRuntime } from "./lsp.js";

export const name = "dsmm";
export const inject = ["profileContext", "agents"] as const;
export type Config = DsmmNativeConfig;
export const Config = new Proxy(DSMM_NATIVE_CONFIG_SCHEMA, { apply(_target, _receiver, args) { return DSMM_CONFIG_SCHEMA(args[0] ?? {}); } });
export type { DeepworkSessionEventMap } from "./dsh-events.js";
export type { DsmmRoleDefinition, DsmmRoleId } from "./roles.js";
export { DSMM_ROLE_IDS, DSMM_ROLES, isDsmmRoleId, renderAgentCordis, renderPresetMetadata } from "./roles.js";
export { DSMM_MANAGED_PRESET_MARKER, materializeRolePresets, reconcileRolePresets, resolveManagedPresetRoot } from "./preset-materializer.js";
export { DSMM_GUARD_PREFIX, decidePostToolExecution, decidePreToolExecution, isSafetyScopeActive, registerSafetyGuards, truncateTextMiddle } from "./guards.js";
export { DEFAULT_DSMM_LSP_SETTINGS, DSMM_LSP_SERVER_NAME, DSMM_LSP_TOOL_NAMES, parseLspSmokeCommand, publicLspToolName, renderLspMcpPatch, resolveLspSettings, toDshMcpClientConfig } from "./lsp.js";
export type { DshMcpStdioConfig, DsmmLspSettings, DsmmLspToolName, DsmmLspRuntimeState } from "./lsp.js";
export { classifyModelFamily } from "./model-family.js";
export type { DsmmModelFamily } from "./model-family.js";
export { registerModelRouting } from "./model-routing.js";
export { childOwnedSessionEvents, resolveEffectiveDsmmRole, resolveSelectedAgentPreset } from "./session-scope.js";
export { roleFromProviderName, roleProviderName, registerRoleProviders } from "./role-providers.js";
export { effectiveRoleFallbackRoutes } from "./role-routing.js";
export { DSMM_STATUS_COMMAND, registerDsmmStatusCommand } from "./commands.js";
export { DSMM_STATUS_VERSION, createDsmmStatusSnapshot, formatDsmmStatus } from "./status.js";
export type { DsmmStatusSnapshot } from "./status.js";
export type * from "./dsh-types.js";
export { DSMM_SKILL_NAMES, DSMM_SETTINGS_SCHEMA, DEFAULT_DSMM_SETTINGS, MVP_SKILL_NAMES, deploymentEditorSchema, isRoleEnabled, resolveConfig, resolveDeployment, resolveRoleRouting, registerSettings, validateNativeConfig } from "./settings.js";
export type { DsmmFinalReviewPolicy, DsmmGitWritePolicy, DsmmGuardScope, DsmmGuardSettings, DsmmPluginConfig, DsmmNativeConfig,
  DsmmModelRoute, DsmmRoleRoutingConfig, DsmmRoleRouting, DsmmRecoveryRoute, DsmmRuntimeRecoverySettings, DsmmSettings,
  DsmmSettingsGetter, DsmmSkillName, DsmmWorkflowSettings, MvpSkillName, DsmmSubagentSettings, DsmmDeploymentSnapshot } from "./settings.js";
export { createProfileRuntime, DsmmProfileRuntime } from "./profile-runtime.js";
export type { DsmmProfileRuntimeStore, DsmmProfileRuntimeOptions } from "./profile-runtime.js";
export { resolveDshHome } from "./dsh-home.js";
export { DsmmDeploymentConfig, parseGlobalConfig, editGlobalConfig } from "./deployment-config.js";
export type { GlobalConfigSnapshot, GlobalConfigSaveRequest, DeploymentPathEdit } from "./deployment-config.js";
export { DSMM_MODULE_DESCRIPTORS, deepworkEnabled, projectDeepworkModule } from "./modules.js";
export type { DsmmModuleState } from "./modules.js";
export { DEEPWORK_MODE_EVENT, DeepworkModeController, hasOpenTurn, isDeepworkActive } from "./state.js";
export type { DsmmHostStartupOptions } from "./runtime-integration.js";
export { DsmmNativeLlmRuntime } from "./llm-runtime.js";
export type { DsmmLlmAdmission, DsmmLlmCallConfig, DsmmLlmHostOwner, DsmmLlmGeneration, DsmmJson } from "./host-llm.js";
export { registerRuntimeRecovery } from "./runtime-recovery.js";
export { classifyRecoveryFailure, foldAttemptedRecoveryRoutes, foldDurableRecoveryWork, selectFallbackRoute } from "./recovery-policy.js";
export type { DurableRecoveryWork, RecoveryFailureDecision } from "./recovery-policy.js";

export function createDsmmHostPlugin(startup: DsmmHostStartupOptions) {
  assertSupportedHostStartup(startup);
  return { name, Config, inject, apply(ctx: DshContext, config: Config = {}) { return apply(ctx, config, startup); } };
}
export async function apply(input: DshContext, config: Config = {}, startupOptions: DsmmHostStartupOptions = {}): Promise<void> {
  assertSupportedHostStartup(startupOptions);
  if (!Context.is(input)) throw new Error("DSMM requires the native Cordis Host");
  const ctx = input;
  const deployment = new DsmmDeploymentConfig(ctx, config);
  const lifetime = new AbortController();
  scopeLifetime(ctx, "dsmm: retire Core", () => lifetime.abort());
  let admission: NativeAdmission | undefined;
  const assert = (agent: Agent) => { lifetime.signal.throwIfAborted(); if (!admission) throw new Error("DSMM initialization is incomplete"); return admission.assert(agent); };
  const startup = await deployment.readDesired(); lifetime.signal.throwIfAborted();
  const getSettings: DsmmSettingsGetter = agent => agent === undefined ? startup.settings : admission!.configuration(agent as Agent).settings;
  getSettings.admission = agent => agent === undefined ? profiles.admission() : admission!.configuration(agent as Agent);
  getSettings.subagentRuntime = () => runtimeAdmissionView(ctx);
  const controller = new DeepworkModeController(ctx as DshContext, agent => getSettings(agent).modules.deepwork.enabled,
    () => admission?.isReady === true && ctx.get("subagents") !== undefined && ctx.get("agentPresets") !== undefined);
  const policy = new DsmmRolePolicy(ctx as DshContext, getSettings, controller);
  let permissionOwner: object | undefined;
  const mountedPermission = () => {
    if (lifetime.signal.aborted) return null;
    const current = ctx.get("dsmmPermissionController");
    return current && (Reflect.get(current, symbols.original) ?? current) === permissionOwner ? current.rules.status().mounted : null;
  };
  const profiles = await createProfileRuntime(ctx as DshContext, startup.settings, { startup, readDesired: () => deployment.readDesired(), modeController: controller,
    runtimeView: () => runtimeAdmissionView(ctx), getMountedPermission: mountedPermission });
  lifetime.signal.throwIfAborted();
  admission = new NativeAdmission(ctx, profiles, policy);
  ctx.provide("dsmmNativeAdmission", admission);
  ctx.provide("dsmmProfileRuntime", profiles);
  ctx.provide("dsmmDeploymentConfig", deployment);
  ctx.provide("dsmmCoreLlmOwner", { async admit(frame) {
    if (!admission!.owns(frame.agent)) return undefined;
    const captured = assert(frame.agent), full = nativeStandingFullAccess(ctx, frame.agent);
    const permissions = ctx.get("dsmmPermissionController");
    if (!full && captured.settings.permissionControl.enabled && permissions === undefined) throw new DsmmProfileError("unavailable", "Core permission authority is not ready.");
    if (!full) await permissions?.rules.refresh();
    const permissionIdentity = permissions === undefined ? undefined : Reflect.get(permissions, symbols.original) ?? permissions;
    const permissionRevision = full ? undefined : permissions?.rules.getPolicy().revision;
    const permissionSignal = full ? undefined : permissions?.rules.signal;
    const signal = AbortSignal.any([frame.signal, lifetime.signal, ...permissionSignal === undefined ? [] : [permissionSignal]]);
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (assert(frame.agent) !== captured) throw new DsmmProfileError("not-owned", "Native admission changed.");
      if (full) return;
      const current = ctx.get("dsmmPermissionController");
      if ((current === undefined ? undefined : Reflect.get(current, symbols.original) ?? current) !== permissionIdentity
        || current?.rules.getPolicy().revision !== permissionRevision || current?.rules.signal !== permissionSignal) {
        throw new DsmmProfileError("not-owned", "Core permission authority changed.");
      }
    };
    assertCurrent();
    return Object.freeze({ agent: frame.agent, admission: captured, capture: captured, epoch: captured.epoch, signal, assertCurrent });
  } });
  const nativeAdmission = admission;
  if (startup.settings.modules.deepwork.enabled) {
    const presets = ctx.inject(["agentPresets"], async scope => {
      await registerRolePresets(scope as DshContext, () => startup.settings,
        agent => { try { return policy.identity(agent as DshAgent).role; } catch { return undefined; } });
      const providers = scope.inject(["subagents"], async runtimeScope => {
        registerRoleProviders(runtimeScope, () => startup.settings, nativeAdmission);
        await registerNativeSubagentControls(runtimeScope);
      });
      if (scope.get("subagents") !== undefined) await providers.await();
    });
    if (ctx.get("agentPresets") !== undefined) await presets.await();
  }
  if (startup.settings.modules.deepwork.enabled) await registerLspRuntime(ctx, startup.settings.lsp, getSettings);
  lifetime.signal.throwIfAborted();
  const installed = new WeakSet<Agent>();
  admission.activate(async (agent, candidate) => {
    candidate.subagentRuntime = () => runtimeAdmissionView(ctx);
    const scope = agent.ctx as DshContext;
    if (startup.settings.modules.deepwork.enabled) {
      registerAgentSkills(scope, controller, candidate, agent as DshAgent, admission.lifetime.signal, () => !nativeAdmission.isSelecting(agent));
      registerDeepworkPrompt(scope, controller, candidate, { section: startup.profile.section ?? startup.global.section }, agent as DshAgent, admission.lifetime.signal);
    }
    if (installed.has(agent)) {
      if (startup.settings.modules.deepwork.enabled && ctx.get("subagents") !== undefined) await registerHeadlessRoleTools(scope, controller, candidate, policy, nativeAdmission, agent as DshAgent);
      return;
    }
    registerModelRouting(scope, controller, candidate);
    registerSafetyGuards(scope, controller, candidate, policy);
    if (startup.settings.modules.deepwork.enabled) {
      if (ctx.get("subagents") !== undefined) await registerHeadlessRoleTools(scope, controller, candidate, policy, nativeAdmission, agent as DshAgent);
    }
    installed.add(agent);
  });
  ctx.inject(["commands"], scope => {
    registerDsmmStatusCommand(scope as DshContext, controller, getSettings);
    if (startup.settings.modules.deepwork.enabled) registerDeepworkCommand(scope as DshContext, controller, getSettings);
  });
  ctx.inject(["typert"], scope => { registerConfigRpc(scope, deployment, startup.settings, () => profiles, startup.sources, mountedPermission); new DsmmProfilesHost(scope, profiles); registerRoleControlRpc(scope, nativeAdmission); });
  const permissions = createCorePermissionAuthority(ctx, { getSettings, rolePolicy: policy, signal: lifetime.signal });
  const installPermissions = () => ctx.inject(["tools", ...(ctx.fiber.entry === undefined ? [] : ["settings"])], scope => {
    const installed = installCorePermissions(scope, deployment, permissions.authority, permissions.assertWritable);
    const identity: object = Reflect.get(installed, symbols.original) ?? installed;
    scopeLifetime(scope, "dsmm: release permission projection", () => { if (permissionOwner === identity) permissionOwner = undefined; }, () => { permissionOwner = identity; });
  });
  if (ctx.fiber.entry === undefined || ctx.fiber.state === 2) installPermissions();
  else {
    const owner = ctx.fiber.ctx;
    const detach = ctx.on("internal/status", fiber => { if (fiber.ctx !== owner || fiber.state !== 2) return; detach(); if (!lifetime.signal.aborted) installPermissions(); }, { global: true });
  }
}
export default { name, inject, Config, apply };
