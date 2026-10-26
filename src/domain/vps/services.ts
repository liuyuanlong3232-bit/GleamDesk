export const serviceKinds = ["3x-ui", "sing-box", "tailscale"] as const;
export type ServiceKind = typeof serviceKinds[number];
export const serviceNames:Record<ServiceKind,string>={"3x-ui":"3x-ui","sing-box":"sing-box",tailscale:"Tailscale（VPS）"};
export interface ServiceConnection {kind:ServiceKind;endpoint:string;enabled:boolean;autoRefresh:boolean}
export interface ServiceSnapshot {
 kind:ServiceKind;endpoint:string;state:"online"|"offline"|"unknown";detail:string;version:string|null;
 uploadBytes:number|null;downloadBytes:number|null;connections:number|null;checkedAtUnixMs:number;
}
export const serviceIdentity=(c:ServiceConnection)=>JSON.stringify([c.kind,c.endpoint,c.enabled,c.autoRefresh]);
export function parseServiceConnections(raw:unknown):ServiceConnection[]{
 if(!Array.isArray(raw)||raw.length>3)throw Error("服务配置格式无效");
 const seen=new Set<string>();
 return raw.map(c=>{
  if(!c||!serviceKinds.includes(c.kind)||seen.has(c.kind)||typeof c.endpoint!=="string"||c.endpoint.length>500||typeof c.enabled!=="boolean"||typeof c.autoRefresh!=="boolean")throw Error("服务配置格式无效");
  seen.add(c.kind);return {kind:c.kind,endpoint:c.endpoint,enabled:c.enabled,autoRefresh:c.autoRefresh};
 });
}
export function parseServiceSnapshot(raw:unknown,connection:ServiceConnection,now=Date.now()):ServiceSnapshot{
 const value=raw as ServiceSnapshot;
 const counter=(n:unknown)=>n===null||(Number.isSafeInteger(n)&&Number(n)>=0);
 if(!value||value.kind!==connection.kind||value.endpoint!==connection.endpoint||!["online","offline","unknown"].includes(value.state)
  ||typeof value.detail!=="string"||value.detail.length>120||/[\r\n]/.test(value.detail)
  ||!(value.version===null||typeof value.version==="string"&&value.version.length<=80)
  ||!counter(value.uploadBytes)||!counter(value.downloadBytes)||!counter(value.connections)
  ||!Number.isSafeInteger(value.checkedAtUnixMs)||value.checkedAtUnixMs<0||value.checkedAtUnixMs>now+1000)throw Error("服务状态格式或来源不匹配");
 return {kind:value.kind,endpoint:value.endpoint,state:value.state,detail:value.detail,version:value.version,uploadBytes:value.uploadBytes,downloadBytes:value.downloadBytes,connections:value.connections,checkedAtUnixMs:value.checkedAtUnixMs};
}
export function serviceStatus(snapshot:ServiceSnapshot|undefined,error:string,now=Date.now()):string{
 if(error)return "无法检查";
 if(!snapshot)return "尚未读取";
 if(now-snapshot.checkedAtUnixMs>120000)return "数据未更新";
 return snapshot.detail;
}
export function serviceBytes(value:number|null):string{
 if(value===null)return "—";
 if(value>=1024**3)return `${(value/1024**3).toFixed(2)} GiB`;
 if(value>=1024**2)return `${(value/1024**2).toFixed(1)} MiB`;
 if(value>=1024)return `${(value/1024).toFixed(1)} KiB`;
 return `${value} B`;
}

export interface XuiClient {name:string;enabled:boolean|null;uploadBytes:number|null;downloadBytes:number|null;quotaBytes:number|null;expiryTime:number|null;lastOnlineAtUnixMs:number|null}
export interface XuiInbound {id:number;name:string|null;nodeId:number|null;protocol:string|null;port:number|null;enabled:boolean|null;uploadBytes:number|null;downloadBytes:number|null;quotaBytes:number|null;expiryTime:number|null;clients:XuiClient[]|null}
export interface XuiNode {id:number;name:string|null;address:string|null;port:number|null;enabled:boolean|null;state:"online"|"offline"|"unknown";inboundCount:number|null;clientCount:number|null;heartbeatAtUnixMs:number|null;xrayVersion:string|null;panelVersion:string|null}
export interface XuiDetails {kind:"3x-ui";endpoint:string;checkedAtUnixMs:number;inbounds:XuiInbound[]|null;nodes:XuiNode[]|null;inboundsError:string|null;nodesError:string|null}
export function parseXuiDetails(raw:unknown,connection:ServiceConnection,now=Date.now()):XuiDetails{
 const value=raw as XuiDetails,fail=()=>{throw Error("3x-ui 详情格式或来源不匹配");};
 const integer=(n:unknown)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
 const nullableCounter=(n:unknown)=>n===null||integer(n),bool=(n:unknown)=>n===null||typeof n==="boolean";
 const text=(n:unknown)=>n===null||typeof n==="string"&&n.trim().length>0&&n.length<=240&&!/[\u0000-\u001f\u007f]/.test(n);
 const expiry=(n:unknown)=>n===null||Number.isSafeInteger(n)&&(n===0||Number(n)>=946684800000&&Number(n)<=8640000000000000||Number(n)<0&&Number(n)>=-3153600000000);
 const stamp=(n:unknown)=>n===null||integer(n)&&Number(n)>=946684800000&&Number(n)<=now+300000;
 const port=(n:unknown)=>n===null||integer(n)&&Number(n)>0&&Number(n)<=65535;
 if(!value||connection.kind!=="3x-ui"||value.kind!==connection.kind||value.endpoint!==connection.endpoint||!integer(value.checkedAtUnixMs)||value.checkedAtUnixMs>now+1000||!text(value.inboundsError)||!text(value.nodesError))fail();
 if(value.inbounds!==null&&!Array.isArray(value.inbounds)||value.nodes!==null&&!Array.isArray(value.nodes))fail();
 if((value.inbounds===null)!==(value.inboundsError!==null)||(value.nodes===null)!==(value.nodesError!==null))fail();
 const inboundIds=new Set<number>(),nodeIds=new Set<number>();let clientCount=0;
 const inbounds=value.inbounds===null?null:value.inbounds.map(row=>{
  if(!row||!integer(row.id)||row.id===0||inboundIds.has(row.id)||!text(row.name)||!nullableCounter(row.nodeId)||!text(row.protocol)||!port(row.port)||!bool(row.enabled)||!nullableCounter(row.uploadBytes)||!nullableCounter(row.downloadBytes)||!nullableCounter(row.quotaBytes)||!expiry(row.expiryTime)||row.clients!==null&&!Array.isArray(row.clients))fail();inboundIds.add(row.id);
  const names=new Set<string>();
  const clients=row.clients===null?null:row.clients.map(client=>{
   if(!client||!text(client.name)||client.name===null||names.has(client.name)||!bool(client.enabled)||!nullableCounter(client.uploadBytes)||!nullableCounter(client.downloadBytes)||!nullableCounter(client.quotaBytes)||!expiry(client.expiryTime)||!stamp(client.lastOnlineAtUnixMs))fail();names.add(client.name);clientCount++;
   return {name:client.name,enabled:client.enabled,uploadBytes:client.uploadBytes,downloadBytes:client.downloadBytes,quotaBytes:client.quotaBytes,expiryTime:client.expiryTime,lastOnlineAtUnixMs:client.lastOnlineAtUnixMs};
  });
  return {id:row.id,name:row.name,nodeId:row.nodeId,protocol:row.protocol,port:row.port,enabled:row.enabled,uploadBytes:row.uploadBytes,downloadBytes:row.downloadBytes,quotaBytes:row.quotaBytes,expiryTime:row.expiryTime,clients};
 });
 const nodes=value.nodes===null?null:value.nodes.map(row=>{
  if(!row||!integer(row.id)||row.id===0||nodeIds.has(row.id)||!text(row.name)||!text(row.address)||!port(row.port)||!bool(row.enabled)||!["online","offline","unknown"].includes(row.state)||!nullableCounter(row.inboundCount)||!nullableCounter(row.clientCount)||!stamp(row.heartbeatAtUnixMs)||!text(row.xrayVersion)||!text(row.panelVersion))fail();nodeIds.add(row.id);
  return {id:row.id,name:row.name,address:row.address,port:row.port,enabled:row.enabled,state:row.state,inboundCount:row.inboundCount,clientCount:row.clientCount,heartbeatAtUnixMs:row.heartbeatAtUnixMs,xrayVersion:row.xrayVersion,panelVersion:row.panelVersion};
 });
 if((inbounds?.length??0)>200||(nodes?.length??0)>200||clientCount>2000)fail();
 return {kind:"3x-ui",endpoint:value.endpoint,checkedAtUnixMs:value.checkedAtUnixMs,inbounds,nodes,inboundsError:value.inboundsError,nodesError:value.nodesError};
}
export function xuiUsed(row:Pick<XuiClient,"uploadBytes"|"downloadBytes">):number|null{
 const n=row.uploadBytes!==null&&row.downloadBytes!==null?row.uploadBytes+row.downloadBytes:null;
 return n!==null&&Number.isSafeInteger(n)?n:null;
}
export function xuiUseState(row:Pick<XuiClient,"enabled"|"expiryTime"|"quotaBytes"|"uploadBytes"|"downloadBytes">,now=Date.now()):string{
 if(row.enabled===false)return "停用";
 if(row.expiryTime!==null&&row.expiryTime>0&&row.expiryTime<=now)return "已到期";
 const used=xuiUsed(row);if(row.quotaBytes!==null&&row.quotaBytes>0&&used!==null&&used>=row.quotaBytes)return "额度用尽";
 return row.enabled===true?"启用":"未确认";
}
export function xuiExpiry(time:number|null):string{return time===null?"未提供":time===0?"不限期":time<0?"待首次使用":new Date(time).toLocaleString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});}

export interface SingBoxProxy {name:string;proxyType:string|null;udp:boolean|null;members:string[]|null;selected:string|null;delayMs:number|null;delayAtUnixMs:number|null}
export interface SingBoxConnection {destination:string|null;port:number|null;network:string|null;inbound:string|null;chains:string[]|null;uploadBytes:number|null;downloadBytes:number|null;startedAtUnixMs:number|null}
export interface SingBoxDetails {kind:"sing-box";endpoint:string;version:string;checkedAtUnixMs:number;proxies:SingBoxProxy[]|null;connections:{uploadBytes:number;downloadBytes:number;entries:SingBoxConnection[]}|null;proxiesError:string|null;connectionsError:string|null}
export function parseSingBoxDetails(raw:unknown,connection:ServiceConnection,now=Date.now()):SingBoxDetails{
 const v=raw as SingBoxDetails,fail=()=>{throw Error("sing-box 详情格式或来源不匹配");};
 const integer=(n:unknown)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
 const counter=(n:unknown)=>n===null||integer(n),text=(s:unknown)=>s===null||typeof s==="string"&&s.trim().length>0&&s.length<=240&&!/[\u0000-\u001f\u007f]/.test(s);
 const stamp=(n:unknown)=>n===null||integer(n)&&Number(n)<=now+1000;
 const names=(a:unknown,max:number)=>Array.isArray(a)&&a.length<=max&&a.every(s=>typeof s==="string"&&text(s))&&new Set(a).size===a.length;
 if(!v||connection.kind!=="sing-box"||v.kind!==connection.kind||v.endpoint!==connection.endpoint||!integer(v.checkedAtUnixMs)||v.checkedAtUnixMs>now+1000||typeof v.version!=="string"||v.version.length>80||!/^sing-box [\w .+()\-]+$/i.test(v.version)||!text(v.proxiesError)||!text(v.connectionsError))fail();
 if((v.proxies===null)!==(v.proxiesError!==null)||(v.connections===null)!==(v.connectionsError!==null))fail();
 if(v.proxies!==null&&(!Array.isArray(v.proxies)||v.proxies.length>500)||v.connections!==null&&(!integer(v.connections.uploadBytes)||!integer(v.connections.downloadBytes)||!Array.isArray(v.connections.entries)||v.connections.entries.length>2000))fail();
 const seen=new Set<string>();
 const proxies=v.proxies===null?null:v.proxies.map(p=>{
  if(!p||typeof p.name!=="string"||!text(p.name)||seen.has(p.name)||!text(p.proxyType)||!(p.udp===null||typeof p.udp==="boolean")||!(p.members===null||names(p.members,500))||!text(p.selected)||!counter(p.delayMs)||p.delayMs!==null&&p.delayMs>65535||!stamp(p.delayAtUnixMs)||(p.delayMs===null)!==(p.delayAtUnixMs===null))fail();seen.add(p.name);
  return {name:p.name,proxyType:p.proxyType,udp:p.udp,members:p.members===null?null:[...p.members],selected:p.selected,delayMs:p.delayMs,delayAtUnixMs:p.delayAtUnixMs};
 });
 const connections=v.connections===null?null:{uploadBytes:v.connections.uploadBytes,downloadBytes:v.connections.downloadBytes,entries:v.connections.entries.map(c=>{
  if(!c||!text(c.destination)||!counter(c.port)||c.port!==null&&(c.port<1||c.port>65535)||!text(c.network)||!text(c.inbound)||!(c.chains===null||names(c.chains,64))||!counter(c.uploadBytes)||!counter(c.downloadBytes)||!stamp(c.startedAtUnixMs))fail();
  return {destination:c.destination,port:c.port,network:c.network,inbound:c.inbound,chains:c.chains===null?null:[...c.chains],uploadBytes:c.uploadBytes,downloadBytes:c.downloadBytes,startedAtUnixMs:c.startedAtUnixMs};
 })};
 return {kind:"sing-box",endpoint:v.endpoint,version:v.version,checkedAtUnixMs:v.checkedAtUnixMs,proxies,connections,proxiesError:v.proxiesError,connectionsError:v.connectionsError};
}
export function singBoxSelection(group:SingBoxProxy,proxies:SingBoxProxy[]):string{
 return group.members!==null&&group.selected&&group.members.includes(group.selected)&&proxies.some(p=>p.name===group.selected)?group.selected:"未确认";
}
export function singBoxDelay(proxy:SingBoxProxy):string{return proxy.delayMs===null||proxy.delayAtUnixMs===null?"无记录":proxy.delayMs===0?"上次测试失败":`${proxy.delayMs} ms`;}

export interface TailscaleDevice {rowId:number;name:string|null;dnsName:string|null;os:string|null;ips:string[]|null;online:boolean|null;active:boolean|null;connection:"direct"|"derp"|"peer-relay"|"unknown";relayRegion:string|null;uploadBytes:number|null;downloadBytes:number|null;lastSeenAtUnixMs:number|null;lastHandshakeAtUnixMs:number|null;exitNode:boolean|null;exitNodeOption:boolean|null;tags:string[]|null;primaryRoutes:string[]|null;expired:boolean|null;keyExpiryAtUnixMs:number|null}
export interface TailscaleDetails {kind:"tailscale";endpoint:string;version:string|null;backendState:string;checkedAtUnixMs:number;selfNode:TailscaleDevice|null;peers:TailscaleDevice[]|null;selfError:string|null;peersError:string|null;healthWarningCount:number|null;magicDnsEnabled:boolean|null}
export function parseTailscaleDetails(raw:unknown,connection:ServiceConnection,now=Date.now()):TailscaleDetails{
 const v=raw as TailscaleDetails,fail=()=>{throw Error("Tailscale 详情格式或来源不匹配");};
 const integer=(n:unknown)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0,counter=(n:unknown)=>n===null||integer(n),bool=(n:unknown)=>n===null||typeof n==="boolean";
 const text=(s:unknown)=>s===null||typeof s==="string"&&s.trim().length>0&&s.length<=240&&!/[\u0000-\u001f\u007f]/.test(s);
 const stamp=(n:unknown)=>n===null||integer(n)&&Number(n)<=now+1000;
 const list=(a:unknown)=>a===null||Array.isArray(a)&&a.length<=64&&a.every(s=>typeof s==="string"&&text(s))&&new Set(a).size===a.length;
 if(!v||connection.kind!=="tailscale"||v.kind!==connection.kind||v.endpoint!==connection.endpoint||!integer(v.checkedAtUnixMs)||v.checkedAtUnixMs>now+1000||!text(v.version)||!text(v.selfError)||!text(v.peersError)||!["NoState","NeedsLogin","NeedsMachineAuth","Stopped","Starting","Running","Unknown"].includes(v.backendState)||!counter(v.healthWarningCount)||!bool(v.magicDnsEnabled))fail();
 if(v.peers!==null&&(!Array.isArray(v.peers)||v.peers.length>500)||(v.peers===null)!==(v.peersError!==null)||v.selfNode!==null&&v.selfError!==null)fail();
 const device=(p:TailscaleDevice,self:boolean):TailscaleDevice=>{
  if(!p||!integer(p.rowId)||(self?p.rowId!==0:p.rowId===0)||![p.name,p.dnsName,p.os,p.relayRegion].every(text)||![p.online,p.active,p.exitNode,p.exitNodeOption,p.expired].every(bool)||![p.ips,p.tags,p.primaryRoutes].every(list)||![p.uploadBytes,p.downloadBytes].every(counter)||![p.lastSeenAtUnixMs,p.lastHandshakeAtUnixMs].every(stamp)||!counter(p.keyExpiryAtUnixMs)||p.keyExpiryAtUnixMs!==null&&p.keyExpiryAtUnixMs>253402300799999||!["direct","derp","peer-relay","unknown"].includes(p.connection)||p.connection!=="unknown"&&p.active!==true||p.connection!=="derp"&&p.relayRegion!==null)fail();
  return {rowId:p.rowId,name:p.name,dnsName:p.dnsName,os:p.os,ips:p.ips===null?null:[...p.ips],online:p.online,active:p.active,connection:p.connection,relayRegion:p.relayRegion,uploadBytes:p.uploadBytes,downloadBytes:p.downloadBytes,lastSeenAtUnixMs:p.lastSeenAtUnixMs,lastHandshakeAtUnixMs:p.lastHandshakeAtUnixMs,exitNode:p.exitNode,exitNodeOption:p.exitNodeOption,tags:p.tags===null?null:[...p.tags],primaryRoutes:p.primaryRoutes===null?null:[...p.primaryRoutes],expired:p.expired,keyExpiryAtUnixMs:p.keyExpiryAtUnixMs};
 };
 const selfNode=v.selfNode===null?null:device(v.selfNode,true),seen=new Set<number>();
 const peers=v.peers===null?null:v.peers.map(p=>{const d=device(p,false);if(seen.has(d.rowId))fail();seen.add(d.rowId);return d;});
 return {kind:"tailscale",endpoint:v.endpoint,version:v.version,backendState:v.backendState,checkedAtUnixMs:v.checkedAtUnixMs,selfNode,peers,selfError:v.selfError,peersError:v.peersError,healthWarningCount:v.healthWarningCount,magicDnsEnabled:v.magicDnsEnabled};
}
export function tailscaleBackend(state:string):string{return ({Running:"运行中",Starting:"启动中",Stopped:"已停止",NeedsLogin:"需要登录",NeedsMachineAuth:"等待设备授权",NoState:"尚无状态",Unknown:"状态未确认"} as Record<string,string>)[state]??"状态未确认";}
export function tailscalePath(device:TailscaleDevice):string{
 if(device.active!==true)return device.active===false?"无近期活动":"未确认";
 return device.connection==="direct"?"直连":device.connection==="peer-relay"?"设备中继":device.connection==="derp"?`DERP 中继${device.relayRegion?` · ${device.relayRegion}`:""}`:"路径未确认";
}
export function tailscaleExpiry(device:TailscaleDevice,now=Date.now()):string{
 if(device.expired===true)return "已过期";
 if(device.keyExpiryAtUnixMs!==null)return device.keyExpiryAtUnixMs<=now?"已到期":"有效期内";
 return device.expired===false?"来源标记未过期":"未提供";
}
