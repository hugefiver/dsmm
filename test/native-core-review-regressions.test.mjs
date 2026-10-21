import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeRootLlmFixture, loadNative } from "./native-root-llm-fixture.mjs";
import { classifyDsmmAgent } from "../src/runtime-integration.ts";

const unavailable = process.platform !== "win32" || !process.env.DSMM_TEST_DSH_ENTRY;

test("native Allow completes the original owned delegation across a valid same-owner admission publication", {
  skip: unavailable || (process.env.DSMM_TEST_DEFERRED_APPROVAL !== "1"
    && "Deferred P1: admission publication during native approval can veto a one-shot delegation; enable DSMM_TEST_DEFERRED_APPROVAL=1 to reproduce"),
  timeout: 45000,
}, async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: true }, { approvalPolicy: "ask" });
  const { ToolCallId } = await loadNative("@deepseek-ai/dsh-llm");
  const { symbols } = await loadNative("@deepseek-ai/cordis");
  const root = await f.create(); root.session.append("turn/start", { turn: 1 });
  const runtime = f.ctx.get("dsmmProfileRuntime"), integration = f.ctx.get("dsmmRuntimeIntegration");
  const owner = integration.owner, coreOwner = f.ctx.get("dsmmCoreLlmOwner");
  const tools = root.ctx.tools, realm = Reflect.get(tools, symbols.original) ?? tools;
  const definition = tools.get("dsmm_reviewer", root), execute = definition.execute;
  const provider = f.ctx.subagents.getProvider("dsmm-role-reviewer");
  const before = runtime.admission(root);
  const saved = await runtime.save({ id: "pending-native-approval", expectedRevision: null, content: JSON.stringify({
    version: 1, id: "pending-native-approval", settings: { workflow: { reviewCap: 2 } },
  }) });
  let approvals = 0, published;
  f.ctx.on("tools/pre-execute", async (exec, next) => {
    const decision = await next();
    return exec.agent === root && exec.name === definition.name && decision.kind === "allow"
      ? { kind: "ask", reason: "Approve this exact owned delegation" } : decision;
  }, { prepend: true, global: true });
  f.ctx.on("approval/request", async () => {
    approvals++;
    const snapshot = await runtime.getSession(root);
    const selected = await runtime.selectSession({ sessionId: root.id, id: saved.id, expectedRevision: saved.revision,
      expectedSelectionRevision: snapshot.selection.selectionRevision, expectedAdmissionEpoch: snapshot.admissionEpoch }, root);
    published = runtime.admission(root);
    assert.notEqual(published, before); assert.notEqual(published.epoch, before.epoch);
    assert.equal(selected.admissionEpoch, published.epoch);
    assert.equal(selected.selection.selectedId, saved.id);
    assert.equal(f.ctx.agents.get(root.id), root);
    assert.equal(f.ctx.get("dsmmRuntimeIntegration").owner, owner);
    assert.equal(f.ctx.get("dsmmCoreLlmOwner"), coreOwner);
    assert.equal(Reflect.get(root.ctx.tools, symbols.original) ?? root.ctx.tools, realm);
    assert.equal(root.ctx.tools.get(definition.name, root), definition); assert.equal(definition.execute, execute);
    assert.equal(f.ctx.subagents.getProvider("dsmm-role-reviewer"), provider);
    assert.equal(f.bodies.length, 0);
    root.session.append("deepwork/mode", { active: false });
    return "allowed-once";
  }, { global: true });
  const prompt = "Complete the single native-approved review after profile publication";
  const invoke = id => tools.execute({ agent: root, name: definition.name, arguments: { description: "Admission publication review", prompt },
    callId: ToolCallId(id), signal: new AbortController().signal });
  const first = await invoke("approval-across-admission-epoch");
  assert.equal(approvals, 1); assert.ok(published); assert.notEqual(published.epoch, before.epoch);
  t.diagnostic(JSON.stringify({ approvals, admissionChanged: published.epoch !== before.epoch, httpDispatches: f.bodies.length, result: first }));
  assert.notEqual(first.isError, true, JSON.stringify(first));
  assert.equal(first.value.kind, "foreground");
  assert.ok(first.value.output.some(block => block.type === "text" && block.text === "native root completed"));
  assert.equal(f.bodies.length, 1); assert.equal(f.bodies[0].body.model, "root-model");
  assert.ok(f.bodies[0].body.messages.some(message => JSON.stringify(message.content).includes(prompt)));
  assert.equal((await invoke("unapproved-next-delegation")).isError, true);
  assert.equal(approvals, 1); assert.equal(f.bodies.length, 1); assert.deepEqual(f.errors, []);
});

async function foreignContinuableFixture(t, name) {
  const f = await nativeRootLlmFixture(t, { defaultActive: false, roles: { "dsmm-coding": false } }, { approvalPolicy: "ask" });
  const { setSandboxMode } = await loadNative("@deepseek-ai/dsh-sandbox-policy");
  const integration = f.ctx.get("dsmmRuntimeIntegration"), runtime = f.ctx.get("dsmmProfileRuntime");
  assert.ok(integration); assert.equal(integration.runtime.authority.view().deliveryFenceReady, true);
  const root = await f.create(); root.session.append("turn/start", { turn: 1 });
  setSandboxMode(root.session, "danger-full-access");
  assert.equal(runtime.getSettings(root).modules.deepwork.enabled, true);
  assert.equal((await runtime.getSession(root)).deepwork.active, false);
  assert.equal(classifyDsmmAgent(root), "native");
  assert.ok(f.ctx.subagents.getProvider("dsmm-role-reviewer"));
  await assert.rejects(f.ctx.subagents.startActivation({ provider: "dsmm-role-reviewer", label: "Owned inactive role stays denied", delivery: "parent",
    request: { parent: root, prompt: [] }, signal: new AbortController().signal }), { code: "UNAUTHORIZED" });
  assert.equal(f.bodies.length, 0);
  assert.equal(f.ctx.subagents.getProvider(name), undefined);
  if (name === "dsmm-role-coding") await assert.rejects(f.ctx.subagents.startActivation({ provider: name, label: "Missing native provider", delivery: "parent",
    request: { parent: root, prompt: [] }, signal: new AbortController().signal }), { code: "NO_PROVIDER" });
  const spawn = f.ctx.subagents.getProvider("spawn");
  assert.equal(typeof spawn.prepareContinuable, "function");
  let preparations = 0;
  const foreign = { name, capabilities: spawn.capabilities, inheritsParentContext: false,
    prepareContinuable(request) { preparations++; return spawn.prepareContinuable(request); } };
  const unregister = f.ctx.subagents.registerProvider(foreign); t.after(unregister);
  assert.equal(f.ctx.subagents.getProvider(name), foreign);
  return { f, root, integration, runtime, foreign, preparations: () => preparations };
}

async function startAndDeliverForeignChild(t, name) {
  const { f, root, integration, runtime, foreign, preparations } = await foreignContinuableFixture(t, name);
  const prompt = "Return a native response from the live foreign continuable provider";
  let started;
  try {
    started = await f.ctx.subagents.startActivation({ provider: name, label: "Foreign native continuation", delivery: "parent",
      request: { parent: root, prompt: [{ type: "text", text: prompt }], agentOptions: { provider: "local", model: "root-model" } },
      signal: new AbortController().signal });
  } finally { t.diagnostic(JSON.stringify({ provider: name, preparations: preparations(), httpDispatches: f.bodies.length })); }
  let evidence;
  try {
    const child = f.ctx.agents.get(started.childId);
    assert.ok(child); await child.whenIdle();
    assert.equal(preparations(), 1); assert.equal(f.ctx.subagents.getProvider(name), foreign);
    assert.equal(child.session.header.parentSession, root.id); assert.equal(child.session.header.origin, "subagent");
    assert.equal(f.ctx.agents.isOwnedBy(child.id, root), true);
    assert.equal(classifyDsmmAgent(child), "native"); assert.equal(runtime.hasAdmission(child), false);
    const { foldSubagentDescriptor } = await loadNative("@deepseek-ai/dsh-subagent");
    const descriptor = foldSubagentDescriptor(child.session.snapshotEvents());
    assert.equal(descriptor.provider, name); assert.equal(descriptor.mode, "continuable");
    assert.deepEqual(f.errors, []); assert.equal(f.bodies.length, 1); assert.equal(f.bodies[0].body.model, "root-model");
    assert.ok(f.bodies[0].body.messages.some(message => JSON.stringify(message.content).includes(prompt)));
    assert.ok(child.session.snapshotEvents().some(event => JSON.stringify(event.data).includes("native root completed")));
    const observation = await f.ctx.sessionQuery.observeSession(child.id, { signal: new AbortController().signal, projectionMode: "none" });
    try {
      assert.equal(observation.header.version, 4); assert.equal(observation.header.id, child.id);
      assert.equal(observation.header.parentSession, root.id); assert.equal(observation.header.origin, "subagent");
      assert.ok(Number.isSafeInteger(observation.inheritedEventCount));
      assert.ok(observation.inheritedEventCount >= 0 && observation.inheritedEventCount <= observation.events.length);
      const own = observation.events.slice(observation.inheritedEventCount);
      assert.equal(own.filter(event => event.type === "subagent/descriptor").length, 1);
      assert.equal(foldSubagentDescriptor(own).provider, name);
      assert.equal(own.some(event => event.type === "dsmm/role-policy"
        || event.type === "deepwork/mode" && event.data.active === true
        || event.type === "agent-preset/selected" && event.data.agentPreset?.startsWith("dsmm-")), false);
    } finally { observation[Symbol.dispose](); }
    t.diagnostic(JSON.stringify({ provider: name, preparations: preparations(), httpDispatches: f.bodies.length,
      classification: classifyDsmmAgent(child), hasDsmmAdmission: runtime.hasAdmission(child), directParent: child.session.header.parentSession === root.id }));
    const authority = integration.runtime.authority, ticket = authority.acquireParentTicket(root);
    evidence = await authority.resolveChildEvidence(ticket, child.id, new AbortController().signal);
    authority.assertDelivery(ticket, child.id, evidence);
    const followup = "Deliver the second native turn through the real parent-child boundary";
    await f.ctx.subagents.sendMessage(root, child.id, [{ type: "text", text: followup }], { signal: new AbortController().signal });
    await child.whenIdle();
    assert.deepEqual(f.errors, []); assert.equal(f.bodies.length, 2);
    assert.ok(f.bodies[1].body.messages.some(message => JSON.stringify(message.content).includes(followup)));
    assert.equal(classifyDsmmAgent(child), "native"); assert.equal(runtime.hasAdmission(child), false);
    if (name === "dsmm-role-foreign-native") {
      child.session.append("deepwork/mode", { active: true });
      assert.throws(() => authority.assertDelivery(ticket, child.id, evidence), { code: "UNAUTHORIZED" });
      await assert.rejects(authority.resolveChildEvidence(ticket, child.id, new AbortController().signal));
      assert.equal(f.bodies.length, 2);
    }
  } finally { await f.ctx.subagents.drainChildren(root, [started.childId]); }
  await root.whenIdle();
  const postDrainDispatches = f.bodies.length;
  const authority = integration.runtime.authority, ticket = authority.acquireParentTicket(root);
  assert.equal(f.ctx.agents.get(started.childId), undefined);
  assert.throws(() => authority.assertDelivery(ticket, started.childId, evidence), { code: "UNAUTHORIZED" });
  if (name === "dsmm-role-coding") {
    assert.equal(f.ctx.subagents.getProvider(name), foreign);
    await assert.rejects(authority.resolveChildEvidence(ticket, started.childId, new AbortController().signal), { code: "UNSUPPORTED_CAPABILITY" });
    assert.equal(f.bodies.length, postDrainDispatches);
    await t.test("native delivery evidence refuses a real same-ID replacement from another registry", async replacementTest => {
      const second = await nativeRootLlmFixture(replacementTest, { defaultActive: false }, { approvalPolicy: "ask" });
      const replacement = await second.ctx.agents.create({ sessionId: started.childId, meta: { cwd: second.workspace },
        agentOptions: { provider: "local", model: "root-model" } });
      replacementTest.after(() => replacement.dispose());
      const detach = f.ctx.agents.enter(replacement.agent, root);
      try {
        assert.equal(f.ctx.agents.get(started.childId), replacement.agent);
        assert.equal(f.ctx.agents.isOwnedBy(started.childId, root), true);
        assert.throws(() => authority.assertDelivery(ticket, started.childId, evidence), { code: "UNAUTHORIZED" });
        await assert.rejects(authority.resolveChildEvidence(ticket, started.childId, new AbortController().signal));
        assert.equal(f.bodies.length, postDrainDispatches); assert.equal(second.bodies.length, 0);
      } finally { detach(); }
      assert.throws(() => authority.assertDelivery(ticket, started.childId, evidence), { code: "UNAUTHORIZED" });
    });
  }
  assert.deepEqual(f.errors, []);
}

test("installed inactive Deepwork preserves an exact foreign dsmm-role-coding continuable provider in full access", { skip: unavailable, timeout: 45000 }, async t => {
  await startAndDeliverForeignChild(t, "dsmm-role-coding");
});

test("native child delivery accepts live foreign continuable provenance despite a role-like provider prefix", { skip: unavailable, timeout: 45000 }, async t => {
  await startAndDeliverForeignChild(t, "dsmm-role-foreign-native");
});

test("installed inactive Deepwork preserves ordinary foreign native continuation and parent delivery", { skip: unavailable, timeout: 45000 }, async t => {
  await startAndDeliverForeignChild(t, "foreign-native");
});
