import { type Context, symbols } from "@deepseek-ai/cordis";
import type { DshAgent } from "./dsh-types.js";
import { buildDsmmLocaleGuidance } from "./locale-guidance.js";
import { agentScopeService } from "./native-scope.js";
import { registerRoleHarnessIdentity } from "./role-identity.js";
import type { DsmmRoleId } from "./roles.js";
import type { DsmmSettingsGetter } from "./settings.js";
import type { DsmmRolePolicy } from "./role-policy.js";
import type { DeepworkModeController } from "./state.js";

interface AgentPromptState {
  reconcile(): void;
  promptRealm?: object;
  locale?: () => void;
  identity?: () => void;
  role?: DsmmRoleId;
  child?: boolean;
  stopMode?: () => void;
}

const agentPrompts = new WeakMap<Context, AgentPromptState>();

export function registerAgentPromptScope(ctx: Context, controller: DeepworkModeController, getSettings: DsmmSettingsGetter,
  policy: DsmmRolePolicy, agent: DshAgent): void {
  const existing = agentPrompts.get(ctx);
  if (existing !== undefined) { existing.reconcile(); return; }
  let retired = false;
  const state: AgentPromptState = { reconcile() {
    if (retired) return;
    const prompt = agentScopeService(ctx, "systemPrompt")!;
    const realm: object = Reflect.get(prompt, symbols.original) ?? prompt;
    if (state.promptRealm !== realm) {
      state.identity?.(); state.locale?.();
      state.identity = undefined; state.role = undefined; state.child = undefined;
      state.locale = prompt.section({ name: "dsmm:locale", order: 49, text(context) {
        if (context.scope !== agent) return "";
        const settings = getSettings(agent);
        return settings.locale === undefined ? "" : buildDsmmLocaleGuidance(settings);
      } });
      state.promptRealm = realm;
    }
    const identity = policy.identity(agent);
    if (state.role === identity.role && state.child === identity.child) return;
    state.identity?.();
    state.identity = identity.role === undefined ? undefined : registerRoleHarnessIdentity(prompt, identity.role, identity.child);
    state.role = identity.role; state.child = identity.child;
  } };
  const retire = () => {
    if (retired) return;
    retired = true;
    state.stopMode?.(); state.identity?.(); state.locale?.();
    agentPrompts.delete(ctx);
  };
  state.stopMode = controller.watch(changed => { if (changed === agent) state.reconcile(); });
  agentPrompts.set(ctx, state);
  ctx.effect(() => retire);
  try { state.reconcile(); }
  catch (error) { retire(); throw error; }
}
