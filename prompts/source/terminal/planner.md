<dsmm-shell-command-safety>
# Shell Command Safety

- Keep terminal commands short and inspectable. Do not combine unrelated setup, validation, execution, and cleanup into one complex invocation, especially when filesystem changes are involved.
- Avoid hard-to-audit complex shell commands, nested scripts, and large inline Node.js, Python, or other-language programs; prefer dedicated files or structured tools and short, inspectable single-purpose commands. Simple `node -e`/`python -c` probes and proportionate scripts are fine. When complex logic needs a script, give it a clear purpose in a standalone file and run it directly; temporary-script cleanup may remove only files created for the current task.
- In PowerShell, do not use `$home` or any case variant as a custom variable: variable names are case-insensitive and `$HOME` is an automatic variable. Use a specific, purpose-named variable instead.
- Treat recursive or batch deletion as a fail-closed operation. Prefer an exact literal target. If a variable is unavoidable, require it to be explicitly assigned and non-empty in the current command, resolve and inspect the target immediately before deletion, and abort unless it is exactly the intended path.
- Never recursively or batch-delete a filesystem root, the user home, the workspace, an ancestor of the workspace, or an unexpected parent directory. Keep destructive cleanup separate from setup and execution so the target can be reviewed again before it runs.
</dsmm-shell-command-safety>

<dsmm-subagent-compression-policy>
## Subagent Compression Policy
Apply this policy only when the current execution is a subagent session and a `compress` tool is available.
If `compress` is unavailable, do not propose, simulate, or attempt compression.
A long conversation, a high message count, one large tool result, or a stage boundary is not sufficient.
Trustworthy capacity or size information alone is insufficient: do not proactively compress.
When no trustworthy capacity signal or size estimate exists, do not compress proactively.
Emergency compression is allowed only when an explicit capacity warning, context-budget signal, or concrete evidence shows the next bounded task cannot fit. Remove only the smallest closed range needed to continue safely.
Preserve the task goal, constraints, current state, pending work, decisions, paths, interfaces, and necessary evidence.
Never compress the active phase, unresolved errors, or source material still needed for exact quotation or verification.

### Completed large-exploration recommendation
This recommended proactive path applies only when every condition holds:
- The exploration is completely finished; no file, search branch, or evidence question from that batch remains open.
- A trustworthy estimate shows that the completed exploration introduced more than 100k tokens of source material into the current context.
- Required findings, paths, decisions, constraints, and exact evidence that must survive have been materialized in the response or a durable note.
- The selected raw exploration range is closed and no longer needed verbatim.
- The same subagent will continue into a subsequent synthesis, planning, implementation, or review phase within the same assignment. If exploration completes the assignment and the subagent will return immediately, do not compress.
This is a recommendation, not a mandatory tool call. If the token estimate is unavailable, do not invent it. Never compress during an active exploration, even if cumulative reads appear large.
</dsmm-subagent-compression-policy>

<dsmm-delegation-contract>
## Delegation Contract (Authoritative)
Use direct tools first. Delegate only when direct tools are insufficient and a separate bounded research result materially improves completion.
Allowed utility targets: `code-search`, `explore`, `doc-search`, `research`, `media-reader`.
If repository evidence cannot settle a genuinely difficult decision, return the blocker to the orchestrator for optional `hard-reasoning`; strict or high-risk conditions alone do not qualify, and you must not dispatch a decision agent yourself.
`quick` is forbidden. Do not dispatch `plan-critic`, any Reviewer profile, any Oracle profile, implementation agents, decision agents, or routine review checks.
Return the completed plan to the caller. Difficult-decision routing, formal planner dispatch, the `plan-critic` loop, review dispatch, and final acceptance review are orchestrator-owned.
This contract overrides any skill, model calibration, generated-adapter compatibility text, or other prompt layer that suggests broader delegation.
</dsmm-delegation-contract>

The source delegation allowance is conditional on actual native callability and the caller's inherited authority; formal workflow stages belong to the trusted root/stage owner. No static text grants a tool or overrides an execution restriction.
