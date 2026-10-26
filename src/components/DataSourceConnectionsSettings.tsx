import {useEffect,useState} from "react";
import {invoke,isTauri} from "@tauri-apps/api/core";
import {CustomHttpSourceEditor} from "./CustomHttpSourceEditor";
import {emptySnapshotConnection,type SnapshotConnection} from "../domain/agriculture/contracts";

export function DataSourceConnectionsSettings(){
  const [draft,setDraft]=useState<SnapshotConnection>({...emptySnapshotConnection});
  const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  useEffect(()=>{
    let active=true;
    if(!isTauri()){setMessage("桌面版可配置数据连接");return;}
    void invoke<SnapshotConnection>("load_snapshot_connection").then(value=>{if(active){setDraft(value);setLoaded(true);}}).catch(()=>{if(active)setMessage("配置读取失败，原文件已保留；暂不能保存");});
    return()=>{active=false;};
  },[]);
  const save=async()=>{
    if(!loaded||busy)return;
    setBusy(true);setMessage("");
    try{
      const config={...draft,sshAlias:draft.sshAlias.trim(),dataRoot:draft.dataRoot.trim(),radarRoot:draft.radarRoot.trim()};
      await invoke("save_snapshot_connection",{config});setDraft(config);setMessage("已保存；连接状态以数据页面为准");
    }catch(error){setMessage(typeof error==="string"?error.slice(0,200):"保存失败，草稿已保留");}
    finally{setBusy(false);}
  };
  return <div className="settings-section">
    <strong>免费直连</strong>
    <label className="settings-toggle"><span>阿根廷农业部全国估产</span><input aria-label="阿根廷官方估产" type="checkbox" disabled={!loaded||busy} checked={draft.argentinaEnabled??false} onChange={e=>setDraft({...draft,argentinaEnabled:e.target.checked})}/></label>
    <label className="settings-toggle"><span>巴西 CONAB 作物年度估产</span><input aria-label="CONAB 官方估产" type="checkbox" disabled={!loaded||busy} checked={draft.conabEnabled??false} onChange={e=>setDraft({...draft,conabEnabled:e.target.checked})}/></label>
    <label className="settings-toggle"><span>海外期货 / 美元指数（Yahoo、东方财富）</span><input aria-label="海外期货公开快照" type="checkbox" disabled={!loaded||busy} checked={draft.overseasFuturesEnabled??false} onChange={e=>setDraft({...draft,overseasFuturesEnabled:e.target.checked})}/></label>
    <label className="settings-toggle"><span>国内期货指定月份（新浪公开快照）</span><input aria-label="国内期货指定月份快照" type="checkbox" disabled={!loaded||busy} checked={draft.chinaFuturesEnabled??false} onChange={e=>setDraft({...draft,chinaFuturesEnabled:e.target.checked})}/></label>
    <label className="settings-toggle"><span>股票自选（A股／港股／美股）</span><input aria-label="股票自选快照" type="checkbox" disabled={!loaded||busy} checked={draft.aSharesEnabled??false} onChange={e=>setDraft({...draft,aSharesEnabled:e.target.checked})}/></label>
    <small>股票按自选代码每分钟读取；公开端点不保证实时或持续可用。旧配置默认关闭。</small>
    <label className="settings-toggle"><span>巴西 IBGE 月度估产</span><input aria-label="巴西 IBGE 月度估产" type="checkbox" disabled={!loaded||busy} checked={draft.ibgeEnabled??true} onChange={e=>setDraft({...draft,ibgeEnabled:e.target.checked})}/></label>
    <label className="settings-toggle"><span>月度商品参考价</span><input aria-label="月度商品参考价" type="checkbox" disabled={!loaded||busy} checked={draft.monthlyEnabled??true} onChange={e=>setDraft({...draft,monthlyEnabled:e.target.checked})}/></label>
    <label className="settings-toggle"><span>月价来源</span><select aria-label="月价来源" disabled={!loaded||busy||!(draft.monthlyEnabled??true)} value={draft.monthlySource??"fred"} onChange={e=>setDraft({...draft,monthlySource:e.target.value as "worldbank"|"fred"})}><option value="worldbank">世界银行</option><option value="fred">IMF / FRED</option></select></label>
    <label className="settings-toggle"><span>NASS 官方作物进度</span><input aria-label="NASS 官方作物进度" type="checkbox" disabled={!loaded||busy} checked={draft.cropProgressEnabled??true} onChange={e=>setDraft({...draft,cropProgressEnabled:e.target.checked})}/></label>
    <label className="settings-toggle"><span>NASS 官方年度产量</span><input aria-label="NASS 官方年度产量" type="checkbox" disabled={!loaded||busy} checked={draft.nassAnnualEnabled??true} onChange={e=>setDraft({...draft,nassAnnualEnabled:e.target.checked})}/></label>
    <label className="settings-toggle"><span>NOAA 美国站点实测</span><input aria-label="NOAA 官方站点实测" type="checkbox" disabled={!loaded||busy} checked={draft.noaaEnabled??true} onChange={e=>setDraft({...draft,noaaEnabled:e.target.checked})}/></label>
    <label className="settings-toggle"><span>USDA 出口检验（官方周报）</span><input aria-label="USDA 官方出口检验" type="checkbox" disabled={!loaded||busy} checked={draft.inspectionsEnabled??true} onChange={e=>setDraft({...draft,inspectionsEnabled:e.target.checked})}/></label>
    <label className="settings-toggle"><span>USDA WASDE 供需（官方月报）</span><input aria-label="USDA WASDE 官方供需" type="checkbox" disabled={!loaded||busy} checked={draft.wasdeEnabled??true} onChange={e=>setDraft({...draft,wasdeEnabled:e.target.checked})}/></label>
    <label className="settings-toggle"><span>CFTC 农业持仓（官方周报）</span><input aria-label="CFTC 官方农业持仓" type="checkbox" disabled={!loaded||busy} checked={draft.cftcEnabled??true} onChange={e=>setDraft({...draft,cftcEnabled:e.target.checked})}/></label>
    <label className="settings-toggle"><span>新闻 RSS（中新网 / 美联储 / 欧洲央行）</span><input aria-label="免费新闻 RSS" type="checkbox" disabled={!loaded||busy} checked={draft.newsEnabled??true} onChange={e=>setDraft({...draft,newsEnabled:e.target.checked})}/></label>
    <label className="settings-toggle"><span>内置行情（金银参考价 / 官方汇率）</span><input aria-label="内置免费行情" type="checkbox" disabled={!loaded||busy} checked={draft.marketEnabled??true} onChange={e=>setDraft({...draft,marketEnabled:e.target.checked})}/></label>
    <small>新闻每 15 分钟、金银每 5 分钟、汇率每小时读取；CFTC 每小时、WASDE、出口检验、NOAA、作物进度每 6 小时读取，年报、月价和 IBGE 每天读取；仅在对应页面显示时刷新，无需密钥或服务器。</small>
    <label className="settings-toggle"><span>Open-Meteo 产区天气</span><input aria-label="Open-Meteo 产区天气" type="checkbox" disabled={!loaded||busy} checked={draft.weatherEnabled??false} onChange={e=>setDraft({...draft,weatherEnabled:e.target.checked})}/></label>
    <label className="settings-toggle"><span>GitHub 每日榜单</span><input aria-label="GitHub 每日榜单" type="checkbox" disabled={!loaded||busy} checked={draft.githubEnabled??false} onChange={e=>setDraft({...draft,githubEnabled:e.target.checked})}/></label>
    <strong>可选 SSH 数据源</strong>
    <label className="settings-toggle"><span>启用 SSH 快照</span><input aria-label="启用 SSH 快照" type="checkbox" disabled={!loaded||busy} checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/></label>
    <div className="beszel-settings">
    <label>SSH 配置别名<input aria-label="SSH 配置别名" disabled={!loaded||busy} value={draft.sshAlias} placeholder="my-data" onChange={e=>setDraft({...draft,sshAlias:e.target.value})}/></label>
    <label>数据根目录<input aria-label="数据根目录" disabled={!loaded||busy} value={draft.dataRoot} placeholder="/srv/market-data" onChange={e=>setDraft({...draft,dataRoot:e.target.value})}/></label>
    <label>雷达目录（可选）<input aria-label="雷达目录" disabled={!loaded||busy} value={draft.radarRoot} placeholder="/srv/market-radar" onChange={e=>setDraft({...draft,radarRoot:e.target.value})}/></label>
    </div>
    <CustomHttpSourceEditor sources={draft.customSources??[]} onChange={customSources=>setDraft({...draft,customSources})} disabled={!loaded||busy}/>
    <div className="settings-actions"><button disabled={!loaded||busy} onClick={()=>void save()}>{busy?"保存中…":"保存数据源"}</button></div>
    {message&&<small role="status">{message}</small>}
    <details className="settings-help"><summary>接入帮助</summary><p>新安装默认开启新闻、内置行情、CFTC、WASDE、出口检验、NOAA、NASS 年报/进度、月价、IBGE 与天气，可关闭；已有配置保持原开关，SSH 默认关闭。使用你自己的 SSH 配置与已信任主机，读取约定快照。不会安装软件或修改定时任务，SSH 密码与私钥由系统 SSH 管理。</p><p>仅支持约定的 JSON / SQLite 结构，填写地址不代表任意接口已适配。免费天气和 GitHub 榜单可独立开启，无需 SSH 或密钥；天气按小时刷新，榜单每天成功保存一次，单次请求不重试。天气免费服务用于非商业用途。榜单原文免费；AI 中文介绍沿用现有付费开关。自定义行情支持公开 HTTPS GET JSON，在市场中心单独显示；默认手动读取，不发送鉴权信息。字段用点分隔，如 data.items、quote.price。</p></details>
  </div>;
}
