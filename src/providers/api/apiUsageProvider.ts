import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ApiConnectionSettings } from "../../types";
import type { Provider } from "../contracts";
import type { ApiUsageAccount, ApiUsageData } from "../data";
import type { ApiUnavailableReason } from "../../domain/api/contracts";
import { hasCredential } from "../../services/credentials";
import { writeHistoryRecord } from "../../services/historyStore";
import { liveProvenance } from "../../domain/analysis/contracts";

export type ApiSource = "deepseek" | "anthropic" | "mimo" | "openai";
interface BackendSnapshot {
  accounts: Array<Omit<ApiUsageAccount, "balance" | "todayCost" | "monthCost" | "periodStart" | "periodEnd" | "todayPeriodStart" | "todayPeriodEnd"> & {
    balance: number | null; todayCost: number | null; monthCost: number | null; periodStart: string | null; periodEnd: string | null;
    todayPeriodStart?: string | null; todayPeriodEnd?: string | null;
  }>;
  observedAt: string;
}
export const defaultApiConnections: ApiConnectionSettings = { deepseekEnabled: false, anthropicEnabled: false, openaiEnabled: false, mimoEnabled: false, mimoDailyAuto: false, credentialRevision: 0 };
const names = { deepseek: "DeepSeek", anthropic: "Anthropic API", mimo: "MiMo", openai: "OpenAI API" };
const sourceUrls = { deepseek: "https://api.deepseek.com/user/balance", anthropic: "https://api.anthropic.com/v1/organizations/cost_report", mimo: "https://platform.xiaomimimo.com/", openai: "https://api.openai.com/v1/organization/costs" };

export function unknownApiAccount(source: ApiSource, availabilityReason: ApiUnavailableReason): ApiUsageAccount {
  return { id: source, name: names[source], state: "unknown", currency: source === "deepseek" || source === "mimo" ? "CNY" : "USD", observedAt: "", availabilityReason, sourceUrl: sourceUrls[source] };
}

export function normalizeApiSnapshot(snapshot: BackendSnapshot): ApiUsageData {
  if (!Array.isArray(snapshot.accounts) || !snapshot.accounts.length || !Number.isFinite(Date.parse(snapshot.observedAt))) throw new Error("费用响应缺少有效时间或账户");
  return { type: "api-balances", mode: "live", accounts: snapshot.accounts.map((account) => ({
    id: account.id, name: account.name, state: account.state, currency: account.currency,
    observedAt: account.observedAt, sourceUrl: account.sourceUrl, availabilityReason: account.availabilityReason,
    balance: typeof account.balance==="number"&&Number.isFinite(account.balance)?account.balance:undefined,
    todayCost: typeof account.todayCost==="number"&&Number.isFinite(account.todayCost)?account.todayCost:undefined,
    monthCost: typeof account.monthCost==="number"&&Number.isFinite(account.monthCost)?account.monthCost:undefined,
    periodStart: account.periodStart ?? undefined, periodEnd: account.periodEnd ?? undefined,
    todayPeriodStart: account.todayPeriodStart ?? undefined, todayPeriodEnd: account.todayPeriodEnd ?? undefined,
    amountScope:account.amountScope,periodTimeZone:account.periodTimeZone,
  })) };
}

export async function readApiUsage(source: ApiSource): Promise<ApiUsageData> {
  return normalizeApiSnapshot(source === "mimo" ? await invoke<BackendSnapshot>("read_mimo_usage") : await invoke<BackendSnapshot>("read_api_usage", { source }));
}

export function createApiUsageProvider(source: ApiSource, config: ApiConnectionSettings): Provider<ApiUsageData> {
  const enabled = source === "openai" ? config.openaiEnabled === true : source === "mimo" ? config.mimoEnabled === true : source === "deepseek" ? config.deepseekEnabled : config.anthropicEnabled;
  return {
    id: `api-${source}`, name: names[source], kind: "api", refreshIntervalMs: enabled ? 60_000 : null,
    backgroundRefreshIntervalMs: null, timeoutMs: 65_000,
    retryPolicy: { maxRetries: 0 }, cacheKey: `money-v2:${enabled}:${config.credentialRevision}`,
    load: async () => {
      const unavailable = (reason: ApiUnavailableReason) => ({ status: "unavailable" as const, retryable: false, data: { type: "api-balances" as const, mode: "live" as const, accounts: [unknownApiAccount(source, reason)] } });
      if (!enabled) return unavailable("not-enabled");
      if (!isTauri()) return unavailable("unsupported-runtime");
      try {
        if (!await hasCredential(source)) return unavailable("unconfigured");
        const data = await readApiUsage(source);
        const observedAt = data.accounts[0].observedAt;
        if (source !== "mimo") await writeHistoryRecord({ id: `api:${source}:${observedAt}`, kind: "usage_history", createdAt: observedAt,
          payload: { schemaVersion: 1, source, sourceUrl: sourceUrls[source], simulation: false,
            provenance: liveProvenance(`api-${source}`), accounts: data.accounts } });
        return { status: data.accounts.some((account) => account.state === "warning") ? "degraded" : "normal", data, observedAt, retryable: false };
      } catch (error) {
        const response = error && typeof error === "object" ? error as { code?: string; message?: string; retryable?: boolean } : {};
        const message = response.message || "费用读取失败";
        if (response.code === "credential") return unavailable("unconfigured");
        return { status: "error", data: { type: "api-balances", mode: "live", accounts: [unknownApiAccount(source, "read-failed")] }, error: message, retryable: response.retryable === true };
      }
    },
  };
}
