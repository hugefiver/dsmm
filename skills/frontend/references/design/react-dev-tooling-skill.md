> DSH adapter boundary: resolve this resource from the loaded skill's directory resourceBase. Examples are not authority: installation/download/login, private state, Git writes and destructive operations need exact explicit authorization. Use only tools and native roles actually exposed in the current catalog and allowed by the caller; otherwise use a real direct fallback or report the limitation. Translate shell examples to the active runtime.

# React Dev Tooling — Capability and Authorization

Inspect actual project dependencies, scripts/binaries and entry wiring first. Reuse already available dev tools; missing tooling does not authorize installation, agent-skill setup or CDN execution. Only separately authorized setup may change dependencies. Otherwise use existing browser/static evidence and identify the unverified render/scan coverage.

## The three tools

| Tool | What it does | Why consider it when available |
|---|---|---|
| **react-grab** | Cmd/Ctrl+C on any UI element copies its source location + nearby code + component stack into the clipboard, formatted for an AI agent to act on. | Cuts agent edit time **~2×** because the agent receives the actual source coordinates instead of guessing from a screenshot. From the author of Million.dev. |
| **react-scan** | Visually highlights every component render in dev. Detects unnecessary re-renders, slow renders, and tracks render causes. Has a headless `react-scan/lite` mode for automated perf measurement. | Catches re-render regressions the moment they happen, before they ship. Pairs with the perfection ruleset (`../perfection/README.md`) for Lighthouse 100 work. |
| **react-doctor** | Static scanner that finds bad React patterns across state & effects, perf, architecture, security, a11y. One-shot `npx --no-install react-doctor` audit + CI GitHub Action + agent-skill installer. | Catches AI-generated React anti-patterns deterministically. Run before commit and in CI. Installs itself as a Claude Code / OpenCode / Cursor / Codex skill so the agent learns from each scan. |

All three are **dev-only** (`process.env.NODE_ENV === 'development'` or `import.meta.env.DEV`). None ship to production.

## Separately authorized setup for a React project

Only after explicit authorization for the exact setup changes, use already present project-local CLIs from the confirmed project context. The following examples prohibit implicit package fetching; if a binary is unavailable, stop and describe the capability gap rather than installing or using latest automatically.

```bash
# 1. react-grab — adds itself to package.json + entry file with dev gate
npx --no-install grab init

# 2. react-doctor — first audit + agent-skill install
npx --no-install react-doctor install

# 3. react-scan — adds itself with dev gate
npx --no-install react-scan init
```

The `init`/`install` CLIs handle framework detection and gating for you. If the CLI fails or does not fit, manual snippets below remain conditional on the same explicit authorization; CDN script examples also require approval of that network/code load. Do not bootstrap a replacement tool.

After install, confirm by reading the diff. Each tool should appear ONLY behind a `process.env.NODE_ENV === "development"` / `import.meta.env.DEV` gate.

## Manual install (when the CLI does not fit)

### Next.js (App Router) — `app/layout.tsx`

```tsx
import Script from "next/script";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {process.env.NODE_ENV === "development" && (
          <>
            <Script
              src="//unpkg.com/react-grab/dist/index.global.js"
              crossOrigin="anonymous"
              strategy="beforeInteractive"
            />
            <Script
              src="//unpkg.com/react-scan/dist/auto.global.js"
              crossOrigin="anonymous"
              strategy="beforeInteractive"
            />
          </>
        )}
      </head>
      <body>{children}</body>
    </html>
  );
}
```

### Next.js (Pages Router) — `pages/_document.tsx`

Same pattern, but the `<Script>` tags live inside `<Head>` from `next/document` and gate on `process.env.NODE_ENV === 'development'`.

### Vite — `src/main.tsx` (or wherever the entry is)

```tsx
if (import.meta.env.DEV) {
  void import("react-grab");
  void import("react-scan");
}
```

Optionally add the Vite plugin for richer `displayName` data on react-scan:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import reactScan from "vite-plugin-react-scan";

export default defineConfig({
  plugins: [react(), reactScan()],
});
```

### Webpack / CRA — entry file top

```ts
if (process.env.NODE_ENV === "development") {
  void import("react-grab");
  void import("react-scan");
}
```

### Remix — `app/root.tsx`

```tsx
export default function App() {
  return (
    <html lang="en">
      <head>
        <Meta />
        {process.env.NODE_ENV === "development" && (
          <>
            <script crossOrigin="anonymous" src="//unpkg.com/react-grab/dist/index.global.js" />
            <script crossOrigin="anonymous" src="//unpkg.com/react-scan/dist/auto.global.js" />
          </>
        )}
        <Links />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
```

### Astro — `src/layouts/Layout.astro`

```astro
---
const isDev = import.meta.env.DEV;
---
<head>
  {isDev && (
    <>
      <script crossorigin="anonymous" src="//unpkg.com/react-grab/dist/index.global.js" is:inline></script>
      <script crossorigin="anonymous" src="//unpkg.com/react-scan/dist/auto.global.js" is:inline></script>
    </>
  )}
</head>
```

## react-doctor — wire the scan, not the bundle

react-doctor is a one-shot CLI plus a CI action, NOT a runtime injection. Use an already available scanner within the authorized task. Agent-skill installation, pre-commit changes and CI setup below require separate approval; they are examples, not required automatic steps:

1. **As an agent skill** so your coding agent learns from each scan and avoids the issues next time:

   ```bash
   npx --no-install react-doctor install
   ```

   This optional upstream installer targets other hosts; do not assume DSH support or write their private configuration. Use only an actually available native skill/capability.

2. **As a local pre-commit / scripted gate:**

   ```bash
   # Manual audit
   npx --no-install react-doctor

   # JSON for scripting / CI
   npx --no-install react-doctor --json > .react-doctor-report.json
   ```

3. **As a CI gate** that blocks PRs when the static scan regresses:

   ```yaml
   # .github/workflows/react-doctor.yml
   name: React Doctor
   on: [pull_request]
   jobs:
     audit:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: millionco/react-doctor@<approved-fixed-revision>
   ```

## Feature flag — disable existing runtime instrumentation

The `NODE_ENV === "development"` gate already keeps these out of production. For temporarily disabling the runtime tools during a dev session (e.g. when profiling without instrumentation overhead), put one env var in front:

```ts
// entry file
const enableDevTools =
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_DISABLE_REACT_DEVTOOLS !== "1";

if (enableDevTools) {
  void import("react-grab");
  void import("react-scan");
}
```

Then `NEXT_PUBLIC_DISABLE_REACT_DEVTOOLS=1 npm run dev` skips both without re-editing code.

For Vite use `VITE_DISABLE_REACT_DEVTOOLS`, for CRA use `REACT_APP_DISABLE_REACT_DEVTOOLS`. The variable name MUST start with the framework's required prefix or it won't reach the bundle.

## When NOT to install these

- **The project is not React.** None of these apply to Solid, Svelte, Vue, Qwik, or any non-React framework. Skip silently.
- **The user explicitly said "no extra dev dependencies"** or the README forbids them. Respect that.
- **The project ships React 16 or earlier.** react-scan and react-doctor target modern React (17+, often 18+). Check `package.json` first; if the project is on legacy React, skip the runtime tools and use its static scan only if already available and applicable, otherwise report that evidence limitation.
- **The project is a library, not an app.** Libraries have no entry file to inject into; only consumers (apps) should run the runtime tools. An already available applicable static scan can still be used; do not install it implicitly.

## Verification

After install, sanity-check that the tools are loaded ONLY in dev:

```bash
# 1. Build for production
npm run build && npm run start  # or vite build && vite preview, etc.

# 2. Open the production URL and verify
#    - No react-grab toolbar visible
#    - No react-scan overlay or console output
#    - DOM contains zero <script> tags pointing at unpkg.com/react-grab or unpkg.com/react-scan
curl -s http://localhost:3000 | grep -E 'react-grab|react-scan' && echo "LEAK — fix the gate" || echo "OK"
```

If any of those leak into production, the dev gate is broken. Fix the gate before declaring done.

## Cross-skill references

- For **render performance / Lighthouse 100** work, see `../perfection/react-perf-tooling.md` — Playwright + `react-scan/lite` integration used during automated audits.
- For **debugging an in-flight React bug**, load the native debugging skill when available and resolve its actual references/runtimes/node.md and references/tools/playwright-cli.md from that skill's returned resourceBase. Use already available React/browser tooling; no cross-skill relative path or unbundled react-devtools resource is assumed. If debugging is unavailable, report that limitation.
- The Phase 0 Design System Gate (in `README.md`) and this React Dev Tooling Gate are both pre-implementation gates. Run Phase 0 first (design system must exist), then inspect existing tooling and its development gate; absent tooling is a reported coverage limitation, not installation authority.

## Mantra

> **Inspect real capabilities first. Keep existing tools dev-only; install/change tooling only when explicitly authorized. State exactly which evidence is unavailable.**
