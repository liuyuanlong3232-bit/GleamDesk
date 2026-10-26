use crate::mail::{MailProvider,MailSecret,save_secret,now_ms};
use serde::{Deserialize,Serialize};
use serde_json::Value;
use std::{io::{Read,Write},net::TcpListener,sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD};

#[derive(Default)]pub struct OAuthState(pub Mutex<Option<Arc<AtomicBool>>>);
#[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]pub struct OAuthRequest {provider:MailProvider,client_id:String,client_secret:Option<String>}
impl Drop for OAuthRequest{fn drop(&mut self){if let Some(secret)=self.client_secret.as_mut(){unsafe{secret.as_bytes_mut().fill(0);}}}}
#[derive(Serialize)]#[serde(rename_all="camelCase")]pub struct OAuthReceipt {provider:MailProvider,email:String}
fn client_valid(id:&str)->bool{!id.is_empty()&&id.len()<=256&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b"-._".contains(&b))}
fn random_text()->Result<String,String>{
    use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom,BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    let mut data=[0u8;32];if unsafe{BCryptGenRandom(std::ptr::null_mut(),data.as_mut_ptr(),data.len() as u32,BCRYPT_USE_SYSTEM_PREFERRED_RNG)}<0{return Err("无法生成OAuth随机验证数据".into());}Ok(URL_SAFE_NO_PAD.encode(data))
}
fn challenge(verifier:&str)->Result<String,String>{let hash=crate::analysis::sha256(verifier.as_bytes())?;let bytes=(0..hash.len()).step_by(2).map(|i|u8::from_str_radix(&hash[i..i+2],16).unwrap()).collect::<Vec<_>>();Ok(URL_SAFE_NO_PAD.encode(bytes))}
fn encode(value:&str)->String{value.as_bytes().iter().map(|byte|if byte.is_ascii_alphanumeric()||b"-._~".contains(byte){char::from(*byte).to_string()}else{format!("%{byte:02X}")}).collect()}
fn form(fields:&[(&str,&str)])->Vec<u8>{fields.iter().map(|(key,value)|format!("{}={}",encode(key),encode(value))).collect::<Vec<_>>().join("&").into_bytes()}
fn expires_at(value:&Value,now:u64)->Option<u64>{
    value["expires_in"].as_u64().filter(|seconds|*seconds>0&&*seconds<=86400)
        .and_then(|seconds|seconds.checked_mul(1000)).and_then(|duration|now.checked_add(duration))
}
// TCP can split the request into several reads. Do not accept a partial header.
fn read_callback(reader:&mut impl Read,state:&str)->Result<String,String>{
    let mut bytes=[0u8;8192];let mut used=0;let started=Instant::now();
    let result=(||{loop{
        if started.elapsed()>Duration::from_secs(2){return Err("OAuth回调达到读取时限".into());}
        if used==bytes.len(){return Err("OAuth回调超过读取上限".into());}
        let count=reader.read(&mut bytes[used..]).map_err(|_|"OAuth回调读取失败或超时")?;
        if count==0{return Err("OAuth回调不完整".into());}used+=count;
        if bytes[..used].windows(4).any(|part|part==b"\r\n\r\n"){
            let request=std::str::from_utf8(&bytes[..used]).map_err(|_|"OAuth回调编码无效")?;
            return callback(request,state);
        }
    }})();bytes.fill(0);result
}
fn callback(request:&str,state:&str)->Result<String,String>{
    let line=request.lines().next().ok_or("OAuth回调无请求行")?;let parts=line.split_whitespace().collect::<Vec<_>>();if parts.len()!=3||parts[0]!="GET"{return Err("OAuth回调方法无效".into());}
    let url=tauri::Url::parse(&format!("http://127.0.0.1{}",parts[1])).map_err(|_|"OAuth回调网址无效")?;
    if url.path()!="/oauth/callback"{return Err("非OAuth回调路径".into());}
    let fields=url.query_pairs().collect::<Vec<_>>();if fields.iter().filter(|(key,_)|key=="state").count()!=1||fields.iter().find(|(key,_)|key=="state").map(|(_,value)|value.as_ref())!=Some(state){return Err("OAuth状态不匹配".into());}
    if fields.iter().any(|(key,_)|key=="error"){return Err("邮箱授权被拒绝或取消".into());}
    if fields.iter().filter(|(key,_)|key=="code").count()!=1{return Err("OAuth回调缺少唯一授权码".into());}
    fields.iter().find(|(key,_)|key=="code").map(|(_,value)|value.to_string()).filter(|code|!code.is_empty()&&code.len()<4096&&!code.chars().any(char::is_control)).ok_or("OAuth授权码无效".into())
}
fn endpoint(provider:MailProvider)->Result<(&'static str,&'static str),String>{match provider{MailProvider::Gmail=>Ok(("oauth2.googleapis.com","/token")),MailProvider::Outlook=>Ok(("login.microsoftonline.com","/common/oauth2/v2.0/token")),_=>Err("此邮箱不使用OAuth".into())}}
fn token_request(provider:MailProvider,body:&mut Vec<u8>)->Result<Value,String>{let (host,path)=endpoint(provider)?;let result=crate::http::post_mail_oauth(host,path,body,Instant::now()+Duration::from_secs(30));body.fill(0);let (status,bytes)=result?;if status!=200{return Err("邮箱授权交换失败，请检查Client ID、客户端类型和回调配置".into());}serde_json::from_slice(&bytes).map_err(|_|"OAuth响应格式无效".into())}
fn access_token(value:&Value)->Result<String,String>{value["access_token"].as_str().filter(|token|!token.is_empty()&&token.len()<10000&&token.is_ascii()&&!token.chars().any(char::is_control)).map(str::to_owned).ok_or("OAuth响应没有有效访问令牌".into())}
pub fn refresh_if_needed(provider:MailProvider,secret:&mut MailSecret)->Result<(),String>{
    if secret.expires_at_unix_ms.is_some_and(|expires|expires>now_ms()+60000){return Ok(());}
    let refresh=secret.refresh_token.as_deref().ok_or("邮箱授权已过期，请重新连接")?;let client=secret.client_id.as_deref().ok_or("邮箱客户端ID缺失")?;
    let mut fields=vec![("grant_type","refresh_token"),("client_id",client),("refresh_token",refresh)];if let Some(value)=secret.client_secret.as_deref().filter(|s|!s.is_empty()){fields.push(("client_secret",value));}
    let value=token_request(provider,&mut form(&fields))?;
    unsafe{secret.authorization.as_bytes_mut().fill(0);}secret.authorization=access_token(&value)?;
    if let Some(token)=value["refresh_token"].as_str(){secret.refresh_token=Some(token.to_owned());}
    secret.expires_at_unix_ms=expires_at(&value,now_ms());save_secret(provider,secret)
}
fn connect(request:OAuthRequest,cancelled:Arc<AtomicBool>)->Result<OAuthReceipt,String>{
    let _operation=crate::mail::begin_operation(request.provider)?;
    if !client_valid(&request.client_id)||request.provider.imap_host().is_some(){return Err("OAuth客户端ID或邮箱类型无效".into());}
    if request.client_secret.as_ref().is_some_and(|s|s.len()>512||s.chars().any(char::is_control)){return Err("OAuth客户端参数无效".into());}
    let listener=TcpListener::bind("127.0.0.1:0").map_err(|_|"无法建立本机OAuth回调")?;listener.set_nonblocking(true).map_err(|_|"OAuth回调配置失败")?;let port=listener.local_addr().map_err(|_|"回调端口不可用")?.port();
    let redirect=format!("http://{}:{port}/oauth/callback",if request.provider==MailProvider::Outlook{"localhost"}else{"127.0.0.1"});let verifier=random_text()?;let state=random_text()?;let challenge=challenge(&verifier)?;
    let (authorization,scope)=match request.provider{MailProvider::Gmail=>("https://accounts.google.com/o/oauth2/v2/auth","https://www.googleapis.com/auth/gmail.modify"),MailProvider::Outlook=>("https://login.microsoftonline.com/common/oauth2/v2.0/authorize","openid offline_access User.Read Mail.ReadWrite"),_=>unreachable!()};
    let mut url=tauri::Url::parse(authorization).map_err(|_|"OAuth授权地址无效")?;url.query_pairs_mut().extend_pairs([("client_id",request.client_id.as_str()),("redirect_uri",&redirect),("response_type","code"),("scope",scope),("state",&state),("code_challenge",&challenge),("code_challenge_method","S256")]);if request.provider==MailProvider::Gmail{url.query_pairs_mut().append_pair("access_type","offline").append_pair("prompt","consent");}
    crate::launcher::open_public_url(url.as_str())?;
    let started=Instant::now();let mut code=loop{
        if cancelled.load(Ordering::SeqCst)||started.elapsed()>Duration::from_secs(300){return Err("邮箱登录已取消或超时".into());}
        match listener.accept(){Ok((mut stream,_))=>{let _=stream.set_read_timeout(Some(Duration::from_secs(2)));let _=stream.set_write_timeout(Some(Duration::from_secs(2)));let result=read_callback(&mut stream,&state);let body=if result.is_ok(){"授权已收到，请返回AI Desktop。"}else{"未接受此回调，请返回AI Desktop查看状态。"};let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);let _=stream.write_all(response.as_bytes());if let Ok(code)=result{break code;}},Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>std::thread::sleep(Duration::from_millis(40)),Err(_)=>return Err("OAuth回调监听失败".into())}
    };
    if cancelled.load(Ordering::SeqCst){unsafe{code.as_bytes_mut().fill(0);}return Err("授权已取消".into());}
    let mut fields=vec![("grant_type","authorization_code"),("client_id",request.client_id.as_str()),("code",code.as_str()),("redirect_uri",redirect.as_str()),("code_verifier",verifier.as_str())];if let Some(value)=request.client_secret.as_deref().filter(|s|!s.is_empty()){fields.push(("client_secret",value));}
    let response=token_request(request.provider,&mut form(&fields));unsafe{code.as_bytes_mut().fill(0);}let response=response?;let token=access_token(&response)?;
    let email=crate::mail::account_identity(request.provider,&token)?;
    let secret=MailSecret{email:email.clone(),authorization:token,refresh_token:response["refresh_token"].as_str().map(str::to_owned),client_id:Some(request.client_id.clone()),client_secret:request.client_secret.clone(),expires_at_unix_ms:expires_at(&response,now_ms())};
    if cancelled.load(Ordering::SeqCst){return Err("登录已取消，未保存凭据".into());}save_secret(request.provider,&secret)?;Ok(OAuthReceipt{provider:request.provider,email})
}
#[tauri::command]pub async fn mail_oauth_connect(state:tauri::State<'_,OAuthState>,request:OAuthRequest)->Result<OAuthReceipt,String>{let cancelled=Arc::new(AtomicBool::new(false));{let mut active=state.0.lock().map_err(|_|"OAuth状态不可用")?;if active.is_some(){return Err("已有邮箱登录正在进行".into());}*active=Some(cancelled.clone());}let result=tauri::async_runtime::spawn_blocking(move||connect(request,cancelled)).await.map_err(|_|"邮箱登录线程失败".to_string());*state.0.lock().map_err(|_|"OAuth状态不可用")?=None;result?}
#[tauri::command]pub fn mail_oauth_cancel(state:tauri::State<'_,OAuthState>)->Result<(),String>{if let Some(active)=state.0.lock().map_err(|_|"OAuth状态不可用")?.as_ref(){active.store(true,Ordering::SeqCst);}Ok(())}
#[cfg(test)]mod tests{use super::*;
 #[test]fn callback_handles_fragmented_tcp_headers_and_rejects_partial_or_oversize(){
  struct Fragments{bytes:std::io::Cursor<Vec<u8>>}
  impl Read for Fragments{fn read(&mut self,buffer:&mut [u8])->std::io::Result<usize>{let count=buffer.len().min(3);self.bytes.read(&mut buffer[..count])}}
  let mut reader=Fragments{bytes:std::io::Cursor::new(b"GET /oauth/callback?state=s&code=c HTTP/1.1\r\nHost: localhost\r\n\r\n".to_vec())};
  assert_eq!(read_callback(&mut reader,"s").unwrap(),"c");
  assert!(read_callback(&mut std::io::Cursor::new(b"GET /oauth/callback?state=s&code=c HTTP/1.1\r\n"),"s").is_err());
  assert!(read_callback(&mut std::io::Cursor::new(vec![b'a';8193]),"s").is_err());
 }
 #[test]fn missing_or_invalid_expiry_is_unknown(){
  assert_eq!(expires_at(&serde_json::json!({"expires_in":3600}),100),Some(3_600_100));
  for value in [serde_json::json!({}),serde_json::json!({"expires_in":0}),serde_json::json!({"expires_in":-1}),serde_json::json!({"expires_in":86401}),serde_json::json!({"expires_in":"3600"})]{assert_eq!(expires_at(&value,100),None);}
  assert_eq!(expires_at(&serde_json::json!({"expires_in":1}),u64::MAX),None);
 }
 #[test]fn oauth_callback_requires_unique_state_and_code(){assert_eq!(callback("GET /oauth/callback?state=s&code=c HTTP/1.1\r\n","s").unwrap(),"c");for path in ["/?state=s&code=c","/oauth/callback?state=x&code=c","/oauth/callback?state=s&state=s&code=c","/oauth/callback?state=s&code=a&code=b"]{assert!(callback(&format!("GET {path} HTTP/1.1\r\n"),"s").is_err());}}
 #[test]fn only_registered_provider_endpoints_are_available(){assert!(endpoint(MailProvider::Qq).is_err());assert!(!client_valid("id&scope=all"));assert!(client_valid("123.apps.googleusercontent.com"));}
}
