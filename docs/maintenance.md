# DSMM maintenance

DSMM is maintained as a standalone project. `src/`, `prompts/`, and `skills/` are
the authoritative source trees. Builds, tests, generators and package checks must
not read a parent or sibling repository.

## Toolchain

Use Node.js 24 for CI/release and pnpm 11.9.0. The package still supports Node.js
22 or later at runtime and targets exactly DSH `0.2.1-rc.2`. Do not change the npm
name `@dsmm/dsmm`, package version, or DSH dependency line as part of routine
maintenance unless the release or compatibility scope explicitly requires it.

Common checks:

```powershell
pnpm run typecheck
pnpm run build
pnpm run test:run
pnpm run check:frontend
pnpm run check:roles
pnpm pack --pack-destination <approved-output-directory>
```

`pnpm test` remains the convenient build-plus-test command. Dependency installation
and lockfile maintenance are separate authorized operations.

## Generated role assets

`src/roles.ts`, `src/prompts.ts`, and `prompts/source/` supply the maintained role
and workflow content. After changing inputs that affect rendered presets or the
base Deepwork prompt, run `pnpm run generate:roles`. CI uses
`pnpm run check:roles` and fails if `agent-presets/` or `prompts/deepwork.md` is
stale. Generated assets are package resources, not an alternate source of truth.

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
