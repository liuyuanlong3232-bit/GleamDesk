import {receipt} from "../news/publicFeeds";
export const monthlySeries=[{id:"PMAIZMTUSDM",name:"玉米",unit:"美元/公吨"},{id:"PWHEAMTUSDM",name:"小麦",unit:"美元/公吨"},{id:"PCOTTINDUSDM",name:"棉花",unit:"美分/磅"},{id:"PSUGAISAUSDM",name:"食糖",unit:"美分/磅"}] as const;
export interface MonthlyPriceRow {id:string;name:string;unit:string;date:string|null;value:number|null;warning?:string}
export type MonthlySource="worldbank"|"fred";
export interface PublicMonthlySnapshot {source:MonthlySource;sourceUrl:string;updatedOn?:string;collectedAt:string;items:MonthlyPriceRow[]}
export const worldBankPage="https://www.worldbank.org/en/research/commodity-markets";
export const worldBankSeries=[
 {id:"wb-maize",header:"Maize",name:"玉米",rawUnit:"($/mt)",unit:"美元/公吨"},
 {id:"wb-wheat-srw",header:"Wheat, US SRW",name:"美国软红冬麦",rawUnit:"($/mt)",unit:"美元/公吨"},
 {id:"wb-wheat-hrw",header:"Wheat, US HRW",name:"美国硬红冬麦",rawUnit:"($/mt)",unit:"美元/公吨"},
 {id:"wb-sugar",header:"Sugar, world",name:"世界食糖",rawUnit:"($/kg)",unit:"美元/千克"},
 {id:"wb-cotton",header:"Cotton, A Index",name:"棉花 A 指数",rawUnit:"($/kg)",unit:"美元/千克"},
] as const;
export function parseWorldBankMonthly(raw:unknown):PublicMonthlySnapshot {
 const r=receipt(raw,"worldbank-monthly"),sourceUrl=(raw as {sourceUrl?:unknown}).sourceUrl;
 if(typeof sourceUrl!=="string"||!/^https:\/\/thedocs\.worldbank\.org\/en\/doc\/[A-Za-z0-9-]{1,160}\/related\/CMO-Historical-Data-Monthly\.xlsx$/.test(sourceUrl))throw Error("世界银行月表来源无效");
 const data=JSON.parse(r.body) as {period?:unknown;updatedOn?:unknown;items?:unknown};
 const validDate=(s:unknown):s is string=>typeof s==="string"&&/^\d{4}-(?:0[1-9]|1[0-2])-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
 if(!data||!validDate(data.period)||!data.period.endsWith("-01")||!validDate(data.updatedOn)||data.period>data.updatedOn||data.updatedOn>new Date(r.collectedAt).toISOString().slice(0,10)||!Array.isArray(data.items)||data.items.length!==worldBankSeries.length)throw Error("世界银行月表日期或结构变化");
 const rows=data.items as Record<string,unknown>[];const period=data.period;
 const items=worldBankSeries.map(series=>{
  const matches=rows.filter(row=>row?.header===series.header);if(matches.length!==1)throw Error("世界银行商品重复或缺失");const row=matches[0];
  if(row.unit!==series.rawUnit||!(row.date===null&&row.value===null||validDate(row.date)&&row.date.endsWith("-01")&&row.date<=period&&typeof row.value==="number"&&Number.isFinite(row.value)&&row.value>=0))throw Error("世界银行单位或价格无效");
  return {id:series.id,name:series.name,unit:series.unit,date:row.date as string|null,value:row.value as number|null,...row.date===null?{warning:"暂不可用"}:row.date!==period?{warning:"本期缺值，保留原月份"}:{}};
 });
 if(!items.some(row=>row.value!==null))throw Error("世界银行没有可用价格");
 return {source:"worldbank",sourceUrl,updatedOn:data.updatedOn,collectedAt:r.collectedAt,items};
}
export function parsePublicMonthly(raw:unknown):PublicMonthlySnapshot {
 const r=receipt(raw,"monthly-commodities"),lines=r.body.replace(/^\uFEFF/,"").trim().split(/\r?\n/);
 if(lines[0]!=="observation_date,"+monthlySeries.map(s=>s.id).join(",")||lines.length>1500)throw Error("月度价格 CSV 列头变化");
 const values:Map<string,{date:string;value:number}>=new Map();let previous="";
 for(const line of lines.slice(1)){
  const cells=line.split(","),date=cells[0];
  if(cells.length!==5||!/^\d{4}-\d{2}-01$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date<=previous||date>new Date(r.collectedAt).toISOString().slice(0,10))throw Error("月度价格日期或列数无效");
  previous=date;
  monthlySeries.forEach((series,index)=>{const text=cells[index+1];if(text===""||text===".")return;if(!/^\d+(?:\.\d+)?$/.test(text))throw Error("月度价格字段无效");const value=Number(text);if(!Number.isFinite(value))throw Error("月度价格数值无效");values.set(series.id,{date,value});});
 }
 const items=monthlySeries.map(s=>{const found=values.get(s.id);return {...s,date:found?.date??null,value:found?.value??null,...!found?{warning:"暂不可用"}:found.date!==previous?{warning:"本期缺值，保留原月份"}:{}};});
 if(!values.size)throw Error("月度价格没有可用记录");return {source:"fred",sourceUrl:"https://fred.stlouisfed.org",collectedAt:r.collectedAt,items};
}
export interface IbgeProductionRow {id:string;name:string;value:number|null}
export interface PublicIbgeSnapshot {month:string;collectedAt:string;items:IbgeProductionRow[]}
export const ibgeProducts=[{id:"39428",name:"谷物、豆类和油料合计"},{id:"39441",name:"玉米（一季）"},{id:"39442",name:"玉米（二季）"},{id:"39443",name:"大豆"},{id:"39445",name:"小麦"}] as const;
export function parsePublicIbge(raw:unknown):PublicIbgeSnapshot {
 const r=receipt(raw,"ibge-crops"),data=JSON.parse(r.body) as Record<string,unknown>[];
 if(!Array.isArray(data)||data.length<2||data.length>100||data[0]?.V!=="Valor")throw Error("IBGE 数据结构变化");
 const seen=new Map<string,Record<string,unknown>>(),periods=new Set<string>();
 for(const row of data.slice(1)){
  if(!row||row.NC!=="1"||row.D1C!=="1"||row.D2C!=="35"||row.D2N!=="Produção"||row.MC!=="1017"||row.MN!=="Toneladas"||typeof row.D3C!=="string"||!/^\d{4}(?:0[1-9]|1[0-2])$/.test(row.D3C)||typeof row.D4C!=="string")throw Error("IBGE 范围、变量或公吨单位不符");
  if(!ibgeProducts.some(p=>p.id===row.D4C))continue;
  if(seen.has(row.D4C))throw Error("IBGE 商品重复，暂不可用");seen.set(row.D4C,row);periods.add(row.D3C);
 }
 if(periods.size!==1)throw Error("IBGE 估算月份不唯一");const period=[...periods][0],month=period.slice(0,4)+"-"+period.slice(4);
 if(month>new Date(r.collectedAt).toISOString().slice(0,7))throw Error("IBGE 估算月份无效");
 const items=ibgeProducts.map(p=>{const text=seen.get(p.id)?.V,value=typeof text==="string"&&/^\d+$/.test(text)?Number(text):null;return {...p,value:value!==null&&Number.isSafeInteger(value)?value:null};});
 if(!items.some(row=>row.value!==null))throw Error("IBGE 没有可用产量");return {month,collectedAt:r.collectedAt,items};
}
export function referenceState(collectedAt:string,period:string|null,failed=false,now=Date.now()):string {
 if(failed||now-Date.parse(collectedAt)>25*3600000)return "数据未更新";
 if(!period)return "暂不可用";
 if(now-Date.parse(period.slice(0,7)+"-01")>120*86400000)return "历史月份";
 return "月度 · 发布时效未确认";
}

export const conabPage="https://www.gov.br/conab/pt-br/atuacao/informacoes-agropecuarias/safras/safra-de-graos/boletim-da-safra-de-graos";
export const conabProducts=[{id:"total",name:"全国谷物总量（不含皮棉）"},{id:"soybeans",name:"大豆"},{id:"corn",name:"玉米合计"},{id:"corn-first",name:"玉米一季"},{id:"corn-second",name:"玉米二季"},{id:"corn-third",name:"玉米三季"},{id:"cotton-lint",name:"皮棉"},{id:"wheat",name:"小麦（冬季作物）"}] as const;
export interface ConabProductionRow {id:string;name:string;period:string;previousPeriod:string;value:number|null;previous:number|null}
export interface PublicConabSnapshot {sourceUrl:string;collectedAt:string;reportMonth:string;publishedDate:string;season:string;previousSeason:string;surveyNumber:number;items:ConabProductionRow[]}
export function parsePublicConab(raw:unknown):PublicConabSnapshot {
 const r=receipt(raw,"conab-crops"),sourceUrl=(raw as {sourceUrl?:unknown}).sourceUrl;
 if(typeof sourceUrl!=="string"||!sourceUrl.startsWith(conabPage+"/"))throw Error("CONAB 来源无效");
 const m=/^([1-9]|1[0-2])o-levantamento-safra-(20\d{2})-(\d{2})\/site_previsao_de_safra-por_produto-(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)-(20\d{2})\.xlsx$/.exec(sourceUrl.slice(conabPage.length+1));
 if(!m)throw Error("CONAB 数据表地址变化");
 const year=Number(m[2]),month=["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"].indexOf(m[4])+1,season=`${year}/${String((year+1)%100).padStart(2,"0")}`,previousSeason=`${year-1}/${String(year%100).padStart(2,"0")}`,reportMonth=`${m[5]}-${String(month).padStart(2,"0")}`;
 if(Number(m[3])!==(year+1)%100||Number(m[5])!==(month>=10?year:year+1))throw Error("CONAB 链接年度不符");
 const data=JSON.parse(r.body) as Record<string,unknown>,day=data?.publishedDate;
 if(!data||data.unit!=="mil t"||data.scope!=="Brasil"||data.totalExcludes!=="algodão em pluma"||data.season!==season||data.previousSeason!==previousSeason||data.reportMonth!==reportMonth||data.surveyNumber!==Number(m[1]))throw Error("CONAB 范围、年度或千吨单位变化");
 if(typeof day!=="string"||!/^20\d{2}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day||!day.startsWith(reportMonth+"-")||day>new Date(r.collectedAt).toISOString().slice(0,10))throw Error("CONAB 来源发布日期无效");
 if(!Array.isArray(data.items)||data.items.length!==conabProducts.length)throw Error("CONAB 商品列表变化");
 const valid=(v:unknown):v is number|null=>v===null||typeof v==="number"&&Number.isFinite(v)&&v>=0;
 const rows=data.items as Record<string,unknown>[];
 const items=conabProducts.map(p=>{
  const found=rows.filter(v=>v?.id===p.id);if(found.length!==1)throw Error("CONAB 商品缺失或重复");const row=found[0],winter=p.id==="wheat",period=winter?String(year+1):season,previousPeriod=winter?String(year):previousSeason;
  if(row.period!==period||row.previousPeriod!==previousPeriod||!valid(row.value)||!valid(row.previous))throw Error("CONAB 商品年度或产量无效");
  return {...p,period,previousPeriod,value:row.value,previous:row.previous};
 });
 if(!items.some(row=>row.value!==null))throw Error("CONAB 没有可用估产");
 return {sourceUrl,collectedAt:r.collectedAt,reportMonth,publishedDate:day,season,previousSeason,surveyNumber:Number(m[1]),items};
}

export const argentinaPage="https://www.magyp.gob.ar/sitio/areas/estimaciones/estimaciones/informes/";
export const argentinaProducts=[{id:"wheat",name:"小麦"},{id:"corn",name:"玉米"},{id:"soybeans",name:"大豆"}] as const;
export interface ArgentinaProductionRow {id:string;name:string;season:string;previousSeason:string;areaHa:number|null;previousAreaHa:number|null;productionTonnes:number|null;previousProductionTonnes:number|null;page:number}
export interface PublicArgentinaSnapshot {sourceUrl:string;collectedAt:string;publishedDate:string;nextReportDate:string|null;items:ArgentinaProductionRow[]}
const realDay=(value:unknown):value is string=>typeof value==="string"&&/^20\d{2}-(?:0[1-9]|1[0-2])-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
function argentinaSourceDate(value:unknown):string {
 if(typeof value!=="string")throw Error("阿根廷月报来源缺失");let u:URL;try{u=new URL(value);}catch{throw Error("阿根廷月报来源无效");}
 if(u.origin!=="https://www.magyp.gob.ar"||u.search||u.hash)throw Error("阿根廷月报来源无效");
 const m=/^\/sitio\/areas\/estimaciones\/_archivos\/estimaciones\/(\d{2})0000_(20\d{2})\/(\d{4})00_([A-Za-z]+)\/(\d{6})[ _]Informe Mensual al (\d{2})_(\d{2})_(20\d{2})\.pdf$/.exec(decodeURIComponent(u.pathname));
 if(!m)throw Error("阿根廷月报文件格式变化");const day=`${m[8]}-${m[7]}-${m[6]}`,month=Number(m[7]),names=["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
 if(!realDay(day)||m[2]!==m[8]||m[1]!==m[8].slice(2)||m[3]!==m[1]+m[7]||m[4]!==names[month-1]||m[5]!==m[1]+m[7]+m[6])throw Error("阿根廷目录与报告日期不符");return day;
}
export function parsePublicArgentina(raw:unknown):PublicArgentinaSnapshot {
 const r=receipt(raw,"argentina-crops"),sourceUrl=(raw as {sourceUrl?:unknown}).sourceUrl,published=argentinaSourceDate(sourceUrl),data=JSON.parse(r.body) as Record<string,unknown>;
 if(!data||data.scope!=="Argentina nacional"||data.unitArea!=="ha"||data.unitProduction!=="ton"||data.publishedDate!==published||published>new Date(r.collectedAt).toISOString().slice(0,10)||!Array.isArray(data.items)||data.items.length!==3)throw Error("阿根廷报告范围、单位或日期变化");
 const next=data.nextReportDate;if(next!==null&&(!realDay(next)||next<=published))throw Error("阿根廷来源计划日期无效");
 const valid=(n:unknown):n is number|null=>n===null||typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
 const rows=data.items as Record<string,unknown>[];
 const items=argentinaProducts.map(p=>{
  const found=rows.filter(row=>row?.id===p.id);if(found.length!==1)throw Error("阿根廷作物缺失或重复");const row=found[0],season=row.season;
  if(typeof season!=="string"||!/^20\d{2}\/\d{2}$/.test(season))throw Error("阿根廷作物年度无效");const y=Number(season.slice(0,4)),previous=`${y-1}/${String(y%100).padStart(2,"0")}`;
  if(Number(season.slice(5))!==(y+1)%100||row.previousSeason!==previous||!valid(row.areaHa)||!valid(row.previousAreaHa)||!valid(row.productionTonnes)||!valid(row.previousProductionTonnes)||typeof row.page!=="number"||!Number.isInteger(row.page)||row.page<1||row.page>80)throw Error("阿根廷年度、页码或原始数量无效");
  return {...p,season,previousSeason:previous,areaHa:row.areaHa,previousAreaHa:row.previousAreaHa,productionTonnes:row.productionTonnes,previousProductionTonnes:row.previousProductionTonnes,page:row.page};
 });
 if(!items.some(i=>i.areaHa!==null||i.productionTonnes!==null||i.previousProductionTonnes!==null))throw Error("阿根廷月报没有可用数量");
 return {sourceUrl:sourceUrl as string,collectedAt:r.collectedAt,publishedDate:published,nextReportDate:next as string|null,items};
}
