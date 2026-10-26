import type { AnalysisCandidate, AnalysisEvidence, AnalysisRequest } from "../domain/analysis/contracts";

export interface EvidenceBatch {
  schemaVersion: 1;
  batchId: string;
  request: AnalysisRequest;
  generatedAt: string;
  actualFrom: string | null;
  actualTo: string | null;
  evidence: AnalysisEvidence[];
  candidates: AnalysisCandidate[];
  uncertainties: string[];
}
// The model ranks locally computed candidates. It cannot supply executable actions or new claims.
export interface EvidenceAnalyzer {
  providerId: string;
  analyze(batch: EvidenceBatch, signal?: AbortSignal): Promise<unknown>;
}
export interface EvidenceAnalysisSelection {
  schemaVersion: 1;
  batchId: string;
  selections: Array<{ candidateId: string; evidenceIds: string[] }>;
}
export interface AnalysisConsent {
  enabled: true;
  providerId: string;
  from: string;
  to: string;
  sources: AnalysisRequest["sources"];
}
