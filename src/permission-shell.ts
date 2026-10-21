import { classifyKnownGitWrite, parseShellCommand } from "./shell-command.js";
import type { ShellDialect } from "./shell-command.js";
import { isAbsolute, resolve } from "node:path";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";

export type PermissionReadExecutable = "git" | "echo" | "printf" | "pwd" | "ls" | "cat" | "head" | "tail" | "wc" | "rg" | "grep"
  | "write-output" | "get-location" | "get-childitem" | "get-content";
/** Host-only native resolution proof for the actual execution realm and environment. */
export interface PermissionShellReadCapability {
  readonly signal: AbortSignal;
  /** Return a canonical implementation only after verifying actual executable/cmdlet identity and resolution in this cwd/Agent realm.
   * The effective environment/configuration must exclude external preprocessors, pagers, hooks, fsmonitor, textconv and other dynamic handlers for these reads. */
  resolveExecutable(token: string, workingDirectory: string, execution?: Readonly<ToolExecution>): PermissionReadExecutable | undefined;
  /** Pure check of the same native executable/environment generation; not another SDK/third-party guard. */
  assertCurrent(execution: Readonly<ToolExecution>): void;
}

/** Supplied by the trusted registration adapter, not inferred from a display name. */
export interface PermissionShellIdentity {
  readonly executable: string;
  readonly dialect: ShellDialect;
  readonly commandField: string;
  readonly cwdField?: string;
  readonly readCapability?: PermissionShellReadCapability;
}
export type PermissionEffect = "read" | "local-write" | "external-write" | "destructive" | "unknown";
export interface PermissionOperation {
  readonly effect: PermissionEffect;
  readonly operations: readonly string[];
  readonly rememberable: boolean;
  readonly executable: string;
  readonly command: string;
  readonly workingDirectory: string;
}
const reads = new Set(["echo", "printf", "pwd", "ls", "cat", "head", "tail", "wc", "rg", "grep", "write-output", "get-location", "get-childitem", "get-content"]);
const localWrites = new Set(["mkdir", "touch", "cp", "mv", "tee", "new-item", "set-content", "add-content", "copy-item", "move-item"]);
const destroys = new Set(["rm", "rmdir", "del", "erase", "remove-item", "format-volume"]);
const rank: Record<PermissionEffect, number> = { read: 0, "local-write": 1, "external-write": 2, destructive: 3, unknown: 4 };
const base = (name: string) => name.replace(/^.*[\\/]/u, "").replace(/\.exe$/iu, "").toLowerCase();
const readFlags: Record<Exclude<PermissionReadExecutable, "git">, readonly string[]> = {
  echo: ["-n", "-e", "-E"], printf: [], pwd: ["-L", "-P"], ls: ["-l", "-a", "-A", "-h", "-1", "--color=never"],
  cat: ["-n", "-b", "-s", "-v", "-e", "-t"], head: [], tail: [], wc: ["-l", "-w", "-c", "-m", "-L"],
  rg: ["-n", "--line-number", "-i", "--ignore-case", "-F", "--fixed-strings", "-l", "--files-with-matches", "--files", "--no-config", "--hidden", "--no-ignore", "--color=never"],
  grep: ["-n", "--line-number", "-i", "--ignore-case", "-F", "--fixed-strings", "-E", "--extended-regexp", "-r", "-R", "-l", "-c", "-v"],
  "write-output": ["-noenumerate"], "get-location": [], "get-childitem": ["-recurse", "-force", "-name", "-file", "-directory"], "get-content": ["-raw"],
};
const gitReadFlags: Record<string, readonly string[]> = {
  status: ["-s", "--short", "-b", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2"],
  diff: ["--no-ext-diff", "--no-textconv", "--stat", "--name-only", "--name-status", "--cached", "--staged", "--quiet", "--exit-code"],
  log: ["--oneline", "--no-decorate", "--no-color", "--no-ext-diff", "--no-textconv"],
  show: ["--stat", "--name-only", "--name-status", "--no-color", "--no-ext-diff", "--no-textconv"],
  "ls-files": ["--cached", "--stage", "--others", "--exclude-standard"], "rev-parse": ["--show-toplevel", "--git-dir", "--is-inside-work-tree", "--verify"],
  "rev-list": ["--count", "--all"], describe: ["--tags", "--always", "--abbrev=0"], version: [],
};
function knownReadArguments(command: PermissionReadExecutable, args: readonly string[]): boolean {
  let flags: readonly string[], operands = args;
  if (command === "git") {
    if (operands[0] === "--no-pager") operands = operands.slice(1);
    const subcommand = operands[0];
    if (subcommand === undefined || !Object.hasOwn(gitReadFlags, subcommand)) return false;
    flags = gitReadFlags[subcommand]; operands = operands.slice(1);
  } else flags = readFlags[command];
  const cmdlet = command.startsWith("get-") || command === "write-output";
  for (let index = 0; index < operands.length; index++) {
    const argument = operands[index], option = cmdlet ? argument.toLowerCase() : argument;
    if (!cmdlet && option === "--") return true;
    if (!argument.startsWith("-")) continue;
    if (flags.includes(option)) continue;
    if (cmdlet && ["get-content", "get-childitem"].includes(command) && ["-path", "-literalpath"].includes(option) && operands[index + 1] !== undefined) { index++; continue; }
    return false;
  }
  return true;
}

/** Classification supports exact-operation authorization, not filesystem or network isolation. */
export function classifyPermissionShell(identity: PermissionShellIdentity, args: unknown, cwd: string, execution?: Readonly<ToolExecution>): PermissionOperation {
  const row = typeof args === "object" && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const command = typeof row[identity.commandField] === "string" ? row[identity.commandField] as string : "";
  const explicitCwd = identity.cwdField !== undefined && typeof row[identity.cwdField] === "string" ? row[identity.cwdField] as string : undefined;
  const workingDirectory = explicitCwd === undefined ? cwd : cwd !== "" && !isAbsolute(explicitCwd) ? resolve(cwd, explicitCwd) : explicitCwd;
  let effect: PermissionEffect = "read";
  const operations: string[] = [];
  // Dynamic evaluation, interpolation, script blocks, wrappers and malformed quotes
  // remain exact-once asks. No command family wildcard is created from them.
  // PowerShell smart quotes are lexical delimiters unsupported by the ASCII tokenizer.
  const unsupportedQuotes = identity.dialect === "powershell" && /[\u2018-\u201f]/u.test(command);
  const dynamic = unsupportedQuotes || command === "" || /[$`{}()]/u.test(command) || /\b(?:eval|exec|invoke-expression|iex|cmd|pwsh|powershell|bash|sh|zsh|env|sudo|node|python)\b/iu.test(command)
    || (command.match(/'/gu)?.length ?? 0) % 2 !== 0 || (command.match(/"/gu)?.length ?? 0) % 2 !== 0;
  for (const segment of parseShellCommand(command, identity.dialect)) {
    const token = segment.words[0] ?? "";
    const trusted = identity.readCapability?.signal.aborted === false ? identity.readCapability.resolveExecutable(token, workingDirectory, execution) : undefined;
    const name = trusted ?? base(token);
    let next: PermissionEffect = "unknown", operation = name;
    if (name === "git") {
      const write = classifyKnownGitWrite(segment.words.map(word => JSON.stringify(word)).join(" "), identity.dialect);
      const sub = segment.words[1]?.toLowerCase();
      operation = `git:${write ?? sub ?? "unknown"}`;
      if (write !== undefined) {
        next = write === "push" ? "external-write" : ["clean", "reset --hard", "rm", "stash drop", "stash clear"].includes(write) ? "destructive" : "local-write";
      } else if (trusted === "git" && knownReadArguments("git", segment.words.slice(1))) next = "read";
      if (segment.words.slice(1).some(word => /^-(?:c|C)(?:.+)?$/u.test(word) || /^--(?:config-env|exec-path|git-dir|work-tree)(?:=|$)/u.test(word))) next = "unknown";
    } else if (reads.has(name) && trusted !== undefined && knownReadArguments(trusted, segment.words.slice(1))) next = "read";
    else if (localWrites.has(name)) next = "local-write";
    else if (destroys.has(name)) next = "destructive";
    if (/[\\/]/u.test(token) && trusted === undefined) next = "unknown";
    if (segment.tokens.some(token => token.kind === "operator" && token.value.includes(">")) && rank[next] < rank["local-write"]) next = "local-write";
    if (rank[next] > rank[effect]) effect = next;
    operations.push(operation);
  }
  if (dynamic || operations.length === 0) effect = "unknown";
  return Object.freeze({ effect, operations: Object.freeze(operations), rememberable: effect !== "unknown" && workingDirectory !== "", executable: identity.executable, command, workingDirectory });
}

export interface PermissionShellReadPaths { readonly workingDirectory: string; readonly paths: readonly string[] }
/** Typed DSMM extraction, not an SDK operand field. Undefined means exact native ask, not inside. */
export function parsePermissionShellReadPaths(identity: PermissionShellIdentity, args: unknown, cwd: string, execution?: Readonly<ToolExecution>): PermissionShellReadPaths | undefined {
  const operation = classifyPermissionShell(identity, args, cwd, execution);
  if (operation.effect !== "read" || operation.workingDirectory === "" || identity.readCapability === undefined) return undefined;
  if (/[|<>]/u.test(operation.command)) return undefined;
  const paths: string[] = [];
  for (const segment of parseShellCommand(operation.command, identity.dialect)) {
    // Redirects, pipelines, wildcard expansion and Git object/pathspec semantics require an exact question.
    if (segment.tokens.some(token => token.kind === "operator" && ![";", "&&"].includes(token.value))) return undefined;
    const command = identity.readCapability.resolveExecutable(segment.words[0], operation.workingDirectory, execution);
    if (command === undefined || command === "git") return undefined;
    if (["echo", "printf", "pwd", "write-output", "get-location"].includes(command)) continue;
    const operands: string[] = [];
    let options = true;
    for (const word of segment.words.slice(1)) {
      if (word === "--" && options) { options = false; continue; }
      if (options && word.startsWith("-")) continue;
      operands.push(word);
    }
    if (command === "rg" || command === "grep") {
      if (!(command === "rg" && segment.words.includes("--files"))) {
        if (operands.length === 0) return undefined;
        operands.shift();
      }
      if (operands.length === 0) operands.push(".");
    } else if (["ls", "get-childitem"].includes(command) && operands.length === 0) operands.push(".");
    // Missing file operands use stdin, which may be supplied by unparsed shell syntax.
    else if (operands.length === 0) return undefined;
    if (operands.some(path => path === "-" || /[*?\[\]]/u.test(path) || /^~(?:[\\/]|$)/u.test(path))) return undefined;
    paths.push(...operands);
  }
  return Object.freeze({ workingDirectory: operation.workingDirectory, paths: Object.freeze(paths) });
}
