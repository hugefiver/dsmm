import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import * as JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { CommandApprovals } from "../src/command-approval.ts";
import { importPermissionRules } from "../src/permission-rules.ts";
import type { NativeCommandEntry } from "../src/permission-settings.ts";
import { deferred, permissionFixture } from "./permission-fixture.ts";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";
useIsolatedDshEnvironment();

const command = "go test -count=1 .";
const entry = (id = "test"): NativeCommandEntry => ({ id, mode: "ask", sandboxMode: "workspace-write",
  match: { tool: "pwsh", commandPattern: "go test", workingDirectory: process.cwd() } });
const nativeCommands = (...entries: NativeCommandEntry[]) => ({ enabled: true, entries });
const rules = (...ids: string[]) => importPermissionRules(ids.map(id => ({ id, action: "ask" as const,
  match: { kind: "shell" as const, executable: "pwsh.exe", command, workingDirectory: process.cwd() } })), "owned-test", 1);

test("native command memory matches rule parameters without synthesizing a new same-level native target", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: nativeCommands(entry()) } });
  try {
    await f.mountManagedShell();
    assert.equal((await f.execute(command)).isError, false);
    assert.equal((await f.execute("go test -count=2 ./other")).isError, false);
    assert.equal(f.nativeAnswers(), 1); assert.equal(f.starts(), 2);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
    assert.equal((await f.execute(command, { sandbox_permissions: "danger-full-access", justification: "Independent native request" })).isError, false);
    assert.equal(f.nativeAnswers(), 2);
    f.setPolicy("never"); assert.equal((await f.execute(command)).isError, true); assert.equal(f.starts(), 3);
  } finally { await f.dispose(); }
});

test("all overlapping command and exact shell asks contribute, while shell matching stays exact", async () => {
  const f = await permissionFixture(2000, { settings: { rules: rules("shell-a", "shell-b"), nativeCommands: nativeCommands(entry("entry-a"), entry("entry-b")) } });
  try {
    await f.mountManagedShell(); assert.equal((await f.execute(command)).isError, false);
    for (const id of ["shell-a", "shell-b", "entry-a", "entry-b"]) assert.equal(f.requests[0].reason?.includes(id), true);
    assert.equal((await f.execute(command)).isError, false);
    assert.equal((await f.execute("go test -count=3 .")).isError, false); assert.equal(f.nativeAnswers(), 1);
    await f.update({ rules: rules("shell-c"), nativeCommands: nativeCommands(entry("entry-a"), entry("entry-b")) });
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 2);
    await f.update({ rules: rules("shell-a", "shell-b"), nativeCommands: nativeCommands(entry("entry-a"), entry("entry-b")) });
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 3);
  } finally { await f.dispose(); }
});

test("shell-only no-target approvals are remembered but independent downstream ask and deny remain authoritative", async () => {
  const f = await permissionFixture(2000, { settings: { rules: rules("shell") } });
  try {
    await f.mountManagedShell();
    assert.equal((await f.execute(command)).isError, false); assert.equal((await f.execute(command)).isError, false);
    assert.equal(f.nativeAnswers(), 1);
    const removeAsk = f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Third-party request" }; }, { global: true });
    f.setOutcome("rejected"); assert.equal((await f.execute(command)).isError, true); assert.equal(f.nativeAnswers(), 2); removeAsk();
    const removeDeny = f.ctx.on("tools/pre-execute", async () => ({ kind: "deny", reason: "Third-party deny" }), { global: true });
    assert.equal((await f.execute(command)).isError, true); assert.equal(f.nativeAnswers(), 2); removeDeny();
    f.setPureDenied(true); assert.equal((await f.execute(command)).isError, true); assert.equal(f.starts(), 2);
  } finally { await f.dispose(); }
});

test("only the complete approval service outcome can create command memory", async t => {
  for (const failure of ["outer-reject", "cancel", "audit", "outer-pre-deny"] as const) await t.test(failure, async () => {
    const f = await permissionFixture(2000, { settings: { rules: rules("shell") } });
    try {
      await f.mountManagedShell();
      const append = f.root.session.append.bind(f.root.session);
      let remove = () => {};
      if (failure === "outer-reject") remove = f.ctx.on("approval/request", async (_request, next) => { await next(); return "rejected"; }, { global: true, prepend: true });
      if (failure === "cancel") f.setOutcome("cancelled");
      if (failure === "audit") f.root.session.append = ((...args: Parameters<typeof append>) => {
        if (args[0] === "approval/decided") throw new Error("audit unavailable");
        return Reflect.apply(append, f.root.session, args);
      }) as typeof append;
      if (failure === "outer-pre-deny") remove = f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "deny", reason: "Independent denial" }; }, { global: true, prepend: true });
      assert.equal((await f.execute(command)).isError, true); assert.equal(f.starts(), 0);
      remove(); f.root.session.append = append; f.setOutcome("allowed-once");
      assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 2);
      assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 2);
    } finally { await f.dispose(); }
  });
});

test("pending policy changes retain native once execution but cannot seed the new source generation", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: nativeCommands(entry()) } });
  const ready = deferred<void>(), release = deferred<"allowed-once">();
  try {
    await f.mountManagedShell();
    f.setAnswer(async request => { ready.resolve(); await release.promise; assert.equal(request.signal?.aborted, false); return "allowed-once"; });
    const pending = f.execute(command); await ready.promise;
    await f.update({ nativeCommands: nativeCommands(entry("replacement")) });
    await f.update({ nativeCommands: nativeCommands(entry()) });
    release.resolve("allowed-once"); assert.equal((await pending).isError, false);
    f.setAnswer(undefined); assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 2);
  } finally { release.resolve("allowed-once"); await f.dispose(); }
});

test("Agent, registration, and owner generation boundaries never share a rule grant", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: nativeCommands(entry()) } });
  try {
    let mounted = await f.mountManagedShell(); assert.equal((await f.execute(command)).isError, false);
    const child = await f.create(f.root), sibling = await f.create(f.root);
    assert.equal((await f.execute(command, {}, undefined, undefined, child)).isError, false);
    assert.equal((await f.execute(command, {}, undefined, undefined, sibling)).isError, false); assert.equal(f.nativeAnswers(), 3);
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 3);
    const authority = f.authorities.get(f.root)!;
    f.authorities.set(f.root, { ...authority, ownerGeneration: 2 });
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 4);
    await mounted.dispose(); mounted = await f.mountManagedShell();
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 5);
  } finally { await f.dispose(); }
});

test("cold native resume of the same session ID cannot inherit a disposed Agent's rule approval", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: nativeCommands(entry()) } });
  try {
    await f.ctx.plugin(JsonlSessionPersistence, { root: join(process.env.DSH_HOME!, "command-memory-sessions"), compression: "none" }).await();
    await f.mountManagedShell();
    const original = await f.create(), session = original.session, authority = f.authorities.get(original)!;
    const execute = (agent: typeof original) => f.execute(command, {}, undefined, undefined, agent);
    assert.equal((await execute(original)).isError, false);
    assert.equal((await execute(original)).isError, false); assert.equal(f.nativeAnswers(), 1); assert.equal(f.starts(), 2);
    await f.disposeAgent(original); assert.equal(f.ctx.agents.get(original.id), undefined);
    const restored = await f.ctx.agents.resume({ resumeSessionId: session.id,
      agentOptions: { provider: "unused-local", model: "unused-local" } });
    try {
      const agent = restored.agent;
      assert.equal(agent.id, original.id); assert.equal(agent.session.id, session.id);
      assert.notEqual(agent, original); assert.notEqual(agent.session, session);
      assert.ok(agent.session.snapshotEvents().some(event => event.type === "approval/decided"));
      f.authorities.set(agent, { ...authority, agent, root: agent });
      agent.session.append("turn/start", { turn: 2 });
      f.setOutcome("rejected");
      assert.equal((await execute(agent)).isError, true); assert.equal(f.nativeAnswers(), 2); assert.equal(f.starts(), 2);
      f.setOutcome("allowed-once");
      assert.equal((await execute(agent)).isError, false); assert.equal(f.nativeAnswers(), 3); assert.equal(f.starts(), 3);
      assert.equal((await execute(agent)).isError, false); assert.equal(f.nativeAnswers(), 3); assert.equal(f.starts(), 4);
    } finally { await restored.dispose(); }
  } finally { await f.dispose(); }
});

test("a cached call cannot transfer approval to another managed registration after the guard", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: nativeCommands(entry()) } });
  try {
    let mounted = await f.mountManagedShell();
    const original = f.ctx.tools.get("pwsh", f.root);
    assert.equal((await f.execute(command)).isError, false);
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 1); assert.equal(f.starts(), 2);
    const remove = f.ctx.on("tools/execute", async (_exec, next) => {
      await mounted.dispose(); mounted = await f.mountManagedShell();
      assert.notEqual(f.ctx.tools.get("pwsh", f.root), original);
      assert.equal(f.controller.coverage(f.root).some(tool => tool.name === "pwsh"), true);
      return next();
    }, { global: true });
    try { assert.equal((await f.execute(command)).isError, true); assert.equal(f.nativeAnswers(), 1); assert.equal(f.starts(), 2); }
    finally { remove(); }
    f.setOutcome("rejected");
    assert.equal((await f.execute(command)).isError, true); assert.equal(f.nativeAnswers(), 2); assert.equal(f.starts(), 2);
    f.setOutcome("allowed-once");
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 3); assert.equal(f.starts(), 3);
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 3); assert.equal(f.starts(), 4);
  } finally { await f.dispose(); }
});

test("memory never answers a later widening request", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: nativeCommands({ ...entry(), sandboxMode: "danger-full-access" }) } });
  try {
    await f.mountManagedShell(); assert.equal((await f.execute(command)).isError, false);
    assert.equal((await f.execute("go test -count=2 .")).isError, false); assert.equal(f.nativeAnswers(), 2);
    assert.equal(f.requests[0].reason?.includes("native-command:test"), true);
    assert.equal(f.requests[1].reason?.includes("native-command:test"), false);
    f.setOutcome("rejected"); assert.equal((await f.execute(command)).isError, true); assert.equal(f.starts(), 2);
  } finally { await f.dispose(); }
});

test("a replaced token cannot borrow another live managed call binding", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: nativeCommands(entry()) } });
  const executions: Readonly<ToolExecution>[] = [], ready = deferred<void>(), release = deferred<"allowed-once">();
  try {
    await f.mountManagedShell();
    f.ctx.on("tools/pre-execute", async (exec, next) => { executions.push(exec); return next(); }, { global: true, prepend: true });
    f.setAnswer(async () => { if (f.nativeAnswers() === 2) ready.resolve(); return release.promise; });
    const first = f.execute(command), second = f.execute("go test -count=2 ."); await ready.promise;
    Reflect.set(executions[0], "token", executions[1].token); release.resolve("allowed-once");
    assert.equal((await first).isError, true); assert.equal((await second).isError, false); assert.equal(f.starts(), 1);
  } finally { release.resolve("allowed-once"); await f.dispose(); }
});

test("cached managed invocations retain the original exec binding after the guard", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: nativeCommands(entry()) } });
  const executions: Readonly<ToolExecution>[] = [], ready = deferred<void>(), release = deferred<void>();
  try {
    await f.mountManagedShell(); assert.equal((await f.execute(command)).isError, false);
    f.ctx.on("tools/execute", async (exec, next) => {
      executions.push(exec); if (executions.length === 2) ready.resolve(); await release.promise; return next();
    }, { global: true });
    const first = f.execute(command), second = f.execute("go test -count=2 ."); await ready.promise;
    Reflect.set(executions[0], "token", executions[1].token); release.resolve();
    assert.equal((await first).isError, true); assert.equal((await second).isError, false);
    assert.equal(f.starts(), 2); assert.equal(f.nativeAnswers(), 1);
  } finally { release.resolve(); await f.dispose(); }
});

test("generic guard-owned memory works without managed provenance and rejects changed cached-call identity", async () => {
  const f = await permissionFixture(2000, { settings: { enabled: false } });
  try {
    const memory = new CommandApprovals(f.ctx);
    let starts = 0;
    f.ctx.tools.register({ name: "plain-command", description: "Count a generic invocation", parameters: { type: "object", properties: {} },
      output: { schema: { type: "object", properties: {} }, render: () => [] }, execute: async () => { starts++; return {}; } });
    f.ctx.on("tools/pre-execute", async (exec, next) => {
      if (exec.name !== "plain-command") return next();
      return memory.decide(exec, memory.capture(exec, [{ kind: "git", semantics: { id: "test-action", cwd: process.cwd() } }]), next, "Owned command rule");
    }, { global: true });
    const run = () => f.execute(command, {}, undefined, undefined, f.root, "plain-command");
    const removeDenial = f.ctx.tools.guard(() => "Independent guard denial");
    assert.equal((await run()).isError, true); assert.equal(starts, 0); removeDenial();
    assert.equal((await run()).isError, false); assert.equal((await run()).isError, false); assert.equal(f.nativeAnswers(), 2);
    const remove = f.ctx.on("tools/pre-execute", async (exec, next) => { const result = await next(); Reflect.set(exec, "arguments", { command: "different" }); return result; }, { global: true, prepend: true });
    assert.equal((await run()).isError, true); assert.equal(starts, 2); remove();
    memory.invalidate(); assert.equal((await run()).isError, false); assert.equal(f.nativeAnswers(), 3);
    f.setPolicy("never"); assert.equal((await run()).isError, true); assert.equal(starts, 3);
  } finally { await f.dispose(); }
});

test("exact Agent memory clearing preserves once calls and prevents late captures from reseeding without retiring other roots", async () => {
  const f = await permissionFixture(2000, { settings: { enabled: false } });
  try {
    const memory = new CommandApprovals(f.ctx), other = await f.create();
    const rule = { kind: "git" as const, semantics: { id: "exact-clear" } };
    let rootRule = rule;
    let last: Readonly<ToolExecution> | undefined;
    f.ctx.tools.register({ name: "clear-command", description: "Counter-only exact memory boundary", parameters: {},
      output: { schema: { type: "string" }, render: () => [] }, async execute() { return "completed"; } });
    f.ctx.on("tools/pre-execute", async (exec, next) => {
      if (exec.name !== "clear-command") return next();
      last = exec;
      return memory.decide(exec, memory.capture(exec, [exec.agent === f.root ? rootRule : rule]), next, "Exact command rule");
    }, { global: true });
    const run = (agent = f.root) => f.execute(command, {}, undefined, undefined, agent, "clear-command");
    assert.equal((await run()).isError, false); assert.equal((await run(other)).isError, false);
    assert.equal((await run()).isError, false); assert.equal(f.nativeAnswers(), 2);
    const old = last!;
    rootRule = { kind: "git", semantics: { id: "late-capture" } };
    const late = memory.capture(old, [rootRule])!;
    assert.equal(late.missing.length, 1);
    memory.clearAgent(f.root);
    assert.doesNotThrow(() => late.resolved("allowed-once"));
    assert.doesNotThrow(() => late.assertCurrent(), "non-retirement clearing must not cancel an authorized once call");
    memory.commit(old); memory.finish(old);
    assert.equal((await run()).isError, false); assert.equal(f.nativeAnswers(), 3, "old capture must not repopulate cleared memory");
    assert.equal((await run()).isError, false); assert.equal((await run(other)).isError, false);
    assert.equal(f.nativeAnswers(), 3, "new captures work and another root retains its memory");
  } finally { await f.dispose(); }
});
