export type WebAppSurface="workspace"|"toolbox";
export interface WebApp {id:string;name:string;url:string;icon:string;category:string;surface?:WebAppSurface;pageTitle?:string;automaticName?:boolean;persistentProfile:true;permissions:[]}
const key="codex-desktop.webapps.v1",changed="codex-desktop.webapps-changed";
const clean=(value:string,limit:number)=>value.replace(/[\u0000-\u001f\u007f]/g,"").trim().slice(0,limit);
const safeIcon=(value:unknown)=>typeof value==="string"&&value.length<=22000&&/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value)?value:"";
export interface WebAppMetadata{id:string;registeredUrl:string;title?:string|null;icon?:string|null}
export function applyWebAppMetadata(apps:WebApp[],metadata:WebAppMetadata):WebApp[]{
  return apps.map(app=>{if(app.id!==metadata.id||app.url!==metadata.registeredUrl)return app;
    const title=typeof metadata.title==="string"?clean(metadata.title,180):app.pageTitle;
    const icon=safeIcon(metadata.icon)||app.icon;
    return {...app,icon,...(title?{pageTitle:title,name:app.automaticName?title.slice(0,60):app.name}:{} )};
  });
}
export function webAppUrl(value:string):string {
  if(value.length>4096||/[\u0000-\u001f\u007f]/.test(value))throw new Error("网址过长或包含控制字符");
  const url=new URL(value.trim());
  if(!["https:","http:"].includes(url.protocol)||url.username||url.password||["tauri.localhost","ipc.localhost","asset.localhost"].includes(url.hostname))throw new Error("仅支持无嵌入凭据的 HTTP(S) 网址");
  return url.href;
}
export const initialWebApps:WebApp[]=[{id:"mues",name:"Muse",url:"https://muse.ai/",icon:"",category:"工作",surface:"workspace",persistentProfile:true,permissions:[]}];
export function temporaryWebApp(url:string,name:string):WebApp{
  return {id:"source-view",name:clean(name,60)||"来源网页",url:webAppUrl(url),icon:"",category:"临时浏览",persistentProfile:true,permissions:[]};
}
export const toolboxPresets = [
  {id:"globalping",name:"全球网站/IP可访问性",description:"Globalping · 多地网络检测",url:"https://globalping.io/",category:"网络工具"},
  {id:"hibp",name:"邮箱泄露检测",description:"Have I Been Pwned · 查询泄露记录",url:"https://haveibeenpwned.com/",category:"安全工具"},
  {id:"vt-url",name:"URL安全检查",description:"VirusTotal · 检查网页地址",url:"https://www.virustotal.com/gui/home/url",category:"安全工具"},
  {id:"abuseipdb",name:"IP信誉",description:"AbuseIPDB · 查询 IP 举报记录",url:"https://www.abuseipdb.com/",category:"安全工具"},
  {id:"vt-hash",name:"Hash查询",description:"VirusTotal · 查询已有文件哈希",url:"https://www.virustotal.com/gui/home/search",category:"安全工具"},
];
export function configureToolboxPreset(apps:WebApp[],presetId:string):{apps:WebApp[];id:string} {
  const preset=toolboxPresets.find(item=>item.id===presetId);if(!preset)throw new Error("未知的工具入口");
  const existing=apps.find(app=>app.url===webAppUrl(preset.url));if(existing)return {apps,id:existing.id};
  const next=addWebApp(apps,preset.name,preset.url,preset.category,"toolbox");return {apps:next,id:next[next.length-1].id};
}
export function normalizeWebApps(value:unknown):WebApp[]{
  if(!Array.isArray(value))return initialWebApps.map(app=>({...app,permissions:[]}));
  const ids=new Set<string>(),urls=new Set<string>();
  return value.slice(0,50).flatMap((raw:Partial<WebApp>)=>{try{
    if(!raw||typeof raw.id!=="string"||!/^[a-zA-Z0-9-]{1,64}$/.test(raw.id)||ids.has(raw.id)||typeof raw.name!=="string"||typeof raw.url!=="string")return [];
    const url=webAppUrl(raw.url),name=clean(raw.name,60);if(!name||urls.has(url))return [];ids.add(raw.id);urls.add(url);
    return [{id:raw.id,name,url,icon:safeIcon(raw.icon),...(typeof raw.pageTitle==="string"?{pageTitle:clean(raw.pageTitle,180)}:{}),...(raw.automaticName===true?{automaticName:true}:{}),category:typeof raw.category==="string"?clean(raw.category,40)||"自定义":"自定义",surface:raw.surface==="toolbox"?"toolbox" as const:"workspace" as const,persistentProfile:true as const,permissions:[] as []}];
  }catch{return [];}});
}
export function loadWebApps():WebApp[]{try{return normalizeWebApps(JSON.parse(localStorage.getItem(key)??"null"));}catch{return initialWebApps.map(app=>({...app,permissions:[]}));}}
export function addWebApp(apps:WebApp[],name:string,url:string,category:string,surface:WebAppSurface="workspace",automaticName=false):WebApp[]{
  const target=webAppUrl(url);if(apps.some(app=>app.url===target))throw new Error("这个网页已经添加");if(apps.length>=50)throw new Error("最多添加50个网页应用");
  const label=clean(name,60);if(!label)throw new Error("请填写名称");
  return [...apps,{id:crypto.randomUUID(),name:label,url:target,icon:"",category:clean(category,40)||"自定义",surface,...(automaticName?{automaticName:true}:{}),persistentProfile:true,permissions:[]}];
}
export function updateWebApp(apps:WebApp[],id:string,patch:{name:string;url:string;category:string;surface:WebAppSurface}):WebApp[]{
  const index=apps.findIndex(app=>app.id===id);if(index<0)throw new Error("网站入口已不存在");
  const url=webAppUrl(patch.url),name=clean(patch.name,60);if(!name)throw new Error("请填写名称");
  if(apps.some(app=>app.id!==id&&app.url===url))throw new Error("这个网页已经添加");
  return normalizeWebApps(apps.map(app=>app.id===id?{...app,name,url,icon:app.url===url?app.icon:"",pageTitle:app.url===url?app.pageTitle:undefined,automaticName:false,category:clean(patch.category,40)||"自定义",surface:patch.surface,permissions:[]}:app));
}
export function moveWebApp(apps:WebApp[],id:string,offset:number):WebApp[]{
  const next=[...apps],from=next.findIndex(app=>app.id===id);if(from<0)return next;
  const to=Math.max(0,Math.min(next.length-1,from+Math.trunc(offset)));if(from===to)return next;
  const [item]=next.splice(from,1);next.splice(to,0,item);return next;
}
export function removeWebApp(apps:WebApp[],id:string):WebApp[]{return apps.filter(app=>app.id!==id);}
export function webAppDropUrl(value:string):string{
  const line=value.split(/[\r\n]/).map(value=>value.trim()).find(value=>value&&!value.startsWith("#"));
  if(!line)throw new Error("拖入内容没有网址");return webAppUrl(line);
}
export function saveWebApps(apps:WebApp[]){
  const normalized=normalizeWebApps(apps);if(normalized.length!==apps.length)throw new Error("网页配置包含无效或重复入口");
  localStorage.setItem(key,JSON.stringify(normalized));if(typeof window!=="undefined")window.dispatchEvent(new Event(changed));
}
export function subscribeWebApps(listener:()=>void):()=>void{
  const storage=(event:StorageEvent)=>{if(event.key===key||event.key===null)listener();};
  window.addEventListener(changed,listener);window.addEventListener("storage",storage);
  return()=>{window.removeEventListener(changed,listener);window.removeEventListener("storage",storage);};
}
