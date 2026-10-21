---
name: using-git-worktrees
description: Use ONLY when the user explicitly asks to use a git worktree for isolated feature work. Do not auto-trigger. Creates a linked worktree, sets up the project, and verifies a clean baseline before development begins.
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

# Using Git Worktrees

> **Consent gate:** This skill activates ONLY when the user explicitly requests a worktree. Never proactively offer or create a worktree. If the user asks for "isolation" or "a separate branch" without saying "worktree," ask whether they want a worktree or a regular branch.

## When to Use

- The user explicitly says "worktree" (or confirms when asked)
- You need isolated development without disturbing the main working tree
- The repository is not a submodule (worktrees inside submodules are problematic)

## Why Worktrees

A worktree gives you a separate checkout of the same repository, linked to the same `.git` directory. You can build and test on one branch without switching your main checkout. Changes in the worktree are visible to git immediately; no stash/switch/unstash dance.

## The Flow

### Step 0: Detect Existing Isolation

Before creating anything, check whether you are already inside a worktree.

```powershell
# In pwsh — check if GIT_DIR differs from GIT_WORK_TREE
$gitDir = git rev-parse --git-dir 2>$null
$gitCommon = git rev-parse --git-common-dir 2>$null
if ($gitDir -and $gitCommon -and ($gitDir -ne $gitCommon)) {
  Write-Output "Already inside a worktree (git-dir=$gitDir, common-dir=$gitCommon). Aborting create."
  exit
}
```

If `git-dir` and `git-common-dir` differ, you are already in a linked worktree — do not create a nested one. Report this to the user and ask how to proceed.

**Submodule guard:** If the current directory is inside a git submodule, worktrees are unreliable. Check with `git rev-parse --show-toplevel` and verify the top-level is not a `.gitmodules` entry.

### Step 1: Create the Worktree

Use `git worktree add` only after explicit worktree authorization, through an actually permitted native shell. No DSH worktree service is assumed.

```powershell
# From the repository root:
$branch = "feature/<short-descriptive-name>"
$worktreePath = "<repo-parent-dir>/<repo-name>-wt-<short-name>"

git worktree add -b $branch $worktreePath
```

**Naming convention:** Place the worktree as a sibling of the main repo (`../<repo>-wt-<branch>`), not inside it. This avoids the worktree appearing in the main checkout's file listing.

**Branch vs detached:** Prefer `-b <new-branch>` so the worktree is on a named branch. Use `--detach` only if the user explicitly wants a detached HEAD.

### Step 2: Project Setup

The worktree is a fresh checkout — dependencies and build artifacts are not shared. Re-run project setup inside the worktree directory.

```powershell
Set-Location $worktreePath

# Node / pnpm (DSMM uses pnpm)
pnpm install

# Cargo (if the project has Rust components)
# cargo build

# Python (if applicable)
# python -m venv .venv; .\.venv\Scripts\Activate.ps1; pip install -e .

# Go (if applicable)
# go build ./...
```

**Do not assume the setup is identical.** Build tools, lockfiles, and generated files must be regenerated in the worktree.

### Step 3: Verify Clean Baseline

Confirm the worktree is ready for development.

```powershell
# Verify branch
git branch --show-current

# Verify clean status
git status --short

# Verify the project builds and tests pass
pnpm run typecheck
pnpm test
```

If any check fails, stop and report to the user. Do not begin feature work on a broken baseline.

## Quick Reference

| Action | Command (pwsh) |
|---|---|
| List existing worktrees | `git worktree list` |
| Create worktree + branch | `git worktree add -b <branch> <path>` |
| Remove worktree | `git worktree remove <path>` |
| Prune stale worktree metadata | `git worktree prune` |
| Check if inside a worktree | `git rev-parse --git-dir` vs `--git-common-dir` |

## Common Mistakes

- **Creating a worktree inside the main checkout.** This pollutes the main tree. Always place worktrees as siblings, not children.
- **Forgetting to run project setup.** The worktree starts empty of `node_modules`, `target/`, etc. Build will fail until you re-install.
- **Not verifying the baseline.** If the worktree's `pnpm test` fails before you write any code, you cannot distinguish pre-existing failures from your changes.
- **Leaving stale worktrees.** When done, `git worktree remove <path>` cleans up. Stale worktrees accumulate and confuse `git worktree list`.

## Red Flags

- Never create a worktree without explicit user consent.
- Never create a worktree inside a submodule.
- Never assume the worktree shares `node_modules` or build artifacts with the main checkout.
- Never start feature work before verifying the baseline builds and tests pass.
- Never leave a worktree unremoved after the work is merged — clean up.

## When Done

When the feature is merged or abandoned:

```powershell
Set-Location <repo-root>
git worktree remove <worktree-path>
git branch -d <branch>  # if merged; -D if abandoned
```
