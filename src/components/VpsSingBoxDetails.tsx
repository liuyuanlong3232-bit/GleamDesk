import {useEffect,useRef,useState} from "react";
import {CloseIcon} from "./CloseIcon";
import {serviceIdentity,serviceBytes,singBoxDelay,singBoxSelection,type ServiceConnection,type SingBoxDetails,type SingBoxProxy} from "../domain/vps/services";
import {readSingBoxDetails,openSingBoxPanel,subscribeVpsServices} from "../services/vpsServices";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";
type Tab="groups"|"nodes"|"connections";
const message=(e:unknown)=>e instanceof Error?e.message:typeof e==="string"?e:"详情暂不可用";
const time=(value:number|null)=>value===null?"未提供":new Date(value).toLocaleString("zh-CN");

export function VpsSingBoxDetails({connection,simulationEnabled=false,onClose,onOpenPanel}:{connection:ServiceConnection;simulationEnabled?:boolean;onClose:()=>void;onOpenPanel?:(url:string,name:string)=>void}){
 const dialog=useRef<HTMLDialogElement>(null),request=useRef(0),mounted=useRef(false),pending=useRef<number|null>(null);
 const [details,setDetails]=useState<SingBoxDetails>(),[error,setError]=useState(""),[busy,setBusy]=useState(false),[invalidated,setInvalidated]=useState(false),[now,setNow]=useState(Date.now);
 const [tab,setTab]=useState<Tab>("groups"),[search,setSearch]=useState(""),[groupFilter,setGroupFilter]=useState(""),[page,setPage]=useState(0);
 const identity=serviceIdentity(connection);
 const refresh=async()=>{
  if(pending.current!==null||simulationEnabled||invalidated||!isWindowVisible())return;
  const id=++request.current;pending.current=id;setBusy(true);setError("");
  try{const value=await readSingBoxDetails(connection,simulationEnabled);if(mounted.current&&id===request.current){setDetails(value);setNow(Date.now());}}
  catch(e){if(mounted.current&&id===request.current)setError(message(e));}
  finally{if(pending.current===id)pending.current=null;if(mounted.current&&id===request.current){setBusy(false);setNow(Date.now());}}
 };
 useEffect(()=>{mounted.current=true;const element=dialog.current!,previous=document.activeElement as HTMLElement|null;element.showModal();return()=>{mounted.current=false;request.current++;element.close();if(previous?.isConnected)previous.focus();};},[]);
 useEffect(()=>{request.current++;pending.current=null;setDetails(undefined);setError("");setBusy(false);if(!simulationEnabled)void refresh();return()=>{request.current++;};},[identity,simulationEnabled]);
 useEffect(()=>subscribeVpsServices(()=>{request.current++;setDetails(undefined);setBusy(false);setInvalidated(true);setError("连接设置已变化，请关闭详情后重新打开");}),[]);
 useEffect(()=>{const update=()=>{if(isWindowVisible())setNow(Date.now());};const timer=window.setInterval(update,15000),stop=subscribeWindowVisibility(update);return()=>{window.clearInterval(timer);stop();};},[]);
 useEffect(()=>{setPage(0);},[tab,search,groupFilter,details]);
 const data=simulationEnabled||invalidated?undefined:details,proxies=data?.proxies??[],groups=proxies.filter(p=>p.members!==null),query=search.trim().toLowerCase();
 const match=(parts:unknown[])=>parts.join(" ").toLowerCase().includes(query);
 const visibleGroups=groups.filter(g=>match([g.name,g.proxyType,g.selected,...g.members!]));
 const nodes=proxies.filter(p=>p.members===null&&(groupFilter===""||groups.find(g=>g.name===groupFilter)?.members?.includes(p.name))&&match([p.name,p.proxyType]));
 const connections=(data?.connections?.entries??[]).filter(c=>match([c.destination,c.port,c.network,c.inbound,...c.chains??[]]));
 const total=tab==="groups"?visibleGroups.length:tab==="nodes"?nodes.length:connections.length,lastPage=Math.max(0,Math.ceil(total/50)-1),currentPage=Math.min(page,lastPage);
 const slice=<T,>(rows:T[])=>rows.slice(currentPage*50,(currentPage+1)*50);
 const delay=(p:SingBoxProxy)=><>{singBoxDelay(p)}{p.delayAtUnixMs!==null&&<small>{time(p.delayAtUnixMs)}{now-p.delayAtUnixMs>300000?" · 较旧记录":""}</small>}</>;
 const sectionError=tab==="connections"?data?.connectionsError:data?.proxiesError;
 return <dialog ref={dialog} className="xui-detail-dialog glass" aria-modal="true" aria-labelledby="singbox-detail-title" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target!==e.currentTarget)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose();}}>
  <header className="xui-detail-heading"><div><h2 id="singbox-detail-title">sing-box <small>只读详情</small></h2><p>{connection.endpoint}</p></div><div className="xui-detail-actions"><button type="button" disabled={simulationEnabled||invalidated||!onOpenPanel} onClick={()=>void openSingBoxPanel(connection,onOpenPanel!,simulationEnabled).catch(e=>setError(message(e)))}>打开原网页面板</button><button type="button" disabled={simulationEnabled||invalidated||busy} onClick={()=>void refresh()}>{busy?"读取中…":"刷新详情"}</button><button className="ui-icon-button" type="button" aria-label="关闭sing-box详情" autoFocus onClick={onClose}><CloseIcon/></button></div></header>
  <div className="xui-detail-content">
   {simulationEnabled?<p role="status">模拟模式 · 真实读取暂停</p>:<><div className="xui-detail-summary"><span>分组 <strong>{data?.proxies?groups.length:"—"}</strong></span><span>节点 <strong>{data?.proxies?proxies.length-groups.length:"—"}</strong></span><span>连接 <strong>{data?.connections?.entries.length??"—"}</strong></span><span>累计上传 <strong>{serviceBytes(data?.connections?.uploadBytes??null)}</strong></span><span>累计下载 <strong>{serviceBytes(data?.connections?.downloadBytes??null)}</strong></span><small>{data?`${data.version} · 读取 ${time(data.checkedAtUnixMs)}`:"尚未读取"}{data&&now-data.checkedAtUnixMs>120000?" · 数据未更新":""}</small></div>{error&&<p role="alert">{error}{data?"；下方保留上次结果":""}</p>}
   <nav className="xui-detail-tabs" role="tablist" aria-label="sing-box详情分类">{([["groups","分组"],["nodes","节点"],["connections","连接"]] as const).map(([id,name])=><button id={`singbox-tab-${id}`} key={id} type="button" role="tab" aria-selected={tab===id} aria-controls="singbox-detail-panel" onClick={()=>setTab(id)}>{name}</button>)}</nav>
   <div className="xui-detail-filters"><input aria-label="搜索sing-box详情" placeholder={tab==="connections"?"搜索目标、链路或入站":"搜索节点或分组"} value={search} onChange={e=>setSearch(e.target.value)} maxLength={240}/>{tab==="nodes"&&<select aria-label="筛选sing-box分组" value={groupFilter} onChange={e=>setGroupFilter(e.target.value)}><option value="">全部节点</option>{groups.map(g=><option key={g.name} value={g.name}>{g.name}</option>)}</select>}{(search||groupFilter!=="")&&<button type="button" onClick={()=>{setSearch("");setGroupFilter("");}}>清除筛选</button>}</div>
   <section id="singbox-detail-panel" role="tabpanel" aria-labelledby={`singbox-tab-${tab}`}>
    {sectionError?<p role="status">{sectionError}</p>:!data?<p className="xui-detail-empty">{busy?"正在读取已有记录…":"暂无可用详情"}</p>:<>
     <div className="xui-table-scroll"><table className="xui-table singbox-table"><thead><tr>{(tab==="groups"?["分组／类型","当前选择","成员","上次延迟记录"]:tab==="nodes"?["节点／类型","UDP","所属分组","上次延迟记录"]:["目标／端口","协议／入站","链路","累计上传","累计下载","连接开始"]).map((title,i)=><th key={title} className={tab==="connections"&&(i===3||i===4)?"numeric":""}>{title}</th>)}</tr></thead><tbody>
      {tab==="groups"&&slice(visibleGroups).map(g=><tr key={g.name}><td><strong>{g.name}</strong><small>{g.proxyType??"未提供类型"}</small></td><td>{singBoxSelection(g,proxies)}{g.selected&&singBoxSelection(g,proxies)==="未确认"&&<small>来源返回：{g.selected}</small>}</td><td><details className="singbox-members"><summary>{g.members!.length} 个成员</summary><ul>{g.members!.map(name=><li key={name}>{name}{!proxies.some(p=>p.name===name)?" · 详情未提供":""}{singBoxSelection(g,proxies)===name?" · 当前选择":""}</li>)}</ul></details><button type="button" onClick={()=>{setGroupFilter(g.name);setSearch("");setTab("nodes");}}>查看节点</button></td><td>{delay(g)}</td></tr>)}
      {tab==="nodes"&&slice(nodes).map(p=><tr key={p.name}><td><strong>{p.name}</strong><small>{p.proxyType??"未提供类型"}</small></td><td>{p.udp===null?"未提供":p.udp?"支持":"不支持"}</td><td>{groups.filter(g=>g.members!.includes(p.name)).map(g=><small key={g.name}>{g.name}{singBoxSelection(g,proxies)===p.name?" · 当前选择":""}</small>)}{!groups.some(g=>g.members!.includes(p.name))&&"未关联分组"}</td><td>{delay(p)}</td></tr>)}
      {tab==="connections"&&slice(connections).map((c,i)=><tr key={currentPage*50+i}><td><strong>{c.destination??"目标未提供"}</strong><small>端口 {c.port??"—"}</small></td><td>{c.network?.toUpperCase()??"—"}<small>{c.inbound??"未提供入站"}</small></td><td>{c.chains===null?"未提供":c.chains.length?c.chains.join(" → "):"空链路"}</td><td className="numeric">{serviceBytes(c.uploadBytes)}</td><td className="numeric">{serviceBytes(c.downloadBytes)}</td><td>{time(c.startedAtUnixMs)}</td></tr>)}
     </tbody></table></div>{!total&&<p className="xui-detail-empty">{query||tab==="nodes"&&groupFilter!==""?"没有符合筛选的记录":tab==="connections"?"读取时没有连接":tab==="groups"?"未返回分组":"未返回独立节点"}</p>}
     {total>50&&<footer className="xui-detail-pagination"><button disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>上一页</button><span>{currentPage+1} / {lastPage+1} · {total} 条</span><button disabled={currentPage===lastPage} onClick={()=>setPage(currentPage+1)}>下一页</button></footer>}
     <p className="xui-detail-note">{tab==="connections"?"连接是读取时的快照；累计流量不是瞬时网速。":tab==="groups"?"分组可包含其他分组。当前选择仅按来源记录展示，不改变选择。":"延迟是已有测试记录，不代表当前连通性；此处不主动测速。"}</p>
    </>}
   </section></>}
  </div>
  <footer className="xui-detail-footer">原网页面板需已配置 external_ui；不会安装或传入密钥，登录后按面板权限操作。</footer>
 </dialog>;
}
