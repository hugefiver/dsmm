import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ConfigForm, ConfigForms } from "@deepseek-ai/dsh-client-ui-settings/client";
import { build } from "esbuild";
import { cloneElement, createElement, isValidElement } from "react";
import type { ReactElement } from "react";
import type { DeploymentController as Controller } from "../src/client/deployment-controller.ts";
import type { Field as DeploymentField } from "../src/client/DeploymentFields.js";
import type { NativeRuntimeState as RuntimeState } from "../src/client/DeploymentPage.js";
import type { PermissionsPanelProps } from "../src/client/PermissionsPanel.js";
import type { DsmmConfigRemote } from "../src/profile-remote.ts";
import type { DeploymentEditorSnapshot } from "../src/profile-types.ts";
import { PermissionController } from "../src/client/permission-controller.ts";
import { DeploymentWorkspace } from "../src/client/deployment-workspace.ts";
import { PermissionClientError } from "../src/client/permission-client.ts";
import type { PermissionInvoker, PermissionValue } from "../src/client/permission-client.ts";
import { deploymentEn } from "../src/client/deployment-locales.ts";
import { scopeSchema } from "../src/client/deployment-data.ts";
import { permissionEn } from "../src/client/permission-locales.ts";
import { installDeploymentPermissionRules } from "../src/deployment-permission-rules.ts";
import { PermissionRefusal } from "../src/permission-errors.ts";
import { deploymentEditorSchema, resolveConfig } from "../src/settings.ts";
import { runtimeAdmissionView } from "../src/runtime-integration.ts";
import { DEFAULT_PERMISSION_CONTROL } from "../src/permission-settings.ts";
import { nativeConfigRun } from "./permission-deployment-fixture.ts";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";

useIsolatedDshEnvironment();
const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const bundle = await build({ absWorkingDir: sourceRoot, stdin: { resolveDir: sourceRoot, contents: `
  export { Field } from './src/client/DeploymentFields.tsx';
  export { NativeRuntimeState } from './src/client/DeploymentPage.tsx';
  export { DeploymentController } from './src/client/deployment-controller.ts';
  export { PermissionsPanel } from './src/client/PermissionsPanel.tsx';
  export { emptyNativeEntry } from './src/client/NativeCommandEntries.tsx';
` }, bundle: true, write: false, format: "cjs", platform: "node", target: "es2022", external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives", "jsonc-parser"] });
const require = createRequire(import.meta.url), module = { exports: {} as {
  Field: typeof DeploymentField; NativeRuntimeState: typeof RuntimeState; DeploymentController: typeof Controller;
  PermissionsPanel(props: PermissionsPanelProps): unknown;
  emptyNativeEntry(): import("../src/permission-settings.ts").NativeCommandRule;
} };
// Production component handlers with native durable forms; this seam is not rendered browser QA.
runInThisContext(`(function(require,module,exports){${bundle.outputFiles[0].text}\n})`)((id: string) => {
  if (id === "react") return { ...require(id), useEffect() {}, useMemo: (fn: () => unknown) => fn(), useId: () => "permission-fixture", useState: (value: unknown) => [value, () => {}], useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get() };
  if (id === "@deepseek-ai/dsh-client-ui-primitives") return { Button: (props: Record<string, unknown>) => createElement("button", props), Input: (props: Record<string, unknown>) => createElement("input", props) };
  return require(id);
}, module, module.exports);
const { Field, NativeRuntimeState, DeploymentController, PermissionsPanel, emptyNativeEntry } = module.exports;
type Node = ReactElement<Record<string, unknown>>;
function nodes(tree: unknown): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return isValidElement<Record<string, unknown>>(tree) ? [tree, ...nodes(tree.props.children)] : [];
}
function render(tree: unknown): unknown {
  if (Array.isArray(tree)) return tree.map(render);
  if (!isValidElement<Record<string, unknown>>(tree)) return tree;
  if (typeof tree.type === "function") return render((tree.type as (props: unknown) => unknown)(tree.props));
  return cloneElement(tree, { children: render(tree.props.children) });
}
function text(tree: unknown): string {
  return Array.isArray(tree) ? tree.map(text).join("") : isValidElement<Record<string, unknown>>(tree) ? text(tree.props.children) : typeof tree === "string" || typeof tree === "number" ? String(tree) : "";
}
function event(node: Node, value: string) { assert.equal(node.props.disabled, false); (node.props.onChange as (event: unknown) => void)({ currentTarget: { value } }); }
function click(node: Node) { assert.equal(node.props.disabled, false); (node.props.onClick as () => void)(); }
function field(tree: unknown, path: string): Node {
  const group = nodes(tree).find(node => node.props["data-field"] === path);
  assert.ok(group, path); return nodes(group).find(node => node.type === "select")!;
}
function details(tree: unknown, path: string): Node {
  const group = nodes(tree).find(node => node.props["data-field"] === path);
  assert.ok(group, path); return group;
}
async function fixture() {
  const run = nativeConfigRun(), profile = await run.createProfile("permission-ui");
  const backend = installDeploymentPermissionRules(profile.ctx, { deployment: profile.deployment, assertWritable() {}, revoke() {}, async notify() {} });
  const root = await profile.create(), lifetime = new AbortController();
  const authority = { root, peer: {}, signal: lifetime.signal, assertCurrent() { lifetime.signal.throwIfAborted(); assert.equal(profile.ctx.agents.get(root.id), root); } };
  const startup = resolveConfig(), writes: unknown[] = [], mutations: unknown[] = [];
  const describe = async (): Promise<DeploymentEditorSnapshot> => {
    const value = await profile.deployment.readDesired();
    return { entryId: value.entryId, namespace: value.nativeNamespace ?? null, hostProfileKey: value.hostProfileKey,
      global: value.global as Record<string, unknown>, globalRevision: value.globalRevision, profile: { ...value.profile }, nativeRevision: value.nativeRevision,
      nativeFormRevision: value.nativeFormRevision ?? null, nativeForm: { base: value.nativeForm?.base ?? null, user: value.nativeForm?.user ?? null },
      desired: { ...value.settings }, sources: value.sources, defaults: { ...resolveConfig() }, startup: { ...startup }, schema: deploymentEditorSchema(), nativeSchema: deploymentEditorSchema(true), subagentRuntime: runtimeAdmissionView(profile.ctx), nextRoot: null, modules: [] };
  };
  const remote: DsmmConfigRemote = { describe: async () => ({ ok: true, value: await profile.deployment.readGlobal() }), describeSettings: async () => ({ ok: true, value: await describe() }), describeModules: async () => ({ ok: true, value: [] }),
    save: async request => { writes.push(request); return { ok: true, value: await profile.deployment.saveGlobal(request, () => {}) }; } };
  const global = new DeploymentController(remote, "global"), native = new DeploymentController(remote, "profile", profile.descriptor().ns);
  const attach = async (writable = true, mutate?: ConfigForm<Record<string, unknown>>["mutate"]) => {
    const value = await describe();
    native.attachForm({ state: { status: "ready", writable, revision: value.nativeFormRevision!, value: value.profile, base: value.nativeForm!.base, user: value.nativeForm!.user },
      mutate: mutate ?? (async (edits, revision) => { mutations.push({ edits, revision }); await profile.settings.mutate(profile.descriptor().ns, [...edits], revision!); await attach(); return true; }) });
  };
  await attach(); await global.refresh(); await native.refresh();
  const deploymentCopy: Readonly<Record<string, string>> = deploymentEn;
  const page = (controller: Controller, key = "permissionControl") => render(createElement(Field, { schema: scopeSchema(controller.getSnapshot().snapshot!, controller.layer).fields![key], path: [key], controller, t: key => deploymentCopy[key] ?? key }));
  return { run, profile, backend, root, authority, global, native, remote, writes, mutations, attach, page,
    async cleanup() { lifetime.abort(); global.dispose(); native.dispose(); await run.dispose(); } };
}

test("command patterns: the config form edits, saves, rereads and Unsets both durable layers without broadening inherited rules", async () => {
  const f = await fixture();
  const rules = [{ id: "web-deny", action: "deny", match: { kind: "webFetch" }, source: { kind: "user-import", label: "fixture" }, revision: 0, revoked: false }];
  const entriesPath = "permissionControl.nativeCommands.entries";
  try {
    for (const c of [f.global, f.native]) {
      if (c === f.native) { await f.attach(); await c.refresh(true); }
      for (const [path, value] of [["enabled", "false"], ["outsideReads", '"ask"'], ["webSearch.enabled", "false"], ["webSearch.rule", '"ask"'], ["webFetch.enabled", "false"], ["webFetch.rule", '"deny"'], ["nativeCommands.enabled", "true"]]) event(field(f.page(c), `permissionControl.${path}`), value);
      const entries = () => details(f.page(c), entriesPath);
      if (c === f.native) {
        // Clear inherited rows explicitly before constructing this layer's replacement.
        const remove = nodes(entries()).find(node => node.type === "button" && text(node).replace(/\s+/gu, " ").trim() === `${permissionEn.removeEntry} 1`);
        assert.ok(remove); click(remove);
      }
      click(nodes(entries()).find(node => node.type === "button" && text(node) === permissionEn.addEntry)!);
      const input = (key: string) => nodes(entries()).find(node => node.type === "input" && String(node.props.id).endsWith(`-${key}`))!;
      event(input("pattern"), "go test");
      event(nodes(details(f.page(c), "permissionControl.rules")).find(node => node.type === "textarea")!, JSON.stringify(rules));
      await c.save(); assert.deepEqual({ layer: c.layer, saved: c.getSnapshot().saved, issue: c.getSnapshot().issue }, { layer: c.layer, saved: true, issue: null });
      const stored = c === f.global ? (await f.profile.deployment.readGlobal()).config : f.profile.persistedConfig();
      assert.deepEqual(stored.permissionControl?.nativeCommands, { enabled: true, entries: ["go test"] });
      assert.equal(stored.permissionControl?.rules?.[0].source.kind, "user-import");
      assert.equal(f.backend.runtime.status().mounted, true); assert.equal(f.backend.runtime.status().restartRequired, true);
      assert.equal(f.backend.runtime.status().state, "synced");
      await c.refresh(true); assert.deepEqual(c.getSnapshot().draft.permissionControl, stored.permissionControl);
      if (c === f.native) {
        assert.equal(f.writes.length, 1); assert.equal(f.mutations.length, 1);
        assert.equal((f.mutations[0] as { revision: number }).revision, 0);
      }
    }
    // Native Unset restores Global, including the command array, not default-filled pins.
    for (const c of [f.native, f.global]) {
      for (const path of ["enabled", "outsideReads", "webSearch.enabled", "webSearch.rule", "webFetch.enabled", "webFetch.rule", "nativeCommands.enabled"]) event(field(f.page(c), `permissionControl.${path}`), "inherit");
      for (const path of ["permissionControl.rules", entriesPath]) click(nodes(details(f.page(c), path)).find(node => node.type === "button" && node.props["data-dsmm-unset"] === path)!);
      await c.save(); assert.equal(c.getSnapshot().saved, true); await c.refresh(true);
      const desired = await f.profile.deployment.readDesired();
      if (c === f.native) assert.deepEqual(desired.settings.permissionControl, resolveConfig({ permissionControl: (await f.profile.deployment.readGlobal()).config.permissionControl }).permissionControl);
      else assert.deepEqual(desired.settings.permissionControl, DEFAULT_PERMISSION_CONTROL);
      f.profile.assertLive();
    }
  } finally { await f.cleanup(); }
});

test("command patterns: real handlers round-trip pattern rows through both layers and Unset them without broadening inherited rules", async () => {
  const f = await fixture();
  try {
    const path = "permissionControl.nativeCommands.entries";
    const group = (c: Controller) => details(f.page(c), path);
    const input = (c: Controller, key: string) => nodes(group(c)).find(node => node.type === "input" && String(node.props.id).endsWith(`-${key}`))!;
    const add = (c: Controller) => click(nodes(group(c)).find(node => node.type === "button" && text(node) === permissionEn.addEntry)!);

    add(f.global);
    event(input(f.global, "pattern"), "go build|test *");
    await f.global.save();
    assert.equal(f.global.getSnapshot().saved, true);
    const globalEntries = () => f.profile.deployment.readGlobal().then(value => value.config.permissionControl?.nativeCommands?.entries);
    assert.deepEqual(await globalEntries(), ["go build|test *"]);
    await f.global.refresh(true);
    assert.equal(input(f.global, "pattern").props.value, "go build|test *");

    // The native layer stores its own replacement pattern, leaving the Global rule untouched.
    await f.attach(); await f.native.refresh(true);
    const remove = nodes(group(f.native)).find(node => node.type === "button" && text(node).trim() === `${permissionEn.removeEntry} 1`)!;
    click(remove); add(f.native);
    event(input(f.native, "pattern"), "go test");
    await f.native.save(); assert.equal(f.native.getSnapshot().saved, true);
    assert.deepEqual(f.profile.persistedConfig().permissionControl?.nativeCommands?.entries, ["go test"]);
    assert.deepEqual(await globalEntries(), ["go build|test *"]);

    // Native Unset restores the Global rule rather than default-filling one.
    click(nodes(group(f.native)).find(node => node.props["data-dsmm-unset"] === path)!);
    await f.native.save(); await f.native.refresh(true);
    assert.equal(f.profile.persistedConfig().permissionControl?.nativeCommands?.entries, undefined);
    assert.equal(input(f.native, "pattern").props.value, "go build|test *", "profile shows the inherited Global pattern");
    click(nodes(group(f.global)).find(node => node.props["data-dsmm-unset"] === path)!);
    await f.global.save(); await f.global.refresh(true);
    assert.equal((await f.profile.deployment.readGlobal()).config.permissionControl?.nativeCommands?.entries, undefined);
    assert.equal((await f.profile.deployment.readDesired()).settings.permissionControl.nativeCommands.entries.length, 0);
  } finally { await f.cleanup(); }
});

test("command patterns: invalid drafts lock Save, raw text stays per row, and stale CAS never persists", async () => {
  const f = await fixture();
  try {
    const path = "permissionControl.nativeCommands.entries", c = f.global;
    const group = () => details(f.page(c), path);
    const patternRow = (row: number) => nodes(group()).filter(node => node.type === "input" && String(node.props.id).endsWith("-pattern"))[row]!;
    for (let row = 0; row < 2; row++) click(nodes(group()).find(node => node.type === "button" && text(node) === permissionEn.addEntry)!);
    event(patternRow(0), "go build||test");
    assert.equal(c.getSnapshot().raw[`${path}.0`]?.invalid, true);
    assert.equal(patternRow(0).props.value, "go build||test", "invalid pattern bytes stay visible");
    await c.save(); assert.equal(f.writes.length, 0);

    // Correcting the first row leaves the second row's own draft and edits intact.
    event(patternRow(0), "go build|test");
    assert.equal(c.getSnapshot().raw[`${path}.0`]?.invalid, false);
    assert.equal(c.getSnapshot().raw[`${path}.1`]?.invalid, true, "the untouched empty row keeps its own draft state and is invalid");
    assert.equal(c.canSave(), false, "the second row is still incomplete");

    // A conflicting Global revision is detected before any write and keeps both rows' edits.
    event(patternRow(1), "go test");
    assert.equal(c.canSave(), true, "both rows are now valid");
    const raw = structuredClone(c.getSnapshot().raw);
    await f.profile.deployment.saveGlobal({ expectedRevision: (await f.profile.deployment.readGlobal()).revision, edits: [{ op: "set", path: ["defaultActive"], value: true }] }, () => {});
    await c.save();
    assert.equal(c.getSnapshot().issue, "conflict"); assert.equal(f.writes.length, 0); assert.equal(c.getSnapshot().saved, false);
    assert.deepEqual(c.getSnapshot().raw, raw);
    assert.equal((await f.profile.deployment.readGlobal()).config.permissionControl?.nativeCommands, undefined);

    // Discarding the stale base and re-entering the pattern persists real bytes.
    await c.refresh(true);
    click(nodes(group()).find(node => node.type === "button" && text(node) === permissionEn.addEntry)!);
    event(patternRow(0), "go build|test *");
    await c.save(); assert.equal(c.getSnapshot().saved, true);
    assert.deepEqual((await f.profile.deployment.readGlobal()).config.permissionControl?.nativeCommands?.entries, [
      "go build|test *",
    ]);
  } finally { await f.cleanup(); }
});

test("command patterns: removing a row clears only that row's draft and reindexes the remaining draft", async () => {
  const f = await fixture();
  try {
    const path = "permissionControl.nativeCommands.entries", c = f.global;
    const group = () => details(f.page(c), path);
    const add = () => click(nodes(group()).find(node => node.type === "button" && text(node) === permissionEn.addEntry)!);
    const patternRow = (row: number) => nodes(group()).filter(node => node.type === "input" && String(node.props.id).endsWith("-pattern"))[row]!;
    for (let row = 0; row < 2; row++) add();
    event(patternRow(0), "go build");
    event(patternRow(1), "go build||test");
    assert.equal(c.getSnapshot().raw[`${path}.1`]?.invalid, true);

    click(nodes(group()).find(node => node.type === "button" && text(node) === `${permissionEn.removeEntry} 1`)!);
    assert.equal(c.getSnapshot().raw[`${path}.1`], undefined, "the removed row's draft is gone");
    assert.deepEqual(c.getSnapshot().raw[`${path}.0`], { text: "go build||test", invalid: true }, "the surviving draft follows its row");
    assert.equal(patternRow(0).props.value, "go build||test");
    await c.save(); assert.equal(f.writes.length, 0, "the shifted invalid draft still locks Save");
    event(patternRow(0), "go test");
    await c.save(); assert.equal(c.getSnapshot().saved, true);
    assert.deepEqual((await f.profile.deployment.readGlobal()).config.permissionControl?.nativeCommands?.entries, [
      "go test",
    ]);
  } finally { await f.cleanup(); }
});

test("command patterns: a saved legacy entry displays compact read-only summary with details, allows deletion, and the UI adds simple string entries without widening", async () => {
  const f = await fixture();
  const path = "permissionControl.nativeCommands.entries";
  try {
    const legacyEntry = { id: "saved-full", mode: "allow" as const, sandboxMode: "danger-full-access" as const, match: { tool: "pwsh" as const, workingDirectory: f.run.root, commandPattern: "go test" } };
    await f.profile.deployment.saveGlobal({ expectedRevision: (await f.profile.deployment.readGlobal()).revision, edits: [{ op: "set", path: ["permissionControl", "nativeCommands"], value: { enabled: true, entries: [legacyEntry] } }] }, () => {});
    const c = f.global; await c.refresh(true);
    const group = () => details(f.page(c), path);

    const legacyRow = () => nodes(group()).find(node => typeof node.props.className === "string" && node.props.className.includes("dsmm-legacy-entry"));
    assert.ok(legacyRow(), "legacy entry is rendered");
    assert.ok(text(legacyRow()).includes(permissionEn.legacyEntry));
    assert.ok(text(legacyRow()).includes("go test"));
    assert.ok(text(legacyRow()).includes("pwsh"));
    assert.ok(text(legacyRow()).includes(f.run.root));
    assert.ok(text(legacyRow()).includes("danger-full-access"));

    // Add entry: adds a simple string rule, preserving legacy entry intact without lossy conversion
    click(nodes(group()).find(node => node.type === "button" && text(node) === permissionEn.addEntry)!);
    const stringInput = nodes(group()).find(node => node.type === "input" && String(node.props.id).endsWith("-pattern"))!;
    assert.ok(stringInput);
    event(stringInput, "git status");
    await c.save(); assert.equal(c.getSnapshot().saved, true);
    assert.deepEqual((await f.profile.deployment.readGlobal()).config.permissionControl?.nativeCommands?.entries, [
      legacyEntry,
      "git status",
    ]);

    // Deleting the legacy row removes it cleanly and leaves string entry
    const removeLegacy = nodes(group()).find(node => node.type === "button" && text(node) === `${permissionEn.removeEntry} 1`)!;
    click(removeLegacy);
    await c.save(); assert.equal(c.getSnapshot().saved, true);
    assert.deepEqual((await f.profile.deployment.readGlobal()).config.permissionControl?.nativeCommands?.entries, [
      "git status",
    ]);
  } finally { await f.cleanup(); }
});

test("command patterns: a new entry stays invalid until patterns are valid and Unset restores inheritance", async () => {
  const f = await fixture();
  try {
    const c = f.global, entry = emptyNativeEntry();
    assert.equal(entry, "");
    const path = "permissionControl.nativeCommands.entries", group = () => details(f.page(c), path);
    click(nodes(group()).find(node => node.type === "button" && text(node) === permissionEn.addEntry)!);
    await c.save(); assert.equal(f.writes.length, 0);
    const input = () => nodes(group()).find(node => node.type === "input" && String(node.props.id).endsWith("-pattern"))!;
    for (const invalid of ["", "   ", "go build||test", "; rm -rf", "git status * *"]) {
      event(input(), invalid);
      assert.equal(c.getSnapshot().raw[`${path}.0`]?.invalid, true, invalid);
      await c.save(); assert.equal(f.writes.length, 0, invalid);
    }
    event(input(), "go build|test *");
    assert.equal(c.getSnapshot().raw[`${path}.0`]?.invalid, false);
    await c.save(); assert.equal(c.getSnapshot().saved, true);
    assert.deepEqual((await f.profile.deployment.readGlobal()).config.permissionControl?.nativeCommands?.entries, [
      "go build|test *",
    ]);
    click(nodes(group()).find(node => node.props["data-dsmm-unset"] === path)!);
    await c.save(); await c.refresh(true);
    assert.equal((await f.profile.deployment.readGlobal()).config.permissionControl?.nativeCommands?.entries, undefined);
    assert.equal(c.getSnapshot().raw[`${path}.0`], undefined, "Unset clears the row's raw draft");
  } finally { await f.cleanup(); }
});

test("profile dynamic override refuses Root rules Save without a Global fallback, and native Unset restores inheritance", async () => {
  const f = await fixture(), c = new PermissionController();
  try {
    event(field(f.page(f.native), "permissionControl.outsideReads"), '"deny"'); await f.native.save();
    const invoke: PermissionInvoker = async (method, args) => {
      try { return (method === "describeRules" ? { snapshot: await f.backend.read(f.authority), runtime: f.backend.runtime.status() } : await f.backend.save(args[1]!, f.authority)) as PermissionValue<typeof method>; }
      catch (error) { throw new PermissionClientError(error instanceof PermissionRefusal ? error.code : "unavailable"); }
    };
    c.bindConnection(invoke, {}); c.bindScope(f.root.id, f.root, "root");
    let generation = c.store.getSnapshot().generation; await c.refresh(generation);
    c.edit(generation, { outsideReads: "ask" }); await c.save(generation);
    assert.equal(c.store.getSnapshot().rulesIssue, "unavailable"); assert.equal(c.store.getSnapshot().dirty, true);
    assert.equal(c.canEdit(generation), false); assert.equal(f.writes.length, 0);
    assert.deepEqual((await f.profile.deployment.readGlobal()).config, {});
    event(field(f.page(f.native), "permissionControl.outsideReads"), "inherit"); await f.native.save();
    await c.refresh(generation, true); assert.equal(c.store.getSnapshot().draft?.outsideReads, "inherit");
    c.edit(generation, { outsideReads: "ask" }); await c.save(generation); assert.equal(c.store.getSnapshot().notice, "saved");
    c.bindConnection(null); generation = c.store.getSnapshot().generation;
    c.edit(generation, { outsideReads: "deny" }); assert.equal(c.store.getSnapshot().draft?.outsideReads, "ask");
    assert.equal(c.store.getSnapshot().display?.snapshot.policy.outsideReads, "ask");
    const permissionCopy: Readonly<Record<string, string>> = permissionEn;
    const tree = render(PermissionsPanel({ controller: c, t: key => permissionCopy[key] ?? key }));
    assert.ok(nodes(tree).filter(node => node.type === "select").every(node => node.props.disabled === true));
    assert.ok(text(tree).includes(permissionEn.unconfirmedObservation), "the retained projection is disclosed as unconfirmed");
    assert.ok(text(tree).includes(permissionEn.sandboxScope), "the Host sandbox boundary is stated once");
    const child = await f.profile.create(f.root); c.bindScope(child.id, child, "child");
    assert.equal(c.canEdit(c.store.getSnapshot().generation), false);
  } finally { c.dispose(); await f.cleanup(); }
});

test("native empty policy groups can be explicitly Unset through the form to restore Root Global-rule ownership", async () => {
  const f = await fixture();
  try {
    await f.profile.settings.mutate(f.profile.descriptor().ns, [{ op: "set", path: ["permissionControl", "webFetch"], value: {} }], f.profile.descriptor().revision);
    await f.attach(); await f.native.refresh(true);
    const before = await f.backend.read(f.authority);
    await assert.rejects(f.backend.save({ expectedRevision: before.revision, changes: { outsideReads: "ask" } }, f.authority), error => error instanceof PermissionRefusal && error.code === "unavailable");
    const unset = nodes(details(f.page(f.native), "permissionControl.webFetch")).find(node => node.props["data-dsmm-unset"] === "permissionControl.webFetch");
    assert.ok(unset); click(unset); await f.native.save(); assert.equal(f.native.getSnapshot().saved, true); assert.equal(f.writes.length, 0);
    const inherited = await f.backend.read(f.authority);
    const saved = await f.backend.save({ expectedRevision: inherited.revision, changes: { outsideReads: "ask" } }, f.authority);
    assert.equal(saved.snapshot.policy.outsideReads, "ask"); assert.equal(saved.runtime.state, "synced");
  } finally { await f.cleanup(); }
});

test("native readonly and detached forms retain visible config but cannot edit or call mutate", async () => {
  const f = await fixture();
  try {
    await f.attach(false);
    const tree = f.page(f.native);
    assert.equal(field(tree, "permissionControl.outsideReads").props.disabled, true);
    f.native.edit(["permissionControl", "outsideReads"], "deny"); await f.native.save();
    assert.equal(f.mutations.length, 0); assert.equal(f.writes.length, 0);
    f.native.attachForm(null); assert.equal(f.native.canWriteProfile(), false);
  } finally { await f.cleanup(); }
});

test("module and scope transitions retain invalid raw drafts and save only the selected native transaction", async () => {
  const f = await fixture(), workspace = new DeploymentWorkspace(f.global);
  try {
    const readForm = async () => {
      const result = await f.remote.describeSettings(); assert.equal(result.ok, true); if (!result.ok) throw new Error("Fixture unavailable"); const v = result.value;
      return { status: "ready" as const, writable: true, revision: v.nativeFormRevision!, value: v.profile, base: v.nativeForm!.base, user: v.nativeForm!.user };
    };
    let formState = await readForm(); const listeners = new Set<() => void>();
    const form = { getSnapshot: () => formState, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async mutate(edits: Parameters<ConfigForm<Record<string, unknown>>["mutate"]>[0], revision?: number) {
        await f.profile.settings.mutate(f.profile.descriptor().ns, [...edits], revision!); formState = await readForm(); for (const listener of listeners) listener(); return true;
      } };
    workspace.bindForms({ get(namespace: string) { assert.equal(namespace, f.profile.descriptor().ns); return form; } } as unknown as ConfigForms);
    const native = workspace.controller("profile")!;
    for (let round = 0; round < 100 && (native.getSnapshot().busy || native.getSnapshot().snapshot === null); round++) await setImmediate();
    assert.equal(native.canWriteProfile(), true);
    workspace.request({ scope: "global", module: "permissions" });
    event(nodes(details(f.page(f.global), "permissionControl.rules")).find(node => node.type === "textarea")!, "{unfinished");
    workspace.request({ scope: "global", module: "run" }); assert.notEqual(workspace.getSnapshot().pending, null); workspace.continueEditing();
    workspace.request({ scope: "global", module: "run" }); workspace.keepAndNavigate();
    assert.equal(workspace.getSnapshot().pending, null); assert.equal(workspace.getSnapshot().module, "run");
    const numeric = nodes(f.page(f.global, "workflow")).find(node => node.props["data-field"] === "workflow.reviewCap")!;
    event(nodes(numeric).find(node => node.type === "input")!, "not-a-number");
    const raw = structuredClone(f.global.getSnapshot().raw);
    workspace.request({ scope: "profile", module: "permissions" }); workspace.keepAndNavigate();
    for (let round = 0; round < 100 && native.getSnapshot().busy; round++) await setImmediate();
    event(field(f.page(native), "permissionControl.outsideReads"), '"deny"'); await workspace.save();
    assert.equal(native.getSnapshot().saved, true); assert.equal((await f.profile.deployment.readDesired()).profile.permissionControl?.outsideReads, "deny");
    assert.equal(f.writes.length, 0); assert.deepEqual(f.global.getSnapshot().raw, raw); assert.equal(f.global.canSave(), false);
    workspace.request({ scope: "global", module: "permissions" });
    for (let round = 0; round < 100 && f.global.getSnapshot().busy; round++) await setImmediate();
    assert.deepEqual(f.global.getSnapshot().raw, raw);
    assert.equal(nodes(details(f.page(f.global), "permissionControl.rules")).find(node => node.type === "textarea")!.props.value, "{unfinished");
    await workspace.save(); assert.equal(f.writes.length, 0);
    workspace.request({ scope: "global", module: "run" }); await workspace.discardAndNavigate();
    assert.equal(workspace.getSnapshot().module, "run"); assert.deepEqual(f.global.getSnapshot().raw, {}); assert.equal(f.global.getSnapshot().dirty, false);
    assert.equal((await f.profile.deployment.readDesired()).profile.permissionControl?.outsideReads, "deny");
  } finally { workspace.dispose(); await f.cleanup(); }
});

test("accepted Global mutation requiring refresh stays saved and never replays an unavailable version", async () => {
  const f = await fixture();
  try {
    const save = f.remote.save;
    f.remote.save = async request => { const accepted = await save(request); assert.equal(accepted.ok, true); if (!accepted.ok) return accepted; return { ok: true, value: { ...accepted.value, revision: "unavailable", refreshRequired: true } }; };
    f.global.edit(["defaultActive"], true); await f.global.save();
    assert.deepEqual({ saved: f.global.getSnapshot().saved, dirty: f.global.getSnapshot().dirty, refreshRequired: f.global.getSnapshot().refreshRequired, issue: f.global.getSnapshot().issue }, { saved: true, dirty: false, refreshRequired: true, issue: null });
    f.global.edit(["defaultActive"], false); await f.global.save(); assert.equal(f.writes.length, 1);
    assert.equal((await f.profile.deployment.readGlobal()).config.defaultActive, true);
    assert.notEqual((f.writes[0] as { expectedRevision: string }).expectedRevision, "unavailable");
    await f.global.refresh(); assert.equal(f.global.getSnapshot().refreshRequired, false); assert.equal(f.global.canEdit(), true);
  } finally { await f.cleanup(); }
});

test("unconfirmed native form result retains the draft and prevents replay until authoritative reread", async () => {
  const f = await fixture(); let mutations = 0;
  try {
    await f.attach(true, async (edits, revision) => {
      mutations++; await f.profile.settings.mutate(f.profile.descriptor().ns, [...edits], revision!); return false;
    });
    f.native.edit(["defaultActive"], true); await f.native.save();
    assert.equal((await f.profile.deployment.readDesired()).profile.defaultActive, true);
    assert.equal(f.native.getSnapshot().issue, "unconfirmed"); assert.equal(f.native.getSnapshot().dirty, true); assert.equal(f.native.getSnapshot().saved, false);
    assert.equal(f.native.canSave(), false); await f.native.save(); assert.equal(mutations, 1); assert.equal(f.writes.length, 0);
    await f.native.refresh(); assert.equal(f.native.getSnapshot().dirty, true); assert.equal(f.native.canSave(), false);
    await f.attach(); await f.native.refresh(true); assert.equal(f.native.getSnapshot().dirty, false); assert.equal(f.native.canEdit(), true); assert.equal(mutations, 1);
  } finally { await f.cleanup(); }
});

test("imported configuration rules use the record list and honest Host provenance", async () => {
  const f = await fixture();
  try {
    const c = f.global, name = "permissionControl.rules", group = () => details(f.page(c), name);
    assert.equal((c.getSnapshot().draft.permissionControl as Record<string, unknown> | undefined)?.rules, undefined, "an untouched layer stays sparse");
    click(nodes(group()).find(node => node.type === "button" && text(node) === permissionEn.addRule)!);
    const input = (key: string) => nodes(group()).find(node => node.type === "input" && String(node.props.id).endsWith(`-${key}`))!;
    const select = (key: string) => nodes(group()).find(node => node.type === "select" && String(node.props.id).endsWith(`-${key}`))!;
    event(input("id"), "imported-denial"); event(select("action"), "deny");
    event(input("path"), "C:\\owned\\outside"); event(select("scope"), "tree");
    const draftRule = (c.getSnapshot().draft.permissionControl as { rules: readonly import("../src/permission-rules.ts").PermissionRule[] }).rules[0]!;
    assert.deepEqual(draftRule.source, { kind: "user-import", label: "configuration" }, "the form never claims operator approval");
    assert.equal(draftRule.revision, 0); assert.equal(draftRule.revoked, false);
    await c.save(); assert.equal(c.getSnapshot().saved, true);
    const stored = (await f.profile.deployment.readGlobal()).config.permissionControl?.rules?.[0];
    assert.deepEqual(stored, { id: "imported-denial", action: "deny", match: { kind: "outside-read", path: "C:\\owned\\outside", scope: "tree" },
      source: { kind: "user-import", label: "global-settings" }, revision: 0, revoked: false });
    assert.equal(f.backend.runtime.status().state, "synced");
    // Records keep real source, revision and revocation visible; the form never fabricates approval.
    await c.refresh(true);
    assert.ok(text(group()).includes(`${permissionEn.source}${permissionEn.imported}`));
    assert.ok(text(group()).includes(`${permissionEn.recordVersion}0`));
    const textarea = () => nodes(group()).find(node => node.type === "textarea")!;
    event(textarea(), JSON.stringify([{ ...stored, revoked: true }])); await c.save(); await c.refresh(true);
    assert.ok(text(group()).includes(permissionEn.revoked));
    const storedRevoked = () => f.profile.deployment.readGlobal().then(value => value.config.permissionControl?.rules?.[0]);
    assert.equal((await storedRevoked())?.revoked, true);
    // A structured edit keeps the stored source, revision and revocation instead of fabricating them.
    event(nodes(group()).find(node => node.type === "select" && node.props.value === "deny")!, "allow"); await c.save(); await c.refresh(true);
    assert.deepEqual(await storedRevoked(), { ...stored, action: "allow", revoked: true }, "structured edits preserve real provenance");
    // Invalid raw JSON keeps its bytes, disables structured edits and locks this transaction's Save.
    const writes = f.writes.length;
    event(textarea(), "{unfinished");
    assert.equal(c.getSnapshot().raw[name]?.text, "{unfinished"); assert.equal(c.canSave(), false);
    assert.equal(nodes(group()).filter(node => node.type === "input" || node.type === "select").every(node => node.props.disabled === true), true);
    await c.save(); assert.equal(f.writes.length, writes);
    event(textarea(), "[]");
    assert.equal(c.canSave(), true); await c.save(); assert.equal((await f.profile.deployment.readGlobal()).config.permissionControl?.rules?.length, 0, "an explicit empty list replaces inherited records");
    click(nodes(group()).find(node => node.props["data-dsmm-unset"] === name)!);
    await c.save();
    assert.equal((await f.profile.deployment.readGlobal()).config.permissionControl?.rules, undefined, "Unset removes only this layer's list");
  } finally { await f.cleanup(); }
});

test("Global rules transaction offers a non-destructive Refresh and an explicit discard-and-reload", async () => {
  const { PermissionController } = await import("../src/client/permission-controller.ts");
  const { deferred } = await import("./permission-fixture.ts");
  type Value = PermissionValue<"describeRules">;
  const value = (revision: string, outsideReads: PermissionValue<"describeRules">["snapshot"]["policy"]["outsideReads"]): Value => ({
    snapshot: { revision, policy: { ...DEFAULT_PERMISSION_CONTROL, outsideReads } },
    runtime: { savedRevision: revision, runtimeRevision: revision, state: "synced", mounted: true, restartRequired: false },
  });
  const c = new PermissionController(), held = deferred<Value>();
  let describes = 0;
  const invoke: PermissionInvoker = async method => {
    if (method !== "describeRules") throw new Error("unexpected write");
    describes++;
    return (describes === 4 ? await held.promise : describes >= 5 ? value("r2", "ask") : value("r0", "inherit")) as PermissionValue<typeof method>;
  };
  c.bindConnection(invoke, {}); c.bindScope("owned-root", {}, "root");
  const stop = c.watch(), copy: Readonly<Record<string, string>> = permissionEn;
  const tree = () => render(PermissionsPanel({ controller: c, t: key => copy[key] ?? key }));
  const button = (label: string) => nodes(tree()).find(node => node.type === "button" && text(node) === label)!;
  const settle = async (predicate: () => boolean) => { for (let round = 0; round < 300 && !predicate(); round++) await new Promise(resolve => setTimeout(resolve, 5)); };
  try {
    await settle(() => c.store.getSnapshot().rules !== null);
    assert.equal(button(permissionEn.refresh).props.disabled, false);
    assert.equal(button(permissionEn.discard).props.disabled, true, "a clean, non-conflicted draft has nothing to discard");
    click(button(permissionEn.refresh));
    assert.equal(c.store.getSnapshot().reading, true, "the rules transaction has its own visible refresh");
    await settle(() => !c.store.getSnapshot().reading);
    const generation = c.store.getSnapshot().generation;
    c.edit(generation, { outsideReads: "deny" });
    assert.equal(button(permissionEn.refresh).props.disabled, false); assert.equal(button(permissionEn.discard).props.disabled, false);
    assert.equal(c.canSave(generation), true);
    // A non-destructive refresh keeps the dirty draft and its base.
    click(button(permissionEn.refresh)); await settle(() => !c.store.getSnapshot().reading);
    assert.equal(c.store.getSnapshot().dirty, true); assert.equal(c.store.getSnapshot().draft!.outsideReads, "deny");
    // Refresh with a newer revision flags a stale CAS conflict.
    click(button(permissionEn.refresh));
    await settle(() => describes === 4);
    assert.equal(c.store.getSnapshot().reading, true);
    held.resolve(value("r1", "allow")); await settle(() => !c.store.getSnapshot().reading);
    const stale = c.store.getSnapshot();
    assert.equal(stale.base!.revision, "r0"); assert.equal(stale.rulesIssue, "stale");
    assert.equal(stale.draft!.outsideReads, "deny"); assert.equal(c.canSave(generation), false);
    click(button(permissionEn.discard)); await settle(() => !c.store.getSnapshot().reading);
    const discarded = c.store.getSnapshot();
    assert.deepEqual({ dirty: discarded.dirty, issue: discarded.rulesIssue, reads: discarded.draft!.outsideReads, base: discarded.base!.revision },
      { dirty: false, issue: null, reads: "ask", base: "r2" });
    assert.equal(button(permissionEn.discard).props.disabled, true);
  } finally { stop(); c.dispose(); }
});

test("native runtime projection preserves execution readiness and unknown observations", () => {
  const copy: Readonly<Record<string, string>> = deploymentEn;
  const t = (key: string) => copy[key] ?? key;
  const paragraphs = (value: Parameters<typeof NativeRuntimeState>[0]["value"]) => nodes(render(createElement(NativeRuntimeState, { value, t }))).filter(node => node.type === "p").map(node => text(node).replace(/\s+/gu, " ").trim());
  const observed = paragraphs({ binding: "stock", deliveryFenceReady: true, restartRequired: false });
  assert.ok(observed.includes(`${t("nativeRuntimeBinding")}: ${t("nativeRuntimeStock")}`));
  assert.ok(observed.includes(`${t("nativeRuntimeFence")}: ${t("on")} · ${t("nativeRuntimeRestart")}: ${t("off")}`));
  const unknown = paragraphs(undefined);
  assert.ok(unknown.includes(`${t("nativeRuntimeBinding")}: ${t("unknown")}`));
  assert.ok(unknown.includes(`${t("nativeRuntimeFence")}: ${t("unknown")} · ${t("nativeRuntimeRestart")}: ${t("unknown")}`));
});
