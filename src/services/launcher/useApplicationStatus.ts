import {useEffect,useState} from "react";
import {invoke,isTauri} from "@tauri-apps/api/core";
import type {ApplicationItem} from "../../types";
import {applicationStatusProbes,type ApplicationStatus} from "./applicationStatus";
import {isWindowVisible,subscribeWindowVisibility} from "../windowVisibility";
export function useApplicationStatus(applications:ApplicationItem[],enabled=true){
  const [statuses,setStatuses]=useState<Record<string,ApplicationStatus>>({});
  const key=JSON.stringify(applicationStatusProbes(applications));
  useEffect(()=>{
    if(!enabled){setStatuses({});return;}
    let active=true,inFlight=false,timer=0,revision=0;const probes=JSON.parse(key);
    const refresh=async()=>{
      window.clearTimeout(timer);if(!active||!isWindowVisible()){revision++;setStatuses({});return;}if(inFlight)return;
      if(!isTauri()||!probes.length){setStatuses({});return;}inFlight=true;const current=revision;
      try{const rows=await invoke<ApplicationStatus[]>("read_application_statuses",{probes});if(active&&current===revision&&isWindowVisible())setStatuses(Object.fromEntries(rows.map(row=>[row.id,row])));}catch{if(active&&current===revision)setStatuses({});}
      finally{inFlight=false;if(active&&isWindowVisible())timer=window.setTimeout(()=>void refresh(),10000);}
    };
    const visible=()=>{revision++;window.clearTimeout(timer);if(!isWindowVisible())setStatuses({});else void refresh();};
    setStatuses({});const stop=subscribeWindowVisibility(visible);void refresh();return()=>{active=false;revision++;window.clearTimeout(timer);stop();};
  },[key,enabled]);return statuses;
}
