import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {transformSync} from 'esbuild';

const initial={startupRegistered:false,startupMatchesCurrent:false,startupRevision:'fixture-revision',startupError:null,iconsHidden:false,iconsError:null};
function fixture({status=initial,native=true,readFailure=false,writeFailure=false,deferRead=false,deferWrite=false}={}){
 const slots=[],effects=[],calls=[];let cursor=0,resolveRead,resolveWrite;
 const react={useState(value){const i=cursor++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return[slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next}]},useRef(value){const i=cursor++;return slots[i]??(slots[i]={current:value})},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn()})}}};
 const deps={react,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},'@tauri-apps/api/core':{isTauri:()=>native},'../services/simulationSafety':{invokeLive:async(command,args)=>{
  calls.push({command,args:args&&JSON.parse(JSON.stringify(args))});
  if(command==='read_windows_desktop_settings'){if(deferRead)await new Promise(r=>resolveRead=r);if(readFailure)throw '读取失败';return {...status};}
  if(deferWrite)await new Promise(r=>resolveWrite=r);
  if(writeFailure)throw '更改失败，请刷新';
  if(command==='set_windows_autostart')return {...status,startupRegistered:args.enabled,startupMatchesCurrent:args.enabled};
  if(command==='set_windows_desktop_icons')return {...status,iconsHidden:args.hidden};
  throw Error('Unexpected command');
 }}};
 const context=createContext({console}),module={exports:{}};
 const code=transformSync(readFileSync('src/components/DesktopSystemSettings.tsx','utf8'),{loader:'tsx',format:'cjs',jsx:'automatic'}).code;
 runInContext(`(function(require,module,exports){${code}\n})`,context)(name=>{assert.ok(name in deps,name);return deps[name]},module,module.exports);
 return{calls,render(simulationEnabled=false){cursor=0;return module.exports.DesktopSystemSettings({simulationEnabled})},async flush(){for(const effect of effects.splice(0))effect();await new Promise(r=>setImmediate(r));},resolveRead(){resolveRead?.()},resolveWrite(){resolveWrite?.()}};
}
function elements(tree,type){if(!tree||typeof tree!=='object')return[];if(Array.isArray(tree))return tree.flatMap(t=>elements(t,type));return[...(tree.type===type?[tree]:[]),...elements(tree.props?.children,type)]}
function text(tree){if(tree==null||typeof tree==='boolean')return'';return typeof tree!=='object'?String(tree):Array.isArray(tree)?tree.map(text).join(''):text(tree.props?.children)}
const input=(tree,label)=>elements(tree,'input').find(node=>node.props['aria-label']===label);
const button=(tree,label)=>elements(tree,'button').find(node=>text(node)===label);
async function ready(f){f.render();await f.flush();return f.render()}
const startup='登录 Windows 时启动',icons='隐藏 Windows 桌面图标';

test('mount only reads real Windows state and never applies old local preferences',async()=>{
 const f=fixture(),tree=await ready(f);assert.equal(f.calls.length,1);assert.equal(f.calls[0].command,'read_windows_desktop_settings');assert.equal(input(tree,startup).props.checked,false);assert.equal(input(tree,icons).props.checked,false);
});
test('changing either switch requires confirmation; cancellation performs no mutation',async()=>{
 for(const label of [startup,icons]){const f=fixture();let tree=await ready(f);input(tree,label).props.onChange({target:{checked:true}});tree=f.render();assert.ok(button(tree,'确认更改'));assert.equal(input(tree,label).props.checked,false);assert.equal(f.calls.length,1);button(tree,'取消').props.onClick();assert.equal(button(f.render(),'确认更改'),undefined);assert.equal(f.calls.length,1);}
});
test('confirmed startup change carries current revision and explicit consent, then uses readback',async()=>{
 const f=fixture();let tree=await ready(f);input(tree,startup).props.onChange({target:{checked:true}});button(f.render(),'确认更改').props.onClick();await f.flush();tree=f.render();assert.deepEqual(f.calls[1],{command:'set_windows_autostart',args:{enabled:true,expectedRevision:'fixture-revision',confirmed:true}});assert.equal(input(tree,startup).props.checked,true);assert.match(text(tree),/已添加/);
});
test('icon restore uses observed state and remains independent from startup registration',async()=>{
 const f=fixture({status:{...initial,iconsHidden:true}});let tree=await ready(f);input(tree,icons).props.onChange({target:{checked:false}});button(f.render(),'确认更改').props.onClick();await f.flush();tree=f.render();assert.deepEqual(f.calls[1],{command:'set_windows_desktop_icons',args:{hidden:false,expectedHidden:true,confirmed:true}});assert.equal(input(tree,icons).props.checked,false);assert.equal(input(tree,startup).props.checked,false);
});
test('Explorer unavailable does not disable an otherwise readable startup control',async()=>{
 const f=fixture({status:{...initial,iconsHidden:null,iconsError:'Explorer 暂不可用'}}),tree=await ready(f);assert.equal(input(tree,icons).props.disabled,true);assert.equal(input(tree,startup).props.disabled,false);assert.match(text(tree),/Explorer 暂不可用/);
});
test('read and write failures disable stale controls without claiming success',async()=>{
 const reading=fixture({readFailure:true}),unavailable=await ready(reading);assert.equal(input(unavailable,startup).props.disabled,true);assert.match(text(unavailable),/读取失败/);
 const f=fixture({writeFailure:true});let tree=await ready(f);input(tree,startup).props.onChange({target:{checked:true}});button(f.render(),'确认更改').props.onClick();await f.flush();tree=f.render();assert.equal(input(tree,startup).props.disabled,true);assert.match(text(tree),/更改失败/);assert.doesNotMatch(text(tree),/已添加当前用户/);assert.equal(button(tree,'确认更改'),undefined);
});
test('simulation and browser preview never read or write system state',async()=>{
 const f=fixture();f.render(true);await f.flush();assert.equal(f.calls.length,0);assert.match(text(f.render(true)),/模拟模式不读取或修改/);
 const browser=fixture({native:false}),tree=await ready(browser);assert.equal(browser.calls.length,0);assert.equal(input(tree,startup).props.disabled,true);
});
test('late reads cannot reactivate controls after entering simulation',async()=>{
 const f=fixture({deferRead:true});f.render();await f.flush();f.render(true);await f.flush();f.resolveRead();await f.flush();const tree=f.render(true);assert.equal(input(tree,startup).props.disabled,true);assert.equal(button(tree,'确认更改'),undefined);assert.equal(f.calls.length,1);
});
test('rapid duplicate confirmations dispatch only one native mutation',async()=>{
 const f=fixture({deferWrite:true});let tree=await ready(f);input(tree,startup).props.onChange({target:{checked:true}});const click=button(f.render(),'确认更改').props.onClick;click();click();await f.flush();assert.equal(f.calls.filter(c=>c.command==='set_windows_autostart').length,1);f.resolveWrite();await f.flush();assert.equal(input(f.render(),startup).props.checked,true);
});
