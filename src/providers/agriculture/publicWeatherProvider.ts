import {isTauri} from "@tauri-apps/api/core";
import {invokeLive} from "../../services/simulationSafety";
import {parsePublicWeather} from "../../domain/agriculture/publicWeather";
import type {Provider} from "../contracts";
import type {PublicWeatherData} from "../data";
export function createPublicWeatherProvider(enabled=false):Provider<PublicWeatherData>{return {
 id:"public-weather",name:"Open-Meteo 免费天气",kind:"resource",refreshIntervalMs:3600000,backgroundRefreshIntervalMs:null,timeoutMs:25000,retryPolicy:{maxRetries:0},cacheKey:`public-weather-v3:${enabled}`,
 load:async signal=>{
  if(!enabled||!isTauri())return {status:"unavailable",data:null,retryable:false};
  try{if(signal.aborted)throw Error("cancelled");const raw=await invokeLive("read_public_weather");if(signal.aborted)throw Error("cancelled");const snapshot=parsePublicWeather(raw);const partial=Boolean(snapshot.issues?.length)||snapshot.weather.some(row=>row.maximum===null||row.precip===null);return {status:partial?"degraded":"normal",data:{type:"public-weather",snapshot},observedAt:snapshot.collectedAt,error:partial?"部分产区或天气字段暂不可用":undefined,retryable:false};}
  catch{return {status:"error",data:null,error:"公开天气读取失败，暂不可用；保留的旧结果按采集时间显示",retryable:false};}
 }
};}
