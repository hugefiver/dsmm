import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmRuntime, ToolCallId } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import * as NativeFs from "@deepseek-ai/dsh-tool-fs";
import * as ManagedFs from "../src/permission-fs.ts";
import * as ManagedSearch from "../src/permission-fs-search.ts";
import * as ManagedWeb from "../src/permission-web.ts";
import * as ManagedPwsh from "../src/permission-pwsh.ts";
import DsmmPlugin from "../src/index.ts";
import type { NativePermissionFsTarget } from "../src/permission-native-rules.ts";
import type { PermissionControlSchemaInput } from "../src/permission-settings.ts";
import { PermissionRefusal } from "../src/permission-control.ts";
import { FixedConfigFileStore } from "../src/config-file-store.ts";
import { profileStoreFilePrimitives } from "../src/profile-store.ts";
import { DsmmProfileError } from "../src/profiles.ts";
import type { DsmmProfileRuntime } from "../src/profile-runtime.ts";
import type { DshAgent } from "../src/dsh-types.ts";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";
import { mountPermissionHostCore, permissionHostProfile, waitForPermissionHost } from "./permission-host-fixture.ts";

useIsolatedDshEnvironment();
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}
const sdk = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-tools"));
const { ApprovalService, setApprovalPolicy } = await import(pathToFileURL(sdk.resolve("@deepseek-ai/dsh-user-approval")).href);
const { FileSystem, FsError } = await import(pathToFileURL(sdk.resolve("@deepseek-ai/dsh-fs")).href);
const native = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-agent-preset-registry"));
const WorkingDirectory = await import(pathToFileURL(native.resolve("@deepseek-ai/dsh-working-directory")).href);
const webSdk = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-tool-web"));
const { WebRuntime } = await import(pathToFileURL(webSdk.resolve("@deepseek-ai/dsh-web")).href);

/** Real Core install and native bodies over one task-owned public filesystem capability. */
async function fixture(policy: PermissionControlSchemaInput = {}, lateCore = false, sandboxFs = false, fullAccess = false) {
  const parent = await realpath(tmpdir()), directory = await mkdtemp(join(parent, "dsmm-managed-tools-"));
  const workspace = join(directory, "workspace"), outside = join(directory, "outside"), home = join(directory, "home");
  for (const path of [workspace, outside, home]) await mkdir(path);
  await mkdir(join(home, "plugins", "dsmm"), { recursive: true });
  await writeFile(join(home, "plugins", "dsmm", "config.json"), JSON.stringify({ permissionControl: { enabled: true, ...policy } }));
  await writeFile(join(workspace, "inside.txt"), "needle inside");
  await writeFile(join(outside, "outside.txt"), "needle outside");
  const ctx = new Context(), handles: AgentHandle[] = [], targets = new Map<string, NativePermissionFsTarget>();
  let reads = 0, mutations = 0, searches = 0, fetches = 0, spawns = 0, approvals = 0, shellStarts = 0;
  const shellSpecs: Record<string, unknown>[] = [];
  let outcome: "allowed-once" | "rejected" = "allowed-once";
  let answer: (() => Promise<typeof outcome>) | undefined;
  const filePath = (target: NativePermissionFsTarget) => String(target.targetKey);
  const mutationPolicy = (target: NativePermissionFsTarget, mode?: string) => {
    if (sandboxFs && !filePath(target).startsWith(`${workspace}${sep}`) && mode !== "danger-full-access") throw new FsError("Owned backend refused an outside mutation", "FS_SANDBOX_DENIED");
  };
  class OwnedFs extends FileSystem {
    get sandboxMode() { return sandboxFs ? "workspace-write" : undefined; }
    processPath(target: NativePermissionFsTarget) { return filePath(target); }
    async resolve(path: string, options: { cwd?: string; signal?: AbortSignal } = {}) {
      options.signal?.throwIfAborted(); const canonical = resolve(options.cwd ?? workspace, path);
      let target = targets.get(canonical);
      if (target === undefined) { target = { targetKey: canonical, displayPath: canonical }; targets.set(canonical, target); }
      return target;
    }
    contains(root: NativePermissionFsTarget, target: NativePermissionFsTarget) {
      const path = relative(filePath(root), filePath(target));
      return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    }
    async stat(target: NativePermissionFsTarget) { const info = await stat(filePath(target)); return { type: info.isDirectory() ? "directory" : "file", size: info.size, version: String(info.mtimeMs) }; }
    async readText(target: NativePermissionFsTarget) { reads++; return readFile(filePath(target), "utf8"); }
    async *streamText(target: NativePermissionFsTarget) { yield await this.readText(target); }
    async writeText(target: NativePermissionFsTarget, content: string, _intent: unknown, _signal: AbortSignal, policy?: { mode: string }) {
      mutationPolicy(target, policy?.mode);
      const before = await readFile(filePath(target), "utf8"); mutations++; await writeFile(filePath(target), content);
      return { operation: "update", before, after: content, version: String((await stat(filePath(target))).mtimeMs) };
    }
    async editText(target: NativePermissionFsTarget, edit: { oldString: string; newString: string; replaceAll: boolean }, _intent: unknown, _signal: AbortSignal, policy?: { mode: string }) {
      mutationPolicy(target, policy?.mode);
      const before = await readFile(filePath(target), "utf8");
      const after = edit.replaceAll ? before.replaceAll(edit.oldString, edit.newString) : before.replace(edit.oldString, edit.newString);
      mutations++; await writeFile(filePath(target), after); return { before, after, version: String((await stat(filePath(target))).mtimeMs) };
    }
  }
  const mountCore = async () => {
    const fiber = await mountPermissionHostCore(ctx, DsmmPlugin);
    if (lateCore) await waitForPermissionHost(ctx, controller => controller.toolCoverage().length === (controller.rules.status().mounted ? 5 : 0));
    return fiber;
  };
  try {
    ctx.provide("profileContext", permissionHostProfile(directory, home,
      { defaultActive: false, lsp: { enabled: false }, presets: { root: join(directory, "presets") } }));
    for (const [plugin, config] of [[AgentRegistry], [SessionStore], [SessionProjectionRegistry], [LlmRuntime], [SystemPrompt, {}], [ToolRuntime, { mode: "native" }], [ApprovalService, { policy: "ask" }], [OwnedFs], [SubagentRuntime, {}], [AgentLoop, {}]] as const) await ctx.plugin(plugin as never, config as never).await();
    await ctx.plugin(WorkingDirectory.default, { defaultDirectory: workspace }).await();
    ctx.provide("sandboxPolicy", { resolve() { return { mode: fullAccess ? "danger-full-access" : "workspace-write", workspaceRoot: workspace }; } });
    ctx.provide("shellEnv", { collect() { return {}; } });
    ctx.provide("shell", { sandboxMode: "workspace-write", resolve(request: Record<string, unknown>) { return { timeoutMs: 1000, ...request }; },
      async execute(spec: Record<string, unknown>) {
        (spec.signal as AbortSignal | undefined)?.throwIfAborted(); shellStarts++; shellSpecs.push(spec);
        return { result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
          stdout: { text: "owned counted shell", truncated: false }, stderr: { text: "", truncated: false } }) };
      } });
    await ctx.plugin(WebRuntime, {}).await();
    ctx.web.registerSearchProvider({ id: "owned-search", available: () => true,
      async search(request: { query: string }) { searches++; return { sources: [{ url: "https://example.invalid/", title: request.query }], truncated: false }; },
    });
    ctx.web.registerFetchProvider({ id: "owned-fetch", available: () => true,
      async fetch(request: { url: string }) { fetches++; return { url: request.url, statusCode: 200, body: { kind: "text", content: "owned provider" }, truncated: false }; },
    });
    ctx.provide("subprocess", { spawn() { spawns++; throw new Error("No co-location capability was supplied"); } });
    ctx.on("approval/request", async () => { approvals++; return answer === undefined ? outcome : answer(); }, { global: true });
    if (!lateCore) await mountCore();
    const fsFiber = ctx.plugin(ManagedFs, {}); await fsFiber.await();
    const searchFiber = ctx.plugin(ManagedSearch, { sampleOverCapGlobResults: false }); await searchFiber.await();
    const webFiber = ctx.plugin(ManagedWeb, { fetch: true }); await webFiber.await();
    for (const fiber of [fsFiber, searchFiber, webFiber]) assert.equal(fiber.state, 2);
    for (const name of ["read", "write", "edit", "glob", "grep", "web_search", "web_fetch"]) assert.ok(ctx.tools.get(name), `${name} must be registered before permission checks`);
    if (!lateCore) await waitForPermissionHost(ctx, controller => controller.toolCoverage().length === (controller.rules.status().mounted ? 5 : 0));
    const create = async (parentAgent?: Agent) => {
      const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), ...parentAgent === undefined ? {} : { parentAgent }, meta: { cwd: workspace, ...parentAgent === undefined ? {} : { origin: "subagent" as const } }, agentOptions: { provider: "unused-local", model: "unused-local" } });
      handles.push(handle); handle.agent.session.append("turn/start", { turn: 1 }); return handle.agent;
    };
    return { ctx, workspace, outside, home, fsFiber, searchFiber, webFiber, create, mountCore,
      controller: () => ctx.get("dsmmPermissionController")!,
      execute: (agent: Agent, name: string, args: unknown, signal = new AbortController().signal) => ctx.tools.execute({ agent, name, arguments: args, signal, callId: ToolCallId(randomUUID()) }),
      async mountShell() { const fiber = ctx.plugin(ManagedPwsh, { enableRunInBackground: false, promoteOnTimeout: false }); await fiber.await(); return fiber; },
      async update(value: PermissionControlSchemaInput) { const path = join(home, "plugins", "dsmm"); await mkdir(path, { recursive: true }); await writeFile(join(path, "config.json"), JSON.stringify({ permissionControl: { enabled: true, ...value } })); },
      counts: () => ({ reads, mutations, searches, fetches, spawns, approvals, shellStarts }), shellSpecs,
      setOutcome(value: typeof outcome) { outcome = value; }, setAnswer(value: typeof answer) { answer = value; },
      async dispose() { for (const handle of handles.reverse()) await handle.dispose(); await ctx.fiber.dispose(); const exact = await realpath(directory); assert.equal(dirname(exact), parent); await rm(exact, { recursive: true }); },
    };
  } catch (error) { for (const handle of handles.reverse()) await handle.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true }); throw error; }
}

test("Core native FS read rules compose once, deny without body access, and retain native results", async () => {
  const f = await fixture({ outsideReads: "ask", nativeCommands: { enabled: false } });
  try {
    const root = await f.create();
    const read = () => f.execute(root, "read", { file_path: join(f.outside, "outside.txt") });
    const result = await read(); assert.equal(result.isError, false, JSON.stringify(result));
    assert.ok(result.meta !== null && typeof result.meta === "object" && !Array.isArray(result.meta));
    assert.deepEqual(result.meta.lines, [{ number: 1, text: "needle outside" }]);
    assert.equal(f.counts().reads, 1); assert.equal(f.counts().approvals, 1);
    f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Native exact invocation" }; }, { global: true });
    assert.equal((await read()).isError, false); assert.equal(f.counts().approvals, 2);
    f.setOutcome("rejected"); assert.equal((await read()).isError, true); assert.equal(f.counts().reads, 2);
    await f.update({ outsideReads: "deny" }); assert.equal((await read()).isError, true); assert.equal(f.counts().approvals, 3); assert.equal(f.counts().reads, 2);
    assert.equal((await f.execute(root, "read", { file_path: join(f.workspace, "inside.txt") })).isError, true); // independent native ask remains authoritative
    f.setOutcome("allowed-once"); assert.equal((await f.execute(root, "read", { file_path: join(f.workspace, "inside.txt") })).isError, false);
    setApprovalPolicy(root.session, "never"); await f.update({ outsideReads: "ask" }); assert.equal((await read()).isError, true);
  } finally { await f.dispose(); }
});
test("native full access reads through malformed or unsynced DSMM policy without publishing stale permission state", async () => {
  const f = await fixture({ outsideReads: "ask" }, false, false, true);
  try {
    const root = await f.create(), file_path = join(f.outside, "outside.txt");
    const config = join(f.home, "plugins", "dsmm", "config.json");
    await writeFile(config, "{ malformed permission source");
    assert.equal((await f.execute(root, "read", { file_path })).isError, false);
    assert.equal(f.controller().rules.status().state, "unsynced"); assert.equal(f.counts().approvals, 0);
    await f.update({ outsideReads: "deny" });
    assert.equal((await f.execute(root, "read", { file_path })).isError, true); assert.equal(f.counts().reads, 1);
    await f.update({ outsideReads: "ask" }); await f.controller().rules.refresh();
    f.controller().rules.invalidate();
    const refresh = f.controller().rules.refresh;
    f.controller().rules.refresh = async () => { throw new PermissionRefusal("unavailable"); };
    try { assert.equal((await f.execute(root, "read", { file_path })).isError, false); }
    finally { f.controller().rules.refresh = refresh; }
    assert.equal(f.controller().rules.status().state, "unsynced"); assert.equal(f.counts().approvals, 0);
    f.controller().rules.refresh = async () => { throw Object.assign(new Error("Owned permission-source IO failure"), { code: "EIO" }); };
    try { assert.equal((await f.execute(root, "read", { file_path })).isError, false); assert.equal(f.counts().reads, 3); }
    finally { f.controller().rules.refresh = refresh; }
    const ready = deferred<void>(), release = deferred<"allowed-once">();
    f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Native full-access purpose" }; }, { global: true });
    f.setAnswer(async () => { ready.resolve(); return release.promise; });
    const pending = f.execute(root, "read", { file_path }); await ready.promise;
    try { await f.fsFiber.dispose(); assert.equal((await pending).isError, true); assert.equal(f.counts().reads, 3); }
    finally { release.resolve("allowed-once"); await pending; }
  } finally { await f.dispose(); }
});
test("full access defers production config-reader IO failures but retains native body IO failures", async () => {
  const f = await fixture({ outsideReads: "deny" }, false, false, true);
  const regularFile = profileStoreFilePrimitives.regularFile;
  try {
    const root = await f.create(), file_path = join(f.outside, "outside.txt"), config = join(f.home, "plugins", "dsmm", "config.json");
    const sourceFailure = Object.assign(new Error("Owned policy-reader IO failure"), { code: "EIO" });
    profileStoreFilePrimitives.regularFile = (path, maximum) => { if (path === config) throw sourceFailure; return regularFile(path, maximum); };
    try {
      assert.throws(() => new FixedConfigFileStore(f.home).read(), (error: unknown) => error instanceof DsmmProfileError && error.code === "io");
      const result = await f.execute(root, "read", { file_path });
      assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(f.counts().reads, 1); assert.equal(f.counts().approvals, 0);
      assert.equal(f.controller().rules.status().state, "unsynced");
    } finally { profileStoreFilePrimitives.regularFile = regularFile; }
    assert.equal((await f.execute(root, "read", { file_path })).isError, true); assert.equal(f.counts().reads, 1);
    await f.update({ outsideReads: "inherit" });
    const fs = f.ctx.get("fs"); assert.ok(fs); const readText = fs.readText;
    const bodyFailure = Object.assign(new Error("Owned native read IO failure"), { code: "EIO" });
    fs.readText = async () => { throw bodyFailure; };
    try {
      const result = await f.execute(root, "read", { file_path });
      assert.equal(result.isError, true); assert.equal(result.error?.message, bodyFailure.message);
    } finally { fs.readText = readText; }
  } finally { profileStoreFilePrimitives.regularFile = regularFile; await f.dispose(); }
});

test("Core FS mapping leaves native write/edit contracts intact and search co-location unproven", async () => {
  const f = await fixture({ outsideReads: "deny" });
  try {
    const root = await f.create(), file = join(f.outside, "outside.txt");
    const write = await f.execute(root, "write", { file_path: file, content: "owned update" }); assert.equal(write.isError, false, JSON.stringify(write));
    assert.ok(write.meta !== null && typeof write.meta === "object" && !Array.isArray(write.meta));
    assert.equal(write.meta.operation, "update");
    const edit = await f.execute(root, "edit", { file_path: file, old_string: "update", new_string: "edit" }); assert.equal(edit.isError, false, JSON.stringify(edit));
    assert.equal(await readFile(file, "utf8"), "owned edit"); assert.equal(f.counts().mutations, 2); assert.equal(f.counts().approvals, 0);
    for (const name of ["glob", "grep"]) assert.equal((await f.execute(root, name, { pattern: "needle", path: f.workspace })).isError, true);
    assert.equal(f.counts().spawns, 0);
    const coverage = f.controller().toolCoverage(root);
    assert.deepEqual(coverage.map(row => row.kind).sort(), ["glob", "grep", "read", "webFetch", "webSearch"].sort());
    assert.ok(coverage.filter(row => row.kind === "glob" || row.kind === "grep").every(row => row.pathEvidence === "requires-colocation"));
    assert.deepEqual(f.controller().coverage(root), []);
    const restrict = root.ctx.tools.restrict({ deny: ["read"] });
    assert.equal(f.controller().toolCoverage(root).some(row => row.kind === "read"), false); restrict();
  } finally { await f.dispose(); }
});

test("Core native Web switches stop provider calls while nativeCommands is off", async () => {
  const f = await fixture({ webSearch: { enabled: false }, webFetch: { enabled: false }, nativeCommands: { enabled: false } });
  try {
    const root = await f.create();
    assert.equal((await f.execute(root, "web_search", { queries: ["owned query"] })).isError, true);
    assert.equal((await f.execute(root, "web_fetch", { url: "https://example.invalid/" })).isError, true);
    assert.equal(f.counts().searches, 0); assert.equal(f.counts().fetches, 0);
    await f.update({ webSearch: { enabled: true, rule: "ask" }, webFetch: { enabled: true, rule: "inherit" } });
    assert.equal((await f.execute(root, "web_search", { queries: ["first", "second"] })).isError, false);
    assert.equal(f.counts().searches, 2); assert.equal(f.counts().approvals, 1);
    const fetched = await f.execute(root, "web_fetch", { url: "https://example.invalid/" }); assert.equal(fetched.isError, false);
    assert.deepEqual(fetched.meta, { url: "https://example.invalid/", statusCode: 200, truncated: false });
    f.setOutcome("rejected"); await f.update({ webFetch: { rule: "ask" } });
    assert.equal((await f.execute(root, "web_fetch", { url: "https://example.invalid/" })).isError, true); assert.equal(f.counts().fetches, 1);
    await f.webFiber.dispose();
    const fetchOnly = f.ctx.plugin(ManagedWeb, { search: false, fetch: true }); await fetchOnly.await();
    assert.equal(f.ctx.tools.get("web_search"), undefined);
    assert.deepEqual(f.controller().toolCoverage(root).filter(row => row.kind === "webFetch" || row.kind === "webSearch").map(row => row.kind), ["webFetch"]);
    await fetchOnly.dispose(); assert.equal(f.controller().toolCoverage(root).some(row => row.kind === "webFetch"), false);
  } finally { await f.dispose(); }
});

test("unmapped native write/edit retain their original sandbox approval and mutation policy", async () => {
  const f = await fixture({ outsideReads: "deny" }, false, true);
  try {
    const root = await f.create(), file_path = join(f.outside, "outside.txt");
    const write = (extra = {}) => f.execute(root, "write", { file_path, content: "owned update", ...extra });
    const escalation = { sandbox_permissions: "danger-full-access", justification: "Approve this owned outside mutation" };
    const denied = await write(); assert.equal(denied.error?.info?.code, "FS_SANDBOX_DENIED", JSON.stringify(denied)); assert.equal(f.counts().mutations, 0);
    f.setOutcome("rejected"); assert.equal((await write(escalation)).isError, true); assert.equal(f.counts().mutations, 0);
    f.setOutcome("allowed-once"); assert.equal((await write(escalation)).isError, false); assert.equal(f.counts().approvals, 2);
    assert.equal((await f.execute(root, "edit", { file_path, old_string: "update", new_string: "edit" })).error?.info?.code, "FS_SANDBOX_DENIED");
    assert.equal((await f.execute(root, "edit", { file_path, old_string: "update", new_string: "edit", ...escalation })).isError, false);
    assert.equal(f.counts().mutations, 2); assert.equal(f.counts().approvals, 3);
    assert.equal(await readFile(file_path, "utf8"), "owned edit");
    assert.equal((await write()).error?.info?.code, "FS_SANDBOX_DENIED");
    setApprovalPolicy(root.session, "never"); assert.equal((await write(escalation)).isError, true); assert.equal(f.counts().approvals, 3);
  } finally { await f.dispose(); }
});

test("late Core load applies permission rules to unadmitted native roots without granting DSMM admission", async () => {
  for (const enabled of [true, false]) {
    const f = await fixture({ enabled, outsideReads: "deny" }, true);
    try {
      assert.ok(f.ctx.tools.get("read")); assert.equal(f.ctx.get("dsmmPermissionController"), undefined);
      const root = await f.create();
      assert.equal((await f.execute(root, "read", { file_path: join(f.outside, "outside.txt") })).isError, false);
      assert.equal(f.counts().reads, 1); assert.equal(f.counts().approvals, 0);
      await f.mountCore();
      assert.equal(f.ctx.dsmmNativeAdmission.owns(root), false);
      assert.equal((await f.execute(root, "read", { file_path: join(f.outside, "outside.txt") })).isError, enabled);
      assert.equal(f.counts().reads, enabled ? 1 : 2);
      assert.equal((await f.execute(root, "read", { file_path: join(f.workspace, "inside.txt") })).isError, false);
      const admitted = await f.create();
      assert.equal((await f.execute(admitted, "read", { file_path: join(f.outside, "outside.txt") })).isError, enabled);
      assert.equal(f.counts().reads, enabled ? 2 : 4); assert.equal(f.counts().approvals, 0);
      assert.equal(f.controller().toolCoverage(admitted).length, enabled ? 5 : 0);
      if (enabled) {
        await f.update({ outsideReads: "ask" }); f.setOutcome("rejected");
        assert.equal((await f.execute(root, "read", { file_path: join(f.outside, "outside.txt") })).isError, true);
        assert.equal(f.counts().reads, 2); assert.equal(f.counts().approvals, 1);
        f.setOutcome("allowed-once");
        assert.equal((await f.execute(root, "read", { file_path: join(f.outside, "outside.txt") })).isError, false);
        assert.equal(f.counts().reads, 3); assert.equal(f.counts().approvals, 2);
      }
    } finally { await f.dispose(); }
  }
});

test("pre-Core native root managed shell retains native sandbox, approval and applicable rules without role admission", async () => {
  const f = await fixture({ outsideReads: "inherit" }, true);
  try {
    const root = await f.create(); await f.mountCore(); await f.mountShell();
    const args = { command: "go test", description: "Count one owned shell invocation", workdir: f.workspace };
    const call = (extra = {}) => f.execute(root, "pwsh", { ...args, ...extra });
    assert.equal(f.ctx.dsmmNativeAdmission.owns(root), false);
    assert.equal((await call()).isError, false); assert.equal(f.counts().shellStarts, 1); assert.equal(f.counts().approvals, 0);
    assert.equal((f.shellSpecs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
    const escalation = { sandbox_permissions: "danger-full-access", justification: "Approve this exact counted native invocation" };
    f.setOutcome("rejected"); assert.equal((await call(escalation)).isError, true); assert.equal(f.counts().shellStarts, 1);
    f.setOutcome("allowed-once"); assert.equal((await call(escalation)).isError, false); assert.equal(f.counts().shellStarts, 2);
    assert.equal((f.shellSpecs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    assert.equal((await call()).isError, false); assert.equal((f.shellSpecs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
    setApprovalPolicy(root.session, "never"); assert.equal((await call(escalation)).isError, true); assert.equal(f.counts().shellStarts, 3);
    const restrict = root.ctx.tools.restrict({ deny: ["pwsh"] });
    try { assert.equal((await call()).isError, true); } finally { restrict(); }
    await f.update({ outsideReads: "deny" }); assert.equal((await call()).isError, true); assert.equal(f.counts().shellStarts, 3);
    assert.equal(f.counts().approvals, 2); assert.equal(f.counts().spawns, 0);
    setApprovalPolicy(root.session, "ask");
    await f.update({ nativeCommands: { enabled: true, entries: [{ id: "owned-test", mode: "ask", sandboxMode: "danger-full-access",
      match: { tool: "pwsh", commandPattern: "go test", workingDirectory: f.workspace } }] } });
    f.setOutcome("rejected"); assert.equal((await call()).isError, true); assert.equal(f.counts().shellStarts, 3);
    f.setOutcome("allowed-once"); assert.equal((await call()).isError, false); assert.equal(f.counts().shellStarts, 4);
    assert.equal((f.shellSpecs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    setApprovalPolicy(root.session, "never"); assert.equal((await call()).isError, true);
    assert.equal(f.counts().shellStarts, 4); assert.equal(f.counts().approvals, 4);
    assert.equal(f.ctx.dsmmNativeAdmission.owns(root), false);
    const profiles = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    assert.throws(() => profiles.admission(root as unknown as DshAgent), { code: "activation" });
  } finally { await f.dispose(); }
});

test("retired exact native-preset DSMM capture cannot become an unadmitted native permission caller", async () => {
  const f = await fixture({ outsideReads: "inherit" });
  try {
    await f.mountShell(); const root = await f.create();
    const args = { command: "Write-Output owned", description: "Count one owned shell invocation", workdir: f.workspace };
    assert.equal(f.ctx.dsmmNativeAdmission.owns(root), true);
    assert.equal((await f.execute(root, "pwsh", args)).isError, false); assert.equal(f.counts().shellStarts, 1);
    f.ctx.dsmmNativeAdmission.lifetime.abort();
    assert.equal(f.ctx.agents.get(root.id), root); assert.equal(f.ctx.dsmmNativeAdmission.owns(root), true);
    assert.equal((await f.execute(root, "pwsh", args)).isError, true);
    assert.equal((await f.execute(root, "read", { file_path: join(f.workspace, "inside.txt") })).isError, true);
    assert.equal(f.counts().shellStarts, 1); assert.equal(f.counts().reads, 0); assert.equal(f.counts().approvals, 0);
  } finally { await f.dispose(); }
});

test("same-name Agent-local tool is untrusted, while native local registrations keep their scope and disposal", async () => {
  const f = await fixture({ outsideReads: "deny" });
  try {
    const root = await f.create(), child = await f.create();
    const unregister = child.ctx.tools.register({ name: "read", description: "Untrusted same-name third party", parameters: { type: "object" }, output: { schema: { type: "string" }, render: () => [] }, async execute() { return "thirdparty"; } });
    assert.equal((await f.execute(child, "read", { file_path: join(f.outside, "outside.txt") })).isError, false);
    assert.equal(f.controller().toolCoverage(child).some(row => row.kind === "read"), false); unregister();
    const fiber = child.ctx.plugin(ManagedFs, {}); await fiber.await();
    assert.equal(f.controller().toolCoverage(child).some(row => row.kind === "read"), true);
    assert.equal((await f.execute(child, "read", { file_path: join(f.outside, "outside.txt") })).isError, true);
    await fiber.dispose(); assert.equal(f.controller().toolCoverage(root).some(row => row.kind === "read"), true);
    await f.fsFiber.dispose(); assert.equal(f.controller().toolCoverage(root).some(row => row.kind === "read"), false);
    assert.equal(f.ctx.tools.get("read"), undefined);
  } finally { await f.dispose(); }
});

test("registration disposal and caller cancellation cancel pending native once approvals", async () => {
  const f = await fixture({ outsideReads: "ask" });
  const gate = deferred<"allowed-once">();
  try {
    const root = await f.create(), ready = deferred<void>();
    f.setAnswer(async () => { ready.resolve(); return gate.promise; });
    const waiting = f.execute(root, "read", { file_path: join(f.outside, "outside.txt") }); await ready.promise;
    await f.fsFiber.dispose(); assert.equal((await waiting).isError, true); assert.equal(f.counts().reads, 0);
    gate.resolve("allowed-once");
    const fiber = f.ctx.plugin(ManagedFs, {}); await fiber.await();
    const cancelled = new AbortController(); cancelled.abort();
    assert.equal((await f.execute(root, "read", { file_path: join(f.outside, "outside.txt") }, cancelled.signal)).isError, true); assert.equal(f.counts().reads, 0);
  } finally { gate.resolve("allowed-once"); await f.dispose(); }
});

test("Core permission policy changes do not veto a later native once approval; subsequent calls still honor never", async t => {
  for (const name of ["read", "web_search", "web_fetch"]) await t.test(name, async () => {
    const f = await fixture({ outsideReads: "ask", webSearch: { rule: "ask" }, webFetch: { rule: "ask" } });
    const ready = deferred<void>(), late = deferred<"allowed-once">();
    try {
      const root = await f.create();
      const args = name === "read" ? { file_path: join(f.outside, "outside.txt") } : name === "web_search" ? { queries: ["owned query"] } : { url: "https://example.invalid/" };
      f.setAnswer(async () => { ready.resolve(); return late.promise; });
      const pending = f.execute(root, name, args); await ready.promise;
      setApprovalPolicy(root.session, "never"); late.resolve("allowed-once");
      const result = await pending;
       assert.deepEqual({ isError: result.isError, reads: f.counts().reads, searches: f.counts().searches, fetches: f.counts().fetches }, { isError: false, reads: name === "read" ? 1 : 0, searches: name === "web_search" ? 1 : 0, fetches: name === "web_fetch" ? 1 : 0 });
       assert.deepEqual(root.session.snapshotEvents().filter(event => event.type === "approval/decided").map(event => event.data.outcome), ["allowed-once"]);
       assert.equal(f.counts().approvals, 1);
       assert.equal((await f.execute(root, name, args)).isError, true); assert.equal(f.counts().approvals, 1);
      setApprovalPolicy(root.session, "ask"); f.setAnswer(undefined);
      assert.equal((await f.execute(root, name, args)).isError, false);
      assert.equal(f.counts().approvals, 2);
    } finally { late.resolve("allowed-once"); await f.dispose(); }
  });
});

test("thin FS module keeps the original public plugin metadata", () => {
  assert.equal(ManagedFs.Config, NativeFs.Config); assert.equal(ManagedFs.inject, NativeFs.inject); assert.equal(ManagedFs.name, NativeFs.name);
});
