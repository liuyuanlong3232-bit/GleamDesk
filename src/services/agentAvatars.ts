import {connectorNames,type ConnectorId} from "../domain/agent/agentRoom";
export type AvatarId=ConnectorId|"GPT"|"Gemini"|"Kimi"|"Grok"|"你";
export type AvatarPhase="idle"|"requesting"|"reply";
export const avatarPhases:AvatarPhase[]=["idle","requesting","reply"];
export const avatarPhaseNames:Record<AvatarPhase,string>={idle:"待机",requesting:"等待接口回复",reply:"展示回复"};
interface AvatarMedia {key:string;blob:Blob;name:string}
const database="codex-desktop-room-avatars",eventName="codex-desktop.avatar-updated";
const revisionKey="codex-desktop.avatar-revision.v1";
const sourcePrefix="codex-desktop.avatar-source.v1.";
export function customAvatarEnabled(id:AvatarId):boolean{try{return localStorage.getItem(sourcePrefix+id)==="custom"}catch{return false}}
function selectAvatarSource(id:AvatarId,source:"theme"|"custom"){mediaKey(id,"idle");try{localStorage.setItem(sourcePrefix+id,source)}catch{throw Error("头像选择未能保存，请重试")}notifyAvatars();}
export async function selectSavedAvatar(id:AvatarId){if(!await loadAvatar(id,"idle"))throw Error("没有此前保存的自选头像");selectAvatarSource(id,"custom");}
function notifyAvatars(){window.dispatchEvent(new Event(eventName));try{localStorage.setItem(revisionKey,`${Date.now()}-${Math.random()}`)}catch{/* Saved media remains available when reopening a window. */}}
let opening:Promise<IDBDatabase>|undefined;
function db(){return opening??=new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(database,1);request.onupgradeneeded=()=>request.result.createObjectStore("media",{keyPath:"key"});request.onsuccess=()=>{const result=request.result;result.onversionchange=()=>{result.close();opening=undefined;};resolve(result);};request.onerror=()=>{opening=undefined;reject(new Error("本机形象存储无法打开"));};});}
function mediaKey(id:AvatarId,phase:AvatarPhase){if(!([...connectorNames,"GPT","Gemini","Kimi","Grok","你"] as string[]).includes(id)||!avatarPhases.includes(phase))throw new Error("形象设置无效");return `${id}:${phase}`;}
export async function validateAvatar(file:File):Promise<void>{
 const video=["video/mp4","video/webm"].includes(file.type);
 if(!["image/png","image/jpeg","image/gif","image/webp","video/mp4","video/webm"].includes(file.type))throw new Error("请选择 PNG、JPEG、GIF、WebP、MP4 或 WebM 文件");
 if(file.size===0||file.size>(video?20:8)*1024*1024)throw new Error(video?"视频最大20MB":"图片最大8MB");
 const b=new Uint8Array(await file.slice(0,16).arrayBuffer());const ascii=(a:number,z:number)=>String.fromCharCode(...b.slice(a,z));
 const valid=file.type==="image/png"?b[0]===137&&ascii(1,4)==="PNG":file.type==="image/jpeg"?b[0]===255&&b[1]===216&&b[2]===255:file.type==="image/gif"?["GIF87a","GIF89a"].includes(ascii(0,6)):file.type==="image/webp"?ascii(0,4)==="RIFF"&&ascii(8,12)==="WEBP":file.type==="video/mp4"?ascii(4,8)==="ftyp":b[0]===26&&b[1]===69&&b[2]===223&&b[3]===163;
 if(!valid)throw new Error("文件内容与格式不符");
}
export async function saveAvatar(id:AvatarId,phase:AvatarPhase,file:File){
 await validateAvatar(file);const key=mediaKey(id,phase),database=await db();
 await new Promise<void>((resolve,reject)=>{const tx=database.transaction("media","readwrite"),store=tx.objectStore("media");store.getAll().onsuccess=event=>{const records=(event.target as IDBRequest<AvatarMedia[]>).result;const size=records.filter(record=>record.key!==key).reduce((sum,record)=>sum+record.blob.size,0)+file.size;if(size>96*1024*1024){tx.abort();return;}store.put({key,blob:file.slice(0,file.size,file.type),name:file.name.slice(0,120)});};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(new Error("形象保存失败"));tx.onabort=()=>reject(new Error("形象总容量上限96MB，请先替换较大的素材"));});
 if(phase==="idle")selectAvatarSource(id,"custom");else notifyAvatars();
}
export async function loadAvatar(id:AvatarId,phase:AvatarPhase):Promise<AvatarMedia|undefined>{const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction("media","readonly"),store=tx.objectStore("media"),request=store.get(mediaKey(id,phase));request.onsuccess=()=>{if(request.result||phase==="idle")resolve(request.result);else{const fallback=store.get(mediaKey(id,"idle"));fallback.onsuccess=()=>resolve(fallback.result);fallback.onerror=()=>reject(new Error("形象读取失败"));}};request.onerror=()=>reject(new Error("形象读取失败"));});}
export async function resetAvatar(id:AvatarId,phase:AvatarPhase){if(phase==="idle"){selectAvatarSource(id,"theme");return;}const database=await db();await new Promise<void>((resolve,reject)=>{const tx=database.transaction("media","readwrite");tx.objectStore("media").delete(mediaKey(id,phase));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(new Error("无法恢复默认形象"));});notifyAvatars();}
export function subscribeAvatars(onChange:()=>void){const storage=(event:StorageEvent)=>{if(event.key===revisionKey)onChange()};window.addEventListener(eventName,onChange);window.addEventListener("storage",storage);return()=>{window.removeEventListener(eventName,onChange);window.removeEventListener("storage",storage);};}
