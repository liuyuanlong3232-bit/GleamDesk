interface Recommendation {repo:string;url:string;description:string;language:string;stars:string;todayStars:string;titleZh?:string;introZh?:string}
export interface DailySnapshot {schemaVersion:1;source:"GitHub Trending";date:string;collectedAt:string;items:Recommendation[];translationStatus:string;status:string}
export function validateDailySnapshot(raw:unknown):DailySnapshot {
  const value=raw as DailySnapshot;
  if(!value||value.schemaVersion!==1||value.source!=="GitHub Trending"||!/^\d{4}-\d{2}-\d{2}$/.test(value.date)||!Number.isFinite(Date.parse(value.collectedAt))||!Array.isArray(value.items)||!value.items.length||value.items.length>8)throw new Error("推荐缓存格式无效");
  const seen=new Set<string>();
  for(const item of value.items){
    if(!item||typeof item.repo!=="string"||!/^[-\w.]+\/[-\w.]+$/.test(item.repo)||seen.has(item.repo)||item.url!==`https://github.com/${item.repo}`)throw new Error("推荐项目来源无效");
    seen.add(item.repo);
    for(const key of ["description","language","stars","todayStars"] as const)if(typeof item[key]!=="string"||item[key].length>700)throw new Error("推荐文字无效");
    for(const key of ["titleZh","introZh"] as const)if(item[key]!==undefined&&(typeof item[key]!=="string"||item[key]!.length>200))throw new Error("中文介绍无效");
  }
  return value;
}
export function beijingDate(now=Date.now()){return new Date(now+8*3600000).toISOString().slice(0,10);}
