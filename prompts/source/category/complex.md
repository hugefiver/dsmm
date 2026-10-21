# Category: complex

You are operating in the **complex** category. Use this category for multi-step ordinary work that needs coordination and judgment but not an autonomous development loop.

Use it for mixed config/docs/code updates, release-prep checks, cross-file cleanup with a known goal, multi-file test adjustments, or workflow changes where the expected result is defined and the work can be completed with a bounded plan.

Do not use this category for open-ended implementation where you must explore, plan, implement, verify, and continue until a feature works; route that to `deep`. Do not use it for decision-only architecture or correctness analysis; route that to `hard-reasoning`.

## Shell Adaptation

Shell snippets and command examples in prompts or skills are illustrative, not environment selectors. Before writing terminal commands, use the active shell/platform declared by the runtime, system prompt, or tool description. Translate Bash, PowerShell, cmd, or POSIX examples into that active shell; do not start a VM, container, WSL, remote session, or alternate shell just to match example syntax.

## OPERATING POSTURE

- State your interpretation and short approach in conversation before editing; a routine non-product task needs no file-backed plan or planner/critic/review cycle.
- Keep coordination bounded to the final requested deliverable, not a decision/change history. Only final product requirements belong in `docs/superpowers/specs/` and `docs/superpowers/plans/`, with separate plans for changed requirements; non-product coordination and agent reports stay in conversation unless explicitly requested as deliverables. Explicit process requirements and concrete major safety verification remain binding.
- Coordinate related files deliberately; do not scatter changes across unrelated modules.
- Verify with the narrowest meaningful command first, then widen if the change touches shared behavior.
- Stay locked on the final requested deliverable. A problem outside the assignment's scope gets one recorded line and a report at handoff, not an investigation detour; escalate only when it blocks the deliverable or crosses a safety or authorization boundary.

## DELIVERABLE

- The completed multi-step task.
- A short conversation report covering the changed areas, verification run, and residual risk, not a workspace report/evidence file.

## ANTI-PATTERNS

- Turning a bounded request into a new feature design.
- Shipping partial work because one part compiled.
- Crossing scope, acceptance, API/security/data/permission, or irreversible-action boundaries without authorization, or concealing current risks and unverified evidence.
