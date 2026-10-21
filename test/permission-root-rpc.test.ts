import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { AgentPresetRegistry } from "@deepseek-ai/dsh-agent-preset-registry";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import * as Connection from "@deepseek-ai/dsh-client-connection";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import DsmmPlugin from "../src/index.ts";
import { createCorePermissionAuthority } from "../src/core-permission-authority.ts";
import { DSMM_ROLES, rolePluginRows } from "../src/roles.ts";
import type { DshAgent } from "../src/dsh-types.ts";
import { PermissionRefusal } from "../src/permission-control.ts";
import { parsePermissionRulesResult } from "../src/permission-remote.ts";
import type { DsmmProfileRuntime } from "../src/profile-runtime.ts";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";
import { mountPermissionHostCore, permissionHostProfile } from "./permission-host-fixture.ts";

useIsolatedDshEnvironment();
const native = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-agent-preset-registry"));
const { Loader, Group } = native("@deepseek-ai/cordis-plugin-loader");
const { CredentialProvider } = native("@deepseek-ai/dsh-credentials");
const { RemoteAccessService } = native("@deepseek-ai/dsh-api-remote-access");
const { ApprovalService } = native("@deepseek-ai/dsh-user-approval");
const { SandboxPolicyService, setSandboxMode } = native("@deepseek-ai/dsh-sandbox-policy");
const skillSdk = createRequire(native.resolve("@deepseek-ai/dsh-skill-filesystem"));
const { SkillRegistry } = skillSdk("@deepseek-ai/dsh-skill");
class MemoryCredentials extends CredentialProvider {
  async modifyRecord(_key: string, modify: (value: unknown) => Promise<unknown>) { return modify(undefined); }
}

async function fixture() {
  const parent = await realpath(tmpdir()), directory = await mkdtemp(join(parent, "dsmm-permission-root-rpc-"));
  const home = join(directory, "home"); await mkdir(home);
  const ctx = new Context().extend({ baseUrl: new URL("../", import.meta.url).href }), handles: AgentHandle[] = [];
  try {
    ctx.provide("profileContext", { ...permissionHostProfile(directory, home,
      { defaultActive: false, lsp: { enabled: false }, presets: { root: join(directory, "presets") } }),
      baseUrl: new URL("../", import.meta.url).href });
    for (const [plugin, config] of [[AgentRegistry], [SessionStore], [SessionProjectionRegistry], [LlmRuntime],
      [SystemPrompt, {}], [ToolRuntime, { mode: "native" }], [AgentLoop, {}], [Loader, { baseUrl: new URL("../", import.meta.url).href }], [AgentPresetRegistry, { default: "standard" }],
      [RemoteAccessService], [MemoryCredentials], [Connection], [TypertRegistry], [TypertGatewayService, {}],
      [ApprovalService, { policy: "ask" }], [SandboxPolicyService, { mode: "workspace-write" }], [SkillRegistry, {}]] as const) {
      await ctx.plugin(plugin as never, config as never).await();
    }
    ctx.loader.builtins.group = { default: Group };
    const denied = async (): Promise<never> => { throw new Error("Permission root fixture forbids web, shell and subprocess work"); };
    ctx.provide("web", { search: denied, fetch: denied });
    ctx.provide("subprocess", { spawn: denied });
    ctx.provide("shell", { execute: denied });
    ctx.provide("shellEnv", { resolve: denied });
    for (const [name, peer, config] of [
      ["dsh-fs-local", "dsh-fs-local", { cwd: directory }],
      ["dsh-working-directory", "dsh-working-directory", { defaultDirectory: directory }],
      ["dsh-jobs-local", "dsh-jobs-local", {}],
      ["dsh-commands", "dsh-command-compact", {}],
      ["dsh-token-meter", "dsh-compaction-tool-result-pruner", {}],
      ["dsh-user-questions", "dsh-tool-ask-user", {}]
    ] as const) {
      const sdk = createRequire(native.resolve(`@deepseek-ai/${peer}`));
      const plugin = sdk(`@deepseek-ai/${name}`);
      const fiber = ctx.plugin(plugin.default, config); await fiber.await(); assert.equal(fiber.state, 2);
    }
    ctx.provide("webServer", { host: "127.0.0.1" });
    for (const id of ["standard", "dsmm-unknown"]) {
      await ctx.agentPresets.register({ id, name: id, description: "Permission root composition", plugins: [] });
    }
    let unregisterDispatcher!: () => Promise<void>;
    for (const id of ["dsmm-orchestrator", "dsmm-planner", "dsmm-builder"]) {
      const role = DSMM_ROLES.find(row => row.id === id)!;
      const plugins = rolePluginRows(role).map(row => ({ ...row,
        isolate: row.isolate === undefined ? undefined : Object.fromEntries(Object.entries(row.isolate).map(([name, value]) => {
          assert.equal(value, true);
          return [name, true] as const;
        })) }));
      const unregister = await ctx.agentPresets.register({ id, name: role.name, description: role.description, plugins });
      if (id === "dsmm-orchestrator") unregisterDispatcher = unregister;
    }
    const create = async (preset = "standard", historical = preset, parentAgent?: Agent) => {
      const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()),
        ...parentAgent === undefined ? {} : { parentAgent },
        meta: { cwd: directory, agentPreset: historical, ...parentAgent === undefined ? {} : { origin: "subagent" as const } },
        agentOptions: { provider: "unused-local", model: "unused-local" },
        async setup(scope) { await ctx.agentPresets.mount(scope, preset); } });
      handles.push(handle); return handle.agent;
    };
    const pre = await create("standard", "dsmm-orchestrator"), readonly = await create("dsmm-planner", "standard"), unknown = await create("dsmm-unknown", "standard");
    const orchestrator = await create("dsmm-orchestrator"), historicalStandard = await create("dsmm-orchestrator", "standard"), builder = await create("dsmm-builder", "standard");
    // Mounted Agents retain this revision; Core owns the current dispatcher registration.
    await unregisterDispatcher();
    for (const root of [orchestrator, historicalStandard]) {
      assert.equal(ctx.agentPresets.composedPreset(root.ctx), "dsmm-orchestrator");
    }
    const core = await mountPermissionHostCore(ctx, DsmmPlugin);
    const host = ctx.dsmmNativeAdmission, profiles = ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const lifetime = new AbortController(); core.ctx.effect(() => () => lifetime.abort());
    const authority = createCorePermissionAuthority(core.ctx, { getSettings: profiles.getSettings, rolePolicy: host.policy, signal: lifetime.signal });
    const invoke = async (root: Agent, method: string, request?: unknown) => parsePermissionRulesResult(await ctx.typertGateway.invoke({
      namespace: "dsmmPermissions", method, peer: ctx.connection.browserPeer,
      args: { sessionId: root.id, ...request === undefined ? {} : { request } } }));
    const describe = (root = pre) => invoke(root, "describeRules");
    const save = (root: Agent, expectedRevision: string, outsideReads: "allow" | "deny" = "deny") => invoke(root, "saveRules", { expectedRevision, changes: { outsideReads } });
    const deployment = ctx.dsmmDeploymentConfig;
    return { ctx, core, host, profiles, pre, readonly, unknown, orchestrator, historicalStandard, builder, authority, create, describe, save, deployment,
      async dispose() { await core.dispose(); for (const handle of handles.reverse()) await handle.dispose(); await ctx.fiber.dispose();
        const exact = await realpath(directory); assert.equal(dirname(exact), parent); await rm(exact, { recursive: true }); } };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.dispose(); await ctx.fiber.dispose();
    const exact = await realpath(directory); assert.equal(dirname(exact), parent); await rm(exact, { recursive: true }); throw error;
  }
}

test("pre-Core native root reads, saves and reads global rules without acquiring an admission; post-Core retains its capture", async () => {
  const f = await fixture();
  try {
    const assertNative = () => { assert.equal(f.host.owns(f.pre), false); assert.equal(f.profiles.hasAdmission(f.pre as DshAgent), false); };
    assertNative();
    assert.equal(f.ctx.agentPresets.composedPreset(f.pre.ctx), "standard");
    assert.equal(f.pre.session.header.agentPreset, "dsmm-orchestrator");
    const before = await f.describe(); assertNative();
    const saved = await f.save(f.pre, before.snapshot.revision); assertNative();
    assert.notEqual(saved.snapshot.revision, before.snapshot.revision); assert.equal(saved.snapshot.policy.outsideReads, "deny");
    assert.deepEqual((await f.describe()).snapshot, saved.snapshot); assertNative();
    assert.equal((await f.deployment.readGlobal()).config.permissionControl?.outsideReads, "deny");
    const source = f.deployment.store.read();
    await assert.rejects(f.save(f.pre, before.snapshot.revision));
    assert.deepEqual(f.deployment.store.read(), source); assertNative();
    const post = await f.create();
    assert.equal(f.host.owns(post), true); assert.equal(f.profiles.hasAdmission(post as DshAgent), true);
    const admission = f.profiles.admission(post as DshAgent);
    const current = await f.describe(post), resaved = await f.save(post, current.snapshot.revision);
    assert.deepEqual((await f.describe(post)).snapshot, resaved.snapshot);
    assert.equal(f.profiles.admission(post as DshAgent), admission);
  } finally { await f.dispose(); }
});

test("enabled Core preserves native pre-Core dispatchers and admits new dispatchers for global rules", async () => {
  const f = await fixture();
  try {
    for (const root of [f.orchestrator, f.historicalStandard]) {
      const assertNative = () => {
        assert.equal(f.host.owns(root), false); assert.equal(f.profiles.hasAdmission(root as DshAgent), false);
        assert.throws(() => f.host.policy.assertDelegation(root as DshAgent, "dsmm-coding"), { code: "UNAUTHORIZED" });
      };
      assert.equal(f.ctx.agentPresets.composedPreset(root.ctx), "dsmm-orchestrator");
      assert.equal(root.session.header.agentPreset, root === f.orchestrator ? "dsmm-orchestrator" : "standard");
      assert.equal(root.ctx.get("sandboxPolicy")!.resolve({ session: root.session }).mode, "workspace-write");
      assertNative();
      const before = await f.describe(root); assertNative();
      const outsideReads = root === f.orchestrator ? "deny" : "allow";
      const saved = await f.save(root, before.snapshot.revision, outsideReads); assertNative();
      assert.notEqual(saved.snapshot.revision, before.snapshot.revision);
      assert.equal(saved.snapshot.policy.outsideReads, outsideReads);
      assert.deepEqual((await f.describe(root)).snapshot, saved.snapshot); assertNative();
      assert.equal((await f.deployment.readGlobal()).config.permissionControl?.outsideReads, outsideReads);
      const source = f.deployment.store.read();
      await assert.rejects(f.save(root, "stale-revision")); assertNative();
      assert.deepEqual(f.deployment.store.read(), source);
      setSandboxMode(root.session, "read-only");
      assert.throws(() => f.authority.assertWritable(root), { code: "denied" });
      await assert.rejects(f.save(root, saved.snapshot.revision)); assertNative();
      assert.deepEqual(f.deployment.store.read(), source);
    }
    const post = await f.create("dsmm-orchestrator");
    assert.equal(f.ctx.agentPresets.composedPreset(post.ctx), "dsmm-orchestrator");
    assert.equal(post.ctx.get("sandboxPolicy")!.resolve({ session: post.session }).mode, "workspace-write");
    assert.equal(f.host.owns(post), true); assert.equal(f.profiles.hasAdmission(post as DshAgent), true);
    const admission = f.profiles.admission(post as DshAgent);
    assert.equal(admission.settings.roles["dsmm-orchestrator"], true);
    assert.equal(f.host.policy.identity(post as DshAgent).role, "dsmm-orchestrator");
    const current = await f.describe(post), saved = await f.save(post, current.snapshot.revision);
    assert.notEqual(saved.snapshot.revision, current.snapshot.revision);
    assert.equal(saved.snapshot.policy.outsideReads, "deny");
    assert.deepEqual((await f.describe(post)).snapshot, saved.snapshot);
    assert.equal((await f.deployment.readGlobal()).config.permissionControl?.outsideReads, "deny");
    assert.equal(f.profiles.admission(post as DshAgent), admission);
    for (const root of [f.orchestrator, f.historicalStandard]) {
      assert.equal(f.host.owns(root), false); assert.equal(f.profiles.hasAdmission(root as DshAgent), false);
    }
  } finally { await f.dispose(); }
});

test("unadmitted auxiliary and unknown DSMM compositions and native readonly sandbox cannot change global rules", async () => {
  const f = await fixture();
  try {
    const before = f.deployment.store.read(), revision = f.deployment.permissionSource().revision;
    for (const root of [f.readonly, f.builder, f.unknown]) {
      assert.equal(f.host.owns(root), false); assert.equal(f.profiles.hasAdmission(root as DshAgent), false);
      assert.ok(f.ctx.agentPresets.composedPreset(root.ctx)?.startsWith("dsmm-"));
      assert.equal(root.session.header.agentPreset, "standard");
      assert.throws(() => f.authority.assertWritable(root), { code: "denied" });
      await assert.rejects(f.describe(root)); await assert.rejects(f.save(root, revision));
      assert.deepEqual(f.deployment.store.read(), before);
    }
    setSandboxMode(f.pre.session, "read-only");
    assert.throws(() => f.authority.assertWritable(f.pre), { code: "denied" });
    await assert.rejects(f.save(f.pre, revision)); assert.deepEqual(f.deployment.store.read(), before);
  } finally { await f.dispose(); }
});

test("root identity, realm and current Core owner remain mandatory for native RPC writes", async () => {
  const f = await fixture();
  try {
    const source = f.deployment.store.read(), revision = f.deployment.permissionSource().revision;
    const child = await f.create("standard", "standard", f.pre);
    await assert.rejects(f.save(child, revision));
    assert.throws(() => f.authority.assertWritable({ ...f.pre } as Agent), { code: "not-owned" });
    const rootContext = f.pre.ctx;
    const foreign = rootContext.isolate("agents");
    Reflect.set(f.pre, "ctx", foreign);
    try {
      assert.throws(() => f.authority.assertWritable(f.pre), { code: "not-owned" });
      await assert.rejects(f.save(f.pre, revision));
    } finally { Reflect.set(f.pre, "ctx", rootContext); }
    const wrongOwner = rootContext.isolate("dsmmCoreLlmOwner");
    wrongOwner.provide("dsmmCoreLlmOwner", { async admit() { return undefined; } });
    Reflect.set(f.pre, "ctx", wrongOwner);
    try {
      assert.throws(() => f.authority.assertWritable(f.pre), { code: "unavailable" });
      await assert.rejects(f.save(f.pre, revision));
    } finally { Reflect.set(f.pre, "ctx", rootContext); }
    assert.deepEqual(f.deployment.store.read(), source);
  } finally { await f.dispose(); }
});

test("captured roots retain readonly identity ceilings and a retired capture cannot become native", async t => {
  const f = await fixture();
  try {
    const root = await f.create(), revision = f.deployment.permissionSource().revision, source = f.deployment.store.read();
    const identity = f.host.policy.identity(root as DshAgent);
    for (const ceiling of [{ role: "dsmm-doc-search" as const }, { readOnly: true }]) {
      const mocked = t.mock.method(f.host.policy, "identity", () => ({ ...identity, ...ceiling }));
      try { assert.throws(() => f.authority.assertWritable(root), { code: "denied" }); await assert.rejects(f.save(root, revision)); }
      finally { mocked.mock.restore(); }
    }
    f.host.lifetime.abort();
    assert.equal(f.host.owns(root), true);
    assert.throws(() => f.host.assert(root));
    assert.throws(() => f.authority.assertWritable(root)); await assert.rejects(f.save(root, revision));
    assert.deepEqual(f.deployment.store.read(), source);
  } finally { await f.dispose(); }
});

test("profile-admitted roots without a host capture still enforce module, epoch, lineage and readonly ceilings", async t => {
  const f = await fixture();
  try {
    const root = await f.create(), source = f.deployment.store.read(), revision = f.deployment.permissionSource().revision;
    const identity = f.host.policy.identity(root as DshAgent);
    const owns = t.mock.method(f.host, "owns", () => false);
    try {
      assert.equal(f.profiles.hasAdmission(root as DshAgent), true);
      f.authority.assertWritable(root);
      const module = t.mock.method(f.host.policy, "assertModuleAdmission", () => { throw new PermissionRefusal("denied"); });
      try { assert.throws(() => f.authority.assertWritable(root), { code: "denied" }); await assert.rejects(f.save(root, revision)); }
      finally { module.mock.restore(); }
      for (const ceiling of [{ epoch: "stale-epoch" }, { child: true }, { parent: f.pre as DshAgent }, { readOnly: true }]) {
        const mocked = t.mock.method(f.host.policy, "identity", () => ({ ...identity, ...ceiling }));
        try { assert.throws(() => f.authority.assertWritable(root), PermissionRefusal); await assert.rejects(f.save(root, revision)); }
        finally { mocked.mock.restore(); }
      }
      const admission = f.profiles.admission(root as DshAgent);
      const originalAdmission = f.profiles.getSettings.admission;
      f.profiles.getSettings.admission = () => ({ ...admission });
      try { assert.throws(() => f.authority.assertWritable(root), { code: "stale" }); }
      finally { f.profiles.getSettings.admission = originalAdmission; }
      assert.deepEqual(f.deployment.store.read(), source);
    } finally { owns.mock.restore(); }
  } finally { await f.dispose(); }
});
