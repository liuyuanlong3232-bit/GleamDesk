import { useEffect, useRef, useState } from "react";
import {listen} from "@tauri-apps/api/event";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { loadWebApps, saveWebApps, applyWebAppMetadata, subscribeWebApps,temporaryWebApp, type WebApp, type WebAppMetadata } from "../services/webAppStore";
import { isWindowVisible, subscribeWindowVisibility } from "../services/windowVisibility";
import { NewsWorkspace } from "./NewsWorkspace";
import { MailWorkspace } from "./MailWorkspace";
import { AgricultureWorkspace } from "./AgricultureWorkspace";
import { MarketWorkspace } from "./MarketWorkspace";
import { AgentRoom } from "./AgentRoom";
import { WidgetErrorBoundary } from "../widgets/WidgetCard";
const nativeModules=[{id:"market",name:"市场中心"},{id:"agriculture",name:"农业中心"},{id:"news",name:"新闻中心"},{id:"mail",name:"邮箱中心"},{id:"agents",name:"Agent Room"},{id:"webapps",name:"自定义网站"}];
let webviewQueue:Promise<unknown>=Promise.resolve();
function webviewCommand<T=void>(command:string,args?:Record<string,unknown>):Promise<T>{const next=webviewQueue.catch(()=>{}).then(()=>invoke<T>(command,args));webviewQueue=next;return next;}
export function Workspace({visible,covered=false,simulationEnabled=false,onManageWebApps,openAppRequest,openUrlRequest,navigationHidden=false,onSelectionChange}:{navigationHidden?:boolean;onSelectionChange?:(id:string)=>void;visible:boolean;covered?:boolean;simulationEnabled?:boolean;onManageWebApps:()=>void;openAppRequest?:{id:string;nonce:number};openUrlRequest?:{url:string;name:string;nonce:number}}) {
  const content=useRef<HTMLDivElement>(null);
  const [windowVisible,setWindowVisible]=useState(isWindowVisible);
  useEffect(()=>subscribeWindowVisibility(()=>setWindowVisible(isWindowVisible())),[]);
  const [apps,setApps]=useState(loadWebApps),[selected,setSelected]=useState(()=>{if(openUrlRequest)return "source-view";try{return sessionStorage.getItem("codex-desktop.workspace-selection")||"mues";}catch{return "mues";}}),[error,setError]=useState("");
  useEffect(()=>{try{if(selected!=="source-view")sessionStorage.setItem("codex-desktop.workspace-selection",selected);}catch{}},[selected]);
  useEffect(()=>{onSelectionChange?.(selected);},[selected,onSelectionChange]);
  useEffect(()=>{
    if(!content.current?.animate||document.documentElement.classList.contains("reduce-motion")||window.matchMedia("(prefers-reduced-motion: reduce)").matches)return;
    const animation=content.current.animate([{opacity:0},{opacity:1}],{duration:320,easing:"cubic-bezier(.2,.8,.2,1)"});
    return()=>animation.cancel();
  },[selected]);
  const [agentIncoming,setAgentIncoming]=useState<{id:number;topic:string}>(),[sourceApp,setSourceApp]=useState<WebApp|undefined>(()=>openUrlRequest?temporaryWebApp(openUrlRequest.url,openUrlRequest.name):undefined);
  useEffect(()=>{if(!openUrlRequest)return;try{setSourceApp(temporaryWebApp(openUrlRequest.url,openUrlRequest.name));setSelected("source-view");}catch(e){setError(e instanceof Error?e.message:"来源网页无法打开");}},[openUrlRequest]);
  useEffect(()=>subscribeWebApps(()=>setApps(loadWebApps())),[]);
  useEffect(()=>{if(openAppRequest&&(apps.some(app=>app.id===openAppRequest.id)||nativeModules.some(module=>module.id===openAppRequest.id)))setSelected(openAppRequest.id);},[openAppRequest]);
  useEffect(()=>{if(!apps.some(app=>app.id===selected)&&sourceApp?.id!==selected&&!nativeModules.some(module=>module.id===selected))setSelected("webapps");},[apps,selected,sourceApp]);
  const app=sourceApp?.id===selected?sourceApp:apps.find(app=>app.id===selected);
  useEffect(()=>{
    const open=(event:Event)=>{const topic=(event as CustomEvent<{topic?:string}>).detail?.topic;if(typeof topic!=="string"||!topic.trim())return;setAgentIncoming({id:Date.now(),topic:topic.slice(0,12000)});setSelected("agents");};
    window.addEventListener("codex-desktop.open-agent-room",open);return()=>window.removeEventListener("codex-desktop.open-agent-room",open);
  },[]);
  useEffect(()=>{
    const open=(event:Event)=>{try{const {url,name}=(event as CustomEvent<{url:string;name:string}>).detail;const existing=apps.find(app=>app.url===url);if(existing){setSelected(existing.id);return;}setSourceApp(temporaryWebApp(url,name));setSelected("source-view");}catch(e){setError(e instanceof Error?e.message:"来源网页无法打开");}};
    window.addEventListener("codex-desktop.open-workspace-url",open);return()=>window.removeEventListener("codex-desktop.open-workspace-url",open);
  },[apps]);
  return <section className={`workspace-layout${navigationHidden?" workbench-native-layout":""}`} data-no-page-swipe>{!navigationHidden&&<nav className="workspace-navigation glass" aria-label="工作区模块">{apps.filter(item=>item.id==="mues"&&item.surface!=="toolbox").map(item=><button key={item.id} aria-current={selected===item.id?"page":undefined} onClick={()=>setSelected(item.id)}><span>{item.icon?<img className="webapp-icon" src={item.icon} alt=""/>:"◉"}</span> {item.name}</button>)}{nativeModules.map(item=><button key={item.id} aria-current={selected===item.id?"page":undefined} onClick={()=>setSelected(item.id)}><span className="workspace-nav-icon">{{market:"▥",agriculture:"♧",news:"▤",mail:"✉",agents:"♧",webapps:"▦"}[item.id as "market"]}</span>{item.name}</button>)}<button onClick={onManageWebApps}>＋ 管理网站</button></nav>}
    <div ref={content} className="workspace-content glass">{selected==="agents"?<NativeWorkspaceModule id={selected} visible={visible&&windowVisible} simulationEnabled={simulationEnabled} agentIncoming={agentIncoming}/>:<WidgetErrorBoundary key={selected} widgetId={selected} recoverable>{app?<NativeWebApp app={app} visible={visible&&windowVisible} covered={covered}/>:selected==="webapps"?<section className="custom-webapps-panel"><header><h2>自定义网站</h2><button onClick={onManageWebApps}>管理网站</button></header><div>{apps.filter(item=>item.surface!=="toolbox"&&item.id!=="mues").map(item=><button key={item.id} onClick={()=>setSelected(item.id)}><strong>{item.icon&&<img className="webapp-icon" src={item.icon} alt=""/>}{item.name}</strong><small>{item.category} · {new URL(item.url).hostname}</small></button>)}<button onClick={onManageWebApps}>＋ 添加网站</button></div>{error&&<p role="alert">{error}</p>}</section>:<NativeWorkspaceModule id={selected} visible={visible&&windowVisible} simulationEnabled={simulationEnabled} agentIncoming={agentIncoming}/>}</WidgetErrorBoundary>}</div></section>;
}

function NativeWebApp({app,visible,covered}:{app:WebApp;visible:boolean;covered:boolean}) {
  useEffect(()=>{
    if(!isTauri()||!visible)return;
    void webviewCommand("webapp_set_covered",{covered}).catch(()=>setError("网页显示状态暂时无法调整"));
  },[covered,visible,app.id,app.url]);
  const frame=useRef<HTMLDivElement>(null),addressInput=useRef<HTMLInputElement>(null),latestAddress=useRef(app.url),editingAddress=useRef(false),[status,setStatus]=useState("准备网页视图"),[error,setError]=useState(""),[address,setAddress]=useState(app.url),[revision,setRevision]=useState(0),[title,setTitle]=useState(app.pageTitle??"");
  useEffect(()=>{latestAddress.current=app.url;editingAddress.current=false;setAddress(app.url);setTitle(app.pageTitle??"");},[app.id,app.url]);
  useEffect(()=>{
    let alive=true,pending=false,again=false;const node=frame.current;
    if(!isTauri()){setStatus("原生网页需要桌面程序");return;}
    if(!node||!visible)return;
    const mount=async()=>{if(pending){again=true;return;}pending=true;
      try{const rect=node.getBoundingClientRect();if(rect.width<100||rect.height<100)return;const receipt=await webviewCommand<{state:string;url:string}>("webapp_mount",{request:{id:app.id,url:app.url,x:rect.x,y:rect.y,width:rect.width,height:rect.height}});if(alive){latestAddress.current=receipt.url;if(!editingAddress.current)setAddress(receipt.url);setStatus(receipt.state==="restored"?"已恢复原页面":receipt.state==="active"?"已创建原生网页视图":"网页状态未知");setError("");}}
      catch(e){if(alive){setStatus("网页不可用");setError(String(e));}}
      finally{pending=false;if(again&&alive){again=false;void mount();}}
    };
    let stopMetadata:(()=>void)|undefined,stopAddress:(()=>void)|undefined;let settleTimer:ReturnType<typeof setTimeout>|undefined;
    const schedule=()=>{if(settleTimer)clearTimeout(settleTimer);settleTimer=setTimeout(()=>{if(alive)void mount();},350);};
    const observer=new ResizeObserver(schedule);window.addEventListener("resize",schedule);
    void(async()=>{
      try{stopMetadata=await listen<WebAppMetadata>("webapp-metadata",event=>{
        if(!alive||event.payload.id!==app.id||event.payload.registeredUrl!==app.url)return;
        if(event.payload.title)setTitle(event.payload.title);
        try{const current=loadWebApps(),next=applyWebAppMetadata(current,event.payload);if(JSON.stringify(current)!==JSON.stringify(next))saveWebApps(next);}catch{setError("网站元数据无法保存，当前网页仍可使用");}
      });}catch{if(alive)setError("网站标题与图标读取不可用");}
      try{stopAddress=await listen<{id:string;registeredUrl:string;url:string}>("webapp-url-changed",event=>{
        if(!alive||event.payload.id!==app.id||event.payload.registeredUrl!==app.url)return;
        latestAddress.current=event.payload.url;if(!editingAddress.current)setAddress(event.payload.url);
      });}catch{if(alive)setError("网页地址同步不可用");}
      if(!alive){stopMetadata?.();stopAddress?.();return;}schedule();observer.observe(node);
    })();
    return()=>{alive=false;if(settleTimer)clearTimeout(settleTimer);window.removeEventListener("resize",schedule);observer.disconnect();stopMetadata?.();stopAddress?.();void webviewCommand("webapp_release",{id:app.id}).catch(()=>{});};
  },[app.id,app.url,visible,revision]);
  return <section className="native-webapp"><header><strong title={title||app.name}>{app.icon&&<img className="webapp-icon" src={app.icon} alt=""/>}{title||app.pageTitle||app.name}</strong><input ref={addressInput} aria-label="网页地址" value={address} onFocus={()=>{editingAddress.current=true;}} onBlur={()=>{editingAddress.current=false;setAddress(latestAddress.current);}} onChange={e=>setAddress(e.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&isTauri())void invoke("webapp_navigate",{id:app.id,url:address}).catch(e=>setError(String(e)));}}/><button onClick={()=>{void webviewCommand("webapp_discard",{id:app.id}).then(()=>setRevision(value=>value+1)).catch(e=>setError(String(e)));}}>重建</button></header><div className="webapp-frame" ref={frame}><p>{covered?"网页暂时让出操作区域；关闭菜单或提醒后恢复原页面。":status}</p>{error&&<p role="alert">{error}</p>}</div><footer>{status} · 保留最近两个网站 · 独立登录配置 · 无本机权限</footer></section>;
}
function NativeWorkspaceModule({id,visible,simulationEnabled,agentIncoming}:{id:string;visible:boolean;simulationEnabled:boolean;agentIncoming?:{id:number;topic:string}}) {
  if(id==="agents")return <AgentRoom incoming={agentIncoming} visible={visible} simulationEnabled={simulationEnabled}/>;
  if(id==="market")return <MarketWorkspace visible={visible&&!simulationEnabled}/>;
  if(id==="mail")return <MailWorkspace visible={visible&&!simulationEnabled}/>;
  if(id==="agriculture")return <AgricultureWorkspace visible={visible&&!simulationEnabled}/>;
  if(id==="news")return <NewsWorkspace visible={visible&&!simulationEnabled}/>;
  const name=nativeModules.find(item=>item.id===id)?.name??"自定义工作区";
  return <section className="native-workspace-module"><h2>{name}</h2><p>此模块正在接入，当前没有连接数据源。</p></section>;
}
