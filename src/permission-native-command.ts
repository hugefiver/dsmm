import { isAbsolute, normalize, parse, resolve } from "node:path";
import { parseNativeCommandPattern, parseNativeCommands, parseSimpleCommandPattern } from "./permission-settings.js";
import type { NativeCommandEntry, NativeCommandsSettings } from "./permission-settings.js";
import type { PermissionShellIdentity } from "./permission-shell.js";
import { PermissionRefusal } from "./permission-errors.js";

/** Host-only validation: Windows drive-relative roots never authorize an enhancement. */
export function parseHostNativeCommands(input: unknown = {}): NativeCommandsSettings {
  const settings = parseNativeCommands(input);
  return Object.freeze({ enabled: settings.enabled, entries: Object.freeze(settings.entries.map(entry => {
    if (typeof entry === "string") return entry;
    const cwd = entry.match.workingDirectory;
    if (!isAbsolute(cwd) || process.platform === "win32" && parse(normalize(cwd)).root.length === 1) throw new PermissionRefusal("validation");
    return Object.freeze({ ...entry, match: Object.freeze({ ...entry.match, workingDirectory: normalize(cwd) }) });
  })) });
}

/** Finite literal grammar: ASCII blanks, bare literal tokens, and static quotes.
 * POSIX quote fragments concatenate; PowerShell quotes must enclose a whole operand.
 * Unsupported syntax retains the ordinary native path. */
export function literalCommand(command: string, dialect: PermissionShellIdentity["dialect"], mode: "legacy" | "simple" = "legacy"): readonly string[] | undefined {
  if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2018-\u201f]/u.test(command) || command.includes("--%")) return undefined;
  const words: string[] = [];
  let word = "", quote = "", started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote !== "") {
      if (char === quote) {
        if (dialect === "powershell" && quote === "'" && command[index + 1] === "'") { word += "'"; index++; }
        else {
          // Adjacent PowerShell double quotes encode an embedded quote, not concatenation.
          if (dialect === "powershell" && index + 1 < command.length && command[index + 1] !== " " && command[index + 1] !== "\t") return undefined;
          quote = "";
        }
      } else if ((dialect === "powershell" && char === '"' && mode === "legacy") || (quote === '"' && (char === "$" || char === "`"))) return undefined;
      else if (char === "\\" && dialect === "posix" && quote === '"' && /[\\$`"]/u.test(command[index + 1] ?? "")) return undefined;
      else word += char;
    } else if (char === "'" || char === '"') {
      // A quoted PowerShell command name is an expression without a call operator.
      if (dialect === "powershell" && (started || words.length === 0)) return undefined;
      quote = char; started = true;
    } else if (char === " " || char === "\t") { if (started) { words.push(word); word = ""; started = false; } }
    else if (!/[\p{L}\p{M}\p{N}_./:=+%\-]/u.test(char) && !(char === "\\" && dialect === "powershell")) return undefined;
    else { word += char; started = true; }
  }
  if (quote !== "") return undefined;
  if (started) words.push(word);
  if (!words.length || words[0] === "" || words[0].includes("=") || dialect === "powershell" && /^(?:[\d+\-]|\.\d)/u.test(words[0])
    || (mode === "legacy"
      ? /^(?:\.|eval|exec|invoke-expression|iex|cmd(?:\.exe)?|pwsh(?:\.exe)?|powershell(?:\.exe)?|bash|sh|zsh|env|sudo|node(?:\.exe)?|python[\d.]*(?:\.exe)?|command|builtin|time|if|then|elif|elseif|else|fi|for|foreach|while|until|do|done|case|esac|in|function|select|coproc|return|throw|exit|break|continue|trap|switch|try|catch|finally|class|enum|using|param|dynamicparam|filter|data|begin|process|end|configuration|workflow|parallel|sequence|default|define|from|var)$/iu
      : /^(?:\.|time|if|then|elif|elseif|else|fi|for|foreach|while|until|do|done|case|esac|in|function|select|coproc|return|throw|exit|break|continue|trap|switch|try|catch|finally|class|enum|using|param|dynamicparam|filter|data|begin|process|end|configuration|workflow|parallel|sequence|default|define|from|var)$/iu).test(mode === "legacy" ? words[0].replace(/^.*[\\/]/u, "") : words[0])) return undefined;
  return Object.freeze(words);
}
export function nativeCommandMatch(settings: NativeCommandsSettings, tool: "bash" | "pwsh", identity: PermissionShellIdentity, args: unknown, workspace: string): NativeCommandEntry | "ambiguous" | undefined {
  if (!settings.enabled || args === null || typeof args !== "object") return undefined;
  const command = Reflect.get(args, identity.commandField), modelCwd = identity.cwdField === undefined ? undefined : Reflect.get(args, identity.cwdField);
  if (typeof command !== "string" || !isAbsolute(workspace) || modelCwd !== undefined && typeof modelCwd !== "string") return undefined;
  const cwd = normalize(modelCwd === undefined ? workspace : resolve(workspace, modelCwd));
  const words = literalCommand(command, identity.dialect);
  if (words === undefined) return undefined;
  const matches = parseHostNativeCommands(settings).entries.filter((entry): entry is NativeCommandEntry => {
    if (typeof entry === "string") return false;
    const match = entry.match;
    if (match.tool !== tool || normalize(match.workingDirectory) !== cwd) return false;
    const pattern = parseNativeCommandPattern(match.commandPattern);
    return pattern.executable === words[0] && pattern.subcommands.includes(words[1]);
  });
  if (new Set(matches.map(entry => entry.sandboxMode)).size > 1) return "ambiguous";
  return matches.find(entry => entry.mode === "ask") ?? matches[0];
}

export function simpleShellDialect(name: string): PermissionShellIdentity["dialect"] | undefined {
  const lower = name.toLowerCase();
  return ["bash", "sh", "zsh"].includes(lower) ? "posix" : ["pwsh", "powershell"].includes(lower) ? "powershell" : undefined;
}
export function simpleShellCommand(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  for (const field of ["command", "cmd", "script"]) {
    const value: unknown = Reflect.get(args, field);
    if (typeof value === "string") return value;
  }
  return undefined;
}
/** A simple hit carries no legacy entry, cwd grant, read trust or sandbox target. */
export function simpleCommandMatch(settings: NativeCommandsSettings, command: string, dialect: PermissionShellIdentity["dialect"]): boolean {
  if (!settings.enabled) return false;
  const words = literalCommand(command, dialect, "simple");
  if (words === undefined) return false;
  const executable = (value: string): string => dialect === "powershell" ? value.replace(/\.exe$/iu, "") : value;
  return settings.entries.some(entry => typeof entry === "string" && parseSimpleCommandPattern(entry).every((alternatives, index) =>
    words[index] !== undefined && alternatives.some(value => index === 0 ? executable(value) === executable(words[0]) : value === words[index])));
}
