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
- Preserve layout stability, readable focus indicators, semantic state, and input modality parity.
- `prefers-reduced-motion` removes non-essential motion and shortens essential continuity while preserving every state and outcome.

## Real-browser QA

Drive the actual browser surface rather than inferring behavior from code.

1. Exercise every applicable matrix row with pointer input.
2. Repeat activation, open/close, and focus flow using only the keyboard; verify visible focus and focus return.
3. Repeat under reduced motion and verify information/state parity.
4. Interrupt and reverse spatial transitions to prove they do not queue, jump, trap focus, or ignore input.
5. Check representative mobile, tablet, and desktop breakpoints required by the parent frontend rules.
6. Capture the available trace and screenshots for normal and reduced-motion states. If the harness cannot capture one evidence type, report exactly which evidence is absent rather than claiming it exists.

Completion requires the relevant matrix rows, package/stack evidence, real-browser normal and reduced-motion results, keyboard and pointer coverage, and captured trace/screenshot paths. No network catalog, vendor package, or unavailable command is required.
