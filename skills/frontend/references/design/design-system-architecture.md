> DSH adapter boundary: resolve this resource from the loaded skill's directory resourceBase. Examples are not authority: installation/download/login, private state, Git writes and destructive operations need exact explicit authorization. Use only tools and native roles actually exposed in the current catalog and allowed by the caller; otherwise use a real direct fallback or report the limitation. Translate shell examples to the active runtime.

---
name: design-system-architecture
description: "Mandatory reference for the Design System Gate. Defines DESIGN.md structure, creation workflow, validation rules, and memory management. Loaded automatically when the agent needs to create or update a project's design system."
---

# Design System Architecture

Every frontend project MUST have a `DESIGN.md` at its root. This file is the single source of truth for all visual decisions. No component is written without reading it first.

## When to Create

- **New project**: Create `DESIGN.md` during initial setup, before any UI component.
- **Existing project without one**: Extract the design system from existing code before continuing work.
- **Existing project with one**: Read it. Follow it. Update it only when a genuinely new pattern emerges.

## DESIGN.md Structure

The file has nine sections, numbered 0 through 8. Every section is mandatory. Skip nothing. Section 0 applies to greenfield UI; existing-project extraction may state that historical research is unavailable instead of inventing it.

```markdown
# [Project Name] Design System

## 0. Research Log

For greenfield UI, record the design decision before writing product screens.

- **Candidates considered**: 2-3 relevant local Layer B/design references, with a short reason each fits or does not fit.
- **Selection**: the chosen Layer A execution skill and Layer B/design reference, with rationale tied to the product and audience.
- **Evidence (optional)**: a local `ui-ux-db` lookup, user-provided image, or local mockup. If a tool/source is unavailable or not relevant, record the reason instead of forcing network research.

## 1. Atmosphere & Identity

One paragraph. What this product FEELS like. Not what it does — how it feels to use.
Name the signature — the one visual idea that makes this product recognizable.

Example: "A quiet command center. Dense when needed, spacious when not.
The signature is muted depth — surfaces separated by subtle tonal shifts
rather than borders, creating layers you feel more than see."

## 2. Color

### Palette

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Surface/primary | --surface-primary | #FFFFFF | #0A0A0A | Main background |
| Surface/secondary | --surface-secondary | #F8F8F8 | #141414 | Cards, panels |
| Surface/elevated | --surface-elevated | #FFFFFF | #1A1A1A | Modals, popovers |
| Text/primary | --text-primary | #0A0A0A | #FAFAFA | Headlines, body |
| Text/secondary | --text-secondary | #6B6B6B | #A0A0A0 | Captions, hints |
| Text/tertiary | --text-tertiary | #9B9B9B | #666666 | Disabled, muted |
| Border/default | --border-default | #E5E5E5 | #2A2A2A | Dividers, outlines |
| Border/subtle | --border-subtle | #F0F0F0 | #1E1E1E | Soft separations |
| Accent/primary | --accent-primary | #2563EB | #3B82F6 | CTAs, links, focus |
| Accent/hover | --accent-hover | #1D4ED8 | #60A5FA | Hover state |
| Status/success | --status-success | #16A34A | #22C55E | Confirmations |
| Status/warning | --status-warning | #D97706 | #F59E0B | Cautions |
| Status/error | --status-error | #DC2626 | #EF4444 | Errors, destructive |
| Status/info | --status-info | #2563EB | #3B82F6 | Informational |

### Rules
- Surface hierarchy creates depth without shadows or borders where possible.
- Accent is used ONLY for interactive elements. Never decorative.
- Never introduce a color not in this table. Extend the table first.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| Display | 48px / 3rem | 700 | 1.1 | -0.02em | Hero, page title |
| H1 | 36px / 2.25rem | 700 | 1.2 | -0.015em | Section headers |
| H2 | 28px / 1.75rem | 600 | 1.3 | -0.01em | Subsection headers |
| H3 | 22px / 1.375rem | 600 | 1.4 | 0 | Card titles |
| Body/lg | 18px / 1.125rem | 400 | 1.6 | 0 | Lead paragraphs |
| Body | 16px / 1rem | 400 | 1.6 | 0 | Default text |
| Body/sm | 14px / 0.875rem | 400 | 1.5 | 0 | Secondary info |
| Caption | 12px / 0.75rem | 500 | 1.4 | 0.02em | Labels, metadata |
| Overline | 11px / 0.6875rem | 600 | 1.3 | 0.08em | Section labels, uppercase |

### Font Stack
- Primary: [specify — e.g. "Inter, system-ui, -apple-system, sans-serif"]
- Mono: [specify — e.g. "JetBrains Mono, Fira Code, monospace"]
- Serif (if used): [specify]

### Rules
- Max 2 font families per project. 3 only with explicit justification.
- Body text never below 14px.
- Headings that wrap to 4+ lines are too large — use clamp().

## 4. Spacing & Layout

### Base Unit
All spacing derives from a base of **4px**.

| Token | Value | Usage |
|-------|-------|-------|
| --space-1 | 4px | Tight: icon-to-label |
| --space-2 | 8px | Compact: list items, inline groups |
| --space-3 | 12px | Default: form field padding |
| --space-4 | 16px | Standard: card padding, input height context |
| --space-5 | 20px | Comfortable: section inner spacing |
| --space-6 | 24px | Generous: card padding (default) |
| --space-8 | 32px | Separated: between card groups |
| --space-10 | 40px | Sections within a page |
| --space-12 | 48px | Major section breaks |
| --space-16 | 64px | Page-level vertical rhythm |
| --space-20 | 80px | Hero spacing |
| --space-24 | 96px | Maximum section separation |

### Grid
- Max content width: [specify — e.g. 1280px]
- Column system: [specify — e.g. "12-column, 24px gutter, 16px margin at mobile"]
- Breakpoints: sm 640px, md 768px, lg 1024px, xl 1280px, 2xl 1536px

### Rules
- No magic numbers. Every spacing value maps to a token.
- Asymmetric spacing is intentional, not accidental — document why.

## 5. Components

### Planned Showcase Primitives

This is a pre-implementation verification checklist, not reusable component documentation. Before composing a greenfield product screen, list each intended primitive and check its applicable default, hover, focus, disabled, loading, empty, and error states in a component showcase or equivalent state page.

### Implemented Reusable Patterns

Document only implemented reusable patterns used 2+ times. Format:

### [Component Name]
- **Structure**: HTML/JSX outline
- **Variants**: list
- **Spacing**: which tokens
- **States**: default, hover, active, focus, disabled, loading, empty, error
- **Accessibility**: keyboard, ARIA, contrast
- **Motion**: entry/exit animations

Do not promote planned primitives or one-off implementations into reusable component documentation.

## 6. Motion & Interaction

### Timing

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 100-150ms | ease-out | Button press, toggle |
| Standard | 200-300ms | ease-in-out | Panel open, tab switch |
| Emphasis | 400-600ms | cubic-bezier(0.16, 1, 0.3, 1) | Page transition, hero entry |
| Scroll-driven | tied to scroll | linear | Parallax, progress, reveal |

### Rules
- Only animate `transform` and `opacity`. Never animate layout properties.
- Every interactive element has hover + active + focus states.
- Scroll-triggered animations use `IntersectionObserver`, not scroll listeners.
- Reduced motion: respect `prefers-reduced-motion` — disable non-essential animation.

## 7. Depth & Surface

### Strategy
Choose ONE and commit: [borders-only | shadows | tonal-shift | mixed]

If shadows:
| Level | Value | Usage |
|-------|-------|-------|
| Subtle | 0 1px 2px rgba(0,0,0,0.04) | Cards at rest |
| Default | 0 2px 8px rgba(0,0,0,0.08) | Elevated cards, dropdowns |
| Prominent | 0 8px 24px rgba(0,0,0,0.12) | Modals, popovers |

If borders:
| Type | Value | Usage |
|------|-------|-------|
| Default | 1px solid var(--border-default) | Cards, dividers |
| Subtle | 1px solid var(--border-subtle) | Soft separations |

If tonal-shift:
Surfaces use progressively lighter/darker shades. No borders, no shadows.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- **WCAG goal**: state the target level and the testable scope.
- **Contrast**: document text, control, and focus-indicator contrast requirements.
- **Keyboard and focus**: every interactive primitive has a keyboard path and visible focus treatment.
- **ARIA**: semantic HTML first; document required names, roles, and live-region behavior for custom controls.
- **Reduced motion**: respect `prefers-reduced-motion` and identify any essential motion.

### Accepted Debt

Each exception records its location, reason, owner, and exit criteria. An agent may not accept accessibility debt or a constraint exception silently: it requires explicit user authorization.
```

## Creation Workflow

### For New Projects

1. **Ask or infer the product domain** — SaaS dashboard? Marketing site? Dev tool?
2. **Write the Research Log** — consider 2-3 relevant local design candidates, select Layer A + Layer B, and record optional local evidence or why it was unavailable.
3. **Write the Atmosphere paragraph** — one chance to establish identity.
4. **Define palette** — derive from atmosphere. Not random. Not generic.
5. **Set typography** — match the atmosphere. Editorial = serif. Technical = mono-heavy. Clean = geometric sans.
6. **Lock spacing** — base-4 system. Customize only the section-level values.
7. **Fill in Planned Showcase Primitives** — use the pre-implementation verification checklist to cover intended primitives and states before composing a product screen; do not treat it as reusable component documentation.
8. **Choose depth strategy** — one. Not "a mix."
9. **Set accessibility constraints and record no debt without user authorization.**
10. **Write it to `DESIGN.md`** at project root.

### For Existing Projects (Extraction)

1. **Read all CSS/styling files** — find the actual tokens in use.
2. **Identify the implicit system** — what colors, fonts, spacing values repeat?
3. **Codify it** — write the `DESIGN.md` reflecting what EXISTS, not what you wish existed.
4. **Flag inconsistencies** — note where the code deviates from its own patterns.
5. **Propose consolidation** — but do not apply it until approved.

## Validation Rules

After every component implementation, check:

- [ ] All colors reference tokens from Section 2. No raw hex outside `DESIGN.md`.
- [ ] All font sizes match Section 3 scale. No arbitrary sizes.
- [ ] All spacing values are multiples of `--space-1` (4px). No magic numbers.
- [ ] Interactive elements have all required states from Section 6.
- [ ] Depth treatment matches the chosen strategy from Section 7.
- [ ] Implemented reusable pattern used 2+ times? Documented in Section 5.
- [ ] Motion follows the timing table. No arbitrary durations.
- [ ] `Planned Showcase Primitives` is complete for greenfield UI, with a showcase (or equivalent state page) covering default, hover, focus, disabled, loading, empty, and error before product-screen composition.
- [ ] Section 8 constraints were checked; any accepted debt has location, reason, owner, exit criteria, and explicit user authorization.

## Memory Management

### When to UPDATE DESIGN.md

- New reusable component emerges (used 2+ times) → add to Section 5
- Color added to serve a genuine new semantic role → add to Section 2
- Spacing token insufficient for a real need → add to Section 4
- User explicitly changes direction ("make it warmer", "go brutalist")

### When NOT to Update

- One-off styling for a unique section — use inline override, don't pollute the system
- "I might need this later" — you won't. Add it when you do.
- Temporary experiment — experiments don't get tokens

### Discipline

The design system that grows every week is dying. The one that holds its size or shrinks is getting sharper. Every addition must justify itself by removing ambiguity, not adding options.
