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
    startup_legacy_present: bool,
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
fn revision(command: &impl Hash) -> String {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    command.hash(&mut hash);
    format!("{:016x}", hash.finish())
}
fn check_change(label: &str, confirmed: bool) -> Result<crate::simulation::LivePermit<'static>, String> {
    if !matches!(label, "main" | "dashboard") || !confirmed { return Err("请在本机设置页确认系统变更".into()); }
    crate::simulation::require_live()
}

#[cfg(windows)]
fn legacy_startup_registration() -> Result<Option<String>, String> {
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
fn legacy_startup_registration() -> Result<Option<String>, String> { Err("仅 Windows 支持此设置".into()) }

#[cfg(windows)]
fn set_legacy_startup(target: Option<&str>, permit: Option<&crate::simulation::LivePermit<'_>>) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::*;
    if legacy_startup_registration()?.as_deref() == target { return Ok(()); }
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut key = std::ptr::null_mut();
    let code = unsafe { if target.is_some() {
        RegCreateKeyExW(HKEY_CURRENT_USER, wide(STARTUP_KEY).as_ptr(), 0, std::ptr::null(), 0, KEY_SET_VALUE, std::ptr::null(), &mut key, std::ptr::null_mut())
    } else { RegOpenKeyExW(HKEY_CURRENT_USER, wide(STARTUP_KEY).as_ptr(), 0, KEY_SET_VALUE, &mut key) } };
    if code != 0 { return Err(format!("无法打开当前用户启动项（Windows {code}）")); }
    if let Some(permit) = permit { if let Err(error) = permit.check() { unsafe { RegCloseKey(key); } return Err(error); } }
    let result = unsafe { match target {
        Some(command) => { let data = wide(command); RegSetValueExW(key, wide(STARTUP_NAME).as_ptr(), 0, REG_SZ, data.as_ptr().cast(), (data.len() * 2) as u32) }
        None => RegDeleteValueW(key, wide(STARTUP_NAME).as_ptr()),
    } };
    unsafe { RegCloseKey(key); }
    if result != 0 && !(result == 2 && target.is_none()) { return Err(format!("旧登录启动项未更新（Windows {result}）")); }
    if legacy_startup_registration()?.as_deref() != target { return Err("旧启动项核对不一致，请刷新检查".into()); }
    Ok(())
}

#[derive(Hash, PartialEq, Eq)]
struct StartupRegistration { shortcut: Option<Vec<u8>>, legacy: Option<String> }

#[cfg(windows)]
fn startup_shortcut_path() -> Result<std::path::PathBuf, String> {
    use ::windows::{core::PCWSTR, Win32::{UI::Shell::{SHGetKnownFolderPath, FOLDERID_Startup, KF_FLAG_DEFAULT}, System::Com::CoTaskMemFree}};
    let raw = unsafe { SHGetKnownFolderPath(&FOLDERID_Startup, KF_FLAG_DEFAULT, None) }.map_err(|_| "无法定位当前用户启动文件夹")?;
    let path = unsafe { PCWSTR(raw.0).to_string() };
    unsafe { CoTaskMemFree(Some(raw.0.cast())); }
    let folder = std::path::PathBuf::from(path.map_err(|_| "启动文件夹路径编码无效")?);
    if !folder.is_absolute() || !folder.is_dir() { return Err("当前用户启动文件夹不可用".into()); }
    Ok(folder.join("GleamDesk.lnk"))
}

// Inspect only our own file. Do not follow a replaced shortcut file or read an unbounded file.
fn shortcut_bytes(path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("无法读取 GleamDesk 启动快捷方式".into()),
        Ok(meta) => {
            #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if meta.file_attributes() & 0x400 != 0 { return Err("启动快捷方式不能是重解析点".into()); } }
            if !meta.is_file() || meta.len() > 1_048_576 { return Err("GleamDesk 启动快捷方式格式异常".into()); }
            std::fs::read(path).map(Some).map_err(|_| "无法读取 GleamDesk 启动快捷方式".into())
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ShortcutTarget { executable: String, directory: String, arguments: String }

#[cfg(windows)]
fn shortcut_target(path: std::path::PathBuf, save_target: Option<std::path::PathBuf>) -> Result<ShortcutTarget, String> {
    std::thread::spawn(move || {
        use ::windows::{core::{Interface, PCWSTR}, Win32::{System::Com::{CoInitializeEx, CoUninitialize, CoCreateInstance, IPersistFile, COINIT_APARTMENTTHREADED, CLSCTX_INPROC_SERVER, STGM_READ}, UI::Shell::{IShellLinkW, ShellLink}}};
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }.map_err(|_| "无法初始化启动快捷方式接口")?;
        struct Apartment; impl Drop for Apartment { fn drop(&mut self) { unsafe { CoUninitialize(); } } }
        let _apartment = Apartment;
        let operation = || -> ::windows::core::Result<ShortcutTarget> { unsafe {
            let wide = |s: &std::path::Path| s.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect::<Vec<_>>();
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            let file: IPersistFile = link.cast()?;
            if let Some(target) = save_target {
                link.SetPath(PCWSTR(wide(&target).as_ptr()))?;
                link.SetWorkingDirectory(PCWSTR(wide(target.parent().unwrap()).as_ptr()))?;
                link.SetArguments(::windows::core::w!(""))?;
                file.Save(PCWSTR(wide(&path).as_ptr()), true)?;
            } else { file.Load(PCWSTR(wide(&path).as_ptr()), STGM_READ)?; }
            let mut executable = vec![0u16;32768]; let mut directory = vec![0u16;32768]; let mut arguments = vec![0u16;32768];
            link.GetPath(&mut executable, std::ptr::null_mut(), 0)?;
            link.GetWorkingDirectory(&mut directory)?; link.GetArguments(&mut arguments)?;
            let text = |buffer: Vec<u16>| String::from_utf16_lossy(&buffer[..buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len())]);
            Ok(ShortcutTarget { executable: text(executable), directory: text(directory), arguments: text(arguments) })
        } };
        operation().map_err(|error| format!("启动快捷方式操作失败（{}）", error.code()))
    }).join().map_err(|_| "启动快捷方式任务失败".to_string())?
}

#[cfg(windows)]
fn startup_registration() -> Result<StartupRegistration, String> {
    Ok(StartupRegistration { shortcut: shortcut_bytes(&startup_shortcut_path()?)?, legacy: legacy_startup_registration()? })
}
#[cfg(not(windows))]
fn startup_registration() -> Result<StartupRegistration, String> { Err("仅 Windows 支持此设置".into()) }

fn same_shortcut_target(target: &ShortcutTarget, executable: &std::path::Path) -> bool {
    let normalized = |s: &str| s.trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase();
    target.arguments.is_empty() && normalized(&target.executable) == normalized(&executable.to_string_lossy())
        && executable.parent().is_some_and(|parent| normalized(&target.directory) == normalized(&parent.to_string_lossy()))
}

// Temporary files have no .lnk extension, so an interrupted write cannot add a second startup entry.
fn replace_shortcut(path: &std::path::Path, bytes: Option<&[u8]>) -> Result<(), String> {
    replace_shortcut_guarded(path, bytes, || Ok(()))
}

fn replace_shortcut_guarded(path: &std::path::Path, bytes: Option<&[u8]>, check: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    use std::io::Write;
    if let Some(bytes) = bytes {
        let temp = path.with_extension(format!("{}.tmp", std::process::id()));
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|_| "无法准备启动快捷方式文件")?;
        let result = (|| {
            file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|_| "无法写入启动快捷方式".to_string())?;
            drop(file); check()?;
            std::fs::rename(&temp, path).map_err(|_| "无法保存 GleamDesk 启动快捷方式".to_string())
        })();
        if result.is_err() { let _ = std::fs::remove_file(&temp); }
        result
    } else {
        check()?;
        match std::fs::remove_file(path) { Ok(()) => Ok(()), Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()), Err(_) => Err("无法移除 GleamDesk 启动快捷方式".into()) }
    }
}

fn update_startup_shortcut(
    path: &std::path::Path, before: Option<&[u8]>, target: Option<&[u8]>,
    check: impl FnOnce() -> Result<(), String>,
    finish: impl FnOnce() -> Result<(), String>, restore_legacy: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    replace_shortcut_guarded(path, target, check)?;
    if let Err(error) = finish() {
        // Do not overwrite a separate edit made while the migration was running.
        if !shortcut_bytes(path).is_ok_and(|bytes| bytes.as_deref() == target) {
            return Err(format!("{error}；快捷方式已被其他程序更改，未覆盖，请检查启动项"));
        }
        let restored_link = replace_shortcut(path, before);
        let restored_legacy = restore_legacy();
        if restored_link.is_err() || restored_legacy.is_err() || !shortcut_bytes(path).is_ok_and(|bytes| bytes.as_deref() == before) {
            return Err(format!("{error}；原启动项恢复未能确认，请勿重启"));
        }
        return Err(format!("{error}；已恢复原启动项"));
    }
    Ok(())
}

#[cfg(windows)]
fn write_startup(enabled: bool, expected: &str, permit: &crate::simulation::LivePermit<'_>) -> Result<(), String> {
    let before = startup_registration()?;
    if revision(&before) != expected { return Err("登录启动项已变化，请刷新后再确认".into()); }
    let path = startup_shortcut_path()?;
    let target = if enabled {
        let executable = std::env::current_exe().map_err(|_| "无法定位当前程序")?;
        startup_command(&executable)?;
        // Build the link away from the real Startup folder; only the final confirmed replacement is a system change.
        let directory = std::env::temp_dir().join(format!("gleamdesk-startup-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "系统时间无效")?.as_nanos()));
        std::fs::create_dir(&directory).map_err(|_| "无法准备启动快捷方式")?;
        let temp = directory.join("GleamDesk.lnk");
        let result = shortcut_target(temp.clone(), Some(executable.clone())).and_then(|target| {
            if !same_shortcut_target(&target, &executable) { return Err("启动快捷方式目标核对失败".into()); }
            shortcut_bytes(&temp)?.ok_or_else(|| "启动快捷方式未生成".into())
        });
        let _ = std::fs::remove_file(&temp); let _ = std::fs::remove_dir(&directory);
        Some(result?)
    } else { None };
    permit.check()?;
    if startup_registration()? != before { return Err("登录启动项已变化，请刷新后再确认".into()); }
    update_startup_shortcut(&path, before.shortcut.as_deref(), target.as_deref(), || permit.check(), || {
        permit.check()?;
        set_legacy_startup(None, Some(permit))?;
        let after = startup_registration()?;
        if after.shortcut != target || after.legacy.is_some() { return Err("启动项保存后核对不一致".into()); }
        if enabled {
            let executable = std::env::current_exe().map_err(|_| "无法定位当前程序")?;
            if !same_shortcut_target(&shortcut_target(path.clone(), None)?, &executable) { return Err("已保存的启动快捷方式目标核对失败".into()); }
        }
        Ok(())
    }, || {
        set_legacy_startup(before.legacy.as_deref(), None)?;
        if !startup_registration().is_ok_and(|value| value == before) { return Err("原启动项恢复核对失败".into()); }
        Ok(())
    })
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
    #[cfg(windows)]
    let matches_current = startup.as_ref().is_ok_and(|entry| entry.shortcut.is_some()) && std::env::current_exe().ok().is_some_and(|executable| {
        startup_shortcut_path().and_then(|path| shortcut_target(path, None)).is_ok_and(|target| same_shortcut_target(&target, &executable))
    });
    #[cfg(not(windows))] let matches_current = false;
    let icons = desktop_icons(None);
    DesktopIntegrationStatus {
        startup_registered: startup.as_ref().ok().map(|entry| entry.shortcut.is_some()),
        startup_matches_current: matches_current,
        startup_legacy_present: startup.as_ref().is_ok_and(|entry| entry.legacy.is_some()),
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
        assert_ne!(revision(&None::<String>), revision(&Some("quoted fixture path".to_string())));
        assert_eq!(revision(&None::<String>), revision(&None::<String>));
    }
    #[test] fn startup_revision_detects_both_shortcut_and_legacy_changes() {
        let empty = StartupRegistration { shortcut: None, legacy: None };
        let link = StartupRegistration { shortcut: Some(vec![1,2,3]), legacy: None };
        let old = StartupRegistration { shortcut: None, legacy: Some("legacy fixture".into()) };
        assert_ne!(revision(&empty), revision(&link)); assert_ne!(revision(&empty), revision(&old));
        assert_ne!(revision(&link), revision(&StartupRegistration { shortcut: Some(vec![1,2,4]), legacy: None }));
    }
    #[cfg(windows)]
    #[test] fn shortcut_round_trip_keeps_unicode_target_working_directory_and_empty_arguments() {
        let directory = std::env::temp_dir().join(format!("gleamdesk-link-test-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("启动 fixture.lnk");
        let executable = std::path::PathBuf::from(r"C:\应用 文件\GleamDesk.exe");
        let saved = shortcut_target(path.clone(), Some(executable.clone())).unwrap();
        assert!(same_shortcut_target(&saved, &executable));
        let loaded = shortcut_target(path.clone(), None).unwrap();
        assert!(same_shortcut_target(&loaded, &executable));
        let mut altered = loaded; altered.arguments = "unexpected-argument".into();
        assert!(!same_shortcut_target(&altered, &executable));
        assert!(shortcut_bytes(&path).unwrap().is_some());
        std::fs::remove_file(&path).unwrap(); std::fs::remove_dir(directory).unwrap();
    }
    #[test] fn shortcut_replace_preserves_neighbors_and_never_overwrites_existing_temporary_file() {
        let directory = std::env::temp_dir().join(format!("gleamdesk-file-test-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("GleamDesk.lnk"); let neighbor = directory.join("other.lnk");
        std::fs::write(&neighbor, b"keep").unwrap();
        replace_shortcut(&path, Some(b"first")).unwrap();
        replace_shortcut(&path, Some(b"second")).unwrap();
        assert_eq!(shortcut_bytes(&path).unwrap().unwrap(), b"second");
        let temp = path.with_extension(format!("{}.tmp", std::process::id()));
        std::fs::write(&temp, b"unrelated").unwrap();
        assert!(replace_shortcut(&path, Some(b"third")).is_err());
        assert_eq!(std::fs::read(&temp).unwrap(), b"unrelated");
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        replace_shortcut(&path, None).unwrap(); replace_shortcut(&path, None).unwrap();
        assert!(shortcut_bytes(&path).unwrap().is_none()); assert_eq!(std::fs::read(&neighbor).unwrap(), b"keep");
        assert!(shortcut_bytes(&directory).is_err());
        std::fs::remove_file(temp).unwrap(); std::fs::remove_file(neighbor).unwrap(); std::fs::remove_dir(directory).unwrap();
    }
    #[test] fn migration_failure_restores_previous_shortcut_and_reports_rollback_failure() {
        let directory = std::env::temp_dir().join(format!("gleamdesk-rollback-test-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap(); let path = directory.join("GleamDesk.lnk");
        let mut restored = false;
        let error = update_startup_shortcut(&path, None, Some(b"new"), || Ok(()), || Err("legacy removal failed".into()), || {restored=true;Ok(())}).unwrap_err();
        assert!(restored); assert!(shortcut_bytes(&path).unwrap().is_none()); assert!(error.contains("已恢复原启动项"));
        replace_shortcut(&path, Some(b"previous")).unwrap();
        assert!(update_startup_shortcut(&path, Some(b"previous"), None, || Ok(()), || Err("failed".into()), || Ok(())).unwrap_err().contains("已恢复原启动项"));
        assert_eq!(std::fs::read(&path).unwrap(), b"previous");
        assert!(update_startup_shortcut(&path, Some(b"previous"), Some(b"new"), || Ok(()), || Err("failed".into()), || Err("rollback failure".into())).unwrap_err().contains("恢复未能确认"));
        assert!(update_startup_shortcut(&path, Some(b"previous"), Some(b"new"), || Err("simulation changed".into()), || panic!("cancelled change must not continue"), || panic!("nothing to restore")).unwrap_err().contains("simulation changed"));
        assert_eq!(std::fs::read(&path).unwrap(),b"previous");
        let error=update_startup_shortcut(&path, Some(b"previous"), Some(b"new"), || Ok(()), || {std::fs::write(&path,b"external edit").unwrap();Err("failed".into())}, || panic!("must not overwrite external state")).unwrap_err();
        assert!(error.contains("未覆盖"));assert_eq!(std::fs::read(&path).unwrap(),b"external edit");
        std::fs::remove_file(path).unwrap(); std::fs::remove_dir(directory).unwrap();
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "read-only Windows startup registration and Explorer icon flags; no changes"]
    fn read_only_desktop_status() {
        let status = desktop_status();
        assert!(status.startup_error.is_none(), "startup read failed");
        assert!(status.icons_error.is_none(), "{:?}", status.icons_error);
        println!("DESKTOP_READONLY:{}", serde_json::to_string(&status).unwrap());
        println!("Read-only desktop status: registration readable; icon visibility readable. No changes.");
    }
}
