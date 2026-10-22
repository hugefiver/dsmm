# Deepwork Agent presets and child control

DSMM 0.3.10 targets exactly DSH `0.2.1-rc.2`. Native package composition and callable admission are separate requirements.

## Roles and composition

The canonical inventory is 11 base roles and 11 categories. Base roles are orchestrator, builder, reviewer, oracle, oracle-2nd, doc-search, code-search, planner, clarifier, plan-critic and media-reader. Categories are frontend, creative, hard-reasoning, research, quick, coding, normal-task, complex, deep, documenting and cross-cutting. IDs are `dsmm-<source-name>`; `explore` is a code-search compatibility alias, not another role. Cross-cutting defaults disabled; other canonical items default enabled.

Only the Orchestrator (`dsmm-orchestrator`) is a selectable standing root, and it is the only composition DSMM registers with the native preset registry. Every other role is an internal delegation target: no role preset is registered for it, and a delegated child shares its parent's standing composition while the admitted invocation carries its role, identity and restrictions. `roles.*` controls delegation availability; disabling a role removes its callable tool and admission entirely. Native preset selection displays `DW …` labels under unchanged IDs. A role name is a responsibility, not a model choice or authority claim.

Native `agentPresets.register({id, plugins})` publishes only the selectable dispatcher composition; DSH doesn't discover presets by scanning exported directories. The native export roster lists only the dispatcher, and creation/execution checks reject every non-dispatcher DSMM root. Generated `agent-presets/` mirrors are inspection/export resources. `presets.materialize` defaults off, publishes only the dispatcher preset directory and never selects the Host default preset. Personas, read-only restrictions and host approvals remain when explicit Deepwork off hides common workflow and DSMM skills. Maintained source content, generation and resource provenance are described in [maintenance](maintenance.md).

Optional preset materialization writes only the DSMM-owned dispatcher preset directory under its configured root. Ownership requires the exact role-bound marker and expected regular files; foreign directories, extra entries, links and containment escapes refuse update/removal. New directories publish by same-parent rename. A legacy marker is accepted only with the complete expected regular-file shape, never as permission to claim unrelated content. Reconciling removes verified owned directories of every non-dispatcher role, including ones published by earlier versions. Materialized files remain export resources, not an alternative native registration mechanism.

Managed Agent scopes supply their own `harness:identity` system section. The ordinary native identity remains unchanged outside those scopes; the override doesn't grant a role, tool or permission based on its displayed name.

Root admission is not configurable per role: the dispatcher is the only standing root. A blank preset switch to any other DSMM role is refused because no such preset is registered, and the admitted composition stays in place. Forced creation and empty-root preset changes still require valid root admission before execution. Opting into Deepwork requires the enabled module, role and usable composition; it never grants writes. Harness's native `/plan` remains collaboration state, not a permission upgrade.

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

No child gains coordination authority from a preset label, persona or serialized role string. The shared policy checks exact live native ownership/admission and provider/definition identity. Each call has its own pending child correlation; awaited creation installs immutable policy before queued input executes. Generic spawn/fork can't bypass role admission in a DSMM-controlled workflow. Unrelated ordinary off-mode native children retain Host behavior without acquiring DSMM delegation.

Read-only roles remain read-only independently of mode and optional guards. Planner returns complete Markdown for native review/handoff; an authorized coordinator persists it. There is no Planner writer. Native catalog visibility and role permission are separate: a schema or read-only catalog listing doesn't authorize invocation, and own-layer native schemas may remain visible even when mandatory execution fences deny them.

Descendants intersect parent allow-lists with requested restrictions and union deny-lists, using frozen captures. Existing native filters still execute. Reinstallation, direct aliases, continuable starts and cold resumes don't enlarge original authority. A named profile can narrow enabled roles but can't lift startup/deployment ceilings; required roles and conditional legacy review rules are covered in [profiles](profiles.md#inheritance-and-ceilings).

## Invocation and lifecycle

Actual per-role or parameterized tool names, target IDs and `level`/opt-in `route` parameters are documented in [model routing](model-routing.md#tool-topology-and-target-filters). Default level is normal; low/high/max require explicit target configuration. Root model selection stays native-owned. Children capture route, visible-output locale and authority at admission, not from a parent's later profile.

Waiting for the official activation result is the default (`delivery:'caller'`). Only `stopReason:'completed'` is normal completion. Native output, structured result, diagnostics and partial output retain their separate meanings; interrupted or failed activation isn't reported as success. Cancellation after publication uses the activation receipt's `dispose()` and waits for cleanup, including cancellation racing with receipt creation.

Explicit `enableRunInBackground` exposes `run_in_background`. Only `true` selects background delivery, before start, using native `delivery:'parent'`. It returns accepted child/message information, and the native activation notifies the parent on completion. A legacy `backgroundMode` value isn't a selector for another execution owner or a promise of cold continuation. Omitted `maxDepth` delegates to the native limit; deployment depth/background settings aren't named-profile fields.

A running waiting call can't be handed to background. There is no restart-as-handoff, second child or DSMM RoleRun/job owner. Native activation owns execution, results and disposal.

## Child reports and control interfaces

Child report interfaces expose actual runs, direct children and a read-only descendant tree. IDs, activity, mode, admitted role/level, route comparison, original evidence and disabled reasons remain separate facts. Corrupt, unsupported or unavailable branches report diagnostics, not fabricated success. Descendant inspection doesn't grant control over non-direct children. The current client doesn't register a separate Conversation child tab; retained interfaces or components aren't proof of a reachable panel.

Route comparison uses the live admitted `invocation-capture` and the child's latest `own-native-request-header`. Missing, invalid or unobserved evidence remains unknown; it is never inferred from a root route, current profile or role label. Display metadata isn't a cold-recovery credential.

Human messages target only a supported live direct child with current exact-parent authority and native capabilities. Entries whose observed control projection is read-only remain inspection-only; this isn't the role's tool-level read-only policy. **Queue** accepts a distinct later turn; **Steer** targets the nearest step. An idle live child can receive another turn, but DSMM cold resume without trusted live binding is unsupported. Native attachment/model capabilities separately determine image availability.

An inbox receipt means **accepted**, not executed or completed. An interrupt acknowledgment isn't completion and doesn't claim queued work was removed. If transport leaves a send outcome unknown, the draft stays visible and automatic resend is disabled. Inspect the native child conversation before explicitly allowing a new message, which could duplicate an accepted one. Refresh and reconnection never imply automatic retry.

## Invocation presentation

Native per-role and parameterized delegation call views distinguish **requested** role/category/level from **actual** validated invocation metadata. Pending raw arguments don't prove execution; error results or missing metadata don't establish actual identity. Route source and model IDs are shown only from the validated result projection, not inferred from a role name or requested route.

Collapsed rows show **调用 Coding** / **Call Coding** once a complete target is available, even while remaining arguments stream. Child labels use **Coding: task description**. Failures, interruptions and current-format replay, including nested PTC, keep the requested name without inventing actual execution. Native safety refusal views take precedence.

Arguments, result content, errors and metadata remain inspectable as JSON. Nontext results don't receive a rich preview. Calls without a usable native window use native fallback behavior. The view is presentation-only: it doesn't select a route, change approval or grant delegation authority.

## Runtime and admission boundaries

Official AgentRegistry, SubagentRuntime and JSONL namespace plugins own execution and storage. There is no custom Registry/Runtime selector, manual-runtime activation path or companion requirement. Native runtime availability and actual DSMM admission are still separate observations; seeing a catalog isn't proof of callable policy. See [settings](settings-status.md#child-runtime-composition).

Cold DSMM recovery without a trusted live binding refuses execution and preserves history. Logs, IDs, PluginRecord display data or current parent settings can't restore authority. Read-only history queries don't resume Agents. `preset-skills` is an internal handle installed and released by the admitted Agent scope, not a public plugin. See [compatibility](compatibility.md#retired-compatibility-surfaces).

Native Host commands, sessions, inbox, permissions, process/cwd/model selection and transports retain ownership. DSMM supplies role admission and bounded controls, not a replacement lifecycle scheduler, generic permission bypass or automatic retry system.

*Author's note: For a coordinator or DSH operator delegating work; inspect actual child admission and receipts before treating catalog visibility or accepted delivery as execution.*
