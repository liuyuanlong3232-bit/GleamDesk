import {agriculturePresentation,type AgricultureEnvelope} from "../agriculture/contracts";
import {rankNews,type NewsEntry,type NewsPriority} from "./contracts";
import type {NotificationCandidate} from "../../types";

function fingerprint(value:string):string {
  let hash=0xcbf29ce484222325n;
  for(const byte of new TextEncoder().encode(value))hash=BigInt.asUintN(64,(hash^BigInt(byte))*0x100000001b3n);
  return hash.toString(16);
}

function canonicalNewsUrl(value:unknown):string|null {
  if(typeof value!=="string")return null;
  try {const url=new URL(value);if(!["http:","https:"].includes(url.protocol)||url.username||url.password)return null;url.hash="";return url.href;}catch{return null;}
}
/** Importance must be explicitly supplied; title keywords only choose a category. */
export function newsFromAgriculture(snapshot:AgricultureEnvelope,now=Date.now()):NewsEntry[] {
  const value=snapshot.snapshots.global_snapshot?.payload.news;
  const snapshotRows=Array.isArray(value)?value.filter((row):row is Record<string,unknown>=>!!row&&typeof row==="object").slice(0,100):[];
  const databaseRows=(snapshot.financeNews??[]) as unknown as Record<string,unknown>[];
  const raw=[...snapshotRows,...databaseRows].slice(0,120);
  return rankNews(agriculturePresentation(snapshot,now).news.map(item=>{
    const row=raw.find(row=>item.url?canonicalNewsUrl(row.url)===canonicalNewsUrl(item.url):row.title===item.title)??{};
    const priority:NewsPriority=row.priority==="red"||row.priority==="orange"?row.priority:"blue";
    const canonicalUrl=item.url?new URL(item.url):null;if(canonicalUrl)canonicalUrl.hash="";
    const eventId=typeof row.eventId==="string"&&row.eventId.trim()?row.eventId.trim().slice(0,300):canonicalUrl?.href??item.id;
    return {id:`news:${fingerprint(eventId)}`,title:item.title,url:item.url,publishedAt:item.publishedAt,state:item.status,
      source:typeof row.source==="string"&&row.source.trim()?row.source.slice(0,120):canonicalUrl?`VPS / ${canonicalUrl.hostname}`:"来源未知",
      summary:typeof row.summary==="string"?row.summary.slice(0,1200):"",category:"市场" as const,priority,
      confirmedPriority:row.confirmedPriority===true};
  }),now);
}

export function newsNotificationCandidates(entries:NewsEntry[],now=Date.now()):NotificationCandidate[] {
  return rankNews(entries,now).filter(item=>item.confirmedPriority&&item.priority!=="blue"&&item.state==="Cached"
    &&item.url&&item.source!=="来源未知"&&item.publishedAt&&Date.parse(item.publishedAt)<=now)
    .map(item=>({id:item.id,source:"provider",scope:"news-vps",rule:`news-event:${item.id}`,kind:"event",
      severity:item.priority==="red"?"error":"warning",title:`${item.priority==="red"?"重大事件 / RED":"重要事件 / ORANGE"} · ${item.title.slice(0,120)}`,
      detail:`${item.source} · ${item.publishedAt}\n${item.summary}\n${item.url}`.slice(0,2500),evidenceAt:item.publishedAt}));
}


export interface Jin10NewsSnapshot {
  schemaVersion:1;source:"Jin10 MCP";fetchedAt:string;last_attempt:string|null;last_success:string|null;
  latest_observation:string|null;status:"OK"|"UNAVAILABLE";news:Record<string,unknown>[];
}
export function validateJin10Snapshot(value:unknown):Jin10NewsSnapshot {
  if(!value||typeof value!=="object")throw new Error("金十快照格式错误");
  const row=value as Record<string,unknown>;
  if(row.schemaVersion!==1||row.source!=="Jin10 MCP"||!Array.isArray(row.news)||row.news.length>100
    ||typeof row.fetchedAt!=="string"||!Number.isFinite(Date.parse(row.fetchedAt))
    ||!["OK","UNAVAILABLE"].includes(String(row.status)))throw new Error("金十快照来源或格式未知");
  for(const field of ["last_attempt","last_success","latest_observation"]){
    if(row[field]!==null&&(typeof row[field]!=="string"||!Number.isFinite(Date.parse(row[field] as string))))throw new Error("金十时间字段未知");
  }
  if(row.news.some(item=>!item||typeof item!=="object"||Array.isArray(item)||(item as Record<string,unknown>).source!=="Jin10 MCP"))throw new Error("金十快照混入未知来源");
  return row as unknown as Jin10NewsSnapshot;
}
/** Overlay only for the news page. Preserve the original agricultural and Finnhub data. */
export function newsWithJin10(snapshot:AgricultureEnvelope|null|undefined,jin10:Jin10NewsSnapshot|null,now=Date.now()):NewsEntry[] {
  const original=snapshot?newsFromAgriculture(snapshot,now):[];
  if(!jin10?.news.length)return original;
  const feed:AgricultureEnvelope={schemaVersion:1,origin:"cache:jin10",fetchedAt:jin10.fetchedAt,
    snapshots:{global_snapshot:{path:"workbench/jin10_news.json",fileModifiedAt:jin10.fetchedAt,payload:{news:jin10.news}}}};
  return rankNews([...newsFromAgriculture(feed,now),...original.filter(item=>item.source!=="Jin10 MCP")],now);
}
