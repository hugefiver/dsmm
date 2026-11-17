import { getTraceable } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { DshAgent, DshContext } from "./dsh-types.js";
import type { Config } from "./index.js";
import { agentForScope, nativeAgentContext } from "./native-scope.js";
import { buildDeepworkPrompt } from "./prompts.js";
import { resolveAdmittedDsmmRole } from "./role-policy.js";
import type { DsmmSettingsGetter } from "./settings.js";
import type { DeepworkModeController } from "./state.js";

const bindings = new WeakMap<DshAgent, () => void>();

/** The admission installer owns scope selection; assembly reads the immutable Agent configuration. */
export function registerDeepworkPrompt(readyCtx: DshContext, controller: DeepworkModeController, getSettings: DsmmSettingsGetter, config: Config, agent: DshAgent, lifetime: AbortSignal): void {
  const refresh = bindings.get(agent);
  if (refresh) { refresh(); return; }
  const ctx = nativeAgentContext(agent);
  let dispose: (() => void) | undefined;
  const reconcile = () => {
    dispose?.();
    const registry = ctx.get("agentPresets")?.serviceFor(agent as Agent, "systemPrompt") ?? ctx.get("systemPrompt");
    if (!registry) throw new Error("Deepwork requires the native system prompt service");
    dispose = getTraceable(ctx, registry).section({ name: "dsmm:deepwork", order: getSettings(agent).promptOrder, interpolate: false, text: "" });
  };
  // Native selection writes this step's variables on the return path of the waterfall.
  const stopAssembly = ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const assembled = await next();
    if (context.scope !== agent && agentForScope(readyCtx, context.scope) !== agent) return assembled;
    if (context.signal?.aborted || getSettings.subagentRuntime?.().deliveryFenceReady === false) return assembled;
    const settings = getSettings(agent);
    if (!settings.modules.deepwork.enabled || !controller.active(agent, settings.defaultActive)) return assembled;
    const roleId = resolveAdmittedDsmmRole(agent, settings, true) ?? null;
    const model = assembled.variables.model ?? agent.options?.model;
    const provider = assembled.variables.provider ?? agent.options?.provider;
    const route = model && provider ? { model, provider } : undefined;
    for (const section of assembled.sections) {
      if (section.name === "dsmm:deepwork") section.text = buildDeepworkPrompt(settings, { route, roleId, overrideSection: config.section });
      else if (roleId === null && section.name === "harness:identity") section.text = "You are an AI assistant.";
      else if (roleId === null && section.name === "deployment:persona-prefix" && section.interpolate !== false) {
        section.text = section.text.replace("You are a coding agent powered by the {{model}} model.", "").trim();
      }
    }
    return assembled;
  }, { prepend: true });
  bindings.set(agent, reconcile);
  const retire = () => { stopAssembly(); dispose?.(); bindings.delete(agent); lifetime.removeEventListener("abort", retire); };
  lifetime.addEventListener("abort", retire, { once: true });
  ctx.effect(() => retire);
  reconcile();
}
