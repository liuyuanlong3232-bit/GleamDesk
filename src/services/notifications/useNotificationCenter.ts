import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { NotificationPreferences, NotificationRecord, NotificationState } from "../../types";
import { acknowledgeNotifications, applyNotifications, isNotificationRecord, notificationsChangedEvent, notificationToastEvent, readNotificationState } from "./repository";
import { createNotificationTestCandidate, notificationTestResult } from "./localTest";

const emptyState: NotificationState = { records: [], totalCount: 0, unacknowledgedCount: 0 };

export function useNotificationCenter() {
  const [state, setState] = useState<NotificationState>(emptyState);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(200);
  const [toast, setToast] = useState<NotificationRecord[]>([]);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState("");
  const testInFlight = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const update = await readNotificationState(limit);
      if (mounted.current && request === generation.current) { setState(update); setError(""); }
    } catch {
      if (mounted.current && request === generation.current) setError("通知历史暂时无法读取");
    }
  }, [limit]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onChanged = () => { void refresh(); };
    const onToast = (items: unknown) => {
      if (document.visibilityState === "visible" && Array.isArray(items)) setToast(items.filter(isNotificationRecord));
    };
    const onBrowserToast = (event: Event) => onToast((event as CustomEvent).detail);
    const onStorage = (event: StorageEvent) => { if (event.key === "codex-desktop.history.v1") onChanged(); };
    window.addEventListener(notificationsChangedEvent, onChanged);
    window.addEventListener(notificationToastEvent, onBrowserToast);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onChanged);
    let active = true;
    const unlisteners: Array<() => void> = [];
    if (isTauri()) {
      for (const subscription of [
        listen("notifications-changed", onChanged),
        getCurrentWindow().listen<NotificationRecord[]>("notification-toast", (event) => onToast(event.payload)),
      ]) {
        void subscription.then((stop) => { if (active) unlisteners.push(stop); else stop(); })
          .catch(() => { if (active) setError("通知状态同步暂时不可用"); });
      }
    }
    return () => {
      active = false;
      mounted.current = false;
      generation.current += 1;
      unlisteners.forEach((stop) => stop());
      window.removeEventListener(notificationsChangedEvent, onChanged);
      window.removeEventListener(notificationToastEvent, onBrowserToast);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onChanged);
    };
  }, [refresh]);

  useEffect(() => {
    if (!toast.length) return;
    const timer = window.setTimeout(() => setToast([]), 12_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const acknowledge = async (ids: string[], all = false) => {
    setLoading(true);
    try {
      await acknowledgeNotifications(ids, all);
      if (mounted.current) setToast((items) => items.filter((item) => !all && !ids.includes(item.id)));
      await refresh();
    } catch { if (mounted.current) setError("确认通知失败，请稍后重试"); }
    finally { if (mounted.current) setLoading(false); }
  };

  const testNotification = async (preferences: NotificationPreferences) => {
    if (testInFlight.current) return;
    testInFlight.current = true;
    setTesting(true);
    setTestMessage("");
    try {
      const candidate = createNotificationTestCandidate(preferences);
      // Empty completed scopes keep the manual check separate from live conditions.
      const update = await applyNotifications([candidate], [], preferences);
      if (mounted.current) setTestMessage(notificationTestResult(update, candidate.id, preferences));
      await refresh();
    } catch {
      if (mounted.current) setTestMessage("测试通知无法保存，请稍后重试。");
    } finally {
      testInFlight.current = false;
      if (mounted.current) setTesting(false);
    }
  };

  return { ...state, error, loading, toast, refresh, acknowledge, testing, testMessage, testNotification, dismissToast: () => setToast([]),
    loadMore: () => setLimit((current) => Math.min(1_000, current + 200)), limit };
}
