//! Read-only OTP notifications. Credentials use Windows Credential Manager;
//! message bodies and codes are held in memory only.
mod extract;
mod imap_reader;
mod api;
pub mod oauth;

use serde::{Deserialize,Serialize};
use std::{collections::BTreeMap,path::PathBuf,sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::{Duration,SystemTime,UNIX_EPOCH}};
use tauri::{AppHandle,Manager};

#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="lowercase")]
pub enum Provider {Qq,Mail163,Gmail,Outlook}
impl Provider {pub fn host(self)->Option<&'static str>{match self{Self::Qq=>Some("imap.qq.com"),Self::Mail163=>Some("imap.163.com"),_=>None}}}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Account {pub id:String,pub provider:Provider,pub email:String,pub enabled:bool}
#[derive(Clone,Default,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Cursor {pub validity:u32,pub uid:u32,pub seen:Vec<String>}
#[derive(Default,Serialize,Deserialize)]
struct Persist {accounts:Vec<Account>,cursors:BTreeMap<String,Cursor>}
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Notice {id:String,account_id:String,sender:String,code:String,received_at:u64,expires_at:u64}
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct AccountStatus {account_id:String,state:String,message:String}
#[derive(Serialize)]
pub struct Snapshot {accounts:Vec<Account>,statuses:Vec<AccountStatus>,notices:Vec<Notice>}
struct Worker {cancel:Arc<AtomicBool>}
#[derive(Default)]
struct Registry {persist:Persist,workers:BTreeMap<String,Worker>,statuses:BTreeMap<String,AccountStatus>,notices:Vec<Notice>,path:Option<PathBuf>}
#[derive(Default,Clone)]pub struct MailState(Arc<Mutex<Registry>>);
static EDIT:Mutex<()>=Mutex::new(());
static SECRETS:Mutex<()>=Mutex::new(());

#[derive(Serialize,Deserialize)]
pub struct Secret {pub email:String,pub authorization:String,pub refresh_token:Option<String>,pub client_id:Option<String>,pub client_secret:Option<String>,pub expires_at_unix_ms:Option<u64>}
impl Drop for Secret {fn drop(&mut self){for s in [&mut self.authorization,&mut self.email]{unsafe{s.as_bytes_mut().fill(0)}}for s in [&mut self.refresh_token,&mut self.client_id,&mut self.client_secret]{if let Some(v)=s {unsafe{v.as_bytes_mut().fill(0)}}}}}
pub fn now_ms()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64}
fn valid_id(id:&str)->bool{!id.is_empty()&&id.len()<=80&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_')}
fn credential(id:&str,suffix:&str)->Result<String,String>{if !valid_id(id){return Err("邮箱账户标识无效".into())}Ok(format!("GleamDesk.MailOtp.{id}.{suffix}"))}

pub fn save_secret(id:&str,secret:&Secret)->Result<(),String>{
 let _lock=SECRETS.lock().map_err(|_|"邮箱凭据正在使用")?;
 let meta=credential(id,"meta")?;
 let bank=if crate::credentials::exists_named(&meta)?{let old=crate::credentials::read_named(&meta)?;if old.as_str().starts_with("0:"){1}else{0}}else{0};
 let mut body=serde_json::to_string(secret).map_err(|_|"邮箱凭据编码失败")?;
 let result=(||{if body.len()>20000{return Err("邮箱授权信息超过保存上限".into())}let mut start=0;let mut count=0;while start<body.len(){let mut end=(start+2400).min(body.len());while !body.is_char_boundary(end){end-=1}crate::credentials::save_named(&credential(id,&format!("{bank}-{count}"))?,&body[start..end])?;start=end;count+=1;}crate::credentials::save_named(&meta,&format!("{bank}:{count}"))})();
 unsafe{body.as_bytes_mut().fill(0)}result
}
fn load_secret(id:&str)->Result<Secret,String>{
 let _lock=SECRETS.lock().map_err(|_|"邮箱凭据正在使用")?;
 let meta=crate::credentials::read_named(&credential(id,"meta")?)?;
 let (bank,count)=meta.as_str().split_once(':').ok_or("邮箱凭据记录无效")?;
 if !matches!(bank,"0"|"1"){return Err("邮箱凭据记录无效".into())}
 let count:usize=count.parse().map_err(|_|"邮箱凭据记录无效")?;if !(1..=9).contains(&count){return Err("邮箱凭据记录无效".into())}
 let mut body=Vec::new();for n in 0..count{let part=crate::credentials::read_named(&credential(id,&format!("{bank}-{n}"))?)?;body.extend_from_slice(part.as_str().as_bytes())}
 let result=serde_json::from_slice(&body).map_err(|_|"邮箱凭据记录无效".into());body.fill(0);result
}
fn clear_secret(id:&str)->Result<(),String>{let _lock=SECRETS.lock().map_err(|_|"邮箱凭据正在使用")?;crate::credentials::clear_named(&credential(id,"meta")?)?;for bank in 0..=1{for n in 0..9{crate::credentials::clear_named(&credential(id,&format!("{bank}-{n}"))?)?}}Ok(())}
fn persist(reg:&Registry)->Result<(),String>{let path=reg.path.as_ref().ok_or("邮箱设置尚未载入")?;let body=serde_json::to_vec(&reg.persist).map_err(|_|"邮箱设置编码失败")?;crate::launcher::replace_config_bytes(path,&body).map_err(|_|"邮箱设置无法保存，原文件保留".to_string())}
pub fn start(app:&AppHandle)->Result<(),String>{
 let state=app.state::<MailState>();let path=app.path().app_data_dir().map_err(|_|"应用目录不可用")?.join("mail-otp.json");
 std::fs::create_dir_all(path.parent().ok_or("应用目录不可用")?).map_err(|_|"应用目录无法创建")?;let loaded=match std::fs::read(&path){Ok(bytes)=>{if bytes.len()>1024*1024{return Err("邮箱设置超过上限".into())}serde_json::from_slice::<Persist>(&bytes).map_err(|_|"邮箱设置损坏，未覆盖原文件")?},Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Persist::default(),Err(_)=>return Err("邮箱设置无法读取，未覆盖原文件".into())};
 if loaded.accounts.len()>12||loaded.accounts.iter().any(|a|!valid_id(&a.id)||validate_email(&a.email,a.provider).is_err()){return Err("邮箱账户设置无效".into())}
 {let mut reg=state.0.lock().map_err(|_|"邮箱状态不可用")?;reg.persist=loaded;reg.path=Some(path);}
 sync(app);Ok(())
}
fn validate_email(email:&str,provider:Provider)->Result<(),String>{let Some((local,domain))=email.split_once('@')else{return Err("请填写完整邮箱地址".into())};if local.is_empty()||email.len()>254||email.chars().any(|c|c.is_control()||c.is_whitespace())||!domain.contains('.')||domain.contains('@'){return Err("邮箱地址无效".into())}if provider==Provider::Qq&&!matches!(domain.to_ascii_lowercase().as_str(),"qq.com"|"foxmail.com"){return Err("QQ 账户请填写 qq.com 或 foxmail.com 邮箱".into())}if provider==Provider::Mail163&&domain.to_ascii_lowercase()!="163.com"{return Err("163 账户请填写 163.com 邮箱".into())}Ok(())}
pub fn add_authorized(app:&AppHandle,provider:Provider,secret:Secret)->Result<Account,String>{
 let _edit=EDIT.lock().map_err(|_|"邮箱设置正在保存")?;validate_email(&secret.email,provider)?;
 let state=app.state::<MailState>();let account={let reg=state.0.lock().map_err(|_|"邮箱状态不可用")?;if reg.path.is_none(){return Err("邮箱设置尚未载入".into())}if reg.persist.accounts.iter().any(|a|a.provider==provider&&a.email.eq_ignore_ascii_case(&secret.email)){return Err("该邮箱已添加，请先移除旧连接再重新授权".into())}if reg.persist.accounts.len()>=12{return Err("最多添加 12 个邮箱".into())}Account{id:format!("{:x}-{}",now_ms(),oauth::random_text()?),provider,email:secret.email.clone(),enabled:true}};
 save_secret(&account.id,&secret)?;
 {let mut reg=state.0.lock().map_err(|_|"邮箱状态不可用")?;reg.persist.accounts.push(account.clone());if let Err(error)=persist(&reg){reg.persist.accounts.pop();let _=clear_secret(&account.id);return Err(error)}}
 sync(app);Ok(account)
}
#[tauri::command]pub fn mail_otp_snapshot(state:tauri::State<'_,MailState>)->Result<Snapshot,String>{let mut reg=state.0.lock().map_err(|_|"邮箱状态不可用")?;reg.notices.retain(|n|n.expires_at>now_ms());if reg.path.is_none(){return Err("邮箱设置读取失败；原文件保持不变".into())}Ok(Snapshot{accounts:reg.persist.accounts.clone(),statuses:reg.statuses.values().cloned().collect(),notices:reg.notices.clone()})}
#[tauri::command]pub async fn mail_otp_add(app:AppHandle,provider:Provider,email:String,authorization:String,consent:bool)->Result<Account,String>{
 let _permit=crate::simulation::require_live()?;if !consent{return Err("请先同意本机保存授权并只读查收新邮件".into())}if provider.host().is_none(){return Err("此邮箱请使用官方网页登录".into())}validate_email(&email,provider)?;
 let secret=Secret{email,authorization,refresh_token:None,client_id:None,client_secret:None,expires_at_unix_ms:None};if secret.authorization.is_empty()||secret.authorization.len()>2048||secret.authorization.chars().any(char::is_control){return Err("请填写邮箱客户端授权码".into())}
 tauri::async_runtime::spawn_blocking(move||{imap_reader::probe(provider,&secret)?;add_authorized(&app,provider,secret)}).await.map_err(|_|"邮箱连接任务失败")?
}
#[tauri::command]
pub fn mail_otp_update(app:AppHandle,id:String,enabled:bool,remove:bool)->Result<(),String>{
 let _edit=EDIT.lock().map_err(|_|"邮箱设置正在保存")?;
 let state=app.state::<MailState>();
 {
  let mut reg=state.0.lock().map_err(|_|"邮箱状态不可用")?;
  let index=reg.persist.accounts.iter().position(|a|a.id==id).ok_or("邮箱账户不存在")?;
  let previous=reg.persist.accounts[index].enabled;
  // Persist a paused account first. If credential deletion fails it stays visible and retryable.
  reg.persist.accounts[index].enabled=if remove{false}else{enabled};
  if let Err(e)=persist(&reg){reg.persist.accounts[index].enabled=previous;return Err(e)}
  if let Some(w)=reg.workers.remove(&id){w.cancel.store(true,Ordering::SeqCst)}
  reg.notices.retain(|n|n.account_id!=id);reg.statuses.remove(&id);
 }
 if remove{
  clear_secret(&id).map_err(|_|"账户已暂停，授权信息未能完全移除，请重试")?;
  let mut reg=state.0.lock().map_err(|_|"邮箱状态不可用")?;
  let index=reg.persist.accounts.iter().position(|a|a.id==id).ok_or("邮箱账户不存在")?;
  let old=reg.persist.accounts.remove(index);let cursor=reg.persist.cursors.remove(&id);
  if let Err(e)=persist(&reg){reg.persist.accounts.insert(index,old);if let Some(c)=cursor{reg.persist.cursors.insert(id.clone(),c);}return Err(e)}
 }
 sync(&app);Ok(())
}
fn status(state:&MailState,account:&Account,cancel:&AtomicBool,value:&str,message:&str){if let Ok(mut reg)=state.0.lock(){if !cancel.load(Ordering::SeqCst){reg.statuses.insert(account.id.clone(),AccountStatus{account_id:account.id.clone(),state:value.into(),message:message.into()});}}}
fn sync(app:&AppHandle){let state=app.state::<MailState>().inner().clone();let mut reg=match state.0.lock(){Ok(r)=>r,Err(_)=>return};let accounts=reg.persist.accounts.clone();for a in accounts.into_iter().filter(|a|a.enabled){if reg.workers.contains_key(&a.id){continue}let cancel=Arc::new(AtomicBool::new(false));reg.workers.insert(a.id.clone(),Worker{cancel:cancel.clone()});let state=state.clone();std::thread::spawn(move||worker(state,a,cancel));}}
pub struct Incoming {pub id:String,pub sender:String,pub subject:String,pub body:String,pub received:u64}
fn recognize(subject:&str,body:&str)->Option<String>{let first=extract::extract(subject,body,&[])?;let other=extract::extract(&subject.replace(&first.text," "),&body.replace(&first.text," "),&[]);if other.is_some_and(|other|other.text!=first.text){return None}Some(first.text)}
pub fn accept_notice(account:&Account,item:Incoming,now:u64)->Option<Notice>{if item.received>now+60_000||now.saturating_sub(item.received)>300_000{return None}let code=recognize(&item.subject,&item.body)?;Some(Notice{id:format!("{}:{}",account.id,item.id),account_id:account.id.clone(),sender:item.sender.chars().filter(|c|!c.is_control()).take(80).collect(),code,received_at:item.received,expires_at:item.received.saturating_add(300_000)})}
fn commit(state:&MailState,a:&Account,cancel:&AtomicBool,cursor:Cursor,items:Vec<Incoming>)->Result<(),String>{let mut reg=state.0.lock().map_err(|_|"邮箱状态不可用")?;if cancel.load(Ordering::SeqCst){return Ok(())}let _permit=crate::simulation::require_live()?;let now=now_ms();reg.notices.retain(|n|n.expires_at>now);for item in items{if let Some(notice)=accept_notice(a,item,now){if !reg.notices.iter().any(|n|n.id==notice.id){reg.notices.push(notice)}}}if reg.notices.len()>30{let excess=reg.notices.len()-30;reg.notices.drain(..excess);}if reg.persist.cursors.get(&a.id)!=Some(&cursor){let old=reg.persist.cursors.insert(a.id.clone(),cursor);if let Err(e)=persist(&reg){if let Some(old)=old{reg.persist.cursors.insert(a.id.clone(),old);}else{reg.persist.cursors.remove(&a.id);}return Err(e)}}Ok(())}
fn worker(state:MailState,a:Account,cancel:Arc<AtomicBool>){let mut delay=5;while !cancel.load(Ordering::SeqCst){if crate::simulation::require_live().is_err(){status(&state,&a,&cancel,"paused","模拟模式暂停查收");pause(&cancel,2);continue}status(&state,&a,&cancel,"connecting","");let result=(||{let mut secret=load_secret(&a.id)?;if secret.email!=a.email{return Err("账户与授权信息不匹配，请重新连接".into())}let cursor=state.0.lock().map_err(|_|"邮箱状态不可用")?.persist.cursors.get(&a.id).cloned().unwrap_or_default();if a.provider.host().is_some(){imap_reader::watch(&a,&secret,cursor,&cancel,|c,items|{commit(&state,&a,&cancel,c,items)?;status(&state,&a,&cancel,"ready","");Ok(())})}else{while !cancel.load(Ordering::SeqCst){let c=state.0.lock().map_err(|_|"邮箱状态不可用")?.persist.cursors.get(&a.id).cloned().unwrap_or_default();oauth::refresh_if_needed(&a,&mut secret,&state,&cancel)?;let (c,items)=api::poll(&a,&secret,c,&||{if cancel.load(Ordering::SeqCst){return Err("邮箱监听已停止".into())}crate::simulation::require_live()?.check()})?;commit(&state,&a,&cancel,c,items)?;status(&state,&a,&cancel,"ready","");pause(&cancel,30);}Ok(())}})();if let Err(message)=result{status(&state,&a,&cancel,"error",&message);pause(&cancel,delay);delay=(delay*2).min(300)}else{delay=5;}}}
pub fn pause(cancel:&AtomicBool,seconds:u64){for _ in 0..seconds*5{if cancel.load(Ordering::SeqCst){break}std::thread::sleep(Duration::from_millis(200));}}

#[cfg(test)]mod tests{use super::*;fn a()->Account{Account{id:"one".into(),provider:Provider::Qq,email:"a@qq.com".into(),enabled:true}}fn item(received:u64)->Incoming{Incoming{id:"42".into(),sender:"Example".into(),subject:"验证码".into(),body:"验证码：834921，5分钟内有效".into(),received}}
#[test]fn only_recent_messages_can_create_notifications(){assert!(accept_notice(&a(),item(1000),400_000).is_none());assert!(accept_notice(&a(),item(500_000),1000).is_none());assert_eq!(accept_notice(&a(),item(1000),2000).unwrap().code,"834921");}
#[test]fn accounts_and_cursors_never_contain_codes_or_authorization(){let p=Persist{accounts:vec![a()],cursors:BTreeMap::new()};let json=serde_json::to_string(&p).unwrap();assert!(!json.contains("authorization")&&!json.contains("code")&&!json.contains("body"));}
#[test]fn account_ids_and_email_validation_reject_injection(){assert!(!valid_id("../other"));assert!(validate_email("a@qq.com\r\nLOGIN",Provider::Qq).is_err());assert!(validate_email("a@gmail.com",Provider::Qq).is_err());}
#[test]fn two_equally_likely_codes_are_not_guessed(){assert!(recognize("Verification code","Verification code: 834921\nVerification code: 765432").is_none());assert_eq!(recognize("Verification code","Your verification code is 834921. Order number: 765432"),Some("834921".into()));}
}
