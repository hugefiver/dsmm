---
name: ast-grep
description: "Use ast-grep (sg) only when the task explicitly requires exact syntax-tree matching or a deterministic codemod that simpler rg/LSP lookup cannot express reliably. Examples: rewrite a specific call/import shape, strip `as any`, find empty catch blocks, or scan/apply YAML rules. Do not trigger for ordinary repository discovery, symbol navigation, text search, or one-off lookups that rg/LSP can answer."
---

## DSH resource and authority contract

This is a DSMM-maintained native skill for DSH 0.2.1-rc.2, not an OpenCode or Codex runtime. Product names in transcript formats, examples, paths and attribution remain descriptive; they are not a host switch.

- Load this skill through the native skill tool only when its trigger matches. Resolve every relative reference/script/asset from the directory resourceBase returned with this skill, not from the project cwd or a sibling repository checkout. Use available read/glob/grep to inspect resources; use write/edit and the active bash or pwsh only within the actual role and host permissions.
- External documentation uses actual web_search/web_fetch or an available documentation service. Context7, GitHub MCP, browser, image and LSP tools are optional catalog capabilities, not bundled calls. Use a real available equivalent or report unavailable evidence; never invent an MCP, Task, todo or compression API. Native read uses file_path, not OpenCode filePath; inspect every actual schema before calling it. Use read_image only when exposed and the actual route supports its image result.
- Source role names are logical assignments: code-search/explore maps to role ID dsmm-code-search, and other canonical roles/categories map to dsmm-<name>. Use this Agent's observed admitted inventory: per-role topology has individual role tools (for example dsmm_plan_critic) plus dsmm_category; parameterized topology has dsmm_role and dsmm_category with their actual role/category enums. Never derive callability from generated files, names or templates. Both layouts preserve target, caller, read-only, inherited tool and depth ceilings; a missing required formal role returns to the stage owner, not a planning bypass.
- Templates describe assignment content, not callable schemas. Actual delegation takes description/prompt, an exposed level, a deployment-authorized exposed route, and an exposed run_in_background only. Omitted/normal retains the default; low/high/max must be configured at roleRouting.<id>.levels as a complete route or exact supported effort, never synthetic suffix roles or fixed max effort. A complete invocation route needs paired provider/model and cannot silently fall back; effort-only needs exact native preflight. Level/layout never change permissions or verification rigor. Reviewer/Oracle independence requires different observed native routes, not names.
- One-shot defaults foreground; permitted one-shot background is native-job-owned. A managed admitted continuable configuration defaults background; explicit run_in_background:false creates a non-reusable one-shot. Use only exposed job_output/job_list/job_kill or send_message/interrupt_agent and returned identities. Existing continuable children can receive nearest-step running messages, idle next turns or same-ID cold continuation; receipts mean inbox acceptance, not completion. Exposed native child-to-parent reporting retains exact-sender/adjacency semantics, not new parent-to-child authority. Settled one-shots never revive; reuse never reselects role/level/route or copies a parent's newer policy into the original child capture. Do not send OpenCode task_id/subagent_type/background/resume/retry or guessed control fields.
- Host observations alone establish lifecycle controls. Managed delivery requires explicit startup composition: disable the stock subagents row, bind the unique PUBLIC DSMM SubagentRuntime subclass and restart; never hot-replace/drain stock or add a shadow runtime. When actually wired and authorized, a user foreground handoff transfers the existing same run to native jobs without a second start; native user queue/steer follows its operator/connection/session/epoch gate. Do not announce unconnected tools/RPCs. Background enablement, capacity, ownership, depth, cancellation and provider support always gate execution. Legacy conservative evidence may permit useful proven capabilities under the same durable child ID; missing evidence denies that capability with a reason, not all legacy children and not an inheritance of current parent policy.
- When exposed, native todo_write replaces the owning Agent's whole list of content/status items; its schema and allowParallelInProgress policy govern updates. Otherwise use concise session coordination or an authorized plan. ask_user_question is conditional on exposure; otherwise ask in conversation. Native host compaction is not a model-facing compression tool. A read-only planner returns complete Markdown; an authorized coordinator persists it, never the planner through shell or a proxy. Role responsibilities, explicit-off common/skill visibility, and the terminal delegation contract override broader examples in a resource.
- Follow the current user's explicit output-language request, otherwise this Agent's immutable captured DSMM locale when supplied, then applicable host/user language guidance or the current request/context. Supported configured locales are en/zh-Hans/zh-Hant/ja/ko/de/fr/es/pt-BR/ru; omission inherits, not an English default. Preserve code, identifiers, paths, commands, protocol fields and exact quotes, and pass explicit language instructions in child assignments. This resource imports no Root session preference, promises neither internal reasoning language nor UI translation, and never changes host/project locale. A later parent Apply does not rewrite a child's captured locale.
- Installation, package-manager bootstrap, downloads, authentication/login, credential/profile access, Git writes and destructive actions require explicit authorization for the exact action. Reference commands are not automatic operations. Worktree consent does not authorize dependency installation or later branch deletion. Read before changing an existing file; preserve unrelated user work. Never silently restore/reset a working tree to repair a failed cleanup.
- Browser/debug QA uses run-owned isolated state, no imported credentials or browser profile, and only already available software unless separately authorized. Keep commands in the active shell dialect. Report unverified surfaces honestly.

# ast-grep

`sg` (also installed as `ast-grep`) is a specialized **AST-aware search and rewrite tool** across 25 languages. It treats your pattern as code, parses it the same way it parses your project, and matches structurally. It is an escalation for exact syntax-tree questions and deterministic codemods, not a default repository-discovery tool.

This skill ships a Python wrapper at `scripts/ast_grep_helper.py` and platform install scripts at `install.sh` (POSIX) and `install.ps1` (Windows). The helper adds offline pattern validation, the two-pass write trick, and binary auto-resolution. Use it as the entry point after the task has met this skill's narrow trigger.

---

## When to use this skill

Use it only when the answer or rewrite depends on an **exact syntax-tree shape**, and simpler text search or LSP navigation cannot express the requirement reliably:

- "Find every function that takes a `Request` parameter."
- "Rewrite every `console.log(x)` to `logger.info(x)`."
- "Strip every `as any` cast."
- "Replace `require(...)` with `import` across the repo."
- "Find empty catch blocks."
- "Migrate `Optional[X]` to `X | None`."
- "Apply this codemod across these 200 files."
- "Run our YAML lint rules and surface violations."

Use LSP for symbols, references, definitions, types, and diagnostics. Use plain `grep` / `rg` for strings, comments, license headers, file names, identifier text, and regex-style searches. When in doubt, start with those simpler tools and do not load this skill unless exact AST shape becomes necessary.

---

## Three things the agent must internalize

### 1. ast-grep is NOT regex

The wildcards are `$VAR` (one AST node) and `$$$` (zero or more nodes). Regex syntax fails silently:

| You wrote | What ast-grep saw | What you wanted |
|---|---|---|
| `foo\|bar` | bitwise-or of `foo` and `bar` | run two separate searches |
| `.*foo` | not parseable | `$$$ foo` (if `$$$` is a list of nodes) or use `rg` |
| `\w+` | not parseable | `$VAR` to capture any identifier |
| `[a-z]` | character class, not parseable | switch to `rg` |

The full anti-pattern table is in `references/pitfalls.md` §1. The helper's `validate` subcommand catches these mechanically — call it before debugging "no matches" by hand.

### 2. Patterns must be valid code

The pattern itself must parse. `def $FN($$$):` fails because the trailing `:` makes it incomplete; use `def $FN($$$)`. `function $NAME` without params/body fails; use `function $NAME($$$) { $$$ }`. Full table per language in `references/pitfalls.md` §2.

### 3. `--update-all` and `--json` are mutually exclusive (silently)

This is the single biggest gotcha when scripting. `sg run -p P -r R --json --update-all` returns the JSON but **does not mutate files**. To both preview AND apply, run **two passes**:

```bash
sg run -p P -r R --json=compact .   # pass 1: see what would change
sg run -p P -r R --update-all .     # pass 2: actually apply
```

The helper does this automatically when you call `replace --apply`. Read `references/pitfalls.md` §9.

---

## The helper script — `scripts/ast_grep_helper.py`

A single-file Python 3 stdlib wrapper. Same on every OS. The agent's default entry point.

### `search` — find all matches of a pattern

```bash
python3 scripts/ast_grep_helper.py search 'console.log($MSG)' --lang ts src/
```

Validates the pattern offline first. If the pattern looks like regex (`\w`, `.*`, `|`, etc.) the helper exits with a hint and never calls `sg` — saves a round-trip. Pass `--force` to skip validation.

Flags:
- `--lang ts` (or any of the 25 languages; aliases like `js`, `py`, `rs`, `kt` accepted)
- `--globs '!**/*.test.ts'` (repeatable; prefix `!` to exclude)
- `-C 3` (context lines)
- `--json-out` (raw JSON instead of human format)

### `replace` — rewrite by pattern, dry-run by default

```bash
# Dry-run preview (default — no files mutated)
python3 scripts/ast_grep_helper.py replace 'console.log($MSG)' 'logger.info($MSG)' --lang ts src/

# Actually apply
python3 scripts/ast_grep_helper.py replace 'console.log($MSG)' 'logger.info($MSG)' --lang ts src/ --apply
```

The helper:
1. Validates both `pattern` and `rewrite` for hint-detectable mistakes.
2. Runs pass 1 with `--json=compact` to collect matches and show a preview.
3. If `--apply` is set, runs pass 2 with `--update-all` to mutate files.

### `scan` — run YAML rules

```bash
# Discover sgconfig.yml from cwd and run all rules
python3 scripts/ast_grep_helper.py scan src/

# Run a single rule file
python3 scripts/ast_grep_helper.py scan -r rules/no-console.yml src/

# Apply auto-fixes
python3 scripts/ast_grep_helper.py scan -U src/

# CI-friendly GitHub annotations
python3 scripts/ast_grep_helper.py scan --report-style short src/
```

### `validate` — offline pattern check (no `sg` call)

Useful for CI lints, pre-commit hooks, and quick sanity checks:

```bash
python3 scripts/ast_grep_helper.py validate '\w+' --lang ts
# → exit 2: regex \w not supported. Use $VAR for identifiers.

python3 scripts/ast_grep_helper.py validate 'console.log($MSG)' --lang ts
# → exit 0: pattern looks plausible for ast-grep.
```

### `langs` / `doctor` / `install`

```bash
python3 scripts/ast_grep_helper.py langs       # list 25 supported languages and aliases
python3 scripts/ast_grep_helper.py doctor      # check ast-grep binary availability
python3 scripts/ast_grep_helper.py install     # delegate to install.sh / install.ps1
```

`new` and `test` subcommands proxy directly to `sg new` and `sg test`.

---

## Direct `sg` use (when the helper isn't enough)

The helper is opinionated. For full control, drop to `sg`. The skill ships a CLI cheat sheet in `references/cli.md`. The minimal idioms:

```bash
# Search
sg run -p 'console.log($MSG)' --lang ts src/

# Search with JSON for scripting
sg run -p 'console.log($MSG)' --lang ts --json=compact src/ | jq '.[] | .file'

# Rewrite, dry-run
sg run -p 'console.log($MSG)' -r 'logger.info($MSG)' --lang ts --json=compact src/

# Rewrite, apply
sg run -p 'console.log($MSG)' -r 'logger.info($MSG)' --lang ts --update-all src/

# Pattern from stdin (great for ad-hoc experiments)
echo 'console.log("hi")' | sg run -p 'console.log($MSG)' --lang js --stdin

# Debug a pattern that returns 0 matches
sg run -p '<your pattern>' --lang <lang> --debug-query=ast --stdin <<< '<sample-code>'

# Run YAML rules
sg scan src/

# Inline YAML rule (one-off)
sg scan --inline-rules '
id: no-todo
language: TypeScript
severity: warning
rule: { pattern: TODO }' src/
```

When using `sg` directly in a shell, **always single-quote patterns** so `$VAR` is not expanded by the shell.

---

## Decision tree — what to use, when

```
USER asks for "find/rewrite/codemod"
│
├─ structural pattern (function shape, call, class, import, control flow)
│  └→ ast-grep (this skill)
│
├─ text pattern (regex, alternation, character classes, file names)
│  └→ rg / grep
│
├─ semantic question (what variable does this refer to? does this throw?)
│  └→ LSP tools, TypeScript compiler, Pyright, Semgrep with type inference
│
└─ multiple repos / federated search
   └→ a search engine + then ast-grep / rg / LSP per-repo
```

The words "find all" or "every" do not by themselves trigger ast-grep. Use it only when the target is an exact syntactic shape and simpler search cannot reliably distinguish it; use rg when the target is text (string content, comment, license header, file name, identifier substring).

---

## Always run dry-run first when rewriting

A bad pattern silently rewrites the wrong thing. The helper's `replace` defaults to dry-run for this reason. The flow is:

1. Search to confirm matches: `helper search '<pattern>' --lang X .`
2. Dry-run rewrite: `helper replace '<pattern>' '<rewrite>' --lang X .` (no `--apply`)
3. Inspect the dry-run summary: number of matches, files affected, the per-location preview.
4. If wrong: refine pattern, go back to step 1.
5. If right: `helper replace '<pattern>' '<rewrite>' --lang X . --apply`.

Never apply a rewrite that you have not first dry-run.

---

## When `sg` returns 0 matches but you know the code is there

In priority order:

1. **Run `helper validate '<pattern>' --lang <lang>`** — catches regex misuse, missing function bodies, Python trailing colons.
2. **Check `--lang`** — `sg` infers from extension; if you pass a `.tsx` file with `--lang ts` (not `tsx`), JSX won't parse.
3. **Inspect the parsed pattern**: `sg run -p '<pattern>' --lang <lang> --debug-query=ast --stdin <<< '<sample>'`. If it shows `ERROR` nodes, the pattern is malformed.
4. **Check the AST of the target file**: `sg run -p '$_' --lang <lang> --debug-query=cst path/to/file | head -40` — find the `kind` you're trying to match.
5. **Try the playground**: <https://ast-grep.github.io/playground.html> — paste code + pattern, see what's happening.

Do not blindly retry with variations. Each failure has a reason; surface it.

---

## When to use YAML rules vs inline `-p` patterns

**Use inline `-p`** when:
- One-off ad-hoc query.
- The pattern is simple (no constraints, no fix template).
- You're exploring.

**Use YAML rules** (file under `rules/`, run via `sg scan`) when:
- The pattern is reused (lint rule, codemod that runs in CI).
- You need `constraints`, `transform`, complex `inside`/`has`, or composite logic.
- You want auto-fix (`fix:` field).
- You want to test the rule (snapshot tests via `sg test`).

The full YAML rule schema is in `references/yaml-rules.md`. Project setup (`sgconfig.yml`, `ruleDirs`, `utilDirs`) is in `references/sgconfig.md`.

---

## Output discipline

- `sg run --json=compact` produces an array of match objects: `{ file, range: {start, end}, text, replacement?, lines, language, ... }`. Pipe through `jq` for further processing.
- Without `--json`, `sg` produces human-readable colored output suitable for terminals.
- The helper's default output is human-readable (file:line:column + match preview). Pass `--json-out` for raw JSON.
- The helper's `replace` always summarizes: number of matches, number of files, per-location preview.

When summarizing for the user, **always include the count of files affected**, not just the count of matches. Users care about blast radius.

---

## Required reading (in order of priority)

1. `references/patterns.md` — meta-variables, naming rules, strictness levels. Read when you're unsure why a pattern doesn't match.
2. `references/pitfalls.md` — the failure-mode field guide. Read when 0 matches surprises you.
3. `references/recipes.md` — copy-paste patterns by language. Read first when you start a new task.
4. `references/cli.md` — `sg run`, `sg scan`, `sg test`, `sg new`, `sg lsp`. Read when the helper isn't enough.
5. `references/yaml-rules.md` — YAML rule schema. Read when you outgrow inline patterns.
6. `references/sgconfig.md` — project-level configuration. Read when you set up `sg scan` for a real project.
7. `references/install.md` — per-OS install methods. Read only if `install.sh` / `install.ps1` fail.

---

## Invariants (do not break)

- **Validate before searching.** When emitting a pattern programmatically, call `helper validate` first. It catches the regex-misuse class of mistakes that account for ~70% of "0 matches" debug sessions.
- **Dry-run before applying.** Never run `sg run -r ... --update-all` without first inspecting the matches. The helper's `replace` enforces this by default.
- **Two-pass writes.** When using `sg` directly to both preview and apply, run two invocations — `--json` ignores `--update-all`.
- **Single-quote patterns in shell.** `'$VAR'` not `"$VAR"`. The shell expands `$VAR` to the empty string in double quotes, breaking the pattern.
- **Pattern is code, not regex.** When the pattern would need `|`, `.*`, `\w`, or `[a-z]`, switch to `rg` instead. Don't try to force ast-grep into a regex shape.
- **`--lang` is required for stdin.** When piping with `--stdin`, set `--lang` explicitly; `sg` cannot infer from extension.
- **Linux: prefer `ast-grep` over `sg`** because `sg` collides with `setgroups`. The helper handles this; if you call `sg` directly, alias it: `alias sg=ast-grep`.
