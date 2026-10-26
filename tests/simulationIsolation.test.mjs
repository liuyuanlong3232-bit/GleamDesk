import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { transformSync } from 'esbuild';

const settingsKey = 'codex-desktop.settings.v1';
function fixture(simulationEnabled,invokeImpl) {
  const values=new Map([[settingsKey,JSON.stringify({simulationEnabled})]]), calls=[],slots=[],effects=[],cache=new Map();
  let cursor=0;
  const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
  const react={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v}]},
    useRef(initial){const i=cursor++;return slots[i]??={current:initial}},useEffect(fn,deps){const i=cursor++;if(!slots[i]||deps?.some((v,j)=>v!==slots[i][j])){slots[i]=deps;effects.push(fn)}}};
  const jsx=(type,props)=>({type,props});
  const context=createContext({console,localStorage:storage,Date,crypto:{randomUUID:()=> 'mock-request'},
    window:{addEventListener(){},removeEventListener(){},setInterval(){return 1},clearInterval(){}},
    document:{addEventListener(){},removeEventListener(){}},setTimeout,clearTimeout});
  const stubs={react,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},
    '@tauri-apps/api/core':{isTauri:()=>true,invoke:async(command,args)=>{calls.push({command,args});if(invokeImpl)return invokeImpl(command,args);return command==='generate_daily_recommendations'?{items:[]}:null}},
    '@tauri-apps/api/event':{listen:async()=>()=>{}},launcherService:{launchApplication:async()=>{}},
    windowVisibility:{isWindowVisible:()=>true,subscribeWindowVisibility:()=>()=>{}},
    settingsStore:{loadSettings:()=>JSON.parse(storage.getItem(settingsKey))},
    credentials:{hasCredential:async()=>true,saveCredential:async()=>{},clearCredential:async()=>{}},
    apiUsageProvider:{readApiUsage:async()=>{calls.push({command:'readApiUsage'});return {accounts:[]}}},
    DailyOpenSource:{openDailyLink:async()=>{}},RoomPortrait:{RoomPortrait(){},defaultRoomAvatar:()=>''},
    agentAvatars:{saveAvatar:async()=>{},resetAvatar:async()=>{},validateAvatar(){}},roomAttachments:{readChatAttachment:async()=>{}},
  };
  function load(path){
    const full=resolve(path);if(cache.has(full))return cache.get(full).exports;
    const module={exports:{}};cache.set(full,module);
    let code=transformSync(readFileSync(full,'utf8'),{loader:full.endsWith('tsx')?'tsx':'ts',format:'cjs',jsx:'automatic'}).code;
    if(full.endsWith('ApiConnectionsSettings.tsx'))code+='\nmodule.exports.__Connection=Connection;module.exports.__Balance=MimoBalanceConnection;';
    const require=name=>{if(name.endsWith('.css'))return{};const stub=stubs[name]??stubs[name.split('/').at(-1)];if(stub)return stub;if(name.startsWith('.')){const base=resolve(dirname(full),name);return load(existsSync(base+'.ts')?base+'.ts':base+'.tsx')}throw Error('Unexpected dependency: '+name)};
    runInContext(`(function(require,module,exports){${code}\n})`,context,{filename:full})(require,module,module.exports);return module.exports;
  }
  return{load,calls,values,storage,render(fn){cursor=0;return fn()},async flush(){for(let i=0;i<8;i++){for(const fn of effects.splice(0))fn();await new Promise(r=>setImmediate(r))}},setMode(enabled){storage.setItem(settingsKey,JSON.stringify({simulationEnabled:enabled}))}};
}
function elements(tree,type){if(!tree||typeof tree!=='object')return[];if(Array.isArray(tree))return tree.flatMap(t=>elements(t,type));return[...(tree.type===type?[tree]:[]),...elements(tree.props?.children,type)]}
function text(tree){if(tree==null||typeof tree==='boolean')return'';if(typeof tree!=='object')return String(tree);if(Array.isArray(tree))return tree.map(text).join('');return text(tree.props?.children)}
const request={id:'test',scope:'direct-DeepSeek',text:'你好',provider:'DeepSeek',attachments:[],mode:'group'};

test('模拟下原生Room服务不触发发送IPC',async()=>{const f=fixture(true),{nativeWorkspace}=f.load('src/services/roomWorkspace.ts');let sent=0;const service=nativeWorkspace(async()=>{sent++;return{}});await assert.rejects(service.send(request),/模拟/);assert.equal(sent,0)});
test('正常模式仍保留Room原来的发送参数',async()=>{const f=fixture(false),{nativeWorkspace}=f.load('src/services/roomWorkspace.ts');let sent;const service=nativeWorkspace(async(command,args)=>{sent={command,args};return{}});await service.send(request);assert.equal(sent.command,'agent_room_workspace_send');assert.equal(sent.args.request,request)});
test('模拟模式的设置生成入口即使直接调用事件也不发送',async()=>{const f=fixture(true),{__Connection:Connection}=f.load('src/components/ApiConnectionsSettings.tsx');const props={source:'mimo',connections:{mimoEnabled:true,credentialRevision:0},onChange(){},simulationEnabled:true};let tree=f.render(()=>Connection(props));await f.flush();tree=f.render(()=>Connection(props));const button=elements(tree,'button').find(n=>text(n).includes('生成今日中文介绍'));assert.ok(button);assert.equal(button.props.disabled,true);await button.props.onClick();await f.flush();assert.equal(f.calls.filter(c=>c.command==='generate_daily_recommendations').length,0)});
test('模拟模式的Room按钮和快捷键都保留草稿且不发送',async()=>{
  const f=fixture(true),{blankWorkspace}=f.load('src/services/roomWorkspace.ts'),{AgentRoom}=f.load('src/components/AgentRoom.tsx');
  f.storage.setItem('codex-desktop.agent-room-current.v1','direct-DeepSeek');const snapshot=blankWorkspace();snapshot.models[0].connected=true;let sent=0;
  const service={load:async()=>snapshot,send:async()=>{sent++;return snapshot},cancel:async()=>{}};const props={service,simulationEnabled:true};
  let tree=f.render(()=>AgentRoom(props));await f.flush();tree=f.render(()=>AgentRoom(props));elements(tree,'textarea')[0].props.onChange({target:{value:'保留草稿'}});tree=f.render(()=>AgentRoom(props));
  const button=elements(tree,'button').find(n=>n.props.className==='ar-send');assert.equal(button.props.disabled,true);await button.props.onClick();elements(tree,'textarea')[0].props.onKeyDown({ctrlKey:true,key:'Enter',preventDefault(){}});await f.flush();tree=f.render(()=>AgentRoom(props));
  assert.equal(sent,0);assert.equal(elements(tree,'textarea')[0].props.value,'保留草稿');assert.match(text(tree),/模拟/);
});
test('主屏和设置把模拟状态传给真实调用入口',()=>{const app=readFileSync('src/App.tsx','utf8'),workspace=readFileSync('src/components/Workspace.tsx','utf8');assert.match(app,/<ApiConnectionsSettings[^>]*simulationEnabled=/);assert.match(workspace,/<AgentRoom[^>]*simulationEnabled=/)});
test('后端各推理入口在读凭据和写消息前检查统一闸门',()=>{
  for(const[file,name]of[['agent_room_workspace.rs','agent_room_workspace_send'],['agent_room.rs','agent_room_chat_send'],['agent_room.rs','agent_room_reply'],['daily_recommendations.rs','generate_daily_recommendations'],['analysis.rs','analyze_history_remote']]){
    const source=readFileSync('src-tauri/src/'+file,'utf8');const start=source.indexOf('pub async fn '+name+'(');assert.ok(start>=0);const prefix=source.slice(start,source.indexOf('spawn_blocking',start));assert.match(prefix,/simulation::require_live\(\)/,name);
  }
});
test('等待同步时切进模拟会在发送IPC前拒绝',async()=>{const f=fixture(false),{nativeWorkspace}=f.load('src/services/roomWorkspace.ts');let sent=0;const service=nativeWorkspace(async()=>{sent++;return{}});const pending=service.send(request);f.setMode(true);await assert.rejects(pending,/模拟/);assert.equal(sent,0)});
test('同步失败时保持关闭，不能退回真实发送',async()=>{const f=fixture(false,async()=>{throw Error('native sync failed')}),policy=f.load('src/services/simulationSafety.ts'),{nativeWorkspace}=f.load('src/services/roomWorkspace.ts');await assert.rejects(policy.syncSimulationMode(false),/sync failed/);let sent=0;await assert.rejects(nativeWorkspace(async()=>{sent++;return{}}).send(request),/sync failed/);assert.equal(sent,0)});
test('开启再关闭模拟不能复活等待中的旧发送',async()=>{
 let release;const f=fixture(false,async()=>new Promise(resolve=>{release=resolve})),policy=f.load('src/services/simulationSafety.ts'),{nativeWorkspace}=f.load('src/services/roomWorkspace.ts');
 const initial=policy.syncSimulationMode(false);await f.flush();let sent=0;const pending=nativeWorkspace(async()=>{sent++;return{}}).send(request);const rejected=assert.rejects(pending,/模拟/);
 f.setMode(true);const on=policy.syncSimulationMode(true);f.setMode(false);const off=policy.syncSimulationMode(false);release();await initial;await f.flush();release();await on;await f.flush();release();await off;await rejected;assert.equal(sent,0);
});
test('自动推荐调用复用隔离服务，不在模拟中发送',async()=>{const f=fixture(true),{invokeLive}=f.load('src/services/simulationSafety.ts');await assert.rejects(invokeLive('generate_daily_recommendations',{consent:true}),/模拟/);assert.equal(f.calls.length,0);assert.match(readFileSync('src/components/DailyOpenSource.tsx','utf8'),/invokeLive<unknown>\("generate_daily_recommendations"/)});
test('正常模式推荐生成仍只发送一次',async()=>{const f=fixture(false),{__Connection:Connection}=f.load('src/components/ApiConnectionsSettings.tsx');const props={source:'mimo',connections:{mimoEnabled:true,credentialRevision:0},onChange(){},simulationEnabled:false};let tree=f.render(()=>Connection(props));await f.flush();tree=f.render(()=>Connection(props));const button=elements(tree,'button').find(n=>text(n).includes('生成今日中文介绍'));assert.equal(button.props.disabled,false);button.props.onClick();await f.flush();assert.equal(f.calls.filter(c=>c.command==='generate_daily_recommendations').length,1)});

test('模拟设置尚未落盘时，余额登录连接和刷新仍被界面状态拦截',async()=>{
 const f=fixture(false),{__Balance:Balance}=f.load('src/components/ApiConnectionsSettings.tsx');const props={connections:{credentialRevision:0},onChange(){},simulationEnabled:true};
 let tree=f.render(()=>Balance(props));await f.flush();tree=f.render(()=>Balance(props));
 for(const label of ['打开 MiMo 官方登录','登录完成，连接余额','刷新余额']){const button=elements(tree,'button').find(n=>text(n)===label);assert.ok(button,label);assert.equal(button.props.disabled,true);button.props.onClick();await f.flush()}
 assert.equal(f.calls.length,0);
});

test('每日推荐卡片的生成和刷新事件不能绕过模拟停用',async()=>{
 const f=fixture(false),{DailyOpenSource}=f.load('src/components/DailyOpenSource.tsx');
 const tree=f.render(()=>DailyOpenSource({connections:{mimoEnabled:true,mimoDailyAuto:true},enabled:false}));
 tree.props.onGenerate();tree.props.onRefresh();await f.flush();assert.equal(f.calls.length,0);
});

test('自动推荐等待读取榜单时开启模拟，不再跟发付费生成',async()=>{
 let release;const f=fixture(false,async command=>{if(command==='read_daily_recommendations')return new Promise(resolve=>{release=resolve});throw Error('unexpected '+command)});
 const {DailyOpenSource,beijingDate}=f.load('src/components/DailyOpenSource.tsx');
 f.render(()=>DailyOpenSource({connections:{mimoEnabled:true,mimoDailyAuto:true},enabled:true}));await f.flush();
 assert.equal(typeof release,'function');f.setMode(true);
 release({schemaVersion:1,source:'GitHub Trending',date:beijingDate(),collectedAt:new Date().toISOString(),items:[{repo:'test/project',url:'https://github.com/test/project',description:'mock',language:'TS',stars:'1',todayStars:'1'}],translationStatus:'pending',status:'ok'});
 await f.flush();assert.equal(f.calls.filter(c=>c.command==='generate_daily_recommendations').length,0);
});
