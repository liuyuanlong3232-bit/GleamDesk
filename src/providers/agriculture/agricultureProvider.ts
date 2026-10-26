import {invoke,isTauri} from "@tauri-apps/api/core";
import type {Provider} from "../contracts";
import type {AgricultureData} from "../data";
import {emptySnapshotConnection,snapshotOrigin,type SnapshotConnection,type AgricultureEnvelope} from "../../domain/agriculture/contracts";
export function createAgricultureProvider(connection:SnapshotConnection=emptySnapshotConnection):Provider<AgricultureData>{return {
  id:"agriculture-status",name:"可选 SSH 行情快照",kind:"resource",refreshIntervalMs:isTauri()?300000:null,backgroundRefreshIntervalMs:null,timeoutMs:25000,
  retryPolicy:{maxRetries:0},cacheKey:`snapshot-v7:${JSON.stringify(connection)}`,load:async()=>{
    if(!connection.enabled)return {status:"unavailable",data:null,error:"数据源未启用，可在设置中配置",retryable:false};
    if(!isTauri())return {status:"unavailable",data:null,error:"SSH 数据读取需要桌面程序",retryable:false};
    try{const snapshot=await invoke<AgricultureEnvelope>("read_agriculture_snapshot");if(snapshot.schemaVersion!==1||snapshot.origin!==snapshotOrigin(connection)||!snapshot.snapshots||!Number.isFinite(Date.parse(snapshot.fetchedAt)))throw new Error("快照来源或格式未知");return {status:"normal",data:{type:"agriculture-status",snapshot},observedAt:snapshot.fetchedAt,retryable:false};}
    catch(error){if(typeof error==="string"&&error.startsWith("SNAPSHOT_UNCONFIGURED:"))return {status:"unavailable",data:null,error:"数据源未启用，可在设置中配置",retryable:false};return {status:"error",data:null,error:"数据源读取失败，暂不可用",retryable:false};}
  }
};}
