import {useState} from "react";
import {invoke,isTauri} from "@tauri-apps/api/core";
export function WebAppDiagnostics(){const [busy,setBusy]=useState(false),[result,setResult]=useState("");
  if(!import.meta.env.TAURI_ENV_DEBUG)return null;
  return <section><strong>原生网页权限验收</strong><p>本机测试页面尝试调用4类本机命令。没有有效启动目标或凭据参数，也不访问外网。</p><button disabled={busy||!isTauri()} onClick={()=>{setBusy(true);void invoke<{blocked:boolean;result:string;nativeDenied:number}>("webapp_security_probe").then(value=>setResult(`${value.blocked?"通过":"未通过"} · ${value.result} · 原生拒绝计数 ${value.nativeDenied}`)).catch(e=>setResult(`未完成 · ${String(e)}`)).finally(()=>setBusy(false));}}>{busy?"探测中…":"运行网页权限探测"}</button>{result&&<p role="status">{result}</p>}</section>;
}
