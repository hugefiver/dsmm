---
name: remove-ai-slops
description: "Remove AI-generated code slop from branch changes or an explicit file list. Establishes regression coverage for final valid requirements, then runs categorized cleanup with bounded permitted work and verifies with quality gates. Covers 10 slop categories. MUST USE when the user asks to \"remove slop\", \"clean AI code\", \"deslop\", \"clean up AI-generated code\", \"remove AI slop\", or wants to clean up AI-generated patterns."
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

# Remove AI Slops Skill

## Inputs

- **Default scope**: branch diff vs `merge-base main` (no arguments needed)
- **Optional scope**: explicit file list passed by the caller

## What this skill does

Cleans AI-generated slop from a bounded set of changed files while preserving final valid requirements and committed contracts. Establishes relevant regression coverage first, then runs a categorized multi-pass cleanup and verifies with applicable quality gates and self-review. Correct only task-owned edits when verification fails.

The safety invariant: **relevant functional and external-interface requirements have passing regression evidence before cleanup**. Don't lock uncommitted intermediate behavior or descriptive text merely because it exists. Git commits are the compatibility boundary; existing committed contracts still bind files with uncommitted edits. Public API/protocol, security, data, permission, and irreversible-operation changes require their applicable authorization.

## 10 Slop Categories

### Stylistic

1. **Obvious comments**: Comments that restate what the code does, useless TODOs, commented-out code. KEEP: current design reasons and meaningful BDD markers, not development or decision history.
2. **Over-defensive code** — Null checks on guaranteed values, try/catch around code that cannot throw, instanceof/type guards on statically-typed params, multi-layer redundant validation, broad catch-all (catch Exception / empty catch). REFACTOR: narrow exceptions, add type narrowing.
3. **Excessive complexity** — Deep nesting (>3 levels), nested ternaries, complex boolean (4+ predicates), long parameter lists (>5), god functions (>50 lines), if/elif variant chains (should be exhaustive pattern matching), `any`/`object` type annotations (should be interfaces/generics/unions).

### Structural

4. **Needless abstraction** — Pass-through wrappers, single-use helpers, speculative indirection, single-implementation interfaces, factory functions that only call constructors.
5. **Boundary violations** — Wrong-layer imports, responsibility leaks, hidden coupling, pure functions with side effects.
6. **Dead code** — Unused imports, unused private functions, unreachable branches, stale feature flags, debug leftovers (console.log, print, dbg!, console.error).

### Hidden cost

7. **Duplication** — Copy-pasted branches, redundant helpers, repeated magic numbers. KEEP: coincidental repetition where intents differ.
8. **Performance equivalences** — O(n²)→O(n), hoist loop-invariant computations, unnecessary intermediate collections, string concatenation in loops (use join/array push), redundant DB/API calls in loops (batch them), redundant deep copies, repeated len()/size() calls (cache). Hard rule: only apply when equivalence is obvious.

### Behavior coverage

9. **Missing tests**: Valid functional or external-interface requirements lack regression coverage. Add the narrowest meaningful test, not a lock for every changed file or intermediate behavior.

### Structural

10. **Mixed-responsibility modules** — Identify ownership/cohesion problems, not a LOC quota. Split by responsibility only when necessary for the approved cleanup; do not manufacture helpers, interfaces, comments or opt-out markers to satisfy a counter. Verify preserved behavior at the affected seam.

## 6-Phase Flow

### Phase 0: Size the work

Use session-level coordination only when it helps. An exposed native todo_write tool can track the owning Agent's complete content/status list under its actual parallel policy; otherwise use a concise response. No TodoWrite, workspace ledger or automatic plan file is assumed. Non-product routine docs or maintenance cleanup does not require planner/critic/review dispatch or a plan/report/evidence file; resolve it directly or ask/delegate a bounded task when needed. Complex product behavior implementation retains its applicable planning policy, and explicit process requirements or concrete major safety risks retain necessary verification.

### Phase 1: Determine scope

```
git diff $(git merge-base main HEAD)..HEAD --name-only
```

Filter out: deleted files, binary files, generated files.

### Phase 2: Establish valid regression coverage (NON-NEGOTIABLE)

For each in-scope behavior-bearing file:
1. Identify final valid functional requirements and committed public/observable contracts.
2. Check if existing tests cover it.
3. If a meaningful regression seam lacks coverage, write the narrowest test for that requirement.
4. Tests must be GREEN before cleanup starts.

If you can't establish passing evidence for a required functional contract, stop cleanup of that behavior. Documentation-only edits use semantic review and applicable loading/delivery checks, not invented text-lock tests.

Don't add string, regex, snapshot, or parsed-content locks for documentation, commit messages, package information, or error/log wording without functional or system-boundary significance. Don't test decision counterexamples or removed components' absence. Update corresponding tests when requirements change; delete tests dedicated to removed modules, helpers, tools, or subsystems. Valid negative safety, protocol, and input-handling tests remain appropriate. Documentation and comments state the concise final design, not the cleanup history.

### Phase 3: Cleanup plan

Keep the categories, cleanup order, and material risks needed for current execution in session, not a per-file workspace ledger.

Safety order (safe → dangerous):
comments → dead code → defensive → duplication → complexity → abstraction/boundary → performance → tests → oversized-modules

### Phase 4: Bounded slop removal

Use direct edits for resolvable non-product docs or maintenance cleanup. Delegate independent product cleanup only when an actually callable permitted native role owns a useful bounded deliverable; respect file ownership, inherited authority and depth. Choose concurrency from actual dependencies and capacity, not a batch quota. Pass run_in_background only when the admitted schema exposes it and useful independent parent work remains; otherwise keep result-gated cleanup foreground. Integrate results before dependent work.

Each file gets a detailed prompt containing:
- The category checklist for that file
- The cleanup order
- Hard constraints: final valid requirements and committed contracts must be preserved; no unauthorized public API changes, no deleting type annotations, no introducing new abstractions, minimal diff. Don't preserve uncommitted transition behavior or add descriptive-text, decision-counterexample, or removed-component absence tests.

An acknowledgment, partial output or wait timeout is not completion evidence. Inspect the actual result, failed checks and unresolved blockers; do not require status tokens or invented polling APIs.

### Phase 5: Applicable quality gates + self-review

Select the meaningful available gates for the changed surface and concrete risk; reuse sufficient unchanged evidence rather than repeating all gates after each correction. Report necessary unavailable tooling/evidence instead of installing it implicitly or claiming a pass:
1. Regression tests still green
2. Lint clean
3. Typecheck clean
4. Unit + integration tests green
5. Static security scan clean (if applicable)

3 review checklists:
- **Safety**: No unauthorized contract change, no security regression, no data loss risk.
- **Behavior**: Final valid functional and external-interface requirements are covered; committed contracts remain intact.
- **Quality**: No new slop introduced, diff is minimal, naming is consistent.

### Phase 6: Fix issues

If a gate fails:
1. Identify the change that caused the failure.
2. Explain why.
3. Inspect the current diff and use an exposed authorized edit tool to correct only this task's problematic hunk; never discard existing user edits or perform unauthorized Git writes. A destructive Git restore requires separate exact authorization.
4. Direct-edit to re-apply only the provably-safe changes.
5. Re-run affected gates and reassess the relevant safety/behavior/quality concern, not every unchanged check.

Stop and escalate when evidence exposes a material blocker, unsafe equivalence, or an authorization decision; do not impose an arbitrary attempt quota.

## Output Format

Return this report in conversation; don't create a workspace report or evidence file unless explicitly requested as a deliverable.

```
## Scope
<files in scope>

## Delivered Result
<current implementation and changed files>

## Regression Coverage
<valid requirements covered, green baseline status>

## Quality Gates
<gates: PASS/FAIL/N/A + evidence>

## Critical Review
<Safety/Behavior/Quality findings>

## Remaining Risks
<slop noticed but out of scope, concerns>

## Final Status
CLEAN | ISSUES FIXED | REQUIRES ATTENTION
```

## Core Principles

- **Valid regression coverage first**: Protect final functional requirements and external contracts, not intermediate implementations. Phase 2 is non-negotiable.
- **Don't bundle unrelated refactors**: A single cleanup commit containing dead code + abstraction + performance is unreviewable and unbisectable. Stay in slop scope.
- **Algorithm changes are NOT slop fixes**: If equivalence requires proof, it's a refactor, not a slop fix. It belongs in a separate change.
- **Don't silently skip**: If a gate is N/A, say N/A and why. If it fails, say it fails.
- **Keep current design reasons**: Remove restating comments and development/decision histories; retain explanations needed to maintain the final design.
- **Don't touch out-of-scope files**: If you notice slop elsewhere, report it in Remaining Risks only.
- **When in doubt, SKIP**: Don't guess. Skip and report.
- **Useful concurrency only**: Choose concurrency from actual independence, ownership and native capacity; don't fill a batch or delegate resolvable non-product cleanup. Passing evidence protects final valid requirements and committed contracts, not uncommitted transition behavior or descriptive text.
