use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}, time::Duration};
use tauri::{AppHandle, Manager};

const MAX_QUERY: usize = 1_000;
const MAX_PAYLOAD_BYTES: usize = 256 * 1024;
const MAX_LEGACY_STORE_BYTES: usize = 16 * 1024 * 1024;
const CURRENT_SCHEMA_VERSION: i64 = 5;
const ALLOWED_KINDS: [&str; 8] = [
    "provider_history", "widget_state", "system_events", "usage_history", "vps_history",
    "hardware_history", "application_history", "notifications_history",
];
const RETENTION_DAYS: [(&str, i64); 7] = [
    ("provider_history", 90),
    ("system_events", 30),
    ("usage_history", 365),
    ("vps_history", 90),
    ("hardware_history", 30),
    ("application_history", 180),
    ("notifications_history", 90),
];
const MAINTENANCE_INTERVAL_SECONDS: i64 = 6 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub id: String,
    pub kind: String,
    pub created_at: String,
    pub payload: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRangeResult {
    pub(crate) records: Vec<HistoryRecord>,
    pub(crate) total_count: usize,
    pub(crate) truncated: bool,
}

#[derive(Default, Deserialize)]
struct HistoryDocument {
    records: Vec<HistoryRecord>,
}

pub(crate) fn database_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok((directory.join("history.sqlite3"), directory.join("history.json")))
}

pub(crate) fn open_database(path: &Path, legacy_path: &Path) -> Result<Connection, String> {
    let mut connection = Connection::open(path).map_err(storage_error)?;
    connection.busy_timeout(Duration::from_secs(5)).map_err(storage_error)?;
    let journal: String = connection.pragma_query_value(None, "journal_mode", |row| row.get(0)).map_err(storage_error)?;
    if journal != "wal" { connection.pragma_update(None, "journal_mode", "WAL").map_err(storage_error)?; }
    connection.pragma_update(None, "synchronous", "NORMAL").map_err(storage_error)?;
    connection.pragma_update(None, "foreign_keys", "ON").map_err(storage_error)?;
    migrate(&mut connection, legacy_path)?;
    prune_expired_if_due(&mut connection)?;
    Ok(connection)
}

fn migrate(connection: &mut Connection, legacy_path: &Path) -> Result<(), String> {
    loop {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage_error)?;
        let version: i64 = transaction.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(storage_error)?;
        if version == CURRENT_SCHEMA_VERSION { transaction.commit().map_err(storage_error)?; break; }
        if version > CURRENT_SCHEMA_VERSION { return Err("history database was created by a newer application version".into()); }
        let next = version + 1;
        match next {
            1 => transaction.execute_batch(
                "CREATE TABLE history_records (
                    kind TEXT NOT NULL,
                    id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    PRIMARY KEY (kind, id)
                );
                CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at TEXT NOT NULL
                );",
            ).map_err(storage_error)?,
            2 => transaction.execute_batch(
                "CREATE INDEX history_by_kind_created ON history_records(kind, created_at DESC);
                CREATE INDEX history_by_created ON history_records(created_at DESC);
                CREATE TABLE maintenance_state (
                    key TEXT PRIMARY KEY,
                    completed_at INTEGER NOT NULL
                );",
            ).map_err(storage_error)?,
            3 => {
                let legacy = read_legacy_document(legacy_path)?;
                for record in legacy.records {
                    validate_record(&record)?;
                    insert_record(&transaction, &record)?;
                }
            }
            4 => transaction.execute_batch(
                "CREATE TABLE notification_cooldowns (
                    group_key TEXT PRIMARY KEY,
                    delivered_at INTEGER NOT NULL
                );",
            ).map_err(storage_error)?,
            5 => transaction.execute_batch(
                "UPDATE history_records
                 SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at))
                 WHERE length(created_at)=20
                   AND substr(created_at,20,1)='Z'
                   AND substr(created_at,1,19)||'.000Z'=strftime('%Y-%m-%dT%H:%M:%fZ',julianday(created_at));",
            ).map_err(storage_error)?,
            _ => return Err(format!("unsupported history schema migration {next}")),
        }
        transaction.pragma_update(None, "user_version", next).map_err(storage_error)?;
        transaction.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            [next],
        ).map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
    }
    Ok(())
}

fn read_legacy_document(path: &Path) -> Result<HistoryDocument, String> {
    match fs::read(path) {
        Ok(bytes) if bytes.len() <= MAX_LEGACY_STORE_BYTES => serde_json::from_slice(&bytes)
            .map_err(|error| format!("legacy history.json is invalid and was preserved: {error}")),
        Ok(_) => Err("legacy history.json exceeds the 16 MB migration safety limit and was preserved".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HistoryDocument::default()),
        Err(error) => Err(format!("cannot read legacy history.json: {error}")),
    }
}

fn validate_record(record: &HistoryRecord) -> Result<(), String> {
    if record.id.trim().is_empty() || record.id.len() > 160 { return Err("invalid history record id".into()); }
    if !ALLOWED_KINDS.contains(&record.kind.as_str()) { return Err("unsupported history record kind".into()); }
    if record.created_at.len() < 20 || record.created_at.len() > 40 || !record.created_at.contains('T') || !record.created_at.ends_with('Z') {
        return Err("invalid history timestamp".into());
    }
    if serde_json::to_vec(&record.payload).map_err(storage_error)?.len() > MAX_PAYLOAD_BYTES {
        return Err("history record payload exceeds the 256 KB limit".into());
    }
    Ok(())
}

fn insert_record(connection: &Connection, record: &HistoryRecord) -> Result<(), String> {
    let created_at = canonical_timestamp(connection, &record.created_at)?;
    let payload = serde_json::to_string(&record.payload).map_err(storage_error)?;
    connection.execute(
        "INSERT INTO history_records(kind, id, created_at, payload_json)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(kind, id) DO UPDATE SET created_at=excluded.created_at, payload_json=excluded.payload_json",
        params![record.kind, record.id, created_at, payload],
    ).map_err(storage_error)?;
    Ok(())
}

fn canonical_timestamp(connection: &Connection, timestamp: &str) -> Result<String, String> {
    if !timestamp.is_ascii() || !timestamp.ends_with('Z') { return Err("invalid history UTC timestamp".into()); }
    let canonical = match timestamp.len() {
        20 => format!("{}.000Z", &timestamp[..19]),
        24 => timestamp.to_string(),
        _ => return Err("history timestamps require seconds or millisecond precision".into()),
    };
    let normalized: Option<String> = connection.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ',julianday(?1))", [&canonical], |row| row.get(0),
    ).map_err(storage_error)?;
    if normalized.as_deref() != Some(canonical.as_str()) { return Err("invalid history calendar timestamp".into()); }
    Ok(canonical)
}

fn prune_expired_if_due(connection: &mut Connection) -> Result<(), String> {
    let now: i64 = connection.query_row("SELECT unixepoch()", [], |row| row.get(0)).map_err(storage_error)?;
    let previous: Option<i64> = connection.query_row(
        "SELECT completed_at FROM maintenance_state WHERE key='retention-prune'",
        [],
        |row| row.get(0),
    ).optional().map_err(storage_error)?;
    if previous.is_some_and(|at| now - at < MAINTENANCE_INTERVAL_SECONDS) { return Ok(()); }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage_error)?;
    for (kind, days) in RETENTION_DAYS {
        let modifier = format!("-{days} days");
        transaction.execute(
            "DELETE FROM history_records WHERE kind=?1 AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',?2)",
            params![kind, modifier],
        ).map_err(storage_error)?;
    }
    transaction.execute("DELETE FROM notification_cooldowns WHERE delivered_at < (unixepoch() - 90 * 86400) * 1000", [])
        .map_err(storage_error)?;
    transaction.execute(
        "INSERT INTO maintenance_state(key, completed_at) VALUES ('retention-prune', ?1)
         ON CONFLICT(key) DO UPDATE SET completed_at=excluded.completed_at",
        [now],
    ).map_err(storage_error)?;
    transaction.commit().map_err(storage_error)
}

fn prune_kind(connection: &Connection, kind: &str, before: &str) -> Result<usize, String> {
    if !RETENTION_DAYS.iter().any(|(candidate, _)| *candidate == kind) {
        return Err("history pruning is not enabled for this record kind".into());
    }
    let canonical_before = canonical_timestamp(connection, before)?;
    connection.execute("DELETE FROM history_records WHERE kind=?1 AND created_at < ?2", params![kind, canonical_before])
        .map_err(storage_error)
}

fn decode_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryRecord> {
    let payload: String = row.get(3)?;
    Ok(HistoryRecord {
        kind: row.get(0)?,
        id: row.get(1)?,
        created_at: row.get(2)?,
        payload: serde_json::from_str(&payload).map_err(|error| rusqlite::Error::FromSqlConversionFailure(
            payload.len(), rusqlite::types::Type::Text, Box::new(error),
        ))?,
    })
}

fn storage_error(error: impl std::fmt::Display) -> String { error.to_string() }

pub(crate) fn query_range(connection: &mut Connection, kind: &str, from: &str, to: &str, limit: usize) -> Result<HistoryRangeResult, String> {
    if !ALLOWED_KINDS.contains(&kind) { return Err("unsupported history record kind".into()); }
    if from.len() != 24 || to.len() != 24 { return Err("history range requires canonical UTC timestamps".into()); }
    let parsed: (Option<i64>, Option<i64>, Option<String>, Option<String>) = connection.query_row(
        "SELECT CAST(unixepoch(?1)*1000+substr(?1,21,3) AS INTEGER), CAST(unixepoch(?2)*1000+substr(?2,21,3) AS INTEGER),
         strftime('%Y-%m-%dT%H:%M:%fZ',julianday(?1)), strftime('%Y-%m-%dT%H:%M:%fZ',julianday(?2))",
        params![from, to], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).map_err(storage_error)?;
    let (Some(start), Some(end), Some(canonical_from), Some(canonical_to)) = parsed else {
        return Err("invalid history range timestamp".into());
    };
    if canonical_from != from || canonical_to != to || end <= start || end - start > 8 * 86_400_000 {
        return Err("invalid history range or range exceeds eight days".into());
    }
    let transaction = connection.transaction().map_err(storage_error)?;
    let count: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM history_records WHERE kind=?1 AND created_at>=?2 AND created_at<?3",
        params![kind, from, to], |row| row.get(0),
    ).map_err(storage_error)?;
    let mut records = Vec::new();
    let mut bytes = 2;
    {
        let mut statement = transaction.prepare(
            "SELECT kind, id, created_at, payload_json FROM history_records
             WHERE kind=?1 AND created_at>=?2 AND created_at<?3 ORDER BY created_at DESC, id DESC LIMIT ?4",
        ).map_err(storage_error)?;
        let rows = statement.query_map(params![kind, from, to, limit.clamp(1, MAX_QUERY) as i64], decode_record).map_err(storage_error)?;
        for row in rows {
            let record = row.map_err(storage_error)?;
            bytes += serde_json::to_vec(&record).map_err(storage_error)?.len() + 1;
            if bytes > 2 * 1024 * 1024 { break; }
            records.push(record);
        }
    }
    transaction.commit().map_err(storage_error)?;
    let total_count = usize::try_from(count).map_err(storage_error)?;
    Ok(HistoryRangeResult { truncated: total_count > records.len(), records, total_count })
}

#[tauri::command]
pub async fn storage_query_range(app: AppHandle, kind: String, from: String, to: String, limit: Option<usize>) -> Result<HistoryRangeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, legacy_path) = database_paths(&app)?;
        let mut connection = open_database(&path, &legacy_path)?;
        query_range(&mut connection, &kind, &from, &to, limit.unwrap_or(MAX_QUERY))
    }).await.map_err(|_| "history range worker failed".to_string())?
}

#[tauri::command]
pub fn storage_insert(app: AppHandle, record: HistoryRecord) -> Result<(), String> {
    validate_record(&record)?;
    let (path, legacy_path) = database_paths(&app)?;
    let mut connection = open_database(&path, &legacy_path)?;
    let transaction = connection.transaction().map_err(storage_error)?;
    insert_record(&transaction, &record)?;
    transaction.commit().map_err(storage_error)
}

#[tauri::command]
pub fn storage_prune(app: AppHandle, kind: String, before: String) -> Result<usize, String> {
    if before.len() < 20 || before.len() > 40 || !before.contains('T') || !before.ends_with('Z') {
        return Err("invalid history cutoff timestamp".into());
    }
    let (path, legacy_path) = database_paths(&app)?;
    let connection = open_database(&path, &legacy_path)?;
    prune_kind(&connection, &kind, &before)
}

#[tauri::command]
pub fn storage_query(app: AppHandle, kind: Option<String>, limit: Option<usize>) -> Result<Vec<HistoryRecord>, String> {
    if let Some(kind) = kind.as_deref() {
        if !ALLOWED_KINDS.contains(&kind) { return Err("unsupported history record kind".into()); }
    }
    let count = limit.unwrap_or(100).clamp(1, MAX_QUERY) as i64;
    let (path, legacy_path) = database_paths(&app)?;
    let connection = open_database(&path, &legacy_path)?;
    let sql = if kind.is_some() {
        "SELECT kind, id, created_at, payload_json FROM history_records WHERE kind=?1 ORDER BY created_at DESC, id DESC LIMIT ?2"
    } else {
        "SELECT kind, id, created_at, payload_json FROM history_records ORDER BY created_at DESC, id DESC LIMIT ?1"
    };
    let mut statement = connection.prepare(sql).map_err(storage_error)?;
    let rows = if let Some(kind) = kind {
        statement.query_map(params![kind, count], decode_record).map_err(storage_error)?
    } else {
        statement.query_map([count], decode_record).map_err(storage_error)?
    };
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(storage_error)
}

#[tauri::command]
pub fn storage_count(app: AppHandle, kind: String) -> Result<usize, String> {
    if !ALLOWED_KINDS.contains(&kind.as_str()) { return Err("unsupported history record kind".into()); }
    let (path, legacy_path) = database_paths(&app)?;
    let connection = open_database(&path, &legacy_path)?;
    let count: i64 = connection.query_row("SELECT COUNT(*) FROM history_records WHERE kind=?1", [kind], |row| row.get(0))
        .map_err(storage_error)?;
    usize::try_from(count).map_err(storage_error)
}

#[tauri::command]
pub fn storage_delete(app: AppHandle, id: String, kind: Option<String>) -> Result<(), String> {
    if id.len() > 160 { return Err("invalid history record id".into()); }
    if let Some(kind) = kind.as_deref() {
        if !ALLOWED_KINDS.contains(&kind) { return Err("unsupported history record kind".into()); }
    }
    let (path, legacy_path) = database_paths(&app)?;
    let connection = open_database(&path, &legacy_path)?;
    match kind {
        Some(kind) => connection.execute("DELETE FROM history_records WHERE id=?1 AND kind=?2", params![id, kind]),
        None => connection.execute("DELETE FROM history_records WHERE id=?1", [id]),
    }.map_err(storage_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);
    static DIRECTORY_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    impl TestDirectory {
        fn new() -> Self {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let id = DIRECTORY_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!("codex-history-{}-{nonce}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self, name: &str) -> PathBuf { self.0.join(name) }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    fn record(kind: &str, id: &str, created_at: &str, value: i64) -> HistoryRecord {
        HistoryRecord { kind: kind.into(), id: id.into(), created_at: created_at.into(), payload: serde_json::json!({"value": value}) }
    }

    #[test]
    fn range_query_filters_before_limiting_and_reports_truncation() {
        let directory = TestDirectory::new();
        let mut connection = open_database(&directory.path("history.sqlite3"), &directory.path("missing.json")).unwrap();
        insert_record(&connection, &record("hardware_history", "old", "2026-10-05T00:00:00.000Z", 1)).unwrap();
        insert_record(&connection, &record("hardware_history", "in-1", "2026-10-05T01:00:00.000Z", 2)).unwrap();
        insert_record(&connection, &record("hardware_history", "in-2", "2026-10-05T01:05:00.000Z", 3)).unwrap();
        insert_record(&connection, &record("hardware_history", "end", "2026-10-05T01:10:00.000Z", 4)).unwrap();
        insert_record(&connection, &record("system_events", "other-kind", "2026-10-05T01:03:00.000Z", 5)).unwrap();
        let result = query_range(&mut connection, "hardware_history", "2026-10-05T01:00:00.000Z", "2026-10-05T01:10:00.000Z", 1).unwrap();
        assert_eq!(result.total_count, 2);
        assert_eq!(result.records[0].id, "in-2");
        assert!(result.truncated);
        let complete = query_range(&mut connection, "hardware_history", "2026-10-05T01:00:00.000Z", "2026-10-05T01:10:00.000Z", 10).unwrap();
        assert_eq!(complete.records.len(), 2);
        assert!(!complete.truncated);
        assert!(query_range(&mut connection, "unknown", "2026-10-05T01:00:00.000Z", "2026-10-05T01:10:00.000Z", 10).is_err());
        assert!(query_range(&mut connection, "hardware_history", "not-a-time", "2026-10-05T01:10:00.000Z", 10).is_err());
        assert!(query_range(&mut connection, "hardware_history", "2026-10-05T01:10:00.000Z", "2026-10-05T01:00:00.000Z", 10).is_err());
    }

    #[test]
    fn range_query_caps_serialized_payload_without_claiming_completeness() {
        let directory = TestDirectory::new();
        let mut connection = open_database(&directory.path("history.sqlite3"), &directory.path("missing.json")).unwrap();
        for index in 0..10 {
            let mut entry = record("hardware_history", &format!("large-{index}"), "2026-10-05T01:00:00.000Z", 1);
            entry.payload = serde_json::json!({"text": "x".repeat(240 * 1024)});
            insert_record(&connection, &entry).unwrap();
        }
        let result = query_range(&mut connection, "hardware_history", "2026-10-05T00:00:00.000Z", "2026-10-05T02:00:00.000Z", 1000).unwrap();
        assert_eq!(result.total_count, 10);
        assert!(result.truncated);
        assert!(result.records.len() < 10);
        assert!(serde_json::to_vec(&result.records).unwrap().len() <= 2 * 1024 * 1024);
    }

    #[test]
    fn utc_second_and_millisecond_formats_share_the_same_range_boundary() {
        let directory = TestDirectory::new();
        let mut connection = open_database(&directory.path("history.sqlite3"), &directory.path("missing.json")).unwrap();
        insert_record(&connection, &record("usage_history", "whole-second", "2026-10-05T01:00:00Z", 1)).unwrap();
        insert_record(&connection, &record("usage_history", "next-millisecond", "2026-10-05T01:00:00.001Z", 2)).unwrap();
        let result = query_range(&mut connection, "usage_history", "2026-10-05T01:00:00.000Z", "2026-10-05T01:00:00.001Z", 100).unwrap();
        assert_eq!(result.records.len(), 1);
        assert_eq!(result.records[0].id, "whole-second");
        assert_eq!(result.records[0].created_at, "2026-10-05T01:00:00.000Z");
        assert_eq!(prune_kind(&connection, "usage_history", "2026-10-05T01:00:00Z").unwrap(), 0);
        assert_eq!(prune_kind(&connection, "usage_history", "2026-10-05T01:00:00.001Z").unwrap(), 1);
        assert_eq!(count(&connection, "usage_history"), 1);
        assert!(prune_kind(&connection, "usage_history", "2026-02-31T01:00:00Z").is_err());
        assert!(canonical_timestamp(&connection, "2026-02-31T01:00:00Z").is_err());
        assert!(canonical_timestamp(&connection, "2026-10-05T01:00:00.000001Z").is_err());
    }

    #[test]
    fn schema_five_normalizes_existing_utc_seconds_without_changing_payloads() {
        let directory = TestDirectory::new();
        let legacy = directory.path("missing.json");
        let mut connection = open_database(&directory.path("history.sqlite3"), &legacy).unwrap();
        insert_record(&connection, &record("usage_history", "existing", "2026-10-05T01:00:00Z", 17)).unwrap();
        connection.execute("UPDATE history_records SET created_at='2026-10-05T01:00:00Z'", []).unwrap();
        connection.pragma_update(None, "user_version", 4).unwrap();
        connection.execute("DELETE FROM schema_migrations WHERE version=5", []).unwrap();
        migrate(&mut connection, &legacy).unwrap();
        migrate(&mut connection, &legacy).unwrap();
        let stored: (String, String) = connection.query_row("SELECT created_at,payload_json FROM history_records WHERE id='existing'", [],
            |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(stored.0, "2026-10-05T01:00:00.000Z");
        assert_eq!(serde_json::from_str::<Value>(&stored.1).unwrap()["value"], 17);
        assert_eq!(count(&connection, "usage_history"), 1);
    }

    fn count(connection: &Connection, kind: &str) -> i64 {
        connection.query_row("SELECT COUNT(*) FROM history_records WHERE kind=?1", [kind], |row| row.get(0)).unwrap()
    }

    #[test]
    fn migration_imports_legacy_json_once_and_preserves_the_source_file() {
        let directory = TestDirectory::new();
        let db = directory.path("history.sqlite3");
        let legacy = directory.path("history.json");
        let document = serde_json::json!({"records": [
            {"id":"event-1","kind":"system_events","createdAt":"2026-10-04T12:00:00.000Z","payload":{"eventId":41}},
            {"id":"vps-1","kind":"vps_history","createdAt":"2026-10-04T12:01:00.000Z","payload":{"cpu":14}}
        ]});
        fs::write(&legacy, serde_json::to_vec(&document).unwrap()).unwrap();

        let connection = open_database(&db, &legacy).unwrap();
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert_eq!(count(&connection, "system_events"), 1);
        assert_eq!(count(&connection, "vps_history"), 1);
        assert!(legacy.exists(), "migration must leave the source recoverable");
        drop(connection);

        let reopened = open_database(&db, &legacy).unwrap();
        assert_eq!(count(&reopened, "system_events"), 1);
        assert_eq!(count(&reopened, "vps_history"), 1);
        assert_eq!(
            reopened.query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(),
            CURRENT_SCHEMA_VERSION,
        );
    }

    #[test]
    fn concurrent_startup_migrates_and_imports_legacy_records_once() {
        use std::sync::{Arc, Barrier};
        let directory = TestDirectory::new();
        let db = directory.path("history.sqlite3");
        let legacy = directory.path("history.json");
        fs::write(&legacy, br#"{"records":[{"id":"legacy-event","kind":"system_events","createdAt":"2026-10-05T00:00:00.000Z","payload":{}}]}"#).unwrap();
        let initialize = Connection::open(&db).unwrap();
        initialize.pragma_update(None, "journal_mode", "WAL").unwrap();
        drop(initialize);
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = (0..2).map(|_| {
            let db = db.clone(); let legacy = legacy.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let connection = open_database(&db, &legacy).unwrap();
                assert_eq!(count(&connection, "system_events"), 1);
            })
        }).collect();
        for worker in workers { worker.join().unwrap(); }
        let connection = open_database(&db, &legacy).unwrap();
        let migrations: i64 = connection.query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| row.get(0)).unwrap();
        assert_eq!(migrations, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn repository_upserts_state_rows_and_queries_new_history_kinds() {
        let directory = TestDirectory::new();
        let connection = open_database(&directory.path("history.sqlite3"), &directory.path("missing.json")).unwrap();
        insert_record(&connection, &record("widget_state", "layout", "2026-10-05T01:00:00.000Z", 1)).unwrap();
        insert_record(&connection, &record("widget_state", "layout", "2026-10-05T01:01:00.000Z", 2)).unwrap();
        insert_record(&connection, &record("hardware_history", "cpu-1", "2026-10-05T01:02:00.000Z", 30)).unwrap();
        assert_eq!(count(&connection, "widget_state"), 1);
        assert_eq!(count(&connection, "hardware_history"), 1);
        let payload: String = connection.query_row("SELECT payload_json FROM history_records WHERE kind='widget_state'", [], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&payload).unwrap()["value"], 2);
    }

    #[test]
    fn application_history_has_indexed_range_reads_idempotent_writes_and_scoped_retention() {
        let directory = TestDirectory::new();
        let mut connection = open_database(&directory.path("history.sqlite3"), &directory.path("missing.json")).unwrap();
        insert_record(&connection, &record("application_history", "shared", "2026-10-06T03:01:00.000Z", 1)).unwrap();
        insert_record(&connection, &record("application_history", "shared", "2026-10-06T03:04:00.000Z", 20)).unwrap();
        insert_record(&connection, &record("application_history", "second", "2026-10-06T03:05:00.000Z", 30)).unwrap();
        insert_record(&connection, &record("application_history", "at-end", "2026-10-06T03:10:00.000Z", 40)).unwrap();
        insert_record(&connection, &record("application_history", "old", "2000-01-01T00:00:00.000Z", 0)).unwrap();
        insert_record(&connection, &record("hardware_history", "shared", "2000-01-01T00:00:00.000Z", 99)).unwrap();
        insert_record(&connection, &record("widget_state", "layout", "2000-01-01T00:00:00.000Z", 2)).unwrap();
        assert_eq!(count(&connection, "application_history"), 4);
        let range = query_range(&mut connection, "application_history", "2026-10-06T03:00:00.000Z", "2026-10-06T03:10:00.000Z", 1).unwrap();
        assert_eq!(range.total_count, 2);
        assert_eq!(range.records[0].id, "second");
        assert!(range.truncated);
        let complete = query_range(&mut connection, "application_history", "2026-10-06T03:00:00.000Z", "2026-10-06T03:10:00.000Z", 10).unwrap();
        assert_eq!(complete.records.iter().map(|record| record.payload["value"].as_i64().unwrap()).collect::<Vec<_>>(), vec![30, 20]);
        assert!(!complete.truncated);
        let columns: Vec<String> = {
            let mut statement = connection.prepare("PRAGMA index_info(history_by_kind_created)").unwrap();
            statement.query_map([], |row| row.get(2)).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(columns, vec!["kind", "created_at"]);
        assert_eq!(prune_kind(&connection, "application_history", "2026-10-06T03:04:00.000Z").unwrap(), 1);
        assert_eq!(count(&connection, "hardware_history"), 1);
        assert_eq!(count(&connection, "application_history"), 3);
        assert!(RETENTION_DAYS.contains(&("application_history", 180)));
        insert_record(&connection, &record("application_history", "expired", "2000-01-01T00:00:00.000Z", 3)).unwrap();
        connection.execute("UPDATE maintenance_state SET completed_at=0 WHERE key='retention-prune'", []).unwrap();
        prune_expired_if_due(&mut connection).unwrap();
        assert_eq!(count(&connection, "application_history"), 3);
        assert_eq!(count(&connection, "widget_state"), 1);
        let after = query_range(&mut connection, "application_history", "2026-10-06T03:00:00.000Z", "2026-10-06T03:11:00.000Z", 10).unwrap();
        assert_eq!(after.records.len(), 3);
    }

    #[test]
    fn explicit_pruning_is_kind_scoped_and_retention_cleanup_is_defined_per_series() {
        let directory = TestDirectory::new();
        let connection = open_database(&directory.path("history.sqlite3"), &directory.path("missing.json")).unwrap();
        insert_record(&connection, &record("hardware_history", "old", "2026-10-01T00:00:00.000Z", 1)).unwrap();
        insert_record(&connection, &record("hardware_history", "new", "2026-10-05T00:00:00.000Z", 2)).unwrap();
        insert_record(&connection, &record("system_events", "event", "2026-10-01T00:00:00.000Z", 3)).unwrap();
        assert_eq!(prune_kind(&connection, "hardware_history", "2026-10-03T00:00:00.000Z").unwrap(), 1);
        assert_eq!(count(&connection, "hardware_history"), 1);
        assert_eq!(count(&connection, "system_events"), 1);
        assert!(RETENTION_DAYS.iter().any(|(kind, days)| *kind == "hardware_history" && *days == 30));
        assert!(prune_kind(&connection, "widget_state", "2026-10-03T00:00:00.000Z").is_err());
    }

    #[test]
    fn scheduled_retention_pruning_removes_expired_series_but_keeps_widget_state() {
        let directory = TestDirectory::new();
        let mut connection = open_database(&directory.path("history.sqlite3"), &directory.path("missing.json")).unwrap();
        insert_record(&connection, &record("hardware_history", "old-hardware", "2000-01-01T00:00:00.000Z", 1)).unwrap();
        insert_record(&connection, &record("system_events", "old-event", "2000-01-01T00:00:00.000Z", 2)).unwrap();
        insert_record(&connection, &record("widget_state", "layout", "2000-01-01T00:00:00.000Z", 3)).unwrap();
        connection.execute("UPDATE maintenance_state SET completed_at=0 WHERE key='retention-prune'", []).unwrap();

        prune_expired_if_due(&mut connection).unwrap();
        assert_eq!(count(&connection, "hardware_history"), 0);
        assert_eq!(count(&connection, "system_events"), 0);
        assert_eq!(count(&connection, "widget_state"), 1);
    }
}
