import type { SubagentProvider } from "@deepseek-ai/dsh-subagent";
import { SubagentError } from "@deepseek-ai/dsh-subagent";
import type { Context } from "@deepseek-ai/cordis";
import { DSMM_ROLE_IDS, roleProviderName } from "./roles.js";
export { roleProviderName } from "./roles.js";
import type { DsmmRoleId } from "./roles.js";
import type { DsmmSettingsGetter } from "./settings.js";
import type { NativeAdmission } from "./native-admission.js";
export interface DsmmSubagentRegistry {
  getProvider(name: string): SubagentProvider | undefined;
  registerProvider(provider: SubagentProvider): () => void;
  resolveMaxDepth?(configured?: number): number | undefined;
}

export function roleFromProviderName(name: string): DsmmRoleId | undefined { return DSMM_ROLE_IDS.find(role => role !== "dsmm-orchestrator" && roleProviderName(role) === name); }
export function registerRoleProviders(ctx: Context, getSettings: DsmmSettingsGetter, admission: NativeAdmission): void {
  const registry = ctx.subagents;
  for (const role of DSMM_ROLE_IDS.filter(role => role !== "dsmm-orchestrator" && getSettings().roles[role])) {
    const provider: SubagentProvider = {
      name: roleProviderName(role), inheritsParentContext: false,
      get capabilities() { return registry.getProvider("spawn")?.capabilities ?? { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }; },
      async prepareContinuable(request) {
        admission.prepare(request, provider);
        const spawn = registry.getProvider("spawn");
        if (!spawn?.prepareContinuable || spawn.inheritsParentContext !== false || spawn.agentRouteDefaults !== undefined) throw new SubagentError("Independent native spawn provider required", "UNSUPPORTED_CAPABILITY");
        const prepared = await spawn.prepareContinuable(request);
        admission.prepare(request, provider);
        if (registry.getProvider("spawn") !== spawn || prepared.seed !== undefined) throw new SubagentError("Independent spawn seed changed", "UNAUTHORIZED");
        return prepared;
      }
    };
    registry.registerProvider(provider);
  }
}
