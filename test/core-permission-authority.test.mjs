import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createCorePermissionAuthority } from "../src/core-permission-authority.ts";
import { PermissionRefusal } from "../src/permission-control.ts";
import { DsmmRolePolicy } from "../src/role-policy.ts";
import { DeepworkModeController } from "../src/state.ts";
import { nativeRootLlmFixture, loadNative } from "./native-root-llm-fixture.mjs";

async function adapter(f) {
  const getSettings = f.ctx.dsmmProfileRuntime.getSettings;
  const owner = [...f.ctx.loader.entries()].find(entry => entry.options.id === "dsmm").fiber;
  const policy = new DsmmRolePolicy(f.ctx, getSettings, new DeepworkModeController(f.ctx, agent => getSettings(agent).modules.deepwork.enabled));
  const lifetime = new AbortController();
  owner.ctx.effect(() => () => lifetime.abort());
  const factory = createCorePermissionAuthority(owner.ctx, { getSettings, rolePolicy: policy, signal: lifetime.signal });
  return { ...factory, fiber: owner, getSettings, policy, owner };
}

async function probe(f, agent, name = "authority_probe", args = {}) {
  const { ToolCallId } = await loadNative("@deepseek-ai/dsh-llm");
  let execution;
  const detach = f.ctx.on("tools/pre-execute", async (exec, next) => { if (exec.agent === agent && exec.name === name) execution = exec; return next(); }, { global: true, prepend: true });
  try {
    const result = await agent.ctx.tools.execute({ agent, name, arguments: args, callId: ToolCallId(randomUUID()), signal: new AbortController().signal });
    assert.ok(execution, "the native ToolRuntime must supply the execution object");
    return { execution, result };
  } finally { detach(); }
}

function registerProbe(f) {
  return f.ctx.tools.register({ name: "authority_probe", description: "Local permission authority probe", parameters: { type: "object", properties: {} },
    output: { schema: { type: "null" }, render: () => [] }, async execute() { return null; } });
}

test("live Core admissions bind stable signals, admission and disposal", async t => {
  const f = await nativeRootLlmFixture(t);
  const { ToolCallId } = await loadNative("@deepseek-ai/dsh-llm");
  const a = await adapter(f), root = await f.create("dsmm-orchestrator");
  registerProbe(f);
  let guards = 0;
  f.ctx.tools.guard(() => { guards++; });
  const { execution: exec, result } = await probe(f, root);
  assert.equal(result.isError, false);
  const first = a.authority.current(exec), second = a.authority.current(exec);
  assert.equal(first.agent, root); assert.equal(first.root, root); assert.equal(first.realm, root.ctx);
  assert.equal(first.owner, a.owner.ctx); assert.equal(first.admissionRevision, a.getSettings.admission(root).epoch);
  assert.equal(first.ownerGeneration, first.admissionRevision);
  assert.equal(first.signal, second.signal); assert.equal(first.permissionRevision, second.permissionRevision);
  assert.equal(first.run, undefined);
  assert.equal(a.authority.rootCurrent(root, exec).signal, first.signal);
  const { setSandboxMode } = await loadNative("@deepseek-ai/dsh-sandbox-policy");
  setSandboxMode(root.session, "read-only");
  assert.throws(() => a.assertWritable(root), { code: "denied" });
  setSandboxMode(root.session, "workspace-write");
  a.assertWritable(root);
  const writableGeneration = a.authority.current(exec);
  a.authority.assertCurrent(writableGeneration, exec); a.authority.assertCurrent(writableGeneration, exec);
  assert.equal(guards, 1, "last-mile assertions must not execute third-party guards again");
  assert.throws(() => a.authority.current({ ...exec, agent: { ...root } }), PermissionRefusal);
  const unrelated = await f.create("dsmm-orchestrator");
  assert.throws(() => a.authority.rootCurrent(unrelated, exec), PermissionRefusal);

  const before = await f.ctx.dsmmProfileRuntime.getSession(root);
  await f.ctx.dsmmProfileRuntime.selectSession({ sessionId: root.id, id: null,
    expectedSelectionRevision: before.selection.selectionRevision, expectedAdmissionEpoch: before.admissionEpoch }, root);
  const changed = a.authority.current(exec);
  assert.equal(writableGeneration.signal.aborted, true);
  assert.notEqual(changed.admissionRevision, writableGeneration.admissionRevision);
  assert.equal(changed.admissionRevision, a.getSettings.admission(root).epoch);
  assert.equal(changed.owner, a.owner.ctx);

  const releaseRestriction = root.ctx.tools.restrict({ deny: ["authority_probe"] });
  const denied = await root.ctx.tools.execute({ ...exec, callId: ToolCallId(randomUUID()) });
  assert.equal(denied.isError, true, "a new call must use the current native restriction");
  releaseRestriction();
  const live = a.authority.current(exec);
  await a.fiber.dispose();
  assert.equal(live.signal.aborted, true);
  assert.throws(() => a.authority.current(exec), PermissionRefusal);
  assert.deepEqual(f.errors, []);
});

test("Core writable checks use live native policy without DW integration or idle state", { timeout: 30000 }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; }), entered = Promise.withResolvers();
  const f = await nativeRootLlmFixture(t, { defaultActive: false }, { globalConfig: { modules: { deepwork: { enabled: false } } }, cleanup: () => release(), async respond(body, res) {
    entered.resolve(); await gate;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "permission-core-response", object: "chat.completion.chunk", created: 1, model: body.model };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "root completed" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  } });
  assert.equal(f.ctx.get("dsmmRuntimeIntegration"), undefined);
  const a = await adapter(f), root = await f.create();
  const { setSandboxMode } = await loadNative("@deepseek-ai/dsh-sandbox-policy");
  setSandboxMode(root.session, "read-only");
  assert.throws(() => a.assertWritable(root), { code: "denied" });
  setSandboxMode(root.session, "workspace-write");
  a.assertWritable(root);
  registerProbe(f);
  const { execution, result } = await probe(f, root);
  assert.equal(result.isError, false);
  const current = a.authority.current(execution);
  assert.equal(current.owner, a.owner.ctx);
  assert.equal(current.admissionRevision, a.getSettings.admission(root).epoch);
  assert.equal(current.realm, root.ctx); assert.equal(current.root, root);
  assert.equal(a.authority.current(execution).signal, current.signal);
  assert.equal(a.authority.rootCurrent(root, execution).signal, current.signal);
  a.authority.assertCurrent(current, execution);
  const running = f.run(root);
  await entered.promise;
  assert.equal(root.status, "running");
  a.assertWritable(root);
  setSandboxMode(root.session, "read-only");
  assert.throws(() => a.assertWritable(root), { code: "denied" });
  release(); await running;
  await a.fiber.dispose();
  assert.throws(() => a.assertWritable(root), { code: "cancelled" });
  assert.deepEqual(f.errors, []);
});

test("actual invocation children borrow only their registered holder and independent Root policy", { timeout: 30000 }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await nativeRootLlmFixture(t, { subagents: { toolTopology: "parameterized" } }, { cleanup: () => release(), async respond(body, res) {
    await gate;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "permission-child-response", object: "chat.completion.chunk", created: 1, model: body.model };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "child completed" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  } });
  const a = await adapter(f), root = await f.create("dsmm-orchestrator");
  const { ToolCallId } = await loadNative("@deepseek-ai/dsh-llm");
  const created = Promise.withResolvers();
  const detachCreated = f.ctx.on("agent/created", ({ agent }) => {
    if (f.ctx.agents.isOwnedBy(agent.id, root)) created.resolve(agent);
  }, { global: true });
  t.after(detachCreated);
  const parentCall = root.ctx.tools.execute({ agent: root, name: "dsmm_role", arguments: { role: "dsmm-doc-search", description: "Read-only child", prompt: "Complete the bounded probe" },
    callId: ToolCallId(randomUUID()), signal: new AbortController().signal });
  const host = f.ctx.dsmmRuntimeIntegration;
  await Promise.race([created.promise, parentCall.then(result => { assert.fail(JSON.stringify(result)); })]);
  const holder = host.registry.list(root, host.owner)[0];
  assert.ok(holder);
  await holder.ready;
  const child = f.ctx.agents.get(holder.invocation.childId);
  assert.ok(child);
  const { execution: exec } = await probe(f, child, "read", { file_path: `${f.workspace}/AGENTS.md` });
  const current = a.authority.current(exec);
  assert.equal(current.agent, child); assert.equal(current.root, root); assert.equal(current.realm, child.ctx);
  assert.equal(current.run, holder);
  assert.equal(a.authority.current(exec).signal, current.signal);
  const operator = a.authority.rootCurrent(root, exec);
  assert.equal(operator.realm, root.ctx); assert.notEqual(operator.realm, current.realm);
  assert.equal(operator.owner, a.owner.ctx);
  a.authority.assertCurrent(current, exec);

  registerProbe(f);
  const { result: write } = await probe(f, child);
  assert.equal(write.isError, true, "the read-only child cannot execute an unapproved tool");
  release();
  await parentCall; await holder.drained;
  assert.throws(() => a.authority.current(exec));
  assert.deepEqual(f.errors, []);
});

test("ordinary native child permission authority uses its real Core parent and independent native restrictions", async t => {
  const response = Promise.withResolvers();
  const f = await nativeRootLlmFixture(t, { defaultActive: false }, { beforeRespond: () => response.promise, cleanup: () => response.resolve() });
  const { ToolCallId } = await loadNative("@deepseek-ai/dsh-llm");
  const a = await adapter(f), root = await f.create();
  const started = await f.ctx.subagents.startActivation({ provider: "spawn", label: "Core native child", delivery: "parent", signal: new AbortController().signal,
    request: { parent: root, prompt: [{ type: "text", text: "Answer in the native child" }], agentOptions: { provider: "local", model: "root-model" } } });
  const child = f.ctx.agents.get(started.childId);
  assert.ok(child);
  const { execution } = await probe(f, child, "read", { file_path: `${f.workspace}/AGENTS.md` });
  const current = a.authority.current(execution);
  assert.equal(current.agent, child); assert.equal(current.root, root); assert.equal(current.realm, child.ctx);
  assert.equal(current.owner, a.owner.ctx); assert.equal(current.run, undefined);
  assert.equal(current.admissionRevision, a.getSettings.admission(root).epoch);
  a.authority.assertCurrent(current, execution);
  const operator = a.authority.rootCurrent(root, execution);
  assert.equal(operator.realm, root.ctx);
  const restrict = child.ctx.tools.restrict({ deny: ["read"] });
  const denied = await child.ctx.tools.execute({ ...execution, callId: ToolCallId(randomUUID()) });
  assert.equal(denied.isError, true, "a new call must use the child's current native restriction");
  restrict();
  a.authority.assertCurrent(a.authority.current(execution), execution);
  response.resolve(); await child.whenIdle();
  assert.deepEqual(f.errors, []);
});
