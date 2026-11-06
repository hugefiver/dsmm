import { getTraceable } from "@deepseek-ai/cordis";
import type { DshAgent } from "./dsh-types.js";
import { nativeAgentContext } from "./native-scope.js";
import { buildRoleIdentity, readPromptAsset } from "./prompt-content.js";
import { DSMM_ROLES, isDsmmRoleId } from "./roles.js";
import type { DsmmRoleId } from "./roles.js";

/** The caller supplies the policy-admitted identity; only its Agent layer is changed. */
export function registerRoleHarnessIdentity(agent: DshAgent, role: DsmmRoleId, child = false): () => void {
  const ctx = nativeAgentContext(agent);
  const prompt = getTraceable(ctx, ctx.get("agentPresets")?.serviceFor({ ctx }, "systemPrompt") ?? ctx.get("systemPrompt")!);
  const definition = DSMM_ROLES.find(row => row.id === role)!;
  const identity = prompt.section({ name: "harness:identity", order: prompt.getSectionOrder("HARNESS_IDENTITY"),
    text: buildRoleIdentity(definition) });
  let locale: (() => void) | undefined;
  let neutralize: (() => void) | undefined;
  try {
    if (!child && !isDsmmRoleId(ctx.get("agentPresets")?.composedPreset(ctx))) {
      locale = prompt.section({ name: "dsmm:locale-guidance", order: 48, interpolate: false, text: readPromptAsset("shared/locale.md") });
      // The standard preset's model identity belongs to its persona, not harness:identity.
      neutralize = ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
        const assembly = await next();
        if (context.scope !== agent) return assembly;
        return { ...assembly, sections: assembly.sections.map(section => section.name === "deployment:persona-prefix" && section.interpolate !== false
          ? { ...section, text: section.text.replace("You are a coding agent powered by the {{model}} model.", "You are a coding agent.") }
          : section) };
      });
    }
    const persona = child ? prompt.section({ name: "deployment:persona-prefix", order: prompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
      text: definition.persona }) : undefined;
    return () => { persona?.(); neutralize?.(); locale?.(); identity(); };
  } catch (error) { neutralize?.(); locale?.(); identity(); throw error; }
}
