import {Fragment,useEffect,useRef,useState} from "react";
import {CloseIcon} from "./CloseIcon";
import {serviceIdentity,serviceBytes,tailscaleBackend,tailscalePath,tailscaleExpiry,type ServiceConnection,type TailscaleDetails,type TailscaleDevice} from "../domain/vps/services";
import {readTailscaleDetails,subscribeVpsServices} from "../services/vpsServices";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";
const message=(e:unknown)=>e instanceof Error?e.message:typeof e==="string"?e:"详情暂不可用";
const time=(n:number|null)=>n===null?"未提供":new Date(n).toLocaleString("zh-CN");
const online=(n:boolean|null)=>n===null?"未确认":n?"在线":"离线";
const name=(d:TailscaleDevice)=>d.name||d.dnsName?.replace(/\.$/,"")||`未命名设备 #${d.rowId}`;
const strings=(items:string[]|null)=>items===null?"未提供":items.length?items.join("、"):"无";
const exitRole=(d:TailscaleDevice)=>d.exitNode===true?"已选出口":d.exitNodeOption===true?"可作出口":d.exitNode===false&&d.exitNodeOption===false?"普通设备":"未确认";
function DeviceFacts({device,now}:{device:TailscaleDevice;now:number}){return <dl className="tailscale-facts"><div><dt>DNS 名称</dt><dd>{device.dnsName??"未提供"}</dd></div><div><dt>标签</dt><dd>{strings(device.tags)}</dd></div><div><dt>主要子网路由</dt><dd>{strings(device.primaryRoutes)}</dd></div><div><dt>密钥有效期</dt><dd>{tailscaleExpiry(device,now)}{device.keyExpiryAtUnixMs!==null&&<small>{time(device.keyExpiryAtUnixMs)}</small>}</dd></div><div><dt>最近离线记录</dt><dd>{time(device.lastSeenAtUnixMs)}</dd></div><div><dt>最近握手</dt><dd>{time(device.lastHandshakeAtUnixMs)}</dd></div></dl>;}

export function VpsTailscaleDetails({connection,simulationEnabled=false,onClose}:{connection:ServiceConnection;simulationEnabled?:boolean;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),request=useRef(0),mounted=useRef(false),pending=useRef<number|null>(null);
 const [details,setDetails]=useState<TailscaleDetails>(),[error,setError]=useState(""),[busy,setBusy]=useState(false),[invalidated,setInvalidated]=useState(false),[now,setNow]=useState(Date.now);
 const [tab,setTab]=useState<"self"|"peers">("self"),[search,setSearch]=useState(""),[filter,setFilter]=useState("all"),[page,setPage]=useState(0),[expanded,setExpanded]=useState<number|null>(null);
 const identity=serviceIdentity(connection);
 const refresh=async()=>{
  if(pending.current!==null||simulationEnabled||invalidated||!isWindowVisible())return;
  const id=++request.current;pending.current=id;setBusy(true);setError("");
  try{const value=await readTailscaleDetails(connection,simulationEnabled);if(mounted.current&&id===request.current){setDetails(value);setNow(Date.now());}}
  catch(e){if(mounted.current&&id===request.current)setError(message(e));}
  finally{if(pending.current===id)pending.current=null;if(mounted.current&&id===request.current){setBusy(false);setNow(Date.now());}}
 };
 useEffect(()=>{mounted.current=true;const element=dialog.current!,previous=document.activeElement as HTMLElement|null;element.showModal();return()=>{mounted.current=false;request.current++;element.close();if(previous?.isConnected)previous.focus();};},[]);
 useEffect(()=>{request.current++;pending.current=null;setDetails(undefined);setError("");setBusy(false);if(!simulationEnabled)void refresh();return()=>{request.current++;};},[identity,simulationEnabled]);
 useEffect(()=>subscribeVpsServices(()=>{request.current++;setDetails(undefined);setBusy(false);setInvalidated(true);setError("连接设置已变化，请关闭详情后重新打开");}),[]);
 useEffect(()=>{const update=()=>{if(isWindowVisible())setNow(Date.now());};const timer=window.setInterval(update,15000),stop=subscribeWindowVisibility(update);return()=>{window.clearInterval(timer);stop();};},[]);
 useEffect(()=>{setPage(0);setExpanded(null);},[tab,search,filter,details]);
 const data=simulationEnabled||invalidated?undefined:details,peers=data?.peers??[],self=data?.selfNode,query=search.trim().toLowerCase();
 const filtered=peers.filter(d=>[d.name,d.dnsName,d.os,...d.ips??[],...d.tags??[],...d.primaryRoutes??[]].join(" ").toLowerCase().includes(query)&&(filter==="all"||filter==="online"&&d.online===true||filter==="offline"&&d.online===false||filter==="unknown"&&d.online===null||filter==="exit"&&(d.exitNode===true||d.exitNodeOption===true)));
 const lastPage=Math.max(0,Math.ceil(filtered.length/50)-1),currentPage=Math.min(page,lastPage),shown=filtered.slice(currentPage*50,(currentPage+1)*50);
 return <dialog ref={dialog} className="xui-detail-dialog glass" aria-modal="true" aria-labelledby="tailscale-detail-title" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target!==e.currentTarget)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose();}}>
  <header className="xui-detail-heading"><div><h2 id="tailscale-detail-title">Tailscale <small>VPS 只读详情</small></h2><p>SSH · {connection.endpoint}</p></div><div className="xui-detail-actions"><button type="button" disabled={simulationEnabled||invalidated||busy} onClick={()=>void refresh()}>{busy?"读取中…":"刷新详情"}</button><button className="ui-icon-button" type="button" aria-label="关闭Tailscale详情" autoFocus onClick={onClose}><CloseIcon/></button></div></header>
  <div className="xui-detail-content">
   {simulationEnabled?<p role="status">模拟模式 · 真实读取暂停</p>:<><div className="xui-detail-summary"><span>服务 <strong>{data?tailscaleBackend(data.backendState):"—"}</strong></span><span>可见设备 <strong>{data?.peers?peers.length:"—"}</strong></span><span>来源在线 <strong>{data?.peers?peers.filter(d=>d.online===true).length:"—"}</strong></span><small>{data?`${data.version??"版本未提供"} · 读取 ${time(data.checkedAtUnixMs)}`:"尚未读取"}{data&&now-data.checkedAtUnixMs>120000?" · 数据未更新":""}</small></div>{error&&<p role="alert">{error}{data?"；下方保留上次结果":""}</p>}
   <nav className="xui-detail-tabs" role="tablist" aria-label="Tailscale详情分类">{([["self","VPS 本机"],["peers","对等设备"]] as const).map(([id,label])=><button id={`tailscale-tab-${id}`} key={id} role="tab" type="button" aria-selected={tab===id} aria-controls="tailscale-detail-panel" onClick={()=>setTab(id)}>{label}</button>)}</nav>
   <section id="tailscale-detail-panel" role="tabpanel" aria-labelledby={`tailscale-tab-${tab}`}>
    {!data?<p className="xui-detail-empty">{busy?"正在读取已有状态…":"暂无可用详情"}</p>:tab==="self"?<>
     <dl className="tailscale-facts tailscale-overview"><div><dt>状态检查</dt><dd>{data.healthWarningCount===null?"未提供":data.healthWarningCount?`${data.healthWarningCount} 项提示，请在原管理端查看`:"来源未报告异常"}</dd></div><div><dt>网络 MagicDNS</dt><dd>{data.magicDnsEnabled===null?"未提供":data.magicDnsEnabled?"启用":"关闭"}</dd></div></dl>
     {data.selfError?<p role="status">{data.selfError}</p>:!self?<p className="xui-detail-empty">来源未提供 VPS 本机信息</p>:<><dl className="tailscale-facts tailscale-overview"><div><dt>设备</dt><dd>{name(self)}<small>{self.os??"系统未提供"}</small></dd></div><div><dt>Tailscale 地址</dt><dd>{strings(self.ips)}</dd></div><div><dt>连接控制服务</dt><dd>{online(self.online)}</dd></div><div><dt>出口角色</dt><dd>{exitRole(self)}</dd></div></dl><DeviceFacts device={self} now={now}/></>}
    </>:<><div className="xui-detail-filters"><input aria-label="搜索Tailscale设备" placeholder="搜索设备、地址、标签或路由" value={search} onChange={e=>setSearch(e.target.value)} maxLength={240}/><select aria-label="筛选Tailscale设备" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部设备</option><option value="online">来源在线</option><option value="offline">来源离线</option><option value="unknown">在线未确认</option><option value="exit">出口设备</option></select>{(query||filter!=="all")&&<button type="button" onClick={()=>{setSearch("");setFilter("all");}}>清除筛选</button>}</div>
     {data.peersError?<p role="status">{data.peersError}</p>:<><div className="xui-table-scroll"><table className="xui-table tailscale-table"><thead><tr><th>设备／地址</th><th>控制服务</th><th>近期路径</th><th className="numeric">累计发送</th><th className="numeric">累计接收</th><th>最近握手</th><th>出口角色</th><th>详情</th></tr></thead><tbody>{shown.map(d=><Fragment key={d.rowId}><tr><td><strong>{name(d)}</strong><small>{strings(d.ips)}</small><small>{d.os??"系统未提供"}</small></td><td>{online(d.online)}</td><td>{tailscalePath(d)}</td><td className="numeric">{serviceBytes(d.uploadBytes)}</td><td className="numeric">{serviceBytes(d.downloadBytes)}</td><td>{time(d.lastHandshakeAtUnixMs)}</td><td>{exitRole(d)}</td><td><button type="button" aria-label={`查看设备详情 ${name(d)} #${d.rowId}`} aria-expanded={expanded===d.rowId} aria-controls={`tailscale-device-${d.rowId}`} onClick={()=>setExpanded(expanded===d.rowId?null:d.rowId)}>{expanded===d.rowId?"收起":"查看"}</button></td></tr>{expanded===d.rowId&&<tr id={`tailscale-device-${d.rowId}`} className="tailscale-expanded"><td colSpan={8}><DeviceFacts device={d} now={now}/></td></tr>}</Fragment>)}</tbody></table></div>{!shown.length&&<p className="xui-detail-empty">{query||filter!=="all"?"没有符合筛选的设备":"当前视图未返回对等设备"}</p>}{filtered.length>50&&<footer className="xui-detail-pagination"><button disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>上一页</button><span>{currentPage+1} / {lastPage+1} · {filtered.length} 条</span><button disabled={currentPage===lastPage} onClick={()=>setPage(currentPage+1)}>下一页</button></footer>}</>}
    </>}
   </section><p className="xui-detail-note">设备列表受 VPS 可见范围和权限限制。在线不等于正在直连；流量是 VPS 与对等设备的累计记录。</p></>}
  </div><footer className="xui-detail-footer">仅通过已有 SSH 读取状态；不安装软件、不发起 Tailscale 登录或探测，不改配置。</footer>
 </dialog>;
}
