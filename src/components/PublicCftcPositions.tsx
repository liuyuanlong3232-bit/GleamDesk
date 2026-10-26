import {cftcRowState,cftcNextRelease,cftcReleaseCalendar,type PublicCftcSnapshot} from "../domain/agriculture/publicCftc";
import {formatMarketTime} from "../domain/agriculture/marketQuotes";
export function PublicCftcPositions({snapshot,error,loading=false,now=Date.now()}:{snapshot?:PublicCftcSnapshot|null;error?:string;loading?:boolean;now?:number}){
 const number=(value:number|null)=>value===null?"—":value.toLocaleString("zh-CN");
 const next=cftcNextRelease(now);
 return <section className="wb-card wb-agri-wide" aria-label="CFTC 官方农业持仓"><header><h2>CFTC 管理基金持仓</h2><small>官方直连 · 仅期货 · 张</small></header>
 {error&&<p role="status" className="wb-footnote">{error}</p>}
 {!snapshot?<p className="wb-empty">{error?"暂不可用":loading?"正在读取 CFTC 官方周报…":"官方直连已关闭或暂不可用"}</p>:<>
 <p className="wb-footnote">{next?`下次计划发布：${formatMarketTime(next.at)}（北京时间）`:"后续发布日历未覆盖，待更新"}</p>
 <div className="wb-agri-table-wrap"><table className="wb-cftc-table wb-public-cftc-table"><thead><tr><th scope="col">品种</th><th scope="col">未平仓量</th><th scope="col">多头</th><th scope="col">空头</th><th scope="col">净持仓</th><th scope="col">多头周变</th><th scope="col">空头周变</th><th scope="col">持仓日 / 状态</th></tr></thead><tbody>{snapshot.items.map(item=><tr key={item.code}><td>{item.name}<details className="wb-quote-details"><summary>详情</summary><small>市场代码 {item.code}</small><small>{item.market}</small><small>合约规格：{item.contractUnits??"来源未提供"}</small></details></td><td>{number(item.open_interest_all)}</td><td>{number(item.managed_money_long)}</td><td>{number(item.managed_money_short)}</td><td>{number(item.managed_money_net)}</td><td>{number(item.managed_money_change_long)}</td><td>{number(item.managed_money_change_short)}</td><td><div className="wb-table-date-state"><time>{item.reportDate??"日期未知"}</time><small>{cftcRowState(item,snapshot,Boolean(error),now)}</small></div></td></tr>)}</tbody></table></div>
 <details className="wb-quote-details"><summary>来源与日期</summary><small>来源：{snapshot.source} · 本机读取 {formatMarketTime(snapshot.collectedAt)}</small><small>持仓日是报告统计截至日，不是发布日期；计划可能调整，不代表报告已经发布或当前数据为最新一期。净持仓为多头减空头；周变采用来源字段，不拼接跨周差值。两种小麦分别展示。</small><small>计划覆盖 {cftcReleaseCalendar.coverageFrom} 至 {cftcReleaseCalendar.coverageTo}；美东15:30，按日期换算夏令时。本机核对 {formatMarketTime(cftcReleaseCalendar.retrievedAt)}。</small><a href={cftcReleaseCalendar.sourceUrl} target="_blank" rel="noreferrer">CFTC 官方发布计划</a>{" · "}<a href="https://publicreporting.cftc.gov/stories/s/r4w3-av2u" target="_blank" rel="noreferrer">CFTC 官方报告</a></details>
 </>}
 </section>;
}
