---
name: debugging
description: "MUST USE for any real runtime debugging across ANY language or binary — crashes, silent failures, wrong responses, stuck processes, memory leaks, async misbehavior, unexplained timing, flaky tests, intermittent failures, passes in isolation, different test fails, order-dependent behavior, CI-only failures, reverse engineering. Runs a hypothesis-driven loop: form ≥3 hypotheses, investigate in parallel, after 2 failed evidence rounds allow one hard-reasoning escalation only when the task is genuinely difficult, confirm root cause, capture a failing reproduction before the fix and verify the same case after, fix minimally, QA by actually USING the system, scrub artifacts. The actual HOW lives in `references/` — READ THEM. Triggers: 'debug this', 'why is X not working', 'hanging', 'attach a debugger', 'reverse engineer', 'pwndbg', 'gdb', 'lldb', 'node inspect', 'tsx debug', 'pdb', 'dlv', 'delve', 'rust-gdb', 'set a breakpoint', 'context window exploded', 'why is the response empty', 'attach the debugger', 'debug it', 'why is this happening', 'trace this bug', 'reproduce and fix', 'silent failure', 'HTTP 200 but empty', 'why did it stop', 'inspect the binary', 'reverse engineering', 'playwright', 'flaky test', 'intermittent failure', 'passes in isolation', 'different test fails', 'order-dependent', 'CI-only failure'."
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

# Debugging

You are a hypothesis-driven debugger. Two disciplines apply regardless of language, runtime, or whether you have source:

1. **Runtime truth beats code reading.** Every claim about why the bug happens must come from observed state — never from a plausible story spun from reading code.
2. **Clean only owned resources.** Before creating a debug artifact, retain its exact identity and cleanup action in the session's resource checklist; no checklist file is required. Remove temporary artifacts before calling the task done, preserving existing user work and retained valid regression evidence.

Keep investigation state and raw evidence in conversation or task-owned temporary storage, not a repository journal. Don't read, modify, delete, or adopt any existing `.debug-journal.md`, and don't edit Git exclude files for debugging notes. Reference instructions to record resources mean this temporary ownership checklist, not a development history. Durable code, comments, docs, and tests express only the final valid requirements, mechanism, and behavior. Tests protect functional and external-interface regressions, not descriptive wording, decision counterexamples, or removed-component absence; update tests with requirements and delete tests dedicated to removed components. Uncommitted intermediate behavior needn't be preserved, but committed contracts and API/security/data/permission authorization remain binding.

The rest of this file is a map. **The knowledge is in `references/`.** This file cannot teach you how to debug — it can only tell you which reference will, for your exact situation.

---

# 🚨 READ THE REFERENCES. THIS IS NOT OPTIONAL.

> **This skill is intentionally small.** Ninety percent of what you need to know lives in `references/`. If you skim this file and start working without opening the references, you will reattach a debugger the wrong way, miss a silent-failure pattern you've never seen before, waste an hour on a source-map gotcha, or invent a worse version of a tool that already solves your problem.
>
> **Every reference below is mandatory when its scenario applies.** "I know this language" is not an exemption. The references exist because every runtime and every specialist tool has at least one gotcha that silently wastes hours, and you will not know which gotcha until you read the file.
>
> **The gate rule**: before you run a command from a given reference's domain, you must have read that reference in this session. Re-reading across sessions is cheap. Guessing is expensive.

---

## Runtime Setup — MANDATORY READING BEFORE ATTACHING

The methodology is language-agnostic. The commands to launch, attach, breakpoint, and inspect are not. **Open the matching reference before Phase 0. Not during. Not after.**

| Your runtime is… | Open this before attaching anything | Non-negotiable because… |
|---|---|---|
| Python (CPython, pytest, asyncio, Django, FastAPI) | 📖 **[references/runtimes/python.md](references/runtimes/python.md)** | pdb vs ipdb vs debugpy vs pytest --pdb all have different attach semantics. Async code needs special breakpoint handling. Wrappers like `poetry run` swallow flags. |
| Node.js / tsx / ts-node / Bun / Deno (running source) | 📖 **[references/runtimes/node.md](references/runtimes/node.md)** | `tsx` + `node inspect` CLI has a **silent source-map failure** — breakpoints by line number do not fire. You will not notice unless you read this first. |
| Rust (cargo, tokio, panics) | 📖 **[references/runtimes/rust.md](references/runtimes/rust.md)** | Release builds strip symbols. Tokio tasks need `tokio-console`. The borrow checker makes `dbg!` the faster tool most of the time. |
| Go (goroutines, dlv, pprof, race) | 📖 **[references/runtimes/go.md](references/runtimes/go.md)** | Goroutine leaks and recovered panics are silent by default. `dlv` has a specific port convention. `go test -race` is the first thing to run, not the last. |
| Native binary / stripped C/C++ / no source | 📖 **[references/runtimes/native-binary.md](references/runtimes/native-binary.md)** | The workflow (triage → dynamic → static → scripted repro) is counterintuitive if you've never done it. `strings -n 8` silently drops short interpolations like `${x}` — read bytes directly for any extraction that matters. macOS adds SIP / Mach-O / lldb specifics that don't apply on Linux. |
| **Bundled-app binary** (Bun SEA, Node SEA, Deno compile, pkg, nexe, Electron, Tauri, PyInstaller) | 📖 **[references/runtimes/bundled-js-binary.md](references/runtimes/bundled-js-binary.md)** | These look like Mach-O / ELF but their *high-level* source is recoverable with the right per-bundler tool — Ghidra is overkill. Source-format reality varies: Bun/pkg/nexe/Electron-asar are usually plaintext; Node SEA with code-cache, PyInstaller `.pyc`, and Deno eszip need extra tooling; Tauri's Rust core still needs native-binary.md. Workflow: identify bundler → locate bundle → extract with the bundler-specific tool → grep. |

**If you cannot honestly say you just opened the reference for your runtime, open it now.**

> 🚨 **Native binary vs bundled binary — check before committing**: `file ./target` calls them both Mach-O / ELF. The 30-second discriminator is `du -h ./target` (50 MB+ suspect bundled) plus `strings -n 12 ./target | rg -iE 'bun|node_modules|webpack|esbuild|deno|pkg/lib|electron|pyinstaller|nexe|NODE_SEA_FUSE|tauri'`. If hits → bundled-js-binary.md. If clean → native-binary.md.

---

## Specialist Tools — ACTIVELY USE WHEN THE SCENARIO FITS

These are not "optional extras". They are the correct tool in their domain, and anything else is slower and less reliable. **If the bug fits the domain, you MUST use the tool. Read the reference first to know how.**

| Tool | Use when | Reference |
|---|---|---|
| **Playwright CLI** | Any browser-served web UI bug. Any flow that requires clicking/typing/navigating. Any "works locally, breaks in prod" where the browser or viewport is the variable. **For Phase 8 QA of any browser product, you MUST drive a real browser via Playwright — not curl, not imagination.** | 📖 **[references/tools/playwright-cli.md](references/tools/playwright-cli.md)** |
| **Ghidra** | Any binary without trustworthy source — third-party closed libs, malware, vendored binaries whose behavior contradicts docs, CTF, firmware. **Use Ghidra's decompiler before `strings`/`objdump` guessing. It turns machine code into readable C.** | 📖 **[references/tools/ghidra.md](references/tools/ghidra.md)** |
| **pwndbg** | Any native binary debugging session. It is GDB with the useful views (registers, stack, disasm, heap) always visible. **If you'd reach for plain `gdb`, reach for `pwndbg` instead — it is strictly a superset.** | 📖 **[references/tools/pwndbg.md](references/tools/pwndbg.md)** |
| **pwntools** | Any time you need a reproducible interaction with a binary or network service — crafted payloads, exploit automation, fuzz harness, CTF scripting. | 📖 **[references/tools/pwntools.md](references/tools/pwntools.md)** |
| **DAP client (`dap.mjs`)** | Any time you would drive a source debugger through a PTY and screen-scrape its text. Debuggers that speak the Debug Adapter Protocol (DAP) expose structured stops, variables, and errors; this bundled zero-dependency client keeps that output bounded and monitorable. **Prefer it over scraping debugger text whenever an already-available adapter speaks DAP.** | 📖 **[references/tools/dap.md](references/tools/dap.md)** |

**Failing to use these tools in their domain is a process failure, not a stylistic choice.** If the bug is in a browser and you did Phase 8 without Playwright, you are doing it wrong. If the bug is in a stripped binary and you read hex with `xxd`, you are doing it wrong. The references tell you how. Read them.

Browser tools always run in a **run-owned temporary empty browser profile or isolated empty context**. **Do not sign in to any browser, vendor, site, or account, including disposable or test accounts.** **Do not import, copy, reuse, or sync user browser settings, extensions, cookies, authentication, or storage state.** If the required flow is authentication-gated, stop at that boundary and **report authentication as a verification limitation**; never attach to a live browser or weaken the boundary to complete QA.

---

## The Phase Loop — READ THE REFERENCE FOR THE PHASE YOU ARE ENTERING

Each phase has exactly one reference. Read it as you enter the phase — not in advance, not from memory. The references are self-contained and short.

| # | Phase | 📖 Open this when entering |
|---|---|---|
| 0 | **Environment assessment** — know the runtime, ports, symbols, env vars, watchers before attaching | [references/methodology/00-setup.md](references/methodology/00-setup.md) |
| 1 | **Temporary resource ownership**: exact task-owned artifacts and safe cleanup actions | [references/methodology/00-setup.md](references/methodology/00-setup.md) |
| 2 | **Hypothesis formation** — minimum three, across orthogonal axes, each with distinguishing evidence | [references/methodology/02-investigate.md](references/methodology/02-investigate.md) |
| 3 | **Parallel investigation** — independent direct probes or permitted callable native roles | [references/methodology/02-investigate.md](references/methodology/02-investigate.md) |
| 4 | **Hard-reasoning escalation** — only after 2 consecutive failed evidence rounds make the task genuinely difficult; consult one hard-reasoning agent with orthogonal framings | [references/methodology/04-hard-reasoning-escalation.md](references/methodology/04-hard-reasoning-escalation.md) |
| 5 | **User decision escalation** — only when evidence exhausted and the call has policy implications | [references/methodology/05-escalate.md](references/methodology/05-escalate.md) |
| 6 | **Root cause confirmation** — confirmed only when toggling the suspected cause toggles the bug | [references/methodology/06-fix.md](references/methodology/06-fix.md) |
| 7 | **Reproduction-first fix** — capture failure first, minimal change, same case passes, no scope expansion | [references/methodology/06-fix.md](references/methodology/06-fix.md) |
| 8 | **Manual QA** — actually use the system (tmux for CLI, Playwright for browser, real curl for API, real repro for binary) | [references/methodology/08-qa.md](references/methodology/08-qa.md) |
| 9 | **Cleanup**: walk the temporary resource checklist, remove owned artifacts, verify only the fix and valid regression evidence were added to the initial working tree | [references/methodology/09-cleanup.md](references/methodology/09-cleanup.md) |
| 10 | **Final verification** — four evidence gates before declaring done | [references/methodology/09-cleanup.md](references/methodology/09-cleanup.md) |

**Phase references are short by design.** Reading one takes a minute. Skipping one costs an hour.

### Cross-cutting methodology references

These are not phases — read them when the situation calls for them:

| Situation | Reference |
|---|---|
| A test is flaky/intermittent, a different test fails, it passes in isolation, it is order-dependent, or it fails only in CI | 📖 **[references/methodology/03-flaky-triage.md](references/methodology/03-flaky-triage.md)** — establish the three-run signature and classify shared state before Phase 2. |
| You cannot run the actual operation (paid API, blocked network, missing hardware) but still need runtime evidence | 📖 **[references/methodology/partial-runtime-evidence.md](references/methodology/partial-runtime-evidence.md)** |
| You're about to declare an extraction / audit / reverse-engineering task done and want a skeptical pass | 📖 **[references/methodology/partial-runtime-evidence.md#independent-verification-for-non-debug-artifacts](references/methodology/partial-runtime-evidence.md#independent-verification-for-non-debug-artifacts)** |

---

## Non-Negotiable Safety Invariants

<safety>
1. **Runtime state is the only source of truth.** A hypothesis without an observed value is a guess. Do not fix guesses.
2. **Every debug artifact has known ownership and a safe cleanup action before creation.** Session-level tracking is sufficient; never introduce a repository journal, extra ledger, or adopt another task's resources.
3. **Never ship a fix without its reproduction.** The failing case captured BEFORE the fix, the same case passing after it, or the fix is unverified. Where the repository keeps tests for this behavior, that case is the regression test.
4. **Never declare done on type-check/compile alone.** Types catch declaration bugs. Only running the actual user scenario catches the actual user bug.
5. **Never ask the user a question that runtime evidence can already answer.** Escalation is for genuine ambiguity.
6. **Never silently swallow errors while debugging.** If the system swallows errors, that is often the bug itself. Make them loud temporarily; restore at cleanup.
7. **Never `git commit` from inside this skill.** Load the native git-master skill only for an exact user-authorized Git operation that the current role policy permits; confirming a fix is not commit authorization.
8. **Never attach without having read the runtime reference.** The gate rule.
</safety>

---

## What to Do Right Now

1. Read the user's bug description.
2. Identify the runtime.
3. If the report is a flaky test, intermittent failure, passes in isolation, different test fails, order-dependent, or CI-only failure, **open `references/methodology/03-flaky-triage.md` before forming hypotheses.**
4. **Open `references/runtimes/<runtime>.md`.** Read it.
5. Identify which specialist tools apply. **Open each matching `references/tools/*.md`.** Read them.
6. Open `references/methodology/00-setup.md` and start Phase 0.
7. Follow the phase loop. Read each methodology reference as you enter the phase.

**The references are the skill. This file is an index.**
