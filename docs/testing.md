# DSMM testing

DSMM keeps fast default verification separate from module and integration
coverage. All entry points use Node's built-in test runner with file concurrency
fixed at one. They do not infer affected tests from Git state, cache results, or
change individual test timeouts.

## Entry points

```powershell
# Build and run the small default smoke selection.
pnpm test

# Show available module and integration names without running tests.
pnpm run test:list

# Run one or more affected quick modules after building current sources as needed.
pnpm run test:module -- permissions config-profiles

# Run one or more explicit integration groups.
pnpm run test:integration -- native-runtime

# Run every TypeScript test wrapper only for dedicated diagnosis.
pnpm run test:diagnostic:all
```

`test:run` is the smoke-only test command used after build by CI and release. It
contains representative permission, configuration/profile, recovery, routing,
frontend/package and workflow-resource checks, but it does not invoke every module.
CI and release retain source typecheck, build, frontend resource verification,
generated-role verification and package creation as separate gates.

The full diagnostic command preserves the former all-wrapper surface. It is not a
commit, release, CI or final-acceptance default. Do not use it as a substitute for
choosing the interfaces affected by a change.

## Quick modules

| Module | Primary coverage |
| --- | --- |
| `permissions` | Permission rules and settings, approval and command guards, managed/native permission consumers, shell and fetch policy. |
| `config-profiles` | Deployment configuration, named profiles, profile stores/RPC, Settings data, presets and module state. |
| `native-runtime` | Native lifecycle, persistence, recovery, session ownership, runtime contracts and LSP boundary. |
| `routing-model` | Model family/selection, route codecs and authority, role catalog/invocation, root eligibility and child control. |
| `frontend-package` | Client controllers and views, browser-independent UI behavior, package exports/assets and generated delivery resources. |
| `workflow-resources` | Prompts, skills and plan/workflow validation. |

Quick modules intentionally exclude every file assigned to an integration group.
Some quick files belong to more than one module where they exercise a real shared
boundary. Selecting several modules deduplicates those files and still runs them
serially.

## Integration groups

| Group | Primary coverage and prerequisites |
| --- | --- |
| `native-runtime` | Multi-step Host/runtime, resume, module admission, real shell safety and native SDK/CLI wrappers. Some cases require `DSMM_TEST_DSH_ENTRY` or `DSMM_COLD_PROFILE_SDK_ANCHOR`. |
| `frontend` | Real browser deployment/profile/editable-choice flows and native role cards. Browser cases require both `DSMM_TEST_DSH_ENTRY` and `DSMM_TEST_PLAYWRIGHT_ENTRY`. |
| `delivery` | Actual package/frontend materialization and full native/ordinary module delivery. Native cases require an explicit DSH anchor. |

Missing anchors produce explicit skips. A skipped integration case is unavailable
coverage, not a pass, and must be reported as such. The wrapper files remain the
entry points for their `.mjs` fixtures so the underlying Host, CLI, approval and
browser scenarios are not orphaned.

## Selecting affected coverage

Run the module containing the changed implementation and every module whose public
or ownership boundary is affected. For example:

- permission-backed configuration changes require `permissions` and
  `config-profiles`;
- role route or model admission changes require `routing-model` and
  `native-runtime`, plus the `native-runtime` integration group when Host ownership
  or persisted sessions are involved;
- deployment UI changes require `frontend-package` and `config-profiles`, plus the
  `frontend` integration group when browser behavior changes;
- shipped resources or package entry changes require `frontend-package` and the
  `delivery` integration group.

Use the narrowest relevant typecheck/build/resource/package checks in addition to
those suites. Final acceptance follows the same affected-surface rule and does not
run the full diagnostic by default. Do not delete valid safety or protocol
regressions, weaken assertions, increase timeouts, or enable file concurrency as a
performance shortcut.
