# Profile selection and long-form actions

## Goal and boundaries

Allow an explicit workspace/Profile choice before a current session exists, and keep the primary actions of long configuration forms visible while scrolling. Preserve native session ownership, input, model selection, permission checks and independent configuration transactions.

- Keep DSMM `0.3.14` and DSH `0.2.1-rc.2`; use this checkout and installed public APIs only. No installation, dependency upgrades, Host package patches, Git writes or operations on the user's Host/browser.
- Preserve the user's `2026-10-22-profiles-page-redesign.md` and unrelated changes. Follow `DESIGN.md` and native tokens without a general UI redesign or new UI dependencies.
- Native-command authorization changes, long-lived grants, model proposals and precise external-path enforcement are outside this deliverable. Their public-interface dependencies are tracked in the roadmap. Preserve direct native bash/pwsh loading and existing permission behavior; do not introduce replacement tools or require adapter migration.
- Switching an already-started idle root is defined separately in [idle session Profile switching](2026-10-23-idle-session-profile-switching.md).

## No-session Profile selection

Use the existing conversation-header fallback and Settings session scope. Browsing, refreshing or opening a menu does not create a session. A workspace comes from an explicit user choice or a supported native context, never process cwd or list order. Do not replace another plugin's slot ownership.

The public `uiWorkspace.connectWorkspace(workspaceId)` obtains a native blank without navigating; it may reuse an existing blank. `openSession(id)` opens the result. Native input and composer blocks belong to individual sessions; no sessionless draft-migration API is assumed.

The controller's preparation flow:

1. Capture connection and navigation generations, the explicit workspace, Profile ID and saved revision. Preserve dirty/invalid/pending-editor guards; an existing current blank uses its normal selection flow.
2. Obtain the Host-returned session ID without passing a DSMM Profile ID as a native preset. Retain that exact target and synchronously occupy an empty native composer-block slot before awaiting describe/select. Never replace another owner's block.
3. Reuse `describeSession` and `selectSession` with admission epoch, selection revision and Profile revision CAS. Do not disguise the prepared target as the current session or build a separate runtime owner.
4. Open only after the accepted snapshot confirms the exact target, selection and admission. A stale navigation intent must not open a late result. Delayed current-binding handoff retains the send block without leaving a sendable gap.
5. Unknown outcomes preserve the target for a read-only refresh; never replay creation or mutation automatically. An explicit subsequent open of an already confirmed target does not repeat selection. Navigation errors clear busy state without losing the exact retained target.
6. Release only task-owned references/blocks. Do not delete or archive native blanks, cancel other work or clear input to recover from failure. When the Host fails without returning an ID, use native workspace navigation to inspect the outcome rather than inventing an identity.

Do not reconstruct text, references, attachments or cursor state, and do not invoke draft initialization with `prompt` or `clearPreviousDraft`. Native model selection and future-default Profile remain independent. If a real Host has separate sessionless input without a public lossless transfer contract, report that verification/interface limit rather than copying only text.

## Visible form actions

- **Agent-model dialog:** place Save/Close and concise status at the top of its actual scrolling surface. Save uses the main editor's draft, action and full eligibility: dirty, valid fields/JSONC, writable snapshot, no pending operation or refresh-required revision. Close/Escape preserve drafts and existing focus-return behavior.
- **Profile editor:** one top Save/Discard/Reload bar, with confirmation, concise status and actionable validation/conflict feedback. No duplicated save bar or independent dialog draft.
- **Deployment:** `ScopeSave` precedes the current section's fields and remains visible. Preserve Global/native-profile selection, pending sections and read-only Refresh semantics.
- **Root rules:** Save/Refresh/Discard remain a separate transaction at the top of the long rules editor. Do not introduce Save all; row-level Add/Remove/Stage controls stay inline.
- Use sticky positioning within the existing scroll owner, not viewport-fixed controls or changes to the Host shell. Nested bars must not overlap. Measure wrapping bar heights where offsets are required, and apply adequate scroll margins to actual focus/scroll targets.
- Preserve keyboard access, modal focus trapping, labels, live regions and read-only/pending/invalid states. Use native tokens and wrapping layouts for narrow widths and long localized text; keep long diagnostics in locatable content rather than consuming the scrolling viewport.

## Implementation boundaries and evidence

The no-session flow is owned by `client/controller.ts`, `SessionProfiles.tsx`, `index.ts` and a small public-native adapter. Form actions are owned by the four existing form components and `styles.ts`. Synchronize `DESIGN.md` and `docs/profiles.md` with final behavior, without execution journals or descriptive-text locks.

Controller regressions cover creation/selection timing, double activation, connection/workspace/session changes, stale navigation, conflicts, unknown commits, delayed binding handoff and preservation of native blocks. Verify the accepted admission and first actual request, not just a selected menu label.

Browser regressions use production components in an isolated fixed-height scrolling shell and the modal's actual scroll container. Check save eligibility and submission, draft preservation on close, focus return, error positioning, and action/button rectangles after real scrolling. Check nested transaction bars independently. Target 375/768/1280px, 200% reflow, themes and reduced motion when a browser environment is available.

Workers run lightweight checks; integration builds current `lib/` before tests importing it. Use the affected `config-profiles` and `frontend-package` module suites and `native-runtime`/`frontend` integration groups; consolidate with the idle-switch plan's affected safety/routing suites. Do not run diagnostic/all, release or pack checks for these changes.

Host/browser tests require explicitly supplied `DSMM_TEST_DSH_ENTRY` and `DSMM_TEST_PLAYWRIGHT_ENTRY` anchors. Missing anchors are unverified coverage, not passing UI evidence; do not install dependencies, use sibling inputs or connect to the user's browser. Native conversation navigation and complete text/reference/attachment continuity need real-surface evidence beyond controller seams.

LSP startup behavior, permission rules and resource delivery are unchanged. Report actual checks and remaining coverage in conversation; clean only exact task-owned temporary resources.
