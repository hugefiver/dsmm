import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { DshAgent } from "./dsh-types.js";
import type { DsmmSettingsGetter } from "./settings.js";

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
declare module "@deepseek-ai/cordis" { interface Context {
  dsmmLspState: () => DsmmLspRuntimeState;
  dsmmLspEntry: (scope: Context) => Promise<void>;
  dsmmProjectLsp: (install: (definition: ToolDefinition) => (() => void) | undefined) => () => void;
} }

export async function configureLspLifecycle(core: Context, getSettings: DsmmSettingsGetter): Promise<void> {
  const startup = getSettings();
  const group = core.fiber.entry?.parent;
  // Loader publishes the whole group's configuration before starting any child,
  // including disabled entries that never acquire a fiber.
  const row = group?.data.find(entry => entry.name === "@dsmm/dsmm/lsp");
  if (!row && !startup.modules.deepwork.enabled) return;
  let current: (() => DsmmLspRuntimeState) | undefined;
  let diagnostic: NonNullable<DsmmLspRuntimeState["diagnostic"]> = "native-tools-unavailable";
  core.provide("dsmmLspState", (): DsmmLspRuntimeState => current?.() ?? (
    startup.modules.deepwork.enabled && row && group?.tree.store[row.id]?.disabled === false
      ? { state: "unavailable", diagnostic, tools: [] } : { state: "disabled", tools: [] }));

  const owned = new Map<string, ToolDefinition>();
  const observers = new Set<(definition: ToolDefinition, added: boolean) => void>();
  core.provide("dsmmProjectLsp", install => {
    const copies = new Map<ToolDefinition, () => void>();
    const update = (definition: ToolDefinition, added: boolean) => {
      if (!added) { copies.get(definition)?.(); copies.delete(definition); return; }
      const dispose = install(definition);
      if (dispose) copies.set(definition, dispose);
    };
    const stop = () => { observers.delete(update); for (const dispose of copies.values()) dispose(); copies.clear(); };
    try {
      for (const definition of owned.values()) update(definition, true);
      observers.add(update);
      return stop;
    } catch (error) { stop(); throw error; }
  });
  const withdraw = (definition: ToolDefinition) => {
    if (owned.get(definition.name) !== definition) return;
    owned.delete(definition.name);
    for (const update of observers) update(definition, false);
  };
  const mount = async (ctx: Context) => {
    if (!startup.modules.deepwork.enabled) return;
    if (current) throw new Error("DSMM LSP already has an active entry");
    const settings = startup.lsp;
    const tools = ctx.get("tools");
    diagnostic = "native-tools-unavailable";
    const status = (): DsmmLspRuntimeState => {
      const names = [...owned].filter(([name, definition]) => tools?.get(name) === definition).map(([name]) => name);
      return names.length ? { state: "ready", tools: names } : { state: "unavailable", diagnostic, tools: [] };
    };
    ctx.effect(() => { current = status; return () => {
      if (current !== status) return;
      current = undefined;
      for (const definition of owned.values()) withdraw(definition);
    }; });
    const unavailable = (reason: typeof diagnostic) => {
      diagnostic = reason;
      if (settings.failOnStartupError) throw new Error(`DSMM LSP startup unavailable: ${reason}`);
    };
    const anchor = (ctx.get("profileContext") as { installAnchor?: string } | undefined)?.installAnchor;
    if (anchor === undefined) return unavailable("host-anchor-unavailable");
    let plugin;
    try {
      const modulePath = createRequire(anchor).resolve("@deepseek-ai/dsh-mcp-client");
      plugin = await import(pathToFileURL(modulePath).href);
    } catch { return unavailable("native-package-unavailable"); }
    if (typeof plugin.apply !== "function") return unavailable("native-package-unavailable");
    if (!tools) return unavailable("native-tools-unavailable");
    tools.guard(exec => exec.agent !== undefined && owned.has(exec.name) && owned.get(exec.name) === tools.get(exec.name, exec.agent)
      && !getSettings(exec.agent as unknown as DshAgent).modules.deepwork.enabled ? "Deepwork LSP is not admitted in this Agent" : undefined);
    // Observe only this client's registrations, including reconnects. The Host
    // registry still performs registration and its disposer owns withdrawal.
    const client = { ...plugin, async apply(scope: Context, config: unknown) {
      const registry = scope.tools;
      const register = (definition: ToolDefinition) => {
        const dispose = registry.register(definition);
        owned.set(definition.name, definition);
        const release = () => { withdraw(definition); dispose(); };
        try { for (const update of observers) update(definition, true); }
        catch (error) { release(); throw error; }
        return release;
      };
      await plugin.apply(scope.extend({ tools: new Proxy(registry, {
        get: (target, key) => key === "register" ? register : Reflect.get(target, key),
      }) }), config);
    } };
    try { await ctx.plugin(client, toDshMcpClientConfig(settings)).await(); }
    catch { return unavailable("native-tools-unavailable"); }
    if (status().state !== "ready") unavailable("native-tools-unavailable");
  };
  if (row) core.provide("dsmmLspEntry", mount);
  else if (startup.lsp.enabled) await mount(core);
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
