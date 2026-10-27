use std::{ffi::c_void, ptr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
static REVISION: AtomicU64 = AtomicU64::new(0);
static WRITING: Mutex<()> = Mutex::new(());
pub fn revision() -> u64 { REVISION.load(Ordering::SeqCst) }

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialSource {
    Beszel, Deepseek, Anthropic, Mimo, Openai,
    #[serde(rename = "mimo-console")]
    MimoConsole,
    #[serde(rename = "analysis-deepseek")]
    AnalysisDeepseek,
    #[serde(rename = "analysis-anthropic")]
    AnalysisAnthropic,
    #[serde(rename = "agent-deepseek")]
    AgentDeepseek,
}
impl CredentialSource {
    fn target(self) -> &'static str {
        match self {
            Self::Beszel => "GleamDesk.Beszel.ApiToken",
            Self::Deepseek => "GleamDesk.DeepSeek.ApiKey",
            Self::Mimo => "GleamDesk.MiMo.ApiKey",
            Self::MimoConsole => "GleamDesk.MiMo.ConsoleSession",
            Self::Anthropic => "GleamDesk.Anthropic.AdminKey",
            Self::Openai => "GleamDesk.OpenAI.AdminKey",
            Self::AnalysisDeepseek => "GleamDesk.DeepSeek.InferenceKey",
            Self::AnalysisAnthropic => "GleamDesk.Anthropic.InferenceKey",
            Self::AgentDeepseek => "GleamDesk.DeepSeek.AgentRoomKey",
        }
    }
}

pub struct Secret(Vec<u8>);
impl Secret { pub fn as_str(&self) -> &str { std::str::from_utf8(&self.0).expect("validated credential") } pub(crate) fn from_string(value:String)->Self { Self(value.into_bytes()) } }
impl Drop for Secret { fn drop(&mut self) { self.0.fill(0); } }
pub fn validate(secret: &str) -> Result<(), String> {
    if secret.trim().is_empty() || secret.len() > 2_560 || secret.chars().any(char::is_control) {
        Err("凭据为空、过长或包含控制字符".into())
    } else { Ok(()) }
}

#[cfg(windows)]
#[repr(C)]
struct CredentialW {
    flags: u32, kind: u32, target_name: *mut u16, comment: *mut u16,
    last_written: windows_sys::Win32::Foundation::FILETIME,
    credential_blob_size: u32, credential_blob: *mut u8,
    persist: u32, attribute_count: u32, attributes: *mut c_void,
    target_alias: *mut u16, user_name: *mut u16,
}
#[cfg(windows)]
#[link(name = "Advapi32")]
unsafe extern "system" {
    fn CredWriteW(credential: *const CredentialW, flags: u32) -> i32;
    fn CredReadW(target: *const u16, kind: u32, flags: u32, credential: *mut *mut CredentialW) -> i32;
    fn CredDeleteW(target: *const u16, kind: u32, flags: u32) -> i32;
    fn CredEnumerateW(filter: *const u16, flags: u32, count: *mut u32, credentials: *mut *mut *mut CredentialW) -> i32;
    fn CredFree(buffer: *mut c_void);
}
#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }

#[cfg(windows)]
pub fn save(source: CredentialSource, value: &str) -> Result<(), String> {
    save_named(source.target(),value)
}
#[cfg(windows)]
pub(crate) fn save_named(target_name:&str,value:&str)->Result<(),String>{
    let _lock = WRITING.lock().map_err(|_|"凭据正在保存，请稍后重试")?;
    save_unlocked(target_name,value)
}
#[cfg(windows)]
fn save_unlocked(target_name:&str,value:&str)->Result<(),String>{
    validate(value)?;
    let mut bytes = Secret(value.as_bytes().to_vec());
    let target = wide(target_name);
    let user = wide("GleamDesk");
    let credential = CredentialW {
        flags: 0, kind: 1, target_name: target.as_ptr() as *mut u16, comment: ptr::null_mut(),
        last_written: windows_sys::Win32::Foundation::FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
        credential_blob_size: bytes.0.len() as u32, credential_blob: bytes.0.as_mut_ptr(), persist: 2,
        attribute_count: 0, attributes: ptr::null_mut(), target_alias: ptr::null_mut(), user_name: user.as_ptr() as *mut u16,
    };
    if unsafe { CredWriteW(&credential, 0) } != 0 { REVISION.fetch_add(1, Ordering::SeqCst); Ok(()) }
    else { Err("无法保存到 Windows Credential Manager".into()) }
}
#[cfg(windows)]
pub fn read(source: CredentialSource) -> Result<Secret, String> {
    read_named(source.target())
}
#[cfg(windows)]
pub(crate) fn read_named(target_name:&str)->Result<Secret,String>{
    let target = wide(target_name);
    let mut pointer: *mut CredentialW = ptr::null_mut();
    if unsafe { CredReadW(target.as_ptr(), 1, 0, &mut pointer) } == 0 || pointer.is_null() {
        return Err("尚未配置服务凭据".into());
    }
    let credential = unsafe { &mut *pointer };
    let result = if credential.credential_blob.is_null() || credential.credential_blob_size == 0 || credential.credential_blob_size > 2_560 {
        Err("Windows 凭据格式无效".into())
    } else {
        let bytes = unsafe { std::slice::from_raw_parts_mut(credential.credential_blob, credential.credential_blob_size as usize) };
        let secret = Secret(bytes.to_vec());
        bytes.fill(0);
        match std::str::from_utf8(&secret.0).ok().and_then(|value| validate(value).ok()) {
            Some(()) => Ok(secret), None => Err("Windows 凭据格式无效".into()),
        }
    };
    unsafe { CredFree(pointer as *mut c_void); }
    result
}
#[cfg(windows)]
pub fn exists(source: CredentialSource) -> Result<bool, String> {
    exists_named(source.target())
}
#[cfg(windows)]
pub(crate) fn exists_named(target_name:&str)->Result<bool,String>{
    let target = wide(target_name);
    let mut pointer: *mut CredentialW = ptr::null_mut();
    if unsafe { CredReadW(target.as_ptr(), 1, 0, &mut pointer) } == 0 {
        return if unsafe { windows_sys::Win32::Foundation::GetLastError() } == 1168 { Ok(false) }
        else { Err("无法读取 Windows 凭据状态".into()) };
    }
    if !pointer.is_null() {
        let credential = unsafe { &mut *pointer };
        if !credential.credential_blob.is_null() && credential.credential_blob_size <= 2_560 {
            unsafe { ptr::write_bytes(credential.credential_blob, 0, credential.credential_blob_size as usize); }
        }
        unsafe { CredFree(pointer as *mut c_void); }
    }
    Ok(true)
}
#[cfg(windows)]
pub fn clear(source: CredentialSource) -> Result<(), String> {
    clear_named(source.target())
}
#[cfg(windows)]
pub(crate) fn clear_named(target_name:&str)->Result<(),String>{
    let _lock = WRITING.lock().map_err(|_|"凭据正在保存，请稍后重试")?;
    let target = wide(target_name);
    if unsafe { CredDeleteW(target.as_ptr(), 1, 0) } != 0 || unsafe { windows_sys::Win32::Foundation::GetLastError() } == 1168 { REVISION.fetch_add(1, Ordering::SeqCst); Ok(()) }
    else { Err("无法删除 Windows 凭据".into()) }
}

// Only the app's known legacy targets are eligible. No fallback reads happen during normal use.
fn legacy_destination(target:&str)->Option<String>{
    let suffix=target.strip_prefix("CodexDesktop.")?;
    let fixed=["Beszel.ApiToken","DeepSeek.ApiKey","MiMo.ApiKey","MiMo.ConsoleSession",
        "Anthropic.AdminKey","OpenAI.AdminKey","DeepSeek.InferenceKey","Anthropic.InferenceKey","DeepSeek.AgentRoomKey"];
    let room=suffix.strip_prefix("AgentRoom.").and_then(|s|s.strip_suffix(".ApiKey"))
        .is_some_and(|p|["DeepSeek","GPT","Gemini","Claude","Qwen","Kimi","Grok","豆包","MiMo"].contains(&p));
    let mail=suffix.strip_prefix("Mail.").is_some_and(|s|{
        let Some((provider,part))=s.split_once('.')else{return false};
        ["gmail","outlook","netease","qq"].contains(&provider)
            && (part=="Part0"||(0..=1).any(|bank|(1..=5).any(|index|part==format!("Bank{bank}.Part{index}"))))
    });
    let service=suffix.strip_prefix("VpsService.").and_then(|s|s.split_once('.')).is_some_and(|(kind,endpoint)|
        ["3x-ui","sing-box"].contains(&kind)&&!endpoint.is_empty()&&endpoint.len()<=1000
            &&endpoint.len()%2==0&&endpoint.bytes().all(|b|b.is_ascii_hexdigit()));
    (fixed.contains(&suffix)||room||mail||service).then(||format!("GleamDesk.{suffix}"))
}

fn import_legacy_with(targets:&[String],consent:bool,mut exists:impl FnMut(&str)->Result<bool,String>,mut copy:impl FnMut(&str,&str)->Result<(),String>)->Result<usize,String>{
    if !consent{return Err("请先确认导入旧版账号".into())}
    // Protect an entire mail account if GleamDesk already has its metadata, including its chunk banks.
    let mut protected_mail=Vec::new();
    for provider in ["gmail","outlook","netease","qq"]{
        if exists(&format!("GleamDesk.Mail.{provider}.Part0"))?{protected_mail.push(format!("GleamDesk.Mail.{provider}."));}
    }
    let mut ordered=targets.to_vec();ordered.sort_by_key(|s|(s.ends_with(".Part0"),s.clone()));ordered.dedup();
    let mut copied=0;
    for old in &ordered{
        let Some(new)=legacy_destination(old)else{continue};
        if protected_mail.iter().any(|prefix|new.starts_with(prefix))||exists(&new)?{continue}
        copy(old,&new).map_err(|_|format!("导入中止，已复制 {copied} 项；旧账号未删除，已有账号未覆盖，可重试"))?;
        copied+=1;
    }
    Ok(copied)
}

#[cfg(windows)]
fn legacy_targets()->Result<Vec<String>,String>{
    let filter=wide("CodexDesktop.*");let mut count=0;let mut entries:*mut *mut CredentialW=ptr::null_mut();
    if unsafe{CredEnumerateW(filter.as_ptr(),0,&mut count,&mut entries)}==0{
        return if unsafe{windows_sys::Win32::Foundation::GetLastError()}==1168{Ok(Vec::new())}else{Err("无法检查旧版凭据状态".into())};
    }
    if entries.is_null(){return Err("旧版凭据目录无效".into())}
    let mut targets=Vec::new();
    for pointer in unsafe{std::slice::from_raw_parts(entries,count as usize)}{
        if pointer.is_null(){continue}
        let entry=unsafe{&mut **pointer};
        if !entry.credential_blob.is_null()&&entry.credential_blob_size<=2560{
            unsafe{ptr::write_bytes(entry.credential_blob,0,entry.credential_blob_size as usize)};
        }
        if entry.kind!=1||entry.target_name.is_null(){continue}
        let mut len=0;
        while len<2048&&unsafe{*entry.target_name.add(len)}!=0{len+=1;}
        if len==2048{continue}
        if let Ok(name)=String::from_utf16(unsafe{std::slice::from_raw_parts(entry.target_name,len)}){
            if legacy_destination(&name).is_some(){targets.push(name)}
        }
    }
    unsafe{CredFree(entries as *mut c_void)};
    Ok(targets)
}

fn require_local_settings(view:&tauri::Webview)->Result<(),String>{
    let url=view.url().map_err(|_|"无法确认设置来源")?;
    if !["main","dashboard"].contains(&view.label())||!crate::webapps::trusted_local_origin(view.label(),&url,cfg!(debug_assertions)){
        return Err("仅本地设置可导入旧版账号".into())
    }Ok(())
}
#[tauri::command]
pub fn credential_legacy_available(view:tauri::Webview)->Result<bool,String>{
    require_local_settings(&view)?;
    #[cfg(windows)]{Ok(!legacy_targets()?.is_empty())}
    #[cfg(not(windows))]{Ok(false)}
}
#[tauri::command]
pub fn credential_import_legacy(view:tauri::Webview,consent:bool)->Result<usize,String>{
    require_local_settings(&view)?;
    if !consent{return Err("请先确认导入旧版账号".into())}
    #[cfg(windows)]{
        // Keep the existing mail-save lock order; never import between bank and metadata writes.
        let _mail_lock=crate::mail::CREDENTIAL_LOCK.lock().map_err(|_|"邮箱凭据正在保存，请稍后重试")?;
        let _lock=WRITING.lock().map_err(|_|"凭据正在保存，请稍后重试")?;
        import_legacy_with(&legacy_targets()?,consent,exists_named,|old,new|{
            let secret=read_named(old)?;save_unlocked(new,secret.as_str())
        })
    }
    #[cfg(not(windows))]{Err("旧版账号导入仅支持 Windows".into())}
}
#[tauri::command]
pub fn credential_save(source: CredentialSource, secret: String) -> Result<(), String> {
    let secret = Secret(secret.into_bytes());
    #[cfg(windows)] { save(source, secret.as_str()) }
    #[cfg(not(windows))] { let _ = (source, secret); Err("安全凭据仅支持 Windows 桌面版本".into()) }
}
#[tauri::command]
pub fn credential_exists(source: CredentialSource) -> Result<bool, String> {
    #[cfg(windows)] { exists(source) }
    #[cfg(not(windows))] { let _ = source; Err("安全凭据仅支持 Windows 桌面版本".into()) }
}
#[tauri::command]
pub fn credential_clear(source: CredentialSource) -> Result<(), String> {
    #[cfg(windows)] { clear(source) }
    #[cfg(not(windows))] { let _ = source; Err("安全凭据仅支持 Windows 桌面版本".into()) }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scopes_credentials_without_legacy_fallback() {
        assert_eq!(CredentialSource::Beszel.target(), "GleamDesk.Beszel.ApiToken");
        assert_eq!(serde_json::from_str::<CredentialSource>("\"openai\"").unwrap().target(), "GleamDesk.OpenAI.AdminKey");
        assert!(serde_json::from_str::<CredentialSource>("\"arbitrary-target\"").is_err());
        assert_ne!(CredentialSource::AnalysisDeepseek.target(), CredentialSource::Deepseek.target());
        assert_ne!(CredentialSource::AnalysisAnthropic.target(), CredentialSource::Anthropic.target());
        assert_eq!(serde_json::from_str::<CredentialSource>("\"analysis-anthropic\"").unwrap().target(), "GleamDesk.Anthropic.InferenceKey");
        assert!(validate("test-token").is_ok());
        assert!(validate("bad\r\nAuthorization: injected").is_err());
        assert!(validate(&"x".repeat(2561)).is_err());
    }
    #[test]
    fn import_requires_consent_before_any_store_access(){
        assert!(import_legacy_with(&[],false,|_|panic!("must not inspect"),|_,_|panic!("must not copy")).is_err());
    }
    #[test]
    fn import_allowlist_excludes_other_apps_and_malformed_targets(){
        for target in ["CodexDesktop.DeepSeek.ApiKey","CodexDesktop.MiMo.ConsoleSession","CodexDesktop.AgentRoom.豆包.ApiKey","CodexDesktop.Mail.gmail.Bank1.Part5","CodexDesktop.Mail.qq.Part0","CodexDesktop.VpsService.3x-ui.6874747073"]{
            assert!(legacy_destination(target).unwrap().starts_with("GleamDesk."));
        }
        for target in ["OtherApp.MiMo.ApiKey","CodexDesktop.Unknown.Secret","CodexDesktop.Mail.gmail.Bank0.Part6","CodexDesktop.Mail.qq.Part1","CodexDesktop.VpsService.3x-ui.not-hex","CodexDesktop.AgentRoom.Ollama.ApiKey"]{
            assert!(legacy_destination(target).is_none());
        }
    }
    #[test]
    fn import_preserves_current_accounts_legacy_values_and_is_idempotent(){
        use std::{cell::RefCell,collections::BTreeMap};
        let store=RefCell::new(BTreeMap::from([
            ("CodexDesktop.DeepSeek.ApiKey".to_string(),"old-deepseek".to_string()),
            ("CodexDesktop.MiMo.ApiKey".to_string(),"old-mimo".to_string()),
            ("GleamDesk.DeepSeek.ApiKey".to_string(),"current-deepseek".to_string()),
        ]));
        let targets=vec!["CodexDesktop.DeepSeek.ApiKey".into(),"CodexDesktop.MiMo.ApiKey".into()];
        let run=||import_legacy_with(&targets,true,|key|Ok(store.borrow().contains_key(key)),|old,new|{
            let value=store.borrow()[old].clone();store.borrow_mut().insert(new.into(),value);Ok(())
        }).unwrap();
        assert_eq!(run(),1);assert_eq!(run(),0);
        assert_eq!(store.borrow()["GleamDesk.DeepSeek.ApiKey"],"current-deepseek");
        assert_eq!(store.borrow()["CodexDesktop.DeepSeek.ApiKey"],"old-deepseek");
        assert_eq!(store.borrow()["GleamDesk.MiMo.ApiKey"],"old-mimo");
    }
    #[test]
    fn import_never_overwrites_banks_of_an_existing_mail_account(){
        let targets=vec!["CodexDesktop.Mail.gmail.Part0".into(),"CodexDesktop.Mail.gmail.Bank0.Part1".into()];
        assert_eq!(import_legacy_with(&targets,true,|key|Ok(key=="GleamDesk.Mail.gmail.Part0"),|_,_|panic!("must preserve all banks")).unwrap(),0);
    }
    #[test]
    fn import_writes_mail_metadata_last_and_stops_on_failure(){
        let targets=vec!["CodexDesktop.Mail.qq.Part0".into(),"CodexDesktop.Mail.qq.Bank0.Part1".into(),"CodexDesktop.Mail.qq.Bank0.Part2".into()];
        let mut copied=Vec::new();
        import_legacy_with(&targets,true,|_|Ok(false),|old,_|{copied.push(old.to_string());Ok(())}).unwrap();
        assert_eq!(copied.last().unwrap(),"CodexDesktop.Mail.qq.Part0");
        let mut attempts=0;
        let error=import_legacy_with(&targets,true,|_|Ok(false),|_,_|{attempts+=1;Err("sensitive backend error".into())}).unwrap_err();
        assert_eq!(attempts,1);assert!(error.contains("已复制 0 项"));assert!(!error.contains("sensitive"));
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "writes only a unique synthetic Windows credential, then removes it"]
    fn native_scoped_credential_roundtrip(){
        let target=format!("GleamDesk.Test.{}.{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        struct Cleanup(String);impl Drop for Cleanup{fn drop(&mut self){let _=clear_named(&self.0);}}
        let _cleanup=Cleanup(target.clone());
        assert!(!exists_named(&target).unwrap());save_named(&target,"synthetic-test-value").unwrap();
        assert_eq!(read_named(&target).unwrap().as_str(),"synthetic-test-value");
        assert!(exists_named(&target).unwrap());
        assert!(!exists_named(&target.replacen("GleamDesk.","CodexDesktop.",1)).unwrap());
        clear_named(&target).unwrap();assert!(!exists_named(&target).unwrap());
    }
}
