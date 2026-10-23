import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import type { ProfilesController } from "../src/client/controller.js";
import { diagnostic, diagnosticLocation } from "../src/profile-diagnostics.ts";
import type { ProfileErrorInfo } from "../src/profile-types.js";

declare global {
  interface Window { __profilesController: ProfilesController }
}

const available = process.env.DSMM_TEST_DSH_ENTRY !== undefined && process.env.DSMM_TEST_PLAYWRIGHT_ENTRY !== undefined;

test("Named profiles redesigned UI page-level browser QA and interactive flows", {
  skip: !available && "requires explicit DSH and Playwright anchors (DSMM_TEST_DSH_ENTRY and DSMM_TEST_PLAYWRIGHT_ENTRY)",
  timeout: 60_000,
}, async (t) => {
  const sdk = createRequire(await realpath(process.env.DSMM_TEST_DSH_ENTRY!));
  const { chromium } = createRequire(process.env.DSMM_TEST_PLAYWRIGHT_ENTRY!)("playwright");
  const { startProfileUiServer } = await import(new URL("../scripts/profile-ui-harness-server.mjs", import.meta.url).href);
  const { compositionBundle } = await import(new URL("../scripts/profile-ui-harness-browser.mjs", import.meta.url).href);

  const temporaryParent = await realpath(tmpdir());
  const owned = await realpath(await mkdtemp(join(temporaryParent, "dsmm-named-profiles-browser-")));
  const packageRoot = join(owned, "package"), sourceRoot = fileURLToPath(new URL("../src/client/", import.meta.url));

  const screenshotDir = join(owned, "screenshots");
  await mkdir(screenshotDir, { recursive: true });

  let server: Awaited<ReturnType<typeof startProfileUiServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    await mkdir(join(packageRoot, "lib"), { recursive: true });

    const result = await build({
      stdin: {
        sourcefile: "named-profiles-surface.tsx",
        resolveDir: sourceRoot,
        loader: "tsx",
        contents: `
          import React, { useEffect, useState, useSyncExternalStore } from 'react';
          import { ProfilesSection } from './ProfilesSection.tsx';
          import { ProfilesController } from './controller.ts';
          import { zh, en } from './locales.ts';
          import { PROFILE_STYLES } from './styles.ts';

          const remote = {
            describe: () => window.__profilesBridge({ method: 'describe' }),
            read: (id) => window.__profilesBridge({ method: 'read', args: { id } }),
            save: (request) => window.__profilesBridge({ method: 'save', args: { request } }),
            select: (request) => window.__profilesBridge({ method: 'select', args: { request } }),
            describeSession: (id) => window.__profilesBridge({ method: 'describeSession', args: { id } }),
            selectSession: (id, request) => window.__profilesBridge({ method: 'selectSession', args: { id, request } }),
          };

          const controller = new ProfilesController(remote);
          controller.attachCatalog({
            providers: [
              {
                id: 'deepseek',
                name: 'DeepSeek',
                models: [
                  { id: 'deepseek-chat', name: 'DeepSeek V3' },
                  { id: 'deepseek-reasoner', name: 'DeepSeek R1' },
                ]
              },
              {
                id: 'openai',
                name: 'OpenAI',
                models: [
                  { id: 'gpt-4o', name: 'GPT-4o' },
                ]
              }
            ]
          });

          function Surface() {
            const [locale, setLocale] = useState('zh');
            const [theme, setTheme] = useState('light');
            useEffect(() => {
              controller.setSession('test-session');
              void controller.refresh().then(() => controller.open('default'));
              window.__profilesController = controller;
            }, []);
            const copy = locale === 'zh' ? zh : en;
            const view = useSyncExternalStore(controller.store.subscribe, () => controller.store.getSnapshot());

            return (
              <div
                className={theme === 'dark' ? 'theme-dark' : 'theme-light'}
                style={{
                  minHeight: '100vh',
                  background: 'var(--dsw-alias-bg-base)',
                  color: 'var(--dsw-alias-label-primary)',
                  boxSizing: 'border-box',
                }}
              >
                <header style={{
                  display: 'flex',
                  gap: '8px',
                  padding: '12px 24px',
                  borderBottom: '1px solid var(--dsw-alias-border-l4)',
                  alignItems: 'center',
                }}>
                  <button id="toggle-locale" onClick={() => setLocale(l => l === 'zh' ? 'en' : 'zh')}>
                    {locale === 'zh' ? 'English' : '中文'}
                  </button>
                  <button id="toggle-theme" onClick={() => setTheme(t => {
                    const next = t === 'light' ? 'dark' : 'light';
                    document.body.toggleAttribute('data-ds-dark-theme', next === 'dark');
                    return next;
                  })}>
                    {theme === 'light' ? 'Dark Mode' : 'Light Mode'}
                  </button>
                </header>
                <div style={{ padding: '24px', maxWidth: '1000px', margin: '0 auto' }}>
                  <ProfilesSection
                    {...controller.actions}
                    hooks={{ profiles: controller.store }}
                    readProfileView={() => controller.store.getSnapshot()}
                    useProfiles={(selector) => selector(view)}
                    t={(k, params) => {
                      let str = copy[k] ?? k;
                      if (params && typeof params === 'object') {
                        for (const [pKey, pVal] of Object.entries(params)) {
                          str = str.split('{' + pKey + '}').join(String(pVal));
                        }
                      }
                      return str;
                    }}
                  />
                </div>
              </div>
            );
          }

          export const inject = ['slots'];
          export function apply(ctx) {
            ctx.effect(() => {
              const style = document.createElement('style');
              style.textContent = PROFILE_STYLES + \`
                body {
                  margin: 0;
                  background: var(--dsw-alias-bg-base);
                  color: var(--dsw-alias-label-primary);
                }
              \`;
              document.head.append(style);
              return () => style.remove();
            });
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register({ name: 'settings.section', id: 'dsmm-profiles' }, Surface)
            );
          }
        `,
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "cjs",
      target: "es2022",
      external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"],
      banner: {
        js: 'window.__ModuleLoader__.load({id:"@dsmm/dsmm",factory:(require)=>{const module={exports:{}};const exports=module.exports;',
      },
      footer: { js: "return module.exports;}});" },
    });

    await writeFile(join(packageRoot, "lib", "client.js"), result.outputFiles![0]!.text);

    server = await startProfileUiServer({
      nativeRequire: sdk,
      packageRoot,
      sha256: "owned-named-profiles-fixture",
      composition: compositionBundle({ containerMode: "fixed-height" }),
    });

    browser = await chromium.launch({
      executablePath: chromium.executablePath(),
      headless: true,
      args: ["--disable-extensions", "--disable-sync"],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
    });
    assert.deepEqual(await context.cookies(), []);

    await context.route("**/*", (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) =>
      new URL(route.request().url()).origin === server!.origin ? route.continue() : route.abort()
    );

    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err: Error) => { console.error("PAGE ERROR:", err); errors.push(err.message); });
    page.on("console", (msg: { type(): string; text(): string }) => console.log("PAGE LOG:", msg.type(), msg.text()));

    await page.exposeBinding("__dsmmNativeBridge", () => ({
      ok: false,
      error: { code: "gateway/unavailable", message: "Unavailable", details: {} },
    }));

    // Server-side profile store mock
    const store: Record<string, string> = {
      default: JSON.stringify({
        version: 1,
        id: "default",
        label: "默认方案",
        settings: {
          locale: "zh",
          defaultActive: true,
          roleRouting: {
            "dsmm-orchestrator": {
              primary: { provider: "deepseek", model: "deepseek-chat" },
            },
            "dsmm-builder": {
              primary: { provider: "deepseek", model: "deepseek-reasoner" },
              levels: { high: { provider: "deepseek", model: "deepseek-reasoner" } },
              fallbackRoutes: [{ provider: "openai", model: "gpt-4o" }],
            },
          },
          guards: {
            gitWriteGuard: "ask",
            gitWriteScope: "high-risk",
          },
        },
      }, null, 2),
    };

    let savePayload: unknown = null;
    let saveRefusal: ProfileErrorInfo | null = null;
    let appliedFutureId: string | null = "default";
    let appliedSessionId: string | null = "default";
    let failRead = true;
    let failReset = true;
    let includeOrchestrator = true;
    let sessionRefreshRequired = false;
    let sessionWarning = false;
    let releaseSession: ((value: unknown) => void) | undefined;

    await page.exposeBinding("__profilesBridge", async (
      _source: { page: unknown; frame: { url(): string } },
      input: { method: string; args?: any }
    ) => {
      const { method, args } = input;
      if (method === "describe") {
        return {
          ok: true,
          value: {
            selectedId: appliedFutureId,
            appliedRevision: "stat-v1-100-200",
            selectionRevision: "stat-v1-100-200",
            profiles: Object.keys(store).map((id) => ({
              id,
              label: id === "default" ? "默认方案" : id,
              revision: "stat-v1-100-200",
              isDefault: id === appliedFutureId,
            })),
            roles: [
              { id: "dsmm-orchestrator", label: "Orchestrator", description: "Plans and coordinates work" },
              { id: "dsmm-builder", label: "Builder", description: "Implements code" },
              { id: "dsmm-reviewer", label: "Reviewer", description: "Reviews code" },
              { id: "dsmm-oracle", label: "Oracle", description: "First external model cross-check" },
              { id: "dsmm-oracle-2nd", label: "Oracle 2nd", description: "Second external model cross-check" },
              { id: "dsmm-planner", label: "Planner", description: "Architecture and design planning" },
              { id: "dsmm-plan-critic", label: "Plan Critic", description: "Rigorous plan critique" },
              { id: "dsmm-creative", label: "Creative", description: "Design and ideation specialist" },
              { id: "dsmm-quick", label: "Quick", description: "Fast deterministic edits" },
            ].filter(role => includeOrchestrator || role.id !== "dsmm-orchestrator"),
            readOnly: false,
          },
        };
      }
      if (method === "read") {
        if (failRead) {
          failRead = false;
          return { ok: false, error: { code: "gateway/unavailable" } };
        }
        return {
          ok: true,
          value: {
            id: args.id,
            label: args.id === "default" ? "默认方案" : args.id,
            revision: "stat-v1-100-200",
            content: store[args.id] ?? store.default,
          },
        };
      }
      if (method === "save") {
        savePayload = args.request;
        if (saveRefusal !== null) return { ok: false, error: { code: "dsmm-profiles/refused", details: saveRefusal } };
        store[args.request.id] = args.request.content;
        return {
          ok: true,
          value: {
            id: args.request.id,
            label: args.request.id === "default" ? "默认方案" : args.request.id,
            revision: "stat-v1-100-201",
            content: args.request.content,
          },
        };
      }
      if (method === "select") {
        if (failReset) {
          failReset = false;
          return { ok: false, error: { code: "dsmm-profiles/refused", details: { code: "io", message: "" } } };
        }
        appliedFutureId = args.request.id;
        return {
          ok: true,
          value: {
            selectedId: appliedFutureId,
            appliedRevision: "stat-v1-100-200",
            selectionRevision: "stat-v1-100-201",
            profiles: Object.keys(store).map((id) => ({
              id,
              label: id === "default" ? "默认方案" : id,
              revision: "stat-v1-100-200",
              isDefault: id === appliedFutureId,
            })),
          },
        };
      }
      if (method === "describeSession") {
        return {
          ok: true,
          value: {
            sessionId: args.id,
            globalDefault: { selectedId: appliedFutureId, appliedRevision: "rev-1", selectionRevision: "sel-1" },
            effectiveProfileId: appliedSessionId,
            scope: appliedSessionId ? "session-override" : "default",
            selection: { selectedId: appliedSessionId, appliedRevision: "rev-1", selectionRevision: "stat-v1-100-200" },
            admittedSelection: { selectedId: appliedSessionId, appliedRevision: "rev-1", selectionRevision: "sel-1" },
            selectionEpoch: "epoch-1",
            admissionEpoch: "epoch-1",
            canApplyOverlay: true,
            canSelectModel: true,
            profileModel: { provider: "deepseek", model: "deepseek-chat" },
            ...(sessionRefreshRequired ? { refreshRequired: true } : {}),
            ...(sessionWarning ? { warnings: [diagnostic("blank-label", "label")] } : {}),
          },
        };
      }
      if (method === "selectSession") {
        return new Promise(resolve => { releaseSession = resolve; });
      }
      return { ok: false, error: { code: "unknown_method", message: `Unknown method ${method}`, details: {} } };
    });

    await page.goto(server.origin);

    const profilesRoot = page.locator(".dsmm-named-profiles");
    await profilesRoot.waitFor({ timeout: 10_000 });

    const pageIssue = profilesRoot.locator(".dsmm-issue[role='alert']");
    await pageIssue.waitFor();
    assert.equal(await profilesRoot.locator(".dsmm-editor").count(), 0);
    assert.equal(await pageIssue.isVisible(), true, "First read failure must be visible without an editor");
    assert.equal(await page.evaluate(() => window.__profilesController.store.getSnapshot().issue?.kind), "transport");
    const moreActions = page.locator(".dsmm-more-actions");
    await moreActions.locator("> summary").click();
    const resetFutureBtn = moreActions.locator("button").first();
    await resetFutureBtn.click();
    await page.waitForFunction(() => window.__profilesController.store.getSnapshot().busy === null);
    assert.equal(await pageIssue.isVisible(), true, "Reset failure must be visible without an editor");
    assert.equal(await page.evaluate(() => window.__profilesController.store.getSnapshot().issue?.code), "io");
    await moreActions.locator("> summary").click();

    // Select the "default" profile from the profile dropdown
    const profileSelect = page.locator('select[id$="-select"]');
    await profileSelect.waitFor();
    await profileSelect.selectOption("default");

    // 1. Initial State & Effective Summary Verification
    const editorState = page.locator("[data-dsmm-editor-state]");
    await editorState.waitFor({ timeout: 10_000 });
    assert.equal(await editorState.getAttribute("data-dsmm-editor-state"), "ready");

    const effectiveSummary = page.locator(".dsmm-effective-summary");
    await effectiveSummary.waitFor();
    assert.match(await effectiveSummary.innerText(), /default/u);

    // Capture desktop normal viewport screenshot
    await page.screenshot({ path: join(screenshotDir, "desktop-normal-1280.png") });

    // 2. Viewport Reflow Checks (1280, 768, 375, and 200% reflow)
    for (const width of [1280, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `Reflow check at width ${width}px`
      );
      if (width === 768) {
        await page.screenshot({ path: join(screenshotDir, "tablet-768.png"), fullPage: true });
      } else if (width === 375) {
        await page.screenshot({ path: join(screenshotDir, "mobile-375.png"), fullPage: true });
      }
    }

    // 200% reflow check at 640px equivalent
    await page.setViewportSize({ width: 640, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      "200% Reflow check at 640px"
    );

    // Reset back to desktop
    await page.setViewportSize({ width: 1280, height: 900 });

    // 3. Dark Theme Verification
    await page.click("#toggle-theme");
    await page.waitForTimeout(100);

    const darkStyles = await page.evaluate(() => {
      const h2 = document.querySelector(".dsmm-named-profiles h2");
      const label = document.querySelector("label[for$='-label']");
      const summaryCard = document.querySelector(".dsmm-effective-summary");
      const input = document.querySelector(".dsmm-input input") || document.querySelector("select");
      const bodyHasDark = document.body.hasAttribute("data-ds-dark-theme");
      return {
        bodyHasDark,
        h2Color: h2 ? getComputedStyle(h2).color : "",
        labelColor: label ? getComputedStyle(label).color : "",
        summaryCardBg: summaryCard ? getComputedStyle(summaryCard).backgroundColor : "",
        inputColor: input ? getComputedStyle(input).color : "",
      };
    });
    assert.equal(darkStyles.bodyHasDark, true, "body has data-ds-dark-theme attribute");
    assert.match(darkStyles.h2Color, /rgb\(\s*249,\s*250,\s*251\s*\)/, `h2 color in dark theme: ${darkStyles.h2Color}`);
    assert.match(darkStyles.labelColor, /rgb\(\s*249,\s*250,\s*251\s*\)/, `label color in dark theme: ${darkStyles.labelColor}`);
    assert.match(darkStyles.summaryCardBg, /rgb\(\s*53,\s*54,\s*56\s*\)/, `card bg in dark theme: ${darkStyles.summaryCardBg}`);

    await page.screenshot({ path: join(screenshotDir, "dark-theme-1280.png") });

    // Open models dialog in dark mode to verify dark theme styling and capture viewport
    const darkOpenBtn = page.locator(".dsmm-open-models-dialog-btn");
    await darkOpenBtn.click();
    const darkModelsDialog = page.locator(".dsmm-profile-models-dialog");
    await darkModelsDialog.waitFor();
    await page.screenshot({ path: join(screenshotDir, "models-dialog-dark-1280.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);

    // Switch back to light theme
    await page.click("#toggle-theme");
    await page.waitForTimeout(100);

    const lightStyles = await page.evaluate(() => {
      const h2 = document.querySelector(".dsmm-named-profiles h2");
      return {
        bodyHasDark: document.body.hasAttribute("data-ds-dark-theme"),
        h2Color: h2 ? getComputedStyle(h2).color : "",
      };
    });
    assert.equal(lightStyles.bodyHasDark, false);
    assert.match(lightStyles.h2Color, /rgb\(\s*15,\s*17,\s*21\s*\)/);

    // 4. Reduced Motion Verification
    await page.emulateMedia({ reducedMotion: "reduce" });
    const prefersReduced = await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
    assert.equal(prefersReduced, true);

    // 5. Basic Settings & Orchestrator Primary Model
    const profileLabelInput = page.locator("input[id$='-label']").first();
    await profileLabelInput.waitFor();
    assert.equal(await profileLabelInput.inputValue(), "默认方案");

    const profileIdInput = page.locator("input[id$='-id']").first();
    assert.equal(await profileIdInput.inputValue(), "default");

    // Orchestrator primary model combobox/input with natural labels
    const orchestratorProvider = page.getByRole("combobox", { name: "提供商", exact: true });
    const orchestratorModel = page.getByRole("combobox", { name: "模型", exact: true });
    await orchestratorModel.waitFor();
    assert.equal(await orchestratorProvider.inputValue(), "deepseek");
    assert.equal(await orchestratorModel.inputValue(), "deepseek-chat");

    // 6. Secondary Actions Disclosure
    assert.equal(await moreActions.evaluate((el: HTMLDetailsElement) => el.open), false);
    await moreActions.locator("> summary").click();
    assert.equal(await moreActions.evaluate((el: HTMLDetailsElement) => el.open), true);
    // Future default reset button is available inside
    await resetFutureBtn.waitFor();
    assert.equal(await resetFutureBtn.isEnabled(), true);

    // 7. Advanced Settings Disclosure (Global settings only: defaults, git guard, topology)
    const advancedSettings = page.locator(".dsmm-advanced-settings");
    assert.equal(await advancedSettings.evaluate((el: HTMLDetailsElement) => el.open), false);
    await advancedSettings.locator("> summary").click();
    assert.equal(await advancedSettings.evaluate((el: HTMLDetailsElement) => el.open), true);

    // Global defaults (runtimePolicy) exist
    const globalRetries = advancedSettings.locator("[data-dsmm-policy-field='maxRetries']");
    await globalRetries.waitFor();
    assert.equal(await globalRetries.isVisible(), true);

    // 8. Git Write Guard & Scope Sparse Mapping
    const gitGuard = advancedSettings.locator("select[id$='-git-guard']");
    await gitGuard.waitFor();
    assert.equal(await gitGuard.inputValue(), "ask");

    const gitScope = advancedSettings.locator("select[id$='-git-scope']");
    assert.equal(await gitScope.inputValue(), "high-risk");
    assert.equal(await gitScope.isEnabled(), true);

    // Setting guard to off disables scope options with hint, but Unset (inherit) remains available
    await gitGuard.selectOption("off");
    await page.waitForTimeout(100);
    const allWritesOpt = gitScope.locator("option[value='all-writes']");
    const highRiskOpt = gitScope.locator("option[value='high-risk']");
    const unsetOpt = gitScope.locator("option[value='']");
    assert.equal(await allWritesOpt.isDisabled(), true, "all-writes option must be disabled when guard is off");
    assert.equal(await highRiskOpt.isDisabled(), true, "high-risk option must be disabled when guard is off");
    assert.equal(await unsetOpt.isEnabled(), true, "Unset option must remain available when guard is off");
    assert.match(await advancedSettings.innerText(), /保护已关闭，检查范围暂不生效/u);

    // Reset guard to ask re-enables scope options
    await gitGuard.selectOption("ask");
    await page.waitForTimeout(50);
    assert.equal(await allWritesOpt.isEnabled(), true);
    assert.equal(await highRiskOpt.isEnabled(), true);

    // Capture advanced expanded screenshot
    await page.screenshot({ path: join(screenshotDir, "advanced-expanded-1280.png"), fullPage: true });

    await globalRetries.fill("999");
    await advancedSettings.locator("> summary").click();
    await profilesRoot.locator(".dsmm-save-lock-reason button").click();
    await t.test("global invalid numeric draft locator restores the exact collapsed field", async () => {
      assert.equal(await globalRetries.evaluate((el: HTMLElement) => document.activeElement === el), true);
      assert.equal(await globalRetries.inputValue(), "999");
    });
    await globalRetries.fill("");

    // 9. Draft State & Save Bar
    // Edit the label to trigger dirty draft while advanced settings is still open
    await profileLabelInput.fill("修改后的默认方案");
    await page.waitForTimeout(50);
    assert.equal(await editorState.getAttribute("data-dsmm-editor-state"), "dirty");

    const saveBar = page.locator(".dsmm-save-bar");
    await saveBar.waitFor();
    const saveBarPosition = await saveBar.evaluate((el: HTMLElement) => window.getComputedStyle(el).position);
    assert.equal(saveBarPosition, "sticky", "Main profile save bar must be sticky");

    // In fixed-height container, scroll down and verify save bar stays in visible viewport
    const container = page.locator("[data-profile-ui-harness]");
    await container.evaluate((el: HTMLElement) => { el.scrollTop = 400; });
    await page.waitForTimeout(50);
    const saveBarInViewport = await saveBar.evaluate((el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const parent = el.closest("[data-profile-ui-harness]") || document.documentElement;
      const pRect = parent.getBoundingClientRect();
      return rect.top >= pRect.top - 1 && rect.top < pRect.bottom && rect.bottom > pRect.top;
    });
    assert.equal(saveBarInViewport, true, "Main profile save bar must remain in scroll viewport when scrolled");
    await container.evaluate((el: HTMLElement) => { el.scrollTop = 0; });

    const saveBtn = saveBar.locator("button", { hasText: "保存" });
    assert.equal(await saveBtn.isEnabled(), true);
    await saveBtn.click();
    await page.waitForTimeout(100);

    // Advanced settings disclosure must preserve open state after save
    assert.equal(await advancedSettings.evaluate((el: HTMLDetailsElement) => el.open), true, "Advanced settings must preserve open state after save");

    // Collapse advanced settings
    await advancedSettings.locator("> summary").click();
    assert.equal(await advancedSettings.evaluate((el: HTMLDetailsElement) => el.open), false);

    // Edit label again to have dirty draft for discard test
    await profileLabelInput.fill("再次修改的方案");
    await page.waitForTimeout(50);

    // 10. Focus Restoration on Discard Modal
    const discardBtn = saveBar.locator("button", { hasText: "放弃" });
    await discardBtn.waitFor();
    await discardBtn.focus();
    await discardBtn.click();

    // Discard confirmation dialog appears
    const discardDialog = page.locator(".dsmm-confirm");
    await discardDialog.waitFor();
    await page.screenshot({ path: join(screenshotDir, "discard-modal-1280.png"), fullPage: true });

    // Click Cancel in discard dialog
    const cancelDiscardBtn = discardDialog.locator("button", { hasText: "取消" });
    await cancelDiscardBtn.click();
    await page.waitForTimeout(100);

    // Verify focus is restored to initiator (discardBtn)
    const activeText = await page.evaluate(() => document.activeElement?.textContent?.trim());
    assert.ok(activeText?.includes("放弃"), "Focus must return to discard initiator button");

    // 11. Multi-Agent Dialog (ProfileModelsDialog)
    const openModelsBtn = page.locator(".dsmm-open-models-dialog-btn");
    await openModelsBtn.waitFor();
    await openModelsBtn.click();

    const modelsDialog = page.locator(".dsmm-profile-models-dialog");
    await modelsDialog.waitFor();
    assert.equal(await modelsDialog.isVisible(), true);

    // Check responsive width <= 1040
    const dialogBox = await modelsDialog.boundingBox();
    assert.ok(dialogBox && dialogBox.width <= 1040, "Dialog max width must be <= 1040px");

    // Check dialog top bar
    const dialogTopBar = modelsDialog.locator(".dsmm-dialog-top-bar");
    await dialogTopBar.waitFor();
    assert.equal(await dialogTopBar.isVisible(), true, "Dialog must have a visible top bar");
    const dialogTopSaveBtn = dialogTopBar.locator("button").filter({ hasText: "保存" });
    assert.equal(await dialogTopSaveBtn.count(), 1, "Dialog top bar must have a Save button");
    const dialogTopCloseBtn = dialogTopBar.locator("button").filter({ hasText: "取消" });
    assert.equal(await dialogTopCloseBtn.count(), 1, "Dialog top bar must have a Cancel button");
    assert.equal(await dialogTopSaveBtn.isEnabled(), false, "Dialog save button must be disabled when clean");

    // Check body sibling inert
    const isSiblingInert = await page.evaluate(() => {
      const dialogEl = document.querySelector(".dsmm-profile-models-dialog");
      for (const child of Array.from(document.body.children)) {
        if (child instanceof HTMLElement && !child.contains(dialogEl)) {
          if (!child.hasAttribute("inert")) return false;
        }
      }
      return true;
    });
    assert.equal(isSiblingInert, true, "Body siblings outside dialog must be inert");

    await page.screenshot({ path: join(screenshotDir, "models-dialog-1280.png") });

    // Orchestrator card: primary route editable, no calling levels
    const orchCard = page.locator(".dsmm-role-card[data-dsmm-role='dsmm-orchestrator']");
    await orchCard.waitFor();
    assert.match(await orchCard.innerText(), /主协调.*不适用调用档位/u);
    const orchDialogModel = orchCard.locator(".dsmm-role-primary-route input[id$='-model']");
    assert.equal(await orchDialogModel.inputValue(), "deepseek-chat");

    // Builder card: primary, levels, fallback, non-model
    const builderCard = page.locator(".dsmm-role-card[data-dsmm-role='dsmm-builder']");
    await builderCard.waitFor();
    const builderDialogModel = builderCard.locator(".dsmm-role-primary-route input[id$='-model']");
    assert.equal(await builderDialogModel.inputValue(), "deepseek-reasoner");

    // Verify geometric alignment: search input and checkbox toggle baseline
    const searchBox = await page.locator(".dsmm-filter-search input").boundingBox();
    const toggleBox = await page.locator(".dsmm-filter-override-toggle").boundingBox();
    assert.ok(searchBox && toggleBox);
    assert.ok(Math.abs((searchBox.y + searchBox.height / 2) - (toggleBox.y + toggleBox.height / 2)) <= 2, "Search input and override toggle must be vertically center-aligned");

    // Verify left boundary alignment of primary route fields across role cards
    const orchRouteBox = await orchCard.locator(".dsmm-role-primary-route").boundingBox();
    const builderRouteBox = await builderCard.locator(".dsmm-role-primary-route").boundingBox();
    assert.ok(orchRouteBox && builderRouteBox);
    assert.ok(Math.abs(orchRouteBox.x - builderRouteBox.x) <= 2, "Role card primary route fields must share the same left boundary");

    // 12. Dual Orchestrator Model Synchronization & Dialog Save Eligibility
    await orchDialogModel.fill("deepseek-reasoner");
    assert.equal(await dialogTopSaveBtn.isEnabled(), true, "Dialog save button must be enabled when dirty and valid");

    // Invalid model input locks save in dialog
    await orchDialogModel.fill("");
    await page.waitForTimeout(50);
    assert.equal(await dialogTopSaveBtn.isEnabled(), false, "Dialog save button must be disabled when invalid");
    await orchDialogModel.fill("deepseek-reasoner");
    await page.waitForTimeout(50);
    assert.equal(await dialogTopSaveBtn.isEnabled(), true, "Dialog save button re-enables when valid");

    // Save from dialog top bar
    await dialogTopSaveBtn.click();
    await page.waitForTimeout(100);
    assert.equal(await dialogTopSaveBtn.isEnabled(), false, "Dialog save button must be disabled after saving");

    // Close button retains uncommitted draft
    await orchDialogModel.fill("deepseek-chat");
    await page.keyboard.press("Escape");
    await dialogTopCloseBtn.click();
    await page.waitForTimeout(100);
    assert.equal(await modelsDialog.count(), 0, "Cancel/Close button unmounts modal");
    assert.equal(await editorState.getAttribute("data-dsmm-editor-state"), "dirty");
    assert.equal(await orchestratorModel.inputValue(), "deepseek-chat");

    // Reopen dialog to test Escape behavior
    await openModelsBtn.click();
    await modelsDialog.waitFor();
    await orchDialogModel.fill("deepseek-reasoner");
    // First Escape closes EditableChoice suggestion dropdown; dialog stays open
    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);
    assert.equal(await modelsDialog.count(), 1, "First Escape must close only the combobox dropdown");
    // Second Escape closes modal dialog
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    assert.equal(await modelsDialog.count(), 0, "Second Escape unmounts the modal dialog");
    // Verify focus returned to trigger button
    assert.equal(await page.evaluate(() => document.activeElement?.className), await openModelsBtn.evaluate((el: HTMLElement) => el.className));
    // Verify main page orchestrator model updated
    assert.equal(await orchestratorModel.inputValue(), "deepseek-reasoner");

    // Revert orchestrator model on main page
    await orchestratorModel.fill("deepseek-chat");
    await openModelsBtn.click();
    await modelsDialog.waitFor();
    assert.equal(await orchCard.locator(".dsmm-role-primary-route input[id$='-model']").inputValue(), "deepseek-chat");

    // 13. Search and Explicit Model Override Filtering
    const searchInput = page.locator(".dsmm-models-filter-bar input[type='search'], .dsmm-filter-bar input[type='search']");
    await searchInput.fill("Builder");
    await page.waitForTimeout(50);
    assert.equal(await page.locator(".dsmm-role-card").count(), 1);
    await searchInput.fill("");
    await page.waitForTimeout(50);
    assert.ok((await page.locator(".dsmm-role-card").count()) > 1);

    const explicitFilter = page.locator(".dsmm-models-filter-bar input[type='checkbox'], .dsmm-filter-bar input[type='checkbox']");
    await explicitFilter.click();
    await page.waitForTimeout(50);
    // Explicit filter shows only roles with explicit model overrides
    assert.ok((await page.locator(".dsmm-role-card").count()) >= 1);
    await explicitFilter.click();
    await page.waitForTimeout(50);

    // 14. Dialog Scrollability to Last Role
    const dialogContent = page.locator(".dsmm-profile-models-dialog-content");
    await dialogContent.waitFor();
    const lastRoleCard = page.locator(".dsmm-role-card[data-dsmm-role='dsmm-quick']");
    await lastRoleCard.waitFor();
    await dialogContent.hover();
    const scrollStart = await dialogContent.evaluate((el: HTMLElement) => el.scrollTop);
    await page.mouse.wheel(0, 10_000);
    await page.waitForFunction(() => {
      const content = document.querySelector(".dsmm-profile-models-dialog-content");
      return content !== null && content.scrollTop > 0 && content.scrollTop + content.clientHeight >= content.scrollHeight - 1;
    });
    assert.ok(await dialogContent.evaluate((el: HTMLElement) => el.scrollTop) > scrollStart, "Mouse wheel must scroll dialog content");
    assert.equal(await lastRoleCard.evaluate((el: HTMLElement) => {
      const viewport = document.querySelector(".dsmm-profile-models-dialog-content")!.getBoundingClientRect();
      const card = el.getBoundingClientRect();
      return card.bottom > viewport.top && card.top < viewport.bottom && card.right > viewport.left && card.left < viewport.right;
    }), true, "Last role must intersect the actual scroll viewport");
    assert.equal(await dialogTopBar.isVisible(), true, "Dialog top bar must remain visible while scrolled to bottom");
    const dialogTopBarInViewport = await dialogTopBar.evaluate((el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const viewport = document.querySelector(".dsmm-profile-models-dialog-content")!.getBoundingClientRect();
      return rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom && rect.top < viewport.bottom && rect.bottom > viewport.top;
    });
    assert.equal(dialogTopBarInViewport, true, "Dialog top bar bounding rect must remain within scroll viewport while scrolled to bottom");
    // Scroll back to top
    await dialogContent.evaluate((el: HTMLElement) => { el.scrollTop = 0; });
    await page.waitForTimeout(50);

    // 15. Tab Focus Trap Cycle
    const closeModelsBtn = modelsDialog.locator("button").first();
    await closeModelsBtn.focus();
    await page.keyboard.press("Shift+Tab");
    const lastSummary = lastRoleCard.locator("details[data-dsmm-details='non-model'] > summary");
    assert.equal(await lastSummary.evaluate((el: HTMLElement) => document.activeElement === el), true, "Shift+Tab from close must wrap to last visible summary");

    // Tab from last wraps back to first focusable element
    await page.keyboard.press("Tab");
    assert.equal(await closeModelsBtn.evaluate((el: HTMLElement) => document.activeElement === el), true, "Tab from last summary must wrap to close");
    await lastSummary.click();
    await closeModelsBtn.focus();
    await page.keyboard.press("Shift+Tab");
    const lastControl = lastRoleCard.locator("input[data-dsmm-policy-field='maxSwitches']");
    assert.equal(await lastControl.evaluate((el: HTMLElement) => document.activeElement === el), true, "Expanded last group must wrap to its real last control");
    await page.keyboard.press("Tab");
    assert.equal(await closeModelsBtn.evaluate((el: HTMLElement) => document.activeElement === el), true);

    // 16. Fallback Chain Add, Move Boundaries, and Safe Focus
    const fallbackDetails = builderCard.locator("details[data-dsmm-details='fallback']");
    await fallbackDetails.locator("> summary").click();
    const addFallbackBtn = builderCard.locator("button[data-dsmm-action='add-fallback']");
    await addFallbackBtn.click();
    await page.waitForTimeout(50);
    const newFallbackRow = builderCard.locator("[data-dsmm-fallback-index='1']");
    await newFallbackRow.waitFor();

    // Verify focus landed on new fallback item's provider input
    assert.equal(await newFallbackRow.locator("input[id$='-provider']").evaluate((el: HTMLElement) => document.activeElement === el), true, "Adding fallback must focus the new route's provider");

    // Move index 1 up to index 0
    const moveUpBtn = newFallbackRow.locator("button[data-dsmm-action='moveUp']");
    await moveUpBtn.click();
    await page.waitForTimeout(50);

    // Verify focus on moved item did not land on disabled moveUp button at index 0
    const activeAfterMoveUp = await page.evaluate(() => document.activeElement?.getAttribute("data-dsmm-action"));
    assert.ok(activeAfterMoveUp === "moveDown" || activeAfterMoveUp === "remove", "Moving to top must focus available action, never disabled moveUp");
    assert.equal(await builderCard.locator("[data-dsmm-fallback-index='0']").evaluate((el: HTMLElement) => el.contains(document.activeElement)), true);
    await builderCard.locator("[data-dsmm-fallback-index='0'] button[data-dsmm-action='moveDown']").click();
    assert.equal(await newFallbackRow.evaluate((el: HTMLElement) => el.contains(document.activeElement)), true, "Moving to the bottom must focus the moved route row");
    assert.equal(await newFallbackRow.locator("input[id$='-provider']").inputValue(), "");

    // Remove the added fallback
    const removeBtn = newFallbackRow.locator("button[data-dsmm-action='remove']");
    await removeBtn.click();
    await page.waitForTimeout(50);
    const activeAfterRemove = await page.evaluate(() => document.activeElement?.getAttribute("data-dsmm-action"));
    assert.ok(activeAfterRemove === "remove" || activeAfterRemove === "add-fallback", "Removing item must preserve focus on next remove or add button");
    assert.equal(await builderCard.locator("[data-dsmm-fallback-index='0'] button[data-dsmm-action='remove']").evaluate((el: HTMLElement) => document.activeElement === el), true);
    assert.equal(await builderCard.locator("[data-dsmm-fallback-index='0'] input[id$='-provider']").inputValue(), "openai");

    // 17. Invalid Draft across Modal Unmount & Auto-Locate
    const nonModelDetails = builderCard.locator("details[data-dsmm-details='non-model']");
    await nonModelDetails.locator("> summary").click();
    const builderRetryInput = builderCard.locator("[data-dsmm-policy-field='maxRetries'] input, input[data-dsmm-policy-field='maxRetries']");
    await builderRetryInput.fill("999"); // invalid 0-10
    await page.waitForTimeout(50);

    // Close dialog via Esc
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);

    assert.equal(await editorState.getAttribute("data-dsmm-editor-state"), "invalid");
    assert.equal(await saveBtn.isDisabled(), true, "Save button must be disabled when invalid fields exist");
    await page.screenshot({ path: join(screenshotDir, "invalid-draft-1280.png"), fullPage: true });

    // Verify Actionable Save-Lock Locator on Main Page
    const saveLockText = page.locator(".dsmm-save-lock-text");
    await saveLockText.waitFor();
    const saveLockMsg = await saveLockText.innerText();
    assert.ok(!saveLockMsg.includes("{reason}"), "Save lock reason must not leave unreplaced {reason} placeholder");

    const saveLockLocator = page.locator(".dsmm-save-lock-reason button");
    await saveLockLocator.waitFor();
    assert.match(await saveLockLocator.innerText(), /dsmm-builder\.rateLimit\.maxRetries/u);
    await saveLockLocator.click();

    // Dialog auto-reopens, target details opens, and invalid input is focused!
    await modelsDialog.waitFor();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-invalid")), "true");
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement)?.value), "999");
    await page.screenshot({ path: join(screenshotDir, "auto-locate-invalid-1280.png") });

    await page.keyboard.press("Escape");

    // 18. JSONC Syntax Error & Recovery
    const jsoncDisclosure = page.locator("details.dsmm-advanced");
    if (!(await jsoncDisclosure.evaluate((el: HTMLDetailsElement) => el.open))) {
      await jsoncDisclosure.locator("> summary").click();
    }
    const jsoncTextarea = jsoncDisclosure.locator("textarea");
    const validJsonc = await jsoncTextarea.inputValue();
    await jsoncTextarea.fill(validJsonc + "\n{ invalid json syntax\n");
    await page.waitForTimeout(50);

    const invalidNotice = page.locator("[data-dsmm-structured-invalid]");
    await invalidNotice.first().waitFor();
    assert.equal(await saveBtn.isDisabled(), true, "Save must remain disabled while JSONC is invalid");

    // Restore JSONC
    await jsoncTextarea.fill(validJsonc);
    await page.waitForTimeout(50);

    // Invalid numeric draft is STILL PRESENT and Save is STILL LOCKED
    assert.equal(await editorState.getAttribute("data-dsmm-editor-state"), "invalid");
    assert.equal(await saveBtn.isDisabled(), true, "Save must still be locked after restoring JSONC");

    // Editing unmounted role source in JSONC unlocks Save
    const sourceWithMaxRetries = validJsonc.replace(
      /"dsmm-builder":\s*\{/u,
      '"dsmm-builder": {\n          "rateLimit": { "maxRetries": 3 },'
    );
    await jsoncTextarea.fill(sourceWithMaxRetries);
    await page.waitForTimeout(100);

    assert.equal(await editorState.getAttribute("data-dsmm-editor-state"), "dirty");
    assert.equal(await saveBtn.isEnabled(), true, "Save must be enabled after JSONC explicit source edit");

    // 17. Save & Commit
    await saveBtn.click();
    await page.waitForTimeout(100);
    assert.ok(savePayload !== null, "Save request must be sent to remote bridge");
    assert.equal(await editorState.getAttribute("data-dsmm-editor-state"), "ready");

    // Verify remounted role input in dialog reflects accepted value
    await openModelsBtn.click();
    await modelsDialog.waitFor();
    await page.locator("[data-dsmm-role='dsmm-builder'] details[data-dsmm-details='non-model'] > summary").click();
    const remountedBuilderRetry = page.locator("[data-dsmm-role='dsmm-builder'] [data-dsmm-policy-field='maxRetries']");
    assert.equal(await remountedBuilderRetry.inputValue(), "3");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);

    const contentBeforeDiagnostics = await jsoncTextarea.inputValue();
    const diagnosticContent = "// UTF-16 😀 diagnostic fixture\n" + contentBeforeDiagnostics;
    await page.evaluate((content: string) => {
      window.__profilesController.actions.editContent(content);
      window.__profilesController.actions.editPath(["settings", "roleRouting", "dsmm-builder", "levels", "low"], { reasoningEffort: "exact" });
    }, diagnosticContent);
    const locatedContent = await jsoncTextarea.inputValue();
    const location = diagnosticLocation(locatedContent, locatedContent.indexOf('"roleRouting"'), '"roleRouting"'.length);
    const knownTargets = [
      ["settings.roleRouting.dsmm-builder.primary.provider", ".dsmm-role-primary-route input[id$='-provider']"],
      ["settings.roleRouting.dsmm-builder.primary.model", ".dsmm-role-primary-route input[id$='-model']"],
      ["settings.roleRouting.dsmm-builder.primary.reasoningEffort", ".dsmm-role-primary-route input[id$='-effort']"],
      ["settings.roleRouting.dsmm-builder.levels.high.model", "[data-dsmm-level='high'] input[id$='-model']"],
      ["settings.roleRouting.dsmm-builder.levels.low.reasoningEffort", "[data-dsmm-level='low'] input[id$='-effort']"],
      ["settings.roleRouting.dsmm-builder.fallbackRoutes[0].model", "[data-dsmm-fallback-index='0'] input[id$='-model']"],
      ["settings.roles.dsmm-builder", "select[id$='-role-enabled']"],
      ["settings.roleRouting.dsmm-builder.strategy", "select[id$='-strategy']"],
      ["settings.roleRouting.dsmm-builder.rateLimit.maxRetries", "input[data-dsmm-policy-field='maxRetries']"],
      ["settings.roleRouting.dsmm-builder.primary", "select[id$='-primary-mode']"],
      ["settings.roleRouting.dsmm-builder.levels.high", "[data-dsmm-level='high'] select[id$='-mode']"],
      ["settings.roleRouting.dsmm-builder.fallbackRoutes", "select[id$='-fallback-mode']"],
    ];
    for (const [field, selector] of knownTargets) {
      saveRefusal = { code: "validation", message: "", field, reason: "invalid-type", location };
      const epoch = await page.evaluate(() => window.__profilesController.store.getSnapshot().validationEpoch);
      await saveBtn.click();
      await modelsDialog.waitFor();
      await page.waitForTimeout(100);
      await t.test(`Host save refusal locates ${field}`, async () => {
        assert.equal(await page.evaluate(() => window.__profilesController.store.getSnapshot().validationEpoch), epoch + 1);
        assert.equal(await builderCard.locator(selector).evaluate((el: HTMLElement) => document.activeElement === el), true);
      });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(50);
    }
    for (const [field, selector] of [
      ["settings.runtimePolicy.rateLimit.maxRetries", "input[data-dsmm-policy-field='maxRetries']"],
      ["settings.runtimePolicy.strategy", "select[id$='-strategy']"],
      ["settings.guards.gitWriteGuard", "select[id$='-git-guard']"],
      ["settings.guards.gitWriteScope", "select[id$='-git-scope']"],
      ["settings.subagents.toolTopology", "select[id$='-topology']"],
    ]) {
      if (await advancedSettings.evaluate((el: HTMLDetailsElement) => el.open)) await advancedSettings.locator("> summary").click();
      saveRefusal = { code: "validation", message: "", field, reason: "invalid-type", location };
      await saveBtn.click();
      await page.waitForTimeout(100);
      await t.test(`Host save refusal locates collapsed global field ${field}`, async () => {
        assert.equal(await modelsDialog.count(), 0);
        assert.equal(await advancedSettings.locator(selector).evaluate((el: HTMLElement) => document.activeElement === el), true);
      });
    }
    const unmappedFields = [
      "settings.roleRouting.dsmm-builder.levels.high.[unknown]",
      "settings.roleRouting.dsmm-builder.primary.[unknown]",
      "settings.roleRouting.dsmm-builder.primary.model.[unknown]",
      "settings.roleRouting.dsmm-builder.fallbackRoutes[9].model",
      "settings.roleRouting.dsmm-builder.fallbackRoutes[0].model.[unknown]",
      "settings.roleRouting.dsmm-builder.fallbackRoutes.[unknown]",
      "settings.roleRouting.dsmm-builder.fallbackRoutes[0]",
      "settings.roleRouting.dsmm-builder.rateLimit.[unknown]",
      "settings.roles.dsmm-builder.[unknown]",
      "settings.roleRouting.dsmm-code-search.primary.model",
      "settings.roleRouting.dsmm-reviewer.primary.model",
      "settings.roleRouting.dsmm-builder.levels.low.provider",
      "settings.runtimePolicy.rateLimit.[unknown]",
    ];
    for (const field of unmappedFields) {
      saveRefusal = { code: "validation", message: "", field, reason: "unknown-field", location };
      await saveBtn.click();
      await page.waitForTimeout(150);
      await t.test(`Unmapped Host save refusal falls back to JSONC: ${field}`, async () => {
        assert.equal(await modelsDialog.count(), 0);
        assert.deepEqual(await jsoncTextarea.evaluate((el: HTMLTextAreaElement) => ({ focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd })),
          { focused: true, start: location.offset, end: location.offset + location.length });
      });
      if (await modelsDialog.count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(50); }
    }

    saveRefusal = { code: "validation", message: "", field: "settings.roleRouting.dsmm-builder.primary.model", reason: "invalid-route", location };
    await page.evaluate(async (content: string) => {
      window.__profilesController.actions.editContent(content + "\n{");
      await window.__profilesController.actions.save();
    }, locatedContent);
    await page.waitForTimeout(150);
    await t.test("unfocusable structured field falls back to JSONC without losing its validation range", async () => {
      assert.equal(await modelsDialog.count(), 0);
      assert.deepEqual(await jsoncTextarea.evaluate((el: HTMLTextAreaElement) => ({ focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd })),
        { focused: true, start: location.offset, end: location.offset + location.length });
    });
    await page.evaluate(async (content: string) => {
      window.__profilesController.actions.editContent(content);
      await window.__profilesController.actions.save();
    }, locatedContent);
    await modelsDialog.waitFor();
    await page.waitForTimeout(100);
    await page.keyboard.press("Escape");

    // An explicit JSONC jump from an issue-bearing dialog must not restore its old trigger.
    await openModelsBtn.click();
    await modelsDialog.waitFor();
    await modelsDialog.locator(".dsmm-dialog-issue button").click();
    await page.waitForTimeout(150);
    await t.test("dialog diagnostic JSONC jump focuses and selects after inert cleanup without trigger contention", async () => {
      assert.equal(await modelsDialog.count(), 0);
      assert.deepEqual(await jsoncTextarea.evaluate((el: HTMLTextAreaElement) => ({ focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd, inert: el.closest("[inert]") !== null })),
        { focused: true, start: location.offset, end: location.offset + location.length, inert: false });
    });

    await openModelsBtn.click();
    await modelsDialog.waitFor();
    const previousEpoch = await page.evaluate(() => window.__profilesController.store.getSnapshot().editorEpoch);
    await page.evaluate(async () => {
      document.querySelector<HTMLButtonElement>(".dsmm-dialog-issue button")!.click();
      await window.__profilesController.actions.create();
      await window.__profilesController.actions.discardAndOpen();
      window.__profilesController.actions.editId("INVALID");
      await window.__profilesController.actions.save();
    });
    await page.waitForTimeout(150);
    await t.test("a pending dialog jump cannot steal focus from a new editor validation epoch", async () => {
      assert.equal(await page.evaluate(() => window.__profilesController.store.getSnapshot().editorEpoch), previousEpoch + 1);
      assert.equal(await profileIdInput.evaluate((el: HTMLElement) => document.activeElement === el), true);
      assert.equal(await profileIdInput.inputValue(), "INVALID");
    });
    saveRefusal = null;
    await page.evaluate(async () => {
      await window.__profilesController.actions.open("default");
      await window.__profilesController.actions.discardAndOpen();
    });
    await page.evaluate((content: string) => window.__profilesController.actions.editContent(content), contentBeforeDiagnostics);
    await page.evaluate(() => window.__profilesController.actions.save());

    // Verify responsive dialog widths at tablet (768) and mobile (375)
    await page.setViewportSize({ width: 768, height: 900 });
    await openModelsBtn.click();
    await modelsDialog.waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      "Reflow check with dialog open at 768px"
    );
    await page.screenshot({ path: join(screenshotDir, "models-dialog-tablet-768.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);

    await page.setViewportSize({ width: 375, height: 900 });
    await openModelsBtn.click();
    await modelsDialog.waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      "Reflow check with dialog open at 375px"
    );
    await page.screenshot({ path: join(screenshotDir, "models-dialog-mobile-375.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);

    // Restore desktop viewport
    await page.setViewportSize({ width: 1280, height: 900 });

    includeOrchestrator = false;
    await page.evaluate(() => window.__profilesController.actions.refresh());
    const orchMode = profilesRoot.locator("select[id$='-orch-mode']");
    assert.equal(await orchMode.isDisabled(), true);
    assert.equal(await orchestratorProvider.isDisabled(), true);
    assert.equal(await orchestratorModel.isDisabled(), true);
    const unavailableReason = await orchMode.getAttribute("aria-describedby");
    assert.ok(unavailableReason);
    assert.equal(await page.locator(`[id='${unavailableReason}']`).isVisible(), true);
    const storedRoute = JSON.parse(await jsoncTextarea.inputValue()).settings.roleRouting["dsmm-orchestrator"];
    await profileLabelInput.fill("库存缺失时保留主协调配置");
    await saveBtn.click();
    await page.waitForFunction(() => window.__profilesController.store.getSnapshot().busy === null);
    assert.deepEqual(JSON.parse((savePayload as { content: string }).content).settings.roleRouting["dsmm-orchestrator"], storedRoute);

    const feedback = profilesRoot.locator("[data-dsmm-session-feedback]");
    const applySession = moreActions.locator("[data-dsmm-session-scope] .dsmm-actions button").first();
    for (const kind of ["conflict", "unconfirmed", "success"]) {
      await applySession.click();
      await page.waitForFunction(() => window.__profilesController.store.getSnapshot().sessionBusy === "apply");
      await moreActions.locator("> summary").focus();
      await page.keyboard.press("Enter");
      assert.equal(await moreActions.evaluate((el: HTMLDetailsElement) => el.open), false);
      assert.ok(releaseSession);
      if (kind === "success") {
        releaseSession({ ok: true, value: { ...await page.evaluate(() => window.__profilesController.store.getSnapshot().session), admissionEpoch: "epoch-2" } });
        await page.waitForFunction(() => window.__profilesController.store.getSnapshot().sessionNotice === "applied");
        await feedback.getByRole("status").last().waitFor();
        assert.equal(await feedback.getByRole("status").last().isVisible(), true);
        assert.equal(await profilesRoot.getByRole("alert").count(), 0);
      } else {
        releaseSession(kind === "conflict"
          ? { ok: false, error: { code: "dsmm-profiles/refused", details: { code: "conflict", message: "" } } }
          : { ok: false, error: { code: "gateway/unavailable" } });
        await feedback.getByRole("alert").waitFor();
        assert.equal(await feedback.getByRole("alert").isVisible(), true);
        assert.equal(await profilesRoot.getByRole("alert").count(), 1, "Feedback must not be duplicated inside the disclosure");
      }
      if (kind === "unconfirmed") {
        assert.equal(await page.evaluate(() => window.__profilesController.store.getSnapshot().sessionUnconfirmed), true);
        assert.equal(await feedback.getByRole("status").first().isVisible(), true);
        await page.screenshot({ path: join(screenshotDir, "collapsed-session-unconfirmed-1280.png"), fullPage: true });
      }
      await page.evaluate(() => window.__profilesController.actions.refreshSession());
      await moreActions.locator("> summary").click();
    }

    await moreActions.locator("> summary").click();
    sessionRefreshRequired = true;
    sessionWarning = true;
    await page.evaluate(() => window.__profilesController.actions.refreshSession());
    assert.equal(await feedback.getByRole("status").first().isVisible(), true);
    await feedback.locator("[data-dsmm-warning]").waitFor();
    assert.equal(await feedback.locator("[data-dsmm-warning]").isVisible(), true);

    assert.equal(errors.length, 0, `Page errors: ${errors.join(", ")}`);
  } finally {
    if (process.env.DSMM_SCREENSHOT_DIR) {
      const { cp } = await import("node:fs/promises");
      await cp(screenshotDir, process.env.DSMM_SCREENSHOT_DIR, { recursive: true });
    }
    if (browser) await browser.close();
    if (server) await server.close();
    await rm(owned, { recursive: true, force: true });
  }
});
