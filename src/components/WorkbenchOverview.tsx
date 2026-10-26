import {useEffect,useRef,useState} from "react";
import {WorkbenchNotes} from "./WorkbenchNotes";
import type {DashboardData,ProviderStatus} from "../types";
import {ApiMoneyDetails,useApiMoneyClock} from "./ApiMoneyDetails";
import {PcOverview,PcGpu,PcDisks,PcTrends} from "../widgets/ResourcePanels";
import {WidgetCard} from "../widgets/WidgetCard";
import {VpsServicePanel} from "./VpsServices";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";
import {AIControlCenter,usageWindowTitle} from "./AIControlCenter";

export function workbenchGreeting(now=new Date()):string {
 const hour=now.getHours();
 return hour<12?"早安":hour<18?"下午好":"晚上好";
}

export function overviewApiAccounts(providers:ProviderStatus[]):ProviderStatus[]{
 return providers.filter(item=>item.kind==="api"&&!['not-enabled','unconfigured','deferred','no-source','balance-unavailable'].includes(item.apiAvailabilityReason??""));
}

export function WorkbenchOverview({displayName="",data,simulationEnabled=false,onNotifications,onRoom,onConnections,vpsInterval,vpsConfigured=false,healthRequest}:{displayName?:string;healthRequest?:number;data:DashboardData;simulationEnabled?:boolean;onNotifications:()=>void;onRoom:()=>void;onConnections:()=>void;vpsInterval:number;vpsConfigured?:boolean}) {
 const [filter,setFilter]=useState("全部");
 const apiClock=useApiMoneyClock();
 const [greeting,setGreeting]=useState(()=>workbenchGreeting());
 useEffect(()=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const refresh=()=>{clearTimeout(timer);if(!isWindowVisible())return;setGreeting(workbenchGreeting());timer=setTimeout(refresh,60000-Date.now()%60000);};
  refresh();const unsubscribe=subscribeWindowVisibility(refresh);window.addEventListener("focus",refresh);
  return()=>{clearTimeout(timer);unsubscribe();window.removeEventListener("focus",refresh);};
 },[]);
 const healthPanel=useRef<HTMLDetailsElement>(null);
 useEffect(()=>{if(healthRequest&&healthPanel.current){healthPanel.current.open=true;healthPanel.current.scrollIntoView({block:"nearest"});}},[healthRequest]);
 const codex=data.providers.find(item=>item.id==="codex"),quota=codex?.usageWindows?.find(item=>item.windowDurationMins===300);
 const apiItems=filter==="全部"||filter==="账户"?overviewApiAccounts(data.providers):[];
 const news=data.notices;
 const filtered=filter==="全部"?news:news.filter(item=>filter==="系统"?/系统|硬件|关机|事件/.test(item.title):filter==="服务"?/VPS|服务|Beszel/.test(item.title):/API|额度|账户/.test(item.title));
 const sources=[{label:"账户",count:news.filter(item=>/API|额度|账户/.test(item.title)).length,color:"#c2263f"},{label:"服务",count:news.filter(item=>/VPS|服务|Beszel/.test(item.title)).length,color:"#bd638e"},{label:"其他",count:news.filter(item=>!/API|额度|账户|VPS|服务|Beszel/.test(item.title)).length,color:"#e4ad55"}];
 let start=0;const gradient=sources.map(item=>{const end=start+(news.length?item.count/news.length*100:0),part=`${item.color} ${start}% ${end}%`;start=end;return part;}).join(",");
 return <section className="wb-design-page wb-home" data-no-page-swipe><header className="wb-page-head"><div><h1 className="wb-personal-title">{displayName.trim()||"我的工作台"}<span className="wb-time-greeting">{greeting}</span></h1></div><button className="wb-primary" onClick={onNotifications}>查看通知</button></header>
  <div className="wb-home-grid"><main className="wb-main-column"><div className="wb-home-hero-grid"><section className="wb-feature"><span className="wb-eyebrow">今日焦点</span><h2>{quota?.usedPercent!==undefined?`Codex 5 小时额度剩余 ${Math.max(0,100-quota.usedPercent).toFixed(0)}%`:news[0]?.title??"暂无服务状态"}</h2><p>{quota?.usedPercent!==undefined?`${usageWindowTitle(quota,"codex")} · ${quota.resetsAt?`重置 ${new Date(quota.resetsAt).toLocaleString("zh-CN")}`:"重置时间未知"}`:news[0]?.detail??"暂无状态数据"}</p>{simulationEnabled&&<div className="wb-source-badges"><span>模拟数据</span></div>}</section><section className="wb-card wb-pulse"><h2>当前通知脉搏</h2><div className="wb-pulse-body"><div><b className="wb-pulse-number">{news.length}</b><small>条当前摘要</small></div><div className="wb-donut" style={{background:news.length?`conic-gradient(${gradient})`:"#29282f"}} aria-label={`${news.length}条通知分类`}/></div><div className="wb-pulse-legend">{sources.map(item=><span key={item.label}><i style={{background:item.color}}/>{item.label} {item.count}</span>)}</div><footer><button onClick={onNotifications}>查看完整通知历史 →</button></footer></section></div>
   <section className="wb-feed-section"><header><h2>信息流</h2><nav className="wb-chips">{["全部","账户","服务","系统"].map(item=><button key={item} aria-pressed={filter===item} onClick={()=>setFilter(item)}>{item}</button>)}</nav></header><div className="wb-home-feed">{apiItems.map(item=><article className="wb-card" key={item.id}><div className="wb-feed-meta"><span>API 账户</span></div><h3>{item.name}</h3><ApiMoneyDetails api={item} now={apiClock}/></article>)}{filtered.map((item,index)=><article className="wb-card" key={item.id??index}><div className="wb-feed-meta"><span>状态摘要</span><span>{item.tone==="amber"?"注意":"记录"}</span></div><h3>{item.title}</h3><p>{item.detail}</p><footer><button className="wb-outline" onClick={onNotifications}>查看通知</button></footer></article>)}{!filtered.length&&!apiItems.length&&<div className="wb-empty">当前筛选暂无摘要</div>}</div></section>
   <WorkbenchNotes/>
  </main><aside className="wb-sidebar"><section className="wb-service-card"><AIControlCenter agents={data.providers.filter(item=>item.kind==="agent")} localAI={data.localAI} gpuName={data.hardware?.gpu.name}/></section><section className="wb-card"><h2>服务器</h2><p>{data.vps.name||"Beszel"}</p><strong>{data.vps.statusMessage||data.vps.state||"Unknown"}</strong><div className="wb-index-list">{data.vps.gauges.map(item=><div key={item.label}><span>{item.label}</span><b>{item.value.toFixed(1)}%</b></div>)}</div><small>{data.vps.lastSuccessAt?`最后成功 ${new Date(data.vps.lastSuccessAt).toLocaleString("zh-CN")}`:"尚无成功读取"}</small>{data.vps.error&&<p>{data.vps.error}</p>}</section><section className="wb-card"><h2>定时任务</h2><div className="wb-timeline">{vpsConfigured&&<article><span className="wb-timeline-dot"/><div><strong>VPS 自动读取</strong><small>刷新间隔 {vpsInterval} 秒</small></div></article>}<article><span className="wb-timeline-dot"/><div><strong>Windows 健康扫描</strong><small>显示时每分钟 · 隐藏时降频</small></div></article></div></section><button className="wb-outline" onClick={onRoom}>查看所有智能体</button><button className="wb-outline" onClick={onConnections}>管理数据连接</button></aside>

   <details className="wb-home-health wb-card" ref={healthPanel}><summary>系统健康与事件日志 · {data.health.events?.length??0} 条重点事件</summary><WidgetCard id="health" data={data}/></details>
  </div></section>;
}



export function vpsMotionAvailable(data:DashboardData,now=Date.now()):boolean {
 const at=Date.parse(data.vps.lastSuccessAt??""),status=data.providerDiagnostics.find(item=>item.providerId==="vps-status")?.status;
 return data.vps.state==="online"&&Number.isFinite(at)&&now>=at&&now-at<=330000&&!["stale","error","unavailable"].includes(status??"");
}

export function WorkbenchResources({data,view,onView,simulationEnabled=false,vpsHubUrl="",animationsEnabled=true,onConnections,onOpenServicePanel}:{data:DashboardData;view:"pc"|"vps";onView:(view:"pc"|"vps")=>void;simulationEnabled?:boolean;vpsHubUrl?:string;animationsEnabled?:boolean;onConnections?:()=>void;onOpenServicePanel?:(url:string,name:string)=>void}) {
 const [effects,setEffects]=useState(true),[effectPulse,setEffectPulse]=useState(0),[visible,setVisible]=useState(true),[reduced,setReduced]=useState(false);
 useEffect(()=>{setVisible(isWindowVisible());return subscribeWindowVisibility(()=>setVisible(isWindowVisible()));},[]);
 useEffect(()=>{const media=window.matchMedia("(prefers-reduced-motion: reduce)"),update=()=>setReduced(media.matches);update();media.addEventListener("change",update);return()=>media.removeEventListener("change",update);},[]);
 const motion=effects&&animationsEnabled&&!reduced&&visible;
 const active=motion&&view==="pc",vpsEffects=motion&&view==="vps";
 const vpsLive=vpsEffects&&vpsMotionAvailable(data);
 const diagnostic=data.providerDiagnostics.find(item=>item.providerId==="hardware-status");
 const sampleAt=data.hardware?.sampledAtUnixMs,age=typeof sampleAt==="number"?Date.now()-sampleAt:Infinity;
 const live=active&&age>=0&&age<=10000&&!["stale","error","unavailable"].includes(diagnostic?.status??"");
 return <section className={`wb-design-page wb-resources${active?" resource-fx-test":""}${vpsEffects?" wb-vps-fx":""}`} data-no-page-swipe><header className="wb-page-head"><div><h1>{view==="pc"?"本机资源":"VPS 控制台"}</h1></div><div className="resource-fx-controls">{view==="vps"&&<button className="wb-outline" aria-pressed={effects} onClick={()=>setEffects(value=>!value)}>动效 {effects?"开启":"关闭"}</button>}{view==="vps"&&<button className="wb-outline" disabled={!vpsLive} onClick={()=>setEffectPulse(value=>value+1)}>演示光效</button>}{view==="vps"&&onConnections&&<button className="wb-outline" onClick={onConnections}>连接设置</button>}{view==="pc"&&<><button className="wb-outline" aria-pressed={effects} onClick={()=>setEffects(value=>!value)}>动效 {effects?"开启":"关闭"}</button><button className="wb-outline" disabled={!live} onClick={()=>setEffectPulse(value=>value+1)}>演示光效</button></>}<nav className="wb-chips" aria-label="资源来源"><button aria-pressed={view==="pc"} onClick={()=>onView("pc")}>本机</button><button aria-pressed={view==="vps"} onClick={()=>onView("vps")}>VPS 控制台</button></nav></div></header>{view==="pc"?<>{effects&&(!animationsEnabled||reduced)&&<p className="resource-fx-caption">动效已暂停</p>}<div className="wb-resource-grid"><PcOverview data={data} effectsEnabled={live} effectPulse={effectPulse}/><PcGpu data={data} effectsEnabled={live}/><PcDisks data={data} effectsEnabled={live}/><PcTrends data={data} simulationEnabled={simulationEnabled} effectsEnabled={active} liveEffectsEnabled={live} effectPulse={effectPulse}/></div></>:<div className="wb-vps-history"><WidgetCard id="vps" vpsConsole effectsEnabled={vpsLive} effectPulse={effectPulse} data={data} simulationEnabled={simulationEnabled} vpsHubUrl={vpsHubUrl}/><VpsServicePanel simulationEnabled={simulationEnabled} onOpenPanel={onOpenServicePanel}/><WidgetCard id="resources" vpsConsole effectsEnabled={vpsLive} effectPulse={effectPulse} data={data} simulationEnabled={simulationEnabled} vpsHubUrl={vpsHubUrl}/></div>}</section>;
}
