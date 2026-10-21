import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

test("a completed root creation keeps its admission when its creation-only caller cancels", async () => {
  const f = await nativeRoutingFixture({}, { nativePresets: true });
  try {
    const caller = new AbortController(), root = await f.create({}, undefined, { signal: caller.signal });
    const admission = f.ctx.dsmmNativeAdmission.assert(root);
    caller.abort();
    assert.equal(f.ctx.dsmmNativeAdmission.assert(root), admission);
    await runFixtureTurn(root);
    assert.equal(f.adapter.calls.length, 1);
  } finally { await f.dispose(); }
});

test("retiring the exact Agent scope during awaited installation cannot publish admission", async () => {
  const f = await nativeRoutingFixture({}, { nativePresets: true });
  let release!: () => void, entered!: (agent: Agent) => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<Agent>(resolve => { entered = resolve; });
  try {
    const admission = f.ctx.dsmmNativeAdmission;
    admission.activate(async agent => { entered(agent); await held; });
    const creating = f.create();
    const rejected = assert.rejects(creating);
    const agent = await ready;
    const disposing = agent.ctx.fiber.dispose();
    release();
    await Promise.all([rejected, disposing]);
    assert.equal(admission.get(agent), undefined);
    assert.equal(f.agents.get(agent.id), undefined);
    assert.equal(f.adapter.calls.length, 0);
  } finally { release(); await f.dispose(); }
});
