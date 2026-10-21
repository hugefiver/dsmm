import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context, symbols } from "@deepseek-ai/cordis";
import type { Service } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import * as NativeConnection from "@deepseek-ai/dsh-client-connection";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { DsmmDeploymentConfig } from "../src/deployment-config.ts";
import type { GlobalConfigSnapshot } from "../src/deployment-config.ts";
import { DeploymentPermissionRules } from "../src/deployment-permission-rules.ts";
import type { DshAgent, DshContext } from "../src/dsh-types.ts";
import { DSMM_MODULE_DESCRIPTORS, projectDeepworkModule, projectDsmmModules } from "../src/modules.ts";
import type { DsmmModuleState } from "../src/modules.ts";
import { installPermissionController } from "../src/permission-controller.ts";
import { PermissionRefusal } from "../src/permission-control.ts";
import { TYPERT_REMOTE } from "../src/profile-remote.ts";
import { DsmmProfilesHost, registerConfigRpc } from "../src/profile-rpc.ts";
import { DsmmProfileRuntime } from "../src/profile-runtime.ts";
import { ProfileStore } from "../src/profile-store.ts";
import type { DeploymentEditorSnapshot, SessionProfileSnapshot } from "../src/profile-types.ts";
import type { DsmmPluginConfig } from "../src/settings.ts";

const require = createRequire(import.meta.url);
const sdk = createRequire(require.resolve("@deepseek-ai/dsh-client-connection/package.json"));
const { CredentialProvider } = sdk("@deepseek-ai/dsh-credentials") as { CredentialProvider: new (ctx: Context) => Service };
class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<string, unknown>();
  async modifyRecord(key: string, change: (value: unknown) => Promise<unknown>): Promise<unknown> {
    const next = await change(this.records.get(key));
    if (next !== undefined) this.records.set(key, next);
    return this.records.get(key);
  }
}

function permission(modules: DsmmModuleState[]): DsmmModuleState {
  assert.deepEqual(modules.map(row => row.descriptor.id), ["deepwork", "permission-control"]);
  return modules[1]!;
}

async function fixture(profile: DsmmPluginConfig = {}, initialEnabled?: boolean, home?: string) {
  const root = home ?? await mkdtemp(join(tmpdir(), "dsmm-module-rpc-")), ctx = new Context();
  try {
    const native = createRequire(process.env.DSMM_TEST_DSH_ENTRY ?? new URL("../package.json", import.meta.url));
    const { RemoteAccessService } = native("@deepseek-ai/dsh-api-remote-access");
    await ctx.plugin(RemoteAccessService).await();
    await Promise.all([ctx.plugin(AgentRegistry).await(), ctx.plugin(TypertRegistry).await(),
      ctx.plugin(TypertGatewayService, {}).await(), ctx.plugin(SystemPrompt, {}).await()]);
    await ctx.plugin(MemoryCredentials).await();
    await ctx.plugin(NativeConnection).await();
    ctx.provide("profileContext", { home: root, dir: root });
    // Unit-test Host boundary: one owned entry and an explicitly mutable form descriptor.
    const nativeDescriptor = { ns: "dsmm", revision: 0 };
    ctx.fiber.entry = { id: "include:dsmm", options: { id: nativeDescriptor.ns, config: profile }, fiber: ctx.fiber } as Context["fiber"]["entry"];
    ctx.provide("webServer", { host: "127.0.0.1" });
    ctx.provide("settings", { writable: true, describe: () => [{ ...nativeDescriptor }] });
    const deployment = new DsmmDeploymentConfig(ctx as unknown as DshContext, profile);
    if (initialEnabled !== undefined) await deployment.saveGlobal({ expectedRevision: "absent", edits: [
      { op: "set", path: ["permissionControl", "enabled"], value: initialEnabled }
    ] }, () => {});
    const startup = await deployment.readDesired();
    let rules!: DeploymentPermissionRules;
    const controllerFiber = ctx.plugin({ name: "module-projection-controller", inject: ["systemPrompt", "agents"], apply(scope: Context) {
      new ToolRuntime(scope, { mode: "native", maxParallelSubCalls: 3 });
      rules = new DeploymentPermissionRules(scope, { deployment, assertWritable() { throw new PermissionRefusal("unavailable"); },
        revoke: () => scope.get("dsmmPermissionController")?.permissions.revokePolicy(), notify: async () => {} });
      installPermissionController(scope, { rules: rules.runtime,
        // This read-only fixture never supplies tool execution/approval authority.
        authority: { current() { throw new PermissionRefusal("unavailable"); }, assertCurrent() { throw new PermissionRefusal("unavailable"); } },
        shellIdentity(_scope, kind) { return { executable: kind, dialect: kind === "bash" ? "posix" : "powershell", commandField: "command", cwdField: "workdir" }; }
      });
    } });
    await controllerFiber.await();
    const installed = ctx.get("dsmmPermissionController")!;
    let controllerLive = true;
    controllerFiber.ctx.effect(() => () => { controllerLive = false; });
    const getMountedPermission = (): boolean | null => {
      const current = ctx.get("dsmmPermissionController");
      if (!controllerLive || current === undefined || Reflect.get(current, symbols.original) !== Reflect.get(installed, symbols.original)) return null;
      return current.rules.status().mounted;
    };
    const store = new ProfileStore(join(root, "dsmm-profiles"));
    const runtime = new DsmmProfileRuntime(ctx as unknown as DshContext, startup.settings, store, {
      startup, readDesired: () => deployment.readDesired(), getMountedPermission
    });
    await runtime.initialize();
    const rpc = ctx.plugin({ name: "module-projection-rpc", inject: ["typert"], apply(scope: Context) {
      new DsmmProfilesHost(scope, runtime);
      registerConfigRpc(scope, deployment, startup.settings, () => runtime, startup.sources, getMountedPermission);
    } });
    await rpc.await();
    const config = <T>(method: string, args: Record<string, unknown> = {}) => ctx.typertGateway.invoke({ namespace: "dsmmConfig", method, args, peer: ctx.connection.browserPeer }) as Promise<T>;
    const profiles = <T>(method: string, args: Record<string, unknown>) => ctx.typertGateway.invoke({ namespace: "dsmmProfiles", method, args, peer: ctx.connection.browserPeer }) as Promise<T>;
    let sequence = 0;
    const createRoot = async () => {
      const session = Session.create(SessionId(`module-root-${++sequence}`));
      const agent: DshAgent = { id: session.id, session: session as unknown as DshAgent["session"], ctx: ctx as unknown as DshContext,
        status: "idle", runMaintenance: task => task(new AbortController().signal) };
      await ctx.agents.register(agent as unknown as Agent);
      const candidate = await runtime.prepareRoot(agent, new AbortController().signal);
      runtime.publish(agent, candidate);
      return agent;
    };
    return { root, ctx, nativeDescriptor, startup, runtime, deployment, rules, controllerFiber, config, profiles, createRoot,
      async dispose() { await ctx.fiber.dispose(); if (home === undefined) await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await ctx.fiber.dispose(); if (home === undefined) await rm(root, { recursive: true, force: true }); throw error; }
}

test("native Gateway and Host module collections preserve all four startup-pinned permission transitions", async (t) => {
  for (const startupEnabled of [false, true]) for (const desiredEnabled of [false, true]) {
    await t.test(`${startupEnabled} -> ${desiredEnabled}`, async () => {
      const f = await fixture({}, startupEnabled);
      try {
        const old = await f.createRoot(), oldAdmission = f.runtime.admission(old);
        const global = await f.config<GlobalConfigSnapshot>("describe");
        await f.config("save", { request: { expectedRevision: global.revision, edits: [
          { op: "set", path: ["permissionControl", "enabled"], value: desiredEnabled }
        ] } });
        const editor = await f.config<DeploymentEditorSnapshot>("describeSettings");
        const modules = await f.config<DsmmModuleState[]>("describeModules");
        assert.deepEqual(modules, editor.modules);
        const state = permission(modules);
        assert.equal(state.desired.enabled, desiredEnabled); assert.equal(state.desired.source, "global");
        assert.equal(state.desired.capture, "current-global"); assert.equal(state.startupMounted, startupEnabled);
        assert.equal(state.admitted, null); assert.equal(state.nextRoot.admitted, startupEnabled);
        assert.equal(state.pending, startupEnabled !== desiredEnabled);
        assert.equal(state.reason, startupEnabled === desiredEnabled ? null : "restart-required");
        assert.equal(state.nextRoot.reason, state.reason);
        assert.equal(f.runtime.admission(old), oldAdmission);
        const oldView = await f.profiles<SessionProfileSnapshot>("describeSession", { sessionId: old.id });
        assert.equal(permission(oldView.modules!).desired.enabled, startupEnabled);
        assert.equal(permission(oldView.modules!).admitted, startupEnabled);
        const agent = await f.createRoot(), admission = f.runtime.admission(agent);
        const described = await f.profiles<SessionProfileSnapshot>("describeSession", { sessionId: agent.id });
        assert.deepEqual(described.modules, f.runtime.getSettings.moduleStates!(agent));
        assert.equal(permission(described.modules!).admitted, startupEnabled);
        assert.equal(permission(described.modules!).desired.enabled, desiredEnabled);
        assert.equal(admission.settings.permissionControl.enabled, startupEnabled);
        assert.equal(admission.restartRequired!.includes("permissionControl.enabled"), startupEnabled !== desiredEnabled);
        assert.equal(f.runtime.getSettings(agent).permissionControl.enabled, startupEnabled);
        assert.equal(f.runtime.admission(old), oldAdmission);
        assert.equal(oldAdmission.settings.permissionControl.enabled, startupEnabled);
        assert.deepEqual(modules[0], projectDeepworkModule(f.startup.settings, await f.deployment.readDesired(), undefined, true));
      } finally { await f.dispose(); }
    });
  }
});

test("permission module source follows default/global/profile deployment provenance; cold desired-ON stays OFF", async () => {
  for (const profile of [{}, { permissionControl: { enabled: false } }] satisfies DsmmPluginConfig[]) {
    const f = await fixture(profile);
    try {
      const before = permission(await f.config<DsmmModuleState[]>("describeModules"));
      assert.equal(before.desired.source, profile.permissionControl === undefined ? "defaults" : "profile");
      const initial = await f.config<GlobalConfigSnapshot>("describe");
      await f.config("save", { request: { expectedRevision: initial.revision, edits: [
        { op: "set", path: ["permissionControl", "enabled"], value: true }
      ] } });
      const after = permission(await f.config<DsmmModuleState[]>("describeModules"));
      assert.equal(after.desired.source, profile.permissionControl === undefined ? "global" : "profile");
      assert.equal(after.desired.enabled, profile.permissionControl === undefined);
      assert.equal(after.startupMounted, before.startupMounted);
      const agent = await f.createRoot();
      const session = await f.profiles<SessionProfileSnapshot>("describeSession", { sessionId: agent.id });
      assert.equal(permission(session.modules!).desired.source, after.desired.source);
      assert.equal(permission(session.modules!).desired.capture, "admission");
    } finally { await f.dispose(); }
  }
  const f = await fixture({}, false);
  try {
    const initial = await f.config<GlobalConfigSnapshot>("describe");
    await f.config("save", { request: { expectedRevision: initial.revision, edits: [
      { op: "unset", path: ["permissionControl", "enabled"] }
    ] } });
    const state = permission(await f.config<DsmmModuleState[]>("describeModules"));
    assert.equal(state.desired.source, "defaults"); assert.equal(state.desired.enabled, true);
    assert.equal(state.startupMounted, false); assert.equal(state.nextRoot.admitted, false); assert.equal(state.reason, "restart-required");
    const agent = await f.createRoot();
    assert.equal(f.runtime.getSettings(agent).permissionControl.enabled, false);
    const captured = f.runtime.admission(agent);
    await f.controllerFiber.dispose();
    const restarted = await fixture({}, undefined, f.root);
    try {
      const restartedRoot = await restarted.createRoot();
      assert.equal(permission(await restarted.config<DsmmModuleState[]>("describeModules")).startupMounted, true);
      assert.equal(restarted.runtime.getSettings(restartedRoot).permissionControl.enabled, true);
      assert.equal(f.runtime.admission(agent), captured);
      assert.equal(captured.settings.permissionControl.enabled, false);
    } finally { await restarted.dispose(); }
  } finally { await f.dispose(); }
});

test("live unsynced permission controller stays mounted; retired or unobserved owners project null without changing admission", async () => {
  const f = await fixture();
  try {
    const agent = await f.createRoot(), admission = f.runtime.admission(agent);
    assert.equal(permission(projectDsmmModules(f.startup.settings, f.startup, admission)).startupMounted, null);
    f.rules.runtime.invalidate();
    assert.equal(f.rules.runtime.signal.aborted, true); assert.equal(f.rules.runtime.status().state, "unsynced");
    assert.equal(permission(await f.config<DsmmModuleState[]>("describeModules")).startupMounted, true);
    assert.equal(permission(f.runtime.getSettings.moduleStates!(agent)).nextRoot.admitted, true);
    await f.controllerFiber.dispose();
    const editor = await f.config<DeploymentEditorSnapshot>("describeSettings");
    assert.deepEqual(editor.modules, await f.config("describeModules"));
    const retired = permission(editor.modules);
    assert.equal(retired.startupMounted, null); assert.equal(retired.nextRoot.admitted, null);
    const session = await f.profiles<SessionProfileSnapshot>("describeSession", { sessionId: agent.id });
    assert.equal(permission(session.modules!).startupMounted, null); assert.equal(permission(session.modules!).admitted, true);
    assert.equal(f.runtime.admission(agent), admission);
  } finally { await f.dispose(); }
});

test("strict module DTO codecs accept nullable observations and reject unknown/duplicate/incomplete inventory and fields", async (t) => {
  const f = await fixture({ permissionControl: { enabled: false } });
  try {
    const editor = await f.config<DeploymentEditorSnapshot>("describeSettings");
    const agent = await f.createRoot();
    const session = await f.profiles<SessionProfileSnapshot>("describeSession", { sessionId: agent.id });
    const methods = ["describeModules", "describeSettings", "describeSession", "selectSession"];
    for (const method of methods) {
      await t.test(method, () => {
        const codec = TYPERT_REMOTE.descriptors.find(row => row.method === method)!.result;
        if (codec.mode !== "strict") throw new Error("Strict module result codec required");
        const envelope = (modules: unknown[]) => method === "describeModules" ? modules : { ...(method === "describeSettings" ? editor : session), modules };
        const parse = (modules: unknown[]) => codec.create().parse(envelope(modules));
        assert.doesNotThrow(() => parse(editor.modules));
        const nullable = projectDsmmModules(f.startup.settings, f.startup);
        assert.doesNotThrow(() => parse(nullable));
        assert.doesNotThrow(() => parse([...nullable].reverse()));
        const permissionState = editor.modules[1]!;
        for (const source of ["defaults", "global", "profile"]) assert.doesNotThrow(() => parse([editor.modules[0]!, { ...permissionState, desired: { ...permissionState.desired, source } }]));
        const { pending: _pending, ...incomplete } = permissionState;
        for (const modules of [[], [editor.modules[0]], [editor.modules[0], editor.modules[0]],
          [editor.modules[0], { ...permissionState, descriptor: { ...permissionState.descriptor, id: "modelParameters" } }],
          [editor.modules[0], { ...permissionState, descriptor: { ...DSMM_MODULE_DESCRIPTORS[1], key: "invented.enabled" } }],
          [editor.modules[0], incomplete], [editor.modules[0], { ...permissionState, authority: true }],
          [editor.modules[0], { ...permissionState, startupMounted: "unknown" }],
          [editor.modules[0], { ...permissionState, nextRoot: { admitted: "unknown", reason: null } }],
          [editor.modules[0], { ...permissionState, desired: { ...permissionState.desired, source: "named-session" } }],
          [editor.modules[0], { ...permissionState, desired: { ...permissionState.desired, capture: "live" } }]]) {
          assert.throws(() => parse(modules));
        }
      });
    }
  } finally { await f.dispose(); }
});
