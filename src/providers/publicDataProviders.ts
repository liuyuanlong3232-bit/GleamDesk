import {overseasFutureSymbols,parseEastmoneyCotton,parseEastmoneyTin,parseOverseasFutures} from "../domain/agriculture/publicOverseasFutures";
import {chinaFutureSymbols,parseChinaFutures} from "../domain/agriculture/publicChinaFutures";
import {aStockSymbols,parseAStocks} from "../domain/agriculture/publicAStocks";
import {isTauri} from "@tauri-apps/api/core";
import {invokeLive} from "../services/simulationSafety";
import {newsFeeds,parsePublicNews,type PublicNewsSnapshot} from "../domain/news/publicFeeds";
import {parseMetal,parseEcbRates,metalReferenceUnit,type PublicMarketSnapshot} from "../domain/agriculture/publicMarket";
import type {Provider} from "./contracts";
import type {PublicNewsData,PublicMarketData,PublicCftcData,PublicWasdeData,PublicInspectionsData,PublicNoaaData,PublicNassAnnualData,PublicCropProgressData,PublicMonthlyData,PublicIbgeData} from "./data";
import {parsePublicCftc} from "../domain/agriculture/publicCftc";

import {parsePublicNoaa} from "../domain/agriculture/publicNoaa";
import {parsePublicInspections} from "../domain/agriculture/publicInspections";
import {parsePublicWasde} from "../domain/agriculture/publicWasde";
import {parseNassAnnual,parseCropProgress} from "../domain/agriculture/publicNass";
import {parsePublicArgentina,parsePublicConab,parsePublicMonthly,parseWorldBankMonthly,parsePublicIbge,type MonthlySource} from "../domain/agriculture/publicReferenceData";
export function createPublicNassAnnualProvider(enabled=true):Provider<PublicNassAnnualData>{return {
 id:"public-nass-annual",name:"NASS 官方年度产量",kind:"resource",cacheKey:`nass-annual-v1:${enabled}`,refreshIntervalMs:86400000,backgroundRefreshIntervalMs:null,timeoutMs:45000,retryPolicy:{maxRetries:0},
 load:async signal=>{
  if(!enabled||!isTauri())return {status:"unavailable",data:null,retryable:false};
  try{if(signal.aborted)throw Error("cancelled");const raw=await invokeLive("read_builtin_public_source",{key:"nass-annual"});if(signal.aborted)throw Error("cancelled");const snapshot=parseNassAnnual(raw);return {status:snapshot.items.some(row=>row.warning)?"degraded":"normal",data:{type:"public-nass-annual",snapshot},observedAt:snapshot.collectedAt,retryable:false};}
  catch{return {status:"error",data:null,error:"NASS 官方年度产量读取失败或格式变化，暂不可用；旧结果保留原日期",retryable:false};}
 }
};}

export function createPublicCropProgressProvider(enabled=true):Provider<PublicCropProgressData>{return {
 id:"public-crop-progress",name:"NASS 官方作物进度",kind:"resource",cacheKey:`crop-progress-v1:${enabled}`,refreshIntervalMs:21600000,backgroundRefreshIntervalMs:null,timeoutMs:45000,retryPolicy:{maxRetries:0},
 load:async signal=>{
  if(!enabled||!isTauri())return {status:"unavailable",data:null,retryable:false};
  try{if(signal.aborted)throw Error("cancelled");const raw=await invokeLive("read_builtin_public_source",{key:"crop-progress"});if(signal.aborted)throw Error("cancelled");const snapshot=parseCropProgress(raw);return {status:snapshot.items.some(row=>row.current===null)?"degraded":"normal",data:{type:"public-crop-progress",snapshot},observedAt:snapshot.collectedAt,retryable:false};}
  catch{return {status:"error",data:null,error:"NASS 官方作物进度读取失败或格式变化，暂不可用；旧结果保留原日期",retryable:false};}
 }
};}

export function monthlyFailureMessage(error:unknown,phase:"request"|"parse"):string {
 let reason="读取失败，原因未确认";
 if(phase==="parse")reason="数据格式变化";
 else {
  const message=typeof error==="string"?error:error instanceof Error?error.message:"";
  const transport=/^FRED_HTTP_(send|receive)_(\d{1,10})$/.exec(message);
  const status=/^公开来源返回 HTTP ([1-5]\d{2})，暂不可用$/.exec(message);
  if(transport){
   const stage=transport[1]==="send"?"发送请求":"接收响应",code=Number(transport[2]);
   const description=code===12002?"超时":code===12029?"连接失败":[12037,12038,12045,12057,12169,12170,12175,12179].includes(code)?"证书校验失败":code===12030?"连接中断或 TLS 错误":"网络失败";
   reason=`${stage}${description}${code?`（${code}）`:""}`;
  }else if(status)reason=`HTTP ${status[1]}`;
  else if(message==="自定义接口读取超时")reason="读取超时";
  else if(message==="公开来源编码无效")reason="响应编码无效";
  else if(message==="接口响应超过 512 KB，请缩小查询范围")reason="响应超过大小限制";
  else if(message==="模拟模式已开启，已阻止真实调用；草稿保留")reason="模拟模式已阻止真实读取";
 }
 return `FRED 月价：${reason}；暂不可用，旧结果保留原日期`;
}
export function createPublicMonthlyProvider(enabled=true,source:MonthlySource="worldbank"):Provider<PublicMonthlyData>{return {
 id:"public-monthly",name:source==="worldbank"?"世界银行月度参考价":"IMF / FRED 月度商品价格",kind:"resource",cacheKey:`${source==="worldbank"?"worldbank-monthly":"monthly-commodities"}-v1:${enabled}`,refreshIntervalMs:86400000,backgroundRefreshIntervalMs:null,timeoutMs:source==="worldbank"?45000:25000,retryPolicy:{maxRetries:0},
 load:async signal=>{
  if(!enabled||!isTauri())return {status:"unavailable",data:null,retryable:false};
  let phase:"request"|"parse"="request";
  try{if(signal.aborted)throw Error("cancelled");const raw=await invokeLive("read_builtin_public_source",{key:source==="worldbank"?"worldbank-monthly":"monthly-commodities"});if(signal.aborted)throw Error("cancelled");phase="parse";const snapshot=source==="worldbank"?parseWorldBankMonthly(raw):parsePublicMonthly(raw);return {status:snapshot.items.some(row=>row.warning)?"degraded":"normal",data:{type:"public-monthly",snapshot},observedAt:snapshot.collectedAt,retryable:false};}
  catch(error){return {status:"error",data:null,error:source==="fred"?monthlyFailureMessage(error,phase):`世界银行月价：${phase==="parse"?"数据格式变化":"读取失败或网络不可达"}；暂不可用，旧结果保留原日期`,retryable:false};}
 }
};}

export function createPublicArgentinaProvider(enabled=false):Provider<import("./data").PublicArgentinaData>{return {
 id:"public-argentina",name:"阿根廷农业部全国估产",kind:"resource",cacheKey:`argentina-crops-v1:${enabled}`,refreshIntervalMs:86400000,backgroundRefreshIntervalMs:null,timeoutMs:75000,retryPolicy:{maxRetries:0},
 load:async signal=>{
  if(!enabled||!isTauri())return {status:"unavailable",data:null,retryable:false};
  try{if(signal.aborted)throw Error("cancelled");const raw=await invokeLive("read_builtin_public_source",{key:"argentina-crops"});if(signal.aborted)throw Error("cancelled");const snapshot=parsePublicArgentina(raw);return {status:snapshot.items.some(row=>row.areaHa===null||row.productionTonnes===null)?"degraded":"normal",data:{type:"public-argentina",snapshot},observedAt:snapshot.collectedAt,retryable:false};}
  catch{return {status:"error",data:null,error:"阿根廷官方月报读取失败或格式变化，暂不可用；旧结果保留原报告日期",retryable:false};}
 }
};}

export function createPublicConabProvider(enabled=false):Provider<import("./data").PublicConabData>{return {
 id:"public-conab",name:"CONAB 巴西作物年度估产",kind:"resource",cacheKey:`conab-crops-v1:${enabled}`,refreshIntervalMs:86400000,backgroundRefreshIntervalMs:null,timeoutMs:45000,retryPolicy:{maxRetries:0},
 load:async signal=>{
  if(!enabled||!isTauri())return {status:"unavailable",data:null,retryable:false};
  try{if(signal.aborted)throw Error("cancelled");const raw=await invokeLive("read_builtin_public_source",{key:"conab-crops"});if(signal.aborted)throw Error("cancelled");const snapshot=parsePublicConab(raw);return {status:snapshot.items.some(row=>row.value===null||row.previous===null)?"degraded":"normal",data:{type:"public-conab",snapshot},observedAt:snapshot.collectedAt,retryable:false};}
  catch{return {status:"error",data:null,error:"CONAB 官方估产读取失败或格式变化，暂不可用；旧结果保留原报告日期",retryable:false};}
 }
};}

export function createPublicIbgeProvider(enabled=true):Provider<PublicIbgeData>{return {
 id:"public-ibge",name:"巴西 IBGE 月度估产",kind:"resource",cacheKey:`ibge-crops-v1:${enabled}`,refreshIntervalMs:86400000,backgroundRefreshIntervalMs:null,timeoutMs:25000,retryPolicy:{maxRetries:0},
 load:async signal=>{
  if(!enabled||!isTauri())return {status:"unavailable",data:null,retryable:false};
  try{if(signal.aborted)throw Error("cancelled");const raw=await invokeLive("read_builtin_public_source",{key:"ibge-crops"});if(signal.aborted)throw Error("cancelled");const snapshot=parsePublicIbge(raw);return {status:snapshot.items.some(row=>row.value===null)?"degraded":"normal",data:{type:"public-ibge",snapshot},observedAt:snapshot.collectedAt,retryable:false};}
  catch{return {status:"error",data:null,error:"巴西 IBGE 月度估产读取失败或格式变化，暂不可用；旧结果保留原日期",retryable:false};}
 }
};}

export function createPublicNoaaProvider(enabled=true):Provider<PublicNoaaData>{return {
 id:"public-noaa",name:"NOAA 官方站点实测",kind:"resource",cacheKey:`noaa-v1:${enabled}`,refreshIntervalMs:21600000,backgroundRefreshIntervalMs:null,timeoutMs:25000,retryPolicy:{maxRetries:0},
 load:async signal=>{
  if(!enabled||!isTauri())return {status:"unavailable",data:null,retryable:false};
  try{if(signal.aborted)throw Error("cancelled");const raw=await invokeLive("read_builtin_public_source",{key:"noaa-observed"});if(signal.aborted)throw Error("cancelled");const snapshot=parsePublicNoaa(raw);return {status:snapshot.stations.some(row=>row.precipDays<30||row.tmaxDays<30||row.tminDays<30)?"degraded":"normal",data:{type:"public-noaa",snapshot},observedAt:snapshot.collectedAt,retryable:false};}
  catch{return {status:"error",data:null,error:"NOAA 实测读取失败或格式变化，暂不可用；旧结果保留原观测日期",retryable:false};}
 }
};}

export function createPublicInspectionsProvider(enabled=true):Provider<PublicInspectionsData>{return {
 id:"public-inspections",name:"USDA 官方出口检验",kind:"resource",cacheKey:`inspections-v1:${enabled}`,refreshIntervalMs:21600000,backgroundRefreshIntervalMs:null,timeoutMs:25000,retryPolicy:{maxRetries:0},
 load:async signal=>{
  if(!enabled||!isTauri())return {status:"unavailable",data:null,retryable:false};
  try{if(signal.aborted)throw Error("cancelled");const raw=await invokeLive("read_builtin_public_source",{key:"usda-inspections"});if(signal.aborted)throw Error("cancelled");const snapshot=parsePublicInspections(raw);return {status:snapshot.items.some(row=>row.warning)?"degraded":"normal",data:{type:"public-inspections",snapshot},observedAt:snapshot.collectedAt,retryable:false};}
  catch{return {status:"error",data:null,error:"USDA 出口检验读取失败或格式变化，暂不可用；旧周报保留原统计日期",retryable:false};}
 }
};}

export function createPublicWasdeProvider(enabled=true):Provider<PublicWasdeData>{return {
 id:"public-wasde",name:"USDA WASDE 官方供需",kind:"resource",cacheKey:`wasde-v1:${enabled}`,refreshIntervalMs:21600000,backgroundRefreshIntervalMs:null,timeoutMs:45000,retryPolicy:{maxRetries:0},
 load:async signal=>{
  if(!enabled||!isTauri())return {status:"unavailable",data:null,retryable:false};
  try{if(signal.aborted)throw Error("cancelled");const raw=await invokeLive("read_builtin_public_source",{key:"wasde"});if(signal.aborted)throw Error("cancelled");const snapshot=parsePublicWasde(raw);return {status:snapshot.items.some(r=>r.warning)?"degraded":"normal",data:{type:"public-wasde",snapshot},observedAt:snapshot.collectedAt,retryable:false};}
  catch{return {status:"error",data:null,error:"USDA WASDE 读取失败或格式变化，暂不可用；旧月报保留原报告月份",retryable:false};}
 }
};}

export function createPublicCftcProvider(enabled=true):Provider<PublicCftcData>{return {
 id:"public-cftc",name:"CFTC 官方农业持仓",kind:"resource",cacheKey:`cftc-v1:${enabled}`,refreshIntervalMs:3600000,backgroundRefreshIntervalMs:null,timeoutMs:25000,retryPolicy:{maxRetries:0},
 load:async signal=>{
  if(!enabled||!isTauri())return {status:"unavailable",data:null,retryable:false};
  try{
   if(signal.aborted)throw Error("cancelled");const raw=await invokeLive("read_builtin_public_source",{key:"cftc-agri"});if(signal.aborted)throw Error("cancelled");
   const snapshot=parsePublicCftc(raw);
   return {status:snapshot.items.some(item=>item.warning||item.reportDate!==snapshot.reportDate)?"degraded":"normal",data:{type:"public-cftc",snapshot},observedAt:snapshot.collectedAt,retryable:false};
  }catch{return {status:"error",data:null,error:"CFTC 官方持仓读取失败或格式变化，暂不可用；保留的旧报告按原日期显示",retryable:false};}
 }
};}

export function createPublicNewsProvider(enabled=true):Provider<PublicNewsData>{return {
 id:"public-news",name:"免费 RSS 新闻",kind:"resource",cacheKey:`rss-v1:${enabled}`,refreshIntervalMs:900000,backgroundRefreshIntervalMs:null,timeoutMs:25000,retryPolicy:{maxRetries:0},
 load:async signal=>{
  if(!enabled||!isTauri())return {status:"unavailable",data:null,retryable:false};
  const snapshot:PublicNewsSnapshot={entries:[],sources:[]};
  await Promise.all(newsFeeds.map(async feed=>{
   try{if(signal.aborted)throw Error("cancelled");const raw=await invokeLive<{collectedAt:string}>("read_builtin_public_source",{key:feed.key});if(signal.aborted)return;const entries=parsePublicNews(raw,feed.key);snapshot.entries.push(...entries);snapshot.sources.push({key:feed.key,name:feed.name,collectedAt:raw.collectedAt});}
   catch{snapshot.sources.push({key:feed.key,name:feed.name,collectedAt:null,error:"读取失败或格式变化，暂不可用"});}
  }));
  if(signal.aborted)throw Error("读取已取消");
  if(!snapshot.entries.length)return {status:"error",data:{type:"public-news",snapshot},error:"免费新闻暂不可用，没有成功读取的记录",retryable:false};
  return {status:snapshot.sources.some(row=>row.error)?"degraded":"normal",data:{type:"public-news",snapshot},retryable:false};
 }
};}
export function createPublicMarketProvider(enabled=true):Provider<PublicMarketData>{return {
 id:"public-market",name:"内置免费行情",kind:"resource",cacheKey:`market-v2:${enabled}`,refreshIntervalMs:300000,backgroundRefreshIntervalMs:null,timeoutMs:25000,retryPolicy:{maxRetries:0},
 load:async signal=>{
  if(!enabled||!isTauri())return {status:"unavailable",data:null,retryable:false};
  const snapshot:PublicMarketSnapshot={quotes:[],fx:null,errors:[]};
  await Promise.all((["gold","silver","fx-ecb"] as const).map(async key=>{
   try{if(signal.aborted)throw Error("cancelled");const raw=await invokeLive("read_builtin_public_source",{key});if(signal.aborted)return;if(key==="fx-ecb")snapshot.fx=parseEcbRates(raw);else snapshot.quotes.push(parseMetal(raw,key));}
   catch{if(key==="fx-ecb")snapshot.errors.push("欧洲央行汇率暂不可用");else snapshot.quotes.push({symbol:key==="gold"?"XAU":"XAG",name:key==="gold"?"黄金参考价":"白银参考价",price:null,currency:"USD",unit:metalReferenceUnit,quoteAt:null,collectedAt:null,source:"Gold API",error:"读取失败或格式变化"});}
  }));
  if(signal.aborted)throw Error("读取已取消");
  snapshot.quotes.sort((a,b)=>a.symbol.localeCompare(b.symbol));
  if(!snapshot.fx&&!snapshot.quotes.some(row=>row.price!==null))return {status:"error",data:{type:"public-market",snapshot},error:"免费行情暂不可用；保留的旧结果为数据未更新",retryable:false};
  return {status:snapshot.errors.length||snapshot.quotes.some(row=>row.error)?"degraded":"normal",data:{type:"public-market",snapshot},retryable:false};
 }
};}

export function createPublicAStocksProvider(enabled=false,symbols:string[]=[]):Provider<import("./data").PublicAStocksData>{
 const selected=aStockSymbols(symbols);
 return {id:"public-a-shares",name:"腾讯公开股票快照",kind:"resource",cacheKey:`a-shares-v2:${enabled}:${selected.join(",")}`,refreshIntervalMs:60000,backgroundRefreshIntervalMs:null,timeoutMs:25000,retryPolicy:{maxRetries:0},load:async signal=>{
  if(!enabled||!selected.length||!isTauri())return {status:"unavailable",data:null,retryable:false};
  try{if(signal.aborted)throw Error("cancelled");const raw=await invokeLive("read_builtin_public_source",{key:"a-shares",symbols:selected});if(signal.aborted)throw Error("cancelled");const snapshot=parseAStocks(raw,selected);return {status:snapshot.missingSymbols.length||snapshot.quotes.some(q=>q.warning)?"degraded":"normal",data:{type:"public-a-shares",snapshot},observedAt:snapshot.collectedAt,retryable:false};}
  catch{return {status:"error",data:null,error:"股票公开快照读取失败或格式变化，暂不可用；旧记录保留来源时间",retryable:false};}
 }};
}

export function createPublicChinaFuturesProvider(enabled=false,symbols:string[]=[]):Provider<import("./data").PublicChinaFuturesData>{
 const selected=chinaFutureSymbols(symbols);
 return {id:"public-cn-futures",name:"新浪公开指定月份合约",kind:"resource",cacheKey:`cn-futures-v1:${enabled}:${selected.join(",")}`,refreshIntervalMs:60000,backgroundRefreshIntervalMs:null,timeoutMs:25000,retryPolicy:{maxRetries:0},load:async signal=>{
  if(!enabled||!selected.length||!isTauri())return {status:"unavailable",data:null,retryable:false};
  try{if(signal.aborted)throw Error("cancelled");const raw=await invokeLive("read_builtin_public_source",{key:"cn-futures",symbols:selected});if(signal.aborted)throw Error("cancelled");const snapshot=parseChinaFutures(raw,selected);return {status:snapshot.missingSymbols.length||snapshot.quotes.some(q=>q.warning)?"degraded":"normal",data:{type:"public-cn-futures",snapshot},observedAt:snapshot.collectedAt,retryable:false};}
  catch{return {status:"error",data:null,error:"国内期货公开快照读取失败或格式变化，暂不可用；旧记录保留来源时间",retryable:false};}
 }};
}

export function createPublicOverseasFuturesProvider(enabled=false,symbols:string[]=[]):Provider<import("./data").PublicOverseasFuturesData>{
 const selected=overseasFutureSymbols(symbols);
 return {id:"public-overseas-futures",name:"海外公开行情",kind:"resource",cacheKey:`overseas-futures-v3:${enabled}:${selected.join(",")}`,refreshIntervalMs:300000,backgroundRefreshIntervalMs:null,timeoutMs:25000,retryPolicy:{maxRetries:0},load:async signal=>{
  if(!enabled||!selected.length||!isTauri())return {status:"unavailable",data:null,retryable:false};
  try{
   if(signal.aborted)throw Error("cancelled");const yahoo=selected.filter(s=>s!=="CT00Y.EM"&&s!=="LTNT.EM");
   const groups:{symbols:string[];read:()=>Promise<import("../domain/agriculture/publicOverseasFutures").OverseasFuturesSnapshot>}[]=[];
   if(yahoo.length)groups.push({symbols:yahoo,read:async()=>parseOverseasFutures(await invokeLive("read_builtin_public_source",{key:"overseas-futures",symbols:yahoo}),yahoo)});
   if(selected.includes("CT00Y.EM"))groups.push({symbols:["CT00Y.EM"],read:async()=>parseEastmoneyCotton(await invokeLive("read_builtin_public_source",{key:"em-cotton"}))});
   if(selected.includes("LTNT.EM"))groups.push({symbols:["LTNT.EM"],read:async()=>parseEastmoneyTin(await invokeLive("read_builtin_public_source",{key:"em-tin"}))});
   const results=await Promise.allSettled(groups.map(g=>g.read()));if(signal.aborted)throw Error("cancelled");
   const successes=results.flatMap(r=>r.status==="fulfilled"?[r.value]:[]);if(!successes.length)throw Error("all sources unavailable");
   const quotes=results.flatMap<import("../domain/agriculture/publicOverseasFutures").OverseasFutureQuote>((r,i)=>r.status==="fulfilled"?r.value.quotes.map(q=>({...q,collectedAt:r.value.collectedAt})):groups[i].symbols.map(symbol=>({symbol,price:null,sourceTime:null,sourceName:null,sourceTimeZone:null,sourceChangePct:null,warning:"该来源暂不可用"})));
   const snapshot={collectedAt:successes.map(s=>s.collectedAt).sort()[0],requestedSymbols:selected,quotes,missingSymbols:successes.flatMap(s=>s.missingSymbols)};
   return {status:snapshot.missingSymbols.length||quotes.some(q=>q.warning)?"degraded":"normal",data:{type:"public-overseas-futures",snapshot},observedAt:snapshot.collectedAt,retryable:false};
  }catch{return {status:"error",data:null,error:"海外公开快照读取失败或格式变化，暂不可用；旧记录保留来源时间",retryable:false};}
 }};
}
