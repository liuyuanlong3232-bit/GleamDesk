import {noaaState,noaaDocumentation,type PublicNoaaSnapshot} from "../domain/agriculture/publicNoaa";
import {formatMarketTime} from "../domain/agriculture/marketQuotes";

export function PublicNoaaObservations({snapshot,error,loading=false}:{snapshot?:PublicNoaaSnapshot|null;error?:string;loading?:boolean}){
 const value=(n:number|null)=>n===null?"—":n.toLocaleString("zh-CN",{maximumFractionDigits:1});
 return <section className="wb-card wb-agri-wide" aria-label="NOAA 美国站点实测"><header><h2>NOAA 美国站点实测</h2><small>{snapshot?`${snapshot.windowStart} 至 ${snapshot.windowEnd}`:"近 30 个完整日"}</small></header>
 {error&&<p className="wb-footnote" role="status">{error}</p>}
 {!snapshot?<p className="wb-empty">{error?"暂不可用":loading?"正在读取 NOAA 官方站点记录…":"官方直连已关闭或暂不可用"}</p>:<>
 <div className="wb-agri-estimates">{snapshot.stations.map(station=><article key={station.stationId}><strong>{station.region} · {noaaState(snapshot,station,Boolean(error))}</strong><b>{value(station.precipTotal)} <small>mm · 有效记录累计</small></b><span>降水记录 {station.precipDays}/30 天{station.traceDays?` · 含微量降水标记 ${station.traceDays} 天`:""}</span><span>最高温均值 {value(station.tmaxMean)}°C · {station.tmaxDays}/30 天</span><span>最低温均值 {value(station.tminMean)}°C · {station.tminDays}/30 天</span><small>最新有效观测 {station.latestDate??"未知"}<br/>{station.name} · {station.stationId}</small></article>)}</div>
 <details className="wb-quote-details"><summary>来源与日期</summary><small>NOAA NCEI · GHCN Daily · 本机读取 {formatMarketTime(snapshot.collectedAt)}</small><small>请求区间按 UTC 选择前 30 个完整日，观测日期沿用来源站点日记录。降水只累计有效日；温度只平均有效日，缺测不补零、也不补足 30 天。剔除质量检查未通过、推定为零及缺少质量信息的值；微量降水保留来源数值和标记，不等于无降水。</small><small>两个固定站点仅作附近位置参考，不代表整个产区；这是真实历史观测，与 Open-Meteo 未来预报分开。数据发布可能延迟，读取成功不代表记录齐全。</small><a href={noaaDocumentation} target="_blank" rel="noreferrer">NOAA 官方数据服务说明</a> · <a href="https://www.ncei.noaa.gov/pub/data/ghcn/daily/ghcnd-stations.txt" target="_blank" rel="noreferrer">官方站点目录</a></details>
 </>}
 </section>;
}
