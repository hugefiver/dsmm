---
name: frontend
description: "MUST USE for ANY frontend, web UI, UX, or visual work — building, styling, or redesigning pages/components, React project setup, performance audits, design QA. Routes three rulesets: design (anti-slop taste router over 12 taste skills + 70 brand DESIGN.md refs — Apple, Stripe, Linear, Notion, Vercel, Claude, Nike, Aside — plus composable interaction mechanics and the React dev tooling gate: react-grab, react-scan, react-doctor), perfection (Lighthouse 100 in every category via real Playwright Chromium audits, NEVER the lighthouse CLI, never by weakening UX), ui-ux-db (searchable 50+ styles, 97 palettes, 57 font pairings, 99 UX guidelines). Triggers: frontend, UI, UX, design, redesign, styling, layout, animation, motion, interaction, interaction mechanics, state, reduced-motion, taste, premium, luxury, minimal, brutalist, Awwwards, anti-slop, polish, DESIGN.md, mockup, react setup, react-scan, react-doctor, lighthouse, performance, Core Web Vitals, LCP, CLS, INP, SEO, accessibility, a11y, WCAG, audit my site, make this faster, color palette, font pairing, looks generic, make it pretty, like X brand, clone site, clone from url."
---

## DSH resource and authority contract

This is a DSMM-maintained native skill for DSH 0.2.1-rc.2, not an OpenCode or Codex runtime. Product names in transcript formats, examples, paths and attribution remain descriptive; they are not a host switch.

- Load this skill through the native skill tool only when its trigger matches. Resolve every relative reference/script/asset from the directory resourceBase returned with this skill, not from the project cwd or a sibling repository checkout. Use available read/glob/grep to inspect resources; use write/edit and the active bash or pwsh only within the actual role and host permissions.
- External documentation uses actual web_search/web_fetch or an available documentation service. Context7, GitHub MCP, browser, image and LSP tools are optional catalog capabilities, not bundled calls. Use a real available equivalent or report unavailable evidence; never invent an MCP, Task, todo or compression API. Native read uses file_path, not OpenCode filePath; inspect every actual schema before calling it. Use read_image only when exposed and the actual route supports its image result.
- Source role names are logical assignments: code-search/explore maps to role ID dsmm-code-search, and other canonical roles/categories map to dsmm-<name>. Use this Agent's observed admitted inventory: per-role topology has individual role tools (for example dsmm_plan_critic) plus dsmm_category; parameterized topology has dsmm_role and dsmm_category with their actual role/category enums. Never derive callability from generated files, names or templates. Both layouts preserve target, caller, read-only, inherited tool and depth ceilings; a missing required formal role returns to the stage owner, not a planning bypass.
- Templates describe assignment content, not callable schemas. Actual delegation takes description/prompt, an exposed level, a deployment-authorized exposed route, and an exposed run_in_background only. Omitted/normal retains the default; low/high/max must be configured at roleRouting.<id>.levels as a complete route or exact supported effort, never synthetic suffix roles or fixed max effort. A complete invocation route needs paired provider/model and cannot silently fall back; effort-only needs exact native preflight. Level/layout never change permissions or verification rigor. Reviewer/Oracle independence requires different observed native routes, not names.
- One-shot defaults foreground; permitted one-shot background is native-job-owned. A managed admitted continuable configuration defaults background; explicit run_in_background:false creates a non-reusable one-shot. Use only exposed job_output/job_list/job_kill or send_message/interrupt_agent and returned identities. Existing continuable children can receive nearest-step running messages, idle next turns or same-ID cold continuation; receipts mean inbox acceptance, not completion. Exposed native child-to-parent reporting retains exact-sender/adjacency semantics, not new parent-to-child authority. Settled one-shots never revive; reuse never reselects role/level/route or copies a parent's newer policy into the original child capture. Do not send OpenCode task_id/subagent_type/background/resume/retry or guessed control fields.
- Host observations alone establish lifecycle controls. Managed delivery requires explicit startup composition: disable the stock subagents row, bind the unique PUBLIC DSMM SubagentRuntime subclass and restart; never hot-replace/drain stock or add a shadow runtime. When actually wired and authorized, a user foreground handoff transfers the existing same run to native jobs without a second start; native user queue/steer follows its operator/connection/session/epoch gate. Do not announce unconnected tools/RPCs. Background enablement, capacity, ownership, depth, cancellation and provider support always gate execution. Legacy conservative evidence may permit useful proven capabilities under the same durable child ID; missing evidence denies that capability with a reason, not all legacy children and not an inheritance of current parent policy.
- When exposed, native todo_write replaces the owning Agent's whole list of content/status items; its schema and allowParallelInProgress policy govern updates. Otherwise use concise session coordination or an authorized plan. ask_user_question is conditional on exposure; otherwise ask in conversation. Native host compaction is not a model-facing compression tool. A read-only planner returns complete Markdown; an authorized coordinator persists it, never the planner through shell or a proxy. Role responsibilities, explicit-off common/skill visibility, and the terminal delegation contract override broader examples in a resource.
- Follow the current user's explicit output-language request, otherwise this Agent's immutable captured DSMM locale when supplied, then applicable host/user language guidance or the current request/context. Supported configured locales are en/zh-Hans/zh-Hant/ja/ko/de/fr/es/pt-BR/ru; omission inherits, not an English default. Preserve code, identifiers, paths, commands, protocol fields and exact quotes, and pass explicit language instructions in child assignments. This resource imports no Root session preference, promises neither internal reasoning language nor UI translation, and never changes host/project locale. A later parent Apply does not rewrite a child's captured locale.
- Installation, package-manager bootstrap, downloads, authentication/login, credential/profile access, Git writes and destructive actions require explicit authorization for the exact action. Reference commands are not automatic operations. Worktree consent does not authorize dependency installation or later branch deletion. Read before changing an existing file; preserve unrelated user work. Never silently restore/reset a working tree to repair a failed cleanup.
- Browser/debug QA uses run-owned isolated state, no imported credentials or browser profile, and only already available software unless separately authorized. Keep commands in the active shell dialect. Report unverified surfaces honestly.

# Frontend

This file is a router, not a rulebook. The rules live in three rulesets under `references/`; your first job is to load the smallest set of files that covers the request, state which you loaded in one sentence, then execute under their guidance. Loading nothing and freestyling produces the generic AI-slop output this skill exists to prevent; loading everything wastes context and creates contradictory instructions.

## Phase 0 — Route (before any UI work)

| Request involves… | Read |
|---|---|
| ANY UI implementation, styling, redesign, mockup, or visual decision | `references/design/README.md` FIRST. Governs the Brief → Build → Subtract → Verify workflow: restrained defaults for internal tools/dashboards/reports/charts; small adjustments inspect touched tokens/components without forcing `DESIGN.md`; subtracts decorative clutter while strictly preserving required content; checks already available React dev tooling without unauthorized installs; routes to taste/brand references. |
| Writing or modifying frontend code, OR auditing performance / SEO / accessibility / quality | ALSO `references/perfection/README.md`. Lighthouse 100 in every category, measured on real Playwright Chromium (never the `lighthouse` CLI), achieved through architecture — never by dropping animations or hiding/deleting required content. |
| Visual QA, before/after verification, screenshot audits, UI defect triage, or checking responsive breakpoints | `references/visual-qa.md`. Enforces fixed-state before/after comparison, defect vs. taste distinction, bounded progress, and distinguishing harness failures from product defects. |
| Looking up a concrete style, color palette, font pairing, chart type, landing-page structure, or UX guideline — or generating a project design system from keywords | `references/ui-ux-db/README.md`. A searchable CSV database with a CLI; a lookup tool, not a posture. Load on demand; `design` stays the source of truth for taste and the `DESIGN.md` contract. |

**For implementation work, design + perfection load together.** A page that hits Lighthouse 100 but looks like AI slop has failed; a page that looks beautiful but ships a 2 MB bundle has failed. Both win or neither does.

## Ruleset 1 — design (`references/design/`)

The reference library has one architecture file, 12 taste skills (Layer A — *how to execute*), one composable interaction-mechanics reference, and 70 brand design systems (Layer B — *what it should look like*). Most non-trivial tasks load **one Layer A + one Layer B**; add the interaction reference when the surface needs it. `README.md` carries the full routing flow, stacking rules, anti-patterns, and the mandatory browser-based Design QA phase; `_INDEX.md` catalogs all 84 files with mood-to-brand mappings — read it whenever routing is not obvious from the tables below.

### Layer 0 — architecture

| File | Read when |
|---|---|
| `design-system-architecture.md` | The project has no `DESIGN.md` (defines the 7-section structure you must create first), or you are extracting a design system from existing UI code. |

### Layer A — taste skills (pick AT MOST ONE style skill; they encode opposing philosophies)

| File | Read when the user says… |
|---|---|
| `taste-skill.md` | Nothing style-specific — "make a good UI". The default all-rounder. |
| `gpt-tasteskill.md` | "Awwwards-tier", "wow factor", "cinematic", "scroll-triggered", or `taste-skill` results felt too safe. |
| `minimalist-skill.md` | "minimal", "clean", "Notion-like", "Linear-like", "editorial". |
| `brutalist-skill.md` | "brutalist", "raw", "Swiss", "experimental", "anti-design". |
| `soft-skill.md` | "premium", "luxury", "calm", "expensive", "spa", "boutique", "elegant". |
| `redesign-skill.md` | Improving EXISTING UI — "this looks bad", "fix the design". Audit-first workflow; never use on greenfield. |
| `image-to-code-skill.md` | "Generate the design first, then code it." Pair with one imagegen file below. |
| `output-skill.md` | Stacks on any style skill when output is incomplete — placeholders, `// TODO`, half-done components. |
| `stitch-skill.md` | Stacks on any style skill for Google Stitch compatibility or a `DESIGN.md` doc export. |
| `imagegen-frontend-web.md` / `imagegen-frontend-mobile.md` / `imagegen-brandkit.md` | Image-only output (mockup, app-screen concepts, brand board). These NEVER write code — switch to `image-to-code-skill.md` if code is wanted. |

### Composable interaction mechanics (stacks; not a style choice)

| File | Read when |
|---|---|
| `interaction-skill.md` | The work includes meaningful interaction states, open/close transitions, spatial continuity, loading/success/error transitions, keyboard focus behavior, or reduced-motion behavior. Stack it with the selected style/brand references; it does not consume the one-style slot. |

### Layer B — brand design systems (orthogonal to Layer A; stack freely)

When the user names a brand or site — "Linear-style", "like Stripe's landing", "Aside-style" — load `references/design/<brand>.md` as the token source of truth (palette, type scale, components, do/don'ts). Coverage includes `apple` `stripe` `linear.app` `notion` `vercel` `claude` `figma` `airbnb` `nike` `tesla` `spotify` `raycast` `revolut` `aside` and ~56 more; the full list with mood shortcuts is in `_INDEX.md`. Extract the tokens and apply them to the project's own content — never copy logos or trademarked imagery. If the named brand is missing, fall back to a Layer A mood match or the `open-design` skill. When the user gives a live URL to clone, load `references/design/clone-from-url.md` for the runtime extraction workflow.

### React dev tooling

| File | Read when |
|---|---|
| `react-dev-tooling-skill.md` | A React project lacks react-grab / react-scan / react-doctor, or you need per-framework install snippets and the dev-only gating pattern (`NODE_ENV === 'development'`). |

## Ruleset 2 — perfection (`references/perfection/`)

| File | Read when |
|---|---|
| `README.md` | Any frontend code is written or audited. Carries the seven tenets: real-browser audits only, 100-in-every-category floor, fix-at-the-architecture, never weaken UX for points, design-system compliance checks, and the response format for audit reports. |
| `react-perf-tooling.md` | Before ANY React audit. The Playwright + `playwright-lighthouse` + `react-scan/lite` injection recipe, per-route render budgets, and the React-specific root-cause checklist. Lighthouse 100 with 30+ unnecessary renders is NOT done. |

The retained `scripts/perfection/lighthouse-audit.py` is a legacy helper and **must not be used as a browser verification entry point**: it does not satisfy the run-owned endpoint contract and may install missing dependencies. Use the canonical TypeScript example in `references/perfection/README.md`; if its existing dependencies are unavailable, report the browser-verification limitation without installing anything. Run mobile AND desktop presets, 3–5 runs, take the median, and diagnose from the JSON report.

## Ruleset 3 — ui-ux-db (`references/ui-ux-db/`)

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

## Quick routes — most common requests

| Request | Load |
|---|---|
| "Build a landing page" (no direction given) | `design/README.md` + `design/taste-skill.md` + `perfection/README.md` |
| "Linear-style landing page" | `design/README.md` + `design/linear.app.md` + `design/taste-skill.md` + `perfection/README.md` |
| "Premium SaaS hero like Stripe" | `design/README.md` + `design/stripe.md` + `design/soft-skill.md` + `perfection/README.md` |
| "Aside-style agent-browser landing" | `design/README.md` + `design/aside.md` + `design/taste-skill.md` + `perfection/README.md` |
| "Clone this site" / "rebuild `<url>`" | `design/README.md` + `design/clone-from-url.md` + `perfection/README.md` |
| "Improve this existing dashboard" | `design/README.md` + `design/redesign-skill.md` + `references/visual-qa.md` + `perfection/README.md` |
| "Internal tool" / "dashboard" / "report layout" | `design/README.md` (brief + restrained default) + `design/minimalist-skill.md` + `references/visual-qa.md` |
| "Visual QA this page" / "check before and after" | `references/visual-qa.md` |
| "Polish these interactions" / "add motion and states" | `design/README.md` + `design/interaction-skill.md` + the selected style/brand reference + `perfection/README.md` |
| "Audit my site" / "make this page faster" | `perfection/README.md` (+ `perfection/react-perf-tooling.md` if React) |
| "Mockup image of a fintech app" — no code | `design/imagegen-frontend-mobile.md` (+ a Layer B brand if named) |
| "What palette/fonts fit a wellness brand?" | `ui-ux-db/README.md` → search CLI |
| "Set up this React project" | `design/README.md` + `design/react-dev-tooling-skill.md` |

## Shared axioms (all rulesets agree — apply always)

- **Brief → Build → Subtract → Verify workflow**:
  - Clarify user goal, primary action, information hierarchy, and required content upfront.
  - Internal tools, dashboards, reports, and charts default to restrained, clear, content-first layouts; expressive atmosphere is opt-in.
  - For small adjustments, inspect touched tokens or adjacent styled components directly without forcing `DESIGN.md` or full-page redesigns.
  - Subtraction removes decorative excess; NEVER delete, omit, or merge required content (fields, inputs, columns, copy) to fit a layout or buy points.
- **Visual QA uses fixed-state before/after**:
  - Lock route, view state, viewport (375 / 768 / 1280px), theme, test data, and scroll position before editing.
  - Never fake or back-date a baseline if pre-change capture was missed; disclose baseline absence honestly.
  - Distinguish objective defects from subjective taste; prioritize defect resolution over aesthetic churning.
  - Distinguish test harness failures from product defects; disclose limitations honestly.
- **Browser isolation & security boundaries**:
  - Use a run-owned temporary empty browser profile or isolated context only.
  - Strictly NO login or account use (including disposable or test accounts).
  - NEVER copy, import, or reuse user browser profiles, cookies, extensions, or storage.
  - NEVER install browser binaries or software packages autonomously.
  - If a surface is authentication-gated, report authentication as a verification limitation rather than attempting to bypass or authenticate.
- **Never weaken UX to buy points.** No dropping animations, hiding content, or simplifying interactions for a score or a deadline.
- **No emojis as icons.** SVG icon sets only (Lucide, Heroicons, Radix, Phosphor).
- **GPU-composited animation only** — `transform`, `opacity`, `filter`; never animate layout properties.

## When to load something else instead

| Situation | Load |
|---|---|
| Brand/style not among the 70 in `references/design/`, or the user says "Open Design" | Use open-design only if actually exposed in the native skill catalog; otherwise use a fitting bundled taste/brand reference or available direct research. Do not assume a local external checkout. |
| Driving a browser for the Design QA phase | Use an actually exposed browser skill/tool or already available, authorized isolated Playwright; if unavailable, report the browser QA blocker. |
| Pure TypeScript/logic work with zero visual surface | Use a fitting actual implementation role; an additional programming skill is optional only if exposed. This frontend skill adds nothing to nonvisual logic. |

## Activation

Use for any frontend, web UI, UX, visual, design, styling, layout, animation, performance, accessibility, or SEO work — building, redesigning, auditing, or generating mockups. Not for backend, CLI, or pure-logic tasks with no visual surface.
