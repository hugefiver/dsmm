# Unified permission control

## Goal and scope

DSMM permission control has two independently configured policy lanes with a shared rule model and a consistent operator experience. The primary extension is operator-authorized, live-session approval of operations that DSH intercepts. Models can propose authorization requests but cannot grant them.

This document defines the target behavior. It does not claim that live-session native-request grants, their management UI or precise external-path enforcement are implemented. DSH remains the execution, approval and sandbox owner; the design does not require replacing or patching DSH packages.

## Two policy lanes

| Lane | Purpose | Example | Effect |
| --- | --- | --- | --- |
| Additional protection | Add DSMM checks where native DSH policy would otherwise permit an operation. | A configured Git-write guard detects a writable Git command that DSH would not ask about. | Submit an approval requirement through DSH, or deny where configured. |
| Native-request authorization | Answer a DSH approval request according to configured rules or explicit live-session grants. | DSH intercepts a command requesting a supported elevated execution mode. | Automatically answer the exact matching native request; otherwise retain native interactive approval or refusal. |

Each lane has its own enablement and policy configuration. Disabling additional protection does not enable native-request authorization; disabling automatic authorization does not disable DSH protection. Editing one lane must not silently create, copy or broaden rules in the other.

Existing `guards.gitWriteGuard` / `guards.gitWriteScope` illustrate additional protection. `permissionControl.nativeCommands` and the exact-request answerer illustrate native-request authorization. These are current integration points, not a declaration that every existing configuration field already follows the target unified model. Any schema consolidation must preserve existing configured behavior or specify an explicit migration without silent permission expansion.

An authorization in the second lane does not implicitly satisfy an independently configured ask in the first. Both lanes contribute their applicable requirements. The interface may present related requirements together, but must show what the operator's action authorizes; there must be no hidden cross-lane permission transfer.

## Shared rule model

Both lanes use the same normalized selectors, parser, matcher and scope presentation. Rule instances and policy effects remain lane-specific. Unification must not introduce separate interpretations of the same command or path in different settings pages.

The rule model distinguishes:

- **Tool:** the actual registered tool and trusted execution adapter, not merely a display name.
- **Command/subcommand:** parsed command patterns, including supported alternatives, with explicit working-directory constraints where applicable. A match does not authorize another command introduced by chaining, pipelines, substitutions or redirects.
- **Path:** a canonical exact path or directory tree, with explicit operation such as read or write. File targets require trusted operation facts and enforceable path/link boundaries; a path-like command argument or cwd is not proof of the command's effects.
- **Requested execution authority:** the native mode or scope being authorized, separately from the tool/command/path selector. `danger-full-access` is an execution authority, not a path pattern.
- **Lifetime and source:** configured policy, a one-call decision or an operator-created live-session grant; include the originating lane and visible scope.

Matching a selector alone never grants permission. The applicable lane policy, operator decision, native request and current role/tool ceilings determine the result. Unknown or unprovable scope is not a successful match.

## Native-request authorization flow

The main new capability extends the second lane:

1. Receive a DSH approval request, or accept a model proposal for a future operation. Bind an actual request to trusted tool/execution facts; proposals alone carry no execution authority.
2. Match independently configured automatic-authorization rules and active live-session grants against the exact native request, tool, command/path facts and requested execution mode.
3. When a valid rule or grant covers the request, answer through the supported native approval service. Each request receives its own native outcome; a previous `allowed-once` result is never replayed as a token for another call.
4. Otherwise use the supported interactive approval path. An operator may reject, allow the current call only, or explicitly approve a displayed scope for the current live session where that scope is supported.
5. Validate operator authority, request/session identity, cancellation and supported scope before registering a live grant. A call-associated grant requires the final native approval outcome; a proposed future grant requires a distinct explicit operator action and does not manufacture an approved native call.
6. On later matching requests, repeat native-request binding and grant validation before answering. A changed command, target path, tool registration or broader requested mode must not inherit a narrower authorization.

Existing `PermissionControl.compose()`, `answerer()` and `nativeApproval()` provide exact-invocation integration points. The extension must preserve those identity checks rather than matching only a tool name, call ID, reason string or signal.

This mechanism is DSMM policy-driven answering of native requests, not a replacement native grant store or a change to the session's standing sandbox. Configured automatic approvals and ephemeral user grants remain distinguishable in the interface and in authority checks.

## Operator and model interaction

Use a consistent experience for tool, command, subcommand and path rules across both configuration lanes and live authorization:

- Show why the operation needs approval, which lane contributed the requirement, the actual requested operation, the proposed matching scope, the execution mode and the lifetime.
- Offer **only this call**, **authorize this scope for this live session**, and **reject** where supported. One-call approval must not silently create a second-lane live grant.
- Provide a visible list of active live grants and a revoke action, separate from saved deployment rules. Explain whether an automatic decision came from configuration or a live grant.
- Let the model propose a command/subcommand pattern, tool, path scope or full-access request with a reason. The user must see and approve the actual normalized scope. Model tool arguments, generated text and stored history cannot act as operator approval or configure automatic approval on their own.
- Do not offer a path-only authorization if the backend can only execute with unrestricted filesystem access. Offer full access only as an explicitly different choice with its broader consequences disclosed.

DSH rc.2's standard approval decision is once/reject, and `conversation.approval.detail` only extends presentation. The additional live-scope choice and management require supported plugin UI/approval integration; they are not obtained merely by changing native button labels. Use native request ownership and cancellation, without a competing general execution or approval owner. No DSH package replacement is required for supported exact-request answering; unsupported native scopes remain unavailable.

## Lifetime, revocation and safety

Live grants are in-memory and bound to the current native session's live Agent and owner lifetime. They are not saved to Global, native-profile or named Profile configuration, nor restored from history. Closing the relevant owner, restarting the Host, recreating/restoring the Agent or invalidating the authorized scope expires them. A shared persisted session ID is insufficient to recover authority. Child sessions do not automatically inherit a parent's grant.

Revocation prevents future automatic answers; it cannot undo an operation already executed. An actual native manual approval remains final for its approved call and scope. Rule edits or revocation must not reinterpret that approval, broaden it or replay it for another call. Request cancellation, disposal and tool-registration changes retain their native effects.

Readonly roles, tool eligibility, current ownership, native hard refusals, `approval.policy=never`, cancellation and OS restrictions remain ceilings. Neither lane nor a live grant bypasses them. Independent asks require their own applicable authority; independent denials remain effective. Unifying rule representation does not silently change existing rule precedence.

Full-access approval must disclose writes to any OS-permitted location, not just the workspace, a command's apparent target or a temporary directory. It does not grant permission to ignore readonly or role ceilings. Exact-path/tree grants require enforcement consistently provided by native file tools and shell confinement; DSMM must not emulate that guarantee with command text matching or a private ACL system.

## Delivery boundary and acceptance

The current Host has an exact-request answerer usable for the native-request lane. Extending it with live grants and explicit operator interaction is a DSMM feature, not wholly contingent on a future native remembered-grant API. It still requires security-focused implementation and validation. General native remembered grants would reduce custom integration work; precise path writes remain dependent on a supported enforcement contract that rc.2 does not provide.

Acceptance must demonstrate:

- A DSH-permitted writable Git operation receives the configured additional DSMM check, without coupling the two configuration lanes.
- A DSH-intercepted operation is answered only by a matching configured authorization or explicitly approved live grant; unmatched requests retain native handling.
- Both lanes interpret equivalent tool/command/subcommand/path selectors consistently while retaining independent policy effects and existing precedence.
- One-call approval does not create a live grant; a live grant covers only its displayed scope, and revocation/expiry prevents future automatic answers.
- Model proposals require real operator confirmation and cannot approve themselves, silently widen scope, persist grants or transfer them to children/restored Agents.
- A request involving both lanes remains understandable and does not gain implicit authorization from the other lane.
- Narrow path authorization is not represented as full access, and unsupported scope/enforcement is shown as unavailable rather than silently broadened.
- Native never/deny/cancellation, readonly ceilings, exact execution identity and final same-call manual approval remain effective.

Behavioral tests and real Host/UI acceptance must exercise both request origins and the grant lifecycle. Document or UI string equality is not an authorization test.
