import {CloseIcon} from "./CloseIcon";
import { useEffect, useRef, useState } from "react";
import type { NotificationPreferences, NotificationSource } from "../types";
import type { useNotificationCenter } from "../services/notifications/useNotificationCenter";
import { isLocalTestNotification } from "../services/notifications/localTest";

type Model = ReturnType<typeof useNotificationCenter>;
const sourceNames: Record<NotificationSource, string> = { system: "系统事件", provider: "连接与数据源", hardware: "本机硬件", api: "API 数据" };
const severityNames = { info: "提示", warning: "警告", error: "错误" };

export function NotificationCenter({ model, opened, onOpen, onClose, preferences, onPreferencesChange, showLauncher=true }: {
  showLauncher?:boolean; model: Model; opened: boolean; onOpen: () => void; onClose: () => void;
  preferences: NotificationPreferences; onPreferencesChange: (preferences: NotificationPreferences) => void;
}) {
  const [unreadOnly, setUnreadOnly] = useState(true);
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const node=dialog.current;
    if(opened&&node&&!node.open)node.showModal();
    return()=>{if(node?.open)node.close();};
  },[opened]);
  const records = model.records.filter((record) => !unreadOnly || !record.acknowledgedAt);
  const updatePreferences = (patch: Partial<NotificationPreferences>) => onPreferencesChange({ ...preferences, ...patch });
  return <>
    {showLauncher&&<button className="notification-launcher glass" onClick={onOpen} aria-label={`通知中心，${model.unacknowledgedCount} 条未确认`} aria-expanded={opened}>
      <span>♧</span> 通知{model.unacknowledgedCount > 0 && <b>{model.unacknowledgedCount > 99 ? "99+" : model.unacknowledgedCount}</b>}
    </button>}
    {opened && <dialog ref={dialog} className="notification-center glass" role="dialog" aria-modal="true" aria-label="通知中心" onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target!==event.currentTarget)return;const bounds=event.currentTarget.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)onClose();}}>
      <div className="notification-center-heading"><div><strong>通知中心</strong><small>{model.unacknowledgedCount} 条未确认 · {model.totalCount} 条历史</small></div><button className="ui-icon-button" autoFocus onClick={onClose} aria-label="关闭通知中心"><CloseIcon/></button></div>
      <div className="notification-center-toolbar"><button className={unreadOnly ? "selected" : ""} onClick={() => setUnreadOnly(true)}>未确认</button><button className={!unreadOnly ? "selected" : ""} onClick={() => setUnreadOnly(false)}>全部历史</button><button disabled={model.loading || model.unacknowledgedCount === 0} onClick={() => void model.acknowledge([], true)}>全部确认</button></div>
      {model.error && <p className="notification-error" role="alert">{model.error}<button onClick={() => void model.refresh()}>重试</button></p>}
      <div className="notification-center-list">
        {records.length === 0 && <p className="notification-empty">{unreadOnly ? "当前没有待确认通知" : "尚无通知历史"}</p>}
        {records.map((record) => <article key={record.id} className={`notification-entry severity-${record.severity}${record.acknowledgedAt ? " acknowledged" : ""}`}>
          <div className="notification-entry-heading"><span>{isLocalTestNotification(record) ? "测试" : severityNames[record.severity]}</span><strong>{record.title}</strong>{record.kind === "condition" && <small>{record.active ? "持续中" : "已恢复"}</small>}</div>
          <details><summary>{isLocalTestNotification(record) ? "本地测试" : record.scope==="news-vps" ? "新闻中心" : sourceNames[record.source]} · {new Date(record.evidenceAt || record.firstSeenAt).toLocaleString("zh-CN")}</summary><p>{record.detail}</p><small>首次记录 {new Date(record.firstSeenAt).toLocaleString("zh-CN")} · 出现 {record.occurrences} 次</small>{record.acknowledgedAt && <small>确认于 {new Date(record.acknowledgedAt).toLocaleString("zh-CN")}</small>}</details>
          {!record.acknowledgedAt && <button disabled={model.loading} onClick={() => void model.acknowledge([record.id])}>确认</button>}
        </article>)}
      </div>
      {model.totalCount > model.records.length && <button className="notification-load-more" disabled={model.limit >= 1_000} onClick={model.loadMore}>{model.limit >= 1_000 ? "已显示最近 1,000 条" : "加载更多历史"}</button>}
      <details className="notification-preferences"><summary>通知设置</summary>
        <label>启用提醒<input type="checkbox" checked={preferences.enabled} onChange={(event) => updatePreferences({ enabled: event.target.checked })} /></label>
        <label>窗口内弹出提醒<input type="checkbox" checked={preferences.toastEnabled} onChange={(event) => updatePreferences({ toastEnabled: event.target.checked })} /></label>
        <label>最低提醒级别<select value={preferences.minimumSeverity} onChange={(event) => updatePreferences({ minimumSeverity: event.target.value as NotificationPreferences["minimumSeverity"] })}><option value="info">提示</option><option value="warning">警告</option><option value="error">错误</option></select></label>
        <label>同规则冷却（秒）<input type="number" min="0" max="86400" step="30" value={preferences.cooldownSeconds} onChange={(event) => updatePreferences({ cooldownSeconds: Math.min(86_400, Math.max(0, Math.round(Number(event.target.value) || 0))) })} /></label>
        {(Object.keys(sourceNames) as NotificationSource[]).map((source) => <label key={source}>{sourceNames[source]}<input type="checkbox" checked={preferences.sources[source]} onChange={(event) => updatePreferences({ sources: { ...preferences.sources, [source]: event.target.checked } })} /></label>)}
        <small>关闭提醒仍保留历史。确认持续异常后，重复采样不会再次弹出；恢复后重新发生会产生新的提醒。</small>
        <div className="notification-test-row"><button disabled={model.loading || model.testing} onClick={() => void model.testNotification(preferences)}>{model.testing ? "生成中…" : "测试提醒"}</button><small>按连接与数据源的开关、级别和冷却设置处理；本地测试记录保存在通知历史。</small></div>
        {model.testMessage && <p className="notification-test-result" role="status">{model.testMessage}</p>}
      </details>
    </dialog>}
    {!opened && model.toast.length > 0 && <aside className="notification-toast glass" role="status">
      <button className="notification-toast-close ui-icon-button" onClick={model.dismissToast} aria-label="关闭提醒"><CloseIcon/></button>
      <strong>{model.toast[0].title}</strong><small>{model.toast.length > 1 ? `共 ${model.toast.length} 条新通知` : model.toast[0].detail}</small>
      <div><button onClick={() => { onOpen(); model.dismissToast(); }}>查看</button><button disabled={model.loading} onClick={() => void model.acknowledge(model.toast.map((record) => record.id))}>确认</button></div>
    </aside>}
  </>;
}
