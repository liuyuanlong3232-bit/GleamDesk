import {receipt} from "../news/publicFeeds";
import {tradingDate} from "./marketQuotes";
import releaseCalendar from "./cftcReleaseCalendar2026.json";

export const cftcReleaseCalendar=releaseCalendar;
export function cftcNextRelease(now=Date.now()):{date:string;at:string}|null {
 if(!Number.isFinite(now)||!Number.isFinite(new Date(now).getTime()))return null;
 const local=new Intl.DateTimeFormat("en",{timeZone:releaseCalendar.timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
 const part=(name:string)=>local.find(p=>p.type===name)?.value;
 const day=`${part("year")}-${part("month")}-${part("day")}`;
 if(day<releaseCalendar.coverageFrom||day>releaseCalendar.coverageTo)return null;
 const [hour,minute]=releaseCalendar.releaseTime.split(":").map(Number);
 for(const date of releaseCalendar.releaseDates){
  if(date<day)continue;
  // Resolve this date's Eastern offset through Intl, including daylight saving.
  const base=Date.parse(`${date}T${releaseCalendar.releaseTime}:00Z`);
  const clock=new Intl.DateTimeFormat("en",{timeZone:releaseCalendar.timeZone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(base);
  const easternHour=Number(clock.find(p=>p.type==="hour")?.value),easternMinute=Number(clock.find(p=>p.type==="minute")?.value);
  const at=base+((hour-easternHour)*60+minute-easternMinute)*60000;
  if(at>now)return {date,at:new Date(at).toISOString()};
 }
 return null;
}

export const cftcMarkets=[
 {code:"002602",commodity:"corn",name:"玉米",market:"CORN - CHICAGO BOARD OF TRADE"},
 {code:"005602",commodity:"soybeans",name:"大豆",market:"SOYBEANS - CHICAGO BOARD OF TRADE"},
 {code:"026603",commodity:"soybean_meal",name:"豆粕",market:"SOYBEAN MEAL - CHICAGO BOARD OF TRADE"},
 {code:"007601",commodity:"soybean_oil",name:"豆油",market:"SOYBEAN OIL - CHICAGO BOARD OF TRADE"},
 {code:"001612",commodity:"wheat_hrw",name:"硬红冬麦",market:"WHEAT-HRW - CHICAGO BOARD OF TRADE"},
 {code:"001602",commodity:"wheat_srw",name:"软红冬麦",market:"WHEAT-SRW - CHICAGO BOARD OF TRADE"},
] as const;
export interface CftcPosition {
 code:string;commodity:string;name:string;market:string;contractUnits:string|null;reportDate:string|null;
 open_interest_all:number|null;managed_money_long:number|null;managed_money_short:number|null;managed_money_net:number|null;
 managed_money_change_long:number|null;managed_money_change_short:number|null;warning:string;
}
export interface PublicCftcSnapshot {source:"CFTC Disaggregated Futures Only";collectedAt:string;reportDate:string;items:CftcPosition[]}
const fields=[['open_interest_all','open_interest_all'],['managed_money_long','m_money_positions_long_all'],['managed_money_short','m_money_positions_short_all'],['managed_money_change_long','change_in_m_money_long_all'],['managed_money_change_short','change_in_m_money_short_all']] as const;
function count(value:unknown,signed=false):number|null {
 if(typeof value!=="number"&&(typeof value!=="string"||!/^[-+]?\d+$/.test(value)))return null;
 const number=Number(value);return Number.isSafeInteger(number)&&(signed||number>=0)?number:null;
}
function empty(market:typeof cftcMarkets[number],warning:string):CftcPosition {
 return {code:market.code,commodity:market.commodity,name:market.name,market:market.market,contractUnits:null,reportDate:null,open_interest_all:null,managed_money_long:null,managed_money_short:null,managed_money_net:null,managed_money_change_long:null,managed_money_change_short:null,warning};
}
export function parsePublicCftc(raw:unknown):PublicCftcSnapshot {
 const value=receipt(raw,"cftc-agri"),rows:unknown=JSON.parse(value.body);
 if(!Array.isArray(rows)||!rows.length||rows.length>60)throw Error("CFTC 返回空记录或格式已变化，暂不可用");
 const latest=new Map<string,CftcPosition>(),blocked=new Set<string>();
 for(const raw of rows){
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("CFTC 记录格式无效");
  const row=raw as Record<string,unknown>,market=cftcMarkets.find(m=>m.code===row.cftc_contract_market_code);
  if(!market||row.futonly_or_combined!=="FutOnly"||row.market_and_exchange_names!==market.market)throw Error("CFTC 市场代码、交易所或期货口径不匹配");
  const date=typeof row.report_date_as_yyyy_mm_dd==="string"&&/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?$/.test(row.report_date_as_yyyy_mm_dd)?tradingDate(row.report_date_as_yyyy_mm_dd):null;
  if(!date||date>value.collectedAt.slice(0,10)){blocked.add(market.code);continue;}
  const item=empty(market,"");item.reportDate=date;
  item.contractUnits=typeof row.contract_units==="string"&&row.contract_units.trim()?row.contract_units.trim().slice(0,160):null;
  for(const [target,key] of fields)item[target]=count(row[key],target.includes("change"));
  item.managed_money_net=item.managed_money_long!==null&&item.managed_money_short!==null?item.managed_money_long-item.managed_money_short:null;
  const invalid=fields.some(([target])=>item[target]===null);
  item.warning=invalid?"部分持仓字段缺失，显示 —":"";
  const previous=latest.get(market.code);
  if(!previous||date>previous.reportDate!)latest.set(market.code,item);
  else if(date===previous.reportDate&&JSON.stringify(item)!==JSON.stringify(previous)){
   const missing=empty(market,"同日记录冲突，暂不可用");missing.reportDate=date;latest.set(market.code,missing);
  }
 }
 const items=cftcMarkets.map(market=>blocked.has(market.code)?empty(market,"报告日期无效，暂不可用"):latest.get(market.code)??empty(market,"该市场暂无记录"));
 const dates=items.flatMap(item=>item.reportDate?[item.reportDate]:[]).sort();
 if(!items.some(item=>item.managed_money_net!==null)||!dates.length)throw Error("CFTC 没有可核对的管理基金持仓记录");
 return {source:"CFTC Disaggregated Futures Only",collectedAt:value.collectedAt,reportDate:dates.at(-1)!,items};
}
export function cftcRowState(item:CftcPosition,snapshot:PublicCftcSnapshot,failed=false,now=Date.now()):string {
 if(!item.reportDate)return item.warning||"暂不可用";
 const state=failed?"数据未更新（读取失败）":item.reportDate<snapshot.reportDate?"数据未更新（早于本批其他市场）":now-Date.parse(snapshot.collectedAt)>2*3600000?"数据未更新（缓存超过2小时）":now-Date.parse(item.reportDate)>14*86400000?"历史报告（持仓日已超过14天）":"";
 return [state,item.warning].filter(Boolean).join("；")||"周报 · 发布时效未确认";
}
