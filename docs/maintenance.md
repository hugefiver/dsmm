# DSMM maintenance

DSMM is maintained as a standalone project. `src/`, `prompts/`, and `skills/` are
the authoritative source trees. Builds, tests, generators and package checks must
not read a parent or sibling repository.

## Toolchain

Use Node.js 24 for CI/release and pnpm 11.9.0. The package still supports Node.js
22 or later at runtime and supports DSH `>=0.2.1-rc.2 <0.3.0`, with rc.2 as the
development dependency baseline. Do not change the npm
name `@dsmm/dsmm`, package version, or DSH dependency line as part of routine
maintenance unless the release or compatibility scope explicitly requires it.

Common checks:

```powershell
pnpm run typecheck
pnpm run build
pnpm run test:list
pnpm run test:module -- <module> [module...]
pnpm run test:integration -- <group> [group...]
pnpm run check:frontend
pnpm run check:roles
pnpm pack --pack-destination <approved-output-directory>
```

`pnpm test` remains the convenient build-plus-fast-smoke command. CI and release
also use that smoke entry after build and typecheck, alongside frontend, generated
role and package checks. Development and final acceptance select only affected
module suites and interface integrations; the explicit full diagnostic is not a
default gate. See [testing](testing.md). Dependency installation and lockfile
maintenance are separate authorized operations.

## Generated role assets

`src/roles.ts`, `src/prompts.ts`, and `prompts/source/` supply the maintained role
and workflow content. After changing inputs that affect rendered presets or the
base Deepwork prompt, run `pnpm run generate:roles`. CI uses
`pnpm run check:roles` and fails if `agent-presets/` or `prompts/deepwork.md` is
stale. Generated assets are package resources, not an alternate source of truth.

Model guidance is subordinate to the selected role and native DSH host contract.
Kimi models share one current-generation `deepwork/kimi.md` calibration; older
generations have no separately maintained prompt. Gemini 4.x, including Argon,
receives a guarded `gemini-4` additive layer based on generic Gemini guidance.
Prompt selection does not change provider, effort, fallback chains or DSH model
capabilities.

Effective Deepwork activation includes a short brainstorming orientation. Full
brainstorming remains a native skill loaded only when material uncertainty calls
for discovery or design; explicit mode-off and native skill controls remain
authoritative. Standing role, authorization and workflow rules do not depend on
loading the full skill. Planning and execution reviews continue for concrete
blocker or evidence progress, not unchanged doubts or repeated same-cause failures.
Harness failures and unmet requirements remain explicit rather than being treated
as product failures or successful completion.

Frontend work follows brief → build → subtract → verify. Small edits preserve
existing styles and required content; visual QA uses comparable real before/after
states, separates defects from taste, and discloses missing evidence. Research
reporting loads the native `report-fidelity` skill on demand for source support, units, derived
calculations, quotations and translation meaning, without mandatory ledgers or
large-workflow requirements for simple questions. These local adaptations preserve
DSH ownership of tasks, lifecycle, permissions and persistence.

The `report-fidelity` skill follows native metadata discovery, lazy body loading,
and the normal skill setting. Historical child captures without that setting keep
it disabled; new captures retain their captured value independently of later
parent settings, without changing the child's authority ceiling.

## Frontend resources and provenance

The full `skills/frontend/` tree is maintained in this repository and shipped in
the npm package. `scripts/frontend-recipe.mjs`, fixed upstream commits,
`skills/frontend/.frontend-materialized.json`, and
`skills/frontend/ATTRIBUTION.md` define its provenance and integrity boundary.
Third-party licenses and notices remain with their resources.

Ordinary build and `check:frontend` are offline. They require the complete local
resource set and never download or replace files. `pnpm run sync:frontend` is the
only network materialization command; use it only with explicit authorization. It
fetches missing files from the fixed commits, verifies Git blob identities and
license blobs, and refuses unsafe destinations. Review and commit the resulting
resource and inventory changes together.

## LSP dependency boundary

DSMM retains only configuration and smoke-test integration for `ocmm-lsp mcp`.
The executable, native binaries, platform packages and their release lifecycle are
provided by the published `ocmm` npm package. Do not copy LSP source, native build
logic or platform publication into this repository. Dependency and lockfile
maintenance must ensure the published package and matching optional platform
package are available without relying on a sibling checkout.

## Release

Pull requests and branch pushes run `.github/workflows/ci.yml` and never publish.
Only an exact `v<package-version>` tag can enter `.github/workflows/release.yml`.
See [releasing](releasing.md) for immutable publication rules and npm Trusted
Publishing prerequisites.
