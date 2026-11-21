import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { bootstrapFacade, carrierBootstrap, COMPOSITION_ID, createBootGraph } from "../scripts/profile-ui-harness-browser.mjs";
import { THEME_CLIENT_IDS } from "../scripts/profile-ui-harness-server.mjs";

const available = process.env.DSMM_TEST_DSH_ENTRY && process.env.DSMM_TEST_PLAYWRIGHT_ENTRY;
const nativeIds = ["@deepseek-ai/dsh-client-modules", "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-typert-registry", "@deepseek-ai/dsh-api-gateway", "@deepseek-ai/dsh-client-ui-tool", "@deepseek-ai/dsh-client-file-upload", "@deepseek-ai/dsh-api-session-controller", ...THEME_CLIENT_IDS];

// The installed ToolCallTree and Slot renderer are unchanged; the composition
// supplies the session, projection, and workspace navigation boundaries.
const composition = `window.__ModuleLoader__.load({id:${JSON.stringify(COMPOSITION_ID)},factory(require){
  const React=require('react');
  const {installConnection}=require('@deepseek-ai/dsh-client-connection/client');
  const {LocaleRuntime}=require('@deepseek-ai/dsh-client-locale/client');
  const {PartialArguments}=require('dsmm-test-arguments');
  const en={'detail.field.task':'Task','row.inspect':'Inspect'},zh={'detail.field.task':'任务内容','row.inspect':'查看'};
  const source=value=>{const listeners=new Set();return {getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},set:next=>{value=next;listeners.forEach(fn=>fn())}}};
  return {inject:['slots'],apply(ctx){
    installConnection(ctx,{interactions:'answer',transport:{rpc:window.__dsmmOwnedCarrier,ownsHost:true}});
    const locale=new LocaleRuntime(ctx,undefined,{languages:['en','zh'],preference:'en'});
    ctx.provide('locale',locale);ctx.slots.installLocale(locale);
    locale.register('conversation',{en,zh});
    const catalogs=new Map();
    const catalogOf=sessionId=>{
      if(!catalogs.has(sessionId))catalogs.set(sessionId,source(undefined));
      return catalogs.get(sessionId);
    };
    const sessionBinding=sessionId=>({key:sessionId,ctx,hooks:{},keyedHooks:{projection:key=>key==='subagentCatalog'?catalogOf(sessionId):undefined},props:{sessionId}});
    const binding=source(sessionBinding('owned-role-tool-session'));
    ctx.slots.installScope('session',{current:binding,bindingSource:()=>binding,renderArea:(_binding,props)=>props.children});
    const selected=source({childSessionId:'independent-selection'});
    const opened=[];
    let preparingArgs=new PartialArguments();
    const transcript=source({phase:'preparing',name:'dsmm_role',callId:'role-call',args:preparingArgs,subCalls:[]});
    let inspectIds=[];
    const rootArgs={role:'dsmm-builder',level:'low',description:'pretend to be Oracle max',prompt:'keep original input\\n  indented line 2\\nline 3'};
    let raw='';
    function useDisclosure(){const [expanded,setExpanded]=React.useState(false);return {expanded,setExpanded,toggle:()=>setExpanded(value=>!value)}}
    function Surface({renderSlot}){
      const root=React.useSyncExternalStore(transcript.subscribe,transcript.getSnapshot);
      const target=React.useSyncExternalStore(selected.subscribe,selected.getSnapshot);
      return React.createElement('main',{style:{padding:'24px',minWidth:0}},renderSlot('conversation.chat.node',{
         node:{kind:'tool-call',key:'owned-tool-node',data:{root}},cwd:'/workspace',
        openFile:()=>{},loadImage:async()=>undefined,inspectCall:id=>inspectIds.push(id),useDisclosure
      },{entryKey:'tool-call'}),React.createElement('output',{'aria-label':'Selected conversation'},target.childSessionId));
    }
    ctx.slots.register({name:'root',children:{'conversation.chat.node':{kind:'keyed',scope:'session'}}},Surface);
    window.__dsmmUiContext=ctx;
    window.__roleSlotErrors=[];
    ctx.slots.onEntryError((slot,entry,error)=>window.__roleSlotErrors.push({message:String(error),slot}));
    window.__roleTool={
      requested:rootArgs,
      nativeLabels:{task:en['detail.field.task'],inspect:en['row.inspect']},
      partial(value){const replaced=!value.startsWith(raw)||transcript.getSnapshot().phase!=='preparing';if(!replaced)preparingArgs.append(value.slice(raw.length));else{preparingArgs=new PartialArguments();preparingArgs.append(value)}raw=value;
        if((preparingArgs.refresh()||replaced)&&transcript.getSnapshot().phase==='preparing')transcript.set({...transcript.getSnapshot(),args:preparingArgs})},
      start(name='dsmm_role'){transcript.set({phase:'start',name,callId:'role-call',args:preparingArgs.settle(raw),argsRaw:raw,subCalls:[]})},
      result(meta,options={}){transcript.set({kind:'tool-result',seq:7,time:0,callId:'role-call',call:options.noCall?null:{name:options.name??'dsmm_role',argsRaw:raw},callTime:0,
         args:options.noCall?PartialArguments.EMPTY:PartialArguments.fromText(raw),content:options.content??[{type:'text',text:'complete original output'},{type:'image',data:'non-text-retained',mimeType:'image/png'}],isError:options.isError??false,
         ...(options.error?{error:options.error}:{}),meta,subCalls:(options.subCalls??[]).map(call=>({...call,args:PartialArguments.fromText(call.argsRaw)}))})},
      replay(){const current=transcript.getSnapshot();transcript.set({...JSON.parse(JSON.stringify(current)),args:PartialArguments.fromText(current.call?.argsRaw??''),callId:'replayed-call'})},
      inspectIds:()=>inspectIds,
      locale(value){locale.setLocale(value)},
      slots:()=>ctx.slots.snapshot(),
      session(sessionId){binding.set(sessionBinding(sessionId))},
      catalog(sessionId,rows){catalogOf(sessionId).set(rows)},
      enableNavigation(){ctx.provide('uiWorkspace',{openSession(target){opened.push(target);selected.set(target)}})},
      opened:()=>opened,
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
  const presentationIds = [...nativeIds];
  const contextMenuId = '@deepseek-ai/dsh-client-ui-context-menu';
  try { sdk.resolve(`${contextMenuId}/package.json`); presentationIds.push(contextMenuId); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  for (const [i, id] of presentationIds.entries()) {
    const url = `/bundles/native-${i}.js`;
    const manifestPath = sdk.resolve(`${id}/package.json`), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const clientEntry = manifest.exports['./client'];
    bundles.set(url, await readFile(resolve(dirname(manifestPath), clientEntry.browser ?? clientEntry.default)));
    rows.push({ id, url, inject: id === contextMenuId ? [COMPOSITION_ID, '@deepseek-ai/dsh-client-shortcuts'] : THEME_CLIENT_IDS.includes(id) || id.endsWith('dsh-client-file-upload') || id.endsWith('dsh-api-session-controller') ? manifest.dsh.client.inject : id.endsWith("dsh-api-gateway") ? ["@deepseek-ai/dsh-typert-registry", COMPOSITION_ID] : id.endsWith("dsh-client-ui-tool") ? ["@deepseek-ai/dsh-api-gateway", COMPOSITION_ID, ...(presentationIds.includes(contextMenuId) ? [contextMenuId] : [])] : [] });
  }
  bundles.set("/bundles/composition.js", Buffer.from(composition));
  rows.push({ id: COMPOSITION_ID, url: "/bundles/composition.js", inject: ["@deepseek-ai/dsh-client-ui-renderer", "dsmm-test-arguments"], external: ["@deepseek-ai/dsh-client-connection/client", "@deepseek-ai/dsh-client-locale/client"] });
  bundles.set("/bundles/adapter.js", Buffer.from(bundle));
  rows.push({ id: "@dsmm/dsmm", url: "/bundles/adapter.js", inject: ["@deepseek-ai/dsh-client-ui-tool", COMPOSITION_ID], external: ["@deepseek-ai/dsh-api-gateway/client"] });
  const graph = createBootGraph(rows, "role-tool-owned-source");
  const bootstrap = `${bootstrapFacade()}
    const createModules=window.__ModuleLoader__.create;
    window.__ModuleLoader__.create=function(options){
      const system=createModules.call(this,options);
      system.manifest={...system.manifest,plugins:system.manifest.plugins.filter(row=>row.id!=='dsmm-test-arguments')};
      return system;
    };`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native role ToolCall acceptance</title>${files.filter(file => /^(index|vendor)-.*\.css$/u.test(file)).map(file => `<link rel="stylesheet" href="/native/assets/${file}">`).join("")}<script>${bootstrap}${carrierBootstrap()}window.__DSH_BOOT__=${JSON.stringify(graph)};</script>${rows.map(row => `<script src="${row.url}"></script>`).join("")}</head><body><div id="root"></div><script type="module" src="/native/assets/${index}"></script></body></html>`;
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
  let browser, server, nativeBackend, releaseChild;
  const nativeStreams = new Map(), nativeRequests = [];
  try {
    await cp(fileURLToPath(new URL("../src/", import.meta.url)), join(owned, "src"), { recursive: true });
    const output = await build({ stdin: { contents: `
      import {registerRoleToolViews} from './RoleToolView.tsx';
      import {RoleCallObservationController} from './role-call-observations.ts';
      import {ROLE_CONTROL_REMOTE} from '../role-control-remote.ts';
      export const inject=['slots','locale','remote'];
      export function apply(ctx){
        const controller=new RoleCallObservationController();
        registerRoleToolViews(ctx,controller);
        let healthy=true,calls=[],opens=0,nativeScope;
        const pending=new Set();
        let unbind=controller.bindConnection(ctx.remote,async function*(sessionId,signal){
          opens++;
          if(!healthy)throw new Error('fixture transport unavailable');
          yield {type:'snapshot',sessionId,admissionEpoch:'a'.repeat(64),calls};
          while(!signal.aborted){
            const event=await new Promise(resolve=>{
              const abort=()=>{pending.delete(deliver);resolve(undefined)};
              const deliver=event=>{signal.removeEventListener('abort',abort);pending.delete(deliver);resolve(event)};
              pending.add(deliver);signal.addEventListener('abort',abort,{once:true});
              if(signal.aborted)abort();
            });
            if(event===undefined)return;
            if(event instanceof Error)throw event;
            yield event;
          }
        });
        window.__roleObservation={
          opens:()=>opens,
          snapshot(sessionId){const value=controller.source(sessionId).getSnapshot();return {...value,calls:[...value.calls]}},
          async native(){unbind();await ctx.remote.$mount(ROLE_CONTROL_REMOTE);await new Promise(resolve=>ctx.inject(['remote.dsmmChildren'],scope=>{nativeScope=scope;resolve()}));this.reconnect()},
          disconnect(){unbind()},
          reconnect(){unbind=controller.bindConnection(nativeScope.remote,(sessionId,signal)=>nativeScope.remote.dsmmChildren.observe(sessionId,signal))},
          update(call){calls=calls.filter(row=>row.callId!==call.callId).concat(call);for(const deliver of [...pending])deliver({type:'update',sessionId:'owned-role-tool-session',admissionEpoch:'a'.repeat(64),call})},
          fail(){healthy=false;for(const fail of [...pending])fail(new Error('private fixture diagnostic'))},
          recover(next=[]){healthy=true;calls=next;controller.observeSessionAvailability('owned-role-tool-session',true)}
        };
        ctx.effect(()=>()=>{unbind();controller.dispose();delete window.__roleObservation});
      }
    `, loader: "tsx", resolveDir: join(owned, "src/client") }, bundle: true, write: false, platform: "browser", format: "cjs", target: "es2022", jsx: "automatic", external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-api-gateway/client"],
      nodePaths,
      banner: { js: 'window.__ModuleLoader__.load({id:"@dsmm/dsmm",factory:(require)=>{const module={exports:{}};const exports=module.exports;' }, footer: { js: "return module.exports;}});" } });
    // Bundle the browser-safe helper separately to exercise its real shared schema.
    const dataOutput = await build({ entryPoints: [join(owned, "src/client/RoleToolView-data.ts")], bundle: true, write: false, platform: "browser", format: "esm", nodePaths });
    await writeFile(join(owned, "data.mjs"), dataOutput.outputFiles[0].text, "utf8");
    const data = await import(pathToFileURL(join(owned, "data.mjs")).href);
    const argumentsBundle = await build({ stdin: { contents: `export {PartialArguments} from ${JSON.stringify(sdk.resolve('@deepseek-ai/dsh-util-values'))};`, loader:'ts', resolveDir:owned }, bundle: true, write: false, platform: 'browser', format: 'cjs', target: 'es2022',
      banner: { js: 'window.__ModuleLoader__.load({id:"dsmm-test-arguments",factory:(require)=>{const module={exports:{}};const exports=module.exports;' }, footer: { js: 'return module.exports;}});' } });
    const meta = { role: "dsmm-reviewer", label: "real invocation", level: "high", routeSource: "primary", mode: "one-shot", childId: "review-child", route: { provider: "fixture", model: "model-a", reasoningEffort: "exact" } };
    assert.equal(data.actualRoleTool("dsmm_role", meta, false)?.role, "dsmm-reviewer");
    for (const invalid of [{ ...meta, label: "x".repeat(121) }, { invocation: meta }, { ...meta, level: "invalid" }, { ...meta, role: "dsmm-orchestrator" }]) assert.equal(data.actualRoleTool("dsmm_role", invalid, false), undefined);
    assert.equal(data.actualRoleTool("dsmm_role", meta, true), undefined);
    assert.equal(data.requestedRoleTool("dsmm_role", '{"role":"dsmm-oracle"').target, undefined);
    assert.equal(data.requestedRoleTool("dsmm_category", '{"category":"dsmm-creative"}').target, "dsmm-creative");
    for (const [key, role] of Object.entries(data.roleToolKeys)) assert.equal(data.requestedRoleTool(key, "bad").target, role);
    server = await serve(sdk, output.outputFiles[0].text, argumentsBundle.outputFiles[0].text);
    browser = await chromium.launch({ executablePath: process.env.DSMM_TEST_BROWSER_EXECUTABLE ?? process.env.DSMM_BROWSER_EXECUTABLE ?? chromium.executablePath(), headless: true, args: ["--disable-extensions", "--disable-sync"] });
    const context = await browser.newContext({ viewport: { width: 375, height: 900 }, serviceWorkers: "block" });
    assert.deepEqual(await context.cookies(), []);
    await context.route("**/*", route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.exposeBinding("__dsmmNativeBridge", async (_source, request) => {
      if (nativeBackend !== undefined && request.operation === 'open') nativeRequests.push({endpoint:request.endpoint,payload:request.payload});
      if (request.operation === 'cancel') {
        const stream = nativeStreams.get(request.id);
        if (stream !== undefined) { stream.abort.abort(); await stream.iterator.return?.(); nativeStreams.delete(request.id); }
        return {ok:true};
      }
      if (request.operation === 'next') {
        const stream = nativeStreams.get(request.id);
        return {ok:true,value:stream === undefined ? {done:true} : await stream.iterator.next()};
      }
      if (nativeBackend !== undefined && request.operation === 'open' && request.channel === '/api') {
        const abort = new AbortController();
        try {
          const iterable = await nativeBackend.ctx.typertGateway.wireStream.open(request.endpoint,request.payload,(async function*(){})(),
            nativeBackend.ctx.connection.browserPeer,abort.signal);
          nativeStreams.set(request.id,{abort,iterator:iterable[Symbol.asyncIterator]()});
          return {ok:true};
        } catch(error) { return {ok:false,error:nativeBackend.ctx.typertGateway.wireStream.failure(error)}; }
      }
      return { ok: false, error: { code: "gateway/unavailable", message: "Unavailable", details: {} } };
    });
    await page.goto(server.origin);
    await page.waitForFunction(()=>window.__roleObservation !== undefined && window.__roleTool !== undefined);
    const evidence = process.env.DSMM_ROLE_TOOL_EVIDENCE_DIR;
    if(evidence)await mkdir(evidence,{recursive:true});
    const card = page.locator('[data-dsmm-role-tool="dsmm_role"]');
    const navigationButton = card => card.getByRole('button', {name:'Open child conversation',exact:true});
    const navigate = async (card, childSessionId, mode, parentSessionId = 'owned-role-tool-session', keyboard = false) => {
      const button = navigationButton(card);
      const before = await page.evaluate(() => window.__roleTool.opened().length);
      if (keyboard) { await button.focus(); await page.keyboard.press('Enter'); }
      else await button.click();
      assert.equal(await page.getByLabel('Selected conversation').innerText(), childSessionId);
      const opened = await page.evaluate(() => window.__roleTool.opened());
      assert.deepEqual(opened.slice(before), [{parentSessionId, childSessionId, mode}]);
    };
    try { await card.waitFor({ timeout: 10_000 }); }
    catch (error) {
      console.error(await page.evaluate(() => ({ text: document.body.innerText, slots: JSON.stringify(window.__dsmmUiContext?.slots.snapshot()), slotErrors: window.__roleSlotErrors, modules: window.__dsmmNativeModules?.entries.state.getSnapshot(), imports: [...(window.__dsmmNativeModules?.loadCache.keys() ?? [])] })), errors);
      throw error;
    }
    assert.equal(await page.locator('[data-chat-call-id="role-call"]').count(), 1);
    assert.equal(await card.getAttribute("data-identity"), "requested");
    assert.equal(await card.getByRole("button", { name: /Builder/u }).count(), 0);
    await page.evaluate(() => window.__roleTool.partial('{"role":"dsmm-builder","prompt":"'));
    await card.getByRole("button", { name: "Calling Builder", exact: true }).waitFor();
    await page.evaluate(() => window.__roleTool.partial(JSON.stringify(window.__roleTool.requested)));
    try { await card.getByRole("button", { name: /Calling Builder[\s\S]*pretend to be Oracle max/u }).waitFor({ timeout: 5000 }); }
    catch (error) { console.error("partial render", await card.innerText(), errors); throw error; }
    const disclosure = card.getByRole("button", { name: /Calling Builder[\s\S]*pretend to be Oracle max/u });
    assert.equal(await card.locator('.dsmm-role-icon').count(), 1);
    await disclosure.focus(); await disclosure.press("Enter");
    assert.equal(await disclosure.evaluate(element => element.matches(":focus-visible") && parseFloat(getComputedStyle(element).outlineWidth) >= 2), true);
    await card.locator('.dsmm-role-task').waitFor();
    await card.getByText("Technical details", { exact: true }).click();
    await card.getByRole("table").waitFor();
    assert.match(await card.innerText(), /keep original input/u);
    const promptCell = card.locator('.dsmm-role-table tr', { hasText: 'args.prompt' }).locator('.dsmm-role-val-cell');
    assert.equal(await promptCell.evaluate(el => getComputedStyle(el.querySelector('.dsmm-role-cell-text') || el).whiteSpace), 'pre-wrap');
    assert.ok((await promptCell.innerText()).includes('indented line 2'));
    await page.evaluate(() => window.__roleTool.start());
    await page.waitForFunction(() => document.querySelector('[data-dsmm-role-tool]')?.getAttribute('data-state') === 'running');
    await card.locator('[data-observation-status="live"]').waitFor();
    await page.evaluate(() => window.__roleObservation.fail());
    await card.locator('[data-observation-status="unavailable"]').waitFor();
    assert.equal(await card.getAttribute('data-state'), 'running');
    assert.match(await card.innerText(), /transport\/internal/u);
    assert.doesNotMatch(await card.innerText(), /private fixture diagnostic/u);
    await page.evaluate(() => window.__roleObservation.recover());
    await card.locator('[data-observation-status="live"]').waitFor();
    assert.doesNotMatch(await card.innerText(), /transport\/internal/u);
    assert.equal(await page.evaluate(() => window.__roleObservation.opens()), 2);
    assert.equal(await card.getByRole("button", { name: /Call Builder[\s\S]*pretend to be Oracle max/u }).count(), 1);
    assert.equal(await navigationButton(card).count(), 0);
    await page.evaluate(value => window.__roleTool.result(value), meta);
    await page.waitForFunction(() => document.querySelector('[data-dsmm-role-tool]')?.getAttribute('data-identity') === 'actual');
    assert.equal(await navigationButton(card).count(), 0, 'a confirmed child cannot navigate before the service is available');
    await page.evaluate(() => window.__roleTool.enableNavigation());
    await navigationButton(card).waitFor();
    await navigate(card, 'review-child', 'one-shot', 'owned-role-tool-session', true);
    assert.equal(await card.getByRole("button", { name: /Call Reviewer[\s\S]*pretend to be Oracle max/u }).count(), 1);
    await card.getByRole("table").waitFor();
    assert.match(await card.innerText(), /primary/u);
    assert.match(await card.innerText(), /fixture\/model-a/u);
    const tableTab = card.getByRole("tab", { name: "Table" });
    const jsonTab = card.getByRole("tab", { name: "JSON" });
    const tableTabId = await tableTab.getAttribute("id");
    const jsonTabId = await jsonTab.getAttribute("id");
    const tableControls = await tableTab.getAttribute("aria-controls");
    const jsonControls = await jsonTab.getAttribute("aria-controls");
    assert.ok(tableControls && jsonControls, "both tabs have aria-controls");
    const tablePanel = card.locator(`#${tableControls}`);
    const jsonPanel = card.locator(`#${jsonControls}`);
    assert.equal(await tablePanel.count(), 1, "table panel IDREF exists");
    assert.equal(await jsonPanel.count(), 1, "json panel IDREF exists");
    assert.equal(await tablePanel.getAttribute("aria-labelledby"), tableTabId);
    assert.equal(await jsonPanel.getAttribute("aria-labelledby"), jsonTabId);
    assert.equal(await tablePanel.getAttribute("hidden"), null, "table panel visible by default");
    assert.equal(await jsonPanel.getAttribute("hidden"), "", "json panel hidden by default");

    // Test tab keyboard navigation
    await jsonTab.focus();
    await page.keyboard.press("Enter");
    assert.equal(await jsonTab.getAttribute("aria-selected"), "true");
    assert.equal(await jsonPanel.getAttribute("hidden"), null, "json panel visible after Enter");
    assert.equal(await tablePanel.getAttribute("hidden"), "", "table panel hidden after switching to json");
    assert.equal(await card.getByRole("table").count(), 0);
    assert.match(await card.innerText(), /"routeSource":\s*"primary"/u);
    if (evidence) {
      await page.evaluate(async () => {
        document.body.setAttribute("data-ds-dark-theme", "");
        await Promise.all(document.getAnimations().map(a => a.finished));
      });
      await page.waitForTimeout(150);
      await page.screenshot({ path: join(evidence, "json-mode-dark.png"), fullPage: true });
      await page.evaluate(async () => {
        document.body.removeAttribute("data-ds-dark-theme");
        await Promise.all(document.getAnimations().map(a => a.finished));
      });
      await page.waitForTimeout(150);
    }
    await tableTab.focus();
    await page.keyboard.press("Space");
    assert.equal(await tableTab.getAttribute("aria-selected"), "true");
    assert.equal(await tablePanel.getAttribute("hidden"), null, "table panel visible after Space");
    assert.equal(await jsonPanel.getAttribute("hidden"), "", "json panel hidden after switching to table");
    await card.getByRole("table").waitFor();
    if (evidence) {
      await page.screenshot({ path: join(evidence, "table-mode-light.png"), fullPage: true });
    }
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
        const ratio = (foreground, bg = background) => { const a = luminance(foreground), b = luminance(bg); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
        const resolveOpaqueBg = el => {
          let cur = el;
          while (cur) {
            const bg = getComputedStyle(cur).backgroundColor;
            const ch = channels(bg);
            if (ch.length === 3 || (ch.length === 4 && ch[3] === 1)) return bg;
            cur = cur.parentElement;
          }
          return background;
        };
        const titleColor = getComputedStyle(element.querySelector('.dsmm-role-title')).color;
        const tabSelected = element.querySelector('[role="tab"][aria-selected="true"]');
        const tabUnselected = element.querySelector('[role="tab"][aria-selected="false"]');
        const indicator = element.querySelector('._indicator_d62eq_22, [class*="indicator"]');
        const tabSelectedBg = indicator ? resolveOpaqueBg(indicator) : background;
        const tabUnselectedBg = tabUnselected ? resolveOpaqueBg(tabUnselected) : background;
        const tabSelectedRatio = tabSelected ? ratio(getComputedStyle(tabSelected).color, tabSelectedBg) : 21;
        const tabUnselectedRatio = tabUnselected ? ratio(getComputedStyle(tabUnselected).color, tabUnselectedBg) : 21;
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
        return {
          title: ratio(titleColor),
          tabSelected: tabSelectedRatio,
          tabUnselected: tabUnselectedRatio,
          status: ratio(getComputedStyle(element.querySelector('[role=status]')).color),
          focus: ratio(focusStyle.outlineColor),
          code: codeContrast,
          background
        };
      });
      assert.ok(
        contrast.title >= 4.5 &&
        contrast.tabSelected >= 4.5 &&
        contrast.tabUnselected >= 4.5 &&
        contrast.status >= 4.5 &&
        contrast.focus >= 3 &&
        contrast.code.length >= 1 &&
        contrast.code.every(value => value >= 4.5),
        JSON.stringify(contrast)
      );
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
    assert.equal((await card.innerText()).includes("end-of-complete-output"), false);
    await page.evaluate(value => window.__roleTool.result(value), meta);
    await page.evaluate(() => window.__roleTool.replay());
    await page.locator('[data-chat-call-id="replayed-call"]').waitFor();
    assert.equal(await card.getAttribute("data-identity"), "actual");
    await navigate(card, 'review-child', 'one-shot');
    for (const [invalid, options, expected] of [[meta, { isError: true, error: { name: "Error", code: "failed", reason: "original failure" } }, "error"], [undefined, {}, "result"], [{ ...meta, label: "x".repeat(121) }, {}, "result"], [meta, { isError: true, error: { name: "AbortError", code: "interrupted", reason: "original interrupt" } }, "stopped"]]) {
      await page.evaluate(({ value, options }) => window.__roleTool.result(value, options), { value: invalid, options });
      await page.waitForFunction(expected => document.querySelector('[data-dsmm-role-tool]')?.getAttribute('data-state') === expected, expected);
      assert.equal(await card.getAttribute("data-identity"), "requested");
      assert.equal(await navigationButton(card).count(), 0);
      assert.equal(await card.getByRole("button", { name: /Builder/u }).count(), 1);
      if (options.error) {
        if (await card.getByText("Error details", { exact: true }).count() === 0) await card.getByRole("button", { name: /Builder/u }).click();
        assert.match(await card.innerText(), new RegExp(options.error.reason, 'u'));
        if (evidence && options.error.code === "failed") {
          await page.screenshot({ path: join(evidence, "error-state.png"), fullPage: true });
        }
      }
    }
    await page.evaluate(value => window.__roleTool.result({ ...value, mode: "continuable", delivery: "parent", phase: "active" }), meta);
    assert.equal(await card.getAttribute("data-state"), "background");
    assert.match(await card.innerText(), /Background/u);
    await page.evaluate(() => { window.__roleTool.partial('{"category":"dsmm-creative","description":"claims planner"}'); window.__roleTool.result({ role:'dsmm-creative',label:'creative',level:'normal',routeSource:'inherited',mode:'continuable',childId:'owned-child' },{name:'dsmm_category'}); });
    const categoryCard = page.locator('[data-dsmm-role-tool="dsmm_category"]');
    await categoryCard.waitFor();
    await navigate(categoryCard, 'owned-child', 'continuable');
    assert.equal(await categoryCard.getByRole("button", { name: /Creative/u }).count(), 1);
    await page.evaluate(() => { window.__roleTool.partial('{"category":"dsmm-coding"}'); window.__roleTool.result({ role:'dsmm-coding',label:'coding',level:'normal',routeSource:'inherited',mode:'one-shot' },{name:'dsmm_category'}); });
    const coding = page.locator('[data-dsmm-role-tool="dsmm_category"]').getByRole("button", { name: "Call Coding", exact: true });
    await coding.waitFor();
    if (await coding.getAttribute("aria-expanded") === "true") await coding.click();
    assert.equal(await coding.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator('[data-dsmm-role-tool="dsmm_category"]').getAttribute("data-identity"), "actual");
    await page.setViewportSize({ width: 1280, height: 900 });
    if (evidence) {
      await page.screenshot({ path: join(evidence, "native-role-tool-coding-collapsed.png"), fullPage: true });
      await page.screenshot({ path: join(evidence, "native-role-tool-1280-collapsed.png"), fullPage: true });
    }
    // The real native tree still renders subcalls; each atom receives its own identity.
    await page.evaluate(value => window.__roleTool.result(value, { subCalls:[{phase:'start',name:'dsmm_planner',callId:'owned-subcall',parentCallId:'role-call',argsRaw:'{}',subCalls:[]}] }), meta);
    await page.locator('[data-subcalls] [data-dsmm-role-tool="dsmm_planner"]').waitFor();
    assert.equal(await page.locator('[data-chat-call-id="owned-subcall"] [data-dsmm-role-tool="dsmm_planner"]').getAttribute("data-identity"), "requested");
    await page.locator('[data-chat-call-id="owned-subcall"]').getByRole("button", { name: "Call Planner", exact: true }).waitFor();
    if (evidence) await page.screenshot({ path: join(evidence, "native-role-tool-ptc-subcall.png"), fullPage: true });
    const nativeLabels = await page.evaluate(() => window.__roleTool.nativeLabels);
    for (const toolName of ['subagent', 'subagent_fork']) {
      await page.evaluate(name => { window.__roleTool.catalog('owned-role-tool-session', undefined); window.__roleTool.partial(JSON.stringify({description:'ordinary native task',prompt:'native original prompt',role:'dsmm-oracle',level:'max'})); window.__roleTool.start(name); }, toolName);
      assert.equal(await page.locator('[data-dsmm-native-tool]').count(), 0, 'before an exact receipt only the native presentation renders');
      const nativeRow = page.locator('[data-chat-call-id="role-call"]');
      assert.ok((await nativeRow.innerText()).length > 0);
      await page.evaluate(name => window.__roleTool.result({kind:'activation',name:'native-worker'}, {name,content:[{type:'text',text:'started subagent native-worker\ncomplete native output retained'}]}), toolName);
      const nativeCard = page.locator(`[data-dsmm-native-tool="${toolName}"]`);
      await nativeCard.waitFor();
      assert.equal(await nativeCard.getAttribute('data-state'), 'accepted');
      const originalToggle = nativeRow.getByRole('button').first();
      if (await originalToggle.getAttribute('aria-expanded') !== 'true') await originalToggle.click();
      const nativeTask = nativeRow.getByText(nativeLabels.task, {exact:true});
      if (await nativeTask.count()) await nativeTask.click();
      assert.match(await nativeRow.innerText(), /native original prompt/u);
      const inspectedBefore = await page.evaluate(() => window.__roleTool.inspectIds().length);
      await nativeRow.getByRole('button', {name:nativeLabels.inspect,exact:true}).click();
      assert.equal(await page.evaluate(() => window.__roleTool.inspectIds().length), inspectedBefore+1);
      const toggle = nativeCard.getByRole('button', {name:'Native agent · native-worker', exact:true});
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      assert.match(await nativeCard.innerText(), /Actual: unknown/u);
      assert.doesNotMatch(await nativeCard.innerText(), /Oracle|max|normal/u, 'ordinary calls never acquire requested DSMM identity');
      const observation = {kind:'native',toolName,nativeName:'native-worker',provider:'in-process',parentSessionId:'owned-role-tool-session',parentAdmissionEpoch:'a'.repeat(64),
        callId:'role-call',rootCallId:'role-call',childId:'native-child',runId:'native-run',phase:'active',delivery:'parent',
        initialRoute:{status:'unknown',reason:'missing-invocation-capture'},actualRoute:{status:'known',source:'own-native-request-header',route:{provider:'fixture',model:'native-model'}}};
      await page.evaluate(call => window.__roleObservation.update(call), observation);
      await page.waitForFunction(() => document.querySelector('[data-dsmm-native-tool]')?.getAttribute('data-state') === 'running');
      assert.match(await nativeCard.innerText(), /fixture\/native-model · effort not reported/u);
      assert.match(await nativeCard.innerText(), /native-child/u);
      assert.equal(await navigationButton(nativeRow).count(), 0, 'the observation alone does not prove a local native child');
      await page.evaluate(() => window.__roleTool.catalog('owned-role-tool-session', [{id:'native-child',mode:'external'}]));
      assert.equal(await navigationButton(nativeRow).count(), 0);
      await page.evaluate(() => window.__roleTool.catalog('owned-role-tool-session', [{id:'native-child',mode:'unknown'}]));
      await navigate(nativeRow, 'native-child', 'unknown');
      for (const width of [375,768,1280]) {
        await page.setViewportSize({width,height:900});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `native ${toolName} reflow ${width}`);
        if(evidence)await page.screenshot({path:join(evidence,`native-${toolName}-${width}.png`),fullPage:true});
      }
      await toggle.focus(); await toggle.press('Tab'); await page.keyboard.press('Shift+Tab');
      assert.equal(await toggle.evaluate(el=>el.matches(':focus-visible') && parseFloat(getComputedStyle(el).outlineWidth)>=2),true);
      await page.evaluate(() => window.__roleObservation.fail());
      await nativeCard.locator('[data-observation-status="unavailable"]').waitFor();
      assert.equal(await nativeCard.getAttribute('data-state'),'accepted');
      assert.doesNotMatch(await nativeCard.innerText(), /fixture\/native-model/u);
      await page.evaluate(call => window.__roleObservation.recover([call]), observation);
      await nativeCard.locator('[data-observation-status="live"]').waitFor();
      for(const [stopReason,state] of [['completed','completed'],['error','error'],['aborted','stopped']]) {
        await page.evaluate(call=>window.__roleObservation.update(call), {...observation,phase:'settled',stopReason});
        await page.waitForFunction(state=>document.querySelector('[data-dsmm-native-tool]')?.getAttribute('data-state')===state,state);
      }
      await page.evaluate(name => window.__roleTool.result({kind:'activation',name:'different-worker'}, {name}), toolName);
      assert.equal(await nativeCard.getAttribute('data-state'),'accepted','reused callId must not select another child');
      assert.doesNotMatch(await nativeCard.innerText(), /native-model|native-child/u);
      await page.evaluate(() => window.__roleTool.replay());
      await page.locator('[data-chat-call-id="replayed-call"]').waitFor();
      assert.equal(await nativeCard.getAttribute('data-state'),'accepted','replay without lifecycle evidence retains the receipt only');
      assert.equal(await navigationButton(nativeRow).count(), 0, 'a named receipt cannot navigate without same-call correlation');
      await page.evaluate(name => {
        window.__roleTool.result({kind:'activation',subagentId:'native-child'}, {name});
        window.__roleTool.replay();
      }, toolName);
      await navigate(nativeRow, 'native-child', 'unknown');
      for(const code of ['failed','interrupted']) {
        await page.evaluate(({name,code})=>window.__roleTool.result(undefined,{name,isError:true,error:{name:'Error',code,reason:'native original failure'}}),{name:toolName,code});
        assert.equal(await page.locator('[data-dsmm-native-tool]').count(),0,'failed native calls keep their original presenter');
        assert.ok((await page.locator('[data-chat-call-id="role-call"]').innerText()).length>0);
      }
    }
    await page.evaluate(value => window.__roleTool.result(value, { isError: true, error: { name:'AutoReviewDeniedError',code:'AUTO_REVIEW_DENIED',reason:'owned native denial' } }), meta);
    await page.waitForFunction(() => !document.querySelector('[data-dsmm-role-tool]'));
    assert.equal(await page.locator('[data-chat-call-id="role-call"]').count(), 1, "native auto-review denial bypasses the adapter");
    await page.evaluate(value => window.__roleTool.result(value, { noCall: true }), meta);
    await page.waitForFunction(() => !document.querySelector('[data-dsmm-role-tool]'));
    assert.equal(await page.locator('[data-chat-call-id="role-call"]').count(), 1, "windowless call uses native fallback");
    const {nativeControlFixture,gate} = await import('./role-control-fixture.ts');
    const {executeFixtureTool,nativeFixturePlugin,runFixtureTurn} = await import('./native-routing-fixture.ts');
    const {ToolCallId} = await nativeFixturePlugin('@deepseek-ai/dsh-llm');
    const nativeTool = await nativeFixturePlugin('@deepseek-ai/dsh-tool-subagent');
    nativeBackend = await nativeControlFixture();
    await nativeBackend.ctx.plugin(await nativeFixturePlugin('@deepseek-ai/dsh-api-remotes')).await();
    await nativeBackend.ctx.plugin(await nativeFixturePlugin('@deepseek-ai/dsh-subagent-fork-in-process'),{providerName:'fork'}).await();
    await nativeBackend.ctx.plugin(nativeTool,{provider:'spawn',toolName:'subagent'}).await();
    await nativeBackend.ctx.plugin(nativeTool,{provider:'fork',toolName:'subagent_fork'}).await();
    assert.equal(nativeBackend.subagents.getProvider('fork').inheritsParentContext,true);
    await page.evaluate(()=>window.__roleObservation.native());
    for (const [toolName,provider] of [['subagent','spawn'],['subagent_fork','fork']]) {
    nativeBackend.adapter.beforeStream = undefined;
    const parent = await nativeBackend.create({agentPreset:'standard'});
    if(provider==='fork')await runFixtureTurn(parent);
    const parentEvents = parent.session.snapshotEvents();
    const parentHeader = parentEvents.findLast(event=>event.type==='request/header');
    const parentMessage = parentEvents.find(event=>event.type==='user/message');
    const held = gate(), entered = gate();
    releaseChild = held.release;
    nativeBackend.adapter.beforeStream = () => { entered.release(); return held.promise; };
    const nativeArgs = {description:`Real native ${provider} browser task`,prompt:'Return a local answer'};
    await page.evaluate(({sessionId,args,toolName}) => {
      window.__roleObservation.reconnect();
      window.__roleTool.session(sessionId);
      window.__roleTool.partial(JSON.stringify(args));window.__roleTool.start(toolName);
    },{sessionId:parent.id,args:nativeArgs,toolName});
    const receipt = await executeFixtureTool(parent.ctx.tools,{agent:parent,name:toolName,callId:ToolCallId('role-call'),arguments:nativeArgs,signal:new AbortController().signal});
    assert.equal(receipt.isError,false);
    await entered.promise;
    const activation = receipt.value ?? receipt.meta;
    assert.equal(activation?.kind,'activation');
    assert.ok(typeof activation.subagentId === 'string' || typeof activation.name === 'string');
    await page.evaluate(({value,toolName})=>window.__roleTool.result(value.meta,{name:toolName,content:value.content}),{value:receipt,toolName});
    const realCard = page.locator(`[data-dsmm-native-tool="${toolName}"]`);
    try { await page.waitForFunction(()=>document.querySelector('[data-dsmm-native-tool]')?.getAttribute('data-state')==='running'); assert.equal(await realCard.getAttribute('data-state'),'running'); }
    catch(error) { console.error({nativeRequests,receipt,dom:await page.locator('body').innerText(),slotErrors:await page.evaluate(()=>window.__roleSlotErrors),source:await page.evaluate(id=>window.__roleObservation.snapshot(id),parent.id),oldSource:await page.evaluate(()=>window.__roleObservation.snapshot('owned-role-tool-session'))});throw error; }
    const realToggle = realCard.getByRole('button').first();
    if(await realToggle.getAttribute('aria-expanded')!=='true')await realToggle.click();
    const childId = activation.subagentId ?? await nativeBackend.subagents.resolveName(parent,activation.name,new AbortController().signal);
    const catalog = await nativeBackend.subagents.listChildren(parent.id, new AbortController().signal);
    const childEntry = catalog.find(entry => entry.id === childId);
    assert.ok(childEntry);
    await page.evaluate(({parentId,catalog}) => window.__roleTool.catalog(parentId,catalog), {parentId:parent.id,catalog});
    await navigate(realCard, childId, childEntry.mode, parent.id);
    const child = nativeBackend.agents.get(childId);
    const inheritedEventCount = child.session.inheritedEventCount;
    const childEvents = child.session.snapshotEvents();
    if(provider==='fork') {
      assert.ok(parentHeader && parentMessage);
      assert.ok(parentHeader.seq<inheritedEventCount,'the parent request header belongs to the inherited prefix');
      const inheritedHeader = childEvents[parentHeader.seq];
      assert.equal(inheritedHeader.type,'request/header');
      assert.equal(inheritedHeader.data.header.config.provider,parentHeader.data.header.config.provider);
      assert.equal(inheritedHeader.data.header.config.model,parentHeader.data.header.config.model);
      const inheritedMessage = childEvents.slice(0,inheritedEventCount).find(event=>event.type==='user/message' && event.data.id===parentMessage.data.id);
      assert.ok(inheritedMessage,'the fork inherits the real parent task');
      assert.deepEqual(inheritedMessage.data.content,parentMessage.data.content);
    }
    const ownHeader = childEvents.slice(inheritedEventCount).findLast(event=>event.type==='request/header');
    assert.ok(ownHeader,'the child must produce its own request header beyond the seed');
    assert.ok(ownHeader.seq>=inheritedEventCount);
    const observed = (await page.evaluate(id=>window.__roleObservation.snapshot(id),parent.id)).calls.find(([id])=>id==='role-call')[1];
    assert.equal(observed.provider,provider);
    assert.equal(observed.nativeName,activation.name);
    assert.equal(observed.childId,childId);
    assert.equal(observed.actualRoute.source,'own-native-request-header');
    assert.equal(observed.actualRoute.route.provider,ownHeader.data.header.config.provider);
    assert.equal(observed.actualRoute.route.model,ownHeader.data.header.config.model);
    assert.equal(observed.actualRoute.route.reasoningEffort,ownHeader.data.header.config.reasoningEffort);
    await realCard.getByText(new RegExp(`${ownHeader.data.header.config.provider}/${ownHeader.data.header.config.model}`,'u')).waitFor();
    assert.match(await realCard.innerText(),new RegExp(childId,'u'));
    await page.evaluate(()=>window.__roleObservation.disconnect());
    if (receipt.meta?.kind === 'activation') await realCard.locator('[data-observation-status="unavailable"]').waitFor();
    else {
      await realCard.waitFor({state:'hidden'});
      await page.locator('[data-chat-call-id="role-call"]').waitFor();
    }
    assert.equal(nativeBackend.agents.get(childId)?.status,'running','disposing the browser observer does not cancel native work');
    await page.evaluate(()=>window.__roleObservation.reconnect());
    await realCard.locator('[data-observation-status="live"]').waitFor();
    held.release();
    await page.waitForFunction(()=>document.querySelector('[data-dsmm-native-tool]')?.getAttribute('data-state')==='completed');
    const settled = (await page.evaluate(id=>window.__roleObservation.snapshot(id),parent.id)).calls.find(([id])=>id==='role-call')[1];
    assert.equal(settled.stopReason,'completed');
    assert.equal(settled.runId,observed.runId);
    assert.equal(settled.childId,childId);
    assert.deepEqual(settled.actualRoute,observed.actualRoute);
    if(evidence)await page.screenshot({path:join(evidence,`real-native-${provider}-gateway-settled.png`),fullPage:true});
    await page.evaluate(()=>window.__roleObservation.disconnect());
    t.diagnostic(`Real ${toolName}/${provider}: exact receipt, own route beyond ${inheritedEventCount} inherited events, observer disconnect without cancellation and same-run settled DOM passed.`);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__roleSlotErrors), []);
    t.diagnostic('Real native tool receipt → Gateway → browser Connection/generated Remote → production observation controller → DOM: held child route, observer disposal without cancellation, reconnect and settled completion passed.');
    await context.close();
  } finally {
    releaseChild?.();
    for(const stream of nativeStreams.values()) { stream.abort.abort(); await stream.iterator.return?.(); }
    nativeStreams.clear();
    await browser?.close(); await server?.close(); await nativeBackend?.dispose();
    if (await realpath(owned) !== owned || dirname(owned) !== temporaryParent || !basename(owned).startsWith("dsmm-role-native-")) throw new Error("Unexpected role fixture cleanup path");
    await rm(owned, { recursive: true });
  }
});
