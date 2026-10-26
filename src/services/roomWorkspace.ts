import {invoke,isTauri} from "@tauri-apps/api/core";
import {requireRealCallsAllowed} from "./simulationSafety";
import {roomMembers,officialPrice,validateLimits,validateRoom,validateSend,type RoomLimits,type ChatRoom,type ModelConfig,type WorkspaceSend,type WorkspaceSnapshot,type WorkspaceMessage} from "../domain/agent/roomWorkspace";
export interface RoomWorkspaceService{load(scope:string):Promise<WorkspaceSnapshot>;send(request:WorkspaceSend):Promise<WorkspaceSnapshot>;saveRoom(room:ChatRoom):Promise<void>;saveLimits(limits:RoomLimits):Promise<void>;configure(config:ModelConfig,secret?:string):Promise<void>;pause(paused:boolean):Promise<void>;enablePaid(enabled:boolean):Promise<void>;cancel():Promise<void>}
export function blankWorkspace():WorkspaceSnapshot{return {rooms:[],messages:[],models:roomMembers.map(provider=>{const model=provider==="DeepSeek"?"deepseek-flash":provider==="MiMo"?"mimo-v2.6-flash":"",price=officialPrice(provider,model);return {provider,model,inputYuan:price?.inputYuan??null,outputYuan:price?.outputYuan??null,vision:provider==="DeepSeek",quotaSource:provider==="Ollama"?"local" as const:"cash" as const,pricing:"official" as const,priceConfirmation:null,connected:false,credentialSource:null}}),paused:false,paidEnabled:false,usage:{day:new Date(Date.now()+28800000).toISOString().slice(0,10),calls:0,estimatedYuan:0},limits:{calls:100,budgetYuan:3},hasOlder:false}}
type Call=<T>(name:string,args?:Record<string,unknown>)=>Promise<T>;
export function nativeWorkspace(call:Call):RoomWorkspaceService{let sending=false;return {load:scope=>call("agent_room_workspace_load",{scope}),async send(request){validateSend(request);if(sending)throw Error("已有请求正在执行");sending=true;try{await requireRealCallsAllowed();return await call("agent_room_workspace_send",{request})}finally{sending=false}},saveRoom:room=>call("agent_room_workspace_save_room",{room:validateRoom(room)}),saveLimits:limits=>call("agent_room_workspace_save_limits",{limits:validateLimits(limits)}),configure:(config,secret)=>call("agent_room_workspace_configure",{request:{config,secret:secret?.trim()||null}}),pause:paused=>call("agent_room_chat_pause",{paused}),enablePaid:enabled=>call("agent_room_workspace_enable_paid",{enabled}),cancel:()=>call("agent_room_cancel")}}
const browserKey="codex-desktop.agent-room-workspace.v1";
/** Local browser preview deliberately has no inference transport or credential storage. */
export function browserWorkspace(storage:Pick<Storage,"getItem"|"setItem">):RoomWorkspaceService{
 const read=()=>{const raw=storage.getItem(browserKey);if(!raw)return blankWorkspace();const value=JSON.parse(raw) as WorkspaceSnapshot;if(!Array.isArray(value.messages)||!Array.isArray(value.rooms)||!Array.isArray(value.models))throw Error("本地记录格式异常，未清空");return {...value,limits:value.limits??{calls:100,budgetYuan:3}}};
 const write=(value:WorkspaceSnapshot)=>storage.setItem(browserKey,JSON.stringify(value));const scopeValid=(scope:string,value:WorkspaceSnapshot)=>{if(scope!=="notes"&&!roomMembers.some(id=>scope===`direct-${id}`)&&!value.rooms.some(room=>room.id===scope))throw Error("对话不存在")};
 return {async load(scope){const value=read();scopeValid(scope,value);return {...value,messages:value.messages.filter(m=>m.scope===scope),paidEnabled:false,models:value.models.map(c=>({...c,connected:false,credentialSource:null}))}},async send(request){validateSend(request);const value=read();scopeValid(request.scope,value);if(request.provider)throw Error("网页预览只保存普通消息；真实 AI 回复请使用桌面应用");if(value.messages.some(m=>m.id===request.id))throw Error("消息已保存");if(value.messages.length>=1000)throw Error("网页记录达到1000条上限，未删除旧记录");value.messages.push({...request,text:request.text.trim(),role:"user",speaker:"你",createdAt:new Date().toISOString(),status:"saved",error:null,replyTo:null});write(value);return this.load(request.scope)},async saveRoom(room){room=validateRoom(room);const value=read();if(value.rooms.some(r=>r.id!==room.id&&r.name===room.name))throw Error("房间名称已存在");value.rooms=[...value.rooms.filter(r=>r.id!==room.id),room];write(value)},async saveLimits(limits){write({...read(),limits:validateLimits(limits)})},async configure(config,secret){if(secret)throw Error("密钥只能保存到桌面应用的 Windows 凭据管理器");const value=read();value.models=value.models.map(c=>c.provider===config.provider?{...config,connected:false,credentialSource:null}:c);write(value)},async pause(paused){write({...read(),paused})},async enablePaid(enabled){if(enabled)throw Error("网页预览不允许付费调用")},async cancel(){}};
}
export function roomWorkspaceService(){return isTauri()?nativeWorkspace(invoke):browserWorkspace(localStorage)}
const recentScopesKey="codex-desktop.agent-room-recent.v1";
const validRecentScope=(scope:unknown):scope is string=>typeof scope==="string"&&(/^room-[a-zA-Z0-9-]{1,70}$/.test(scope)||roomMembers.some(id=>scope===`direct-${id}`));
export function loadRecentScopes(storage:Pick<Storage,"getItem">):string[]{
 const raw=storage.getItem(recentScopesKey);if(raw===null)return [];
 if(raw.length>8192)throw Error("最近对话列表无法读取，原记录已保留");
 const value=JSON.parse(raw) as {version?:number;scopes?:unknown};
 if(value?.version!==1||!Array.isArray(value.scopes)||value.scopes.length>20||!value.scopes.every(validRecentScope))throw Error("最近对话列表无法读取，原记录已保留");
 return [...new Set(value.scopes)];
}
export function rememberRecentScope(storage:Pick<Storage,"getItem"|"setItem">,scope:string):string[]{
 const current=loadRecentScopes(storage);if(!validRecentScope(scope))return current;
 const next=[scope,...current.filter(id=>id!==scope)].slice(0,20);
 storage.setItem(recentScopesKey,JSON.stringify({version:1,scopes:next}));return next;
}
export function conversationShortcuts(rooms:ChatRoom[],scopes:string[],currentScope:string){
 const label=(scope:string)=>rooms.find(room=>room.id===scope)?.name??(roomMembers.some(id=>scope===`direct-${id}`)?`与 ${scope.slice(7)} 对话`:null);
 const last=scopes.find(scope=>scope!==currentScope&&label(scope)!==null);
 const recentRooms=scopes.flatMap(scope=>{const room=rooms.find(room=>room.id===scope&&room.id!==currentScope);return room?[room]:[];}).slice(0,3);
 return {last:last?{scope:last,label:label(last)!}:null,rooms:recentRooms.length?recentRooms:rooms.filter(room=>room.id!==currentScope).slice(0,3),hasRecentRooms:recentRooms.length>0};
}
export function transcriptMarkdown(name:string,messages:WorkspaceMessage[]){return `# ${name}\n\n`+messages.map(m=>`## ${m.speaker} · ${m.createdAt}\n\n${m.text}${m.attachments.length?"\n\n附件："+m.attachments.map(a=>a.name).join("、"):""}${m.error?"\n\n状态："+m.error:""}`).join("\n\n")}
