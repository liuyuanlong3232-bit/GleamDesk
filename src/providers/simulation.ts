import { useEffect, useMemo, useState } from "react";
import type { DashboardData, SimulationScenario, SystemEvent } from "../types";
import { isWindowVisible, subscribeWindowVisibility } from "../services/windowVisibility";

const simulationProviderIds = new Set(["agent-quotas", "api-balances", "vps-status", "system-health", "notifications"]);

export function useSimulationTick(enabled: boolean, providerIds: string[]) {
  const providerKey = [...new Set(providerIds)].sort().join("|");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const active = providerKey.split("|").some((id) => simulationProviderIds.has(id));
    if (!enabled || !active) return;
    let timer = 0;
    const start = () => {
      window.clearInterval(timer);
      if (isWindowVisible()) {
        timer = window.setInterval(() => setTick((value) => value + 1), 3_000);
      }
    };
    start();
    const unsubscribe = subscribeWindowVisibility(start);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [enabled, providerKey]);

  return tick;
}

export function simulateDashboardData(data: DashboardData, tick: number, scenario: SimulationScenario): DashboardData {
  const spend = Math.round(tick * 2) / 100;
  const vpsState = scenario === "error" ? "offline" : scenario === "warning" || scenario === "high-load" ? "warning" : "normal";
  const healthState: "offline" | "warning" | "normal" = scenario === "error" ? "offline" : scenario === "warning" || scenario === "high-load" ? "warning" : "normal";
  const providers = data.providers.map((provider) => {
    if (provider.id === "windows-health") return { ...provider, state: healthState, lastUpdated: new Date().toISOString() };
    if (provider.id === "codex" && tick > 0) {
      const percentage = Math.max(1, (provider.percentage ?? 72) - Math.floor(tick / 2));
      return { ...provider, percentage, remaining: `模拟消耗中 · 剩余 ${percentage}%`, usageWindows: provider.usageWindows?.map((window, index) => index === 0 ? { ...window, usedPercent: 100-percentage } : window), lastUpdated: new Date().toISOString() };
    }
    if (provider.kind === "api" && tick > 0) {
      return {
        ...provider,
        balance: Math.max(0, (provider.balance ?? 0) - spend),
        todayCost: (provider.todayCost ?? 0) + spend,
        lastUpdated: new Date().toISOString(),
      };
    }
    return provider;
  }).concat([
    { id: "vps-health", name: "LA-VPS", kind: "server" as const, state: vpsState === "normal" ? "online" as const : vpsState, lastUpdated: new Date().toISOString() },
  ]);

  const gauges = data.vps.gauges.map((gauge) => ({
    ...gauge,
    value: scenario === "high-load" && gauge.label === "CPU" ? 94
      : scenario === "high-load" && gauge.label === "内存" ? 83
        : gauge.value,
  }));
  const now = new Date().toISOString();
  const simulatedEvents: SystemEvent[] = scenario === "error" ? [
    { id: `simulation:system:${tick}`, timestamp: now, channel: "System", recordId: `simulation-${tick}`, source: "Microsoft-Windows-Kernel-Power", eventId: 41, level: "错误", category: "非正常关机记录", message: "Developer Simulation · 模拟的异常关机事件", severity: "error" },
    { id: `simulation:application:${tick}`, timestamp: now, channel: "Application", recordId: `simulation-app-${tick}`, source: "Application Error", eventId: 1000, level: "错误", category: "应用崩溃", message: "Developer Simulation · 模拟的应用崩溃事件", severity: "error", relatedProcess: "demo-app.exe" },
  ] : scenario === "warning" ? [
    { id: `simulation:application:${tick}`, timestamp: now, channel: "Application", recordId: `simulation-app-${tick}`, source: "Application Error", eventId: 1000, level: "错误", category: "应用崩溃", message: "Developer Simulation · 模拟的应用崩溃事件", severity: "error", relatedProcess: "demo-app.exe" },
  ] : [];
  const healthSummary = scenario === "error" ? "模拟异常关机与应用崩溃" : scenario === "warning" ? "模拟应用崩溃事件" : scenario === "high-load" ? "系统负载较高（模拟）" : "模拟正常场景 · 未触发事件";
  const healthDetail = scenario === "normal" ? "Developer Simulation · 不读取或修改真实事件历史" : "Developer Simulation · 以下为临时模拟事件，不代表真实系统问题";
  const metrics = data.metrics.map((metric) => metric.id === "cpu" && scenario === "high-load"
    ? { ...metric, value: 91 }
    : metric.id === "memory" && scenario === "high-load" ? { ...metric, value: 84 } : metric);
  const notices = scenario === "normal" ? data.notices : simulatedEvents.length > 0 ? simulatedEvents.map((event) => ({
    id: event.id,
    icon: "!",
    title: `${event.category} · ${event.eventId}`,
    detail: `${event.message} · ${event.source}`,
    tone: "amber" as const,
  })) : [
    { icon: "▲", title: "模拟告警：资源负载较高", detail: "Developer Simulation · 不代表真实系统状态", tone: "amber" as const },
  ];

  return {
    ...data,
    providers,
    vps: {
      ...data.vps,
      name: "LA-VPS · 模拟",
      state: vpsState,
      uptime: scenario === "error" ? "连接中断（模拟）" : "模拟运行中",
      latency: scenario === "high-load" ? 946 : data.vps.latency,
      gauges,
    },
    health: { ...data.health, state: healthState, summary: healthSummary, detail: healthDetail, events: simulatedEvents },
    metrics,
    notices,
  };
}

export function useSimulatedDashboardData(data: DashboardData, enabled: boolean, scenario: SimulationScenario, tick: number) {
  return useMemo(() => enabled ? simulateDashboardData(data, tick, scenario) : data, [data, enabled, scenario, tick]);
}
