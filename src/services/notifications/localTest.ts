import type { NotificationCandidate, NotificationPreferences, NotificationState } from "../../types";

const scope = "notification-self-test";
const rule = "manual-test";

export function createNotificationTestCandidate(preferences: NotificationPreferences, nonce: string = crypto.randomUUID(), nowMs = Date.now()): NotificationCandidate {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(nonce) || !Number.isFinite(nowMs)) throw new Error("通知测试参数无效");
  return {
    id: `notification-test:${nonce}`, source: "provider", scope, rule, kind: "event",
    severity: preferences.minimumSeverity,
    title: "本地测试通知",
    detail: "这条通知由你手动生成，用于检查提醒设置、弹出提醒、确认和历史读取。",
    evidenceAt: new Date(nowMs).toISOString(),
  };
}

export function isLocalTestNotification(candidate: Pick<NotificationCandidate, "source" | "scope" | "rule" | "kind">): boolean {
  return candidate.source === "provider" && candidate.scope === scope && candidate.rule === rule && candidate.kind === "event";
}

export function notificationTestResult(state: NotificationState, id: string, preferences: NotificationPreferences): string {
  const record = state.records.find((item) => item.id === id);
  if (!record) return "测试请求已处理，请刷新全部历史查看。";
  if (!preferences.enabled) return "本次测试已记录；提醒已关闭。";
  if (!preferences.sources.provider) return "本次测试已记录；连接与数据源提醒已关闭。";
  if (!record.lastNotifiedAt) return "本次测试已记录；同规则提醒处于冷却时间。";
  if (!preferences.toastEnabled) return "本次测试已记录；窗口内弹出提醒已关闭。";
  return "本次测试已记录；请检查弹出提醒，可在通知中心确认。";
}
