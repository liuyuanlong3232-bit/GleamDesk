import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode,type PointerEvent,type KeyboardEvent} from "react";
import {createWidgetAnimationManager} from "../widgets/animationManager";
import {WorkbenchNotes} from "./WorkbenchNotes";
import type {DashboardData,ProviderStatus,OverviewCardId,OverviewCardSizes} from "../types";
import {useApiMoneyClock} from "./ApiMoneyDetails";
import {apiMoneyView,hudQuotaUsed} from "../presentation/quotaAdapter";
import {HudQuotaDetails} from "./StatusHud";
import {normalizeOverviewCardOrder,normalizeOverviewCardSizes} from "../providers/settingsStore";
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
 animationsEnabled?:boolean;cardSizes?:OverviewCardSizes;onCardSizesChange?:(sizes:OverviewCardSizes)=>void;cardOrder?:OverviewCardId[];onCardOrderChange?:(order:OverviewCardId[])=>void;
 onNotifications:()=>void;onRoom:()=>void;onConnections:()=>void;vpsInterval:number;vpsConfigured?:boolean;
}
const cardNames:Record<OverviewCardId,string>={agents:"AI 额度",api:"API 账户",vps:"服务器",activity:"动态",todos:"待办",updates:"更新频率",health:"系统健康"};
const layoutInteractive="button,input,textarea,select,a,summary,[contenteditable=true],[role=slider],canvas,video,audio";

export function WorkbenchOverview({displayName="",data,simulationEnabled=false,animationsEnabled=true,cardOrder,cardSizes,onCardOrderChange,onCardSizesChange,onNotifications,onRoom,onConnections,vpsInterval,vpsConfigured=false,healthRequest}:OverviewProps) {
 const [filter,setFilter]=useState("全部"),[editing,setEditing]=useState(false);
 const [todosReady,setTodosReady]=useState(false);
 const [agentId,setAgentId]=useState(""),[apiId,setApiId]=useState("");
 const clock=useApiMoneyClock(),now=Math.max(clock,Date.now());
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
 const healthAt=Date.parse(data.health.lastScanAt??"");
 const ready:Record<OverviewCardId,boolean>={agents:quotaFresh&&(hudQuotaUsed(agent)!==undefined||Boolean(agent?.membership?.available)),api:Boolean(money?.hasCurrentAmount),vps:vpsLive&&data.vps.gauges.some(item=>Number.isFinite(item.value)),activity:news.length>0,todos:todosReady,updates:true,health:Number.isFinite(healthAt)&&healthAt<=now&&now-healthAt<=330000};
 const layout=useOverviewCardLayout(cardOrder,cardSizes,animationsEnabled,ready,onCardOrderChange,onCardSizesChange);
 useEffect(()=>{if(healthRequest)layout.cards.current.get("health")?.scrollIntoView({block:"nearest"});},[healthRequest]);
 const resetAt=quotaFresh?agent?.usageWindows?.map(item=>Date.parse(item.resetsAt??"")).filter(at=>Number.isFinite(at)&&at>now).sort((a,b)=>a-b)[0]:undefined;
 const content:Record<OverviewCardId,ReactNode>={
  agents:<><div className="wb-summary-title"><h3>{agent?.name??"AI 额度"}</h3>{choices.length>1&&<select aria-label="选择额度客户端" value={agent?.id??""} onChange={event=>setAgentId(event.target.value)}>{choices.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}</div><HudQuotaDetails provider={quota}/><p className="wb-summary-note">{quotaNote||(!agent?"尚未连接客户端":resetAt?`重置 ${new Date(resetAt).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}`:agent.plan??"重置时间未知")}</p></>,
  api:<><div className="wb-summary-title"><h3>{api?.name??"API 账户"}</h3>{apis.length>1&&<select aria-label="选择 API 账户" value={api?.id??""} onChange={event=>setApiId(event.target.value)}>{apis.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}</div><span className="wb-summary-label">{money?.label??"账户余额"}</span><strong className="wb-summary-money">{money?.primary??"未知"}</strong><p className="wb-summary-note">{money?.note||(!api?"尚未配置账户":`读取 ${money?.stamp}`)}</p></>,
  vps:<><div className="wb-summary-title"><h3>{data.vps.name||"VPS"}</h3><span className={`wb-status-dot ${vpsLive?"is-online":""}`}>{vpsLive?"在线":data.vps.state==="offline"?"离线":"未知"}</span></div><div className="wb-summary-gauges">{["CPU","内存","磁盘"].map((label,index)=>{const item=data.vps.gauges[index];return <div key={label}><span>{item?.label??label}</span><strong>{vpsLive&&Number.isFinite(item?.value)?`${item.value.toFixed(1)}%`:"未知"}</strong></div>;})}</div><p className="wb-summary-note">{data.vps.error||(!vpsLive?(data.vps.lastSuccessAt?"数据未更新":"尚无成功读取"):data.vps.statusMessage||"连接正常")}</p></>,
  activity:<div className="wb-feed-section"><header><h2>动态</h2><nav className="wb-chips wb-moving-selection" aria-label="动态筛选"><SelectionIndicator activeKey={filter}/>{["全部","账户","服务","系统"].map(item=><button key={item} aria-pressed={filter===item} onClick={()=>setFilter(item)}>{item}</button>)}</nav></header>
   <div className="wb-home-feed" key={filter}>{filtered.map((item,index)=><article key={item.id??index} className={`wb-activity-row tone-${item.tone}`}><span className="wb-activity-mark" aria-hidden="true">{category(item.title)==="账户"?"◈":category(item.title)==="服务"?"▤":"◷"}</span><div><h3>{item.title}</h3><p>{item.detail}</p></div><button className="wb-outline" aria-label={`查看通知：${item.title}`} onClick={onNotifications}>查看</button></article>)}{!filtered.length&&<div className="wb-empty">当前筛选暂无摘要</div>}</div></div>,
  todos:<WorkbenchNotes embedded onReady={setTodosReady}/>,
  updates:<section className="wb-update-frequency"><h2>更新频率</h2>{vpsConfigured&&<p><strong>VPS 自动读取</strong> · 刷新间隔 {vpsInterval} 秒</p>}<p><strong>Windows 健康扫描</strong> · 显示时每分钟 · 隐藏时降频</p></section>,
  health:<WidgetCard id="health" data={data}/>

 };
 return <section ref={layout.root} className={`wb-design-page wb-home wb-home-clear${editing?" is-layout-editing":""}${layout.active?" is-layout-interacting":""}${!animationsEnabled?" wb-motion-off":""}`} data-no-page-swipe onPointerMove={layout.pointerMove} onPointerUp={()=>layout.finish(true)} onPointerCancel={()=>layout.finish(false)} onLostPointerCapture={()=>layout.finish(false)} onKeyDown={event=>{if(event.key==="Escape"&&layout.active){event.preventDefault();event.stopPropagation();layout.finish(false);}}}>
  <header className="wb-page-head"><div><h1 className="wb-personal-title">{displayName.trim()||"我的工作台"}</h1>{simulationEnabled&&<small className="wb-demo-label">模拟数据</small>}</div><div className="wb-overview-actions"><button className="wb-outline" onClick={onNotifications}>通知 {news.length}</button><button className="wb-outline" aria-pressed={editing} onClick={()=>{layout.finish(true);setEditing(value=>!value);}}>{editing?"完成布局":"调整布局"}</button></div></header>
  <p id="wb-layout-keyboard" className="visually-hidden">移动：拖动卡片标题或空白处；键盘空格拾起，方向键移动，空格放下，Esc 取消。大小：左右键调整宽度，上下键调整高度。</p>
  <span className="visually-hidden" role="status">{layout.announcement}</span>
  <div ref={layout.grid} className="wb-home-hero-grid wb-overview-modules" aria-label="总览模块">
   {layout.order.map((id,index)=><div className={`wb-summary-slot${layout.active?.id===id?` is-${layout.active.kind}`:""}`} key={id} data-overview-card={id} tabIndex={editing?0:undefined} role={editing?"group":undefined} aria-label={editing?`移动${cardNames[id]}`:undefined} aria-describedby={editing?"wb-layout-keyboard":undefined} onPointerDown={event=>{if(editing&&!(event.target as Element).closest(layoutInteractive))layout.begin(event,id,"move");}} onKeyDown={event=>{if(event.target===event.currentTarget)layout.keyMove(event,id);}} style={{"--card-index":index,"--card-columns":layout.sizes[id].columns,"--card-height":`${layout.sizes[id].height}px`} as CSSProperties} ref={node=>{if(node)layout.cards.current.set(id,node);else layout.cards.current.delete(id);}}>
    <section className="wb-card wb-summary-card">
     <div className="wb-summary-body">{content[id]}</div>
     {editing&&<button type="button" className="wb-resize-handle" aria-label={`调整${cardNames[id]}大小`} title="拖动调整大小" aria-describedby="wb-layout-keyboard" onPointerDown={event=>layout.begin(event,id,"resize")} onKeyDown={event=>layout.keyResize(event,id)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 16 9-9M12 16l4-4"/></svg></button>}
    </section>
   </div>)}
  </div>
  <div className="wb-overview-links"><button className="wb-outline" onClick={onRoom}>Agent Room ↗</button><button className="wb-outline" onClick={onConnections}>管理连接 ↗</button></div>
 </section>;
}

// Pointer capture stays on the scrolling page, so a card can move in the DOM without losing the gesture.
function useOverviewCardLayout(savedOrder:OverviewCardId[]|undefined,savedSizes:OverviewCardSizes|undefined,animationsEnabled:boolean,ready:Record<OverviewCardId,boolean>,onOrderChange?:OverviewProps["onCardOrderChange"],onSizesChange?:OverviewProps["onCardSizesChange"]) {
 const [localOrder,setLocalOrder]=useState<OverviewCardId[]>(()=>normalizeOverviewCardOrder(null)),[localSizes,setLocalSizes]=useState(()=>normalizeOverviewCardSizes(null));
 const [draftOrder,setDraftOrder]=useState<OverviewCardId[]|null>(null),[draftSizes,setDraftSizes]=useState<OverviewCardSizes|null>(null);
 const [active,setActive]=useState<{id:OverviewCardId;kind:"move"|"resize"|"keyboard"}|null>(null),[announcement,setAnnouncement]=useState("");
 const order=draftOrder??normalizeOverviewCardOrder(savedOrder??localOrder),sizes=draftSizes??normalizeOverviewCardSizes(savedSizes??localSizes);
 const root=useRef<HTMLElement>(null),grid=useRef<HTMLDivElement>(null),cards=useRef(new Map<OverviewCardId,HTMLElement>());
 const awakened=useRef(new Set<OverviewCardId>());
 const [visible,setVisible]=useState(true);
 const frame=useRef(0),animations=useRef<Animation[]>([]),positions=useRef(new Map<OverviewCardId,{x:number;y:number}>());
 const focusAfter=useRef<OverviewCardId|null>(null),drop=useRef<{id:OverviewCardId;left:number;top:number}|null>(null);
 type Gesture={id:OverviewCardId;kind:"move"|"resize"|"keyboard";pointerId?:number;x:number;y:number;startX:number;startY:number;grabX:number;grabY:number;width:number;wide:boolean;lastSwap?:{x:number;y:number};originalSizes:OverviewCardSizes;moved:boolean};
 const gesture=useRef<Gesture|null>(null),latest=useRef({order,sizes,animationsEnabled,onOrderChange,onSizesChange});
 latest.current={order,sizes,animationsEnabled,onOrderChange,onSizesChange};
 const motion=()=>latest.current.animationsEnabled&&!window.matchMedia("(prefers-reduced-motion: reduce)").matches;
 const previewOrder=(next:OverviewCardId[])=>{latest.current.order=next;setDraftOrder(next);};
 const previewSizes=(next:OverviewCardSizes)=>{latest.current.sizes=next;setDraftSizes(next);};
 const reorder=(id:OverviewCardId,target:OverviewCardId)=>{
  const next=[...latest.current.order];if(id===target)return;
  next.splice(next.indexOf(id),1);next.splice(latest.current.order.indexOf(target),0,id);previewOrder(next);
  setAnnouncement(`${cardNames[id]}，第 ${next.indexOf(id)+1} 位，共 ${next.length} 张`);
 };
 const paint=()=>{
  const g=gesture.current;if(g?.kind!=="move")return;
  const slot=cards.current.get(g.id),card=slot?.querySelector<HTMLElement>(".wb-summary-card");if(!slot||!card)return;
  const box=slot.getBoundingClientRect();card.style.transform=`translate(${g.x-g.grabX-box.left}px,${g.y-g.grabY-box.top}px)`;
 };
 const finish=(commit:boolean)=>{
  const g=gesture.current;if(!g)return;
  const card=cards.current.get(g.id)?.querySelector<HTMLElement>(".wb-summary-card");
  if(g.kind==="move"&&g.moved&&card){const box=card.getBoundingClientRect();drop.current={id:g.id,left:box.left,top:box.top};}
  gesture.current=null;cancelAnimationFrame(frame.current);
  if(g.pointerId!==undefined&&root.current?.hasPointerCapture(g.pointerId))root.current.releasePointerCapture(g.pointerId);
  if(card)card.style.transform="";
  if(commit){
   if(g.kind==="resize"){setLocalSizes(latest.current.sizes);latest.current.onSizesChange?.(latest.current.sizes);}
   else {setLocalOrder(latest.current.order);latest.current.onOrderChange?.(latest.current.order);}
  }
  setDraftOrder(null);setDraftSizes(null);setActive(null);focusAfter.current=g.kind==="resize"?null:g.id;
  setAnnouncement(commit?`${cardNames[g.id]}布局已调整`:`已取消调整${cardNames[g.id]}`);
 };
 const step=()=>{
  const g=gesture.current,page=root.current,area=grid.current;if(!g||!page||!area)return;
  g.moved ||= Math.hypot(g.x-g.startX,g.y-g.startY)>4;
  if(g.moved&&g.kind==="move"){
   const bounds=page.getBoundingClientRect();
   if(g.y>bounds.bottom-44)page.scrollTop+=12;else if(g.y<bounds.top+44)page.scrollTop-=12;
   const box=area.getBoundingClientRect();
   if(!g.lastSwap||Math.hypot(g.x-g.lastSwap.x,g.y-g.lastSwap.y)>12){
    let nearest:OverviewCardId=g.id,distance=Infinity;
    for(const [id,node] of cards.current){
     const left=box.left+node.offsetLeft,top=box.top+node.offsetTop;
     if(g.x>=left&&g.x<=left+node.offsetWidth&&g.y>=top&&g.y<=top+node.offsetHeight){nearest=id;break;}
     const value=(g.x-left-node.offsetWidth/2)**2+(g.y-top-node.offsetHeight/2)**2;
     if(value<distance){nearest=id;distance=value;}
    }
    if(nearest!==g.id){reorder(g.id,nearest);g.lastSwap={x:g.x,y:g.y};}
   }
   paint();
  }else if(g.moved&&g.kind==="resize"){
   const gap=parseFloat(getComputedStyle(area).columnGap)||20,unit=(area.clientWidth+gap)/12;
   const columns=g.wide?Math.min(12,Math.max(Math.ceil((216+gap)/unit),Math.round((g.width+g.x-g.startX+gap)/unit))):g.originalSizes[g.id].columns;
   const next=normalizeOverviewCardSizes({...latest.current.sizes,[g.id]:{columns,height:g.originalSizes[g.id].height+g.y-g.startY}});
   if(JSON.stringify(next)!==JSON.stringify(latest.current.sizes))previewSizes(next);
  }
  frame.current=requestAnimationFrame(step);
 };
 const begin=(event:PointerEvent<HTMLElement>,id:OverviewCardId,kind:"move"|"resize")=>{
  if(event.button!==0||gesture.current||!root.current)return;
  const card=cards.current.get(id)?.querySelector<HTMLElement>(".wb-summary-card");if(!card)return;
  event.preventDefault();event.currentTarget.focus({preventScroll:true});root.current.setPointerCapture(event.pointerId);
  animations.current.forEach(animation=>animation.cancel());const box=card.getBoundingClientRect();
  gesture.current={id,kind,pointerId:event.pointerId,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,grabX:event.clientX-box.left,grabY:event.clientY-box.top,width:box.width,wide:(grid.current?.clientWidth??0)>680,originalSizes:latest.current.sizes,moved:false};
  setActive({id,kind});frame.current=requestAnimationFrame(step);
 };
 const pointerMove=(event:PointerEvent<HTMLElement>)=>{const g=gesture.current;if(g&&g.pointerId===event.pointerId){g.x=event.clientX;g.y=event.clientY;}};
 const keyMove=(event:KeyboardEvent<HTMLElement>,id:OverviewCardId)=>{
  if(event.key===" "||event.key==="Enter"){
   event.preventDefault();if(gesture.current?.kind==="keyboard"){finish(true);return;}if(gesture.current)return;
   gesture.current={id,kind:"keyboard",x:0,y:0,startX:0,startY:0,grabX:0,grabY:0,width:0,wide:true,originalSizes:latest.current.sizes,moved:false};
   setActive({id,kind:"keyboard"});setAnnouncement(`已拾起${cardNames[id]}，方向键移动，空格放下，Esc 取消`);return;
  }
  if(gesture.current?.kind!=="keyboard"||gesture.current.id!==id)return;
  const offset=["ArrowLeft","ArrowUp"].includes(event.key)?-1:["ArrowRight","ArrowDown"].includes(event.key)?1:0;
  if(offset){event.preventDefault();const target=latest.current.order[latest.current.order.indexOf(id)+offset];if(target)reorder(id,target);}
 };
 const keyResize=(event:KeyboardEvent<HTMLButtonElement>,id:OverviewCardId)=>{
  if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key)||gesture.current)return;
  event.preventDefault();const current=latest.current.sizes[id],next=normalizeOverviewCardSizes({...latest.current.sizes,[id]:{columns:current.columns+(event.key==="ArrowRight"?1:event.key==="ArrowLeft"?-1:0),height:current.height+(event.key==="ArrowDown"?24:event.key==="ArrowUp"?-24:0)}});
  setLocalSizes(next);latest.current.onSizesChange?.(next);setAnnouncement(`${cardNames[id]}，宽 ${next[id].columns} 格，高 ${next[id].height} 像素`);
 };
 useLayoutEffect(()=>{
  animations.current.forEach(animation=>animation.cancel());animations.current=[];
  const next=new Map<OverviewCardId,{x:number;y:number}>();
  for(const [id,node] of cards.current){const box={x:node.offsetLeft,y:node.offsetTop},before=positions.current.get(id);next.set(id,box);
   if(motion()&&before&&id!==active?.id&&(before.x!==box.x||before.y!==box.y)&&node.animate)
    animations.current.push(node.animate([{transform:`translate(${before.x-box.x}px,${before.y-box.y}px)`},{transform:"translate(0,0)"}],{duration:200,easing:"cubic-bezier(.2,.8,.2,1)"}));
  }
  positions.current=next;paint();
  if(visible&&isWindowVisible())for(const [id,node] of cards.current){
   if(!ready[id]||awakened.current.has(id))continue;
   awakened.current.add(id);node.dataset.awakened="true";
   if(motion()){const animation=createWidgetAnimationManager(true).play(node,"enter");if(animation){animation.effect?.updateTiming({delay:order.indexOf(id)*35});animations.current.push(animation);}}
  }
  if(drop.current&&!active){const point=drop.current,card=cards.current.get(point.id)?.querySelector<HTMLElement>(".wb-summary-card");drop.current=null;if(card&&motion()){const box=card.getBoundingClientRect();animations.current.push(card.animate([{transform:`translate(${point.left-box.left}px,${point.top-box.top}px)`},{transform:"translate(0,0)"}],{duration:180,easing:"ease-out"}));}}
  const focus=active?.kind==="keyboard"?active.id:focusAfter.current;
  if(focus){cards.current.get(focus)?.focus({preventScroll:true});focusAfter.current=null;}
 },[order.join(","),JSON.stringify(sizes),active,animationsEnabled,JSON.stringify(ready),visible]);
 useEffect(()=>{setVisible(isWindowVisible());return subscribeWindowVisibility(()=>setVisible(isWindowVisible()));},[]);
 useEffect(()=>{
  const cancel=()=>finish(false),media=window.matchMedia("(prefers-reduced-motion: reduce)"),reduce=()=>{if(media.matches)animations.current.forEach(animation=>animation.cancel());};
  window.addEventListener("blur",cancel);window.addEventListener("resize",cancel);media.addEventListener("change",reduce);
  return()=>{cancelAnimationFrame(frame.current);animations.current.forEach(animation=>animation.cancel());window.removeEventListener("blur",cancel);window.removeEventListener("resize",cancel);media.removeEventListener("change",reduce);};
 },[]);
 return {root,grid,cards,order,sizes,active,announcement,begin,pointerMove,finish,keyMove,keyResize};
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
