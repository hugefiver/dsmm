# Native Agent Teams

DSMM uses the Host's Agent Teams service and task tools. The native Host owns the task board, revisions, persistence, member names and task presentation. Team mode is a root-session choice; DSMM does not enable it automatically. A Host without the native service or task tools retains ordinary delegation.

## Roles and task access

The current native step determines which conditional task tools are callable. DSMM keeps the original registrations and their activation conditions.

- Writable agents may use the native `team_task_create`, `team_task_list`, `team_task_get` and `team_task_update` tools where their role, inherited filters and native task authority permit them.
- Read-only DSMM roles receive only `team_task_list` and `team_task_get`. The root assigns and closes their tasks. Giving a task to a read-only agent does not authorize a task mutation or a file write.
- The native root controls Team mode and reassignment. Task ownership, `writeScopes`, member labels and messages do not grant tools, delegate new roles, expand path access or lift depth limits.

## Working with tasks

Create tasks with the dependencies and ownership needed for the work. An unassigned, ready pending task can be claimed and completed through the native update operation. Root reassignment immediately makes the task `in_progress`; the assigned worker reads and executes it without claiming it again.

Task changes do not wake an agent or send a message. Send the task identity and assignment through native `send_message` when work should begin. Interrupting an agent does not release its task ownership. Read the board before deciding whether reassignment is needed.

Use the task's current revision as `expectedRevision` when updating through the native service, or the corresponding field exposed by the native tool schema. On `TEAM_TASK_STALE_REVISION`, reread and reconcile the current task before making another change. On `TEAM_TASK_PERSISTENCE_UNCONFIRMED`, the change may already be visible while durable storage is uncertain: reread authoritative state and do not replay the mutation automatically.

`writeScopes` describe intended work areas for coordination. They are not filesystem locks or permission grants. Native sandbox policy and DSMM's existing tool, role and permission checks still decide whether an operation may execute.

## Member lifetime

On tree-capable Hosts, messages preserve their sender and stay within the native tree. Native names and `list_agents` identify members; `wait_agent` is available when the Host exposes it. Ancestors can interrupt descendants; siblings cannot use interruption as a coordination shortcut.

Supported members can continue under the verified live root after their durable creator exits. Cold continuation uses current selected-profile content and retains captured DSMM restrictions. Generic native members retain their native model authority and do not acquire a DSMM role. Details and legacy-record limits are in [Agent presets](agent-presets.md) and [compatibility](compatibility.md).
