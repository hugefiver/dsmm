---
name: subagent-driven-development
description: Use when executing implementation plans with independent tasks in the current session
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

<!-- Local fork of obra/superpowers/subagent-driven-development v6.3.0.
     Optional delegation after applicable planning; current outcomes and evidence.
     Worker permissions, ownership, and host continuation remain bounded.
     Source and maintenance contract: docs/v1-maintenance.md. -->

# Subagent-Driven Development

Use focused workers when delegation materially improves implementation of an approved plan. Coordinate toward the plan's goal and ideal end state, not toward ceremonial completion of every originally imagined step.

**Core principle:** Preserve the approved goal, constraints, permissions, and acceptance criteria; choose the smallest execution and evidence path that proves the outcome.

Delegation is optional. Direct execution is valid when a task is small, tightly coupled to controller context, or cheaper to complete than to brief and reconcile. When delegation helps, give each worker self-contained context rather than session history.

This skill begins at implementation. For complex implementation of product business logic or behavior, the orchestrator must first complete the `planner` → `plan-critic` sequence and resolve every substantive plan blocker. An exception applies only to a limited, simple, low-risk, clearly bounded change or an explicit user request. Non-product routine operations, docs, maintenance, and release preparation do not inherit that sequence: execute directly when resolvable, otherwise ask or delegate a bounded `complex`/specialist task. Explicit process requirements and concrete major safety verification still apply. Direct execution does not bypass required product planning.

**Continuous execution:** Do not pause between ordinary tasks merely to ask whether to continue. Stop for a decision that changes scope or acceptance, weakens security or data guarantees, changes a public API/protocol, expands permissions, requires an irreversible/destructive operation, triggers an external side effect requiring authorization, or leaves only pure guesses. Otherwise make a bounded ruling and continue.

**Bounded execution:** Resolve non-material plan defects or ambiguities from approved requirements and repository evidence. Carry only current constraints, necessary assumptions, unresolved risks, and evidence into coordination and reports. Don't create a ruling ledger or preserve decision history.

**Narration discipline:** Between tool calls, keep narration brief. Use prose for decisions, blockers, and questions rather than duplicating tool output.

## When to Use

- An approved plan or bounded task has work that benefits from isolated execution context.
- Task boundaries and file ownership are clear enough to avoid interference.
- The controller can supply goals, criteria, dependencies, interfaces, evidence expectations, and constraints without pasting session history.

For two or more independent tasks with no shared state or overlapping files, consider `dispatching-parallel-agents`. Keep dependent or shared-state work sequential. Do not delegate merely to satisfy a workflow label.

## Outcome-Oriented Process

1. Understand the goal, ideal end state, acceptance criteria, dependencies/interfaces, relevant evidence, and global constraints.
2. Scan planned file/interface overlaps, current constraints, and material risks.
3. Choose direct execution or a useful worker boundary for each task or wave.
4. After work returns, inspect the actual changes and evidence and resolve integration issues. Keep short-lived coordination in session; synchronize useful results at delivery or major phase boundaries, not every checklist update.
5. Request focused or whole-change review only when risk, uncertainty, change shape, or user instruction makes independent review useful.
6. Coordinate integrated/global verification, consolidating necessary heavy checks at task completion or important phase boundaries; report any unverified item.

The plan is guidance, not an immutable script. A worker may use a minimal evidence-based equivalent when repository reality makes a planned detail unnecessary or inferior, provided the approved goal, constraints, permissions, and acceptance criteria remain unchanged. Describe the resulting current implementation and any unresolved risk, not a deviation history. Decisions in the stop classes above return to the controller or user.

## Worker Briefs

Explain only what the worker needs to act safely toward the outcome; these are useful prompts, not required fields or an exhaustive inventory:

- the task/wave goal and ideal end state;
- acceptance criteria and useful evidence;
- relevant current state, dependencies, and interfaces;
- material scope and ownership boundaries;
- global constraints and permissions;
- current constraints, authorization boundaries, or known risks.

Workers may discover corresponding resources within the authorized scope; the brief need not name every file, revision, hash, or receipt. Discovery does not expand permissions or bypass ownership, irreversible-operation, or protocol-identity boundaries. Do not make a worker read an entire plan when a clear bounded brief is sufficient. Do not prescribe fixed report fields, a first-line status, test transcript, scenario count, commit, or reviewer approval. Ask for the resulting implementation, changed files, local verification evidence/results, and material risks or unverified coverage needed for integration.

### Recommended Executor Decision

Before dispatch, verify the profile is callable, no ownership conflict exists, dependencies are ready, and the task's security/runtime rigor fits the worker. A recommendation is evidence for this decision, not a command. Never expand a worker's permissions because a plan names a more powerful profile.

Use direct tools first. Workers may use only bounded utility leaves their effective policy permits; they do not spawn implementation, planning, coordination, Reviewer, or Oracle seats. Worker self-review is useful evidence but does not become a mandatory review receipt.

## Git Ownership and Authorization

Workers do not stage, commit, push, tag, rebase, release, or perform other Git writes unless the user specifically authorized that exact operation and the effective worker policy permits it. Normally they return changed files and evidence to the controller.

A clear user request can authorize the exact Git operation without a redundant confirmation, but its semantics do not expand:

- implement or fix does not mean commit;
- commit does not mean push, tag, rebase, or release;
- authorization for one repository, branch, range, or operation does not authorize another.

## Local Workflow Boundaries

No automatic workspace or ledger scripts, automatic cleanup, routine full review after each task or wave, or default worker Git write is permitted. Return worker reports in conversation, not workspace plan/report/evidence files unless explicitly requested as deliverables. Use session-level coordination for short-lived state without repeated stability/hash checks or completion writes before deleting disposable checklists; safe ownership cleanup and authorization remain binding. Product specs/plans describe only final product deliverables; other tasks never write to the superpowers directories.

## Plan and Integration Scan

Before work that spans tasks or waves:

- Check shared files and interfaces for incompatible assumptions.
- Check dependencies and ordering against the desired end state.
- Confirm planned evidence relates to observable acceptance criteria.
- Keep security, data-loss, protocol/API, compatibility, and irreversible-operation safeguards intact.

Resolve non-material conflicts from evidence and proceed with the resulting current constraints. Escalate when resolving a conflict would change scope, acceptance, safety, data guarantees, public interfaces/protocols, permissions, irreversible effects, or would be a pure guess.

## Batch Small Same-Shape Work

Several independent, low-judgment edits of the same kind may share one brief. State the shared outcome and material scope/ownership boundaries; workers can discover corresponding resources inside them without an exhaustive file list or per-item identity lock. Inspect actual changes against that scope. Keep separate work where judgment, dependencies, tests, or integration risk differ.

## Corrections and Changed Inputs

Continue the same worker session for a bounded correction to the same goal when the host exposes a continuation handle and its context remains valid. Otherwise start a fresh worker with the necessary correction context.

After a correction, rerun only affected checks or reviews plus any integration check whose substantive input changed. Do not restart a full review for formatting, narration, status wording, or other changes that cannot affect the reviewed outcome. Escalate rather than retry blindly after repeated no-progress attempts.

## Model Selection

Use the least costly currently available profile likely to complete the task reliably. Turn count and context handoff cost matter more than nominal token price. Scale capability to integration judgment, diff size, uncertainty, and risk; do not use a reviewer or Oracle as an implementation or architecture worker.

## Worker Results Are Evidence, Not Gates

Status labels such as `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, or `NEEDS_CONTEXT` are informational. Read the actual changed files, reasoning, evidence, and concerns. An acknowledgement, dispatch success, or label alone is not completion evidence.

Likewise, an optional or redundant child that is unavailable, times out, returns only an acknowledgement, or fails to add evidence does not block a result already proven by sufficient current evidence. Required work remains required; do not use this rule to bypass a real unresolved security, data-loss, protocol/API, compatibility, or irreversible-operation risk.

When a worker raises a concern:

- resolve correctness or scope concerns from code and requirements before relying on the result;
- provide missing context when that is the blocker;
- change model or task boundary when the work genuinely exceeds the worker;
- escalate decisions in the stop classes rather than forcing a guess.

### Waiting on Dispatched Subagents

Do not poll aggressively, sleep, or repeatedly ask for status. While you have local work — preparing the next dispatch, inspecting returned diffs, updating todos, or packaging review input — keep working. If the host exposes background completion, let it notify you. If a wait surface exists and you are genuinely idle, wait in bounded stretches rather than short loops, then reconcile outstanding children once per stretch. A continuation handle continues a child session; it is not a polling job ID.

## Verification

Choose evidence that can demonstrate the requested behavior or invariant. Depending on the change, this can include focused deterministic tests, existing regression tests, typechecks, builds, runtime probes, inspection of generated output, or protocol/security checks.

Workers run lightweight local checks for their substantive changes; the controller owns integration and consolidated global/heavy verification, not a full-suite run per small task. Apply brainstorming's material-relevance reuse rule: unrelated code, dependency, or environment changes don't invalidate passing evidence; changes affecting tested behavior or interfaces require only affected checks and explicit coverage gaps. Required safety, release, pre-commit, and user-mandated checks remain binding.

Do not impose a universal RED gate, test transcript, scenario count, or full-suite run for every task. Add or run tests where a plausible deterministic regression seam warrants them. Never weaken real safeguards or substitute an acknowledgement for evidence.

Tests protect final valid requirements, functionality, and external interfaces. Don't lock descriptive documentation, commit messages, package information, or non-contractual error/log wording through string, regex, snapshot, or parsed-content assertions. Don't test decision counterexamples or the absence of removed components. Update tests with requirements and delete tests dedicated to removed components. Uncommitted intermediate behavior needn't be preserved; committed contracts and authorization boundaries still apply.

## Completion and Integration Check

For each worker result or direct-execution wave:

- inspect the actual changed and newly created files or current diff;
- compare the result to the goal and acceptance criteria;
- evaluate the reported evidence and run additional targeted checks when needed;
- check shared interfaces and assumptions against other work;
- report current constraints, unresolved risks, and intentionally unverified items.

This is outcome verification, not a mandatory full reviewer pass after each task or wave.

## Constructing Review Requests

When independent review is useful, provide the reviewer with the goal, acceptance criteria, current diff or committed range including new files, relevant verification evidence, and global constraints. Add focused context for a known concern without pre-judging the conclusion. Do not paste accumulated session history or require a fixed packet schema, receipt, or first-line verdict.

Reviewers inspect the actual change and evidence; they should not rerun expensive checks without a reason. Treat their findings according to technical merit. Re-request only the affected review when substantive code, requirements, evidence, or constraints changed. An editorial prompt change does not stale otherwise applicable review analysis.

## When Review Is Useful

Consider focused review for a high-risk implementation concern, uncertain complex fix, meaningful cross-module integration, security/data/protocol/compatibility/release risk, or explicit user request. Consider a whole-change review before merge or delivery when the size or risk benefits from independent scrutiny.

Review is not unconditional. A proven low-risk result need not wait for an optional or redundant reviewer, and reviewer approval is not a substitute for evidence. When review is required by the user or a governing release/safety process, satisfy that requirement and resolve substantive blockers before completion.

## Handling Findings

Use the `receiving-code-review` skill. Fix validated blocking defects or missing required evidence. Group related findings into a coherent correction rather than spawning one worker per comment. Push back with code, requirements, or evidence when a finding is incorrect or would change approved intent.

After a substantive fix, rerun affected evidence and reviews. Do not rerun unaffected reviews. Preserve the approved goal and constraints; escalate feedback that would change scope, acceptance, safety/data guarantees, public APIs/protocols, permissions, or irreversible behavior.

## Prompt Templates

- `./implementer-prompt.md` — focused worker brief
- `./spec-reviewer-prompt.md` — optional narrow requirements consultation
- `./code-quality-reviewer-prompt.md` — optional narrow quality consultation

## Integration

- **writing-plans** — captures outcomes, dependencies, risks, and useful evidence when durable coordination is warranted
- **requesting-code-review** — constructs a focused review request when review is useful
- **receiving-code-review** — evaluates and acts on findings with technical rigor
