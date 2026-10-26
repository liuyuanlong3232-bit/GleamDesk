import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { demoProviderRegistry } from "../src/providers/demo/registry";
import { refreshDashboardData } from "../src/providers/dashboardService";
import { providersFor } from "../src/providers/registry";
import { snapshotAfterFailure, createVpsHistoryRecord, snapshotFromVpsHistory, beszelProviderResult, emptyVpsObservation, observationFromNative } from "../src/providers/server/beszelProvider";
import type { VpsObservation } from "../src/domain/vps/contracts";
import { presentVps, formatVpsUptime } from "../src/presentation/vpsAdapter";
import { presentApplications } from "../src/presentation/applicationAdapter";
import { healthFromEventLog } from "../src/providers/system/windowsHealthProvider";
import { adaptProviderSnapshots } from "../src/providers/dashboardAdapter";
import { createProviderRuntime } from "../src/providers/providerRuntime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WidgetCard } from "../src/widgets/WidgetCard";
import { emptyDashboardData } from "../src/providers/dashboardAdapter";
import { createHardwareProvider } from "../src/providers/system/hardwareProvider";
import { createWindowsHealthProvider } from "../src/providers/system/windowsHealthProvider";
import { createAgricultureProvider } from "../src/providers/agriculture/agricultureProvider";

test("new agriculture reader does not reuse an old snapshot without collector confirmation metadata", async () => {
  const now = Date.parse("2026-10-17T04:00:00Z");
  const values = new Map<string,string>();
  const oldKey = "codex-desktop.provider.v6:" + encodeURIComponent("agriculture-status:ssh-104-agriculture-v5");
  values.set(oldKey, JSON.stringify({expiresAt:now+300000,snapshot:{
    providerId:"agriculture-status",status:"normal",lastSuccessAt:new Date(now).toISOString(),
    data:{type:"agriculture-status",snapshot:{schemaVersion:1,origin:"ssh:vps:203.0.113.10",fetchedAt:new Date(now).toISOString(),snapshots:{},radar:{status:"unavailable",quotes:[],mainContracts:[]}}}
  }}));
  const previous = values.get(oldKey);
  const provider = createAgricultureProvider();
  let loads = 0;
  provider.load = async () => {
    loads += 1;
    return {status:"normal",data:{type:"agriculture-status",snapshot:{schemaVersion:1,origin:"ssh:vps:203.0.113.10",fetchedAt:new Date(now).toISOString(),snapshots:{},radar:{status:"unavailable",quotes:[],mainContracts:[{continuousSymbol:"C.DCE",contractSymbol:"C2611.DCE",mappingDate:"2026-10-15",confirmed:true}]}}}};
  };
  const runtime = createProviderRuntime({cache:{get:key=>values.get(key)??null,set:(key,value)=>{values.set(key,value);}},now:()=>now});
  const snapshot = await runtime.refresh(provider);
  assert.equal(loads,1);
  assert.equal(snapshot.data?.snapshot.radar?.mainContracts[0].contractSymbol,"C2611.DCE");
  assert.equal(values.get(oldKey),previous);
  await runtime.refresh(provider);
  assert.equal(loads,1);
});

function vpsSample(patch: Partial<VpsObservation> = {}): VpsObservation {
  return { ...emptyVpsObservation("ready", "one"), name: "VPS", state: "online", uptimeSeconds: 3600, cpuPercent: 12,
    observedAt: "2026-10-05T09:50:00.000Z", lastSuccessAt: "2026-10-05T09:50:00.000Z",sourceTimeVerified:true, ...patch };
}

test("Beszel credential changes refresh immediately without placing credentials in cache identity", async () => {
  let loads=0;
  const config={url:"https://example.com",systemId:"one",refreshIntervalSeconds:30};
  const first=providersFor(["vps-status"],{...config,credentialRevision:1})[0];
  const next=providersFor(["vps-status"],{...config,credentialRevision:2})[0];
  const load=async()=>({status:"normal" as const,data:{type:"vps-status" as const,observation:vpsSample({cpuPercent:++loads})}});
  first.load=load; next.load=load;
  const values=new Map<string,string>();
  const runtime=createProviderRuntime({cache:{get:key=>values.get(key)??null,set:(key,value)=>values.set(key,value)},now:()=>Date.parse("2026-10-06T11:00:00Z")});
  await runtime.refresh(first); await runtime.refresh(first);
  assert.equal(loads,1);
  await runtime.refresh(next);
  assert.equal(loads,2);
  assert.notEqual(first.cacheKey,next.cacheKey);
  assert.ok([...values.keys()].every(key=>!key.includes("token")));
});

test("shared native snapshots retain their actual observation time and one VPS history identity", async () => {
  const sampledAt = "2026-10-05T09:50:00.000Z";
  const health = healthFromEventLog({ status: "ok", warnings: [], events: [], scannedAtUnixMs: Date.parse(sampledAt) });
  assert.equal(health.observation.scannedAt, sampledAt);
  const snapshot = vpsSample({ observedAt: sampledAt, lastSuccessAt: sampledAt });
  const first = await createVpsHistoryRecord({ url: "https://example.com/", systemId: "one" }, snapshot);
  const second = await createVpsHistoryRecord({ url: "https://example.com", systemId: "one" }, snapshot);
  assert.equal(first.id, second.id);
  assert.equal(first.createdAt, sampledAt);
  assert.equal(snapshotFromVpsHistory([first], { url: "https://example.com/", systemId: "one" })?.lastSuccessAt, sampledAt);
  assert.equal(snapshotFromVpsHistory([first], { url: "https://other.example.com", systemId: "one" }), undefined);
  assert.equal(snapshotFromVpsHistory([first], { url: "https://example.com", systemId: "two" }), undefined);
  const { hubUrl: _legacyOrigin, ...legacyPayload } = first.payload;
  assert.equal(snapshotFromVpsHistory([{ ...first, payload: legacyPayload }], { url: "https://example.com", systemId: "one" }), undefined);
  assert.notEqual(first.id, (await createVpsHistoryRecord({ url: "https://other.example.com", systemId: "one" }, snapshot)).id);
  assert.notEqual(first.id, (await createVpsHistoryRecord({ url: "https://example.com", systemId: "one" }, { ...snapshot, observedAt: "2026-10-05T09:50:01.000Z" })).id);
  await assert.rejects(createVpsHistoryRecord({ url: "https://example.com", systemId: "one" }, { ...snapshot, observedAt: "invalid" }));
  assert.equal(first.payload.schemaVersion, 2);
  assert.equal("snapshot" in first.payload, false);
  assert.equal("gauges" in first.payload.observation, false);
});

test("Beszel failures with persisted data stay stale through the provider and widget adapter", async () => {
  const observedAt = "2026-10-05T09:50:00.000Z";
  const previous = vpsSample({ observedAt, lastSuccessAt: observedAt });
  const [provider] = providersFor(["vps-status"], { url: "https://example.com", systemId: "one", refreshIntervalSeconds: 30 });
  provider.load = async () => beszelProviderResult(snapshotAfterFailure("one", "服务 网络连接失败或请求超时", previous), true);
  provider.retryPolicy = { maxRetries: 0 };
  const runtime = createProviderRuntime({ now: () => Date.parse("2026-10-05T10:00:00.000Z") });
  const snapshot = await runtime.refresh(provider);
  assert.equal(snapshot.status, "stale");
  assert.equal(snapshot.lastSuccessAt, observedAt);
  const data = adaptProviderSnapshots([provider], [snapshot]);
  assert.equal(data.vps.state, "warning");
  assert.match(data.vps.statusMessage!, /已过期/);
  assert.equal(data.vps.gauges[0].value, 12);
  assert.equal(data.vps.lastSuccessAt, observedAt);
  const markup = renderToStaticMarkup(createElement(WidgetCard, { id: "vps", data }));
  assert.match(markup, /历史数据已过期/);
  assert.match(markup, /服务 网络连接失败或请求超时/);
});

test("configured Beszel read failures reach the runtime circuit breaker and preserve VPS history time", async () => {
  const observedAt = "2026-10-05T09:50:00.000Z";
  const previous = vpsSample({ observedAt, lastSuccessAt: observedAt });
  const [provider] = providersFor(["vps-status"], { url: "https://example.com", systemId: "one", refreshIntervalSeconds: 30 });
  let loads = 0;
  provider.retryPolicy = { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 };
  provider.load = async () => {
    loads += 1;
    return beszelProviderResult(snapshotAfterFailure("one", "服务 网络连接失败或请求超时", previous), true);
  };
  let timestamp = Date.parse("2026-10-06T10:00:00.000Z");
  const values = new Map<string, string>();
  const cache = { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value); } };
  const runtime = createProviderRuntime({ cache, now: () => timestamp });

  let snapshot;
  for (let failure = 1; failure <= 3; failure += 1) {
    snapshot = await runtime.refresh(provider);
    assert.equal(snapshot.status, "stale");
    assert.equal(snapshot.lastSuccessAt, observedAt);
    assert.equal(snapshot.data?.observation.lastSuccessAt, observedAt);
    assert.equal(snapshot.data?.observation.cpuPercent, 12);
    assert.equal(loads, failure);
    if (failure < 3) timestamp += 1_001;
  }
  const thirdFailureUpdatedAt = snapshot!.lastUpdated;
  assert.ok(snapshot!.retryAt);
  timestamp += 10_000;
  const cooling = await runtime.refresh(provider);
  assert.equal(loads, 3, "cooldown suppresses additional Beszel reads");
  assert.equal(cooling.retryAt, snapshot!.retryAt);
  assert.equal(cooling.lastUpdated, thirdFailureUpdatedAt);
  assert.equal(cooling.lastSuccessAt, observedAt);
  assert.equal(cooling.data?.observation.observedAt, observedAt);
  const data = adaptProviderSnapshots([provider], [cooling]);
  const markup = renderToStaticMarkup(createElement(WidgetCard, { id: "vps", data, vpsConsole: true }));
  assert.match(markup, /服务 网络连接失败或请求超时；连续读取失败，暂停刷新至/);
});

test("Beszel missing credentials and unsupported platform remain unavailable, not breaker failures", async () => {
  const missing = { ...emptyVpsObservation("credentials-missing", "one"), state: "offline" as const, error: "凭据尚未配置" };
  const unsupported = emptyVpsObservation("platform-unsupported", "one");
  const unconfigured = emptyVpsObservation("unconfigured");
  for (const observation of [missing, unsupported, unconfigured]) {
    const result = beszelProviderResult(observation, true);
    assert.equal(result.status, "unavailable");
    assert.equal(result.retryable, false);
  }
  const observedAt = "2026-10-05T09:50:00.000Z";
  const missingWithHistory = snapshotAfterFailure("one", "Beszel 凭据尚未配置", vpsSample({ observedAt, lastSuccessAt: observedAt }));
  const retained = beszelProviderResult(missingWithHistory, true);
  assert.equal(retained.status, "unavailable");
  assert.equal(retained.retained, true);
  assert.equal(retained.observedAt, observedAt);
  assert.equal(retained.data?.observation.lastSuccessAt, observedAt);

  const [provider] = providersFor(["vps-status"], { url: "https://example.com", systemId: "one", refreshIntervalSeconds: 30 });
  const values = new Map<string, string>();
  const cache = { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value); } };
  const runtime = createProviderRuntime({ cache, now: () => Date.parse("2026-10-06T10:00:00.000Z") });
  for (const [index, observation] of [missing, unsupported, unconfigured].entries()) {
    const currentProvider = { ...provider, cacheKey: `availability-${index}`, retryPolicy: { maxRetries: 0 },
      load: async () => beszelProviderResult(observation, true) };
    const result = await runtime.refresh(currentProvider);
    assert.equal(result.status, "unavailable");
    assert.equal(result.retryAt, undefined);
    const cacheKey = "codex-desktop.provider.v6:" + encodeURIComponent(currentProvider.id + ":" + currentProvider.cacheKey);
    const envelope = JSON.parse(values.get(cacheKey)!);
    assert.equal(envelope.failureCount, undefined);
    assert.equal(envelope.cooldownUntil, undefined);
  }
});

test("native hardware, Event Log and agriculture failures reach provider cooldown with cached success preserved", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalTauri = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), { crypto: webcrypto }) });
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    let failReads = true;
    const commandCalls = new Map<string, number>();
    mockIPC((command) => {
      commandCalls.set(command, (commandCalls.get(command) ?? 0) + 1);
      if (command === "storage_query") return [];
      if (command === "storage_prune") return 0;
      if (command === "read_windows_events" && !failReads) return { status: "partial", warnings: ["部分通道不可读"], events: [] };
      throw new Error(`${command} offline`);
    });

    const providers = [createHardwareProvider(), createWindowsHealthProvider(), createAgricultureProvider({enabled:true,sshAlias:"synthetic",dataRoot:"/srv/test",radarRoot:""})];
    const readCommands = ["read_hardware_snapshot", "read_windows_events", "read_agriculture_snapshot"];
    const cacheValues = new Map<string, string>();
    const cache = { get: (key: string) => cacheValues.get(key) ?? null, set: (key: string, value: string) => { cacheValues.set(key, value); } };
    let timestamp = Date.parse("2026-10-06T10:00:00.000Z");
    const previousSuccessAt = "2026-10-05T09:50:00.000Z";
    const runtime = createProviderRuntime({ cache, now: () => timestamp, wait: async () => undefined });

    for (const [index, provider] of providers.entries()) {
      provider.refreshIntervalMs = 1_000;
      const raw = await provider.load(new AbortController().signal);
      assert.equal(raw.status, "error", `${provider.id} catch must report an error`);
      const command = readCommands[index];
      assert.equal(commandCalls.get(command), 1);
      commandCalls.set(command, 0);
      const identity = `${provider.id}:${provider.cacheKey ?? "default"}`;
      const storageKey = `codex-desktop.provider.v6:${encodeURIComponent(identity)}`;
      cache.set(storageKey, JSON.stringify({ expiresAt: timestamp - 1, snapshot: {
        providerId: provider.id, status: "normal", data: { type: provider.id, retainedMarker: "previous success" },
        lastUpdated: previousSuccessAt, lastSuccessAt: previousSuccessAt,
      } }));

      const callsPerRefresh = (provider.retryPolicy?.maxRetries ?? 1) + 1;
      let latest;
      for (let failure = 1; failure <= 3; failure += 1) {
        latest = await runtime.refresh(provider);
        assert.equal(latest.status, "stale", `${provider.id} should retain only stale prior data`);
        assert.equal(latest.lastSuccessAt, previousSuccessAt);
        assert.equal(latest.data?.retainedMarker, "previous success");
        assert.equal(commandCalls.get(command), callsPerRefresh * failure);
        if (failure < 3) timestamp += 6_001;
      }
      const priorFailureTime = latest!.lastUpdated;
      timestamp += 10_000;
      const cooling = await runtime.refresh(provider);
      assert.equal(commandCalls.get(command), callsPerRefresh * 3, `${provider.id} must not call IPC during cooldown`);
      assert.equal(cooling.lastUpdated, priorFailureTime);
      assert.equal(cooling.lastSuccessAt, previousSuccessAt);
      assert.equal(cooling.data?.retainedMarker, "previous success");
      timestamp += 61_000;
    }

    failReads = false;
    const partial = await createWindowsHealthProvider().load(new AbortController().signal);
    assert.equal(partial.status, "degraded", "partial Event Log reads remain degraded");

    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: false });
    for (const provider of [createHardwareProvider(), createWindowsHealthProvider(), createAgricultureProvider()]) {
      const result = await provider.load(new AbortController().signal);
      assert.equal(result.status, "unavailable", `${provider.id} stays unavailable outside Tauri`);
      assert.equal(result.retryable, false);
    }
  } finally {
    clearMocks();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalTauri) Object.defineProperty(globalThis, "isTauri", originalTauri);
    else Reflect.deleteProperty(globalThis, "isTauri");
  }
});

test("retained health and hardware widgets show expired data instead of normal live status", () => {
  const observedAt = "2026-10-05T09:50:00.000Z";
  const [provider] = providersFor(["system-health"]);
  const health = adaptProviderSnapshots([provider], [{ providerId: provider.id, status: "stale", error: "scan failed",
    lastUpdated: "2026-10-05T10:00:00.000Z", lastSuccessAt: observedAt,
    data: healthFromEventLog({ status: "ok", warnings: [], events: [] }, observedAt) }]);
  assert.equal(health.health.state, "offline");
  assert.equal(health.health.eventLogStatus, "error");
  assert.equal(health.health.lastScanAt, observedAt);
  const healthMarkup = renderToStaticMarkup(createElement(WidgetCard, { id: "health", data: health }));
  assert.match(healthMarkup, /数据已过期/);
  assert.match(healthMarkup, /scan failed/);
  assert.doesNotMatch(healthMarkup, /未发现近期重点事件/);
  const data = emptyDashboardData();
  data.hardware = { sampledAtUnixMs: Date.parse(observedAt),
    cpu: { usageStatus: "available", usagePercent: 12, temperatureStatus: "unsupported", temperatureC: null },
    memory: { status: "available", usagePercent: 20, usedBytes: 20, totalBytes: 100 },
    network: { status: "available", uploadBytesPerSecond: 1, downloadBytesPerSecond: 2 },
    disks: { status: "available", volumes: [] },
    gpu: { name: null, status: "unsupported", usagePercent: null, memoryUsedBytes: null, memoryTotalBytes: null, temperatureC: null } };
  data.providerDiagnostics = [{ providerId: "hardware-status", name: "本机硬件", status: "stale", error: "read failed",
    lastUpdated: "2026-10-05T10:00:00.000Z", lastSuccessAt: observedAt }];
  const hardwareMarkup = renderToStaticMarkup(createElement(WidgetCard, { id: "hardware", data }));
  assert.match(hardwareMarkup, /已过期/);
  assert.match(hardwareMarkup, /read failed/);
  assert.doesNotMatch(hardwareMarkup, /实时/);
  assert.equal(data.hardware.cpu.usageStatus, "available", "presentation must not rewrite native capability data");
});

test("registered demo providers load one unified dashboard snapshot without polling", async () => {
  const data = await refreshDashboardData(demoProviderRegistry.map((provider) => provider.id), undefined, false);
  assert.equal(demoProviderRegistry.length, 3);
  assert.ok(demoProviderRegistry.every((provider) => provider.refreshIntervalMs === null));
  assert.equal(data.providers.filter((item) => item.kind === "agent").length, 5);
  assert.equal(data.providers.filter((item) => item.kind === "api").length, 4);
  assert.equal(data.metrics.length, 0);
  assert.equal(data.applications.length, 8);
});

test("only providers used by visible widgets are requested", async () => {
  const data = await refreshDashboardData(["agent-quotas"], undefined, false);
  assert.equal(data.providers.length, 5);
  assert.deepEqual(data.metrics, []);
  assert.deepEqual(data.applications, []);
});

test("Beszel is a visible-widget provider with a bounded configured refresh interval", () => {
  assert.ok(!demoProviderRegistry.some((provider) => provider.id === "vps-status"));
  const [provider] = providersFor(["vps-status"], { url: "https://beszel.example.com", systemId: "system-1", refreshIntervalSeconds: 600 });
  assert.equal(provider.id, "vps-status");
  assert.equal(provider.refreshIntervalMs, 300_000);
});

test("Windows Health is loaded only for visible health or notification widgets", () => {
  assert.equal(providersFor(["agent-quotas"]).some((provider) => provider.id === "windows-health"), false);
  const [provider] = providersFor(["system-health", "notifications"]);
  assert.equal(provider.id, "windows-health");
  assert.equal(provider.refreshIntervalMs, 60_000);
  assert.equal(provider.backgroundRefreshIntervalMs, null);
  assert.deepEqual(providersFor(["vps-status", "system-health"], undefined, { includeLiveProviders: false, includeDemoProviders: false }), []);
  assert.equal(providersFor(["windows-health"]).length, 1, "interval refreshes must resolve the native provider id too");
});

test("Windows Event Log snapshots distinguish a clean scan from selected critical events", () => {
  const [provider] = providersFor(["windows-health"]);
  const adapt = (data: ReturnType<typeof healthFromEventLog>) => adaptProviderSnapshots([provider], [{
    providerId: provider.id, status: "normal", data, lastUpdated: data.observation.scannedAt, lastSuccessAt: data.observation.scannedAt,
  }]);
  const clean = healthFromEventLog({ status: "ok", warnings: [], events: [] }, "2026-10-04T08:00:00.000Z");
  assert.equal(clean.observation.status, "ok");
  assert.deepEqual(Object.keys(clean).sort(), ["observation", "type"]);
  assert.deepEqual(Object.keys(clean.observation).sort(), ["events", "scannedAt", "status", "warnings"]);
  const cleanPresentation = adapt(clean);
  assert.equal(cleanPresentation.health.summary, "未发现近期重点事件");
  assert.equal(cleanPresentation.health.eventLogStatus, "ok");
  assert.equal(cleanPresentation.providers[0].state, "normal");

  const event = {
    id: "System:912:2026-10-04T08:20:00.000Z", timestamp: "2026-10-04T08:20:00.000Z", channel: "System" as const,
    recordId: "912", source: "Microsoft-Windows-Kernel-Power", eventId: 41, level: "错误", category: "非正常关机记录",
    message: "测试事件，不表示原因", severity: "error" as const,
  };
  const snapshot = healthFromEventLog({ status: "ok", warnings: [], events: [event] });
  assert.equal(snapshot.observation.events[0].id, event.id);
  const presentation = adapt(snapshot);
  assert.match(presentation.health.summary, /1 条重点事件/);
  assert.equal(presentation.notices[0].id, event.id);
  assert.equal(presentation.providers[0].state, "warning");
});

test("health presentation maps read states and proximity without changing domain observations", () => {
  const [provider] = providersFor(["windows-health"]);
  const observedAt = "2026-10-06T00:00:00.000Z";
  const power = { id: "power", timestamp: observedAt, channel: "System" as const, recordId: "1", source: "Microsoft-Windows-Kernel-Power",
    eventId: 41, level: "错误", severity: "error" as const, category: "异常关机", message: "原始事件", icon: "discard", tone: "discard" };
  const display = { ...power, id: "display", recordId: "2", source: "Display", eventId: 4101, timestamp: "2026-10-05T23:59:00.000Z" };
  const raw = healthFromEventLog({ status: "ok", events: [power, display], warnings: [] }, observedAt);
  const before = JSON.stringify(raw);
  const presented = adaptProviderSnapshots([provider], [{ providerId: provider.id, status: "normal", data: raw, lastUpdated: observedAt, lastSuccessAt: observedAt }]);
  assert.equal(JSON.stringify(raw), before);
  assert.ok(raw.observation.events.every(event => !("icon" in event) && !("tone" in event)));
  assert.match(presented.notices[0].title, /时间接近/);
  assert.match(presented.notices[0].detail, /不能据此判断因果/);
  assert.equal(presented.health.lastScanAt, observedAt);
  for (const status of ["degraded", "unavailable", "error"] as const) {
    const result = adaptProviderSnapshots([provider], [{ providerId: provider.id, status, data: raw,
      lastUpdated: observedAt, lastSuccessAt: observedAt, error: "当前读取受限" }]);
    assert.equal(result.health.state, status === "degraded" ? "warning" : "offline");
    assert.equal(result.health.detail, "当前读取受限");
    assert.doesNotMatch(result.health.summary, /未发现近期重点事件/);
    assert.equal(JSON.stringify(raw), before);
  }
  for (const status of ["partial", "unavailable", "error"] as const) {
    const data = healthFromEventLog({ status, events: [], warnings: ["通道读取问题"] }, observedAt);
    const result = adaptProviderSnapshots([provider], [{ providerId: provider.id, status: status === "partial" ? "degraded" : "unavailable", data,
      lastUpdated: observedAt, lastSuccessAt: null, error: "通道读取问题" }]);
    assert.equal(result.health.state, status === "partial" ? "warning" : "offline");
    assert.equal(result.health.eventLogStatus, status);
    assert.equal(result.health.detail, "通道读取问题");
    assert.equal(JSON.stringify(data).includes('"notices"'), false);
  }
});

test("Beszel invalid-token failure keeps the last successful VPS snapshot", () => {
  const previous = vpsSample({ name: "VPS-LA", uptimeSeconds: 172800, lastSuccessAt: "2026-10-04T08:00:00.000Z" });
  const failed = snapshotAfterFailure("system-1", "Beszel API 令牌无效或无权读取该系统", previous);
  assert.equal(failed.state, "offline");
  assert.equal(failed.cpuPercent, 12);
  assert.equal(failed.lastSuccessAt, previous.lastSuccessAt);
  assert.match(failed.error ?? "", /令牌无效/);
});

test("Beszel network failure without a previous snapshot shows an offline empty state", () => {
  const failed = snapshotAfterFailure("system-1", "Beszel Hub 网络连接失败或请求超时");
  assert.equal(failed.state, "offline");
  assert.equal(failed.uptimeSeconds, null);
  assert.equal(failed.cpuPercent, null);
  const view = presentVps(failed, "unavailable");
  assert.equal(view.uptime, "暂无成功数据");
  assert.deepEqual(view.gauges, []);
  assert.match(view.statusMessage ?? "", /连接失败/);
});

test("legacy VPS history remains readable without inferring precise uptime from display text", () => {
  const record = { kind: "vps_history" as const, id: "old", createdAt: "2026-10-05T09:50:00.000Z", payload: {
    hubUrl: "https://example.com", serverId: "one", snapshot: { name: "old", state: "online", uptime: "运行中 2 天",
      lastUpdated: "2026-10-05T09:49:59.000Z", gauges: [{ label: "CPU", value: 24 }, { label: "内存", value: 45 }], services: [] } } };
  const before = JSON.stringify(record);
  const observation = snapshotFromVpsHistory([record], { url: "https://example.com", systemId: "one" })!;
  assert.equal(observation.cpuPercent, 24);
  assert.equal(observation.memoryPercent, 45);
  assert.equal(observation.uptimeSeconds, null);
  assert.equal(observation.observedAt, record.payload.snapshot.lastUpdated);
  assert.equal("gauges" in observation, false);
  assert.equal(presentVps(observation, "stale").uptime, "运行时间未知");
  assert.equal(JSON.stringify(record), before);
});

test("native VPS observations project duration and gauges only in presentation", () => {
  const observation = observationFromNative({ sampledAtUnixMs: Date.parse("2026-10-06T03:00:00.000Z"), serverId: "one", name: "VPS",
    state: "online", uptimeSeconds: 183600.5, latencyMs: 42, cpuPercent: 12.5, memoryPercent: 43, diskPercent: null, network: {}, services: [] });
  const before = JSON.stringify(observation);
  const view = presentVps(observation, "normal");
  assert.equal(view.uptime, "运行中 2 天 3 小时");
  assert.deepEqual(view.gauges, [{ label: "CPU", value: 12.5 }, { label: "内存", value: 43 }]);
  assert.ok(view.services.every(service => service.state === "unknown"));
  assert.equal(observation.services.length, 0);
  assert.equal("uptime" in observation, false);
  assert.equal("statusMessage" in observation, false);
  assert.equal(formatVpsUptime(null), "运行时间未知");
  assert.equal(formatVpsUptime(0), "运行中 0 分钟");
  assert.equal(JSON.stringify(observation), before);
});

test("application catalog uses launcher items and default Dock styling belongs to presentation", async () => {
  const result = await demoProviderRegistry.find(provider => provider.id === "application-list")!.load(new AbortController().signal);
  if (result.data?.type !== "application-catalog") throw new Error("Missing app catalog");
  assert.ok(result.data.applications.every(app => "target" in app && "icon" in app && !("glyph" in app) && !("color" in app)));
  const before = JSON.stringify(result.data);
  assert.equal(presentApplications(result.data.applications)[0].glyph, "微");
  assert.equal(JSON.stringify(result.data), before);
  const configured = { ...result.data.applications[0], glyph: "自", color: "#123456" };
  assert.deepEqual(presentApplications([configured])[0], { id: configured.id, name: configured.name, glyph: "自", color: "#123456" });
});
