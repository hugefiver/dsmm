import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { SubagentError } from "@deepseek-ai/dsh-subagent";
import { nativeRoutingFixture } from "./native-routing-fixture.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("background role receipts wait for the exact native child's admission", async t => {
  const f = await nativeRoutingFixture({ defaultActive: true, subagents: { enableRunInBackground: true } }, { headless: true });
  const entered = gate(), proceed = gate();
  let running: Promise<unknown> | undefined;
  try {
    const parent = await f.create(), admission = f.ctx.dsmmNativeAdmission;
    const ensure = admission.ensure.bind(admission);
    let child: Agent | undefined, settled = false;
    t.mock.method(admission, "ensure", async (agent: Agent) => {
      if (agent !== parent) { child = agent; entered.release(); await proceed.promise; }
      return ensure(agent);
    });
    const executing = parent.ctx.tools.execute({ name: "dsmm_reviewer", callId: ToolCallId("pending-background-admission"),
      arguments: { description: "Await native admission", prompt: "Complete the local task", run_in_background: true },
      agent: parent, signal: new AbortController().signal });
    running = executing;
    void executing.then(() => { settled = true; });
    await entered.promise;
    assert.equal(settled, false);
    assert.ok(child);
    assert.equal(f.agents.get(child.id), child);
    proceed.release();
    const result = await executing;
    assert.equal(result.isError, false);
    if (!result.isError) assert.equal((result.value as { subagentId?: string }).subagentId, child.id);
    await child.whenIdle();
  } finally {
    proceed.release();
    await running;
    await f.dispose();
  }
});

test("failed child admission disposes a native background activation instead of returning an accepted receipt", async t => {
  const f = await nativeRoutingFixture({ defaultActive: true, subagents: { enableRunInBackground: true } }, { headless: true });
  try {
    const parent = await f.create(), admission = f.ctx.dsmmNativeAdmission;
    const ensure = admission.ensure.bind(admission);
    let child: Agent | undefined;
    t.mock.method(admission, "ensure", async (agent: Agent) => {
      if (agent !== parent) { child = agent; throw new SubagentError("Child admission refused", "UNAUTHORIZED"); }
      return ensure(agent);
    });
    const result = await parent.ctx.tools.execute({ name: "dsmm_reviewer", callId: ToolCallId("failed-background-admission"),
      arguments: { description: "Refuse native admission", prompt: "Do not run without admission", run_in_background: true },
      agent: parent, signal: new AbortController().signal });
    assert.equal(result.isError, true);
    assert.ok(child);
    assert.equal(f.agents.get(child.id), undefined);
    assert.equal(f.agents.get(parent.id), parent);
    assert.equal(f.adapter.calls.some(call => call.sessionId === child.id), false);
  } finally { await f.dispose(); }
});
