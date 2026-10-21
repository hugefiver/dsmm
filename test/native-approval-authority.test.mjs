import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeRootLlmFixture, loadNative } from "./native-root-llm-fixture.mjs";

const unavailable = process.platform !== "win32" || !process.env.DSMM_TEST_DSH_ENTRY;
const quoted = value => `'${value.replaceAll("'", "''")}'`;
const rule = (command, workingDirectory) => ({ id: "owned-blacklist", action: "deny", match: {
  kind: "shell", executable: "unresolved-native-pwsh", command, workingDirectory,
}, source: { kind: "user-import", label: "owned native approval fixture" }, revision: 1, revoked: false });

async function caller(f, agent) {
  const { ToolCallId } = await loadNative("@deepseek-ai/dsh-llm");
  return (command, extra = {}) => f.ctx.tools.execute({ name: "pwsh", arguments: {
    command, description: "Execute an owned native approval fixture", workdir: f.workspace, timeoutMs: 10000, ...extra,
  }, agent, callId: ToolCallId(randomUUID()), signal: new AbortController().signal });
}

test("actual Root full access keeps ordinary unknown and Git calls native while exact configured deny remains pre-approval", { skip: unavailable, timeout: 45000 }, async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: true }, {
    migrateShell: true, approvalPolicy: "ask",
    globalConfig: { permissionControl: { outsideReads: "ask", nativeCommands: { enabled: false } } },
  });
  const { setSandboxMode } = await loadNative("@deepseek-ai/dsh-sandbox-policy");
  const agent = await f.create(); agent.session.append("turn/start", { turn: 1 });
  setSandboxMode(agent.session, "danger-full-access");
  let approvals = 0;
  f.ctx.on("approval/request", async () => { approvals++; return "allowed-once"; }, { global: true });
  const execute = await caller(f, agent), outside = join(f.root, "outside");
  await mkdir(outside);
  const marker = join(outside, "full-access.txt");
  const command = `Set-Content -LiteralPath ${quoted(marker)} -Value owned-full; Get-Content -LiteralPath ${quoted(marker)}`;
  const result = await execute(command);
  assert.equal(result.value?.exitCode, 0, JSON.stringify(result));
  assert.equal((await readFile(marker, "utf8")).trim(), "owned-full");
  assert.equal(approvals, 0);
  // Dry-run in the owned non-repository directory exercises the Git guard without a write.
  const git = await execute("git commit --dry-run --porcelain");
  assert.equal(typeof git.value?.exitCode, "number", JSON.stringify(git));
  assert.equal(approvals, 0);
  const blocked = join(outside, "blocked.txt"), denied = `Set-Content -LiteralPath ${quoted(blocked)} -Value forbidden`;
  await writeFile(join(f.home, "plugins", "dsmm", "config.json"), JSON.stringify({ permissionControl: {
    outsideReads: "ask", rules: [rule(denied, f.workspace)],
  } }));
  assert.equal((await execute(denied)).isError, true);
  assert.equal(existsSync(blocked), false); assert.equal(approvals, 0);
  assert.equal(f.bodies.length, 0);
});

test("actual Root honors a later native Allow after a pending source change exactly once without widening standing policy", { skip: unavailable, timeout: 45000 }, async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: true }, { migrateShell: true, approvalPolicy: "ask" });
  const { setSandboxMode } = await loadNative("@deepseek-ai/dsh-sandbox-policy");
  const agent = await f.create(); agent.session.append("turn/start", { turn: 1 });
  setSandboxMode(agent.session, "workspace-write");
  const outside = join(f.root, "outside"); await mkdir(outside);
  const marker = join(outside, "allowed-once.txt"), command = `Set-Content -LiteralPath ${quoted(marker)} -Value approved`;
  const nativeCommands = { enabled: true, entries: [{ id: "owned-once", mode: "ask", sandboxMode: "danger-full-access", match: {
    tool: "pwsh", executable: "Set-Content", args: ["-LiteralPath", marker, "-Value", "approved"], workingDirectory: f.workspace,
  } }] };
  const source = join(f.home, "plugins", "dsmm", "config.json");
  await mkdir(join(f.home, "plugins", "dsmm"), { recursive: true });
  await writeFile(source, JSON.stringify({ permissionControl: { nativeCommands } }));
  const entered = Promise.withResolvers(), choice = Promise.withResolvers(); let approvals = 0;
  f.ctx.on("approval/request", async () => { approvals++; entered.resolve(); return choice.promise; }, { global: true });
  const execute = await caller(f, agent), pending = execute(command);
  try {
    await Promise.race([entered.promise, pending.then(result => { throw new Error(`Tool settled before native approval: ${JSON.stringify(result)}`); })]);
    await writeFile(source, JSON.stringify({ permissionControl: { nativeCommands, rules: [rule(command, f.workspace)] } }));
    choice.resolve("allowed-once");
    const allowed = await pending;
    assert.equal(allowed.value?.exitCode, 0, JSON.stringify(allowed));
    assert.equal((await readFile(marker, "utf8")).trim(), "approved");
    assert.equal(approvals, 1);
    assert.equal(f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, "workspace-write");
    await rm(marker);
    assert.equal((await execute(command)).isError, true);
    assert.equal(existsSync(marker), false); assert.equal(approvals, 1);
    assert.equal(f.bodies.length, 0);
  } finally { choice.resolve("cancelled"); await pending; }
});

test("actual Root combines its Git ask with official escalation without a command entry or a second approval", { skip: unavailable, timeout: 45000 }, async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: true }, {
    migrateShell: true, approvalPolicy: "ask", globalConfig: { permissionControl: { nativeCommands: { enabled: false } } },
  });
  const { setSandboxMode } = await loadNative("@deepseek-ai/dsh-sandbox-policy");
  const agent = await f.create(); agent.session.append("turn/start", { turn: 1 });
  setSandboxMode(agent.session, "workspace-write");
  const entered = Promise.withResolvers(), choice = Promise.withResolvers(); let approvals = 0;
  f.ctx.on("approval/request", async () => { approvals++; entered.resolve(); return choice.promise; }, { global: true });
  const execute = await caller(f, agent), command = "git commit --dry-run --porcelain";
  const escalation = { sandbox_permissions: "danger-full-access", justification: "Use the exact native full-access target for this owned dry run" };
  const pending = execute(command, escalation);
  try {
    await Promise.race([entered.promise, pending.then(result => { throw new Error(`Tool settled before native approval: ${JSON.stringify(result)}`); })]);
    await writeFile(join(f.home, "plugins", "dsmm", "config.json"), JSON.stringify({ permissionControl: {
      nativeCommands: { enabled: false }, rules: [rule(command, f.workspace)],
    } }));
    choice.resolve("allowed-once");
    const result = await pending;
    assert.equal(result.value?.kind, "foreground", JSON.stringify(result));
    assert.equal(result.value.sandbox?.mode, "danger-full-access");
    assert.equal(approvals, 1);
    assert.equal(f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, "workspace-write");
    assert.equal((await execute(command, escalation)).isError, true);
    assert.equal(approvals, 1); assert.equal(f.bodies.length, 0);
  } finally { choice.resolve("cancelled"); await pending; }
});
