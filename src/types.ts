import type { SystemEvent } from "./domain/health/contracts";
export type { SystemEvent } from "./domain/health/contracts";
import type { ApplicationItem } from "./domain/applications/contracts";
export type { ApplicationItem, ApplicationType } from "./domain/applications/contracts";
import type { ProviderKind, ProviderState, ProviderDiagnostic,ProviderResultStatus } from "./domain/providers/contracts";
export type { ProviderKind, ProviderState, ProviderResultStatus, ProviderDiagnostic } from "./domain/providers/contracts";
import type { HardwareSnapshot } from "./domain/hardware/contracts";
export type { HardwareSnapshot, HardwareMetricStatus } from "./domain/hardware/contracts";

export interface ProviderStatus {
  id: string;
  name: string;
  kind: ProviderKind;
  state: ProviderState;
  dataState?: import("./domain/providers/contracts").DataState;
  percentage?: number;
  remaining?: string;
  resetTime?: string;
  balance?: number;
  todayCost?: number;
  monthlyCost?: number;
  currency?: string;
  sourceUrl?: string;
  periodStart?: string;
  periodEnd?: string;
  todayPeriodStart?: string;
  todayPeriodEnd?: string;
  apiAmountScope?: import("./domain/api/contracts").ApiAmountScope;
  apiReadStatus?: ProviderResultStatus;
  apiAvailabilityReason?: import("./domain/api/contracts").ApiUnavailableReason;
  apiPeriodTimeZone?: "UTC"|"Asia/Shanghai";
  detail?: string;
  latency?: number;
  lastUpdated: string;
  error?: string;
  installed?: boolean;
  running?: boolean;
  loginStatus?: import("./domain/agent/contracts").AgentQuotaAccount["loginStatus"];
  plan?: string;
  membership?: import("./domain/agent/contracts").AgentQuotaAccount["membership"];
  usageType?: string;
  source?: string;
  confidence?: import("./domain/agent/contracts").AgentConfidence;
  usageWindows?: import("./domain/agent/contracts").AgentUsageWindow[];
  ordinaryUsageAllowed?: boolean;
  cliDetected?: boolean;
  configurationDetected?: boolean;
  cacheDetected?: boolean;
}

export interface MonitorInfo {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
}

export interface WidgetPlacement {
  id: string;
  x: number;
  y: number;
  width: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  height: 1 | 2 | 3 | 4;
  hidden: boolean;
}

export type LayoutPreset = "standard" | "compact" | "minimal";

export interface LayoutDocument {
  schemaVersion: 2;
  monitorId: string;
  resolution: string;
  scaleFactor: number;
  mode: LayoutPreset;
  widgets: WidgetPlacement[];
  updatedAt: string;
}

export type AppTheme = "burgundy" | "lavender" | "moss" | "white";
export type StartupMode = "desktop" | "main" | "dashboard" | "custom";
export type WallpaperMode = "auto" | "dark" | "light";
export type SimulationScenario = "normal" | "warning" | "error" | "high-load";
export type DesktopSurfaceMode = "keep" | "hide-icons" | "hide-taskbar";

export type ScannedApplication = Pick<ApplicationItem, "id" | "name" | "icon" | "type" | "target"> &
  Partial<Pick<ApplicationItem, "arguments" | "category" | "sourcePath" | "processName" | "glyph" | "color" | "iconSource">>;

export interface ApplicationConfig {
  version: 1 | 2;
  apps: ApplicationItem[];
}

export interface AppSettings {
  displayName: string;
  theme: AppTheme;
  opacity: number;
  hudBackgroundOpacity: number;
  blur: number;
  accent: string;
  glassBorderOpacity: number;
  glassShadowStrength: number;
  animations: boolean;
  autoStart: boolean;
  desktopMode: boolean;
  mousePassthrough: boolean;
  desktopSurfaceMode: DesktopSurfaceMode;
  startupMode: StartupMode;
  showMainOnStartup: boolean;
  showDashboardOnStartup: boolean;
  wallpaperMode: WallpaperMode;
  simulationEnabled: boolean;
  simulationScenario: SimulationScenario;
  beszelUrl: string;
  beszelAutoStartHub: boolean;
  beszelHubExecutable: string;
  beszelHubDataDirectory: string;
  beszelSystemId: string;
  beszelRefreshIntervalSeconds: number;
  beszelCredentialRevision?: number;
  notificationPreferences: NotificationPreferences;
  apiConnections: ApiConnectionSettings;
  remoteAnalysis: import("./domain/analysis/remoteSettings").RemoteAnalysisSettings;
}

export interface ApiConnectionSettings {
  deepseekEnabled: boolean;
  anthropicEnabled: boolean;
  mimoEnabled?: boolean;
  openaiEnabled?: boolean;
  mimoDailyAuto?: boolean;
  credentialRevision: number;
}

export interface WallpaperProfile {
  path: string | null;
  luminance: number | null;
  profile: "dark" | "light" | "unknown";
}

export interface ResourceMetric {
  id: string;
  name: string;
  value: number;
  color: "blue" | "violet" | "green" | "cyan";
  points: string;
}

export interface NoticeItem {
  id?: string;
  icon: string;
  title: string;
  detail: string;
  tone: "amber" | "violet" | "blue";
}

export type NotificationSeverity = "info" | "warning" | "error";
export type NotificationSource = "system" | "provider" | "hardware" | "api";
export interface NotificationPreferences {
  enabled: boolean;
  toastEnabled: boolean;
  minimumSeverity: NotificationSeverity;
  cooldownSeconds: number;
  sources: Record<NotificationSource, boolean>;
}
export interface NotificationCandidate {
  id: string;
  source: NotificationSource;
  scope: string;
  rule: string;
  kind: "event" | "condition";
  severity: NotificationSeverity;
  title: string;
  detail: string;
  evidenceAt: string | null;
}
export interface NotificationRecord extends NotificationCandidate {
  schemaVersion: 1;
  firstSeenAt: string;
  lastSeenAt: string;
  lastNotifiedAt: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  occurrences: number;
  active: boolean;
  pendingDelivery: boolean;
}
export interface NotificationState {
  records: NotificationRecord[];
  totalCount: number;
  unacknowledgedCount: number;
}

export interface DockApplication {
  id: string;
  name: string;
  glyph: string;
  color: string;
}

export interface VpsSnapshot {
  name: string;
  host?: string | null;
  state?: ProviderState;
  uptime: string;
  latency?: number;
  gauges: { label: string; value: number }[];
  network?: { uploadBytes?: number; downloadBytes?: number; totalBytes?: number };
  services: { name: string; state: "online" | "offline" | "unknown" }[];
  lastUpdated?: string;
  lastSuccessAt?: string;
  lastFetchedAt?: string;
  statusMessage?: string;
  error?: string;
  serverId?: string;
}

export interface HealthSnapshot {
  state?: ProviderState;
  summary: string;
  detail: string;
  metrics: { label: string; value: number; unit?: string }[];
  events?: SystemEvent[];
  eventLogStatus?: "ok" | "partial" | "unavailable" | "error";
  lastScanAt?: string;
}

export type HistoryKind = "provider_history" | "widget_state" | "system_events" | "usage_history" | "vps_history" | "hardware_history" | "application_history" | "notifications_history";

export interface HistoryRecord<T = unknown> {
  id: string;
  kind: HistoryKind;
  createdAt: string;
  payload: T;
}

export interface NamedLayout {
  name: string;
  document: LayoutDocument;
  savedAt: string;
}

export interface DashboardData {
  providers: ProviderStatus[];
  providerDiagnostics: ProviderDiagnostic[];
  vps: VpsSnapshot;
  health: HealthSnapshot;
  hardware: HardwareSnapshot | null;
  localAI?: import("./domain/local/contracts").LocalAiSnapshot | null;
  customMarket?: import("./domain/agriculture/customHttpQuotes").CustomQuotesSnapshot | null;
  publicNews?: import("./domain/news/publicFeeds").PublicNewsSnapshot | null;
  nassAnnual?: import("./domain/agriculture/publicNass").PublicNassAnnualSnapshot | null;
  cropProgress?: import("./domain/agriculture/publicNass").PublicCropProgressSnapshot | null;
  publicMonthly?: import("./domain/agriculture/publicReferenceData").PublicMonthlySnapshot | null;
  publicArgentina?: import("./domain/agriculture/publicReferenceData").PublicArgentinaSnapshot | null;
  publicConab?: import("./domain/agriculture/publicReferenceData").PublicConabSnapshot | null;
  publicIbge?: import("./domain/agriculture/publicReferenceData").PublicIbgeSnapshot | null;
  publicNoaa?: import("./domain/agriculture/publicNoaa").PublicNoaaSnapshot | null;
  publicInspections?: import("./domain/agriculture/publicInspections").PublicInspectionsSnapshot | null;
  publicWasde?: import("./domain/agriculture/publicWasde").PublicWasdeSnapshot | null;
  publicCftc?: import("./domain/agriculture/publicCftc").PublicCftcSnapshot | null;
  publicOverseasFutures?: import("./domain/agriculture/publicOverseasFutures").OverseasFuturesSnapshot | null;
  publicChinaFutures?: import("./domain/agriculture/publicChinaFutures").ChinaFuturesSnapshot | null;
  publicAStocks?: import("./domain/agriculture/publicAStocks").AStocksSnapshot | null;
  publicMarket?: import("./domain/agriculture/publicMarket").PublicMarketSnapshot | null;
  publicWeather?: import("./domain/agriculture/publicWeather").PublicWeatherSnapshot | null;
  agriculture?: import("./domain/agriculture/contracts").AgricultureEnvelope | null;
  metrics: ResourceMetric[];
  notices: NoticeItem[];
  applications: DockApplication[];
}
