import {useEffect,useRef,useState} from "react";
import {invoke,isTauri} from "@tauri-apps/api/core";
export interface DnsApiResult {domain:string;recordType:string;comparison:"matching"|"different"|"no-answer"|"incomplete";completedAtUnixMs:number;resolvers:{provider:string;rcode:number|null;error:string|null;answers:{name:string;type:number;TTL:number;data:string}[]}[]}
export function dnsComparisonLabel(value:DnsApiResult["comparison"]):string {
  return {matching:"两家解析结果一致",different:"两家解析结果存在差异","no-answer":"两家均未返回该类型的记录",incomplete:"读取不完整，暂时无法比较"}[value];
}
export function DnsApiTool({onBack}:{onBack:()=>void}) {
  const [domain,setDomain]=useState(""),[recordType,setRecordType]=useState("A"),[busy,setBusy]=useState(false),[error,setError]=useState(""),[result,setResult]=useState<DnsApiResult|null>(null);
  const alive=useRef(true),inFlight=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const run=async()=>{
    if(inFlight.current)return;inFlight.current=true;setBusy(true);setError("");setResult(null);
    try {const value=await invoke<DnsApiResult>("dns_api_compare",{query:{domain:domain.trim(),recordType}});if(alive.current)setResult(value);}
    catch(error){if(alive.current)setError(String(error));}
    finally{inFlight.current=false;if(alive.current)setBusy(false);}
  };
  return <article className="native-tool dns-api-tool glass"><header><h2>DNS 传播检测</h2><button disabled={busy} onClick={onBack}>返回工具箱</button></header>
    <p className="tool-privacy">点击查询后，域名会发送至 Cloudflare 和 Google Public DNS。输入与结果不保存。</p>
    <p>对比两家公共解析器的记录；结果一致不能证明全球已同步，差异也可能来自缓存或 CDN 策略。</p>
    <div className="dns-query-fields"><label>域名<input value={domain} onChange={event=>setDomain(event.target.value)} placeholder="example.com" maxLength={253} disabled={busy}/></label><label>记录类型<select value={recordType} onChange={event=>setRecordType(event.target.value)} disabled={busy}>{["A","AAAA","CNAME","MX","TXT","NS"].map(type=><option key={type}>{type}</option>)}</select></label></div>
    <button disabled={busy||!domain.trim()||!isTauri()} onClick={()=>void run()}>{busy?"查询中…":"查询并对比一次"}</button>
    {!isTauri()&&<p>需要 Windows 桌面程序</p>}{error&&<p role="alert">{error}</p>}
    {result&&<><h3>{dnsComparisonLabel(result.comparison)}</h3><small>{result.domain} · {result.recordType} · {new Date(result.completedAtUnixMs).toLocaleString("zh-CN")}</small><div className="dns-api-results">{result.resolvers.map(resolver=><section key={resolver.provider}><h3>{resolver.provider}</h3>{resolver.error?<p role="alert">{resolver.error}</p>:<><p>DNS 状态码：{resolver.rcode}{resolver.rcode===3?" · 域名不存在":resolver.rcode===0?" · 查询已返回":""}</p>{resolver.answers.length?<table><thead><tr><th>记录</th><th>缓存秒数</th></tr></thead><tbody>{resolver.answers.map((answer,index)=><tr key={index}><td><small>{answer.name} · 类型 {answer.type}</small><div>{answer.data}</div></td><td>{answer.TTL}</td></tr>)}</tbody></table>:<p>没有返回记录</p>}</>}</section>)}</div></>}
  </article>;
}
