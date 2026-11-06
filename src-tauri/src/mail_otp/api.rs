use super::{Account,Provider,Secret,Cursor,Incoming};
use serde_json::Value;
use base64::{Engine,engine::general_purpose::{URL_SAFE,URL_SAFE_NO_PAD}};
use mailparse::MailHeaderMap;

pub fn get(provider:Provider,path:&str,token:&str)->Result<Value,String>{
 let permit=crate::simulation::require_live()?;
 if token.is_empty()||token.len()>12000||!token.is_ascii()||token.chars().any(char::is_control){return Err("邮箱令牌无效，请重新连接".into())}
 let host=match provider{Provider::Gmail=>"gmail.googleapis.com",Provider::Outlook=>"graph.microsoft.com",_=>return Err("邮箱类型无效".into())};
 let mut headers=format!("Authorization: Bearer {token}\r\nAccept: application/json\r\n");
 let result=crate::http::mail_otp_get(host,path,&headers);unsafe{headers.as_bytes_mut().fill(0)}let (status,mut bytes)=result?;permit.check()?;
 let result=if status==200{serde_json::from_slice(&bytes).map_err(|_|"邮箱响应格式无效".into())}else{Err(match status{401|403=>"邮箱授权失效或权限不足，请重新连接",429=>"邮箱暂时限流，稍后自动重试",_=>"邮箱读取失败，稍后自动重试"}.into())};bytes.fill(0);result
}
pub fn identity(provider:Provider,token:&str)->Result<String,String>{let value=get(provider,if provider==Provider::Gmail{"/gmail/v1/users/me/profile"}else{"/v1.0/me?$select=mail,userPrincipalName"},token)?;let email=if provider==Provider::Gmail{value["emailAddress"].as_str()}else{value["mail"].as_str().or_else(||value["userPrincipalName"].as_str())};email.map(str::to_owned).ok_or("未能确认邮箱身份".into())}
fn body_parts(part:&mailparse::ParsedMail,plain:&mut String,html:&mut String,depth:usize){
 if depth>16||part.headers.get_first_value("Content-Disposition").is_some_and(|s|s.to_ascii_lowercase().starts_with("attachment")){return}
 if part.subparts.is_empty(){if let Ok(body)=part.get_body(){if part.ctype.mimetype.eq_ignore_ascii_case("text/plain"){plain.push_str(&body);plain.push('\n')}else if part.ctype.mimetype.eq_ignore_ascii_case("text/html"){html.push_str(&body);html.push('\n')}}}else{for p in part.subparts.iter().take(32){body_parts(p,plain,html,depth+1)}}
}
pub fn parse_mime(raw:&[u8])->Option<(String,String,String)>{if raw.len()>192*1024{return None}let parsed=mailparse::parse_mail(raw).ok()?;let from=parsed.headers.get_first_value("From").unwrap_or_default();let subject=parsed.headers.get_first_value("Subject").unwrap_or_default();let mut plain=String::new();let mut html=String::new();body_parts(&parsed,&mut plain,&mut html,0);Some((from,subject,if plain.trim().is_empty(){super::extract::html_to_text(&html)}else{plain}))}
fn path_id(id:&str)->Result<&str,String>{if id.is_empty()||id.len()>512||!id.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-=".contains(&b)){return Err("邮件标识无效".into())}Ok(id)}
pub fn poll(account:&Account,secret:&Secret,mut cursor:Cursor,include_summary:bool,check:&impl Fn()->Result<(),String>)->Result<(Cursor,Vec<Incoming>,Option<Vec<Incoming>>),String>{
 check()?;let baseline=include_summary&&cursor.seen.is_empty();let mut items=Vec::new();let mut summary=Vec::new();
 if account.provider==Provider::Gmail{
  let list=get(account.provider,"/gmail/v1/users/me/messages?maxResults=20&q=in%3Ainbox",&secret.authorization)?;
  if list.get("messages").is_some_and(|v|!v.is_array()){return Err("Gmail 邮件列表结构无效".into())}
  for row in list["messages"].as_array().map(Vec::as_slice).unwrap_or(&[]).iter().take(20).rev(){
   check()?;let id=path_id(row["id"].as_str().ok_or("邮件标识缺失")?)?;
   let seen=cursor.seen.iter().any(|s|s==id);if seen&&!include_summary{continue}
   let message=get(account.provider,&format!("/gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From"),&secret.authorization)?;
   let received=message["internalDate"].as_str().and_then(|s|s.parse::<u64>().ok()).ok_or("邮件接收时间无效")?;
   let header=|name:&str|message["payload"]["headers"].as_array().and_then(|rows|rows.iter().find(|h|h["name"].as_str().is_some_and(|s|s.eq_ignore_ascii_case(name)))).and_then(|h|h["value"].as_str()).unwrap_or("");
   let (sender,subject,_)=parse_mime(format!("From: {}\r\nSubject: {}\r\n\r\n",header("From"),header("Subject")).as_bytes()).unwrap_or_default();
   let mut item=Incoming{id:id.into(),sender,subject,body:String::new(),received};
   if super::now_ms().saturating_sub(received)<=300_000&&message["sizeEstimate"].as_u64().unwrap_or(u64::MAX)<=192*1024{
    check()?;let mut message=get(account.provider,&format!("/gmail/v1/users/me/messages/{id}?format=raw"),&secret.authorization)?;
    let mut encoded=message["raw"].take().as_str().unwrap_or("").to_owned();
    if let Ok(mut raw)=URL_SAFE_NO_PAD.decode(&encoded).or_else(|_|URL_SAFE.decode(&encoded)){if let Some((sender,subject,body))=parse_mime(&raw){item.sender=sender;item.subject=subject;item.body=body;}raw.fill(0)}unsafe{encoded.as_bytes_mut().fill(0)}
   }
   if include_summary{summary.push(item.clone())}if !seen&&!baseline{items.push(item)}if !seen{cursor.seen.push(id.into())}
  }
 }else{
  let list=get(account.provider,"/v1.0/me/mailFolders/inbox/messages?$top=20&$select=id,subject,from,receivedDateTime&$orderby=receivedDateTime%20desc",&secret.authorization)?;
  for row in list["value"].as_array().ok_or("Outlook 邮件列表结构无效")?.iter().take(20).rev(){
   check()?;let id=row["id"].as_str().filter(|s|s.len()<=512).ok_or("邮件标识无效")?;let seen=cursor.seen.iter().any(|s|s==id);if seen&&!include_summary{continue}
   let received=chrono::DateTime::parse_from_rfc3339(row["receivedDateTime"].as_str().unwrap_or("")).map_err(|_|"邮件接收时间无效")?.timestamp_millis().max(0) as u64;
   let sender=row["from"]["emailAddress"]["name"].as_str().filter(|s|!s.is_empty()).or_else(||row["from"]["emailAddress"]["address"].as_str()).unwrap_or("Outlook").into();
   let mut item=Incoming{id:id.into(),sender,subject:row["subject"].as_str().unwrap_or("").into(),body:String::new(),received};
   if super::now_ms().saturating_sub(received)<=300_000{
    check()?;let segment=id.bytes().map(|b|if b.is_ascii_alphanumeric()||b"_-".contains(&b){(b as char).to_string()}else{format!("%{b:02X}")}).collect::<String>();
    let message=match get(account.provider,&format!("/v1.0/me/mailFolders/inbox/messages/{segment}?$select=body"),&secret.authorization){Ok(value)=>value,Err(error) if error=="接口响应超过 512 KB，请缩小查询范围"=>Value::Null,Err(error)=>return Err(error)};
    let content=message["body"]["content"].as_str().unwrap_or("");item.body=if message["body"]["contentType"].as_str().is_some_and(|s|s.eq_ignore_ascii_case("html")){super::extract::html_to_text(content)}else{content.to_owned()};
   }
   if include_summary{summary.push(item.clone())}if !seen&&!baseline{items.push(item)}if !seen{cursor.seen.push(id.into())}
  }
 }
 if cursor.seen.len()>64{let n=cursor.seen.len()-64;cursor.seen.drain(..n);}Ok((cursor,items,include_summary.then_some(summary)))
}
#[cfg(test)]mod tests{use super::*;
#[test]fn mime_decodes_headers_and_skips_attachments(){let raw=b"From: Example <a@example.com>\r\nSubject: =?UTF-8?B?6aqM6K+B56CB?=\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nYour verification code is =38=33=34=39=32=31.\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=secret.txt\r\n\r\n999999\r\n--x--\r\n";let (_,subject,body)=parse_mime(raw).unwrap();assert_eq!(subject,"验证码");assert!(body.contains("834921"));assert!(!body.contains("999999"));}
#[test]fn message_ids_are_single_path_segments(){for id in ["../profile","a?format=full","x\r\n"]{assert!(path_id(id).is_err())}assert!(path_id("19ef3123ab").is_ok())}
}
