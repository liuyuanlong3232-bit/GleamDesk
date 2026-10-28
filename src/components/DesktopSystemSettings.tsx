import {useEffect,useRef,useState} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {invokeLive} from "../services/simulationSafety";

interface DesktopStatus {
 startupRegistered:boolean|null;startupMatchesCurrent:boolean;startupLegacyPresent?:boolean;startupRevision:string;startupError:string|null;
 iconsHidden:boolean|null;iconsError:string|null;
}
type Change={kind:"startup"|"icons";enabled:boolean};

export function DesktopSystemSettings({simulationEnabled=false}:{simulationEnabled?:boolean}){
 const[status,setStatus]=useState<DesktopStatus|null>(null),[pending,setPending]=useState<Change|null>(null),[working,setWorking]=useState(false),[message,setMessage]=useState("");
 const busy=useRef(false),epoch=useRef(0),simulated=useRef(simulationEnabled);simulated.current=simulationEnabled;
 const read=async()=>{
  if(!isTauri()||simulated.current||busy.current)return;
  busy.current=true;const current=++epoch.current;setWorking(true);setPending(null);setMessage("");
  try{const value=await invokeLive<DesktopStatus>("read_windows_desktop_settings");if(current===epoch.current&&!simulated.current)setStatus(value)}
  catch(error){if(current===epoch.current){setStatus(null);setMessage(typeof error==="string"?error:"无法读取 Windows 设置，请刷新重试。")}}
  finally{if(current===epoch.current){busy.current=false;setWorking(false)}}
 };
 useEffect(()=>{
  epoch.current++;busy.current=false;setPending(null);setStatus(null);setMessage("");setWorking(false);
  if(!simulationEnabled)void read();
  return()=>{epoch.current++};
 },[simulationEnabled]);
 const apply=async()=>{
  if(!pending||!status||simulated.current||busy.current)return;
  if(pending.kind==="startup"?(status.startupRegistered===null||!status.startupRevision):status.iconsHidden===null)return;
  busy.current=true;const current=++epoch.current;setWorking(true);setMessage("");
  try{
   const value=await invokeLive<DesktopStatus>(pending.kind==="startup"?"set_windows_autostart":"set_windows_desktop_icons",pending.kind==="startup"
    ?{enabled:pending.enabled,expectedRevision:status.startupRevision,confirmed:true}
    :{hidden:pending.enabled,expectedHidden:status.iconsHidden,confirmed:true});
   if(current===epoch.current&&!simulated.current){setStatus(value);setMessage(pending.kind==="startup"?(pending.enabled?"已添加当前用户登录启动项。":"已移除 GleamDesk 登录启动项。"):pending.enabled?"桌面图标已隐藏。":"桌面图标已显示。")}
  }catch(error){if(current===epoch.current){setStatus(null);setMessage(typeof error==="string"?error:"Windows 设置未能确认，请刷新检查。")}}
  finally{if(current===epoch.current){busy.current=false;setWorking(false);setPending(null)}}
 };
 const disabled=!isTauri()||simulationEnabled||working||pending!==null;
 return <div className="windows-system-options">
  <label className="settings-toggle"><span>登录 Windows 时启动</span><input aria-label="登录 Windows 时启动" type="checkbox" checked={status?.startupRegistered===true} disabled={disabled||status?.startupRegistered==null} onChange={event=>setPending({kind:"startup",enabled:event.target.checked})}/></label>
  <label className="settings-toggle"><span>隐藏 Windows 桌面图标</span><input aria-label="隐藏 Windows 桌面图标" type="checkbox" checked={status?.iconsHidden===true} disabled={disabled||status?.iconsHidden==null} onChange={event=>setPending({kind:"icons",enabled:event.target.checked})}/></label>
  <div className="settings-actions"><button disabled={disabled} onClick={()=>void read()}>{working?"处理中…":"刷新系统状态"}</button></div>
  {pending&&<section className="app-update-confirm" aria-label="确认 Windows 设置更改"><p>{pending.kind==="startup"?(pending.enabled?"在当前用户启动文件夹创建 GleamDesk 快捷方式，指向当前程序并设置工作目录；移除旧版同名注册表启动项，避免重复启动。移动程序后需重新设置。":"只移除当前用户的 GleamDesk 启动快捷方式及旧版同名启动项。"):pending.enabled?"隐藏桌面图标，保留全部文件。不会随退出自动恢复，可在桌面右键→查看中重新显示。":"重新显示 Windows 桌面图标。"}</p><div className="settings-actions"><button disabled={working||simulationEnabled} onClick={()=>void apply()}>确认更改</button><button disabled={working} onClick={()=>setPending(null)}>取消</button></div></section>}
  {simulationEnabled?<p role="status">模拟模式不读取或修改 Windows 设置。</p>:!isTauri()?<p role="status">请在 Windows 桌面程序中设置。</p>:<>
   {status?.startupRegistered&&!status.startupMatchesCurrent&&<p role="status">登录启动项指向另一份 GleamDesk；关闭后再开启可切换到当前程序。</p>}
   {status?.startupLegacyPresent&&<p role="status">检测到旧版注册表启动项；开启此开关可迁移到启动文件夹。</p>}
   {status?.startupError&&<p role="status">{status.startupError}</p>}{status?.iconsError&&<p role="status">{status.iconsError}</p>}
  </>}
  {message&&<p role="status">{message}</p>}
  <details className="settings-help"><summary>Windows 设置说明</summary><p>登录启动仅登记当前用户的 GleamDesk 项，不使用管理员权限；也可在 Windows“启动应用”中管理。隐藏图标不删除、移动或重新排列桌面文件，也不隐藏任务栏。</p></details>
 </div>;
}
