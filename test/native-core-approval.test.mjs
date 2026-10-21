import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeRootLlmFixture, loadNative } from "./native-root-llm-fixture.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const unavailable = process.platform !== "win32" || !process.env.DSMM_TEST_DSH_ENTRY;

test("native full access runs ordinary tools without an unrelated DW delivery provider", { skip: unavailable, timeout: 30000 }, async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: true, guards: { gitWriteGuard: "deny" } }, {
    lateSpawn: true, migrateShell: true, approvalPolicy: "ask",
    globalConfig: { permissionControl: { outsideReads: "ask", nativeCommands: { enabled: false } } },
  });
  const { setSandboxMode } = await loadNative("@deepseek-ai/dsh-sandbox-policy");
  const { ToolCallId } = await loadNative("@deepseek-ai/dsh-llm");
  const root = await f.create(); root.session.append("turn/start", { turn: 1 });
  setSandboxMode(root.session, "danger-full-access");
  let approvals = 0;
  f.ctx.on("approval/request", async () => { approvals++; return "allowed-once"; }, { global: true });
  assert.equal(f.ctx.get("dsmmRuntimeIntegration").runtime.authority.view().deliveryFenceReady, false);
  const result = await root.ctx.tools.execute({ agent: root, name: "pwsh", arguments: {
    command: "Write-Output 42", workdir: f.workspace, description: "Use the actual native shell", timeoutMs: 10000,
  }, callId: ToolCallId("full-access-native-without-dw-spawn"), signal: new AbortController().signal });
  assert.equal(result.value?.exitCode, 0, JSON.stringify(result));
  assert.match(JSON.stringify(result.content), /42/u);
  const denied = await root.ctx.tools.execute({ agent: root, name: "pwsh", arguments: {
    command: "git commit --dry-run --porcelain", workdir: f.workspace, description: "Check the configured explicit Git deny", timeoutMs: 10000,
  }, callId: ToolCallId("full-access-explicit-git-deny"), signal: new AbortController().signal });
  assert.equal(denied.isError, true); assert.equal(denied.value, undefined);
  assert.equal(approvals, 0); assert.equal(f.bodies.length, 0);
  await assert.rejects(f.ctx.subagents.start("dsmm-role-coding", { parent: root, prompt: [], signal: new AbortController().signal }));
});

test("full access runs preexisting and newly registered native capabilities without a missing-admission veto", { skip: unavailable, timeout: 30000 }, async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: true }, { approvalPolicy: "ask" });
  const { setSandboxMode } = await loadNative("@deepseek-ai/dsh-sandbox-policy");
  const { ToolCallId } = await loadNative("@deepseek-ai/dsh-llm");
  const { getTraceable } = await loadNative("@deepseek-ai/cordis");
  let approvals = 0, bodies = 0;
  f.ctx.tools.register({ name: "owned_preexisting_probe", description: "Preexisting native capability with no filesystem or process effect", parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] }, execute() { bodies++; return "preexisting native result"; } });
  const root = await f.create("dsmm-orchestrator"); root.session.append("turn/start", { turn: 1 });
  setSandboxMode(root.session, "danger-full-access");
  f.ctx.on("approval/request", async () => { approvals++; return "allowed-once"; }, { global: true });
  const raw = f.ctx.agentPresets.serviceFor(root, "tools"), tools = raw === undefined ? root.ctx.tools : getTraceable(root.ctx, raw);
  tools.register({ name: "owned_native_probe", description: "Native capability with no filesystem or process effect", parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] }, execute() { bodies++; return "native capability result"; } });
  const execute = name => tools.execute({ agent: root, name, arguments: {}, callId: ToolCallId(`full-native-${name}`), signal: new AbortController().signal });
  assert.equal((await execute("owned_preexisting_probe")).value, "preexisting native result");
  const result = await execute("owned_native_probe");
  assert.notEqual(result.isError, true, JSON.stringify(result)); assert.equal(result.value, "native capability result");
  assert.equal(bodies, 2); assert.equal(approvals, 0); assert.equal(f.bodies.length, 0);
});

test("a full-access Root sends plain model turns despite an unreadable DSMM permission source", { skip: unavailable, timeout: 30000 }, async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false }, { approvalPolicy: "ask", globalConfig: { permissionControl: { outsideReads: "ask" } } });
  const { setSandboxMode } = await loadNative("@deepseek-ai/dsh-sandbox-policy");
  const root = await f.create();
  setSandboxMode(root.session, "danger-full-access");
  const owner = f.ctx.get("dsmmCoreLlmOwner");
  await writeFile(join(f.home, "plugins", "dsmm", "config.json"), "{ malformed permission source");
  await f.run(root, "First plain full-access turn");
  await f.run(root, "Second plain full-access turn");
  assert.deepEqual(f.errors, []); assert.equal(f.bodies.length, 2);
  assert.equal(f.ctx.get("dsmmCoreLlmOwner"), owner);
});

test("a native Allow completes its exact DSMM delegation after role intent changes, without granting the next call", { skip: unavailable, timeout: 45000 }, async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: true }, { approvalPolicy: "ask" });
  const { ToolCallId } = await loadNative("@deepseek-ai/dsh-llm");
  const root = await f.create(); root.session.append("turn/start", { turn: 1 });
  let approvals = 0;
  f.ctx.on("tools/pre-execute", async (exec, next) => {
    const decision = await next();
    return exec.name === "dsmm_reviewer" && decision.kind === "allow" ? { kind: "ask", reason: "Approve this exact reviewer invocation" } : decision;
  }, { prepend: true, global: true });
  f.ctx.on("approval/request", async () => {
    approvals++; root.session.append("deepwork/mode", { active: false }); return "allowed-once";
  }, { global: true });
  const invoke = id => root.ctx.tools.execute({ agent: root, name: "dsmm_reviewer", arguments: { description: "Exact native-approved review", prompt: "Return a useful local result" },
    callId: ToolCallId(id), signal: new AbortController().signal });
  const first = await invoke("approved-review");
  assert.notEqual(first.isError, true, JSON.stringify(first)); assert.equal(approvals, 1);
  assert.equal((await invoke("next-review")).isError, true);
  assert.equal(approvals, 1); assert.equal(f.bodies.length, 1);
});

test("full access does not classify an exact foreign role-named registration as disabled DSMM delegation", { skip: unavailable, timeout: 30000 }, async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: true, roles: { "dsmm-coding": false } }, { approvalPolicy: "ask" });
  const { setSandboxMode } = await loadNative("@deepseek-ai/dsh-sandbox-policy");
  const { ToolCallId } = await loadNative("@deepseek-ai/dsh-llm");
  let bodies = 0, approvals = 0;
  const definition = { name: "dsmm_coding", description: "Unrelated registered native counter", parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] }, execute() { bodies++; return "foreign-native"; } };
  f.ctx.tools.register(definition);
  const root = await f.create(); root.session.append("turn/start", { turn: 1 });
  setSandboxMode(root.session, "danger-full-access");
  f.ctx.on("approval/request", async () => { approvals++; return "allowed-once"; }, { global: true });
  assert.equal(root.ctx.tools.get(definition.name, root), definition);
  const result = await root.ctx.tools.execute({ agent: root, name: definition.name, arguments: {},
    callId: ToolCallId("full-access-foreign-role-name"), signal: new AbortController().signal });
  assert.notEqual(result.isError, true, JSON.stringify(result)); assert.equal(result.value, "foreign-native");
  assert.equal(bodies, 1); assert.equal(approvals, 0); assert.equal(f.bodies.length, 0);
});

test("native approval cannot substitute a changed owned DSMM tool body", { skip: unavailable, timeout: 30000 }, async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: true }, { approvalPolicy: "ask" });
  const { ToolCallId } = await loadNative("@deepseek-ai/dsh-llm");
  const root = await f.create(); root.session.append("turn/start", { turn: 1 });
  const definition = root.ctx.tools.get("dsmm_reviewer", root), original = definition.execute;
  let replacements = 0, approvals = 0;
  f.ctx.on("tools/pre-execute", async (exec, next) => {
    const decision = await next();
    return exec.name === definition.name && decision.kind === "allow" ? { kind: "ask", reason: "Approve this exact registered reviewer" } : decision;
  }, { prepend: true, global: true });
  f.ctx.on("approval/request", async () => {
    approvals++; definition.execute = async () => { replacements++; return "replacement"; }; return "allowed-once";
  }, { global: true });
  try {
    const result = await root.ctx.tools.execute({ agent: root, name: definition.name, arguments: { description: "Owned body lifecycle", prompt: "Return a useful local result" },
      callId: ToolCallId("changed-owned-body"), signal: new AbortController().signal });
    assert.equal(result.isError, true); assert.equal(approvals, 1);
    assert.equal(replacements, 0); assert.equal(f.bodies.length, 0);
  } finally { definition.execute = original; }
});
