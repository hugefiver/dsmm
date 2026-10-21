import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { build } from "esbuild";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import type { DsmmProfilesRemote } from "../src/profile-remote.js";
import type { ProfileReadResult, ProfileSnapshot, SessionProfileSnapshot } from "../src/profile-types.js";
import { isValidElement } from "react";
import type { ReactElement } from "react";
import { findNodeAtLocation, parseTree } from "jsonc-parser";

// Exercise authored controller/business code without rebuilding shared lib.
async function clientModule<T>(entry: string, overrides: Record<string, unknown> = {}): Promise<T> {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../src/client/${entry}`, import.meta.url))], bundle: true,
    platform: "node", format: "cjs", packages: "external", write: false, logLevel: "silent" });
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", result.outputFiles[0].text)((name: string) => Object.hasOwn(overrides, name) ? overrides[name] : require(name), module, module.exports);
  return module.exports as T;
}
const { ProfilesController } = await clientModule<typeof import("../src/client/controller.js")>("controller.ts");
const { structuredDocument, editStructuredPath } = await clientModule<typeof import("../src/client/structured.js")>("structured.ts");
const { draftWarnings, safeIssue } = await clientModule<typeof import("../src/client/diagnostics.js")>("diagnostics.tsx");
const revision = "a".repeat(64), nextRevision = "b".repeat(64);
const raw = '{\n  // keep this comment\n  "version": 1, "id": "p", "label": "   ",\n  "settings": {"workflow": {"reviewCap": 2}, "locale": "zh-Hans"}\n}\n';
const warning = draftWarnings(raw)[0];
const selection = { selectedId: null, appliedRevision: null, selectionRevision: "absent" };
const snapshot: ProfileSnapshot = { ...selection, profiles: [{ id: "p", revision, warnings: [warning] }] };
const saved: ProfileReadResult = { id: "p", content: raw, revision, warnings: [warning] };
function session(id: string): SessionProfileSnapshot {
  return { sessionId: id, selection, globalDefault: selection, admittedSelection: { selectedId: "p", appliedRevision: revision, selectionRevision: revision },
    admissionEpoch: "original-epoch", scope: "global-default", switchAllowed: true,
    canSelectModel: false, selectModelUnavailableReason: "model-unconfigured",
    canToggleMode: false, toggleModeUnavailableReason: "runtime-unavailable",
    canApplyOverlay: false, applyOverlayUnavailableReason: "new-session-required", warnings: [warning] };
}
function fixture(overrides: Partial<DsmmProfilesRemote> = {}) {
  const calls: string[] = [];
  const controller = new ProfilesController({
    describe: async () => ({ ok: true, value: snapshot }), read: async () => ({ ok: true, value: saved }),
    save: async request => { calls.push("save"); return { ok: true, value: { ...saved, content: request.content, revision: nextRevision } }; },
    select: async request => { calls.push("future"); return { ok: true, value: { ...snapshot, selectedId: request.id, appliedRevision: request.expectedRevision ?? null, selectionRevision: nextRevision, selectedWarnings: [warning] } }; },
    describeSession: async id => ({ ok: true, value: session(id) }), selectSession: async () => { calls.push("session"); return { ok: true, value: session("root") }; },
    ...overrides,
  });
  return { controller, calls };
}

test("warnings follow accepted saved/future pins while current admission and draft bytes remain independent", async () => {
  const f = fixture();
  try {
    await f.controller.refresh(); await f.controller.open("p");
    f.controller.setSession("root"); await setImmediate();
    f.controller.actions.editContent(raw + "// draft tail\n");
    await f.controller.actions.save();
    const savedState = f.controller.store.getSnapshot();
    assert.deepEqual(savedState.editor?.warnings, [warning]);
    assert.deepEqual(savedState.snapshot?.profiles[0].warnings, [warning]);
    assert.equal(savedState.snapshot?.selectedId, null);
    assert.equal(savedState.editor?.content, raw + "// draft tail\n");
    await f.controller.actions.apply();
    const state = f.controller.store.getSnapshot();
    assert.equal(state.snapshot?.appliedRevision, nextRevision);
    assert.deepEqual(state.snapshot?.selectedWarnings, [warning]);
    assert.equal(state.session?.admittedSelection?.appliedRevision, revision);
    assert.equal(state.session?.admissionEpoch, "original-epoch");
    assert.deepEqual(state.session?.warnings, [warning]);
    assert.deepEqual(f.calls, ["save", "future"]);
    await f.controller.reload(); assert.deepEqual(f.controller.store.getSnapshot().editor?.warnings, [warning]);
  } finally { f.controller.dispose(); }
});

test("blank label remains a nonblocking draft warning; malformed labels are never downgraded", () => {
  assert.equal(warning.code, "blank-label"); assert.equal(warning.severity, "warning"); assert.equal(warning.field, "label");
  assert.ok(warning.location); assert.equal(raw.slice(warning.location.offset, warning.location.offset + warning.location.length), '"label"');
  for (const label of [undefined, "A", 0, "\u0000", " ".repeat(121), "\ud800"]) {
    const text = JSON.stringify({ version: 1, id: "p", label, settings: {} });
    assert.deepEqual(draftWarnings(text), []);
  }
});

test("levels, locale, named roles and topology share sparse JSONC edits with original comments retained", () => {
  let draft = editStructuredPath(raw, ["settings", "roleRouting", "dsmm-planner", "levels", "high"], { reasoningEffort: "exact" })!;
  draft = editStructuredPath(draft, ["settings", "roles", "dsmm-reviewer"], false)!;
  draft = editStructuredPath(draft, ["settings", "subagents", "toolTopology"], "parameterized")!;
  draft = editStructuredPath(draft, ["settings", "roleRouting", "dsmm-planner", "levels", "max"], { provider: "manual", model: "unlisted", reasoningEffort: "custom" })!;
  const projected = structuredDocument(draft)!;
  assert.deepEqual(projected.roleRouting["dsmm-planner"].levels, { high: { reasoningEffort: "exact" }, max: { provider: "manual", model: "unlisted", reasoningEffort: "custom" } });
  assert.deepEqual(projected.settings.roles, { "dsmm-reviewer": false });
  assert.deepEqual(projected.settings.subagents, { toolTopology: "parameterized" });
  assert.equal(projected.settings.locale, "zh-Hans");
  assert.ok(draft.includes("// keep this comment")); assert.ok(draft.includes('"workflow": {"reviewCap": 2}'));
  const inherit = editStructuredPath(draft, ["settings", "locale"], undefined)!;
  assert.equal(structuredDocument(inherit)?.settings.locale, undefined);
  for (const invalid of [{ "dsmm-orchestrator": { levels: { high: { reasoningEffort: "high" } } } }, { "dsmm-planner": { levels: { normal: { reasoningEffort: "high" } } } }, { "dsmm-planner": { levels: { high: { provider: "partial" } } } }]) {
    const text = JSON.stringify({ version: 1, id: "p", settings: { roleRouting: invalid } });
    assert.equal(editStructuredPath(text, ["label"], "rewrite"), null);
  }
  assert.equal(structuredDocument('{"version":1,"id":"p","settings":{"subagents":{"allowRouteOverride":true}}}'), null);
});

test("validation submission retains precise UTF-16 location and draft; refresh never requests focus", async () => {
  const location = { offset: 44, length: 7, line: 3, column: 25 };
  const f = fixture({ save: async () => ({ ok: false, error: new RemoteError("dsmm-profiles/refused", "PRIVATE_EXCEPTION", {
    code: "validation", message: "PRIVATE_VALUE", reason: "unknown-field", field: "settings.[unknown]", location,
  }) }) });
  try {
    await f.controller.refresh(); await f.controller.open("p"); f.controller.actions.editContent(raw + "// kept\n");
    await f.controller.actions.save();
    const state = f.controller.store.getSnapshot();
    assert.equal(state.validationEpoch, 1); assert.equal(state.issue?.field, "settings.[unknown]");
    assert.deepEqual(state.issue?.location, location); assert.equal(state.issue?.reason, "unknown-field");
    assert.equal(state.editor?.content, raw + "// kept\n"); assert.equal(state.dirty, true);
    assert.equal(state.issue?.message, undefined); assert.doesNotMatch(JSON.stringify(state.issue), /PRIVATE_|secretCredential/u);
    await f.controller.refresh(); assert.equal(f.controller.store.getSnapshot().validationEpoch, 1);
  } finally { f.controller.dispose(); }
});

test("safe diagnostic presentation rejects unknown codes/locations and never exposes private exception text", () => {
  for (const info of [{ code: "unexpected", message: "PRIVATE" }, { code: "validation", message: "PRIVATE", field: "settings.secretCredential" }, { code: "validation", message: "PRIVATE", location: { offset: -1, length: 1, line: 1, column: 1 } }]) {
    assert.deepEqual(safeIssue(info), { kind: "assembly", code: "unavailable" });
  }
  const issue = safeIssue({ code: "activation", message: "PRIVATE", field: "settings.roleRouting.dsmm-planner.levels.high.reasoningEffort" });
  assert.equal(issue.field, "settings.roleRouting.dsmm-planner.levels.high.reasoningEffort"); assert.equal(issue.message, undefined);
});

test("nonstring topology values cannot throw or normalize the raw draft", () => {
  const values = [["per-role"], { toString: 0 }, [], null, 0, true];
  const outcomes = values.map(toolTopology => {
    const content = JSON.stringify({ version: 1, id: "p", settings: { subagents: { toolTopology } } });
    try {
      const projected = structuredDocument(content);
      const edited = editStructuredPath(content, ["label"], "replacement");
      return { projected, edited, content };
    } catch { return { threw: true, content }; }
  });
  assert.deepEqual(outcomes, values.map(toolTopology => ({ projected: null, edited: null,
    content: JSON.stringify({ version: 1, id: "p", settings: { subagents: { toolTopology } } }) })));
});

test("unambiguous blank label warning remains alongside a blocking route error at its exact raw location", async () => {
  const content = raw.replace("// keep this comment", "// keep 😀 this comment").replace('"locale": "zh-Hans"', '"roleRouting": {"dsmm-planner": {"primary": {"provider": "partial"}}}');
  const tree = parseTree(content)!;
  const property = findNodeAtLocation(tree, ["label"])!.parent!.children![0];
  const warning = draftWarnings(content);
  assert.equal(structuredDocument(content), null);
  assert.equal(warning.length, 1); assert.equal(warning[0].code, "blank-label");
  assert.equal(warning[0].location?.offset, property.offset); assert.equal(warning[0].location?.length, property.length);
  assert.equal(content.slice(property.offset, property.offset + property.length), '"label"');
  const f = fixture({ read: async () => ({ ok: true, value: { ...saved, content } }), save: async () => ({ ok: false,
    error: new RemoteError("dsmm-profiles/refused", "refused", { code: "validation", message: "", reason: "invalid-route", field: "settings.roleRouting.dsmm-planner.primary" }) }) });
  try {
    await f.controller.refresh(); await f.controller.open("p"); f.controller.actions.editContent(content + "// retained\n");
    await f.controller.actions.save();
    const state = f.controller.store.getSnapshot();
    assert.equal(state.issue?.reason, "invalid-route"); assert.equal(state.issue?.code, "validation");
    assert.equal(draftWarnings(state.editor!.content)[0]?.code, "blank-label");
    assert.equal(state.editor?.content, content + "// retained\n"); assert.equal(state.dirty, true);
  } finally { f.controller.dispose(); }
  for (const ambiguous of [content.slice(0, -3), content.replace('"label": "   "', '"label": "   ", "label": "other"'), content.replace('"provider": "partial"', '"provider": "partial", "provider": "other"')]) {
    assert.deepEqual(draftWarnings(ambiguous), []);
  }
});

function treeElements(tree: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(treeElements);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...treeElements(tree.props.children)];
}

async function validationEffectHarness() {
  const effects: (() => unknown)[] = [];
  const require = createRequire(import.meta.url);
  function NativeInput() { throw new Error("Ref/effect test does not replace a native browser rendering test"); }
  const { ProfilesSection } = await clientModule<typeof import("../src/client/ProfilesSection.js")>("ProfilesSection.tsx", {
    react: { ...require("react"), useId: () => "validation-focus", useRef: (current: unknown) => ({ current }), useEffect: (effect: () => unknown) => effects.push(effect) },
    "@deepseek-ai/dsh-client-ui-primitives": { Input: NativeInput, Button: () => null },
  });
  return (controller: InstanceType<typeof ProfilesController>) => {
    effects.length = 0;
    const nodes = treeElements(ProfilesSection({ ...controller.actions, useProfiles: select => select(controller.store.getSnapshot()), t: key => key }));
    const focus = { id: 0, editor: 0, active: "save" };
    const rawInput = { value: controller.store.getSnapshot().editor!.content, invalid: false, selectionStart: 0, selectionEnd: 0,
      focus() { focus.editor++; focus.active = "jsonc"; }, setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; } };
    const requestId = { disabled: false, readOnly: false, invalid: false, focus() { focus.id++; if (!this.disabled && !this.readOnly) focus.active = "id"; } };
    const advanced = { open: false };
    for (const node of nodes) {
      const ref = (node as unknown as { ref?: { current: unknown } }).ref;
      if (ref === undefined) continue;
      if (node.type === NativeInput) { requestId.disabled = node.props.disabled === true; requestId.readOnly = node.props.readOnly === true; requestId.invalid = node.props["aria-invalid"] === true; ref.current = requestId; }
      if (node.type === "textarea") { rawInput.invalid = node.props["aria-invalid"] === true; ref.current = rawInput; }
      if (node.type === "details" && node.props.className === "dsmm-advanced") ref.current = advanced;
    }
    return { focus, rawInput, requestId, advanced, runEffects() { for (const effect of effects) effect(); } };
  };
}

test("production validation effect focuses the located raw ID rather than the disabled saved request ID", async () => {
  const content = raw.replace("// keep this comment", "// keep 😀 this comment").replace('"id": "p"', '"id": "different"');
  const location = { offset: content.indexOf('"id"'), length: 4, line: 3, column: 17 };
  const f = fixture({ read: async () => ({ ok: true, value: { ...saved, content } }), save: async () => ({ ok: false,
    error: new RemoteError("dsmm-profiles/refused", "refused", { code: "validation", message: "", reason: "invalid-type", field: "id", location }) }) });
  const render = await validationEffectHarness();
  try {
    await f.controller.refresh(); await f.controller.open("p"); f.controller.actions.editContent(content + "// retained\n"); await f.controller.actions.save();
    const frame = render(f.controller); assert.equal(frame.requestId.disabled, true); frame.runEffects();
    assert.equal(frame.rawInput.invalid, true); assert.equal(frame.requestId.invalid, false);
    assert.equal(frame.focus.id, 0); assert.equal(frame.focus.editor, 1); assert.equal(frame.focus.active, "jsonc"); assert.equal(frame.advanced.open, true);
    assert.equal(frame.rawInput.selectionStart, location.offset); assert.equal(frame.rawInput.selectionEnd, location.offset + location.length);
    assert.equal(frame.rawInput.value.slice(frame.rawInput.selectionStart, frame.rawInput.selectionEnd), '"id"');
    frame.runEffects(); assert.equal(frame.focus.editor, 1, "the handled validation epoch cannot repeatedly steal focus");
    assert.equal(f.controller.store.getSnapshot().editor?.content, content + "// retained\n");
  } finally { f.controller.dispose(); }
});

test("production no-location ID effect targets only an editable request ID and leaves refresh focus alone", async () => {
  const render = await validationEffectHarness();
  const f = fixture();
  try {
    await f.controller.refresh(); await f.controller.actions.create(); f.controller.actions.editId("INVALID"); await f.controller.actions.save();
    assert.equal(f.controller.store.getSnapshot().issue?.location, undefined);
    const editable = render(f.controller); assert.equal(editable.requestId.disabled, false); editable.runEffects();
    assert.equal(editable.requestId.invalid, true); assert.equal(editable.rawInput.invalid, false);
    assert.deepEqual(editable.focus, { id: 1, editor: 0, active: "id" }); assert.equal(editable.advanced.open, false);
    await f.controller.refresh();
    const refreshed = render(f.controller); refreshed.runEffects(); assert.deepEqual(refreshed.focus, { id: 0, editor: 0, active: "save" });
  } finally { f.controller.dispose(); }
  const savedId = fixture({ save: async () => ({ ok: false, error: new RemoteError("dsmm-profiles/refused", "refused", { code: "validation", message: "", field: "id" }) }) });
  try {
    await savedId.controller.refresh(); await savedId.controller.open("p"); savedId.controller.actions.editContent(raw + "// retained\n"); await savedId.controller.actions.save();
    const disabled = render(savedId.controller); assert.equal(disabled.requestId.disabled, true); disabled.runEffects();
    assert.deepEqual(disabled.focus, { id: 0, editor: 1, active: "jsonc" }); assert.equal(disabled.advanced.open, true);
  } finally { savedId.controller.dispose(); }
});
