import {invoke,isTauri} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {invokeLive} from "./simulationSafety";
import {requireRealCallsAllowed} from "./simulationSafety";
import {webAppUrl} from "./webAppStore";
import {parseServiceConnections,parseServiceSnapshot,parseXuiDetails,parseSingBoxDetails,parseTailscaleDetails,type ServiceConnection} from "../domain/vps/services";
export async function loadVpsServices(){return isTauri()?parseServiceConnections(await invoke("load_vps_services")):[];}
export async function saveVpsServices(connections:ServiceConnection[]){
 if(!isTauri())throw Error("服务连接需要 Windows 桌面版");
 return parseServiceConnections(await invoke("save_vps_services",{connections:parseServiceConnections(connections)}));
}
export async function readVpsService(connection:ServiceConnection,simulationEnabled=false){
 if(!connection.enabled)throw Error("服务连接已关闭");
 if(!isTauri())throw Error("服务读取需要 Windows 桌面版");
 return parseServiceSnapshot(await invokeLive("read_vps_service",{kind:connection.kind,endpoint:connection.endpoint},simulationEnabled),connection);
}
export async function readXuiDetails(connection:ServiceConnection,simulationEnabled=false){
 if(connection.kind!=="3x-ui"||!connection.enabled)throw Error("3x-ui 连接未启用");
 if(!isTauri())throw Error("服务详情需要 Windows 桌面版");
 return parseXuiDetails(await invokeLive("read_xui_details",{endpoint:connection.endpoint},simulationEnabled),connection);
}
export function xuiPanelUrl(connection:ServiceConnection):string{
 const url=new URL(webAppUrl(connection.endpoint));
 if(connection.kind!=="3x-ui"||url.search||url.hash)throw Error("3x-ui 面板地址无效");
 return webAppUrl(`${connection.endpoint.replace(/\/+$/,"")}/panel/`);
}
export async function readSingBoxDetails(connection:ServiceConnection,simulationEnabled=false){
 if(connection.kind!=="sing-box"||!connection.enabled)throw Error("sing-box 连接未启用");
 if(!isTauri())throw Error("服务详情需要 Windows 桌面版");
 return parseSingBoxDetails(await invokeLive("read_sing_box_details",{endpoint:connection.endpoint},simulationEnabled),connection);
}
export function singBoxPanelUrl(connection:ServiceConnection):string{
 const url=new URL(webAppUrl(connection.endpoint));
 if(connection.kind!=="sing-box"||url.search||url.hash)throw Error("sing-box 面板地址无效");
 return webAppUrl(`${connection.endpoint.replace(/\/+$/,"")}/ui/`);
}
export async function readTailscaleDetails(connection:ServiceConnection,simulationEnabled=false){
 if(connection.kind!=="tailscale"||!connection.enabled)throw Error("Tailscale 连接未启用");
 if(!isTauri())throw Error("服务详情需要 Windows 桌面版");
 return parseTailscaleDetails(await invokeLive("read_tailscale_details",{endpoint:connection.endpoint},simulationEnabled),connection);
}
export async function openSingBoxPanel(connection:ServiceConnection,open:(url:string,name:string)=>void,simulationEnabled=false){
 if(!connection.enabled)throw Error("服务连接已关闭");await requireRealCallsAllowed(simulationEnabled);
 open(singBoxPanelUrl(connection),"sing-box 网页面板");
}
export async function openXuiPanel(connection:ServiceConnection,open:(url:string,name:string)=>void,simulationEnabled=false){
 if(!connection.enabled)throw Error("服务连接已关闭");await requireRealCallsAllowed(simulationEnabled);
 open(xuiPanelUrl(connection),"3x-ui 管理面板");
}
export async function serviceToken(connection:Pick<ServiceConnection,"kind"|"endpoint">,action:"inspect"|"save"|"clear",token?:string):Promise<boolean>{
 if(!isTauri())return false;
 return invoke("vps_service_token",{kind:connection.kind,endpoint:connection.endpoint,action,token:token??null});
}
export function subscribeVpsServices(listener:()=>void){
 let active=true,stop:(()=>void)|undefined;
 if(isTauri())void listen("vps-services-changed",listener).then(unlisten=>{if(active)stop=unlisten;else unlisten();}).catch(()=>{if(active)listener();});
 return()=>{active=false;stop?.();};
}
