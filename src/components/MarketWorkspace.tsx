import {overseasFutureSymbol,overseasFutureQuote,overseasFutureState,overseasFutures} from "../domain/agriculture/publicOverseasFutures";
import {PublicOverseasFutures,OverseasQuoteDetails} from "./PublicOverseasFutures";
import type {ReactNode} from "react";
import {chinaFutureSymbol,chinaFutureQuote,chinaFutureState,chinaFutureProducts} from "../domain/agriculture/publicChinaFutures";
import {aStockSymbol,aStockQuote,aStockState} from "../domain/agriculture/publicAStocks";
import {domesticCalendar,inferDomesticTradingDay} from "../domain/agriculture/tradingCalendar";
import {CustomMarketQuotes} from "./CustomMarketQuotes";
import {PublicMonthlyPrices} from "./PublicAgricultureReference";
import {BuiltinMarketQuotes} from "./BuiltinMarketQuotes";
import {useMemo,useState} from "react";
import {useProviderDashboardData} from "../providers/useProviderDashboardData";
import {agriculturePresentation,observationState} from "../domain/agriculture/contracts";
import {marketQuotes,formatMarketTime,marketQuoteState,splitContractPrices,type MarketQuote} from "../domain/agriculture/marketQuotes";
import {OverviewChart,Sparkline,type ComparisonSeries} from "./ResearchPanels";
interface Asset{id:string;name:string;symbol:string}
type AssetMarket="A"|"US"|"HK"|"futures";
export function marketAssetSymbol(market:AssetMarket,input:string):string|null{
 const value=input.trim().toUpperCase();
 if(market==="A"){const full=/^\d{6}$/.test(value)?`${value}.${value.startsWith("6")?"SH":value.startsWith("0")||value.startsWith("3")?"SZ":"BJ"}`:value;const symbol=aStockSymbol(full);return symbol&&/\.(SH|SZ|BJ)$/.test(symbol)?symbol:null;}
 if(market==="HK"){const symbol=aStockSymbol(/^\d{1,5}$/.test(value)?value.padStart(5,"0")+".HK":value);return symbol?.endsWith(".HK")?symbol:null;}
 if(market==="US"){const symbol=aStockSymbol(value.endsWith(".US")?value:value+".US");return symbol?.endsWith(".US")?symbol:null;}
 return chinaFutureSymbol(value)||overseasFutureSymbol(value);
}
const assetKey="codex-desktop.market-assets.v1";
const freeReferenceSymbols=["LTNT.EM","CT00Y.EM","DX-Y.NYB"];
const cropSymbols=["ZC=F","ZS=F","ZW=F","ZL=F","ZM=F","CT=F","SB=F","CL=F"];
const defaults:Asset[]=[];
const exchangePairs:Array<[string,string]>=[["人民币","CNY"],["欧元","EUR"],["日元","JPY"],["港币","HKD"],["英镑","GBP"]];
function exchangeRateRows(payload:unknown):Array<{name:string;code:string;value:number}>{
  if(!payload||typeof payload!=="object")return [];
  const rates=(payload as {rates?:unknown}).rates;
  if(!rates||typeof rates!=="object"||Array.isArray(rates))return [];
  return exchangePairs.flatMap(([name,code])=>{const value=(rates as Record<string,unknown>)[code];return typeof value==="number"&&Number.isFinite(value)&&value>0?[{name,code,value}]:[];});
}
function formatExchangeRateTime(value:unknown):string{
  if(typeof value!=="number"||!Number.isFinite(value)||value<=0)return "更新时间未知";
  return new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(value*1000);
}
export function loadMarketAssets():Asset[]{try{const value=JSON.parse(localStorage.getItem(assetKey)??"null");if(!Array.isArray(value))return defaults;const seen=new Set<string>();return value.slice(0,60).flatMap(item=>{if(!item||typeof item.id!=="string"||seen.has(item.id)||typeof item.name!=="string"||typeof item.symbol!=="string")return [];seen.add(item.id);return [{id:item.id.slice(0,80),name:item.name.slice(0,60),symbol:(item.symbol||"").slice(0,50)}];});}catch{return defaults;}}
export function MarketWorkspace({visible}:{visible:boolean}){
  const [assets,setAssets]=useState(loadMarketAssets),[editing,setEditing]=useState(false),[name,setName]=useState(""),[symbol,setSymbol]=useState(""),[message,setMessage]=useState(""),[days,setDays]=useState(30),[focus,setFocus]=useState("自选");
  const [assetMarket,setAssetMarket]=useState<AssetMarket>("A");
  const data=useProviderDashboardData(visible?["public-a-shares","public-cn-futures","public-overseas-futures","agriculture-status","custom-market-quotes","public-market","public-monthly"]:[],{url:"",systemId:"",refreshIntervalSeconds:300},true,undefined,[...new Set([...assets.map(a=>a.symbol),...freeReferenceSymbols])].sort());const envelope=data.agriculture;
  const stockIssue=data.providerDiagnostics.find(item=>item.providerId==="public-a-shares");
  const stockSourceActive=Boolean(stockIssue&&stockIssue.status!=="unavailable");
  const stockRows=new Map((data.publicAStocks?.quotes??[]).map(row=>[row.symbol,row]));
  const futuresIssue=data.providerDiagnostics.find(item=>item.providerId==="public-cn-futures");
  const futuresSourceActive=Boolean(futuresIssue&&futuresIssue.status!=="unavailable");
  const futuresRows=new Map((data.publicChinaFutures?.quotes??[]).map(row=>[row.symbol,row]));
  const overseasIssue=data.providerDiagnostics.find(item=>item.providerId==="public-overseas-futures");
  const overseasActive=Boolean(overseasIssue&&overseasIssue.status!=="unavailable");
  const overseasRows=new Map((data.publicOverseasFutures?.quotes??[]).map(row=>[row.symbol,row]));
  const monthlyIssue=data.providerDiagnostics.find(item=>item.providerId==="public-monthly");
  const serverIssue=data.providerDiagnostics.find(item=>item.providerId==="agriculture-status");
  const marketIssue=data.providerDiagnostics.find(item=>item.providerId==="public-market");
  const customIssue=data.providerDiagnostics.find(item=>item.providerId==="custom-market-quotes");
  const showServerData=Boolean(envelope);
  const showCustom=Boolean(data.customMarket?.sources.length)||customIssue?.status==="error";

  const quotes=useMemo(()=>marketQuotes(envelope),[envelope]);
  const history=(id:string):MarketQuote[]=>((quotes.get(id)??[]).filter(row=>row.dataType==="daily"&&row.at>=Date.now()-days*86400000));
  const series:Array<ComparisonSeries&{id:string}>=([{id:"GC=F",name:"黄金",color:"#f2b64e",category:"metal"},{id:"SI=F",name:"白银",color:"#55b3ef",category:"metal"},{id:"DX-Y.NYB",name:"美元指数",color:"#3ad4a6",category:"macro"},{id:"CL=F",name:"原油",color:"#aa88ec",category:"energy"}] as Array<Omit<ComparisonSeries,"points">&{id:string}>).map(item=>({...item,points:history(item.id)}));
  const agriculture=useMemo(()=>envelope?agriculturePresentation(envelope):null,[envelope]);
  const cropPrices=(agriculture?.prices??[]).filter(price=>cropSymbols.includes(price.symbol));
  const chinaPrices=(agriculture?.prices??[]).filter(price=>price.source.startsWith("VPS / Tushare"));
  const chinaContracts=splitContractPrices(chinaPrices,envelope);
  const cropSeries=cropPrices.filter(price=>price.symbol!=="CL=F").slice(0,4).map((price,index)=>({name:price.name,category:"agriculture" as const,points:history(price.symbol),color:["#f2b64e","#55b3ef","#3ad4a6","#aa88ec"][index]}));
  const latest=(id:string)=>quotes.get(id)?.at(-1);const news=(envelope?.snapshots.global_snapshot?.payload.news as {title?:string;url?:string;epoch?:number}[]|undefined)??[];
  const exchangeSnapshot=envelope?.snapshots.global_snapshot?.payload.exchange_rates as {status?:string;time_last_update_unix?:number;time_next_update_unix?:number}|undefined;
  const exchangeRows=exchangeRateRows(exchangeSnapshot);
  const exchangeExpired=typeof exchangeSnapshot?.time_next_update_unix==="number"&&exchangeSnapshot.time_next_update_unix*1000<=Date.now();
  const exchangeStatus=exchangeSnapshot?.status==="MISSING_KEY"?"缺少 VPS 密钥":exchangeSnapshot?.status==="STALE"||exchangeExpired?"数据已过期":exchangeSnapshot?.status==="UNAVAILABLE"?"暂不可用":exchangeRows.length?"每日更新":"等待 VPS 快照";
  const exchangeUpdated=formatExchangeRateTime(exchangeSnapshot?.time_last_update_unix);
  const update=(next:Asset[])=>{try{localStorage.setItem(assetKey,JSON.stringify(next));setAssets(next);setMessage("");return true;}catch{setMessage("自选配置保存失败");return false;}};
  return <section className="wb-design-page wb-market" data-no-page-swipe>
    <header className="wb-page-head"><div><h1>市场中心</h1></div><button className="wb-primary" onClick={()=>setEditing(!editing)}>{editing?"完成管理":"管理自选"}</button></header>
    {showServerData&&<section className="wb-ticker" aria-label="主要市场行情">{series.map(item=><article key={item.id}><span>{item.name}</span><strong>{latest(item.id)?.value??"—"}</strong><small>{latest(item.id)?.sourceDate??"Unknown"}</small></article>)}</section>}
    <div className={`wb-market-grid${showServerData?"":" wb-public-only"}`}><main className="wb-main-column">
      {marketIssue?.status!=="unavailable"&&<BuiltinMarketQuotes snapshot={data.publicMarket} loading={!data.providerDiagnostics.some(row=>row.providerId==="public-market")} error={marketIssue?.error}/>}{monthlyIssue?.status!=="unavailable"&&<PublicMonthlyPrices snapshot={data.publicMonthly} error={monthlyIssue?.error} loading={!monthlyIssue}/>}{showCustom&&<CustomMarketQuotes snapshot={data.customMarket} error={data.providerDiagnostics.find(item=>item.providerId==="custom-market-quotes")?.error} visible={visible}/>}
      {overseasIssue?.status!=="unavailable"&&freeReferenceSymbols.some(s=>!assets.some(a=>a.symbol===s))&&<PublicOverseasFutures title="海外参考行情" snapshot={data.publicOverseasFutures} symbols={freeReferenceSymbols.filter(s=>!assets.some(a=>a.symbol===s))} error={overseasIssue?.error} loading={!overseasIssue}/>}
      {serverIssue?.status==="error"&&!showServerData&&<p className="wb-footnote" role="status">自有数据源读取失败，暂不可用</p>}
      {!showServerData&&marketIssue?.status==="unavailable"&&monthlyIssue?.status==="unavailable"&&!showCustom&&!stockSourceActive&&!futuresSourceActive&&!overseasActive&&<p className="wb-empty">尚未启用行情来源，可在设置 → 数据来源开启</p>}
      {showServerData&&<section className="wb-feature wb-market-focus"><span className="wb-eyebrow">今日重点 / 来源观测</span><h2>{latest("GC=F")?`黄金最新记录 ${latest("GC=F")!.value}`:"等待可核对的市场记录"}</h2>{latest("GC=F")&&<p>日收盘 · {latest("GC=F")!.sourceDate} · {observationState(latest("GC=F")!.sourceDate)}</p>}<div className="wb-source-badges"><span>Yahoo 期货日记录</span><span>现有 VPS</span></div></section>}
      {stockIssue?.error&&<p className="wb-footnote" role="status">{stockIssue.error}</p>}
      {overseasIssue?.error&&<p className="wb-footnote" role="status">{overseasIssue.error}</p>}
      {futuresIssue?.error&&<p className="wb-footnote" role="status">{futuresIssue.error}</p>}
      {(assets.length>0||showServerData||editing||stockSourceActive||futuresSourceActive||overseasActive)&&<section className="wb-card wb-watch-table"><header><h2>自选股 / 品种</h2><span>{assets.length} 个自选</span></header><div className="wb-stock-head"><span>品种</span><span>价格</span><span>日涨跌</span><span>行情时间 / 类型</span></div><div className="wb-stock-rows">{assets.map(asset=>{
        const stock=aStockSymbol(asset.symbol),future=chinaFutureSymbol(asset.symbol),useFuture=futuresSourceActive&&Boolean(future),overseas=overseasFutureSymbol(asset.symbol),useOverseas=overseasActive&&Boolean(overseas);
        const overseasRow=overseas?overseasRows.get(overseas):undefined;
        const futureRow=future?futuresRows.get(future):undefined;
        let quote=latest(asset.symbol),stateLabel:string|undefined;
        if(stockSourceActive&&stock){quote=aStockQuote(stockRows.get(stock),data.publicAStocks?.collectedAt);stateLabel=aStockState(stockRows.get(stock),data.publicAStocks,Boolean(stockIssue?.error));}
        else if(useFuture){quote=chinaFutureQuote(futureRow,data.publicChinaFutures?.collectedAt);stateLabel=chinaFutureState(futureRow,data.publicChinaFutures,Boolean(futuresIssue?.error));}
        else if(useOverseas){quote=overseasFutureQuote(overseasRow,data.publicOverseasFutures?.collectedAt);stateLabel=overseasFutureState(overseasRow,data.publicOverseasFutures,Boolean(overseasIssue?.error));}
        else if(!quote&&chinaFutureProducts[asset.symbol.split(".")[0]])stateLabel="主力关系未确认";
        return <MarketWatchRow key={asset.id} asset={stock&&asset.name===asset.symbol&&stockRows.get(stock)?.name?{...asset,name:stockRows.get(stock)!.name}:asset} quote={quote} stateLabel={stateLabel} sourceTimeOnly={useFuture||useOverseas} priceUnit={stock?`${stockRows.get(stock)?.currency??"来源币种"}/股`:useOverseas&&overseas?overseasFutures[overseas].unit:useFuture&&future?chinaFutureProducts[future.replace(/\d{4}\..+$/,"")].unit:undefined} quoteDetails={useOverseas&&overseasRow?<OverseasQuoteDetails row={overseasRow}/>:useFuture&&future?<a href={chinaFutureProducts[future.replace(/\d{4}\..+$/,"")].unitSource} target="_blank" rel="noreferrer">交易所计价单位依据（原价未换算）</a>:undefined} previousSettlement={useFuture?futureRow?.previousSettlement:undefined} onRemove={editing?()=>{if(window.confirm(`从自选移除“${asset.name}”？`))update(assets.filter(item=>item.id!==asset.id));}:undefined}/>;
      })}</div>{editing&&<form className="wb-add-form" onSubmit={event=>{event.preventDefault();const normalized=marketAssetSymbol(assetMarket,symbol);if(!normalized){setMessage("请核对市场与代码；期货需使用支持的月份合约或海外代码");return;}if(assets.some(asset=>asset.symbol===normalized)){setMessage("该代码已在自选中");return;}if(assets.length>=60){setMessage("最多保存 60 个自选");return;}if(update([...assets,{id:crypto.randomUUID(),name:name.trim().slice(0,60)||normalized,symbol:normalized}])){setName("");setSymbol("");}}}><select value={assetMarket} onChange={event=>setAssetMarket(event.target.value as AssetMarket)} aria-label="自选市场"><option value="A">A股</option><option value="US">美股</option><option value="HK">港股</option><option value="futures">期货</option></select><input value={symbol} onChange={event=>setSymbol(event.target.value)} aria-label="自选代码" placeholder={assetMarket==="A"?"如 600519、000001.SZ":assetMarket==="US"?"如 AAPL、MSFT":assetMarket==="HK"?"如 00700、09988.HK":"如 AG2612.SHF、C2701.DCE、GC=F"} required/><input value={name} onChange={event=>setName(event.target.value)} aria-label="自选名称" placeholder="名称（可选）"/><button className="wb-primary">添加</button></form>}<p className="wb-footnote">股票公开快照可能延迟；未开启来源时请到设置 → 数据来源启用。国内期货填写月份合约；海外序列可能换月，不推测主力。</p></section>}
      {showServerData&&<section className="wb-card wb-watch-table wb-crop-market"><header><h2>农产品日行情</h2><span>{cropPrices.length} 个来源品种 · VPS 快照</span></header><div className="wb-stock-head"><span>品种</span><span>每日记录</span><span>日涨跌</span><span>来源日期 / 状态</span></div><div className="wb-stock-rows">{cropPrices.map(price=><div className="wb-stock-row" key={price.symbol}><div><strong>{price.name}</strong><small>{price.symbol}</small></div><b>{price.price??"—"}</b><span className={price.change!==null&&price.change<0?"wb-down":"wb-up"}>{price.change===null?"—":`${price.change>0?"+":""}${price.change.toFixed(2)}%`}</span><div><small>{price.date??"来源日期未知"} · {price.status}</small></div></div>)}</div>{!cropPrices.length&&<p className="wb-empty">等待 VPS 全球农产品快照</p>}<p className="wb-footnote">包括玉米、大豆、小麦、豆油、豆粕、棉花、原糖与原油；沿用来源提供的涨跌幅和日期。</p></section>}
      {chinaPrices.length>0&&<section className="wb-card wb-watch-table"><header><h2>国内期货快照</h2><span>最近确认主力</span></header>
        {chinaContracts.current.length?chinaContracts.current.map(price=><div className="wb-stock-row" key={price.symbol}><div><strong>{price.name}</strong><small>{price.symbol}</small></div><b>{price.price??"—"}</b><span className={price.change!==null&&price.change<0?"wb-down":"wb-up"}>{price.change===null?"—":`${price.change.toFixed(2)}%`}</span><div><small>日收盘 · {price.date??"日期未提供"}</small><small>主力确认日期：{price.mappingDate}</small><details className="wb-quote-details"><summary>详情</summary><small>采集时间：{formatMarketTime(price.collectedAt??null)}</small><small>确认来源：{price.mappingSource}</small><small>确认采集时间：{formatMarketTime(price.mappingCollectedAt)}</small></details>{price.status==="Stale"&&<small className="wb-quote-stale">数据未更新</small>}</div></div>):<p className="wb-empty">主力关系尚未确认或已过期，已有记录可在历史合约中查看。</p>}
        <details className="wb-contract-history"><summary>历史合约 · {chinaContracts.history.length} 条记录</summary><div className="wb-stock-head"><span>品种 / 合约</span><span>收盘记录</span><span>日涨跌</span><span>行情日期 / 类型</span></div><div className="wb-stock-rows">{chinaContracts.history.map((price,index)=>{
          const collected=price.collectedAt??null;
          return <div className="wb-stock-row" key={`${price.symbol}-${index}`}><div><strong>{price.name||"品种未知"}</strong><small>{price.symbol||"VPS 国内快照"}</small></div><b>{price.price??"—"}</b><span className={price.change!==null&&price.change<0?"wb-down":"wb-up"}>{price.change===null?"—":`${price.change>0?"+":""}${price.change.toFixed(2)}%`}</span><div><small>日收盘 · {price.date??"行情日期未提供"}</small>{price.status==="Stale"&&<small className="wb-quote-stale">数据未更新</small>}<details className="wb-quote-details"><summary>详情</summary><small>采集时间：{formatMarketTime(collected)}</small><small>来源：{price.source}</small></details></div></div>;
        })}</div></details></section>}

    </main>{showServerData&&<aside className="wb-sidebar"><section className="wb-card"><header><h2>市场总览</h2><span>日快照</span></header><div className="wb-index-list">{series.map(item=><div key={item.id}><span>{item.name}</span><strong>{latest(item.id)?.value??"—"}</strong><Sparkline points={item.points}/></div>)}</div></section><section className="wb-card wb-fx-card"><header><h2>汇率</h2><span>USD 基准 · {exchangeStatus}</span></header>{exchangeRows.length?<div className="wb-fx-rows">{exchangeRows.map(row=><div key={row.code}><span>{row.name} <small>/{row.code}</small></span><strong>{row.value.toLocaleString("zh-CN",{maximumSignificantDigits:7})}</strong></div>)}</div>:<p className="wb-empty">{exchangeSnapshot?.status==="MISSING_KEY"?"请在 VPS config/data_sources.env 配置 EXCHANGE_RATE_API_KEY":exchangeSnapshot?.status==="UNAVAILABLE"?"VPS 汇率源暂不可用":"暂无 VPS 汇率快照"}</p>}<small className="wb-fx-updated">来源：ExchangeRate-API · {exchangeUpdated}</small></section><section className="wb-card"><header><h2>今日大事</h2></header><div className="wb-timeline">{news.length?news.slice(0,5).map((item,index)=><button key={item.url??index} disabled={!item.url} onClick={()=>window.dispatchEvent(new CustomEvent("codex-desktop.open-workspace-url",{detail:{url:item.url,name:item.title?.slice(0,50)||"来源"}}))}><span className="wb-timeline-dot"/><div><strong>{item.title??"标题未知"}</strong><small>{typeof item.epoch==="number"&&Number.isFinite(item.epoch)&&item.epoch>0&&item.epoch<1e11?new Date(item.epoch*1000).toLocaleString("zh-CN"):"来源时间未知"}</small></div></button>):<p className="wb-empty">尚无可靠快讯或事件日历</p>}</div></section><section className="wb-card"><h2>来源状态</h2><p>VPS 已有 {envelope?.radar?.quotes.length??0} 条自选盘中记录、{cropPrices.length} 种全球农产品日行情。LME 锡暂不可用。</p></section><button className="wb-outline" onClick={()=>setEditing(!editing)}>管理自选</button></aside>}</div>
    {showServerData&&<details className="wb-card wb-chart-details"><summary>历史区间对比</summary><div className="wb-chips">{["自选","金属","宏观","农产品"].map(item=><button key={item} aria-pressed={focus===item} onClick={()=>setFocus(item)}>{item}</button>)}</div><OverviewChart visible={visible} series={focus==="金属"?series.slice(0,2):focus==="宏观"?series.slice(2):focus==="农产品"?cropSeries:series} days={days} onDays={setDays}/></details>}{message&&<p role="status">{message}</p>}
  </section>;
}

function DomesticTradingDayDetails({symbol,sourceTime,now}:{symbol:string;sourceTime:string|null;now:number}){
  const assessment=inferDomesticTradingDay(symbol,sourceTime,now),source=assessment.exchange?domesticCalendar.exchanges[assessment.exchange]:null;
  return <><small>{assessment.date?`推定交易日：${assessment.date}`:`交易日未确认：${assessment.reason}`}</small><small>{assessment.date?assessment.reason:"不以采集日期补交易日；原价格与来源时刻保留。"}</small>{source&&<><small>日历：{source.name} · {domesticCalendar.coverageFrom} 至 {domesticCalendar.coverageTo}；核对 {domesticCalendar.checkedAt.slice(0,10)}</small><a href={source.calendarSource.url} target="_blank" rel="noreferrer">日历来源：{source.calendarSource.name}</a></>}<small>推定结果不等于交易所确认，不写入日收盘历史；日历每年年底前更新。</small></>;
}
export function MarketWatchRow({asset,quote,onRemove,stateLabel,sourceTimeOnly=false,previousSettlement,priceUnit,quoteDetails,now=Date.now()}:{asset:Asset;quote?:MarketQuote;onRemove?:()=>void;stateLabel?:string;sourceTimeOnly?:boolean;previousSettlement?:number|null;priceUnit?:string;quoteDetails?:ReactNode;now?:number}){
  const domesticPublic=quote?.dataType==="intraday"&&(quote.source.startsWith("新浪公开指定月份合约快照")||quote.source.startsWith("腾讯公开行情快照"));
  const status=stateLabel??marketQuoteState(quote,now),unavailable=status==="暂不可用";
  const type=quote?.dataType==="intraday"?(sourceTimeOnly?"来源快照":"盘中快照"):"日收盘";
  return <div className="wb-stock-row" data-market-symbol={asset.symbol}>
    <div><strong>{asset.name}</strong><small>{asset.symbol||"代码未配置"}</small></div>
    <div><b>{!unavailable&&quote?quote.value:"—"}</b>{priceUnit&&<small>{priceUnit}</small>}</div>
    <span className={!unavailable&&quote?.dayChange!==null&&quote?.dayChange!==undefined&&quote.dayChange<0?"wb-down":"wb-up"}>{unavailable||quote?.dayChange===null||quote?.dayChange===undefined?"—":`${quote.dayChange>0?"+":""}${quote.dayChange.toFixed(2)}%`}</span>
    <div className="wb-quote-meta">{quote&&<div className="wb-quote-line"><small>{type}</small><small>{quote.dataType==="intraday"?`${sourceTimeOnly?"来源时刻":"行情时间"}：${formatMarketTime(quote.quoteAt)}`:`行情日期：${formatMarketTime(quote.sourceDate)} · 时间未提供`}</small></div>}
      <div className="wb-quote-actions">{status&&<small className={unavailable?"wb-quote-unavailable":"wb-quote-stale"}>{status}</small>}
      {quote&&<details className="wb-quote-details"><summary>详情</summary><small>采集时间：{formatMarketTime(quote.collectedAt)}{quote.collectedAt&&/^\d{4}-\d{2}-\d{2}$/.test(quote.collectedAt)?" · 时间未提供":""}</small><small>来源：{quote.source}</small>{quoteDetails}{sourceTimeOnly&&previousSettlement!==undefined&&<><small>来源昨结算：{previousSettlement??"—"}；不等同昨收盘</small><small>指定月份报价，不代表已确认主力。</small></>}{domesticPublic&&<DomesticTradingDayDetails symbol={asset.symbol} sourceTime={quote.quoteAt} now={now}/>}</details>}</div>
      {onRemove&&<button onClick={onRemove}>移除</button>}
    </div>
  </div>;
}
