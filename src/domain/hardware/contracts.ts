export type HardwareMetricStatus = "available" | "sampling" | "unavailable" | "unsupported";

export interface HardwareSnapshot {
  sampledAtUnixMs: number;
  cpu: {
    usagePercent: number | null;
    usageStatus: HardwareMetricStatus;
    temperatureC: number | null;
    temperatureStatus: HardwareMetricStatus;
  };
  memory: {
    usedBytes: number | null;
    totalBytes: number | null;
    usagePercent: number | null;
    status: HardwareMetricStatus;
  };
  disks: {
    volumes: Array<{ name: string; usedBytes: number; totalBytes: number; usagePercent: number; readBytesPerSecond?: number | null; writeBytesPerSecond?: number | null; ioStatus?: HardwareMetricStatus }>;
    readBytesPerSecond?: number | null;
    writeBytesPerSecond?: number | null;
    ioStatus?: HardwareMetricStatus;
    status: HardwareMetricStatus;
  };
  network: {
    uploadBytesPerSecond: number | null;
    downloadBytesPerSecond: number | null;
    status: HardwareMetricStatus;
  };
  gpu: {
    name: string | null;
    usagePercent: number | null;
    memoryUsedBytes: number | null;
    memoryTotalBytes: number | null;
    temperatureC: number | null;
    status: HardwareMetricStatus;
    usageStatus?: HardwareMetricStatus;
    memoryStatus?: HardwareMetricStatus;
    temperatureStatus?: HardwareMetricStatus;
    source?: string | null;
    detail?: string | null;
  };
}
