export type RemoteAnalysisProvider = "deepseek" | "anthropic";
export interface RemoteAnalysisSettings { provider: RemoteAnalysisProvider | null; credentialRevision: number }
export const analysisModels: Record<RemoteAnalysisProvider, string> = {
  deepseek: "deepseek-flash", anthropic: "claude-haiku-4-5-20251001",
};
export function normalizeRemoteAnalysisSettings(value: unknown): RemoteAnalysisSettings {
  const item = value && typeof value === "object" ? value as Partial<RemoteAnalysisSettings> : {};
  return { provider: item.provider === "deepseek" || item.provider === "anthropic" ? item.provider : null,
    credentialRevision: typeof item.credentialRevision === "number" && Number.isSafeInteger(item.credentialRevision) && item.credentialRevision >= 0 ? item.credentialRevision : 0 };
}
