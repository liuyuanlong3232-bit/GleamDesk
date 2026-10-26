import {useEffect,useState} from "react";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";
import type {AgricultureEnvelope} from "../domain/agriculture/contracts";
import {marketQuotes} from "../domain/agriculture/marketQuotes";
export interface PricePoint{at:number;value:number}
export function priceHistory(envelope:AgricultureEnvelope|null|undefined,symbol:string,days=30):PricePoint[]{
  if(!envelope||!symbol)return [];
  const now=Date.now();
  return (marketQuotes(envelope).get(symbol)??[]).filter(row=>row.dataType==="daily"&&row.at<=now+86400000&&row.at>=now-days*86400000).map(({at,value})=>({at,value}));
}
export function intervalChange(points:PricePoint[]):number|null{if(points.length<2||points[0].value===0)return null;return (points.at(-1)!.value/points[0].value-1)*100;}
export function Sparkline({points}:{points:PricePoint[]}){if(points.length<2)return <span className="research-no-trend">历史不足</span>;const min=Math.min(...points.map(point=>point.value)),max=Math.max(...points.map(point=>point.value));const first=points[0].at,last=points.at(-1)!.at;const coords=points.map(point=>`${((point.at-first)/Math.max(1,last-first)*100).toFixed(1)},${(24-(point.value-min)/Math.max(1e-9,max-min)*20).toFixed(1)}`).join(" ");return <svg className="research-spark" viewBox="0 0 100 28" role="img" aria-label="真实每日历史趋势"><polyline points={coords}/></svg>;}
export interface ComparisonSeries{name:string;points:PricePoint[];color:string;category?:"agriculture"|"metal"|"macro"|"energy"}
export function comparisonMovement(points:PricePoint[]):"loss"|"gain"|"neutral"|"unknown"{
  if(points.length<2||points.some(point=>!Number.isFinite(point.at)||!Number.isFinite(point.value)))return "unknown";
  const change=intervalChange(points);if(change===null||!Number.isFinite(change))return "unknown";
  return change<=-5?"loss":change>0?"gain":"neutral";
}
export function OverviewChart({series,days,onDays,visible=true}:{series:ComparisonSeries[];days:number;onDays:(days:number)=>void;visible?:boolean}){
  const [windowVisible,setWindowVisible]=useState(true);
  useEffect(()=>{const update=()=>setWindowVisible(isWindowVisible());update();return subscribeWindowVisibility(update);},[]);
  const valid=series.filter(item=>item.points.length>=2&&item.points[0].value!==0&&item.points.every(point=>Number.isFinite(point.at)&&Number.isFinite(point.value)));const all=valid.flatMap(item=>item.points);const from=all.length?Math.min(...all.map(point=>point.at)):0,to=all.length?Math.max(...all.map(point=>point.at)):1;
  const returns=valid.flatMap(item=>item.points.map(point=>(point.value/item.points[0].value-1)*100));const bound=Math.max(1,...returns.map(Math.abs));
  return <div className={`research-chart research-chart-tech${visible&&windowVisible?" research-chart-motion":""}`}><nav>{[[1,"1D"],[7,"1W"],[30,"1M"]].map(([value,label])=><button key={value} aria-pressed={days===value} onClick={()=>onDays(Number(value))}>{label}</button>)}<small>每日快照 · 相对区间首条记录</small></nav><div className="research-chart-area">{valid.length?<><div className="research-chart-axis"><span>{bound.toFixed(1)}%</span><span>0%</span><span>-{bound.toFixed(1)}%</span></div><svg viewBox="0 0 500 220" preserveAspectRatio="none" role="img" aria-label="真实每日价格区间对比">{valid.map(item=>{
    const coords=item.points.map(point=>`${((point.at-from)/Math.max(1,to-from)*490+5).toFixed(2)},${(110-(point.value/item.points[0].value-1)*100/bound*100).toFixed(2)}`).join(" ");
    return <g key={item.name}>{(item.category==="agriculture"||item.category==="metal")&&<polyline className={`research-category-edge research-edge-${item.category}`} points={coords} aria-hidden="true"/>}<polyline className={`research-price-line research-line-${item.category??"default"}`} style={{stroke:item.color}} points={coords}/></g>;
  })}</svg></>:<div className="research-empty-chart">有效历史观测不足</div>}</div><div className="research-chart-dates"><span>{from?new Date(from).toLocaleDateString("zh-CN"):"来源日期未知"}</span><span>{to>1?new Date(to).toLocaleDateString("zh-CN"):""}</span></div><div className="research-chart-legend">{series.map(item=>{
    const movement=comparisonMovement(item.points),change=movement==="unknown"?null:intervalChange(item.points);
    const label=movement==="loss"?"区间跌幅达到 5%":movement==="gain"?"区间上涨":movement==="unknown"?"历史不足或无有效变化":"区间跌幅未达 5% 或持平";
    return <span key={item.name} className={`research-series-${item.category??"default"} research-status-${movement}`} title={`${label}；按当前所选区间计算，红灯阈值为 -5%`}><i style={{background:item.color}}/>{item.name} <b>{change===null?"—":`${change>0?"+":""}${change.toFixed(2)}%`}</b><i className={`research-movement research-movement-${movement}`} role="img" aria-label={`${item.name}：${label}`} title={`${label}；按当前所选区间计算，红灯阈值为 -5%`}/></span>;
  })}</div></div>;
}
