# Native permissions

DSMM 0.3.10 targets exactly DSH `0.2.1-rc.2`. DSH owns approval; DSMM composes policy into the native tool pipeline without a second approval queue, UI, TTL or session permit memory.

## Full access and approval

Full access means actual native effective standing `danger-full-access`, not a model argument, a requested escalation or a configured `permissionControl.nativeCommands` target. With that standing authority, DSMM doesn't add an ask, downgrade the sandbox, demand a path permit or refuse an unknown operation because classification facts are missing. The only DSMM restriction is a deterministically matched existing explicit deny blacklist, expressed as a native pre-approval decision. There's no additional inferred high-risk list.

A captured read-only child or a live, composed DSMM read-only preset has an explicit blacklist covering `write`, `edit`, `bash` and `pwsh`. Standing Full access must not bypass that ceiling; useful native reads remain available. Missing ordinary DSMM policy or classification facts do not by themselves establish a read-only role.

Actual DSH manual approval is final for the same call and approved scope. Older DSMM rules, a changed permission revision or epoch, and DSMM internal gates don't veto it afterward. A pending native approval isn't canceled merely because a permission source changes.

A native once grant applies only to its actual call and scope. It doesn't change standing session permissions, authorize later calls or turn a narrower approval into full access. Model-supplied arguments aren't approval; a matching simple allowlist entry selects an automatic answer for the current native request, not a reusable grant. Native policy `never` refuses before the rc2 answerer and cannot be overridden by it. Caller/native cancellation remains effective, and the original tool or OS can still fail. Permission to execute isn't a command-success guarantee.

## Settings and synchronization

`permissionControl.enabled` defaults true independently of Deepwork and is captured at cold startup. Saving a different value reports restart-required; it neither hot-mounts an executor nor changes the admitted toggle, even for new roots. Turning it off doesn't disable native permissions or other independent tool restrictions.

Global and native-profile layers may configure permission settings; named/session overlays can't. Dynamic `permissionControl.outsideReads`, `permissionControl.webSearch`, `permissionControl.webFetch`, `permissionControl.rules` and `permissionControl.nativeCommands` require runtime policy synchronization, not a restart. A configured value isn't proof of mounting or synchronization. Outside-read and web controls cover their native tool surfaces, not every filesystem or network operation inside a shell command.

The rules RPC writes Global. A native override of outside-read, web or rule policy must be edited or unset at that layer rather than bypassed by a Global RPC save. An enabled-only override doesn't shadow dynamic policy. See [settings and status](settings-status.md) for layer ownership and save authority.

Storage CAS and runtime adoption are separate from native call approval. Saves recheck authoritative storage and await notification before publishing synchronized policy. Notification failure leaves saved/runtime revisions visibly unsynchronized; recovery rereads storage, and conflicts preserve dirty drafts. These checks don't cancel pending native approval or override an actual approved call. New calls consume current policy, with no cross-call reuse of a once grant.

Configuration writes require the real native operator, exact entry/form or Root authority and a live connection/owner through every await and immediately before commit. Serialized provenance, a client loopback claim or an old registration isn't authority. Only relevant effective permission changes coordinate revocation; unrelated model/locale/display edits aren't a second approval gate. A committed write stays committed when notification or observation fails, with refresh-required/unsynchronized status. An unconfirmed native result requires reread, not blind retry.

## Trusted read-only calls

Trusted native `read`, `glob` and `grep` calls do not request outside-read approval, inside or outside the workspace. This includes saved `outsideReads: ask` and `outside-read` entries with `action: ask`. DSMM continues reading these settings without rewriting user configuration. Missing FS/path or co-location facts do not turn `allow`, `ask` or `inherit` into a read approval.

Existing deny policy and path-rule matching remain effective. Outside standing Full access, a relevant deny fails closed when the required containment or path facts cannot be proved; an unknown backend is not proof that a target is inside the workspace. Standing Full access retains its definite-blacklist behavior described above.

The same outside-read behavior applies to the existing shell read branch only when the native adapter supplies a current, trusted `readCapability` for the actual executable and environment. A tool name, command name or workspace cwd is not read-only proof. Independent shell command rules, unknown-command behavior and web/Git policy are unchanged.

This removes only DSMM outside-read asks. Independent downstream asks, denials and cancellation still apply, including third-party tools with familiar names. Native read-only restrictions, role/tool/RPC ceilings and exact registration, body, arguments, Agent and invocation-token bindings remain in force. A native once approval still belongs only to its original call.

## Configuration drawer and command rules

Use **Plugins → DSMM bundle config → Permissions**. The selected Global/native-profile scope edits its sparse deployment policy; a separate Root-rules transaction writes Global only under the existing live operator, exact open Root, registration and synchronized-policy authority. A child, stale connection, read-only Host or shadowing native policy doesn't acquire a fallback Global write. Named Profiles can't grant these permissions. No duplicate Settings permission page or Conversation permission tab is registered.

A trusted, writable native Root can manage Global rules without DSMM role admission, including when it predates Core mounting and currently uses the user-selectable `dsmm-orchestrator` composition. Qualification uses the current native composition, never a historical preset label; auxiliary, read-only and unknown `dsmm-` compositions remain ineligible without admission. Rule management does not grant DSMM role execution rights. Captured DSMM objects still require current admission and role checks, and retired captures cannot fall back to ordinary native authority.

`permissionControl.nativeCommands` defaults off. Entries in `permissionControl.nativeCommands.entries` accept simple command/subcommand pattern strings (e.g. `git`, `git status`, `go test`) or legacy object entries (`NativeCommandEntry`). Legacy entries are preserved losslessly without silent conversion or authorization widening.

In the UI, new command entries are entered simply as command strings with Add and Remove actions. There are no ID, tool, cwd, sandbox or action selectors, and no repetitive override or explanation lines. Saved legacy structured entries display a compact read-only summary showing the command and identifiable constraints (tool, working directory, ask/sandbox differences viewable in collapsible details) plus a delete button.

Simple command rules support literal command and subcommand prefixes (such as `git`, `git status`, `go test`) and optional alternatives (`go build|test`). A match takes priority over DSMM command ask/deny and legacy command entries, automatically approving native `danger-full-access` for that invocation. Unmatched commands follow the ordinary policy path. Shell chaining, pipes, redirects and complex shell syntax do not match. Current invocation identity, cancellation and role/tool eligibility remain required; the grant does not change the session's standing sandbox.

An additional outer middleware may request approval after the pre-execution pipeline has returned. When that request has no exact execution association, it retains native approval handling; DSMM does not infer authorization from a shared call ID, signal or tool name.

New UI entries require a valid, non-empty command pattern before saving; empty or invalid drafts lock the Save button. Removing a row discards that row's draft and reindexes the remaining raw drafts cleanly; Unset restores default configuration in Global scope and inherits Global configuration in Profile scope.

Observed `kind:shell` registration isn't proof of the actual executor, environment, executable or sandbox. The editor doesn't auto-certify those values. Missing/stale controller or registration identity still refuses consumption. Saving a rule isn't native manual approval and doesn't solve an unexplained read-only Git prompt; that investigation needs the full triggering call and approval reason.

## Capability limits

### Running overlay changes

Live overlay Apply is unavailable. Save/select a future default and create a new session instead of rebinding an active parent or pending invocation. Ordinary mode controls and Use profile model retain independent capabilities; neither grants overlay authority.

Same-call approval, cancellation, ownership and input isolation remain effective. Don't replay a whole parent task to work around a refused call; inspect the outcome and explicitly invoke fresh work only when appropriate.

See [running-overlay and approval boundaries](deferred-native-approval-risk.md).

Outside-read and web policies apply to their native tool surfaces. They don't provide complete filesystem/network isolation for arbitrary shell commands or replace operating-system checks on the final inode and socket target.

### Workspace and system-temp modifications

DSMM does not add a path-range approval layer to native write/edit or ordinary shell modifications, including targets in workspace and system-temp subdirectories. Explicit command/Git rules, role/tool restrictions and native or third-party approval decisions remain effective. A temp path does not automatically approve an independent request.

Native write/edit retain their FS intents, observation/version checks, atomic modification and backend-provided sandbox escalation. Shell execution retains the native executor, standing sandbox and explicit call-scoped escalation. DSMM does not infer every command's effects from its cwd, raise the sandbox mode because a temp path appears in its arguments, or automatically replay a denied command.

Actual write access remains backend-dependent: the stock Windows shell sandbox uses a private temp directory, not the entire shared system temp, and stock LocalFS does not itself enforce sandbox write scopes. DSMM neither changes system-temp ACLs nor supplies a replacement sandbox or FS isolation layer. Absence of an extra DSMM approval does not prove that a backend permits a write or requires approval for every outside write.
