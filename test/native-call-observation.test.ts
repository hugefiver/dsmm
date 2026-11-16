import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import * as NativeSubagentTool from "@deepseek-ai/dsh-tool-subagent";
import type { RoleCallObservation, RoleCallObservationFrame } from "../src/role-control-types.ts";
import { parseRoleCallObservationFrame } from "../lib/role-control-remote.js";
import { gate, nativeControlFixture } from "./role-control-fixture.ts";
import { executeFixtureTool } from "./native-routing-fixture.ts";

type Fixture = Awaited<ReturnType<typeof nativeControlFixture>>;
async function open(fixture: Fixture, parent: Agent, signal = new AbortController().signal) {
  const stream = await fixture.ctx.typertGateway.stream({ namespace: "dsmmChildren", method: "observe",
    args: { sessionId: parent.id }, peer: fixture.ctx.connection.browserPeer, signal }) as AsyncIterable<RoleCallObservationFrame>;
  return stream[Symbol.asyncIterator]();
}
async function snapshot(fixture: Fixture, parent: Agent) {
  const iterator = await open(fixture, parent);
  try {
    const frame = await iterator.next();
    assert.ok(!frame.done && frame.value.type === "snapshot");
    return frame.value.calls;
  } finally { await iterator.return?.(); }
}
async function nextCall(iterator: AsyncIterator<RoleCallObservationFrame>, predicate: (call: RoleCallObservation) => boolean) {
  for (let count = 0; count < 30; count++) {
    const frame = await iterator.next();
    assert.ok(!frame.done);
    const calls = frame.value.type === "snapshot" ? frame.value.calls : frame.value.type === "update" ? [frame.value.call] : [];
    const found = calls.find(predicate);
    if (found !== undefined) return found;
  }
  throw new Error("Native observation did not reach the expected state");
}
function execute(parent: Agent, callId: string, name = "subagent", rootCallId = callId) {
  const input = { agent: parent, name, callId: ToolCallId(callId), rootCallId: ToolCallId(rootCallId),
    arguments: { description: "Native observation", prompt: "Return a local answer" }, signal: new AbortController().signal };
  return executeFixtureTool(parent.ctx.tools, input);
}
async function install(fixture: Fixture, toolName = "subagent") {
  await fixture.ctx.plugin(NativeSubagentTool, { provider: "spawn", toolName }).await();
  return fixture.create({ agentPreset: "standard" });
}

test("native receipt binds the exact call after its own header, remains active and preserves native result", { timeout: 20000 }, async () => {
  const f = await nativeControlFixture(), entered = gate(), held = gate(), receipt = gate(), abort = new AbortController();
  f.adapter.beforeStream = () => { entered.release(); return held.promise; };
  try {
    const parent = await install(f), iterator = await open(f, parent, abort.signal);
    assert.equal((await iterator.next()).value?.type, "snapshot");
    const remove = f.ctx.on("tools/post-execute", async (exec, _result, next) => {
      if (exec.agent === parent && exec.name === "subagent") await receipt.promise;
      return next();
    }, { global: true });
    const result = execute(parent, "native-live", "subagent", "ptc-root");
    await entered.promise;
    assert.deepEqual(await snapshot(f, parent), [], "a start or own header alone cannot correlate a tool call");
    receipt.release();
    const accepted = await result;
    remove();
    assert.equal(accepted.isError, false);
    if (accepted.isError) return;
    const call = await nextCall(iterator, call => call.callId === "native-live" && call.actualRoute.status === "known");
    assert.equal(call.kind, "native");
    assert.equal(call.rootCallId, "setExecutor" in f.tools ? call.callId : "ptc-root");
    assert.equal(call.phase, "active");
    assert.equal(call.delivery, "parent");
    if (call.kind !== "native") return;
    if ("resolveName" in f.subagents) assert.equal(typeof call.nativeName, "string");
    if (call.nativeName !== undefined) {
      assert.deepEqual(accepted.value, { kind: "activation", name: call.nativeName });
      assert.deepEqual(accepted.meta, { kind: "activation", name: call.nativeName });
      const runtime = f.subagents as unknown as { resolveName(parent: Agent, name: string, signal: AbortSignal): Promise<string> };
      assert.equal(await runtime.resolveName(parent, call.nativeName, abort.signal), call.childId);
    } else assert.deepEqual(accepted.value, { kind: "activation", subagentId: call.childId });
    assert.deepEqual(accepted.content, [{ type: "text", text: `started subagent ${call.nativeName ?? call.childId}` }]);
    assert.deepEqual(call.initialRoute, { status: "unknown", reason: "missing-invocation-capture" });
    assert.equal("role" in call, false);
    assert.equal("level" in call, false);
    assert.equal("routeSource" in call, false);
    assert.equal(f.ctx.dsmmNativeAdmission.invocation(f.agents.get(call.childId)!), undefined);
    if (call.actualRoute.status === "known") assert.equal(call.actualRoute.route.model, f.adapter.calls[0].model);
    const frame = { type: "update", sessionId: parent.id, admissionEpoch: call.parentAdmissionEpoch, call };
    assert.deepEqual(parseRoleCallObservationFrame(frame), frame);
    assert.throws(() => parseRoleCallObservationFrame({ ...frame, call: { ...call, role: "dsmm-coding" } }), TypeError);
    assert.throws(() => parseRoleCallObservationFrame({ ...frame, call: { ...call, initialRoute: {
      status: "known", source: "invocation-capture", route: { provider: "fixture", model: "invented" }
    } } }), TypeError);
    abort.abort(); await iterator.return?.();
    assert.equal(f.agents.get(call.childId)?.status, "running", "observer disposal leaves native execution running");
    const completed = await open(f, parent);
    held.release();
    const final = await nextCall(completed, item => item.callId === call.callId && item.phase === "settled");
    assert.equal(final.stopReason, "completed");
    assert.equal(final.runId, call.runId);
    assert.deepEqual((await snapshot(f, parent))[0], final);
    await completed.return?.();
  } finally { abort.abort(); receipt.release(); held.release(); await f.dispose(); }
});

test("a native end before its tool receipt preserves the exact terminal run and own route", { timeout: 20000 }, async () => {
  const f = await nativeControlFixture(), receipt = gate(), ended = gate();
  try {
    const parent = await install(f);
    f.ctx.on("tools/post-execute", async (exec, _result, next) => {
      if (exec.agent === parent && exec.name === "subagent") await receipt.promise;
      return next();
    }, { global: true });
    f.ctx.on("subagent/end", () => { ended.release(); }, { global: true });
    const result = execute(parent, "terminal-before-receipt");
    await ended.promise;
    assert.deepEqual(await snapshot(f, parent), []);
    receipt.release();
    assert.equal((await result).isError, false);
    const iterator = await open(f, parent);
    const final = await nextCall(iterator, call => call.callId === "terminal-before-receipt");
    assert.equal(final.phase, "settled");
    assert.equal(final.stopReason, "completed");
    assert.equal(final.actualRoute.status, "known");
    await iterator.return?.();
  } finally { receipt.release(); await f.dispose(); }
});

test("native duplicate call ids are removed while other sessions and PTC calls remain independent", { timeout: 20000 }, async () => {
  const f = await nativeControlFixture(), held = gate();
  f.adapter.beforeStream = () => held.promise;
  try {
    const first = await install(f), second = await f.create({ agentPreset: "standard" });
    const results = await Promise.all([
      execute(first, "shared"), execute(second, "shared"),
      execute(first, "nested-a", "subagent", "ptc"), execute(first, "nested-b", "subagent", "ptc")
    ]);
    assert.ok(results.every(result => !result.isError));
    for (const [parent, id] of [[first, "shared"], [second, "shared"], [first, "nested-a"], [first, "nested-b"]] as const) {
      const observed = await open(f, parent);
      await nextCall(observed, call => call.callId === id);
      await observed.return?.();
    }
    const calls = await snapshot(f, first), others = await snapshot(f, second);
    assert.equal(calls.length, 3); assert.equal(others.length, 1);
    assert.notEqual(calls.find(call => call.callId === "shared")?.childId, others[0].childId);
    assert.deepEqual(calls.filter(call => call.callId !== "shared").map(call => call.rootCallId),
      "setExecutor" in f.tools ? ["nested-a", "nested-b"] : ["ptc", "ptc"]);
    const iterator = await open(f, first);
    assert.equal((await iterator.next()).value?.type, "snapshot");
    assert.equal((await execute(first, "shared")).isError, false);
    let removed = false;
    for (let count = 0; count < 20 && !removed; count++) {
      const frame = await iterator.next();
      assert.ok(!frame.done);
      removed = frame.value.type === "remove" && frame.value.callId === "shared";
    }
    assert.ok(removed);
    assert.equal((await snapshot(f, first)).some(call => call.callId === "shared"), false);
    assert.equal((await snapshot(f, second))[0].callId, "shared");
    await iterator.return?.();
  } finally { held.release(); await f.dispose(); }
});

test("native failure and interruption keep the successful activation receipt separate from terminal outcome", { timeout: 20000 }, async t => {
  for (const stop of ["error", "aborted"] as const) await t.test(stop, async () => {
    const f = await nativeControlFixture(), entered = gate(), held = gate();
    f.adapter.beforeStream = () => { entered.release(); return held.promise; };
    if (stop === "error") f.adapter.failModels.add("native-default");
    try {
      const parent = await install(f), iterator = await open(f, parent);
      const accepted = await execute(parent, `native-${stop}`);
      assert.equal(accepted.isError, false);
      await entered.promise;
      const active = await nextCall(iterator, call => call.actualRoute.status === "known");
      assert.equal(active.phase, "active");
      if (stop === "aborted") f.agents.get(active.childId)!.cancel({ kind: "disposed" });
      held.release();
      const final = await nextCall(iterator, call => call.phase === "settled");
      assert.equal(final.stopReason, stop);
      assert.equal(final.runId, active.runId);
      assert.deepEqual(final.actualRoute, active.actualRoute);
      await iterator.return?.();
    } finally { held.release(); await f.dispose(); }
  });
});

test("matching output shape cannot attach another call's native child or a non-native identity", { timeout: 20000 }, async () => {
  const f = await nativeControlFixture(), held = gate();
  f.adapter.beforeStream = () => held.promise;
  try {
    const parent = await install(f), other = await f.create({ agentPreset: "standard" });
    const accepted = await execute(other, "real-native");
    assert.equal(accepted.isError, false);
    if (accepted.isError) return;
    const observed = await open(f, other);
    await nextCall(observed, call => call.callId === "real-native");
    await observed.return?.();
    const identity = typeof accepted.value === "object" && accepted.value !== null && "name" in accepted.value ? "name" : "subagentId";
    f.tools.register({ name: "lookalike", description: "Fixture result without a native activation", parameters: {},
      output: { schema: { type: "object", additionalProperties: false, properties: {
        kind: { type: "string", const: "activation" }, [identity]: { type: "string" }
      }, required: ["kind", identity] }, render: () => [] }, async execute() { return accepted.value; } });
    assert.equal((await execute(parent, "spoof", "lookalike")).isError, false);
    assert.deepEqual(await snapshot(f, parent), []);
    assert.equal((await snapshot(f, other)).length, 1);
    const missing = await execute(parent, "no-tool", "unknown-native-name");
    assert.equal(missing.isError, true);
    assert.deepEqual(await snapshot(f, parent), []);
  } finally { held.release(); await f.dispose(); }
});

test("concurrent same-parent tools cannot claim another execution token's native activation", { timeout: 20000 }, async () => {
  const f = await nativeControlFixture(), held = gate(), entered = gate(), copiedReceipt = Promise.withResolvers<unknown>();
  f.adapter.beforeStream = () => held.promise;
  try {
    const parent = await install(f), native = parent.ctx.tools.get("subagent", parent);
    assert.ok(native);
    f.tools.register({ name: "copy_concurrent_receipt", description: "Return another call's receipt", parameters: {},
      output: native.output, async execute() { entered.release(); return copiedReceipt.promise; } });
    const copying = execute(parent, "copying-call", "copy_concurrent_receipt");
    await entered.promise;
    const accepted = await execute(parent, "launching-call");
    assert.equal(accepted.isError, false);
    if (accepted.isError) return;
    copiedReceipt.resolve(accepted.value);
    const copied = await copying;
    assert.equal(copied.isError, false);
    if (!copied.isError) assert.deepEqual(copied.value, accepted.value);
    const iterator = await open(f, parent);
    const observed = await nextCall(iterator, call => call.callId === "launching-call");
    assert.equal(observed.phase, "active");
    assert.deepEqual((await snapshot(f, parent)).map(call => call.callId), ["launching-call"]);
    held.release();
    await nextCall(iterator, call => call.callId === "launching-call" && call.phase === "settled");
    assert.deepEqual((await snapshot(f, parent)).map(call => call.callId), ["launching-call"]);
    await iterator.return?.();
  } finally { copiedReceipt.resolve(null); held.release(); await f.dispose(); }
});
