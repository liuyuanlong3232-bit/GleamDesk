import {CloseIcon} from "./CloseIcon";
import {useEffect,useState,useRef} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {launchApplication} from "../services/launcher/launcherService";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";
import type {ApiConnectionSettings} from "../types";
import {invokeLive} from "../services/simulationSafety";

import {validateDailySnapshot,beijingDate,type DailySnapshot} from "../domain/news/dailyRecommendations";
import {readDailyRecommendations} from "../services/publicSources";
export {validateDailySnapshot,beijingDate} from "../domain/news/dailyRecommendations";
export type {DailySnapshot} from "../domain/news/dailyRecommendations";
interface DailyPresentation {presentation?:"card"|"hud";hidden?:boolean;onClose?:()=>void}
export async function openDailyLink(url:string,name:string){
  if(!/^https:\/\/github\.com\/[-\w.]+\/[-\w.]+$/.test(url)&&!["https://daily.juya.uk/","https://platform.xiaomimimo.com/"].includes(url))throw new Error("链接来源无效");
  await launchApplication({id:"daily-link",name,icon:"",type:"url",target:url,pinned:false,order:0});
}
export function DailyOpenSource({connections,enabled=true,...presentation}:{connections:ApiConnectionSettings;enabled?:boolean}&DailyPresentation){
  const [snapshot,setSnapshot]=useState<DailySnapshot|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [sourceRevision,setSourceRevision]=useState(0),revision=useRef(0);
  useEffect(()=>{let active=true,stop:(()=>void)|undefined;if(isTauri())void listen("snapshot-connection-changed",()=>{revision.current++;setSnapshot(null);setError("");setBusy(false);setSourceRevision(n=>n+1);}).then(value=>{if(active)stop=value;else value();}).catch(()=>{});return()=>{active=false;stop?.();};},[]);
  useEffect(()=>{
    if(!enabled||!isTauri())return;
    let active=true,pending=false,timer:number|undefined;
    const refresh=async()=>{
      if(!active||pending||!isWindowVisible())return;
      pending=true;setBusy(true);
      try{
        let value=await readDailyRecommendations();
        if(active){setSnapshot(value);setError("");}
        if(active&&isWindowVisible()&&connections.mimoEnabled&&connections.mimoDailyAuto&&value.date===beijingDate()&&value.status!=="STALE"&&value.translationStatus==="pending"){
          value=validateDailySnapshot(await invokeLive<unknown>("generate_daily_recommendations",{consent:true}));
          if(active)setSnapshot(value);
        }
      }catch(cause){if(active)setError(typeof cause==="string"?cause:cause instanceof Error?cause.message:"推荐读取失败，暂不可用");}
      finally{pending=false;if(active)setBusy(false);}
    };
    const restart=()=>{if(timer!==undefined)window.clearInterval(timer);timer=undefined;if(isWindowVisible()){void refresh();timer=window.setInterval(()=>void refresh(),15*60000);}};
    let unlisten:(()=>void)|undefined;
    void listen<unknown>("daily-recommendations-updated",event=>{if(active){try{setSnapshot(validateDailySnapshot(event.payload));setError("");}catch{/* Ignore invalid event payloads. */}}}).then(stop=>{if(active)unlisten=stop;else stop();});
    const stop=subscribeWindowVisibility(restart);restart();
    return()=>{active=false;stop();unlisten?.();if(timer!==undefined)window.clearInterval(timer);};
  },[enabled,connections.mimoEnabled,connections.mimoDailyAuto,connections.credentialRevision,sourceRevision]);
  const refresh=async()=>{if(!enabled||busy||!isTauri())return;const admitted=revision.current;setBusy(true);try{const value=await readDailyRecommendations();if(admitted===revision.current){setSnapshot(value);setError("");}}catch(cause){if(admitted===revision.current)setError(typeof cause==="string"?cause:"缓存读取失败，保留上次内容");}finally{if(admitted===revision.current)setBusy(false);}};
  const generate=async()=>{if(!enabled||busy||!isTauri())return;setBusy(true);try{setSnapshot(validateDailySnapshot(await invokeLive("generate_daily_recommendations",{consent:true})));setError("");}catch(cause){setError(typeof cause==="string"?cause:"中文介绍生成失败；今天不会自动重试");}finally{setBusy(false);}};
  const open=(url:string,name:string)=>void openDailyLink(url,name).catch(()=>setError("无法打开链接"));
  return <DailyOpenSourceView connections={connections} enabled={enabled} snapshot={snapshot} busy={busy} error={error} onRefresh={()=>void refresh()} onGenerate={()=>void generate()} onOpen={open} {...presentation}/>;
}
export function DailyOpenSourceView({connections,enabled=true,snapshot,busy,error,onRefresh,onGenerate,onOpen,presentation="card",hidden=false,onClose}:{connections:ApiConnectionSettings;enabled?:boolean;snapshot:DailySnapshot|null;busy:boolean;error:string;onRefresh:()=>void;onGenerate:()=>void;onOpen:(url:string,name:string)=>void}&DailyPresentation){
  const [collapsed,setCollapsed]=useState(false);
  const fresh=snapshot?.date===beijingDate()&&snapshot?.status!=="STALE";
  return <section className={`daily-opensource${presentation==="hud"?" daily-opensource-hud":""}${collapsed?" is-collapsed":""}`} hidden={hidden} aria-label="每日开源推荐" data-main-hit-region={presentation==="card"?true:undefined} data-no-page-swipe>
    <header><div><strong>每日开源推荐</strong><small>{snapshot?`${snapshot.date} · ${snapshot.items.length} 个${fresh?"":" · 旧榜单"}`:enabled?"GitHub Trending · 每日最多 8 个":"模拟模式已暂停采集"}</small></div>
      <button aria-label="刷新推荐" aria-busy={busy} disabled={busy||!isTauri()||!enabled} onClick={onRefresh}><span className={busy?"daily-refresh-icon is-refreshing":"daily-refresh-icon"} aria-hidden="true">↻</span></button>
      {presentation==="hud"?<button className="ui-icon-button" aria-label="关闭每日推荐" onClick={onClose}><CloseIcon/></button>:<button aria-label={collapsed?"展开每日推荐":"收起每日推荐"} aria-expanded={!collapsed} onClick={()=>setCollapsed(value=>!value)}>{collapsed?"＋":"−"}</button>}
    </header>
    {!collapsed&&<><div className="daily-projects">{snapshot?.items.map((item,index)=><article key={item.repo}>
      <button className="daily-project-title" onClick={()=>onOpen(item.url,item.repo)}><span>{String(index+1).padStart(2,"0")}</span><strong>{item.titleZh||item.repo.split("/")[1]}</strong><b aria-hidden="true">↗</b></button>
      <p>{item.introZh||item.description||"来源未提供简介，用途待确认。"}</p>
      <small>{item.language||"语言未标注"}{item.stars?` · ★ ${item.stars}`:""}{item.introZh?" · AI 中文介绍":" · 原文"}</small>
      {item.introZh&&<details><summary>{item.repo} · 查看原文</summary><p>{item.description||"来源未提供简介"}</p></details>}
    </article>)??<p className="daily-empty">{isTauri()?busy?"正在读取公开榜单…":"等待首次榜单采集":"真实推荐需在桌面预览中读取"}</p>}</div>
    {error&&<p className="daily-message" role="status">{error}</p>}
    {snapshot&&snapshot.translationStatus!=="done"&&<div className="daily-translate"><small>{snapshot.translationStatus==="attempted"?"今天已尝试生成，保留原文；不重复扣费。":connections.mimoDailyAuto?"等待 MiMo 中文介绍":"中文介绍尚未生成"}</small>
      {snapshot.translationStatus==="pending"&&<button disabled={busy||!fresh||!connections.mimoEnabled||!isTauri()||!enabled} onClick={onGenerate}>生成中文 · 付费，每日 1 次</button>}
    </div>}
    <footer><small>{busy?"处理中…":"每日更新"}</small><button onClick={()=>onOpen("https://daily.juya.uk/","橘鸦 AI 早报")}>AI 早报 ↗</button></footer></>}
  </section>;
}
