import {useEffect,useRef,useState} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {checkAppUpdate,currentAppVersion,installAppUpdate,loadLastAppUpdate,openReleasePage,updateError,type AppUpdateStatus} from "../services/appUpdates";

export function AppUpdateIndicator({enabled,onOpen}:{enabled:boolean;onOpen:()=>void}){
 const[report,setReport]=useState<AppUpdateStatus|null>(null);
 useEffect(()=>{
  if(!enabled||!isTauri()){setReport(null);return;}
  let active=true,stop:(()=>void)|undefined;
  void listen<AppUpdateStatus>("gleamdesk-update-checked",event=>{if(active)setReport(event.payload)}).then(unlisten=>{if(active)stop=unlisten;else unlisten()}).catch(()=>{});
  const timer=window.setTimeout(()=>{void checkAppUpdate().then(value=>{if(active)setReport(value)}).catch(()=>{/* Startup failures do not interrupt the desktop. Manual checking remains available. */})},5000);
  return()=>{active=false;window.clearTimeout(timer);stop?.()};
 },[enabled]);
 if(!enabled||!report?.newer)return null;
 return <button className="island-item app-update-indicator" aria-label={`发现新版 ${report.latestVersion}，打开版本与更新`} title={`GleamDesk ${report.latestVersion} 可用`} onClick={onOpen}><span aria-hidden="true">↑</span><small>新版</small></button>;
}

export function AppUpdateSettings({automatic,onAutomaticChange,simulationEnabled=false}:{automatic:boolean;onAutomaticChange:(enabled:boolean)=>void;simulationEnabled?:boolean}){
 const[report,setReport]=useState<AppUpdateStatus|null>(()=>simulationEnabled?null:loadLastAppUpdate()),[checking,setChecking]=useState(false),[installing,setInstalling]=useState(false),[confirming,setConfirming]=useState(false),[saved,setSaved]=useState(false),[progress,setProgress]=useState<number|null>(null),[message,setMessage]=useState("");
 const operation=useRef(false),generation=useRef(0),simulated=useRef(simulationEnabled);simulated.current=simulationEnabled;
 useEffect(()=>{generation.current++;operation.current=false;setReport(simulationEnabled?null:loadLastAppUpdate());setConfirming(false);setSaved(false);setMessage("");setChecking(false);setInstalling(false);setProgress(null);return()=>{generation.current++}},[simulationEnabled]);
 useEffect(()=>{
  if(!isTauri())return;let active=true,stop:(()=>void)|undefined;
  void listen<number|null>("gleamdesk-update-progress",event=>{if(active)setProgress(typeof event.payload==="number"&&Number.isFinite(event.payload)?Math.max(0,Math.min(100,event.payload)):null)}).then(unlisten=>{if(active)stop=unlisten;else unlisten()}).catch(()=>{});
  return()=>{active=false;stop?.()};
 },[]);
 const check=async()=>{
  if(simulated.current||operation.current)return;
  operation.current=true;
  const version=++generation.current;setChecking(true);setMessage("");setReport(null);setConfirming(false);setSaved(false);
  try{const value=await checkAppUpdate(true);if(version===generation.current&&!simulated.current)setReport(value)}
  catch(error){if(version===generation.current&&!simulated.current)setMessage(updateError(error))}
  finally{if(version===generation.current){operation.current=false;setChecking(false)}}
 };
 const install=async()=>{
  if(simulated.current||operation.current||!saved||!confirming||!report?.canInstall)return;
  operation.current=true;
  const version=++generation.current;setInstalling(true);setProgress(null);setMessage("");
  try{await installAppUpdate(report.latestVersion,true);if(version===generation.current)setMessage("安装器已启动，程序将退出。")}
  catch(error){if(version===generation.current)setMessage(updateError(error))}
  finally{if(version===generation.current){operation.current=false;setInstalling(false);setConfirming(false);setSaved(false)}}
 };
 const open=()=>void openReleasePage(report?.releaseUrl).catch(error=>setMessage(updateError(error)));
 return <div className="settings-section app-updates">
  <strong>GleamDesk {currentAppVersion}</strong>
  <label className="settings-toggle"><span>启动后检查更新</span><input aria-label="启动后检查更新" type="checkbox" checked={automatic} disabled={installing} onChange={event=>onAutomaticChange(event.target.checked)}/></label>
  <div className="settings-actions"><button disabled={!isTauri()||simulationEnabled||checking||installing} onClick={()=>void check()}>{checking?"检查中…":"检查更新"}</button><button disabled={installing} onClick={open}>打开发布页 ↗</button></div>
  {simulationEnabled?<p role="status">模拟模式不检查或安装真实更新。</p>:checking?<p role="status">正在连接 GitHub…</p>:report?<div className="app-update-result" role="status"><strong>{report.newer?`发现新版 ${report.latestVersion}`:report.latestVersion===report.currentVersion?`当前已是最新正式版（${report.currentVersion}）`:`当前版本 ${report.currentVersion} 高于已发布版 ${report.latestVersion}`}</strong>{report.newer&&<>{!confirming&&<p>{report.installHint}</p>}{report.notes&&<details className="settings-help"><summary>更新内容</summary><p className="app-update-notes">{report.notes}</p></details>}{report.canInstall&&!confirming&&<button className="action-button" disabled={installing} onClick={()=>{setConfirming(true);setSaved(false)}}>下载并更新</button>}</>}</div>:<p className="app-update-idle">尚未检查；网络不可用不会影响正常使用。</p>}
  {confirming&&<section className="app-update-confirm" aria-label="确认安装更新"><p>请保存正在编辑的内容。确认后关闭 Dock、顶部 HUD 和工作台，更新程序并重新启动；配置与历史保留。</p><label className="settings-toggle"><span>我已保存输入，允许退出并安装更新</span><input type="checkbox" checked={saved} disabled={installing} onChange={event=>setSaved(event.target.checked)}/></label><div className="settings-actions"><button disabled={!saved||installing||simulationEnabled} onClick={()=>void install()}>{installing?"正在下载并校验…":"确认退出并更新"}</button><button disabled={installing} onClick={()=>{setConfirming(false);setSaved(false)}}>取消</button></div></section>}
  {installing&&<p role="status">{progress===null?"正在下载并校验更新…":`下载 ${progress}% · 校验通过后启动安装器`}</p>}
  {message&&<p role="status">{message}</p>}
  <details className="settings-help"><summary>更新说明</summary><p>检查只访问 GitHub 的公开发布信息，不发送账号或配置。自动安装使用独立更新签名校验，不代表安装包已有 Windows 发行者证书。便携版到发布页手动下载并替换文件。</p><p>没有完整签名更新附件的旧版本只提供下载入口。关闭工作台只是隐藏，手动更新前请从顶部 HUD 退出整个程序，不要删除应用数据。</p></details>
 </div>;
}
