import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mock, test } from "node:test";
import * as Cordis from "@deepseek-ai/cordis";
import { Context } from "@deepseek-ai/cordis";
import type { ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import type {} from "@deepseek-ai/dsh-api-gateway/client";
import * as NativeConnection from "@deepseek-ai/dsh-client-connection";
import { LlmError, LlmRuntime, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { LlmResolvedModelInfo } from "@deepseek-ai/dsh-llm";
import { remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { build } from "esbuild";
import type { DshAgent } from "../src/dsh-types.ts";
import type { DsmmProfilesRemote } from "../src/profile-remote.ts";
import type { DsmmProfileRuntime } from "../src/profile-runtime.ts";
import { ProfileStore } from "../src/profile-store.ts";
import type { ProfileSnapshot } from "../src/profile-types.ts";
import type { DsmmProfileOverlay } from "../src/profiles.ts";
import type { DsmmPluginConfig } from "../src/settings.ts";
import "./profile-apply-source-loader.mjs";

const { RoutingFixtureAdapter, nativeFixturePlugin, nativeRoutingFixture, runFixtureTurn, headerRoutes } = await import("./native-routing-fixture.ts");

const require = createRequire(import.meta.url);
const nativeRequire = createRequire(require.resolve("@deepseek-ai/dsh-client-connection/package.json"));
const { CredentialProvider } = nativeRequire("@deepseek-ai/dsh-credentials");

class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<string, unknown>();
  async modifyRecord(key: string, modify: (value: unknown) => Promise<unknown>) {
    const value = await modify(this.records.get(key));
    if (value !== undefined) this.records.set(key, value);
    return this.records.get(key);
  }
}

/** Finite provider/model metadata; no unlisted route is considered available. */
class CatalogAdapter extends RoutingFixtureAdapter {
  beforeResolve?: (provider: string, model: string) => Promise<void>;
  readonly resolutions: Array<{ provider: string; model: string; code?: string }> = [];
  readonly catalog = new Map([
    ["fixture/native-default", ["low", "high"]],
    ["fixture/profile-a", ["high"]],
    ["fixture/profile-b", ["low", "high"]],
  ]);
  override async listModels(provider: string) {
    return Promise.all([...this.catalog.keys()].filter(key => key.startsWith(`${provider}/`))
      .map(key => this.resolveModel(provider, key.slice(provider.length + 1))));
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.beforeResolve?.(provider, model);
    const efforts = this.catalog.get(`${provider}/${model}`);
    this.resolutions.push({ provider, model, ...(efforts === undefined ? { code: "UNKNOWN_MODEL" } : {}) });
    if (efforts === undefined) throw new LlmError("Unlisted fixture route", "UNKNOWN_MODEL");
    return { provider, id: model, name: model, inputModalities: ["text"],
      reasoning: { efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })), defaultEffort: ReasoningEffortId("high") } };
  }
}

async function fixture(config: DsmmPluginConfig = {}) {
  const adapter = new CatalogAdapter();
  const metadataFailures: Array<{ code?: string; provider: string; model: string; reasoningEffort?: string }> = [];
  const metadataCalls: Array<{ provider: string; model: string; reasoningEffort?: string }> = [];
  const native = await nativeRoutingFixture(config, { adapter, headless: true, persistence: true,
    nativeFs: true, nativePermissionSettings: true });
  const resolve = LlmRuntime.prototype.resolveCallConfig;
  const observation = mock.method(LlmRuntime.prototype, "resolveCallConfig", async function (this: LlmRuntime, ...args: Parameters<typeof resolve>) {
    metadataCalls.push({ ...args[0] });
    try { return await resolve.apply(this, args); }
    catch (error) {
      metadataFailures.push({ provider: args[0].provider, model: args[0].model, reasoningEffort: args[0].reasoningEffort,
        code: error instanceof LlmError ? error.code : undefined });
      throw error;
    }
  });
  const client = new Context();
  try {
    const { WebServer } = await nativeFixturePlugin("@deepseek-ai/dsh-host-webserver", "@deepseek-ai/dsh-web-app");
    await native.ctx.plugin(WebServer, { host: "127.0.0.1", port: 0 }).await();
    assert.equal(native.ctx.settings.writable, true);
    await Promise.all([native.ctx.plugin(TypertRegistry).await(), native.ctx.plugin(TypertGatewayService, {}).await(), client.plugin(TypertRegistry).await()]);
    await native.ctx.plugin(MemoryCredentials).await();
    const remoteAccess = await nativeFixturePlugin("@deepseek-ai/dsh-api-remote-access");
    await native.ctx.plugin(remoteAccess.default).await();
    await native.ctx.plugin(NativeConnection).await();
    const gateway = native.ctx.typertGateway;
    gateway.registerRemoteEvents(async function* (signal) {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    }, { home: "isolated-profile-apply" });
    const realm = createContext({ crypto: globalThis.crypto, AbortController, AbortSignal, URL, TextEncoder, TextDecoder,
      setTimeout, clearTimeout, queueMicrotask, console });
    const clone = runInContext("value => JSON.parse(value)", realm) as (value: string) => unknown;
    async function loadClient(packageName: string) {
      let factory: ((require: (id: string) => unknown) => any) | undefined;
      realm.window = { __ModuleLoader__: { load(row: { factory: typeof factory }) { factory = row.factory; } } };
      const manifestPath = require.resolve(`${packageName}/package.json`);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const clientExport = manifest.exports["./client"];
      const entry = typeof clientExport === "string" ? clientExport : clientExport.browser ?? clientExport.default;
      runInContext(await readFile(join(dirname(manifestPath), entry), "utf8"), realm);
      delete realm.window;
      assert.ok(factory);
      return factory(id => { assert.equal(id, "@deepseek-ai/cordis"); return Cordis; });
    }
    const connection = await loadClient("@deepseek-ai/dsh-client-connection");
    connection.installConnection(client, { transport: { ownsHost: true, rpc: {
      async call(channel: string, endpoint: string, payload: { args: Record<string, unknown> }, signal: AbortSignal) {
        assert.equal(channel, "/api");
        const [namespace, method] = endpoint.split("/");
        try {
          const value = await gateway.invoke({ namespace, method, args: JSON.parse(JSON.stringify(payload.args)), peer: native.ctx.connection.browserPeer, signal });
          return clone(JSON.stringify({ ok: true, value }));
        } catch (error) {
          const failure = remoteErrorOf(error);
          if (failure === undefined) throw error;
          return clone(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message, details: failure.details } }));
        }
      },
      async *open(channel: string, endpoint: string, payload: unknown, signal: AbortSignal, uplink?: AsyncIterable<unknown>) {
        assert.equal(channel, "/api");
        yield* await gateway.wireStream.open(endpoint, payload, uplink ?? (async function* () {})(), native.ctx.connection.browserPeer, signal);
      },
    } } });
    await client.plugin(await loadClient("@deepseek-ai/dsh-api-gateway")).await();
    const codecs = await build({ entryPoints: [fileURLToPath(new URL("../src/profile-remote.ts", import.meta.url))],
      bundle: true, write: false, format: "iife", globalName: "DsmmCodec", platform: "browser" });
    runInContext(codecs.outputFiles[0].text, realm);
    await client.remote.$mount(realm.DsmmCodec.TYPERT_REMOTE);
    const remote = client.remote.dsmmProfiles as DsmmProfilesRemote;
    const runtime = native.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    assert.ok(runtime);
    const preset = await native.ctx.get("agentPresets")!.resolve("dsmm-orchestrator");
    assert.equal(preset.broken, undefined);
    const store = ProfileStore.fromCentral(native.home, native.profileDir, runtime.admission().deployment!.entryId);
    return { native, adapter, runtime, remote, clone, store, metadataFailures, metadataCalls,
      async dispose() { observation.mock.restore(); await client.fiber.dispose(); await native.dispose(); } };
  } catch (error) { observation.mock.restore(); await client.fiber.dispose(); await native.dispose(); throw error; }
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

test("finite native Gateway and cross-VM strict client save/read raw route JSON and preserve route metadata without completion", async () => {
  const parameters = { temperature: 0, maxTokens: 1, stop: [], custom_flag: false, custom_zero: 0, custom_null: null,
    custom_nested: { rows: [false, 0, null, {}, []] }, customParameters: { original_name: "data" } };
  const primary = { provider: "fixture", model: "profile-a", ...parameters };
  const f = await fixture({ defaultActive: true, roleRouting: { "dsmm-orchestrator": { primary } } });
  try {
    const settings = { modelParameters: { passthrough: false }, roleRouting: { "dsmm-reviewer": { primary: { ...primary, reasoningEffort: "medium" },
      fallbackRoutes: [{ ...primary, custom_flag: true }, primary] } } };
    const saved = await save(f, "raw-route-data", settings);
    const read = value(await f.remote.read(saved.id));
    assert.deepEqual(JSON.parse(read.content).settings, settings);
    assert.equal((await ProfileStore.fromCentral(f.native.home, f.native.profileDir, f.runtime.admission().deployment!.entryId).read(saved.id)).content, saved.content);
    const root = await f.native.create({ agentPreset: "standard" });
    const snapshot = value(await f.remote.describeSession(root.id));
    const routing = snapshot.configuration!.settings.roleRouting as { "dsmm-orchestrator": { primary: unknown } };
    assert.deepEqual(JSON.parse(JSON.stringify(routing["dsmm-orchestrator"].primary)), primary);
    assert.deepEqual(f.runtime.admission(root as unknown as DshAgent).settings.roleRouting["dsmm-orchestrator"]!.primary, primary);
    assert.equal(f.adapter.calls.length, 0);
  } finally { await f.dispose(); }
});

function overlay(model: string): DsmmProfileOverlay {
  return { workflow: { reviewCap: model === "profile-a" ? 1 : 4 },
    roleRouting: { "dsmm-reviewer": { primary: { provider: "fixture", model, reasoningEffort: "high" } } } };
}

async function save(f: Awaited<ReturnType<typeof fixture>>, id: string, settings: DsmmProfileOverlay) {
  return value(await f.remote.save(f.clone(JSON.stringify({ id, expectedRevision: null,
    content: JSON.stringify({ version: 1, id, settings }) })) as Parameters<DsmmProfilesRemote["save"]>[0]));
}

async function select(f: Awaited<ReturnType<typeof fixture>>, id: string, revision: string): Promise<ProfileSnapshot> {
  const before = value(await f.remote.describe());
  return value(await f.remote.select(f.clone(JSON.stringify({ id, expectedRevision: revision,
    expectedSelectionRevision: before.selectionRevision })) as Parameters<DsmmProfilesRemote["select"]>[0]));
}

test("finite native catalog and cross-VM RPC keep future defaults independent from explicit blank choices", async () => {
  const f = await fixture();
  try {
    const a = await save(f, "a", overlay("profile-a"));
    const b = await save(f, "b", { ...overlay("profile-b"), modelParameters: { passthrough: false } });
    assert.equal(f.native.agents.list().length, 0);
    assert.equal((await select(f, "a", a.revision)).selectedId, "a");
    const oldRoot = await f.native.create({ agentPreset: "standard" });
    assert.equal(oldRoot.status, "idle");
    const nativeChoice = structuredClone(oldRoot.options);
    const oldAdmission = f.runtime.admission(oldRoot as unknown as DshAgent);
    assert.equal((await select(f, "b", b.revision)).selectedId, "b");
    const newRoot = await f.native.create({ agentPreset: "standard" });
    assert.equal(f.runtime.admission(oldRoot as unknown as DshAgent), oldAdmission);
    assert.equal(oldAdmission.profile?.id, "a");
    assert.equal(f.runtime.admission(newRoot as unknown as DshAgent).profile?.id, "b");
    const before = value(await f.remote.describeSession(oldRoot.id));
    assert.equal(before.canApplyOverlay, true);
    const selected = value(await f.remote.selectSession(oldRoot.id, { sessionId: oldRoot.id, id: b.id, expectedRevision: b.revision,
      expectedSelectionRevision: before.selection.selectionRevision, expectedAdmissionEpoch: before.admissionEpoch }));
    assert.equal(selected.admittedSelection?.selectedId, b.id);
    assert.equal(selected.scope, "session-override");
    assert.notEqual(f.runtime.admission(oldRoot as unknown as DshAgent), oldAdmission);
    assert.equal(oldAdmission.settings.modelParameters.passthrough, true);
    assert.equal(value(await f.remote.describeSession(newRoot.id)).configuration!.modelParameterPolicy?.mode, "native-defaults");
    assert.deepEqual(JSON.parse(JSON.stringify(value(await f.remote.describeSession(newRoot.id)).configuration!.settings.modelParameters)), { passthrough: false });
    assert.equal(f.metadataCalls.length, 0);
    assert.deepEqual(oldRoot.options, nativeChoice);
    assert.equal(f.adapter.resolutions.length, 0);
    assert.equal(f.adapter.calls.length, 0);
  } finally { await f.dispose(); }
});

test("Use profile model remains an independent capability while manual native model intent and operator authority stay separate", async () => {
  const primary = { provider: "fixture", model: "profile-a", reasoningEffort: "high" };
  const f = await fixture({ defaultActive: true, roleRouting: { "dsmm-orchestrator": { primary } } });
  try {
    const selection: ModelSelectionRef = { current: { provider: "fixture", model: "native-default" }, assembled: undefined };
    const root = await f.native.create({ agentPreset: "dsmm-orchestrator" }, selection);
    const admission = f.runtime.admission(root as unknown as DshAgent);
    const before = value(await f.remote.describeSession(root.id));
    assert.equal(before.canSelectModel, true);
    assert.deepEqual(JSON.parse(JSON.stringify(before.profileModel)), primary);
    assert.equal(before.canApplyOverlay, true);
    assert.equal(before.applyOverlayUnavailableReason, undefined);
    // Native public selection and durable intent seams, not a replacement Models SDK.
    for (const route of [primary, { provider: "fixture", model: "profile-b", reasoningEffort: "low" }]) {
      const resolved = await f.native.ctx.llm.resolveCallConfig({ ...route, reasoningEffort: ReasoningEffortId(route.reasoningEffort) });
      selection.current = { provider: resolved.provider, model: resolved.model, reasoningEffort: resolved.reasoningEffort };
      root.session.append("model/selection", selection.current);
      await runFixtureTurn(root);
    }
    assert.deepEqual(headerRoutes(root).map(({ model }) => model), ["profile-a", "profile-b"]);
    assert.equal(f.runtime.admission(root as unknown as DshAgent), admission);
    assert.deepEqual(JSON.parse(JSON.stringify(value(await f.remote.describeSession(root.id)).profileModel)), primary);
    const otherPeer = f.native.ctx.connection.createPeer({ principal: { kind: "owner" } });
    try {
      await assert.rejects(f.native.ctx.typertGateway.invoke({ namespace: "dsmmProfiles", method: "save", peer: otherPeer,
        args: { request: { id: "profile-b", expectedRevision: null, content: JSON.stringify({ version: 1, id: "profile-b", settings: {} }) } } }), error => {
        const failure = remoteErrorOf(error);
        return failure?.code === "dsmm-profiles/refused" && failure.details.code === "not-owned";
      });
      assert.equal((await f.store.describe()).profiles.some(profile => profile.id === "profile-b"), false);
    } finally { await otherPeer.dispose(); }
  } finally { await f.dispose(); }
});

test("cross-VM future-session defaults preserve unknown provider/model and unadvertised effort without metadata I/O", async () => {
  const f = await fixture();
  try {
    const a = await save(f, "a", overlay("profile-a"));
    await select(f, "a", a.revision);
    const root = await f.native.create({ agentPreset: "standard" });
    for (const [id, route] of [
      ["provider", { provider: "unregistered", model: "profile-b", reasoningEffort: "high" }],
      ["model", { provider: "fixture", model: "unlisted", reasoningEffort: "high" }],
      ["effort", { provider: "fixture", model: "profile-a", reasoningEffort: "max" }],
    ] as const) {
      const draft = await save(f, id, { roleRouting: { "dsmm-reviewer": { primary: route } } });
      const admitted = f.runtime.admission(root as unknown as DshAgent);
      await select(f, id, draft.revision);
      assert.deepEqual(f.runtime.admission().settings.roleRouting["dsmm-reviewer"]?.primary, route);
      const fresh = await f.native.create({ agentPreset: "standard" });
      assert.deepEqual(f.runtime.admission(fresh as unknown as DshAgent).settings.roleRouting["dsmm-reviewer"]?.primary, route);
      assert.equal(f.runtime.admission(root as unknown as DshAgent), admitted);
      assert.equal(f.metadataCalls.length, 0);
      assert.equal(f.metadataFailures.length, 0);
    }
  } finally { await f.dispose(); }
});

test("documenting baseline and named overlay retain exact routes independently without metadata I/O", async () => {
  const baselineRoute = { provider: "fixture", model: "profile-b", reasoningEffort: "low" };
  const overlayRoute = { provider: "fixture", model: "profile-a", reasoningEffort: "high" };
  const f = await fixture({ roleRouting: { "dsmm-documenting": { primary: baselineRoute } } });
  try {
    assert.deepEqual(f.runtime.admission().settings.roleRouting["dsmm-documenting"]?.primary, baselineRoute);
    const inherited = await save(f, "inherited-doc", {});
    const overridden = await save(f, "overridden-doc", { roleRouting: { "dsmm-documenting": { primary: overlayRoute } } });
    await select(f, inherited.id, inherited.revision);
    assert.equal(f.metadataCalls.length, 0);
    const root = await f.native.create({ agentPreset: "standard" });
    const oldAdmission = f.runtime.admission(root as unknown as DshAgent);
    f.metadataCalls.length = 0;
    await select(f, overridden.id, overridden.revision);
    assert.deepEqual(f.runtime.admission().settings.roleRouting["dsmm-documenting"]?.primary, overlayRoute);
    assert.equal(f.metadataCalls.length, 0);
    assert.equal(f.metadataCalls.some(route => route.model === baselineRoute.model), false);
    assert.equal(f.runtime.admission(root as unknown as DshAgent), oldAdmission);
    const overriddenRoot = await f.native.create({ agentPreset: "standard" });
    assert.deepEqual(f.runtime.admission(overriddenRoot as unknown as DshAgent).settings.roleRouting["dsmm-documenting"]?.primary, overlayRoute);
    assert.equal(f.metadataCalls.length, 0);
    assert.equal(f.metadataCalls.some(route => route.model === baselineRoute.model), false);
    const omittedRoute = { provider: "fixture", model: "profile-a" };
    const omitted = await save(f, "omitted-doc", { roleRouting: { "dsmm-documenting": { primary: omittedRoute } } });
    f.metadataCalls.length = 0;
    await select(f, omitted.id, omitted.revision);
    assert.deepEqual(f.runtime.admission().settings.roleRouting["dsmm-documenting"]?.primary, omittedRoute);
    assert.equal(f.metadataCalls.length, 0);
    const omittedRoot = await f.native.create({ agentPreset: "standard" });
    assert.deepEqual(f.runtime.admission(omittedRoot as unknown as DshAgent).settings.roleRouting["dsmm-documenting"]?.primary, omittedRoute);
    assert.equal(f.runtime.admission(root as unknown as DshAgent), oldAdmission);
    assert.equal(f.metadataCalls.length, 0);
    assert.equal(f.adapter.calls.length, 0);
  } finally { await f.dispose(); }
});

test("documenting role toggles preserve configured effort for future roots without model validation", async () => {
  const f = await fixture({ roleRouting: { "dsmm-documenting": { primary: { provider: "fixture", model: "profile-a", reasoningEffort: "max" } } } });
  try {
    const draft = await save(f, "disabled-doc", { roles: { "dsmm-documenting": false } });
    await select(f, draft.id, draft.revision);
    assert.equal(f.runtime.admission().settings.roles["dsmm-documenting"], false);
    assert.equal(f.metadataCalls.some(route => route.model === "profile-a"), false);
    const root = await f.native.create({ agentPreset: "standard" });
    f.metadataCalls.length = 0;
    assert.equal(f.runtime.admission(root as unknown as DshAgent).settings.roles["dsmm-documenting"], false);
    assert.equal(f.metadataCalls.some(route => route.model === "profile-a"), false);
    assert.equal(f.metadataFailures.length, 0);
    const enabled = await save(f, "enabled-doc", {});
    const admitted = f.runtime.admission(root as unknown as DshAgent);
    await select(f, enabled.id, enabled.revision);
    const fresh = await f.native.create({ agentPreset: "standard" });
    assert.equal(f.runtime.admission(fresh as unknown as DshAgent).settings.roles["dsmm-documenting"], true);
    assert.equal(f.runtime.admission(fresh as unknown as DshAgent).settings.roleRouting["dsmm-documenting"]?.primary?.reasoningEffort, "max");
    assert.equal(f.metadataFailures.length, 0);
    assert.equal(f.metadataCalls.length, 0);
    assert.equal((await f.store.loadSelection()).selectedId, enabled.id);
    assert.equal(f.runtime.admission(root as unknown as DshAgent), admitted);
  } finally { await f.dispose(); }
});

test("enabled documenting preserves unresolved future-session routes without consulting the model owner", async () => {
  const f = await fixture();
  try {
    const root = await f.native.create({ agentPreset: "standard" });
    for (const [id, route] of [
      ["doc-provider", { provider: "unregistered", model: "profile-b", reasoningEffort: "low" }],
      ["doc-model", { provider: "fixture", model: "unlisted-doc", reasoningEffort: "high" }],
      ["doc-effort", { provider: "fixture", model: "profile-a", reasoningEffort: "max" }],
    ] as const) {
      const draft = await save(f, id, { roleRouting: { "dsmm-documenting": { primary: route } } });
      const admitted = f.runtime.admission(root as unknown as DshAgent);
      await select(f, id, draft.revision);
      const fresh = await f.native.create({ agentPreset: "standard" });
      assert.deepEqual(f.runtime.admission(fresh as unknown as DshAgent).settings.roleRouting["dsmm-documenting"]?.primary, route);
      assert.equal(f.runtime.admission(root as unknown as DshAgent), admitted);
      assert.equal(f.metadataFailures.length, 0);
      assert.equal(f.metadataCalls.length, 0);
    }
    assert.equal(f.adapter.calls.length, 0);
  } finally { await f.dispose(); }
});

test("documenting defaults preserve ordered unresolved primary and fallback parameters", async () => {
  const f = await fixture();
  try {
    const primary = { provider: "fixture", model: "unlisted-doc", reasoningEffort: "high" };
    const fallback = { provider: "fixture", model: "profile-a", reasoningEffort: "high" };
    const available = await save(f, "doc-fallback", { roleRouting: { "dsmm-documenting": { primary, fallbackRoutes: [fallback] } } });
    await select(f, available.id, available.revision);
    const root = await f.native.create({ agentPreset: "standard" });
    const admitted = f.runtime.admission(root as unknown as DshAgent);
    const invalidFallback = { ...fallback, reasoningEffort: "max" };
    const invalid = await save(f, "doc-invalid-fallback", { roleRouting: { "dsmm-documenting": { primary, fallbackRoutes: [invalidFallback] } } });
    await select(f, invalid.id, invalid.revision);
    const fresh = await f.native.create({ agentPreset: "standard" });
    assert.deepEqual(f.runtime.admission(fresh as unknown as DshAgent).settings.roleRouting["dsmm-documenting"], { primary, fallbackRoutes: [invalidFallback] });
    assert.deepEqual(admitted.settings.roleRouting["dsmm-documenting"], { primary, fallbackRoutes: [fallback] });
    assert.equal(f.runtime.admission(root as unknown as DshAgent), admitted);
    assert.equal(f.metadataFailures.length, 0);
    assert.equal(f.metadataCalls.length, 0);
  } finally { await f.dispose(); }
});

const documentingChain = {
  primary: { provider: "apai", model: "gpt-6.1-sol", reasoningEffort: "medium" },
  fallbackRoutes: [
    { provider: "apai", model: "gpt-5.6-terra", reasoningEffort: "high" },
    { provider: "apai", model: "gpt-5.6-luna", reasoningEffort: "high" },
  ],
};

async function installedPiAdapter() {
  // The installed adapter shares the fixture's native peer/error identity.
  const llm = pathToFileURL(require.resolve("@deepseek-ai/dsh-llm")).href;
  const peers = registerHooks({ resolve(specifier, context, next) {
    return specifier === "@deepseek-ai/dsh-llm" ? { url: llm, shortCircuit: true } : next(specifier, context);
  } });
  try { return await nativeFixturePlugin("@deepseek-ai/dsh-llm-pi-ai"); }
  finally { peers.deregister(); }
}

test("installed PiAiAdapter metadata does not gate Apply or normalize requested effort and routes", async t => {
  const pi = await installedPiAdapter();
  for (const scenario of ["unregistered", "undeclared-efforts", "high-only", "missing-primary", "declared-efforts"] as const) {
    await t.test(scenario, async () => {
      const f = await fixture();
      const network = mock.method(globalThis, "fetch", async () => { throw new Error("Metadata Apply must not access a network"); });
      const completion = mock.method(pi.PiAiAdapter.prototype, "stream", () => { throw new Error("Metadata Apply must not request completion"); });
      try {
        const allModels = [documentingChain.primary, ...documentingChain.fallbackRoutes].map(route => ({ id: route.model }));
        const models = scenario === "undeclared-efforts" ? allModels
          : allModels.filter(model => scenario !== "missing-primary" || model.id !== documentingChain.primary.model)
            .map(model => ({ ...model, reasoningEfforts: scenario === "declared-efforts" && model.id === documentingChain.primary.model
              ? { medium: "medium", high: "high" } : { high: "high" } }));
        if (scenario !== "unregistered") {
          await f.native.ctx.plugin(pi, { providers: { apai: { api: "openai-responses", baseURL: "https://metadata-only.invalid/v1", models } } }).await();
        }
        const nativeLlm = f.native.ctx.get("llm")!;
        if (scenario !== "unregistered" && scenario !== "missing-primary") {
          const info = await nativeLlm.resolveModelInfo("apai", documentingChain.primary.model);
          assert.equal(info.reasoning?.efforts.some(effort => effort.id === "medium") ?? false, scenario === "declared-efforts");
        }
        const draft = await save(f, "apai-doc", { roleRouting: { "dsmm-documenting": documentingChain } });
        const beforeGlobal = value(await f.remote.describe());
        assert.equal(beforeGlobal.roles?.find(role => role.id === "dsmm-documenting")?.enabled, true);
        f.metadataCalls.length = 0;
        f.metadataFailures.length = 0;
        value(await f.remote.select({ id: draft.id, expectedRevision: draft.revision, expectedSelectionRevision: beforeGlobal.selectionRevision }));
        const root = await f.native.create({ agentPreset: "standard" });
        assert.deepEqual(f.metadataFailures, []);
        assert.deepEqual(f.metadataCalls, []);
        assert.deepEqual(f.runtime.admission().settings.roleRouting["dsmm-documenting"], documentingChain);
        assert.deepEqual(f.runtime.admission(root as unknown as DshAgent).settings.roleRouting["dsmm-documenting"], documentingChain);
        assert.equal(network.mock.callCount(), 0);
        assert.equal(completion.mock.callCount(), 0);
        assert.equal(f.adapter.calls.length, 0);
      } finally {
        network.mock.restore(); completion.mock.restore();
        await f.dispose();
      }
    });
  }
});
