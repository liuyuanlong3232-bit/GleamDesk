import {invoke,isTauri} from "@tauri-apps/api/core";
import {launchApplication} from "./launcher/launcherService";
import {version} from "../../package.json";

export const currentAppVersion=version;
export interface AppUpdateStatus {
 currentVersion:string;latestVersion:string;newer:boolean;canInstall:boolean;notes:string;releaseUrl:string;installHint:string;
}
const statusKey="gleamdesk.update-status.v1";
export function loadLastAppUpdate():AppUpdateStatus|null{
 try{
  const raw=localStorage.getItem(statusKey);if(!raw||raw.length>12000)return null;
  const saved=JSON.parse(raw),report=saved.report as AppUpdateStatus;
  if(!Number.isFinite(saved.checkedAt)||saved.checkedAt>Date.now()||Date.now()-saved.checkedAt>3600_000||report?.currentVersion!==currentAppVersion||!/^\d+\.\d+\.\d+$/.test(report.latestVersion)||typeof report.newer!=="boolean"||typeof report.canInstall!=="boolean"||typeof report.notes!=="string"||typeof report.releaseUrl!=="string"||typeof report.installHint!=="string")return null;
  return report;
 }catch{return null;}
}
export async function checkAppUpdate(force=false):Promise<AppUpdateStatus>{
 if(!isTauri())throw new Error("浏览器预览不检查真实更新");
 try{
  const report=await invoke<AppUpdateStatus>("check_app_update",{force});
  try{localStorage.setItem(statusKey,JSON.stringify({checkedAt:Date.now(),report}))}catch{/* A full profile must not prevent checking. */}
  return report;
 }catch(error){try{localStorage.removeItem(statusKey)}catch{}throw error;}
}
export async function installAppUpdate(expectedVersion:string,consent:boolean){
 if(!consent)throw new Error("请先保存输入并确认退出安装");
 if(!isTauri())throw new Error("浏览器预览不安装更新");
 return invoke<void>("install_app_update",{expectedVersion,consent:true});
}
export async function openReleasePage(url="https://github.com/liuyuanlong3232-bit/GleamDesk/releases/latest"){
 const parsed=new URL(url);
 if(parsed.origin!=="https://github.com"||parsed.username||parsed.password||parsed.search||parsed.hash||!/^\/liuyuanlong3232-bit\/GleamDesk\/releases\/(?:latest|tag\/v?\d+\.\d+\.\d+)$/.test(parsed.pathname))throw new Error("发布页地址不符");
 return launchApplication({id:"gleamdesk-release",name:"GleamDesk 发布页",icon:"",type:"url",target:parsed.href,pinned:false,order:0});
}
export function updateError(error:unknown){return typeof error==="string"?error:error instanceof Error?error.message:"更新检查失败，请稍后重试";}
