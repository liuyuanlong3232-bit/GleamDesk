import {invoke,isTauri} from "@tauri-apps/api/core";
import {loadSettings} from "../providers/settingsStore";

const blockedMessage="模拟模式已开启，已阻止真实调用；草稿保留";
let runtimeBlocked=false;
let generation=0;
let synchronization:Promise<void>=Promise.resolve();

/** Synchronize a process-wide native gate; failed synchronization keeps sends blocked. */
export function syncSimulationMode(enabled:boolean):Promise<void>{
 if(runtimeBlocked!==enabled)generation++;
 runtimeBlocked=enabled;
 synchronization=synchronization.catch(()=>{}).then(async()=>{
  if(isTauri())await invoke("set_simulation_mode",{enabled:enabled||loadSettings().simulationEnabled});
 });
 return synchronization;
}
export async function requireRealCallsAllowed(simulationEnabled=false):Promise<void>{
 const admittedGeneration=generation;
 const check=()=>{if(simulationEnabled||runtimeBlocked||loadSettings().simulationEnabled||admittedGeneration!==generation)throw Error(blockedMessage)};
 check();await synchronization;check();
}
export async function invokeLive<T>(command:string,args?:Record<string,unknown>,simulationEnabled=false):Promise<T>{
 await requireRealCallsAllowed(simulationEnabled);
 return invoke<T>(command,args);
}
