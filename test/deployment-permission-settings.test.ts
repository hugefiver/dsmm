import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PERMISSION_CONTROL, resolvePermissionControl } from "../src/permission-settings.ts";
import { DSMM_CONFIG_SCHEMA, DSMM_NATIVE_CONFIG_SCHEMA, resolveConfig, resolveDeployment, validateSparseConfig } from "../src/settings.ts";
import type { DsmmPluginConfig } from "../src/settings.ts";
import { editGlobalConfig, parseGlobalConfig } from "../src/deployment-config.ts";
import { parseProfileDocument } from "../src/profiles.ts";
import { readOnlySettings } from "../src/status.ts";
import { importPermissionRules } from "../src/permission-rules.ts";
import { nativeConfigRun } from "./native-config-fixture.ts";
import { parseNativeCommands } from "../src/permission-settings.ts";
import { parseHostNativeCommands } from "../src/permission-native-command.ts";
import { parsePermissionRulesResult } from "../src/permission-remote.ts";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { DshAgent } from "../src/dsh-types.ts";

const admissionAgent = (agent: Agent): Omit<DshAgent, "ctx"> => agent;

const legacyCommand = { id: "legacy", mode: "ask" as const, sandboxMode: "workspace-write" as const,
  match: { tool: "pwsh" as const, workingDirectory: process.cwd(), commandPattern: "go test" } };

test("simple command config preserves mixed arrays through strict schemas, deployment and permission RPC parsing", () => {
  const nativeCommands = { enabled: true, entries: ["git", "git remote add", "go build|test *", legacyCommand] };
  const global = { permissionControl: { nativeCommands } };
  assert.deepEqual(DSMM_CONFIG_SCHEMA(global), global);
  const native = DSMM_NATIVE_CONFIG_SCHEMA(global).permissionControl as unknown as { get(): unknown };
  assert.deepEqual(native.get(), global.permissionControl);
  assert.deepEqual(parseHostNativeCommands(nativeCommands), nativeCommands);
  const policy = resolvePermissionControl(global.permissionControl);
  const snapshot = { revision: "mixed", policy };
  const runtime = { savedRevision: "mixed", runtimeRevision: "mixed", state: "synced", mounted: true, restartRequired: false };
  assert.deepEqual(parsePermissionRulesResult(JSON.parse(JSON.stringify({ snapshot, runtime }))).snapshot, snapshot);
  assert.deepEqual(resolveDeployment(global, {}).permissionControl.nativeCommands, nativeCommands);
  assert.deepEqual(resolveDeployment(global, { permissionControl: { nativeCommands: { entries: [] } } }).permissionControl.nativeCommands.entries, []);
  assert.deepEqual(resolveDeployment(global, { permissionControl: { nativeCommands: { entries: ["node"] } } }).permissionControl.nativeCommands.entries, ["node"]);
  for (const entry of ["", "git * extra", "git; node", null, { ...legacyCommand, extra: true }, { id: "partial" }, { ...legacyCommand, match: { ...legacyCommand.match, extra: true } }]) {
    const invalid = { permissionControl: { nativeCommands: { enabled: false, entries: ["git", entry] } } };
    assert.throws(() => parseNativeCommands(invalid.permissionControl.nativeCommands));
    assert.throws(() => resolvePermissionControl(invalid.permissionControl as never));
    assert.throws(() => DSMM_CONFIG_SCHEMA(invalid as never));
    assert.throws(() => DSMM_NATIVE_CONFIG_SCHEMA(invalid as never));
  }
});

test("simple command Global and native SettingsForms persist mixed arrays with CAS and inherit on unset", async () => {
  const run = nativeConfigRun({ managedRuntime: true });
  try {
    const profile = await run.createProfile("simple-commands", {});
    const entries = ["git", legacyCommand];
    const saved = await profile.deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["permissionControl", "nativeCommands"], value: { enabled: true, entries } }] }, () => {});
    assert.deepEqual((await profile.deployment.readGlobal()).config.permissionControl?.nativeCommands?.entries, entries);
    const descriptor = profile.descriptor();
    await profile.settings.mutate(descriptor.ns, [{ op: "set", path: ["permissionControl", "nativeCommands", "entries"], value: ["python", legacyCommand] }], descriptor.revision);
    assert.deepEqual(profile.persistedConfig().permissionControl?.nativeCommands?.entries, ["python", legacyCommand]);
    assert.deepEqual((await profile.deployment.readDesired()).settings.permissionControl.nativeCommands.entries, ["python", legacyCommand]);
    await assert.rejects(profile.settings.mutate(descriptor.ns, [{ op: "set", path: ["permissionControl", "nativeCommands", "entries"], value: [] }], descriptor.revision));
    const fresh = profile.descriptor();
    await assert.rejects(profile.settings.mutate(fresh.ns, [{ op: "set", path: ["permissionControl", "nativeCommands", "entries"], value: ["git; other"] }], fresh.revision));
    assert.deepEqual(profile.persistedConfig().permissionControl?.nativeCommands?.entries, ["python", legacyCommand]);
    await profile.settings.mutate(fresh.ns, [{ op: "unset", path: ["permissionControl", "nativeCommands", "entries"] }], fresh.revision);
    assert.deepEqual((await profile.deployment.readDesired()).settings.permissionControl.nativeCommands.entries, entries);
    await assert.rejects(profile.deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["permissionControl", "nativeCommands", "entries"], value: [] }] }, () => {}), { code: "conflict" });
    assert.equal((await profile.deployment.readGlobal()).revision, saved.revision);
  } finally { await run.dispose(); }
});

test("permission-control uses the shared Core default and sparse deployment schema, not named overlays", () => {
  assert.deepEqual(resolveConfig().permissionControl, DEFAULT_PERMISSION_CONTROL);
  assert.deepEqual(DSMM_CONFIG_SCHEMA({}), {});
  const omitted = DSMM_NATIVE_CONFIG_SCHEMA({}).permissionControl as unknown as { get(): unknown };
  assert.equal(omitted.get(), undefined);
  const off: DsmmPluginConfig = { permissionControl: { enabled: false } };
  assert.deepEqual(resolveDeployment(off, {}).permissionControl, resolvePermissionControl(off.permissionControl));
  assert.equal(resolveDeployment(off, { permissionControl: { enabled: true } }).permissionControl.enabled, true);
  assert.equal(resolveDeployment({ modules: { deepwork: { enabled: false } } }, off).permissionControl.enabled, false);
  assert.equal(resolveDeployment({ modules: { deepwork: { enabled: false } } }, {}).permissionControl.enabled, true);
  assert.deepEqual(readOnlySettings(resolveConfig(off)).permissionControl, resolvePermissionControl(off.permissionControl));
  const saved = editGlobalConfig({}, [{ op: "set", path: ["permissionControl", "enabled"], value: false }]);
  assert.deepEqual(parseGlobalConfig(JSON.stringify(saved)), off);
  assert.deepEqual(DSMM_CONFIG_SCHEMA(off), off);
  assert.equal(resolveDeployment(editGlobalConfig(saved, [{ op: "unset", path: ["permissionControl", "enabled"] }]), {}).permissionControl.enabled, true);
  assert.throws(() => parseProfileDocument(JSON.stringify({ version: 1, id: "forbidden-overlay", settings: off })));
  for (const permissionControl of [null, false, { enabled: null }, { enabled: "false" }, { unknown: true }, { webFetch: { enabled: null } }, { webSearch: { unknown: true } }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => validateSparseConfig({ permissionControl }, true));
    assert.throws(() => DSMM_NATIVE_CONFIG_SCHEMA({ permissionControl }));
  }
});

test("permission schemas retain dynamic rules and validate nested edit paths without materializing sparse defaults", () => {
  const rules = importPermissionRules([{ id: "read-policy", action: "ask", match: { kind: "outside-read", path: "fixture-external", scope: "tree" } }], "fixture-import", 3);
  const config: DsmmPluginConfig = { permissionControl: { outsideReads: "deny", webFetch: { enabled: false }, rules } };
  assert.deepEqual(DSMM_CONFIG_SCHEMA(config), config);
  const native = DSMM_NATIVE_CONFIG_SCHEMA(config).permissionControl as unknown as { get(): unknown };
  assert.deepEqual(native.get(), config.permissionControl);
  const edited = editGlobalConfig(config, [{ op: "set", path: ["permissionControl", "webSearch", "rule"], value: "ask" }]);
  assert.equal(resolveConfig(edited).permissionControl.webSearch.rule, "ask");
  assert.equal(resolveConfig(edited).permissionControl.webFetch.enabled, false);
  assert.deepEqual(resolveConfig(edited).permissionControl.rules, rules);
  const settings = resolveConfig(edited), projected = readOnlySettings(settings);
  assert.notEqual(projected.permissionControl.webSearch, settings.permissionControl.webSearch);
  assert.notEqual(projected.permissionControl.rules, settings.permissionControl.rules);
  assert.notEqual(projected.permissionControl.rules[0]!.match, settings.permissionControl.rules[0]!.match);
  assert.throws(() => editGlobalConfig(config, [{ op: "set", path: ["permissionControl", "webSearch", "unexpected"], value: true }]));
});

test("native SettingsForms saves permission desired state with CAS while admissions retain startup policy", async () => {
  const run = nativeConfigRun({ managedRuntime: true });
  try {
    const profile = await run.createProfile("permission-live", { roles: { "dsmm-orchestrator": true } });
    const root = admissionAgent(await profile.create());
    const original = profile.runtime.admission(root);
    assert.equal(resolveConfig(original.settings).permissionControl.enabled, true);
    const descriptor = profile.descriptor();
    await profile.settings.mutate(descriptor.ns, [
      { op: "set", path: ["permissionControl", "enabled"], value: false },
      { op: "set", path: ["permissionControl", "outsideReads"], value: "deny" },
      { op: "set", path: ["permissionControl", "webSearch", "enabled"], value: false }
    ], descriptor.revision);
    profile.assertLive();
    assert.equal(resolveConfig(profile.persistedConfig()).permissionControl.enabled, false);
    assert.equal(resolveConfig((await profile.deployment.readDesired()).settings).permissionControl.enabled, false);
    assert.equal(profile.runtime.admission(root), original);
    const next = admissionAgent(await profile.create());
    const admitted = profile.runtime.admission(next);
    assert.equal(resolveConfig(admitted.settings).permissionControl.enabled, true);
    assert.equal(resolveConfig(admitted.settings).permissionControl.outsideReads, "deny");
    assert.equal(resolveConfig(admitted.settings).permissionControl.webSearch.enabled, false);
    assert.equal(resolveConfig(original.settings).permissionControl.outsideReads, "inherit");
    assert.ok(admitted.restartRequired?.includes("permissionControl.enabled"));
    assert.equal(admitted.sourceCaptures?.fields["permissionControl.outsideReads"], "deployment");
    assert.equal(admitted.sourceCaptures?.fields["permissionControl.webSearch.enabled"], "deployment");
    assert.equal(admitted.sources?.["permissionControl.enabled"], "defaults");
    assert.equal(admitted.sourceCaptures?.fields["permissionControl.enabled"], "startup");
    await assert.rejects(profile.settings.mutate(descriptor.ns, [{ op: "set", path: ["permissionControl", "enabled"], value: true }], descriptor.revision));
    assert.equal(resolveConfig(profile.persistedConfig()).permissionControl.enabled, false);
    const freshConfig: DsmmPluginConfig = { roles: { "dsmm-orchestrator": true }, permissionControl: { enabled: false } };
    const cold = await run.createProfile("permission-cold", freshConfig);
    const coldRoot = admissionAgent(await cold.create());
    assert.equal(resolveConfig(cold.runtime.admission(coldRoot).settings).permissionControl.enabled, false);
    assert.equal(cold.runtime.admission(coldRoot).restartRequired?.includes("permissionControl.enabled"), false);
    assert.equal(profile.runtime.admission(root), original);
  } finally { await run.dispose(); }
});

test("global permission saves retain running startup state and a stale revision cannot overwrite it", async () => {
  const run = nativeConfigRun({ managedRuntime: true });
  try {
    const profile = await run.createProfile("permission-global", { roles: { "dsmm-orchestrator": true } });
    const root = admissionAgent(await profile.create());
    const original = profile.runtime.admission(root);
    const saved = await profile.deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["permissionControl", "enabled"], value: false }] }, () => {});
    assert.equal(resolveConfig(saved.config).permissionControl.enabled, false);
    const read = await profile.deployment.readGlobal();
    assert.equal(resolveConfig(read.config).permissionControl.enabled, false);
    assert.equal(read.revision, saved.revision);
    const next = admissionAgent(await profile.create());
    const admitted = profile.runtime.admission(next);
    assert.equal(resolveConfig(admitted.settings).permissionControl.enabled, true);
    assert.equal(resolveConfig(admitted.deployment!.settings).permissionControl.enabled, false);
    assert.ok(admitted.restartRequired?.includes("permissionControl.enabled"));
    assert.equal(profile.runtime.admission(root), original);
    await assert.rejects(profile.deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["permissionControl", "enabled"], value: true }] }, () => {}), { code: "conflict" });
    assert.equal((await profile.deployment.readGlobal()).revision, saved.revision);
    profile.assertLive();
  } finally { await run.dispose(); }
});
