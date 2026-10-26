---
name: receiving-code-review
description: Use when receiving code review feedback, before implementing suggestions, especially if feedback seems unclear or technically questionable - requires technical rigor and verification, not performative agreement or blind implementation
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

<!-- Local fork of obra/superpowers/receiving-code-review v6.2.0.
     Evidence-based technical evaluation and affected-input follow-up review.
     Source and maintenance contract: docs/v1-maintenance.md. -->

# Code Review Reception

## Overview

Code review requires technical evaluation, not emotional performance.

**Core principle:** Verify before implementing. Preserve the approved goal and constraints. Technical correctness over social comfort.

## Evaluate the Feedback

1. Read the complete substantive feedback.
2. Restate or clarify the technical requirement when needed.
3. Verify the claim against current code, requirements, and evidence.
4. Classify it as a product defect, harness/tool/environment failure, evidence gap, optional improvement, incorrect finding, or decision that changes approved intent.
5. Apply the smallest justified correction or push back with evidence.
6. Rerun only affected verification and review surfaces.

A reviewer status, verdict label, acknowledgement, or receipt-shaped response is informational. The cited code, reasoning, and evidence determine whether action is required. Reviewer approval is not a substitute for verification.

## Clarification and Escalation

Clarify an item before implementing it when ambiguity would materially change the correction. Independent clear items may proceed while clarification is pending if doing so cannot create rework or violate shared assumptions.

Escalate instead of deciding when a proposed response changes scope or acceptance, weakens security or data guarantees, changes a public API/protocol, expands permissions, requires an irreversible action, conflicts with the user's approved direction, or would otherwise be a pure guess.

For a non-material ambiguity, choose a safe reversible interpretation from repository evidence. Keep only the resulting current constraint or unresolved verification limit, not a ruling history.

## Source-Specific Handling

### From the user

- Treat the direction as authoritative after understanding its scope.
- Ask only when ambiguity changes the deliverable or risk.
- Do not expand authorization beyond the request's semantics.
- Skip performative agreement; act or state the technical interpretation.

### From an external reviewer

Check whether the suggestion:

- is correct for this codebase and supported platforms;
- breaks committed contracts or final approved acceptance criteria;
- overlooks why the current implementation exists;
- adds unused or speculative functionality;
- conflicts with global constraints or user decisions.

Push back with code, requirements, test results, or protocol/platform evidence when it is wrong. If evidence is unavailable and the decision is material, state the gap and escalate rather than guessing.

## Product Findings vs Evidence Findings

- **Product defect:** Correct the implementation with the smallest change that preserves approved intent.
- **Harness/tool/environment failure:** Repair the owned verification surface when authorized, or report the unavailable evidence; do not change product behavior or weaken a valid check to make it pass.
- **Evidence gap:** Add or rerun the evidence needed to establish the claim; do not rewrite product behavior unless investigation reveals a real defect.
- **Optional improvement:** Record or defer it according to scope and value; it does not block a proven result.
- **Intent-changing proposal:** Return it to the decision owner rather than silently broadening scope.

Keep real security, data-loss, protocol/API, compatibility, release, and irreversible-operation safeguards intact even when a finding is inconvenient.

## Implementing Valid Findings

Group related findings when one coherent correction and evidence path covers them. Use focused deterministic tests at real regression seams, or other useful evidence such as typechecks, builds, runtime probes, and inspection where those better prove the outcome. There is no universal RED transcript, scenario count, one-review-per-finding, or full-suite requirement.

Correction workers run lightweight checks for their substantive local changes and return changes, local evidence, and material risks. The orchestrator consolidates necessary global/heavy checks at task completion or important phase boundaries. Reuse still-applicable evidence by material relevance; supplement affected or missing coverage without waiving required safety, release, pre-commit, or user checks.

Deep workers and implementers may choose a minimal evidence-based equivalent correction when it preserves the approved goal, constraints, permissions, and acceptance criteria. Report the resulting correction, current constraints, evidence, and unresolved risks. Don't preserve decision or development history.

Judge tests against final valid requirements, functionality, and external interfaces. Don't require descriptive-text locks, decision-counterexample tests, or tests asserting that deleted components are absent. Update tests when requirements change and delete tests dedicated to removed components. Uncommitted intermediate behavior needn't be preserved; existing committed contracts and API/security/data/permission authorization remain binding.

## Follow-Up Review

Rerun only the review lanes affected by a newly identified or resolved blocker, substantive changes to code, new files, requirements, acceptance criteria or constraints, or relevant new evidence. Do not rerun review for formatting, narration, labels, repeated concerns, unchanged uncertainty, or unrelated changes. Stop and escalate rather than repeating the same no-progress review; unresolved required findings remain incomplete while independent authorized work may continue only when it does not depend on them.

An optional or redundant reviewer that times out, acknowledges without analysis, or adds no evidence does not block a result already established by sufficient current evidence. A review explicitly required by the user or governing process still must be completed, and substantive unresolved high-impact risks remain blockers.

## Git Boundary

Implementing a review fix does not authorize a commit. A commit request does not authorize push, tag, rebase, or release. A clear user request can authorize its exact Git operation without a redundant confirmation, but permissions never expand to another operation or repository.

## Communication

Avoid performative agreement such as "You're absolutely right" or "Great point." Prefer:

- `Fixed <specific issue> in <location>; <evidence>.`
- `Verified the finding against <source>; the minimal correction is <change>.`
- `This would conflict with <requirement/evidence>; I recommend no change because <reason>.`
- `I cannot verify <claim> without <missing evidence>; this is material because <impact>.`

If earlier pushback was wrong, correct it factually and proceed without a long apology.

## Common Mistakes

| Mistake | Better response |
|---|---|
| Performative agreement | State the technical interpretation or action |
| Blind implementation | Verify against current code and requirements |
| Treating a label as proof | Evaluate cited evidence and actual changes |
| Broadening scope | Preserve the approved goal and constraints |
| Repeating every review | Rerun only substantively affected review |
| Guessing through material risk | Escalate the decision |
| Treating optional review as a gate | Rely on sufficient current evidence unless review is required |
