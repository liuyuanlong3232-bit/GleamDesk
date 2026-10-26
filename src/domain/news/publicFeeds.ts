import {rankNews,type NewsEntry} from "./contracts";
import {mappedTime} from "../agriculture/customHttpQuotes";

export const newsFeeds=[
 {key:"news-china",name:"中新网财经",host:"www.chinanews.com.cn"},
 {key:"news-fed",name:"美联储货币政策",host:"www.federalreserve.gov"},
 {key:"news-ecb",name:"欧洲央行",host:"www.ecb.europa.eu"},
] as const;
export interface PublicReceipt {key:string;collectedAt:string;body:string}
export interface PublicNewsSnapshot {entries:NewsEntry[];sources:{key:string;name:string;collectedAt:string|null;error?:string}[]}
export function publicTimestamp(value:unknown):string|null{return typeof value==="string"&&value.includes("T")?mappedTime(value,"iso"):null;}
export function receipt(raw:unknown,key:string,maxBytes=512*1024):PublicReceipt {
 const row=raw as PublicReceipt;
 if(row?.key!==key||typeof row.body!=="string"||new TextEncoder().encode(row.body).length>maxBytes||!publicTimestamp(row.collectedAt)||Date.parse(row.collectedAt)>Date.now()+60000)throw Error("公开来源或读取时间无效");
 return row;
}
export function xmlDocument(body:string,parse:(body:string)=>Document=text=>new DOMParser().parseFromString(text,"application/xml")):Document {
 if(/<!DOCTYPE|<!ENTITY/i.test(body))throw Error("公开 XML 包含不支持的声明");
 const doc=parse(body.replace(/^\uFEFF/,""));
 if(doc.getElementsByTagName("parsererror").length)throw Error("公开 XML 格式无效");
 return doc;
}
function plain(value:string):string {
 // Inert template, never mounted; no article, image, script or style is executed.
 const template=document.createElement("template");template.innerHTML=value;
 template.content.querySelectorAll("script,style").forEach(node=>node.remove());
 return (template.content.textContent??"").replace(/\s+/g," ").trim().slice(0,300);
}
export function parsePublicNews(raw:unknown,key:string,parse?: (body:string)=>Document,strip=plain):NewsEntry[]{
 const feed=newsFeeds.find(row=>row.key===key);if(!feed)throw Error("未知新闻来源");
 const value=receipt(raw,key),doc=xmlDocument(value.body,parse);
 if(doc.documentElement.localName!=="rss"||!doc.querySelector("channel"))throw Error("RSS 结构已变化");
 const items=Array.from(doc.querySelectorAll("channel > item")).slice(0,40),entries:NewsEntry[]=[];
 for(const item of items){
  const text=(name:string)=>item.querySelector(name)?.textContent?.trim()??"";
  const title=strip(text("title")),date=text("pubDate");let url:URL;
  try{url=new URL(text("link"));}catch{continue;}
  const allowedHost=url.hostname===feed.host||(key==="news-china"&&url.hostname==="www.chinanews.com");
  if(!title||!allowedHost||!["https:","http:"].includes(url.protocol)||url.username||url.password||url.port)continue;
  url.hash="";
  const publishedAt=/(?:GMT|UTC|[+-]\d{4})$/i.test(date)&&Number.isFinite(Date.parse(date))?new Date(date).toISOString():null;
  entries.push({id:`rss:${url.href}`,title,summary:strip(text("description")),source:feed.name,url:url.href,publishedAt,category:"市场",priority:"blue",confirmedPriority:false,state:publishedAt&&Date.parse(publishedAt)<=Date.parse(value.collectedAt)+60000?"Cached":"Unknown"});
 }
 if(!entries.length)throw Error(items.length?"RSS 没有可核对的标题和原文链接":"RSS 暂无记录");
 return rankNews(entries);
}
