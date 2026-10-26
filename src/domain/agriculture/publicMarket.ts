import {receipt,xmlDocument,publicTimestamp} from "../news/publicFeeds";
export const metalReferenceUnit="金衡盎司（按市场惯例）";
export const metalUnitBasis="单位按贵金属市场惯例解释；Gold API 接口未单独声明计量单位，不代表已取得服务商明确确认。";
export const metalUnitBasisUrl="https://www.lbma.org.uk/publications/the-otc-guide/the-price";
export interface BuiltinQuote {symbol:string;name:string;price:number|null;currency:string;unit:string;quoteAt:string|null;source:string;collectedAt:string|null;error?:string}
export interface PublicMarketSnapshot {quotes:BuiltinQuote[];fx:{date:string;collectedAt:string;rates:{currency:string;value:number}[]}|null;errors:string[]}
export function parseMetal(raw:unknown,key:"gold"|"silver"):BuiltinQuote {
 const value=receipt(raw,key),row=JSON.parse(value.body) as Record<string,unknown>,symbol=key==="gold"?"XAU":"XAG";
 if(row.symbol!==symbol||row.currency!=="USD")throw Error("金属报价的品种或币种不匹配");
 if(row.unit!=null)throw Error("金银来源提供了单位字段，需重新核对计量口径");
 const price=typeof row.price==="number"&&Number.isFinite(row.price)&&row.price>0?row.price:null;
 const time=publicTimestamp(row.updatedAt);
 const quoteAt=time&&Date.parse(time)<=Date.parse(value.collectedAt)+60000?time:null;
 if(price===null||!quoteAt)throw Error("金属报价缺少有效价格或来源时间");
 return {symbol,name:key==="gold"?"黄金参考价":"白银参考价",price,currency:"USD",unit:metalReferenceUnit,quoteAt,source:"Gold API",collectedAt:value.collectedAt};
}
export function parseEcbRates(raw:unknown,parse?: (body:string)=>Document):NonNullable<PublicMarketSnapshot["fx"]>{
 const value=receipt(raw,"fx-ecb"),doc=xmlDocument(value.body,parse);
 if(doc.documentElement.localName!=="Envelope"||doc.documentElement.namespaceURI!=="http://www.gesmes.org/xml/2002-08-01")throw Error("汇率来源格式不匹配");
 const namespace="http://www.ecb.int/vocabulary/2002-08-01/eurofxref";
 const days=Array.from(doc.getElementsByTagNameNS(namespace,"Cube")).filter(node=>node.hasAttribute("time"));
 if(days.length!==1)throw Error("汇率日期不明确");
 const day=days[0],date=day.getAttribute("time")??"";
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date>value.collectedAt.slice(0,10))throw Error("汇率日期无效");
 const seen=new Set<string>();const rates=Array.from(day.children).flatMap(node=>{
  const currency=node.getAttribute("currency")??"",text=node.getAttribute("rate")??"";
  if(node.namespaceURI!==namespace||!['USD','CNY','JPY','GBP','HKD'].includes(currency)||seen.has(currency)||!/^\d+(?:\.\d+)?$/.test(text))return [];
  const rate=Number(text);if(!Number.isFinite(rate)||rate<=0)return [];seen.add(currency);return [{currency,value:rate}];
 });
 if(!rates.length)throw Error("汇率数值暂不可用");
 return {date,collectedAt:value.collectedAt,rates};
}
export function metalState(quote:BuiltinQuote,now=Date.now()):string {
 if(quote.error||quote.price===null)return "暂不可用";
 if(!quote.quoteAt||!quote.collectedAt)return "新鲜度未确认";
 const age=now-Date.parse(quote.quoteAt),readAge=now-Date.parse(quote.collectedAt);
 if(age< -60000||readAge< -60000)return "时间未确认";
 return age>30*60000||readAge>10*60000?"数据未更新":"参考快照";
}
