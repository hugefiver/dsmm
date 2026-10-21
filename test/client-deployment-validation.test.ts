import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";
import { cloneElement, createElement, isValidElement } from "react";
import type { ReactElement } from "react";
import type { DeploymentController as Controller } from "../src/client/deployment-controller.js";
import type { Field as DeploymentField } from "../src/client/DeploymentFields.js";
import type { StateInspector as Inspector } from "../src/client/DeploymentPage.js";
import { moduleFields, CONFIG_MODULES } from "../src/client/deployment-modules.ts";
import { editLayer } from "../src/client/deployment-data.ts";
import type { DsmmConfigRemote } from "../src/profile-remote.js";
import type { DeploymentAdmissionView, DeploymentEditorSnapshot, SessionProfileSnapshot } from "../src/profile-types.js";
import { deploymentEditorSchema, mergeConfigLayers, resolveConfig, resolveDeployment, validateSparseConfig } from "../src/settings.js";

// Compile the client under test in memory; never overwrite the shared lib build.
const root = fileURLToPath(new URL("..", import.meta.url));
const compiled = await build({
  absWorkingDir: root,
  stdin: { resolveDir: root, contents: 'export { DeploymentController } from "./src/client/deployment-controller.ts"; export { Field, AdvancedField } from "./src/client/DeploymentFields.tsx"; export { StateInspector } from "./src/client/DeploymentPage.tsx";' },
  bundle: true, write: false, platform: "node", format: "cjs", target: "es2022",
  external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives", "jsonc-parser"],
});
const require = createRequire(import.meta.url);
const module = { exports: {} as { DeploymentController: typeof Controller; Field: typeof DeploymentField; StateInspector: typeof Inspector } };
runInThisContext(`(function(require, module, exports) { ${compiled.outputFiles[0].text}\n})`)((id: string) => {
  if (id === "react") return { ...require(id), useEffect() {}, useMemo: (factory: () => unknown) => factory(), useId: () => "advanced-validation", useState: (value: unknown) => [value, () => {}], useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get() };
  if (id === "@deepseek-ai/dsh-client-ui-primitives") return { Button: (props: Record<string, unknown>) => createElement("button", props), Input: (props: Record<string, unknown>) => createElement("input", props) };
  return require(id);
}, module, module.exports);
const { DeploymentController, Field, StateInspector } = module.exports;

function fixture(global: Record<string, unknown>, profile: Record<string, unknown>, base: Record<string, unknown> = profile) {
  const defaults = resolveConfig() as unknown as Record<string, unknown>;
  const snapshot: DeploymentEditorSnapshot = {
    entryId: "include:dsmm", namespace: "dsmm", hostProfileKey: "own-profile", global: structuredClone(global), globalRevision: "g0",
    profile: structuredClone(profile), nativeRevision: "n0", nativeFormRevision: 0, nativeForm: { base, user: {} },
    desired: resolveDeployment(validateSparseConfig(global, true), validateSparseConfig(profile)) as unknown as Record<string, unknown>, sources: {}, startup: defaults, defaults, schema: deploymentEditorSchema(), nextRoot: null, modules: [],
  };
  const writes: Parameters<DsmmConfigRemote["save"]>[0][] = [];
  const remote: DsmmConfigRemote = {
    describe: async () => ({ ok: true, value: { config: snapshot.global, revision: snapshot.globalRevision } }),
    describeModules: async () => ({ ok: true, value: [] }),
    describeSettings: async () => ({ ok: true, value: structuredClone(snapshot) }),
    save: async request => { writes.push(request); for (const edit of request.edits) snapshot.global = editLayer(snapshot.global, edit.path, edit.op === "set" ? edit.value : undefined); snapshot.globalRevision = "g1"; return { ok: true, value: { config: snapshot.global, revision: "g1" } }; },
  };
  return { snapshot, writes, controller: new DeploymentController(remote, "global"), remote };
}
function attachNative(f: ReturnType<typeof fixture>, c: Controller, mutations: unknown[]): void {
  const native = f.snapshot.nativeForm!;
  c.attachForm({ state: { status: "ready", writable: true, revision: f.snapshot.nativeFormRevision!, value: f.snapshot.profile, base: native.base, user: native.user }, mutate: async (ops, revision) => {
    assert.equal(revision, f.snapshot.nativeFormRevision); mutations.push(ops);
    let user = native.user as Record<string, unknown>;
    for (const edit of ops) user = editLayer(user, edit.path, edit.op === "set" ? edit.value : undefined);
    f.snapshot.nativeForm = { base: native.base, user };
    f.snapshot.profile = mergeConfigLayers(validateSparseConfig(native.base), validateSparseConfig(user)) as Record<string, unknown>;
    f.snapshot.nativeFormRevision!++; f.snapshot.nativeRevision = `n${f.snapshot.nativeFormRevision}`;
    attachNative(f, c, mutations); return true;
  } });
}

function elements(tree: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...elements(tree.props.children)];
}
function renderComponent(node: ReactElement<Record<string, unknown>>): unknown {
  assert.equal(typeof node.type, "function");
  return (node.type as (props: unknown) => unknown)(node.props);
}
// Execute production components and their event handlers without a DOM renderer.
function renderTree(tree: unknown): unknown {
  if (Array.isArray(tree)) return tree.map(renderTree);
  if (!isValidElement<Record<string, unknown>>(tree)) return tree;
  if (typeof tree.type === "function") return renderTree(renderComponent(tree));
  return cloneElement(tree, { children: renderTree(tree.props.children) });
}
function text(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(text).join(" ");
  return isValidElement<Record<string, unknown>>(tree) ? text(tree.props.children) : typeof tree === "string" || typeof tree === "number" ? String(tree) : "";
}
function advancedInput(controller: Controller, remote: DsmmConfigRemote) {
  void remote;
  const input = elements(renderTree(createElement(Field, { schema: controller.getSnapshot().snapshot!.schema.fields!.roleRouting, path: ["roleRouting"], controller, t: key => key }))).find(node => node.type === "textarea")!;
  return (value: string) => (input.props.onChange as (event: unknown) => void)({ currentTarget: { value } });
}

test("Core passthrough field handlers save explicit false, same-default true and inheritance without rewriting opaque routes", async () => {
  const routing = { "dsmm-reviewer": { primary: { provider: "fixture", model: "manual-unlisted", reasoning_effort: "future-effort", opaque: { nested: [1, null, "unchanged"] } } } };
  for (const choice of ["false", "true", "inherit"]) {
    const initial = choice === "inherit" ? { modelParameters: { passthrough: false }, roleRouting: routing } : { roleRouting: routing };
    const f = fixture(initial, {});
    try {
      await f.controller.refresh();
      const tree = renderTree(createElement(Field, { schema: f.snapshot.schema.fields!.modelParameters, path: ["modelParameters"], controller: f.controller, t: key => key }));
      const group = elements(tree).find(node => node.props["data-field"] === "modelParameters.passthrough");
      assert.ok(group);
      const select = elements(group).find(node => node.type === "select")!;
      (select.props.onChange as (event: unknown) => void)({ currentTarget: { value: choice } });
      await f.controller.save();
      assert.equal(f.controller.getSnapshot().saved, true);
      assert.deepEqual(f.controller.getSnapshot().draft.roleRouting, routing);
      assert.deepEqual(f.writes, [{ expectedRevision: "g0", edits: choice === "inherit"
        ? [{ op: "unset", path: ["modelParameters", "passthrough"] }]
        : [{ op: "set", path: ["modelParameters"], value: { passthrough: choice === "true" } }] }]);
    } finally { f.controller.dispose(); }
  }
});

test("advanced route editing accepts opaque JSON and either effort alias with passthrough off, but refuses unsafe route fields", async () => {
  for (const alias of ["reasoningEffort", "reasoning_effort"]) {
    const f = fixture({ modelParameters: { passthrough: false } }, {});
    try {
      await f.controller.refresh();
      const routing = { "dsmm-reviewer": { primary: { provider: "fixture", model: "manual", [alias]: "exact-unlisted", temperature: 0.3, maxTokens: 123, stop: [], customParameters: { nested: [null, true, 1] } } } };
      advancedInput(f.controller, f.remote)(JSON.stringify(routing)); await f.controller.save();
      assert.equal(f.controller.getSnapshot().saved, true);
      assert.deepEqual(f.writes[0].edits, [{ op: "set", path: ["roleRouting"], value: routing }]);
      assert.deepEqual(f.controller.getSnapshot().draft.modelParameters, { passthrough: false });
    } finally { f.controller.dispose(); }
  }
  for (const extra of [{ headers: {} }, { reasoningEffort: "a", reasoning_effort: "b" }, { opaque: JSON.parse('{"__proto__":true}') }]) {
    const f = fixture({ modelParameters: { passthrough: false } }, {});
    try {
      await f.controller.refresh(); advancedInput(f.controller, f.remote)(JSON.stringify({ "dsmm-reviewer": { primary: { provider: "fixture", model: "manual", ...extra } } }));
      await f.controller.save(); assert.equal(f.writes.length, 0); assert.equal(f.controller.getSnapshot().dirty, true);
    } finally { f.controller.dispose(); }
  }
});

test("Core permission enabled field uses ordinary Global/native Save and preserves independent rule policy", async () => {
  const policy = { enabled: true, outsideReads: "deny", webFetch: { enabled: false, rule: "ask" }, rules: [] };
  for (const native of [false, true]) {
    const f = fixture(native ? {} : { permissionControl: policy }, native ? { permissionControl: policy } : {});
    const c = native ? new DeploymentController(f.remote, "profile", "dsmm") : f.controller, mutations: unknown[] = [];
    if (native) { f.snapshot.nativeForm = { base: {}, user: f.snapshot.profile }; attachNative(f, c, mutations); }
    try {
      await c.refresh();
      const tree = renderTree(createElement(Field, { schema: f.snapshot.schema.fields!.permissionControl, path: ["permissionControl"], controller: c, t: key => key }));
      const group = elements(tree).find(node => node.props["data-field"] === "permissionControl.enabled");
      assert.ok(group);
      const select = elements(group).find(node => node.type === "select")!;
      (select.props.onChange as (event: unknown) => void)({ currentTarget: { value: "false" } }); await c.save();
      assert.equal(c.getSnapshot().saved, true); assert.deepEqual(c.getSnapshot().draft.permissionControl, { ...policy, enabled: false });
      const edits = [{ op: "set", path: ["permissionControl", "enabled"], value: false }];
      if (native) { assert.deepEqual(mutations, [edits]); assert.deepEqual(f.writes, []); }
      else assert.deepEqual(f.writes, [{ expectedRevision: "g0", edits }]);
    } finally { c.dispose(); if (native) f.controller.dispose(); }
  }
});

test("Global save accepts either sparse primary member completed by the unchanged native profile", async () => {
  for (const [globalPrimary, nativePrimary] of [[{ provider: "fixture" }, { model: "review" }], [{ model: "review" }, { provider: "fixture" }]] as const) {
    const f = fixture({ roleRouting: { "dsmm-reviewer": { primary: globalPrimary } } }, { roleRouting: { "dsmm-reviewer": { primary: nativePrimary } } });
    try {
      await f.controller.refresh(); f.controller.edit(["defaultActive"], !f.snapshot.defaults.defaultActive); await f.controller.save();
      assert.equal(f.controller.getSnapshot().issue, null);
      assert.equal(f.controller.getSnapshot().dirty, false);
      assert.equal(f.controller.getSnapshot().saved, true);
      assert.deepEqual(f.writes, [{ expectedRevision: "g0", edits: [{ op: "set", path: ["defaultActive"], value: !f.snapshot.defaults.defaultActive }] }]);
      assert.deepEqual(f.controller.getSnapshot().draft, { roleRouting: { "dsmm-reviewer": { primary: globalPrimary } }, defaultActive: !f.snapshot.defaults.defaultActive });
    } finally { f.controller.dispose(); }
  }
});

test("Global advanced fields validate their sparse input against the complete native candidate without pinning inherited routes", async () => {
  for (const [globalPrimary, nativePrimary, changed] of [[{ provider: "fixture" }, { model: "review" }, { provider: "changed-provider" }], [{ model: "review" }, { provider: "fixture" }, { model: "changed-model" }]] as const) {
    const f = fixture({ roleRouting: { "dsmm-reviewer": { primary: globalPrimary } } }, { roleRouting: { "dsmm-reviewer": { primary: nativePrimary } } });
    try {
      await f.controller.refresh(); advancedInput(f.controller, f.remote)(JSON.stringify({ "dsmm-reviewer": { primary: changed } })); await f.controller.save();
      assert.equal(f.controller.getSnapshot().issue, null);
      assert.equal(f.controller.getSnapshot().saved, true);
      const key = Object.keys(changed)[0];
      assert.deepEqual(f.writes, [{ expectedRevision: "g0", edits: [{ op: "set", path: ["roleRouting", "dsmm-reviewer", "primary", key], value: Object.values(changed)[0] }] }]);
      assert.deepEqual(f.controller.getSnapshot().draft, { roleRouting: { "dsmm-reviewer": { primary: changed } } });
    } finally { f.controller.dispose(); }
  }
});

test("Global validation uses the effective native profile even without an owned native form", async () => {
  const f = fixture({ roleRouting: { "dsmm-reviewer": { primary: { provider: "fixture" } } } }, { roleRouting: { "dsmm-reviewer": { primary: { model: "review" } } } });
  f.snapshot.nativeForm = null; f.snapshot.nativeFormRevision = null;
  try {
    await f.controller.refresh(); f.controller.edit(["defaultActive"], false); await f.controller.save();
    assert.equal(f.controller.getSnapshot().saved, true); assert.equal(f.writes.length, 1);
  } finally { f.controller.dispose(); }
});

test("Sparse primary edits still require a complete effective route before saving", async () => {
  for (const advanced of [false, true]) {
    const f = fixture({}, {});
    try {
      await f.controller.refresh();
      const routing = { "dsmm-reviewer": { primary: { provider: "fixture" } } };
      if (advanced) advancedInput(f.controller, f.remote)(JSON.stringify(routing)); else f.controller.edit(["roleRouting"], routing);
      await f.controller.save(); assert.equal(f.writes.length, 0); assert.equal(f.controller.getSnapshot().dirty, true);
      if (advanced) assert.deepEqual(f.controller.getSnapshot().draft, {}); else assert.equal(f.controller.getSnapshot().issue, "validation");
    } finally { f.controller.dispose(); }
  }
});

test("Global advanced inheritance removes only the explicit layer without materializing native or default values", async () => {
  const f = fixture({ roleRouting: { "dsmm-reviewer": { primary: { provider: "global" } } } }, { roleRouting: { "dsmm-reviewer": { primary: { provider: "native", model: "review" } } } });
  try {
    await f.controller.refresh(); advancedInput(f.controller, f.remote)(""); await f.controller.save();
    assert.equal(f.controller.getSnapshot().saved, true); assert.deepEqual(f.controller.getSnapshot().draft, {});
    assert.deepEqual(f.writes, [{ expectedRevision: "g0", edits: [{ op: "unset", path: ["roleRouting"] }] }]);
  } finally { f.controller.dispose(); }
});

test("Native precedence cannot conceal malformed sparse editor grammar", async () => {
  const native = { roleRouting: { "dsmm-reviewer": { primary: { provider: "fixture", model: "review" } } } };
  for (const primary of [{ provider: "  " }, { model: 42 }, { headers: "route" }]) {
    for (const advanced of [false, true]) {
      const f = fixture({}, native);
      try {
        await f.controller.refresh();
        const routing = { "dsmm-reviewer": { primary } };
        if (advanced) advancedInput(f.controller, f.remote)(JSON.stringify(routing)); else f.controller.edit(["roleRouting"], routing);
        await f.controller.save(); assert.equal(f.writes.length, 0); assert.equal(f.controller.getSnapshot().dirty, true);
        if (advanced) assert.deepEqual(f.controller.getSnapshot().draft, {}); else assert.equal(f.controller.getSnapshot().issue, "validation");
      } finally { f.controller.dispose(); }
    }
  }
});

test("Global advanced validation applies native routes after the draft and keeps fallback arrays complete", async () => {
  const f = fixture({}, { roleRouting: { "dsmm-reviewer": { primary: { provider: "native", model: "review" } } } });
  try {
    await f.controller.refresh();
    advancedInput(f.controller, f.remote)('{"dsmm-reviewer":{"primary":{"model":"global-only"}}}');
    await f.controller.save(); assert.equal(f.controller.getSnapshot().saved, true);
    assert.deepEqual(f.writes[0].edits, [{ op: "set", path: ["roleRouting"], value: { "dsmm-reviewer": { primary: { model: "global-only" } } } }]);
    advancedInput(f.controller, f.remote)('{"dsmm-reviewer":{"fallbackRoutes":[{"model":"incomplete"}]}}');
    await f.controller.save(); assert.equal(f.writes.length, 1); assert.equal(f.controller.getSnapshot().dirty, true);
  } finally { f.controller.dispose(); }
});

test("Profile advanced fields inherit global and native base members but persist only the user layer", async () => {
  const global = { roleRouting: { "dsmm-reviewer": { primary: { provider: "global", model: "global-model" } } } };
  const base = { roleRouting: { "dsmm-reviewer": { primary: { provider: "native-base" } } } };
  const user = { roleRouting: { "dsmm-reviewer": { primary: { model: "user-model" } } } };
  const f = fixture(global, mergeConfigLayers(validateSparseConfig(base), validateSparseConfig(user)) as Record<string, unknown>, base);
  f.snapshot.nativeForm = { base, user };
  const c = new DeploymentController(f.remote, "profile", "dsmm"), mutations: unknown[] = [];
  attachNative(f, c, mutations);
  try {
    await c.refresh(); advancedInput(c, f.remote)('{"dsmm-reviewer":{"primary":{"model":"changed"}}}'); await c.save();
    assert.equal(c.getSnapshot().saved, true);
    assert.deepEqual(mutations, [[{ op: "set", path: ["roleRouting", "dsmm-reviewer", "primary", "model"], value: "changed" }]]);
    assert.deepEqual(c.getSnapshot().draft, { roleRouting: { "dsmm-reviewer": { primary: { model: "changed" } } } });
    assert.equal(f.writes.length, 0);
  } finally { c.dispose(); f.controller.dispose(); }
});

test("selected-scope module fields preserve hidden LSP input through ordinary Global and native saves", async () => {
  const stored = { enabled: true, serverName: "retained-server", command: "retained-command", args: ["retained-argument"] };
  const f = fixture({ lsp: stored, defaultActive: true }, { lsp: stored, defaultActive: true }, {});
  f.snapshot.nativeForm = { base: {}, user: structuredClone(f.snapshot.profile) };
  const mutations: unknown[] = [];
  const profile = new DeploymentController(f.remote, "profile", "dsmm");
  attachNative(f, profile, mutations);
  try {
    for (const controller of [f.controller, profile]) {
      await controller.refresh();
      const fields = CONFIG_MODULES.flatMap(module => moduleFields(f.snapshot.schema, module, controller.layer));
      assert.equal(new Set(fields.map(([key]) => key)).size, fields.length);
      const section = renderTree(fields.map(([key, schema]) => createElement(Field, { key, schema, path: [key], controller, t: key => key })));
      const paths = elements(section).flatMap(node => typeof node.props["data-field"] === "string" ? [node.props["data-field"]] : []);
      assert.equal(paths.some(path => path === "lsp" || path.startsWith("lsp.")), false);
      assert.ok(paths.includes("modules.deepwork.enabled") === (controller.layer === "global"));
      assert.ok(paths.includes("workflow.reviewCap"));
      assert.ok(paths.includes("roleRouting"));
      const field = elements(section).find(node => node.props["data-field"] === "defaultActive")!;
      const select = elements(field).find(node => node.type === "select")!;
      assert.equal(select.props.disabled, false);
      (select.props.onChange as (event: unknown) => void)({ currentTarget: { value: "false" } });
      await controller.save();
      assert.equal(controller.getSnapshot().saved, true);
      assert.deepEqual(controller.getSnapshot().draft.lsp, stored);
    }
    assert.deepEqual(f.writes, [{ expectedRevision: "g0", edits: [{ op: "set", path: ["defaultActive"], value: false }] }]);
    assert.deepEqual(mutations, [[{ op: "set", path: ["defaultActive"], value: false }]]);
    assert.deepEqual(f.snapshot.global.lsp, stored);
    assert.deepEqual((f.snapshot.nativeForm.user as Record<string, unknown>).lsp, stored);
  } finally { profile.dispose(); f.controller.dispose(); }
});

test("rendered inspector hides LSP configuration, provenance and restart state across all projected layers", async () => {
  const f = fixture({ lsp: { enabled: true } }, {});
  const admission: DeploymentAdmissionView = {
    settings: { lsp: { enabled: true, env: { entries: 2 } }, workflow: { reviewCap: 7 } },
    sources: { lsp: "deployment", "lsp.enabled": "named-session", "lsp.env": "mixed", "workflow.reviewCap": "named-session" },
    captures: { "lsp.command": "startup", "lsp.env": "mixed", "workflow.reviewCap": "named-session" },
    restartRequired: ["lsp", "lsp.command"], named: null,
  };
  f.snapshot.sources = { "lsp.enabled": "global", "lsp.env": "mixed", "workflow.reviewCap": "defaults" };
  f.snapshot.startupSources = { "lsp.serverName": "startup" };
  f.snapshot.nextRoot = admission;
  const session: SessionProfileSnapshot = {
    sessionId: "owned-inspector-root", admissionEpoch: "owned-inspector-epoch", scope: "deployment-baseline", switchAllowed: true,
    canSelectModel: false, selectModelUnavailableReason: "model-unconfigured",
    canToggleMode: false, toggleModeUnavailableReason: "runtime-unavailable",
    canApplyOverlay: false, applyOverlayUnavailableReason: "new-session-required",
    globalDefault: { selectedId: null, appliedRevision: null, selectionRevision: "absent" },
    selection: { selectedId: null, appliedRevision: null, selectionRevision: "absent" }, configuration: admission,
  };
  const before = structuredClone(f.snapshot);
  const inspector = () => renderTree(createElement(StateInspector, { controller: f.controller, t: key => key }));
  try {
    await f.controller.refresh();
    for (const state of [null, session]) {
      f.controller.setSession(state);
      const tree = inspector(), nodes = elements(tree);
      const paths = nodes.filter(node => node.type === "dt").map(text);
      assert.equal(paths.some(path => path === "lsp" || path.startsWith("lsp.")), false);
      assert.ok(paths.includes("workflow.reviewCap"));
      assert.ok(paths.includes("modules.deepwork.enabled"));
      assert.deepEqual(paths, [...paths].sort());
      assert.equal(nodes.some(node => node.type === "p" && text(node).includes("pending")), false);
      if (state !== null) assert.ok(nodes.some(node => node.props.role === "status" && text(node) === "sessionObserved"));
    }
    f.snapshot.nextRoot = { ...admission, restartRequired: ["lsp.enabled", "permissions"] };
    await f.controller.refresh();
    const pending = elements(inspector()).find(node => node.type === "p" && text(node).includes("pending"));
    assert.ok(pending);
    assert.ok(text(pending).includes("permissions"));
    assert.equal(text(pending).includes("lsp"), false);
    assert.deepEqual(f.snapshot.global, before.global);
    assert.deepEqual(f.snapshot.schema, before.schema);
    assert.deepEqual(f.snapshot.desired, before.desired);
    assert.deepEqual(f.snapshot.startup, before.startup);
    assert.deepEqual(session.configuration, admission);
  } finally { f.controller.dispose(); }
});
