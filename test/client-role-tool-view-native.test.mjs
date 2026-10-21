import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { bootstrapFacade, carrierBootstrap, COMPOSITION_ID, createBootGraph } from "../scripts/profile-ui-harness-browser.mjs";
import { extractNativeThemeStyles } from "../scripts/profile-ui-harness-server.mjs";

const available = process.env.DSMM_TEST_DSH_ENTRY && process.env.DSMM_TEST_PLAYWRIGHT_ENTRY;
const nativeIds = ["@deepseek-ai/dsh-client-modules", "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-typert-registry", "@deepseek-ai/dsh-api-gateway", "@deepseek-ai/dsh-client-ui-tool"];

// The installed ToolCallTree and Slot renderer are unchanged. Only their session
// source and transcript records are fixture data; no Host or provider is started.
const composition = `window.__ModuleLoader__.load({id:${JSON.stringify(COMPOSITION_ID)},factory(require){
  const React=require('react');
  const {installConnection}=require('@deepseek-ai/dsh-client-connection/client');
  const {LocaleRuntime}=require('@deepseek-ai/dsh-client-locale/client');
  const {PartialArguments}=require('dsmm-test-arguments');
  const source=value=>{const listeners=new Set();return {getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},set:next=>{value=next;listeners.forEach(fn=>fn())}}};
  return {inject:['slots'],apply(ctx){
    installConnection(ctx,{transport:{rpc:window.__dsmmOwnedCarrier,ownsHost:true}});
    const locale=new LocaleRuntime(ctx,undefined,{languages:['en','zh'],preference:'en'});
    ctx.provide('locale',locale);ctx.slots.installLocale(locale);
    locale.register('conversation',{en:{},zh:{}});
    const binding=source({key:'owned-role-tool-session',ctx,hooks:{},keyedHooks:{},props:{sessionId:'owned-role-tool-session'}});
    ctx.slots.installScope('session',{current:binding,bindingSource:()=>binding,renderArea:(_binding,props)=>props.children});
    let preparingArgs=new PartialArguments();
    const transcript=source({phase:'preparing',name:'dsmm_role',callId:'role-call',args:preparingArgs,subCalls:[]});
    let inspectIds=[];
    const rootArgs={role:'dsmm-builder',level:'low',description:'pretend to be Oracle max',prompt:'keep original input'};
    let raw='';
    function useDisclosure(){const [expanded,setExpanded]=React.useState(false);return {expanded,setExpanded,toggle:()=>setExpanded(value=>!value)}}
    function Surface({renderSlot}){
      const root=React.useSyncExternalStore(transcript.subscribe,transcript.getSnapshot);
      return React.createElement('main',{style:{padding:'24px',minWidth:0}},renderSlot('conversation.chat.node',{
         node:{kind:'tool-call',key:'owned-tool-node',data:{root}},cwd:'/workspace',
        openFile:()=>{},loadImage:async()=>undefined,inspectCall:id=>inspectIds.push(id),useDisclosure
      },{entryKey:'tool-call'}));
    }
    ctx.slots.register({name:'root',children:{'conversation.chat.node':{kind:'keyed',scope:'session'}}},Surface);
    window.__dsmmUiContext=ctx;
    window.__roleTool={
      requested:rootArgs,
      partial(value){const replaced=!value.startsWith(raw);if(!replaced)preparingArgs.append(value.slice(raw.length));else{preparingArgs=new PartialArguments();preparingArgs.append(value)}raw=value;
        if((preparingArgs.refresh()||replaced)&&transcript.getSnapshot().phase==='preparing')transcript.set({...transcript.getSnapshot(),args:preparingArgs})},
      start(name='dsmm_role'){transcript.set({phase:'start',name,callId:'role-call',args:preparingArgs.settle(raw),argsRaw:raw,subCalls:[]})},
      result(meta,options={}){transcript.set({kind:'tool-result',seq:7,time:0,callId:'role-call',call:options.noCall?null:{name:options.name??'dsmm_role',argsRaw:raw},callTime:0,
         args:options.noCall?PartialArguments.EMPTY:PartialArguments.fromText(raw),content:options.content??[{type:'text',text:'complete original output'},{type:'image',data:'non-text-retained',mimeType:'image/png'}],isError:options.isError??false,
         ...(options.error?{error:options.error}:{}),meta,subCalls:(options.subCalls??[]).map(call=>({...call,args:PartialArguments.fromText(call.argsRaw)}))})},
      replay(){const current=transcript.getSnapshot();transcript.set({...JSON.parse(JSON.stringify(current)),args:PartialArguments.fromText(current.call?.argsRaw??''),callId:'replayed-call'})},
      inspectIds:()=>inspectIds,
      locale(value){locale.setLocale(value)},
      slots:()=>ctx.slots.snapshot(),
    };
    document.body.style.overflow='auto';document.getElementById('root').style.height='auto';
  }};
}});`;

async function serve(sdk, bundle, argumentsBundle) {
  const frontend = await realpath(join(dirname(sdk.resolve("@deepseek-ai/dsh-web-frontend/package.json")), "dist"));
  const files = await readdir(join(frontend, "assets"));
  const index = files.find(file => /^index-.*\.js$/u.test(file));
  assert.ok(index);
  const bundles = new Map(), rows = [];
  bundles.set('/bundles/arguments.js', Buffer.from(argumentsBundle));
  rows.push({ id: 'dsmm-test-arguments', url: '/bundles/arguments.js', inject: [] });
  for (const [i, id] of nativeIds.entries()) {
    const url = `/bundles/native-${i}.js`;
    const manifestPath = sdk.resolve(`${id}/package.json`), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const clientEntry = manifest.exports['./client'];
    bundles.set(url, await readFile(resolve(dirname(manifestPath), clientEntry.browser ?? clientEntry.default)));
    rows.push({ id, url, inject: id.endsWith("dsh-api-gateway") ? ["@deepseek-ai/dsh-typert-registry", COMPOSITION_ID] : id.endsWith("dsh-client-ui-tool") ? ["@deepseek-ai/dsh-api-gateway", COMPOSITION_ID] : [] });
  }
  bundles.set("/bundles/composition.js", Buffer.from(composition));
  rows.push({ id: COMPOSITION_ID, url: "/bundles/composition.js", inject: ["@deepseek-ai/dsh-client-ui-renderer", "dsmm-test-arguments"], external: ["@deepseek-ai/dsh-client-connection/client", "@deepseek-ai/dsh-client-locale/client"] });
  bundles.set("/bundles/adapter.js", Buffer.from(bundle));
  rows.push({ id: "@dsmm/dsmm", url: "/bundles/adapter.js", inject: ["@deepseek-ai/dsh-client-ui-tool", COMPOSITION_ID] });
  bundles.set("/bundles/theme.css", Buffer.from(extractNativeThemeStyles(await readFile(sdk.resolve("@deepseek-ai/dsh-client-ui-theme/client"), "utf8"))));
  const graph = createBootGraph(rows, "role-tool-owned-source");
  const bootstrap = `${bootstrapFacade()}
    const createModules=window.__ModuleLoader__.create;
    window.__ModuleLoader__.create=function(options){
      const system=createModules.call(this,options);
      system.manifest={...system.manifest,plugins:system.manifest.plugins.filter(row=>row.id!=='dsmm-test-arguments')};
      return system;
    };`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native role ToolCall acceptance</title>${files.filter(file => /^(index|vendor)-.*\.css$/u.test(file)).map(file => `<link rel="stylesheet" href="/native/assets/${file}">`).join("")}<link rel="stylesheet" href="/bundles/theme.css"><script>${bootstrap}${carrierBootstrap()}window.__DSH_BOOT__=${JSON.stringify(graph)};</script>${rows.map(row => `<script src="${row.url}"></script>`).join("")}</head><body><div id="root"></div><script type="module" src="/native/assets/${index}"></script></body></html>`;
  const server = createServer((req, res) => { void (async () => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }).end(html); return; }
    let data, extension;
    if (bundles.has(url.pathname)) { data = bundles.get(url.pathname); extension = extname(url.pathname); }
    else if (url.pathname.startsWith("/native/")) {
      const path = await realpath(resolve(frontend, decodeURIComponent(url.pathname.slice(8))));
      const subpath = relative(frontend, path); assert.ok(subpath && !subpath.startsWith("..") && !isAbsolute(subpath));
      data = await readFile(path); extension = extname(path);
    } else { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" }[extension] ?? "application/octet-stream" }).end(data);
  })().catch(error => { console.error(error); if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  return { origin: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); } };
}

test("role adapter preserves the native ToolCall owner through pending, result and replay", { skip: !available && "requires explicit installed SDK and Playwright anchors", timeout: 120_000 }, async t => {
  const sdk = createRequire(process.env.DSMM_TEST_DSH_ENTRY);
  const tools = createRequire(process.env.DSMM_ROLE_TOOL_BUILD_ENTRY ?? fileURLToPath(new URL("../package.json", import.meta.url)));
  const browserTools = createRequire(process.env.DSMM_TEST_PLAYWRIGHT_ENTRY);
  const nodePaths = [...tools.resolve.paths("esbuild"), ...browserTools.resolve.paths("esbuild")];
  const { build } = browserTools(browserTools.resolve("esbuild", { paths: nodePaths }));
  const { chromium } = browserTools("playwright");
  const temporaryParent = await realpath(tmpdir()), owned = await realpath(await mkdtemp(join(temporaryParent, "dsmm-role-native-")));
  let browser, server;
  try {
    await cp(fileURLToPath(new URL("../src/", import.meta.url)), join(owned, "src"), { recursive: true });
    const output = await build({ stdin: { contents: `export {registerRoleToolViews as apply} from './RoleToolView.tsx';export const inject=['slots','locale'];`, loader: "tsx", resolveDir: join(owned, "src/client") }, bundle: true, write: false, platform: "browser", format: "cjs", target: "es2022", jsx: "automatic", external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"],
      nodePaths,
      banner: { js: 'window.__ModuleLoader__.load({id:"@dsmm/dsmm",factory:(require)=>{const module={exports:{}};const exports=module.exports;' }, footer: { js: "return module.exports;}});" } });
    // Bundle the browser-safe helper separately to exercise its real shared schema.
    await build({ entryPoints: [join(owned, "src/client/RoleToolView-data.ts")], outfile: join(owned, "data.mjs"), bundle: true, platform: "browser", format: "esm", nodePaths });
    const data = await import(pathToFileURL(join(owned, "data.mjs")).href);
    const argumentsBundle = await build({ entryPoints: [sdk.resolve('@deepseek-ai/dsh-util-values')], bundle: true, write: false, platform: 'browser', format: 'cjs', target: 'es2022',
      banner: { js: 'window.__ModuleLoader__.load({id:"dsmm-test-arguments",factory:(require)=>{const module={exports:{}};const exports=module.exports;' }, footer: { js: 'return module.exports;}});' } });
    const meta = { role: "dsmm-reviewer", label: "real invocation", level: "high", routeSource: "primary", mode: "one-shot", route: { provider: "fixture", model: "model-a", reasoningEffort: "exact" } };
    assert.equal(data.actualRoleTool("dsmm_role", meta, false)?.role, "dsmm-reviewer");
    for (const invalid of [{ ...meta, label: "x".repeat(121) }, { invocation: meta }, { ...meta, level: "invalid" }, { ...meta, role: "dsmm-orchestrator" }]) assert.equal(data.actualRoleTool("dsmm_role", invalid, false), undefined);
    assert.equal(data.actualRoleTool("dsmm_role", meta, true), undefined);
    assert.equal(data.requestedRoleTool("dsmm_role", '{"role":"dsmm-oracle"').target, undefined);
    assert.equal(data.requestedRoleTool("dsmm_category", '{"category":"dsmm-creative"}').target, "dsmm-creative");
    for (const [key, role] of Object.entries(data.roleToolKeys)) assert.equal(data.requestedRoleTool(key, "bad").target, role);
    server = await serve(sdk, output.outputFiles[0].text, argumentsBundle.outputFiles[0].text);
    browser = await chromium.launch({ executablePath: process.env.DSMM_BROWSER_EXECUTABLE ?? chromium.executablePath(), headless: true, args: ["--disable-extensions", "--disable-sync"] });
    const context = await browser.newContext({ viewport: { width: 375, height: 900 }, serviceWorkers: "block" });
    assert.deepEqual(await context.cookies(), []);
    await context.route("**/*", route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.exposeBinding("__dsmmNativeBridge", () => ({ ok: false, error: { code: "gateway/unavailable", message: "Unavailable", details: {} } }));
    await page.goto(server.origin);
    const card = page.locator('[data-dsmm-role-tool="dsmm_role"]');
    try { await card.waitFor({ timeout: 10_000 }); }
    catch (error) {
      console.error(await page.evaluate(() => ({ text: document.body.innerText, slots: window.__dsmmUiContext?.slots.snapshot(), modules: window.__dsmmNativeModules?.entries.state.getSnapshot(), imports: [...(window.__dsmmNativeModules?.loadCache.keys() ?? [])] })), errors);
      throw error;
    }
    assert.equal(await page.locator('[data-chat-call-id="role-call"]').count(), 1);
    assert.equal(await card.getAttribute("data-identity"), "requested");
    assert.equal(await card.getByRole("button", { name: /Builder/u }).count(), 0);
    await page.evaluate(() => window.__roleTool.partial('{"role":"dsmm-builder","prompt":"'));
    await card.getByRole("button", { name: /Builder/u }).waitFor();
    await page.evaluate(() => window.__roleTool.partial(JSON.stringify(window.__roleTool.requested)));
    try { await card.getByRole("button", { name: /Builder/u }).waitFor({ timeout: 5000 }); }
    catch (error) { console.error("partial render", await card.innerText(), errors); throw error; }
    assert.equal(await card.getByRole("button", { name: /Oracle/u }).count(), 0);
    const disclosure = card.getByRole("button", { name: /Builder/u });
    await disclosure.focus(); await disclosure.press("Enter");
    assert.equal(await disclosure.evaluate(element => element.matches(":focus-visible") && parseFloat(getComputedStyle(element).outlineWidth) >= 2), true);
    await card.getByText("Arguments received so far", { exact: true }).waitFor();
    assert.match(await card.innerText(), /keep original input/u);
    await page.evaluate(() => window.__roleTool.start());
    await page.waitForFunction(() => document.querySelector('[data-dsmm-role-tool]')?.getAttribute('data-state') === 'running');
    await card.getByRole("button", { name: "Inspect tool call", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__roleTool.inspectIds()), ["role-call"]);
    await page.evaluate(value => window.__roleTool.result(value), meta);
    await page.waitForFunction(() => document.querySelector('[data-dsmm-role-tool]')?.getAttribute('data-identity') === 'actual');
    assert.equal(await card.getByRole("button", { name: /Reviewer/u }).count(), 1);
    assert.match(await card.innerText(), /complete original output/u); assert.match(await card.innerText(), /non-text-retained/u);
    assert.match(await card.innerText(), /fixture\/model-a/u);
    const evidence = process.env.DSMM_ROLE_TOOL_EVIDENCE_DIR;
    if (evidence) await mkdir(evidence, { recursive: true });
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `reflow ${width}`);
      if (evidence) await page.screenshot({ path: join(evidence, `native-role-tool-${width}.png`), fullPage: true });
    }
    for (const dark of [false, true]) {
      await page.evaluate(async value => {
        document.body.toggleAttribute("data-ds-dark-theme", value);
        const header = document.querySelector('.dsmm-role-heading');
        getComputedStyle(header).color;
        await Promise.all(header.getAnimations().map(animation => animation.finished));
      }, dark);
      const actualDisclosure = card.getByRole("button", { name: /Reviewer/u });
      await actualDisclosure.focus(); await actualDisclosure.press("Tab"); await page.keyboard.press("Shift+Tab");
      await actualDisclosure.press("Space"); await actualDisclosure.press("Space");
      assert.equal(await actualDisclosure.getAttribute("aria-expanded"), "true");
      assert.equal(await actualDisclosure.evaluate(element => element.matches(":focus-visible") && parseFloat(getComputedStyle(element).outlineWidth) >= 2), true);
      const contrast = await card.evaluate(element => {
        const channels = color => color.match(/[\d.]+/gu).map(Number);
        const luminance = color => channels(color).slice(0, 3).map(value => { const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        let ancestor = element, background;
        while (ancestor) { const color = getComputedStyle(ancestor).backgroundColor, rgb = channels(color); if (rgb.length === 3 || rgb[3] === 1) { background = color; break; } ancestor = ancestor.parentElement; }
        if (!background) throw new Error("No opaque native surface");
        const ratio = foreground => { const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
        const codeContrast = [...element.querySelectorAll('pre')].map(pre => {
          let node = pre;
          while (node.firstElementChild) node = node.firstElementChild;
          let surface = pre, color;
          while (surface) { const value = getComputedStyle(surface).backgroundColor, rgb = channels(value); if (rgb.length === 3 || rgb[3] === 1) { color = value; break; } surface = surface.parentElement; }
          const a = luminance(getComputedStyle(node).color), b = luminance(color);
          return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        });
        const focusStyle = getComputedStyle(element.querySelector('[data-disclosure-row]'));
        if (channels(focusStyle.outlineColor).length === 4 && channels(focusStyle.outlineColor)[3] !== 1) throw new Error('Keyboard ring is transparent');
        return { title: ratio(getComputedStyle(element.querySelector('.dsmm-role-title')).color), status: ratio(getComputedStyle(element.querySelector('[role=status]')).color), focus: ratio(focusStyle.outlineColor), code: codeContrast, background };
      });
      assert.ok(contrast.title >= 4.5 && contrast.status >= 4.5 && contrast.focus >= 3 && contrast.code.length === 3 && contrast.code.every(value => value >= 4.5), JSON.stringify(contrast));
      t.diagnostic(`${dark ? "dark" : "light"} native text contrast ${JSON.stringify(contrast)}`);
    }
    await page.evaluate(() => window.__roleTool.locale('zh'));
    await page.waitForFunction(() => document.querySelector('[data-dsmm-role-tool]')?.textContent.includes('实际'));
    await page.setViewportSize({ width: 375, height: 900 }); await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "200% reduced-motion reflow");
    if (evidence) await page.screenshot({ path: join(evidence, "native-role-tool-zh-dark-reduced-zoom200.png"), fullPage: true });
    await page.evaluate(() => { document.documentElement.style.zoom = ""; window.__roleTool.locale('en'); });
    const longOutput = `${"full-output ".repeat(6000)}end-of-complete-output`;
    await page.evaluate(({ value, longOutput }) => window.__roleTool.result(value, { content: [{ type: 'text', text: longOutput }] }), { value: meta, longOutput });
    assert.match(await card.innerText(), /end-of-complete-output/u);
    await page.evaluate(value => window.__roleTool.result(value), meta);
    await page.evaluate(() => window.__roleTool.replay());
    await page.locator('[data-chat-call-id="replayed-call"]').waitFor();
    assert.equal(await card.getAttribute("data-identity"), "actual");
    for (const [invalid, options, expected] of [[meta, { isError: true, error: { name: "Error", code: "failed", reason: "original failure" } }, "error"], [undefined, {}, "result"], [{ ...meta, label: "x".repeat(121) }, {}, "result"], [meta, { isError: true, error: { name: "AbortError", code: "interrupted", reason: "original interrupt" } }, "stopped"]]) {
      await page.evaluate(({ value, options }) => window.__roleTool.result(value, options), { value: invalid, options });
      await page.waitForFunction(expected => document.querySelector('[data-dsmm-role-tool]')?.getAttribute('data-state') === expected, expected);
      assert.equal(await card.getAttribute("data-identity"), "requested");
      assert.equal(await card.getByRole("button", { name: /Builder/u }).count(), 1);
      if (options.error) {
        if (await card.getByText("Error details", { exact: true }).count() === 0) await card.getByRole("button", { name: /Builder/u }).click();
        assert.match(await card.innerText(), new RegExp(options.error.reason, 'u'));
      }
    }
    await page.evaluate(value => window.__roleTool.result({ ...value, jobId: "owned-job" }), meta);
    assert.match(await card.innerText(), /child completion not confirmed/u);
    await page.evaluate(() => { window.__roleTool.partial('{"category":"dsmm-creative","description":"claims planner"}'); window.__roleTool.result({ role:'dsmm-creative',label:'creative',level:'normal',routeSource:'inherited',mode:'continuable',childId:'owned-child' },{name:'dsmm_category'}); });
    await page.locator('[data-dsmm-role-tool="dsmm_category"]').waitFor();
    assert.equal(await page.locator('[data-dsmm-role-tool]').getByRole("button", { name: /Creative/u }).count(), 1);
    await page.evaluate(() => { window.__roleTool.partial('{"category":"dsmm-coding"}'); window.__roleTool.result({ role:'dsmm-coding',label:'coding',level:'normal',routeSource:'inherited',mode:'one-shot' },{name:'dsmm_category'}); });
    const coding = page.locator('[data-dsmm-role-tool="dsmm_category"]').getByRole("button", { name: "Call Coding · normal", exact: true });
    await coding.waitFor();
    if (await coding.getAttribute("aria-expanded") === "true") await coding.click();
    assert.equal(await coding.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator('[data-dsmm-role-tool="dsmm_category"]').getAttribute("data-identity"), "actual");
    if (evidence) await page.screenshot({ path: join(evidence, "native-role-tool-coding-collapsed.png"), fullPage: true });
    // The real native tree still renders subcalls; each atom receives its own identity.
    await page.evaluate(value => window.__roleTool.result(value, { subCalls:[{phase:'start',name:'dsmm_planner',callId:'owned-subcall',parentCallId:'role-call',argsRaw:'{}',subCalls:[]}] }), meta);
    await page.locator('[data-subcalls] [data-dsmm-role-tool="dsmm_planner"]').waitFor();
    assert.equal(await page.locator('[data-chat-call-id="owned-subcall"] [data-dsmm-role-tool="dsmm_planner"]').getAttribute("data-identity"), "requested");
    await page.locator('[data-chat-call-id="owned-subcall"]').getByRole("button", { name: "Call Planner", exact: true }).waitFor();
    if (evidence) await page.screenshot({ path: join(evidence, "native-role-tool-ptc-subcall.png"), fullPage: true });
    await page.evaluate(value => window.__roleTool.result(value, { isError: true, error: { name:'AutoReviewDeniedError',code:'AUTO_REVIEW_DENIED',reason:'owned native denial' } }), meta);
    await page.waitForFunction(() => !document.querySelector('[data-dsmm-role-tool]'));
    assert.equal(await page.locator('[data-chat-call-id="role-call"]').count(), 1, "native auto-review denial bypasses the adapter");
    await page.evaluate(value => window.__roleTool.result(value, { noCall: true }), meta);
    await page.waitForFunction(() => !document.querySelector('[data-dsmm-role-tool]'));
    assert.equal(await page.locator('[data-chat-call-id="role-call"]').count(), 1, "windowless call uses native fallback");
    assert.deepEqual(errors, []);
    t.diagnostic("Real SDK ToolCallTree + native Slot renderer: pending/start/result/replay, full content, inspect, keyboard disclosure, error/interruption, background, category, subcalls and windowless native fallback passed at 375/768/1280.");
    await context.close();
  } finally {
    await browser?.close(); await server?.close();
    if (await realpath(owned) !== owned || dirname(owned) !== temporaryParent || !basename(owned).startsWith("dsmm-role-native-")) throw new Error("Unexpected role fixture cleanup path");
    await rm(owned, { recursive: true });
  }
});
