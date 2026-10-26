import type { ProviderState } from "../providers/contracts";

export type AgentConfidence = "verified" | "local" | "estimated" | "unknown";
export interface AgentRuntimeSnapshot {
  available: boolean;
  partial: boolean;
  observedAtUnixMs: number;
  clients: Array<{id: string; processCount: number}>;
}
export type AgentAvailabilityReason = "no-source" | "not-logged-in" | "unsupported-account" | "quota-unavailable" | "no-quota-source" | "read-failed" | "unsupported-runtime";
export interface AgentUsageWindow {
  id: string;
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: string;
  title?: string;
}

export interface AgentQuotaAccount {
  id: string;
  name: string;
  state: ProviderState;
  remainingPercent?: number;
  remainingSeconds?: number;
  quotaPeriod?: "daily" | "weekly" | "fast-requests" | "cycle";
  resetAt?: string;
  resetPolicy?: "daily" | "weekly" | "subscription";
  resetWeekday?: number;
  availabilityReason?: AgentAvailabilityReason;
  installed?: boolean;
  running?: boolean;
  loginStatus?: "unknown" | "not-logged-in" | "configured" | "verified";
  plan?: string;
  usageType?: string;
  source?: string;
  confidence?: AgentConfidence;
  usageWindows?: AgentUsageWindow[];
  ordinaryUsageAllowed?: boolean;
  cliDetected?: boolean;
  configurationDetected?: boolean;
  cacheDetected?: boolean;
  membership?: {available:boolean;source?:string;planName?:string|null;expiryText?:string|null;benefits:Array<{label:string;detail:string}>;observedAtUnixMs?:number;cached?:boolean};
  observedAt: string;
}
