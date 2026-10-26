import {tradingDate,newerCollection} from "./marketQuotes";
export type TimeFormat="iso"|"yyyymmdd"|"unixSeconds"|"unixMilliseconds";
export interface CustomQuoteFields{symbol:string;price:string;name:string;changePct:string;quoteAt:string;collectedAt:string;unit:string;currency:string}
export interface CustomHttpSource{
 id:string;name:string;enabled:boolean;url:string;autoRefresh:boolean;refreshMinutes:number;rowsPath:string;rowMode:"list"|"single";
 dataType:"intraday"|"daily";timeFormat:TimeFormat;collectionFormat:TimeFormat;changeScale:"percent"|"ratio";staleMinutes:number;fields:CustomQuoteFields;
}
export interface CustomQuote{symbol:string;name:string;price:number|null;changePct:number|null;quoteAt:string|null;collectedAt:string|null;unit:string|null;currency:string|null;warning:string}
export interface CustomQuoteResult{id:string;name:string;dataType:"daily"|"intraday";staleMinutes:number;receivedAt:string|null;status:"normal"|"partial"|"unread"|"stale"|"error";error:string;quotes:CustomQuote[]}
export interface CustomQuotesSnapshot{sources:CustomQuoteResult[]}
export const newCustomHttpSource=(id:string):CustomHttpSource=>({id,name:"",enabled:false,url:"",autoRefresh:false,refreshMinutes:15,rowsPath:"",rowMode:"list",dataType:"daily",timeFormat:"iso",collectionFormat:"iso",changeScale:"percent",staleMinutes:15,fields:{symbol:"",price:"",name:"",changePct:"",quoteAt:"",collectedAt:"",unit:"",currency:""}});
const forbidden=new Set(["__proto__","prototype","constructor"]);
export function pathValid(path:string):boolean{return path.length<=160&&(path===""||path.split(".").every(part=>part.length>0&&!forbidden.has(part)&&!/[\s\[\]{}()]/.test(part)));}
export function fieldAt(raw:unknown,path:string):unknown{
 if(!pathValid(path))throw Error("字段位置格式无效，只支持点分隔的字段名和数组下标");
 if(!path)return raw;let value=raw;
 for(const part of path.split(".")){if(!value||typeof value!=="object"||!Object.prototype.hasOwnProperty.call(value,part))return undefined;value=(value as Record<string,unknown>)[part];}
 return value;
}
const text=(value:unknown,max=80):string=>typeof value==="string"?value.trim().slice(0,max):typeof value==="number"&&Number.isFinite(value)?String(value):"";
export function quoteNumber(value:unknown):number|null{
 if(typeof value==="number")return Number.isFinite(value)?value:null;
 if(typeof value!=="string"||!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))return null;
 const number=Number(value);return Number.isFinite(number)?number:null;
}
export function mappedTime(value:unknown,format:TimeFormat):string|null{
 if(format==="unixSeconds"||format==="unixMilliseconds"){const n=quoteNumber(value);if(n===null||n<0)return null;const d=new Date(n*(format==="unixSeconds"?1000:1));return Number.isFinite(d.getTime())?d.toISOString():null;}
 if(typeof value!=="string")return null;const s=value.trim();
 if(format==="yyyymmdd")return /^\d{8}$/.test(s)?tradingDate(s):null;
 if(/^\d{4}-\d{2}-\d{2}$/.test(s))return tradingDate(s);
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(s)||!tradingDate(s))return null;
 return Number.isFinite(Date.parse(s))?s:null;
}
export function mapCustomQuotes(raw:unknown,source:CustomHttpSource):{quotes:CustomQuote[];ignored:number}{
 if(!source.fields.symbol||!source.fields.price)throw Error("请填写代码和价格的字段位置");
 for(const path of [source.rowsPath,...Object.values(source.fields)])if(!pathValid(path))throw Error("字段位置格式无效");
 const selected=fieldAt(raw,source.rowsPath);
 const rows=source.rowMode==="single"?(selected&&typeof selected==="object"&&!Array.isArray(selected)?[selected]:null):Array.isArray(selected)?selected:null;
 if(!rows)throw Error(source.rowMode==="single"?"数据位置没有对应的对象":"数据列表位置没有对应的数组");
 if(rows.length>500)throw Error("接口超过 500 条，请在接口参数中缩小范围");
 if(!rows.length)throw Error("接口返回 0 条行情，暂不可用");
 let ignored=0;const bySymbol=new Map<string,CustomQuote>();
 const get=(row:unknown,path:string)=>path?fieldAt(row,path):undefined;
 for(const row of rows){
  const symbol=text(get(row,source.fields.symbol));if(!symbol){ignored++;continue;}
  const price=quoteNumber(get(row,source.fields.price)),change=quoteNumber(get(row,source.fields.changePct));
  const quoteAt=mappedTime(get(row,source.fields.quoteAt),source.timeFormat),collectedAt=mappedTime(get(row,source.fields.collectedAt),source.collectionFormat);
  const warning=[price===null?"缺少有效价格":"",!quoteAt?"行情时间未知":"",source.fields.collectedAt&&!collectedAt?"来源采集时间未知":""].filter(Boolean).join("；");
  const percent=change===null?null:change*(source.changeScale==="ratio"?100:1);
  const quote:CustomQuote={symbol,name:text(get(row,source.fields.name))||symbol,price,changePct:percent!==null&&Number.isFinite(percent)?percent:null,quoteAt,collectedAt,unit:text(get(row,source.fields.unit),40)||null,currency:text(get(row,source.fields.currency),20)||null,warning};
  const previous=bySymbol.get(symbol);
  if(!previous){bySymbol.set(symbol,quote);continue;}
  const at=quoteAt?Date.parse(quoteAt):NaN,oldAt=previous.quoteAt?Date.parse(previous.quoteAt):NaN;
  if(Number.isFinite(at)&&(!Number.isFinite(oldAt)||at>oldAt)){bySymbol.set(symbol,quote);continue;}
  if(at===oldAt&&collectedAt&&(!previous.collectedAt||newerCollection(collectedAt,previous.collectedAt))){bySymbol.set(symbol,quote);continue;}
  if(!Number.isFinite(at)||at===oldAt&&(!collectedAt||!previous.collectedAt))previous.warning=[previous.warning,"重复记录，新旧无法确认"].filter(Boolean).join("；");
 }
 if(!bySymbol.size)throw Error("没有识别到品种代码，请检查字段对应");
 return {quotes:[...bySymbol.values()],ignored};
}
export function customQuoteState(quote:CustomQuote,result:Pick<CustomQuoteResult,"status"|"dataType"|"staleMinutes">,now=Date.now()):string{
 if(result.status==="stale")return "数据未更新（本次读取失败或缓存过期）";
 if(!quote.quoteAt)return "行情时间未知 · 新鲜度未确认";
 const age=now-Date.parse(quote.quoteAt);if(age< -300000)return "行情时间异常";
 if(result.dataType==="daily"||/^\d{4}-\d{2}-\d{2}$/.test(quote.quoteAt))return "新鲜度未确认";
 return age>result.staleMinutes*60000?"数据未更新":"";
}
