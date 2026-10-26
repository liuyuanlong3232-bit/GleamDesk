use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};
use crate::provider_requests::{RequestCache, observed_unix_ms};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeszelSnapshot {
    pub sampled_at_unix_ms: Option<u64>,
    pub fetched_at_unix_ms: u64,
    pub name: String,
    pub host: Option<String>,
    pub state: &'static str,
    pub uptime_seconds: Option<f64>,
    pub latency_ms: Option<u64>,
    pub cpu_percent: Option<f64>,
    pub memory_percent: Option<f64>,
    pub disk_percent: Option<f64>,
    pub network: Network,
    pub services: Vec<Service>,
    pub server_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub upload_bytes: Option<f64>,
    pub download_bytes: Option<f64>,
    pub total_bytes: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Service {
    pub name: String,
    pub state: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HubUrl {
    host: String,
    port: u16,
    secure: bool,
    prefix: String,
}

#[cfg(windows)]
fn beszel_get(hub: &HubUrl, path: &str, token: &str) -> Result<(u32, Vec<u8>), String> {
    crate::credentials::validate(token)?;
    crate::http::get(&hub.host, hub.port, hub.secure, path, &format!("Authorization: {token}\r\nAccept: application/json\r\n"))
}

fn parse_hub_url(value: &str) -> Result<HubUrl, String> {
    let value = value.trim().trim_end_matches('/');
    let (scheme, rest) = value.split_once("://").ok_or("Beszel 地址必须以 http:// 或 https:// 开头")?;
    let secure = match scheme.to_ascii_lowercase().as_str() {
        "https" => true,
        "http" => false,
        _ => return Err("Beszel 地址只支持 HTTP 或 HTTPS".into()),
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() || authority.contains('@') || authority.contains('?') || authority.contains('#') {
        return Err("Beszel 地址主机名无效".into());
    }
    let prefix = &rest[authority_end..];
    if prefix.contains('?') || prefix.contains('#') || prefix.contains('\\') {
        return Err("Beszel 地址不能包含查询参数或片段".into());
    }
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']').ok_or("Beszel IPv6 地址格式无效")?;
        let host = &authority[1..end];
        let suffix = &authority[end + 1..];
        let port = if suffix.is_empty() { if secure { 443 } else { 80 } }
            else if let Some(raw_port) = suffix.strip_prefix(':') { raw_port.parse::<u16>().map_err(|_| "Beszel 端口无效")? }
            else { return Err("Beszel IPv6 地址格式无效".into()); };
        (host.to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((host, raw_port)) if !raw_port.is_empty() && raw_port.bytes().all(|byte| byte.is_ascii_digit()) => {
                (host.to_string(), raw_port.parse::<u16>().map_err(|_| "Beszel 端口无效")?)
            }
            Some((_, raw_port)) if raw_port.is_empty() => return Err("Beszel 端口无效".into()),
            Some(_) => return Err("Beszel 主机名或端口格式无效；IPv6 地址请使用方括号".into()),
            None => (authority.to_string(), if secure { 443 } else { 80 }),
        }
    };
    if host.is_empty() || port == 0 || host.chars().any(char::is_control) {
        return Err("Beszel 地址主机名或端口无效".into());
    }
    Ok(HubUrl { host, port, secure, prefix: prefix.to_string() })
}

fn api_error_message(status: u32) -> String {
    match status {
        401 | 403 => "Beszel API 令牌无效或无权读取该系统".into(),
        404 => "找不到 Beszel 系统，请检查 System ID 和访问权限".into(),
        _ => format!("Beszel API 请求失败（HTTP {status}）"),
    }
}

fn validate_system_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 80 || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return Err("Beszel System ID 只能包含字母、数字、连字符或下划线".into());
    }
    Ok(())
}

fn parse_record(body: &[u8], fallback: &str, server_id: &str, latency: u64, stats: Option<&Value>) -> Result<BeszelSnapshot, String> {
    let record: Value = serde_json::from_slice(body).map_err(|_| "Beszel 返回了无法识别的数据")?;
    let info = parse_embedded_json(record.get("info"));
    let stat = stats.and_then(|value| value.get("stats")).unwrap_or(&Value::Null);
    let cpu = number(&info, &["cpu", "Cpu"]).or_else(|| number(stat, &["cpu"]));
    let memory = number(&info, &["mp", "MemPct"]).or_else(|| number(stat, &["mp", "MemPct"]));
    let disk = number(&info, &["dp", "DiskPct"]).or_else(|| number(stat, &["dp", "DiskPct"]));
    let uptime_seconds = number(&info, &["u", "Uptime"]).filter(|value| value.is_finite() && *value >= 0.0 && *value <= 9_007_199_254_740_991.0);
    let percent = |value: Option<f64>| value.filter(|value| value.is_finite() && (0.0..=100.0).contains(value));
    let network_array = stat.get("b").or_else(|| stat.get("Bandwidth"));
    let upload = network_array.and_then(|value| value.get(0)).and_then(Value::as_f64)
        .or_else(|| number(&info, &["ns", "NetworkSent"])).filter(|value| value.is_finite() && *value >= 0.0);
    let download = network_array.and_then(|value| value.get(1)).and_then(Value::as_f64)
        .or_else(|| number(&info, &["nr", "NetworkRecv"])).filter(|value| value.is_finite() && *value >= 0.0);
    let total = number(&info, &["bb", "BandwidthBytes", "b", "Bandwidth"])
        .or_else(|| upload.zip(download).map(|(sent, recv)| sent + recv)).filter(|value| value.is_finite() && *value >= 0.0);
    let status = record.get("status").and_then(Value::as_str).unwrap_or("");
    let state = match status.to_ascii_lowercase().as_str() {
        "up" | "online" => "online",
        "down" | "offline" => "offline",
        _ => "unknown",
    };
    let name = record.get("name").and_then(Value::as_str).filter(|name| !name.is_empty()).unwrap_or(fallback).to_string();
    let fetched_at_unix_ms=observed_unix_ms();
    let system_time=source_timestamp(&record["updated"],fetched_at_unix_ms);
    // The displayed metrics can mix system info and the last stats packet.
    // Do not give an older packet the newer system record's date.
    let sampled_at_unix_ms=match stats {
        Some(stats)=>system_time.zip(source_timestamp(&stats["created"],fetched_at_unix_ms)).map(|(system,stats)|system.min(stats)),
        None=>system_time,
    };
    Ok(BeszelSnapshot {
        sampled_at_unix_ms, fetched_at_unix_ms,
        name, host:record["host"].as_str().and_then(normalize_location_host),state, uptime_seconds, latency_ms: Some(latency), cpu_percent: percent(cpu), memory_percent: percent(memory), disk_percent: percent(disk),
        network: Network { upload_bytes: upload, download_bytes: download, total_bytes: total },
        services: Vec::new(), server_id: server_id.into(),
    })
}

// PocketBase UTC dates use YYYY-MM-DD[ T]HH:mm:ss[.fraction]Z.
// Reuse the Windows time conversion already used by the local Codex reader.
#[cfg(windows)]
fn source_timestamp(value:&Value,now:u64)->Option<u64>{
    use windows_sys::Win32::{Foundation::{FILETIME,SYSTEMTIME},System::Time::{SystemTimeToFileTime,FileTimeToSystemTime}};
    let text=value.as_str()?;let bytes=text.as_bytes();
    if bytes.len()<20||bytes.get(4)!=Some(&b'-')||bytes.get(7)!=Some(&b'-')||!matches!(bytes.get(10),Some(b'T'|b' '))||bytes.get(13)!=Some(&b':')||bytes.get(16)!=Some(&b':')||bytes.last()!=Some(&b'Z'){return None}
    let fraction=text.get(19..text.len()-1)?;
    let millis=if fraction.is_empty(){0}else{let digits=fraction.strip_prefix('.')?;if digits.is_empty()||digits.len()>9||!digits.bytes().all(|b|b.is_ascii_digit()){return None}format!("{digits:0<3}").get(..3)?.parse::<u16>().ok()?};
    let part=|a,b|{let raw=text.get(a..b)?;if !raw.bytes().all(|b|b.is_ascii_digit()){return None}raw.parse::<u16>().ok()};
    let mut time:SYSTEMTIME=unsafe{std::mem::zeroed()};time.wYear=part(0,4)?;time.wMonth=part(5,7)?;time.wDay=part(8,10)?;time.wHour=part(11,13)?;time.wMinute=part(14,16)?;time.wSecond=part(17,19)?;time.wMilliseconds=millis;
    let mut file:FILETIME=unsafe{std::mem::zeroed()};let mut back:SYSTEMTIME=unsafe{std::mem::zeroed()};
    if unsafe{SystemTimeToFileTime(&time,&mut file)}==0||unsafe{FileTimeToSystemTime(&file,&mut back)}==0{return None}
    if (time.wYear,time.wMonth,time.wDay,time.wHour,time.wMinute,time.wSecond)!=(back.wYear,back.wMonth,back.wDay,back.wHour,back.wMinute,back.wSecond){return None}
    let result=(((file.dwHighDateTime as u64)<<32)|file.dwLowDateTime as u64).checked_sub(116444736000000000)?/10000;
    (result<=now.saturating_add(1000)).then_some(result)
}
#[cfg(not(windows))]
fn source_timestamp(_: &Value,_:u64)->Option<u64>{None}

fn parse_embedded_json(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(raw)) => serde_json::from_str(raw).unwrap_or(Value::Null),
        Some(value) => value.clone(),
        None => Value::Null,
    }
}

fn number(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| value.get(*key).and_then(|item| item.as_f64().or_else(|| item.as_str()?.parse().ok())))
}

fn jwt_format(token: &str) -> bool {
    let parts: Vec<_> = token.split('.').collect();
    parts.len() == 3 && parts.iter().all(|part| !part.is_empty()
        && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'))
}

fn validate_auth_token(token: &str) -> Result<(), String> {
    crate::credentials::validate(token)?;
    if !jwt_format(token) {
        return Err("Beszel 读取需要 PocketBase 用户认证 JWT；请填写登录用户获得的令牌，不带 Bearer 前缀。Agent 注册 Token 不适用于此读取。".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeszelTokenStatus { configured: bool, jwt_format: bool }

#[tauri::command]
pub fn inspect_beszel_token() -> Result<BeszelTokenStatus, String> {
    #[cfg(windows)] {
        let configured = crate::credentials::exists(crate::credentials::CredentialSource::Beszel)?;
        let format = if configured { jwt_format(crate::credentials::read(crate::credentials::CredentialSource::Beszel)?.as_str()) } else { false };
        Ok(BeszelTokenStatus { configured, jwt_format: format })
    }
    #[cfg(not(windows))] { Ok(BeszelTokenStatus { configured:false, jwt_format:false }) }
}

struct LoginSecret(Vec<u8>);
impl Drop for LoginSecret { fn drop(&mut self) { self.0.fill(0); } }

#[derive(Serialize)]
struct LoginBody<'a> { identity: &'a str, password: &'a str }
#[derive(Deserialize)]
struct LoginReply { token: String }

#[tauri::command]
pub async fn connect_beszel_account(window: tauri::WebviewWindow, base_url: String, identity: String, password: String) -> Result<(),String> {
    if !["main","dashboard"].contains(&window.label()) || !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true) {
        return Err("请在可见的应用窗口中连接 Beszel 账户".into());
    }
    let password=LoginSecret(password.into_bytes());
    let hub=parse_hub_url(&base_url)?;
    let identity=identity.trim().to_string();
    if identity.is_empty() || identity.len()>512 || password.0.is_empty() || password.0.len()>4096 { return Err("请填写有效的 Hub 账户邮箱和密码".into()); }
    if !hub.secure && !matches!(hub.host.as_str(),"localhost"|"127.0.0.1"|"::1") { return Err("远程 Hub 的账户登录需使用 HTTPS".into()); }
    let revision=crate::credentials::revision();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)] {
            let check=|| if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true) {Err("Beszel 连接已取消".to_string())} else {Ok(())};
            let mut body=LoginSecret(serde_json::to_vec(&LoginBody {identity:&identity,password:std::str::from_utf8(&password.0).map_err(|_|"无法编码登录信息")?}).map_err(|_|"无法编码登录信息")?);
            let path=format!("{}/api/collections/users/auth-with-password",hub.prefix);
            let response=crate::http::post_pocketbase_auth(&hub.host,hub.port,hub.secure,&path,&body.0,Instant::now()+Duration::from_secs(30),&check);
            body.0.fill(0); drop(password);
            let (status,mut bytes)=response.map_err(|_|"Beszel 账户连接失败或超时；没有自动重试")?;
            if status!=200 {bytes.fill(0);return Err(match status {400|401=>"Hub 账户邮箱或密码验证失败",403=>"Hub 拒绝此次用户登录",300..=399=>"Hub 返回了重定向，请使用最终 Hub 地址",_=>"Hub 用户认证服务暂不可用"}.into());}
            let reply=serde_json::from_slice::<LoginReply>(&bytes);
            bytes.fill(0);
            let token=LoginSecret(reply.map_err(|_|"Hub 未返回有效的用户认证令牌")?.token.into_bytes());
            let value=std::str::from_utf8(&token.0).map_err(|_|"Hub 认证令牌编码无效")?;
            validate_auth_token(value)?;
            check()?;
            if revision!=crate::credentials::revision() {return Err("凭据在连接期间已更新，请重新连接".into());}
            crate::credentials::save(crate::credentials::CredentialSource::Beszel,value)?;
            Ok(())
        }
        #[cfg(not(windows))] {let _=(hub,identity,password,revision,window);Err("Beszel 账户连接仅支持 Windows 桌面应用".into())}
    }).await.map_err(|_|"Beszel 账户连接任务无法完成".to_string())?
}

#[tauri::command]
pub fn save_beszel_token(token: String) -> Result<(), String> {
    validate_auth_token(&token)?;
    #[cfg(windows)]
    { crate::credentials::save(crate::credentials::CredentialSource::Beszel, &token) }
    #[cfg(not(windows))]
    { let _ = token; Err("Beszel 安全凭据目前仅支持 Windows Credential Manager".into()) }
}

#[tauri::command]
pub fn has_beszel_token() -> bool {
    #[cfg(windows)]
    { crate::credentials::exists(crate::credentials::CredentialSource::Beszel).unwrap_or(false) }
    #[cfg(not(windows))]
    { false }
}

#[tauri::command]
pub fn clear_beszel_token() -> Result<(), String> {
    #[cfg(windows)]
    { crate::credentials::clear(crate::credentials::CredentialSource::Beszel) }
    #[cfg(not(windows))]
    { Err("Beszel 安全凭据目前仅支持 Windows Credential Manager".into()) }
}

#[tauri::command]
pub async fn fetch_beszel_snapshot(state: tauri::State<'_, BeszelState>, base_url: String, system_id: String, minimum_interval_ms: Option<u64>) -> Result<BeszelSnapshot, String> {
    let cache = state.cache.clone();
    let interval = minimum_interval_ms.unwrap_or(2_000).clamp(1_000, 300_000);
    tauri::async_runtime::spawn_blocking(move || fetch_beszel_snapshot_blocking(cache, base_url, system_id, interval))
        .await.map_err(|_| "Beszel 读取任务无法完成".to_string())?
}

#[derive(Default)]
pub struct BeszelState { cache: RequestCache<(HubUrl, String, u64), BeszelSnapshot>, location_cache:RequestCache<String,VpsLocation> }
impl BeszelState {
    pub fn metrics(&self) -> Option<crate::provider_requests::RequestMetrics> { self.cache.metrics() }
}

fn fetch_beszel_snapshot_blocking(cache: RequestCache<(HubUrl, String, u64), BeszelSnapshot>, base_url: String, system_id: String, interval_ms: u64) -> Result<BeszelSnapshot, String> {
    validate_system_id(&system_id)?;
    let hub = parse_hub_url(&base_url)?;
    let revision = crate::credentials::revision();
    let key = (hub.clone(), system_id.clone(), revision);
    let result = cache.read(key, Duration::from_millis(interval_ms), Duration::from_millis(500), || {
        #[cfg(windows)]
        {
            let token = crate::credentials::read(crate::credentials::CredentialSource::Beszel)?;
            validate_auth_token(token.as_str())?;
            let started = Instant::now();
            let system_path = format!("{}/api/collections/systems/records/{}?fields=id,name,host,status,info,updated", hub.prefix, system_id);
            let (system_status, body) = beszel_get(&hub, &system_path, token.as_str())?;
            if !(200..300).contains(&system_status) { return Err(api_error_message(system_status)); }
            let latency = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            let stats_path = format!("{}/api/collections/system_stats/records?filter=system%3D%22{}%22&sort=-created&perPage=1&fields=created,stats,type", hub.prefix, system_id);
            let stats = match beszel_get(&hub, &stats_path, token.as_str()) {
                Ok((status, bytes)) if (200..300).contains(&status) => serde_json::from_slice::<Value>(&bytes).ok()
                    .and_then(|value| value.get("items").and_then(Value::as_array).and_then(|items| items.first().cloned())),
                Ok((status, _)) if !(200..300).contains(&status) && status != 404 => return Err(api_error_message(status)),
                _ => None,
            };
            parse_record(&body, "Beszel", &system_id, latency, stats.as_ref())
        }
        #[cfg(not(windows))]
        { let _ = hub; Err("Beszel API 连接目前仅支持 Windows 桌面版本".into()) }
    });
    if revision != crate::credentials::revision() { return Err("服务凭据已更新，请重新读取".into()); }
    result
}

fn normalize_location_host(raw:&str)->Option<String>{
    let value=raw.trim();
    if let Ok(ip)=value.parse::<std::net::IpAddr>(){return Some(ip.to_string())}
    if let Some(inner)=value.strip_prefix('[').and_then(|v|v.strip_suffix(']')){return inner.parse::<std::net::Ipv6Addr>().ok().map(|ip|ip.to_string())}
    let value=value.trim_end_matches('.').to_ascii_lowercase();
    if value.len()>253||!value.contains('.')||value.parse::<std::net::Ipv4Addr>().is_ok()||!value.bytes().all(|b|b.is_ascii_alphanumeric()||b".-".contains(&b)){return None}
    if value.ends_with(".local")||value.split('.').any(|label|label.is_empty()||label.len()>63||label.starts_with('-')||label.ends_with('-')){return None}
    Some(value)
}
pub(crate) fn public_location_ip(ip:std::net::IpAddr)->bool{
    use std::net::IpAddr;
    match ip{
        IpAddr::V4(ip)=>{let [a,b,c,_]=ip.octets();!(ip.is_private()||ip.is_loopback()||ip.is_link_local()||ip.is_multicast()||ip.is_broadcast()||ip.is_documentation()||a==0||a>=240||(a==100&&(64..=127).contains(&b))||(a==198&&(18..=19).contains(&b))||(a==192&&((b==0&&c==0)||(b==88&&c==99))))},
        IpAddr::V6(ip)=>{if let Some(mapped)=ip.to_ipv4_mapped(){return public_location_ip(IpAddr::V4(mapped))}let s=ip.segments();(s[0]&0xe000)==0x2000&&!(s[0]==0x2001&&(s[1]<=0x1ff||s[1]==0xdb8))&&s[0]!=0x2002&&s[0]!=0x3fff}
    }
}
fn unique_public_location_ip(host:&str,resolve:impl FnOnce(&str)->Result<Vec<std::net::IpAddr>,String>)->Result<std::net::IpAddr,String>{
    let host=normalize_location_host(host).ok_or("服务器地址不可用于所在地查询")?;
    let ips=if let Ok(ip)=host.parse(){vec![ip]}else{resolve(&host)?};
    let ips:std::collections::HashSet<_>=ips.into_iter().collect();
    if ips.len()!=1{return Err("服务器域名没有唯一地址，所在地未确认".into())}
    let ip=*ips.iter().next().ok_or("服务器IP未知")?;
    if !public_location_ip(ip){return Err("内网或保留地址，所在地未确认".into())}Ok(ip)
}
#[cfg(windows)]
fn resolve_location_host(host:&str)->Result<Vec<std::net::IpAddr>,String>{
    const SCRIPT:&str=r#"$ErrorActionPreference='Stop';$q=[Console]::In.ReadToEnd()|ConvertFrom-Json;ConvertTo-Json -Compress -InputObject @([System.Net.Dns]::GetHostAddresses($q.host)|ForEach-Object{$_.ToString()})"#;
    let path=crate::network_tools::system_executable("WindowsPowerShell\\v1.0\\powershell.exe")?;
    let body=serde_json::to_vec(&serde_json::json!({"host":host})).map_err(|_|"域名查询参数无效")?;
    let value=crate::cli_reader::read_cli_json_input(&path,&["-NoProfile","-NonInteractive","-Command",SCRIPT],Duration::from_secs(5),Some(&body)).map_err(|_|"服务器域名解析失败或超时")?;
    let values=value.as_array().ok_or("服务器域名解析结果无效")?;
    if values.len()>64{return Err("服务器域名地址过多，所在地未确认".into())}
    values.iter().map(|v|v.as_str().and_then(|v|v.parse().ok()).ok_or("服务器域名解析结果无效".into())).collect()
}
#[derive(Debug,Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct VpsLocation{pub ip:String,pub country_zh:Option<String>,pub country_en:Option<String>,pub city_zh:Option<String>,pub city_en:Option<String>,pub looked_up_at_unix_ms:u64,pub source:&'static str}
struct LocationLanguage{country:Option<String>,city:Option<String>,country_code:Option<String>}
fn location_language(bytes:&[u8],ip:std::net::IpAddr)->Result<LocationLanguage,String>{
    if bytes.len()>65536{return Err("所在地返回数据过大".into())}
    let value:Value=serde_json::from_slice(bytes).map_err(|_|"所在地返回格式无效")?;
    if value["success"]!=true||value["ip"].as_str().and_then(|v|v.parse::<std::net::IpAddr>().ok())!=Some(ip){return Err("所在地返回地址不匹配或查询失败".into())}
    let name=|field:&str|value[field].as_str().map(str::trim).filter(|v|!v.is_empty()&&v.chars().count()<=100&&!v.chars().any(char::is_control)).map(str::to_owned);
    let country_code=name("country_code").filter(|v|v.len()==2&&v.bytes().all(|b|b.is_ascii_uppercase()));
    Ok(LocationLanguage{country:name("country"),city:name("city"),country_code})
}
fn lookup_location(ip:std::net::IpAddr,read:impl Fn(&str)->Result<Vec<u8>,String>)->Result<VpsLocation,String>{
    // Fixed free HTTPS endpoint; no key, account, message, or Hub token is sent.
    let en=read("en").and_then(|v|location_language(&v,ip));let zh=read("zh-CN").and_then(|v|location_language(&v,ip));
    if let (Ok(en),Ok(zh))=(&en,&zh){if en.country_code.is_some()&&zh.country_code.is_some()&&en.country_code!=zh.country_code{return Err("中英文所在地结果不一致，未确认".into())}}
    let en=en.ok();let zh=zh.ok();
    let result=VpsLocation{ip:ip.to_string(),country_zh:zh.as_ref().and_then(|v|v.country.clone()),country_en:en.as_ref().and_then(|v|v.country.clone()),city_zh:zh.and_then(|v|v.city),city_en:en.and_then(|v|v.city),looked_up_at_unix_ms:observed_unix_ms(),source:"ipwho.is"};
    if result.country_en.is_none()&&result.country_zh.is_none()&&result.city_en.is_none()&&result.city_zh.is_none(){return Err("所在地暂不可用".into())}Ok(result)
}
#[tauri::command]
pub async fn read_vps_location(view:tauri::Webview,state:tauri::State<'_,BeszelState>,host:String)->Result<VpsLocation,String>{
    if !matches!(view.label(),"main"|"dashboard"){return Err("所在地查询只用于主屏和工作台".into())}
    let live=crate::simulation::require_live().map_err(|_|"模拟模式或状态未同步，所在地未查询")?;
    let host=normalize_location_host(&host).ok_or("服务器地址不可用于所在地查询")?;let cache=state.location_cache.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let check=||live.check().map_err(|_|"模拟模式已暂停所在地查询".to_string());check()?;
        cache.read(host.clone(),Duration::from_secs(86400),Duration::from_secs(1800),||{
            #[cfg(windows)]{
                let ip=unique_public_location_ip(&host,resolve_location_host)?;check()?;
                let deadline=Instant::now()+Duration::from_secs(8);
                lookup_location(ip,|language|crate::http::ip_location_json(&ip.to_string(),language,deadline,&check))
            }
            #[cfg(not(windows))]{Err("所在地查询需要Windows桌面程序".into())}
        })
    }).await.map_err(|_|"所在地查询任务失败".to_string())?
}

fn local_hub_port(base_url: &str) -> Result<u16, String> {
    let hub=parse_hub_url(base_url)?;
    if hub.secure || hub.host!="127.0.0.1" || !hub.prefix.is_empty() || hub.port<1024 {
        return Err("随软件启动仅支持 http://127.0.0.1:端口 的本机 Hub（端口至少 1024）".into());
    }
    Ok(hub.port)
}

fn local_hub_paths(executable:&str,data_directory:&str)->Result<(std::path::PathBuf,std::path::PathBuf),String>{
    if [executable,data_directory].iter().any(|s|s.len()>1024||s.chars().any(char::is_control)||s.trim().starts_with("\\\\")||s.trim().starts_with("//")) {
        return Err("本机 Hub 路径无效；请使用本地完整路径".into());
    }
    let exe=std::path::PathBuf::from(executable.trim());
    let data=std::path::PathBuf::from(data_directory.trim());
    if !exe.is_absolute() || !exe.is_file() || !exe.file_name().is_some_and(|n|n.to_string_lossy().eq_ignore_ascii_case("beszel.exe")) {
        return Err("请选择已安装的 beszel.exe 完整路径".into());
    }
    if !data.is_absolute() || !data.is_dir() || !data.join("data.db").is_file() {
        return Err("原数据目录无效：需要已有 data.db，不会自动新建数据库".into());
    }
    Ok((exe,data))
}

fn hub_health_response(status:u32,body:&[u8])->bool {
    status==200 && serde_json::from_slice::<Value>(body).ok().is_some_and(|v|v["code"].as_u64()==Some(200))
}

fn local_hub_command(exe:&std::path::Path,data:&std::path::Path,port:u16)->std::process::Command {
    let mut command=std::process::Command::new(exe);
    command.args(["serve","--http",&format!("127.0.0.1:{port}"),"--dir"]).arg(data);
    if let Some(parent)=exe.parent(){command.current_dir(parent);}
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    command
}

#[cfg(windows)]
fn ensure_local_hub(base_url:&str,executable:&str,data_directory:&str,check:&impl Fn()->Result<(),String>)->Result<String,String>{
    use std::{io::ErrorKind,net::{SocketAddr,TcpStream},sync::Mutex,thread};
    static STARTING:Mutex<()>=Mutex::new(());
    let _lock=STARTING.lock().map_err(|_|"本机 Hub 启动锁不可用")?;
    check()?;
    let port=local_hub_port(base_url)?;
    let address=SocketAddr::from(([127,0,0,1],port));
    let health=||->Result<bool,String>{
        let (status,body)=crate::http::vps_service_get("127.0.0.1",port,false,"/api/health","Accept: application/json\r\n",check)?;
        Ok(hub_health_response(status,&body))
    };
    match TcpStream::connect_timeout(&address,Duration::from_secs(3)) {
        Ok(_)=>return if health()? {Ok("本机 Hub 已运行，未重复启动".into())}else{Err("端口已有服务，但 Hub 健康检查未通过；未启动新进程".into())},
        Err(error) if error.kind()==ErrorKind::ConnectionRefused=>{},
        Err(_)=>return Err("无法确认本机 Hub 端口空闲，已停止启动".into()),
    }
    let (exe,data)=local_hub_paths(executable,data_directory)?;
    check()?;
    let mut child=local_hub_command(&exe,&data,port).spawn().map_err(|_|"无法启动已配置的本机 Hub")?;
    let result=(||{
        let deadline=Instant::now()+Duration::from_secs(15);
        while Instant::now()<deadline {
            check()?;
            if child.try_wait().map_err(|_|"无法检查本机 Hub 进程")?.is_some(){return Err("本机 Hub 启动后退出，请检查程序与原数据目录".into());}
            if TcpStream::connect_timeout(&address,Duration::from_millis(200)).is_ok() && health().unwrap_or(false){
                check()?;
                return Ok("本机 Hub 已启动并通过健康检查".into());
            }
            thread::sleep(Duration::from_millis(250));
        }
        Err("本机 Hub 启动超时，已结束本次新建进程；不会重复拉起".into())
    })();
    if result.is_err() && child.try_wait().map_err(|_|"启动失败且无法确认本次 Hub 进程状态")?.is_none(){
        child.kill().map_err(|_|"启动失败且无法结束本次 Hub 进程，请手动检查")?;
        child.wait().map_err(|_|"本次 Hub 进程退出状态无法确认")?;
    }
    result
}

#[tauri::command]
pub async fn ensure_local_beszel_hub(view:tauri::Webview,base_url:String,executable:String,data_directory:String)->Result<String,String>{
    let url=view.url().map_err(|_|"无法确认启动请求来源")?;
    if view.label()!="main" || !crate::webapps::trusted_local_origin(view.label(),&url,cfg!(debug_assertions)) {
        return Err("仅本地主屏可执行已配置的 Hub 启动检查".into());
    }
    let permit=crate::simulation::require_live()?;
    #[cfg(windows)] {
        tauri::async_runtime::spawn_blocking(move||ensure_local_hub(&base_url,&executable,&data_directory,&||permit.check()))
            .await.map_err(|_|"本机 Hub 启动检查任务失败".to_string())?
    }
    #[cfg(not(windows))] {let _=(permit,base_url,executable,data_directory);Err("本机 Hub 随软件启动仅支持 Windows".into())}
}

#[cfg(test)]
mod tests {
    use super::{api_error_message, jwt_format, parse_hub_url, parse_record, validate_system_id};
    use serde_json::json;

    #[test]
    fn local_hub_startup_never_targets_remote_or_public_listeners(){
        assert_eq!(super::local_hub_port("http://127.0.0.1:8090/"),Ok(8090));
        for url in ["https://127.0.0.1:8090","http://127.0.0.1:8090/prefix","http://0.0.0.0:8090","http://example.com:8090","http://127.0.0.1:80","http://user:pass@127.0.0.1:8090"]{assert!(super::local_hub_port(url).is_err(),"{url}");}
    }
    #[cfg(windows)]
    #[test]
    fn local_hub_windows_closed_port_is_reported_refused_within_probe_budget(){
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();drop(listener);
        let error=std::net::TcpStream::connect_timeout(&address,std::time::Duration::from_secs(3)).unwrap_err();
        assert_eq!(error.kind(),std::io::ErrorKind::ConnectionRefused,"{error}");
    }
    #[test]
    fn local_hub_health_requires_successful_pocketbase_json(){
        assert!(super::hub_health_response(200,br#"{"code":200,"message":"API is healthy."}"#));
        assert!(!super::hub_health_response(200,b"<html>login</html>"));
        assert!(!super::hub_health_response(503,br#"{"code":200}"#));
        assert!(!super::hub_health_response(200,br#"{"code":503}"#));
    }
    #[cfg(windows)]
    #[test]
    fn local_hub_existing_listener_is_reused_or_refused_without_launching(){
        use std::{io::{Read,Write},net::TcpListener,thread};
        for (body,expected) in [(r#"{"code":200}"#,true),("<html>other service</html>",false)] {
            let listener=TcpListener::bind("127.0.0.1:0").unwrap();
            let port=listener.local_addr().unwrap().port();
            listener.set_nonblocking(true).unwrap();
            let server=thread::spawn(move||{
                let deadline=std::time::Instant::now()+std::time::Duration::from_secs(20);
                while std::time::Instant::now()<deadline {
                    match listener.accept(){
                        Ok((mut stream,_))=>{
                            stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
                            let mut input=[0;2048];
                            if stream.read(&mut input).unwrap_or(0)==0{continue;}
                            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
                            return;
                        },
                        Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(std::time::Duration::from_millis(10)),
                        Err(error)=>panic!("{error}"),
                    }
                }
                panic!("Synthetic Hub health request did not arrive");
            });
            let result=super::ensure_local_hub(&format!("http://127.0.0.1:{port}"),"not-an-executable","not-a-database",&||Ok(()));
            assert_eq!(result.is_ok(),expected,"{result:?}");
            if let Err(error)=result{assert!(error.contains("健康检查未通过"),"{error}");}
            server.join().unwrap();
        }
    }
    #[test]
    fn local_hub_launch_arguments_preserve_paths_and_bind_loopback(){
        let command=super::local_hub_command(std::path::Path::new("C:/Hub folder/beszel.exe"),std::path::Path::new("D:/Hub data/beszel_data"),8090);
        let args:Vec<_>=command.get_args().map(|s|s.to_string_lossy().into_owned()).collect();
        assert_eq!(args,vec!["serve","--http","127.0.0.1:8090","--dir","D:/Hub data/beszel_data"]);
        assert_eq!(command.get_program(),std::ffi::OsStr::new("C:/Hub folder/beszel.exe"));
    }
    #[test]
    fn local_hub_paths_require_existing_database_without_reading_data(){
        assert!(super::local_hub_paths("relative/beszel.exe","relative/data").is_err());
        assert!(super::local_hub_paths("\\\\server\\share\\beszel.exe","C:/data").is_err());
        assert!(super::local_hub_paths("  \\\\server\\share\\beszel.exe","C:/data").is_err());
        assert!(super::local_hub_paths("//server/share/beszel.exe","C:/data").is_err());
        let directory=std::env::temp_dir().join(format!("beszel-startup-paths-{}-{}",std::process::id(),super::observed_unix_ms()));
        std::fs::create_dir(&directory).unwrap();
        let exe=directory.join("beszel.exe");std::fs::write(&exe,b"test fixture; never executed").unwrap();
        assert!(super::local_hub_paths(exe.to_str().unwrap(),directory.to_str().unwrap()).is_err());
        std::fs::write(directory.join("data.db"),b"synthetic marker; never opened").unwrap();
        assert!(super::local_hub_paths(exe.to_str().unwrap(),directory.to_str().unwrap()).is_ok());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn public_ip_resolution_rejects_private_reserved_or_ambiguous_addresses_without_fallback(){
        for ip in ["127.0.0.1","10.0.0.1","172.16.0.1","192.168.1.1","169.254.1.1","100.64.1.1","192.0.2.1","198.51.100.1","203.0.113.1","198.18.0.1","224.0.0.1","240.0.0.1","::1","fe80::1","fc00::1","2001:db8::1","::ffff:127.0.0.1"] {
            assert!(super::unique_public_location_ip(ip,|_|panic!("IP literals must not resolve DNS")).is_err(),"{ip}");
        }
        for ips in [vec![],vec!["1.1.1.1","8.8.8.8"],vec!["1.1.1.1","10.0.0.1"]]{
            assert!(super::unique_public_location_ip("example.com",|_|Ok(ips.iter().map(|v|v.parse().unwrap()).collect())).is_err());
        }
        for ip in ["1.1.1.1","8.8.8.8","2606:4700:4700::1111"]{assert_eq!(super::unique_public_location_ip(ip,|_|panic!()).unwrap().to_string(),ip);}
        assert_eq!(super::unique_public_location_ip("EXAMPLE.com",|host|{assert_eq!(host,"example.com");Ok(vec!["1.1.1.1".parse().unwrap();2])}).unwrap().to_string(),"1.1.1.1");
    }
    #[test]
    fn location_response_must_match_the_requested_ip_and_country(){
        let ip="1.1.1.1".parse().unwrap();
        for value in [json!({"success":false,"ip":"1.1.1.1"}),json!({"success":true,"ip":"8.8.8.8"}),json!({"success":true})]{assert!(super::location_language(&serde_json::to_vec(&value).unwrap(),ip).is_err());}
        let result=super::lookup_location(ip,|lang|Ok(serde_json::to_vec(&json!({"success":true,"ip":"1.1.1.1","country_code":if lang=="en"{"US"}else{"JP"},"country":"fixture"})).unwrap()));
        assert!(result.unwrap_err().contains("不一致"));
    }
    #[test]
    fn bilingual_location_requests_are_bounded_and_keep_missing_fields_unknown(){
        let calls=std::cell::RefCell::new(Vec::new());let ip="1.1.1.1".parse().unwrap();
        let value=super::lookup_location(ip,|lang|{calls.borrow_mut().push(lang.to_string());Ok(serde_json::to_vec(&json!({"success":true,"ip":"1.1.1.1","country_code":"JP","country":if lang=="en"{"Japan"}else{"日本"},"city":if lang=="en"{"Tokyo"}else{"东京"}})).unwrap())}).unwrap();
        assert_eq!(*calls.borrow(),vec!["en","zh-CN"]);assert_eq!(value.country_zh.as_deref(),Some("日本"));assert_eq!(value.city_en.as_deref(),Some("Tokyo"));
        let value=super::lookup_location(ip,|lang|if lang=="zh-CN"{Err("fixture timeout".into())}else{Ok(br#"{"success":true,"ip":"1.1.1.1","country":"Japan","country_code":"JP"}"#.to_vec())}).unwrap();
        assert!(value.country_zh.is_none());assert!(value.city_en.is_none());assert_eq!(value.country_en.as_deref(),Some("Japan"));
        let calls=std::cell::Cell::new(0);assert!(super::lookup_location(ip,|_|{calls.set(calls.get()+1);Err("fixture failure".into())}).is_err());assert_eq!(calls.get(),2,"one query per language, no retry");
    }
    #[test]
    fn location_cache_is_shared_and_scoped_to_the_host(){
        let cache=super::RequestCache::<String,super::VpsLocation>::default();let other=cache.clone();let calls=std::cell::Cell::new(0);
        let read=||{calls.set(calls.get()+1);super::lookup_location("1.1.1.1".parse().unwrap(),|_|Ok(br#"{"success":true,"ip":"1.1.1.1","country":"fixture"}"#.to_vec()))};
        let first=cache.read("host-a".into(),std::time::Duration::from_secs(86400),std::time::Duration::from_secs(1800),read).unwrap();
        let second=other.read("host-a".into(),std::time::Duration::from_secs(86400),std::time::Duration::from_secs(1800),read).unwrap();assert_eq!(calls.get(),1);assert_eq!(first.looked_up_at_unix_ms,second.looked_up_at_unix_ms);
        other.read("host-b".into(),std::time::Duration::from_secs(86400),std::time::Duration::from_secs(1800),read).unwrap();assert_eq!(calls.get(),2);
    }
    #[test]
    fn location_failures_are_cached_without_additional_network_attempts(){
        let cache=super::RequestCache::<String,super::VpsLocation>::default();let calls=std::cell::Cell::new(0);
        for _ in 0..2 {assert!(cache.read("host".into(),std::time::Duration::from_secs(86400),std::time::Duration::from_secs(1800),||{calls.set(calls.get()+1);Err("fixture failure".into())}).is_err());}
        assert_eq!(calls.get(),1);
    }

    #[test]
    fn source_timestamp_is_not_the_time_of_reading() {
        let body=serde_json::to_vec(&json!({"status":"up","updated":"2026-10-16 08:04:01.125Z","info":{"cpu":12}})).unwrap();
        let value=parse_record(&body,"test","one",1,None).unwrap();
        assert_eq!(serde_json::to_value(value).unwrap()["sampledAtUnixMs"],json!(1792137841125u64));
    }
    #[test]
    fn monitored_host_comes_from_the_system_record_not_hub_or_display_name() {
        let body=serde_json::to_vec(&json!({"name":"Japan VPS","host":"1.1.1.1","info":{"h":"different-machine"}})).unwrap();
        assert_eq!(serde_json::to_value(parse_record(&body,"localhost","one",1,None).unwrap()).unwrap()["host"],"1.1.1.1");
        for host in ["", "https://user:password@example.com", "bad\r\nhost", "/var/run/beszel.sock"] {
            let body=serde_json::to_vec(&json!({"name":"Japan VPS","host":host})).unwrap();
            assert!(serde_json::to_value(parse_record(&body,"localhost","one",1,None).unwrap()).unwrap()["host"].is_null());
        }
    }
    #[test]
    fn missing_or_bad_source_time_stays_unknown() {
        for date in ["", "2026-10-18 12:00:00", "2026-02-30T12:00:00Z", "2099-10-18T12:00:00Z"] {
            let body=serde_json::to_vec(&json!({"updated":date,"info":{"cpu":1}})).unwrap();
            assert!(serde_json::to_value(parse_record(&body,"test","one",1,None).unwrap()).unwrap()["sampledAtUnixMs"].is_null(),"{date}");
        }
    }
    #[test]
    fn mixed_metrics_use_the_older_source_and_never_borrow_a_date() {
        let body=serde_json::to_vec(&json!({"updated":"2026-10-18T12:00:00Z","info":{"cpu":1}})).unwrap();
        let stats=json!({"created":"2026-10-16T08:04:01.125Z","stats":{"b":[1,2]}});
        assert_eq!(serde_json::to_value(parse_record(&body,"test","one",1,Some(&stats)).unwrap()).unwrap()["sampledAtUnixMs"],json!(1792137841125u64));
        let stats=json!({"stats":{"b":[1,2]}});
        assert!(serde_json::to_value(parse_record(&body,"test","one",1,Some(&stats)).unwrap()).unwrap()["sampledAtUnixMs"].is_null());
    }

    #[test]
    fn parses_current_beszel_compact_metrics_and_keeps_unknown_services_unknown() {
        let body = serde_json::to_vec(&json!({
            "name": "VPS-LA",
            "status": "up",
            "info": { "u": 183_600, "cpu": 12.5, "mp": 43.0, "dp": 31.0 }
        })).unwrap();
        let stats = json!({ "stats": { "b": [1200, 2400] } });
        let snapshot = parse_record(&body, "Beszel", "ab12cd34ef56gh7", 42, Some(&stats)).unwrap();
        assert_eq!(snapshot.name, "VPS-LA");
        assert_eq!(snapshot.state, "online");
        assert_eq!(snapshot.uptime_seconds, Some(183_600.0));
        assert_eq!(snapshot.latency_ms, Some(42));
        assert_eq!((snapshot.cpu_percent, snapshot.memory_percent, snapshot.disk_percent), (Some(12.5), Some(43.0), Some(31.0)));
        let raw = serde_json::to_value(&snapshot).unwrap();
        assert!(raw.get("uptime").is_none() && raw.get("gauges").is_none() && raw.get("statusMessage").is_none());
        assert_eq!(snapshot.network.upload_bytes, Some(1200.0));
        assert_eq!(snapshot.network.download_bytes, Some(2400.0));
        assert!(snapshot.services.is_empty());
    }

    #[test]
    fn parses_named_metrics_and_down_status() {
        let body = serde_json::to_vec(&json!({
            "name": "Backup",
            "status": "down",
            "info": "{\"Uptime\":3600,\"Cpu\":11,\"MemPct\":52,\"DiskPct\":66}"
        })).unwrap();
        let snapshot = parse_record(&body, "Beszel", "system-1", 10, None).unwrap();
        assert_eq!(snapshot.state, "offline");
        assert_eq!(snapshot.uptime_seconds, Some(3600.0));
        assert_eq!((snapshot.cpu_percent, snapshot.memory_percent, snapshot.disk_percent), (Some(11.0), Some(52.0), Some(66.0)));
    }

    #[test]
    fn invalid_metric_numbers_are_unknown_instead_of_clamped_or_formatted() {
        let body = serde_json::to_vec(&json!({"status":"up","info":{"u":-5,"cpu":101,"mp":-1,"dp":"NaN","ns":-7}})).unwrap();
        let snapshot = parse_record(&body,"Beszel","one",1,None).unwrap();
        assert_eq!((snapshot.uptime_seconds,snapshot.cpu_percent,snapshot.memory_percent,snapshot.disk_percent),(None,None,None,None));
        assert!(snapshot.network.upload_bytes.is_none());
        let serialized=serde_json::to_string(&snapshot).unwrap();
        assert!(!serialized.contains("运行中") && !serialized.contains("gauges") && !serialized.contains("statusMessage"));
    }

    #[test]
    fn validates_hub_urls_and_system_ids() {
        assert!(parse_hub_url("https://beszel.example.com/monitoring/").is_ok());
        assert!(parse_hub_url("http://[::1]:8090").is_ok());
        assert!(parse_hub_url("file://beszel").is_err());
        assert!(parse_hub_url("https://beszel.example.com:bad").is_err());
        assert!(validate_system_id("ab12cd34ef56gh7").is_ok());
        assert!(validate_system_id("bad&id=all").is_err());
    }

    #[test]
    fn classifies_authentication_and_api_failures() {
        assert_eq!(api_error_message(401), "Beszel API 令牌无效或无权读取该系统");
        assert_eq!(api_error_message(403), "Beszel API 令牌无效或无权读取该系统");
        assert_eq!(api_error_message(404), "找不到 Beszel 系统，请检查 System ID 和访问权限");
        assert_eq!(api_error_message(503), "Beszel API 请求失败（HTTP 503）");
    }

    #[test]
    fn credential_format_metadata_distinguishes_jwt_without_revealing_or_verifying_the_token() {
        assert!(jwt_format("eyJhbGciOiJIUzI1NiJ9.eyJpZCI6Im9uZSJ9.signature_test"));
        for token in ["agent-registration-token", "Bearer header.payload.signature", "header..signature", "header.payload.signature.extra", "header.payload.signature\r\n"] {
            assert!(!jwt_format(token));
        }
    }

    #[test]
    #[ignore = "read-only inspection of this application's saved Beszel credential format"]
    fn inspect_current_beszel_token_metadata_readonly() {
        let status = super::inspect_beszel_token().unwrap();
        println!("{}", serde_json::to_string(&status).unwrap());
    }
}

