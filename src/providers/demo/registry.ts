import type { Provider } from "../contracts";
import type { AgentQuotaData, ApiUsageData, ApplicationCatalogData } from "../data";

const stamp = new Date().toISOString();

const agentAccounts: AgentQuotaData["accounts"] = [
  { id: "codex", name: "Codex", state: "normal", remainingPercent: 72, remainingSeconds: 9060, resetAt: new Date(Date.parse(stamp) + 7_200_000).toISOString(), observedAt: stamp },
  { id: "claude", name: "Claude Code", state: "normal", remainingPercent: 82, quotaPeriod: "weekly", resetPolicy: "weekly", resetWeekday: 1, observedAt: stamp },
  { id: "gemini", name: "Gemini CLI", state: "normal", remainingPercent: 70, quotaPeriod: "daily", resetPolicy: "daily", observedAt: stamp },
  { id: "cursor", name: "Cursor", state: "normal", remainingPercent: 68, quotaPeriod: "fast-requests", resetPolicy: "subscription", observedAt: stamp },
  { id: "antigravity", name: "Antigravity", state: "warning", remainingPercent: 45, quotaPeriod: "cycle", resetPolicy: "subscription", observedAt: stamp },
];

const apiAccounts: ApiUsageData["accounts"] = [
  { id: "deepseek", name: "DeepSeek", state: "normal", balance: 38.42, currency: "CNY", todayCost: 1.24, monthCost: 12.68, observedAt: stamp },
  { id: "mimo", name: "MiMo", state: "normal", balance: 71.05, currency: "CNY", todayCost: 2.31, monthCost: 28.42, observedAt: stamp },
  { id: "openai", name: "OpenAI API", state: "normal", balance: 12.6, currency: "CNY", todayCost: 0.48, monthCost: 6.32, observedAt: stamp },
  { id: "anthropic", name: "Anthropic API", state: "normal", balance: 8.32, currency: "CNY", todayCost: 0.21, monthCost: 4.18, observedAt: stamp },
];

const applications: ApplicationCatalogData["applications"] = [
  ["wechat", "微信"], ["qq", "QQ"], ["edge", "Edge"], ["vscode", "VS Code"],
  ["terminal", "Terminal"], ["codex", "Codex"], ["claude", "Claude"], ["chatgpt", "ChatGPT"],
].map(([id, name], order) => ({ id, name, icon: "", type: "exe", target: "", pinned: true, order }));

export const demoProviderRegistry: Provider<AgentQuotaData | ApiUsageData | ApplicationCatalogData>[] = [
  { id: "agent-quotas", name: "AI 使用额度（演示）", kind: "agent", refreshIntervalMs: null, load: async () => ({ status: "normal", data: { type: "agent-quotas", mode: "demo", accounts: agentAccounts } }) },
  { id: "api-balances", name: "API 余额（演示）", kind: "api", refreshIntervalMs: null, load: async () => ({ status: "normal", data: { type: "api-balances", mode: "demo", accounts: apiAccounts } }) },
  { id: "application-list", name: "快捷启动（演示）", kind: "dock", refreshIntervalMs: null, load: async () => ({ status: "normal", data: { type: "application-catalog", applications } }) },
];
