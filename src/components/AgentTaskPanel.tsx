import {useEffect,useState} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {applyAgentTaskEvent,canStartAgentTask,cancelLocalAgentTask,emptyAgentTaskRuntime,listLocalAgents,pickLocalTaskDirectory,resolveLocalAgentTask,runLocalAgentTask,type AgentTaskCatalog,type AgentTaskEvent,type AgentTaskModel} from "../services/agentTasks";

const statusLabels={idle:"准备就绪",starting:"正在启动…",running:"执行中",approval_required:"等待你确认",completed:"已完成",failed:"执行失败",cancelled:"已停止"} as const;
const providerNames:Record<string,string>={DeepSeek:"DeepSeek",GPT:"OpenAI",Gemini:"Google",Claude:"Anthropic",Qwen:"阿里云百炼",Kimi:"Moonshot",Grok:"xAI",豆包:"火山方舟",MiMo:"小米 MiMo",Ollama:"本机 Ollama"};
const modelKey=(model:AgentTaskModel)=>`${model.provider}\n${model.model}`;
const errorText=(reason:unknown)=>reason instanceof Error?reason.message:String(reason);

export function AgentTaskPanel({simulationEnabled,onInsertResult}:{simulationEnabled:boolean;onInsertResult:(text:string)=>void}){
 const [catalog,setCatalog]=useState<AgentTaskCatalog>({models:[],paidEnabled:false}),[selectedKey,setSelectedKey]=useState("");
 const [directory,setDirectory]=useState(""),[prompt,setPrompt]=useState(""),[taskId,setTaskId]=useState<string|null>(null);
 const [runtime,setRuntime]=useState(emptyAgentTaskRuntime),[busy,setBusy]=useState(false),[stopping,setStopping]=useState(false),[approving,setApproving]=useState(false),[loading,setLoading]=useState(false);
 const {status,progress,output,commands,approval,error}=runtime;

 const loadModels=async()=>{setLoading(true);setRuntime(old=>({...old,error:""}));try{const value=await listLocalAgents();setCatalog(value);setSelectedKey(old=>value.models.some(model=>modelKey(model)===old)?old:modelKey(value.models.find(item=>item.available)??value.models[0]??{provider:"",model:""}));}catch(reason){setRuntime(old=>({...old,error:errorText(reason)}));}finally{setLoading(false)}};
 useEffect(()=>{if(!isTauri()){setRuntime(old=>({...old,error:"本机 API 任务需要在 GleamDesk 桌面版运行"}));return}void loadModels()},[]);

 const chooseDirectory=async()=>{setRuntime(old=>({...old,error:""}));try{const value=await pickLocalTaskDirectory();if(value)setDirectory(value)}catch(reason){setRuntime(old=>({...old,error:errorText(reason)}))}};
 const selected=catalog.models.find(item=>modelKey(item)===selectedKey);
 const canStart=isTauri()&&!busy&&canStartAgentTask(selected,catalog,simulationEnabled)&&Boolean(directory.trim())&&Boolean(prompt.trim());

 const start=async()=>{
  if(!canStart||!selected)return;
  const id=globalThis.crypto?.randomUUID?.()??`task-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
  setTaskId(id);setBusy(true);setStopping(false);setApproving(false);setRuntime({...emptyAgentTaskRuntime(),status:"starting"});
  let unlisten:(()=>void)|undefined;
  try{
   unlisten=await listen<AgentTaskEvent>("agent-task-event",event=>{
    const value=event.payload;if(value.taskId!==id)return;
    setRuntime(old=>applyAgentTaskEvent(old,value));
   });
   const receipt=await runLocalAgentTask({taskId:id,provider:selected.provider,model:selected.model,directory:directory.trim(),prompt:prompt.trim()});
   setRuntime(old=>({...old,status:receipt.status}));
  }catch(reason){setRuntime(old=>({...old,status:"failed",error:errorText(reason)}))}
  finally{unlisten?.();setBusy(false);setStopping(false);setApproving(false)}
 };

 const resolve=async(approved:boolean)=>{
  if(!taskId||!approval||approving)return;
  setApproving(true);setRuntime(old=>({...old,error:""}));
  try{await resolveLocalAgentTask({taskId,approvalId:approval.id,approved});setRuntime(old=>({...old,approval:null,status:"running",progress:approved?"已批准，正在执行…":"已拒绝，正在告知模型…"}))}
  catch(reason){setRuntime(old=>({...old,error:errorText(reason)}))}
  finally{setApproving(false)}
 };
 const stop=async()=>{if(!taskId||!busy||stopping)return;setStopping(true);setRuntime(old=>({...old,error:""}));try{await cancelLocalAgentTask(taskId)}catch(reason){setStopping(false);setRuntime(old=>({...old,error:errorText(reason)}))}};

 return <section className="ar-task-panel" aria-label="Room API 本机任务">
  <header className="ar-task-panel-heading"><div><h2>本机开发任务</h2><p>使用 Agent Room 已配置的一个 API 模型，按需查看所选目录。</p></div><span className={`ar-task-state ar-task-${status}`} role="status">{stopping?"正在停止…":statusLabels[status]}</span></header>
  {!isTauri()?<p className="ar-task-note">{error}</p>:<>
   <div className="ar-task-form">
    <label>Room API 模型<select value={selectedKey} disabled={busy||simulationEnabled||loading} onChange={event=>setSelectedKey(event.target.value)}>
     {catalog.models.map(item=><option key={modelKey(item)} value={modelKey(item)} disabled={!item.available}>{providerNames[item.provider]??item.provider} · {item.model||item.reason||"尚未配置"}{item.available?" · 尚未验证工具调用":""}</option>)}
    </select></label>
    <button type="button" className="ar-task-refresh" disabled={busy||loading} onClick={()=>void loadModels()}>{loading?"正在读取…":"刷新模型配置"}</button>
    <label className="ar-task-directory">工作目录<div><input value={directory} disabled={busy||simulationEnabled} placeholder="选择要处理的本地项目文件夹" onChange={event=>setDirectory(event.target.value)}/><button type="button" disabled={busy||simulationEnabled} onClick={()=>void chooseDirectory()}>浏览…</button></div></label>
    <label className="ar-task-prompt">任务说明<textarea value={prompt} maxLength={8000} disabled={busy||simulationEnabled} placeholder="例如：检查这个项目的启动流程，修复启动时报错并运行相关测试" onChange={event=>setPrompt(event.target.value)}/></label>
    <div className="ar-task-actions"><small>{selected?.available?"每次模型请求计入 Agent Room 共用的每日次数与预算。工具调用能力尚未用该具体模型验证，若接口不支持会说明原因且不会切换模型。":"先在 Agent Room 模型设置中配置 API 模型与密钥。"}</small><div>{busy?<button type="button" className="ar-task-stop" disabled={stopping} onClick={()=>void stop()}>{stopping?"正在停止…":"停止任务"}</button>:<button type="button" className="ar-task-run" disabled={!canStart} onClick={()=>void start()}>{simulationEnabled?"模拟模式已暂停":selected&&selected.provider!=="Ollama"&&!catalog.paidEnabled?"请先允许付费调用":"开始任务"}</button>}</div></div>
    {selected?.provider!=="Ollama"&&!selected?.priceConfirmed&&selected?.available&&<p className="ar-task-note">请先在 Room 模型设置中确认当前模型价格。</p>}
    {selected?.provider!=="Ollama"&&selected?.priceConfirmed&&!catalog.paidEnabled&&<p className="ar-task-note">付费调用开关关闭时不会发送 API 请求。请在 Agent Room 的调用设置中开启。</p>}
    {simulationEnabled&&<p className="ar-task-note">当前模拟模式会阻止真实 API 请求。</p>}
   </div>

   {busy&&<p className="ar-task-progress" role="status">{progress||"任务正在准备…"}</p>}
   {approval&&<section className="ar-task-approval" aria-label={approval.kind==="edit"?"文件修改审批":"命令审批"}>
    {approval.kind==="edit"?<><h3>审阅文件修改</h3><p className="ar-task-approval-path">{approval.path}</p><div className="ar-task-diff"><section><h4>修改前</h4><pre>{approval.before}</pre></section><section><h4>修改后</h4><pre>{approval.after}</pre></section></div><p>批准后会重新检查原文；文件内容变化时会拒绝覆盖。</p><div className="ar-task-approval-actions"><button type="button" disabled={approving||stopping} onClick={()=>void resolve(false)}>拒绝修改</button><button type="button" className="is-approve" disabled={approving||stopping} onClick={()=>void resolve(true)}>{approving?"正在处理…":"应用修改"}</button></div></>:<><h3>确认运行命令</h3><pre className="ar-task-command">{approval.command}</pre><p className="ar-task-approval-path">工作目录：{approval.directory}</p><p className="ar-task-warning">{approval.permissionNotice}</p><p className="ar-task-warning">{approval.outputNotice}</p><div className="ar-task-approval-actions"><button type="button" disabled={approving||stopping} onClick={()=>void resolve(false)}>拒绝命令</button><button type="button" className="is-approve" disabled={approving||stopping} onClick={()=>void resolve(true)}>{approving?"正在处理…":"执行命令"}</button></div></>}
   </section>}
   {commands.length>0&&<section className="ar-task-command-results"><h3>命令结果</h3>{commands.map((item,index)=><details key={`${index}-${item.exitCode}`} open={index===commands.length-1}><summary>退出码：{item.exitCode??"未知"}{item.truncated?" · 输出已截短":""}</summary><pre>{item.output||"（没有输出）"}</pre><p>此结果已发送给当前模型，用于继续任务。</p></details>)}</section>}
   {(output||busy)&&<section className="ar-task-output"><header><strong>{status==="completed"?"任务结果":"模型进度"}</strong>{status==="completed"&&output&&<button type="button" onClick={()=>onInsertResult(output.trim())}>转入聊天草稿</button>}</header><pre>{output||"正在等待模型响应…"}</pre></section>}
   {error&&<p className="ar-task-error" role="alert">{error}</p>}
   <p className="ar-task-note">文件内容和搜索片段只在模型按需请求后发送。文件写入和每条命令都需你确认；命令以当前 Windows 用户权限运行，所选目录不是安全隔离区。</p>
  </>}
 </section>;
}
