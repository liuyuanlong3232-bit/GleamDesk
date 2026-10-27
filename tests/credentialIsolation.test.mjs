import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {transformSync} from 'esbuild';

function fixture({settings,legacy=true,simulation=false,failImport=false,choice=''}={}){
  const values=new Map(),calls=[],slots=[],effects=[];let cursor=0,updated=0;
  if(settings)values.set('codex-desktop.settings.v1',JSON.stringify(settings));
  if(choice)values.set('gleamdesk.legacy-credentials.choice.v1',choice);
  const localStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
  const react={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v}]},useEffect(fn){const i=cursor++;if(!slots[i]){slots[i]=true;effects.push(fn)}}};
  const jsx=(type,props)=>({type,props});
  const deps={react,'react/jsx-runtime':{jsx,jsxs:jsx},'@tauri-apps/api/core':{isTauri:()=>true},
    '../services/credentials':{hasLegacyCredentials:async()=>{calls.push('inspect');return legacy},importLegacyCredentials:async consent=>{calls.push({command:'import',consent});if(failImport)throw '导入中止，旧账号保留';return 2}},
    '../providers/api/apiUsageProvider':{},'../services/formatMoney':{},'./DailyOpenSource':{},'../services/simulationSafety':{},
    '../presentation/theme':{normalizeTheme:v=>v??'burgundy',themeAccent:()=> '#c2263f'},'../services/appLogger':{logEvent(){}},
    '../services/notifications/policy':{normalizeNotificationPreferences:v=>v??{}},'../domain/analysis/remoteSettings':{normalizeRemoteAnalysisSettings:v=>v??{}},
  };
  const context=createContext({localStorage,Date,console});
  const load=path=>{const module={exports:{}};const code=transformSync(readFileSync(path,'utf8'),{loader:path.endsWith('tsx')?'tsx':'ts',format:'cjs',jsx:'automatic'}).code;
    runInContext(`(function(require,module,exports){${code}\n})`,context)(name=>{if(!(name in deps))throw Error('Unexpected dependency '+name);return deps[name]},module,module.exports);return module.exports;};
  const {LegacyCredentialImport}=load('src/components/ApiConnectionsSettings.tsx');
  return{values,calls,load,get updated(){return updated},render(){cursor=0;return LegacyCredentialImport({simulationEnabled:simulation,onImported:()=>updated++})},async flush(){for(const fn of effects.splice(0))fn();await new Promise(resolve=>setImmediate(resolve))}};
}
function elements(tree,type){if(!tree||typeof tree!=='object')return[];if(Array.isArray(tree))return tree.flatMap(t=>elements(t,type));return[...(tree.type===type?[tree]:[]),...elements(tree.props?.children,type)]}
function text(tree){if(tree==null||typeof tree==='boolean')return'';if(typeof tree!=='object')return String(tree);if(Array.isArray(tree))return tree.map(text).join('');return text(tree.props?.children)}
const button=(tree,label)=>elements(tree,'button').find(b=>text(b)===label);

test('fresh profiles remain unconfigured; existing watchlist and history storage are untouched',()=>{
  const f=fixture(),store=f.load('src/providers/settingsStore.ts');
  const before=JSON.stringify([...f.values]);const settings=store.loadSettings();
  assert.equal(settings.credentialNamespaceVersion,1);assert.equal(settings.apiConnections.deepseekEnabled,false);assert.equal(settings.apiConnections.mimoDailyAuto,false);
  assert.equal(JSON.stringify([...f.values]),before);
});
test('namespace transition keeps preferences and connections but requires renewed automatic-paid consent',()=>{
  const f=fixture({settings:{displayName:'fixture user',theme:'ocean',beszelUrl:'http://127.0.0.1:8090',apiConnections:{deepseekEnabled:true,mimoEnabled:true,mimoDailyAuto:true}}});
  f.values.set('codex-desktop.market-watchlist.v1','synthetic watchlist');f.values.set('history-fixture','synthetic history');
  const store=f.load('src/providers/settingsStore.ts'),settings=store.loadSettings();
  assert.equal(settings.displayName,'fixture user');assert.equal(settings.beszelUrl,'http://127.0.0.1:8090');assert.equal(settings.apiConnections.deepseekEnabled,true);assert.equal(settings.apiConnections.mimoEnabled,true);assert.equal(settings.apiConnections.mimoDailyAuto,false);
  store.saveSettings(settings);assert.equal(f.values.get('codex-desktop.market-watchlist.v1'),'synthetic watchlist');assert.equal(f.values.get('history-fixture'),'synthetic history');
});
test('subsequent GleamDesk updates preserve saved credentials marker and renewed paid setting',()=>{
  const f=fixture({settings:{credentialNamespaceVersion:1,apiConnections:{mimoEnabled:true,mimoDailyAuto:true,credentialRevision:123}}});
  const store=f.load('src/providers/settingsStore.ts'),settings=store.loadSettings();store.saveSettings(settings);const reloaded=store.loadSettings();
  assert.equal(reloaded.apiConnections.mimoDailyAuto,true);assert.equal(reloaded.apiConnections.credentialRevision,123);assert.equal(reloaded.credentialNamespaceVersion,1);
});
test('no legacy account means no import prompt or import call',async()=>{
  const f=fixture({legacy:false});f.render();await f.flush();assert.equal(f.render(),null);assert.deepEqual(f.calls,['inspect']);
});
test('detecting legacy credentials never imports without explicit checkbox consent',async()=>{
  const f=fixture();f.render();await f.flush();let tree=f.render();assert.equal(button(tree,'导入账号').props.disabled,true);
  await button(tree,'导入账号').props.onClick();await f.flush();assert.deepEqual(f.calls,['inspect']);
  elements(tree,'input')[0].props.onChange({target:{checked:true}});tree=f.render();assert.equal(button(tree,'导入账号').props.disabled,false);
  await button(tree,'导入账号').props.onClick();await f.flush();tree=f.render();
  assert.deepEqual(f.calls,['inspect',{command:'import',consent:true}]);assert.match(text(tree),/已导入 2 项/);assert.equal(f.updated,1);assert.equal(f.values.get('gleamdesk.legacy-credentials.choice.v1'),'imported');
});
test('skip persists without importing; the settings retain a manual re-entry',async()=>{
  const f=fixture();f.render();await f.flush();button(f.render(),'暂不导入').props.onClick();
  assert.equal(f.values.get('gleamdesk.legacy-credentials.choice.v1'),'skipped');assert.ok(button(f.render(),'导入旧版账号…'));assert.deepEqual(f.calls,['inspect']);
});
test('simulation mode blocks import even if a stale handler is invoked',async()=>{
  const f=fixture({simulation:true});f.render();await f.flush();let tree=f.render();elements(tree,'input')[0].props.onChange({target:{checked:true}});tree=f.render();
  assert.equal(button(tree,'导入账号').props.disabled,true);await button(tree,'导入账号').props.onClick();await f.flush();assert.deepEqual(f.calls,['inspect']);
});
test('failed imports preserve choice and show a retry without claiming success',async()=>{
  const f=fixture({failImport:true});f.render();await f.flush();let tree=f.render();elements(tree,'input')[0].props.onChange({target:{checked:true}});tree=f.render();
  await button(tree,'导入账号').props.onClick();await f.flush();tree=f.render();assert.match(text(tree),/导入中止/);assert.equal(f.values.has('gleamdesk.legacy-credentials.choice.v1'),false);assert.equal(button(tree,'导入账号').props.disabled,false);assert.equal(f.updated,1);
});
