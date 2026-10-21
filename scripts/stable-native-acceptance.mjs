import assert from "node:assert/strict";

/** Native Renderer and UiSession supply the scope; only the test shell is owned. */
export function stableCompositionBundle(compositionId, { current = false } = {}) {
  assert.ok(typeof compositionId === "string" && compositionId.length > 0);
  const currentSetup = current ? `
     const source=value=>{const listeners=new Set();return {getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},set:next=>{value=next;listeners.forEach(fn=>fn())}}};
     const roleArgs={role:'dsmm-builder',level:'low',description:'030 requested identity',prompt:'retain raw input'};let roleRaw=JSON.stringify(roleArgs);
     const transcript=source({phase:'preparing',name:'dsmm_role',callId:'dsmm-030-role-call',subCalls:[]});
     const assistant=source({blocks:[{kind:'tool-call',callId:'dsmm-030-role-call',argsRaw:roleRaw}]});
     const nodeLocation={kind:'step',step:{data:{source:()=>assistant}}};
     function useDisclosure(){const [expanded,setExpanded]=React.useState(false);return {expanded,setExpanded,toggle:()=>setExpanded(value=>!value)}}
     function RoleToolSurface({renderSlot,SessionProvider}){const root=React.useSyncExternalStore(transcript.subscribe,transcript.getSnapshot);return React.createElement(SessionProvider,{},renderSlot('conversation.chat.node',{node:{kind:'tool-call',key:'dsmm-030-tool-node',data:{root},location:nodeLocation},cwd:'/workspace',openFile:()=>{},loadImage:async()=>undefined,inspectCall:()=>{},useDisclosure},{entryKey:'tool-call'}))}
     window.__dsmmRoleTool={requested:roleArgs,start(){transcript.set({phase:'start',name:'dsmm_role',callId:'dsmm-030-role-call',argsRaw:roleRaw,subCalls:[]})},result(meta){transcript.set({kind:'tool-result',seq:3,time:0,callId:'dsmm-030-role-call',call:{name:'dsmm_role',argsRaw:roleRaw},callTime:0,content:[{type:'text',text:'030 complete raw output'}],isError:false,meta,subCalls:[]})}};` : "";
  const currentChildren = current ? `,'plugins.bundle.config':{kind:'keyed',scope:'root'},'conversation.chat.node':{kind:'keyed',scope:'session'}` : "";
  const currentViews = current ? `,
            renderSlot('plugins.bundle.config',{view:'page'},{entryKey:'@dsmm/dsmm'}),
            React.createElement(RoleToolSurface,{renderSlot,SessionProvider})` : "";
  return `window.__ModuleLoader__.load({id:${JSON.stringify(compositionId)},factory(require){
    const React=require('react');
    const {installConnection}=require('@deepseek-ai/dsh-client-connection/client');
    const {LocaleRuntime}=require('@deepseek-ai/dsh-client-locale/client');
    return {inject:['slots'],apply(ctx){
      installConnection(ctx,{interactions:'answer',transport:{rpc:window.__dsmmOwnedCarrier,ownsHost:true}});
     const locale=new LocaleRuntime(ctx,undefined,{languages:['en'],preference:'en'});
     ctx.provide('locale',locale);ctx.slots.installLocale(locale);
     ${currentSetup}
     document.body.style.overflow='auto';document.getElementById('root').style.height='auto';
     ctx.slots.register({name:'root',children:{'settings.section':{kind:'list',scope:'root'},'conversation.view':{kind:'list',scope:'session'}${currentChildren}}},
       ({renderSlot,SessionProvider})=>React.createElement('main',{'data-profile-ui-harness':'',style:{padding:'24px',width:'100%',minWidth:0,boxSizing:'border-box'}},
           renderSlot('settings.section',{}, {only:'dsmm-profiles'}),
           React.createElement(SessionProvider,{},renderSlot('conversation.view',{}, {only:'dsmm-children'}))${currentViews}));
      window.__dsmmUiContext=ctx;
    }};
  }});`;
}
