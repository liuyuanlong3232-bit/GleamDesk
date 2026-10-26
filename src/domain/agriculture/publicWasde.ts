import {publicTimestamp,xmlDocument} from "../news/publicFeeds";
export const wasdePage="https://www.usda.gov/about-usda/general-information/staff-offices/office-chief-economist/commodity-markets/wasde-report";
const months=["January","February","March","April","May","June","July","August","September","October","November","December"];
export interface WasdeRow {commodity:string;region:string;marketingYear:string;kind:string;production:number|null;use:number|null;exports:number|null;stocks:number|null;warning?:string}
export interface PublicWasdeSnapshot {reportMonth:string;collectedAt:string;sourceUrl:string;unit:"百万吨";items:WasdeRow[]}
const clean=(s:string)=>s.replace(/\s+/g," ").trim().replace(/\s*\d+\/$/,"").trim();
function attr(node:Element,pattern:RegExp):string|null {return Array.from(node.attributes).find(a=>pattern.test(a.name))?.value??null;}
const all=(node:Element)=>[node,...Array.from(node.getElementsByTagName("*"))];
function numeric(s:string|null):number|null {if(s===null||! /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(s.trim()))return null;const n=Number(s.replace(/,/g,""));return Number.isFinite(n)?n:null;}
export function parsePublicWasde(raw:unknown,parse?:(body:string)=>Document):PublicWasdeSnapshot {
 const r=raw as {key:string;collectedAt:string;sourceUrl:string;body:string};
 if(r?.key!=="wasde"||typeof r.body!=="string"||new TextEncoder().encode(r.body).length>4*1024*1024||!publicTimestamp(r.collectedAt)||Date.parse(r.collectedAt)>Date.now()+60000)throw Error("WASDE 来源或读取时间无效");
 const link=/^https:\/\/www\.usda\.gov\/oce\/commodity\/wasde\/wasde(0[1-9]|1[0-2])(\d{2})\.xml$/.exec(r.sourceUrl);
 if(!link)throw Error("WASDE 文件地址无效");
 const reportMonth=`20${link[2]}-${link[1]}`;
 if(reportMonth>r.collectedAt.slice(0,7))throw Error("WASDE 报告月份无效");
 const doc=xmlDocument(r.body,parse);if(doc.documentElement.tagName!=="Report"||doc.documentElement.getAttribute("Name")!=="wasde")throw Error("WASDE 结构变化");
 const reports=Array.from(doc.getElementsByTagName("Report")),items:WasdeRow[]=[];
 for(const [english,commodity] of [["Corn","玉米"],["Wheat","小麦"],["Soybean","大豆"]]){
  const tables=reports.filter(n=>new RegExp(`^World ${english} Supply and Use\\b`).test(n.getAttribute("sub_report_title")??""));
  const candidates:{matrix:Element;year:string;kind:string}[]=[];
  for(const table of tables){
   if(table.getAttribute("Report_Month")!==`${months[Number(link[1])-1]} 20${link[2]}`||clean(table.getAttribute("sub_report_subtitle")??"").replace(/[()]/g,"")!=="Million Metric Tons")throw Error("WASDE 日期或单位变化");
   for(const matrix of Array.from(table.children)){
    const header=attr(matrix,/^region_header\d+$/),year=header&&/^(\d{4}\/\d{2})(?:\s+(Proj\.|Est\.|\(Est\.\)))?$/.exec(header.trim());
    if(!year)continue;
    if(Number(year[1].slice(5))!==(Number(year[1].slice(0,4))+1)%100)throw Error("WASDE 年度无效");
    candidates.push({matrix,year:year[1],kind:header!.includes("Proj.")?"预测":header!.includes("Est.")?"估计":"历史报告值"});
   }
  }
  const latest=candidates.map(c=>c.year).sort().at(-1);
  for(const [englishRegion,region] of [["World","全球"],["United States","美国"],["Brazil","巴西"],["Argentina","阿根廷"]]){
   const rows:WasdeRow[]=[];
   for(const c of candidates.filter(c=>c.year===latest))for(const group of all(c.matrix).filter(n=>clean(attr(n,/^region\d+$/)??"")===englishRegion)){
    const monthRows=all(group).filter(n=>attr(n,/^forecast_month\d+$/)===months[Number(link[1])-1].slice(0,3));
    // Never substitute last month's projection for this month's missing row.
    const scopes=monthRows.length?monthRows:all(group).some(n=>attr(n,/^forecast_month\d+$/)!==null)?[]:[group];
    for(const scope of scopes){
     const value=(label:string)=>{const fields=all(scope).filter(n=>clean(attr(n,/^attribute\d+$/)??"")===label);const cells=fields.flatMap(n=>all(n).map(n=>attr(n,/^cell_value\d+$/)).filter((v):v is string=>v!==null));return cells.length===1?numeric(cells[0]):null;};
     const row:WasdeRow={commodity,region,marketingYear:c.year,kind:c.kind,production:value("Production"),use:value("Domestic Total"),exports:value("Exports"),stocks:value("Ending Stocks")};
     if([row.production,row.use,row.exports,row.stocks].some(v=>v===null))row.warning="部分字段暂不可用";
     rows.push(row);
    }
   }
   const unique=[...new Map(rows.map(row=>[JSON.stringify(row),row])).values()];
   items.push(unique.length===1?unique[0]:{commodity,region,marketingYear:latest??"未知",kind:"未确认",production:null,use:null,exports:null,stocks:null,warning:unique.length?"记录冲突，暂不可用":"暂不可用"});
  }
 }
 if(!items.some(row=>row.production!==null))throw Error("WASDE 没有可核对的供需记录");
 return {reportMonth,collectedAt:r.collectedAt,sourceUrl:r.sourceUrl,unit:"百万吨",items};
}
export function wasdeState(s:PublicWasdeSnapshot,failed=false,now=Date.now()):string {
 if(failed||now-Date.parse(s.collectedAt)>7*3600000)return "数据未更新";
 if(s.reportMonth<new Date(now-62*86400000).toISOString().slice(0,7))return "历史月报";
 return "月报 · 发布时效未确认";
}
