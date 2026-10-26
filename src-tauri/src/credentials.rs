use std::{ffi::c_void, ptr};
use std::sync::atomic::{AtomicU64, Ordering};
static REVISION: AtomicU64 = AtomicU64::new(0);
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
            Self::Beszel => "CodexDesktop.Beszel.ApiToken",
            Self::Deepseek => "CodexDesktop.DeepSeek.ApiKey",
            Self::Mimo => "CodexDesktop.MiMo.ApiKey",
            Self::MimoConsole => "CodexDesktop.MiMo.ConsoleSession",
            Self::Anthropic => "CodexDesktop.Anthropic.AdminKey",
            Self::Openai => "CodexDesktop.OpenAI.AdminKey",
            Self::AnalysisDeepseek => "CodexDesktop.DeepSeek.InferenceKey",
            Self::AnalysisAnthropic => "CodexDesktop.Anthropic.InferenceKey",
            Self::AgentDeepseek => "CodexDesktop.DeepSeek.AgentRoomKey",
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
    validate(value)?;
    let mut bytes = Secret(value.as_bytes().to_vec());
    let target = wide(target_name);
    let user = wide("AgentRoom");
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
    let target = wide(target_name);
    if unsafe { CredDeleteW(target.as_ptr(), 1, 0) } != 0 || unsafe { windows_sys::Win32::Foundation::GetLastError() } == 1168 { REVISION.fetch_add(1, Ordering::SeqCst); Ok(()) }
    else { Err("无法删除 Windows 凭据".into()) }
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
    fn scopes_credentials_and_preserves_beszel_target() {
        assert_eq!(CredentialSource::Beszel.target(), "CodexDesktop.Beszel.ApiToken");
        assert_eq!(serde_json::from_str::<CredentialSource>("\"openai\"").unwrap().target(), "CodexDesktop.OpenAI.AdminKey");
        assert!(serde_json::from_str::<CredentialSource>("\"arbitrary-target\"").is_err());
        assert_ne!(CredentialSource::AnalysisDeepseek.target(), CredentialSource::Deepseek.target());
        assert_ne!(CredentialSource::AnalysisAnthropic.target(), CredentialSource::Anthropic.target());
        assert_eq!(serde_json::from_str::<CredentialSource>("\"analysis-anthropic\"").unwrap().target(), "CodexDesktop.Anthropic.InferenceKey");
        assert!(validate("test-token").is_ok());
        assert!(validate("bad\r\nAuthorization: injected").is_err());
        assert!(validate(&"x".repeat(2561)).is_err());
    }
}
