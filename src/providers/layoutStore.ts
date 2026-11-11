import type { LayoutDocument, LayoutPreset, MonitorInfo, NamedLayout, WidgetPlacement } from "../types";
import { defaultPlacements, createPresetPlacements, widgetRegistry } from "../widgets/registry";
import { logEvent } from "../services/appLogger";

const keyFor = (monitorId: string) => "codex-desktop.layout.v2." + encodeURIComponent(monitorId);
const legacyKeyFor = (monitorId: string) => "codex-desktop.layout.v1." + monitorId;
const namedLayoutsKey = "codex-desktop.named-layouts.v1";

export function loadNamedLayouts(monitorId?: string): NamedLayout[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(namedLayoutsKey) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isNamedLayout).filter((item) => !monitorId || item.document.monitorId === monitorId);
  } catch {
    return [];
  }
}

export function saveNamedLayout(name: string, document: LayoutDocument): NamedLayout[] {
  const normalizedName = name.trim().slice(0, 48);
  if (!normalizedName) return loadNamedLayouts(document.monitorId);
  const all = loadNamedLayouts().filter((item) => !(item.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase() && item.document.monitorId === document.monitorId));
  all.push({ name: normalizedName, document: { ...document }, savedAt: new Date().toISOString() });
  try {
    localStorage.setItem(namedLayoutsKey, JSON.stringify(all.slice(-100)));
    logEvent("info", "layout.named_saved", { monitorId: document.monitorId, name: normalizedName });
  } catch {
    logEvent("warn", "layout.named_save_failed", { monitorId: document.monitorId });
  }
  return loadNamedLayouts(document.monitorId);
}

function isNamedLayout(value: unknown): value is NamedLayout {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NamedLayout>;
  return typeof item.name === "string" && typeof item.savedAt === "string" && isLayoutDocument(item.document);
}

export function createDefaultLayout(monitor: Pick<MonitorInfo, "id" | "width" | "height" | "scaleFactor">): LayoutDocument {
  return {
    schemaVersion: 2,
    monitorId: monitor.id,
    resolution: `${monitor.width}x${monitor.height}`,
    scaleFactor: monitor.scaleFactor,
    mode: "standard",
    widgets: defaultPlacements.map((item) => ({ ...item })),
    updatedAt: new Date().toISOString(),
  };
}

export function loadLayout(monitor: Pick<MonitorInfo, "id" | "width" | "height" | "scaleFactor">): LayoutDocument {
  const fallback = createDefaultLayout(monitor);
  try {
    const stored = localStorage.getItem(keyFor(monitor.id));
    if (stored) {
      const parsed = JSON.parse(stored) as unknown;
      if (isLayoutDocument(parsed)) {
        return { ...parsed, monitorId: monitor.id, resolution: fallback.resolution, scaleFactor: monitor.scaleFactor, widgets: normalizePlacements(parsed.widgets) };
      }
    }

    const legacy = localStorage.getItem(legacyKeyFor(monitor.id));
    if (legacy) {
      const parsed = JSON.parse(legacy) as unknown;
      if (Array.isArray(parsed)) {
        const migrated = { ...fallback, widgets: normalizePlacements(parsed) };
        saveLayout(migrated);
        return migrated;
      }
    }
  } catch {
    logEvent("warn", "layout.load_failed", { monitorId: monitor.id });
  }
  return fallback;
}

export function saveLayout(document: LayoutDocument) {
  const next = { ...document, updatedAt: new Date().toISOString() };
  try {
    localStorage.setItem(keyFor(next.monitorId), JSON.stringify(next));
    logEvent("info", "layout.saved", { monitorId: next.monitorId, mode: next.mode, widgetCount: next.widgets.length });
  } catch {
    logEvent("warn", "layout.save_failed", { monitorId: next.monitorId });
  }
}

export function applyLayoutPreset(document: LayoutDocument, mode: LayoutPreset): LayoutDocument {
  return { ...document, mode, widgets: snapPlacements(createPresetPlacements(mode)) };
}

export function parseLayoutImport(value: unknown, monitor: Pick<MonitorInfo, "id" | "width" | "height" | "scaleFactor">): LayoutDocument | null {
  if (!isLayoutDocument(value)) return null;
  return {
    schemaVersion: 2,
    monitorId: monitor.id,
    resolution: `${monitor.width}x${monitor.height}`,
    scaleFactor: monitor.scaleFactor,
    mode: value.mode,
    widgets: normalizePlacements(value.widgets),
    updatedAt: new Date().toISOString(),
  };
}

function isLayoutDocument(value: unknown): value is LayoutDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LayoutDocument>;
  return candidate.schemaVersion === 2
    && typeof candidate.monitorId === "string"
    && typeof candidate.resolution === "string"
    && typeof candidate.scaleFactor === "number"
    && ["standard", "compact", "minimal"].includes(candidate.mode ?? "")
    && Array.isArray(candidate.widgets);
}

function normalizePlacements(value: unknown): WidgetPlacement[] {
  const input = Array.isArray(value) ? value : [];
  const ids = new Set(widgetRegistry.map((widget) => widget.id));
  const seen = new Set<string>();
  const placements = input.flatMap((item): WidgetPlacement[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<WidgetPlacement>;
    if (typeof candidate.id !== "string" || !ids.has(candidate.id) || seen.has(candidate.id)) return [];
    seen.add(candidate.id);
    const definition = widgetRegistry.find((widget) => widget.id === candidate.id)!;
    const rawWidth = typeof candidate.width === "number" ? candidate.width : (candidate as Partial<WidgetPlacement> & { span?: number }).span;
    const width = typeof rawWidth === "number" && Number.isFinite(rawWidth)
      ? Math.min(12, Math.max(2, Math.round(rawWidth))) as WidgetPlacement["width"]
      : definition.defaultPlacement.width;
    const rawHeight = typeof candidate.height === "number" && Number.isFinite(candidate.height) ? Math.round(candidate.height) : 1;
    const height = Math.min(4, Math.max(1, rawHeight)) as WidgetPlacement["height"];
    const x = typeof candidate.x === "number" && Number.isFinite(candidate.x) ? Math.max(0, Math.min(11, Math.round(candidate.x))) : definition.defaultPlacement.x;
    const y = typeof candidate.y === "number" && Number.isFinite(candidate.y) ? Math.max(0, Math.round(candidate.y)) : definition.defaultPlacement.y;
    return [{ id: candidate.id, x, y, width, height, hidden: candidate.hidden === true }];
  });
  return snapPlacements([...placements, ...defaultPlacements.filter((item) => !seen.has(item.id)).map((item) => ({ ...item }))]);
}

export function snapPlacements(placements: WidgetPlacement[]): WidgetPlacement[] {
  let column = 0;
  let row = 0;
  let rowHeight: number = 1;
  return placements.map((item) => {
    if (item.hidden) return { ...item };
    if (column + item.width > 12) {
      row += rowHeight;
      column = 0;
      rowHeight = 1;
    }
    const positioned = { ...item, x: column, y: row };
    column += item.width;
    rowHeight = Math.max(rowHeight, item.height);
    if (column === 12) {
      row += rowHeight;
      column = 0;
      rowHeight = 1;
    }
    return positioned;
  });
}

export type HudEdge="top"|"right"|"bottom"|"left";
export interface HudPlacement{edge:HudEdge;offset:number}
export function loadHudPlacement(monitorId:string):HudPlacement{
 try{const value=JSON.parse(localStorage.getItem(`codex-desktop.hud-position.v1.${monitorId}`)||"null");if(value&&["top","right","bottom","left"].includes(value.edge)&&Number.isFinite(value.offset))return {edge:value.edge,offset:Math.max(0,Math.min(1,value.offset))}}catch{/* Keep a usable position if local storage is unavailable. */}
 return {edge:"top",offset:1};
}
export function saveHudPlacement(monitorId:string,placement:HudPlacement){localStorage.setItem(`codex-desktop.hud-position.v1.${monitorId}`,JSON.stringify(placement))}
export function hudPosition(placement:HudPlacement,size:{width:number;height:number},viewport:{width:number;height:number}){
 const inset=16,bottomSpace=64,width=Math.min(size.width,Math.max(0,viewport.width-inset*2)),height=Math.min(size.height,Math.max(0,viewport.height-inset*2-bottomSpace));
 const xTravel=Math.max(0,viewport.width-inset*2-width),yTravel=Math.max(0,viewport.height-inset*2-bottomSpace-height);
 const offset=Math.max(0,Math.min(1,placement.offset));
 return {x:placement.edge==="left"?inset:placement.edge==="right"?inset+xTravel:inset+xTravel*offset,y:placement.edge==="top"?inset:placement.edge==="bottom"?inset+yTravel:inset+yTravel*offset};
}
export function dragHudPlacement(point:{x:number;y:number},viewport:{width:number;height:number},current:HudPlacement,size={width:0,height:0},grabFraction=.5):HudPlacement{
 const distances={top:Math.abs(point.y),right:Math.abs(viewport.width-point.x),bottom:Math.abs(viewport.height-64-point.y),left:Math.abs(point.x)};
 const edge=(Object.keys(distances) as HudEdge[]).reduce((nearest,next)=>distances[next]<distances[nearest]?next:nearest,current.edge);
 const horizontal=edge==="top"||edge==="bottom",length=(horizontal?viewport.width:viewport.height-64)-32,run=Math.min(length,horizontal?size.width:size.height);
 const origin=(horizontal?point.x:point.y)-16-run*Math.max(0,Math.min(1,grabFraction));
 return {edge,offset:Math.max(0,Math.min(1,origin/Math.max(1,length-run)))};
}
