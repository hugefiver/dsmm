# DSMM native architecture

DSMM 0.3.3 targets exactly DSH `0.2.1-rc.2`. It supplies Core configuration and native permission integration plus optional Deepwork roles, routing and skills.

## Composition and authority

Official AgentRegistry, SubagentRuntime, AgentLoop and JSONL namespace plugins own creation, execution, activation results, queues, parent-child ownership, storage and disposal. DSMM doesn't replace those owners or require a manual-runtime selector, companion or cold-migration entry.

The data flow is configuration source → complete immutable candidate → Agent admission → native request/tool execution → activation/catalog → client projection. Configuration and display metadata can't flow backward to grant execution permission.

Each role invocation captures its exact parent, ToolExecution, definition/provider identities, frozen settings and route before calling native `startActivation`. A short-lived pending record correlates the unique child with awaited `agent/created`. That listener installs scoped policy, skills and routing before queued input is released, then publishes the live admission. It runs after Registry publication; initialization failure is rolled back by the native factory, not treated as an unpublished creation. Pending state isn't a second execution queue.

Preset discovery, root eligibility and model availability are independent. Auxiliary presets aren't valid roots even if a native picker displays them. Empty-root preset changes require a valid execution-before-input binding; mismatched composition refuses at step/request/tool boundaries. Generic spawn/fork can't bypass a controlled parent's role admission. Ordinary non-DSMM off-mode paths don't gain DSMM authority.

Agent-scoped guards retain lifetime checks after plugin retirement. Native activation disposal handles owned work; hot unload/reinstall isn't a promise of uninterrupted live-session replacement. Existing unbound Agents aren't enrolled by listing them.

## Configuration and admission

Settings resolve as defaults → sparse Global → explicit native entry/profile → admitted named overlay. Objects merge, arrays replace, and explicit false, empty and same-default values remain pins. Unset affects only its own layer.

Core remains available without a session or active Deepwork. Desired source values, mounted startup ceilings and actual Agent admission are distinct. New roots capture valid desired configuration within mounted ceilings. Existing Agents and their children don't absorb later saves. Without a session, admission is unknown.

Global, native form, named document and selection pointer have independent CAS boundaries. Global/store writes retain prepare, atomic commit and observation stages; native writes retain the public ConfigEditor/form transaction. Operator, connection, entry and lifetime are checked after awaits and before irreversible writes. A committed write with failed notification/observation stays committed with refresh-required or unsynchronized status. An unconfirmed native mutation requires reread before retry.

Named-profile Save and future-default selection don't apply to existing Agents or select a model. **Live overlay Apply is unavailable**. **Use profile model**, **Deepwork mode** and **Apply overlay** project separate capabilities and reasons; Apply's restriction doesn't disable ordinary model/mode actions. Use profile model invokes native selection against the admitted immutable revision and observed manual-intent watermark. Same-value manual reselection is still new intent. See [Profiles](profiles.md).

## Native client surfaces

**Plugins → DSMM bundle config** is the deployment editor. Global and current native profile have separate Save/Refresh/Discard, module drawers and bounded Advanced JSON. Exact form namespace, entry/profile identity, revision and raw base/user provenance are required; a redacted snapshot isn't a replacement document. Missing form authority doesn't authorize a Global fallback. Named **Deepwork Profiles** retains its Settings section and compact Conversation menu. [DESIGN.md](../DESIGN.md) defines native components and interaction behavior.

Dirty and invalid drafts survive navigation and conflicts. Saving doesn't create sessions, select models, restart services or mount LSP. Children UI projects official catalog/control capabilities, not a duplicate state machine. Direct-child control and read-only descendant inspection have different authority.

Collapsed invocation rows show `调用 Coding` / `Call Coding`; native child labels use `Coding: task description`. Requested identity isn't actual identity. Validated result metadata, partial/failure/interruption handling and current-format replay/PTC preserve that distinction. Native safety refusal presentation takes precedence.

## Execution, routing and resources

Waiting calls use native `delivery: 'caller'` and consume the activation result; only `completed` is normal completion. Publication-time cancellation uses the receipt's `dispose()` and waits for cleanup. Background must be chosen before start with `delivery: 'parent'`; accepted child/message IDs aren't completion. Running waiting calls can't be handed off to background.

Live direct-child Queue/Steer/interrupt require exact ownership, admission, operator and actual native capabilities. Unknown delivery outcomes aren't automatically resent. Cold DSMM resume without trusted live binding refuses execution while preserving history. DSMM read-only history queries don't call resume; native factory load/repair may precede the created guard, so refusal isn't a no-log-open guarantee.

Ordinary roots retain native model selection. Role normal and explicit low/high/max routes use generic capabilities and immutable parameter policy. Standard supported calls use native prepared calls. Raw/custom parameters and Pi-AI stop-only calls use the minimal public completions payload seam for self-contained literal or explicit model-mapping configurations. Catalog-backed raw combinations that can't be reliably reproduced are rejected for both native and DSMM parameter sources. Standard Coding and native effort encoding remain unchanged. [Model routing](model-routing.md) and [runtime recovery](runtime-recovery.md) define the boundaries.

Fourteen skills use Agent-scoped metadata discovery and lazy bodies, preserving non-DSMM ancestor winners and cancellation/invalidation semantics. `preset-skills` is an internal admission-owned handle, not a public plugin or global lifecycle owner. Deepwork off removes workflow/DSMM skills, not mandatory persona/read-only/tool policy.

## Limits

Native approval remains final for its exact call/scope, not a reusable permission. Relevant policy changes coordinate revocation; unrelated display/model saves aren't second approval gates. See [native permissions](native-permissions.md).

Network behavior and limits are specified in [Fake-IP fetch](web-fetch-fakeip.md); shell rejection remains unlocated. LSP automatic mounting stays disabled; DSH's native LSP and independent MCP remain unchanged. See [LSP boundary](lsp.md).
