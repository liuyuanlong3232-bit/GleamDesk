import regions from "./publicWeatherRegions.json";
import type {AgricultureWeather} from "./contracts";
import {publicTimestamp} from "../news/publicFeeds";
export interface PublicWeatherIssue{name:string;reason:string}
export interface PublicWeatherSnapshot{source:"Open-Meteo";collectedAt:string;weather:AgricultureWeather[];issues?:PublicWeatherIssue[]}
const validDay=(value:unknown):value is string=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+"T00:00:00Z"))&&new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
export function parsePublicWeather(raw:unknown):PublicWeatherSnapshot{
 const value=raw as {source?:string;collectedAt?:string;payload?:unknown[]};
 if(value?.source!=="Open-Meteo"||!publicTimestamp(value.collectedAt)||Date.parse(value.collectedAt!)>Date.now()+60000||!Array.isArray(value.payload)||value.payload.length!==regions.length)throw Error("天气来源、时间或产区数量不符");
 const issues:PublicWeatherIssue[]=[];
 const weather=regions.flatMap((region,index)=>{
  const unavailable=(reason:string):AgricultureWeather[]=>{issues.push({name:region.name,reason});return [];};
  const row=value.payload![index] as {latitude:number;longitude:number;utc_offset_seconds:number;daily_units:Record<string,string>;daily:{time:unknown[];temperature_2m_max:unknown[];precipitation_sum:unknown[]}};
  if(!row||!Number.isFinite(row.latitude)||!Number.isFinite(row.longitude)||Math.abs(row.latitude-region.latitude)>0.75||Math.abs(row.longitude-region.longitude)>0.75||row.utc_offset_seconds!==0||row.daily_units?.temperature_2m_max!=="°C"||row.daily_units?.precipitation_sum!=="mm")return unavailable("坐标、时区或单位不符");
  const daily=row.daily;
  if(!daily||!Array.isArray(daily.time)||daily.time.length!==7||!daily.time.every(validDay)||daily.time.some((day,i)=>i>0&&Date.parse(day as string)-Date.parse(daily.time[i-1] as string)!==86400000))return unavailable("预报日期不完整");
  if(daily.time[0]!==new Date(value.collectedAt!).toISOString().slice(0,10))return unavailable("预报仍是旧日期");
  const complete=(values:unknown[],rain=false)=>Array.isArray(values)&&values.length===7&&values.every(n=>typeof n==="number"&&Number.isFinite(n)&&(!rain||n>=0));
  const temp=complete(daily.temperature_2m_max)?Math.max(...daily.temperature_2m_max as number[]):null;
  const rain=complete(daily.precipitation_sum,true)?Number((daily.precipitation_sum as number[]).reduce((a,b)=>a+b,0).toFixed(2)):null;
  const dailyNumber=(n:unknown,rain=false)=>typeof n==="number"&&Number.isFinite(n)&&(!rain||n>=0)?n:null;
  const aligned=(values:unknown)=>Array.isArray(values)&&values.length===7;
  const forecastDays=daily.time.map((day,i)=>({date:String(day),maximum:aligned(daily.temperature_2m_max)?dailyNumber(daily.temperature_2m_max[i]):null,precip:aligned(daily.precipitation_sum)?dailyNumber(daily.precipitation_sum[i],true):null}));
  return [{...region,forecastDays,representative:true,forecastTimeZone:"UTC",maximum:temp,precip:rain,source:"Open-Meteo · 本机直连",generatedAt:value.collectedAt!,weatherAt:null,forecastStart:String(daily.time[0]),forecastEnd:String(daily.time[6]),sourceHint:temp===null||rain===null?"部分天气数据缺失":"",}];
 });
 if(!weather.length)throw Error("天气产区均未通过校验，暂不可用");
 return {source:"Open-Meteo",collectedAt:value.collectedAt!,weather,issues};
}
