import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AgentQuotaAccount, AgentAvailabilityReason, AgentUsageWindow } from "../../domain/agent/contracts";
import type { Provider } from "../contracts";
import type { AgentQuotaData } from "../data";
import catalog from "../../domain/agent/clientCatalog.json";
import type {AgentRuntimeSnapshot} from "../../domain/agent/contracts";

export const agentClients = catalog;
export const unavailableAgentRuntime = ():AgentRuntimeSnapshot => ({available:false,partial:false,observedAtUnixMs:0,clients:[]});
export function normalizeAgentRuntime(value:unknown,now=Date.now()):AgentRuntimeSnapshot {
  const snapshot=value as Partial<AgentRuntimeSnapshot>|null;
  if(!snapshot||snapshot.available!==true||!Number.isFinite(snapshot.observedAtUnixMs)||snapshot.observedAtUnixMs!>now+5000||now-snapshot.observedAtUnixMs!>30000||!Array.isArray(snapshot.clients))return unavailableAgentRuntime();
  const counts=new Map<string,number>();
  for(const client of snapshot.clients){if(client&&agentClients.some(item=>item.id===client.id)&&Number.isInteger(client.processCount)&&client.processCount>0&&client.processCount<=4096)counts.set(client.id,Math.max(counts.get(client.id)??0,client.processCount))}
  return {available:true,partial:snapshot.partial===true,observedAtUnixMs:snapshot.observedAtUnixMs!,clients:agentClients.flatMap(client=>counts.has(client.id)?[{id:client.id,processCount:counts.get(client.id)!}]:[])};
}
export async function readAgentRuntime():Promise<AgentRuntimeSnapshot>{
  if(!isTauri())return unavailableAgentRuntime();
  try{return normalizeAgentRuntime(await invoke("read_agent_runtime"))}catch{return unavailableAgentRuntime()}
}
export function runningAgentClients(snapshot:unknown,now=Date.now()){
  const ids=new Set(normalizeAgentRuntime(snapshot,now).clients.map(client=>client.id));
  return agentClients.filter(client=>ids.has(client.id));
}
import { recordCodexQuotaChange } from "../../services/historyStore";
import { logEvent } from "../../services/appLogger";

export interface NativeSnapshot {
  observedAtUnixMs: number;
  accounts: Array<{ id: string; name: string; state: AgentQuotaAccount["state"]; installed: boolean; running: boolean;
    loginStatus: AgentQuotaAccount["loginStatus"]; plan: string | null; usageType: string; source: string;
    confidence: AgentQuotaAccount["confidence"]; reason: AgentAvailabilityReason | ""; observedAtUnixMs: number;
    ordinaryUsageAllowed: boolean | null;
    membership?:AgentQuotaAccount["membership"];
    cliDetected?: boolean; configurationDetected?: boolean|null; cacheDetected?: boolean|null;
    windows: Array<{ id: string; usedPercent: number; windowDurationMins: number | null; resetsAtUnixMs: number | null; title?:string|null }> }>;
}
const names = [["codex", "Codex"], ["claude", "Claude Code"], ["antigravity", "Antigravity"], ["doubao", "豆包"], ["gemini", "Gemini（预留）"]];
export function unknownAgentUsage(reason: AgentAvailabilityReason = "no-source"): AgentQuotaData {
  return { type: "agent-quotas", mode: "live", accounts: names.map(([id, name]) => ({ id, name, state: "unknown", observedAt: "", availabilityReason: reason, source: "none", confidence: "unknown", loginStatus: "unknown", usageWindows: [] })) };
}
export function normalizeAgentUsage(snapshot: NativeSnapshot): AgentQuotaData {
  if (!Number.isFinite(snapshot.observedAtUnixMs) || !Array.isArray(snapshot.accounts)) throw new Error("Agent 状态响应无效");
  const accounts = snapshot.accounts.filter(account => names.some(([id]) => id === account.id)).map((account): AgentQuotaAccount => {
    const usageWindows: AgentUsageWindow[] = (account.windows ?? []).flatMap(window => {
      if (!Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) return [];
      return [{ id: window.id, usedPercent: window.usedPercent, title: typeof window.title==="string"?window.title:undefined,
        windowDurationMins: Number.isFinite(window.windowDurationMins) && window.windowDurationMins! > 0 ? window.windowDurationMins! : undefined,
        resetsAt: Number.isFinite(window.resetsAtUnixMs) && window.resetsAtUnixMs! >= 0 ? new Date(window.resetsAtUnixMs!).toISOString() : undefined }];
    });
    return { id: account.id, name: account.name, state: account.state,
      observedAt: new Date(account.observedAtUnixMs ?? snapshot.observedAtUnixMs).toISOString(),
      installed: account.installed, running: account.running, loginStatus: account.loginStatus,
      plan: account.plan ?? undefined, membership:account.membership, usageType: account.usageType, source: account.source,
      confidence: usageWindows.length ? account.confidence : "unknown", usageWindows,
      ordinaryUsageAllowed: account.ordinaryUsageAllowed ?? undefined,
      cliDetected: account.cliDetected, configurationDetected: account.configurationDetected??undefined, cacheDetected: account.cacheDetected??undefined,
      remainingPercent: usageWindows.length ? 100 - usageWindows[0].usedPercent : undefined,
      resetAt: usageWindows[0]?.resetsAt, availabilityReason: account.reason || undefined };
  });
  return { type: "agent-quotas", mode: "live", accounts };
}
export function createAgentUsageProvider(): Provider<AgentQuotaData> {
  return { id: "agent-quotas", name: "AI Agent Usage", kind: "agent", refreshIntervalMs: isTauri() ? 300_000 : null,
    backgroundRefreshIntervalMs: null, timeoutMs: 70_000, retryPolicy: { maxRetries: 0 }, cacheKey: "native-agents-v4",
    load: async () => {
      if (!isTauri()) return { status: "unavailable", data: unknownAgentUsage("unsupported-runtime"), retryable: false };
      try {
        const snapshot = await invoke<NativeSnapshot>("read_agent_usage");
        const data = normalizeAgentUsage(snapshot);
        await recordCodexQuotaChange(data.accounts).catch(()=>logEvent("warn","history.codex_quota_write_failed"));
        return { status: data.accounts.some(account => account.availabilityReason === "read-failed") ? "degraded" : "normal", data,
          observedAt: new Date(snapshot.observedAtUnixMs).toISOString(), retryable: false };
      } catch { return { status: "error", data: unknownAgentUsage("read-failed"), error: "Agent 本地状态读取失败", retryable: false }; }
    } };
}
