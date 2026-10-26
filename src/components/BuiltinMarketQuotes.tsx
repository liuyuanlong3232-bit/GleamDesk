import {metalState,metalReferenceUnit,metalUnitBasis,metalUnitBasisUrl,type PublicMarketSnapshot} from "../domain/agriculture/publicMarket";
import {formatMarketTime} from "../domain/agriculture/marketQuotes";
export function BuiltinMarketQuotes({snapshot,error,loading=false}:{snapshot?:PublicMarketSnapshot|null;error?:string;loading?:boolean}){
 return <section className="wb-card wb-watch-table" aria-label="内置免费行情"><header><h2>免费参考行情</h2><small>金银报价 · 官方汇率</small></header>
 {!snapshot&&<p className="wb-empty">{error||(loading?"读取免费来源中…":"内置来源已关闭或暂不可用")}</p>}
 {snapshot&&<>
 {error&&<p className="wb-footnote" role="status">{error}</p>}
 <div className="wb-stock-head"><span>品种 / 来源</span><span>参考价格</span><span>日涨跌</span><span>来源时间 / 状态</span></div>
 <div className="wb-stock-rows">{snapshot.quotes.map(quote=><div className="wb-stock-row" key={quote.symbol}>
  <div><strong>{quote.name}</strong><small>{quote.symbol} · {quote.source}</small></div><div><b>{quote.price?.toLocaleString("zh-CN",{maximumFractionDigits:6})??"—"}</b><small>{quote.currency==="USD"&&quote.unit===metalReferenceUnit?`美元／${quote.unit}`:`${quote.currency} · ${quote.unit}`}</small></div><span>—</span>
  <div className="wb-quote-meta"><small>{quote.quoteAt?formatMarketTime(quote.quoteAt):"来源时间未知"}</small><small>{error&&quote.price!==null?"数据未更新":metalState(quote)}</small><details className="wb-quote-details"><summary>详情</summary><small>本机读取：{formatMarketTime(quote.collectedAt)}</small><small>聚合参考报价，不对应 COMEX 或国内期货合约；来源未返回日涨跌幅。</small><small>{metalUnitBasis}</small>{quote.error&&<small>{quote.error}</small>}<a href={metalUnitBasisUrl} target="_blank" rel="noreferrer">LBMA 报价口径</a>{" · "}<a href="https://gold-api.com/docs" target="_blank" rel="noreferrer">Gold API 来源说明</a></details></div>
 </div>)}</div>
 {snapshot.fx&&<section className="wb-custom-source"><header><h3>欧洲央行参考汇率</h3><small>来源日期 {snapshot.fx.date} · EUR 基准 · {error?"数据未更新":"新鲜度未确认"}</small></header><div className="wb-fx-rows">{snapshot.fx.rates.map(rate=><div key={rate.currency}><span>1 EUR / {rate.currency}</span><strong>{rate.value.toLocaleString("zh-CN",{maximumSignificantDigits:8})}</strong></div>)}</div><details className="wb-quote-details"><summary>详情</summary><small>本机读取：{formatMarketTime(snapshot.fx.collectedAt)}</small><small>每日参考汇率，不是实时成交价；尚未接入该来源的发布日历。</small><a href="https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html" target="_blank" rel="noreferrer">欧洲央行来源说明</a></details></section>}
 {snapshot.errors.map(message=><p className="wb-footnote" key={message}>{message}</p>)}
 </>}
 </section>;
}
