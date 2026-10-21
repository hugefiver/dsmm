import assert from "node:assert/strict";
import { test } from "node:test";
import { ReasoningEffortId, ToolCallId } from "@deepseek-ai/dsh-llm";
import { STRUCTURED_OUTPUT_TOOL, SubagentDepthError } from "@deepseek-ai/dsh-subagent";
import { nativeRoutingFixture } from "./native-routing-fixture.ts";

test("official activation enforces depth and consumes exact route and structured output options", async () => {
  const f = await nativeRoutingFixture({ defaultActive: false }, { nativePresets: true });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  try {
    const parent = await f.create(), signal = new AbortController().signal;
    const request = { parent, agentPreset: "standard", prompt: [{ type: "text" as const, text: "Return an approved result" }],
      agentOptions: { provider: "fixture", model: "request-options", reasoningEffort: ReasoningEffortId("low"), maxTokens: 30 } };
    await assert.rejects(f.subagents.startActivation({ provider: "spawn", label: "Depth bound", delivery: "caller", signal,
      request: { ...request, maxDepth: 0 } }), SubagentDepthError);
    assert.equal(f.adapter.calls.length, 0);
    assert.equal(f.agents.list().length, 1);
    f.adapter.beforeStream = async options => { entered(); options.signal?.addEventListener("abort", release, { once: true }); await held; };
    f.adapter.streamChunks = async function* () {
      const id = ToolCallId("native-options-structured");
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id, name: STRUCTURED_OUTPUT_TOOL, argumentsDelta: '{"approved":true}' };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id, name: STRUCTURED_OUTPUT_TOOL, arguments: '{"approved":true}' } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    };
    const activation = await f.subagents.startActivation({ provider: "spawn", label: "Native options", delivery: "caller", signal,
      request: { ...request, maxDepth: 2, outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"], additionalProperties: false } } });
    try {
      await ready;
      const child = f.agents.get(activation.childId)!;
      assert.ok(child);
      assert.equal(f.agents.isOwnedBy(child.id, parent), true);
      assert.equal(child.session.header.delegationDepth, 1);
      assert.equal(f.ctx.agentPresets.composedPreset(child.ctx), "standard");
      const call = f.adapter.calls[0];
      assert.equal(call.model, "request-options");
      assert.equal(call.reasoningEffort, "low");
      assert.equal(call.maxTokens, 30);
      release();
      const result = await activation.result;
      assert.equal(result.stopReason, "completed");
      assert.deepEqual(result.structured, { approved: true });
    } finally { release(); await activation.dispose(); }
  } finally { release(); await f.dispose(); }
});

test("accepted native activation is owned by its receipt rather than the creation signal", async () => {
  const f = await nativeRoutingFixture({ defaultActive: false }, { nativePresets: true });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  try {
    const parent = await f.create(), creation = new AbortController();
    f.adapter.beforeStream = async options => { entered(); await new Promise<void>(resolve => {
      if (options.signal?.aborted) resolve(); else options.signal?.addEventListener("abort", () => resolve(), { once: true });
    }); };
    const activation = await f.subagents.startActivation({ provider: "spawn", label: "Receipt lifetime", delivery: "caller", signal: creation.signal,
      request: { parent, agentPreset: "standard", prompt: [{ type: "text", text: "Wait for explicit receipt cancellation" }] } });
    try {
      await ready;
      creation.abort();
      assert.equal(f.adapter.calls[0].signal?.aborted, false);
      assert.ok(f.agents.get(activation.childId));
      await activation.dispose();
      assert.equal(f.agents.get(activation.childId), undefined);
      assert.notEqual((await activation.result).stopReason, "completed");
      assert.equal(f.adapter.calls.length, 1);
    } finally { await activation.dispose(); }
  } finally { await f.dispose(); }
});
