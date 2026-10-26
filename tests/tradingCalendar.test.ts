import {test} from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {domesticCalendar,domesticOpenDay,inferDomesticTradingDay,domesticTradingDayLabel,domesticSnapshotLabel} from "../src/domain/agriculture/tradingCalendar";
import {chinaFutureQuote,chinaFutureState,type ChinaFutureQuote} from "../src/domain/agriculture/publicChinaFutures";
import {aStockQuote,aStockState,type AStockQuote} from "../src/domain/agriculture/publicAStocks";
import {overseasFutureState,type OverseasFutureQuote} from "../src/domain/agriculture/publicOverseasFutures";
import {MarketWatchRow} from "../src/components/MarketWorkspace";

const weekend=Date.parse("2026-10-24T18:00:00+08:00");
const assess=(symbol:string,time:string,now=weekend)=>inferDomesticTradingDay(symbol,time,now);
test("日历带来源、核对时间和明确覆盖范围，不读取服务器或凭据",()=>{
 assert.equal(domesticCalendar.coverageFrom,"2026-01-01");assert.equal(domesticCalendar.coverageTo,"2026-12-31");
 assert.equal(domesticCalendar.timezone,"Asia/Shanghai");assert.ok(Number.isFinite(Date.parse(domesticCalendar.checkedAt)));
 for(const exchange of Object.values(domesticCalendar.exchanges))assert.match(exchange.calendarSource.url,/^https:\/\//);
 for(const exchange of [domesticCalendar.exchanges.DCE,domesticCalendar.exchanges.ZCE]){
  assert.match(exchange.calendarSource.sha256,/^[a-f0-9]{64}$/);assert.match(exchange.calendarSource.retrievedAt,/^2026-10-18/);
 }
});
test("全年工作日只按交易所休市安排扣除，调休周末不开市",()=>{
 for(const day of ["2026-01-04","2026-02-14","2026-02-28","2026-05-09","2026-09-20","2026-10-10"])assert.equal(domesticOpenDay(day),false,day);
 for(const day of ["2026-01-05","2026-02-24","2026-04-07","2026-05-06","2026-06-22","2026-09-28","2026-10-08"])assert.equal(domesticOpenDay(day),true,day);
 assert.equal(domesticCalendar.closedWeekdays.length,19);
});
test("休市日期包括长假末尾，坏日期及未覆盖年份返回未知",()=>{
 for(const day of ["2026-01-01","2026-02-23","2026-04-06","2026-05-05","2026-06-19","2026-09-25","2026-10-07"])assert.equal(domesticOpenDay(day),false);
 for(const day of ["2026-02-30","2025-12-31","2027-01-01","garbage"])assert.equal(domesticOpenDay(day),null);
});
test("周五夜盘及周六凌晨沪银归入下周一，来源时刻原样保留",()=>{
 for(const time of ["2026-10-23T21:00:00+08:00","2026-10-23T23:59:59+08:00","2026-10-24T00:00:00+08:00","2026-10-24T02:30:00+08:00"]){const result=assess("AG2612.SHF",time);assert.equal(result.date,"2026-10-26",time);assert.equal(result.session,"night");}
 assert.equal(assess("AG2612.SHF","2026-10-24T02:30:01+08:00").date,null);
});
test("沪锡与沪银夜盘结束不同，不能一律套02:30",()=>{
 assert.equal(assess("SN2611.SHF","2026-10-24T01:00:00+08:00").date,"2026-10-26");
 assert.equal(assess("SN2611.SHF","2026-10-24T01:00:01+08:00").date,null);
});
test("大商所与郑商所夜盘到23点，不能延伸到次日凌晨",()=>{
 for(const symbol of ["A2701.DCE","C2701.DCE","CS2701.DCE","M2701.DCE","Y2701.DCE","P2701.DCE","CF2701.ZCE","SR2701.ZCE","OI2701.ZCE"]){
  assert.equal(assess(symbol,"2026-10-23T23:00:00+08:00").date,"2026-10-26",symbol);
  assert.equal(assess(symbol,"2026-10-23T23:00:01+08:00").date,null,symbol);
  assert.equal(assess(symbol,"2026-10-24T00:00:00+08:00").date,null,symbol);
 }
});
test("鸡蛋、生猪、强麦只有日盘，不根据其他品种的夜盘推定",()=>{
 for(const symbol of ["JD2612.DCE","LH2701.DCE","WH2611.ZCE"]){
  assert.equal(assess(symbol,"2026-10-23T15:00:00+08:00").date,"2026-10-23");
  assert.equal(assess(symbol,"2026-10-23T21:01:00+08:00").date,null);
 }
});
test("日盘分段及收盘端点有效，休息时段不推定",()=>{
 for(const time of ["09:00:00","10:15:00","10:30:00","11:30:00","13:30:00","15:00:00"])assert.equal(assess("C2701.DCE",`2026-10-23T${time}+08:00`).date,"2026-10-23",time);
 for(const time of ["08:59:59","10:15:01","10:29:59","11:30:01","13:29:59","15:00:01","20:59:59"])assert.equal(assess("C2701.DCE",`2026-10-23T${time}+08:00`).date,null,time);
});
test("周一凌晨和周日晚上没有凭空生成夜盘",()=>{
 const now=Date.parse("2026-10-26T10:00:00+08:00");
 for(const time of ["2026-10-26T01:00:00+08:00","2026-10-25T21:30:00+08:00","2026-10-24T21:30:00+08:00"])assert.equal(assess("AG2612.SHF",time,now).date,null,time);
});
test("所有节前停夜盘及其次日凌晨均不推定为节后交易日",()=>{
 for(const day of domesticCalendar.noNightEvenings){
  const next=new Date(Date.parse(day)+86400000).toISOString().slice(0,10),now=Date.parse(next+"T12:00:00+08:00");
  for(const symbol of ["AG2612.SHF","C2701.DCE","CF2701.ZCE"])assert.equal(assess(symbol,day+"T21:00:00+08:00",now).date,null,day+symbol);
  assert.equal(assess("AG2612.SHF",next+"T00:30:00+08:00",now).date,null,next);
 }
});
test("节后首日日盘正常，前夜不开，节后当晚归次一交易日",()=>{
 const now=Date.parse("2026-10-09T10:00:00+08:00");
 assert.equal(assess("AG2612.SHF","2026-10-07T21:00:00+08:00",now).date,null);
 assert.equal(assess("AG2612.SHF","2026-10-08T09:00:00+08:00",now).date,"2026-10-08");
 assert.equal(assess("AG2612.SHF","2026-10-08T21:00:00+08:00",now).date,"2026-10-09");
});
test("日期按北京时间，等价UTC时间不会算成另一交易日",()=>{
 assert.equal(assess("AG2612.SHF","2026-10-23T18:30:00Z").date,"2026-10-26");
 assert.equal(assess("C2701.DCE","2026-10-23T07:00:00Z").date,"2026-10-23");
});
test("跨年目标或当前日期超出覆盖时降为未确认，不沿用旧日历",()=>{
 const end=Date.parse("2026-12-31T23:00:00+08:00");
 assert.equal(assess("AG2701.SHF","2026-12-31T21:00:00+08:00",end).reason,"日历覆盖不足");
 assert.equal(assess("C2701.DCE","2026-12-31T15:00:00+08:00",end).date,"2026-12-31");
 assert.equal(assess("C2701.DCE","2026-12-31T15:00:00+08:00",Date.parse("2027-01-01T10:00:00+08:00")).date,null);
 assert.match(domesticTradingDayLabel("C2701.DCE","2026-12-31T15:00:00+08:00",Date.parse("2027-01-01T10:00:00+08:00")),/覆盖不足/);
});
test("源日期非法、缺失、时区缺失、时钟异常均不补本机日期",()=>{
 for(const time of ["","2026-02-30T09:00:00+08:00","2026-10-23T24:00:00+08:00","2026-10-23T09:00:00","2026-10-26T09:00:00+08:00"])assert.equal(assess("C2701.DCE",time).date,null,time);
 for(const now of [NaN,Infinity,1e20])assert.doesNotThrow(()=>assert.equal(assess("C2701.DCE","2026-10-23T09:00:00+08:00",now).date,null));
});
test("未知市场、连续主力、错误交易所和北交所未核规则保持未知",()=>{
 for(const symbol of ["AG.SHF","AG2612.DCE","C2613.DCE","GC=F","LTNT.EM","DX-Y.NYB","920001.BJ","anything"])assert.equal(assess(symbol,"2026-10-23T09:00:00+08:00").date,null,symbol);
});
test("沪深股票使用来源更新日期与各自日历，不要求更新时间等于成交时刻",()=>{
 for(const symbol of ["600000.SH","000426.SZ"]){
  assert.equal(assess(symbol,"2026-10-23T16:14:33+08:00").date,"2026-10-23");
  assert.equal(assess(symbol,"2026-10-24T16:14:33+08:00").date,null);
 }
});
test("休市快照不等于数据读取失败，周六凌晨仍在夜盘时不叫休市",()=>{
 assert.equal(domesticSnapshotLabel("AG2612.SHF","2026-10-24T02:00:00+08:00",Date.parse("2026-10-24T02:01:00+08:00")),"公开快照");
 assert.equal(domesticSnapshotLabel("AG2612.SHF","2026-10-24T02:00:00+08:00",weekend),"休市快照");
 assert.equal(domesticSnapshotLabel("000426.SZ","2026-10-23T16:00:00+08:00",weekend),"休市快照");
});
const future:ChinaFutureQuote={symbol:"C2701.DCE",name:"合成玉米",price:2209,previousSettlement:2200,sourceTime:"2026-10-23T23:00:00+08:00"};
test("日历推定不改来源时间、价格、涨跌幅或日历史键",()=>{
 const before=JSON.stringify(future),quote=chinaFutureQuote(future,"2026-10-24T10:00:00Z")!;
 assert.equal(assess(future.symbol,future.sourceTime!).date,"2026-10-26");assert.equal(quote.sourceDate,"2026-10-23");assert.equal(quote.value,2209);assert.equal(quote.dayChange,null);assert.equal(quote.dataType,"intraday");assert.equal(JSON.stringify(future),before);
});
test("断网和旧缓存的错误优先级保持，不被日历改写成正常",()=>{
 const snapshot={collectedAt:new Date(weekend).toISOString(),requestedSymbols:[future.symbol],quotes:[future],missingSymbols:[]};
 assert.equal(chinaFutureState(future,snapshot,false,weekend),"休市快照 · 推定交易日 2026-10-26");
 assert.match(chinaFutureState(future,snapshot,true,weekend),/^数据未更新/);
 assert.match(chinaFutureState(future,snapshot,false,weekend+150001),/^数据未更新/);
 assert.equal(chinaFutureState({...future,price:null},snapshot,false,weekend),"暂不可用");
});
test("股票错误和来源涨跌幅冲突不会被推定状态掩盖",()=>{
 const stock:AStockQuote={symbol:"000426.SZ",name:"合成",price:10,previousClose:9,changePct:null,quoteAt:"2026-10-23T16:00:00+08:00",warning:"涨跌幅字段待核对"};
 const snapshot={collectedAt:new Date(weekend).toISOString(),requestedSymbols:[stock.symbol],quotes:[stock],missingSymbols:[]};
 assert.equal(aStockState(stock,snapshot,false,weekend),stock.warning);assert.equal(aStockState(stock,snapshot,true,weekend),"数据未更新");
 assert.match(aStockState({...stock,warning:undefined},snapshot,false,weekend),/休市快照.*推定交易日 2026-10-23/);
 assert.equal(aStockQuote(stock,snapshot.collectedAt)!.sourceDate,"2026-10-23");
});
test("市场和农业共用的行在折叠详情展示推定依据、覆盖和来源",()=>{
 const quote=chinaFutureQuote(future,"2026-10-24T10:00:00Z");
 const html=renderToStaticMarkup(createElement(MarketWatchRow,{asset:{id:"test",symbol:future.symbol,name:"玉米"},quote,stateLabel:"休市快照 · 推定交易日 2026-10-26",sourceTimeOnly:true,previousSettlement:2200,now:weekend}));
 for(const expected of ["2209","23:00:00","推定交易日：2026-10-26","不代表来源确认","2026-12-31","日历来源","不写入日收盘历史","不等同昨收盘","不代表已确认主力"])assert.ok(html.includes(expected),expected);
 assert.ok(!html.includes("夜盘所属交易日待核对"));
});
test("海外价格状态继续未确认，不拿国内日历套用",()=>{
 const row:OverseasFutureQuote={symbol:"GC=F",price:4007.9,sourceTime:"2026-10-24T04:59:58+08:00",sourceName:"Synthetic",sourceTimeZone:"America/New_York",sourceChangePct:null};
 const snapshot={collectedAt:new Date(weekend).toISOString(),requestedSymbols:[row.symbol],quotes:[row],missingSymbols:[]};
 assert.match(overseasFutureState(row,snapshot,false,weekend),/交易日未确认/);assert.ok(!overseasFutureState(row,snapshot,false,weekend).includes("推定"));
});
