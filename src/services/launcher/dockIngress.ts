import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ApplicationItem } from "../../types";
import { createApplicationId, normalizeApplications } from "../applicationStore";

export function applicationFromUrl(text: string): ApplicationItem {
  const candidate=text.split(/[\r\n]/).map(line=>line.trim()).find(line=>line&&!line.startsWith("#"));
  if(!candidate) throw new Error("拖入内容没有网址");
  const url=new URL(candidate);
  if(!["http:","https:"].includes(url.protocol)||url.username||url.password||candidate.length>2000) throw new Error("Dock 仅支持不含登录凭据的 HTTP / HTTPS 网址");
  return { id:`url-${crypto.randomUUID()}`,name:url.hostname,icon:"",type:"url",target:url.href,pinned:true,order:0,glyph:"↗",category:"网址" };
}
export async function applicationsFromPaths(paths: string[]): Promise<ApplicationItem[]> {
  if(!isTauri()) throw new Error("浏览器预览不能读取 Windows 路径");
  if(!paths.length||paths.length>16)throw new Error("一次最多处理16个应用入口");
  const entries:Array<{name:string;type:ApplicationItem["type"];target:string;sourcePath:string;icon:string;arguments?:string|null;processName?:string|null}>=[];
  for(let index=0;index<paths.length;index+=4){
    const batch=paths.slice(index,index+4);
    entries.push(...await invoke<typeof entries>("extract_original_app_icons",{paths:batch}));
  }
  return entries.map((entry,index)=>({id:createApplicationId(entry.name,entry.target),name:entry.name,icon:entry.icon,type:entry.type,target:entry.target,sourcePath:entry.sourcePath,
    arguments:entry.arguments||undefined,processName:entry.processName||undefined,...(entry.icon?{iconSource:"system" as const}:{}),pinned:true,order:index,category:"拖入"}));
}
export function normalizeApplicationName(value:string):string{
  const normalized=value.toLocaleLowerCase().replace(/\b(microsoft|desktop|app)\b/g,"").replace(/[^\p{L}\p{N}]/gu,"");
  const aliases:Record<string,string>={visualstudiocode:"vscode",vscode:"vscode",windowsterminal:"terminal",microsoftedge:"edge",edgebrowser:"edge",wechat:"wechat",weixin:"wechat",微信:"wechat",chatgpt:"chatgpt",codexdesktop:"codex"};
  return aliases[normalized]??normalized;
}
export function applicationTargetsEqual(left:ApplicationItem,right:ApplicationItem):boolean{
  if(left.type!==right.type||!left.target||!right.target)return false;
  return left.type==="url"||right.type==="url"?left.type===right.type&&left.target===right.target:left.target.toLowerCase()===right.target.toLowerCase();
}
export function mergeDroppedApplications(current:ApplicationItem[],incoming:ApplicationItem[]):ApplicationItem[]{
  const next=[...current];
  for(const item of incoming){
    const existing=next.findIndex(app=>applicationTargetsEqual(app,item));
    const incomingName=normalizeApplicationName(item.name);const placeholder=existing<0&&incomingName?next.findIndex(app=>!app.target.trim()&&normalizeApplicationName(app.name)===incomingName):-1;
    const index=existing>=0?existing:placeholder;
    if(index>=0){
      const previous=next[index];
      const keepCustom=previous.iconSource==="custom"&&Boolean(previous.icon);
      next[index]={...previous,...item,id:previous.id,name:previous.name,order:previous.order,pinned:true,icon:keepCustom?previous.icon:item.icon||previous.icon,iconSource:keepCustom?"custom":item.icon?item.iconSource:previous.iconSource,glyph:previous.glyph||item.glyph,color:previous.color||item.color,
        ...(previous.target?{arguments:previous.arguments??item.arguments,processName:previous.processName??item.processName}:{} )};
    }else next.push({...item,order:next.length});
  }
  return normalizeApplications(next);
}

export function reorderDockApplications(current: ApplicationItem[], draggedId:string, targetId:string):ApplicationItem[]{
  const pinned=current.filter(app=>app.pinned).sort((a,b)=>a.order-b.order);
  const from=pinned.findIndex(app=>app.id===draggedId),to=pinned.findIndex(app=>app.id===targetId);
  if(from<0||to<0||from===to)return current;
  const [item]=pinned.splice(from,1);pinned.splice(to,0,item);
  const order=new Map(pinned.map((app,index)=>[app.id,index]));
  return normalizeApplications(current.map(app=>({...app,order:order.get(app.id)??pinned.length+app.order})));
}
