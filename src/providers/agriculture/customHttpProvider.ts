import {isTauri} from "@tauri-apps/api/core";
import {invokeLive} from "../../services/simulationSafety";
import {mapCustomQuotes,type CustomHttpSource,type CustomQuoteResult} from "../../domain/agriculture/customHttpQuotes";
import type {Provider} from "../contracts";import type {CustomMarketData} from "../data";
export function createCustomHttpProvider(sources:CustomHttpSource[]=[]):Provider<CustomMarketData>{
 const selected=sources.filter(source=>source.enabled);
 return {id:"custom-market-quotes",name:"自定义行情",kind:"resource",refreshIntervalMs:60000,backgroundRefreshIntervalMs:null,timeoutMs:45000,retryPolicy:{maxRetries:0},cacheKey:`custom-http-v1:${JSON.stringify(sources)}`,
 load:async()=>{
  if(!isTauri()||!selected.length)return {status:"unavailable",data:null,retryable:false};
  const results=await Promise.all(selected.map(async(source):Promise<CustomQuoteResult>=>{
   const result:CustomQuoteResult={id:source.id,name:source.name,dataType:source.dataType,staleMinutes:source.staleMinutes,receivedAt:null,status:"error",error:"",quotes:[]};
   try{
    const raw=await invokeLive<{id:string;status:string;receivedAt:string|null;payload:unknown;error:string}>("read_custom_http_source",{id:source.id,refresh:false});
    if(raw.id!==source.id||!["normal","stale","unread","error"].includes(raw.status))throw Error("自定义来源响应无效");
    if(raw.status==="unread")return {...result,status:"unread"};
    if(raw.status==="error")return {...result,error:raw.error||"接口暂不可用"};
    if(!raw.receivedAt||!Number.isFinite(Date.parse(raw.receivedAt)))throw Error("接口读取时间无效");
    const mapped=mapCustomQuotes(raw.payload,source);result.quotes=mapped.quotes;result.receivedAt=raw.receivedAt;
    result.status=raw.status==="stale"?"stale":mapped.ignored||mapped.quotes.some(q=>q.warning)?"partial":"normal";
    result.error=raw.error||(mapped.ignored?`${mapped.ignored} 条记录未识别到代码，已跳过`:result.status==="partial"?"部分字段缺失或格式不符，详见各行":"");return result;
   }catch(error){return {...result,status:"error",error:typeof error==="string"?error:error instanceof Error?error.message:"自定义行情暂不可用"};}
  }));
  return {status:results.every(source=>source.status==="normal")?"normal":"degraded",data:{type:"custom-market-quotes",snapshot:{sources:results}},retryable:false};
 }};
}
