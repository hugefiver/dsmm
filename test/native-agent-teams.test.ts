import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolDefinition, ToolExecutionResult, ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import type { DshContext } from "../src/dsh-types.js";
import { readDelegationCeiling } from "../src/session-metadata.js";
import { executeFixtureTool, nativeFixturePlugin, nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

interface NativeStep {
  view(scope: object): ReadonlyMap<string, ToolDefinition>;
  dispose(): void;
}
type StepTools = ToolRuntime & {
  resolve(context: { agent: Agent; modelSelection: Agent["options"]; signal: AbortSignal }): Promise<NativeStep>;
  schemas(agent: Agent, step: NativeStep): ToolSchema[];
};
interface Task {
  id: string;
  revision: number;
  status: "pending" | "in_progress" | "completed" | "deleted";
  subject: string;
  owner?: string;
  ownerId?: string;
  ready: boolean;
  blockedBy: string[];
  writeScopes: string[];
}
interface NativeTeams {
  isEnabled(agent: Agent): boolean;
  setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void>;
  listTasks(agent: Agent): Task[];
  getTask(agent: Agent, id: string): Task;
  projection: { stateOf(session: Agent["session"]): { enabled?: boolean; tasks: Task[] } };
}
const taskNames = ["team_task_create", "team_task_list", "team_task_get", "team_task_update"];
let sequence = 0;
const toolsOf = (agent: Agent) => agent.ctx.tools as StepTools;
async function step(agent: Agent): Promise<NativeStep> {
  return toolsOf(agent).resolve({ agent, modelSelection: agent.options, signal: new AbortController().signal });
}
async function invoke(agent: Agent, name: string, args: unknown = {}, admitted?: NativeStep, useStep = true) {
  const toolSet = admitted ?? (useStep ? await step(agent) : undefined);
  try {
    return await executeFixtureTool(agent.ctx.tools, { agent, name, arguments: args,
      callId: ToolCallId(`team-${++sequence}`), signal: new AbortController().signal, ...(toolSet === undefined ? {} : { toolSet }) });
  } finally { if (admitted === undefined) toolSet?.dispose(); }
}
function task(result: ToolExecutionResult): Task {
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(typeof result.value === "object" && result.value !== null && "id" in result.value && typeof result.value.id === "string");
  return result.value as unknown as Task;
}
function failure(result: ToolExecutionResult, code?: string): void {
  assert.ok(result.isError, JSON.stringify(result));
  if (code !== undefined) assert.equal(result.error.info?.code, code, JSON.stringify(result));
}
async function names(agent: Agent): Promise<string[]> {
  const current = await step(agent);
  try { return toolsOf(agent).schemas(agent, current).map(tool => tool.name).filter(name => taskNames.includes(name)); }
  finally { current.dispose(); }
}
async function member(parent: Agent, role: "dsmm-coding" | "dsmm-code-search"): Promise<Agent> {
  const result = await invoke(parent, role === "dsmm-coding" ? "dsmm_category" : "dsmm_code_search", {
    ...(role === "dsmm-coding" ? { category: role } : {}), description: "Native Team member", prompt: "Wait for an assigned shared task", run_in_background: true
  });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(typeof result.value === "object" && result.value !== null && "subagentId" in result.value);
  const child = parent.ctx.agents.get(String(result.value.subagentId)); assert.ok(child);
  return child;
}

async function teamFixture() {
  const f = await nativeRoutingFixture({ subagents: { maxDepth: 3, enableRunInBackground: true } }, {
    persistence: true, nativeControls: true, nativeFs: true,
    beforeDsmm: async ctx => {
      const service = await nativeFixturePlugin("@deepseek-ai/dsh-agent-team");
      await ctx.plugin(service.default, {}).await();
      const tools = await nativeFixturePlugin("@deepseek-ai/dsh-tool-agent-team");
      await ctx.plugin(tools, {}).await();
    }
  });
  const teams = (f.ctx as unknown as DshContext).get!<NativeTeams>("agentTeams"); assert.ok(teams);
  const pending = new Map<string, () => void>(), entered = new Set<string>(), entering = new Map<string, () => void>(), released = new Set<string>();
  let closed = false;
  f.adapter.beforeStream = async options => {
    const id = options.sessionId!;
    if (f.agents.get(id)?.session.header.origin !== "subagent") return;
    entered.add(id); entering.get(id)?.(); entering.delete(id);
    if (closed || released.has(id)) return;
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    pending.set(id, finish); options.signal!.addEventListener("abort", finish, { once: true });
    try { await held; }
    finally { pending.delete(id); options.signal!.removeEventListener("abort", finish); }
  };
  return { ...f, teams,
    entered(agent: Agent): Promise<void> { return entered.has(agent.id) ? Promise.resolve() : new Promise(resolve => { entering.set(agent.id, resolve); }); },
    release(agent: Agent) { released.add(agent.id); pending.get(agent.id)?.(); },
    hold(agent: Agent) { released.delete(agent.id); entered.delete(agent.id); },
    async dispose() { closed = true; for (const finish of pending.values()) finish(); await f.dispose(); }
  };
}

const unavailable = process.env.DSMM_TEST_DSH_ENTRY === undefined;

test("native persistence uncertainty leaves one readable task without automatic replay", { skip: unavailable, timeout: 15000 }, async () => {
  const f = await teamFixture();
  try {
    const root = await f.create({ agentPreset: "dsmm-orchestrator" });
    await f.teams.setEnabled(root, true);
    const remove = f.ctx.on("session/flush", session => { if (session === root.session) throw new Error("Fixture durability checkpoint failure"); }, { global: true });
    try {
      failure(await invoke(root, "team_task_create", { subject: "Unconfirmed durability", description: "Reread before deciding further action" }), "TEAM_TASK_PERSISTENCE_UNCONFIRMED");
    } finally { remove(); }
    const visible = f.teams.listTasks(root); assert.equal(visible.length, 1);
    const current = task(await invoke(root, "team_task_get", { task_id: visible[0].id }));
    assert.equal(current.revision, 1); assert.equal(current.status, "pending");
    assert.equal(f.teams.listTasks(root).length, 1);
    await f.ctx.sessions.flush(root.session);
  } finally { await f.dispose(); }
});

test("Hosts without native Team service retain normal model execution and no Team tools", async () => {
  const f = await nativeRoutingFixture();
  try {
    const root = await f.create({ agentPreset: "dsmm-orchestrator" });
    assert.equal((f.ctx as unknown as DshContext).get?.("agentTeams"), undefined);
    await runFixtureTurn(root);
    const request = f.adapter.calls.find(call => call.sessionId === root.id); assert.ok(request);
    assert.equal(request.tools?.some(tool => taskNames.includes(tool.name)) ?? false, false);
    assert.equal(root.ctx.tools.schemas(root).some(tool => taskNames.includes(tool.name)), false);
  } finally { await f.dispose(); }
});

test("native task workflow preserves CAS, readonly ownership and explicit wake semantics", { skip: unavailable, timeout: 25000 }, async () => {
  const f = await teamFixture();
  try {
    const root = await f.create({ agentPreset: "dsmm-orchestrator" }), foreign = await f.create({ agentPreset: "dsmm-orchestrator" });
    await f.teams.setEnabled(root, true); await f.teams.setEnabled(foreign, true);
    const writer = await member(root, "dsmm-coding"), reader = await member(root, "dsmm-code-search");
    await Promise.all([f.entered(writer), f.entered(reader)]);
    const blocker = task(await invoke(root, "team_task_create", { subject: "Prepare evidence", description: "Complete the prerequisite" }));
    const dependent = task(await invoke(root, "team_task_create", { subject: "Write bounded result", description: "Write then complete", blocked_by: [blocker.id], write_scopes: ["team-result.txt"] }));
    assert.equal(dependent.ready, false);
    failure(await invoke(writer, "team_task_update", { task_id: dependent.id, expected_revision: dependent.revision, action: "claim" }), "TEAM_TASK_BLOCKED");
    assert.equal(f.teams.getTask(root, dependent.id).revision, dependent.revision);
    const claimed = task(await invoke(writer, "team_task_update", { task_id: blocker.id, expected_revision: blocker.revision, action: "claim" }));
    assert.equal(claimed.status, "in_progress"); assert.equal(f.teams.getTask(root, blocker.id).ownerId, writer.id);
    failure(await invoke(writer, "team_task_update", { task_id: blocker.id, expected_revision: blocker.revision, action: "complete" }), "TEAM_TASK_STALE_REVISION");
    const done = task(await invoke(writer, "team_task_update", { task_id: blocker.id, expected_revision: claimed.revision, action: "complete" }));
    assert.equal(done.status, "completed");
    const ready = task(await invoke(writer, "team_task_get", { task_id: dependent.id })); assert.equal(ready.ready, true);
    const working = task(await invoke(writer, "team_task_update", { task_id: dependent.id, expected_revision: ready.revision, action: "claim" }));
    const output = join(f.profileDir, "team-result.txt");
    const write = await invoke(writer, "write", { file_path: output, content: "native Team result" });
    assert.ok(!write.isError, JSON.stringify(write)); assert.equal(readFileSync(output, "utf8"), "native Team result");
    assert.equal(task(await invoke(writer, "team_task_update", { task_id: dependent.id, expected_revision: working.revision, action: "complete" })).status, "completed");
    const report = task(await invoke(root, "team_task_create", { subject: "Readonly report", description: "Report findings to the root", write_scopes: ["readonly-report.txt"] }));
    const disposed = new Promise<void>(resolve => {
      const remove = f.ctx.on("agent/disposed", ({ agent }) => { if (agent === reader) { remove(); resolve(); } }, { global: true });
    });
    f.release(reader); await disposed;
    const beforeWake = f.adapter.calls.filter(call => call.sessionId === reader.id).length;
    const assigned = task(await invoke(root, "team_task_update", { task_id: report.id, expected_revision: report.revision, action: "reassign", owner: reader.id }));
    assert.equal(assigned.status, "in_progress"); assert.equal(f.teams.getTask(root, report.id).ownerId, reader.id);
    assert.equal(f.agents.get(reader.id), undefined);
    assert.equal(f.adapter.calls.filter(call => call.sessionId === reader.id).length, beforeWake);
    failure(await invoke(foreign, "team_task_get", { task_id: report.id }), "TEAM_TASK_NOT_FOUND");
    failure(await invoke(root, "team_task_update", { task_id: report.id, expected_revision: assigned.revision, action: "reassign", owner: foreign.id }), "TEAM_MEMBER_NOT_FOUND");
    assert.equal(f.teams.getTask(root, report.id).revision, assigned.revision);
    f.hold(reader);
    assert.ok(!(await invoke(root, "send_message", { agent: reader.id, message: `Read task ${report.id}; it is already assigned` })).isError);
    const resumed = f.agents.get(reader.id); assert.ok(resumed); await f.entered(resumed);
    assert.ok(f.adapter.calls.filter(call => call.sessionId === reader.id).length > beforeWake);
    const owned = task(await invoke(resumed, "team_task_get", { task_id: report.id })); assert.equal(owned.status, "in_progress");
    const beforeReadonly = f.teams.listTasks(root);
    failure(await invoke(resumed, "team_task_update", { task_id: report.id, expected_revision: owned.revision, action: "complete" }));
    const deniedPath = join(f.profileDir, "readonly-report.txt");
    failure(await invoke(resumed, "write", { file_path: deniedPath, content: "Task ownership is not write permission" }));
    failure(await invoke(resumed, "dsmm_category", { category: "dsmm-coding", description: "Task owner cannot delegate", prompt: "Must refuse" }));
    assert.equal(existsSync(deniedPath), false); assert.deepEqual(f.teams.listTasks(root), beforeReadonly);
    let waitSettled = false;
    const waiting = invoke(resumed, "wait_agent", { timeout_ms: 10000 }).then(result => { waitSettled = true; return result; });
    const edited = task(await invoke(root, "team_task_update", { task_id: report.id, expected_revision: owned.revision, action: "edit", description: "Root records updated task details" }));
    assert.equal(waitSettled, false); assert.equal(resumed.inbox.nextStep.length, 0);
    assert.ok(!(await invoke(root, "send_message", { agent: resumed.id, message: "Read the updated task details" })).isError);
    const waited = await waiting; assert.ok(!waited.isError, JSON.stringify(waited)); assert.deepEqual(waited.value, { timedOut: false });
    assert.ok(!(await invoke(root, "interrupt_agent", { agent: resumed.id })).isError);
    await resumed.whenIdle();
    assert.equal(f.teams.getTask(root, report.id).ownerId, resumed.id);
    const completed = task(await invoke(root, "team_task_update", { task_id: report.id, expected_revision: edited.revision, action: "complete" }));
    assert.equal(completed.status, "completed");
    const projected = f.ctx.sessionProjections.snapshot(root.session).values as unknown as { agentTeam: { enabled: boolean; tasks: Task[] } };
    assert.equal(projected.agentTeam.enabled, true);
    assert.deepEqual(projected.agentTeam.tasks.map(row => [row.id, row.status, row.revision]), f.teams.listTasks(root).map(row => [row.id, row.status, row.revision]));
  } finally { await f.dispose(); }
});

test("native Team tools retain conditional registration and inherited filters across off-on-off", { skip: unavailable, timeout: 20000 }, async () => {
  const f = await teamFixture();
  try {
    const root = await f.create({ agentPreset: "dsmm-orchestrator" });
    assert.equal(f.teams.isEnabled(root), false);
    await runFixtureTurn(root);
    assert.deepEqual(f.adapter.calls.filter(call => call.sessionId === root.id).at(-1)?.tools?.filter(tool => taskNames.includes(tool.name)) ?? [], []);
    const reader = await member(root, "dsmm-code-search"), writer = await member(root, "dsmm-coding");
    const removeDeny = root.ctx.tools.restrict({ deny: ["team_task_get"] });
    const filtered = await member(root, "dsmm-code-search"); removeDeny();
    await Promise.all([f.entered(reader), f.entered(writer), f.entered(filtered)]);
    const definition = root.ctx.tools.get("team_task_list", root); assert.ok(definition);
    assert.equal(reader.ctx.tools.get("team_task_list", reader) === definition, true);
    assert.ok(readDelegationCeiling(reader.session)?.allow?.includes("team_task_get"));
    assert.equal(readDelegationCeiling(filtered.session)?.allow?.includes("team_task_get"), false);
    for (const agent of [root, reader, writer, filtered]) assert.deepEqual(await names(agent), []);
    failure(await invoke(reader, "team_task_list"), "UNKNOWN_TOOL");
    await assert.rejects(f.teams.setEnabled(reader, true), { code: "TEAM_LEAD_REQUIRED" });
    await f.teams.setEnabled(root, true);
    await runFixtureTurn(root);
    assert.deepEqual(f.adapter.calls.filter(call => call.sessionId === root.id).at(-1)?.tools?.map(tool => tool.name).filter(name => taskNames.includes(name)).sort(), [...taskNames].sort());
    assert.deepEqual((await names(root)).sort(), [...taskNames].sort());
    assert.deepEqual((await names(writer)).sort(), [...taskNames].sort());
    assert.deepEqual((await names(reader)).sort(), ["team_task_get", "team_task_list"]);
    assert.deepEqual(await names(filtered), ["team_task_list"]);
    assert.equal(reader.ctx.tools.get("team_task_list", reader) === definition, true);
    failure(await invoke(reader, "team_task_list", {}, undefined, false), "UNKNOWN_TOOL");
    const created = task(await invoke(root, "team_task_create", { subject: "Inspect shared task", description: "Read the task without changing its board" }));
    assert.equal(task(await invoke(reader, "team_task_get", { task_id: created.id })).revision, 1);
    assert.ok(!(await invoke(reader, "team_task_list")).isError);
    failure(await invoke(filtered, "team_task_get", { task_id: created.id }));
    const board = f.teams.listTasks(root);
    failure(await invoke(reader, "team_task_create", { subject: "Forbidden readonly mutation", description: "Must not append" }));
    failure(await invoke(reader, "team_task_update", { task_id: created.id, expected_revision: 1, action: "claim" }));
    assert.deepEqual(f.teams.listTasks(root), board);
    const admittedWhileOn = await step(writer);
    try {
      await f.teams.setEnabled(root, false);
      await runFixtureTurn(root);
      assert.deepEqual(f.adapter.calls.filter(call => call.sessionId === root.id).at(-1)?.tools?.filter(tool => taskNames.includes(tool.name)) ?? [], []);
      for (const agent of [root, reader, writer, filtered]) assert.deepEqual(await names(agent), []);
      failure(await invoke(writer, "team_task_create", { subject: "Disabled", description: "Must not append" }), "UNKNOWN_TOOL");
      failure(await invoke(writer, "team_task_create", { subject: "Previously admitted", description: "Native mode check still applies" }, admittedWhileOn), "TEAM_DISABLED");
      failure(await invoke(writer, "team_task_update", { task_id: created.id, expected_revision: 1, action: "claim" }, undefined, false), "UNKNOWN_TOOL");
      assert.equal(reader.ctx.tools.get("team_task_list", reader) === definition, true);
      assert.deepEqual(f.teams.projection.stateOf(root.session).tasks.map(row => [row.id, row.revision]), [[created.id, 1]]);
    } finally { admittedWhileOn.dispose(); }
  } finally { await f.dispose(); }
});
