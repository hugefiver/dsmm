> DSH adapter boundary: resolve this resource from the loaded skill's directory resourceBase. Examples are not authority: installation/download/login, private state, Git writes and destructive operations need exact explicit authorization. Use only tools and native roles actually exposed in the current catalog and allowed by the caller; otherwise use a real direct fallback or report the limitation. Translate shell examples to the active runtime.

# Phase 6 + 7 — Root Cause Confirmation & Reproduction-Locked Fix

A cause is not "confirmed" until you can toggle the bug by toggling the cause. Every other level of evidence is correlation, and correlation-driven fixes ship bugs.

---

## Phase 6 — Root Cause Confirmation

You are allowed to call the cause "confirmed" only when ALL THREE of these hold:

### 1. Captured runtime value matches the hypothesis exactly

Not "the value looks consistent with" — the value is exactly the value the hypothesis predicted. If your hypothesis was "baseUrl is api.anthropic.com despite ANTHROPIC_BASE_URL being set to a proxy", the captured value is literally `"https://api.anthropic.com"` in the debugger at the moment of the HTTP call.

### 2. Reproducible

Running the repro a second time yields the same observation. Flaky repros mean you haven't isolated the cause; you've isolated a symptom that sometimes appears when the cause does. Keep investigating.

### 3. Toggle proof (the one most skipped)

**Changing the value** (via debugger assignment, env override, or a speculative one-line patch) **makes the bug disappear — and reverting brings the bug back**.

If you can't toggle the bug by toggling the suspected cause, what you have is a correlation, not a mechanism. A correlation is a strong hypothesis, not a confirmed cause.

Examples of a valid toggle proof:

| Suspected cause | Toggle |
|---|---|
| Env var overrides library default, and the override is wrong | Unset the env var → bug goes away. Reset it → bug comes back. |
| Async task is not awaited | Add `await` → bug goes away. Remove `await` → bug comes back. |
| Third-party SDK uses hardcoded URL | Monkey-patch SDK to use env URL → bug goes away. Unpatch → bug comes back. |
| Race condition on shared state | Add a mutex → bug goes away under load. Remove mutex → bug comes back under load. |

If you can't construct a toggle proof, you haven't confirmed the cause. Run one more round.

### Capture current mechanism and proof in temporary evidence

```markdown
## Root cause (confirmed <ISO timestamp>)
- Mechanism: <one paragraph, causal not correlational — the chain from cause to observable symptom>
- Evidence: <file:line of captured value | path to saved repro | address + register state>
- Toggle proof: "With <change X>, repro produces <good>. Reverting <change X>, repro produces <bad>."
- Fix scope: <files and approximate line count>
```

The "mechanism" field is the acid test. If you can't write the causal chain from cause to observable symptom as one paragraph, you don't yet understand the bug well enough to fix it.

---

## Phase 7 — Reproduction-Locked Fix

Red reproduction, green same case, refactor. No shortcuts.

### 1. Red — the reproduction as a test

Capture a case that fails *specifically because of this bug*. Where the repository keeps tests for this behavior, keep that case as a regression test; otherwise capture a before-fix run and its failure output. Requirements:

- **For a test, its name reads like a bug report.** `test_refinement_turn_returns_empty_content_when_anthropic_returns_401` is good. `test_bug_fix` is not.
- **Failure output clearly shows what the bug looks like.** If someone reads only the failure output, they understand what's broken.
- **Minimum infrastructure.** Don't spin up the whole server if a smaller reproducible run captures the mechanism.

Run the test or scenario. Confirm it fails before the fix. Capture the failure output in conversation or task-owned temporary evidence:

```markdown
### Red phase (<ISO timestamp>)
Reproduction: <test path>::<name> or <scenario and inputs>
Command: <exact invocation>
Output:
```
<verbatim failure output>
```
Confirms: the bug is reproducible in the test harness or captured runtime scenario.
```

### 2. Green — minimum change

Make the same case pass with the **smallest change that fully fixes the observed mechanism**.

If the diff is larger than ~30 lines and you aren't refactoring, something is wrong — either you're fixing more than the bug, or the root cause was deeper than you confirmed. Back to Phase 6.

Signs you're over-fixing:
- Adding "just in case" null checks or try/except around other code
- Refactoring adjacent functions because "while I'm here"
- Adding new configuration options the bug didn't require
- Introducing new abstractions to "make this cleaner"

Resist all of these. Fix the bug. Note the surrounding issues for follow-up. Move on.

### 3. Refactor — ONLY AFTER GREEN

Only cleanup directly related to the fix. Do not re-architect.

If the code around the fix has an unresolved concern, report its current impact to the user; don't expand scope or create a repository follow-up journal.

### 4. Regression — full suite green

Run the full test suite for the affected package when present (not just the targeted test, if any). Existing tests must still pass.

If they don't, your "fix" broke something else. Back to Phase 6 with the new failure as evidence — usually it means the mechanism you thought you fixed was load-bearing for some other code path you didn't know about, and the "broken" test is actually pointing at a better understanding of the system.

### 5. Close the observability gap

If diagnosis burned extra rounds *because state was invisible* — no log line told you which branch ran, what the value was, whether the fallback engaged — that invisibility is a defect adjacent to the bug, and this is the one moment where adding a log line is NOT "just in case": this session is the evidence that the line earns its place. Ship the fix WITH that line, written to the standard of `references/logging.md` — level chosen by consumer, placed at the decision point, data in fields not interpolation, through the project's designated logger. If the project deliberately does not log, respect that and skip this step.

Every temporary `print` / `dbg!` / `console.log` added during diagnosis belongs in the task-owned resource checklist and is removed in Phase 9. A line with a current ongoing consumer may be part of the authorized fix; a line used only for diagnosis is temporary instrumentation.

### Capture current verification evidence

```markdown
### Green phase (<ISO timestamp>)
Fix: <file:line> — <two-line description of the change>
Reproduction: <test path>::<name> or <scenario> now passes
Output: <verbatim passing output for the same case>
Full suite: <N tests, <M failures — should be 0> (or <none exists>)
```

---

## The red-green discipline summary

No captured failure → no proof the fix addresses the reported bug. Only proof it doesn't break tests that already existed. Keep the reproduction as a test where the repository keeps tests for this behavior; otherwise the captured before/after run is the proof.

Where tests are kept, verify that the same valid regression case fails without the fix and passes with it. Keep before/after outputs in task-owned temporary evidence or conversation, not a repository journal. Tests protect final valid functionality and external interfaces, not descriptive wording, decision counterexamples, or removed-component absence. Update tests for changed requirements and delete tests dedicated to removed components; committed contracts and authorization remain binding.
