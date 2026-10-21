---
name: dispatching-parallel-agents
description: Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies
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

<!-- Local fork of obra/superpowers/dispatching-parallel-agents v6.2.0.
     Independent file/resource ownership and outcome-oriented evidence integration.
     Source and maintenance contract: docs/v1-maintenance.md. -->

# Dispatching Parallel Agents

## Overview

Parallelize independent work only when isolated workers can make useful progress without sharing mutable state, editing overlapping files, or depending on one another's results.

**Core principle:** Parallelize independent outcome domains, then integrate against the shared goal and constraints.

Delegation is optional. If direct execution is smaller than preparing and reconciling worker briefs, do the work directly. If tasks share a root cause or interface decision, investigate or sequence them together.

## Independence Check

Parallel work is appropriate when:

- there are at least two independently understandable goals;
- file/resource ownership does not overlap;
- no task consumes an output another task must first produce;
- workers do not mutate the same external service, environment, or test fixture;
- each result can be evaluated with useful evidence before integration.

Do not parallelize related failures, exploratory debugging with an unknown shared cause, coupled architecture decisions, or work whose safety depends on global ordering.

## Create Focused Worker Briefs

Explain enough for each worker to act safely; these are useful prompts, not required fields or an exhaustive resource inventory:

- its goal and ideal end state;
- acceptance criteria and useful evidence;
- current context, dependencies, and interfaces;
- material exclusive ownership or scope boundaries;
- global constraints and permissions;
- current constraints, authorization boundaries, or material risks.

Workers may discover corresponding resources inside their authorized domain; don't require exhaustive file lists or per-item revision/hash/receipt locks. Discovery never expands permissions or shared-state ownership. Keep actual safety, irreversible-operation, and protocol/integrity identities explicit when needed. Do not paste session history or require a fixed response format. Ask for actual changed and new files, local evidence/results, current constraints, and material risks or unverified coverage in conversation, not a ruling log or workspace report. A status label or acknowledgement is informational, not evidence.

Workers may choose minimal evidence-based equivalent changes when repository reality supports them, provided the approved goal, constraints, permissions, and acceptance criteria do not change. Their reports describe final outcomes, constraints, evidence, and unresolved risks, not deviations or decision histories. They escalate changes to scope/acceptance, security or data guarantees, public APIs/protocols, permissions, irreversible actions, or decisions that would be pure guesses.

## Dispatch Concurrently

Use the host's currently callable parallel-dispatch mechanism. Submit calls together only when its schema supports concurrency; otherwise do not imply that sequential calls run in parallel.

Before dispatch, verify ownership boundaries and side-effect isolation. Do not allow workers to expand their own permissions or spawn peer implementation, planning, coordination, Reviewer, or Oracle seats.

## Reconcile and Integrate

Workers run lightweight local checks for their substantive changes, not full suites per small task. The parent coordinates integration and global verification, consolidating necessary heavy checks at task completion or important phase boundaries. Reuse evidence by material relevance under brainstorming: unrelated parallel code, dependency, or environment changes don't stale it; rerun affected or missing checks and report uncovered risks. Required safety, release, pre-commit, and user checks remain binding.

As workers return:

- inspect each result's actual diff and newly created files;
- compare it to that worker's goal and acceptance criteria;
- evaluate or run useful targeted evidence;
- check cross-result interfaces, assumptions, and conflicts;
- carry forward current integration constraints and unresolved risks;
- verify the combined result against the overall ideal end state.

This is an integration check, not a mandatory full review per worker or wave. Request focused or whole-change review only when risk, uncertainty, user instruction, or a governing process makes it useful.

An optional or redundant child that times out, returns only an acknowledgement, or adds no evidence does not block a result already proven by sufficient evidence. Required tasks and real security, data-loss, compatibility, protocol/API, or irreversible-operation risks remain blockers until resolved or explicitly decided.

## Corrections and Review

When a result needs a bounded correction, continue the same worker session if its context is valid; otherwise issue a fresh focused brief. Rerun only evidence or reviews affected by substantive changes. Formatting, narration, status wording, or unrelated edits do not require a new review.

Do not impose a universal RED gate, test transcript, scenario count, full-suite run, per-task reviewer, or commit. Select evidence proportionate to the plausible regression and integration risk.

## Git Boundary

Parallel workers do not perform Git writes unless the user specifically authorizes the exact operation and effective policy permits it. A clear request authorizes only its stated operation: implement/fix is not commit, and commit is not push, tag, rebase, or release. Authorization does not expand across repositories or operations.

## Common Mistakes

- **Too broad:** one worker owns several unrelated domains.
- **False independence:** workers touch the same files, interface, fixture, or external state.
- **Vague outcome:** the brief says "fix it" without criteria or useful evidence.
- **No constraints:** a worker can accidentally broaden behavior or permissions.
- **Ceremonial fan-out:** workers or reviewers are dispatched only to satisfy a count.
- **Summary-only integration:** the parent trusts claims without inspecting changes and evidence.
- **Guessing through risk:** a worker silently decides scope, safety, data, protocol/API, permission, or irreversible behavior.
