# Resident root continuation across Core replacement

A root conversation keeps its native Agent, Session, history and ID when one handoff-capable DSMM Core replaces another. A session opened by 0.3.30 or earlier needs one normal Host restart to enter this lifecycle. A Core replacement never replays a pending message, tool call or approval.

## Admission and ownership

The Agent lifetime owns the execution gate. The Core lifetime owns its installed business hooks, routes, tool definitions and approvals. Remember only roots published by a participating Core and match the actual Host registry, Agent, Session and mounted preset domain. A Session ID, conversation text or historical role name cannot transfer authority. On replacement, prepare and publish a fresh root admission using the current configuration. Leave unrelated native Agents alone. Existing child captures do not transfer to the successor.

A retired owner cannot authorize new work. Keep a root closed while its old operations drain and while its new owner installs; a failure in one root must not prevent unrelated roots from continuing. Permission writes, model calls and tool execution observe this same boundary, including paths that otherwise handle ordinary native Agents.

## Routing and verification

A resident LLM runtime prepares new requests with the current Core's routing state. The actual native provider runtime retains dispatch ownership. Verify an ordinary root and a Deepwork root across distinct Core module instances with the same Host services: one new input reaches the expected model, native session identity is unchanged and new role tools work. Check that the retired owner, stale tools, outstanding approvals and the interval with no successor cannot dispatch work. Exercise the implementation through the native Agent loop with an isolated fixture, without changing a desktop profile.
