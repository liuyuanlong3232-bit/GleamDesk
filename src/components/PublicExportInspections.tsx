import {inspectionsState,inspectionsUrl,type PublicInspectionsSnapshot} from "../domain/agriculture/publicInspections";
import {formatMarketTime} from "../domain/agriculture/marketQuotes";

export function PublicExportInspections({snapshot,error,loading=false}:{snapshot?:PublicInspectionsSnapshot|null;error?:string;loading?:boolean}){
 const number=(value:number|null)=>value===null?"—":value.toLocaleString("zh-CN");
 return <section className="wb-card wb-agri-wide" aria-label="USDA 全美出口检验"><header><h2>USDA 全美出口检验</h2><small>{snapshot?`统计截至 ${snapshot.weekEnding} · 吨`:"官方周报 · 吨"}</small></header>
 {error&&<p className="wb-footnote" role="status">{error}</p>}
 {!snapshot?<p className="wb-empty">{error?"暂不可用":loading?"正在读取 USDA 官方出口检验周报…":"官方直连已关闭或暂不可用"}</p>:<>
 <p className="wb-footnote">发布 {snapshot.publishedDate} · {inspectionsState(snapshot,Boolean(error))}</p>
 <div className="wb-agri-table-wrap"><table className="wb-cftc-table wb-inspections-table"><thead><tr><th scope="col">品种</th>{[["本周",snapshot.weekEnding],["上周",snapshot.previousWeekEnding],["去年同期",snapshot.yearAgoWeekEnding]].map(([label,day])=><th key={label} scope="col">{label}<time dateTime={day}>{day}</time></th>)}</tr></thead><tbody>{snapshot.items.map(row=><tr key={row.commodity}><td>{row.name}{row.warning&&<small className="wb-inspections-warning">{row.warning}</small>}</td><td>{number(row.current)}</td><td>{number(row.previous)}</td><td>{number(row.yearAgo)}</td></tr>)}</tbody></table></div>
 <details className="wb-quote-details"><summary>来源与日期</summary><small>USDA AMS / FGIS · WA_GR101 · 公吨（metric tons） · 本机读取 {formatMarketTime(snapshot.collectedAt)}</small><small>全美已检验或称重的出口谷物；全部谷物合计直接采用来源 Total，包含表中三品种以外的谷物，不是海湾港口合计，也不是出口销售或 WASDE 预测。统计截至日、发布日期和读取时间分别保留。</small><a href={inspectionsUrl} target="_blank" rel="noreferrer">USDA 官方周报</a></details>
 </>}
 </section>;
}
