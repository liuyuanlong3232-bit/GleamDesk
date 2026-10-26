export interface LocalModel {
  name: string;
  sizeBytes?: number | null;
  family?: string | null;
  parameterSize?: string | null;
  quantization?: string | null;
  sizeVramBytes?: number | null;
  expiresAt?: string | null;
  remote: boolean;
}
export interface LocalAiSnapshot {
  serviceStatus: "online" | "offline" | "unknown";
  source: string;
  models: LocalModel[];
  runningModels: LocalModel[];
  modelCount: number | null;
  truncated: boolean;
  observedAtUnixMs: number;
  error: string | null;
  usage?:{scope:"workbench-only";requests:number;inputTokens:number;outputTokens:number;unmeasuredRequests:number;recordingSinceAtUnixMs:number;lastRecordedAtUnixMs?:number}|null;
}
