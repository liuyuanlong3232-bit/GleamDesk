import assert from "node:assert/strict";
import { test } from "node:test";
import { providersFor } from "../src/providers/registry";
import { adaptProviderSnapshots, emptyDashboardData, mergeDashboardData } from "../src/providers/dashboardAdapter";
import { defaultApiConnections, normalizeApiSnapshot } from "../src/providers/api/apiUsageProvider";
import { formatMoney } from "../src/services/formatMoney";
import { presentAgentQuotas, presentApiUsage } from "../src/presentation/quotaAdapter";
import { demoProviderRegistry } from "../src/providers/demo/registry";

test("quota providers return domain facts and adapters format durations and source descriptions", async () => {
  const agent = await demoProviderRegistry.find(provider => provider.id === "agent-quotas")!.load(new AbortController().signal);
  assert.equal(agent.data?.type, "agent-quotas");
  if (agent.data?.type !== "agent-quotas") throw new Error("Missing quota demo");
  assert.ok(agent.data.accounts.every(account => !("remainingText" in account) && Number.isFinite(Date.parse(account.observedAt))));
  assert.equal(agent.data.accounts[0].remainingSeconds, 9060);
  assert.equal(presentAgentQuotas(agent.data.accounts, "normal", undefined, agent.data.mode)[0].remaining, "剩余 2h 31m");
  assert.equal(presentAgentQuotas(agent.data.accounts, "normal")[1].resetTime, "周一重置");
  assert.equal(presentAgentQuotas(agent.data.accounts, "stale", "读取失败")[0].state, "warning");
  const account = { id:"deepseek", name:"DeepSeek", state:"normal" as const, currency:"CNY", observedAt:"2026-10-06T05:00:00Z", sourceUrl:"https://api.deepseek.com/user/balance", balance:7.45 };
  assert.match(presentApiUsage([account],"normal")[0].detail!, /官方账户余额/);
  assert.equal(presentApiUsage([account],"unavailable")[0].state,"unknown");
  assert.equal(presentApiUsage([account],"degraded")[0].state,"warning");
  assert.equal(presentApiUsage([account],"error","真实错误")[0].detail,"真实错误");
});

test("backend legacy display text is stripped from the domain snapshot without losing real currency or periods", () => {
  const account = { id:"deepseek", name:"DeepSeek", state:"normal" as const, currency:"CNY", observedAt:"2026-10-06T05:00:00Z", sourceUrl:"https://api.deepseek.com/user/balance", balance:7.45, todayCost:null, monthCost:null, periodStart:null, periodEnd:null, detail:"legacy display text" };
  const data=normalizeApiSnapshot({ observedAt:account.observedAt, accounts:[account] });
  assert.equal("detail" in data.accounts[0],false);
  assert.equal(data.accounts[0].balance,7.45);
  assert.equal(data.mode,"live");
  assert.equal(data.accounts[0].todayCost,undefined);
});

test("normal mode contains no fabricated Agent or API quotas; demos require explicit simulation", async () => {
  const providers = providersFor(["agent-quotas", "api-balances"]);
  assert.ok(providers.every((provider) => !provider.name.includes("演示")));
  const snapshots = await Promise.all(providers.map(async (provider) => ({ ...await provider.load(new AbortController().signal), providerId: provider.id, lastUpdated: null, lastSuccessAt: null })));
  const data = adaptProviderSnapshots(providers, snapshots);
  assert.equal(data.providers.length, 9);
  assert.equal(data.notices.length, 0, "unconfigured sources are unknown, not incident notices");
  assert.ok(data.providers.every((item) => item.state === "unknown" && item.percentage === undefined && item.balance === undefined && item.todayCost === undefined));
  assert.ok(providersFor(["api-balances"], undefined, { includeLiveProviders: false }).some((provider) => provider.name.includes("演示")));
});

test("API reads refresh while visible and stop while hidden, using no secret cache keys", () => {
  const [provider] = providersFor(["api-deepseek"], undefined, { apiConfig: { ...defaultApiConnections, deepseekEnabled: true, credentialRevision: 10 } });
  assert.equal(provider.id, "api-deepseek");
  assert.equal(provider.refreshIntervalMs, 60_000);
  assert.equal(provider.backgroundRefreshIntervalMs, null);
  assert.equal(provider.cacheKey, "money-v2:true:10");
});

test("nullable backend costs remain unknown and money preserves the source currency", () => {
  const data = normalizeApiSnapshot({ observedAt: "2026-10-05T00:00:00Z", accounts: [{ id: "deepseek", name: "DeepSeek", state: "normal", currency: "USD", observedAt: "2026-10-05T00:00:00Z", balance: 5, todayCost: null, monthCost: null, periodStart: null, periodEnd: null }] });
  assert.equal(data.accounts[0].todayCost, undefined);
  assert.equal(data.accounts[0].balance, 5);
  assert.equal(formatMoney(undefined, "USD"), "未知");
  assert.match(formatMoney(5, "USD"), /\$/);
  assert.ok(!formatMoney(5, "USD").includes("¥"));
});

test("stale API data is visibly marked and changed currency rows replace the previous account set", () => {
  const [provider] = providersFor(["api-deepseek"]);
  const payload = { type: "api-balances" as const, accounts: [{ id: "deepseek", name: "DeepSeek", state: "normal" as const, currency: "CNY", balance: 5, observedAt: "2026-10-05T00:00:00Z" }] };
  const first = adaptProviderSnapshots([provider], [{ providerId: provider.id, status: "normal", data: payload, lastUpdated: payload.accounts[0].observedAt, lastSuccessAt: payload.accounts[0].observedAt }]);
  const stale = adaptProviderSnapshots([provider], [{ providerId: provider.id, status: "stale", data: payload, error: "网络失败", lastUpdated: "2026-10-05T00:10:00Z", lastSuccessAt: payload.accounts[0].observedAt }]);
  assert.equal(stale.providers[0].state, "warning");
  assert.match(stale.providers[0].detail ?? "", /已过期/);
  const update = adaptProviderSnapshots([provider], [{ providerId: provider.id, status: "normal", data: { ...payload, accounts: [{ ...payload.accounts[0], id: "deepseek-usd", currency: "USD" }, { ...payload.accounts[0], id: "deepseek-cny" }] }, lastUpdated: null, lastSuccessAt: null }]);
  assert.deepEqual(mergeDashboardData(first, update).providers.map((account) => account.id), ["deepseek-usd", "deepseek-cny"]);
});

test("individual API refreshes keep service rows in their existing positions", () => {
  const services = providersFor(["api-balances"]);
  const snapshots = services.map((provider) => ({ providerId: provider.id, status: "normal" as const,
    data: { type: "api-balances" as const, accounts: (provider.id === "api-unsupported" ? ["mimo", "openai"] : [provider.id.slice(4)])
      .map((id) => ({ id, name: id, state: "unknown" as const, currency: "", observedAt: "" })) },
    lastUpdated: null, lastSuccessAt: null }));
  let current = adaptProviderSnapshots(services, snapshots);
  const expected = current.providers.map((item) => item.id);
  for (const source of ["anthropic", "deepseek", "deepseek", "anthropic"]) {
    const [provider] = providersFor([`api-${source}`]);
    const update = adaptProviderSnapshots([provider], [{ providerId: provider.id, status: "normal", lastUpdated: null, lastSuccessAt: null,
      data: { type: "api-balances", accounts: [{ id: source, name: source, state: "normal", balance: 12, currency: "USD", observedAt: "" }] } }]);
    current = mergeDashboardData(current, update);
    assert.deepEqual(current.providers.map((item) => item.id), expected);
    assert.equal(current.providers.find((item) => item.id === source)?.balance, 12);
  }
});

test("merging the first complete snapshot preserves source order across provider kinds", () => {
  const initial = emptyDashboardData();
  initial.providers = [
    { id: "codex", name: "Codex", kind: "agent", state: "unknown", lastUpdated: "" },
    { id: "deepseek", name: "DeepSeek", kind: "api", state: "unknown", lastUpdated: "" },
    { id: "anthropic", name: "Anthropic", kind: "api", state: "unknown", lastUpdated: "" },
    { id: "mimo", name: "MiMo", kind: "api", state: "unknown", lastUpdated: "" },
  ];
  initial.providerDiagnostics = ["deepseek", "anthropic"].map((source) => ({
    providerId: `api-${source}`, name: source, status: "unavailable", lastUpdated: null, lastSuccessAt: null,
  }));
  assert.deepEqual(mergeDashboardData(emptyDashboardData(), initial).providers.map((item) => item.id), initial.providers.map((item) => item.id));
});

test("API failures and recovery replace the entire service group without leftover error or currency rows", () => {
  const [provider] = providersFor(["api-deepseek"]);
  const account = (id: string, currency: string) => ({ id, name: "DeepSeek", state: "normal" as const, currency, balance: 5, observedAt: "" });
  const success = (accounts: ReturnType<typeof account>[]) => adaptProviderSnapshots([provider], [{ providerId: provider.id, status: "normal",
    lastUpdated: null, lastSuccessAt: null, data: { type: "api-balances", accounts } }]);
  const initial = success([account("deepseek-usd", "USD"), account("deepseek-cny", "CNY")]);
  initial.providers.push({ id: "mimo", name: "MiMo", kind: "api", state: "unknown", lastUpdated: "" });
  const failed = adaptProviderSnapshots([provider], [{ providerId: provider.id, status: "error", data: null,
    error: "账户读取失败", lastUpdated: null, lastSuccessAt: null }]);
  const failure = mergeDashboardData(initial, failed);
  assert.deepEqual(failure.providers.map((item) => item.id).sort(), ["api-deepseek", "mimo"]);
  assert.equal(failure.providers.find((item) => item.id === "api-deepseek")?.state, "offline");
  const recovered = mergeDashboardData(failure, success([account("deepseek-usd", "USD")]));
  assert.deepEqual(recovered.providers.map((item) => item.id), ["deepseek-usd", "mimo"]);
  assert.equal(recovered.providers[0].state, "normal");
  assert.deepEqual(failure.providers.map((item) => item.id), ["api-deepseek", "mimo"]);
  assert.deepEqual(initial.providers.map((item) => item.id), ["deepseek-usd", "deepseek-cny", "mimo"], "merging must not mutate an earlier snapshot");
});
