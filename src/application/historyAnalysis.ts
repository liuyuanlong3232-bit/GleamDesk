import type { HistoryKind, HistoryRecord } from "../types";
import type { HistoryRepository } from "../services/historyRepository";
import { analysisSources } from "../domain/analysis/contracts";
import type { AnalysisCandidate, AnalysisEvidence, AnalysisRequest, AnalysisSource, AnalysisSourceSummary, EvidenceMetric,
  HistoryAnalysisReport, HistoryRangeResult, MetricSummary } from "../domain/analysis/contracts";

const kinds: Record<AnalysisSource, HistoryKind> = {
  hardware: "hardware_history", system: "system_events", vps: "vps_history", api: "usage_history",
};
const freshness: Record<AnalysisSource, number> = { hardware: 120_000, system: 7 * 86_400_000, vps: 600_000, api: 600_000 };
// Evidence participates in a signed body digest: use UTF-16 ordinal order, never the machine's locale.
const evidenceOrder = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
export function isHistoryReportFresh(report: HistoryAnalysisReport, now: number): boolean {
  const generated = Date.parse(report.generatedAt);
  if (!Number.isFinite(now) || !Number.isFinite(generated) || generated > now + 1_000 || now - generated > 120_000) return false;
  return report.request.sources.every((source) => {
    const summary = report.sources.find((item) => item.source === source);
    const latest = summary?.lastAt ? Date.parse(summary.lastAt) : NaN;
    return Number.isFinite(latest) && latest <= now + 1_000 && now - latest <= freshness[source];
  });
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown, length = 160) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, length) : "";
const number = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;

export function validateAnalysisRequest(request: AnalysisRequest) {
  const from = Date.parse(request.from), to = Date.parse(request.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || new Date(from).toISOString() !== request.from
    || new Date(to).toISOString() !== request.to || to <= from || to - from > 7 * 86_400_000) throw new Error("分析范围必须是有效 UTC 时间且不超过 7 天");
  if (!Array.isArray(request.sources) || !request.sources.length || request.sources.length > 4
    || new Set(request.sources).size !== request.sources.length || request.sources.some((source) => !analysisSources.includes(source))) throw new Error("请选择有效且不重复的数据来源");
  if (typeof request.timeZone !== "string" || request.timeZone.length > 64) throw new Error("无效时区");
  new Intl.DateTimeFormat("zh-CN", { timeZone: request.timeZone });
}

function liveProvider(payload: ObjectValue, source: AnalysisSource): string | null {
  if (payload.simulation === true) return null;
  const provenance = object(payload.provenance);
  const provider = text(provenance.providerId);
  if (provenance.schemaVersion === 1 && provenance.mode === "live") {
    const expected = { hardware: ["hardware-status"], system: ["windows-health"], vps: ["vps-status"], api: ["api-deepseek", "api-anthropic"] };
    return expected[source].includes(provider) ? provider : null;
  }
  // Existing API history already has an explicit real-source envelope.
  if (source === "api" && payload.schemaVersion === 1 && payload.simulation === false
    && (payload.source === "deepseek" || payload.source === "anthropic")) return `api-${payload.source}`;
  return null;
}

function vpsHub(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch { return null; }
}

function normalizeEvidence(record: HistoryRecord, source: AnalysisSource): AnalysisEvidence | null {
  if (record.kind !== kinds[source] || !record.id || record.id.length > 160) return null;
  const payload = object(record.payload);
  const providerId = liveProvider(payload, source);
  if (!providerId) return null;
  let at = Date.parse(record.createdAt);
  const metrics: EvidenceMetric[] = [];
  const add = (key: string, label: string, unit: string, value: unknown, maximum = Number.MAX_SAFE_INTEGER) => {
    if (number(value, maximum) && !metrics.some((metric) => metric.key === key)) metrics.push({ key, label, unit, value });
  };
  let event: AnalysisEvidence["event"];
  let sourceUrl: string | undefined;
  if (source === "hardware") {
    if (!number(payload.sampledAtUnixMs)) return null;
    at = payload.sampledAtUnixMs;
    const cpu = object(payload.cpu), memory = object(payload.memory), network = object(payload.network);
    const disks = object(payload.disks), gpu = object(payload.gpu);
    if (cpu.usageStatus === "available") add("hardware.cpu", "本机 CPU", "%", cpu.usagePercent, 100);
    if (memory.status === "available") add("hardware.memory", "本机内存占用", "%", memory.usagePercent, 100);
    if (network.status === "available") {
      add("hardware.upload", "本机网络上传", "B/s", network.uploadBytesPerSecond);
      add("hardware.download", "本机网络下载", "B/s", network.downloadBytesPerSecond);
    }
    if (disks.status === "available" && Array.isArray(disks.volumes)) for (const entry of disks.volumes.slice(0, 32)) {
      const disk = object(entry), name = text(disk.name, 32);
      if (name && number(disk.totalBytes) && number(disk.usedBytes) && disk.usedBytes <= disk.totalBytes)
        add(`hardware.disk.${name}`, `本机磁盘 ${name}`, "%", disk.usagePercent, 100);
    }
    const gpuName = text(gpu.name, 128) || "GPU";
    if ((gpu.usageStatus ?? gpu.status) === "available") add(`hardware.gpu.${gpuName}`, `本机 ${gpuName}`, "%", gpu.usagePercent, 100);
    if ((gpu.memoryStatus ?? gpu.status) === "available" && number(gpu.memoryUsedBytes) && number(gpu.memoryTotalBytes)
      && gpu.memoryTotalBytes > 0 && gpu.memoryUsedBytes <= gpu.memoryTotalBytes)
      add(`hardware.gpu-memory.${gpuName}`, `${gpuName} 显存占用`, "%", gpu.memoryUsedBytes / gpu.memoryTotalBytes * 100, 100);
    if ((gpu.temperatureStatus ?? gpu.status) === "available") add(`hardware.gpu-temperature.${gpuName}`, `${gpuName} 温度`, "°C", gpu.temperatureC, 200);
  } else if (source === "system") {
    at = Date.parse(typeof payload.timestamp === "string" ? payload.timestamp : "");
    if (!number(payload.eventId, 65_535) || !Number.isInteger(payload.eventId)
      || !["critical", "error", "warning"].includes(String(payload.severity)) || !text(payload.source)) return null;
    event = { source: text(payload.source), eventId: payload.eventId, severity: String(payload.severity), message: text(payload.message, 512) };
  } else if (source === "vps") {
    const modern = payload.schemaVersion === 2;
    const snapshot = object(modern ? payload.observation : payload.snapshot);
    if (modern && (snapshot.availability !== "ready" || (snapshot.error !== undefined && snapshot.error !== null && snapshot.error !== ""))) return null;
    if (!["online", "warning"].includes(String(snapshot.state))) return null;
    const observed = modern ? snapshot.observedAt : snapshot.lastUpdated;
    at = Date.parse(typeof observed === "string" ? observed : "");
    const serverId = text(payload.serverId, 80);
    const hubUrl = vpsHub(payload.hubUrl);
    if (!serverId || !hubUrl || (!modern && !Array.isArray(snapshot.gauges))) return null;
    sourceUrl = hubUrl;
    const identity = JSON.stringify([hubUrl, serverId]);
    const gauges = modern ? [{ label: "CPU", value: snapshot.cpuPercent }, { label: "内存", value: snapshot.memoryPercent }, { label: "硬盘", value: snapshot.diskPercent }]
      : (snapshot.gauges as unknown[]).slice(0, 16);
    for (const entry of gauges) {
      const gauge = object(entry), label = text(gauge.label, 40);
      if (["CPU", "内存", "硬盘"].includes(label)) add(`vps.${identity}.${label}`, `${serverId} · ${text(hubUrl, 128)} ${label}`, "%", gauge.value, 100);
    }
    // Beszel transfer totals are not network rates and are not connected into a rate series.
  } else {
    if (!Array.isArray(payload.accounts) || payload.accounts.length > 8) return null;
    const sourceName = providerId.slice(4);
    if (payload.source !== sourceName || payload.simulation !== false) return null;
    for (const entry of payload.accounts) {
      const account = object(entry), id = text(account.id, 80), currency = text(account.currency, 3);
      if (!id || !["CNY", "USD"].includes(currency) || !["normal", "warning", "online"].includes(String(account.state))) continue;
      const observed = Date.parse(typeof account.observedAt === "string" ? account.observedAt : "");
      if (!Number.isFinite(observed) || Math.abs(observed - at) > 1_000) continue;
      const prefix = `api.${sourceName}.${id}.${currency}`;
      add(`${prefix}.balance`, `${sourceName} ${currency} 余额快照`, currency, account.balance);
      const start = Date.parse(typeof account.periodStart === "string" ? account.periodStart : "");
      const end = Date.parse(typeof account.periodEnd === "string" ? account.periodEnd : "");
      const todayStart = Date.parse(typeof account.todayPeriodStart === "string" ? account.todayPeriodStart : "");
      const todayEnd = Date.parse(typeof account.todayPeriodEnd === "string" ? account.todayPeriodEnd : "");
      if (Number.isFinite(todayStart) && Number.isFinite(todayEnd) && todayEnd > todayStart && todayEnd - todayStart <= 86_400_000) {
        const before = metrics.length, period = `${new Date(todayStart).toISOString()}/${new Date(todayEnd).toISOString()}`;
        add(`${prefix}.today.${period}`, `${sourceName} ${currency} 当日费用快照`, currency, account.todayCost);
        for (const metric of metrics.slice(before)) {
          metric.periodStart = new Date(todayStart).toISOString(); metric.periodEnd = new Date(todayEnd).toISOString();
        }
      }
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        const period = `${new Date(start).toISOString()}/${new Date(end).toISOString()}`;
        const before = metrics.length;
        add(`${prefix}.month.${period}`, `${sourceName} ${currency} 月累计费用快照`, currency, account.monthCost);
        for (const metric of metrics.slice(before)) {
          metric.periodStart = new Date(start).toISOString(); metric.periodEnd = new Date(end).toISOString();
        }
      }
    }
  }
  if (!Number.isFinite(at) || at < 0 || (!metrics.length && !event)) return null;
  return { id: `${record.kind}:${record.id}`, recordId: record.id, kind: record.kind, source, providerId,
    observedAt: new Date(at).toISOString(), metrics, ...(event ? { event } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(source === "api" ? { sourceUrl: providerId === "api-deepseek" ? "https://api.deepseek.com/user/balance" : "https://api.anthropic.com/v1/organizations/cost_report" } : {}) };
}

function summarizeMetrics(evidence: AnalysisEvidence[]): MetricSummary[] {
  const groups = new Map<string, { source: AnalysisSource; metric: EvidenceMetric; points: Array<{ value: number; id: string }> }>();
  for (const record of evidence) for (const metric of record.metrics) {
    let group = groups.get(metric.key);
    if (!group) { group = { source: record.source, metric, points: [] }; groups.set(metric.key, group); }
    group.points.push({ value: metric.value, id: record.id });
  }
  return [...groups.entries()].map(([key, group]) => ({ key, source: group.source, label: group.metric.label, unit: group.metric.unit,
    sampleCount: group.points.length, minimum: Math.min(...group.points.map((point) => point.value)),
    maximum: Math.max(...group.points.map((point) => point.value)),
    sampleMean: group.points.reduce((mean, point) => mean + point.value / group.points.length, 0),
    evidenceIds: group.points.map((point) => point.id),
    ...(group.metric.periodStart ? { periodStart: group.metric.periodStart, periodEnd: group.metric.periodEnd } : {}),
  })).sort((a, b) => evidenceOrder(a.key, b.key));
}

export function buildHistoryAnalysis(request: AnalysisRequest, queried: Partial<Record<AnalysisSource, HistoryRangeResult | Error>>,
  generatedAt = new Date().toISOString()): HistoryAnalysisReport {
  validateAnalysisRequest(request);
  const now = Date.parse(generatedAt);
  if (!Number.isFinite(now) || Date.parse(request.to) > now + 1_000) throw new Error("分析时间不能超出当前时间");
  const from = Date.parse(request.from), to = Date.parse(request.to);
  const evidence: AnalysisEvidence[] = [];
  const summaries: AnalysisSourceSummary[] = [];
  for (const source of request.sources) {
    const response = queried[source];
    const issues: string[] = [];
    const accepted: AnalysisEvidence[] = [];
    const seen = new Set<string>();
    let excludedCount = 0;
    if (!response || response instanceof Error) issues.push("历史读取失败，不能作为无异常或零值的证据");
    else for (const record of response.records) {
      const raw = object(record.payload);
      const rawTime = source === "hardware" && typeof raw.sampledAtUnixMs === "number" ? raw.sampledAtUnixMs
        : source === "system" ? Date.parse(typeof raw.timestamp === "string" ? raw.timestamp : "")
          : source === "vps" ? Date.parse(String(raw.schemaVersion === 2 ? object(raw.observation).observedAt ?? "" : object(raw.snapshot).lastUpdated ?? "")) : Date.parse(record.createdAt);
      if (Number.isFinite(rawTime) && (rawTime < from || rawTime >= to)) continue;
      const normalized = normalizeEvidence(record, source);
      if (!normalized || seen.has(normalized.id)) { excludedCount++; continue; }
      const time = Date.parse(normalized.observedAt);
      if (time < from || time >= to) continue;
      seen.add(normalized.id);
      accepted.push(normalized);
    }
    accepted.sort((a, b) => evidenceOrder(a.observedAt, b.observedAt));
    const firstAt = accepted[0]?.observedAt ?? null, lastAt = accepted.at(-1)?.observedAt ?? null;
    const stale = lastAt !== null && now - Date.parse(lastAt) > freshness[source];
    const truncated = !!response && !(response instanceof Error) && response.truncated;
    if (excludedCount) issues.push(`${excludedCount} 条模拟、旧格式、重复或无效记录未进入证据`);
    if (truncated) issues.push("查询数量或字节上限导致截断，统计只覆盖返回的记录");
    if (!accepted.length) issues.push("没有可确认来源的有效样本；空记录不证明没有异常");
    if (stale) issues.push("最近证据已过期，不代表当前状态");
    summaries.push({ source, status: !accepted.length ? "DATA_UNAVAILABLE" : issues.length ? "partial" : "available",
      queriedCount: response && !(response instanceof Error) ? response.totalCount : 0, acceptedCount: accepted.length,
      excludedCount, truncated, firstAt, lastAt, stale, issues });
    evidence.push(...accepted);
  }
  evidence.sort((a, b) => evidenceOrder(a.observedAt, b.observedAt) || evidenceOrder(a.id, b.id));
  const metrics = summarizeMetrics(evidence);
  const candidates: AnalysisCandidate[] = metrics.map((metric) => ({ id: `metric:${metric.key}`, kind: "metric-summary",
    title: metric.label, detail: `${metric.sampleCount} 个有效样本，最小 ${metric.minimum.toFixed(2)}、最大 ${metric.maximum.toFixed(2)}、样本均值 ${metric.sampleMean.toFixed(2)} ${metric.unit}`,
    evidenceIds: metric.evidenceIds }));
  const events = evidence.filter((record) => record.event);
  const proximityKeys = new Set<string>();
  for (let index = 0; index < events.length && proximityKeys.size < 20; index++) {
    for (let other = index + 1; other < events.length && proximityKeys.size < 20; other++) {
      if (Date.parse(events[other].observedAt) - Date.parse(events[index].observedAt) > 300_000) break;
      if (events[index].event!.source === events[other].event!.source) continue;
      const ids = [events[index].id, events[other].id];
      const key = `proximity:${ids.join("|")}`;
      proximityKeys.add(key);
      candidates.push({ id: key, kind: "time-proximity", title: "不同来源的事件时间接近",
        detail: "两条事件在 5 分钟内出现。该记录只说明时间共现，不能判断原因。", evidenceIds: ids });
    }
  }
  const reasons: string[] = [];
  const hardware = evidence.filter((entry) => entry.source === "hardware" && entry.metrics.some((metric) => metric.key === "hardware.cpu"));
  const span = hardware.length ? Date.parse(hardware.at(-1)!.observedAt) - Date.parse(hardware[0].observedAt) : 0;
  const maximumGap = hardware.slice(1).reduce((maximum, entry, index) => Math.max(maximum,
    Date.parse(entry.observedAt) - Date.parse(hardware[index].observedAt)), 0);
  const slots = new Set(hardware.map((entry) => Math.floor((Date.parse(entry.observedAt) - from) / 30_000)));
  const coverage = slots.size / Math.max(1, Math.ceil((to - from) / 30_000));
  if (hardware.length < 11 || span < 300_000) reasons.push("至少需要 11 个真实 CPU 历史样本，跨越 5 分钟");
  if (maximumGap > 90_000 || coverage < .8) reasons.push("选定范围的硬件覆盖不足 80%，或样本间存在超过 90 秒的中断");
  if (summaries.some((summary) => summary.status !== "available" || summary.stale)) reasons.push("部分选定来源缺失、过期、格式未确认或已截断");
  if (evidence.length > 256) reasons.push("证据超过远程批次上限；请缩短时间范围");
  return { schemaVersion: 1, status: !evidence.length ? "DATA_UNAVAILABLE" : summaries.some((summary) => summary.status !== "available") ? "partial" : "available",
    request: { ...request, sources: [...request.sources] }, generatedAt, actualFrom: evidence[0]?.observedAt ?? null,
    actualTo: evidence.at(-1)?.observedAt ?? null, sources: summaries, evidence, metrics, candidates,
    aiReadiness: { eligible: reasons.length === 0, reasons },
    uncertainties: ["统计和观察项来自本机历史计算；启用远程分析时，模型只筛选、排列这些观察项。", "均值按有效样本计算，不是整个时间段的时间加权均值；缺失指标不补零。",
      "离散网络速率不插值、不跨中断连接；API 余额与费用分开，币种和 UTC 费用范围分开。",
      "历史样本不证明当前连接可用；事件筛选历史不等于完整 Windows 日志。时间共现不证明因果。"] };
}

export async function runHistoryAnalysis(repository: Pick<HistoryRepository, "queryRange">, request: AnalysisRequest,
  generatedAt = new Date().toISOString()): Promise<HistoryAnalysisReport> {
  validateAnalysisRequest(request);
  const results = await Promise.allSettled(request.sources.map((source) => repository.queryRange(kinds[source],
    new Date(Date.parse(request.from) - (source === "hardware" ? 30_000 : 0)).toISOString(), request.to, 1_000)));
  const queried: Partial<Record<AnalysisSource, HistoryRangeResult | Error>> = {};
  results.forEach((result, index) => { queried[request.sources[index]] = result.status === "fulfilled" ? result.value : new Error("history read failed"); });
  return buildHistoryAnalysis(request, queried, generatedAt);
}
