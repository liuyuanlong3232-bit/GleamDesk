import {wasdeState,wasdePage,type PublicWasdeSnapshot} from "../domain/agriculture/publicWasde";
import {formatMarketTime} from "../domain/agriculture/marketQuotes";
export function PublicWasdeSupply({snapshot,error,loading=false}:{snapshot?:PublicWasdeSnapshot|null;error?:string;loading?:boolean}){
 const number=(n:number|null)=>n===null?"—":n.toLocaleString("zh-CN",{maximumFractionDigits:2});
 return <section className="wb-card wb-agri-wide" aria-label="USDA WASDE 官方供需"><header><h2>USDA WASDE 供需</h2><small>{snapshot?`${snapshot.reportMonth} 月报 · 百万吨`:"官方月报"}</small></header>
 {error&&<p className="wb-footnote" role="status">{error}</p>}
 {!snapshot?<p className="wb-empty">{error?"暂不可用":loading?"正在读取 USDA 官方月报…":"官方直连已关闭或暂不可用"}</p>:<><div className="wb-agri-table-wrap"><table className="wb-cftc-table wb-public-wasde-table"><thead><tr>{["品种 / 地区","市场年度 / 口径","产量","国内使用量","出口","期末库存"].map(t=><th scope="col" key={t}>{t}</th>)}</tr></thead><tbody>{snapshot.items.map(row=><tr key={row.commodity+row.region}><td>{row.commodity} · {row.region}</td><td><div className="wb-table-date-state"><span>{row.marketingYear} · {row.kind}</span><small>{wasdeState(snapshot,Boolean(error))}{row.warning?` · ${row.warning}`:""}</small></div></td><td>{number(row.production)}</td><td>{number(row.use)}</td><td>{number(row.exports)}</td><td>{number(row.stocks)}</td></tr>)}</tbody></table></div>
 <details className="wb-quote-details"><summary>来源与日期</summary><small>USDA WASDE · 报告月份 {snapshot.reportMonth} · 本机读取 {formatMarketTime(snapshot.collectedAt)}</small><small>按来源的市场年度汇总，预测和估计值并非实际最终产量。全球国内使用量沿用来源调整口径；不是交易价格、出口检验或 NASS 年度统计。不推算具体发布日期。</small><a href={wasdePage} target="_blank" rel="noreferrer">USDA 官方报告</a> · <a href={snapshot.sourceUrl} target="_blank" rel="noreferrer">本期 XML</a></details></>}
 </section>;
}
