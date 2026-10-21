import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const available = process.env.DSMM_TEST_DSH_ENTRY !== undefined && process.env.DSMM_TEST_PLAYWRIGHT_ENTRY !== undefined;

test("editable choices keep highlighted IDs across catalog reorder and cancel removed choices", { skip: !available && "requires explicit DSH and Playwright anchors (DSMM_TEST_DSH_ENTRY and DSMM_TEST_PLAYWRIGHT_ENTRY)" }, async () => {
  const sdk = createRequire(process.env.DSMM_TEST_DSH_ENTRY!);
  const { chromium } = createRequire(process.env.DSMM_TEST_PLAYWRIGHT_ENTRY!)("playwright");
  const { startProfileUiServer } = await import(new URL("../scripts/profile-ui-harness-server.mjs", import.meta.url).href);
  const { COMPOSITION_ID } = await import(new URL("../scripts/profile-ui-harness-browser.mjs", import.meta.url).href);
  const { stableCompositionBundle } = await import(new URL("../scripts/stable-native-acceptance.mjs", import.meta.url).href);
  const temporaryParent = await realpath(tmpdir());
  const owned = await realpath(await mkdtemp(join(temporaryParent, "dsmm-choice-state-")));
  const packageRoot = join(owned, "package"), sourceRoot = fileURLToPath(new URL("../src/client/", import.meta.url));
  let server: Awaited<ReturnType<typeof startProfileUiServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await mkdir(join(packageRoot, "lib"), { recursive: true });
    const result = await build({ stdin: { sourcefile: "choice-state-fixture.tsx", resolveDir: sourceRoot, loader: "tsx", contents: `
      import React, {useState} from 'react';
      import {EditableChoice} from './EditableChoice.tsx';
      import {PROFILE_STYLES} from './styles.ts';
      const rows = [{id:'low',name:'Low'},{id:'high',name:'High'}];
      const changes = {primary:[],fallback:[]};
      function Surface(){
        const [values,setValues] = useState({primary:'custom-primary',fallback:'custom-fallback'});
        const [options,setOptions] = useState({primary:rows,fallback:rows});
        window.__choiceState = {changes, replaceOptions:(id,next)=>setOptions(current=>({...current,[id]:next}))};
        return <section className="dsmm-profiles">{['primary','fallback'].map(id=><div className="dsmm-field" key={id}>
          <label htmlFor={id}>{id}</label><EditableChoice id={id} label={id} value={values[id]} options={options[id]} disabled={false}
            onChange={value=>{changes[id].push(value);setValues(current=>({...current,[id]:value}));}}
            onSelect={id==='primary'?value=>{changes[id].push(value);setValues(current=>({...current,[id]:value}));}:undefined} />
        </div>)}</section>;
      }
      export const inject = ['slots'];
      export function apply(ctx){
        ctx.effect(()=>{const style=document.createElement('style');style.textContent=PROFILE_STYLES;document.head.append(style);return()=>style.remove();});
        ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'dsmm-profiles'},Surface));
      }
    ` }, bundle: true, write: false, platform: "browser", format: "cjs", target: "es2022", external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"],
      banner: { js: 'window.__ModuleLoader__.load({id:"@dsmm/dsmm",factory:(require)=>{const module={exports:{}};const exports=module.exports;' },
      footer: { js: "return module.exports;}});" } });
    await writeFile(join(packageRoot, "lib", "client.js"), result.outputFiles![0]!.text);
    server = await startProfileUiServer({ nativeRequire: sdk, packageRoot, sha256: "owned-choice-state", composition: stableCompositionBundle(COMPOSITION_ID) });
    browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: false, args: ["--disable-extensions", "--disable-sync"] });
    const context = await browser.newContext({ viewport: { width: 768, height: 900 }, serviceWorkers: "block" });
    assert.deepEqual(await context.cookies(), []);
    await context.route("**/*", (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) =>
      new URL(route.request().url()).origin === server!.origin ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.name));
    await page.exposeBinding("__dsmmNativeBridge", () => ({ ok: false, error: { code: "gateway/unavailable", message: "Unavailable", details: {} } }));
    await page.goto(server.origin);
    const primary = page.getByRole("combobox", { name: "primary", exact: true }), fallback = page.getByRole("combobox", { name: "fallback", exact: true });
    await primary.waitFor();
    const selected = () => primary.evaluate((input: HTMLInputElement) => {
      const id = input.getAttribute("aria-activedescendant"); return id === null ? null : document.getElementById(id)?.getAttribute("data-value");
    });
    await primary.focus(); await primary.press("ArrowDown"); await primary.press("ArrowDown");
    assert.equal(await selected(), "high");
    await page.evaluate(() => Reflect.get(window, "__choiceState").replaceOptions("primary", [{ id: "high", name: "High" }, { id: "low", name: "Low" }]));
    await page.waitForFunction(() => document.querySelector('#primary-choices [role="option"]')?.getAttribute("data-value") === "high");
    assert.equal(await selected(), "high");
    await page.evaluate(() => Reflect.get(window, "__choiceState").replaceOptions("primary", [
      ...Array.from({ length: 12 }, (_, index) => ({ id: `inserted-${index}`, name: `Inserted ${index}` })),
      { id: "high", name: "High" }, { id: "low", name: "Low" },
    ]));
    await page.waitForFunction(() => {
      const input = document.getElementById("primary")!, row = document.getElementById(input.getAttribute("aria-activedescendant") ?? "");
      if (row?.getAttribute("data-value") !== "high") return false;
      const item = row.getBoundingClientRect(), list = row.parentElement!.getBoundingClientRect();
      return item.top >= list.top && item.bottom <= list.bottom;
    });
    await primary.press("ArrowDown"); assert.equal(await selected(), "low");
    await primary.press("ArrowUp"); assert.equal(await selected(), "high");
    await primary.press("Enter");
    assert.equal(await primary.inputValue(), "high"); assert.equal(await fallback.inputValue(), "custom-fallback");

    await page.evaluate(() => Reflect.get(window, "__choiceState").replaceOptions("primary", [{ id: "high", name: "High" }, { id: "low", name: "Low" }]));
    await primary.fill("typed-exact");
    await page.waitForFunction(() => document.querySelector('#primary-choices [role="option"]')?.getAttribute("data-value") === "high");
    await primary.press("Escape");
    await primary.press("ArrowDown"); assert.equal(await selected(), "high");
    const before = await page.evaluate(() => [...Reflect.get(window, "__choiceState").changes.primary]);
    await page.evaluate(() => Reflect.get(window, "__choiceState").replaceOptions("primary", [{ id: "low", name: "Low" }]));
    await page.waitForFunction(() => !document.querySelector('#primary-choices [data-value="high"]'));
    assert.equal(await selected(), null);
    await primary.press("Enter");
    assert.equal(await primary.inputValue(), "typed-exact");
    assert.deepEqual(await page.evaluate(() => [...Reflect.get(window, "__choiceState").changes.primary]), before);
    assert.equal(await fallback.inputValue(), "custom-fallback");

    await primary.press("ArrowDown");
    await primary.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    assert.equal(await primary.inputValue(), "typed-exact"); assert.equal(await selected(), "low");
    await primary.press("Escape"); assert.equal(await primary.getAttribute("aria-expanded"), "false");
    await fallback.focus(); await fallback.press("ArrowDown"); await fallback.press("ArrowDown"); await fallback.press("Enter");
    assert.equal(await fallback.inputValue(), "high"); assert.equal(await primary.inputValue(), "typed-exact");
    assert.deepEqual(await page.evaluate(() => [...Reflect.get(window, "__choiceState").changes.fallback]), ["high"]);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser?.close(); await server?.close();
    if (await realpath(owned) !== owned || dirname(owned) !== temporaryParent || !basename(owned).startsWith("dsmm-choice-state-")) throw new Error("Unexpected browser fixture cleanup path");
    await rm(owned, { recursive: true, force: false });
  }
});
