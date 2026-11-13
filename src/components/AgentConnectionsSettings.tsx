import {useEffect,useRef,useState} from "react";
import {invoke,isTauri} from "@tauri-apps/api/core";
import {emit} from "@tauri-apps/api/event";
import {normalizeAgentUsage,readAgentRuntime,readAgentAccountRevision,unavailableAgentRuntime,runningAgentClients} from "../providers/agents/agentUsageProvider";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";
import {launchApplication} from "../services/launcher/launcherService";
import type {AgentQuotaAccount} from "../domain/agent/contracts";

// 只保留真正接入的客户端：这里显示连接状态，不展示额度明细。
const providers=[
  {id:"doubao",name:"豆包",url:"https://www.doubao.com/chat/",hint:"在此单独连接豆包，客户端可保持运行。客户端换号后需重新连接。登录仅在本机加密保存，最长 7 天。",detectOnly:false},
  {id:"codex",name:"Codex",url:"https://chatgpt.com/codex",hint:"通过 Codex CLI 的官方额度接口读取 5 小时与周额度。",detectOnly:false},
  {id:"claude",name:"Claude Code",url:"https://code.claude.com/docs/en/authentication",hint:"读取 Claude Code 客户端的订阅额度与登录状态。",detectOnly:false},
  {id:"antigravity",name:"Antigravity",url:"https://antigravity.google/",hint:"请先启动并登录客户端，然后回到这里刷新。",detectOnly:false},
  {id:"cursor",name:"Cursor",url:"https://cursor.com/",hint:"Cursor 目前没有公开的额度接口，这里只显示是否安装与运行。",detectOnly:true},
  {id:"kimi",name:"Kimi Code",url:"https://www.kimi.com/code",hint:"先在 Kimi Code 登录，再刷新读取额度；登录过期请重新登录。",detectOnly:false},
] as const;

function stateLabel(account:AgentQuotaAccount|undefined,running:boolean,runtimeAvailable:boolean){
  if(!runtimeAvailable)return "运行状态待识别";
  if(account?.loginStatus==="verified")return "已连接";
  if(account?.loginStatus==="configured")return "已保存登录";
  if(account?.loginStatus==="not-logged-in")return "未登录";
  if(account?.installed)return "已安装 · 未连接";
  return running?"运行中":"未检测到";
}

export function AgentConnectionsSettings({enabled=false,onEnabledChange}:{enabled?:boolean;onEnabledChange?:(enabled:boolean)=>void}){
 const generation=useRef(0),allowed=useRef(enabled);allowed.current=enabled;
 const accountStates=useRef(new Map<string,{revision?:string;checking:boolean;generation:number}>()),refreshBatch=useRef(0);
 const [runtime,setRuntime]=useState(unavailableAgentRuntime);
 useEffect(()=>{if(!isTauri())return;let active=true,pending=false;const refresh=async()=>{if(!active||pending||!isWindowVisible())return;pending=true;try{const value=await readAgentRuntime();if(active)setRuntime(value)}finally{pending=false}};void refresh();const timer=window.setInterval(()=>void refresh(),8000);const stop=subscribeWindowVisibility(()=>{if(isWindowVisible())void refresh()});window.addEventListener("codex-desktop.agents-refresh",refresh);return()=>{active=false;window.clearInterval(timer);stop();window.removeEventListener("codex-desktop.agents-refresh",refresh)}},[]);
 const activeClients=new Set(runningAgentClients(runtime).map(client=>client.id));
 const [accounts,setAccounts]=useState<AgentQuotaAccount[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const [doubaoOpen,setDoubaoOpen]=useState(false),[doubaoBusy,setDoubaoBusy]=useState(false),[doubaoMessage,setDoubaoMessage]=useState("");
 const refreshAccount=async(id:string,forced=false,checkOnly=false)=>{
  if(!allowed.current||!isTauri())return false;
  const version=generation.current;let state=accountStates.current.get(id);
  if(!state){state={checking:false,generation:0};accountStates.current.set(id,state);}
  if(state.checking)return false;state.checking=true;
  let revision:string;
  try{revision=await readAgentAccountRevision(true,id);}
  catch{if(version===generation.current&&allowed.current){state.revision=undefined;state.generation++;setAccounts(current=>current.filter(account=>account.id!==id));}return false;}
  finally{state.checking=false;}
  if(version!==generation.current||!allowed.current)return false;
  const changed=revision!==state.revision;
  if(changed){state.revision=revision;state.generation++;setAccounts(current=>current.filter(account=>account.id!==id));}
  if(checkOnly&&!changed)return true;
  const requestGeneration=++state.generation;
  try{
   const snapshot=await invoke<Parameters<typeof normalizeAgentUsage>[0]>("read_agent_usage",{force:forced,consent:true,agentId:id,expectedRevision:revision});
   if(version!==generation.current||!allowed.current||requestGeneration!==state.generation||revision!==state.revision)return false;
   const next=normalizeAgentUsage(snapshot,revision).accounts;
   if(next.length!==1||next[0].id!==id)throw new Error("Agent 响应归属无效");
   setAccounts(current=>[...current.filter(account=>account.id!==id),...next]);return true;
  }catch{if(version===generation.current&&allowed.current&&requestGeneration===state.generation)setAccounts(current=>current.filter(account=>account.id!==id));return false;}
 };
 const refresh=async(forced=true)=>{
  if(!allowed.current||!isTauri())return;const version=generation.current,batch=++refreshBatch.current;setBusy(true);setMessage("");
  const result=await Promise.all(providers.map(provider=>refreshAccount(provider.id,forced)));
  if(version!==generation.current||batch!==refreshBatch.current||!allowed.current)return;
  const succeeded=result.some(Boolean);
  if(forced&&succeeded)void emit("agent-usage-changed").catch(()=>window.dispatchEvent(new Event("codex-desktop.agents-refresh")));
  setMessage(succeeded?(result.every(Boolean)?"连接状态已刷新":"部分连接读取失败，其余已刷新"):"AI 连接读取失败，请查看客户端登录状态。");setBusy(false);
 };
 useEffect(()=>{if(enabled&&isTauri())void refresh(false);else{generation.current++;accountStates.current.clear();setAccounts([]);setBusy(false);setMessage("");}return()=>{generation.current++;};},[enabled]);
 useEffect(()=>{
  if(!enabled||!isTauri())return;let active=true;
  const check=()=>{
   if(!active||!allowed.current||!isWindowVisible())return;
   for(const provider of providers)void refreshAccount(provider.id,false,true);
  };
  const timer=window.setInterval(()=>void check(),10_000);const stop=subscribeWindowVisibility(()=>void check());
  return()=>{active=false;window.clearInterval(timer);stop();};
 },[enabled]);
 const open=(url:string,name:string)=>void launchApplication({id:"agent-connection-link",name,icon:"",type:"url",target:url,pinned:false,order:0}).catch(()=>setMessage("无法打开官方页面"));
 const manageDoubao=async(action:"open"|"connect"|"disconnect")=>{
  if(!allowed.current||!isTauri()||doubaoBusy)return;
  const version=generation.current;setDoubaoBusy(true);setDoubaoMessage("");
  try{
   await invoke(`doubao_login_${action}`,{consent:true});
   if(version!==generation.current||!allowed.current)return;
   setDoubaoOpen(action==="open");
   setDoubaoMessage(action==="open"?"在官方窗口登录后，返回这里点完成连接。":action==="connect"?"豆包已连接":"豆包已断开");
   if(action!=="connect")setAccounts(current=>current.filter(account=>account.id!=="doubao"));
   await refreshAccount("doubao",true);
  }catch(error){if(version===generation.current&&allowed.current)setDoubaoMessage(typeof error==="string"?error:"豆包连接失败，请重试");}
  finally{setDoubaoBusy(false);}
 };
 return <div className="settings-section">
  <label className="settings-toggle"><span>允许读取本机 AI 账号与用量</span><input aria-label="允许读取本机 AI 账号与用量" type="checkbox" checked={enabled} onChange={event=>onEnabledChange?.(event.target.checked)}/></label>
  <small>开启后仅检查客户端登录与额度状态，不发送对话。关闭不会删除已有记录。</small>
  <button className="action-button" disabled={!enabled||!isTauri()||busy} onClick={()=>void refresh()}>{busy?"读取中…":"刷新连接状态"}</button>

  <div className="agent-connection-list">
   {providers.map(item=>{const account=accounts.find(value=>value.id===item.id);const running=activeClients.has(item.id);const connected=account?.loginStatus==="verified";return <section className={`agent-connection-setting${connected?" is-connected":""}`} key={item.id}>
    <div className="agent-connection-row">
     <span className="agent-connection-dot" aria-hidden="true"/>
     <strong>{item.name}</strong>
     <small>{stateLabel(account,running,runtime.available)}{account?.plan?` · ${account.plan}`:""}</small>
    </div>
    {item.detectOnly&&<small className="agent-connection-note">仅检测安装与运行，不读取额度。</small>}
    {item.id==="doubao"&&<>
     <div className="agent-connection-row">
      <button className="action-button" disabled={!enabled||!isTauri()||doubaoBusy} onClick={()=>void manageDoubao("open")}>{connected?"重新连接豆包":"连接豆包"}</button>
      {doubaoOpen&&<button className="action-button" disabled={!enabled||doubaoBusy} onClick={()=>void manageDoubao("connect")}>{doubaoBusy?"连接中…":"完成连接"}</button>}
      {(connected||doubaoOpen)&&<button className="action-button" disabled={!enabled||doubaoBusy} onClick={()=>void manageDoubao("disconnect")}>断开豆包</button>}
     </div>
     {doubaoMessage&&<small role="status">{doubaoMessage}</small>}
    </>}
    <details className="settings-help"><summary>连接说明</summary><p>{item.hint}</p><button onClick={()=>open(item.url,item.name)}>官方页面／登录说明 ↗</button></details>
   </section>;})}
  </div>

  {message&&<small role="status">{message}</small>}
 </div>;
}
