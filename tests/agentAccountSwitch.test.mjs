import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {transformSync} from 'esbuild';

// Execute the real dashboard hook with two synthetic sign-ins and controlled IPC.
// No real login files, credentials, accounts, or network requests are used.
function fixture({enabled=true,live=true,deferA=false,deferB=false}={}){
 const slots=[],effects=[],calls=[],timers=new Map(),listeners=new Map(),visibility=new Set(),pending=[];
 let cursor=0,revision='session:1',visible=true,timerId=0,scopeFails=false;
 const react={
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value}]},
  useEffect(effect,deps){const i=cursor++,old=slots[i];if(!old||deps.some((d,j)=>!Object.is(d,old.deps[j]))){slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=effect()})}}
 };
 const empty=()=>({providers:[],providerDiagnostics:[]});
 const deps={react,
  '@tauri-apps/api/core':{isTauri:()=>true},
  '@tauri-apps/api/event':{listen:async(name,fn)=>{listeners.set(name,fn);return()=>listeners.delete(name)}},
  './dashboardAdapter':{emptyDashboardData:empty},
  './dashboardService':{
   mergeDashboardData:(current,next)=>({...current,...next}),
   refreshDashboardData:async(ids,_config,_live,_api,_force,_stocks,scope)=>{
    calls.push({kind:'quota',ids,scope});const captured=scope??'session:1';
    if((captured==='session:1'&&deferA)||(captured==='session:2'&&deferB))await new Promise(resolve=>pending.push({scope:captured,resolve}));
    return {providers:ids.includes('agent-quotas')?[{id:'codex',kind:'agent',state:'normal',percentage:captured==='session:1'?80:20}]:[],providerDiagnostics:[]};
   }
  },
  './registry':{providersFor:()=>[]},
  './pollingLifecycle':{startProviderPolling:(ids,_providers,refresh)=>{refresh(ids);return()=>{}}},
  '../services/appLogger':{logEvent(){}},
  '../services/windowVisibility':{isWindowVisible:()=>visible,subscribeWindowVisibility:fn=>{visibility.add(fn);return()=>visibility.delete(fn)}},
  './agents/agentUsageProvider':{readAgentAccountRevision:async()=>{calls.push({kind:'scope'});if(scopeFails)throw Error('Synthetic source unavailable');return revision}}
 };
 const context=createContext({console,Event:class{},window:{
  setInterval(fn){const id=++timerId;timers.set(id,fn);return id},clearInterval:id=>timers.delete(id),
  addEventListener(){},removeEventListener(){},dispatchEvent(){}
 }});
 const code=transformSync(readFileSync('src/providers/useProviderDashboardData.ts','utf8'),{loader:'ts',format:'cjs'}).code;
 const module={exports:{}};runInContext(`(function(require,module,exports){${code}\n})`,context)(name=>{if(!(name in deps))throw Error('Unexpected dependency '+name);return deps[name]},module,module.exports);
 const hook=()=>module.exports.useProviderDashboardData(['agent-quotas'],{url:'',systemId:'',refreshIntervalSeconds:30},live,{localAgentUsageEnabled:enabled});
 const flush=async()=>{for(const effect of effects.splice(0))effect();for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve))};
 return {calls,timers,listeners,pending,render(){cursor=0;return hook()},flush,change(value){revision=value},failScope(){scopeFails=true},tick(){for(const fn of timers.values())fn()},show(){visible=true;for(const fn of visibility)fn()},hide(){visible=false},finish(scope){for(const p of pending.filter(p=>p.scope===scope))p.resolve()},dispose(){for(const slot of slots)slot?.cleanup?.()}};
}

test('quota cache requests are tied to the current native account revision',async()=>{
 const f=fixture();f.render();await f.flush();
 assert.ok(f.calls.some(c=>c.kind==='scope'),'must verify the login source before hydrating cached quota');
 assert.equal(f.calls.find(c=>c.kind==='quota'&&c.ids.includes('agent-quotas'))?.scope,'session:1');
 assert.equal(f.render().providers[0].percentage,80);f.dispose();
});

test('official-client account switch clears A before B finishes, without waiting five minutes',async()=>{
 const f=fixture({deferB:true});f.render();await f.flush();assert.equal(f.render().providers[0].percentage,80);
 f.change('session:2');f.tick();await f.flush();assert.equal(f.render().providers.length,0,'old account quota must disappear while the new account is being read');
 f.finish('session:2');await f.flush();assert.equal(f.render().providers[0].percentage,20);f.dispose();
});

test('a delayed response for A cannot overwrite B after the account switch',async()=>{
 const f=fixture({deferA:true});f.render();await f.flush();f.change('session:2');f.tick();await f.flush();
 assert.equal(f.render().providers[0]?.percentage,20);f.finish('session:1');await f.flush();assert.equal(f.render().providers[0].percentage,20);f.dispose();
});

test('unreadable account identity removes previous quota until it can be confirmed again',async()=>{
 const f=fixture();f.render();await f.flush();f.failScope();f.tick();await f.flush();assert.equal(f.render().providers.length,0);f.dispose();
});

test('disabled consent and simulation never inspect login sources',async()=>{
 for(const options of [{enabled:false},{live:false}]){const f=fixture(options);f.render();await f.flush();f.tick();await f.flush();assert.equal(f.calls.filter(c=>c.kind==='scope').length,0);f.dispose();assert.equal(f.timers.size,0)}
});
