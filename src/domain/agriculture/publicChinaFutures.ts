import {receipt} from "../news/publicFeeds";
import type {MarketQuote} from "./marketQuotes";
import {domesticSnapshotLabel,domesticTradingDayLabel} from "./tradingCalendar";

// These are product identities, not current main-contract mappings or an expiry calendar.
export const chinaFutureProducts:Record<string,{exchange:string;marker:string;sourceName:string;unit:string;unitSource:string}>={
 AG:{exchange:"SHF",marker:"沪",sourceName:"白银",unit:"元/千克",unitSource:"https://www.shfe.cn/regulation/exchangerules/productrules/202512/t20251231_829961.html"},SN:{exchange:"SHF",marker:"沪",sourceName:"锡",unit:"元/吨",unitSource:"https://www.shfe.com.cn/products/futures/metal/nonferrousmetal/sn_f/standard_sn_f/202312/t20231205_331278.html"},
 A:{exchange:"DCE",marker:"连",sourceName:"豆一",unit:"元/吨",unitSource:"https://www.dce.com.cn/dalianshangpin/resource/cms/2019/05/2019051410181769090.pdf"},C:{exchange:"DCE",marker:"连",sourceName:"玉米",unit:"元/吨",unitSource:"https://www.dce.com.cn/dalianshangpin/resource/cms/2019/05/2019051410181769090.pdf"},
 CS:{exchange:"DCE",marker:"连",sourceName:"淀粉",unit:"元/吨",unitSource:"https://www.dce.com.cn/dalianshangpin/resource/cms/2019/05/2019051410181769090.pdf"},M:{exchange:"DCE",marker:"连",sourceName:"豆粕",unit:"元/吨",unitSource:"https://www.dce.com.cn/dalianshangpin/resource/cms/2019/05/2019051410181769090.pdf"},
 Y:{exchange:"DCE",marker:"连",sourceName:"豆油",unit:"元/吨",unitSource:"https://www.dce.com.cn/dalianshangpin/resource/cms/2019/05/2019051410181769090.pdf"},P:{exchange:"DCE",marker:"连",sourceName:"棕榈油",unit:"元/吨",unitSource:"https://www.dce.com.cn/dalianshangpin/resource/cms/2019/05/2019051410181769090.pdf"},
 JD:{exchange:"DCE",marker:"连",sourceName:"鸡蛋",unit:"元/500千克",unitSource:"https://www.dce.com.cn/dalianshangpin/resource/cms/2019/05/2019051410181769090.pdf"},LH:{exchange:"DCE",marker:"连",sourceName:"生猪",unit:"元/吨",unitSource:"https://www.dce.com.cn/dalianshangpin/fgfz/6142914/6142926/6262877/大连商品交易所生猪期货业务细则（根据2025年6月24日〔2025〕59号文件修改）.pdf"},
 WH:{exchange:"ZCE",marker:"郑",sourceName:"强麦",unit:"元/吨",unitSource:"https://english.czce.com.cn/en/Rulebook/DetailedRules/webinfo/2024/02/1708568086158763.htm"},SR:{exchange:"ZCE",marker:"郑",sourceName:"白糖",unit:"元/吨",unitSource:"https://www.czce.com.cn/cn/uploadfile/2024/06/26/20240626165544343.pdf"},
 CF:{exchange:"ZCE",marker:"郑",sourceName:"棉花",unit:"元/吨",unitSource:"https://www.czce.com.cn/cn/flfg/zcjywgz/pzxz/webinfo/2024/02/1708568084281851.htm"},OI:{exchange:"ZCE",marker:"郑",sourceName:"菜油",unit:"元/吨",unitSource:"https://www.czce.com.cn/cn/uploadfile/2024/02/07/20240207144928864.pdf"},
};
export interface ChinaFutureQuote {symbol:string;name:string;price:number|null;previousSettlement:number|null;sourceTime:string|null;warning?:string}
export interface ChinaFuturesSnapshot {collectedAt:string;requestedSymbols:string[];quotes:ChinaFutureQuote[];missingSymbols:string[]}
export function chinaFutureSymbol(value:string):string|null {
 const m=/^([A-Z]{1,2})(\d{2})(0[1-9]|1[0-2])\.(SHF|DCE|ZCE)$/i.exec(value.trim());
 if(!m||chinaFutureProducts[m[1].toUpperCase()]?.exchange!==m[4].toUpperCase())return null;
 return value.trim().toUpperCase();
}
export function chinaFutureSymbols(values:string[]):string[]{return [...new Set(values.map(chinaFutureSymbol).filter((s):s is string=>s!==null))].sort().slice(0,60);}
const numeric=(value:string|undefined):number|null=>value!==undefined&&/^\d+(?:\.\d+)?$/.test(value)&&Number.isFinite(Number(value))&&Number(value)>0?Number(value):null;
function sourceClock(day:string,time:string,collectedAt:string):string|null {
 if(!/^20\d{2}-\d{2}-\d{2}$/.test(day)||!/^\d{6}$/.test(time))return null;
 const iso=`${day}T${time.slice(0,2)}:${time.slice(2,4)}:${time.slice(4)}+08:00`,at=Date.parse(iso);
 if(!Number.isFinite(at)||at>Date.parse(collectedAt)+60000||new Date(at+8*3600000).toISOString().slice(0,19)!==iso.slice(0,19))return null;
 return iso;
}
export function parseChinaFutures(raw:unknown,symbols:string[]):ChinaFuturesSnapshot {
 const r=receipt(raw,"cn-futures",65536),requested=chinaFutureSymbols(symbols);
 if(!requested.length||requested.length!==symbols.length)throw Error("国内期货须指定明确月份合约");
 const codes=new Map(requested.map(symbol=>[symbol.split(".")[0],symbol])),seen=new Set<string>(),quotes:ChinaFutureQuote[]=[];
 for(const line of r.body.trim().split(/\r?\n/)){
  const m=/^var hq_str_nf_([A-Z]{1,2}\d{4})="([^"\r\n]*)";$/.exec(line.trim());
  if(!m||!codes.has(m[1])||seen.has(m[1]))throw Error("国内期货响应代码冲突或格式变化");seen.add(m[1]);
  if(!m[2])continue;
  const symbol=codes.get(m[1])!,product=chinaFutureProducts[m[1].replace(/\d+$/,"")],f=m[2].split(",");
  if(f.length<28||f[0]!==product.sourceName+m[1].slice(-4)||f[15]!==product.marker||f[16]!==product.sourceName)throw Error("国内期货品种或交易所不一致");
  const sourceTime=sourceClock(f[17],f[1],r.collectedAt),price=sourceTime?numeric(f[8]):null;
  quotes.push({symbol,name:f[0],price,previousSettlement:numeric(f[10]),sourceTime,warning:!sourceTime?"来源时间未确认":price===null?"无有效成交报价":undefined});
 }
 if(!quotes.length)throw Error("国内期货没有可核对的记录");
 return {collectedAt:r.collectedAt,requestedSymbols:requested,quotes,missingSymbols:requested.filter(s=>!quotes.some(q=>q.symbol===s))};
}
export function chinaFutureQuote(row:ChinaFutureQuote|undefined,collectedAt:string|undefined):MarketQuote|undefined {
 if(!row||row.price===null||!row.sourceTime||!collectedAt)return undefined;
 // Source clock only: this is NOT a confirmed exchange trading day. Never join to daily history.
 return {at:Date.parse(row.sourceTime),value:row.price,sourceDate:row.sourceTime.slice(0,10),quoteAt:row.sourceTime,collectedAt,dayChange:null,dataType:"intraday",source:`新浪公开指定月份合约快照 · ${chinaFutureProducts[row.symbol.replace(/\d{4}\..+$/,"")].unit}`};
}
export function chinaFutureState(row:ChinaFutureQuote|undefined,snapshot:ChinaFuturesSnapshot|null|undefined,failed=false,now=Date.now()):string {
 if(!row||row.price===null)return row?.warning??"暂不可用";
 const dateLabel=domesticTradingDayLabel(row.symbol,row.sourceTime,now);
 if(failed||!snapshot||now-Date.parse(snapshot.collectedAt)>150000)return `数据未更新 · ${dateLabel}`;
 return `${domesticSnapshotLabel(row.symbol,row.sourceTime,now)} · ${dateLabel}`;
}
