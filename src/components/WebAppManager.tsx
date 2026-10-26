import {useEffect,useRef,useState} from "react";
import {isTauri} from "@tauri-apps/api/core";
import {getCurrentWebview} from "@tauri-apps/api/webview";
import {addWebApp,loadWebApps,moveWebApp,removeWebApp,saveWebApps,subscribeWebApps,updateWebApp,webAppDropUrl,type WebApp,type WebAppSurface} from "../services/webAppStore";
const toolCategories=["网络工具","安全工具","开发工具","系统工具","AI工具","自定义网站"];
const blank={name:"",url:"",category:"工作",surface:"workspace" as WebAppSurface};
export function WebAppManager(){
  const [apps,setApps]=useState(loadWebApps),[draft,setDraft]=useState(blank),[editing,setEditing]=useState<string|null>(null),[message,setMessage]=useState("");
  const root=useRef<HTMLElement>(null),dirty=useRef(false);
  useEffect(()=>subscribeWebApps(()=>setApps(loadWebApps())),[]);
  const apply=(next:WebApp[])=>{saveWebApps(next);setApps(next);};
  const acceptUrl=(value:string)=>{try{if(dirty.current)throw new Error("请先保存或取消当前编辑，再拖入新网址");const url=webAppDropUrl(value);setEditing(null);setDraft({...blank,url,name:new URL(url).hostname});dirty.current=true;setMessage("网址已填入，选择名称、分类和显示位置后保存。");}catch(error){setMessage(error instanceof Error?error.message:"无法读取网址");}};
  const dropHandler=useRef(acceptUrl);dropHandler.current=acceptUrl;
  useEffect(()=>{
    if(!isTauri())return;let active=true,stop:(()=>void)|undefined;
    void getCurrentWebview().onDragDropEvent(event=>{if(!active||event.payload.type!=="drop")return;const rect=root.current?.getBoundingClientRect(),x=event.payload.position.x/window.devicePixelRatio,y=event.payload.position.y/window.devicePixelRatio;if(!rect||x<rect.left||x>rect.right||y<rect.top||y>rect.bottom)return;
      if(event.payload.paths.length!==1||!/^https?:\/\//i.test(event.payload.paths[0])){setMessage("这里只接收一个网页网址；应用文件请放到 Dock。");return;}dropHandler.current(event.payload.paths[0]);
    }).then(unlisten=>{if(active)stop=unlisten;else unlisten();}).catch(()=>{if(active)setMessage("原生网址拖入不可用，请粘贴网址。");});return()=>{active=false;stop?.();};
  },[]);
  const reset=()=>{setEditing(null);setDraft(blank);dirty.current=false;};
  const act=(operation:()=>WebApp[])=>{try{apply(operation());setMessage("网站配置已保存");return true;}catch(error){setMessage(error instanceof Error?error.message:"配置保存失败");return false;}};
  return <section className="webapp-manager" ref={root} data-no-page-swipe onDragOver={event=>{if(event.dataTransfer.types.includes("text/uri-list")||event.dataTransfer.types.includes("text/plain")){event.preventDefault();event.dataTransfer.dropEffect="copy";}}} onDrop={event=>{event.preventDefault();acceptUrl(event.dataTransfer.getData("text/uri-list")||event.dataTransfer.getData("text/plain"));}}>
    <form className="webapp-manager-form" onSubmit={event=>{event.preventDefault();try{apply(editing?updateWebApp(loadWebApps(),editing,draft):addWebApp(loadWebApps(),draft.name,draft.url,draft.category,draft.surface,draft.name===new URL(draft.url).hostname));reset();setMessage("网站配置已保存");}catch(error){setMessage(error instanceof Error?error.message:"配置保存失败");}}}>
      <strong>{editing?"修改网站入口":"添加网站入口"}</strong>
      <label>名称<input required maxLength={60} value={draft.name} onChange={event=>{dirty.current=true;setDraft({...draft,name:event.target.value});}}/></label>
      <label>网址<input required type="url" maxLength={4096} placeholder="https://" value={draft.url} onChange={event=>{dirty.current=true;setDraft({...draft,url:event.target.value});}}/></label>
      <div className="webapp-manager-fields"><label>显示位置<select value={draft.surface} onChange={event=>{dirty.current=true;const surface=event.target.value as WebAppSurface;setDraft({...draft,surface,category:surface==="toolbox"?"自定义网站":"工作"});}}><option value="workspace">工作区</option><option value="toolbox">工具箱</option></select></label><label>分类<input list="webapp-categories" maxLength={40} value={draft.category} onChange={event=>{dirty.current=true;setDraft({...draft,category:event.target.value});}}/><datalist id="webapp-categories">{(draft.surface==="toolbox"?toolCategories:["工作","市场","农业","新闻","AI","自定义"]).map(item=><option key={item} value={item}/>)}</datalist></label></div>
      <div className="settings-actions"><button type="submit">{editing?"保存修改":"添加网站"}</button><button type="button" onClick={reset}>取消编辑</button></div>
      <small>可以拖入网址。网页登录使用独立配置，网站入口没有本机命令权限。删除入口会保留浏览器登录配置。</small>
    </form>
    <div className="webapp-manager-list">{apps.map((app,index)=><article key={app.id}><div><strong>{app.icon&&<img className="webapp-icon" src={app.icon} alt=""/>}{app.name}</strong>{app.pageTitle&&app.pageTitle!==app.name&&<small>{app.pageTitle}</small>}<small>{app.surface==="toolbox"?"工具箱":"工作区"} · {app.category}</small><span>{app.url}</span></div><div className="webapp-manager-actions"><button type="button" aria-label={`上移 ${app.name}`} disabled={index===0} onClick={()=>act(()=>moveWebApp(loadWebApps(),app.id,-1))}>↑</button><button type="button" aria-label={`下移 ${app.name}`} disabled={index===apps.length-1} onClick={()=>act(()=>moveWebApp(loadWebApps(),app.id,1))}>↓</button><button type="button" onClick={()=>{if(dirty.current&&!window.confirm("放弃当前未保存的入口编辑？"))return;setEditing(app.id);setDraft({name:app.name,url:app.url,category:app.category,surface:app.surface??"workspace"});dirty.current=false;}}>修改</button><button type="button" onClick={()=>{if(!window.confirm(`删除网站入口“${app.name}”？浏览器登录配置会保留。`))return;const saved=act(()=>removeWebApp(loadWebApps(),app.id));if(saved&&editing===app.id)reset();}}>删除</button></div></article>)}</div>
    {apps.length===0&&<p>尚未添加网站。</p>}{message&&<p role="status">{message}</p>}
  </section>;
}
