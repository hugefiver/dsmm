> DSH adapter boundary: resolve this resource from the loaded skill's directory resourceBase. Examples are not authority: installation/download/login, private state, Git writes and destructive operations need exact explicit authorization. Use only tools and native roles actually exposed in the current catalog and allowed by the caller; otherwise use a real direct fallback or report the limitation. Translate shell examples to the active runtime.

# Playwright CLI — Browser QA That Actually Drives a Browser

**https://playwright.dev/ · https://github.com/microsoft/playwright**

For any browser-served web UI bug, this is the correct tool. Not curl. Not imagination. Not a headless HTTP library. A real browser with a real rendering engine, real JS execution, real cookies, real service workers, real viewport.

**In Phase 8 Manual QA for browser products, using Playwright is not optional.** Curl cannot catch: CSS that breaks at specific viewport widths, hydration mismatches, client-side router bugs, cookie/session interactions, service-worker caching, JS-triggered navigations. All of those are common bug classes. Drive a browser.

> Note: `microsoft/playwright-cli` is the legacy repo; the current tooling lives in `@playwright/test` (npm) and `playwright` (pip), which include the `playwright` CLI. Use those — the legacy `playwright-cli` package is deprecated.

---

## When to reach for Playwright

| Bug symptom | Use Playwright? |
|---|---|
| Form submit produces wrong result | ✅ — Playwright drives the form exactly as a user does |
| Page blank in prod, fine locally | ✅ — hydration/env differences need a real browser |
| CSS looks wrong at a specific width | ✅ — use `--viewport-size` |
| Click doesn't fire / wrong handler | ✅ — Playwright fires real DOM events |
| Flash of unstyled content / loading glitch | ✅ — use trace viewer to see frames |
| API returns wrong data | ❌ — use curl, this isn't a browser bug |
| Backend returns wrong status code | ❌ — use curl |
| Client hits a URL that returns 500 | ✅ but also ❌ — Playwright shows the call + response + failure effect on UI |

---

## Install (per-project)

Playwright installs browser binaries separately from the npm package.

```bash
# In the project
npm init playwright@latest             # interactive; picks TS/JS + browsers + config
# Or if Playwright is already a dep:
npx playwright install                 # downloads browsers
npx playwright install chromium        # just chromium
npx playwright install --with-deps     # also installs OS deps (Linux)
```

Python:
```bash
pip install playwright
playwright install
```

---

## The four things you'll actually use

### 1. `codegen` — record a session, generate the script

The fastest way to create a repro. Opens a real browser; your clicks / typing become a Playwright script you can paste into a test.

```bash
npx playwright codegen https://your-app.local
npx playwright codegen --viewport-size=375,667 https://your-app.local    # iPhone SE size
npx playwright codegen --device="iPhone 14" https://your-app.local
```

Use the run-owned empty browser context and save the reproduction script in the task-owned temporary root for Phase 8. Put its exact path in the resource checklist, not a repository journal.

### 2. A one-shot Playwright script — reproduce + capture

Usually the Phase 8 QA artifact. Save under the task-owned temporary root and list its exact path for cleanup (replace illustrative `/tmp/` paths below):

```ts
// /tmp/debug-repro.spec.ts
import { test, expect } from '@playwright/test';

test('refinement chat shows non-empty response when env var set', async ({ page }) => {
  await page.goto('http://localhost:3000/chat');
  await page.fill('textarea[name="message"]', 'Add a logging step');
  await page.click('button[type=submit]');

  // Wait for the response to appear (not just the spinner to disappear)
  const response = page.locator('[data-testid="assistant-reply"]');
  await expect(response).toBeVisible({ timeout: 30_000 });
  await expect(response).not.toBeEmpty();

  // Capture evidence
  await page.screenshot({ path: '/tmp/debug-after-fix.png', fullPage: true });
  console.log(await response.textContent());
});
```

Run it with tracing enabled for rich post-mortem:

```bash
npx playwright test /tmp/debug-repro.spec.ts --trace on --headed
```

### 3. `PWDEBUG=1` — step through the script with Playwright Inspector

```bash
PWDEBUG=1 npx playwright test /tmp/debug-repro.spec.ts
```

Opens the Playwright Inspector alongside the browser. You can step through Playwright actions, see the DOM state at each step, and edit selectors on the fly.

Use this when the script doesn't reproduce cleanly and you need to watch it run.

### 4. `show-trace` — post-mortem on a failed run

```bash
npx playwright show-trace trace.zip
# or from the test-results dir:
npx playwright show-trace test-results/<test-name>/trace.zip
```

Scrubs through a recorded session: timeline, DOM snapshot at each action, network, console, source. When a test failed on CI but passed locally, this is the single best artifact.

---

## Headless vs headed during debugging

Always add `--headed` when debugging. Headless browsers sometimes behave subtly differently (font rendering, viewport, media permissions). For QA evidence, run headed and screenshot.

```bash
npx playwright test --headed
npx playwright test --headed --project=chromium     # pin the browser
```

---

## Catching the silent-failure patterns Playwright is good at

```ts
// Toast that flashes and disappears
page.on('console', msg => console.log('[browser console]', msg.type(), msg.text()));

// Unhandled page errors (uncaught exceptions in the page JS)
page.on('pageerror', err => console.error('[page error]', err));

// Network failures — e.g., backend returned 500 but UI shows nothing
page.on('response', async resp => {
  if (!resp.ok()) {
    console.warn(`[network ${resp.status()}] ${resp.url()} — ${await resp.text()}`);
  }
});

// Request that never came back
page.on('requestfailed', req => {
  console.error('[request failed]', req.url(), req.failure()?.errorText);
});
```

Add these listeners to the top of the debug script. They surface a lot of the "UI showed nothing" class of bug.

---

## Viewport and device emulation

CSS bugs that only appear at specific sizes, or layout bugs on mobile:

```ts
// At test level
test.use({ viewport: { width: 375, height: 667 } });

// Per-page
await page.setViewportSize({ width: 375, height: 667 });

// Predefined devices
import { devices } from '@playwright/test';
test.use({ ...devices['iPhone 14'] });
```

---

## Gotchas

- **Wait for state, not for time.** `await page.waitForTimeout(2000)` is flaky. Use `await expect(locator).toBeVisible()` or `page.waitForResponse(urlPattern)`.
- **Stale selectors re-resolve.** Playwright's locators re-find the element on each action, unlike Puppeteer's handles. Don't over-think it.
- **Service workers persist across test runs in headed mode.** Use a run-owned temporary profile for a clean state; never clear a real profile in place. See the profile-safety procedure below.
- **Installing on CI requires `--with-deps`** on Linux images that lack the browser's shared-library deps.
- **Parallel tests share a browser process by default**; if one test polls a debugger port, others may interfere. Use `workers: 1` for debugging.

---

## Profile safety — run-owned empty user-data directory

**Never clear cookies, cache, or site data on a user's real browser profile.** This includes Playwright's `context.clearCookies()`, CDP `Network.clearBrowserCookies` and `Storage.clearCookies`, and browser APIs such as `chrome.browsingData.remove`. These operations can erase the user's authenticated state across unrelated sites.

Every browser action in this guide uses a **run-owned temporary empty browser profile or isolated empty context**. **Do not sign in to any browser, vendor, site, or account, including disposable or test accounts.** **Do not import, copy, reuse, or sync user browser settings, extensions, cookies, authentication, or storage state**; this includes Playwright `--load-storage`, `storageState`, copied profiles, and connections to an existing CDP session. If a required flow cannot be reached anonymously, stop and **report authentication as a verification limitation** rather than bypassing the boundary or claiming that coverage.

`launchPersistentContext` preserves cookies, local storage, and other browser state in its directory. It must use an **independent, run-owned empty user-data directory** made for this debug run; Chrome's main User Data directory and every other existing browser profile are off limits. Never copy a browser profile into the run directory or transfer authentication state from one. This is both safer and the supported Playwright model for persistent contexts.

Do not load browser extensions or plugins. The clean profile and `--disable-extensions` are mandatory; `--load-extension` and `--disable-extensions-except` are prohibited. Never sign in to a browser or vendor account (Google, Microsoft, Firefox, or similar), a personal web account, or any target application. Never enable browser setting sync. Cookies, cache, and service-worker data may be created only by anonymous visits made inside this run; they expire with its profile and do not represent returning-user or authenticated coverage.

Create the run-owned directories without referring to any existing browser data:

```powershell
if (-not (Test-Path -LiteralPath $env:TEMP)) { throw "Temporary directory was not found" }

$runRoot = Join-Path $env:TEMP ("dsmm-playwright-" + [guid]::NewGuid().ToString("N"))
$userDataDir = Join-Path $runRoot "user-data"
$logsDir = Join-Path $runRoot "logs"
$ownershipToken = [guid]::NewGuid().ToString("N")
$ownershipMarker = Join-Path $runRoot ".dsmm-run-owner"
New-Item -ItemType Directory -Path $runRoot -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path $userDataDir -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path $logsDir -ErrorAction Stop | Out-Null
New-Item -ItemType File -Path $ownershipMarker -Value $ownershipToken -ErrorAction Stop | Out-Null
$env:PW_USER_DATA_DIR = $userDataDir
```

Use that empty directory for the persistent context. Cookie clearing is permitted only for this run-owned empty profile:

```ts
const context = await chromium.launchPersistentContext(process.env.PW_USER_DATA_DIR!, {
  channel: 'chrome',
  headless: false,
  args: [
    '--disable-extensions',
    '--disable-sync',
  ],
});
await context.clearCookies(); // safe only for this run-owned empty profile
```

## Non-blocking browser-debug launch

Prefer the current agent platform's native background task or process tool when it actually exposes one. If no such durable native tool is available, the PowerShell fallback must start the Node browser-debug script with `Start-Process`, capture run-owned logs, record its PID, and return immediately:

```powershell
$browserDebugScriptInput = $env:PW_BROWSER_DEBUG_SCRIPT
if ([string]::IsNullOrWhiteSpace($browserDebugScriptInput)) {
  throw "Set PW_BROWSER_DEBUG_SCRIPT to the existing project browser-debug script"
}
if (-not (Test-Path -LiteralPath $browserDebugScriptInput -PathType Leaf)) {
  throw "Browser-debug script was not found"
}
$resolvedBrowserDebugScript = (Resolve-Path -LiteralPath $browserDebugScriptInput -ErrorAction Stop).Path
$stdoutLog = Join-Path $logsDir "browser-debug.stdout.log"
$stderrLog = Join-Path $logsDir "browser-debug.stderr.log"
$pidFile = Join-Path $runRoot "browser-debug.pid"
$browserArguments = @(
  ('"{0}"' -f $resolvedBrowserDebugScript),
  "--run-root",
  ('"{0}"' -f $runRoot)
)

$process = Start-Process -FilePath "node" -ArgumentList $browserArguments -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
$pidRecord = "$($process.Id):$($process.StartTime.ToUniversalTime().Ticks)"
$pidRecord | Set-Content -LiteralPath $pidFile -NoNewline
$launchReceipt = [ordered]@{
  runRoot = $runRoot
  pid = $process.Id
  startTimeTicks = $process.StartTime.ToUniversalTime().Ticks
  pidFile = $pidFile
  ownershipMarker = $ownershipMarker
  ownershipToken = $ownershipToken
  stdoutLog = $stdoutLog
  stderrLog = $stderrLog
}
Write-Output ($launchReceipt | ConvertTo-Json -Compress)
```

Do not add `-Wait`: launch must be nonblocking, and no tool call may wait for the entire browser session. `Start-Job` does not survive shell exit, so it does not meet this contract. In a later bounded tool call, confirm readiness through the script's readiness endpoint or bounded log polling (for example, a fixed number of reads with a deadline), then inspect only the recorded PID if the browser exits unexpectedly. Never use an unbounded poll.

After closing the context, terminate only the recorded run-owned PID through that same verified Process object and clean up only the directory created by this run. Resolve and validate the exact target before deleting it:

```powershell
$resolvedTempRoot = (Resolve-Path -LiteralPath $env:TEMP -ErrorAction Stop).Path
$resolvedRunRoot = [IO.Path]::GetFullPath($runRoot)
$runRootParent = [IO.Directory]::GetParent($resolvedRunRoot)
$runRootName = [IO.Path]::GetFileName($resolvedRunRoot)
if (
  $null -eq $runRootParent -or
  $runRootParent.FullName -ne $resolvedTempRoot -or
  $runRootName -notmatch '^dsmm-playwright-[0-9a-f]{32}$'
) {
  throw "Refusing to remove a non-run-owned profile"
}
if (
  -not (Test-Path -LiteralPath $ownershipMarker -PathType Leaf) -or
  (Get-Content -LiteralPath $ownershipMarker -Raw).Trim() -ne $ownershipToken
) {
  throw "Refusing to remove a run root without its exact ownership marker"
}

$pidRecord = (Get-Content -LiteralPath $pidFile -Raw).Trim().Split(":")
if ($pidRecord.Count -ne 2) { throw "Refusing to terminate an invalid run-owned PID record" }
$runOwnedPid = [int]$pidRecord[0]
$expectedStartTicks = [long]$pidRecord[1]
$runOwnedProcess = Get-Process -Id $runOwnedPid -ErrorAction SilentlyContinue
if ($null -ne $runOwnedProcess) {
  if ($runOwnedProcess.StartTime.ToUniversalTime().Ticks -ne $expectedStartTicks) {
    throw "Refusing to terminate a PID that is no longer run-owned"
  }
  $runOwnedProcess.Kill()
  if (-not $runOwnedProcess.WaitForExit(10000)) {
    throw "Run-owned browser process did not exit before cleanup deadline"
  }
}

Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force
```

---

## Phase 9 cleanup specifics

Follow [central cleanup rules](../methodology/09-cleanup.md) and the profile-marker and process-identity checks above. Register exact paths under the task-owned temporary root for reports, test results, traces, debug specs, and screenshots, plus owned browser/context identities and process PIDs and start identities. Delete only resolved, verified owned paths, not shared relative directories or `/tmp` filename patterns. Existing browser caches and profiles aren't cleanup targets; any authorized task-created browser installation needs its exact owned path recorded before cleanup.
