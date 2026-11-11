import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from "react";
import {WorkbenchNotes} from "./WorkbenchNotes";
import type {DashboardData,ProviderStatus,OverviewCardId} from "../types";
import {useApiMoneyClock} from "./ApiMoneyDetails";
import {apiMoneyView} from "../presentation/quotaAdapter";
import {HudQuotaDetails} from "./StatusHud";
import {normalizeOverviewCardOrder} from "../providers/settingsStore";
import {SelectionIndicator} from "./SelectionIndicator";
import {PcOverview,PcGpu,PcDisks,PcTrends} from "../widgets/ResourcePanels";
import {WidgetCard} from "../widgets/WidgetCard";
import {VpsServicePanel} from "./VpsServices";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";

export function overviewApiAccounts(providers:ProviderStatus[]):ProviderStatus[]{
 return providers.filter(item=>item.kind==="api"&&!['not-enabled','unconfigured','deferred','no-source','balance-unavailable'].includes(item.apiAvailabilityReason??""));
}

interface OverviewProps {
 displayName?:string;healthRequest?:number;data:DashboardData;simulationEnabled?:boolean;
 animationsEnabled?:boolean;cardOrder?:OverviewCardId[];onCardOrderChange?:(order:OverviewCardId[])=>void;
 onNotifications:()=>void;onRoom:()=>void;onConnections:()=>void;vpsInterval:number;vpsConfigured?:boolean;
}
const cardNames={agents:"AI 额度",api:"API 账户",vps:"服务器"};

export function WorkbenchOverview({displayName="",data,simulationEnabled=false,animationsEnabled=true,cardOrder,onCardOrderChange,onNotifications,onRoom,onConnections,vpsInterval,vpsConfigured=false,healthRequest}:OverviewProps) {
 const [filter,setFilter]=useState("全部"),[editing,setEditing]=useState(false);
 const [localOrder,setLocalOrder]=useState<OverviewCardId[]>(["agents","api","vps"]);
 const order=normalizeOverviewCardOrder(cardOrder??localOrder);
 const [agentId,setAgentId]=useState(""),[apiId,setApiId]=useState("");
 const clock=useApiMoneyClock(),now=Math.max(clock,Date.now());
 const root=useRef<HTMLElement>(null),healthPanel=useRef<HTMLDetailsElement>(null);
 const cards=useRef(new Map<OverviewCardId,HTMLElement>()),positions=useRef(new Map<OverviewCardId,{x:number;y:number}>());
 const dragging=useRef<OverviewCardId|null>(null),animations=useRef<Animation[]>([]);
 const agents=data.providers.filter(item=>item.kind==="agent");
 const useful=agents.filter(item=>item.installed||item.running||item.confidence==="verified"||item.usageWindows?.length||item.membership?.available);
 const choices=useful.length?useful:agents;
 const agent=choices.find(item=>item.id===agentId)??choices[0];
 const apis=overviewApiAccounts(data.providers),api=apis.find(item=>item.id===apiId)??apis[0];
 const money=api?apiMoneyView(api,now):null;
 const observed=Date.parse(agent?.lastUpdated??""),age=now-observed;
 const quotaFresh=simulationEnabled||Number.isFinite(observed)&&age>=0&&age<=330000&&agent?.dataState!=="Stale";
 const quota=quotaFresh?agent:agent?{...agent,state:"unknown" as const,membership:undefined}:undefined;
 const quotaNote=agent&&!quotaFresh?(Number.isFinite(observed)&&age>330000||agent.dataState==="Stale"?"数据已过期":"读取时间未确认"):agent?.error;
 const vpsLive=simulationEnabled&&["online","normal","warning"].includes(data.vps.state??"")||vpsMotionAvailable(data,now);
 const news=data.notices;
 const category=(title:string)=>/VPS|服务|Beszel/i.test(title)?"服务":/API|额度|账户|Codex|Claude|Antigravity|豆包|Kimi/i.test(title)?"账户":"系统";
 const filtered=filter==="全部"?news:news.filter(item=>category(item.title)===filter);
 useEffect(()=>{if(healthRequest&&healthPanel.current){healthPanel.current.open=true;healthPanel.current.scrollIntoView({block:"nearest"});}},[healthRequest]);
 useEffect(()=>()=>{animations.current.forEach(animation=>animation.cancel());},[]);
 useLayoutEffect(()=>{
  animations.current.forEach(animation=>animation.cancel());animations.current=[];
  const next=new Map<OverviewCardId,{x:number;y:number}>();
  const motion=animationsEnabled&&!window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  for(const [id,node] of cards.current){
   const box={x:node.offsetLeft,y:node.offsetTop},before=positions.current.get(id);next.set(id,box);
   if(motion&&before&&(before.x!==box.x||before.y!==box.y)&&node.animate)
    animations.current.push(node.animate([{transform:`translate(${before.x-box.x}px,${before.y-box.y}px)`},{transform:"translate(0,0)"}],{duration:220,easing:"cubic-bezier(.2,.8,.2,1)"}));
  }
  positions.current=next;
 },[order.join(","),animationsEnabled]);
 const move=(id:OverviewCardId,target:OverviewCardId)=>{
  if(id===target)return;
  const next=[...order];next.splice(next.indexOf(id),1);next.splice(order.indexOf(target),0,id);
  setLocalOrder(next);onCardOrderChange?.(next);
 };
 const resetAt=quotaFresh?agent?.usageWindows?.map(item=>Date.parse(item.resetsAt??"")).filter(at=>Number.isFinite(at)&&at>now).sort((a,b)=>a-b)[0]:undefined;
 const content:Record<OverviewCardId,ReactNode>={
  agents:<><div className="wb-summary-title"><h3>{agent?.name??"AI 额度"}</h3>{choices.length>1&&<select aria-label="选择额度客户端" value={agent?.id??""} onChange={event=>setAgentId(event.target.value)}>{choices.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}</div><HudQuotaDetails provider={quota}/><p className="wb-summary-note">{quotaNote||(!agent?"尚未连接客户端":resetAt?`重置 ${new Date(resetAt).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}`:agent.plan??"重置时间未知")}</p></>,
  api:<><div className="wb-summary-title"><h3>{api?.name??"API 账户"}</h3>{apis.length>1&&<select aria-label="选择 API 账户" value={api?.id??""} onChange={event=>setApiId(event.target.value)}>{apis.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}</div><span className="wb-summary-label">{money?.label??"账户余额"}</span><strong className="wb-summary-money">{money?.primary??"未知"}</strong><p className="wb-summary-note">{money?.note||(!api?"尚未配置账户":`读取 ${money?.stamp}`)}</p></>,
  vps:<><div className="wb-summary-title"><h3>{data.vps.name||"VPS"}</h3><span className={`wb-status-dot ${vpsLive?"is-online":""}`}>{vpsLive?"在线":data.vps.state==="offline"?"离线":"未知"}</span></div><div className="wb-summary-gauges">{["CPU","内存","磁盘"].map((label,index)=>{const item=data.vps.gauges[index];return <div key={label}><span>{item?.label??label}</span><strong>{vpsLive&&Number.isFinite(item?.value)?`${item.value.toFixed(1)}%`:"未知"}</strong></div>;})}</div><p className="wb-summary-note">{data.vps.error||(!vpsLive?(data.vps.lastSuccessAt?"数据未更新":"尚无成功读取"):data.vps.statusMessage||"连接正常")}</p></>
 };
 return <section ref={root} className={`wb-design-page wb-home wb-home-clear${!animationsEnabled?" wb-motion-off":""}`} data-no-page-swipe>
  <header className="wb-page-head"><div><h1 className="wb-personal-title">{displayName.trim()||"我的工作台"}</h1>{simulationEnabled&&<small className="wb-demo-label">模拟数据</small>}</div><div className="wb-overview-actions"><button className="wb-outline" onClick={onNotifications}>通知 {news.length}</button><button className="wb-outline" aria-pressed={editing} onClick={()=>setEditing(value=>!value)}>{editing?"完成布局":"调整布局"}</button></div></header>
  <div className="wb-home-hero-grid" aria-label="工作台摘要">
   {order.map((id,index)=><section className="wb-card wb-summary-card" key={id} data-overview-card={id} style={{"--card-index":index} as CSSProperties} ref={node=>{if(node)cards.current.set(id,node);else cards.current.delete(id);}} onDragOver={event=>{if(dragging.current){event.preventDefault();event.dataTransfer.dropEffect="move";}}} onDrop={event=>{event.preventDefault();if(dragging.current)move(dragging.current,id);dragging.current=null;}}>
    {editing&&<div className="wb-card-reorder"><span draggable aria-label={`拖动${cardNames[id]}`} title={`拖动${cardNames[id]}`} onDragStart={event=>{dragging.current=id;event.dataTransfer.effectAllowed="move";event.dataTransfer.setData("text/plain",id);}} onDragEnd={()=>{dragging.current=null;}}>⠿</span><span>{cardNames[id]}</span><button aria-label={`前移${cardNames[id]}`} disabled={index===0} onClick={()=>move(id,order[index-1])}>←</button><button aria-label={`后移${cardNames[id]}`} disabled={index===order.length-1} onClick={()=>move(id,order[index+1])}>→</button></div>}
    {content[id]}
   </section>)}
  </div>
  <div className="wb-home-grid"><main className="wb-main-column"><section className="wb-feed-section wb-card"><header><h2>动态</h2><nav className="wb-chips wb-moving-selection" aria-label="动态筛选"><SelectionIndicator activeKey={filter}/>{["全部","账户","服务","系统"].map(item=><button key={item} aria-pressed={filter===item} onClick={()=>setFilter(item)}>{item}</button>)}</nav></header>
   <div className="wb-home-feed" key={filter}>{filtered.map((item,index)=><article key={item.id??index} className={`wb-activity-row tone-${item.tone}`}><span className="wb-activity-mark" aria-hidden="true">{category(item.title)==="账户"?"◈":category(item.title)==="服务"?"▤":"◷"}</span><div><h3>{item.title}</h3><p>{item.detail}</p></div><button className="wb-outline" aria-label={`查看通知：${item.title}`} onClick={onNotifications}>查看</button></article>)}{!filtered.length&&<div className="wb-empty">当前筛选暂无摘要</div>}</div>
   </section><details className="wb-card wb-update-frequency"><summary>更新频率</summary>{vpsConfigured&&<p><strong>VPS 自动读取</strong> · 刷新间隔 {vpsInterval} 秒</p>}<p><strong>Windows 健康扫描</strong> · 显示时每分钟 · 隐藏时降频</p></details></main><aside className="wb-sidebar"><WorkbenchNotes/><div className="wb-overview-links"><button className="wb-outline" onClick={onRoom}>Agent Room ↗</button><button className="wb-outline" onClick={onConnections}>管理连接 ↗</button></div></aside>
   <details className="wb-home-health wb-card" ref={healthPanel}><summary>系统健康与事件日志 · {data.health.events?.length??0} 条重点事件</summary><WidgetCard id="health" data={data}/></details>
  </div>
 </section>;
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
 return <section className={`wb-design-page wb-resources${active?" resource-fx-test":""}${vpsEffects?" wb-vps-fx":""}`} data-no-page-swipe><header className="wb-page-head"><div><h1>{view==="pc"?"本机资源":"VPS 控制台"}</h1></div><div className="resource-fx-controls">{view==="vps"&&<button className="wb-outline" aria-pressed={effects} onClick={()=>setEffects(value=>!value)}>动效 {effects?"开启":"关闭"}</button>}{view==="vps"&&<button className="wb-outline" disabled={!vpsLive} onClick={()=>setEffectPulse(value=>value+1)}>演示光效</button>}{view==="vps"&&onConnections&&<button className="wb-outline" onClick={onConnections}>连接设置</button>}{view==="pc"&&<><button className="wb-outline" aria-pressed={effects} onClick={()=>setEffects(value=>!value)}>动效 {effects?"开启":"关闭"}</button><button className="wb-outline" disabled={!live} onClick={()=>setEffectPulse(value=>value+1)}>演示光效</button></>}<nav className="wb-chips wb-moving-selection" aria-label="资源来源"><SelectionIndicator activeKey={view}/><button aria-pressed={view==="pc"} onClick={()=>onView("pc")}>本机</button><button aria-pressed={view==="vps"} onClick={()=>onView("vps")}>VPS 控制台</button></nav></div></header>{view==="pc"?<>{effects&&(!animationsEnabled||reduced)&&<p className="resource-fx-caption">动效已暂停</p>}<div className="wb-resource-grid"><PcOverview data={data} effectsEnabled={live} effectPulse={effectPulse}/><PcGpu data={data} effectsEnabled={live}/><PcDisks data={data} effectsEnabled={live}/><PcTrends data={data} simulationEnabled={simulationEnabled} effectsEnabled={active} liveEffectsEnabled={live} effectPulse={effectPulse}/></div></>:<div className="wb-vps-history"><WidgetCard id="vps" vpsConsole effectsEnabled={vpsLive} effectPulse={effectPulse} data={data} simulationEnabled={simulationEnabled} vpsHubUrl={vpsHubUrl}/><VpsServicePanel simulationEnabled={simulationEnabled} onOpenPanel={onOpenServicePanel}/><WidgetCard id="resources" vpsConsole effectsEnabled={vpsLive} effectPulse={effectPulse} data={data} simulationEnabled={simulationEnabled} vpsHubUrl={vpsHubUrl}/></div>}</section>;
}
