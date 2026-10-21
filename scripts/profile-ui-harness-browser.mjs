/** Test composition only; no native or DSMM production bundle is rewritten. */
export const COMPOSITION_ID = "@dsmm/profile-ui-acceptance";

export function compositionBundle() {
  return `window.__ModuleLoader__.load({id:${JSON.stringify(COMPOSITION_ID)},factory(require){
    const React=require('react');
    const {installConnection}=require('@deepseek-ai/dsh-client-connection/client');
    const {LocaleRuntime}=require('@deepseek-ai/dsh-client-locale/client');
    return {inject:['slots'],apply(ctx){
      installConnection(ctx,{transport:{rpc:window.__dsmmOwnedCarrier,ownsHost:true}});
      const locale=new LocaleRuntime(ctx,undefined,{languages:['en'],preference:'en'});
      ctx.provide('locale',locale);
      ctx.slots.installLocale(locale);
      // The owned component surface is vertically scrollable; it is not the
      // production application's fixed-height settings-shell layout.
      document.body.style.overflow='auto';
      document.getElementById('root').style.height='auto';
      document.getElementById('root').style.overflow='visible';
      ctx.slots.register({name:'root',children:{'settings.section':{kind:'list',scope:'root'}}},
        ({renderSlot})=>React.createElement('main',{'data-profile-ui-harness':'',style:{padding:'24px',width:'100%',minWidth:0,boxSizing:'border-box'}},
          renderSlot('settings.section',{}, {only:'dsmm-profiles'})));
      window.__dsmmUiContext=ctx;
      window.__dsmmNativeSeedProof={reactVersion:React.version,primitiveNames:Object.keys(require('@deepseek-ai/dsh-client-ui-primitives')).filter(name=>name==='Button'||name==='Input')};
    }};
  }});`;
}

export function bootstrapFacade(libraries = []) {
  return `window.__ModuleLoader__={mode:'queue',pendingQueue:[],load(row){this.pendingQueue.push(row)},create(options){
    const at=this.pendingQueue.findIndex(row=>row.id==='@deepseek-ai/dsh-client-modules');
    if(at<0)throw new Error('Native modules bootstrap missing');
    const row=this.pendingQueue.splice(at,1)[0];
    const exports=row.factory(()=>{throw new Error('Bootstrap requested an unseeded module')});
    const system=exports.createClientModuleSystem(this,{id:row.id,exports},options);
     // The composition activates selected libraries itself; their native
     // exports remain in the module table.
     system.manifest={...system.manifest,plugins:system.manifest.plugins.filter(row=>
       !${JSON.stringify(["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-locale", ...libraries])}.includes(row.id))};
    window.__dsmmNativeModules=system;
    return system;
  }};`;
}

/** The only bridge is a Playwright-owned binding, not an HTTP API route. */
export function carrierBootstrap() {
  return `(()=>{
    let sequence=0;
    const generation=crypto.randomUUID();
    const request=value=>window.__dsmmNativeBridge(value);
    window.__dsmmOwnedCarrier={
      async call(channel,endpoint,payload,signal){
        const id=generation+'-call-'+(++sequence);
        const cancel=()=>{void request({operation:'cancel',id})};
        signal?.addEventListener('abort',cancel,{once:true});
        try{
          if(signal?.aborted)return {ok:false,error:{code:'gateway/cancelled',message:'Cancelled',details:{}}};
          return await request({operation:'call',id,channel,endpoint,payload});
        }finally{signal?.removeEventListener('abort',cancel)}
      },
      async *open(channel,endpoint,payload,signal){
        const id=generation+'-stream-'+(++sequence);
        const cancel=()=>{void request({operation:'cancel',id})};
        signal.addEventListener('abort',cancel,{once:true});
        try{
          if(signal.aborted)return;
          const opened=await request({operation:'open',id,channel,endpoint,payload});
          if(!opened.ok)throw Object.assign(new Error(opened.error.message),opened.error);
          while(!signal.aborted){
            const item=await request({operation:'next',id});
            if(!item.ok)throw Object.assign(new Error(item.error.message),item.error);
            if(item.value.done)return;
            yield item.value.value;
          }
        }finally{signal.removeEventListener('abort',cancel);await request({operation:'cancel',id})}
      }
    };
  })();`;
}

export function createBootGraph(rows, revision) {
  const entries = rows.map(({ id, url, inject = [], external = [] }) => ({ id, url, rev: revision, inject, external, immediately: true }));
  return { rev: revision, entries, batches: entries.map(({ id, url, rev }) => ({ phase: id === "@deepseek-ai/dsh-client-modules" ? "bootstrap" : "application", url, rev, entries: [id] })) };
}

/** Read settled native state; never restart, wrap, or replace a plugin. */
export async function nativeClientPreflight(scope = window) {
  const modules = scope.__dsmmNativeModules;
  const root = scope.__dsmmUiContext?.root;
  const errorProof = (error) => ({ name: error.name, message: error.message ?? String(error), stack: error.stack });
  const loader = root?.get("loader");
  const providers = Reflect.ownKeys(root?.reflect.store ?? {}).map((key) => {
    const { name, fiber } = root.reflect.store[key];
    return { service: name, provider: fiber.name, state: fiber.state };
  });
  const missingServices = [];
  const pluginGraph = (modules?.manifest.plugins ?? []).map(({ id, inject }) => {
    const exports = modules.loadCache.get(id)?.exports;
    const declared = exports?.inject;
    const requiredServices = Array.isArray(declared) ? [...declared] : Object.keys(declared ?? {});
    const services = requiredServices.map((service) => {
      const available = root !== undefined && root.get(service) !== undefined;
      if (!available) missingServices.push({ id, service });
      return { service, available };
    });
    const importError = modules.importError(id);
    return { id, inject, materialized: exports !== undefined, requiredServices, services, ...(importError ? { importError: errorProof(importError) } : {}) };
  });
  const entries = [];
  for (const entry of loader?.entries() ?? []) {
    const row = { id: entry.id, name: entry.options.name, state: entry.fiber?.state };
    // Fiber.await is the public API that rethrows its original startup error.
    // Only a settled FAILED fiber is read, so no new activation is triggered.
    if (entry.fiber?.state === 3) {
      try { await entry.fiber.await(); }
      catch (error) { row.startupError = errorProof(error); }
    }
    entries.push(row);
  }
  const uiSession = root?.get("uiSession");
  const scopeBinding = uiSession?.adapter.current.getSnapshot();
  const sessionScope = { provider: uiSession?.name, installed: uiSession?.adapter !== undefined,
    noActiveSession: scopeBinding !== undefined && scopeBinding.key === undefined,
    hookNames: Object.keys(scopeBinding?.hooks ?? {}), propNames: Object.keys(scopeBinding?.props ?? {}) };
  return { rootPresent: root !== undefined, nativeModules: [...(modules?.loadCache.keys() ?? [])], pluginGraph, providers, missingServices, entries,
    entryState: modules?.entries.state.getSnapshot(), slotTree: root?.get("slots")?.snapshot?.(), sessionScope };
}
