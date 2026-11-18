import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import * as NativeBash from "@deepseek-ai/dsh-tool-bash";
import * as NativePwsh from "@deepseek-ai/dsh-tool-pwsh";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition, ToolExecution } from "@deepseek-ai/dsh-tools";
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

test("linear unavailable initial authority retains the ordinary standing-full path without a grant", async t => {
  for (const failure of ["missing", "assert"] as const) await t.test(failure, async () => {
    const f = await permissionFixture(2000, { sandboxMode: "danger-full-access", settings: { nativeCommands: { enabled: true, entries: [] } } });
    try {
      await f.mountManagedShell(); f.setOutcome("rejected");
      if (failure === "missing") f.authorities.delete(f.root); else f.setPureDenied(true);
      const simple: boolean[] = [];
      f.ctx.on("tools/execute", async (exec, next) => { simple.push(f.permissions.isSimple(exec)); return next(); }, { global: true });
      for (const command of ["echo one", "echo one; echo two"]) {
        const result = await f.execute(command);
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
      }
      assert.deepEqual(simple, [false, false]); assert.equal(f.starts(), 2); assert.equal(f.nativeAnswers(), 0);
    } finally { await f.dispose(); }
  });
});

test("linear standing-full unknown reads retain blacklist-only semantics while a whitelisted Git deny is covered", async () => {
  const f = await permissionFixture(2000, { sandboxMode: "danger-full-access", guards: { scope: "always", gitWriteGuard: "deny" } });
  try {
    await f.mountManagedShell(); f.setOutcome("rejected");
    const command = "echo before; git push", nativeCommands = { enabled: true, entries: ["git push"] };
    const unknownPathRule = importPermissionRules([{ id: "outside", action: "deny", match: { kind: "outside-read", path: process.cwd(), scope: "tree" } }], "owned full-access fixture", 1);
    for (const policy of [{ outsideReads: "inherit" as const }, { outsideReads: "deny" as const }, { outsideReads: "inherit" as const, rules: unknownPathRule }]) {
      await f.update({ ...policy, nativeCommands });
      const result = await f.execute(command);
      assert.equal(result.isError, false, JSON.stringify({ policy, result }));
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    }
    await f.update({ nativeCommands, rules: exactRule("ask", command) });
    assert.equal((await f.execute(command)).isError, false);
    await f.update({ nativeCommands: { enabled: true, entries: ["git push", legacy] } });
    assert.equal((await f.execute("echo before; go test; git push")).isError, false);
    await f.update({ nativeCommands, rules: exactRule("deny", command) });
    const before = f.starts();
    assert.equal((await f.execute(command)).isError, true); assert.equal(f.starts(), before);
    await f.update({ nativeCommands: { enabled: true, entries: ["echo", "git push"] }, rules: exactRule("deny", command) });
    assert.equal((await f.execute(command)).isError, false);
    assert.equal(f.nativeAnswers(), 0);
  } finally { await f.dispose(); }
});

test("linear mixed scripts use standing-full guard semantics without inheriting a requested sandbox mode", async t => {
  for (const sandboxMode of ["danger-full-access", "workspace-write"] as const) for (const gitWriteGuard of ["ask", "deny"] as const) {
    await t.test(`${sandboxMode}/${gitWriteGuard}`, async () => {
      const f = await permissionFixture(2000, { sandboxMode, guards: { scope: "always", gitWriteGuard, shellCommandSafety: true },
        settings: { nativeCommands: { enabled: true, entries: gitWriteGuard === "deny" ? ["git push"] : [] } } });
      try {
        await f.mountManagedShell(); f.setOutcome("rejected");
        const simple: boolean[] = [];
        f.ctx.on("tools/execute", async (exec, next) => { simple.push(f.permissions.isSimple(exec)); return next(); }, { global: true });
        const full = sandboxMode === "danger-full-access";
        if (gitWriteGuard === "deny") {
          assert.equal((await f.execute("source ./env")).isError, !full);
          const result = await f.execute("source ./env; git push", { sandbox_permissions: "danger-full-access", justification: "Independent requested escalation" });
          assert.equal(result.isError, !full, JSON.stringify(result));
          if (full) assert.deepEqual(simple, [false, true]);
          else assert.equal(f.starts(), 0);
        } else {
          const result = await f.execute("echo before; git push");
          assert.equal(result.isError, !full, JSON.stringify(result));
          if (full) assert.deepEqual(simple, [true], "standing-full Git ask must not prevent linear qualification");
          else assert.equal(f.starts(), 0);
        }
      } finally { await f.dispose(); }
    });
  }
});

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
        assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, command.includes(";") ? "danger-full-access" : "workspace-write");
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

test("linear wrappers do not inherit a wrapped whitelist, and existing dialect deny is component-coverable", async () => {
  const f = await permissionFixture(2000, { guards: { scope: "always", gitWriteGuard: "deny", shellCommandSafety: true },
    settings: { nativeCommands: { enabled: true, entries: ["git push"] } } });
  try {
    await f.mountManagedShell(); f.setOutcome("rejected");
    assert.equal((await f.execute("echo before; env git push --force")).isError, true);
    await f.update({ nativeCommands: { enabled: true, entries: ["env"] } });
    assert.equal((await f.execute("echo before; env git push --force")).isError, false);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    assert.equal((await f.execute("echo before; source ./env")).isError, true);
    await f.update({ nativeCommands: { enabled: true, entries: ["source"] } });
    assert.equal((await f.execute("echo before; source ./env")).isError, false);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
  } finally { await f.dispose(); }
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
  for (const command of ["go test", "go test; echo tail"]) for (const mutation of ["arguments", "agent", "body", "registration", "owner", "disposed", "cancel", "retire", "config"] as const) await t.test(`${command}/${mutation}`, async () => {
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
      const result = await f.execute(command);
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

test("linear stock and managed scripts grant one full-access execution with zero whitelist hits, even for unclassified programs", async t => {
  for (const managed of [false, true]) for (const kind of ["bash", "pwsh"] as const) await t.test(`${managed ? "managed" : "stock"}/${kind}`, async () => {
    const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [] } } });
    try {
      if (managed) await f.mountManagedShell(kind); else await mountStock(f, kind);
      f.setOutcome("rejected");
      const standing = f.ctx.get("sandboxPolicy")!.resolve({ session: f.root.session });
      for (const command of ["echo one; echo two", "unknown-program foo\r\ngit unclassified-subcommand", "node -e 'code'; bash -c 'git push'", "echo one &&\n echo two || other | final", kind === "bash" ? "echo o\\\nne" : "echo `\r\none"]) {
        const before = f.starts(), result = await f.execute(command, {}, undefined, undefined, f.root, kind);
        assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(f.starts(), before + 1);
        assert.equal(f.specs.at(-1)!.command, command);
        assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
      }
      assert.equal(f.nativeAnswers(), 0);
      assert.deepEqual(f.ctx.get("sandboxPolicy")!.resolve({ session: f.root.session }), standing);
      await f.update({ nativeCommands: { enabled: false, entries: [] } });
      assert.equal((await f.execute("echo one; echo two", {}, undefined, undefined, f.root, kind)).isError, false);
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
    } finally { await f.dispose(); }
  });
});

test("linear Git qualification uses effective guard scope and covers every branch, independently of hook order", async t => {
  for (const guardsFirst of [false, true]) for (const gitWriteGuard of ["ask", "deny", "off"] as const) for (const gitWriteScope of ["all-writes", "high-risk"] as const) {
    await t.test(`${guardsFirst}/${gitWriteGuard}/${gitWriteScope}`, async () => {
      const f = await permissionFixture(2000, { guardsFirst, guards: { scope: "always", gitWriteGuard, gitWriteScope }, settings: { nativeCommands: { enabled: true, entries: ["git commit"] } } });
      try {
        await f.mountManagedShell(); f.setOutcome("rejected");
        assert.equal((await f.execute("echo before; git unclassified-subcommand")).isError, false);
        assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
        assert.equal((await f.execute("echo before; git commit -m owned; echo after")).isError, false);
        assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
        for (const [command, highRisk] of [["echo before && git push", false], ["echo before || git push --force", true], ["echo before | env git push --force", true]] as const) {
          const controlled = gitWriteGuard !== "off" && (gitWriteScope === "all-writes" || highRisk);
          const before = f.starts(), result = await f.execute(command);
          assert.equal(result.isError, controlled, JSON.stringify({ command, result }));
          assert.equal(f.starts(), before + (controlled ? 0 : 1));
          if (!controlled) assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
        }
      } finally { await f.dispose(); }
    });
  }
  for (const scope of ["off", "deepwork-or-dsmm-agent"] as const) {
    const f = await permissionFixture(2000, { guards: { scope, gitWriteGuard: "deny" }, settings: { nativeCommands: { enabled: true, entries: [] } } });
    try {
      await f.mountManagedShell();
      assert.equal((await f.execute("echo one; git push --force")).isError, false);
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    } finally { await f.dispose(); }
  }
});

test("linear unsupported syntax retains native handling without granting a matched prefix", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: commands } });
  try {
    await mountStock(f, "bash"); f.setOutcome("rejected");
    for (const command of ["node a.js > out; other", "node a.js; other $HOME", "node a.js;; other", "node a.js &&", "node a.js\\\r\nother", "X=value node a.js; other", "node a.js # comment\nother"]) {
      const result = await f.execute(command, { sandbox_permissions: "danger-full-access", justification: "Independent native request" }, undefined, undefined, f.root, "bash");
      assert.equal(result.isError, true, command); assert.equal(f.starts(), 0);
    }
    assert.equal(f.nativeAnswers(), 7);
    await mountStock(f, "pwsh");
    for (const command of ["echo ok`\ngit push", "echo ok`\r\ngit push"]) {
      assert.equal((await f.execute(command, { sandbox_permissions: "danger-full-access", justification: "Independent native request" })).isError, true);
      assert.equal(f.starts(), 0);
    }
    assert.equal(f.nativeAnswers(), 9);
  } finally { await f.dispose(); }
});

test("linear exact rules project only equal raw components; full-script constraints require every component whitelisted", async () => {
  const f = await permissionFixture();
  try {
    await f.mountManagedShell(); f.setOutcome("rejected");
    const command = "  go test ; echo tail ", component = "go test";
    for (const action of ["ask", "deny"] as const) {
      await f.update({ nativeCommands: { enabled: true, entries: [] }, rules: exactRule(action, component) });
      assert.equal((await f.execute(command)).isError, false);
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
      await f.update({ nativeCommands: { enabled: true, entries: ["go test"] }, rules: exactRule(action, component) });
      assert.equal((await f.execute(command)).isError, false);
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
      await f.update({ nativeCommands: { enabled: true, entries: ["go test"] }, rules: exactRule(action, command) });
      assert.equal((await f.execute(command)).isError, true);
      await f.update({ nativeCommands: { enabled: true, entries: ["go test", "echo"] }, rules: exactRule(action, command) });
      assert.equal((await f.execute(command)).isError, false);
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    }
    const base = exactRule("deny", component)[0];
    for (const rule of [{ ...base, revoked: true }, { ...base, match: { ...base.match, command: "go  test" } },
      { ...base, match: { ...base.match, executable: "other-shell" } }, { ...base, match: { ...base.match, workingDirectory: resolve(process.cwd(), "other") } }]) {
      await f.update({ nativeCommands: { enabled: true, entries: [] }, rules: [rule] });
      assert.equal((await f.execute(command)).isError, false);
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    }
    await f.update({ nativeCommands: { enabled: true, entries: [] }, rules: exactRule("deny", "go test") });
    assert.equal((await f.execute("go `\ntest; echo tail")).isError, false);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access", "internal continuation is not removed for exact matching");
    await f.update({ nativeCommands: { enabled: true, entries: ["echo"] }, rules: exactRule("deny", component) });
    assert.equal((await f.execute(command)).isError, false);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write", "another component's whitelist does not cover this rule");
  } finally { await f.dispose(); }
});

test("linear authorization keeps native never/deny, role/tool limits, outer asks and invocation identity", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [] } } });
  try {
    await mountStock(f, "pwsh"); f.setOutcome("rejected");
    const command = "echo one; echo two";
    f.setPureDenied(true);
    assert.equal((await f.execute(command, { sandbox_permissions: "danger-full-access", justification: "Independent native escalation" })).isError, true);
    f.setPureDenied(false);
    f.setPolicy("never"); assert.equal((await f.execute(command)).isError, true); f.setPolicy("ask");
    const restrict = f.root.ctx.tools.restrict({ deny: ["pwsh"] });
    try { assert.equal((await f.execute(command)).isError, true); } finally { restrict(); }
    const deny = f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "deny", reason: "Third party" }; }, { global: true });
    assert.equal((await f.execute(command)).isError, true); deny();
    const ask = f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Outer native purpose" }; }, { global: true, prepend: true });
    assert.equal((await f.execute(command)).isError, true); assert.equal(f.nativeAnswers(), 2); ask();
    const callId = ToolCallId("linear-shared-id"), signal = new AbortController().signal;
    const results = await Promise.all([f.execute(command, {}, signal, callId), f.execute(command, {}, signal, callId)]);
    assert.ok(results.every(result => !result.isError)); assert.equal(f.starts(), 2);
    assert.equal((await f.execute("unmatched", { sandbox_permissions: "danger-full-access", justification: "Separate call" }, signal, callId)).isError, true);
    const refresh = f.sync.refresh.bind(f.sync), ready = deferred<void>(), release = deferred<void>();
    let execution: Readonly<ToolExecution> | undefined;
    const capture = f.ctx.on("tools/pre-execute", async (exec, next) => { execution = exec; return next(); }, { global: true, prepend: true });
    f.sync.refresh = async () => { ready.resolve(); await release.promise; return refresh(); };
    const pending = f.execute(command); await ready.promise;
    assert.ok(execution); Reflect.set(execution, "arguments", { command: "other; replacement" }); release.resolve();
    assert.equal((await pending).isError, true); capture(); assert.equal(f.starts(), 2);
  } finally { await f.dispose(); }
});
