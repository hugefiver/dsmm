import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { executeFixtureTool, nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

test("a root disabled by the successor stays closed while an eligible conversation continues", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true }, { nativePresets: true });
  try {
    const dw = await f.create({ agentPreset: "dsmm-orchestrator" }), ordinary = await f.create({ agentPreset: "standard" });
    await runFixtureTurn(dw); assert.equal(f.adapter.calls.length, 1);
    await f.dsmmFiber.dispose();
    await f.mountSuccessorCore({ roles: { "dsmm-orchestrator": false } });
    await runFixtureTurn(dw); assert.equal(f.adapter.calls.length, 1);
    assert.throws(() => f.ctx.dsmmNativeAdmission.assert(dw));
    await runFixtureTurn(ordinary); assert.equal(f.adapter.calls.length, 2);
  } finally { await f.dispose(); }
});

test("an old tool decision cannot enter a body after Core replacement or hold up another root", { timeout: 20_000 }, async t => {
  let bodies = 0;
  const enteredBody = Promise.withResolvers<void>(), finishBody = Promise.withResolvers<void>();
  const f = await nativeRoutingFixture({}, { nativePresets: true, spawn: false, fixtureTools: [{
    name: "handoff_probe", description: "Count calls", parameters: {},
    output: { schema: { type: "number" }, render: () => [] }, async execute(_args, exec) {
      bodies++;
      if (exec.callId === "in-body") { enteredBody.resolve(); await finishBody.promise; }
      return bodies;
    }
  }] });
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const beforeBody = Promise.withResolvers<void>(), dispatch = Promise.withResolvers<void>();
  try {
    const root = await f.create({ agentPreset: "standard" }), other = await f.create({ agentPreset: "standard" });
    root.ctx.on("tools/pre-execute", async (exec, next) => {
      const decision = await next();
      if (exec.agent === root && exec.callId === "held") { reached.resolve(); await release.promise; }
      return decision;
    });
    root.ctx.on("tools/execute", async (exec, next) => {
      if (exec.agent === root && exec.callId === "before-body") { beforeBody.resolve(); await dispatch.promise; }
      return next();
    });
    const call = (id: string) => executeFixtureTool(root.ctx.tools, { agent: root, name: "handoff_probe", callId: ToolCallId(id), arguments: {}, signal: new AbortController().signal });
    const inBody = call("in-body"); await enteredBody.promise;
    const beforeDispatch = call("before-body"); await beforeBody.promise;
    const old = call("held");
    await reached.promise;
    await f.dsmmFiber.dispose(); await f.mountSuccessorCore();
    await runFixtureTurn(other);
    assert.equal(f.adapter.calls.length, 1);
    release.resolve(); dispatch.resolve();
    assert.equal((await old).isError, true); assert.equal((await beforeDispatch).isError, true);
    assert.equal(bodies, 1);
    assert.throws(() => f.ctx.dsmmNativeAdmission.assert(root));
    finishBody.resolve(); await inBody;
    await t.waitFor(() => f.ctx.dsmmNativeAdmission.assert(root));
    assert.equal((await call("fresh")).isError, false); assert.equal(bodies, 2);
  } finally { release.resolve(); dispatch.resolve(); finishBody.resolve(); await f.dispose(); }
});
