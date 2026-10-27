import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {transformSync} from 'esbuild';

const release={currentVersion:'0.1.2',latestVersion:'0.2.0',newer:true,canInstall:true,notes:'<script>plain release text</script>',releaseUrl:'https://github.com/liuyuanlong3232-bit/GleamDesk/releases/tag/v0.2.0',installHint:'保存输入后确认安装'};
function fixture({result=release,failCheck=false,failInstall=false,defer=false,native=true,storage=new Map()}={}){
 const slots=[],effects=[],calls=[],timers=new Map(),listeners=new Map();let cursor=0,timerId=0,resolveCheck,choice;
 const react={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v}]},useRef(initial){const i=cursor++;return slots[i]??(slots[i]={current:initial})},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,n)=>!Object.is(v,old.deps[n]))){slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn()})}}};
 const context=createContext({console,URL,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},window:{setTimeout(fn){timers.set(++timerId,fn);return timerId},clearTimeout(id){timers.delete(id)}}});
 const deps={react,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},'@tauri-apps/api/core':{isTauri:()=>native,invoke:async(command,args)=>{calls.push({command,args});if(command==='check_app_update'){if(defer)await new Promise(r=>resolveCheck=r);if(failCheck)throw '网络不可用';return result}if(command==='install_app_update'){if(failInstall)throw '更新签名校验失败，当前版本未替换';return}throw Error('Unexpected command')}},'@tauri-apps/api/event':{listen:async(name,callback)=>{listeners.set(name,callback);return()=>listeners.delete(name)}},'./launcher/launcherService':{launchApplication:async app=>{calls.push({command:'open-release',target:app.target})}},'../../package.json':{version:'0.1.2'}};
 const load=path=>{const module={exports:{}};const code=transformSync(readFileSync(path,'utf8'),{loader:path.endsWith('tsx')?'tsx':'ts',format:'cjs',jsx:'automatic'}).code;runInContext(`(function(require,module,exports){${code}\n})`,context)(name=>{if(!(name in deps))throw Error('Unexpected dependency '+name);return deps[name]},module,module.exports);return module.exports};
 const service=load('src/services/appUpdates.ts');deps['../services/appUpdates']=service;
 const components=load('src/components/AppUpdates.tsx');
 return{calls,service,timers,resolve(){resolveCheck?.()},get choice(){return choice},render(simulationEnabled=false){cursor=0;return components.AppUpdateSettings({automatic:true,onAutomaticChange:v=>choice=v,simulationEnabled})},indicator(enabled=true){cursor=0;return components.AppUpdateIndicator({enabled,onOpen:()=>calls.push({command:'open-settings'})})},async flush(){for(const effect of effects.splice(0))effect();await new Promise(r=>setImmediate(r))},runTimers(){for(const[id,fn]of timers){timers.delete(id);fn()}},emit(name,value){listeners.get(name)?.({payload:value})}};
}
function elements(tree,type){if(!tree||typeof tree!=='object')return[];if(Array.isArray(tree))return tree.flatMap(t=>elements(t,type));return[...(tree.type===type?[tree]:[]),...elements(tree.props?.children,type)]}
function text(tree){if(tree==null||typeof tree==='boolean')return'';if(typeof tree!=='object')return String(tree);if(Array.isArray(tree))return tree.map(text).join('');return text(tree.props?.children)}
const button=(tree,label)=>elements(tree,'button').find(b=>text(b)===label);
async function checked(f){f.render();await f.flush();await button(f.render(),'检查更新').props.onClick();await f.flush();return f.render()}

test('manual checking never downloads or installs, and opt-out only changes its preference',async()=>{
 const f=fixture();let tree=await checked(f);assert.match(text(tree),/发现新版 0.2.0/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].command,'check_app_update');assert.equal(f.calls[0].args.force,true);
 elements(tree,'input')[0].props.onChange({target:{checked:false}});assert.equal(f.choice,false);assert.equal(f.calls.length,1);
});
test('install requires the visible confirmation and saved-input checkbox; cancel never invokes install',async()=>{
 const f=fixture();let tree=await checked(f);button(tree,'下载并更新').props.onClick();tree=f.render();assert.equal(button(tree,'确认退出并更新').props.disabled,true);
 await button(tree,'确认退出并更新').props.onClick();assert.equal(f.calls.length,1);
 elements(tree,'input')[1].props.onChange({target:{checked:true}});tree=f.render();button(tree,'取消').props.onClick();tree=f.render();assert.equal(button(tree,'确认退出并更新'),undefined);assert.equal(f.calls.length,1);
 button(tree,'下载并更新').props.onClick();tree=f.render();assert.equal(elements(tree,'input')[1].props.checked,false);elements(tree,'input')[1].props.onChange({target:{checked:true}});
 await button(f.render(),'确认退出并更新').props.onClick();assert.equal(f.calls.length,2);assert.equal(f.calls[1].command,'install_app_update');assert.equal(f.calls[1].args.expectedVersion,'0.2.0');assert.equal(f.calls[1].args.consent,true);
});
test('a failed signature or installer launch is reported without claiming replacement or automatically retrying',async()=>{
 const f=fixture({failInstall:true});let tree=await checked(f);button(tree,'下载并更新').props.onClick();tree=f.render();elements(tree,'input')[1].props.onChange({target:{checked:true}});await button(f.render(),'确认退出并更新').props.onClick();await f.flush();tree=f.render();
 assert.match(text(tree),/更新签名校验失败，当前版本未替换/);assert.doesNotMatch(text(tree),/安装器已启动/);assert.equal(button(tree,'确认退出并更新'),undefined);assert.equal(f.calls.filter(c=>c.command==='install_app_update').length,1);
});
test('network failure is never presented as latest and allows an explicit retry',async()=>{
 const f=fixture({failCheck:true}),tree=await checked(f);assert.match(text(tree),/网络不可用/);assert.doesNotMatch(text(tree),/已是最新正式版|下载并更新/);assert.equal(button(tree,'检查更新').props.disabled,false);
});
test('rapid duplicate checks share one UI operation instead of issuing a second native request',async()=>{
 const f=fixture({defer:true});f.render();await f.flush();const click=button(f.render(),'检查更新').props.onClick;click();click();await f.flush();assert.equal(f.calls.length,1);f.resolve();await f.flush();assert.match(text(f.render()),/发现新版/);
});
test('unsigned releases and portable builds keep the download page without an install action',async()=>{
 const f=fixture({result:{...release,canInstall:false,installHint:'请到发布页手动下载'}}),tree=await checked(f);assert.equal(button(tree,'下载并更新'),undefined);assert.match(text(tree),/手动下载/);await button(tree,'打开发布页 ↗').props.onClick();assert.equal(f.calls[1].target,release.releaseUrl);
});
test('equal remote versions do not offer an install action',async()=>{
 const f=fixture({result:{...release,newer:false,canInstall:false,latestVersion:'0.1.2'}}),tree=await checked(f);assert.match(text(tree),/当前已是最新正式版/);assert.equal(button(tree,'下载并更新'),undefined);
});
test('a development version ahead of GitHub is described without claiming it is the published latest',async()=>{
 const f=fixture({result:{...release,newer:false,canInstall:false,latestVersion:'0.1.1'}}),tree=await checked(f);assert.match(text(tree),/高于已发布版 0.1.1/);assert.doesNotMatch(text(tree),/已是最新正式版/);assert.equal(button(tree,'下载并更新'),undefined);
});
test('simulation prevents checking and a late response cannot restore a real update card',async()=>{
 const f=fixture({defer:true});f.render();await f.flush();const request=button(f.render(),'检查更新').props.onClick();await f.flush();f.render(true);await f.flush();f.resolve();await request;const tree=f.render(true);assert.match(text(tree),/模拟模式不检查或安装真实更新/);assert.doesNotMatch(text(tree),/发现新版/);await button(tree,'检查更新').props.onClick();assert.equal(f.calls.length,1);
});
test('startup checks are delayed once, only announce a newer version, and never install',async()=>{
 const f=fixture();assert.equal(f.indicator(),null);await f.flush();assert.equal(f.calls.length,0);assert.equal(f.timers.size,1);f.runTimers();await f.flush();const tree=f.indicator();assert.match(tree.props['aria-label'],/0.2.0/);tree.props.onClick();assert.deepEqual(f.calls.map(c=>c.command),['check_app_update','open-settings']);
 f.indicator(false);await f.flush();assert.equal(f.indicator(false),null);assert.equal(f.timers.size,0);
});
test('startup failures and disabled startup checks do not interrupt the desktop or invoke installs',async()=>{
 const f=fixture({failCheck:true});f.indicator();await f.flush();f.runTimers();await f.flush();assert.equal(f.indicator(),null);assert.equal(f.calls.length,1);
 const disabled=fixture();disabled.indicator(false);await disabled.flush();disabled.runTimers();assert.equal(disabled.calls.length,0);
});
test('the HUD result is available in a newly opened settings WebView without another network request',async()=>{
 const storage=new Map(),hud=fixture({storage});hud.indicator();await hud.flush();hud.runTimers();await hud.flush();
 const settings=fixture({storage});let tree=settings.render();await settings.flush();tree=settings.render();assert.match(text(tree),/发现新版 0.2.0/);assert.ok(button(tree,'下载并更新'));assert.equal(settings.calls.length,0);
});
test('cached reports expire, do not cross app versions, and are removed after a failed check',async()=>{
 const storage=new Map(),first=fixture({storage});await checked(first);const key='gleamdesk.update-status.v1',valid=storage.get(key);
 storage.set(key,JSON.stringify({...JSON.parse(valid),checkedAt:Date.now()-3600_001}));assert.equal(fixture({storage}).service.loadLastAppUpdate(),null);
 const other=JSON.parse(valid);other.report.currentVersion='0.0.1';storage.set(key,JSON.stringify(other));assert.equal(fixture({storage}).service.loadLastAppUpdate(),null);
 storage.set(key,valid);await checked(fixture({storage,failCheck:true}));assert.equal(storage.has(key),false);assert.equal(fixture({storage}).service.loadLastAppUpdate(),null);
});
test('service rejects an unconfirmed install and external release URLs before native IPC',async()=>{
 const f=fixture();await assert.rejects(f.service.installAppUpdate('0.2.0',false));for(const url of ['https://evil.test/release','https://github.com/other/repo/releases/latest',release.releaseUrl+'?token=secret','file:///C:/app.exe'])await assert.rejects(f.service.openReleasePage(url));assert.equal(f.calls.length,0);
 const browser=fixture({native:false});await assert.rejects(browser.service.checkAppUpdate());await assert.rejects(browser.service.installAppUpdate('0.2.0',true));assert.equal(browser.calls.length,0);
});
