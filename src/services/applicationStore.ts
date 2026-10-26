import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ApplicationConfig, ApplicationItem, ApplicationType } from "../types";
import { logEvent } from "./appLogger";

export const applicationsStorageKey = "codex-desktop.applications.v1";
export const configVersion = 2 as const;
let nativeSaveQueue: Promise<void> = Promise.resolve();
export const applicationsPreviousStorageKey = applicationsStorageKey + ".previous";

export function readApplicationConfig(value: unknown): ApplicationItem[] {
  const apps = parseApplicationImport(value);
  const entries = Array.isArray(value) ? value : (value as { apps?: unknown[] } | null)?.apps;
  if (!apps || !Array.isArray(entries) || apps.length !== entries.length) {
    throw new Error("应用配置读取失败，原配置已保留。请检查配置文件后重新打开应用管理。");
  }
  return migrateLocalAiEntries(value, apps);
}

export function readCachedApplications(): ApplicationItem[] {
  const raw = localStorage.getItem(applicationsStorageKey);
  return raw === null ? defaultApplications() : readApplicationConfig(JSON.parse(raw));
}

const starterApps: Array<Pick<ApplicationItem, "id" | "name" | "glyph" | "color">> = [
  { id: "wechat", name: "微信", glyph: "微", color: "#32c878" },
  { id: "qq", name: "QQ", glyph: "Q", color: "#39a9ff" },
  { id: "edge", name: "Edge", glyph: "e", color: "#32c6cf" },
  { id: "vscode", name: "VS Code", glyph: "<>", color: "#46a5f5" },
  { id: "terminal", name: "Terminal", glyph: ">_", color: "#bcc5d6" },
  { id: "codex", name: "Codex", glyph: "✳", color: "#dce7f6" },
  { id: "claude", name: "Claude", glyph: "✺", color: "#ff9b69" },
  { id: "chatgpt", name: "ChatGPT", glyph: "◎", color: "#65d6a5" },
];

export function defaultApplications(): ApplicationItem[] {
  return addLocalAiEntries(starterApps.map((app, order) => ({ ...app, icon: "", type: "exe", target: "", pinned: true, order })));
}
const localEntries = [{id:"builtin-ollama",name:"Ollama",glyph:"◌"},{id:"builtin-qwen",name:"Qwen",glyph:"Q"},{id:"builtin-deepseek-local",name:"DeepSeek Local",glyph:"D"}];
function addLocalAiEntries(apps:ApplicationItem[]):ApplicationItem[]{
  const next=[...apps];
  for(const entry of localEntries)if(!next.some(app=>app.id===entry.id))next.push({...entry,icon:"",type:"url",target:"http://127.0.0.1:11434",pinned:true,order:next.length,category:"本地 AI"});
  return next;
}
export function migrateLocalAiEntries(value:unknown,apps:ApplicationItem[]):ApplicationItem[]{
  const version=value&&typeof value==="object"?(value as {version?:unknown}).version:undefined;
  return version===2?apps:addLocalAiEntries(apps);
}

export function loadApplications(): ApplicationItem[] {
  try {
    return readCachedApplications();
  } catch {
    return defaultApplications();
  }
}

export function saveApplications(apps: ApplicationItem[]): Promise<void> {
  const config: ApplicationConfig = { version: configVersion, apps: normalizeApplications(apps) };
  const isNativeApp = isTauri();
  const localMirror: ApplicationConfig = {
    ...config,
    apps: isNativeApp ? config.apps.map((app) => ({ ...app, icon: "" })) : config.apps,
  };
  const pending = nativeSaveQueue.then(async () => {
    try {
      // The native file is authoritative. Never change the mirror before its acknowledgement.
      if (isNativeApp) await invoke<void>("save_applications", { config });
      try {
        const previous = localStorage.getItem(applicationsStorageKey);
        if (!isNativeApp && previous !== null) readApplicationConfig(JSON.parse(previous));
        if (previous !== null) localStorage.setItem(applicationsPreviousStorageKey, previous);
        localStorage.setItem(applicationsStorageKey, JSON.stringify(localMirror));
      } catch (error) {
        if (!isNativeApp) throw error;
        // A cache failure cannot undo a successfully saved native file.
        logEvent("warn", "launcher.config_mirror_save_failed", { appCount: config.apps.length });
      }
      logEvent("info", "launcher.config_saved", { appCount: config.apps.length });
    } catch {
      logEvent("warn", "launcher.file_config_save_failed", { appCount: config.apps.length });
      throw new Error("应用配置保存失败，未保存本次更改。请检查磁盘空间、文件权限或原配置是否损坏后重试。");
    }
  });
  nativeSaveQueue = pending.catch(() => undefined);
  return pending;
}

export function parseApplicationImport(value: unknown): ApplicationItem[] | null {
  const candidate = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { apps?: unknown }).apps)
      ? (value as { apps: unknown[] }).apps
      : null;
  if (!candidate) return null;

  const apps = candidate.flatMap((raw, index): ApplicationItem[] => {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as Partial<ApplicationItem> & { path?: unknown };
    const type = isApplicationType(entry.type) ? entry.type : "exe";
    const target = typeof entry.target === "string" ? entry.target : typeof entry.path === "string" ? entry.path : "";
    const name = typeof entry.name === "string" ? entry.name.trim().slice(0, 80) : "";
    if (!name || name.length === 0) return [];
    return [{
      id: typeof entry.id === "string" && entry.id.length > 0 ? entry.id.slice(0, 120) : createApplicationId(name, target, index),
      name,
      icon: normalizeIcon(entry.icon),
      type,
      target: target.slice(0, 2_000),
      arguments: typeof entry.arguments === "string" ? entry.arguments.slice(0, 2_000) : undefined,
      category: typeof entry.category === "string" ? entry.category.slice(0, 80) : undefined,
      pinned: typeof entry.pinned === "boolean" ? entry.pinned : true,
      order: typeof entry.order === "number" && Number.isFinite(entry.order) ? Math.max(0, entry.order) : index,
      glyph: typeof entry.glyph === "string" ? entry.glyph.slice(0, 8) : undefined,
      color: typeof entry.color === "string" && /^#[0-9a-f]{6}$/i.test(entry.color) ? entry.color : undefined,
      sourcePath: typeof entry.sourcePath === "string" ? entry.sourcePath.slice(0, 2_000) : undefined,
      processName: typeof entry.processName === "string" ? entry.processName.slice(0, 120) : undefined,
      ...(entry.iconSource === "system" || entry.iconSource === "custom" ? { iconSource: entry.iconSource } : {}),
    }];
  });
  return normalizeApplications(apps);
}

export function moveApplication(apps: ApplicationItem[], id: string, offset: number): ApplicationItem[] {
  const current = normalizeApplications(apps);
  const index = current.findIndex((app) => app.id === id);
  const target = Math.max(0, Math.min(current.length - 1, index + offset));
  if (index < 0 || index === target) return current;
  const [item] = current.splice(index, 1);
  current.splice(target, 0, item);
  return current.map((app, order) => ({ ...app, order }));
}

export function normalizeApplications(apps: ApplicationItem[]): ApplicationItem[] {
  return [...apps].sort((left, right) => left.order - right.order).map((app, index) => ({ ...app, order: index }));
}

export function createApplicationId(name: string, target: string, index = 0) {
  const value = `${name.toLowerCase()}|${target.toLowerCase()}|${index}`;
  let hash = 2166136261;
  for (let position = 0; position < value.length; position += 1) {
    hash ^= value.charCodeAt(position);
    hash = Math.imul(hash, 16777619);
  }
  return `app-${(hash >>> 0).toString(16)}`;
}

function isApplicationType(value: unknown): value is ApplicationType {
  return value === "exe" || value === "shortcut" || value === "url" || value === "command";
}

function normalizeIcon(value: unknown) {
  if (typeof value !== "string" || value.length >= 3_000_000) return "";
  return /^data:image\/(?:png|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[a-z\d+/=\r\n]+$/i.test(value) ? value : "";
}
