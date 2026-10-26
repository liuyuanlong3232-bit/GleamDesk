import {applyTheme} from "../presentation/theme";
import {startNativeWindowVisibility} from "../services/windowVisibility";
import { useCallback, useEffect, useRef, useState } from "react";
import {RoomPortrait} from "./RoomPortrait";
import {applicationFromUrl,applicationsFromPaths,mergeDroppedApplications} from "../services/launcher/dockIngress";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { logEvent } from "../services/appLogger";
import { ApplicationDock } from "./ApplicationDock";
import { useApplications } from "../services/useApplications";
import { loadSettings } from "../providers/settingsStore";
import { startDockWindowHitRegionTracking } from "../tauri";
import { launchApplication } from "../services/launcher/launcherService";
import type { ApplicationItem } from "../types";

export function dockWindowSize(count:number,expanded:boolean,menuOpen:boolean,messageOpen=false) {
  const open=expanded||menuOpen;return {width:open?Math.max(240,Math.min(2400,Math.max(0,count)*68+32)):64,height:menuOpen?450:messageOpen?120:open?72:64};
}

const iconRefreshMarker="codex-desktop.native-icons.v8";
function isSmallPng(icon:string):boolean{
  const payload=icon.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)/)?.[1];
  if(!payload||payload.length<32)return false;
  try{
    const bytes=atob(payload.slice(0,32));
    if(bytes.length<24)return false;
    const dimension=(offset:number)=>((bytes.charCodeAt(offset)<<24)|(bytes.charCodeAt(offset+1)<<16)|(bytes.charCodeAt(offset+2)<<8)|bytes.charCodeAt(offset+3))>>>0;
    const width=dimension(16),height=dimension(20);
    return width>0&&height>0&&width<=64&&height<=64;
  }catch{return false;}
}
function legacyIconPath(application:ApplicationItem):string|undefined{
  if(application.iconSource==="custom"||!isSmallPng(application.icon))return undefined;
  const path=application.sourcePath||application.target;
  return /^[A-Za-z]:[\\/]/.test(path)&&!path.startsWith("\\\\")?path:undefined;
}

async function cropTransparentPng(icon:string):Promise<string>{
  if(!icon.startsWith("data:image/png;base64,"))return icon;
  const image=new Image();image.src=icon;await image.decode();
  const source=document.createElement("canvas");source.width=image.naturalWidth;source.height=image.naturalHeight;
  const sourceContext=source.getContext("2d",{willReadFrequently:true});if(!sourceContext)return icon;
  sourceContext.drawImage(image,0,0);
  const {data}=sourceContext.getImageData(0,0,source.width,source.height);
  let left=source.width,top=source.height,right=-1,bottom=-1;
  for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++)if(data[(y*source.width+x)*4+3]>12){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
  if(right<left||bottom<top)return icon;
  const contentWidth=right-left+1,contentHeight=bottom-top+1;
  if(contentWidth>=source.width*0.75&&contentHeight>=source.height*0.75)return icon;
  const padding=Math.max(1,Math.round(Math.min(contentWidth,contentHeight)*0.02));
  const x=Math.max(0,left-padding),y=Math.max(0,top-padding);
  const width=Math.min(source.width-x,contentWidth+padding*2),height=Math.min(source.height-y,contentHeight+padding*2);
  const cropped=document.createElement("canvas");cropped.width=width;cropped.height=height;
  const croppedContext=cropped.getContext("2d");if(!croppedContext)return icon;
  croppedContext.drawImage(image,x,y,width,height,0,0,width,height);
  return cropped.toDataURL("image/png");
}

export function DockWindow() {
  useEffect(startNativeWindowVisibility,[]);
  useEffect(startDockWindowHitRegionTracking,[]);
  const [applications, updateApplications] = useApplications(error => setMessage(error));
  const updateApplicationsRef=useRef(updateApplications);updateApplicationsRef.current=updateApplications;
  const iconRefreshStarted=useRef(false);
  const iconCropStarted=useRef(false);
  const [settings, setSettings] = useState(loadSettings);
  const [menuOpen, setMenuOpen] = useState(false);
  const [message, setMessage] = useState("");
  const count = applications.filter(app => app.pinned).length;
  useEffect(()=>{
    if(!isTauri()||iconRefreshStarted.current||localStorage.getItem(iconRefreshMarker)==="done")return;
    const candidates=applications.flatMap(application=>{const path=legacyIconPath(application);return path?[{id:application.id,path}]:[];});
    if(!candidates.length)return;
    iconRefreshStarted.current=true;
    void (async()=>{
      const refreshed=new Map<string,string>();let complete=true;
      for(let index=0;index<candidates.length;index+=16){
        try{
          const entries=await applicationsFromPaths(candidates.slice(index,index+16).map(entry=>entry.path));
          for(const entry of entries)if(entry.icon&&entry.sourcePath)refreshed.set(entry.sourcePath.toLowerCase(),entry.icon);
        }catch(error){complete=false;const reason=error instanceof Error?error.message:String(error);logEvent("warn","dock.icon_refresh_failed",{reason:reason.slice(0,160)});}
      }
      if(refreshed.size)await updateApplicationsRef.current(current=>current.map(application=>{
        if(application.iconSource==="custom")return application;
        const path=(application.sourcePath||application.target).toLowerCase(),icon=refreshed.get(path);
        return icon?{...application,icon,iconSource:"system"}:application;
      }));
      if(refreshed.size)logEvent("info","dock.icon_refresh_succeeded",{count:refreshed.size});else if(complete)logEvent("warn","dock.icon_refresh_empty",{candidateCount:candidates.length});
      if(complete)localStorage.setItem(iconRefreshMarker,"done");
    })().catch(error=>setMessage(error instanceof Error?error.message:"应用配置保存失败"));
  },[applications]);
  useEffect(()=>{
    if(!isTauri()||iconCropStarted.current)return;
    const candidate=applications.find(app=>app.name==="AI Chart 智能技术图表终端"&&app.iconSource==="system"&&app.icon.startsWith("data:image/png;base64,"));
    if(!candidate)return;
    iconCropStarted.current=true;
    void cropTransparentPng(candidate.icon).then(async icon=>{
      if(icon===candidate.icon)return;
      await updateApplicationsRef.current(current=>current.map(app=>app.id===candidate.id&&app.icon===candidate.icon?{...app,icon}:app));
      logEvent("info","dock.icon_transparent_padding_cropped",{application:candidate.name});
    }).catch(error=>{setMessage(error instanceof Error?error.message:"应用配置保存失败");logEvent("warn","dock.icon_crop_failed",{reason:"icon_crop_or_config_save_failed"});});
  },[applications]);
  const [expanded,setExpanded]=useState(false),[interacting,setInteracting]=useState(false);
  const [dockExpandedReady,setDockExpandedReady]=useState(false);
  const wasExpanded=useRef(false);
  const root=useRef<HTMLElement>(null),openTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),closeTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const hold=useRef(false);hold.current=menuOpen||interacting||Boolean(message);
  const clearTimers=useCallback(()=>{clearTimeout(openTimer.current);clearTimeout(closeTimer.current);},[]);
  const expand=useCallback(()=>{clearTimers();setExpanded(true);},[clearTimers]);
  const collapseLater=useCallback(()=>{clearTimers();closeTimer.current=setTimeout(()=>{if(!hold.current&&!root.current?.matches(":hover"))setExpanded(false);},550);},[clearTimers]);
  const activity=useCallback((active:boolean)=>{setInteracting(active);if(active)expand();else collapseLater();},[expand,collapseLater]);
  const showApps=expanded||menuOpen||interacting||Boolean(message);
  useEffect(()=>{const blur=()=>{clearTimers();if(!hold.current)setExpanded(false);};window.addEventListener("blur",blur);return()=>{clearTimers();window.removeEventListener("blur",blur);};},[clearTimers]);
  useEffect(()=>{if(menuOpen||interacting||message)expand();else collapseLater();},[menuOpen,interacting,message,expand,collapseLater]);

  const openDashboardAt = (target: string) => {
    localStorage.setItem("codex-desktop.dashboard-intent.v1", JSON.stringify({ target, timestamp: Date.now() }));
    void invoke("open_dashboard").catch(() => setMessage("无法打开控制台"));
  };
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === "codex-desktop.settings.v1") setSettings(loadSettings()); };
    const localAi = (event: Event) => openDashboardAt("local-ai:" + (event as CustomEvent<{ id: string }>).detail.id);
    window.addEventListener("storage", changed);
    window.addEventListener("codex-desktop.local-ai-request", localAi);
    return () => { window.removeEventListener("storage", changed); window.removeEventListener("codex-desktop.local-ai-request", localAi); };
  }, []);
  useEffect(() => {
    let cancelled=false;
    if(showApps){
      const opening=!wasExpanded.current;
      wasExpanded.current=true;
      if(opening)setDockExpandedReady(false);
      const reveal=opening||!dockExpandedReady;
      void invoke("position_dock_window",dockWindowSize(count,true,menuOpen,Boolean(message))).then(()=>{
        if(reveal)requestAnimationFrame(()=>{if(!cancelled)setDockExpandedReady(true);});
      }).catch(()=>setMessage("Dock 位置调整失败"));
    }else{
      const closing=wasExpanded.current;
      wasExpanded.current=false;
      setDockExpandedReady(false);
      if(!closing){
        void invoke("position_dock_window",dockWindowSize(count,false,false)).catch(()=>setMessage("Dock 位置调整失败"));
        return()=>{cancelled=true;};
      }
      const timer=window.setTimeout(()=>{
        void invoke("position_dock_window",dockWindowSize(count,false,false)).catch(()=>setMessage("Dock 位置调整失败"));
      },240);
      return()=>{cancelled=true;window.clearTimeout(timer);};
    }
    return()=>{cancelled=true;};
  }, [count, showApps, menuOpen, dockExpandedReady, message]);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--glass-alpha", String(settings.opacity / 100));
    root.style.setProperty("--glass-blur", settings.blur + "px");
    applyTheme(root,settings.theme);
    root.style.setProperty("--glass-border-opacity", String(settings.glassBorderOpacity / 100));
    root.style.setProperty("--glass-shadow-strength", String(settings.glassShadowStrength / 100));
    root.classList.toggle("reduce-motion", !settings.animations);
  }, [settings]);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 4500);
    return () => window.clearTimeout(timer);
  }, [message]);
  const launch = async (application: ApplicationItem) => {
    if (!application.target.trim()) { openDashboardAt("settings"); return; }
    try { await launchApplication(application); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  return <main ref={root} className={`dock-surface main-screen ${showApps?"is-expanded":"is-collapsed"}${showApps&&dockExpandedReady?" is-ready":""}`} aria-label="桌面 Dock"
    onPointerEnter={()=>{clearTimers();openTimer.current=setTimeout(expand,220);}}
    onPointerMove={()=>clearTimeout(closeTimer.current)} onPointerLeave={collapseLater}
    onFocus={expand} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))collapseLater();}}
    onKeyDown={event=>{if(event.key==="Escape"&&!hold.current){clearTimers();setExpanded(false);}}}
    onDragOver={event=>{event.preventDefault();expand();}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))collapseLater();}}
    onDrop={async event=>{if(event.defaultPrevented)return;const value=event.dataTransfer.getData("text/uri-list")||event.dataTransfer.getData("text/plain");if(!value)return;event.preventDefault();expand();try{await updateApplications(current=>mergeDroppedApplications(current,[applicationFromUrl(value)]));setMessage("网址已添加");}catch(error){setMessage(error instanceof Error?error.message:"拖入内容无效");}}}>
    <button className="dock-pill glass" aria-label="展开应用启动栏" title="展开应用启动栏" aria-expanded={showApps} data-dock-hit-region="" aria-hidden={showApps} tabIndex={showApps?-1:0} inert={showApps} onPointerDown={event=>{if(event.button===2){event.preventDefault();clearTimers();}}} onClick={expand} onContextMenu={event=>{event.preventDefault();clearTimers();}}><RoomPortrait id="你"/></button>
    <section className="widget-card dock-card quick-launch-preview" data-dock-hit-region="" aria-label="快捷启动" aria-hidden={!showApps} inert={!showApps}>

    <ApplicationDock presentation="quick-launch" applications={applications} onApplicationsChange={updateApplications} onLaunch={app => void launch(app)} onManage={() => openDashboardAt("settings")} onAvatar={()=>openDashboardAt("profile-avatar")} onMenuVisibilityChange={setMenuOpen} onActivityChange={activity} statusVisible={showApps} />
    </section>
    {message && <div className="dock-window-message glass" role="status" data-dock-hit-region="">{message}</div>}
  </main>;
}
