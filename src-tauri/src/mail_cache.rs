//! One bounded DPAPI-encrypted cache per configured provider; never stores credentials.
use crate::mail::{MailDetail,MailProvider,MailSnapshot};
use serde::{Deserialize,Serialize};
use std::{fs,path::{Path,PathBuf}};
use tauri::{AppHandle,Manager};
const MAX_BYTES:u64=6*1024*1024;

#[derive(Serialize,Deserialize)]
pub struct Cache {version:u8,account:String,pub snapshot:Option<MailSnapshot>,pub details:Vec<MailDetail>}
impl Cache {pub fn empty(account:&str)->Self{Self{version:1,account:account.into(),snapshot:None,details:Vec::new()}}}
pub fn path(app:&AppHandle,provider:MailProvider)->Result<PathBuf,String>{
 Ok(app.path().app_data_dir().map_err(|_|"邮箱缓存目录不可用")?.join(format!("mail-cache-{}.bin",provider.id())))
}
#[cfg(windows)]
fn crypt(bytes:&[u8],decrypt:bool)->Result<Vec<u8>,String>{
 use windows_sys::Win32::{Security::Cryptography::{CRYPT_INTEGER_BLOB,CryptProtectData,CryptUnprotectData,CRYPTPROTECT_UI_FORBIDDEN},Foundation::LocalFree};
 let input=CRYPT_INTEGER_BLOB{cbData:bytes.len().try_into().map_err(|_|"邮箱缓存过大")?,pbData:bytes.as_ptr() as *mut u8};
 let mut output=CRYPT_INTEGER_BLOB{cbData:0,pbData:std::ptr::null_mut()};
 unsafe{
  let ok=if decrypt{CryptUnprotectData(&input,std::ptr::null_mut(),std::ptr::null(),std::ptr::null_mut(),std::ptr::null(),CRYPTPROTECT_UI_FORBIDDEN,&mut output)}else{CryptProtectData(&input,std::ptr::null(),std::ptr::null(),std::ptr::null_mut(),std::ptr::null(),CRYPTPROTECT_UI_FORBIDDEN,&mut output)};
  if ok==0{return Err(if decrypt{"本机邮件缓存无法解密，请刷新邮件重新保存"}else{"本机邮件缓存加密失败"}.into());}
  let result=std::slice::from_raw_parts(output.pbData,output.cbData as usize).to_vec();
  if decrypt{std::ptr::write_bytes(output.pbData,0,output.cbData as usize);}LocalFree(output.pbData.cast());Ok(result)
 }
}
#[cfg(not(windows))]fn crypt(_bytes:&[u8],_decrypt:bool)->Result<Vec<u8>,String>{Err("邮件加密缓存需要 Windows".into())}
pub fn load(path:&Path,account:&str)->Result<Cache,String>{
 let metadata=match fs::metadata(path){Ok(value)=>value,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(Cache::empty(account)),Err(_)=>return Err("邮件缓存不可读".into())};
 if metadata.len()>MAX_BYTES{return Err("邮件缓存超过上限，请断开账户后重新连接".into());}
 let bytes=fs::read(path).map_err(|_|"邮件缓存读取失败")?;let mut plain=crypt(&bytes,true)?;
 let decoded=serde_json::from_slice::<Cache>(&plain);plain.fill(0);let cache=decoded.map_err(|_|"邮件缓存格式无效，请刷新")?;
 if cache.version!=1||cache.account!=account{return Ok(Cache::empty(account));}
 if cache.details.len()>12||cache.details.iter().any(|item|item.body.chars().count()>64000)||cache.snapshot.as_ref().is_some_and(|s|s.account!=account||s.messages.len()>12){return Err("邮件缓存结构超限".into());}
 Ok(cache)
}
pub fn save(path:&Path,cache:&Cache)->Result<(),String>{
 let mut plain=serde_json::to_vec(cache).map_err(|_|"邮件缓存编码失败")?;
 if plain.len() as u64>MAX_BYTES-1024{plain.fill(0);return Err("邮件缓存达到本机保存上限".into());}
 let encoded=crypt(&plain,false);plain.fill(0);let encoded=encoded?;
 fs::create_dir_all(path.parent().ok_or("邮件缓存路径无效")?).map_err(|_|"邮件缓存目录无法创建")?;
 let pending=path.with_extension("bin.tmp");
 fs::write(&pending,encoded).map_err(|_|"加密邮件缓存无法保存")?;
 fs::rename(&pending,path).map_err(|_|"加密邮件缓存无法更新".to_string())
}
pub fn clear(path:&Path)->Result<(),String>{
 for candidate in [path.to_path_buf(),path.with_extension("bin.tmp")]{match fs::remove_file(candidate){Ok(())=>{},Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{},Err(_)=>return Err("邮件缓存无法清除，请关闭占用后重试".into())}}Ok(())
}

#[cfg(all(test,windows))]mod tests{
 use super::*;
 #[test]fn encrypted_cache_roundtrip_is_account_scoped_and_clearable(){
  let path=std::env::temp_dir().join(format!("gleamdesk-mail-cache-{}-{}.bin",std::process::id(),crate::mail::now_ms()));
  let mut cache=Cache::empty("fixture@example.invalid");cache.snapshot=Some(MailSnapshot{provider:MailProvider::Gmail,account:cache.account.clone(),unread_count:Some(1),messages:vec![],observed_at_unix_ms:123,source:"synthetic".into()});
  cache.details.push(MailDetail{id:"fixture".into(),body:"private synthetic body".into(),truncated:false,source:"synthetic".into(),cached:false,observed_at_unix_ms:123});
  save(&path,&cache).unwrap();let bytes=fs::read(&path).unwrap();assert!(!bytes.windows(7).any(|w|w==b"private"));
  assert_eq!(load(&path,&cache.account).unwrap().details[0].body,"private synthetic body");assert!(load(&path,"other@example.invalid").unwrap().snapshot.is_none());
  cache.details[0].body="updated".into();save(&path,&cache).unwrap();assert_eq!(load(&path,&cache.account).unwrap().details[0].body,"updated");
  fs::write(&path,b"corrupt fixture").unwrap();assert!(load(&path,&cache.account).is_err());clear(&path).unwrap();assert!(!path.exists());
 }
}
