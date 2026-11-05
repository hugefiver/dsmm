import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { RemoteStream } from "@deepseek-ai/dsh-api-gateway/client";
import type { RemoteStreamOptions } from "@deepseek-ai/dsh-api-gateway/client";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { RoleCallObservation, RoleCallObservationFrame } from "../src/role-control-types.ts";
import { RoleCallObservationController } from "../lib/client/role-call-observations.js";
import { parseRoleCallObservationFrame } from "../lib/role-control-remote.js";
import { gate, nativeControlFixture, remoteErrorOf } from "./role-control-fixture.ts";

async function open(fixture: Awaited<ReturnType<typeof nativeControlFixture>>, root: Agent, signal: AbortSignal) {
  return await fixture.ctx.typertGateway.stream({ namespace: "dsmmChildren", method: "observe",
    args: { sessionId: root.id }, peer: fixture.ctx.connection.browserPeer, signal }) as AsyncIterable<RoleCallObservationFrame>;
}

async function nextCall(iterator: AsyncIterator<RoleCallObservationFrame>, predicate: (call: RoleCallObservation) => boolean): Promise<RoleCallObservation> {
  for (let count = 0; count < 20; count++) {
    const next = await iterator.next();
    if (next.done) throw new Error("Role call stream ended before the expected call");
    const calls = next.value.type === "snapshot" ? next.value.calls : next.value.type === "update" ? [next.value.call] : [];
    const call = calls.find(predicate);
    if (call !== undefined) return call;
  }
  throw new Error("Role call stream exceeded its bounded update window");
}

async function nextRemoval(iterator: AsyncIterator<RoleCallObservationFrame>, callId: string): Promise<void> {
  for (let count = 0; count < 20; count++) {
    const next = await iterator.next();
    if (next.done) throw new Error("Role call stream ended before duplicate removal");
    if (next.value.type === "remove" && next.value.callId === callId) return;
  }
  throw new Error("Role call stream exceeded its duplicate-removal window");
}

async function collectCalls(iterator: AsyncIterator<RoleCallObservationFrame>, expected: ReadonlySet<string>): Promise<Map<string, RoleCallObservation>> {
  const calls = new Map<string, RoleCallObservation>();
  for (let count = 0; count < 60; count++) {
    const next = await iterator.next();
    if (next.done) throw new Error("Role call stream ended before all expected calls");
    if (next.value.type === "remove") calls.delete(next.value.callId);
    else for (const call of next.value.type === "snapshot" ? next.value.calls : [next.value.call]) calls.set(call.callId, call);
    if ([...expected].every(id => calls.get(id)?.actualRoute.status === "known")) return calls;
  }
  throw new Error("Role call stream exceeded its bounded multi-call window");
}

async function waitForSource<T>(source: { getSnapshot(): T; subscribe(listener: () => void): () => void }, predicate: (value: T) => boolean): Promise<T> {
  const current = source.getSnapshot();
  if (predicate(current)) return current;
  return await new Promise(resolve => {
    const stop = source.subscribe(() => {
      const value = source.getSnapshot();
      if (!predicate(value)) return;
      stop(); resolve(value);
    });
  });
}

async function expectStreamEnd(iterator: AsyncIterator<RoleCallObservationFrame>): Promise<void> {
  let next: IteratorResult<RoleCallObservationFrame>;
  try { next = await iterator.next(); }
  catch (error) {
    const code = remoteErrorOf(error)?.code;
    assert.ok(code === "dsmm-children/refused" || code === "gateway/cancelled", `unexpected stream failure: ${String(code)}`);
    return;
  }
  assert.equal(next.done, true);
}

async function execute(root: Agent, callId: string, options: { background?: boolean; rootCallId?: string; category?: "dsmm-coding" | "dsmm-quick" } = {}) {
  return root.ctx.tools.execute({ agent: root, name: "dsmm_category", callId: ToolCallId(callId),
    ...(options.rootCallId === undefined ? {} : { rootCallId: ToolCallId(options.rootCallId) }),
    arguments: { category: options.category ?? "dsmm-coding", description: callId, prompt: "Return a local answer",
      ...(options.background ? { run_in_background: true } : {}) }, signal: new AbortController().signal });
}

test("real Gateway publishes this activation route before foreground result and observer disposal does not cancel it", { timeout: 20000 }, async () => {
  const fixture = await nativeControlFixture(), entered = gate(), held = gate(), observation = new AbortController();
  fixture.adapter.beforeStream = () => { entered.release(); return held.promise; };
  try {
    const root = await fixture.create(), stream = await open(fixture, root, observation.signal), iterator = stream[Symbol.asyncIterator]();
    const opening = await iterator.next();
    assert.ok(!opening.done && opening.value.type === "snapshot");
    let settled = false;
    const result = execute(root, "foreground-observed").then(value => { settled = true; return value; });
    await entered.promise;
    const live = await nextCall(iterator, call => call.callId === "foreground-observed" && call.actualRoute.status === "known" && call.runId !== undefined);
    assert.equal(settled, false);
    assert.equal(live.rootCallId, live.callId);
    assert.equal(live.delivery, "caller");
    assert.equal(live.phase, "active");
    assert.equal(live.actualRoute.status, "known");
    if (live.actualRoute.status === "known") assert.equal(live.actualRoute.route.model, fixture.adapter.calls[0].model);

    observation.abort();
    await iterator.return?.();
    assert.equal(settled, false, "disposing the observer must not dispose the activation");
    held.release();
    const completed = await result;
    assert.equal(completed.isError, false);

    const replayAbort = new AbortController(), replay = await open(fixture, root, replayAbort.signal), replayIterator = replay[Symbol.asyncIterator]();
    const frozen = await nextCall(replayIterator, call => call.callId === "foreground-observed");
    assert.equal(frozen.phase, "settled");
    assert.equal(frozen.stopReason, "completed");
    assert.equal(frozen.runId, live.runId);
    assert.deepEqual(frozen.actualRoute, live.actualRoute);

    await fixture.invoke("prompt", { sessionId: root.id, request: fixture.request(root, frozen.childId, "later activation") });
    const resumed = fixture.agents.get(frozen.childId);
    if (resumed !== undefined) await resumed.whenIdle();
    const after = await open(fixture, root, new AbortController().signal), afterIterator = after[Symbol.asyncIterator]();
    const stillFrozen = await nextCall(afterIterator, call => call.callId === "foreground-observed");
    assert.deepEqual(stillFrozen, frozen, "later same-child headers cannot rewrite the old call");
    replayAbort.abort(); await replayIterator.return?.(); await afterIterator.return?.();
  } finally { held.release(); await fixture.dispose(); }
});

test("real stream and success meta whitelist route fields while the observation codec rejects extras", { timeout: 20000 }, async () => {
  const fixture = await nativeControlFixture({ roleRouting: { "dsmm-coding": { primary: {
    provider: "fixture", model: "whitelist-model", reasoningEffort: "high", temperature: 0.3, stop: ["END"],
  } } } }), abort = new AbortController();
  try {
    const root = await fixture.create(), stream = await open(fixture, root, abort.signal), iterator = stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "snapshot");
    const resultPromise = execute(root, "whitelist-call");
    const observed = await nextCall(iterator, call => call.callId === "whitelist-call" && call.actualRoute.status === "known");
    const result = await resultPromise;
    assert.equal(result.isError, false);
    assert.deepEqual(Object.keys(observed.initialRoute.status === "known" ? observed.initialRoute.route : {}).sort(), ["model", "provider", "reasoningEffort"]);
    assert.ok(Object.keys(observed.actualRoute.status === "known" ? observed.actualRoute.route : {}).every(key => ["model", "provider", "reasoningEffort"].includes(key)));
    const meta = result.meta as { route?: object; routeComparison?: { initialRoute: { status: string; route?: object }; liveRoute: { status: string; route?: object } } };
    assert.deepEqual(Object.keys(meta.route ?? {}).sort(), ["model", "provider", "reasoningEffort"]);
    assert.deepEqual(Object.keys(meta.routeComparison?.initialRoute.route ?? {}).sort(), ["model", "provider", "reasoningEffort"]);
    assert.throws(() => parseRoleCallObservationFrame({ type: "update", sessionId: root.id, admissionEpoch: observed.parentAdmissionEpoch,
      call: { ...observed, initialRoute: { status: "known", source: "invocation-capture", route: {
        provider: "fixture", model: "leak", reasoningEffort: "high", temperature: 0.7,
      } } } }), TypeError);
  } finally { abort.abort(); await fixture.dispose(); }
});

test("same-session repeated callId executes and removes ambiguous live projection while each result keeps exact child evidence", { timeout: 20000 }, async () => {
  const fixture = await nativeControlFixture(), abort = new AbortController();
  try {
    const root = await fixture.create(), stream = await open(fixture, root, abort.signal), iterator = stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "snapshot");
    const first = await execute(root, "repeat-call", { rootCallId: "ptc-root" });
    assert.equal(first.isError, false);
    const firstMeta = first.meta as { childId?: string; routeComparison?: { childId: string } } | undefined;
    assert.ok(firstMeta?.childId);
    const secondResult = execute(root, "repeat-call", { rootCallId: "ptc-root" });
    await nextRemoval(iterator, "repeat-call");
    const second = await secondResult;
    assert.equal(second.isError, false);
    const secondMeta = second.meta as { childId?: string; routeComparison?: { childId: string } } | undefined;
    assert.ok(secondMeta?.childId);
    assert.notEqual(secondMeta.childId, firstMeta.childId);
    assert.equal(firstMeta.routeComparison?.childId, firstMeta.childId);
    assert.equal(secondMeta.routeComparison?.childId, secondMeta.childId);
    const replay = await open(fixture, root, new AbortController().signal), replayIterator = replay[Symbol.asyncIterator]();
    const snapshot = await replayIterator.next();
    assert.ok(!snapshot.done && snapshot.value.type === "snapshot");
    if (snapshot.value.type === "snapshot") assert.equal(snapshot.value.calls.some(call => call.callId === "repeat-call"), false);
    await replayIterator.return?.();
  } finally { abort.abort(); await fixture.dispose(); }
});

test("same rootCallId PTC calls remain independent and same callId is isolated by parent session", { timeout: 20000 }, async () => {
  const fixture = await nativeControlFixture(), held = gate();
  fixture.adapter.beforeStream = () => held.promise;
  const abortA = new AbortController(), abortB = new AbortController();
  try {
    const parentA = await fixture.create(), parentB = await fixture.create();
    const streamA = await open(fixture, parentA, abortA.signal), iteratorA = streamA[Symbol.asyncIterator]();
    const streamB = await open(fixture, parentB, abortB.signal), iteratorB = streamB[Symbol.asyncIterator]();
    assert.equal((await iteratorA.next()).value?.type, "snapshot");
    assert.equal((await iteratorB.next()).value?.type, "snapshot");
    const results = await Promise.all([
      execute(parentA, "shared-call", { background: true }), execute(parentB, "shared-call", { background: true }),
      execute(parentA, "ptc-a", { background: true, rootCallId: "ptc-root" }),
      execute(parentA, "ptc-b", { background: true, rootCallId: "ptc-root" }),
    ]);
    assert.ok(results.every(result => !result.isError));
    const [callsA, callsB] = await Promise.all([
      collectCalls(iteratorA, new Set(["shared-call", "ptc-a", "ptc-b"])),
      collectCalls(iteratorB, new Set(["shared-call"])),
    ]);
    assert.equal(callsA.size, 3);
    assert.equal(callsB.size, 1);
    assert.equal(callsA.get("shared-call")?.parentSessionId, parentA.id);
    assert.equal(callsB.get("shared-call")?.parentSessionId, parentB.id);
    assert.notEqual(callsA.get("shared-call")?.childId, callsB.get("shared-call")?.childId);
    assert.equal(callsA.get("ptc-a")?.rootCallId, "ptc-root");
    assert.equal(callsA.get("ptc-b")?.rootCallId, "ptc-root");
    assert.notEqual(callsA.get("ptc-a")?.callId, callsA.get("ptc-b")?.callId);
    assert.equal(callsA.get("ptc-a")?.delivery, "parent");
    assert.equal(callsA.get("ptc-b")?.phase, "active");
  } finally {
    abortA.abort(); abortB.abort(); held.release();
    await fixture.dispose();
  }
});

test("real Gateway observes nested child delegation without widening child control authority", { timeout: 20000 }, async () => {
  const fixture = await nativeControlFixture({ subagents: { maxDepth: 3 } }), held = gate(), abort = new AbortController();
  fixture.adapter.beforeStream = () => held.promise;
  try {
    const root = await fixture.create(), child = await fixture.start(root, "Nested parent");
    const stream = await open(fixture, child, abort.signal), iterator = stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "snapshot");
    const result = await execute(child, "nested-call", { background: true, category: "dsmm-quick" });
    assert.equal(result.isError, false, JSON.stringify(result));
    const nested = await nextCall(iterator, call => call.callId === "nested-call" && call.actualRoute.status === "known");
    assert.equal(nested.parentSessionId, child.id);
    assert.notEqual(nested.childId, child.id);
    await assert.rejects(fixture.invoke("describe", { sessionId: child.id }), error => remoteErrorOf(error)?.details.code === "not-owned");
    abort.abort(); await iterator.return?.(); held.release();
    await fixture.subagents.drainChildren(root, [child.id]);
    await assert.rejects(open(fixture, child, new AbortController().signal), error => {
      const code = remoteErrorOf(error)?.details.code;
      return code === "not-found" || code === "not-owned";
    });
  } finally { abort.abort(); held.release(); await fixture.dispose(); }
});

test("observation stream continuously authenticates connection and admission lifetimes", { timeout: 20000 }, async () => {
  const fixture = await nativeControlFixture();
  try {
    const root = await fixture.create(), firstAbort = new AbortController();
    const first = await open(fixture, root, firstAbort.signal), firstIterator = first[Symbol.asyncIterator]();
    assert.equal((await firstIterator.next()).value?.type, "snapshot");
    await fixture.replaceConnection();
    await expectStreamEnd(firstIterator);

    const second = await open(fixture, root, new AbortController().signal), secondIterator = second[Symbol.asyncIterator]();
    assert.equal((await secondIterator.next()).value?.type, "snapshot");
    await fixture.dsmmFiber.dispose();
    await expectStreamEnd(secondIterator);
  } finally { await fixture.dispose(); }
});

test("production client source consumes real Gateway frames and fences connection replacement", { timeout: 20000 }, async () => {
  const fixture = await nativeControlFixture(), held = gate(), controller = new RoleCallObservationController();
  fixture.adapter.beforeStream = () => held.promise;
  try {
    const root = await fixture.create(), callId = randomUUID();
    const gatewayOpen = async function* (sessionId: string, signal: AbortSignal): AsyncIterable<RoleCallObservationFrame> {
      const stream = await fixture.ctx.typertGateway.stream({ namespace: "dsmmChildren", method: "observe", args: { sessionId },
        peer: fixture.ctx.connection.browserPeer, signal });
      yield* stream as AsyncIterable<RoleCallObservationFrame>;
    };
    const generation = { getSnapshot: () => ({ id: 1, host: { home: "C:/fixture" } }), subscribe: () => () => {} };
    const firstFactory = { $stream<Item>(options: RemoteStreamOptions<Item>) { return new RemoteStream<Item>({ generation }, options); } };
    const unbindFirst = controller.bindConnection(firstFactory, gatewayOpen);
    const source = controller.source(root.id), stop = source.subscribe(() => {});
    await waitForSource(source, state => state.status === "live");
    const result = await execute(root, callId, { background: true });
    assert.equal(result.isError, false);
    const live = await waitForSource(source, state => state.calls.get(callId)?.actualRoute.status === "known");
    const observed = live.calls.get(callId)!;
    assert.equal(observed.delivery, "parent");
    assert.equal(observed.phase, "active");

    await fixture.replaceConnection();
    const unavailable = await waitForSource(source, state => state.status === "unavailable");
    assert.deepEqual(unavailable.calls.get(callId)?.actualRoute, { status: "unknown", reason: "not-observed" });
    assert.equal(unavailable.calls.get(callId)?.phase, "active");

    const secondGeneration = { ...generation, getSnapshot: () => ({ id: 2, host: { home: "C:/fixture" } }) };
    const secondFactory = { $stream<Item>(options: RemoteStreamOptions<Item>) { return new RemoteStream<Item>({ generation: secondGeneration }, options); } };
    const unbindSecond = controller.bindConnection(secondFactory, gatewayOpen);
    assert.equal(source.getSnapshot().calls.size, 0, "new connection identity clears the old cache before accepting frames");
    unbindFirst();
    const replaced = await waitForSource(source, state => state.status === "live" && state.calls.get(callId)?.runId === observed.runId);
    assert.equal(replaced.calls.get(callId)?.parentAdmissionEpoch, observed.parentAdmissionEpoch);
    controller.dispose();
    assert.equal(fixture.agents.get(observed.childId)?.status, "running", "client source disposal must not cancel activation");
    stop(); unbindSecond();
  } finally { controller.dispose(); held.release(); await fixture.dispose(); }
});
