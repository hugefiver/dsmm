import assert from "node:assert/strict";
import { test, mock } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { nativeRoutingFixture } from "./native-routing-fixture.ts";
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
      const hostResult = await agent.ctx.get("tools")!.execute({ agent, name: "mcp__host_lsp__status", arguments: {},
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
  const f = await nativeRoutingFixture({ defaultActive: true, lsp: { enabled: true, command, args, failOnStartupError: true } });
  try {
    const agent = await f.create();
    const state = f.ctx.get("dsmmLspState")!();
    assert.equal(state.state, "ready", JSON.stringify(state));
    assert.ok(state.tools.includes("mcp__dsmm_lsp__status"));
    const result = await agent.ctx.get("tools")!.execute({ agent, name: "mcp__dsmm_lsp__status", arguments: {},
      callId: ToolCallId("enabled-lsp-status"), signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
  } finally { await f.dispose(); }
});
