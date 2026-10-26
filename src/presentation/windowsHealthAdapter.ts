import type { EventLogObservation, SystemEvent } from "../domain/health/contracts";
import type { HealthSnapshot, NoticeItem, ProviderResultStatus, ProviderStatus } from "../types";

function eventNotices(events: SystemEvent[]): NoticeItem[] {
  const notices = events.slice(0, 3).map((event) => ({
    id: event.id,
    icon: event.severity === "critical" ? "!" : event.severity === "error" ? "▲" : "i",
    title: `${event.category} · ${event.eventId}`,
    detail: `${new Date(event.timestamp).toLocaleString("zh-CN")} · ${event.source}`,
    tone: event.severity === "warning" ? "violet" as const : "amber" as const,
  }));
  const power = events.find((event) => event.channel === "System" && event.source.toLowerCase().includes("kernel-power") && event.eventId === 41);
  const display = events.find((event) => event.channel === "System" && (event.source.toLowerCase() === "display" || event.source.toLowerCase().includes("nvlddmkm")));
  if (power && display && Math.abs(Date.parse(power.timestamp) - Date.parse(display.timestamp)) <= 5 * 60_000) {
    notices.unshift({
      id: `time-proximity:${power.id}:${display.id}`, icon: "i",
      title: "检测到时间接近的电源与显示事件",
      detail: "时间接近可能相关，但不能据此判断因果，需要进一步确认。", tone: "violet",
    });
  }
  return notices.slice(0, 4);
}

export function presentWindowsHealth(observation: EventLogObservation, status: ProviderResultStatus, error?: string) {
  const { events } = observation;
  const warnings = observation.warnings.filter(Boolean).slice(0, 2).join("；");
  let state: HealthSnapshot["state"] = "normal";
  let summary = "未发现近期重点事件";
  let detail = "已检查系统与应用日志中的高价值事件";
  if (observation.status === "unavailable" || observation.status === "error") {
    state = "offline";
    summary = "Windows 事件日志不可用";
    detail = warnings || "读取事件日志失败";
  } else if (observation.status === "partial") {
    state = "warning";
    summary = "部分事件日志不可读取";
    detail = warnings || "部分通道读取失败，其余通道已完成扫描";
  } else if (events.length > 0) {
    state = "warning";
    summary = `检测到 ${events.length} 条重点事件`;
    detail = `${events[0].category} · ${events[0].source} Event ID ${events[0].eventId}`;
  }
  const health: HealthSnapshot = {
    state, summary, detail, metrics: [], events,
    eventLogStatus: observation.status, lastScanAt: observation.scannedAt,
  };
  const providerStatus: ProviderStatus = {
    id: "windows-health", name: "Windows Event Log", kind: "system",
    state: state ?? "unknown", lastUpdated: observation.scannedAt,
    error: observation.status === "ok" ? undefined : detail,
  };
  if (status === "stale") {
    health.state = "offline";
    health.eventLogStatus = "error";
    health.summary = "Windows 事件日志数据已过期";
    health.detail = error || "读取失败 · 显示上次成功扫描的事件";
    providerStatus.state = "offline";
    providerStatus.error = error;
  } else if (status === "error" || status === "unavailable") {
    health.state = "offline";
    health.eventLogStatus = status === "error" || observation.status === "error" ? "error" : "unavailable";
    health.summary = "Windows 事件日志不可用";
    health.detail = error || warnings || "当前扫描未成功";
    providerStatus.state = "offline";
    providerStatus.error = health.detail;
  } else if (status === "degraded" && observation.status === "ok") {
    health.state = "warning";
    health.summary = "事件日志数据降级";
    health.detail = error || "当前扫描结果存在限制";
    providerStatus.state = "warning";
    providerStatus.error = health.detail;
  }
  return { health, providerStatus, notices: eventNotices(events) };
}
