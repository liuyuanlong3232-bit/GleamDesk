const valid = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const processKey = (process) => `${process.id}:${process.name.toLowerCase().replace(/\.exe$/, "")}`;

export function deriveRuntimeCpu(records, verifiedStarts = new Map()) {
  const identities = (record) => {
    const processes = new Map();
    for (const process of record.processes) {
      const start = process.startedAt ?? verifiedStarts.get(processKey(process));
      if (typeof start !== "string" || !Number.isFinite(Date.parse(start)) || !valid(process.cpuSeconds)) return null;
      const key = `${processKey(process)}:${start}`;
      if (processes.has(key)) return null;
      processes.set(key, process.cpuSeconds);
    }
    return processes;
  };
  return records.map((record, index) => {
    if (index === 0) return { value: null, reason: "initial_baseline" };
    const previous = records[index - 1];
    const seconds = record.elapsedSeconds - previous.elapsedSeconds;
    if (!(seconds > 0) || !Number.isInteger(record.logicalProcessors) || record.logicalProcessors <= 0
      || record.logicalProcessors !== previous.logicalProcessors) return { value: null, reason: "clock_or_processor_change" };
    const currentCpu = identities(record), previousCpu = identities(previous);
    if (!currentCpu || !previousCpu) return { value: null, reason: "counter_or_lifetime_unavailable" };
    if (currentCpu.size !== previousCpu.size || [...currentCpu.keys()].some((key) => !previousCpu.has(key)))
      return { value: null, reason: "process_group_change" };
    let delta = 0;
    for (const [key, cpu] of currentCpu) {
      if (cpu < previousCpu.get(key)) return { value: null, reason: "counter_rollback" };
      delta += cpu - previousCpu.get(key);
    }
    return { value: 100 * delta / seconds / record.logicalProcessors, reason: null };
  });
}
