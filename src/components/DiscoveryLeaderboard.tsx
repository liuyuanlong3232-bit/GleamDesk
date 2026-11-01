import {useEffect,useRef,useState} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {invokeLive} from "../services/simulationSafety";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";
import {parseDiscovery,validateDiscoverySnapshot,type DiscoveryBoard,type DiscoverySnapshot} from "../services/publicSources";
import {useOfflineDescriptions} from "./OfflineTranslation";

export function DiscoveryLeaderboard({board,enabled,onOpen}:{board:DiscoveryBoard;enabled:boolean;onOpen:(url:string,name:string)=>void}){
 const [snapshot,setSnapshot]=useState<DiscoverySnapshot|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[stale,setStale]=useState(false);
 const reload=useRef<()=>void>(()=>{});
 useEffect(()=>{
  let active=true,pending=false;const key=`gleamdesk.discovery.${board}.v1`;
  setSnapshot(null);setBusy(false);setError("");setStale(false);
  try{const cached=localStorage.getItem(key);if(cached){const value=validateDiscoverySnapshot(JSON.parse(cached),board);setSnapshot(value);setStale(Date.now()-Date.parse(value.collectedAt)>3600000);}}catch{/* A corrupt optional cache cannot replace a live result. */}
  const refresh=async()=>{
   if(!active||pending||!enabled||!isTauri()||!isWindowVisible())return;
   pending=true;setBusy(true);
   try{const value=parseDiscovery(await invokeLive("fetch_public_discovery",{board}),board);if(active){setSnapshot(value);setStale(false);setError("");try{localStorage.setItem(key,JSON.stringify(value));}catch{setError("榜单已读取，本机缓存暂时无法保存");}}}
   catch(cause){if(active){setStale(true);setError(cause instanceof Error?cause.message:typeof cause==="string"?cause:"榜单暂时无法读取");}}
   finally{pending=false;if(active)setBusy(false);}
  };
  reload.current=()=>void refresh();const stop=subscribeWindowVisibility(()=>void refresh());void refresh();
  const timer=enabled?window.setInterval(()=>void refresh(),15*60000):undefined;
  return()=>{active=false;stop();if(timer!==undefined)window.clearInterval(timer);};
 },[board,enabled]);
 const displayed=snapshot?.board===board?snapshot:null;
 const original=(item:DiscoverySnapshot['items'][number])=>board==="show-hn"?item.title.replace(/^Show HN:\s*/i,""):item.description;
 const translation=useOfflineDescriptions(displayed?.items.map(item=>({description:original(item)}))??[],enabled);
 return <div className="discovery-leaderboard">
  <div className="daily-source-line"><span>{board==="spaces"?"AI 应用 · 官方热度顺序":"开发者新作品 · 来源当前顺序"}</span><button type="button" aria-label={`刷新 ${board==="spaces"?"Spaces":"Show HN"} 榜单`} disabled={busy||!enabled||!isTauri()} onClick={()=>reload.current()}>{busy?"读取中…":"↻"}</button></div>
  <div className="daily-projects">{displayed?.items.map(item=>{
   const text=original(item),translated=translation.results[text];
   return <article key={item.id}>
    <button type="button" className="daily-project-title" title={board==="spaces"?"查看应用页面":"查看 Show HN 讨论"} onClick={()=>onOpen(item.url,item.title)}><span>{String(item.rank).padStart(2,"0")}</span><strong>{board==="show-hn"?translated||text:item.title}</strong><b aria-hidden="true">↗</b></button>
    {board==="spaces"&&<><small className="daily-item-author">{item.id}</small><p>{translated||item.description||"来源未提供简介"}</p></>}
    <div className="daily-item-meta"><span>{item.score===null?"热度未提供":`${item.score.toLocaleString("zh-CN")} ${board==="spaces"?"赞":"分"}`}{item.comments!==null?` · ${item.comments.toLocaleString("zh-CN")} 条讨论`:""}</span>{item.detail&&<span>{item.detail}</span>}</div>
    {translated?<details><summary>离线中文译文 · 查看原文</summary><p>{text}</p></details>:translation.busy&&text&&<small>正在离线翻译…</small>}
   </article>;
  })??<p className="daily-empty">{busy?"正在读取公开榜单…":enabled?"暂无榜单，可稍后刷新":"采集已暂停"}</p>}</div>
  {error&&<p className="daily-message" role="status">{error}{displayed?"；保留上次榜单":""}</p>}
  {translation.error&&<p className="daily-message" role="status">{translation.error}；保留原文</p>}
  {displayed&&<p className="daily-message">{stale?"旧榜单 · ":""}采集于 {new Date(displayed.collectedAt).toLocaleString("zh-CN",{hour12:false})}</p>}
 </div>;
}
