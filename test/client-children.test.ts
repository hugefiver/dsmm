import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { build } from "esbuild";
import { isValidElement } from "react";
import type { ReactElement } from "react";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { DsmmChildrenRemote } from "../src/role-control-remote.js";
import type { ChildSessionSnapshot, RoleControlChildView, SubagentPromptReceipt, SubagentPromptRequest } from "../src/role-control-types.js";
import type { ChildrenSnapshot } from "../src/client/children-controller.js";
import type { DsmmInvocationView, DsmmRoleRouteComparison } from "../src/profile-types.js";

async function clientModule<T>(entry: string, overrides: Record<string, unknown> = {}): Promise<T> {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../src/client/${entry}`, import.meta.url))], bundle: true,
    platform: "node", format: "cjs", packages: "external", write: false, logLevel: "silent" });
  const module = { exports: {} }, require = createRequire(import.meta.url);
  new Function("require", "module", "exports", result.outputFiles[0].text)((name: string) => Object.hasOwn(overrides, name) ? overrides[name] : require(name), module, module.exports);
  return module.exports as T;
}
const { ChildrenController, childActionKey } = await clientModule<typeof import("../src/client/children-controller.js")>("children-controller.ts");
const epoch = "a".repeat(64), otherEpoch = "b".repeat(64);
const yes = { enabled: true } as const;
const invocation = { role: "dsmm-planner", label: "Planner", level: "high", routeSource: "level", route: { provider: "configured", model: "exact", reasoningEffort: "custom" }, mode: "one-shot", runId: "run", childId: "one-shot" } as const;
function child(id = "child", parentSessionId = "parent"): RoleControlChildView {
  return { id, parentSessionId, mode: "continuable", activity: "running", label: "Continuable", readonly: false, controls: { prompt: yes, interrupt: yes } };
}
function snapshot(id = "parent"): ChildSessionSnapshot {
  return { sessionId: id, admissionEpoch: epoch, children: [child("child", id)],
    capabilities: { prompt: yes, interrupt: yes, images: yes, runtime: { binding: "stock", deliveryFenceReady: true, restartRequired: false } } };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(overrides: Partial<DsmmChildrenRemote> = {}, value = snapshot()) {
  const calls: { prompts: SubagentPromptRequest[]; interrupts: unknown[]; reads: string[] } = { prompts: [], interrupts: [], reads: [] };
  const remote: DsmmChildrenRemote = {
    describe: async id => { calls.reads.push(id); return { ok: true, value: { ...value, sessionId: id, children: value.children.map(child => ({ ...child, parentSessionId: id })) } }; },
    descendants: async id => ({ ok: true, value: { sessionId: id, admissionEpoch: value.admissionEpoch, descendants: [] } }),
    prompt: async (_id, request) => { calls.prompts.push(request); return { ok: true, value: { messageId: "message" as SubagentPromptReceipt["messageId"] } }; },
    interrupt: async (id, request) => { calls.interrupts.push({ id, request }); return { ok: true, value: { accepted: true } }; }, ...overrides,
  };
  const controller = new ChildrenController(remote), owner = {}, connection = {};
  return { controller, calls, owner, connection, value, async start() { controller.bindConnection(connection, "generation"); controller.bindScope(value.sessionId, owner); await setImmediate(); assert.equal(controller.store.getSnapshot().fresh, true); } };
}

test("native scope is required before observing child conversations", async () => {
  const f = fixture();
  try {
    f.controller.bindScope("parent", null); await f.controller.actions.refresh(f.controller.store.getSnapshot().generation);
    assert.deepEqual(f.calls.reads, []); assert.equal(f.controller.store.getSnapshot().snapshot, null);
    await f.start();
    assert.equal(f.controller.store.getSnapshot().snapshot?.children[0].id, "child");
  } finally { f.controller.dispose(); }
});

test("Queue/Steer use real text/image bodies and native receipt semantics without Agent attribution", async () => {
  const f = fixture();
  try {
    await f.start(); const generation = f.controller.store.getSnapshot().generation;
    const bytes = new Uint8Array([137, 80, 78, 71]);
    f.controller.actions.editText(generation, "child", "  literal\nmessage  ");
    await f.controller.actions.addImages(generation, "child", [new File([bytes], "chosen.png", { type: "image/png" })]);
    f.controller.actions.setDelivery(generation, "child", "steer");
    await f.controller.actions.prompt(generation, "child");
    const request = f.calls.prompts[0];
    assert.equal(request.parentSessionId, "parent"); assert.equal(request.childSessionId, "child"); assert.equal(request.mode, "continuable"); assert.equal(request.delivery, "steer"); assert.ok(request.requestId);
    assert.deepEqual(request.content, [{ type: "text", text: "  literal\nmessage  " }, { type: "image", mediaType: "image/png", data: Buffer.from(bytes).toString("base64"), name: "chosen.png" }]);
    assert.ok(request.clientTimeZone); assert.equal(Object.hasOwn(request, "senderAgent"), false);
    const state = f.controller.store.getSnapshot();
    assert.equal(state.snapshot?.children[0].activity, "running"); assert.equal(state.drafts.get("child")?.text, "");
    assert.deepEqual(state.outcomes.get(childActionKey("child")), { kind: "prompt", receipt: { messageId: "message" } });
    f.controller.actions.editText(generation, "child", "queued"); f.controller.actions.setDelivery(generation, "child", "queue");
    await f.controller.actions.prompt(generation, "child"); assert.equal(f.calls.prompts[1].delivery, "queue"); assert.notEqual(f.calls.prompts[1].requestId, request.requestId);
    await f.controller.actions.interrupt(generation, "child"); assert.deepEqual(f.calls.interrupts, [{ id: "parent", request: { parentSessionId: "parent", childSessionId: "child", mode: "continuable" } }]);
    assert.equal(f.controller.store.getSnapshot().snapshot?.children[0].activity, "running");
    assert.deepEqual(f.controller.store.getSnapshot().outcomes.get(childActionKey("child")), { kind: "interrupt", receipt: { accepted: true } });
  } finally { f.controller.dispose(); }
});

test("one-shot, read-only, foreign and capability-denied targets cannot send or interrupt", async () => {
  const value = snapshot();
  value.children.push({ ...child("one-shot"), mode: "one-shot", readonly: true, controls: { prompt: { enabled: false, reason: "one-shot" }, interrupt: { enabled: false, reason: "one-shot" } } });
  value.children.push({ ...child("read-only"), readonly: true, controls: { prompt: { enabled: false, reason: "read-only" }, interrupt: { enabled: false, reason: "read-only" } } });
  value.capabilities.images = { enabled: false, reason: "unavailable" };
  const f = fixture({}, value);
  try {
    await f.start(); const generation = f.controller.store.getSnapshot().generation;
    for (const id of ["one-shot", "read-only", "foreign"]) { f.controller.actions.editText(generation, id, "do not send"); await f.controller.actions.prompt(generation, id); await f.controller.actions.interrupt(generation, id); }
    await f.controller.actions.addImages(generation, "child", [new File(["body"], "chosen.png", { type: "image/png" })]);
    assert.equal(f.controller.store.getSnapshot().drafts.get("child"), undefined); assert.deepEqual(f.calls.prompts, []); assert.deepEqual(f.calls.interrupts, []);
    value.capabilities.prompt = { enabled: false, reason: "unavailable" };
    await f.controller.actions.refresh(generation); const next = f.controller.store.getSnapshot().generation;
    f.controller.actions.editText(next, "child", "retained"); await f.controller.actions.prompt(next, "child"); assert.deepEqual(f.calls.prompts, []); assert.equal(f.controller.store.getSnapshot().drafts.get("child")?.text, "retained");
  } finally { f.controller.dispose(); }
});

test("transport loss preserves the exact draft, strips unsafe exceptions, and never retries an unknown send", async () => {
  let sends = 0;
  const f = fixture({ prompt: async () => { sends++; throw { kind: "domain", code: "secretCredential", reason: "PRIVATE_RAW_EXCEPTION" }; } });
  try {
    await f.start(); const generation = f.controller.store.getSnapshot().generation;
    f.controller.actions.editText(generation, "child", " original ");
    await f.controller.actions.prompt(generation, "child"); await f.controller.actions.prompt(generation, "child");
    assert.equal(sends, 1); assert.equal(f.controller.store.getSnapshot().drafts.get("child")?.text, " original "); assert.equal(f.controller.store.getSnapshot().drafts.get("child")?.uncertain, true);
    assert.deepEqual(f.controller.store.getSnapshot().issues.get(childActionKey("child")), { kind: "transport", code: "unavailable", unknown: true });
    await f.controller.actions.refresh(generation); const next = f.controller.store.getSnapshot().generation;
    await f.controller.actions.prompt(next, "child"); assert.equal(sends, 1);
    f.controller.actions.acknowledgeUnknown(next, "child"); await f.controller.actions.prompt(next, "child"); assert.equal(sends, 2);
  } finally { f.controller.dispose(); }
});

test("known Host refusal and invalid image input retain corrective drafts without claiming a send", async () => {
  const f = fixture({ prompt: async () => ({ ok: false, error: new RemoteError("dsmm-children/refused", "PRIVATE", { code: "disabled", reason: "evidence-unavailable", field: "childSessionId" }) }) });
  try {
    await f.start(); const generation = f.controller.store.getSnapshot().generation;
    f.controller.actions.editText(generation, "child", "draft");
    await f.controller.actions.addImages(generation, "child", [new File(["body"], "bad.svg", { type: "image/svg+xml" })]);
    assert.deepEqual(f.controller.store.getSnapshot().issues.get(childActionKey("child")), { kind: "local", code: "invalid-content" });
    assert.equal(f.controller.store.getSnapshot().drafts.get("child")?.text, "draft"); assert.equal(f.controller.store.getSnapshot().drafts.get("child")?.imageBusy, false);
    await f.controller.actions.prompt(generation, "child");
    assert.deepEqual(f.controller.store.getSnapshot().issues.get(childActionKey("child")), { kind: "domain", code: "disabled", reason: "evidence-unavailable", field: "childSessionId" });
    assert.equal(f.controller.store.getSnapshot().drafts.get("child")?.uncertain, false);
  } finally { f.controller.dispose(); }
});

test("picked image removal retains exact body identity even through retained row callbacks", async () => {
  const f = fixture();
  try {
    await f.start(); const generation = f.controller.store.getSnapshot().generation;
    await f.controller.actions.addImages(generation, "child", [new File(["first"], "same.png", { type: "image/png" }), new File(["second"], "same.png", { type: "image/png" })]);
    const [first, second] = f.controller.store.getSnapshot().drafts.get("child")!.images;
    f.controller.actions.removeImage(generation, "child", first); f.controller.actions.removeImage(generation, "child", first);
    assert.deepEqual(f.controller.store.getSnapshot().drafts.get("child")?.images, [second]);
    await f.controller.actions.prompt(generation, "child"); assert.deepEqual(f.calls.prompts[0].content, [second]);
  } finally { f.controller.dispose(); }
});

test("session, owner, connection, admission replacement and disposal fence late receipts and retained callbacks", async () => {
  for (const replacement of ["session", "owner", "connection", "admission", "dispose"] as const) {
    const response = deferred<RemoteResult<SubagentPromptReceipt>>(), calls: SubagentPromptRequest[] = [];
    const f = fixture({ prompt: async (_id, request) => { calls.push(request); return response.promise; } });
    try {
      await f.start(); const generation = f.controller.store.getSnapshot().generation;
      f.controller.actions.editText(generation, "child", "do not lose or leak this draft");
      const request = f.controller.actions.prompt(generation, "child");
      if (replacement === "session") f.controller.bindScope("other", {});
      if (replacement === "owner") f.controller.bindScope("parent", {});
      if (replacement === "connection") { f.controller.bindConnection(null); f.controller.bindConnection({}, "new-generation"); }
      if (replacement === "admission") { f.value.admissionEpoch = otherEpoch; f.controller.observeAdmission("parent", otherEpoch); }
      if (replacement === "dispose") f.controller.dispose();
      await setImmediate();
      response.resolve({ ok: true, value: { messageId: "late-message" as SubagentPromptReceipt["messageId"] } }); await request;
      await f.controller.actions.prompt(generation, "child"); await f.controller.actions.interrupt(generation, "child");
      const state = f.controller.store.getSnapshot(); assert.equal(calls.length, 1); assert.equal(state.outcomes.size, 0); assert.equal(state.pending.size, 0);
      if (replacement === "connection" || replacement === "admission") { assert.equal(state.drafts.get("child")?.text, "do not lose or leak this draft"); assert.equal(state.drafts.get("child")?.uncertain, true); }
      else assert.equal(state.drafts.size, 0);
      if (replacement === "session") assert.equal(state.snapshot?.sessionId, "other");
    } finally { f.controller.dispose(); }
  }
});

test("late reads cannot replace a new native owner; descendant diagnostics and mixed epochs are not false successes", async () => {
  const old = deferred<RemoteResult<ChildSessionSnapshot>>(); let reads = 0;
  const f = fixture({ describe: async id => ++reads === 1 ? old.promise : { ok: true, value: snapshot(id) },
    descendants: async id => ({ ok: true, value: { sessionId: id, admissionEpoch: epoch, descendants: [{ kind: "diagnostic", id: "broken", parentSessionId: id, depth: 1, reason: "corrupt" }] } }) });
  try {
    f.controller.bindConnection(f.connection, "generation"); f.controller.bindScope("parent", f.owner); f.controller.bindScope("other", {}); await setImmediate();
    old.resolve({ ok: true, value: snapshot() }); await setImmediate();
    assert.equal(f.controller.store.getSnapshot().snapshot?.sessionId, "other"); assert.equal(f.controller.store.getSnapshot().descendants?.descendants[0].kind, "diagnostic");
  } finally { f.controller.dispose(); }
  const mismatch = fixture({ descendants: async id => ({ ok: true, value: { sessionId: id, admissionEpoch: otherEpoch, descendants: [] } }) });
  try { await mismatch.start(); assert.equal(mismatch.controller.store.getSnapshot().descendants, null); assert.equal(mismatch.controller.store.getSnapshot().descendantIssue?.code, "conflict"); assert.equal(mismatch.controller.store.getSnapshot().fresh, true); }
  finally { mismatch.controller.dispose(); }
});

test("malformed observations fail closed", async () => {
  const bad = fixture({ describe: async () => ({ ok: true, value: { ...snapshot(), unsafeExtra: "PRIVATE" } as ChildSessionSnapshot }) });
  try {
    bad.controller.bindConnection(bad.connection, "generation"); bad.controller.bindScope("parent", bad.owner); await setImmediate();
    assert.equal(bad.controller.store.getSnapshot().fresh, false); assert.equal(bad.controller.store.getSnapshot().snapshot, null); assert.equal(bad.controller.store.getSnapshot().issue?.kind, "protocol");
    await bad.controller.actions.interrupt(bad.controller.store.getSnapshot().generation, "child"); assert.deepEqual(bad.calls.interrupts, []);
  } finally { bad.controller.dispose(); }
});

test("observed admission replacement fences an initial read and rejects conflicting epoch results before any action", async () => {
  const initial = deferred<RemoteResult<ChildSessionSnapshot>>(), conflicting = deferred<RemoteResult<ChildSessionSnapshot>>();
  const admitted = snapshot(); admitted.admissionEpoch = otherEpoch;
  let reads = 0;
  const f = fixture({ describe: async () => ++reads === 1 ? initial.promise : reads === 2 ? conflicting.promise : { ok: true, value: admitted },
    descendants: async id => ({ ok: true, value: { sessionId: id, admissionEpoch: reads === 1 ? epoch : otherEpoch, descendants: [] } }) });
  try {
    f.controller.bindConnection(f.connection, "generation"); f.controller.bindScope("parent", f.owner);
    const oldGeneration = f.controller.store.getSnapshot().generation;
    f.controller.observeAdmission("parent", otherEpoch);
    initial.resolve({ ok: true, value: snapshot() }); await setImmediate();
    assert.equal(f.controller.store.getSnapshot().fresh, false);
    assert.equal(f.controller.store.getSnapshot().snapshot, null);
    assert.ok(f.controller.store.getSnapshot().generation > oldGeneration);
    conflicting.resolve({ ok: true, value: snapshot() }); await setImmediate();
    const current = f.controller.store.getSnapshot();
    f.controller.actions.editText(current.generation, "child", "must not send under stale admission");
    for (const generation of [oldGeneration, current.generation]) {
      await f.controller.actions.prompt(generation, "child"); await f.controller.actions.interrupt(generation, "child");
    }
    assert.equal(current.fresh, false); assert.equal(current.issue?.code, "conflict"); assert.equal(current.snapshot, null);
    assert.deepEqual(f.calls.prompts, []); assert.deepEqual(f.calls.interrupts, []);
    const readsBeforeRepeat = reads; f.controller.observeAdmission("parent", otherEpoch); await setImmediate();
    assert.equal(reads, readsBeforeRepeat); assert.equal(f.controller.store.getSnapshot().fresh, false);
    await f.controller.actions.refresh(f.controller.store.getSnapshot().generation);
    const restored = f.controller.store.getSnapshot();
    assert.equal(restored.fresh, true); assert.equal(restored.snapshot?.admissionEpoch, otherEpoch);
    await f.controller.actions.interrupt(restored.generation, "child");
    assert.equal(f.calls.interrupts.length, 1);
  } finally { f.controller.dispose(); }
});

test("image intake and interrupt can complete in either order without dropping bytes or stranding busy state", async () => {
  for (const order of ["image-first", "interrupt-first"] as const) {
    const bytes = new Uint8Array([0, 137, 80, 78, 71, 255]), reading = deferred<ArrayBuffer>(), acknowledgement = deferred<RemoteResult<{ accepted: true }>>();
    let interrupts = 0;
    const f = fixture({ interrupt: async () => { interrupts++; return acknowledgement.promise; } });
    try {
      await f.start(); const generation = f.controller.store.getSnapshot().generation;
      f.controller.actions.editText(generation, "child", " preserve text ");
      await f.controller.actions.addImages(generation, "child", [new File(["existing"], "existing.png", { type: "image/png" })]);
      const existing = f.controller.store.getSnapshot().drafts.get("child")!.images[0];
      const file = new File([bytes], "picked.png", { type: "image/png" }); file.arrayBuffer = () => reading.promise;
      const intake = f.controller.actions.addImages(generation, "child", [file]);
      const interrupt = f.controller.actions.interrupt(generation, "child");
      assert.equal(interrupts, 1); assert.equal(f.controller.store.getSnapshot().pending.get(childActionKey("child")), "interrupt");
      if (order === "interrupt-first") { acknowledgement.resolve({ ok: true, value: { accepted: true } }); await interrupt; }
      reading.resolve(bytes.buffer); await intake;
      const expected = { type: "image", mediaType: "image/png", data: Buffer.from(bytes).toString("base64"), name: "picked.png" };
      assert.equal(f.controller.store.getSnapshot().drafts.get("child")?.imageBusy, false);
      assert.deepEqual(f.controller.store.getSnapshot().drafts.get("child")?.images, [existing, expected]);
      if (order === "image-first") {
        assert.equal(f.controller.store.getSnapshot().pending.get(childActionKey("child")), "interrupt");
        acknowledgement.resolve({ ok: true, value: { accepted: true } }); await interrupt;
      }
      const draft = f.controller.store.getSnapshot().drafts.get("child")!;
      assert.equal(draft.text, " preserve text "); assert.equal(draft.imageBusy, false); assert.equal(draft.uncertain, false);
      assert.equal(f.controller.store.getSnapshot().pending.size, 0);
      await f.controller.actions.prompt(generation, "child");
      assert.deepEqual(f.calls.prompts[0].content, [{ type: "text", text: " preserve text " }, existing, expected]);
    } finally { f.controller.dispose(); }
  }
});

test("image intake faults during interrupt clear busy state and retain unrelated corrective drafts", async () => {
  const reading = deferred<ArrayBuffer>(), acknowledgement = deferred<RemoteResult<{ accepted: true }>>();
  const f = fixture({ interrupt: async () => acknowledgement.promise });
  try {
    await f.start(); const generation = f.controller.store.getSnapshot().generation;
    f.controller.actions.editText(generation, "child", "retained");
    await f.controller.actions.addImages(generation, "child", [new File(["existing"], "existing.png", { type: "image/png" })]);
    const existing = f.controller.store.getSnapshot().drafts.get("child")!.images[0];
    const file = new File(["unreadable"], "picked.png", { type: "image/png" }); file.arrayBuffer = () => reading.promise;
    const intake = f.controller.actions.addImages(generation, "child", [file]), interrupt = f.controller.actions.interrupt(generation, "child");
    reading.reject(new Error("PRIVATE_FILE_ERROR")); await intake;
    assert.equal(f.controller.store.getSnapshot().drafts.get("child")?.imageBusy, false);
    assert.deepEqual(f.controller.store.getSnapshot().drafts.get("child")?.images, [existing]);
    assert.deepEqual(f.controller.store.getSnapshot().issues.get(childActionKey("child")), { kind: "local", code: "invalid-content" });
    acknowledgement.resolve({ ok: true, value: { accepted: true } }); await interrupt;
    assert.equal(f.controller.store.getSnapshot().drafts.get("child")?.text, "retained");
    await f.controller.actions.prompt(generation, "child"); assert.deepEqual(f.calls.prompts[0].content, [{ type: "text", text: "retained" }, existing]);
  } finally { f.controller.dispose(); }
});

test("late image intake and interrupt receipts cannot revive busy state or images after a lifetime fence", async () => {
  for (const replacement of ["session", "owner", "connection", "admission", "dispose"] as const) {
    const reading = deferred<ArrayBuffer>(), acknowledgement = deferred<RemoteResult<{ accepted: true }>>();
    const f = fixture({ interrupt: async () => acknowledgement.promise });
    try {
      await f.start(); const generation = f.controller.store.getSnapshot().generation;
      f.controller.actions.editText(generation, "child", "retained within the same owner");
      const file = new File(["late"], "late.png", { type: "image/png" }); file.arrayBuffer = () => reading.promise;
      const intake = f.controller.actions.addImages(generation, "child", [file]), interrupt = f.controller.actions.interrupt(generation, "child");
      if (replacement === "session") f.controller.bindScope("other", {});
      if (replacement === "owner") f.controller.bindScope("parent", {});
      if (replacement === "connection") { f.controller.bindConnection(null); f.controller.bindConnection({}, "new-generation"); }
      if (replacement === "admission") { f.value.admissionEpoch = otherEpoch; f.controller.observeAdmission("parent", otherEpoch); }
      if (replacement === "dispose") f.controller.dispose();
      await setImmediate();
      reading.resolve(new Uint8Array([1, 2, 3]).buffer); await intake;
      acknowledgement.resolve({ ok: true, value: { accepted: true } }); await interrupt;
      const state = f.controller.store.getSnapshot();
      assert.equal(state.pending.size, 0); assert.equal(state.outcomes.size, 0);
      for (const draft of state.drafts.values()) { assert.equal(draft.imageBusy, false); assert.deepEqual(draft.images, []); }
      if (replacement === "connection" || replacement === "admission") assert.equal(state.drafts.get("child")?.text, "retained within the same owner");
      else assert.equal(state.drafts.size, 0);
    } finally { f.controller.dispose(); }
  }
});

function treeElements(tree: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(treeElements);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...treeElements(tree.props.children)];
}
test("production forms preserve accessible native semantics, real delivery callbacks and inspection-only descendants", async () => {
  const require = createRequire(import.meta.url);
  const components = await clientModule<typeof import("../src/client/ChildrenPanel.js")>("ChildrenPanel.tsx", {
    react: { ...require("react"), useId: () => "child-form", useRef: (value: unknown) => ({ current: value }) },
    "@deepseek-ai/dsh-client-ui-primitives": { Button: () => null },
  });
  const f = fixture();
  try {
    await f.start(); const state = f.controller.store.getSnapshot(), target = state.snapshot!.children[0], t = (key: string) => key;
    const form = treeElements(components.ChildComposer({ child: target, state, actions: f.controller.actions, t }));
    const text = form.find(node => node.type === "textarea")!, select = form.find(node => node.type === "select")!;
    assert.equal(typeof text.props.id, "string"); assert.ok(form.some(node => node.type === "label" && node.props.htmlFor === text.props.id));
    const hint = form.find(node => node.type === "p" && node.props.children === "deliveryHint")!;
    assert.equal(text.props["aria-describedby"], hint.props.id); assert.equal(select.props["aria-describedby"], hint.props.id);
    (text.props.onChange as (event: unknown) => void)({ currentTarget: { value: "from the real form" } });
    (select.props.onChange as (event: unknown) => void)({ currentTarget: { value: "steer" } });
    const ready = treeElements(components.ChildComposer({ child: target, state: f.controller.store.getSnapshot(), actions: f.controller.actions, t }));
    let prevented = false; (ready.find(node => node.type === "form")!.props.onSubmit as (event: unknown) => void)({ preventDefault() { prevented = true; } }); await setImmediate();
    assert.equal(prevented, true); assert.equal(f.calls.prompts[0].delivery, "steer"); assert.equal(f.calls.prompts[0].content[0].type, "text");
    const inspection = treeElements(components.ChildDetails({ child: target, state, actions: f.controller.actions, t, inspection: true }));
    assert.equal(inspection.some(node => node.type === components.ChildComposer), false);
    assert.equal(inspection.some(node => node.type === components.ControlAvailability), false);
    const deniedTarget = { ...target, readonly: true, controls: { prompt: { enabled: false, reason: "not-direct-child" }, interrupt: { enabled: false, reason: "not-direct-child" } } } as const;
    const deniedInspection = treeElements(components.ChildDetails({ child: deniedTarget, state, actions: f.controller.actions, t, inspection: true }));
    assert.ok(deniedInspection.some(node => node.type === components.ControlAvailability && node.props.value === deniedTarget.controls.prompt));
    const oneShot = treeElements(components.ChildDetails({ child: { ...target, mode: "one-shot", readonly: true }, state, actions: f.controller.actions, t }));
    assert.equal(oneShot.some(node => node.type === components.ChildComposer), false);
    const foreign = components.ChildrenPanel({ ...f.controller.actions, sessionId: "foreign", useChildren: selector => selector(state), t });
    assert.equal(treeElements(foreign).some(node => node.type === components.ChildDetails), false);
    const readonlyState: ChildrenSnapshot = { ...state, descendants: { sessionId: "parent", admissionEpoch: epoch, descendants: [{ kind: "diagnostic", id: "broken", parentSessionId: "parent", depth: 1, reason: "corrupt" }] } };
    const panel = treeElements(components.ChildrenPanel({ ...f.controller.actions, sessionId: "parent", useChildren: selector => selector(readonlyState), t }));
    assert.ok(panel.some(node => node.type === "p" && node.props.children === "diagnostic"));
  } finally { f.controller.dispose(); }
});

function renderedText(value: unknown): string {
  if (Array.isArray(value)) return value.map(renderedText).join("");
  if (isValidElement<Record<string, unknown>>(value)) return renderedText(value.props.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function metadataFields(tree: unknown): Map<string, string> {
  const fields = new Map<string, string>(); let label = "";
  for (const node of treeElements(tree)) {
    if (node.type === "dt") label = renderedText(node.props.children);
    else if (node.type === "dd") fields.set(label, renderedText(node.props.children));
  }
  return fields;
}
const routeComponents = await clientModule<typeof import("../src/client/ChildrenPanel.js")>("ChildrenPanel.tsx", { "@deepseek-ai/dsh-client-ui-primitives": { Button: () => null } });
const { childrenLocaleEn, childrenLocaleZh } = await clientModule<typeof import("../src/client/children-locales.js")>("children-locales.ts");
const comparedRoutes: DsmmRoleRouteComparison = {
  childId: "child", initialRoute: { status: "known", source: "invocation-capture", route: { provider: "captured", model: "initial-only", reasoningEffort: "high" } },
  liveRoute: { status: "known", source: "own-native-request-header", route: { provider: "native-own", model: "observed-only", reasoningEffort: "off" } },
};

test("production child route fields keep captured high separate from own native request off", async () => {
  const value = snapshot();
  value.children[0].routeComparison = comparedRoutes;
  value.children[0].invocation = { ...invocation, childId: "child", mode: "continuable", routeComparison: comparedRoutes };
  const f = fixture({}, value);
  try {
    await f.start(); const state = f.controller.store.getSnapshot();
    for (const locale of [childrenLocaleEn, childrenLocaleZh]) {
      const translations: Readonly<Record<string, string>> = locale;
      const t = (key: string) => translations[key] ?? key;
      const invocation = routeComponents.InvocationDetails({ value: state.snapshot!.children[0].invocation, t });
      const runComparison = treeElements(invocation).find(node => node.type === routeComponents.RouteComparisonDetails)!;
      const row = routeComponents.ChildDetails({ child: state.snapshot!.children[0], state, actions: f.controller.actions, t, inspection: true });
      const childComparison = treeElements(row).find(node => node.type === routeComponents.RouteComparisonDetails)!;
      for (const node of [runComparison, childComparison]) {
        const fields = metadataFields(routeComponents.RouteComparisonDetails({ value: node.props.value as DsmmRoleRouteComparison, t }));
        assert.equal(fields.get(locale.initialRoute), "captured/initial-only (high)");
        assert.equal(fields.get(locale.liveRoute), "native-own/observed-only (off)");
        assert.ok(fields.get(locale.initialRouteSource)?.includes("invocation-capture"));
        assert.ok(fields.get(locale.liveRouteSource)?.includes("own-native-request-header"));
      }
      const compatibility = metadataFields(invocation);
      assert.equal(compatibility.get(locale.reportedRoute), "configured/exact (custom)");
      assert.equal(compatibility.get(locale.routeSource), "level");
      const nestedInvocation = treeElements(row).find(node => node.type === routeComponents.InvocationDetails)!;
      assert.equal(treeElements(routeComponents.InvocationDetails({ value: nestedInvocation.props.value as DsmmInvocationView, showComparison: nestedInvocation.props.showComparison as boolean, t }))
        .some(node => node.type === routeComponents.RouteComparisonDetails), false);
    }
  } finally { f.controller.dispose(); }
});

test("production route rows expose pre-request and unobserved reasons without promoting initial or compatibility routes", () => {
  for (const reason of ["no-own-request-header", "invalid-own-request-header", "not-observed"] as const) {
    for (const locale of [childrenLocaleEn, childrenLocaleZh]) {
      const translations: Readonly<Record<string, string>> = locale;
      const t = (key: string) => translations[key] ?? key;
      const comparison: DsmmRoleRouteComparison = { ...comparedRoutes, liveRoute: { status: "unknown", reason } };
      const fields = metadataFields(routeComponents.RouteComparisonDetails({ value: comparison, t }));
      assert.equal(fields.get(locale.initialRoute), "captured/initial-only (high)");
      assert.equal(fields.get(locale.liveRoute), locale.routeUnknown);
      assert.ok(fields.get(locale.liveRouteReason)?.includes(reason));
      assert.equal(fields.has(locale.liveRouteSource), false);
    }
  }
  for (const locale of [childrenLocaleEn, childrenLocaleZh]) {
    const translations: Readonly<Record<string, string>> = locale;
    const t = (key: string) => translations[key] ?? key;
    const invocationDetails = routeComponents.InvocationDetails({ value: invocation, t });
    const comparison = treeElements(invocationDetails).find(node => node.type === routeComponents.RouteComparisonDetails)!;
    assert.equal(comparison.props.value, undefined);
    const rendered = routeComponents.RouteComparisonDetails({ t }), fields = metadataFields(rendered);
    assert.equal(fields.get(locale.initialRoute), locale.routeUnknown); assert.equal(fields.get(locale.liveRoute), locale.routeUnknown);
    assert.equal(fields.has(locale.initialRouteSource), false); assert.equal(fields.has(locale.liveRouteSource), false);
    assert.ok(renderedText(rendered).includes(locale.comparisonUnobserved));
    assert.equal(metadataFields(invocationDetails).get(locale.reportedRoute), "configured/exact (custom)");
  }
});

test("uncaptured child comparison shows its own native route without inventing invocation level or initial capture", async () => {
  const value = snapshot();
  value.children[0] = { ...child(), routeComparison: { ...comparedRoutes, initialRoute: { status: "unknown", reason: "missing-invocation-capture" } } };
  const f = fixture({}, value);
  try {
    await f.start(); const state = f.controller.store.getSnapshot(), observed = state.snapshot!.children[0];
    assert.equal(observed.invocation, undefined);
    for (const locale of [childrenLocaleEn, childrenLocaleZh]) {
      const translations: Readonly<Record<string, string>> = locale;
      const t = (key: string) => translations[key] ?? key;
      const row = routeComponents.ChildDetails({ child: observed, state, actions: f.controller.actions, t, inspection: true });
      const comparison = treeElements(row).find(node => node.type === routeComponents.RouteComparisonDetails)!;
      const fields = metadataFields(routeComponents.RouteComparisonDetails({ value: comparison.props.value as DsmmRoleRouteComparison, t }));
      assert.equal(fields.get(locale.initialRoute), locale.routeUnknown);
      assert.ok(fields.get(locale.initialRouteReason)?.includes("missing-invocation-capture"));
      assert.equal(fields.has(locale.initialRouteSource), false);
      assert.equal(fields.get(locale.liveRoute), "native-own/observed-only (off)");
      assert.ok(fields.get(locale.liveRouteSource)?.includes("own-native-request-header"));
      const invocationNode = treeElements(row).find(node => node.type === routeComponents.InvocationDetails)!;
      assert.equal(invocationNode.props.value, undefined);
      const invocationFields = metadataFields(routeComponents.InvocationDetails({ t }));
      assert.equal(invocationFields.has(locale.level), false); assert.equal(invocationFields.has(locale.role), false); assert.equal(invocationFields.has(locale.reportedRoute), false);
    }
  } finally { f.controller.dispose(); }
});
