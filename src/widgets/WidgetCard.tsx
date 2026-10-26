import { Component, useEffect, useRef, useState, type CSSProperties, type ErrorInfo, type ReactNode } from "react";
import type { ApplicationItem, DashboardData, ProviderStatus } from "../types";
import { widgetRegistry } from "./registry";
import { logEvent } from "../services/appLogger";
import { queryHistoryRecords } from "../services/historyStore";
import { AppGlyph } from "../components/ApplicationDock";
import {isTauri} from "@tauri-apps/api/core";
import {invokeLive} from "../services/simulationSafety";
import {isWindowVisible,subscribeWindowVisibility} from "../services/windowVisibility";
import {formatVpsLocation} from "../presentation/vpsAdapter";
import type {VpsLocation} from "../domain/vps/contracts";
import {ApiMoneyDetails,useApiMoneyClock} from "../components/ApiMoneyDetails";
import { AIControlCenter } from "../components/AIControlCenter";
import { OverviewTrends, PcOverview, PcGpu, PcDisks, PcTrends, CpuParticles, cpuParticleBurst, networkTrendSpike } from "./ResourcePanels";

interface WidgetProps {
  data: DashboardData;
  compact?: boolean;
  simulationEnabled?: boolean;
  vpsHubUrl?: string;
  vpsConsole?: boolean;
  effectsEnabled?: boolean;
  effectPulse?: number;
  applications?: ApplicationItem[];
  onLaunchApplication?: (application: ApplicationItem) => void;
  onManageApplications?: () => void;
  onOpenNotifications?: () => void;
}
type Renderer = (props: WidgetProps) => ReactNode;

function CardHeading({ glyph, title, link, onLink, expanded, children }: { glyph: string; title: string; link?: string; onLink?: () => void; expanded?: boolean; children?: ReactNode }) {
  return <div className="card-heading">
    <span className="heading-glyph">{glyph}</span><strong>{title}</strong>
    <div className="heading-actions">{children}{link && onLink && <button className="card-link" onClick={onLink} aria-expanded={expanded}>{link} <span>›</span></button>}</div>
  </div>;
}

function AgentQuotaWidget({ data, simulationEnabled }: WidgetProps) {
  return <AIControlCenter agents={data.providers.filter(item => item.kind === "agent")} localAI={data.localAI} gpuName={data.hardware?.gpu.name} simulationEnabled={simulationEnabled} />;
}

function ApiBalanceWidget({ data }: WidgetProps) {
  const now=useApiMoneyClock();
  const issue = data.providerDiagnostics.find((item) => (item.providerId === "api-balances"||item.providerId.startsWith("api-")) && ["stale","error"].includes(item.status));
  return <article className="widget-card">
    <CardHeading glyph="◈" title="API 余额 / 费用" />
    <div className="balance-list">{data.providers.filter((item) => item.kind === "api").map((api) => (
      <div className="balance-row" key={api.id}>
        <span className={`api-mark ${api.id}`}>{apiGlyph(api)}</span><div className="balance-content"><div className="balance-heading"><span className="balance-name">{api.name}</span></div><ApiMoneyDetails api={api} now={now}/></div>
      </div>
    ))}</div>
    {issue && <div className={`widget-footnote provider-hint status-${issue.status}`}>{issue.name} · {issue.status}{issue.error ? ` · ${issue.error}` : ""}</div>}
  </article>;
}

function VpsWidget({ data, vpsConsole,vpsHubUrl="", simulationEnabled, effectsEnabled = false, effectPulse = 0 }: WidgetProps) {
  const [showDetails, setShowDetails] = useState(false);
  const identity=JSON.stringify([vpsHubUrl,data.vps.serverId,data.vps.host]);
  const [location,setLocation]=useState<{identity:string;value:VpsLocation|null;error:string;busy:boolean}>({identity:"",value:null,error:"",busy:false});
  useEffect(()=>{
    if(simulationEnabled||!data.vps.host||!isTauri())return;
    let active=true,pending=false;
    const refresh=async()=>{
      if(!active||pending||!isWindowVisible())return;pending=true;
      setLocation({identity,value:null,error:"",busy:true});
      try{const value=await invokeLive<VpsLocation>("read_vps_location",{host:data.vps.host});if(!value||value.source!=="ipwho.is"||!Number.isSafeInteger(value.lookedUpAtUnixMs)||value.lookedUpAtUnixMs<0||value.lookedUpAtUnixMs>Date.now()+1000)throw "所在地返回格式无效";if(active)setLocation({identity,value,error:"",busy:false})}
      catch(reason){if(active)setLocation({identity,value:null,error:typeof reason==="string"?reason:"所在地暂不可用",busy:false})}
      finally{pending=false}
    };
    void refresh();const stop=subscribeWindowVisibility(()=>void refresh());const timer=window.setInterval(()=>void refresh(),86400000);
    return()=>{active=false;stop();window.clearInterval(timer)};
  },[identity,simulationEnabled]);
  const geo=!simulationEnabled&&location.identity===identity?location:undefined;
  const place=formatVpsLocation(geo?.value);
  const locationLine=simulationEnabled?"模拟模式 · 查询暂停":geo?.busy?"查询中…":geo?.value?<>{place.country}<br/>{place.city}</>:"未知 / Unknown";
  const locationDetails=<>{geo?.error&&<p>{geo.error}</p>}{geo?.value&&<p>所在地来源 · {geo.value.source} · {geo.value.ip} · {new Date(geo.value.lookedUpAtUnixMs).toLocaleString("zh-CN")}</p>}</>;
  const diagnostic = data.providerDiagnostics.find((item) => item.providerId === "vps-status");
  const state = data.vps.state ?? "unknown";
  const stateLabel = state === "online" ? "在线" : state === "offline" ? "离线" : state === "warning" ? "警告" : "未知";
  const formatBytes = (value?: number) => value === undefined || !Number.isFinite(value) || value < 0 ? "—" : value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : value >= 1_000 ? `${(value / 1_000).toFixed(1)} KB` : `${value.toFixed(0)} B`;
  if (vpsConsole) {
    const stale = diagnostic?.status === "stale";
    const status = stale ? "数据未更新" : state === "unknown" ? (data.vps.lastFetchedAt ? "时间未确认" : "待连接") : stateLabel;
    const stamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "尚无记录";
    const loads = ["CPU", "内存", "硬盘"].map(label => {
      const raw = data.vps.gauges.find(item => item.label === label)?.value;
      return { label, value: typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : null };
    });
    return <article className="widget-card vps-console-summary">
      <div className="vps-console-main">
        <header className="vps-console-heading"><span>服务器 / VPS</span><span className={`vps-status-badge state-${stale ? "warning" : state}`}><i className={`live-dot state-dot-${stale ? "warning" : state}`} />{status}</span></header>
        <div className="vps-identity"><span className="vps-machine-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="8" rx="2"/><rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 7h.01M7 17h.01M12 7h5M12 17h5" strokeLinecap="round"/></svg></span><div><h2>{data.vps.name || "等待连接服务器"}</h2>{data.vps.statusMessage && <p>{data.vps.statusMessage}</p>}</div></div>
        <div className="vps-console-loads">{loads.map(({ label, value }) => <section className={`vps-load${effectsEnabled && value !== null ? " vps-metric-live" : ""}${value !== null && value >= 80 ? " is-high" : ""}`} key={label} aria-label={`${label} ${value === null ? "暂无数据" : `${value.toFixed(1)}%`}`}>
          <div className="vps-load-ring"><svg viewBox="0 0 100 100" aria-hidden="true"><circle className="vps-ring-track" cx="50" cy="50" r="42"/>{value !== null && value > 0 && <circle className="vps-ring-value" cx="50" cy="50" r="42" pathLength="100" strokeDasharray={`${value} 100`}/>} {effectsEnabled && value !== null && label === "硬盘" && <circle className="vps-ring-sweep" cx="50" cy="50" r="42" pathLength="100" strokeDasharray="5 95"/>}</svg>{label === "CPU" && <CpuParticles load={value} enabled={effectsEnabled} pulse={effectPulse}/>}<strong>{value === null ? "—" : <>{value.toFixed(1)}<small>%</small></>}</strong></div><div><h3>{label === "硬盘" ? "磁盘" : label}</h3>{(value === null || value >= 85) && <small>{value === null ? "等待采样" : "占用偏高"}</small>}</div>
        </section>)}</div>
      </div>
      <aside className="vps-connection-panel"><h3>连接概况</h3><dl><div><dt>数据来源</dt><dd>{simulationEnabled ? "开发模拟" : "Beszel"}</dd></div><div><dt>运行时间</dt><dd>{data.vps.uptime || "未知"}</dd></div><div><dt>连接延迟</dt><dd>{state !== "unknown" && typeof data.vps.latency === "number" && Number.isFinite(data.vps.latency) && data.vps.latency >= 0 ? `${data.vps.latency} ms` : "—"}</dd></div><div><dt>来源时间</dt><dd>{stamp(data.vps.lastUpdated)}</dd></div><div><dt>服务器地址</dt><dd className="vps-location-value">{data.vps.host||"未知"}</dd></div><div><dt>IP 所在地</dt><dd className="vps-location-value">{locationLine}</dd></div></dl>
        <div className="vps-network-pair" aria-label="网络采样流量"><div><small>↓ 下载 / 采样</small><strong>{formatBytes(data.vps.network?.downloadBytes)}</strong></div><div><small>↑ 上传 / 采样</small><strong>{formatBytes(data.vps.network?.uploadBytes)}</strong></div></div>
        {data.vps.error && <p className="vps-connection-error">{data.vps.error}</p>}
        <details className="vps-service-details"><summary>服务与来源详情</summary><p>{data.vps.serverId ? `系统 ID · ${data.vps.serverId}` : "尚未选择 Beszel 系统"}</p><p>本机读取 · {stamp(data.vps.lastFetchedAt)}</p>{locationDetails}{data.vps.services.map(service => <p key={service.name}><i className={`live-dot state-dot-${service.state}`}/>{service.name} · {service.state === "online" ? "在线" : service.state === "offline" ? "离线" : "未知"}</p>)}<p>独立服务的状态，以已接入的检查结果为准。</p></details>
      </aside>
    </article>;
  }
  return <article className="widget-card">
    <CardHeading glyph="▤" title="服务器 / VPS" link={showDetails ? "收起详情" : "查看详情"} onLink={() => setShowDetails((value) => !value)} expanded={showDetails} />
    <div className={`server-banner state-${state}`}><span className="server-icon">▤</span>
      <div><strong>{data.vps.name || "未连接"}</strong><small><i className={`live-dot state-dot-${state}`} /> {data.vps.statusMessage || stateLabel} · {data.vps.uptime || "运行时间未知"}</small></div>
      <span className="latency"><i>▮▮▮</i> {data.vps.latency === undefined ? "—" : `${data.vps.latency} ms`}</span>
    </div>
    <div className="server-gauges">{data.vps.gauges.map(({ label, value }) => (
      <div className="gauge" key={label} style={{ "--gauge-value": `${value}%` } as CSSProperties}><strong>{value}%</strong><span>{label}</span></div>
    ))}</div>
    <div className="server-network"><span>IP 所在地</span><span className="vps-location-value">{locationLine}</span></div><div className="server-network"><span>网络 / 采样</span><span>↓ {formatBytes(data.vps.network?.downloadBytes)}　↑ {formatBytes(data.vps.network?.uploadBytes)}{data.vps.network?.uploadBytes === undefined && data.vps.network?.downloadBytes === undefined && data.vps.network?.totalBytes !== undefined ? ` · 合计 ${formatBytes(data.vps.network.totalBytes)}` : ""}</span></div>
    <div className="server-services">{data.vps.services.map((service) => <span key={service.name}><i className={`live-dot state-dot-${service.state}`} /> {service.name} · {service.state === "unknown" ? "未知" : service.state === "online" ? "在线" : "离线"}</span>)}</div>
    {(data.vps.error || data.vps.lastSuccessAt) && <small className="server-last-success">{data.vps.error ? `${data.vps.error} · ` : ""}{data.vps.lastSuccessAt ? `来源时间 ${new Date(data.vps.lastSuccessAt).toLocaleString("zh-CN")}` : "尚无成功连接记录"}</small>}
    {showDetails && <div className="widget-source-details"><p><strong>数据来源</strong><span>{data.vps.serverId ? `Beszel · 系统 ${data.vps.serverId}` : data.vps.statusMessage || "尚未连接 Beszel"}</span></p><p><strong>来源时间</strong><span>{data.vps.lastUpdated ? new Date(data.vps.lastUpdated).toLocaleString("zh-CN") : "未确认"}</span></p><p><strong>本机读取</strong><span>{data.vps.lastFetchedAt ? new Date(data.vps.lastFetchedAt).toLocaleString("zh-CN") : "尚无读取记录"}</span></p><p><strong>读取状态</strong><span>{diagnostic?.error || data.vps.error || (state === "unknown" ? "未配置或数据不可用" : stateLabel)}</span></p>{locationDetails}</div>}
  </article>;
}

function HealthWidget({ data }: WidgetProps) {
  const state = data.health.state ?? "normal";
  const status = data.health.eventLogStatus;
  const statusLabel = status === "ok" ? "已读取"
    : status === "partial" ? "部分通道不可读"
      : status === "unavailable" || status === "error" ? "不可用"
        : "等待扫描";
  const events = data.health.events ?? [];
  const icon = state === "offline" ? "!" : state === "warning" ? "▲" : "✓";
  return <article className="widget-card">
    <CardHeading glyph="⌁" title="系统健康" />
    <div className={`health-banner state-${state}`}><span>{icon}</span><div><strong>{data.health.summary || "等待数据"}</strong><small>{data.health.detail}</small></div></div>
    <div className="health-event-status"><span>Windows Event Log</span><strong className={`event-log-${status ?? "pending"}`}>{statusLabel}</strong>
      <span>最近扫描</span><strong>{data.health.lastScanAt ? new Date(data.health.lastScanAt).toLocaleString("zh-CN") : "尚未扫描"}</strong>
    </div>
    <div className="health-events" aria-label="近期重点系统事件">
      {events.length === 0
        ? <div className="health-empty">{status === "ok" ? "无异常 · 未发现近期重点事件" : status === "partial" ? "本次仅完成部分事件通道扫描" : status === "unavailable" || status === "error" ? "无法读取 Windows 事件日志" : "等待事件扫描"}</div>
        : events.slice(0, 5).map((event) => <details className={`health-event severity-${event.severity}`} key={event.id}>
          <summary><span className="event-severity-mark">{event.severity === "critical" ? "!" : event.severity === "error" ? "▲" : "i"}</span>
            <span className="event-summary"><strong>{event.category} · {event.eventId}</strong><small>{new Date(event.timestamp).toLocaleString("zh-CN")} · {event.source}</small></span>
            <span className="event-expand">›</span>
          </summary>
          <div className="health-event-detail"><small>{event.channel} 日志 · {event.level}{event.relatedProcess ? ` · ${event.relatedProcess}` : ""}</small><p>{event.message}</p></div>
        </details>)}
    </div>
  </article>;
}

function NoticesWidget({ data, onOpenNotifications }: WidgetProps) {
  return <article className="widget-card">
    <CardHeading glyph="♧" title="最近通知 / 异常"><button className="card-link" onClick={onOpenNotifications}>查看全部 <span>›</span></button></CardHeading>
    <div className="notice-list">{!data.notices.length && <div className="health-empty">暂无异常通知</div>}{data.notices.map((notice) => (
      <div className="notice-row" key={notice.id ?? notice.title}><span className={`notice-icon ${notice.tone}`}>{notice.icon}</span>
        <div><strong>{notice.title}</strong><small>{notice.detail}</small></div><span className="notice-arrow">›</span>
      </div>
    ))}</div>
  </article>;
}

interface VpsHistoryEntry {
  sourceTimeVerified?: boolean;
  serverId?: string;
  cpu?: number | null;
  memory?: number | null;
  disk?: number | null;
  network?: { uploadBytes?: number; downloadBytes?: number; totalBytes?: number; uploadBps?: number; downloadBps?: number; totalBps?: number } | null;
  status?: string;
}

function totalNetworkBytes(network: VpsHistoryEntry["network"]) {
  if (!network) return undefined;
  const total = network.totalBytes ?? network.totalBps;
  if (total !== undefined) return total;
  const upload = network.uploadBytes ?? network.uploadBps;
  const download = network.downloadBytes ?? network.downloadBps;
  return upload === undefined && download === undefined ? undefined : (upload ?? 0) + (download ?? 0);
}

function trendPoints(values: Array<number | undefined>, normalize = false) {
  const available = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (available.length === 0) return null;
  const tail = available.slice(-36);
  const maximum = normalize ? Math.max(1, ...tail) : 100;
  const points = tail.map((value, index) => {
    const x = tail.length < 2 ? (index === 0 ? 0 : 108) : Math.round(index * 108 / (tail.length - 1));
    const y = Math.round(31 - Math.min(100, Math.max(0, value / maximum * 100)) * 0.28);
    return `${x},${y}`;
  });
  return points.length === 1 ? `${points[0]} 108,${points[0].split(",")[1]}` : points.join(" ");
}

function formatBytes(value?: number) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value.toFixed(0)} B`;
}

function hardwareBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let index = 0;
  while (amount >= 1_000 && index < units.length - 1) { amount /= 1_000; index += 1; }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function hardwareRate(value: number | null) {
  return value === null || !Number.isFinite(value) ? "—" : `${hardwareBytes(value)}/s`;
}

function HardwareWidget({ data, simulationEnabled }: WidgetProps) {
  const snapshot = data.hardware;
  const issue = data.providerDiagnostics.find((item) => item.providerId === "hardware-status" && item.status !== "normal");
  const stale = issue?.status === "stale";
  const metricLabel = (status?: string) => stale && status === "available" ? "已过期" : ({
    available: "实时",
    sampling: "采样中",
    unavailable: "不可用",
    unsupported: "接口不支持",
  }[status ?? ""] ?? "等待数据");
  const percent = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : `${value.toFixed(0)}%`;
  const lastSampled = snapshot?.sampledAtUnixMs ? new Date(snapshot.sampledAtUnixMs).toLocaleTimeString("zh-CN") : "尚未采样";

  return <article className="widget-card hardware-widget">
    <CardHeading glyph="▣" title="本机硬件">
      <span className="hardware-sampled-at">{stale ? "已过期 · " : ""}{lastSampled}</span>
    </CardHeading>
    {!snapshot
      ? <div className={`hardware-empty${issue ? ` provider-hint status-${issue.status}` : ""}`}>{simulationEnabled ? "开发模拟已暂停真实硬件采样" : issue?.error || "等待本机硬件采样"}</div>
      : <>
        <div className="hardware-metrics">
          <section className="hardware-metric">
            <div className="hardware-metric-heading"><strong>CPU</strong><span>{metricLabel(snapshot.cpu.usageStatus)}</span></div>
            <b>{percent(snapshot.cpu.usagePercent)}</b>
            <div className="hardware-progress"><i style={{ width: `${snapshot.cpu.usagePercent ?? 0}%` }} /></div>
            <small>温度 · {snapshot.cpu.temperatureC === null ? metricLabel(snapshot.cpu.temperatureStatus) : `${snapshot.cpu.temperatureC.toFixed(0)}°C`}</small>
          </section>
          <section className="hardware-metric">
            <div className="hardware-metric-heading"><strong>内存</strong><span>{metricLabel(snapshot.memory.status)}</span></div>
            <b>{percent(snapshot.memory.usagePercent)}</b>
            <div className="hardware-progress"><i className="memory-progress" style={{ width: `${snapshot.memory.usagePercent ?? 0}%` }} /></div>
            <small>{hardwareBytes(snapshot.memory.usedBytes)} / {hardwareBytes(snapshot.memory.totalBytes)}</small>
          </section>
          <section className="hardware-metric hardware-network">
            <div className="hardware-metric-heading"><strong>网络</strong><span>{metricLabel(snapshot.network.status)}</span></div>
            <div className="hardware-network-values"><small>↓ {hardwareRate(snapshot.network.downloadBytesPerSecond)}</small><small>↑ {hardwareRate(snapshot.network.uploadBytesPerSecond)}</small></div>
            <small>物理网络适配器</small>
          </section>
        </div>
        <div className="hardware-detail-grid">
          <section className="hardware-detail">
            <strong>固定磁盘</strong>
            {snapshot.disks.volumes.length
              ? snapshot.disks.volumes.map((volume) => <div className="hardware-disk" key={volume.name}>
                <div><span>{volume.name}</span><small>{percent(volume.usagePercent)} · {hardwareBytes(volume.usedBytes)} / {hardwareBytes(volume.totalBytes)}</small></div>
                <div className="hardware-progress"><i className="disk-progress" style={{ width: `${volume.usagePercent}%` }} /></div>
              </div>)
              : <small>{metricLabel(snapshot.disks.status)}</small>}
          </section>
          <section className="hardware-detail">
            <strong>图形处理器</strong>
            <div className="hardware-gpu"><span>{snapshot.gpu.name || "GPU"}</span><small>{snapshot.gpu.usagePercent === null ? metricLabel(snapshot.gpu.usageStatus ?? snapshot.gpu.status) : `${percent(snapshot.gpu.usagePercent)} 使用`}</small></div>
            <small>显存 · {snapshot.gpu.memoryUsedBytes === null ? metricLabel(snapshot.gpu.memoryStatus ?? snapshot.gpu.status) : `${hardwareBytes(snapshot.gpu.memoryUsedBytes)} / ${hardwareBytes(snapshot.gpu.memoryTotalBytes)}`}</small>
            <small>温度 · {snapshot.gpu.temperatureC === null ? metricLabel(snapshot.gpu.temperatureStatus ?? snapshot.gpu.status) : `${snapshot.gpu.temperatureC.toFixed(0)}°C`}</small>
            {snapshot.gpu.detail && <small>{snapshot.gpu.detail}</small>}
          </section>
        </div>
        {issue && <small className={`hardware-issue provider-hint status-${issue.status}`}>{stale ? "数据已过期 · " : ""}{issue.error || `${issue.name} · ${issue.status}`}</small>}
      </>}
  </article>;
}

function ResourcesWidget({ data, vpsConsole, effectsEnabled = false, effectPulse = 0 }: WidgetProps) {
  const [history, setHistory] = useState<Array<{ createdAt: string; payload: VpsHistoryEntry }>>([]);
  const [range, setRange] = useState<"1h" | "24h">("1h");
  useEffect(() => {
    let active = true;
    if (!data.vps.serverId) { setHistory([]); return () => { active = false; }; }
    void queryHistoryRecords("vps_history", 500).then((records) => {
      if (!active) return;
      const matching = records.flatMap((record) => {
        const payload = record.payload as VpsHistoryEntry;
        return payload.serverId === data.vps.serverId&&payload.sourceTimeVerified===true ? [{ createdAt: record.createdAt, payload }] : [];
      }).reverse();
      setHistory(matching);
    });
    return () => { active = false; };
  }, [data.vps.serverId, data.vps.lastUpdated]);

  const cutoff = Date.now() - (range === "1h" ? 60 : 24 * 60) * 60_000;
  const samples = history.filter((sample) => new Date(sample.createdAt).getTime() >= cutoff);
  const valueFor = (id: "cpu" | "memory" | "disk") => {
    const value = data.vps.gauges.find((gauge) => gauge.label === ({ cpu: "CPU", memory: "内存", disk: "硬盘" }[id]))?.value;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
  };
  const rates = data.vps.network;
  const networkTotal = totalNetworkBytes(rates);
  const [bursts, setBursts] = useState({ cpu: 0, network: 0 });
  const previous = useRef<{ at: number; cpu: number | null; network: number | null; serverId?: string } | null>(null);
  const lastPulse = useRef(effectPulse), revision = useRef(0);
  const sampleAt = Date.parse(data.vps.lastSuccessAt ?? ""), cpu = valueFor("cpu") ?? null;
  const network = typeof rates?.downloadBytes === "number" && Number.isFinite(rates.downloadBytes) && rates.downloadBytes >= 0 ? rates.downloadBytes : null;
  useEffect(() => {
    const before = previous.current, demonstrate = lastPulse.current !== effectPulse;
    lastPulse.current = effectPulse;
    if (!vpsConsole || !effectsEnabled || !Number.isFinite(sampleAt)) { previous.current = null; setBursts({ cpu: 0, network: 0 }); return; }
    previous.current = { at: sampleAt, cpu, network, serverId: data.vps.serverId };
    const adjacent = before && before.serverId === data.vps.serverId && sampleAt > before.at && sampleAt - before.at <= 330000;
    const cpuJump = cpu !== null && (demonstrate || !!adjacent && cpuParticleBurst(before.cpu, cpu).length > 0);
    const networkJump = network !== null && (demonstrate || !!adjacent && networkTrendSpike(before.network, network));
    if (!cpuJump && !networkJump) { setBursts({ cpu: 0, network: 0 }); return; }
    const id = ++revision.current; setBursts({ cpu: cpuJump ? id : 0, network: networkJump ? id : 0 });
    const timer = window.setTimeout(() => setBursts({ cpu: 0, network: 0 }), 1150);
    return () => window.clearTimeout(timer);
  }, [vpsConsole, effectsEnabled, effectPulse, sampleAt, cpu, network, data.vps.serverId]);
  const charts = [
    { id: "cpu", name: "CPU", color: "blue", value: valueFor("cpu"), points: trendPoints(samples.map((item) => item.payload.cpu ?? undefined)) },
    { id: "memory", name: "内存", color: "green", value: valueFor("memory"), points: trendPoints(samples.map((item) => item.payload.memory ?? undefined)) },
    { id: "disk", name: "硬盘", color: "cyan", value: valueFor("disk"), points: trendPoints(samples.map((item) => item.payload.disk ?? undefined)) },
    { id: "network", name: "网络", color: "violet", value: undefined, points: trendPoints(samples.map((item) => totalNetworkBytes(item.payload.network)), true), network: true },
  ];
  return <article className={`widget-card${vpsConsole ? " vps-console-trends" : ""}`}>
    <CardHeading glyph="▥" title={vpsConsole ? "性能趋势" : `VPS 资源 · ${data.vps.name || "Beszel"}`}>
      <select aria-label="资源采样时间" value={range} onChange={(event) => setRange(event.target.value as "1h" | "24h")}><option value="1h">过去 1 小时</option><option value="24h">过去 24 小时</option></select>
    </CardHeading>
    {vpsConsole && <p className="vps-trends-caption">CPU、内存与磁盘占用 · 网络采样流量</p>}
    <div className="metric-grid">{charts.map((metric) => (
      <div className={`metric-panel metric-${metric.id}${effectsEnabled && metric.points ? " vps-trend-live" : ""}`} key={metric.id}>
        <div className="metric-label"><span>{metric.name}</span><strong>{metric.network ? formatBytes(networkTotal) : metric.value === undefined ? "—" : `${metric.value.toFixed(0)}%`}</strong></div>
        {metric.network && <small className="network-up">↓ {formatBytes(rates?.downloadBytes)} <span>↑ {formatBytes(rates?.uploadBytes)}</span></small>}
        <div className="chart-area"><span className="chart-axis">{vpsConsole ? <><span>{metric.network ? "峰值" : "100%"}</span><span>50%</span><span>{metric.network ? "0" : "0%"}</span></> : metric.network ? <>峰值<br /><br />50%<br /><br />0</> : <>100%<br /><br />50%<br /><br />0%</>}</span>
          {vpsConsole && !metric.points && <span className="vps-chart-empty">暂无{metric.name}历史</span>}
          {metric.points && <svg viewBox="0 0 108 34" preserveAspectRatio="none" role="img" aria-label={`${metric.name} 最近使用趋势`}>
            <defs><linearGradient id={`fill-${metric.id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={`var(--${metric.color})`} stopOpacity=".34" /><stop offset="100%" stopColor={`var(--${metric.color})`} stopOpacity="0" /></linearGradient></defs>
            <polygon points={`0,34 ${metric.points} 108,34`} fill={`url(#fill-${metric.id})`} />
            {effectsEnabled && <g className={`vps-trend-glow vps-trend-glow-${metric.id}`} aria-hidden="true"><polyline points={metric.points} fill="none" vectorEffect="non-scaling-stroke"/></g>}
            {effectsEnabled && metric.id === "cpu" && <g className="vps-cpu-tail" aria-hidden="true"><polyline points={metric.points} fill="none" vectorEffect="non-scaling-stroke"/></g>}
            {effectsEnabled && metric.id === "cpu" && bursts.cpu > 0 && <g key={bursts.cpu} className="vps-cpu-heartbeat" aria-hidden="true"><polyline points={metric.points} fill="none" vectorEffect="non-scaling-stroke"/></g>}
            {effectsEnabled && metric.id === "network" && bursts.network > 0 && <g key={bursts.network} className="vps-network-grow" aria-hidden="true"><polyline points={metric.points} fill="none" vectorEffect="non-scaling-stroke"/></g>}
            <polyline className="vps-trend-actual" points={metric.points} fill="none" stroke={`var(--${metric.color})`} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>}
        </div>{effectsEnabled && metric.id === "network" && metric.points && bursts.network > 0 && <span key={bursts.network} className="fx-trend-network-flash" aria-hidden="true"/>}<small className="chart-time">{samples.length ? `${samples.length} 个历史点` : "等待真实历史数据"}<span>{data.vps.lastUpdated ? new Date(data.vps.lastUpdated).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "未连接"}</span></small>
      </div>
    ))}</div>
  </article>;
}

function DockWidget({ data, applications, onLaunchApplication, onManageApplications }: WidgetProps) {
  const apps = applications ?? data.applications.map((app, order) => ({ ...app, icon: "", type: "exe" as const, target: "", pinned: true, order }));
  return <article className="widget-card dock-card"><CardHeading glyph="▦" title="快捷启动"><button className="card-link" onClick={onManageApplications}>管理应用 <span>›</span></button></CardHeading>
    <div className="app-dock">{apps.filter((app) => app.pinned).sort((left, right) => left.order - right.order).map((app) => (
      <button className="dock-item" key={app.id} title={app.target ? `打开 ${app.name}` : `${app.name} 尚未配置`} onClick={() => onLaunchApplication?.(app)}>
        <AppGlyph application={app} /><small>{app.name}</small>
      </button>
    ))}<button className="add-app" title="添加应用" onClick={onManageApplications}>＋</button></div>
  </article>;
}

const renderers: Record<string, Renderer> = {
  codex: AgentQuotaWidget,
  api: ApiBalanceWidget,
  vps: VpsWidget,
  health: HealthWidget,
  notices: NoticesWidget,
  resources: ResourcesWidget,
  hardware: HardwareWidget,
  "pc-overview": PcOverview,
  "pc-gpu": PcGpu,
  "pc-disks": PcDisks,
  "pc-trends": PcTrends,
  dock: DockWidget,
};

export function WidgetCard({ id, ...props }: WidgetProps & { id: string }) {
  const renderer = renderers[id];
  const definition = widgetRegistry.find((item) => item.id === id);
  if (!renderer || !definition) return <article className="widget-card">未知组件：{id}</article>;
  if(id==="resources"&&props.compact)return <OverviewTrends data={props.data} vpsHubUrl={props.vpsHubUrl} simulationEnabled={props.simulationEnabled} />;
  const Widget = renderer;
  return <Widget {...props} />;
}

interface WidgetErrorBoundaryProps { widgetId: string; children: ReactNode; recoverable?: boolean }
const knownErrorTypes = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError"]);
function recoverableErrorType(value: unknown): string {
  try {
    if (!(value instanceof Error)) return "Error";
    const name = value.name;
    return typeof name === "string" && knownErrorTypes.has(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

export class WidgetErrorBoundary extends Component<WidgetErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    if (this.props.recoverable) {
      logEvent("error", "widget.render_failed", { widgetId: this.props.widgetId, errorType: recoverableErrorType(error) });
    } else {
      logEvent("error", "widget.render_failed", { widgetId: this.props.widgetId, message: error.message.slice(0, 160) });
    }
  }

  render() {
    return this.state.failed
      ? <article className="widget-card widget-error" role="alert">组件暂时无法显示{this.props.recoverable&&<button type="button" onClick={()=>this.setState({failed:false})}>重试显示</button>}</article>
      : this.props.children;
  }
}

function apiGlyph(api: ProviderStatus) {
  return ({ deepseek: "D", mimo: "M", openai: "◎", anthropic: "A" } as Record<string, string>)[api.id] ?? "•";
}
