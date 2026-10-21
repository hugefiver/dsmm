import assert from "node:assert/strict";
import { test } from "node:test";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";
import { runtimeAdmissionView } from "../lib/runtime-integration.js";
import { parseSubagentRuntimeAdmissionView } from "../lib/profile-remote.js";

test("MAIN keeps Core configuration, ordinary execution and RPC services usable without subagents", async () => {
  const f = await nativeRoutingFixture({ defaultActive: false }, { spawn: false, nativePermissionSettings: true,
    async beforeDsmm(ctx) {
      for (const runtime of ctx.registry.values()) if (runtime.callback === SubagentRuntime)
        for (const fiber of [...runtime.fibers]) await fiber.dispose();
      await ctx.plugin(TypertRegistry).await();
    } });
  try {
    assert.equal(f.ctx.get("subagents"), undefined);
    assert.ok(f.ctx.get("dsmmDeploymentConfig"));
    assert.ok(f.ctx.get("dsmmProfileRuntime"));
    assert.ok(f.ctx.get("dsmmConfig"));
    assert.equal(f.ctx.dsmmLspState().state, "disabled");
    const state = parseSubagentRuntimeAdmissionView(runtimeAdmissionView(f.ctx));
    assert.equal(state.binding, "unavailable");
    assert.equal(state.deliveryFenceReady, false);
    const root = await f.create();
    const result = await root.ctx.tools.execute({ agent: root, name: "read", callId: ToolCallId("core-read"), arguments: {}, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    await runFixtureTurn(root);
    assert.equal(f.adapter.calls.length, 1);
    const admission = await f.ctx.get("dsmmCoreLlmOwner").admit({ agent: root, turn: 0, step: 0, signal: new AbortController().signal });
    admission.assertCurrent();
    f.ctx.get("dsmmPermissionController").rules.invalidate();
    assert.equal(admission.signal.aborted, true);
    assert.throws(() => admission.assertCurrent());
  } finally { await f.dispose(); }
});

test("MAIN never enrolls a retained unbound Agent merely because it is resident", async () => {
  let retained;
  const f = await nativeRoutingFixture({}, { nativePresets: true, async beforeDsmm(_ctx, create) { retained = await create(); } });
  try {
    assert.ok(retained);
    const result = await retained.ctx.tools.execute({ agent: retained, name: "read", callId: ToolCallId("unbound-read"), arguments: {}, signal: new AbortController().signal });
    assert.equal(result.isError, true);
    assert.equal(f.adapter.calls.length, 0);
  } finally { await f.dispose(); }
});

test("read-only child policy fences own-layer aliases and re-registered allowed tool names", async () => {
  const f = await nativeRoutingFixture({}, { nativePresets: true });
  const disposers = [];
  try {
    const root = await f.create({ agentPreset: "dsmm-orchestrator" });
    const child = await f.createAuxiliary("dsmm-reviewer", undefined, "one-shot", root);
    try {
      const tools = f.ctx.get("agentPresets").serviceFor(child, "tools") ?? child.ctx.tools;
      const execute = name => tools.execute({ agent: child, name, callId: ToolCallId(`readonly-${name}`), arguments: {}, signal: new AbortController().signal });
      assert.ok(tools.get("read", child));
      let effects = 0;
      for (const name of ["write_alias", "read"]) {
        disposers.push(tools.register({ name, description: "Fixture effect", parameters: {},
          output: { schema: { type: "string" }, render: value => [{ type: "text", text: value }] },
          async execute() { effects++; return "effect"; } }));
        assert.equal((await execute(name)).isError, true);
      }
      assert.equal(effects, 0);
    } finally { await f.releaseAuxiliary(child); }
  } finally { for (const dispose of disposers.reverse()) dispose(); await f.dispose(); }
});
