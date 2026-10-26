import test from "node:test";
import assert from "node:assert/strict";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {parseServiceConnections,parseServiceSnapshot,serviceStatus,serviceBytes,parseXuiDetails,xuiUsed,xuiUseState,xuiExpiry,parseSingBoxDetails,singBoxDelay,singBoxSelection,parseTailscaleDetails,tailscalePath,tailscaleBackend,tailscaleExpiry,type ServiceConnection,type XuiDetails,type SingBoxDetails,type TailscaleDetails,type TailscaleDevice} from "../src/domain/vps/services";
import {readVpsService,serviceToken,readXuiDetails,xuiPanelUrl,openXuiPanel,readSingBoxDetails,singBoxPanelUrl,openSingBoxPanel,readTailscaleDetails} from "../src/services/vpsServices";
import {temporaryWebApp} from "../src/services/webAppStore";
import {emptyVpsObservation} from "../src/providers/server/beszelProvider";
import {presentVps} from "../src/presentation/vpsAdapter";
const c:ServiceConnection={kind:"sing-box",endpoint:"https://my.example",enabled:true,autoRefresh:false};
const now=Date.parse("2026-10-25T03:00:00Z");
const fixture=()=>({kind:c.kind,endpoint:c.endpoint,state:"online",detail:"Clash API 可读取",version:"sing-box 1.12.0",uploadBytes:0,downloadBytes:1024,connections:1,checkedAtUnixMs:now});
const xui:ServiceConnection={...c,kind:"3x-ui",endpoint:"https://my.example/custom-base"};
const xuiFixture=():XuiDetails=>({kind:"3x-ui",endpoint:xui.endpoint,checkedAtUnixMs:now,inboundsError:null,nodesError:null,nodes:[],inbounds:[{id:1,name:"测试入站",nodeId:0,protocol:"vless",port:443,enabled:true,uploadBytes:0,downloadBytes:1024,quotaBytes:0,expiryTime:0,clients:[{name:"alice",enabled:true,uploadBytes:0,downloadBytes:1024,quotaBytes:4096,expiryTime:-604800000,lastOnlineAtUnixMs:null}]}]});
test("未配置时不再制造三个未知服务",()=>{
 assert.deepEqual(presentVps(emptyVpsObservation(),"unavailable").services,[]);
 assert.deepEqual(parseServiceConnections([]),[]);
});
test("配置不接受重复类型或缺失启用意图，返回只保留非敏感字段",()=>{
 for(const bad of [[c,c],[{...c,kind:"other"}],[{...c,enabled:undefined}],null])assert.throws(()=>parseServiceConnections(bad));
 const value=parseServiceConnections([{...c,token:"should-not-persist"}]);assert.deepEqual(value,[c]);assert.equal(JSON.stringify(value).includes("should-not-persist"),false);
});
test("状态结果必须属于当前服务和地址，不挪用其他主机",()=>{
 assert.equal(parseServiceSnapshot(fixture(),c,now).uploadBytes,0);
 for(const patch of [{kind:"3x-ui"},{endpoint:"https://other.example"},{checkedAtUnixMs:now+2000},{state:"up"},{detail:"invalid\ntext"}])assert.throws(()=>parseServiceSnapshot({...fixture(),...patch},c,now));
});
test("缺失和错误的计数不能变为零",()=>{
 for(const n of [undefined,-1,1.2,Infinity,"42",Number.MAX_SAFE_INTEGER+1])assert.throws(()=>parseServiceSnapshot({...fixture(),uploadBytes:n},c,now));
 assert.equal(parseServiceSnapshot({...fixture(),uploadBytes:null},c,now).uploadBytes,null);
 assert.equal(serviceBytes(null),"—");assert.equal(serviceBytes(0),"0 B");assert.equal(serviceBytes(1024),"1.0 KiB");
});
test("读取失败和过期结果不显示在线，保留真实检查时刻",()=>{
 const snapshot=parseServiceSnapshot(fixture(),c,now);
 assert.equal(serviceStatus(snapshot,"timeout",now),"无法检查");assert.equal(serviceStatus(snapshot,"",now+120001),"数据未更新");
 assert.equal(serviceStatus(undefined,"",now),"尚未读取");assert.equal(serviceStatus(snapshot,"",now),"Clash API 可读取");assert.equal(snapshot.checkedAtUnixMs,now);
});
test("关闭的连接和模拟模式不进入真实 IPC",async()=>{
 const priorWindow=Object.getOwnPropertyDescriptor(globalThis,"window"),priorTauri=Object.getOwnPropertyDescriptor(globalThis,"isTauri");
 let requests=0;
 try {
  Object.defineProperty(globalThis,"window",{configurable:true,value:{}});Object.defineProperty(globalThis,"isTauri",{configurable:true,value:true});
  mockIPC(()=>{requests++;throw Error("unexpected IPC")});
  await assert.rejects(readVpsService({...c,enabled:false}));await assert.rejects(readVpsService(c,true),/模拟/);await assert.rejects(readXuiDetails(xui,true),/模拟/);await assert.rejects(readSingBoxDetails(c,true),/模拟/);await assert.rejects(readSingBoxDetails({...c,enabled:false}));await assert.rejects(openSingBoxPanel(c,()=>{throw Error("must not open")},true),/模拟/);await assert.rejects(readTailscaleDetails({kind:"tailscale",endpoint:"my-vps",enabled:true,autoRefresh:false},true),/模拟/);assert.equal(requests,0);
 }finally{clearMocks();if(priorWindow)Object.defineProperty(globalThis,"window",priorWindow);else Reflect.deleteProperty(globalThis,"window");if(priorTauri)Object.defineProperty(globalThis,"isTauri",priorTauri);else Reflect.deleteProperty(globalThis,"isTauri");}
});
test("3x-ui详情核对地址并仅保留列表展示字段",()=>{
 const raw:any=xuiFixture();raw.inbounds[0].settings={password:"SECRET"};raw.inbounds[0].clients[0].uuid="SECRET";raw.inbounds[0].clients[0].subId="SECRET";
 const result=parseXuiDetails(raw,xui,now);assert.equal(result.inbounds![0].clients![0].name,"alice");assert.equal(JSON.stringify(result).includes("SECRET"),false);
 for(const patch of [{endpoint:"https://other.example"},{checkedAtUnixMs:now+3000},{kind:"sing-box"}])assert.throws(()=>parseXuiDetails({...raw,...patch},xui,now));
 const duplicated=xuiFixture();duplicated.inbounds!.push({...duplicated.inbounds![0]});assert.throws(()=>parseXuiDetails(duplicated,xui,now));
});
test("详情区分空列表、未读取、局部失败和缺失用户列表",()=>{
 const raw=xuiFixture();raw.nodes=null;raw.nodesError="节点无权限";const value=parseXuiDetails(raw,xui,now);assert.equal(value.nodes,null);assert.equal(value.inbounds!.length,1);
 assert.throws(()=>parseXuiDetails({...raw,nodesError:null},xui,now));
 raw.nodes=[];raw.nodesError=null;raw.inbounds![0].clients=null;const partial=parseXuiDetails(raw,xui,now);assert.deepEqual(partial.nodes,[]);assert.equal(partial.inbounds![0].clients,null);
});
test("启用、到期和用尽均不当成在线，空值不当成不限",()=>{
 const row=xuiFixture().inbounds![0].clients![0];assert.equal(xuiUseState(row,now),"启用");assert.equal(xuiExpiry(row.expiryTime),"待首次使用");assert.equal(xuiExpiry(null),"未提供");assert.equal(xuiExpiry(0),"不限期");
 assert.equal(xuiUseState({...row,enabled:false},now),"停用");assert.equal(xuiUseState({...row,expiryTime:now-1},now),"已到期");assert.equal(xuiUseState({...row,downloadBytes:4096},now),"额度用尽");
 assert.equal(xuiUsed({...row,uploadBytes:null}),null);assert.equal(xuiUseState({...row,enabled:null,quotaBytes:null,expiryTime:null},now),"未确认");
});
test("同名用户在不同入站仍为独立条目，不合并流量",()=>{
 const raw=xuiFixture();raw.inbounds!.push({...raw.inbounds![0],id:2,nodeId:3,clients:[{...raw.inbounds![0].clients![0],downloadBytes:2048}]});
 const value=parseXuiDetails(raw,xui,now);assert.equal(value.inbounds!.length,2);assert.equal(value.inbounds![0].clients![0].downloadBytes,1024);assert.equal(value.inbounds![1].clients![0].downloadBytes,2048);
});
test("原管理面板保留自定义根路径，不携带令牌、不保存网站配置",async()=>{
 assert.equal(xuiPanelUrl(xui),"https://my.example/custom-base/panel/");assert.throws(()=>xuiPanelUrl({...xui,endpoint:"https://my.example?token=SECRET"}));
 assert.throws(()=>xuiPanelUrl({...xui,endpoint:"https://user:pass@my.example"}));
 const app=temporaryWebApp(xuiPanelUrl(xui),"3x-ui 管理面板");assert.equal(app.id,"source-view");assert.deepEqual(app.permissions,[]);assert.equal(app.url,xuiPanelUrl(xui));
 let calls=0;await assert.rejects(openXuiPanel(xui,()=>{calls++;},true),/模拟/);assert.equal(calls,0);
});
test("读取和凭据管理都传递预期地址，错误地址结果被拒绝",async()=>{
 const priorWindow=Object.getOwnPropertyDescriptor(globalThis,"window"),priorTauri=Object.getOwnPropertyDescriptor(globalThis,"isTauri");
 const calls:any[]=[];let wrong=false;
 try {
  Object.defineProperty(globalThis,"window",{configurable:true,value:{}});Object.defineProperty(globalThis,"isTauri",{configurable:true,value:true});
  mockIPC((command,args)=>{calls.push({command,args});if(command==="vps_service_token")return true;if(command==="read_vps_service")return {...fixture(),checkedAtUnixMs:Date.now(),endpoint:wrong?"https://other.example":c.endpoint};throw Error("unexpected IPC");});
  await readVpsService(c);await serviceToken(c,"inspect");
  assert.equal(calls.length,2);for(const call of calls){assert.equal(call.args.endpoint,c.endpoint);assert.equal(call.args.kind,c.kind);}
  wrong=true;await assert.rejects(readVpsService(c),/来源不匹配/);
 }finally{clearMocks();if(priorWindow)Object.defineProperty(globalThis,"window",priorWindow);else Reflect.deleteProperty(globalThis,"window");if(priorTauri)Object.defineProperty(globalThis,"isTauri",priorTauri);else Reflect.deleteProperty(globalThis,"isTauri");}
});
const singFixture=():SingBoxDetails=>({kind:'sing-box',endpoint:c.endpoint,version:'sing-box 1.12.0',checkedAtUnixMs:now,proxiesError:null,connectionsError:null,proxies:[{name:'GROUP',proxyType:'Selector',udp:true,members:['edge'],selected:'edge',delayMs:null,delayAtUnixMs:null},{name:'edge',proxyType:'VLESS',udp:true,members:null,selected:null,delayMs:0,delayAtUnixMs:now-60000}],connections:{uploadBytes:0,downloadBytes:1024,entries:[{destination:'example.com',port:443,network:'tcp',inbound:'mixed/in',chains:['edge','GROUP'],uploadBytes:0,downloadBytes:null,startedAtUnixMs:now-60000}]}});
test('sing-box详情保留分组、历史失败和零流量，剥除其他字段',()=>{
 const v=singFixture();Object.assign(v.proxies![1],{password:'SECRET-PASS'});Object.assign(v.connections!.entries[0],{processPath:'SECRET-PROCESS',sourceIP:'SECRET-SOURCE'});
 const d=parseSingBoxDetails(v,c,now);assert.equal(d.connections!.uploadBytes,0);assert.equal(d.connections!.entries[0].downloadBytes,null);assert.equal(singBoxDelay(d.proxies![1]),'上次测试失败');assert.equal(singBoxDelay(d.proxies![0]),'无记录');assert.equal(singBoxSelection(d.proxies![0],d.proxies!),'edge');assert.equal(JSON.stringify(d).includes('SECRET-'),false);
});
test('sing-box分组选择不能猜测，不把不存在的成员认作有效选择',()=>{
 const p=singFixture().proxies!;for(const selected of ['missing',null])assert.equal(singBoxSelection({...p[0],selected},p),'未确认');assert.equal(singBoxSelection(p[0],[p[0]]),'未确认');assert.equal(singBoxSelection({...p[0],members:[]},p),'未确认');assert.equal(singBoxDelay({...p[1],delayMs:28}),'28 ms');assert.equal(singBoxDelay({...p[1],delayAtUnixMs:null}),'无记录');
});
test('sing-box详情校验来源、重复节点、时间和计数，不接受缺失冒充空列表',()=>{
 for(const patch of [{endpoint:'https://other.example'},{kind:'3x-ui'},{checkedAtUnixMs:now+2000},{version:'mihomo 1.0'},{proxies:undefined},{proxies:null},{connections:null}])assert.throws(()=>parseSingBoxDetails({...singFixture(),...patch},c,now));
 for(const patch of [{delayMs:-1},{delayMs:1.5},{delayAtUnixMs:now+2000},{delayMs:null},{members:['edge','edge']},{name:'edge\n'}]){const d=singFixture();Object.assign(d.proxies![1],patch);assert.throws(()=>parseSingBoxDetails(d,c,now));}
 const duplicate=singFixture();duplicate.proxies!.push(duplicate.proxies![1]);assert.throws(()=>parseSingBoxDetails(duplicate,c,now));
 for(const patch of [{port:0},{port:65536},{uploadBytes:-1},{startedAtUnixMs:now+2000},{chains:['edge','edge']}]){const d=singFixture();Object.assign(d.connections!.entries[0],patch);assert.throws(()=>parseSingBoxDetails(d,c,now));}
});
test('sing-box局部失败保留独立结果；空节点和空连接是可用结果',()=>{
 const d=singFixture();d.connections=null;d.connectionsError='连接暂不可用';assert.equal(parseSingBoxDetails(d,c,now).proxies!.length,2);
 const empty=singFixture();empty.proxies=[];empty.connections!.entries=[];assert.equal(parseSingBoxDetails(empty,c,now).connections!.entries.length,0);
});
test('sing-box原面板只进入已有ui路径，不带密钥、不保存网站配置',async()=>{
 assert.equal(singBoxPanelUrl({...c,endpoint:'https://my.example/base/'}),'https://my.example/base/ui/');for(const endpoint of ['https://my.example/?secret=x','https://my.example/#token','file:///x'])assert.throws(()=>singBoxPanelUrl({...c,endpoint}));assert.throws(()=>singBoxPanelUrl(xui));
 let target='';await openSingBoxPanel(c,url=>{target=url});assert.equal(target,'https://my.example/ui/');await assert.rejects(openSingBoxPanel({...c,enabled:false},()=>{}));
});
const tsConnection:ServiceConnection={kind:'tailscale',endpoint:'my-vps',enabled:true,autoRefresh:false};
const tsDevice=(rowId=1):TailscaleDevice=>({rowId,name:'desktop',dnsName:'desktop.example.ts.net.',os:'windows',ips:['100.64.0.2'],online:true,active:true,connection:'direct',relayRegion:null,uploadBytes:0,downloadBytes:1024,lastSeenAtUnixMs:null,lastHandshakeAtUnixMs:now-30000,exitNode:false,exitNodeOption:true,tags:['tag:personal'],primaryRoutes:['192.168.1.0/24'],expired:null,keyExpiryAtUnixMs:now+86400000});
const tsFixture=():TailscaleDetails=>({kind:'tailscale',endpoint:tsConnection.endpoint,version:'1.90.0',backendState:'Running',checkedAtUnixMs:now,selfNode:{...tsDevice(0),name:'vps-self',online:false},peers:[tsDevice()],selfError:null,peersError:null,healthWarningCount:0,magicDnsEnabled:true});
test('Tailscale详情只返回展示字段，VPS自身不借用对等设备在线状态',()=>{
 const f=tsFixture();Object.assign(f,{authURL:'SECRET-LOGIN',users:'SECRET-EMAIL'});Object.assign(f.peers![0],{publicKey:'SECRET-PUBLIC',peerAPIURL:'SECRET-URL'});const d=parseTailscaleDetails(f,tsConnection,now);assert.equal(d.selfNode!.online,false);assert.equal(d.peers![0].online,true);assert.equal(d.peers![0].uploadBytes,0);assert.equal(JSON.stringify(d).includes('SECRET-'),false);
});
test('Tailscale详情严格核对别名、时间、唯一行和缺失字段',()=>{
 for(const patch of [{endpoint:'other-vps'},{kind:'sing-box'},{checkedAtUnixMs:now+2000},{peers:undefined},{peers:null},{backendState:'ready'}])assert.throws(()=>parseTailscaleDetails({...tsFixture(),...patch},tsConnection,now));
 for(const patch of [{rowId:0},{connection:'relay'},{active:false},{uploadBytes:-1},{lastHandshakeAtUnixMs:now+2000},{tags:['x','x']},{online:'yes'},{relayRegion:'fra'},{keyExpiryAtUnixMs:Infinity}]){const f=tsFixture();Object.assign(f.peers![0],patch);assert.throws(()=>parseTailscaleDetails(f,tsConnection,now));}
 const f=tsFixture();f.peers!.push(tsDevice());assert.throws(()=>parseTailscaleDetails(f,tsConnection,now));f.peers![1].rowId=2;assert.equal(parseTailscaleDetails(f,tsConnection,now).peers!.length,2);
});
test('Tailscale缺失、空列表和局部错误不同，未来到期有效',()=>{
 const f=tsFixture();f.peers=null;f.peersError='设备列表未提供';assert.equal(parseTailscaleDetails(f,tsConnection,now).selfNode!.name,'vps-self');f.selfNode=null;f.selfError='本机暂不可用';f.peers=[];f.peersError=null;assert.equal(parseTailscaleDetails(f,tsConnection,now).peers!.length,0);
 const d=tsDevice();assert.equal(tailscaleExpiry(d,now),'有效期内');assert.equal(tailscaleExpiry({...d,keyExpiryAtUnixMs:now-1},now),'已到期');assert.equal(tailscaleExpiry({...d,keyExpiryAtUnixMs:null},now),'未提供');assert.equal(tailscaleExpiry({...d,expired:true},now),'已过期');
});
test('Tailscale路径不凭在线或静止DERP记录推断连通，不伪造零延迟',()=>{
 const d=tsDevice();assert.equal(tailscalePath(d),'直连');assert.equal(tailscalePath({...d,connection:'derp',relayRegion:'fra'}),'DERP 中继 · fra');assert.equal(tailscalePath({...d,connection:'peer-relay'}),'设备中继');assert.equal(tailscalePath({...d,active:false,connection:'unknown'}),'无近期活动');assert.equal(tailscalePath({...d,active:null,connection:'unknown'}),'未确认');assert.equal(tailscalePath({...d,connection:'unknown'}),'路径未确认');assert.equal(tailscaleBackend('NeedsLogin'),'需要登录');assert.equal(tailscaleBackend('future'),'状态未确认');
});
