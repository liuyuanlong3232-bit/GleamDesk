import type { ApiConnectionSettings, DashboardData } from "../types";
import type { Provider } from "./contracts";
import { adaptProviderSnapshots, mergeDashboardData } from "./dashboardAdapter";
import type { ProviderData } from "./data";
import { providersFor } from "./registry";
import { providerRuntime } from "./providerRuntime";
import type { BeszelProviderConfig } from "./server/beszelProvider";
import { publishProviderNotifications } from "../services/notifications/providerNotifications";
import {invoke,isTauri} from "@tauri-apps/api/core";
import type {SnapshotConnection} from "../domain/agriculture/contracts";

export async function refreshDashboardData(
  providerIds: string[],
  beszelConfig?: BeszelProviderConfig,
  includeLiveProviders = true,
  apiConfig?: ApiConnectionSettings,
  force = false,
  stockSymbols:string[] = [],
): Promise<DashboardData> {
  let snapshotConnection:SnapshotConnection|undefined,configurationFailed=false;
  if(includeLiveProviders&&isTauri()&&providerIds.some(id=>["agriculture-status","public-weather","custom-market-quotes","public-news","public-a-shares","public-cn-futures","public-overseas-futures","public-market","public-cftc","public-wasde","public-inspections","public-noaa","public-nass-annual","public-crop-progress","public-monthly","public-ibge","public-conab","public-argentina"].includes(id))){
    try{snapshotConnection=await invoke<SnapshotConnection>("load_snapshot_connection");}catch{configurationFailed=true;}
  }
  const providers: Provider<ProviderData>[] = providersFor(providerIds, beszelConfig, { includeLiveProviders, apiConfig,snapshotConnection,stockSymbols });
  if(configurationFailed){for(const provider of providers.filter(item=>["agriculture-status","public-weather","custom-market-quotes","public-news","public-a-shares","public-cn-futures","public-overseas-futures","public-market","public-cftc","public-wasde","public-inspections","public-noaa","public-nass-annual","public-crop-progress","public-monthly","public-ibge","public-conab","public-argentina"].includes(item.id))){provider.cacheKey="snapshot-config-unreadable";provider.load=async()=>({status:"error",data:null,error:"数据源配置读取失败，原文件已保留",retryable:false});}}
  const snapshots = await Promise.all(providers.map((provider) => providerRuntime.refresh(provider, force)));
  if (includeLiveProviders) await publishProviderNotifications(providers, snapshots);
  return adaptProviderSnapshots(providers, snapshots);
}

export { mergeDashboardData };
