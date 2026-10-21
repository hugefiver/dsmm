import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createContext, runInContext, runInThisContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { parse } from "jsonc-parser";
import type { ProfilesController as Controller } from "../src/client/controller.js";
import { editStructuredPath, moveFallback, structuredDocument } from "../src/client/structured.ts";
import { sessionProfileLabels } from "../src/client/session-labels.ts";
import { en } from "../src/client/locales.ts";
import { configurationVersionState, writableSelectionVersion } from "../src/client/configuration-display.ts";
import { isValidElement } from "react";
import type { ReactElement } from "react";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { MenuEntry } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ProfilesActions, ProfilesViewSnapshot } from "../src/client/controller.js";
import type { DsmmProfilesRemote } from "../src/profile-remote.js";
import type { ProfileSnapshot, SessionProfileSnapshot, SessionProfileSelectRequest } from "../src/profile-types.js";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import type { ModelCatalog } from "@deepseek-ai/dsh-api-session-controller";
import type { SessionSelectModelRequest } from "@deepseek-ai/dsh-api-session-controller";
import type { SessionEventSource } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionEventWindow } from "@deepseek-ai/dsh-api-session-controller/client";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { isProfileId } from "../src/profile-remote.ts";
import { build } from "esbuild";
import type { EditableChoiceProps } from "../src/client/EditableChoice.js";
import type { SessionScope } from "../src/client/SessionProfiles.js";
import type { ComposerBlocks } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ConnectionGeneration } from "@deepseek-ai/dsh-client-connection/client";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { editStructuredPath as editCurrentPath, moveFallback as moveCurrentFallback, structuredDocument as currentDocument } from "../src/client/structured.js";

const controllerBundle = await build({ entryPoints: [fileURLToPath(new URL("../src/client/controller.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives", "jsonc-parser"] });
const sourceRequire = createRequire(import.meta.url), controllerModule = { exports: {} as { ProfilesController: typeof Controller } };
runInThisContext(`(function(require,module,exports){${controllerBundle.outputFiles[0].text}\n})`)(
  (id: string) => id === "@deepseek-ai/dsh-client-ui-primitives" ? { Button: NativeProfileButton } : sourceRequire(id), controllerModule, controllerModule.exports);
const { ProfilesController } = controllerModule.exports;
type ProfilesController = Controller;

const revision = "a".repeat(64), otherRevision = "b".repeat(64);
const content = `{
  // untouched document comment
  "version": 1, "id": "p", "label": "P",
  "settings": {
    "workflow": { "reviewCap": 2 }, // untouched workflow bytes
    "runtimePolicy": { "strategy": "startup-lock" },
    "roleRouting": { "dsmm-planner": {
      "primary": { "provider": "manual", /* route comment */ "model": "unlisted", "reasoningEffort": "exact-custom" },
      "fallbackRoutes": [
        { "provider": "one", /* first preserved */ "model": "m1" },
        { "provider": "two", /* second preserved */ "model": "m2", "reasoningEffort": "max" }
      ],
      "strategy": "rate-limit-fallback", "rateLimit": { "maxRetries": 0, "switchAfterRateLimits": 1 }
    }}
  }
}\n`;
const snapshot: ProfileSnapshot = { profiles: [{ id: "p", label: "P", revision }], selectedId: null, appliedRevision: null, selectionRevision: "absent" };
function session(id: string, epoch = "epoch-1"): SessionProfileSnapshot {
  return { sessionId: id, globalDefault: { selectedId: null, appliedRevision: null, selectionRevision: "absent" }, selection: { selectedId: null, appliedRevision: null, selectionRevision: "absent" }, scope: "global-default", admissionEpoch: epoch, switchAllowed: true,
    canSelectModel: true, canToggleMode: true, canApplyOverlay: true };
}
function success<T>(value: T): RemoteResult<T> { return { ok: true, value }; }
const translate: PropsLocale<"settings.dsmm-profiles">["t"] = (key, values) => {
  const copy = Object.hasOwn(en, key) ? en[key as keyof typeof en] : key;
  return copy.replace(/\{([^}]+)\}/gu, (placeholder, name: string) => values === undefined || !Object.hasOwn(values, name) ? placeholder : String(values[name]));
};
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function modelObservation() {
  let snapshot: unknown = { lastUsed: null, next: { provider: "native", model: "current-native" } };
  const listeners = new Set<() => void>();
  return {
    source: { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    change(value: unknown, notify = true) { snapshot = value; if (notify) for (const listener of listeners) listener(); },
    invalidate() { for (const listener of listeners) listener(); },
  };
}
function fixture(overrides: Partial<DsmmProfilesRemote> = {}) {
  const calls: string[] = [];
  const selections: SessionProfileSelectRequest[] = [];
  const remote: DsmmProfilesRemote = {
    describe: async () => { calls.push("describe"); return success(snapshot); },
    read: async (id) => { calls.push(`read:${id}`); return success({ id, content, revision }); },
    save: async (request) => { calls.push("save"); return success({ id: request.id, content: request.content, revision: otherRevision }); },
    select: async (request) => { calls.push("select"); return success({ ...snapshot, selectedId: request.id, appliedRevision: request.id === null ? null : request.expectedRevision! }); },
    describeSession: async (id) => { calls.push(`describeSession:${id}`); return success(session(id)); },
    selectSession: async (id, request) => { calls.push(`selectSession:${id}`); selections.push(request); const selection = { selectedId: request.id, appliedRevision: request.expectedRevision ?? null, selectionRevision: otherRevision }; return success({ ...session(id, "epoch-2"), selection, admittedSelection: selection, scope: "session-override" }); },
    ...overrides,
  };
  const controller = new ProfilesController(remote), observation = modelObservation();
  const events: SessionEventSource = { getSnapshot: () => ({ entries: [], hasMore: false, revision: 0, change: { kind: "replace", entries: [] } }), subscribe: () => () => {} };
  const interaction = { getSnapshot: () => ({ status: "ready" as const }), subscribe: () => () => {} };
  let currentBinding: string | null = null;
  // Unit fixture for the real native adapter's read-only keyed projection seat.
  controller.store.subscribe(() => {
    const id = controller.store.getSnapshot().currentSessionId;
    if (id !== currentBinding) {
      currentBinding = id;
      controller.attachModelSelectionSource(id, id === null ? null : observation.source);
      controller.attachModelEventSource(id, id === null ? null : events);
      controller.attachModelInteractionSource(id, id === null ? null : interaction);
    }
  });
  return { controller, calls, selections, modelObservation: observation };
}
async function settle(controller: ProfilesController) {
  for (let round = 0; round < 100 && controller.store.getSnapshot().sessionBusy !== null; round++) await setImmediate();
  assert.equal(controller.store.getSnapshot().sessionBusy, null);
}

type HeaderInput = ProfilesActions & { sessionId?: string; readProfileView(): ProfilesViewSnapshot; useProfiles(selector: (value: ProfilesViewSnapshot) => ProfilesViewSnapshot): ProfilesViewSnapshot; t: PropsLocale<"settings.dsmm-profiles">["t"] };
type HeaderComponent = (props: HeaderInput) => unknown;
function NativeProfileMenu() { throw new Error("Tree contract only; native Menu browser behavior is verified separately"); }
function NativeProfileButton() { throw new Error("Tree contract only; native Button is not rendered in this fixture"); }
function NativeProfileIcon() { throw new Error("Tree contract only; native SVG is not rendered in this fixture"); }
async function nativeHeaderComponent(name: "SessionProfiles" | "ProfilesSection" | "SessionScope" = "SessionProfiles"): Promise<HeaderComponent> {
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { SessionProfiles: HeaderComponent; ProfilesSection: HeaderComponent; SessionScope: typeof SessionScope } };
  const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
  const compiled = await build({ absWorkingDir: sourceRoot, stdin: { resolveDir: sourceRoot, contents: 'export {SessionProfiles,SessionScope} from "./src/client/SessionProfiles.tsx";export {ProfilesSection} from "./src/client/ProfilesSection.tsx";' }, bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives", "jsonc-parser"] });
  const load = (id: string) => {
    // JSX tree contract only, not a renderer/browser substitute. All header
    // behavior runs from the compiled production module and real controller.
    if (id === "react") return { ...require("react"), useId: () => "header-unit", useRef: () => ({ current: null }), useState: () => [false, () => {}], useEffect: () => {} };
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return { Button: NativeProfileButton, Menu: NativeProfileMenu, IconBranchOutlineRegular: NativeProfileIcon, Input() { throw new Error("Header tree must not render an editor"); } };
    return require(id);
  };
  runInContext(compiled.outputFiles[0].text, createContext({ module, exports: module.exports, require: load, TextEncoder, TextDecoder }));
  return name === "SessionScope" ? props => module.exports.SessionScope({ state: props.readProfileView(), actions: props, t: props.t }) : module.exports[name];
}
function headerTree(component: HeaderComponent, controller: ProfilesController, id = controller.store.getSnapshot().currentSessionId): unknown {
  return component({ ...controller.actions, readProfileView: controller.store.getSnapshot, sessionId: id ?? undefined, useProfiles: (select) => select(controller.store.getSnapshot()), t: translate });
}
function elements(tree: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...elements(tree.props.children), ...elements(tree.props.anchor), ...elements(tree.props.icon)];
}

test("one editable choice stores suggestion IDs and exact custom effort through save and read", async () => {
  function NativeChoiceInput() { throw new Error("Element contract only; native input behavior is exercised in browser QA"); }
  function NativeChoiceButton() { throw new Error("Element contract only; dropdown pointer behavior is exercised in browser QA"); }
  const require = createRequire(import.meta.url);
  const compiled = await build({ entryPoints: [fileURLToPath(new URL("../src/client/EditableChoice.tsx", import.meta.url))], bundle: true, write: false,
    platform: "node", format: "cjs", external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"] });
  const module = { exports: {} as { EditableChoice(props: EditableChoiceProps): unknown } };
  runInContext(compiled.outputFiles![0]!.text, createContext({ module, exports: module.exports,
    require: (id: string) => id === "@deepseek-ai/dsh-client-ui-primitives" ? { Input: NativeChoiceInput, Button: NativeChoiceButton, IconChevronDownOutlineRegular: NativeProfileIcon }
      : id === "react" ? { ...require(id), useRef: () => ({ current: null }), useState: (initial: unknown) => [initial === false ? true : initial, () => {}], useEffect: () => {} } : require(id) }));
  let saved = content, savedRevision = revision;
  const f = fixture({ save: async request => { saved = request.content; savedRevision = otherRevision; return success({ id: request.id, content: saved, revision: savedRevision }); },
    read: async id => success({ id, content: saved, revision: savedRevision }) });
  const writes: string[] = [], selected: string[] = [], path = ["settings", "roleRouting", "dsmm-planner", "primary", "reasoningEffort"];
  const writeValue = (value: string) => { writes.push(value); f.controller.actions.editPath(path, value); };
  let choices = [{ id: "high", name: "High" }];
  const control = () => elements(module.exports.EditableChoice({ id: "exact-effort", label: "Exact effort", value: structuredDocument(f.controller.store.getSnapshot().editor!.content)!.roleRouting["dsmm-planner"].primary!.reasoningEffort ?? "",
    options: choices, disabled: false, onChange: writeValue, onSelect: value => { selected.push(value); writeValue(value); } }));
  try {
    await f.controller.refresh(); await f.controller.actions.open("p");
    const nodes = control(), inputs = nodes.filter(node => node.type === NativeChoiceInput);
    assert.equal(inputs.length, 1);
    const list = nodes.find(node => node.props.role === "listbox")!;
    assert.equal(inputs[0]!.props["aria-controls"], list.props.id);
    const option = nodes.find(node => node.props.role === "option" && node.props["data-value"] === "high")!;
    const change = inputs[0]!.props.onChange as (event: { currentTarget: { value: string } }) => void;
    (option.props.onClick as () => void)();
    assert.equal(control().find(node => node.type === NativeChoiceInput)!.props.value, "high");
    await f.controller.actions.save(); await f.controller.actions.open("p");
    assert.equal(structuredDocument(f.controller.store.getSnapshot().editor!.content)!.roleRouting["dsmm-planner"].primary!.reasoningEffort, "high");
    change({ currentTarget: { value: "Exact-Custom-Medium" } });
    assert.deepEqual(writes, ["high", "Exact-Custom-Medium"]);
    assert.deepEqual(selected, ["high"]);
    assert.equal(control().find(node => node.type === NativeChoiceInput)!.props.value, "Exact-Custom-Medium");
    choices = [];
    assert.equal(control().find(node => node.type === NativeChoiceInput)!.props.value, "Exact-Custom-Medium");
    choices = [{ id: "low", name: "Low" }, { id: "high", name: "High" }];
    assert.equal(control().find(node => node.type === NativeChoiceInput)!.props.value, "Exact-Custom-Medium");
    assert.deepEqual(writes, ["high", "Exact-Custom-Medium"]);
    await f.controller.actions.save(); await f.controller.actions.open("p");
    assert.equal(structuredDocument(f.controller.store.getSnapshot().editor!.content)!.roleRouting["dsmm-planner"].primary!.reasoningEffort, "Exact-Custom-Medium");
    assert.ok(saved.includes("/* route comment */"));
    assert.deepEqual(structuredDocument(saved)!.roleRouting["dsmm-planner"].fallbackRoutes, structuredDocument(content)!.roleRouting["dsmm-planner"].fallbackRoutes);
  } finally { f.controller.dispose(); }
});

test("known route edits and fallback moves retain opaque JSONC parameters without interpreting them", () => {
  const raw = `{
    "version": 1, "id": "opaque", "settings": {"roleRouting": {"dsmm-builder": {
      "primary": {"provider":"custom", "model":"main", "reasoningEffort":"medium", /* opaque primary */ "temperature":0.25, "vendorKnob":{"nested":[1,"Keep Case"]}},
      "fallbackRoutes": [
        {"provider":"custom", "model":"first", "reasoningEffort":"high", /* opaque first */ "vendorFlag":false},
        {"provider":"custom", "model":"second", "reasoningEffort":"high", "vendorFlag":{"deep":true}}
      ],
      "levels":{"low":{"provider":"custom", "model":"level", "reasoningEffort":"medium", "vendorLevel":["unchanged"]}, "high":{"reasoningEffort":"Exact-Level", "vendorLevel":{"opaque":true}}}
    }}}
  }`;
  const original = parse(raw).settings.roleRouting["dsmm-builder"];
  assert.ok(currentDocument(raw));
  let next = editCurrentPath(raw, ["settings", "roleRouting", "dsmm-builder", "primary", "reasoningEffort"], "Exact-Custom")!;
  next = editCurrentPath(next, ["settings", "roleRouting", "dsmm-builder", "levels", "low", "model"], "new-level-model")!;
  next = editCurrentPath(next, ["settings", "roleRouting", "dsmm-builder", "levels", "high", "reasoningEffort"], "New-Exact-Level")!;
  next = moveCurrentFallback(next, "dsmm-builder", 0, 1)!;
  const expected = structuredClone(original);
  expected.primary.reasoningEffort = "Exact-Custom"; expected.levels.low.model = "new-level-model"; expected.levels.high.reasoningEffort = "New-Exact-Level";
  expected.fallbackRoutes.reverse();
  assert.deepEqual(parse(next).settings.roleRouting["dsmm-builder"], expected);
  assert.ok(next.includes("/* opaque primary */")); assert.ok(next.includes("/* opaque first */"));
  for (const unsafe of [raw.replace('"temperature":0.25', '"temperature":0.25,"temperature":0.5'), raw.replace('"vendorKnob":', '"__proto__":')]) {
    assert.equal(editCurrentPath(unsafe, ["settings", "roleRouting", "dsmm-builder", "primary", "model"], "rewritten"), null);
  }
});

test("accepted editor replacements keep structured and advanced controls distinct across refreshes", async () => {
  const component = await nativeHeaderComponent("ProfilesSection"), f = fixture();
  const editorKeys = () => {
    const editor = elements(headerTree(component, f.controller)).find(node => node.type === "div" && node.props.className === "dsmm-editor");
    assert.ok(editor);
    const children = editor.props.children as unknown[];
    const keys = children.filter(isValidElement).map(node => node.key).filter(key => key !== null);
    assert.ok(keys.length >= 2, "Both stateful editor controls need reconciliation identities");
    assert.equal(new Set(keys).size, keys.length, "Sibling editor keys must not duplicate stale editable controls");
    return keys;
  };
  try {
    await f.controller.refresh(); await f.controller.actions.open("p");
    const acceptedKeys = editorKeys();
    await f.controller.refresh();
    assert.deepEqual(editorKeys(), acceptedKeys);
    f.controller.actions.editContent(content + "\n// current draft\n");
    assert.deepEqual(editorKeys(), acceptedKeys);
    await f.controller.actions.save();
    const savedKeys = editorKeys();
    assert.notDeepEqual(savedKeys, acceptedKeys);
    await f.controller.refresh();
    assert.deepEqual(editorKeys(), savedKeys);
  } finally { f.controller.dispose(); }
});

test("documenting activation refusal retains safe code and field without accepting either Apply", async () => {
  const refusal = () => ({ ok: false as const, error: new RemoteError("dsmm-profiles/refused", "The Host refused the profile operation.", {
    code: "activation", message: "The configured provider, model or exact reasoning effort is unavailable in the native model catalog.",
    field: "settings.roleRouting.dsmm-documenting.primary",
  }) });
  const f = fixture({ select: async () => refusal(), selectSession: async () => refusal() });
  try {
    await f.controller.refresh(); await f.controller.actions.open("p");
    const editor = f.controller.store.getSnapshot().editor;
    await f.controller.actions.apply();
    const future = f.controller.store.getSnapshot();
    assert.deepEqual(future.issue, { kind: "domain", code: "activation", field: "settings.roleRouting.dsmm-documenting.primary" });
    assert.equal(future.notice, null); assert.deepEqual(future.snapshot, snapshot); assert.deepEqual(future.editor, editor);
    f.controller.setSession("documenting-packet"); await settle(f.controller);
    const admission = f.controller.store.getSnapshot().session;
    f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
    const current = f.controller.store.getSnapshot();
    assert.deepEqual(current.sessionIssue, future.issue);
    assert.equal(current.sessionNotice, null); assert.deepEqual(current.session, admission); assert.deepEqual(current.editor, editor);
  } finally { f.controller.dispose(); }
});

test("named legacy editor keeps its pinned selection inspectable and disables every library mutation", async () => {
  const component = await nativeHeaderComponent("ProfilesSection");
  const f = fixture({ describe: async () => success({ ...snapshot, origin: "legacy", readOnly: true, selectedId: "p", appliedRevision: revision }) });
  await f.controller.refresh(); await f.controller.actions.open("p");
  f.controller.actions.editContent(content + "\n// local unsaved edit\n");
  assert.equal(f.controller.store.getSnapshot().dirty, true);
  const nodes = elements(headerTree(component, f.controller));
  for (const copy of [en.new, en.save, en.apply, en.reset]) {
    const button = nodes.find(node => node.type === NativeProfileButton && node.props.children === copy);
    assert.ok(button, copy); assert.equal(button.props.disabled, true, copy);
  }
  assert.ok(nodes.some(node => node.props.children === en.readOnlyOrigin));
  assert.ok(nodes.some(node => node.type === "textarea" && node.props.readOnly === true && String(node.props.value).includes("untouched document comment")));
  const refresh = nodes.find(node => node.type === NativeProfileButton && node.props.children === en.refresh);assert.equal(refresh?.props.disabled, false);
  assert.equal(f.controller.store.getSnapshot().snapshot?.appliedRevision, revision);
  assert.equal(f.calls.some(call => call === "save" || call === "select"), false);
  f.controller.dispose();
});

test("profile control is an icon-only native portaled menu with no standalone visible label or status", async () => {
  const component = await nativeHeaderComponent(), f = fixture();
  await f.controller.refresh(); f.controller.setSession("native-menu-root"); await settle(f.controller);
  const nodes = elements(headerTree(component, f.controller));
  const menu = nodes.find((node) => node.type === NativeProfileMenu);
  assert.ok(menu, "released labeled select must be replaced by the actual native Menu primitive");
  assert.equal(menu.props.portal, true); assert.equal(menu.props.autoFocus, true);
  assert.equal(nodes.some((node) => ["label", "select", "p", "details", "summary"].includes(String(node.type))), false);
  const trigger = nodes.find((node) => node.type === NativeProfileButton); assert.ok(trigger);
  assert.equal(trigger.props.children, undefined); assert.equal(trigger.props["aria-label"], en.headerProfileLabel);
  assert.ok(nodes.some((node) => node.type === NativeProfileIcon));
  f.controller.dispose();
});

test("true sessionless welcome keeps the profile control inspectable without enabling a mutation", async () => {
  const component = await nativeHeaderComponent(), f = fixture(); await f.controller.refresh();
  const tree = component({ ...f.controller.actions, readProfileView: f.controller.store.getSnapshot, sessionId: undefined, useProfiles: (select) => select(f.controller.store.getSnapshot()), t: translate });
  assert.notEqual(tree, null, "undefined native identity and null controller identity are the same honest sessionless state");
  const menu = elements(tree).find((node) => node.type === NativeProfileMenu); assert.ok(menu);
  const entries = menu.props.items as MenuEntry[];
  assert.ok(entries.some((entry) => "type" in entry && entry.type === "label" && entry.id === "@status" && entry.text.length > 0));
  assert.ok(entries.filter((entry) => !("type" in entry)).every((entry) => "disabled" in entry && entry.disabled));
  assert.equal(f.controller.store.getSnapshot().currentSessionId, null); assert.deepEqual(f.selections, []);
  f.controller.dispose();
});

test("the same root menu enables on an owned blank binding and rejects a retained sessionless action", async () => {
  const component = await nativeHeaderComponent(), f = fixture(); await f.controller.refresh();
  const props: HeaderInput = { ...f.controller.actions, readProfileView: f.controller.store.getSnapshot, useProfiles: (select) => select(f.controller.store.getSnapshot()), t: translate };
  const sessionless = headerMenu(component(props));
  f.controller.setSession("owned-native-blank"); await settle(f.controller);
  const blank = component(props); assert.notEqual(blank, null);
  assert.equal(menuRowDisabled(blank), false, "root placement needs no session-only header prop to follow a real current binding");
  sessionless.props.onSelect("p"); await settle(f.controller);
  assert.equal(f.selections.length, 0, "stale sessionless menu must not act after a new view binds");
  headerMenu(blank).props.onSelect("p"); await settle(f.controller);
  assert.equal(f.selections.length, 1); assert.equal(f.selections[0].sessionId, "owned-native-blank");
  f.controller.dispose();
});
function headerMenu(tree: unknown) {
  const menu = elements(tree).find((element) => element.type === NativeProfileMenu); assert.ok(menu);
  return menu as ReactElement<{ selectedId: string; items: MenuEntry[]; onSelect(id: string): void; onClose(): void }>;
}
function menuRowDisabled(tree: unknown, id = "p"): boolean {
  const entry = headerMenu(tree).props.items.find((entry) => entry.id === id && !("type" in entry)); assert.ok(entry);
  return "disabled" in entry && entry.disabled === true;
}
function menuFeedback(tree: unknown): string {
  const entry = headerMenu(tree).props.items.find((entry) => entry.id === "@status");
  return entry !== undefined && "type" in entry && entry.type === "label" ? entry.text : "";
}

test("structured path editing preserves unrelated JSONC and explicit inheritance/empty-chain semantics", () => {
  const next = editStructuredPath(content, ["settings", "roleRouting", "dsmm-planner", "rateLimit", "maxRetries"], 4)!;
  assert.ok(next.includes('// untouched document comment'));
  assert.ok(next.includes('"workflow": { "reviewCap": 2 }, // untouched workflow bytes'));
  assert.ok(next.includes('/* route comment */'));
  const empty = editStructuredPath(next, ["settings", "roleRouting", "dsmm-planner", "fallbackRoutes"], [])!;
  assert.deepEqual(structuredDocument(empty)!.roleRouting["dsmm-planner"].fallbackRoutes, []);
  const inherited = editStructuredPath(empty, ["settings", "roleRouting", "dsmm-planner", "fallbackRoutes"], undefined)!;
  assert.equal(Object.hasOwn(structuredDocument(inherited)!.roleRouting["dsmm-planner"], "fallbackRoutes"), false);
  assert.equal(structuredDocument(content)!.roleRouting["dsmm-planner"].rateLimit!.maxRetries, 0);
});

test("fallback reorder preserves original object text/comments and never mutates an out-of-range index", () => {
  const next = moveFallback(content, "dsmm-planner", 1, 0)!;
  assert.deepEqual(structuredDocument(next)!.roleRouting["dsmm-planner"].fallbackRoutes!.map((route) => route.provider), ["two", "one"]);
  assert.ok(next.includes('{ "provider": "one", /* first preserved */ "model": "m1" }'));
  assert.ok(next.includes('{ "provider": "two", /* second preserved */ "model": "m2", "reasoningEffort": "max" }'));
  assert.equal(moveFallback(content, "dsmm-planner", 0, -1), null);
});

test("invalid raw syntax, duplicate keys, unsafe keys and malformed policies cannot be normalized by structured controls", () => {
  for (const invalid of [content.slice(0, -4), content.replace('"version": 1', '"version": 1, "version": 1'), content.replace('"reviewCap": 2', '"__proto__": {}'), content.replace('"maxRetries": 0', '"maxRetries": 99'), content.replace('"strategy": "rate-limit-fallback"', '"strategy": "unknown"')]) {
    assert.equal(structuredDocument(invalid), null);
    assert.equal(editStructuredPath(invalid, ["label"], "normalized"), null);
  }
});

test("native catalog refresh retains exact manual route/effort and only explicit model edits clear effort", async () => {
  const f = fixture();
  await f.controller.refresh(); await f.controller.open("p");
  const catalog: ModelCatalog = { default: { provider: "listed", model: "other" }, routableProviders: ["listed"], groups: [], failures: [] };
  f.controller.attachCatalog({ modelCatalog: async () => success(catalog) });
  await setImmediate();
  assert.equal(f.controller.store.getSnapshot().editor!.content, content);
  assert.equal(f.controller.store.getSnapshot().dirty, false);
  f.controller.actions.editRoute(["settings", "roleRouting", "dsmm-planner", "primary"], "manual", "new-unlisted");
  const next = f.controller.store.getSnapshot().editor!.content;
  assert.equal(structuredDocument(next)!.roleRouting["dsmm-planner"].primary!.reasoningEffort, undefined);
  assert.ok(next.includes('/* route comment */'));
  assert.ok(next.includes('"workflow": { "reviewCap": 2 }, // untouched workflow bytes'));
  assert.deepEqual(f.calls, ["describe", "read:p"]);
  f.controller.dispose();
});

test("manual medium and fallback routes pass unchanged through save and both profile Apply boundaries", async () => {
  const manual = { provider: "manual-provider", model: "unlisted-model", reasoningEffort: "medium" };
  const fallbacks = [
    { provider: "fallback-one", model: "fallback-model", reasoningEffort: "high" },
    { provider: "fallback-two", model: "fallback-model", reasoningEffort: "high" },
  ];
  const draft = JSON.stringify({ version: 1, id: "p", settings: { roleRouting: { "dsmm-documenting": { primary: manual, fallbackRoutes: fallbacks } } } });
  for (const scope of ["future-default", "current-session"] as const) {
    const saves: string[] = [], defaults: unknown[] = [];
    const f = fixture({
      read: async id => success({ id, content: draft, revision }),
      save: async request => { saves.push(request.content); return success({ id: request.id, content: request.content, revision: otherRevision }); },
      select: async request => { defaults.push(request); return success({ ...snapshot, profiles: [{ id: "p", revision: otherRevision }], selectedId: request.id, appliedRevision: otherRevision, selectionRevision: otherRevision }); },
    });
    try {
      await f.controller.refresh(); await f.controller.actions.open("p");
      f.controller.attachCatalog({ modelCatalog: async () => success({ default: { provider: "listed", model: "other" }, routableProviders: ["listed"], groups: [], failures: [] }) });
      await setImmediate();
      assert.equal(f.controller.store.getSnapshot().editor!.content, draft);
      f.controller.actions.editPath(["label"], "Manual profile");
      const submitted = f.controller.store.getSnapshot().editor!.content;
      await f.controller.actions.save();
      assert.deepEqual(saves, [submitted]);
      assert.deepEqual(structuredDocument(submitted)!.roleRouting["dsmm-documenting"], { primary: manual, fallbackRoutes: fallbacks });
      if (scope === "future-default") {
        await f.controller.actions.apply();
        assert.deepEqual(defaults, [{ id: "p", expectedRevision: otherRevision, expectedSelectionRevision: "absent" }]);
        assert.equal(f.controller.store.getSnapshot().issue, null);
        assert.equal(f.controller.store.getSnapshot().notice?.key, "applied");
      } else {
        f.controller.setSession("manual-medium"); await settle(f.controller);
        f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
        assert.deepEqual(f.selections, [{ sessionId: "manual-medium", id: "p", expectedRevision: otherRevision, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "epoch-1" }]);
        assert.deepEqual(defaults, []);
        assert.equal(f.controller.store.getSnapshot().sessionIssue, null);
        assert.equal(f.controller.store.getSnapshot().sessionNotice, "applied");
      }
      assert.equal(f.controller.store.getSnapshot().editor!.content, submitted);
    } finally { f.controller.dispose(); }
  }
});

test("current-session Apply uses session CAS/epoch without selecting the global default or changing the draft", async () => {
  const f = fixture();
  await f.controller.refresh(); await f.controller.open("p");
  f.controller.setSession("native-root-one"); await settle(f.controller);
  f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
  assert.deepEqual(f.selections, [{ sessionId: "native-root-one", id: "p", expectedRevision: revision, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "epoch-1" }]);
  assert.equal(f.controller.store.getSnapshot().snapshot!.selectedId, null);
  assert.equal(f.controller.store.getSnapshot().editor!.content, content);
  assert.equal(f.controller.store.getSnapshot().session!.admissionEpoch, "epoch-2");
  assert.equal(f.calls.includes("select"), false);
  f.controller.dispose();
});

test("session labels keep captured profile A distinct from future global B without changing CAS or a dirty draft", async () => {
  const captured: SessionProfileSnapshot = {
    ...session("native-admitted-a"),
    globalDefault: { selectedId: "profile-b", appliedRevision: otherRevision, selectionRevision: otherRevision },
    admittedSelection: { selectedId: "profile-a", appliedRevision: revision, selectionRevision: revision },
  };
  const f = fixture({ describeSession: async () => success(captured) });
  await f.controller.refresh(); await f.controller.open("p");
  f.controller.actions.editPath(["label"], "Keep this dirty draft");
  const draft = f.controller.store.getSnapshot().editor!.content;
  f.controller.setSession(captured.sessionId); await settle(f.controller);
  const state = f.controller.store.getSnapshot();
  const labels = sessionProfileLabels(state.session!, translate);
  assert.ok(labels.admitted.includes("profile-a"));
  assert.equal(labels.admitted.includes("profile-b"), false);
  assert.ok(labels.futureDefault.includes("profile-b"));
  assert.deepEqual(state.session!.selection, { selectedId: null, appliedRevision: null, selectionRevision: "absent" });
  assert.equal(state.sessionChoice, "profile-a", "the selector shows admitted configuration while sidecar CAS stays independent");
  assert.equal(state.editor!.content, draft); assert.equal(state.dirty, true);
  assert.equal(f.calls.includes("select"), false); assert.deepEqual(f.selections, []);
  f.controller.dispose();
});

test("old session DTO labels remain honest when exact admitted identity is absent", () => {
  const old = { ...session("old-native"), globalDefault: { selectedId: "new-global", appliedRevision: otherRevision, selectionRevision: otherRevision } };
  const labels = sessionProfileLabels(old, translate);
  assert.ok(labels.admitted.includes(en.sessionGlobalCaptured));
  assert.equal(labels.admitted.includes("new-global"), false);
  assert.equal(labels.admitted.includes("deployment baseline"), false);
  assert.ok(labels.futureDefault.includes("new-global"));
  const explicit = { ...old, scope: "session-override" as const, selection: { selectedId: "pinned-old", appliedRevision: revision, selectionRevision: revision } };
  assert.equal(sessionProfileLabels(explicit, translate).admitted.includes("pinned-old"), false, "a sidecar alone is not an exact live admission");
});

test("native profile menu retains admitted unavailable identity without standalone profile text", async () => {
  const component = await nativeHeaderComponent();
  const admitted = { ...session("header-root"), admittedSelection: { selectedId: "missing-pinned", appliedRevision: revision, selectionRevision: revision } };
  const f = fixture({ describeSession: async () => success(admitted) });
  await f.controller.refresh(); f.controller.setSession(admitted.sessionId); await settle(f.controller);
  const tree = headerTree(component, f.controller);
  const nodes = elements(tree);
  assert.equal(nodes.filter((node) => node.type === NativeProfileMenu).length, 1);
  assert.equal(nodes.filter((node) => ["label", "select", "details", "summary", "p"].includes(String(node.type))).length, 0);
  const menu = headerMenu(tree);
  assert.equal(menu.props.selectedId, "missing-pinned", "an absent sidecar must not mislabel the admitted profile as baseline");
  assert.equal(menuRowDisabled(tree, "missing-pinned"), true);
  assert.deepEqual(f.selections, []);
  f.controller.dispose();
});

test("native menu immediately applies with existing CAS, then displays accepted admission without global mutation", async () => {
  const component = await nativeHeaderComponent();
  const f = fixture(); await f.controller.refresh(); f.controller.setSession("header-root"); await settle(f.controller);
  headerMenu(headerTree(component, f.controller)).props.onSelect("p"); await settle(f.controller);
  assert.deepEqual(f.selections, [{ sessionId: "header-root", id: "p", expectedRevision: revision, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "epoch-1" }]);
  assert.equal(headerMenu(headerTree(component, f.controller)).props.selectedId, "p");
  assert.equal(f.calls.includes("select"), false);
  f.controller.dispose();
});

test("header refusal retains admitted selection and dirty drafts disable selection without automatic discard", async () => {
  const component = await nativeHeaderComponent();
  const admitted = { ...session("header-root"), admittedSelection: { selectedId: "old-profile", appliedRevision: revision, selectionRevision: revision } };
  const f = fixture({ describeSession: async () => success(admitted), selectSession: async () => ({ ok: false, error: new RemoteError("dsmm-profiles/refused", "refused", { code: "conflict", message: "Epoch changed" }) }) });
  await f.controller.refresh(); f.controller.setSession(admitted.sessionId); await settle(f.controller);
  headerMenu(headerTree(component, f.controller)).props.onSelect("p"); await settle(f.controller);
  const refused = headerTree(component, f.controller);
  assert.equal(headerMenu(refused).props.selectedId, "old-profile");
  assert.equal(menuFeedback(refused), en.headerConflict);
  assert.ok(elements(refused).some((node) => node.type === "span" && node.props.role === "alert"));
  await f.controller.open("p"); f.controller.actions.editPath(["label"], "Keep dirty header draft");
  const draft = f.controller.store.getSnapshot().editor!.content;
  const dirty = headerTree(component, f.controller); assert.equal(menuRowDisabled(dirty), true);
  headerMenu(dirty).props.onSelect(""); await settle(f.controller);
  assert.equal(f.controller.store.getSnapshot().editor!.content, draft);
  assert.equal(f.controller.store.getSnapshot().session!.admissionEpoch, "epoch-1");
  f.controller.dispose();
});

test("refused activation exposes only its canonical code and configuration field with an in-menu recovery hint", async () => {
  const component = await nativeHeaderComponent();
  const field = "settings.roleRouting.dsmm-doc-search.primary";
  const f = fixture({ selectSession: async () => ({ ok: false, error: new RemoteError("dsmm-profiles/refused", "PRIVATE_PROVIDER_TOKEN must not be rendered", { code: "activation", field, message: "PRIVATE_PROVIDER_TOKEN must not be rendered" }) }) });
  await f.controller.refresh(); f.controller.setSession("activation-refused"); await settle(f.controller);
  headerMenu(headerTree(component, f.controller)).props.onSelect("p"); await settle(f.controller);
  const menu = headerMenu(headerTree(component, f.controller));
  const diagnostics = menu.props.items.filter((entry) => "type" in entry && entry.type === "label").map((entry) => "text" in entry ? entry.text : "").join(" ");
  assert.ok(diagnostics.includes("activation"), "generic refusal copy currently hides the actionable refusal code");
  assert.ok(diagnostics.includes(field), "canonical configuration fields must remain actionable");
  assert.ok(diagnostics.includes("Refresh") && diagnostics.includes("retry"));
  assert.equal(diagnostics.includes("PRIVATE_PROVIDER_TOKEN"), false);
  assert.equal(f.controller.store.getSnapshot().session!.admissionEpoch, "epoch-1");
  f.controller.dispose();
});

test("refusal menu never echoes raw messages, filesystem paths or credential-shaped fields", async () => {
  const component = await nativeHeaderComponent();
  for (const field of ["C:\\private\\PRIVATE_PATH", "../../PRIVATE_PATH", "settings.roleRouting.dsmm-doc-search.primary?token=PRIVATE_TOKEN", "settings.roleRouting.custom-secret.primary"]) {
    const f = fixture({ selectSession: async () => ({ ok: false, error: new RemoteError("dsmm-profiles/refused", "PRIVATE_MESSAGE", { code: "activation", field, message: "PRIVATE_MESSAGE" }) }) });
    await f.controller.refresh(); f.controller.setSession("private-refusal"); await settle(f.controller);
    headerMenu(headerTree(component, f.controller)).props.onSelect("p"); await settle(f.controller);
    const diagnostics = JSON.stringify(headerMenu(headerTree(component, f.controller)).props.items);
    assert.ok(diagnostics.includes("unavailable"), "invalid diagnostic DTO fails closed before presentation");
    assert.equal(diagnostics.includes(field), false); assert.equal(/PRIVATE_|custom-secret/u.test(diagnostics), false);
    f.controller.dispose();
  }
});

test("header distinguishes unknown captured defaults from explicit baseline and fences old-view response", async () => {
  const component = await nativeHeaderComponent(); const pending = deferred<RemoteResult<SessionProfileSnapshot>>();
  const baseline = fixture({ describeSession: async (id) => success({ ...session(id), scope: "deployment-baseline", admittedSelection: { selectedId: null, appliedRevision: null, selectionRevision: revision } }) });
  await baseline.controller.refresh(); baseline.controller.setSession("explicit-baseline"); await settle(baseline.controller);
  assert.equal(headerMenu(headerTree(component, baseline.controller)).props.selectedId, "");
  baseline.controller.dispose();
  const f = fixture({ selectSession: async () => pending.promise });
  await f.controller.refresh(); f.controller.setSession("old-header"); await settle(f.controller);
  assert.equal(headerMenu(headerTree(component, f.controller)).props.selectedId, "__dsmm_captured_default__");
  const retainedMenu = headerMenu(headerTree(component, f.controller));
  retainedMenu.props.onSelect("p");
  assert.equal(menuRowDisabled(headerTree(component, f.controller)), true);
  f.controller.setSession("new-header"); await settle(f.controller);
  pending.resolve(success({ ...session("old-header", "old-new-epoch"), scope: "session-override", selection: { selectedId: "p", appliedRevision: revision, selectionRevision: otherRevision } })); await setImmediate();
  assert.equal(headerTree(component, f.controller, "old-header"), null);
  assert.equal(headerMenu(headerTree(component, f.controller)).props.selectedId, "__dsmm_captured_default__");
  const count = f.selections.length; retainedMenu.props.onSelect("p"); await settle(f.controller);
  assert.equal(f.selections.length, count, "a retained foreign-view menu callback cannot act on the new current session");
  assert.equal(f.controller.store.getSnapshot().sessionNotice, null);
  f.controller.dispose();
});

test("busy-session menu keeps its trigger inspectable, explains refusal inside and disables mutation rows", async () => {
  const component = await nativeHeaderComponent();
  const f = fixture({ describeSession: async (id) => success({ ...session(id), switchAllowed: false, switchUnavailableReason: "busy", canApplyOverlay: false, applyOverlayUnavailableReason: "busy" }) });
  await f.controller.refresh(); f.controller.setSession("busy-header"); await settle(f.controller);
  const tree = headerTree(component, f.controller);
  assert.equal(menuRowDisabled(tree), true);
  assert.ok(headerMenu(tree).props.items.some(entry => entry.id === "@overlay-reason" && "text" in entry && entry.text));
  const trigger = elements(tree).find((node) => node.type === NativeProfileButton); assert.ok(trigger); assert.notEqual(trigger.props.disabled, true);
  headerMenu(tree).props.onSelect("p"); await settle(f.controller);
  assert.deepEqual(f.selections, []);
  f.controller.dispose();
});

function appliedWithModel(id: string, model = "profile-main"): SessionProfileSnapshot {
  return { ...session(id, "epoch-2"), scope: "session-override", selection: { selectedId: "p", appliedRevision: revision, selectionRevision: otherRevision },
    admittedSelection: { selectedId: "p", appliedRevision: revision, selectionRevision: otherRevision },
    profileModel: { provider: "manual-provider", model, reasoningEffort: "exact-profile-effort" } };
}

test("running native model selection stays available while overlay requires a new session and mode is busy", async () => {
  const component = await nativeHeaderComponent(), scope = await nativeHeaderComponent("SessionScope");
  const frame = (id: string): SessionProfileSnapshot => ({ ...appliedWithModel(id), switchAllowed: false,
    canApplyOverlay: false, applyOverlayUnavailableReason: "new-session-required", canToggleMode: false, toggleModeUnavailableReason: "busy",
    deepwork: { active: false, explicit: false, locked: false, revision } });
  const models: SessionSelectModelRequest[] = []; let modes = 0;
  const f = fixture({ describeSession: async id => success(frame(id)), selectMode: async id => { modes++; return success(frame(id)); } });
  f.controller.attachModelSelector({ selectModel: async request => { models.push(request); return success({ selected: request }); } });
  try {
    await f.controller.refresh(); f.controller.setSession("running-capabilities"); await settle(f.controller);
    const tree = headerTree(component, f.controller);
    assert.equal(menuRowDisabled(tree, "p"), true); assert.equal(menuRowDisabled(tree, ""), true);
    assert.equal(menuRowDisabled(tree, "@mode"), true); assert.equal(menuRowDisabled(tree, "@use-model"), false);
    for (const id of ["@overlay-reason", "@mode-reason"]) assert.ok(headerMenu(tree).props.items.some(entry => entry.id === id && "text" in entry && entry.text));
    const nodes = elements(headerTree(scope, f.controller));
    const buttons = nodes.filter(node => node.type === NativeProfileButton);
    assert.equal(buttons.find(node => node.props.children === en.headerUseCurrentModel)!.props.disabled, false);
    for (const label of [en.sessionApply, en.sessionReset]) {
      const button = buttons.find(node => node.props.children === label)!;
      assert.equal(button.props.disabled, true);
      assert.ok(nodes.some(node => node.props.id === button.props["aria-describedby"]));
    }
    headerMenu(tree).props.onSelect("p"); headerMenu(tree).props.onSelect("@mode");
    await f.controller.actions.applySession(); await f.controller.actions.resetSession(); await f.controller.actions.setDeepwork(true);
    assert.deepEqual(f.selections, []); assert.equal(modes, 0);
    headerMenu(tree).props.onSelect("@use-model"); await settle(f.controller);
    assert.equal(models.length, 1); assert.equal(models[0]!.model, "profile-main"); assert.deepEqual(f.selections, []);
    await f.controller.open("p"); f.controller.actions.setFieldInvalid("maxRetries", true); f.controller.actions.editContent(content);
    assert.equal(f.controller.store.getSnapshot().dirty, false);
    assert.equal(menuRowDisabled(headerTree(component, f.controller), "@use-model"), true);
    await f.controller.actions.useSessionProfileModel(); assert.equal(models.length, 1);
    f.controller.actions.setFieldInvalid("maxRetries", false);
    f.controller.actions.editPath(["label"], "Independent save"); await f.controller.save(); await f.controller.apply();
    assert.ok(f.calls.includes("save")); assert.ok(f.calls.includes("select")); assert.deepEqual(f.selections, []);
  } finally { f.controller.dispose(); }
});

test("mode capability is independent of overlay and profile-model capabilities", async () => {
  const component = await nativeHeaderComponent(); let modes = 0;
  const frame = (id: string): SessionProfileSnapshot => ({ ...session(id), switchAllowed: false,
    canApplyOverlay: false, applyOverlayUnavailableReason: "new-session-required", canSelectModel: false, selectModelUnavailableReason: "model-unconfigured",
    deepwork: { active: false, explicit: false, locked: false, revision } });
  const f = fixture({ describeSession: async id => success(frame(id)), selectMode: async (id, request) => {
    modes++; return success({ ...frame(id), deepwork: { active: request.active, explicit: true, locked: false, revision: otherRevision } });
  } });
  try {
    await f.controller.refresh(); f.controller.setSession("independent-mode"); await settle(f.controller);
    const tree = headerTree(component, f.controller);
    assert.equal(menuRowDisabled(tree, "@mode"), false); assert.equal(menuRowDisabled(tree, "@use-model"), true); assert.equal(menuRowDisabled(tree, "p"), true);
    headerMenu(tree).props.onSelect("@mode"); await settle(f.controller);
    assert.equal(modes, 1); assert.equal(f.controller.store.getSnapshot().session!.deepwork!.active, true); assert.deepEqual(f.selections, []);
  } finally { f.controller.dispose(); }
});

test("missing action capabilities fail closed despite a permissive legacy overlay flag", async () => {
  const component = await nativeHeaderComponent(); let modes = 0, models = 0;
  const frame = (id: string) => {
    const value = { ...appliedWithModel(id), deepwork: { active: false, explicit: false, locked: false, revision } };
    for (const key of ["canApplyOverlay", "canSelectModel", "canToggleMode"]) Reflect.deleteProperty(value, key);
    return value;
  };
  const f = fixture({ describeSession: async id => success(frame(id)), selectMode: async id => { modes++; return success(frame(id)); } });
  f.controller.attachModelSelector({ selectModel: async request => { models++; return success({ selected: request }); } });
  try {
    await f.controller.refresh(); f.controller.setSession("unknown-capabilities"); await settle(f.controller);
    const tree = headerTree(component, f.controller);
    for (const id of ["p", "", "@use-model", "@mode"]) assert.equal(menuRowDisabled(tree, id), true);
    await f.controller.actions.applySession(); await f.controller.actions.resetSession(); await f.controller.actions.useSessionProfileModel(); await f.controller.actions.setDeepwork(true);
    assert.deepEqual(f.selections, []); assert.equal(modes, 0); assert.equal(models, 0);
  } finally { f.controller.dispose(); }
});

test("model-only reread rechecks capability and serializes competing requests", async () => {
  const accepted = deferred<RemoteResult<SessionProfileSnapshot>>(); let hold = false, reads = 0, models = 0;
  const frame = (id: string): SessionProfileSnapshot => ({ ...appliedWithModel(id), switchAllowed: false, canApplyOverlay: false, applyOverlayUnavailableReason: "new-session-required" });
  const f = fixture({ describeSession: async id => { reads++; return hold ? accepted.promise : success(frame(id)); } });
  f.controller.attachModelSelector({ selectModel: async request => { models++; return success({ selected: request }); } });
  try {
    f.controller.setSession("withdrawn-capability"); await settle(f.controller);
    hold = true; const selecting = f.controller.actions.useSessionProfileModel();
    await f.controller.actions.useSessionProfileModel(); await f.controller.actions.applySession(); await f.controller.actions.resetSession();
    assert.equal(reads, 2); assert.deepEqual(f.selections, []);
    accepted.resolve(success({ ...frame("withdrawn-capability"), canSelectModel: false, selectModelUnavailableReason: "maintenance" })); await selecting;
    assert.equal(models, 0); assert.equal(f.controller.store.getSnapshot().sessionIssue?.code, "maintenance");
    assert.equal(f.controller.store.getSnapshot().sessionNotice, null);
  } finally { f.controller.dispose(); }
});

test("model-only late reread cannot dispatch after session identity changes or disposal", async () => {
  for (const boundary of ["session", "dispose"] as const) {
    const accepted = deferred<RemoteResult<SessionProfileSnapshot>>(); let hold = false, models = 0;
    const f = fixture({ describeSession: async id => hold && id === "old-model" ? accepted.promise : success(appliedWithModel(id)) });
    f.controller.attachModelSelector({ selectModel: async request => { models++; return success({ selected: request }); } });
    f.controller.setSession("old-model"); await settle(f.controller); hold = true;
    const selecting = f.controller.actions.useSessionProfileModel();
    if (boundary === "session") { f.controller.setSession("new-model"); await settle(f.controller); } else f.controller.dispose();
    const before = f.controller.store.getSnapshot();
    accepted.resolve(success(appliedWithModel("old-model"))); await selecting;
    assert.equal(models, 0); assert.equal(f.controller.store.getSnapshot(), before);
    f.controller.dispose();
  }
});

test("normal switches, profile saves, model-field edits and session reads never select a native model", async () => {
  const calls: SessionSelectModelRequest[] = [];
  const f = fixture({ describeSession: async (id) => success({ ...session(id), profileModel: appliedWithModel(id).profileModel }), selectSession: async (id) => success(appliedWithModel(id)) });
  f.controller.attachModelSelector({ selectModel: async (request) => { calls.push(request); return success({ selected: request }); } });
  await f.controller.refresh(); f.controller.setSession("preserve-native"); await settle(f.controller);
  await f.controller.actions.refreshSession();
  f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
  await f.controller.open("p"); f.controller.actions.editRoute(["settings", "roleRouting", "dsmm-planner", "primary"], "edited-provider", "edited-model");
  await f.controller.actions.save();
  assert.deepEqual(calls, []);
  f.controller.dispose();
});

test("compact menu has one profile list and a model-only action using the admitted snapshot", async () => {
  const component = await nativeHeaderComponent(); const accepted = deferred<RemoteResult<SessionProfileSnapshot>>();
  const calls: SessionSelectModelRequest[] = [];
  let hold = false;
  const f = fixture({ describeSession: async (id) => hold ? accepted.promise : success(appliedWithModel(id)) });
  f.controller.attachModelSelector({ selectModel: async (request) => { calls.push(request); return success({ selected: request }); } });
  await f.controller.refresh(); f.controller.setSession("explicit-native"); await settle(f.controller);
  const tree = headerTree(component, f.controller);
  const menu = headerMenu(tree);
  assert.equal(menu.props.items.filter((entry) => entry.id === "p").length, 1);
  assert.equal(menu.props.items.some((entry) => entry.id === "@model-hint" || entry.id.startsWith("@model:")), false);
  const option = menu.props.items.find((entry) => entry.id === "@use-model"); assert.ok(option);
  assert.equal(isProfileId(option.id), false, "model-action options cannot collide with any profile ID");
  hold = true;
  menu.props.onSelect("@use-model");
  assert.deepEqual(calls, []);
  const admitted = appliedWithModel("explicit-native");
  accepted.resolve(success({ ...admitted, profileModel: { ...admitted.profileModel!, customParameters: { raw: false }, temperature: 0 } })); await settle(f.controller);
  assert.deepEqual(calls, [{ sessionId: "explicit-native", provider: "manual-provider", model: "profile-main", reasoningEffort: "exact-profile-effort" }]);
  assert.equal(f.controller.store.getSnapshot().sessionNotice, "applied-with-model");
  assert.equal(headerMenu(headerTree(component, f.controller)).props.selectedId, "p", "the admitted ID, never an action prefix, remains selected");
  assert.equal(f.controller.store.getSnapshot().snapshot!.selectedId, null);
  assert.equal(f.selections.length, 0, "model-only action never re-admits the saved profile's latest revision");
  f.controller.dispose();
});

test("menu mode control uses accepted session state, preserves a dirty draft and never changes native models", async () => {
  const component = await nativeHeaderComponent();
  const writes: unknown[] = [], models: unknown[] = [];
  let mode = { active: false, explicit: false, locked: false, revision };
  const f = fixture({ describeSession: async (id) => success({ ...session(id), deepwork: mode }), selectMode: async (id, request) => {
    writes.push(request); mode = { ...mode, active: request.active, explicit: true, revision: otherRevision };
    return success({ ...session(id), deepwork: mode });
  } });
  f.controller.attachModelSelector({ selectModel: async (request) => { models.push(request); return success({ selected: request }); } });
  await f.controller.refresh(); f.controller.setSession("mode-menu"); await settle(f.controller);
  await f.controller.open("p"); f.controller.actions.editContent(content + "\n// draft retained");
  const draft = f.controller.store.getSnapshot().editor!.content;
  const tree = headerTree(component, f.controller);
  assert.equal(menuRowDisabled(tree, "@mode"), false, "mode intent is independent of unsaved profile edits");
  headerMenu(tree).props.onSelect("@mode"); await settle(f.controller);
  assert.deepEqual(writes, [{ sessionId: "mode-menu", active: true, expectedModeRevision: revision, expectedAdmissionEpoch: session("mode-menu").admissionEpoch }]);
  assert.equal(f.controller.store.getSnapshot().session!.deepwork!.active, true);
  assert.equal(f.controller.store.getSnapshot().editor!.content, draft); assert.equal(f.controller.store.getSnapshot().dirty, true);
  assert.equal(f.controller.store.getSnapshot().sessionNotice, "mode-on"); assert.deepEqual(models, []); assert.deepEqual(f.selections, []);
  f.controller.dispose();
});

test("failed or late mode writes cannot optimistically toggle or publish into a different native session", async () => {
  const pending = deferred<RemoteResult<SessionProfileSnapshot>>();
  const f = fixture({ describeSession: async (id) => success({ ...session(id), deepwork: { active: false, explicit: false, locked: false, revision } }), selectMode: async () => pending.promise });
  f.controller.setSession("first-mode"); await settle(f.controller);
  const changing = f.controller.actions.setDeepwork(true);
  assert.equal(f.controller.store.getSnapshot().session!.deepwork!.active, false);
  f.controller.setSession("second-mode"); await settle(f.controller);
  pending.resolve(success({ ...session("first-mode"), deepwork: { active: true, explicit: true, locked: false, revision: otherRevision } }));
  await changing;
  assert.equal(f.controller.store.getSnapshot().session!.sessionId, "second-mode"); assert.equal(f.controller.store.getSnapshot().session!.deepwork!.active, false);
  f.controller.dispose();
  const failed = fixture({ describeSession: async (id) => success({ ...session(id), deepwork: { active: false, explicit: false, locked: false, revision } }), selectMode: async () => { throw new Error("PRIVATE_PROVIDER_KEY"); } });
  failed.controller.setSession("failed-mode"); await settle(failed.controller); await failed.controller.actions.setDeepwork(true);
  assert.equal(failed.controller.store.getSnapshot().session!.deepwork!.active, false); assert.equal(failed.controller.store.getSnapshot().sessionNotice, null);
  assert.doesNotMatch(JSON.stringify(failed.controller.store.getSnapshot()), /PRIVATE_PROVIDER_KEY/u);
  failed.controller.dispose();
});

test("model-only action fences a changed admission and newer native model intent without profile CAS", async () => {
  let reads = 0;
  const f = fixture({ describeSession: async (id) => success({ ...appliedWithModel(id), ...(reads++ > 0 ? { admissionEpoch: otherRevision } : {}) }) });
  const models: unknown[] = [];
  f.controller.attachModelSelector({ selectModel: async (request) => { models.push(request); return success({ selected: request }); } });
  f.controller.setSession("model-only-conflict"); await settle(f.controller); await f.controller.actions.useSessionProfileModel();
  assert.equal(f.controller.store.getSnapshot().sessionIssue!.code, "conflict"); assert.deepEqual(models, []); assert.deepEqual(f.selections, []);
  f.controller.dispose();
});

test("resident native mode and preset events refresh the menu without loading history or applying profiles", async () => {
  let active = false, reads = 0;
  const f = fixture({ describeSession: async (id) => { reads++; return success({ ...session(id), deepwork: { active, explicit: true, locked: false, revision: active ? otherRevision : revision } }); } });
  f.controller.setSession("observed-mode"); await settle(f.controller);
  const native = Session.create(SessionId("observed-mode"));
  let window: SessionEventWindow = { entries: [], revision: 0, hasMore: false, change: { kind: "replace", entries: [] } };
  let notify = () => {};
  f.controller.attachModelEventSource("observed-mode", { getSnapshot: () => window, subscribe: (listener) => { notify = listener; return () => { notify = () => {}; }; } });
  const emit = (event: ReturnType<typeof native.append>) => {
    const row = { type: "event" as const, event };
    window = { ...window, entries: [...window.entries, row], revision: window.revision + 1, change: { kind: "append", entries: [row] } };
    notify();
  };
  active = true; emit(native.append("deepwork/mode", { active: true })); await settle(f.controller);
  assert.equal(f.controller.store.getSnapshot().session!.deepwork!.active, true); assert.equal(reads, 2);
  notify(); await settle(f.controller); assert.equal(reads, 2, "identical observed metadata does not loop-refresh");
  active = false; emit(native.append("agent-preset/selected", { agentPreset: "minimal" })); await settle(f.controller);
  assert.equal(f.controller.store.getSnapshot().session!.deepwork!.active, false); assert.equal(reads, 3);
  assert.deepEqual(f.selections, []); f.controller.dispose();
});

test("mode/preset events during an older in-flight read coalesce one follow-up read instead of leaving stale mode", async () => {
  const oldRead = deferred<RemoteResult<SessionProfileSnapshot>>(); let reads = 0;
  const mode = (active: boolean) => ({ active, explicit: active, locked: false, revision: active ? otherRevision : revision });
  const f = fixture({ describeSession: async (id) => { reads++; return reads === 1 ? oldRead.promise : success({ ...session(id), deepwork: mode(true) }); } });
  f.controller.setSession("mode-inflight");
  const native = Session.create(SessionId("mode-inflight"));
  let window: SessionEventWindow = { entries: [], revision: 0, hasMore: false, change: { kind: "replace", entries: [] } };
  let notify = () => {};
  f.controller.attachModelEventSource("mode-inflight", { getSnapshot: () => window, subscribe: (listener) => { notify = listener; return () => {}; } });
  const rows = [native.append("deepwork/mode", { active: true }), native.append("agent-preset/selected", { agentPreset: "minimal" })].map(event => ({ type: "event" as const, event }));
  window = { ...window, entries: rows, revision: 1, change: { kind: "append", entries: rows } }; notify(); notify();
  assert.equal(reads, 1);
  oldRead.resolve(success({ ...session("mode-inflight"), deepwork: mode(false) })); await settle(f.controller);
  assert.equal(reads, 2); assert.equal(f.controller.store.getSnapshot().session!.deepwork!.active, true);
  assert.deepEqual(f.selections, []); f.controller.dispose();
});

test("model-only read also fences newer same-session preset intent before native selection", async () => {
  const accepted = deferred<RemoteResult<SessionProfileSnapshot>>(); let hold = false;
  const state = (id: string) => ({ ...appliedWithModel(id), deepwork: { active: true, explicit: false, locked: false, revision } });
  const f = fixture({ describeSession: async (id) => hold ? accepted.promise : success(state(id)) });
  let calls = 0;
  f.controller.attachModelSelector({ selectModel: async (request) => { calls++; return success({ selected: request }); } });
  f.controller.setSession("model-preset-race"); await settle(f.controller);
  const native = Session.create(SessionId("model-preset-race"));
  let window: SessionEventWindow = { entries: [], revision: 0, hasMore: false, change: { kind: "replace", entries: [] } };
  let notify = () => {};
  f.controller.attachModelEventSource("model-preset-race", { getSnapshot: () => window, subscribe: (listener) => { notify = listener; return () => {}; } });
  hold = true; const selecting = f.controller.actions.useSessionProfileModel();
  const row = { type: "event" as const, event: native.append("agent-preset/selected", { agentPreset: "minimal" }) };
  window = { ...window, entries: [row], revision: 1, change: { kind: "append", entries: [row] } }; notify();
  accepted.resolve(success(state("model-preset-race"))); await selecting;
  assert.equal(calls, 0); assert.equal(f.controller.store.getSnapshot().sessionIssue!.code, "model-choice-changed"); assert.deepEqual(f.selections, []);
  f.controller.dispose();
});

test("native model selection failure preserves the accepted profile and reports partial success without rollback", async () => {
  const f = fixture({ selectSession: async (id) => success(appliedWithModel(id)) });
  let calls = 0;
  f.controller.attachModelSelector({ selectModel: async () => { calls++; throw new Error("Do not expose private provider details"); } });
  await f.controller.refresh(); f.controller.setSession("model-failed"); await settle(f.controller);
  f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession({ useProfileModel: true });
  const state = f.controller.store.getSnapshot();
  assert.equal(calls, 1); assert.equal(state.session!.selection.selectedId, "p"); assert.equal(state.session!.admissionEpoch, "epoch-2");
  assert.equal(state.sessionNotice, null); assert.equal(state.sessionIssue!.source, "profile-model"); assert.equal(state.sessionIssue!.code, "model-selection-failed");
  assert.equal(state.sessionIssue!.message, undefined);
  assert.equal(state.snapshot!.selectedId, null);
  const component = await nativeHeaderComponent();
  assert.ok(menuFeedback(headerTree(component, f.controller)).length > 0);
  f.controller.dispose();
});

test("explicit missing profile model preserves current native model and reports the committed profile honestly", async () => {
  const f = fixture(); let calls = 0;
  f.controller.attachModelSelector({ selectModel: async (request) => { calls++; return success({ selected: request }); } });
  await f.controller.refresh(); f.controller.setSession("no-profile-main"); await settle(f.controller);
  f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession({ useProfileModel: true });
  assert.equal(calls, 0); assert.equal(f.controller.store.getSnapshot().session!.selection.selectedId, "p");
  assert.equal(f.controller.store.getSnapshot().sessionIssue!.code, "model-unconfigured");
  assert.equal(f.controller.store.getSnapshot().sessionNotice, null);
  f.controller.dispose();
});

test("selector withdrawal/replacement before profile acceptance forbids late native selection", async () => {
  const accepted = deferred<RemoteResult<SessionProfileSnapshot>>(); const f = fixture({ selectSession: async () => accepted.promise });
  let oldCalls = 0, newCalls = 0;
  f.controller.attachModelSelector({ selectModel: async (request) => { oldCalls++; return success({ selected: request }); } });
  await f.controller.refresh(); f.controller.setSession("selector-withdrawn"); await settle(f.controller);
  f.controller.actions.chooseSessionProfile("p"); const apply = f.controller.actions.applySession({ useProfileModel: true });
  f.controller.attachModelSelector(null);
  f.controller.attachModelSelector({ selectModel: async (request) => { newCalls++; return success({ selected: request }); } });
  accepted.resolve(success(appliedWithModel("selector-withdrawn"))); await apply;
  assert.equal(oldCalls, 0); assert.equal(newCalls, 0);
  assert.equal(f.controller.store.getSnapshot().session!.selection.selectedId, "p");
  assert.equal(f.controller.store.getSnapshot().sessionIssue!.code, "model-service-unavailable");
  f.controller.dispose();
});

test("stale current-session and disposal fences prevent post-CAS native model dispatch", async () => {
  for (const boundary of ["view", "dispose"] as const) {
    const accepted = deferred<RemoteResult<SessionProfileSnapshot>>(); const f = fixture({ selectSession: async () => accepted.promise }); let calls = 0;
    f.controller.attachModelSelector({ selectModel: async (request) => { calls++; return success({ selected: request }); } });
    await f.controller.refresh(); f.controller.setSession("old-native"); await settle(f.controller);
    f.controller.actions.chooseSessionProfile("p"); const apply = f.controller.actions.applySession({ useProfileModel: true });
    if (boundary === "view") { f.controller.setSession("new-native"); await settle(f.controller); }
    else f.controller.dispose();
    accepted.resolve(success(appliedWithModel("old-native"))); await apply;
    assert.equal(calls, 0);
    if (boundary === "view") assert.equal(f.controller.store.getSnapshot().session!.sessionId, "new-native");
    f.controller.dispose();
  }
});

test("later native Models-tab selection wins because explicit profile action never echoes or reselects a model", async () => {
  const calls: SessionSelectModelRequest[] = []; let nativeModel = "previous-native";
  const selector = { selectModel: async (request: SessionSelectModelRequest) => { calls.push(request); nativeModel = request.model; return success({ selected: request }); } };
  const f = fixture({ selectSession: async (id) => success(appliedWithModel(id)) }); f.controller.attachModelSelector(selector);
  await f.controller.refresh(); f.controller.setSession("manual-later"); await settle(f.controller);
  f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession({ useProfileModel: true });
  assert.equal(nativeModel, "profile-main");
  await selector.selectModel({ sessionId: "manual-later" as SessionSelectModelRequest["sessionId"], provider: "native-manual", model: "manual-tab-later" });
  await f.controller.actions.refreshSession(); await f.controller.actions.refreshCatalog();
  assert.equal(nativeModel, "manual-tab-later"); assert.equal(calls.length, 2);
  assert.equal("selectedModel" in f.controller.store.getSnapshot(), false, "native projections, not a local model echo, own the picker");
  f.controller.dispose();
});

test("manual Models-tab choice while profile CAS is pending wins over a delayed explicit profile-model action", async () => {
  const accepted = deferred<RemoteResult<SessionProfileSnapshot>>(); const f = fixture({ selectSession: async () => accepted.promise });
  let nativeModel = "old-native", calls = 0;
  f.controller.attachModelSelector({ selectModel: async (request) => { calls++; nativeModel = request.model; return success({ selected: request }); } });
  await f.controller.refresh(); f.controller.setSession("manual-during-cas"); await settle(f.controller);
  f.controller.actions.chooseSessionProfile("p"); const apply = f.controller.actions.applySession({ useProfileModel: true });
  nativeModel = "manual-tab-later";
  f.modelObservation.change({ lastUsed: null, next: { provider: "native-manual", model: nativeModel } });
  accepted.resolve(success(appliedWithModel("manual-during-cas"))); await apply;
  assert.equal(nativeModel, "manual-tab-later", "a delayed profile action must not overwrite the newer native choice");
  assert.equal(calls, 0);
  assert.equal(f.controller.store.getSnapshot().session!.selection.selectedId, "p");
  assert.equal(f.controller.store.getSnapshot().sessionIssue!.code, "model-choice-changed");
  f.controller.dispose();
});

test("projection invalidation and not-yet-notified frame unit seams fence optional model dispatch", async () => {
  for (const change of ["same-value-new-sequence", "pending-next-frame"] as const) {
    const accepted = deferred<RemoteResult<SessionProfileSnapshot>>(); const f = fixture({ selectSession: async () => accepted.promise }); let calls = 0;
    f.controller.attachModelSelector({ selectModel: async (request) => { calls++; return success({ selected: request }); } });
    await f.controller.refresh(); f.controller.setSession("projection-race"); await settle(f.controller);
    f.controller.actions.chooseSessionProfile("p"); const apply = f.controller.actions.applySession({ useProfileModel: true });
    if (change === "same-value-new-sequence") f.modelObservation.invalidate();
    else f.modelObservation.change({ lastUsed: { provider: "native", model: "current-native" }, next: { provider: "pending-native", model: "pending-model-choice" } }, false);
    accepted.resolve(success(appliedWithModel("projection-race"))); await apply;
    assert.equal(calls, 0); assert.equal(f.controller.store.getSnapshot().session!.selection.selectedId, "p");
    assert.equal(f.controller.store.getSnapshot().sessionIssue!.code, "model-choice-changed");
    f.controller.dispose();
  }
});

test("missing or withdrawn native model-selection observation refuses only the optional model stage", async () => {
  for (const timing of ["missing", "withdrawn"] as const) {
    const accepted = deferred<RemoteResult<SessionProfileSnapshot>>(); const f = fixture({ selectSession: async () => accepted.promise }); let calls = 0;
    f.controller.attachModelSelector({ selectModel: async (request) => { calls++; return success({ selected: request }); } });
    await f.controller.refresh(); f.controller.setSession("observation-boundary"); await settle(f.controller);
    if (timing === "missing") f.controller.attachModelSelectionSource(null, null);
    f.controller.actions.chooseSessionProfile("p"); const apply = f.controller.actions.applySession({ useProfileModel: true });
    if (timing === "withdrawn") f.controller.attachModelSelectionSource(null, null);
    accepted.resolve(success(appliedWithModel("observation-boundary"))); await apply;
    assert.equal(calls, 0); assert.equal(f.controller.store.getSnapshot().session!.selection.selectedId, "p");
    assert.equal(f.controller.store.getSnapshot().sessionIssue!.code, "model-observation-unavailable");
    assert.equal(f.controller.store.getSnapshot().sessionNotice, null);
    f.controller.dispose();
  }
});

test("changing current native view fences pending session responses and disposal fences retained actions", async () => {
  const old = deferred<RemoteResult<SessionProfileSnapshot>>();
  const f = fixture({ describeSession: async (id) => id === "native-old" ? old.promise : success(session(id)) });
  await f.controller.refresh(); f.controller.setSession("native-old"); f.controller.setSession("native-new"); await settle(f.controller);
  old.resolve(success(session("native-old", "stale-epoch"))); await setImmediate();
  assert.equal(f.controller.store.getSnapshot().session!.sessionId, "native-new");
  assert.equal(f.controller.store.getSnapshot().session!.admissionEpoch, "epoch-1");
  const accepted = f.controller.store.getSnapshot(); f.controller.dispose();
  f.controller.setSession("other"); f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.refreshSession(); await f.controller.actions.applySession();
  assert.equal(f.controller.store.getSnapshot(), accepted);
});

test("a switched view cannot receive the old session's delayed apply response", async () => {
  const applied = deferred<RemoteResult<SessionProfileSnapshot>>();
  const f = fixture({ selectSession: async () => applied.promise });
  await f.controller.refresh(); f.controller.setSession("old-root"); await settle(f.controller);
  f.controller.actions.chooseSessionProfile("p"); const pending = f.controller.actions.applySession();
  f.controller.setSession("new-root"); await settle(f.controller);
  applied.resolve(success({ ...session("old-root", "old-new-epoch"), scope: "session-override", selection: { selectedId: "p", appliedRevision: revision, selectionRevision: otherRevision } }));
  await pending;
  assert.equal(f.controller.store.getSnapshot().session!.sessionId, "new-root");
  assert.equal(f.controller.store.getSnapshot().sessionNotice, null);
  assert.equal(f.controller.store.getSnapshot().snapshot!.selectedId, null);
  f.controller.dispose();
});

test("native catalog withdrawal fences delayed catalog results without rewriting a manual draft", async () => {
  const catalog = deferred<RemoteResult<ModelCatalog>>();
  const f = fixture(); await f.controller.refresh(); await f.controller.open("p");
  f.controller.attachCatalog({ modelCatalog: async () => catalog.promise });
  f.controller.attachCatalog(null);
  catalog.resolve(success({ default: { provider: "unexpected", model: "unexpected" }, routableProviders: [], groups: [], failures: [] }));
  await setImmediate();
  const state = f.controller.store.getSnapshot();
  assert.equal(state.catalog, null); assert.equal(state.catalogUnavailable, true); assert.equal(state.catalogBusy, false);
  assert.equal(state.editor!.content, content); assert.equal(state.dirty, false);
  f.controller.dispose();
});

test("session conflicts, busy sessions, invalid form fields and dirty drafts refuse commit without losing state", async () => {
  const f = fixture({ selectSession: async () => ({ ok: false, error: new RemoteError("dsmm-profiles/refused", "refused", { code: "conflict", message: "Session epoch changed" }) }) });
  await f.controller.refresh(); await f.controller.open("p"); f.controller.setSession("native-root"); await settle(f.controller);
  f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
  assert.equal(f.controller.store.getSnapshot().sessionIssue!.code, "conflict");
  assert.equal(f.controller.store.getSnapshot().session!.selection.selectedId, null);
  f.controller.actions.setFieldInvalid("maxRetries", true); await f.controller.actions.save();
  assert.equal(f.calls.includes("save"), false);
  f.controller.actions.editPath(["label"], "Draft");
  const dirty = f.controller.store.getSnapshot().editor!.content;
  assert.equal(parse(dirty).label, "Draft");
  await f.controller.actions.applySession();
  assert.equal(f.controller.store.getSnapshot().editor!.content, dirty);
  f.controller.dispose();
});

test("saved profile state uses recorded source version and keeps missing source metadata explicitly unknown", async () => {
  const component = await nativeHeaderComponent("ProfilesSection");
  const observed = "stat-v1-123456789-123456790", changed = "stat-v1-123456791-123456792";
  let sourceRevision: string | undefined = observed;
  const f = fixture({ describe: async () => success({ ...snapshot, profiles: [{ id: "p", revision: observed }], selectedId: "p", appliedRevision: "snapshot-v1-00000000-0000-4000-8000-000000000001", selectionRevision: changed, ...(sourceRevision === undefined ? {} : { sourceRevision }) }),
    read: async id => success({ id, content, revision: observed }) });
  try {
    await f.controller.refresh(); await f.controller.open("p");
    const status = () => elements(headerTree(component, f.controller)).find(node => node.props["data-dsmm-editor-state"] !== undefined)!.props.children;
    assert.equal(status(), en.savedApplied);
    sourceRevision = changed; await f.controller.refresh(); assert.equal(status(), en.savedNotApplied);
    sourceRevision = undefined; await f.controller.refresh(); assert.equal(status(), en.savedRelationshipUnknown);
    assert.equal(f.calls.includes("select"), false); assert.equal(f.controller.store.getSnapshot().dirty, false);
  } finally { f.controller.dispose(); }
});

test("new-session page selects the retained native blank's profile and baseline with sidecar CAS, not future-default or model writes", async () => {
  const component = await nativeHeaderComponent(), scope = await nativeHeaderComponent("SessionScope");
  const future = { selectedId: "p", appliedRevision: revision, sourceRevision: revision, selectionRevision: revision };
  let accepted: SessionProfileSnapshot = { ...session("native-workspace-blank"), switchAllowed: false,
    admittedSelection: future, globalDefault: future };
  const selections: SessionProfileSelectRequest[] = [];
  const f = fixture({ describe: async () => success({ ...snapshot, ...future, profiles: [...snapshot.profiles, { id: "q", label: "Q", revision: otherRevision }] }),
    describeSession: async () => success(accepted), selectSession: async (id, request) => {
      selections.push(request);
      const selection = { selectedId: request.id, appliedRevision: request.expectedRevision ?? null, selectionRevision: otherRevision };
      accepted = { ...accepted, selection, admittedSelection: selection, admissionEpoch: `epoch-${selections.length + 1}`, scope: request.id === null ? "deployment-baseline" : "session-override" };
      return success(accepted);
    } });
  let models = 0;
  f.controller.attachModelSelector({ selectModel: async request => { models++; return success({ selected: request }); } });
  try {
    await f.controller.refresh();
    const sessionless = headerMenu(headerTree(component, f.controller));
    assert.equal(menuRowDisabled(headerTree(component, f.controller), "q"), true);
    sessionless.props.onSelect("q");
    assert.equal(selections.length, 0);
    // Native workspace navigation owns create/retain and the composer. DSMM
    // receives its real identity and never creates a substitute session.
    f.controller.setSession(accepted.sessionId); await settle(f.controller);
    assert.equal(headerMenu(headerTree(component, f.controller)).props.selectedId, "p");
    assert.equal(elements(headerTree(scope, f.controller)).find(node => node.type === "select")!.props.value, "p");
    sessionless.props.onSelect("q"); assert.equal(selections.length, 0, "retained sessionless callbacks cannot act on a new binding");
    const menu = headerMenu(headerTree(component, f.controller));
    menu.props.onClose(); assert.equal(selections.length, 0, "dismissing the menu does not apply a choice");
    menu.props.onSelect("q"); await settle(f.controller);
    assert.equal(selections[0]!.expectedSelectionRevision, "absent", "admitted future-default revision is not session sidecar CAS");
    assert.equal(headerMenu(headerTree(component, f.controller)).props.selectedId, "q");
    headerMenu(headerTree(component, f.controller)).props.onSelect(""); await settle(f.controller);
    assert.equal(selections[1]!.id, null); assert.equal(selections[1]!.expectedRevision, undefined);
    assert.equal(selections[1]!.expectedSelectionRevision, otherRevision);
    assert.equal(headerMenu(headerTree(component, f.controller)).props.selectedId, "");
    assert.equal(f.controller.store.getSnapshot().snapshot!.selectedId, "p");
    assert.equal(f.calls.includes("select"), false); assert.equal(models, 0);
  } finally { f.controller.dispose(); }
});

async function nativeComposerBlocks(): Promise<ComposerBlocks> {
  const source = await readFile(join(dirname(sourceRequire.resolve("@deepseek-ai/dsh-client-ui-conversation/package.json")), "lib", "client.js"), "utf8");
  const start = source.indexOf("//#region lib/types/client/input/blocks.js"), end = source.indexOf("//#endregion", start);
  assert.ok(start >= 0 && end > start);
  // Execute the shipped registry with its real native store. This is a
  // controller seam test, not a substitute for rendering the native composer.
  const realm = createContext({ _deepseek_ai_dsh_client_store: { createSnapshotStore } });
  return runInContext(`${source.slice(start, end)}\nnew ComposerBlockRegistry()`, realm) as ComposerBlocks;
}

test("native composer block is acquired before profile RPC and released only from its exact owned seat", async () => {
  for (const boundary of ["accepted", "navigation", "dispose", "withdrawal", "foreign", "forget"] as const) {
    const pending = deferred<RemoteResult<SessionProfileSnapshot>>(), blocks = await nativeComposerBlocks();
    const id = SessionId(`blank-block-${boundary}`);
    const f = fixture({ selectSession: async () => { assert.ok(blocks.storeFor(id).getSnapshot()); return pending.promise; } });
    try {
      await f.controller.refresh(); f.controller.setSession(id); await settle(f.controller);
      f.controller.attachComposerBlocks(blocks, () => en.sessionSelectionBlock);
      f.controller.actions.chooseSessionProfile("p"); const applying = f.controller.actions.applySession();
      const owned = blocks.storeFor(id).getSnapshot(); assert.ok(owned);
      const foreign = { reason: "Native model unavailable" };
      if (boundary === "navigation") f.controller.setSession("another-root");
      if (boundary === "dispose") f.controller.dispose();
      if (boundary === "withdrawal") f.controller.attachComposerBlocks(null);
      if (boundary === "foreign") blocks.set(id, foreign);
      if (boundary === "forget") { blocks.forget(id); blocks.set(id, foreign); }
      pending.resolve(success(appliedWithModel(id))); await applying;
      assert.equal(blocks.storeFor(id).getSnapshot(), boundary === "foreign" || boundary === "forget" ? foreign : undefined);
    } finally { f.controller.dispose(); }
  }
  const blocks = await nativeComposerBlocks(), id = SessionId("blank-existing-block"), foreign = { reason: en.sessionSelectionBlock };
  blocks.set(id, foreign);
  const f = fixture();
  try {
    await f.controller.refresh(); f.controller.setSession(id); await settle(f.controller);
    f.controller.attachComposerBlocks(blocks, () => en.sessionSelectionBlock);
    f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
    f.controller.dispose();
    assert.equal(blocks.storeFor(id).getSnapshot(), foreign, "even equal reason text cannot confer ownership of an existing native block");
  } finally { f.controller.dispose(); }
});

test("an unconfirmed profile result requires a successful reread, never automatic retry", async () => {
  const component = await nativeHeaderComponent();
  for (const refusal of ["transport", "cancelled"] as const) {
    const blocks = await nativeComposerBlocks(), id = SessionId(`blank-unconfirmed-${refusal}`);
    let writes = 0, unreadable = false;
    const f = fixture({ selectSession: async () => { writes++; return refusal === "transport"
      ? { ok: false, error: new RemoteError("gateway/cancelled", "lost reply", {}) }
      : { ok: false, error: new RemoteError("dsmm-profiles/refused", "cancelled", { code: "cancelled", message: "cancelled" }) }; },
      describeSession: async () => unreadable ? { ok: false, error: new RemoteError("gateway/cancelled", "read unavailable", {}) } : success(session(id)) });
    try {
      await f.controller.refresh(); f.controller.setSession(id); await settle(f.controller);
      f.controller.attachComposerBlocks(blocks, () => en.sessionSelectionBlock);
      f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession();
      assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, true);
      assert.equal(menuRowDisabled(headerTree(component, f.controller), "p"), true);
      assert.equal(menuFeedback(headerTree(component, f.controller)), en.sessionUnconfirmedRefresh);
      await f.controller.actions.applySession(); await f.controller.actions.resetSession(); assert.equal(writes, 1);
      unreadable = true; await f.controller.refreshSession();
      assert.ok(blocks.storeFor(id).getSnapshot()); assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, true);
      unreadable = false; await f.controller.refreshSession();
      assert.equal(blocks.storeFor(id).getSnapshot(), undefined); assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, false);
      assert.equal(writes, 1);
    } finally { f.controller.dispose(); }
  }
});

test("a native composer notification that changes the current view prevents dispatch of the old selection", async () => {
  const blocks = await nativeComposerBlocks(), id = SessionId("blank-reentrant-navigation"), f = fixture();
  try {
    await f.controller.refresh(); f.controller.setSession(id); await settle(f.controller);
    f.controller.attachComposerBlocks(blocks, () => en.sessionSelectionBlock);
    const stop = blocks.storeFor(id).subscribe(() => { if (blocks.storeFor(id).getSnapshot() !== undefined) f.controller.setSession(null); });
    f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession(); stop();
    assert.equal(f.selections.length, 0); assert.equal(f.controller.store.getSnapshot().currentSessionId, null);
    assert.equal(blocks.storeFor(id).getSnapshot(), undefined);
  } finally { f.controller.dispose(); }
});

test("committed refresh-required selection is visible as pending confirmation and cannot replay", async () => {
  const component = await nativeHeaderComponent(), blocks = await nativeComposerBlocks(), id = SessionId("blank-committed-refresh");
  let writes = 0, accepted = session(id);
  const f = fixture({ describeSession: async () => success(accepted), selectSession: async () => {
    writes++; accepted = { ...appliedWithModel(id), refreshRequired: true }; return success(accepted);
  } });
  try {
    await f.controller.refresh(); f.controller.setSession(id); await settle(f.controller);
    f.controller.attachComposerBlocks(blocks, () => en.sessionSelectionBlock);
    headerMenu(headerTree(component, f.controller)).props.onSelect("p"); await settle(f.controller);
    assert.equal(headerMenu(headerTree(component, f.controller)).props.selectedId, "p");
    assert.equal(menuFeedback(headerTree(component, f.controller)), en.sessionCommittedRefresh);
    assert.equal(f.controller.store.getSnapshot().sessionNotice, null); assert.ok(blocks.storeFor(id).getSnapshot());
    await f.controller.actions.applySession(); await f.controller.actions.resetSession(); assert.equal(writes, 1);
    accepted = appliedWithModel(id); await f.controller.refreshSession();
    assert.equal(blocks.storeFor(id).getSnapshot(), undefined); assert.equal(writes, 1);
  } finally { f.controller.dispose(); }
});

test("connection generations and leave-return navigation invalidate retained menus and late selection replies", async () => {
  const component = await nativeHeaderComponent(), pending = deferred<RemoteResult<SessionProfileSnapshot>>();
  const connection = createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: "isolated" } });
  let writes = 0;
  const f = fixture({ selectSession: async () => { writes++; return pending.promise; } });
  try {
    f.controller.bindConnection(connection); await f.controller.refresh();
    f.controller.setSession("same-native-id"); await settle(f.controller);
    const old = headerMenu(headerTree(component, f.controller));
    f.controller.setSession(null); f.controller.setSession("same-native-id"); await settle(f.controller);
    old.props.onSelect("p"); assert.equal(writes, 0);
    const retained = headerMenu(headerTree(component, f.controller)); retained.props.onSelect("p");
    await f.controller.open("p"); // A pending selection cannot replace the editor.
    connection.set(undefined);
    await f.controller.actions.applySession(); retained.props.onSelect("p"); assert.equal(writes, 1);
    pending.resolve(success(appliedWithModel("same-native-id"))); await setImmediate();
    assert.equal(f.controller.store.getSnapshot().session, null); assert.equal(f.controller.store.getSnapshot().sessionNotice, null);
    connection.set({ id: 2, host: { home: "isolated" } }); await settle(f.controller);
    retained.props.onSelect("p"); assert.equal(writes, 1);
    assert.equal(f.controller.store.getSnapshot().session!.admissionEpoch, "epoch-1");
    await f.controller.open("p"); f.controller.actions.editPath(["label"], "Keep disconnected settings draft");
    const draft = f.controller.store.getSnapshot().editor!.content;
    connection.set(undefined); connection.set({ id: 3, host: { home: "isolated" } }); await settle(f.controller);
    assert.equal(f.controller.store.getSnapshot().editor!.content, draft); assert.equal(f.controller.store.getSnapshot().dirty, true);
  } finally { f.controller.dispose(); }
});

test("returning to a blank with an in-flight selection waits for completion and rereads rather than replaying", async () => {
  const component = await nativeHeaderComponent(), pending = deferred<RemoteResult<SessionProfileSnapshot>>();
  const blocks = await nativeComposerBlocks(), id = SessionId("blank-return-pending");
  let accepted = session(id), writes = 0, reads = 0;
  const f = fixture({ describeSession: async () => { reads++; return success(accepted); }, selectSession: async () => { writes++; return pending.promise; } });
  try {
    await f.controller.refresh(); f.controller.setSession(id); await settle(f.controller);
    f.controller.attachComposerBlocks(blocks, () => en.sessionSelectionBlock);
    f.controller.actions.chooseSessionProfile("p"); const applying = f.controller.actions.applySession();
    f.controller.setSession(null); f.controller.setSession(id); await settle(f.controller);
    assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, true);
    assert.equal(menuRowDisabled(headerTree(component, f.controller), "p"), true);
    assert.ok(blocks.storeFor(id).getSnapshot());
    await f.controller.actions.applySession(); assert.equal(writes, 1);
    accepted = appliedWithModel(id); pending.resolve(success(accepted)); await applying; await settle(f.controller);
    assert.equal(reads, 3); assert.equal(writes, 1);
    assert.equal(headerMenu(headerTree(component, f.controller)).props.selectedId, "p");
    assert.equal(f.controller.store.getSnapshot().sessionUnconfirmed, false); assert.equal(blocks.storeFor(id).getSnapshot(), undefined);
  } finally { f.controller.dispose(); }
});

test("version presentation exposes metadata state while CAS keeps its actual observation token", () => {
  const observed = "stat-v1-123456789-123456790", pin = "snapshot-v1-00000000-0000-4000-8000-000000000001";
  assert.equal(configurationVersionState(observed), "versionObserved"); assert.equal(writableSelectionVersion(observed), true);
  assert.equal(configurationVersionState(revision), "versionObserved"); assert.equal(configurationVersionState("native-v1-17"), "versionObserved");
  assert.equal(configurationVersionState("absent"), "versionAbsent"); assert.equal(writableSelectionVersion("absent"), true);
  assert.equal(configurationVersionState(null), "versionUnknown"); assert.equal(configurationVersionState("unavailable"), "versionUnknown");
  assert.equal(configurationVersionState(pin), "versionUnknown"); assert.equal(writableSelectionVersion(pin), false); assert.equal(writableSelectionVersion("unavailable"), false);
});

test("committed session selection awaiting reread blocks profile and mode replay even with an observed stat version", async () => {
  const observed = "stat-v1-123456789-123456790", pin = "snapshot-v1-00000000-0000-4000-8000-000000000001";
  let refreshRequired = true, modeWrites = 0; const selections: SessionProfileSelectRequest[] = [];
  const frame = (id: string): SessionProfileSnapshot => ({ ...session(id, "c".repeat(64)),
    selection: { selectedId: "p", appliedRevision: pin, selectionRevision: observed, sourceRevision: observed, ...(refreshRequired ? { refreshRequired: true } : {}) },
    deepwork: { active: false, explicit: false, locked: false, revision } });
  const f = fixture({ describe: async () => success({ ...snapshot, profiles: [{ id: "p", revision: observed }] }),
    describeSession: async id => success(frame(id)), selectSession: async (id, request) => { selections.push(request); return success(frame(id)); },
    selectMode: async (id, request) => { modeWrites++; return success({ ...frame(id), deepwork: { active: request.active, explicit: true, locked: false, revision: otherRevision } }); } });
  try {
    await f.controller.refresh(); f.controller.setSession("pending-selection"); await settle(f.controller);
    f.controller.actions.chooseSessionProfile("p"); await f.controller.actions.applySession(); await f.controller.actions.setDeepwork(true);
    assert.equal(selections.length, 0); assert.equal(modeWrites, 0);
    const component = await nativeHeaderComponent(); const tree = headerTree(component, f.controller);
    assert.equal(menuRowDisabled(tree, "p"), true); assert.equal(menuRowDisabled(tree, "@mode"), true);
    refreshRequired = false; await f.controller.refreshSession();
    refreshRequired = true; await f.controller.actions.applySession({ useProfileModel: true });
    assert.equal(selections.length, 1); assert.equal(f.controller.store.getSnapshot().sessionIssue, null); assert.equal(f.controller.store.getSnapshot().session?.selection.refreshRequired, true);
    await f.controller.actions.setDeepwork(true); assert.equal(modeWrites, 0);
    refreshRequired = false; await f.controller.refreshSession();
    await f.controller.actions.applySession(); await f.controller.actions.setDeepwork(true);
    assert.equal(selections.length, 2); assert.equal(selections[0]!.expectedRevision, observed); assert.equal(selections[0]!.expectedSelectionRevision, observed); assert.equal(modeWrites, 1);
  } finally { f.controller.dispose(); }
});

test("committed profile save with unavailable version requires explicit reread and cannot replay Save or Apply", async () => {
  let stored = content, storedRevision = revision, writes = 0;
  const f = fixture({ read: async id => success({ id, content: stored, revision: storedRevision }), save: async request => {
    writes++; stored = request.content; storedRevision = otherRevision;
    return success({ id: request.id, content: stored, revision: "unavailable", refreshRequired: true });
  } });
  try {
    await f.controller.refresh(); await f.controller.open("p"); f.controller.actions.editPath(["label"], "Committed source"); await f.controller.save();
    const accepted = f.controller.store.getSnapshot(); assert.equal(accepted.notice?.key, "saved"); assert.equal(accepted.dirty, false); assert.equal(accepted.editor?.refreshRequired, true);
    f.controller.actions.editPath(["label"], "Do not replay"); await f.controller.save(); await f.controller.apply();
    assert.equal(writes, 1); assert.equal(f.calls.includes("select"), false); assert.equal(f.controller.store.getSnapshot().editor?.content, stored);
    await f.controller.reload(); assert.equal(f.controller.store.getSnapshot().editor?.refreshRequired, undefined);
    await f.controller.apply(); assert.equal(f.calls.includes("select"), true); assert.equal(writes, 1);
  } finally { f.controller.dispose(); }
});
