// Quota and Chromium login handling ported from Wahwayhale/dsh-connect-doubao,
// revision a3911074206d78d6ac170aee5ce081990f3ca30d (MIT).
// Rust/WinHTTP adaptation: read-only app profile; no chat or browser injection.
// User-authorized DPAPI session cache is profile-bound and expires within seven days.
use super::*;

use std::{io::Read,path::Path};
use base64::{Engine,engine::general_purpose::STANDARD};
use windows_sys::Win32::Security::Cryptography::*;
const REQUIRED:&[&str]=&["sessionid","sessionid_ss","sid_tt","sid_guard","uid_tt","ttwid","odin_tt","passport_csrf_token","s_v_web_id"];
const QUOTA_PATH:&str="/alice/commerce/sale/subscription/quota/summary/";

fn failure(issue:&'static str)->AgentObservation{
 let mut result=account("doubao","豆包");result.source="doubao-client-api";
 result.reason=if matches!(issue,"profile-not-found"|"not-logged-in"|"login-expired"){"not-logged-in"}else if issue=="quota-unavailable"{"quota-unavailable"}else{"read-failed"};
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
fn decode_cookie(plaintext:&[u8],host:&str)->Result<String,&'static str>{
 let digest=crate::analysis::sha256(host.as_bytes()).map_err(|_|"login-unreadable")?;
 let hash=(0..32).map(|i|u8::from_str_radix(&digest[i*2..i*2+2],16).unwrap_or(0)).collect::<Vec<_>>();
 let prefix=[32,24,16].into_iter().find(|n|plaintext.len()>=*n&&plaintext[..*n]==hash[..*n]).unwrap_or(0);
 let value=&plaintext[prefix..];
 if value.len()>16384||!value.iter().all(|b|(0x20..=0x7e).contains(b)&&*b!=b';'){return Err("login-unreadable")}
 String::from_utf8(value.to_vec()).map_err(|_|"login-unreadable")
}
fn decrypt_cookie(key:&[u8],encrypted:&[u8],host:&str)->Result<String,&'static str>{
 if encrypted.starts_with(b"v20"){return Err("encryption-unsupported")}
 if encrypted.len()<31||!matches!(encrypted.get(..3),Some(b"v10"|b"v11")){return Err("login-unreadable")}
 let split=encrypted.len()-16;let plaintext=aes_gcm(key,&encrypted[3..15],&encrypted[15..split],&encrypted[split..])?;
 decode_cookie(&plaintext.0,host)
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
fn profiles()->Vec<PathBuf>{
 let mut out=vec![];
 for name in ["GLEAMDESK_DOUBAO_PROFILE","LOCALAPPDATA","APPDATA"]{
  let Some(value)=std::env::var_os(name)else{continue};let root=PathBuf::from(value);
  if !root.is_absolute()||root.to_string_lossy().starts_with("\\\\"){continue}
  let path=if name=="GLEAMDESK_DOUBAO_PROFILE"{root}else{root.join("Doubao/User Data")};
  if path.join("Local State").is_file()&&!out.contains(&path){out.push(path)}
 }
 // Client-owned --user-data-dir is authoritative for installations moved to another drive.
 if let Ok(system)=crate::network_tools::system_executable("WindowsPowerShell/v1.0/powershell.exe"){
  const SCRIPT:&str=r#"$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$paths=@(Get-CimInstance Win32_Process -Filter "Name='Doubao.exe'" | ForEach-Object {if($_.CommandLine -match '--user-data-dir(?:=|\s+)(?:"([^"]+)"|([^\s]+))'){if($matches[1]){$matches[1]}else{$matches[2]}}});ConvertTo-Json -InputObject @{paths=$paths} -Compress"#;
  if let Ok(value)=cli_reader::read_cli_json(&system,&["-NoProfile","-NonInteractive","-Command",SCRIPT],Duration::from_secs(3)){
   for path in value["paths"].as_array().into_iter().flatten().take(8).filter_map(Value::as_str).filter(|s|s.len()<2048).map(PathBuf::from){if path.is_absolute()&&!path.to_string_lossy().starts_with("\\\\")&&path.join("Local State").is_file()&&!out.contains(&path){out.insert(0,path)}}
  }
 }
 out
}
fn profile_folder(value:Option<&str>)->Result<&str,&'static str>{
 let value=value.unwrap_or("Default");
 if value.is_empty()||value.len()>100||!value.bytes().all(|c|c.is_ascii_alphanumeric()||b" _-".contains(&c)){return Err("profile-unsupported")}
 Ok(value)
}
struct Login{header:crate::credentials::Secret,token:Option<crate::credentials::Secret>,expires:u64}
const MAX_SESSION_AGE:u64=7*24*60*60*1000;
fn active_profile(profile:&Path)->Result<String,&'static str>{
 let state:Value=serde_json::from_slice(&bounded_file(&profile.join("Local State"))?.0).map_err(|_|"login-unreadable")?;
 Ok(profile_folder(state.pointer("/profile/last_used").and_then(Value::as_str))?.into())
}
fn cookie_header(profile:&Path)->Result<Login,&'static str>{
 #[derive(serde::Deserialize)]struct State{os_crypt:Crypt,#[serde(default)]profile:Profile}
 #[derive(Default,serde::Deserialize)]struct Profile{last_used:Option<String>}
 #[derive(serde::Deserialize)]struct Crypt{encrypted_key:String}
 let state:State=serde_json::from_slice(&bounded_file(&profile.join("Local State"))?.0).map_err(|_|"login-unreadable")?;
 let bytes=Sensitive(STANDARD.decode(state.os_crypt.encrypted_key).map_err(|_|"login-unreadable")?);
 if !bytes.0.starts_with(b"DPAPI"){return Err("encryption-unsupported")}
 let key=unprotect(&bytes.0[5..])?;if key.0.len()!=32{return Err("login-unreadable")}
 let folder=profile_folder(state.profile.last_used.as_deref())?;
 let db=rusqlite::Connection::open_with_flags(profile.join(folder).join("Network/Cookies"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY|rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|_|"login-file-busy")?;
 db.busy_timeout(Duration::from_millis(200)).map_err(|_|"login-file-busy")?;
 db.execute_batch("PRAGMA query_only=ON;").map_err(|_|"login-file-busy")?;
 // Only this app's service domains. No browser-wide cookie access or profile copying.
 let mut stmt=db.prepare("SELECT host_key,name,encrypted_value,expires_utc FROM cookies WHERE (host_key IN ('doubao.com','.doubao.com','bytedance.com','.bytedance.com') OR host_key LIKE '%.doubao.com' OR host_key LIKE '%.bytedance.com') AND length(encrypted_value) BETWEEN 31 AND 32768 LIMIT 512").map_err(|_|"login-unreadable")?;
 let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Vec<u8>>(2)?,r.get::<_,i64>(3)?))).map_err(|_|"login-file-busy")?;
 let mut pairs=std::collections::BTreeMap::new();let mut unsupported=false;let now=observed_unix_ms();let mut expires=now+MAX_SESSION_AGE;
 for row in rows{
  let (host,name,encrypted,expiry)=row.map_err(|_|"login-file-busy")?;
  if name.is_empty()||name.len()>100||!name.bytes().all(|c|c.is_ascii_alphanumeric()||b"-_.".contains(&c)){continue}
  if expiry>0{let at=(expiry as u64).saturating_sub(11644473600000000)/1000;if at<=now{continue}if REQUIRED.contains(&name.as_str()){expires=expires.min(at)}}
  match decrypt_cookie(&key.0,&encrypted,&host){Ok(value)if !value.is_empty()=>{pairs.insert(name,crate::credentials::Secret::from_string(value));},Err("encryption-unsupported")=>unsupported=true,_=>{}}
 }
 if REQUIRED.iter().any(|name|!pairs.contains_key(*name)){return Err(if unsupported{"encryption-unsupported"}else{"not-logged-in"})}
 let mut header=String::new();for (name,value) in &pairs{if !header.is_empty(){header.push_str("; ")}header.push_str(name);header.push('=');header.push_str(value.as_str());}
 if header.len()>64*1024{return Err("login-unreadable")}
 let token=pairs.remove("msToken");Ok(Login{header:crate::credentials::Secret::from_string(header),token,expires})
}
#[derive(serde::Serialize,serde::Deserialize)]
struct SavedLogin{version:u8,profile:String,saved_at:u64,expires:u64,header:String,token:Option<String>}
impl Drop for SavedLogin{fn drop(&mut self){std::mem::take(&mut self.header).into_bytes().fill(0);if let Some(token)=self.token.take(){token.into_bytes().fill(0)}}}
fn cache_scope(root:&Path,folder:&str)->Result<String,&'static str>{
 // The folder identifies a profile, not its current account. Only client-owned
 // identity/session cookies bind an imported login to the account signed in now.
 let db=rusqlite::Connection::open_with_flags(root.join(folder).join("Network/Cookies"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY|rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|_|"account-unconfirmed")?;
 db.busy_timeout(Duration::from_millis(100)).map_err(|_|"account-unconfirmed")?;
 let mut query=db.prepare("SELECT host_key,name,encrypted_value FROM cookies WHERE (host_key IN ('doubao.com','.doubao.com','bytedance.com','.bytedance.com') OR host_key LIKE '%.doubao.com' OR host_key LIKE '%.bytedance.com') AND name IN ('uid_tt','sessionid','sessionid_ss','sid_tt','sid_guard') AND length(encrypted_value) BETWEEN 1 AND 32768 AND (expires_utc=0 OR expires_utc>?1) ORDER BY name,host_key LIMIT 64").map_err(|_|"account-unconfirmed")?;
 let expiry=observed_unix_ms().saturating_mul(1000).saturating_add(11644473600000000).min(i64::MAX as u64) as i64;
 let mut rows=query.query([expiry]).map_err(|_|"account-unconfirmed")?;
 let mut bytes=Sensitive(format!("doubao-account-source-v2\n{}",root.join(folder).to_string_lossy().to_lowercase()).into_bytes());let mut uid=false;let mut session=false;
 while let Some(row)=rows.next().map_err(|_|"account-unconfirmed")?{
  let host:String=row.get(0).map_err(|_|"account-unconfirmed")?;let name:String=row.get(1).map_err(|_|"account-unconfirmed")?;
  let encrypted=Sensitive(row.get::<_,Vec<u8>>(2).map_err(|_|"account-unconfirmed")?);
  uid|=name=="uid_tt";session|=matches!(name.as_str(),"sessionid"|"sessionid_ss"|"sid_tt");
  for part in [host.as_bytes(),name.as_bytes(),encrypted.0.as_slice()]{bytes.0.extend_from_slice(&(part.len() as u64).to_le_bytes());bytes.0.extend_from_slice(part)}
 }
 if !uid||!session{return Err("not-logged-in")}
 crate::analysis::sha256(&bytes.0).map_err(|_|"account-unconfirmed")
}
pub(super) fn source_scope()->Result<String,String>{
 let root=profiles().into_iter().next().ok_or("豆包当前登录目录暂时不可用")?;
 let folder=active_profile(&root).map_err(|_|"豆包当前账号暂时不可确认")?;
 cache_scope(&root,&folder).map_err(|_|"豆包当前账号暂时不可确认".into())
}
fn cache_file(dir:&Path)->PathBuf{dir.join("doubao-session.dpapi")}
fn save_login(dir:&Path,scope:&str,login:&Login,now:u64)->Result<(),&'static str>{
 let payload=SavedLogin{version:2,profile:scope.into(),saved_at:now,expires:login.expires.min(now+MAX_SESSION_AGE),header:login.header.as_str().into(),token:login.token.as_ref().map(|s|s.as_str().into())};
 let body=Sensitive(serde_json::to_vec(&payload).map_err(|_|"cache-unavailable")?);
 if body.0.len()>128*1024{return Err("cache-unavailable")}
 let input=CRYPT_INTEGER_BLOB{cbData:body.0.len() as u32,pbData:body.0.as_ptr() as *mut u8};let mut output=CRYPT_INTEGER_BLOB::default();
 if unsafe{CryptProtectData(&input,std::ptr::null(),std::ptr::null(),std::ptr::null(),std::ptr::null(),CRYPTPROTECT_UI_FORBIDDEN,&mut output)}==0{return Err("cache-unavailable")}
 let result=if output.pbData.is_null()||output.cbData>256*1024{Err("cache-unavailable")}else{
  let bytes=unsafe{std::slice::from_raw_parts(output.pbData,output.cbData as usize)};
  std::fs::create_dir_all(dir).and_then(|_|std::fs::write(dir.join("doubao-session.dpapi.tmp"),bytes)).and_then(|_|std::fs::rename(dir.join("doubao-session.dpapi.tmp"),cache_file(dir))).map_err(|_|"cache-unavailable")
 };
 unsafe{windows_sys::Win32::Foundation::LocalFree(output.pbData as _);};result
}
fn load_login(dir:&Path,scope:&str,now:u64)->Result<Login,&'static str>{
 let encrypted=bounded_file(&cache_file(dir)).map_err(|_|"login-file-busy")?;if encrypted.0.len()>256*1024{return Err("cache-invalid")}
 let plain=unprotect(&encrypted.0).map_err(|_|"cache-invalid")?;let mut payload:SavedLogin=serde_json::from_slice(&plain.0).map_err(|_|"cache-invalid")?;
 if payload.expires<=now{let _=std::fs::remove_file(cache_file(dir));return Err("cache-expired")}
 if payload.version!=2||payload.profile!=scope{return Err("account-unconfirmed")}
 if payload.saved_at>now||payload.expires<=now||payload.expires>payload.saved_at.saturating_add(MAX_SESSION_AGE)||payload.header.is_empty()||payload.header.len()>64*1024||!payload.header.bytes().all(|b|(32..=126).contains(&b))||payload.token.as_ref().is_some_and(|v|v.len()>16384||!v.bytes().all(|b|(32..=126).contains(&b))){return Err("cache-expired")}
 Ok(Login{header:crate::credentials::Secret::from_string(std::mem::take(&mut payload.header)),token:payload.token.take().map(crate::credentials::Secret::from_string),expires:payload.expires})
}
fn query_path(token:Option<&str>)->String{
 // Same fixed desktop request parameters as the verified upstream implementation.
 let mut params=tauri::Url::parse("https://www.doubao.com").unwrap();
 params.query_pairs_mut().extend_pairs([("aid","582478"),("real_aid","582478"),("version_code","20800"),("pc_version","2.31.4"),("device_id","2697515174213273"),("tea_uuid","2697515174213273"),("web_id","7677868049198630415"),("fp","verify_2697515174213273"),("chromium_version","147.0.7727.149"),("runtime_version","3.39.0"),("channel","win"),("language","zh"),("region","CN"),("sys_region","CN"),("tz_name","Asia/Shanghai"),("pkg_type","release_version"),("client_platform","pc_client"),("device_platform","web"),("doubao_device_platform","desktop"),("web_platform","desktop"),("samantha_web","1"),("use-olympus-account","1")]);
 if let Some(token)=token{params.query_pairs_mut().append_pair("msToken",token);}
 format!("{QUOTA_PATH}?{}",params.query().unwrap_or(""))
}
pub(super) fn read(cache_dir:Option<&Path>)->AgentObservation{
 let paths=profiles();if paths.is_empty(){return failure("profile-not-found")}
 let mut last="not-logged-in";
 for profile in paths.into_iter().take(1){
  let scope=match active_profile(&profile).and_then(|folder|cache_scope(&profile,&folder)){Ok(scope)=>scope,Err(issue)=>{last=issue;continue}};
  let mut cache_issue=None;
  let login=match cookie_header(&profile){Ok(login)=>{if let Some(dir)=cache_dir{if save_login(dir,&scope,&login,observed_unix_ms()).is_err(){cache_issue=Some("cache-unavailable")}}login},Err("login-file-busy")=>{
   // Re-check the actual account, never infer ownership from a directory or
   // from an old token still accepted by the service. A locked DB fails closed.
   if cache_scope(&profile,&active_profile(&profile).unwrap_or_default()).ok().as_ref()!=Some(&scope){last="account-unconfirmed";continue}
   match cache_dir.ok_or("account-unconfirmed").and_then(|dir|load_login(dir,&scope,observed_unix_ms())){Ok(login)=>login,Err(issue)=>{last=issue;continue}}
  },Err(issue)=>{last=issue;continue}};
  if cache_scope(&profile,&active_profile(&profile).unwrap_or_default()).ok().as_ref()!=Some(&scope){last="account-unconfirmed";continue}
  let path=crate::credentials::Secret::from_string(query_path(login.token.as_ref().map(|s|s.as_str())));
  let headers=crate::credentials::Secret::from_string(format!("User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/2.31.4\r\nReferer: chrome://doubao-chat/\r\nContent-Type: application/json\r\nAccept: */*\r\nAccept-Language: zh-CN,zh;q=0.9\r\nagw-js-conv: str\r\nCookie: {}\r\n",login.header.as_str()));
  match crate::http::post_doubao_quota(path.as_str(),headers.as_str()){
   Ok((200,bytes))=>{let body=Sensitive(bytes);let value=serde_json::from_slice(&body.0).map_err(|_|());
    let mut result=value.map(|value|parse_quota(&value)).unwrap_or_else(|_|failure("response-invalid"));
    if let Some(issue)=cache_issue{if let Some(member)=result.membership.as_mut(){member["readIssue"]=Value::String(issue.into());}}
    if result.reason=="quota-unavailable"{
     let overview=crate::credentials::Secret::from_string(path.as_str().replacen(QUOTA_PATH,"/alice/commerce/sale/subscription/overview/",1));
     if let Ok((200,bytes))=crate::http::post_doubao_quota(overview.as_str(),headers.as_str()){
      let bytes=Sensitive(bytes);if let Ok(value)=serde_json::from_slice::<Value>(&bytes.0){
       return parse_quota(&value)
      }
     }
    }
    return result},
   Ok((401,_))=>{if let Some(dir)=cache_dir{let _=std::fs::remove_file(cache_file(dir));}last="login-expired"},Ok((403,_))=>last="response-rejected",_=>last="request-failed"
  }
 }
 failure(last)
}

#[cfg(test)]
mod tests{
 use super::*;use serde_json::json;
 #[test]fn changed_cookie_source_cannot_reuse_the_previous_account_login(){
  let root=std::env::temp_dir().join(format!("gleamdesk-doubao-account-scope-{}-{}",std::process::id(),observed_unix_ms()));
  let network=root.join("profile/Default/Network");std::fs::create_dir_all(&network).unwrap();
  let db=rusqlite::Connection::open(network.join("Cookies")).unwrap();
  db.execute_batch("CREATE TABLE cookies(host_key TEXT,name TEXT,encrypted_value BLOB,expires_utc INTEGER DEFAULT 0)").unwrap();
  for name in ["uid_tt","sessionid"]{db.execute("INSERT INTO cookies(host_key,name,encrypted_value) VALUES('.doubao.com',?1,?2)",rusqlite::params![name,b"synthetic-account-a".as_slice()]).unwrap();}
  let scope=cache_scope(&root.join("profile"),"Default").unwrap();let now=observed_unix_ms();
  let login=Login{header:crate::credentials::Secret::from_string("sessionid=synthetic-a".into()),token:None,expires:now+MAX_SESSION_AGE};
  save_login(&root,&scope,&login,now).unwrap();
  db.execute("UPDATE cookies SET encrypted_value=?1 WHERE name='uid_tt'",[b"synthetic-account-b".as_slice()]).unwrap();drop(db);
  let next_scope=cache_scope(&root.join("profile"),"Default").unwrap();
  let reused=load_login(&root,&next_scope,now).is_ok();std::fs::remove_dir_all(&root).unwrap();
  assert!(!reused,"same profile directory must not authorize another account's cached login");
 }
 #[test]fn doubao_uses_active_profile_and_never_traverses_another_directory(){assert_eq!(profile_folder(Some("Profile 2")),Ok("Profile 2"));assert_eq!(profile_folder(None),Ok("Default"));for name in ["../other","C:\\other","another/profile","",".hidden"]{assert!(profile_folder(Some(name)).is_err())}}
 #[test]fn doubao_activity_quota_uses_only_reported_percentage(){let result=parse_quota(&json!({"code":0,"data":{"current_subscription":{"display":{"product_name":"体验套餐"}},"incentive_quota_section":{"window_limit_groups":[{"window_limits":[{"window_type":9,"used_percent":45,"end_time":1800000000000u64}]}]}}}));assert_eq!(result.login_status,"verified");assert_eq!(result.plan.as_deref(),Some("体验套餐"));assert_eq!(result.membership.as_ref().unwrap()["benefits"][0]["label"],"活动赠送额度");assert_eq!(result.windows[0].used_percent,45.);assert_eq!(result.windows[0].window_duration_mins,None);assert!(crate::http::post_doubao_quota("/chat/completion","Cookie: fixture").is_err());}
 #[test]#[ignore="explicitly authorized, read-only live Doubao account quota query"]
 fn inspect_live_doubao_quota(){let dir=std::env::var_os("APPDATA").map(|s|PathBuf::from(s).join("org.agentroom.desktop"));let result=read(dir.as_deref());println!("{}",serde_json::to_string(&result).unwrap());assert_eq!(result.login_status,"verified");}
 #[test]fn doubao_cache_is_encrypted_profile_bound_and_bounded_in_time(){
  let root=std::env::temp_dir().join(format!("gleamdesk-doubao-cache-{}-{}",std::process::id(),observed_unix_ms()));let now=observed_unix_ms();
  let login=Login{header:crate::credentials::Secret::from_string("sessionid=synthetic-session".into()),token:None,expires:now+MAX_SESSION_AGE};
  save_login(&root,"fixture-profile",&login,now).unwrap();let bytes=std::fs::read(cache_file(&root)).unwrap();assert!(!bytes.windows(17).any(|s|s==b"synthetic-session"));
  assert_eq!(load_login(&root,"fixture-profile",now).unwrap().header.as_str(),login.header.as_str());assert!(load_login(&root,"another-profile",now).is_err());assert!(load_login(&root,"fixture-profile",now+MAX_SESSION_AGE).is_err());
  assert!(!cache_file(&root).exists());std::fs::remove_dir(root).unwrap();
 }
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
 #[test]fn doubao_cookie_host_binding_and_header_validation(){
  let host=".doubao.com";let digest=crate::analysis::sha256(host.as_bytes()).unwrap();let bytes=(0..32).map(|i|u8::from_str_radix(&digest[i*2..i*2+2],16).unwrap()).collect::<Vec<_>>();
  for n in [32,24,16]{let mut plaintext=bytes[..n].to_vec();plaintext.extend_from_slice(b"fixture-session");assert_eq!(decode_cookie(&plaintext,host).unwrap(),"fixture-session");}
  assert_eq!(decode_cookie(b"legacy-value",host).unwrap(),"legacy-value");
  assert!(decode_cookie(b"bad\r\nheader",host).is_err());assert!(decode_cookie(b"bad;another=value",host).is_err());
  assert!(decrypt_cookie(&[0;32],b"v20unsupported",host).is_err());
 }
 #[test]fn doubao_aes_gcm_authenticates_ciphertext(){
  // NIST AES-256-GCM zero-key/zero-IV vector, 16 zero plaintext bytes.
  let ciphertext=[0xce,0xa7,0x40,0x3d,0x4d,0x60,0x6b,0x6e,0x07,0x4e,0xc5,0xd3,0xba,0xf3,0x9d,0x18];
  let tag=[0xd0,0xd1,0xc8,0xa7,0x99,0x99,0x6b,0xf0,0x26,0x5b,0x98,0xb5,0xd4,0x8a,0xb9,0x19];
  let mut encrypted=b"v10".to_vec();encrypted.extend_from_slice(&[0;12]);encrypted.extend_from_slice(&ciphertext);encrypted.extend_from_slice(&tag);
  // Zero bytes are not cookie header values, so authenticated decrypt and header validation are separate.
  assert_eq!(aes_gcm(&[0;32],&encrypted[3..15],&encrypted[15..31],&encrypted[31..]).unwrap().0,vec![0;16]);
  encrypted[15]^=1;assert!(aes_gcm(&[0;32],&encrypted[3..15],&encrypted[15..31],&encrypted[31..]).is_err());
 }
}
struct Sensitive(Vec<u8>);
impl Drop for Sensitive{fn drop(&mut self){self.0.fill(0)}}
fn aes_gcm(key:&[u8],nonce:&[u8],ciphertext:&[u8],tag:&[u8])->Result<Sensitive,&'static str>{
 if key.len()!=32||nonce.len()!=12||tag.len()!=16||ciphertext.len()>32768{return Err("login-unreadable")}
 struct Algorithm(BCRYPT_ALG_HANDLE);impl Drop for Algorithm{fn drop(&mut self){unsafe{BCryptCloseAlgorithmProvider(self.0,0);}}}
 struct Key(BCRYPT_KEY_HANDLE);impl Drop for Key{fn drop(&mut self){unsafe{BCryptDestroyKey(self.0);}}}
 let mut handle=std::ptr::null_mut();if unsafe{BCryptOpenAlgorithmProvider(&mut handle,BCRYPT_AES_ALGORITHM,std::ptr::null(),0)}<0{return Err("login-unreadable")}let algorithm=Algorithm(handle);
 let mode:Vec<u16>="ChainingModeGCM\0".encode_utf16().collect();
 if unsafe{BCryptSetProperty(algorithm.0,BCRYPT_CHAINING_MODE,mode.as_ptr() as *const u8,(mode.len()*2) as u32,0)}<0{return Err("login-unreadable")}
 let mut handle=std::ptr::null_mut();if unsafe{BCryptGenerateSymmetricKey(algorithm.0,&mut handle,std::ptr::null_mut(),0,key.as_ptr(),32,0)}<0{return Err("login-unreadable")}let key=Key(handle);
 let mut info=BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO{cbSize:std::mem::size_of::<BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO>() as u32,dwInfoVersion:BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO_VERSION,pbNonce:nonce.as_ptr() as *mut u8,cbNonce:12,pbTag:tag.as_ptr() as *mut u8,cbTag:16,..Default::default()};
 let mut output=Sensitive(vec![0;ciphertext.len().max(1)]);let mut length=0;
 if unsafe{BCryptDecrypt(key.0,ciphertext.as_ptr(),ciphertext.len() as u32,&mut info as *mut _ as *mut _,std::ptr::null_mut(),0,output.0.as_mut_ptr(),output.0.len() as u32,&mut length,0)}<0{return Err("login-unreadable")}
 output.0.truncate(length as usize);Ok(output)
}
