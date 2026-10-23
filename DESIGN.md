# DSMM native client design system

## 0. Native contract

This extends the native DSH 0.2.1-rc.2 Settings and Plugins interface, not a new application or redesign. Native tokens and components remain authoritative; no unrelated brand, font, styling framework or animation dependency is needed.

The native reference packages are `dsh-client-ui-theme`, `dsh-client-ui-primitives`, `dsh-client-ui-settings-general`, `dsh-client-ui-settings-models` and `dsh-client-ui-settings-plugins`. Relevant sources are `ui-theme/src/styles/{base,design-platform,focus}.css`, `ui-primitives/src/{Button,Input}.module.css`, and the Settings/Models section CSS in their published client bundles. The values below describe the shipped default theme; installed theme overrides remain authoritative. DSMM doesn't change vendor code, theme or user configuration.

DSMM 0.3.16 targets exactly DSH `0.2.1-rc.2`. Its settings extend public native slots and preserve native authentication, navigation, model selection and service ownership.

### Product priorities

**Never overengineer. Without breaking business logic and within permitted boundaries, user experience takes precedence over stricter theoretical correctness.**

- Follow established practice and DSH's normal design, business flows and public extension points. Preserve native history loading, reading and restoration, model selection, subagent/provider lifecycles and plugin compatibility. Do not change DSH's business contracts or require unrelated plugins to adopt DSMM-specific protocols.
- Allow reasonable, otherwise permitted use even when a stricter threat model would label it unsafe. Speculative risks or an inability to prove every edge case safe are not sufficient reasons to block normal use, add approvals or disable native capabilities.
- Choose the smallest practical solution. Do not introduce frameworks, lifecycle machinery, compatibility requirements or validation gates unless a concrete business requirement or demonstrated defect needs them. A limitation in DSMM must not become a restriction on DSH's normal operation.
- If precise implementation is impractical within the current Host's supported capabilities, use a coarser-grained but useful implementation that preserves normal business flows, or defer the feature and reassess after DSH updates make it simpler to implement. State the actual coverage and limitations; do not present a deferred feature or an unsupported guarantee as implemented, or build intrusive infrastructure merely to claim completeness.
- Preserve existing user authorization and real data-integrity and permission guarantees. Do not invent stronger guarantees and then treat normal native behavior as a violation; make necessary safeguards proportionate to the actual risk and keep nonblocking information nonblocking.

Native history loading, reading, promotion, explicit and declarative restoration, and durable restoration after provider unregistration follow DSH's own rules. DSMM doesn't add a global restoration gate or require other plugins to implement a new admission protocol. DSMM-controlled live objects and DSMM entry points still check their current owner and applicable permission ceilings. Historical metadata isn't current DSMM authorization. Restricted-role continuation can lose DSMM-specific restrictions on restoration; preserving those restrictions across restoration isn't guaranteed on the current Host and is deferred until supported extension points can enforce them without disrupting native flows. A restored native session must not be presented as automatically holding valid DSMM role admission. This limitation doesn't gate ordinary configuration or UI saves.

## 1. Atmosphere & Identity

### Native Plugins configuration

The canonical entry is native sidebar **Plugins → DSMM bundle**. DSMM registers
only `plugins.bundle.config` with package key `@dsmm/dsmm`; the native owner passes
`view`, not a form. Core configuration is available without `configForms`. The
authenticated snapshot's namespace resolves the optional native form; exact
entry, profile, connection, mode, writable state, base/user values and form
revision must agree. Absent, stale or mismatched forms are explained as read-only,
never replaced with a guessed namespace or a Global write.

One scope selector chooses **DSMM Global config** (the trusted Home's shared
base) or **Current DSH profile overrides** (the current native entry). The content
below it is one flat page with five named sections: **Run and modules**, **Model
routes and recovery**, **Workflow, roles and subagents**, **Permissions and
safety**, and **Configuration state**. Subagent settings appear as a labeled group
inside the workflow section. An **Other / advanced** section is appended only when
the Host schema exposes a field that no named section owns; fields are never
dropped to keep the section count small. Every editable schema field belongs to
exactly one section. Deepwork master is Global-only; mounted startup capabilities
remain separate from desired values. Official native services own persistence.
Named **Deepwork Profiles** remains in its independent Settings/header surface.
Configuration browsing and saves do not select a profile, change a native model,
create a session or call a provider.

Official AgentRegistry, SubagentRuntime and JSONL namespace plugins own execution
and storage. There is no custom-owner/manual-runtime selector or companion setting.
Observed native availability, saved desired values, mounted capability, Agent
admission and restart state remain distinct. A responding root isn't proof of child
execution or every control capability. The UI doesn't select a storage owner,
edit persistence bindings or suppress actual Host errors. Core remains available
without a session or active Deepwork.

Each scope saves sparse explicit values. In Global scope, Unset restores built-in
defaults; in profile scope, Unset inherits Global plus Host base pins. Same-default,
false and empty-array pins remain explicit. Boolean/enum/number/string controls cover
ordinary fields; a bounded, schema-described JSON editor covers nested objects that
have no dedicated structured control, while rule arrays and exact command entries use
structured records with schema-validated editing. Objects expose an explicit
whole-group Unset, including empty native policy containers. It removes only that
layer's chosen group and its raw child drafts; leaf Unset leaves unrelated overrides
intact.
No merged/default-filled document, unknown field or executable schema callback is
submitted. Native commands support simple command/subcommand pattern strings (e.g., `git`,
`git status`, `go test`). New entries are entered as a clean command string with add and remove actions,
without extra ID, tool, working directory, sandbox or action selectors. Legacy structured entries
are displayed as a compact read-only summary showing the original command and identifiable constraints
(tool, cwd, ask/sandbox details) alongside a delete button, without lossy conversion or silent permission widening.
Observed tool registration is not executor, environment or sandbox certification.

The **Permissions and safety** section holds two independent transactions. The
configuration transaction edits the selected Global/profile layer — deployment
guards, permission switches, outside-read and web defaults, imported configuration
rules and exact native command entries — and is available without a main session;
its write authority still comes from the Host, never from the presence of a
connection, Root or local UI state. The Global-rules transaction requires a trusted
open Root, writable operator, synchronized policy and current
registration/controller; child/readonly/disconnected/unsynced/profile-override
refusals are visible and affect only this transaction. Saves persist Global rules for
contexts using that policy; the UI never describes them as session-private. There is
no cross-scope Save all or fallback Global write. The selected config scope's save bar
lists all its pending sections. Saved/startup/next-root/current admission are separate
inspector states; missing session data is unknown.

LSP controls are hidden in DSMM's settings UI for this version. The implementation,
interfaces and original configuration remain, but automatic MCP mounting stays off
even with `lsp.enabled:true`. A save or independent restart doesn't enable it.
DSH's own LSP and independently configured MCP are unaffected; the retained manual
patch isn't a supported DSMM activation entry. See [LSP boundary](docs/lsp.md).

Read-only desired/startup/admission projections redact executable configuration,
private directories and continuation prompt text on the Host, before transport.
LSP environment names are anonymous counted entries; source/capture metadata is
aggregated at `lsp.env` (mixed is explicit), never credential-bearing key paths.
Only the authenticated editor's sparse input/provenance retains editable raw
values. The inspector takes a stable sorted union of safe layers and their
source/capture paths: missing fields are absent, not defaults. Configuration versions
are ordinary metadata observations, not content-integrity proofs. UI distinguishes
observed, not-stored and unavailable states. Raw hashes, stat strings, internal CAS
counters, long source identities and epochs aren't presentation labels.

Drafts and invalid JSON/number/argument text live in contribution memory, isolated
by real source identity and connection generation, never localStorage. Switching
section, switching scope or leaving a pending confirmation offers Continue editing,
Keep draft and return, or explicit Discard. Native navigation unmount/remount
retains these drafts and their Save locks. Refresh does not merge dirty drafts or
silently rebase conflicts.
Accepted mutations remain committed when reread is unavailable: show Saved /
refresh required and block replay until refreshed. A native form result that
does not confirm mutation is explicitly unconfirmed, not proof of rejection;
retain the draft and require source reread before any retry. Source-version
relationships use optional `sourceRevision`; missing metadata is unknown, not
equality between an immutable applied reference and a live source version. Save
never restarts, cancels, reconciles, applies a profile or mounts LSP. Cold-switch
text explains independent native restart and possible session cancellation.

The page uses one horizontal section tablist above a full-width content area at
every width, with no backdrop, focus trap or `aria-modal`; the navigation semantics
and layout rules are specified under Components and Spacing. Native typography,
colors, spacing, radii, focus and borders-only surfaces below remain authoritative.
Controls have visible focus, associated invalid hints, explicit unavailable/busy
reasons and polite commit announcements. Reduced motion retains the same hierarchy.
The contribution runs inside the native Plugins owner, not a separate application
shell.

A quiet, practical part of DSH: system typography, compact controls, a readable configuration editor, clear selection and explicit save outcomes. The independent named-profile section is displayed as **Deepwork Profiles** / **Deepwork 配置档**, without replacing navigation, opening another application shell or relabeling native agent presets as configuration profiles. Native role display names use `DW …`; technical section, RPC, package and role IDs retain their DSMM identity.

A page whose selected section has no fields explains that the current scope exposes
none and keeps the section reachable, rather than hiding it silently. Remember
explicit expansion choices within each configuration scope across saves, language
changes and reopening. Sections remain scannable; optional technical details stay
collapsed. Ordinary copy uses direct action and scope names, omits duplicate
headings and implementation explanations, and keeps necessary permission
consequences, unsaved-draft warnings and recovery actions.

## 2. Color

Use these host CSS variables in components. The light/dark values are extracted defaults for reference only; do not hardcode them or change the host's theme attribute. Dark mode is owned by `body[data-ds-dark-theme]` and the native theme service.

| Role | Native token | Light default | Dark default |
| --- | --- | --- | --- |
| Field surface | `--dsw-alias-bg-layer-1` | `#ffffff` | `#232324` |
| Settings surface | `--dsw-alias-bg-layer-2` | `#ffffff` | `#2c2c2e` |
| Editor/group surface | `--dsw-alias-bg-module-platform` | `#f5f6f7` | `#353638` |
| Main text | `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` |
| Secondary text | `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` |
| Native muted text | `--dsw-alias-label-tertiary` | `#81858c` | `#adb2b8` |
| Native placeholder | `--dsw-alias-label-dimmed` | `#e1e5ee` | `#43454a` |
| Filled-button text | `--dsw-alias-label-primary-foreground` | `#ffffff` | `#0f1115` |
| Divider | `--dsw-alias-border-l2` | `#0000001a` | `#ffffff1f` |
| Outline | `--dsw-alias-border-l3` | `#0000001f` | `#ffffff29` |
| Native field/card stroke | `--dsw-alias-border-l4` | `#00000029` | `#ffffff33` |
| Business/focus accent | `--dsw-alias-state-business-primary` | `#4176e6` | `#7aaaff` |
| Error accent | `--dsw-alias-state-error-primary` | `#ec1313` | `#f25a5a` |
| Success accent | `--dsw-alias-state-success-primary` | `#22c55e` | `#22c55e` |
| Warning accent | `--dsw-alias-state-warn-primary` | `#f59e0b` | `#f59e0b` |
| Hover surface | `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` |
| Pressed surface | `--dsw-alias-interactive-bg-active` | `#2631481a` | `#ffffff24` |
| Primary action fill | `--dsw-alias-button-primary-fill` | `#0f1115` | `#f9fafb` |
| Primary action hover | `--dsw-alias-button-primary-hover` | `#43454a` | `#ebeef2` |

Host aliases `--dsw-alias-settings-card-fill` and `--dsw-alias-settings-card-stroke` resolve to layer-2 and border-l4. Use them only if an actual grouped surface is needed. No decorative gradients, new accent palette or colored status badges.

Required instructions, hints and status/error text use primary or secondary text, not a low-contrast accent. Native tertiary text, placeholder colors and thin strokes are not proof of accessible contrast; Section 8 governs their use. An error may have an error-colored accent while its message remains primary text. Color never carries state alone.

## 3. Typography

Inherit `var(--dsw-font-family)`:

`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif`.

Configuration content and exact identifiers may use `var(--ds-font-family-code)`:

`"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei"`.

Do not import fonts or use the host's Montserrat brand face for settings text.

| Use | Size | Weight | Line height | Source |
| --- | --- | --- | --- | --- |
| Section heading | 18px | 600 | Inherit; native section does not declare another value | Plugins section |
| Group/profile heading | 14px | 500 | 22px | Models editor title |
| Section tab label | 14px | 500 selected, 400 inactive | 22px | Body scale; selection also uses `aria-selected` and surface |
| Body, controls, required hints | 14px | 400 | 22px | Native Button/Input and Models controls |
| Configuration editor | 14px | 400 | 22px | Body scale with native code font |
| Technical key beside a human label | 12px | 400 | 18px | Native compact metadata; never the only heading |
| Optional nonessential metadata | 12px | 400 | 18px | Native compact controls; still subject to contrast checks |

Native settings also contain 13px labels and 12px hints. DSMM's own essential labels, instructions and errors use the 14px body scale. Use sentence case, readable Chinese/English copy, no all-caps decoration and no emoji icons.

## 4. Spacing & Layout

At narrow widths and 200% zoom, labels, legends and disclosure summaries wrap within their own available width (`overflow-wrap: anywhere`, `min-width: 0`, `max-width: 100%`); do not clip content or hide document overflow. Retry controls use readable English/Chinese field descriptions with units instead of raw camelCase backend keys. IDs and JSONC policy paths remain exact technical identifiers.

The native interface uses a 4px rhythm plus explicit compact-control exceptions. These named values are the allowed geometry references for DSMM styles, not newly exported host tokens:

| Name | Value | Use |
| --- | --- | --- |
| Tight gap | 4px | Icon/action adjacency |
| Field gap | 6px | Existing native label-to-control spacing; documented host exception |
| Small gap | 8px | Action group and related labels |
| Control inset | 10px | Native Models select/input horizontal padding; documented host exception |
| Section gap / field inset | 12px | Vertical rhythm, editable field padding |
| Group padding | 16px | Optional grouped editor surface |
| Host content inset | 24px | Owned by Settings shell; do not add a second shell inset |
| Field height | 32px | Native Input and Models select |
| Default action height | 36px | Native Button `size="md"` |
| Compact action height | 28px | Native Button `size="sm"`; not the default form action |
| Select / scope control width | 240px | Existing native select measure; bounded by available width |
| Section maximum width | 760px | Native Plugins content measure; DSMM uses the full available width within it |
| Narrow-width body | 100% | Content never narrows into a second column; only the tab strip scrolls horizontally |

Native radii: `--dsw-radius-xs` 4px, `--dsw-radius-sm` 8px, `--dsw-radius-md` 12px, `--dsw-radius-lg` 16px, `--dsw-radius-xl` 20px and `--dsw-radius-panel` 28px. Controls use md; DSMM does not create another panel.

The host owns its Settings panel, native Plugins shell, navigation and scroll containers. DSMM owns only its content area: one horizontal section tablist and one full-width section body at every width, wrapping action rows, full-width fields and contained editor overflow. The tablist scrolls horizontally when it cannot fit; it must not compress labels into truncation or create document-level horizontal overflow. A profile selector follows the native Models select's 240px maximum and obeys `max-width: 100%`. Long names and diagnostics wrap; code may scroll inside the editor but must not create document-level horizontal overflow. A textarea uses semantic rows and vertical resizing rather than a viewport-sized editor.

No new responsive framework or fixed sidebar. The layout is one column at every width; only density and wrapping change:

| Width | Configuration page behavior |
| --- | --- |
| 375px | Scope select takes the available width up to 240px; the scope line and status wrap. The tab strip scrolls horizontally with a visible edge cue and never shrinks labels. Groups, command rows and rule records stack their label above the control; action rows wrap with the primary action first and never clip. |
| 768px | Same single column and scrollable tab strip. Label/control pairs may sit side by side at the native 240px measure when the row has enough width; save-bar status and actions wrap as one group rather than splitting the status from its controls. |
| 1280px | Content keeps one readable column within the 760px measure; the tab strip fits without scrolling when labels allow. Extra width stays whitespace around the same single-column content. |

No breakpoint disables a control, hides a supported field or moves primary actions out of normal flow. Verify the section at 375, 768 and 1280px, including the narrower space the host navigation leaves. Do not claim the host shell's independent responsive behavior was changed or verified by a standalone section test.

## 5. Components

### Interaction states

Exercise these production components through the native owner in an isolated client context.

| Primitive | Default / hover / focus / pressed | Disabled / loading | Empty / success / error |
| --- | --- | --- | --- |
| Profile select | Named native `<select>`; keyboard selection; host-token focus ring | Disabled during selection commit; stable selected value | Explain no profiles; announce committed selection; refusal retains old selection |
| Profile name | Native `Input` with visible associated label; focus-within ring | Native disabled state only when mutation is pending | Required/invalid name message associated with the field; preserve draft |
| Configuration editor | Labeled native `<textarea>`; code font; visible focus ring | Prevent conflicting edits while save is pending; readable content | Explain expected overlay shape; preserve invalid/conflicting draft with actionable error |
| Save/create/select/reset actions | Native `Button`; clear action label; keyboard activation; visible ring | Native disabled plus busy label; no width-changing replacement | Announce actual commit; error does not masquerade as success |
| Status and diagnostics | Persistent semantic text in a stable position | Loading text and `aria-busy` where applicable | Distinguish unavailable service, empty store, conflict, validation and I/O refusal; offer relevant recovery |
| Structured route fields | Separate labeled editable provider/model/exact-effort comboboxes, each one native Input with a listbox and compact dropdown affordance; keyboard and pointer parity | Disabled while profile mutation is pending; catalog loading never replaces configured values | Suggestions retain actual IDs; arbitrary typed values remain exact. Explicit model changes clear stale effort, refresh does not |
| Ordered fallback rows | Numbered route groups and native add/remove/move buttons with route-specific names | Boundary moves disabled; preserve focus on the surviving row/action | Empty means an explicit empty chain; inherit is a separate choice; status explains draft-only changes |
| Role/profile strategy and retry fields | Explicit startup-lock/rate-limit-fallback/inherit selects and native bounded numeric inputs | Native disabled controls during mutations; inherited effective values remain readable | Invalid raw policy disables structured mutation without normalizing content; explicit inherit removes only the changed override |
| Advanced JSONC disclosure | Native keyboard-operable details/summary; same underlying draft as structured fields | Readable invalid draft retained during errors | Invalid JSONC refuses structured edits; unchanged comments/unrelated fields remain byte-preserved |
| Configuration field | One labeled native `<select>`, `<input>` or `<textarea>` with its hint and 2px focus ring; inherit appears only where the layer supports it | Disabled only during that layer's commit or a scope switch; inherited effective values stay readable as secondary text | Invalid raw text keeps the user's bytes with an associated error that locks this transaction's Save; Unset restores defaults in Global and inheritance in profile |
| Current-session profile scope | Shows this session's accepted configuration separately from the default for future sessions | Selection is available before execution begins; started sessions, stale views and conflicting commits remain protected | Keep the draft and current choice on refusal; an accepted change applies to the first request and delegated work |
| Compact Conversation profile menu | One icon-only native Button and portaled Menu, one profile list and one `@use-model` action; native keyboard selection, Escape/outside dismissal and focus return | Keep the trigger available to inspect reasons; compute model, mode and overlay capabilities independently, with per-action committing/session/idle/draft gates | Short sanitized errors inside the menu; successes only in a visually hidden live region, without visible success prose |
| Deepwork mode | Native menu toggle with independent capability; explicit same-default intent persists | Sessionless/busy/unavailable mutation disabled; DW persona remains inside its captured module ceiling | Official minimal defaults off, DW defaults on, explicit off wins; saved intent isn't current DSMM admission |
| Section navigation | Native `<button>` elements in a `role="tablist"`; inactive labels use secondary text at weight 400 with a `--dsw-alias-interactive-bg-hover` hover surface; the selected tab uses `--dsw-alias-interactive-bg-active`, primary text at weight 500 and a 2px bottom border in `--dsw-alias-label-primary`; every tab has the 2px business-color focus ring | Never disabled; activating a tab with a pending draft opens the shared confirmation instead | Empty sections remain selectable and explain why no fields are exposed; selection is conveyed by `aria-selected` and surface, not color alone |
| Configuration scope control | Labeled native `<select>`; keyboard selection; focus ring | Disabled while a scope switch, save, or leave confirmation is in progress, never for a background revalidation | Explain read-only profile and its recovery; refusal keeps the previous scope |
| Scope save bar | One primary Save plus outline Refresh and Discard-and-reload, positioned as a sticky action bar at the top of the active section panel matching settings surface tokens with compact symmetrical padding | Save disabled while its own save is in flight, clean, invalid, conflicted, or after an observed refusal made its base no longer authoritative; Refresh and Discard disabled while their own request or a save is in flight; a background revalidation never disables any of them | Status line names dirty, saving, saved, saved-refresh-required, conflict, offline and read-only; does not animate or replace layout; idle state does not reserve empty status line |
| Section loading state | Stable text block reserving its status line | First load and user-triggered refresh show `aria-busy` and a busy label; a save reports through its own status and controls; silent revalidation of a trusted snapshot never toggles `aria-busy` or disables controls | Unavailable, unknown and empty are separate texts; unchanged data stays editable, while data observed no longer current is marked stale and only its affected mutation is disabled |
| Native command rows | Clean command/subcommand string input with per-row remove, or compact read-only summary with details and delete for legacy entries | Row edits disabled while the layer is busy | Empty list states that no entries exist; invalid drafts keep text and lock Save |
| Imported configuration rules | Record list from the selected layer with a schema-validated import/advanced-edit form; host-token rows and focus ring | Editable only while that configuration layer is writable and idle; never gated on a main session or Root | Empty list states that the layer stores no rules; imported records show source kind and revocation, never a verified-approval badge |
| Global rule records | Records in fieldsets with edit and stage-revoke actions and no inline mutation | Editing disabled unless the Root is trusted, writable, synchronized and idle | Distinguish active/revoked, source kind, staging, unsaved draft and unsynced runtime; refusal keeps the draft |

DW presets default on but are not locked; explicit off retains persona, read-only and Git/host permissions. A captured module-off ceiling remains unavailable, not a profile-editable bypass.

### Configuration page

The page keeps the native Plugins entry and renders inside its content area:

1. **Scope bar** — one labeled select for **DSMM Global config** / **Current DSH profile overrides**, one short line naming the effective source and override relation, and the profile read-only reason when that form is unwritable. It never renames the independent named **Deepwork Profiles** editor.
2. **Section navigation** — `Run and modules`, `Model routes and recovery`, `Workflow, roles and subagents`, `Permissions and safety`, and read-only `Configuration state`. **Other / advanced** is appended only while an ungrouped field exists. Technical keys are secondary text next to human labels, never the only heading.
3. **Section body** — full width, one column, plain fields and groups. Ordinary fields are visible immediately; nested policy objects, advanced JSON and diagnostics are disclosures. Do not wrap each field in its own card or add a second hierarchy of nested collapsibles.
4. **Scope save bar** — positioned at the top of the active section panel (before module configuration content and State inspector) as a sticky bar using settings surface tokens (`--dsw-alias-bg-layer-2`) with compact symmetrical padding and non-colliding dynamic offset. Shared by all sections for the selected configuration layer, listing the pending section names, with one Save for that layer. Idle state avoids reserving whitespace for absent status. It never writes both scopes together, and the read-only state inspector never contributes drafts. The Global-rules transaction in **Permissions and safety** is a separate transaction with its own sticky bar at the top of the rules section, avoiding nested sticky occlusion via dynamic offset; rule drafts never appear in the scope bar and one transaction's pending state never disables the other.

Tabs use `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls` and a matching `role="tabpanel"`; roving tabindex keeps one tab in the tab order. Arrow keys and Home/End move focus only; Enter/Space activates the focused tab so a dirty-navigation confirmation is never bypassed. Activating a tab moves focus to its panel heading, and returning to the tablist moves focus to the selected tab. The tablist remains one horizontally scrollable strip at every width, keeping the same semantics; labels never truncate into ambiguity. The document must not gain horizontal overflow.

Localized labels stay parallel and short:

| Section | English | Chinese |
| --- | --- | --- |
| run | Run and modules | 运行与模块 |
| routes | Model routes and recovery | 模型路由与恢复 |
| workflow | Workflow, roles and subagents | 工作流、角色与子 Agent |
| permissions | Permissions and safety | 权限与安全 |
| state | Configuration state | 配置状态 |
| other | Other / advanced | 其他／高级 |

The scope select keeps its existing two labels, **DSMM Global config** / **DSMM 全局配置** and **Current DSH profile overrides** / **当前 DSH 配置覆盖**.

Scope switching, section switching and native navigation never save, apply or rebase. A pending or invalid draft opens the shared confirmation with Continue editing, Keep draft and return, and Discard; Escape cancels it and returns focus. Explicit expansion choices are remembered per scope across saves, language changes and reopening. On first visit to a scope the page opens the first section with editable fields for that scope, falling back to **Configuration state** when the scope exposes none; afterwards it restores that scope's last viewed section. **Configuration state** is read-only: it shows desired, startup, next-root and current admission values with its own Refresh action, contributes no draft, and never turns another section's pending edits into a save from this view.

The two configuration layers keep distinct controls. Global Unset restores built-in defaults. Profile Unset inherits Global plus Host base pins. Same-default, explicit false and empty-array pins stay visibly explicit. Group Unset removes only that layer's group and its raw child drafts. Arrays replace inherited arrays. Exact fields keep their Host spelling; the browser never normalizes paths. LSP stays absent from navigation while its stored document survives saves unchanged.

### Permissions and safety

The section presents two independent transactions. The configuration transaction uses the shared scope save bar; the Global-rules transaction has its own heading, controls, save bar and status line.

**Configuration scope** edits the selected layer: guards scope, shell safety, Git write policy, output truncation, plan validation, question labels, todo discipline, `permissionControl.enabled`, `outsideReads`, web search/fetch, imported configuration rules and command allowlist entries. It is always available for a writable Global layer, including without a main session. Enum choices come from the Host schema; nothing adds an option the schema does not support. Fixed selectors are `deepwork-or-dsmm-agent` / `always` / `off` for guard scope, `ask` / `deny` / `off` for Git write policy, and `inherit` / `allow` / `ask` / `deny` for outside reads and each web rule; boolean guards and numeric limits (`maxInlineBytes` in bytes, `maxLabelChars` in characters) keep visible units. `webSearch` and `webFetch` each expose `enabled` plus `rule`, and `nativeCommands.enabled` is a separate switch for the command list; stored entries remain visible and inspectable when the switch is off, with their inactive state explained. Turning off the Git guard neither approves a Git write nor bypasses read-only state.

`permissionControl.rules` is a clear record list with schema-validated import and advanced editing, not a provenance forger: the existing Host import path generates record source, and imported records are never labeled as verified approvals. Source/revision/revoked keep their real meaning. `permissionControl.enabled` explains desired-versus-mounted and restart consequences; saving never claims current protection was lifted. `outsideReads` and the web rules explain their layering and native boundaries without implying private-network access or outside-workspace writes.

Native command entries configure the command allowlist: new entries accept only the command/subcommand string (e.g., `git`, `git status`, `go test`) with add and remove actions, free of ID, tool, cwd, sandbox, action selectors, stacked explanations, or repeated override labels. Matching a simple command rule executes with full access automatically for that invocation, while unmatched commands follow the ordinary policy path. Legacy structured object entries are rendered as a compact read-only summary showing the original command pattern and identifiable constraints (tool, cwd, ask/sandbox differences expandable in details) with a delete action, preserved losslessly without automatic conversion or permission widening. Empty or invalid draft entries lock Save, and row removal safely reindexes remaining drafts without data loss.

**Global rules through the selected main session** shows the session/connection/synchronization state, the rule list, the rule editor and its own Save, Discard and Refresh. Copy states that saving persists Global rules affecting contexts that use that policy; it never labels them session-private. Available changes are `outsideReads`, `webSearch` and `webFetch`; `upsert`/`revoke` manage rule ID, action and match. Rule actions are `allow`, `ask`, `deny` (record actions never accept `inherit`); matches are exact outside-read path with exact/tree scope, exact shell executable + command + working directory, or a web tool. The editor sends no invented source or revision. Revoked records remain visible as revoked. A profile override blocks this transaction only; it is cleared by editing or Unsetting that value in the profile scope and refreshing, never silently.

The rule editor is a plain labeled form, not a modal. Staged upserts and revocations are listed with a per-row remove action, and Save is disabled while the draft is clean, the editor is open, a conflict exists or the runtime is unsynchronized. Records show action, match, source kind and active/revoked state without inventing verification. Root state, rule presence/absence, capability and synchronization are separate statements: a connected Root with no rules is empty, not unknown, while missing capability data stays unknown.

Coverage, registration limits and capability caveats sit in a collapsed **Details** disclosure. Essential consequences, refusals, conflict and unsaved state stay outside it. Missing capability data is unknown, never an empty or safe state. Allow never overrides a native `ask`/`deny`, native sandbox, read-only or role ceiling. A saved rule revision with an unsynchronized runtime is reported as unsynced, not as fully enforced.

### Reading, saving and conflict states

Loading is split from transport activity so that background work is invisible unless it changes what the user can do. The configuration-layer editor loads once on entry and rereads through its explicit Refresh. The Global-rules panel reads on opening, changes to its session/owner/connection binding, and explicit Refresh; it does not poll. Save uses the returned result without scheduling another read.

- **First load / no trusted authority** — stable status text with `aria-busy`, one busy label, and no stale controls presented as current.
- **User-triggered Refresh or retry** — its own visible busy state on that action and status line.
- **Silent revalidation of a trusted snapshot** — no spinner, no `aria-busy` flip on the section, no live-region announcement, no dismount, and no disabling of inputs or Save. Focus, drafts, expansion and scroll position remain untouched.
- **Save** — cancels or invalidates unfinished background reads, keeps the existing `expectedRevision` field mandatory, and relies on CAS plus Host verification. A late read cannot overwrite the accepted result.
- **Current authority** — native session and connection notifications immediately fence affected operations. Other external policy or runtime changes become visible on the next read or save; the UI does not promise continuous observation. The Host checks current ownership, writability, runtime state and CAS for each mutation. An observed refusal disables only the affected mutation, keeps the draft and marks the visible data as no longer current.
- **Identity fencing** — responses and saves are accepted only for the exact owner object, session ID, scope and connection generation that started them, in request-sequence order, with abort and disposal invalidating earlier work. A replaced owner with an unchanged session ID still invalidates old responses and saves; the old draft may be offered for recovery but its base is not treated as the new owner's authority.
- **Identical clean policy** — revalidation may refresh the baseline without visible movement.
- **Dirty draft** — keep the original CAS base; an observed changed revision marks a conflict and blocks Save. Do not merge. The conflict path offers non-destructive reload/inspect and an explicit discard-and-reload; no force-overwrite and no automatic rebase.
- **Accepted-but-unconfirmed** — a committed write with failed reread stays Saved / refresh required and blocks replay until refreshed. Transport or protocol failure is not proof of rejection.
- **Independent transaction state** — pending, saved, conflict, unavailable/offline and unsynced are shown per transaction. Repeated background failures do not re-alert. Focus moves only for user-triggered validation failures, and ordinary save keeps focus on the initiating control.

Reads stay inside the existing watch lifecycle; an invalid Root issues no automatic request. A failed read leaves a stable error until an explicit retry or a real binding change. There is no timed retry loop. Unmount and identity changes invalidate in-flight work.

### Section field map

Each supported setting has exactly one home; the table is a coverage contract, not new schema.

| Section | Owning fields |
| --- | --- |
| Run and modules | `modules` (Global), `defaultActive`, `modelParameters` |
| Model routes and recovery | `roleRouting`, `runtimePolicy`, `runtimeRecovery` |
| Workflow, roles and subagents | `workflow`, `roles`, `skills`, `presets`, `locale`, `promptOrder`, `subagents` |
| Permissions and safety | `permissionControl`, `guards` |
| Configuration state | Read-only desired/startup/next-root/admission inspection |
| Other / advanced | Any remaining editable Host field; `lsp`, `modeName` and `section` stay non-editable and never create this section on their own |

The run section uses a bounded field surface; routes use the existing route-group and `EditableChoice` patterns; the workflow section groups subagent settings under one labeled subheading. A field that previously sat in a catch-all group appears in the section that owns its meaning; only a field with no fitting section keeps an **Other / advanced** home, and none is dropped to reduce the tab count. The `modules.deepwork.enabled` master toggle remains Global-only and absent from the profile scope, while every other listed field follows its existing layer rules. A scope that exposes no field in a section explains that, rather than hiding the section or substituting inherited values as editable ones. The Host schema is authoritative: a field that is not present is not invented, and a newly added field that no named section claims appears under **Other / advanced**.

Ordinary fields use one labeled native control each: `<select>` for closed enums and booleans (with an explicit inherit choice where the layer supports it), `<input type="number">` with a visible unit for numbers, `<input>` for strings, `<textarea>` for prompts and other multi-line text, and a borders-only fieldset with its own Unset action for an object group. A control with a sparse value shows the inherited value as secondary text, not as an editable value. Invalid raw text stays in its control with an associated message and is never silently replaced by a normalized value. Only schema-described nested policy shapes use the advanced JSONC disclosure, which shares its draft with the structured fields.

### Current-session profile and header menu

Current-session text distinguishes the admitted profile from the future default. Source-version metadata is displayed only when known; internal immutable references, CAS counters and epochs remain protocol values, not labels. Session-selection CAS uses only the sidecar selection state; an absent sidecar is not relabeled as a newer future default. Missing optional admitted/source identity stays unknown or captured.

The Conversation header uses one icon-only native 28px Button with the host's 16px branch SVG and an accessible **Current-session profile** name to open the native Menu. There is no visible standalone label, selected-profile text, status, tooltip copy or instruction outside the menu. Use one profile list, one **Use profile model** action, the Deepwork toggle/locked label and refresh; omit verbose normal-menu descriptions and the duplicate profile-model list. Display the saved label or its ID fallback once. A visually hidden live region announces successful outcomes; no persistent visible success text is rendered. Short sanitized errors and necessary disabled/locked reasons remain inside the menu. Native Menu owns keyboard navigation, Escape/outside dismissal, focus return and body-portal placement. Profile/default selection uses the Host's blank-session capability; after execution starts it remains unavailable. Never silently discard a Settings draft, create a session or change a global default to operate this control.

Menu refusal diagnostics show only a finite known reason code and an optional closed canonical configuration-field grammar, with bounded length. Never echo raw Host/provider messages, arbitrary wire fields, paths, identifiers or credential values. Unknown transport/domain errors map to safe generic codes. Explain activation, maintenance and conflict distinctly and offer refresh plus an idle retry hint; refresh is read-only, not an automatic queued apply. These details remain inside the menu and its visually hidden accessible announcement. A native idle snapshot is not a reservation: another activity may acquire maintenance before CAS, in which case the previous profile remains applied and retry must remain explicit.

One root-scoped `conversation.header.leading` contribution serves active, retained blank and sessionless states, including `hideChrome`. Its numeric priority is `Number.MAX_SAFE_INTEGER`: native SlotCore chooses the lowest numeric priority, so existing native/plugin navigation wins. DSMM does not replace the header or another leading owner; a host whose plugin owns this single slot may not display the profile icon. The menu follows the public current-session adapter/controller identity, and retained callbacks reject a changed identity before dispatch. Without a real current identity the menu remains inspectable but profile mutations are disabled; no session is created automatically.

The single profile list switches the profile while preserving the chosen native main model, with zero native selection calls. Exactly one `@use-model` **Use profile model** action requests the current admitted immutable profile's configured ordinary-root primary through native `session.selectModel`. It does not reapply a subsequently saved draft revision, increment the profile epoch or write a profile sidecar. There is no local model echo, shadow selector or DOM/native-store patch: the native model-selection projection/picker is authoritative. Missing model configuration, withdrawn selector or native selection failure retains the admitted profile and reports a short sanitized error. This explicit action has the same native semantics as choosing the Models tab, including native default-model persistence in the background; normal switching, profile saving and route-field editing never invoke it.

The **Deepwork** toggle shows explicit mode intent; otherwise official minimal mode defaults off and DW presets default on. A same-default choice still persists intent, and explicit off wins without removing persona. Mounted/admitted module ceilings and native idle/ownership/session identity remain mutation gates. `canToggleMode`, `canSelectModel` and `canApplyOverlay` are independent: unavailable live Apply doesn't disable ordinary mode changes or Use profile model. Stored intent alone doesn't establish current DSMM role admission or prove that a restored session retains its former restrictions; native restoration follows Section 0. Desired-off saves never remove captured read-only or Git protection.

The owned trigger uses only the native compact 28px control geometry and 16px icon. Portaled menu rows and essential headings wrap using the existing 14px/22px body scale and primary/secondary text tokens. Real browser checks must include the trigger focus ring and open menu's right edges against the viewport and native clipping ancestors, not only document scroll width.

The model action observes public current-session sources read-only: the `projection("modelSelection")` face, the borrowed live binding's `eventSource` model/selection sequence watermark, and the resident native ModelDirectory.store interaction phase. The native projection alone suppresses an identical pending selection, so it is not same-value intent proof. Read only event type/sequence from the already-materialized current-session window; do not retain, load history or export events. Capture these source identities/generations before reading the admitted profile model, then refuse the native model call if a newer durable model/selection event or local native selecting phase appears before dispatch. The local directory phase also protects a manual selection awaiting its native acknowledgment. Missing/withdrawn required observation fails closed. A newer native choice is kept with short sanitized feedback while the admitted profile remains applied. After native model dispatch, the native API retains its own last-writer semantics; DSMM never reissues or echoes a model to defeat a later Models-tab choice, and does not claim to fence remote mutations not yet observed before dispatch.

Use `Button`, `Input` and, if needed, existing SVG icons from `@deepseek-ai/dsh-client-ui-primitives`. Their native exports contain no `Select` or `Textarea`; do not invent imports. Use semantic HTML for those controls, adapting the existing Models input/select geometry and host tokens. Keep the browser's native select affordance rather than copying a hardcoded-color SVG arrow.

`Button` supports normal button attributes and `variant="primary" | "ghost" | "outline" | "toolbar"`, `size="md" | "sm"`, and `icon`. `Input` forwards normal input attributes; its `className` decorates the wrapper. Add a DSMM-owned wrapper focus ring if required; the native inner input disables its own outline. Do not patch vendor primitives.

Native `SettingsFormModel`/`configForms` manage the host plugin-config document, not independent DSMM profile files. Reuse visual primitives, not that persistence model. A `settings.section` contribution has its own stable id/label/locale and a native injected `getSnapshot`/`subscribe` source. Register it additively; do not replace the native settings slot owner.

### Implemented Reusable Patterns

#### Named profiles: scannable single-column layout with Multi-Agent Dialog

The named profiles editor is scoped under `.dsmm-profiles.dsmm-named-profiles` to prevent leaking layout or style overrides to deployment pages or permissions panels. The surface is organized into a streamlined single-column flow with a dedicated Multi-Agent Dialog:

1. **Header browse row** — Lists saved labels, IDs, and immutable revisions alongside New draft and Refresh inventory buttons. A live status badge (`data-dsmm-editor-state`) reflects dirty, saved, refresh-required, and applied states. Opening another profile or refreshing checks `dirty || invalidFields.length > 0`; unsaved edits trigger explicit discard confirmation with focus restoration to the initiating trigger upon cancellation or Escape.
2. **Effective summary** — Compact card displaying future default selection (with inline "Set as future default" action) and current session admission (with a quick-locate action targeting session settings).
3. **Secondary actions** — Collapsed disclosure containing future default reset ("新会话使用插件默认" / "Use baseline for future sessions") and current-session scope controls (`SessionScope`), preserving four independent transactions (Save profile, Set as future default, Session admission, and Model-only activation).
4. **Basic settings** — Flat, uncollapsed section in normal flow:
   - Profile name (`label`) with optional omit action.
   - Profile ID (`id`), locked on saved revisions.
   - Orchestrator primary model shortcut (`settings.roleRouting["dsmm-orchestrator"].primary` only), configured directly here with provider, model, and reasoning effort controls, noting that orchestrator calling levels are not provided.
   - "Configure all Agent models" ("配置全部 Agent 模型") button opening the responsive Multi-Agent Dialog.
   - Business output language (`settings.locale`).
   - Deepwork default active toggle (`settings.defaultActive`).
   - When raw JSONC syntax is malformed, displays a prominent syntax notice and a direct jump action to the JSONC editor.
5. **Multi-Agent Dialog (`ProfileModelsDialog`)** — Wide responsive modal dialog (~1040px max width, internal scroll) reusing DSH Modal primitives:
   - Background inert isolation applied to document body siblings while open.
   - Sticky dialog top bar with Save and Close actions: shares the same draft and save eligibility rules (dirty, snapshot, valid fields, valid projection) as the main profile editor with compact symmetrical padding; Save commits immediately while Close retains uncommitted drafts without silent discard.
   - Dialog filter bar with unified 32px height and aligned vertical baseline for the role search input and explicit override checkbox toggle.
   - Role cards listing each role from `snapshot.roles` with a fixed-width left identity column and left-aligned inline primary route (mode select, provider, model, reasoning effort) sharing identical label-to-control spacing and vertical baselines.
   - Expandable calling levels (`low`, `high`, `max`) with accurate configuration summary (absent for orchestrator).
   - Expandable fallback chains (up to 32 items with safe focus management on add/move/remove).
   - Collapsed non-model role settings (`enabled`, `retry`) with inheritance summary using known data.
   - Single JSONC draft shared with main page; closing dialog via Esc or close button preserves dirty/invalid drafts without extra discard confirmation.
6. **Advanced execution settings** — Collapsed `<details>` disclosure for global execution settings:
   - Profile defaults: Default strategy and rate-limit bounds (`settings.runtimePolicy`).
   - Git write protection: Sparse `settings.guards.gitWriteGuard` (`ask` | `deny` | `off`) and `settings.guards.gitWriteScope` (`all-writes` | `high-risk`, labeled "Git 写操作保护范围" with options "所有写操作" / "仅高风险写操作"). When the guard is `off`, the scope control is disabled with an explanatory hint ("保护已关闭，检查范围暂不生效"), while Unset/inherit remains accessible.
   - Subagent tools: `settings.subagents.toolTopology` (`per-role` | `parameterized`).
7. **Advanced JSONC source editor** — Collapsed `<details className="dsmm-advanced">` disclosure:
   - Direct JSONC text editing preserving original comments, formatting, and unprojected parameters.
   - Validation failures expand necessary disclosures, scroll into view with `prefers-reduced-motion: reduce` support, focus the input, and select the precise UTF-16 character range.
8. **Save bar with Actionable Save-Lock Locator** — Positioned as a sticky action bar at the top of the named profiles editor (`.dsmm-editor`):
   - Sticky positioning ensures Save, Discard, Reload, and short status remain visible during long profile edits without viewport-fixed hacks.
   - Status message, save-lock text, and actionable locator buttons remain integrated in the top bar:
     - For role-scoped invalid fields, automatically opens the dialog, clears filters, expands the target details group, and focuses the invalid field.
     - For ID or unmapped errors, focuses the field or expands JSONC with exact UTF-16 character range selection.
   - Save button (enabled only when dirty and valid).
   - Discard button (triggers confirmation when dirty or when invalid fields exist).
   - Reload button (available when clean).

Save increments `editorEpoch` without resetting user-controlled disclosure open/closed states. Essential warnings, validation errors, conflict notices, read-only notices, and unavailable service reasons always remain visible in normal flow outside collapsed disclosures. Invocation `normal` remains a read-only default-route alias; orchestrator has no level overrides. Each level override is inherit, exact effort-only, or a complete route. Output locale is inherited when omitted and affects only agent output. Named profiles expose only subagent topology, never deployment permissions, background execution, or recursion depth. Current-session startup-binding readiness relies strictly on server admission DTOs.

#### Delegation call presentation

Native `tool.call.toolview` contributions cover per-role tools and the parameterized role/category entries. A pending argument-derived label is **requested**, not actual admission. Completed results use **actual** only when validated native invocation metadata matches the tool and canonical target; errors or missing metadata don't manufacture an executed role or route. Native request/capture evidence remains the authority for route claims.

Native child labels use `Coding: task description`, without technical IDs. Current-format replay and nested PTC use the same identity rules without requiring a live Agent. Native safety refusal presentation takes precedence. Background is chosen before activation starts; don't show a running-call handoff action or confuse an accepted child/message receipt with completion.

The collapsed title names the target agent, such as **调用 Coding** / **Call Coding**, rather than displaying only `dsmm_category`. A complete target field is enough to display its requested name while the remaining arguments stream. Incomplete or invalid target data stays unknown. Details distinguish requested and reported actual identity and retain technical tool/call IDs; errors and interruptions retain the requested target without claiming it executed.

Use native disclosure, status and code-block primitives. Arguments, output, errors and metadata stay inspectable; nontext content is represented as JSON, without an image, audio or rich-media preview. Native disclosure and Inspect behavior remain available. A call without a usable native window returns to the native fallback rather than inventing a client binding. Presentation never changes routing, permission or approval.

The host primitives above are dependencies, not package-owned implementations. Package-owned patterns below are implemented and reused at least twice.

The structured editor uses a reusable route field group for primary and fallback candidates and a reusable runtime-policy group for profile defaults and role overrides. Both use the host primitives and the geometry above, with borders-only fieldsets and wrapping action rows. Their selectors are advisory, and exact manual values remain editable without a catalog listing.

`EditableChoice` is the shared one-input combobox for provider, model and exact effort, including fallback and invocation-level routes. Native Input and a transparent ghost Button retain the existing surface, radius and focus treatment; the arrow button is 24px square with a 4px right inset. Clicking the input opens available choices without toggling an open list closed. The borders-only listbox uses layer-1, primary text, hover/active tokens, md radius, 4px adjacency, 8px/10px option padding and a 240px maximum scroll height. Focus remains on the input; arrows move the active suggestion, Enter chooses its ID or keeps typed text, Escape/outside blur dismisses. Suggestion labels may be friendly, but choosing stores the actual ID and typing stores the exact string. Catalog refresh never normalizes a value. Each control updates only its existing JSONC path, never reconstructs a route or changes model-parameter placement. Effort-only levels have no guessed catalog; the configured value remains a suggestion and arbitrary values remain editable.

The structured draft projection retains opaque route and level parameters without interpreting them. Known-field edits and fallback moves preserve these parameters and original JSONC bytes; malformed known fields, duplicate/unsafe keys and excessive nesting still refuse structured mutation. The Host remains authoritative for parameter support, validation and Apply. Closed host enums, role IDs, permissions and actions remain fixed selectors; this pattern does not make them arbitrary string inputs.

Field dependencies remain explicit: choosing another catalog provider resets that route's model and exact effort; typing a provider keeps the manual model and clears only its stale exact effort. Model changes clear that route's exact effort. Choosing an unchanged ID does not rewrite the draft; navigation, catalog refresh and unrelated instances never reset values.

## 6. Motion & Interaction

The host provides `--ds-transition-duration-fast` (100ms), `--ds-transition-duration` (200ms), `--ds-transition-duration-slow` (300ms), and `--ds-ease-in-out` (`cubic-bezier(.4, 0, .2, 1)`). This settings section needs no entrance animation or new motion library. Feedback is immediate and never waits for animation; if a transition is needed, use the host timing and opacity/transform only. Under `prefers-reduced-motion: reduce`, remove nonessential transitions and retain the same information and focus behavior.

Native focus expression: `var(--dsw-focus-ring-width)` (2px) solid `var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`, with a 2px control-owned offset. Never remove keyboard focus feedback. Preserve the host's pointer/keyboard modality handling. Native Input's focus-within border alone is not sufficient evidence of a 2px keyboard ring.

Changing an editor's profile is distinct from activating that profile. Do not silently discard an unsaved draft or change the active profile while browsing. Block or explicitly confirm a draft-discarding action. Save success follows the accepted backend snapshot, not a click or locally valid JSON. Disable competing commits during pending work, keep error drafts, and ignore stale responses after another selection or disposal. External conflicts need a clear reload/retry path without overwriting the user's draft. Focus stays on the initiating control after ordinary saves; after refused validation, identify and focus the relevant field without stealing focus on background refreshes.

## 7. Depth & Surface

DSMM content uses borders-only grouping and the host's existing neutral surfaces. Native layer-1/layer-2/module surfaces, md control radii and subtle divider tokens supply the hierarchy; no new shadows, floating cards, nested modal or backdrop. The host Settings shell already owns `--dsw-elevation-prominent` and its panel radius. DSMM must not copy or override that shell. Strengthening an editable control boundary with an existing text token for accessibility is scoped to DSMM controls, not a vendor/theme redesign.

## 8. Accessibility constraints

Target WCAG 2.2 AA for the DSMM-owned section and its tested states. All text/control/status names must remain understandable without color, hover or a pointing device.

- Text contrast: at least 4.5:1 for ordinary text, or 3:1 only when the actual large-text criterion applies. Control/focus indicators needed for identification: at least 3:1 against adjacent colors. Check rendered light, dark and reduced-motion states; theme tokens alone are not a passing audit.
- Observed default-theme risks: tertiary light text on white is 3.71:1; error light text on white is approximately 4.4976:1; error dark text on layer-2 is 4.24:1; success green on white is 2.28:1. Therefore required hints/status/error messages use primary/secondary text. Colored accents are supplementary, never sole labels. Use an existing high-contrast token such as secondary text for DSMM editable boundaries if the subtle native border fails identification contrast. Do not silently accept these risks because they also occur in the host.
- Semantic `<label>`, `<select>`, `<input>`, `<textarea>` and `<button>` first. Use stable ids, associate hints/errors with `aria-describedby`, mark invalid fields with `aria-invalid`, and announce save/selection outcomes with a polite status region. An urgent user-triggered refusal may use an alert; avoid announcing every keystroke or duplicating messages.
- Every action has a keyboard path and visible focus; no keyboard trap, unbound custom shortcut or surprise focus loss. Native form targets are at least 24px in their applicable dimension. Test Tab/Shift+Tab, select arrow keys, Space/Enter, tab arrow keys plus Home/End versus activation, and any implemented confirmation's dismissal/focus return.
- The section tablist is exposed as tabs, not links or plain buttons: exactly one tab is in the tab order, the selected tab owns `aria-selected="true"`, and each panel is labeled by its tab. `aria-busy` is scoped to the region that is actually waiting: first load and explicit refresh may set it, silent revalidation must not, and a save reports through its own busy status. Status text keeps a stable reserved line so state changes do not shift controls under the pointer or keyboard focus.
- Busy, unavailable and disabled states must explain why an action cannot proceed. Preserve readable error details and unsaved content; never expose credentials, token contents or unredacted provider errors in a profile editor/status message.
- Test normal and reduced motion, 200% zoom/reflow, long names, empty/unavailable stores, pending operations, validation errors, conflicts and backend failures. Capture screenshots at 375/768/1280px and keyboard/pointer evidence in a run-owned empty browser context.
- Do not sign in, import browser state, weaken native authentication or attach to the live user application to obtain QA evidence. Report the actual authenticated-host verification boundary explicitly.

Accepted accessibility debt: none. Any future exception must record location, reason, owner, exit criteria and explicit user authorization; an unavailable verification surface is a disclosed limitation, not an implicitly accepted exception.
