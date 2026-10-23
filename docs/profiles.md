# Deepwork runtime profiles

DSMM 0.3.13 targets exactly DSH `0.2.1-rc.2`. See [compatibility](compatibility.md) for installation boundaries.

A named Deepwork profile is a runtime-policy document, not a native deployment profile or Agent preset. Open **Settings → Deepwork Profiles** to browse and edit it. Native **Plugins → DSMM** edits deployment layers instead, as described in [settings and status](settings-status.md).

## Four independent states

| State | What it means |
| --- | --- |
| Draft | Unsaved JSONC in the editor, including invalid input and comments |
| Saved revision | Validated bytes in the named document; Save changes only these bytes |
| Future-default selection | A named profile ID or deployment baseline selected for subsequent activations |
| Current admission | The actual session's captured settings, profile revision and admission epoch |

Browsing doesn't activate anything. **Save profile** doesn't select it or change a resident Agent. **Set as future default** records the named ID and an archival saved revision, never a dirty draft. Subsequent activations read that ID's latest valid saved content. **Use baseline for future sessions** clears that default without deleting documents.

**Apply profile to current session** and **Pin baseline for current session** are unavailable in this version (`canApplyOverlay:false`, `new-session-required`). Save and select a future default, then create a new session. Nothing is queued, restarted or silently applied to the current root or its children.

The compact Conversation header menu shows the current admission separately from the future default. **Use profile model** asks native model selection to use the admitted immutable configuration's declared main model, not a later saved draft. It doesn't write an overlay pointer or increment the admission epoch. Native model-default persistence follows the Models tab; newer manual model or effort intent, including same-value reselection, wins. `canSelectModel`, `canToggleMode` and `canApplyOverlay` have independent reasons: unavailable live Apply doesn't disable ordinary model selection or mode switching. Sessionless controls never create a session.

## Named profiles interface layout

The redesigned Named Profiles page (`.dsmm-profiles.dsmm-named-profiles`) organizes editing into a streamlined, scannable flow with a wide multi-agent configuration dialog:

1. **Header browse row** — Select profile, New draft, and Refresh inventory buttons alongside a real-time status badge (`data-dsmm-editor-state`) tracking dirty, saved, refresh-required, and applied states.
2. **Effective summary card** — Visible summary of future default (with inline Set as future default button) and current session admission (with a quick-locate button targeting the session settings section).
3. **Secondary actions** — Collapsed disclosure containing future default reset ("新会话使用插件默认" / "Use baseline for future sessions") and current-session scope controls, preserving four independent transactions (Save profile, Set as future default, Session admission, and Model-only activation).
4. **Basic settings** — Flat, uncollapsed section in normal flow:
   - Profile name (`label`) with optional omit action.
   - Profile ID (`id`), locked for saved revisions.
   - Orchestrator primary model shortcut (`roleRouting.dsmm-orchestrator.primary` only), with provider/model/effort selection and note that orchestrator levels are not provided.
   - "Configure all Agent models" ("配置全部 Agent 模型") button opening the Multi-Agent Dialog.
   - Business output language (`settings.locale`).
   - Deepwork default active (`settings.defaultActive`).
   - If raw JSONC syntax is invalid, a clear notice is shown here with a button to expand and focus the JSONC source.
5. **Multi-Agent Dialog (`ProfileModelsDialog`)** — Wide responsive modal dialog (~1040px max width, internal scroll) reusing DSH Modal primitives:
   - Background inert isolation applied to document body siblings while open.
   - Dialog filter bar with role search input (by role name/ID) and toggle for explicit model overrides only (including explicit empty fallback chains `[]`).
   - Role cards listing each role from `snapshot.roles` with inline primary route (provider, model, reasoning effort).
   - Expandable calling levels (`low`, `high`, `max`) with accurate configuration summary (absent for orchestrator).
   - Expandable fallback chains (up to 32 items with safe focus management on add/move/remove).
   - Collapsed non-model role settings (`enabled`, `retry`) with inheritance summary using known data.
   - Single JSONC draft shared with main page; closing dialog via Esc or close button preserves dirty/invalid drafts without extra discard confirmation.
6. **Advanced execution settings** — Collapsed `<details>` disclosure for global execution settings:
   - Profile defaults: Default strategy and rate-limit bounds (`settings.runtimePolicy`).
   - Git write protection: Sparse `settings.guards.gitWriteGuard` (`ask` | `deny` | `off`) and `settings.guards.gitWriteScope` (`all-writes` | `high-risk`). When guard is `off`, the scope control is disabled with an explanatory note ("保护已关闭，检查范围暂不生效"), while Unset/inherit remains accessible.
   - Subagent tools: `settings.subagents.toolTopology` (`per-role` | `parameterized`).
7. **Advanced JSONC source editor** — Collapsed `<details className="dsmm-advanced">` disclosure:
   - Full JSONC source editor preserving comments, whitespace, and unprojected parameters.
   - User-triggered validation refusals expand disclosures and select the exact UTF-16 character range with reduced-motion support.
8. **Save bar with Actionable Save-Lock Locator** — In normal document flow at the bottom:
   - Status message and blocking issues.
   - When save is locked due to invalid fields, actionable locator buttons directly navigate to the target:
     - For role-scoped invalid fields, automatically opens the dialog, clears filters, expands the target details group, and focuses the invalid field.
     - For ID or unmapped errors, focuses the field or expands JSONC with exact UTF-16 character range selection.
   - Save button (enabled only when dirty and valid).
   - Discard button (triggers confirmation when dirty or when invalid fields exist).
   - Reload button (available when clean).

Discard confirmation tracks the initiating control and restores focus to that control (falling back to the profile selector) on cancellation or Escape. Blocking validation errors, read-only notices, and unavailable service reasons always remain visible in normal flow outside collapsed disclosures. Save increments the editor epoch without resetting user disclosure open/close states.

## Document format

A document contains exactly `version: 1`, a filename-matching `id`, optional `label`, and `settings`. IDs contain 1 to 64 lowercase ASCII letters, digits, hyphens or underscores, start with a letter or digit, and can't be Windows reserved names. Labels are bounded text without control characters.

```jsonc
{
  "version": 1,
  "id": "careful",
  "label": "Careful review",
  "settings": {
    // Omitted fields inherit the captured deployment baseline.
    "locale": "en",
    "roles": { "dsmm-quick": false },
    "subagents": { "toolTopology": "parameterized" },
    "roleRouting": {
      "dsmm-reviewer": {
        "primary": { "provider": "my-provider", "model": "review-model" },
        "levels": { "high": { "reasoningEffort": "high" } },
        "fallbackRoutes": [],
        "strategy": "startup-lock"
      }
    }
  }
}
```

The provider/model must resolve through native DSH, and an exact effort must be supported. Catalog listings are advisory, not authentication or network-health checks. Manual/unlisted routes remain editable. See [model routing](model-routing.md) for level selection and route precedence.

Allowed runtime fields are `defaultActive`, `locale`, `roles`, `roleRouting`, `modelParameters`, `runtimePolicy`, `workflow`, `guards`, `runtimeRecovery`, and `subagents.toolTopology`. Skills, prompt content, preset installation, LSP, provider/account credentials, background/depth settings and `subagents.allowRouteOverride` aren't named-profile fields. Native persistence remains Host-owned. `modules` is global-only. Unknown fields are rejected.

The `deepseekV4Pro`/`deepseekFlash` Calibration, DefaultReasoningEffort and MaxReasoningPresets fields are rejected with `deprecated-field`. They aren't silently ignored or migrated. All models use native capabilities, `modelParameters` and explicit `roleRouting[id]` primary/fallback/level parameters. `normal` is the invocation default, not a configurable level entry. Orchestrator levels aren't supported.

## Inheritance and ceilings

Effective policy resolves from **built-in defaults → sparse global deployment → explicit native entry/profile override → immutable named overlay**. Missing members inherit, arrays replace, and explicit empty fallback chains remain empty. A named primary or level route replaces that route value, including removal of omitted effort, rather than retaining an old route's effort.

Named `roles` can narrow availability, not lift the captured deployment or startup ceiling. Orchestrator, Planner and Plan Critic can't be disabled by a named profile. Under legacy workflow policy, Reviewer is also required when final review isn't off, and Oracle is required for `simple-oracle-complex-reviewer`. Required status doesn't create missing startup capabilities. The editor shows required reason, startup availability, deployment enablement, admitted state, and source/capture separately; routing remains editable for disabled roles.

`locale` supports `en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`, `de`, `fr`, `es`, `pt-BR`, and `ru`. Omission inherits deployment preference, then applicable native/user language guidance or conversation context. A current user's explicit output-language request wins and should be preserved in child assignments. Locale affects visible replies, plans and role output only, not internal reasoning, UI/project locale, identifiers, commands or exact quotations. A parent's later profile change doesn't rewrite a child's captured preference.

## JSONC, diagnostics and concurrency

Structured controls and Advanced JSONC edit the same draft. Path edits preserve unrelated bytes and comments. Invalid raw input stays visible and isn't normalized by switching back to the form. Save or explicitly discard dirty changes before changing the editor's document or selecting its saved revision.

The only nonblocking warning is `blank-label`: the profile ID is used for display, and the original document can still be saved and selected. Saved, draft, future-pin and current-admission warnings are distinct. Validation errors carry a stable reason, schema-safe field and, when available, JSONC offset/length and line/column. Unknown key names aren't echoed as trusted diagnostic fields. Duplicate keys, unsafe keys, malformed routes, unsupported values and retired fields block validation.

Saves and selections require expected versions. File `revision` values use `stat-v1-<mtimeNs>-<ctimeNs>` from safe file observations; they distinguish ordinary versions, not content integrity. Cooperative writers share a lock, recheck before commit, and use same-directory atomic replacement. Precommit failures retain the prior selection, though an unused snapshot may remain. Same-stat content changes and non-cooperating final-rename races are not detected or prevented by a version marker.

Successful rename is the commit point. Admission preparation finishes before rename and publication happens synchronously once. Failure to observe the final target, including replacement by another file, still returns committed success with `selectionRevision` or `revision` set to `unavailable` and `refreshRequired:true`. Refresh before another mutation; `unavailable` is not a valid expected revision. A normal save returns the version a subsequent read observes, not staging-file timestamps.

## Storage and lifetime

The central store is `<resolvedDshHome>/plugins/dsmm/profiles/`, a DSMM convention. Trusted home resolution uses explicit `profileContext.home`, then `DSH_HOME`, then the official `~/.dsh` default. Shared named drafts and immutable revisions are separate from selection/session state scoped to canonical native profile identity and the actual DSMM entry ID. Reads don't create files or locks. Clients and models can't choose arbitrary roots or entry identities.

Selection writes retain an exclusive archival `snapshot-v1-<UUID>` file in `.revisions` and a pointer with the profile ID. Pointer identity/CAS reads do not interpret that archival snapshot. An activation resolves the selected ID's latest saved content; missing old revisions or retired runtime fields in old captures do not prevent this. Missing, unsafe or invalid current content fails explicitly, without baseline or arbitrary-profile fallback. Disk selection revisions and the actual admission's content revision/epoch are separate observations.

An old `<profileContext.dir>/dsmm-profiles` library is unsupported. It remains untouched and is not replaced by a same-name central document. Invalid, missing, linked or unstable references refuse. File/path, size, schema and session identity checks remain mandatory. There is no automatic copy, import, migration, rewrite or source deletion.

Startup freezes mounted capabilities before consumers install. Root reactivation preserves an explicit named ID or baseline choice; without an explicit session choice it uses the current global selection. A native continuable child uses its own trusted selection or inherits its parent's selection source, resolving latest content at activation. Current deployment/module/role restrictions and the live parent's actual authority remain ceilings. `getSettings(agent)` remains immutable for a residency. Native IDs, history and tasks survive; old grants, captures, retry state and approvals do not. Read-only observation never resumes a session.

Saving or selecting a future default never changes the native root model, remounts startup services or upgrades role permissions. Deepwork mode intent is separate: explicit off wins over DW preset defaults and doesn't remove persona/read-only policy. Live children retain their original route, locale and authority, with exact-parent checks for control; see [Agent presets and child control](agent-presets.md).

*Author's note: For a DSH operator editing named policy; save first, then choose the intended future or current-session scope explicitly.*
