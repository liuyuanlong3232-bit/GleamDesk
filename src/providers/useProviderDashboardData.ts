import { useEffect, useState } from "react";
import type { ApiConnectionSettings, DashboardData } from "../types";
import { emptyDashboardData } from "./dashboardAdapter";
import { mergeDashboardData, refreshDashboardData } from "./dashboardService";
import { startProviderPolling } from "./pollingLifecycle";
import { providersFor } from "./registry";
import type { BeszelProviderConfig } from "./server/beszelProvider";
import { logEvent } from "../services/appLogger";
import { isWindowVisible, subscribeWindowVisibility } from "../services/windowVisibility";
import {listen} from "@tauri-apps/api/event";
import {isTauri} from "@tauri-apps/api/core";

export function useProviderDashboardData(providerIds: string[], beszelConfig: BeszelProviderConfig, includeLiveProviders = true, apiConfig?: ApiConnectionSettings, stockSymbols:string[]=[]): DashboardData {
  const ids = [...new Set(providerIds)].sort();
  const providerKey = JSON.stringify({ ids, beszelConfig, includeLiveProviders, apiConfig, stockSymbols });
  const [data, setData] = useState<DashboardData>(emptyDashboardData);

  useEffect(() => {
    let active = true;
    let sourceGeneration=0;
    const { ids: selectedIds, beszelConfig: config, includeLiveProviders: allowLive, apiConfig: api, stockSymbols: selectedStocks } = JSON.parse(providerKey) as { ids: string[]; beszelConfig: BeszelProviderConfig; includeLiveProviders: boolean; apiConfig?: ApiConnectionSettings;stockSymbols:string[] };
    setData(emptyDashboardData());
    const refresh = (ids: string[], force = false) => {
      const generation=sourceGeneration;
      void refreshDashboardData(ids, config, allowLive, api, force, selectedStocks).then((snapshot) => {
        if (active&&generation===sourceGeneration) setData((current) => mergeDashboardData(current, snapshot));
      }).catch((error: unknown) => {
        if (!active) return;
        logEvent("error", "provider.dashboard_refresh_failed", { message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
      });
    };
    const providers = providersFor(selectedIds, config, { includeLiveProviders: allowLive, apiConfig: api,stockSymbols:selectedStocks });
    const stopPolling = startProviderPolling(selectedIds, providers, refresh, {
      isVisible: isWindowVisible,
      subscribeVisibility: subscribeWindowVisibility,
      setInterval: (callback, milliseconds) => window.setInterval(callback, milliseconds),
      clearInterval: (timerId) => window.clearInterval(timerId),
    });
    const refreshAgents=()=>{if(allowLive&&selectedIds.includes("agent-quotas"))refresh(["agent-quotas","ollama-local"],true);};
    window.addEventListener("codex-desktop.agents-refresh",refreshAgents);
    const sourceChanged=()=>{window.dispatchEvent(new Event("codex-desktop.custom-http-config-changed"));sourceGeneration++;setData(current=>({...current,agriculture:null,publicWeather:null,customMarket:null,publicNews:null,publicMarket:null,publicAStocks:null,publicChinaFutures:null,publicOverseasFutures:null,publicCftc:null,publicWasde:null,publicInspections:null,publicNoaa:null,nassAnnual:null,cropProgress:null,publicMonthly:null,publicIbge:null,publicConab:null,publicArgentina:null}));if(allowLive)refresh(selectedIds.filter(id=>["agriculture-status","public-weather","custom-market-quotes","public-news","public-a-shares","public-cn-futures","public-overseas-futures","public-market","public-cftc","public-wasde","public-inspections","public-noaa","public-nass-annual","public-crop-progress","public-monthly","public-ibge","public-conab","public-argentina"].includes(id)),true);};
    const customRefreshed=()=>{if(allowLive&&selectedIds.includes("custom-market-quotes"))refresh(["custom-market-quotes"],true);};
    window.addEventListener("codex-desktop.custom-http-refresh",customRefreshed);
    let stopSource:(()=>void)|undefined;
    if(isTauri())void listen("snapshot-connection-changed",sourceChanged).then(stop=>{if(active)stopSource=stop;else stop();}).catch(()=>{});
    return () => {
      window.removeEventListener("codex-desktop.agents-refresh",refreshAgents);
      window.removeEventListener("codex-desktop.custom-http-refresh",customRefreshed);
      stopSource?.();
      active = false;
      stopPolling();
    };
  }, [providerKey]);

  return data;
}
