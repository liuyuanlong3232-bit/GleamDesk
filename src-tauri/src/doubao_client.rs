// Official quota parsing adapted from Wahwayhale/dsh-connect-doubao (MIT).
// Browser-session approach: revision 8cefed037b065da481113b8182858ac037f1ba62.
// Use a separate, user-operated WebView login; never open the desktop Cookies DB.
// Only the captured session persists, protected by current-user DPAPI for <=7 days.
use super::*;
use std::{io::Read,path::Path,sync::Mutex};
use tauri::{Emitter,Manager};
use windows_sys::Win32::Security::Cryptography::*;
const REQUIRED:&[&str]=&["sessionid","sessionid_ss","sid_tt","uid_tt"];
const QUOTA_PATH:&str="/alice/commerce/sale/subscription/quota/summary/";
const MAX_SESSION_AGE:u64=7*24*60*60*1000;
const BROWSER_SCOPE:&str="gleamdesk-doubao-browser-v1";
static SESSION_WRITE:Mutex<()>=Mutex::new(());
struct Login{header:crate::credentials::Secret,token:Option<crate::credentials::Secret>,expires:u64}
struct Sensitive(Vec<u8>);
impl Drop for Sensitive{fn drop(&mut self){self.0.fill(0)}}
#[derive(Default)]
pub(super) struct BrowserState{flow:Mutex<Flow>}
#[derive(Default)]
struct Flow{generation:u64,label:Option<String>,connecting:bool}
fn failure(issue:&'static str)->AgentObservation{
 let mut result=account("doubao","豆包");result.source="doubao-client-api";
 result.reason=if matches!(issue,"browser-not-connected"|"cache-expired"|"not-logged-in"|"login-expired"){"not-logged-in"}else if issue=="quota-unavailable"{"quota-unavailable"}else{"read-failed"};
 if result.reason=="not-logged-in"{result.login_status="not-logged-in";}
 result.membership=Some(serde_json::json!({"available":false,"benefits":[],"source":"doubao-client-api","readIssue":issue}));result
}
fn parse_quota(value:&Value)->AgentObservation{
 if value.get("code").is_some_and(|v|v.as_i64()!=Some(0)&&v.as_str()!=Some("0")){return failure("response-rejected")}
 let data=&value["data"];let section=&data["window_limit_section"];
 let mut result=account("doubao","豆包");result.source="doubao-client-api";result.installed=true;
 result.plan=bounded_text(data.pointer("/current_subscription/display/short_name")).or_else(||bounded_text(data.pointer("/current_subscription/display/product_name")));
 let mut benefits=vec![];
 for (section,incentive) in [(section,false),(&data["incentive_quota_section"],true)]{
 for (g,group) in section["window_limit_groups"].as_array().into_iter().flatten().take(16).enumerate(){
  for (i,row) in group["window_limits"].as_array().into_iter().flatten().take(16).enumerate(){
   let (label,minutes)=if incentive{("活动赠送额度",None)}else{match row["window_type"].as_u64(){Some(1)=>("5 小时额度",Some(300)),Some(2)=>("周额度",Some(10080)),_=>continue}};
   let Some(used)=valid_percent(&row["used_percent"])else{continue};
   let less=row["less_than_one_percent"]==true;
   benefits.push(serde_json::json!({"label":label,"detail":if less{"已用 <1%".into()}else{format!("已用 {used}%")}}));
   // A bound (<1%) is not an exact 1% or 0%. Preserve it in the member display.
   if !less{
    let reset=row["end_time"].as_u64().filter(|at|*at>0&&*at<=253_402_300_799_999);
    result.windows.push(UsageWindow{id:format!("{}:{g}:{i}",if incentive{"gift"}else{"member"}),used_percent:used,window_duration_mins:minutes,resets_at_unix_ms:reset,title:Some(label.into())});
   }
  }
 }
 }
 if benefits.is_empty(){return failure("quota-unavailable")}
 result.login_status="verified";result.confidence="verified";result.reason="";
 let exhausted=section["usage_exhausted"]==true||data["enterprise_window_limit_section"]["usage_exhausted"]==true;
 result.ordinary_usage_allowed=Some(!exhausted);result.state=if exhausted||result.windows.iter().any(|w|w.used_percent>=100.){"warning"}else{"normal"};
 result.membership=Some(serde_json::json!({"available":true,"source":"doubao-client-api","planName":result.plan,"benefits":benefits,"cached":false,"observedAtUnixMs":result.observed_at_unix_ms}));result
}
fn unprotect(input:&[u8])->Result<Sensitive,&'static str>{
 let mut output=CRYPT_INTEGER_BLOB::default();let blob=CRYPT_INTEGER_BLOB{cbData:input.len() as u32,pbData:input.as_ptr() as *mut u8};
 if input.is_empty()||input.len()>256*1024||unsafe{CryptUnprotectData(&blob,std::ptr::null_mut(),std::ptr::null(),std::ptr::null(),std::ptr::null(),CRYPTPROTECT_UI_FORBIDDEN,&mut output)}==0{return Err("login-unreadable")}
 let result=if output.pbData.is_null()||output.cbData>256*1024{Err("login-unreadable")}else{
  let bytes=unsafe{std::slice::from_raw_parts_mut(output.pbData,output.cbData as usize)};let result=Sensitive(bytes.to_vec());bytes.fill(0);Ok(result)
 };
 unsafe{windows_sys::Win32::Foundation::LocalFree(output.pbData as _);};result
}
fn bounded_file(path:&Path)->Result<Sensitive,&'static str>{
 let mut bytes=Sensitive(vec![]);std::fs::File::open(path).map_err(|_|"login-unreadable")?.take(4*1024*1024+1).read_to_end(&mut bytes.0).map_err(|_|"login-unreadable")?;
 if bytes.0.len()>4*1024*1024{return Err("login-unreadable")}Ok(bytes)
}
#[derive(serde::Serialize,serde::Deserialize)]
struct SavedLogin{version:u8,profile:String,saved_at:u64,expires:u64,header:String,token:Option<String>}
impl Drop for SavedLogin{fn drop(&mut self){std::mem::take(&mut self.header).into_bytes().fill(0);if let Some(token)=self.token.take(){token.into_bytes().fill(0)}}}
fn save_login(dir:&Path,scope:&str,login:&Login,now:u64)->Result<(),&'static str>{
 let payload=SavedLogin{version:3,profile:scope.into(),saved_at:now,expires:login.expires.min(now+MAX_SESSION_AGE),header:login.header.as_str().into(),token:login.token.as_ref().map(|s|s.as_str().into())};
 let body=Sensitive(serde_json::to_vec(&payload).map_err(|_|"cache-unavailable")?);
 if body.0.len()>128*1024{return Err("cache-unavailable")}
 let input=CRYPT_INTEGER_BLOB{cbData:body.0.len() as u32,pbData:body.0.as_ptr() as *mut u8};let mut output=CRYPT_INTEGER_BLOB::default();
 if unsafe{CryptProtectData(&input,std::ptr::null(),std::ptr::null(),std::ptr::null(),std::ptr::null(),CRYPTPROTECT_UI_FORBIDDEN,&mut output)}==0{return Err("cache-unavailable")}
 let result=if output.pbData.is_null()||output.cbData>256*1024{Err("cache-unavailable")}else{
  let bytes=unsafe{std::slice::from_raw_parts(output.pbData,output.cbData as usize)};
  std::fs::create_dir_all(dir).and_then(|_|std::fs::write(dir.join("doubao-browser-session.dpapi.tmp"),bytes)).and_then(|_|std::fs::rename(dir.join("doubao-browser-session.dpapi.tmp"),cache_file(dir))).map_err(|_|"cache-unavailable")
 };
 unsafe{windows_sys::Win32::Foundation::LocalFree(output.pbData as _);};result
}
fn query_path(token:Option<&str>)->String{
 // Same fixed desktop request parameters as the verified upstream implementation.
 let mut params=tauri::Url::parse("https://www.doubao.com").unwrap();
 params.query_pairs_mut().extend_pairs([("aid","582478"),("real_aid","582478"),("version_code","20800"),("pc_version","2.31.4"),("device_id","2697515174213273"),("tea_uuid","2697515174213273"),("web_id","7677868049198630415"),("fp","verify_2697515174213273"),("chromium_version","147.0.7727.149"),("runtime_version","3.39.0"),("channel","win"),("language","zh"),("region","CN"),("sys_region","CN"),("tz_name","Asia/Shanghai"),("pkg_type","release_version"),("client_platform","pc_client"),("device_platform","web"),("doubao_device_platform","desktop"),("web_platform","desktop"),("samantha_web","1"),("use-olympus-account","1")]);
 if let Some(token)=token{params.query_pairs_mut().append_pair("msToken",token);}
 format!("{QUOTA_PATH}?{}",params.query().unwrap_or(""))
}

fn cache_file(dir:&Path)->PathBuf{dir.join("doubao-browser-session.dpapi")}
fn valid_pair(name:&str,value:&str)->bool{
 !name.is_empty()&&name.len()<=100&&name.bytes().all(|c|c.is_ascii_alphanumeric()||b"-_.".contains(&c))
 &&!value.is_empty()&&value.len()<=16384&&value.bytes().all(|b|(0x20..=0x7e).contains(&b)&&b!=b';')
}
fn validate_header(header:&str)->Result<(),&'static str>{
 if header.is_empty()||header.len()>64*1024{return Err("cache-invalid")}
 let mut names=std::collections::BTreeSet::new();
 for pair in header.split("; "){
  let (name,value)=pair.split_once('=').ok_or("cache-invalid")?;
  if !valid_pair(name,value)||!names.insert(name){return Err("cache-invalid")}
 }
 if REQUIRED.iter().any(|name|!names.contains(name)){return Err("not-logged-in")}Ok(())
}
fn load_login(dir:&Path,now:u64)->Result<(Login,String),&'static str>{
 let encrypted=bounded_file(&cache_file(dir)).map_err(|_|"browser-not-connected")?;
 if encrypted.0.len()>256*1024{return Err("cache-invalid")}
 let signature=crate::analysis::sha256(&encrypted.0).map_err(|_|"cache-invalid")?;
 let plain=unprotect(&encrypted.0).map_err(|_|"cache-invalid")?;
 let mut payload:SavedLogin=serde_json::from_slice(&plain.0).map_err(|_|"cache-invalid")?;
 if payload.version!=3||payload.profile!=BROWSER_SCOPE{return Err("cache-invalid")}
 if payload.saved_at>now||payload.expires<=now||payload.expires>payload.saved_at.saturating_add(MAX_SESSION_AGE){return Err("cache-expired")}
 validate_header(&payload.header)?;
 if payload.token.as_ref().is_some_and(|value|!valid_pair("msToken",value)){return Err("cache-invalid")}
 Ok((Login{header:crate::credentials::Secret::from_string(std::mem::take(&mut payload.header)),token:payload.token.take().map(crate::credentials::Secret::from_string),expires:payload.expires},signature))
}
pub(super) fn source_scope(dir:Option<&Path>)->Result<String,String>{
 let Some(dir)=dir else{return Ok("doubao-browser-unavailable".into())};
 Ok(match load_login(dir,observed_unix_ms()){
  Ok((_,signature))=>format!("doubao-browser:{signature}"),
  Err(issue)=>format!("doubao-browser:{issue}"),
 })
}
fn remove_login(dir:&Path)->Result<(),String>{
 match std::fs::remove_file(cache_file(dir)){
  Ok(())=>Ok(()),Err(error)if error.kind()==std::io::ErrorKind::NotFound=>Ok(()),
  Err(_)=>Err("豆包登录缓存无法清除，请关闭后重试".into()),
 }
}
fn reject_login(dir:&Path,signature:&str){
 if let Ok(_guard)=SESSION_WRITE.lock(){
  if load_login(dir,observed_unix_ms()).is_ok_and(|(_,current)|current==signature){let _=remove_login(dir);}
 }
}
fn login_navigation(url:&tauri::Url)->bool{
 url.scheme()=="https"&&url.host_str().is_some_and(|host|["doubao.com","bytedance.com","zijieapi.com"].iter().any(|domain|host==*domain||host.ends_with(&format!(".{domain}"))))
}
fn capture_login(view:&tauri::WebviewWindow)->Result<Login,String>{
 let current=view.url().map_err(|_|"豆包登录窗口地址不可读")?;
 if current.scheme()!="https"||current.host_str()!=Some("www.doubao.com"){return Err("请先在豆包官方页面完成登录，再点完成连接".into())}
 let url=tauri::Url::parse(&format!("https://www.doubao.com{QUOTA_PATH}")).map_err(|_|"豆包官方网址无效")?;
 let cookies=view.cookies_for_url(url).map_err(|_|"豆包登录状态暂时不可读")?;
 let now=observed_unix_ms();let mut expires=now+MAX_SESSION_AGE;
 let mut pairs=std::collections::BTreeMap::<String,crate::credentials::Secret>::new();
 for cookie in cookies{
  let name=cookie.name();let value=cookie.value();
  if !valid_pair(name,value){continue}
  if let Some(at)=cookie.expires_datetime(){
   let at=at.unix_timestamp().max(0) as u64*1000;
   if at<=now{continue}if REQUIRED.contains(&name){expires=expires.min(at)}
  }
  if let Some(previous)=pairs.get(name){
   if REQUIRED.contains(&name)&&previous.as_str()!=value{return Err("豆包登录状态不一致，请重新连接".into())}
  }else{pairs.insert(name.into(),crate::credentials::Secret::from_string(value.into()));}
 }
 if REQUIRED.iter().any(|name|!pairs.contains_key(*name)){return Err("豆包尚未完成登录，请登录后再点完成连接".into())}
 let mut header=String::new();for (name,value) in &pairs{if !header.is_empty(){header.push_str("; ")}header.push_str(name);header.push('=');header.push_str(value.as_str());}
 let header=crate::credentials::Secret::from_string(header);
 validate_header(header.as_str()).map_err(|_|"豆包登录状态格式无效")?;
 Ok(Login{header,token:pairs.remove("msToken"),expires})
}
fn same_account(a:&Login,b:&Login)->bool{
 fn identity(header:&str)->Vec<(&str,&str)>{header.split("; ").filter_map(|part|part.split_once('=')).filter(|(key,_)|REQUIRED.contains(key)).collect()}
 identity(a.header.as_str())==identity(b.header.as_str())
}
pub(super) fn open(app:&tauri::AppHandle)->Result<(),String>{
 let state=app.state::<AgentUsageState>();
 let existing=state.browser_login.flow.lock().map_err(|_|"豆包连接忙碌")?.label.clone();
 if let Some(view)=existing.and_then(|label|app.get_webview_window(&label)){
  view.show().map_err(|_|"豆包登录窗口无法显示")?;return view.set_focus().map_err(|_|"豆包登录窗口无法聚焦".into());
 }
 let dir=app.path().app_data_dir().map_err(|_|"豆包登录目录不可用")?;
 let (generation,label)={
  let mut flow=state.browser_login.flow.lock().map_err(|_|"豆包连接忙碌")?;
  let _guard=SESSION_WRITE.lock().map_err(|_|"豆包登录保存忙碌")?;remove_login(&dir)?;
  flow.generation=flow.generation.saturating_add(1);flow.connecting=false;
  let label=format!("doubao-account-{}",flow.generation);flow.label=Some(label.clone());(flow.generation,label)
 };
 let _=state.account_scope.revision("doubao",true,Some(&dir));
 let _=app.emit("agent-usage-changed",serde_json::json!({"agentId":"doubao"}));
 let url=tauri::Url::parse("https://www.doubao.com/chat/").map_err(|_|"豆包官方网址无效")?;
 let view=tauri::WebviewWindowBuilder::new(app,&label,tauri::WebviewUrl::External(url))
  .title("豆包官方登录 · 登录后返回工作台点完成连接")
  .inner_size(1050.,760.).data_directory(dir.join("doubao-login-webview")).incognito(true)
  .on_navigation(login_navigation).on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny)
  .build().map_err(|_|"豆包登录窗口创建失败")?;
 let app=app.clone();
 view.on_window_event(move|event|{
  if matches!(event,tauri::WindowEvent::Destroyed){
   let state=app.state::<AgentUsageState>();if let Ok(mut flow)=state.browser_login.flow.lock(){
    if flow.generation==generation{flow.generation=flow.generation.saturating_add(1);flow.label=None;flow.connecting=false;}
   };
  }
 });Ok(())
}
pub(super) fn connect(app:&tauri::AppHandle)->Result<(),String>{
 let state=app.state::<AgentUsageState>();
 let (generation,label)={
  let mut flow=state.browser_login.flow.lock().map_err(|_|"豆包连接忙碌")?;
  if flow.connecting{return Err("正在连接豆包，请稍候".into())}
  let label=flow.label.clone().ok_or("请先点击连接豆包并完成官方登录")?;
  flow.connecting=true;(flow.generation,label)
 };
 let result=(||{
  let view=app.get_webview_window(&label).ok_or("豆包登录窗口已关闭，请重新连接")?;
  let login=capture_login(&view)?;let result=query_quota(&login);
  // A missing/unsupported quota is not proof of a usable login.
  if result.login_status!="verified"{
   return Err(match result.membership.as_ref().and_then(|m|m["readIssue"].as_str()){
    Some("quota-unavailable")=>"豆包已响应，但未返回可识别额度；请确认此账号支持会员额度",
    Some("request-failed")=>"豆包额度连接失败，请稍后再次点完成连接",
    _=>"豆包未接受此登录，请确认登录完成后重试",
   }.into())
  }
  let current=capture_login(&view)?;
  if !same_account(&login,&current){return Err("连接时豆包账号发生变化，请重新连接".into())}
  let dir=app.path().app_data_dir().map_err(|_|"豆包登录目录不可用")?;
  {
   let flow=state.browser_login.flow.lock().map_err(|_|"豆包连接忙碌")?;
   if flow.generation!=generation||flow.label.as_deref()!=Some(&label){return Err("本次豆包连接已取消".into())}
   let _guard=SESSION_WRITE.lock().map_err(|_|"豆包登录保存忙碌")?;
   save_login(&dir,BROWSER_SCOPE,&current,observed_unix_ms()).map_err(|_|"豆包额度已验证，但加密登录保存失败，请重试")?;
  }
  let _=state.account_scope.revision("doubao",true,Some(&dir));
  let _=view.close();let _=app.emit("agent-usage-changed",serde_json::json!({"agentId":"doubao"}));Ok(())
 })();
 if let Ok(mut flow)=state.browser_login.flow.lock(){if flow.generation==generation{flow.connecting=false;}}
 result
}
pub(super) fn disconnect(app:&tauri::AppHandle)->Result<(),String>{
 let dir=app.path().app_data_dir().map_err(|_|"豆包登录目录不可用")?;
 let state=app.state::<AgentUsageState>();let label={
  let mut flow=state.browser_login.flow.lock().map_err(|_|"豆包连接忙碌")?;
  let _guard=SESSION_WRITE.lock().map_err(|_|"豆包登录保存忙碌")?;remove_login(&dir)?;
  flow.generation=flow.generation.saturating_add(1);flow.connecting=false;flow.label.take()
 };
 if let Some(view)=label.and_then(|label|app.get_webview_window(&label)){let _=view.close();}
 let _=state.account_scope.revision("doubao",true,Some(&dir));
 let _=app.emit("agent-usage-changed",serde_json::json!({"agentId":"doubao"}));Ok(())
}
fn query_quota(login:&Login)->AgentObservation{
 let path=crate::credentials::Secret::from_string(query_path(login.token.as_ref().map(|s|s.as_str())));
 let headers=crate::credentials::Secret::from_string(format!("User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/2.31.4\r\nReferer: chrome://doubao-chat/\r\nContent-Type: application/json\r\nAccept: */*\r\nAccept-Language: zh-CN,zh;q=0.9\r\nagw-js-conv: str\r\nCookie: {}\r\n",login.header.as_str()));
 match crate::http::post_doubao_quota(path.as_str(),headers.as_str()){
  Ok((200,bytes))=>{
   let body=Sensitive(bytes);let result=serde_json::from_slice(&body.0).map(|value|parse_quota(&value)).unwrap_or_else(|_|failure("response-invalid"));
   if result.reason=="quota-unavailable"{
    let overview=crate::credentials::Secret::from_string(path.as_str().replacen(QUOTA_PATH,"/alice/commerce/sale/subscription/overview/",1));
    if let Ok((200,bytes))=crate::http::post_doubao_quota(overview.as_str(),headers.as_str()){
     let bytes=Sensitive(bytes);if let Ok(value)=serde_json::from_slice::<Value>(&bytes.0){return parse_quota(&value)}
    }
   }result
  },
  Ok((401,_))=>failure("login-expired"),Ok((403,_))=>failure("response-rejected"),_=>failure("request-failed"),
 }
}
pub(super) fn read(cache_dir:Option<&Path>)->AgentObservation{
 let Some(dir)=cache_dir else{return failure("browser-not-connected")};
 let (login,signature)=match load_login(dir,observed_unix_ms()){Ok(login)=>login,Err(issue)=>return failure(issue)};
 let result=query_quota(&login);
 if result.membership.as_ref().is_some_and(|m|m["readIssue"]=="login-expired"){reject_login(dir,&signature);}
 result
}

#[cfg(test)]
mod tests{
 use super::*;use serde_json::json;
 fn synthetic_login(value:&str,expires:u64)->Login{
  Login{header:crate::credentials::Secret::from_string(REQUIRED.iter().map(|name|format!("{name}={value}")).collect::<Vec<_>>().join("; ")),token:None,expires}
 }
 #[test]fn browser_session_is_encrypted_expires_in_seven_days_and_retires_old_owners(){
  let root=std::env::temp_dir().join(format!("gleamdesk-doubao-browser-{}-{}",std::process::id(),observed_unix_ms()));
  let now=observed_unix_ms();let a=synthetic_login("synthetic-owner-a",now+MAX_SESSION_AGE*2);
  save_login(&root,BROWSER_SCOPE,&a,now).unwrap();let (loaded,scope_a)=load_login(&root,now).unwrap();
  assert!(same_account(&a,&loaded));assert_eq!(loaded.expires,now+MAX_SESSION_AGE);
  let bytes=std::fs::read(cache_file(&root)).unwrap();assert!(!bytes.windows(17).any(|part|part==b"synthetic-owner-a"));
  let b=synthetic_login("synthetic-owner-b",now+MAX_SESSION_AGE);
  save_login(&root,BROWSER_SCOPE,&b,now).unwrap();let (loaded,scope_b)=load_login(&root,now).unwrap();
  assert!(same_account(&b,&loaded));assert!(!same_account(&a,&loaded));assert_ne!(scope_a,scope_b);
  reject_login(&root,&scope_a);assert!(cache_file(&root).exists(),"late failure for A must not remove B");
  assert!(load_login(&root,now+MAX_SESSION_AGE).is_err());
  reject_login(&root,&scope_b);assert!(!cache_file(&root).exists());std::fs::remove_dir(root).unwrap();
 }
 #[test]fn browser_session_never_imports_a_legacy_client_cache(){
  let root=std::env::temp_dir().join(format!("gleamdesk-doubao-legacy-{}-{}",std::process::id(),observed_unix_ms()));
  std::fs::create_dir(&root).unwrap();std::fs::write(root.join("doubao-session.dpapi"),b"synthetic-legacy-session").unwrap();
  assert!(matches!(load_login(&root,observed_unix_ms()),Err("browser-not-connected")));
  assert_eq!(read(Some(&root)).login_status,"not-logged-in");
  std::fs::remove_file(root.join("doubao-session.dpapi")).unwrap();std::fs::remove_dir(root).unwrap();
 }
 #[test]fn login_window_is_restricted_and_headers_require_an_unambiguous_identity(){
  for url in ["https://www.doubao.com/chat/","https://sso.doubao.com/","https://www.bytedance.com/"]{assert!(login_navigation(&tauri::Url::parse(url).unwrap()))}
  for url in ["http://www.doubao.com/","https://doubao.com.evil.example/","file:///C:/secret","https://evil.example/?doubao.com"]{assert!(!login_navigation(&tauri::Url::parse(url).unwrap()))}
  let login=synthetic_login("synthetic",observed_unix_ms()+1000);assert!(validate_header(login.header.as_str()).is_ok());
  assert!(validate_header("sessionid=partial").is_err());
  assert!(validate_header(&format!("{}; uid_tt=other",login.header.as_str())).is_err());
  assert!(!valid_pair("sessionid","bad\r\nheader"));assert!(!valid_pair("sessionid","bad;injected=value"));
  assert!(require_login_window("dashboard",Some(true)).is_ok());
  assert!(require_login_window("dashboard",Some(false)).is_err());assert!(require_login_window("doubao-account-1",Some(true)).is_err());
 }
 #[test]fn doubao_activity_quota_uses_only_reported_percentage(){let result=parse_quota(&json!({"code":0,"data":{"current_subscription":{"display":{"product_name":"体验套餐"}},"incentive_quota_section":{"window_limit_groups":[{"window_limits":[{"window_type":9,"used_percent":45,"end_time":1800000000000u64}]}]}}}));assert_eq!(result.login_status,"verified");assert_eq!(result.plan.as_deref(),Some("体验套餐"));assert_eq!(result.membership.as_ref().unwrap()["benefits"][0]["label"],"活动赠送额度");assert_eq!(result.windows[0].used_percent,45.);assert_eq!(result.windows[0].window_duration_mins,None);assert!(crate::http::post_doubao_quota("/chat/completion","Cookie: fixture").is_err());}
 #[test]#[ignore="explicitly authorized, read-only live Doubao account quota query"]
 fn inspect_live_doubao_quota(){let dir=std::env::var_os("APPDATA").map(|s|PathBuf::from(s).join("org.agentroom.desktop"));let result=read(dir.as_deref());println!("{}",serde_json::to_string(&result).unwrap());assert_eq!(result.login_status,"verified");}
 #[test]fn doubao_official_quota_keeps_periods_and_less_than_one(){
  let value=json!({"code":0,"data":{"current_subscription":{"display":{"short_name":"标准套餐"}},"window_limit_section":{"usage_exhausted":false,"window_limit_groups":[{"window_limits":[{"window_type":1,"used_percent":1,"less_than_one_percent":true,"start_time":1800000000000u64,"end_time":1800018000000u64},{"window_type":2,"used_percent":23,"start_time":1800000000000u64,"end_time":1800604800000u64}]}]}}});
  let result=parse_quota(&value);assert_eq!(result.login_status,"verified");assert_eq!(result.source,"doubao-client-api");assert_eq!(result.plan.as_deref(),Some("标准套餐"));
  let membership=result.membership.unwrap();assert_eq!(membership["benefits"][0]["detail"],"已用 <1%");assert_eq!(membership["benefits"][1]["detail"],"已用 23%");
  assert_eq!(result.windows.len(),1);assert_eq!(result.windows[0].used_percent,23.);assert_eq!(result.windows[0].window_duration_mins,Some(10080));
 }
 #[test]fn doubao_missing_fields_are_unknown_and_zero_reset_is_not_guessed(){
  for value in [json!({}),json!({"code":1,"data":{}}),json!({"data":{"window_limit_section":{"window_limit_groups":[{"window_limits":[{"window_type":1}]}]}}})]{let result=parse_quota(&value);assert_ne!(result.login_status,"verified");assert!(result.windows.is_empty());}
  let value=json!({"data":{"window_limit_section":{"usage_exhausted":true,"window_limit_groups":[{"window_limits":[{"window_type":1,"used_percent":100,"start_time":0,"end_time":0},{"window_type":2,"used_percent":-1}]}]}}});
  let result=parse_quota(&value);assert_eq!(result.state,"warning");assert_eq!(result.windows.len(),1);assert_eq!(result.windows[0].resets_at_unix_ms,None);
 }
}
