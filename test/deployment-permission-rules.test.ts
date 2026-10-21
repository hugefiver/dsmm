import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { installDeploymentPermissionRules } from "../src/deployment-permission-rules.ts";
import type { DeploymentPermissionRules } from "../src/deployment-permission-rules.ts";
import type { PermissionRuleSnapshot, PermissionRulesSaveAuthority } from "../src/permission-rules.ts";
import { nativeConfigRun } from "./permission-deployment-fixture.ts";
import type { DsmmPluginConfig } from "../src/settings.ts";
import { registerNativePermissionRules } from "../src/permission-native-rules.ts";

const sdk = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-tools"));
const { ApprovalService, setApprovalPolicy } = await import(pathToFileURL(sdk.resolve("@deepseek-ai/dsh-user-approval")).href);

type Profile = Awaited<ReturnType<ReturnType<typeof nativeConfigRun>["createProfile"]>>;
function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function bind(profile: Profile) {
  const deployment = profile.deployment;
  assert.equal(deployment.nativeEntry, profile.entry);
  let readonly = false, revokes = 0;
  let notify = async (_snapshot: PermissionRuleSnapshot): Promise<void> => {};
  let onRevoke = (): void => {};
  let backend!: DeploymentPermissionRules;
  const fiber = profile.ctx.plugin({ name: "owned-permission-backend", inject: ["agents"], apply(ctx) {
    backend = installDeploymentPermissionRules(ctx, { deployment,
      assertWritable() { if (readonly) throw new Error("owned readonly restriction"); },
      revoke() { revokes++; onRevoke(); }, notify: snapshot => notify(snapshot) });
  } });
  await fiber.await();
  const root = await profile.create(), abort = new AbortController(), peer = {};
  const authority: PermissionRulesSaveAuthority = { root, peer, signal: abort.signal,
    assertCurrent() { abort.signal.throwIfAborted(); assert.equal(profile.ctx.agents.get(root.id), root); if (readonly) throw new Error("owned readonly restriction"); } };
  return { deployment, backend, root, authority, abort, fiber, revokes: () => revokes,
    readonly(value: boolean) { readonly = value; }, notify(value: typeof notify) { notify = value; }, onRevoke(value: typeof onRevoke) { onRevoke = value; } };
}

test("global rules use persistent source tokens, real CAS and operator provenance across a fresh native Host", async () => {
  const run = nativeConfigRun({ managedPermissionSettings: true });
  try {
    const profile = await run.createProfile("permission-token"), owner = await bind(profile);
    const before = await owner.backend.read(owner.authority);
    const saved = await owner.backend.save({ expectedRevision: before.revision,
      changes: { outsideReads: "ask" }, upsert: [{ id: "audit", action: "deny", match: { kind: "webSearch" } }] }, owner.authority);
    assert.notEqual(saved.snapshot.revision, before.revision);
    assert.equal(saved.runtime.state, "synced");
    assert.equal(saved.snapshot.policy.rules[0]!.source.kind, "operator");
    assert.deepEqual(saved.snapshot.policy.rules[0]!.source, { kind: "operator", sessionId: owner.root.id, savedAt: saved.snapshot.policy.rules[0]!.source.kind === "operator" ? saved.snapshot.policy.rules[0]!.source.savedAt : 0 });
    await assert.rejects(owner.backend.save({ expectedRevision: before.revision, changes: { outsideReads: "allow" } }, owner.authority));
    await profile.dispose();
    const reopened = await run.reopenProfile("permission-token"), restored = await bind(reopened);
    assert.deepEqual(await restored.backend.read(restored.authority), saved.snapshot);
  } finally { await run.dispose(); }
});

test("native mutate/update/replace share the ordinary editor transaction and imports cannot claim operator provenance", async () => {
  const run = nativeConfigRun({ managedPermissionSettings: true });
  try {
    const profile = await run.createProfile("permission-native"), owner = await bind(profile);
    const initial = owner.backend.runtime.signal;
    let descriptor = profile.descriptor();
    await profile.settings.mutate(descriptor.ns, [{ op: "set", path: ["permissionControl", "outsideReads"], value: "deny" }], descriptor.revision);
    assert.equal(initial.aborted, true);
    assert.equal(owner.backend.runtime.getPolicy().policy.outsideReads, "deny");
    const snapshot = await owner.backend.read(owner.authority);
    await assert.rejects(owner.backend.save({ expectedRevision: snapshot.revision, changes: { outsideReads: "allow" } }, owner.authority), /Native profile overrides/);
    const native = profile.ctx.settings;
    descriptor = profile.descriptor();
    await native.update(descriptor.ns, { permissionControl: { rules: [{ id: "imported", action: "ask", match: { kind: "webFetch" },
      source: { kind: "operator", sessionId: "forged", savedAt: 1 }, revision: 8, revoked: true }] } }, descriptor.revision);
    const rule = owner.backend.runtime.getPolicy().policy.rules[0]!;
    assert.deepEqual(rule.source, { kind: "user-import", label: "native-profile-settings" });
    assert.equal(rule.revoked, true);
    descriptor = profile.descriptor();
    await native.replace(descriptor.ns, { ...profile.persistedConfig(), permissionControl: { enabled: false, outsideReads: "ask" } }, descriptor.revision);
    assert.equal(owner.backend.runtime.status().mounted, true);
    assert.equal(owner.backend.runtime.status().restartRequired, true);
    assert.equal(owner.backend.runtime.getPolicy().policy.enabled, true);
    assert.equal(owner.backend.runtime.getPolicy().policy.outsideReads, "ask");
    assert.equal(owner.revokes(), 3);
    profile.assertLive();
  } finally { await run.dispose(); }
});

test("a committed save reports unsynchronized permission state until authoritative recovery acknowledges it", async () => {
  const run = nativeConfigRun({ managedPermissionSettings: true }), entered = gate(), release = gate();
  try {
    const profile = await run.createProfile("permission-notify"), owner = await bind(profile);
    const before = owner.backend.initial, oldSignal = owner.backend.runtime.signal;
    owner.notify(async () => { entered.release(); await release.promise; throw new Error("owned notification failure"); });
    const saving = owner.backend.save({ expectedRevision: before.revision, changes: { outsideReads: "deny" } }, owner.authority);
    await Promise.race([entered.promise, saving.then(() => { throw new Error("The notification did not reach its gate."); })]);
    assert.equal(oldSignal.aborted, true);
    assert.equal(owner.backend.runtime.status().state, "updating");
    assert.throws(() => owner.backend.runtime.getPolicy());
    assert.equal((await owner.deployment.readDesired()).settings.permissionControl.outsideReads, "deny");
    release.release();
    const saved = await saving;
    assert.equal(saved.snapshot.policy.outsideReads, "deny");
    assert.equal(saved.runtime.state, "unsynced");
    assert.equal(owner.backend.runtime.status().state, "unsynced");
    assert.throws(() => owner.backend.runtime.getPolicy());
    owner.notify(async () => {});
    await owner.backend.reconcile();
    assert.equal(owner.backend.runtime.getPolicy().policy.outsideReads, "deny");
    assert.notEqual(owner.backend.runtime.signal, oldSignal);
    assert.equal(oldSignal.aborted, true);
  } finally { release.release(); await run.dispose(); }
});

test("a real file CAS loss recovers the winning source, never the rejected proposal or former signal", async () => {
  const run = nativeConfigRun({ managedPermissionSettings: true });
  try {
    const profile = await run.createProfile("permission-cas"), owner = await bind(profile);
    await owner.deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["permissionControl", "outsideReads"], value: "ask" }] }, () => {});
    const before = await owner.backend.read(owner.authority), signal = owner.backend.runtime.signal;
    owner.onRevoke(() => {
      owner.onRevoke(() => {});
      writeFileSync(join(run.home, "plugins", "dsmm", "config.json"), JSON.stringify({ permissionControl: { outsideReads: "allow" } }));
    });
    const global = await owner.deployment.readGlobal();
    await assert.rejects(owner.deployment.saveGlobal({ expectedRevision: global.revision,
      edits: [{ op: "set", path: ["permissionControl", "outsideReads"], value: "deny" }] }, () => {}), { code: "conflict" });
    assert.equal(owner.backend.runtime.getPolicy().policy.outsideReads, "allow");
    assert.equal(signal.aborted, true);
    assert.notEqual(owner.backend.runtime.getPolicy().revision, before.revision);
  } finally { await run.dispose(); }
});

test("cancellation before file CAS prevents persistence; active Root work does not prevent rule revocation", async () => {
  const run = nativeConfigRun({ managedPermissionSettings: true }), hold = gate();
  try {
    const profile = await run.createProfile("permission-authority"), owner = await bind(profile);
    const busy = owner.root.runMaintenance(() => hold.promise);
    try {
      const saved = await owner.backend.save({ expectedRevision: owner.backend.initial.revision, changes: { outsideReads: "ask" } }, owner.authority);
      assert.equal(saved.snapshot.policy.outsideReads, "ask");
      assert.notEqual(saved.snapshot.revision, owner.backend.initial.revision);
      assert.equal(saved.snapshot.policy.rules.length, 0);
      const previous = owner.backend.runtime.signal;
      const same = await owner.backend.save({ expectedRevision: saved.snapshot.revision, changes: { outsideReads: "ask" } }, owner.authority);
      assert.equal(same.snapshot.revision, owner.deployment.permissionSource().revision);
      assert.equal(previous.aborted, true);
      assert.notEqual(owner.backend.runtime.signal, previous);
    } finally { hold.release(); await busy; }
    const source = owner.deployment.permissionSource(), signal = owner.backend.runtime.signal;
    owner.onRevoke(() => owner.abort.abort());
    await assert.rejects(owner.backend.save({ expectedRevision: source.revision, changes: { outsideReads: "deny" } }, owner.authority));
    assert.equal(owner.deployment.permissionSource().globalRevision, source.globalRevision);
    assert.equal(signal.aborted, true);
    owner.onRevoke(() => {});
    owner.readonly(true);
    assert.throws(() => owner.backend.assertWritable(owner.root));
  } finally { hold.release(); await run.dispose(); }
});


test("generic global saves synchronize all attached owners, retain native overrides and restamp imported rules", async () => {
  const run = nativeConfigRun({ managedPermissionSettings: true }), entered = gate(), release = gate();
  try {
    const first = await bind(await run.createProfile("permission-global-first"));
    const override: DsmmPluginConfig = { permissionControl: { webFetch: { enabled: false } } };
    const second = await bind(await run.createProfile("permission-global-second", override));
    const firstSignal = first.backend.runtime.signal, secondSignal = second.backend.runtime.signal;
    second.notify(async () => { entered.release(); await release.promise; });
    const saving = first.deployment.saveGlobal({ expectedRevision: "absent", edits: [
      { op: "set", path: ["modules", "deepwork", "enabled"], value: false },
      { op: "set", path: ["permissionControl"], value: { webFetch: { enabled: true, rule: "deny" }, rules: [{ id: "import", action: "deny", match: { kind: "webSearch" },
        source: { kind: "operator", sessionId: "untrusted", savedAt: 1 }, revision: 4, revoked: true }] } }
    ] }, () => {});
    await Promise.race([entered.promise, saving.then(() => { throw new Error("Missing shared notification gate"); })]);
    assert.equal(firstSignal.aborted, true); assert.equal(secondSignal.aborted, true);
    assert.throws(() => first.backend.runtime.getPolicy()); assert.throws(() => second.backend.runtime.getPolicy());
    release.release(); await saving;
    assert.equal(first.backend.runtime.getPolicy().policy.webFetch.enabled, true);
    assert.equal(second.backend.runtime.getPolicy().policy.webFetch.enabled, false);
    assert.equal(second.backend.runtime.getPolicy().policy.webFetch.rule, "deny");
    assert.deepEqual(first.backend.runtime.getPolicy().policy.rules[0]!.source, { kind: "user-import", label: "global-settings" });
    assert.equal(first.backend.runtime.getPolicy().policy.rules[0]!.revoked, true);
    assert.equal((await first.deployment.readGlobal()).config.modules?.deepwork?.enabled, false);
  } finally { release.release(); await run.dispose(); }
});

test("an independently changed source is reported unsynced and fences dispatch until authoritative reconciliation", async () => {
  const run = nativeConfigRun({ managedPermissionSettings: true });
  try {
    const owner = await bind(await run.createProfile("permission-observed-source"));
    const before = owner.backend.runtime.status(), signal = owner.backend.runtime.signal;
    await owner.deployment.store.save(JSON.stringify({ permissionControl: { outsideReads: "deny" } }), "absent");
    assert.throws(() => owner.backend.runtime.getPolicy(), { code: "stale" });
    const status = owner.backend.runtime.status();
    assert.equal(status.state, "unsynced");
    assert.notEqual(status.savedRevision, before.savedRevision);
    assert.equal(status.runtimeRevision, before.runtimeRevision);
    assert.equal(signal.aborted, true);
    assert.throws(() => owner.backend.runtime.getPolicy());
    await owner.backend.reconcile();
    assert.equal(owner.backend.runtime.getPolicy().policy.outsideReads, "deny");
    assert.equal(owner.backend.runtime.status().runtimeRevision, status.savedRevision);
  } finally { await run.dispose(); }
});

test("source-bound deployment policy permits a stable identified native call through the real SDK guard", async () => {
  const run = nativeConfigRun({ managedPermissionSettings: true });
  try {
    const profile = await run.createProfile("permission-native-stable"), owner = await bind(profile);
    let bodies = 0;
    const definition: ToolDefinition = { name: "owned-native-web", description: "owned inert native boundary", parameters: { type: "object" },
      output: { schema: { type: "integer" }, render: (_args, value) => [{ type: "text", text: String(value) }] }, async execute() { return ++bodies; } };
    profile.ctx.tools.register(definition);
    registerNativePermissionRules(profile.ctx, { runtime: owner.backend.runtime,
      identify: current => current === definition ? { kind: "webFetch", context: profile.ctx, assertCurrent() {} } : undefined, assertCurrent() {} });
    owner.root.session.append("turn/start", { turn: 1 });
    const result = await profile.ctx.tools.execute({ callId: ToolCallId(randomUUID()), name: definition.name, arguments: {}, agent: owner.root, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(bodies, 1);
    const policy = owner.backend.runtime.getPolicy();
    assert.equal(owner.backend.runtime.getPolicy(), policy); assert.ok(Object.isFrozen(policy)); assert.ok(Object.isFrozen(policy.policy));
  } finally { await run.dispose(); }
});

test("next actual native consumption refreshes direct-file edits and native whole-array command overrides", async () => {
  const run = nativeConfigRun({ managedPermissionSettings: true });
  try {
    const profile = await run.createProfile("permission-owned-refresh"), owner = await bind(profile);
    let bodies = 0;
    const definition: ToolDefinition = { name: "owned-native-refresh", description: "Owned source-consumption boundary", parameters: { type: "object" },
      output: { schema: { type: "integer" }, render: (_args, value) => [{ type: "text", text: String(value) }] }, async execute() { return ++bodies; } };
    profile.ctx.tools.register(definition);
    registerNativePermissionRules(profile.ctx, { runtime: owner.backend.runtime, identify: current => current === definition ? { kind: "webFetch", context: profile.ctx, assertCurrent() {} } : undefined, assertCurrent() {} });
    owner.root.session.append("turn/start", { turn: 1 });
    const execute = () => profile.ctx.tools.execute({ name: definition.name, callId: ToolCallId(randomUUID()), arguments: {}, agent: owner.root, signal: new AbortController().signal });
    await owner.deployment.store.save("{}", "absent");
    assert.equal((await execute()).isError, false); const oldSignal = owner.backend.runtime.signal;
    const entry = { id: "owned", mode: "allow", sandboxMode: "danger-full-access", match: { tool: "pwsh", commandPattern: "go test", workingDirectory: run.root } };
    writeFileSync(join(run.home, "plugins", "dsmm", "config.json"), JSON.stringify({ permissionControl: { webFetch: { enabled: false }, nativeCommands: { enabled: true, entries: [entry] } } }));
    assert.equal(owner.deployment.permissionSource().policy.nativeCommands.entries.length, 1);
    assert.equal((await execute()).isError, true); assert.equal(bodies, 1); assert.equal(oldSignal.aborted, true);
    assert.equal(owner.backend.runtime.getPolicy().policy.nativeCommands.entries.length, 1);
    const descriptor = profile.descriptor();
    await profile.settings.mutate(descriptor.ns, [{ op: "set", path: ["permissionControl", "nativeCommands", "entries"], value: [] }, { op: "set", path: ["permissionControl", "webFetch", "enabled"], value: true }], descriptor.revision);
    assert.equal((await execute()).isError, false); assert.equal(bodies, 2);
    assert.deepEqual(owner.backend.runtime.getPolicy().policy.nativeCommands, { enabled: true, entries: [] });
    writeFileSync(join(run.home, "plugins", "dsmm", "config.json"), "invalid-source");
    assert.equal((await execute()).isError, true); assert.equal(bodies, 2);
    await owner.fiber.dispose(); assert.equal((await execute()).isError, true); assert.equal(bodies, 2);
  } finally { await run.dispose(); }
});
test("Host command cwd validation fences invalid source before publication and rejects global/native saves before persistence", async () => {
  const run = nativeConfigRun({ managedPermissionSettings: true });
  try {
    const profile = await run.createProfile("permission-host-cwd"), owner = await bind(profile);
    const commands = (workingDirectory: string) => ({ enabled: true, entries: [{ id: "owned", mode: "allow", sandboxMode: "danger-full-access",
      match: { tool: "pwsh", commandPattern: "go test", workingDirectory } }] });
    const nonCanonical = `${run.root}/child/..`, invalidCwd = isAbsolute("C:/owned/workspace") ? "/owned/workspace" : "C:/owned/workspace";
    await owner.deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["permissionControl", "nativeCommands"], value: commands(nonCanonical) }] }, () => {});
    assert.deepEqual(owner.backend.runtime.getPolicy().policy.nativeCommands.entries, commands(normalize(nonCanonical)).entries);
    const saved = await owner.deployment.readGlobal(), descriptor = profile.descriptor();
    await assert.rejects(owner.deployment.saveGlobal({ expectedRevision: saved.revision, edits: [{ op: "set", path: ["permissionControl", "nativeCommands"], value: commands(invalidCwd) }] }, () => {}));
    assert.equal((await owner.deployment.readGlobal()).revision, saved.revision);
    await assert.rejects(profile.settings.mutate(descriptor.ns, [{ op: "set", path: ["permissionControl", "nativeCommands"], value: commands(invalidCwd) }], descriptor.revision));
    assert.equal(profile.persistedConfig().permissionControl?.nativeCommands, undefined);
    const signal = owner.backend.runtime.signal;
    writeFileSync(join(run.home, "plugins", "dsmm", "config.json"), JSON.stringify({ permissionControl: { nativeCommands: commands(invalidCwd) } }));
    await assert.rejects(owner.backend.runtime.refresh()); assert.equal(signal.aborted, true);
    assert.equal(owner.backend.runtime.status().state, "unsynced"); assert.throws(() => owner.backend.runtime.getPolicy());
    writeFileSync(join(run.home, "plugins", "dsmm", "config.json"), JSON.stringify({ permissionControl: { nativeCommands: commands(nonCanonical) } }));
    await owner.backend.runtime.refresh(); assert.equal(owner.backend.runtime.status().state, "synced");
    assert.deepEqual(owner.backend.runtime.getPolicy().policy.nativeCommands.entries, commands(normalize(nonCanonical)).entries);
    assert.equal(signal.aborted, true);
  } finally { await run.dispose(); }
});

test("command patterns: durable global/native saves preserve pattern fields, CAS and whole-array Unset inheritance", async () => {
  const run = nativeConfigRun({ managedPermissionSettings: true });
  try {
    const profile = await run.createProfile("permission-pattern-saves"), owner = await bind(profile);
    const entry = { id: "global", mode: "ask", sandboxMode: "workspace-write", match: { tool: "pwsh", workingDirectory: run.root, commandPattern: " \tgo\tbuild|test *\t " } };
    const globalCommands = { enabled: true, entries: [entry] };
    await owner.deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["permissionControl", "nativeCommands"], value: globalCommands }] }, () => {});
    const saved = await owner.deployment.readGlobal(), beforeNative = profile.descriptor();
    const nativeCommands = { entries: [{ ...entry, id: "native", match: { ...entry.match, commandPattern: "go test" } }] };
    await profile.settings.mutate(beforeNative.ns, [{ op: "set", path: ["permissionControl", "nativeCommands"], value: nativeCommands }], beforeNative.revision);
    assert.deepEqual(profile.persistedConfig().permissionControl?.nativeCommands, nativeCommands);
    let desired = await owner.deployment.readDesired();
    assert.deepEqual(desired.global.permissionControl?.nativeCommands, globalCommands);
    assert.deepEqual(desired.profile.permissionControl?.nativeCommands, nativeCommands);
    assert.deepEqual(desired.settings.permissionControl.nativeCommands, { enabled: true, ...nativeCommands });
    assert.equal(desired.sources["permissionControl.nativeCommands.entries"], "profile");
    const snapshot = owner.backend.runtime.getPolicy(), descriptor = profile.descriptor();
    await assert.rejects(owner.deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["permissionControl", "nativeCommands", "entries"], value: [] }] }, () => {}), { code: "conflict" });
    await assert.rejects(profile.settings.mutate(beforeNative.ns, [{ op: "set", path: ["permissionControl", "nativeCommands", "entries"], value: [] }], beforeNative.revision));
    assert.deepEqual(await owner.deployment.readGlobal(), saved);
    assert.deepEqual(profile.persistedConfig().permissionControl?.nativeCommands, nativeCommands);
    assert.equal(profile.descriptor().revision, descriptor.revision);
    assert.equal(owner.backend.runtime.getPolicy().revision, snapshot.revision);
    await profile.settings.mutate(descriptor.ns, [{ op: "set", path: ["permissionControl", "nativeCommands", "entries"], value: [] }], descriptor.revision);
    assert.deepEqual(owner.backend.runtime.getPolicy().policy.nativeCommands, { enabled: true, entries: [] });
    const unset = profile.descriptor();
    await profile.settings.mutate(unset.ns, [{ op: "unset", path: ["permissionControl", "nativeCommands", "entries"] }], unset.revision);
    desired = await owner.deployment.readDesired();
    assert.deepEqual(desired.settings.permissionControl.nativeCommands, globalCommands);
    assert.equal(desired.sources["permissionControl.nativeCommands.entries"], "global");
    assert.deepEqual(owner.backend.runtime.getPolicy().policy.nativeCommands, globalCommands);
  } finally { await run.dispose(); }
});

test("command patterns: legacy and mixed global/native saves fail without replacing durable data, revisions or runtime candidates", async () => {
  const run = nativeConfigRun({ managedPermissionSettings: true });
  try {
    const profile = await run.createProfile("permission-pattern-reject-save"), owner = await bind(profile);
    const match = { tool: "pwsh", workingDirectory: run.root, commandPattern: "go test" };
    const entry = { id: "valid", mode: "ask", sandboxMode: "workspace-write", match };
    const valid = { enabled: true, entries: [entry] };
    await owner.deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["permissionControl", "nativeCommands"], value: valid }] }, () => {});
    let descriptor = profile.descriptor();
    await profile.settings.mutate(descriptor.ns, [{ op: "set", path: ["permissionControl", "nativeCommands"], value: valid }], descriptor.revision);
    descriptor = profile.descriptor();
    const saved = await owner.deployment.readGlobal(), native = profile.persistedConfig(), snapshot = owner.backend.runtime.getPolicy(), signal = owner.backend.runtime.signal, revokes = owner.revokes();
    const legacy = { tool: "pwsh", workingDirectory: run.root, executable: "go", subcommand: "test", args: ["."] };
    for (const invalidMatch of [legacy, { ...legacy, commandPattern: "go test" }]) for (const enabled of [false, true]) {
      const value = { enabled, entries: [{ ...entry, match: invalidMatch }] };
      await assert.rejects(owner.deployment.saveGlobal({ expectedRevision: saved.revision, edits: [{ op: "set", path: ["permissionControl", "nativeCommands"], value }] }, () => {}));
      assert.deepEqual(await owner.deployment.readGlobal(), saved);
      await assert.rejects(profile.settings.mutate(descriptor.ns, [{ op: "set", path: ["permissionControl", "nativeCommands"], value }], descriptor.revision));
      assert.deepEqual(profile.persistedConfig(), native);
      assert.equal(profile.descriptor().revision, descriptor.revision);
      assert.deepEqual(owner.backend.runtime.getPolicy(), snapshot);
      assert.equal(owner.backend.runtime.signal, signal); assert.equal(signal.aborted, false);
      assert.equal(owner.revokes(), revokes);
    }
  } finally { await run.dispose(); }
});

test("command patterns: external legacy or mixed disabled sources fail refresh and dispatch without publishing or rewriting data", async () => {
  const run = nativeConfigRun({ managedPermissionSettings: true });
  try {
    const profile = await run.createProfile("permission-pattern-reject-refresh"), owner = await bind(profile);
    let bodies = 0;
    const definition: ToolDefinition = { name: "owned-pattern-refresh", description: "Owned source validation boundary", parameters: { type: "object" },
      output: { schema: { type: "integer" }, render: (_args, value) => [{ type: "text", text: String(value) }] }, async execute() { return ++bodies; } };
    profile.ctx.tools.register(definition);
    registerNativePermissionRules(profile.ctx, { runtime: owner.backend.runtime, identify: current => current === definition ? { kind: "webFetch", context: profile.ctx, assertCurrent() {} } : undefined, assertCurrent() {} });
    owner.root.session.append("turn/start", { turn: 1 });
    const execute = () => profile.ctx.tools.execute({ name: definition.name, callId: ToolCallId(randomUUID()), arguments: {}, agent: owner.root, signal: new AbortController().signal });
    const entry = { id: "valid", mode: "ask", sandboxMode: "workspace-write", match: { tool: "pwsh", workingDirectory: run.root, commandPattern: "go test" } };
    const valid = JSON.stringify({ permissionControl: { nativeCommands: { enabled: true, entries: [entry] } } });
    await owner.deployment.store.save(valid, "absent"); await owner.backend.runtime.refresh();
    assert.equal((await execute()).isError, false); assert.equal(bodies, 1);
    const native = profile.persistedConfig(), nativeRevision = profile.descriptor().revision;
    const legacy = { tool: "pwsh", workingDirectory: run.root, executable: "go", subcommand: "test", args: ["."] };
    for (const match of [legacy, { ...legacy, commandPattern: "go test" }]) {
      const snapshot = owner.backend.runtime.getPolicy(), signal = owner.backend.runtime.signal;
      const invalid = JSON.stringify({ permissionControl: { enabled: false, nativeCommands: { enabled: false, entries: [{ ...entry, match }] } } });
      writeFileSync(join(run.home, "plugins", "dsmm", "config.json"), invalid);
      const file = owner.deployment.store.read();
      await assert.rejects(owner.backend.runtime.refresh());
      assert.equal((await execute()).isError, true); assert.equal(bodies, 1);
      assert.equal(signal.aborted, true); assert.equal(owner.backend.runtime.status().state, "unsynced");
      assert.equal(owner.backend.runtime.status().runtimeRevision, snapshot.revision);
      assert.throws(() => owner.backend.runtime.getPolicy());
      assert.deepEqual(owner.deployment.store.read(), file);
      assert.equal(file.content, invalid);
      assert.deepEqual(profile.persistedConfig(), native); assert.equal(profile.descriptor().revision, nativeRevision);
      writeFileSync(join(run.home, "plugins", "dsmm", "config.json"), valid);
      await owner.backend.runtime.refresh();
      assert.deepEqual(owner.backend.runtime.getPolicy().policy.nativeCommands, { enabled: true, entries: [entry] });
    }
  } finally { await run.dispose(); }
});

test("deployment policy changes and same-source no-op saves refresh their projection without revoking native final approval", { timeout: 15000 }, async () => {
  const run = nativeConfigRun({ managedPermissionSettings: true });
  let release = (): void => {};
  try {
    const profile = await run.createProfile("permission-native-generations"), owner = await bind(profile);
    let bodies = 0, answers = 0, hold: (() => Promise<void>) | undefined, pendingSignal: AbortSignal | undefined;
    let outcome: "allowed-once" | "rejected" | "cancelled" = "allowed-once";
    const definition: ToolDefinition = { name: "owned-native-web", description: "owned inert native boundary", parameters: { type: "object" },
      output: { schema: { type: "integer" }, render: (_args, value) => [{ type: "text", text: String(value) }] }, async execute() { return ++bodies; } };
    profile.ctx.tools.register(definition);
    registerNativePermissionRules(profile.ctx, { runtime: owner.backend.runtime,
      identify: current => current === definition ? { kind: "webFetch", context: profile.ctx, assertCurrent() {} } : undefined, assertCurrent() {} });
    await profile.ctx.plugin(ApprovalService, { policy: "ask" }).await();
    profile.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Native exact tool-call approval" }; }, { global: true });
    profile.ctx.on("approval/request", async request => { answers++; pendingSignal = request.signal; await hold?.(); return outcome; }, { global: true });
    owner.root.session.append("turn/start", { turn: 1 });
    const execute = () => profile.ctx.tools.execute({ callId: ToolCallId(randomUUID()), name: definition.name, arguments: {}, agent: owner.root, signal: new AbortController().signal });
    for (const noOp of [false, true]) {
      const previous = owner.backend.runtime.getPolicy(), signal = owner.backend.runtime.signal, entered = gate(), held = gate();
      const beforeBodies = bodies, beforeAnswers = answers;
      release = held.release;
      hold = () => { entered.release(); return held.promise; };
      const pending = execute();
      assert.equal(await Promise.race([entered.promise.then(() => true), pending.then(() => false)]), true, "native call must reach its approval request");
      assert.equal(bodies, beforeBodies); assert.equal(answers, beforeAnswers + 1);
      assert.equal(previous.policy.outsideReads === "deny", noOp);
      const saved = await owner.backend.save({ expectedRevision: previous.revision, changes: { outsideReads: "deny" } }, owner.authority);
      assert.equal(saved.snapshot.revision, owner.deployment.permissionSource().revision); assert.equal(signal.aborted, true);
      const current = owner.backend.runtime.getPolicy();
      assert.notEqual(current, previous); assert.equal(owner.backend.runtime.getPolicy(), current);
      assert.equal(current.policy.outsideReads, "deny"); assert.equal(pendingSignal?.aborted, false);
      held.release(); assert.equal((await pending).isError, false); assert.equal(bodies, beforeBodies + 1);
      assert.equal(owner.root.session.snapshotEvents().filter(event => event.type === "approval/decided").at(-1)?.data.outcome, "allowed-once");
      hold = undefined;
      assert.equal((await execute()).isError, false); assert.equal(bodies, beforeBodies + 2); assert.equal(answers, beforeAnswers + 2);
    }
    const approvedBodies = bodies;
    for (const refusal of ["rejected", "cancelled"] as const) {
      outcome = refusal; assert.equal((await execute()).isError, true); assert.equal(bodies, approvedBodies);
      assert.equal(owner.root.session.snapshotEvents().filter(event => event.type === "approval/decided").at(-1)?.data.outcome, refusal);
    }
    const beforeNever = answers;
    setApprovalPolicy(owner.root.session, "never");
    assert.equal((await execute()).isError, true); assert.equal(bodies, approvedBodies); assert.equal(answers, beforeNever);
  } finally { release(); await run.dispose(); }
});
