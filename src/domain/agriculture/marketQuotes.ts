import type {AgricultureEnvelope,AgriculturePrice,MainContract} from "./contracts";

export interface MarketQuote {
  at:number;value:number;sourceDate:string;quoteAt:string|null;collectedAt:string|null;
  dayChange:number|null;dataType:"intraday"|"daily";source:string;
}
const radarSymbols=new Set(["000426.SZ","000960.SZ","AG.SHF","SN.SHF"]);
const validNumber=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value);
const time=(value:unknown):string|null=>typeof value==="string"&&Number.isFinite(Date.parse(value))?value:null;
const timestamp=(value:unknown):string|null=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)?time(value):null;

export function tradingDate(value:unknown):string|null {
  if(typeof value!=="string")return null;
  const normalized=/^\d{8}$/.test(value)?`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6)}`:value;
  if(!/^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(normalized)||!time(normalized))return null;
  const day=normalized.slice(0,10),at=Date.parse(day);
  return Number.isFinite(at)&&new Date(at).toISOString().slice(0,10)===day?day:null;
}

function collectionRange(value:unknown):{start:number;end:number}|null {
  if(typeof value!=="string"||!tradingDate(value))return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(value)){
    const start=Date.parse(`${value}T00:00:00+08:00`);
    return {start,end:start+86400000-1};
  }
  // Offsetless collector timestamps are legacy VPS Beijing times, not local PC times.
  const normalized=/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)?value.replace(" ","T")+"+08:00":value;
  if(!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(normalized))return null;
  const start=Date.parse(normalized);
  return Number.isFinite(start)?{start,end:start}:null;
}

export function newerCollection(candidate:unknown,current:unknown):boolean {
  const next=collectionRange(candidate),previous=collectionRange(current);
  // A date-only collection is a whole-day range. Overlap cannot prove which is newer.
  return Boolean(next&&(!previous||next.start>previous.end));
}

export function marketQuotes(envelope:AgricultureEnvelope|null|undefined):Map<string,MarketQuote[]> {
  const bySymbol=new Map<string,Map<number,MarketQuote>>();
  const add=(symbol:unknown,sourceDate:unknown,price:unknown,change:unknown,collected:unknown,source:string)=>{
    const day=tradingDate(sourceDate);
    if(typeof symbol!=="string"||radarSymbols.has(symbol)||symbol==="LME-SN"||!day||!validNumber(price)||price<=0)return;
    const at=Date.parse(day),values=bySymbol.get(symbol)??new Map<number,MarketQuote>(),previous=values.get(at);
    if(previous&&!newerCollection(collected,previous.collectedAt))return;
    values.set(at,{at,value:price,sourceDate:day,quoteAt:null,collectedAt:collectionRange(collected)?collected as string:null,dayChange:validNumber(change)?change:null,dataType:"daily",source});
    bySymbol.set(symbol,values);
  };
  for(const item of envelope?.market??[])for(const row of item.history)add(row.symbol,row.sourceDate,row.price,row.changePct,row.collectedDate,"VPS / Yahoo Finance");
  for(const sample of envelope?.history??[])for(const row of sample.prices)add(row.symbol,row.quote_date,row.price,row.change_pct,sample.generatedAt,"VPS / 全球行情快照");
  const current=envelope?.snapshots.global_snapshot?.payload.prices;
  if(Array.isArray(current))for(const row of current)add(row.symbol,row.quote_date,row.price,row.change_pct,envelope?.snapshots.global_snapshot.payload.generated_at_bjt,"VPS / 全球行情快照");
  if(envelope?.radar?.status==="available"){
    const seen=new Set<string>();
    for(const row of envelope.radar.quotes){
      if(!radarSymbols.has(row.symbol))continue;
      if(seen.has(row.symbol)){bySymbol.delete(row.symbol);continue;}
      seen.add(row.symbol);
      const collected=timestamp(row.collectedAt),quoteAt=timestamp(row.quoteAt);
      if(!validNumber(row.price)||row.price<=0||!collected)continue;
      const at=Date.parse(quoteAt??collected);
      bySymbol.set(row.symbol,new Map([[at,{at,value:row.price,sourceDate:quoteAt??"",quoteAt,collectedAt:collected,dayChange:validNumber(row.changePct)?row.changePct:null,dataType:"intraday",source:row.source}]]));
    }
  }
  return new Map([...bySymbol].map(([symbol,values])=>[symbol,[...values.values()].sort((a,b)=>a.at-b.at)]));
}

export function formatMarketTime(value:string|null):string {
  const range=collectionRange(value);
  if(!range)return "未提供";
  // Date-only observations stay date-only. Never invent midnight as a quote time.
  if(/^\d{4}-\d{2}-\d{2}$/.test(value!))return value!;
  // Legacy collectedDate without an offset was written by the VPS in Beijing time.
  return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(new Date(range.start));
}

export function marketQuoteState(quote:MarketQuote|undefined,now=Date.now()):string {
  if(!quote)return "暂不可用";
  const value=quote.dataType==="intraday"?quote.collectedAt:quote.sourceDate;
  const age=value?now-Date.parse(value):NaN;
  if(!Number.isFinite(age)||age< -300000)return "暂不可用";
  return age>(quote.dataType==="intraday"?15*60000:3*86400000)?"数据未更新":"";
}

export function splitContractPrices(prices:AgriculturePrice[],envelope:AgricultureEnvelope|null|undefined,now=Date.now()) {
  // Recently confirmed relationships are dated evidence, never a claim about today's main.
  const today=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai"}).format(now);
  const recent=(day:string|null)=>day!==null&&day<=today&&Date.parse(today)-Date.parse(day)<=3*86400000;
  const mappings=new Map<string,{day:string;rows:MainContract[]}>();
  for(const row of envelope?.radar?.mainContracts??[]){
    const continuous=row.continuousSymbol.match(/^([A-Z]+)\.(SHF|DCE|ZCE)$/);
    const day=tradingDate(row.mappingDate);
    if(!day||!recent(day)||!continuous||!new RegExp(`^${continuous[1]}\\d{4}\\.${continuous[2]}$`).test(row.contractSymbol))continue;
    if(row.confirmed!==undefined&&typeof row.confirmed!=="boolean")continue;
    if(row.collectedAt!==undefined){
      const collected=timestamp(row.collectedAt);
      if(!collected||Date.parse(collected)>now+300000||formatMarketTime(collected).slice(0,10)<day)continue;
    }
    const previous=mappings.get(row.continuousSymbol);
    if(!previous||day>previous.day)mappings.set(row.continuousSymbol,{day,rows:[row]});
    else if(day===previous.day)previous.rows.push(row);
  }
  const confirmed=new Map<string,MainContract>();
  for(const group of mappings.values()){
    const candidates=group.rows.filter(row=>row.confirmed!==false),contracts=new Set(candidates.map(row=>row.contractSymbol));
    if(contracts.size!==1)continue;
    const selected=candidates[0];
    if(group.rows.some(row=>row.contractSymbol===selected.contractSymbol&&row.confirmed===false))continue;
    const latest=candidates.reduce((previous,row)=>newerCollection(row.collectedAt,previous.collectedAt)?row:previous);
    confirmed.set(latest.contractSymbol,{...latest,mappingDate:group.day});
  }
  const current=prices.flatMap(row=>{
    const mapping=confirmed.get(row.symbol),day=tradingDate(row.date);
    return mapping&&day&&recent(day)&&row.status!=="Stale"&&day<=mapping.mappingDate?[{...row,mappingDate:mapping.mappingDate,mappingSource:mapping.source??"VPS / 雷达映射",mappingCollectedAt:mapping.collectedAt??null}]:[];
  });
  const displayed=new Set(current.map(row=>row.symbol));
  return {current,history:prices.filter(row=>!displayed.has(row.symbol))};
}
