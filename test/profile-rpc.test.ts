import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import * as Cordis from "@deepseek-ai/cordis";
import { Context } from "@deepseek-ai/cordis";
import type { Service } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import * as NativeConnection from "@deepseek-ai/dsh-client-connection";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import type { ClientRemote } from "@deepseek-ai/dsh-api-gateway/client";
import { RemoteAccessService } from "@deepseek-ai/dsh-api-remote-access";
import { remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import type { ConnectionInstallOptions } from "@deepseek-ai/dsh-client-connection/client";
import { TYPERT_REMOTE } from "../src/profile-remote.ts";
import { ProfileStore } from "../src/profile-store.ts";
import type { ProfileStoreOptions } from "../src/profile-store.ts";
import type { DsmmProfileRuntime } from "../src/profile-runtime.ts";
import dsmmPlugin from "../src/index.ts";
import type { DshAgent, DshContext } from "../src/dsh-types.ts";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";
import { nativeConfigRun } from "./native-config-fixture.ts";

useIsolatedDshEnvironment();
const require = createRequire(import.meta.url);
// Client diagnostics are TSX; share the existing non-emitting source hook.
require("./profile-apply-source-loader.mjs");
const { canReconcileSelection, ProfilesController } = await import("../src/client/controller.ts");
const sdk = createRequire(require.resolve("@deepseek-ai/dsh-client-connection"));
const { CredentialProvider } = sdk("@deepseek-ai/dsh-credentials") as { CredentialProvider: new (ctx: Context) => Service };
class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<string, unknown>();
  async modifyRecord(key: string, modify: (current: unknown) => Promise<unknown>) {
    const next = await modify(this.records.get(key));
    if (next !== undefined) this.records.set(key, next);
    return this.records.get(key);
  }
}
type NativeClientModule = { inject: string[]; apply(ctx: Context): void; installConnection?(ctx: Context, options: ConnectionInstallOptions): void };
async function nativeClient(packageName: string): Promise<NativeClientModule> {
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = manifest.exports["./client"];
  const source = await readFile(join(dirname(manifestPath), entry.browser ?? entry.default), "utf8");
  let factory: ((require: (id: string) => unknown) => NativeClientModule) | undefined;
  const realm = createContext({ crypto: globalThis.crypto, AbortController, AbortSignal, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, queueMicrotask, console, window: { __ModuleLoader__: { load(row: { factory: typeof factory }) { factory = row.factory; } } } });
  runInContext(source, realm);
  delete realm.window;
  assert.ok(factory);
  return factory((id) => { assert.equal(id, "@deepseek-ai/cordis"); return Cordis; });
}

async function fixture(storeOptions?: ProfileStoreOptions) {
  const run = nativeConfigRun(), client = new Context();
  try {
    const profile = await run.createProfile("profile-rpc"), host = profile.ctx;
    // The source loader remaps this existing fixture's lib imports as well.
    const runtime = profile.runtime as unknown as DsmmProfileRuntime;
    const store = Reflect.get(runtime, "store") as ProfileStore;
    if (storeOptions?.observe !== undefined) Reflect.set(store, "observe", storeOptions.observe);
    const settingsOwner = Reflect.get(host.settings, Cordis.symbols.original) ?? host.settings;
    const settingsFiber: Context["fiber"] = Reflect.get(settingsOwner, "ctx").fiber;
    assert.equal(host.settings.writable, true);
    assert.equal(profile.descriptor().ns, profile.entry.options.id);
    assert.equal(host.settings.documentPath, profile.patchPath);
    assert.equal(host.agents.list().length, 0);
    const carrier = { host: "127.0.0.1" }; host.provide("webServer", carrier);
    await host.plugin(MemoryCredentials).await();
    const connectionFiber = host.plugin(NativeConnection); await connectionFiber.await();
    const peer = host.connection.browserPeer;
    await host.plugin(RemoteAccessService).await();
    await Promise.all([host.plugin(TypertRegistry).await(), host.plugin(TypertGatewayService, {}).await(), client.plugin(TypertRegistry).await()]);
    const gateway = host.typertGateway;
    for (const fiber of [...host.registry.values()].flatMap(row => [...row.fibers]).filter(fiber => Object.hasOwn(fiber.inject, "typert"))) await fiber.await();
    const rpcOwner = Reflect.get(host.dsmmProfiles, Cordis.symbols.original) ?? host.dsmmProfiles;
    const rpcFiber: Context["fiber"] = Reflect.get(rpcOwner, "ctx").fiber;
    gateway.registerRemoteEvents(async function* (signal) { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); }, { home: "isolated-test" });
    const connection = await nativeClient("@deepseek-ai/dsh-client-connection");
    assert.ok(connection.installConnection);
    let offline = false;
    connection.installConnection(client, { transport: { ownsHost: true, rpc: {
      async call(channel, endpoint, payload, signal) {
        assert.equal(channel, "/api");
        if (offline) throw new Error("PRIVATE_TRANSPORT_SENTINEL");
        const [namespace, method] = endpoint.split("/");
        const args = (payload as { args: Record<string, unknown> }).args;
        try { return { ok: true, value: await gateway.invoke({ namespace, method, args, signal, peer }) }; }
        catch (error) {
          const failure = remoteErrorOf(error);
          if (failure === undefined) throw error;
          return { ok: false, error: { code: failure.code, message: failure.message, details: failure.details } };
        }
      },
      async *open(channel, endpoint, payload, signal, uplink) {
        assert.equal(channel, "/api");
        yield* await gateway.wireStream.open(endpoint, payload, uplink ?? (async function* () {})(), peer, signal);
      },
    } } });
    await client.plugin(await nativeClient("@deepseek-ai/dsh-api-gateway")).await();
    const remote: ClientRemote = client.remote;
    const unmount = await remote.$mount(TYPERT_REMOTE);
    return { root: run.root, home: run.home, profile, host, client, gateway, peer, store, runtime, remote, unmount, rpcFiber, connectionFiber, settingsFiber, carrier,
      offline(value: boolean) { offline = value; },
      async dispose() { await client.fiber.dispose(); await run.dispose(); } };
  } catch (error) { await client.fiber.dispose(); await run.dispose(); throw error; }
}

async function savedPair(f: Awaited<ReturnType<typeof fixture>>) {
  const a = await f.remote.dsmmProfiles.save({ id: "a", content: '{"version":1,"id":"a","settings":{"workflow":{"reviewCap":1}}}', expectedRevision: null });
  const b = await f.remote.dsmmProfiles.save({ id: "b", content: '{"version":1,"id":"b","settings":{"workflow":{"reviewCap":4}}}', expectedRevision: null });
  assert.ok(a.ok && b.ok);
  return { a: a.value, b: b.value };
}
const refused = (code: string) => (error: unknown) => {
  const remote = remoteErrorOf(error);
  return remote?.code === "dsmm-profiles/refused" && remote.details.code === code;
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("strict codecs reject authority, path, malformed revision, and unsupported result fields", () => {
  for (const descriptor of TYPERT_REMOTE.descriptors) {
    assert.equal(descriptor.result.mode, "strict");
    for (const parameter of descriptor.parameters) assert.equal(parameter.codec.mode, "strict");
  }
  const save = TYPERT_REMOTE.descriptors.find(item => item.service === "dsmmProfiles" && item.method === "save")!.parameters[0].codec;
  const select = TYPERT_REMOTE.descriptors.find(item => item.method === "select")!.parameters[0].codec;
  if (save.mode !== "strict" || select.mode !== "strict") assert.fail("strict codecs required");
  const valid = { id: "example", content: "{}", expectedRevision: null };
  assert.deepEqual(save.create().parse(valid), valid);
  for (const request of [{ ...valid, path: "C:/private" }, { ...valid, peer: {} }, { ...valid, id: "../escape" }, { ...valid, expectedRevision: "bad" }, { ...valid, content: null }]) assert.throws(() => save.create().parse(request));
  assert.throws(() => select.create().parse({ id: "example", expectedSelectionRevision: "absent" }));
  assert.throws(() => select.create().parse({ id: null, expectedSelectionRevision: "unavailable" }));
  const result = TYPERT_REMOTE.descriptors[0].result;
  if (result.mode !== "strict") assert.fail("strict result required");
  assert.throws(() => result.create().parse({ profiles: [], selectedId: null, appliedRevision: null, selectionRevision: "absent", credentials: {} }));
  assert.throws(() => result.create().parse({ profiles: [{ id: "example", revision: false }], selectedId: null, appliedRevision: null, selectionRevision: "absent" }));
});

test("production profile injection owns live native RPC children and withdraws services/codecs", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsmm-production-rpc-")), ctx = new Context();
  try {
    await ctx.plugin(RemoteAccessService).await();
    await Promise.all([ctx.plugin(TypertRegistry).await(), ctx.plugin(TypertGatewayService, {}).await(), ctx.plugin(AgentRegistry).await()]);
    ctx.provide("profileContext", { home: root, dir: root, startedBundles: [] });
    const entry = ctx.plugin({ name: "production-rpc", Config: dsmmPlugin.Config, inject: [...dsmmPlugin.inject],
      apply(ready: Context, config: Parameters<typeof dsmmPlugin.apply>[1]) { return dsmmPlugin.apply(ready as unknown as DshContext, config); } }, {});
    await entry.await();
    const owned = (fiber: Context["fiber"]): boolean => fiber.uid !== 0 && (fiber.uid === entry.uid || owned(fiber.parent.fiber));
    for (const fiber of [...ctx.registry.values()].flatMap(row => [...row.fibers]).filter(fiber => owned(fiber) && Object.hasOwn(fiber.inject, "typert"))) await fiber.await();
    for (const name of ["dsmmProfiles", "dsmmConfig"]) {
      const service = ctx.get(name); assert.ok(service);
      const original = Reflect.get(service, Cordis.symbols.original) ?? service;
      assert.ok(owned(original.ctx.fiber)); assert.equal(original.ctx.fiber.state, 2);
    }
    const peer = new NativeConnection.Peer(ctx, { principal: { kind: "owner" } });
    const snapshot = await ctx.typertGateway.invoke({ namespace: "dsmmProfiles", method: "describe", args: {}, peer });
    assert.equal((snapshot as { selectedId: string | null }).selectedId, null);
    await entry.dispose();
    for (const namespace of ["dsmmProfiles", "dsmmConfig"]) await assert.rejects(ctx.typertGateway.invoke({ namespace, method: "describe", args: {}, peer }), error => String(remoteErrorOf(error)?.code) === "gateway/definition-unavailable");
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("genuine Gateway operator saves drafts without any session and conflicts retain dirty state", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.host.dsmmProfiles.describe(), error => remoteErrorOf(error)?.code === "dsmm-profiles/peer-required");
    await assert.rejects(f.gateway.invoke({ namespace: "dsmmProfiles", method: "save", peer: f.peer, args: { request: { id: "../escape", content: "{}", expectedRevision: null } } }), error => String(remoteErrorOf(error)?.code) === "gateway/input-invalid");
    await assert.rejects(f.gateway.invoke({ namespace: "dsmmProfiles", method: "describe", peer: f.peer, args: { peer: { id: "forged" } } }), error => String(remoteErrorOf(error)?.code) === "gateway/arguments-invalid");
    const controller = new ProfilesController(f.remote.dsmmProfiles);
    await controller.refresh(); await controller.actions.create(); controller.actions.editId("everyday"); await controller.save();
    const saved = controller.store.getSnapshot();
    assert.equal(saved.notice?.key, "saved"); assert.equal(saved.snapshot?.selectedId, null); assert.equal(saved.dirty, false); assert.ok(saved.editor?.revision);
    await controller.apply(); assert.equal(controller.store.getSnapshot().snapshot?.selectedId, "everyday");
    controller.actions.editContent(saved.editor!.content + "\n// draft\n");
    const draft = controller.store.getSnapshot().editor!.content;
    await f.store.save({ id: "everyday", content: draft + "\n", expectedRevision: saved.editor!.revision }); await controller.save();
    assert.equal(controller.store.getSnapshot().issue?.code, "conflict"); assert.equal(controller.store.getSnapshot().editor?.content, draft);
    assert.equal(controller.store.getSnapshot().snapshot?.selectedId, "everyday"); assert.equal(controller.store.getSnapshot().notice, null);
    controller.dispose();
  } finally { await f.dispose(); }
});

test("Gateway save refuses independent and same-ID peers, readonly Settings, nonlocal carrier and JSON authority", async () => {
  const f = await fixture();
  const request = { id: "draft", content: '{"version":1,"id":"draft","settings":{}}', expectedRevision: null };
  try {
    const invoke = (peer = f.peer, input: unknown = request) => f.gateway.invoke({ namespace: "dsmmProfiles", method: "save", args: { request: input }, peer });
    const other = f.host.connection.createPeer({ principal: { kind: "owner" } });
    const impostor = { ...f.peer, ctx: f.host, async dispose() {} };
    assert.equal(impostor.id, f.peer.id);
    await assert.rejects(invoke(other), refused("not-owned")); await assert.rejects(invoke(impostor), refused("not-owned"));
    await assert.rejects(invoke(f.peer, { ...request, peer: f.peer.id }), error => String(remoteErrorOf(error)?.code) === "gateway/input-invalid");
    f.carrier.host = "0.0.0.0"; await assert.rejects(invoke(), refused("not-owned")); f.carrier.host = "127.0.0.1";
    Object.defineProperty(Reflect.get(f.host.settings, Cordis.symbols.original) ?? f.host.settings, "writable", { configurable: true, value: false });
    await assert.rejects(invoke(), refused("not-owned"));
    assert.deepEqual((await f.store.describe()).profiles, []);
  } finally { await f.dispose(); }
});

test("Gateway save rechecks caller, connection owner and Host lifetime on both sides of lock acquisition", { timeout: 20000 }, async t => {
  for (const phase of ["before-lock", "after-lock"] as const) for (const change of ["request", "peer", "operator", "owner", "connection", "service", "host", "settings"] as const) await t.test(`${phase}/${change}`, async () => {
    const f = await fixture(), entered = gate(), release = gate(), backendSettled = gate();
    const connection = Reflect.get(f.host.connection, Cordis.symbols.original) ?? f.host.connection;
    const ownerContext = Reflect.get(connection, "ctx") as Context;
    const operator = connection.browserPeer, abort = new AbortController();
    const save = f.store.save.bind(f.store);
    const revoke = async () => {
      if (change === "request") abort.abort(); else if (change === "peer") await operator.dispose();
      else if (change === "operator") Reflect.set(connection, "browserPeer", f.host.connection.createPeer({ principal: { kind: "owner" } }));
      else if (change === "owner") {
        ownerContext.set("connection", Object.create(Object.getPrototypeOf(connection), Object.getOwnPropertyDescriptors(connection)));
        assert.equal(f.host.connection.browserPeer, operator);
        assert.notEqual(Reflect.get(f.host.connection, Cordis.symbols.original), connection);
      } else if (change === "connection") await f.connectionFiber.dispose();
      else if (change === "service") await f.rpcFiber.dispose();
      else if (change === "host") await f.host.fiber.dispose();
      else await f.settingsFiber.dispose();
    };
    f.store.save = async (request, authority) => {
      try {
        if (phase === "before-lock") { entered.release(); await release.promise; }
        return await save(request, authority);
      } finally { backendSettled.release(); }
    };
    if (phase === "after-lock") {
      // Pause inside the real store lock without replacing any native
      // authority, lock acquisition, commit or Gateway permission decision.
      type LockedOperation = (assertLock: () => void) => unknown;
      const locked = Reflect.get(f.store, "locked").bind(f.store) as (operation: LockedOperation) => Promise<unknown>;
      Reflect.set(f.store, "locked", (operation: LockedOperation) => locked(async assertLock => {
        assertLock(); await readFile(join(f.store.profileDir, ".lock")); entered.release(); await release.promise;
        return operation(assertLock);
      }));
    }
    try {
      const pending = f.gateway.invoke({ namespace: "dsmmProfiles", method: "save", peer: operator, signal: abort.signal, args: { request: { id: "blocked", content: '{"version":1,"id":"blocked","settings":{}}', expectedRevision: null } } });
      const rejected = assert.rejects(pending, error => change === "request" ? remoteErrorOf(error)?.code === "gateway/cancelled" : refused(change === "host" ? "disposed" : ["peer", "connection", "service"].includes(change) ? "cancelled" : "not-owned")(error));
      await entered.promise; await revoke(); release.release(); await rejected; await backendSettled.promise;
      assert.deepEqual((await f.store.describe()).profiles, []);
      await assert.rejects(readFile(join(f.store.profileDir, "blocked.jsonc")), { code: "ENOENT" });
      await assert.rejects(readFile(join(f.store.profileDir, ".lock")), { code: "ENOENT" });
    } finally {
      release.release(); Reflect.set(connection, "browserPeer", operator);
      if (change === "owner") ownerContext.set("connection", connection);
      await f.dispose();
    }
  });
});

test("Gateway default selection requires the current writable operator for selecting and clearing", async () => {
  const f = await fixture();
  try {
    const { a } = await savedPair(f);
    const before = await f.runtime.describe();
    const request = { id: "a", expectedRevision: a.revision, expectedSelectionRevision: before.selectionRevision };
    const invoke = (peer = f.peer) => f.gateway.invoke({ namespace: "dsmmProfiles", method: "select", args: { request }, peer });
    const other = f.host.connection.createPeer({ principal: { kind: "owner" } });
    await assert.rejects(invoke(other), refused("not-owned"));
    await assert.rejects(invoke({ ...f.peer, ctx: f.host, async dispose() {} }), refused("not-owned"));
    const settings = Reflect.get(f.host.settings, Cordis.symbols.original) ?? f.host.settings;
    Object.defineProperty(settings, "writable", { configurable: true, value: false });
    await assert.rejects(invoke(), refused("not-owned"));
    assert.equal((await f.store.loadSelection()).selectionRevision, before.selectionRevision);
    Object.defineProperty(settings, "writable", { configurable: true, value: true });
    const selected = await f.remote.dsmmProfiles.select(request); assert.ok(selected.ok);
    assert.equal((await f.store.loadSelection()).selectedId, "a");
    const clear = { id: null, expectedSelectionRevision: selected.value.selectionRevision };
    await assert.rejects(f.gateway.invoke({ namespace: "dsmmProfiles", method: "select", args: { request: clear }, peer: other }), refused("not-owned"));
    const cleared = await f.remote.dsmmProfiles.select(clear); assert.ok(cleared.ok);
    assert.equal((await f.store.loadSelection()).selectedId, null);
  } finally { await f.dispose(); }
});

test("Gateway default selection fences cancellation and operator retirement while awaiting its lock", { timeout: 20000 }, async t => {
  for (const phase of ["before-lock", "after-lock"] as const) for (const change of ["request", "owner", "service", "settings"] as const) await t.test(`${phase}/${change}`, async () => {
    const f = await fixture(), entered = gate(), release = gate(), settled = gate();
    const connection = Reflect.get(f.host.connection, Cordis.symbols.original) ?? f.host.connection;
    const ownerContext = Reflect.get(connection, "ctx") as Context;
    const abort = new AbortController(), before = await f.store.loadSelection();
    const select = f.store.select.bind(f.store);
    Reflect.set(f.store, "select", async (...args: Parameters<ProfileStore["select"]>) => {
      try {
        if (phase === "before-lock") { entered.release(); await release.promise; }
        return await select(...args);
      } finally { settled.release(); }
    });
    if (phase === "after-lock") {
      type LockedOperation = (assertLock: () => void) => unknown;
      const locked = Reflect.get(f.store, "locked").bind(f.store) as (operation: LockedOperation) => Promise<unknown>;
      Reflect.set(f.store, "locked", (operation: LockedOperation) => locked(async assertLock => {
        assertLock(); await readFile(join(f.store.profileDir, ".lock")); entered.release(); await release.promise;
        return operation(assertLock);
      }));
    }
    try {
      const pending = f.gateway.invoke({ namespace: "dsmmProfiles", method: "select", peer: f.peer, signal: abort.signal,
        args: { request: { id: null, expectedSelectionRevision: before.selectionRevision } } });
      const rejected = assert.rejects(pending, error => change === "request" ? remoteErrorOf(error)?.code === "gateway/cancelled" : refused(change === "service" ? "cancelled" : "not-owned")(error));
      await entered.promise;
      if (change === "request") abort.abort();
      else if (change === "owner") ownerContext.set("connection", Object.create(Object.getPrototypeOf(connection), Object.getOwnPropertyDescriptors(connection)));
      else if (change === "service") await f.rpcFiber.dispose();
      else await f.settingsFiber.dispose();
      release.release(); await rejected; await settled.promise;
      assert.deepEqual(await f.store.loadSelection(), before);
      await assert.rejects(readFile(join(f.store.profileDir, ".lock")), { code: "ENOENT" });
    } finally {
      release.release();
      if (change === "owner") ownerContext.set("connection", connection);
      await f.dispose();
    }
  });
});

test("Gateway default selection reports a committed pointer after observation failure and RPC disposal", async () => {
  const f = await fixture({ observe() { throw new Error("final stat unavailable"); } });
  const committed = gate(), release = gate();
  try {
    const before = await f.runtime.describe(), select = f.runtime.select.bind(f.runtime);
    f.runtime.select = async (request, authority) => { const result = await select(request, authority); committed.release(); await release.promise; return result; };
    const pending = f.remote.dsmmProfiles.select({ id: null, expectedSelectionRevision: before.selectionRevision });
    await committed.promise;
    const durable = await f.store.loadSelection(); await f.rpcFiber.dispose(); release.release();
    const result = await pending; assert.ok(result.ok);
    assert.equal(result.value.refreshRequired, true); assert.equal(result.value.selectionRevision, "unavailable");
    assert.notEqual(durable.selectionRevision, before.selectionRevision);
    assert.notEqual(durable.selectionRevision, "unavailable");
    assert.equal(result.value.selectedId, durable.selectedId);
  } finally { release.release(); await f.dispose(); }
});

test("Gateway save returns the durable commit when observation fails and RPC is disposed after rename", async () => {
  const f = await fixture({ observe() { throw new Error("final stat unavailable"); } });
  const committed = gate(), release = gate();
  try {
    const save = f.runtime.save.bind(f.runtime);
    f.runtime.save = async (request, authority) => { const result = await save(request, authority); committed.release(); await release.promise; return result; };
    const pending = f.remote.dsmmProfiles.save({ id: "committed", content: '{"version":1,"id":"committed","settings":{}}', expectedRevision: null });
    await committed.promise;
    const durable = await f.store.read("committed"); await f.rpcFiber.dispose(); release.release();
    const result = await pending; assert.ok(result.ok); assert.equal(result.value.refreshRequired, true);
    assert.equal(result.value.content, durable.content); assert.equal(result.value.revision, "unavailable"); assert.notEqual(durable.revision, "unavailable");
    assert.equal(await readFile(join(f.store.profileDir, "committed.jsonc"), "utf8"), result.value.content);
    assert.equal((await f.store.loadSelection()).selectedId, null);
  } finally { release.release(); await f.dispose(); }
});

test("native RemoteResult transport failure and withdrawn assembly retain drafts and no success claim", async () => {
  const f = await fixture();
  try {
    const controller = new ProfilesController(f.remote.dsmmProfiles);
    await controller.refresh(); await controller.actions.create();
    const draft = controller.store.getSnapshot().editor!.content;
    f.offline(true); await controller.save();
    assert.equal(controller.store.getSnapshot().issue?.kind, "transport"); assert.equal(JSON.stringify(controller.store.getSnapshot()).includes("PRIVATE_TRANSPORT_SENTINEL"), false);
    assert.equal(controller.store.getSnapshot().editor?.content, draft); assert.equal(controller.store.getSnapshot().notice, null);
    f.offline(false); await f.unmount(); await controller.save();
    assert.equal(controller.store.getSnapshot().issue?.kind, "assembly"); assert.equal(controller.store.getSnapshot().dirty, true); assert.equal(controller.store.getSnapshot().editor?.content, draft);
    controller.dispose();
  } finally { await f.dispose(); }
});

test("editor switching requires explicit discard and disposal ignores late native response", async () => {
  const f = await fixture();
  try {
    const document = await f.store.save({ id: "saved", content: '{"version":1,"id":"saved","settings":{}}', expectedRevision: null });
    const controller = new ProfilesController(f.remote.dsmmProfiles);
    await controller.refresh(); await controller.actions.create(); const draft = controller.store.getSnapshot().editor!.content;
    await controller.open(document.id); assert.equal(controller.store.getSnapshot().pendingEditor, "saved"); controller.actions.cancelDiscard();
    assert.equal(controller.store.getSnapshot().editor?.content, draft); await controller.open(document.id); await controller.actions.discardAndOpen();
    assert.equal(controller.store.getSnapshot().editor?.revision, document.revision); controller.actions.editContent("invalid JSONC"); await controller.save();
    assert.equal(controller.store.getSnapshot().issue?.code, "validation"); assert.equal(controller.store.getSnapshot().editor?.content, "invalid JSONC");
    const pending = controller.refresh(); controller.dispose(); const before = controller.store.getSnapshot(); await pending; assert.strictEqual(controller.store.getSnapshot(), before);
    await f.rpcFiber.dispose(); await assert.rejects(f.gateway.invoke({ namespace: "dsmmProfiles", method: "describe", args: {}, peer: f.peer }), error => String(remoteErrorOf(error)?.code) === "gateway/definition-unavailable");
  } finally { await f.dispose(); }
});

test("external selection CAS preserves admitted defaults, supports explicit reconciliation and refuses corrupt pointers", async () => {
  const f = await fixture();
  try {
    const { a, b } = await savedPair(f), controller = new ProfilesController(f.remote.dsmmProfiles);
    const external = ProfileStore.fromCentral(f.home, f.profile.dir, f.profile.entry.id);
    await controller.refresh(); await controller.open(a.id); await controller.apply(); const admitted = controller.store.getSnapshot().snapshot;
    const existing = await f.profile.create();
    assert.equal(f.runtime.getSettings(existing as unknown as DshAgent).workflow.reviewCap, 1);
    const describe = f.store.describe.bind(f.store); let change = true;
    f.store.describe = async () => { if (change) { change = false; await external.select({ id: b.id, expectedRevision: b.revision, expectedSelectionRevision: (await external.describe()).selectionRevision }); } return describe(); };
    await controller.apply(); assert.strictEqual(controller.store.getSnapshot().snapshot, admitted); assert.equal(controller.store.getSnapshot().notice, null); assert.equal(controller.store.getSnapshot().issue?.code, "conflict");
    await controller.refresh(); assert.equal(controller.store.getSnapshot().snapshot?.selectedId, a.id); assert.equal(controller.store.getSnapshot().snapshot?.appliedRevision, admitted?.appliedRevision);
    assert.equal(canReconcileSelection(controller.store.getSnapshot().snapshot), true);
    await controller.open(b.id); await controller.apply(); assert.equal(controller.store.getSnapshot().snapshot?.selectedId, b.id); assert.equal(controller.store.getSnapshot().snapshot?.selectionError, undefined);
    const next = await f.profile.create();
    assert.equal(f.runtime.getSettings(next as unknown as DshAgent).workflow.reviewCap, 4);
    assert.equal(f.runtime.getSettings(existing as unknown as DshAgent).workflow.reviewCap, 1);
    await controller.reset(); assert.equal(controller.store.getSnapshot().notice?.key, "reset");
    await controller.open(a.id); await controller.apply();
    await external.select({ id: b.id, expectedRevision: b.revision, expectedSelectionRevision: (await external.describe()).selectionRevision });
    await controller.refresh(); await controller.apply();
    assert.equal(controller.store.getSnapshot().snapshot?.selectionError, undefined);
    assert.equal((await f.store.describe()).selectedId, a.id);
    await controller.reset();
    await external.select({ id: b.id, expectedRevision: b.revision, expectedSelectionRevision: (await external.describe()).selectionRevision });
    await controller.refresh();
    assert.equal(controller.store.getSnapshot().snapshot?.selectedId, null);
    assert.equal(controller.store.getSnapshot().snapshot?.selectionError?.code, "conflict");
    await controller.reset();
    assert.equal((await f.store.describe()).selectedId, null);
    const pointer = join(f.store.stateDir, ".selection.json"); await writeFile(pointer, "corrupt selection"); await controller.refresh();
    assert.equal(controller.store.getSnapshot().snapshot?.selectionRevision, "unavailable"); assert.equal(canReconcileSelection(controller.store.getSnapshot().snapshot), false);
    await controller.apply(); await controller.reset(); assert.equal(await readFile(pointer, "utf8"), "corrupt selection"); assert.equal(controller.store.getSnapshot().notice, null);
    controller.dispose();
  } finally { await f.dispose(); }
});

test("invalid new IDs produce field validation without a native RPC write", async () => {
  const f = await fixture();
  try {
    const controller = new ProfilesController(f.remote.dsmmProfiles); await controller.refresh(); await controller.actions.create(); f.offline(true);
    for (const id of ["Uppercase", "con", "a".repeat(65)]) { controller.actions.editId(id); await controller.save(); assert.equal(controller.store.getSnapshot().issue?.kind, "domain"); assert.equal(controller.store.getSnapshot().issue?.code, "validation"); assert.equal(controller.store.getSnapshot().issue?.field, "id"); assert.equal(controller.store.getSnapshot().editor?.id, id); assert.equal(controller.store.getSnapshot().notice, null); }
    assert.deepEqual((await f.store.describe()).profiles, []); controller.dispose();
  } finally { await f.dispose(); }
});

test("genuine native Remote refuses unpaired UTF16 without changing bytes or admitted selection", async () => {
  const f = await fixture();
  try {
    const { a } = await savedPair(f);
    const selected = await f.remote.dsmmProfiles.select({ id: a.id, expectedRevision: a.revision, expectedSelectionRevision: "absent" }); assert.ok(selected.ok);
    const bytes = await readFile(join(f.store.profileDir, "a.jsonc")), pointer = await readFile(join(f.store.stateDir, ".selection.json"));
    for (const content of [`{"version":1,"id":"a","label":"\uD800","settings":{}}`, a.content + `\n// \uD800\n`]) {
      const result = await f.remote.dsmmProfiles.save({ id: a.id, content, expectedRevision: a.revision });
      if (result.ok || result.error.code !== "dsmm-profiles/refused") assert.fail("structured validation refusal required");
      assert.equal(result.error.details.code, "validation"); assert.equal(result.error.details.field, "content");
      assert.deepEqual(await readFile(join(f.store.profileDir, "a.jsonc")), bytes); assert.deepEqual(await readFile(join(f.store.stateDir, ".selection.json")), pointer);
      assert.equal((await f.runtime.describe()).appliedRevision, selected.value.appliedRevision);
    }
  } finally { await f.dispose(); }
});

test("genuine native codecs retain warnings and exact safe diagnostics", async () => {
  const f = await fixture();
  try {
    const raw = '\uFEFF{ // retained\n"version":1,"id":"blank","label":"  ","settings":{"locale":"zh-Hant"},}\n';
    const save = await f.remote.dsmmProfiles.save({ id: "blank", content: raw, expectedRevision: null }); assert.ok(save.ok); assert.equal(save.value.content, raw); assert.equal(save.value.warnings?.[0]?.code, "blank-label");
    const read = await f.remote.dsmmProfiles.read("blank"); assert.ok(read.ok); assert.deepEqual(read.value.warnings, save.value.warnings);
    const selected = await f.remote.dsmmProfiles.select({ id: "blank", expectedRevision: save.value.revision, expectedSelectionRevision: "absent" }); assert.ok(selected.ok); assert.equal(selected.value.selectedWarnings?.[0]?.code, "blank-label"); assert.equal(selected.value.profiles[0]?.error, undefined);
    const refreshed = await f.remote.dsmmProfiles.describe(); assert.ok(refreshed.ok); assert.deepEqual(refreshed.value.selectedWarnings, selected.value.selectedWarnings);
    for (const settings of [{ deepseekFlashMaxReasoningPresets: [] }, { guards: { "private/key=SECRET": "SECRET_VALUE" } }]) {
      const result = await f.remote.dsmmProfiles.save({ id: "blank", content: JSON.stringify({ version: 1, id: "blank", settings }), expectedRevision: save.value.revision });
      if (result.ok || result.error.code !== "dsmm-profiles/refused") assert.fail("structured refusal required");
      assert.ok(result.error.details.location); assert.ok(result.error.details.reason); assert.equal(JSON.stringify(result.error.details).includes("SECRET"), false); assert.equal((await f.runtime.read("blank")).revision, save.value.revision);
    }
  } finally { await f.dispose(); }
});
