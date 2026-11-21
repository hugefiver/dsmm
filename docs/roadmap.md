# DSMM roadmap

## Version policy

**Current Host acceptance target: DSH `0.2.2-rc.5`.** When DSMM changes its declared adaptation target, update this line and run compatibility regression once. All other Host acceptance uses only the current target. On RC5, DSMM `0.3.34` Web cards opened the corresponding role and native child conversations. The native Plugins manager enabled and disabled the LSP entry across Host restarts, exposing nine tools when enabled and none when disabled.

**DSMM supports DSH `>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-rc.1 <0.3.0`.** Official DSH rc.3 gives `engines.dsh` precedence over peer ranges. The SDK remains pinned to `0.2.1-rc.2` for development. The 0.2.2 support range starts at `0.2.2-rc.1` and excludes `0.2.2-alpha.*`. Each DSMM version declares its supported Host range independently of its development dependencies. Older SDKs and old configuration schemas aren't runtime compatibility targets. Historical-session support is limited to the existing native reader and validated continuation paths. Broader historical-version behavior repair and migration are outside the current scope. A dependency upgrade or support outside the declared range requires deliberate reassessment, not an automatic runtime switch.

Published `0.3.0` retains its original rc.1 package, tag, assets and version-bound release identity.

## Current capabilities

Official AgentRegistry, SubagentRuntime and JSONL namespace plugins own execution and storage. DSMM supplies immutable admission, roles, routing and scoped policy without a custom execution owner, persistence companion or manual-runtime selector. Coding delegation consumes native activation results and cancellation. Native tree controls follow Host membership and ancestor authority; retained DSMM descendant-inspection interfaces remain read-only.

Deployment configuration uses native Plugins forms and separate sparse Global/native-profile layers. Named Profiles preserve draft, saved revision, future default and current admission as distinct states. Global/store CAS, native form revisions, filesystem protection, operator authority and RPC lifetime checks retain their own boundaries. Desired values don't update mounted services or running task policy. Save/future-default selection, model selection, mode changes and overlay Apply have independent capabilities.

The Profile editor has a single-column main form, direct basic settings and orchestrator model controls, a separate Agent-model dialog, independently collapsed advanced settings and JSONC, and Save/Discard/Reload with validation, conflict and focus handling. The page structure and controller behavior are implemented; browser acceptance is distinct from adding these features.

Supported root and continuable-child reactivation preserves native session identity and history while rebuilding admission from current deployment settings and the current content of the selected named profile. Cold children resume through native ownership, use current role routing and restrictions, and do not inherit historical approvals. Already resident Agents retain their admitted configuration. The cross-Host regression in `test/native-session-resume-refresh.test.ts` covers original root/child IDs, changed routes, readonly enforcement, disabled-role refusal and fresh approval requests; this is implemented behavior, not a pending restoration feature.

Agent-scoped skills expose metadata and load bodies lazily, preserving non-DSMM ancestor winners. Standard model calls use native prepared calls. The minimal public Pi-AI completions seam supports raw/custom and stop-only parameters for self-contained literal or explicit model-mapping configurations. Catalog-backed raw combinations that can't be reliably reproduced are rejected for both native and DSMM parameter sources; standard calls and native effort encoding remain unchanged.

Native call views show the target in collapsed rows, distinguish requested from actual identity, and retain that distinction for partial output, failure, interruption and current-format replay/PTC. Child labels use `Coding: task description`.

On DSH `0.2.2-rc.1`, native multi-file patches are available through explicit `tool-fs.config.applyPatch: true`, with the default remaining off. DSMM forwards native configuration and retains role/tool ceilings, observation checks and native sandbox/approval ownership; sequential commit can partially succeed. See [native patches](native-permissions.md#native-multi-file-patches-on-dsh-022-rc1). Dynamic Pi-AI request headers retain the native hook across standard/raw paths and the original registration scope; see [request headers](model-routing.md#native-dynamic-request-headers). Gemini 4 series aliases share the existing additive calibration.

## Remaining capability boundaries

| Capability | Current behavior | Requirement for broader support |
| --- | --- | --- |
| Cross-route model fallback on 0.2.2 | 0.2.2 fixes the model selection per step; DSMM keeps same-route bounded retries and degrades `rate-limit-fallback` switching to a same-route retry with a one-time diagnostic. 0.2.1 switching is unchanged. | A public re-selection boundary within the failing step (or per-attempt selection); see [compatibility](compatibility.md#dsh-022-host-differences). |
| Session overlay Apply | Completed or stopped roots can switch using current resident-tree activity, native maintenance and admission CAS, including on rc.3 without provider enumeration. Observed active work, queued input and pending approval/delegation prevent switching. | Switching during active work remains unsupported. Unknown external-provider activity is not a global switching gate. See [approval boundaries](deferred-native-approval-risk.md). |
| Running-call background handoff | Deferred. Select waiting or native parent delivery before starting; existing background dispatch stays unchanged. | A supported same-activation native delivery handoff; see the deferred foreground delegation requirements below. |
| Granular sandbox access switches | Deferred for later investigation, including system-certificate access for Windows Schannel. No new switch or backend is supplied for this capability. | A supported per-process enforcement mechanism, identified necessary resources, and isolated on/off verification; see [granular sandbox extensions](#deferred-granular-sandbox-access-switches). |
| Restricted-role continuation after restoration | Supported roots and continuable children receive fresh admission through awaited `agent/created`, with current role, parent, readonly, tool and depth checks. Historical approvals do not grant current authority. | Broader historical-format support needs public control of persisted persona/composition and pre-activation restoration boundaries. Cold-child image preflight can still inspect historical `agent.options` before current routing takes effect. Unresolvable presets and missing or unsafe identity remain refused; see [recovery boundaries](compatibility.md#native-history-composition). |
| Non-disruptive hot update | No uninterrupted live-session guarantee. Retire admissions and let native owners cancel/dispose owned work; guards remain fail-closed. | Native lifecycle support that preserves active task/approval boundaries. |
| Catalog-backed raw combinations | Rejected where the complete composition can't be reliably reproduced, regardless of native or DSMM parameter source. Standard calls aren't affected. | A public seam that can reproduce the full catalog composition and preserve native capability/effort semantics. |
| Repeated command approval | Eligible DSMM command-rule approvals are remembered for the exact live Agent. Independent native/downstream asks, non-reusable rules and sandbox widening can still require approval. | Diagnose the exact command, working directory, contributing rule and approval reason; do not expand Allow rules merely to suppress a prompt. |
| PowerShell Fake-IP access | Verified HTTPS through the current Mihomo Fake-IP route with Node/OpenSSL in native and DSMM `workspace-write`; Windows curl/Schannel fails in both sandbox paths. | Upstream Windows sandbox/Schannel compatibility; configured proxy-environment propagation remains unverified. See [network limitations](runtime-recovery.md#powershell-in-a-fake-ip-environment). |
| External LSP | The [native `dsmm-lsp` entry](lsp.md) is off by default. DSH Plugins enables or disables its MCP client; the Host reports whether a restart is needed. Existing compositions without the entry retain the startup `lsp.enabled` setting. | Supply `ocmm-lsp` and a language server for the target platform. Module lifecycle and tool execution are covered separately from language-specific operations. Independent MCP clients retain their tools, and readonly roles cannot rename or format. |

Search/Fetch retain the explicitly configured native provider. DSMM doesn't automatically enable a direct API, change credentials or forward the recent human question. HTTP Fake-IP behavior and network limits are maintained in [Fake-IP fetch](web-fetch-fakeip.md).

## Delivered: live delegation route observation

A read-only native Gateway stream connects admitted role/level and initial versus observed provider/model/effort to the exact parent session and tool call. Actual route evidence comes from the current child's own request header; missing or invalidated active evidence is unknown, and missing effort is not filled from the initial route. Settled observations remain frozen. Descendant-session observation uses verified live lineage without widening root/direct-child mutation controls.

Role, category and native subagent cards offer **Open child conversation** when the local child can be identified. The button opens the child under the card's parent session. Native subagent cards use their expanded-row action for this destination; unresolved or external executions retain native tool-call inspection instead.

Repeated provider call IDs continue to execute normally. When the client cannot disambiguate a reused call ID, live observation for that key is removed; each final tool result retains its own child-bound metadata. Disconnects and observer disposal never transfer execution, cancel the child or create another completion owner.

CLI/Gateway coverage includes observation before foreground completion, independent-peer refusal, readonly scope, observer disposal and repeated call IDs. On the tree-capable Host, an isolated browser also exercises a real native activation through Gateway, the native Connection/generated remote, the production observation controller and ToolCallTree DOM. It covers live own-header routes, completion and observer disposal without cancellation. Visual card states and responsive layout are covered with the native presenter retained. The [Gateway tests](../test/role-call-observation.test.ts) exercise the live stream, and the [browser test](../test/client-role-tool-view-native.test.mjs) verifies running and settled cards through a test RPC bridge. That coverage does not exercise the Host's WebSocket transport.

## Deferred: foreground delegation handoff

Reassess after DSH updates. The pinned `0.2.1-rc.2` API fixes activation delivery to `caller` or `parent` at startup and exposes no public running-activation handoff. DSMM must not take over completion notification or patch Host internals to supply it.

- Allow users to click **Run in background** on an active DSMM delegation started without `run_in_background: true`. Continue the same activation without cancellation, restart or duplicate dispatch; DSH retains execution, cancellation and completion-delivery ownership.
- Add an option extending manual handoff to foreground delegations involving non-DW Agents while Deepwork is enabled, covering both non-DW callers and non-DW targets. Dispatches that already run in the background need no change; the current native `subagent` tool already uses parent delivery and returns immediately.
- On a candidate DSH update, check for a public same-activation handoff API and its completion/cancellation race semantics. Read-only live invocation metadata uses a separate supported client channel and does not transfer execution or delivery ownership.
- Acceptance requires one native completion delivery, no duplicate execution, unchanged permission and ownership checks, and correct handling of completion racing a click. Verify the non-DW option in both states and leave already-background calls untouched. Do not expose an ineffective switch or upgrade/install DSH automatically.

## Current: non-DW Deepwork enhancement

Ordinary native presets retain their identity, persona, model selection, explicit effort and native delegation while Deepwork is active. They receive general guidance, lazy skills and applicable model-parameter tuning, without acquiring an orchestrator role or mandatory specialist calls. Explicit DSMM presets and trusted role invocations retain their admitted routing and delegation policy.

Native `subagent` and `subagent_fork` calls preserve their original presenter and gain call-card observations after an exact activation receipt is available. Execution-token correlation binds the native start to its call; actual routes come from the child's own request header and terminal state from its native end. An accepted receipt alone does not imply task completion. Before correlation, on unsupported presenters or on unobserved replay, the native output remains available without invented role or route metadata.

## Current: native tree collaboration and Agent Teams

Native same-tree messaging preserves the sender, and interruption uses ancestor authority. Members can remain usable after their creator exits. Supported cold role and generic members retain their original identity and captured DSMM readonly/tool/target/depth ceilings while a verified current native root owns their admission lifetime. Current selected-profile content applies without restoring historical approval grants or recreating absent ancestors. Legacy records without an own ceiling retain exact-live-creator recovery.

Agent Teams reuses the native task service, conditional tools, revisions and persistence. Readonly DSMM members can list/get; the root handles their task mutations. Reassignment, explicit wake, revision conflicts and persistence-uncertain outcomes follow the native contracts. Task ownership and advisory write scopes grant no execution permissions. See [Agent Teams](agent-teams.md) and the `native-teams` [integration group](testing.md#integration-groups).

## Deferred: prompt delivery of concurrent foreground results

Independent foreground calls already execute concurrently through the native scheduler. Returning each completed tool result while a sibling is still running requires a supported native result-submission boundary; the current Host commits results in model-call order. This remains separate from running-activation background handoff. DSMM must not synthesize tool results or take over native completion delivery to supply either capability.

## Current: conservative native history support

Historical-session loading uses the existing native DSH reader, not a pending DSMM migration subsystem. `ApiSessionList.list()` reads `sessionQuery.listSessions()`; `SessionHistoryController.page()` reads persisted events without activating an Agent. These paths do not require a historical DSMM preset to resolve or a DSMM admission to succeed. Titles are folded from stored events, and history pages expose conversation events, including tool results.

- DSH `0.2.1-rc.2` includes session-format codecs v0–v4 and their migration chain. These are DSH storage-format versions, not DSMM package versions. Records must satisfy the native format and metadata requirements; the current history API requires `cwd`. Unsupported formats or invalid records remain distinct from unavailable execution capabilities.
- Preserve the implemented native history reader and validated root/child continuation paths. Support depends on readable native records, resolvable identity and current permissions; no blanket compatibility guarantee is made for historical package versions. Additional historical-format repair or migration is outside the current scope.
- Historical list entries, titles, messages and tool results must remain readable independently of continuation. Native follow/promotion and Agent resume are separate execution paths: retired presets or unsafe identity may prevent continuation without constituting a history-decoding failure. Continued execution uses current restrictions and fresh authorization, never historical approvals as current authority.
- Preserve original records. Any necessary migration must protect user data with a recoverable original and concurrent-write safeguards. Corrupt or genuinely unreadable data must produce a specific diagnostic rather than silently removing the session. Compatibility checks should exercise native list and read-only history independently from continuation.

## Delivered: Profile selection before the first request and on idle roots

New sessions automatically use the saved future-default Profile, or the deployment baseline if no Profile is selected. Before the first request, the user can override that choice for just this session in the conversation header or Settings. The [header test](../test/client-profile-editor.test.ts) covers selection on a retained blank; the [runtime test](../test/session-profile-runtime.test.ts) checks that the first prompt uses the selected settings, delegated requests use its role route, and the native model and future default remain unchanged.

- The header menu and Settings session scope accept an explicit workspace and Profile choice when no session exists. Browsing or refreshing does not create a session, and no workspace is inferred from list order or process cwd.
- The current DSH `uiWorkspace.connectWorkspace()` service obtains a native blank without opening it. DSMM retains that exact session, occupies an empty composer block, performs the existing describe/select transaction and opens the session only after its selection and admission match. Profile-first interaction waits for an explicit workspace choice. No native model or future-default setting is changed.
- Late results cannot take over newer navigation. Unknown outcomes are reread without automatic creation or mutation replay; if the Host never returns a session ID, native workspace navigation is needed to inspect the result. DSMM releases only its own retained reference and composer block and does not reconstruct native input or attachments.
- Started and restored roots can explicitly switch once their native subtree is quiescent. The next request and new delegations use the committed configuration without changing the native model or future default. Successful publication clears only the exact subtree's command-rule memory; active or unprovable work remains refused. Client running-state transitions refresh server capabilities without granting permission locally.
- Browser coverage does not yet exercise carrying unsent text, references and attachments through native new-session navigation and sending them with the selected Profile in one flow.

## UI acceptance: simpler DSMM settings

The Profile redesign, deployment navigation and initial expansion behavior already exist. Isolated native-browser coverage exercises deployment saves, Profile editor/dialog states, validation, conflict handling, keyboard access, themes and responsive layouts. Explicit route provider/model blanks now block both main-form and dialog saves while preserving numeric drafts and inheritance behavior. The [Profile browser test](../test/client-named-profiles-browser.test.ts) covers that production component. Further UI work should address concrete findings in uncovered surfaces, not rebuild the existing page.

- Expand drawers containing only one section by default so their controls are immediately visible. Keep multi-section drawers easy to scan and navigate.
- Remove all redundant copy: repeated headings, explanations already conveyed by a control, implementation details and “not X, but Y” comparisons.
- Use familiar, consistent names across settings and session menus. Prefer direct wording such as “本次会话配置”, “新会话默认配置”, “使用默认配置” and “保存”; keep internal terms such as admission, overlay, mounted state and CAS out of normal interface copy.
- Keep only information needed to make a choice or act: what a setting affects, when it takes effect, important permission/data consequences and a concise recovery action when something fails. Place optional technical diagnostics behind a details disclosure.
- Review every drawer and its empty, disabled, saved and error states. Users must be able to find the controls and understand their choices without reading implementation explanations; preserve keyboard access and accessible labels.

## Current: dispatcher-only native presets

- Register only the dispatcher as a selectable native preset. Delegation targets are not registered compositions: a delegated child shares its parent's standing composition, and the admitted invocation carries its role, identity and restrictions.
- Blank preset switches to any other DSMM role are refused by the native registry; the admitted composition keeps executing.
- DSMM installs no Host package patches. Supported restored Agents receive fresh DSMM admission under current configuration and validated native ownership. Historical role identity may inform validation, but logs never restore delegation authority or live child residency. Historical presets that no longer resolve remain a separate compatibility limitation.

Existing [Fake-IP fetch](web-fetch-fakeip.md) protections remain in force.

## Current: command-pattern allowlists

- Use command patterns as the sole native-command rule format. `go build|test` matches either subcommand with variable trailing arguments. Legacy exact-command configuration is rejected without migration or silent permission expansion. See the [implementation plan](superpowers/plans/2026-10-21-command-pattern-only.md).
- Match parsed command tokens rather than shell-string prefixes. A matching command does not authorize an additional pipeline, chained command or substitution. Variable arguments can still invoke the selected program's own scripts or subprocess features; sandbox and role restrictions remain necessary.
- Preserve native deny/never, readonly, current ownership, approval consumption and configuration CAS. Pattern matching does not itself widen the sandbox or create remembered session approval.

## Current: live-Agent command-rule approval reuse

- `CommandApprovals` is wired into Git safety guards and permission-controlled command execution. After a complete native approval outcome and final execution checks, eligible Git, shell and native-command rule contributions can be remembered in memory for the exact live Agent. This DSMM rule memory is separate from native `allowed-once` target authorization.
- Reuse matches rule semantics, tool definition, configuration source, owner/generation, realm and live session identity. Uncertain/non-reusable contributions keep asking. Disposal, plugin retirement and policy invalidation revoke memory; a restored Agent with the same session ID does not inherit it, and children do not share it.
- Independent downstream asks, native deny/never, readonly and role ceilings still apply. Rule memory does not itself authorize a later sandbox-widening request or become a reusable native target grant. Command-pattern Allow configuration and remembered Ask contributions remain distinct.
- `test/command-approval.test.ts` and `test/git-command-approval.test.ts` cover reuse, compound rules, source changes, independent refusals, identity changes, cold resume and later widening requests.

## Deferred: scoped long-lived authorization and model proposals

The [permission-control design](superpowers/specs/2026-10-23-unified-permission-control.md) defines two independently configured lanes with one rule model and a consistent operator experience:

The extension must preserve the existing interception scope. Native reads that do not ask must continue without an added gate; generic or independently sourced approvals cannot be treated as outside-read authorization. Mode-bounded command auto-authorization remains a separate deferred item below, not a delivered guarantee.

- **Additional protection:** Existing guards detect configured operations, such as writable Git actions, and submit their existing approval requirements through DSH. The extension does not expand that interception set.
- **Native-request authorization:** DSMM automatically answers DSH-intercepted requests according to authorization rules. The primary extension is explicit operator-created live-session grants for this lane, not just remembering the first lane's command-rule asks.
- Share tool, command/subcommand and path selectors, parsing, matching and scope presentation across the lanes. Keep configuration, rule effects and authorization sources separate; authorizing one lane must not implicitly satisfy an independent requirement in the other.
- Allow the user to approve one call or a displayed scope for the live session, inspect active grants and revoke them. Models may propose tool/command/subcommand/path or full-access authorization with a reason, but cannot grant it or silently alter saved policy. Grants stay in memory for the live Agent/Host lifetime, without persistence, restore or automatic child inheritance.
- Each matching DSH request would receive a fresh native decision. A live grant would authorize future matching answers, not reuse a prior `allowed-once` result or change standing sandbox permissions. Command/subcommand/path long-lived scopes and model proposals remain deferred rather than introducing a separate approval owner and grant-management subsystem on rc.2. Reassess after DSH provides simpler scope, lifetime and revocation contracts.
- Native rc.2 client decisions remain once/reject. The additional scope choice and grant management require plugin interaction work, not a DSH package replacement or a button-label change. Preserve native request ownership, cancellation, final same-call manual approval, native never/deny and role ceilings.
- Display path scope and execution mode separately. Full access permits OS-allowed writes outside the workspace and is not a directory grant. Precise path/tree authorization is available only with native enforcement shared by file tools and shell; unsupported scopes cannot silently fall back to full access.
- Acceptance covers both request origins, independent configuration with shared matching, explicit operator consent, model proposals, matching/non-matching requests, revocation and expiry, and the native permission ceilings. Existing first-lane rule memory is not proof that this second-lane extension is complete.

## Upstream watch: native command authorization scope

- **Deferred on DSH `0.2.1-rc.2`.** Observe whether a public native API binds a tool registration or approval request to the execution body's actual registration context, effective sandbox policy and executor identity. The current registry lookup and `approval/request` payload do not expose enough provenance to establish that binding for directly loaded native shell tools.
- Preserve direct loading of native bash/pwsh, including aliases and custom compositions. Do not replace them with a separate DSMM tool set, copy their execution logic, require migration to adapters, or silently remove existing automatic-approval support.
- The target is configuration-derived elevation only in actual standing `workspace-write`, with no configured writes in `read-only` and no redundant approval in standing full access. Preserve native deny/never/cancellation, independent approval requirements and the finality of manual approval for the same call. This mode-boundary correction is not delivered; existing permission behavior remains unchanged.
- Reassess when a supported public source-binding contract becomes available. Verify direct native loading, scoped policy/executor differences, aliases, loading order and asynchronous mode changes through actual approvals and executor policy before implementing. Do not infer authority from tool names, reason text or a controller's unrelated scope, patch Host packages, or upgrade DSH automatically.

## Planned: external-path grants and native temporary-directory policy

- Outside-workspace read policy and native external write/edit refusal already exist. Configurable exact-path/tree grants remain subject to enforcement shared by file tools and shell execution.
- Temporary-directory access follows the full default allowance of the selected DSH mode and backend. DSMM does not narrow that allowance to a dedicated `temp/dsh` subtree. Preserve readonly and explicit deny rules; permission to use temporary storage does not authorize deleting unrelated temporary files.
- Describe each backend's actual temporary-directory scope accurately. Windows child-process `TMP`/`TEMP` may point to a private session/workspace directory; native file-tool allowances and process confinement must not be presented as identical without evidence.
- DSH `0.2.1-rc.2` has no additional writable-root field. DSH `0.2.2-rc.1` exposes `additionalWritableRoots`, but its bundled Windows ACL backend rejects additional writable directories. On `0.2.2-rc.3`, additional directory grants authorize native `write` and `edit`; Windows PowerShell, terminals and PTC retain workspace/private-temp access. File-tool and process enforcement are separate, and the Windows backend reports partial enforcement. Single-file and independent read/write grants remain separate capability gaps.
- Broader path support requires public Host enforcement, readonly preservation, path/link validation and rejection of adjacent unapproved locations. Unsupported scopes must not silently become full access or a private ACL framework.

## Deferred: granular sandbox access switches

- Investigate independently controlled sandbox capability extensions in a later task. This capability is outside the current implementation scope; do not add configuration fields or UI switches that have no enforceable effect.
- The intended system-certificate compatibility extension is enabled by default once a supported, verified implementation exists. Disabling it must remove that extension for subsequent executions without changing unrelated sandbox policy. TLS certificate verification stays enabled in both states.
- First establish the cause of Windows curl/Git Schannel failures and the exact required objects, endpoints and access rights. `SEC_E_NO_CREDENTIALS` alone does not identify a missing certificate-store path or prove which permission is needed.
- DSH `0.2.2-rc.1` exposes file-effect modes and directory roots, not per-process certificate, CNG or RPC endpoint grants. A certificate extension requires a supported Host/runner/native-helper mechanism; adding a DSMM boolean or writable directory cannot supply it.
- Any Host/native-helper work is separately scoped. Do not modify the installed runtime, system-wide endpoint ACLs or certificate stores, silently change TLS backends, disable verification or broaden to full access as a default remedy.
- Acceptance requires isolated Windows curl and Git Schannel execution with the extension on and off, preserved TLS verification, rejection of unrelated external writes, readonly preservation and clear configured-versus-effective capability status. Unsupported backends remain explicit; no success claim comes from saving a setting alone.

## Upstream follow-up: Windows Git Schannel

- Track the sandbox/Schannel incompatibility reproduced with DSH `0.2.1-rc.2`; an upstream fix is not yet confirmed. Details and the explicit per-command OpenSSL workaround are in [runtime limitations](runtime-recovery.md#known-host-limitation-windows-sandbox-and-git-schannel).
- On a candidate DSH update, verify Git HTTPS with Schannel through both native and DSMM-managed `workspace-write` execution, while retaining denial of unauthorized external writes. Do not disable certificate validation, silently change TLS backends or relax sandbox restrictions to obtain a passing result.

## Delivery priorities and Host dependencies

- **Current-Host acceptance:** check native composer draft and attachment continuity across Profile selection; review uncovered settings UI states and fix concrete findings.
- **Environment acceptance:** the native LSP switch, tool withdrawal from resident Agents and read-only restrictions are covered. Linux RC5 acceptance with `gopls` covered definition, references, cross-file rename and refusal of rename/format for a read-only reviewer. Go diagnostics remain unverified on Linux; the tested Windows `ocmm-lsp` passed a `file:////%3F/C:/…` URI to `gopls`. Historical sample coverage is likewise separate from implementing a reader.
- **Permission follow-up:** observe native registration/approval source-binding APIs before revisiting mode-bounded automatic authorization; preserve existing direct-native compatibility without replacement tools. Long-lived command/subcommand/path grants, model-proposed scopes and their management UI are also deferred pending simpler supported DSH contracts. Existing command configuration and command-rule memory remain distinct capabilities. Precise path enforcement remains a separate Host dependency.
- **Await supported Host contracts:** exact external write/tree grants shared by file tools and shell; safe configuration changes during active execution; same-activation delivery transfer; non-disruptive plugin replacement; and a complete catalog-backed raw prepared-call seam. Existing catalog helpers and hot reload do not supply those stronger guarantees. Broader continuation also needs supported historical persona/composition handling and route-aware image preflight.

Reassess deferred capabilities against concrete public Host API changes. A newer release within the supported range does not by itself establish that the missing contracts or their acceptance evidence are available.

The [DSH 0.2.2-rc.1 adaptation summary](superpowers/plans/2026-11-05-dsh-0.2.2-rc1-adaptation.md) defines the delivered dual-Host behavior, verification and remaining limits. Later RC or stable releases require exact-version interface and runtime verification before broader compatibility claims. Deferred capabilities remain subject to their public Host contracts.

## Publication and Desktop installation

0.3.17 publication uses the version-bound [release controls](releasing.md). Desktop plugin installation follows publication, uses the Desktop-owned carrier and requires DSH `>=0.2.1-rc.2 <0.3.0`. Installation doesn't authorize upgrading the Host, changing credentials or real sessions, altering unrelated configuration, or restarting active work. An incompatible Host or required data migration blocks installation rather than expanding its scope.
