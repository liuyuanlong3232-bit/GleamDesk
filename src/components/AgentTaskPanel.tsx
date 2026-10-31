import {useEffect,useState} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {cancelLocalAgentTask,listLocalAgents,pickLocalTaskDirectory,runLocalAgentTask,type LocalAgentId,type LocalAgentProvider,type LocalAgentTaskEvent} from "../services/agentTasks";

const statusLabels={idle:"准备就绪",starting:"正在启动…",running:"执行中",completed:"已完成",failed:"执行失败",cancelled:"已停止"} as const;
export function AgentTaskPanel({simulationEnabled,onInsertResult}:{simulationEnabled:boolean;onInsertResult:(text:string)=>void}){
 const [providers,setProviders]=useState<LocalAgentProvider[]>([]),[agent,setAgent]=useState<LocalAgentId>("codex"),[directory,setDirectory]=useState(""),[prompt,setPrompt]=useState("");
 const [taskId,setTaskId]=useState<string|null>(null),[status,setStatus]=useState<keyof typeof statusLabels>("idle"),[output,setOutput]=useState(""),[diagnostics,setDiagnostics]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[stopping,setStopping]=useState(false);
 useEffect(()=>{if(!isTauri()){setError("本机 Agent 任务需要在 GleamDesk 桌面版运行");return}let alive=true;void listLocalAgents().then(items=>{if(!alive)return;setProviders(items);const available=items.find(item=>item.available);if(available)setAgent(available.id)}).catch(reason=>{if(alive)setError(String(reason))});return()=>{alive=false}},[]);
 const chooseDirectory=async()=>{setError("");try{const value=await pickLocalTaskDirectory();if(value)setDirectory(value)}catch(reason){setError(String(reason))}};
 const start=async()=>{
  if(busy||simulationEnabled||!directory.trim()||!prompt.trim())return;
  const id=globalThis.crypto?.randomUUID?.()??`task-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
  setTaskId(id);setBusy(true);setStopping(false);setStatus("starting");setOutput("");setDiagnostics("");setError("");
  let unlisten:(()=>void)|undefined;
  try{
   unlisten=await listen<LocalAgentTaskEvent>("agent-task-event",event=>{
    const value=event.payload;if(value.taskId!==id)return;
    if(value.output)setOutput(old=>(old+value.output!).slice(-80_000));
    if(value.diagnostic)setDiagnostics(old=>(old+value.diagnostic!).slice(-24_000));
    if(value.message)setError(value.message);
    if(value.status!=="running")setStatus(value.status);
    else setStatus("running");
   });
   const receipt=await runLocalAgentTask({taskId:id,agent,directory:directory.trim(),prompt:prompt.trim()});
   setStatus(receipt.status);
  }catch(reason){setStatus("failed");setError(String(reason))}
  finally{unlisten?.();setBusy(false);setStopping(false)}
 };
 const stop=async()=>{if(!taskId||!busy||stopping)return;setStopping(true);setError("");try{await cancelLocalAgentTask(taskId)}catch(reason){setStopping(false);setError(String(reason))}};
 const selected=providers.find(item=>item.id===agent), canStart=isTauri()&&!simulationEnabled&&!busy&&Boolean(selected?.available)&&Boolean(directory.trim())&&Boolean(prompt.trim());
 return <section className="ar-task-panel" aria-label="本机 Agent 任务">
  <header className="ar-task-panel-heading"><div><h2>本机 Agent 任务</h2><p>把任务交给本机已安装的 Agent，在指定目录中执行。</p></div><span className={`ar-task-state ar-task-${status}`} role="status">{stopping?"正在停止…":statusLabels[status]}</span></header>
  {!isTauri()?<p className="ar-task-note">{error}</p>:<>
   <div className="ar-task-form">
    <label>Agent<select value={agent} disabled={busy||simulationEnabled} onChange={event=>setAgent(event.target.value as LocalAgentId)}>{providers.map(item=><option key={item.id} value={item.id} disabled={!item.available}>{item.name} · {item.available?"已检测":"未检测到 CLI"}</option>)}</select></label>
    <label className="ar-task-directory">工作目录<div><input value={directory} disabled={busy||simulationEnabled} placeholder="选择要交给 Agent 的本地文件夹" onChange={event=>setDirectory(event.target.value)}/><button type="button" disabled={busy||simulationEnabled} onClick={()=>void chooseDirectory()}>浏览…</button></div></label>
    <label className="ar-task-prompt">任务说明<textarea value={prompt} maxLength={8000} disabled={busy||simulationEnabled} placeholder="例如：检查这个项目并说明最需要优先处理的问题" onChange={event=>setPrompt(event.target.value)}/></label>
    <div className="ar-task-actions"><small>{selected?.available?"使用本机 CLI 当前登录账号和权限配置；Agent 的确认规则保持原样。":"没有检测到可用的 Agent CLI。"}</small><div>{busy?<button type="button" className="ar-task-stop" disabled={stopping} onClick={()=>void stop()}>{stopping?"正在停止…":"停止任务"}</button>:<button type="button" className="ar-task-run" disabled={!canStart} onClick={()=>void start()}>{simulationEnabled?"模拟模式已暂停":"开始任务"}</button>}</div></div>
    <p className="ar-task-note">无交互确认能力的 CLI 操作可能会被客户端权限规则拒绝；Room 不会自动开启跳过权限。</p>
   </div>
   {(output||busy)&&<section className="ar-task-output"><header><strong>{status==="completed"?"Agent 回复":"运行输出"}</strong>{status==="completed"&&output&&<button type="button" onClick={()=>onInsertResult(output.trim())}>转入聊天草稿</button>}</header><pre>{output||"正在等待 Agent 输出…"}</pre></section>}
   {diagnostics&&<details className="ar-task-diagnostics"><summary>客户端诊断信息</summary><pre>{diagnostics}</pre></details>}
   {error&&<p className="ar-task-error" role="alert">{error}</p>}
  </>}
 </section>
}
