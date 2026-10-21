import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import * as NativeBash from "@deepseek-ai/dsh-tool-bash";
import * as NativePwsh from "@deepseek-ai/dsh-tool-pwsh";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { registerSafetyGuards } from "../src/guards.ts";
import { DeepworkModeController } from "../src/state.ts";
import { resolveConfig } from "../src/settings.ts";
import type { DsmmSettingsGetter } from "../src/settings.ts";
import type { DshContext } from "../src/dsh-types.ts";
import { importPermissionRules } from "../src/permission-rules.ts";
import { deferred, permissionFixture } from "./permission-fixture.ts";
import type { PermissionFixture } from "./permission-fixture.ts";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";

useIsolatedDshEnvironment();
const commands = { enabled: true, entries: ["git", "go test", "node", "python"] };
const safety = (f: PermissionFixture, gitWriteGuard: "ask" | "deny" = "ask") => {
  const ctx = f.ctx as unknown as DshContext;
  const settings = resolveConfig({ guards: { scope: "always", gitWriteGuard } });
  registerSafetyGuards(ctx, new DeepworkModeController(ctx), (() => settings) as DsmmSettingsGetter);
};
const mountStock = async (f: PermissionFixture, kind: "bash" | "pwsh") => {
  const fiber = f.ctx.plugin(kind === "bash" ? NativeBash : NativePwsh, { enableRunInBackground: false, promoteOnTimeout: false });
  await fiber.await(); return fiber;
};
const exactRule = (action: "ask" | "deny", command = "go test") => importPermissionRules([
  { id: "shell", action, match: { kind: "shell", executable: "pwsh.exe", command, workingDirectory: process.cwd() } },
], "owned simple fixture", 1);
const legacy = { id: "legacy", mode: "ask" as const, sandboxMode: "danger-full-access" as const,
  match: { tool: "pwsh" as const, workingDirectory: process.cwd(), commandPattern: "go test" } };

test("simple stock native bash and pwsh grant exact full access without interactive approval or standing changes", async t => {
  for (const kind of ["bash", "pwsh"] as const) await t.test(kind, async () => {
    const f = await permissionFixture(2000, { settings: { nativeCommands: commands } });
    try {
      await mountStock(f, kind); safety(f, "deny"); f.setOutcome("rejected");
      const original = f.ctx.tools.get(kind, f.root)!;
      for (const workdir of [process.cwd(), resolve(process.cwd(), "child")]) {
        const command = kind === "pwsh" ? "git.exe commit -m owned" : "git commit -m owned";
        const result = await f.execute(command, { workdir }, undefined, undefined, f.root, kind);
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.deepEqual(f.specs.at(-1)!.sandboxPolicy, { mode: "danger-full-access", workspaceRoot: process.cwd() });
        assert.equal(f.specs.at(-1)!.workdir, workdir);
      }
      for (const sandbox_permissions of ["workspace-write", "danger-full-access"]) {
        assert.equal((await f.execute("go test", { sandbox_permissions, justification: "Model request" }, undefined, undefined, f.root, kind)).isError, false);
        assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
      }
      assert.equal(f.nativeAnswers(), 0); assert.equal(f.starts(), 4);
      assert.equal(f.ctx.tools.get(kind, f.root), original);
      for (const command of ["go version", "node a.js; other"]) {
        assert.equal((await f.execute(command, {}, undefined, undefined, f.root, kind)).isError, false);
        assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
      }
      await f.update({ nativeCommands: { enabled: false, entries: commands.entries } });
      assert.equal((await f.execute("go test", {}, undefined, undefined, f.root, kind)).isError, false);
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
      assert.equal(f.nativeAnswers(), 0); assert.equal(f.starts(), 7);
    } finally { await f.dispose(); }
  });
});

test("simple stock auto answers an exactly bound inner ask while native deny and never stay final", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: commands } });
  try {
    await mountStock(f, "pwsh"); safety(f);
    const ask = f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Native purpose" }; }, { global: true });
    f.setOutcome("rejected");
    assert.equal((await f.execute("git commit -m owned")).isError, false); assert.equal(f.starts(), 1); assert.equal(f.nativeAnswers(), 0);
    f.setPolicy("never"); assert.equal((await f.execute("git commit -m owned")).isError, true); assert.equal(f.starts(), 1); assert.equal(f.nativeAnswers(), 0);
    ask(); f.setPolicy("ask");
    f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "deny", reason: "Native denied" }; }, { global: true });
    assert.equal((await f.execute("git commit -m owned")).isError, true); assert.equal(f.starts(), 1);
  } finally { await f.dispose(); }
});

test("simple stock outer asks retain native outcomes and cannot lend approval to another exact invocation", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: commands } });
  try {
    await mountStock(f, "pwsh"); safety(f);
    const ask = f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Outer native purpose" }; }, { global: true, prepend: true });
    const signal = new AbortController().signal, callId = ToolCallId("owned-outer-native-purpose");
    const call = () => f.execute("git commit -m owned", {}, signal, callId);
    f.setOutcome("rejected");
    assert.equal((await call()).isError, true); assert.equal(f.starts(), 0); assert.equal(f.nativeAnswers(), 1);
    f.setOutcome("allowed-once");
    const allowed = await call();
    assert.equal(allowed.isError, false, JSON.stringify(allowed)); assert.equal(f.starts(), 1); assert.equal(f.nativeAnswers(), 2);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    f.setOutcome("rejected");
    assert.equal((await call()).isError, true); assert.equal(f.starts(), 1); assert.equal(f.nativeAnswers(), 3);
    f.setPolicy("never"); assert.equal((await call()).isError, true); assert.equal(f.starts(), 1); assert.equal(f.nativeAnswers(), 3);
    ask(); f.setPolicy("ask");
    f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "deny", reason: "Outer native denial" }; }, { global: true, prepend: true });
    assert.equal((await call()).isError, true); assert.equal(f.starts(), 1); assert.equal(f.nativeAnswers(), 3);
  } finally { await f.dispose(); }
});

test("simple managed matches precede DSMM Git outside-read shell deny and legacy asks or ambiguity", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: commands, rules: exactRule("deny"), outsideReads: "deny" } });
  try {
    await f.mountManagedShell(); safety(f, "deny"); f.setOutcome("rejected");
    for (const entries of [["go", legacy], ["go", legacy, { ...legacy, id: "ambiguous", sandboxMode: "workspace-write" as const }]]) {
      await f.update({ nativeCommands: { enabled: true, entries }, rules: exactRule("deny"), outsideReads: "deny" });
      assert.equal((await f.execute("go test")).isError, false);
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    }
    await f.update({ nativeCommands: { enabled: true, entries: ["git", "Get-Content"] }, outsideReads: "deny" });
    for (const command of ["git commit -m owned", "Get-Content ../outside.txt"]) assert.equal((await f.execute(command)).isError, false);
    for (const command of ["node -e 'console.log(1)'", 'python -c \'print("ok")\'']) {
      await f.update({ nativeCommands: commands, rules: exactRule("ask", command) });
      assert.equal((await f.execute(command)).isError, false);
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    }
    assert.equal(f.starts(), 6); assert.equal(f.nativeAnswers(), 0);
    await f.update({ nativeCommands: { enabled: true, entries: ["python", legacy] } });
    assert.equal((await f.execute("go test")).isError, true); assert.equal(f.nativeAnswers(), 1); assert.equal(f.starts(), 6);
    await f.update({ nativeCommands: { enabled: true, entries: ["python", { ...legacy, mode: "allow" }] } });
    assert.equal((await f.execute("go test")).isError, false); assert.equal(f.nativeAnswers(), 1);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    await f.update({ nativeCommands: commands, rules: exactRule("deny", "go version") });
    assert.equal((await f.execute("go version")).isError, true); assert.equal(f.starts(), 7);
  } finally { await f.dispose(); }
});

test("simple stock concurrent exact tokens do not lend full access approval to a following unmatched request", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: commands } });
  try {
    await mountStock(f, "pwsh"); f.setOutcome("rejected");
    const signal = new AbortController().signal, callId = ToolCallId("owned-concurrent-simple");
    const results = await Promise.all([f.execute("go test", {}, signal, callId), f.execute("go test", {}, signal, callId)]);
    assert.ok(results.every(result => !result.isError), JSON.stringify({ results, starts: f.starts(), answers: f.nativeAnswers() })); assert.equal(f.starts(), 2); assert.equal(f.nativeAnswers(), 0);
    const unmatched = await f.execute("go version", { sandbox_permissions: "danger-full-access", justification: "Independent unmatched request" }, signal, callId);
    assert.equal(unmatched.isError, true); assert.equal(f.starts(), 2); assert.equal(f.nativeAnswers(), 1);
  } finally { await f.dispose(); }
});

test("simple stock aliases use actual definitions and command-cmd-script precedence without trusting kind or unknown names", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: commands } });
  try {
    safety(f, "deny"); let entered = 0;
    for (const name of ["sh", "zsh", "powershell", "BASH", "terminal"]) {
      const definition: ToolDefinition = { name, description: "Owned shell convention", parameters: { type: "object", additionalProperties: true },
        output: { schema: { type: "string" }, render: () => [] }, execute: async args => {
          entered++; if (name !== "terminal") assert.equal((args as Record<string, unknown>).sandbox_permissions, "danger-full-access"); return "owned";
        } };
      f.ctx.tools.register(definition);
    }
    for (const name of ["sh", "zsh", "powershell", "BASH"]) {
      for (const extra of [{}, { command: null, cmd: "git commit -m owned", script: "ignored" }, { command: null, cmd: null, script: "git commit -m owned" }])
        assert.equal((await f.execute("git commit -m owned", extra, undefined, undefined, f.root, name)).isError, false);
    }
    assert.equal(entered, 12); assert.equal(f.nativeAnswers(), 0);
    let observed: boolean | undefined;
    f.ctx.on("tools/pre-execute", async (exec, next) => { if (exec.name === "terminal") observed = await f.controller.simpleCommandAllowed(exec); return next(); }, { global: true, prepend: true });
    assert.equal((await f.execute("git commit -m owned", { kind: "shell" }, undefined, undefined, f.root, "terminal")).isError, false);
    assert.equal(observed, false);
  } finally { await f.dispose(); }
});

test("simple stock late registration unload replacement and controller retirement preserve original tool ownership", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: commands } });
  try {
    assert.equal((await f.execute("go test")).isError, true);
    const stock = await mountStock(f, "pwsh");
    assert.equal((await f.execute("go test")).isError, false); assert.equal(f.starts(), 1); assert.equal(f.nativeAnswers(), 0);
    await stock.dispose(); assert.equal((await f.execute("go test")).isError, true); assert.equal(f.starts(), 1);
    const replacement = await mountStock(f, "pwsh");
    const definition = f.ctx.tools.get("pwsh", f.root)!;
    assert.equal((await f.execute("go test")).isError, false); assert.equal(f.starts(), 2);
    const restriction = f.root.ctx.tools.restrict({ deny: ["pwsh"] });
    try { assert.equal((await f.execute("go test")).isError, true); assert.equal(f.starts(), 2); } finally { restriction(); }
    const guard = f.runtime.guard(() => "Global tool denial");
    try { assert.equal((await f.execute("go test")).isError, true); assert.equal(f.starts(), 2); } finally { guard(); }
    f.controller.retire(); assert.equal(f.ctx.tools.get("pwsh", f.root), definition);
    assert.equal((await f.execute("go test")).isError, false); assert.equal(f.starts(), 3);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
    await replacement.dispose(); assert.equal(f.ctx.tools.get("pwsh", f.root), undefined);
  } finally { await f.dispose(); }
});

test("simple stock retirement does not overwrite a newer body on the same actual definition", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: commands } });
  try {
    await mountStock(f, "pwsh");
    const definition = f.ctx.tools.get("pwsh", f.root)!, original = definition.execute;
    assert.equal((await f.execute("go test")).isError, false);
    let replacementCalls = 0;
    const replacement: ToolDefinition["execute"] = async (args, exec) => { replacementCalls++; return original.call(definition, args, exec); };
    Reflect.set(definition, "execute", replacement);
    f.controller.retire();
    assert.equal((await f.execute("go test")).isError, false); assert.equal(replacementCalls, 1);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
  } finally { await f.dispose(); }
});

test("simple probe refresh failure retains standing full access and native nonfull rejection without using stale matches", async t => {
  for (const enabled of [false, true]) for (const sandboxMode of ["danger-full-access", "workspace-write"] as const) {
    await t.test(`${enabled ? "previously matching" : "disabled"}/${sandboxMode}`, async () => {
      const f = await permissionFixture(2000, { sandboxMode, settings: { nativeCommands: { enabled, entries: commands.entries } } });
      try {
        await f.mountManagedShell(); f.setOutcome("rejected");
        if (sandboxMode === "danger-full-access") f.authorities.delete(f.root);
        const failure = new Error("Owned permission source unavailable");
        f.sync.refresh = async () => { throw failure; };
        const result = await f.execute("go test");
        assert.equal(result.isError, sandboxMode !== "danger-full-access", JSON.stringify(result));
        assert.equal(f.nativeAnswers(), 0);
        assert.equal(f.starts(), sandboxMode === "danger-full-access" ? 1 : 0);
        if (sandboxMode === "danger-full-access") assert.equal((f.specs[0].sandboxPolicy as { mode: string }).mode, sandboxMode);
        else assert.equal(result.error?.message, failure.message);
      } finally { await f.dispose(); }
    });
  }
});

test("simple stock pending invalid registration is retired before a subsequent call can wrap the original body", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: commands } });
  const ready = deferred<void>(), release = deferred<void>();
  let pending: ReturnType<typeof f.execute> | undefined;
  try {
    await mountStock(f, "pwsh");
    const definition = f.ctx.tools.get("pwsh", f.root)!;
    const originalDescriptor = Object.getOwnPropertyDescriptor(definition, "execute");
    f.ctx.on("tools/execute", async (exec, next) => {
      if ((exec.arguments as Record<string, unknown>).command === "go test A") { ready.resolve(); await release.promise; }
      return next();
    }, { global: true, prepend: true });
    pending = f.execute("go test A"); await ready.promise;
    const firstWrapper = definition.execute;
    Reflect.set(definition, "description", `${definition.description} owned field update`);
    const attempt = await f.execute("go test B");
    const bodyDuringPending = definition.execute;
    assert.equal(attempt.isError, true); assert.equal(f.starts(), 0);
    release.resolve(); assert.equal((await pending).isError, true); assert.equal(f.starts(), 0);
    const retiredDescriptor = Object.getOwnPropertyDescriptor(definition, "execute");
    const subsequent = await f.execute("go test C");
    assert.equal(subsequent.isError, false, JSON.stringify(subsequent));
    assert.equal(bodyDuringPending, firstWrapper);
    assert.deepEqual(retiredDescriptor, originalDescriptor);
    assert.equal(f.starts(), 1); assert.equal(f.nativeAnswers(), 0);
    assert.equal((f.specs[0].sandboxPolicy as { mode: string }).mode, "danger-full-access");
  } finally { release.resolve(); if (pending !== undefined) await pending; await f.dispose(); }
});

test("simple stock invocation identity cannot transfer across argument agent body registration owner cancellation or retirement changes", async t => {
  for (const mutation of ["arguments", "agent", "body", "registration", "owner", "disposed", "cancel", "retire", "config"] as const) await t.test(mutation, async () => {
    const f = await permissionFixture(2000, { settings: { nativeCommands: commands } });
    try {
      const stock = await mountStock(f, "pwsh");
      const alternate = mutation === "agent" ? await f.create() : undefined;
      f.ctx.on("tools/execute", async (exec, next) => {
        if (mutation === "arguments") Reflect.set(exec, "arguments", { command: "other" });
        if (mutation === "agent") Reflect.set(exec, "agent", alternate);
        if (mutation === "body") Reflect.set(f.ctx.tools.get("pwsh", f.root)!, "execute", async () => { throw new Error("replacement must not run"); });
        if (mutation === "registration") { await stock.dispose(); await mountStock(f, "pwsh"); }
        if (mutation === "owner") f.authorities.delete(f.root);
        if (mutation === "disposed") await f.disposeAgent(f.root);
        if (mutation === "cancel") f.lifetime.abort();
        if (mutation === "retire") f.controller.retire();
        if (mutation === "config") await f.update({ nativeCommands: { enabled: false, entries: [] } });
        return next();
      }, { global: true, prepend: true });
      const result = await f.execute("go test");
      assert.equal(result.isError, mutation !== "config", JSON.stringify(result));
      assert.equal(f.starts(), mutation === "config" ? 1 : 0); assert.equal(f.nativeAnswers(), 0);
    } finally { await f.dispose(); }
  });
});

test("simple stock retains readonly tool filtering global guards native never cancellation and refresh identity", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: commands } });
  const ready = deferred<void>(), gate = deferred<void>();
  try {
    await mountStock(f, "pwsh"); safety(f, "deny");
    f.setPureDenied(true); assert.equal((await f.execute("go test")).isError, true); f.setPureDenied(false);
    const restriction = f.root.ctx.tools.restrict({ deny: ["pwsh"] });
    try { assert.equal((await f.execute("go test")).isError, true); } finally { restriction(); }
    const guard = f.runtime.guard(() => "Global tool denial");
    try { assert.equal((await f.execute("go test")).isError, true); } finally { guard(); }
    f.setPolicy("never"); assert.equal((await f.execute("go test")).isError, true); f.setPolicy("ask");
    const abort = new AbortController(); abort.abort(); assert.equal((await f.execute("go test", {}, abort.signal)).isError, true);
    const refresh = f.sync.refresh.bind(f.sync);
    f.sync.refresh = async () => { ready.resolve(); await gate.promise; return refresh(); };
    const pending = f.execute("go test"); await ready.promise;
    Reflect.set(f.ctx.tools.get("pwsh", f.root)!, "execute", async () => { throw new Error("replacement must not run"); });
    gate.resolve(); assert.equal((await pending).isError, true); assert.equal(f.starts(), 0); assert.equal(f.nativeAnswers(), 0);
  } finally { gate.resolve(); await f.dispose(); }
});
