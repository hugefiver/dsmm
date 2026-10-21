import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";
import { setImmediate } from "node:timers/promises";
import { cloneElement, createElement, isValidElement } from "react";
import type { ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionGenerationState } from "@deepseek-ai/dsh-client-connection/client";
import type { DsmmConfigRemote } from "../src/profile-remote.js";
import type { DeploymentAdmissionView, DeploymentEditorSnapshot, SessionProfileSnapshot } from "../src/profile-types.js";
import type { DeploymentPageProps } from "../src/client/DeploymentPage.js";
import { deploymentEn, deploymentZh } from "../src/client/deployment-locales.js";
import { permissionEn } from "../src/client/permission-locales.ts";
import { deploymentEditorSchema, resolveConfig } from "../src/settings.js";
import { DeploymentController } from "../src/client/deployment-controller.js";
import type { NativePageForm } from "../src/client/deployment-controller.js";
import { editLayer, layerDiff, mergeLayer, parseAdvanced, record, validateEditorValue } from "../src/client/deployment-data.js";

function fixture() {
  const defaults = resolveConfig() as unknown as Record<string, unknown>;
  let snapshot: DeploymentEditorSnapshot = {
    entryId: "include:dsmm", namespace: "dsmm", hostProfileKey: "own-profile",
    global: { workflow: { reviewCap: 3 }, modules: { deepwork: { enabled: false } } }, globalRevision: "g0",
    profile: {}, nativeRevision: "n0", nativeFormRevision: 0, nativeForm: { base: {}, user: {} },
    desired: defaults, sources: {}, startup: defaults, defaults, schema: deploymentEditorSchema(), nextRoot: null, modules: [],
  };
  const writes: unknown[] = [];
  let intercept: (() => Promise<void>) | undefined;
  const remote: DsmmConfigRemote = {
    describe: async () => ({ ok: true, value: { config: snapshot.global, revision: snapshot.globalRevision } }),
    describeModules: async () => ({ ok: true, value: [] }),
    describeSettings: async () => { await intercept?.(); return { ok: true, value: structuredClone(snapshot) }; },
    save: async request => {
      assert.equal(request.expectedRevision, snapshot.globalRevision);
      writes.push(request);
      let global = snapshot.global;
      for (const edit of request.edits) global = editLayer(global, edit.path, edit.op === "set" ? edit.value : undefined);
      snapshot = { ...snapshot, global, globalRevision: "g1" };
      return { ok: true, value: { config: global, revision: "g1" } };
    },
  };
  const mutateNative = (edits: Parameters<NativePageForm["mutate"]>[0], revision?: number) => {
    assert.equal(revision, snapshot.nativeFormRevision);
    const base = snapshot.nativeForm!.base as Record<string, unknown>;
    let user = snapshot.nativeForm!.user as Record<string, unknown>;
    for (const edit of edits) user = editLayer(user, edit.path, edit.op === "set" ? edit.value : undefined);
    const nextRevision = revision! + 1, value = mergeLayer(base, user);
    assert.ok(record(value));
    snapshot = { ...snapshot, nativeForm: { base, user }, profile: value, nativeFormRevision: nextRevision, nativeRevision: `n${nextRevision}` };
    return { status: "ready" as const, writable: true, revision: nextRevision, value, base, user };
  };
  return { remote, writes, mutateNative, get: () => snapshot, change: (patch: Partial<DeploymentEditorSnapshot>) => { snapshot = { ...snapshot, ...patch }; }, intercept: (callback: () => Promise<void>) => { intercept = callback; } };
}

const currentClient = await build({ entryPoints: [fileURLToPath(new URL("../src/client/index.ts", import.meta.url))], bundle: true, write: false, platform: "browser", format: "cjs", target: "es2022", external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"] });
async function compiledNativePage(remote: DsmmConfigRemote) {
  const require = createRequire(import.meta.url);
  const refs: Array<{ current: unknown }> = []; let refIndex = 0;
  const module = { exports: {} as { apply(ctx: Context): Promise<void> } };
  runInThisContext(`(function(require,module,exports){${currentClient.outputFiles[0].text}\n})`)((id: string) => {
    if (id === "react") return { ...require(id), useEffect() {}, useId: () => "deployment-fixture", useRef: (current: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current }), useMemo: (factory: () => unknown) => factory(), useState: (value: unknown) => [value, () => {}], useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get() };
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return { Button: (props: Record<string, unknown>) => createElement("button", props), Input: (props: Record<string, unknown>) => createElement("input", props) };
    assert.equal(id, "react/jsx-runtime"); return require(id);
  }, module, module.exports);
  let component!: (props: DeploymentPageProps) => unknown, core!: DeploymentController;
  let injected!: Pick<DeploymentPageProps, "core" | "remote" | "workspace">;
  const copy: Readonly<Record<string, string>> = deploymentEn;
  const t: DeploymentPageProps["t"] = key => copy[key] ?? key;
  // A JSX tree seam, not a browser/authentication substitute. Capture the real
  // production slot component and controller; no header or session DOM is forged.
  const context = {
    remote: { $mount() {}, dsmmConfig: remote }, effect() {}, locale: { bind: () => t },
    inject(names: string[], callback: (ctx: unknown) => unknown) { if (names.includes("remote.dsmmConfig")) return callback(this); },
    slots: { inject(_name: string, callback: () => unknown) { callback(); }, register(options: { name: string; inject(): typeof injected }, view: typeof component) { if (options.name === "plugins.bundle.config") { component = view; injected = options.inject(); core = injected.core; } } },
  };
  await module.exports.apply(context as unknown as Context);
  for (let round = 0; round < 100 && core.getSnapshot().busy; round++) await setImmediate();
  const tree = (translate = t) => { refIndex = 0; return component({ ...injected, view: "page", t: translate }); };
  const open = (label: string) => { const button = elements(tree()).find(node => typeof node.props.onClick === "function" && text(node) === label); assert.ok(button, label); (button.props.onClick as () => void)(); };
  const inspector = () => {
    const node = elements(tree()).find(node => typeof node.type === "function" && node.type.name === "StateInspector")!;
    assert.ok(node); return (node.type as (props: unknown) => unknown)(node.props);
  };
  return { core, component: (overrides: Partial<DeploymentPageProps> = {}) => component({ ...injected, view: "page", t, ...overrides }), inspector, open, tree: (translate?: DeploymentPageProps["t"]) => render(tree(translate)), workspace: injected.workspace!, dispose() { injected.workspace!.dispose(); core.dispose(); } };
}
function render(tree: unknown): unknown {
  if (Array.isArray(tree)) return tree.map(render);
  if (!isValidElement<Record<string, unknown>>(tree)) return tree;
  if (typeof tree.type === "function") return render((tree.type as (props: unknown) => unknown)(tree.props));
  return cloneElement(tree, { children: render(tree.props.children) });
}
function elements(tree: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...elements(tree.props.children)];
}
function text(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(text).join("");
  return isValidElement<Record<string, unknown>>(tree) ? text(tree.props.children) : typeof tree === "string" || typeof tree === "number" ? String(tree) : "";
}

test("one flat section tablist keeps the user's group collapse through save, locale and reopening", async () => {
  const f = fixture(), page = await compiledNativePage(f.remote);
  const group = (path: string, translate?: DeploymentPageProps["t"]) => {
    const node = elements(page.tree(translate)).find(node => node.type === "details" && node.props["data-field"] === path);
    assert.ok(node, path); return node;
  };
  try {
    page.open(deploymentEn["module:workflow"]);
    assert.equal(group("subagents").props.open ?? false, false, "multi-field sections keep nested groups collapsed");
    (group("subagents").props.onToggle as (event: unknown) => void)({ currentTarget: { open: true } });
    const field = elements(group("subagents")).find(node => node.props["data-field"] === "subagents.maxDepth");
    assert.ok(field);
    const input = elements(field).find(node => node.type === "input"); assert.ok(input);
    (input.props.onChange as (event: unknown) => void)({ currentTarget: { value: "2" } });
    (group("subagents").props.onToggle as (event: unknown) => void)({ currentTarget: { open: false } });
    assert.equal(group("subagents").props.open, false);
    await page.workspace.save();
    assert.equal(f.writes.length, 1);
    assert.equal(group("subagents").props.open, false);
    assert.equal(group("subagents", key => deploymentZh[key as keyof typeof deploymentZh] ?? key).props.open, false);
    page.workspace.request({ scope: "global", module: null });
    page.open(deploymentEn["module:workflow"]);
    assert.equal(group("subagents").props.open, false);
    (group("subagents").props.onToggle as (event: unknown) => void)({ currentTarget: { open: true } });
    assert.equal(group("subagents").props.open, true);
    page.open(deploymentEn["module:run"]);
    assert.equal(group("modules").props.open, false);
    assert.equal(group("modelParameters").props.open, false);
    page.open(deploymentEn["module:routes"]);
    assert.equal(group("roleRouting").props.open ?? false, false, "advanced JSON stays collapsed");
    const tabs = elements(page.tree()).filter(node => node.props.role === "tab");
    assert.deepEqual(tabs.map(node => node.props["data-dsmm-tab"]), ["run", "routes", "workflow", "permissions", "state"]);
    assert.equal(tabs.filter(node => node.props["aria-selected"] === true).length, 1);
    assert.equal(tabs.filter(node => node.props.tabIndex === 0).length, 1);
    assert.equal(tabs.find(node => node.props["data-dsmm-tab"] === "routes")!.props["aria-selected"], true);
    const panel = elements(page.tree()).find(node => node.props.role === "tabpanel");
    assert.equal(panel?.props["aria-labelledby"], tabs.find(node => node.props["data-dsmm-tab"] === "routes")!.props.id);
    page.workspace.request({ scope: "global", module: "state" });
    assert.deepEqual(elements(page.tree()).filter(node => node.props.role === "tab").map(node => node.props.tabIndex), [-1, -1, -1, -1, 0]);
  } finally { page.dispose(); }
});

test("scope switching restores each scope's remembered section instead of pinning the current one", async () => {
  const f = fixture(), page = await compiledNativePage(f.remote);
  try {
    page.workspace.request({ scope: "global", module: "workflow" });
    page.workspace.request({ scope: "profile", module: "routes" });
    assert.deepEqual([page.workspace.getSnapshot().scope, page.workspace.getSnapshot().module], ["profile", "routes"]);
    const scope = elements(page.tree()).find(node => node.type === "select" && String(node.props.id).endsWith("-scope"));
    assert.ok(scope);
    (scope.props.onChange as (event: unknown) => void)({ currentTarget: { value: "global" } });
    assert.deepEqual([page.workspace.getSnapshot().scope, page.workspace.getSnapshot().module, page.workspace.getSnapshot().pending], ["global", "workflow", null]);
    const back = elements(page.tree()).find(node => node.type === "select" && String(node.props.id).endsWith("-scope"))!;
    (back.props.onChange as (event: unknown) => void)({ currentTarget: { value: "profile" } });
    assert.deepEqual([page.workspace.getSnapshot().scope, page.workspace.getSnapshot().module, page.workspace.getSnapshot().pending], ["profile", "routes", null]);
  } finally { page.dispose(); }
});

test("a lone JSON editor opens without expanding its optional schema and inheritance details", async () => {
  const f = fixture();
  f.change({ schema: { type: "object", fields: { roleRouting: f.get().schema.fields!.roleRouting! } } });
  const page = await compiledNativePage(f.remote);
  try {
    page.open(deploymentEn["module:routes"]);
    const groups = () => elements(page.tree()).filter(node => node.type === "details");
    const editor = groups().find(node => node.props["data-field"] === "roleRouting"); assert.ok(editor);
    assert.equal(editor.props.open, true);
    assert.ok(elements(editor).some(node => node.type === "textarea"));
    assert.ok(groups().filter(node => node.props["data-field"] !== "roleRouting").every(node => node.props.open !== true));
    (editor.props.onToggle as (event: unknown) => void)({ currentTarget: { open: false } });
    assert.equal(groups().find(node => node.props["data-field"] === "roleRouting")?.props.open, false);
  } finally { page.dispose(); }
});

test("Permissions and safety keeps configuration editing independent from unavailable Global rules", async () => {
  const f = fixture(), page = await compiledNativePage(f.remote);
  const { PermissionController } = await import("../src/client/permission-controller.ts");
  const { DeploymentWorkspace } = await import("../src/client/deployment-workspace.ts");
  const permissions = new PermissionController();
  const workspace = new DeploymentWorkspace(page.core, permissions);
  try {
    workspace.request({ scope: "global", module: "permissions" });
    for (let round = 0; round < 100 && page.core.getSnapshot().busy; round++) await setImmediate();

    const tree = render(page.component({ workspace, permissions, permissionsT: key => permissionEn[key as keyof typeof permissionEn] }));
    const nodes = elements(tree);
    // The configuration transaction stays editable without a Root.
    const guard = nodes.find(node => node.props["data-field"] === "guards.scope");
    assert.ok(guard, "configuration guard fields render");
    const guardSelect = elements(guard).find(node => node.type === "select");
    assert.equal(guardSelect?.props.disabled, false);
    // The Global-rules transaction renders inside the same section but owns its own controls.
    const rulesPanel = nodes.find(node => node.props["data-dsmm-permissions"] !== undefined);
    assert.ok(rulesPanel, "rules transaction renders");
    assert.equal(elements(rulesPanel).filter(node => node.type === "select").length, 0, "no trusted policy: no rule controls are presented as current");
    const rulesText = text(rulesPanel);
    assert.ok(rulesText.includes(permissionEn.noRoot), "the rules transaction explains its refusal");
    // A legal configuration edit still saves while the rules transaction is unavailable.
    (guardSelect!.props.onChange as (event: unknown) => void)({ currentTarget: { value: '"always"' } });
    const after = elements(render(page.component({ workspace, permissions, permissionsT: key => permissionEn[key as keyof typeof permissionEn] })));
    const configSave = after.find(node => node.type === "button" && text(node) === deploymentEn.saveGlobal && node.props.disabled === false);
    assert.ok(configSave, "configuration Save is not disabled by the rules transaction");
    assert.equal(page.core.getSnapshot().dirty, true);
  } finally { workspace.dispose(); permissions.dispose(); page.dispose(); }
});
test("source-bundled native page distinguishes known admission-unavailable and includes sorted named-only next/session fields", async () => {
  const f = fixture(), page = await compiledNativePage(f.remote);
  const session: SessionProfileSnapshot = { sessionId: "known-native-root", admissionEpoch: "epoch-new", scope: "session-override", switchAllowed: true,
    canSelectModel: false, selectModelUnavailableReason: "model-unconfigured",
    canToggleMode: false, toggleModeUnavailableReason: "runtime-unavailable",
    canApplyOverlay: false, applyOverlayUnavailableReason: "new-session-required",
    globalDefault: { selectedId: null, appliedRevision: null, selectionRevision: "absent" }, selection: { selectedId: "overlay", appliedRevision: "named-revision", selectionRevision: "named-selection" } };
  try {
    page.open(deploymentEn["module:state"]);
    page.core.setSession(session);
    const unavailable = text(page.inspector());
    const configuration: DeploymentAdmissionView = { settings: { defaultActive: false, roleRouting: { "dsmm-reviewer": { primary: { provider: "fixture", model: "overlay-only" } } } },
      sources: { defaultActive: "defaults", "roleRouting.dsmm-reviewer.primary.provider": "named-session", "roleRouting.dsmm-reviewer.primary.model": "named-session" }, captures: { defaultActive: "deployment", "roleRouting.dsmm-reviewer.primary.model": "named-session" }, restartRequired: [], named: { id: "overlay", revision: "named-revision" } };
    f.change({ nextRoot: configuration }); await page.core.refresh(); page.core.setSession({ ...session, configuration });
    const tree = page.inspector(), nodes = elements(tree), rows = nodes.filter(node => node.type === "dl");
    const keys = rows.map(row => text(elements(row).find(node => node.type === "dt")));
    const model = rows.find(row => text(row).includes("roleRouting.dsmm-reviewer.primary.model"));
    assert.ok(model, "named-only field is absent in desired routing but present in admitted/next-root state");
    assert.match(text(model), /overlay-only/u); assert.match(text(model), /Named\/session/u); assert.match(text(model), /Absent/u);
    const values = elements(model).filter(node => node.type === "dd").map(text);
    assert.equal(values[1], `${deploymentEn.startup}: ${deploymentEn.absent} · ${deploymentEn.unknown}`);
    assert.equal(values[2], `${deploymentEn.next}: ${JSON.stringify("overlay-only")} · ${deploymentEn.namedSource}`);
    assert.equal(values[3], `${deploymentEn.session}: ${JSON.stringify("overlay-only")} · ${deploymentEn.namedSource}`);
    assert.deepEqual(keys, [...keys].sort());
    assert.equal(text(elements(page.inspector()).find(node => node.props.role === "status")), deploymentEn.sessionObserved);
    assert.ok(unavailable.includes(deploymentEn.sessionUnavailable));
    page.core.setSession(null); assert.ok(text(page.inspector()).includes(deploymentEn.noSession));
  } finally { page.dispose(); }
});

test("first configuration read failure exposes a disabled Save and explicit Refresh in the same section after connection recovery", async () => {
  const f = fixture(); let unavailable = true;
  f.intercept(async () => { if (unavailable) throw new Error("fixture disconnected"); });
  const page = await compiledNativePage(f.remote);
  const listeners = new Set<() => void>(); let current: ReturnType<ConnectionGenerationState["getSnapshot"]>;
  page.core.bindConnection({ getSnapshot: () => current, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } });
  const button = (label: string) => elements(page.tree()).find(node => node.type === "button" && text(node) === label);
  try {
    page.open(deploymentEn["module:run"]);
    assert.equal(page.core.getSnapshot().snapshot, null); assert.equal(page.core.getSnapshot().issue, "transport");
    assert.ok(elements(page.tree()).some(node => node.props.role === "alert" && text(node) === deploymentEn.transport));
    assert.equal(button(deploymentEn.saveGlobal)?.props.disabled, true); assert.equal(button(deploymentEn.refresh)?.props.disabled, false);
    await (button(deploymentEn.saveGlobal)!.props.onClick as () => void)(); assert.equal(f.writes.length, 0);
    unavailable = false; current = { id: 1 } as unknown as NonNullable<typeof current>; for (const listener of listeners) listener();
    assert.equal(page.core.getSnapshot().snapshot, null); assert.equal(page.core.canEdit(), false);
    (button(deploymentEn.refresh)!.props.onClick as () => void)();
    while (page.core.getSnapshot().busy) await setImmediate();
    assert.equal(page.workspace.getSnapshot().module, "run"); assert.equal(page.core.getSnapshot().issue, null); assert.equal(page.core.canEdit(), true);
    assert.equal(page.core.getSnapshot().snapshot?.entryId, f.get().entryId); assert.equal(f.writes.length, 0);
  } finally { page.dispose(); assert.equal(listeners.size, 0); }
});

test("unresolved native scope exposes read-only Refresh without borrowing a dirty Global save", async () => {
  const f = fixture(); f.change({ namespace: null }); const page = await compiledNativePage(f.remote);
  try {
    page.open(deploymentEn["module:run"]); page.core.edit(["defaultActive"], true);
    const scope = elements(page.tree()).find(node => node.type === "select")!;
    (scope.props.onChange as (event: unknown) => void)({ currentTarget: { value: "profile" } }); page.workspace.keepAndNavigate();
    const controls = elements(page.tree()).filter(node => node.type === "button"), refresh = controls.find(node => text(node) === deploymentEn.refresh);
    assert.equal(page.workspace.controller(), null); assert.ok(refresh); assert.equal(refresh.props.disabled, false);
    assert.ok(controls.every(node => ![deploymentEn.saveGlobal, deploymentEn.saveProfile].includes(text(node))));
    (refresh.props.onClick as () => void)(); while (page.core.getSnapshot().busy) await setImmediate();
    assert.equal(page.core.getSnapshot().dirty, true); assert.equal(f.writes.length, 0);
  } finally { page.dispose(); }
});

test("Global native editor preserves sparse untouched fields, bytes CAS and saved feedback after field validation settles", async () => {
  const f = fixture(), controller = new DeploymentController(f.remote, "global");
  await controller.refresh(); controller.edit(["workflow", "reviewCap"], 4); await controller.save();
  assert.deepEqual(f.writes, [{ expectedRevision: "g0", edits: [{ op: "set", path: ["workflow", "reviewCap"], value: 4 }] }]);
  assert.deepEqual(f.get().global.modules, { deepwork: { enabled: false } });
  assert.equal(controller.getSnapshot().saved, true);
  controller.setInvalid("workflow.reviewCap", false);
  assert.equal(controller.getSnapshot().saved, true, "a mounted valid field must not erase successful live feedback"); controller.dispose();
});

test("Global conflict and refresh keep the dirty CAS baseline until an explicit discard", async () => {
  const f = fixture(), c = new DeploymentController(f.remote, "global"); await c.refresh(); c.edit(["workflow", "reviewCap"], 4);
  f.change({ globalRevision: "external", global: { workflow: { reviewCap: 2 }, defaultActive: true } });
  await c.save(); await c.refresh();
  assert.equal(c.getSnapshot().issue, "conflict"); assert.equal(c.getSnapshot().dirty, true); assert.equal(c.getSnapshot().snapshot?.globalRevision, "g0");
  assert.deepEqual(c.getSnapshot().draft.workflow, { reviewCap: 4 }); assert.equal(f.writes.length, 0);
  await c.refresh(true); assert.equal(c.getSnapshot().snapshot?.globalRevision, "external"); assert.equal(c.getSnapshot().dirty, false); c.dispose();
});

test("invalid advanced/schema fields refuse writes while preserving the draft", async () => {
  const f = fixture(), c = new DeploymentController(f.remote, "global"); await c.refresh();
  c.setInvalid("roleRouting", true); await c.save(); assert.equal(f.writes.length, 0); assert.equal(c.getSnapshot().dirty, true);
  c.setInvalid("roleRouting", false); c.edit(["unknown"], true); await c.save(); assert.equal(c.getSnapshot().issue, "validation"); assert.equal(c.getSnapshot().draft.unknown, true);
  for (const input of ['{"x":1,"x":2}', '{"x":{"y":1,"y":2}}', '{"x":1,}', '//comment\n{}']) assert.throws(() => parseAdvanced(input));
  assert.deepEqual(parseAdvanced('{"primary":{"provider":"existing","model":"manual"}}'), { primary: { provider: "existing", model: "manual" } });
  assert.equal(validateEditorValue({ modules: { deepwork: { enabled: true } } }, f.get().schema), true);
  assert.equal(validateEditorValue({ roleRouting: { unknownRole: {} } }, f.get().schema, true), false, "projected native controls reject unknown role IDs before any RPC");
  for (const maxRetries of [-1, 1.5, 11]) assert.equal(validateEditorValue({ runtimePolicy: { rateLimit: { maxRetries } } }, f.get().schema, true), false, "native rate-limit controls share the resolver's bounded integer grammar");
  const route = { provider: "fixture", model: "owned" };
  assert.equal(validateEditorValue({ roleRouting: { "dsmm-reviewer": { primary: { ...route, model: "  " } } } }, f.get().schema, true), false);
  assert.equal(validateEditorValue({ roleRouting: { "dsmm-reviewer": { fallbackRoutes: Array.from({ length: 33 }, () => route) } } }, f.get().schema, true), false);
  assert.equal(validateEditorValue({ modules: { arbitrary: {} } }, f.get().schema), false); c.dispose();
});

test("profile native form requires exact namespace, revision, explicit metadata and Host writability", async () => {
  const f = fixture(); f.change({ nativeForm: { base: { defaultActive: true }, user: { defaultActive: false } }, profile: { defaultActive: false } });
  const c = new DeploymentController(f.remote, "profile", "dsmm"); let mutations = 0;
  const state = { status: "ready" as const, writable: true, revision: 0, value: { defaultActive: false }, base: { defaultActive: true }, user: { defaultActive: false } };
  const mutate: NativePageForm["mutate"] = async (ops, revision) => { assert.equal(revision, 0); assert.deepEqual(ops, [{ op: "unset", path: ["defaultActive"] }]); mutations++; c.attachForm({ state: f.mutateNative(ops, revision), mutate }); return true; };
  c.attachForm({ state, mutate }); await c.refresh(); assert.deepEqual(c.getSnapshot().draft, { defaultActive: false }, "never schema-filled form.value"); assert.equal(c.canWriteProfile(), true);
  c.attachForm({ state: { ...state, writable: false }, mutate }); c.edit(["defaultActive"], undefined); await c.save(); assert.equal(mutations, 0);
  c.attachForm({ state, mutate }); c.edit(["defaultActive"], undefined); await c.save(); assert.equal(mutations, 1); assert.equal(f.writes.length, 0);
  assert.deepEqual(c.getSnapshot().draft, {}); assert.equal(f.get().profile.defaultActive, true); assert.equal(c.getSnapshot().saved, true);
  assert.equal(c.canWriteProfile(), true);
  const foreign = new DeploymentController(f.remote, "profile", "other-row"); foreign.attachForm({ state: { ...state, revision: f.get().nativeFormRevision!, value: f.get().profile, user: f.get().nativeForm!.user as Record<string, unknown> }, mutate }); await foreign.refresh(); assert.equal(foreign.canWriteProfile(), false); foreign.dispose(); c.dispose();
  assert.deepEqual(layerDiff({ workflow: { reviewCap: 3, strictGates: false } }, { workflow: { strictGates: false } }), [{ op: "unset", path: ["workflow", "reviewCap"] }]);
});

test("native mutation refuses non-JSON object values without coercing them into inherited configuration", async () => {
  const f = fixture(), c = new DeploymentController(f.remote, "profile", "dsmm"); let mutations = 0;
  c.attachForm({ state: { status: "ready", writable: true, revision: 0, value: {}, base: {}, user: {} }, mutate: async () => { mutations++; return true; } });
  try {
    await c.refresh(); c.edit(["workflow"], new Date("2026-01-01T00:00:00Z")); await c.save();
    assert.equal(c.getSnapshot().issue, "validation"); assert.equal(c.getSnapshot().dirty, true);
    assert.ok(c.getSnapshot().draft.workflow instanceof Date); assert.equal(mutations, 0); assert.equal(f.writes.length, 0);
  } finally { c.dispose(); }
});

test("entry replacement and disposal between validation and send cannot write a previous identity", async () => {
  for (const reason of ["entry", "dispose"] as const) {
    const f = fixture(), c = new DeploymentController(f.remote, "global"); await c.refresh(); c.edit(["defaultActive"], true);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); f.intercept(() => gate); const pending = c.save();
    if (reason === "entry") f.change({ entryId: "include:other", hostProfileKey: "other-profile" }); else c.dispose();
    release(); await pending; assert.equal(f.writes.length, 0); assert.equal(c.getSnapshot().dirty, true); c.dispose();
  }
});

test("profile editor preserves sparse native primary inheritance instead of pinning merged routes", async () => {
  const f = fixture();
  const user = { roleRouting: { "dsmm-reviewer": { primary: { model: "override" } } } };
  f.change({ global: { roleRouting: { "dsmm-reviewer": { primary: { provider: "fixture", model: "native-default" } } } }, nativeForm: { base: {}, user } });
  const c = new DeploymentController(f.remote, "profile", "dsmm");let mutations = 0;
  c.attachForm({ state: { status: "ready", writable: true, revision: 0, value: {}, base: {}, user }, mutate: async (ops, revision) => {
    assert.equal(revision, 0);assert.deepEqual(ops, [{ op: "set", path: ["roleRouting", "dsmm-reviewer", "primary", "model"], value: "changed" }]);mutations++;
    const state = f.mutateNative(ops, revision); c.attachForm({ state, mutate: async () => { throw new Error("unexpected replay"); } }); return true;
  } });
  await c.refresh();c.edit(["roleRouting", "dsmm-reviewer", "primary", "model"], "changed");await c.save();
  assert.equal(mutations, 1);assert.equal(f.writes.length, 0);
  assert.deepEqual(c.getSnapshot().draft.roleRouting, { "dsmm-reviewer": { primary: { model: "changed" } } });c.dispose();
});

test("connection replacement preserves dirty edits and fences the old generation before outbound saves", async () => {
  const f = fixture(), c = new DeploymentController(f.remote, "global"); const listeners = new Set<() => void>();
  let current: ReturnType<ConnectionGenerationState["getSnapshot"]>;
  const source: ConnectionGenerationState = { getSnapshot: () => current, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  c.bindConnection(source); await c.refresh(); assert.equal(c.getSnapshot().issue, "transport");
  current = { id: 1 } as unknown as NonNullable<typeof current>; for (const listener of listeners) listener(); await c.refresh(true);
  c.edit(["defaultActive"], true); current = undefined; for (const listener of listeners) listener(); await c.save();
  assert.equal(f.writes.length, 0); assert.equal(c.getSnapshot().dirty, true); assert.equal(c.getSnapshot().issue, "transport");
  current = { id: 2 } as unknown as NonNullable<typeof current>; for (const listener of listeners) listener(); await c.refresh(); await c.save();
  assert.equal(c.getSnapshot().issue, "conflict"); assert.equal(f.writes.length, 0); c.dispose(); assert.equal(listeners.size, 0);
});
