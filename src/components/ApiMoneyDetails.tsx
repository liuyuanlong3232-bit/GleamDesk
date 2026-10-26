import {useEffect,useState} from "react";
import type {ProviderStatus} from "../types";
import {apiMoneyView} from "../presentation/quotaAdapter";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";

/** Local display clock only: never polls a provider or sends a request. */
export function useApiMoneyClock(){
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{let timer:number|undefined;const restart=()=>{if(timer!==undefined)window.clearInterval(timer);timer=undefined;if(isWindowVisible()){setNow(Date.now());timer=window.setInterval(()=>setNow(Date.now()),30000)}};restart();const stop=subscribeWindowVisibility(restart);return()=>{stop();if(timer!==undefined)window.clearInterval(timer)}},[]);
  return now;
}
export function ApiMoneyDetails({api,now=Date.now()}:{api:ProviderStatus;now?:number}){
  const view=apiMoneyView(api,now);
  return <div className={`api-money-details${view.note?" has-note":""}`}>
    <div className="api-money-primary"><span>{view.label}</span><strong>{view.primary}</strong></div>
    {!view.balanceScope&&<small>今日 {view.today} · {api.apiPeriodTimeZone==="UTC"?"UTC":api.apiPeriodTimeZone==="Asia/Shanghai"?"北京时间":view.scope==="demo"?"开发模拟":"时区未确认"}</small>}
    {view.note&&<small className="api-money-state">{view.note}</small>}
    <small>读取于 {view.stamp}{view.stamp!=="未知"?"（北京时间）":""}</small>
    <details><summary>来源与统计区间</summary><small>{api.detail||"来源暂不可用"}</small>{api.sourceUrl&&<small>{api.sourceUrl}</small>}<small>{view.period}</small>
      {view.showPrevious&&<small>上次记录（非当前） · {view.previous}</small>}
    </details>
  </div>;
}
