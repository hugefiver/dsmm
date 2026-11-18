import { type Context, symbols } from "@deepseek-ai/cordis";
import type { DshAgent } from "./dsh-types.js";
import { registerBundledSkills } from "./skills.js";
import { agentScopeService, scopeParentOf } from "./native-scope.js";
import type { DsmmSettingsGetter } from "./settings.js";
import type { DeepworkModeController } from "./state.js";

const bindings = new WeakMap<Context, () => void>();

/** Admission owns installation; mode changes only invalidate this Agent's lazy provider. */
export function registerAgentSkills(ctx: Context, controller: DeepworkModeController, getSettings: DsmmSettingsGetter, agent: DshAgent, catalogReady?: () => boolean): void {
  const refresh = bindings.get(ctx);
  if (refresh) { refresh(); return; }
  let mounted: { parent: object | undefined; realm: object; provider: ReturnType<typeof registerBundledSkills> } | undefined;
  const remove = () => { mounted?.provider.dispose(); mounted = undefined; };
  const reconcile = () => {
    const settings = getSettings(agent);
    if (!settings.modules.deepwork.enabled || !controller.active(agent, settings.defaultActive)) { remove(); return; }
    const skills = agentScopeService(ctx, "skills"), parent = scopeParentOf(agent);
    if (skills === undefined) throw new Error("Active skills require the native skill registry");
    const realm: object = Reflect.get(skills, symbols.original) ?? skills;
    if (mounted?.parent === parent && mounted?.realm === realm) { mounted.provider.invalidate(); return; }
    remove();
    mounted = { parent, realm, provider: registerBundledSkills(ctx, skills, { agent, controller, getSettings, catalogReady }) };
  };
  const stopMode = controller.watch(changed => { if (changed === agent) reconcile(); });
  bindings.set(ctx, reconcile);
  ctx.effect(() => () => { stopMode(); remove(); bindings.delete(ctx); });
  reconcile();
}
