import type { ProviderState } from "../providers/contracts";

export type ApiUnavailableReason = "not-enabled" | "unsupported-runtime" | "unconfigured" | "no-source" | "deferred" | "read-failed" | "balance-unavailable" | "balance-read-failed" | "mimo-console-balance" | "local-recommendation-estimate";
export type ApiAmountScope="balance"|"organization"|"local-estimate"|"unknown"|"demo";
export interface ApiUsageAccount {
  id: string;
  name: string;
  state: ProviderState;
  balance?: number;
  currency: string;
  todayCost?: number;
  monthCost?: number;
  observedAt: string;
  sourceUrl?: string;
  periodStart?: string;
  periodEnd?: string;
  todayPeriodStart?: string;
  todayPeriodEnd?: string;
  availabilityReason?: ApiUnavailableReason;
  amountScope?: ApiAmountScope;
  periodTimeZone?: "UTC"|"Asia/Shanghai";
}
