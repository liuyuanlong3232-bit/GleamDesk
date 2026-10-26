import type { VpsObservation, VpsState } from "../../domain/vps/contracts";
import type { HistoryRecord } from "../../types";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const scalar = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
const time = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function vpsObservationFromHistory(record: HistoryRecord, hubUrl: string, serverId: string): VpsObservation | undefined {
  const payload = object(record.payload);
  if (record.kind !== "vps_history" || payload.hubUrl !== hubUrl || payload.serverId !== serverId) return undefined;
  const modern = payload.schemaVersion === 2;
  const raw = object(modern ? payload.observation : payload.snapshot);
  if (!Object.keys(raw).length) return undefined;
  const gauges = Array.isArray(raw.gauges) ? raw.gauges.map(object) : [];
  const legacyPercent = (key: string, label: string) => scalar(payload[key], 100) ?? scalar(gauges.find(gauge => gauge.label === label)?.value, 100);
  const observedAt = time(modern ? raw.observedAt : raw.lastUpdated) ?? time(record.createdAt);
  if (!observedAt) return undefined;
  const network = object(raw.network);
  const services = (Array.isArray(raw.services) ? raw.services : []).flatMap(value => {
    const item = object(value);
    return typeof item.name === "string" && ["online", "offline", "unknown"].includes(String(item.state))
      ? [{ name: item.name.slice(0, 160), state: item.state as "online" | "offline" | "unknown" }] : [];
  }).slice(0, 20);
  return {
    name: typeof raw.name === "string" ? raw.name : serverId,host:typeof raw.host==="string"?raw.host:null,serverId,
    state: ["online", "offline", "warning"].includes(String(raw.state)) ? raw.state as VpsState : "unknown",
    availability: "ready", uptimeSeconds: modern ? scalar(raw.uptimeSeconds) : null,
    latencyMs: scalar(modern ? raw.latencyMs : raw.latency),
    cpuPercent: modern ? scalar(raw.cpuPercent, 100) : legacyPercent("cpu", "CPU"),
    memoryPercent: modern ? scalar(raw.memoryPercent, 100) : legacyPercent("memory", "内存"),
    diskPercent: modern ? scalar(raw.diskPercent, 100) : legacyPercent("disk", "硬盘"),
    network: { uploadBytes: scalar(network.uploadBytes) ?? undefined, downloadBytes: scalar(network.downloadBytes) ?? undefined, totalBytes: scalar(network.totalBytes) ?? undefined },
    services, observedAt, lastSuccessAt:raw.sourceTimeVerified===true?observedAt:null,
    sourceTimeVerified:raw.sourceTimeVerified===true,fetchedAt:time(raw.fetchedAt),
  };
}
