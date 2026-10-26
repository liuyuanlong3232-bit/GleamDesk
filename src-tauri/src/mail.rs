use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration,Instant,SystemTime,UNIX_EPOCH};

#[derive(Clone,Copy,Deserialize,Serialize,Debug,PartialEq)]
#[serde(rename_all="lowercase")]
pub enum MailProvider {Gmail,Outlook,Netease,Qq}
impl MailProvider {
    pub fn id(self)->&'static str {match self {Self::Gmail=>"gmail",Self::Outlook=>"outlook",Self::Netease=>"netease",Self::Qq=>"qq"}}
    pub fn imap_host(self)->Option<&'static str>{match self {Self::Netease=>Some("imap.163.com"),Self::Qq=>Some("imap.qq.com"),_=>None}}
}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct MailSecret {pub email:String,pub authorization:String,pub refresh_token:Option<String>,pub client_id:Option<String>,pub client_secret:Option<String>,pub expires_at_unix_ms:Option<u64>}
impl Drop for MailSecret {fn drop(&mut self){unsafe{self.authorization.as_bytes_mut().fill(0);if let Some(s)=self.refresh_token.as_mut(){s.as_bytes_mut().fill(0);}if let Some(s)=self.client_secret.as_mut(){s.as_bytes_mut().fill(0);}}}}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct MailMessage {pub id:String,pub subject:String,pub sender:String,pub received_at:String,pub unread:Option<bool>,pub important:bool}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct MailSnapshot {pub provider:MailProvider,pub account:String,pub unread_count:Option<u64>,pub messages:Vec<MailMessage>,pub observed_at_unix_ms:u64,pub source:String}
pub fn now_ms()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64}
fn email_valid(value:&str,provider:MailProvider)->bool{
    let parts:Vec<_>=value.split('@').collect();if parts.len()!=2||parts[0].is_empty()||value.len()>254||value.chars().any(|c|c.is_control()||c.is_whitespace()||"\"\\".contains(c)){return false;}
    match provider {MailProvider::Netease=>parts[1].eq_ignore_ascii_case("163.com"),MailProvider::Qq=>parts[1].eq_ignore_ascii_case("qq.com")||parts[1].eq_ignore_ascii_case("foxmail.com"),_=>!parts[1].is_empty()}
}
// Serialize each account's refresh/read/write/disconnect without queuing stale operations.
static ACTIVE:[std::sync::atomic::AtomicBool;4]=[const{std::sync::atomic::AtomicBool::new(false)};4];
pub struct MailOperation(usize);
impl Drop for MailOperation{fn drop(&mut self){ACTIVE[self.0].store(false,std::sync::atomic::Ordering::Release);}}
pub fn begin_operation(provider:MailProvider)->Result<MailOperation,String>{
    let index=match provider{MailProvider::Gmail=>0,MailProvider::Outlook=>1,MailProvider::Netease=>2,MailProvider::Qq=>3};
    ACTIVE[index].compare_exchange(false,true,std::sync::atomic::Ordering::AcqRel,std::sync::atomic::Ordering::Acquire)
        .map(|_|MailOperation(index)).map_err(|_|"此邮箱操作正在进行，请完成后重试".into())
}
static CREDENTIAL_LOCK:std::sync::Mutex<()>=std::sync::Mutex::new(());
fn bank_key(provider:MailProvider,bank:usize,index:usize)->String{format!("CodexDesktop.Mail.{}.Bank{bank}.Part{index}",provider.id())}
fn key(provider:MailProvider,index:usize)->String{format!("CodexDesktop.Mail.{}.Part{index}",provider.id())}
#[cfg(windows)]pub fn save_secret(provider:MailProvider,value:&MailSecret)->Result<(),String>{
    let _lock=CREDENTIAL_LOCK.lock().map_err(|_|"邮箱凭据锁不可用")?;
    let old=crate::credentials::read_named(&key(provider,0)).ok();
    let bank=if old.as_ref().is_some_and(|value|value.as_str().starts_with("0:")){1}else{0};
    if !email_valid(&value.email,provider)||value.authorization.is_empty()||value.authorization.chars().any(char::is_control){return Err("邮箱或授权凭据格式无效".into());}
    let mut bytes=serde_json::to_vec(value).map_err(|_|"邮箱凭据编码失败")?;
    if bytes.len()>10000{bytes.fill(0);return Err("邮箱凭据超过安全保存上限".into());}
    // Windows credential blobs have a per-entry bound. Commit the count last.
    let body=String::from_utf8(bytes).map_err(|_|"邮箱凭据编码无效")?;
    let mut chunks=Vec::new();let mut start=0;
    while start<body.len(){let mut end=(start+2400).min(body.len());while !body.is_char_boundary(end){end-=1;}chunks.push(&body[start..end]);start=end;}
    let result=(||{for (index,chunk) in chunks.iter().enumerate(){crate::credentials::save_named(&bank_key(provider,bank,index+1),chunk)?;}crate::credentials::save_named(&key(provider,0),&format!("{bank}:{}",chunks.len()))})();
    let mut body=body;unsafe{body.as_bytes_mut().fill(0);}result
}
#[cfg(windows)]pub fn load_secret(provider:MailProvider)->Result<MailSecret,String>{
    let _lock=CREDENTIAL_LOCK.lock().map_err(|_|"邮箱凭据锁不可用")?;
    let metadata=crate::credentials::read_named(&key(provider,0))?;
    let (bank,count)=metadata.as_str().split_once(':').ok_or("邮箱凭据记录无效")?;
    let bank=bank.parse::<usize>().map_err(|_|"邮箱凭据记录无效")?;let count=count.parse::<usize>().map_err(|_|"邮箱凭据记录无效")?;if bank>1{return Err("邮箱凭据记录无效".into());}
    if !(1..=5).contains(&count){return Err("邮箱凭据记录超限".into());}
    let mut body=Vec::new();for index in 1..=count{let secret=crate::credentials::read_named(&bank_key(provider,bank,index))?;body.extend_from_slice(secret.as_str().as_bytes());}
    let result=serde_json::from_slice(&body).map_err(|_|"邮箱凭据结构无效".to_string());body.fill(0);result
}
#[tauri::command]pub fn mail_configured(provider:MailProvider)->Result<bool,String>{
    #[cfg(windows)]{crate::credentials::exists_named(&key(provider,0))}
    #[cfg(not(windows))]{let _=provider;Ok(false)}
}
#[tauri::command]pub fn mail_save_authorization(provider:MailProvider,email:String,authorization:String)->Result<(),String>{
    if provider.imap_host().is_none(){return Err("Gmail和Outlook请使用官方OAuth登录".into());}
    let _operation=begin_operation(provider)?;let secret=MailSecret{email,authorization,refresh_token:None,client_id:None,client_secret:None,expires_at_unix_ms:None};
    #[cfg(windows)]{save_secret(provider,&secret)}
    #[cfg(not(windows))]{Err("安全保存需要Windows".into())}
}
#[tauri::command]pub fn mail_disconnect(provider:MailProvider)->Result<(),String>{
    let _operation=begin_operation(provider)?;
    #[cfg(windows)]{let _lock=CREDENTIAL_LOCK.lock().map_err(|_|"邮箱凭据锁不可用")?;crate::credentials::clear_named(&key(provider,0))?;for bank in 0..=1{for index in 1..=5{crate::credentials::clear_named(&bank_key(provider,bank,index))?;}}Ok(())}
    #[cfg(not(windows))]{let _=provider;Err("安全凭据需要Windows".into())}
}
fn safe_text(value:Option<&Value>,limit:usize)->String{value.and_then(Value::as_str).unwrap_or("").chars().filter(|c|!c.is_control()||*c=='\t').take(limit).collect()}
fn important(subject:&str)->bool{let subject=subject.to_lowercase();["security","verify","verification","invoice","bill","验证码","安全","账单","付款","登录","login"].iter().any(|word|subject.contains(word))}
pub fn graph_message(value:&Value)->MailMessage{
    let subject=safe_text(value.get("subject"),500);let sender=safe_text(value.pointer("/from/emailAddress/name"),250);let address=safe_text(value.pointer("/from/emailAddress/address"),254);
    MailMessage{id:safe_text(value.get("id"),600),important:important(&subject),subject,sender:if sender.is_empty(){address}else{format!("{sender} <{address}>")},received_at:safe_text(value.get("receivedDateTime"),100),unread:value["isRead"].as_bool().map(|read|!read)}
}
pub fn gmail_message(value:&Value)->MailMessage{
    let headers=value.pointer("/payload/headers").and_then(Value::as_array);
    let header=|name:&str|headers.and_then(|items|items.iter().find(|item|item["name"].as_str().is_some_and(|v|v.eq_ignore_ascii_case(name)))).map(|item|safe_text(item.get("value"),500)).unwrap_or_default();
    let subject=header("Subject");MailMessage{id:safe_text(value.get("id"),200),important:important(&subject),subject,sender:header("From"),received_at:header("Date"),unread:value["labelIds"].as_array().map(|items|items.iter().any(|item|item=="UNREAD"))}
}
#[cfg(windows)]fn api_get(host:&str,path:&str,token:&str)->Result<Value,String>{api_get_until(host,path,token,Instant::now()+Duration::from_secs(25))}
#[cfg(windows)]fn api_get_until(host:&str,path:&str,token:&str,deadline:Instant)->Result<Value,String>{
    if !matches!(host,"gmail.googleapis.com"|"graph.microsoft.com"){return Err("邮箱API目标无效".into());}
    if token.is_empty()||token.len()>12000||!token.is_ascii()||token.chars().any(char::is_control){return Err("令牌格式无效".into());}
    let mut headers=format!("Authorization: Bearer {token}\r\nAccept: application/json\r\n").into_bytes();
    let result=crate::http::mail_get_http(host,path,std::str::from_utf8(&headers).map_err(|_|"令牌编码无效")?,deadline);headers.fill(0);
    let (status,bytes)=result?;if status!=200{return Err(match status{401|403=>"邮箱授权已过期或权限不足，请重新连接",429=>"邮箱服务限流，请稍后读取",_=>"邮箱读取失败"}.into());}
    serde_json::from_slice(&bytes).map_err(|_|"邮箱响应格式无效".into())
}
#[cfg(windows)]fn api_snapshot(provider:MailProvider,secret:&MailSecret)->Result<MailSnapshot,String>{
    let started=Instant::now();let deadline=started+Duration::from_secs(45);let mut messages=Vec::new();let (count,source)=match provider{
        MailProvider::Outlook=>{let folder=api_get_until("graph.microsoft.com","/v1.0/me/mailFolders/inbox?$select=unreadItemCount",&secret.authorization,deadline)?;let list=api_get_until("graph.microsoft.com","/v1.0/me/mailFolders/inbox/messages?$top=12&$select=id,subject,from,receivedDateTime,isRead&$orderby=receivedDateTime%20desc",&secret.authorization,deadline)?;
            messages=list["value"].as_array().ok_or("Outlook邮件列表结构无效")?.iter().take(12).map(graph_message).collect();(folder["unreadItemCount"].as_u64(),"Microsoft Graph")},
        MailProvider::Gmail=>{let label=api_get_until("gmail.googleapis.com","/gmail/v1/users/me/labels/INBOX",&secret.authorization,deadline)?;let list=api_get_until("gmail.googleapis.com","/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=12",&secret.authorization,deadline)?;
            for item in list["messages"].as_array().unwrap_or(&Vec::new()).iter().take(12){if started.elapsed()>Duration::from_secs(40){return Err("邮箱读取达到时限，未将部分结果视为完整".into());}let id=item["id"].as_str().filter(|id|id.len()<=200&&id.bytes().all(|b|b.is_ascii_alphanumeric())).ok_or("Gmail邮件ID无效")?;let message=api_get_until("gmail.googleapis.com",&format!("/gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date"),&secret.authorization,deadline)?;messages.push(gmail_message(&message));}(label["messagesUnread"].as_u64(),"Gmail API")},_=>return Err("此账户使用IMAP读取".into())};
    Ok(MailSnapshot{provider,account:secret.email.clone(),unread_count:count,messages,observed_at_unix_ms:now_ms(),source:source.into()})
}
#[tauri::command]pub async fn mail_read_snapshot(provider:MailProvider)->Result<MailSnapshot,String>{
    tauri::async_runtime::spawn_blocking(move||{
        let _operation=begin_operation(provider)?;
        #[cfg(windows)]{let mut secret=load_secret(provider)?;if provider.imap_host().is_some(){crate::mail_imap::snapshot(provider,&secret)}else{crate::mail_oauth::refresh_if_needed(provider,&mut secret)?;api_snapshot(provider,&secret)}}
        #[cfg(not(windows))]{let _=provider;Err("邮箱连接需要Windows".into())}
    }).await.map_err(|_|"邮箱读取任务失败".to_string())?
}
#[cfg(test)]mod tests{use super::*;
    #[test]fn mailbox_addresses_cannot_inject_protocol_commands(){assert!(email_valid("a@qq.com",MailProvider::Qq));assert!(!email_valid("a@qq.com\r\nLOGOUT",MailProvider::Qq));assert!(!email_valid("a@other.com",MailProvider::Qq));}
    #[test]fn missing_read_status_is_not_marked_unread(){let message=graph_message(&serde_json::json!({"subject":"Invoice","id":"1"}));assert_eq!(message.unread,None);assert!(message.important);let mail=gmail_message(&serde_json::json!({"id":"1","payload":{"headers":[{"name":"subject","value":"hello"}]},"labelIds":["UNREAD"]}));assert_eq!(mail.unread,Some(true));assert_eq!(mail.subject,"hello");}
}

#[cfg(windows)]pub fn account_identity(provider:MailProvider,token:&str)->Result<String,String>{
    let value=match provider{MailProvider::Gmail=>api_get("gmail.googleapis.com","/gmail/v1/users/me/profile",token)?,MailProvider::Outlook=>api_get("graph.microsoft.com","/v1.0/me?$select=mail,userPrincipalName",token)?,_=>return Err("此账号不使用OAuth身份查询".into())};
    let email=if provider==MailProvider::Gmail{value["emailAddress"].as_str()}else{value["mail"].as_str().or_else(||value["userPrincipalName"].as_str())}.filter(|value|email_valid(value,provider)).ok_or("授权成功但邮箱身份无法确认")?;Ok(email.to_owned())
}
#[derive(Serialize)]#[serde(rename_all="camelCase")]
pub struct MailDetail {id:String,body:String,truncated:bool,source:String}
fn message_id(provider:MailProvider,id:&str)->Result<(),String>{
    if id.is_empty()||id.len()>600||id.contains("..")||!id.bytes().all(|byte|byte.is_ascii_alphanumeric()||b"-_=+/.:".contains(&byte)){return Err("邮件ID无效".into());}
    if provider.imap_host().is_some(){let (validity,uid)=id.split_once(':').ok_or("IMAP邮件版本缺失")?;if validity.parse::<u64>().is_err()||uid.parse::<u64>().is_err(){return Err("IMAP邮件ID无效".into());}}Ok(())
}
fn encoded_id(id:&str)->String{id.bytes().map(|byte|if byte.is_ascii_alphanumeric()||b"-_".contains(&byte){char::from(byte).to_string()}else{format!("%{byte:02X}")}).collect()}
#[tauri::command]pub async fn mail_read_detail(provider:MailProvider,id:String,expected_account:String)->Result<MailDetail,String>{
    message_id(provider,&id)?;
    tauri::async_runtime::spawn_blocking(move||{
        let _operation=begin_operation(provider)?;
        #[cfg(windows)]{
            let mut secret=load_secret(provider)?;if secret.email!=expected_account{return Err("邮箱账户已变化，请重新读取列表".into());}
            if provider.imap_host().is_some(){let (body,truncated)=crate::mail_imap::detail(provider,&secret,&id)?;return Ok(MailDetail{id,body,truncated,source:"TLS IMAP / BODY.PEEK".into()});}
            crate::mail_oauth::refresh_if_needed(provider,&mut secret)?;
            let (body,truncated,source)=if provider==MailProvider::Gmail {let message=api_get("gmail.googleapis.com",&format!("/gmail/v1/users/me/messages/{}?format=full",encoded_id(&id)),&secret.authorization)?;let (body,truncated)=crate::mail_display::gmail_body(&message["payload"])?;(body,truncated,"Gmail API")}
                else{let message=api_get("graph.microsoft.com",&format!("/v1.0/me/messages/{}?$select=body",encoded_id(&id)),&secret.authorization)?;let content=message.pointer("/body/content").and_then(Value::as_str).ok_or("邮件正文未知")?;let body=if message.pointer("/body/contentType").and_then(Value::as_str).is_some_and(|kind|kind.eq_ignore_ascii_case("html")){crate::mail_display::html_text(content)}else{content.to_owned()};let truncated=body.chars().count()>64000;(body.chars().take(64000).collect(),truncated,"Microsoft Graph")};
            Ok(MailDetail{id,body,truncated,source:source.into()})
        }
        #[cfg(not(windows))]{Err("邮件正文读取需要Windows".into())}
    }).await.map_err(|_|"邮件正文读取任务失败".to_string())?
}
#[tauri::command]pub async fn mail_mark_read(provider:MailProvider,id:String,expected_account:String,confirmed:bool)->Result<(),String>{
    if !confirmed{return Err("本次标记已读未确认".into());}message_id(provider,&id)?;
    tauri::async_runtime::spawn_blocking(move||{
        let _operation=begin_operation(provider)?;
        #[cfg(windows)]{
            let mut secret=load_secret(provider)?;if secret.email!=expected_account{return Err("邮箱账户已变化，请重新读取列表".into());}
            if provider.imap_host().is_some(){return crate::mail_imap::mark_read(provider,&secret,&id);}
            crate::mail_oauth::refresh_if_needed(provider,&mut secret)?;
            let (host,path,method,body)=if provider==MailProvider::Gmail {("gmail.googleapis.com",format!("/gmail/v1/users/me/messages/{}/modify",encoded_id(&id)),"POST",b"{\"removeLabelIds\":[\"UNREAD\"]}".as_slice())}
                else{("graph.microsoft.com",format!("/v1.0/me/messages/{}",encoded_id(&id)),"PATCH",b"{\"isRead\":true}".as_slice())};
            let mut headers=format!("Authorization: Bearer {}\r\nContent-Type: application/json\r\n",secret.authorization).into_bytes();
            let result=crate::http::mail_mark_read_http(host,&path,method,std::str::from_utf8(&headers).map_err(|_|"令牌编码无效")?,body,Instant::now()+Duration::from_secs(30));headers.fill(0);let (status,_)=result?;
            if !matches!(status,200|204){return Err("标记已读失败；可能需要重新授予邮件修改权限".into());}Ok(())
        }
        #[cfg(not(windows))]{Err("邮件状态操作需要Windows".into())}
    }).await.map_err(|_|"邮件状态任务失败".to_string())?
}

#[cfg(test)]mod action_tests {use super::*;
 #[test]fn operations_exclude_same_account_and_release_after_drop(){
  let first=begin_operation(MailProvider::Gmail).unwrap();
  assert!(begin_operation(MailProvider::Gmail).is_err());
  let other=begin_operation(MailProvider::Outlook).unwrap();drop(other);drop(first);
  assert!(begin_operation(MailProvider::Gmail).is_ok());
 }
 #[test]fn message_identifiers_cannot_supply_paths_or_commands(){assert!(message_id(MailProvider::Gmail,"../../send").is_err());assert!(message_id(MailProvider::Qq,"12:34").is_ok());assert!(message_id(MailProvider::Qq,"12:34\r\nLOGOUT").is_err());assert_eq!(encoded_id("a/b+="),"a%2Fb%2B%3D");}
}
