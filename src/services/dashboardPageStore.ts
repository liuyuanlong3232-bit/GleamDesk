import type { LayoutDocument, MonitorInfo, WidgetPlacement } from "../types";
import { widgetRegistry } from "../widgets/registry";
import { activeDashboardPage, createDashboardPages, preservePageWidgetPositions, type DashboardPages, type DashboardPage } from "../domain/dashboard/pages";
const key=(id:string)=>"codex-desktop.dashboard-pages.v1."+encodeURIComponent(id);
type Monitor=Pick<MonitorInfo,"id"|"width"|"height"|"scaleFactor">;
export function parseDashboardPages(value:unknown,monitor:Monitor,legacy:LayoutDocument):DashboardPages|null {
  const candidate=value as Partial<DashboardPages>|null;
  if(candidate?.schemaVersion!==1||!Array.isArray(candidate.pages)||candidate.pages.length>24||candidate.pages.length===0)return null;
  const fallback=createDashboardPages(monitor,legacy),seen=new Set<string>(),known=new Set(widgetRegistry.map(widget=>widget.id));
  try {
    const pages:DashboardPage[]=candidate.pages.flatMap(raw=>{
      if(!raw||typeof raw.id!=="string"||!raw.id||raw.id.length>64||typeof raw.name!=="string"||!raw.name.trim()||seen.has(raw.id)||!Array.isArray(raw.widgets)||raw.widgets.length>40)return [];
      const system=fallback.pages.find(page=>page.id===raw.id);if(!system&&raw.kind!=="custom")return [];
      const ids=new Set<string>();const widgets:WidgetPlacement[]=raw.widgets.flatMap(widget=>{
        if(!widget||typeof widget.id!=="string"||!known.has(widget.id)||ids.has(widget.id)||!Number.isFinite(widget.width)||!Number.isFinite(widget.height))return [];
        ids.add(widget.id);return [{id:widget.id,x:widget.x as number,y:widget.y as number,width:widget.width,height:widget.height,hidden:widget.hidden===true}];
      });
      const packed=preservePageWidgetPositions(widgets);seen.add(raw.id);
      return [{id:raw.id,name:raw.name.trim().slice(0,40),kind:system?.kind??"custom",system:Boolean(system),...(["standard","compact","minimal"].includes(raw.mode??"")?{mode:raw.mode}:{}),hidden:raw.hidden===true,widgets:packed}];
    });
    pages.push(...fallback.pages.filter(page=>!seen.has(page.id)));if(pages.length>24)return null;
    if(!pages.some(page=>!page.hidden))pages[0].hidden=false;
    const document:DashboardPages={schemaVersion:1,monitorId:monitor.id,activePageId:typeof candidate.activePageId==="string"?candidate.activePageId:"overview",pages};
    return {...document,activePageId:activeDashboardPage(document).id};
  }catch{return null;}
}
export function loadDashboardPages(monitor:Monitor,legacy:LayoutDocument):DashboardPages {
  try{return parseDashboardPages(JSON.parse(localStorage.getItem(key(monitor.id))??"null"),monitor,legacy)??createDashboardPages(monitor,legacy);}catch{return createDashboardPages(monitor,legacy);}
}
export function saveDashboardPages(document:DashboardPages){localStorage.setItem(key(document.monitorId),JSON.stringify(document));}
const namedKey="codex-desktop.named-pages.v1";
export function loadNamedPages():Record<string,unknown>{try{const value=JSON.parse(localStorage.getItem(namedKey)??"{}");return value&&typeof value==="object"&&!Array.isArray(value)?value:{};}catch{return {};}}
export function saveNamedPages(name:string,document:DashboardPages){const current=loadNamedPages();const entries=Object.entries(current).filter(([key])=>key!==name).slice(-99);localStorage.setItem(namedKey,JSON.stringify(Object.fromEntries([...entries,[name,document]])));}
