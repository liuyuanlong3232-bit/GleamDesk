import {overseasFutures,overseasFutureState,type OverseasFutureQuote,type OverseasFuturesSnapshot} from "../domain/agriculture/publicOverseasFutures";
import {formatMarketTime} from "../domain/agriculture/marketQuotes";

export function OverseasQuoteDetails({row}:{row:OverseasFutureQuote}){
 const tin=row.symbol==="LTNT.EM";const index=overseasFutures[row.symbol].instrumentType==="INDEX",eastmoney=overseasFutures[row.symbol].source==="eastmoney";
 return <><small>来源{index?"指数":"合约"}名称：{row.sourceName??"未提供"}</small>{row.sourceType&&<small>来源类型：{row.sourceType}{row.sourceType==="ALTSYMBOL"?"（公开别名；代码、品种、市场及币种已核对）":""}</small>}<small>来源时区：{row.sourceTimeZone??"未提供"}（上方时刻按北京时间显示，时间戳保留 UTC）</small><small>{index?"指数点；不是美元金额":`原币种代码：${overseasFutures[row.symbol].currency}；价格未换算`}</small><small>来源涨跌幅：{row.sourceChangePct===null?"—":`${row.sourceChangePct}%`}（比较基准未确认，不作日涨跌）</small><small>{index?"指数参考值，不是美元指数期货；不接入日收盘历史。":eastmoney?tin?"东方财富原名为综合锡03；交割日和主力关系未确认，不当作指定月份或 LME 官方结算价，不接入日收盘历史。":"东方财富 CT00Y 当月连续，与 Yahoo CT=F 独立；未确认具体月份或主力，不接入日收盘历史。":"序列代码可能换月，不代表已确认主力；不接入日收盘历史。"}</small>{eastmoney&&<a href={`https://quote.eastmoney.com/globalfuture/${tin?"LTNT":"CT00Y"}.html`} target="_blank" rel="noreferrer">东方财富来源页面</a>}</>;
}
export function PublicOverseasFutures({snapshot,symbols,error,loading=false,now=Date.now(),title="海外农产品期货"}:{snapshot?:OverseasFuturesSnapshot|null;symbols:string[];error?:string;loading?:boolean;now?:number;title?:string}){
 const rows=new Map((snapshot?.quotes??[]).map(row=>[row.symbol,row]));
 return <section className="wb-card wb-watch-table" aria-label={`${title}快照`}><header><h2>{title}</h2><span>公开快照 · 逐行注明来源</span></header>
  {error&&<p role="status" className="wb-footnote">{error}</p>}
  <div className="wb-stock-head"><span>品种 / 代码</span><span>价格 / 单位</span><span>报价类型</span><span>来源时刻 / 状态</span></div><div className="wb-stock-rows">{symbols.map(symbol=>{const row=rows.get(symbol),identity=overseasFutures[symbol];return <div className="wb-stock-row" key={symbol} data-market-symbol={symbol}>
   <div><strong>{identity.name}</strong><small>{symbol} · {identity.source==="eastmoney"?"东方财富":"Yahoo Finance"}</small></div><div><b>{row?.price??"—"}</b><small>{identity.unit}</small></div><span>公开序列</span><div className="wb-quote-meta"><small>{row?.sourceTime?`来源时刻：${formatMarketTime(row.sourceTime)}`:"来源时间未确认"}</small><small className="wb-quote-stale">{loading?"正在读取…":overseasFutureState(row,snapshot,Boolean(error),now)}</small>{row&&row.price!==null&&<details className="wb-quote-details"><summary>详情</summary><small>采集时间：{formatMarketTime(row.collectedAt??snapshot?.collectedAt??null)}</small><OverseasQuoteDetails row={row}/></details>}</div>
  </div>;})}</div>
  <p className="wb-footnote">可能延迟；交易日未确认。各品种单位不同。</p>
 </section>;
}
