# State and flow

Use this reference for a screen that reads or writes through a request, depends on a precondition, restores saved state, or runs a multi-step flow. Define the states before implementation, then define what each transition keeps and clears.

## State table

Write one row for every state the changed path can reach. Put it in `DESIGN.md` beside the screen or in the change description when the project has no `DESIGN.md`.

| State and what decides it | The user sees | Next action offered | Requests that run | Must not show or run | Leaves by |
|---|---|---|---|---|---|
| Unknown: first read pending | A placeholder for the region | None | The read | “No items”, a zero count, or stale data presented as current | Read settles |
| Unknown: read failed | The load failure beside the affected region | Retry | None until retry | Empty content or an old list presented as current | Retry |
| Empty: read returned zero | What belongs here and how to add the first item | Add | None | An error or retry for the read | Add or refresh |
| Loaded: current data available | The current items or object | The primary action | None unless refreshed | A spinner or previous error | Refresh, select, or edit |
| Saving: write pending | The form with typed values and a real pending lock | Cancel only when its semantics are defined | One write | A second write or success notice | Write settles, cancellation resolves, or a deadline |
| Save failed: write rejected or failed | Typed values and the cause beside the field or object | Retry or edit | None until a new attempt | “Saved” or a cleared form | Retry, edit, or leave |

Add rows for a missing precondition, waiting on another party, a conflict, and partial success across targets when the path can reach them. A default `false`, `[]`, `0`, or `null` before the first answer means unknown, not a confirmed fact.

## State rules

- **Unknown is distinct from empty and failed.** A pending or failed read must not appear as empty, zero, signed out, or not configured. The message and next action must fit the actual cause.
- **Guard the affected action, not the whole page.** A precondition that blocks creating may still allow reading existing content.
- **One fact has one owner.** When an action settles, the header, rows, badges, counts, buttons, and notices read the same current state.
- **Keep user work through failure.** Validation and save failures preserve input and identify what needs correction.
- **A conflict leads to the existing object or status.** It is neither success nor an invitation to repeat the same write.
- **Every pending state ends.** Success, failure, or a deadline must provide a truthful result and a way forward.

## Request and target binding

- **A response belongs to its request and target.** Before applying it, confirm that the item, account, project, session, route, or other target is still current and that no newer request supersedes it. Key cached data by target.
- **Drop stale responses.** A late response for an abandoned target or superseded request must not replace current data, open a dialog, or raise an error in the new context.
- **Cancellation is not undo.** Aborting local waiting does not prove that the server rejected or reversed a write. After cancellation, timeout, or a lost response, inspect the persisted result before claiming success or failure.
- **An optimistic rollback restores only its own replaced value.** It must not overwrite a later edit or newer confirmed value.
- **One pending action produces at most one write.** Enforce the pending guard in the action handler, not only through button appearance. A rejected attempt must leave retry able to send a new request.
- **Leaving during a write needs a defined result.** On return, the flow either confirms the completed write or reports that its result is unknown or incomplete.

## Re-entry

Define where each piece of state lives: server, URL, local storage, or memory. For each entry path, state what is restored, what is deliberately discarded, and which request may run:

- reload, and quit/restart for a desktop app;
- close and reopen through the normal entry point;
- back and forward navigation;
- a cold deep link;
- reconnect after the connection or host drops;
- a second window or device when the product synchronizes state.

Memory-only state does not survive reload or restart. A control that depends on a live connection needs a reconnecting state rather than disappearing or appearing ready.

## Keep and clear

Server data, request status, selection, input, and view state change independently. Keep them separate so a refresh does not reset unrelated user work.

| Across a transition, keep unless the requirement or target change says otherwise | Observe |
|---|---|
| Selection | Selected id or selected-row state |
| Input | Every typed or drafted value |
| Focus | The active control and a sensible focus destination after removal |
| Scroll | The relevant scroller's position |
| Work area | The open panel, tab, expanded row, and position of the region being edited |

| When the corresponding state ends, clear | Required result |
|---|---|
| Old spinner or loading text | Absent after settlement, not merely covered |
| Old error | Absent after a successful retry |
| Old success notice | Absent when the next action starts |
| Old dialog or form | Closed or retained according to the transition contract; never reopened by a late response |

For a same-target refetch, keep previous data visible with a separate progress indicator. When the target changes or old data would be misleading, replace it at once. Reserve space for expected notices and results so the work area does not jump.

## Implementation review

Follow a user action through the handler, local state, request, response, and render. Inspect what start, success, rejection, and cancellation each set and clear; reverse-order responses and target checks; repeated activation and retry; effect cleanup, timers, and subscriptions; and every supported re-entry path.

A source trace can locate a cause but cannot prove rendered behavior. Use `references/visual-qa.md` to gather the corresponding user-path evidence.
