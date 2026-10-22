import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import type { ProfilesController } from "../src/client/controller.js";
import { diagnostic } from "../src/profile-diagnostics.ts";

declare global {
  interface Window { __profilesController: ProfilesController }
}

const available = process.env.DSMM_TEST_DSH_ENTRY !== undefined && process.env.DSMM_TEST_PLAYWRIGHT_ENTRY !== undefined;

test("Named profiles redesigned UI page-level browser QA and interactive flows", {
  skip: !available && "requires explicit DSH and Playwright anchors (DSMM_TEST_DSH_ENTRY and DSMM_TEST_PLAYWRIGHT_ENTRY)",
  timeout: 60_000,
}, async () => {
  const sdk = createRequire(await realpath(process.env.DSMM_TEST_DSH_ENTRY!));
  const { chromium } = createRequire(process.env.DSMM_TEST_PLAYWRIGHT_ENTRY!)("playwright");
  const { startProfileUiServer } = await import(new URL("../scripts/profile-ui-harness-server.mjs", import.meta.url).href);
  const { COMPOSITION_ID } = await import(new URL("../scripts/profile-ui-harness-browser.mjs", import.meta.url).href);
  const { stableCompositionBundle } = await import(new URL("../scripts/stable-native-acceptance.mjs", import.meta.url).href);

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
      composition: stableCompositionBundle(COMPOSITION_ID),
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

    // Capture desktop normal screenshot
    await page.screenshot({ path: join(screenshotDir, "desktop-normal-1280.png"), fullPage: true });

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

    await page.screenshot({ path: join(screenshotDir, "dark-theme-1280.png"), fullPage: true });

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

    // 7. Advanced Settings Disclosure & Role Routing
    const advancedSettings = page.locator(".dsmm-advanced-settings");
    assert.equal(await advancedSettings.evaluate((el: HTMLDetailsElement) => el.open), false);
    await advancedSettings.locator("> summary").click();
    assert.equal(await advancedSettings.evaluate((el: HTMLDetailsElement) => el.open), true);

    // Initially selected role in advanced is orchestrator
    // Notice indicates orchestrator model is configured in basic settings
    assert.match(await advancedSettings.innerText(), /主协调模型在上方.*配置/u);

    // Switch role to Builder
    const roleSelect = advancedSettings.locator("select[id$='-role']").first();
    await roleSelect.selectOption("dsmm-builder");
    // Verify builder primary model and fallback appear
    const builderModel = advancedSettings.getByRole("combobox", { name: "Builder 主路由 模型" });
    await builderModel.waitFor();
    assert.equal(await builderModel.inputValue(), "deepseek-reasoner");

    const fallbackModel = advancedSettings.getByRole("combobox", { name: "Builder 备用 1 模型" });
    await fallbackModel.waitFor();
    assert.equal(await fallbackModel.inputValue(), "gpt-4o");

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

    // 9. Draft State & Save Bar
    // Edit the label to trigger dirty draft
    await profileLabelInput.fill("修改后的默认方案");
    await page.waitForTimeout(50);
    assert.equal(await editorState.getAttribute("data-dsmm-editor-state"), "dirty");

    const saveBar = page.locator(".dsmm-save-bar");
    await saveBar.waitFor();
    const saveBtn = saveBar.locator("button", { hasText: "保存" });
    assert.equal(await saveBtn.isEnabled(), true);

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
    assert.equal(activeText, "放弃更改", "Focus must return to discard initiator button");

    // 11. Invalid Input Protection via RetryNumber across JSONC syntax errors
    const retryCountInput = advancedSettings.locator("input[type='number']").first();
    await retryCountInput.fill("999"); // 999 is out of range 0-10
    await page.waitForTimeout(50);
    assert.equal(await editorState.getAttribute("data-dsmm-editor-state"), "invalid");
    assert.equal(await saveBtn.isDisabled(), true, "Save button must be disabled when invalid fields exist");
    await page.screenshot({ path: join(screenshotDir, "invalid-draft-1280.png"), fullPage: true });

    // Open JSONC source editor disclosure and make JSONC syntactically invalid
    const jsoncDisclosure = page.locator("details.dsmm-advanced");
    await jsoncDisclosure.locator("> summary").click();
    const jsoncTextarea = jsoncDisclosure.locator("textarea");
    const validJsonc = await jsoncTextarea.inputValue();
    await jsoncTextarea.fill(validJsonc + "\n{ invalid json syntax\n");
    await page.waitForTimeout(50);

    // Form displays projection failure notice and disables controls, but invalid draft is NOT lost
    const invalidNotice = page.locator("[data-dsmm-structured-invalid]");
    await invalidNotice.first().waitFor();
    assert.equal(await saveBtn.isDisabled(), true, "Save must remain disabled while JSONC is invalid");

    // Restore JSONC to valid syntax
    await jsoncTextarea.fill(validJsonc);
    await page.waitForTimeout(50);

    // Verify invalid number draft "999" is STILL PRESENT and Save is STILL LOCKED
    assert.equal(await retryCountInput.inputValue(), "999", "Invalid numeric draft must be preserved after restoring JSONC");
    assert.equal(await editorState.getAttribute("data-dsmm-editor-state"), "invalid");
    assert.equal(await saveBtn.isDisabled(), true, "Save must still be locked after restoring JSONC");

    await roleSelect.selectOption("dsmm-reviewer");
    assert.equal(await advancedSettings.locator("[data-dsmm-role='dsmm-builder']").count(), 0);

    // Editing an unmounted role's source must unlock Save without returning to that role.
    const sourceWithMaxRetries = validJsonc.replace(
      /"dsmm-builder":\s*\{/u,
      '"dsmm-builder": {\n          "rateLimit": { "maxRetries": 3 },'
    );
    await jsoncTextarea.fill(sourceWithMaxRetries);
    await page.waitForTimeout(100);

    assert.equal(await advancedSettings.locator("[data-dsmm-role='dsmm-builder']").count(), 0);
    assert.equal(await editorState.getAttribute("data-dsmm-editor-state"), "dirty");
    assert.equal(await saveBtn.isEnabled(), true, "Save must be enabled after JSONC explicit source edit");

    // 12. Save & Commit
    await saveBtn.click();
    await page.waitForTimeout(100);
    assert.ok(savePayload !== null, "Save request must be sent to remote bridge");
    assert.equal(await editorState.getAttribute("data-dsmm-editor-state"), "ready");
    await roleSelect.selectOption("dsmm-builder");
    assert.equal(await retryCountInput.inputValue(), "3", "Remounted input must reflect the accepted source value");

    // Verify that saving preserved the open state of Advanced Settings
    assert.equal(
      await advancedSettings.evaluate((el: HTMLDetailsElement) => el.open),
      true,
      "Advanced settings disclosure must stay open across save"
    );

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
    if (browser) await browser.close();
    if (server) await server.close();
    await rm(owned, { recursive: true, force: true });
  }
});
