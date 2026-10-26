import {CloseIcon} from "./CloseIcon";
import {useEffect,useRef,type ReactNode} from "react";
import {RoomPortrait} from "./RoomPortrait";

export function DashboardAvatarMenu({open,blocked,onOpenChange,children}:{open:boolean;blocked:boolean;onOpenChange:(open:boolean)=>void;children:ReactNode}) {
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const openTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),closeTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const latest=useRef({open,blocked,onOpenChange});latest.current={open,blocked,onOpenChange};
  const clearTimers=()=>{clearTimeout(openTimer.current);clearTimeout(closeTimer.current);};
  const close=()=>{clearTimers();latest.current.onOpenChange(false);};
  useEffect(()=>{if(blocked)close();},[blocked]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if(event.altKey&&event.key.toLowerCase()==="q"&&!latest.current.blocked){event.preventDefault();clearTimers();latest.current.onOpenChange(!latest.current.open);if(!latest.current.open)trigger.current?.focus();}
      if(event.key==="Escape"&&latest.current.open){event.preventDefault();close();trigger.current?.focus();}
    };
    const outside=(event:PointerEvent)=>{if(latest.current.open&&event.target instanceof Node&&!root.current?.contains(event.target))close();};
    const blur=()=>close();
    window.addEventListener("keydown",key);document.addEventListener("pointerdown",outside);window.addEventListener("blur",blur);
    return()=>{clearTimers();window.removeEventListener("keydown",key);document.removeEventListener("pointerdown",outside);window.removeEventListener("blur",blur);};
  },[]);
  return <div className="dashboard-avatar-menu" ref={root} onMouseEnter={()=>{
    clearTimers();if(!blocked)openTimer.current=setTimeout(()=>latest.current.onOpenChange(true),300);
  }} onMouseLeave={()=>{clearTimers();closeTimer.current=setTimeout(()=>{if(!root.current?.contains(document.activeElement))close();},400);}}
  onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))close();}}>
    <button ref={trigger} className="dashboard-avatar-trigger" type="button" disabled={blocked} aria-label="控制台导航与设置" aria-expanded={open&&!blocked} aria-controls="dashboard-avatar-panel" title="悬停展开导航与设置 · Alt+Q" onClick={()=>{clearTimers();onOpenChange(true);}}>
      <RoomPortrait id="你"/>
    </button>
    {open&&!blocked&&<section className="dashboard-avatar-panel glass" id="dashboard-avatar-panel" aria-label="控制台导航与设置面板" onMouseEnter={()=>clearTimers()}>
      <div className="avatar-panel-heading"><strong>控制台</strong><button className="ui-icon-button" type="button" aria-label="收起控制台菜单" onClick={close}><CloseIcon/></button></div>
      {children}
    </section>}
  </div>;
}


export interface WorkbenchNavItem {id:string;label:string;icon:string;active:boolean}
export function WorkbenchRail({items,blocked,onSelect,onSettings,onSearch,onAdd,onAvatar}:{items:WorkbenchNavItem[];blocked:boolean;onSelect:(id:string)=>void;onSettings:()=>void;onSearch:()=>void;onAdd:()=>void;onAvatar?:()=>void}) {
  return <nav className="workbench-rail" aria-label="工作台主导航" data-no-page-swipe>
    <button type="button" className="workbench-rail-avatar-space" aria-label="更换我的头像" title="更换我的头像" disabled={blocked} onClick={onAvatar}><RoomPortrait id="你"/></button>
    <div className="workbench-rail-pages">{items.map(item=><button key={item.id} type="button" className="workbench-nav-button" aria-label={item.label} title={item.label} data-tooltip={item.label} aria-current={item.active?"page":undefined} disabled={blocked} onClick={()=>onSelect(item.id)}><WorkbenchIcon kind={item.icon}/></button>)}</div>
    <div className="workbench-rail-actions"><button type="button" className="workbench-nav-button" aria-label="搜索" title="搜索" data-tooltip="搜索" onClick={onSearch} disabled={blocked}><WorkbenchIcon kind="search"/></button><button type="button" className="workbench-nav-button" aria-label="设置中心" title="设置中心" data-tooltip="设置中心" onClick={onSettings} disabled={blocked}><WorkbenchIcon kind="settings"/></button><button type="button" className="workbench-nav-button workbench-add" aria-label="页面与布局" title="页面与布局" data-tooltip="页面与布局" onClick={onAdd} disabled={blocked}><WorkbenchIcon kind="add"/></button></div>
  </nav>;
}
function WorkbenchIcon({kind}:{kind:string}) {
 const paths:Record<string,string>={home:"M3 11 12 3l9 8M5 10v10h5v-6h4v6h5V10",resources:"M4 5h16v12H4zM8 21h8M12 17v4",server:"M4 3h16v8H4zM4 13h16v8H4zM7 7h.01M7 17h.01M11 7h6M11 17h6",news:"M4 4h16v16H4zM8 8h8M8 12h8M8 16h5",market:"M4 19V5M4 19h16M7 14l4-4 4 3 5-7",agriculture:"M12 21V10M12 15C3 15 4 5 4 5c8 0 8 10 8 10ZM12 11s0-8 8-8c0 8-8 8-8 8Z",mail:"M3 6h18v12H3zM3 6l9 7 9-7",agents:"M5 6h14v11H9l-4 4zM9 10h6M9 13h4",web:"M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c-5 5-5 13 0 18M12 3c5 5 5 13 0 18",toolbox:"M4 8h16v12H4zM8 8V4h8v4M4 13h16M10 12v3h4v-3",search:"M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM15 15l6 6",settings:"M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",add:"M12 5v14M5 12h14",custom:"M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"};
 return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={paths[kind]??paths.custom}/></svg>;
}


export function DashboardPageManager({onClose,children}:{onClose:()=>void;children:ReactNode}) {
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const node=dialog.current!;const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;node.showModal();return()=>{node.close();if(previous?.isConnected)previous.focus();};},[]);
 return <dialog ref={dialog} className="workbench-page-manager glass" aria-modal="true" aria-labelledby="workbench-page-manager-title" data-no-page-swipe onCancel={event=>{event.preventDefault();onClose();}}><header><h2 id="workbench-page-manager-title">页面与布局</h2><button className="ui-icon-button" autoFocus aria-label="关闭页面管理" onClick={onClose}><CloseIcon/></button></header>{children}</dialog>;
}
