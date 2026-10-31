import {invoke} from "@tauri-apps/api/core";

export type LocalAgentId="codex"|"claude"|"antigravity"|"opencode";
export interface LocalAgentProvider{id:LocalAgentId;name:string;available:boolean}
export interface LocalAgentTaskRequest{taskId:string;agent:LocalAgentId;directory:string;prompt:string}
export interface LocalAgentTaskReceipt{taskId:string;agent:string;status:"completed"|"failed"|"cancelled";exitCode:number|null}
export interface LocalAgentTaskEvent{taskId:string;agent:string;status:"running"|"completed"|"failed"|"cancelled";output?:string|null;diagnostic?:string|null;exitCode?:number|null;message?:string|null}

export const listLocalAgents=()=>invoke<LocalAgentProvider[]>("agent_task_list");
export const pickLocalTaskDirectory=()=>invoke<string|null>("agent_task_pick_directory");
export const runLocalAgentTask=(request:LocalAgentTaskRequest)=>invoke<LocalAgentTaskReceipt>("agent_task_run",{request});
export const cancelLocalAgentTask=(taskId:string)=>invoke<void>("agent_task_cancel",{taskId});
