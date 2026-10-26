import { invoke, isTauri } from "@tauri-apps/api/core";
import type { HistoryRecord, NotificationCandidate, NotificationPreferences, NotificationRecord, NotificationState } from "../../types";
import { readBrowserHistoryRecords, transactBrowserHistory } from "../historyRepository";
import { reduceNotifications } from "./policy";

export const notificationsChangedEvent = "codex-desktop.notifications-changed";
export const notificationToastEvent = "codex-desktop.notification-toast";
const cooldownStateId = "notification-cooldowns";

export function isNotificationRecord(value: unknown): value is NotificationRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<NotificationRecord>;
  return record.schemaVersion === 1 && typeof record.id === "string" && typeof record.title === "string" && typeof record.detail === "string"
    && typeof record.firstSeenAt === "string" && typeof record.lastSeenAt === "string" && Number.isFinite(Date.parse(record.firstSeenAt))
    && (record.kind === "event" || record.kind === "condition") && (record.severity === "info" || record.severity === "warning" || record.severity === "error")
    && (record.source === "system" || record.source === "provider" || record.source === "api" || record.source === "hardware")
    && typeof record.scope === "string" && typeof record.rule === "string" && typeof record.active === "boolean";
}

function notificationRecords(history: HistoryRecord[]): NotificationRecord[] {
  return history.flatMap((record) => record.kind === "notifications_history" && isNotificationRecord(record.payload) ? [record.payload] : []);
}

function stateFromHistory(history: HistoryRecord[], limit = 200): NotificationState {
  const records = notificationRecords(history);
  return {
    records: records.sort((left, right) => right.firstSeenAt.localeCompare(left.firstSeenAt) || right.id.localeCompare(left.id)).slice(0, Math.max(1, Math.min(1_000, limit))),
    totalCount: records.length,
    unacknowledgedCount: records.filter((record) => !record.acknowledgedAt).length,
  };
}

function changed(delivered: NotificationRecord[] = [], toast = false) {
  window.dispatchEvent(new Event(notificationsChangedEvent));
  if (toast && delivered.length && document.visibilityState === "visible") {
    const red=delivered.filter(record=>record.source==="provider"&&record.kind==="event"&&record.scope==="news-vps"&&record.rule.startsWith("news-event:")&&record.severity==="error");
    if(red.length) window.alert(`重大新闻提醒 / RED\n\n${red.slice(0,4).map(record=>`${record.title}\n${record.detail}`).join("\n\n")}\n\n完整记录保存在通知中心。`);
    const toast=delivered.filter(record=>!red.includes(record));
    if(toast.length)window.dispatchEvent(new CustomEvent(notificationToastEvent, { detail: toast }));
  }
}

export async function applyNotifications(candidates: NotificationCandidate[], completeScopes: string[], preferences: NotificationPreferences): Promise<NotificationState> {
  if (isTauri()) return invoke<NotificationState>("notification_apply", { candidates, completeScopes, preferences });
  const update = await transactBrowserHistory((history) => {
    const current = notificationRecords(history);
    const metadata = history.find((item) => item.kind === "widget_state" && item.id === cooldownStateId)?.payload;
    const cooldowns = metadata && typeof metadata === "object" ? metadata as Record<string, number> : {};
    const reduction = reduceNotifications(current, cooldowns, candidates, completeScopes, preferences, Date.now());
    const kept = history.filter((item) => !(item.kind === "notifications_history" && isNotificationRecord(item.payload)) && !(item.kind === "widget_state" && item.id === cooldownStateId));
    const records: HistoryRecord[] = [...kept, ...reduction.records.map((record) => ({ id: record.id, kind: "notifications_history" as const, createdAt: record.firstSeenAt, payload: record })),
      { id: cooldownStateId, kind: "widget_state", createdAt: new Date().toISOString(), payload: reduction.cooldowns }];
    return { records, result: { state: stateFromHistory(records), delivered: reduction.delivered } };
  });
  changed(update.delivered, preferences.toastEnabled);
  return update.state;
}

export async function readNotificationState(limit = 200): Promise<NotificationState> {
  return isTauri() ? invoke<NotificationState>("notification_state", { limit }) : stateFromHistory(readBrowserHistoryRecords(), limit);
}

export async function acknowledgeNotifications(ids: string[], all = false): Promise<NotificationState> {
  if (isTauri()) return invoke<NotificationState>("notification_acknowledge", { ids, all });
  const state = await transactBrowserHistory((history) => {
    const now = new Date().toISOString();
    const records = history.map((item) => item.kind === "notifications_history" && isNotificationRecord(item.payload) && (all || ids.includes(item.id))
      ? { ...item, payload: { ...item.payload, acknowledgedAt: now, pendingDelivery: false } } : item);
    return { records, result: stateFromHistory(records) };
  });
  changed();
  return state;
}
