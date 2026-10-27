pub mod eventlog;

use serde::Serialize;
use std::hash::{Hash, Hasher};

const STARTUP_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const STARTUP_NAME: &str = "GleamDesk";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIntegrationStatus {
    startup_registered: Option<bool>,
    startup_matches_current: bool,
    startup_revision: String,
    startup_error: Option<String>,
    icons_hidden: Option<bool>,
    icons_error: Option<String>,
}

fn startup_command(path: &std::path::Path) -> Result<String, String> {
    let text = path.to_str().ok_or("程序路径无法表示")?;
    if !path.is_absolute() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        || text.chars().any(|c| matches!(c, '"' | '\0' | '\r' | '\n')) {
        return Err("开机启动需要有效的程序路径".into());
    }
    let command = format!("\"{text}\"");
    if command.encode_utf16().count() > 260 { return Err("程序路径过长，无法添加登录启动项".into()); }
    Ok(command)
}
fn revision(command: &Option<String>) -> String {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    command.hash(&mut hash);
    format!("{:016x}", hash.finish())
}
fn check_change(label: &str, confirmed: bool) -> Result<crate::simulation::LivePermit<'static>, String> {
    if !matches!(label, "main" | "dashboard") || !confirmed { return Err("请在本机设置页确认系统变更".into()); }
    crate::simulation::require_live()
}

#[cfg(windows)]
fn startup_registration() -> Result<Option<String>, String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut buffer = vec![0u16; 32768];
    let mut size = (buffer.len() * 2) as u32;
    let code = unsafe { RegGetValueW(HKEY_CURRENT_USER, wide(STARTUP_KEY).as_ptr(), wide(STARTUP_NAME).as_ptr(), RRF_RT_REG_SZ,
        std::ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut size) };
    if code == 2 { return Ok(None); }
    if code != 0 || size == 0 || size as usize > buffer.len() * 2 { return Err(format!("无法读取登录启动项（Windows {code}）")); }
    let length = buffer.iter().position(|&c| c == 0).ok_or("登录启动项格式无效")?;
    String::from_utf16(&buffer[..length]).map(Some).map_err(|_| "登录启动项编码无效".into())
}
#[cfg(not(windows))]
fn startup_registration() -> Result<Option<String>, String> { Err("仅 Windows 支持此设置".into()) }

#[cfg(windows)]
fn write_startup(enabled: bool, expected: &str, permit: &crate::simulation::LivePermit<'_>) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::*;
    let before = startup_registration()?;
    if revision(&before) != expected { return Err("登录启动项已变化，请刷新后再确认".into()); }
    let target = if enabled { Some(startup_command(&std::env::current_exe().map_err(|_| "无法定位当前程序")?)?) } else { None };
    if before == target { return Ok(()); }
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut key = std::ptr::null_mut();
    permit.check()?;
    let code = unsafe { if enabled {
        RegCreateKeyExW(HKEY_CURRENT_USER, wide(STARTUP_KEY).as_ptr(), 0, std::ptr::null(), 0, KEY_SET_VALUE, std::ptr::null(), &mut key, std::ptr::null_mut())
    } else { RegOpenKeyExW(HKEY_CURRENT_USER, wide(STARTUP_KEY).as_ptr(), 0, KEY_SET_VALUE, &mut key) } };
    if code != 0 { return Err(format!("无法打开当前用户启动项（Windows {code}）")); }
    let result = permit.check().map(|_| unsafe { match target.as_ref() {
        Some(command) => { let data = wide(command); RegSetValueExW(key, wide(STARTUP_NAME).as_ptr(), 0, REG_SZ, data.as_ptr().cast(), (data.len() * 2) as u32) }
        None => RegDeleteValueW(key, wide(STARTUP_NAME).as_ptr()),
    } });
    unsafe { RegCloseKey(key); }
    let result = result?;
    if result != 0 && !(result == 2 && !enabled) { return Err(format!("登录启动项未保存（Windows {result}）")); }
    if startup_registration()? != target { return Err("启动项写入后核对不一致，请刷新检查".into()); }
    Ok(())
}
#[cfg(not(windows))]
fn write_startup(_: bool, _: &str, _: &crate::simulation::LivePermit<'_>) -> Result<(), String> { Err("仅 Windows 支持此设置".into()) }

#[cfg(windows)]
fn desktop_icons(change: Option<(bool, bool, crate::simulation::LivePermit<'static>)>) -> Result<bool, String> {
    // A fresh STA keeps Explorer automation separate from Tauri's UI/worker apartments.
    std::thread::spawn(move || -> Result<bool, String> {
        use ::windows::Win32::{System::{Com::{CoInitializeEx, CoUninitialize, CoCreateInstance, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, IServiceProvider}, Variant::VARIANT},
            UI::Shell::{ShellWindows, IShellWindows, IShellBrowser, IFolderView2, SWC_DESKTOP, SWFO_NEEDDISPATCH, SID_STopLevelBrowser, FWF_NOICONS}};
        use ::windows::core::{Interface, Error, HRESULT};
        struct Apartment;
        impl Drop for Apartment { fn drop(&mut self) { unsafe { CoUninitialize(); } } }
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }.map_err(|_| "无法初始化桌面接口")?;
        let _apartment = Apartment;
        let operation = || -> ::windows::core::Result<bool> { unsafe {
            let shell: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER)?;
            let mut hwnd = 0;
            let dispatch = shell.FindWindowSW(&VARIANT::from(0i32), &VARIANT::default(), SWC_DESKTOP, &mut hwnd, SWFO_NEEDDISPATCH)?;
            let services: IServiceProvider = dispatch.cast()?;
            let browser: IShellBrowser = services.QueryService(&SID_STopLevelBrowser)?;
            let view: IFolderView2 = browser.QueryActiveShellView()?.cast()?;
            let mask = FWF_NOICONS.0 as u32;
            let hidden = view.GetCurrentFolderFlags()? & mask != 0;
            if let Some((desired, expected, permit)) = change {
                if hidden != expected { return Err(Error::new(HRESULT(0x8000000Cu32 as i32), "桌面图标状态已变化，请刷新")); }
                permit.check().map_err(|message| Error::new(HRESULT(0x80004004u32 as i32), message))?;
                if hidden != desired { view.SetCurrentFolderFlags(mask, if desired { mask } else { 0 })?; }
                let after = view.GetCurrentFolderFlags()? & mask != 0;
                if after != desired { return Err(Error::new(HRESULT(0x80004005u32 as i32), "桌面图标核对失败")); }
                return Ok(after);
            }
            Ok(hidden)
        } };
        operation().map_err(|error| format!("桌面图标接口不可用（{}）；可在桌面右键→查看中调整", error.code()))
    }).join().map_err(|_| "桌面图标读取任务失败".to_string())?
}
#[cfg(not(windows))]
fn desktop_icons(_: Option<(bool, bool, crate::simulation::LivePermit<'static>)>) -> Result<bool, String> { Err("仅 Windows 支持此设置".into()) }

fn desktop_status() -> DesktopIntegrationStatus {
    let startup = startup_registration();
    let current = std::env::current_exe().ok().and_then(|path| startup_command(&path).ok());
    let icons = desktop_icons(None);
    DesktopIntegrationStatus {
        startup_registered: startup.as_ref().ok().map(|entry| entry.is_some()),
        startup_matches_current: startup.as_ref().ok().and_then(|entry| entry.as_ref()).zip(current.as_ref()).is_some_and(|(a,b)| a.eq_ignore_ascii_case(b)),
        startup_revision: startup.as_ref().ok().map(revision).unwrap_or_default(),
        startup_error: startup.err(), icons_hidden: icons.as_ref().ok().copied(), icons_error: icons.err(),
    }
}

#[tauri::command]
pub async fn read_windows_desktop_settings() -> Result<DesktopIntegrationStatus, String> {
    tauri::async_runtime::spawn_blocking(desktop_status).await.map_err(|_| "系统设置读取失败".into())
}
#[tauri::command]
pub async fn set_windows_autostart(view: tauri::Webview, enabled: bool, expected_revision: String, confirmed: bool) -> Result<DesktopIntegrationStatus, String> {
    let permit = check_change(view.label(), confirmed)?;
    tauri::async_runtime::spawn_blocking(move || { permit.check()?; write_startup(enabled, &expected_revision, &permit)?; Ok(desktop_status()) })
        .await.map_err(|_| "登录启动设置任务失败".to_string())?
}
#[tauri::command]
pub async fn set_windows_desktop_icons(view: tauri::Webview, hidden: bool, expected_hidden: bool, confirmed: bool) -> Result<DesktopIntegrationStatus, String> {
    let permit = check_change(view.label(), confirmed)?;
    tauri::async_runtime::spawn_blocking(move || { permit.check()?; desktop_icons(Some((hidden, expected_hidden, permit)))?; Ok(desktop_status()) })
        .await.map_err(|_| "桌面图标设置任务失败".to_string())?
}

#[cfg(test)]
mod desktop_tests {
    use super::*;
    #[cfg(windows)]
    #[test] fn startup_target_quotes_spaces_and_unicode_without_a_shell() {
        assert_eq!(startup_command(std::path::Path::new(r"C:\应用 文件\GleamDesk.exe")).unwrap(), r#""C:\应用 文件\GleamDesk.exe""#);
        for bad in [r"GleamDesk.exe", r"C:\test.cmd", "C:\\bad\"name.exe", "C:\\bad\nname.exe"] { assert!(startup_command(std::path::Path::new(bad)).is_err()); }
        assert!(startup_command(std::path::Path::new(&format!("C:\\{}.exe", "长".repeat(260)))).is_err());
    }
    #[test] fn changes_require_settings_window_and_explicit_confirmation() {
        for label in ["dashboard", "main", "dock", "remote-1"] { assert!(check_change(label, false).is_err()); }
        assert!(check_change("remote-1", true).is_err()); assert!(check_change("dock", true).is_err());
        assert_ne!(revision(&None), revision(&Some("quoted fixture path".into())));
        assert_eq!(revision(&None), revision(&None));
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "read-only Windows startup registration and Explorer icon flags; no changes"]
    fn read_only_desktop_status() {
        let status = desktop_status();
        assert!(status.startup_error.is_none(), "startup read failed");
        assert!(status.icons_error.is_none(), "{:?}", status.icons_error);
        println!("Read-only desktop status: registration readable; icon visibility readable. No changes.");
    }
}
