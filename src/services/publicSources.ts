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

export type DiscoveryBoard="spaces"|"show-hn";
export interface DiscoveryItem {rank:number;id:string;title:string;description:string;url:string;score:number|null;comments:number|null;detail:string}
export interface DiscoverySnapshot {board:DiscoveryBoard;source:"Hugging Face Spaces"|"Show HN";collectedAt:string;items:DiscoveryItem[]}
export function isDiscoveryLink(value:string):boolean{
 try{const url=new URL(value);if(url.protocol!=="https:"||url.port||url.username||url.password||url.hash)return false;
  if(url.hostname==="news.ycombinator.com")return url.pathname==="/show"&&!url.search||url.pathname==="/item"&&/^\?id=[1-9]\d{0,14}$/.test(url.search);
  return url.hostname==="huggingface.co"&&(url.pathname==="/spaces"&&url.search==="?sort=trending"||!url.search&&/^\/spaces\/[\w.-]+\/[\w.-]+$/.test(url.pathname)&&!url.pathname.split('/').some(part=>part==='.'||part==='..'));
 }catch{return false;}
}
export function validateDiscoverySnapshot(raw:unknown,board:DiscoveryBoard):DiscoverySnapshot{
 const value=raw as DiscoverySnapshot,source=board==="spaces"?"Hugging Face Spaces":"Show HN";
 if(!value||value.board!==board||value.source!==source||!Number.isFinite(Date.parse(value.collectedAt))||Date.parse(value.collectedAt)>Date.now()+60000||!Array.isArray(value.items)||!value.items.length||value.items.length>8)throw Error("每日推荐缓存格式无效");
 const seen=new Set<string>();
 for(const item of value.items){
  if(!item||!Number.isInteger(item.rank)||item.rank<1||item.rank>100000||typeof item.id!=="string"||item.id.length>200||seen.has(item.id)||typeof item.title!=="string"||!item.title.trim()||item.title.length>300||typeof item.description!=="string"||item.description.length>700||typeof item.detail!=="string"||item.detail.length>250||!isDiscoveryLink(item.url)||![item.score,item.comments].every(number=>number===null||Number.isSafeInteger(number)&&number>=0))throw Error("每日推荐条目无效");
  if(board==="spaces"?item.url!==`https://huggingface.co/spaces/${item.id}`:item.url!==`https://news.ycombinator.com/item?id=${item.id}`)throw Error("推荐链接与来源不匹配");seen.add(item.id);
 }
 return value;
}
export function parseDiscovery(raw:unknown,board:DiscoveryBoard,parseHtml:(html:string)=>Pick<ParentNode,"querySelectorAll">=html=>{const template=document.createElement('template');template.innerHTML=html;return template.content;}):DiscoverySnapshot{
 const page=raw as {board?:string;source?:string;collectedAt?:string;payload?:unknown;html?:string},source=board==="spaces"?"Hugging Face Spaces":"Show HN";
 if(!page||page.board!==board||page.source!==source)throw Error("每日推荐来源不匹配");
 const count=(value:unknown)=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?value:null;
 let items:DiscoveryItem[];
 if(board==="spaces"){
  if(!Array.isArray(page.payload)||page.payload.length>100)throw Error("Spaces 榜单格式无效");
  items=page.payload.slice(0,8).map((value,index)=>{
   const item=value as {id?:unknown;likes?:unknown;cardData?:{title?:unknown;short_description?:unknown};runtime?:{stage?:unknown};lastModified?:unknown};
   if(!item||typeof item.id!=="string"||!/^[-\w.]+\/[-\w.]+$/.test(item.id))throw Error("Spaces 标识无效");
   const states:Record<string,string>={RUNNING:"运行中",SLEEPING:"休眠中",PAUSED:"已暂停",RUNTIME_ERROR:"运行异常",BUILD_ERROR:"构建异常",BUILDING:"正在构建",NO_APP_FILE:"尚未就绪"};
   const state=typeof item.runtime?.stage==="string"?states[item.runtime.stage]??"状态未知":"状态未知";
   const date=typeof item.lastModified==="string"&&Number.isFinite(Date.parse(item.lastModified))?item.lastModified.slice(0,10):null;
   return {rank:index+1,id:item.id,title:typeof item.cardData?.title==="string"&&item.cardData.title.trim()?item.cardData.title.trim().slice(0,300):item.id.split('/')[1],description:typeof item.cardData?.short_description==="string"?item.cardData.short_description.slice(0,700):"",url:`https://huggingface.co/spaces/${item.id}`,score:count(item.likes),comments:null,detail:`${state}${date?` · 更新 ${date}`:''}`};
  });
 }else{
  if(typeof page.html!=="string"||page.html.length>512*1024)throw Error("Show HN 榜单格式无效");
  const seen=new Set<string>();
  items=Array.from(parseHtml(page.html).querySelectorAll('tr.athing')).flatMap(row=>{
   const id=row.getAttribute('id')??'',title=row.querySelector('.titleline>a')?.textContent?.trim()??'',rankText=row.querySelector('.rank')?.textContent?.trim()??'';
   if(!/^[1-9]\d{0,14}$/.test(id)||!/^\d+\.?$/.test(rankText)||!title||seen.has(id))return [];
   seen.add(id);const meta=row.nextElementSibling,scoreText=meta?.querySelector('.score')?.textContent?.trim()??'',age=meta?.querySelector('.age')?.textContent?.trim()??'';
   const comments=Array.from(meta?.querySelectorAll('a')??[]).map(link=>link.textContent?.trim()??'').find(text=>/^\d+\s+comments?$/.test(text));
   const ageZh=age.replace(/^(\d+)\s+(minute|hour|day|month|year)s? ago$/,(_all,n:string,unit:string)=>`${n}${({minute:'分钟',hour:'小时',day:'天',month:'个月',year:'年'} as Record<string,string>)[unit]}前`);
   return [{rank:Number.parseInt(rankText,10),id,title:title.slice(0,300),description:"",url:`https://news.ycombinator.com/item?id=${id}`,score:/^\d+\s+points?$/.test(scoreText)?Number.parseInt(scoreText,10):null,comments:comments?Number.parseInt(comments,10):null,detail:ageZh.slice(0,250)}];
  }).slice(0,8);
 }
 return validateDiscoverySnapshot({board,source,collectedAt:page.collectedAt,items},board);
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
