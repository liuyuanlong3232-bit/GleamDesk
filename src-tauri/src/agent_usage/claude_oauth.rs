// Claude Code 订阅额度：官方账号的 OAuth 用量端点。
// 与开源实现一致（claude-code-usage-monitor / ai-agent-usage-monitor）：
// 读取本机 Claude Code 登录后写入的 accessToken，只发一次只读 GET。
// 令牌只在内存中出现一次，不写日志、不落盘、不进入错误信息。
use super::*;

const HOST: &str = "api.anthropic.com";
const USAGE_PATH: &str = "/api/oauth/usage";

fn bounded(path: &std::path::Path, cap: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(cap + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > cap { return None; }
    Some(bytes)
}

/// 只映射端点真实给出的窗口：five_hour / seven_day，以及按模型细分的 limits[]。
/// 名称与时长不猜测；未知窗口名一律原样保留在 title 里。
pub(crate) fn usage_windows(root: &Value) -> Vec<UsageWindow> {
    let mut rows = Vec::new();
    for (key, title, minutes) in [("five_hour", "5 小时额度", 300u64), ("seven_day", "周额度", 10080u64)] {
        let Some(entry) = root.get(key).filter(|value| value.is_object()) else { continue };
        let Some(used) = valid_percent(&entry["utilization"]) else { continue };
        rows.push(UsageWindow {
            id: key.into(), title: Some(title.into()), used_percent: used,
            window_duration_mins: Some(minutes), resets_at_unix_ms: timestamp_ms(&entry["resets_at"]),
        });
    }
    if let Some(items) = root.get("limits").and_then(Value::as_array) {
        let mut seen = std::collections::HashSet::new();
        for item in items.iter().take(8) {
            let Some(percent) = valid_percent(&item["percent"]) else { continue };
            let name = item["scope"]["model"]["display_name"].as_str()
                .or_else(|| item["scope"]["model"]["id"].as_str())
                .filter(|name| !name.is_empty()).unwrap_or("模型");
            let id = format!("scoped:{name}");
            if !seen.insert(id.clone()) { continue; }
            rows.push(UsageWindow {
                id, title: Some(format!("{name} · 周额度")), used_percent: percent,
                window_duration_mins: Some(10080), resets_at_unix_ms: timestamp_ms(&item["resets_at"]),
            });
        }
    }
    rows.truncate(6);
    rows
}

pub(super) fn read() -> AgentObservation {
    let mut result = account("claude", "Claude Code");
    result.source = "claude-oauth-usage";
    let home = match std::env::var_os("USERPROFILE").map(PathBuf::from)
        .filter(|path| path.is_absolute() && !path.to_string_lossy().starts_with("\\\\")) {
        Some(home) => home, None => return result,
    };
    let path = home.join(".claude").join(".credentials.json");
    result.installed = path.is_file();
    if !result.installed { result.reason = "not-installed"; result.login_status = "not-logged-in"; return result }
    let Some(bytes) = bounded(&path, 256 * 1024) else { result.reason = "read-failed"; return result };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { result.reason = "read-failed"; return result };
    let oauth = &value["claudeAiOauth"];
    if let Some(plan) = oauth["subscriptionType"].as_str().filter(|plan| !plan.is_empty()) { result.plan = Some(plan.to_string()) }
    let token = oauth["accessToken"].as_str()
        .filter(|token| !token.is_empty() && token.len() <= 8192 && token.bytes().all(|byte| byte.is_ascii_graphic()));
    let Some(token) = token else { result.login_status = "not-logged-in"; result.reason = "not-logged-in"; return result };
    let expires = oauth["expiresAt"].as_u64().or_else(|| oauth["expiresAt"].as_f64().map(|value| value as u64));
    if expires.is_some_and(|at| at <= observed_unix_ms()) { result.login_status = "not-logged-in"; result.reason = "expired"; return result }
    result.login_status = "configured";
    let headers = crate::credentials::Secret::from_string(format!(
        "Authorization: Bearer {token}\r\nAccept: application/json\r\nanthropic-beta: oauth-2025-04-20\r\n"));
    match crate::http::vps_service_get(HOST, 443, true, USAGE_PATH, headers.as_str(), &|| Ok(())) {
        Ok((200, mut body)) => {
            let parsed = serde_json::from_slice::<Value>(&body); body.fill(0);
            match parsed {
                Ok(value) => {
                    let rows = usage_windows(&value);
                    if rows.is_empty() { result.reason = "quota-unavailable" } else { result.windows = rows; finish_quota(&mut result, "claude-oauth-usage") }
                }
                Err(_) => result.reason = "read-failed",
            }
        }
        Ok((401 | 403, _)) => { result.login_status = "not-logged-in"; result.reason = "not-logged-in" }
        Ok((429, _)) => result.reason = "rate-limited",
        _ => result.reason = "read-failed",
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn five_hour_and_weekly_are_mapped_without_guessing() {
        let rows = usage_windows(&serde_json::json!({
            "five_hour": { "utilization": 12.5, "resets_at": "2026-11-07T12:00:00Z" },
            "seven_day": { "utilization": 40 },
            "nimbus_quill": { "utilization": 90 }
        }));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "five_hour");
        assert_eq!(rows[0].window_duration_mins, Some(300));
        assert!(rows[0].resets_at_unix_ms.is_some());
        assert_eq!(rows[1].window_duration_mins, Some(10080));
    }
    #[test]
    fn malformed_percent_is_skipped_instead_of_zeroed() {
        let rows = usage_windows(&serde_json::json!({
            "five_hour": { "utilization": 101 },
            "seven_day": { "utilization": "40" }
        }));
        assert!(rows.is_empty());
    }
    #[test]
    fn scoped_model_limits_are_kept_and_deduplicated() {
        let rows = usage_windows(&serde_json::json!({
            "limits": [
                { "kind": "weekly_scoped", "percent": 70, "scope": { "model": { "display_name": "Opus" } } },
                { "kind": "weekly_scoped", "percent": 80, "scope": { "model": { "display_name": "Opus" } } }
            ]
        }));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].used_percent, 70.0);
        assert!(rows[0].title.as_deref().is_some_and(|title| title.contains("Opus")));
    }
}
