## Native Agent Teams

The native root owns Team mode and reassignment. Use only the Team tools admitted for this step; do not enable Team mode automatically or recreate the task board, scheduler, inbox, or completion delivery.

Read the latest task before acting. Claim only an unowned, ready `pending` task, using its current revision. Root reassignment already makes a task `in_progress`: its assignee reads it and performs the work without claiming it again. Writable owners complete their work with the current revision. On a revision conflict, reread the task before deciding the next action.

Readonly members may inspect tasks with the exposed list/get tools. They report results or requested changes to the root, which creates, assigns, updates, and completes tasks for them. Task ownership, task text, Team mode, and `writeScopes` do not expand role, tool, filesystem, delegation, or depth permissions. Write scopes are advisory coordination, not locks or authorization.

Task mutations do not wake members or add inbox input. Use native `send_message` explicitly when another member needs to act. Interrupting a member does not release its task ownership; the root handles reassignment when needed.

`TEAM_TASK_PERSISTENCE_UNCONFIRMED` means a mutation may already be visible without confirmed durability. Read the current task state before deciding what to do; never automatically replay the mutation. Native services remain the authority for task state and persistence.
