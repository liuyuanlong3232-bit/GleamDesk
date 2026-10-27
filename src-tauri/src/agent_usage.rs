use std::{path::PathBuf, time::Duration};
use serde::Serialize;
use serde_json::Value;
use crate::{cli_reader, provider_requests::{observed_unix_ms, RequestCache}};

#[derive(Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct CodexActivity{state:&'static str,active_tasks:usize,source:&'static str}
#[cfg(windows)]
fn activity_timestamp(text:&str)->Option<u64>{
 use windows_sys::Win32::{Foundation::{FILETIME,SYSTEMTIME},System::Time::SystemTimeToFileTime};
 if text.len()<20||!text.ends_with('Z'){return None}let part=|a,b|text.get(a..b)?.parse::<u16>().ok();
 let mut value:SYSTEMTIME=unsafe{std::mem::zeroed()};value.wYear=part(0,4)?;value.wMonth=part(5,7)?;value.wDay=part(8,10)?;value.wHour=part(11,13)?;value.wMinute=part(14,16)?;value.wSecond=part(17,19)?;
 let mut file:FILETIME=unsafe{std::mem::zeroed()};if unsafe{SystemTimeToFileTime(&value,&mut file)}==0{return None}
 (((file.dwHighDateTime as u64)<<32)|file.dwLowDateTime as u64).checked_sub(116444736000000000).map(|ticks|ticks/10000)
}
#[cfg(not(windows))]fn activity_timestamp(_: &str)->Option<u64>{None}
#[cfg(test)]fn activity_evidence(text:&str,now:u64)->Option<(&'static str,u64)>{activity_evidence_since(text,now,0)}
fn activity_evidence_since(text:&str,now:u64,session_started:u64)->Option<(&'static str,u64)>{
 let mut state=None;let mut turn=String::new();let mut at=0;let mut latest=0;
 for line in text.lines(){let Ok(value)=serde_json::from_str::<Value>(line)else{continue};let Some(time)=value["timestamp"].as_str().and_then(activity_timestamp)else{continue};if time<session_started||time>now.saturating_add(5000){continue}latest=latest.max(time);
  if value["type"]!="event_msg"||time<at{continue}let payload=&value["payload"];let id=payload["turn_id"].as_str().unwrap_or("");
  match payload["type"].as_str(){Some("task_started")=>{state=Some("running");turn=id.into();at=time},Some("task_complete")|Some("turn_aborted")=>{if !turn.is_empty()&&!id.is_empty()&&turn!=id{continue}state=Some(if payload["type"]=="turn_aborted"||!payload["error"].is_null(){"interrupted"}else{"completed"});at=time},_=>{}}
 }
 let state=state?;Some((if state=="running"&&now.saturating_sub(latest)>30*60*1000{"unknown"}else if state!="running"&&now.saturating_sub(at)>5*60*1000{"idle"}else{state},at))
}
fn collect_activity_paths(root:&std::path::Path,depth:usize,left:&mut usize,out:&mut Vec<(std::time::SystemTime,PathBuf)>){
 if depth>4||*left==0{return}let Ok(entries)=std::fs::read_dir(root)else{return};
 for entry in entries.flatten(){if *left==0{break}*left-=1;let Ok(kind)=entry.file_type()else{continue};let path=entry.path();if kind.is_dir(){collect_activity_paths(&path,depth+1,left,out)}else if kind.is_file()&&entry.file_name().to_str().is_some_and(|name|name.starts_with("rollout-")&&name.ends_with(".jsonl")){if let Ok(modified)=entry.metadata().and_then(|meta|meta.modified()){out.push((modified,path))}}}
}
fn local_codex_activity()->CodexActivity{
 use std::io::{Read,Seek,SeekFrom};
 let unknown=||CodexActivity{state:"unknown",active_tasks:0,source:"local-task-events"};
 let Some(home)=std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(||std::env::var_os("USERPROFILE").map(|home|PathBuf::from(home).join(".codex")))else{return unknown()};
 if home.to_string_lossy().starts_with("\\\\"){return unknown()}let mut files=vec![];collect_activity_paths(&home.join("sessions"),0,&mut 8192,&mut files);files.sort_by(|a,b|b.0.cmp(&a.0));
 let now=observed_unix_ms();let mut active=0;let mut latest=None;let mut uncertain_recent=false;
 for (modified,path) in files.into_iter().take(12){let recent=modified.duration_since(std::time::UNIX_EPOCH).ok().is_some_and(|time|now.saturating_sub(time.as_millis() as u64)<=30*60*1000);let Ok(mut file)=std::fs::File::open(path)else{uncertain_recent|=recent;continue};let Ok(size)=file.metadata().map(|meta|meta.len())else{uncertain_recent|=recent;continue};let mut head=vec![];if (&mut file).take(64*1024).read_to_end(&mut head).is_err(){uncertain_recent|=recent;continue}let header=String::from_utf8_lossy(&head);let session_started=header.lines().next().and_then(|line|serde_json::from_str::<Value>(line).ok()).filter(|value|value["type"]=="session_meta").and_then(|value|value["timestamp"].as_str().and_then(activity_timestamp));let Some(session_started)=session_started else{uncertain_recent|=recent;continue};
  let start=size.saturating_sub(96*1024);if file.seek(SeekFrom::Start(start)).is_err(){uncertain_recent|=recent;continue}let mut bytes=vec![];if file.take(96*1024).read_to_end(&mut bytes).is_err(){uncertain_recent|=recent;continue}let text=String::from_utf8_lossy(&bytes);let text=if start>0{text.split_once('\n').map(|(_,rest)|rest).unwrap_or("")}else{&text};
  if let Some((state,at))=activity_evidence_since(text,now,session_started){if state=="running"{active+=1}if latest.is_none_or(|(_,previous)|at>previous){latest=Some((state,at))}}else{uncertain_recent|=recent}
 }
 CodexActivity{state:if active>0{"running"}else if uncertain_recent{"unknown"}else{latest.map(|(state,_)|state).unwrap_or("unknown")},active_tasks:active,source:"local-task-events"}
}
/// Metadata-only observation. No transcript text, paths, tokens or credentials leave this reader.
#[tauri::command]
pub async fn read_codex_activity(consent:Option<bool>)->Result<CodexActivity,String>{require_usage_consent(consent)?;tauri::async_runtime::spawn_blocking(local_codex_activity).await.map_err(|_|"本机 Codex 任务状态暂时不可用".into())}

fn require_usage_consent(consent:Option<bool>)->Result<(),String>{
    if consent==Some(true){Ok(())}else{Err("未允许读取本机 AI 客户端账号和用量，请在设置中开启".into())}
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow { id: String, used_percent: f64, window_duration_mins: Option<u64>, resets_at_unix_ms: Option<u64>, title: Option<String> }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentObservation {
    id: String, name: String, state: &'static str, installed: bool, running: bool,
    login_status: &'static str, plan: Option<String>, usage_type: &'static str,
    source: &'static str, confidence: &'static str, windows: Vec<UsageWindow>,
    ordinary_usage_allowed: Option<bool>, reason: &'static str,
    observed_at_unix_ms: u64,
    cli_detected: bool, configuration_detected: Option<bool>, cache_detected: Option<bool>, membership: Option<Value>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnapshot { accounts: Vec<AgentObservation>, observed_at_unix_ms: u64 }
#[derive(Default)]
pub struct AgentUsageState { cache: RequestCache<(), AgentSnapshot>, runtime_cache: RequestCache<(), AgentRuntimeSnapshot> }
impl AgentUsageState { pub fn metrics(&self)->Option<crate::provider_requests::RequestMetrics>{self.cache.metrics()} }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct AgentRuntimeClient { id:String, process_count:u32 }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct AgentRuntimeSnapshot { available:bool, partial:bool, observed_at_unix_ms:u64, clients:Vec<AgentRuntimeClient> }
const CLIENT_CATALOG:&str=include_str!("../../src/domain/agent/clientCatalog.json");
// Read only the process identity. Script tokens stay inside this helper; no
// arguments, paths, credentials or conversation text leave its output.
const RUNTIME_SCRIPT:&str=r#"
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$catalog=@($request.catalog)
if($request.PSObject.Properties.Name -contains 'processes'){$processes=@($request.processes)}else{
 $names=@($catalog | ForEach-Object {$_.executables})+@('node.exe','bun.exe','python.exe','pythonw.exe')
 $filter=(@($names | Select-Object -Unique | ForEach-Object {"Name = '$_'"}) -join ' OR ')
 $filter='('+$filter+') AND SessionId = '+[Diagnostics.Process]::GetCurrentProcess().SessionId
 $processes=@(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop | Select-Object -First 4096 ProcessId,ParentProcessId,Name,CommandLine)
}
function Arguments($command){
 if(!$command -or $command.Length -gt 32768){return ''}
 return ([regex]::Replace($command,'^\s*(?:"[^"]*"|\S+)\s*','')).Trim()
}
function ScriptToken($arguments){
 $remaining=$arguments
 for($i=0;$i -lt 8;$i++){
  $match=[regex]::Match($remaining,'^(?:"(?<quoted>[^"]*)"|(?<bare>\S+))')
  if(!$match.Success){return ''}
  $token=if($match.Groups['quoted'].Success){$match.Groups['quoted'].Value}else{$match.Groups['bare'].Value}
  $remaining=$remaining.Substring($match.Length).TrimStart()
  if($token -in @('-e','--eval','-c','--command','--require','-r','--loader','--import')){return ''}
  if($token.StartsWith('-')){continue}
  return $token.Replace('\','/').ToLowerInvariant()
 }
 return ''
}
$found=@{}
$partial=$false
foreach($process in $processes){
 $name=([string]$process.Name).ToLowerInvariant()
 $arguments=Arguments ([string]$process.CommandLine)
 if($process.ParentProcessId -eq $request.ownerPid -and (($name -eq 'codex.exe' -and $arguments -match '^app-server(?:\s|$)') -or ($name -eq 'claude.exe' -and $arguments -match '^auth\s+status(?:\s|$)'))){continue}
 $interpreter=$name -in @('node.exe','bun.exe','python.exe','pythonw.exe')
 if($interpreter -and !$process.CommandLine){$partial=$true;continue}
 $script=if($interpreter){ScriptToken $arguments}else{''}
 $module=if($name -in @('python.exe','pythonw.exe') -and $arguments -match '^-m\s+([A-Za-z0-9_.]+)(?:\s|$)'){$matches[1]}else{''}
 foreach($client in $catalog){
  $matched=$client.executables -contains $name
  if(!$matched -and $interpreter){
   foreach($marker in $client.scripts){if($script.Contains($marker)){$matched=$true;break}}
   if(!$matched -and $script.EndsWith('.exe')){$matched=$client.executables -contains (($script -split '/')[-1])}
   foreach($prefix in $client.modules){if($module -eq $prefix -or $module.StartsWith($prefix+'.')){$matched=$true;break}}
  }
  if($matched){if(!$found.ContainsKey($client.id)){$found[$client.id]=0};$found[$client.id]++}
 }
}
$clients=@(foreach($client in $catalog){if($found.ContainsKey($client.id)){@{id=$client.id;processCount=$found[$client.id]}}})
@{available=$true;partial=$partial;clients=$clients} | ConvertTo-Json -Compress -Depth 4
"#;
fn runtime_snapshot(value:Value)->AgentRuntimeSnapshot {
 let catalog:Vec<Value>=serde_json::from_str(CLIENT_CATALOG).unwrap_or_default();
 let clients=if value["available"]==true {catalog.iter().filter_map(|client|{
  let id=client["id"].as_str()?;
  let count=value["clients"].as_array()?.iter().filter(|row|row["id"]==id).filter_map(|row|row["processCount"].as_u64()).filter(|count|*count>0&&*count<=4096).max()?;
  Some(AgentRuntimeClient{id:id.into(),process_count:count as u32})
 }).collect()}else{vec![]};
 AgentRuntimeSnapshot{available:value["available"]==true,partial:value["partial"]==true,observed_at_unix_ms:observed_unix_ms(),clients}
}
#[cfg(windows)]
fn runtime_helper(request:&Value)->Value {
 let system=std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(||PathBuf::from("C:\\Windows"));
 let body=serde_json::to_vec(request).unwrap_or_default();
 cli_reader::read_cli_json_input(&system.join("System32/WindowsPowerShell/v1.0/powershell.exe"),&["-NoProfile","-NonInteractive","-Command",RUNTIME_SCRIPT],Duration::from_secs(6),Some(&body)).unwrap_or(Value::Null)
}
fn load_runtime()->AgentRuntimeSnapshot {
 #[cfg(windows)] {runtime_snapshot(runtime_helper(&serde_json::json!({"catalog":serde_json::from_str::<Value>(CLIENT_CATALOG).unwrap_or(Value::Null),"ownerPid":std::process::id()})))}
 #[cfg(not(windows))] {runtime_snapshot(Value::Null)}
}
#[tauri::command]
pub async fn read_agent_runtime(state:tauri::State<'_,AgentUsageState>)->Result<AgentRuntimeSnapshot,String>{
 let cache=state.runtime_cache.clone();
 tauri::async_runtime::spawn_blocking(move||cache.read((),Duration::from_secs(4),Duration::from_secs(7),||Ok(load_runtime())))
 .await.map_err(|_|"Agent 运行识别暂不可用".to_string())?
}

fn account(id: &str, name: &str) -> AgentObservation {
    AgentObservation { id: id.into(), name: name.into(), state: "unknown", installed: false, running: false,
        login_status: "unknown", plan: None, usage_type: "subscription", source: "none", confidence: "unknown",
        windows: Vec::new(), ordinary_usage_allowed: None, reason: "no-source", observed_at_unix_ms: observed_unix_ms(), cli_detected: false, configuration_detected: None, cache_detected: None, membership: None }
}
fn bounded_text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty() && text.len() <= 64 && !text.chars().any(char::is_control)).map(str::to_owned)
}
fn usage_window(id: &str, value: &Value) -> Option<UsageWindow> {
    let used_percent = value.get("usedPercent")?.as_f64().filter(|value| value.is_finite() && (0.0..=100.0).contains(value))?;
    let window_duration_mins = value.get("windowDurationMins").and_then(Value::as_u64).filter(|value| *value > 0 && *value <= 527_040);
    let resets_at_unix_ms = value.get("resetsAt").and_then(Value::as_u64).and_then(|value| value.checked_mul(1000)).filter(|value| *value <= 253_402_300_799_999);
    Some(UsageWindow { id: id.into(), used_percent, window_duration_mins, resets_at_unix_ms, title: None })
}
pub(crate) fn codex_observation(account_reply: &Value, limits: &Value) -> AgentObservation {
    let mut result = account("codex", "Codex"); result.installed = true; result.cli_detected = true; result.source = "codex-cli";
    let auth = &account_reply["account"];
    if auth.is_null() { result.login_status = "not-logged-in"; result.reason = "not-logged-in"; return result; }
    result.login_status = "configured";
    result.plan = bounded_text(auth.get("planType"));
    if auth.get("type").and_then(Value::as_str) != Some("chatgpt") { result.reason = "unsupported-account"; return result; }
    let snapshot = if let Some(buckets) = limits.get("rateLimitsByLimitId").and_then(Value::as_object) {
        buckets.get("codex")
    } else { limits.get("rateLimits").filter(|snapshot| snapshot.get("limitId").and_then(Value::as_str).is_none_or(|id| id == "codex")) };
    if let Some(snapshot) = snapshot {
        result.plan = bounded_text(snapshot.get("planType")).or(result.plan);
        for key in ["primary", "secondary"] { if let Some(window) = snapshot.get(key).and_then(|value| usage_window(key, value)) { result.windows.push(window); } }
    }
    result.ordinary_usage_allowed = limits.get("ordinaryUsageAllowed").and_then(Value::as_bool);
    if result.windows.is_empty() { result.reason = "quota-unavailable"; }
    else {
        result.login_status = "verified"; result.confidence = "verified"; result.source = "codex-cli-official-rpc"; result.reason = "";
        result.state = if result.ordinary_usage_allowed == Some(false) || result.windows.iter().any(|window| window.used_percent >= 100.0) { "warning" } else { "normal" };
    }
    result
}
pub(crate) fn claude_observation(value: &Value) -> AgentObservation {
    let mut result = account("claude", "Claude Code"); result.installed = true; result.cli_detected = true; result.source = "claude-cli-auth-status";
    result.login_status = match value.get("loggedIn").and_then(Value::as_bool) { Some(true) => "configured", Some(false) => "not-logged-in", None => "unknown" };
    result.plan = bounded_text(value.get("subscriptionType"));
    if value["authMethod"]=="api_key" || value["authMethod"]=="apiKey" {result.usage_type="api";}
    result.reason = if result.login_status == "not-logged-in" { "not-logged-in" } else { "no-quota-source" };
    result
}

fn executable(name: &str) -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH").map(|paths| std::env::split_paths(&paths).take(64).map(|path| path.join(name)).collect()).unwrap_or_default();
    if let Some(home) = home {
        candidates.extend([home.join(".local/bin").join(name), home.join("AppData/Local/Programs").join(name)]);
        if name == "codex.exe" {
            let root = home.join("AppData/Local/OpenAI/Codex/bin");
            if let Ok(entries) = std::fs::read_dir(root) {
                let mut versions: Vec<_> = entries.take(32).filter_map(Result::ok).map(|entry| entry.path().join(name)).filter(|path| path.is_file()).collect();
                versions.sort_by_key(|path| std::fs::metadata(path).and_then(|meta| meta.modified()).ok()); versions.reverse(); candidates.extend(versions);
            }
        }
    }
    candidates.into_iter().find(|path| path.is_absolute() && path.is_file())
}
const METADATA_SCRIPT: &str = r#"
$ErrorActionPreference='Stop'
$roots=@('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
$apps=@(foreach($root in $roots){Get-ItemProperty -Path ($root+'\*') -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -match '^(Antigravity|豆包|Doubao)(\s|$)'} | Select-Object DisplayName,DisplayVersion})
$processes=@(Get-Process -Name 'Antigravity','Doubao','豆包','codex','claude' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName)
@{antigravityInstalled=(@($apps | Where-Object {$_.DisplayName -match '^Antigravity'}).Count -gt 0);doubaoInstalled=(@($apps | Where-Object {$_.DisplayName -match '^(豆包|Doubao)'}).Count -gt 0);antigravityRunning=($processes -contains 'Antigravity');doubaoRunning=(($processes -contains 'Doubao') -or ($processes -contains '豆包'));codexRunning=($processes -contains 'codex');claudeRunning=($processes -contains 'claude');antigravityCli=[bool](Get-Command antigravity -ErrorAction SilentlyContinue);antigravityConfiguration=(Test-Path -LiteralPath (Join-Path $env:APPDATA 'Antigravity\User\settings.json'));antigravityCache=(Test-Path -LiteralPath (Join-Path $env:APPDATA 'Antigravity\Cache'))} | ConvertTo-Json -Compress
"#;
fn metadata() -> Value {
    #[cfg(windows)] {
        let system = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        return cli_reader::read_cli_json(&system.join("System32/WindowsPowerShell/v1.0/powershell.exe"), &["-NoProfile", "-NonInteractive", "-Command", METADATA_SCRIPT], Duration::from_secs(6)).unwrap_or(Value::Null);
    }
    #[cfg(not(windows))] { Value::Null }
}
fn load(app:Option<&tauri::AppHandle>) -> AgentSnapshot {
    let metadata = metadata();
    let mut codex = executable("codex.exe").map(|path| match cli_reader::read_codex_usage(&path) {
        Ok((auth, quotas)) => codex_observation(&auth, &quotas),
        Err(error) => {
            #[cfg(test)] eprintln!("Codex CLI inspection failed at {}: {}", path.display(), error);
            #[cfg(not(test))] let _ = error;
            let mut result = account("codex", "Codex"); result.installed = true; result.source = "codex-cli"; result.reason = "read-failed"; result
        }
    }).unwrap_or_else(|| account("codex", "Codex"));
    codex.running = metadata["codexRunning"].as_bool().unwrap_or(false);
    let mut claude = executable("claude.exe").map(|path| match cli_reader::read_cli_json(&path, &["auth", "status", "--json"], Duration::from_secs(10)) {
        Ok(value) => claude_observation(&value),
        Err(_) => { let mut result = account("claude", "Claude Code"); result.installed = true; result.source = "claude-cli-auth-status"; result.reason = "read-failed"; result }
    }).unwrap_or_else(|| account("claude", "Claude Code"));
    claude.running = metadata["claudeRunning"].as_bool().unwrap_or(false);
    if claude.login_status=="configured" && claude.usage_type!="api" {
        if let Some(path)=executable("claude.exe") {match cli_reader::read_claude_usage(&path){Ok(value)=>apply_claude_usage(&mut claude,&value),Err(_)=>claude.reason="read-failed"}}
    }
    let local = |id: &str, name: &str, key: &str| {
        let mut result = account(id, name);
        result.installed = metadata[format!("{key}Installed")].as_bool().unwrap_or(false);
        result.running = metadata[format!("{key}Running")].as_bool().unwrap_or(false);
        result.cli_detected = metadata[format!("{key}Cli")].as_bool().unwrap_or(false);
        result.configuration_detected = metadata[format!("{key}Configuration")].as_bool();
        result.cache_detected = metadata[format!("{key}Cache")].as_bool();
        if !metadata.is_null() { result.source = "windows-client-metadata"; }
        result
    };
    let mut antigravity=local("antigravity","Antigravity","antigravity");
    #[cfg(windows)] antigravity_quota(&mut antigravity);
    let mut doubao=local("doubao","豆包","doubao");let member=app.map(|app|crate::doubao_membership::snapshot(app,true)).unwrap_or(Value::Null);
    if member["available"]==true{doubao.login_status="verified";doubao.source="doubao-member-page";doubao.confidence="local";doubao.reason="";doubao.state="normal";doubao.plan=bounded_text(member.get("planName"));doubao.membership=Some(member);}
    AgentSnapshot { accounts: vec![codex, claude, antigravity, doubao, account("gemini", "Gemini（预留）")], observed_at_unix_ms: observed_unix_ms() }
}
#[tauri::command]
pub async fn read_agent_usage(app:tauri::AppHandle,state: tauri::State<'_, AgentUsageState>,force:Option<bool>,consent:Option<bool>) -> Result<AgentSnapshot, String> {
    require_usage_consent(consent)?;
    let cache = state.cache.clone();
    tauri::async_runtime::spawn_blocking(move || cache.read((), if force==Some(true){Duration::ZERO}else{Duration::from_secs(300)}, Duration::from_secs(10), || Ok(load(Some(&app)))))
        .await.map_err(|_| "Agent 状态读取任务失败".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn usage_and_task_reads_require_explicit_consent(){
        assert!(require_usage_consent(None).is_err());
        assert!(require_usage_consent(Some(false)).is_err());
        assert!(require_usage_consent(Some(true)).is_ok());
    }
    #[test]
    fn runtime_catalog_is_shared_and_runtime_output_has_no_process_arguments(){
        let catalog:Vec<Value>=serde_json::from_str(CLIENT_CATALOG).unwrap();
        let mut ids=std::collections::HashSet::new();
        for client in &catalog {
            assert!(ids.insert(client["id"].as_str().unwrap()));
            assert!(client["url"].as_str().unwrap().starts_with("https://"));
            for name in client["executables"].as_array().unwrap(){let name=name.as_str().unwrap();assert!(name.ends_with(".exe")&&!name.contains('\''));}
        }
        assert_eq!(ids.len(),22);
        let snapshot=runtime_snapshot(serde_json::json!({"available":true,"clients":[{"id":"cursor","processCount":3,"commandLine":"private-secret"},{"id":"cursor","processCount":2},{"id":"unknown","processCount":7},{"id":"gemini","processCount":-1}]}));
        assert_eq!(snapshot.clients.len(),1);assert_eq!(snapshot.clients[0].id,"cursor");assert_eq!(snapshot.clients[0].process_count,3);
        assert!(!serde_json::to_string(&snapshot).unwrap().contains("secret"));
        assert!(runtime_snapshot(serde_json::json!({"available":false,"clients":[{"id":"cursor","processCount":1}]})).clients.is_empty());
    }
    #[cfg(windows)]
    #[test]
    fn runtime_detection_uses_fixture_processes_and_does_not_match_prompt_keywords(){
        let catalog:Vec<Value>=serde_json::from_str(CLIENT_CATALOG).unwrap();
        let mut processes=vec![];
        for (index,client) in catalog.iter().enumerate(){
            let (name,command)=if let Some(name)=client["executables"].as_array().unwrap().first().and_then(Value::as_str){(name.to_owned(),format!("\"C:\\fixture\\{name}\""))}
            else {let marker=client["scripts"][0].as_str().unwrap();("node.exe".into(),format!("node.exe \"C:/fixture{marker}cli.js\""))};
            processes.push(serde_json::json!({"ProcessId":index+100,"ParentProcessId":2,"Name":name,"CommandLine":command}));
        }
        processes.extend([
            serde_json::json!({"ProcessId":300,"ParentProcessId":2,"Name":"node.exe","CommandLine":"node.exe C:/fixture/node_modules/@google/gemini-cli/dist/index.js --token must-not-leave-helper"}),
            serde_json::json!({"ProcessId":301,"ParentProcessId":2,"Name":"python.exe","CommandLine":"python.exe -m kimi_cli --private must-not-leave-helper"}),
            serde_json::json!({"ProcessId":302,"ParentProcessId":2,"Name":"node.exe","CommandLine":"node.exe C:/fixture/editor.js say @google/gemini-cli and copilot"}),
            serde_json::json!({"ProcessId":303,"ParentProcessId":2,"Name":"Code.exe","CommandLine":"Code.exe --extension cline"}),
            serde_json::json!({"ProcessId":304,"ParentProcessId":999,"Name":"codex.exe","CommandLine":"codex.exe app-server --listen stdio://"}),
            serde_json::json!({"ProcessId":305,"ParentProcessId":999,"Name":"claude.exe","CommandLine":"claude.exe auth status --json"}),
            serde_json::json!({"ProcessId":306,"ParentProcessId":2,"Name":"node.exe","CommandLine":"node.exe --eval \"require('@google/gemini-cli')\""}),
        ]);
        let value=runtime_helper(&serde_json::json!({"catalog":catalog,"ownerPid":999,"processes":processes}));
        assert_eq!(value["available"],true,"fixture helper did not finish");
        let snapshot=runtime_snapshot(value);
        assert_eq!(snapshot.clients.len(),22);
        let count=|id:&str|snapshot.clients.iter().find(|client|client.id==id).unwrap().process_count;
        assert_eq!(count("codex"),1);assert_eq!(count("claude"),1);assert_eq!(count("gemini"),2);assert_eq!(count("kimi"),2);
        assert!(!serde_json::to_string(&snapshot).unwrap().contains("must-not-leave-helper"));
    }
    #[cfg(windows)]
    #[test]
    fn codex_activity_uses_task_events_not_text_mentions_or_file_touches(){
        let now=activity_timestamp("2026-10-14T12:01:00Z").unwrap();
        let start=r#"{"timestamp":"2026-10-14T12:00:00Z","type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}"#;
        assert_eq!(activity_evidence(start,now),Some(("running",now-60000)));
        let mention=r#"{"timestamp":"2026-10-14T12:00:10Z","type":"event_msg","payload":{"type":"agent_message","message":"task_complete @GPT"}}"#;
        assert_eq!(activity_evidence(mention,now),None);
        let end=r#"{"timestamp":"2026-10-14T12:00:30Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"a"}}"#;
        assert_eq!(activity_evidence(&format!("{start}\n{end}"),now),Some(("completed",now-30000)));
        assert_eq!(activity_evidence(start,now+31*60*1000).unwrap().0,"unknown");
        assert_eq!(activity_evidence_since(start,now,now-30000),None);
        let other=r#"{"timestamp":"2026-10-14T12:00:30Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"other"}}"#;
        assert_eq!(activity_evidence(&format!("{start}\n{other}"),now).unwrap().0,"running");
        let failed=r#"{"timestamp":"2026-10-14T12:00:30Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"a","error":{"message":"fixture failure"}}}"#;
        assert_eq!(activity_evidence(&format!("{start}\n{failed}"),now).unwrap().0,"interrupted");
    }
    #[test]
    fn no_login_and_api_key_do_not_invent_subscription_quotas() {
        let result = codex_observation(&serde_json::json!({"account":null}), &Value::Null);
        assert_eq!(result.login_status, "not-logged-in"); assert!(result.windows.is_empty()); assert_eq!(result.confidence, "unknown");
        assert!(codex_observation(&serde_json::json!({"account":{"type":"apiKey"}}), &Value::Null).windows.is_empty());
    }
    #[test]
    fn codex_uses_named_bucket_and_preserves_two_real_windows() {
        let result = codex_observation(&serde_json::json!({"account":{"type":"chatgpt","planType":"plus","email":"must-not-be-returned"}}), &serde_json::json!({"ordinaryUsageAllowed":true,"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":20,"windowDurationMins":300,"resetsAt":1791365412},"secondary":{"usedPercent":3,"windowDurationMins":10080,"resetsAt":1791952212}}}}));
        assert_eq!(result.windows.len(), 2); assert_eq!(result.windows[0].used_percent, 20.0); assert_eq!(result.windows[0].resets_at_unix_ms, Some(1791365412000));
        assert_eq!(result.confidence, "verified"); assert!(!serde_json::to_string(&result).unwrap().contains("must-not-be-returned"));
    }
    #[test]
    fn another_bucket_or_malformed_percent_is_unknown_instead_of_a_guess() {
        let auth = serde_json::json!({"account":{"type":"chatgpt"}});
        assert!(codex_observation(&auth, &serde_json::json!({"rateLimitsByLimitId":{"other":{}},"rateLimits":{"primary":{"usedPercent":50}}})).windows.is_empty());
        assert!(codex_observation(&auth, &serde_json::json!({"rateLimits":{"primary":{"usedPercent":101}}})).windows.is_empty());
    }
    #[test]
    fn claude_login_metadata_is_not_a_quota_source() {
        for logged_in in [false, true] {
            let result = claude_observation(&serde_json::json!({"loggedIn":logged_in,"subscriptionType":"pro","email":"private"}));
            assert!(result.windows.is_empty()); assert_eq!(result.confidence, "unknown"); assert!(!serde_json::to_string(&result).unwrap().contains("private"));
        }
    }
    #[test]
    fn claude_engine_quota_requires_readings_not_just_a_plan(){
        let mut result=claude_observation(&serde_json::json!({"loggedIn":true,"subscriptionType":"pro"}));
        apply_claude_usage(&mut result,&serde_json::json!({"rate_limits_available":false,"subscription_type":"pro"}));assert!(result.windows.is_empty());assert_eq!(result.confidence,"unknown");
        apply_claude_usage(&mut result,&serde_json::json!({"rate_limits_available":true,"subscription_type":"max","rate_limits":{"five_hour":{"utilization":0,"resets_at":"2026-10-15T12:00:00Z"},"seven_day":{"utilization":37},"seven_day_opus":{"utilization":101},"limits":[{"kind":"weekly_scoped","percent":70,"scope":{"model":{"display_name":"Fable"}}}]}}));
        assert_eq!(result.plan.as_deref(),Some("max"));assert_eq!(result.source,"claude-engine-get-usage");assert_eq!(result.windows.len(),3);assert_eq!(result.windows[0].used_percent,0.);assert!(result.windows[0].resets_at_unix_ms.is_some());assert_eq!(result.confidence,"verified");
    }
    #[test]
    fn antigravity_summary_follows_upstream_envelopes_union_values_and_bucket_names(){
        let groups=serde_json::json!([{"displayName":"Gemini Models","buckets":[{"bucketId":"gemini_weekly","displayName":"Weekly Limit","remaining":{"case":"remainingFraction","value":0.25},"resetTime":"2026-10-20T00:00:00Z"},{"bucketId":"gemini-five-hour","displayName":"Five Hour Limit","remainingFraction":1.0},{"bucketId":"disabled","disabled":true,"remainingFraction":0}]}]);
        for value in [serde_json::json!({"groups":groups}),serde_json::json!({"summary":{"groups":groups}}),serde_json::json!({"response":{"groups":groups}})]{let rows=antigravity_summary(&value).unwrap();assert_eq!(rows.len(),2);assert_eq!(rows[0].used_percent,75.);assert_eq!(rows[0].window_duration_mins,Some(10080));assert_eq!(rows[1].used_percent,0.);assert_eq!(rows[1].window_duration_mins,Some(300));assert!(rows[0].title.as_ref().unwrap().contains("Weekly Limit"));}
    }
    #[test]
    fn antigravity_empty_inventory_does_not_invent_or_reuse_legacy_quota(){
        assert!(antigravity_summary(&serde_json::json!({"groups":[]})).unwrap().is_empty());assert!(antigravity_summary(&serde_json::json!({"other":[]})).is_none());
        let duplicate=serde_json::json!({"groups":[{"buckets":[{"bucketId":"a","remainingFraction":0.5},{"bucketId":"a","remainingFraction":0.8}]}]});assert!(antigravity_summary(&duplicate).is_none());
        let malformed=serde_json::json!({"groups":[{"buckets":[{"bucketId":"bad","remainingFraction":-1},{"bucketId":"missing"}]}]});assert!(antigravity_summary(&malformed).unwrap().is_empty());
    }
    #[test]
    fn antigravity_legacy_groups_aliases_without_including_auxiliary_models(){
        let value=serde_json::json!({"userStatus":{"userTier":{"name":"Pro"},"cascadeModelConfigData":{"clientModelConfigs":[{"modelOrAlias":{"model":"gemini-a"},"quotaInfo":{"remainingFraction":0.7}},{"label":"Gemini B","quotaInfo":{"remainingFraction":0.2}},{"label":"Claude C","quotaInfo":{"remainingFraction":0.8}},{"label":"GPT D","quotaInfo":{"remainingFraction":0.4}},{"label":"Gemini Image","quotaInfo":{"remainingFraction":0.0}},{"label":"aux autocomplete","quotaInfo":{"remainingFraction":0.0}}]}}});
        let (plan,rows)=antigravity_status(&value);assert_eq!(plan.as_deref(),Some("Pro"));assert_eq!(rows.len(),2);assert!((rows[0].used_percent-80.).abs()<0.001);assert!((rows[1].used_percent-60.).abs()<0.001);assert!(rows.iter().all(|row|row.window_duration_mins.is_none()));
        assert!(antigravity_status(&Value::Null).1.is_empty());
    }
    #[test]
    fn claude_scoped_limits_replace_legacy_family_and_failure_clears_windows(){
        let mut result=claude_observation(&serde_json::json!({"loggedIn":true}));apply_claude_usage(&mut result,&serde_json::json!({"rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":10},"seven_day_opus":{"utilization":20},"limits":[{"kind":"weekly_scoped","scope":{"model":{"display_name":"Opus"}},"percent":30}]}}));
        assert_eq!(result.windows.len(),2);assert_eq!(result.windows[1].used_percent,30.);
        apply_claude_usage(&mut result,&serde_json::json!({"rate_limits_available":false}));assert!(result.windows.is_empty());assert_eq!(result.confidence,"unknown");
    }
    #[test]
    #[ignore = "read-only inspection of installed clients and existing Codex account"]
    fn inspect_native_agent_sources_without_returning_credentials() {
        let snapshot = load(None);
        assert_eq!(snapshot.accounts.len(), 5);
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains("email") && !json.contains("access_token") && !json.contains("accountId"));
        println!("{}", json);
    }
}

pub(crate) fn timestamp_ms(value:&Value)->Option<u64>{
    let text=value.as_str()?;if text.len()>64||!text.is_ascii(){return None;}
    let connection=rusqlite::Connection::open_in_memory().ok()?;
    let seconds:Option<i64>=connection.query_row("SELECT unixepoch(?1)",[text],|row|row.get(0)).ok()?;
    u64::try_from(seconds?).ok()?.checked_mul(1000)
}

// Adapted from Agent HUD Open ClaudeUsage / ClaudeEngineUsage (Apache-2.0).
fn apply_claude_usage(result:&mut AgentObservation,payload:&Value){
    result.windows.clear();result.confidence="unknown";result.state="unknown";
    if payload["rate_limits_available"]!=true{result.reason="no-quota-source";return}
    result.plan=bounded_text(payload.get("subscription_type")).or_else(||result.plan.take());
    let usage=&payload["rate_limits"];
    for (key,label,minutes) in [("five_hour","5 小时额度",300),("seven_day","周额度",10080),("seven_day_sonnet","Sonnet 周额度",10080),("seven_day_opus","Opus 周额度",10080)]{
        let row=&usage[key];let Some(percent)=row["utilization"].as_f64().filter(|value|value.is_finite()&&(0.0..=100.0).contains(value))else{continue;};
        result.windows.push(UsageWindow{id:key.into(),used_percent:percent,window_duration_mins:Some(minutes),resets_at_unix_ms:timestamp_ms(&row["resets_at"]),title:Some(label.into())});
    }
    for row in usage["limits"].as_array().into_iter().flatten().take(16){
        if row["kind"]!="weekly_scoped"{continue}
        let Some(percent)=valid_percent(&row["percent"])else{continue};
        let model=&row["scope"]["model"];let Some(name)=bounded_text(model.get("display_name")).or_else(||bounded_text(model.get("id")))else{continue};
        let family=name.to_lowercase();let id=if family.contains("sonnet"){"seven_day_sonnet".into()}else if family.contains("opus"){"seven_day_opus".into()}else{format!("weekly:{family}")};
        let window=UsageWindow{id:id.clone(),used_percent:percent,window_duration_mins:Some(10080),resets_at_unix_ms:timestamp_ms(&row["resets_at"]),title:Some(format!("{name} 周额度"))};
        if let Some(previous)=result.windows.iter_mut().find(|window|window.id==id){*previous=window}else{result.windows.push(window)}
    }
    finish_quota(result,"claude-engine-get-usage");
}

fn valid_percent(value:&Value)->Option<f64>{value.as_f64().filter(|value|value.is_finite()&&(0.0..=100.0).contains(value))}
fn finish_quota(result:&mut AgentObservation,source:&'static str){
    if result.windows.is_empty(){result.reason="quota-unavailable";return}
    result.source=source;result.confidence="verified";result.login_status="verified";result.reason="";result.state=if result.windows.iter().any(|row|row.used_percent>=100.){"warning"}else{"normal"};
}

// Quota schema and period naming ported from Agent HUD Open AntigravityClient.
fn antigravity_summary(value:&Value)->Option<Vec<UsageWindow>>{
    let groups=value.pointer("/response/groups").or_else(||value.pointer("/summary/groups")).or_else(||value.get("groups"))?.as_array()?;
    let mut rows=vec![];let mut ids=std::collections::HashSet::new();
    for group in groups.iter().take(16){
        let buckets=group["buckets"].as_array()?;
        for bucket in buckets.iter().take(16){
            if bucket["disabled"]==true{continue}
            let id=bounded_text(bucket.get("bucketId"))?;if !ids.insert(id.clone()){return None}
            let remaining=bucket["remainingFraction"].as_f64().or_else(||bucket["remaining"]["remainingFraction"].as_f64()).or_else(||(bucket["remaining"]["case"]=="remainingFraction").then(||bucket["remaining"]["value"].as_f64()).flatten()).filter(|fraction|fraction.is_finite()&&(0.0..=1.0).contains(fraction));
            let Some(remaining)=remaining else{continue};
            let label=bounded_text(bucket.get("displayName")).unwrap_or_else(||id.clone());
            let cadence=format!("{id} {label}").to_lowercase().replace(['_','-']," ");
            let minutes=if cadence.contains("weekly"){Some(10080)}else if cadence.contains("five hour")||cadence.contains("5 hour"){Some(300)}else{None};
            let title=bounded_text(group.get("displayName")).map(|group|format!("{group} · {label}")).unwrap_or(label);
            rows.push(UsageWindow{id:format!("antigravity:{id}"),used_percent:(1.-remaining)*100.,window_duration_mins:minutes,resets_at_unix_ms:timestamp_ms(&bucket["resetTime"]),title:Some(title)});
        }
    }
    Some(rows)
}

fn antigravity_status(value:&Value)->(Option<String>,Vec<UsageWindow>){
    let status=&value["userStatus"];let plan=bounded_text(status.pointer("/userTier/name")).or_else(||bounded_text(status.pointer("/planStatus/planInfo/planName")));
    let mut rows:Vec<UsageWindow>=vec![];
    for row in status["cascadeModelConfigData"]["clientModelConfigs"].as_array().into_iter().flatten().take(32){
        let Some(remaining)=row["quotaInfo"]["remainingFraction"].as_f64().filter(|value|value.is_finite()&&(0.0..=1.0).contains(value))else{continue};
        let model=bounded_text(row.pointer("/modelOrAlias/model")).unwrap_or_default();let label=bounded_text(row.get("label")).unwrap_or_else(||model.clone());
        let lower=format!("{model} {label}").to_lowercase();if ["lite","autocomplete","image"].iter().any(|name|lower.contains(name)){continue}
        let (family,title)=if lower.contains("gemini"){("gemini","Gemini 模型")}else if lower.contains("claude")||lower.contains("gpt"){("claude-gpt","Claude / GPT 模型")}else{(model.as_str(),label.as_str())};
        if family.is_empty(){continue}let used=(1.-remaining)*100.;let reset=timestamp_ms(&row["quotaInfo"]["resetTime"]);let id=format!("antigravity:legacy:{family}");
        if let Some(previous)=rows.iter_mut().find(|window|window.id==id){if previous.used_percent<used{previous.used_percent=used;previous.resets_at_unix_ms=reset}}
        else{rows.push(UsageWindow{id,used_percent:used,window_duration_mins:None,resets_at_unix_ms:reset,title:Some(title.into())})}
    }
    (plan,rows)
}

#[cfg(windows)]
fn antigravity_quota(result:&mut AgentObservation){
    if !result.running{return;}
    result.reason="quota-unavailable";
    let Ok(powershell)=crate::network_tools::system_executable("WindowsPowerShell/v1.0/powershell.exe")else{return;};
    let Ok(curl)=crate::network_tools::system_executable("curl.exe")else{return;};
    let Ok(mut detected)=cli_reader::read_cli_json(&powershell,&["-NoProfile","-NonInteractive","-Command",include_str!("antigravity-discovery.ps1")],Duration::from_secs(6))else{return;};
    let deadline=std::time::Instant::now()+Duration::from_secs(7);
    let candidates=detected["candidates"].as_array().cloned().unwrap_or_default();
    'outer:for mut candidate in candidates.into_iter().take(3){
        let Some(token)=candidate["token"].as_str().filter(|token|!token.is_empty()&&token.len()<=1024&&token.bytes().all(|b|b.is_ascii_alphanumeric()||b"-_.+/=".contains(&b)))else{continue;};
        let token=token.to_owned();candidate["token"]=Value::Null;
        for port in candidate["ports"].as_array().into_iter().flatten().take(4).filter_map(Value::as_u64).filter(|port|*port>0&&*port<=65535){
            for method in ["RetrieveUserQuotaSummary","GetUserStatus"]{
                if std::time::Instant::now()>=deadline{break 'outer;}
                let body=if method=="RetrieveUserQuotaSummary"{r#"{\"forceRefresh\":true}"#}else{r#"{\"metadata\":{\"ideName\":\"antigravity\",\"extensionName\":\"antigravity\",\"ideVersion\":\"unknown\",\"locale\":\"en\"}}"#};
                let config=format!("url = \"https://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{method}\"\nrequest = \"POST\"\nheader = \"Content-Type: application/json\"\nheader = \"X-Codeium-Csrf-Token: {token}\"\nheader = \"Connect-Protocol-Version: 1\"\ndata = \"{body}\"\nnoproxy = \"*\"\nproto = \"=https\"\ninsecure\nfail\nsilent\nmax-time = 2\nconnect-timeout = 1\n");
                let mut input=config.into_bytes();let remaining=deadline.saturating_duration_since(std::time::Instant::now());
                let response=cli_reader::read_cli_json_input(&curl,&["-q","--config","-"],remaining.min(Duration::from_secs(3)),Some(&input));input.fill(0);
                let Ok(value)=response else{continue;};
                if method=="RetrieveUserQuotaSummary"{
                    if let Some(rows)=antigravity_summary(&value){result.windows=rows;finish_quota(result,"antigravity-local-quota");break 'outer}
                }else{
                    let (plan,rows)=antigravity_status(&value);result.plan=plan;result.windows=rows;
                }
                if !result.windows.is_empty(){result.windows.truncate(8);result.source="antigravity-local-quota";result.confidence="verified";result.login_status="verified";result.reason="";result.state=if result.windows.iter().any(|window|window.used_percent>=100.){"warning"}else{"normal"};break 'outer;}
            }
        }
    }
    detected["candidates"]=Value::Null;
}
