> DSH adapter boundary: resolve this resource from the loaded skill's directory resourceBase. Examples are not authority: installation/download/login, private state, Git writes and destructive operations need exact explicit authorization. Use only tools and native roles actually exposed in the current catalog and allowed by the caller; otherwise use a real direct fallback or report the limitation. Translate shell examples to the active runtime.

# Phase 4 — Hard-Reasoning Escalation

At 2 consecutive failed hypothesis rounds, stop investigating and reframe. Two evidence-backed failures establish that this is a genuinely difficult debugging problem; only at this threshold may `hard-reasoning` be used. Ordinary and first-attempt debugging must stay with direct runtime investigation, `code-search`, or `research`.

Reviewer and Oracle profiles are not debugging consultants. They are reserved for implementation acceptance and focused code-quality verification.

---

## When to invoke

| Situation | Invoke? |
|---|---|
| 1 round failed, you have new distinguishing evidence | No — run one more round with a refined hypothesis set |
| 2 rounds failed, hypotheses now feel like variations of each other | **Yes — invoke one hard-reasoning consultation** |
| 2 rounds failed, no new evidence angles left to try | **Yes — invoke one hard-reasoning consultation** |
| You've been investigating >2 hours with multiple evidence-backed failures | **Yes — invoke one hard-reasoning consultation** |
| 1 round failed but the user is watching and wants speed | No — the task has not crossed the difficulty threshold |

---

## One bounded consultation with orthogonal framings

Use one `hard-reasoning` agent to examine three distinct bug-cause categories:

- **A (obvious-but-missed)** — embarrassingly simple causes the investigator walked past.
- **B (system-boundary)** — causes living at integration seams, not in the code being read.
- **C (invariant-violation)** — assumptions load-bearing to current hypotheses that may themselves be false.

Do not fan out multiple decision agents. Add `code-search` or `research` only when a named evidence gap requires a bounded lookup.

---

## Prompt

```
Native assignment content for a permitted callable hard-reasoning role (otherwise return to stage owner):
     prompt="""
     GOAL: Reframe this genuinely difficult root-cause investigation after two failed evidence rounds.
     STOP WHEN: You provide one ranked next hypothesis set and decisive runtime queries; do not propose a fix without confirming evidence.
     EVIDENCE: <bug description, failed hypotheses, and verbatim observations with file:line/log references>

     Analyze all three frames separately:
     A. OBVIOUS-BUT-MISSED — wrong process/file/build, stale cache, typo, off-by-one, or harness mismatch.
     B. SYSTEM-BOUNDARY — SDK, middleware, transport, ABI, version, load-order, or build/runtime configuration contract.
     C. INVARIANT-VIOLATION — load-bearing assumptions that may be false.

     Return: three ranked candidate causes, the frame supporting each, and the smallest runtime query that confirms or refutes each. This is decision support only; do not edit files or dispatch other agents.
     """
```

---

## Synthesize into the next evidence round

Treat the response as hypotheses, not proof. Pull the ranked candidates and falsification queries into a new hypothesis set, then resolve them with runtime evidence.

Minimum 3, same rules as Phase 2. Aim to have hypotheses drawn from the agreement scan (likely cause) AND from the disagreement scan (so one round's evidence resolves the disagreement).

Keep the currently permitted escalation, next hypothesis set, decisive queries, and evidence gaps in conversation or disposable investigation state. Don't create a repository escalation or hypothesis history.

### Reset the counter

Reset the "consecutive failed rounds" counter to 0. Return to Phase 3 (parallel investigation) with the new set.

---

## If another 2 rounds fail after escalation

You are genuinely stuck. This is the escalation threshold.

Escalate to the user (see `05-escalate.md`) with the unresolved question, decisive observed evidence, current constraints, and missing authorization or evidence. Don't guess a fix or require a full investigation transcript.
