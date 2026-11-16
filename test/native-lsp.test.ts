import assert from "node:assert/strict";
import { test, mock } from "node:test";
import childProcess from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { executeFixtureTool, nativeRoutingFixture } from "./native-routing-fixture.ts";
import { createDsmmStatusSnapshot } from "../lib/status.js";
import type { DsmmProfileRuntime } from "../lib/profile-runtime.js";
import type { DshAgent } from "../lib/dsh-types.js";
import type { DshContext } from "../lib/dsh-types.js";
import { DsmmDeploymentConfig } from "../lib/deployment-config.js";
import { parseLspSmokeCommand } from "../lib/lsp.js";

for (const enabled of [false, true]) {
  test(`default-disabled native LSP retains future enabled=${enabled} configuration without changing its running admission`, async () => {
    const command = "dsmm-retained-lsp-executable";
    let lspSpawns = 0;
    const spawn = childProcess.spawn;
    const spy = mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
      if (args[0] === command) lspSpawns++;
      return spawn(...args);
    });
    syncBuiltinESMExports();
    let hostCalls = 0;
    let f: Awaited<ReturnType<typeof nativeRoutingFixture>> | undefined;
    try {
      f = await nativeRoutingFixture({ defaultActive: true }, {
        fixtureTools: [{ name: "mcp__host_lsp__status", description: "Host-owned LSP status", parameters: {},
          output: { schema: { type: "string" }, render: () => [{ type: "text", text: "host LSP" }] },
          async execute() { hostCalls++; return "host LSP"; } }],
      });
      const agent = await f.create();
      const desired = new DsmmDeploymentConfig(f.ctx as unknown as DshContext, {});
      await desired.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["lsp"],
        value: { enabled, command, args: ["mcp"], failOnStartupError: true } }] }, () => {});
      const state = f.ctx.get("dsmmLspState")!();
      assert.deepEqual(state, { state: "disabled", tools: [] });
      assert.equal(lspSpawns, 0);
      assert.equal(agent.ctx.get("tools")!.get("mcp__dsmm_lsp__status", agent), undefined);
      const runtime = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
      const settings = runtime.getSettings(agent as unknown as DshAgent);
      assert.equal(settings.lsp.enabled, false);
      const deployment = f.ctx.get("dsmmDeploymentConfig");
      assert.ok(deployment);
      assert.equal((await deployment.readGlobal()).config.lsp?.enabled, enabled);
      const status = createDsmmStatusSnapshot({ agent: agent as unknown as DshAgent, settings, modeActive: true,
        admission: runtime.admission(agent as unknown as DshAgent) });
      assert.equal(status.lspRuntime?.state, "disabled");
      const hostResult = await executeFixtureTool(agent.ctx.get("tools")!, { agent, name: "mcp__host_lsp__status", arguments: {},
        callId: ToolCallId("host-lsp"), signal: new AbortController().signal });
      assert.equal(hostResult.isError, false);
      assert.equal(hostCalls, 1);
    } finally {
      await f?.dispose();
      spy.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test("explicitly enabled LSP uses the real host MCP bridge and exposes its status tool", {
  skip: process.env.DSMM_TEST_DSH_ENTRY === undefined ? "not covered: explicit enabled LSP requires real host anchor DSMM_TEST_DSH_ENTRY" : false,
  timeout: 30_000,
}, async () => {
  const [command, ...args] = parseLspSmokeCommand(process.env.DSMM_LSP_SMOKE_COMMAND, ["ocmm-lsp", "mcp"]);
  const root = mkdtempSync(join(tmpdir(), "dsmm-native-lsp-status-"));
  let f: Awaited<ReturnType<typeof nativeRoutingFixture>> | undefined;
  try {
    f = await nativeRoutingFixture({ defaultActive: true, lsp: { enabled: true, command, args, cwd: root,
      env: { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, XDG_CONFIG_HOME: root }, failOnStartupError: true } });
    const agent = await f.create();
    const state = f.ctx.get("dsmmLspState")!();
    assert.equal(state.state, "ready", JSON.stringify(state));
    assert.ok(state.tools.includes("mcp__dsmm_lsp__status"));
    const result = await executeFixtureTool(agent.ctx.tools, { agent, name: "mcp__dsmm_lsp__status", arguments: {},
      callId: ToolCallId("enabled-lsp-status"), signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
  } finally {
    try { await f?.dispose(); }
    finally {
      assert.equal(lstatSync(root).isSymbolicLink(), false);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

for (const readonlyMode of [false, true]) test(readonlyMode
  ? "explicitly enabled LSP denies readonly rename and format without changing source"
  : "explicitly enabled LSP performs real Go queries and cross-file rename", {
  skip: process.env.DSMM_TEST_DSH_ENTRY === undefined || !process.env.DSMM_LSP_SMOKE_COMMAND?.trim()
    ? "not covered: real Go operations require DSMM_TEST_DSH_ENTRY, explicit DSMM_LSP_SMOKE_COMMAND and gopls" : false,
  timeout: 60_000,
}, async t => {
  const [command, ...args] = parseLspSmokeCommand(process.env.DSMM_LSP_SMOKE_COMMAND, ["ocmm-lsp", "mcp"]);
  const root = mkdtempSync(join(tmpdir(), "dsmm-native-lsp-"));
  const home = join(root, "home");
  mkdirSync(home);
  mkdirSync(join(root, "broken"));
  const definition = join(root, "greeting.go"), reference = join(root, "use.go"), broken = join(root, "broken", "broken.go");
  const definitionText = 'package acceptance\n\nfunc greeting() string { return "hello" }\n';
  const referenceText = 'package acceptance\n\nvar message= greeting()\n';
  writeFileSync(join(root, "go.mod"), "module example.com/dsmm-lsp-acceptance\n\ngo 1.22\n");
  writeFileSync(definition, definitionText);
  writeFileSync(reference, referenceText);
  writeFileSync(broken, 'package broken\n\nvar invalid int = "wrong"\n');
  let f: Awaited<ReturnType<typeof nativeRoutingFixture>> | undefined;
  try {
    f = await nativeRoutingFixture({ defaultActive: true, lsp: { enabled: true, command, args, cwd: root,
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home,
        XDG_CACHE_HOME: home, GOENV: "off", GOWORK: "off", GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local",
        GOCACHE: join(root, "go-cache"), GOMODCACHE: join(root, "go-mod-cache") }, failOnStartupError: true } });
    const agent = await f.create({ agentPreset: "dsmm-orchestrator" });
    const state = f.ctx.get("dsmmLspState")!();
    assert.equal(state.state, "ready", JSON.stringify(state));
    for (const name of ["status", "diagnostics", "goto_definition", "find_references", "rename", "format"]) {
      assert.ok(state.tools.includes(`mcp__dsmm_lsp__${name}`));
    }
    const execute = (name: string, arguments_: Record<string, unknown>, actor = agent) => executeFixtureTool(actor.ctx.tools, {
      agent: actor, name: `mcp__dsmm_lsp__${name}`, arguments: arguments_, callId: ToolCallId(`lsp-${name}`),
      signal: AbortSignal.timeout(30_000) });
    await t.test("status reaches the native MCP server", async () => {
      const result = await execute("status", {});
      assert.equal(result.isError, false, JSON.stringify(result));
    });
    if (!readonlyMode) {
      for (const [name, arguments_, expectedFile] of [
        ["diagnostics", { filePath: broken }, "broken.go"],
        ["goto_definition", { filePath: reference, line: 3, character: 14 }, "greeting.go"],
        ["find_references", { filePath: definition, line: 3, character: 7, includeDeclaration: true }, "use.go"],
      ] as const) {
        await t.test(`${name} returns the expected source location`, async () => {
          const result = await execute(name, arguments_);
          assert.equal(result.isError, false, JSON.stringify(result));
          const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
          assert.ok(text.includes(expectedFile), text);
          if (name === "diagnostics") assert.ok(text.includes("wrong"), text);
        });
      }
      await t.test("admitted rename changes the declaration and cross-file reference", async () => {
        const renamed = await execute("rename", { filePath: definition, line: 3, character: 7, newName: "welcome" });
        assert.equal(renamed.isError, false, JSON.stringify(renamed));
        assert.equal(readFileSync(definition, "utf8"), definitionText.replace("greeting", "welcome"));
        assert.equal(readFileSync(reference, "utf8"), referenceText.replace("greeting", "welcome"));
      });
    } else {
      const beforeDefinition = readFileSync(definition, "utf8"), beforeReference = readFileSync(reference, "utf8");
      const readonly = await f!.createAuxiliary("dsmm-reviewer", undefined, "one-shot", agent);
      try {
        assert.equal((await execute("status", {}, readonly)).isError, false);
        for (const [name, arguments_] of [
          ["rename", { filePath: definition, line: 3, character: 7, newName: "forbidden" }],
          ["format", { filePath: reference }],
        ] as const) {
          assert.equal(readonly.ctx.tools.get(`mcp__dsmm_lsp__${name}`, readonly), undefined);
          const denied = await execute(name, arguments_, readonly);
          assert.equal(denied.isError, true, JSON.stringify(denied));
          t.diagnostic(`${name} denial: ${JSON.stringify(denied.error)}`);
          assert.equal(readFileSync(definition, "utf8"), beforeDefinition);
          assert.equal(readFileSync(reference, "utf8"), beforeReference);
        }
      } finally { await f!.releaseAuxiliary(readonly); }
    }
  } finally {
    try { await f?.dispose(); }
    finally {
      assert.equal(lstatSync(root).isSymbolicLink(), false);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
