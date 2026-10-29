# DSMM agent guidance

## Scope

- This repository is the complete DSMM project. Do not read build inputs from a
  parent or sibling checkout.
- `src/`, `prompts/`, and `skills/` are maintained sources. Preserve public APIs,
  native DSH ownership, permission ceilings and current runtime behavior unless a
  task explicitly changes them.
- Keep `@dsmm/dsmm`, the package version, and all DSH `0.2.1-rc.2` dependencies
  unchanged unless the task explicitly authorizes a release or compatibility move.

## Permission design principle

- Focus risk controls on preventing common model mistakes in tool selection and
  operation scope, together with basic permission enforcement. Do not aim to
  eliminate every possible privilege-bypass technique or implement a complete
  shell security analyzer.
- Keep checks proportional to those goals. Preserve existing permission
  boundaries and fallback behavior unless a task explicitly changes them;
  unsupported syntax alone is not a reason to add stricter policy.

## Build and verification

Use the existing Node/pnpm toolchain; do not install dependencies without
authorization.

```powershell
pnpm run typecheck
pnpm run build
pnpm run test:list
pnpm run test:module -- <module> [module...]
pnpm run test:integration -- <group> [group...]
pnpm run check:roles
pnpm pack --pack-destination <approved-output-directory>
```

During development and final acceptance, run only the module suites covering the
change and any affected interfaces. Add the relevant explicit integration group
when a Host, browser or package-delivery boundary changes. `pnpm test`, CI and the
release verification job run build plus the fast smoke suite; they do not run all
modules or integrations. `test:diagnostic:all` is an explicit diagnostic command,
not a default acceptance gate. Keep test files serial unless new evidence supports
a narrower concurrency change, and never trade away safety/protocol coverage or
raise timeouts to make a suite faster. See `docs/testing.md`.

`generate:roles` is the only writer for `agent-presets/` and
`prompts/deepwork.md`; follow it with `check:roles`.

## Resources and release

- Preserve third-party licenses, notices and attribution. Frontend resources use
  fixed commits and the checked-in `.frontend-materialized.json` inventory.
- Build and checks stay offline. `sync:frontend` performs authorized fixed-pin
  network materialization; never make it an implicit build step.
- CI verifies pull requests and branch pushes only. Release tags are
  `v<package-version>` and publication is owned by `.github/workflows/release.yml`.
- Git writes, dependency installation, publishing, tag changes and destructive
  cleanup require explicit authorization for the exact operation.
