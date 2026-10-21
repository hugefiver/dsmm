import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function hold(signal: AbortSignal | undefined, until: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    void until.then(() => { signal?.removeEventListener("abort", abort); resolve(); }, reject);
  });
}

function invoke(parent: Agent, args: Record<string, unknown>, signal = new AbortController().signal) {
  return parent.ctx.tools.execute({ agent: parent, name: "dsmm_category", callId: ToolCallId(randomUUID()),
    arguments: { category: "dsmm-coding", description: "Implement the local answer", prompt: "Return the useful local answer", ...args }, signal });
}

test("official activation returns the useful Coding result and actual child identity", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, roleRouting: { "dsmm-coding": { primary: { provider: "fixture", model: "coding" } } } }, { nativePresets: true, persistence: true });
  try {
    const parent = await f.create();
    const result = await invoke(parent, {});
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(JSON.stringify(result), /fixture complete/);
    assert.equal(f.adapter.calls.length, 1);
    assert.equal(f.adapter.calls[0].model, "coding");
    const children = await f.subagents.listChildren(parent.id);
    assert.equal(children.length, 1);
    assert.equal(children[0].label, "Coding: Implement the local answer");
  } finally { await f.dispose(); }
});

test("Core mounted before the native preset registry admits Coding after its substrate is ready", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true }, { nativePresets: true, deferPresets: true });
  try {
    assert.ok(f.ctx.get("dsmmProfileRuntime"));
    await f.mountPresets();
    const parent = await f.create();
    const result = await invoke(parent, {});
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(JSON.stringify(result), /fixture complete/);
    assert.equal(f.adapter.calls.length, 1);
  } finally { await f.dispose(); }
});

test("same-parent Coding tiers retain independent immutable routes", { timeout: 15000 }, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, roleRouting: { "dsmm-coding": {
    primary: { provider: "fixture", model: "normal" }, levels: { low: { provider: "fixture", model: "small" }, high: { provider: "fixture", model: "large" } }
  } } }, { nativePresets: true });
  const ready = gate(), release = gate();
  try {
    const parent = await f.create();
    f.adapter.beforeStream = async options => { if (f.adapter.calls.length === 2) ready.release(); await hold(options.signal, release.promise); };
    const low = invoke(parent, { level: "low" }), high = invoke(parent, { level: "high" });
    await ready.promise;
    const children = f.agents.list().filter(agent => f.agents.isOwnedBy(agent.id, parent));
    assert.equal(children.length, 2);
    const admission = f.ctx.get("dsmmNativeAdmission")!;
    assert.notEqual(admission.get(children[0])?.settings, admission.get(children[1])?.settings);
    assert.deepEqual(f.adapter.calls.map(call => call.model).sort(), ["large", "small"]);
    release.release();
    for (const result of await Promise.all([low, high])) assert.equal(result.isError, false, JSON.stringify(result));
  } finally { release.release(); await f.dispose(); }
});

test("cancellation during awaited created rolls back without releasing queued input", { timeout: 15000 }, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true }, { nativePresets: true });
  const entered = gate(), release = gate(), abort = new AbortController();
  let child: Agent | undefined;
  try {
    const parent = await f.create();
    f.ctx.on("agent/created", async frame => {
      if (frame.agent.session.header.origin !== "subagent") return;
      child = frame.agent; entered.release(); await release.promise;
    }, { global: true, prepend: true });
    const running = invoke(parent, {}, abort.signal);
    await entered.promise;
    assert.ok(child && f.agents.get(child.id) === child);
    assert.equal(f.adapter.calls.length, 0);
    abort.abort(); release.release();
    const result = await running;
    assert.equal(result.isError, true);
    assert.equal(f.adapter.calls.length, 0);
    assert.equal(f.agents.get(child.id), undefined);
    const next = await invoke(parent, {});
    assert.equal(next.isError, false, JSON.stringify(next));
  } finally { release.release(); await f.dispose(); }
});

test("accepted activation cancellation disposes its child before the caller settles", { timeout: 15000 }, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true }, { nativePresets: true });
  const entered = gate(), release = gate(), abort = new AbortController();
  try {
    const parent = await f.create();
    f.adapter.beforeStream = async options => { entered.release(); await hold(options.signal, release.promise); };
    const running = invoke(parent, {}, abort.signal);
    await entered.promise;
    const children = f.agents.list().filter(agent => f.agents.isOwnedBy(agent.id, parent));
    assert.equal(children.length, 1);
    abort.abort();
    const result = await running;
    assert.equal(result.isError, true);
    assert.equal(f.agents.get(children[0].id), undefined);
    assert.equal(f.adapter.calls.length, 1);
  } finally { release.release(); await f.dispose(); }
});

test("native partial output is retained as an incomplete failure, never a successful result", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true }, { nativePresets: true });
  try {
    const parent = await f.create();
    f.adapter.streamChunks = async function* () {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "PARTIAL_LOCAL_WORK" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "PARTIAL_LOCAL_WORK" } };
      yield { type: "finish", reason: { kind: "max-tokens" } };
    };
    const result = await invoke(parent, {});
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /PARTIAL_LOCAL_WORK/);
    assert.equal(f.adapter.calls.length, 1);
  } finally { await f.dispose(); }
});

test("owner unload cancels active work and leaves live Agent execution fail closed", { timeout: 15000 }, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true }, { nativePresets: true });
  const entered = gate(), release = gate();
  try {
    const parent = await f.create();
    f.adapter.beforeStream = async options => { entered.release(); await hold(options.signal, release.promise); };
    const running = invoke(parent, {});
    await entered.promise;
    await f.dsmmFiber.dispose();
    assert.equal((await running).isError, true);
    assert.equal(f.agents.list().filter(agent => f.agents.isOwnedBy(agent.id, parent)).length, 0);
    const result = await parent.ctx.tools.execute({ agent: parent, name: "write", callId: ToolCallId(randomUUID()), arguments: {}, signal: new AbortController().signal });
    assert.equal(result.isError, true);
    assert.equal(f.adapter.calls.length, 1);
  } finally { release.release(); await f.dispose(); }
});

test("auxiliary preset roots and blank switches cannot execute tools or requests", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true }, { nativePresets: true });
  try {
    await assert.rejects(f.create({ agentPreset: "dsmm-coding" }));
    await assert.rejects(f.create({ agentPreset: "dsmm-reviewer" }));
    const parent = await f.create();
    // Delegation roles are not registered presets: the switch itself is refused
    // and the admitted dispatcher composition keeps its native authority.
    await assert.rejects(f.ctx.get("agentPresets")!.select(parent, "dsmm-coding"), /not-found|Unknown agent preset/u);
    const kept = await parent.ctx.tools.execute({ agent: parent, name: "write", callId: ToolCallId(randomUUID()), arguments: { file_path: join(f.profileDir, "kept-composition"), content: "kept" }, signal: new AbortController().signal });
    assert.equal(kept.isError, false, JSON.stringify(kept));
    await runFixtureTurn(parent);
    assert.equal(f.adapter.calls.length, 1, "the kept dispatcher composition executes its turn normally");
  } finally { await f.dispose(); }
});

test("generic native spawn is refused under a controlled parent while ordinary off remains native", async () => {
  const f = await nativeRoutingFixture({ defaultActive: false }, { nativePresets: true });
  try {
    const controlled = await f.create({ agentPreset: "dsmm-orchestrator" });
    await assert.rejects(f.subagents.startActivation({ provider: "spawn", label: "Unadmitted", signal: new AbortController().signal, delivery: "caller",
      request: { parent: controlled, agentPreset: "standard", prompt: [{ type: "text", text: "Must not execute" }] } }));
    const ordinary = await f.create();
    await runFixtureTurn(ordinary);
    const native = await f.subagents.startActivation({ provider: "spawn", label: "Ordinary native child", signal: new AbortController().signal, delivery: "caller",
      request: { parent: ordinary, agentPreset: "standard", prompt: [{ type: "text", text: "Native off path" }] } });
    assert.equal((await native.result).stopReason, "completed");
    assert.equal(f.adapter.calls.length, 2);
  } finally { await f.dispose(); }
});

test("native child messaging and interrupt preserve exact adjacency and cannot cold-recover role authority", { timeout: 15000 }, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, subagents: { enableRunInBackground: true } }, { nativePresets: true });
  const entered = gate(), release = gate();
  try {
    const parent = await f.create(), foreign = await f.create();
    f.adapter.beforeStream = async options => { entered.release(); await hold(options.signal, release.promise); };
    const result = await invoke(parent, { run_in_background: true });
    assert.equal(result.isError, false, JSON.stringify(result));
    if (result.isError) return;
    await entered.promise;
    const child = f.agents.list().find(agent => f.agents.isOwnedBy(agent.id, parent))!;
    await assert.rejects(f.subagents.sendMessage(foreign, child.id, [{ type: "text", text: "foreign" }], { signal: new AbortController().signal }));
    assert.throws(() => f.subagents.interrupt(child.id, { kind: "ancestor", agent: foreign }));
    const receipt = await f.subagents.sendMessage(parent, child.id, [{ type: "text", text: "queued" }], { signal: new AbortController().signal });
    assert.equal(typeof receipt, "string");
    f.subagents.interrupt(child.id, { kind: "ancestor", agent: parent });
    await child.whenIdle();
    assert.equal(child.session.snapshotEvents().filter(event => event.type === "turn/end").at(-1)?.data.reason.kind, "aborted");
    await f.subagents.drainChildren(parent, [child.id]);
    await assert.rejects(f.subagents.sendMessage(parent, child.id, [{ type: "text", text: "cold" }], { signal: new AbortController().signal }));
    assert.equal(f.agents.get(child.id), undefined);
  } finally { release.release(); await f.dispose(); }
});
