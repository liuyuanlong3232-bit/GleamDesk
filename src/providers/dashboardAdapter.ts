import type { DashboardData, NoticeItem, ProviderDiagnostic, ProviderStatus } from "../types";
import { toProviderDiagnostic, type Provider, type ProviderSnapshot } from "./contracts";
import type { ProviderData } from "./data";
import { presentWindowsHealth } from "../presentation/windowsHealthAdapter";
import { presentVps } from "../presentation/vpsAdapter";
import { presentApplications } from "../presentation/applicationAdapter";
import { presentAgentQuotas, presentApiUsage } from "../presentation/quotaAdapter";

export function emptyDashboardData(): DashboardData {
  return {
    providers: [],
    providerDiagnostics: [],
    vps: { name: "", uptime: "", latency: 0, gauges: [], services: [] },
    health: { summary: "", detail: "", metrics: [] },
    hardware: null,
    localAI: null,
    metrics: [],
    notices: [],
    applications: [],
  };
}

function providerErrorStatus(provider: Provider<ProviderData>, snapshot: ProviderSnapshot<ProviderData>): ProviderStatus {
  const status = snapshot.status === "stale" ? "warning" : "offline";
  const id = provider.id === "agent-quotas" ? "codex" : provider.id === "api-balances" ? "openai" : provider.id;
  return { id, name: provider.name, kind: provider.kind, state: status, lastUpdated: snapshot.lastUpdated ?? "", error: snapshot.error };
}

function providerNotice(diagnostic: ProviderDiagnostic): NoticeItem | undefined {
  if (diagnostic.status === "normal" || diagnostic.status === "degraded") return undefined;
  const stale = diagnostic.status === "stale";
  return {
    id: `provider:${diagnostic.providerId}:${diagnostic.status}`,
    icon: stale ? "i" : "!",
    title: `${diagnostic.name} ${stale ? "数据已过期" : "暂不可用"}`,
    detail: diagnostic.error || (diagnostic.lastSuccessAt ? `上次成功 ${new Date(diagnostic.lastSuccessAt).toLocaleString("zh-CN")}` : "尚无成功读取记录"),
    tone: stale ? "violet" : "amber",
  };
}

export function adaptProviderSnapshots(providers: Provider<ProviderData>[], snapshots: ProviderSnapshot<ProviderData>[]): DashboardData {
  const data = emptyDashboardData();
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  for (const snapshot of snapshots) {
    const provider = providerById.get(snapshot.providerId);
    if (!provider) continue;
    const diagnostic = toProviderDiagnostic(provider, snapshot);
    data.providerDiagnostics.push(diagnostic);
    const notice = snapshot.status === "unavailable" && snapshot.retryable === false && !snapshot.error ? undefined : providerNotice(diagnostic);
    if (notice) data.notices.push(notice);

    const payload = snapshot.data;
    if (!payload) {
      data.providers.push(providerErrorStatus(provider, snapshot));
      continue;
    }

    switch (payload.type) {
      case "public-news":data.publicNews=payload.snapshot;break;
      case "public-overseas-futures":data.publicOverseasFutures=payload.snapshot;break;
      case "public-cn-futures":data.publicChinaFutures=payload.snapshot;break;
      case "public-a-shares":data.publicAStocks=payload.snapshot;break;
      case "public-market":data.publicMarket=payload.snapshot;break;
      case "public-nass-annual":data.nassAnnual=payload.snapshot;break;
      case "public-crop-progress":data.cropProgress=payload.snapshot;break;
      case "public-monthly":data.publicMonthly=payload.snapshot;break;
      case "public-argentina":data.publicArgentina=payload.snapshot;break;
      case "public-conab":data.publicConab=payload.snapshot;break;
      case "public-ibge":data.publicIbge=payload.snapshot;break;
      case "public-noaa":data.publicNoaa=payload.snapshot;break;
      case "public-inspections":data.publicInspections=payload.snapshot;break;
      case "public-wasde":data.publicWasde=payload.snapshot;break;
      case "public-cftc":data.publicCftc=payload.snapshot;break;
      case "agent-quotas":
        data.providers.push(...presentAgentQuotas(payload.accounts, snapshot.status, snapshot.error, payload.mode));
        break;
      case "api-balances":
        data.providers.push(...presentApiUsage(payload.accounts, snapshot.status, snapshot.error, payload.mode));
        break;
      case "application-catalog":
        data.applications = presentApplications(payload.applications);
        break;
      case "vps-status":
        data.vps = presentVps(payload.observation, snapshot.status, snapshot.error);
        if (snapshot.lastSuccessAt) data.vps.lastSuccessAt = snapshot.lastSuccessAt;
        break;
      case "windows-health": {
        const presentation = presentWindowsHealth(payload.observation, snapshot.status, snapshot.error);
        data.health = presentation.health;
        data.metrics = [];
        data.notices.push(...presentation.notices);
        data.providers.push(presentation.providerStatus);
        break;
      }
      case "hardware-status":
        data.hardware = payload.snapshot;
        break;
      case "custom-market-quotes":
        data.customMarket=payload.snapshot;
        break;
      case "public-weather":
        data.publicWeather=payload.snapshot;
        break;
      case "agriculture-status":
        data.agriculture=payload.snapshot;
        break;
      case "local-ai":
        data.localAI = payload.snapshot;
        break;
    }
  }

  data.notices = [...new Map(data.notices.map((notice) => [notice.id ?? notice.title, notice])).values()].slice(0, 4);
  return data;
}

export function mergeDashboardData(current: DashboardData, update: DashboardData): DashboardData {
  let providerRows = [...current.providers];
  for (const source of ["deepseek", "anthropic","mimo","openai"]) {
    if (update.providerDiagnostics.some((item) => item.providerId === `api-${source}`)) {
      const belongsToSource = (item: ProviderStatus) => item.id === source || item.id === `api-${source}` || item.id.startsWith(`${source}-`);
      const position = providerRows.findIndex(belongsToSource);
      providerRows = providerRows.filter((item) => !belongsToSource(item));
      // Existing groups retain their slot; new groups follow the incoming snapshot order.
      if (position >= 0) providerRows.splice(position, 0, ...update.providers.filter(belongsToSource));
    }
  }
  const providers = new Map(providerRows.map((item) => [item.id, item]));
  for (const item of update.providers) providers.set(item.id, item);
  const diagnostics = new Map(current.providerDiagnostics.map((item) => [item.providerId, item]));
  for (const item of update.providerDiagnostics) diagnostics.set(item.providerId, item);
  const hasHealthUpdate = Boolean(update.health.summary || update.health.eventLogStatus || update.health.lastScanAt);
  const notices = new Map(current.notices.map((item) => [item.id ?? item.title, item]));
  const changedProviderIds = new Set(update.providerDiagnostics.map((item) => item.providerId));
  for (const [id, item] of notices) {
    if (typeof item.id === "string" && item.id.startsWith("provider:") && changedProviderIds.has(item.id.split(":")[1])) notices.delete(id);
  }
  for (const item of update.notices) notices.set(item.id ?? item.title, item);
  return {
    providers: [...providers.values()],
    providerDiagnostics: [...diagnostics.values()],
    vps: update.vps.name || update.vps.statusMessage || update.vps.error || update.vps.lastUpdated ? update.vps : current.vps,
    health: hasHealthUpdate ? update.health : current.health,
    hardware: update.hardware ?? current.hardware,
    localAI: update.localAI ?? current.localAI,
    agriculture:update.agriculture??current.agriculture,
    publicWeather:update.publicWeather??current.publicWeather,
    customMarket:update.customMarket??current.customMarket,
    publicNews:update.publicNews??current.publicNews,
    publicOverseasFutures:update.publicOverseasFutures??current.publicOverseasFutures,
    publicChinaFutures:update.publicChinaFutures??current.publicChinaFutures,
    publicAStocks:update.publicAStocks??current.publicAStocks,
    publicMarket:update.publicMarket??current.publicMarket,
    publicWasde:update.publicWasde??current.publicWasde,
    publicInspections:update.publicInspections??current.publicInspections,
    nassAnnual:update.nassAnnual??current.nassAnnual,
    cropProgress:update.cropProgress??current.cropProgress,
    publicMonthly:update.publicMonthly??current.publicMonthly,
    publicArgentina:update.publicArgentina??current.publicArgentina,
    publicConab:update.publicConab??current.publicConab,
    publicIbge:update.publicIbge??current.publicIbge,
    publicNoaa:update.publicNoaa??current.publicNoaa,
    publicCftc:update.publicCftc??current.publicCftc,
    metrics: hasHealthUpdate ? update.metrics : update.metrics.length ? update.metrics : current.metrics,
    notices: [...notices.values()].slice(-4),
    applications: update.applications.length ? update.applications : current.applications,
  };
}
