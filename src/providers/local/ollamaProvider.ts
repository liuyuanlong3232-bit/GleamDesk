import { invoke, isTauri } from "@tauri-apps/api/core";
import type { LocalAiSnapshot } from "../../domain/local/contracts";
import type { Provider } from "../contracts";
import type { LocalAiData } from "../data";

export function unavailableLocalAI(reason: string): LocalAiSnapshot {
  return { serviceStatus: "unknown", source: "http://127.0.0.1:11434", models: [], runningModels: [], modelCount: null, truncated: false, observedAtUnixMs: Date.now(), error: reason };
}
export function createOllamaProvider(): Provider<LocalAiData> {
  return { id: "ollama-local", name: "Ollama Local AI", kind: "system", refreshIntervalMs: isTauri() ? 30_000 : null, backgroundRefreshIntervalMs: null,
    timeoutMs: 12_000, retryPolicy: { maxRetries: 0 }, cacheKey: "loopback-ollama-v1",
    load: async () => {
      if (!isTauri()) return { status: "unavailable", data: { type: "local-ai", snapshot: unavailableLocalAI("浏览器预览不读取本机 Ollama") }, retryable: false };
      try {
        const snapshot = await invoke<LocalAiSnapshot>("read_ollama_status");
        return { status: snapshot.serviceStatus === "online" ? "normal" : "degraded", data: { type: "local-ai", snapshot },
          observedAt: new Date(snapshot.observedAtUnixMs).toISOString(), retryable: false };
      } catch { return { status: "error", data: { type: "local-ai", snapshot: unavailableLocalAI("本机 Ollama 检测失败") }, error: "Ollama 本地检测失败", retryable: false }; }
    } };
}
