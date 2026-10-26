import {receipt} from "../news/publicFeeds";
import type {MarketQuote} from "./marketQuotes";

// Fixed source identities; the dollar index is explicitly INDEX, never a futures alias.
export const overseasFutures:Record<string,{name:string;exchange:string;currency:string;unit:string;instrumentType?:"INDEX";source?:"eastmoney"}>={
 "LTNT.EM":{name:"LME 综合锡03",exchange:"LME",currency:"USD",unit:"美元/吨",source:"eastmoney"},
 "CT00Y.EM":{name:"ICE 棉花（当月连续）",exchange:"NYBOT",currency:"USX",unit:"美分/磅",source:"eastmoney"},
 "DX-Y.NYB":{name:"美元指数",exchange:"NYB",currency:"USD",unit:"指数点",instrumentType:"INDEX"},
 "GC=F":{name:"COMEX 黄金",exchange:"CMX",currency:"USD",unit:"美元/金衡盎司"},
 "SI=F":{name:"COMEX 白银",exchange:"CMX",currency:"USD",unit:"美元/金衡盎司"},
 "CL=F":{name:"WTI 原油",exchange:"NYM",currency:"USD",unit:"美元/桶"},
 "ZC=F":{name:"CBOT 玉米",exchange:"CBT",currency:"USX",unit:"美分/蒲式耳"},
 "ZS=F":{name:"CBOT 大豆",exchange:"CBT",currency:"USX",unit:"美分/蒲式耳"},
 "ZW=F":{name:"CBOT 软红冬麦",exchange:"CBT",currency:"USX",unit:"美分/蒲式耳"},
 "ZL=F":{name:"CBOT 豆油",exchange:"CBT",currency:"USX",unit:"美分/磅"},
 "ZM=F":{name:"CBOT 豆粕",exchange:"CBT",currency:"USD",unit:"美元/短吨"},
 "CT=F":{name:"ICE 棉花",exchange:"NYB",currency:"USX",unit:"美分/磅"},
 "SB=F":{name:"ICE 原糖",exchange:"NYB",currency:"USX",unit:"美分/磅"},
};
export const agricultureFuturesSymbols=["ZC=F","ZS=F","ZW=F","ZL=F","ZM=F","CT00Y.EM","SB=F"];
export function overseasFutureSymbol(value:string):string|null {const s=value.trim().toUpperCase();return Object.prototype.hasOwnProperty.call(overseasFutures,s)?s:null;}
export function overseasFutureSymbols(values:string[]):string[]{return [...new Set(values.map(overseasFutureSymbol).filter((s):s is string=>s!==null))].sort();}
export interface OverseasFutureQuote {symbol:string;price:number|null;sourceTime:string|null;sourceName:string|null;sourceTimeZone:string|null;sourceChangePct:number|null;sourceType?:string;collectedAt?:string;warning?:string}
export interface OverseasFuturesSnapshot {collectedAt:string;requestedSymbols:string[];quotes:OverseasFutureQuote[];missingSymbols:string[]}
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
const finite=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
const text=(v:unknown):string|null=>typeof v==="string"&&v.length>0&&v.length<=160&&!/[\u0000-\u001f\ufffd]/.test(v)?v:null;
// Spark changes these rolling aliases between FUTURE and ALTSYMBOL. An alias
// needs matching product and full exchange names in addition to code/currency;
// it is still a rolling public series, never an inferred delivery contract.
const yahooAliasIdentity:Record<string,{exchange:string;name:RegExp}>={
 "GC=F":{exchange:"COMEX",name:/^Gold (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2}$/},
 "SI=F":{exchange:"COMEX",name:/^Silver (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2}$/},
 "CL=F":{exchange:"NY Mercantile",name:/^Crude Oil (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2}$/},
 "ZC=F":{exchange:"CBOT",name:/^Corn Futures,(?:Mar|May|Jul|Sep|Dec)-20\d{2}$/},
 "ZS=F":{exchange:"CBOT",name:/^Soybean Futures,(?:Jan|Mar|May|Jul|Aug|Sep|Nov)-20\d{2}$/},
 "ZW=F":{exchange:"CBOT",name:/^Chicago SRW Wheat Futures,(?:Mar|May|Jul|Sep|Dec)-2(?:0\d{2})?$/},
 "ZL=F":{exchange:"CBOT",name:/^Soybean Oil Futures,(?:Jan|Mar|May|Jul|Aug|Sep|Oct|Dec)-20\d{2}$/},
 "ZM=F":{exchange:"CBOT",name:/^Soybean Meal Futures,(?:Jan|Mar|May|Jul|Aug|Sep|Oct|Dec)-20\d{2}$/},
 "SB=F":{exchange:"ICE Futures",name:/^Sugar #11 (?:Mar|May|Jul|Oct) \d{2}$/},
};
export function parseOverseasFutures(raw:unknown,symbols:string[]):OverseasFuturesSnapshot {
 const r=receipt(raw,"overseas-futures"),requested=overseasFutureSymbols(symbols);
 if(!requested.length||requested.length!==symbols.length||requested.some(s=>overseasFutures[s].source==="eastmoney"))throw Error("海外期货代码无效或重复");
 const spark=object(object(JSON.parse(r.body))?.spark);
 if(!spark||spark.error!=null||!Array.isArray(spark.result)||spark.result.length>requested.length)throw Error("海外期货响应格式变化");
 const seen=new Set<string>(),quotes:OverseasFutureQuote[]=[];
 for(const value of spark.result){
  const row=object(value),symbol=row?.symbol;
  if(typeof symbol!=="string"||!requested.includes(symbol)||seen.has(symbol))throw Error("海外期货响应代码冲突");
  seen.add(symbol);
  const m=Array.isArray(row?.response)&&row.response.length===1?object(object(row.response[0])?.meta):null,identity=overseasFutures[symbol];
  const q:OverseasFutureQuote={symbol,price:null,sourceTime:null,sourceName:null,sourceTimeZone:null,sourceChangePct:null};
  if(row?.error!=null||!m)q.warning="暂不可用";
  else if(m.symbol!==symbol)q.warning="来源代码未确认";
  else if(m.exchangeName!==identity.exchange||m.currency!==identity.currency)q.warning="来源交易所或币种未确认";
  else if(m.instrumentType!==(identity.instrumentType??"FUTURE")&&!(m.instrumentType==="ALTSYMBOL"&&yahooAliasIdentity[symbol]))q.warning="来源类型未确认";
  else if(m.instrumentType==="ALTSYMBOL"&&(m.fullExchangeName!==yahooAliasIdentity[symbol].exchange||!yahooAliasIdentity[symbol].name.test(text(m.shortName)??"")))q.warning="来源品种名称或完整交易所未确认";
  else {
   q.sourceType=text(m.instrumentType)??undefined;
   const epoch=finite(m.regularMarketTime),name=text(m.shortName),zone=text(m.exchangeTimezoneName);
   if(epoch===null||!Number.isInteger(epoch)||epoch<946684800||epoch*1000>Date.parse(r.collectedAt)+60000)q.warning="来源时间未确认";
   else if(!name||!zone)q.warning="来源合约或时区未确认";
   else {
    try{new Intl.DateTimeFormat("en",{timeZone:zone}).format(0);}catch{q.warning="来源时区未确认";}
    if(!q.warning){q.sourceTime=new Date(epoch*1000).toISOString();q.sourceName=name;q.sourceTimeZone=zone;q.price=finite(m.regularMarketPrice);q.sourceChangePct=finite(m.regularMarketChangePercent);if(q.price===null)q.warning="无有效报价";}
   }
  }
  quotes.push(q);
 }
 if(!quotes.length)throw Error("海外期货没有可核对的记录");
 return {collectedAt:r.collectedAt,requestedSymbols:requested,quotes,missingSymbols:requested.filter(s=>!seen.has(s))};
}
export function overseasFutureQuote(row:OverseasFutureQuote|undefined,collectedAt:string|undefined):MarketQuote|undefined {
 if(!row||row.price===null||!row.sourceTime||!collectedAt)return undefined;
 // No inferred trading day, daily change, main month or history join for rolling aliases.
 return {at:Date.parse(row.sourceTime),value:row.price,sourceDate:row.sourceTime.slice(0,10),quoteAt:row.sourceTime,collectedAt:row.collectedAt??collectedAt,dayChange:null,dataType:"intraday",source:overseasFutures[row.symbol].source==="eastmoney"?`东方财富 ${overseasFutures[row.symbol].name} · ${row.symbol}`:overseasFutures[row.symbol].instrumentType==="INDEX"?"Yahoo Finance 美元指数快照":"Yahoo Finance 公开期货序列"};
}
export function overseasFutureState(row:OverseasFutureQuote|undefined,snapshot:OverseasFuturesSnapshot|null|undefined,failed=false,now=Date.now()):string {
 if(!row||row.price===null)return row?.warning??"暂不可用";
 if(failed||!snapshot||now-Date.parse(row.collectedAt??snapshot.collectedAt)>600000)return "数据未更新 · 交易日未确认";
 return `${now-Date.parse(row.sourceTime!)>1800000?"来源记录较早":"公开快照"} · 交易日未确认`;
}
export function parseEastmoneyCotton(raw:unknown):OverseasFuturesSnapshot{return parseEastmoneyFuture(raw,"em-cotton");}
export function parseEastmoneyTin(raw:unknown):OverseasFuturesSnapshot{return parseEastmoneyFuture(raw,"em-tin");}
function parseEastmoneyFuture(raw:unknown,key:"em-cotton"|"em-tin"):OverseasFuturesSnapshot {
 const spec=key==="em-cotton"?{symbol:"CT00Y.EM",code:"CT00Y",name:"棉花当月连续",market:108,digits:2}:{symbol:"LTNT.EM",code:"LTNT",name:"综合锡03",market:109,digits:0};
 const r=receipt(raw,key,65536),qt=object(object(JSON.parse(r.body))?.qt);
 if(!qt||qt.dm!==spec.code||qt.name!==spec.name||qt.sc!==spec.market||qt.zsjd!==spec.digits)throw Error("东方财富代码、市场或精度变化");
 const epoch=finite(qt.utime),price=finite(qt.p);
 if(epoch===null||!Number.isInteger(epoch)||epoch<946684800||epoch*1000>Date.parse(r.collectedAt)+60000||price===null||price<=0)throw Error("东方财富价格或来源时间无效");
 // utime is the source Unix timestamp. Do not manufacture a delivery month/trading day.
 return {collectedAt:r.collectedAt,requestedSymbols:[spec.symbol],missingSymbols:[],quotes:[{symbol:spec.symbol,price,sourceTime:new Date(epoch*1000).toISOString(),sourceName:qt.name,sourceTimeZone:null,sourceChangePct:null,collectedAt:r.collectedAt}]};
}
