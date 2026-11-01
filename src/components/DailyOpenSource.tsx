import {useOfflineDescriptions} from "./OfflineTranslation";
import {CloseIcon} from "./CloseIcon";
import {useEffect,useState,useRef} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {launchApplication} from "../services/launcher/launcherService";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";

import {validateDailySnapshot,beijingDate,type DailySnapshot} from "../domain/news/dailyRecommendations";
import {readDailyRecommendations} from "../services/publicSources";
import {isSkillsLink,isDiscoveryLink} from "../services/publicSources";
import {SkillsLeaderboard} from "./SkillsLeaderboard";
import {DiscoveryLeaderboard} from "./DiscoveryLeaderboard";
import "./daily-discovery.css";
export {validateDailySnapshot,beijingDate} from "../domain/news/dailyRecommendations";
export type {DailySnapshot} from "../domain/news/dailyRecommendations";
interface DailyPresentation {presentation?:"card"|"hud";hidden?:boolean;onClose?:()=>void}
export async function openDailyLink(url:string,name:string){
  if(!/^https:\/\/github\.com\/[-\w.]+\/[-\w.]+$/.test(url)&&!isSkillsLink(url)&&!isDiscoveryLink(url)&&!["https://daily.juya.uk/","https://platform.xiaomimimo.com/","https://www.skills.sh/","https://www.skills.sh/trending"].includes(url))throw new Error("链接来源无效");
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
const dailyPages=[
 {id:'projects',title:'GitHub',caption:'每日开源项目',mark:'GH',link:'https://daily.juya.uk/',linkLabel:'AI 早报'},
 {id:'skills',title:'Skills',caption:'技能安装热榜',mark:'SK',link:'https://www.skills.sh/trending',linkLabel:'Skills.sh'},
 {id:'spaces',title:'Spaces',caption:'热门 AI 应用体验',mark:'HF',link:'https://huggingface.co/spaces?sort=trending',linkLabel:'Spaces 榜单'},
 {id:'show-hn',title:'Show HN',caption:'开发者的新作品',mark:'HN',link:'https://news.ycombinator.com/show',linkLabel:'Show HN 榜单'},
] as const;
function PageArrow({previous=false}:{previous?:boolean}){return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={previous?'m14 6-6 6 6 6':'m10 6 6 6-6 6'}/></svg>}
export function DailyOpenSourceView({enabled=true,snapshot,busy,error,onRefresh,onOpen,presentation="card",hidden=false,onClose}:{enabled?:boolean;snapshot:DailySnapshot|null;busy:boolean;error:string;onRefresh:()=>void;onOpen:(url:string,name:string)=>void}&DailyPresentation){
 const [collapsed,setCollapsed]=useState(false),[page,setPage]=useState(0),[motion,setMotion]=useState<'none'|'next'|'previous'>('none'),[turn,setTurn]=useState(0);
 const current=dailyPages[page],section=current.id;
 const translation=useOfflineDescriptions(snapshot?.items??[],enabled&&!hidden&&!collapsed&&section==='projects');
 const fresh=snapshot?.date===beijingDate()&&snapshot?.status!=='STALE';
 useEffect(()=>{if(hidden||collapsed){setPage(0);setMotion('none');setTurn(0)}},[hidden,collapsed]);
 const flip=(direction:1|-1)=>{setMotion(direction===1?'next':'previous');setTurn(value=>value+1);setPage(value=>(value+direction+dailyPages.length)%dailyPages.length)};
 return <section className={`daily-opensource daily-carousel${presentation==='hud'?' daily-opensource-hud':''}${collapsed?' is-collapsed':''}`} hidden={hidden} aria-label="每日推荐" data-main-hit-region={presentation==='card'?true:undefined} data-no-page-swipe>
  <header><div><strong>每日推荐</strong><small>开源 · 技能 · AI 应用 · 新作品</small></div>
   {section==='projects'&&<button type="button" aria-label="刷新推荐" aria-busy={busy} disabled={busy||!isTauri()||!enabled} onClick={onRefresh}><span className={busy?'daily-refresh-icon is-refreshing':'daily-refresh-icon'} aria-hidden="true">↻</span></button>}
   {presentation==='hud'?<button type="button" className="ui-icon-button" aria-label="关闭每日推荐" onClick={onClose}><CloseIcon/></button>:<button type="button" aria-label={collapsed?'展开每日推荐':'收起每日推荐'} aria-expanded={!collapsed} onClick={()=>setCollapsed(value=>!value)}>{collapsed?'＋':'−'}</button>}
  </header>
  {!collapsed&&<>
   <nav className="daily-pager" aria-label="每日推荐翻页">
    <button type="button" className="daily-page-arrow" aria-label="上一页推荐" title={`上一页：${dailyPages[(page+3)%4].title}`} onClick={()=>flip(-1)}><PageArrow previous/></button>
    <div className="daily-page-heading" aria-live="polite" aria-atomic="true"><span className={`daily-page-mark daily-page-mark-${section}`} aria-hidden="true">{current.mark}</span><div><strong>{current.title}</strong><small>{current.caption}</small></div></div>
    <div className="daily-page-count"><span>{page+1} / {dailyPages.length}</span><span className="daily-page-dots" aria-hidden="true">{dailyPages.map(item=><i key={item.id} className={item.id===section?'is-active':''}/>)}</span></div>
    <button type="button" className="daily-page-arrow" aria-label="下一页推荐" title={`下一页：${dailyPages[(page+1)%4].title}`} onClick={()=>flip(1)}><PageArrow/></button>
   </nav>
   <div className="daily-page-viewport"><div className="daily-page" key={`${page}-${turn}`} data-motion={motion} data-board={section}>
    {section==='skills'?<SkillsLeaderboard enabled={enabled&&!hidden} onOpen={onOpen}/>:section==='spaces'||section==='show-hn'?<DiscoveryLeaderboard board={section} enabled={enabled&&!hidden} onOpen={onOpen}/>:<>
     <div className="daily-source-line"><span>{snapshot?`${snapshot.date} · ${snapshot.items.length} 个项目${fresh?'':' · 旧榜单'}`:enabled?'GitHub Trending · 每日最多 8 个':'采集已暂停'}</span></div>
     <div className="daily-projects">{snapshot?.items.map((item,index)=><article key={item.repo}>
      <button type="button" className="daily-project-title" onClick={()=>onOpen(item.url,item.repo)}><span>{String(index+1).padStart(2,'0')}</span><strong>{item.repo.split('/')[1]}</strong><b aria-hidden="true">↗</b></button>
      <p>{translation.results[item.description]||item.description||'来源未提供简介，用途待确认。'}</p>
      <small>{item.language||'语言未标注'}{item.stars?` · ★ ${item.stars}`:''}{translation.results[item.description]?' · 离线中文译文 · 仅供参考':translation.busy?' · 离线翻译中…':' · 原文'}</small>
      {translation.results[item.description]&&<details><summary>{item.repo} · 查看原文</summary><p>{item.description||'来源未提供简介'}</p></details>}
     </article>)??<p className="daily-empty">{isTauri()?busy?'正在读取公开榜单…':'等待首次榜单采集':'真实推荐需在桌面程序中读取'}</p>}</div>
     {error&&<p className="daily-message" role="status">{error}</p>}
     {translation.error&&<p className="daily-message" role="status">{translation.error}；保留原文</p>}
    </>}
   </div></div>
   <p className="daily-translation-note">英文简介离线译为中文 · 原文可展开 · 译文仅供参考</p>
   <footer><small>点击箭头切换榜单</small><button type="button" onClick={()=>onOpen(current.link,current.linkLabel)}>{current.linkLabel} ↗</button></footer>
  </>}
 </section>;
}
