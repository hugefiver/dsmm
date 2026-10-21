import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { literalCommand, nativeCommandMatch, parseHostNativeCommands } from "../src/permission-native-command.ts";
import { parseNativeCommandPattern, parseNativeCommands, resolvePermissionControl } from "../src/permission-settings.ts";
import type { NativeCommandEntry, NativeCommandsSettings } from "../src/permission-settings.ts";
import { DSMM_CONFIG_SCHEMA, DSMM_NATIVE_CONFIG_SCHEMA, resolveDeployment, validateSparseConfig } from "../src/settings.ts";
import type { DsmmPluginConfig } from "../src/settings.ts";
import type { PermissionControlSchemaInput } from "../src/permission-settings.ts";
import { parsePermissionRulesResult } from "../src/permission-remote.ts";
import { importPermissionRules } from "../src/permission-rules.ts";
import { deferred, permissionFixture } from "./permission-fixture.ts";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";

useIsolatedDshEnvironment();
const workspace = process.cwd();
const patternEntry = (changes: Partial<NativeCommandEntry> = {}): NativeCommandEntry => ({
  id: "pattern", mode: "ask", sandboxMode: "workspace-write",
  match: { tool: "pwsh", workingDirectory: workspace, commandPattern: "go build|test" }, ...changes,
});
const policy = (...entries: NativeCommandEntry[]): NativeCommandsSettings => ({ enabled: true, entries });
const settings = (...entries: NativeCommandEntry[]): PermissionControlSchemaInput => ({ nativeCommands: policy(...entries) });
const identity = (tool: "bash" | "pwsh") => ({ executable: tool, dialect: tool === "bash" ? "posix" as const : "powershell" as const, commandField: "command", cwdField: "workdir" });
const matchedId = (match: ReturnType<typeof nativeCommandMatch>) => typeof match === "object" ? match.id : match;

test("command patterns: bounded browser-safe grammar accepts static prefixes and rejects shell or wildcard grammar", () => {
  for (const value of ["go build|test", "go build|test *", " \tgo\tbuild|test\t* \t"]) {
    assert.deepEqual(parseNativeCommandPattern(value), { executable: "go", subcommands: ["build", "test"] });
  }
  assert.deepEqual(parseNativeCommandPattern("go test"), { executable: "go", subcommands: ["test"] });
  assert.deepEqual(parseNativeCommandPattern("C:\\Tools\\go.exe 测试|tést"), { executable: "C:\\Tools\\go.exe", subcommands: ["测试", "tést"] });
  for (const value of [undefined, null, 1, "", " \t", "go", "go *", "go build|", "go |test", "go build||test", "go|other test",
    "go build | test", "go test extra", "go test * extra", "go test **", "go te*", "go* test", "go te?", "go [test]", "go (test)",
    "go 'test'", '"go" test', "go te\\st", "go test;other", "go test && other", "go $test", "go `test`", "go test > out",
    "go\ntest", "go\u00a0test", "go test\n", "go test\r", "go test\v", "go test\u0085", "go test\u2028", "go te\0st", "go " + "t".repeat(32766)]) {
    assert.throws(() => parseNativeCommandPattern(value), { code: "validation" }, JSON.stringify(value));
  }
  assert.equal(parseNativeCommandPattern("go " + "t".repeat(32765)).subcommands[0].length, 32765);
});

test("command patterns: strict entry validation rejects legacy, mixed, incomplete, unknown and oversized inputs even when disabled", () => {
  const entry = patternEntry(), common = { tool: "pwsh", workingDirectory: workspace };
  const invalid = [
    { ...entry.match, executable: "go" }, { ...entry.match, subcommand: "test" }, { ...entry.match, args: [] },
    { ...entry.match, unknown: true }, { ...common }, { ...common, executable: "go" },
    { ...common, executable: "go", subcommand: "test", args: ["."] }, { ...common, executable: "Write-Output", args: ["owned"] },
    { ...common, commandPattern: null }, { ...common, commandPattern: "" }, { ...common, commandPattern: "go test?" },
    { commandPattern: "go test", workingDirectory: workspace }, { tool: "pwsh", commandPattern: "go test" },
  ];
  for (const match of invalid) for (const enabled of [false, true]) {
    const nativeCommands = { enabled, entries: [{ ...entry, match }] };
    const config = { permissionControl: { nativeCommands } };
    assert.throws(() => parseNativeCommands(nativeCommands), { code: "validation" });
    assert.throws(() => validateSparseConfig(config));
    assert.throws(() => Reflect.apply(DSMM_CONFIG_SCHEMA, undefined, [config]));
    assert.throws(() => Reflect.apply(DSMM_NATIVE_CONFIG_SCHEMA, undefined, [config]));
  }
  assert.throws(() => parseNativeCommands(policy(...Array.from({ length: 1025 }, (_, index) => patternEntry({ id: String(index) })))), { code: "validation" });
  assert.equal(parseNativeCommands(policy(...Array.from({ length: 1024 }, (_, index) => patternEntry({ id: String(index) })))).entries.length, 1024);
});

test("command patterns: real global and native sparse schemas round-trip explicit fields and whole-array overrides", () => {
  const global = { permissionControl: { nativeCommands: policy(patternEntry({ id: "global", mode: "allow", match: { tool: "pwsh", workingDirectory: workspace, commandPattern: " \tgo\tbuild|test *\t " } }), patternEntry()) } };
  const native = { permissionControl: { nativeCommands: { entries: [patternEntry({ id: "native", match: { tool: "bash", workingDirectory: workspace, commandPattern: "go test *" } })] } } };
  const nativeParse = (input: DsmmPluginConfig) => (DSMM_NATIVE_CONFIG_SCHEMA(input).permissionControl as unknown as { get(): PermissionControlSchemaInput }).get();
  const json = (input: unknown) => JSON.parse(JSON.stringify(input));
  const parsedGlobal = DSMM_CONFIG_SCHEMA(json(DSMM_CONFIG_SCHEMA(global)));
  const parsedNative = { permissionControl: nativeParse(json({ permissionControl: nativeParse(native) })) };
  assert.deepEqual(parsedGlobal, global);
  assert.deepEqual(parsedNative, native);
  assert.deepEqual(resolveDeployment(parsedGlobal, parsedNative).permissionControl.nativeCommands, policy(...native.permissionControl.nativeCommands.entries));
  assert.deepEqual(resolveDeployment(parsedGlobal, {}).permissionControl.nativeCommands, global.permissionControl.nativeCommands);
  const nativeFull = { permissionControl: nativeParse(global) };
  assert.deepEqual(nativeFull, global);
  const snapshot = { revision: "round-trip", policy: resolvePermissionControl(global.permissionControl) };
  const runtime = { savedRevision: "round-trip", runtimeRevision: "round-trip", state: "synced", mounted: true, restartRequired: false };
  assert.deepEqual(parsePermissionRulesResult(json({ snapshot, runtime })).snapshot, snapshot);
});

test("command patterns: both shell dialects match zero or many static tail arguments with exact executable, tool, cwd and case", () => {
  for (const tool of ["bash", "pwsh"] as const) for (const commandPattern of ["go build|test", "go build|test *", "go test"]) {
    const entry = patternEntry({ match: { tool, workingDirectory: workspace, commandPattern } });
    const match = (command: string, workdir?: string) => nativeCommandMatch(policy(entry), tool, identity(tool), { command, workdir }, workspace);
    for (const command of ["go test", "go test -count=1 ./...", "go test 'two words' \"中文\" ''", "go test '$HOME;*?[]{}()&|<>~#`@,'", "go test -exec runner"]) {
      assert.equal(matchedId(match(command)), entry.id, command);
    }
    assert.equal(matchedId(match("go test", join(workspace, "child", ".."))), entry.id);
    assert.equal(matchedId(match("go build")), commandPattern === "go test" ? undefined : entry.id);
    for (const command of ["go", "Go test", "go Test", "other test", "./go test", "/usr/bin/go test", "go clean", "go build test-more", "go other test", "go test-more"]) {
      if (command === "go build test-more" && commandPattern !== "go test") continue;
      assert.equal(match(command), undefined, command);
    }
    assert.equal(match("go test", "child"), undefined);
    assert.equal(nativeCommandMatch(policy(entry), tool === "pwsh" ? "bash" : "pwsh", identity(tool), { command: "go test" }, workspace), undefined);
    assert.equal(nativeCommandMatch({ enabled: false, entries: [entry] }, tool, identity(tool), { command: "go test" }, workspace), undefined);
    for (const command of ["go build|test", "go test | other", "go test && other", "go test;other", "go test\nother", "go test > out", "go test < in", "go test $HOME", 'go test "$HOME"', "go test $(other)", "go test `other`", "go test *.go", "env go test", "pwsh -Command 'go test'", "bash -c 'go test'", "node runner", "go test --% x"]) {
      assert.equal(literalCommand(command, identity(tool).dialect), undefined, command);
      assert.equal(match(command), undefined, command);
    }
  }
  const entry = patternEntry({ match: { tool: "pwsh", workingDirectory: `${workspace}/child/..`, commandPattern: "C:\\Tools\\go.exe test" } });
  const parsedEntry = parseHostNativeCommands(policy(entry)).entries[0];
  assert.equal(typeof parsedEntry === "string" ? undefined : parsedEntry.match.workingDirectory, workspace);
  assert.equal(matchedId(nativeCommandMatch(policy(entry), "pwsh", identity("pwsh"), { command: "C:\\Tools\\go.exe test" }, workspace)), entry.id);
  assert.equal(nativeCommandMatch(policy(entry), "pwsh", identity("pwsh"), { command: "go.exe test" }, workspace), undefined);
  assert.equal(nativeCommandMatch(policy(entry), "pwsh", identity("pwsh"), { command: "C:\\tools\\go.exe test" }, workspace), undefined);
});

test("command patterns: overlapping patterns retain ask and ambiguous precedence in either entry order", () => {
  const call = (entries: NativeCommandEntry[], command: string) => nativeCommandMatch(policy(...entries), "pwsh", identity("pwsh"), { command }, workspace);
  const allow = patternEntry({ id: "allow", mode: "allow", sandboxMode: "danger-full-access", match: { tool: "pwsh", workingDirectory: workspace, commandPattern: "go test *" } });
  const ask = patternEntry({ sandboxMode: "danger-full-access" });
  for (const entries of [[allow, ask], [ask, allow]]) assert.equal(matchedId(call(entries, "go test .")), ask.id);
  const narrowAsk = { ...allow, mode: "ask" as const }, patternAllow = { ...ask, mode: "allow" as const };
  assert.equal(matchedId(call([patternAllow, narrowAsk], "go test .")), narrowAsk.id);
  for (const entries of [[allow, patternEntry()], [patternEntry(), allow]]) assert.equal(call(entries, "go test ."), "ambiguous");
  assert.equal(call([ask, patternEntry({ id: "other", mode: "allow" })], "go test ."), "ambiguous");
});

test("command patterns: managed native calls use once approval, preserve explicit targets and leave unsupported shell on the native path", async () => {
  const f = await permissionFixture(2000, { settings: settings(patternEntry({ sandboxMode: "danger-full-access" })) });
  try {
    await f.mountManagedShell();
    for (const command of ["go build", "go test -count=1 ."]) {
      assert.equal((await f.execute(command)).isError, false);
      assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
    }
    assert.equal(f.starts(), 2); assert.equal(f.nativeAnswers(), 2);
    f.setOutcome("rejected");
    assert.equal((await f.execute("go build")).isError, true); assert.equal(f.starts(), 2); assert.equal(f.nativeAnswers(), 3);
    f.setOutcome("allowed-once");
    const explicit = { sandbox_permissions: "workspace-write", justification: "Use this exact workspace target only" };
    assert.equal((await f.execute("go test", explicit)).isError, false);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
    assert.equal(f.nativeAnswers(), 4);
    assert.equal((await f.execute("go build|test")).isError, false);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "workspace-write");
    assert.equal(f.nativeAnswers(), 4); assert.equal(f.starts(), 4);
    await f.update(settings(patternEntry({ mode: "allow", sandboxMode: "danger-full-access" })));
    assert.equal((await f.execute("go test -exec runner")).isError, false);
    assert.equal(f.nativeAnswers(), 4); assert.equal(f.starts(), 5);
    assert.equal((f.specs.at(-1)!.sandboxPolicy as { mode: string }).mode, "danger-full-access");
  } finally { await f.dispose(); }
});

test("command patterns: ask and configured allow preserve native never, audit failure and cancellation before body", async t => {
  for (const mode of ["ask", "allow"] as const) await t.test(mode, async () => {
    const f = await permissionFixture(2000, { settings: settings(patternEntry({ mode, sandboxMode: "danger-full-access" })) });
    try {
      await f.mountManagedShell();
      f.setPolicy("never");
      assert.equal((await f.execute("go test")).isError, true); assert.equal(f.starts(), 0); assert.equal(f.nativeAnswers(), 0);
      f.setPolicy("ask");
      const append = f.root.session.append.bind(f.root.session), failure = new Error("owned audit failure");
      f.root.session.append = ((...args: Parameters<typeof append>) => { if (args[0] === "approval/decided") throw failure; return Reflect.apply(append, f.root.session, args); }) as typeof append;
      try { assert.equal((await f.execute("go test")).isError, true); assert.equal(f.starts(), 0); }
      finally { f.root.session.append = append; }
      if (mode === "ask") {
        for (const outcome of ["cancelled", "unavailable", "rejected"] as const) {
          f.setOutcome(outcome); assert.equal((await f.execute("go test")).isError, true); assert.equal(f.starts(), 0);
        }
        const ready = deferred<void>(), gate = deferred<"allowed-once">(), abort = new AbortController();
        f.setAnswer(async () => { ready.resolve(); return gate.promise; });
        const pending = f.execute("go test", {}, abort.signal);
        try { await ready.promise; abort.abort(); assert.equal((await pending).isError, true); assert.equal(f.starts(), 0); }
        finally { gate.resolve("allowed-once"); await pending; }
      } else {
        const abort = new AbortController(); abort.abort();
        assert.equal((await f.execute("go test", {}, abort.signal)).isError, true); assert.equal(f.starts(), 0);
      }
    } finally { await f.dispose(); }
  });
});

test("command patterns: deny, readonly/role, tool caps and revoked current owner precede enhancement", async () => {
  const rules = importPermissionRules([{ id: "deny-test", action: "deny", match: { kind: "shell", executable: "pwsh.exe", command: "go test", workingDirectory: workspace } }], "owned", 1);
  const f = await permissionFixture(2000, { settings: { ...settings(patternEntry({ mode: "allow", sandboxMode: "danger-full-access" })), rules } });
  try {
    await f.mountManagedShell();
    assert.equal((await f.execute("go test")).isError, true);
    await f.update(settings(patternEntry({ mode: "allow", sandboxMode: "danger-full-access" })));
    f.setPureDenied(true); assert.equal((await f.execute("go test")).isError, true); f.setPureDenied(false);
    const restrict = f.root.ctx.tools.restrict({ deny: ["pwsh"] });
    try { assert.equal((await f.execute("go test")).isError, true); } finally { restrict(); }
    const guard = f.runtime.guard(() => "independent native denial");
    try { assert.equal((await f.execute("go test")).isError, true); } finally { guard(); }
    f.authorities.delete(f.root); assert.equal((await f.execute("go test")).isError, true);
    assert.equal(f.starts(), 0); assert.equal(f.nativeAnswers(), 0);
  } finally { await f.dispose(); }
});

test("command patterns: bash body gets its exact target and ambiguous overlaps retain ordinary native policy", async () => {
  const bash = patternEntry({ match: { tool: "bash", workingDirectory: workspace, commandPattern: "go build|test *" }, sandboxMode: "danger-full-access" });
  const f = await permissionFixture(2000, { settings: settings(bash) });
  try {
    await f.mountManagedShell("bash");
    assert.equal((await f.execute("go test 'two words'", {}, undefined, undefined, f.root, "bash")).isError, false);
    assert.equal(f.starts(), 1); assert.equal(f.nativeAnswers(), 1);
    assert.equal((f.specs[0].sandboxPolicy as { mode: string }).mode, "danger-full-access");
    const overlapping = patternEntry({ id: "overlapping", mode: "allow", match: { tool: "bash", workingDirectory: workspace, commandPattern: "go test" } });
    await f.update(settings(bash, overlapping));
    assert.equal((await f.execute("go test 'two words'", {}, undefined, undefined, f.root, "bash")).isError, false);
    assert.equal(f.starts(), 2); assert.equal(f.nativeAnswers(), 1);
    assert.equal((f.specs[1].sandboxPolicy as { mode: string }).mode, "workspace-write");
  } finally { await f.dispose(); }
});

test("command patterns: pending native approval remains final across rule updates and is never reused by the following call", async () => {
  const f = await permissionFixture(2000, { settings: settings(patternEntry({ sandboxMode: "danger-full-access" })) });
  const ready = deferred<void>(), gate = deferred<"allowed-once">();
  let pending: ReturnType<typeof f.execute> | undefined;
  try {
    await f.mountManagedShell();
    f.setAnswer(async () => { ready.resolve(); return gate.promise; });
    pending = f.execute("go test"); await ready.promise;
    await f.update(settings());
    gate.resolve("allowed-once");
    assert.equal((await pending).isError, false); assert.equal(f.starts(), 1); assert.equal(f.nativeAnswers(), 1);
    assert.equal((f.specs[0].sandboxPolicy as { mode: string }).mode, "danger-full-access");
    f.setAnswer(undefined);
    assert.equal((await f.execute("go test")).isError, false); assert.equal(f.starts(), 2); assert.equal(f.nativeAnswers(), 1);
    assert.equal((f.specs[1].sandboxPolicy as { mode: string }).mode, "workspace-write");
  } finally { gate.resolve("allowed-once"); await pending; await f.dispose(); }
});

test("command patterns: approved target cannot transfer to changed argv or a disposed current registration", async t => {
  for (const replacement of ["arguments", "registration"] as const) await t.test(replacement, async () => {
    const f = await permissionFixture(2000, { settings: settings(patternEntry({ sandboxMode: "danger-full-access" })) });
    try {
      const mounted = await f.mountManagedShell();
      f.ctx.on("tools/pre-execute", async (_exec, next) => { await next(); return { kind: "ask", reason: "native purpose" }; }, { global: true });
      f.ctx.on("tools/execute", async (exec, next) => {
        if (replacement === "registration") await mounted.dispose();
        else Reflect.set(exec, "arguments", { ...(exec.arguments as Record<string, unknown>), command: "go test changed" });
        return next();
      }, { global: true });
      assert.equal((await f.execute("go test")).isError, true); assert.equal(f.starts(), 0); assert.equal(f.nativeAnswers(), 1);
    } finally { await f.dispose(); }
  });
});
