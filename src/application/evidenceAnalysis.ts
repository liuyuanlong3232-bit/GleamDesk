import type { AnalysisCandidate, HistoryAnalysisReport } from "../domain/analysis/contracts";
import type { AnalysisConsent, EvidenceAnalyzer, EvidenceBatch } from "../ports/evidenceAnalyzer";

export async function prepareEvidenceBatch(report: HistoryAnalysisReport): Promise<EvidenceBatch> {
  if (!report.aiReadiness.eligible) throw new Error("真实历史尚未通过完整性与稳定性检查");
  if (report.evidence.length > 256 || !report.evidence.length) throw new Error("证据批次超出数量上限");
  const body = { schemaVersion: 1 as const, request: report.request, generatedAt: report.generatedAt,
    actualFrom: report.actualFrom, actualTo: report.actualTo, evidence: report.evidence,
    candidates: report.candidates, uncertainties: report.uncertainties };
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.byteLength > 128 * 1024) throw new Error("证据批次超过 128 KiB，请缩短范围或减少来源");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const batchId = Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
  return JSON.parse(JSON.stringify({ ...body, batchId })) as EvidenceBatch;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key));
}
export function validateEvidenceSelection(batch: EvidenceBatch, output: unknown): AnalysisCandidate[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("模型输出必须是结构化选择");
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > 64 * 1024) throw new Error("模型输出超过上限");
  const response = output as Record<string, unknown>;
  if (!exactKeys(response, ["schemaVersion", "batchId", "selections"]) || response.schemaVersion !== 1 || response.batchId !== batch.batchId
    || !Array.isArray(response.selections) || response.selections.length > 12) throw new Error("模型输出批次或格式无效");
  const allowed = new Map(batch.candidates.map((candidate) => [candidate.id, candidate]));
  const evidence = new Set(batch.evidence.map((entry) => entry.id));
  const selected = new Set<string>();
  return response.selections.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型观察格式无效");
    const selection = value as Record<string, unknown>;
    if (!exactKeys(selection, ["candidateId", "evidenceIds"]) || typeof selection.candidateId !== "string" || !Array.isArray(selection.evidenceIds)
      || selection.evidenceIds.some((id: unknown) => typeof id !== "string")) throw new Error("模型观察必须关联已知证据");
    const candidate = allowed.get(selection.candidateId);
    const references = selection.evidenceIds as string[];
    if (!candidate || selected.has(candidate.id) || !references.length || new Set(references).size !== references.length
      || references.length !== candidate.evidenceIds.length || references.some((id) => !evidence.has(id) || !candidate.evidenceIds.includes(id)))
      throw new Error("模型引用遗漏、重复或越界");
    selected.add(candidate.id);
    return structuredClone(candidate);
  });
}

export async function runEvidenceAnalyzer(report: HistoryAnalysisReport, analyzer: EvidenceAnalyzer, consent: AnalysisConsent,
  signal?: AbortSignal): Promise<{ batchId: string; providerId: string; observations: AnalysisCandidate[] }> {
  if (consent.enabled !== true || !analyzer.providerId || consent.providerId !== analyzer.providerId || consent.from !== report.request.from
    || consent.to !== report.request.to || consent.sources.length !== report.request.sources.length
    || consent.sources.some((source) => !report.request.sources.includes(source)) || new Set(consent.sources).size !== consent.sources.length)
    throw new Error("推理服务和本次数据范围尚未获得有效选择");
  signal?.throwIfAborted();
  const batch = await prepareEvidenceBatch(report);
  const output = await analyzer.analyze(structuredClone(batch), signal);
  signal?.throwIfAborted();
  return { batchId: batch.batchId, providerId: analyzer.providerId, observations: validateEvidenceSelection(batch, output) };
}
