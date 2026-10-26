import type { HistoryKind, HistoryRecord } from "../types";
import { invoke } from "@tauri-apps/api/core";
import type { HistoryRangeResult } from "../domain/analysis/contracts";

export interface HistoryRepository {
  insert<T>(record: HistoryRecord<T>): Promise<void>;
  query(kind?: HistoryKind, limit?: number): Promise<HistoryRecord[]>;
  queryRange(kind: HistoryKind, from: string, to: string, limit?: number): Promise<HistoryRangeResult>;
  count(kind: HistoryKind): Promise<number>;
  delete(id: string, kind?: HistoryKind): Promise<void>;
  prune(kind: HistoryKind, before: string): Promise<number>;
}

const browserKey = "codex-desktop.history.v1";
const maxBrowserRecords = 2_000;
const historyKinds: HistoryKind[] = ["provider_history", "widget_state", "system_events", "usage_history", "vps_history", "hardware_history", "application_history", "notifications_history"];

export function validateHistoryRange(from: string, to: string) {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || new Date(start).toISOString() !== from
    || new Date(end).toISOString() !== to || end <= start || end - start > 8 * 86_400_000) {
    throw new Error("历史查询需要不超过 8 天的有效 UTC 时间范围");
  }
}

export function readBrowserHistoryRecords(): HistoryRecord[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(browserKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isHistoryRecord).slice(-maxBrowserRecords) : [];
  } catch {
    return [];
  }
}

export async function transactBrowserHistory<T>(change: (records: HistoryRecord[]) => { records: HistoryRecord[]; result: T }): Promise<T> {
  const run = () => {
    const update = change(readBrowserHistoryRecords());
    localStorage.setItem(browserKey, JSON.stringify(update.records.slice(-maxBrowserRecords)));
    return update.result;
  };
  return typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request("codex-desktop-browser-history", { mode: "exclusive" }, run)
    : run();
}

function isHistoryRecord(value: unknown): value is HistoryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<HistoryRecord>;
  return typeof record.id === "string" && typeof record.createdAt === "string" && historyKinds.includes(record.kind as HistoryKind);
}

const browserHistoryRepository: HistoryRepository = {
  async insert(record) {
    await transactBrowserHistory((records) => ({
      records: records.filter((item) => item.kind !== record.kind || item.id !== record.id).concat(record as HistoryRecord), result: undefined,
    }));
  },
  async query(kind, limit = 100) {
    return readBrowserHistoryRecords().filter((item) => !kind || item.kind === kind)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(1_000, limit)));
  },
  async count(kind) {
    return readBrowserHistoryRecords().filter((item) => item.kind === kind).length;
  },
  async queryRange(kind, from, to, limit = 1_000) {
    validateHistoryRange(from, to);
    if (!historyKinds.includes(kind)) throw new Error("不支持的历史记录类型");
    const stored = localStorage.getItem(browserKey);
    const parsed: unknown = stored === null ? [] : JSON.parse(stored);
    if (!Array.isArray(parsed) || !parsed.every(isHistoryRecord)) throw new Error("浏览器历史格式无效");
    const matches = (parsed as HistoryRecord[]).filter((record) => record.kind === kind
      && Date.parse(record.createdAt) >= Date.parse(from) && Date.parse(record.createdAt) < Date.parse(to))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const records: HistoryRecord[] = [];
    let bytes = 2;
    for (const record of matches.slice(0, Math.max(1, Math.min(1_000, Math.floor(limit) || 1)))) {
      bytes += new TextEncoder().encode(JSON.stringify(record)).byteLength + 1;
      if (bytes > 2 * 1024 * 1024) break;
      records.push(record);
    }
    return { records, totalCount: matches.length, truncated: matches.length > records.length };
  },
  async delete(id, kind) {
    await transactBrowserHistory((records) => ({ records: records.filter((item) => item.id !== id || (kind !== undefined && item.kind !== kind)), result: undefined }));
  },
  async prune(kind, before) {
    const cutoff = Date.parse(before);
    if (!Number.isFinite(cutoff)) return 0;
    return transactBrowserHistory((records) => {
      const kept = records.filter((item) => item.kind !== kind || Date.parse(item.createdAt) >= cutoff);
      return { records: kept, result: records.length - kept.length };
    });
  },
};

const tauriHistoryRepository: HistoryRepository = {
  insert: (record) => invoke("storage_insert", { record }),
  query: (kind, limit = 100) => invoke<HistoryRecord[]>("storage_query", { kind: kind ?? null, limit }),
  queryRange: (kind, from, to, limit = 1_000) => {
    validateHistoryRange(from, to);
    return invoke<HistoryRangeResult>("storage_query_range", { kind, from, to, limit });
  },
  count: (kind) => invoke<number>("storage_count", { kind }),
  delete: (id, kind) => invoke("storage_delete", { id, kind: kind ?? null }),
  prune: (kind, before) => invoke<number>("storage_prune", { kind, before }),
};

export function selectHistoryRepository(native: boolean): HistoryRepository {
  return native ? tauriHistoryRepository : browserHistoryRepository;
}
