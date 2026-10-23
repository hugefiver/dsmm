import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { build } from "esbuild";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { SnapshotStore } from "@deepseek-ai/dsh-client-store";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { ComposerBlock, ComposerBlocks } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ConnectionGeneration } from "@deepseek-ai/dsh-client-connection/client";
import type { DsmmProfilesRemote } from "../src/profile-remote.js";
import type { ProfileSnapshot, SessionProfileSnapshot, SessionProfileSelectRequest } from "../src/profile-types.js";
import type { ProfilesController as Controller } from "../src/client/controller.js";
import type { ProfileBlankNative, ProfileBlankServices, ProfileWorkspace, profileBlankNative as nativeAdapter } from "../src/client/profile-blank.js";
import type { SessionSnapshot } from "@deepseek-ai/dsh-api-session-controller/client";

// Compile the current sources in memory; no checked-in lib output is exercised.
const compiled = await build({ absWorkingDir: fileURLToPath(new URL("..", import.meta.url)), stdin: { resolveDir: fileURLToPath(new URL("..", import.meta.url)), contents: 'export {ProfilesController} from "./src/client/controller.ts"; export {profileBlankNative} from "./src/client/profile-blank.ts";' },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives", "jsonc-parser"] });
const module = { exports: {} as { ProfilesController: typeof Controller; profileBlankNative: typeof nativeAdapter } };
runInThisContext(`(function(require,module,exports){${compiled.outputFiles[0].text}\n})`)(createRequire(import.meta.url), module, module.exports);
const { ProfilesController, profileBlankNative } = module.exports;
const revision = "a".repeat(64), selectionRevision = "b".repeat(64);
function success<T>(value: T): RemoteResult<T> { return { ok: true, value }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function baseline(id: string): SessionProfileSnapshot {
  return { sessionId: id, admissionEpoch: "epoch-1", globalDefault: { selectedId: null, appliedRevision: null, selectionRevision: "absent" },
    selection: { selectedId: null, appliedRevision: null, selectionRevision: "absent" }, scope: "global-default", switchAllowed: true, canApplyOverlay: true, canSelectModel: false, canToggleMode: false };
}
function selected(id: string, profile: string | null = "p"): SessionProfileSnapshot {
  const selection = { selectedId: profile, appliedRevision: profile === null ? null : revision, selectionRevision };
  return { ...baseline(id), selection, admittedSelection: selection, admissionEpoch: "epoch-2", scope: profile === null ? "deployment-baseline" : "session-override" };
}
function composerBlocks(): ComposerBlocks {
  const stores = new Map<SessionId, SnapshotStore<ComposerBlock | undefined>>();
  const storeFor = (id: SessionId) => { let store = stores.get(id); if (store === undefined) { store = createSnapshotStore<ComposerBlock | undefined>(undefined); stores.set(id, store); } return store; };
  return { storeFor, set: (id, block) => storeFor(id).set(block), forget: id => { stores.delete(id); } };
}
async function fixture(overrides: Partial<DsmmProfilesRemote> = {}, nativeOverrides: Partial<ProfileBlankNative> = {}) {
  const id = SessionId("actual-host-blank"), calls: string[] = [], selections: SessionProfileSelectRequest[] = [], blocks = composerBlocks();
  let actual = baseline(id), releases = 0, opened = 0;
  const workspaces = createSnapshotStore<readonly ProfileWorkspace[]>([{ id: "first", label: "First" }, { id: "chosen", label: "Chosen" }]);
  const navigation = new AbortController();
  const remote: DsmmProfilesRemote = {
    describe: async () => success({ profiles: [{ id: "p", revision }, { id: "q", revision }], selectedId: "q", appliedRevision: revision, selectionRevision }),
    read: async () => { throw new Error("No editor read"); }, save: async () => { throw new Error("No editor write"); }, select: async () => { throw new Error("No future default write"); },
    describeSession: async target => { calls.push(`describe:${target}`); assert.ok(blocks.storeFor(id).getSnapshot(), "target blocked before async describe"); return success(actual); },
    selectSession: async (target, request) => { calls.push(`select:${target}`); assert.ok(blocks.storeFor(id).getSnapshot()); assert.equal(controller.store.getSnapshot().currentSessionId, null); selections.push(request); actual = selected(id, request.id); return success(actual); },
    ...overrides,
  };
  const controller = new ProfilesController(remote);
  const native: ProfileBlankNative = {
    workspaces, beginNavigation: () => navigation.signal,
    connectWorkspace: async workspace => { calls.push(`connect:${workspace}`); assert.equal(controller.store.getSnapshot().currentSessionId, null); return id; },
    retain: target => { calls.push(`retain:${target}`); return { sessionId: target, ready: Promise.resolve({ sessionId: target }), release: () => { releases++; } }; },
    openSession: target => { opened++; calls.push(`open:${target}`); assert.ok(blocks.storeFor(target).getSnapshot(), "no send before native binding takeover"); controller.setSession(target); },
    ...nativeOverrides,
  };
  controller.attachComposerBlocks(blocks, () => "selection pending"); controller.attachBlankNative(native); await controller.refresh();
  return { controller, native, blocks, id, calls, selections, navigation, workspaces, setActual: (value: SessionProfileSnapshot) => { actual = value; }, get releases() { return releases; }, get opened() { return opened; } };
}
async function settle(controller: Controller) { for (let i = 0; i < 100 && controller.store.getSnapshot().sessionBusy !== null; i++) await setImmediate(); assert.equal(controller.store.getSnapshot().sessionBusy, null); }
function sessionSource(id: SessionId, running: boolean) {
  return createSnapshotStore<SessionSnapshot>({ sessionId: id, running, pendingSubmissions: [], subagent: null, removed: false, openState: "open",
    openError: null, hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null, promptAttempted: true, awaitingFirstTurn: false });
}

test("browsing and workspace choice do not create; explicit profile choice uses the chosen workspace and target CAS", async () => {
  const f = await fixture();
  try {
    assert.equal(f.controller.store.getSnapshot().sessionWorkspaceId, null);
    assert.equal(f.calls.length, 0);
    f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
    assert.equal(f.controller.store.getSnapshot().sessionPreparationPending, true); assert.equal(f.calls.length, 0);
    await f.controller.actions.chooseSessionWorkspace("chosen"); await settle(f.controller);
    assert.equal(f.calls.filter(call => call.startsWith("connect:")).join(), "connect:chosen");
    assert.equal(f.opened, 1); assert.equal(f.releases, 1);
    assert.deepEqual(f.selections, [{ sessionId: f.id, id: "p", expectedRevision: revision, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "epoch-1" }]);
    assert.equal(f.controller.store.getSnapshot().session?.admittedSelection?.selectedId, "p");
    assert.equal(f.blocks.storeFor(f.id).getSnapshot(), undefined);
  } finally { f.controller.dispose(); }
});

test("slow connect is single flight and a later navigation never retains, selects or opens the late blank", async () => {
  const pending = deferred<SessionId>(); let connections = 0;
  const f = await fixture({}, { connectWorkspace: async () => { connections++; return pending.promise; } });
  try {
    await f.controller.actions.chooseSessionWorkspace("chosen"); f.controller.actions.chooseSessionProfile("p");
    const applying = f.controller.actions.applySession(); await f.controller.actions.applySession();
    assert.equal(connections, 1); f.navigation.abort();
    pending.resolve(f.id); await applying;
    assert.deepEqual(f.calls, []); assert.equal(f.opened, 0); assert.equal(f.controller.store.getSnapshot().sessionBusy, null);
  } finally { f.controller.dispose(); }
});

test("slow CAS cannot steal navigation; connection replacement, disposal and service withdrawal release only owned resources", async t => {
  for (const change of ["session", "connection", "dispose", "native", "blocks", "workspace"] as const) await t.test(change, async () => {
    const pending = deferred<RemoteResult<SessionProfileSnapshot>>(), started = deferred<void>();
    const f = await fixture({ selectSession: async () => { started.resolve(); return pending.promise; } });
    const generation = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: "isolated" } });
    try {
      f.controller.bindConnection(generation);
      await f.controller.actions.chooseSessionWorkspace("chosen"); f.controller.actions.chooseSessionProfile("p");
      const applying = f.controller.actions.applySession(); await started.promise;
      if (change === "session") f.controller.setSession("other-native-session");
      if (change === "connection") generation.set(undefined);
      if (change === "dispose") f.controller.dispose();
      if (change === "native") f.controller.attachBlankNative(null);
      if (change === "blocks") f.controller.attachComposerBlocks(null);
      if (change === "workspace") await f.controller.actions.chooseSessionWorkspace("first");
      pending.resolve(success(selected(f.id))); await applying;
      assert.equal(f.opened, 0); assert.equal(f.releases, 1); assert.equal(f.blocks.storeFor(f.id).getSnapshot(), undefined);
    } finally { f.controller.dispose(); }
  });
});

test("unknown or refresh-required commit is reconciled by describe, without replaying create or select", async t => {
  for (const response of ["transport", "refresh-required", "wrong-profile", "wrong-target", "missing-admission"] as const) await t.test(response, async () => {
    const f = await fixture({ selectSession: async () => response === "transport" ? { ok: false, error: new RemoteError("gateway/cancelled", "lost", {}) }
      : success(response === "refresh-required" ? { ...selected("actual-host-blank"), refreshRequired: true } : response === "missing-admission" ? { ...selected("actual-host-blank"), admittedSelection: undefined }
        : selected(response === "wrong-target" ? "foreign" : "actual-host-blank", response === "wrong-profile" ? "q" : "p")) });
    try {
      await f.controller.actions.chooseSessionWorkspace("chosen"); f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
      assert.equal(f.opened, 0); assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, true); assert.ok(f.blocks.storeFor(f.id).getSnapshot());
      const calls = [...f.calls]; await f.controller.actions.applySession(); assert.deepEqual(f.calls, calls);
      f.setActual(selected(f.id)); await f.controller.actions.refreshSession(); await settle(f.controller);
      assert.equal(f.opened, 1); assert.equal(f.calls.filter(call => call.startsWith("connect:")).length, 1);
      assert.equal(f.releases, 1); assert.equal(f.blocks.storeFor(f.id).getSnapshot(), undefined);
    } finally { f.controller.dispose(); }
  });
});

test("refresh mismatch keeps the same target for an explicit retry and never opens an unconfirmed selection", async () => {
  let writes = 0;
  const f = await fixture({ selectSession: async () => { writes++; return writes === 1 ? { ok: false, error: new RemoteError("gateway/cancelled", "lost", {}) } : success(selected("actual-host-blank")); } });
  try {
    await f.controller.actions.chooseSessionWorkspace("chosen"); f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
    await f.controller.actions.refreshSession(); assert.equal(writes, 1); assert.equal(f.opened, 0); assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, false);
    f.setActual(selected(f.id)); await f.controller.actions.applySession(); await settle(f.controller);
    assert.equal(writes, 2); assert.equal(f.opened, 1); assert.equal(f.calls.filter(call => call.startsWith("connect:")).length, 1);
  } finally { f.controller.dispose(); }
});

test("foreign composer blocks and native busy/maintenance refusals are preserved without cancelling activity", async t => {
  for (const reason of ["foreign", "busy", "maintenance", "new-session-required"] as const) await t.test(reason, async () => {
    const f = await fixture();
    const foreign = { reason: "other owner" };
    try {
      if (reason === "foreign") f.blocks.set(f.id, foreign);
      else f.setActual({ ...baseline(f.id), canApplyOverlay: false, applyOverlayUnavailableReason: reason });
      await f.controller.actions.chooseSessionWorkspace("chosen"); f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
      assert.equal(f.opened, 0); assert.equal(f.selections.length, 0); assert.equal(f.releases, 1);
      assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, false);
      assert.equal(f.blocks.storeFor(f.id).getSnapshot(), reason === "foreign" ? foreign : undefined);
    } finally { f.controller.dispose(); }
  });
});

test("a replaced block/store survives task cleanup and dirty editor state prevents preparation", async () => {
  const pending = deferred<RemoteResult<SessionProfileSnapshot>>(), started = deferred<void>();
  const f = await fixture({ selectSession: async () => { started.resolve(); return pending.promise; } });
  try {
    await f.controller.actions.chooseSessionWorkspace("chosen"); f.controller.actions.chooseSessionProfile("p");
    const applying = f.controller.actions.applySession(); await started.promise;
    const foreign = { reason: "new native generation" }; f.blocks.forget(f.id); f.blocks.set(f.id, foreign);
    f.controller.dispose(); pending.resolve(success(selected(f.id))); await applying;
    assert.equal(f.blocks.storeFor(f.id).getSnapshot(), foreign); assert.equal(f.releases, 1);
  } finally { f.controller.dispose(); }
  const dirty = await fixture();
  try { await dirty.controller.actions.chooseSessionWorkspace("chosen"); await dirty.controller.actions.create(); dirty.controller.actions.chooseSessionProfile("p"); await dirty.controller.actions.applySession(); assert.deepEqual(dirty.calls, []); }
  finally { dirty.controller.dispose(); }
});

test("a definite CAS refusal releases this entrance without opening or cancelling the native session", async () => {
  const f = await fixture({ selectSession: async () => ({ ok: false, error: new RemoteError("dsmm-profiles/refused", "busy", { code: "busy", message: "busy" }) }) });
  try {
    await f.controller.actions.chooseSessionWorkspace("chosen"); f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
    assert.equal(f.opened, 0); assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, false);
    assert.equal(f.controller.store.getSnapshot().sessionIssue?.code, "busy"); assert.equal(f.releases, 1); assert.equal(f.blocks.storeFor(f.id).getSnapshot(), undefined);
  } finally { f.controller.dispose(); }
});

test("native navigation to an unknown target keeps the send block until a successful current-session reread", async () => {
  const reading = deferred<RemoteResult<SessionProfileSnapshot>>(); let describes = 0;
  const f = await fixture({ describeSession: async id => { describes++; return describes === 1 ? success(baseline(id)) : reading.promise; },
    selectSession: async () => ({ ok: false, error: new RemoteError("gateway/cancelled", "lost", {}) }) });
  try {
    await f.controller.actions.chooseSessionWorkspace("chosen"); f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
    f.controller.setSession(f.id);
    assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, true); assert.ok(f.blocks.storeFor(f.id).getSnapshot()); assert.equal(f.releases, 1);
    reading.resolve(success(selected(f.id))); await settle(f.controller);
    assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, false); assert.equal(f.blocks.storeFor(f.id).getSnapshot(), undefined); assert.equal(f.opened, 0);
  } finally { f.controller.dispose(); }
});

test("a connect failure with no returned identity is never blindly replayed by refresh", async () => {
  let connections = 0;
  const f = await fixture({}, { connectWorkspace: async () => { connections++; throw new Error("Reply lost before identity"); } });
  try {
    await f.controller.actions.chooseSessionWorkspace("chosen"); f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
    assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, true);
    await f.controller.actions.refreshSession(); await f.controller.actions.applySession();
    assert.equal(connections, 1); assert.equal(f.opened, 0); assert.equal(f.releases, 0);
  } finally { f.controller.dispose(); }
});

test("an incomplete native open leaves the prepared target refreshable without replaying selection or replacing navigation", async t => {
  for (const outcome of ["pending", "throw"] as const) await t.test(outcome, async () => {
    const f = await fixture(); let attempts = 0, navigations = 0;
    f.native.beginNavigation = () => { navigations++; return f.navigation.signal; };
    f.native.openSession = () => { attempts++; f.navigation.abort(); if (outcome === "throw") throw new Error("Native open failed before binding takeover"); };
    try {
      await f.controller.actions.chooseSessionWorkspace("chosen"); f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
      assert.equal(f.controller.store.getSnapshot().sessionBusy, null, "settled Profile selection must not leave the native handoff apply-locked");
      assert.equal(f.controller.store.getSnapshot().currentSessionId, null); assert.equal(f.releases, 0);
      const held = f.blocks.storeFor(f.id).getSnapshot(); assert.ok(held);
      await f.controller.actions.applySession(); assert.equal(attempts, 1); assert.equal(f.selections.length, 1);
      await f.controller.actions.refreshSession();
      assert.equal(f.controller.store.getSnapshot().sessionBusy, null); assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, false);
      assert.equal(attempts, 1, "refresh must not revive the superseded navigation intent");
      assert.equal(f.blocks.storeFor(f.id).getSnapshot(), held); assert.equal(f.selections.length, 1); assert.equal(navigations, 1);
      f.native.openSession = target => { attempts++; assert.equal(f.blocks.storeFor(target).getSnapshot(), held); f.controller.setSession(target); };
      await f.controller.actions.applySession(); await settle(f.controller);
      assert.equal(attempts, 2); assert.equal(f.selections.length, 1); assert.equal(f.calls.filter(call => call.startsWith("connect:")).length, 1);
      assert.equal(navigations, 1, "retrying the known target must not begin or cancel another navigation");
      assert.equal(f.controller.store.getSnapshot().currentSessionId, f.id); assert.equal(f.releases, 1); assert.equal(f.blocks.storeFor(f.id).getSnapshot(), undefined);
    } finally { f.controller.dispose(); }
  });
});

test("an asynchronous native handoff retains the exact block until the target current binding confirms its profile", async () => {
  const reading = deferred<RemoteResult<SessionProfileSnapshot>>(); let describes = 0;
  const f = await fixture({ describeSession: async target => ++describes === 1 ? success(baseline(target)) : reading.promise });
  let stop = () => {};
  f.native.openSession = () => { f.navigation.abort(); };
  try {
    await f.controller.actions.chooseSessionWorkspace("chosen"); f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
    const held = f.blocks.storeFor(f.id).getSnapshot(); assert.ok(held); assert.equal(f.releases, 0);
    const observed: (ComposerBlock | undefined)[] = [], store = f.blocks.storeFor(f.id);
    stop = store.subscribe(() => { observed.push(store.getSnapshot()); });
    assert.equal(f.controller.store.getSnapshot().sessionBusy, null);
    await setImmediate(); f.controller.setSession(f.id);
    assert.equal(f.releases, 1); assert.equal(f.blocks.storeFor(f.id).getSnapshot(), held, "native binding takeover transfers, rather than momentarily clears, the block");
    assert.ok(observed.every(block => block === held), "no sendable gap may appear before the current binding confirms the Profile");
    reading.resolve(success(selected(f.id))); await settle(f.controller);
    assert.equal(f.blocks.storeFor(f.id).getSnapshot(), undefined); assert.equal(f.selections.length, 1);
  } finally { stop(); f.controller.dispose(); }
});

test("a handoff recovery read cannot reopen its target after another native session takes over", async () => {
  const reading = deferred<RemoteResult<SessionProfileSnapshot>>(), started = deferred<void>(); let describes = 0, attempts = 0;
  const f = await fixture({ describeSession: async target => { if (++describes === 1) return success(baseline(target)); started.resolve(); return reading.promise; } });
  f.native.openSession = () => { attempts++; f.navigation.abort(); };
  try {
    await f.controller.actions.chooseSessionWorkspace("chosen"); f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
    const refreshing = f.controller.actions.refreshSession(); await started.promise;
    f.controller.setSession("another-native-session");
    reading.resolve(success(selected(f.id))); await refreshing; await settle(f.controller);
    assert.equal(attempts, 1); assert.equal(f.controller.store.getSnapshot().currentSessionId, "another-native-session");
    assert.equal(f.selections.length, 1); assert.equal(f.releases, 1); assert.equal(f.blocks.storeFor(f.id).getSnapshot(), undefined);
  } finally { f.controller.dispose(); }
});

test("native adapter passes only the explicitly chosen real workspace, never a Profile preset or draft initializer", async () => {
  type WorkspaceId = NonNullable<NonNullable<Parameters<ProfileBlankServices["uiWorkspace"]["connectWorkspace"]>[0]>>;
  const workspaceId = "explicit-workspace" as WorkspaceId, id = SessionId("native-returned-id"), calls: unknown[][] = [];
  const list = createSnapshotStore({ phase: "ready", items: [{ workspaceId, title: "Explicit", path: "/native/workspace" }] });
  const services: ProfileBlankServices = {
    workspaces: { list }, layout: { beginNavigation: () => new AbortController().signal },
    uiWorkspace: { connectWorkspace: async (...args) => { calls.push(args); return id; }, openSession: (...args) => { calls.push(args); } },
    sessions: { retain: () => { throw new Error("Not retained by browsing"); } },
  };
  const native = profileBlankNative(services);
  assert.deepEqual(native.workspaces.getSnapshot(), [{ id: workspaceId, label: "Explicit" }]); assert.deepEqual(calls, []);
  assert.equal(await native.connectWorkspace(workspaceId), id); assert.deepEqual(calls, [[workspaceId]]);
  await assert.rejects(native.connectWorkspace("unknown")); assert.equal(calls.length, 1);
});

test("running transitions during describe coalesce a follow-up without clearing dirty editor or native state", async () => {
  const reading = deferred<RemoteResult<SessionProfileSnapshot>>(); let reads = 0, writes = 0;
  const f = await fixture({ describeSession: async id => ++reads === 1 ? reading.promise : success(baseline(id)), selectSession: async id => { writes++; return success(selected(id)); } });
  const source = sessionSource(f.id, true), blocks = f.blocks.storeFor(f.id), foreign = { reason: "native composer owner" };
  try {
    blocks.set(foreign); await f.controller.actions.create();
    f.controller.actions.editContent('{"version":1,"id":"unsaved","settings":{}}');
    f.controller.actions.setNumberDraft("workflow.reviewCap", { draft: "-", invalid: true, sourceValue: 2 });
    f.controller.actions.setFieldInvalid("workflow.reviewCap", true);
    const editor = f.controller.store.getSnapshot().editor, draft = f.controller.actions.getNumberDraft("workflow.reviewCap");
    f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id);
    for (const running of [false, true, false]) source.set({ ...source.getSnapshot(), running });
    assert.equal(reads, 1); assert.equal(writes, 0);
    reading.resolve(success({ ...baseline(f.id), canApplyOverlay: false, applyOverlayUnavailableReason: "busy" }));
    await settle(f.controller);
    assert.equal(reads, 2); assert.equal(f.controller.store.getSnapshot().session?.canApplyOverlay, true);
    assert.equal(f.controller.store.getSnapshot().editor, editor); assert.equal(f.controller.store.getSnapshot().dirty, true);
    assert.equal(f.controller.actions.getNumberDraft("workflow.reviewCap"), draft); assert.deepEqual(f.controller.store.getSnapshot().invalidFields, ["workflow.reviewCap"]);
    assert.equal(blocks.getSnapshot(), foreign);
    source.set({ ...source.getSnapshot(), lastAgentError: "unrelated update" }); await settle(f.controller); assert.equal(reads, 2);
  } finally { f.controller.dispose(); }
});

test("running transitions during Profile CAS queue only a read and preserve accepted admission and feedback", async () => {
  const mutation = deferred<RemoteResult<SessionProfileSnapshot>>(); let actual: SessionProfileSnapshot, reads = 0, writes = 0;
  const f = await fixture({ describeSession: async id => { reads++; return success(actual ?? baseline(id)); }, selectSession: async () => { writes++; return mutation.promise; } });
  const source = sessionSource(f.id, false);
  try {
    f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
    f.controller.actions.chooseSessionProfile("p"); const applying = f.controller.actions.applySession();
    source.set({ ...source.getSnapshot(), running: true }); source.set({ ...source.getSnapshot(), running: false });
    assert.equal(reads, 1); assert.equal(writes, 1); assert.equal(f.controller.store.getSnapshot().sessionBusy, "apply");
    actual = { ...selected(f.id), admissionEpoch: "latest-admission" }; mutation.resolve(success(selected(f.id)));
    await applying; await settle(f.controller);
    assert.equal(reads, 2); assert.equal(writes, 1); assert.equal(f.controller.store.getSnapshot().session?.admissionEpoch, "latest-admission");
    assert.equal(f.controller.store.getSnapshot().sessionNotice, "applied"); assert.equal(f.blocks.storeFor(f.id).getSnapshot(), undefined);
  } finally { f.controller.dispose(); }
});

test("same-binding open failure retains the exact session block across a delayed Profile CAS until a safe reread", async () => {
  const mutation = deferred<RemoteResult<SessionProfileSnapshot>>(), confirmation = deferred<RemoteResult<SessionProfileSnapshot>>();
  let writes = 0, reads = 0, confirming = false;
  const f = await fixture({ describeSession: async id => { reads++; return confirming ? confirmation.promise : success(baseline(id)); },
    selectSession: async () => { writes++; return mutation.promise; } });
  const source = sessionSource(f.id, false);
  try {
    f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
    f.controller.actions.chooseSessionProfile("p"); const applying = f.controller.actions.applySession();
    const block = f.blocks.storeFor(f.id).getSnapshot(); assert.ok(block);
    source.set({ ...source.getSnapshot(), openState: "error", openError: new RemoteError("gateway/cancelled", "history stream failed", {}) });
    assert.equal(f.controller.store.getSnapshot().session, null);
    assert.equal(f.controller.store.getSnapshot().sessionIssue?.code, "gateway/cancelled");
    assert.equal(f.blocks.storeFor(f.id).getSnapshot(), block, "read failure must not release an in-flight session CAS block");
    assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, true);
    mutation.resolve(success(selected(f.id))); await applying;
    assert.equal(f.blocks.storeFor(f.id).getSnapshot(), block, "a fenced late result is not safe confirmation");
    assert.equal(f.controller.store.getSnapshot().session, null);
    await f.controller.actions.applySession(); assert.equal(writes, 1); assert.equal(reads, 1);
    source.set({ ...source.getSnapshot(), openState: "open", openError: null });
    confirming = true; const refreshing = f.controller.actions.refreshSession();
    assert.equal(f.blocks.storeFor(f.id).getSnapshot(), block);
    confirmation.resolve(success(selected(f.id))); await refreshing;
    assert.equal(f.blocks.storeFor(f.id).getSnapshot(), undefined);
    assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, false);
    assert.equal(f.controller.store.getSnapshot().sessionIssue, null);
    assert.equal(writes, 1); assert.equal(reads, 2);
  } finally { mutation.resolve(success(selected(f.id))); confirmation.resolve(success(selected(f.id))); f.controller.dispose(); }
});

test("same-binding open failure retains an accepted refresh-required selection block until safe confirmation", async t => {
  for (const pending of ["session", "selection"] as const) await t.test(pending, async () => {
    const accepted = selected("actual-host-blank");
    const f = await fixture({ describeSession: async id => success(baseline(id)), selectSession: async () => success(pending === "session"
      ? { ...accepted, refreshRequired: true } : { ...accepted, selection: { ...accepted.selection, refreshRequired: true } }) });
    const source = sessionSource(f.id, false);
    try {
      f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
      f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
      const block = f.blocks.storeFor(f.id).getSnapshot(); assert.ok(block);
      source.set({ ...source.getSnapshot(), openState: "error", openError: new RemoteError("gateway/cancelled", "history stream failed", {}) });
      assert.equal(f.blocks.storeFor(f.id).getSnapshot(), block);
      assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, true);
      source.set({ ...source.getSnapshot(), openState: "open", openError: null });
      await f.controller.actions.refreshSession();
      assert.equal(f.blocks.storeFor(f.id).getSnapshot(), undefined);
    } finally { f.controller.dispose(); }
  });
});

test("late describe and detached running notifications cannot cross native session, binding or connection lifetime", async t => {
  for (const boundary of ["navigation", "binding", "withdraw", "connection", "dispose"] as const) await t.test(boundary, async () => {
    const reading = deferred<RemoteResult<SessionProfileSnapshot>>(); let hold = false, reads = 0;
    const f = await fixture({ describeSession: async id => { reads++; return hold ? reading.promise : success(baseline(id)); } });
    const source = sessionSource(f.id, true), connection = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: "isolated" } });
    try {
      f.controller.bindConnection(connection); f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
      hold = true; const refreshing = f.controller.actions.refreshSession(); hold = false;
      if (boundary === "navigation") f.controller.setSession("other-root");
      if (boundary === "binding") f.controller.attachSessionSource(f.id, sessionSource(f.id, false));
      if (boundary === "withdraw") f.controller.attachSessionSource(f.id, null);
      if (boundary === "connection") { connection.set(undefined); source.set({ ...source.getSnapshot(), running: false }); connection.set({ id: 2, host: { home: "replacement" } }); }
      if (boundary === "dispose") f.controller.dispose();
      if (boundary !== "dispose") await settle(f.controller);
      const before = f.controller.store.getSnapshot(), priorReads = reads;
      source.set({ ...source.getSnapshot(), running: false });
      reading.resolve(success({ ...selected(f.id), admissionEpoch: "stale-admission" })); await refreshing;
      if (boundary !== "dispose") await settle(f.controller);
      assert.equal(f.controller.store.getSnapshot(), before); assert.equal(reads, priorReads);
      if (boundary === "withdraw") { await f.controller.actions.refreshSession(); assert.equal(reads, priorReads); assert.equal(before.session, null); }
    } finally { f.controller.dispose(); }
  });
});

test("native idle cannot override server maintenance and an explicit reread can observe tool completion without a running transition", async () => {
  let available = false, reads = 0, writes = 0;
  const f = await fixture({ describeSession: async id => { reads++; return success({ ...baseline(id), canApplyOverlay: available,
    ...(available ? {} : { applyOverlayUnavailableReason: "maintenance" as const }) }); }, selectSession: async id => { writes++; return success(selected(id)); } });
  const source = sessionSource(f.id, true);
  try {
    f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
    source.set({ ...source.getSnapshot(), running: false }); await settle(f.controller);
    assert.equal(reads, 2); assert.equal(f.controller.store.getSnapshot().session?.canApplyOverlay, false);
    f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession(); assert.equal(writes, 0);
    available = true; await f.controller.actions.refreshSession();
    assert.equal(source.getSnapshot().running, false); assert.equal(f.controller.store.getSnapshot().session?.canApplyOverlay, true);
    f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession(); assert.equal(writes, 1);
  } finally { f.controller.dispose(); }
});

test("late Profile mutation cannot publish into a replacement or withdrawn exact binding", async t => {
  for (const boundary of ["binding", "withdraw"] as const) await t.test(boundary, async () => {
    const mutation = deferred<RemoteResult<SessionProfileSnapshot>>(); let reads = 0, writes = 0;
    const f = await fixture({ describeSession: async id => { reads++; return success(baseline(id)); }, selectSession: async () => { writes++; return mutation.promise; } });
    try {
      f.controller.attachSessionSource(f.id, sessionSource(f.id, false)); f.controller.setSession(f.id); await settle(f.controller);
      f.controller.actions.chooseSessionProfile("p"); const applying = f.controller.actions.applySession();
      f.controller.attachSessionSource(f.id, boundary === "binding" ? sessionSource(f.id, false) : null); await settle(f.controller);
      assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, true);
      mutation.resolve(success({ ...selected(f.id), admissionEpoch: "withdrawn-admission" })); await applying; await settle(f.controller);
      assert.equal(writes, 1); assert.equal(f.controller.store.getSnapshot().sessionNotice, null);
      assert.equal(f.controller.store.getSnapshot().session?.admissionEpoch, boundary === "binding" ? "epoch-1" : undefined);
      assert.equal(reads, boundary === "binding" ? 3 : 1);
      if (boundary === "binding") assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, false);
    } finally { f.controller.dispose(); }
  });
});

test("pending mode mutation rereads capability changes and a replacement binding observes its final state", async t => {
  for (const boundary of ["running", "binding"] as const) await t.test(boundary, async () => {
    const mutation = deferred<RemoteResult<SessionProfileSnapshot>>(); let active = false, reads = 0, writes = 0;
    const frame = (id: string): SessionProfileSnapshot => ({ ...baseline(id), canToggleMode: true, deepwork: { active, explicit: active, locked: false, revision } });
    const f = await fixture({ describeSession: async id => { reads++; return success(frame(id)); }, selectMode: async () => { writes++; return mutation.promise; } });
    const source = sessionSource(f.id, false);
    try {
      f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
      const changing = f.controller.actions.setDeepwork(true);
      if (boundary === "running") { source.set({ ...source.getSnapshot(), running: true }); source.set({ ...source.getSnapshot(), running: false }); }
      else { f.controller.attachSessionSource(f.id, sessionSource(f.id, false)); await settle(f.controller); }
      active = true; mutation.resolve(success(frame(f.id))); await changing; await settle(f.controller);
      assert.equal(writes, 1); assert.equal(reads, boundary === "running" ? 2 : 3);
      assert.equal(f.controller.store.getSnapshot().session?.deepwork?.active, true);
    } finally { f.controller.dispose(); }
  });
});

test("busy, maintenance and CAS conflict refresh capabilities without retrying Profile selection", async t => {
  for (const code of ["busy", "maintenance", "conflict"] as const) await t.test(code, async () => {
    let reads = 0, writes = 0;
    const f = await fixture({ describeSession: async id => { reads++; return success(baseline(id)); },
      selectSession: async () => { writes++; return { ok: false, error: new RemoteError("dsmm-profiles/refused", code, { code, message: code }) }; } });
    try {
      f.controller.attachSessionSource(f.id, sessionSource(f.id, false)); f.controller.setSession(f.id); await settle(f.controller);
      f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession(); await settle(f.controller);
      assert.equal(reads, 2); assert.equal(writes, 1); assert.equal(f.controller.store.getSnapshot().sessionIssue?.code, code);
      assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, false);
    } finally { f.controller.dispose(); }
  });
});

function unavailableSession(): RemoteResult<SessionProfileSnapshot> {
  return { ok: false, error: new RemoteError("dsmm-profiles/refused", "not yet admitted", { code: "unavailable", message: "not yet admitted", field: "sessionId" }) };
}

function activationFailure(): RemoteResult<SessionProfileSnapshot> {
  return { ok: false, error: new RemoteError("dsmm-profiles/refused", "admission incomplete", { code: "activation", message: "admission incomplete" }) };
}

test("unready native true bursts coalesce one pending read and permanent activation never retries without another event", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reading = deferred<RemoteResult<SessionProfileSnapshot>>(); let reads = 0, available = false;
  const f = await fixture({ describeSession: async id => {
    reads++;
    if (reads === 1) return unavailableSession();
    if (reads === 2) return reading.promise;
    return available ? success(baseline(id)) : activationFailure();
  } });
  const source = sessionSource(f.id, false);
  try {
    f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
    for (let i = 0; i < 10; i++) f.controller.observeSessionAvailability(f.id, source, true);
    assert.equal(reads, 2, "a burst cannot start parallel reads");
    reading.resolve(activationFailure()); await settle(f.controller);
    assert.equal(reads, 3, "one pending tail read survives the in-flight failure");
    assert.equal(f.controller.store.getSnapshot().sessionIssue?.code, "activation");
    assert.equal(f.controller.store.getSnapshot().sessionReadinessPending, false);
    t.mock.timers.tick(60_000); await setImmediate();
    assert.equal(reads, 3, "neither failure nor a timer schedules another read");
    available = true;
    f.controller.observeSessionAvailability(f.id, source, true); await settle(f.controller);
    assert.equal(reads, 4); assert.equal(f.controller.store.getSnapshot().sessionIssue, null);
    for (let i = 0; i < 10; i++) f.controller.observeSessionAvailability(f.id, source, true);
    await setImmediate(); assert.equal(reads, 4, "successful current-cycle reads deduplicate identical true");
  } finally { f.controller.dispose(); }
});

test("a false availability edge fences older successful reads even while their snapshots remain visible", async () => {
  const reading = deferred<RemoteResult<SessionProfileSnapshot>>(); let reads = 0, available = true;
  const f = await fixture({ describeSession: async id => {
    reads++;
    if (reads === 3) return reading.promise;
    return available ? success(baseline(id)) : activationFailure();
  } });
  const source = sessionSource(f.id, false);
  try {
    f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
    f.controller.observeSessionAvailability(f.id, source, true); await settle(f.controller);
    assert.equal(reads, 2);
    const refreshing = f.controller.actions.refreshSession();
    f.controller.observeSessionAvailability(f.id, source, false);
    f.controller.observeSessionAvailability(f.id, source, true);
    available = false;
    reading.resolve(success(baseline(f.id))); await refreshing; await settle(f.controller);
    assert.equal(reads, 4); assert.notEqual(f.controller.store.getSnapshot().session, null);
    assert.equal(f.controller.store.getSnapshot().sessionIssue?.code, "activation");
    available = true;
    f.controller.observeSessionAvailability(f.id, source, true); await settle(f.controller);
    assert.equal(reads, 5, "the old successful response cannot acknowledge this availability cycle");
    assert.equal(f.controller.store.getSnapshot().sessionIssue, null);
  } finally { f.controller.dispose(); }
});

test("a successful readiness read retains a queued running invalidation for the pending tail read", async () => {
  const reading = deferred<RemoteResult<SessionProfileSnapshot>>(); let reads = 0;
  const f = await fixture({ describeSession: async id => {
    reads++;
    if (reads === 1) return unavailableSession();
    return reads === 2 ? reading.promise : success(baseline(id));
  } });
  const source = sessionSource(f.id, false);
  try {
    f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
    f.controller.observeSessionAvailability(f.id, source, true);
    source.set({ ...source.getSnapshot(), running: true }); source.set({ ...source.getSnapshot(), running: false });
    f.controller.observeSessionAvailability(f.id, source, true);
    reading.resolve(success({ ...baseline(f.id), canApplyOverlay: false, applyOverlayUnavailableReason: "busy" }));
    await settle(f.controller);
    assert.equal(reads, 3); assert.equal(f.controller.store.getSnapshot().session?.canApplyOverlay, true);
    f.controller.observeSessionAvailability(f.id, source, true); await setImmediate(); assert.equal(reads, 3);
  } finally { f.controller.dispose(); }
});

test("false availability invalidates readiness success without restarting its one display deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture({ describeSession: async () => unavailableSession() }), source = sessionSource(f.id, false);
  try {
    f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
    t.mock.timers.tick(9000);
    f.controller.observeSessionAvailability(f.id, source, false);
    f.controller.observeSessionAvailability(f.id, source, true); await settle(f.controller);
    assert.equal(f.controller.store.getSnapshot().sessionReadinessPending, true);
    t.mock.timers.tick(1000);
    assert.equal(f.controller.store.getSnapshot().sessionReadinessPending, false);
    f.controller.observeSessionAvailability(f.id, source, false);
    f.controller.observeSessionAvailability(f.id, source, true); await settle(f.controller);
    assert.equal(f.controller.store.getSnapshot().sessionReadinessPending, false);
  } finally { f.controller.dispose(); }
});

test("replacing an exact binding with the same source fences old read success and readiness deduplication", async () => {
  const reading = deferred<RemoteResult<SessionProfileSnapshot>>(); let reads = 0, available = true;
  const f = await fixture({ describeSession: async id => {
    reads++;
    return reads === 3 ? reading.promise : available ? success(baseline(id)) : activationFailure();
  } });
  const source = sessionSource(f.id, false);
  try {
    f.controller.attachSessionSource(f.id, source, {}); f.controller.setSession(f.id); await settle(f.controller);
    f.controller.observeSessionAvailability(f.id, source, true); await settle(f.controller);
    const refreshing = f.controller.actions.refreshSession();
    available = false;
    f.controller.attachSessionSource(f.id, source, {}); await settle(f.controller);
    assert.equal(reads, 4);
    const replacement = f.controller.store.getSnapshot();
    reading.resolve(success(baseline(f.id))); await refreshing;
    assert.equal(f.controller.store.getSnapshot(), replacement);
    available = true;
    f.controller.observeSessionAvailability(f.id, source, true); await settle(f.controller);
    assert.equal(reads, 5); assert.equal(f.controller.store.getSnapshot().sessionIssue, null);
  } finally { f.controller.dispose(); }
});

test("initial native unavailability has one display deadline, no retry, and late readiness clears the read issue", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let available = false, reads = 0;
  const f = await fixture({ describeSession: async id => { reads++; return available ? success(baseline(id)) : unavailableSession(); } });
  const source = sessionSource(f.id, false), foreign = { reason: "native owner" };
  try {
    f.blocks.set(f.id, foreign);
    await f.controller.actions.create();
    f.controller.actions.editContent('{"version":1,"id":"draft","settings":{}}');
    f.controller.actions.setNumberDraft("workflow.reviewCap", { draft: "-", invalid: true, sourceValue: 2 });
    f.controller.actions.setFieldInvalid("workflow.reviewCap", true);
    const editor = f.controller.store.getSnapshot().editor, number = f.controller.actions.getNumberDraft("workflow.reviewCap");
    f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
    assert.equal(f.controller.store.getSnapshot().sessionReadinessPending, true);
    assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, false);
    t.mock.timers.tick(9000);
    await f.controller.actions.refreshSession();
    source.set({ ...source.getSnapshot() });
    assert.equal(f.controller.store.getSnapshot().sessionReadinessPending, true);
    t.mock.timers.tick(1000);
    assert.equal(f.controller.store.getSnapshot().sessionReadinessPending, false);
    assert.equal(f.controller.store.getSnapshot().sessionIssue?.field, "sessionId");
    assert.equal(reads, 2, "expiry only changes presentation");
    await f.controller.actions.refreshSession();
    assert.equal(f.controller.store.getSnapshot().sessionReadinessPending, false, "Refresh cannot restart the display deadline");
    available = true;
    f.controller.observeSessionAvailability(f.id, source, true); await settle(f.controller);
    assert.equal(reads, 4); assert.equal(f.controller.store.getSnapshot().session?.sessionId, f.id);
    assert.equal(f.controller.store.getSnapshot().sessionIssue, null);
    for (let i = 0; i < 5; i++) f.controller.observeSessionAvailability(f.id, source, true);
    assert.equal(reads, 4, "duplicate ready summaries do not storm");
    f.controller.observeSessionAvailability(f.id, source, false);
    f.controller.observeSessionAvailability(f.id, source, true); await settle(f.controller); assert.equal(reads, 5);
    assert.equal(f.controller.store.getSnapshot().editor, editor); assert.equal(f.controller.store.getSnapshot().dirty, true);
    assert.equal(f.controller.actions.getNumberDraft("workflow.reviewCap"), number);
    assert.deepEqual(f.controller.store.getSnapshot().invalidFields, ["workflow.reviewCap"]);
    assert.equal(f.blocks.storeFor(f.id).getSnapshot(), foreign);
  } finally { f.controller.dispose(); }
});

test("readiness never masks other errors or unavailable reads without an exact native binding", async t => {
  for (const failure of [
    new RemoteError("dsmm-profiles/refused", "other unavailable", { code: "unavailable", message: "other" }),
    new RemoteError("dsmm-profiles/refused", "validation", { code: "validation", message: "invalid", field: "sessionId" }),
    new RemoteError("dsmm-profiles/refused", "activation", { code: "activation", message: "activation" }),
    new RemoteError("dsmm-profiles/refused", "not-owned", { code: "not-owned", message: "not-owned", field: "sessionId" }),
    new RemoteError("dsmm-profiles/peer-required", "auth", {}), new RemoteError("gateway/cancelled", "transport", {}),
  ]) await t.test(failure.code + failure.message, async () => {
    const f = await fixture({ describeSession: async () => ({ ok: false, error: failure }) });
    try {
      f.controller.attachSessionSource(f.id, sessionSource(f.id, false)); f.controller.setSession(f.id); await settle(f.controller);
      assert.equal(f.controller.store.getSnapshot().sessionReadinessPending, false);
      assert.notEqual(f.controller.store.getSnapshot().sessionIssue, null);
    } finally { f.controller.dispose(); }
  });
  const f = await fixture({ describeSession: async () => unavailableSession() });
  try { f.controller.setSession(f.id); await settle(f.controller); assert.equal(f.controller.store.getSnapshot().sessionReadinessPending, false); }
  finally { f.controller.dispose(); }
});

test("removed and open-error snapshots terminate readiness even when running stays idle", async t => {
  for (const failure of ["removed", "openError"] as const) await t.test(failure, async () => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let reads = 0;
    const f = await fixture({ describeSession: async () => { reads++; return unavailableSession(); } }), source = sessionSource(f.id, false);
    try {
      f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
      assert.equal(f.controller.store.getSnapshot().sessionReadinessPending, true);
      source.set({ ...source.getSnapshot(), ...(failure === "removed" ? { removed: true } : { openState: "error" as const, openError: new RemoteError("dsmm-profiles/peer-required", "denied", {}) }) });
      assert.equal(f.controller.store.getSnapshot().sessionReadinessPending, false);
      assert.equal(f.controller.store.getSnapshot().sessionIssue?.code, failure === "removed" ? "disposed" : "dsmm-profiles/peer-required");
      const snapshot = f.controller.store.getSnapshot(); t.mock.timers.tick(10_000);
      assert.equal(f.controller.store.getSnapshot(), snapshot); assert.equal(reads, 1);
    } finally { f.controller.dispose(); t.mock.timers.reset(); }
  });
});

test("pending readiness and old notifications are fenced by binding, navigation, connection and disposal", async t => {
  for (const boundary of ["binding", "withdraw", "navigation", "connection", "dispose"] as const) await t.test(boundary, async () => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let reads = 0;
    const f = await fixture({ describeSession: async () => { reads++; return unavailableSession(); } }), source = sessionSource(f.id, false);
    const connection = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: "isolated" } });
    try {
      f.controller.bindConnection(connection); f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
      t.mock.timers.tick(5000);
      if (boundary === "binding") f.controller.attachSessionSource(f.id, sessionSource(f.id, false));
      if (boundary === "withdraw") f.controller.attachSessionSource(f.id, null);
      if (boundary === "navigation") f.controller.setSession(null);
      if (boundary === "connection") { connection.set(undefined); connection.set({ id: 2, host: { home: "replacement" } }); }
      if (boundary === "dispose") f.controller.dispose();
      await settle(f.controller);
      const snapshot = f.controller.store.getSnapshot(), count = reads;
      if (boundary !== "connection") f.controller.observeSessionAvailability(f.id, source, true);
      t.mock.timers.tick(5000);
      assert.equal(f.controller.store.getSnapshot(), snapshot); assert.equal(reads, count);
      assert.equal(snapshot.sessionReadinessPending, boundary === "binding" || boundary === "connection");
    } finally { f.controller.dispose(); t.mock.timers.reset(); }
  });
});

test("successful readiness cancels its timer and an open failure fences an older unavailable response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let available = false;
  const pending = deferred<RemoteResult<SessionProfileSnapshot>>();
  let hold = false;
  const f = await fixture({ describeSession: async id => hold ? pending.promise : available ? success(baseline(id)) : unavailableSession() });
  const source = sessionSource(f.id, false);
  try {
    f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
    available = true; f.controller.observeSessionAvailability(f.id, source, true); await settle(f.controller);
    const accepted = f.controller.store.getSnapshot(); t.mock.timers.tick(10_000);
    assert.equal(f.controller.store.getSnapshot(), accepted); assert.equal(accepted.sessionIssue, null);
    hold = true; const reading = f.controller.actions.refreshSession();
    source.set({ ...source.getSnapshot(), openState: "error", openError: new RemoteError("gateway/cancelled", "open failed", {}) });
    const failed = f.controller.store.getSnapshot();
    pending.resolve(unavailableSession()); await reading;
    assert.equal(f.controller.store.getSnapshot(), failed);
    assert.equal(failed.sessionReadinessPending, false); assert.equal(failed.sessionIssue?.code, "gateway/cancelled");
  } finally { f.controller.dispose(); }
});

test("readiness during a Profile CAS coalesces one read without clearing independent refusal feedback", async () => {
  const mutation = deferred<RemoteResult<SessionProfileSnapshot>>(); let reads = 0;
  const f = await fixture({ describeSession: async id => { reads++; return success(baseline(id)); }, selectSession: async () => mutation.promise });
  const source = sessionSource(f.id, false);
  try {
    f.controller.attachSessionSource(f.id, source); f.controller.setSession(f.id); await settle(f.controller);
    f.controller.actions.chooseSessionProfile("p"); const applying = f.controller.actions.applySession();
    for (let i = 0; i < 5; i++) f.controller.observeSessionAvailability(f.id, source, true);
    assert.equal(reads, 1);
    mutation.resolve({ ok: false, error: new RemoteError("dsmm-profiles/refused", "conflict", { code: "conflict", message: "conflict" }) });
    await applying; await settle(f.controller);
    assert.equal(reads, 2); assert.equal(f.controller.store.getSnapshot().sessionIssue?.code, "conflict");
    await f.controller.actions.refreshSession(); assert.equal(f.controller.store.getSnapshot().sessionIssue?.code, "conflict");
  } finally { f.controller.dispose(); }
});

test("Refresh reads the captured session in parallel with inventory failure and preserves draft CAS state", async () => {
  const global = deferred<RemoteResult<ProfileSnapshot>>();
  let hold = false, reads: string[] = [];
  const f = await fixture({ describe: async () => hold ? global.promise : success({ profiles: [], selectedId: null, appliedRevision: null, selectionRevision: "absent" }),
    describeSession: async id => { reads.push(id); return success(baseline(id)); } });
  try {
    f.controller.attachSessionSource(f.id, sessionSource(f.id, false)); f.controller.setSession(f.id); await settle(f.controller);
    await f.controller.actions.create(); f.controller.actions.editContent('{"version":1,"id":"draft","settings":{}}');
    f.controller.actions.setNumberDraft("workflow.reviewCap", { draft: "-", invalid: true, sourceValue: 2 }); f.controller.actions.setFieldInvalid("workflow.reviewCap", true);
    const draft = f.controller.store.getSnapshot().editor, number = f.controller.actions.getNumberDraft("workflow.reviewCap");
    hold = true; const refreshing = f.controller.actions.refresh();
    assert.deepEqual(reads, [f.id, f.id], "session refresh starts before inventory resolves");
    f.controller.setSession("new-session"); await settle(f.controller);
    global.resolve({ ok: false, error: new RemoteError("gateway/cancelled", "offline", {}) }); await refreshing;
    assert.deepEqual(reads, [f.id, f.id, "new-session"], "inventory completion never redirects its session refresh");
    assert.equal(f.controller.store.getSnapshot().issue?.kind, "transport");
    assert.equal(f.controller.store.getSnapshot().session?.sessionId, "new-session");
    assert.equal(f.controller.store.getSnapshot().editor, draft); assert.equal(f.controller.store.getSnapshot().dirty, true);
    assert.equal(f.controller.actions.getNumberDraft("workflow.reviewCap"), number); assert.deepEqual(f.controller.store.getSnapshot().invalidFields, ["workflow.reviewCap"]);
  } finally { f.controller.dispose(); }
});
