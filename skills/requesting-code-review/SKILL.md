---
name: requesting-code-review
description: Use when an implemented change benefits from independent review before delivery or merge
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

<!-- Selectively adapted from obra/superpowers/requesting-code-review v7.0.1.
     Risk/evidence-driven implementation review of current changes and contracts.
     Reviewers don't spawn additional review seats.
     Source and maintenance contract: ../../docs/maintenance.md.
     Upstream MIT license: ./LICENSE. -->

# Requesting Code Review

Request independent code review when it provides useful evidence about an implemented change. Give the reviewer the current work product, requirements, constraints, and evidence, not a decision history or session transcript.

**Core principle:** Review current implemented code against the approved outcome. Reviewer and Oracle profiles are not research, ideation, architecture-design, root-cause debugging, plan review, or implementation workers.

## When Review Is Useful

Consider review when one or more applies:

- The change is complex, cross-module, difficult to inspect, or carries meaningful integration risk.
- Security, data loss, performance, compatibility, protocol/API, migration, release, or irreversible behavior deserves independent scrutiny.
- Local verification leaves material uncertainty about a complex fix.
- The user or a governing project/release process requires review.
- A focused concern would benefit from a second model perspective.

A small, low-risk result with sufficient current evidence does not require review merely as ceremony. Reviewer approval is not unconditional, and an optional or redundant reviewer does not become a completion gate.

## Construct the Review Request

Provide the reviewer, in whatever order is clearest:

- the goal and ideal end state;
- acceptance criteria;
- the current working-tree diff or committed range, including newly created files;
- relevant verification evidence and any intentionally unverified item;
- current global constraints and permissions;
- focused dependency/interface or risk context needed to evaluate the change.

Use the actual current diff or range rather than a prose-only summary. If output is large or sensitive, provide a safe reviewable artifact or focused slices plus a complete file manifest, without omitting changes material to the criteria.

Do not require a fixed packet schema, first-line verdict, receipt, or transcript. Do not paste accumulated conversation history. Do not tell the reviewer what conclusion to reach or add open-ended directions unrelated to the change.

The reviewer evaluates supplied evidence by material relevance and requests missing or affected coverage, not blanket reruns for unrelated code, dependency, or environment changes. The orchestrator coordinates consolidated global/heavy checks; reviewers do not duplicate them or dispatch other reviewers, workers, or evidence-gathering subagents. Required safety, release, pre-commit, and user checks remain binding.

The approved requirements define the outcome but may not enumerate every valid input class, environment, or failure condition. Review reasonable behavior implied by that outcome and the surrounding committed contracts when a concrete user impact or regression risk supports it; specification silence is not permission to break expected behavior. This does not authorize new features, preferences, or speculative scope. If an important behavior was considered but cannot be judged from the supplied change and evidence, name it, explain why it remains unjudged, and identify the missing evidence. No fixed heading, list, or item count is required.

## Reviewer Selection

Select only the lanes that add useful independent evidence. Available profiles do not cause automatic fan-out.

- `reviewer` is the primary-model or primary-lane self-review profile.
- Oracle roles are cross-check choices in order: dsmm-oracle, then dsmm-oracle-2nd only when enabled, permitted and useful. Verify different actual native routes before claiming external-model independence; this inventory supplies no later slots.
- Later Oracle slots indicate selection order, not greater capability.
- Keep one canonical native role identity. Omitted/normal preserves its default route; low/high/max can be selected only when listed in the actual target's configured roleRouting levels and exposed schema. Levels are complete routes or exact supported effort-only choices, never suffix tools or guaranteed model effort. Arbitrary route overrides need deployment opt-in, exposed parameters and exact preflight. All levels retain review rigor and authority ceilings.
- Explicit user model configuration and effective routing policy remain authoritative.

Typical choices:

- Focused, moderate-risk review: one suitable Reviewer or Oracle lane.
- Complex or high-impact change: primary review plus an intentionally chosen independent cross-check when the extra evidence is worth its cost.
- Additional lanes: only for an explicit evidence need, not because profiles happen to exist.

Review roles inspect implementation; they do not approve plans or decide unapproved product scope.

Review against final valid requirements and committed contracts, not uncommitted intermediate behavior. Documents, code/comments, tests, and commit messages state only the concise final design and behavior. Tests must protect functionality and external interfaces, not lock descriptive documentation, commit messages, package information, or non-contractual error/log wording through strings, regex, snapshots, or parsed content. Don't require decision-counterexample or removed-component absence tests. Changed requirements update tests; removed components lose their dedicated tests. API, security, data, permission, and irreversible-operation authorization still applies.

## Interpret the Result

Read the reviewer's analysis, cited code, and evidence. A status label, acknowledgement, dispatch success, or unsupported approval/rejection is informational rather than proof.

- Fix validated Critical or Important product defects before relying on the result.
- Supply missing required evidence when the implementation may be sound but proof is insufficient.
- Record or defer Minor suggestions according to scope and value.
- Push back with requirements, code, or evidence when a finding is wrong.
- Preserve real security, data-loss, protocol/API, compatibility, release, and irreversible-operation safeguards.

An optional or redundant review child that is unavailable, times out, or returns no substantive analysis does not block a result already established by sufficient evidence. This does not waive a review explicitly required by the user or governing process, nor a real unresolved high-impact risk.

## Rerunning Review

Rerun only reviews affected by a newly identified or resolved blocker, substantive changes to code, new files, requirements, acceptance criteria or constraints, or relevant new evidence. Do not rerun because formatting, narration, status wording, repeated doubts, unchanged uncertainty, or unrelated files changed. A validated unresolved blocker still prevents dependent completion; repeated review does not clear it.

When a substantive fix changes the reviewed area, send the updated current diff or range and affected evidence. Reuse a continuation only while it remains the same review objective and context is reliable; otherwise start a fresh focused review.

## Git Boundary

Review does not require a commit. A working-tree diff plus new files is valid review input. Do not stage, commit, push, tag, rebase, or release merely to manufacture a review boundary.

Git writes require authorization for the specific operation. A clear user request can authorize that exact operation without re-asking, but implement/fix does not mean commit, and commit does not mean push, tag, rebase, or release. Authorization never expands to a different operation or repository.

See template at: `./code-reviewer.md`
