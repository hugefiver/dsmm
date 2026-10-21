import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { permissionFixture } from "./permission-fixture.ts";
import { literalCommand } from "../src/permission-native-command.ts";
import { classifyPermissionShell } from "../src/permission-shell.ts";
import { importPermissionRules } from "../src/permission-rules.ts";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";
useIsolatedDshEnvironment();
const entry = { id: "go", mode: "ask" as const, sandboxMode: "danger-full-access" as const, match: { tool: "pwsh" as const, commandPattern: "go test", workingDirectory: process.cwd() } };
test("registration and owner identity changes, controller disposal and caller cancellation prevent native body entry", async t => {
  for (const change of ["registration", "authority", "controller", "abort"] as const) await t.test(change, async () => {
    const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [entry] } } });
    const abort = new AbortController();
    try {
      const mounted = await f.mountManagedShell();
      f.ctx.on("tools/execute", async (_exec, next) => {
        if (change === "registration") await mounted.dispose();
        else if (change === "controller") f.controller.retire();
        else if (change === "abort") abort.abort();
        else f.authorities.set(f.root, { ...f.authorities.get(f.root)!, ownerGeneration: 2 });
        return next();
      }, { global: true });
      assert.equal((await f.execute("go test", {}, abort.signal)).isError, true); assert.equal(f.starts(), 0);
    } finally { await f.dispose(); }
  });
});
test("delegated native never is not answered by its Root's configured command allow", async () => {
  const f = await permissionFixture(2000, { settings: { nativeCommands: { enabled: true, entries: [{ ...entry, mode: "allow" }] } } });
  try {
    await f.mountManagedShell(); const child = await f.create(f.root); f.setPolicy("never", child);
    assert.equal((await f.execute("go test", {}, undefined, ToolCallId("child-owned"), child)).isError, true);
    assert.equal(f.starts(), 0); assert.equal(f.nativeAnswers(), 0);
    assert.equal((await f.execute("go test")).isError, false); assert.equal(f.starts(), 1);
  } finally { await f.dispose(); }
});
test("literal enhancement grammar never recognizes PowerShell smart quotes, dynamic handlers or interpreter wrappers", () => {
  const identity = { executable: "pwsh.exe", dialect: "powershell" as const, commandField: "command" };
  for (let codepoint = 0x2018; codepoint <= 0x201f; codepoint++) {
    const quote = codepoint < 0x201c ? "'" : '"', command = `Write-Output ${quote}safe${String.fromCodePoint(codepoint)}; Remove-Item victim # ${quote}`;
    assert.equal(literalCommand(command, "powershell"), undefined); assert.equal(classifyPermissionShell(identity, { command }, process.cwd()).effect, "unknown");
  }
  for (const command of ["$tool @args", "go test $(cmd)", "pwsh -Command 'go test .'", "python3 anything", ". script.ps1", "go test --% .", "GOCACHE=x go test .", "go test . > outside"]) assert.equal(literalCommand(command, "powershell"), undefined);
  assert.deepEqual(literalCommand("go test '中文 café'", "powershell"), ["go", "test", "中文 café"]);
});
for (const boundary of ["outer final native outcome", "replaced display identity"] as const) test(`final native approval permits its original call across a source change with ${boundary}`, async () => {
  const command = "Write-Output owned";
  const rules = (action: "ask" | "deny") => importPermissionRules([{ id: "exact", action, match: { kind: "shell", executable: "pwsh.exe", command, workingDirectory: process.cwd() } }], "owned configuration", 1);
  const f = await permissionFixture(2000, { settings: { rules: rules("ask") } });
  try {
    await f.mountManagedShell();
    if (boundary === "outer final native outcome") {
      f.setOutcome("rejected");
      f.ctx.on("approval/request", async (_request, next) => {
        await next(); await f.update({ rules: rules("deny") }); return "allowed-once";
      }, { global: true, prepend: true });
    } else {
      f.ctx.on("tools/pre-execute", async (_exec, next) => {
        const decision = await next();
        return decision.kind === "ask" ? { ...decision, displayReason: { ...decision.displayReason!, en: decision.displayReason!.en } } : decision;
      }, { global: true, prepend: true });
      f.setAnswer(async () => { await f.update({ rules: rules("deny") }); return "allowed-once"; });
    }
    const result = await f.execute(command);
    const outcomes = f.root.session.snapshotEvents().filter(event => event.type === "approval/decided").map(event => event.data.outcome);
    assert.deepEqual(outcomes, ["allowed-once"]);
    assert.equal(result.isError, false, JSON.stringify({ result, outcomes, starts: f.starts(), answers: f.nativeAnswers() }));
    assert.equal(f.starts(), 1);
  } finally { await f.dispose(); }
});
