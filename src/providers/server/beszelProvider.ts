import { invoke, isTauri } from "@tauri-apps/api/core";
import type { HistoryRecord } from "../../types";
import type { NativeBeszelObservation, VpsObservation } from "../../domain/vps/contracts";
import { safeBeszelError } from "../../domain/vps/contracts";
import { vpsObservationFromHistory } from "../../adapters/history/vpsHistory";
import type { Provider, ProviderLoadResult } from "../contracts";
import type { VpsStatusData } from "../data";
import { createHistoryRecord, queryHistoryRecords, writeHistoryRecord } from "../../services/historyStore";
import { liveProvenance } from "../../domain/analysis/contracts";

export interface BeszelProviderConfig {
  url: string;
  systemId: string;
  refreshIntervalSeconds: number;
  credentialRevision?: number;
}

export function emptyVpsObservation(availability: VpsObservation["availability"] = "unconfigured", serverId = ""): VpsObservation {
  return {
    name: "Beszel", serverId, state: "unknown", availability,
    uptimeSeconds: null, latencyMs: null, cpuPercent: null, memoryPercent: null, diskPercent: null,
    network: {}, services: [], observedAt: null, lastSuccessAt: null,
  };
}

function readableError(error: unknown) {
  return safeBeszelError(error);
}

export function snapshotAfterFailure(systemId: string, message: string, previous?: VpsObservation): VpsObservation {
  const availability = message.includes("尚未配置") ? "credentials-missing" : "failed";
  if (previous) {
    return { ...previous, state: availability === "failed" ? "offline" : previous.state, availability, error: message };
  }
  return {
    ...emptyVpsObservation(availability, systemId),
    name: systemId || "Beszel",
    state: message.includes("尚未配置") ? "unknown" : "offline",
    error: message,
  };
}

export function snapshotFromVpsHistory(records: HistoryRecord[], config: Pick<BeszelProviderConfig, "url" | "systemId">) {
  const hubUrl = config.url.trim().replace(/\/+$/, "");
  for (const record of records) {
    const observation = vpsObservationFromHistory(record, hubUrl, config.systemId.trim());
    if (observation) return observation;
  }
  return undefined;
}

async function loadSnapshot(config: BeszelProviderConfig): Promise<VpsObservation> {
  const url = config.url.trim().replace(/\/+$/, "");
  const systemId = config.systemId.trim();
  if (!url || !systemId) return emptyVpsObservation();
  if (!isTauri()) return emptyVpsObservation("platform-unsupported", systemId);

  try {
    const result = await invoke<NativeBeszelObservation>("fetch_beszel_snapshot", { baseUrl: url, systemId,
      minimumIntervalMs: Math.max(10, Math.min(300, Math.round(config.refreshIntervalSeconds || 30))) * 1_000 });
    const snapshot = observationFromNative(result);
    if(hasFreshVpsSample(snapshot,Date.now(),Math.max(10,Math.min(300,config.refreshIntervalSeconds||30))*1000))await writeHistoryRecord(await createVpsHistoryRecord(config, snapshot));
    return snapshot;
  } catch (error) {
    const message = readableError(error);
    const previous = snapshotFromVpsHistory(await queryHistoryRecords("vps_history", 100), config);
    return snapshotAfterFailure(systemId, message, previous);
  }
}

export function observationFromNative(result: NativeBeszelObservation): VpsObservation {
  const time=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=8.64e15?new Date(value).toISOString():null;
  const fetchedAt=time(result.fetchedAtUnixMs),rawTime=time(result.sampledAtUnixMs);
  const observedAt=rawTime&&Date.parse(rawTime)<=(fetchedAt?Date.parse(fetchedAt):Date.now())+1000?rawTime:null;
  return { name: result.name,host:result.host??null,serverId: result.serverId, state: result.state, availability: "ready",
    uptimeSeconds: result.uptimeSeconds, latencyMs: result.latencyMs,
    cpuPercent: result.cpuPercent, memoryPercent: result.memoryPercent, diskPercent: result.diskPercent,
    network: { ...result.network }, services: result.services.map(service => ({ ...service })), observedAt, lastSuccessAt: fetchedAt?observedAt:null,fetchedAt,sourceTimeVerified:observedAt!==null&&fetchedAt!==null };
}

export function hasFreshVpsSample(snapshot:VpsObservation,now:number,intervalMs=30000){
  const time=snapshot.observedAt?Date.parse(snapshot.observedAt):NaN;
  return snapshot.sourceTimeVerified===true&&Number.isFinite(time)&&time<=now+1000&&now-time<=Math.max(120000,intervalMs*3);
}

export async function createVpsHistoryRecord(config: Pick<BeszelProviderConfig, "url" | "systemId">, snapshot: VpsObservation) {
  const sampledAt = snapshot.observedAt;
  if (snapshot.sourceTimeVerified!==true||!sampledAt || new Date(sampledAt).toISOString() !== sampledAt) throw new Error("VPS 来源时间未确认，未写入实时历史");
  const identity = JSON.stringify([config.url.trim().replace(/\/+$/, ""), config.systemId.trim(), sampledAt]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const id = `vps-sample-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const record = createHistoryRecord("vps_history", {
    schemaVersion: 2, sourceTimeVerified:true, provenance: liveProvenance("vps-status"), hubUrl: config.url.trim().replace(/\/+$/, ""), serverId: config.systemId.trim(),
    cpu: snapshot.cpuPercent, memory: snapshot.memoryPercent, disk: snapshot.diskPercent,
    network: snapshot.network, status: snapshot.state, observation: snapshot,
  }, id);
  record.createdAt = sampledAt;
  return record;
}

export function createBeszelProvider(config: BeszelProviderConfig): Provider<VpsStatusData> {
  const interval = Math.max(10, Math.min(300, Math.round(config.refreshIntervalSeconds || 30))) * 1_000;
  return {
    id: "vps-status",
    name: "Beszel VPS 状态",
    kind: "server",
    refreshIntervalMs: config.url.trim() && config.systemId.trim() ? interval : null,
    timeoutMs: 20_000,
    retryPolicy: { maxRetries: 1, initialDelayMs: 1_000, maxDelayMs: 4_000 },
    cacheKey: `source-time-v1::${config.url.trim().replace(/\/+$/, "")}::${config.systemId.trim()}::${config.credentialRevision ?? 0}`,
    load: async () => {
      const snapshot = await loadSnapshot(config);
      return beszelProviderResult(snapshot, Boolean(config.url.trim() && config.systemId.trim()),Date.now(),interval);
    },
  };
}

export function beszelProviderResult(snapshot: VpsObservation, configured: boolean,now=Date.now(),intervalMs=30000): ProviderLoadResult<VpsStatusData> {
  if(snapshot.availability==="ready"&&configured&&!hasFreshVpsSample(snapshot,now,intervalMs)){
    const known=snapshot.sourceTimeVerified===true&&snapshot.observedAt!==null&&Number.isFinite(Date.parse(snapshot.observedAt))&&Date.parse(snapshot.observedAt)<=now+1000;
    const error=known?"数据未更新":"来源时间未确认";
    return {status:"unavailable",data:{type:"vps-status",observation:{...snapshot,state:known?"warning":"unknown",error}},error,retryable:false,observedAt:known?snapshot.observedAt!:undefined,retained:known};
  }
  const failed = snapshot.availability === "failed";
  const status = failed && configured ? "error" : !configured || snapshot.availability !== "ready" || snapshot.error ? "unavailable"
    : snapshot.state === "online" ? "normal" : snapshot.state === "warning" || snapshot.state === "offline" ? "degraded" : "unavailable";
  return { status, data: { type: "vps-status", observation: snapshot }, error: snapshot.error,
    observedAt: snapshot.lastSuccessAt ?? snapshot.observedAt ?? undefined,
    retained: Boolean(snapshot.error && snapshot.lastSuccessAt),
    retryable: failed && snapshot.state === "offline" && configured };
}

export async function testBeszelConnection(config: Pick<BeszelProviderConfig, "url" | "systemId">) {
  if (!config.url.trim() || !config.systemId.trim()) throw new Error("请先填写 Beszel Hub 地址和 System ID");
  if (!isTauri()) throw new Error("请在 Windows 桌面应用中测试 Beszel 连接");
  return invoke<NativeBeszelObservation>("fetch_beszel_snapshot", { baseUrl: config.url.trim(), systemId: config.systemId.trim() });
}
