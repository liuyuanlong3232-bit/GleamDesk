import {CloseIcon} from "./CloseIcon";
import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { LocalAiSnapshot } from "../domain/local/contracts";
import { isWindowVisible, subscribeWindowVisibility } from "../services/windowVisibility";

export function LocalAIWindow() {
  const [request,setRequest]=useState<string|null>(null);
  const [snapshot,setSnapshot]=useState<LocalAiSnapshot|null>(null);
  const [model,setModel]=useState("");
  const [message,setMessage]=useState("");
  const [info,setInfo]=useState<{capabilities:string[];details:{family:string|null;parameterSize:string|null;quantization:string|null};remote:boolean}|null>(null);
  const [busy,setBusy]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const open=(event:Event)=>{const id=(event as CustomEvent<{id:string}>).detail?.id;if(["builtin-ollama","builtin-qwen","builtin-deepseek-local"].includes(id)){setRequest(id);setMessage("");setInfo(null);}};
    window.addEventListener("codex-desktop.local-ai-request",open);
    return()=>window.removeEventListener("codex-desktop.local-ai-request",open);
  },[]);
  useEffect(()=>{
    if(!request)return;
    dialog.current?.showModal();
    let active=true,inFlight=false,timer=0;
    const refresh=async()=>{
      if(!active||!isWindowVisible()||inFlight)return;
      if(!isTauri()){setMessage("本地模型入口需要 Windows 桌面应用");return;}
      inFlight=true;
      try{const next=await invoke<LocalAiSnapshot>("read_ollama_status");if(active){setSnapshot(next);const prefix=request==="builtin-qwen"?"qwen":request==="builtin-deepseek-local"?"deepseek":"";setModel(current=>next.models.some(item=>item.name===current)?current:next.models.find(item=>!item.remote&&(!prefix||item.name.toLowerCase().includes(prefix)))?.name??"");}}
      catch{if(active)setMessage("无法读取本机 Ollama API");}
      finally{inFlight=false;}
    };
    const restart=()=>{window.clearInterval(timer);if(isWindowVisible()){void refresh();timer=window.setInterval(()=>void refresh(),30_000);}};
    restart();
    const stop=subscribeWindowVisibility(restart);
    return()=>{active=false;window.clearInterval(timer);stop();dialog.current?.close();};
  },[request]);
  const action=async(kind:"info"|"terminal")=>{
    if(!model||busy)return;setBusy(true);setMessage("");
    try{if(kind==="info")setInfo(await invoke("read_ollama_model_info",{name:model}));else{await invoke("open_ollama_terminal",{name:model});setMessage("已打开此本地模型的终端聊天");}}
    catch(error){setMessage(typeof error==="string"?error:"本地模型入口操作失败");}
    finally{setBusy(false);}
  };
  if(!request)return null;
  return <dialog ref={dialog} className="local-ai-dialog glass" aria-label="本地 AI" onCancel={event=>{event.preventDefault();setRequest(null);}}>
    <header><div><small>LOCAL AI</small><h2>{request==="builtin-qwen"?"Qwen":request==="builtin-deepseek-local"?"DeepSeek Local":"Ollama"}</h2></div><button className="ui-icon-button" aria-label="关闭本地AI" onClick={()=>setRequest(null)}><CloseIcon/></button></header>
    <p><i className={`live-dot ${snapshot?.serviceStatus==="online"?"":"muted-dot"}`} /> Ollama · {snapshot?.serviceStatus==="online"?"在线":"未连接"}</p>
    <small>来源：{snapshot?.source??"http://127.0.0.1:11434"} · 仅本机 API，不读取内部模型文件</small>
    {snapshot?.serviceStatus==="online"?<>
      <label>已安装模型<select value={model} disabled={busy} onChange={event=>{setModel(event.target.value);setInfo(null);}}><option value="">选择已有本地模型</option>{snapshot.models.map(item=><option key={item.name} value={item.name} disabled={item.remote}>{item.name}{item.remote?" · 远程模型":""}</option>)}</select></label>
      <p>{snapshot.modelCount===0?"当前没有已安装模型":`${snapshot.modelCount??"未知数量"} 个模型 · ${snapshot.runningModels.length} 个正在运行`}</p>
      <div className="settings-actions"><button disabled={!model||busy} onClick={()=>void action("info")}>读取模型信息</button><button disabled={!model||busy||info?.remote} onClick={()=>void action("terminal")}>打开终端聊天</button></div>
      <small>终端入口会再次核对已有本地模型，需要本机 Ollama CLI。打开后如模型被其他程序移除，请核对 CLI 的下载提示。</small>
    </>:<p>安装或启动 Ollama 服务后，再从此处选择实际模型。当前不会自动安装或下载模型。</p>}
    {info&&<div className="widget-source-details"><p>{[info.details.family,info.details.parameterSize,info.details.quantization].filter(Boolean).join(" · ")||"模型信息未知"}</p><p>能力：{info.capabilities.join("、")||"未提供"}</p></div>}
    {message&&<p role="status">{message}</p>}
  </dialog>;
}
