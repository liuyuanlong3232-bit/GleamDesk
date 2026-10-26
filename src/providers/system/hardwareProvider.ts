import { invoke, isTauri } from "@tauri-apps/api/core";
import type { HardwareSnapshot } from "../../domain/hardware/contracts";
import type { Provider, ProviderLoadResult } from "../contracts";
import type { HardwareStatusData } from "../data";
import { createHistoryRecord, writeHistoryRecord } from "../../services/historyStore";
import { liveProvenance } from "../../domain/analysis/contracts";

export function hardwareProviderResult(snapshot: HardwareSnapshot): ProviderLoadResult<HardwareStatusData> {
  const primary = [snapshot.cpu.usageStatus, snapshot.memory.status, snapshot.disks.status, snapshot.network.status];
  const readable = primary.filter((status) => status === "available" || status === "sampling").length;
  const gpuUnavailable = [snapshot.gpu.usageStatus ?? snapshot.gpu.status,
    snapshot.gpu.memoryStatus ?? snapshot.gpu.status, snapshot.gpu.temperatureStatus ?? snapshot.gpu.status]
    .some((status) => status === "unavailable");
  const diskIoUnavailable = snapshot.disks.ioStatus === "unavailable";
  const status = readable === primary.length && !gpuUnavailable && !diskIoUnavailable ? "normal" : readable > 0 ? "degraded" : "unavailable";
  const unavailable = primary.filter((item) => item === "unavailable").length;
  return {
    status,
    observedAt: new Date(snapshot.sampledAtUnixMs).toISOString(),
    data: { type: "hardware-status", snapshot },
    error: [unavailable ? `${unavailable} 类本机硬件指标暂不可用` : "", gpuUnavailable ? "GPU 部分数据暂不可用" : "", diskIoUnavailable ? "磁盘读写计数器暂不可用" : ""].filter(Boolean).join("；") || undefined,
    retryable: unavailable > 0 || gpuUnavailable,
  };
}

async function persistSample(snapshot: HardwareSnapshot) {
  const bucket = Math.floor(snapshot.sampledAtUnixMs / 30_000) * 30_000;
  const record = createHistoryRecord("hardware_history", { ...snapshot, provenance: liveProvenance("hardware-status") }, `hardware-sample-${bucket}`);
  record.createdAt = new Date(bucket).toISOString();
  await writeHistoryRecord(record);
}

export function createHardwareProvider(): Provider<HardwareStatusData> {
  const supported = isTauri();
  return {
    id: "hardware-status",
    name: "本机硬件",
    kind: "system",
    refreshIntervalMs: supported ? 2_000 : null,
    backgroundRefreshIntervalMs: null,
    timeoutMs: 5_000,
    retryPolicy: { maxRetries: 1, initialDelayMs: 300, maxDelayMs: 1_000 },
    load: async (): Promise<ProviderLoadResult<HardwareStatusData>> => {
      if (!supported) {
        return { status: "unavailable", data: null, error: "浏览器预览不能读取本机硬件数据", retryable: false };
      }
      try {
        const snapshot = await invoke<HardwareSnapshot>("read_hardware_snapshot", { minimumIntervalMs: 1_000 });
        await persistSample(snapshot);
        return hardwareProviderResult(snapshot);
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error || "读取本机硬件指标失败"))
          .replace(/[\r\n\t]+/g, " ").slice(0, 200);
        return { status: "error", data: null, error: message, retryable: true };
      }
    },
  };
}
