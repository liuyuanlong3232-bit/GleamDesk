import {useEffect,useRef,useState,type ReactNode,type CSSProperties} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {requestAppExit} from "../services/windowVisibility";
import {dragHudPlacement,hudPosition,loadHudPlacement,saveHudPlacement,type HudPlacement,type HudEdge} from "../providers/layoutStore";
import codexMark from "../assets/hud/chatgpt.png";
import claudeMark from "../assets/hud/claude.png";
import antigravityMark from "../assets/hud/antigravity.png";
import apiHubMark from "../assets/hud/api-fluent.png";
import mailHubMark from "../assets/hud/mail-fluent.png";
import vpsHubMark from "../assets/hud/vps-fluent.png";
import pcHubMark from "../assets/hud/pc-fluent.png";
import ollamaMark from "../assets/hud/ollama.svg";
import doubaoMark from "../assets/hud/doubao.svg";
import geminiMark from "../assets/hud/gemini.svg";
import cursorMark from "../assets/hud/cursor.png";
import windsurfMark from "../assets/hud/windsurf.svg";
import traeMark from "../assets/hud/trae-color.svg";
import copilotMark from "../assets/hud/copilot.png";
import qwenMark from "../assets/hud/qwen.png";
import opencodeMark from "../assets/hud/opencode-dark.png";
import kimiMark from "../assets/hud/kimi.png";
import piMark from "../assets/hud/pi.png";
import hermesMark from "../assets/hud/hermes.png";
import openclawMark from "../assets/hud/openclaw.png";
import codebuddyMark from "../assets/hud/codebuddy.png";
import workbuddyMark from "../assets/hud/workbuddy.png";
import qoderMark from "../assets/hud/qoder-dark.png";
import zcodeMark from "../assets/hud/zcode.png";
import deepseekMark from "../assets/hud/deepseek.png";
import gooseMark from "../assets/hud/goose.svg";
import {AvatarArtwork} from "./AvatarArtwork";
import {hudQuotaUsed,apiMoneyView,doubaoReadIssueMessage} from "../presentation/quotaAdapter";
import {usageWindowTitle} from "./AIControlCenter";
import type {ProviderStatus,ApiConnectionSettings} from "../types";
import {CloseIcon} from "./CloseIcon";
import {MailOtpToast} from './MailOtpToast';

const clientMarks:Record<string,string>={codex:codexMark,claude:claudeMark,antigravity:antigravityMark,ollama:ollamaMark,doubao:doubaoMark,gemini:geminiMark,cursor:cursorMark,windsurf:windsurfMark,trae:traeMark,copilot:copilotMark,qwen:qwenMark,opencode:opencodeMark,kimi:kimiMark,pi:piMark,hermes:hermesMark,openclaw:openclawMark,codebuddy:codebuddyMark,workbuddy:workbuddyMark,qoder:qoderMark,zcode:zcodeMark,"deepseek-harness":deepseekMark,goose:gooseMark};
const templateMarks=new Set(["codex","cursor","windsurf","copilot","kimi","pi","hermes","zcode","goose","ollama"]);
const utilityMarks:Record<string,string>={api:apiHubMark,mail:mailHubMark,vps:vpsHubMark,pc:pcHubMark};

export function HudQuotaDetails({provider}:{provider?:ProviderStatus}){
 if(provider?.id==="doubao"&&provider.membership?.available){
  const readings=provider.membership.benefits.flatMap(benefit=>{
   const usage=benefit.detail.match(/已(?:用|使用)\s*[<＜]?\s*\d+(?:\.\d+)?\s*%/);
   return usage?[{label:benefit.label,value:usage[0].replace(/^已(?:用|使用)\s*/,"")}]:[];
  });
  if(readings.length)return <>{(provider.membership.cached||provider.error||provider.state==="offline"||provider.state==="unknown")&&<p className="hud-panel-note">上次读取</p>}<div className="hud-quota-grid">{readings.map((row,index)=><section className="hud-quota-card" key={`${row.label}-${index}`}><span className="hud-panel-label">{row.label}</span><strong className="hud-quota-value">{row.value}</strong><span className="hud-quota-caption">已用</span></section>)}</div></>;
 }
 const used=hudQuotaUsed(provider);
 const windows=used===undefined?[]:provider?.usageWindows?.filter(window=>Number.isFinite(window.usedPercent)&&window.usedPercent>=0&&window.usedPercent<=100)??[];
 const rank=(window:{windowDurationMins?:number})=>window.windowDurationMins===300?0:window.windowDurationMins===10080?1:2;
 const rows=windows.length?[...windows].sort((a,b)=>rank(a)-rank(b)):[{id:"summary",title:"剩余额度",usedPercent:used,windowDurationMins:undefined}];
 if(used===undefined)return <div className="hud-panel-empty"><strong>额度未知</strong>{provider?.id==="doubao"&&doubaoReadIssueMessage(provider.membership?.readIssue)&&<p className="hud-panel-note">{doubaoReadIssueMessage(provider.membership?.readIssue)}</p>}</div>;
 return <div className="hud-quota-grid">{rows.map((window,index)=>{
  const remaining=Number((100-window.usedPercent!).toFixed(1));
  const title=provider?.id==="codex"?(window.windowDurationMins===300?"5 小时":window.windowDurationMins===10080?"周额度":usageWindowTitle(window,"codex")):usageWindowTitle(window,provider?.id??"");
  return <section className="hud-quota-card" key={`${window.id}-${index}`}>
   <span className="hud-panel-label">{title}</span>
   <strong className="hud-quota-value" aria-label={`剩余 ${remaining}%`}>{remaining}<small>%</small></strong>
   <span className="hud-quota-caption">剩余</span>
   <div className="hud-detail-track" role="progressbar" aria-label={`${title}剩余额度`} aria-valuetext={`剩余 ${remaining}%，已用 ${Math.round(window.usedPercent!)}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}><i style={{width:`${remaining}%`}}/></div>
  </section>;
 })}</div>;
}

export function HudApiBalances({providers,connections,now}:{providers:ProviderStatus[];connections:ApiConnectionSettings;now:number}){
 const accounts=([
  ["deepseek","DeepSeek",connections.deepseekEnabled],
  ["mimo","MiMo",connections.mimoEnabled],
  ["openai","OpenAI API",connections.openaiEnabled],
  ["anthropic","Anthropic API",connections.anthropicEnabled],
 ] as const).filter(([, ,enabled])=>enabled===true);
 if(!accounts.length)return <div className="hud-panel-empty">未启用账户</div>;
 return <div className="hud-api-accounts">{accounts.flatMap(([id,name])=>{
  const matches=providers.filter(item=>item.id===id||id==="deepseek"&&/^deepseek-(?:cny|usd)$/.test(item.id));
  return (matches.length?matches:[undefined]).map((provider)=>{
  const view=provider?apiMoneyView(provider,now):undefined;
  const balance=view?.balanceScope&&view.primary!=="未知"?view.primary:undefined;
  return <section className="hud-api-account" key={provider?.id??id}><span className="hud-panel-label">{provider?.name??name}</span><strong className="hud-api-balance" aria-label={balance?`余额 ${balance}`:"余额未知"}>{balance?balance.replace(/ [A-Z]{3}$/,""):"—"}</strong></section>;
  });
 })}</div>;
}

export function HudPanelHeading({eyebrow,title,status,onClose}:{eyebrow?:string;title:string;status?:string;onClose:()=>void}){
 return <header className="hud-panel-heading"><div>{eyebrow&&<span className="hud-panel-label">{eyebrow}</span>}<h2>{title}</h2></div>{status&&<span className="hud-panel-status">{status}</span>}<button type="button" className="hud-panel-close" aria-label="收起详情" onClick={onClose}><CloseIcon/></button></header>;
}

export function HudPanelFooter({note,action,onOpen}:{note?:string;action:string;onOpen:()=>void}){
 return <footer className="hud-panel-footer"><span>{note}</span><button type="button" className="hud-panel-action" onClick={onOpen}>{action}<span aria-hidden="true">↗</span></button></footer>;
}

export function HudLogo({id,label,showQuota=false,quotaUsed}:{id:string;label:string;showQuota?:boolean;quotaUsed?:number}){
 const used=typeof quotaUsed==="number"&&Number.isFinite(quotaUsed)&&quotaUsed>=0&&quotaUsed<=100?quotaUsed:undefined;
 const level=used===undefined?"unknown":used>=90?"critical":used>=70?"warning":"ok";
 return <span className={`hud-logo hud-logo-${id}`}><span className="hud-logo-art"><HudArtwork id={id} label={label}/></span><span className="hud-bot-body"/><span className="hud-bot-eyes"><i/><i/></span>{showQuota&&<svg className={`hud-quota-ring quota-${level}`} viewBox="0 0 42 42" aria-hidden="true" data-quota-used={used} data-quota-level={level}><circle className="hud-quota-track" cx="21" cy="21" r="19"/>{used!==undefined&&used>0&&<circle className="hud-quota-fill" cx="21" cy="21" r="19" pathLength="100" strokeDasharray={`${used} 100`} transform="rotate(-90 21 21)"/>}</svg>}</span>;
}
function HudArtwork({id,label}:{id:string;label:string}){
 if(id==="workbench")return <span className="hud-workbench-crop"><AvatarArtwork kind="workbench"/></span>;
 if(id==="daily")return <span className="hud-brand-image hud-daily-avatar"><AvatarArtwork kind="daily"/></span>;
 const utility=utilityMarks[id];
 if(utility)return <img src={utility} alt="" draggable={false} className="hud-app-icon"/>;
 const image=clientMarks[id];
 if(image&&templateMarks.has(id))return <span className="hud-brand-mask" style={{maskImage:`url(${JSON.stringify(image)})`,WebkitMaskImage:`url(${JSON.stringify(image)})`}}/>;
 if(image)return <img src={image} alt="" className="hud-brand-image"/>;
 return <span className="hud-letter-mark">{label.slice(0,1)}</span>;
}

export function HudWorkbenchButton({onOpen,onEnter,expanded=false,busy=false}:{onOpen:()=>void;onEnter:()=>void;expanded?:boolean;busy?:boolean}){
 return <button type="button" className="island-item island-workbench" aria-label="打开工作台" aria-expanded={expanded} disabled={busy} onMouseEnter={onEnter} onFocus={onEnter} onClick={onOpen}><span className="island-symbol" aria-hidden="true"><HudLogo id="workbench" label="工作台"/></span></button>;
}
export function HudMailButton({onOpen,onEnter,expanded=false}:{onOpen:()=>void;onEnter:()=>void;expanded?:boolean}){
 return <button type="button" className={`island-item island-mail${expanded?' is-opened':''}`} aria-label="打开邮箱提醒" aria-expanded={expanded} title="邮箱提醒" onMouseEnter={onEnter} onClick={onOpen}><span className="island-symbol" aria-hidden="true"><HudLogo id="mail" label="邮箱"/></span></button>;
}

/** Reuses the main window's existing hit-region tracking; no native styles change. */
export function StatusHud({monitorId,open,onDrag,onLeave,animations,children,mailEnabled=true,mailOpen=false,onCloseMail,onOpenMailSettings}:{onOpenMailSettings?:()=>void;mailEnabled?:boolean;mailOpen?:boolean;onCloseMail?:()=>void;monitorId:string;open:boolean;onDrag:()=>void;onLeave:()=>void;animations:boolean;children:ReactNode}){
 const [recent,setRecent]=useState(false);
 const [menu,setMenu]=useState<{x:number;y:number}|null>(null),[exitError,setExitError]=useState("");
 const [exitConfirm,setExitConfirm]=useState(false),[exitBusy,setExitBusy]=useState(false),[exitCardHeight,setExitCardHeight]=useState(244);
 const[placement,setPlacement]=useState<HudPlacement>(()=>loadHudPlacement(monitorId)),[size,setSize]=useState({width:660,height:88}),[viewport,setViewport]=useState({width:window.innerWidth,height:window.innerHeight}),[dragging,setDragging]=useState(false),[saveError,setSaveError]=useState(""),[panelHeight,setPanelHeight]=useState(0),[panelWidth,setPanelWidth]=useState(360);
 const root=useRef<HTMLDivElement>(null),gesture=useRef<{id:number;x:number;y:number;started:boolean;original:HudPlacement;grabFraction:number;capture:HTMLElement}|null>(null),skipClick=useRef(false),latest=useRef(placement);latest.current=placement;
 const hoverTimer=useRef<number|undefined>(undefined);
 useEffect(()=>{if(open||menu||dragging)setRecent(false)},[open,Boolean(menu),dragging]);
 const dismiss=useRef(onDrag);dismiss.current=onDrag;
 useEffect(()=>{if(menu)root.current?.querySelector<HTMLButtonElement>(exitConfirm?".hud-exit-confirm button":".hud-context-menu button")?.focus({preventScroll:true});},[Boolean(menu),exitConfirm,exitBusy]);
 useEffect(()=>{if(!exitConfirm)return;const card=root.current?.querySelector<HTMLElement>(".hud-exit-confirm");if(!card)return;const measure=()=>setExitCardHeight(card.offsetHeight);const observer=new ResizeObserver(measure);observer.observe(card);measure();return()=>observer.disconnect();},[exitConfirm]);
 useEffect(()=>()=>{window.clearTimeout(hoverTimer.current)},[]);
 useEffect(()=>{
  if(!open&&!menu&&!recent&&!dragging)return;let active=true,unlisten:(()=>void)|undefined;
  const close=()=>{if(!active||exitBusy)return;setMenu(null);setRecent(false);setExitConfirm(false);setExitError("");window.clearTimeout(hoverTimer.current);const g=gesture.current;gesture.current=null;if(g?.started)setPlacement(g.original);if(g?.capture.hasPointerCapture(g.id))g.capture.releasePointerCapture(g.id);setDragging(false);skipClick.current=false;dismiss.current()};
  const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))close()};
  document.addEventListener("pointerdown",outside,true);window.addEventListener("blur",close);
  // Clipped desktop clicks bypass the DOM. Observe the native window losing focus.
  if(isTauri())void getCurrentWindow().onFocusChanged(({payload})=>{if(!payload)close()}).then(stop=>{if(active)unlisten=stop;else stop()}).catch(()=>console.warn("HUD 原生失焦监听暂不可用"));
  return()=>{active=false;document.removeEventListener("pointerdown",outside,true);window.removeEventListener("blur",close);unlisten?.()};
 },[open,Boolean(menu),exitBusy,recent,dragging]);
 useEffect(()=>{setPlacement(loadHudPlacement(monitorId));setSaveError("")},[monitorId]);
 useEffect(()=>{const element=root.current?.querySelector<HTMLElement>(".status-island");if(!element)return;const measure=()=>setSize({width:element.offsetWidth,height:element.offsetHeight});const observer=new ResizeObserver(measure);observer.observe(element);measure();const resize=()=>setViewport({width:window.innerWidth,height:window.innerHeight});window.addEventListener("resize",resize);return()=>{observer.disconnect();window.removeEventListener("resize",resize)}},[]);
 useEffect(()=>{const measure=()=>{const panels=Array.from(root.current?.querySelectorAll<HTMLElement>(".island-popover")??[]);const panel=panels.find(p=>p.offsetHeight>0);setPanelHeight(panel?.offsetHeight??0);setPanelWidth(panel?.offsetWidth??360)};const observer=new ResizeObserver(measure);const mutation=new MutationObserver(()=>{root.current?.querySelectorAll<HTMLElement>(".island-popover").forEach(p=>observer.observe(p));measure()});if(root.current){observer.observe(root.current);mutation.observe(root.current,{childList:true,subtree:true,attributes:true,attributeFilter:["hidden"]})}measure();return()=>{observer.disconnect();mutation.disconnect()}},[open]);
 const save=(next:HudPlacement)=>{try{saveHudPlacement(monitorId,next);setSaveError("")}catch{setSaveError("当前位置暂时无法保存，重启后会使用默认位置")}};
 const position=hudPosition(placement,size,viewport);
 const panelSpace={
  width:Math.max(0,placement.edge==="left"?viewport.width-position.x-size.width-26:placement.edge==="right"?position.x-26:viewport.width-32),
  height:Math.max(0,placement.edge==="top"?viewport.height-position.y-size.height-26:placement.edge==="bottom"?position.y-26:viewport.height-80),
 };
 const keyEdges:Record<string,HudEdge>={ArrowUp:"top",ArrowDown:"bottom",ArrowLeft:"left",ArrowRight:"right"};
 const cancelMove=()=>{const g=gesture.current;gesture.current=null;if(g?.started){latest.current=g.original;setPlacement(g.original);}if(g?.capture.hasPointerCapture(g.id))g.capture.releasePointerCapture(g.id);setDragging(false);skipClick.current=Boolean(g?.started);};
 return <div ref={root} className={`island-wrap hud-island hud-${placement.edge}${open?" island-open":""}${dragging?" hud-dragging":""}${menu?" hud-has-menu":""}${animations?"":" hud-motion-off"}`} style={{left:position.x,top:position.y,"--hud-panel-available-width":`${panelSpace.width}px`,"--hud-panel-available-height":`${panelSpace.height}px`,"--hud-panel-left":`${Math.max(16-position.x,Math.min((size.width-panelWidth)/2,viewport.width-16-position.x-panelWidth))}px`,"--hud-panel-top":`${Math.min(0,viewport.height-80-position.y-panelHeight)}px`} as CSSProperties} data-main-hit-region tabIndex={0} aria-label="主屏 Hub" onMouseEnter={()=>window.clearTimeout(hoverTimer.current)} onMouseMove={event=>{const eyes=root.current?.querySelector<HTMLElement>(".is-opened .hud-bot-eyes");if(!eyes)return;const bounds=eyes.getBoundingClientRect();eyes.style.setProperty("--hud-look-x",`${Math.max(-2,Math.min(2,(event.clientX-bounds.x-bounds.width/2)/25))}px`);eyes.style.setProperty("--hud-look-y",`${Math.max(-2,Math.min(2,(event.clientY-bounds.y-bounds.height/2)/25))}px`)}} onMouseLeave={()=>{if(!menu&&!gesture.current){window.clearTimeout(hoverTimer.current);hoverTimer.current=window.setTimeout(onLeave,180)}}} onKeyDown={event=>{if(event.target===event.currentTarget&&["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key)&&!exitConfirm&&!exitBusy){event.preventDefault();const next:HudPlacement={edge:keyEdges[event.key],offset:.5};onDrag();latest.current=next;setPlacement(next);save(next);return;}if(event.key==="Escape"&&!exitBusy){cancelMove();setMenu(null);setExitConfirm(false);setExitError("");setRecent(false);onDrag()}}} onContextMenu={event=>{if(exitConfirm||exitBusy){event.preventDefault();return;}if((event.target as HTMLElement).closest(".hud-context-menu")){event.preventDefault();return;}if(event.target!==event.currentTarget&&!(event.target as HTMLElement).closest(".status-island"))return;event.preventDefault();window.clearTimeout(hoverTimer.current);onDrag();setExitError("");setMenu({x:Math.max(8,Math.min(event.clientX,viewport.width-208)),y:Math.max(8,Math.min(event.clientY,viewport.height-168))});}}
 onPointerDown={event=>{skipClick.current=false;if(exitConfirm||exitBusy||event.button!==0||!(event.target as HTMLElement).closest(".status-island"))return;const bounds=root.current!.getBoundingClientRect(),horizontal=latest.current.edge==="top"||latest.current.edge==="bottom",grabFraction=(horizontal?event.clientX-bounds.left:event.clientY-bounds.top)/Math.max(1,horizontal?bounds.width:bounds.height);const capture=(event.target as HTMLElement).closest<HTMLElement>("button")??root.current!;gesture.current={id:event.pointerId,x:event.clientX,y:event.clientY,started:false,original:latest.current,grabFraction,capture};try{capture.setPointerCapture(event.pointerId)}catch{gesture.current=null}}}
 onPointerMove={event=>{const g=gesture.current;if(!g||g.id!==event.pointerId)return;if(!g.started){if(Math.hypot(event.clientX-g.x,event.clientY-g.y)<6)return;g.started=true;skipClick.current=true;setDragging(true);onDrag()}const next=dragHudPlacement({x:event.clientX,y:event.clientY},viewport,latest.current,size,g.grabFraction);latest.current=next;setPlacement(next)}}
 onPointerUp={event=>{const g=gesture.current;if(!g||g.id!==event.pointerId)return;gesture.current=null;if(g.started){save(latest.current);setDragging(false)}if(g.capture.hasPointerCapture(event.pointerId))g.capture.releasePointerCapture(event.pointerId)}}
 onPointerCancel={cancelMove} onLostPointerCapture={event=>{if(gesture.current?.id===event.pointerId)cancelMove();}}
 onClickCapture={event=>{if(skipClick.current){event.preventDefault();event.stopPropagation();skipClick.current=false}}}>
 {children}
 <MailOtpToast animations={animations} onOpenSettings={()=>{setRecent(false);onCloseMail?.();onOpenMailSettings?.()}} enabled={mailEnabled} blocked={open||Boolean(menu)||dragging} recent={recent||mailOpen} onCloseRecent={()=>{setRecent(false);onCloseMail?.()}}/>

 {menu&&!exitConfirm&&<div className="hud-context-menu glass" role="menu" aria-label="HUD 菜单" data-main-hit-region style={{left:Math.max(8,Math.min(menu.x,viewport.width-208)),top:Math.max(8,Math.min(menu.y,viewport.height-168))}} onKeyDown={event=>{if(event.key==="Tab")event.preventDefault();}}><strong>GleamDesk</strong><button type="button" role="menuitem" onClick={()=>{setMenu(null);setRecent(true)}}>最近邮件</button><button type="button" role="menuitem" className="hud-exit-action" onClick={()=>{setExitError("");setExitConfirm(true);}}>退出程序</button></div>}
 {menu&&exitConfirm&&<div className="hud-exit-confirm glass" role="alertdialog" aria-modal="true" aria-label="退出程序确认" aria-describedby="hud-exit-warning" data-main-hit-region style={{left:Math.max(8,Math.min(menu.x,viewport.width-336)),top:Math.max(8,Math.min(menu.y,viewport.height-exitCardHeight-8))}} onKeyDown={event=>{if(event.key!=="Tab")return;event.preventDefault();const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));const index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus();}}>
   <strong>退出 GleamDesk？</strong><p id="hud-exit-warning">请先保存正在编辑的内容。Dock、顶部 HUD 和工作台将一起关闭。</p>
   {exitError&&<p className="hud-exit-error" role="alert">{exitError}</p>}
   <div className="hud-exit-buttons"><button type="button" disabled={exitBusy} onClick={()=>{setExitConfirm(false);setMenu(null);setExitError("");}}>取消</button><button type="button" className="hud-exit-submit" disabled={exitBusy} onClick={()=>{if(exitBusy)return;setExitBusy(true);setExitError("");void requestAppExit(true).then(()=>{setExitConfirm(false);setMenu(null);}).catch(()=>setExitError("退出失败，请重试")).finally(()=>setExitBusy(false));}}>{exitBusy?"正在退出…":"退出程序"}</button></div>
 </div>}
 {saveError&&<p className="hud-save-notice" role="status">{saveError}</p>}
 </div>;
}
