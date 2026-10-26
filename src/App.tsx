import {appThemes,applyTheme} from "./presentation/theme";
import {CloseIcon} from "./components/CloseIcon";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { loadLayout, loadNamedLayouts, parseLayoutImport, saveNamedLayout } from "./providers/layoutStore";
import { defaultSettings, loadSettings, saveSettings } from "./providers/settingsStore";
import {syncSimulationMode,invokeLive} from "./services/simulationSafety";
import { useProviderDashboardData } from "./providers/useProviderDashboardData";
import { useSimulationTick, useSimulatedDashboardData } from "./providers/simulation";
import { applyStartupPreferences, isTauri, openDashboardWindow, readMonitors, readRuntimeStatus, readWallpaperProfile, restoreWindows, setDesktopMode, showMainWindow, startMainWindowHitRegionTracking, updateMainWindowHitRegions } from "./tauri";
import type { AppSettings, HistoryKind, LayoutDocument, LayoutPreset, MonitorInfo, NamedLayout, SimulationScenario, WallpaperProfile, WidgetPlacement } from "./types";
import { widgetRegistry } from "./widgets/registry";
import { WidgetCard, WidgetErrorBoundary } from "./widgets/WidgetCard";
import { createWidgetAnimationManager } from "./widgets/animationManager";
import { countHistoryRecords, createHistoryRecord, writeHistoryRecord } from "./services/historyStore";
import { logEvent, readRecentLogs } from "./services/appLogger";
import { testBeszelConnection,observationFromNative,beszelProviderResult } from "./providers/server/beszelProvider";
import {VpsServiceSettings} from "./components/VpsServices";
import { ApplicationDock } from "./components/ApplicationDock";
import { DailyOpenSource } from "./components/DailyOpenSource";
import {DataSourceConnectionsSettings} from "./components/DataSourceConnectionsSettings";
import { ApplicationManager } from "./components/ApplicationManager";
import { SettingsDialog } from "./components/SettingsDialog";
import {PersonalAvatarDialog} from "./components/RoomPortrait";
import { StatusHud,HudLogo,HudQuotaDetails,HudWorkbenchButton } from "./components/StatusHud";
import { hudQuotaUsed,apiHudSummary } from "./presentation/quotaAdapter";
import {agentClients,readAgentRuntime,unavailableAgentRuntime,runningAgentClients} from "./providers/agents/agentUsageProvider";
import { AgentConnectionsSettings } from "./components/AgentConnectionsSettings";
import type { SettingsModuleId } from "./components/settingsModules";
import { ProviderRequestDiagnostics } from "./components/ProviderRequestDiagnostics";
import type { ProviderRequestDiagnostics as RequestDiagnosticsSnapshot } from "./ports/providerDiagnostics";
import { readProviderRequestDiagnostics } from "./tauri";
import { LocalAIWindow } from "./components/LocalAIWindow";
import { useApplications } from "./services/useApplications";
import { activateOrLaunchApplication } from "./services/launcher/windowManager";
import { setMousePassthrough, startPassthroughEscape } from "./tauri";
import type { ApplicationItem } from "./types";
import { NotificationCenter } from "./components/NotificationCenter";
import { useNotificationCenter } from "./services/notifications/useNotificationCenter";
import { ApiConnectionsSettings } from "./components/ApiConnectionsSettings";
import { HistoryAnalysis } from "./components/HistoryAnalysis";
import { AnalysisConnectionsSettings } from "./components/AnalysisConnectionsSettings";
import {ApiMoneyDetails,useApiMoneyClock} from "./components/ApiMoneyDetails";
import { DashboardPageControls,dashboardNavigationItems,buildWorkbenchSearchItems,WorkbenchSearch,type WorkbenchSearchItem } from "./components/DashboardPageControls";
import {loadWebApps,subscribeWebApps,configureToolboxPreset,saveWebApps,webAppUrl} from "./services/webAppStore";
import { DashboardPageManager, WorkbenchRail } from "./components/DashboardAvatarMenu";
import { ToolboxWorkspace } from "./components/ToolboxWorkspace";
import { PagedViewport } from "./components/PagedViewport";
import { WebAppManager } from "./components/WebAppManager";
import { MailConnections } from "./components/MailConnections";
import { WebAppDiagnostics } from "./components/WebAppDiagnostics";
import { Workspace } from "./components/Workspace";
import { WorkbenchOverview, WorkbenchResources } from "./components/WorkbenchOverview";
import { activeDashboardPage, adjacentDashboardPage, adjacentWidgetPage, supportsDashboardWidgets, createDashboardPages, pageLayout, replacePageLayout, selectDashboardPage, moveDashboardWidget, placeDashboardWidget, reorderDashboardWidget, type DashboardPages } from "./domain/dashboard/pages";
import type { WidgetDragPosition } from "./components/PagedViewport";
import { loadDashboardPages, saveDashboardPages, parseDashboardPages, loadNamedPages, saveNamedPages } from "./services/dashboardPageStore";
import { isWindowVisible, startNativeWindowVisibility, subscribeWindowVisibility } from "./services/windowVisibility";

type ScreenMode = "main" | "dashboard";

const initialScreen: ScreenMode = window.location.pathname.endsWith("main.html") ? "main" : "dashboard";
const appStartedAt = new Date().toISOString();
const wallpaperStorageKey = "codex-desktop.wallpaper-profile.v1";
const dashboardIntentKey = "codex-desktop.dashboard-intent.v1";

function loadCachedWallpaper(): WallpaperProfile {
  try {
    const value = JSON.parse(localStorage.getItem(wallpaperStorageKey) ?? "null") as WallpaperProfile | null;
    if (value && (value.profile === "dark" || value.profile === "light" || value.profile === "unknown")) return value;
  } catch { /* Use the neutral preview profile. */ }
  return { path: null, luminance: null, profile: "unknown" };
}

function App() {
  useEffect(startNativeWindowVisibility, []);
  const [screen, setScreen] = useState<ScreenMode>(initialScreen);
  useEffect(()=>{document.documentElement.classList.toggle("workbench-console",screen==="dashboard");return()=>document.documentElement.classList.remove("workbench-console");},[screen]);
  useEffect(()=>{const nativeMain=isTauri()&&screen==="main";document.documentElement.classList.toggle("tauri-main-window",nativeMain);if(nativeMain)return startMainWindowHitRegionTracking();return()=>document.documentElement.classList.remove("tauri-main-window");},[screen]);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [activeMonitor, setActiveMonitor] = useState("secondary-preview");
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  useEffect(()=>{void syncSimulationMode(settings.simulationEnabled).catch(()=>logEvent("warn","simulation.native_sync_failed",{}));},[settings.simulationEnabled]);
  const passthroughEscape = useRef(() => {});
  const [wallpaperProfile, setWallpaperProfile] = useState<WallpaperProfile>(() => loadCachedWallpaper());
  const notifications = useNotificationCenter();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const hubStartupKey = useRef("");
  useEffect(() => {
    if (!isTauri() || screen !== "main" || settings.simulationEnabled || !settings.beszelAutoStartHub) {hubStartupKey.current="";return;}
    const key=JSON.stringify([settings.beszelUrl,settings.beszelHubExecutable,settings.beszelHubDataDirectory]);
    if(hubStartupKey.current===key)return;
    hubStartupKey.current=key;
    void invokeLive<string>("ensure_local_beszel_hub",{baseUrl:settings.beszelUrl,executable:settings.beszelHubExecutable,dataDirectory:settings.beszelHubDataDirectory})
      .then(message=>{if(hubStartupKey.current===key)logEvent("info","beszel.local_hub_startup",{message});})
      .catch(error=>{if(hubStartupKey.current===key)logEvent("warn","beszel.local_hub_startup",{message:typeof error==="string"?error:"本机 Hub 启动检查失败"});});
  },[screen,settings.simulationEnabled,settings.beszelAutoStartHub,settings.beszelUrl,settings.beszelHubExecutable,settings.beszelHubDataDirectory]);

  useEffect(() => {
    if (!isTauri()) document.documentElement.classList.add("browser-preview");
    return () => document.documentElement.classList.remove("browser-preview");
  }, []);

  useEffect(() => {
    logEvent("info", "app.started", { screen });
    let active = true;
    const syncMonitors = async (startup = false) => {
      try {
        const items = await readMonitors();
        if (!active) return;
        setMonitors(items);
        const secondary = items.find((monitor) => !monitor.isPrimary);
        setActiveMonitor((current) => secondary?.id ?? items[0]?.id ?? current ?? "preview");
        if (isTauri()) {
          if (startup && screen === "main") {
            await updateMainWindowHitRegions();
            await applyStartupPreferences({
              mode: settings.startupMode,
              showMain: settings.showMainOnStartup,
              showDashboard: settings.showDashboardOnStartup,
              desktopMode: settings.desktopMode,
            });
          } else {
            await restoreWindows();
          }
        }
        logEvent("info", "window.monitors_loaded", { count: items.length });
      } catch {
        if (active) { setMonitors([]); logEvent("warn", "window.monitors_failed"); }
      }
    };
    void syncMonitors(true);
    const onFocus = () => { void syncMonitors(false); };
    const onVisibility = () => { if (isWindowVisible()) void syncMonitors(false); };
    window.addEventListener("focus", onFocus);
    const unsubscribe = subscribeWindowVisibility(onVisibility);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const profile = settings.wallpaperMode === "auto" ? wallpaperProfile.profile : settings.wallpaperMode;
    const isLight = profile === "light";
    document.documentElement.style.setProperty("--glass-alpha", String(Math.max(settings.opacity / 100, isLight ? 0.92 : 0)));
    document.documentElement.style.setProperty("--hud-background-alpha", String(settings.hudBackgroundOpacity / 100));
    document.documentElement.style.setProperty("--glass-blur", Math.max(settings.blur, isLight ? 28 : 0) + "px");
    applyTheme(document.documentElement,settings.theme);
    document.documentElement.style.setProperty("--glass-border-opacity", String(settings.glassBorderOpacity/100));
    document.documentElement.style.setProperty("--glass-shadow-strength", String(settings.glassShadowStrength/100));
    document.documentElement.classList.toggle("reduce-motion", !settings.animations);
    document.documentElement.classList.toggle("wallpaper-light", isLight);
    document.documentElement.classList.toggle("wallpaper-dark", profile === "dark");
  }, [settings, wallpaperProfile]);

  useEffect(() => {
    if (!isTauri() || screen !== "main") return;
    let timer = 0;
    let active = true;
    const refresh = async () => {
      if (isWindowVisible()) {
        try {
          const profile = await readWallpaperProfile();
          if (!active) return;
          const previous = loadCachedWallpaper();
          setWallpaperProfile(profile);
          localStorage.setItem(wallpaperStorageKey, JSON.stringify(profile));
          if (previous.profile !== profile.profile) {
            logEvent("info", "wallpaper.profile_changed", { profile: profile.profile, luminance: profile.luminance });
          }
        } catch {
          logEvent("warn", "wallpaper.read_failed");
        }
      }
      if (active && isWindowVisible()) timer = window.setTimeout(refresh, 60_000);
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (isWindowVisible()) {
        void refresh();
      }
    };
    void refresh();
    const unsubscribe = subscribeWindowVisibility(onVisibility);
    return () => {
      active = false;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [screen]);

  useEffect(() => {
    if (!isTauri()) return;
    void setDesktopMode(settings.desktopMode).catch(() => logEvent("warn", "window.desktop_mode_failed"));
  }, [settings.desktopMode]);

  useEffect(() => {
    if (!isTauri()) return;
    void setMousePassthrough(settings.mousePassthrough).catch((error: unknown) => {
      logEvent("warn", "window.mouse_passthrough_failed");
      if (settings.mousePassthrough) {
        passthroughEscape.current();
        if (screen === "dashboard") window.alert(String(error));
      }
    });
  }, [settings.mousePassthrough]);

  useEffect(() => startPassthroughEscape(() => passthroughEscape.current()), []);

  useEffect(() => {
    const onPassthroughHotkey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.code === "Space" && settings.mousePassthrough) {
        event.preventDefault();
        updateSettings({ mousePassthrough: false });
      }
    };
    window.addEventListener("keydown", onPassthroughHotkey);
    return () => window.removeEventListener("keydown", onPassthroughHotkey);
  }, [settings.mousePassthrough]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "codex-desktop.settings.v1") setSettings(loadSettings());
      if (event.key === wallpaperStorageKey) setWallpaperProfile(loadCachedWallpaper());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const updateSettings = (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
    if(patch.simulationEnabled!==undefined)void syncSimulationMode(next.simulationEnabled).catch(()=>logEvent("warn","simulation.native_sync_failed",{}));
    if (patch.simulationEnabled !== undefined || patch.simulationScenario !== undefined) {
      void writeHistoryRecord(createHistoryRecord("widget_state", {
        event: "simulation.settings_changed",
        enabled: next.simulationEnabled,
        scenario: next.simulationScenario,
        note: "Developer Simulation only; no real service data is used.",
      }, "simulation.settings"));
    }
  };
  // The native listener stays installed; always apply to the latest settings.
  passthroughEscape.current = () => updateSettings({ mousePassthrough: false });

  const openDashboard = async (primary?: boolean) => {
    if (isTauri()) {
      try {
        await openDashboardWindow(primary);
        logEvent("info", "window.dashboard_opened", { monitorCount: monitors.length });
        return;
      } catch {
        // Keep the dashboard reachable in this window if native opening fails.
      }
    }
    const target=monitors.find(monitor=>primary?monitor.isPrimary:!monitor.isPrimary)??monitors.find(monitor=>monitor.isPrimary);
    setActiveMonitor(target?.id ?? "primary-preview");
    setScreen("dashboard");
    logEvent("info", "window.screen_changed", { screen: "dashboard" });
  };

  const returnToMain = async () => {
    if (isTauri()) {
      try {
        await showMainWindow();
        logEvent("info", "window.main_shown");
        return;
      } catch {
        // Fall back to the main-screen preview if the native window is unavailable.
      }
    }
    setScreen("main");
    logEvent("info", "window.screen_changed", { screen: "main" });
  };

  const openDashboardAt = (target: string) => {
    try { localStorage.setItem(dashboardIntentKey, JSON.stringify({ target, timestamp: Date.now() })); } catch { /* Dashboard still opens without a focus hint. */ }
    void openDashboard();
  };
  useEffect(()=>{
    if(screen!=="main")return;
    const forward=(event:Event)=>{const id=(event as CustomEvent<{id:string}>).detail?.id;if(["builtin-ollama","builtin-qwen","builtin-deepseek-local"].includes(id))openDashboardAt(`local-ai:${id}`);};
    window.addEventListener("codex-desktop.local-ai-request",forward);
    return()=>window.removeEventListener("codex-desktop.local-ai-request",forward);
  },[screen]);

  const content = screen === "main" ? (
      <MainScreen
        monitors={monitors}
        onDashboard={openDashboard}
        onDashboardScreen={(primary)=>void openDashboard(primary)}
        onDashboardAt={openDashboardAt}
        onSelectMonitor={setActiveMonitor}
        settings={settings}
        onSettingsChange={updateSettings}
      />
    ) : (
    <Dashboard
      settings={settings}
      wallpaperProfile={wallpaperProfile}
      onSettingsChange={updateSettings}
      monitors={monitors}
      activeMonitor={activeMonitor}
      onReturnMain={returnToMain}
      notificationOverlayVisible={notificationsOpen||notifications.toast.length>0}
      onOpenNotifications={() => setNotificationsOpen(true)}
    />
  );
  return <>{content}{screen==="dashboard"&&<LocalAIWindow />}<HistoryAnalysis showLauncher={false} simulationEnabled={settings.simulationEnabled} remoteSettings={settings.remoteAnalysis} /><NotificationCenter showLauncher={false} model={notifications} opened={notificationsOpen}
    onOpen={() => setNotificationsOpen(true)} onClose={() => setNotificationsOpen(false)}
    preferences={settings.notificationPreferences}
    onPreferencesChange={(notificationPreferences) => updateSettings({ notificationPreferences })} /></>;
}

function MainScreen({
  monitors,
  onDashboard,
  onDashboardScreen,
  onDashboardAt,
  onSelectMonitor,
  settings,
  onSettingsChange,
}: {
  monitors: MonitorInfo[];
  onDashboard: () => void;
  onDashboardScreen: (primary: boolean) => void;
  onDashboardAt: (target: string) => void;
  onSelectMonitor: (id: string) => void;
  settings: AppSettings;
  onSettingsChange: (patch: Partial<AppSettings>) => void;
}) {
  const mainProviderIds = ["agent-quotas", "api-balances", "vps-status", "system-health", "application-list"];
  const data = useProviderDashboardData(mainProviderIds, {
    url: settings.beszelUrl, systemId: settings.beszelSystemId, refreshIntervalSeconds: settings.beszelRefreshIntervalSeconds, credentialRevision: settings.beszelCredentialRevision ?? 0,
  }, !settings.simulationEnabled, settings.apiConnections);
  const simulationTick = useSimulationTick(settings.simulationEnabled, mainProviderIds);
  const displayData = useSimulatedDashboardData(data, settings.simulationEnabled, settings.simulationScenario, simulationTick);
  const animationManager = createWidgetAnimationManager(settings.animations);
  const [islandOpen, setIslandOpen] = useState(false);
  const [islandPanel, setIslandPanel] = useState<string>("codex");
  const [hudPinned,setHudPinned]=useState(false);
  const [workbenchScreens,setWorkbenchScreens]=useState({loading:false,hasSecondary:false,error:""});
  const openWorkbenchScreen=(primary:boolean)=>{setIslandOpen(false);setHudPinned(false);onDashboardScreen(primary)};
  const chooseWorkbenchScreen=async()=>{
    if(workbenchScreens.loading)return;
    if(islandOpen&&hudPinned&&islandPanel==="workbench"&&!workbenchScreens.error){setIslandOpen(false);setHudPinned(false);return}
    setIslandPanel("workbench");setHudPinned(true);setIslandOpen(true);
    setWorkbenchScreens({loading:true,hasSecondary:false,error:""});
    try{
      const current=await readMonitors();
      if(!current.length)throw new Error("未检测到屏幕");
      const hasSecondary=current.some(monitor=>!monitor.isPrimary);
      setWorkbenchScreens({loading:false,hasSecondary,error:""});
      if(!hasSecondary)openWorkbenchScreen(true);
    }catch{
      setWorkbenchScreens({loading:false,hasSecondary:false,error:"屏幕检测失败，请重试"});
    }
  };
  const [agentRuntime,setAgentRuntime]=useState(unavailableAgentRuntime);
  useEffect(()=>{
    if(!isTauri()||settings.simulationEnabled)return;let active=true,pending=false;
    const refresh=async()=>{if(!active||pending||!isWindowVisible())return;pending=true;try{const value=await readAgentRuntime();if(active)setAgentRuntime(value)}finally{pending=false}};
    void refresh();const timer=window.setInterval(()=>void refresh(),8000);const stop=subscribeWindowVisibility(()=>{if(isWindowVisible())void refresh()});
    return()=>{active=false;window.clearInterval(timer);stop()};
  },[settings.simulationEnabled]);
  const [codexActivity,setCodexActivity]=useState<{state:string;activeTasks:number;source:string}>({state:"unknown",activeTasks:0,source:"none"});
  useEffect(()=>{if(!isTauri()||settings.simulationEnabled)return;let active=true,pending=false;const refresh=async()=>{if(!active||pending||!isWindowVisible())return;pending=true;try{const value=await invoke<{state:string;activeTasks:number;source:string}>("read_codex_activity");if(active)setCodexActivity(value)}catch{if(active)setCodexActivity({state:"unknown",activeTasks:0,source:"read-failed"})}finally{pending=false}};void refresh();const timer=window.setInterval(()=>void refresh(),3000);return()=>{active=false;window.clearInterval(timer)}},[settings.simulationEnabled]);
  const [managerOpen, setManagerOpen] = useState(false);
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [applications, setApplications] = useApplications(setSelectedApp);
  const pinnedApps = applications.filter((app) => app.pinned).sort((left, right) => left.order - right.order);
  const apiProviders = displayData.providers.filter(provider => provider.kind === "api");
  const apiClock=useApiMoneyClock();
  const apiOverview=apiHudSummary(apiProviders,apiClock);
  const healthEvents = displayData.health.events ?? [];
  const healthReadable = displayData.health.state !== "offline" && (displayData.health.eventLogStatus === "ok" || displayData.health.eventLogStatus === "partial");
  const criticalHealth = healthEvents.some(event => event.severity === "critical");
  const errorHealth = healthEvents.some(event => event.severity === "error");
  const healthBadge = !healthReadable ? "" : criticalHealth ? "重大" : errorHealth ? "错误" : displayData.health.eventLogStatus === "partial" ? "部分" : healthEvents.length ? "警告" : "";
  const vpsDiagnostic = displayData.providerDiagnostics.find(provider => provider.providerId === "vps-status");
  const vpsState = displayData.vps.state ?? "unknown";
  const vpsHint = vpsDiagnostic?.status === "stale" ? "数据过期" : vpsState === "offline" ? "连接异常" : vpsDiagnostic?.status === "degraded" ? "数据降级" : displayData.vps.latency !== undefined ? `${Math.round(displayData.vps.latency)} ms` : "";
  const hudAgent=displayData.providers.find(provider=>provider.kind==="agent"&&provider.id===islandPanel);
  const hudClient=agentClients.find(client=>client.id===islandPanel);
  const runningClients=runningAgentClients(settings.simulationEnabled?{available:true,partial:false,observedAtUnixMs:Date.now(),clients:["codex","claude","antigravity"].map(id=>({id,processCount:1}))}:agentRuntime);
  const runningKey=runningClients.map(client=>client.id).join("|");
  useEffect(()=>{if(islandOpen&&agentClients.some(client=>client.id===islandPanel)&&!runningKey.split("|").includes(islandPanel)){setIslandOpen(false);setHudPinned(false)}},[runningKey,islandPanel,islandOpen]);
  const islandItems = [
    ...runningClients.map(client=>{
      const provider=displayData.providers.find(provider=>provider.kind==="agent"&&provider.id===client.id);const used=hudQuotaUsed(provider);
      const working=client.id==="codex"&&!settings.simulationEnabled&&codexActivity.state==="running";
      const activity=client.id!=="codex"?"已启动":codexActivity.state==="running"?`工作中 · ${codexActivity.activeTasks} 项`:codexActivity.state==="completed"?"已完成":codexActivity.state==="interrupted"?"已中断":codexActivity.state==="idle"?"空闲":"已启动";
      return {id:client.id,label:client.name,value:client.id==="ollama"?"本地服务":used===undefined?"额度未知":`已用 ${Math.round(used)}%`,meta:settings.simulationEnabled?"模拟数据":activity,badge:"",state:working?"working":used===undefined?"unknown":used>=90?"error":used>=70?"warning":"normal",progress:used,quota:client.id!=="ollama",detail:"",path:""};
    }),
    { id: "api" as const, ...apiOverview, badge: "", progress: undefined, quota: false, detail: "各账户按币种和口径分列", path: "m12 2 4 4-4 4-4-4zM2 12l4-4 4 4-4 4zm10 2 4 4-4 4-4-4zm2-2 4-4 4 4-4 4z" },
    { id: "vps" as const, label: "VPS 状态", value: vpsState === "online" || vpsState === "normal" ? "在线" : vpsState === "offline" ? "离线" : vpsState === "warning" ? "警告" : "未知", meta: vpsHint, badge: "", state: vpsState, progress: undefined, quota: false, detail: displayData.vps.error ?? displayData.vps.statusMessage ?? "", path: "M3 4h18v13H3zM8 21h8M12 17v4" },
    { id: "pc" as const, label: "本机 PC", value: healthReadable ? `${healthEvents.length} 条` : displayData.health.eventLogStatus === "error" || displayData.health.eventLogStatus === "unavailable" ? "不可用" : "未知", meta: "", badge: healthBadge, state: healthReadable ? criticalHealth || errorHealth ? "error" : healthBadge ? "warning" : "normal" : "unknown", progress: undefined, quota: false, detail: displayData.health.summary, path: "M3 4h18v13H3zM8 21h8M12 17v4" },
    { id: "daily" as const, label: "每日开源推荐", value: "每日最多 8 个", meta: "GitHub Trending", badge: "", state: "normal", progress: undefined, quota: false, detail: "", path: "" },
  ];
  const launchApp = async (application: ApplicationItem) => {
    if (!application.target.trim()) {
      setSelectedApp(`${application.name} · 先扫描或填写应用路径`);
      setManagerOpen(true);
      return;
    }
    try {
      const result = await activateOrLaunchApplication(application);
      setSelectedApp(`${application.name} · ${result.status === "activated" ? "已切换到运行中的窗口" : "已启动"}`);
      logEvent("info", "launcher.application_opened", { id: application.id, type: application.type, status: result.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : "应用启动失败";
      setSelectedApp(`${application.name} · ${message}`);
      logEvent("warn", "launcher.application_open_failed", { id: application.id, type: application.type });
    }
  };

  const openPanel = (id: string) => onDashboardAt(id);


  return (
    <main className="main-screen scenic">
      <div className="scenic-haze" />
      <header className="main-top">
        <StatusHud monitorId={monitors.find(monitor=>monitor.isPrimary)?.id??"primary"} open={islandOpen} animations={settings.animations} onDrag={()=>{setIslandOpen(false);setHudPinned(false)}} onLeave={()=>{if(!hudPinned)setIslandOpen(false)}}>
          <div className={`status-island hud-icon-row glass ${animationManager.classFor(islandOpen ? "expand" : "collapse")}`} style={animationManager.style()}>
            {islandItems.map(({id, label, value, meta, badge, state, progress, quota}) => (
              <button key={id} className={`island-item island-${id} is-${state}${hudPinned&&islandOpen&&islandPanel===id?" is-opened":""}`} aria-label={`打开${label}详情`} aria-expanded={islandOpen && islandPanel === id} onMouseEnter={()=>{if(!hudPinned){setIslandPanel(id);setIslandOpen(true)}}} onFocus={()=>{if(!hudPinned){setIslandPanel(id);setIslandOpen(true)}}} onClick={() => { const closeCurrent = hudPinned && islandOpen && islandPanel === id; setIslandPanel(id); setHudPinned(!closeCurrent); setIslandOpen(!closeCurrent); }}>
                <span className="island-symbol" aria-hidden="true"><HudLogo id={id} label={label} showQuota={quota} quotaUsed={progress}/></span>
                <span className="island-content">
                  <span className="island-metric-label">{label}</span>
                  <span className="island-value-row">{id === "vps" && state !== "unknown" && <i className="island-state-dot" aria-hidden="true"/>}<strong>{value}</strong>{meta && <small className="island-meta">{meta}</small>}{badge && <span className="island-alert-badge">{badge}</span>}</span>
                  {progress !== undefined && <span className="island-quota-track" role="progressbar" aria-label={`${label} 已用额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{width:`${progress}%`}}/></span>}
                </span>
              </button>
            ))}
            <HudWorkbenchButton expanded={islandOpen&&hudPinned&&islandPanel==="workbench"} busy={workbenchScreens.loading} onEnter={()=>{if(islandPanel!=="workbench"){setIslandOpen(false);setHudPinned(false);}}} onOpen={()=>void chooseWorkbenchScreen()}/>
          </div>
            <div className={`island-popover glass${hudPinned?"":" hud-peek"}${hudPinned&&islandPanel==="daily"?" hud-daily-panel":""}`} hidden={!islandOpen} data-main-hit-region>
              {!hudPinned&&<><strong className="popover-title">{islandItems.find(item=>item.id===islandPanel)?.label}</strong><p className="hud-source-note">{[islandItems.find(item=>item.id===islandPanel)?.value,islandItems.find(item=>item.id===islandPanel)?.meta].filter(Boolean).join(" · ")}</p></>}
              <DailyOpenSource connections={settings.apiConnections} enabled={!settings.simulationEnabled} presentation="hud" hidden={!islandOpen||!hudPinned||islandPanel!=="daily"} onClose={()=>{setIslandOpen(false);setHudPinned(false)}}/>
              {hudPinned&&islandPanel==="workbench"&&<><strong className="popover-title">打开工作台</strong>{workbenchScreens.loading?<p className="hud-source-note" role="status">正在检测屏幕…</p>:workbenchScreens.error?<><p className="hud-source-note" role="alert">{workbenchScreens.error}</p><button className="text-button" onClick={()=>void chooseWorkbenchScreen()}>重新检测</button></>:<div className="hud-screen-options"><button onClick={()=>openWorkbenchScreen(true)}>主屏</button>{workbenchScreens.hasSecondary&&<button onClick={()=>openWorkbenchScreen(false)}>副屏</button>}</div>}</>}
              <div hidden={!hudPinned||islandPanel==="daily"||islandPanel==="workbench"}>
              {(hudClient||hudAgent) && <><strong className="popover-title">{hudClient?.name??hudAgent?.name??"Agent"}</strong>{islandPanel==="ollama"?<div className="popover-row"><span>本地服务</span><strong>{displayData.localAI?.serviceStatus==="online"?"在线":displayData.localAI?.serviceStatus==="offline"?"离线":"未知"}</strong></div>:<HudQuotaDetails provider={hudAgent}/>} {hudAgent&&<button className="text-button" onClick={() => openPanel("codex")}>查看额度 →</button>}</>}
              {islandPanel === "api" && <><strong className="popover-title">API 账户</strong><div className="hud-api-accounts">{apiProviders.map(provider=><section className="hud-api-account" key={provider.id}><strong>{provider.name}</strong><ApiMoneyDetails api={provider} now={apiClock}/></section>)}</div><button className="text-button" onClick={() => openPanel("api")}>查看 API 面板 →</button></>}
              {islandPanel === "vps" && <><strong className="popover-title">VPS · {displayData.vps.name || "Beszel"}</strong><div className="popover-row"><span>连接状态</span><strong>{displayData.vps.state === "online" ? "在线" : displayData.vps.state === "offline" ? "离线" : displayData.vps.state === "warning" ? "警告" : "未知"}</strong></div><div className="popover-row"><span>延迟</span><strong>{displayData.vps.latency === undefined ? "—" : `${displayData.vps.latency} ms`}</strong></div><button className="text-button" onClick={() => openPanel("vps")}>打开 VPS 面板 →</button></>}
              {islandPanel === "pc" && <><strong className="popover-title">System Health</strong><div className="popover-row"><span>状态</span><strong>{displayData.health.summary || "等待扫描"}</strong></div><div className="popover-row"><span>近期重点事件</span><strong>{displayData.health.events?.length ?? 0} 条</strong></div><button className="text-button" onClick={() => openPanel("health")}>查看系统健康 →</button></>}
              <button className="text-button island-mode-toggle" onClick={() => { onSettingsChange({ desktopMode: !settings.desktopMode }); setIslandOpen(false); }}>{settings.desktopMode ? "切到交互模式" : "切到桌面模式"}</button>
              <label className="passthrough-toggle"><input type="checkbox" checked={settings.mousePassthrough} onChange={(event) => onSettingsChange({ mousePassthrough: event.target.checked })} /> 鼠标穿透 <kbd>Ctrl Shift Space 退出</kbd></label>
              </div>
            </div>
        </StatusHud>
      </header>

      {!isTauri() && displayData.metrics.length > 0 && <aside className="resource-rail glass" aria-label="系统资源">
        {displayData.metrics.slice(0, 3).map((metric) => (
          <div className="rail-metric" key={metric.id}>
            <span>{metric.name}</span><strong>{metric.value}%</strong>
            <i><b style={{ width: Math.max(metric.value, 4) + "%" }} /></i>
          </div>
        ))}
      </aside>}



      <div className="main-center-hint">
        {selectedApp ? <span role="status">{selectedApp}</span> : null}
      </div>

      {!isTauri() && <footer className="main-footer">
        <div className="monitor-switch glass" aria-label="预览屏幕">
          {monitors.map((monitor, index) => (
            <button
              key={monitor.id}
              className={monitor.isPrimary ? "selected" : ""}
              onClick={() => {
                onSelectMonitor(monitor.id);
                if (!monitor.isPrimary) onDashboard();
              }}
            >
              {monitor.isPrimary ? "主屏" : (monitor.name || "屏幕 " + (index + 1))}
            </button>
          ))}
        </div>
        <ApplicationDock applications={pinnedApps} onLaunch={(application) => void launchApp(application)} onManage={() => setManagerOpen((open) => !open)} onApplicationsChange={setApplications} />
      </footer>}

      <div className="main-hint">桌面氛围预览 · 毛玻璃 {settings.opacity}%</div>
      {managerOpen && <div className="application-manager-overlay glass" aria-label="应用管理面板" data-main-hit-region><div className="settings-title"><div><strong>应用管理</strong><small>统一管理 Dock 与搜索的应用入口</small></div><button className="ui-icon-button" onClick={() => setManagerOpen(false)} aria-label="关闭应用管理"><CloseIcon/></button></div><ApplicationManager applications={applications} onApplicationsChange={setApplications} /></div>}
    </main>
  );
}

function Dashboard({
  settings,
  wallpaperProfile,
  onSettingsChange,
  monitors,
  activeMonitor,
  onReturnMain,
  onOpenNotifications,
  notificationOverlayVisible,
}: {
  settings: AppSettings;
  wallpaperProfile: WallpaperProfile;
  onSettingsChange: (patch: Partial<AppSettings>) => void;
  monitors: MonitorInfo[];
  activeMonitor: string;
  onReturnMain: () => void;
  onOpenNotifications: () => void;
  notificationOverlayVisible: boolean;
}) {
  const [editingEnabled, setEditing] = useState(false);
  const [pageManagerOpen,setPageManagerOpen]=useState(false);
  const [workspaceSelection,setWorkspaceSelection]=useState(()=>{try{return sessionStorage.getItem("codex-desktop.workspace-selection")||"mues";}catch{return "mues";}});
  const [openAppRequest,setOpenAppRequest]=useState<{id:string;nonce:number}>();
  const [openUrlRequest,setOpenUrlRequest]=useState<{url:string;name:string;nonce:number}>();
  const [resourceView,setResourceView]=useState<'pc'|'vps'>('pc');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [personalAvatarOpen,setPersonalAvatarOpen]=useState(false);
  const [settingsModule, setSettingsModule] = useState<SettingsModuleId>("appearance");
  useEffect(()=>{const open=()=>{setSettingsModule("agents");setSettingsOpen(true);};window.addEventListener("codex-desktop.open-agent-connections",open);return()=>window.removeEventListener("codex-desktop.open-agent-connections",open);},[]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [openToolRequest,setOpenToolRequest]=useState<{id:string;nonce:number}>();
  useEffect(()=>{if(settingsOpen||searchOpen||notificationOverlayVisible)setPageManagerOpen(false);},[settingsOpen,searchOpen,notificationOverlayVisible]);
  const currentMonitor = monitors.find((monitor) => monitor.id === activeMonitor) ?? {
    id: activeMonitor, name: "预览显示器", x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1, isPrimary: false,
  };
  const [pageDocument, setPageDocument] = useState<DashboardPages>(() => loadDashboardPages(currentMonitor,loadLayout(currentMonitor)));
  const currentPage=activeDashboardPage(pageDocument);
  const editing=editingEnabled&&currentPage.kind==="custom";
  const navigationItems=dashboardNavigationItems(pageDocument,workspaceSelection,resourceView);
  const editablePages=pageDocument.pages.filter(page=>page.kind==="custom"&&!page.hidden);
  const layout=pageLayout(pageDocument,currentMonitor);
  const changePages=(next:DashboardPages)=>{try{saveDashboardPages(next);setPageDocument(next);}catch(error){setToast(error instanceof Error?error.message:"页面配置保存失败");}};
  const setLayout=(next:LayoutDocument)=>{try{changePages(replacePageLayout(pageDocument,currentPage.id,next));}catch(error){setToast(error instanceof Error?error.message:"布局无法保存");}};
  const selectPage=(id:string)=>{setEditing(false);changePages(selectDashboardPage(pageDocument,id));};
  const stepPage=(direction:number)=>{const next=adjacentDashboardPage(pageDocument,direction);if(next.id==="resources")setResourceView("pc");selectPage(next.id);};
  const selectWorkbenchPage=(id:string)=>{setPageManagerOpen(false);setEditing(false);if(id==="vps"||id==="resources"){setResourceView(id==="vps"?"vps":"pc");selectPage("resources");}else if(pageDocument.pages.some(page=>page.id===id))selectPage(id);else openWebTool(id);};
  const viewportPageId=currentPage.id==="resources"?`resources:${resourceView}`:currentPage.id;
  const viewportPageIds=pageDocument.pages.filter(page=>!page.hidden).flatMap(page=>page.id==="resources"?["resources:pc","resources:vps"]:[page.id]);
  const [savedLayouts, setSavedLayouts] = useState<NamedLayout[]>(() => loadNamedLayouts(currentMonitor.id));
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragPosition,setDragPosition]=useState<WidgetDragPosition|null>(null);

  const [toast, setToast] = useState("");
  const moveWorkbench = async (primary: boolean) => {
    try {
      await openDashboardWindow(primary);
      setToast(isTauri() ? `工作台已移到${primary ? "主屏" : "副屏"}` : `桌面版会将完整工作台移到${primary ? "主屏" : "副屏"}`);
    } catch { setToast("无法移动工作台，请重试"); }
  };
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [checkingWindowRefresh, setCheckingWindowRefresh] = useState(false);
  const [diagnostics, setDiagnostics] = useState<{
    appVersion: string;
    tauriVersion: string;
    rustStatus: string;
    historyCounts: Record<HistoryKind, number>;
    lastError: string;
    refreshedAt: string;
    requestMetrics: RequestDiagnosticsSnapshot | null;
  } | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const lastHistoryTick = useRef(0);
  const [beszelToken, setBeszelToken] = useState("");
  const [beszelTokenConfigured, setBeszelTokenConfigured] = useState(false);
  const [beszelTokenJwtFormat, setBeszelTokenJwtFormat] = useState<boolean | null>(null);
  const [beszelLoginIdentity, setBeszelLoginIdentity] = useState("");
  const [beszelLoginPassword, setBeszelLoginPassword] = useState("");
  const [beszelConnecting, setBeszelConnecting] = useState(false);
  const [beszelMessage, setBeszelMessage] = useState("");
  const [beszelTesting, setBeszelTesting] = useState(false);
  const [beszelDraft, setBeszelDraft] = useState(() => ({ url: settings.beszelUrl, systemId: settings.beszelSystemId, refreshIntervalSeconds: settings.beszelRefreshIntervalSeconds }));
  const [beszelHubDraft,setBeszelHubDraft]=useState(()=>({enabled:settings.beszelAutoStartHub,executable:settings.beszelHubExecutable,dataDirectory:settings.beszelHubDataDirectory}));
  const [beszelHubMessage,setBeszelHubMessage]=useState("");
  useEffect(()=>{setBeszelHubDraft({enabled:settings.beszelAutoStartHub,executable:settings.beszelHubExecutable,dataDirectory:settings.beszelHubDataDirectory});},[settings.beszelAutoStartHub,settings.beszelHubExecutable,settings.beszelHubDataDirectory]);
  useEffect(()=>{if(!settingsOpen||settingsModule!=="beszel")return;const refresh=()=>{const entry=readRecentLogs().reverse().find(row=>row.event==="beszel.local_hub_startup");setBeszelHubMessage(typeof entry?.details?.message==="string"?entry.details.message:"");};refresh();window.addEventListener("storage",refresh);return()=>window.removeEventListener("storage",refresh);},[settingsOpen,settingsModule]);
  const [applications, setApplications] = useApplications(setToast);
  const [searchSites,setSearchSites]=useState(loadWebApps);
  useEffect(()=>subscribeWebApps(()=>setSearchSites(loadWebApps())),[]);
  const searchItems=useMemo(()=>buildWorkbenchSearchItems(pageDocument,applications,searchSites),[pageDocument,applications,searchSites]);

  useEffect(() => {
    setPageDocument(loadDashboardPages(currentMonitor,loadLayout(currentMonitor)));
    setSavedLayouts(loadNamedLayouts(currentMonitor.id));
  }, [activeMonitor, currentMonitor.width, currentMonitor.height, currentMonitor.scaleFactor]);
  useEffect(() => {
    const applyIntent = () => {
      try {
        const raw = localStorage.getItem(dashboardIntentKey);
        if (!raw) return;
        const intent = JSON.parse(raw) as { target?: string; timestamp?: number };
        if (!intent.timestamp || Date.now() - intent.timestamp > 30_000) { localStorage.removeItem(dashboardIntentKey); return; }
        localStorage.removeItem(dashboardIntentKey);
        if (intent.target === "settings") {
          setSettingsModule("applications");
          setSettingsOpen(true);
        }
        else if(intent.target==="profile-avatar") {setPersonalAvatarOpen(true);}
        else if(intent.target?.startsWith("local-ai:")) {
          window.setTimeout(()=>window.dispatchEvent(new CustomEvent("codex-desktop.local-ai-request",{detail:{id:intent.target!.slice(9)}})),200);
        }
        else if(intent.target==="vps") {
          setResourceView("vps");setEditing(false);
          setPageDocument(document=>{const next={...document,activePageId:"resources",pages:document.pages.map(page=>page.id==="resources"?{...page,hidden:false}:page)};saveDashboardPages(next);return next;});
        }
        else if (["codex", "api", "vps", "health"].includes(intent.target ?? "")) {
          const widgetId = intent.target === "vps" ? "vps" : intent.target === "health" ? "health" : intent.target;
          setPageDocument(document=>{const page=document.pages.find(page=>page.widgets.some(widget=>widget.id===widgetId&&!widget.hidden));if(!page)return document;const next={...document,activePageId:page.id,pages:document.pages.map(item=>item.id===page.id?{...item,hidden:false}:item)};saveDashboardPages(next);return next;});
        }
      } catch { localStorage.removeItem(dashboardIntentKey); }
    };
    const onStorage = (event: StorageEvent) => { if (event.key === dashboardIntentKey) applyIntent(); };
    window.addEventListener("storage", onStorage);
    applyIntent();
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const placements = layout.widgets;
  const preset = layout.mode;
  const visiblePlacements = useMemo(
    () => placements.filter(placement=>!placement.hidden).filter(placement=>currentPage.kind!=="resources"||editing||(resourceView==="pc"?placement.id!=="resources":placement.id==="resources")).map(placement=>currentPage.kind==="resources"&&!editing&&resourceView==="vps"?{...placement,x:0,y:0,width:12 as const,height:3 as const}:placement),
    [placements,currentPage.kind,resourceView,editing],
  );
  const providerIds = useMemo(() => currentPage.kind==="overview"&&!editing?["agent-quotas","api-balances","system-health","vps-status"]:currentPage.kind==="resources"&&!editing?[resourceView==="pc"?"hardware-status":"vps-status"]:[...new Set(visiblePlacements.flatMap((placement) => {
    const providerId = widgetRegistry.find((widget) => widget.id === placement.id)?.dataProvider;
    return providerId ? placement.id === "resources" && currentPage.kind === "overview" ? [providerId,"hardware-status"] : [providerId] : [];
  }))].sort(), [visiblePlacements,currentPage.kind,editing,resourceView]);
  const data = useProviderDashboardData(providerIds, {
    url: settings.beszelUrl, systemId: settings.beszelSystemId, refreshIntervalSeconds: settings.beszelRefreshIntervalSeconds, credentialRevision: settings.beszelCredentialRevision ?? 0,
  }, !settings.simulationEnabled, settings.apiConnections);
  const simulationTick = useSimulationTick(settings.simulationEnabled, providerIds);
  const displayData = useSimulatedDashboardData(data, settings.simulationEnabled, settings.simulationScenario, simulationTick);
  const animationManager = useMemo(() => createWidgetAnimationManager(settings.animations), [settings.animations]);

  useEffect(() => {
    if (!settings.simulationEnabled || simulationTick < 1 || simulationTick % 20 !== 0 || simulationTick === lastHistoryTick.current) return;
    lastHistoryTick.current = simulationTick;
    void writeHistoryRecord(createHistoryRecord("usage_history", {
      simulation: true,
      scenario: settings.simulationScenario,
      providers: displayData.providers.map(({ id, percentage, balance, todayCost, state }) => ({ id, percentage, balance, todayCost, state })),
      vps: { state: displayData.vps.state, gauges: displayData.vps.gauges },
      health: { state: displayData.health.state, summary: displayData.health.summary },
    }));
    void writeHistoryRecord(createHistoryRecord("provider_history", {
      simulation: true,
      providers: displayData.providers.map(({ id, state, percentage, balance }) => ({ id, state, percentage, balance })),
    }));
  }, [settings.simulationEnabled, settings.simulationScenario, simulationTick, displayData]);

  useEffect(() => {
    if (!settings.simulationEnabled || simulationTick < 1 || simulationTick % 10 !== 0) return;
    const phase = displayData.health.state === "offline" ? "error" : "refresh";
    document.querySelectorAll<HTMLElement>(".widget-shell").forEach((element) => animationManager.play(element, phase));
  }, [settings.simulationEnabled, simulationTick, displayData.health.state, animationManager]);

  const updatePlacement = (id: string, update: Partial<WidgetPlacement>) => {
    persistLayout({ ...layout, widgets: placements.map((item) => item.id === id ? { ...item, ...update } as WidgetPlacement : item) });
  };

  const persist = () => {
    saveDashboardPages(pageDocument);
    setEditing(false);
    setToast("布局已保存到此显示器");
  };

  const resetLayout = () => {
    changePages(createDashboardPages(currentMonitor,loadLayout(currentMonitor)));
    setToast("已恢复默认布局");
  };

  const setPresetLayout = (value: LayoutPreset) => {
    persistLayout({ ...layout, mode:value, widgets:layout.widgets.map(widget=>({...widget,width:value==="minimal"?Math.min(12,Math.max(3,widget.width)) as WidgetPlacement["width"]:widget.width})) });
  };

  const reorder = (targetId: string, sourceId = dragging) => {
    if (!sourceId || sourceId === targetId) return;
    const next=reorderDashboardWidget(pageDocument,currentPage.id,sourceId,targetId);
    if(next===pageDocument)return;
    persistLayout({ ...layout, widgets:next.pages.find(page=>page.id===currentPage.id)?.widgets??placements });
    setDragging(null);
  };

  const persistLayout = (next: LayoutDocument) => {
    setLayout(next);
    // Legacy layout keys remain untouched; page layouts are stored separately.
    void writeHistoryRecord(createHistoryRecord("widget_state", next, `layout:${next.monitorId}`));
  };

  const saveCurrentLayout = () => {
    saveDashboardPages(pageDocument);
    setToast("当前布局已保存");
  };

  const saveLayoutAs = () => {
    const name = window.prompt("给当前显示器布局起个名字", layout.mode === "standard" ? "我的布局" : presetLabel(layout.mode));
    if (!name?.trim()) return;
    saveNamedPages(currentMonitor.id+':'+name.trim(),pageDocument);
    setSavedLayouts(saveNamedLayout(name, layout));
    setToast(`已另存布局：${name.trim()}`);
  };

  const applySavedLayout = (name: string) => {
    const pages=parseDashboardPages(loadNamedPages()[currentMonitor.id+':'+name],currentMonitor,loadLayout(currentMonitor));
    if(pages){changePages(pages);setToast(`已应用分页布局：${name}`);return;}
    const saved = savedLayouts.find((item) => item.name === name);
    if (!saved) return;
    const next = {
      ...saved.document,
      monitorId: currentMonitor.id,
      resolution: `${currentMonitor.width}x${currentMonitor.height}`,
      scaleFactor: currentMonitor.scaleFactor,
      updatedAt: new Date().toISOString(),
    };
    persistLayout(next);
    setToast(`已应用布局：${name}`);
  };

  const refreshDiagnostics = async () => {
    const [appVersion, tauriVersion, rustStatus, requestMetrics, ...history] = await Promise.all([
      isTauri() ? getVersion().catch(() => "未知") : Promise.resolve("0.1.1 · 预览"),
      isTauri() ? getTauriVersion().catch(() => "未知") : Promise.resolve("浏览器预览"),
      readRuntimeStatus().catch(() => "Rust 后端不可用"),
      readProviderRequestDiagnostics().catch(() => null),
      ...(["provider_history", "widget_state", "system_events", "usage_history", "vps_history", "hardware_history", "application_history", "notifications_history"] as const).map((kind) => countHistoryRecords(kind)),
    ]);
    const lastError = [...readRecentLogs()].reverse().find((entry) => entry.level === "error");
    setDiagnostics({
      appVersion,
      tauriVersion,
      rustStatus,
      requestMetrics,
      historyCounts: {
        provider_history: history[0] ?? 0,
        widget_state: history[1] ?? 0,
        system_events: history[2] ?? 0,
        usage_history: history[3] ?? 0,
        vps_history: history[4] ?? 0,
        hardware_history: history[5] ?? 0,
        application_history: history[6] ?? 0,
        notifications_history: history[7] ?? 0,
      },
      lastError: lastError ? `${lastError.event} · ${new Date(lastError.at).toLocaleString("zh-CN")}` : "无错误记录",
      refreshedAt: new Date().toLocaleTimeString("zh-CN"),
    });
  };

  const launchFromDashboard = async (application: ApplicationItem) => {
    try {
      const result = await activateOrLaunchApplication(application);
      setToast(`${application.name} · ${result.status === "activated" ? "已切换到运行中的窗口" : "已启动"}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "应用启动失败");
    }
  };

  const checkWindowRefresh = async (scope: "dashboard" | "both") => {
    if (checkingWindowRefresh) return;
    setCheckingWindowRefresh(true);
    try {
      await invoke("check_hidden_window_refresh", { scope });
      await refreshDiagnostics();
      setToast("窗口已恢复，可展开最近读取与显隐时间核对");
    } catch (error) { setToast(typeof error === "string" ? error : "显隐检查无法执行"); }
    finally { setCheckingWindowRefresh(false); }
  };

  const openWebAppsManager=()=>{setSettingsModule("webapps");setSettingsOpen(true);};
  const openWebTool=(id:string)=>{setOpenUrlRequest(undefined);setOpenAppRequest({id,nonce:Date.now()});selectPage("workspace");};
  const openServicePanel=(url:string,name:string)=>{setOpenUrlRequest({url:webAppUrl(url),name:name.slice(0,60),nonce:Date.now()});setOpenAppRequest(undefined);selectPage("workspace");};
  const openApplicationsManager = () => {
    setSettingsModule("applications");
    setSettingsOpen(true);
  };
  const openSearchResult=(item:WorkbenchSearchItem)=>{
    const {kind,id}=item.target;
    if(kind==="page")selectWorkbenchPage(id);
    else if(kind==="tool"){setOpenToolRequest({id,nonce:Date.now()});selectPage("toolbox");}
    else if(kind==="application"){
      const application=applications.find(app=>app.id===id);
      if(!application)setToast("应用入口已变更，请重新搜索");
      else if(!application.target.trim())openApplicationsManager();
      else void launchFromDashboard(application);
    }else if(kind==="webapp")openWebTool(id);
    else if(kind==="preset"){
      try{const current=loadWebApps(),next=configureToolboxPreset(current,id);if(next.apps!==current)saveWebApps(next.apps);openWebTool(next.id);}
      catch(error){setToast(error instanceof Error?error.message:"无法打开工具网站");}
    }
  };

  useEffect(() => {
    if (diagnosticsOpen) void refreshDiagnostics();
  }, [diagnosticsOpen]);

  useEffect(() => {
    if (!settingsOpen || settingsModule !== "beszel") {
      setBeszelLoginPassword("");
      setBeszelToken("");
      return;
    }
    if (!isTauri()) return;
    let active = true;
    void invoke<{ configured: boolean; jwtFormat: boolean }>("inspect_beszel_token").then((status) => {
      if (active) { setBeszelTokenConfigured(status.configured); setBeszelTokenJwtFormat(status.configured ? status.jwtFormat : null); }
    }).catch(() => { if (active) { setBeszelTokenJwtFormat(null); setBeszelMessage("无法检查已保存的令牌状态"); } });
    return () => { active = false; };
  }, [settingsOpen, settingsModule]);
  useEffect(() => subscribeWindowVisibility(() => { if (!isWindowVisible()) setBeszelLoginPassword(""); }), []);
  useEffect(() => {
    setBeszelDraft({ url: settings.beszelUrl, systemId: settings.beszelSystemId, refreshIntervalSeconds: settings.beszelRefreshIntervalSeconds });
  }, [settings.beszelUrl, settings.beszelSystemId, settings.beszelRefreshIntervalSeconds]);

  const saveBeszelToken = async () => {
    if (!beszelToken.trim()) { setBeszelMessage("请输入 Beszel PocketBase API 令牌"); return; }
    try {
      await invoke("save_beszel_token", { token: beszelToken });
      setBeszelToken("");
      setBeszelTokenConfigured(true);
      setBeszelTokenJwtFormat(true);
      onSettingsChange({ beszelCredentialRevision: Date.now() });
      setBeszelMessage("令牌已保存在 Windows Credential Manager");
      logEvent("info", "beszel.credential_saved");
    } catch (error) {
      setBeszelMessage(typeof error === "string" ? error : "令牌保存失败");
    }
  };

  const connectBeszelAccount = async () => {
    if (beszelConnecting || !beszelLoginIdentity.trim() || !beszelLoginPassword || !beszelDraft.url.trim()) return;
    const password=beszelLoginPassword; setBeszelLoginPassword(""); setBeszelConnecting(true); setBeszelMessage("正在连接 Hub 账户…");
    try {
      await invoke("connect_beszel_account", { baseUrl:beszelDraft.url.trim(), identity:beszelLoginIdentity.trim(), password });
      setBeszelTokenConfigured(true); setBeszelTokenJwtFormat(true);
      onSettingsChange({beszelUrl:beszelDraft.url.trim(),beszelSystemId:beszelDraft.systemId.trim(),beszelRefreshIntervalSeconds:Math.max(10,Math.min(300,Math.round(beszelDraft.refreshIntervalSeconds||30))),beszelCredentialRevision:Date.now()});
      setBeszelMessage("账户已连接，读取令牌已安全保存。可以测试系统连接。");
      logEvent("info","beszel.account_connected");
    } catch (error) { setBeszelMessage(typeof error === "string" ? error.slice(0,180) : "Hub 账户连接失败"); }
    finally { setBeszelConnecting(false); }
  };

  const clearBeszelToken = async () => {
    try {
      await invoke("clear_beszel_token");
      setBeszelTokenConfigured(false);
      setBeszelTokenJwtFormat(null);
      onSettingsChange({ beszelCredentialRevision: Date.now() });
      setBeszelMessage("已删除保存的令牌");
    } catch (error) {
      setBeszelMessage(typeof error === "string" ? error : "令牌删除失败");
    }
  };

  const runBeszelConnectionTest = async () => {
    setBeszelTesting(true);
    setBeszelMessage("正在连接 Beszel Hub…");
    try {
      const result = await testBeszelConnection(beszelDraft);
      const source=beszelProviderResult(observationFromNative(result),true,Date.now(),Math.max(10,Math.min(300,beszelDraft.refreshIntervalSeconds||30))*1000);
      const statusMessage = source.error??(result.state === "online" ? "在线" : result.state === "offline" ? "离线" : "状态未知");
      setBeszelMessage(`连接成功 · ${result.name} · ${statusMessage}`);
      logEvent("info", "beszel.connection_test_succeeded", { systemId: beszelDraft.systemId });
    } catch (error) {
      const message = typeof error === "string" ? error : error instanceof Error ? error.message : "连接失败";
      setBeszelMessage(message.slice(0, 180));
      logEvent("warn", "beszel.connection_test_failed", { systemId: beszelDraft.systemId });
    } finally {
      setBeszelTesting(false);
    }
  };

  const exportLayout = () => {
    const blob = new Blob([JSON.stringify(pageDocument, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `codex-desktop-layout-${activeMonitor}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    logEvent("info", "layout.exported", { monitorId: activeMonitor });
  };

  const importLayout = async (file?: File) => {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const pages=parseDashboardPages(parsed,currentMonitor,loadLayout(currentMonitor));
      if(pages){changePages(pages);setToast("已导入分页布局");return;}
      const imported = parseLayoutImport(parsed, currentMonitor);
      if (!imported) throw new Error("invalid layout document");
      changePages(createDashboardPages(currentMonitor,imported));
      setToast("布局已导入并应用到当前显示器");
      logEvent("info", "layout.imported", { monitorId: activeMonitor });
    } catch {
      setToast("布局文件无效，未应用更改");
      logEvent("warn", "layout.import_failed", { monitorId: activeMonitor });
    }
  };

  const moveWidget = (id: string, offset: number) => {
    const from = placements.findIndex((item) => item.id === id);
    const to = Math.max(0, Math.min(placements.length - 1, from + offset));
    if (from < 0 || from === to) return;
    const next = [...placements];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    persistLayout({ ...layout, widgets: next });
  };

  return (
    <main className="dashboard-screen scenic paged-dashboard avatar-dashboard workbench-dashboard">
      <WorkbenchRail blocked={Boolean(dragging)||settingsOpen||searchOpen||pageManagerOpen||personalAvatarOpen} items={navigationItems} onSelect={selectWorkbenchPage} onSettings={()=>setSettingsOpen(true)} onSearch={()=>setSearchOpen(true)} onAdd={()=>setPageManagerOpen(true)} onAvatar={()=>setPersonalAvatarOpen(true)}/>
      <header className="workbench-window-actions" aria-label="工作台窗口">
        <button className="ui-icon-button" type="button" aria-label="隐藏工作台" onClick={onReturnMain}><span className="workbench-hide-dot" aria-hidden="true"><CloseIcon/></span></button>
      </header>
      {personalAvatarOpen&&<PersonalAvatarDialog displayName={settings.displayName} onSaveName={displayName=>onSettingsChange({displayName})} onClose={()=>setPersonalAvatarOpen(false)}/>}
      <div className="dashboard-glow" />
      {pageManagerOpen&&<DashboardPageManager onClose={()=>setPageManagerOpen(false)}>
        <DashboardPageControls document={pageDocument} items={navigationItems} onSelect={selectWorkbenchPage} onChange={next=>{changePages(next);if(next.pages.length>pageDocument.pages.length){setEditing(true);setPageManagerOpen(false);}}}/>
        {currentPage.kind==="custom"&&<div className="avatar-console-actions">
          <button className={"action-button "+(editing?"active":"")} onClick={()=>{if(editing)persist();else setEditing(true);setPageManagerOpen(false);}}>{editing?"完成编辑":"编辑组件布局"}</button>
        </div>}
      {editing && <div className="dashboard-toolbar">
        <div className="toolbar-controls">
          {editing && (
            <>
              {supportsDashboardWidgets(currentPage) && <select aria-label="添加组件" defaultValue="" onChange={(event) => {
                const id = event.target.value;
                if (!id) return;
                if(placements.some(item=>item.id===id))updatePlacement(id,{hidden:false});
                else {const definition=widgetRegistry.find(item=>item.id===id);if(definition)persistLayout({...layout,widgets:[...placements,{...definition.defaultPlacement,hidden:false}]});}
                event.currentTarget.value = "";
              }}>
                <option value="">添加组件</option>
                {widgetRegistry.filter(item=>!placements.some(placement=>placement.id===item.id&&!placement.hidden)).map((item) => (
                  <option key={item.id} value={item.id}>{widgetRegistry.find((widget) => widget.id === item.id)?.title ?? item.id}</option>
                ))}
              </select>}

            </>
          )}
        </div>
      </div>}

      {editing && <div className="edit-instructions">抓住卡片标题或 ⠿ 拖动手柄移动；靠近页面边缘停留可移到其他自定义组件页</div>}
        <div className="settings-actions"><button onClick={()=>void moveWorkbench(true)}>移到主屏</button><button disabled={!monitors.some(monitor=>!monitor.isPrimary)} onClick={()=>void moveWorkbench(false)}>移到副屏</button><button onClick={onReturnMain}>返回桌面</button></div>
        <small className="avatar-console-hint">{navigationItems.find(item=>item.active)?.label??currentPage.name} · Esc 关闭</small>
      </DashboardPageManager>}

      {searchOpen&&<WorkbenchSearch items={searchItems} onSelect={openSearchResult} onClose={()=>setSearchOpen(false)}/>}

      {settingsOpen && (
        <SettingsDialog selected={settingsModule} onSelect={(id) => { setSettingsModule(id); if (id === "diagnostics") setDiagnosticsOpen(true); }} onClose={() => setSettingsOpen(false)} pages={{
          appearance: (
          <div className="settings-section">
            <fieldset className="settings-theme-picker"><legend>主题颜色</legend><div>{appThemes.map(theme=><button type="button" key={theme.id} aria-pressed={settings.theme===theme.id} onClick={()=>onSettingsChange({theme:theme.id})}><i aria-hidden="true" style={{background:theme.surface,color:theme.text,borderColor:theme.accent}}><b style={{background:theme.accent}}/><span>Aa</span></i><span>{theme.name}</span></button>)}</div></fieldset>
            <label>卡片透明度 <strong>{settings.opacity}%</strong><input type="range" min="55" max="96" value={settings.opacity} onChange={(event) => onSettingsChange({ opacity: Number(event.target.value) })} /></label>
            <div className="settings-hud-opacity">
              <div className="settings-hud-opacity-heading"><label htmlFor="hud-background-opacity">主屏状态条背景</label><strong>{settings.hudBackgroundOpacity}%</strong><button type="button" onClick={() => onSettingsChange({ hudBackgroundOpacity: defaultSettings.hudBackgroundOpacity })}>恢复默认</button></div>
              <div className="settings-hud-opacity-control"><span>更透</span><input id="hud-background-opacity" type="range" min="45" max="95" step="1" value={settings.hudBackgroundOpacity} aria-valuetext={`背景浓度 ${settings.hudBackgroundOpacity}%`} onChange={(event) => onSettingsChange({ hudBackgroundOpacity: Number(event.target.value) })}/><span>更实</span></div>
            </div>
            <label>毛玻璃强度 <strong>{settings.blur}px</strong><input type="range" min="0" max="36" value={settings.blur} onChange={(event) => onSettingsChange({ blur: Number(event.target.value) })} /></label>
            <label>玻璃边框 <strong>{settings.glassBorderOpacity}%</strong><input type="range" min="0" max="45" value={settings.glassBorderOpacity} onChange={(event) => onSettingsChange({ glassBorderOpacity:Number(event.target.value) })} /></label>
            <label>玻璃阴影 <strong>{settings.glassShadowStrength}%</strong><input type="range" min="0" max="100" value={settings.glassShadowStrength} onChange={(event) => onSettingsChange({ glassShadowStrength:Number(event.target.value) })} /></label>
            <label className="settings-toggle">界面动画<input type="checkbox" checked={settings.animations} onChange={(event) => onSettingsChange({ animations: event.target.checked })} /></label>
            <label>壁纸适配<select value={settings.wallpaperMode} onChange={(event) => onSettingsChange({ wallpaperMode: event.target.value as AppSettings["wallpaperMode"] })}><option value="auto">自动识别亮度</option><option value="dark">深色壁纸</option><option value="light">浅色壁纸</option></select></label>
            <small>{settings.wallpaperMode === "auto" ? `当前识别：${wallpaperProfile.profile === "unknown" ? "等待检测" : wallpaperProfile.profile === "dark" ? "深色" : "浅色"}${wallpaperProfile.luminance === null ? "" : ` · 亮度 ${(wallpaperProfile.luminance * 100).toFixed(0)}%`}` : "使用所选壁纸对比度配置"}</small>
          </div>),
          layout: (<div className="settings-section"><strong>当前显示器布局</strong>
            <div className="settings-actions"><button onClick={()=>void moveWorkbench(true)}>移到主屏</button><button disabled={!monitors.some(monitor=>!monitor.isPrimary)} onClick={()=>void moveWorkbench(false)}>移到副屏</button><button onClick={onReturnMain}>返回桌面</button></div>
            <label>显示密度<select value={preset} onChange={(event)=>setPresetLayout(event.target.value as LayoutDocument["mode"])}><option value="standard">标准</option><option value="compact">紧凑</option><option value="minimal">精简</option></select></label>
            <small>{currentMonitor.name} · {currentMonitor.width} × {currentMonitor.height} · {presetLabel(layout.mode)}</small>
            <label>载入已保存布局<select value="" onChange={(event) => applySavedLayout(event.target.value)}><option value="">选择布局</option>{savedLayouts.map((item) => <option key={`${item.name}-${item.savedAt}`} value={item.name}>{item.name}</option>)}</select></label>
            <div className="settings-actions"><button onClick={saveCurrentLayout}>保存当前</button><button onClick={saveLayoutAs}>另存布局</button><button onClick={resetLayout}>恢复默认</button><button onClick={exportLayout}>导出 JSON</button><button onClick={() => importInput.current?.click()}>导入 JSON</button></div>
            <input ref={importInput} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { void importLayout(event.target.files?.[0]); event.currentTarget.value = ""; }} />
          </div>),
          widgets: (<div className="settings-section widget-settings"><strong>组件显示与排序</strong>
            {placements.map((item, index) => {
              const definition = widgetRegistry.find((widget) => widget.id === item.id);
              return <div className="widget-setting-row" key={item.id}><label><input type="checkbox" checked={!item.hidden} onChange={(event) => updatePlacement(item.id, { hidden: !event.target.checked })} /><span>{definition?.title ?? item.id}</span></label>
                <div><button aria-label={`上移${definition?.title ?? item.id}`} disabled={index === 0} onClick={() => moveWidget(item.id, -1)}>↑</button><button aria-label={`下移${definition?.title ?? item.id}`} disabled={index === placements.length - 1} onClick={() => moveWidget(item.id, 1)}>↓</button></div>
              </div>;
            })}
          </div>),
          applications: (<div className="settings-section applications-settings" id="application-management"><ApplicationManager applications={applications} onApplicationsChange={setApplications} /></div>),
          desktop: (<div className="settings-section">
            <label>启动时显示<select value={settings.startupMode} onChange={(event) => onSettingsChange({ startupMode: event.target.value as AppSettings["startupMode"] })}><option value="desktop">Dock 和顶部 HUD（默认）</option><option value="dashboard">工作台</option><option value="custom">自定义</option></select></label>
            {settings.startupMode === "custom" && <>
              <label className="settings-toggle">显示 Dock 和顶部 HUD<input type="checkbox" checked={settings.showMainOnStartup} onChange={(event) => onSettingsChange({ showMainOnStartup: event.target.checked })} /></label>
              <label className="settings-toggle">显示工作台<input type="checkbox" checked={settings.showDashboardOnStartup} onChange={(event) => onSettingsChange({ showDashboardOnStartup: event.target.checked })} /></label>
            </>}
            <details className="settings-help"><summary>高级与帮助</summary>
              <p>点击 Dock 或顶部的企鹅按钮打开工作台，点击工作台红点隐藏。</p>
              <label className="settings-toggle">保持在其他窗口下方<input type="checkbox" checked={settings.desktopMode} onChange={(event) => onSettingsChange({ desktopMode: event.target.checked })} /></label>
              <label className="settings-toggle">整窗鼠标穿透<input type="checkbox" checked={settings.mousePassthrough} onChange={(event) => onSettingsChange({ mousePassthrough: event.target.checked })} /></label>
              <small>开启后 HUD 和推荐也无法点击；Ctrl + Shift + Space 退出。空白区域已支持穿透。</small>
              <small>开机启动、隐藏 Windows 桌面图标暂未支持。</small>
            </details>
          </div>),
          simulation: (<div className="settings-section">
            <label className="settings-toggle">启用模拟数据变化<input type="checkbox" checked={settings.simulationEnabled} onChange={(event) => onSettingsChange({ simulationEnabled: event.target.checked })} /></label>
            <label>模拟场景<select value={settings.simulationScenario} disabled={!settings.simulationEnabled} onChange={(event) => onSettingsChange({ simulationScenario: event.target.value as SimulationScenario })}><option value="normal">正常消耗</option><option value="warning">系统警告</option><option value="error">VPS 离线 / 系统异常</option><option value="high-load">高负载</option></select></label>
            <small>仅模拟界面和通知，不写入真实历史；开启后暂停真实 Provider。</small>
          </div>),
          agents:(<AgentConnectionsSettings/>),
          api: (<ApiConnectionsSettings connections={settings.apiConnections} simulationEnabled={settings.simulationEnabled} onChange={(apiConnections) => onSettingsChange({ apiConnections })} />),
          analysis: (<><AnalysisConnectionsSettings settings={settings.remoteAnalysis} onChange={(remoteAnalysis) => onSettingsChange({ remoteAnalysis })} /><button className="action-button" onClick={()=>window.dispatchEvent(new Event("codex-desktop.open-history-analysis"))}>打开历史分析</button></>),
          mail: (<MailConnections/>),
          webapps: (<WebAppManager/>),
          data: (<DataSourceConnectionsSettings/>),
          beszel: (<div className="settings-section beszel-settings"><strong>Beszel VPS 连接</strong>
            <details className="settings-help beszel-hub-startup"><summary>本机 Hub 随软件启动</summary>
              <label className="settings-toggle"><input type="checkbox" checked={beszelHubDraft.enabled} onChange={e=>setBeszelHubDraft(v=>({...v,enabled:e.target.checked}))}/>随 GleamDesk 启动本机 Hub</label>
              {beszelHubDraft.enabled&&<>
                <label>Hub 程序路径<input value={beszelHubDraft.executable} placeholder="已安装的 beszel.exe 完整路径" maxLength={1024} onChange={e=>setBeszelHubDraft(v=>({...v,executable:e.target.value}))}/></label>
                <label>原数据目录<input value={beszelHubDraft.dataDirectory} placeholder="包含 data.db 的 beszel_data 目录" maxLength={1024} onChange={e=>setBeszelHubDraft(v=>({...v,dataDirectory:e.target.value}))}/></label>
              </>}
              <small>仅支持 http://127.0.0.1 的本机 Hub，复用原数据库。已有健康 Hub 不重复启动；退出软件后 Hub 继续运行。</small>
              <button className="action-button" onClick={()=>{try{if(beszelHubDraft.enabled){const url=new URL(beszelDraft.url);if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||!beszelHubDraft.executable.trim()||!beszelHubDraft.dataDirectory.trim())throw Error("请填写本机 HTTP Hub 地址、程序路径和原数据目录");}onSettingsChange({beszelAutoStartHub:beszelHubDraft.enabled,beszelHubExecutable:beszelHubDraft.executable.trim(),beszelHubDataDirectory:beszelHubDraft.dataDirectory.trim(),beszelUrl:beszelDraft.url.trim()});setBeszelHubMessage(beszelHubDraft.enabled?"已保存，主屏将检查并按需启动本机 Hub":"已关闭随软件启动；已运行的 Hub 保持运行");}catch(error){setBeszelHubMessage(error instanceof Error?error.message:"本机启动设置保存失败");}}}>保存本机启动设置</button>
              {beszelHubMessage&&<small role="status">{beszelHubMessage}</small>}
            </details>
            <label>Hub 地址<input type="url" value={beszelDraft.url} placeholder="https://beszel.example.com" onChange={(event) => setBeszelDraft((current) => ({ ...current, url: event.target.value }))} /></label>
            <label>System ID<input value={beszelDraft.systemId} placeholder="Beszel 系统记录 ID" onChange={(event) => setBeszelDraft((current) => ({ ...current, systemId: event.target.value }))} /></label>
            <label>刷新间隔（秒）<input type="number" min="10" max="300" step="5" value={beszelDraft.refreshIntervalSeconds} onChange={(event) => setBeszelDraft((current) => ({ ...current, refreshIntervalSeconds: Number(event.target.value) }))} /></label>
            <label>API 令牌<input type="password" autoComplete="new-password" value={beszelToken} placeholder={beszelTokenConfigured ? "已保存 · 输入新令牌以替换" : "PocketBase 用户认证令牌"} onChange={(event) => setBeszelToken(event.target.value)} /></label>
            <div className="settings-actions"><button onClick={() => onSettingsChange({ beszelUrl: beszelDraft.url.trim(), beszelSystemId: beszelDraft.systemId.trim(), beszelRefreshIntervalSeconds: Math.max(10, Math.min(300, Math.round(beszelDraft.refreshIntervalSeconds || 30))) })}>保存连接设置</button><button disabled={!isTauri() || !beszelToken.trim()} onClick={() => void saveBeszelToken()}>安全保存令牌</button><button disabled={!isTauri() || !beszelDraft.url || !beszelDraft.systemId || beszelTesting} onClick={() => void runBeszelConnectionTest()}>{beszelTesting ? "测试中…" : "测试连接"}</button>{beszelTokenConfigured && <button onClick={() => void clearBeszelToken()}>删除令牌</button>}</div>
            <small>{beszelTokenConfigured ? "令牌已保存" : "未保存令牌"}</small>
            <details className="settings-help"><summary>连接帮助</summary><p>使用 PocketBase 用户认证令牌，Agent 注册令牌不适用。也可在下方使用 Hub 账户登录。建议使用 HTTPS。令牌保存在 Windows 凭据管理器；设置只保存地址、System ID 和刷新间隔。浏览器预览不能连接账户。</p></details>
            {beszelTokenConfigured && beszelTokenJwtFormat === false && <small role="status">保存的值不符合 PocketBase JWT 格式。请换成你登录用户获得的 API 认证令牌，直接填写令牌内容；Agent 注册 Token 不适用于此读取。</small>}
            <details className="settings-help"><summary>使用 Hub 账户登录</summary>
            <small>密码仅用于本次登录，取得的令牌保存在本机。</small>
            <label>Hub 账户邮箱<input type="email" autoComplete="username" value={beszelLoginIdentity} disabled={!isTauri() || beszelConnecting} onChange={(event) => setBeszelLoginIdentity(event.target.value)} /></label>
            <label>Hub 账户密码<input type="password" autoComplete="off" value={beszelLoginPassword} disabled={!isTauri() || beszelConnecting} onChange={(event) => setBeszelLoginPassword(event.target.value)} /></label>
            <div className="settings-actions"><button disabled={!isTauri() || beszelConnecting || !beszelDraft.url.trim() || !beszelLoginIdentity.trim() || !beszelLoginPassword} onClick={() => void connectBeszelAccount()}>{beszelConnecting ? "连接中…" : "连接并保存"}</button></div>
            </details>
            {beszelMessage && <small role="status">{beszelMessage}</small>}
            <VpsServiceSettings/>
          </div>),
          diagnostics: (<div className="settings-section"><WebAppDiagnostics/><button className="diagnostics-toggle" aria-expanded={diagnosticsOpen} onClick={() => setDiagnosticsOpen((open) => !open)}>系统诊断 <span>{diagnosticsOpen ? "收起" : "查看"}</span></button>
            {diagnosticsOpen && <>
              <ProviderRequestDiagnostics snapshot={diagnostics?.requestMetrics ?? null} checking={checkingWindowRefresh} onCheck={(scope) => void checkWindowRefresh(scope)} />
              <div className="diagnostics-grid">
                <span>应用版本</span><strong>{diagnostics?.appVersion ?? "读取中…"}</strong>
                <span>Tauri</span><strong>{diagnostics?.tauriVersion ?? "读取中…"}</strong>
                <span>Rust 后端</span><strong>{diagnostics?.rustStatus ?? "读取中…"}</strong>
                <span>Provider</span><strong>{displayData.providers.length} 个可见数据项</strong>
                <span>Provider 状态</span><strong>{displayData.providerDiagnostics.map((provider) => `${provider.name} ${provider.status}${provider.error ? ` · ${provider.error}` : ""}`).join(" · ") || "等待数据"}</strong>
                <span>事件日志</span><strong>{displayData.health.eventLogStatus === "ok" ? "正常" : displayData.health.eventLogStatus === "partial" ? "部分通道不可读" : displayData.health.eventLogStatus === "unavailable" ? "不可用" : displayData.health.eventLogStatus === "error" ? "读取失败" : "未扫描或组件未启用"}</strong>
                <span>最近扫描</span><strong>{displayData.health.lastScanAt ? new Date(displayData.health.lastScanAt).toLocaleString("zh-CN") : "—"}</strong>
                <span>重点事件</span><strong>{displayData.health.events?.length ?? 0} 条{settings.simulationEnabled ? "展示（模拟）" : "当前结果"}</strong>
                <span>Widget</span><strong>{visiblePlacements.length} / {widgetRegistry.length} 已显示</strong>
                <span>最近启动</span><strong>{new Date(appStartedAt).toLocaleString("zh-CN")}</strong>
                <span>最后错误</span><strong>{diagnostics?.lastError ?? "读取中…"}</strong>
                <span>历史记录</span><strong>{diagnostics ? `Provider ${diagnostics.historyCounts.provider_history} · Widget ${diagnostics.historyCounts.widget_state} · 事件 ${diagnostics.historyCounts.system_events} · 用量 ${diagnostics.historyCounts.usage_history} · VPS ${diagnostics.historyCounts.vps_history} · 硬件 ${diagnostics.historyCounts.hardware_history}` : "读取中…"}</strong>
              </div>
              <div className="settings-actions"><button onClick={() => void refreshDiagnostics()}>刷新诊断</button><small>更新于 {diagnostics?.refreshedAt ?? "—"}</small></div>
            </>}
          </div>),
        }} />
      )}

      {editing && supportsDashboardWidgets(currentPage) && visiblePlacements.length===0 && <div className="page-empty-edit-hint">此页还没有组件，可在“添加组件”中选择，或从其他组件页拖入</div>}


      {editing && !supportsDashboardWidgets(currentPage) && currentPage.widgets.length>0 && <div className="dashboard-toolbar"><div className="toolbar-controls"><strong>此页有未显示的组件</strong>{currentPage.widgets.map(item=><label key={item.id}>{widgetRegistry.find(widget=>widget.id===item.id)?.title??item.id}<select aria-label={`移回${item.id}`} defaultValue="" onChange={event=>{const target=event.target.value;if(!target)return;try{changePages(moveDashboardWidget(pageDocument,currentPage.id,target,item.id));}catch(error){setToast(error instanceof Error?error.message:"无法移动组件");}event.currentTarget.value="";}}><option value="">移回组件页…</option>{editablePages.filter(page=>page.id!==currentPage.id).map(page=><option value={page.id} key={page.id}>{page.name}</option>)}</select></label>)}</div></div>}
      {supportsDashboardWidgets(currentPage)&&(!["overview","resources"].includes(currentPage.kind)||editing)&&<header className="workbench-page-heading"><div><h1>{currentPage.kind==="overview"?"工作台":currentPage.kind==="resources"?"本机与 VPS":currentPage.name}</h1>{editing&&<p>拖动标题调整卡片，完成后保存布局</p>}</div><div><button onClick={onOpenNotifications}>通知中心</button><button onClick={()=>editing?persist():setEditing(true)}>{editing?"完成编辑":"编辑布局"}</button></div></header>}
      <PagedViewport retainForTransition={currentPage.kind!=="workspace"} pageId={viewportPageId} pageIds={viewportPageIds} editing={editing} onStep={stepPage} onWidgetDrag={(id,position)=>{setDragging(id);setDragPosition(position??null);}} onWidgetDrop={(id,target,position)=>{try{if(target){reorder(target,id);return;}if(position)changePages(placeDashboardWidget(pageDocument,currentPage.id,id,position.x,position.y));}catch(error){setToast(error instanceof Error?error.message:"无法放置组件");}}} onEdgeMove={(id,direction)=>{try{const target=adjacentWidgetPage({...pageDocument,pages:editablePages},direction,id);if(!target){setToast("其他自定义组件页没有可容纳的位置，可新建页面或调整布局");return;}const next=moveDashboardWidget(pageDocument,currentPage.id,target.id,id);if(next!==pageDocument)changePages(selectDashboardPage(next,target.id));}catch(error){setToast(error instanceof Error?error.message:"无法跨页移动");}}}>
      {currentPage.kind==="overview"&&!editing?<WidgetErrorBoundary widgetId="workbench-overview"><WorkbenchOverview displayName={settings.displayName} healthRequest={openAppRequest?.id==="health"?openAppRequest.nonce:undefined} data={displayData} simulationEnabled={settings.simulationEnabled} vpsInterval={settings.beszelRefreshIntervalSeconds} vpsConfigured={settings.simulationEnabled||Boolean(settings.beszelUrl.trim()&&settings.beszelSystemId.trim())} onNotifications={onOpenNotifications} onRoom={()=>openWebTool("agents")} onConnections={()=>{setSettingsModule("api");setSettingsOpen(true);}}/></WidgetErrorBoundary>:currentPage.kind==="resources"&&!editing?<WidgetErrorBoundary widgetId="workbench-resources"><WorkbenchResources data={displayData} view={resourceView} onView={setResourceView} simulationEnabled={settings.simulationEnabled} vpsHubUrl={settings.beszelUrl} animationsEnabled={settings.animations} onOpenServicePanel={openServicePanel} onConnections={()=>{setSettingsModule("beszel");setSettingsOpen(true);}}/></WidgetErrorBoundary>:currentPage.kind === "workspace" ? <WidgetErrorBoundary widgetId="workspace"><Workspace navigationHidden onSelectionChange={setWorkspaceSelection} covered={notificationOverlayVisible||pageManagerOpen} visible={!settingsOpen&&!searchOpen} simulationEnabled={settings.simulationEnabled} onManageWebApps={openWebAppsManager} openAppRequest={openAppRequest} openUrlRequest={openUrlRequest} /></WidgetErrorBoundary> : currentPage.kind === "toolbox" ? <WidgetErrorBoundary widgetId="toolbox"><ToolboxWorkspace openToolRequest={openToolRequest} onResources={()=>selectWorkbenchPage("resources")} onHealth={()=>{setOpenAppRequest({id:"health",nonce:Date.now()});selectPage("overview");}} onAgentRoom={()=>openWebTool("agents")} onLocalAi={()=>window.dispatchEvent(new CustomEvent("codex-desktop.local-ai-request",{detail:{id:"builtin-ollama"}}))} onManageWebApps={openWebAppsManager} onOpenWebApp={openWebTool} /></WidgetErrorBoundary> : <section className={`widget-grid page-${currentPage.kind} grid-rows-${Math.max(editing?4:3,...visiblePlacements.map(item=>item.y+item.height))}`} style={{"--page-rows":Math.max(editing?4:3,...visiblePlacements.map(item=>item.y+item.height))} as CSSProperties} aria-label="副屏组件">
        {visiblePlacements.map((placement) => (
          <div
            className={"widget-shell span-" + placement.width + " widget-" + placement.id + (editing ? " is-editing" : "") + (dragging === placement.id ? " is-dragging" : "") + " " + animationManager.classFor(displayData.health.state === "offline" ? "error" : "enter")}
            style={{ "--widget-column": `${placement.x + 1} / span ${placement.width}`, "--widget-row": `${placement.y + 1} / span ${placement.height}`, ...(dragging===placement.id&&dragPosition?{position:"fixed",left:dragPosition.x-dragPosition.offsetX,top:dragPosition.y-dragPosition.offsetY,width:dragPosition.width,height:dragPosition.height,zIndex:9999,pointerEvents:"none",boxSizing:"border-box"}:{}), ...animationManager.style() } as CSSProperties}
            key={placement.id}
            data-widget-id={placement.id}
            draggable={false}
          >
            {editing && <select className="widget-page-move" aria-label="移动组件到页面" value="" onChange={event=>{if(!event.target.value)return;try{changePages(moveDashboardWidget(pageDocument,currentPage.id,event.target.value,placement.id));}catch(error){setToast(error instanceof Error?error.message:"无法移动组件");}}}><option value="">移到其他页</option>{editablePages.filter(page=>page.id!==currentPage.id).map(page=><option value={page.id} key={page.id}>{page.name}</option>)}</select>}
            {editing && (
              <div className="widget-tools">
                <span className="drag-handle">⠿ 拖动</span>
                <button title="缩小组件" onClick={() => updatePlacement(placement.id, { width: Math.max(2, placement.width - 1) as WidgetPlacement["width"] })}>−</button>
                <button title="放大组件" onClick={() => updatePlacement(placement.id, { width: Math.min(12, placement.width + 1) as WidgetPlacement["width"] })}>+</button>
                <button title="增高组件" onClick={()=>updatePlacement(placement.id,{height:Math.min(4,placement.height+1) as WidgetPlacement["height"]})}>↕＋</button><button title="降低组件" onClick={()=>updatePlacement(placement.id,{height:Math.max(1,placement.height-1) as WidgetPlacement["height"]})}>↕−</button><button className="ui-icon-button" title="隐藏组件" onClick={() => updatePlacement(placement.id, { hidden: true })}><CloseIcon/></button>
              </div>
            )}
            <WidgetErrorBoundary widgetId={placement.id}><WidgetCard id={placement.id} data={displayData} compact={currentPage.kind==="overview"} simulationEnabled={settings.simulationEnabled} vpsHubUrl={settings.beszelUrl} applications={applications} onLaunchApplication={(application) => void launchFromDashboard(application)} onManageApplications={openApplicationsManager} onOpenNotifications={onOpenNotifications} /></WidgetErrorBoundary>
          </div>
        ))}
      </section>}
      </PagedViewport>

      {toast && <div className="toast glass">{toast}</div>}
    </main>
  );
}

function presetLabel(mode: LayoutPreset) {
  return ({ standard: "标准", compact: "紧凑", minimal: "精简" })[mode];
}
export default App;
