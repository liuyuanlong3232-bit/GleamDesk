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

const iconRefreshMarker="codex-desktop.native-icons.v9";
function legacyIconPath(application:ApplicationItem):string|undefined{
  if(application.iconSource==="custom")return undefined;
  const path=application.sourcePath||application.target;
  return /^[A-Za-z]:[\\/]/.test(path)&&!path.startsWith("\\\\")?path:undefined;
}

export function DockWindow() {
  useEffect(startNativeWindowVisibility,[]);
  useEffect(startDockWindowHitRegionTracking,[]);
  const [applications, updateApplications] = useApplications(error => setMessage(error));
  const updateApplicationsRef=useRef(updateApplications);updateApplicationsRef.current=updateApplications;
  const iconRefreshStarted=useRef(false);
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
