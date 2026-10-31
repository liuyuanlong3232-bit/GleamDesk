import {invoke} from "@tauri-apps/api/core";

export interface AgentTaskModel{provider:string;model:string;available:boolean;protocolSupported:boolean;verified:boolean;priceConfirmed:boolean;reason:string|null}
export interface AgentTaskCatalog{models:AgentTaskModel[];paidEnabled:boolean}
export interface AgentTaskRequest{taskId:string;provider:string;model:string;directory:string;prompt:string}
export interface AgentTaskResolveRequest{taskId:string;approvalId:string;approved:boolean}
export interface AgentTaskReceipt{taskId:string;provider:string;model:string;status:"completed"|"failed"|"cancelled"}
export interface AgentTaskApproval{id:string;kind:"edit"|"command";path:string|null;before:string|null;after:string|null;command:string|null;directory:string|null;permissionNotice:string|null;outputNotice:string|null}
export interface AgentTaskCommandResult{exitCode:number|null;output:string;truncated:boolean}
export interface AgentTaskEvent{taskId:string;provider:string;model:string;status:"running"|"approval_required"|"completed"|"failed"|"cancelled";progress:string|null;output:string|null;approval:AgentTaskApproval|null;commandResult:AgentTaskCommandResult|null;error:string|null}
export type AgentTaskStatus="idle"|"starting"|AgentTaskEvent["status"];
export interface AgentTaskRuntimeState{status:AgentTaskStatus;progress:string;output:string;commands:AgentTaskCommandResult[];approval:AgentTaskApproval|null;error:string}

export const emptyAgentTaskRuntime=():AgentTaskRuntimeState=>({status:"idle",progress:"",output:"",commands:[],approval:null,error:""});
export function canStartAgentTask(model:AgentTaskModel|undefined,catalog:AgentTaskCatalog,simulationEnabled:boolean){return Boolean(model?.available&&model.protocolSupported&&!simulationEnabled&&(model.provider==="Ollama"||(model.priceConfirmed&&catalog.paidEnabled)))}
export function applyAgentTaskEvent(state:AgentTaskRuntimeState,event:AgentTaskEvent):AgentTaskRuntimeState{
 const status=event.approval?"approval_required":event.status;
 const output=event.output?(status==="completed"?event.output:`${state.output}${state.output?"\n":""}${event.output}`.slice(-64_000)):state.output;
 return {status,progress:event.progress??state.progress,output,commands:event.commandResult?[...state.commands,event.commandResult].slice(-5):state.commands,approval:event.approval??(event.status==="running"||status!=="approval_required"?null:state.approval),error:event.error??state.error};
}

export const listLocalAgents=()=>invoke<AgentTaskCatalog>("agent_task_list");
export const pickLocalTaskDirectory=()=>invoke<string|null>("agent_task_pick_directory");
export const runLocalAgentTask=(request:AgentTaskRequest)=>invoke<AgentTaskReceipt>("agent_task_run",{request});
export const resolveLocalAgentTask=(request:AgentTaskResolveRequest)=>invoke<void>("agent_task_resolve",{request});
export const cancelLocalAgentTask=(taskId:string)=>invoke<void>("agent_task_cancel",{taskId});
