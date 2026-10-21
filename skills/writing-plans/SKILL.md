---
name: writing-plans
description: Use before complex product behavior implementation, or when an explicit planning request or concrete major risk requires a plan; not for routine non-product multi-step work
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

<!-- Local fork of obra/superpowers/writing-plans v6.3.0.
     Outcome-oriented final product plans; temporary coordination for other work.
     Complex implementation receives orchestrator-owned blocker-focused criticism.
     Source and maintenance contract: docs/v1-maintenance.md. -->

# Writing Plans

## Overview

Produce an implementation plan that lets a capable engineer reach the approved outcome without rediscovering important context. A native read-only planner returns complete Markdown; an authorized coordinator writes any required artifact within its own permissions. Capture the goal, ideal end state, dependencies, interfaces, risks, constraints, and evidence that would demonstrate success. Prefer useful decision support over procedural ceremony.

Assume the engineer is skilled but unfamiliar with this codebase and problem domain. Explain local conventions or non-obvious constraints that materially affect the work; do not prescribe details that repository evidence leaves safely open.

**Product plan location:** `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`, only for final product requirements to be delivered. The same restriction applies to `docs/superpowers/specs/`. Each document describes its final deliverable; changed requirements use separate plans, not appended development or decision history. Other tasks use conversation-level coordination or a task-owned temporary plan, never these directories.

## When to Write a File-Backed Plan

Do not write a plan merely because work has multiple steps. Use a durable plan for complex implementation of product business logic or behavior, or when an explicit planning request or concrete major risk requires one. Non-product routine operations, docs, maintenance, and release preparation stay in conversation: resolve them directly, ask for material missing input, or use a useful `complex`/specialist worker without default planner/critic/review cycles. Dependencies or multiple files alone do not trigger a file-backed plan.

For complex product implementation, skip the planner/critic sequence only when the change is limited, simple, low risk, and clearly bounded, or when the user explicitly requests the skip. State the applicable condition in conversation. Clear requirements, multiple familiar files, strong model capability, or sufficient evidence do not exempt that work. A user-requested skip does not authorize changes to security/data guarantees, public APIs/protocols, permissions, or irreversible behavior. Planning complexity doesn't expand the product-plan directory's purpose.

## Scope and Discovery

Before decomposing work:

- Read the approved design or requirements and the relevant repository evidence.
- Describe the current state and the ideal end state.
- Identify dependencies, interfaces, ownership boundaries, and ordering constraints.
- Surface material risks: security, data loss, compatibility, protocols/APIs, irreversible operations, and difficult rollback.
- Check external constraints such as budget, mandated/prohibited stack, scale, privacy, compliance, accessibility, and platform requirements. Do not invent constraints.

If the work contains independent subsystems, split it into independently valuable plans or waves. If a material choice would alter scope, acceptance, safety, data, a public API/protocol, permissions, or an irreversible action, return it for approval rather than guessing.

For a non-material open choice, choose a safe reversible default from evidence. Express only the resulting current constraint or unresolved risk needed for execution, not the choice history.

## Plan Shape

Use the structure that best explains the work. A useful plan normally makes these discoverable, but does not require fixed headings or field order:

- Approved goal and ideal end state
- Source requirements/design and global constraints
- Relevant current state
- Dependencies and interfaces, including what each unit consumes and produces
- Current risks, necessary assumptions, and authorization boundaries
- Waves or tasks with clear outcome boundaries
- Useful acceptance evidence for each wave and for the integrated result

Describe the concise final requirements, design, and behavior. Update intermediate text directly; don't retain development history, rejected alternatives, or decision counterexamples. Include commands, code sketches, file paths, or signatures when they prevent ambiguity; omit them when repository patterns and acceptance criteria already make the implementation obvious.

## Waves and Tasks

Organize work around outcomes and dependency order.

For each wave, state:

- the wave goal and observable end state;
- the tasks or changes that produce it;
- dependencies and interfaces that constrain execution;
- likely files or areas, when known;
- material risks or decisions;
- useful acceptance evidence showing the wave achieved its goal.

A task should be cohesive enough to produce meaningful progress and small enough to reason about and verify. Combine setup, types, implementation, docs, and validation when they only have value together. Split tasks when they can be implemented or rejected independently, have different ownership, or unlock parallel work.

Plans need not prescribe one executor action every 2-5 minutes. They also need not mandate a failing-test transcript, scenario count, per-task full review, or commit. Use deterministic tests at real regression-prone seams; use typechecks, builds, focused inspection, runtime probes, or other evidence when those better demonstrate the outcome. Keep real security, data-loss, protocol, compatibility, and irreversible-operation safeguards explicit.

Separate lightweight worker checks for substantive local changes from orchestrator-owned integration/global verification. Consolidate necessary heavy checks at task completion or important phase boundaries, not per small task; plan affected or missing evidence under brainstorming's material-relevance reuse rule without waiving required safety, release, pre-commit, or user checks.

## Executor Flexibility

The plan defines the approved goal, constraints, permissions, and acceptance criteria. It may recommend an approach, task boundary, executor profile, or evidence path without freezing incidental mechanics.

Deep workers and implementers may choose a minimal evidence-based equivalent when repository reality makes a planned detail unnecessary or inferior, provided they do not change the approved goal, constraints, permissions, or acceptance criteria. Handoffs describe the resulting implementation, current constraints, unresolved risks, and evidence, not a deviation or ruling log.

They escalate instead of choosing when the decision changes scope or acceptance, weakens safety or data guarantees, changes a public API/protocol, expands permissions, introduces an irreversible action, or would otherwise be a pure guess.

Executor recommendations are hints, not dispatch commands. The orchestrator selects a currently callable profile based on actual complexity and policy. Direct execution describes who performs implementation after applicable planning; it is not a way to skip the complex product-implementation planner/critic sequence.

## Git Boundaries

Git commits are the compatibility boundary. Uncommitted intermediate behavior may change incompatibly to satisfy final requirements without transition shims or tests preserving it. Existing committed contracts remain binding even in files with uncommitted edits; API, security, data, permission, and irreversible-operation changes still need their applicable authorization.

Do not include routine commit steps or a default separate spec/plan commit. Git writes require authorization for the specific operation. A clear user request can authorize that exact operation without a second confirmation, but authorization never expands beyond its semantics:

- implement or fix does not mean commit;
- commit does not mean push, tag, rebase, or release;
- authorization for one repository, branch, range, or operation does not authorize another.

## Self-Review

Review the completed plan against its source:

1. **Outcome coverage:** Does the ideal end state satisfy every approved requirement?
2. **Dependency consistency:** Do ordering, interfaces, files, and ownership assumptions agree?
3. **Evidence quality:** Would the proposed evidence demonstrate the behavior or invariant that matters?
4. **Risk discipline:** Are material security, data, compatibility, protocol, and irreversible risks handled without speculative scope?
5. **Executability:** Can an engineer act without placeholders or pure guesses while retaining discretion over incidental mechanics?

Fix issues inline. Do not require a second review simply because wording or formatting changed.

Tests cover valid requirements, functionality, and external interfaces, not descriptive-text locks or decision counterexamples. Don't lock documentation, commit messages, package information, or non-contractual error/log wording through strings, regex, snapshots, or parsed content. Changed requirements update their tests; removed components lose their dedicated tests, with no replacement absence tests. Keep valid negative safety, protocol, and input-handling tests.

## Blocker-Focused Plan Review

For complex implementation of product business logic or behavior, return the completed plan to the orchestrator for `plan-critic` review before implementation. The orchestrator owns dispatch; the planner never invokes the critic. Non-product work receives criticism only when explicitly required or warranted by a concrete major risk, not merely because a plan exists. For a valid skip, state the reason instead. Give the critic the goal, acceptance criteria, current plan, source requirements, relevant evidence, and global constraints. No fixed field order, first-line verdict, receipt, hash, or repeated approval ritual is required.

Treat acknowledgements and status labels as informational, not evidence. Judge the returned analysis and cited evidence. Correct a substantive blocker, rebut it with concrete evidence, or escalate it for clarification before implementation. Non-blocking improvements do not hold implementation, and an unavailable, timed-out, or merely acknowledging critic does not manufacture approval or erase an unresolved blocker.

If review finds a substantive issue, update the plan and rerun only the affected review when the review input changed materially. Formatting, narration, status wording, or other non-substantive edits do not stale a sound review. Do not impose a fixed iteration count or continue an open-ended loop; escalate when a blocker cannot be resolved from evidence.

## Execution Handoff

Hand off the approved outcome, current reviewed plan or applicable narrow-skip condition, dependencies/interfaces, relevant evidence, global constraints, and unresolved risks. Use subagent-driven development or parallel dispatch only when delegation materially helps; otherwise implement directly through the appropriate workflow.
