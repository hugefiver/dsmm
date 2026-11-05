import assert from "node:assert/strict";
import { test, mock } from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function hold(signal: AbortSignal | undefined, until: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    void until.then(() => { signal?.removeEventListener("abort", abort); resolve(); }, reject);
  });
}
function* parallelCalls(topology: "per-role" | "parameterized", args: Record<string, unknown> = {}, sameDefinition = false): Generator<StreamChunk> {
  const requests = [
    { name: topology === "per-role" ? "dsmm_code_search" : "dsmm_role", target: topology === "per-role" ? {} : { role: "dsmm-code-search" } },
    sameDefinition ? { name: "dsmm_role", target: { role: "dsmm-doc-search" } } : { name: "dsmm_category", target: { category: "dsmm-quick" } }
  ];
  for (const [index, request] of requests.entries()) {
    const id = ToolCallId(index === 0 ? "call-A" : "call-B");
    const text = JSON.stringify({ description: `Independent ${index}`, prompt: `Return RESULT_${index}`, ...request.target, ...args });
    yield { type: "block-start", index, blockType: "tool-call" };
    yield { type: "tool-call-delta", index, id, name: request.name, argumentsDelta: text };
    yield { type: "block-end", index, block: { type: "tool-call", id, name: request.name, arguments: text } };
  }
  yield { type: "finish", reason: { kind: "tool-calls" } };
}
function* answer(text: string): Generator<StreamChunk> {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" } };
}

test("native scheduler capacity refusal publishes no overflow child while the admitted sibling is held", { timeout: 15000 }, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, roleRouting: {
    "dsmm-code-search": { primary: { provider: "fixture", model: "capacity-A" } },
    "dsmm-quick": { primary: { provider: "fixture", model: "capacity-B" } }
  } }, { nativeSubagents: { maxActiveSubagents: 1 } });
  const entered = gate(), release = gate(), rejected = gate();
  let nativeFailure: unknown;
  const start = f.subagents.startActivation.bind(f.subagents);
  const spy = mock.method(f.subagents, "startActivation", async (...args: Parameters<typeof start>) => {
    try { return await start(...args); }
    catch (error) { nativeFailure = error; rejected.release(); throw error; }
  });
  try {
    const parent = await f.create();
    const results = new Map<string, ToolExecutionResult>();
    f.ctx.on("tools/result", (execution, result) => {
      if (execution.agent === parent) results.set(execution.callId, result);
    }, { global: true });
    let rootStep = 0;
    f.adapter.beforeStream = async options => { if (options.sessionId !== parent.id) { entered.release(); await hold(options.signal, release.promise); } };
    f.adapter.streamChunks = async function* (options) {
      if (options.sessionId === parent.id && rootStep++ === 0) yield* parallelCalls("per-role");
      else yield* answer("CAPACITY_PROOF");
    };
    const turn = runFixtureTurn(parent);
    await entered.promise; await rejected.promise;
    assert.equal(f.agents.list().filter(agent => f.agents.isOwnedBy(agent.id, parent)).length, 1);
    assert.equal(f.adapter.calls.filter(call => call.sessionId !== parent.id).length, 1);
    assert.equal((nativeFailure as { code: string }).code, "ACTIVATION_LIMIT_REACHED");
    release.release(); await turn;
    const failure = [...results.values()].find(result => result.isError)!;
    assert.equal(failure.isError, true);
    if (failure.isError) assert.equal(failure.error.info?.code, "ACTIVATION_LIMIT_REACHED");
    assert.equal([...results.values()].filter(result => !result.isError).length, 1);
    assert.deepEqual(f.agents.list(), [parent]);
  } finally { release.release(); spy.mock.restore(); await f.dispose(); }
});

test("native scheduler child cancellation leaves the independent foreground sibling running", { timeout: 15000 }, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, subagents: { toolTopology: "parameterized" }, roleRouting: {
    "dsmm-code-search": { primary: { provider: "fixture", model: "cancel-A" } },
    "dsmm-quick": { primary: { provider: "fixture", model: "cancel-B" } }
  } });
  const enteredA = gate(), enteredB = gate(), release = gate(), cancelled = gate();
  try {
    const parent = await f.create();
    const results = new Map<string, ToolExecutionResult>();
    f.ctx.on("tools/result", (execution, result) => {
      if (execution.agent === parent) { results.set(execution.callId, result); if (execution.callId === "call-A") cancelled.release(); }
    }, { global: true });
    let rootStep = 0;
    f.adapter.beforeStream = async options => {
      if (options.sessionId !== parent.id) { (options.model === "cancel-A" ? enteredA : enteredB).release(); await hold(options.signal, release.promise); }
    };
    f.adapter.streamChunks = async function* (options) {
      if (options.sessionId === parent.id && rootStep++ === 0) yield* parallelCalls("parameterized");
      else yield* answer("SIBLING_PROOF");
    };
    const turn = runFixtureTurn(parent);
    await enteredA.promise; await enteredB.promise;
    const childA = f.agents.list().find(agent => agent.options.model === "cancel-A")!;
    const childB = f.agents.list().find(agent => agent.options.model === "cancel-B")!;
    f.subagents.interrupt(childA.id, { kind: "ancestor", agent: parent });
    await cancelled.promise;
    assert.equal(results.get("call-A")!.isError, true);
    assert.equal(results.has("call-B"), false);
    assert.equal(f.agents.get(childA.id), undefined);
    assert.equal(f.agents.get(childB.id), childB);
    assert.equal(f.adapter.calls.find(call => call.sessionId === childB.id)!.signal?.aborted, false);
    release.release(); await turn;
    assert.equal(results.get("call-B")!.isError, false);
    assert.deepEqual(f.agents.list(), [parent]);
  } finally { release.release(); await f.dispose(); }
});

test("forced background refuses missing native persistence without caller fallback or child publication", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, subagents: { forceBackground: true } }, { persistence: false });
  try {
    const parent = await f.create();
    const result = await parent.ctx.tools.execute({ agent: parent, name: "dsmm_code_search", callId: ToolCallId("no-persistence"),
      arguments: { description: "No persistence", prompt: "Must refuse", run_in_background: false }, signal: new AbortController().signal });
    assert.equal(result.isError, true);
    if (result.isError) assert.equal(result.error.info?.code, "PERSISTENCE_UNAVAILABLE");
    assert.equal(f.adapter.calls.length, 0);
    assert.deepEqual(f.agents.list(), [parent]);
  } finally { await f.dispose(); }
});

const forcedCases = [
  { topology: "per-role", name: "dsmm_code_search", target: {}, enable: false, argument: undefined },
  { topology: "parameterized", name: "dsmm_role", target: { role: "dsmm-code-search" }, enable: false, argument: false },
  { topology: "per-role", name: "dsmm_category", target: { category: "dsmm-quick" }, enable: true, argument: true },
  { topology: "parameterized", name: "dsmm_category", target: { category: "dsmm-quick" }, enable: false, argument: false }
] as const;

for (const row of forcedCases) test(`forced background ${row.topology} ${row.name} accepts ${String(row.argument)} with enable=${row.enable} and completes the same activation`, { timeout: 15000 }, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, subagents: { forceBackground: true, enableRunInBackground: row.enable, toolTopology: row.topology } });
  const entered = gate(), release = gate();
  const activations: Awaited<ReturnType<typeof f.subagents.startActivation>>[] = [];
  const start = f.subagents.startActivation.bind(f.subagents);
  const spy = mock.method(f.subagents, "startActivation", async (...args: Parameters<typeof start>) => {
    assert.equal(args[0].delivery, "parent");
    const activation = await start(...args); activations.push(activation); return activation;
  });
  try {
    const parent = await f.create();
    f.adapter.beforeStream = async options => { if (options.sessionId !== parent.id) { entered.release(); await hold(options.signal, release.promise); } };
    f.adapter.streamChunks = async function* (options) { yield* answer(options.sessionId === parent.id ? "PARENT_COMPLETED" : "FORCED_CHILD_PROOF"); };
    const schema = parent.ctx.tools.schemas(parent).find(tool => tool.name === row.name)!;
    assert.ok((schema.parameters as { properties: Record<string, unknown> }).properties.run_in_background);
    const prompt = renderPrompt(await f.ctx.systemPrompt.assemble({ scope: parent }));
    const lifecycle = JSON.parse(prompt.split("<dsmm-child-lifecycle-state>\n")[1].split("\n</dsmm-child-lifecycle-state>")[0]);
    assert.equal(lifecycle.backgroundEnabled, true); assert.equal(lifecycle.forceBackground, true);
    const admitted = JSON.parse(prompt.split("<dsmm-admitted-delegation>\n")[1].split("\n</dsmm-admitted-delegation>")[0]) as {
      delegation: Array<{ tool: string; parameters: string[]; background: boolean; forceBackground: boolean }> };
    const exposed = admitted.delegation.find(entry => entry.tool === row.name)!;
    assert.ok(exposed.parameters.includes("run_in_background"));
    assert.equal(exposed.background, true); assert.equal(exposed.forceBackground, true);
    const result = await parent.ctx.tools.execute({ agent: parent, name: row.name, callId: ToolCallId("forced-background"),
      arguments: { description: "Forced parent delivery", prompt: "Return a useful result", ...row.target,
        ...row.argument === undefined ? {} : { run_in_background: row.argument } }, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    if (result.isError) return;
    await entered.promise;
    assert.equal(activations.length, 1);
    const receipt = result.value as { kind: string; subagentId: Agent["id"]; messageId: string; invocation: { childId: string; mode: string } };
    const child = f.agents.get(receipt.subagentId)!;
    assert.ok(child); assert.equal(receipt.kind, "continuable"); assert.equal(typeof receipt.messageId, "string");
    assert.equal(receipt.subagentId, activations[0].childId);
    assert.equal(receipt.invocation.childId, child.id); assert.equal((result.meta as { childId: string }).childId, child.id);
    assert.equal(Object.hasOwn(receipt, "jobId"), false);
    assert.equal(child.session.snapshotEvents().some(event => event.type === "turn/end"), false, "receipt arrives while native child work remains held");
    const admission = f.ctx.dsmmNativeAdmission.get(child)!;
    assert.equal(admission.settings.subagents.forceBackground, true);
    assert.equal(admission.settings.subagents.enableRunInBackground, row.enable);
    assert.equal(Object.isFrozen(admission.settings.subagents), true);
    assert.notEqual(admission.settings, f.ctx.dsmmNativeAdmission.get(parent)!.settings);
    if (row.name === "dsmm_code_search") {
      await f.saveDeployment({ defaultActive: true, subagents: { forceBackground: false } });
      assert.equal(f.ctx.dsmmNativeAdmission.get(child), admission);
      assert.equal(admission.settings.subagents.forceBackground, true);
    }
    release.release();
    const completed = await activations[0].result;
    assert.equal(completed.stopReason, "completed");
    assert.match(JSON.stringify(completed.output), /FORCED_CHILD_PROOF/);
    await parent.whenIdle();
    const notices = parent.session.snapshotEvents().filter(event => event.type === "user/message").filter(event => event.data.source.kind === "subagent-settled");
    assert.equal(notices.length, 1);
    const source = notices[0].data.source;
    assert.ok(source.kind === "subagent-settled");
    assert.equal(source.senderSessionId, child.id);
    assert.equal(f.adapter.calls.filter(call => call.sessionId === child.id).length, 1);
    assert.equal(f.agents.get(child.id), undefined);
  } finally { release.release(); spy.mock.restore(); await f.dispose(); }
});

for (const [toolTopology, sameDefinition] of [["per-role", false], ["parameterized", false], ["parameterized", true]] as const) test(`native scheduler runs ${toolTopology} foreground ${sameDefinition ? "same-definition dsmm_role" : "role and category"} calls concurrently and correlates reverse completion`, { timeout: 15000 }, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, subagents: { toolTopology, enableRunInBackground: toolTopology === "parameterized" }, roleRouting: {
    "dsmm-code-search": { primary: { provider: "fixture", model: "held-A" } },
    [sameDefinition ? "dsmm-doc-search" : "dsmm-quick"]: { primary: { provider: "fixture", model: "held-B" } }
  } });
  const enteredA = gate(), enteredB = gate(), releaseA = gate(), releaseB = gate(), endedB = gate();
  try {
    const parent = await f.create();
    const children = new Map<string, Agent>(), results = new Map<string, ToolExecutionResult>(), tokens = new Set<unknown>();
    f.ctx.on("agent/created", ({ agent }) => { if (agent.session.header.origin === "subagent") children.set(agent.options.model!, agent); }, { global: true });
    f.ctx.on("agent/disposed", ({ agent }) => { if (agent === children.get("held-B")) endedB.release(); }, { global: true });
    f.ctx.on("tools/result", (execution, result) => {
      if (execution.agent === parent) { tokens.add(execution.token); results.set(execution.callId, result); }
    }, { global: true });
    let rootStep = 0, settled = false;
    f.adapter.beforeStream = async options => {
      if (options.model === "held-A") { enteredA.release(); await hold(options.signal, releaseA.promise); }
      if (options.model === "held-B") { enteredB.release(); await hold(options.signal, releaseB.promise); }
    };
    f.adapter.streamChunks = async function* (options) {
      if (options.sessionId === parent.id) {
        if (rootStep++ === 0) yield* parallelCalls(toolTopology, toolTopology === "parameterized" ? { run_in_background: false } : {}, sameDefinition);
        else yield* answer("PARENT_COMPLETED");
      } else yield* answer(`RESULT_${options.model}`);
    };
    const turn = runFixtureTurn(parent).then(() => { settled = true; });
    await enteredA.promise; await enteredB.promise;
    assert.equal(children.size, 2, "both native children entered held model work before either release");
    assert.equal(settled, false);
    assert.equal(parent.session.snapshotEvents().filter(event => event.type === "tool/result").length, 0);
    releaseB.release();
    await endedB.promise;
    assert.equal(f.agents.get(children.get("held-B")!.id), undefined);
    assert.equal(f.agents.get(children.get("held-A")!.id), children.get("held-A"));
    assert.equal(settled, false, "B finishing cannot settle the still-held A caller");
    assert.equal(parent.session.snapshotEvents().filter(event => event.type === "tool/result").length, 0, "native commits results in model-call order");
    releaseA.release(); await turn;
    assert.equal(tokens.size, 2, "each call retains its own native execution token");
    for (const [callId, model] of [["call-A", "held-A"], ["call-B", "held-B"]]) {
      const result = results.get(callId)!;
      assert.ok(result); assert.equal(result.isError, false, JSON.stringify(result));
      if (result.isError) continue;
      const value = result.value as { kind: string; invocation: { childId: string }; output: unknown };
      assert.equal(value.kind, "foreground");
      assert.equal(value.invocation.childId, children.get(model)!.id);
      assert.match(JSON.stringify(value.output), new RegExp(`RESULT_${model}`));
      assert.equal((result.meta as { childId: string }).childId, children.get(model)!.id);
    }
    assert.deepEqual(parent.session.snapshotEvents().filter(event => event.type === "tool/result").map(event => event.data.message.toolCallId), ["call-A", "call-B"]);
    assert.deepEqual(f.agents.list(), [parent]);
  } finally { releaseA.release(); releaseB.release(); await f.dispose(); }
});
