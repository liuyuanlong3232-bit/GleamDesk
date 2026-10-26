import {receipt} from "../news/publicFeeds";
export const nassAnnualPage="https://esmis.nal.usda.gov/publication/crop-production-annual-summary";
export const cropProgressPage="https://esmis.nal.usda.gov/publication/crop-progress";
const months=["January","February","March","April","May","June","July","August","September","October","November","December"];
function namedDate(month:string,day:string,year:string):string {const s=`${year}-${String(months.indexOf(month)+1).padStart(2,"0")}-${day.padStart(2,"0")}`;if(!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw Error("NASS 日期无效");return s;}
function number(text:string,zero=false):number|null {if(zero&&text==="-")return 0;if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text))return null;const n=Number(text.replace(/,/g,""));return Number.isFinite(n)&&n>=0?n:null;}
function source(raw:unknown,key:string,annual=false){const r=receipt(raw,key,annual?1024*1024:512*1024),url=(raw as {sourceUrl?:unknown}).sourceUrl;const pattern=annual?/^https:\/\/esmis\.nal\.usda\.gov\/sites\/default\/release-files\/(?:[A-Za-z0-9_-]+\/){1,3}cropan\d{2}\.txt$/:/^https:\/\/esmis\.nal\.usda\.gov\/sites\/default\/release-files\/(?:[A-Za-z0-9_-]+\/){1,3}prog\d{4}\.txt$/;if(typeof url!=="string"||!pattern.test(url))throw Error("NASS 文件地址无效");return {...r,sourceUrl:url,lines:r.body.replace(/\r/g,"").split("\n")};}
export interface NassAnnualRow {name:string;production:number|null;previousProduction:number|null;yield:number|null;warning?:string}
export interface PublicNassAnnualSnapshot {year:string;previousYear:string;reportMonth:string;collectedAt:string;sourceUrl:string;items:NassAnnualRow[]}
export function parseNassAnnual(raw:unknown):PublicNassAnnualSnapshot {
 const r=source(raw,"nass-annual",true),intro=r.lines.slice(0,24).join(" ").replace(/\s+/g," ");
 const summary=/Crop Production (\d{4}) Summary/.exec(intro),month=/(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})/.exec(intro);
 if(!summary||!month||!intro.includes("Agricultural Statistics Service"))throw Error("NASS 年报标题变化");
 const reportMonth=`${month[2]}-${String(months.indexOf(month[1])+1).padStart(2,"0")}`;
 if(reportMonth>new Date(r.collectedAt).toISOString().slice(0,7)||!r.sourceUrl.endsWith(`cropan${month[2].slice(2)}.txt`))throw Error("NASS 年报月份不符");
 const titles=r.lines.flatMap((line,index)=>line.startsWith("Crop Area Planted and Harvested, Yield, and Production in Metric Units -")?[index]:[]);
 const candidates=titles.map(index=>r.lines.slice(index,index+90)).filter(lines=>lines.slice(0,12).join(" ").includes("Yield per hectare")&&lines.slice(0,12).join(" ").includes("Production"));
 if(candidates.length!==1)throw Error("NASS 公吨产量汇总不唯一");
 const table=candidates[0],head=table.slice(0,12).join(" "),years=/United States:\s*(\d{4}) and (\d{4})/.exec(head);
 if(!years||years[2]!==summary[1]||Number(years[2])-Number(years[1])!==1||!head.includes("metric tons"))throw Error("NASS 年报年份或单位变化");
 const items=([["Corn for grain","玉米"],["Soybeans for beans","大豆"],["Wheat, all","小麦（全部）"]] as const).map(([label,name])=>{
  const found=table.filter(line=>line.split(/\.{2,}/)[0].trim().replace(/\s+\d+\/$/,"")===label);
  if(found.length>1)throw Error("NASS 年报产量重复");
  const cells=found[0]?.split(":")[1]?.trim().split(/\s+/);
  const row:NassAnnualRow={name,production:cells?.length===4?number(cells[3]):null,previousProduction:cells?.length===4?number(cells[2]):null,yield:cells?.length===4?number(cells[1]):null};
  if([row.production,row.previousProduction,row.yield].some(n=>n===null))row.warning="部分数据暂不可用";return row;
 });
 if(!items.some(row=>row.production!==null))throw Error("NASS 年报没有可核对的产量");
 return {year:years[2],previousYear:years[1],reportMonth,collectedAt:r.collectedAt,sourceUrl:r.sourceUrl,items};
}
export interface CropProgressRow {name:string;metric:string;scope:string;date:string;current:number|null;previous:number|null;yearAgo:number|null;average:number|null;averagePeriod:string|null}
export interface PublicCropProgressSnapshot {publishedDate:string;collectedAt:string;sourceUrl:string;items:CropProgressRow[]}
export function parseCropProgress(raw:unknown):PublicCropProgressSnapshot {
 const r=source(raw,"crop-progress"),intro=r.lines.slice(0,12).join(" "),released=/Released (\w+) (\d{1,2}), (\d{4}), by the National Agricultural Statistics Service/.exec(intro);
 if(!intro.includes("Crop Progress")||!released)throw Error("NASS 周报标题变化");
 const publishedDate=namedDate(released[1],released[2],released[3]);if(publishedDate>new Date(r.collectedAt).toISOString().slice(0,10)||!r.sourceUrl.endsWith(released[3].slice(2)+".txt"))throw Error("NASS 周报发布日期无效");
 const zero=/^-\s+Represents zero\./m.test(r.body),percent=(text:string)=>{const n=number(text,zero);return n!==null&&n<=100?n:null;};
 const starts=r.lines.flatMap((line,index)=>/^[A-Za-z][A-Za-z ]+ - Selected States(?::|$)/.test(line.trim())?[index]:[]),items:CropProgressRow[]=[];
 const names:Record<string,string>={Corn:"玉米",Soybeans:"大豆","Winter Wheat":"冬小麦","Spring Wheat":"春小麦"};
 const metrics:Record<string,string>={Mature:"成熟",Harvested:"收获",Planted:"播种",Emerged:"出苗","Dropping Leaves":"落叶",Condition:"优良率"};
 for(let n=0;n<starts.length;n++){
  const block=r.lines.slice(starts[n],Math.min(starts[n]+90,starts[n+1]??r.lines.length)),heading=/^(Corn|Soybeans|Winter Wheat|Spring Wheat) (.+) - Selected States(?:: Week Ending (\w+) (\d{1,2}), (\d{4}))?$/.exec(block[0].trim());
  if(!heading||!metrics[heading[2]])continue;
  const coverage=/\[These (\d+) States (.+)\]/.exec(block[1]??""),totals=block.filter(line=>/^\d+ States\s*\.+:/.test(line.trim()));
  if(!coverage||totals.length!==1||!totals[0].trim().startsWith(coverage[1]+" States")||!block.some(line=>/\bpercent\b/.test(line)))throw Error("NASS 周报汇总或单位变化");
  const cells=(line:string|undefined)=>line?.split(":")[1]?.trim().split(/\s+/)??[];
  const values=cells(totals[0]);let current:number|null=null,previous:number|null=null,yearAgo:number|null=null,average:number|null=null,averagePeriod:string|null=null,date:string;
  if(heading[2]==="Condition"){
   if(!heading[3]||!block.some(line=>/Very poor\s*:\s*Poor\s*:\s*Fair\s*:\s*Good\s*:\s*Excellent/.test(line)))throw Error("NASS 长势列头变化");
   date=namedDate(heading[3],heading[4],heading[5]);
   const good=(v:string[])=>{const fields=v.map(percent);return v.length===5&&fields.every(x=>x!==null)&&fields.reduce((a,b)=>a!+b!,0)===100?fields[3]!+fields[4]!:null;};
   current=good(values);previous=good(cells(block.find(line=>/^Previous week\s*\.+:/.test(line.trim()))));yearAgo=good(cells(block.find(line=>/^Previous year\s*\.+:/.test(line.trim()))));
  }else{
   const h=block.findIndex(line=>/State\s*:\s*[A-Za-z]+ \d{1,2},/.test(line));
   const labels=block[h]?.split(":").slice(1).map(s=>s.trim()),years=block[h+1]?.split(":").slice(1).map(s=>s.trim());
   if(!labels||!years||labels.length!==4||years.length!==4||years[3]!=="Average"||values.length!==4)throw Error("NASS 进度列头变化");
   const parseLabel=(i:number)=>{const m=/^(\w+) (\d{1,2}),$/.exec(labels[i]);if(!m||!/^\d{4}$/.test(years[i]))throw Error("NASS 进度日期变化");return namedDate(m[1],m[2],years[i]);};
   date=parseLabel(2);const prior=parseLabel(1);parseLabel(0);
   if(Date.parse(date)-Date.parse(prior)!==7*86400000||Number(years[0])!==Number(years[2])-1||years[1]!==years[2]||!/^\d{4}-\d{4}$/.test(labels[3]))throw Error("NASS 周报比较期变化");
   const averageYears=labels[3].split("-").map(Number);if(averageYears[1]-averageYears[0]!==4||averageYears[1]!==Number(years[2])-1)throw Error("NASS 五年比较期无效");
   averagePeriod=labels[3];[yearAgo,previous,current,average]=values.map(percent);
  }
  if(date>publishedDate||Date.parse(publishedDate)-Date.parse(date)>8*86400000)throw Error("NASS 统计截至日无效");
  if(items.some(row=>row.name===names[heading[1]]&&row.metric===metrics[heading[2]]))throw Error("NASS 指标重复，暂不可用");
  items.push({name:names[heading[1]],metric:metrics[heading[2]],scope:`${coverage[1]}州汇总`,date,current,previous,yearAgo,average,averagePeriod});
 }
 if(!items.some(row=>row.current!==null))throw Error("NASS 周报没有可用汇总");
 return {publishedDate,collectedAt:r.collectedAt,sourceUrl:r.sourceUrl,items};
}
export function nassReportState(collectedAt:string,period:string,weekly:boolean,failed=false,now=Date.now()):string {
 if(failed||now-Date.parse(collectedAt)>(weekly?7:25)*3600000)return "数据未更新";
 if(now-Date.parse(period.length===7?period+"-01":period)>(weekly?14:550)*86400000)return weekly?"历史周报":"历史年报";
 return weekly?"周报 · 发布时效未确认":"年度报告值 · 发布时效未确认";
}
