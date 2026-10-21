import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import * as AgentInstructions from "@deepseek-ai/dsh-agent-instructions";
import * as Persona from "@deepseek-ai/dsh-persona";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { createScope } from "@deepseek-ai/dsh-scope";
import { SystemPrompt, renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { DshAgent } from "../src/dsh-types.js";
import { DSMM_ROLES, rolePluginRows } from "../src/roles.js";
import { buildRoleIdentity } from "../src/prompt-content.js";
import { registerRoleHarnessIdentity } from "../src/role-identity.js";

test("native role persona and instruction compositions accept required Config fields and activate", async () => {
  const ctx = new Context();
  const promptFiber = ctx.plugin(SystemPrompt, {});
  const projectionsFiber = ctx.plugin(SessionProjectionRegistry);
  try {
    await Promise.all([promptFiber.await(), projectionsFiber.await()]);
    const ordinaryKey = {};
    const ordinary = createScope(ctx, ordinaryKey);
    await ordinary.ctx.plugin(Persona, { prefix: "Ordinary native persona" }).await();
    const nativePrompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: ordinaryKey }));
    ctx.systemPrompt.section({ name: "fixture:tool-guidance", order: 1000, text: "Native tool guidance" });
    for (const role of DSMM_ROLES) {
      const key = { ctx: undefined as unknown as Context };
      const scope = createScope(ctx, key);
      key.ctx = scope.ctx;
      const rows = rolePluginRows(role);
      const persona = rows.find((row) => row.id === "persona");
      const instructions = rows.find((row) => row.id === "agent-instructions");
      assert.ok(persona && instructions);
      // Native Cordis validates each real plugin's Config before activation.
      // Mount the emitted values unchanged so the old text/missing-maxBytes
      // composition fails here exactly as it does in the eager preset audit.
      const personaFiber = scope.ctx.plugin(Persona, persona.config as unknown as Persona.Config);
      const instructionsFiber = scope.ctx.plugin(AgentInstructions, instructions.config as unknown as AgentInstructions.Config);
      const activation = await Promise.allSettled([personaFiber.await(), instructionsFiber.await()]);
      const failures = activation.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []);
      assert.deepEqual(failures, [], `${role.id} native composition failed Config validation or activation`);
      scope.ctx.get("systemPrompt")!.section({ name: "fixture:workspace-instructions", order: 50, text: "Native workspace instructions" });
      const disposeIdentity = registerRoleHarnessIdentity(key as unknown as DshAgent, role.id);
      const prompt = await ctx.systemPrompt.assemble({ scope: key });
      assert.equal(prompt.sections[0]?.name, "harness:identity");
      assert.equal(prompt.sections[0]?.text, buildRoleIdentity(role));
      assert.ok(renderPrompt(prompt).startsWith(buildRoleIdentity(role)));
      assert.equal(prompt.sections.find((section) => section.name === Persona.PERSONA_PREFIX_SECTION)?.text, role.persona);
      assert.ok(renderPrompt(prompt).includes("Native workspace instructions"));
      assert.ok(renderPrompt(prompt).includes("Native tool guidance"));
      assert.equal(renderPrompt(await ctx.systemPrompt.assemble({ scope: ordinaryKey })), `${nativePrompt}\n\nNative tool guidance`);
      disposeIdentity();
      const restored = await ctx.systemPrompt.assemble({ scope: key });
      assert.equal(restored.sections[0]?.text, (await ctx.systemPrompt.assemble()).sections[0]?.text);
    }
  } finally {
    await ctx.fiber.dispose();
  }
});
