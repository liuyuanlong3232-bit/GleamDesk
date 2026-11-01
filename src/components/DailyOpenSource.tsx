import {useOfflineDescriptions} from "./OfflineTranslation";
import {CloseIcon} from "./CloseIcon";
import {useEffect,useState,useRef} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {launchApplication} from "../services/launcher/launcherService";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";

import {validateDailySnapshot,beijingDate,type DailySnapshot} from "../domain/news/dailyRecommendations";
import {readDailyRecommendations} from "../services/publicSources";
import {isSkillsLink} from "../services/publicSources";
import {SkillsLeaderboard} from "./SkillsLeaderboard";
export {validateDailySnapshot,beijingDate} from "../domain/news/dailyRecommendations";
export type {DailySnapshot} from "../domain/news/dailyRecommendations";
interface DailyPresentation {presentation?:"card"|"hud";hidden?:boolean;onClose?:()=>void}
export async function openDailyLink(url:string,name:string){
  if(!/^https:\/\/github\.com\/[-\w.]+\/[-\w.]+$/.test(url)&&!isSkillsLink(url)&&!["https://daily.juya.uk/","https://platform.xiaomimimo.com/"].includes(url))throw new Error("链接来源无效");
  await launchApplication({id:"daily-link",name,icon:"",type:"url",target:url,pinned:false,order:0});
}
export function DailyOpenSource({enabled=true,...presentation}:{enabled?:boolean}&DailyPresentation){
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

      }catch(cause){if(active)setError(typeof cause==="string"?cause:cause instanceof Error?cause.message:"推荐读取失败，暂不可用");}
      finally{pending=false;if(active)setBusy(false);}
    };
    const restart=()=>{if(timer!==undefined)window.clearInterval(timer);timer=undefined;if(isWindowVisible()){void refresh();timer=window.setInterval(()=>void refresh(),15*60000);}};
    let unlisten:(()=>void)|undefined;
    void listen<unknown>("daily-recommendations-updated",event=>{if(active){try{setSnapshot(validateDailySnapshot(event.payload));setError("");}catch{/* Ignore invalid event payloads. */}}}).then(stop=>{if(active)unlisten=stop;else stop();});
    const stop=subscribeWindowVisibility(restart);restart();
    return()=>{active=false;stop();unlisten?.();if(timer!==undefined)window.clearInterval(timer);};
  },[enabled,sourceRevision]);
  const refresh=async()=>{if(!enabled||busy||!isTauri())return;const admitted=revision.current;setBusy(true);try{const value=await readDailyRecommendations();if(admitted===revision.current){setSnapshot(value);setError("");}}catch(cause){if(admitted===revision.current)setError(typeof cause==="string"?cause:"缓存读取失败，保留上次内容");}finally{if(admitted===revision.current)setBusy(false);}};
  const open=(url:string,name:string)=>void openDailyLink(url,name).catch(()=>setError("无法打开链接"));
  return <DailyOpenSourceView enabled={enabled} snapshot={snapshot} busy={busy} error={error} onRefresh={()=>void refresh()} onOpen={open} {...presentation}/>;
}
export function DailyOpenSourceView({enabled=true,snapshot,busy,error,onRefresh,onOpen,presentation="card",hidden=false,onClose}:{enabled?:boolean;snapshot:DailySnapshot|null;busy:boolean;error:string;onRefresh:()=>void;onOpen:(url:string,name:string)=>void}&DailyPresentation){
  const [collapsed,setCollapsed]=useState(false),[section,setSection]=useState<"projects"|"skills">("projects");
  const translation=useOfflineDescriptions(snapshot?.items??[],enabled&&!hidden&&!collapsed&&section==="projects");
  const fresh=snapshot?.date===beijingDate()&&snapshot?.status!=="STALE";
  return <section className={`daily-opensource${presentation==="hud"?" daily-opensource-hud":""}${collapsed?" is-collapsed":""}`} hidden={hidden} aria-label="每日开源推荐" data-main-hit-region={presentation==="card"?true:undefined} data-no-page-swipe>
    <header><div><strong>每日开源推荐</strong><small>{section==="skills"?"Skills.sh · 技能安装热榜":snapshot?`${snapshot.date} · ${snapshot.items.length} 个${fresh?"":" · 旧榜单"}`:enabled?"GitHub Trending · 每日最多 8 个":"模拟模式已暂停采集"}</small></div>
      {section==="projects"&&<button aria-label="刷新推荐" aria-busy={busy} disabled={busy||!isTauri()||!enabled} onClick={onRefresh}><span className={busy?"daily-refresh-icon is-refreshing":"daily-refresh-icon"} aria-hidden="true">↻</span></button>}
      {presentation==="hud"?<button className="ui-icon-button" aria-label="关闭每日推荐" onClick={onClose}><CloseIcon/></button>:<button aria-label={collapsed?"展开每日推荐":"收起每日推荐"} aria-expanded={!collapsed} onClick={()=>setCollapsed(value=>!value)}>{collapsed?"＋":"−"}</button>}
    </header>
    {!collapsed&&<><div className="daily-board-tabs" role="group" aria-label="推荐内容"><button aria-pressed={section==="projects"} onClick={()=>setSection("projects")}>开源项目</button><button aria-pressed={section==="skills"} onClick={()=>setSection("skills")}>Skills 热榜</button></div>
    {section==="skills"?<SkillsLeaderboard enabled={enabled&&!hidden} onOpen={onOpen}/>:<><div className="daily-projects">{snapshot?.items.map((item,index)=><article key={item.repo}>
      <button className="daily-project-title" onClick={()=>onOpen(item.url,item.repo)}><span>{String(index+1).padStart(2,"0")}</span><strong>{item.repo.split("/")[1]}</strong><b aria-hidden="true">↗</b></button>
      <p>{translation.results[item.description]||item.description||"来源未提供简介，用途待确认。"}</p>
      <small>{item.language||"语言未标注"}{item.stars?` · ★ ${item.stars}`:""}{translation.results[item.description]?" · 离线中文译文 · 仅供参考":translation.busy?" · 离线翻译中…":" · 原文"}</small>
      {translation.results[item.description]&&<details><summary>{item.repo} · 查看原文</summary><p>{item.description||"来源未提供简介"}</p></details>}
    </article>)??<p className="daily-empty">{isTauri()?busy?"正在读取公开榜单…":"等待首次榜单采集":"真实推荐需在桌面预览中读取"}</p>}</div>
    {error&&<p className="daily-message" role="status">{error}</p>}
    {translation.error&&<p className="daily-message" role="status">{translation.error}；保留原文。</p>}
    <p className="daily-message">英文简介自动离线译为中文 · 不调用翻译 API</p>
    <footer><small>{busy?"处理中…":"每日更新"}</small><button onClick={()=>onOpen("https://daily.juya.uk/","橘鸦 AI 早报")}>AI 早报 ↗</button></footer></>}</>}
  </section>;
}
