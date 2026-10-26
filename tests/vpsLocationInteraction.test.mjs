import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {transformSync} from 'esbuild';

// Execute the real private component and safety service with synthetic hooks/IPC.
function fixture(invokeImpl){
 const slots=[],effects=[],calls=[];let cursor=0,visible=true,onVisibility=()=>{};
 const settings={simulationEnabled:false};
 const context=createContext({Date,JSON,console,window:{setInterval(){return 1},clearInterval(){}},CardHeading(){},CpuParticles(){}});
 const jsx=(type,props)=>({type,props});
 const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v}]},
  useEffect(fn,deps){const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i].deps[j])){const old=slots[i];effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()}})}}};
 const stubs={'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'@tauri-apps/api/core':{isTauri:()=>true,invoke:async(command,args)=>{calls.push({command,args});return invokeImpl(command,args)}},'../providers/settingsStore':{loadSettings:()=>settings}};
 const evaluate=(code)=>{const module={exports:{}};const source=transformSync(code,{loader:'tsx',format:'cjs',jsx:'automatic'}).code;
  runInContext(`(function(require,module,exports){${source}\n})`,context)(name=>{if(!(name in stubs))throw Error('Unexpected dependency '+name);return stubs[name]},module,module.exports);return module.exports;};
 Object.assign(context,hooks,evaluate(readFileSync('src/presentation/vpsAdapter.ts','utf8')),evaluate(readFileSync('src/services/simulationSafety.ts','utf8')),{isTauri:()=>true,isWindowVisible:()=>visible,subscribeWindowVisibility:fn=>{onVisibility=fn;return()=>{onVisibility=()=>{}}}});
 const code=readFileSync('src/widgets/WidgetCard.tsx','utf8');const {VpsWidget}=evaluate(code.slice(code.indexOf('function VpsWidget('),code.indexOf('function HealthWidget('))+'\nexport {VpsWidget};');
 return{calls,render(props){cursor=0;return VpsWidget(props)},setMode(value){settings.simulationEnabled=value},setVisible(value){visible=value;onVisibility()},async flush(){for(let i=0;i<6;i++){for(const effect of effects.splice(0))effect();await new Promise(r=>setImmediate(r))}}};
}
const data=host=>({vps:{host,serverId:'one',name:'test',state:'online',gauges:[{label:'CPU',value:12}],network:{},services:[],uptime:'运行中'},providerDiagnostics:[]});
const props=host=>({data:data(host),vpsConsole:true,vpsHubUrl:'http://127.0.0.1:8090',simulationEnabled:false});
const result=(ip,countryZh='日本',countryEn='Japan')=>({ip,countryZh,countryEn,cityZh:'东京',cityEn:'Tokyo',source:'ipwho.is',lookedUpAtUnixMs:Date.now()});
function text(tree){if(tree==null||typeof tree==='boolean')return'';if(typeof tree!=='object')return String(tree);if(Array.isArray(tree))return tree.map(text).join('');return text(tree.props?.children)}

test('模拟模式即使有服务器地址也不发所在地命令',async()=>{const f=fixture(()=>{throw Error('unexpected IPC')});f.setMode(true);f.render({...props('1.1.1.1'),simulationEnabled:true});await f.flush();assert.equal(f.calls.length,0)});
test('正常查询只传服务器host，不把本机Hub地址发给定位服务',async()=>{const f=fixture(async()=>result('1.1.1.1'));let tree=f.render(props('1.1.1.1'));await f.flush();tree=f.render(props('1.1.1.1'));assert.equal(f.calls.length,1);assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])),{command:'read_vps_location',args:{host:'1.1.1.1'}});assert.match(text(tree),/日本 \/ Japan/);assert.match(text(tree),/东京 \/ Tokyo/)});
test('切换服务器会立即隐藏旧所在地，旧请求迟到也不覆盖新服务器',async()=>{
 const pending=new Map();const f=fixture((command,args)=>new Promise(resolve=>pending.set(args.host,resolve)));
 f.render(props('1.1.1.1'));await f.flush();f.render(props('8.8.8.8'));await f.flush();pending.get('1.1.1.1')(result('1.1.1.1'));await f.flush();assert.doesNotMatch(text(f.render(props('8.8.8.8'))),/日本 \/ Japan/);
 pending.get('8.8.8.8')(result('8.8.8.8','美国','United States'));await f.flush();assert.match(text(f.render(props('8.8.8.8'))),/美国 \/ United States/);
});
test('窗口隐藏暂停查询，查询失败不影响CPU和在线状态',async()=>{
 const f=fixture(async()=>{throw '所在地暂不可用'});f.setVisible(false);f.render(props('1.1.1.1'));await f.flush();assert.equal(f.calls.length,0);
 f.setVisible(true);await f.flush();const tree=f.render(props('1.1.1.1'));assert.equal(f.calls.length,1);assert.match(text(tree),/所在地暂不可用/);assert.match(text(tree),/在线/);assert.match(text(tree),/12/);assert.match(text(tree),/未知 \/ Unknown/);
});
test('定位响应时间无效时保持未知，不让VPS卡片渲染失败',async()=>{
 const f=fixture(async()=>({...result('1.1.1.1'),lookedUpAtUnixMs:NaN}));f.render(props('1.1.1.1'));await f.flush();
 const tree=f.render(props('1.1.1.1'));assert.match(text(tree),/所在地返回格式无效/);assert.match(text(tree),/在线/);assert.match(text(tree),/未知 \/ Unknown/);
});
