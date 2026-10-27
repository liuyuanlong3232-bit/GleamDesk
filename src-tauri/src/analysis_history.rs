// Native recheck of the exact evidence sent by the first-party analysis view.
// The database contains provider history, not arbitrary plugin supplied claims.
use crate::storage::{self, HistoryRecord};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

fn invalid() -> String { "历史批次已变化、过期或未通过原生完整性检查，请重新生成本地报告".into() }
fn string(value: &Value) -> &str { value.as_str().unwrap_or("") }
fn text(value: &Value, limit: usize) -> String {
    // Match the frontend's UTF-16 length cap. Rejecting a split surrogate is safer than sending it.
    let cleaned: String = string(value).chars().map(|c| if c <= '\u{1f}' || c == '\u{7f}' { ' ' } else { c }).collect();
    String::from_utf16_lossy(&cleaned.encode_utf16().take(limit).collect::<Vec<_>>())
}
fn numeric(value: &Value, max: f64) -> Option<f64> { value.as_f64().filter(|n| n.is_finite() && *n >= 0.0 && *n <= max) }
fn add(metrics: &mut Vec<Value>, key: String, label: String, unit: &str, value: &Value, max: f64) {
    if let Some(n) = numeric(value, max) {
        if !metrics.iter().any(|metric| metric["key"] == key) { metrics.push(json!({"key":key,"label":label,"unit":unit,"value":n})); }
    }
}
pub(crate) fn utc_ms(connection: &Connection, at: &str) -> Result<i64, String> {
    if at.len() != 24 || !at.is_ascii() || !at.ends_with('Z') { return Err(invalid()); }
    let (canonical, millis): (Option<String>, Option<i64>) = connection.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ',julianday(?1)), CAST(unixepoch(?1)*1000+substr(?1,21,3) AS INTEGER)",
        [at], |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|_| invalid())?;
    if canonical.as_deref() != Some(at) { return Err(invalid()); }
    millis.ok_or_else(invalid)
}
pub(crate) fn utc_at(connection: &Connection, millis: i64) -> Result<String, String> {
    connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ',?1/1000.0,'unixepoch')", [millis], |row| row.get(0)).map_err(|_| invalid())
}
fn payload_time(connection: &Connection, value: &Value) -> Option<i64> {
    let at = string(value);
    if !at.is_ascii() { return None; }
    let canonical = if at.len() == 20 { format!("{}.000Z", &at[..19]) } else { at.to_string() };
    utc_ms(connection, &canonical).ok()
}
fn kind(source: &str) -> Option<&'static str> {
    match source { "hardware" => Some("hardware_history"), "system" => Some("system_events"), "vps" => Some("vps_history"), "api" => Some("usage_history"), _ => None }
}
fn raw_time(connection: &Connection, record: &HistoryRecord, source: &str) -> Option<i64> {
    match source {
        "hardware" => numeric(&record.payload["sampledAtUnixMs"], 9_007_199_254_740_991.0).map(|n| n as i64),
        "system" => payload_time(connection, &record.payload["timestamp"]),
        "vps" => if record.payload["schemaVersion"].as_f64() == Some(2.0) { payload_time(connection, &record.payload["observation"]["observedAt"]) }
            else { payload_time(connection, &record.payload["snapshot"]["lastUpdated"]) },
        _ => utc_ms(connection, &record.created_at).ok(),
    }
}
fn normalize(connection: &Connection, record: &HistoryRecord, source: &str) -> Option<Value> {
    if Some(record.kind.as_str()) != kind(source) || record.id.is_empty() || record.id.encode_utf16().count() > 160 { return None; }
    let p = &record.payload;
    if p["simulation"] == true { return None; }
    let provider = text(&p["provenance"]["providerId"], 160);
    let expected = match source { "hardware" => vec!["hardware-status"], "system" => vec!["windows-health"], "vps" => vec!["vps-status"], _ => vec!["api-deepseek", "api-anthropic"] };
    let provider = if p["provenance"]["schemaVersion"] == 1 && p["provenance"]["mode"] == "live" && expected.contains(&provider.as_str()) { provider }
        else if source == "api" && p["schemaVersion"] == 1 && p["simulation"] == false && ["deepseek", "anthropic"].contains(&string(&p["source"])) { format!("api-{}", string(&p["source"])) }
        else { return None; };
    let at = raw_time(connection, record, source)?;
    if at < 0 { return None; }
    let mut metrics = Vec::new();
    let mut event = None;
    let mut url = None;
    let max = 9_007_199_254_740_991.0;
    if source == "hardware" {
        if p["cpu"]["usageStatus"] == "available" { add(&mut metrics, "hardware.cpu".into(), "本机 CPU".into(), "%", &p["cpu"]["usagePercent"], 100.0); }
        if p["memory"]["status"] == "available" { add(&mut metrics, "hardware.memory".into(), "本机内存占用".into(), "%", &p["memory"]["usagePercent"], 100.0); }
        if p["network"]["status"] == "available" {
            add(&mut metrics, "hardware.upload".into(), "本机网络上传".into(), "B/s", &p["network"]["uploadBytesPerSecond"], max);
            add(&mut metrics, "hardware.download".into(), "本机网络下载".into(), "B/s", &p["network"]["downloadBytesPerSecond"], max);
        }
        if p["disks"]["status"] == "available" {
            for disk in p["disks"]["volumes"].as_array().into_iter().flatten().take(32) {
                let name = text(&disk["name"], 32);
                if !name.is_empty() && numeric(&disk["totalBytes"], max).is_some() && numeric(&disk["usedBytes"], max).is_some() && disk["usedBytes"].as_f64()? <= disk["totalBytes"].as_f64()? {
                    add(&mut metrics, format!("hardware.disk.{name}"), format!("本机磁盘 {name}"), "%", &disk["usagePercent"], 100.0);
                }
            }
        }
        let g = &p["gpu"];
        let name = text(&g["name"], 128); let name = if name.is_empty() { "GPU".to_string() } else { name };
        let status = |key: &str| if g[key].is_null() { &g["status"] } else { &g[key] };
        if status("usageStatus") == "available" { add(&mut metrics, format!("hardware.gpu.{name}"), format!("本机 {name}"), "%", &g["usagePercent"], 100.0); }
        if status("memoryStatus") == "available" {
            if let (Some(used), Some(total)) = (numeric(&g["memoryUsedBytes"], max), numeric(&g["memoryTotalBytes"], max)) {
                if total > 0.0 && used <= total { add(&mut metrics, format!("hardware.gpu-memory.{name}"), format!("{name} 显存占用"), "%", &json!(used / total * 100.0), 100.0); }
            }
        }
        if status("temperatureStatus") == "available" { add(&mut metrics, format!("hardware.gpu-temperature.{name}"), format!("{name} 温度"), "°C", &g["temperatureC"], 200.0); }
    } else if source == "system" {
        let id = numeric(&p["eventId"], 65_535.0)?;
        let src = text(&p["source"], 160);
        if id.fract() != 0.0 || src.is_empty() || !["critical", "error", "warning"].contains(&string(&p["severity"])) { return None; }
        event = Some(json!({"source":src,"eventId":id as u32,"severity":p["severity"],"message":text(&p["message"],512)}));
    } else if source == "vps" {
        let modern = p["schemaVersion"].as_f64() == Some(2.0);
        let snapshot = if modern { &p["observation"] } else { &p["snapshot"] };
        if modern && (snapshot["availability"] != "ready" || snapshot.get("error").is_some_and(|error| !error.is_null() && error != "")) { return None; }
        if !["online", "warning"].contains(&string(&snapshot["state"])) { return None; }
        let server = text(&p["serverId"], 80);
        // Use Tauri's existing URL parser; never issue a network call to a history URL.
        let raw = string(&p["hubUrl"]);
        if raw.len() > 2048 { return None; }
        let parsed = tauri::Url::parse(raw).ok()?;
        if !["http", "https"].contains(&parsed.scheme()) || !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() || server.is_empty() { return None; }
        let hub = format!("{}{}", parsed.origin().ascii_serialization(), parsed.path().trim_end_matches('/'));
        let identity = serde_json::to_string(&[&hub, &server]).ok()?;
        let gauges = if modern { vec![json!({"label":"CPU","value":snapshot["cpuPercent"]}), json!({"label":"内存","value":snapshot["memoryPercent"]}), json!({"label":"硬盘","value":snapshot["diskPercent"]})] }
            else { snapshot["gauges"].as_array()?.iter().take(16).cloned().collect() };
        for gauge in &gauges {
            let label = text(&gauge["label"],40);
            if ["CPU", "内存", "硬盘"].contains(&label.as_str()) { add(&mut metrics, format!("vps.{identity}.{label}"), format!("{server} · {} {label}", text(&json!(hub),128)), "%", &gauge["value"],100.0); }
        }
        url = Some(hub);
    } else {
        let accounts = p["accounts"].as_array()?;
        if accounts.len() > 8 || p["simulation"] != false || string(&p["source"]) != &provider[4..] { return None; }
        let source_name = &provider[4..];
        for account in accounts {
            let id = text(&account["id"],80); let currency = text(&account["currency"],3);
            if id.is_empty() || !["CNY","USD"].contains(&currency.as_str()) || !["normal","warning","online"].contains(&string(&account["state"])) { continue; }
            if !payload_time(connection,&account["observedAt"]).is_some_and(|observed| (observed-at).abs() <= 1000) { continue; }
            let prefix = format!("api.{source_name}.{id}.{currency}");
            add(&mut metrics,format!("{prefix}.balance"),format!("{source_name} {currency} 余额快照"),&currency,&account["balance"],max);
            for (label, value_key, start_key, end_key, duration) in [("today","todayCost","todayPeriodStart","todayPeriodEnd",86_400_000),("month","monthCost","periodStart","periodEnd",i64::MAX)] {
                if let (Some(start),Some(end)) = (payload_time(connection,&account[start_key]),payload_time(connection,&account[end_key])) {
                    if end <= start || end-start > duration { continue; }
                    let start = utc_at(connection,start).ok()?; let end = utc_at(connection,end).ok()?;
                    let before = metrics.len();
                    add(&mut metrics,format!("{prefix}.{label}.{start}/{end}"),format!("{source_name} {currency} {}费用快照",if label == "today" { "当日" } else { "月累计" }),&currency,&account[value_key],max);
                    for metric in &mut metrics[before..] { metric["periodStart"] = json!(start); metric["periodEnd"] = json!(end); }
                }
            }
        }
        url = Some(if provider == "api-deepseek" { "https://api.deepseek.com/user/balance" } else { "https://api.anthropic.com/v1/organizations/cost_report" }.into());
    }
    if metrics.is_empty() && event.is_none() { return None; }
    let mut result = json!({"id":format!("{}:{}",record.kind,record.id),"recordId":record.id,"kind":record.kind,"source":source,"providerId":provider,"observedAt":utc_at(connection,at).ok()?,"metrics":metrics});
    if let Some(event) = event { result["event"] = event; }
    if let Some(url) = url { result["sourceUrl"] = json!(url); }
    Some(result)
}
pub(crate) fn verify_batch(connection: &mut Connection, batch: &Value, now: i64) -> Result<Value, String> {
    let request = &batch["request"];
    let from = utc_ms(connection,string(&request["from"]))?; let to = utc_ms(connection,string(&request["to"]))?;
    let generated = utc_ms(connection,string(&batch["generatedAt"]))?;
    if batch["schemaVersion"] != 1 || to <= from || to-from > 7*86_400_000 || to > now+1000 || generated < to-1000 || generated > now+1000 || now-generated > 120_000 { return Err(invalid()); }
    let sources = request["sources"].as_array().ok_or_else(invalid)?;
    if sources.is_empty() || sources.len() > 4 || sources.iter().map(string).collect::<HashSet<_>>().len() != sources.len() || sources.iter().any(|source| kind(string(source)).is_none()) { return Err(invalid()); }
    let zone = string(&request["timeZone"]);
    if zone.is_empty() || zone.len() > 64 { return Err(invalid()); }
    let submitted = batch["evidence"].as_array().ok_or_else(invalid)?;
    if submitted.is_empty() || submitted.len() > 256 { return Err(invalid()); }
    let mut evidence = Vec::new();
    for source in sources.iter().map(string) {
        let start = utc_at(connection,from-if source == "hardware" { 30_000 } else { 0 })?;
        let range = storage::query_range(connection,kind(source).unwrap(),&start,string(&request["to"]),1000)?;
        if range.truncated || range.total_count != range.records.len() { return Err(invalid()); }
        let mut accepted = Vec::new();
        for record in range.records {
            if raw_time(connection,&record,source).is_some_and(|at| at < from || at >= to) { continue; }
            let normalized = normalize(connection,&record,source).ok_or_else(invalid)?;
            accepted.push(normalized);
        }
        let latest = accepted.iter().filter_map(|item| utc_ms(connection,string(&item["observedAt"])).ok()).max().ok_or_else(invalid)?;
        let freshness = match source { "hardware" => 120_000, "system" => 7*86_400_000, _ => 600_000 };
        if now-latest > freshness {
            let name = match source { "hardware" => "本机硬件", "system" => "Windows 事件", "vps" => "VPS", _ => "API" };
            return Err(format!("{name}最新样本已过期，请重新生成本地报告后确认"));
        }
        evidence.extend(accepted);
    }
    // Match JavaScript's fixed UTF-16 ordinal ordering, including supplementary Unicode IDs.
    evidence.sort_by(|a,b| string(&a["observedAt"]).cmp(string(&b["observedAt"])).then_with(|| string(&a["id"]).encode_utf16().cmp(string(&b["id"]).encode_utf16())));
    // JSON numeric values compare with a tiny floating point tolerance, never an absolute rounding tolerance.
    if evidence.len() != submitted.len() || evidence.iter().zip(submitted).any(|(a,b)| !same(a,b)) || batch["actualFrom"] != evidence[0]["observedAt"] || batch["actualTo"] != evidence.last().unwrap()["observedAt"] { return Err(invalid()); }
    let hardware: Vec<i64> = evidence.iter().filter(|e| e["source"] == "hardware" && e["metrics"].as_array().unwrap().iter().any(|m| m["key"] == "hardware.cpu"))
        .map(|e| utc_ms(connection,string(&e["observedAt"]))).collect::<Result<_,_>>()?;
    if hardware.len() < 11 || hardware.last().unwrap()-hardware[0] < 300_000 || hardware.windows(2).any(|pair| pair[1]-pair[0] > 90_000)
        || (hardware.iter().map(|at| (at-from)/30_000).collect::<HashSet<_>>().len() as f64) / (((to-from) as f64/30_000.0).ceil().max(1.0)) < 0.8 { return Err(invalid()); }
    let candidates = batch["candidates"].as_array().ok_or_else(invalid)?;
    if candidates.is_empty() || candidates.len() > 128 { return Err(invalid()); }
    let mut groups: HashMap<String, Vec<(&Value,&Value)>> = HashMap::new();
    for item in &evidence { for metric in item["metrics"].as_array().unwrap() { groups.entry(string(&metric["key"]).into()).or_default().push((item,metric)); } }
    let known: HashMap<_,_> = evidence.iter().map(|item| (string(&item["id"]),item)).collect();
    let mut candidate_ids = HashSet::new();
    let mut safe_candidates = Vec::new();
    for candidate in candidates {
        let id = string(&candidate["id"]);
        if id.is_empty() || !candidate_ids.insert(id) { return Err(invalid()); }
        let refs = candidate["evidenceIds"].as_array().ok_or_else(invalid)?;
        if refs.is_empty() || refs.len() > 256 || refs.iter().map(string).collect::<HashSet<_>>().len() != refs.len() { return Err(invalid()); }
        if let Some(key) = id.strip_prefix("metric:") {
            let points = groups.get(key).ok_or_else(invalid)?;
            if candidate["kind"] != "metric-summary" || refs.len() != points.len() || refs.iter().zip(points).any(|(r,(item,_))| r != &item["id"]) { return Err(invalid()); }
            let values: Vec<f64> = points.iter().map(|(_,m)| m["value"].as_f64().unwrap()).collect();
            let metric = points[0].1;
            safe_candidates.push(json!({"id":id,"kind":"metric-summary","label":metric["label"],"unit":metric["unit"],"sampleCount":values.len(),
                "minimum":values.iter().copied().reduce(f64::min),"maximum":values.iter().copied().reduce(f64::max),"sampleMean":values.iter().map(|v| v/values.len() as f64).sum::<f64>(),
                "periodStart":metric["periodStart"],"periodEnd":metric["periodEnd"],"evidenceIds":refs}));
        } else {
            if candidate["kind"] != "time-proximity" || refs.len() != 2 || id != format!("proximity:{}|{}",string(&refs[0]),string(&refs[1])) { return Err(invalid()); }
            let a = known.get(string(&refs[0])).ok_or_else(invalid)?; let b = known.get(string(&refs[1])).ok_or_else(invalid)?;
            let distance = utc_ms(connection,string(&b["observedAt"]))?-utc_ms(connection,string(&a["observedAt"]))?;
            if a["event"].is_null() || b["event"].is_null() || a["event"]["source"] == b["event"]["source"] || !(0..=300_000).contains(&distance) { return Err(invalid()); }
            safe_candidates.push(json!({"id":id,"kind":"time-proximity","distanceMs":distance,"evidenceIds":refs,"uncertainty":"Time proximity does not establish causation."}));
        }
    }
    // Every metric must have its candidate; omitting evidence cannot narrow the apparent facts.
    if groups.keys().any(|key| !candidate_ids.contains(format!("metric:{key}").as_str())) { return Err(invalid()); }
    Ok(json!({"schemaVersion":1,"request":request,"actualFrom":batch["actualFrom"],"actualTo":batch["actualTo"],"evidence":evidence,"candidates":safe_candidates,
        "uncertainties":["Sample means are not time-weighted; missing data is not zero.","History does not prove current connectivity; selected events are not a full event log.","Time proximity does not establish causation."]}))
}
fn same(a: &Value, b: &Value) -> bool {
    match (a,b) {
        (Value::Number(a),Value::Number(b)) => match (a.as_f64(),b.as_f64()) { (Some(a),Some(b)) => (a-b).abs() <= 8.0*f64::EPSILON*a.abs().max(b.abs()).max(1.0), _ => false },
        (Value::Array(a),Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a,b)|same(a,b)),
        (Value::Object(a),Value::Object(b)) => a.len() == b.len() && a.iter().all(|(k,v)| b.get(k).is_some_and(|b|same(v,b))),
        _ => a == b,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection,Value,i64) {
        let fixture: Value = serde_json::from_str(include_str!("../../tests/fixtures/analysis-batch.json")).unwrap();
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE history_records(kind TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(kind,id));").unwrap();
        for record in fixture["records"].as_array().unwrap() {
            connection.execute("INSERT INTO history_records VALUES (?1,?2,?3,?4)",rusqlite::params![string(&record["kind"]),string(&record["id"]),string(&record["createdAt"]),record["payload"].to_string()]).unwrap();
        }
        let now = utc_ms(&connection,string(&fixture["generatedAt"])).unwrap();
        (connection,fixture["batch"].clone(),now)
    }
    #[test]
    fn frontend_batch_is_rebuilt_from_all_four_native_sources_and_stats() {
        let (mut db,batch,now) = fixture();
        let safe = verify_batch(&mut db,&batch,now).unwrap();
        assert_eq!(safe["evidence"].as_array().unwrap().len(),batch["evidence"].as_array().unwrap().len());
        assert!(safe["candidates"].as_array().unwrap().iter().any(|c|c["kind"] == "time-proximity"));
        assert!(safe["candidates"].as_array().unwrap().iter().any(|c|string(&c["id"]).contains(".today.")));
        assert!(safe["candidates"].as_array().unwrap().iter().any(|c|string(&c["id"]).contains("gpu-temperature")));
    }
    #[test]
    fn hardware_sample_expiry_precedes_the_reports_own_deadline() {
        let (mut db,batch,generated) = fixture();
        let latest = batch["evidence"].as_array().unwrap().iter()
            .filter(|item| item["source"] == "hardware")
            .map(|item| utc_ms(&db,string(&item["observedAt"])).unwrap()).max().unwrap();
        let expired = latest + 120_001;
        assert!(expired-generated < 120_000, "Source expiry must occur while report age is still valid");
        verify_batch(&mut db,&batch,expired-1).unwrap();
        assert_eq!(verify_batch(&mut db,&batch,expired).unwrap_err(),"本机硬件最新样本已过期，请重新生成本地报告后确认");
    }
    #[test]
    fn modern_vps_history_rebuilds_the_same_evidence_as_legacy_gauges() {
        let (mut db,batch,now) = fixture();
        let rows: Vec<(String,String)> = {
            let mut statement=db.prepare("SELECT id,payload_json FROM history_records WHERE kind='vps_history'").unwrap();
            let rows=statement.query_map([],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
            rows.map(Result::unwrap).collect()
        };
        assert!(!rows.is_empty());
        for (id,raw) in rows {
            let mut payload: Value=serde_json::from_str(&raw).unwrap();
            let snapshot=payload["snapshot"].clone();
            let value=|label:&str|snapshot["gauges"].as_array().unwrap().iter().find(|item|item["label"]==label).map(|item|item["value"].clone()).unwrap_or(Value::Null);
            payload["schemaVersion"]=json!(2);
            payload["observation"]=json!({"state":snapshot["state"],"availability":"ready","observedAt":snapshot["lastUpdated"],"cpuPercent":value("CPU"),"memoryPercent":value("内存"),"diskPercent":value("硬盘")});
            payload.as_object_mut().unwrap().remove("snapshot");
            db.execute("UPDATE history_records SET payload_json=?1 WHERE kind='vps_history' AND id=?2",rusqlite::params![payload.to_string(),id]).unwrap();
        }
        verify_batch(&mut db,&batch,now).unwrap();
        db.execute("UPDATE history_records SET payload_json=json_set(payload_json,'$.observation.error',json('false')) WHERE kind='vps_history'",[]).unwrap();
        assert!(verify_batch(&mut db,&batch,now).is_err());
    }

    #[test]
    fn native_rejects_forged_values_messages_references_missing_evidence_and_stale_batches() {
        let (mut db,batch,now) = fixture();
        let mut forged = batch.clone(); forged["evidence"][0]["metrics"][0]["value"] = json!(99.99);
        assert!(verify_batch(&mut db,&forged,now).is_err());
        let mut missing = batch.clone(); missing["evidence"].as_array_mut().unwrap().remove(0);
        assert!(verify_batch(&mut db,&missing,now).is_err());
        let mut refs = batch.clone(); refs["candidates"][0]["evidenceIds"][0] = json!("invented");
        assert!(verify_batch(&mut db,&refs,now).is_err());
        let mut message = batch.clone();
        let event = message["evidence"].as_array_mut().unwrap().iter_mut().find(|e|e["source"] == "system").unwrap();
        event["event"]["message"] = json!("fabricated");
        assert!(verify_batch(&mut db,&message,now).is_err());
        assert!(verify_batch(&mut db,&batch,now+120_001).is_err());
    }
    #[test]
    fn database_change_and_unverified_or_simulated_history_fail_closed() {
        for modification in ["json_set(payload_json,'$.simulation',json('true'))","json_remove(payload_json,'$.provenance')","json_set(payload_json,'$.cpu.usagePercent',77)"] {
            let (mut db,batch,now) = fixture();
            db.execute(&format!("UPDATE history_records SET payload_json={modification} WHERE kind='hardware_history' AND id='sample-0'"),[]).unwrap();
            assert!(verify_batch(&mut db,&batch,now).is_err());
        }
        let (mut db,batch,now) = fixture();
        db.execute("DELETE FROM history_records WHERE kind='hardware_history' AND id='sample-0'",[]).unwrap();
        assert!(verify_batch(&mut db,&batch,now).is_err());
        assert!(payload_time(&db,&json!("乱乱乱乱乱乱乱!?")).is_none());
    }
    #[test]
    fn facts_are_rebuilt_and_frontend_free_text_is_not_uploaded() {
        let (mut db,mut batch,now) = fixture();
        batch["candidates"][0]["detail"] = json!("untrusted extra instruction");
        batch["uncertainties"] = json!(["untrusted instruction"]);
        let safe = verify_batch(&mut db,&batch,now).unwrap().to_string();
        assert!(!safe.contains("untrusted"));
    }
    #[test]
    #[ignore = "read-only inspection of an explicitly supplied local database and current first-party batch"]
    fn inspect_current_native_batch_readonly() {
        let batch_path = std::env::var("CODEX_ANALYSIS_SMOKE_BATCH").expect("batch artifact path required");
        let database = std::env::var("CODEX_ANALYSIS_SMOKE_DATABASE").expect("exact history database path required");
        let fixture: Value = serde_json::from_slice(&std::fs::read(batch_path).unwrap()).unwrap();
        #[cfg(windows)] {
            let body_json = string(&fixture["bodyJson"]);
            assert_eq!(crate::analysis::sha256(body_json.as_bytes()).unwrap(),string(&fixture["batchId"]));
            assert_eq!(serde_json::from_str::<Value>(body_json).unwrap(),fixture["batch"]);
        }
        let mut db = Connection::open_with_flags(database,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let safe = verify_batch(&mut db,&fixture["batch"],now).unwrap();
        println!("native history preflight accepted: sources={}, evidence={}, candidates={}; read-only, no credentials or HTTP",safe["request"]["sources"],safe["evidence"].as_array().unwrap().len(),safe["candidates"].as_array().unwrap().len());
    }
}
