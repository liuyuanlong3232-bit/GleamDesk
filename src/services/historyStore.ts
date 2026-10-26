import type { AgentQuotaAccount, AgentUsageWindow } from "../domain/agent/contracts";
import type { HistoryRepository } from "./historyRepository";
import type { HistoryKind, HistoryRecord } from "../types";
import { isTauri } from "../tauri";
import { logEvent } from "./appLogger";
import { selectHistoryRepository } from "./historyRepository";

const prunableKinds = new Set<HistoryKind>(["provider_history", "system_events", "usage_history", "vps_history", "hardware_history", "application_history", "notifications_history"]);
const repository = () => selectHistoryRepository(isTauri());

export function createHistoryRecord<T>(kind: HistoryKind, payload: T, id?: string): HistoryRecord<T> {
  return {
    id: id ?? `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    createdAt: new Date().toISOString(),
    payload,
  };
}

export async function writeHistoryRecord<T>(record: HistoryRecord<T>) {
  try {
    await repository().insert(record);
    return true;
  } catch {
    logEvent("warn", "history.write_failed", { kind: record.kind });
    return false;
  }
}

export async function pruneHistoryRecords(kind: HistoryKind, before: string): Promise<number> {
  if (!prunableKinds.has(kind)) return 0;
  try {
    return await repository().prune(kind, before);
  } catch {
    logEvent("warn", "history.prune_failed", { kind });
    return 0;
  }
}

export async function queryHistoryRecords(kind?: HistoryKind, limit = 100): Promise<HistoryRecord[]> {
  try {
    return await repository().query(kind, limit);
  } catch {
    return [];
  }
}

export async function countHistoryRecords(kind: HistoryKind): Promise<number> {
  try {
    return await repository().count(kind);
  } catch {
    logEvent("warn", "history.count_failed", { kind });
    return 0;
  }
}

export async function deleteHistoryRecord(id: string, kind?: HistoryKind) {
  try {
    await repository().delete(id, kind);
    return true;
  } catch {
    return false;
  }
}

// Only official observations are persisted. Existing API and simulated history stay separate.
export interface CodexQuotaHistory {
  type: "codex-quota";
  source: "codex-cli-official-rpc";
  windows: AgentUsageWindow[];
}
export type CodexQuotaRecord = HistoryRecord<CodexQuotaHistory>;

export function codexQuotaRecords(records: HistoryRecord[]): CodexQuotaRecord[] {
  return records.flatMap(record => {
    const payload = record.payload as Partial<CodexQuotaHistory> | null;
    if (record.kind !== "provider_history" || !Number.isFinite(Date.parse(record.createdAt))
      || !payload || payload.type !== "codex-quota" || payload.source !== "codex-cli-official-rpc"
      || !Array.isArray(payload.windows) || !payload.windows.length) return [];
    const windows = payload.windows;
    if (windows.length > 8 || new Set(windows.map(window => window?.id)).size !== windows.length
      || windows.some(window => !window || typeof window.id !== "string" || window.id.length > 80
        || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100
        || (window.windowDurationMins !== undefined && (!Number.isFinite(window.windowDurationMins) || window.windowDurationMins <= 0)))) return [];
    return [record as CodexQuotaRecord];
  }).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
}

export function codexQuotaHistoryRecord(account: AgentQuotaAccount | undefined, previous?: CodexQuotaRecord, now=Date.now()): CodexQuotaRecord | null {
  if (!account || account.id !== "codex" || account.confidence !== "verified"
    || account.source !== "codex-cli-official-rpc" || account.availabilityReason
    || !["normal","warning","online"].includes(account.state)) return null;
  const at=Date.parse(account.observedAt);
  if (!Number.isFinite(at) || at<=0 || at>now || now-at>300_000
    || (previous && at<=Date.parse(previous.createdAt))) return null;
  const windows=(account.usageWindows??[]).filter(window => Number.isFinite(window.usedPercent)
    && window.usedPercent>=0 && window.usedPercent<=100).map(window => ({
      id:window.id, usedPercent:window.usedPercent,
      ...(window.windowDurationMins!==undefined?{windowDurationMins:window.windowDurationMins}:{}),
      ...(window.resetsAt&&Number.isFinite(Date.parse(window.resetsAt))?{resetsAt:window.resetsAt}:{}),
    }));
  if (!windows.length) return null;
  const signature=(rows:AgentUsageWindow[])=>JSON.stringify(rows.map(row=>[row.id,row.windowDurationMins,row.usedPercent]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
  if (previous && signature(windows)===signature(previous.payload.windows)) return null;
  const record:CodexQuotaRecord={id:"codex-quota:"+account.observedAt,kind:"provider_history",createdAt:account.observedAt,
    payload:{type:"codex-quota",source:"codex-cli-official-rpc",windows}};
  return codexQuotaRecords([record]).length ? record : null;
}

let codexHistoryWrite:Promise<void>=Promise.resolve();
export function recordCodexQuotaChange(accounts:AgentQuotaAccount[], store:HistoryRepository=repository(), now=Date.now()):Promise<void> {
  const write=codexHistoryWrite.catch(()=>{}).then(async()=>{
    const account=accounts.find(item=>item.id==="codex");
    if(!account || account.confidence!=="verified" || account.source!=="codex-cli-official-rpc")return;
    const previous=codexQuotaRecords(await store.query("provider_history",1000)).at(-1);
    const record=codexQuotaHistoryRecord(account,previous,now);
    if(record)await store.insert(record);
  });
  codexHistoryWrite=write;
  return write;
}

export async function readCodexQuotaHistory():Promise<CodexQuotaRecord[]> {
  return codexQuotaRecords(await repository().query("provider_history",1000)).slice(-120);
}
