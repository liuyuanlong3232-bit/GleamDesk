// Cursor 额度：读取本机 Cursor 的登录令牌（SQLite 只读打开），再查用量端点。
// 与开源实现一致（ai-agent-usage-monitor / openusage）：
// state.vscdb 只读、WAL 不改写，令牌只在内存中使用一次，不写日志、不落盘。
// 这是非官方接口，字段随版本变化；解析不到就降级为「不支持」，绝不猜数字。
use super::*;

const HOST: &str = "api2.cursor.sh";
const SUMMARY_PATH: &str = "/auth/usage-summary";

fn number(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| value.as_str()?.parse().ok()).filter(|value| value.is_finite())
}

fn state_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from)
        .filter(|path| path.is_absolute() && !path.to_string_lossy().starts_with("\\\\"))?;
    Some(appdata.join("Cursor").join("User").join("globalStorage").join("state.vscdb"))
}

fn token(path: &std::path::Path) -> Result<String, &'static str> {
    let connection = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ).map_err(|_| "read-failed")?;
    let mut statement = connection
        .prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
        .map_err(|_| "read-failed")?;
    let stored = statement.query_row([], |row| row.get::<_, rusqlite::types::Value>(0))
        .map_err(|_| "not-logged-in")?;
    let text = match stored {
        rusqlite::types::Value::Text(text) => text,
        rusqlite::types::Value::Blob(bytes) => String::from_utf8(bytes).map_err(|_| "read-failed")?,
        _ => return Err("not-logged-in"),
    };
    if text.is_empty() || text.len() > 8192 || !text.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("not-logged-in");
    }
    Ok(text)
}

/// Cursor 的额度是「本计费周期已用百分比」，没有 5 小时或周窗口。
/// 实测（2026-11-07，free 账号）：`plan.limit` 为 0，只有 `totalPercentUsed` 有效，
/// 所以先取百分比，再退回 used/limit（企业席位的 `overall` 走后者）。
pub(crate) fn usage_windows(root: &Value) -> Vec<UsageWindow> {
    let reset = root["billingCycleEnd"].as_str()
        .map(|value| Value::String(value.to_string()))
        .and_then(|value| timestamp_ms(&value));
    let individual = &root["individualUsage"];
    let mut rows = Vec::new();
    for key in ["plan", "overall"] {
        let Some(entry) = individual.get(key).filter(|value| value.is_object()) else { continue };
        let percent = number(&entry["totalPercentUsed"])
            .filter(|value| (0.0..=100.0).contains(value))
            .or_else(|| {
                let limit = number(&entry["limit"]).filter(|value| *value > 0.0)?;
                Some(number(&entry["used"]).unwrap_or(0.0) / limit * 100.0)
            });
        let Some(percent) = percent else { continue };
        rows.push(UsageWindow {
            id: "cursor:plan".into(),
            title: Some("本月额度".into()),
            used_percent: percent.clamp(0.0, 100.0),
            window_duration_mins: None,
            resets_at_unix_ms: reset,
        });
        break;
    }
    if let Some(on_demand) = individual.get("onDemand").filter(|value| value.is_object()) {
        if on_demand["enabled"].as_bool().unwrap_or(false) {
            if let Some(limit) = number(&on_demand["limit"]).filter(|value| *value > 0.0) {
                let used = number(&on_demand["used"]).unwrap_or(0.0);
                rows.push(UsageWindow {
                    id: "cursor:on-demand".into(), title: Some("按需用量".into()),
                    used_percent: (used / limit * 100.0).clamp(0.0, 100.0),
                    window_duration_mins: None, resets_at_unix_ms: reset,
                });
            }
        }
    }
    rows
}

pub(super) fn read() -> AgentObservation {
    let mut result = account("cursor", "Cursor");
    result.source = "cursor-local-usage";
    result.cli_detected = executable("cursor.exe").is_some() || executable("cursor-agent.exe").is_some();
    let Some(path) = state_path() else { return result };
    if !path.is_file() { return result }
    result.installed = true;
    result.running = load_runtime().clients.iter().any(|client| client.id == "cursor");
    let token = match token(&path) {
        Ok(token) => token,
        Err(reason) => {
            result.reason = reason;
            if reason == "not-logged-in" { result.login_status = "not-logged-in" }
            return result;
        }
    };
    result.login_status = "configured";
    let headers = crate::credentials::Secret::from_string(format!(
        "Authorization: Bearer {token}\r\nAccept: application/json\r\n"));
    match crate::http::vps_service_get(HOST, 443, true, SUMMARY_PATH, headers.as_str(), &|| Ok(())) {
        Ok((200, mut body)) => {
            let parsed = serde_json::from_slice::<Value>(&body); body.fill(0);
            match parsed {
                Ok(value) => {
                    let rows = usage_windows(&value);
                    if rows.is_empty() { result.reason = "quota-unavailable" } else { result.windows = rows; finish_quota(&mut result, "cursor-local-usage") }
                }
                Err(_) => result.reason = "read-failed",
            }
        }
        Ok((401 | 403, _)) => { result.login_status = "not-logged-in"; result.reason = "not-logged-in" }
        Ok((404, _)) => result.reason = "quota-unavailable",
        _ => result.reason = "read-failed",
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn free_plan_uses_reported_percent_when_limit_is_zero() {
        // 实测形状：free 账号 limit=0，但 totalPercentUsed 有效。
        let rows = usage_windows(&serde_json::json!({
            "billingCycleEnd": "2026-11-13T04:18:32.537Z",
            "membershipType": "free",
            "individualUsage": {
                "plan": { "enabled": true, "used": 0, "limit": 0, "totalPercentUsed": 2.5,
                          "breakdown": { "included": 0, "bonus": 5, "total": 5 } },
                "onDemand": { "enabled": false, "used": 0, "limit": null }
            }
        }));
        assert_eq!(rows.len(), 1);
        assert!((rows[0].used_percent - 2.5).abs() < 0.001);
        assert_eq!(rows[0].id, "cursor:plan");
        assert_eq!(rows[0].window_duration_mins, None);
        assert!(rows[0].resets_at_unix_ms.is_some());
    }
    #[test]
    fn enterprise_overall_falls_back_to_used_over_limit_in_cents() {
        let rows = usage_windows(&serde_json::json!({
            "billingCycleEnd": "2026-12-01T00:00:00Z",
            "individualUsage": { "overall": { "enabled": true, "used": 10948, "limit": 20000 } }
        }));
        assert_eq!(rows.len(), 1);
        assert!((rows[0].used_percent - 54.74).abs() < 0.01);
    }
    #[test]
    fn missing_limit_and_percent_is_not_reported_as_zero_usage() {
        assert!(usage_windows(&serde_json::json!({ "individualUsage": { "plan": { "used": 10 } } })).is_empty());
        assert!(usage_windows(&serde_json::json!({ "individualUsage": { "plan": { "used": 10, "limit": 0 } } })).is_empty());
    }
    #[test]
    fn on_demand_window_only_appears_when_enabled_with_a_limit() {
        let rows = usage_windows(&serde_json::json!({
            "individualUsage": {
                "plan": { "limit": 100, "used": 10 },
                "onDemand": { "enabled": true, "used": 500, "limit": 2000 }
            }
        }));
        assert_eq!(rows.len(), 2);
        assert!((rows[1].used_percent - 25.0).abs() < 0.001);
    }
}
