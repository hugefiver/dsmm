import assert from "node:assert/strict";
import { test } from "node:test";
import { ReasoningEffortId, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import * as NativeSubagentTool from "@deepseek-ai/dsh-tool-subagent";
import { headerRoutes, nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";
import type { DsmmProfileRuntime } from "../lib/profile-runtime.js";
import type { DshAgent } from "../lib/dsh-types.js";
import { resolveAdmittedDsmmRole } from "../lib/role-policy.js";
import { resolveEffectiveDsmmRole } from "../lib/session-scope.js";

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

test("ordinary native identity, persona, route and subagent execution survive Deepwork on and off", async () => {
  const route = { provider: "fixture", model: "gpt-6.1-native", reasoningEffort: ReasoningEffortId("low") };
  const f = await nativeRoutingFixture({ defaultActive: true, roleRouting: {
    "dsmm-orchestrator": { primary: { provider: "fixture", model: "forbidden-primary" }, fallbackRoutes: [{ provider: "fixture", model: "forbidden-fallback" }] }
  } }, { nativePresets: true, harnessIdentity: "NATIVE_HARNESS_IDENTITY",
    async beforeDsmm(ctx) { await ctx.plugin(NativeSubagentTool, { provider: "spawn" }).await(); } });
  try {
    await f.ctx.agentPresets.register({ id: "native-persona", name: "Native persona", description: "Native identity proof",
      plugins: [{ name: "cordis:parity-persona", config: { prefix: "NATIVE_PERSONA: You are a coding agent powered by the {{model}} model." } }] });
    const parent = await f.create({ agentPreset: "native-persona" }, { current: route, assembled: undefined }, { agentOptions: route });
    const runtime = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const parentView: Omit<DshAgent, "ctx"> = parent;
    const admission = f.ctx.dsmmNativeAdmission, children: Agent[] = [];
    f.ctx.on("agent/created", ({ agent }) => { if (f.agents.isOwnedBy(agent.id, parent)) children.push(agent); }, { global: true });
    const nativeTool = parent.ctx.tools.get("subagent", parent);
    assert.ok(nativeTool);
    let delegate = true;
    f.adapter.streamChunks = async function* (options) {
      if (options.sessionId === parent.id && delegate) {
        delegate = false;
        const id = ToolCallId(`ordinary-${children.length}`), args = JSON.stringify({ description: "Native useful child", prompt: "Return NATIVE_CHILD_RESULT" });
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield { type: "tool-call-delta", index: 0, id, name: "subagent", argumentsDelta: args };
        yield { type: "block-end", index: 0, block: { type: "tool-call", id, name: "subagent", arguments: args } };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      } else {
        const text = options.sessionId === parent.id ? "NATIVE_PARENT_RESULT" : "NATIVE_CHILD_RESULT";
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    };
    for (const active of [true, false, true]) {
      const before = await runtime.getSession(parentView);
      await runtime.selectMode({ sessionId: parent.id, active, expectedModeRevision: before.deepwork!.revision, expectedAdmissionEpoch: before.admissionEpoch }, parentView);
      const settings = runtime.getSettings(parentView), offset = f.adapter.calls.length;
      assert.equal(admission.policy.identity(parentView).role, undefined);
      assert.equal(resolveAdmittedDsmmRole(parentView, settings, active), undefined);
      assert.equal(resolveEffectiveDsmmRole(parentView, settings, active), undefined);
      assert.deepEqual(admission.policy.targets(parentView), []);
      assert.equal(parent.ctx.tools.get("subagent", parent), nativeTool);
      assert.equal(parent.ctx.tools.schemas(parent).some(tool => tool.name.startsWith("dsmm_")), false);
      assert.equal((await parent.ctx.get("skills")!.list({ scope: parent })).some(skill => skill.name === "brainstorming"), active);
      delegate = true;
      await runFixtureTurn(parent);
      const calls = f.adapter.calls.slice(offset), child = children.at(-1)!;
      const result = parent.session.snapshotEvents().filter(event => event.type === "tool/result").at(-1);
      assert.ok(result);
      assert.equal(result.data.message.isError, false, JSON.stringify(result));
      assert.equal(calls.length, 3, "native parent, child, and resumed parent each make a real request");
      assert.deepEqual(calls.map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort })), [route, route, route]);
      assert.deepEqual(headerRoutes(child), [route]);
      assert.equal(admission.invocation(child), undefined);
      const rootPrompt = JSON.stringify(calls[0].messages.filter(message => message.role === "system"));
      assert.ok(rootPrompt.includes("NATIVE_HARNESS_IDENTITY"));
      assert.ok(rootPrompt.includes(`NATIVE_PERSONA: You are a coding agent powered by the ${route.model} model.`));
      assert.equal(rootPrompt.includes("<dsmm-deepwork-mode>"), active);
      assert.equal(rootPrompt.includes("<workflow-model-calibration>"), false);
      assert.equal(rootPrompt.includes("You are DW Orchestrator."), false);
      assert.ok(JSON.stringify(calls[2].messages).includes("NATIVE_CHILD_RESULT"), "the useful child result returns to the native parent request");
      await f.subagents.drainChildren(parent, [child.id]);
      await parent.whenIdle();
    }
    assert.equal(children.length, 3);
  } finally { await f.dispose(); }
});

test("role adapters reject external-only and history-seeding spawn providers before model execution", { timeout: 15000 }, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true }, { nativePresets: true });
  try {
    const parent = await f.create({ agentPreset: "dsmm-orchestrator" }), capabilities = f.subagents.getProvider("spawn")!.capabilities;
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
