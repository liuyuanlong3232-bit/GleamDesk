import {test} from "node:test";
import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {parsePublicCftc,cftcMarkets,cftcRowState,cftcNextRelease,cftcReleaseCalendar} from "../src/domain/agriculture/publicCftc";
import {createPublicCftcProvider} from "../src/providers/publicDataProviders";
import {syncSimulationMode} from "../src/services/simulationSafety";
import {PublicCftcPositions} from "../src/components/PublicCftcPositions";
import {createProviderRuntime} from "../src/providers/providerRuntime";
import {providersFor} from "../src/providers/registry";
import {emptySnapshotConnection} from "../src/domain/agriculture/contracts";
const at=new Date().toISOString(),date="2026-10-13";
const row=(index=0,patch:Record<string,unknown>={})=>({cftc_contract_market_code:cftcMarkets[index].code,market_and_exchange_names:cftcMarkets[index].market,report_date_as_yyyy_mm_dd:date+"T00:00:00",futonly_or_combined:"FutOnly",contract_units:"(CONTRACTS OF 5,000 BUSHELS)",open_interest_all:"100",m_money_positions_long_all:"20",m_money_positions_short_all:"30",change_in_m_money_long_all:"-2",change_in_m_money_short_all:"0",...patch});
const raw=(rows:unknown[]=cftcMarkets.map((_,i)=>row(i)))=>({key:"cftc-agri",collectedAt:at,body:JSON.stringify(rows)});

test("官方发布日历全年52日有序唯一，节假日顺延不按普通周五推算",()=>{
 const days=cftcReleaseCalendar.releaseDates;assert.equal(days.length,52);assert.equal(new Set(days).size,52);assert.deepEqual(days,[...days].sort());assert.ok(days.every(d=>d>=cftcReleaseCalendar.coverageFrom&&d<=cftcReleaseCalendar.coverageTo&&new Date(d).toISOString().slice(0,10)===d));
 assert.deepEqual(days.filter(d=>new Date(d).getUTCDay()!==5),['2026-01-05','2026-06-22','2026-07-06','2026-11-16','2026-11-30','2026-12-28']);assert.equal(cftcReleaseCalendar.tentative,true);assert.match(cftcReleaseCalendar.sourceUrl,/^https:\/\/www\.cftc\.gov\//);
});
test("发布时刻按美东夏令时换算，不受宿主本地时区影响",()=>{
 for(const [now,at] of [['2026-01-02T12:00:00Z','2026-01-05T20:30:00.000Z'],['2026-03-06T20:29:59Z','2026-03-06T20:30:00.000Z'],['2026-03-08T12:00:00Z','2026-03-13T19:30:00.000Z'],['2026-10-24T15:00:00Z','2026-10-30T19:30:00.000Z'],['2026-11-01T12:00:00Z','2026-11-06T20:30:00.000Z']])assert.equal(cftcNextRelease(Date.parse(now))?.at,at);
});
test("节假日发布延后到官方指定周一，跨到北京时间的下一日",()=>{
 for(const [now,date] of [['2026-06-19T23:00:00Z','2026-06-22'],['2026-07-03T23:00:00Z','2026-07-06'],['2026-11-13T23:00:00Z','2026-11-16'],['2026-11-27T23:00:00Z','2026-11-30'],['2026-12-25T23:00:00Z','2026-12-28']])assert.equal(cftcNextRelease(Date.parse(now))?.date,date);
});
test("计划时刻前后边界、跨年覆盖和非法时刻不制造下一年计划",()=>{
 const due=Date.parse('2026-10-30T19:30:00Z');assert.equal(cftcNextRelease(due-1)?.date,'2026-10-30');assert.equal(cftcNextRelease(due)?.date,'2026-11-06');
 for(const now of [NaN,Infinity,1e20,Date.parse('2025-12-31T23:59:59Z'),Date.parse('2027-01-01T05:00:00Z'),Date.parse('2026-12-28T20:30:00Z')])assert.equal(cftcNextRelease(now),null);
});
test("页面只给下次计划，不冒充实际发布或改持仓日期和数值",()=>{
 const s=parsePublicCftc(raw()),before=JSON.stringify(s);const html=renderToStaticMarkup(createElement(PublicCftcPositions,{snapshot:s,now:Date.parse('2026-10-24T15:00:00Z')}));assert.match(html,/下次计划发布：2026-10-31 03:30:00（北京时间）/);assert.match(html,/计划可能调整/);assert.match(html,/周报 · 发布时效未确认/);assert.doesNotMatch(html,/已发布|最新一期报告|已确认最新/);assert.equal(JSON.stringify(s),before);
 const outside=renderToStaticMarkup(createElement(PublicCftcPositions,{snapshot:s,now:Date.parse('2027-01-01T06:00:00Z')}));assert.match(outside,/后续发布日历未覆盖/);assert.doesNotMatch(outside,/下次计划发布：/);
});
test("六个市场分别映射，负净仓、负周变和真实零均保留",()=>{const s=parsePublicCftc(raw());assert.equal(s.items.length,6);assert.equal(s.reportDate,date);assert.equal(s.collectedAt,at);assert.equal(s.items[0].managed_money_net,-10);assert.equal(s.items[0].managed_money_change_long,-2);assert.equal(s.items[0].managed_money_change_short,0);assert.deepEqual(s.items.slice(-2).map(i=>i.commodity),["wheat_hrw","wheat_srw"]);assert.match(s.items[0].contractUnits!,/BUSHELS/);});
test("只取同一市场最新持仓日，记录不能逐字段拼接",()=>{const s=parsePublicCftc(raw([row(0,{report_date_as_yyyy_mm_dd:"2026-10-06T00:00:00",m_money_positions_long_all:"99"}),row(0,{m_money_positions_long_all:null}),row(1)]));assert.equal(s.items[0].reportDate,date);assert.equal(s.items[0].managed_money_long,null);assert.equal(s.items[0].managed_money_net,null);assert.match(s.items[0].warning,/字段缺失/);});
test("混合日期逐行保留，不向缺品种借日期",()=>{const s=parsePublicCftc(raw([row(0,{report_date_as_yyyy_mm_dd:"2026-10-06T00:00:00"}),row(1)]));assert.equal(s.items[0].reportDate,"2026-10-06");assert.equal(s.items[1].reportDate,date);assert.equal(s.items[2].reportDate,null);assert.equal(s.items[2].managed_money_long,null);assert.match(cftcRowState(s.items[0],s),/数据未更新/);});
test("日历不参与周报读取，周五不能按日行情阈值误标过期",()=>{const s=parsePublicCftc({...raw(),collectedAt:"2026-10-16T10:00:00Z"});assert.equal(cftcRowState(s.items[0],s,false,Date.parse(s.collectedAt)),"周报 · 发布时效未确认");assert.equal(s.reportDate,date);});
test("空字段、布尔、负持仓、小数不补零",()=>{for(const value of [null,"",false,"-1","1.5"]){const s=parsePublicCftc(raw([row(0,{open_interest_all:value}),row(1)]));assert.equal(s.items[0].open_interest_all,null);assert.match(s.items[0].warning,/字段缺失/);}});
test("缺部分字段的旧缓存也必须同时标未更新",()=>{const s=parsePublicCftc(raw([row(0,{open_interest_all:null}),row(1)]));assert.match(cftcRowState(s.items[0],s,true),/数据未更新.*字段缺失/);});
test("禁止混入口径、交易所或去掉前导零的代码",()=>{for(const patch of [{futonly_or_combined:"Combined"},{cftc_contract_market_code:2602},{market_and_exchange_names:"OTHER EXCHANGE"}])assert.throws(()=>parsePublicCftc(raw([row(0,patch)])),/不匹配/);});
test("同日冲突不能任意挑一条，相同重复可以去重",()=>{const s=parsePublicCftc(raw([row(),row(0,{m_money_positions_long_all:"21"}),row(),row(1)]));assert.equal(s.items[0].managed_money_net,null);assert.match(s.items[0].warning,/冲突/);const same=parsePublicCftc(raw([row(),row()]));assert.equal(same.items[0].managed_money_net,-10);});
test("无效或未来报告日期不能改成采集日，也不能退回旧记录冒充最新",()=>{for(const day of ["2026-02-30T00:00:00","2999-01-01T00:00:00",null]){const s=parsePublicCftc(raw([row(0,{report_date_as_yyyy_mm_dd:day}),row(),row(1)]));assert.equal(s.items[0].reportDate,null);assert.equal(s.items[0].managed_money_net,null);assert.match(s.items[0].warning,/日期无效/);}});
test("空、过量及错误对象不能当成功",()=>{for(const rows of [[],Array.from({length:61},()=>row()),[row(0,{m_money_positions_long_all:null})]])assert.throws(()=>parsePublicCftc(raw(rows)));assert.throws(()=>parsePublicCftc({...raw(),body:'{"error":"blocked"}'}));});
test("持仓表每行有自身日期、缺值为破折号，数据读取失败标未更新",()=>{const s=parsePublicCftc(raw([row()]));const html=renderToStaticMarkup(createElement(PublicCftcPositions,{snapshot:s,error:"断网"}));assert.match(html,/数据未更新/);assert.match(html,/该市场暂无记录/);assert.match(html,/—/);assert.match(html,/日期未知/);assert.match(html,/持仓日是报告统计截至日/);assert.match(html,/仅期货/);});
async function native(run:()=>Promise<void>){const a=Object.getOwnPropertyDescriptor(globalThis,"window"),b=Object.getOwnPropertyDescriptor(globalThis,"isTauri");Object.defineProperty(globalThis,"window",{configurable:true,value:globalThis});Object.defineProperty(globalThis,"isTauri",{configurable:true,value:true});try{await run();}finally{clearMocks();if(a)Object.defineProperty(globalThis,"window",a);else Reflect.deleteProperty(globalThis,"window");if(b)Object.defineProperty(globalThis,"isTauri",b);else Reflect.deleteProperty(globalThis,"isTauri");}}
test("关闭时零IPC，模拟时不得读取官方接口",async()=>native(async()=>{const calls:string[]=[];mockIPC(c=>{calls.push(c);return null});assert.equal((await createPublicCftcProvider(false).load(new AbortController().signal)).status,"unavailable");assert.equal(calls.length,0);await syncSimulationMode(true);assert.equal((await createPublicCftcProvider().load(new AbortController().signal)).status,"error");assert.ok(calls.every(c=>c==="set_simulation_mode"));await syncSimulationMode(false);}));
test("读取失败保留上次真实持仓日期与读取时间，不自动重试",async()=>native(async()=>{let offline=false,count=0;mockIPC(c=>{if(c==="set_simulation_mode")return null;assert.equal(c,"read_builtin_public_source");count++;if(offline)throw Error("offline");return raw();});await syncSimulationMode(false);const values=new Map<string,string>(),runtime=createProviderRuntime({cache:{get:key=>values.get(key)??null,set:(key,value)=>{values.set(key,value);}}});const provider=createPublicCftcProvider();const first=await runtime.refresh(provider,true);assert.equal(first.status,"normal");offline=true;const next=await runtime.refresh(provider,true);assert.equal(next.status,"stale");assert.equal(next.data?.snapshot.reportDate,date);assert.equal(next.data?.snapshot.collectedAt,at);assert.equal(count,2);}));
test("默认开但无需SSH，不在后台轮询，也不混入演示模式",()=>{assert.equal(emptySnapshotConnection.cftcEnabled,true);const [provider]=providersFor(["public-cftc"]);assert.equal(provider.refreshIntervalMs,3600000);assert.equal(provider.backgroundRefreshIntervalMs,null);assert.equal(provider.retryPolicy?.maxRetries,0);assert.equal(providersFor(["public-cftc"],undefined,{includeDemoProviders:true}).length,0);});
