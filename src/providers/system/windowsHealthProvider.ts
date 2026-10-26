import { invoke, isTauri } from "@tauri-apps/api/core";
import type { EventLogReadStatus, SystemEvent } from "../../domain/health/contracts";
import type { Provider, ProviderLoadResult } from "../contracts";
import type { WindowsHealthData } from "../data";
import { createHistoryRecord, pruneHistoryRecords, queryHistoryRecords, writeHistoryRecord } from "../../services/historyStore";
import { liveProvenance } from "../../domain/analysis/contracts";

interface NativeEventLogScan {
  scannedAtUnixMs?: number;
  status: EventLogReadStatus;
  warnings: string[];
  events: SystemEvent[];
}

function normalizeEvent(event: SystemEvent): SystemEvent | undefined {
  if (!event || typeof event !== "object" || !event.id || !event.source || !Number.isFinite(event.eventId)) return undefined;
  const parsedTime = Date.parse(event.timestamp);
  if (!Number.isFinite(parsedTime)) return undefined;
  return {
    id: event.id,
    channel: event.channel,
    recordId: event.recordId,
    eventId: event.eventId,
    level: event.level,
    severity: event.severity,
    timestamp: new Date(parsedTime).toISOString(),
    source: String(event.source).slice(0, 200),
    category: String(event.category || "系统事件").slice(0, 100),
    message: String(event.message || `事件消息暂不可用 · Event ID ${event.eventId}`).replace(/[\r\n\t]+/g, " ").slice(0, 2_000),
    relatedProcess: typeof event.relatedProcess === "string" ? event.relatedProcess.slice(0, 260) : undefined,
  };
}

function normalizeEvents(events: SystemEvent[]) {
  const seen = new Set<string>();
  return events.flatMap((event) => {
    const normalized = normalizeEvent(event);
    if (!normalized || seen.has(normalized.id)) return [];
    seen.add(normalized.id);
    return [normalized];
  }).sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

export function healthFromEventLog(scan: NativeEventLogScan, scannedAt = new Date(scan.scannedAtUnixMs ?? Date.now()).toISOString()): WindowsHealthData {
  return { type: "windows-health", observation: {
    status: scan.status,
    scannedAt,
    events: normalizeEvents(scan.events ?? []).slice(0, 60),
    warnings: (scan.warnings ?? []).filter(Boolean).slice(0, 2),
  } };
}

async function storedEvents(): Promise<SystemEvent[]> {
  const records = await queryHistoryRecords("system_events", 1_000);
  return normalizeEvents(records.map((record) => record.payload as SystemEvent));
}

async function persistEvents(events: SystemEvent[]) {
  for (const event of events) {
    const id = `system-event-${event.id}`;
    const record = createHistoryRecord("system_events", { ...event, provenance: liveProvenance("windows-health") }, id);
    record.createdAt = event.timestamp;
    await writeHistoryRecord(record);
  }
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  await pruneHistoryRecords("system_events", cutoff);
}

function readableError(error: unknown) {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "读取 Windows 事件日志失败";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

export function createWindowsHealthProvider(): Provider<WindowsHealthData> {
  return {
    id: "windows-health",
    name: "Windows Event Log",
    kind: "system",
    refreshIntervalMs: 60_000,
    backgroundRefreshIntervalMs: null,
    timeoutMs: 15_000,
    retryPolicy: { maxRetries: 1, initialDelayMs: 1_000, maxDelayMs: 4_000 },
    load: async (): Promise<ProviderLoadResult<WindowsHealthData>> => {
      const scannedAt = new Date().toISOString();
      if (!isTauri()) {
        return { status: "unavailable", data: healthFromEventLog({ status: "unavailable", warnings: ["浏览器预览不能访问 Windows Event Log"], events: [] }, scannedAt), error: "浏览器预览不能访问 Windows Event Log", retryable: false };
      }
      try {
        const scan = await invoke<NativeEventLogScan>("read_windows_events", { limit: 60 });
        const events = normalizeEvents(scan.events ?? []);
        await persistEvents(events);
        const data = healthFromEventLog({ ...scan, events });
        const status = scan.status === "ok" ? "normal" : scan.status === "partial" ? "degraded" : scan.status === "error" ? "error" : "unavailable";
        return { status, data, observedAt: data.observation.scannedAt,
          error: status === "normal" ? undefined : data.observation.warnings.join("；") || (status === "degraded" ? "部分 Windows 日志通道不可读取" : "Windows 事件日志读取失败"),
          retryable: status === "unavailable" || status === "degraded" };
      } catch (error) {
        const previous = await storedEvents();
        const message = readableError(error);
        return { status: "error", data: healthFromEventLog({ status: "error", warnings: [message], events: previous }, scannedAt), error: message, retryable: true };
      }
    },
  };
}

export { normalizeEvents };
