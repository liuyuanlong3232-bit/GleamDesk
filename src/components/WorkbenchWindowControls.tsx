import {useEffect,useState} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {getCurrentWindow} from "@tauri-apps/api/window";

export function WorkbenchWindowControls(){
 const [maximized,setMaximized]=useState(false),[error,setError]=useState("");

 useEffect(()=>{
  if(!isTauri())return;
  const window=getCurrentWindow();let active=true,unlisten:(()=>void)|undefined;
  const refresh=()=>{void window.isMaximized().then(value=>{if(active)setMaximized(value)}).catch(()=>{});};
  refresh();
  void window.onResized(refresh).then(stop=>{if(active)unlisten=stop;else stop()}).catch(()=>{});
  return()=>{active=false;unlisten?.()};
 },[]);

 if(!isTauri())return null;
 const minimize=()=>{setError("");void getCurrentWindow().minimize().catch(()=>setError("无法最小化工作台"));};
 const toggleMaximize=()=>{setError("");void getCurrentWindow().toggleMaximize().then(()=>getCurrentWindow().isMaximized()).then(setMaximized).catch(()=>setError("无法调整工作台大小"));};

 return <>
  <button className="ui-icon-button workbench-window-control" type="button" aria-label="最小化工作台" title="最小化工作台" onClick={minimize}>
   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M3 8h10"/></svg>
  </button>
  <button className="ui-icon-button workbench-window-control" type="button" aria-label={maximized?"还原工作台":"最大化工作台"} title={maximized?"还原工作台":"最大化工作台"} aria-pressed={maximized} onClick={toggleMaximize}>
   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" aria-hidden="true">{maximized?<><path d="M5.5 5.5V3.75c0-.4.3-.75.75-.75h5c.4 0 .75.35.75.75v5c0 .4-.35.75-.75.75H9.5"/><path d="M3.75 6.5h5c.4 0 .75.35.75.75v5c0 .4-.35.75-.75.75h-5a.75.75 0 0 1-.75-.75v-5c0-.4.35-.75.75-.75Z"/></>:<rect x="3.5" y="3.5" width="9" height="9" rx=".8"/>}</svg>
  </button>
  {error&&<small className="workbench-window-error" role="alert">{error}</small>}
 </>;
}
