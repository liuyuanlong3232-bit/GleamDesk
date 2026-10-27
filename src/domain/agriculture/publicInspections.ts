import {receipt} from "../news/publicFeeds";

export const inspectionsUrl="https://www.ams.usda.gov/mnreports/wa_gr101.txt";
export interface InspectionRow {commodity:string;name:string;current:number|null;previous:number|null;yearAgo:number|null;warning?:string}
export interface PublicInspectionsSnapshot {publishedDate:string;weekEnding:string;previousWeekEnding:string;yearAgoWeekEnding:string;collectedAt:string;unit:"吨";items:InspectionRow[]}
const months=["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const fullMonths=["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];
function date(year:number,month:number,day:number):string {
 const value=`${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
 if(year<2000||year>2100||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw Error("出口检验日期无效");
 return value;
}
function namedDate(month:string,day:string,year:string):string {
 const name=month.toUpperCase(),index=months.findIndex((short,i)=>name===short||name===fullMonths[i]);
 if(index<0)throw Error("出口检验月份无效");
 return date(Number(year),index+1,Number(day));
}
function numericDate(value:string):string {const [month,day,year]=value.split("/").map(Number);return date(year,month,day);}
function number(value:string):number|null {
 if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value))return null;
 const result=Number(value.replace(/,/g,""));return Number.isSafeInteger(result)&&result>=0?result:null;
}
export function parsePublicInspections(raw:unknown):PublicInspectionsSnapshot {
 const r=receipt(raw,"usda-inspections"),lines=r.body.replace(/^\uFEFF/,"").split(/\r*\n/).map(line=>line.trim());
 if(lines[0]!=="WA_GR101")throw Error("出口检验报告编号变化");
 const publication=/^Washington, DC\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{4})\s+USDA Market News$/.exec(lines[1]??"");
 const title=lines.indexOf("GRAINS INSPECTED AND/OR WEIGHED FOR EXPORT");
 const ending=/^REPORTED IN WEEK ENDING ([A-Z]{3}) (\d{1,2}), (\d{4})$/.exec(lines[title+1]??"");
 if(!publication||title<2||!ending||lines[title+2]!=="-- METRIC TONS --")throw Error("出口检验报告结构或单位变化");
 const publishedDate=namedDate(publication[1],publication[2],publication[3]),weekEnding=namedDate(ending[1],ending[2],ending[3]);
 const header=lines.findIndex((line,index)=>index>title&&/^GRAIN\s/.test(line));
 const dates=/^GRAIN\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+TO DATE\s+TO DATE$/.exec(lines[header]??"");
 if(!dates||header-title>12||lines[header-1]!=="----------- WEEK ENDING ----------  MARKET YEAR  MARKET YEAR"||!/^CURRENT\s+PREVIOUS$/.test(lines[header-2]??""))throw Error("出口检验列头变化");
 const current=numericDate(dates[1]),previousWeekEnding=numericDate(dates[2]),yearAgoWeekEnding=numericDate(dates[3]);
 const priorYearDays=(Date.parse(current)-Date.parse(yearAgoWeekEnding))/86400000;
 if(current!==weekEnding||Date.parse(current)-Date.parse(previousWeekEnding)!==7*86400000||priorYearDays<350||priorYearDays>380||publishedDate<weekEnding||publishedDate>new Date(r.collectedAt).toISOString().slice(0,10))throw Error("出口检验报告日期不一致");
 // Only the first national summary: later port, destination and correction tables are different scopes.
 const end=lines.findIndex((line,index)=>index>header&&line.startsWith("CROP MARKETING YEARS BEGIN "));
 if(end<0||end-header>24)throw Error("出口检验汇总边界变化");
 const rows=new Map<string,(number|null)[]>();
 for(const line of lines.slice(header+1,end).filter(Boolean)){
  const cells=line.split(/\s+/),key=cells.shift()!;
  if(!/^(?:[A-Z]+|Total)$/.test(key)||rows.has(key)||cells.length!==5)throw Error("出口检验行缺列或重复");
  rows.set(key,cells.map(number));
 }
 const items:InspectionRow[]=([["CORN","玉米"],["SOYBEANS","大豆"],["WHEAT","小麦"],["Total","全部谷物合计"]] as const).map(([commodity,name])=>{
  const values=rows.get(commodity),row:InspectionRow={commodity,name,current:values?.[0]??null,previous:values?.[1]??null,yearAgo:values?.[2]??null};
  if([row.current,row.previous,row.yearAgo].some(v=>v===null))row.warning="部分数据暂不可用";
  return row;
 });
 if(!items.some(row=>row.current!==null))throw Error("出口检验没有可核对的当周数据");
 return {publishedDate,weekEnding,previousWeekEnding,yearAgoWeekEnding,collectedAt:r.collectedAt,unit:"吨",items};
}
export function inspectionsState(s:PublicInspectionsSnapshot,failed=false,now=Date.now()):string {
 if(failed||now-Date.parse(s.collectedAt)>7*3600000)return "数据未更新";
 if(now-Date.parse(s.publishedDate)>14*86400000)return "历史周报";
 return "周报 · 发布时效未确认";
}
