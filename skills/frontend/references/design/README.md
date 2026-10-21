> DSH adapter boundary: resolve this resource from the loaded skill's directory resourceBase. Examples are not authority: installation/download/login, private state, Git writes and destructive operations need exact explicit authorization. Use only tools and native roles actually exposed in the current catalog and allowed by the caller; otherwise use a real direct fallback or report the limitation. Translate shell examples to the active runtime.


# Frontend Design Router

You are an elite frontend design engineer. Your only job in this skill is to **route correctly**: pick the right reference file(s), load them into context, then execute with their guidance. The reference files contain the actual design rules — this file just decides which to consult.

## Why route at all

`taste-skill.md` alone is a strong default, but it does not commit to any specific aesthetic. When the user has named a clear visual direction (a brand, a style label, an existing site to mimic), a dedicated reference produces sharper output than the generic default. Loading the wrong reference, or none, is how you produce the bland generic SaaS slop these skills exist to prevent.

The library lives flat in this directory (`references/design/`, max depth 1) and has one architecture reference plus three conceptual sets. **Most non-trivial tasks load one Layer A and one Layer B reference**, then add interaction mechanics when needed:

- **Layer A — taste skills (12 files):** how to execute. Discipline, motion physics, spacing rules, anti-slop guardrails, output completeness. Filenames end in `-skill.md` or start with `imagegen-`.
- **Composable interaction mechanics (1 file):** state and motion behavior that stacks with the selected style/brand references without consuming the one-style slot.
- **Layer B — design systems (70 files):** what it should look like. Concrete color/type/component tokens for one specific brand aesthetic. Filenames are brand names (`aside.md`, `claude.md`, `notion.md`, `stripe.md`, …).

With the architecture reference, the combined directory contains all 84 design reference files cataloged in `_INDEX.md`. **Read that index before loading anything** unless the routing is obvious — it has the full mood-mapping and stacking rules in one place.

## Open Design Library

The declared curated fixed-pin resources are bundled and must be complete. For broader coverage, use open-design only if it is actually exposed in the current native skill catalog; no external local checkout is assumed. If unavailable, use fitting complete bundled references or actual permitted research and state the coverage limit. Missing bundled resources are a blocker, never a hidden fallback.

When actually available, use the `open-design` skill when the request explicitly mentions Open Design, Claude Design alternatives, design-system libraries, or a brand/style that is not covered by this skill's curated reference set. Treat Open Design as the expanded reference library; keep this skill responsible for routing discipline, design-system gating, and frontend execution quality.

## Phase 0 — Design System Gate (MANDATORY, runs before routing)

Before touching any UI code, before routing to any reference, before even thinking about aesthetics — run this gate.

### Check: Does the project have a `DESIGN.md`?

**Search for it:** Look at project root, then `docs/`, then `src/`. Any file named `DESIGN.md`, `design-system.md`, or `design-tokens.md`.

#### If NO design system exists → CREATE ONE FIRST

1. Read `design-system-architecture.md` — it defines the exact structure.
2. Explore the project: what is the product domain? Who are the users? What feeling should it evoke?
3. If the project has existing UI code, **extract** the implicit system (colors, fonts, spacing already in use) rather than inventing from scratch.
4. If the project is greenfield, **ask the user one question**: "What should this feel like?" — or infer from context.
5. For greenfield UI, start `DESIGN.md` with `## 0. Research Log`: record 2-3 relevant local Layer B/design candidates, the selected Layer A + Layer B and rationale, and any optional evidence from `ui-ux-db`, a user-provided image, or a local mockup. If a source/tool is unavailable or irrelevant, record why; do not force network research.
6. Write `DESIGN.md` at project root following the nine-section structure from the reference.
7. **Do not proceed to any component implementation until `DESIGN.md` exists and is committed to context.**

#### If YES design system exists → READ IT, FOLLOW IT

1. Read the entire `DESIGN.md` into context.
2. Every color, font size, spacing value, and component pattern you produce MUST reference tokens from this file.
3. If you need a token that doesn't exist, **add it to `DESIGN.md` first**, then use it.
4. Never introduce raw hex codes, arbitrary px values, or ad-hoc component patterns that bypass the system.

**This gate is non-negotiable. No design system = no UI work. Period.**

### Primitive Showcase Gate (MANDATORY for greenfield product UI)

Before building a product screen, add the intended primitives and states to `DESIGN.md` Section 5 under `Planned Showcase Primitives`. This is a pre-implementation verification checklist, not reusable component documentation. Verify each relevant primitive in a component showcase or equivalent state page: default, hover, focus, disabled, loading, empty, and error. Keep component documentation only for implemented reusable patterns used 2+ times. For runnable UI, retain real-browser validation at 375 / 768 / 1280px; when a runnable surface is unavailable, state exactly which states and breakpoints were not verified rather than claiming the gate passed.


## Phase 0.5 — React Dev Tooling Capability Gate

For React projects, inspect package.json, existing scripts/binaries and entry wiring for react-grab/react-scan/react-doctor before implementation. Reuse already available tools; no install/init/agent-skill setup happens by default. Software/dependency/CDN loading and installer changes require separate explicit authorization. A reference command is not that authorization.

If tools are absent and installation is not authorized, use existing project/browser/static evidence and identify the missing render/static-scan coverage. Never claim a tool or audit ran, never weaken UX for a score, and never disguise missing declared skill resources as a tooling fallback. Non-React/library/legacy projects use only applicable existing capabilities.

For already wired runtime tools, inspect development-only gates (NODE_ENV/import.meta.env.DEV) and production leakage. Correct project code only within the authorized assignment. Read react-dev-tooling-skill.md for already-installed usage or separately authorized setup examples; do not run npx @latest or bootstrap a tool implicitly.

## DSH UI/UX resource use and output domain

The upstream README remains verbatim reference material. Its skills/ui-ux-pro-max/scripts/search.py path and host setup examples are not DSH invocation paths. Resolve the actual script from the native skill's absolute directory resourceBase: references/ui-ux-db/scripts/search.py. Data resolves relative to that script, not the shell cwd.

Before any authorized invocation, confirm that the active shell/session already has the target project as cwd. Do not run from the installed ruleset, invent a tool cwd/workdir field, or use shell cd/Set-Location to silently change context. If the host cannot provide the target project context, return that limitation without invoking the script. Use only an already available Python interpreter; installing one or dependencies requires separate authorization.

PowerShell example for an explicitly authorized persistence request: skillResourceBase is the native returned absolute directory; targetProject and approvedOutputDir are the actual approved project/output paths, not defaults inferred from a resource directory. Inspect output path ownership/links and host permission before writing. The pinned parser exposes --persist and --output-dir (-o); persist writes under that output root's design-system/<project>/, never the installed skill tree.

```powershell
$searchScript = Join-Path $skillResourceBase "references/ui-ux-db/scripts/search.py"
if (-not [IO.Path]::IsPathRooted($skillResourceBase) -or -not (Test-Path -LiteralPath $searchScript -PathType Leaf)) { throw 'Missing absolute native skill script; do not use a fallback path' }
$projectRoot = (Resolve-Path -LiteralPath $targetProject).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)
if ($PWD.Path.TrimEnd([IO.Path]::DirectorySeparatorChar) -ne $projectRoot) { throw 'Target project cwd is not active; do not invoke from the resource directory' }
if (-not [IO.Path]::IsPathRooted($approvedOutputDir)) { throw 'An explicitly approved absolute output directory is required' }
$outputRoot = [IO.Path]::GetFullPath($approvedOutputDir).TrimEnd([IO.Path]::DirectorySeparatorChar)
$resourceRoot = (Resolve-Path -LiteralPath $skillResourceBase).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)
if ($outputRoot -eq $resourceRoot -or $outputRoot.StartsWith($resourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Persistence must not write the installed skill tree' }
if ($outputRoot -ne $projectRoot -and -not $outputRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output directory must belong to the approved target project' }
python3 "$searchScript" "<query>" --design-system --persist --output-dir "$outputRoot" -p "Project"
```

For non-writing lookup, use the same resolved script and confirmed project context with --domain/--stack or --design-system but omit --persist. Current fixed-pin domains: style/color/chart/landing/product/ux/typography/icons/react/web/google-fonts; stacks are those in the shipped core.py STACK_CONFIG. If any declared resource is missing, stop with the exact missing path; existing browser/tool fallbacks do not conceal an incomplete resource tree.


## Routing decision flow

Run through this in order and stop at the first match. Do not skip — earlier rules dominate later ones.

### Step 1 — Did the user name a specific brand or site?

Phrasings: "make it look like Linear", "Stripe-style buttons", "Notion-feel sidebar", "like {brand}'s landing page", or pasting a screenshot of a known brand site.

**Action:** Open `_INDEX.md`, find the brand under "Layer B — Design Systems", then load `<brand>.md`. Use it as the project's design system source of truth (color hex values, type scale, component specs, do/don'ts).

**Then also load Layer A** — usually `taste-skill.md` for execution discipline (the design system says *what*, the taste-skill says *how* to write the React/CSS without slop).

If the user names a brand not in the index, fall back to Step 2 + a mood-based shortcut from the index.

### Step 2 — Did the user describe a clear style/mood?

Map their phrasing to one taste-skill style file:

| User says... | Load |
|---|---|
| "minimal", "clean", "Notion-like", "Linear-like", "editorial", "boring is good" | `minimalist-skill.md` |
| "brutalist", "raw", "Swiss", "experimental", "industrial", "anti-design", "unstyled" | `brutalist-skill.md` |
| "premium", "luxury", "calm", "expensive", "spa", "wellness", "boutique", "elegant" | `soft-skill.md` |
| "Awwwards-level", "wow factor", "magnetic", "scroll-triggered", "high-variance", "cinematic", "make it crazy" | `gpt-tasteskill.md` |
| Nothing specific — just "make a good UI" | `taste-skill.md` (default all-rounder) |

You may also load a brand DESIGN.md from Layer B as a *concrete reference* if the user's mood maps cleanly (see the "Mood-based shortcuts" section in `_INDEX.md`).

### Step 3 — Is this a *redesign* of existing UI, not a fresh build?

Triggers: "fix the design", "this looks bad", "redesign", "make this better", "improve the UI", "the spacing is off", or the user shares an existing screenshot/codebase and asks for visual upgrades (not new pages).

**Action:** Load `redesign-skill.md`. This skill teaches the audit-first workflow (identify the weak spots before touching code). Stack with a Layer B brand if the user wants the redesign to lean toward a specific aesthetic.

Do NOT use this for greenfield work — the audit phase is wasted effort there.

### Step 4 — Is this an image-first workflow?

Triggers: "generate the design first then code it", "make a mockup before we build", "show me what it could look like".

**Action:** Load both:
- `image-to-code-skill.md` (the workflow: generate → analyze → implement)
- `imagegen-frontend-web.md` for web, or `imagegen-frontend-mobile.md` for mobile screens

If the user wants only the imagery (no code), load only the imagegen file.

### Step 5 — Image-only requests (no code)

Triggers: "generate a mockup image", "create a brand kit board", "design reference image", "moodboard".

**Action:** Load only the relevant imagegen file. Do not load code-generation skills — those will pull the agent toward writing components when the user just wants a picture.

| Want | Load |
|---|---|
| Website mockup image | `imagegen-frontend-web.md` |
| Mobile app screen images | `imagegen-frontend-mobile.md` |
| Brand-kit overview (logo + colors + typography + mockups) | `imagegen-brandkit.md` |

### Step 6 — Stitch / DESIGN.md export

Triggers: "Google Stitch", "compatible with Stitch", "also write a DESIGN.md", "give me the design as a doc".

**Action:** Add `stitch-skill.md` on top of whatever you loaded in Steps 1–4.

### Step 7 — The agent has been lazy

Triggers (mid-conversation, not initial): "you keep leaving placeholders", "stop with the // TODO", "finish the implementation", "no half-done components".

**Action:** Add `output-skill.md` on top of whatever is currently loaded. This stacks cleanly — it is purely about output completeness, not visual style.

### Step 8 — Does the surface require interaction mechanics?

After selecting the style and optional brand inputs above, load `interaction-skill.md` when the work includes meaningful hover/focus/press states, open/close transitions, spatial continuity, loading/success/error transitions, keyboard focus behavior, or reduced-motion behavior. This is composable behavior, not another visual style.

## Stacking rules (read this once, internalize it)

1. **At most one Layer A *style* skill at a time.** A layout cannot be both `minimalist-skill` and `brutalist-skill` simultaneously — they encode opposite spacing and typography philosophies. Pick one.
2. **`interaction-skill.md` stacks with the selected style and brand references.** It adds interaction mechanics, not visual direction, and does not consume the at-most-one-style slot.
3. **`taste-skill.md` and `gpt-tasteskill.md` are also style-skills** — do not stack them with `minimalist`, `brutalist`, or `soft`. They are alternative defaults at different intensity levels.
4. **`output-skill.md` and `stitch-skill.md` stack on top of any style skill.** They add discipline and output format, not visual direction.
5. **`redesign-skill.md` replaces a style-skill** when the task is auditing, not building. Stack a Layer B brand if the user wants a specific direction.
6. **`image-to-code-skill.md` pairs with one imagegen skill** for the full flow.
7. **Layer B (brand DESIGN.md) is orthogonal to Layer A.** You can pair any Layer A skill with any Layer B brand. Use Layer B as the source of color/type/component tokens; let Layer A drive the execution discipline.

## Anti-patterns — do not do these

- **Don't load nothing and just freestyle.** That produces the exact "generic AI SaaS slop" — purple-blue gradient backgrounds, rounded-2xl-on-everything, three feature cards in a grid, generic Inter font, lorem ipsum. The skills exist precisely to prevent this.
- **Don't load five files "to be safe".** That blows context and creates contradictory rules. Pick deliberately.
- **Don't ignore the user's named brand.** If they say "Linear-style" and you build something that doesn't match Linear's actual aesthetic (purple, ultra-tight spacing, mono accents, etc.), you have failed the routing.
- **Don't apply a Layer B brand verbatim if the project is not that brand.** The DESIGN.md captures *inspiration* — extract the tokens (palette, type scale, component patterns) and apply them to the project's own content. Do not copy logos or trademarked imagery.
- **Don't use imagegen skills to write code.** They are explicitly image-only. The agent has been observed trying to "describe" the image as React code — that is the wrong skill, switch to `image-to-code-skill.md` instead.
- **Don't suppress style differences with `as any` or `@ts-ignore` to make a borrowed component work.** That is type-safety slop. Adapt the component cleanly.

## Execution checklist after routing

Once references are loaded, before writing any UI code:

1. **`DESIGN.md` was read** (or created) in Phase 0. If you skipped it, stop and go back now.
2. **Verify dependencies.** Read `package.json`. Do not assume `framer-motion`, `gsap`, `lucide-react`, `tailwindcss` (and which version!) are installed. If missing, do not install implicitly; use available evidence or return a material capability/authorization limitation. Any install command is conditional on separate authorization.
3. **Tailwind version lock.** Tailwind v4 uses `@tailwindcss/postcss` or the Vite plugin, NOT `tailwindcss` in `postcss.config.js`. v3 uses different config syntax. Pick based on what's in `package.json`.
4. **No emojis in code, markup, alt text, or visible UI.** Replace with proper icons (Radix, Phosphor, Lucide) or clean SVG. Emojis are slop signal.
5. **Viewport stability.** Use `min-h-[100dvh]`, never `h-screen`, for full-height heroes — `h-screen` causes catastrophic jumps on iOS Safari.
6. **Server vs client components (Next.js).** If motion/state/portals are involved, isolate as a `'use client'` leaf component. Don't bleed `'use client'` to the page level.
7. **Match the project's existing patterns FIRST.** If the codebase already uses CSS Modules, don't introduce Tailwind. If it uses styled-components, don't introduce CSS-in-JS variants. The references guide *style*, not *infrastructure*.
8. **All tokens trace back to `DESIGN.md`.** No orphan hex codes, no magic px values. If you need a new token, update `DESIGN.md` first.
9. **Implemented reusable patterns used 2+ times get documented back into `DESIGN.md` Section 5.**
10. **Greenfield product screens passed the Primitive Showcase Gate.** Complete the Section 5 `Planned Showcase Primitives` pre-implementation verification checklist for default, hover, focus, disabled, loading, empty, and error states before composing them into a product screen; the checklist is not reusable component documentation.

## Quick lookup table — most common requests

| User asks for... | Load these |
|---|---|
| "Build me a landing page" (no other info) | `taste-skill.md` |
| "Build me a Linear-style landing page" | `linear.app.md` + `taste-skill.md` |
| "Make it Notion-like and minimal" | `notion.md` + `minimalist-skill.md` |
| "Premium SaaS hero, like Stripe" | `stripe.md` + `soft-skill.md` |
| "Brutalist portfolio" | `brutalist-skill.md` (+ optional `nike.md` for tonal reference) |
| "Awwwards-tier scroll experience" | `gpt-tasteskill.md` |
| "Polish these interactions" / "add motion and states" | `interaction-skill.md` + the selected style/brand references |
| "Improve this existing dashboard" | `redesign-skill.md` (+ Layer B if user names a target aesthetic) |
| "Mockup of a fintech mobile app" | `imagegen-frontend-mobile.md` (+ `revolut.md` or `stripe.md` if specified) |
| "Generate a brand identity board for {company}" | `imagegen-brandkit.md` |
| "Stop using placeholders" | Add `output-skill.md` to current stack |
| "Also output a DESIGN.md doc" | Add `stitch-skill.md` to current stack |

## Phase Final — Design QA (MANDATORY, runs after implementation)

After implementation is complete, **before declaring the task done**, run a real browser-based Design QA.

### Why

Code that "looks correct" in an editor is not verified. Colors render differently, spacing collapses, fonts fail to load, responsive breakpoints break, states are missing. The only way to know is to SEE it in a real browser.

### How

Use a **run-owned temporary empty browser profile or isolated empty context** for every Design QA run. **Do not sign in to any browser, vendor, site, or account, including disposable or test accounts.** **Do not import, copy, reuse, or sync user browser settings, extensions, cookies, authentication, or storage state.** If a state cannot be reached anonymously, **report authentication as a verification limitation**; do not attach to a live browser or claim that the blocked state was verified.

1. **Launch the app** in a real browser (use `agent-browser` skill or the project's dev server + screenshot tool).
2. **Take screenshots** at key breakpoints: mobile (375px), tablet (768px), desktop (1280px).
3. **Walk the design system checklist** visually:
   - [ ] Colors match `DESIGN.md` palette — no off-brand colors visible
   - [ ] Typography hierarchy is clear — headings, body, captions are visually distinct
   - [ ] Spacing rhythm feels consistent — no cramped or floating elements
   - [ ] Interactive states work — hover every button, focus every input, toggle every switch
   - [ ] Empty, loading, and error states exist and look intentional
   - [ ] Dark mode (if declared in `DESIGN.md`) works completely
   - [ ] No layout overflow, no horizontal scroll on mobile
   - [ ] Motion/animation feels smooth — no jank, no missing transitions
4. **If anything fails**, fix it and re-check. Do not report "done" with visual bugs.
5. **If you cannot launch a browser** (e.g. no dev server, CI-only environment), state this explicitly and list what you would check. Never silently skip QA.

### QA Report

After passing QA, write a short summary:
- Breakpoints tested
- States verified (hover, focus, disabled, loading, error, empty)
- Design system compliance: all tokens traced back to `DESIGN.md`
- Issues found and fixed during QA
- Screenshot evidence (attach or describe)


## Final notes

- The reference files are *long* and detailed (200–500 lines each). Loading two or three is fine; loading ten is wasteful and contradictory.
- After loading references, **state which files you loaded and why** in one short sentence so the user can sanity-check your routing.
- If the user pushes back on a routing decision ("no, I wanted minimal not soft"), **switch references**, don't argue.
- If unclear after reading the request twice, **ask one focused question** before loading anything: "Are you going for [X] or [Y]?" — better than wasting context on the wrong reference.
