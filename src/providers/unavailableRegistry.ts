import type { Provider } from "./contracts";
import type { ApiUsageData } from "./data";

export const unavailableApiProvider: Provider<ApiUsageData> = {
  id: "api-unsupported", name: "其他 API 数据来源", kind: "api", refreshIntervalMs: null,
  load: async () => ({ status: "unavailable", retryable: false, data: { type: "api-balances", mode: "live", accounts: [
    { id: "openai", name: "OpenAI API", state: "unknown", currency: "", observedAt: "", availabilityReason: "deferred" },
  ] } }),
};
