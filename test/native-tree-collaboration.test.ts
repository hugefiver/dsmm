import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import type { DsmmProfileRuntime } from "../src/profile-runtime.js";
import { delegationDepthOf } from "@deepseek-ai/dsh-subagent";
import { readDelegationCeiling } from "../src/session-metadata.js";
import { nativeTreeRoot, nativeIsOwnedBy } from "../src/native-ownership.js";
import { nativeRoutingFixture, runFixtureTurn, executeFixtureTool } from "./native-routing-fixture.ts";

let callSequence = 0;
async function invoke(agent: Agent, name: string, args: unknown = {}) {
  try {
    return await executeFixtureTool(agent.ctx.get("tools")!, { agent, name, arguments: args,
      callId: ToolCallId(`tree-${++callSequence}`), signal: new AbortController().signal });
  } catch (cause) { throw new Error(`Native ${name} failed`, { cause }); }
}

async function child(parent: Agent, role: "dsmm-deep" | "dsmm-coding" | "dsmm-code-search") {
  const category = role !== "dsmm-code-search";
  const result = await invoke(parent, category ? "dsmm_category" : "dsmm_code_search", {
    ...(category ? { category: role } : {}), description: `Tree ${role}`, prompt: "Complete the bounded task", run_in_background: true
  });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.ok(!result.isError && typeof result.value === "object" && result.value !== null && "subagentId" in result.value);
  const id = result.value.subagentId;
  assert.equal(typeof id, "string");
  const agent = parent.ctx.agents.get(String(id));
  assert.ok(agent);
  return agent;
}

function holdChildRequests(f: Awaited<ReturnType<typeof nativeRoutingFixture>>, includeRoots = false) {
  const pending = new Map<string, () => void>();
  const releasedMembers = new Set<string>();
  let released = false;
  f.adapter.beforeStream = async options => {
    if (released || releasedMembers.has(options.sessionId!) || !includeRoots && f.agents.get(options.sessionId!)?.session.header.origin !== "subagent") return;
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    pending.set(options.sessionId!, finish);
    options.signal!.addEventListener("abort", finish, { once: true });
    try { await held; }
    finally { pending.delete(options.sessionId!); options.signal!.removeEventListener("abort", finish); }
  };
  return Object.assign(() => { released = true; for (const finish of pending.values()) finish(); }, {
    member(id: string) { releasedMembers.add(id); pending.get(id)?.(); }
  });
}

const treeHost = process.env.DSMM_TEST_DSH_ENTRY !== undefined;

test("cold target ceilings propagate through newly delegated parameterized descendants", { skip: !treeHost, timeout: 20000 }, async () => {
  const f = await nativeRoutingFixture({ subagents: { maxDepth: 4, enableRunInBackground: true, toolTopology: "parameterized" } }, { persistence: true, nativeControls: true });
  let release = holdChildRequests(f);
  let reopened: AgentHandle | undefined;
  try {
    const profiles = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const content = (enabled: boolean) => JSON.stringify({ version: 1, id: "target-ceiling", settings: { roles: { "dsmm-code-search": enabled } } });
    const saved = await profiles.save({ id: "target-ceiling", expectedRevision: null, content: content(false) });
    await profiles.select({ id: saved.id, expectedRevision: saved.revision, expectedSelectionRevision: "absent" });
    const root = await f.create({ agentPreset: "dsmm-orchestrator" });
    const a = await child(root, "dsmm-deep");
    const original = readDelegationCeiling(a.session); assert.ok(original);
    assert.ok(original.targets.includes("dsmm-coding"));
    assert.ok(original.targets.includes("dsmm-doc-search"));
    assert.equal(original.targets.includes("dsmm-code-search"), false);
    release(); await a.whenIdle(); await root.whenIdle();
    await f.disposeAgent(root); await f.ctx.sessionPersistence.flush();
    await profiles.save({ id: saved.id, expectedRevision: saved.revision, content: content(true) });
    reopened = await f.agents.resume({ resumeSessionId: root.id, agentOptions: { ...root.options },
      setup: async (ctx, agent) => { await f.ctx.agentPresets.mount(ctx, agent.session.header.agentPreset); } });
    release = holdChildRequests(f);
    assert.equal((await invoke(reopened.agent, "send_message", { agent: a.id, message: "Continue bounded delegation" })).isError, false);
    const resumed = f.agents.get(a.id); assert.ok(resumed);
    assert.equal((await f.ctx.dsmmNativeAdmission.ensure(resumed)).settings.roles["dsmm-code-search"], true);
    const b = await child(resumed, "dsmm-coding");
    assert.ok(b.ctx.tools.get("dsmm_role", b), "the shared parameterized entry remains usable");
    const denied = await invoke(b, "dsmm_role", { role: "dsmm-code-search", description: "Outside original targets", prompt: "Must not start", run_in_background: true });
    assert.ok(denied.isError, JSON.stringify(denied));
    assert.equal(f.agents.list().some(agent => f.ctx.dsmmNativeAdmission.invocation(agent)?.target === "dsmm-code-search"), false);
    assert.equal(readDelegationCeiling(b.session)?.targets.includes("dsmm-code-search"), false);
    const allowed = await invoke(b, "dsmm_role", { role: "dsmm-doc-search", description: "Inside original targets", prompt: "Read allowed evidence", run_in_background: true });
    assert.ok(!allowed.isError, JSON.stringify(allowed));
    assert.ok(typeof allowed.value === "object" && allowed.value !== null && "subagentId" in allowed.value);
    const c = f.agents.get(String(allowed.value.subagentId)); assert.ok(c);
    assert.equal(f.ctx.dsmmNativeAdmission.invocation(c)?.target, "dsmm-doc-search");
  } finally { release(); await reopened?.dispose(); await f.dispose(); }
});

test("cold readonly members retain native approval refusal and the selected profile's current enabled role", { skip: !treeHost, timeout: 20000 }, async () => {
  let reads = 0;
  const f = await nativeRoutingFixture({ subagents: { maxDepth: 3, enableRunInBackground: true } }, {
    persistence: true, nativeControls: true, nativePermissionSettings: true, dsmmLlm: true
  });
  const probe = join(f.profileDir, "tree-read-probe.txt"), forbidden = join(f.profileDir, "tree-readonly-write.txt");
  writeFileSync(probe, "approved evidence", { flag: "wx" });
  f.ctx.on("tools/result", (exec, result) => { if (exec.name === "read" && !result.isError) reads++; }, { global: true });
  const release = holdChildRequests(f, true);
  let releaseResumed: (() => void) | undefined;
  let reopened: AgentHandle | undefined;
  try {
    const profiles = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const content = (enabled: boolean) => JSON.stringify({ version: 1, id: "tree-policy", settings: { roles: { "dsmm-code-search": enabled } } });
    const saved = await profiles.save({ id: "tree-policy", expectedRevision: null, content: content(true) });
    await profiles.select({ id: saved.id, expectedRevision: saved.revision, expectedSelectionRevision: "absent" });
    await f.ctx.plugin(ApprovalService, { policy: "ask" }).await();
    let approvals = 0, approve = true, askRead = true;
    f.ctx.on("approval/request", async () => { approvals++; return approve ? "allowed-once" : "rejected"; }, { global: true });
    f.ctx.on("tools/pre-execute", async (exec, next) => {
      const decision = await next();
      return exec.name === "read" && askRead && decision.kind === "allow" ? { kind: "ask", reason: "Approve this exact read" } : decision;
    }, { global: true, prepend: true });
    const root = await f.create({ agentPreset: "dsmm-orchestrator" });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const remove = f.ctx.on("agent/pre-step", async (frame, next) => { if (frame.agent === root) entered(); return next(); }, { global: true });
    const rootTurn = runFixtureTurn(root);
    await started; remove();
    const rootRead = await invoke(root, "read", { file_path: probe });
    assert.equal(rootRead.isError, false, JSON.stringify(rootRead));
    const a = await child(root, "dsmm-deep");
    const b = await child(a, "dsmm-code-search");
    askRead = false;
    const allowed = await invoke(b, "read", { file_path: probe });
    assert.equal(allowed.isError, false, JSON.stringify(allowed));
    askRead = true;
    assert.equal((await invoke(b, "read", { file_path: probe })).isError, true);
    assert.equal(approvals, 1, "the native child never policy refuses rather than borrowing the root's approval");
    assert.equal(reads, 2);
    assert.equal((await invoke(b, "write", { file_path: forbidden, content: "must not write" })).isError, true);
    assert.equal(readDelegationCeiling(b.session)?.readOnly, true);
    release(); await b.whenIdle(); await a.whenIdle(); await rootTurn;
    await f.disposeAgent(root); await f.ctx.sessionPersistence.flush();
    reopened = await f.agents.resume({ resumeSessionId: root.id, agentOptions: { ...root.options },
      setup: async (ctx, agent) => { await f.ctx.agentPresets.mount(ctx, agent.session.header.agentPreset); } });
    approve = false;
    releaseResumed = holdChildRequests(f);
    assert.equal((await invoke(reopened.agent, "send_message", { agent: b.id, message: "Continue readonly task" })).isError, false);
    const resumed = f.agents.get(b.id);
    assert.ok(resumed);
    assert.equal(f.agents.get(a.id), undefined);
    askRead = false;
    const allowedCold = await invoke(resumed, "read", { file_path: probe });
    assert.equal(allowedCold.isError, false, JSON.stringify(allowedCold));
    askRead = true;
    assert.equal((await invoke(resumed, "read", { file_path: probe })).isError, true);
    assert.equal(approvals, 1, "cold continuation retains native never rather than historical root approval");
    assert.equal(reads, 3);
    assert.equal((await invoke(resumed, "write", { file_path: forbidden, content: "must not write" })).isError, true);
    assert.equal(existsSync(forbidden), false);
    releaseResumed();
    await resumed.whenIdle(); await reopened.agent.whenIdle();
    await reopened.dispose(); await f.ctx.sessionPersistence.flush();
    await profiles.save({ id: saved.id, expectedRevision: saved.revision, content: content(false) });
    reopened = await f.agents.resume({ resumeSessionId: root.id, agentOptions: { ...root.options },
      setup: async (ctx, agent) => { await f.ctx.agentPresets.mount(ctx, agent.session.header.agentPreset); } });
    const before = f.adapter.calls.filter(call => call.sessionId === b.id).length;
    const refused = await invoke(reopened.agent, "send_message", { agent: b.id, message: "Disabled role must refuse" });
    const rejected = f.agents.get(b.id);
    if (rejected !== undefined) await rejected.whenIdle();
    assert.equal(f.adapter.calls.filter(call => call.sessionId === b.id).length, before);
    if (!refused.isError) assert.ok(rejected === undefined || rejected.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind !== "completed"));
  } finally { release(); releaseResumed?.(); await reopened?.dispose(); await f.dispose(); }
});

test("native tree siblings message with actual identity; interruption requires an ancestor", { skip: !treeHost, timeout: 20000 }, async () => {
  const f = await nativeRoutingFixture({ subagents: { maxDepth: 3, enableRunInBackground: true } }, { persistence: true, nativeControls: true });
  const release = holdChildRequests(f);
  try {
    const root = await f.create({ agentPreset: "dsmm-orchestrator" });
    const other = await f.create({ agentPreset: "dsmm-orchestrator" });
    const a = await child(root, "dsmm-deep");
    const b = await child(a, "dsmm-coding");
    const sibling = await child(root, "dsmm-code-search");
    assert.equal(f.agents.get(b.id) === b, true, `exact resident B: ${f.agents.get(b.id)?.id}`);
    assert.equal((f.subagents as unknown as { rootOf(agent: Agent): Agent }).rootOf(b).id, root.id);
    assert.equal(nativeTreeRoot(f.agents, b)?.id, root.id);
    assert.equal(nativeTreeRoot(f.agents, b) === f.agents.get(root.id), true);
    assert.equal(nativeIsOwnedBy(f.agents, b.id, root), false);
    const creatorDisposed = new Promise<void>(resolve => {
      const remove = f.ctx.on("agent/disposed", ({ agent }) => { if (agent === a) { remove(); resolve(); } }, { global: true });
    });
    release.member(a.id);
    await creatorDisposed;
    assert.equal(f.agents.get(a.id), undefined);
    assert.equal(f.agents.get(b.id) === b, true);
    const probe = join(f.profileDir, "resident-work.txt");
    writeFileSync(probe, "resident work after creator exit", { flag: "wx" });
    const residentWork = await invoke(b, "read", { file_path: probe });
    assert.equal(residentWork.isError, false, JSON.stringify(residentWork));
    const listed = await invoke(sibling, "list_agents");
    assert.equal(listed.isError, false, JSON.stringify(listed));
    const delivered = await invoke(sibling, "send_message", { agent: b.id, message: "sibling message" });
    assert.equal(delivered.isError, false, JSON.stringify(delivered));
    const message = b.inbox.nextStep.find(message => message.source?.kind === "agent-message" && message.source.senderSessionId === sibling.id);
    assert.ok(message);
    assert.ok(message.content.some(block => block.type === "text" && block.text === "sibling message"));
    assert.equal((await invoke(other, "send_message", { agent: b.id, message: "cross-tree" })).isError, true);
    assert.equal((await invoke(sibling, "interrupt_agent", { agent: b.id })).isError, true);
    assert.equal((await invoke(root, "interrupt_agent", { agent: b.id })).isError, false);
    assert.equal((await invoke(other, "interrupt_agent", { agent: b.id })).isError, true);
  } finally { release(); await f.dispose(); }
});

test("native cold grandchild keeps its ID and ceilings without recreating its creator", { skip: !treeHost, timeout: 20000 }, async () => {
  const f = await nativeRoutingFixture({ subagents: { maxDepth: 2, enableRunInBackground: true } }, { persistence: true, nativeControls: true });
  const release = holdChildRequests(f);
  let reopened: AgentHandle | undefined;
  try {
    const root = await f.create({ agentPreset: "dsmm-orchestrator" });
    const a = await child(root, "dsmm-deep");
    a.ctx.get("tools")!.restrict({ deny: ["web_search"] });
    const b = await child(a, "dsmm-coding");
    release();
    await b.whenIdle();
    await a.whenIdle();
    const captured = readDelegationCeiling(b.session);
    assert.ok(captured);
    assert.equal(captured.creatorId, a.id);
    assert.equal(captured.rootId, root.id);
    assert.equal(captured.allow?.includes("web_search"), false);
    assert.equal(captured.maxDepth, 2);
    assert.equal(b.session.snapshotEvents().findIndex(event => event.type === "plugin:dsmm/delegation-ceiling")
      < b.session.snapshotEvents().findIndex(event => event.type === "request/header"), true, JSON.stringify(b.session.snapshotEvents().map(event => ({ type: event.type, ...event.type === "turn/end" ? { data: event.data } : {} }))));
    await root.whenIdle();
    await f.disposeAgent(root);
    assert.equal(f.agents.get(b.id), undefined);
    await f.ctx.sessionPersistence.flush();
    reopened = await f.agents.resume({ resumeSessionId: root.id, agentOptions: { ...root.options },
      setup: async (ctx, agent) => { await f.ctx.agentPresets.mount(ctx, agent.session.header.agentPreset); } });
    const delivered = await invoke(reopened.agent, "send_message", { agent: b.id, message: "cold continuation" });
    assert.equal(delivered.isError, false, JSON.stringify(delivered));
    const resumed = f.agents.get(b.id);
    assert.ok(resumed);
    assert.equal(resumed.id, b.id);
    assert.equal(resumed.session.header.parentSession, a.id);
    assert.equal(f.agents.get(a.id), undefined);
    assert.equal(delegationDepthOf(resumed), 2);
    assert.deepEqual(readDelegationCeiling(resumed.session), captured);
    await runFixtureTurn(resumed);
    assert.ok(f.adapter.calls.some(call => call.sessionId === resumed.id));
    assert.equal((await invoke(resumed, "web_search", { query: "must remain denied" })).isError, true);
    assert.ok(resumed.ctx.tools.get("dsmm_code_search", resumed));
    const deeper = await invoke(resumed, "dsmm_code_search", { description: "Over captured depth", prompt: "Must refuse" });
    assert.ok(deeper.isError, JSON.stringify(deeper));
    assert.equal(f.ctx.dsmmNativeAdmission.policy.maximumDepth(resumed, 4), 2);
    assert.doesNotThrow(() => f.ctx.dsmmNativeAdmission.policy.assertDelegation(resumed, "dsmm-code-search"));
    assert.equal(f.agents.get(a.id), undefined);
    assert.equal((await invoke(resumed, "list_agents")).isError, false);
  } finally { release(); await reopened?.dispose(); await f.dispose(); }
});
