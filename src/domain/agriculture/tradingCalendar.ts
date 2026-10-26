import calendar from "./tradingCalendar2026.json";
import {tradingDate} from "./marketQuotes";

export const domesticCalendar=calendar;
type Exchange=keyof typeof calendar.exchanges;
export interface TradingDayAssessment {
 date:string|null;reason:string;exchange?:Exchange;session?:"day"|"night";
}
// Minutes after the civil evening's midnight; null means day sessions only.
const nightEnds:Record<string,Record<string,number|null>>={
 SHF:{AG:1590,SN:1500},
 DCE:{A:1380,C:1380,CS:1380,M:1380,Y:1380,P:1380,JD:null,LH:null},
 ZCE:{CF:1380,SR:1380,OI:1380,WH:null},
};
const closed=new Set(calendar.closedWeekdays),noNight=new Set(calendar.noNightEvenings);
const dayOffset=86400000,chinaOffset=8*3600000;
const civilDay=(epoch:number)=>new Date(epoch+chinaOffset).toISOString().slice(0,10);
const shift=(day:string,days:number)=>new Date(Date.parse(day)+days*dayOffset).toISOString().slice(0,10);
function covered(day:string):boolean {return tradingDate(day)===day&&day>=calendar.coverageFrom&&day<=calendar.coverageTo;}
export function domesticOpenDay(day:string):boolean|null {
 if(!covered(day))return null;
 const weekday=new Date(day).getUTCDay();return weekday!==0&&weekday!==6&&!closed.has(day);
}
function followingOpenDay(day:string):string|null {
 for(let i=1;i<=15;i++){const next=shift(day,i),open=domesticOpenDay(next);if(open===null)return null;if(open)return next;}return null;
}
function sourceEpoch(value:string|null|undefined):number|null {
 if(!value||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)||!tradingDate(value))return null;
 const at=Date.parse(value);return Number.isFinite(at)?at:null;
}
function instrument(symbol:string):{exchange:Exchange;nightEnd?:number|null;stock:boolean}|null {
 const normalized=symbol.trim().toUpperCase(),stock=/^\d{6}\.(SH|SZ)$/.exec(normalized);
 if(stock)return {exchange:stock[1] as Exchange,stock:true};
 const future=/^([A-Z]{1,2})\d{2}(?:0[1-9]|1[0-2])\.(SHF|DCE|ZCE)$/.exec(normalized);
 if(!future||!Object.hasOwn(nightEnds[future[2]],future[1]))return null;
 return {exchange:future[2] as Exchange,stock:false,nightEnd:nightEnds[future[2]][future[1]]};
}
export function inferDomesticTradingDay(symbol:string,sourceTime:string|null|undefined,now=Date.now()):TradingDayAssessment {
 const profile=instrument(symbol),unknown=(reason:string):TradingDayAssessment=>({date:null,reason,exchange:profile?.exchange});
 if(!profile)return unknown("市场或品种规则未覆盖");
 const at=sourceEpoch(sourceTime);if(at===null||!Number.isFinite(new Date(now).getTime())||at>now+60000)return unknown("来源时间未确认");
 const day=civilDay(at);
 if(!covered(day)||!covered(civilDay(now)))return unknown("日历覆盖不足");
 const second=((at+chinaOffset)%dayOffset+dayOffset)%dayOffset/1000;
 if(profile.stock){
  // Tencent exposes an update clock, not a separately certified trade-date field.
  if(!domesticOpenDay(day))return unknown("来源日期为休市日");
  return {date:day,exchange:profile.exchange,session:"day",reason:"按来源日期和交易所开市日推定；更新时刻不证明成交时刻"};
 }
 if([[540,615],[630,690],[810,900]].some(([start,end])=>second>=start*60&&second<=end*60)){
  if(!domesticOpenDay(day))return unknown("来源日期为休市日");
  return {date:day,exchange:profile.exchange,session:"day",reason:"按来源时刻、交易日历及日盘时段推定"};
 }
 const end=profile.nightEnd;
 if(end===null||end===undefined)return unknown("该品种无夜盘或来源时刻不在交易时段");
 const afterMidnight=end>=1440&&second<=(end-1440)*60;
 const evening=afterMidnight?shift(day,-1):day;
 const eveningSecond=afterMidnight?second+86400:second;
 if(eveningSecond<1260*60||eveningSecond>end*60)return unknown("来源时刻不在交易时段");
 if(!covered(evening))return unknown("日历覆盖不足");
 if(!domesticOpenDay(evening)||noNight.has(evening))return unknown("该晚无夜盘安排");
 const next=followingOpenDay(evening);if(!next)return unknown("日历覆盖不足");
 return {date:next,exchange:profile.exchange,session:"night",reason:"按来源时刻、交易日历及夜盘时段推定；不代表来源确认"};
}
export function domesticTradingDayLabel(symbol:string,sourceTime:string|null|undefined,now=Date.now()):string {
 const result=inferDomesticTradingDay(symbol,sourceTime,now);
 return result.date?`推定交易日 ${result.date}`:result.reason==="日历覆盖不足"?"交易日未确认（日历覆盖不足）":"交易日未确认";
}
export function domesticSnapshotLabel(symbol:string,sourceTime:string|null|undefined,now=Date.now()):string {
 const profile=instrument(symbol),at=sourceEpoch(sourceTime);
 if(profile&&Number.isFinite(new Date(now).getTime())&&domesticOpenDay(civilDay(now))===false){
  // Saturday's early SHFE night session is still running; Sunday is not.
  const nowSession=profile.stock?null:inferDomesticTradingDay(symbol,new Date(now).toISOString(),now);
  if(!nowSession?.date)return "休市快照";
 }
 return at!==null&&Number.isFinite(new Date(now).getTime())&&civilDay(at)===civilDay(now)?"公开快照":"历史快照";
}
