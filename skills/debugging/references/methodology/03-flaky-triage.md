> DSH adapter boundary: resolve this resource from the loaded skill's directory resourceBase. Examples are not authority: installation/download/login, private state, Git writes and destructive operations need exact explicit authorization. Use only tools and native roles actually exposed in the current catalog and allowed by the caller; otherwise use a real direct fallback or report the limitation. Translate shell examples to the active runtime.

# Flaky-test triage

Use this reference when a test is intermittent, passes in isolation, changes its failing neighbor, depends on execution order, or fails only in CI. Treat the symptom as shared-state evidence until a controlled experiment proves otherwise.

## Safety boundary

- Start with an unchanged rerun. Do not install tools, terminate another user's process, overwrite user configuration, or use a shared temp root.
- Capture relevant run evidence temporarily; list exact run-owned artifacts and cleanup actions in the temporary resource checklist. Clean only resources this run owns.
- Retry wrappers, arbitrary sleeps, quarantine, deletion, and assertion weakening are not fixes. They hide evidence and must not be used to claim resolution.
- Keep test commands and environment changes scoped to the affected test or suite. Do not turn a flaky-test investigation into a full-suite mutation.

## Three-run signature

Before forming root-cause hypotheses, record the command, exit code, failing test, duration, seed, worker count, temp root, environment differences, and the first causal error rather than a later cascade. A missing field is evidence to collect, not a reason to fill it in from memory.

1. **Unchanged rerun** — run the original command without retries, new sleeps, altered worker counts, or other changes. Record whether the same failure recurs and preserve the first causal error.
2. **Isolated case** — run the exact failing test alone with the same relevant seed, workers, environment, and run-owned temp root where possible. Passing in isolation is a classification clue, not a green result.
3. **Quiet affected scope** — run the smallest affected file, package, or suite in a unique root with unrelated watchers and concurrent local work excluded. Compare its command, duration, worker count, and environment to the failure.

If order dependence is plausible, use an optional **Seeded shuffle** only after the three runs. Record its seed, then rerun the same seed first; do not keep sampling fresh seeds until one produces the desired result.

| Classification | Controlled toggle or evidence to seek |
|---|---|
| Product race or async timing | Hold scheduling and resource ownership steady; verify that awaited completion, timers, or teardown change the outcome. |
| Order or fixture leakage | Run the predecessor and target together, reverse or reset their shared fixture, then compare against the isolated target. |
| Environment contention | Namespace the temp root, port, database, cache, container, or lock and compare the run-owned environment. |
| Resource-limit pressure | Record workers, durations, memory or file-handle signals, and constrained versus unconstrained affected-scope behavior. |

Keep multiple hypotheses open until a controlled toggle distinguishes them. An unreproduced failure is unresolved evidence, not fixed.

## Paired isolation examples

Use the example for the active shell. These are paired alternatives, not instructions to switch shells.

**Bash — unique run root and optional listener inspection**

```bash
run_root="$(mktemp -d "${TMPDIR:-/tmp}/dsmm-flaky.XXXXXX")"
TEST_TMPDIR="$run_root" pnpm test -- --test-name-pattern "affected test"

# Inspect only when ss is already installed; do not install an inspector.
if command -v ss >/dev/null 2>&1; then
  ss -ltnp
fi
```

**PowerShell — unique run root and optional listener inspection**

```powershell
$runRoot = Join-Path "$env:LOCALAPPDATA\Temp\opencode" "flaky-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $runRoot | Out-Null
$env:TEST_TMPDIR = $runRoot
pnpm test -- --test-name-pattern "affected test"

Get-NetTCPConnection -LocalPort 3000
```

Do not install a port inspector and never kill a port owner. If a listener is relevant, capture its identity and namespace the port for the run instead. Use the temporary resource checklist and remove only the unique root created by the current investigation.

## Cause-oriented repair

- Namespace run-owned temp roots, ports, databases, containers, caches, and locks so concurrent tests cannot collide.
- Restore globals and fake clocks during teardown. Await and close only resources created by the current run.
- Use per-test fixtures or explicit reset boundaries instead of relying on suite order or process lifetime.
- Add a failing-first deterministic regression that exercises the confirmed causal sequence, then make the minimal cause-oriented repair.

After two failed evidence rounds, the local workflow permits one `hard-reasoning` escalation only when the root cause is genuinely difficult. Reviewer and Oracle profiles are not debugging agents and must not be used for this triage.

If the evidence remains unresolved, report the current classification, decisive shared-state evidence, remaining evidence gaps, owned-resource cleanup, and the explicit statement that no fix is claimed. Don't require a receipt or experiment history.
