import {useEffect,useRef,useState} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {serviceKinds,serviceNames,serviceIdentity,serviceStatus,serviceBytes,type ServiceConnection,type ServiceKind,type ServiceSnapshot} from "../domain/vps/services";
import {loadVpsServices,saveVpsServices,readVpsService,serviceToken,subscribeVpsServices} from "../services/vpsServices";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";
import {startProviderPolling} from "../providers/pollingLifecycle";
import {VpsXuiDetails} from "./VpsXuiDetails";
import {VpsSingBoxDetails} from "./VpsSingBoxDetails";
import {VpsTailscaleDetails} from "./VpsTailscaleDetails";
const errorText=(reason:unknown)=>reason instanceof Error?reason.message:typeof reason==="string"?reason:"操作失败，请检查连接配置";

export function VpsServiceSettings(){
 const [connections,setConnections]=useState<ServiceConnection[]>([]),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const [tokens,setTokens]=useState<Partial<Record<ServiceKind,string>>>({}),[saved,setSaved]=useState<Partial<Record<ServiceKind,boolean>>>({});
 const committed=useRef<ServiceConnection[]>([]),mounted=useRef(false),pending=useRef(false);
 useEffect(()=>{mounted.current=true;let active=true;void loadVpsServices().then(value=>{if(active){setConnections(value);committed.current=value;setLoaded(true);for(const c of value)if(c.kind!=="tailscale"&&c.endpoint)void serviceToken(c,"inspect").then(v=>{if(active)setSaved(old=>({...old,[c.kind]:v}));}).catch(()=>{});}}).catch(e=>{if(active)setMessage(errorText(e));});return()=>{active=false;mounted.current=false;setTokens({});};},[]);
 useEffect(()=>subscribeWindowVisibility(()=>{if(!isWindowVisible())setTokens({});}),[]);
 const update=(kind:ServiceKind,patch:Partial<ServiceConnection>)=>setConnections(old=>old.map(c=>c.kind===kind?{...c,...patch}:c));
 const perform=async(action:()=>Promise<void>)=>{if(pending.current)return;pending.current=true;setBusy(true);setMessage("");try{await action();}catch(e){if(mounted.current)setMessage(errorText(e));}finally{pending.current=false;if(mounted.current)setBusy(false);}};
 const persist=async(next:ServiceConnection[])=>{
  const result=await saveVpsServices(next);committed.current=result;
  if(mounted.current)setConnections(result);
  const states=await Promise.all(result.filter(c=>c.kind!=="tailscale"&&c.endpoint).map(async c=>{try{return [c.kind,await serviceToken(c,"inspect")] as const;}catch{return null;}}));
  if(mounted.current){setSaved(Object.fromEntries(states.filter(v=>v!==null)));}return result;
 };
 const tokenAction=(kind:ServiceKind,action:"save"|"clear")=>void perform(async()=>{
  const current=connections.find(c=>c.kind===kind),previous=committed.current.find(c=>c.kind===kind);
  if(!current||!previous||current.endpoint!==previous.endpoint)throw Error("请先保存当前服务地址，再管理此地址的令牌");
  const token=tokens[kind];setTokens(old=>({...old,[kind]:""}));
  const result=await serviceToken(current,action,token);
  if(mounted.current){setSaved(old=>({...old,[kind]:result}));setMessage(action==="save"?"令牌已安全保存":"令牌已删除");}
 });
 return <section className="vps-service-settings"><h3>可选服务</h3><p className="settings-help-text">连接用户已有的服务；不安装、不修改服务器。默认手动读取。</p>
  <fieldset disabled={!loaded||busy||!isTauri()}>
   {connections.map(c=><section className="vps-service-editor" key={c.kind}>
    <header><strong>{serviceNames[c.kind]}</strong><button type="button" onClick={()=>void perform(async()=>{if(c.kind!=="tailscale"&&committed.current.some(v=>v.kind===c.kind&&v.endpoint))await serviceToken(committed.current.find(v=>v.kind===c.kind)!,"clear");await persist(connections.filter(v=>v.kind!==c.kind));if(mounted.current){setTokens(old=>({...old,[c.kind]:""}));setSaved(old=>({...old,[c.kind]:false}));setMessage("连接已移除");}})}>移除{c.kind!=="tailscale"?"连接及令牌":"连接"}</button></header>
    <label>{c.kind==="tailscale"?"SSH 别名":"服务地址"}<input value={c.endpoint} maxLength={500} autoComplete="off" placeholder={c.kind==="tailscale"?"例如 my-server":"https://你的服务地址"} onChange={e=>{update(c.kind,{endpoint:e.target.value});setTokens(old=>({...old,[c.kind]:""}));setSaved(old=>({...old,[c.kind]:false}));}}/></label>
    <label className="settings-toggle"><input type="checkbox" checked={c.enabled} onChange={e=>update(c.kind,{enabled:e.target.checked,autoRefresh:e.target.checked&&c.autoRefresh})}/>启用连接</label>
    <label className="settings-toggle"><input type="checkbox" disabled={!c.enabled} checked={c.autoRefresh} onChange={e=>update(c.kind,{autoRefresh:e.target.checked})}/>页面显示时每分钟读取</label>
    {c.kind!=="tailscale"&&<><label>API 令牌{c.kind==="sing-box"?"（配置了 secret 时填写）":""}<input type="password" autoComplete="new-password" value={tokens[c.kind]??""} placeholder={saved[c.kind]?"此地址已保存令牌":"令牌不写入连接配置"} onChange={e=>setTokens(old=>({...old,[c.kind]:e.target.value}))}/></label><div className="settings-actions"><button type="button" disabled={!tokens[c.kind]?.trim()} onClick={()=>tokenAction(c.kind,"save")}>保存令牌</button><button type="button" onClick={()=>tokenAction(c.kind,"clear")}>删除令牌</button></div></>}
    <details className="settings-help"><summary>连接要求</summary>{c.kind==="tailscale"?<p>复用 Windows OpenSSH 中已经配置并验证过主机身份的别名，只在 VPS 执行 tailscale status --json。不自动登录或安装，不读取本机 Tailscale 冒充 VPS。</p>:c.kind==="3x-ui"?<p>当前适配 API Token 版本的 /panel/api/server/status，需核对面板版本。显示的是 Xray 状态和服务器累计网络流量。</p>:<p>需已有 Clash API，概况读取 /version 和 /connections；详情额外读取 /proxies，仅展示已有延迟记录，不主动测速。未开启接口时不会修改 sing-box。累计流量不是瞬时网速。</p>}<p>远程使用 HTTPS；HTTP 仅支持本机回环，例如用户自己建立的本机转发。更换地址会使用独立令牌，旧令牌不会发送到新地址。</p></details>
   </section>)}
   <div className="settings-actions">{serviceKinds.filter(kind=>!connections.some(c=>c.kind===kind)).map(kind=><button type="button" key={kind} onClick={()=>setConnections(old=>[...old,{kind,endpoint:"",enabled:false,autoRefresh:false}])}>添加 {serviceNames[kind]}</button>)}</div>
   <div className="settings-actions"><button type="button" onClick={()=>void perform(async()=>{await persist(connections);if(mounted.current)setMessage("连接设置已保存；可到 VPS 页面读取状态");})}>保存服务连接</button></div>
  </fieldset>{message&&<p role="status">{message}</p>}
 </section>;
}

interface Entry {identity:string;snapshot?:ServiceSnapshot;error:string;busy:boolean}
export function VpsServicePanel({simulationEnabled=false,onOpenPanel}:{simulationEnabled?:boolean;onOpenPanel?:(url:string,name:string)=>void}){
 const [connections,setConnections]=useState<ServiceConnection[]>([]),[entries,setEntries]=useState<Partial<Record<ServiceKind,Entry>>>({}),[error,setError]=useState("");
 const [now,setNow]=useState(Date.now),[revision,setRevision]=useState(0),[onScreen,setOnScreen]=useState(false);
 const [selected,setSelected]=useState<ServiceConnection>();
 const root=useRef<HTMLElement>(null),generation=useRef(0),inFlight=useRef(new Set<string>());
 useEffect(()=>{let active=true,loadRevision=0;const read=()=>{const request=++loadRevision;generation.current++;setSelected(undefined);setEntries({});setConnections([]);setError("");void loadVpsServices().then(c=>{if(active&&request===loadRevision){setConnections(c);setRevision(v=>v+1);}}).catch(e=>{if(active&&request===loadRevision)setError(errorText(e));});};read();const stop=subscribeVpsServices(read);return()=>{active=false;generation.current++;stop();};},[]);
 const enabled=connections.filter(c=>c.enabled),identity=JSON.stringify(connections);
 useEffect(()=>{setOnScreen(false);const element=root.current;if(!element)return;const observer=new IntersectionObserver(values=>setOnScreen(values.some(v=>v.isIntersecting)));observer.observe(element);return()=>observer.disconnect();},[identity,error]);
 const refresh=async(c:ServiceConnection)=>{
  if(simulationEnabled||!isWindowVisible()||!isTauri())return;
  const key=serviceIdentity(c),epoch=generation.current;
  if(inFlight.current.has(key))return;inFlight.current.add(key);
  setEntries(old=>({...old,[c.kind]:{...old[c.kind],identity:key,error:"",busy:true}}));
  try{const snapshot=await readVpsService(c,simulationEnabled);if(epoch===generation.current)setEntries(old=>({...old,[c.kind]:{identity:key,snapshot,error:"",busy:false}}));}
  catch(e){if(epoch===generation.current)setEntries(old=>({...old,[c.kind]:{identity:key,snapshot:old[c.kind]?.snapshot,error:errorText(e),busy:false}}));}
  finally{inFlight.current.delete(key);}
 };
 useEffect(()=>{generation.current++;setEntries({});},[identity,simulationEnabled,revision]);
 useEffect(()=>{
  if(simulationEnabled||!onScreen||!isTauri())return;
  const selected=enabled.filter(c=>c.autoRefresh);
  return startProviderPolling(selected.map(c=>c.kind),selected.map(c=>({id:c.kind,name:serviceNames[c.kind],kind:"server" as const,refreshIntervalMs:60000,backgroundRefreshIntervalMs:null,load:async()=>({status:"unavailable" as const,data:null})})),ids=>{for(const c of selected)if(ids.includes(c.kind))void refresh(c);},{isVisible:isWindowVisible,subscribeVisibility:subscribeWindowVisibility,setInterval:(fn,ms)=>window.setInterval(fn,ms),clearInterval:id=>window.clearInterval(id)});
 },[identity,simulationEnabled,onScreen,revision]);
 useEffect(()=>{if(!enabled.length)return;const timer=window.setInterval(()=>setNow(Date.now()),15000);return()=>window.clearInterval(timer);},[identity]);
 if(!enabled.length&&!error)return null;
 return <section className="widget-card vps-services-panel" ref={root} aria-label="可选 VPS 服务"><header className="card-heading"><strong>服务状态</strong>{simulationEnabled&&<span>模拟模式 · 真实读取暂停</span>}</header>{error&&<p role="status">{error}</p>}
  <div className="vps-services-grid">{enabled.map(c=>{const entry=entries[c.kind]?.identity===serviceIdentity(c)?entries[c.kind]:undefined,snapshot=simulationEnabled?undefined:entry?.snapshot;
   const state=entry?.error||!snapshot||now-snapshot.checkedAtUnixMs>120000?"unknown":snapshot.state;
   return <article key={c.kind} className="vps-service-result"><header><h3>{serviceNames[c.kind]}</h3><div className="vps-service-actions"><button type="button" disabled={simulationEnabled||!isTauri()} onClick={()=>setSelected(c)}>查看详情</button><button type="button" disabled={simulationEnabled||entry?.busy||!isTauri()} onClick={()=>void refresh(c)}>{entry?.busy?"读取中…":"读取状态"}</button></div></header>
    <p className={`state-${state}`} role="status">{simulationEnabled?"真实读取暂停":serviceStatus(snapshot,entry?.error??"",now)}</p><small className="vps-service-endpoint">{c.endpoint}</small>
    {snapshot&&<><dl>{snapshot.version&&<div><dt>版本</dt><dd>{snapshot.version}</dd></div>}{snapshot.connections!==null&&<div><dt>当前连接</dt><dd>{snapshot.connections}</dd></div>}{c.kind!=="tailscale"&&<><div><dt>{c.kind==="3x-ui"?"服务器累计发送":"累计上传"}</dt><dd>{serviceBytes(snapshot.uploadBytes)}</dd></div><div><dt>{c.kind==="3x-ui"?"服务器累计接收":"累计下载"}</dt><dd>{serviceBytes(snapshot.downloadBytes)}</dd></div></>}</dl><small>本次读取 {new Date(snapshot.checkedAtUnixMs).toLocaleString("zh-CN")}{entry?.error?" · 上次成功结果":""}</small></>}
    {entry?.error&&!simulationEnabled&&<small role="alert">{entry.error}</small>}
   </article>;
  })}</div>{selected?.kind==="3x-ui"&&<VpsXuiDetails connection={selected} simulationEnabled={simulationEnabled} onClose={()=>setSelected(undefined)} onOpenPanel={onOpenPanel}/>}{selected?.kind==="sing-box"&&<VpsSingBoxDetails connection={selected} simulationEnabled={simulationEnabled} onClose={()=>setSelected(undefined)} onOpenPanel={onOpenPanel}/>}{selected?.kind==="tailscale"&&<VpsTailscaleDetails connection={selected} simulationEnabled={simulationEnabled} onClose={()=>setSelected(undefined)}/>}
 </section>;
}
