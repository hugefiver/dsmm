---
name: brainstorming
description: "Use before creative or materially ambiguous work to clarify outcomes, constraints, risks, and an appropriate implementation direction."
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

<!-- Selectively adapted from obra/superpowers/brainstorming v7.0.1.
     Triggered native final-state policy and proportional discovery.
     Authorized work follows applicable planning without redundant design approval.
     Source and maintenance contract: ../../docs/maintenance.md.
     Upstream MIT license: ./LICENSE. -->

# Brainstorming Outcomes Into Designs

Use discovery and design to remove material uncertainty before implementation. The objective is a shared understanding of the goal, constraints, acceptance criteria, interfaces, risks, and ideal end state, not completion of a prescribed ceremony.

## Conditional Artifact and Evidence Guidance

These rules apply whenever this triggered skill is loaded, but their detailed guidance is needed only when discovery will produce a durable design/spec/plan or prescribe regression evidence. Before doing either, read `./references/artifacts-and-evidence.md` from this skill's resourceBase. Conversation-only discovery need not load it. Shared workflow and role policies remain effective without injecting this skill body; packaging is not automatic skill execution or authority.

## Coordinated Verification and Evidence Reuse

For multi-task or parallel work, workers run lightweight local checks relevant to their substantive changes, not a full suite for each small task. Handoffs state what changed, local evidence/results, and material risks or unverified coverage. The orchestrator coordinates integration and global verification, consolidating necessary heavy checks at task completion or important phase boundaries and minimizing full-suite frequency.

Reuse passing evidence when it still covers the current claim and no change materially affects the tested behavior or interface. Unchanged code needs no repeat verification absent a relevant change. During long tasks, dependency/environment changes and unrelated parallel code edits may coexist with valid evidence; they don't automatically invalidate it. Assess concrete relevance: a dependency or environment change that affects tested behavior or interfaces is not unrelated. Rerun only affected or missing checks and state uncovered risks; don't treat failed, stale, or irrelevant evidence as a pass. This reduces duplication, not necessary verification: preserve safety/data/API/permission boundaries, required release checks, repository pre-commit typecheck/test/build gates, and explicit user verification requirements.

## Authorization and Intent

Start from the user's request and current project evidence:

- Identify the requested goal and ideal end state.
- Preserve stated constraints, permissions, exclusions, and acceptance criteria.
- Treat a materially clear imperative as authorization to implement that stated scope. Do not require a separate design presentation or reapproval merely because implementation follows discovery.
- Honor an explicit request for a strict process, design review, approval checkpoint, artifact, or verification step.
- Ask or obtain specific authorization when a decision changes the requested scope or acceptance, weakens security or data guarantees, changes a public API/protocol, expands permissions, triggers an irreversible/destructive action, or causes an external side effect that requires consent.

An instruction to design, investigate, implement, or fix does not authorize unrelated work. Git authorization is operation-specific: implement/fix is not commit; commit is not push, tag, rebase, or release. A clear request for an exact Git operation authorizes that operation without a redundant confirmation, but never expands to another operation, repository, branch, or release action.

## Choose Proportional Discovery

Choose and revise the path based on actual uncertainty, coordination, and risk. Path labels are planning aids, not gates, and may become lighter or heavier as evidence resolves or reveals complexity.

- **Direct/bounded:** The goal, affected flow, constraints, and acceptance are materially clear. Read enough local context to match patterns, state any consequential assumption, and proceed without a separate design approval.
- **Spike:** Feasibility or missing facts determine the path. Use the cheapest valid investigation and return a recommendation; exploratory code is throwaway unless the user authorizes implementation.
- **Architectural:** Boundaries, interfaces, dependencies, or consequential trade-offs remain unresolved. Explore enough to make those decisions explicit, then present the useful design or choices before implementation when user input is materially required.

Do not default upward merely because work is multi-file, creative, or unfamiliar. Do not default downward when concrete security, data-loss, compatibility, protocol/API, migration, release, or irreversible-operation risks require additional care.

These paths size discovery and design; they do not replace workflow planning policy. Complex implementation of product business logic or behavior defaults to `planner` → `plan-critic` → implementation even when requirements are clear and evidence is strong. Planning or criticism for that work may be skipped only for a limited, simple, low-risk, clearly bounded change, or when the user explicitly requests the skip; state the applicable condition in conversation. Non-product routine operations, docs, maintenance, and release preparation use direct execution when resolvable, otherwise a material question or useful `complex`/specialist delegation, not automatic or repeated planner/critic/review cycles. Explicit process requirements and verification for concrete major safety risks remain binding. An explicit skip never permits an unapproved security, data, API/protocol, permission, or irreversible-action decision.

## Discovery

Inspect only enough project context to resolve material questions:

- First read the context the user supplied or named, including relevant specs, plans, handoffs, files, and prior conversation, then inspect the connected project material until you can explain the relevant current behavior and affected area. Do not ask for facts that this context already answers.

- current behavior and relevant local patterns;
- affected boundaries, dependencies, and interfaces;
- constraints and acceptance evidence;
- plausible failure, rollback, compatibility, security, data, and operational risks;
- independent work that can form separate waves.

Use a clarifier or ask the user only when missing information would change the deliverable, create material rework, or cross an escalation boundary. Ask the smallest useful question in the clearest form; state what its answer would change or why the unresolved point matters. There is no required question count, option count, or multiple-choice format. If the supplied and inspected context resolves every material question, proceed without manufacturing one.

## Explore Approaches When They Matter

Present alternatives only when there is a real decision with meaningful trade-offs. Give as many viable approaches as the decision warrants, including one when the evidence supports a single clear path. Explain the recommendation using project evidence, constraints, reversibility, risk, and cost.

Do not manufacture alternatives, architecture, or refactoring to make the process appear thorough. Follow established patterns and apply YAGNI.

## Outcome-Oriented Design

Scale the design artifact to the work within the product-spec and temporary-plan boundaries above. A useful design makes the following discoverable without requiring fixed sections or order:

- goal and ideal end state;
- scope, exclusions, constraints, permissions, and acceptance criteria;
- current state and proposed approach;
- dependencies, interfaces, data/error flow, and ownership boundaries;
- material risks, rollback or safeguards where relevant;
- wave goals and useful acceptance evidence.

Organize waves by independently meaningful outcomes and dependency order. For each wave, state what becomes true and what evidence would demonstrate it. Do not require a task list, tiny sequential steps, or completion in a fixed order when work can safely proceed directly or in parallel.

## Bounded Rulings and Escalation

Resolve non-material ambiguity from the approved goal and repository evidence. Choose the smallest safe, reversible option that preserves the user's goal, constraints, permissions, and acceptance criteria.

Keep only the resulting current requirements, constraints, unresolved risks, and useful evidence in task coordination and handoffs. Don't write a decision or assumption history.

Escalate rather than guess when a choice changes scope or acceptance, weakens security or data guarantees, changes a public API/protocol, expands permissions, creates an irreversible effect, conflicts with a specific user mandate, or has no evidence-based path. Strict process is otherwise justified only by an explicit user request or concrete risk.

## Review and Approval

Self-review a material design for requirement coverage, internal consistency, interfaces, risks, and acceptance evidence. Fix clear issues directly.

Request user review or approval only when their decision is needed, they explicitly requested the checkpoint, or a governing high-risk boundary requires it. Do not require approval section-by-section, repeat review because wording changed, or restart a design loop after a non-substantive edit. If substantive inputs change, revisit only the affected decisions and evidence.

A saved spec is not mandatory for a clear bounded change. Create a product spec only for final product requirements to be delivered; other tasks stay in conversation or a task-owned temporary plan. Do not create a separate design/spec commit by default.

## Implementation Handoff

Once the goal is authorized and material uncertainty is resolved, proceed through the applicable implementation workflow without asking for a second design approval. Hand off the goal, ideal end state, constraints, acceptance criteria, dependencies/interfaces, material risks, and useful evidence. File-backed plans follow the location and final-deliverable rules above; delegated workers remain conditional on execution value.
