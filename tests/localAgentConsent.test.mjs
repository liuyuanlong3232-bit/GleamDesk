import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createContext,runInContext} from 'node:vm';
import {transformSync} from 'esbuild';

function fixture({defer=false}={}){
 const slots=[],effects=[],calls=[];let cursor=0,enabled=false,finish,changed;
 const react={
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v}]},
  useRef(initial){const i=cursor++;return slots[i]??(slots[i]={current:initial})},
  useEffect(fn,deps){const i=cursor++,previous=slots[i];if(!previous||deps.some((d,n)=>!Object.is(d,previous.deps[n]))){slots[i]={deps};effects.push(()=>{previous?.cleanup?.();slots[i].cleanup=fn()})}}
 };
 const account={id:'codex',name:'Codex',installed:true,loginStatus:'verified',plan:'synthetic-plan'};
 const deps={react,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
  '@tauri-apps/api/core':{isTauri:()=>true,invoke:async(command,args)=>{calls.push({command,args});if(command==='read_agent_usage'){if(defer)await new Promise(r=>finish=r);return{accounts:[account]}}if(command==='read_ollama_status')return{serviceStatus:'online',runningModels:[]};if(command==='read_doubao_membership')return{available:false};throw Error('Unexpected command '+command)}},
  './AIControlCenter':{membershipBenefitDetail:v=>v},'./StatusHud':{HudLogo:()=>null},
  '../providers/agents/agentUsageProvider':{normalizeAgentUsage:v=>v,agentClients:[],unavailableAgentRuntime:()=>({available:false}),readAgentRuntime:async()=>{calls.push({command:'runtime-only'});return{available:true}},runningAgentClients:()=>[]},
  '../services/windowVisibility':{isWindowVisible:()=>true,subscribeWindowVisibility:()=>()=>{}},'../services/launcher/launcherService':{launchApplication:async()=>{throw Error('External launch not allowed')}}
 };
 const context=createContext({console,Event:class{},window:{setInterval:()=>1,clearInterval(){},addEventListener(){},removeEventListener(){},dispatchEvent(){}}});
 const load=path=>{const module={exports:{}};const code=transformSync(readFileSync(path,'utf8'),{loader:'tsx',format:'cjs',jsx:'automatic'}).code;runInContext(`(function(require,module,exports){${code}\n})`,context)(name=>{if(!(name in deps))throw Error('Unexpected dependency '+name);return deps[name]},module,module.exports);return module.exports};
 const {AgentConnectionsSettings}=load('src/components/AgentConnectionsSettings.tsx');
 return{calls,load,get changed(){return changed},render(value=enabled){enabled=value;cursor=0;return AgentConnectionsSettings({enabled,onEnabledChange:v=>changed=v})},async flush(){for(const effect of effects.splice(0))effect();await new Promise(r=>setImmediate(r))},finish(){finish?.()}};
}
function elements(tree,type){if(!tree||typeof tree!=='object')return[];if(Array.isArray(tree))return tree.flatMap(t=>elements(t,type));return[...(tree.type===type?[tree]:[]),...elements(tree.props?.children,type)]}
function text(tree){if(tree==null||typeof tree==='boolean')return'';if(typeof tree!=='object')return String(tree);if(Array.isArray(tree))return tree.map(text).join('');return text(tree.props?.children)}
const button=(tree,label)=>elements(tree,'button').find(b=>text(b)===label);
const accountCalls=f=>f.calls.filter(c=>c.command==='read_agent_usage'||c.command==='read_doubao_membership');

test('opening AI settings while disabled only detects running apps, never reads accounts',async()=>{
 const f=fixture();f.render();await f.flush();const tree=f.render();assert.equal(elements(tree,'input')[0].props.checked,false);
 assert.ok(f.calls.some(c=>c.command==='runtime-only'));assert.equal(accountCalls(f).length,0);
 assert.equal(button(tree,'刷新连接状态').props.disabled,true);assert.equal(button(tree,'读取豆包会员').props.disabled,true);
 await button(tree,'刷新连接状态').props.onClick();await button(tree,'读取豆包会员').props.onClick();assert.equal(accountCalls(f).length,0);
 elements(tree,'input')[0].props.onChange({target:{checked:true}});assert.equal(f.changed,true);assert.equal(accountCalls(f).length,0);
});
test('explicit opt in passes consent; turning off hides account values and prevents further reads',async()=>{
 const f=fixture();f.render(false);await f.flush();f.render(true);await f.flush();let tree=f.render();assert.match(text(tree),/synthetic-plan/);
 assert.equal(accountCalls(f).length,1);assert.equal(accountCalls(f)[0].args.consent,true);
 const staleRefresh=button(tree,'刷新连接状态').props.onClick;
 f.render(false);await f.flush();tree=f.render();assert.doesNotMatch(text(tree),/synthetic-plan/);await staleRefresh();assert.equal(accountCalls(f).length,1);
});
test('an in-flight account reply cannot reappear after consent is turned off',async()=>{
 const f=fixture({defer:true});f.render(true);await f.flush();assert.equal(accountCalls(f).length,1);
 f.render(false);await f.flush();f.finish();await f.flush();assert.doesNotMatch(text(f.render()),/synthetic-plan|连接状态已刷新/);
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
