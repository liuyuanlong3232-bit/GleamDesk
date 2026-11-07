import {useEffect,useRef,useState} from "react";
import {invoke,isTauri} from "@tauri-apps/api/core";
import {normalizeAgentUsage,readAgentRuntime,unavailableAgentRuntime,runningAgentClients} from "../providers/agents/agentUsageProvider";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";
import {launchApplication} from "../services/launcher/launcherService";
import type {AgentQuotaAccount} from "../domain/agent/contracts";

// 只保留真正接入的客户端：这里显示连接状态，不展示额度明细。
const providers=[
  {id:"doubao",name:"豆包",url:"https://www.doubao.com/chat/",hint:"在豆包客户端登录后自动读取会员额度，无需重复网页登录。",detectOnly:false},
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
 const [runtime,setRuntime]=useState(unavailableAgentRuntime);
 useEffect(()=>{if(!isTauri())return;let active=true,pending=false;const refresh=async()=>{if(!active||pending||!isWindowVisible())return;pending=true;try{const value=await readAgentRuntime();if(active)setRuntime(value)}finally{pending=false}};void refresh();const timer=window.setInterval(()=>void refresh(),8000);const stop=subscribeWindowVisibility(()=>{if(isWindowVisible())void refresh()});window.addEventListener("codex-desktop.agents-refresh",refresh);return()=>{active=false;window.clearInterval(timer);stop();window.removeEventListener("codex-desktop.agents-refresh",refresh)}},[]);
 const activeClients=new Set(runningAgentClients(runtime).map(client=>client.id));
 const [accounts,setAccounts]=useState<AgentQuotaAccount[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const refresh=async(forced=true)=>{if(!allowed.current||!isTauri())return;const version=++generation.current;setBusy(true);setMessage("");try{const result=await Promise.allSettled([invoke<Parameters<typeof normalizeAgentUsage>[0]>("read_agent_usage",{force:forced,consent:true})]);if(version!==generation.current||!allowed.current)return;if(result[0].status==="fulfilled")setAccounts(normalizeAgentUsage(result[0].value).accounts);setMessage(result[0].status==="rejected"?"AI 连接读取失败，请查看客户端登录状态。":"连接状态已刷新");window.dispatchEvent(new Event("codex-desktop.agents-refresh"));}catch{if(version===generation.current&&allowed.current)setMessage("连接检查失败");}finally{if(version===generation.current)setBusy(false);}};
 useEffect(()=>{if(enabled&&isTauri())void refresh(false);else{generation.current++;setAccounts([]);setBusy(false);setMessage("");}return()=>{generation.current++;};},[enabled]);
 const open=(url:string,name:string)=>void launchApplication({id:"agent-connection-link",name,icon:"",type:"url",target:url,pinned:false,order:0}).catch(()=>setMessage("无法打开官方页面"));
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
    <details className="settings-help"><summary>连接说明</summary><p>{item.hint}</p><button onClick={()=>open(item.url,item.name)}>官方页面／登录说明 ↗</button></details>
   </section>;})}
  </div>

  {message&&<small role="status">{message}</small>}
 </div>;
}
