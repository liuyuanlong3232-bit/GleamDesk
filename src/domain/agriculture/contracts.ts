import {marketQuotes,newerCollection,tradingDate} from "./marketQuotes";
export interface SnapshotConnection {enabled:boolean;sshAlias:string;dataRoot:string;radarRoot:string;weatherEnabled?:boolean;githubEnabled?:boolean;newsEnabled?:boolean;marketEnabled?:boolean;aSharesEnabled?:boolean;chinaFuturesEnabled?:boolean;overseasFuturesEnabled?:boolean;cftcEnabled?:boolean;wasdeEnabled?:boolean;inspectionsEnabled?:boolean;noaaEnabled?:boolean;nassAnnualEnabled?:boolean;cropProgressEnabled?:boolean;monthlyEnabled?:boolean;monthlySource?:import("./publicReferenceData").MonthlySource;ibgeEnabled?:boolean;conabEnabled?:boolean;argentinaEnabled?:boolean;customSources?:import("./customHttpQuotes").CustomHttpSource[]}
export const emptySnapshotConnection:SnapshotConnection={enabled:false,sshAlias:"",dataRoot:"",radarRoot:"",weatherEnabled:true,githubEnabled:false,newsEnabled:true,marketEnabled:true,aSharesEnabled:true,chinaFuturesEnabled:true,overseasFuturesEnabled:true,cftcEnabled:true,wasdeEnabled:true,inspectionsEnabled:true,noaaEnabled:true,nassAnnualEnabled:true,cropProgressEnabled:true,monthlyEnabled:true,monthlySource:"worldbank",ibgeEnabled:true,conabEnabled:true,argentinaEnabled:true,customSources:[]};
export const snapshotOrigin=(config:SnapshotConnection)=>`ssh:${JSON.stringify([config.sshAlias,config.dataRoot,config.radarRoot])}`;
export interface RadarQuote {symbol:string;sourceSymbol:string;price:number;changePct:number|null;quoteAt:string|null;collectedAt:string;dataType:"intraday";source:string}
export interface MainContract {continuousSymbol:string;contractSymbol:string;mappingDate:string;confirmed?:boolean;collectedAt?:string;source?:string}
export interface RadarSnapshot {status:"available"|"unavailable";quotes:RadarQuote[];mainContracts:MainContract[]}
export interface AgricultureEnvelope {schemaVersion:1;origin:string;fetchedAt:string;market?:{symbol:string;history:{name:string;symbol:string;sourceDate:string;price:number;collectedDate:string;changePct?:number|null}[]}[];radar?:RadarSnapshot;chinaFutures?:{symbol:string;history:{name:string;symbol:string;sourceDate:string;price:number;collectedDate:string;previousClose:number|null;changePct:number|null;unit:string|null;source:string}[]}[];financeNews?:{title:string;source:string;publishedAt:string|null;summary:string;url:string|null;collectedAt:string|null}[];usdaReports?:{id:string;records:{report_date:string;report_type:string;commodity:string;metric_name:string;value:string|number;unit:string;value_outlier:boolean|number|string|null}[]}[];history?:{generatedAt:string;prices:Record<string,unknown>[]}[];snapshots:Record<string,{path:string;fileModifiedAt:string;payload:Record<string,unknown>}>}
export interface AgriculturePrice {name:string;symbol:string;price:number|null;change:number|null;date:string|null;status:"Cached"|"Stale"|"Unknown";unit:string|null;source:string;collectedAt?:string|null}
export interface AgricultureWeather {forecastDays?:{date:string;maximum:number|null;precip:number|null}[];representative?:boolean;forecastTimeZone?:string;name:string;crop:string;precip:number|null;maximum:number|null;source:string;generatedAt:string|null;sourceHint:string;slug?:string;latitude?:number|null;longitude?:number|null;weatherAt?:string|null;forecastStart?:string|null;forecastEnd?:string|null}
export interface AgricultureNews {id:string;title:string;url:string|null;publishedAt:string|null;status:"Cached"|"Stale"|"Unknown";source?:string;summary?:string}
const text=(value:unknown,max=300)=>typeof value==="string"?value.slice(0,max):"";
const numeric=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?value:null;
const rows=(value:unknown):Record<string,unknown>[]=>Array.isArray(value)?value.filter(item=>item&&typeof item==="object").slice(0,100):[];
const date=(value:unknown)=>typeof value==="string"&&Number.isFinite(Date.parse(value))?value:null;
export function observationState(value:string|null,now=Date.now(),maximumAgeDays=3):AgriculturePrice["status"] {if(!value)return "Unknown";const age=now-Date.parse(value);return !Number.isFinite(age)||age< -86400000?"Unknown":age>maximumAgeDays*86400000?"Stale":"Cached";}
export function agriculturePresentation(envelope:AgricultureEnvelope,now=Date.now()) {
  const global=envelope.snapshots.global_snapshot?.payload??{},china=envelope.snapshots.china_snapshot?.payload??{};
  const quotes=marketQuotes(envelope);
  const prices:AgriculturePrice[]=rows(global.prices).map(item=>{
    const day=tradingDate(item.quote_date),quote=quotes.get(text(item.symbol))?.at(-1);
    const selected=day&&quote?.dataType==="daily"&&quote.sourceDate>=day?quote:null;
    return {name:text(item.commodity),symbol:text(item.symbol),price:selected?.value??numeric(item.price),change:selected?selected.dayChange:numeric(item.change_pct),date:selected?.sourceDate??day,status:observationState(selected?.sourceDate??day,now),unit:null,source:selected?.source??"VPS / Yahoo Finance direct",collectedAt:selected?.collectedAt??null};
  });
  const chinaMarket=envelope.chinaFutures?.flatMap(group=>group.history.map(item=>({...item,symbol:item.symbol||group.symbol})))??[];
  const latestByChinaSymbol=new Map<string,typeof chinaMarket[number]>();
  for(const item of chinaMarket){
    const current=latestByChinaSymbol.get(item.symbol),day=tradingDate(item.sourceDate),currentDay=tradingDate(current?.sourceDate);
    if(!current||(day!==null&&(currentDay===null||day>currentDay))||(day===currentDay&&newerCollection(item.collectedDate,current.collectedDate)))latestByChinaSymbol.set(item.symbol,item);
  }
  const chinaRows:Record<string,unknown>[]=latestByChinaSymbol.size?[...latestByChinaSymbol.values()]:rows(china.futures).map(item=>({name:text(item.name??item.commodity),symbol:text(item.symbol??item.ts_code),sourceDate:tradingDate(item.sourceDate??item.trade_date??item.date??item.quote_date),price:numeric(item.last_price??item.close??item.price),previousClose:numeric(item.prev_close),changePct:numeric(item.change_pct),unit:typeof item.unit==="string"?text(item.unit):null,source:"Tushare",collectedDate:item.collectedDate??item.fetched_at??null}));
  const chinaDate=chinaRows.map(item=>tradingDate(item.sourceDate)).filter((item):item is string=>Boolean(item)).sort().at(-1)??null;
  prices.push(...chinaRows.map(item=>({name:text(item.name??item.commodity),symbol:text(item.symbol??item.ts_code),price:numeric(item.price),change:numeric(item.changePct),date:tradingDate(item.sourceDate),status:observationState(tradingDate(item.sourceDate),now),unit:typeof item.unit==="string"?text(item.unit):null,source:`VPS / ${text(item.source)||"Tushare"}`,collectedAt:date(item.collectedDate)})));
  const weather:AgricultureWeather[]=rows((global.weather as Record<string,unknown>|undefined)?.regions).map(item=>({name:text(item.name),crop:text(item.crop_focus),precip:numeric(item.precip_7d_mm),maximum:numeric(item.max_temp_7d_c),source:text(item.source)||"来源未知",generatedAt:date(global.generated_at_bjt),sourceHint:text(item.risk),slug:text(item.slug),latitude:numeric(item.latitude??item.lat),longitude:numeric(item.longitude??item.lon),weatherAt:date(item.updated_at??item.observed_at),forecastStart:date(item.forecast_start),forecastEnd:date(item.forecast_end)}));
  weather.push(...rows((china.weather as Record<string,unknown>|undefined)?.regions).map(item=>({name:text(item.region),crop:"",precip:numeric(item.precip_7d_mm),maximum:numeric(item.temp_max_7d_c),source:"VPS / Open-Meteo",generatedAt:date(china.generated_at_bjt),sourceHint:"",latitude:numeric(item.latitude??item.lat),longitude:numeric(item.longitude??item.lon),weatherAt:date(item.updated_at??item.observed_at),forecastStart:date(item.forecast_start),forecastEnd:date(item.forecast_end)})));
  const seen=new Set<string>();const financeRows=(envelope.financeNews??[]) as unknown as Record<string,unknown>[];const newsRows:Record<string,unknown>[]=[...rows(global.news),...financeRows];const news:AgricultureNews[]=newsRows.flatMap(item=>{let url:string|null=null;try{const value=new URL(text(item.url,4096));if(["http:","https:"].includes(value.protocol)&&!value.username&&!value.password)url=value.href;}catch{}
    const title=text(item.title,500);if(!title)return [];const id=url??title.toLocaleLowerCase();if(seen.has(id))return [];seen.add(id);
    const publishedAt=typeof item.epoch==="number"&&Number.isFinite(item.epoch)&&item.epoch>0&&item.epoch<1e11?new Date(item.epoch*1000).toISOString():date(item.publishedAt);
    return [{id,title,url,publishedAt,status:observationState(publishedAt,now,2),source:text(item.source),summary:text(item.summary,1200)}];}).sort((a,b)=>(Date.parse(b.publishedAt??"")||0)-(Date.parse(a.publishedAt??"")||0));
  return {prices,weather,news,globalGeneratedAt:date(global.generated_at_bjt),chinaGeneratedAt:date(china.generated_at_bjt),chinaDate};
}

// Approximate representative anchors for named regions, never station locations or crop boundaries.
const weatherAnchors:Record<string,[number,number]>={
  us_corn_belt:[41.5,-93.5],us_plains:[39,-100],brazil_mato_grosso:[-13,-56],brazil_parana:[-24.5,-51.5],argentina_core:[-33,-61],
  "美国玉米带":[41.5,-93.5],"美国大平原":[39,-100],"巴西马托格罗索":[-13,-56],"巴西巴拉那":[-24.5,-51.5],"阿根廷核心区":[-33,-61],
  "内蒙古":[43.5,112],"黑龙江":[47,128],"新疆":[42,85],"河南":[34,113.5]
};
export function agricultureWeatherPosition(item:AgricultureWeather):{x:number;y:number;representative:boolean}|null{
  const supplied=typeof item.latitude==="number"&&Number.isFinite(item.latitude)&&typeof item.longitude==="number"&&Number.isFinite(item.longitude)&&item.latitude>=-60&&item.latitude<=85&&item.longitude>=-180&&item.longitude<=180;
  const anchor=supplied?[item.latitude!,item.longitude!]:weatherAnchors[item.slug??""]??weatherAnchors[item.name];if(!anchor)return null;
  return {x:(anchor[1]+180)/360*100,y:(85-anchor[0])/145*100,representative:item.representative===true||!supplied};
}
export function agricultureWeatherValue(item:AgricultureWeather,metric:"temperature"|"rain"):number|null{
  const value=metric==="temperature"?item.maximum:item.precip;
  return typeof value==="number"&&Number.isFinite(value)&&(metric==="temperature"||value>=0)?value:null;
}
export function agricultureWeatherTone(item:AgricultureWeather,metric:"temperature"|"rain"):string{
  const value=agricultureWeatherValue(item,metric);if(value===null)return "unknown";
  return metric==="temperature"?value>=35?"hot":value>=25?"warm":"cool":value>=80?"wet":value>=20?"rain":"dry";
}
export function agricultureSnapshotStatus(at:string|null,now=Date.now()):"cached"|"stale"|"unknown"{
  const age=at?now-Date.parse(at):NaN;
  return !Number.isFinite(age)||age<0?"unknown":age>86400000?"stale":"cached";
}
