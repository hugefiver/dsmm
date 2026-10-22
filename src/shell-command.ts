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
      if (char === "'" && dialect === "powershell" && input[index + 1] === "'") {
        appendWord("'");
        index += 1;
      } else if (char === "'") state = "unquoted";
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

export interface GitStaticContext {
  /** Literal spelling, not a claim about executable identity or repository confinement. */
  readonly executable: string;
  readonly globalOptions: readonly string[];
  readonly environment: readonly string[];
}

export interface GitCommandAction {
  readonly ruleId: `git.${string}`;
  readonly action: string;
  readonly risk: "write" | "high-risk";
  /** Callers must also bind actual cwd, dialect, Agent and tool registration. */
  readonly reusable: boolean;
  readonly context: GitStaticContext;
}

interface GitInvocation {
  name: string;
  args: readonly string[];
  globalOptions: readonly string[];
  known: boolean;
}

function gitSubcommand(words: readonly string[]): GitInvocation | undefined {
  let known = true;
  for (let index = 1; index < words.length; index += 1) {
    const option = words[index] ?? "";
    if (["--help", "-h", "--version", "-v", "--html-path", "--man-path", "--info-path", "--exec-path"].includes(option)) return undefined;
    if (option === "--") { known = false; continue; }
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
      if (index + 1 >= words.length) return undefined;
      if (option === "--config-env") known = false;
      index += 1;
      continue;
    }
    if (/^-[Cc].+/u.test(option) || [...GIT_GLOBAL_OPTIONS_WITH_VALUE].some((name) => option.startsWith(`${name}=`))) {
      if (option.startsWith("--config-env=")) known = false;
      continue;
    }
    if (option.startsWith("-")) {
      if (!["-p", "--paginate", "-P", "--no-pager", "--bare", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-lazy-fetch", "--no-advice"].includes(option)) known = false;
      continue;
    }
    return { name: option, args: words.slice(index + 1), globalOptions: words.slice(1, index), known };
  }
  return undefined;
}

interface GitOptions {
  flags: Set<string>;
  values: Map<string, string[]>;
  positional: string[];
  /** Number of positional operands before the literal -- boundary. */
  boundary: number | undefined;
  known: boolean;
}

interface OptionSyntax {
  flags?: string;
  values?: string;
  optional?: string;
  /** Git's LASTARG_DEFAULT options accept a separate value, or default at end. */
  lastValue?: string;
  dryRunShort?: boolean;
  /** These option spellings share one boolean, including their negated forms. */
  flagAliases?: readonly string[];
}

/** Git options are case-sensitive; only declared value-taking options consume operands. */
function gitOptions(args: readonly string[], syntax: OptionSyntax): GitOptions {
  const flags = new Set((`${syntax.flags ?? ""} -h --help`).split(/\s+/u));
  const values = new Set((syntax.values ?? "").split(/\s+/u));
  const optional = new Set((syntax.optional ?? "").split(/\s+/u));
  const lastValue = new Set((syntax.lastValue ?? "").split(/\s+/u));
  const result: GitOptions = { flags: new Set(), values: new Map(), positional: [], boundary: undefined, known: true };
  const aliases: Record<string, string> = { "-f": "--force", "-d": "--delete", "-W": "--worktree", "-S": "--staged" };
  if (syntax.dryRunShort) aliases["-n"] = "--dry-run";
  const save = (name: string, value?: string): void => {
    const positive = name.startsWith("--no-") ? `--${name.slice(5)}` : aliases[name] ?? name;
    if (syntax.flagAliases?.includes(positive)) {
      for (const alias of syntax.flagAliases) {
        result.flags.delete(alias);
        if (alias.startsWith("--")) result.flags.delete(`--no-${alias.slice(2)}`);
      }
    }
    if (name.startsWith("--no-") && (flags.has(positive) || optional.has(positive))) {
      result.flags.delete(positive);
      for (const [short, long] of Object.entries(aliases)) if (long === positive) result.flags.delete(short);
    } else if (name.startsWith("--") || flags.has(positive)) result.flags.delete(`--no-${positive.slice(2)}`);
    result.flags.add(name);
    if (value !== undefined) result.values.set(name, [...(result.values.get(name) ?? []), value]);
  };
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? "";
    if (word === "--") {
      result.boundary = result.positional.length;
      result.positional.push(...args.slice(index + 1));
      break;
    }
    if (!word.startsWith("-") || word === "-") {
      result.positional.push(word);
      continue;
    }
    if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      const name = equals < 0 ? word : word.slice(0, equals);
      if (values.has(name) || lastValue.has(name)) {
        const value = equals < 0 ? args[++index] : word.slice(equals + 1);
        if (value === undefined && !lastValue.has(name)) result.known = false;
        save(name, value);
      } else if (optional.has(name)) save(name, equals < 0 ? undefined : word.slice(equals + 1));
      else if (equals < 0 && (flags.has(name) || name.startsWith("--no-") && (flags.has(`--${name.slice(5)}`) || optional.has(`--${name.slice(5)}`)))) save(name);
      else result.known = false;
      continue;
    }
    for (let offset = 1; offset < word.length; offset += 1) {
      const name = `-${word[offset] ?? ""}`;
      if (values.has(name) || optional.has(name)) {
        const attached = word.slice(offset + 1);
        const value = attached || (values.has(name) ? args[++index] : undefined);
        if (values.has(name) && value === undefined) result.known = false;
        save(name, value);
        break;
      }
      if (flags.has(name)) save(name);
      else {
        result.known = false;
        break;
      }
    }
  }
  return result;
}

const LIST_SYNTAX: OptionSyntax = {
  flags: "--list -l -a --all -r --remotes -v --verbose -q --quiet --ignore-case -i --no-column --no-contains --no-merged",
  values: "--format --sort --points-at",
  optional: "--column --color --abbrev",
  lastValue: "--contains --no-contains --merged --no-merged"
};
const MESSAGE_VALUES = "-m --message -F --file -C --reuse-message -c --reedit-message --author --date --cleanup --trailer --template -t --pathspec-from-file";
const COMMIT_SYNTAX: OptionSyntax = {
  flags: "-a --all -p --patch -s --signoff -n --no-verify -q --quiet -v --verbose -e --edit --no-edit --amend --reset-author --allow-empty --allow-empty-message --no-post-rewrite -i --include -o --only --dry-run --short --porcelain --long -z --null --branch --no-status --status --no-gpg-sign --pathspec-file-nul",
  values: `${MESSAGE_VALUES} --fixup --squash`, optional: "-S --gpg-sign --untracked-files -u"
};

interface ActionKind { action: string; risk: "write" | "high-risk"; known: boolean }

function gitActions(name: string, args: readonly string[]): readonly ActionKind[] {
  let parsed: GitOptions;
  const result: ActionKind[] = [];
  const emit = (action: string, high = false): void => { result.push({ action: `${name}.${action}`, risk: high ? "high-risk" : "write", known: parsed.known }); };
  const has = (...options: string[]): boolean => options.some((option) => parsed.flags.has(option));
  const unknown = (): readonly ActionKind[] => [{ action: `${name}.unknown`, risk: "write", known: false }];
  const query = (): readonly ActionKind[] => parsed.known ? [] : unknown();
  const help = (): boolean => has("-h", "--help");
  const dryRun = (): boolean => has("-n", "--dry-run");
  if (name === "branch") {
    parsed = gitOptions(args, {
      flags: `${LIST_SYNTAX.flags} -d --delete -D -m --move -M -c --copy -C -f --force --show-current --edit-description --unset-upstream --create-reflog --no-track -t`,
      values: `${LIST_SYNTAX.values} -u --set-upstream-to`, optional: `${LIST_SYNTAX.optional} --track`, lastValue: LIST_SYNTAX.lastValue
    });
    if (help()) return [];
    const force = has("-f", "--force");
    if (has("-D", "-d", "--delete")) emit(has("-D") || force ? "force-delete" : "delete", true);
    else if (has("-C", "-c", "--copy")) emit(has("-C") || force ? "force-copy" : "copy", has("-C") || force);
    else if (has("-M", "-m", "--move")) emit(has("-M") || force ? "force-rename" : "rename", has("-M") || force);
    else if (has("-u", "--set-upstream-to", "--unset-upstream")) emit(has("--unset-upstream") ? "unset-upstream" : "set-upstream");
    else if (has("--edit-description")) emit("edit-description");
    else if (force && parsed.positional.length > 0) emit("force-update", true);
    else if (has("--show-current", "--list", "-l", "-a", "--all", "-r", "--remotes", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at") || parsed.positional.length === 0) return query();
    else emit("create");
    return result;
  }
  if (name === "tag") {
    parsed = gitOptions(args, { flags: `${LIST_SYNTAX.flags} -d --delete -f --force -a --annotate -s --sign -v --verify --create-reflog --no-sign`, values: "--format --sort --points-at -m --message -F --file -u --local-user", optional: `${LIST_SYNTAX.optional} -n`, lastValue: LIST_SYNTAX.lastValue });
    if (help()) return [];
    if (has("-d", "--delete")) emit("delete", true);
    else if (has("-f", "--force") && parsed.positional.length > 0) emit("force-update", true);
    else if (has("-m", "--message", "-F", "--file", "-a", "--annotate", "-s", "--sign", "-u", "--local-user")) emit("create");
    else if (has("--list", "-l", "-v", "--verify", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "-n") || parsed.positional.length === 0) return query();
    else emit("create");
    return result;
  }
  if (name === "remote") {
    parsed = gitOptions(args, { flags: "-v --verbose -f --fetch --tags --no-tags -a --auto -d --delete --add --push --all -n --dry-run -p --prune", values: "-t --track -m --master", optional: "--mirror", dryRunShort: true });
    if (help()) return [];
    const action = parsed.positional[0];
    if (action === undefined || ["show", "get-url"].includes(action)) return query();
    if (!["add", "rename", "remove", "rm", "set-head", "set-branches", "set-url", "update", "prune"].includes(action)) return unknown();
    if (action === "prune" && dryRun()) return [];
    emit(action === "rm" ? "remove" : action);
    return result;
  }
  if (name === "stash") {
    parsed = gitOptions(args, { flags: "-p --patch -S --staged -k --keep-index --no-keep-index -u --include-untracked -a --all -q --quiet --index --pathspec-file-nul --only-untracked --stat --numstat --shortstat --name-only --name-status --summary --oneline -f --force", values: "-m --message --pathspec-from-file --format -n --max-count --skip --since --until --grep --author -U --unified", optional: "--pretty" });
    if (help()) return [];
    const first = parsed.positional[0];
    if (first === "list" || first === "show") return query();
    const action = first === undefined || parsed.boundary === 0 ? "push" : first;
    if (!["push", "save", "apply", "pop", "branch", "create", "store", "drop", "clear"].includes(action)) return unknown();
    emit(action, action === "drop" || action === "clear");
    return result;
  }
  if (name === "worktree") {
    parsed = gitOptions(args, { flags: "-f --force -d --detach --checkout --no-checkout --lock --porcelain -z -v --verbose -n --dry-run --orphan --relative-paths --no-relative-paths --guess-remote --no-guess-remote --quiet -q", values: "-b -B --reason --expire", dryRunShort: true });
    if (help()) return [];
    const action = parsed.positional[0];
    if (action === "list") return query();
    if (action === "prune" && dryRun()) return [];
    if (action === undefined || !["add", "move", "lock", "unlock", "repair", "remove", "prune"].includes(action)) return unknown();
    emit(action, action === "remove" || action === "prune");
    return result;
  }
  if (name === "submodule") {
    parsed = gitOptions(args, { flags: "-q --quiet --cached --files --recursive --force -f --init --remote -N --no-fetch --checkout --merge --rebase --recommend-shallow --no-recommend-shallow --single-branch --no-single-branch --progress --all --default", values: "-b --branch --name --reference --depth -j --jobs --filter --ref-format --super-prefix --separate-git-dir -n --summary-limit", optional: "--recurse-submodules" });
    if (help()) return [];
    const action = parsed.positional[0];
    if (action === undefined || ["status", "summary"].includes(action)) return query();
    if (!["add", "init", "deinit", "update", "sync", "set-branch", "set-url", "foreach"].includes(action)) return unknown();
    if (action === "foreach") parsed.known = false;
    emit(action);
    return result;
  }
  if (name === "commit") {
    parsed = gitOptions(args, COMMIT_SYNTAX);
    if (help() || has("--dry-run", "--short", "--porcelain", "--long")) return [];
    emit(has("--amend") ? "amend" : "create", has("--amend"));
    return result;
  }
  if (name === "push") {
    parsed = gitOptions(args, { flags: "-f --force --force-if-includes -d --delete --mirror -n --dry-run --all --branches --tags --follow-tags --prune --atomic --porcelain --quiet -q --verbose -v --progress --no-verify --set-upstream -u --no-force --no-force-with-lease --no-force-if-includes --no-signed --ipv4 -4 --ipv6 -6", values: "--repo --receive-pack --exec -o --push-option", optional: "--force-with-lease --signed --recurse-submodules", dryRunShort: true });
    if (help() || dryRun()) return [];
    const refspecs = parsed.positional.slice(has("--repo") ? 0 : 1);
    if (has("-f", "--force") || refspecs.some((ref) => ref.startsWith("+"))) emit("force", true);
    if (has("--force-with-lease")) emit("force-with-lease", true);
    if (has("--force-if-includes")) emit("force-if-includes", true);
    if (has("-d", "--delete") || refspecs.some((ref) => /^\+?:.+/u.test(ref))) emit("delete", true);
    if (has("--mirror")) emit("mirror", true);
    if (result.length === 0) emit("update");
    if (has("--receive-pack", "--exec")) return result.map((action) => ({ ...action, known: false }));
    return result;
  }
  if (name === "reset") {
    parsed = gitOptions(args, { flags: "--hard --soft --mixed --merge --keep -q --quiet -p --patch -N --intent-to-add --no-refresh --refresh --pathspec-file-nul", values: "--pathspec-from-file --inter-hunk-context --unified -U" });
    if (help()) return [];
    emit(has("--hard") ? "hard" : "update", has("--hard"));
    return result;
  }
  if (name === "clean") {
    parsed = gitOptions(args, { flags: "-f --force -d -x -X -i --interactive -n --dry-run -q --quiet", values: "-e --exclude", dryRunShort: true });
    if (help() || dryRun()) return [];
    emit("remove", true);
    return result;
  }
  if (name === "rebase") {
    parsed = gitOptions(args, { flags: "--continue --skip --abort --quit --edit-todo --show-current-patch --apply --merge -m --interactive -i --keep-empty --no-keep-empty --reapply-cherry-picks --no-reapply-cherry-picks --fork-point --no-fork-point --root --update-refs --no-update-refs --autosquash --no-autosquash --autostash --no-autostash --signoff --no-verify --verify --no-gpg-sign --force-rebase -f --no-ff --no-stat --stat -n --quiet -q --verbose -v --reschedule-failed-exec --no-reschedule-failed-exec --reset-author-date --committer-date-is-author-date --ignore-date --keep-base", values: "--onto --exec -x --strategy -s --strategy-option -X --whitespace --empty", optional: "--rebase-merges -r --gpg-sign -S" });
    if (help() || has("--show-current-patch")) return [];
    const action = ["continue", "skip", "abort", "quit", "edit-todo"].find((value) => has(`--${value}`)) ?? "start";
    emit(action, true);
    if (has("--exec", "-x")) return result.map((item) => ({ ...item, known: false }));
    return result;
  }
  if (name === "checkout" || name === "switch" || name === "restore") {
    const common = "-m --merge -q --quiet --progress --no-progress --recurse-submodules --no-recurse-submodules";
    const syntax: OptionSyntax = name === "restore"
      ? { flags: `${common} -p --patch --ignore-skip-worktree-bits --ours --theirs -2 -3 --overlay --no-overlay --pathspec-file-nul -S --staged -W --worktree --ignore-unmerged`, values: "--source -s --conflict --pathspec-from-file -U --unified --inter-hunk-context", optional: "--recurse-submodules" }
      : name === "checkout"
        ? { flags: `${common} -f --force --detach -d --guess --no-guess -t --no-track -p --patch --ignore-skip-worktree-bits --ignore-other-worktrees --overwrite-ignore --no-overwrite-ignore --ours --theirs -2 -3 --overlay --no-overlay --pathspec-file-nul -l`, values: "-b -B --conflict --pathspec-from-file --orphan", optional: "--recurse-submodules --track" }
        : { flags: `${common} -f --force --discard-changes --detach -d --guess --no-guess -t --no-track --ignore-other-worktrees --overwrite-ignore --no-overwrite-ignore`, values: "-c -C --create --force-create --conflict --orphan", optional: "--recurse-submodules --track", flagAliases: ["-f", "--force", "--discard-changes"] };
    parsed = gitOptions(args, syntax);
    if (help()) return [];
    if (name === "restore") {
      const worktree = has("-W", "--worktree") || !has("-S", "--staged");
      emit(worktree ? "worktree" : "staged", worktree);
    } else {
      const paths = parsed.boundary === undefined ? parsed.positional.length > 1 : parsed.positional.length > parsed.boundary;
      const discard = has("-f", "--force", "--discard-changes", name === "checkout" ? "-B" : "-C", "--force-create") || (name === "checkout" && (paths || has("--pathspec-from-file", "-p", "--patch", "--ours", "--theirs", "-2", "-3")));
      emit(discard ? "discard" : has("-b", "-c", "--create", "--orphan") ? "create" : "switch", discard);
      // A lone checkout operand can be a branch or a path; no repository lookup is made.
      if (name === "checkout" && !discard && !has("-b", "--orphan", "--detach", "-t", "--track")) {
        if (parsed.boundary === undefined) return unknown();
        result[0]!.known = false;
      }
    }
    return result;
  }
  if (name === "config") {
    parsed = gitOptions(args, { flags: "--add --replace-all --unset --unset-all --rename-section --remove-section --edit -e --get --get-all --get-regexp --get-urlmatch --list -l --global --system --local --worktree --null -z --name-only --show-origin --show-scope --includes --no-includes --bool --int --bool-or-int --bool-or-str --path --expiry-date --fixed-value --append --all", values: "--file -f --blob --type --default --comment --value --url" });
    if (help()) return [];
    const action = ["add", "replace-all", "unset", "unset-all", "rename-section", "remove-section", "edit"].find((value) => has(`--${value}`)) ?? (has("-e") ? "edit" : undefined);
    if (action !== undefined) emit(action);
    else if (["set", "unset", "rename-section", "remove-section", "edit"].includes(parsed.positional[0] ?? "")) emit(has("--append") ? "add" : parsed.positional[0] === "unset" && has("--all") ? "unset-all" : parsed.positional[0] ?? "set");
    else if (has("--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l") || ["get", "list"].includes(parsed.positional[0] ?? "") || parsed.positional.length < 2) return query();
    else emit("set");
    // Non-default config stores/scopes are protected, but not generalized to other targets.
    if (has("--file", "-f", "--blob", "--global", "--system", "--worktree")) return result.map((item) => ({ ...item, known: false }));
    return result;
  }
  if (name === "notes") {
    parsed = gitOptions(args, { flags: "-f --force --allow-empty --stdin -n --dry-run -v --verbose --ignore-missing --abort --commit", values: "--ref -r -m --message -F --file -c --reedit-message -C --reuse-message -s --strategy --separator", optional: "--stripspace", dryRunShort: true });
    if (help()) return [];
    const action = parsed.positional[0];
    if (action === undefined || ["list", "show", "get-ref"].includes(action)) return query();
    if (!["add", "append", "copy", "edit", "merge", "prune", "remove"].includes(action)) return unknown();
    if (action === "prune" && dryRun()) return [];
    emit(action === "merge" && has("--abort", "--commit") ? `merge-${has("--abort") ? "abort" : "commit"}` : action);
    return result;
  }
  if (name === "replace") {
    parsed = gitOptions(args, { flags: "-f --force -d --delete -e --edit -g --graft -l --list --convert-graft-file --raw", values: "--format" });
    if (help()) return [];
    if (has("-d", "--delete", "-e", "--edit", "-g", "--graft", "--convert-graft-file")) emit(has("-d", "--delete") ? "delete" : has("-e", "--edit") ? "edit" : has("--convert-graft-file") ? "convert-graft-file" : "graft", true);
    else if (has("-l", "--list") || parsed.positional.length < 2) return query();
    else emit("create", true);
    return result;
  }
  if (name === "symbolic-ref" || name === "update-ref") {
    parsed = gitOptions(args, { flags: "-d --delete -q --quiet --short --no-recurse --recurse --stdin -z --no-deref --create-reflog --batch-updates", values: "-m" });
    if (help()) return [];
    if (name === "symbolic-ref" && !has("-d", "--delete") && parsed.positional.length < 2) return query();
    emit(has("-d", "--delete") ? "delete" : has("--stdin") ? "transaction" : "write", true);
    if (has("--stdin")) result[0]!.known = false;
    return result;
  }
  if (name === "reflog") {
    parsed = gitOptions(args, { flags: "--all --single-worktree --updateref --rewrite --stale-fix -n --dry-run --verbose", values: "--expire --expire-unreachable", dryRunShort: true });
    if (help()) return [];
    const action = parsed.positional[0];
    if (action === undefined || ["show", "list", "exists"].includes(action)) return query();
    if (!["delete", "expire", "drop", "write"].includes(action)) return unknown();
    if (["delete", "expire"].includes(action) && dryRun()) return [];
    emit(action, action !== "write");
    return result;
  }
  if (name === "filter-branch") {
    parsed = gitOptions(args, { flags: "-f --force --prune-empty --remap-to-ancestor --state-branch", values: "--setup --subdirectory-filter --env-filter --tree-filter --index-filter --parent-filter --msg-filter --commit-filter --tag-name-filter --original -d --state-branch" });
    if (help()) return [];
    emit("rewrite", true);
    return result.map((action) => ({ ...action, known: false }));
  }
  if (!GIT_WRITE_COMMANDS.has(name)) return [];
  const syntax: Record<string, OptionSyntax> = {
    add: { flags: "-n --dry-run -v --verbose -f --force -i --interactive -p --patch -e --edit -u --update -A --all --no-all --ignore-removal -N --intent-to-add --refresh --ignore-errors --ignore-missing --renormalize --sparse --pathspec-file-nul", values: "--chmod --pathspec-from-file", dryRunShort: true },
    rm: { flags: "-f --force -n --dry-run -r --cached --ignore-unmatch --sparse -q --quiet --pathspec-file-nul", values: "--pathspec-from-file", dryRunShort: true },
    mv: { flags: "-f --force -n --dry-run -k -v --verbose --sparse", dryRunShort: true },
    apply: { flags: "--stat --numstat --summary --check --apply --index --cached --intent-to-add -3 --3way --reverse -R --reject --allow-overlap --inaccurate-eof --verbose -v --quiet -q --recount --allow-empty --unsafe-paths --ignore-space-change --ignore-whitespace", values: "--directory --include --exclude --whitespace -p -C --build-fake-ancestor" },
    fetch: { flags: "--all --append -a --atomic --force -f --multiple --prune -p --prune-tags -P --no-tags -n --tags -t --dry-run --quiet -q --verbose -v --update-head-ok -u --keep -k --unshallow --update-shallow --refetch --no-write-fetch-head --write-fetch-head --no-recurse-submodules --ipv4 -4 --ipv6 -6", values: "--depth --deepen --shallow-since --shallow-exclude --upload-pack --server-option -o --jobs -j --negotiation-tip", optional: "--recurse-submodules --filter" },
    merge: { flags: "--abort --continue --quit --commit --no-commit --edit -e --no-edit --ff --no-ff --ff-only --squash --no-squash --stat --no-stat -n --log --no-log --signoff --no-signoff --no-verify --verify --allow-unrelated-histories --autostash --no-autostash -q --quiet -v --verbose", values: "-m --message -F --file -s --strategy -X --strategy-option --into-name", optional: "-S --gpg-sign --log" },
    init: { flags: "-q --quiet --bare", values: "--template --separate-git-dir --object-format --ref-format -b --initial-branch", optional: "--shared" },
    clone: { flags: "--bare --mirror --local -l --no-local --no-hardlinks --shared -s --dissociate --quiet -q --verbose -v --progress --no-checkout -n --reject-shallow --no-reject-shallow --single-branch --no-single-branch --no-tags --shallow-submodules --no-shallow-submodules --remote-submodules --sparse --also-filter-submodules", values: "--template --reference --reference-if-able --origin -o --branch -b --revision --upload-pack -u --depth --shallow-since --shallow-exclude --separate-git-dir --config -c --filter --jobs -j --server-option --ref-format", optional: "--recurse-submodules --recursive" },
    pull: { flags: "--ff --no-ff --ff-only --commit --no-commit --edit -e --no-edit --squash --no-squash --all --append -a --force -f --prune -p --tags -t --no-tags -n --dry-run --quiet -q --verbose -v --unshallow --update-shallow --autostash --no-autostash --no-rebase --allow-unrelated-histories --no-verify --signoff", values: "--depth --deepen --shallow-since --shallow-exclude --upload-pack --server-option --jobs -j -s --strategy -X --strategy-option", optional: "--rebase -r --recurse-submodules -S --gpg-sign" },
    am: { flags: "--continue --skip --abort --quit --resolved -r --interactive -i --signoff -s --keep -k --keep-non-patch -b --keep-cr --no-keep-cr --3way -3 --no-3way --quiet -q --utf8 -u --no-utf8 --scissors --no-scissors --reject --ignore-space-change --ignore-whitespace --no-verify", values: "--patch-format --directory --include --exclude --whitespace -p -C --empty", optional: "--show-current-patch --gpg-sign -S" },
    "cherry-pick": { flags: "--continue --skip --abort --quit --no-commit -n --edit -e --signoff -s --ff --allow-empty --allow-empty-message --keep-redundant-commits --rerere-autoupdate --no-rerere-autoupdate -x", values: "--mainline -m --strategy --strategy-option -X --empty", optional: "--gpg-sign -S" },
    revert: { flags: "--continue --skip --abort --quit --no-commit -n --edit -e --no-edit --signoff -s --rerere-autoupdate --no-rerere-autoupdate", values: "--mainline -m --strategy --strategy-option -X", optional: "--gpg-sign -S" }
  };
  parsed = gitOptions(args, syntax[name] ?? {});
  if (help()) return [];
  if ((["add", "rm", "mv"].includes(name) && dryRun()) || (["fetch", "pull"].includes(name) && has("--dry-run")) || (name === "apply" && has("--check", "--stat", "--numstat", "--summary") && !has("--apply", "--build-fake-ancestor")) || (name === "am" && has("--show-current-patch"))) return [];
  emit(["am", "merge", "cherry-pick", "revert"].includes(name) ? ["continue", "skip", "abort", "quit"].find((value) => has(`--${value}`)) ?? "start" : "write");
  if (has("--upload-pack")) return result.map((action) => ({ ...action, known: false }));
  return result;
}

/** Pure, finite Git classification; this is not a shell AST or an authorization grant. */
export function evaluateGitCommand(input: string, dialect: ShellDialect): readonly GitCommandAction[] {
  const actions: GitCommandAction[] = [];
  const seen = new Set<string>();
  // The tokenizer deliberately does not model expansion, control flow, or shell state.
  let staticShell = !/[\$(){}*?\[\]]/u.test(input) && !(dialect === "posix" && input.includes("`")) && !(dialect === "powershell" && /@\w/u.test(input));
  // POSIX tilde expansion and quote-dependent backslashes are not represented in context.
  if (dialect === "posix" && /[~\\]/u.test(input)) staticShell = false;
  for (const segment of parseShellCommand(input, dialect)) {
    const start = commandStart(segment.words, dialect);
    if (start === undefined) { staticShell = false; continue; }
    let commandWords = segment.words.slice(start);
    const environment = [...segment.words.slice(0, start)];
    let wrapperKnown = true;
    while (isNamedExecutable(commandWords[0] ?? "", "env", dialect)) {
      const unwrapped = skipEnv(commandWords, 0);
      if (unwrapped === undefined) { commandWords = []; break; }
      // Keep the wrapper's literal spelling, including options affecting cwd/env.
      const prefixLength = commandWords.length - unwrapped.length;
      const literal = prefixLength > 0 && unwrapped.every((word, index) => word === commandWords[prefixLength + index]);
      const prefix = literal ? commandWords.slice(0, prefixLength) : commandWords;
      environment.push(...prefix);
      wrapperKnown = wrapperKnown && literal && !prefix.some((word) => /^(-[iv]*[fS]|--(?:file|split-string))(?:=|.|$)/u.test(word));
      commandWords = [...unwrapped];
    }
    const executable = commandWords[0] ?? "";
    if (!isNamedExecutable(executable, "git", dialect)) { staticShell = false; continue; }
    const invocation = gitSubcommand(commandWords);
    if (invocation === undefined) continue;
    const context: GitStaticContext = { executable, globalOptions: invocation.globalOptions, environment };
    const operatorsKnown = segment.tokens.every((token, index) => token.kind === "word" || dialect === "powershell" && token.value === "&" && index === 0);
    const reusable = staticShell && operatorsKnown && invocation.known && wrapperKnown;
    for (const action of gitActions(invocation.name, invocation.args)) {
      const item: GitCommandAction = { ruleId: `git.${action.action}`, action: action.action, risk: action.risk, reusable: reusable && action.known, context };
      const key = JSON.stringify(item);
      if (!seen.has(key)) { seen.add(key); actions.push(item); }
    }
    if (!operatorsKnown) staticShell = false;
  }
  return actions;
}

export function classifyKnownGitWrite(input: string, dialect: ShellDialect): string | undefined {
  const first = evaluateGitCommand(input, dialect)[0];
  if (first === undefined) return undefined;
  if (first.action === "reset.hard") return "reset --hard";
  const [name, action] = first.action.split(".");
  if (name === "notes") return `notes ${action?.split("-")[0] ?? ""}`;
  if (name === "stash" && ["pop", "drop", "clear"].includes(action ?? "")) return `stash ${action}`;
  return name;
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
