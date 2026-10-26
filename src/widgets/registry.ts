import type { LayoutPreset, WidgetPlacement } from "../types";

export interface WidgetDefinition {
  id: string;
  title: string;
  glyph: string;
  category: string;
  dataProvider: string;
  defaultPlacement: WidgetPlacement;
  defaultPosition: { row: number; column: number };
  settings: Record<string, string | number | boolean>;
}

const widgetSpecs = [
  { id: "codex", title: "AI Control Center", glyph: "◉", category: "agents", dataProvider: "agent-quotas", defaultPlacement: { id: "codex", x: 0, y: 0, width: 3, height: 1, hidden: false } },
  { id: "api", title: "API 余额", glyph: "◈", category: "api", dataProvider: "api-balances", defaultPlacement: { id: "api", x: 3, y: 0, width: 3, height: 1, hidden: false } },
  { id: "vps", title: "服务器 / VPS", glyph: "▤", category: "server", dataProvider: "vps-status", defaultPlacement: { id: "vps", x: 6, y: 0, width: 3, height: 1, hidden: false } },
  { id: "health", title: "系统健康", glyph: "⌁", category: "system", dataProvider: "system-health", defaultPlacement: { id: "health", x: 9, y: 0, width: 3, height: 1, hidden: false } },
  { id: "notices", title: "最近通知 / 异常", glyph: "♧", category: "notice", dataProvider: "notifications", defaultPlacement: { id: "notices", x: 0, y: 1, width: 5, height: 1, hidden: false } },
  { id: "resources", title: "资源监控", glyph: "▥", category: "resource", dataProvider: "vps-status", defaultPlacement: { id: "resources", x: 5, y: 1, width: 7, height: 1, hidden: false } },
  { id: "dock", title: "快捷启动", glyph: "▦", category: "dock", dataProvider: "application-list", defaultPlacement: { id: "dock", x: 0, y: 2, width: 12, height: 1, hidden: false } },
  { id: "hardware", title: "本机硬件", glyph: "▣", category: "system", dataProvider: "hardware-status", defaultPlacement: { id: "hardware", x: 0, y: 3, width: 12, height: 1, hidden: false } },
] as const;

const resourceSpecs = [
  {id:"pc-overview",title:"本机资源",width:8,height:1},
  {id:"pc-gpu",title:"GPU 详情",width:4,height:3},
  {id:"pc-disks",title:"磁盘容量",width:8,height:1},
  {id:"pc-trends",title:"本机趋势",width:8,height:1},
].map(item=>({id:item.id,title:item.title,glyph:"▣",category:"resource",dataProvider:"hardware-status",defaultPlacement:{id:item.id,x:0,y:0,width:item.width,height:item.height,hidden:false} as WidgetPlacement}));
export const widgetRegistry: WidgetDefinition[] = [...widgetSpecs,...resourceSpecs].map((widget) => ({
  ...widget,
  defaultPosition: { row: widget.defaultPlacement.y, column: widget.defaultPlacement.x },
  settings: {},
}));

export const defaultPlacements = widgetSpecs.map(({ defaultPlacement }) => ({ ...defaultPlacement }));

export function createPresetPlacements(mode: LayoutPreset): WidgetPlacement[] {
  return defaultPlacements.map((item) => ({
    ...item,
    width: mode === "compact" && item.id === "resources" ? 6
      : mode === "minimal" && ["notices", "health"].includes(item.id) ? 6
        : item.width,
    hidden: mode === "minimal" && item.id === "notices",
  }) as WidgetPlacement);
}
