import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { DshAgent } from "../src/dsh-types.js";
import type { DsmmProfileRuntime } from "../src/profile-runtime.js";
import { executeFixtureTool, headerRoutes, nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

const structural = (agent: Agent) => agent as unknown as DshAgent;
const profile = (id: string, locale: string, model: string) => JSON.stringify({ version: 1, id, settings: {
  defaultActive: true, locale, workflow: { policy: "legacy", reviewCap: 2 },
  roleRouting: { "dsmm-reviewer": { primary: { provider: "fixture", model, reasoningEffort: "high" } } },
} });

async function select(runtime: DsmmProfileRuntime, root: Agent, id: string | null, revision?: string) {
  const state = await runtime.getSession(structural(root));
  assert.equal(state.canApplyOverlay, true);
  return runtime.selectSession({ sessionId: root.id, id, expectedRevision: revision,
    expectedSelectionRevision: state.selection.selectionRevision, expectedAdmissionEpoch: state.admissionEpoch }, structural(root));
}

test("native tree root switches after completion and user stop for subsequent requests and delegations", {
  skip: process.env.DSMM_TEST_DSH_ENTRY === undefined && "requires explicit tree-capable Host anchor",
  timeout: 20_000,
}, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, locale: "en", subagents: { enableRunInBackground: true } }, { nativePermissionSettings: true });
  let calls = 0;
  async function delegate(root: Agent) {
    const result = await executeFixtureTool(root.ctx.tools, { agent: root, name: "dsmm_reviewer",
      callId: ToolCallId(`profile-switch-${++calls}`), signal: new AbortController().signal,
      arguments: { description: "Check selected profile", prompt: "Complete the bounded task", run_in_background: true } });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(typeof result.value === "object" && result.value !== null && "subagentId" in result.value);
    const child = f.agents.get(String(result.value.subagentId));
    assert.ok(child !== undefined);
    await (f.subagents as unknown as { waitForTreeWork(root: Agent): Promise<void> }).waitForTreeWork(root);
    await root.whenIdle();
    return child;
  }
  try {
    const runtime = f.ctx.get("dsmmProfileRuntime") as unknown as DsmmProfileRuntime;
    const a = await runtime.save({ id: "tree-a", content: profile("tree-a", "en", "a-review"), expectedRevision: null });
    const b = await runtime.save({ id: "tree-b", content: profile("tree-b", "ja", "b-review"), expectedRevision: null });
    await runtime.select({ id: a.id, expectedRevision: a.revision, expectedSelectionRevision: (await runtime.describe()).selectionRevision });
    const root = await f.create({ agentPreset: "dsmm-orchestrator" });
    const options = structuredClone(root.options);
    await runFixtureTurn(root);
    const child = await delegate(root);
    assert.equal(headerRoutes(child).at(-1)?.model, "a-review");

    await select(runtime, root, b.id, b.revision);
    await runFixtureTurn(root);
    const requestB = f.adapter.calls.filter(call => call.sessionId === root.id).at(-1)!;
    assert.match(JSON.stringify(requestB.messages), /capturedLocale\\":\\"ja/u);
    assert.match(JSON.stringify(requestB.messages), /reviewCap: 2/u);
    assert.equal(headerRoutes(root).at(-1)?.model, "native-default");
    assert.deepEqual(root.options, options);
    const newChild = await delegate(root);
    assert.equal(headerRoutes(newChild).at(-1)?.model, "b-review");

    let entered!: () => void;
    const streaming = new Promise<void>(resolve => { entered = resolve; });
    let requestSignal: AbortSignal | undefined;
    f.adapter.beforeStream = async request => {
      if (request.sessionId !== root.id) return;
      requestSignal = request.signal;
      await new Promise<void>(resolve => {
        request.signal!.addEventListener("abort", () => resolve(), { once: true });
        entered();
      });
    };
    const turn = runFixtureTurn(root);
    await streaming;
    assert.equal(root.status, "running");
    assert.equal((await runtime.getSession(structural(root))).canApplyOverlay, false);
    root.cancel({ kind: "user" });
    await turn; await root.whenIdle();
    f.adapter.beforeStream = undefined;
    assert.equal(requestSignal?.aborted, true);
    assert.equal(root.status, "idle");

    const baseline = await select(runtime, root, null);
    assert.equal(baseline.scope, "deployment-baseline");
    await runFixtureTurn(root);
    const requestBaseline = f.adapter.calls.filter(call => call.sessionId === root.id).at(-1)!;
    assert.match(JSON.stringify(requestBaseline.messages), /capturedLocale\\":\\"en/u);
    assert.equal(headerRoutes(root).at(-1)?.model, "native-default");
    assert.deepEqual(root.options, options);
    const baselineChild = await delegate(root);
    assert.equal(headerRoutes(baselineChild).at(-1)?.model, "native-default");
  } finally { await f.dispose(); }
});
