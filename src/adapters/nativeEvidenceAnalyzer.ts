import { invoke } from "@tauri-apps/api/core";
import type { EvidenceAnalyzer, EvidenceBatch, AnalysisConsent } from "../ports/evidenceAnalyzer";
import type { RemoteAnalysisProvider } from "../domain/analysis/remoteSettings";

export interface AnalysisReceipt {
  provider: RemoteAnalysisProvider; model: string; batchId: string;
  requestedAtUnixMs: number; completedAtUnixMs: number; inputTokens: number | null; outputTokens: number | null;
}
type Invoker = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
// Consent stays per invocation. It is never persisted as permission for future uploads.
export function nativeEvidenceAnalyzer(provider: RemoteAnalysisProvider, consent: AnalysisConsent, nativeInvoke: Invoker = invoke): EvidenceAnalyzer & { receipt: AnalysisReceipt | null } {
  const adapter: EvidenceAnalyzer & { receipt: AnalysisReceipt | null } = {
    providerId: `analysis-${provider}`, receipt: null,
    async analyze(batch: EvidenceBatch, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const { batchId, ...body } = batch;
      const requestId = crypto.randomUUID();
      const cancel = () => { void nativeInvoke("cancel_history_analysis", { requestId }).catch(() => undefined); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const response = await nativeInvoke<{ selection: unknown; receipt: AnalysisReceipt }>("analyze_history_remote", {
          request: { requestId, provider, batchId, bodyJson: JSON.stringify(body), consent },
        });
        signal?.throwIfAborted();
        const receipt = response.receipt;
        if (!receipt || receipt.provider !== provider || receipt.batchId !== batchId || !receipt.model
          || !Number.isFinite(receipt.requestedAtUnixMs) || !Number.isFinite(receipt.completedAtUnixMs) || receipt.completedAtUnixMs < receipt.requestedAtUnixMs)
          throw new Error("推理响应回执无效");
        adapter.receipt = receipt;
        return response.selection;
      } finally { signal?.removeEventListener("abort", cancel); }
    },
  };
  return adapter;
}
