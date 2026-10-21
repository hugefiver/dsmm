export const DSMM_LSP_SERVER_NAME = "dsmm_lsp";
export const DSMM_LSP_TOOL_NAMES = [
  "status",
  "diagnostics",
  "goto_definition",
  "find_references",
  "find_symbol_related",
  "symbols",
  "prepare_rename",
  "rename",
  "format"
] as const;
export type DsmmLspToolName = (typeof DSMM_LSP_TOOL_NAMES)[number];

export interface DsmmLspRuntimeState {
  state: "disabled" | "ready" | "unavailable";
  diagnostic?: "host-anchor-unavailable" | "native-package-unavailable" | "native-tools-unavailable";
  tools: readonly string[];
}
declare module "@deepseek-ai/cordis" { interface Context { dsmmLspState: () => DsmmLspRuntimeState } }

/** Optional native package resolution is anchored by the trusted host, not home guesses or CLI paths. */
export async function registerLspRuntime(ctx: Context, settings: DsmmLspSettings, getSettings?: import("./settings.js").DsmmSettingsGetter): Promise<void> {
  let state: DsmmLspRuntimeState = { state: "disabled", tools: [] };
  ctx.provide("dsmmLspState", () => state);
  if (!settings.enabled) return;
  const anchor = (ctx.get("profileContext") as { installAnchor?: string } | undefined)?.installAnchor;
  const unavailable = (diagnostic: DsmmLspRuntimeState["diagnostic"]): void => {
    state = { state: "unavailable", tools: [], diagnostic };
    if (settings.failOnStartupError) throw new Error(`DSMM LSP startup unavailable: ${diagnostic}`);
  };
  if (anchor === undefined) { unavailable("host-anchor-unavailable"); return; }
  let plugin;
  try {
    const modulePath = createRequire(anchor).resolve("@deepseek-ai/dsh-mcp-client");
    plugin = await import(pathToFileURL(modulePath).href);
  } catch { unavailable("native-package-unavailable"); return; }
  if (typeof plugin.apply !== "function") { unavailable("native-package-unavailable"); return; }
  const before = new Map(ctx.get("tools")?.schemas().map((row) => [row.name, ctx.get("tools")!.get(row.name)]) ?? []);
  try { await ctx.plugin(plugin, toDshMcpClientConfig(settings)).await(); }
  catch { unavailable("native-tools-unavailable"); return; }
  const tools = ctx.get("tools");
  const names = tools?.schemas().map((tool) => tool.name).filter((name) => name.startsWith(`mcp__${settings.serverName}__`)) ?? [];
  if (names.length === 0) { unavailable("native-tools-unavailable"); return; }
  if (getSettings !== undefined) {
    const owned = new Map(names.filter((name) => tools!.get(name) !== before.get(name)).map((name) => [name, tools!.get(name)]));
    const dispose = tools!.guard((execution) => execution.agent !== undefined
      && owned.has(execution.name) && owned.get(execution.name) === tools!.get(execution.name, execution.agent)
      && !getSettings(execution.agent as unknown as import("./dsh-types.js").DshAgent).modules.deepwork.enabled
      ? "Deepwork LSP is not admitted in this Agent" : undefined);
    ctx.effect(() => dispose);
  }
  state = { state: "ready", tools: names };
  ctx.on("tools/change", () => {
    const names = tools!.schemas().map((tool) => tool.name).filter((name) => name.startsWith(`mcp__${settings.serverName}__`));
    state = names.length === 0 ? { state: "unavailable", diagnostic: "native-tools-unavailable", tools: [] } : { state: "ready", tools: names };
  });
  ctx.effect(() => () => { state = { state: "unavailable", diagnostic: "native-tools-unavailable", tools: [] }; });
}

export interface DsmmLspSettings {
  enabled: boolean;
  serverName: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  toolCallTimeoutMs: number;
  failOnStartupError: boolean;
}

export interface DshMcpStdioConfig {
  transport: "stdio";
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  toolCallTimeoutMs: number;
  failOnStartupError: boolean;
}

export const DEFAULT_DSMM_LSP_SETTINGS: DsmmLspSettings = {
  enabled: false,
  serverName: "dsmm_lsp",
  command: "ocmm-lsp",
  args: ["mcp"],
  cwd: "",
  env: {},
  toolCallTimeoutMs: 60000,
  failOnStartupError: true
};

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;

export function resolveLspSettings(input: Partial<DsmmLspSettings> = {}): DsmmLspSettings {
  const serverName = input.serverName ?? DEFAULT_DSMM_LSP_SETTINGS.serverName;
  validateServerName(serverName);

  const command = input.command ?? DEFAULT_DSMM_LSP_SETTINGS.command;
  if (typeof command !== "string" || command.trim() === "") throw new Error("dsmm lsp command must be a non-empty string");

  const args = input.args ?? DEFAULT_DSMM_LSP_SETTINGS.args;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("dsmm lsp args must be an array of strings");

  const env = input.env ?? DEFAULT_DSMM_LSP_SETTINGS.env;
  if (!isStringRecord(env)) throw new Error("dsmm lsp env must be a string record");

  return {
    enabled: input.enabled ?? DEFAULT_DSMM_LSP_SETTINGS.enabled,
    serverName,
    command,
    args: [...args],
    cwd: input.cwd ?? DEFAULT_DSMM_LSP_SETTINGS.cwd,
    env: { ...env },
    toolCallTimeoutMs: normalizeTimeout(input.toolCallTimeoutMs),
    failOnStartupError: input.failOnStartupError ?? DEFAULT_DSMM_LSP_SETTINGS.failOnStartupError
  };
}

export function toDshMcpClientConfig(input: Partial<DsmmLspSettings> = {}): DshMcpStdioConfig {
  const settings = resolveLspSettings(input);

  return {
    transport: "stdio",
    serverName: settings.serverName,
    command: settings.command,
    args: settings.args,
    env: settings.env,
    cwd: settings.cwd,
    toolCallTimeoutMs: settings.toolCallTimeoutMs,
    failOnStartupError: settings.failOnStartupError
  };
}

export function publicLspToolName(rawName: DsmmLspToolName, serverName = DEFAULT_DSMM_LSP_SETTINGS.serverName): string {
  validateServerName(serverName);
  return `mcp__${serverName}__${rawName}`;
}

export function renderLspMcpPatch(input: Partial<DsmmLspSettings> = {}): string {
  const settings = resolveLspSettings(input);
  const lines = [
    "# Example only: opt-in dsmm LSP MCP bridge.",
    "# Uses the ocmm-lsp executable published by the ocmm npm package; no LSP source or native build is bundled by DSMM.",
    "- insert:",
    "    - id: dsmm-lsp-mcp",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        transport: stdio",
    `        serverName: ${renderYamlScalar(settings.serverName)}`,
    `        command: ${renderYamlScalar(settings.command)}`,
    ...renderYamlStringArray("        args", settings.args),
    ...renderYamlStringRecord("        env", settings.env),
    `        cwd: ${renderYamlScalar(settings.cwd)}`,
    `        toolCallTimeoutMs: ${settings.toolCallTimeoutMs}`,
    `        failOnStartupError: ${settings.failOnStartupError}`
  ];

  return `${lines.join("\n")}\n`;
}

export function parseLspSmokeCommand(raw: string | undefined, fallback: readonly string[]): string[] {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return [...fallback];

  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (cause) {
      throw new Error("dsmm lsp smoke command must be a non-empty string array when provided as JSON", { cause });
    }

    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((value) => typeof value !== "string")) {
      throw new Error("dsmm lsp smoke command must be a non-empty string array when provided as JSON");
    }

    return [...parsed];
  }

  return [trimmed, "mcp"];
}

function validateServerName(serverName: string): void {
  if (!SERVER_NAME_PATTERN.test(serverName)) throw new Error("dsmm lsp serverName must match /^[A-Za-z0-9_-]{1,32}$/u");
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_DSMM_LSP_SETTINGS.toolCallTimeoutMs;
  return Math.floor(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function renderYamlStringArray(key: string, values: readonly string[]): string[] {
  if (values.length === 0) return [`${key}: []`];
  const itemIndent = `${key.match(/^ */u)?.[0] ?? ""}  `;
  return [
    `${key}:`,
    ...values.map((value) => `${itemIndent}- ${renderYamlScalar(value)}`)
  ];
}

function renderYamlStringRecord(key: string, values: Record<string, string>): string[] {
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return [`${key}: {}`];
  const itemIndent = `${key.match(/^ */u)?.[0] ?? ""}  `;
  return [
    `${key}:`,
    ...entries.map(([entryKey, value]) => `${itemIndent}${renderYamlScalar(entryKey)}: ${renderYamlScalar(value)}`)
  ];
}

function renderYamlScalar(value: string): string {
  if (isPlainYamlScalar(value)) return value;
  return JSON.stringify(value);
}

function isPlainYamlScalar(value: string): boolean {
  if (value === "") return false;
  if (value !== value.trim()) return false;
  if (!/^[A-Za-z0-9_./-]+$/u.test(value)) return false;
  if (/^(?:true|false|null|~)$/iu.test(value)) return false;
  if (/^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) return false;
  return !value.startsWith("---") && !value.startsWith("...");
}
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
