import assert from "node:assert/strict";
import {test} from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {parseWorldBankMonthly,worldBankSeries} from "../src/domain/agriculture/publicReferenceData";
import {createPublicMonthlyProvider} from "../src/providers/publicDataProviders";
import {PublicMonthlyPrices} from "../src/components/PublicAgricultureReference";
import {DataSourceConnectionsSettings} from "../src/components/DataSourceConnectionsSettings";
import {emptySnapshotConnection} from "../src/domain/agriculture/contracts";
import {providersFor} from "../src/providers/registry";
import {createProviderRuntime} from "../src/providers/providerRuntime";
import {syncSimulationMode} from "../src/services/simulationSafety";

const at="2026-10-23T00:00:00Z";
const payload=()=>({period:"2026-09-01",updatedOn:"2026-10-02",items:worldBankSeries.map((s,i)=>({header:s.header,unit:s.rawUnit,date:"2026-09-01",value:i}))});
const receipt=(data:unknown=payload())=>({key:"worldbank-monthly",collectedAt:at,sourceUrl:"https://thedocs.worldbank.org/en/doc/example-0050012026/related/CMO-Historical-Data-Monthly.xlsx",body:JSON.stringify(data)});
async function native(run:()=>Promise<void>){
 const oldWindow=Object.getOwnPropertyDescriptor(globalThis,"window"),oldTauri=Object.getOwnPropertyDescriptor(globalThis,"isTauri");
 Object.defineProperty(globalThis,"window",{value:globalThis,configurable:true});Object.defineProperty(globalThis,"isTauri",{value:true,configurable:true});
 try{await run();}finally{await syncSimulationMode(false);clearMocks();if(oldWindow)Object.defineProperty(globalThis,"window",oldWindow);else Reflect.deleteProperty(globalThis,"window");if(oldTauri)Object.defineProperty(globalThis,"isTauri",oldTauri);else Reflect.deleteProperty(globalThis,"isTauri");}
}
test("世行月价保留来源、文件更新时间、原单位和两个小麦品种",()=>{
 const s=parseWorldBankMonthly(receipt());assert.equal(s.source,"worldbank");assert.equal(s.updatedOn,"2026-10-02");assert.equal(s.items[0].value,0);assert.deepEqual(s.items.map(r=>r.name),["玉米","美国软红冬麦","美国硬红冬麦","世界食糖","棉花 A 指数"]);assert.equal(s.items[3].unit,"美元/千克");assert.equal(s.items[0].date,"2026-09-01");
});
test("本期缺值保留实际旧月份，缺品种不补零",()=>{
 const p=payload();p.items[1].date="2026-08-01";const s=parseWorldBankMonthly(receipt(p));assert.equal(s.items[1].date,"2026-08-01");assert.match(s.items[1].warning!,/本期缺值/);
 const p2=payload() as {items:{date:string|null;value:number|null}[]};p2.items[2].date=null;p2.items[2].value=null;assert.equal(parseWorldBankMonthly(receipt(p2)).items[2].value,null);
});
test("错列、重复商品、错误单位和无效数值全部拒绝",()=>{
 for(const mutate of [(p:ReturnType<typeof payload>)=>{p.items.pop();},(p:ReturnType<typeof payload>)=>{p.items[1]={...p.items[0]};},(p:ReturnType<typeof payload>)=>{p.items[3].unit="cents/lb" as typeof p.items[3]["unit"];},(p:ReturnType<typeof payload>)=>{p.items[0].value=-1;},(p:ReturnType<typeof payload>)=>{p.items[0].value=Number.NaN;}]){const p=payload();mutate(p);assert.throws(()=>parseWorldBankMonthly(receipt(p)));}
});
test("假日期、未来日期、非月初价格和错误来源拒绝",()=>{
 for(const patch of [{updatedOn:"2026-02-30"},{updatedOn:"2027-01-01"},{period:"2026-09-02"},{period:"2026-11-01"}])assert.throws(()=>parseWorldBankMonthly(receipt({...payload(),...patch})));
 for(const patch of [{key:"monthly-commodities"},{collectedAt:"2999-01-01T00:00:00Z"},{sourceUrl:"https://evil.test/month.xlsx"},{sourceUrl:receipt().sourceUrl+"?token=x"},{body:"<html>"}])assert.throws(()=>parseWorldBankMonthly({...receipt(),...patch}));
 const p=payload();p.items[0].date="2026-09-02";assert.throws(()=>parseWorldBankMonthly(receipt(p)));
});
test("新安装默认世行且SSH未配置；旧配置不默默换来源",()=>{
 assert.equal(emptySnapshotConnection.monthlySource,"worldbank");assert.equal(emptySnapshotConnection.enabled,false);assert.equal(emptySnapshotConnection.sshAlias,"");assert.equal(emptySnapshotConnection.dataRoot,"");
 const current=providersFor(["public-monthly"],undefined,{snapshotConnection:emptySnapshotConnection})[0];assert.match(current.name,/世界银行/);
 const legacy=providersFor(["public-monthly"],undefined,{snapshotConnection:{enabled:false,sshAlias:"",dataRoot:"",radarRoot:""}})[0];assert.match(legacy.name,/FRED/);assert.notEqual(current.cacheKey,legacy.cacheKey);
});
test("设置可以明确选择两种来源，界面不混用链接和单位",()=>{
 const settings=renderToStaticMarkup(createElement(DataSourceConnectionsSettings));assert.match(settings,/月价来源/);assert.match(settings,/value="worldbank"/);assert.match(settings,/value="fred"/);
 const html=renderToStaticMarkup(createElement(PublicMonthlyPrices,{snapshot:parseWorldBankMonthly(receipt())}));assert.match(html,/世界银行/);assert.match(html,/美元\/千克/);assert.match(html,/2026-10-02/);assert.match(html,/不拼接历史序列/);assert.doesNotMatch(html,/fred.stlouisfed.org\/series/);
});
test("世行只调用所选公开来源，关闭或模拟零请求，失败不回退FRED或SSH",async()=>native(async()=>{
 const calls:string[]=[];let fail=false;
 mockIPC((cmd,args)=>{if(cmd==="set_simulation_mode")return null;assert.equal(cmd,"read_builtin_public_source");calls.push((args as {key:string}).key);if(fail)throw "fixture-secret";return receipt();});
 await syncSimulationMode(false);const good=await createPublicMonthlyProvider().load(new AbortController().signal);assert.equal(good.status,"normal");assert.deepEqual(calls,["worldbank-monthly"]);
 fail=true;calls.length=0;const bad=await createPublicMonthlyProvider().load(new AbortController().signal);assert.equal(bad.status,"error");assert.equal(bad.retryable,false);assert.doesNotMatch(bad.error!,/fixture-secret/);assert.deepEqual(calls,["worldbank-monthly"]);
 calls.length=0;await createPublicMonthlyProvider(false).load(new AbortController().signal);assert.equal(calls.length,0);
 await syncSimulationMode(true);await createPublicMonthlyProvider().load(new AbortController().signal);assert.equal(calls.length,0);
}));
test("切换来源后不能复活旧来源缓存，失败保留本来源真实日期",async()=>native(async()=>{
 const storage=new Map<string,string>();const runtime=createProviderRuntime({now:()=>Date.parse(at),cache:{get:k=>storage.get(k)??null,set:(k,v)=>{storage.set(k,v);}}});
 let fail=false;mockIPC((cmd)=>{if(cmd==="set_simulation_mode")return null;assert.equal(cmd,"read_builtin_public_source");if(fail)throw "offline";return receipt();});
 await syncSimulationMode(false);const wb=createPublicMonthlyProvider();assert.equal((await runtime.refresh(wb)).data?.snapshot.source,"worldbank");
 fail=true;const fred=await runtime.refresh(createPublicMonthlyProvider(true,"fred"));assert.equal(fred.data,null);assert.equal(fred.status,"error");
 const stale=await runtime.refresh(wb,true);assert.equal(stale.data?.snapshot.items[0].date,"2026-09-01");assert.equal(stale.data?.snapshot.source,"worldbank");
}));
