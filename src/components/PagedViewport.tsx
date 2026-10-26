import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

const interactive="button,input,textarea,select,a,[contenteditable=true],[role=slider],.widget-card,.settings-dialog";
const widgetDragInteractive="button,input,textarea,select,a,[contenteditable=true],[role=slider]";
const contentSurface="[data-no-page-swipe],.workspace-layout";
export function canStartPageSwipe(target:Pick<Element,"closest">,editing:boolean,pointerType:string):boolean {
  return pointerType==="touch"&&!editing&&!target.closest(`${interactive},${contentSurface}`);
}
export function pageSwipeDirection(start:{x:number;y:number;id:number},end:{x:number;y:number;id:number}):number {
  if(start.id!==end.id)return 0;
  const x=end.x-start.x,y=end.y-start.y;
  return Math.abs(x)>110&&Math.abs(x)>Math.abs(y)*1.8?(x<0?1:-1):0;
}
export interface WidgetDragPosition {x:number;y:number;offsetX:number;offsetY:number;width:number;height:number}
export function widgetDropPosition(pointer:{x:number;y:number},offset:{x:number;y:number},bounds:{left:number;top:number;width:number;height:number},gap:number,rowGap:number):{x:number;y:number}|null {
  if(![pointer.x,pointer.y,offset.x,offset.y,bounds.left,bounds.top,bounds.width,bounds.height,gap,rowGap].every(Number.isFinite)||gap<0||rowGap<0)return null;
  const cellWidth=(bounds.width-gap*11)/12,cellHeight=(bounds.height-rowGap*3)/4;
  if(cellWidth<=0||cellHeight<=0||pointer.x<bounds.left||pointer.y<bounds.top||pointer.x>=bounds.left+bounds.width||pointer.y>=bounds.top+bounds.height)return null;
  return {x:Math.floor((pointer.x-offset.x-bounds.left)/(cellWidth+gap)),y:Math.floor((pointer.y-offset.y-bounds.top)/(cellHeight+rowGap))};
}
export function clearWidgetDrag(onWidgetDrag:(id:string|null,position?:WidgetDragPosition)=>void){onWidgetDrag(null);}
interface Props {pageId:string;pageIds:string[];editing:boolean;retainForTransition?:boolean;onStep:(direction:number)=>void;onWidgetDrag:(id:string|null,position?:WidgetDragPosition)=>void;onEdgeMove:(id:string,direction:number)=>void;onWidgetDrop:(id:string,target:string|null,position:{x:number;y:number}|null)=>void;children:ReactNode}
export function PagedViewport({pageId,pageIds,editing,retainForTransition=true,onStep,onWidgetDrag,onEdgeMove,onWidgetDrop,children}:Props) {
  const root=useRef<HTMLDivElement>(null),last=useRef(0),start=useRef<{x:number;y:number;id:number;widget?:string;active:boolean;offsetX:number;offsetY:number;width:number;height:number}|null>(null),edge=useRef<{direction:number;timer:number}|null>(null);
  const callbacks=useRef({onStep,onWidgetDrag,onEdgeMove,onWidgetDrop});callbacks.current={onStep,onWidgetDrag,onEdgeMove,onWidgetDrop};
  const previous=useRef({id:pageId,content:retainForTransition?children:null,index:pageIds.indexOf(pageId)}),[leaving,setLeaving]=useState<{id:string;content:ReactNode}|null>(null),[direction,setDirection]=useState(1),[widgetDragActive,setWidgetDragActive]=useState(false);
  const clearEdge=()=>{if(edge.current)window.clearTimeout(edge.current.timer);edge.current=null;};
  const resetGesture=()=>{const gesture=start.current;start.current=null;clearEdge();setWidgetDragActive(false);if(gesture&&root.current?.hasPointerCapture(gesture.id)){try{root.current.releasePointerCapture(gesture.id);}catch{}}if(gesture?.widget)clearWidgetDrag(callbacks.current.onWidgetDrag);};
  useLayoutEffect(()=>{
    const old=previous.current;
    if(old.id!==pageId){
      if(!start.current?.widget)resetGesture();
      setDirection(pageIds.indexOf(pageId)>=old.index?1:-1);setLeaving({id:old.id,content:old.content});
    }
    previous.current={id:pageId,content:retainForTransition?children:null,index:pageIds.indexOf(pageId)};
  },[pageId,children,pageIds,retainForTransition]);
  useEffect(()=>{if(!leaving)return;const timer=window.setTimeout(()=>setLeaving(null),320);return()=>window.clearTimeout(timer);},[leaving]);
  useEffect(()=>{if(!editing&&start.current?.widget)resetGesture();},[editing]);
  useEffect(()=>{
    const cancel=()=>resetGesture();const hidden=()=>{if(document.hidden)cancel();};
    window.addEventListener("blur",cancel);document.addEventListener("visibilitychange",hidden);
    return()=>{window.removeEventListener("blur",cancel);document.removeEventListener("visibilitychange",hidden);clearEdge();};
  },[]);
  useEffect(()=>{
    const next=(direction:number)=>{const now=performance.now();if(!direction||now-last.current<310)return;last.current=now;callbacks.current.onStep(direction);};
    const key=(event:KeyboardEvent)=>{if(editing||(event.target as Element).closest(`${interactive},${contentSurface}`)||document.querySelector("dialog[open],.settings-backdrop"))return;if(event.key==="ArrowLeft"||event.key==="ArrowRight"){event.preventDefault();next(event.key==="ArrowRight"?1:-1);}};
    let accumulated=0,wheelAt=0;
    const wheel=(event:WheelEvent)=>{if(editing)return;const horizontal=Math.abs(event.deltaX)>Math.abs(event.deltaY);if(!event.ctrlKey&&!horizontal)return;if((event.target as Element).closest(contentSurface))return;event.preventDefault();const now=performance.now();if(now-wheelAt>180)accumulated=0;wheelAt=now;accumulated+=event.ctrlKey?event.deltaY:event.deltaX;if(Math.abs(accumulated)>45){next(Math.sign(accumulated));accumulated=0;}};
    const node=root.current;window.addEventListener("keydown",key);node?.addEventListener("wheel",wheel,{passive:false});return()=>{window.removeEventListener("keydown",key);node?.removeEventListener("wheel",wheel);};
  },[editing]);
  return <div ref={root} className={`paged-viewport${widgetDragActive?" is-widget-dragging":""}`} data-direction={direction} onPointerDown={event=>{
    if(event.button!==0||!event.isPrimary)return;
    resetGesture();const target=event.target as Element;
    const card=target.closest<HTMLElement>("[data-widget-id]");
    const widget=editing&&card&&!target.closest(widgetDragInteractive)&&((target.closest(".drag-handle"))||(target.closest(".widget-card .card-heading")))?card.dataset.widgetId:undefined;
    if(!widget&&!canStartPageSwipe(target,editing,event.pointerType))return;
    const dragCard=widget?target.closest<HTMLElement>("[data-widget-id]"):null,rect=dragCard?.getBoundingClientRect();
    start.current={x:event.clientX,y:event.clientY,id:event.pointerId,widget,active:false,offsetX:rect?event.clientX-rect.left:0,offsetY:rect?event.clientY-rect.top:0,width:rect?.width??0,height:rect?.height??0};
    try{event.currentTarget.setPointerCapture(event.pointerId);}catch{resetGesture();return;}
    if(widget)event.preventDefault();
  }} onPointerMove={event=>{
    const gesture=start.current;if(!gesture||gesture.id!==event.pointerId)return;
    if(event.pointerType==="mouse"&&(event.buttons&1)===0){resetGesture();return;}
    if(!gesture.widget)return;
    if(!gesture.active&&Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>6){gesture.active=true;setWidgetDragActive(true);}
    if(!gesture.active)return;callbacks.current.onWidgetDrag(gesture.widget,{x:event.clientX,y:event.clientY,offsetX:gesture.offsetX,offsetY:gesture.offsetY,width:gesture.width,height:gesture.height});const bounds=event.currentTarget.getBoundingClientRect();const direction=event.clientX<bounds.left+44?-1:event.clientX>bounds.right-44?1:0;
    if(edge.current?.direction===direction)return;clearEdge();if(direction)edge.current={direction,timer:window.setTimeout(()=>{edge.current=null;if(start.current?.widget)callbacks.current.onEdgeMove(start.current.widget,direction);},500)};
  }} onPointerUp={event=>{
    const gesture=start.current;if(!gesture||gesture.id!==event.pointerId)return;
    start.current=null;clearEdge();setWidgetDragActive(false);if(event.currentTarget.hasPointerCapture(event.pointerId)){try{event.currentTarget.releasePointerCapture(event.pointerId);}catch{}}
    if(gesture.widget){if(gesture.active){const hit=document.elementFromPoint(event.clientX,event.clientY),target=hit?.closest<HTMLElement>("[data-widget-id]")?.dataset.widgetId??null,grid=hit?.closest<HTMLElement>(".widget-grid"),bounds=grid?.getBoundingClientRect(),style=grid?getComputedStyle(grid):null,gap=style?Number.parseFloat(style.columnGap)||0:0,rowGap=style?Number.parseFloat(style.rowGap)||0:0;callbacks.current.onWidgetDrop(gesture.widget,target,bounds?widgetDropPosition({x:event.clientX,y:event.clientY},{x:gesture.offsetX,y:gesture.offsetY},bounds,gap,rowGap):null);}callbacks.current.onWidgetDrag(null);return;}
    const direction=pageSwipeDirection(gesture,{x:event.clientX,y:event.clientY,id:event.pointerId});if(direction)callbacks.current.onStep(direction);
  }} onPointerCancel={event=>{if(start.current?.id===event.pointerId)resetGesture();}} onLostPointerCapture={event=>{if(event.target===event.currentTarget&&start.current?.id===event.pointerId)resetGesture();}}>
    {leaving&&<div key={leaving.id} className="dashboard-page-stage page-leaving" aria-hidden="true" inert>{leaving.content}</div>}
    <div className="dashboard-page-stage page-entering" key={pageId}>{children}</div>
  </div>;
}
