---
name: avoid-ai-slop
description: Use before generating or modifying code, tests, or documentation when considering speculative abstractions, redundant defenses or fallbacks, filler explanations, or checks that do not prove required behavior; also use when the user explicitly asks to avoid AI slop.
license: MIT
---

# Avoid AI Slop

Prevent unnecessary machinery and unsupported claims in the current deliverable. This is generation-time guidance, not permission to clean unrelated code or start another workflow. Keep the active role, authorization, planning, review, safety, and verification requirements.

## Start with the actual obligation

Identify the requested behavior, its consumers, affected failure paths, and existing guarantees. Prefer the direct solution that fulfills those obligations. Extend it only for a concrete supported input, consumer, failure case, or compatibility requirement that the direct solution cannot handle.

Future flexibility alone is not a requirement. Do not add configuration switches, generic frameworks, pass-through wrappers, compatibility shims, or extra copies without a current responsibility. A helper is useful when it clarifies a real responsibility, not merely because code can be extracted.

## Judge defenses by their effect

For a proposed validation, retry, fallback, exception handler, or recovery layer, identify what it detects and how it changes rejection, recovery, or diagnosis. Validate at genuine trust boundaries; use established internal guarantees instead of repeatedly defending against impossible states.

Preserve authentication, authorization, input handling, data integrity, protocol checks, supported compatibility, accessibility, and necessary recovery. Simplicity is not permission to remove them. Keep valid safeguards even when their code is longer.

Do not turn a failed read into a successful empty result, swallow an error behind a plausible default, or retry a side effect without the required safety guarantees. Propagate failures or handle them according to the existing contract. Fix incorrect types rather than suppressing them with `as any`, `@ts-ignore`, or `@ts-expect-error`.

## Make explanations useful to their reader

Write comments for non-obvious intent, constraints, or invariants, not a narration of the next line. Documentation and reports describe the effective behavior and the facts needed to use or assess it. Omit hollow claims, repetitive summaries, defensive filler, and unrequested process histories.

Ask whether a sentence changes the reader's understanding or decision, and whether removing it would mislead. Preserve qualifications that change scope, evidence strength, attribution, uncertainty, or legal and safety obligations. Do not invent specificity, measurements, citations, causal claims, or certainty to make prose sound authoritative. Use the applicable source-fidelity guidance for sourced reports.

## Verify the obligation, not the appearance of effort

Choose checks that can expose a failure of the required behavior or external interface. Preserve meaningful safety and regression coverage. Do not add tautological assertions, snapshots of incidental prose, tests for an intermediate implementation, or tests whose only purpose is to fill a quota. Mock interactions can be valid interface checks; they do not prove product behavior they never exercise.

A new optional artifact does not automatically justify a verifier for that artifact. A check needs a concrete requirement it can falsify. Reuse passing evidence when it still covers the current behavior; supplement affected or missing coverage instead of repeating unchanged checks for reassurance.

Distinguish compilation, a harness result, and an exercised product surface. Report checks that failed, were blocked, or were not run without claiming completion from an unrelated success. Keep required checks and disclose missing evidence rather than weakening them to get green output.

## Stay within the current task

Apply this guidance before introducing the questionable structure or text. Correct the current authorized change without scanning or rewriting the rest of the repository. Read-only roles remain read-only; report unrelated findings to the task owner.

Do not launch agents, add approval gates, or create audit records because this skill was loaded. If the user explicitly requests systematic cleanup of existing AI-generated changes, use `remove-ai-slops` through the applicable workflow; this skill does not start it automatically. Once the requested outcome and necessary evidence are satisfied, stop.

## Sources and license

Adapted from [Stop That Shit's engineering skill](https://github.com/lennney/stop-that-shit/blob/main/skills/stop-that-shit/SKILL.md) and the reader-focused principles in its [STSS skill](https://github.com/lennney/stop-that-shit/blob/main/skills/stss/SKILL.md). Local comment, test, and workflow guidance follows this project's existing boundaries. No upstream Guard tooling or enforcement workflow is included.

The upstream MIT copyright and permission notice are retained in [LICENSE](./LICENSE).
