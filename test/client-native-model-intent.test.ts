import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Context, Service } from "@deepseek-ai/cordis";
import type { HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { ModelDirectoryState } from "@deepseek-ai/dsh-client-ui-model-selection/client";
import type { ModelSelection, SessionSelectModelRequest, SessionSelectModelValue } from "@deepseek-ai/dsh-api-session-controller";
import type { SessionEventSource, SessionEventLikeEntry } from "@deepseek-ai/dsh-api-session-controller/client";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import { ProfilesController } from "../lib/client/controller.js";
import type { DsmmProfilesRemote } from "../lib/profile-remote.js";
import type { SessionProfileSnapshot } from "../lib/profile-types.js";
import { nativeRoutingFixture } from "./native-routing-fixture.ts";

const require = createRequire(import.meta.url);
const revision = "a".repeat(64);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function success<T>(value: T): RemoteResult<T> { return { ok: true, value }; }
async function installed(packageName: string, relative: string): Promise<unknown> {
  // Exact shipped native implementations are test-only dependency seams;
  // production consumes only declared public services and observable faces.
  return import(pathToFileURL(join(dirname(require.resolve(`${packageName}/package.json`)), "lib", "types", relative)).href);
}
type Feed = SessionEventSource & { append(entry: SessionEventLikeEntry): void };
type NativeDirectory = { store: HostObservable<ModelDirectoryState>; select(selection: ModelSelection): Promise<RemoteResult<void>>; dispose(): void };
type NativeModels = { ModelDirectory: new (...args: unknown[]) => NativeDirectory; ModelDirectoryResolver: new (ctx: Context) => { directoryFor(id: string): NativeDirectory } };
async function nativeModelsModule(): Promise<NativeModels> {
  const store = await import("@deepseek-ai/dsh-client-store");
  let factory: ((resolve: (id: string) => unknown) => NativeModels) | undefined;
  const realm = createContext({ console, queueMicrotask, setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load(row: { factory: typeof factory }) { factory = row.factory; } } },
  });
  const root = dirname(require.resolve("@deepseek-ai/dsh-client-ui-model-selection/package.json"));
  runInContext(await readFile(join(root, "lib", "client.js"), "utf8"), realm);
  assert.ok(factory);
  const neverRender = () => { throw new Error("This native controller test must not pretend to render browser primitives"); };
  return factory((id) => {
    if (id === "@deepseek-ai/dsh-client-store") return store;
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return { Button: neverRender, Input: neverRender };
    if (id === "react-dom") return { createPortal: neverRender };
    return require(id);
  });
}

async function nativeIntentFixture() {
  const f = await nativeRoutingFixture();
  const reducer = await installed("@deepseek-ai/dsh-api-session-controller", "model-selection-projection.js") as { installModelSelectionProjection(ctx: Context): void };
  const events = await installed("@deepseek-ai/dsh-api-session-controller", "client/contract/events.js") as { MutableSessionEventSource: new () => Feed };
  const { ModelDirectory } = await nativeModelsModule();
  reducer.installModelSelectionProjection(f.ctx);
  const root = await f.create();
  const feed = new events.MutableSessionEventSource();
  f.ctx.on("session/event", (session, event) => { if (session === root.session) feed.append({ type: "event", event }); });
  let frames = 0, projected: unknown;
  const projectionListeners = new Set<() => void>();
  f.ctx.sessionProjections.onChanged((session, key, value) => {
    if (session !== root.session || key !== "modelSelection") return;
    frames++; projected = value; for (const listener of projectionListeners) listener();
  });
  const intent = { provider: "fixture", model: "same-native-pending", reasoningEffort: "high" };
  root.session.append("model/selection", { ...intent });
  const projection = { getSnapshot: () => projected, subscribe: (listener: () => void) => { projectionListeners.add(listener); return () => { projectionListeners.delete(listener); }; } };
  const nativeAck = deferred<RemoteResult<SessionSelectModelValue>>();
  const catalog = { store: { getSnapshot: () => ({ status: "ready", error: null, value: { default: intent, groups: [], failures: [], routableProviders: ["fixture"] } }), subscribe: () => () => {} }, reasoningFor: () => undefined };
  // The actual directory and actual SnapshotStore publish selecting before
  // this held RPC acknowledgment. No store.write/set or synthetic invalidate.
  const directory = new ModelDirectory({ selectModel: () => nativeAck.promise }, root.id, () => true, catalog, projection, () => true);
  const profileAck = deferred<RemoteResult<SessionProfileSnapshot>>();
  const initial: SessionProfileSnapshot = { sessionId: root.id, globalDefault: { selectedId: null, appliedRevision: null, selectionRevision: "absent" }, selection: { selectedId: null, appliedRevision: null, selectionRevision: "absent" }, scope: "global-default", admissionEpoch: "old-epoch", switchAllowed: true, canSelectModel: true, canToggleMode: true, canApplyOverlay: true };
  const remote: DsmmProfilesRemote = {
    describe: async () => success({ profiles: [{ id: "p", revision }], ...initial.globalDefault }),
    describeSession: async () => success(initial), selectSession: () => profileAck.promise,
    read: async () => { throw new Error("Not part of this intent reproduction"); }, save: async () => { throw new Error("Not part of this intent reproduction"); }, select: async () => { throw new Error("Global profile selection must not run"); },
  };
  const controller = new ProfilesController(remote);
  await controller.refresh(); controller.setSession(root.id); await controller.actions.refreshSession();
  // setSession starts describe asynchronously; settle through its public store.
  for (let turn = 0; turn < 20 && controller.store.getSnapshot().sessionBusy !== null; turn++) await new Promise<void>((done) => queueMicrotask(done));
  assert.equal(controller.store.getSnapshot().sessionBusy, null, "native fixture session description must settle");
  controller.attachModelSelectionSource(root.id, projection);
  const eventAware = controller as ProfilesController & { attachModelEventSource?: (id: string, source: SessionEventSource) => void; attachModelInteractionSource?: (id: string, source: HostObservable<ModelDirectoryState>) => void };
  eventAware.attachModelEventSource?.(root.id, feed);
  eventAware.attachModelInteractionSource?.(root.id, directory.store);
  let optionalDispatches = 0;
  controller.attachModelSelector({ selectModel: async (request: SessionSelectModelRequest) => { optionalDispatches++; return success({ selected: request }); } });
  controller.actions.chooseSessionProfile("p");
  return { f, root, controller, directory, nativeAck, intent, frames: () => frames, calls: () => optionalDispatches,
    releaseProfile() { profileAck.resolve(success({ ...initial, scope: "session-override", admissionEpoch: "new-epoch", selection: { selectedId: "p", appliedRevision: revision, selectionRevision: revision }, profileModel: { provider: "fixture", model: "profile-main" } })); },
    async dispose() { controller.dispose(); directory.dispose(); await f.dispose(); },
  };
}

test("actual native same-pending model/selection advances seq without a projection frame and forbids optional model dispatch", async () => {
  const n = await nativeIntentFixture();
  try {
    assert.equal(n.frames(), 1);
    const apply = n.controller.actions.applySession({ useProfileModel: true });
    const seq = n.root.session.seq;
    n.root.session.append("model/selection", { ...n.intent });
    assert.ok(n.root.session.seq > seq); assert.equal(n.frames(), 1, "native reducer really suppresses identical pending projection publication");
    n.releaseProfile(); await apply;
    assert.equal(n.calls(), 0, "the real model/selection event watermark must fence the suppressed projection");
    assert.equal(n.controller.store.getSnapshot().session!.selection.selectedId, "p");
    assert.equal(n.controller.store.getSnapshot().sessionIssue!.code, "model-choice-changed");
  } finally { await n.dispose(); }
});

test("production optional observer dependency roster resolves the actual native directory in its caller scope", async () => {
  const client = new Context();
  const { ModelDirectoryResolver } = await nativeModelsModule();
  const events = await installed("@deepseek-ai/dsh-api-session-controller", "client/contract/events.js") as { MutableSessionEventSource: new () => Feed };
  const projection = { getSnapshot: () => ({ lastUsed: null, next: null }), subscribe: () => () => {} };
  const id = "session-owned-native-observer-gate";
  // Minimal test-owned retained-binding and wire faces. The actual native
  // resolver, directory, SnapshotStore and Cordis scoped DI run unchanged.
  const binding = { sessionId: id, eventSource: new events.MutableSessionEventSource(), ctx: client,
    session: { projections: { faceOf: () => projection }, getSnapshot: () => ({ blank: true }) } };
  class FixtureRemote extends Service { constructor(ctx: Context) { super(ctx, "remote"); } $on() { return () => {}; } }
  try {
    client.provide("sessions", { scope: () => client, binding: () => binding, subagentAddress: () => undefined });
    new FixtureRemote(client);
    client.provide("remote.session", { modelCatalog: async () => success({ default: { provider: "fixture", model: "default" }, groups: [], failures: [], routableProviders: ["fixture"] }) });
    await client.plugin(ModelDirectoryResolver).await();
    const bundle = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
    const gate = bundle.match(/sessionCtx\.inject\((\[[^\]]+\]), \(modelCtx\)/u);
    assert.ok(gate, "test must exercise the production optional observer's exact dependency roster");
    const dependencies = JSON.parse(gate[1]) as string[];
    assert.ok(dependencies.includes("remote.session"), "the optional native interaction observer explicitly owns its session namespace dependency");
    await client.inject(["sessions", "remote"], async (parent) => {
      await parent.inject(dependencies, (scope) => {
        assert.doesNotThrow(() => scope.modelDirectories.directoryFor(id as SessionSelectModelRequest["sessionId"]), "production observer must resolve the native directory on its first, pre-picker binding");
      });
    });
  } finally { await client.fiber.dispose(); }
});

test("actual native directory selecting publication before model RPC acknowledgment fences the optional stage", async () => {
  const n = await nativeIntentFixture();
  try {
    const apply = n.controller.actions.applySession({ useProfileModel: true });
    const native = n.directory.select({ ...n.intent });
    assert.equal(n.directory.store.getSnapshot().status, "selecting");
    assert.equal(n.frames(), 1, "no durable model acknowledgment or changed projection is needed for the UI intent fence");
    n.releaseProfile(); await apply;
    assert.equal(n.calls(), 0); assert.equal(n.controller.store.getSnapshot().sessionIssue!.code, "model-choice-changed");
    n.nativeAck.resolve(success({ selected: n.intent })); await native;
    assert.equal(n.directory.store.getSnapshot().status, "ready");
  } finally { await n.dispose(); }
});

test("native selection pending before profile CAS still fences the optional stage after its acknowledgment settles", async () => {
  const n = await nativeIntentFixture();
  try {
    const native = n.directory.select({ ...n.intent });
    assert.equal(n.directory.store.getSnapshot().status, "selecting");
    const apply = n.controller.actions.applySession({ useProfileModel: true });
    n.nativeAck.resolve(success({ selected: n.intent })); await native;
    assert.equal(n.directory.store.getSnapshot().status, "ready");
    assert.equal(n.frames(), 1, "the already-pending intent must not need a changed projection to remain fenced");
    n.releaseProfile(); await apply;
    assert.equal(n.calls(), 0); assert.equal(n.controller.store.getSnapshot().sessionIssue!.code, "model-choice-changed");
    assert.equal(n.controller.store.getSnapshot().session!.selection.selectedId, "p");
  } finally { await n.dispose(); }
});
