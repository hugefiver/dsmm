import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { parseGlobalConfig } from "../src/deployment-config.ts";
import { DSMM_CONFIG_SCHEMA, deploymentEditorSchema, isRootRoleEnabled, resolveConfig } from "../src/settings.ts";
import { nativeRoutingFixture } from "./native-routing-fixture.ts";

test("the dispatcher is the only selectable standing root; the retired planner-root switch fails closed", () => {
  const config = resolveConfig(DSMM_CONFIG_SCHEMA({}));
  assert.deepEqual(Object.keys(config.presets).sort(), ["materialize"]);
  assert.equal(config.roles["dsmm-planner"], true);
  assert.equal(isRootRoleEnabled(config, "dsmm-orchestrator"), true);
  for (const role of ["dsmm-planner", "dsmm-builder", "dsmm-reviewer"] as const) {
    assert.equal(isRootRoleEnabled(config, role), false, `${role} stays an internal delegation target`);
  }
  assert.equal(deploymentEditorSchema().fields?.presets.fields?.plannerRootEnabled, undefined);
  for (const value of [true, false, null, "true", 1]) {
    assert.throws(() => parseGlobalConfig(JSON.stringify({ presets: { plannerRootEnabled: value } })), { code: "validation", field: "presets.[unknown]" });
    const stale = { presets: { plannerRootEnabled: value } } as unknown as Parameters<typeof resolveConfig>[0];
    assert.throws(() => resolveConfig(stale));
  }
});

test("the selection roster exposes only the dispatcher while other roles stay mounted for delegation", async () => {
  const f = await nativeRoutingFixture({ subagents: { maxDepth: 3 } }, { nativePresets: true });
  try {
    const presets = f.ctx.get("agentPresets")!;
    assert.deepEqual((await presets.remoteExportList()).presets.map(row => row.id).filter(id => id.startsWith("dsmm-")), ["dsmm-orchestrator"]);
    for (const role of ["dsmm-planner", "dsmm-builder"] as const) await assert.rejects(f.create({ agentPreset: role }));
    assert.equal(f.adapter.calls.length, 0);
    assert.deepEqual(f.agents.list(), []);
    const root = await f.create({ agentPreset: "dsmm-orchestrator" });
    const result = await root.ctx.tools.execute({ agent: root, name: "dsmm_planner", callId: ToolCallId("delegated-planner"),
      arguments: { description: "Bounded native plan", prompt: "Return the useful local plan" }, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(JSON.stringify(result), /fixture complete/);
    assert.deepEqual(f.agents.list(), [root]);
  } finally { await f.dispose(); }
});

test("blank preset switches to non-dispatcher roles fail closed and keep the admitted composition", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true }, { nativePresets: true });
  try {
    const presets = f.ctx.get("agentPresets")!;
    const root = await f.create();
    await presets.select(root, "dsmm-orchestrator");
    await f.ctx.get("dsmmNativeAdmission")!.ensure(root);
    const useful = await root.ctx.tools.execute({ agent: root, name: "dsmm_code_search", callId: ToolCallId("admitted-utility"),
      arguments: { description: "Admitted utility", prompt: "Return the useful local result" }, signal: new AbortController().signal });
    assert.equal(useful.isError, false, JSON.stringify(useful));
    // Delegation roles are not registered presets; a switch to one is refused
    // by the native registry and the admitted composition keeps executing.
    await assert.rejects(presets.select(root, "dsmm-planner"), /not-found|Unknown agent preset/u);
    const still = await root.ctx.tools.execute({ agent: root, name: "dsmm_code_search", callId: ToolCallId("refused-utility"),
      arguments: { description: "Kept composition", prompt: "Return the useful local result" }, signal: new AbortController().signal });
    assert.equal(still.isError, false, JSON.stringify(still));
    assert.equal(f.adapter.calls.length, 2);
  } finally { await f.dispose(); }
});
