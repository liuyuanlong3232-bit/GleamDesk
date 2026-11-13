import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createContext,runInContext} from 'node:vm';
import {transformSync} from 'esbuild';

const agentIds=['codex','claude','antigravity','doubao','kimi','cursor'];
function fixture({defer=false,readFails=false,emitFails=false,loginFails=false}={}){
 const slots=[],effects=[],calls=[],events=[],localEvents=[],dashboardCalls=[],nativeListeners=new Map(),pending=[];let cursor=0,enabled=false,changed;
 const react={
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v}]},
  useRef(initial){const i=cursor++;return slots[i]??(slots[i]={current:initial})},
  useEffect(fn,deps){const i=cursor++,previous=slots[i];if(!previous||deps.some((d,n)=>!Object.is(d,previous.deps[n]))){slots[i]={deps};effects.push(()=>{previous?.cleanup?.();slots[i].cleanup=fn()})}}
 };
 const account={id:'codex',name:'Codex',installed:true,loginStatus:'verified',plan:'synthetic-plan'};
 const deps={react,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
  '@tauri-apps/api/core':{isTauri:()=>true,invoke:async(command,args)=>{calls.push({command,args});if(command.startsWith('doubao_login_')){if(command==='doubao_login_connect'&&loginFails)throw '豆包尚未完成登录';return;}if(command==='read_agent_usage'){if(defer)await new Promise(r=>pending.push(r));if(readFails)throw Error('Synthetic read failure');return{accountRevision:'1:1:1',accounts:[{...account,id:args.agentId}]}}if(command==='read_ollama_status')return{serviceStatus:'online',runningModels:[]};if(command==='read_doubao_membership')return{available:false};throw Error('Unexpected command '+command)}},
  '@tauri-apps/api/event':{emit:async(name,payload)=>{if(emitFails)throw Error('Synthetic event failure');events.push({name,payload})},listen:async(name,fn)=>{nativeListeners.set(name,fn);return()=>nativeListeners.delete(name)}},
  './dashboardAdapter':{emptyDashboardData:()=>({providers:[]})},
  './dashboardService':{refreshDashboardData:async(...args)=>{dashboardCalls.push(args);return{providers:[]}},mergeDashboardData:(current,next)=>({...current,...next})},
  './pollingLifecycle':{startProviderPolling:()=>()=>{}},'./registry':{providersFor:()=>[]},
  '../services/appLogger':{logEvent(){}},
  './AIControlCenter':{membershipBenefitDetail:v=>v},'./StatusHud':{HudLogo:()=>null},
  '../presentation/quotaAdapter':{doubaoReadIssueMessage:()=>undefined},
  '../providers/agents/agentUsageProvider':{normalizeAgentUsage:v=>v,agentClients:[],unavailableAgentRuntime:()=>({available:false}),readAgentRuntime:async()=>{calls.push({command:'runtime-only'});return{available:true}},runningAgentClients:()=>[],readAgentAccountRevision:async()=> '1:1:1'},
  './agents/agentUsageProvider':{quotaAgentIds:agentIds,readAgentAccountRevision:async()=> '1:1:1'},
  '../services/windowVisibility':{isWindowVisible:()=>true,subscribeWindowVisibility:()=>()=>{}},'../services/launcher/launcherService':{launchApplication:async()=>{throw Error('External launch not allowed')}}
 };
 const context=createContext({console,Event:class{constructor(type){this.type=type}},window:{setInterval:()=>1,clearInterval(){},addEventListener(){},removeEventListener(){},dispatchEvent(event){localEvents.push(event.type)}}});
 const load=path=>{const module={exports:{}};const code=transformSync(readFileSync(path,'utf8'),{loader:'tsx',format:'cjs',jsx:'automatic'}).code;runInContext(`(function(require,module,exports){${code}\n})`,context)(name=>{if(!(name in deps))throw Error('Unexpected dependency '+name);return deps[name]},module,module.exports);return module.exports};
 const {AgentConnectionsSettings}=load('src/components/AgentConnectionsSettings.tsx');
 return{calls,events,localEvents,dashboardCalls,nativeListeners,load,get changed(){return changed},render(value=enabled){enabled=value;cursor=0;return AgentConnectionsSettings({enabled,onEnabledChange:v=>changed=v})},renderHook(fn){cursor=0;return fn()},async flush(){for(const effect of effects.splice(0))effect();await new Promise(r=>setImmediate(r))},dispose(){for(const slot of slots)slot?.cleanup?.()},finish(){for(const finish of pending)finish()}};
}
function elements(tree,type){if(!tree||typeof tree!=='object')return[];if(Array.isArray(tree))return tree.flatMap(t=>elements(t,type));return[...(tree.type===type?[tree]:[]),...elements(tree.props?.children,type)]}
function text(tree){if(tree==null||typeof tree==='boolean')return'';if(typeof tree!=='object')return String(tree);if(Array.isArray(tree))return tree.map(text).join('');return text(tree.props?.children)}
const button=(tree,label)=>elements(tree,'button').find(b=>text(b)===label);
const accountCalls=f=>f.calls.filter(c=>c.command==='read_agent_usage'||c.command==='read_doubao_membership');

test('manual account refresh notifies every native window without publishing account data',async()=>{
 const f=fixture();f.render(true);await f.flush();
 assert.equal(f.events.length,0,'opening settings must not broadcast a manual refresh');
 button(f.render(),'刷新连接状态').props.onClick();await f.flush();
 assert.equal(f.events.length,1);assert.equal(f.events[0].name,'agent-usage-changed');assert.equal(f.events[0].payload,undefined);
});

test('failed account reads do not broadcast a successful refresh',async()=>{
 const f=fixture({readFails:true});f.render(true);await f.flush();button(f.render(),'刷新连接状态').props.onClick();await f.flush();
 assert.equal(f.events.length,0);assert.match(text(f.render()),/AI 连接读取失败/);
});

test('a native event failure preserves the successful account read and falls back to a local refresh',async()=>{
 const f=fixture({emitFails:true});f.render(true);await f.flush();button(f.render(),'刷新连接状态').props.onClick();await f.flush();
 assert.deepEqual(f.localEvents,['codex-desktop.agents-refresh']);assert.match(text(f.render()),/synthetic-plan|连接状态已刷新/);assert.doesNotMatch(text(f.render()),/连接检查失败/);
});

test('a refresh from another native window updates the HUD provider and unsubscribes on unmount',async()=>{
 const f=fixture(),{useProviderDashboardData}=f.load('src/providers/useProviderDashboardData.ts');
 f.renderHook(()=>useProviderDashboardData(['agent-quotas'],{url:'',systemId:'',refreshIntervalSeconds:30},true,{localAgentUsageEnabled:true}));await f.flush();
 const listener=f.nativeListeners.get('agent-usage-changed');assert.equal(typeof listener,'function');
 const before=f.dashboardCalls.length;listener();await f.flush();const updates=f.dashboardCalls.slice(before);
 assert.equal(updates.filter(args=>args[0].includes('agent-quotas')).length,6);
 assert.deepEqual(updates.filter(args=>args[7]).map(args=>args[7]).sort(),[...agentIds].sort());assert.ok(updates.every(args=>args[4]===false),'reuse the completed native read instead of forcing it again');
 f.dispose();assert.equal(f.nativeListeners.has('agent-usage-changed'),false);
});

test('a cross-window quota refresh cannot enable real reads in simulation',async()=>{
 const f=fixture(),{useProviderDashboardData}=f.load('src/providers/useProviderDashboardData.ts');
 f.renderHook(()=>useProviderDashboardData(['agent-quotas'],{url:'',systemId:'',refreshIntervalSeconds:30},false));await f.flush();
 const listener=f.nativeListeners.get('agent-usage-changed');assert.equal(typeof listener,'function');listener();await f.flush();assert.equal(f.dashboardCalls.length,0);f.dispose();
});

test('connecting Doubao refreshes only Doubao in the other native windows',async()=>{
 const f=fixture(),{useProviderDashboardData}=f.load('src/providers/useProviderDashboardData.ts');
 f.renderHook(()=>useProviderDashboardData(['agent-quotas'],{url:'',systemId:'',refreshIntervalSeconds:30},true,{localAgentUsageEnabled:true}));await f.flush();
 const before=f.dashboardCalls.length;f.nativeListeners.get('agent-usage-changed')({payload:{agentId:'doubao'}});await f.flush();
 const updates=f.dashboardCalls.slice(before);assert.equal(updates.length,1);assert.equal(updates[0][7],'doubao');f.dispose();
});

test('windows without quota cards ignore cross-window quota refreshes',async()=>{
 const f=fixture(),{useProviderDashboardData}=f.load('src/providers/useProviderDashboardData.ts');
 f.renderHook(()=>useProviderDashboardData(['hardware-status'],{url:'',systemId:'',refreshIntervalSeconds:30}));await f.flush();
 f.nativeListeners.get('agent-usage-changed')();await f.flush();assert.equal(f.dashboardCalls.length,0);f.dispose();
});

test('opening AI settings while disabled only detects running apps, never reads accounts',async()=>{
 const f=fixture();f.render();await f.flush();const tree=f.render();assert.equal(elements(tree,'input')[0].props.checked,false);
 assert.ok(f.calls.some(c=>c.command==='runtime-only'));assert.equal(accountCalls(f).length,0);
 assert.equal(button(tree,'刷新连接状态').props.disabled,true);assert.equal(button(tree,'读取豆包会员'),undefined);
 await button(tree,'刷新连接状态').props.onClick();assert.equal(accountCalls(f).length,0);
 elements(tree,'input')[0].props.onChange({target:{checked:true}});assert.equal(f.changed,true);assert.equal(accountCalls(f).length,0);
});

test('Doubao login is explicit and stays disabled until local account access is enabled',async()=>{
 const f=fixture();let tree=f.render(false);
 const connect=button(tree,'连接豆包');assert.ok(connect,'Doubao needs its own connection action');
 assert.equal(connect.props.disabled,true);assert.equal(f.calls.length,0);
 assert.match(text(tree),/客户端换号后需重新连接/);
});

test('Doubao opens only on request and saves only after a separate completion action',async()=>{
 const f=fixture();f.render(true);await f.flush();assert.equal(f.calls.filter(c=>c.command.startsWith('doubao_login_')).length,0);
 button(f.render(),'重新连接豆包').props.onClick();await f.flush();
 assert.equal(f.calls.filter(c=>c.command==='doubao_login_open').length,1);
 assert.equal(f.calls.filter(c=>c.command==='doubao_login_connect').length,0);
 assert.match(text(f.render()),/返回这里点完成连接/);
 button(f.render(),'完成连接').props.onClick();await f.flush();
 assert.equal(f.calls.filter(c=>c.command==='doubao_login_connect').length,1);
 assert.equal(button(f.render(),'完成连接'),undefined);assert.match(text(f.render()),/豆包已连接/);
 assert.ok(f.calls.filter(c=>c.command.startsWith('doubao_login_')).every(c=>c.args.consent===true));
});

test('an incomplete Doubao login keeps the completion action available for retry',async()=>{
 const f=fixture({loginFails:true});f.render(true);await f.flush();button(f.render(),'重新连接豆包').props.onClick();await f.flush();
 button(f.render(),'完成连接').props.onClick();await f.flush();
 assert.match(text(f.render()),/豆包尚未完成登录/);assert.ok(button(f.render(),'完成连接'));
 f.render(false);await f.flush();const before=f.calls.length;
 button(f.render(),'完成连接').props.onClick();await f.flush();assert.equal(f.calls.length,before);
});
test('explicit opt in passes consent; turning off hides account values and prevents further reads',async()=>{
 const f=fixture();f.render(false);await f.flush();f.render(true);await f.flush();let tree=f.render();assert.match(text(tree),/synthetic-plan/);
 assert.equal(accountCalls(f).length,6);assert.ok(accountCalls(f).every(call=>call.args.consent===true&&agentIds.includes(call.args.agentId)));
 const staleRefresh=button(tree,'刷新连接状态').props.onClick;
 f.render(false);await f.flush();tree=f.render();assert.doesNotMatch(text(tree),/synthetic-plan/);await staleRefresh();assert.equal(accountCalls(f).length,6);
});
test('an in-flight account reply cannot reappear after consent is turned off',async()=>{
 const f=fixture({defer:true});f.render(true);await f.flush();assert.equal(accountCalls(f).length,6);
 f.render(false);await f.flush();f.finish();await f.flush();assert.doesNotMatch(text(f.render()),/synthetic-plan|连接状态已刷新/);
 assert.equal(f.events.length,0);
 assert.equal(button(f.render(),'刷新连接状态').props.disabled,true);
});
test('privacy notice is collapsed by default and exposes the local and external data boundary',()=>{
 const f=fixture(),{PrivacyNotice}=f.load('src/components/PrivacyNotice.tsx'),tree=PrivacyNotice();
 assert.equal(tree.type,'details');assert.notEqual(tree.props.open,true);assert.match(text(tree),/默认不读取/);assert.match(text(tree),/关闭不删除已有记录/);
 assert.ok(elements(tree,'a').some(a=>a.props.href.endsWith('/docs/PRIVACY.md')));
});
test('the new rights and asset records link to existing local documents',()=>{
 for(const file of ['docs/DATA_AND_ASSET_RIGHTS.md','docs/PRIVACY.md','src/assets/avatars-3d/README.md','src/assets/hud/README.md']){
  for(const match of readFileSync(file,'utf8').matchAll(/\]\(([^)]+)\)/g)){
   const link=match[1];if(!/^https?:|^#/.test(link))assert.ok(existsSync(resolve(dirname(file),link.split('#')[0])),`${file}: ${link}`);
  }
 }
});
