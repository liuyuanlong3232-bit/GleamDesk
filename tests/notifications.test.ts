import assert from "node:assert/strict";
import { test } from "node:test";
import type { NotificationCandidate, NotificationRecord } from "../src/types";
import { defaultNotificationPreferences as preferences, normalizeNotificationPreferences, reduceNotifications } from "../src/services/notifications/policy";
import { notificationBatches, notificationsFromSnapshots } from "../src/services/notifications/providerNotifications";
import { applyNotifications, readNotificationState, acknowledgeNotifications } from "../src/services/notifications/repository";
import { notificationToastEvent } from "../src/services/notifications/repository";
import { createNotificationTestCandidate, isLocalTestNotification, notificationTestResult } from "../src/services/notifications/localTest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationCenter } from "../src/components/NotificationCenter";
import { defaultSettings, loadSettings, saveSettings } from "../src/providers/settingsStore";
import type { Provider, ProviderSnapshot } from "../src/providers/contracts";
import type { ProviderData } from "../src/providers/data";

const start = Date.parse("2026-10-05T00:00:00Z");
const candidate = (id = "event:1", kind: NotificationCandidate["kind"] = "event"): NotificationCandidate => ({
  id, kind, source: "system", scope: "windows-health", rule: "event-41", severity: "warning", title: "测试事件", detail: "测试数据", evidenceAt: "2026-10-05T00:00:00Z",
});

test("large event scans preserve all evidence and defer scope resolution to the final batch", () => {
  const events = Array.from({ length: 120 }, (_, index) => candidate(`event:${index}`));
  const condition = candidate("condition:1", "condition");
  const batches = notificationBatches([...events, condition], [condition.scope]);
  assert.deepEqual(batches.map((batch) => batch.candidates.length), [100, 20, 1]);
  assert.deepEqual(batches.slice(0, 2).map((batch) => batch.completeScopes), [[], []]);
  assert.deepEqual(batches.at(-1)?.completeScopes, [condition.scope]);
  assert.equal(new Set(batches.flatMap((batch) => batch.candidates.map((item) => item.id))).size, 121);
});

test("repeated events and continuous conditions retain acknowledgement and occurrence count", () => {
  const condition = candidate("condition:1", "condition");
  const initial = reduceNotifications([], {}, [candidate(), condition], [], { ...preferences, cooldownSeconds: 0 }, start);
  const acknowledged = initial.records.map((record) => ({ ...record, acknowledgedAt: new Date(start).toISOString() }));
  const repeat = reduceNotifications(acknowledged, initial.cooldowns, [candidate(), condition], [], preferences, start + 500_000);
  assert.equal(repeat.delivered.length, 0);
  assert.ok(repeat.records.every((record) => record.occurrences === 1 && record.acknowledgedAt));
});

test("resolved conditions rearm after recovery and cooldown delays delivery without losing history", () => {
  const condition = candidate("condition:1", "condition");
  const first = reduceNotifications([], {}, [condition], [condition.scope], preferences, start);
  const resolved = reduceNotifications(first.records, first.cooldowns, [], [condition.scope], preferences, start + 1_000);
  assert.equal(resolved.records[0].active, false);
  const back = reduceNotifications(resolved.records, resolved.cooldowns, [condition], [condition.scope], preferences, start + 2_000);
  assert.equal(back.records[0].occurrences, 2);
  assert.equal(back.delivered.length, 0);
  assert.equal(back.records[0].pendingDelivery, true);
  const later = reduceNotifications(back.records, back.cooldowns, [condition], [condition.scope], preferences, start + 301_000);
  assert.equal(later.delivered.length, 1);
  assert.equal(later.records[0].occurrences, 2);
});

test("muted sources persist history and only completed scopes resolve conditions", () => {
  const condition = candidate("condition:1", "condition");
  const muted = { ...preferences, sources: { ...preferences.sources, system: false } };
  const first = reduceNotifications([], {}, [condition], [], muted, start);
  assert.equal(first.records.length, 1);
  assert.equal(first.delivered.length, 0);
  const partial = reduceNotifications(first.records, first.cooldowns, [], ["api-deepseek"], preferences, start + 1_000);
  assert.equal(partial.records[0].active, true);
  const enabled = reduceNotifications(partial.records, partial.cooldowns, [condition], [condition.scope], preferences, start + 2_000);
  assert.equal(enabled.delivered.length, 1);
});

test("an event suppressed by cooldown is recorded and never replayed as a new event", () => {
  const first = reduceNotifications([], {}, [candidate("a")], [], preferences, start);
  const suppressed = reduceNotifications(first.records, first.cooldowns, [candidate("b")], [], preferences, start + 1_000);
  assert.equal(suppressed.records.length, 2);
  assert.equal(suppressed.delivered.length, 0);
  const repeat = reduceNotifications(suppressed.records, suppressed.cooldowns, [candidate("b")], [], preferences, start + 500_000);
  assert.equal(repeat.delivered.length, 0);
});

test("severity escalation rearms a condition and identity collisions fail", () => {
  const condition = candidate("condition:1", "condition");
  const first = reduceNotifications([], {}, [condition], [], preferences, start);
  first.records[0].acknowledgedAt = new Date(start).toISOString();
  const escalated = reduceNotifications(first.records, first.cooldowns, [{ ...condition, severity: "error" }], [], preferences, start + 301_000);
  assert.equal(escalated.records[0].acknowledgedAt, null);
  assert.equal(escalated.delivered.length, 1);
  assert.throws(() => reduceNotifications(first.records, {}, [{ ...condition, scope: "other" }], [], preferences, start), /冲突/);
  assert.equal(normalizeNotificationPreferences({ cooldownSeconds: -3, sources: { system: false } }).cooldownSeconds, 0);
});

test("unconfigured sources and demos do not generate alerts; failed authentication does", () => {
  const provider: Provider<ProviderData> = { id: "api-deepseek", name: "DeepSeek", kind: "api", refreshIntervalMs: null, load: async () => ({ status: "unavailable", data: null }) };
  const snapshot: ProviderSnapshot<ProviderData> = { providerId: provider.id, status: "unavailable", data: null, retryable: false, error: "尚未配置", lastUpdated: null, lastSuccessAt: null };
  assert.equal(notificationsFromSnapshots([provider], [snapshot]).candidates.length, 0);
  assert.equal(notificationsFromSnapshots([{ ...provider, name: "API（演示）" }], [{ ...snapshot, status: "error" }]).candidates.length, 0);
  assert.equal(notificationsFromSnapshots([provider], [{ ...snapshot, status: "error", error: "无权读取" }]).candidates.length, 1);
});

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("manual notification checks use a reserved local identity and the selected reminder level", () => {
  const item = createNotificationTestCandidate({ ...preferences, minimumSeverity: "info" }, "manual-first", start);
  assert.equal(item.id, "notification-test:manual-first");
  assert.equal(item.scope, "notification-self-test");
  assert.equal(item.rule, "manual-test");
  assert.equal(item.source, "provider");
  assert.equal(item.kind, "event");
  assert.equal(item.severity, "info");
  assert.equal(item.evidenceAt, new Date(start).toISOString());
  assert.equal(isLocalTestNotification(item), true);
  assert.equal(isLocalTestNotification({ ...item, scope: "windows-health" }), false);
  assert.equal(isLocalTestNotification({ ...item, kind: "condition" }), false);
  assert.throws(() => createNotificationTestCandidate(preferences, "../foreign", start), /无效/);
  assert.throws(() => createNotificationTestCandidate(preferences, "x", NaN), /无效/);
});

test("manual checks keep live conditions active and have an independent cooldown group", () => {
  const live = candidate("condition:live", "condition");
  const initial = reduceNotifications([], {}, [live], [live.scope], preferences, start);
  const item = createNotificationTestCandidate(preferences, "manual-first", start + 1_000);
  const update = reduceNotifications(initial.records, initial.cooldowns, [item], [], preferences, start + 1_000);
  assert.equal(update.delivered.length, 1);
  assert.equal(update.records.find(record => record.id === live.id)?.active, true);
  assert.equal(update.records.find(record => record.id === live.id)?.resolvedAt, null);
  const duplicate = reduceNotifications(update.records, update.cooldowns, [item], [], preferences, start + 2_000);
  assert.equal(duplicate.records.length, 2);
  assert.equal(duplicate.delivered.length, 0);
  const second = createNotificationTestCandidate(preferences, "manual-second", start + 3_000);
  const cooled = reduceNotifications(duplicate.records, duplicate.cooldowns, [second], [], preferences, start + 3_000);
  assert.equal(cooled.records.length, 3);
  assert.equal(cooled.delivered.length, 0);
  assert.match(notificationTestResult({ records: cooled.records, totalCount: 3, unacknowledgedCount: 3 }, second.id, preferences), /冷却/);
});

test("browser manual checks persist, deduplicate, respect mute and retain acknowledgements", async () => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
  Object.defineProperty(globalThis, "window", { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, "document", { value: { visibilityState: "visible" }, configurable: true });
  const toasts: unknown[] = [];
  window.addEventListener(notificationToastEvent, event => toasts.push((event as CustomEvent).detail));
  const first = createNotificationTestCandidate(preferences, "browser-first");
  const firstState = await applyNotifications([first], [], preferences);
  assert.match(notificationTestResult(firstState, first.id, preferences), /弹出提醒/);
  await applyNotifications([first], [], preferences);
  assert.equal((await readNotificationState()).totalCount, 1);
  const second = createNotificationTestCandidate(preferences, "browser-second");
  const secondState = await applyNotifications([second], [], preferences);
  assert.match(notificationTestResult(secondState, second.id, preferences), /冷却/);
  assert.equal(toasts.length, 1);
  await acknowledgeNotifications([first.id]);
  await applyNotifications([first], [], preferences);
  assert.ok((await readNotificationState()).records.find(record => record.id === first.id)?.acknowledgedAt);
  const mutedPreferences = { ...preferences, enabled: false };
  const muted = createNotificationTestCandidate(mutedPreferences, "browser-muted");
  const mutedState = await applyNotifications([muted], [], mutedPreferences);
  assert.match(notificationTestResult(mutedState, muted.id, mutedPreferences), /提醒已关闭/);
  assert.equal(mutedState.totalCount, 3);
  assert.equal(toasts.length, 1);
  const saved = JSON.parse(localStorage.getItem("codex-desktop.history.v1")!) as Array<{ kind: string }>;
  assert.equal(saved.filter(record => ["system_events", "hardware_history", "usage_history", "vps_history", "application_history"].includes(record.kind)).length, 0);
  assert.equal((await acknowledgeNotifications([], true)).unacknowledgedCount, 0);
});

test("notification center labels local checks clearly and sends only on a manual action", () => {
  const item = createNotificationTestCandidate(preferences, "ui-first", start);
  const reduction = reduceNotifications([], {}, [item], [], preferences, start);
  let calls = 0;
  const model = {
    records: reduction.records, totalCount: 1, unacknowledgedCount: 1, error: "", loading: false, toast: [],
    refresh: async () => {}, acknowledge: async () => {}, testing: false, testMessage: "本次测试已记录",
    testNotification: async () => { calls += 1; }, dismissToast: () => {}, loadMore: () => {}, limit: 200,
  };
  const html = renderToStaticMarkup(createElement(NotificationCenter, { model, opened: true, onOpen: () => {}, onClose: () => {}, preferences, onPreferencesChange: () => {} }));
  assert.match(html, /<summary>本地测试/);
  assert.match(html, /<span>测试<\/span>/);
  assert.match(html, />测试提醒<\/button>/);
  assert.match(html, /role="status"/);
  assert.equal(calls, 0);
  const busy = renderToStaticMarkup(createElement(NotificationCenter, { model: { ...model, testing: true }, opened: true, onOpen: () => {}, onClose: () => {}, preferences, onPreferencesChange: () => {} }));
  assert.match(busy, /<button disabled="">生成中…<\/button>/);
});

test("custom reminder preferences survive settings save and reload with unrelated settings preserved", () => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
  const custom = { ...preferences, minimumSeverity: "error" as const, cooldownSeconds: 330, toastEnabled: false,
    sources: { ...preferences.sources, provider: false, api: false } };
  saveSettings({ ...defaultSettings, theme: "burgundy", opacity: 91, notificationPreferences: custom });
  const loaded = loadSettings();
  assert.deepEqual(loaded.notificationPreferences, custom);
  assert.equal(loaded.theme, "burgundy");
  assert.equal(loaded.opacity, 91);
  assert.equal(loaded.remoteAnalysis.provider, null);
  assert.equal(loaded.apiConnections.deepseekEnabled, false);
  const malformed = JSON.parse(localStorage.getItem("codex-desktop.settings.v1")!);
  malformed.notificationPreferences.cooldownSeconds = 330.4;
  malformed.notificationPreferences.minimumSeverity = "invalid";
  localStorage.setItem("codex-desktop.settings.v1", JSON.stringify(malformed));
  assert.equal(loadSettings().notificationPreferences.cooldownSeconds, 330);
  assert.equal(loadSettings().notificationPreferences.minimumSeverity, "warning");
});

test("browser notification transactions preserve more than the 1000-row UI query limit", async () => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
  Object.defineProperty(globalThis, "window", { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, "document", { value: { visibilityState: "visible" }, configurable: true });
  const now = new Date().toISOString();
  const records = Array.from({ length: 1_101 }, (_, index) => {
    const payload: NotificationRecord = { ...candidate(`event:${index}`), schemaVersion: 1, firstSeenAt: now, lastSeenAt: now,
      lastNotifiedAt: null, acknowledgedAt: null, resolvedAt: null, occurrences: 1, active: true, pendingDelivery: false };
    return { id: payload.id, kind: "notifications_history", createdAt: now, payload };
  });
  localStorage.setItem("codex-desktop.history.v1", JSON.stringify(records));
  await applyNotifications([], [], preferences);
  const state = await readNotificationState();
  assert.equal(state.records.length, 200);
  assert.equal(state.totalCount, 1_101);
  await acknowledgeNotifications([], true);
  assert.equal((await readNotificationState()).unacknowledgedCount, 0);
});
