use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, time::{Duration, Instant}};
use tauri::Manager;
use crate::credentials::CredentialSource;
use crate::provider_requests::RequestCache;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiSource { Deepseek, Anthropic, Openai }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiAccount {
    id: String, name: String, state: &'static str, balance: Option<f64>, currency: String,
    today_cost: Option<f64>, month_cost: Option<f64>, observed_at: String,
    source_url: &'static str, period_start: Option<String>, period_end: Option<String>,
    today_period_start: Option<String>, today_period_end: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSnapshot { accounts: Vec<ApiAccount>, observed_at: String }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiFailure { code: &'static str, message: String, retryable: bool }
type ApiResult<T> = Result<T, ApiFailure>;
fn failure(code: &'static str, message: impl Into<String>, retryable: bool) -> ApiFailure { ApiFailure { code, message: message.into(), retryable } }
fn invalid(message: &'static str) -> ApiFailure { failure("invalid_response", message, false) }

#[derive(Default)]
pub struct ApiUsageState {
    deepseek: RequestCache<u64, ApiSnapshot, ApiFailure>,
    anthropic: RequestCache<u64, ApiSnapshot, ApiFailure>,
    openai: RequestCache<u64, ApiSnapshot, ApiFailure>,
}
impl ApiUsageState {
    pub fn metrics(&self) -> [Option<crate::provider_requests::RequestMetrics>; 3] { [self.deepseek.metrics(), self.anthropic.metrics(), self.openai.metrics()] }
}

fn decimal(value: &Value) -> ApiResult<f64> {
    let text = value.as_str().ok_or_else(|| invalid("费用接口缺少金额字符串"))?;
    if text.is_empty() || text.len() > 48 || !text.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.' || byte == b'-') {
        return Err(invalid("费用接口返回了无效金额"));
    }
    text.parse::<f64>().ok().filter(|number| number.is_finite()).ok_or_else(|| invalid("费用接口返回了无效金额"))
}

fn parse_deepseek(body: &[u8], observed_at: &str) -> ApiResult<ApiSnapshot> {
    let root: Value = serde_json::from_slice(body).map_err(|_| invalid("DeepSeek 余额响应格式无效"))?;
    let available = root.get("is_available").and_then(Value::as_bool).ok_or_else(|| invalid("DeepSeek 未返回余额状态"))?;
    let balances = root.get("balance_infos").and_then(Value::as_array).filter(|items| !items.is_empty() && items.len() <= 2)
        .ok_or_else(|| invalid("DeepSeek 未返回可读取的币种余额"))?;
    let mut currencies = HashSet::new();
    let mut accounts = Vec::new();
    for item in balances {
        let currency = item.get("currency").and_then(Value::as_str).filter(|value| matches!(*value, "CNY" | "USD"))
            .ok_or_else(|| invalid("DeepSeek 返回了未知币种"))?;
        if !currencies.insert(currency) { return Err(invalid("DeepSeek 返回了重复币种")); }
        let balance = decimal(item.get("total_balance").unwrap_or(&Value::Null))?;
        if balance < 0.0 { return Err(invalid("DeepSeek 返回了无效余额")); }
        accounts.push(ApiAccount {
            id: if balances.len() == 1 { "deepseek".into() } else { format!("deepseek-{}", currency.to_ascii_lowercase()) },
            name: if balances.len() == 1 { "DeepSeek".into() } else { format!("DeepSeek · {currency}") },
            state: if available { "normal" } else { "warning" }, balance: Some(balance), currency: currency.into(),
            today_cost: None, month_cost: None, observed_at: observed_at.into(),
            source_url: "https://api.deepseek.com/user/balance", period_start: None, period_end: None,
            today_period_start: None, today_period_end: None,
        });
    }
    Ok(ApiSnapshot { accounts, observed_at: observed_at.into() })
}

fn utc_midnight(value: &str) -> ApiResult<String> {
    let body = value.strip_suffix('Z').or_else(|| value.strip_suffix("+00:00")).ok_or_else(|| invalid("费用桶时区不是 UTC"))?;
    let (date, time) = body.split_once('T').ok_or_else(|| invalid("费用桶时间格式无效"))?;
    if date.len() != 10 || date.as_bytes()[4] != b'-' || date.as_bytes()[7] != b'-'
        || !date.bytes().enumerate().all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
        || !(time == "00:00:00" || time.strip_prefix("00:00:00.").is_some_and(|fraction| !fraction.is_empty() && fraction.bytes().all(|byte| byte == b'0'))) {
        return Err(invalid("费用桶不是完整 UTC 日桶"));
    }
    Ok(format!("{date}T00:00:00Z"))
}

fn parse_cost_page(body: &[u8], month_start: &str, today_start: &str, ending_at: &str, seen: &mut HashSet<String>) -> ApiResult<(f64, f64, Option<String>)> {
    let root: Value = serde_json::from_slice(body).map_err(|_| invalid("Anthropic 费用响应格式无效"))?;
    let buckets = root.get("data").and_then(Value::as_array).ok_or_else(|| invalid("Anthropic 缺少费用桶"))?;
    let mut month = 0.0;
    let mut today = 0.0;
    for bucket in buckets {
        let start = utc_midnight(bucket.get("starting_at").and_then(Value::as_str).ok_or_else(|| invalid("Anthropic 费用桶缺少时间"))?)?;
        let end = utc_midnight(bucket.get("ending_at").and_then(Value::as_str).ok_or_else(|| invalid("Anthropic 费用桶缺少结束时间"))?)?;
        // Requests and buckets use UTC midnight; reject partial or out-of-range reports.
        if start.as_str() < month_start || start.as_str() >= ending_at || end <= start || end.as_str() > ending_at || !seen.insert(start.clone()) {
            return Err(invalid("Anthropic 返回了请求范围外的费用桶"));
        }
        let rows = bucket.get("results").and_then(Value::as_array).ok_or_else(|| invalid("Anthropic 缺少费用条目"))?;
        for row in rows {
            if row.get("currency").and_then(Value::as_str) != Some("USD") { return Err(invalid("Anthropic 费用币种不是 USD")); }
            let usd = decimal(row.get("amount").unwrap_or(&Value::Null))? / 100.0;
            month += usd;
            if start.as_str() >= today_start { today += usd; }
        }
    }
    if !month.is_finite() || !today.is_finite() { return Err(invalid("Anthropic 费用合计无效")); }
    let has_more = root.get("has_more").and_then(Value::as_bool).ok_or_else(|| invalid("Anthropic 缺少分页状态"))?;
    let next = if has_more {
        Some(root.get("next_page").and_then(Value::as_str).filter(|value| !value.is_empty() && value.len() <= 512)
            .ok_or_else(|| invalid("Anthropic 费用分页游标无效"))?.to_string())
    } else { None };
    Ok((month, today, next))
}

#[cfg(windows)]
fn utc_period() -> ApiResult<(String, String, String, String)> {
    use windows_sys::Win32::{Foundation::{FILETIME, SYSTEMTIME}, System::{Time::FileTimeToSystemTime, SystemInformation::GetSystemTimeAsFileTime}};
    let mut file: FILETIME = unsafe { std::mem::zeroed() };
    unsafe { GetSystemTimeAsFileTime(&mut file); }
    let mut time: SYSTEMTIME = unsafe { std::mem::zeroed() };
    if unsafe { FileTimeToSystemTime(&file, &mut time) } == 0 { return Err(failure("clock", "无法读取费用报告的 UTC 时间", false)); }
    let today = format!("{:04}-{:02}-{:02}T00:00:00Z", time.wYear, time.wMonth, time.wDay);
    let month = format!("{:04}-{:02}-01T00:00:00Z", time.wYear, time.wMonth);
    let observed = format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond);
    // Both boundaries come from one observation, including at UTC midnight.
    let ticks = ((file.dwHighDateTime as u64) << 32 | file.dwLowDateTime as u64) + 86400 * 10_000_000;
    let tomorrow_file = FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 };
    let mut tomorrow: SYSTEMTIME = unsafe { std::mem::zeroed() };
    if unsafe { FileTimeToSystemTime(&tomorrow_file, &mut tomorrow) } == 0 { return Err(failure("clock", "无法计算费用报告的 UTC 范围", false)); }
    let ending = format!("{:04}-{:02}-{:02}T00:00:00Z", tomorrow.wYear, tomorrow.wMonth, tomorrow.wDay);
    Ok((month, today, ending, observed))
}

fn percent_encode(value: &str) -> String {
    value.bytes().map(|byte| if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) { (byte as char).to_string() } else { format!("%{byte:02X}") }).collect()
}

#[cfg(windows)]
fn request(host: &str, path: &str, headers: &str) -> ApiResult<Vec<u8>> {
    let (status, body) = crate::http::get(host, 443, true, path, headers).map_err(|_| failure("network", "费用服务连接失败或超时", true))?;
    if !(200..300).contains(&status) {
        let (code, message, retryable) = match status {
            401 | 403 => ("authentication", "凭据无效或缺少报告读取权限", false),
            429 => ("rate_limit", "服务限制请求频率，请稍后重试", true),
            300..=399 => ("redirect", "费用接口返回了重定向，请核对官方地址", false),
            500..=599 => ("service", "费用服务暂时不可用", true),
            _ => ("request", "费用接口拒绝了请求", false),
        };
        return Err(failure(code, format!("{message}（HTTP {status}）"), retryable));
    }
    Ok(body)
}

#[cfg(windows)]
fn fetch(source: ApiSource) -> ApiResult<ApiSnapshot> {
    let credential = match source { ApiSource::Deepseek => CredentialSource::Deepseek, ApiSource::Anthropic => CredentialSource::Anthropic, ApiSource::Openai => CredentialSource::Openai };
    let secret = crate::credentials::read(credential).map_err(|_| failure("credential", "尚未配置或无法读取服务凭据", false))?;
    let (month_start, today_start, ending, observed) = utc_period()?;
    match source {
        ApiSource::Openai => fetch_openai(secret.as_str(),month_start,today_start,ending,observed),
        ApiSource::Deepseek => {
            let body = request("api.deepseek.com", "/user/balance", &format!("Authorization: Bearer {}\r\nAccept: application/json\r\n", secret.as_str()))?;
            parse_deepseek(&body, &observed)
        }
        ApiSource::Anthropic => {
            let headers = format!("x-api-key: {}\r\nanthropic-version: 2023-06-01\r\nAccept: application/json\r\n", secret.as_str());
            let base = format!("/v1/organizations/cost_report?starting_at={}&ending_at={}&bucket_width=1d&limit=31", percent_encode(&month_start), percent_encode(&ending));
            let started = Instant::now();
            let mut path = base.clone();
            let mut cursors = HashSet::new();
            let mut seen_buckets = HashSet::new();
            let mut total = (0.0, 0.0);
            let mut complete = false;
            for _ in 0..4 {
                if started.elapsed() > Duration::from_secs(40) { return Err(failure("timeout", "费用报告读取超时；未展示不完整合计", false)); }
                let body = request("api.anthropic.com", &path, &headers)?;
                let (month, today, next) = parse_cost_page(&body, &month_start, &today_start, &ending, &mut seen_buckets)?;
                total.0 += month; total.1 += today;
                if let Some(cursor) = next {
                    if !cursors.insert(cursor.clone()) { return Err(invalid("费用分页重复；未展示不完整合计")); }
                    path = format!("{base}&page={}", percent_encode(&cursor));
                } else { complete = true; break; }
            }
            if !complete { return Err(invalid("费用报告超过分页上限；未展示不完整合计")); }
            Ok(ApiSnapshot { observed_at: observed.clone(), accounts: vec![ApiAccount {
                id: "anthropic".into(), name: "Anthropic API".into(), state: "normal", balance: None, currency: "USD".into(),
                today_cost: Some(total.1), month_cost: Some(total.0), observed_at: observed,
                source_url: "https://api.anthropic.com/v1/organizations/cost_report", period_start: Some(month_start), period_end: Some(ending.clone()),
                today_period_start: Some(today_start), today_period_end: Some(ending),
            }] })
        }
    }
}

#[tauri::command]
pub async fn read_api_usage(app: tauri::AppHandle, source: ApiSource) -> ApiResult<ApiSnapshot> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ApiUsageState>();
        let cache = match source { ApiSource::Deepseek => &state.deepseek, ApiSource::Anthropic => &state.anthropic, ApiSource::Openai => &state.openai };
        let revision = crate::credentials::revision();
        cache.read(revision, Duration::from_secs(60), Duration::from_secs(10), || {
            #[cfg(windows)] { fetch(source) }
            #[cfg(not(windows))] { Err(failure("unsupported", "费用读取仅支持 Windows 桌面版本", false)) }
        })
    }).await.map_err(|_| failure("internal", "费用读取任务失败", false))?
}

impl Clone for ApiFailure { fn clone(&self) -> Self { Self { code: self.code, message: self.message.clone(), retryable: self.retryable } } }
impl From<String> for ApiFailure { fn from(message: String) -> Self { failure("internal", message, false) } }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn shared_api_cache_preserves_failure_class_and_invalidates_on_credential_revision() {
        let state = ApiUsageState::default();
        let ttl = Duration::from_secs(60);
        let first = state.deepseek.read(1, ttl, Duration::from_secs(10), || Err(failure("authentication", "缺少读取权限", false))).unwrap_err();
        assert_eq!(first.code, "authentication");
        let shared = state.deepseek.read(1, ttl, Duration::from_secs(10), || panic!("cached failure")).unwrap_err();
        assert_eq!(shared.code, "authentication");
        assert!(!shared.retryable);
        let fresh = state.deepseek.read(2, ttl, Duration::from_secs(10), || parse_deepseek(br#"{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"7.45"}]}"#, "2026-10-06T00:00:00Z")).unwrap();
        assert_eq!(fresh.accounts[0].balance, Some(7.45));
    }
    #[test]
    fn deepseek_keeps_currencies_separate_and_costs_unknown() {
        let body = serde_json::to_vec(&json!({"is_available": true, "balance_infos": [{"currency":"CNY","total_balance":"110.00"},{"currency":"USD","total_balance":"2.50"}]})).unwrap();
        let snapshot = parse_deepseek(&body, "2026-10-05T00:00:00Z").unwrap();
        assert_eq!(snapshot.accounts[0].balance, Some(110.0));
        assert_eq!(snapshot.accounts[1].currency, "USD");
        assert!(snapshot.accounts.iter().all(|account| account.today_cost.is_none() && account.month_cost.is_none()));
        assert!(snapshot.accounts.iter().all(|account| serde_json::to_value(account).unwrap().get("detail").is_none()));
        assert_ne!(snapshot.accounts[0].id, snapshot.accounts[1].id);
        assert!(parse_deepseek(br#"{"balance_infos":[]}"#, "now").is_err());
    }
    #[test]
    fn costs_convert_fractional_cents_to_usd_and_split_utc_day() {
        let body = serde_json::to_vec(&json!({"data":[
            {"starting_at":"2026-10-01T00:00:00Z","ending_at":"2026-10-02T00:00:00Z","results":[{"currency":"USD","amount":"200"}]},
            {"starting_at":"2026-10-05T00:00:00Z","ending_at":"2026-10-06T00:00:00Z","results":[{"currency":"USD","amount":"123.78912"}]}
        ],"has_more":false,"next_page":null})).unwrap();
        let mut seen = HashSet::new();
        let (month, today, next) = parse_cost_page(&body, "2026-10-01T00:00:00Z", "2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z", &mut seen).unwrap();
        assert!((today - 1.2378912).abs() < 1e-9);
        assert!((month - 3.2378912).abs() < 1e-9);
        assert!(next.is_none());
        assert!(decimal(&json!("NaN")).is_err());
        assert!(parse_cost_page(br#"{"data":[],"has_more":true}"#, "a", "b", "c", &mut HashSet::new()).is_err());
        assert!(parse_cost_page(&body, "2026-10-01T00:00:00Z", "2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z", &mut seen).is_err());
        assert_eq!(utc_midnight("2026-10-05T00:00:00.000+00:00").unwrap(), "2026-10-05T00:00:00Z");
        assert!(utc_midnight("2026-10-05T00:00:00+08:00").is_err());
        assert_eq!(percent_encode("a&b/"), "a%26b%2F");
    }
}

#[cfg(windows)]
fn fetch_openai(secret:&str,month_start:String,today_start:String,ending:String,observed:String)->ApiResult<ApiSnapshot>{
    let to_seconds=|text:&str|crate::agent_usage::timestamp_ms(&serde_json::json!(text)).map(|value|value/1000).ok_or_else(||invalid("费用请求日期无效"));
    let month=to_seconds(&month_start)?;let today=to_seconds(&today_start)?;let end=to_seconds(&ending)?;
    let base=format!("/v1/organization/costs?start_time={month}&end_time={end}&bucket_width=1d&limit=31");let mut path=base.clone();let mut cursors=HashSet::new();let mut seen=HashSet::new();let(mut month_cost,mut today_cost)=(0.0,0.0);let started=Instant::now();let mut complete=false;
    let headers=format!("Authorization: Bearer {secret}\r\nAccept: application/json\r\n");
    for _ in 0..4{
        if started.elapsed()>Duration::from_secs(40){return Err(failure("timeout","OpenAI 费用报告读取超时；未展示不完整合计",false));}
        let bytes=request("api.openai.com",&path,&headers)?;
        let value:Value=serde_json::from_slice(&bytes).map_err(|_|invalid("OpenAI 费用报告格式无效"))?;
        let rows=value["data"].as_array().filter(|rows|rows.len()<=180).ok_or_else(||invalid("OpenAI 缺少费用桶"))?;
        for bucket in rows{
            let start=bucket["start_time"].as_u64().ok_or_else(||invalid("OpenAI 费用桶缺少时间"))?;let finish=bucket["end_time"].as_u64().ok_or_else(||invalid("OpenAI 费用桶缺少结束时间"))?;
            if start<month||start>=end||finish<=start||finish>end||start%86400!=0||finish%86400!=0||!seen.insert(start){return Err(invalid("OpenAI 返回了重复或范围外的费用桶"));}
            let values=bucket["results"].as_array().filter(|rows|rows.len()<=1000).ok_or_else(||invalid("OpenAI 缺少费用条目"))?;
            for row in values{
                if row["amount"]["currency"]!="usd"{return Err(invalid("OpenAI 费用币种不是 USD"));}
                let number=row["amount"]["value"].as_f64().filter(|number|number.is_finite()).ok_or_else(||invalid("OpenAI 未返回有效费用"))?;
                month_cost+=number;if start>=today{today_cost+=number;}
            }
        }
        if !month_cost.is_finite()||!today_cost.is_finite(){return Err(invalid("OpenAI 费用合计无效"));}
        match value["has_more"].as_bool(){Some(false)=>{complete=true;break;},Some(true)=>{
            let cursor=value["next_page"].as_str().filter(|value|!value.is_empty()&&value.len()<=512).ok_or_else(||invalid("OpenAI 缺少分页游标"))?;
            if !cursors.insert(cursor.to_owned()){return Err(invalid("OpenAI 分页游标重复"));}path=format!("{base}&page={}",percent_encode(cursor));
        },None=>return Err(invalid("OpenAI 缺少分页状态"))}
    }
    if !complete{return Err(invalid("OpenAI 费用报告超过分页上限，合计未知"));}
    Ok(ApiSnapshot{observed_at:observed.clone(),accounts:vec![ApiAccount{id:"openai".into(),name:"OpenAI API".into(),state:"normal",balance:None,currency:"USD".into(),today_cost:Some(today_cost),month_cost:Some(month_cost),observed_at:observed,source_url:"https://api.openai.com/v1/organization/costs",period_start:Some(month_start),period_end:Some(ending.clone()),today_period_start:Some(today_start),today_period_end:Some(ending)}]})
}
