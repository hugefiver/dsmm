import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { literalCommand, nativeCommandMatch, simpleCommandMatch, simpleShellCommand, simpleShellDialect } from "../src/permission-native-command.ts";
import { parseSimpleCommandPattern } from "../src/permission-settings.ts";
import type { NativeCommandEntry, NativeCommandsSettings } from "../src/permission-settings.ts";
import type { PermissionShellIdentity } from "../src/permission-shell.ts";

const workspace = resolve("native-command-workspace");
const powershell: PermissionShellIdentity = { executable: "pwsh", dialect: "powershell", commandField: "command", cwdField: "workdir" };
const posix: PermissionShellIdentity = { executable: "bash", dialect: "posix", commandField: "script", cwdField: "cwd" };
function settings(changes: Partial<NativeCommandEntry["match"]> = {}): NativeCommandsSettings {
  return { enabled: true, entries: [{ id: "pattern", mode: "allow", sandboxMode: "danger-full-access", match: {
    tool: "pwsh", commandPattern: "go test", workingDirectory: workspace, ...changes,
  } }] };
}
const matchedId = (value: ReturnType<typeof nativeCommandMatch>) => typeof value === "object" ? value.id : value;

test("PowerShell doubled double quotes cannot match an argv with the quote removed", () => {
  const command = 'go test "a""b"';
  assert.equal(literalCommand(command, "powershell"), undefined);
  assert.equal(nativeCommandMatch(settings(), "pwsh", powershell, { command }, workspace), undefined);
  assert.deepEqual(literalCommand('go test "ab"', "powershell"), ["go", "test", "ab"]);
});

test("unquoted tilde and non-shell whitespace cannot create literal matches", () => {
  for (const dialect of ["posix", "powershell"] as const) {
    for (const command of ["go test ~", "go test ~/src", "go test name=~", "go test a\vb", "go test a\fb", "go test a\u00a0b", "go test a\u2028b"]) {
      assert.equal(literalCommand(command, dialect), undefined, JSON.stringify({ command, dialect }));
    }
    assert.deepEqual(literalCommand("go\ttest '~'", dialect), ["go", "test", "~"]);
  }
  assert.equal(nativeCommandMatch(settings({ tool: "bash" }), "bash", posix, { script: "go test ~" }, workspace), undefined);
  assert.ok(nativeCommandMatch(settings({ tool: "bash" }), "bash", posix, { script: "go test '~'" }, workspace));
});

test("static quoting preserves argument case, order, Unicode, and supported empty arguments", () => {
  for (const dialect of ["posix", "powershell"] as const) {
    assert.deepEqual(literalCommand('  go\t test \'two words\' "中文" \'\' "" Case case  ', dialect), ["go", "test", "two words", "中文", "", "", "Case", "case"]);
    assert.deepEqual(literalCommand("go test 'a\u00a0b'", dialect), ["go", "test", "a\u00a0b"]);
    assert.deepEqual(literalCommand("go test '$HOME;*?[]{}()&|<>~#`@,'", dialect), ["go", "test", "$HOME;*?[]{}()&|<>~#`@,"]);
    assert.deepEqual(literalCommand('go test "a;*?[]{}()&|<>~#@,"', dialect), ["go", "test", "a;*?[]{}()&|<>~#@,"]);
  }
  assert.deepEqual(literalCommand('go test a"b"\'c\' "a""b"', "posix"), ["go", "test", "abc", "ab"]);
  assert.deepEqual(literalCommand("go test 'it''s' C:\\Work\\repo", "powershell"), ["go", "test", "it's", "C:\\Work\\repo"]);
  assert.deepEqual(literalCommand('"/usr/bin/go" test "a\\b"', "posix"), ["/usr/bin/go", "test", "a\\b"]);
});

test("unsupported expansion, operators, wrappers, and malformed syntax stay unknown", () => {
  const common = ["", " \t ", "go test\nother", "go test\r", "go test\0x", "go test $HOME", 'go test "$HOME"',
    "go test `whoami`", "go test a | other", "go test a && other", "go test a; other", "go test > out", "go test < in",
    "go test (other)", "go test {a,b}", "go test *.ts", "go test a?", "go test [ab]", "go test # comment", "go test 'open", 'go test "open',
    "env go test", "sudo go test", "node -e code", "pwsh -Command code", "bash -c code", "go test --% x", "go test \u2018x\u2019"];
  for (const dialect of ["posix", "powershell"] as const) for (const command of common) {
    assert.equal(literalCommand(command, dialect), undefined, JSON.stringify({ command, dialect }));
  }
  for (const command of ["go test a\\ b", 'go test "a\\$b"', "X=value go test", "time go test", "! go test", "if true", "function go", "go test <(other)"]) {
    assert.equal(literalCommand(command, "posix"), undefined, command);
  }
  for (const command of ['"go" test', "'go' test", 'go test a"b"', 'go test "a"b', "go test 'a'b", "go test 'a\"b'", "go test a` b", "go test @args", "go test a,b", "return go test", "throw go", "exit 0", "foreach x", ".5", "1", "configuration x"]) {
    assert.equal(literalCommand(command, "powershell"), undefined, command);
  }
});

test("native patterns require exact executable, subcommand, tool and cwd while accepting static argv tails", () => {
  const policy = settings();
  const match = (command: string, workdir?: string) => nativeCommandMatch(policy, "pwsh", powershell, { command, workdir }, workspace);
  for (const command of ["go test", 'go test Case "two words"', 'go test case "two words"', 'go test "two words" Case', 'go test Case "two words" extra', "go test Case"]) assert.equal(matchedId(match(command)), "pattern");
  assert.equal(matchedId(match("go test Case 'two words'", ".")), "pattern");
  for (const command of ['Go test Case "two words"', 'go Test Case "two words"', "go build", "go"]) assert.equal(match(command), undefined);
  assert.equal(match('go test Case "two words"', "nested"), undefined);
  assert.equal(nativeCommandMatch(policy, "bash", posix, { script: 'go test Case "two words"' }, workspace), undefined);
  assert.equal(matchedId(match('go test Case "two words"', join(workspace, "nested", ".."))), "pattern");
  assert.equal(nativeCommandMatch({ ...policy, enabled: false }, "pwsh", powershell, { command: 'go test Case "two words"' }, workspace), undefined);
  const original = policy.entries[0];
  assert.notEqual(typeof original, "string");
  if (typeof original === "string") return;
  const ask: NativeCommandEntry = { ...original, id: "ask", mode: "ask" };
  assert.equal(matchedId(nativeCommandMatch({ ...policy, entries: [...policy.entries, ask] }, "pwsh", powershell, { command: 'go test Case "two words"' }, workspace)), "ask");
  assert.equal(nativeCommandMatch({ ...policy, entries: [...policy.entries, { ...ask, sandboxMode: "workspace-write" }] }, "pwsh", powershell, { command: 'go test Case "two words"' }, workspace), "ambiguous");
});

test("simple prefixes match complete literal tokens across dialects without legacy interpreter exclusions", () => {
  const match = (entry: string, command: string, dialect: "posix" | "powershell" = "powershell") => simpleCommandMatch({ enabled: true, entries: [entry] }, command, dialect);
  for (const dialect of ["posix", "powershell"] as const) {
    for (const [entry, command] of [["git", "git"], ["git", "git status -sb"], ["go build|test *", "go test -exec runner"], ["git remote add", "git remote add origin url"],
      ["node", "node -e 'console.log(1)'"], ["python", 'python -c \'print("ok")\''], ["env", "env git status"], ["bash", "bash -c 'git status'"], ["pwsh", "pwsh -Command 'git status'"]]) {
      assert.equal(match(entry, command, dialect), true, command);
    }
    for (const command of ["git status-extra", "git -C repo status", "git status; other", "git status | other", "git status > out", "git status $(other)", 'git status "$HOME"', "git status *.ts", "git status\nother", "env git status"]) assert.equal(match("git status", command, dialect), false, command);
    for (const command of ["node a.js; other", "node $(other)", "python -c $code", "if true"]) assert.equal(match(command.split(" ")[0], command, dialect), false, command);
    assert.equal(match("git", "bash -c 'git status'", dialect), false);
    assert.equal(literalCommand("node -e 'console.log(1)'", dialect), undefined);
  }
  assert.equal(match("go", "go.exe test"), true);
  assert.equal(match("go.exe", "go test"), true);
  assert.equal(match("go test", "go.exe Test"), false);
  assert.equal(match("go", "./go.exe test"), false);
  assert.equal(match("go", "go.exe test", "posix"), false);
  assert.equal(literalCommand('python -c \'print("ok")\'', "powershell"), undefined);
  assert.deepEqual(literalCommand('python -c \'print("ok")\'', "powershell", "simple"), ["python", "-c", 'print("ok")']);
  for (const input of ["", "*", "git|node", "git status|", "git status * x", "git **", "git status extra|other", "git status;other", "git\nstatus", "git $HOME"]) assert.throws(() => parseSimpleCommandPattern(input));
  assert.equal(simpleShellCommand({ command: 1, cmd: "git status", script: "ignored" }), "git status");
  assert.equal(simpleShellCommand({ command: "", cmd: "git status" }), "");
  for (const name of ["bash", "sh", "ZSH"]) assert.equal(simpleShellDialect(name), "posix");
  for (const name of ["pwsh", "PowerShell"]) assert.equal(simpleShellDialect(name), "powershell");
  assert.equal(simpleShellDialect("terminal"), undefined);
});

test("real PowerShell native Node argv agrees with accepted literals and exposes embedded quotes", t => {
  const available = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 10000 });
  if ((available.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return t.skip("PowerShell is not installed");
  assert.ifError(available.error);
  assert.equal(available.status, 0, available.stderr);
  const executable = `'${process.execPath.replaceAll("'", "''")}'`;
  const probe = (argumentsText: string) => {
    const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `& ${executable} -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- test ${argumentsText}`], { encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim()) as string[];
  };
  for (const text of ["Case case 'two words' \"中文\" '' \"\" 'it''s' C:\\Work\\repo", "'a\u00a0b' '$HOME;*?[]{}()&|<>~#`@,'", '"a;*?[]{}()&|<>~#@,"', '"ab"']) {
    const argv = probe(text);
    assert.deepEqual(literalCommand(`go test ${text}`, "powershell"), ["go", ...argv]);
  }
  assert.deepEqual(probe('"a""b"'), ["test", 'a"b']);
  assert.equal(literalCommand('go test "a""b"', "powershell"), undefined);
  assert.deepEqual(probe("a\u00a0b"), ["test", "a", "b"]);
  assert.equal(literalCommand("go test a\u00a0b", "powershell"), undefined);
});
