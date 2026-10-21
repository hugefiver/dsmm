import assert from "node:assert/strict";
import { test } from "node:test";
import { isAbsolute, normalize, parse, resolve } from "node:path";
import { nativeCommandMatch, literalCommand, parseHostNativeCommands } from "../src/permission-native-command.ts";
import { parseNativeCommands, resolvePermissionControl } from "../src/permission-settings.ts";
import { DSMM_CONFIG_SCHEMA, DSMM_NATIVE_CONFIG_SCHEMA, resolveDeployment, validateSparseConfig } from "../src/settings.ts";

const identity = { executable: "pwsh.exe", dialect: "powershell" as const, commandField: "command", cwdField: "workdir" };
const entry = { id: "go-test", mode: "allow" as const, match: { tool: "pwsh" as const, commandPattern: "go test", workingDirectory: resolve(".") }, sandboxMode: "danger-full-access" as const };
test("nativeCommands default off, strict full entries, sparse transport and whole-array overlay", () => {
  assert.deepEqual(resolvePermissionControl().nativeCommands, { enabled: false, entries: [] });
  const config = { permissionControl: { nativeCommands: { enabled: true, entries: [entry] } } };
  assert.deepEqual(DSMM_CONFIG_SCHEMA(config), config);
  assert.deepEqual((DSMM_NATIVE_CONFIG_SCHEMA(config).permissionControl as unknown as { get(): unknown }).get(), config.permissionControl);
  const result = resolveDeployment(config, { permissionControl: { nativeCommands: { entries: [] } } });
  assert.deepEqual(result.permissionControl.nativeCommands, { enabled: true, entries: [] });
  const restored = DSMM_CONFIG_SCHEMA(JSON.parse(JSON.stringify(DSMM_CONFIG_SCHEMA(config))));
  assert.deepEqual(resolveDeployment(restored, {}).permissionControl.nativeCommands.entries, [entry]);
  for (const nativeCommands of [null, { enabled: null }, { enabled: "true" }, { entries: [entry, entry] }, { entries: [{ ...entry, mode: "session" }] }, { entries: [{ ...entry, match: { ...entry.match, workingDirectory: "relative" } }] }, { entries: [{ ...entry, match: { ...entry.match, commandPattern: undefined } }] }, { entries: [{ ...entry, match: { ...entry.match, commandPattern: "go te\0st" } }] }, { entries: [{ ...entry, source: "operator" }] }]) {
    assert.throws(() => parseNativeCommands(nativeCommands));
    assert.throws(() => validateSparseConfig({ permissionControl: { nativeCommands } }));
  }
});
test("wire cwd validation preserves Host path data while Host validation and matching canonicalize locally", () => {
  const withCwd = (workingDirectory: string) => ({ enabled: true, entries: [{ ...entry, match: { ...entry.match, workingDirectory } }] });
  for (const cwd of ["/owned/workspace", "C:/owned/workspace", "C:\\owned\\workspace", "\\\\server\\share\\workspace"]) {
    assert.deepEqual(parseNativeCommands(withCwd(cwd)).entries, withCwd(cwd).entries);
    assert.deepEqual(DSMM_CONFIG_SCHEMA({ permissionControl: { nativeCommands: withCwd(cwd) } }).permissionControl!.nativeCommands!.entries, withCwd(cwd).entries);
  }
  for (const cwd of ["relative", "C:relative", "\\workspace", "\\\\server", "", " \t", "C:/bad\0cwd"]) {
    assert.throws(() => parseNativeCommands(withCwd(cwd)), { code: "validation" });
  }
  const cwd = resolve("owned", ".."), nonCanonical = `${cwd}/child/..`;
  assert.deepEqual(parseHostNativeCommands(withCwd(nonCanonical)).entries, withCwd(normalize(nonCanonical)).entries);
  const canonicalMatch = nativeCommandMatch(parseNativeCommands(withCwd(nonCanonical)), "pwsh", identity, { command: "go test -count=1 .", workdir: cwd }, cwd);
  assert.ok(typeof canonicalMatch === "object" && canonicalMatch !== null); assert.equal(canonicalMatch.id, entry.id);
  assert.deepEqual(parseHostNativeCommands(withCwd(parse(cwd).root)).entries, withCwd(parse(cwd).root).entries);
  const foreignCwd = isAbsolute("C:/owned/workspace") ? "/owned/workspace" : "C:/owned/workspace";
  assert.doesNotThrow(() => parseNativeCommands(withCwd(foreignCwd)));
  assert.throws(() => parseHostNativeCommands(withCwd(foreignCwd)), { code: "validation" });
  assert.throws(() => nativeCommandMatch(parseNativeCommands(withCwd(foreignCwd)), "pwsh", identity, { command: "go test -count=1 .", workdir: cwd }, cwd), { code: "validation" });
});
test("finite pattern matching preserves executable/subcommand case, cwd, tool and static quotes", () => {
  const settings = parseNativeCommands({ enabled: true, entries: [entry] });
  const match = (command: string, workdir = resolve("."), tool: "bash" | "pwsh" = "pwsh") => nativeCommandMatch(settings, tool, identity, { command, workdir }, resolve("."));
  const quotedMatch = match("go test '-count=1' \".\"");
  assert.ok(typeof quotedMatch === "object" && quotedMatch !== null); assert.equal(quotedMatch.id, entry.id);
  for (const command of ["Go test -count=1 .", "go Test -count=1 .", "go test -count=1 .; go clean", "go test -count=1 . | echo x", "go test $args", "go test @args", "go test --% -count=1 .", "go test -count=1 . > x", "pwsh -Command 'go test -count=1 .'", "go test\n-count=1 .", "go test `'.'", "go test -count=1 {x}"]) assert.equal(match(command), undefined);
  assert.equal(match("go test -count=1 .", resolve("other")), undefined);
  assert.equal(match("go test -count=1 .", resolve("."), "bash"), undefined);
  assert.deepEqual(literalCommand("go test '中文 café'", "posix"), ["go", "test", "中文 café"]);
  assert.equal(literalCommand("go test $(echo x)", "posix"), undefined);
  const ask = { ...entry, id: "ask", mode: "ask" as const };
  const askMatch = nativeCommandMatch(parseNativeCommands({ enabled: true, entries: [entry, ask] }), "pwsh", identity, { command: "go test -count=1 ." }, resolve("."));
  assert.ok(typeof askMatch === "object" && askMatch !== null); assert.equal(askMatch.mode, "ask");
  assert.equal(nativeCommandMatch(parseNativeCommands({ enabled: true, entries: [entry, { ...ask, sandboxMode: "workspace-write" }] }), "pwsh", identity, { command: "go test -count=1 ." }, resolve(".")), "ambiguous");
});
