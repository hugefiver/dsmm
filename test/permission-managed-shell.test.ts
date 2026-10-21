import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ToolCallId, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { PreToolDecision, ToolDefinition } from "@deepseek-ai/dsh-tools";
import { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH } from "@deepseek-ai/dsh-tools";
import { deferred, permissionFixture } from "./permission-fixture.ts";
import { importPermissionRules } from "../src/permission-rules.ts";
import type { NativeCommandEntry } from "../src/permission-settings.ts";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";
useIsolatedDshEnvironment();
const command = "go test -count=1 .";
export const commandEntry = (mode: "allow" | "ask", tool: "bash" | "pwsh" = "pwsh"): NativeCommandEntry => ({ id: "go", mode, sandboxMode: "danger-full-access", match: { tool, commandPattern: "go test", workingDirectory: process.cwd() } });
const shellRule = (action: "ask" | "allow" | "deny") => importPermissionRules([{ id: "bounded", action, match: { kind: "shell", executable: "pwsh.exe", command, workingDirectory: process.cwd() } }], "direct-file", 1);

test("default/off/unknown native once and configured allow use original body without DSMM peer", async () => {
  const f = await permissionFixture();
  try {
    await f.mountManagedShell();
    for (const value of [command, "unknown-command --arbitrary", "Write-Output x; Write-Output y"]) assert.equal((await f.execute(value)).isError, false);
    assert.equal(f.nativeAnswers(), 0); assert.equal(f.starts(), 3);
    await f.update({ nativeCommands: { enabled: true, entries: [commandEntry("allow")] } });
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 0);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    await f.update({ nativeCommands: { enabled: false, entries: [commandEntry("allow")] } });
    assert.equal((await f.execute(command)).isError, false);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
    assert.equal(f.ctx.tools.constructor.name, "ToolRuntime");
  } finally { await f.dispose(); }
});
test("native bash registration retains its own dialect/tool match and original Config/body surface", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [commandEntry("allow")] } } });
  try {
    await f.mountManagedShell("bash");
    const call = () => f.execute(command, {}, undefined, ToolCallId(randomUUID()), f.root, "bash");
    assert.equal((await call()).isError, false); assert.equal(f.nativeAnswers(), 0); assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
    await f.update({ nativeCommands: { enabled: true, entries: [commandEntry("ask", "bash")] } });
    assert.equal((await call()).isError, false); assert.equal(f.nativeAnswers(), 1); assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    f.setOutcome("rejected"); assert.equal((await call()).isError, true); assert.equal(f.starts(), 2);
  } finally { await f.dispose(); }
});
test("B ask and C same-purpose native ask are single interactive grants and never remembered", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [commandEntry("ask")] } } });
  let nextCalls = 0;
  try {
    await f.mountManagedShell();
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 1);
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 2);
    f.ctx.on("tools/pre-execute", async (_exec, next) => { nextCalls++; await next(); return { kind: "ask", reason: "native purpose", displayReason: { en: "Native purpose", zh: "原生目的" } }; }, { global: true });
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 3); assert.equal(nextCalls, 1);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    assert.equal(f.requests.at(-1)!.reason!.includes(command), true);
    assert.equal(f.requests.at(-1)!.displayReason!.zh.includes("原生目的"), true);
    const before = f.starts();
    for (const outcome of ["rejected", "cancelled", "unavailable"] as const) { f.setOutcome(outcome); assert.equal((await f.execute(command)).isError, true); }
    assert.equal(f.starts(), before);
    f.setPolicy("never"); const answers = f.nativeAnswers(); assert.equal((await f.execute(command)).isError, true); assert.equal(f.nativeAnswers(), answers);
  } finally { await f.dispose(); }
});
test("outer middleware allow preserves the exact target authorized by the original native request", async () => {
  const f = await permissionFixture(2000, { settings: { rules: shellRule("ask"), nativeCommands: { enabled: true, entries: [commandEntry("allow")] } } });
  try {
    await f.mountManagedShell();
    f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Native exact invocation purpose" }; }, { global: true });
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.nativeAnswers(), 1); assert.equal(f.starts(), 1);
    let observed: PreToolDecision | undefined, targetBeforeBody: string | undefined;
    f.ctx.on("tools/execute", async (exec, next) => { targetBeforeBody = f.controller.nativeAccess(exec).approvedSandboxMode; return next(); }, { global: true });
    const remove = f.ctx.on("tools/pre-execute", async (_exec, next) => { observed = await next(); return { kind: "allow" }; }, { global: true, prepend: true });
    const value = await f.execute(command);
    assert.equal(observed?.kind, "allow"); assert.equal(targetBeforeBody, "danger-full-access");
    assert.equal(value.isError, false); assert.equal(f.starts(), 2); assert.equal(f.nativeAnswers(), 2); remove();
  } finally { await f.dispose(); }
});
test("same-level official mode preserves rule and command asks without widening their native target", async t => {
  const raw = "go test", explicit = { sandbox_permissions: "workspace-write", justification: "Use the current native workspace policy" };
  const rules = importPermissionRules([{ id: "owned-purpose", action: "ask", match: { kind: "shell", executable: "pwsh.exe", command: raw, workingDirectory: process.cwd() } }], "owned configuration", 1);
  for (const settings of [{ rules }, { nativeCommands: { enabled: true, entries: [commandEntry("ask")] } }]) {
    await t.test(settings.rules === undefined ? "command ask" : "shell rule ask", async () => {
      const f = await permissionFixture(2000, { settings });
      try {
        await f.mountManagedShell(); f.setOutcome("rejected");
        const rejected = await f.execute(raw, explicit);
        assert.equal(rejected.isError, true, JSON.stringify({ rejected, answers: f.nativeAnswers(), starts: f.starts() })); assert.equal(f.nativeAnswers(), 1); assert.equal(f.starts(), 0);
        f.setOutcome("allowed-once"); assert.equal((await f.execute(raw, explicit)).isError, false); assert.equal(f.nativeAnswers(), 2);
        assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
        f.setPolicy("never"); assert.equal((await f.execute(raw, explicit)).isError, true); assert.equal(f.nativeAnswers(), 2); assert.equal(f.starts(), 1);
      } finally { await f.dispose(); }
    });
  }
});
test("command entries only widen an actual native spec and preserve an already authorized wider standing policy", async () => {
  const f = await permissionFixture(2000, { sandboxMode: "danger-full-access", settings: { nativeCommands: { enabled: true, entries: [{ ...commandEntry("allow"), sandboxMode: "workspace-write" }] } } });
  try {
    await f.mountManagedShell(); assert.equal((await f.execute(command)).isError, false);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
  } finally { await f.dispose(); }
});
test("standing native full access has no DSMM extra ask or unknown-facts denial, but a definite blacklist denies before approval", async () => {
  const rules = importPermissionRules([{ id: "outside-secret", action: "deny", match: { kind: "outside-read", path: process.cwd(), scope: "tree" } }], "owned configuration", 1);
  const f = await permissionFixture(2000, { sandboxMode: "danger-full-access", settings: { outsideReads: "ask", nativeCommands: { enabled: false } } });
  try {
    await f.mountManagedShell();
    for (const raw of [command, "unknown-command --arbitrary", "Get-Content ../outside.txt", "Write-Output x; Write-Output y"]) {
      assert.equal((await f.execute(raw)).isError, false);
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    }
    await f.update({ outsideReads: "deny", rules, nativeCommands: { enabled: true, entries: [commandEntry("ask")] } });
    assert.equal((await f.execute(command)).isError, false); // Missing read proof is not a blacklist match.
    assert.equal(f.nativeAnswers(), 0); assert.equal(f.starts(), 5);
    await f.update({ rules: shellRule("deny") });
    assert.equal((await f.execute(command)).isError, true); assert.equal(f.starts(), 5); assert.equal(f.nativeAnswers(), 0);
  } finally { await f.dispose(); }
});
test("native approval remains final across a pending source blacklist change and publishes only its exact once target", async () => {
  let access: ReturnType<Awaited<ReturnType<typeof permissionFixture>>["controller"]["nativeAccess"]> | undefined;
  const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [commandEntry("ask")] } } });
  const ready = deferred<Parameters<typeof f.ctx.approval.request>[0]>(), release = deferred<"allowed-once">();
  try {
    await f.mountManagedShell();
    const sandbox = f.ctx.get("sandboxPolicy") as { resolve(request: { session: typeof f.root.session }): unknown };
    const standingPolicy = sandbox.resolve({ session: f.root.session });
    f.ctx.on("tools/execute", async (exec, next) => { access = f.controller.nativeAccess(exec); return next(); }, { global: true });
    f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Native exact call" }; }, { global: true });
    f.setAnswer(async request => { ready.resolve(request); return release.promise; });
    const call = f.execute(command, { sandbox_permissions: "workspace-write", justification: "Approve only workspace writes" });
    const request = await ready.promise;
    await f.update({ rules: shellRule("deny") }); assert.equal(request.signal?.aborted, false);
    f.setPureDenied(true); release.resolve("allowed-once");
    assert.equal((await call).isError, false); assert.equal(f.nativeAnswers(), 1); assert.equal(f.starts(), 1);
    assert.deepEqual(access, { standingFullAccess: false, approvedSandboxMode: "workspace-write" });
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
    assert.equal((await f.execute(command)).isError, true); assert.equal(f.starts(), 1);
    assert.deepEqual(sandbox.resolve({ session: f.root.session }), standingPolicy);
  } finally { release.resolve("allowed-once"); await f.dispose(); }
});
test("closure-owned exact targets survive native metadata rewrites and final answer overrides without another approval", async t => {
  for (const target of ["entry", "official-no-entry"] as const) for (const outer of ["metadata", "final-answer"] as const) await t.test(`${target}/${outer}`, async () => {
    const standing = target === "entry" ? "workspace-write" : "read-only";
    const mode = target === "entry" ? "danger-full-access" : "workspace-write";
    const f = await permissionFixture(2000, { sandboxMode: standing, settings: { rules: shellRule("ask"),
      ...target === "entry" ? { nativeCommands: { enabled: true, entries: [commandEntry("ask")] } } : {} } });
    try {
      await f.mountManagedShell();
      f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Native exact purpose", displayReason: { en: "Native exact purpose", zh: "原生目的" } }; }, { global: true });
      if (outer === "metadata") {
        f.ctx.on("tools/pre-execute", async (_exec, next) => { const decision = await next(); return decision.kind === "ask" ? { ...decision, displayReason: { ...decision.displayReason!, en: decision.displayReason!.en } } : { ...decision }; }, { global: true, prepend: true });
        f.setAnswer(async () => { assert.equal(f.starts(), 0); await f.update({ rules: shellRule("deny") }); return "allowed-once"; });
      } else {
        f.setOutcome("rejected");
        f.ctx.on("approval/request", async (_request, next) => { await next(); assert.equal(f.starts(), 0); await f.update({ rules: shellRule("deny") }); return "allowed-once"; }, { global: true, prepend: true });
      }
      const extra = target === "entry" ? {} : { sandbox_permissions: mode, justification: "Approve this exact workspace target only" };
      const result = await f.execute(command, extra);
      assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(f.starts(), 1); assert.equal(f.nativeAnswers(), 1);
      assert.equal((f.specs[0].sandboxPolicy as { mode: string }).mode, mode);
      assert.equal(f.requests[0].reason?.includes(command), true); assert.equal(f.requests[0].displayReason?.zh.includes("原生目的"), true);
      assert.deepEqual(f.root.session.snapshotEvents().filter(event => event.type === "approval/decided").map(event => event.data.outcome), ["allowed-once"]);
      assert.equal((await f.execute(command, extra)).isError, true); assert.equal(f.starts(), 1); assert.equal(f.nativeAnswers(), 1);
      await f.update({ nativeCommands: { enabled: false } }); f.setAnswer(undefined);
      const removeAsk = f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "allow" }; }, { global: true, prepend: true });
      assert.equal((await f.execute("Write-Output following")).isError, false);
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, standing); removeAsk();
    } finally { await f.dispose(); }
  });
});
test("an approved target cannot transfer through changed invocation arguments or a disposed registration", async t => {
  for (const replacement of ["arguments", "registration"] as const) await t.test(replacement, async () => {
    const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [commandEntry("ask")] } } });
    try {
      const mounted = await f.mountManagedShell();
      f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Native exact target" }; }, { global: true });
      f.ctx.on("tools/execute", async (exec, next) => {
        if (replacement === "registration") await mounted.dispose();
        else Reflect.set(exec, "arguments", { ...(exec.arguments as Record<string, unknown>), command: "go test changed" });
        return next();
      }, { global: true });
      assert.equal((await f.execute(command)).isError, true); assert.equal(f.nativeAnswers(), 1); assert.equal(f.starts(), 0);
    } finally { await f.dispose(); }
  });
});
test("a new independent outer native ask retains its own rejection after an exact target was approved", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [commandEntry("ask")] } } });
  try {
    await f.mountManagedShell();
    f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Native exact target" }; }, { global: true });
    f.ctx.on("tools/pre-execute", async (_exec, next) => {
      const decision = await next(); return decision.kind === "allow" ? { kind: "ask", reason: "Independent native purpose" } : decision;
    }, { global: true, prepend: true });
    f.setAnswer(async () => f.nativeAnswers() === 1 ? "allowed-once" : "rejected");
    assert.equal((await f.execute(command)).isError, true); assert.equal(f.nativeAnswers(), 2); assert.equal(f.starts(), 0);
    assert.deepEqual(f.root.session.snapshotEvents().filter(event => event.type === "approval/decided").map(event => event.data.outcome), ["allowed-once", "rejected"]);
  } finally { await f.dispose(); }
});
test("target preapproval maps native refusals to denial and propagates a failed audit without entering the body", async t => {
  for (const outcome of ["rejected", "cancelled", "unavailable", "never", "audit-failure"] as const) await t.test(outcome, async () => {
    const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [commandEntry("ask")] } } });
    try {
      await f.mountManagedShell(); let decision: PreToolDecision | undefined;
      f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Native exact target" }; }, { global: true });
      f.ctx.on("tools/pre-execute", async (_exec, next) => { decision = await next(); return decision; }, { global: true, prepend: true });
      const append = f.root.session.append.bind(f.root.session), failure = new Error("Owned audit append failure");
      if (outcome === "never") f.setPolicy("never");
      else if (outcome === "audit-failure") f.root.session.append = ((...args: Parameters<typeof append>) => {
        if (args[0] === "approval/decided") throw failure;
        return Reflect.apply(append, f.root.session, args);
      }) as typeof append;
      else f.setOutcome(outcome);
      try {
        const result = await f.execute(command);
        assert.equal(result.isError, true); assert.equal(f.starts(), 0);
        if (outcome === "audit-failure") assert.equal(result.error?.message, failure.message);
        else assert.equal(decision?.kind, "deny");
      } finally { f.root.session.append = append; }
    } finally { await f.dispose(); }
  });
});
test("native and combined preapproval preserve the same caller-abort code and pre-dispatch lifecycle", async t => {
  for (const combined of [false, true]) await t.test(combined ? "combined native target" : "SDK-owned native ask", async () => {
    const f = await permissionFixture(2000, { settings: combined ? { nativeCommands: { enabled: true, entries: [commandEntry("ask")] } } : {} });
    const ready = deferred<void>(), release = deferred<"allowed-once">(), caller = new AbortController();
    let dispatched = 0, posted = 0;
    try {
      await f.mountManagedShell();
      f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Native command purpose" }; }, { global: true });
      f.ctx.on("tools/execute", async (_exec, next) => { dispatched++; return next(); }, { global: true });
      f.ctx.on("tools/post-execute", async (_exec, result, next) => { posted++; assert.equal(result.error?.info?.code, TOOL_ABORTED_BEFORE_DISPATCH); return next(); }, { global: true });
      f.setAnswer(async () => { ready.resolve(); return release.promise; });
      const pending = f.execute(command, {}, caller.signal); await ready.promise; caller.abort();
      const result = await pending;
      assert.equal(result.error?.info?.code, TOOL_ABORTED_BEFORE_DISPATCH, JSON.stringify(result));
      assert.equal(f.starts(), 0); assert.equal(dispatched, 0); assert.equal(posted, 1);
    } finally { release.resolve("allowed-once"); await f.dispose(); }
  });
});
test("standing native full access does not require DSMM owner facts, while a known blacklist still denies", async () => {
  const f = await permissionFixture(2000, { sandboxMode: "danger-full-access" });
  try {
    await f.mountManagedShell(); f.authorities.delete(f.root);
    assert.equal((await f.execute(command)).isError, false); assert.equal(f.starts(), 1); assert.equal(f.nativeAnswers(), 0);
    await f.update({ rules: shellRule("deny") });
    assert.equal((await f.execute(command)).isError, true); assert.equal(f.starts(), 1);
  } finally { await f.dispose(); }
});
test("the original native escalation request survives permission-source changes and never authorizes a following call", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: false } } });
  const ready = deferred<Parameters<typeof f.ctx.approval.request>[0]>(), release = deferred<"allowed-once">();
  try {
    await f.mountManagedShell();
    f.setAnswer(async request => { ready.resolve(request); return release.promise; });
    const call = f.execute(command, { sandbox_permissions: "danger-full-access", justification: "Native approval for this exact full-access invocation" });
    const request = await ready.promise;
    await f.update({ rules: shellRule("deny") }); assert.equal(request.signal?.aborted, false); assert.equal(f.starts(), 0);
    release.resolve("allowed-once"); assert.equal((await call).isError, false); assert.equal(f.nativeAnswers(), 1);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    await f.update({ nativeCommands: { enabled: false } }); f.setAnswer(undefined);
    assert.equal((await f.execute("Write-Output following")).isError, false);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
    assert.equal(f.nativeAnswers(), 1);
  } finally { release.resolve("allowed-once"); await f.dispose(); }
});
test("actual SDK around-wrapper cancellation reaches a waiting B request before entering the original body", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [commandEntry("ask")] } } });
  const ready = deferred<Parameters<typeof f.ctx.approval.request>[0]>(), release = deferred<"allowed-once">(), wrapper = new AbortController();
  let call: ReturnType<typeof f.execute> | undefined;
  try {
    await f.mountManagedShell(); f.ctx.on("tools/execute", async (exec, next) => { exec.signal = wrapper.signal; return next(); }, { global: true });
    f.setAnswer(async request => { ready.resolve(request); return release.promise; }); call = f.execute(command);
    const request = await ready.promise; assert.equal(request.signal?.aborted, false); wrapper.abort();
    assert.equal(request.signal?.aborted, true); assert.equal(f.starts(), 0);
    release.resolve("allowed-once"); assert.equal((await call).isError, true); assert.equal(f.starts(), 0);
  } finally { release.resolve("allowed-once"); await call; await f.dispose(); }
});
test("around-wrapper argument replacement cannot transfer a literal command grant to a different native body", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [commandEntry("allow")] } } });
  try {
    await f.mountManagedShell(); let replaced = false;
    f.ctx.on("tools/execute", async (exec, next) => { replaced = Reflect.set(exec, "arguments", { ...(exec.arguments as Record<string, unknown>), command: "Write-Output owned" }); return next(); }, { global: true });
    const value = await f.execute(command); assert.equal(replaced, true); assert.equal(value.isError, true); assert.equal(f.starts(), 0); assert.equal(f.nativeAnswers(), 0);
  } finally { await f.dispose(); }
});
test("actual SDK around-wrapper cancellation reaches the original executor with enhancement off", async () => {
  const ready = deferred<AbortSignal>(), release = deferred<void>(), wrapper = new AbortController();
  const f = await permissionFixture(2000, { async shellExecution(spec) { assert.ok(spec.signal instanceof AbortSignal); ready.resolve(spec.signal); await release.promise; } });
  let call: ReturnType<typeof f.execute> | undefined;
  try {
    await f.mountManagedShell(); f.ctx.on("tools/execute", async (exec, next) => { exec.signal = wrapper.signal; return next(); }, { global: true });
    call = f.execute("Write-Output owned"); const signal = await ready.promise; assert.equal(signal.aborted, false); wrapper.abort(); assert.equal(signal.aborted, true);
    release.resolve(); const result = await call; assert.equal(result.isError, true); assert.equal(result.error?.info?.code, TOOL_ABORTED); assert.equal(f.nativeAnswers(), 0);
  } finally { release.resolve(); await call; await f.dispose(); }
});
test("A official escalation owns override and same-purpose asks; configured allow remains inside native service", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [commandEntry("allow")] } } });
  try {
    await f.mountManagedShell(); const extra = { sandbox_permissions: "danger-full-access", justification: "Owned exact command needs external writes" };
    assert.equal((await f.execute(command, extra)).isError, false); assert.equal(f.nativeAnswers(), 0); assert.equal(f.starts(), 1);
    const asks = () => f.root.session.snapshotEvents().filter(event => event.type === "approval/asked").length;
    assert.equal(asks(), 1);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    await f.update({ rules: shellRule("ask"), nativeCommands: { enabled: true, entries: [commandEntry("allow")] } });
    assert.equal((await f.execute(command, extra)).isError, false); assert.equal(f.nativeAnswers(), 1); assert.equal(f.starts(), 2);
    assert.equal(asks(), 2);
    f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "same invocation native gate" }; }, { global: true });
    assert.equal((await f.execute(command, extra)).isError, false); assert.equal(f.nativeAnswers(), 2); assert.equal(f.starts(), 3);
    assert.equal(asks(), 3);
    f.setPolicy("never"); assert.equal((await f.execute(command, extra)).isError, true); assert.equal(f.nativeAnswers(), 2); assert.equal(f.starts(), 3);
  } finally { await f.dispose(); }
});
test("official escalation uses the current native approval service after replacement, preserving never before answerers", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [commandEntry("allow")] } } });
  try {
    await f.mountManagedShell(); await f.replaceApproval("never");
    const value = await f.execute(command, { sandbox_permissions: "danger-full-access", justification: "Owned exact external-write scope" });
    assert.equal(value.isError, true, JSON.stringify(value)); assert.equal(f.starts(), 0); assert.equal(f.nativeAnswers(), 0);
    await f.replaceApproval("ask"); assert.equal((await f.execute(command, { sandbox_permissions: "danger-full-access", justification: "Owned exact external-write scope" })).isError, false); assert.equal(f.starts(), 1);
  } finally { await f.dispose(); }
});
test("configured deny, absolute readonly/role and scoped tool restrictions precede any enhancement", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [commandEntry("allow")] }, rules: shellRule("deny") } });
  try {
    await f.mountManagedShell(); assert.equal((await f.execute(command)).isError, true); assert.equal(f.starts(), 0);
    await f.update({ nativeCommands: { enabled: true, entries: [commandEntry("allow")] } });
    f.setPureDenied(true); assert.equal((await f.execute(command)).isError, true); f.setPureDenied(false);
    const restrict = f.root.ctx.tools.restrict({ deny: ["pwsh"] }); assert.equal((await f.execute(command)).isError, true); restrict();
    const guard = f.runtime.guard(() => "Independent purpose denies"); assert.equal((await f.execute(command)).isError, true); guard();
    assert.equal(f.starts(), 0); assert.equal(f.nativeAnswers(), 0);
    assert.equal((await f.execute(command)).isError, false);
  } finally { await f.dispose(); }
});
test("caller cancellation and same callId concurrency retain exact tokens while latest native approval survives source changes", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [commandEntry("ask")] } } });
  try {
    await f.mountManagedShell(); const ready = deferred<void>(), gate = deferred<"allowed-once">();
    f.setAnswer(async () => { ready.resolve(); return gate.promise; }); const abort = new AbortController(); const call = f.execute(command, {}, abort.signal);
    await ready.promise; assert.equal(f.starts(), 0); abort.abort(); assert.equal((await call).isError, true); gate.resolve("allowed-once"); assert.equal(f.starts(), 0);
    const barrier = deferred<void>(); let waiting = 0;
    f.setAnswer(async () => { if (++waiting === 2) barrier.resolve(); await barrier.promise; return "allowed-once"; });
    const id = ToolCallId(randomUUID()), sharedSignal = new AbortController().signal;
    const calls = await Promise.all([f.execute(command, {}, sharedSignal, id), f.execute(command, {}, sharedSignal, id)]);
    assert.ok(calls.every(value => !value.isError)); assert.equal(waiting, 2); assert.equal(f.starts(), 2);
    const unask = f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "Concurrent native purpose" }; }, { global: true });
    const sdkBarrier = deferred<void>(); waiting = 0;
    f.setAnswer(async () => { if (++waiting === 2) sdkBarrier.resolve(); await sdkBarrier.promise; return "allowed-once"; });
    const sdkCalls = await Promise.all([f.execute(command, {}, sharedSignal, id), f.execute(command, {}, sharedSignal, id)]);
    assert.ok(sdkCalls.every(value => !value.isError)); assert.equal(waiting, 2); assert.equal(f.starts(), 4); unask();
    const revokeReady = deferred<void>(), stale = deferred<"allowed-once">();
    f.setAnswer(async () => { revokeReady.resolve(); return stale.promise; }); const pending = f.execute(command); await revokeReady.promise;
    await f.update({ nativeCommands: { enabled: false, entries: [] } }); stale.resolve("allowed-once");
    assert.equal((await pending).isError, false); assert.equal(f.starts(), 5);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    f.setAnswer(undefined); assert.equal((await f.execute("Write-Output next")).isError, false);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
  } finally { await f.dispose(); }
});
test("actual Agent disposal terminates a waiting native request before the original body", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [commandEntry("ask")] } } });
  const ready = deferred<void>(), gate = deferred<"allowed-once">();
  try {
    await f.mountManagedShell(); f.setAnswer(async () => { ready.resolve(); return gate.promise; });
    const call = f.execute(command); await ready.promise; await f.disposeAgent(f.root);
    assert.equal((await call).isError, true); gate.resolve("allowed-once"); assert.equal(f.starts(), 0);
  } finally { gate.resolve("allowed-once"); await f.dispose(); }
});
test("cooperative registration preserves body receiver, immutable arguments, metadata and context methods", async () => {
  const f = await permissionFixture();
  try {
    const context = createUserMessage({ content: [{ type: "text", text: "owned deferred context" }], source: { kind: "user" } });
    const definition: ToolDefinition = { name: "owned_receiver", description: "Owned original receiver", parameters: { type: "object" }, output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
      async execute(args, exec) { assert.equal(this, definition); assert.ok(Object.isFrozen(args)); exec.deferContext(context); exec.concludeTurn(); return "owned"; } };
    const unregister = f.controller.shellScope(f.ctx, "pwsh").tools.register(definition), registered = f.ctx.tools.get(definition.name)!;
    assert.equal(registered.parameters, definition.parameters); assert.equal(registered.output, definition.output);
    const result = await f.runtime.execute({ name: definition.name, callId: ToolCallId(randomUUID()), arguments: {}, agent: f.root, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.concludesTurn, true); assert.deepEqual(result.additionalContexts, [context]); unregister();
  } finally { await f.dispose(); }
});
test("PTC public leaf dispatch uses the same single SDK gate and cannot borrow run_code approval", async () => {
  const f = await permissionFixture(2000, { mode: "ptc", settings: { nativeCommands: { enabled: true, entries: [commandEntry("ask")] } } });
  const sdk = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-tools"));
  const { PtcRuntime } = await import(pathToFileURL(sdk.resolve("@deepseek-ai/dsh-ptc-runtime")).href);
  class OwnedPtc extends PtcRuntime {
    readonly language = "typescript"; readonly isolation = "owned-fixture";
    resolve(request: Record<string, unknown>) { return { ...request, cwd: process.cwd(), timeoutMs: 1000 }; }
    async run(spec: { bindings: { global: string; functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
      try { return { value: await spec.bindings.find(binding => binding.global === "tools")!.functions.pwsh({ command, description: "Run one owned fixture command", workdir: process.cwd() }), logs: [] }; }
      catch { return { error: { kind: "exception", message: "Native leaf refused" }, logs: [] }; }
    }
  }
  try {
    await f.mountManagedShell(); await f.ctx.plugin(OwnedPtc).await();
    f.ctx.on("tools/pre-execute", async (exec, next) => { const value = await next(); return exec.name === "pwsh" ? { kind: "ask", reason: "PTC leaf native purpose" } : value; }, { global: true });
    const call = () => f.runtime.execute({ name: "run_code", callId: ToolCallId(randomUUID()), arguments: { code: "return await tools.pwsh({});", description: "Call one owned leaf" }, agent: f.root, signal: new AbortController().signal });
    assert.equal((await call()).isError, false); assert.equal(f.starts(), 1); assert.equal(f.nativeAnswers(), 1); assert.equal(f.requests[0].toolName, "pwsh");
    f.setOutcome("rejected"); assert.equal((await call()).isError, true); assert.equal(f.starts(), 1);
  } finally { await f.dispose(); }
});
