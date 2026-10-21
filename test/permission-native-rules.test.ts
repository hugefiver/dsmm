import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat, rm, symlink } from "node:fs/promises";
import { join, resolve, relative, sep, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmRuntime, ToolCallId } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import * as NativeFs from "@deepseek-ai/dsh-tool-fs";
import * as NativeSearch from "@deepseek-ai/dsh-tool-fs-search";
import * as NativePwsh from "@deepseek-ai/dsh-tool-pwsh";
import { registerNativePermissionRules } from "../src/permission-native-rules.ts";
import type { NativePermissionToolIdentity, NativePermissionFsTarget } from "../src/permission-native-rules.ts";
import { resolvePermissionControl } from "../src/permission-settings.ts";
import type { PermissionControlSchemaInput } from "../src/permission-settings.ts";
import { PermissionRulesRuntimeSync, importPermissionRules } from "../src/permission-rules.ts";
import { parsePermissionShellReadPaths } from "../src/permission-shell.ts";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";

useIsolatedDshEnvironment();
const sdk = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-tools"));
const { ApprovalService, setApprovalPolicy } = await import(pathToFileURL(sdk.resolve("@deepseek-ai/dsh-user-approval")).href);
const { FileSystem } = await import(pathToFileURL(sdk.resolve("@deepseek-ai/dsh-fs")).href);
const WorkingDirectory = await import(pathToFileURL(sdk.resolve("@deepseek-ai/dsh-working-directory")).href);

async function nativeFixture(policy: PermissionControlSchemaInput = {}, fullAccess = false) {
  assert.ok(existsSync(tmpdir()));
  const directory = await mkdtemp(join(tmpdir(), "dsmm-native-rules-")), workspace = join(directory, "workspace"), outside = join(directory, "outside");
  await mkdir(workspace); await mkdir(outside);
  await writeFile(join(workspace, "inside.txt"), "needle inside 中文"); await writeFile(join(outside, "outside.txt"), "needle outside 中文");
  const ctx = new Context(), identities = new Map<ToolDefinition, NativePermissionToolIdentity>();
  const processPaths = new Map<unknown, string>(), targets = new Map<string, NativePermissionFsTarget>();
  let reads = 0, spawns = 0, approvals = 0, colocated = true;
  let outcome: "allowed-once" | "rejected" | "cancelled" | "unavailable" = "allowed-once";
  let answer: (() => Promise<typeof outcome>) | undefined;
  let handle: Awaited<ReturnType<Context["agents"]["create"]>> | undefined;
  class OwnedFs extends FileSystem {
    async resolve(path: string, options: { cwd?: string; signal?: AbortSignal } = {}) {
      options.signal?.throwIfAborted(); const canonical = await realpath(resolve(options.cwd ?? workspace, path)); options.signal?.throwIfAborted();
      let target = targets.get(canonical);
      if (target === undefined) { target = { targetKey: randomUUID(), displayPath: canonical }; targets.set(canonical, target); processPaths.set(target.targetKey, canonical); }
      return target;
    }
    contains(parent: NativePermissionFsTarget, child: NativePermissionFsTarget) { const path = relative(processPaths.get(parent.targetKey)!, processPaths.get(child.targetKey)!); return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); }
    processPath(target: NativePermissionFsTarget) { return processPaths.get(target.targetKey)!; }
    async stat(target: NativePermissionFsTarget) { const info = await stat(this.processPath(target)); return { type: info.isDirectory() ? "directory" : "file", size: info.size, version: String(info.mtimeMs) }; }
    async readText(target: NativePermissionFsTarget) { reads++; return readFile(this.processPath(target), "utf8"); }
    async *streamText(target: NativePermissionFsTarget) { yield await this.readText(target); }
    async writeText() { throw new Error("owned readonly backend"); }
    async editText() { throw new Error("owned readonly backend"); }
  }
  try {
    await Promise.all([ctx.plugin(AgentRegistry).await(), ctx.plugin(SessionStore).await(), ctx.plugin(SessionProjectionRegistry).await(), ctx.plugin(LlmRuntime).await(), ctx.plugin(SystemPrompt, {}).await()]);
    await ctx.plugin(ToolRuntime, { mode: "native" }).await(); await ctx.plugin(OwnedFs).await();
    await ctx.plugin(WorkingDirectory.default, { defaultDirectory: workspace }).await(); await ctx.plugin(ApprovalService, { policy: "ask" }).await();
    if (fullAccess) ctx.provide("sandboxPolicy", { resolve() { return { mode: "danger-full-access", workspaceRoot: workspace }; } });
    ctx.provide("subprocess", { spawn(request: { argv: string[]; cwd: string; signal: AbortSignal }) {
      assert.equal(request.cwd, workspace); assert.equal(request.argv[1], "--no-config"); assert.equal(request.argv.some(arg => arg.startsWith("--pre")), false);
      const path = request.argv.indexOf("--");
      if (path !== -1) { const resolved = resolve(workspace, request.argv[path + 1]); assert.ok(resolved.startsWith(`${directory}${sep}`)); }
      request.signal.throwIfAborted(); spawns++;
      let stdout = "", stderr = "";
      const done = new Promise<{ exitCode: number; signal: null }>((yes, no) => {
        const child = spawn(request.argv[0], request.argv.slice(1), { cwd: workspace, signal: request.signal, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
        child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
        child.once("error", no); child.once("close", (code, signal) => {
          if (signal !== null || code === null) no(new Error("owned rg process failed"));
          else yes({ exitCode: code, signal: null });
        });
      });
      return { done, collected: { stdout: { readFrom: () => ({ text: stdout, lossy: false }) }, stderr: { readFrom: () => ({ text: stderr, lossy: false }) } } };
    } });
    await ctx.plugin(NativeFs, {}).await(); await ctx.plugin(NativeSearch, { sampleOverCapGlobResults: false }).await();
    for (const kind of ["read", "glob", "grep"] as const) identities.set(ctx.tools.get(kind)!, { kind, context: ctx, assertCurrent() {}, coLocated() { return colocated; } });
    ctx.on("approval/request", async () => { approvals++; return answer === undefined ? outcome : answer(); }, { global: true });
    const sync = new PermissionRulesRuntimeSync({ revision: "source:initial", policy: resolvePermissionControl(policy) }, () => {});
    registerNativePermissionRules(ctx, { runtime: sync, identify: definition => identities.get(definition), assertCurrent() {} });
    await ctx.plugin(AgentLoop, {}).await();
    handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: workspace }, agentOptions: { provider: "unused-owned", model: "unused-owned" } });
    const root = handle.agent; root.session.append("turn/start", { turn: 1 });
    const execute = (name: string, args: unknown, signal = new AbortController().signal) => ctx.tools.execute({ callId: ToolCallId(randomUUID()), name, arguments: args, signal, agent: root });
    const update = async (policy: PermissionControlSchemaInput) => { const revision = sync.status().savedRevision, ticket = sync.begin(revision); return sync.commit(ticket, { revision: randomUUID(), policy: resolvePermissionControl(policy) }, async () => {}); };
    return { ctx, root, workspace, outside, directory, identities, sync, execute, update, reads: () => reads, spawns: () => spawns, approvals: () => approvals,
      setOutcome(value: typeof outcome) { outcome = value; }, setAnswer(value: typeof answer) { answer = value; }, setColocated(value: boolean) { colocated = value; },
      setNever() { setApprovalPolicy(root.session, "never"); },
      async dispose() { await handle?.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true }); } };
  } catch (error) { await handle?.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true }); throw error; }
}

test("stock native read inherits outside reads, and allow/ask/deny use actual file_path without write permission", async () => {
  const f = await nativeFixture();
  try {
    assert.equal((await f.execute("read", { file_path: join(f.outside, "outside.txt") })).isError, false); assert.equal(f.approvals(), 0);
    await f.update({ outsideReads: "deny" });
    assert.equal((await f.execute("read", { file_path: "inside.txt" })).isError, false);
    assert.equal((await f.execute("read", { file_path: "../outside/outside.txt" })).isError, true); assert.equal(f.reads(), 2);
    await f.update({ outsideReads: "ask" });
    assert.equal((await f.execute("read", { file_path: "../outside/outside.txt" })).isError, false); assert.equal(f.approvals(), 1);
    f.setOutcome("rejected"); assert.equal((await f.execute("read", { file_path: join(f.outside, "outside.txt") })).isError, true); assert.equal(f.reads(), 3);
    await f.update({ outsideReads: "allow" });
    assert.equal((await f.execute("read", { file_path: join(f.outside, "outside.txt") })).isError, false);
    assert.equal((await f.execute("write", { file_path: join(f.outside, "outside.txt"), content: "overwrite" })).isError, true);
    assert.equal((await f.execute("edit", { file_path: join(f.outside, "outside.txt"), old_string: "needle", new_string: "modified" })).isError, true);
    assert.equal(await readFile(join(f.outside, "outside.txt"), "utf8"), "needle outside 中文");
  } finally { await f.dispose(); }
});

test("native glob/grep enforce real search roots at direct packaged-rg spawn and require backend co-location", async () => {
  const f = await nativeFixture({ outsideReads: "deny" });
  try {
    assert.equal((await f.execute("glob", { pattern: "*.txt" })).isError, false);
    assert.equal((await f.execute("grep", { pattern: "中文", include: "*.{txt,md}" })).isError, false); assert.equal(f.spawns(), 2);
    assert.equal((await f.execute("grep", { pattern: "needle", path: "../outside", cwd: f.workspace, flags: "--pre=untrusted" })).isError, true); assert.equal(f.spawns(), 2);
    assert.equal((await f.execute("glob", { pattern: "*.txt", path: "../outside" })).isError, true);
    assert.equal((await f.execute("grep", { pattern: "needle", path: join(f.outside, "outside.txt") })).isError, true); assert.equal(f.spawns(), 2);
    await f.update({ outsideReads: "allow" });
    assert.equal((await f.execute("grep", { pattern: "needle", path: join(f.outside, "outside.txt") })).isError, false); assert.equal(f.spawns(), 3);
    f.setColocated(false); f.setOutcome("rejected");
    assert.equal((await f.execute("glob", { pattern: "*.txt" })).isError, true); assert.equal(f.spawns(), 3); assert.equal(f.approvals(), 1);
  } finally { await f.dispose(); }
});
test("standing full access bypasses outside asks and unknown path facts, retaining only definite outside blacklist matches", async () => {
  const f = await nativeFixture({ outsideReads: "ask", nativeCommands: { enabled: false } }, true);
  try {
    assert.equal((await f.execute("read", { file_path: "../outside/outside.txt" })).isError, false);
    f.setColocated(false);
    assert.equal((await f.execute("grep", { pattern: "needle", path: "../outside" })).isError, false);
    await f.update({ outsideReads: "deny" });
    assert.equal((await f.execute("glob", { pattern: "*.txt", path: "../outside" })).isError, false);
    const definition = f.ctx.tools.get("read")!, identity = f.identities.get(definition)!;
    const context = f.ctx.extend({ get: ((...args: Parameters<Context["get"]>) => args[0] === "fs" ? undefined : Reflect.apply(f.ctx.get, f.ctx, args)) as Context["get"] });
    f.identities.set(definition, { ...identity, context });
    assert.equal((await f.execute("read", { file_path: "../outside/outside.txt" })).isError, false);
    f.identities.set(definition, identity);
    assert.equal((await f.execute("read", { file_path: "../outside/outside.txt" })).isError, true);
    await f.update({ outsideReads: "deny", rules: importPermissionRules([{ id: "unresolved-rule", action: "deny", match: { kind: "outside-read", path: join(f.outside, "missing.txt"), scope: "exact" } }], "owned configuration", 1) });
    assert.equal((await f.execute("read", { file_path: "../outside/outside.txt" })).isError, true);
    assert.equal(f.approvals(), 0); assert.equal(f.reads(), 2); assert.equal(f.spawns(), 2);
  } finally { await f.dispose(); }
});
test("full access treats rule-only filesystem IO failures as unknown without losing a proved blacklist match", async t => {
  for (const code of ["EIO", "EACCES"] as const) await t.test(code, async () => {
    const f = await nativeFixture({}, true);
    const fs = f.ctx.get("fs"); assert.ok(fs); const originalResolve = fs.resolve.bind(fs);
    try {
      const target = join(f.outside, "outside.txt"), inaccessibleRule = join(f.outside, "policy-only.txt");
      fs.resolve = async (path: string, options: { cwd?: string; signal?: AbortSignal } = {}) => {
        if (path === inaccessibleRule) throw Object.assign(new Error("Owned rule-only path failure"), { code });
        return originalResolve(path, options);
      };
      const unknown = { id: "unresolved", action: "deny" as const, match: { kind: "outside-read" as const, path: inaccessibleRule, scope: "exact" as const } };
      await f.update({ rules: importPermissionRules([unknown], "owned configuration", 1) });
      const read = await f.execute("read", { file_path: target });
      assert.equal(read.isError, false, JSON.stringify(read)); assert.equal(f.reads(), 1); assert.equal(f.approvals(), 0);
      const proved = { id: "proved", action: "deny" as const, match: { kind: "outside-read" as const, path: target, scope: "exact" as const } };
      for (const rules of [[proved, unknown], [unknown, proved]]) {
        await f.update({ rules: importPermissionRules(rules, "owned configuration", 2) });
        assert.equal((await f.execute("read", { file_path: target })).isError, true); assert.equal(f.reads(), 1);
      }
    } finally { fs.resolve = originalResolve; await f.dispose(); }
  });
});
test("unresolved read facts cannot turn a relevant hard path deny into a once ask", async t => {
  for (const missing of ["fs", "colocation", "operands"] as const) await t.test(missing, async () => {
    const f = await nativeFixture(); let shellStarts = 0;
    try {
      const rules = importPermissionRules([{ id: "outside-deny", action: "deny", match: { kind: "outside-read", path: join(f.outside, "outside.txt"), scope: "exact" } },
        { id: "outside-allow", action: "allow", match: { kind: "outside-read", path: f.outside, scope: "tree" } }], "owned configuration", 1);
      await f.update({ outsideReads: "inherit", rules });
      let name = "read", input: unknown = { file_path: "../outside/outside.txt" };
      if (missing === "fs") {
        const definition = f.ctx.tools.get("read")!, identity = f.identities.get(definition)!;
        const context = f.ctx.extend({ get: ((...args: Parameters<Context["get"]>) => args[0] === "fs" ? undefined : Reflect.apply(f.ctx.get, f.ctx, args)) as Context["get"] });
        f.identities.set(definition, { ...identity, context });
      } else if (missing === "colocation") {
        f.setColocated(false); name = "glob"; input = { pattern: "*.txt", path: "../outside" };
      } else {
        f.ctx.provide("shellEnv", { collect() { return {}; } });
        f.ctx.provide("shell", { resolve(request: Record<string, unknown>) { return request; }, execute() { shellStarts++; return { result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: { text: "owned", truncated: false }, stderr: { text: "", truncated: false } }) }; } });
        await f.ctx.plugin(NativePwsh, { enableRunInBackground: false, promoteOnTimeout: false }).await();
        f.identities.set(f.ctx.tools.get("pwsh")!, { kind: "shell", context: f.ctx, coLocated() { return true; }, assertCurrent() {}, shell: {
          executable: "pwsh", dialect: "powershell", commandField: "command", cwdField: "workdir", readCapability: {
            signal: new AbortController().signal, resolveExecutable(token) { return token.toLowerCase() === "get-content" ? "get-content" : undefined; }, assertCurrent() {},
          },
        } });
        name = "pwsh"; input = { command: "Get-Content *", description: "Owned uncertain read operands", workdir: f.workspace };
      }
      const value = await f.execute(name, input);
      assert.equal(value.isError, true, JSON.stringify({ value, approvals: f.approvals(), reads: f.reads(), spawns: f.spawns(), shellStarts }));
      assert.equal(f.approvals(), 0); assert.equal(f.reads(), 0); assert.equal(f.spawns(), 0); assert.equal(shellStarts, 0);
      if (missing !== "operands") {
        await f.update({ outsideReads: "inherit" }); assert.equal((await f.execute(name, input)).isError, false); assert.equal(f.approvals(), 0);
      }
    } finally { await f.dispose(); }
  });
});

test("native once approval is final when permission-only co-location facts change", async () => {
  const f = await nativeFixture({ outsideReads: "ask" });
  let nextCalls = 0;
  try {
    f.ctx.on("tools/pre-execute", async (_exec, next) => { nextCalls++; return next(); }, { global: true });
    f.setAnswer(async () => { f.setColocated(false); return "allowed-once"; });
    assert.equal((await f.execute("grep", { pattern: "needle", path: "../outside" })).isError, false);
    assert.equal(f.spawns(), 1); assert.equal(nextCalls, 1);
  } finally { await f.dispose(); }
});

test("native and DSMM same-call asks compose once and deny never/unavailable/cancelled", async () => {
  const f = await nativeFixture({ outsideReads: "ask" });
  let nextCalls = 0;
  try {
    f.ctx.on("tools/pre-execute", async (_exec, next) => { nextCalls++; await next(); return { kind: "ask", reason: "downstream exact once" }; }, { global: true });
    assert.equal((await f.execute("read", { file_path: "../outside/outside.txt" })).isError, false);
    assert.equal(f.approvals(), 1); assert.equal(nextCalls, 1);
    for (const outcome of ["unavailable", "cancelled", "rejected"] as const) { f.setOutcome(outcome); assert.equal((await f.execute("read", { file_path: "../outside/outside.txt" })).isError, true); }
    f.setNever(); assert.equal((await f.execute("read", { file_path: "../outside/outside.txt" })).isError, true); assert.equal(f.approvals(), 4); assert.equal(f.reads(), 1);
  } finally { await f.dispose(); }
});

test("source save while native approval is pending preserves the latest operator decision for that call only", async () => {
  const f = await nativeFixture({ outsideReads: "ask" });
  let release!: (value: "allowed-once") => void, entered!: () => void;
  const ready = new Promise<void>(yes => { entered = yes; }), answer = new Promise<"allowed-once">(yes => { release = yes; });
  try {
    f.setAnswer(() => { entered(); return answer; });
    const pending = f.execute("read", { file_path: "../outside/outside.txt" }); await ready;
    await f.update({ outsideReads: "deny" }); release("allowed-once"); assert.equal((await pending).isError, false); assert.equal(f.reads(), 1);
    assert.equal((await f.execute("read", { file_path: "../outside/outside.txt" })).isError, true); assert.equal(f.reads(), 1);
  } finally { release("allowed-once"); await f.dispose(); }
});

test("outside exact/tree rules keep target keys opaque and classify an existing junction outside", async () => {
  const f = await nativeFixture({ outsideReads: "deny" });
  try {
    await f.update({ outsideReads: "deny", rules: importPermissionRules([{ id: "owned-tree", action: "allow", match: { kind: "outside-read", path: f.outside, scope: "tree" } }], "owned import", 1) });
    assert.equal((await f.execute("read", { file_path: "../outside/outside.txt" })).isError, false);
    await symlink(f.outside, join(f.workspace, "link"), process.platform === "win32" ? "junction" : "dir");
    await f.update({ outsideReads: "deny" });
    assert.equal((await f.execute("read", { file_path: "link/outside.txt" })).isError, true); assert.equal(f.reads(), 1);
  } finally { await f.dispose(); }
});

test("trusted Shell parser extracts actual file/search operands and refuses uncertain roots without rejecting Unicode", () => {
  const identity = { executable: "pwsh.exe", dialect: "powershell" as const, commandField: "command", readCapability: {
    signal: new AbortController().signal, resolveExecutable(token: string) { return token === "rg" ? "rg" as const : token.toLowerCase() === "get-content" ? "get-content" as const : undefined; }, assertCurrent() {},
  } };
  assert.deepEqual(parsePermissionShellReadPaths(identity, { command: "rg --no-config -n 中文 ../outside" }, "workspace")?.paths, ["../outside"]);
  assert.deepEqual(parsePermissionShellReadPaths(identity, { command: "Get-Content -LiteralPath '../中文.txt' -Raw" }, "workspace")?.paths, ["../中文.txt"]);
  for (const command of ["rg --pre=anything needle inside.txt", "Get-Content *.txt", "Get-Content < ../x", "rg needle inside.txt | rg secret"])
    assert.equal(parsePermissionShellReadPaths(identity, { command }, "workspace"), undefined);
});

test("stock native pwsh outside-read rule uses verified Get-Content operand, never workspace cwd alone", { skip: process.platform !== "win32" }, async () => {
  const f = await nativeFixture({ outsideReads: "deny" });
  const file = join(f.outside, "outside.txt"), command = `Get-Content -LiteralPath '${file}' -Raw`;
  let starts = 0;
  try {
    f.ctx.provide("shellEnv", { collect() { return {}; } });
    f.ctx.provide("shell", {
      resolve(request: { command: string; workdir: string; signal: AbortSignal }) { return request; },
      execute(request: { command: string; workdir: string; signal: AbortSignal }) {
        assert.equal(request.command, command); assert.equal(request.workdir, f.workspace); request.signal.throwIfAborted(); starts++;
        const result = promisify(execFile)("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { cwd: f.workspace, signal: request.signal, timeout: 5000 })
          .then(value => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 5000, stdout: { text: value.stdout, truncated: false }, stderr: { text: value.stderr, truncated: false } }));
        return { result: () => result };
      },
    });
    await f.ctx.plugin(NativePwsh, { enableRunInBackground: false, promoteOnTimeout: false }).await();
    const definition = f.ctx.tools.get("pwsh")!;
    f.identities.set(definition, { kind: "shell", context: f.ctx, coLocated() { return true; }, assertCurrent() {}, shell: {
      executable: "pwsh", dialect: "powershell", commandField: "command", cwdField: "workdir", readCapability: {
        signal: new AbortController().signal,
        resolveExecutable(token) { return token.toLowerCase() === "get-content" ? "get-content" : undefined; }, assertCurrent() {},
      },
    } });
    const call = () => f.execute("pwsh", { command, workdir: f.workspace, description: "owned exact local file read" });
    assert.deepEqual(parsePermissionShellReadPaths(f.identities.get(definition)!.shell!, { command, workdir: f.workspace }, f.workspace)?.paths, [file]);
    assert.equal((await call()).isError, true); assert.equal(starts, 0);
    await f.update({ outsideReads: "ask" });
    const result = await call(); assert.equal(result.isError, false); assert.equal(starts, 1); assert.equal(f.approvals(), 1);
    assert.ok(result.content.some(block => block.type === "text" && block.text.includes("needle outside")), JSON.stringify(result.content));
    await f.update({ outsideReads: "deny" }); assert.equal((await call()).isError, true); assert.equal(starts, 1);
  } finally { await f.dispose(); }
});

test("coarse web rules deny only trusted tools and never suppress native network denial or independent native ask", async () => {
  const f = await nativeFixture({ webSearch: { enabled: false }, webFetch: { rule: "ask" } });
  let bodies = 0;
  try {
    for (const kind of ["webSearch", "webFetch"] as const) {
      const definition: ToolDefinition = { name: kind, description: "owned native network boundary", parameters: { type: "object" }, output: { schema: { type: "integer" }, render: (_args, value) => [{ type: "text", text: String(value) }] }, async execute() { return ++bodies; } };
      f.ctx.tools.register(definition); f.identities.set(definition, { kind, context: f.ctx, assertCurrent() {} });
    }
    assert.equal((await f.execute("webSearch", {})).isError, true); assert.equal(bodies, 0);
    assert.equal((await f.execute("webFetch", {})).isError, false); assert.equal(bodies, 1); assert.equal(f.approvals(), 1);
    const guard = f.ctx.tools.guard(exec => exec.name === "webFetch" ? "owned native resolver refused private address" : undefined);
    await f.update({ webFetch: { rule: "allow" } }); assert.equal((await f.execute("webFetch", {})).isError, true); assert.equal(bodies, 1); guard();
    const shadow = f.root.ctx.tools.register({ name: "webSearch", description: "untrusted same-name", parameters: { type: "object" }, output: { schema: { type: "integer" }, render: (_args, value) => [{ type: "text", text: String(value) }] }, async execute() { return 7; } });
    assert.equal((await f.execute("webSearch", {})).isError, false); shadow();
  } finally { await f.dispose(); }
});

test("Shell read containment and relative path rules use the session workspace rather than model workdir", async t => {
  const f = await nativeFixture({ outsideReads: "deny" });
  let bodies = 0;
  try {
    const inner = join(f.workspace, "inner"), nestedOutside = join(f.outside, "nested"); await mkdir(inner); await mkdir(nestedOutside);
    await writeFile(join(inner, "inside.txt"), "owned inside");
    f.ctx.provide("shellEnv", { collect() { return {}; } });
    f.ctx.provide("shell", {
      resolve(request: { command: string; workdir: string; signal: AbortSignal }) { return request; },
      async execute(request: { signal: AbortSignal }) { request.signal.throwIfAborted(); bodies++; return { result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: { text: "owned counter", truncated: false }, stderr: { text: "", truncated: false } }) }; },
    });
    await f.ctx.plugin(NativePwsh, { enableRunInBackground: false, promoteOnTimeout: false }).await();
    f.identities.set(f.ctx.tools.get("pwsh")!, { kind: "shell", context: f.ctx, coLocated() { return true; }, assertCurrent() {}, shell: {
      executable: "pwsh", dialect: "powershell", commandField: "command", cwdField: "workdir", readCapability: { signal: new AbortController().signal,
        resolveExecutable(token) { return token.toLowerCase() === "get-content" ? "get-content" : undefined; }, assertCurrent() {} },
    } });
    const command = `Get-Content -LiteralPath '${join(f.outside, "outside.txt")}' -Raw`;
    const call = (workdir?: string, readCommand = command) => f.execute("pwsh", { command: readCommand, description: "Read one owned literal path", ...workdir === undefined ? {} : { workdir } });
    for (const [label, workdir] of [["session", undefined], ["absolute outside", f.outside], ["relative outside", "../outside"]] as const) await t.test(label, async () => {
      assert.equal((await call(workdir)).isError, true); assert.equal(bodies, 0);
    });
    assert.equal((await call("inner", "Get-Content -LiteralPath 'inside.txt' -Raw")).isError, false); assert.equal(bodies, 1);
    await f.update({ outsideReads: "ask" });
    for (const workdir of [undefined, f.outside, "../outside"]) {
      let ready!: (value: boolean) => void, release!: (value: "allowed-once") => void;
      const pending = new Promise<boolean>(yes => { ready = yes; }), answer = new Promise<"allowed-once">(yes => { release = yes; });
      f.setAnswer(() => { ready(true); return answer; });
      const before: number = bodies;
      const run = call(workdir);
      try { assert.equal(await Promise.race([pending, run.then(() => false)]), true); assert.equal(bodies, before); release("allowed-once"); assert.equal((await run).isError, false); }
      finally { release("allowed-once"); await run; }
    }
    f.setAnswer(undefined);
    await f.update({ outsideReads: "deny", rules: importPermissionRules([{ id: "owned-anchored-tree", action: "allow", match: { kind: "outside-read", path: "../outside", scope: "tree" } }], "owned import", 2) });
    for (const workdir of [undefined, nestedOutside, "../outside/nested", inner]) assert.equal((await call(workdir)).isError, false);
    const before = bodies;
    await f.update({ outsideReads: "deny", rules: importPermissionRules([{ id: "owned-anchored-exact", action: "allow", match: { kind: "outside-read", path: "../outside/outside.txt", scope: "exact" } }], "owned import", 3) });
    for (const workdir of [nestedOutside, "../outside/nested"]) assert.equal((await call(workdir)).isError, false);
    assert.equal(bodies, before + 2);
  } finally { await f.dispose(); }
});
