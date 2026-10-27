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

<!-- Selectively adapted from obra/superpowers/subagent-driven-development v7.0.1.
     Optional delegation after applicable planning; current outcomes and evidence.
     Worker permissions, ownership, and host continuation remain bounded.
     Source and maintenance contract: ../../docs/maintenance.md.
     Upstream MIT license: ./LICENSE. -->

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

## Model Selection

Use the least costly currently available profile likely to complete the task reliably. Turn count and context handoff cost matter more than nominal token price. Scale capability to integration judgment, diff size, uncertainty, and risk; do not use a reviewer or Oracle as an implementation or architecture worker.

## Returns, Corrections, Verification, and Review

Before waiting on a worker, correcting returned work, evaluating completion evidence, constructing an independent review request, or handling findings, read `./references/worker-return-and-review.md` from this skill's resourceBase. That reference contains the conditional operating details; this entry remains authoritative for permission, ownership, workflow, and escalation boundaries.

Worker labels and acknowledgements are not evidence. Inspect actual changes and current evidence against the goal, interfaces, and acceptance criteria. Stop blind retries when the same failure recurs without a new diagnostic basis; distinguish product defects from harness/tool/environment gaps, keep dependent work incomplete, and continue only independent authorized work. Escalate rather than guess when a correction or finding would change scope or acceptance, weaken security or data guarantees, change a public API/protocol, expand permissions, require an irreversible action, or cross another stop class above.

Independent review is conditional on concrete value or an explicit requirement, never an automatic per-task gate. The orchestrator owns review dispatch and integration/global verification. Do not introduce a ledger, fixed packet or report format, scenario quota, universal RED/TDD gate, nested reviewer/controller, or Git write.

## Prompt Templates

- `./implementer-prompt.md` — focused worker brief
- `./spec-reviewer-prompt.md` — optional narrow requirements consultation
- `./code-quality-reviewer-prompt.md` — optional narrow quality consultation

## Integration

- **writing-plans** — captures outcomes, dependencies, risks, and useful evidence when durable coordination is warranted
- **requesting-code-review** — constructs a focused review request when review is useful
- **receiving-code-review** — evaluates and acts on findings with technical rigor
