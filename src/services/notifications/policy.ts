import type { NotificationCandidate, NotificationPreferences, NotificationRecord, NotificationSource } from "../../types";

export const defaultNotificationPreferences: NotificationPreferences = {
  enabled: true, toastEnabled: true, minimumSeverity: "warning", cooldownSeconds: 300,
  sources: { system: true, provider: true, hardware: true, api: true },
};

export function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  const candidate = value && typeof value === "object" ? value as Partial<NotificationPreferences> : {};
  const bool = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;
  return {
    enabled: bool(candidate.enabled, true),
    toastEnabled: bool(candidate.toastEnabled, true),
    minimumSeverity: candidate.minimumSeverity === "info" || candidate.minimumSeverity === "error" ? candidate.minimumSeverity : "warning",
    cooldownSeconds: typeof candidate.cooldownSeconds === "number" && Number.isFinite(candidate.cooldownSeconds)
      ? Math.max(0, Math.min(86_400, Math.round(candidate.cooldownSeconds))) : 300,
    sources: Object.fromEntries((["system", "provider", "hardware", "api"] as NotificationSource[])
      .map((source) => [source, bool(candidate.sources?.[source], true)])) as NotificationPreferences["sources"],
  };
}

export const severityRank = (severity: NotificationCandidate["severity"]) => ({ info: 0, warning: 1, error: 2 })[severity];

export interface NotificationReduction {
  records: NotificationRecord[];
  cooldowns: Record<string, number>;
  delivered: NotificationRecord[];
}

/** Browser preview adapter. Native requests use an immediate SQLite transaction. */
export function reduceNotifications(
  previous: NotificationRecord[], cooldowns: Record<string, number>, candidates: NotificationCandidate[], completeScopes: string[],
  preferences: NotificationPreferences, nowMs: number,
): NotificationReduction {
  const now = new Date(nowMs).toISOString();
  const records = new Map(previous.map((record) => [record.id, { ...record }]));
  const nextCooldowns = { ...cooldowns };
  const delivered: NotificationRecord[] = [];
  for (const record of records.values()) {
    if (record.kind === "condition" && record.active && completeScopes.includes(record.scope) && !candidates.some((item) => item.id === record.id)) {
      record.active = false;
      record.pendingDelivery = false;
      record.resolvedAt = now;
    }
  }
  for (const candidate of candidates) {
    const old = records.get(candidate.id);
    if (old && (old.scope !== candidate.scope || old.source !== candidate.source || old.kind !== candidate.kind || old.rule !== candidate.rule)) {
      throw new Error("通知标识发生冲突");
    }
    const reactivated = old?.active === false && candidate.kind === "condition";
    const escalated = old && severityRank(candidate.severity) > severityRank(old.severity);
    const record: NotificationRecord = {
      ...(old ?? { schemaVersion: 1, firstSeenAt: now, lastNotifiedAt: null, acknowledgedAt: null, occurrences: 1, pendingDelivery: false }),
      ...candidate, lastSeenAt: now, active: true, resolvedAt: null,
    };
    if (reactivated) record.occurrences += 1;
    if (reactivated || escalated) record.acknowledgedAt = null;
    if (candidate.kind === "condition" && (!old || reactivated || escalated)) record.pendingDelivery = true;
    const mayNotify = !old || (candidate.kind === "condition" && record.pendingDelivery && record.acknowledgedAt === null);
    const group = `${candidate.scope}:${candidate.rule}`;
    const cooledDown = nextCooldowns[group] === undefined || nowMs - nextCooldowns[group] >= preferences.cooldownSeconds * 1_000;
    if (mayNotify && preferences.enabled && preferences.sources[candidate.source] && severityRank(candidate.severity) >= severityRank(preferences.minimumSeverity) && cooledDown) {
      record.lastNotifiedAt = now;
      record.pendingDelivery = false;
      nextCooldowns[group] = nowMs;
      delivered.push({ ...record });
    }
    records.set(record.id, record);
  }
  const cutoff = nowMs - 90 * 24 * 60 * 60_000;
  for (const [key, at] of Object.entries(nextCooldowns)) if (at < cutoff) delete nextCooldowns[key];
  return { records: [...records.values()].filter((record) => Date.parse(record.firstSeenAt) >= cutoff), cooldowns: nextCooldowns, delivered };
}
