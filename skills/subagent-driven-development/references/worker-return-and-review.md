> DSH adapter boundary: resolve this reference from the loaded skill's directory resourceBase. It grants no tools, permissions, workflow authority, or Git authorization; the entry skill and active role remain authoritative.

# Worker Return, Correction, Verification, and Review

Read this reference only when a dispatched worker is pending or has returned, a correction is needed, completion evidence must be integrated, or independent implementation review is useful or required.

## Corrections and Changed Inputs

Continue the same worker session for a bounded correction to the same goal when the host exposes a continuation handle and its context remains valid. Otherwise start a fresh worker with the necessary correction context.

After a correction, rerun only affected checks or reviews plus any integration check whose substantive input changed. A newly identified or resolved blocker or relevant new evidence can justify another affected pass; formatting, narration, status wording, repeated doubts, or unchanged uncertainty cannot. When the same check fails consecutively for the same reason and no new diagnostic basis exists, stop blind retries, identify whether the failure belongs to the product or the harness/tool/environment, and state the unmet requirement and needed input or capability. Continue independent authorized work only when it does not depend on the blocker.

## Worker Results Are Evidence, Not Gates

Status labels such as `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, or `NEEDS_CONTEXT` are informational. Read the actual changed files, reasoning, evidence, and concerns. An acknowledgement, dispatch success, or label alone is not completion evidence.

Likewise, an optional or redundant child that is unavailable, times out, returns only an acknowledgement, or fails to add evidence does not block a result already proven by sufficient current evidence. Required work remains required; do not use this rule to bypass a real unresolved security, data-loss, protocol/API, compatibility, or irreversible-operation risk.

When a worker raises a concern:

- resolve correctness or scope concerns from code and requirements before relying on the result;
- provide missing context when that is the blocker;
- change model or task boundary when the work genuinely exceeds the worker;
- escalate decisions in the entry skill's stop classes rather than forcing a guess.

### Waiting on Dispatched Workers

Do not poll aggressively, sleep, or repeatedly ask for status. While local coordination or inspection work remains, keep working. If the host exposes background completion, let it notify you. If a wait surface exists and you are genuinely idle, wait in bounded stretches rather than short loops, then reconcile outstanding children once per stretch. A continuation handle continues a child session; it is not a polling job ID.

## Verification

Choose evidence that can demonstrate the requested behavior or invariant. Depending on the change, this can include focused deterministic tests, existing regression tests, typechecks, builds, runtime probes, inspection of generated output, or protocol/security checks.

Keep product failures separate from harness, tool, fixture, and environment failures. If the harness did not exercise the product behavior, report the evidence gap; do not change product behavior or weaken a valid check merely to obtain green output. An unresolved required failure remains incomplete even when other authorized work can proceed independently.

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

Reviewers inspect the actual change and evidence; they should not rerun expensive checks without a reason. They consider material input classes and failure conditions implied by approved behavior and local contracts without inventing new product scope. Any important behavior they cannot judge must be named with the reason and missing evidence; no fixed heading, list, or count is required.

Treat findings according to technical merit. Re-request only the affected review for a newly identified or resolved blocker, a substantive correction, or relevant new evidence or constraints. An editorial prompt change, repeated concern, or unchanged uncertainty does not stale otherwise applicable review analysis.

## When Review Is Useful

Consider focused review for a high-risk implementation concern, uncertain complex fix, meaningful cross-module integration, security/data/protocol/compatibility/release risk, or explicit user request. Consider a whole-change review before merge or delivery when the size or risk benefits from independent scrutiny.

Review is not unconditional. A proven low-risk result need not wait for an optional or redundant reviewer, and reviewer approval is not a substitute for evidence. When review is required by the user or a governing release/safety process, satisfy that requirement and resolve substantive blockers before completion.

## Handling Findings

Use the `receiving-code-review` skill. Fix validated blocking defects or missing required evidence. Group related findings into a coherent correction rather than spawning one worker per comment. Push back with code, requirements, or evidence when a finding is incorrect or would change approved intent.

After a substantive fix, rerun affected evidence and any review whose blocker or supporting evidence changed. Do not rerun unaffected reviews. Preserve the approved goal and constraints; escalate feedback that would change scope, acceptance, safety/data guarantees, public APIs/protocols, permissions, or irreversible behavior.
