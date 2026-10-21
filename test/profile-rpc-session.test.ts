import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context, symbols } from "@deepseek-ai/cordis";
import type { Service } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import { RemoteAccessService } from "@deepseek-ai/dsh-api-remote-access";
import * as NativeConnection from "@deepseek-ai/dsh-client-connection";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { TYPERT_REMOTE } from "../src/profile-remote.ts";
import { DsmmConfigHost, registerProfilesRpc } from "../src/profile-rpc.ts";
import { ProfileStore } from "../src/profile-store.ts";
import { DsmmProfileRuntime } from "../src/profile-runtime.ts";
import type { DsmmProfileRuntimeOptions } from "../src/profile-runtime.ts";
import { resolveConfig } from "../src/settings.ts";
import type { DshAgent, DshContext } from "../src/dsh-types.ts";
import type { DeploymentEditorSnapshot, SessionProfileSelectRequest, SessionProfileSnapshot } from "../src/profile-types.ts";
import { DsmmDeploymentConfig } from "../src/deployment-config.ts";
import type { GlobalConfigSnapshot } from "../src/deployment-config.ts";
import { nativeRoutingFixture } from "./native-routing-fixture.ts";

const require = createRequire(import.meta.url);
const nativeRequire = createRequire(require.resolve("@deepseek-ai/dsh-client-connection/package.json"));
const { CredentialProvider } = nativeRequire("@deepseek-ai/dsh-credentials") as { CredentialProvider: new (ctx: Context) => Service };
/** Signing records exist only in this isolated in-memory native provider. */
class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<string, unknown>();
  async modifyRecord(key: string, modify: (current: unknown) => Promise<unknown>): Promise<unknown> {
    const next = await modify(this.records.get(key));
    if (next !== undefined) this.records.set(key, next);
    return this.records.get(key);
  }
}

async function fixture(nativeConnection = true, globalConfig = false, baseline = resolveConfig(), options?: DsmmProfileRuntimeOptions) {
  const root = await mkdtemp(join(tmpdir(), "dsmm-scoped-rpc-")), ctx = new Context();
  try {
    await ctx.plugin(RemoteAccessService).await();
    await Promise.all([ctx.plugin(TypertRegistry).await(), ctx.plugin(TypertGatewayService, {}).await(), ctx.plugin(AgentRegistry).await()]);
    if (nativeConnection) await ctx.plugin(MemoryCredentials).await();
    const connectionFiber = nativeConnection ? ctx.plugin(NativeConnection) : undefined;
    await connectionFiber?.await();
    const store = new ProfileStore(join(root, "dsmm-profiles"));
    const runtime = new DsmmProfileRuntime(ctx as unknown as DshContext, baseline, store, options);
    await runtime.initialize();
    const carrier = { host: "127.0.0.1" }, settingsAuthority = { writable: true };
    ctx.provide("webServer", carrier); ctx.provide("settings", settingsAuthority);
    let deployment: DsmmDeploymentConfig | undefined;
    if (globalConfig) {
      ctx.provide("profileContext", { home: root, dir: root });
      deployment = new DsmmDeploymentConfig(ctx as unknown as DshContext, {});
    }
    const rpc = ctx.plugin({ name: "session-profile-rpc", inject: ["typert"], apply(ready: Context) {
      registerProfilesRpc(ready, runtime);
      if (deployment !== undefined) new DsmmConfigHost(ready, deployment, baseline, () => runtime, options?.startup?.sources);
    } }); await rpc.await();
    const gateway = ctx.typertGateway;
    const peer = nativeConnection ? ctx.connection.browserPeer : new NativeConnection.Peer(ctx, { principal: { kind: "owner" } });
    const invoke = <T>(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> => gateway.invoke({ namespace: "dsmmProfiles", method, args, peer, signal }) as Promise<T>;
    // Registry/session/Connection/Gateway/store are native. This idle maintenance
    // seam and explicit publication do not claim native activation-loop proof.
    const createRoot = async (id: string, origin?: "subagent") => {
      const initial = Session.create(SessionId(id));
      const session = origin === undefined ? initial : Session.create(initial.id, [], { ...initial.header, origin });
      let maintenance = false;
      const agent: DshAgent = { id: session.id, session: session as unknown as DshAgent["session"], ctx: ctx as unknown as DshContext, status: "idle", runMaintenance(task) {
        if (maintenance || this.status === "running") throw new Error("maintenance is not available");
        maintenance = true; return task(new AbortController().signal).finally(() => { maintenance = false; });
      } };
      await ctx.agents.register(agent as unknown as Agent);
      if (origin === undefined) runtime.publish(agent, await runtime.prepareRoot(agent, new AbortController().signal));
      return agent;
    };
    return { root, ctx, gateway, runtime, store, rpc, connectionFiber, invoke, createRoot, deployment, carrier, settingsAuthority,
      async dispose() { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); throw error; }
}
const refused = (code: string) => (error: unknown) => {
  const remote = remoteErrorOf(error);
  return remote?.code === "dsmm-profiles/refused" && remote.details.code === code;
};
function selectRequest(snapshot: SessionProfileSnapshot, id: string | null): SessionProfileSelectRequest {
  return { sessionId: snapshot.sessionId, id, expectedSelectionRevision: snapshot.selection.selectionRevision, expectedAdmissionEpoch: snapshot.admissionEpoch };
}
function modeRequest(snapshot: SessionProfileSnapshot, active: boolean) {
  return { sessionId: snapshot.sessionId, active, expectedModeRevision: snapshot.deepwork!.revision, expectedAdmissionEpoch: snapshot.admissionEpoch };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("session and mode codecs reject supplied authority, invalid identities, unsafe routes and malformed revisions", () => {
  const describe = TYPERT_REMOTE.descriptors.find(row => row.method === "describeSession")!;
  const select = TYPERT_REMOTE.descriptors.find(row => row.method === "selectSession")!;
  const mode = TYPERT_REMOTE.descriptors.find(row => row.method === "selectMode")!;
  assert.deepEqual(describe.parameters.map(({ name, wire, source }) => ({ name, wire, source })), [{ name: "sessionId", wire: "sessionId", source: "json" }]);
  assert.deepEqual(select.parameters.map(({ name, wire, source }) => ({ name, wire, source })), [{ name: "sessionId", wire: "sessionId", source: "json" }, { name: "request", wire: "request", source: "json" }]);
  for (const descriptor of [describe, select, mode]) { assert.equal(descriptor.result.mode, "strict"); for (const parameter of descriptor.parameters) assert.equal(parameter.codec.mode, "strict"); }
  const request = { sessionId: "native-session", id: null, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "a".repeat(64) };
  const codec = select.parameters[1].codec, modeCodec = mode.parameters[1].codec, result = describe.result;
  if (codec.mode !== "strict" || modeCodec.mode !== "strict" || result.mode !== "strict") assert.fail("strict protocol required");
  assert.deepEqual(codec.create().parse(request), request);
  for (const invalid of [{ ...request, agent: {} }, { ...request, peer: {} }, { ...request, path: "C:/private" }, { ...request, owner: true }, { ...request, expectedAdmissionEpoch: "old" }, { ...request, expectedAdmissionEpoch: "a".repeat(65) }, ...["", "a".repeat(257), "a\0b", "\uD800"].map(sessionId => ({ ...request, sessionId })), { ...request, id: "a" }, { ...request, expectedRevision: "b".repeat(64) }, { ...request, expectedSelectionRevision: "unavailable" }]) assert.throws(() => codec.create().parse(invalid));
  const toggle = { sessionId: request.sessionId, active: false, expectedModeRevision: "b".repeat(64), expectedAdmissionEpoch: request.expectedAdmissionEpoch };
  assert.deepEqual(modeCodec.create().parse(toggle), toggle);
  for (const invalid of [{ ...toggle, active: "false" }, { ...toggle, peer: "private" }, { ...toggle, expectedModeRevision: "absent" }, { ...toggle, expectedAdmissionEpoch: "old" }]) assert.throws(() => modeCodec.create().parse(invalid));
  const selection = { selectedId: null, appliedRevision: null, selectionRevision: "absent" };
  const snapshot = { sessionId: request.sessionId, globalDefault: selection, selection, scope: "global-default", admissionEpoch: request.expectedAdmissionEpoch, switchAllowed: false, canSelectModel: false, canToggleMode: false, canApplyOverlay: false };
  assert.deepEqual(result.create().parse(snapshot), snapshot);
  for (const invalid of [{ ...snapshot, credentials: {} }, { ...snapshot, admissionEpoch: "unavailable" }, { ...snapshot, selection: { ...selection, path: "secret" } }, { ...snapshot, switchAllowed: "yes" }, { ...snapshot, scope: ["global-default"] }]) assert.throws(() => result.create().parse(invalid));
  const deepwork = { active: false, explicit: false, locked: false, revision: "b".repeat(64) };
  assert.deepEqual(result.create().parse({ ...snapshot, deepwork }), { ...snapshot, deepwork });
  for (const invalid of [{ ...deepwork, active: "true" }, { ...deepwork, secret: true }, { ...deepwork, revision: "absent" }]) assert.throws(() => result.create().parse({ ...snapshot, deepwork: invalid }));
  const rateLimit = { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 10000, maxTotalDelayMs: 30000, switchAfterRateLimits: 3, maxSwitches: 2 };
  const policy = { role: "dsmm-planner", strategy: "startup-lock", rateLimit, retries: 0, rateLimitFailures: 0, switches: 0, totalDelayMs: 0, route: { provider: "manual-route", model: "m".repeat(512), reasoningEffort: "high" } };
  assert.deepEqual(result.create().parse({ ...snapshot, rolePolicy: policy }), { ...snapshot, rolePolicy: policy });
  for (const profileModel of [policy.route, { provider: "manual-provider", model: "manual/model" }, { provider: "fixture", model: "model", temperature: 0.4, top_p: 0.9 }]) assert.deepEqual(result.create().parse({ ...snapshot, profileModel }), { ...snapshot, profileModel });
  for (const profileModel of [null, { provider: "fixture", model: "model", auth: "hidden" }, { provider: "fixture", model: "model", authorityCeiling: {} }, { provider: "https://private", model: "model" }, { provider: "fixture", model: "https://private" }, { provider: "p".repeat(129), model: "model" }, { provider: "fixture", model: "m".repeat(513) }, { provider: "fixture", model: "model", reasoningEffort: "e".repeat(65) }, { provider: "fixture", model: "model", reasoningEffort: "" }, { provider: "fixture", model: "bad\0model" }, { provider: "fixture", model: "\uD800" }]) assert.throws(() => result.create().parse({ ...snapshot, profileModel }));
  for (const rolePolicy of [{ ...policy, credentials: {} }, { ...policy, role: "not-a-dw-role" }, { ...policy, retries: Infinity }, { ...policy, switches: 11 }, { ...policy, rateLimit: { ...rateLimit, maxRetries: -1 } }, { ...policy, rateLimit: { ...rateLimit, peer: true } }, { ...policy, route: { provider: "https://secret-provider", model: "m" } }, { ...policy, route: { provider: "native-provider", model: "https://credential-bearing-model" } }]) assert.throws(() => result.create().parse({ ...snapshot, rolePolicy }));
});

test("native Gateway reports immutable admitted configuration and refuses live Apply without changing either root or pointers", async () => {
  const f = await fixture();
  try {
    const a = await f.createRoot("rpc-root-a"), b = await f.createRoot("rpc-root-b");
    const beforeA = await f.invoke<SessionProfileSnapshot>("describeSession", { sessionId: a.id }), beforeB = await f.invoke<SessionProfileSnapshot>("describeSession", { sessionId: b.id });
    const global = await f.runtime.describe(), admitted = f.runtime.admission(a);
    assert.equal(beforeA.switchAllowed, false); assert.equal(beforeA.switchUnavailableReason, "unavailable");
    await assert.rejects(f.invoke("selectSession", { sessionId: a.id, request: selectRequest(beforeA, null) }), refused("unavailable"));
    assert.equal(f.runtime.admission(a), admitted); assert.deepEqual(await f.invoke("describeSession", { sessionId: a.id }), beforeA);
    assert.deepEqual(await f.invoke("describeSession", { sessionId: b.id }), beforeB); assert.deepEqual(await f.runtime.describe(), global);
    assert.equal((await f.store.loadSessionSelection(a.id!)).admissionEpoch, null); await assert.rejects(access(join(f.store.stateDir, ".selection.json")), { code: "ENOENT" });
  } finally { await f.dispose(); }
});

test("session mutations require a local writable operator, not only the exact browser peer", async () => {
  const f = await fixture();
  try {
    const agent = await f.createRoot("rpc-local-writer"), before = await f.runtime.getSession(agent);
    const args = { sessionId: agent.id, request: selectRequest(before, null) };
    f.settingsAuthority.writable = false;
    await assert.rejects(f.invoke("selectSession", args), refused("not-owned"));
    f.settingsAuthority.writable = true; f.carrier.host = "0.0.0.0";
    await assert.rejects(f.invoke("selectSession", args), refused("not-owned"));
    assert.equal((await f.store.loadSessionSelection(agent.id!)).admissionEpoch, null);
  } finally { await f.dispose(); }
});

test("native mode RPC changes only an owned root and rejects stale intent and child authority", async () => {
  const native = await nativeRoutingFixture({ defaultActive: false }, { headless: true, persistence: true, nativePermissionSettings: true });
  try {
    const ctx = native.ctx; await ctx.plugin(RemoteAccessService).await();
    ctx.provide("webServer", { host: "127.0.0.1" });
    await Promise.all([ctx.plugin(TypertRegistry).await(), ctx.plugin(TypertGatewayService, {}).await()]);
    await ctx.plugin(MemoryCredentials).await(); await ctx.plugin(NativeConnection).await();
    const invoke = <T>(method: string, args: Record<string, unknown>) => ctx.typertGateway.invoke({ namespace: "dsmmProfiles", method, args, peer: ctx.connection.browserPeer }) as Promise<T>;
    const a = await native.create({ agentPreset: "standard" }), b = await native.create({ agentPreset: "standard" });
    const before = await invoke<SessionProfileSnapshot>("describeSession", { sessionId: a.id }), other = await invoke<SessionProfileSnapshot>("describeSession", { sessionId: b.id });
    const request = modeRequest(before, true), selected = await invoke<SessionProfileSnapshot>("selectMode", { sessionId: a.id, request });
    assert.equal(selected.deepwork!.active, true); assert.equal(selected.deepwork!.explicit, true); assert.equal(selected.admissionEpoch, before.admissionEpoch); assert.deepEqual(selected.selection, before.selection);
    assert.notEqual(selected.deepwork!.revision, before.deepwork!.revision); assert.deepEqual(await invoke("describeSession", { sessionId: b.id }), other);
    await assert.rejects(invoke("selectMode", { sessionId: a.id, request }), refused("conflict"));
    await assert.rejects(invoke("selectMode", { sessionId: b.id, request: modeRequest(selected, false) }), refused("validation"));
    await assert.rejects(native.create({ origin: "subagent" }), { code: "UNAUTHORIZED" });
    const child = await native.createAuxiliary("dsmm-reviewer", undefined, "one-shot", a);
    await assert.rejects(invoke("describeSession", { sessionId: child.id }), refused("not-owned"));
    await assert.rejects(invoke("selectMode", { sessionId: child.id, request: { ...modeRequest(selected, false), sessionId: child.id } }), refused("not-owned"));
    const off = await invoke<SessionProfileSnapshot>("selectMode", { sessionId: a.id, request: modeRequest(selected, false) }); assert.equal(off.deepwork!.active, false);
  } finally { await native.dispose(); }
});

test("mode RPC rejects busy, foreign maintenance, cancellation and malformed cold lookups before writes", async () => {
  const f = await fixture();
  try {
    const agent = await f.createRoot("mode-rpc-busy"), before = await f.runtime.getSession(agent), request = modeRequest(before, true);
    Object.defineProperty(agent, "status", { value: "running", configurable: true }); await assert.rejects(f.invoke("selectMode", { sessionId: agent.id, request }), refused("busy"));
    Object.defineProperty(agent, "status", { value: "idle", configurable: true });
    const blocked = gate(), maintenance = agent.runMaintenance!(() => blocked.promise);
    try { await assert.rejects(f.invoke("selectMode", { sessionId: agent.id, request }), refused("maintenance")); } finally { blocked.release(); await maintenance; }
    const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(f.invoke("selectMode", { sessionId: agent.id, request }, cancelled.signal));
    const cold = { ...request, sessionId: "cold-mode" };
    for (const invalid of [{ ...cold, peer: true }, { ...cold, active: "true" }, { ...cold, expectedModeRevision: "bad" }]) await assert.rejects(f.invoke("selectMode", { sessionId: "cold-mode", request: invalid }));
    assert.deepEqual(await f.runtime.getSession(agent), before);
  } finally { await f.dispose(); }
});

test("bad peers, mismatched identities and malformed payloads refuse before cold resume or mutation", async () => {
  const f = await fixture();
  try {
    let resumes = 0; f.ctx.provide("sessionController", { async resolveAgent() { resumes++; throw new Error("PRIVATE_RESUME"); } });
    const request = { sessionId: "cold-root", id: null, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "a".repeat(64) }, operator = f.ctx.connection.browserPeer;
    const independent = f.ctx.connection.createPeer({ principal: { kind: "owner" } }), impostor = { ...operator, ctx: f.ctx, async dispose() {} };
    for (const peer of [independent, impostor]) await assert.rejects(f.gateway.invoke({ namespace: "dsmmProfiles", method: "selectSession", args: { sessionId: "cold-root", request }, peer }), refused("not-owned"));
    await assert.rejects(f.invoke("selectSession", { sessionId: "other-root", request }), refused("validation"));
    for (const args of [{ sessionId: "cold-root", request: { ...request, peer: operator.id } }, { sessionId: "cold-root", request: { ...request, path: "C:/private" } }, { sessionId: "cold-root", request: { ...request, expectedAdmissionEpoch: "bad" } }, { sessionId: "cold-root", request: { ...request, id: "../bad", expectedRevision: "a".repeat(64) } }, { sessionId: "a".repeat(257), request }, { sessionId: "cold-root", request, agent: {} }]) await assert.rejects(f.invoke("selectSession", args), error => ["gateway/input-invalid", "gateway/arguments-invalid"].includes(String(remoteErrorOf(error)?.code)));
    const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(f.invoke("selectSession", { sessionId: "cold-root", request }, cancelled.signal));
    assert.equal(resumes, 0); assert.deepEqual((await f.store.describe()).profiles, []); assert.equal((await f.store.loadSessionSelection("cold-root")).admissionEpoch, null);
    await assert.rejects(f.invoke("describeSession", { sessionId: "cold-root" }), refused("unavailable")); assert.equal(f.ctx.agents.get(SessionId("cold-root")), undefined);
    const child = await f.createRoot("origin-child", "subagent"); await assert.rejects(f.invoke("describeSession", { sessionId: child.id }), refused("not-owned"));
    await f.rpc.dispose();
    for (const method of ["describeSession", "selectSession"]) await assert.rejects(f.invoke(method, { sessionId: "cold-root", ...(method === "selectSession" ? { request } : {}) }), error => String(remoteErrorOf(error)?.code) === "gateway/definition-unavailable");
  } finally { await f.dispose(); }
});

test("independent owner without native Connection cannot save or select a session; public reads remain available", async () => {
  const f = await fixture(false);
  try {
    await f.createRoot("no-connection-root"); await assert.rejects(f.invoke("describeSession", { sessionId: "no-connection-root" }), refused("not-owned"));
    await assert.rejects(f.invoke("save", { request: { id: "global", content: '{"version":1,"id":"global","settings":{}}', expectedRevision: null } }), refused("not-owned"));
    assert.equal((await f.invoke<{ selectedId: string | null }>("describe", {})).selectedId, null); assert.deepEqual((await f.store.describe()).profiles, []);
  } finally { await f.dispose(); }
});

test("read-only admission projections redact private settings without changing effective configuration", async () => {
  const baseline = resolveConfig({ lsp: { command: "REVIEW_COMMAND_SENTINEL", args: ["REVIEW_ARG_SENTINEL"], cwd: "C:/private-only-fixture", env: { TOKEN: "REVIEW_SENTINEL", REVIEW_KEY_SENTINEL: "private" } }, presets: { root: "C:/private-preset-fixture" }, runtimeRecovery: { idleContinuation: { prompt: "REVIEW_PROMPT_SENTINEL" } } });
  const startup = { settings: baseline, global: {}, profile: {}, entryId: "include:dsmm", hostProfileKey: "owned", globalRevision: "absent", nativeRevision: "native",
    sources: { "lsp.env.REVIEW_KEY_SENTINEL": "profile" as const, "lsp.env.TOKEN": "global" as const } };
  const f = await fixture(true, true, baseline, { startup });
  try {
    const agent = await f.createRoot("safe-read-root"), session = await f.invoke<SessionProfileSnapshot>("describeSession", { sessionId: agent.id });
    const editor = await f.gateway.invoke({ namespace: "dsmmConfig", method: "describeSettings", args: {}, peer: f.ctx.connection.browserPeer }) as DeploymentEditorSnapshot;
    assert.equal(editor.startupSources?.["lsp.env"], "mixed");
    assert.doesNotMatch(JSON.stringify({ desired: editor.desired, startup: editor.startup, sources: editor.sources, startupSources: editor.startupSources }), /REVIEW_\w*SENTINEL|private-only-fixture|private-preset-fixture/u);
    for (const view of [session.configuration, editor.nextRoot]) { assert.ok(view); assert.doesNotMatch(JSON.stringify(view), /REVIEW_\w*SENTINEL|private-only-fixture|private-preset-fixture/u); }
    assert.equal((session.configuration!.settings.lsp as typeof baseline.lsp).command, "<configured>"); assert.deepEqual(f.runtime.getSettings(agent), baseline);
    const codec = TYPERT_REMOTE.descriptors.find(row => row.method === "describeSession")!.result; if (codec.mode !== "strict") assert.fail("strict result required");
    assert.throws(() => codec.create().parse({ ...session, configuration: { ...session.configuration, settings: baseline } }));
    assert.throws(() => codec.create().parse({ ...session, configuration: { ...session.configuration, sources: { "lsp.env.REVIEW_KEY_SENTINEL": "profile" } } }));
    const editorCodec = TYPERT_REMOTE.descriptors.find(row => row.method === "describeSettings")!.result;
    if (editorCodec.mode !== "strict") assert.fail("strict editor result required");
    assert.throws(() => editorCodec.create().parse({ ...editor, startupSources: { "lsp.env.REVIEW_KEY_SENTINEL": "profile" } }));
    await f.gateway.invoke({ namespace: "dsmmConfig", method: "save", peer: f.ctx.connection.browserPeer, args: { request: { expectedRevision: editor.globalRevision,
      edits: [{ op: "set", path: ["lsp", "env"], value: { TOKEN: "EDITOR_SENTINEL" } }] } } });
    const edited = await f.gateway.invoke({ namespace: "dsmmConfig", method: "describeSettings", args: {}, peer: f.ctx.connection.browserPeer }) as DeploymentEditorSnapshot;
    assert.deepEqual((edited.global.lsp as Record<string, unknown>).env, { TOKEN: "EDITOR_SENTINEL" });
    assert.doesNotMatch(JSON.stringify({ desired: edited.desired, startup: edited.startup, nextRoot: edited.nextRoot, sources: edited.sources, startupSources: edited.startupSources }), /EDITOR_SENTINEL|REVIEW_\w*SENTINEL|private-only-fixture|private-preset-fixture/u);
    const operator = f.ctx.connection.browserPeer, independent = f.ctx.connection.createPeer({ principal: { kind: "owner" } });
    for (const peer of [independent, { ...operator, ctx: f.ctx, async dispose() {} }]) for (const [namespace, method, args] of [["dsmmProfiles", "describeSession", { sessionId: agent.id }], ["dsmmConfig", "describeSettings", {}]] as const) {
      await assert.rejects(f.gateway.invoke({ namespace, method, args, peer }), refused("not-owned"));
    }
  } finally { await f.dispose(); }
});

test("global Gateway edits require exact operator and local/writable carrier; CAS and sparse validation preserve pointers", async () => {
  const f = await fixture(true, true);
  try {
    const invoke = (request: unknown, peer = f.ctx.connection.browserPeer) => f.gateway.invoke({ namespace: "dsmmConfig", method: "save", args: { request }, peer }) as Promise<GlobalConfigSnapshot>;
    const request = { expectedRevision: "absent", edits: [{ op: "set", path: ["defaultActive"], value: true }] }, peer = f.ctx.connection.browserPeer;
    await assert.rejects(invoke(request, { ...peer, ctx: f.ctx, async dispose() {} }), refused("not-owned"));
    f.carrier.host = "0.0.0.0"; await assert.rejects(invoke(request), refused("not-owned")); f.carrier.host = "127.0.0.1"; f.settingsAuthority.writable = false; await assert.rejects(invoke(request), refused("not-owned")); f.settingsAuthority.writable = true;
    await assert.rejects(invoke({ ...request, root: f.root }), error => String(remoteErrorOf(error)?.code) === "gateway/input-invalid");
    const pointer = await readFile(join(f.store.stateDir, ".selection.json")).catch(() => null), saved = await invoke(request); assert.equal(saved.config.defaultActive, true);
    assert.deepEqual(await readFile(join(f.store.stateDir, ".selection.json")).catch(() => null), pointer); await assert.rejects(invoke(request), refused("conflict"));
    const exact = await invoke({ expectedRevision: saved.revision, edits: [{ op: "set", path: ["workflow", "reviewCap"], value: 0 }] }); assert.equal(exact.config.defaultActive, true); assert.equal(exact.config.workflow?.reviewCap, 0);
    await assert.rejects(invoke({ expectedRevision: exact.revision, edits: [{ op: "unset", path: ["arbitraryPath"] }] }), refused("validation"));
  } finally { await f.dispose(); }
});

test("pending Core reads refuse data after operator, original connection, carrier or lifetime changes", { timeout: 20000 }, async t => {
  for (const method of ["describe", "describeSettings", "describeModules"] as const) for (const change of ["none", "operator", "owner", "service", "request", "connection", "carrier", "writability"] as const) await t.test(`${method}/${change}`, async () => {
    const f = await fixture(true, true), entered = gate(), release = gate();
    const connection = Reflect.get(f.ctx.connection, symbols.original) ?? f.ctx.connection, ownerContext = Reflect.get(connection, "ctx") as Context, operator = connection.browserPeer;
    try {
      await f.gateway.invoke({ namespace: "dsmmConfig", method: "save", peer: operator, args: { request: { expectedRevision: "absent", edits: [{ op: "set", path: ["lsp", "env"], value: { TOKEN: "PENDING_CORE_READ_SENTINEL" } }] } } });
      const authorized = await f.gateway.invoke({ namespace: "dsmmConfig", method, args: {}, peer: operator }); if (method !== "describeModules") assert.match(JSON.stringify(authorized), /PENDING_CORE_READ_SENTINEL/u);
      const read = f.deployment!.readGlobal.bind(f.deployment); f.deployment!.readGlobal = async () => { const snapshot = await read(); entered.release(); await release.promise; return snapshot; };
      const abort = new AbortController(), pending = f.gateway.invoke({ namespace: "dsmmConfig", method, args: {}, peer: operator, signal: abort.signal }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      await entered.promise;
      if (change === "operator") Reflect.set(connection, "browserPeer", f.ctx.connection.createPeer({ principal: { kind: "owner" } }));
      else if (change === "owner") ownerContext.set("connection", Object.create(Object.getPrototypeOf(connection), Object.getOwnPropertyDescriptors(connection)));
      else if (change === "service") await f.rpc.dispose(); else if (change === "request") abort.abort(); else if (change === "connection") await f.connectionFiber!.dispose(); else if (change === "carrier") f.carrier.host = "0.0.0.0"; else if (change === "writability") f.settingsAuthority.writable = false;
      release.release(); const result = await pending;
      if (change === "none") { assert.ok(result.ok); assert.deepEqual(result.value, authorized); }
      else { assert.ok(!result.ok); if (change === "request") assert.equal(remoteErrorOf(result.error)?.code, "gateway/cancelled"); else assert.ok(refused(change === "service" ? "disposed" : "not-owned")(result.error)); }
    } finally { release.release(); Reflect.set(connection, "browserPeer", operator); if (change === "owner") ownerContext.set("connection", connection); await f.dispose(); }
  });
});

test("Core save retains success when service disposal follows durable commit", async () => {
  const f = await fixture(true, true), committed = gate(), release = gate();
  try {
    const save = f.deployment!.saveGlobal.bind(f.deployment); f.deployment!.saveGlobal = async (request, authority) => { const snapshot = await save(request, authority); committed.release(); await release.promise; return snapshot; };
    const pending = f.gateway.invoke({ namespace: "dsmmConfig", method: "save", peer: f.ctx.connection.browserPeer, args: { request: { expectedRevision: "absent", edits: [{ op: "set", path: ["defaultActive"], value: true }] } } });
    await committed.promise; const durable = await f.deployment!.readGlobal(); assert.equal(durable.config.defaultActive, true); await f.rpc.dispose(); release.release(); assert.deepEqual(await pending, durable);
  } finally { release.release(); await f.dispose(); }
});
