# DSMM agent guidance

## Scope

- This repository is the complete DSMM project. Do not read build inputs from a
  parent or sibling checkout.
- `src/`, `prompts/`, and `skills/` are maintained sources. Preserve public APIs,
  native DSH ownership, permission ceilings and current runtime behavior unless a
  task explicitly changes them.
- Keep `@dsmm/dsmm`, the package version, and all DSH `0.2.1-rc.2` dependencies
  unchanged unless the task explicitly authorizes a release or compatibility move.

## Build and verification

Use the existing Node/pnpm toolchain; do not install dependencies without
authorization.

```powershell
pnpm run typecheck
pnpm run build
pnpm run test
pnpm run check:roles
pnpm pack --pack-destination <approved-output-directory>
```

Run targeted checks while editing and leave full integration verification to the
task owner when requested. `generate:roles` is the only writer for
`agent-presets/` and `prompts/deepwork.md`; follow it with `check:roles`.

## Resources and release

- Preserve third-party licenses, notices and attribution. Frontend resources use
  fixed commits and the checked-in `.frontend-materialized.json` inventory.
- Build and checks stay offline. `sync:frontend` performs authorized fixed-pin
  network materialization; never make it an implicit build step.
- CI verifies pull requests and branch pushes only. Release tags are
  `v<package-version>` and publication is owned by `.github/workflows/release.yml`.
- Git writes, dependency installation, publishing, tag changes and destructive
  cleanup require explicit authorization for the exact operation.
