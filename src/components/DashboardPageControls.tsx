import {CloseIcon} from "./CloseIcon";
import { useEffect,useRef,useState } from "react";
import { addDashboardPage, deleteDashboardPage, hideDashboardPage, renameDashboardPage, type DashboardPages } from "../domain/dashboard/pages";
import type { WorkbenchNavItem } from "./DashboardAvatarMenu";
import type {ApplicationItem} from "../types";
import {toolboxPresets,type WebApp} from "../services/webAppStore";
import {nativeTools,networkTools} from "../services/toolboxTools";

export function dashboardNavigationItems(document:DashboardPages,workspaceSelection:string,resourceView:"pc"|"vps"="pc"):WorkbenchNavItem[] {
  const page=document.pages.find(item=>item.id===document.activePageId&&!item.hidden)??document.pages.find(item=>!item.hidden);
  return [
    {id:"overview",label:"工作台总览",icon:"home",active:page?.id==="overview"},
    {id:"resources",label:"本机资源",icon:"resources",active:page?.id==="resources"&&resourceView==="pc"},
    {id:"vps",label:"VPS 控制台",icon:"server",active:page?.id==="resources"&&resourceView==="vps"},
    ...[{id:"news",label:"新闻中心",icon:"news"},{id:"market",label:"市场中心",icon:"market"},{id:"agriculture",label:"农业中心",icon:"agriculture"},{id:"mail",label:"邮箱中心",icon:"mail"},{id:"agents",label:"Agent Room",icon:"agents"},{id:"mues",label:"Muse / 网页工作区",icon:"web"},{id:"webapps",label:"自定义网站",icon:"custom"}].map(item=>({...item,active:page?.kind==="workspace"&&(item.id===workspaceSelection||item.id==="mues"&&!["news","market","agriculture","mail","agents","webapps"].includes(workspaceSelection))})),
    {id:"toolbox",label:"工具箱",icon:"toolbox",active:page?.id==="toolbox"},
    ...document.pages.filter(item=>item.kind==="custom"&&!item.hidden).map(item=>({id:item.id,label:item.name,icon:"custom",active:page?.id===item.id})),
  ].filter(item=>{const target=document.pages.find(page=>page.id===(item.id==="vps"?"resources":item.id));return target?!target.hidden:document.pages.some(page=>page.kind==="workspace"&&!page.hidden);});
}

export interface WorkbenchSearchItem {
  key:string;label:string;description:string;keywords:string;actionLabel:string;
  target:{kind:"page"|"tool"|"application"|"webapp"|"preset";id:string};
}
const searchAliases:Record<string,string>={overview:"首页 总览 系统健康",resources:"本机 电脑 CPU 内存 磁盘 资源",vps:"服务器 云主机",news:"新闻 资讯",market:"行情 股票 期货",agriculture:"农业 农产品",mail:"邮箱 邮件",agents:"聊天室 群聊 模型 AI",mues:"Muse 网页 工作区",webapps:"网站 网页",toolbox:"工具 开发 网络"};
export function buildWorkbenchSearchItems(document:DashboardPages,applications:ApplicationItem[],webApps:WebApp[]):WorkbenchSearchItem[] {
  const navigation=dashboardNavigationItems(document,"", "pc");
  const entries:WorkbenchSearchItem[]=navigation.map(item=>({key:`page:${item.id}`,label:item.label,description:"工作台页面",keywords:`${item.id} ${searchAliases[item.id]??""}`,actionLabel:"打开",target:{kind:"page",id:item.id}}));
  if(navigation.some(item=>item.id==="toolbox")){
    for(const [id,label,description] of nativeTools)entries.push({key:`tool:${id}`,label,description,keywords:`开发工具 ${id}`,actionLabel:"打开",target:{kind:"tool",id}});
    for(const [id,label] of [...networkTools,["dns-api","DNS 传播检测"]])entries.push({key:`tool:${id}`,label,description:"网络工具",keywords:id,actionLabel:"打开",target:{kind:"tool",id}});
  }
  if(document.pages.some(page=>page.kind==="workspace"&&!page.hidden)){
    for(const app of webApps){
      const preset=toolboxPresets.find(item=>item.url===app.url);
      let host="";try{host=new URL(app.url).hostname;}catch{/* Never index addresses or query parameters. */}
      if(app.id==="mues"){
        const page=entries.find(item=>item.key==="page:mues");
        if(page){page.label=`${app.name} / 网页工作区`;page.keywords+=` ${app.name} ${host} ${app.pageTitle??""}`;continue;}
      }
      entries.push({key:`webapp:${app.id}`,label:app.name,description:`${app.category} · ${host}`,keywords:`${app.pageTitle??""} ${preset?.name??""} ${preset?.description??""}`,actionLabel:"打开",target:{kind:"webapp",id:app.id}});
    }
    if(navigation.some(item=>item.id==="toolbox"))for(const preset of toolboxPresets){
      if(webApps.some(app=>app.url===preset.url))continue;
      entries.push({key:`preset:${preset.id}`,label:preset.name,description:preset.description,keywords:preset.category,actionLabel:"打开",target:{kind:"preset",id:preset.id}});
    }
  }
  for(const app of applications)entries.push({key:`application:${app.id}`,label:app.name,description:app.target.trim()?(app.category||"本机应用"):"未配置路径 · 前往应用管理",keywords:app.category??"",actionLabel:app.target.trim()?"打开":"配置",target:{kind:"application",id:app.id}});
  return entries;
}
const searchText=(value:string)=>value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g," ").trim();
export function filterWorkbenchSearch(items:WorkbenchSearchItem[],query:string):WorkbenchSearchItem[]{
  const text=searchText(query);if(!text)return items.filter(item=>item.target.kind==="page").slice(0,8);
  const tokens=text.split(" ");
  const rank=(item:WorkbenchSearchItem)=>{const name=searchText(item.label);return name===text?0:name.startsWith(text)?1:name.includes(text)?2:3;};
  return items.filter(item=>{const haystack=searchText(`${item.label} ${item.description} ${item.keywords}`);return tokens.every(token=>haystack.includes(token));}).sort((a,b)=>rank(a)-rank(b));
}

export function WorkbenchSearch({items,onSelect,onClose}:{items:WorkbenchSearchItem[];onSelect:(item:WorkbenchSearchItem)=>void;onClose:()=>void}){
  const [query,setQuery]=useState(""),[selected,setSelected]=useState(0);
  const results=filterWorkbenchSearch(items,query),active=Math.max(0,Math.min(selected,results.length-1));
  const list=useRef<HTMLDivElement>(null);
  const dialog=useRef<HTMLElement>(null);
  const input=useRef<HTMLInputElement>(null);
  const restoreFocus=useRef(true);
  useEffect(()=>{list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({block:"nearest"});},[query,active]);
  useEffect(()=>()=>{if(restoreFocus.current)requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>('.workbench-rail [aria-label="搜索"]')?.focus());},[]);
  const choose=(item:WorkbenchSearchItem)=>{restoreFocus.current=false;onSelect(item);onClose();};
  return <div className="workbench-search-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}} onKeyDown={event=>{
    if(event.key==="Escape"){event.preventDefault();event.stopPropagation();onClose();}
    if(event.key==="Tab"){
      const focusable=dialog.current?.querySelectorAll<HTMLElement>('input,button:not(:disabled)');
      if(focusable?.length){const first=focusable[0],last=focusable[focusable.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
    }
  }}>
    <section ref={dialog} className="dashboard-search workbench-search glass" role="dialog" aria-modal="true" aria-label="全局搜索" data-no-page-swipe>
      <header><span aria-hidden="true">⌕</span><input ref={input} autoFocus role="combobox" aria-label="搜索页面、工具或应用" aria-expanded="true" aria-controls="workbench-search-results" aria-autocomplete="list" aria-activedescendant={results.length?`workbench-search-result-${active}`:undefined} placeholder="搜索页面、工具或应用…" value={query} onChange={event=>{setQuery(event.target.value);setSelected(0);}} onKeyDown={event=>{
        if(event.nativeEvent.isComposing)return;
        if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();if(results.length)setSelected((active+(event.key==="ArrowDown"?1:-1)+results.length)%results.length);}
        if(event.key==="Enter"&&results[active]){event.preventDefault();choose(results[active]);}
      }}/>{query&&<button className="ui-icon-button" type="button" aria-label="清空搜索" onClick={()=>{setQuery("");setSelected(0);input.current?.focus();}}><CloseIcon/></button>}<button type="button" aria-label="关闭搜索" onClick={onClose}>Esc</button></header>
      <p className="workbench-search-status" role="status">{query.trim()?`${results.length} 个结果`:"常用入口"}</p>
      <div ref={list} id="workbench-search-results" className="workbench-search-results" role="listbox" aria-label="搜索结果">{results.map((item,index)=><button type="button" role="option" aria-selected={index===active} id={`workbench-search-result-${index}`} key={item.key} onFocus={()=>setSelected(index)} onClick={()=>choose(item)}><span className="workbench-search-kind">{{page:"页面",tool:"工具",application:"应用",webapp:"网站",preset:"网站"}[item.target.kind]}</span><span className="workbench-search-label"><strong>{item.label}</strong><small>{item.description}</small></span><span className="workbench-search-action">{item.actionLabel} ↗</span></button>)}</div>
      {!results.length&&<p className="workbench-search-empty">没有找到匹配的入口</p>}
      <footer>↑ ↓ 选择 · Enter 打开 · Esc 关闭</footer>
    </section>
  </div>;
}

export function DashboardPageControls({document,items,onSelect,onChange}:{document:DashboardPages;items:WorkbenchNavItem[];onSelect:(id:string)=>void;onChange:(next:DashboardPages)=>void}) {
  const [message,setMessage]=useState("");
  const perform=(action:()=>DashboardPages)=>{try{onChange(action());setMessage("");}catch(error){setMessage(error instanceof Error?error.message:"页面操作失败");}};
  return <div className="dashboard-page-controls">
    <nav className="page-tabs" aria-label="工作台页面">{items.map(item=><button key={item.id} aria-current={item.active?"page":undefined} onClick={()=>onSelect(item.id)}>{item.label}</button>)}</nav>
    <p className="page-manager-description">内置页面使用当前工作台布局；添加、拖动和调整组件只用于自定义组件页。</p>
    <details className="page-editor glass"><summary>管理页面与导航分组</summary><button onClick={()=>{const name=window.prompt("新组件页名称");if(name)perform(()=>addDashboardPage(document,name));}}>＋ 新建组件页</button>{document.pages.map(page=><div key={page.id}><span>{page.kind==="workspace"?"业务与网页分组":page.name}{page.system?" · 内置":" · 组件页"}</span>{!page.system&&<button onClick={()=>{const name=window.prompt("页面名称",page.name);if(name)perform(()=>renameDashboardPage(document,page.id,name));}}>重命名</button>}<button onClick={()=>perform(()=>hideDashboardPage(document,page.id,!page.hidden))}>{page.hidden?"显示":"隐藏"}</button>{!page.system&&<button onClick={()=>{if(window.confirm(`删除页面“${page.name}”及其布局？历史数据会保留。`))perform(()=>deleteDashboardPage(document,page.id));}}>删除</button>}</div>)}</details>
    {message&&<span role="status">{message}</span>}
  </div>;
}
