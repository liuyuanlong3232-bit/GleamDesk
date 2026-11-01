import {invokeLive} from "./simulationSafety";
import {validateDailySnapshot,beijingDate,type DailySnapshot} from "../domain/news/dailyRecommendations";
import type {SnapshotConnection} from "../domain/agriculture/contracts";

export type SkillsBoard="trending"|"all-time";
export interface SkillsSnapshot {source:"Skills.sh";board:SkillsBoard;collectedAt:string;items:{rank:number;name:string;source:string;url:string;installs:string}[]}
export function isSkillsLink(url:string):boolean{
 try{const parsed=new URL(url);return parsed.protocol==="https:"&&parsed.hostname==="www.skills.sh"&&!parsed.port&&!parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash&&/^\/[\w.-]+\/[\w.-]+(?:\/[\w.-]+)?$/.test(parsed.pathname)&&!parsed.pathname.split("/").some(part=>part==="."||part==="..");}catch{return false;}
}
export function validateSkillsSnapshot(raw:unknown,board:SkillsBoard):SkillsSnapshot{
 const value=raw as SkillsSnapshot;
 if(!value||value.source!=="Skills.sh"||value.board!==board||!Number.isFinite(Date.parse(value.collectedAt))||!Array.isArray(value.items)||!value.items.length||value.items.length>8)throw Error("Skills 榜单缓存格式无效");
 const seen=new Set<string>();
 for(const item of value.items){if(!item||!Number.isInteger(item.rank)||item.rank<1||item.rank>100000||!isSkillsLink(item.url)||seen.has(item.url)||typeof item.name!=="string"||!item.name.trim()||item.name.length>160||typeof item.source!=="string"||!item.source.trim()||item.source.length>200||typeof item.installs!=="string"||!/^\d[\d,.]*(?:[KMB])?$/i.test(item.installs))throw Error("Skills 榜单条目无效");seen.add(item.url);}
 return value;
}
export function parseSkillsLeaderboard(raw:unknown,board:SkillsBoard,parseHtml:(html:string)=>Pick<ParentNode,"querySelectorAll">=html=>{const template=document.createElement("template");template.innerHTML=html;return template.content;}):SkillsSnapshot{
 const page=raw as {source?:string;board?:string;collectedAt?:string;html?:string};
 if(page?.source!=="Skills.sh"||page.board!==board||typeof page.html!=="string"||page.html.length>2*1024*1024||!Number.isFinite(Date.parse(page.collectedAt??"")))throw Error("Skills 榜单来源或格式无效");
 const seen=new Set<string>();
 const items=Array.from(parseHtml(page.html).querySelectorAll("a[href]")).flatMap(anchor=>{
  const href=anchor.getAttribute("href")??"",url=`https://www.skills.sh${href}`;
  const name=anchor.querySelector("h3")?.textContent?.trim(),source=anchor.querySelector("p")?.textContent?.trim();
  const installs=anchor.lastElementChild?.textContent?.trim()??"";
  const rank=Number(anchor.firstElementChild?.textContent?.trim());
  if(!name||!source||!Number.isInteger(rank)||rank<1||!/^\/[\w.-]+\/[\w.-]+(?:\/[\w.-]+)?$/.test(href)||!isSkillsLink(url)||seen.has(url)||!/^\d[\d,.]*(?:[KMB])?$/i.test(installs))return [];
  seen.add(url);return [{rank,name,source,url,installs}];
 }).slice(0,8);
 if(!items.length)throw Error("Skills 榜单页面格式已变化，暂不可用");
 return validateSkillsSnapshot({source:"Skills.sh",board,collectedAt:page.collectedAt,items},board);
}

export async function enablePublicWeather():Promise<void>{
 const config=await invokeLive<SnapshotConnection>("load_snapshot_connection");
 if(config.weatherEnabled)return;
 await invokeLive("save_snapshot_connection",{config:{...config,weatherEnabled:true}});
}

// Template contents stay inert; never insert remote HTML into the application.
export function parseTrending(raw:unknown,parseHtml:(html:string)=>Pick<ParentNode,"querySelectorAll">=html=>{const template=document.createElement("template");template.innerHTML=html;return template.content;}):DailySnapshot{
 const page=raw as {source?:string;collectedAt?:string;html?:string};
 if(page?.source!=="GitHub Trending"||typeof page.html!=="string"||page.html.length>2_000_000||!Number.isFinite(Date.parse(page.collectedAt??"")))throw Error("GitHub 来源或格式无效");
 const document=parseHtml(page.html),seen=new Set<string>();
 const items=Array.from(document.querySelectorAll("article.Box-row")).flatMap(article=>{
  const href=article.querySelector("h2 a")?.getAttribute("href")??"";
  if(!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(href))return [];
  const repo=href.slice(1);if(seen.has(repo)||repo.split("/").some(p=>p==="."||p===".."))return [];seen.add(repo);
  const text=(selector:string)=>(article.querySelector(selector)?.textContent??"").replace(/\s+/g," ").trim().slice(0,700);
  return [{repo,url:`https://github.com/${repo}`,description:text("p"),language:text('[itemprop="programmingLanguage"]'),stars:text(`a[href="${href}/stargazers"]`),todayStars:text("span.float-sm-right")}];
 }).slice(0,8);
 if(!items.length)throw Error("GitHub 榜单页面格式已变化，暂不可用");
 return validateDailySnapshot({schemaVersion:1,source:"GitHub Trending",date:beijingDate(Date.parse(page.collectedAt!)),collectedAt:page.collectedAt,items,translationStatus:"pending",status:"OK"});
}
export async function readDailyRecommendations():Promise<DailySnapshot>{
 let old:DailySnapshot|undefined;
 try{old=validateDailySnapshot(await invokeLive("read_daily_recommendations"));if(old.date===beijingDate()&&old.status!=="STALE")return old;}
 catch(error){if(typeof error==="string"&&error.startsWith("PUBLIC_SOURCE_DISABLED:"))throw Error(error.slice("PUBLIC_SOURCE_DISABLED:".length).trim());if(typeof error!=="string"||!error.startsWith("PUBLIC_CACHE_MISS:"))throw error;}
 try{
  const fresh=parseTrending(await invokeLive("fetch_public_github_trending"));
  return validateDailySnapshot(await invokeLive("save_public_daily_recommendations",{snapshot:fresh}));
 }catch(error){if(old)return {...old,status:"STALE"};throw error;}
}
