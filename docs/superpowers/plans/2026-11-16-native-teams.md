# Native Deepwork and Agent Teams

## Outcome

Ordinary native presets retain their native identity, persona, model selection and delegation while Deepwork supplies only its general guidance, skills and applicable model tuning. DSMM role presets retain admitted role routing and restrictions. Native delegation cards display evidenced identity and route information without taking over execution.

On a capable DSH Host, DSMM participates in native subagent-tree communication and Agent Teams. Same-tree members can exchange messages and resume supported cold members; ancestors can interrupt descendants. Native services own execution, inboxes, task state, persistence and completion delivery. Role, readonly, tool and depth ceilings remain effective.

## Scope and constraints

- Preserve the supported older Host branch using capability detection, without changing package versions or dependencies.
- Reuse native Team mode, task tools and UI. Do not introduce another task board, runtime, message bus or configuration switch.
- Keep readonly members limited to task inspection; the root performs task mutations for them.
- Keep unavailable session Profile switching unavailable where public provider/startup observation cannot prove safe maintenance.
- Existing history reading and root/child configuration refresh remain implemented. Do not add another reader or migration subsystem; representative DSMM 0.2.x artifacts remain a separate evidence question.
- Running-activation delivery handoff, out-of-order foreground result submission, active-work Apply, cross-route retry and broader sandbox grants retain their Host boundaries.
- Each independently useful function and its tests form one commit. Perform one combined implementation review before ordinary push. Do not publish or alter release identity.

## 1. Ordinary presets with Deepwork

Affected areas: `src/role-policy.ts`, `src/session-scope.ts`, `src/role-identity.ts`, `src/agent-prompt-scope.ts`, `src/mode.ts`, routing and role-tool installation.

Separate Deepwork activation from DSMM role identity. An ordinary preset does not acquire `dsmm-orchestrator` from mode activation. Roles come from valid DSMM preset selection or trusted invocation/admission. Keep ordinary persona and native model authority, including explicit effort. Do not apply orchestrator primary/fallback or expose role tools through inferred identity.

The ordinary prompt path in `src/mode.ts` and `src/prompts.ts` must select general Deepwork guidance instead of the role workflow in `prompts/source/deepwork/default.md`. It may describe actually exposed native delegation, but must not require absent planner/plan-critic/clarifier tools. Keep general skills and model tuning independent. Verify the useful native delegation through a real request, not a prompt text snapshot.

Ordinary native delegation remains available subject to native capabilities and inherited restrictions. Actual DSMM roles retain their admitted delegation limits. General prompt/skill enhancement must remain available independently of role identity.

Update existing tests that used ordinary roots as shorthand for DSMM orchestrators to use explicit DSMM presets where those tests protect role behavior. Add focused real-native on/off coverage for ordinary identity, route and delegation, and retain readonly/filter/depth rejection coverage.

## 2. Native delegation cards

Affected areas: `src/role-control-types.ts`, `src/native-admission.ts`, `src/role-control-rpc.ts`, `src/client/RoleToolView-data.ts`, `src/client/RoleToolView.tsx`, and observation handling.

Express native and role invocation identities distinctly. Preserve existing role metadata and replay compatibility; ordinary calls must not fabricate role, level or configured-route provenance.

Use native execution/lifecycle identities and the child's own request header for correlation. Do not infer child identity from descriptions, timestamps or ordering. Keep missing route/effort unknown. Preserve original tool output, cancellation, completion ownership, repeated-call-ID handling, PTC identity, disconnect behavior and observer disposal.

Register the presentation for actual supported native delegation definitions without replacing execution. Where a public exact live correlation is unavailable, retain native presentation and evidenced final identity; report the unresolved live surface rather than guess.

Acceptance exercises native and DSMM cards before completion and after success, failure, interruption and replay. Browser coverage must connect real observation updates to production DOM, in addition to existing controller tests.

## 3. Native tree collaboration and cold continuation

Affected areas: `src/native-ownership.ts`, `src/native-subagents.ts`, `src/native-admission.ts`, `src/role-policy.ts`, `src/profile-runtime.ts`, role tools and prompts.

Keep distinct concepts:

- Current native tree root, established by `rootOf(exactLiveAgent)`.
- Durable direct creator, established by matching native catalog/descriptor/lifecycle evidence.
- Current admission owner and effective restrictions, established by the current configuration plus trustworthy inherited ceilings and native restrictions.

Do not redefine direct ownership as same-tree membership. New delegation still requires its exact current creator and admitted role/depth/tool checks. Name resolution grants no authority.

Use native `sendMessage` with the actual sender. Model interruption uses `interrupt(target, { kind: "ancestor", agent: caller })`, never user authority. Preserve native discovery/waiting and accepted-message semantics. Unknown outcomes are not automatically replayed.

A supported cold member can resume under the native root with its original ID, creator identity and depth, without recreating intermediate ancestors. Native descriptor/catalog/root evidence supplies membership; current enabled role and mounted composition supply current admission authority. Historical approvals grant nothing.

Persist DSMM-only restrictions through the existing public `appendPluginRecord` / `pluginRecordOf` boundary in `src/session-metadata.ts`, on the child's own native Session before admitting the first request. Use a versioned `plugin:dsmm/delegation-ceiling` record containing child/creator/root identities, native provider, role/level and profile selection identity, readonly, tool allow/deny, admitted delegation targets and absolute maxDepth (explicitly represent unbounded when applicable). For a DSMM role child, capture these from the verified pending invocation and parent policy, not model arguments. For an ordinary native child, capture the same restrictions from its verified native creation/publication and exact creator admission; persist `role: null` and `level: null`. A generic native record never supplies DSMM role identity or a configured role route. Its depth ceiling captures proven DSMM inherited or explicitly configured limits; absence is `null`, not the native default depth. Native tool/provider invocation limits remain enforced by the Host. When a Host does not persist a tool instance's `maxDepth` in public descriptor/lifecycle evidence, DSMM does not claim to preserve that instance setting across Host configuration changes. Native policy events continue to own sandbox and approval inheritance; the new record carries only restrictions and selection identity, never grants, secrets or historical live authority. Do not create a separate capture file/store or rewrite native descriptors.

On cold activation, read only the child's own events after any seed; reject conflicting/malformed records. Match child/creator/provider and reachable catalog identity to the native descriptor/header and current native root. Apply readonly by logical OR, intersect allowed tools/targets with current valid policy, union denies, and take the minimum current/captured maxDepth while retaining native delegationDepth. Resolve the selected profile's current content; resolve a role route only for a role-bearing record. Generic continuation uses the current native provider and original native model-selection ownership, without `resolveRoleInvocation` or inferred role identity. Task owner and message sender never supply target authority. Current provider/permission refusals and applicable role refusals still win. Verify append/persistence via native disposal and reopen. Existing records without this ceiling retain the already-supported exact-live-creator recovery; creator-absent recovery requires the new complete evidence and otherwise refuses.

When the creator is absent, the proven live root is the current admission lifetime owner, not a fabricated direct creator. Keep durable creator ID separate from the live owner in bindings and checks. Resident members retain captured ceilings after creator exit; new delegation from them still validates their exact live identity and effective restrictions.

Resident captures remain immutable. Root retirement invalidates its owned work. Creator retirement alone does not invalidate a member legitimately owned by the still-live native root. Missing or conflicting identity/ceiling evidence refuses the dependent capability.

Acceptance covers sibling messages, cross-tree refusal, ancestor-only interruption, original-ID cold resume after creator disposal, current disabled-role refusal, readonly/filter/depth restrictions and fresh approvals. Existing older-Host continuation remains covered. Add native `list_agents` and `wait_agent` to actual admitted observation as appropriate; availability comes from native tools, not generated names.

## 4. Native Agent Teams

Consume existing `ctx.agentTeams` and `team_task_create/list/get/update`; preserve native conditional tool visibility and mode ownership. Do not automatically enable Team mode. The root controls the mode and reassignment.

In rc.3, `ToolsService.get/definitions/schemas(agent)` without a `toolSet` inspect registered, restriction-filtered definitions independently of `when`; `resolve(context)` computes the step's admitted set, and `executable` rejects conditional tools without that set. Capture the original inherited definitions and permission ceiling through the inspection surface, leaving native step admission authoritative. Never copy native Team definitions into the Agent scope: registration options carry `when` separately from the definition, so copying would erase the condition. Reconcile registration identity only on actual registry changes, not Team visibility changes. Preserve explicit inherited allow/deny filters.

Test members created while Team is off across off→on→off: native resolved step schemas and execution must follow the switch; readonly list/get becomes usable when enabled, mutation remains refused, and explicit tool denies survive all states.

Writable members follow native task permissions and exact revision CAS. Readonly members may list/get; direct create/update is refused even when task owner. The root can create, assign and complete tasks for readonly workers based on their messages.

An unassigned ready task is claimed before execution. A root-reassigned task is already `in_progress`: the worker gets it and executes without claiming again. Task changes do not wake members; explicit messages do. Interrupting a member does not release task ownership. `writeScopes` are coordination hints, not authorization or locks.

`TEAM_TASK_PERSISTENCE_UNCONFIRMED` requires rereading current state before deciding further action. Do not automatically replay mutations. Task text, ownership and Team mode do not broaden role permissions.

Provide guidance only when native Team capability is enabled/available. Preserve terminal-role delegation restrictions. Update maintained prompt resources and generated assets through the existing generator where applicable.

Acceptance uses real native service/tools: writable claim/complete, root reassignment without waking, explicit message wake, readonly inspection and mutation refusal, stale revision, dependency blocking, root completion, native task projection and existing UI.

## 5. Existing feature acceptance and documentation

Profile/Settings acceptance checks native navigation, first-send route, unsent text/references/attachments, independent Save/default/Apply capabilities, errors and keyboard focus. On Hosts without provider enumeration, verify truthful unavailability while preserving independent save/default/mode functions. Fix only evidenced defects.

LSP acceptance uses the existing startup bridge and a real language server for diagnostics, definitions/references and allowed mutations; readonly rename/format remains denied. Desired configuration saves do not remount a running integration. Update stale documentation claiming startup is permanently disabled.

Windows acceptance distinguishes native file-tool extra roots from confined process access, checks TLS-enabled Schannel and preserves external-write rejection. Failures remain explicit Host limitations; do not change global TLS, ACL or sandbox policy to pass.

Update `docs/roadmap.md`, `docs/compatibility.md`, `docs/lsp.md`, `docs/agent-presets.md` and relevant testing/prompt maintenance documentation to final behavior. Preserve and integrate the existing roadmap requirements. Do not commit machine-specific paths, raw execution evidence or task journals.

## Verification and delivery

Workers run targeted checks for their changes. The coordinator consolidates typecheck/build and affected modules, then exact-Host/browser/LSP integration evidence. Reuse passing evidence unaffected by later changes. Missing anchors and skipped scenarios are reported, not counted as success.

Review the combined functional commits and new files with the approved scope and actual evidence. Correct substantive findings, rerun affected checks, commit corrections, and push normally. History samples or Host contracts not available in scope stay explicit rather than becoming speculative implementations.
