# DSMM roadmap

## Version policy

**DSMM 0.3.13 targets exactly DSH `0.2.1-rc.2`.** Each DSMM version targets the published DSH RC or stable release selected for that version. Older SDKs and old configuration schemas aren't runtime compatibility targets. Loading sessions created by DSMM `0.2.x` is a required compatibility target, separate from retaining old runtime implementations or execution behavior. A newer upstream release requires deliberate reassessment, not an automatic dependency or runtime switch.

Published `0.3.0` retains its original rc.1 package, tag, assets and version-bound release identity.

## Current capabilities

Official AgentRegistry, SubagentRuntime and JSONL namespace plugins own execution and storage. DSMM supplies immutable admission, roles, routing and scoped policy without a custom execution owner, persistence companion or manual-runtime selector. Coding delegation consumes native activation results and cancellation; live direct-child controls use native ownership and capabilities, while descendant inspection remains read-only.

Deployment configuration uses native Plugins forms and separate sparse Global/native-profile layers. Named Profiles preserve draft, saved revision, future default and current admission as distinct states. Global/store CAS, native form revisions, filesystem protection, operator authority and RPC lifetime checks retain their own boundaries. Desired values don't update mounted services or running task policy. Save/future-default selection, model selection, mode changes and overlay Apply have independent capabilities.

The Profile editor has a single-column main form, direct basic settings and orchestrator model controls, a separate Agent-model dialog, independently collapsed advanced settings and JSONC, and Save/Discard/Reload with validation, conflict and focus handling. The page structure and controller behavior are implemented; browser acceptance is distinct from adding these features.

Supported root and continuable-child reactivation preserves native session identity and history while rebuilding admission from current deployment settings and the current content of the selected named profile. Cold children resume through native ownership, use current role routing and restrictions, and do not inherit historical approvals. Already resident Agents retain their admitted configuration. The cross-Host regression in `test/native-session-resume-refresh.test.ts` covers original root/child IDs, changed routes, readonly enforcement, disabled-role refusal and fresh approval requests; this is implemented behavior, not a pending restoration feature.

Agent-scoped skills expose metadata and load bodies lazily, preserving non-DSMM ancestor winners. Standard model calls use native prepared calls. The minimal public Pi-AI completions seam supports raw/custom and stop-only parameters for self-contained literal or explicit model-mapping configurations. Catalog-backed raw combinations that can't be reliably reproduced are rejected for both native and DSMM parameter sources; standard calls and native effort encoding remain unchanged.

Native call views show the target in collapsed rows, distinguish requested from actual identity, and retain that distinction for partial output, failure, interruption and current-format replay/PTC. Child labels use `Coding: task description`.

## Remaining capability boundaries

| Capability | Current behavior | Requirement for broader support |
| --- | --- | --- |
| Profile selection before execution | An existing blank root session can select a saved profile or deployment defaults before execution begins, including a retained native blank on the new-session page. With no session ID, the current menu disables selection. | Add selection before a session exists and carry it into creation without losing the unsent draft or changing future defaults. |
| Live overlay Apply | Apply is implemented for eligible blank, unstarted root sessions. It is unavailable after execution has begun or while work is active; saving and future-default selection remain separate actions. | Exact configuration/call/approval binding for an already-started session without cross-call authority reuse. See [approval boundaries](deferred-native-approval-risk.md). |
| Running-call background handoff | Unavailable. Select waiting or native parent delivery before starting; don't restart a task to simulate transfer. | A supported same-activation ownership/delivery handoff. |
| Restricted-role continuation after restoration | Supported roots and continuable children receive fresh admission through awaited `agent/created`, with current role, parent, readonly, tool and depth checks. Historical approvals do not grant current authority. | Broader historical-format support needs public control of persisted persona/composition and pre-activation restoration boundaries. Cold-child image preflight can still inspect historical `agent.options` before current routing takes effect. Unresolvable presets and missing or unsafe identity remain refused; see [recovery boundaries](compatibility.md#native-history-composition). |
| Non-disruptive hot update | No uninterrupted live-session guarantee. Retire admissions and let native owners cancel/dispose owned work; guards remain fail-closed. | Native lifecycle support that preserves active task/approval boundaries. |
| Catalog-backed raw combinations | Rejected where the complete composition can't be reliably reproduced, regardless of native or DSMM parameter source. Standard calls aren't affected. | A public seam that can reproduce the full catalog composition and preserve native capability/effort semantics. |
| Repeated command approval | Eligible DSMM command-rule approvals are remembered for the exact live Agent. Independent native/downstream asks, non-reusable rules and sandbox widening can still require approval. | Diagnose the exact command, working directory, contributing rule and approval reason; do not expand Allow rules merely to suppress a prompt. |
| PowerShell Fake-IP access | Verified HTTPS through the current Mihomo Fake-IP route with Node/OpenSSL in native and DSMM `workspace-write`; Windows curl/Schannel fails in both sandbox paths. | Upstream Windows sandbox/Schannel compatibility; configured proxy-environment propagation remains unverified. See [network limitations](runtime-recovery.md#powershell-in-a-fake-ip-environment). |
| External LSP | A startup mounting path exists when Deepwork and `lsp.enabled` are enabled, with a trusted Host install anchor, native MCP client and discoverable tools. LSP defaults to disabled; saving configuration doesn't remount the running integration. | Verify the bridge in the target Host with separately supplied executables and language servers. The integration test skips without its Host anchor; tool discovery alone doesn't establish working language-server operations. Native DSH LSP and independently configured MCP remain separate, and readonly roles don't gain rename/format authority. |

Search/Fetch retain the explicitly configured native provider. DSMM doesn't automatically enable a direct API, change credentials or forward the recent human question. HTTP Fake-IP behavior and network limits are maintained in [Fake-IP fetch](web-fetch-fakeip.md).

## Current: native history loading, including the DSMM 0.2.x compatibility target

Historical-session loading uses the existing native DSH reader, not a pending DSMM migration subsystem. `ApiSessionList.list()` reads `sessionQuery.listSessions()`; `SessionHistoryController.page()` reads persisted events without activating an Agent. These paths do not require a historical DSMM preset to resolve or a DSMM admission to succeed. Titles are folded from stored events, and history pages expose conversation events, including tool results.

- DSH `0.2.1-rc.2` includes session-format codecs v0–v4 and their migration chain. These are DSH storage-format versions, not DSMM package versions. Records must satisfy the native format and metadata requirements; the current history API requires `cwd`. Unsupported formats or invalid records remain distinct from unavailable execution capabilities.
- Loading sessions created by DSMM `0.2.x` remains a compatibility requirement. The loading mechanism is implemented; there is no identified missing DSMM reader to build. Coverage of representative `0.2.x` root/child artifacts is not established by the existing earlier-`0.3.x` legacy-session test. That is a sample-coverage limit, not evidence that history loading is unimplemented or requires a newer Host.
- Historical list entries, titles, messages and tool results must remain readable independently of continuation. Native follow/promotion and Agent resume are separate execution paths: retired presets or unsafe identity may prevent continuation without constituting a history-decoding failure. Continued execution uses current restrictions and fresh authorization, never historical approvals as current authority.
- Preserve original records. Any necessary migration must protect user data with a recoverable original and concurrent-write safeguards. Corrupt or genuinely unreadable data must produce a specific diagnostic rather than silently removing the session. Compatibility checks should exercise native list and read-only history independently from continuation.

## Current blank-session selection; remaining pre-creation selection

Existing blank root sessions support configuration selection and installation before the first request. The conversation header menu and Settings session scope use this path. `test/client-profile-editor.test.ts` covers selection on the new-session page with a retained native blank, and `test/session-profile-runtime.test.ts` covers first-request routing and execution-state guards. This flow is implemented, not a pending new-session feature as a whole.

- The remaining functional gap is selection when no session exists: `SessionProfiles` disables its menu without a session ID and the Settings session scope shows a hint instead of a selector. Provide a pre-creation choice and carry it into the admission used by the first request.
- Current DSH provides `session-maybe` conversation slots and `ClientSessions.create()` for creating or reusing a blank session. A pre-session selector can retain the choice, obtain the native blank and complete the existing DSMM selection transaction before allowing the first send. This is a medium-sized client integration on the current Host, not a dependency-upgrade prerequisite. Preserve native navigation and draft ownership; creating a blank alone does not prove that text, references and attachments survive the transition.
- Preserve the existing separation between this session's choice and future defaults, current permission checks, and rejection once execution has begun. The chosen configuration must govern the first request and subsequent delegated work.
- Verify the complete native new-session flow, including unsent text and attachments, selection feedback and first send. Controller/composer blocking during selection does not by itself establish draft preservation across session creation. Do not show a “new session required” instruction where the required action is unavailable.

## UI acceptance: simpler DSMM settings

The Profile redesign, deployment section navigation and initial expansion behavior already exist. The remaining work is a complete review of actual UI states and fixes for concrete findings, not reimplementation of the page. `test/client-named-profiles-browser.test.ts` exercises the production Profile section in an isolated browser shell when Host and Playwright anchors are supplied; it does not establish the full native conversation-header/new-session experience or every deployment drawer.

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

## Planned: unified rules and live-session native-request authorization

The [permission-control design](superpowers/specs/2026-10-23-unified-permission-control.md) defines two independently configured lanes with one rule model and a consistent operator experience:

- **Additional protection:** DSMM detects operations DSH would otherwise permit, such as configured writable Git actions, and submits an additional approval requirement through DSH. This remains governed by its own guard configuration.
- **Native-request authorization:** DSMM automatically answers DSH-intercepted requests according to authorization rules. The primary extension is explicit operator-created live-session grants for this lane, not just remembering the first lane's command-rule asks.
- Share tool, command/subcommand and path selectors, parsing, matching and scope presentation across the lanes. Keep configuration, rule effects and authorization sources separate; authorizing one lane must not implicitly satisfy an independent requirement in the other.
- Allow the user to approve one call or a displayed scope for the live session, inspect active grants and revoke them. Models may propose tool/command/subcommand/path or full-access authorization with a reason, but cannot grant it or silently alter saved policy. Grants stay in memory for the live Agent/Host lifetime, without persistence, restore or automatic child inheritance.
- Extend the existing exact-request answerer so each matching DSH request receives a fresh native decision. A live grant is authority to answer future matching requests, not reuse of a prior `allowed-once` result or a change to standing sandbox permissions. This can use current Host extension points; the entire capability need not wait for native remembered grants.
- Native rc.2 client decisions remain once/reject. The additional scope choice and grant management require plugin interaction work, not a DSH package replacement or a button-label change. Preserve native request ownership, cancellation, final same-call manual approval, native never/deny and role ceilings.
- Display path scope and execution mode separately. Full access permits OS-allowed writes outside the workspace and is not a directory grant. Precise path/tree authorization is available only with native enforcement shared by file tools and shell; unsupported scopes cannot silently fall back to full access.
- Acceptance covers both request origins, independent configuration with shared matching, explicit operator consent, model proposals, matching/non-matching requests, revocation and expiry, and the native permission ceilings. Existing first-lane rule memory is not proof that this second-lane extension is complete.

## Planned: external-path and temporary-directory grants

- Outside-workspace read policy and native external write/edit refusal already exist. The missing capability is configurable exact-path/tree grants, particularly external writes and dedicated temporary-directory writes, consistently enforced by file tools and shell execution.
- Reassess the available public DSH interfaces before choosing an implementation. This capability remains deferred rather than blocking command-pattern or configuration improvements.
- Target independent read and write permissions for exact paths or directory trees: normal workspace writes, configured external reads, and writes only to explicitly authorized external locations. A dedicated system-temp `dsh` subtree is a useful opt-in scope for creating, editing and cleaning Agent-owned temporary files; it must not grant access to the entire system temp directory or authorize deleting unrelated files.
- DSH `0.2.1-rc.2` has no additional writable-root field in its standard execution policy. Its Windows backend supplies a private per-session/workspace `dsh-*` directory through child-process `TMP`/`TEMP`; this is neither a configurable fixed `temp/dsh` grant nor proof that native file tools share the same allowance.
- Broader support depends on public Host path-grant interfaces consumed consistently by native file tools and shell confinement. Preserve readonly, resolve path/link boundaries, and verify that adjacent unapproved locations remain unwritable. Do not expose a nonfunctional setting, substitute full access, or implement a private ACL framework in DSMM.

## Upstream follow-up: Windows Git Schannel

- Track the sandbox/Schannel incompatibility reproduced with DSH `0.2.1-rc.2`; an upstream fix is not yet confirmed. Details and the explicit per-command OpenSSL workaround are in [runtime limitations](runtime-recovery.md#known-host-limitation-windows-sandbox-and-git-schannel).
- On a candidate DSH update, verify Git HTTPS with Schannel through both native and DSMM-managed `workspace-write` execution, while retaining denial of unauthorized external writes. Do not disable certificate validation, silently change TLS backends or relax sandbox restrictions to obtain a passing result.

## Delivery priorities and Host dependencies

- **Current-Host work:** complete the no-session Profile selector and first-send/draft handoff; review settings UI states and fix concrete findings. The former is medium-sized integration work; the latter is bounded UI acceptance, not a page rebuild. Neither requires a new DSH version.
- **Environment acceptance:** exercise the existing LSP bridge with an explicit Host anchor, supplied executable and real language server. This verifies an implemented integration rather than adding a new mounting mechanism. Historical sample coverage is likewise separate from implementing a reader.
- **Permission extension:** prioritize live-session authorization of DSH-intercepted requests through the existing exact-request answerer, with explicit operator choice, model proposals and revocation. Additional DSMM protection and native-request authorization retain separate configuration but share rule semantics and presentation. Native remembered-grant support could simplify integration; it is not a prerequisite for every supported automatic answer. Precise path enforcement remains a separate Host dependency.
- **Await supported Host contracts:** exact external write/tree grants shared by file tools and shell; configuration/call/approval binding for started-session Apply; same-activation delivery transfer; non-disruptive plugin replacement; and a complete catalog-backed raw prepared-call seam. Existing catalog helpers and hot reload do not supply those stronger guarantees. Broader continuation also needs supported historical persona/composition handling and route-aware image preflight.

As of 2026-10-23, the public [DSH master comparison](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.1-rc.2...master) is identical to `dsh-v0.2.1-rc.2`, with no commits ahead. The latest [release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2) is rc.2, published 2026-10-17; npm `latest` and `next` also resolve to rc.2. `alpha.5` predates that baseline. No newer public upgrade target or delivery commitment for the missing contracts is established. Reassess concrete API changes when published, rather than waiting for a version label alone.

## Publication and Desktop installation

0.3.13 publication uses the version-bound [release controls](releasing.md). Desktop plugin installation follows publication, uses the Desktop-owned carrier and requires exact DSH `0.2.1-rc.2`. Installation doesn't authorize upgrading the Host, changing credentials or real sessions, altering unrelated configuration, or restarting active work. An incompatible Host or required data migration blocks installation rather than expanding its scope.
