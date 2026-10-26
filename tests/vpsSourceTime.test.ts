import test from "node:test";
import assert from "node:assert/strict";
import { safeBeszelError } from "../src/domain/vps/contracts";

test("Beszel诊断只保留固定分类，不回显地址、密钥或响应正文",()=>{
 for(const message of ["服务 网络连接失败或请求超时","Beszel API 令牌无效或无权读取该系统","找不到 Beszel 系统，请检查 System ID 和访问权限","尚未配置服务凭据","Beszel 返回了无法识别的数据","Beszel API 请求失败（HTTP 503）","Beszel VPS 状态 超过采样时限"]){
  assert.equal(safeBeszelError(message),message);assert.equal(safeBeszelError(new Error(message)),message);
 }
 for(const input of [null,{},"服务 网络连接失败或请求超时 token=synthetic-secret","HTTP 401 https://private.invalid",'<html>synthetic-secret</html>',"Bearer synthetic-secret","Beszel API 请求失败（HTTP 503）\nsynthetic-secret"]){
  assert.equal(safeBeszelError(input),"Beszel 读取失败，详细原因未识别");
 }
});

test("真实Beszel加载通路对模拟IPC错误脱敏，失败不写历史",async()=>{
 const windowBefore=Object.getOwnPropertyDescriptor(globalThis,"window"),tauriBefore=Object.getOwnPropertyDescriptor(globalThis,"isTauri");
 try{
  Object.defineProperty(globalThis,"window",{configurable:true,value:Object.assign(new EventTarget(),{crypto:webcrypto})});
  Object.defineProperty(globalThis,"isTauri",{configurable:true,value:true});
  for(const message of ["Beszel API 令牌无效或无权读取该系统","找不到 Beszel 系统，请检查 System ID 和访问权限","Bearer synthetic-secret https://private.invalid"]){
   let writes=0,reads=0;
   mockIPC((command)=>{if(command==="fetch_beszel_snapshot"){reads++;throw message}if(command==="storage_query")return [];if(command==="storage_insert"){writes++;return null}throw Error("Unexpected mock command "+command)});
   const result=await createBeszelProvider({url:"https://hub.example",systemId:"one",refreshIntervalSeconds:30}).load(new AbortController().signal);
   assert.equal(reads,1);assert.equal(writes,0);assert.equal(result.error,safeBeszelError(message));
   assert.equal(result.data?.observation.error,safeBeszelError(message));
   assert.doesNotMatch(JSON.stringify(result),/synthetic-secret|private.invalid/);
  }
 }finally{clearMocks();if(windowBefore)Object.defineProperty(globalThis,"window",windowBefore);else Reflect.deleteProperty(globalThis,"window");if(tauriBefore)Object.defineProperty(globalThis,"isTauri",tauriBefore);else Reflect.deleteProperty(globalThis,"isTauri")}
});
import {observationFromNative,beszelProviderResult,createVpsHistoryRecord,createBeszelProvider} from "../src/providers/server/beszelProvider";
import {presentVps} from "../src/presentation/vpsAdapter";
import {snapshotFromVpsHistory} from "../src/providers/server/beszelProvider";
import {createProviderRuntime} from "../src/providers/providerRuntime";
import {clearMocks,mockIPC} from "@tauri-apps/api/mocks";
import {webcrypto} from "node:crypto";
import {overviewTrendSamples} from "../src/widgets/ResourcePanels";
import {emptyDashboardData} from "../src/providers/dashboardAdapter";
import {WidgetCard} from "../src/widgets/WidgetCard";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
const now=Date.parse("2026-10-18T12:00:00Z");
const native=(time:number|null)=>({sampledAtUnixMs:time,fetchedAtUnixMs:now,serverId:"one",name:"test",state:"online" as const,uptimeSeconds:3600,latencyMs:2,cpuPercent:12,memoryPercent:34,diskPercent:45,network:{},services:[]});

test("来源时间缺失不能被转换成1970或本机现在",()=>{
 const value=observationFromNative(native(null));
 assert.equal(value.observedAt,null);assert.equal(value.lastSuccessAt,null);
 assert.equal(value.fetchedAt,new Date(now).toISOString());
 const result=beszelProviderResult(value,true,now);assert.equal(result.status,"unavailable");assert.match(result.error!,/时间.*未确认/);
});
test("HTTP刚成功但来源停更，仍标旧数据而不是在线实时",async()=>{
 const value=observationFromNative(native(now-600000));const result=beszelProviderResult(value,true,now);
 assert.equal(result.status,"unavailable");assert.equal(result.retained,true);assert.match(result.error!,/数据未更新/);
 const runtime=createProviderRuntime({now:()=>now});const snapshot=await runtime.refresh({id:"test-vps",name:"test",kind:"server",refreshIntervalMs:30000,load:async()=>result});
 assert.equal(snapshot.status,"stale");assert.equal(snapshot.lastSuccessAt,new Date(now-600000).toISOString());
 const view=presentVps(value,snapshot.status,result.error);assert.equal(view.state,"warning");assert.match(view.statusMessage!,/数据未更新/);
});
test("同一来源观测被多次读取，不产生新的历史身份或采样日期",async()=>{
 const a=observationFromNative(native(now-10000)),b=observationFromNative({...native(now-10000),fetchedAtUnixMs:now+50000});
 const config={url:"https://hub.example",systemId:"one"};const first=await createVpsHistoryRecord(config,a),second=await createVpsHistoryRecord(config,b);
 assert.equal(first.id,second.id);assert.equal(first.createdAt,second.createdAt);assert.notEqual(a.fetchedAt,b.fetchedAt);
});
test("未知时间不能写成真实历史，未来或无效时间不冒充采样",async()=>{
 for(const time of [null,NaN,Infinity,now+60000]){const value=observationFromNative(native(time));
  const result=beszelProviderResult(value,true,now);assert.notEqual(result.status,"normal");
  if(time===null||!Number.isFinite(time))await assert.rejects(createVpsHistoryRecord({url:"https://hub.example",systemId:"one"},value));
 }
});
test("修复前没有来源时间标识的缓存，不再冒充已确认的实时数据",()=>{
 const sample=new Date(now).toISOString();const old={id:"old",kind:"vps_history" as const,createdAt:sample,payload:{schemaVersion:2,hubUrl:"https://hub.example",serverId:"one",observation:{name:"old",state:"online",observedAt:sample,cpuPercent:1}}};
 const value=snapshotFromVpsHistory([old],{url:"https://hub.example",systemId:"one"})!;
 assert.equal(value.sourceTimeVerified,false);assert.equal(value.lastSuccessAt,null);assert.notEqual(beszelProviderResult(value,true,now).status,"normal");
});
test("刷新缓存版本，旧的正常状态不会绕过来源时间检查",()=>{
 const provider=createBeszelProvider({url:"https://hub.example",systemId:"one",refreshIntervalSeconds:30});assert.match(provider.cacheKey!,/source-time-v1/);
});
test("新鲜度容许正常采集间隔，并在边界后降级",()=>{
 for(const [seconds,age,expected]of [[30,119000,"normal"],[30,121000,"unavailable"],[300,899000,"normal"],[300,901000,"unavailable"]] as const){
  assert.equal(beszelProviderResult(observationFromNative(native(now-age)),true,now,seconds*1000).status,expected);
 }
});

test("真实加载通路只保存时间已确认的新鲜来源，不把旧包或未知时间写成实时历史",async()=>{
 const windowBefore=Object.getOwnPropertyDescriptor(globalThis,"window"),tauriBefore=Object.getOwnPropertyDescriptor(globalThis,"isTauri");
 try{
  Object.defineProperty(globalThis,"window",{configurable:true,value:Object.assign(new EventTarget(),{crypto:webcrypto})});Object.defineProperty(globalThis,"isTauri",{configurable:true,value:true});
  const records:any[]=[];let sample:number|null=null;
  mockIPC((command,args)=>{if(command==="fetch_beszel_snapshot")return {...native(sample),fetchedAtUnixMs:Date.now()};if(command==="storage_insert"){records.push(args.record);return null}throw Error("Unexpected mock command "+command)});
  const provider=createBeszelProvider({url:"https://hub.example",systemId:"one",refreshIntervalSeconds:30}),signal=new AbortController().signal;
  await provider.load(signal);assert.equal(records.length,0);
  sample=Date.now()-600000;await provider.load(signal);assert.equal(records.length,0);
  sample=Date.now()-10000;await provider.load(signal);assert.equal(records.length,1);assert.equal(records[0].createdAt,new Date(sample).toISOString());
  await provider.load(signal);assert.equal(records[0].id,records[1].id);assert.equal(records[0].createdAt,records[1].createdAt);
 }finally{clearMocks();if(windowBefore)Object.defineProperty(globalThis,"window",windowBefore);else Reflect.deleteProperty(globalThis,"window");if(tauriBefore)Object.defineProperty(globalThis,"isTauri",tauriBefore);else Reflect.deleteProperty(globalThis,"isTauri")}
});

test("修复前来源时间不明的历史保留，但不画进实时资源曲线",async()=>{
 const config={url:"https://hub.example",systemId:"one"},record=await createVpsHistoryRecord(config,observationFromNative(native(now-10000)));
 assert.equal(overviewTrendSamples([],[record],config.url,config.systemId,now-60000,now).vps.length,1);
 const old={...record,payload:{...record.payload,observation:{...record.payload.observation,sourceTimeVerified:undefined}}};
 assert.equal(overviewTrendSamples([],[old],config.url,config.systemId,now-60000,now).vps.length,0);
});

test("VPS界面分别显示来源时间与本机读取，旧数据不显示在线",()=>{
 const value=observationFromNative(native(now-600000)),result=beszelProviderResult(value,true,now),data=emptyDashboardData();
 data.vps=presentVps(result.data!.observation,"stale",result.error);data.providerDiagnostics=[{providerId:"vps-status",name:"test",status:"stale",lastUpdated:new Date(now).toISOString(),lastSuccessAt:value.observedAt}];
 const markup=renderToStaticMarkup(createElement(WidgetCard,{id:"vps",data,vpsConsole:true}));assert.match(markup,/来源时间/);assert.match(markup,/本机读取/);assert.match(markup,/数据未更新/);assert.doesNotMatch(markup,/>在线</);
});
