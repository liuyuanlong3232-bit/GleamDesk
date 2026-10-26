import stations from "./publicNoaaStations.json";
import {receipt} from "../news/publicFeeds";

export const noaaDocumentation="https://www.ncei.noaa.gov/support/access-data-service-api-user-documentation";
export interface NoaaStationSummary {stationId:string;name:string;region:string;latestDate:string|null;precipTotal:number|null;precipDays:number;traceDays:number;tmaxMean:number|null;tmaxDays:number;tminMean:number|null;tminDays:number}
export interface PublicNoaaSnapshot {collectedAt:string;windowStart:string;windowEnd:string;stations:NoaaStationSummary[]}
const day=(value:unknown):value is string=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
function field(row:Record<string,unknown>,name:"PRCP"|"TMAX"|"TMIN"):number|null {
 const text=row[name],attributes=row[name+"_ATTRIBUTES"];
 if(typeof text!=="string"||! /^-?\d+(?:\.\d+)?$/.test(text.trim())||typeof attributes!=="string")return null;
 const flags=attributes.split(",").map(part=>part.trim());
 // Quality flag must be blank; presumed zero, absent observations and lagged temperatures are not observations for this day.
 if(flags.length<3||flags.length>4||flags[1]!==""||!flags[2]||!["","A","B","C","D","E","F","G","H","K","O","T","W"].includes(flags[0]))return null;
 const value=Number(text);
 if(!Number.isFinite(value)||value===-9999||value===-999.9)return null;
 return name==="PRCP"?(value>=0?value:null):(value>=-100&&value<=70?value:null);
}
export function parsePublicNoaa(raw:unknown):PublicNoaaSnapshot {
 const r=receipt(raw,"noaa-observed"),meta=raw as {windowStart?:unknown;windowEnd?:unknown;units?:unknown};
 const yesterday=new Date(Date.parse(new Date(r.collectedAt).toISOString().slice(0,10)+"T00:00:00Z")-86400000).toISOString().slice(0,10);
 if(meta.units!=="metric"||!day(meta.windowStart)||!day(meta.windowEnd)||Date.parse(meta.windowEnd)-Date.parse(meta.windowStart)!==29*86400000||meta.windowEnd>yesterday||Date.parse(yesterday)-Date.parse(meta.windowEnd)>86400000)throw Error("NOAA 单位或请求日期范围无效");
 const rows=JSON.parse(r.body) as unknown;
 if(!Array.isArray(rows)||rows.length>60)throw Error("NOAA 日记录结构变化");
 const seen=new Set<string>(),validRows:Record<string,unknown>[]=[];
 for(const value of rows){
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error("NOAA 日记录无效");
  const row=value as Record<string,unknown>;
  if(!stations.some(s=>s.id===row.STATION)||!day(row.DATE)||row.DATE<meta.windowStart||row.DATE>meta.windowEnd)throw Error("NOAA 站点或观测日期不符");
  const key=String(row.STATION)+row.DATE;if(seen.has(key))throw Error("NOAA 站点日期重复，暂不可用");seen.add(key);validRows.push(row);
 }
 const summaries=stations.map(station=>{
  const days=validRows.filter(row=>row.STATION===station.id).map(row=>({date:row.DATE as string,rain:field(row,"PRCP"),high:field(row,"TMAX"),low:field(row,"TMIN"),trace:typeof row.PRCP_ATTRIBUTES==="string"&&["T","H"].includes(row.PRCP_ATTRIBUTES.split(",")[0].trim())}));
  for(const row of days)if(row.high!==null&&row.low!==null&&row.low>row.high){row.high=null;row.low=null;}
  const rain=days.flatMap(row=>row.rain===null?[]:[row.rain]),high=days.flatMap(row=>row.high===null?[]:[row.high]),low=days.flatMap(row=>row.low===null?[]:[row.low]);
  const mean=(values:number[])=>values.length?Number((values.reduce((a,b)=>a+b,0)/values.length).toFixed(1)):null;
  return {stationId:station.id,name:station.name,region:station.region,latestDate:days.filter(row=>row.rain!==null||row.high!==null||row.low!==null).map(row=>row.date).sort().at(-1)??null,precipTotal:rain.length?Number(rain.reduce((a,b)=>a+b,0).toFixed(1)):null,precipDays:rain.length,traceDays:days.filter(row=>row.rain!==null&&row.trace&&row.rain===0).length,tmaxMean:mean(high),tmaxDays:high.length,tminMean:mean(low),tminDays:low.length};
 });
 if(!summaries.some(s=>s.latestDate))throw Error("NOAA 没有可用的站点观测记录");
 return {collectedAt:r.collectedAt,windowStart:meta.windowStart,windowEnd:meta.windowEnd,stations:summaries};
}
export function noaaState(snapshot:PublicNoaaSnapshot,station:NoaaStationSummary,failed=false,now=Date.now()):string {
 if(failed||now-Date.parse(snapshot.collectedAt)>7*3600000||snapshot.windowEnd!==new Date(Date.parse(new Date(now).toISOString().slice(0,10))-86400000).toISOString().slice(0,10))return "数据未更新";
 if(!station.latestDate)return "暂不可用";
 return [station.precipDays,station.tmaxDays,station.tminDays].every(count=>count===30)?"记录完整":"记录不完整";
}
