> DSH adapter boundary: resolve this resource from the loaded skill's directory resourceBase. Examples are not authority: installation/download/login, private state, Git writes and destructive operations need exact explicit authorization. Use only tools and native roles actually exposed in the current catalog and allowed by the caller; otherwise use a real direct fallback or report the limitation. Translate shell examples to the active runtime.

# Interaction mechanics

This is a composable mechanics reference, not a visual style choice. Load it when the work includes meaningful hover/focus/press behavior, disclosure or modal transitions, drag/spatial continuity, loading/success/error transitions, or motion-system decisions. It stacks with one selected Layer A style skill and an optional Layer B design system; it never consumes the one-style slot.

## Read the project before choosing motion

1. Read the complete project `DESIGN.md` and use its tokens and motion rules.
2. Read the component conventions and the existing implementation of the affected primitive.
3. Inspect `package.json`, the lockfile, and imports to identify the existing animation/motion stack. Do not assume Tailwind, Motion, a spring library, or any other package is installed.
4. Prefer existing CSS and project utilities. Before proposing a new dependency, record its bundle/runtime cost and why the current stack cannot express the required behavior. A new dependency still requires the task's normal design and authorization process.

External interaction catalogs may be used as optional inspiration when already available, but the implementation and verification contract below is complete without network access or vendor components.

## Interaction-state matrix

Before implementation, write the relevant rows for each affected component. Omit states that truly do not apply; never omit a state merely because it is harder to verify.

| State | Trigger/input | Visual response | Motion/duration | Focus/announcement | Reduced-motion behavior |
|---|---|---|---|---|---|
| Default | Initial/settled | Token-defined baseline | None unless state continuity needs it | Correct semantic role/name | Same information |
| Hover | Pointer hover | Clear affordance without layout shift | Short transform/opacity/color transition | No focus substitution | Instant or reduced transition |
| Focus | Keyboard/programmatic focus | Visible token-defined focus indicator | No delayed focus feedback | Focus order and target verified | Indicator remains visible |
| Press/active | Pointer or keyboard activation | Immediate pressed response | No input-latency animation | Activation works with keyboard | Immediate response |
| Open/close | Disclosure, menu, dialog, popover | State and spatial origin remain legible | Interruptible transition | Focus move/return and semantics verified | Instant or minimal continuity |
| Loading | Async work starts | Stable layout and progress state | Motion never blocks input or status | Busy/status semantics as applicable | Non-animated status remains |
| Success | Operation succeeds | Confirm result without surprise movement | Brief state transition | Status conveyed non-visually | Same information without motion |
| Error | Operation fails | Error is adjacent and actionable | No decorative shake requirement | Error relationship/announcement verified | Same information without motion |
| Disabled | Action unavailable | Distinct but readable state | No hover/press affordance | Native semantics when possible | Identical behavior |

## Mechanics rules

- Motion communicates state change or spatial continuity; it is not decoration added to every element.
- Input acknowledgement is immediate. Never delay click, key, focus, drag, or close handling until an animation completes.
- Prefer compositor-friendly `transform` and `opacity`; do not animate layout properties when an equivalent composited transition exists.
- Spatial interactions may use interruptible spring motion only when the existing stack supports it. Reversal or repeated input must retarget from the current visual state rather than queue stale animations.
- Reserve persistent slots for labels, icons, and loading indicators. Size the control for its longest supported label, and swap or overlay content within those slots so loading, success, or icon changes don't alter width, height, or padding or move a neighbouring target. Keep the accessible name and status meaningful when visual text is hidden.
- Preserve layout stability, readable focus indicators, semantic state, and input modality parity.
- `prefers-reduced-motion` removes non-essential motion and shortens essential continuity while preserving every state and outcome.

## Accessibility on affected surfaces

Check the A and AA criteria in [WCAG 2.2](https://www.w3.org/TR/WCAG22/) relevant to the changed controls and their surrounding flow. These checks describe scoped evidence, not a complete conformance assessment or certification.

- **Contrast (1.4.3, 1.4.11):** check text at 4.5:1, or 3:1 for large text, and visual information needed to identify controls and states at 3:1 against adjacent colours. Check affected themes and placeholders. Apply the criteria's exceptions, including inactive controls, incidental text and logotypes; unmodified browser controls are exempt from the non-text contrast requirement.
- **Focus and keyboard (2.4.7, 2.4.11, 2.1.1, 2.1.2):** keep a visible focus indicator and keyboard operation without a focus trap. Focused controls must not be entirely hidden by author-created content such as sticky bars or overlays. Assess user-movable content at its initial position. User-opened content can obscure focus when the person can reveal the focused control without advancing keyboard focus. Aim to keep controls fully visible; that stronger target is distinct from the AA minimum. Preserve the keyboard criterion's exception for functions whose input depends on the path of movement.
- **Pointer targets (2.5.8):** provide at least 24 by 24 CSS px, or satisfy the spacing exception: a 24 CSS px diameter circle centred on each undersized target's bounding box must not intersect another target or another undersized target's circle. Other exceptions cover an equivalent conforming control on the same page, inline targets in sentences or targets constrained by non-target text line height, unmodified user-agent controls, and an essential or legally required presentation. A small glyph can have a larger hit area.
- **Reflow and spacing (1.4.10, 1.4.12):** check reflow at a 320 CSS px viewport width for vertically scrolling content; parts that need a two-dimensional layout, such as a data table or map, have an exception. With line height 1.5, paragraph spacing 2 times the font size, letter spacing 0.12em and word spacing 0.16em, applicable text must not lose content or functionality. Apply only spacing properties used by the language or script.
- **Dragging (2.5.7):** provide a single-pointer alternative that doesn't require dragging, unless dragging is essential or the unmodified user agent supplies the function. Keyboard support alone doesn't satisfy this criterion.
- **Authentication, help and repeated entry (3.3.8, 3.2.6, 3.3.7):** where these flows are affected, allow password-manager and paste assistance rather than requiring an unaided cognitive test; check the criterion's alternative, assistance, object-recognition and personal-content exceptions. Keep repeated help mechanisms in the same relative order unless the person changes it. Reuse information entered earlier in the same process or make it selectable, except where re-entry is essential, needed for security, or the prior information is no longer valid.

Report the affected criteria checked, observed failures, and unavailable evidence. Don't claim whole-product AA conformance from these checks.

## Real-browser QA

Drive the actual browser surface rather than inferring behavior from code.

1. Exercise every applicable matrix row with pointer input.
2. Repeat activation, open/close, and focus flow using only the keyboard; verify visible focus and focus return.
3. Repeat under reduced motion and verify information/state parity.
4. Interrupt and reverse spatial transitions to prove they do not queue, jump, trap focus, or ignore input.
5. Check representative mobile, tablet, and desktop breakpoints required by the parent frontend rules.
6. Capture the available trace and screenshots for normal and reduced-motion states. If the harness cannot capture one evidence type, report exactly which evidence is absent rather than claiming it exists.

Completion requires the relevant matrix rows, package/stack evidence, real-browser normal and reduced-motion results, keyboard and pointer coverage, and captured trace/screenshot paths. No network catalog, vendor package, or unavailable command is required.
