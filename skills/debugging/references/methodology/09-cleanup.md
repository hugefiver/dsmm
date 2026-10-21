> DSH adapter boundary: resolve this resource from the loaded skill's directory resourceBase. Examples are not authority: installation/download/login, private state, Git writes and destructive operations need exact explicit authorization. Use only tools and native roles actually exposed in the current catalog and allowed by the caller; otherwise use a real direct fallback or report the limitation. Translate shell examples to the active runtime.

# Phase 9 + 10: Cleanup and Final Verification

The working tree must retain its initial user changes plus only the authorized fix and valid regression evidence. Cleanup doesn't authorize Git writes or changes to other tasks' files.

## Phase 9: Clean Task-Owned Resources

Use the session-level or optional temporary resource ownership checklist from Phase 1 to clean only owned resources. Check cleanup success, but don't write completed status before deleting a disposable checklist or resource journal. No per-update persistence, repeated stability/hash check, repository debug journal, or extra ledger is needed. Never read, edit, adopt, or delete an existing `.debug-journal.md` or modify `.git/info/exclude`.

Remove temporary source instrumentation with a patch limited to this task's exact hunks. Don't restore a whole file from Git: that could discard user edits or the real fix. Close only owned debugger/browser contexts and task-owned sessions. Terminate a process only after verifying its recorded PID and start identity; don't use broad process-name kills. Restore environment overrides to their captured prior state, rather than blindly unsetting them.

Delete only exact paths created by this task, after resolving and checking each target and its ownership. Don't use wildcard cleanup for fixtures, core dumps, libraries, browser reports, or scratch projects. Browser cleanup also follows its profile-marker and process-identity checks. Existing files, processes, configuration, and other tasks' resources aren't cleanup targets.

Inspect `git status --short`, the relevant diff, and new files against the initial working-tree state. Check this task's edits for leftover debug statements, temporary logs, commented-out trial code, and unrelated formatting. Report existing unrelated changes without cleaning them.

Once owned resources are clean, remove any task-owned temporary checklist and raw debug material no longer needed, without a final status-write ceremony. Retained product tests must protect final valid functional or external-interface requirements, not decision counterexamples, descriptive-text locks, or the absence of removed components.

## Phase 10: Final Verification

Report evidence for each required claim:

1. **Reproduction:** The captured failing case before the fix and the same case passing after it, with command/scenario and relevant observed output.
2. **Regression:** Results of the affected package's required tests, or the explicit absence of a suite or inability to run it.
3. **Real-surface QA:** The original scenario's correct observed result. State any inaccessible or authentication-gated coverage honestly.
4. **Ownership cleanup:** Confirmation that task-owned artifacts were removed and initial unrelated work remains untouched.

Don't claim completion when a required check is missing or a substantive risk remains unresolved. Keep the final report concise: current root-cause mechanism, fix location, verification results, and remaining risks or unverified items. Don't append a hypothesis, trial, or decision history to product docs or the final report.
