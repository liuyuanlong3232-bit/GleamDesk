use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use std::{collections::VecDeque,sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::{SystemTime,UNIX_EPOCH,Instant,Duration}};
use tauri::{State,Webview,Manager};
#[path = "agent_room_workspace.rs"]
pub(crate) mod workspace;
#[derive(Default)]
pub struct AgentRoomState {inner:Arc<Mutex<RoomState>>}
#[derive(Default)]
struct RoomState {used:VecDeque<String>,active:Option<Arc<AtomicBool>>}
struct Reservation(Arc<Mutex<RoomState>>);
impl Drop for Reservation {fn drop(&mut self){if let Ok(mut state)=self.0.lock(){state.active=None;}}}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RoomRequest {id:String,provider:String,model:String,prompt:String,digest:String,consent_at_unix_ms:u64,paid_accepted:bool}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct RoomReceipt {text:String,provider:String,model:String,input_tokens:Option<u64>,output_tokens:Option<u64>}
fn now_ms()->u64 {SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64}
fn validate_request(request:&RoomRequest)->Result<(),String>{
    if request.id.is_empty()||request.id.len()>80||!request.id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-')||request.prompt.is_empty()||request.prompt.len()>64*1024{return Err("讨论请求无效或超过64KB".into());}
    if request.consent_at_unix_ms>now_ms()||now_ms().saturating_sub(request.consent_at_unix_ms)>60000{return Err("本次发送确认已过期，请重新核对提示词".into());}
    if !matches!(request.provider.as_str(),"deepseek"|"ollama"){return Err("此连接器没有接通自动回复".into());}
    if request.provider=="deepseek"&&(!request.paid_accepted||request.model!="deepseek-flash"){return Err("尚未确认 DeepSeek 本次发送与费用".into());}
    #[cfg(windows)] if crate::analysis::sha256(request.prompt.as_bytes())?!=request.digest{return Err("提示词与本次确认摘要不一致".into());}
    Ok(())
}
fn parse_response(provider:&str,bytes:&[u8])->Result<RoomReceipt,String>{
    let data:Value=serde_json::from_slice(bytes).map_err(|_|"模型响应格式无效")?;
    let (text,model,input,output)=if provider=="deepseek" {
        if data["choices"][0]["finish_reason"]!="stop"||data["choices"][0]["message"]["role"]!="assistant"||data["choices"][0]["message"]["tool_calls"].as_array().is_some_and(|items|!items.is_empty()){return Err("回复未完整结束或包含未支持工具调用".into());}
        (data["choices"][0]["message"]["content"].as_str(),data["model"].as_str(),data["usage"]["prompt_tokens"].as_u64(),data["usage"]["completion_tokens"].as_u64())
    } else {if data["done"]!=true||data["message"]["role"]!="assistant"||data["message"]["tool_calls"].as_array().is_some_and(|items|!items.is_empty()){return Err("本地回复未完整结束或包含工具调用".into());}
        (data["message"]["content"].as_str(),data["model"].as_str(),data["prompt_eval_count"].as_u64(),data["eval_count"].as_u64())};
    let text=text.filter(|s|!s.trim().is_empty()&&s.len()<=64*1024).ok_or("回复为空或超过上限")?;
    let model=model.filter(|s|s.len()<=256&&!s.chars().any(char::is_control)).ok_or("实际模型未知")?;
    Ok(RoomReceipt{text:text.to_owned(),provider:provider.into(),model:model.into(),input_tokens:input,output_tokens:output})
}
#[tauri::command]
pub async fn agent_room_reply(view:Webview,state:State<'_,AgentRoomState>,request:RoomRequest)->Result<RoomReceipt,String>{
    let live=crate::simulation::require_live()?;
    if view.label()!="dashboard"{return Err("只能从本机工作区发送讨论".into());}if request.provider=="deepseek"{return Err("请在聊天室中使用 @DeepSeek；旧轮次接口已停用付费调用".into());}validate_request(&request)?;
    let cancelled=Arc::new(AtomicBool::new(false));
    {let mut state=state.inner.lock().map_err(|_|"讨论状态不可用")?;if state.active.is_some(){return Err("已有一条请求正在执行".into());}if state.used.contains(&request.id){return Err("这个发送确认已使用，不自动重复请求".into());}state.used.push_back(request.id.clone());if state.used.len()>256{state.used.pop_front();}state.active=Some(cancelled.clone());}
    let reservation=Reservation(state.inner.clone());
    tauri::async_runtime::spawn_blocking(move||{let _reservation=reservation;let check=||{live.check()?;if cancelled.load(Ordering::SeqCst)||!view.window().is_visible().unwrap_or(false){Err("讨论请求已取消；已发送的远程请求仍可能计费".into())}else{Ok(())}};check()?;
        #[cfg(windows)] {
            let body=json!({"model":request.model,"messages":[{"role":"user","content":request.prompt}],"stream":false,"max_tokens":2048,"thinking":{"type":"disabled"}});
            let body=serde_json::to_vec(&body).map_err(|_|"无法编码讨论请求")?;
            let result=if request.provider=="deepseek"{
                let secret=crate::credentials::read(crate::credentials::CredentialSource::AgentDeepseek)?;
                let mut headers=format!("Authorization: Bearer {}\r\nContent-Type: application/json\r\n",secret.as_str()).into_bytes();
                let result=crate::http::post_json("api.deepseek.com","/chat/completions",std::str::from_utf8(&headers).map_err(|_|"凭据无效")?,&body,Instant::now()+Duration::from_secs(60),&check);headers.fill(0);drop(secret);result
            }else {
                crate::ollama::validate_local_chat_model(&request.model)?;check()?;
                let body=serde_json::to_vec(&json!({"model":request.model,"messages":[{"role":"user","content":request.prompt}],"stream":false,"options":{"num_predict":2048},"keep_alive":"2m"})).map_err(|_|"本地请求编码失败")?;
                crate::http::post_ollama_chat(&body,Instant::now()+Duration::from_secs(60),&check)
            }?;
            if request.provider=="ollama" && result.0==200 {if let Ok(receipt)=parse_response("ollama",&result.1){if crate::ollama::record_workbench_usage(view.app_handle(),receipt.input_tokens,receipt.output_tokens).is_err(){eprintln!("Ollama workbench usage could not be saved");}}}
            check()?;if result.0!=200{return Err(match result.0{401|403=>"连接凭据或模型权限不足",429=>"服务额度不足或限流",_=>"请求失败；未自动重试"}.into());}parse_response(&request.provider,&result.1)
        }
        #[cfg(not(windows))] {Err("当前平台尚未连接讨论回复".into())}
    }).await.map_err(|_|"讨论请求线程失败".to_string())?
}
#[tauri::command]
pub fn agent_room_cancel(view:Webview,state:State<'_,AgentRoomState>)->Result<(),String>{if view.label()!="dashboard"{return Err("没有讨论取消权限".into());}if let Some(active)=state.inner.lock().map_err(|_|"讨论状态不可用")?.active.as_ref(){active.store(true,Ordering::SeqCst);}Ok(())}
#[cfg(test)] mod tests {use super::*;
 #[test] fn replies_require_complete_assistant_messages(){assert!(parse_response("deepseek",br#"{"choices":[{"finish_reason":"length","message":{"role":"assistant","content":"partial"}}]}"#).is_err());let reply=parse_response("deepseek",br#"{"model":"deepseek-flash","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"reply"}}],"usage":{"prompt_tokens":8}}"#).unwrap();assert_eq!(reply.input_tokens,Some(8));assert_eq!(reply.output_tokens,None);assert_eq!(reply.text,"reply");}
 #[test] fn disabled_connectors_and_unconfirmed_paid_calls_fail(){let request=RoomRequest{id:"a".into(),provider:"deepseek".into(),model:"deepseek-flash".into(),prompt:"hello".into(),digest:"invalid".into(),consent_at_unix_ms:now_ms(),paid_accepted:false};assert!(validate_request(&request).is_err());let request=RoomRequest{provider:"codex".into(),..request};assert!(validate_request(&request).is_err());}
}

const CHAT_KIND: &str = "agent_room_chat";
const LEDGER_KIND: &str = "agent_room_ledger";
const CHAT_MAX_CHARS: usize = 2000;
const CHAT_PROMPT_BYTES: usize = 24000;
const CHAT_CONTEXT_BYTES: usize = 12000;
const CHAT_REPLY_CHARS: usize = 6000;
const CHAT_OUTPUT_TOKENS: u64 = 2048;
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(super) struct ChatLimits { calls:u64, budget_yuan:f64 }
impl Default for ChatLimits {fn default()->Self{Self{calls:100,budget_yuan:3.}}}
fn validate_chat_limits(limits:&ChatLimits)->Result<(),String>{if !(1..=10000).contains(&limits.calls)||!limits.budget_yuan.is_finite()||!(0.01..=10000.).contains(&limits.budget_yuan){return Err("每日次数需为1～10000的整数，预算需为¥0.01～¥10000".into())}Ok(())}
fn chat_limits(db:&rusqlite::Connection)->Result<ChatLimits,String>{let value=read_chat_record(db,LEDGER_KIND,"limits")?.unwrap_or_default();validate_chat_limits(&value)?;Ok(value)}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatMessage {
    id: String, role: String, text: String, created_at: String, status: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    error: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatSettings { paused: bool, paid_enabled: bool }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatUsage { day: String, calls: u64, estimated_yuan: f64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSnapshot {
    messages: Vec<ChatMessage>, paused: bool, paid_enabled: bool, has_older: bool,
    usage: ChatUsage, credential_source: Option<&'static str>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatSend { id: String, text: String }
fn chat_error(error: impl std::fmt::Display) -> String { format!("聊天室本地保存失败：{error}") }
fn read_chat_record<T: serde::de::DeserializeOwned>(db: &rusqlite::Connection, kind: &str, id: &str) -> Result<Option<T>, String> {
    use rusqlite::OptionalExtension;
    let raw: Option<String> = db.query_row("SELECT payload_json FROM history_records WHERE kind=?1 AND id=?2",
        rusqlite::params![kind, id], |row| row.get(0)).optional().map_err(chat_error)?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|_| "聊天室本地记录格式异常，未清空记录".into())).transpose()
}
fn write_chat_record<T: Serialize>(db: &rusqlite::Connection, kind: &str, id: &str, value: &T) -> Result<(), String> {
    let raw = serde_json::to_string(value).map_err(chat_error)?;
    db.execute("INSERT INTO history_records(kind,id,created_at,payload_json) VALUES(?1,?2,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?3)
        ON CONFLICT(kind,id) DO UPDATE SET payload_json=excluded.payload_json",
        rusqlite::params![kind, id, raw]).map_err(chat_error)?;
    Ok(())
}
fn chat_time(db: &rusqlite::Connection) -> Result<String, String> {
    db.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| row.get(0)).map_err(chat_error)
}
fn chat_day(db: &rusqlite::Connection) -> Result<String, String> {
    // One fixed calendar for counters, independent of Windows local timezone.
    db.query_row("SELECT strftime('%Y-%m-%d','now','+8 hours')", [], |row| row.get(0)).map_err(chat_error)
}
fn chat_usage(db: &rusqlite::Connection, day: &str) -> Result<ChatUsage, String> {
    let usage = read_chat_record::<ChatUsage>(db, LEDGER_KIND, day)?.unwrap_or(ChatUsage { day: day.into(), calls: 0, estimated_yuan: 0.0 });
    if usage.day != day || !usage.estimated_yuan.is_finite() || usage.estimated_yuan < 0.0 {
        return Err("聊天室计数格式异常，已停止付费调用".into());
    }
    Ok(usage)
}
fn chat_messages(db: &rusqlite::Connection) -> Result<Vec<ChatMessage>, String> {
    let mut query = db.prepare("SELECT payload_json FROM history_records WHERE kind=?1 ORDER BY created_at DESC,rowid DESC LIMIT 1000").map_err(chat_error)?;
    let rows = query.query_map([CHAT_KIND], |row| row.get::<_, String>(0)).map_err(chat_error)?;
    let mut messages = Vec::new();
    for raw in rows {
        let message: ChatMessage = serde_json::from_str(&raw.map_err(chat_error)?).map_err(|_| "聊天室消息格式异常，未清空记录")?;
        messages.push(message);
    }
    messages.reverse();
    Ok(messages)
}
fn chat_snapshot(db: &rusqlite::Connection, credential_source: Option<&'static str>) -> Result<ChatSnapshot, String> {
    let settings = read_chat_record::<ChatSettings>(db, LEDGER_KIND, "settings")?.unwrap_or_default();
    let count: i64 = db.query_row("SELECT COUNT(*) FROM history_records WHERE kind=?1", [CHAT_KIND], |row| row.get(0)).map_err(chat_error)?;
    Ok(ChatSnapshot { messages: chat_messages(db)?, paused: settings.paused, paid_enabled: settings.paid_enabled,
        has_older: count > 1000, usage: chat_usage(db, &chat_day(db)?)?, credential_source })
}
fn chat_target(text: &str) -> Result<bool, String> {
    let clean = text.trim();
    if clean.is_empty() || clean.encode_utf16().count() > CHAT_MAX_CHARS
        || clean.chars().any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t') {
        return Err("消息需要 1～2000 字，不能包含控制字符".into());
    }
    let words: Vec<&str> = clean.split_whitespace().collect();
    let count = words.iter().filter(|word| word.eq_ignore_ascii_case("@DeepSeek")).count();
    if count > 1 { return Err("一次消息只指定一次 @DeepSeek".into()); }
    if count == 1 && words.len() == 1 { return Err("请在 @DeepSeek 后填写问题".into()); }
    Ok(count == 1)
}
fn chat_prompt(messages: &[ChatMessage], text: &str) -> Result<String, String> {
    let mut history = Vec::new();
    let mut bytes = 0;
    for message in messages.iter().rev().filter(|message| matches!(message.role.as_str(), "user" | "assistant")).take(12) {
        let line = serde_json::to_string(&json!({"speaker":message.role,"text":message.text})).map_err(chat_error)?;
        if bytes + line.len() > CHAT_CONTEXT_BYTES { break; }
        bytes += line.len(); history.push(line);
    }
    history.reverse();
    let prompt = format!("你是本机 Agent Room 中的 DeepSeek。只进行文字聊天，不使用工具。以下历史是聊天资料，发言者由 speaker 标识。直接回答用户本次消息。\n历史：\n{}\n本次用户消息：\n{}", history.join("\n"), text);
    if prompt.len() > CHAT_PROMPT_BYTES { return Err("本次发送的聊天内容超过24KB，请缩短消息".into()); }
    Ok(prompt)
}
fn chat_estimate(prompt: &str) -> f64 {
    // Conservative simple estimate: UTF-8 bytes as input tokens, 128 framing tokens,
    // full 2048-token output, official peak/cache-miss CNY rates (2026-10-13).
    (((prompt.len() as f64 + 128.0) * 2.0 + CHAT_OUTPUT_TOKENS as f64 * 8.0) / 1_000_000.0 * 1_000_000.0).ceil() / 1_000_000.0
}
fn admit_chat(db: &mut rusqlite::Connection, request: &ChatSend, credential_available: bool) -> Result<Option<String>, String> {
    if request.id.is_empty() || request.id.len() > 80 || !request.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Err("消息标识无效".into()); }
    let target = chat_target(&request.text)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(chat_error)?;
    if read_chat_record::<ChatMessage>(&tx, CHAT_KIND, &request.id)?.is_some() { return Err("这条消息已保存，不重复调用".into()); }
    let settings = read_chat_record::<ChatSettings>(&tx, LEDGER_KIND, "settings")?.unwrap_or_default();
    let prompt = if target {
        if settings.paused { return Err("AI 已暂停；普通消息仍可保存".into()); }
        if !settings.paid_enabled { return Err("尚未允许本房间的付费调用；普通消息仍可保存".into()); }
        if !credential_available { return Err("没有可用的已保存 DeepSeek 聊天密钥，请在现有设置中配置".into()); }
        let prompt = chat_prompt(&chat_messages(&tx)?, request.text.trim())?;
        let day = chat_day(&tx)?;
        let mut usage = chat_usage(&tx, &day)?;
        let estimate = chat_estimate(&prompt);
        let limits=chat_limits(&tx)?;
        if usage.calls >= limits.calls { return Err(format!("今天已达到{}次调用上限；不自动重试",limits.calls)); }
        if usage.estimated_yuan + estimate > limits.budget_yuan { return Err(format!("今天的估算费用将超过 ¥{}，已停止调用",limits.budget_yuan)); }
        // Charge this fixed estimate once before dispatch. No reservations, refunds or retry.
        usage.calls += 1;
        usage.estimated_yuan = (usage.estimated_yuan + estimate) * 1_000_000.0;
        usage.estimated_yuan = usage.estimated_yuan.round() / 1_000_000.0;
        write_chat_record(&tx, LEDGER_KIND, &day, &usage)?;
        Some(prompt)
    } else { None };
    let message = ChatMessage { id: request.id.clone(), role: "user".into(), text: request.text.trim().into(),
        created_at: chat_time(&tx)?, status: if target { "sending" } else { "saved" }.into(), reply_to: None, error: None };
    write_chat_record(&tx, CHAT_KIND, &message.id, &message)?;
    tx.commit().map_err(chat_error)?;
    Ok(prompt)
}
fn finish_chat(db: &mut rusqlite::Connection, id: &str, result: &Result<RoomReceipt, String>) -> Result<(), String> {
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(chat_error)?;
    let mut user = read_chat_record::<ChatMessage>(&tx, CHAT_KIND, id)?.ok_or("已发送消息的本地记录缺失")?;
    if user.status != "sending" { return Err("本地消息状态变化，未重复写入回复".into()); }
    match result {
        Ok(receipt) => {
            user.status = "answered".into();
            let reply = ChatMessage { id: format!("{id}-reply"), role: "assistant".into(), text: receipt.text.clone(),
                created_at: chat_time(&tx)?, status: if receipt.text.encode_utf16().count() > CHAT_REPLY_CHARS { "partial" } else { "saved" }.into(),
                reply_to: Some(id.into()), error: None };
            let mut reply = reply;
            if reply.text.encode_utf16().count() > CHAT_REPLY_CHARS {
                let mut len = 0;
                reply.text = reply.text.chars().take_while(|c| { len += c.len_utf16(); len <= CHAT_REPLY_CHARS }).collect();
                reply.error = Some("回复超过6000字，已截短保存；不会自动续写".into());
            }
            write_chat_record(&tx, CHAT_KIND, &reply.id, &reply)?;
        }
        Err(error) => { user.status = "failed".into(); user.error = Some(error.clone()); }
    }
    write_chat_record(&tx, CHAT_KIND, id, &user)?;
    tx.commit().map_err(chat_error)
}
fn recover_interrupted_chat(db: &mut rusqlite::Connection) -> Result<(), String> {
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(chat_error)?;
    // Recover all pending records, including ones outside the visible latest-1000 window.
    let pending: Vec<String> = {
        let mut query = tx.prepare("SELECT payload_json FROM history_records WHERE kind=?1 AND json_extract(payload_json,'$.status')='sending'").map_err(chat_error)?;
        let rows = query.query_map([CHAT_KIND], |row| row.get::<_, String>(0)).map_err(chat_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(chat_error)?
    };
    for raw in pending {
        let mut message: ChatMessage = serde_json::from_str(&raw).map_err(chat_error)?;
        message.status = "interrupted".into();
        message.error = Some("上次请求未完成；已保留次数和估算费用，不自动重试".into());
        write_chat_record(&tx, CHAT_KIND, &message.id, &message)?;
    }
    tx.commit().map_err(chat_error)
}
fn open_chat_database(path: &std::path::Path, legacy: &std::path::Path) -> Result<rusqlite::Connection, String> {
    if !path.exists() {
        if legacy.exists() { return Err("发现旧历史文件，需要先确认迁移；聊天室未读取或修改它".into()); }
        return crate::storage::open_database(path, legacy);
    }
    let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(chat_error)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(chat_error)?;
    let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(chat_error)?;
    if version != 5 { return Err("现有数据库版本需要确认；聊天室不会自动迁移".into()); }
    // Only use the existing table; no migration, maintenance or old-kind queries here.
    db.prepare("SELECT kind,id,created_at,payload_json FROM history_records LIMIT 0").map_err(chat_error)?;
    Ok(db)
}
fn chat_db(view: &Webview) -> Result<rusqlite::Connection, String> {
    let (path, legacy) = crate::storage::database_paths(view.app_handle())?;
    open_chat_database(&path, &legacy)
}
fn require_idle_room(state: &RoomState) -> Result<(), String> {
    if state.active.is_some() { return Err("已有一条请求正在执行，请等待或暂停".into()); }
    Ok(())
}
fn require_chat_view(view: &Webview) -> Result<(), String> {
    if view.label() != "dashboard" { return Err("只能从本机工作区使用聊天室".into()); } Ok(())
}
#[cfg(windows)]
fn chat_credential() -> Result<Option<crate::credentials::CredentialSource>, String> {
    use crate::credentials::CredentialSource;
    if crate::credentials::exists(CredentialSource::AgentDeepseek)? { return Ok(Some(CredentialSource::AgentDeepseek)); }
    if crate::credentials::exists(CredentialSource::Deepseek)? { return Ok(Some(CredentialSource::Deepseek)); }
    Ok(None)
}
#[cfg(not(windows))]
fn chat_credential() -> Result<Option<crate::credentials::CredentialSource>, String> { Ok(None) }
fn chat_credential_label(source: Option<crate::credentials::CredentialSource>) -> Option<&'static str> {
    use crate::credentials::CredentialSource;
    match source { Some(CredentialSource::AgentDeepseek) => Some("agent-deepseek"), Some(CredentialSource::Deepseek) => Some("deepseek"), _ => None }
}
#[tauri::command]
pub fn agent_room_chat_load(view: Webview, state: State<'_, AgentRoomState>) -> Result<ChatSnapshot, String> {
    require_chat_view(&view)?;
    let guard = state.inner.lock().map_err(|_| "讨论状态不可用")?;
    let mut db = chat_db(&view)?;
    if guard.active.is_none() { recover_interrupted_chat(&mut db)?; }
    chat_snapshot(&db, chat_credential_label(chat_credential()?))
}
#[tauri::command]
pub fn agent_room_chat_pause(view: Webview, state: State<'_, AgentRoomState>, paused: bool) -> Result<(), String> {
    require_chat_view(&view)?;
    let guard = state.inner.lock().map_err(|_| "讨论状态不可用")?;
    let db = chat_db(&view)?;
    let mut settings = read_chat_record::<ChatSettings>(&db, LEDGER_KIND, "settings")?.unwrap_or_default();
    settings.paused = paused;
    write_chat_record(&db, LEDGER_KIND, "settings", &settings)?;
    if paused { if let Some(active) = &guard.active { active.store(true, Ordering::SeqCst); } }
    Ok(())
}
#[tauri::command]
pub fn agent_room_chat_enable_paid(view: Webview, state: State<'_, AgentRoomState>, enabled: bool) -> Result<(), String> {
    require_chat_view(&view)?;
    let guard = state.inner.lock().map_err(|_| "讨论状态不可用")?;
    let db = chat_db(&view)?;
    let mut settings = read_chat_record::<ChatSettings>(&db, LEDGER_KIND, "settings")?.unwrap_or_default();
    settings.paid_enabled = enabled;
    write_chat_record(&db, LEDGER_KIND, "settings", &settings)?;
    if !enabled { if let Some(active) = &guard.active { active.store(true, Ordering::SeqCst); } }
    Ok(())
}
#[tauri::command]
pub async fn agent_room_chat_send(view: Webview, state: State<'_, AgentRoomState>, request: ChatSend) -> Result<ChatSnapshot, String> {
    let live = crate::simulation::require_live()?;
    require_chat_view(&view)?;
    let target = chat_target(&request.text)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let credential;
    let prompt;
    let reservation;
    {
        let mut guard = state.inner.lock().map_err(|_| "讨论状态不可用")?;
        require_idle_room(&guard)?;
        let mut db = chat_db(&view)?;
        credential = if target { chat_credential()? } else { None };
        prompt = admit_chat(&mut db, &request, credential.is_some())?;
        if prompt.is_none() { return chat_snapshot(&db, chat_credential_label(chat_credential()?)); }
        guard.active = Some(cancelled.clone());
        reservation = Reservation(state.inner.clone());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _reservation = reservation;
        let check = || { live.check()?; if cancelled.load(Ordering::SeqCst) || !view.window().is_visible().unwrap_or(false) {
            Err("请求已取消；已发送的远程调用可能计费，不自动重试".into())
        } else { Ok(()) } };
        let result: Result<RoomReceipt, String> = (|| {
            check()?;
            #[cfg(windows)] {
                let body = serde_json::to_vec(&json!({"model":"deepseek-flash","messages":[{"role":"user","content":prompt.ok_or("发送内容缺失")?}],
                    "stream":false,"max_tokens":CHAT_OUTPUT_TOKENS,"thinking":{"type":"disabled"}})).map_err(chat_error)?;
                let secret = crate::credentials::read(credential.ok_or("没有已保存的聊天密钥")?)?;
                let mut headers = format!("Authorization: Bearer {}\r\nContent-Type: application/json\r\n", secret.as_str()).into_bytes();
                let response = crate::http::post_json("api.deepseek.com", "/chat/completions",
                    std::str::from_utf8(&headers).map_err(|_| "凭据无效")?, &body, Instant::now() + Duration::from_secs(60), &check);
                headers.fill(0); drop(secret);
                let (status, bytes) = response?;
                check()?;
                if status != 200 { return Err(match status { 401 | 403 => "聊天密钥或模型权限不足", 429 => "服务额度不足或限流", _ => "请求失败；未自动重试" }.into()); }
                // Length-limited completions are useful, but explicitly marked partial.
                let mut data: Value = serde_json::from_slice(&bytes).map_err(|_| "模型响应格式无效")?;
                let partial = data["choices"][0]["finish_reason"] == "length";
                if partial { data["choices"][0]["finish_reason"] = json!("stop"); }
                let mut receipt = parse_response("deepseek", &serde_json::to_vec(&data).map_err(chat_error)?)?;
                if partial { receipt.text.push_str("\n\n[达到单次回复上限，未自动续写]"); }
                Ok(receipt)
            }
            #[cfg(not(windows))] { Err("当前平台未接入 DeepSeek 聊天".into()) }
        })();
        let mut db = chat_db(&view)?;
        // Pause and response saving share the same lock so a late reply cannot slip past pause.
        let _guard = _reservation.0.lock().map_err(|_| "讨论状态不可用")?;
        let result = if cancelled.load(Ordering::SeqCst) { Err("请求已取消；已发送的远程调用可能计费，不自动重试".into()) } else { result };
        finish_chat(&mut db, &request.id, &result)?;
        chat_snapshot(&db, chat_credential_label(credential))
    }).await.map_err(|_| "讨论请求线程失败；未自动重试".to_string())?
}

#[cfg(test)]
mod chat_tests {
    use super::*;
    use rusqlite::Connection;
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE history_records(kind TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(kind,id));").unwrap();
        db
    }
    fn request(id: &str, text: &str) -> ChatSend { ChatSend { id: id.into(), text: text.into() } }
    fn enable(db: &Connection) { write_chat_record(db, LEDGER_KIND, "settings", &ChatSettings { paused: false, paid_enabled: true }).unwrap(); }
    fn reply(text: &str) -> RoomReceipt { RoomReceipt { text: text.into(), provider: "deepseek".into(), model: "deepseek-flash".into(), input_tokens: Some(8), output_tokens: Some(8) } }
    fn mock_send(db: &mut Connection, request: &ChatSend, calls: &mut u64, answer: Result<RoomReceipt, String>) -> Result<(), String> {
        if admit_chat(db, request, true)?.is_some() { *calls += 1; finish_chat(db, &request.id, &answer)?; }
        Ok(())
    }
    #[test]
    fn ordinary_messages_persist_without_model_or_credential() {
        let mut db = db();
        assert!(admit_chat(&mut db, &request("ordinary", "记下我的想法"), false).unwrap().is_none());
        let snapshot = chat_snapshot(&db, None).unwrap();
        assert_eq!(snapshot.messages.len(), 1); assert_eq!(snapshot.usage.calls, 0);
        assert_eq!(snapshot.messages[0].role, "user"); assert_eq!(snapshot.messages[0].status, "saved");
    }
    #[test]
    fn one_human_mention_calls_once_and_assistant_mentions_never_route() {
        let mut db = db(); enable(&db); let mut calls = 0;
        mock_send(&mut db, &request("ask", "@DeepSeek 你好"), &mut calls, Ok(reply("@DeepSeek 这是回复"))).unwrap();
        let snapshot = chat_snapshot(&db, None).unwrap();
        assert_eq!(calls, 1); assert_eq!(snapshot.usage.calls, 1); assert_eq!(snapshot.messages.len(), 2);
        assert_eq!(snapshot.messages[1].role, "assistant"); assert_eq!(snapshot.messages[1].reply_to.as_deref(), Some("ask"));
        assert!(mock_send(&mut db, &request("ask", "@DeepSeek 你好"), &mut calls, Ok(reply("重复"))).is_err());
        assert_eq!(calls, 1);
    }
    #[test]
    fn cap_twenty_and_budget_reject_before_the_mock_network() {
        let mut db = db(); enable(&db); let mut calls = 0;
        write_chat_record(&db,LEDGER_KIND,"limits",&ChatLimits{calls:20,budget_yuan:1.}).unwrap();
        for i in 0..20 { mock_send(&mut db, &request(&format!("ask-{i}"), "@DeepSeek 问题"), &mut calls, Ok(reply("答案"))).unwrap(); }
        assert!(mock_send(&mut db, &request("twenty-one", "@DeepSeek 问题"), &mut calls, Ok(reply("不会发送"))).is_err());
        assert_eq!(calls, 20);
        let day = chat_day(&db).unwrap();
        write_chat_record(&db, LEDGER_KIND, &day, &ChatUsage { day: day.clone(), calls: 1, estimated_yuan: 0.99 }).unwrap();
        assert!(mock_send(&mut db, &request("budget", "@DeepSeek 问题"), &mut calls, Ok(reply("不会发送"))).is_err());
        assert_eq!(calls, 20); assert_eq!(chat_usage(&db, &day).unwrap().estimated_yuan, 0.99);
    }
    #[test]
    fn failures_count_once_without_retry_and_pause_allows_plain_messages() {
        let mut db = db(); enable(&db); let mut calls = 0;
        mock_send(&mut db, &request("failure", "@DeepSeek 问题"), &mut calls, Err("模拟超时".into())).unwrap();
        let snapshot = chat_snapshot(&db, None).unwrap();
        assert_eq!(calls, 1); assert_eq!(snapshot.messages[0].status, "failed"); assert_eq!(snapshot.usage.calls, 1);
        assert!(snapshot.usage.estimated_yuan > 0.0);
        write_chat_record(&db, LEDGER_KIND, "settings", &ChatSettings { paused: true, paid_enabled: true }).unwrap();
        assert!(mock_send(&mut db, &request("paused", "@DeepSeek 问题"), &mut calls, Ok(reply("不会发送"))).is_err());
        assert!(admit_chat(&mut db, &request("note", "暂停时仍保存"), false).unwrap().is_none());
        assert_eq!(calls, 1);
    }
    #[test]
    fn local_reopen_restores_messages_counters_and_interrupted_calls() {
        let path = std::env::temp_dir().join(format!("room-chat-test-{}-{}.sqlite3", std::process::id(), now_ms()));
        {
            let mut db = Connection::open(&path).unwrap();
            db.execute_batch("CREATE TABLE history_records(kind TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(kind,id));").unwrap();
            enable(&db);
            assert!(admit_chat(&mut db, &request("pending", "@DeepSeek 问题"), true).unwrap().is_some());
        }
        {
            let mut db = Connection::open(&path).unwrap(); recover_interrupted_chat(&mut db).unwrap();
            let snapshot = chat_snapshot(&db, None).unwrap();
            assert!(snapshot.paid_enabled); assert_eq!(snapshot.usage.calls, 1); assert!(snapshot.usage.estimated_yuan > 0.0);
            assert_eq!(snapshot.messages[0].status, "interrupted");
            assert!(admit_chat(&mut db, &request("pending", "@DeepSeek 问题"), true).is_err());
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn text_context_output_and_corrupt_ledger_are_bounded() {
        assert!(chat_target("").is_err()); assert!(chat_target(&"a".repeat(2001)).is_err());
        assert!(chat_target("@DeepSeek").is_err()); assert!(chat_target("@DeepSeek 问题 @DeepSeek").is_err());
        assert!(!chat_target("x@DeepSeek.com").unwrap()); assert!(!chat_target("@DeepSeekOther 看看").unwrap());
        assert!(chat_target("请 @deepseek 看看").unwrap());
        let mut db = db(); enable(&db);
        for i in 0..15 { admit_chat(&mut db, &request(&format!("note-{i}"), &"中文".repeat(1000)), false).unwrap(); }
        let prompt = chat_prompt(&chat_messages(&db).unwrap(), &"字".repeat(2000)).unwrap();
        assert!(prompt.len() <= CHAT_PROMPT_BYTES); assert!(chat_estimate(&prompt) < 1.0);
        assert!(admit_chat(&mut db, &request("long-reply", "@DeepSeek 问题"), true).unwrap().is_some());
        finish_chat(&mut db, "long-reply", &Ok(reply(&"😀".repeat(4000)))).unwrap();
        let snapshot = chat_snapshot(&db, None).unwrap();
        let answer = snapshot.messages.iter().find(|m| m.role == "assistant").unwrap();
        assert_eq!(answer.text.encode_utf16().count(), 6000); assert_eq!(answer.status, "partial");
        let day = chat_day(&db).unwrap();
        db.execute("UPDATE history_records SET payload_json='invalid' WHERE kind=?1 AND id=?2", rusqlite::params![LEDGER_KIND, day]).unwrap();
        assert!(admit_chat(&mut db, &request("bad-ledger", "@DeepSeek 问题"), true).is_err());
    }
    #[test]
    fn paid_calls_default_off_and_missing_keys_do_not_spend() {
        let mut db = db();
        assert!(admit_chat(&mut db, &request("disabled", "@DeepSeek 问题"), true).is_err());
        enable(&db);
        assert!(admit_chat(&mut db, &request("no-key", "@DeepSeek 问题"), false).is_err());
        assert_eq!(chat_snapshot(&db, None).unwrap().usage.calls, 0);
    }
    #[test]
    fn new_day_uses_new_counter_and_keeps_previous_day() {
        let db = db();
        write_chat_record(&db, LEDGER_KIND, "2000-01-01", &ChatUsage { day: "2000-01-01".into(), calls: 20, estimated_yuan: 1.0 }).unwrap();
        assert_eq!(chat_usage(&db, &chat_day(&db).unwrap()).unwrap().calls, 0);
        assert_eq!(chat_usage(&db, "2000-01-01").unwrap().calls, 20);
    }

    #[test]
    fn concurrent_requests_are_rejected_until_the_guard_finishes() {
        let state = Arc::new(Mutex::new(RoomState::default()));
        assert!(require_idle_room(&state.lock().unwrap()).is_ok());
        state.lock().unwrap().active = Some(Arc::new(AtomicBool::new(false)));
        assert!(require_idle_room(&state.lock().unwrap()).is_err());
        drop(Reservation(state.clone()));
        assert!(require_idle_room(&state.lock().unwrap()).is_ok());
    }
    #[test]
    fn chat_open_preserves_existing_kinds_and_does_not_migrate() {
        let path = std::env::temp_dir().join(format!("room-isolation-{}-{}.sqlite3", std::process::id(), now_ms()));
        let legacy = path.with_extension("json");
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch("CREATE TABLE history_records(kind TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=5;
                INSERT INTO history_records VALUES('provider_history','protected','2000-01-01T00:00:00.000Z','{\"keep\":true}');").unwrap();
        }
        {
            let mut db = open_chat_database(&path, &legacy).unwrap();
            admit_chat(&mut db, &request("ordinary-isolated", "新聊天室记录"), false).unwrap();
            let raw: String = db.query_row("SELECT payload_json FROM history_records WHERE kind='provider_history'", [], |row| row.get(0)).unwrap();
            assert_eq!(raw, "{\"keep\":true}");
            db.pragma_update(None, "user_version", 4).unwrap();
        }
        assert!(open_chat_database(&path, &legacy).is_err());
        {
            let db = Connection::open(&path).unwrap();
            let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
            assert_eq!(version, 4);
        }
        std::fs::remove_file(path).unwrap();
    }

}
