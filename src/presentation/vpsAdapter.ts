import type { VpsObservation,VpsLocation } from "../domain/vps/contracts";
import type { ProviderResultStatus, VpsSnapshot } from "../types";

export function formatVpsUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "运行时间未知";
  const whole = Math.floor(seconds), days = Math.floor(whole / 86_400), hours = Math.floor(whole % 86_400 / 3_600), minutes = Math.floor(whole % 3_600 / 60);
  if (days > 0) return `运行中 ${days} 天 ${hours} 小时`;
  if (hours > 0) return `运行中 ${hours} 小时 ${minutes} 分`;
  return `运行中 ${minutes} 分钟`;
}

export function presentVps(observation: VpsObservation, status: ProviderResultStatus, error?: string): VpsSnapshot {
  const snapshot: VpsSnapshot = {
    name: observation.name,host:observation.host??null,serverId: observation.serverId, state: observation.state,
    uptime: formatVpsUptime(observation.uptimeSeconds), latency: observation.latencyMs ?? undefined,
    gauges: [["CPU", observation.cpuPercent], ["内存", observation.memoryPercent], ["硬盘", observation.diskPercent]]
      .flatMap(([label, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? [{ label: String(label), value }] : []),
    network: { ...observation.network },
    services: observation.services.map(service => ({ ...service })),
    lastUpdated: observation.sourceTimeVerified===false?undefined:observation.observedAt ?? undefined, lastSuccessAt: observation.lastSuccessAt ?? undefined,lastFetchedAt:observation.fetchedAt??undefined,
    error: error ?? observation.error,
    statusMessage: observation.state === "online" ? "在线" : observation.state === "offline" ? "离线" : "状态未知",
  };
  if (observation.availability === "unconfigured") { snapshot.statusMessage = "请在设置中心填写 Beszel Hub、System ID 和 API 令牌"; snapshot.uptime = "等待连接"; }
  if (observation.availability === "platform-unsupported") { snapshot.statusMessage = "Beszel 连接需在 Windows 桌面应用中使用"; snapshot.uptime = "等待连接"; }
  if (observation.availability === "credentials-missing") { snapshot.statusMessage = "尚未配置 API 令牌"; snapshot.uptime = "暂无成功数据"; }
  if (observation.availability === "failed") { snapshot.statusMessage = observation.lastSuccessAt ? "连接失败 · 显示上次成功数据" : "连接失败"; if (!observation.lastSuccessAt) snapshot.uptime = "暂无成功数据"; }
  if (status === "stale") { snapshot.state = "warning"; snapshot.statusMessage = observation.availability==="failed"?"读取失败 · 历史数据已过期":"数据未更新"; }
  else if (status === "error" || (status === "unavailable" && observation.availability === "ready")) { snapshot.state = "offline"; snapshot.statusMessage = "当前数据不可用"; }
  else if (status === "degraded" && snapshot.state === "online") { snapshot.state = "warning"; snapshot.statusMessage = "数据降级"; }
  if(observation.availability==="ready"&&(observation.sourceTimeVerified===false||!observation.observedAt)){snapshot.state="unknown";snapshot.statusMessage="来源时间未确认";}
  return snapshot;
}

export function formatVpsLocation(value:VpsLocation|null|undefined){
  const bilingual=(zh:string|null|undefined,en:string|null|undefined)=>{
    const clean=(text:unknown)=>typeof text==="string"&&text.trim().length<=150&&!/[\r\n\t]/.test(text)?text.trim():"";
    let chinese=clean(zh);const english=clean(en);
    if(!/[\u3400-\u9fff]/.test(chinese))chinese="";
    return `${chinese||"未知"} / ${english||"Unknown"}`;
  };
  return {country:bilingual(value?.countryZh,value?.countryEn),city:bilingual(value?.cityZh,value?.cityEn)};
}
