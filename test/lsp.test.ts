import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DSMM_LSP_SETTINGS,
  DSMM_LSP_SERVER_NAME,
  DSMM_LSP_TOOL_NAMES,
  parseLspSmokeCommand,
  publicLspToolName,
  renderLspMcpPatch,
  resolveLspSettings,
  toDshMcpClientConfig
} from "../lib/lsp.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("resolveLspSettings returns deep-copied defaults", () => {
  const settings = resolveLspSettings();

  assert.deepEqual(settings, DEFAULT_DSMM_LSP_SETTINGS);
  assert.notEqual(settings.args, DEFAULT_DSMM_LSP_SETTINGS.args);
  assert.notEqual(settings.env, DEFAULT_DSMM_LSP_SETTINGS.env);
});

test("publicLspToolName renders public MCP tool names and validates server names", () => {
  assert.equal(DSMM_LSP_SERVER_NAME, "dsmm_lsp");
  assert.deepEqual(DSMM_LSP_TOOL_NAMES, [
    "status",
    "diagnostics",
    "goto_definition",
    "find_references",
    "find_symbol_related",
    "symbols",
    "prepare_rename",
    "rename",
    "format"
  ]);
  assert.equal(publicLspToolName("diagnostics"), "mcp__dsmm_lsp__diagnostics");
  assert.equal(publicLspToolName("rename", "custom-lsp_1"), "mcp__custom-lsp_1__rename");
  assert.equal(publicLspToolName("format"), "mcp__dsmm_lsp__format");
  assert.throws(() => publicLspToolName("status", "invalid.name"), /serverName/u);
});

test("resolveLspSettings validates inputs and normalizes timeout", () => {
  const env = { DSMM_TRACE: "1" };
  const args = ["--stdio", "mcp"];
  const settings = resolveLspSettings({
    enabled: true,
    serverName: "abc_123",
    command: "/usr/local/bin/ocmm-lsp",
    args,
    cwd: "/workspace/project",
    env,
    toolCallTimeoutMs: 1234.9,
    failOnStartupError: false
  });

  assert.deepEqual(settings, {
    enabled: true,
    serverName: "abc_123",
    command: "/usr/local/bin/ocmm-lsp",
    args,
    cwd: "/workspace/project",
    env,
    toolCallTimeoutMs: 1234,
    failOnStartupError: false
  });
  assert.notEqual(settings.args, args);
  assert.notEqual(settings.env, env);
  assert.equal(resolveLspSettings({ toolCallTimeoutMs: 0 }).toolCallTimeoutMs, DEFAULT_DSMM_LSP_SETTINGS.toolCallTimeoutMs);
  assert.equal(resolveLspSettings({ toolCallTimeoutMs: Number.POSITIVE_INFINITY }).toolCallTimeoutMs, DEFAULT_DSMM_LSP_SETTINGS.toolCallTimeoutMs);
  assert.throws(() => resolveLspSettings({ serverName: "invalid.name" }), /serverName/u);
  assert.throws(() => resolveLspSettings({ command: "   " }), /command/u);
  assert.throws(() => resolveLspSettings({ args: ["mcp", 1] as unknown as string[] }), /args/u);
});

test("toDshMcpClientConfig omits dsmm-only enabled flag", () => {
  const config = toDshMcpClientConfig({ enabled: true, serverName: "lsp2", args: ["mcp", "--log"], env: { A: "B" } });

  assert.deepEqual(config, {
    transport: "stdio",
    serverName: "lsp2",
    command: "ocmm-lsp",
    args: ["mcp", "--log"],
    env: { A: "B" },
    cwd: "",
    toolCallTimeoutMs: 60000,
    failOnStartupError: true
  });
  assert.equal("enabled" in config, false);
});

test("renderLspMcpPatch renders stable copyable YAML", () => {
  assert.equal(renderLspMcpPatch({
    serverName: "my_lsp",
    command: "/usr/local/bin/ocmm-lsp",
    args: ["mcp", "--flag value"],
    cwd: "/repo/root",
    env: { ZED: "last", ALPHA: "first value" },
    toolCallTimeoutMs: 2500,
    failOnStartupError: false
  }), `# Example only: opt-in dsmm LSP MCP bridge.
# Uses the ocmm-lsp executable published by the ocmm npm package; no LSP source or native build is bundled by DSMM.
- insert:
    - id: dsmm-lsp-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: my_lsp
        command: /usr/local/bin/ocmm-lsp
        args:
          - mcp
          - "--flag value"
        env:
          ALPHA: "first value"
          ZED: last
        cwd: /repo/root
        toolCallTimeoutMs: 2500
        failOnStartupError: false
`);
});

test("parseLspSmokeCommand handles fallback, JSON arrays, and plain commands", () => {
  const fallback = ["ocmm-lsp", "mcp"] as const;

  assert.deepEqual(parseLspSmokeCommand(undefined, fallback), ["ocmm-lsp", "mcp"]);
  assert.deepEqual(parseLspSmokeCommand("   ", fallback), ["ocmm-lsp", "mcp"]);
  assert.deepEqual(parseLspSmokeCommand('["node","dist/cli/ocmm-lsp.js","mcp"]', fallback), ["node", "dist/cli/ocmm-lsp.js", "mcp"]);
  assert.deepEqual(parseLspSmokeCommand("/usr/local/bin/ocmm-lsp", fallback), ["/usr/local/bin/ocmm-lsp", "mcp"]);
  assert.throws(() => parseLspSmokeCommand("[]", fallback), /non-empty string array/u);
  assert.throws(() => parseLspSmokeCommand('["ocmm-lsp",1]', fallback), /non-empty string array/u);
});

test("example LSP MCP patch matches renderer output", () => {
  const patchPath = join(packageRoot, "patches", "ocmm-lsp-mcp.example.cordis.patch.yml");

  assert.equal(readFileSync(patchPath, "utf8"), renderLspMcpPatch({ enabled: true }));
});
