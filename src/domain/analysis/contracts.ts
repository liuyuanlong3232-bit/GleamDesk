import type { HistoryRecord } from "../../types";

export const analysisSources = ["hardware", "system", "vps", "api"] as const;
export type AnalysisSource = typeof analysisSources[number];
export interface LiveProvenance {
  schemaVersion: 1;
  mode: "live";
  providerId: string;
}
export function liveProvenance(providerId: string): LiveProvenance {
  return { schemaVersion: 1, mode: "live", providerId };
}
export interface AnalysisRequest {
  from: string;
  to: string;
  timeZone: string;
  sources: AnalysisSource[];
}
export interface HistoryRangeResult {
  records: HistoryRecord[];
  totalCount: number;
  truncated: boolean;
}
export interface EvidenceMetric {
  key: string;
  label: string;
  unit: string;
  value: number;
  periodStart?: string;
  periodEnd?: string;
}
export interface AnalysisEvidence {
  id: string;
  recordId: string;
  kind: HistoryRecord["kind"];
  source: AnalysisSource;
  providerId: string;
  observedAt: string;
  metrics: EvidenceMetric[];
  event?: { source: string; eventId: number; severity: string; message: string };
  sourceUrl?: string;
}
export interface AnalysisSourceSummary {
  source: AnalysisSource;
  status: "available" | "partial" | "DATA_UNAVAILABLE";
  queriedCount: number;
  acceptedCount: number;
  excludedCount: number;
  truncated: boolean;
  firstAt: string | null;
  lastAt: string | null;
  stale: boolean;
  issues: string[];
}
export interface MetricSummary {
  key: string;
  label: string;
  unit: string;
  source: AnalysisSource;
  sampleCount: number;
  minimum: number;
  maximum: number;
  sampleMean: number;
  evidenceIds: string[];
  periodStart?: string;
  periodEnd?: string;
}
export interface AnalysisCandidate {
  id: string;
  kind: "metric-summary" | "time-proximity";
  title: string;
  detail: string;
  evidenceIds: string[];
}
export interface HistoryAnalysisReport {
  schemaVersion: 1;
  status: "available" | "partial" | "DATA_UNAVAILABLE";
  request: AnalysisRequest;
  generatedAt: string;
  actualFrom: string | null;
  actualTo: string | null;
  sources: AnalysisSourceSummary[];
  evidence: AnalysisEvidence[];
  metrics: MetricSummary[];
  candidates: AnalysisCandidate[];
  aiReadiness: { eligible: boolean; reasons: string[] };
  uncertainties: string[];
}
