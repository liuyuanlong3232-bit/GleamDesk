import type { LayoutDocument, MonitorInfo, WidgetPlacement } from "../../types";

export type DashboardPageKind = "overview" | "resources" | "workspace" | "toolbox" | "custom";
export interface DashboardPage { id: string; name: string; kind: DashboardPageKind; system: boolean; mode?: LayoutDocument["mode"]; hidden: boolean; widgets: WidgetPlacement[] }
export interface DashboardPages { schemaVersion: 1; monitorId: string; activePageId: string; pages: DashboardPage[] }
type Monitor = Pick<MonitorInfo, "id" | "width" | "height" | "scaleFactor">;
const systemPages = [
  {id:"overview",name:"总览",kind:"overview"}, {id:"resources",name:"资源",kind:"resources"},
  {id:"workspace",name:"工作区",kind:"workspace"}, {id:"toolbox",name:"工具箱",kind:"toolbox"},
] as const;

export function packPageWidgets(widgets: WidgetPlacement[]): WidgetPlacement[] {
  const occupied: WidgetPlacement[] = [];
  return widgets.map(widget => {
    const item = {...widget, width: Math.min(12,Math.max(2,Math.round(widget.width))) as WidgetPlacement["width"],height: Math.min(4,Math.max(1,Math.round(widget.height))) as WidgetPlacement["height"]};
    if (item.hidden) return item;
    for(let y=0;y+item.height<=4;y++) for(let x=0;x+item.width<=12;x++) {
      if(occupied.some(old=>x<old.x+old.width&&x+item.width>old.x&&y<old.y+old.height&&y+item.height>old.y))continue;
      const next={...item,x,y};occupied.push(next);return next;
    }
    throw new Error("这一页空间不足，请减小组件或移到其他页面");
  });
}
export function preservePageWidgetPositions(widgets:WidgetPlacement[]):WidgetPlacement[] {
  const occupied:WidgetPlacement[]=[];
  for(const widget of widgets){
    if(!Number.isInteger(widget.x)||!Number.isInteger(widget.y)||!Number.isInteger(widget.width)||!Number.isInteger(widget.height)||widget.x<0||widget.y<0||widget.width<2||widget.width>12||widget.height<1||widget.height>4||widget.x+widget.width>12||widget.y+widget.height>4)return packPageWidgets(widgets);
    if(widget.hidden)continue;
    if(occupied.some(old=>widget.x<old.x+old.width&&widget.x+widget.width>old.x&&widget.y<old.y+old.height&&widget.y+widget.height>old.y))return packPageWidgets(widgets);
    occupied.push(widget);
  }
  return widgets.map(widget=>({...widget}));
}
export function placeDashboardWidget(document:DashboardPages,pageId:string,widgetId:string,x:number,y:number):DashboardPages {
  const page=document.pages.find(item=>item.id===pageId),widget=page?.widgets.find(item=>item.id===widgetId);
  if(!page||!widget)throw new Error("找不到要放置的组件");
  if(page.hidden||!supportsDashboardWidgets(page))throw new Error("组件只能放在可见的总览、资源或自定义组件页");
  if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x+widget.width>12||y+widget.height>4)throw new Error("这里没有足够的网格空间");
  if(!widget.hidden&&page.widgets.some(item=>item.id!==widgetId&&!item.hidden&&x<item.x+item.width&&x+widget.width>item.x&&y<item.y+item.height&&y+widget.height>item.y))throw new Error("这个位置与其他组件重叠");
  return {...document,pages:document.pages.map(item=>item.id!==pageId?item:{...item,widgets:item.widgets.map(current=>current.id===widgetId?{...current,x,y}:current)})};
}
export function reorderDashboardWidget(document:DashboardPages,pageId:string,sourceId:string,targetId:string):DashboardPages {
  const page=document.pages.find(item=>item.id===pageId),from=page?.widgets.findIndex(item=>item.id===sourceId)??-1,to=page?.widgets.findIndex(item=>item.id===targetId)??-1;
  if(!page||from<0||to<0||from===to)return document;
  const widgets=[...page.widgets],[item]=widgets.splice(from,1);widgets.splice(to,0,item);
  return {...document,pages:document.pages.map(item=>item.id===pageId?{...item,widgets:packPageWidgets(widgets)}:item)};
}
export function createDashboardPages(monitor: Monitor, legacy: LayoutDocument): DashboardPages {
  const byId=new Map(legacy.widgets.map(widget=>[widget.id,widget]));
  const widget=(id:string,width:WidgetPlacement["width"],height:WidgetPlacement["height"])=>({...byId.get(id)!,id,x:0,y:0,width,height,hidden:byId.get(id)?.hidden??false});
  return {schemaVersion:1,monitorId:monitor.id,activePageId:"overview",pages:systemPages.map(page=>({ ...page,system:true,hidden:false,widgets:page.kind==="overview"?packPageWidgets([widget("codex",3,2),widget("api",3,2),widget("vps",3,2),widget("health",3,2),widget("notices",5,1),widget("resources",7,1)]):page.kind==="resources"?packPageWidgets([widget("pc-overview",8,1),widget("pc-gpu",4,3),widget("pc-disks",8,1),widget("pc-trends",8,1),widget("resources",12,1)]):[] }))};
}
export function activeDashboardPage(document: DashboardPages): DashboardPage {
  return document.pages.find(page=>page.id===document.activePageId&&!page.hidden)??document.pages.find(page=>!page.hidden)??document.pages[0];
}
export function pageLayout(document: DashboardPages, monitor: Monitor): LayoutDocument {
  return {schemaVersion:2,monitorId:monitor.id,resolution:`${monitor.width}x${monitor.height}`,scaleFactor:monitor.scaleFactor,mode:activeDashboardPage(document).mode??"standard",widgets:activeDashboardPage(document).widgets,updatedAt:new Date().toISOString()};
}
export function replacePageLayout(document: DashboardPages, id: string, layout: LayoutDocument): DashboardPages {
  return {...document,pages:document.pages.map(page=>page.id===id?{...page,mode:layout.mode,widgets:preservePageWidgetPositions(layout.widgets)}:page)};
}
export function selectDashboardPage(document:DashboardPages,id:string):DashboardPages {
  return document.pages.some(page=>page.id===id&&!page.hidden)?{...document,activePageId:id}:document;
}
export function adjacentDashboardPage(document:DashboardPages,direction:number):DashboardPage {
  const pages=document.pages.filter(page=>!page.hidden), index=pages.findIndex(page=>page.id===activeDashboardPage(document).id);
  return pages[(index+Math.sign(direction)+pages.length)%pages.length];
}
export function supportsDashboardWidgets(page:DashboardPage):boolean { return page.kind==="overview"||page.kind==="resources"||page.kind==="custom"; }
export function adjacentWidgetPage(document:DashboardPages,direction:number,widgetId?:string):DashboardPage|null {
  if(!Math.sign(direction))return null;
  const pages=document.pages.filter(page=>!page.hidden), current=activeDashboardPage(document), index=pages.findIndex(page=>page.id===current.id);
  const widget=widgetId?current.widgets.find(item=>item.id===widgetId):undefined;
  if(widgetId&&!widget)return null;
  for(let step=1;step<pages.length;step++){
    const page=pages[(index+Math.sign(direction)*step+pages.length*2)%pages.length];
    if(!supportsDashboardWidgets(page))continue;
    if(widget){if(page.widgets.some(item=>item.id===widget.id))continue;try{if(!findWidgetSlot(preservePageWidgetPositions(page.widgets),widget.width,widget.height))continue;}catch{continue;}}
    return page;
  }
  return null;
}
export function addDashboardPage(document:DashboardPages,name:string):DashboardPages {
  const clean=name.trim().slice(0,40);if(!clean)throw new Error("请填写页面名称");
  if(document.pages.length>=24)throw new Error("最多支持24个页面");
  const page:DashboardPage={id:crypto.randomUUID(),name:clean,kind:"custom",system:false,hidden:false,widgets:[]};
  return {...document,activePageId:page.id,pages:[...document.pages,page]};
}
export function renameDashboardPage(document:DashboardPages,id:string,name:string):DashboardPages {
  const clean=name.trim().slice(0,40);if(!clean)throw new Error("请填写页面名称");
  return {...document,pages:document.pages.map(page=>page.id===id?{...page,name:clean}:page)};
}
export function hideDashboardPage(document:DashboardPages,id:string,hidden:boolean):DashboardPages {
  const next={...document,pages:document.pages.map(page=>page.id===id?{...page,hidden}:page)};
  if(!next.pages.some(page=>!page.hidden))throw new Error("至少保留一个可见页面");
  return {...next,activePageId:activeDashboardPage(next).id};
}
export function deleteDashboardPage(document:DashboardPages,id:string):DashboardPages {
  if(document.pages.find(page=>page.id===id)?.system)throw new Error("系统页面不能删除，可选择隐藏");
  const next={...document,pages:document.pages.filter(page=>page.id!==id)};
  if(!next.pages.some(page=>!page.hidden))throw new Error("至少保留一个可见页面");
  return {...next,activePageId:activeDashboardPage(next).id};
}
export function moveDashboardWidget(document:DashboardPages,source:string,target:string,widgetId:string,beforeId?:string):DashboardPages {
  const widget=document.pages.find(page=>page.id===source)?.widgets.find(widget=>widget.id===widgetId);
  if(!widget) return document;
  const targetPage=document.pages.find(page=>page.id===target);
  if(!targetPage||targetPage.hidden||!supportsDashboardWidgets(targetPage))throw new Error("组件只能移到可见的总览、资源或自定义组件页");
  if(source===target)return document;
  if(source!==target&&targetPage.widgets.some(item=>item.id===widgetId))throw new Error("目标页已有此组件，请选择其他组件页");
  const targetWidgets=preservePageWidgetPositions(targetPage.widgets),slot=findWidgetSlot(targetWidgets,widget.width,widget.height);
  if(!slot)throw new Error("这一页空间不足，请减小组件或移到其他页面");
  const moved={...widget,...slot,hidden:false};
  const index=beforeId?targetWidgets.findIndex(item=>item.id===beforeId):-1;if(index>=0)targetWidgets.splice(index,0,moved);else targetWidgets.push(moved);
  return {...document,pages:document.pages.map(page=>page.id===source?{...page,widgets:preservePageWidgetPositions(page.widgets.filter(item=>item.id!==widgetId))}:page.id===target?{...page,widgets:targetWidgets}:page)};
}
function findWidgetSlot(widgets:WidgetPlacement[],width:number,height:number):{x:number;y:number}|null {
  for(let y=0;y+height<=4;y++)for(let x=0;x+width<=12;x++)if(!widgets.some(item=>!item.hidden&&x<item.x+item.width&&x+width>item.x&&y<item.y+item.height&&y+height>item.y))return {x,y};
  return null;
}
