# Deepwork Agent presets and child control

The supported Host range is listed in [compatibility](compatibility.md). Native package composition and callable admission are separate requirements.

## Roles and composition

The canonical inventory is 11 base roles and 11 categories. Base roles are orchestrator, builder, reviewer, oracle, oracle-2nd, doc-search, code-search, planner, clarifier, plan-critic and media-reader. Categories are frontend, creative, hard-reasoning, research, quick, coding, normal-task, complex, deep, documenting and cross-cutting. IDs are `dsmm-<source-name>`; `explore` is a code-search compatibility alias, not another role. Cross-cutting defaults disabled; other canonical items default enabled.

Only the Orchestrator (`dsmm-orchestrator`) is a selectable standing root, and it is the only composition DSMM registers with the native preset registry. Every other role is an internal delegation target: no role preset is registered for it, and a delegated child shares its parent's standing composition while the admitted invocation carries its role, identity and restrictions. `roles.*` controls delegation availability; disabling a role removes its callable tool and admission entirely. Native preset selection displays `DW …` labels under unchanged IDs. A role name is a responsibility, not a model choice or authority claim.

Native `agentPresets.register({id, plugins})` publishes only the selectable dispatcher composition; DSH doesn't discover presets by scanning exported directories. The native export roster lists only the dispatcher, and creation/execution checks reject every non-dispatcher DSMM root. Generated `agent-presets/` mirrors are inspection/export resources. `presets.materialize` defaults off, publishes only the dispatcher preset directory and never selects the Host default preset. Personas, read-only restrictions and host approvals remain when explicit Deepwork off hides common workflow and DSMM skills. Maintained source content, generation and resource provenance are described in [maintenance](maintenance.md).

Optional preset materialization writes only the DSMM-owned dispatcher preset directory under its configured root. Ownership requires the exact role-bound marker and expected regular files; foreign directories, extra entries, links and containment escapes refuse update/removal. New directories publish by same-parent rename. A legacy marker is accepted only with the complete expected regular-file shape, never as permission to claim unrelated content. Reconciling removes verified owned directories of every non-dispatcher role, including ones published by earlier versions. Materialized files remain export resources, not an alternative native registration mechanism.

Managed Agent scopes supply the single role opening (`You are <display name>.`) through `harness:identity`, without a parenthesized role ID. Persona prefixes carry role guidance, not another identity opening; admitted children shadow both inherited sections. Internal role IDs remain the admission, routing and preset keys. The displayed identity grants no role, tool or permission.

An active non-DW preset opens with a neutral assistant identity and omits the stock model announcement. It keeps custom persona instructions, native model selection, effort and delegation. It receives general working guidance, matching model behavior guidance, locale policy and lazy skills. Turning Deepwork off restores the native opening. Mode activation does not create an orchestrator identity, apply DSMM role routes or require specialist tools. When a skill describes an unavailable specialist, the Agent follows its native persona's authority and performs the permitted work directly.

Root admission is not configurable per role: the dispatcher is the only standing root. A blank preset switch to any other DSMM role is refused because no such preset is registered, and the admitted composition stays in place. Forced creation and empty-root preset changes still require valid root admission before execution. DSMM role admission requires an enabled module, enabled role and usable composition. Ordinary presets can use the general Deepwork mode without acquiring a role; mode activation grants no writes. Harness's native `/plan` remains collaboration state, not a permission upgrade.

Standing Orchestrator/Builder compositions include native planning, compaction/pruning, question and todo rows. Planner includes planning, compaction/pruning and questions, but no todo writer. Coding/frontend/deep/complex/cross-cutting include compaction/pruning, questions and todo; other auxiliary roles add none of those rows. Native spawn can retain parent services, so this isn't a promise to strip every inherited row from short children. Effective filters and execution fences still decide access. Native `/plan` doesn't upgrade Planner permissions, and `/compact` remains a human native command.

## Delegation authority

| Admitted identity | Permitted logical children, intersected with native authority |
| --- | --- |
| Trusted root/stage-owner Orchestrator, or a delegated stage-owner Builder | Authorized workflow/execution roles; owns formal planning, criticism and acceptance |
| quick, code-search, doc-search, research, media-reader | None; research remains a leaf |
| Planner, clarifier, plan-critic, Reviewer/Oracle | Read-only code-search, doc-search, research, media-reader |
| coding, normal-task, frontend, creative, hard-reasoning, documenting | Bounded utility leaves |
| deep, complex, cross-cutting | Utility leaves and coding/frontend/hard-reasoning/creative/documenting specialists |
| Native child Builder | Bounded utility leaves, not stage ownership |

No child gains coordination authority from a preset label, persona or serialized role string. The shared policy checks exact live native ownership/admission and provider/definition identity. Each call has its own pending child correlation; awaited creation installs immutable policy before queued input executes. Generic spawn/fork can't bypass role admission in a DSMM-controlled workflow. Ordinary native children retain Host delegation and model ownership without acquiring a DSMM role, whether Deepwork is active or inactive.

Read-only roles remain read-only independently of mode and optional guards. Planner returns complete Markdown for native review/handoff; an authorized coordinator persists it. There is no Planner writer. Native catalog visibility and role permission are separate: a schema or read-only catalog listing doesn't authorize invocation, and own-layer native schemas may remain visible even when mandatory execution fences deny them.

Descendants intersect captured tool and delegation-target ceilings with current admission and native restrictions, and union deny-lists. New tree members persist their DSMM ceilings in their own native Session records. Cold continuation validates native catalog, provider and lineage, loads the captured profile selector's current content, and retains the original readonly, tool, target and DSMM depth limits. A verified live root can own the admission lifetime while the durable creator is absent; it does not become the direct creator. Older records without a complete ceiling retain exact-live-creator recovery. A named profile cannot lift native ceilings; see [profiles](profiles.md#inheritance-and-ceilings).

## Invocation and lifecycle

Actual per-role or parameterized tool names, target IDs and `level`/opt-in `route` parameters are documented in [model routing](model-routing.md#tool-topology-and-target-filters). Default level is normal; low/high/max require explicit target configuration. Root model selection stays native-owned. Children capture route, visible-output locale and authority at admission, not from a parent's later profile.

Waiting for the official activation result is the default (`delivery:'caller'`). Only `stopReason:'completed'` is normal completion. Native output, structured result, diagnostics and partial output retain their separate meanings; interrupted or failed activation isn't reported as success. Cancellation after publication uses the activation receipt's `dispose()` and waits for cleanup, including cancellation racing with receipt creation.

`subagents.enableRunInBackground` or `subagents.forceBackground` exposes `run_in_background`. Both default false. With `forceBackground:true`, every delegation uses native `delivery:'parent'` whether the argument is omitted, true or false, including when `enableRunInBackground:false`. Otherwise only `enableRunInBackground:true` with `run_in_background:true` selects background delivery. Background calls return accepted child/message information; the native activation notifies the parent on completion. Independent foreground calls in one model response run concurrently through the native scheduler and each waits for its own completed result. A legacy `backgroundMode` value isn't a selector for another execution owner or a promise of cold continuation. Omitted `maxDepth` delegates to the native limit; deployment depth/background settings aren't named-profile fields.

A running waiting call can't be handed to background. There is no restart-as-handoff, second child or DSMM RoleRun/job owner. Native activation owns execution, results and disposal.

## Child reports and control interfaces

Child report interfaces expose actual runs, direct children and a read-only descendant tree. IDs, activity, mode, admitted role/level, route comparison, original evidence and disabled reasons remain separate facts. Corrupt, unsupported or unavailable branches report diagnostics, not fabricated success. These inspection interfaces do not grant additional control. On tree-capable Hosts, native `send_message` preserves the actual sender and permits same-tree communication; native `list_agents` and `wait_agent` provide discovery and waiting when exposed. Native interruption requires ancestor authority. Cross-tree messaging and sibling interruption remain refused. Older Hosts retain their adjacent-child control contract. The current client doesn't register a separate DSMM Conversation child tab; use the native Host surfaces that are actually available.

Route comparison uses the live admitted `invocation-capture` and the child's latest `own-native-request-header`. Missing, invalid or unobserved evidence remains unknown; it is never inferred from a root route, current profile or role label. Display metadata isn't a cold-recovery credential.

Human messages target supported direct children with current exact-parent authority and native capabilities. **Queue** accepts a distinct later turn; **Steer** targets the nearest step. A cold continuable child enters the native recovery path and obtains a fresh role admission. Listing and interrupt do not activate cold children. Inspection-only descendant controls are separate from tool-level readonly policy. Native attachment/model preflight can still limit image continuation; see [compatibility](compatibility.md#native-history-composition).

An inbox receipt means **accepted**, not executed or completed. An interrupt acknowledgment isn't completion and doesn't claim queued work was removed. If transport leaves a send outcome unknown, the draft stays visible and automatic resend is disabled. Inspect the native child conversation before explicitly allowing a new message, which could duplicate an accepted one. Refresh and reconnection never imply automatic retry.

## Invocation presentation

Native per-role and parameterized delegation call views distinguish **requested** role/category/level from **actual** validated invocation metadata. Pending raw arguments don't prove execution; error results or missing metadata don't establish actual identity. Route source and model IDs are shown only from the validated result projection, not inferred from a role name or requested route.

Collapsed rows show **调用 Coding** / **Call Coding** once a complete target is available, even while remaining arguments stream. Child labels use **Coding: task description**. Failures, interruptions and current-format replay, including nested PTC, keep the requested name without inventing actual execution. Native safety refusal views take precedence.

Arguments, result content, errors and metadata remain inspectable as JSON. Nontext results don't receive a rich preview. Calls without a usable native window use native fallback behavior. The view is presentation-only: it doesn't select a route, change approval or grant delegation authority.

## Runtime and admission boundaries

Official AgentRegistry, SubagentRuntime and JSONL namespace plugins own execution and storage. There is no custom Registry/Runtime selector, manual-runtime activation path or companion requirement. Native runtime availability and actual DSMM admission are still separate observations; seeing a catalog isn't proof of callable policy. See [settings](settings-status.md#child-runtime-composition).

Cold recovery requires verified native root/child identity and creates a new exact-object admission. Persisted DSMM records carry restrictions and profile selection identity; current native membership, provider and policy supply authority. Creator-absent recovery requires a complete own ceiling record. Generic native members retain null role/level and native model ownership. DSMM does not preserve an unavailable native tool-instance depth setting across Host configuration changes; each current native invocation still enforces its own depth limit. Read-only history queries never resume Agents. `preset-skills` is installed and released by the admitted Agent scope, not a public plugin. See [compatibility](compatibility.md#native-history-composition).

Native Host commands, sessions, inbox, permissions, process/cwd/model selection and transports retain ownership. DSMM supplies role admission and bounded controls, not a replacement lifecycle scheduler, generic permission bypass or automatic retry system.

*Author's note: For a coordinator or DSH operator delegating work; inspect actual child admission and receipts before treating catalog visibility or accepted delivery as execution.*
