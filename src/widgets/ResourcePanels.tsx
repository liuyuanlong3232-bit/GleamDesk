import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { DashboardData, HardwareSnapshot, HistoryRecord } from "../types";
import { queryHistoryRecords } from "../services/historyStore";
import { isWindowVisible, subscribeWindowVisibility } from "../services/windowVisibility";
import { vpsObservationFromHistory } from "../adapters/history/vpsHistory";

export function bytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  let amount = value, index = 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  while (amount >= 1000 && index < 4) { amount /= 1000; index++; }
  return `${amount.toFixed(index ? 1 : 0)} ${units[index]}`;
}
const percent = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(0)}%`;
export const metricState = (state?: string) => ({ available: "可用", sampling: "采样中", unsupported: "不支持", unavailable: "暂不可用" }[state ?? ""] ?? "未知");
function Head({ title, data }: { title: string; data: DashboardData }) {
  const diagnostic = data.providerDiagnostics.find(item => item.providerId === "hardware-status");
  return <div className="card-heading"><strong>{title}</strong><span className="resource-source">{diagnostic?.status === "stale" ? "已过期" : data.hardware ? "实时" : "未知"} · {data.hardware ? new Date(data.hardware.sampledAtUnixMs).toLocaleTimeString("zh-CN") : "等待采样"}</span></div>;
}
// Visual-only test effects never replace a metric or infer disk I/O from capacity.
export function resourceEffectLoad(value:number|null|undefined,status?:string):number|null {
  return status==="available"&&typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=100?value:null;
}
export function cpuParticleBurst(previous:number|null,current:number|null) {
  if(previous===null||current===null||!Number.isFinite(previous)||!Number.isFinite(current)||previous<0||previous>100||current<0||current>100||Math.abs(current-previous)<3)return [];
  const angle=current/100*Math.PI*2-Math.PI/2;
  return Array.from({length:Math.min(12,4+Math.floor(Math.abs(current-previous)/3))},(_,index)=>{
    const direction=angle+(index-4)*.16;
    return {x:Math.cos(angle)*29,y:Math.sin(angle)*29,dx:Math.cos(direction)*(15+index*2),dy:Math.sin(direction)*(15+index*2),delay:index*18};
  });
}
export function CpuParticles({load,enabled,pulse}:{load:number|null;enabled:boolean;pulse:number}) {
  const previous=useRef<number|null>(null),lastPulse=useRef(pulse),batch=useRef(0);
  const [particles,setParticles]=useState<ReturnType<typeof cpuParticleBurst>>([]);
  useEffect(()=>{
    const before=previous.current,demonstrate=pulse!==lastPulse.current;previous.current=load;lastPulse.current=pulse;
    if(!enabled){setParticles([]);return;}
    const next=demonstrate?cpuParticleBurst(40,64):cpuParticleBurst(before,load);
    if(!next.length){setParticles([]);return;}
    batch.current++;setParticles(next);
    // One bounded burst, no overlapping particle arrays or animation loop.
    const timer=window.setTimeout(()=>setParticles([]),1100);
    return()=>window.clearTimeout(timer);
  },[load,enabled,pulse]);
  return enabled?<span className="fx-cpu-particles" aria-hidden="true">{particles.map((particle,index)=><i key={`${batch.current}:${index}`} style={{"--particle-x":`${particle.x}px`,"--particle-y":`${particle.y}px`,"--particle-dx":`${particle.dx}px`,"--particle-dy":`${particle.dy}px`,"--particle-delay":`${particle.delay}ms`} as CSSProperties}/>)}</span>:null;
}
export function PcOverview({data,effectsEnabled=false,effectPulse=0}: {data: DashboardData;effectsEnabled?:boolean;effectPulse?:number}) {
  const s = data.hardware;
  const metrics = [
    {name:"CPU",kind:"cpu", value:s?.cpu.usagePercent, status:s?.cpu.usageStatus, detail:s?.cpu.temperatureC == null ? `温度 ${metricState(s?.cpu.temperatureStatus)}` : `${s.cpu.temperatureC.toFixed(0)}°C`},
    {name:"内存",kind:"memory", value:s?.memory.usagePercent, status:s?.memory.status, detail:`${bytes(s?.memory.usedBytes)} / ${bytes(s?.memory.totalBytes)}`},
    {name:"GPU",kind:"gpu", value:s?.gpu.usagePercent, status:s?.gpu.usageStatus ?? s?.gpu.status, detail:s?.gpu.name ?? "未知设备"},
    {name:"网络",kind:"network", value:null, status:s?.network.status, detail:`↓ ${bytes(s?.network.downloadBytesPerSecond)}/s · ↑ ${bytes(s?.network.uploadBytesPerSecond)}/s`},
  ];
  return <article className="widget-card"><Head title="本机资源" data={data}/><div className="resource-rings">{metrics.map(m=>{const load=resourceEffectLoad(m.value,m.status);return <section key={m.name}><div className={`resource-ring resource-ring-${m.kind}${effectsEnabled&&load!==null?" fx-metric-live":""}${load!==null&&load>=80?" fx-high-load":""}`} style={{"--ring":`${Math.min(100,Math.max(0,m.value??0))}%`} as CSSProperties}><strong>{m.name==="网络" ? "⇅" : percent(m.value)}</strong>{m.kind==="cpu"&&<CpuParticles load={load} enabled={effectsEnabled} pulse={effectPulse}/>}</div><b>{m.name}</b><small>{metricState(m.status)}</small><small>{m.detail}</small></section>;})}</div></article>;
}
export function diskIoRate(read:number|null|undefined,write:number|null|undefined,status?:string):number|null {
  return status==="available"&&typeof read==="number"&&typeof write==="number"&&Number.isFinite(read)&&Number.isFinite(write)&&read>=0&&write>=0&&Number.isFinite(read+write)?read+write:null;
}
export function PcDisks({data,effectsEnabled=false}:{data:DashboardData;effectsEnabled?:boolean}) {
  return <article className="widget-card disk-panel"><Head title="磁盘容量与读写" data={data}/><div className="resource-disks">{data.hardware?.disks.volumes.map(volume=>{const io=diskIoRate(volume.readBytesPerSecond,volume.writeBytesPerSecond,volume.ioStatus);return <section key={volume.name}><div><strong>{volume.name}</strong><b>{percent(volume.usagePercent)}</b></div><div className={`hardware-progress${effectsEnabled&&io!==null&&io>0?" fx-disk-live":""}`}><i style={{width:`${Math.min(100,Math.max(0,volume.usagePercent))}%`}}/></div><small>{bytes(volume.usedBytes)} / {bytes(volume.totalBytes)}</small><div className="disk-io-rates"><span>读取 <b>{io===null?"—":`${bytes(volume.readBytesPerSecond)}/s`}</b></span><span>写入 <b>{io===null?"—":`${bytes(volume.writeBytesPerSecond)}/s`}</b></span></div><small className="disk-io-source">{io!==null?"实时读写":volume.ioStatus==="sampling"?"读写速率采样中":volume.ioStatus?"读写速率不可用":"读写速率尚未接入"}</small></section>;}) ?? <p>等待磁盘采样</p>}{data.hardware?.disks.volumes.length===0&&<p>{metricState(data.hardware.disks.status)}</p>}</div></article>;
}
export function PcGpu({data,effectsEnabled=false}:{data:DashboardData;effectsEnabled?:boolean}) {
  const gpu=data.hardware?.gpu,load=resourceEffectLoad(gpu?.usagePercent,gpu?.usageStatus??gpu?.status);
  return <article className={`widget-card gpu-panel${effectsEnabled&&load!==null?" fx-gpu-live":""}`} style={{"--gpu-grid-opacity":load===null?0:.06+load/100*.3,"--gpu-grid-glow":load===null?0:load/100} as CSSProperties}>{effectsEnabled&&load!==null&&<span className="fx-gpu-grid" aria-hidden="true"/>}<Head title="GPU 详情" data={data}/><h3>{gpu?.name||"未知设备"}</h3><div className="gpu-value"><b>{percent(gpu?.usagePercent)}</b><small>利用率 · {metricState(gpu?.usageStatus??gpu?.status)}</small></div><div className="gpu-value"><b>{gpu?.temperatureC==null?"—":`${gpu.temperatureC.toFixed(0)}°C`}</b><small>温度 · {metricState(gpu?.temperatureStatus??gpu?.status)}</small></div><div className="gpu-value"><b>{bytes(gpu?.memoryUsedBytes)}</b><small>显存 / {bytes(gpu?.memoryTotalBytes)} · {metricState(gpu?.memoryStatus??gpu?.status)}</small></div><details><summary>设备信息</summary><p>{gpu?.source||"来源未知"}</p>{gpu?.detail&&<small>{gpu.detail}</small>}</details></article>;
}
export interface TrendSample { at:number; value:number|null }
// Preserve timestamps and missing observations. Never bridge gaps with invented values.
export function trendSegments(samples:TrendSample[],from:number,to:number,normalize=false):string[] {
  const usable=samples.filter(s=>Number.isFinite(s.at)&&s.at>=from&&s.at<=to);
  const max=normalize?Math.max(1,...usable.map(s=>s.value!=null&&Number.isFinite(s.value)?s.value:0)):100;
  const segments:string[]=[];let points:string[]=[];let previous:number|null=null;
  for(const sample of usable){
    if(sample.value==null||!Number.isFinite(sample.value)||(previous!==null&&sample.at-previous>120000)){if(points.length>1)segments.push(points.join(" "));points=[];}
    if(sample.value!=null&&Number.isFinite(sample.value))points.push(`${((sample.at-from)/(to-from)*300).toFixed(2)},${(62-Math.min(1,Math.max(0,sample.value/max))*58).toFixed(2)}`);
    previous=sample.at;
  }
  if(points.length>1)segments.push(points.join(" "));return segments;
}
type OverviewTrendHistory = { identity: string; hardware: TrendSample[]; vps: TrendSample[] };
const historyProvenance = (payload: unknown, providerId: string) => {
  if (!payload || typeof payload !== "object") return false;
  const provenance = (payload as { provenance?: unknown }).provenance;
  return !!provenance && typeof provenance === "object"
    && (provenance as { mode?: unknown }).mode === "live"
    && (provenance as { providerId?: unknown }).providerId === providerId;
};
const normalizedHubUrl = (value: string) => value.trim().replace(/\/+$/, "");

export function overviewTrendSamples(
  hardwareRows: HistoryRecord[], vpsRows: HistoryRecord[], hubUrl: string, serverId: string, from: number, to: number,
): { hardware: TrendSample[]; vps: TrendSample[] } {
  const hardware = hardwareRows.flatMap((record) => {
    if (record.kind !== "hardware_history" || !historyProvenance(record.payload, "hardware-status")) return [];
    const snapshot = record.payload as Partial<HardwareSnapshot>;
    const at = snapshot.sampledAtUnixMs;
    const value = snapshot.cpu?.usagePercent;
    if (typeof at !== "number" || !Number.isFinite(at) || at < from || at > to) return [];
    return [{ at, value: snapshot.cpu?.usageStatus === "available" && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null }];
  }).sort((left, right) => left.at - right.at);
  const normalizedHub = normalizedHubUrl(hubUrl);
  const vps = !normalizedHub || !serverId ? [] : vpsRows.flatMap((record) => {
    if (!historyProvenance(record.payload, "vps-status")) return [];
    const observation = vpsObservationFromHistory(record, normalizedHub, serverId);
    const at = observation?.observedAt ? Date.parse(observation.observedAt) : NaN;
    const value = observation?.cpuPercent;
    if (observation?.availability !== "ready" || observation.sourceTimeVerified!==true || !Number.isFinite(at) || at < from || at > to) return [];
    return [{ at, value: typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null }];
  }).sort((left, right) => left.at - right.at);
  return { hardware, vps };
}

function OverviewTrendChart({ title, samples, from, to }: { title: string; samples: TrendSample[]; from: number; to: number }) {
  const segments = trendSegments(samples, from, to);
  return <section className="overview-trend-chart">
    <header><b>{title}</b><small>0–100%</small></header>
    {segments.length
      ? <svg viewBox="0 0 300 66" preserveAspectRatio="none" role="img" aria-label={`${title}最近30分钟真实趋势 0到100%`}>
        <line x1="0" y1="4" x2="300" y2="4" className="overview-trend-axis" />
        <line x1="0" y1="62" x2="300" y2="62" className="overview-trend-axis" />
        {segments.map((points, index) => <polyline key={index} points={points} />)}
      </svg>
      : <small className="overview-trend-empty">有效观测不足</small>}
  </section>;
}

export function OverviewTrends({ data, vpsHubUrl = "", simulationEnabled = false }: { data: DashboardData; vpsHubUrl?: string; simulationEnabled?: boolean }) {
  const serverId = data.vps.serverId ?? "";
  const hubUrl = normalizedHubUrl(vpsHubUrl);
  const identity = `${hubUrl}::${serverId}`;
  const hardwareBucket = Math.floor((data.hardware?.sampledAtUnixMs ?? 0) / 30_000);
  const [history, setHistory] = useState<OverviewTrendHistory>({ identity, hardware: [], vps: [] });

  useEffect(() => {
    let active = true;
    if (simulationEnabled) {
      setHistory({ identity, hardware: [], vps: [] });
      return () => { active = false; };
    }
    setHistory(current => current.identity === identity ? current : { identity, hardware: [], vps: [] });
    const load = () => {
      if (!active || !isWindowVisible()) return;
      void Promise.all([
        queryHistoryRecords("hardware_history", 500),
        hubUrl && serverId ? queryHistoryRecords("vps_history", 500) : Promise.resolve([]),
      ]).then(([hardwareRows, vpsRows]) => {
        if (!active) return;
        const to = Date.now(), from = to - 30 * 60_000;
        const selected = overviewTrendSamples(hardwareRows, vpsRows, hubUrl, serverId, from, to);
        setHistory({ identity, ...selected });
      }).catch(() => {
        if (active) setHistory({ identity, hardware: [], vps: [] });
      });
    };
    load();
    const unsubscribe = subscribeWindowVisibility(() => { if (isWindowVisible()) load(); });
    return () => { active = false; unsubscribe(); };
  }, [identity, hubUrl, serverId, data.vps.lastSuccessAt, hardwareBucket, simulationEnabled]);

  const to = Date.now(), from = to - 30 * 60_000;
  const visibleHistory = history.identity === identity && !simulationEnabled ? history : { identity, hardware: [], vps: [] };
  const vpsSuccessAt = data.vps.lastSuccessAt ? Date.parse(data.vps.lastSuccessAt) : NaN;
  const vpsRecent = !!hubUrl && !!serverId && Number.isFinite(vpsSuccessAt) && vpsSuccessAt >= from && vpsSuccessAt <= to;
  const vpsSamples = vpsRecent ? visibleHistory.vps.filter(sample => sample.at >= from && sample.at <= to) : [];
  const vpsCpu = vpsSamples.at(-1)?.value;
  const hardwareIssue = data.providerDiagnostics.find(item => item.providerId === "hardware-status");
  const rawCpuValue = data.hardware?.cpu.usagePercent;
  const cpuValue = data.hardware?.cpu.usageStatus === "available" && typeof rawCpuValue === "number" && Number.isFinite(rawCpuValue) && rawCpuValue >= 0 && rawCpuValue <= 100 ? rawCpuValue : null;
  const hardwareSampleAt = data.hardware?.sampledAtUnixMs;
  const hardwareCpuLive = typeof hardwareSampleAt === "number" && Number.isFinite(hardwareSampleAt) && hardwareSampleAt <= to && to - hardwareSampleAt <= 10_000;
  const hardwareDiagnosticReliable = hardwareIssue?.status === "normal" || hardwareIssue?.status === "degraded";
  const cpuLabel = hardwareIssue?.status === "stale" || (hardwareIssue && hardwareDiagnosticReliable && !hardwareCpuLive) ? "数据已过期"
    : hardwareIssue?.status === "error" || hardwareIssue?.status === "unavailable" ? "数据不可用"
      : hardwareDiagnosticReliable && hardwareCpuLive && cpuValue !== null ? "实时更新" : "等待 CPU 数据";
  const vpsStatus = vpsRecent ? (data.vps.state === "online" ? "在线" : data.vps.state === "offline" ? "离线" : data.vps.state === "warning" ? "警告" : "状态未知") : "状态未知";
  return <article className="widget-card overview-trends">
    <div className="card-heading"><span className="heading-glyph">▥</span><strong>VPS / PC 关键摘要</strong><small className="resource-source">{simulationEnabled ? "模拟模式 · 真实历史暂停" : "最近30分钟"}</small></div>
    <div className="overview-summary-grid">
      <div><span>VPS · {data.vps.name || "Beszel"}</span><strong>{simulationEnabled ? "模拟模式" : vpsStatus}</strong><small>{simulationEnabled ? "模拟期间不读取真实历史" : vpsRecent ? `CPU ${typeof vpsCpu === "number" ? `${vpsCpu.toFixed(0)}%` : "未知"} · 最近更新` : "有效观测不足"}</small></div>
      <div><span>本机</span><strong>{simulationEnabled ? "模拟模式" : cpuValue === null ? "CPU 未知" : `CPU ${cpuValue.toFixed(0)}%`}</strong><small>{simulationEnabled ? "真实历史暂停" : cpuLabel}</small></div>
    </div>
    <div className="overview-trend-grid">
      <OverviewTrendChart title="VPS CPU" samples={vpsSamples} from={from} to={to} />
      <OverviewTrendChart title="本机 CPU" samples={visibleHistory.hardware.filter(sample => sample.at >= from && sample.at <= to)} from={from} to={to} />
    </div>
  </article>;
}

export function networkTrendSpike(previous:number|null,current:number|null):boolean {
  return previous!==null&&current!==null&&Number.isFinite(previous)&&Number.isFinite(current)&&previous>=0&&current>=0&&current>Math.max(previous*2.5,previous+64000);
}
export function hardwareTrendSeries(samples:HardwareSnapshot[]) {
  return [
    {kind:"cpu",name:"CPU",values:samples.map(s=>({at:s.sampledAtUnixMs,value:resourceEffectLoad(s.cpu?.usagePercent,s.cpu?.usageStatus)}))},
    {kind:"memory",name:"内存",values:samples.map(s=>({at:s.sampledAtUnixMs,value:resourceEffectLoad(s.memory?.usagePercent,s.memory?.status)}))},
    {kind:"disk",name:"磁盘读写",normalize:true,values:samples.map(s=>({at:s.sampledAtUnixMs,value:diskIoRate(s.disks?.readBytesPerSecond,s.disks?.writeBytesPerSecond,s.disks?.ioStatus)}))},
    {kind:"network",name:"网络下载",normalize:true,values:samples.map(s=>({at:s.sampledAtUnixMs,value:s.network?.status==="available"&&typeof s.network.downloadBytesPerSecond==="number"&&Number.isFinite(s.network.downloadBytesPerSecond)&&s.network.downloadBytesPerSecond>=0?s.network.downloadBytesPerSecond:null}))},
  ];
}
export function ResourceTrendChart({kind,title,values,from,to,normalize=false,effectsEnabled=false,pulse=0,memoryLoad=null,diskActive=false}:{kind:string;title:string;values:TrendSample[];from:number;to:number;normalize?:boolean;effectsEnabled?:boolean;pulse?:number;memoryLoad?:number|null;diskActive?:boolean}) {
  const segments=trendSegments(values,from,to,normalize),glow=effectsEnabled&&segments.length>0;
  const specks=kind==="disk"&&glow&&diskActive?segments.flatMap(points=>points.split(" ")).filter((_,index)=>index%3===0).slice(-14):[];
  return <section className={`resource-trend-${kind}${glow?" fx-trend-enabled":""}`} style={{"--memory-microshift":`${Math.min(100,Math.max(0,memoryLoad??0))/100*.6}px`} as CSSProperties}><b>{title}{kind==="disk"&&effectsEnabled&&<small className="fx-trend-disk-note">读 + 写 · B/s</small>}</b>{segments.length?<svg viewBox="0 0 300 66" preserveAspectRatio="none" role="img" aria-label={`${title}真实历史曲线`}>
    {glow&&<g className={`fx-trend-glow fx-trend-glow-${kind}`} aria-hidden="true">{segments.map((points,index)=><polyline key={index} points={points}/>)}</g>}
    {glow&&kind==="cpu"&&<g className="fx-trend-tail" aria-hidden="true">{segments.map((points,index)=><polyline key={index} points={points}/>)}</g>}
    {glow&&pulse>0&&(kind==="cpu"||kind==="network")&&<g key={pulse} className={`fx-trend-burst fx-trend-burst-${kind}`} aria-hidden="true">{segments.map((points,index)=><polyline key={index} points={points}/>)}</g>}
    {glow&&kind==="disk"&&diskActive&&<g className="fx-trend-specks" aria-hidden="true">{specks.map((point,index)=>{const [x,y]=point.split(",");return <circle key={index} cx={x} cy={y} r=".85" style={{"--speck-delay":`${index*137}ms`} as CSSProperties}/>;})}</g>}
    <g className="resource-trend-actual">{segments.map((points,index)=><polyline key={index} points={points}/>)}</g>
  </svg>:<small>有效观测不足</small>}{glow&&kind==="network"&&pulse>0&&<span key={pulse} className="fx-trend-network-flash" aria-hidden="true"/>}</section>;
}
export function PcTrends({data,simulationEnabled,effectsEnabled=false,liveEffectsEnabled=false,effectPulse=0}:{data:DashboardData;simulationEnabled?:boolean;effectsEnabled?:boolean;liveEffectsEnabled?:boolean;effectPulse?:number}) {
  const [samples,setSamples]=useState<HardwareSnapshot[]>([]),[bursts,setBursts]=useState({cpu:0,network:0});
  const previous=useRef<{at:number;cpu:number|null;network:number|null}|null>(null),lastPulse=useRef(effectPulse),revision=useRef(0);
  const sampleAt=data.hardware?.sampledAtUnixMs??0,cpu=resourceEffectLoad(data.hardware?.cpu.usagePercent,data.hardware?.cpu.usageStatus);
  const network=data.hardware?.network.status==="available"?data.hardware.network.downloadBytesPerSecond:null;
  useEffect(()=>{
    const before=previous.current,demonstrate=lastPulse.current!==effectPulse;lastPulse.current=effectPulse;
    if(!effectsEnabled||!liveEffectsEnabled||simulationEnabled){previous.current=null;setBursts({cpu:0,network:0});return;}
    previous.current={at:sampleAt,cpu,network};
    const adjacent=before&&sampleAt>before.at&&sampleAt-before.at<=5000;
    const cpuJump=demonstrate||!!adjacent&&cpuParticleBurst(before.cpu,cpu).length>0;
    const networkJump=demonstrate||!!adjacent&&networkTrendSpike(before.network,network);
    if(!cpuJump&&!networkJump){setBursts({cpu:0,network:0});return;}
    const id=++revision.current;setBursts({cpu:cpuJump?id:0,network:networkJump?id:0});
    const timer=window.setTimeout(()=>setBursts({cpu:0,network:0}),1150);
    return()=>window.clearTimeout(timer);
  },[sampleAt,cpu,network,effectsEnabled,liveEffectsEnabled,effectPulse,simulationEnabled]);
  const hardwareBucket=Math.floor(sampleAt/30000);
  useEffect(()=>{let active=true;if(simulationEnabled){setSamples([]);return;}
    void queryHistoryRecords("hardware_history",500).then(rows=>{if(!active)return;const cutoff=Date.now()-3600000;setSamples(rows.flatMap(row=>{const s=row.payload as HardwareSnapshot&{provenance?:{mode?:string;providerId?:string}};return s?.provenance?.mode==="live"&&s.provenance.providerId==="hardware-status"&&s.sampledAtUnixMs>=cutoff&&s.sampledAtUnixMs<=Date.now()?[s]:[];}).sort((a,b)=>a.sampledAtUnixMs-b.sampledAtUnixMs));});return()=>{active=false;};
  },[hardwareBucket,simulationEnabled]);
  const to=Date.now(),from=to-3600000;
  return <article className="widget-card trend-panel"><div className="card-heading"><strong>本机趋势</strong><small className="resource-source">过去一小时 · {simulationEnabled?"模拟模式 · 真实历史暂停":`${samples.length} 条记录`}</small></div><div className="resource-trend-grid">{hardwareTrendSeries(samples).map(series=><ResourceTrendChart key={series.kind} kind={series.kind} title={series.name} values={series.values} from={from} to={to} normalize={series.normalize} effectsEnabled={effectsEnabled} pulse={series.kind==="cpu"?bursts.cpu:series.kind==="network"?bursts.network:0} memoryLoad={resourceEffectLoad(data.hardware?.memory.usagePercent,data.hardware?.memory.status)} diskActive={liveEffectsEnabled&&(diskIoRate(data.hardware?.disks.readBytesPerSecond,data.hardware?.disks.writeBytesPerSecond,data.hardware?.disks.ioStatus)??0)>0}/>)}</div></article>;
}
