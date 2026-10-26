import type {ApplicationItem} from "../../types";
export interface ApplicationStatus{id:string;state:"running"|"not-running"|"unknown"|"unsupported";basis:"path"|"process-name"|"none";observedAtUnixMs:number}
export function applicationStatusProbes(applications:ApplicationItem[]){return applications.filter(app=>app.pinned&&app.target.trim()&&(app.type==="exe"||app.type==="shortcut")).slice(0,100).map(app=>({id:app.id,kind:app.type,target:app.target,processName:app.processName??null}));}
export function confirmedRunning(status:ApplicationStatus|undefined,now=Date.now()):boolean{return Boolean(status&&status.state==="running"&&Number.isFinite(status.observedAtUnixMs)&&status.observedAtUnixMs<=now+1000&&now-status.observedAtUnixMs<=15000);}
