import { literalCommand } from "./permission-native-command.js";
import type { PermissionShellIdentity } from "./permission-shell.js";

export interface LinearScriptComponent {
  readonly start: number;
  readonly end: number;
  readonly command: string;
  readonly words: readonly string[];
}

/** Complete finite recognition, not a shell AST. Original ranges are never rewritten for execution. */
export function parseLinearScript(command: string, dialect: PermissionShellIdentity["dialect"]): readonly LinearScriptComponent[] | undefined {
  const components: LinearScriptComponent[] = [];
  let start = 0, chunk = 0, quote = "", structured = false;
  let pending: "chain" | "separator" | undefined;
  let pieces: string[] = [];
  const finish = (end: number): boolean => {
    const view = pieces.join("") + command.slice(chunk, end);
    const words = literalCommand(view, dialect, "simple");
    if (words === undefined) return false;
    let left = start, right = end;
    while (command[left] === " " || command[left] === "\t") left++;
    while (right > left && (command[right - 1] === " " || command[right - 1] === "\t")) right--;
    components.push(Object.freeze({ start: left, end: right, command: command.slice(left, right), words }));
    pieces = []; return true;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote !== "") {
      if (char === quote) {
        if (dialect === "powershell" && quote === "'" && command[index + 1] === "'") index++;
        else quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === (dialect === "posix" ? "\\" : "`")) {
      const length = command[index + 1] === "\n" ? 2 : dialect === "powershell" && command.slice(index + 1, index + 3) === "\r\n" ? 3 : 0;
      if (length !== 0) {
        // Do not reinterpret token-internal PowerShell escaped newlines as POSIX concatenation.
        if (dialect === "powershell" && index !== start && command[index - 1] !== " " && command[index - 1] !== "\t") return undefined;
        pieces.push(command.slice(chunk, index)); index += length - 1; chunk = index + 1; structured = true; continue;
      }
      // Do not reinterpret CRLF as a POSIX continuation or split an escaped operator.
      return undefined;
    }
    const newline = char === "\n" || char === "\r" && command[index + 1] === "\n";
    if (!newline && char !== ";" && char !== "|" && char !== "&") continue;
    structured = true;
    const chain = char === "|" || char === "&";
    let length = newline && char === "\r" ? 2 : 1;
    if (chain && command[index + 1] === char) length = 2;
    else if (char === "&") return undefined;
    const empty = /^[ \t]*$/u.test(pieces.join("") + command.slice(chunk, index));
    if (empty) {
      if (!newline) return undefined;
    } else {
      if (!finish(index)) return undefined;
      pending = undefined;
    }
    if (chain) pending = "chain";
    else if (!newline) pending = "separator";
    index += length - 1; start = chunk = index + 1;
    pieces = [];
  }
  if (quote !== "" || !structured) return undefined;
  const empty = /^[ \t]*$/u.test(pieces.join("") + command.slice(chunk));
  if (empty) { if (pending === "chain") return undefined; }
  else if (!finish(command.length)) return undefined;
  return components.length === 0 ? undefined : Object.freeze(components);
}
