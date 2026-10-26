import {receipt} from "../news/publicFeeds";
import type {MarketQuote} from "./marketQuotes";
import {domesticSnapshotLabel,domesticTradingDayLabel} from "./tradingCalendar";
export interface AStockQuote {symbol:string;name:string;price:number|null;previousClose:number|null;changePct:number|null;quoteAt:string|null;currency?:"CNY"|"HKD"|"USD";warning?:string}
export interface AStocksSnapshot {collectedAt:string;requestedSymbols:string[];quotes:AStockQuote[];missingSymbols:string[]}
export function aStockSymbol(value:string):string|null {
 const input=value.trim().toUpperCase();
 if(/^\d{5}\.HK$/.test(input)&&!input.startsWith("00000"))return input;
 if(/^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,3})?\.US$/.test(input))return input;
 const match=/^(\d{6})\.(SH|SZ|BJ)$/i.exec(value.trim());if(!match)return null;
 const [,code,exchange]=match,market=exchange.toUpperCase();
 if(market==="SH"&&!/^(60[0135]|68[89])\d{3}$/.test(code)||market==="SZ"&&!/^(00[0-3]|30[01])\d{3}$/.test(code)||market==="BJ"&&!/^(?:[48]\d{5}|920\d{3})$/.test(code))return null;
 return `${code}.${market}`;
}
export function aStockSymbols(values:string[]):string[]{return [...new Set(values.map(aStockSymbol).filter((s):s is string=>s!==null))].sort().slice(0,60);}
const number=(text:string|undefined):number|null=>text!==undefined&&/^-?\d+(?:\.\d+)?$/.test(text)&&Number.isFinite(Number(text))?Number(text):null;
function stockTime(value:string|undefined,collectedAt:string,market="a"):string|null {
 if(market!=="a"){
  if(!value)return null;
  const normalized=value.replace(/\//g,"-"),m=/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(normalized);
  if(!m)return null;
  if(market==="hk")return stockTime(m.slice(1).join(""),collectedAt);
  for(const offset of [4,5]){
   const iso=normalized.replace(" ","T")+`-0${offset}:00`,at=Date.parse(iso);
   if(!Number.isFinite(at)||at>Date.parse(collectedAt)+60000)continue;
   const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(at);
   const get=(type:string)=>parts.find(p=>p.type===type)?.value;
   if(`${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`===normalized)return iso;
  }
  return null;
 }
 if(!value||!/^\d{14}$/.test(value))return null;
 const iso=`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(8,10)}:${value.slice(10,12)}:${value.slice(12)}+08:00`,at=Date.parse(iso);
 if(!Number.isFinite(at)||at>Date.parse(collectedAt)+60000||new Date(at+8*3600000).toISOString().slice(0,19)!==iso.slice(0,19))return null;return iso;
}
export function parseAStocks(raw:unknown,symbols:string[]):AStocksSnapshot {
 const r=receipt(raw,"a-shares",65536),requested=aStockSymbols(symbols);
 if(!requested.length||requested.length!==symbols.length)throw Error("A股请求代码无效或重复");
 const allowed=new Set(requested),seen=new Set<string>(),quotes:AStockQuote[]=[];
 for(const line of r.body.trim().split(/\r?\n/)){
  const match=/^v_(sh|sz|bj|hk|us)([A-Za-z0-9.-]+)="([^"\r\n]*)";$/.exec(line.trim());if(!match)throw Error("股票来源格式变化");
  const symbol=`${match[2]}.${match[1].toUpperCase()}`;if(!allowed.has(symbol)||seen.has(symbol))throw Error("股票响应代码冲突");seen.add(symbol);
  if(!match[3])continue;const f=match[3].split("~"),market=match[1],currency=market==="hk"?"HKD":market==="us"?"USD":"CNY";
  if(market==="hk"?(f.length<78||f[0]!=="100"||f[2]!==match[2]||f[63]!=="GP"||f[75]!=="HKD"):market==="us"?(f.length<36||f[0]!=="200"||!(f[2]===match[2]||["OQ","N","A","P","NQ"].some(s=>f[2]===`${match[2]}.${s}`))||f[35]!=="USD"):(f.length<83||f[2]!==match[2]||f[61]!=="GP-A"||f[82]!=="CNY"))throw Error("股票市场、代码或币种字段不一致");
  const name=f[1];if(!name||name.length>80||/[\u0000-\u001f\ufffd]/.test(name))throw Error("A股名称编码无效");
  const current=number(f[3]),previous=number(f[4]),change=number(f[31]),pct=number(f[32]),quoteAt=stockTime(f[30],r.collectedAt,market==="hk"?"hk":market==="us"?"us":"a");
  const price=current!==null&&current>0&&quoteAt?current:null,previousClose=previous!==null&&previous>0?previous:null;
  let changePct=pct,warning:string|undefined;
  if(price===null){changePct=null;warning=quoteAt?"无有效成交报价":"来源时间未确认";}
  else if(previousClose===null||change===null||pct===null||Math.abs(price-previousClose-change)>0.015||Math.abs((price/previousClose-1)*100-pct)>0.025){changePct=null;warning="涨跌幅字段待核对";}
  quotes.push({symbol,name,price,previousClose,changePct,quoteAt,currency,warning});
 }
 if(!quotes.length)throw Error("A股没有可核对的记录");
 return {collectedAt:r.collectedAt,requestedSymbols:requested,quotes,missingSymbols:requested.filter(s=>!quotes.some(q=>q.symbol===s))};
}
export function aStockQuote(row:AStockQuote|undefined,collectedAt:string|undefined):MarketQuote|undefined {
 if(!row||row.price===null||!row.quoteAt||!collectedAt)return undefined;
 return {at:Date.parse(row.quoteAt),value:row.price,sourceDate:row.quoteAt.slice(0,10),quoteAt:row.quoteAt,collectedAt,dayChange:row.changePct,dataType:"intraday",source:`腾讯公开行情快照 · ${row.currency??"CNY"}/股`};
}
export function aStockState(row:AStockQuote|undefined,snapshot:AStocksSnapshot|null|undefined,failed=false,now=Date.now()):string {
 if(!row||row.price===null)return row?.warning??"暂不可用";
 if(failed||!snapshot||now-Date.parse(snapshot.collectedAt)>150000)return "数据未更新";
 if(row.warning)return row.warning;
 if(/\.(HK|US)$/.test(row.symbol))return "公开快照 · 交易日未确认";
 return `${domesticSnapshotLabel(row.symbol,row.quoteAt,now)} · ${domesticTradingDayLabel(row.symbol,row.quoteAt,now)}`;
}
