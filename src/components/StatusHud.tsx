import {useEffect,useRef,useState,type ReactNode,type CSSProperties} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {requestAppExit} from "../services/windowVisibility";
import {dragHudPlacement,hudPosition,loadHudPlacement,saveHudPlacement,type HudPlacement,type HudEdge} from "../providers/layoutStore";
import codexMark from "../assets/hud/chatgpt.png";
import claudeMark from "../assets/hud/claude.png";
import antigravityMark from "../assets/hud/antigravity.png";
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
import {hudQuotaUsed} from "../presentation/quotaAdapter";
import {usageWindowTitle} from "./AIControlCenter";
import type {ProviderStatus} from "../types";

const clientMarks:Record<string,string>={codex:codexMark,claude:claudeMark,antigravity:antigravityMark,ollama:ollamaMark,doubao:doubaoMark,gemini:geminiMark,cursor:cursorMark,windsurf:windsurfMark,trae:traeMark,copilot:copilotMark,qwen:qwenMark,opencode:opencodeMark,kimi:kimiMark,pi:piMark,hermes:hermesMark,openclaw:openclawMark,codebuddy:codebuddyMark,workbuddy:workbuddyMark,qoder:qoderMark,zcode:zcodeMark,"deepseek-harness":deepseekMark,goose:gooseMark};
const templateMarks=new Set(["codex","cursor","windsurf","copilot","kimi","pi","hermes","zcode","goose","ollama"]);

export function HudQuotaDetails({provider}:{provider?:ProviderStatus}){
 const used=hudQuotaUsed(provider);
 const windows=used===undefined?[]:provider?.usageWindows?.filter(window=>Number.isFinite(window.usedPercent)&&window.usedPercent>=0&&window.usedPercent<=100)??[];
 const rows=windows.length?windows:[{id:"summary",title:provider?.name??"额度",usedPercent:used}];
 if(used===undefined)return <p className="hud-source-note">额度未知</p>;
 return <>{rows.map((window,index)=><div className="popover-row hud-window-row" key={`${window.id}-${index}`}><span>{usageWindowTitle(window,provider?.id??"")}</span><strong>{window.usedPercent===undefined?"—":`已用 ${Math.round(window.usedPercent)}%`}</strong>{window.usedPercent!==undefined&&<><small className="hud-window-remaining">剩余 {Number((100-window.usedPercent).toFixed(1))}%</small><div className="micro-track"><i style={{width:`${window.usedPercent}%`}}/></div></>}</div>)}</>;
}

export function HudLogo({id,label,showQuota=false,quotaUsed}:{id:string;label:string;showQuota?:boolean;quotaUsed?:number}){
 const used=typeof quotaUsed==="number"&&Number.isFinite(quotaUsed)&&quotaUsed>=0&&quotaUsed<=100?quotaUsed:undefined;
 const level=used===undefined?"unknown":used>=90?"critical":used>=70?"warning":"ok";
 return <span className={`hud-logo hud-logo-${id}`}><span className="hud-logo-art"><HudArtwork id={id} label={label}/></span><span className="hud-bot-body"/><span className="hud-bot-eyes"><i/><i/></span>{showQuota&&<svg className={`hud-quota-ring quota-${level}`} viewBox="0 0 42 42" aria-hidden="true" data-quota-used={used} data-quota-level={level}><circle className="hud-quota-track" cx="21" cy="21" r="19"/>{used!==undefined&&used>0&&<circle className="hud-quota-fill" cx="21" cy="21" r="19" pathLength="100" strokeDasharray={`${used} 100`} transform="rotate(-90 21 21)"/>}</svg>}</span>;
}
function HudArtwork({id,label}:{id:string;label:string}){
 if(id==="workbench")return <span className="hud-workbench-crop"><AvatarArtwork kind="workbench"/></span>;
 if(id==="daily")return <span className="hud-brand-image hud-daily-avatar"><AvatarArtwork kind="daily"/></span>;
 const image=clientMarks[id];
 if(image&&templateMarks.has(id))return <span className="hud-brand-mask" style={{maskImage:`url(${JSON.stringify(image)})`,WebkitMaskImage:`url(${JSON.stringify(image)})`}}/>;
 if(image)return <img src={image} alt="" className="hud-brand-image"/>;
 if(id==="vps"||id==="pc")return <svg className="hud-device-avatar" viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="24" cy="24" r="23" fill={id==="vps"?"#283b4a":"#443046"}/>{id==="vps"?<g stroke="#bbdcf0" strokeWidth="2.2" strokeLinecap="round"><rect x="12" y="11" width="24" height="12" rx="4"/><rect x="12" y="26" width="24" height="12" rx="4"/><path d="M18 17h.01M18 32h.01M25 17h5M25 32h5"/></g>:<g stroke="#f2c0d7" strokeWidth="2.2" strokeLinecap="round"><rect x="10" y="12" width="28" height="21" rx="4"/><path d="M18 39h12M24 33v6M17 22h.01M31 22h.01M20 27q4 3 8 0"/></g>}</svg>;
 if(id==="api")return <span className="hud-api-mark">API</span>;
 return <span className="hud-letter-mark">{label.slice(0,1)}</span>;
}

export function HudWorkbenchButton({onOpen,onEnter,expanded=false,busy=false}:{onOpen:()=>void;onEnter:()=>void;expanded?:boolean;busy?:boolean}){
 return <button type="button" className="island-item island-workbench" aria-label="打开工作台" aria-expanded={expanded} disabled={busy} onMouseEnter={onEnter} onFocus={onEnter} onClick={onOpen}><span className="island-symbol" aria-hidden="true"><HudLogo id="workbench" label="工作台"/></span></button>;
}

/** Reuses the main window's existing hit-region tracking; no native styles change. */
export function StatusHud({monitorId,open,onDrag,onLeave,animations,children}:{monitorId:string;open:boolean;onDrag:()=>void;onLeave:()=>void;animations:boolean;children:ReactNode}){
 const [menu,setMenu]=useState<{x:number;y:number}|null>(null),[exitError,setExitError]=useState("");
 const [exitConfirm,setExitConfirm]=useState(false),[exitBusy,setExitBusy]=useState(false),[exitCardHeight,setExitCardHeight]=useState(244);
 const[placement,setPlacement]=useState<HudPlacement>(()=>loadHudPlacement(monitorId)),[size,setSize]=useState({width:660,height:88}),[viewport,setViewport]=useState({width:window.innerWidth,height:window.innerHeight}),[dragging,setDragging]=useState(false),[saveError,setSaveError]=useState(""),[panelHeight,setPanelHeight]=useState(0),[panelWidth,setPanelWidth]=useState(360);
 const root=useRef<HTMLDivElement>(null),gesture=useRef<{id:number;x:number;y:number;started:boolean;original:HudPlacement;grabFraction:number;capture:HTMLElement}|null>(null),skipClick=useRef(false),latest=useRef(placement);latest.current=placement;
 const hoverTimer=useRef<number|undefined>(undefined);
 const dismiss=useRef(onDrag);dismiss.current=onDrag;
 useEffect(()=>{if(menu)root.current?.querySelector<HTMLButtonElement>(exitConfirm?".hud-exit-confirm button":".hud-context-menu button")?.focus({preventScroll:true});},[Boolean(menu),exitConfirm,exitBusy]);
 useEffect(()=>{if(!exitConfirm)return;const card=root.current?.querySelector<HTMLElement>(".hud-exit-confirm");if(!card)return;const measure=()=>setExitCardHeight(card.offsetHeight);const observer=new ResizeObserver(measure);observer.observe(card);measure();return()=>observer.disconnect();},[exitConfirm]);
 useEffect(()=>()=>{window.clearTimeout(hoverTimer.current)},[]);
 useEffect(()=>{
  if(!open&&!menu)return;let active=true,unlisten:(()=>void)|undefined;
  const close=()=>{if(!active||exitBusy)return;setMenu(null);setExitConfirm(false);setExitError("");window.clearTimeout(hoverTimer.current);const g=gesture.current;gesture.current=null;if(g?.started)setPlacement(g.original);if(g?.capture.hasPointerCapture(g.id))g.capture.releasePointerCapture(g.id);setDragging(false);skipClick.current=false;dismiss.current()};
  const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))close()};
  document.addEventListener("pointerdown",outside,true);window.addEventListener("blur",close);
  // Clipped desktop clicks bypass the DOM. Observe the native window losing focus.
  if(isTauri())void getCurrentWindow().onFocusChanged(({payload})=>{if(!payload)close()}).then(stop=>{if(active)unlisten=stop;else stop()}).catch(()=>console.warn("HUD 原生失焦监听暂不可用"));
  return()=>{active=false;document.removeEventListener("pointerdown",outside,true);window.removeEventListener("blur",close);unlisten?.()};
 },[open,Boolean(menu),exitBusy]);
 useEffect(()=>{setPlacement(loadHudPlacement(monitorId));setSaveError("")},[monitorId]);
 useEffect(()=>{const element=root.current?.querySelector<HTMLElement>(".status-island");if(!element)return;const measure=()=>setSize({width:element.offsetWidth,height:element.offsetHeight});const observer=new ResizeObserver(measure);observer.observe(element);measure();const resize=()=>setViewport({width:window.innerWidth,height:window.innerHeight});window.addEventListener("resize",resize);return()=>{observer.disconnect();window.removeEventListener("resize",resize)}},[]);
 useEffect(()=>{const panel=root.current?.querySelector<HTMLElement>(".island-popover");if(!panel)return;const measure=()=>{setPanelHeight(panel.offsetHeight);setPanelWidth(panel.offsetWidth)};const observer=new ResizeObserver(measure);observer.observe(panel);measure();return()=>observer.disconnect()},[open]);
 const save=(next:HudPlacement)=>{try{saveHudPlacement(monitorId,next);setSaveError("")}catch{setSaveError("当前位置暂时无法保存，重启后会使用默认位置")}};
 const position=hudPosition(placement,size,viewport);
 const keyEdges:Record<string,HudEdge>={ArrowUp:"top",ArrowDown:"bottom",ArrowLeft:"left",ArrowRight:"right"};
 return <div ref={root} className={`island-wrap hud-island hud-${placement.edge}${open?" island-open":""}${dragging?" hud-dragging":""}${menu?" hud-has-menu":""}${animations?"":" hud-motion-off"}`} style={{left:position.x,top:position.y,"--hud-panel-left":`${Math.max(16-position.x,Math.min(size.width-panelWidth,viewport.width-16-position.x-panelWidth))}px`,"--hud-panel-top":`${Math.min(0,viewport.height-80-position.y-panelHeight)}px`} as CSSProperties} data-main-hit-region onMouseEnter={()=>window.clearTimeout(hoverTimer.current)} onMouseMove={event=>{const eyes=root.current?.querySelector<HTMLElement>(".is-opened .hud-bot-eyes");if(!eyes)return;const bounds=eyes.getBoundingClientRect();eyes.style.setProperty("--hud-look-x",`${Math.max(-2,Math.min(2,(event.clientX-bounds.x-bounds.width/2)/25))}px`);eyes.style.setProperty("--hud-look-y",`${Math.max(-2,Math.min(2,(event.clientY-bounds.y-bounds.height/2)/25))}px`)}} onMouseLeave={()=>{if(!menu&&!gesture.current){window.clearTimeout(hoverTimer.current);hoverTimer.current=window.setTimeout(onLeave,180)}}} onKeyDown={event=>{if(event.key==="Escape"&&!exitBusy){setMenu(null);setExitConfirm(false);setExitError("");onDrag()}}} onContextMenu={event=>{if(exitConfirm||exitBusy){event.preventDefault();return;}if((event.target as HTMLElement).closest(".hud-context-menu")){event.preventDefault();return;}if(event.target!==event.currentTarget&&!(event.target as HTMLElement).closest(".status-island,.hud-grip"))return;event.preventDefault();window.clearTimeout(hoverTimer.current);onDrag();setExitError("");setMenu({x:Math.max(8,Math.min(event.clientX,viewport.width-208)),y:Math.max(8,Math.min(event.clientY,viewport.height-124))});}}
 onPointerDown={event=>{if(exitConfirm||exitBusy||event.button!==0||!(event.target as HTMLElement).closest(".status-island,.hud-grip"))return;const bounds=root.current!.getBoundingClientRect(),horizontal=latest.current.edge==="top"||latest.current.edge==="bottom",grabFraction=(horizontal?event.clientX-bounds.left:event.clientY-bounds.top)/Math.max(1,horizontal?bounds.width:bounds.height);const capture=(event.target as HTMLElement).closest<HTMLElement>("button")??root.current!;gesture.current={id:event.pointerId,x:event.clientX,y:event.clientY,started:false,original:latest.current,grabFraction,capture};capture.setPointerCapture(event.pointerId)}}
 onPointerMove={event=>{const g=gesture.current;if(!g||g.id!==event.pointerId)return;if(!g.started){if(Math.hypot(event.clientX-g.x,event.clientY-g.y)<6)return;g.started=true;skipClick.current=true;setDragging(true);onDrag()}setPlacement(dragHudPlacement({x:event.clientX,y:event.clientY},viewport,latest.current,size,g.grabFraction))}}
 onPointerUp={event=>{const g=gesture.current;if(!g||g.id!==event.pointerId)return;gesture.current=null;if(g.started){save(latest.current);setDragging(false)}if(g.capture.hasPointerCapture(event.pointerId))g.capture.releasePointerCapture(event.pointerId)}}
 onPointerCancel={()=>{const g=gesture.current;gesture.current=null;if(g?.started)setPlacement(g.original);setDragging(false);skipClick.current=false}}
 onClickCapture={event=>{if(skipClick.current){event.preventDefault();event.stopPropagation();skipClick.current=false}}}>
 {children}
 <button className="hud-grip" disabled={exitConfirm||exitBusy} aria-label="移动主屏状态面板" title="拖到屏幕四边；右键打开菜单" onKeyDown={event=>{const edge=keyEdges[event.key];if(!edge)return;event.preventDefault();onDrag();const next={edge,offset:.5};setPlacement(next);save(next)}}>⠿</button>
 {menu&&!exitConfirm&&<div className="hud-context-menu glass" role="menu" aria-label="HUD 菜单" data-main-hit-region style={{left:Math.max(8,Math.min(menu.x,viewport.width-208)),top:Math.max(8,Math.min(menu.y,viewport.height-124))}} onKeyDown={event=>{if(event.key==="Tab")event.preventDefault();}}><strong>Agent Room</strong><button type="button" role="menuitem" className="hud-exit-action" onClick={()=>{setExitError("");setExitConfirm(true);}}>退出程序</button></div>}
 {menu&&exitConfirm&&<div className="hud-exit-confirm glass" role="alertdialog" aria-modal="true" aria-label="退出程序确认" aria-describedby="hud-exit-warning" data-main-hit-region style={{left:Math.max(8,Math.min(menu.x,viewport.width-336)),top:Math.max(8,Math.min(menu.y,viewport.height-exitCardHeight-8))}} onKeyDown={event=>{if(event.key!=="Tab")return;event.preventDefault();const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));const index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus();}}>
   <strong>退出 Agent Room？</strong><p id="hud-exit-warning">请先保存正在编辑的内容。Dock、顶部 HUD 和工作台将一起关闭。</p>
   {exitError&&<p className="hud-exit-error" role="alert">{exitError}</p>}
   <div className="hud-exit-buttons"><button type="button" disabled={exitBusy} onClick={()=>{setExitConfirm(false);setMenu(null);setExitError("");}}>取消</button><button type="button" className="hud-exit-submit" disabled={exitBusy} onClick={()=>{if(exitBusy)return;setExitBusy(true);setExitError("");void requestAppExit(true).then(()=>{setExitConfirm(false);setMenu(null);}).catch(()=>setExitError("退出失败，请重试")).finally(()=>setExitBusy(false));}}>{exitBusy?"正在退出…":"退出程序"}</button></div>
 </div>}
 {saveError&&<p className="hud-save-notice" role="status">{saveError}</p>}
 </div>;
}
