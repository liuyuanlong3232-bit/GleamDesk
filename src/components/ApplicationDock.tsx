import { useEffect, useRef, useState, type CSSProperties } from "react";
import {useApplicationStatus} from "../services/launcher/useApplicationStatus";
import {confirmedRunning} from "../services/launcher/applicationStatus";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logEvent } from "../services/appLogger";
import type { ApplicationItem } from "../types";
import { dockMagnification } from "../services/launcher/dockMagnification";
import { readApplicationIcon } from "../services/iconStore";
import { revealApplication } from "../services/launcher/launcherService";
import { applicationFromUrl, applicationsFromPaths, mergeDroppedApplications, reorderDockApplications } from "../services/launcher/dockIngress";

interface ApplicationDockProps {
  applications: ApplicationItem[];
  presentation?: "shelf" | "quick-launch";
  onLaunch: (application: ApplicationItem) => void;
  onManage: () => void;
  onAvatar?: () => void;
  onMenuVisibilityChange?: (open: boolean) => void;
  onActivityChange?: (active:boolean) => void;
  statusVisible?: boolean;
  onApplicationsChange: (next: ApplicationItem[] | ((current: ApplicationItem[]) => ApplicationItem[])) => void | Promise<void>;
}

export function ApplicationDock({ applications, presentation = "shelf", onLaunch, onManage, onAvatar, onApplicationsChange, onMenuVisibilityChange, onActivityChange, statusVisible=true }: ApplicationDockProps) {
  const statuses=useApplicationStatus(applications,statusVisible);
  const [menu, setMenu] = useState<{ id: string | null } | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [iconTarget, setIconTarget] = useState<string | null>(null);
  const dock = useRef<HTMLDivElement>(null);
  const iconInput = useRef<HTMLInputElement>(null);
  const [dragOver,setDragOver] = useState(false);
  const [dropMessage,setDropMessage] = useState("");
  const [busy,setBusy] = useState(false);
  const [sorting,setSorting]=useState(false);
  const [dragHint,setDragHint]=useState<{id:string;target:string}|null>(null);
  const incoming = useRef(false);
  const magnificationFrame = useRef<number | null>(null);
  const pointerPosition = useRef<number | null>(null);
  const updateRef = useRef(onApplicationsChange);
  const pointerDrag = useRef<{id:string;startX:number;startY:number;active:boolean;target:string;pointerId:number}|null>(null);
  const suppressClick = useRef(false);
  updateRef.current=onApplicationsChange;
  const item = menu?.id ? applications.find((application) => application.id === menu.id) : undefined;
  const pinnedApps = applications.filter((application) => application.pinned).sort((left, right) => left.order - right.order);
  const persist = async (next: Parameters<typeof onApplicationsChange>[0]) => {
    try { await onApplicationsChange(next); }
    catch (error) { setDropMessage(error instanceof Error ? error.message : "应用配置保存失败，未保存本次更改。"); }
  };

  useEffect(()=>{
    if(!isTauri())return;
    let active=true,unlisten:(()=>void)|undefined;
    void getCurrentWebview().onDragDropEvent(async event=>{
      const payload=event.payload;
      if(payload.type==="leave"){if(active)setDragOver(false);return;}
      // Tauri emits these events only while the OS drag is over this webview.
      // The quick-launch window shrinks to a 64px avatar, so its hidden card's
      // DOM bounds cannot reliably decide whether a native drop belongs here.
      const surface=presentation==="quick-launch"?(dock.current?.closest(".dock-surface")??dock.current):dock.current;
      const rect=surface?.getBoundingClientRect();
      const x=payload.position.x/window.devicePixelRatio,y=payload.position.y/window.devicePixelRatio;
      const inside=presentation==="quick-launch"||Boolean(rect&&x>=rect.left&&x<=rect.right&&y>=rect.top&&y<=rect.bottom);
      if(active)setDragOver(inside);
      if(payload.type!=="drop"||!inside||!active||incoming.current)return;
      incoming.current=true;setBusy(true);setDragOver(false);
      try{const apps=payload.paths.every(path=>/^https?:\/\//i.test(path))?payload.paths.map(applicationFromUrl):await applicationsFromPaths(payload.paths);if(active){await updateRef.current(current=>mergeDroppedApplications(current,apps));if(active)setDropMessage(`已添加 ${apps.length} 个入口`);}}
      catch(error){if(active)setDropMessage(error instanceof Error?error.message:typeof error==="string"?error:"无法解析拖入文件");}
      finally{incoming.current=false;if(active)setBusy(false);}
    }).then(stop=>{if(active)unlisten=stop;else stop();}).catch(()=>{if(active)setDropMessage("原生文件拖入监听不可用");});
    return()=>{active=false;unlisten?.();};
  },[presentation]);
  useEffect(()=>{if(!dropMessage)return;const timer=window.setTimeout(()=>setDropMessage(""),4500);return()=>window.clearTimeout(timer);},[dropMessage]);

  useEffect(() => {
    const clearDropHint = () => setDragOver(false);
    const cancelDrop = (event: KeyboardEvent) => { if (event.key === "Escape") clearDropHint(); };
    window.addEventListener("dragend", clearDropHint);
    window.addEventListener("drop", clearDropHint);
    window.addEventListener("blur", clearDropHint);
    window.addEventListener("keydown", cancelDrop);
    return () => {
      window.removeEventListener("dragend", clearDropHint);
      window.removeEventListener("drop", clearDropHint);
      window.removeEventListener("blur", clearDropHint);
      window.removeEventListener("keydown", cancelDrop);
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    let active=true,unlisten:(()=>void)|undefined,nativeMenuRequested=false;
    const close = () => {if(active)setMenu(null);};
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", close, { once: true });
    document.addEventListener("keydown", keydown);
    window.addEventListener("blur", close);
    if(isTauri())void (async()=>{
      const stop=await getCurrentWindow().onFocusChanged(({payload})=>{if(!payload)close();});
      if(!active){stop();return;}unlisten=stop;
      if(presentation==="quick-launch"){
        nativeMenuRequested=true;
        await invoke("set_dock_menu_open",{open:true});
      }
    })().catch(()=>{if(active){close();setDropMessage("Dock 菜单激活失败，请重试");}});
    return () => {
      active=false;unlisten?.();
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("blur", close);
      if(nativeMenuRequested)void invoke("set_dock_menu_open",{open:false}).catch(()=>logEvent("warn","dock.menu_focus_restore_failed"));
    };
  }, [Boolean(menu),presentation]);

  useEffect(() => {
    if (!menu) { setMenuPos(null); return; }
    const place = () => {
      const width = menuRef.current?.offsetWidth || 188;
      const anchor = menu.id ? dock.current?.querySelector<HTMLElement>(`[data-dock-id="${CSS.escape(menu.id)}"]`) : null;
      const rect = anchor?.getBoundingClientRect();
      const viewportWidth = window.innerWidth, viewportHeight = window.innerHeight;
      const centerX = rect ? rect.left + rect.width / 2 : viewportWidth / 2;
      const top = rect ? rect.top : viewportHeight - 72;
      setMenuPos({
        left: Math.min(Math.max(8, centerX - width / 2), Math.max(8, viewportWidth - width - 8)),
        bottom: Math.max(8, viewportHeight - top + 8),
      });
    };
    place();
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", place); };
  }, [menu]);

  useEffect(() => { onMenuVisibilityChange?.(Boolean(menu)); }, [menu, onMenuVisibilityChange]);
  useEffect(()=>{onActivityChange?.(busy||dragOver||sorting||Boolean(dropMessage));},[busy,dragOver,sorting,dropMessage,onActivityChange]);

  useEffect(() => () => { if (magnificationFrame.current !== null) cancelAnimationFrame(magnificationFrame.current); }, []);
  const magnify = (clientX: number | null) => {
    if (presentation !== "shelf" || !document.documentElement.classList.contains("dock-window")) return;
    pointerPosition.current = clientX;
    if (magnificationFrame.current !== null) return;
    magnificationFrame.current = requestAnimationFrame(() => {
      magnificationFrame.current = null;
      const surface = dock.current;
      if (!surface) return;
      const buttons = Array.from(surface.querySelectorAll<HTMLElement>("[data-dock-id]"));
      const left = surface.getBoundingClientRect().left;
      const centers = buttons.map(button => left + button.offsetLeft + button.offsetWidth / 2);
      const pointer = document.documentElement.classList.contains("reduce-motion") ? null : pointerPosition.current;
      const poses = dockMagnification(centers, pointer);
      for (let index = 0; index < buttons.length; index++) {
        buttons[index].style.setProperty("--dock-scale", String(poses[index].scale));
        buttons[index].style.setProperty("--dock-shift", poses[index].shift + "px");
        buttons[index].style.setProperty("--dock-lift", poses[index].lift + "px");
      }
    });
  };

  const selectIcon = async (file?: File) => {
    if (!file || !iconTarget) return;
    try {
      const icon = await readApplicationIcon(file);
      await onApplicationsChange((current) => current.map((application) => application.id === iconTarget ? { ...application, icon, iconSource: "custom" } : application));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "图标设置失败。");
    } finally {
      setIconTarget(null);
    }
  };

  return <>
    <div ref={dock} className={`dock glass${presentation === "quick-launch" ? " app-dock" : ""}${dragOver?" dock-drop-active":""}${sorting?" is-sorting":""}`} aria-label="应用 Dock" aria-busy={busy}
      onPointerMove={event => magnify(event.clientX)}
      onPointerLeave={() => magnify(null)}
      onContextMenu={event=>{if((event.target as HTMLElement).closest(".dock-item"))return;event.preventDefault();setMenu({id:null});}}
      onDragOver={event=>{event.preventDefault();setDragOver(!Array.from(event.dataTransfer.types).includes("application/x-codex-dock"));}}
      onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDragOver(false);}}
      onDrop={async event=>{
        event.preventDefault();setDragOver(false);
        if(event.dataTransfer.getData("application/x-codex-dock"))return;
        try{const text=event.dataTransfer.getData("text/uri-list")||event.dataTransfer.getData("text/plain");if(text){const app=applicationFromUrl(text);await onApplicationsChange(current=>mergeDroppedApplications(current,[app]));setDropMessage("网址已添加");}else if(!isTauri())setDropMessage("Windows 文件拖入需要桌面应用");}
        catch(error){setDropMessage(error instanceof Error?error.message:"拖入内容无效");}
      }}>
      {pinnedApps.map((application) => (
        <button
          className={`dock-item${dragHint?.id===application.id?" is-dragging":""}${dragHint&&dragHint.id!==application.id&&dragHint.target===application.id?" is-drop-target":""}`}
          key={application.id}
          data-dock-id={application.id}
          draggable={!busy&&!isTauri()}
          onPointerDown={event=>{if(isTauri()&&event.button===0&&!busy){event.currentTarget.setPointerCapture(event.pointerId);pointerDrag.current={id:application.id,startX:event.clientX,startY:event.clientY,active:false,target:application.id,pointerId:event.pointerId};}}}
          onPointerMove={event=>{
            const drag=pointerDrag.current;if(!drag||drag.id!==application.id)return;
            if(!drag.active&&Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>6){drag.active=true;setSorting(true);event.currentTarget.setPointerCapture(event.pointerId);}
            if(drag.active){const target=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>("[data-dock-id]");if(target?.dataset.dockId)drag.target=target.dataset.dockId;setDragHint(current=>current&&current.id===drag.id&&current.target===drag.target?current:{id:drag.id,target:drag.target});}
          }}
          onPointerUp={event=>{const drag=pointerDrag.current;pointerDrag.current=null;setSorting(false);setDragHint(null);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(drag?.active){suppressClick.current=true;event.preventDefault();void persist(current=>reorderDockApplications(current,drag.id,drag.target));}}}
          onPointerCancel={()=>{pointerDrag.current=null;setSorting(false);setDragHint(null);}}
          onLostPointerCapture={()=>{pointerDrag.current=null;setSorting(false);setDragHint(null);}}
          onDragStart={event=>{event.dataTransfer.setData("application/x-codex-dock",application.id);event.dataTransfer.effectAllowed="move";}}
          onDragOver={event=>event.preventDefault()}
          onDrop={event=>{const id=event.dataTransfer.getData("application/x-codex-dock");if(id){event.preventDefault();event.stopPropagation();setDragOver(false);void persist(current=>reorderDockApplications(current,id,application.id));}}}
          onClick={() => {if(suppressClick.current){suppressClick.current=false;return;}onLaunch(application);}}
          onContextMenu={(event) => { event.preventDefault(); setMenu({ id: application.id }); }}
          aria-label={application.target ? `打开 ${application.name}` : `配置 ${application.name}`}
        >
          <AppGlyph application={application} unadornedImage={presentation === "quick-launch"} />
          {confirmedRunning(statuses[application.id])&&<span className="dock-running-dot" aria-label="检测到运行进程" title={statuses[application.id].basis==="path"?"按程序路径确认正在运行":"按配置的进程名称匹配"}/>}
        </button>
      ))}
      {pinnedApps.length===0 && <button type="button" className="dock-empty" onClick={()=>onManage()}>拖入应用，或打开应用库</button>}
    </div>
    {(dropMessage||busy||dragOver)&&<div className="dock-drop-message glass" role="status" data-dock-hit-region="">{busy?"正在读取名称、路径和原始图标…":dragOver?"放到 Dock 添加入口":dropMessage}</div>}
    <input ref={iconInput} className="visually-hidden" type="file" accept=".png,.svg,.ico,image/png,image/svg+xml,image/x-icon" onChange={(event) => { void selectIcon(event.target.files?.[0]); event.currentTarget.value = ""; }} />
    {menu && !item && <div ref={menuRef} className="app-context-menu glass" role="menu" data-dock-hit-region={presentation === "quick-launch" ? "" : undefined} style={{ left: menuPos?.left ?? 0, bottom: menuPos?.bottom ?? 0, visibility: menuPos ? "visible" : "hidden" }} onPointerDown={(event) => event.stopPropagation()}>
      <strong>Dock</strong>
      <button role="menuitem" onClick={() => { setMenu(null); onManage(); }}>应用库…</button>
      {onAvatar&&<button role="menuitem" onClick={() => { setMenu(null); onAvatar(); }}>更换我的头像</button>}
    </div>}
    {menu && item && <div ref={menuRef} className="app-context-menu glass" role="menu" data-dock-hit-region={presentation === "quick-launch" ? "" : undefined} style={{ left: menuPos?.left ?? 0, bottom: menuPos?.bottom ?? 0, visibility: menuPos ? "visible" : "hidden" }} onPointerDown={(event) => event.stopPropagation()}>
      <strong title={item.name}>{item.name}</strong>
      <button role="menuitem" onClick={() => { setMenu(null); onLaunch(item); }}>打开</button>
      <button role="menuitem" onClick={() => { setIconTarget(item.id); setMenu(null); iconInput.current?.click(); }}>更换图标</button>
      <button role="menuitem" disabled={!item.target || item.type === "url" || item.type === "command"} onClick={() => { setMenu(null); void revealApplication(item).catch((error) => window.alert(error instanceof Error ? error.message : "无法打开应用位置")); }}>打开所在位置</button>
      <span className="app-context-separator" aria-hidden="true" />
      <button role="menuitem" onClick={() => { setMenu(null); void persist((current) => current.map((app) => app.id === item.id ? { ...app, pinned: false } : app)); }}>从 Dock 移除</button>
    </div>}
  </>;
}

export function AppGlyph({ application, unadornedImage = false }: { application: ApplicationItem; unadornedImage?: boolean }) {
  const icon = application.icon;
  if (icon) return unadornedImage
    ? <img className="app-icon-plain" src={icon} alt="" draggable={false} />
    : <span className="app-icon app-image-icon" style={{ "--app-color": application.color ?? "#67b5ff" } as CSSProperties}><img src={icon} alt="" /></span>;
  const glyph = application.glyph || application.name.slice(0, 1).toUpperCase();
  return <span className="app-icon" style={{ "--app-color": application.color ?? "#67b5ff" } as CSSProperties}>{glyph}</span>;
}
