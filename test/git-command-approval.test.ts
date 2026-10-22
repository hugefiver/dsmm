import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as NativeBash from "@deepseek-ai/dsh-tool-bash";
import * as NativePwsh from "@deepseek-ai/dsh-tool-pwsh";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { TOOL_ABORTED_BEFORE_DISPATCH } from "@deepseek-ai/dsh-tools";
import { registerSafetyGuards } from "../src/guards.ts";
import { DeepworkModeController } from "../src/state.ts";
import { resolveConfig } from "../src/settings.ts";
import type { DsmmPluginConfig, DsmmSettingsGetter } from "../src/settings.ts";
import type { DshContext } from "../src/dsh-types.ts";
import { importPermissionRules } from "../src/permission-rules.ts";
import { CommandApprovals } from "../src/command-approval.ts";
import { installCorePermissions } from "../src/core-permissions.ts";
import { deferred, permissionFixture } from "./permission-fixture.ts";
import { nativeConfigRun } from "./permission-deployment-fixture.ts";
import type { PermissionFixture } from "./permission-fixture.ts";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";
useIsolatedDshEnvironment();
const sdk = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-tools"));
const { ApprovalService } = await import(pathToFileURL(sdk.resolve("@deepseek-ai/dsh-user-approval")).href);

const readonlyCompound = "Get-Location; git status --short; git branch --show-current; git remote -v; git log -8 --oneline; git status -sb; Get-Command go,make,golangci-lint -ErrorAction SilentlyContinue | Select-Object Name,Source; go version";
function safety(f: PermissionFixture, guards: DsmmPluginConfig["guards"] = {}) {
  const ctx = f.ctx as unknown as DshContext;
  let settings = resolveConfig({ guards: { scope: "always", ...guards } });
  const getter: DsmmSettingsGetter = () => settings;
  registerSafetyGuards(ctx, new DeepworkModeController(ctx), getter, undefined, f.permissions.commandApprovals);
  return (guards: DsmmPluginConfig["guards"]) => { settings = resolveConfig({ guards: { scope: "always", ...guards } }); };
}
async function stock(f: PermissionFixture, kind: "pwsh" | "bash" = "pwsh") {
  const fiber = f.ctx.plugin(kind === "pwsh" ? NativePwsh : NativeBash, { enableRunInBackground: false, promoteOnTimeout: false });
  await fiber.await(); return fiber;
}
const ruleIds = (f: PermissionFixture) => [...f.requests.at(-1)!.reason!.matchAll(/\[(git\.[^\]]+)\]/gu)].map(match => match[1]);

test("ordinary stock Shell remembers Git rules with permission control enabled or disabled", async t => {
  for (const enabled of [true, false]) for (const kind of ["pwsh", "bash"] as const) await t.test(`${enabled}/${kind}`, async () => {
    const f = await permissionFixture(2000, { settings: { enabled } });
    try {
      await stock(f, kind); safety(f);
      const definition = f.ctx.tools.get(kind, f.root);
      const run = (command: string) => f.execute(command, {}, undefined, undefined, f.root, kind);
      assert.equal((await run("git commit -m first")).isError, false);
      assert.equal((await run("git commit -m second")).isError, false); assert.equal(f.nativeAnswers(), 1);
      assert.equal(f.starts(), 2); assert.equal(f.ctx.tools.get(kind, f.root), definition);
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
      if (kind === "pwsh") { assert.equal((await run(readonlyCompound)).isError, false); assert.equal(f.nativeAnswers(), 1); }
      assert.equal((await run("git commit --amend -m third")).isError, false); assert.equal(f.nativeAnswers(), 2);
    } finally { await f.dispose(); }
  });
});

test("compound approvals retain every action and subtract only previously approved contributions", async () => {
  const f = await permissionFixture();
  try {
    await stock(f); safety(f);
    assert.equal((await f.execute("git add first.txt")).isError, false); assert.equal(f.nativeAnswers(), 1);
    assert.equal((await f.execute("git add second.txt; git reset --hard HEAD")).isError, false);
    assert.deepEqual(ruleIds(f), ["git.reset.hard"]); assert.equal(f.nativeAnswers(), 2);
    assert.equal((await f.execute("git add third.txt; git reset --hard HEAD~1")).isError, false); assert.equal(f.nativeAnswers(), 2);
    assert.equal((await f.execute("git reset --hard HEAD; git push --force origin main; git push --delete origin obsolete")).isError, false);
    assert.deepEqual(ruleIds(f), ["git.push.force", "git.push.delete"]); assert.equal(f.nativeAnswers(), 3);
    assert.equal((await f.execute("git push --force-with-lease origin other")).isError, false);
    assert.deepEqual(ruleIds(f), ["git.push.force-with-lease"]); assert.equal(f.nativeAnswers(), 4);
  } finally { await f.dispose(); }
});

test("high-risk scope still asks or denies later compound actions and retains exact shell rules", async () => {
  const command = "git add .";
  const rules = importPermissionRules([{ id: "explicit-add", action: "ask", match: { kind: "shell", executable: "pwsh.exe", command, workingDirectory: process.cwd() } }], "owned", 1);
  const f = await permissionFixture(2000, { settings: { rules } });
  try {
    await f.mountManagedShell(); const change = safety(f, { gitWriteScope: "high-risk" });
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 1);
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 1);
    assert.equal((await f.execute("git add other; git reset --hard HEAD")).isError, false);
    assert.deepEqual(ruleIds(f), ["git.reset.hard"]); assert.equal(f.nativeAnswers(), 2);
    assert.equal((await f.execute("git commit -m x; git push --force origin main")).isError, false);
    assert.deepEqual(ruleIds(f), ["git.push.force"]); assert.equal(f.nativeAnswers(), 3);
    change({ gitWriteScope: "high-risk", gitWriteGuard: "deny" });
    assert.equal((await f.execute("git add other")).isError, false);
    assert.equal((await f.execute("git add other; git reset --hard HEAD")).isError, true); assert.equal(f.nativeAnswers(), 3);
    await f.update({ rules: rules.map(rule => ({ ...rule, action: "deny" })) });
    assert.equal((await f.execute(command)).isError, true);
  } finally { await f.dispose(); }
});

test("Git memory binds literal target context, cwd, action and definition while uncertain contexts keep asking", async () => {
  const f = await permissionFixture();
  try {
    let mounted = await stock(f); safety(f);
    for (const command of ["git -C one commit -m first", "git -C one commit -m second"]) assert.equal((await f.execute(command)).isError, false);
    assert.equal(f.nativeAnswers(), 1);
    assert.equal((await f.execute("git -C two commit -m third")).isError, false); assert.equal(f.nativeAnswers(), 2);
    assert.equal((await f.execute("git -C one commit -m fourth", { workdir: resolve("other") })).isError, false); assert.equal(f.nativeAnswers(), 3);
    for (let index = 0; index < 2; index++) assert.equal((await f.execute('git commit -m "$message"')).isError, false);
    assert.equal(f.nativeAnswers(), 5);
    await mounted.dispose(); mounted = await stock(f);
    assert.equal((await f.execute("git -C one commit -m fifth")).isError, false); assert.equal(f.nativeAnswers(), 6);
    const child = await f.create(f.root);
    assert.equal((await f.execute("git -C one commit -m child", {}, undefined, undefined, child)).isError, false); assert.equal(f.nativeAnswers(), 7);
  } finally { await f.dispose(); }
});

test("cached stock calls retain independent asks, denials, never, tool restrictions and native widening", async t => {
  for (const enabled of [true, false]) await t.test(String(enabled), async () => {
    const f = await permissionFixture(2000, { settings: { enabled }, sandboxMode: "read-only" });
    try {
      await stock(f); safety(f); const command = "git commit -m owned";
      assert.equal((await f.execute(command)).isError, false);
      assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 1);
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "read-only");
      const ask = f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Independent native purpose" }; }, { global: true });
      f.setOutcome("rejected"); assert.equal((await f.execute(command)).isError, true); assert.equal(f.nativeAnswers(), 2); ask();
      const deny = f.ctx.on("tools/pre-execute", async () => ({ kind: "deny", reason: "Independent deny" }), { global: true });
      assert.equal((await f.execute(command)).isError, true); assert.equal(f.nativeAnswers(), 2); deny();
      const restrict = f.root.ctx.tools.restrict({ deny: ["pwsh"] });
      assert.equal((await f.execute(command)).isError, true); assert.equal(f.starts(), 2); restrict();
      const beforeNever = f.nativeAnswers();
      f.setPolicy("never"); assert.equal((await f.execute(command)).isError, true); assert.equal(f.nativeAnswers(), beforeNever);
      f.setPolicy("ask"); f.setOutcome("allowed-once");
      for (let index = 0; index < 2; index++) assert.equal((await f.execute(command, { sandbox_permissions: "workspace-write", justification: "Independent native widening" })).isError, false);
      assert.equal(f.nativeAnswers(), beforeNever + 2); assert.equal(f.starts(), 4);
    } finally { await f.dispose(); }
  });
});

test("generic final rejection, cancellation, audit failure and outer deny cannot seed Git memory", async t => {
  for (const outcome of ["outer-reject", "cancel", "audit", "outer-deny"] as const) await t.test(outcome, async () => {
    const f = await permissionFixture(2000, { settings: { enabled: false } });
    const ready = deferred<void>(), release = deferred<"allowed-once">(), abort = new AbortController();
    try {
      await stock(f); safety(f); const append = f.root.session.append.bind(f.root.session);
      let remove = () => {};
      if (outcome === "outer-reject") remove = f.ctx.on("approval/request", async (_request, next) => { await next(); return "rejected"; }, { global: true, prepend: true });
      if (outcome === "audit") f.root.session.append = ((...args: Parameters<typeof append>) => {
        if (args[0] === "approval/decided") throw new Error("Owned audit failure"); return Reflect.apply(append, f.root.session, args);
      }) as typeof append;
      if (outcome === "outer-deny") remove = f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "deny", reason: "Outer deny" }; }, { global: true, prepend: true });
      if (outcome === "cancel") f.setAnswer(async () => { ready.resolve(); return release.promise; });
      const first = f.execute("git commit -m first", {}, abort.signal);
      if (outcome === "cancel") { await ready.promise; abort.abort(); }
      const result = await first;
      assert.equal(result.isError, true); assert.equal(f.starts(), 0);
      if (outcome === "cancel") {
        assert.equal(result.error?.info?.code, TOOL_ABORTED_BEFORE_DISPATCH);
        assert.equal(result.error?.info?.name, "AbortError");
      }
      remove(); f.root.session.append = append; release.resolve("allowed-once"); f.setAnswer(undefined);
      assert.equal((await f.execute("git commit -m second")).isError, false); assert.equal(f.nativeAnswers(), 2);
      assert.equal((await f.execute("git commit -m third")).isError, false); assert.equal(f.nativeAnswers(), 2);
    } finally { release.resolve("allowed-once"); await f.dispose(); }
  });
});

test("generic cancellation while awaiting downstream preserves native abort results without remembering a rule", async () => {
  const f = await permissionFixture(2000, { settings: { enabled: false } });
  const ready = deferred<void>(), release = deferred<void>(), abort = new AbortController();
  try {
    await stock(f); safety(f);
    const remove = f.ctx.on("tools/pre-execute", async (_exec, next) => {
      const decision = await next(); ready.resolve(); await release.promise; return decision;
    }, { global: true });
    const pending = f.execute("git commit -m first", {}, abort.signal);
    await ready.promise; abort.abort(); release.resolve();
    const result = await pending;
    assert.equal(result.error?.info?.code, TOOL_ABORTED_BEFORE_DISPATCH);
    assert.equal(result.error?.info?.name, "AbortError");
    assert.equal(f.starts(), 0); assert.equal(f.nativeAnswers(), 0); remove();
    assert.equal((await f.execute("git commit -m second")).isError, false); assert.equal(f.nativeAnswers(), 1);
    assert.equal((await f.execute("git commit -m third")).isError, false); assert.equal(f.nativeAnswers(), 1);
  } finally { release.resolve(); await f.dispose(); }
});

test("generic cached invocation and pending invocation cannot borrow another valid token before the guard", async t => {
  for (const cached of [false, true]) await t.test(String(cached), async () => {
    const f = await permissionFixture(2000, { settings: { enabled: false } });
    const executions: Readonly<ToolExecution>[] = [], ready = deferred<void>(), release = deferred<void>();
    try {
      await stock(f); safety(f);
      if (cached) assert.equal((await f.execute("git commit -m warm")).isError, false);
      f.ctx.on("tools/pre-execute", async (exec, next) => {
        const decision = await next(); executions.push(exec); if (executions.length === 2) ready.resolve(); await release.promise; return decision;
      }, { global: true, prepend: true });
      const first = f.execute("git commit -m first"), second = f.execute("git commit -m second"); await ready.promise;
      Reflect.set(executions[0], "token", executions[1].token); release.resolve();
      assert.equal((await first).isError, true); assert.equal((await second).isError, false); assert.equal(f.starts(), cached ? 2 : 1);
    } finally { release.resolve(); await f.dispose(); }
  });
});

test("stock cached-call arguments, session and registration changes are rejected at the existing guard", async t => {
  for (const mutation of ["arguments", "session", "registration"] as const) await t.test(mutation, async () => {
    const f = await permissionFixture(2000, { settings: { enabled: false } });
    try {
      let mounted = await stock(f); safety(f);
      assert.equal((await f.execute("git commit -m first")).isError, false);
      const originalSession = f.root.session, other = await f.create();
      const remove = f.ctx.on("tools/pre-execute", async (exec, next) => {
        const decision = await next();
        if (mutation === "arguments") assert.equal(Reflect.set(exec, "arguments", { ...(exec.arguments as object), command: "git push --force origin main" }), true);
        if (mutation === "session") assert.equal(Reflect.set(f.root, "session", other.session), true);
        if (mutation === "registration") { await mounted.dispose(); mounted = await stock(f); }
        return decision;
      }, { global: true, prepend: true });
      try { assert.equal((await f.execute("git commit -m second")).isError, true); assert.equal(f.starts(), 1); }
      finally { remove(); if (mutation === "session") assert.equal(Reflect.set(f.root, "session", originalSession), true); }
      assert.equal((await f.execute("git commit -m third")).isError, false);
      assert.equal(f.nativeAnswers(), mutation === "arguments" ? 1 : 2);
    } finally { await f.dispose(); }
  });
});

test("tool failure does not revoke a completed command approval", async () => {
  const f = await permissionFixture(2000, { async shellExecution() { throw new Error("Owned executor failure"); } });
  try {
    await stock(f); safety(f);
    assert.equal((await f.execute("git commit -m first")).isError, true);
    assert.equal((await f.execute("git commit -m second")).isError, true);
    assert.equal(f.nativeAnswers(), 1); assert.equal(f.starts(), 2);
  } finally { await f.dispose(); }
});

test("real Core source revocation invalidates Git memory across A-B-A native configuration edits", async t => {
  for (const enabled of [true, false]) await t.test(String(enabled), async () => {
    const run = nativeConfigRun();
    const ready = deferred<void>(), release = deferred<"allowed-once">();
    try {
      const profile = await run.createProfile(`git-memory-${enabled}`, { permissionControl: { enabled }, guards: { scope: "always", gitWriteScope: "all-writes" } });
      const ctx = profile.ctx, root = await profile.create(), lifetime = new AbortController(), owner = {};
      root.session.append("turn/start", { turn: 1 });
      await ctx.plugin(ApprovalService, { policy: "ask" }).await();
      let asks = 0, starts = 0, wait = false;
      ctx.on("approval/request", async request => {
        asks++;
        if (wait) { ready.resolve(); await release.promise; assert.equal(request.signal?.aborted, false); }
        return "allowed-once";
      }, { global: true });
      ctx.provide("shellEnv", { collect() { return {}; } });
      ctx.provide("workingDirectory", { async ensure() { return run.root; } });
      ctx.provide("sandboxPolicy", { resolve() { return { mode: "workspace-write", workspaceRoot: run.root }; } });
      ctx.provide("shell", { sandboxMode: "workspace-write", resolve(request: Record<string, unknown>) { return { timeoutMs: 1000, ...request }; },
        async execute(spec: Record<string, unknown>) { (spec.signal as AbortSignal).throwIfAborted(); starts++; return {
          result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
            stdout: { text: "counted", truncated: false }, stderr: { text: "", truncated: false } }),
        }; } });
      const memory = new CommandApprovals(ctx);
      const controller = installCorePermissions(ctx, profile.deployment, {
        current(exec) { return { agent: exec.agent!, root, realm: ctx, owner, ownerGeneration: 1, admissionRevision: "fixture", permissionRevision: "fixture", signal: lifetime.signal }; },
        assertCurrent() {},
      }, () => {}, memory);
      // Keep this getter identity stable: only the real source backend can revoke this grant.
      const settings = (await profile.deployment.readDesired()).settings;
      registerSafetyGuards(ctx as unknown as DshContext, new DeepworkModeController(ctx as unknown as DshContext), () => settings, undefined, memory);
      await ctx.plugin(NativePwsh, { enableRunInBackground: false, promoteOnTimeout: false }).await();
      let calls = 0;
      const execute = (command = "git commit -m counted") => ctx.tools.execute({ name: "pwsh", callId: ToolCallId(`git-source-${++calls}`), agent: root,
        signal: lifetime.signal, arguments: { command, description: "Count a command", workdir: run.root } });
      const change = async (path: string[], value: unknown) => {
        const descriptor = profile.descriptor(); await profile.settings.mutate(descriptor.ns, [{ op: "set", path, value }], descriptor.revision);
      };
      assert.equal((await execute()).isError, false); assert.equal((await execute()).isError, false); assert.equal(asks, 1);
      await change(["guards", "gitWriteScope"], "high-risk"); await change(["guards", "gitWriteScope"], "all-writes");
      assert.equal((await execute()).isError, false); assert.equal(asks, 2);
      await change(["permissionControl", "outsideReads"], "deny"); await change(["permissionControl", "outsideReads"], "inherit");
      assert.equal((await execute()).isError, false); assert.equal(asks, 3);
      wait = true;
      const pending = execute("git reset --hard HEAD"); await ready.promise;
      await change(["guards", "gitWriteScope"], "high-risk"); await change(["guards", "gitWriteScope"], "all-writes");
      release.resolve("allowed-once"); assert.equal((await pending).isError, false); wait = false;
      assert.equal((await execute("git reset --hard HEAD~1")).isError, false); assert.equal(asks, 5); assert.equal(starts, 6);
      assert.equal(controller.rules.status().mounted, enabled); profile.assertLive();
    } finally { release.resolve("allowed-once"); await run.dispose(); }
  });
});
