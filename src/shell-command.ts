export type ShellDialect = "posix" | "powershell";

export type ShellToken =
  | { kind: "word"; value: string; quoted: boolean }
  | { kind: "operator"; value: string };

export interface ParsedShellSegment {
  tokens: readonly ShellToken[];
  words: readonly string[];
}

type QuoteState = "unquoted" | "single-quoted" | "double-quoted";

const GIT_WRITE_COMMANDS = new Set([
  "add",
  "am",
  "apply",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "fetch",
  "init",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "remote",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "submodule",
  "switch",
  "tag",
  "worktree"
]);

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree"
]);

const CONFIG_WRITE_OPTIONS = new Set([
  "--add",
  "--replace-all",
  "--unset",
  "--unset-all",
  "--rename-section",
  "--remove-section",
  "--edit"
]);

const CONFIG_QUERY_OPTIONS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
  "-l",
  "--show-origin",
  "--show-scope",
  "--name-only"
]);

const CONFIG_OPTIONS_WITH_VALUE = new Set(["--file", "-f", "--blob", "--type", "--default", "--comment"]);
const ENV_OPTIONS_WITH_VALUE = new Set(["-u", "--unset", "-C", "--chdir", "-a", "--argv0", "-f", "--file", "-S", "--split-string"]);
const ENV_SHORT_OPTIONS_WITH_ATTACHED_VALUE = new Set(["-C", "-u", "-a", "-f", "-S"]);
const ENV_LONG_OPTIONS_WITH_ATTACHED_VALUE = new Set(["--unset", "--chdir", "--argv0", "--file", "--split-string", "--default-signal", "--ignore-signal", "--block-signal"]);
const ENV_OPTIONS_WITHOUT_VALUE = new Set(["-i", "--ignore-environment", "-v", "--debug", "--default-signal", "--ignore-signal", "--block-signal", "--list-signal-handling"]);
const ENV_SHORT_FLAGS_WITHOUT_VALUE = new Set(["i", "v"]);

function lower(value: string): string {
  return value.toLowerCase();
}

function matching(value: string, expected: string, dialect: ShellDialect): boolean {
  return dialect === "powershell" ? lower(value) === lower(expected) : value === expected;
}

function executableBasename(value: string): string {
  return value.replace(/^.*[\\/]/u, "");
}

function isNamedExecutable(value: string, expected: string, dialect: ShellDialect): boolean {
  const basename = executableBasename(value);
  return matching(basename, expected, dialect) || matching(basename, `${expected}.exe`, dialect);
}

function isPosixAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

function isEnvAssignment(value: string, afterOptions: boolean): boolean {
  return value.includes("=") && (afterOptions || !value.startsWith("-"));
}

function isEnvShortOptionWithAttachedValue(value: string): boolean {
  return [...ENV_SHORT_OPTIONS_WITH_ATTACHED_VALUE].some((option) => value.startsWith(option) && value.length > option.length);
}

function envShortCluster(words: readonly string[], index: number): { nextIndex: number; splitString?: string } | undefined {
  const option = words[index] ?? "";
  if (!option.startsWith("-") || option.startsWith("--")) return undefined;

  let character = 1;
  while (ENV_SHORT_FLAGS_WITHOUT_VALUE.has(option[character] ?? "")) character += 1;
  if (character === 1) return undefined;
  if (character === option.length) return { nextIndex: index + 1 };

  const valueOption = `-${option[character] ?? ""}`;
  if (!ENV_SHORT_OPTIONS_WITH_ATTACHED_VALUE.has(valueOption)) return undefined;
  if (character + 1 < option.length) return { nextIndex: index + 1, splitString: valueOption === "-S" ? option.slice(character + 1) : undefined };
  const value = words[index + 1];
  if (value === undefined) return undefined;
  return { nextIndex: index + 2, splitString: valueOption === "-S" ? value : undefined };
}

function isPowerShellAssignmentStatement(words: readonly string[]): boolean {
  return words.length >= 3 && /^\$[A-Za-z_][A-Za-z0-9_:]*$/u.test(words[0] ?? "") && words[1] === "=";
}

function unquotedWord(tokens: readonly ShellToken[]): ShellToken | undefined {
  return tokens.find((token): token is Extract<ShellToken, { kind: "word" }> => token.kind === "word" && !token.quoted);
}

function isRedirectionOperator(value: string): boolean {
  return value.includes(">");
}

export function parseShellCommand(input: string, dialect: ShellDialect): readonly ParsedShellSegment[] {
  const segments: ParsedShellSegment[] = [];
  let tokens: ShellToken[] = [];
  let words: string[] = [];
  let word = "";
  let quoted = false;
  let wordStarted = false;
  let state: QuoteState = "unquoted";
  const escape = dialect === "posix" ? "\\" : "`";

  const finishWord = (): void => {
    if (!wordStarted) return;
    tokens.push({ kind: "word", value: word, quoted });
    words.push(word);
    word = "";
    quoted = false;
    wordStarted = false;
  };

  const appendWord = (value: string): void => {
    word += value;
    wordStarted = true;
  };

  const appendOperator = (value: string): void => {
    finishWord();
    tokens.push({ kind: "operator", value });
  };

  const finishSegment = (): void => {
    finishWord();
    if (tokens.length === 0) return;
    segments.push({ tokens, words });
    tokens = [];
    words = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";

    if (char === escape && state !== "single-quoted") {
      const next = input[index + 1];
      if (next === "\r" && input[index + 2] === "\n") {
        index += 2;
        continue;
      }
      if (next === "\n") {
        index += 1;
        continue;
      }
      if (next !== undefined) {
        appendWord(next);
        index += 1;
        continue;
      }
      appendWord(char);
      continue;
    }

    if (state === "single-quoted") {
      if (char === "'") state = "unquoted";
      else appendWord(char);
      continue;
    }

    if (state === "double-quoted") {
      if (char === '"') state = "unquoted";
      else appendWord(char);
      continue;
    }

    if (char === "'") {
      state = "single-quoted";
      quoted = true;
      wordStarted = true;
      continue;
    }
    if (char === '"') {
      state = "double-quoted";
      quoted = true;
      wordStarted = true;
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      finishSegment();
      continue;
    }
    if (char === ";") {
      finishSegment();
      continue;
    }
    if (char === "&" && input[index + 1] === ">") {
      let operator = "&>";
      index += 1;
      if (input[index + 1] === ">") {
        operator = "&>>";
        index += 1;
      }
      appendOperator(operator);
      continue;
    }
    if (char === "&") {
      if (input[index + 1] === "&") {
        index += 1;
        finishSegment();
        continue;
      }
      if (dialect === "powershell" && tokens.length === 0 && !wordStarted) appendOperator(char);
      else finishSegment();
      continue;
    }
    if (char === "|") {
      if (input[index + 1] === "|") index += 1;
      finishSegment();
      continue;
    }
    if (char === ">" || char === "<") {
      let operator = char;
      if (input[index + 1] === char) {
        operator += char;
        index += 1;
      }
      if (input[index + 1] === "&") {
        operator += "&";
        index += 1;
      }
      appendOperator(operator);
      continue;
    }
    if (/\s/u.test(char)) {
      finishWord();
      continue;
    }
    appendWord(char);
  }

  finishSegment();
  return segments;
}

function commandStart(words: readonly string[], dialect: ShellDialect): number | undefined {
  if (dialect === "powershell" && isPowerShellAssignmentStatement(words)) return undefined;

  let index = 0;
  while (dialect === "posix" && isPosixAssignment(words[index] ?? "")) index += 1;
  return index < words.length ? index : undefined;
}

function envCommandWords(words: readonly string[], start: number, consumeBare: boolean): readonly string[] | undefined {
  let index = start;
  if (consumeBare && words[index] === "-") index += 1;
  while (isEnvAssignment(words[index] ?? "", true)) index += 1;
  return index < words.length ? words.slice(index) : undefined;
}

function splitEnvCommand(value: string, trailing: readonly string[]): readonly string[] | undefined {
  const segments = parseShellCommand(value, "posix");
  if (segments.length !== 1) return undefined;

  const segment = segments[0];
  if (segment === undefined || segment.tokens.some((token) => token.kind !== "word") || segment.words.length === 0) return undefined;
  return [...segment.words, ...trailing];
}

function skipEnv(words: readonly string[], start: number): readonly string[] | undefined {
  let index = start + 1;
  while (index < words.length) {
    const option = words[index] ?? "";
    if (option === "--") return envCommandWords(words, index + 1, true);
    if (option === "-") return envCommandWords(words, index + 1, false);
    if (ENV_OPTIONS_WITHOUT_VALUE.has(option)) {
      index += 1;
      continue;
    }
    if (option === "-S" || option === "--split-string") {
      const value = words[index + 1];
      return value === undefined ? undefined : splitEnvCommand(value, words.slice(index + 2));
    }
    if (option.startsWith("--split-string=")) return splitEnvCommand(option.slice("--split-string=".length), words.slice(index + 1));
    if (ENV_OPTIONS_WITH_VALUE.has(option)) {
      if (index + 1 >= words.length) return undefined;
      index += 2;
      continue;
    }
    const cluster = envShortCluster(words, index);
    if (cluster !== undefined) {
      if (cluster.splitString !== undefined) return splitEnvCommand(cluster.splitString, words.slice(cluster.nextIndex));
      index = cluster.nextIndex;
      continue;
    }
    if (option.startsWith("-S") && option.length > 2) return splitEnvCommand(option.slice(2), words.slice(index + 1));
    if (isEnvShortOptionWithAttachedValue(option)) {
      index += 1;
      continue;
    }
    if ([...ENV_LONG_OPTIONS_WITH_ATTACHED_VALUE].some((name) => option.startsWith(`${name}=`))) {
      index += 1;
      continue;
    }
    if (isEnvAssignment(option, false)) {
      index += 1;
      continue;
    }
    return words.slice(index);
  }
  return undefined;
}

function gitSubcommand(words: readonly string[], start: number): { name: string; args: readonly string[] } | undefined {
  let index = start + 1;
  while (index < words.length) {
    const option = words[index] ?? "";
    if (option === "--") {
      index += 1;
      continue;
    }
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
      if (index + 1 >= words.length) return undefined;
      index += 2;
      continue;
    }
    if (/^-[Cc].+/u.test(option) || [...GIT_GLOBAL_OPTIONS_WITH_VALUE].some((name) => option.startsWith(`${name}=`))) {
      index += 1;
      continue;
    }
    if (option.startsWith("-")) {
      index += 1;
      continue;
    }
    return { name: lower(option), args: words.slice(index + 1) };
  }
  return undefined;
}

function configWrites(args: readonly string[]): boolean {
  const options = args.map(lower);
  if (options.some((option) => CONFIG_WRITE_OPTIONS.has(option) || [...CONFIG_WRITE_OPTIONS].some((name) => option.startsWith(`${name}=`)))) return true;
  if (options.some((option) => CONFIG_QUERY_OPTIONS.has(option))) return false;

  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const option = lower(argument);
    if (argument === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (CONFIG_OPTIONS_WITH_VALUE.has(option)) {
      index += 1;
      continue;
    }
    if ([...CONFIG_OPTIONS_WITH_VALUE].some((name) => option.startsWith(`${name}=`))) continue;
    if (argument.startsWith("-")) continue;
    positional.push(argument);
  }
  return positional.length >= 2;
}

function firstAction(args: readonly string[], optionsWithValue: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--") return args[index + 1];
    if (optionsWithValue.includes(lower(argument))) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return argument;
  }
  return undefined;
}

function replaceWrites(args: readonly string[]): boolean {
  const options = args.map(lower);
  if (options.some((option) => option === "-d" || option === "--delete" || option === "-e" || option === "--edit" || option === "-g" || option === "--graft")) return true;
  if (options.some((option) => option === "-l" || option === "--list")) return false;
  return args.filter((argument) => !argument.startsWith("-")).length >= 2;
}

function symbolicRefWrites(args: readonly string[]): boolean {
  const options = args.map(lower);
  if (options.some((option) => option === "-d" || option === "--delete")) return true;
  return args.filter((argument) => !argument.startsWith("-")).length >= 2;
}

export function classifyKnownGitWrite(input: string, dialect: ShellDialect): string | undefined {
  for (const segment of parseShellCommand(input, dialect)) {
    const start = commandStart(segment.words, dialect);
    if (start === undefined) continue;

    let commandWords: readonly string[] = segment.words.slice(start);
    let executable = commandWords[0] ?? "";
    while (isNamedExecutable(executable, "env", dialect)) {
      const unwrapped = skipEnv(commandWords, 0);
      if (unwrapped === undefined) {
        executable = "";
        break;
      }
      commandWords = unwrapped;
      executable = commandWords[0] ?? "";
    }
    if (!isNamedExecutable(executable, "git", dialect)) continue;

    const subcommand = gitSubcommand(commandWords, 0);
    if (subcommand === undefined) continue;

    if (subcommand.name === "config") {
      if (configWrites(subcommand.args)) return "config";
      continue;
    }
    if (subcommand.name === "notes") {
      const action = lower(firstAction(subcommand.args, ["--ref", "-r"]) ?? "");
      if (["add", "append", "copy", "edit", "merge", "prune", "remove"].includes(action)) return `notes ${action}`;
      continue;
    }
    if (subcommand.name === "replace") {
      if (replaceWrites(subcommand.args)) return "replace";
      continue;
    }
    if (subcommand.name === "update-ref") return "update-ref";
    if (subcommand.name === "symbolic-ref") {
      if (symbolicRefWrites(subcommand.args)) return "symbolic-ref";
      continue;
    }
    if (subcommand.name === "reset" && subcommand.args.some((argument) => lower(argument) === "--hard")) return "reset --hard";
    if (subcommand.name === "stash") {
      const action = lower(subcommand.args[0] ?? "");
      if (action === "pop" || action === "drop" || action === "clear") return `stash ${action}`;
    }
    if (GIT_WRITE_COMMANDS.has(subcommand.name)) return subcommand.name;
  }

  return undefined;
}

export type ShellDialectViolation = "powershell-export" | "powershell-source" | "powershell-dev-null" | "posix-powershell-env";

export function classifyShellDialectViolation(input: string, dialect: ShellDialect): ShellDialectViolation | undefined {
  for (const segment of parseShellCommand(input, dialect)) {
    const command = unquotedWord(segment.tokens);
    if (dialect === "powershell" && command !== undefined) {
      const name = lower(command.value);
      if (name === "export") return "powershell-export";
      if (name === "source") return "powershell-source";
    }
    if (dialect === "powershell") {
      for (let index = 0; index < segment.tokens.length - 1; index += 1) {
        const token = segment.tokens[index];
        const operand = segment.tokens[index + 1];
        if (token?.kind === "operator" && isRedirectionOperator(token.value) && operand?.kind === "word" && !operand.quoted && operand.value === "/dev/null") {
          return "powershell-dev-null";
        }
      }
    }
    if (dialect === "posix" && command !== undefined && /^\$env:/iu.test(command.value)) return "posix-powershell-env";
  }

  return undefined;
}
