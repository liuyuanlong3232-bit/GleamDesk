import {useEffect,useRef,useState} from "react";
import {invoke,isTauri} from "@tauri-apps/api/core";
import type {LocalAiSnapshot} from "../domain/local/contracts";
interface Receipt {text:string;provider:string;model:string;inputTokens:number|null;outputTokens:number|null}
export function RoomApiReply({connector,prompt,disabled,onReply,onRequesting}:{connector:string;prompt:string;disabled:boolean;onReply:(text:string)=>void;onRequesting?:(requesting:boolean)=>void}) {
  const [configured,setConfigured]=useState(false),[key,setKey]=useState(""),[snapshot,setSnapshot]=useState<LocalAiSnapshot|null>(null),[model,setModel]=useState(""),[confirm,setConfirm]=useState<string|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const alive=useRef(true);
  const requestingCallback=useRef<typeof onRequesting>(undefined);
  useEffect(()=>()=>{requestingCallback.current?.(false);},[]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{const cancel=()=>{if(isTauri())void invoke("agent_room_cancel").catch(()=>{});};window.addEventListener("codex-desktop.cancel-room-request",cancel);return()=>window.removeEventListener("codex-desktop.cancel-room-request",cancel);},[]);
  const provider=connector==="DeepSeek"?"deepseek":connector==="Ollama"?"ollama":null;
  useEffect(()=>{let active=true;setConfirm(null);setMessage("");setKey("");
    if(provider==="deepseek"&&isTauri())void invoke<boolean>("credential_exists",{source:"agent-deepseek"}).then(value=>{if(active)setConfigured(value);}).catch(()=>{if(active)setMessage("凭据状态未知");});
    if(provider==="ollama"&&isTauri())void invoke<LocalAiSnapshot>("read_ollama_status").then(value=>{if(active){setSnapshot(value);setModel(value.models.find(model=>!model.remote)?.name??"");}}).catch(()=>{if(active)setMessage("本机服务不可用");});
    return()=>{active=false;};
  },[provider]);
  useEffect(()=>{setConfirm(null);},[prompt,disabled]);
  useEffect(()=>()=>{if(isTauri())void invoke("agent_room_cancel").catch(()=>{});},[]);
  if(!provider)return <small>当前连接器使用手动转接；尚无已接通的自动回复接口。</small>;
  const send=async()=>{if(!confirm)return;const actual=confirm;setConfirm(null);setBusy(true);setMessage("");const notify=onRequesting;requestingCallback.current=notify;notify?.(true);
    try{const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(actual)))).map(byte=>byte.toString(16).padStart(2,"0")).join("");const receipt=await invoke<Receipt>("agent_room_reply",{request:{id:crypto.randomUUID(),provider,model:provider==="deepseek"?"deepseek-flash":model,prompt:actual,digest,consentAtUnixMs:Date.now(),paidAccepted:provider==="deepseek"}});if(!alive.current)return;onReply(receipt.text);setMessage(`已收到 ${receipt.model} 回复 · 输入 ${receipt.inputTokens??"未知"} / 输出 ${receipt.outputTokens??"未知"} token`);}
    catch(e){if(alive.current)setMessage(String(e));}finally{if(alive.current)setBusy(false);notify?.(false);requestingCallback.current=undefined;}
  };
  return <section className="room-api-reply"><strong>{provider==="deepseek"?"DeepSeek API · deepseek-flash":"Ollama 本机 API"}</strong>
    {provider==="deepseek"&&!configured&&<><p>使用讨论专用凭据，保存后由你逐次确认发送。</p><input type="password" autoComplete="new-password" placeholder="仅保存到 Windows Credential Manager" value={key} onChange={e=>setKey(e.target.value)}/><button disabled={!key.trim()||busy||!isTauri()} onClick={()=>{setBusy(true);void invoke("credential_save",{source:"agent-deepseek",secret:key}).then(()=>{setConfigured(true);setKey("");setMessage("讨论凭据已保存");}).catch(()=>setMessage("凭据保存失败")).finally(()=>setBusy(false));}}>保存讨论凭据</button></>}
    {provider==="ollama"&&<><p>{snapshot?.serviceStatus==="online"?"已检测服务；只允许已有本地模型":"本机服务未连接"}</p><select aria-label="讨论本地模型" value={model} onChange={e=>setModel(e.target.value)}>{!model&&<option value="">没有可用的本地模型</option>}{snapshot?.models.filter(model=>!model.remote).map(model=><option key={model.name}>{model.name}</option>)}</select></>}
    <button disabled={disabled||busy||!isTauri()||(provider==="deepseek"?!configured:!model)} onClick={()=>setConfirm(prompt)}>核对本次发送</button>
    {busy&&<button onClick={()=>void invoke("agent_room_cancel").then(()=>setMessage("已请求取消；已发送的远程调用仍可能计费"))}>取消请求</button>}
    {confirm&&<div className="room-send-confirm"><p>{provider==="deepseek"?"以下提示词将发送到 DeepSeek（api.deepseek.com），可能产生 token 费用。输出上限2048 token，仅发送一次，不自动重试。":"以下提示词只发送到本机127.0.0.1:11434的已安装本地模型，不安装模型。"}</p><pre>{confirm}</pre><button disabled={disabled||busy} onClick={()=>void send()}>{provider==="deepseek"?"同意本次范围及费用，发送一次":"发送到本机一次"}</button><button onClick={()=>setConfirm(null)}>取消</button></div>}
    {message&&<p role="status">{message}</p>}
  </section>;
}
