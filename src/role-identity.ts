import { getTraceable } from "@deepseek-ai/cordis";
import type { DshAgent } from "./dsh-types.js";
import { nativeAgentContext } from "./native-scope.js";
import { buildRoleIdentity } from "./prompt-content.js";
import { DSMM_ROLES } from "./roles.js";
import type { DsmmRoleId } from "./roles.js";

/** The caller supplies the policy-admitted identity; only its Agent layer is changed. */
export function registerRoleHarnessIdentity(agent: DshAgent, role: DsmmRoleId, child = false): () => void {
  const ctx = nativeAgentContext(agent);
  const prompt = getTraceable(ctx, ctx.get("agentPresets")?.serviceFor({ ctx }, "systemPrompt") ?? ctx.get("systemPrompt")!);
  const definition = DSMM_ROLES.find(row => row.id === role)!;
  const identity = prompt.section({ name: "harness:identity", order: prompt.getSectionOrder("HARNESS_IDENTITY"),
    text: buildRoleIdentity(definition) });
  try {
    const persona = child ? prompt.section({ name: "deployment:persona-prefix", order: prompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
      text: definition.persona }) : undefined;
    return () => { persona?.(); identity(); };
  } catch (error) { identity(); throw error; }
}
