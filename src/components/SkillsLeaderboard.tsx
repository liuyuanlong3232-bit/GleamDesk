import {useEffect,useRef,useState} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {invokeLive} from "../services/simulationSafety";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";
import {parseSkillsLeaderboard,validateSkillsSnapshot,type SkillsBoard,type SkillsSnapshot} from "../services/publicSources";

export function SkillsLeaderboard({enabled,onOpen}:{enabled:boolean;onOpen:(url:string,name:string)=>void}){
 const [board,setBoard]=useState<SkillsBoard>("trending"),[snapshot,setSnapshot]=useState<SkillsSnapshot|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[stale,setStale]=useState(false);
 const reload=useRef<()=>void>(()=>{});
 useEffect(()=>{
  let active=true,pending=false;
  const key=`gleamdesk.skills-leaderboard.${board}`;
  setSnapshot(null);setError("");setBusy(false);setStale(false);
  try{const stored=localStorage.getItem(key);if(stored){const value=validateSkillsSnapshot(JSON.parse(stored),board);setSnapshot(value);setStale(Date.now()-Date.parse(value.collectedAt)>3600000);}}catch{/* Invalid or unavailable storage never replaces a live result. */}
  const refresh=async()=>{
   if(!active||pending||!enabled||!isTauri()||!isWindowVisible())return;
   pending=true;setBusy(true);
   try{const value=parseSkillsLeaderboard(await invokeLive("fetch_public_skills_leaderboard",{board}),board);if(active){setSnapshot(value);setStale(false);setError("");try{localStorage.setItem(key,JSON.stringify(value));}catch{setError("榜单已读取，本机缓存暂时无法保存");}}}
   catch(cause){if(active){setStale(true);setError(cause instanceof Error?cause.message:typeof cause==="string"?cause:"Skills 榜单读取失败");}}
   finally{pending=false;if(active)setBusy(false);}
  };
  reload.current=()=>void refresh();
  const stop=subscribeWindowVisibility(()=>void refresh());void refresh();
  const timer=window.setInterval(()=>void refresh(),3600000);
  return()=>{active=false;stop();window.clearInterval(timer);};
 },[board,enabled]);
 const displayed=snapshot?.board===board?snapshot:null;
 return <div className="skills-leaderboard">
  <div className="daily-board-tabs" role="group" aria-label="Skills 榜单类型">
   <button aria-pressed={board==="trending"} onClick={()=>setBoard("trending")}>24 小时趋势</button>
   <button aria-pressed={board==="all-time"} onClick={()=>setBoard("all-time")}>总安装榜</button>
   <button aria-label="刷新 Skills 榜单" disabled={busy||!enabled||!isTauri()} onClick={()=>reload.current()}>{busy?"读取中…":"刷新"}</button>
  </div>
  <p className="daily-message">{board==="trending"?"近 24 小时安装量":"累计安装量"} · Skills.sh · 保留来源名次，展示前 8 个条目</p>
  {!enabled&&<p className="daily-message">采集已暂停，已有内容仅为本机缓存。</p>}
  <div className="daily-projects">{displayed?.items.map(item=><article key={item.url}>
   <button className="daily-project-title" onClick={()=>onOpen(item.url,item.name)}><span>{String(item.rank).padStart(2,"0")}</span><strong>{item.name}</strong><b aria-hidden="true">↗</b></button>
   <p>{item.source}</p><small>{board==="trending"?"24 小时安装量":"累计安装量"} {item.installs}</small>
  </article>)??<p className="daily-empty">{!enabled?"模拟模式或隐藏期间暂停采集":busy?"正在读取 Skills 榜单…":"暂无榜单，稍后可刷新"}</p>}</div>
  {error&&<p className="daily-message" role="status">{error}{displayed?"；保留上次榜单":""}</p>}
  {displayed&&<p className="daily-message">{stale?"旧榜单 · ":""}采集于 {new Date(displayed.collectedAt).toLocaleString("zh-CN",{hour12:false})}</p>}
  <p className="daily-message">安装热度不代表效果评分；点击查看技能说明和原始来源。</p>
 </div>;
}
