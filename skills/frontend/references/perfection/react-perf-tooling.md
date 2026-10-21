> DSH adapter boundary: resolve this resource from the loaded skill's directory resourceBase. Examples are not authority: installation/download/login, private state, Git writes and destructive operations need exact explicit authorization. Use only tools and native roles actually exposed in the current catalog and allowed by the caller; otherwise use a real direct fallback or report the limitation. Translate shell examples to the active runtime.

# React Perf Tooling for Lighthouse 100

You are auditing or optimizing a React app for Lighthouse 100. Two tools belong in this workflow alongside Playwright + lighthouse — they catch the React-specific perf issues that Lighthouse counts but doesn't diagnose by component:

| Tool | Surface | What it gives you |
|---|---|---|
| **react-scan** (`react-scan/lite`) | Runtime instrumentation, headless | Per-fiber `commit` events with `changeDescription` — "this component re-rendered because <prop / state / context / parent / hook> changed". Correlates with `long-animation-frame` to attribute LoAF to specific components. |
| **react-doctor** | Static scan, CI-friendly | Deterministic findings across state/effects, perf (memoization, list keys, expensive children), architecture, security, a11y. One-shot `npx react-doctor@latest` produces a JSON report. From the Million.dev team. |

Use both. They are complementary: `react-scan` tells you *what's slow right now*; `react-doctor` tells you *what's structurally wrong*. Both are dev-only and free.

Every browser audit uses a **run-owned temporary empty browser profile or isolated empty context**. **Do not sign in to any browser, vendor, site, or account, including disposable or test accounts.** **Do not import, copy, reuse, or sync user browser settings, extensions, cookies, authentication, or storage state.** If the route cannot be exercised anonymously, **report authentication as a verification limitation**; do not attach to a live browser or inject state to make the audit pass.

If the project does not yet have react-scan and react-doctor wired into its dev environment, read `../design/react-dev-tooling-skill.md` first and install them — they should be on by default for every React project this skill audits.

## Lighthouse run + react-scan/lite

`playwright-lighthouse` already drives a real Chrome. Inject `react-scan/lite` BEFORE React mounts via `page.addInitScript`. Then drain its `onEvent` stream during the run and assert on render budgets at the end.

```ts
// scripts/audit-with-react-scan.ts
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import { playAudit } from "playwright-lighthouse";

type OwnedAuditBrowser = {
  context: BrowserContext;
  page: Page;
  port: number;
  close(): Promise<void>;
};

async function removeOwnedRunRoot(runRoot: string, ownershipToken: string): Promise<void> {
  const [resolvedTempRoot, resolvedRunRoot] = await Promise.all([realpath(tmpdir()), realpath(runRoot)]);
  const ownershipMarker = join(resolvedRunRoot, ".dsmm-run-owner");
  if (
    dirname(resolvedRunRoot) !== resolvedTempRoot ||
    !/^dsmm-lighthouse-[A-Za-z0-9_-]+$/.test(basename(resolvedRunRoot)) ||
    (await readFile(ownershipMarker, "utf8")) !== ownershipToken
  ) {
    throw new Error("Refusing to remove a Lighthouse run root without exact ownership evidence");
  }
  await rm(resolvedRunRoot, { recursive: true, force: false });
}

async function readOwnedCdpPort(userDataDir: string, launchStartedAt: number): Promise<number> {
  const activePortFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 10_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const [portText, browserPath] = (await readFile(activePortFile, "utf8")).trim().split(/\r?\n/);
      const port = Number(portText);
      const metadata = await stat(activePortFile);
      if (!Number.isInteger(port) || port < 1 || !browserPath?.startsWith("/devtools/browser/")) {
        throw new Error("Chrome wrote an invalid DevToolsActivePort file");
      }
      if (metadata.mtimeMs < launchStartedAt - 1_000) {
        throw new Error("DevToolsActivePort predates this browser launch");
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("CDP readiness budget expired before the ownership probe");
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(remainingMs),
      });
      if (!response.ok) throw new Error(`CDP readiness returned HTTP ${response.status}`);
      const version = (await response.json()) as { webSocketDebuggerUrl?: string };
      if (!version.webSocketDebuggerUrl) throw new Error("CDP response omitted webSocketDebuggerUrl");
      const endpoint = new URL(version.webSocketDebuggerUrl);
      if (endpoint.hostname !== "127.0.0.1" || endpoint.port !== String(port) || endpoint.pathname !== browserPath) {
        throw new Error("CDP endpoint does not match this launch's DevToolsActivePort file");
      }
      return port;
    } catch (error) {
      lastError = error;
      const retryDelayMs = Math.min(100, Math.max(0, deadline - Date.now()));
      if (retryDelayMs > 0) await delay(retryDelayMs);
    }
  }

  throw new Error(`Owned CDP endpoint was not ready before the deadline: ${String(lastError)}`);
}

async function launchOwnedAuditBrowser(): Promise<OwnedAuditBrowser> {
  const resolvedTempRoot = await realpath(tmpdir());
  const runRoot = await mkdtemp(join(resolvedTempRoot, "dsmm-lighthouse-"));
  const ownershipToken = randomUUID();
  const ownershipMarker = join(runRoot, ".dsmm-run-owner");
  const userDataDir = join(runRoot, "user-data");
  await writeFile(ownershipMarker, ownershipToken, { flag: "wx" });
  await mkdir(userDataDir);

  let context: BrowserContext | undefined;
  try {
    const launchStartedAt = Date.now();
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome",
      headless: false,
      args: [
        '--disable-extensions',
        '--disable-sync',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
      ],
    });
    const port = await readOwnedCdpPort(userDataDir, launchStartedAt);
    const ownedContext = context;
    const page = ownedContext.pages()[0] ?? (await ownedContext.newPage());
    return {
      context: ownedContext,
      page,
      port,
      close: async () => {
        await ownedContext.close();
        await removeOwnedRunRoot(runRoot, ownershipToken);
      },
    };
  } catch (error) {
    if (context) await context.close();
    await removeOwnedRunRoot(runRoot, ownershipToken);
    throw error;
  }
}

const ownedBrowser = await launchOwnedAuditBrowser();
try {
  // Inject react-scan/lite BEFORE the app boots. Initialization failure still reaches finally.
  await ownedBrowser.context.addInitScript(() => {
    // @ts-ignore — pulled from the project's node_modules or a self-hosted bundle
    import("react-scan/lite").then(({ instrument }) => {
      (window as any).__renderEvents = [];
      instrument({
        onEvent: (event: any) => {
          if (event.kind === "commit") (window as any).__renderEvents.push(event);
        },
        recordChangeDescriptions: true,
        includeFiberSource: true,
        includeFiberIdentity: true,
      });
    });
  });

  await ownedBrowser.page.goto("http://localhost:3000/<route>");
  await playAudit({
    page: ownedBrowser.page,
    port: ownedBrowser.port,
    thresholds: { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 },
    reports: { formats: { html: true, json: true }, name: "lighthouse-<route>" },
    config: { extends: "lighthouse:default", settings: { formFactor: "mobile" } },
  });

  // Pull render events and assert on render quality
  const events = await ownedBrowser.page.evaluate(() => (window as any).__renderEvents);
  const unnecessary = events.filter((e: any) =>
    e.tree?.some((node: any) => node.changeDescription?.kind === "unnecessary"),
  );

  if (unnecessary.length > 0) {
    throw new Error(`FAIL: ${unnecessary.length} unnecessary renders detected during audit`);
  }
  await ownedBrowser.page.screenshot({ path: "lighthouse-react-<route>.png", fullPage: true });
} finally {
  await ownedBrowser.close();
}
```

This is the canonical integration. `DevToolsActivePort` comes only from the new empty directory and is cross-checked against `/json/version`; failure to confirm it stops the audit, with no fixed-port fallback. The returned context is the browser ownership handle, and cleanup closes that exact context before marker-validated removal of the exact run root. Run twice per route (mobile + desktop), same as the base Lighthouse workflow. Both must hit 100/100/100/100 AND zero unnecessary renders.

## react-doctor — static perf gate

Before the Playwright run, fail fast on structural issues. The scan is fast and doesn't need a browser, so put it earlier in the pipeline.

```bash
npx react-doctor@latest --json > .react-doctor-report.json
```

Parse `.react-doctor-report.json` for perf-category findings. Treat any perf finding as a blocker for the same reason you treat a Lighthouse score < 100 as a blocker — these are deterministic issues that *will* show up in Lighthouse eventually under throttling.

Wire it into CI as a separate job (cheap, fast, no browser needed):

```yaml
- name: React Doctor static perf scan
  uses: millionco/react-doctor@main
```

Or run inline with a fail filter:

```yaml
- name: React Doctor static perf scan
  run: npx react-doctor@latest --json --fail-on perf
```

## When to load which during an audit

Run them in this order, stop at the first failure:

1. **`react-doctor`** — cheapest. Catches missing memoization, broken list keys, unstable callback refs, expensive children that re-render unnecessarily. Fix everything it reports BEFORE running Lighthouse — half the perf score wins live here.
2. **`react-scan` interactive in dev** — load the page in real Chrome with `npx react-scan@latest init` already wired (see the dev-tooling reference). Walk the LCP route, the most-clicked CTA, and any animation-heavy view. The toolbar shows render counts; the overlay highlights unnecessary renders in gray. Fix until clean.
3. **`react-scan/lite` in the Lighthouse run** — once interactive is clean, run the Playwright audit above. This catches anything that only shows under throttling or only on first paint.
4. **Playwright + Lighthouse** — standard run from `README.md` audit workflow. Score 100 + zero unnecessary renders from step 3 = done.

## React-specific perf root causes (extends `README.md` ROOT-CAUSE CHECKLIST)

These are the failures `react-scan` and `react-doctor` surface that base Lighthouse won't directly name:

- **Context value identity churn.** A provider value `useMemo` was forgotten; every consumer re-renders on every render of the provider's parent. → `useMemo` the value, or split contexts so high-churn fields don't sit next to stable ones.
- **Inline object/array/callback props on memoized children.** `<Child config={{ a: 1 }} />` breaks `React.memo` every render. → Hoist, `useMemo`, or `useCallback`.
- **List keys = array index.** Reordering shreds the reconciler. → Use a stable id from the data.
- **Expensive components rendered unconditionally above the fold.** → `lazy()` + `Suspense`, or move below the LCP, or pre-render server-side.
- **Effects that fire on every render.** Missing dependency arrays or unstable deps. → Stabilize deps, or split state, or extract to `useEvent`-style ref.
- **Spreading the entire context value into props.** Couples every consumer to every field. → Destructure only the fields used.
- **Hydration mismatches.** SSR markup doesn't equal client first-render. → react-doctor flags structurally; fix the source of the divergence (Date.now, locale, randomness, browser-only APIs).

`react-doctor` finds these statically. `react-scan` confirms the symptom in the running app. Both must come clean before Lighthouse 100 is meaningful.

## Anti-patterns specific to this workflow

- **Forgetting `page.addInitScript` (using `page.evaluate` instead).** `evaluate` runs AFTER React mounts; you'll miss every initial-render event. Use `addInitScript`.
- **`react-scan` non-lite during a Lighthouse run.** The full UI (toolbar, canvas overlay) adds overhead and skews the score. Use `react-scan/lite` ONLY for measurement; the full version is for interactive dev.
- **Reporting Lighthouse 100 with `react-scan` showing 30+ unnecessary renders per route.** The score is meaningless if the React layer is thrashing — INP and CLS will degrade under real load even if the synthetic run passed. Both gates must clear.
- **Treating `trackUnnecessaryRenders` as free.** It has measurable overhead; in a Lighthouse run it can drag the perf score by 2-3 points. Use it for interactive diagnosis, not for the audit run.
- **Skipping react-doctor because "it's just a linter".** It's not. It detects React-specific defects (missing keys, broken memo, unstable refs, hydration mismatches) that ESLint plugins miss because they require fiber-level reasoning.

## Mantra

> **Lighthouse 100 + react-doctor clean + zero unnecessary renders from react-scan. All three or it is not done.**
