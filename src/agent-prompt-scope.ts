import { getTraceable, symbols } from "@deepseek-ai/cordis";
import type { DshAgent, DshContext } from "./dsh-types.js";
import { buildDsmmLocaleGuidance } from "./locale-guidance.js";
import { agentForScope, nativeAgentContext } from "./native-scope.js";
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

const agentPrompts = new WeakMap<DshAgent, AgentPromptState>();

export function registerAgentPromptScope(ctx: DshContext, controller: DeepworkModeController, getSettings: DsmmSettingsGetter,
  policy: DsmmRolePolicy, agent: DshAgent, signal: AbortSignal): void {
  signal.throwIfAborted();
  const existing = agentPrompts.get(agent);
  if (existing !== undefined) { existing.reconcile(); return; }
  const agentCtx = nativeAgentContext(agent);
  let retired = false;
  const state: AgentPromptState = { reconcile() {
    if (retired) return;
    const prompt = agentCtx.get("agentPresets")?.serviceFor({ ctx: agentCtx }, "systemPrompt") ?? agentCtx.get("systemPrompt")!;
    const realm: object = Reflect.get(prompt, symbols.original) ?? prompt;
    if (state.promptRealm !== realm) {
      state.identity?.(); state.locale?.();
      state.identity = undefined; state.role = undefined; state.child = undefined;
      state.locale = getTraceable(agentCtx, prompt).section({ name: "dsmm:locale", order: 49, text(context) {
        if (context.scope !== agent && agentForScope(ctx, context.scope) !== agent) return "";
        const settings = getSettings(agent);
        return settings.locale === undefined ? "" : buildDsmmLocaleGuidance(settings);
      } });
      state.promptRealm = realm;
    }
    const identity = policy.identity(agent);
    if (state.role === identity.role && state.child === identity.child) return;
    state.identity?.();
    state.identity = identity.role === undefined ? undefined : registerRoleHarnessIdentity(agent, identity.role, identity.child);
    state.role = identity.role; state.child = identity.child;
  } };
  const retire = () => {
    if (retired) return;
    retired = true;
    signal.removeEventListener("abort", retire);
    state.stopMode?.(); state.identity?.(); state.locale?.();
    if (agentPrompts.get(agent) === state) agentPrompts.delete(agent);
  };
  state.stopMode = controller.watch(changed => { if (changed === agent) state.reconcile(); });
  agentPrompts.set(agent, state);
  signal.addEventListener("abort", retire, { once: true });
  agentCtx.effect(() => retire);
  try { state.reconcile(); }
  catch (error) { retire(); throw error; }
}
