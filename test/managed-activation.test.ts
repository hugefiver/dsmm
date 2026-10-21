import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import * as NativeSubagentTool from "@deepseek-ai/dsh-tool-subagent";
import { nativeRoutingFixture } from "./native-routing-fixture.ts";

test("the native generic delegation tool cannot bypass a controlled parent's pending admission", { timeout: 15000 }, async () => {
  const f = await nativeRoutingFixture({ defaultActive: false }, { nativePresets: true,
    async beforeDsmm(ctx) { await ctx.plugin(NativeSubagentTool, { provider: "spawn" }).await(); } });
  try {
    const parent = await f.create({ agentPreset: "dsmm-orchestrator" });
    const result = await parent.ctx.tools.execute({ agent: parent, name: "subagent", callId: ToolCallId("native-spawn-refusal"),
      arguments: { description: "generic bypass", prompt: "must not start" }, signal: new AbortController().signal });
    assert.equal(result.isError, true);
    assert.equal(f.adapter.calls.length, 0);
    assert.deepEqual(f.agents.list(), [parent]);
    const ordinary = await f.create();
    assert.ok(ordinary.ctx.tools.get("subagent", ordinary));
    const stock = await ordinary.ctx.tools.execute({ agent: ordinary, name: "subagent", callId: ToolCallId("native-spawn-off"),
      arguments: { description: "ordinary native task", prompt: "return a local answer" }, signal: new AbortController().signal });
    assert.equal(stock.isError, false, JSON.stringify(stock));
    await f.subagents.drainDescendants([ordinary]);
    await assert.rejects(f.subagents.startActivation({ provider: "dsmm-role-coding", label: "untrusted direct call", delivery: "caller",
      request: { parent, agentPreset: "dsmm-coding", prompt: [] }, signal: new AbortController().signal }));
    assert.deepEqual(f.agents.list(), [parent, ordinary]);
  } finally { await f.dispose(); }
});

test("role adapters reject external-only and history-seeding spawn providers before model execution", { timeout: 15000 }, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true }, { nativePresets: true });
  try {
    const parent = await f.create(), capabilities = f.subagents.getProvider("spawn")!.capabilities;
    await f.spawnFiber!.dispose(); let starts = 0;
    const call = () => parent.ctx.tools.execute({ agent: parent, name: "dsmm_category", callId: ToolCallId("provider-refusal"),
      arguments: { category: "dsmm-coding", description: "unsupported seed", prompt: "must not run" }, signal: new AbortController().signal });
    const external = f.subagents.registerProvider({ name: "spawn", capabilities, inheritsParentContext: false, async start() { starts++; throw new Error("External start forbidden"); } });
    try { assert.equal((await call()).isError, true); } finally { external(); }
    const seeded = f.subagents.registerProvider({ name: "spawn", capabilities, inheritsParentContext: false, async prepareContinuable() { return { seed: [] }; } });
    try { assert.equal((await call()).isError, true); } finally { seeded(); }
    assert.equal(starts, 0); assert.equal(f.adapter.calls.length, 0); assert.deepEqual(f.agents.list(), [parent]);
  } finally { await f.dispose(); }
});
