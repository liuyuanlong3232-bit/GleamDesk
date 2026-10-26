use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity { Info, Warning, Error }

impl Severity {
    fn rank(self) -> u8 { match self { Self::Info => 0, Self::Warning => 1, Self::Error => 2 } }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source { System, Provider, Hardware, Api }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeKind { Event, Condition }

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationCandidate {
    pub id: String,
    pub source: Source,
    pub scope: String,
    pub rule: String,
    pub kind: NoticeKind,
    pub severity: Severity,
    pub title: String,
    pub detail: String,
    pub evidence_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRecord {
    pub schema_version: u8,
    pub id: String,
    pub source: Source,
    pub scope: String,
    pub rule: String,
    pub kind: NoticeKind,
    pub severity: Severity,
    pub title: String,
    pub detail: String,
    pub evidence_at: Option<String>,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub last_notified_at: Option<String>,
    pub acknowledged_at: Option<String>,
    pub resolved_at: Option<String>,
    pub occurrences: u32,
    pub active: bool,
    #[serde(default)]
    pub pending_delivery: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Sources { pub system: bool, pub provider: bool, pub hardware: bool, pub api: bool }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreferences {
    pub enabled: bool,
    pub toast_enabled: bool,
    pub minimum_severity: Severity,
    pub cooldown_seconds: u64,
    pub sources: Sources,
}

impl NotificationPreferences {
    fn accepts(&self, candidate: &NotificationCandidate) -> bool {
        let source_enabled = match candidate.source {
            Source::System => self.sources.system,
            Source::Provider => self.sources.provider,
            Source::Hardware => self.sources.hardware,
            Source::Api => self.sources.api,
        };
        self.enabled && source_enabled && candidate.severity.rank() >= self.minimum_severity.rank()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationState {
    pub records: Vec<NotificationRecord>,
    pub unacknowledged_count: u64,
    pub total_count: u64,
}

fn error(error: impl std::fmt::Display) -> String { error.to_string() }

fn timestamp(connection: &Connection) -> Result<String, String> {
    connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| row.get(0)).map_err(error)
}

fn validate(candidate: &NotificationCandidate) -> Result<(), String> {
    if candidate.id.is_empty() || candidate.id.len() > 160 || candidate.scope.is_empty() || candidate.scope.len() > 100
        || candidate.rule.is_empty() || candidate.rule.len() > 240 || candidate.title.is_empty() || candidate.title.len() > 600
        || candidate.detail.len() > 8_000 || candidate.evidence_at.as_ref().is_some_and(|value| value.len() > 40) {
        return Err("notification candidate exceeds its field limits".into());
    }
    Ok(())
}

fn get_record(connection: &Connection, id: &str) -> Result<Option<NotificationRecord>, String> {
    let json: Option<String> = connection.query_row(
        "SELECT payload_json FROM history_records WHERE kind='notifications_history' AND id=?1 AND json_extract(payload_json,'$.schemaVersion')=1",
        [id], |row| row.get(0),
    ).optional().map_err(error)?;
    json.map(|json| serde_json::from_str(&json).map_err(error)).transpose()
}

fn save_record(connection: &Connection, record: &NotificationRecord) -> Result<(), String> {
    connection.execute(
        "INSERT INTO history_records(kind,id,created_at,payload_json) VALUES ('notifications_history',?1,?2,?3)
         ON CONFLICT(kind,id) DO UPDATE SET created_at=excluded.created_at,payload_json=excluded.payload_json",
        params![record.id, record.first_seen_at, serde_json::to_string(record).map_err(error)?],
    ).map_err(error)?;
    Ok(())
}

fn read_state(connection: &Connection, limit: usize) -> Result<NotificationState, String> {
    let mut statement = connection.prepare(
        "SELECT payload_json FROM history_records WHERE kind='notifications_history' AND json_extract(payload_json,'$.schemaVersion')=1
         ORDER BY created_at DESC,id DESC LIMIT ?1",
    ).map_err(error)?;
    let rows = statement.query_map([limit.clamp(1, 1_000) as i64], |row| row.get::<_, String>(0)).map_err(error)?;
    let records = rows.map(|row| serde_json::from_str(&row.map_err(error)?).map_err(error)).collect::<Result<Vec<_>, String>>()?;
    let (total_count, unacknowledged_count): (i64, i64) = connection.query_row(
        "SELECT COUNT(*),COALESCE(SUM(CASE WHEN json_extract(payload_json,'$.acknowledgedAt') IS NULL THEN 1 ELSE 0 END),0)
         FROM history_records WHERE kind='notifications_history' AND json_extract(payload_json,'$.schemaVersion')=1",
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(error)?;
    Ok(NotificationState { records, total_count: total_count.max(0) as u64, unacknowledged_count: unacknowledged_count.max(0) as u64 })
}

fn apply(
    connection: &mut Connection,
    candidates: &[NotificationCandidate],
    complete_scopes: &[String],
    preferences: &NotificationPreferences,
    now_ms: u64,
    now: &str,
) -> Result<Vec<NotificationRecord>, String> {
    if candidates.len() > 100 || complete_scopes.len() > 30 || complete_scopes.iter().any(|scope| scope.len() > 100) {
        return Err("notification batch exceeds its limit".into());
    }
    for candidate in candidates { validate(candidate)?; }
    // An immediate transaction coordinates requests from both WebViews in the native process.
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
    let mut condition_query = transaction.prepare(
        "SELECT payload_json FROM history_records WHERE kind='notifications_history'
         AND json_extract(payload_json,'$.schemaVersion')=1 AND json_extract(payload_json,'$.kind')='condition'
         AND json_extract(payload_json,'$.active')=1",
    ).map_err(error)?;
    let conditions = condition_query.query_map([], |row| row.get::<_, String>(0)).map_err(error)?
        .map(|row| serde_json::from_str::<NotificationRecord>(&row.map_err(error)?).map_err(error)).collect::<Result<Vec<_>, String>>()?;
    drop(condition_query);
    for mut record in conditions {
        if complete_scopes.contains(&record.scope) && !candidates.iter().any(|candidate| candidate.id == record.id) {
            record.active = false;
            record.pending_delivery = false;
            record.resolved_at = Some(now.into());
            save_record(&transaction, &record)?;
        }
    }

    let mut delivered = Vec::new();
    for candidate in candidates {
        let previous = get_record(&transaction, &candidate.id)?;
        if previous.as_ref().is_some_and(|record| record.scope != candidate.scope || record.rule != candidate.rule || record.kind != candidate.kind || record.source != candidate.source) {
            return Err("notification identity collision".into());
        }
        let reactivated = previous.as_ref().is_some_and(|record| !record.active && candidate.kind == NoticeKind::Condition);
        let escalated = previous.as_ref().is_some_and(|record| candidate.severity.rank() > record.severity.rank());
        let fresh = previous.is_none();
        let mut record = previous.unwrap_or_else(|| NotificationRecord {
            schema_version: 1, id: candidate.id.clone(), source: candidate.source, scope: candidate.scope.clone(), rule: candidate.rule.clone(),
            kind: candidate.kind, severity: candidate.severity, title: candidate.title.clone(), detail: candidate.detail.clone(), evidence_at: candidate.evidence_at.clone(),
            first_seen_at: now.into(), last_seen_at: now.into(), last_notified_at: None, acknowledged_at: None, resolved_at: None, occurrences: 1, active: true, pending_delivery: false,
        });
        record.last_seen_at = now.into();
        record.title = candidate.title.clone();
        record.detail = candidate.detail.clone();
        record.evidence_at = candidate.evidence_at.clone();
        record.severity = candidate.severity;
        record.active = true;
        record.resolved_at = None;
        if reactivated { record.occurrences = record.occurrences.saturating_add(1); }
        if reactivated || escalated { record.acknowledged_at = None; }
        if candidate.kind == NoticeKind::Condition && (fresh || reactivated || escalated) { record.pending_delivery = true; }
        let may_notify = fresh || (candidate.kind == NoticeKind::Condition && record.pending_delivery && record.acknowledged_at.is_none());
        let group_key = format!("{}:{}", candidate.scope, candidate.rule);
        let previous_delivery: Option<i64> = transaction.query_row(
            "SELECT delivered_at FROM notification_cooldowns WHERE group_key=?1", [&group_key], |row| row.get(0),
        ).optional().map_err(error)?;
        let cooled_down = previous_delivery.is_none_or(|at| now_ms.saturating_sub(at.max(0) as u64) >= preferences.cooldown_seconds.clamp(0, 86_400) * 1_000);
        if may_notify && preferences.accepts(candidate) && cooled_down {
            record.last_notified_at = Some(now.into());
            record.pending_delivery = false;
            transaction.execute(
                "INSERT INTO notification_cooldowns(group_key,delivered_at) VALUES (?1,?2)
                 ON CONFLICT(group_key) DO UPDATE SET delivered_at=excluded.delivered_at",
                params![group_key, now_ms.min(i64::MAX as u64) as i64],
            ).map_err(error)?;
            delivered.push(record.clone());
        }
        save_record(&transaction, &record)?;
    }
    transaction.commit().map_err(error)?;
    Ok(delivered)
}

fn is_red_news(record: &NotificationRecord) -> bool {
    record.source == Source::Provider && record.scope == "news-vps"
        && record.kind == NoticeKind::Event && record.rule.starts_with("news-event:")
        && record.severity == Severity::Error
}

fn red_news_text(records: &[NotificationRecord]) -> Option<String> {
    let red: Vec<_> = records.iter().filter(|record| is_red_news(record)).collect();
    if red.is_empty() { return None; }
    let mut text = String::from("来源已明确标注以下重大事件，请核对原文；等级不代表内容已经独立核实。\n\n");
    for record in red.iter().take(4) {
        text.push_str(&record.title.chars().filter(|c| *c != '\0').take(180).collect::<String>());
        text.push('\n');
        text.push_str(&record.detail.chars().filter(|c| *c != '\0').take(380).collect::<String>());
        text.push_str("\n\n");
    }
    if red.len() > 4 { text.push_str(&format!("另有 {} 条，详见通知中心。\n", red.len() - 4)); }
    text.push_str("完整记录保存在通知中心；关闭本窗口不会重复推送同一事件。");
    Some(text)
}

#[cfg(windows)]
fn show_red_news(text: String) -> Option<std::thread::JoinHandle<()>> {
    // Keep dialogs serial and off the UI/SQLite worker; native websites cannot cover them.
    static DIALOG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    std::thread::Builder::new().name("news-alert".into()).spawn(move || {
        let _guard = DIALOG_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let title: Vec<u16> = "重大新闻提醒 / RED\0".encode_utf16().collect();
        let body: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_OK, MB_ICONWARNING, MB_TOPMOST, MB_SETFOREGROUND};
        unsafe { MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), MB_OK | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND); }
    }).ok()
}

#[cfg(not(windows))]
fn show_red_news(_text: String) -> Option<std::thread::JoinHandle<()>> { None }

fn notification_target<'a>(windows: &[(&'a str, bool, bool)]) -> Option<&'a str> {
    windows.iter().find(|(label, visible, focused)| ["main", "dashboard"].contains(label) && *visible && *focused)
        .or_else(|| windows.iter().find(|(label, visible, _)| *label == "dashboard" && *visible))
        .or_else(|| windows.iter().find(|(label, visible, _)| *label == "main" && *visible))
        .map(|(label, _, _)| *label)
}
fn broadcast(app: &AppHandle, delivered: &[NotificationRecord], toast_enabled: bool) {
    let _ = app.emit("notifications-changed", ());
    if !toast_enabled || delivered.is_empty() { return; }
    if let Some(text) = red_news_text(delivered) { let _ = show_red_news(text); }
    let toast: Vec<_> = delivered.iter().filter(|record| !is_red_news(record)).cloned().collect();
    if toast.is_empty() { return; }
    let windows = app.windows();
    let states: Vec<_> = windows.values().map(|window| (window.label(), window.is_visible().unwrap_or(false), window.is_focused().unwrap_or(false))).collect();
    let target = notification_target(&states);
    if let Some(label) = target { let _ = app.emit_to(label, "notification-toast", &toast); }
}

#[tauri::command]
pub async fn notification_apply(app: AppHandle, candidates: Vec<NotificationCandidate>, complete_scopes: Vec<String>, preferences: NotificationPreferences) -> Result<NotificationState, String> {
    tauri::async_runtime::spawn_blocking(move || notification_apply_blocking(app, candidates, complete_scopes, preferences))
        .await.map_err(|_| "通知保存任务无法完成".to_string())?
}

fn notification_apply_blocking(app: AppHandle, candidates: Vec<NotificationCandidate>, complete_scopes: Vec<String>, preferences: NotificationPreferences) -> Result<NotificationState, String> {
    let (path, legacy) = crate::storage::database_paths(&app)?;
    let mut connection = crate::storage::open_database(&path, &legacy)?;
    let now = timestamp(&connection)?;
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64;
    let previous_changes = connection.total_changes();
    let delivered = apply(&mut connection, &candidates, &complete_scopes, &preferences, now_ms, &now)?;
    let state = read_state(&connection, 200)?;
    if connection.total_changes() > previous_changes { broadcast(&app, &delivered, preferences.toast_enabled); }
    Ok(state)
}

#[tauri::command]
pub async fn notification_state(app: AppHandle, limit: Option<usize>) -> Result<NotificationState, String> {
    tauri::async_runtime::spawn_blocking(move || notification_state_blocking(app, limit))
        .await.map_err(|_| "通知查询任务无法完成".to_string())?
}

fn notification_state_blocking(app: AppHandle, limit: Option<usize>) -> Result<NotificationState, String> {
    let (path, legacy) = crate::storage::database_paths(&app)?;
    read_state(&crate::storage::open_database(&path, &legacy)?, limit.unwrap_or(200))
}

#[tauri::command]
pub async fn notification_acknowledge(app: AppHandle, ids: Vec<String>, all: bool) -> Result<NotificationState, String> {
    tauri::async_runtime::spawn_blocking(move || notification_acknowledge_blocking(app, ids, all))
        .await.map_err(|_| "通知确认任务无法完成".to_string())?
}

fn notification_acknowledge_blocking(app: AppHandle, ids: Vec<String>, all: bool) -> Result<NotificationState, String> {
    if ids.len() > 1_000 || ids.iter().any(|id| id.len() > 160) { return Err("notification acknowledgement exceeds its limit".into()); }
    let (path, legacy) = crate::storage::database_paths(&app)?;
    let mut connection = crate::storage::open_database(&path, &legacy)?;
    let now = timestamp(&connection)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
    if all {
        transaction.execute(
            "UPDATE history_records SET payload_json=json_set(payload_json,'$.acknowledgedAt',?1,'$.pendingDelivery',json('false'))
             WHERE kind='notifications_history' AND json_extract(payload_json,'$.schemaVersion')=1 AND json_extract(payload_json,'$.acknowledgedAt') IS NULL",
            [&now],
        ).map_err(error)?;
    } else {
        for id in ids {
            transaction.execute(
                "UPDATE history_records SET payload_json=json_set(payload_json,'$.acknowledgedAt',?1,'$.pendingDelivery',json('false'))
                 WHERE kind='notifications_history' AND id=?2 AND json_extract(payload_json,'$.schemaVersion')=1",
                params![now, id],
            ).map_err(error)?;
        }
    }
    transaction.commit().map_err(error)?;
    let state = read_state(&connection, 200)?;
    broadcast(&app, &[], false);
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn red_news_routing_requires_news_event_scope_and_severity() {
        let mut connection = connection();
        let mut item = candidate("news:test", NoticeKind::Event);
        item.scope = "news-vps".into(); item.rule = "news-event:news:test".into(); item.severity = Severity::Error;
        let records = apply(&mut connection, &[item.clone()], &[], &preferences(), 1_000, "2026-10-05T00:00:00.000Z").unwrap();
        assert!(is_red_news(&records[0]));
        assert!(red_news_text(&records).unwrap().contains("完整记录"));
        assert!(apply(&mut connection, &[item], &[], &preferences(), 999_000, "2026-10-05T00:16:00.000Z").unwrap().is_empty());
        let mut other = records[0].clone(); other.severity = Severity::Warning;
        assert!(!is_red_news(&other)); assert!(red_news_text(&[other.clone()]).is_none());
        other.severity = Severity::Error; other.scope = "vps-status".into(); assert!(!is_red_news(&other));
        other.scope = "news-vps".into(); other.source = Source::System; assert!(!is_red_news(&other));
        other.source = Source::Provider; other.kind = NoticeKind::Condition; assert!(!is_red_news(&other));
    }
    #[test]
    fn news_alert_text_batches_and_bounds_source_content() {
        let mut connection = connection();
        let items: Vec<_> = (0..5).map(|id| { let mut item = candidate(&format!("news:{id}"), NoticeKind::Event);
            item.scope = "news-vps".into(); item.rule = format!("news-event:{id}"); item.severity = Severity::Error;
            item.title = "title\0".into(); item.detail = "detail\0".into(); item }).collect();
        let records = apply(&mut connection, &items, &[], &preferences(), 1_000, "2026-10-05T00:00:00.000Z").unwrap();
        assert_eq!(records.len(), 5);
        let text = red_news_text(&records).unwrap(); assert!(text.contains("另有 1 条")); assert!(!text.contains('\0'));
        let mut prefs = preferences(); prefs.sources.provider = false;
        let mut muted = items[0].clone(); muted.id = "muted-news".into();
        assert!(apply(&mut connection, &[muted], &[], &prefs, 999_000, "2026-10-05T00:16:00.000Z").unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Requires an interactive Windows desktop and manual dismissal"]
    fn red_news_popup_manual_preview() {
        show_red_news("本地界面测试，非真实新闻。\n\n本次仅检查重大提醒弹窗的显示与关闭；不读取VPS、不调用API、不写通知历史。\n\n请点击确定关闭测试窗口。".into())
            .expect("news dialog worker must start").join().expect("news dialog worker must exit");
    }
    #[test]
    fn toast_target_uses_local_windows_even_with_native_children() {
        assert_eq!(notification_target(&[("dashboard", true, true), ("main", true, false), ("remote-popup-1", true, true)]), Some("dashboard"));
        assert_eq!(notification_target(&[("dashboard", true, false), ("main", true, false), ("remote-popup-1", true, true)]), Some("dashboard"));
        assert_eq!(notification_target(&[("dashboard", false, false), ("main", true, false)]), Some("main"));
        assert_eq!(notification_target(&[("remote-app-mues", true, true), ("dock", true, true)]), None);
    }
    fn preferences() -> NotificationPreferences {
        NotificationPreferences { enabled: true, toast_enabled: true, minimum_severity: Severity::Warning, cooldown_seconds: 300,
            sources: Sources { system: true, provider: true, hardware: true, api: true } }
    }
    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE history_records(kind TEXT,id TEXT,created_at TEXT,payload_json TEXT,PRIMARY KEY(kind,id));
            CREATE TABLE notification_cooldowns(group_key TEXT PRIMARY KEY,delivered_at INTEGER);").unwrap();
        connection
    }
    fn candidate(id: &str, kind: NoticeKind) -> NotificationCandidate {
        NotificationCandidate { id: id.into(), source: Source::Provider, scope: "vps-status".into(), rule: "connection".into(), kind,
            severity: Severity::Warning, title: "VPS connection unavailable".into(), detail: "No current response".into(), evidence_at: None }
    }
    #[test]
    fn duplicate_events_and_repeated_conditions_preserve_acknowledgements() {
        let mut connection = connection();
        let item = candidate("vps", NoticeKind::Condition);
        assert_eq!(apply(&mut connection, &[item.clone()], &[], &preferences(), 1_000, "2026-10-05T00:00:00.000Z").unwrap().len(), 1);
        let mut record = get_record(&connection, "vps").unwrap().unwrap();
        record.acknowledged_at = Some("2026-10-05T00:00:01.000Z".into());
        save_record(&connection, &record).unwrap();
        assert!(apply(&mut connection, &[item], &[], &preferences(), 601_000, "2026-10-05T00:10:00.000Z").unwrap().is_empty());
        let record = get_record(&connection, "vps").unwrap().unwrap();
        assert!(record.acknowledged_at.is_some());
        assert_eq!(record.occurrences, 1);
        let event = candidate("event", NoticeKind::Event);
        apply(&mut connection, &[event.clone()], &[], &preferences(), 900_000, "2026-10-05T00:15:00.000Z").unwrap();
        assert!(apply(&mut connection, &[event], &[], &preferences(), 1_900_000, "2026-10-05T00:30:00.000Z").unwrap().is_empty());
    }
    #[test]
    fn cooldown_keeps_new_events_in_history_and_resolution_is_scope_limited() {
        let mut connection = connection();
        let first = candidate("event-1", NoticeKind::Event);
        let second = candidate("event-2", NoticeKind::Event);
        assert_eq!(apply(&mut connection, &[first], &[], &preferences(), 1_000, "2026-10-05T00:00:00.000Z").unwrap().len(), 1);
        assert!(apply(&mut connection, &[second], &[], &preferences(), 2_000, "2026-10-05T00:00:01.000Z").unwrap().is_empty());
        assert_eq!(read_state(&connection, 200).unwrap().total_count, 2);
        let item = candidate("condition", NoticeKind::Condition);
        apply(&mut connection, &[item.clone()], &[], &preferences(), 400_000, "2026-10-05T00:06:00.000Z").unwrap();
        apply(&mut connection, &[], &["windows-health".into()], &preferences(), 500_000, "2026-10-05T00:08:00.000Z").unwrap();
        assert!(get_record(&connection, "condition").unwrap().unwrap().active);
        apply(&mut connection, &[], &["vps-status".into()], &preferences(), 600_000, "2026-10-05T00:10:00.000Z").unwrap();
        assert!(!get_record(&connection, "condition").unwrap().unwrap().active);
        assert_eq!(apply(&mut connection, &[item], &[], &preferences(), 800_000, "2026-10-05T00:13:00.000Z").unwrap().len(), 1);
        assert_eq!(get_record(&connection, "condition").unwrap().unwrap().occurrences, 2);
    }
    #[test]
    fn muted_sources_record_evidence_without_delivery() {
        let mut connection = connection();
        let mut prefs = preferences();
        prefs.sources.provider = false;
        assert!(apply(&mut connection, &[candidate("muted", NoticeKind::Event)], &[], &prefs, 1_000, "2026-10-05T00:00:00.000Z").unwrap().is_empty());
        assert_eq!(read_state(&connection, 200).unwrap().unacknowledged_count, 1);
    }
    #[test]
    fn recovered_condition_waits_for_cooldown_and_acknowledgement_clears_pending_delivery() {
        let mut connection = connection();
        let item = candidate("condition", NoticeKind::Condition);
        apply(&mut connection, &[item.clone()], &[], &preferences(), 1_000, "2026-10-05T00:00:00.000Z").unwrap();
        apply(&mut connection, &[], &[item.scope.clone()], &preferences(), 2_000, "2026-10-05T00:00:01.000Z").unwrap();
        assert!(apply(&mut connection, &[item.clone()], &[], &preferences(), 3_000, "2026-10-05T00:00:02.000Z").unwrap().is_empty());
        assert!(get_record(&connection, "condition").unwrap().unwrap().pending_delivery);
        let later = apply(&mut connection, &[item.clone()], &[], &preferences(), 302_000, "2026-10-05T00:05:01.000Z").unwrap();
        assert_eq!(later.len(), 1);
        assert_eq!(later[0].occurrences, 2);
        let mut record = later[0].clone();
        record.acknowledged_at = Some("2026-10-05T00:05:02.000Z".into()); record.pending_delivery = false;
        save_record(&connection, &record).unwrap();
        assert!(apply(&mut connection, &[item], &[], &preferences(), 700_000, "2026-10-05T00:11:00.000Z").unwrap().is_empty());
    }
    #[test]
    fn independent_database_connections_cannot_deliver_the_same_notice_twice() {
        use std::sync::{Arc, Barrier};
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("codex-notifications-{}-{nonce}.sqlite3", std::process::id()));
        let setup = Connection::open(&path).unwrap();
        setup.execute_batch("CREATE TABLE history_records(kind TEXT,id TEXT,created_at TEXT,payload_json TEXT,PRIMARY KEY(kind,id));
            CREATE TABLE notification_cooldowns(group_key TEXT PRIMARY KEY,delivered_at INTEGER);").unwrap();
        drop(setup);
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = (0..2).map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut connection = Connection::open(path).unwrap();
                connection.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
                barrier.wait();
                apply(&mut connection, &[candidate("same-event", NoticeKind::Event)], &[], &preferences(), 1_000, "2026-10-05T00:00:00.000Z").unwrap().len()
            })
        }).collect();
        assert_eq!(workers.into_iter().map(|worker| worker.join().unwrap()).sum::<usize>(), 1);
        let connection = Connection::open(&path).unwrap();
        assert_eq!(read_state(&connection, 200).unwrap().total_count, 1);
        drop(connection);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn manual_notification_scope_deduplicates_without_resolving_live_conditions() {
        let mut connection = connection();
        let live = candidate("live", NoticeKind::Condition);
        apply(&mut connection, &[live.clone()], &[], &preferences(), 1_000, "2026-10-06T00:00:00.000Z").unwrap();
        let mut first = candidate("notification-test:first", NoticeKind::Event);
        first.scope = "notification-self-test".into();
        first.rule = "manual-test".into();
        first.title = "本地测试通知".into();
        first.detail = "用户手动检查通知流程".into();
        assert_eq!(apply(&mut connection, &[first.clone()], &[], &preferences(), 2_000, "2026-10-06T00:00:01.000Z").unwrap().len(), 1);
        assert!(apply(&mut connection, &[first.clone()], &[], &preferences(), 3_000, "2026-10-06T00:00:02.000Z").unwrap().is_empty());
        assert_eq!(read_state(&connection, 200).unwrap().total_count, 2);
        assert!(get_record(&connection, &live.id).unwrap().unwrap().active);
        let mut second = first;
        second.id = "notification-test:second".into();
        assert!(apply(&mut connection, &[second.clone()], &[], &preferences(), 4_000, "2026-10-06T00:00:03.000Z").unwrap().is_empty());
        assert_eq!(read_state(&connection, 200).unwrap().total_count, 3);
        assert!(get_record(&connection, &second.id).unwrap().unwrap().last_notified_at.is_none());
    }
}
