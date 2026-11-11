import {normalizeTheme,themeAccent} from "../presentation/theme";
import type { AppSettings, OverviewCardId, OverviewCardSizes } from "../types";
import { logEvent } from "../services/appLogger";
import { normalizeNotificationPreferences } from "../services/notifications/policy";
import { normalizeRemoteAnalysisSettings } from "../domain/analysis/remoteSettings";

const storageKey = "codex-desktop.settings.v1";
const overviewIds:OverviewCardId[]=["agents","api","vps","activity","todos","updates","health"];

export function normalizeOverviewCardOrder(value:unknown):OverviewCardId[] {
  return Array.isArray(value)&&new Set(value).size===value.length&&value.every(id=>overviewIds.includes(id))
    ? [...value,...overviewIds.filter(id=>!value.includes(id))] : [...overviewIds];
}

export function normalizeOverviewCardSizes(value:unknown):OverviewCardSizes {
  const source=value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
  const size=(id:OverviewCardId)=>{
    const raw=source[id],item=raw&&typeof raw==="object"?raw as Record<string,unknown>:{};
    const defaults={agents:[4,240,216],api:[4,240,216],vps:[4,240,216],activity:[7,384,240],todos:[5,240,168],updates:[7,144,96],health:[5,288,216]}[id];
    return {columns:Math.round(clamp(item.columns,3,12,defaults[0])),height:Math.max(defaults[2],Math.min(720,Math.round(clamp(item.height,defaults[2],720,defaults[1])/24)*24))};
  };
  return Object.fromEntries(overviewIds.map(id=>[id,size(id)])) as OverviewCardSizes;
}

export const defaultSettings: AppSettings = {
  workbenchOverviewOrder: normalizeOverviewCardOrder(null),
  workbenchOverviewSizes: normalizeOverviewCardSizes(null),
  credentialNamespaceVersion: 1,
  checkUpdatesOnStartup: true,
  displayName: "",
  theme: "burgundy",
  opacity: 82,
  hudBackgroundOpacity: 88,
  blur: 24,
  accent: "#c2263f",
  glassBorderOpacity: 18,
  glassShadowStrength: 40,
  animations: true,
  autoStart: false,
  desktopMode: false,
  mousePassthrough: false,
  desktopSurfaceMode: "keep",
  startupMode: "desktop",
  showMainOnStartup: true,
  showDashboardOnStartup: false,
  wallpaperMode: "auto",
  simulationEnabled: false,
  simulationScenario: "normal",
  beszelUrl: "",
  beszelAutoStartHub: false,
  beszelHubExecutable: "",
  beszelHubDataDirectory: "",
  beszelSystemId: "",
  beszelRefreshIntervalSeconds: 30,
  beszelCredentialRevision: 0,
  notificationPreferences: normalizeNotificationPreferences(null),
  apiConnections: { localAgentUsageEnabled: false, deepseekEnabled: false, anthropicEnabled: false, openaiEnabled: false, mimoEnabled: false, credentialRevision: 0 },
  remoteAnalysis: normalizeRemoteAnalysisSettings(null),
};

export function loadSettings(): AppSettings {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<AppSettings> | null;
    if (!value) return { ...defaultSettings };
    return {
      workbenchOverviewOrder: normalizeOverviewCardOrder(value.workbenchOverviewOrder),
      workbenchOverviewSizes: normalizeOverviewCardSizes(value.workbenchOverviewSizes),
      credentialNamespaceVersion: 1,
      displayName: typeof value.displayName==="string"?value.displayName.replace(/[\u0000-\u001f\u007f]/g,"").trim().slice(0,32):"",
      theme: normalizeTheme(value.theme),
      opacity: clamp(value.opacity, 55, 96, defaultSettings.opacity),
      hudBackgroundOpacity: clamp(value.hudBackgroundOpacity, 45, 95, defaultSettings.hudBackgroundOpacity),
      blur: clamp(value.blur, 0, 36, defaultSettings.blur),
      accent: themeAccent(normalizeTheme(value.theme)),
      glassBorderOpacity: clamp(value.glassBorderOpacity, 0, 45, defaultSettings.glassBorderOpacity),
      glassShadowStrength: clamp(value.glassShadowStrength, 0, 100, defaultSettings.glassShadowStrength),
      animations: typeof value.animations === "boolean" ? value.animations : defaultSettings.animations,
      autoStart: typeof value.autoStart === "boolean" ? value.autoStart : defaultSettings.autoStart,
      checkUpdatesOnStartup: value.checkUpdatesOnStartup !== false,
      desktopMode: typeof value.desktopMode === "boolean" ? value.desktopMode : defaultSettings.desktopMode,
      mousePassthrough: typeof value.mousePassthrough === "boolean" ? value.mousePassthrough : defaultSettings.mousePassthrough,
      desktopSurfaceMode: value.desktopSurfaceMode === "hide-icons" ? "hide-icons" : "keep",
      startupMode: value.startupMode === "dashboard" || value.startupMode === "custom" ? value.startupMode : "desktop",
      showMainOnStartup: typeof value.showMainOnStartup === "boolean" ? value.showMainOnStartup : defaultSettings.showMainOnStartup,
      showDashboardOnStartup: typeof value.showDashboardOnStartup === "boolean" ? value.showDashboardOnStartup : defaultSettings.showDashboardOnStartup,
      wallpaperMode: value.wallpaperMode === "dark" || value.wallpaperMode === "light" ? value.wallpaperMode : "auto",
      simulationEnabled: typeof value.simulationEnabled === "boolean" ? value.simulationEnabled : defaultSettings.simulationEnabled,
      simulationScenario: value.simulationScenario === "warning" || value.simulationScenario === "error" || value.simulationScenario === "high-load" ? value.simulationScenario : "normal",
      beszelUrl: typeof value.beszelUrl === "string" ? value.beszelUrl.slice(0, 500) : "",
      beszelAutoStartHub: value.beszelAutoStartHub === true,
      beszelHubExecutable: typeof value.beszelHubExecutable === "string" ? value.beszelHubExecutable.slice(0, 1024) : "",
      beszelHubDataDirectory: typeof value.beszelHubDataDirectory === "string" ? value.beszelHubDataDirectory.slice(0, 1024) : "",
      beszelSystemId: typeof value.beszelSystemId === "string" ? value.beszelSystemId.trim().slice(0, 80) : "",
      beszelRefreshIntervalSeconds: clamp(value.beszelRefreshIntervalSeconds, 10, 300, 30),
      beszelCredentialRevision: clamp(value.beszelCredentialRevision, 0, Number.MAX_SAFE_INTEGER, 0),
      notificationPreferences: normalizeNotificationPreferences(value.notificationPreferences),
      remoteAnalysis: normalizeRemoteAnalysisSettings(value.remoteAnalysis),
      apiConnections: {
        localAgentUsageEnabled: value.apiConnections?.localAgentUsageEnabled === true,
        deepseekEnabled: value.apiConnections?.deepseekEnabled === true,
        anthropicEnabled: value.apiConnections?.anthropicEnabled === true,
        mimoEnabled: value.apiConnections?.mimoEnabled === true,
        openaiEnabled: value.apiConnections?.openaiEnabled === true,
        credentialRevision: clamp(value.apiConnections?.credentialRevision, 0, Number.MAX_SAFE_INTEGER, 0),
      },
    };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings: AppSettings) {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ ...settings, theme: normalizeTheme(settings.theme), accent: themeAccent(normalizeTheme(settings.theme)) }));
    logEvent("info", "settings.saved", { theme: settings.theme, animations: settings.animations });
  } catch {
    logEvent("warn", "settings.save_failed");
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
