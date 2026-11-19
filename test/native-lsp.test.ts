import assert from "node:assert/strict";
import { test, mock } from "node:test";
import childProcess from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { executeFixtureTool, nativeFixturePlugin, nativeRoutingFixture } from "./native-routing-fixture.ts";
import { createDsmmStatusSnapshot } from "../lib/status.js";
import type { DsmmProfileRuntime } from "../lib/profile-runtime.js";
import type { DshAgent } from "../lib/dsh-types.js";
import type { DshContext } from "../lib/dsh-types.js";
import { DsmmDeploymentConfig } from "../lib/deployment-config.js";
import { parseLspSmokeCommand, toDshMcpClientConfig } from "../lib/lsp.js";
import type { DsmmLspSettings } from "../lib/lsp.js";

const specifier = "@dsmm/dsmm/lsp";
const fixtureScript = fileURLToPath(new URL("./lsp-stdio-fixture.mjs", import.meta.url));

async function lspEntryFixture(lsp: Partial<DsmmLspSettings>, beforeCore?: (ctx: Context) => Promise<void>) {
  // The routing fixture's in-memory Loader resolves peers from the Host. Resolve
  // this bundle subpath from the package under test, as an installed profile does.
  const url = import.meta.resolve(specifier);
  const hook = registerHooks({ resolve(name, context, next) { return name === specifier ? { url, shortCircuit: true } : next(name, context); } });
  let id: string;
  try {
    const f = await nativeRoutingFixture({ defaultActive: true, lsp }, { beforeDsmm: async ctx => {
      id = await ctx.loader.create({ name: specifier, disabled: true });
      await beforeCore?.(ctx);
    } });
    return { ...f, async toggle(enabled: boolean) {
      await f.ctx.loader.update(id, { disabled: !enabled });
      await f.ctx.loader.await();
      if (enabled) await f.ctx.loader.resolve(id).fiber!.await();
    }, async dispose() { try { await f.dispose(); } finally { hook.deregister(); } } };
  } catch (error) { hook.deregister(); throw error; }
}

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

test("legacy composition without an LSP entry honors lsp.enabled at startup", {
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

for (const tool of ["status", ""]) test(tool
  ? "native LSP toggle withdraws only its tools, stays off over Core restart, and reactivates"
  : "an empty LSP entry never reports same-prefix independent MCP tools as ready", {
  skip: !process.env.DSMM_TEST_DSH_ENTRY && "requires a trusted Host MCP client",
}, async () => {
  const anchor = process.env.DSMM_TEST_DSH_ENTRY!;
  const native = await import(pathToFileURL(createRequire(anchor).resolve("@deepseek-ai/dsh-mcp-client")).href);
  const command = process.execPath;
  const f = await lspEntryFixture({ enabled: true, command, args: [fixtureScript, tool], failOnStartupError: false }, async ctx => {
    await ctx.plugin(native, toDshMcpClientConfig({ serverName: "dsmm_lsp__other", command, args: [fixtureScript, "probe"] })).await();
    if (tool) {
      ctx.loader.builtins["lsp-test-realm"] = { default: { async apply(scope: Context) {
        const realm = scope.isolate("tools").isolate("systemPrompt");
        await realm.plugin(SystemPrompt, {}).await();
        await realm.plugin(ToolRuntime, {}).await();
        if ("setExecutor" in ToolRuntime.prototype) await realm.plugin(await nativeFixturePlugin("@deepseek-ai/dsh-tool-executor-native")).await();
      } } };
      await ctx.agentPresets.register({ id: "lsp-isolated", name: "Isolated tools", description: "Own native tool registry",
        plugins: [{ name: "cordis:lsp-test-realm" }] });
    }
  });
  try {
    const foreign = "mcp__dsmm_lsp__other__probe", managed = "mcp__dsmm_lsp__status";
    const state = () => f.ctx.get("dsmmLspState")!();
    const agent = await f.create();
    const call = (name: string, actor = agent) => executeFixtureTool(actor.ctx.tools, { agent: actor, name, arguments: {}, callId: ToolCallId(name), signal: AbortSignal.timeout(5_000) });
    assert.deepEqual(state(), { state: "disabled", tools: [] });
    assert.equal(agent.ctx.tools.get(managed), undefined);
    await f.toggle(true);
    const resident = tool ? await f.create({ agentPreset: "lsp-isolated" }) : undefined;
    const realm = resident && f.ctx.agentPresets.serviceFor(resident, "tools");
    const initial = realm?.get(managed, resident);
    if (tool) {
      assert.ok(realm && initial && resident);
      assert.equal(realm.get(foreign, resident), undefined);
      assert.deepEqual((await executeFixtureTool(realm, { name: managed, agent: resident, arguments: {}, callId: ToolCallId("resident-initial"), signal: AbortSignal.timeout(5_000) })).content, [{ type: "text", text: "stdio:status" }]);
      assert.deepEqual(state(), { state: "ready", tools: [managed] });
      assert.deepEqual((await call(managed)).content, [{ type: "text", text: "stdio:status" }]);
      const deployment = f.ctx.get("dsmmDeploymentConfig")!;
      const path = ["modules", "deepwork", "enabled"];
      const off = await deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path, value: false }] }, () => {});
      const limited = await f.create();
      assert.equal((await call(managed, limited)).isError, true);
      assert.deepEqual((await call(foreign, limited)).content, [{ type: "text", text: "stdio:probe" }]);
      await deployment.saveGlobal({ expectedRevision: off.revision, edits: [{ op: "unset", path }] }, () => {});
    } else assert.deepEqual(state(), { state: "unavailable", diagnostic: "native-tools-unavailable", tools: [] });
    await f.toggle(false);
    assert.deepEqual(state(), { state: "disabled", tools: [] });
    assert.equal(agent.ctx.tools.get(managed), undefined);
    assert.deepEqual((await call(foreign)).content, [{ type: "text", text: "stdio:probe" }]);
    if (tool) {
      assert.ok(realm && resident);
      assert.equal(realm.get(managed, resident), undefined);
      assert.ok(!realm.schemas(resident).some(schema => schema.name === managed));
      assert.equal((await executeFixtureTool(realm, { name: managed, agent: resident, arguments: {}, callId: ToolCallId("resident-off"), signal: AbortSignal.timeout(5_000) })).isError, true);
      assert.equal(realm.get(foreign, resident), undefined);
      await f.toggle(true);
      assert.ok(realm.get(managed, resident));
      assert.notEqual(realm.get(managed, resident), initial);
      assert.deepEqual((await executeFixtureTool(realm, { name: managed, agent: resident, arguments: {}, callId: ToolCallId("resident-reactivated"), signal: AbortSignal.timeout(5_000) })).content, [{ type: "text", text: "stdio:status" }]);
      await f.toggle(false);
      await f.dsmmFiber.restart();
      assert.deepEqual(state(), { state: "disabled", tools: [] });
      assert.equal(f.tools.get(managed), undefined);
      assert.equal(realm.get(managed, resident), undefined);
      await f.toggle(true);
      assert.deepEqual(state(), { state: "ready", tools: [managed] });
      assert.notEqual(realm.get(managed, resident), initial);
      const successor = await f.create({ agentPreset: "lsp-isolated" });
      assert.equal(f.ctx.agentPresets.serviceFor(successor, "tools")!.get(managed, successor), f.tools.get(managed));
    }
  } finally { await f.dispose(); }
});

test("native LSP activation honors a disabled startup Deepwork module", async () => {
  const f = await lspEntryFixture({ enabled: true, command: "must-not-start", failOnStartupError: true }, async ctx => {
    const config = new DsmmDeploymentConfig(ctx as unknown as DshContext, {});
    await config.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["modules", "deepwork", "enabled"], value: false }] }, () => {});
  });
  try {
    await f.toggle(true);
    assert.deepEqual(f.ctx.get("dsmmLspState")!(), { state: "disabled", tools: [] });
    assert.equal(f.tools.get("mcp__dsmm_lsp__status"), undefined);
  } finally { await f.dispose(); }
});

test("failed strict LSP activation leaves Core running and never starts the legacy bridge", async () => {
  const f = await lspEntryFixture({ enabled: true, command: process.execPath, args: [fixtureScript], failOnStartupError: true });
  try {
    assert.deepEqual(f.ctx.get("dsmmLspState")!(), { state: "disabled", tools: [] });
    await assert.rejects(f.toggle(true));
    assert.ok(f.ctx.get("dsmmNativeAdmission"));
    assert.deepEqual(f.ctx.get("dsmmLspState")!(), { state: "unavailable", tools: [],
      diagnostic: process.env.DSMM_TEST_DSH_ENTRY ? "native-tools-unavailable" : "host-anchor-unavailable" });
    await f.toggle(false);
    assert.deepEqual(f.ctx.get("dsmmLspState")!(), { state: "disabled", tools: [] });
  } finally { await f.dispose(); }
});

for (const readonlyMode of [false, true]) test(readonlyMode
  ? "native LSP entry denies readonly rename and format without changing source"
  : "native LSP entry performs real Go queries and cross-file rename", {
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
  let f: Awaited<ReturnType<typeof lspEntryFixture>> | undefined;
  try {
    f = await lspEntryFixture({ command, args, cwd: root,
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home,
        XDG_CACHE_HOME: home, GOENV: "off", GOWORK: "off", GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local",
        GOCACHE: join(root, "go-cache"), GOMODCACHE: join(root, "go-mod-cache") }, failOnStartupError: true });
    await f.toggle(true);
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
