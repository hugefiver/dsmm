> DSH adapter boundary: resolve this resource from the loaded skill's directory resourceBase. Examples are not authority: installation/download/login, private state, Git writes and destructive operations need exact explicit authorization. Use only tools and native roles actually exposed in the current catalog and allowed by the caller; otherwise use a real direct fallback or report the limitation. Translate shell examples to the active runtime.


# Visual Quality Assurance (Visual QA)

Visual QA is empirical verification of rendered UI on actual displays and browsers. Code that appears syntactically correct in an editor can fail in rendering: fonts fail to load, containers collapse, flex/grid wraps unexpectedly, contrast degrades, or interactive states fail.

This reference defines the authoritative principles and protocols for visual quality assurance.

---

## 1. Fixed-State Baseline & Comparative Verification

Before modifying existing UI, establish a verifiable before/after comparison by locking six parameters:

1. **Route & Query Parameters**: The exact path, query strings, and hash.
2. **Application & View State**: The specific UI mode, open drawers, active tabs, focused inputs, selection, or modal states.
3. **Viewport Dimension**: Test at standard representative breakpoints:
   - **Mobile**: `375px` width (e.g. 375×667 or 375×812)
   - **Tablet**: `768px` width (e.g. 768×1024)
   - **Desktop**: `1280px` width (e.g. 1280×800)
4. **Theme**: Explicit light or dark theme setting.
5. **Test Data / Fixtures**: Stable, deterministic mock data. Avoid changing timestamps, random IDs, or volatile external network responses that create false diffs.
6. **Scroll Position**: Top of page (`scrollTop = 0`), or precisely scrolled to the component under inspection.

### Baseline Discipline

- **Capture Before Edits**: Always capture baseline screenshots or render state *before* editing project source.
- **Identical Conditions**: Post-change screenshots MUST be captured with the exact same 6 parameters.
- **No Fake Baselines**: If a pre-change baseline was not captured before editing, **never** revert code temporarily to fabricate a retroactive baseline, and **never** disguise a post-change capture as a "before" state. Explicitly disclose that comparative baseline evidence is unavailable, and verify the post-change state directly against requirements.

---

## 2. Defect vs. Taste Distinction

Keep a strict distinction between functional/visual defects and subjective taste.

### Defect (Objective Flaw — Must Fix)

A defect is a verifiable departure from requirements, accessibility standards, or visual integrity:
- **Layout breakage**: Unintended element wrapping, overlapping containers or text, broken grid/flex alignment.
- **Clipping & overflow**: Cut-off typography, truncated data labels without tooltips, unintended horizontal scroll on mobile viewports.
- **Contrast & accessibility failures**: Contrast ratios falling below WCAG AA minimums (4.5:1 for body copy, 3:1 for large text).
- **Broken interaction states**: Missing or unstyled focus rings, unresponsive hover states, disabled states that appear clickable, or broken transitions.
- **Missing required content**: Omitted form inputs, deleted table columns, lost action buttons, or abridged copy.
- **Design token violations**: Arbitrary undeclared hex codes or rogue spacing when design tokens exist.

### Taste (Subjective Preference — Do Not Churn)

Taste encompasses aesthetic variations that remain fully compliant with the approved brief and design system:
- Adjusting a border radius between two valid token values (e.g. 8px vs 10px).
- Debating subtle nuance between two accessible neutral background shades.
- Subjective preference on whitespace density when both options follow the spacing scale.

**Remediation Rule**: Prioritize defects over taste. Do not enter open-ended aesthetic refactoring loops based on subjective taste. Once functional requirements, design tokens, and accessibility standards are satisfied, stop.

---

## 3. Bounded Progress & Local Remediation

- **Localize fixes**: Modify only the affected component, style rule, or token. Avoid collateral refactoring or full-page redesigns for a localized issue.
- **Evidence-driven re-verification**: Only perform another verification cycle when there is concrete progress:
  - A new specific defect is identified.
  - An existing defect has been remediated.
  - New diagnostic evidence (e.g. console log, render trace) clarifies a root cause.
- **Stopping condition**: If repeated attempts fail with the same symptom without new diagnostic insight, STOP. Disclose the persistent blocker clearly rather than looping blindly.
- **No ceremony overhead**: Avoid fixed review count quotas, dual-oracle rituals, or synthetic status ledgers.

---

## 4. Distinguishing Harness Failures from Product Defects

Before blaming product code for a visual discrepancy, check the test harness:

1. Is the local development server running and returning HTTP 200?
2. Did the browser context launch successfully, or did CDP connection time out?
3. Did network mocks fail to supply required data, leaving components in permanent loading states?
4. Is the target route blocked behind an authentication barrier?

**Rule**: A test harness failure does NOT prove product defect or product success. If Playwright, Chromium, or network mocks fail, report the harness limitation accurately. Never treat an unreached view as passing or failing.

---

## 5. Browser Environment & Safety Boundaries

Visual QA must strictly adhere to environment safety boundaries:

- **Run-Owned Temporary Empty Profile**: Always launch browsers using an isolated, temporary, run-owned directory or context.
- **Strictly NO Login**: Do NOT log in to any site, service, account, or provider, including disposable or test accounts.
- **NO User State Reuse**: Never copy, import, or synchronize user browser profiles, cookies, extensions, local storage, or session credentials.
- **Authentication Walls**: If a UI surface requires authentication to render, disclose authentication as an explicit verification limitation; do not bypass or authenticate.
- **NO Autonomous Software Installation**: Never run `npm install`, `npx playwright install`, or download browser binaries without explicit user authorization. If required browser tooling is unavailable, report the limitation.
- **Real Local Capabilities Only**: Use real, available tools (such as an admitted browser tool or pre-installed project Playwright scripts). Do not invoke fictional tools or attach to unapproved browser runners.

---

## 6. State and Flow Behavior Evidence

Use these cases for changed reads, writes, saved state, and multi-step flows. Expected results come from the state table, requirement, or established product contract; current behavior alone is not an expectation.

### Real user path

Reach each state through the controls and navigation available to a user. A typed route, script-dispatched event, forced click, or direct API call used in place of the user action is diagnostic evidence for a different path, not proof of the real entry point. Name the build and data used.

### Held and failed

1. Start the user action and hold its response at an available network or fixture boundary.
2. Confirm that interception actually fired and the response is still held before capturing the pending state. A service worker, another transport, or an unreached handler invalidates the capture.
3. Observe the pending message, locked controls, input, selection, focus, scroll, and work area. Release the response for success or produce the failure, then wait for the resulting state or event rather than a fixed delay.
4. Record request count and target, then read back or reload to inspect the persisted result. A success notice alone does not prove persistence. If the condition cannot be held or observed, mark it **UNVERIFIED** with the reason.

An injected hold or failure verifies handling of that condition. A stubbed success does not verify a real backend success path; identify that remaining boundary explicitly.

### Switch: stale response cannot replace the current target

1. Start request A and hold it.
2. Switch to target B through the real user control and let B complete.
3. Release A.
4. Verify that the screen still shows B's data and selection, with no dialog, error, or success notice belonging to A. Record both requests and their targets.

### Twice: duplicate activation and retry

While the first write is held, activate the same action again. Verify that no unintended second write occurs: either exactly one request leaves or the second attempt is refused with a visible reason. After a refusal or failure, activate retry and verify that a new request can leave. Compare request counts, targets, and the persisted result rather than inferring them from button appearance.

### Re-entry

After settlement, return through each supported user path: reload or restart, close and reopen, back and forward, a cold deep link, reconnect, and a second window or device when synchronization is supported. Check the explicit keep/discard contract: saved state remains, discarded state does not return, and expected controls remain available. Leaving during a write must produce the defined completed, incomplete, or unknown result on return.

### Keep and clear observations

Observe these values before the action, while its request is held, and after it settles:

- **Keep according to the contract**: selection, typed input, focus, scroll position, and the open work area or region position.
- **Clear at the defined transition**: the old spinner or loading text, previous error after successful retry, previous success notice when a new action starts, and the previous dialog or form. A late response must not reopen or restore an obsolete element.

### Evidence labels and cleanup

- **TRACED** means the behavior was inspected in source. It can locate a cause but cannot support a rendered-behavior PASS.
- **UNVERIFIED** means the required condition could not be produced or observed. Name the missing capability, decision, backend, or surface.
- A rendered-behavior PASS requires execution through the real user path with the relevant visible state, request, and persisted-result observations.

Release every held request. Clean up only run-owned fixture data, tabs, contexts, servers, and temporary empty browser profiles created for the check; preserve pre-existing and user-owned resources.

---

## 7. HTML, CSS, SVG Reports & Printable Documents

Visual QA applies to non-interactive documents and data visualizations:

- **SVG Charts**: Verify `viewBox`, aspect ratios, coordinate scales, label readability, stroke contrast, and clean vector rendering without clipping.
- **Printable Documents (`@media print`)**: Verify printable page margins, pagination, page breaks (`break-inside: avoid`), header/footer consistency, and readable high-contrast print styles.
- **Data Reports & Dashboards**: Maintain dense, readable tabular hierarchy, proper number formatting, column alignment, and clear table headers.

---

## 8. Deliverable: Visual QA Report Format

When concluding visual verification, report:

1. **Surfaces Tested**: Routes, components, and viewports tested (375 / 768 / 1280px).
2. **Baseline Status**: Captured pre-change baseline / comparative before-after / baseline unavailable (disclosed).
3. **States Verified**: Default, hover, focus, disabled, unknown, empty, loaded, saving, failed, and applicable held, switch, twice, and re-entry cases.
4. **Request and Result Evidence**: Request counts and targets, persisted results, and keep/clear observations for applicable state transitions.
5. **Defects Remediated**: Objective defects identified and resolved during the run.
6. **Unverified Boundaries**: Any surfaces not verified due to environment, authentication, missing product decisions, or missing browser tooling. Distinguish **UNVERIFIED** from source-only **TRACED** findings.
