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
import {readAgentAccountRevision,quotaAgentIds} from "./agents/agentUsageProvider";

export function useProviderDashboardData(providerIds: string[], beszelConfig: BeszelProviderConfig, includeLiveProviders = true, apiConfig?: ApiConnectionSettings, stockSymbols:string[]=[]): DashboardData {
  const ids = [...new Set(providerIds)].sort();
  const providerKey = JSON.stringify({ ids, beszelConfig, includeLiveProviders, apiConfig, stockSymbols });
  const [data, setData] = useState<DashboardData>(emptyDashboardData);

  useEffect(() => {
    let active = true;
    let sourceGeneration=0;
    const { ids: selectedIds, beszelConfig: config, includeLiveProviders: allowLive, apiConfig: api, stockSymbols: selectedStocks } = JSON.parse(providerKey) as { ids: string[]; beszelConfig: BeszelProviderConfig; includeLiveProviders: boolean; apiConfig?: ApiConnectionSettings;stockSymbols:string[] };
    const monitorAccounts=allowLive&&api?.localAgentUsageEnabled===true&&selectedIds.includes("agent-quotas")&&isTauri();
    const accounts=new Map(quotaAgentIds.map(id=>[id,{revision:undefined as string|undefined,pending:false,generation:0}]));
    setData(emptyDashboardData());
    const refresh = (ids: string[], force = false) => {
      if(monitorAccounts&&ids.includes("agent-quotas")){
        for(const id of quotaAgentIds)void checkAccountRevision(id,true,force);
        ids=ids.filter(id=>id!=="agent-quotas");
      }
      if(!ids.length)return;
      const generation=sourceGeneration;
      void refreshDashboardData(ids, config, allowLive, api, force, selectedStocks).then((snapshot) => {
        if (active&&generation===sourceGeneration) setData((current) => mergeDashboardData(current, snapshot));
      }).catch((error: unknown) => {
        if (!active) return;
        logEvent("error", "provider.dashboard_refresh_failed", { message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
      });
    };
    const clearAccountQuota=(id:string)=>setData(current=>({...current,providers:current.providers.filter(provider=>provider.kind!=="agent"||provider.id!==id),providerDiagnostics:current.providerDiagnostics?.filter(provider=>provider.providerId!==`agent-quotas-${id}`)??[]}));
    const checkAccountRevision=async(id:typeof quotaAgentIds[number],refreshQuota=false,force=false)=>{
      const account=accounts.get(id)!;
      if(!monitorAccounts||!active||account.pending||(!force&&!isWindowVisible()))return;
      account.pending=true;
      try{
        const next=await readAgentAccountRevision(true,id);if(!active)return;
        const changed=next!==account.revision;
        if(changed){account.revision=next;account.generation++;clearAccountQuota(id);}
        if(changed||refreshQuota){
          const generation=account.generation;
          void refreshDashboardData(["agent-quotas"],config,allowLive,api,force,selectedStocks,next,id).then(snapshot=>{
            if(active&&generation===account.generation&&next===account.revision)setData(current=>mergeDashboardData(current,snapshot));
          }).catch(()=>{if(active&&generation===account.generation)logEvent("warn","provider.agent_refresh_failed",{agent:id});});
        }
      }catch{if(active){account.revision=undefined;account.generation++;clearAccountQuota(id);}}
      finally{account.pending=false;}
    };
    const providers = providersFor(selectedIds, config, { includeLiveProviders: allowLive, apiConfig: api,stockSymbols:selectedStocks });
    const stopPolling = startProviderPolling(selectedIds, providers, refresh, {
      isVisible: isWindowVisible,
      subscribeVisibility: subscribeWindowVisibility,
      setInterval: (callback, milliseconds) => window.setInterval(callback, milliseconds),
      clearInterval: (timerId) => window.clearInterval(timerId),
    });
    const checkAccounts=()=>{for(const id of quotaAgentIds)void checkAccountRevision(id);};
    const accountTimer=monitorAccounts?window.setInterval(checkAccounts,10_000):undefined;
    const stopAccountVisibility=monitorAccounts?subscribeWindowVisibility(()=>{if(isWindowVisible())checkAccounts();}):undefined;
    if(monitorAccounts)checkAccounts();
    const refreshAgents=(event?:unknown)=>{
      const id=(event as {detail?:{agentId?:string}}|undefined)?.detail?.agentId;
      if(monitorAccounts&&quotaAgentIds.some(agent=>agent===id)){void checkAccountRevision(id as typeof quotaAgentIds[number],true);return;}
      // Settings already performed its forced read. Other windows reuse that
      // verified native result instead of issuing the same six queries again.
      if(allowLive&&selectedIds.includes("agent-quotas"))refresh(["agent-quotas","ollama-local"]);
    };
    window.addEventListener("codex-desktop.agents-refresh",refreshAgents);
    const sourceChanged=()=>{window.dispatchEvent(new Event("codex-desktop.custom-http-config-changed"));sourceGeneration++;setData(current=>({...current,agriculture:null,publicWeather:null,customMarket:null,publicNews:null,publicMarket:null,publicAStocks:null,publicChinaFutures:null,publicOverseasFutures:null,publicCftc:null,publicWasde:null,publicInspections:null,publicNoaa:null,nassAnnual:null,cropProgress:null,publicMonthly:null,publicIbge:null,publicConab:null,publicArgentina:null}));if(allowLive)refresh(selectedIds.filter(id=>["agriculture-status","public-weather","custom-market-quotes","public-news","public-a-shares","public-cn-futures","public-overseas-futures","public-market","public-cftc","public-wasde","public-inspections","public-noaa","public-nass-annual","public-crop-progress","public-monthly","public-ibge","public-conab","public-argentina"].includes(id)),true);};
    const customRefreshed=()=>{if(allowLive&&selectedIds.includes("custom-market-quotes"))refresh(["custom-market-quotes"],true);};
    window.addEventListener("codex-desktop.custom-http-refresh",customRefreshed);
    let stopSource:(()=>void)|undefined;
    let stopAgents:(()=>void)|undefined;
    if(isTauri())void listen("snapshot-connection-changed",sourceChanged).then(stop=>{if(active)stopSource=stop;else stop();}).catch(()=>{});
    if(isTauri())void listen("agent-usage-changed",refreshAgents).then(stop=>{if(active)stopAgents=stop;else stop();}).catch(()=>{});
    return () => {
      window.removeEventListener("codex-desktop.agents-refresh",refreshAgents);
      window.removeEventListener("codex-desktop.custom-http-refresh",customRefreshed);
      stopSource?.();
      stopAgents?.();
      if(accountTimer!==undefined)window.clearInterval(accountTimer);
      stopAccountVisibility?.();
      active = false;
      stopPolling();
    };
  }, [providerKey]);

  return data;
}
