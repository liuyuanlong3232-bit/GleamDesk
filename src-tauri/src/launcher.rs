use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    env,
    fs,
    hash::{Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

const MAX_SCAN_RESULTS: usize = 500;
#[tauri::command]
pub fn pick_application_target(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::UI::Controls::Dialogs::{
            CommDlgExtendedError, GetOpenFileNameW, OPENFILENAMEW, OFN_EXPLORER, OFN_FILEMUSTEXIST,
            OFN_HIDEREADONLY, OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST,
        };

        let owner = app.get_window("dashboard").or_else(|| app.get_window("main"))
            .and_then(|window| window.hwnd().ok().map(|handle| handle.0))
            .unwrap_or(std::ptr::null_mut());
        let filter: Vec<u16> = "应用程序和快捷方式\0*.exe;*.lnk;*.url\0所有文件\0*.*\0\0".encode_utf16().collect();
        let title: Vec<u16> = "选择要添加到 Dock 的应用\0".encode_utf16().collect();
        let mut path = vec![0u16; 32_768];
        let mut dialog = OPENFILENAMEW::default();
        dialog.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
        dialog.hwndOwner = owner;
        dialog.lpstrFilter = filter.as_ptr();
        dialog.nFilterIndex = 1;
        dialog.lpstrFile = path.as_mut_ptr();
        dialog.nMaxFile = path.len() as u32;
        dialog.lpstrTitle = title.as_ptr();
        dialog.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_HIDEREADONLY;

        if GetOpenFileNameW(&mut dialog) == 0 {
            let error = CommDlgExtendedError();
            if error == 0 { return Ok(None); }
            return Err(format!("Windows 文件选择器失败（代码 0x{error:08X}）"));
        }
        let end = path.iter().position(|unit| *unit == 0).unwrap_or(path.len());
        if end == 0 { return Err("没有选择应用路径".into()); }
        Ok(Some(std::ffi::OsString::from_wide(&path[..end]).to_string_lossy().into_owned()))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("应用选择器仅在 Windows 桌面端可用".into())
    }
}

#[tauri::command]
pub fn load_applications(app: AppHandle) -> Result<Option<Value>, String> {
    let path = app.path().app_data_dir().map_err(|error| error.to_string())?.join("applications.json");
    read_application_file(&path)
}

fn read_application_file(path: &Path) -> Result<Option<Value>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| "应用配置文件无法解析，原文件已保留".to_string())?;
            validate_application_config(&value)?;
            Ok(Some(value))
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取应用配置：{error}")),
    }
}

#[tauri::command]
pub fn save_applications(app: AppHandle, config: Value) -> Result<(), String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    save_application_file(&directory, &config)
}

fn validate_application_config(value: &Value) -> Result<(), String> {
    let apps = value.as_array().or_else(|| value.get("apps").and_then(Value::as_array));
    if apps.is_some_and(|apps| apps.iter().all(|app| app.get("name").and_then(Value::as_str).is_some_and(|name| !name.trim().is_empty()))) {
        Ok(())
    } else {
        Err("应用配置格式无效，原文件已保留".into())
    }
}

fn save_application_file(directory: &Path, config: &Value) -> Result<(), String> {
    // All windows use this lock; backup and replacement are one serialized operation.
    static SAVING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = SAVING.lock().map_err(|_| "应用配置保存失败，请重新打开应用".to_string())?;
    validate_application_config(config)?;
    fs::create_dir_all(directory).map_err(|error| format!("无法创建应用配置目录：{error}"))?;
    let path = directory.join("applications.json");
    // A damaged or unreadable source must never be overwritten by a different window.
    let previous = match fs::read(&path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| "原应用配置无法解析，已停止保存并保留原文件".to_string())?;
            validate_application_config(&value)?;
            Some(bytes)
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("无法读取原应用配置，已停止保存：{error}")),
    };
    let bytes = serde_json::to_vec_pretty(config).map_err(|_| "应用配置序列化失败".to_string())?;

    if let Some(apps) = config.get("apps").and_then(Value::as_array) {
        let mut icons = Vec::new();
        for item in apps {
            let id = item.get("id").and_then(Value::as_str).unwrap_or_default();
            let icon = item.get("icon").and_then(Value::as_str).unwrap_or_default();
            if let Some((extension, payload)) = embedded_icon(icon) {
                if let Some(bytes) = base64_decode(payload) {
                    let mut hasher = std::collections::hash_map::DefaultHasher::new();
                    id.hash(&mut hasher);
                    icons.push((format!("{:016x}.{extension}", hasher.finish()), bytes));
                }
            }
        }
        if !icons.is_empty() {
            let icon_directory = directory.join("icons");
            fs::create_dir_all(&icon_directory).map_err(|error| format!("无法创建应用图标目录：{error}"))?;
            for (name, bytes) in icons {
                fs::write(icon_directory.join(name), bytes).map_err(|error| format!("无法保存应用图标：{error}"))?;
            }
        }
    }
    if let Some(previous) = previous {
        replace_config_bytes(&directory.join("applications.previous.json"), &previous)
            .map_err(|error| format!("无法备份上一版应用配置，已停止保存：{error}"))?;
    }
    replace_config_bytes(&path, &bytes).map_err(|error| format!("应用配置保存失败，原文件已保留：{error}"))?;
    Ok(())
}

pub(crate) fn replace_config_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static NEXT_TEMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = NEXT_TEMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = path.with_file_name(format!(".applications-{}-{sequence}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_config_path(&temporary, path)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

#[cfg(windows)]
fn replace_config_path(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 {
        Err(std::io::Error::last_os_error())
    } else { Ok(()) }
}

#[cfg(not(windows))]
fn replace_config_path(source: &Path, target: &Path) -> std::io::Result<()> { fs::rename(source, target) }

fn embedded_icon(value: &str) -> Option<(&'static str, &str)> {
    [
        ("data:image/png;base64,", "png"),
        ("data:image/svg+xml;base64,", "svg"),
        ("data:image/x-icon;base64,", "ico"),
        ("data:image/vnd.microsoft.icon;base64,", "ico"),
    ].into_iter().find_map(|(prefix, extension)| value.strip_prefix(prefix).map(|payload| (extension, payload)))
}

fn base64_decode(value: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(value.len() * 3 / 4);
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    for character in value.bytes() {
        if character == b'=' { break; }
        let digit = match character {
            b'A'..=b'Z' => character - b'A',
            b'a'..=b'z' => character - b'a' + 26,
            b'0'..=b'9' => character - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'\r' | b'\n' => continue,
            _ => return None,
        };
        accumulator = (accumulator << 6) | digit as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(((accumulator >> bits) & 0xff) as u8);
            accumulator &= (1_u32 << bits) - 1;
        }
    }
    Some(output)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedApplication {
    id: String,
    name: String,
    icon: String,
    #[serde(rename = "type")]
    kind: String,
    target: String,
    category: String,
    source_path: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherApplication {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    target: String,
    #[serde(default)]
    arguments: String,
    #[serde(default)]
    process_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    status: String,
    process_name: Option<String>,
}

#[tauri::command]
pub fn scan_applications() -> Result<Vec<ScannedApplication>, String> {
    #[cfg(not(windows))]
    return Err("应用扫描仅支持 Windows 桌面应用".into());

    #[cfg(windows)]
    {
        let mut roots = Vec::new();
        push_env_root(&mut roots, "USERPROFILE", "Desktop", "桌面");
        push_env_root(&mut roots, "PUBLIC", "Desktop", "桌面");
        push_env_root(&mut roots, "APPDATA", "Microsoft/Windows/Start Menu/Programs", "开始菜单");
        push_env_root(&mut roots, "ProgramData", "Microsoft/Windows/Start Menu/Programs", "开始菜单");
        push_program_root(&mut roots, "ProgramFiles");
        push_program_root(&mut roots, "ProgramFiles(x86)");
        push_env_root(&mut roots, "LOCALAPPDATA", "Programs", "程序");

        let mut found = Vec::new();
        let mut seen = HashSet::new();
        for (root, category, max_depth) in roots {
            scan_directory(&root, &category, max_depth, 0, &mut seen, &mut found);
            if found.len() >= MAX_SCAN_RESULTS { break; }
        }
        found.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
        Ok(found)
    }
}

fn push_env_root(roots: &mut Vec<(PathBuf, String, usize)>, variable: &str, suffix: &str, category: &str) {
    if let Some(base) = env::var_os(variable) {
        roots.push((PathBuf::from(base).join(suffix), category.into(), if category == "程序" { 2 } else { 5 }));
    }
}

fn push_program_root(roots: &mut Vec<(PathBuf, String, usize)>, variable: &str) {
    if let Some(path) = env::var_os(variable) {
        roots.push((PathBuf::from(path), "程序".into(), 2));
    }
}

fn scan_directory(
    directory: &Path,
    category: &str,
    max_depth: usize,
    depth: usize,
    seen: &mut HashSet<String>,
    found: &mut Vec<ScannedApplication>,
) {
    if depth > max_depth || found.len() >= MAX_SCAN_RESULTS { return; }
    let entries = match fs::read_dir(directory) { Ok(entries) => entries, Err(_) => return };
    let mut children = Vec::new();
    for entry in entries.flatten() {
        if found.len() >= MAX_SCAN_RESULTS { return; }
        let path = entry.path();
        let file_type = match entry.file_type() { Ok(kind) => kind, Err(_) => continue };
        if file_type.is_dir() {
            if depth < max_depth { children.push(path); }
            continue;
        }
        if !file_type.is_file() { continue; }
        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default();
        let lower_extension = extension.to_ascii_lowercase();
        let target = match lower_extension.as_str() {
            "lnk" => path.to_string_lossy().to_string(),
            "exe" if category == "程序" => path.to_string_lossy().to_string(),
            "url" => match internet_shortcut_url(&path) { Some(url) => url, None => continue },
            _ => continue,
        };
        let key = target.to_lowercase();
        if !seen.insert(key) { continue; }
        let name = path.file_stem().and_then(|value| value.to_str()).unwrap_or("应用").trim();
        if name.is_empty() { continue; }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        path.to_string_lossy().to_lowercase().hash(&mut hasher);
        found.push(ScannedApplication {
            id: format!("scan-{:016x}", hasher.finish()),
            name: name.to_string(),
            icon: String::new(),
            kind: if lower_extension == "lnk" { "shortcut" } else if lower_extension == "url" { "url" } else { "exe" }.into(),
            target,
            category: category.into(),
            source_path: path.to_string_lossy().to_string(),
        });
    }
    children.sort();
    for child in children {
        if found.len() >= MAX_SCAN_RESULTS { break; }
        scan_directory(&child, category, max_depth, depth + 1, seen, found);
    }
}

fn internet_shortcut_url(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let target = text.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        key.trim().eq_ignore_ascii_case("URL").then(|| value.trim().to_string())
    })?;
    (target.starts_with("https://") || target.starts_with("http://")).then_some(target)
}

#[tauri::command]
pub fn open_application(application: LauncherApplication) -> Result<LaunchResult, String> {
    validate_launch(&application)?;
    #[cfg(not(windows))]
    return Err("应用启动仅支持 Windows 桌面应用".into());
    #[cfg(windows)]
    std::thread::spawn(move || {
        // Shell extensions and shortcut metadata need an STA. Keep it off the UI thread.
        use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
        let initialized = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32 | COINIT_DISABLE_OLE1DDE as u32) };
        if initialized < 0 { return Err("Windows 启动接口初始化失败".into()); }
        struct Apartment;
        impl Drop for Apartment { fn drop(&mut self) { unsafe { CoUninitialize() } } }
        let _apartment = Apartment;
        launch_native(&application)
    }).join().map_err(|_| "Windows 启动任务失败".to_string())?
}

fn validate_launch(application: &LauncherApplication) -> Result<(), String> {
    let target = application.target.trim();
    if target.is_empty() { return Err("应用目标路径为空，请先在应用管理中配置路径".into()); }
    if !["exe", "shortcut", "url", "command"].contains(&application.kind.as_str()) {
        return Err("不支持的应用类型".into());
    }
    if [target, application.arguments.as_str()].iter().any(|value| value.contains('\0') || value.encode_utf16().count() > 32767) {
        return Err("应用路径或参数无效".into());
    }
    if application.kind == "url" && !tauri::Url::parse(target).is_ok_and(|url| matches!(url.scheme(), "http" | "https")) {
        return Err("网址只支持 http 或 https 地址".into());
    }
    Ok(())
}

#[cfg(windows)]
fn wide_text(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }

#[cfg(windows)]
fn shortcut_target(path: &str) -> Option<(String, String)> {
    use windows::{core::{Interface, PCWSTR}, Win32::{
        System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ},
        UI::Shell::{IShellLinkW, ShellLink},
    }};
    let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.ok()?;
    let file: IPersistFile = link.cast().ok()?;
    let path = wide_text(path);
    unsafe { file.Load(PCWSTR(path.as_ptr()), STGM_READ) }.ok()?;
    let mut target = vec![0u16; 32768];
    unsafe { link.GetPath(&mut target, std::ptr::null_mut(), 0) }.ok()?;
    let text = |bytes: &[u16]| String::from_utf16_lossy(&bytes[..bytes.iter().position(|unit| *unit == 0).unwrap_or(bytes.len())]);
    let target = text(&target);
    if target.is_empty() { return None; }
    let mut directory = vec![0u16; 32768];
    let _ = unsafe { link.GetWorkingDirectory(&mut directory) };
    Some((target, text(&directory)))
}

#[cfg(windows)]
fn normalized_launch_path(value: &str) -> String {
    let path = Path::new(value).canonicalize().ok().map(|path| path.to_string_lossy().into_owned()).unwrap_or_else(|| value.into());
    path.trim_start_matches("\\\\?\\").replace('/', "\\").to_lowercase()
}

#[cfg(windows)]
fn activate_existing(target:&str)->Result<bool,String>{
    use windows_sys::Win32::{Foundation::{CloseHandle,HWND,LPARAM},System::Threading::{OpenProcess,QueryFullProcessImageNameW,PROCESS_QUERY_LIMITED_INFORMATION},UI::WindowsAndMessaging::{EnumWindows,GetWindow,GetWindowThreadProcessId,IsIconic,IsWindowVisible,SetForegroundWindow,ShowWindowAsync,GW_OWNER,SW_RESTORE}};
    if !Path::new(target).is_absolute(){return Ok(false);}
    struct Search{target:String,window:HWND}
    unsafe extern "system" fn visit(window:HWND,context:LPARAM)->i32{
        if IsWindowVisible(window)==0||!GetWindow(window,GW_OWNER).is_null(){return 1;}
        let search=&mut*(context as *mut Search);let mut pid=0;GetWindowThreadProcessId(window,&mut pid);
        let process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,0,pid);if process.is_null(){return 1;}
        let mut buffer=vec![0u16;32768];let mut length=buffer.len() as u32;
        let ok=QueryFullProcessImageNameW(process,0,buffer.as_mut_ptr(),&mut length);CloseHandle(process);
        if ok!=0&&normalized_launch_path(&String::from_utf16_lossy(&buffer[..length as usize]))==search.target{search.window=window;return 0;}1
    }
    let mut search=Search{target:normalized_launch_path(target),window:std::ptr::null_mut()};
    unsafe{EnumWindows(Some(visit),&mut search as *mut _ as LPARAM)};
    if search.window.is_null(){return Ok(false);}
    unsafe{if IsIconic(search.window)!=0{ShowWindowAsync(search.window,SW_RESTORE);}if SetForegroundWindow(search.window)!=0{return Ok(true);}}
    // Do not spawn a duplicate or force foreground rights when Windows refuses focus.
    Err("应用已在运行，Windows 未允许切换到前台，请从任务栏打开".into())
}

#[cfg(windows)]
fn shell_open(target: &str, arguments: &str, directory: Option<&str>) -> Result<(), String> {
    use windows_sys::Win32::{Foundation::GetLastError, UI::{
        Shell::{ShellExecuteExW, SHELLEXECUTEINFOW, SEE_MASK_NOASYNC, SEE_MASK_UNICODE, SEE_MASK_FLAG_NO_UI},
        WindowsAndMessaging::SW_SHOWNORMAL,
    }};
    let verb = wide_text("open");
    let target = wide_text(target);
    let arguments = wide_text(arguments);
    let directory = directory.map(wide_text);
    let mut request: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    request.cbSize = std::mem::size_of_val(&request) as u32;
    // Suppress generic file-open error dialogs; normal security/elevation prompts remain enabled.
    request.fMask = SEE_MASK_NOASYNC | SEE_MASK_UNICODE | SEE_MASK_FLAG_NO_UI;
    request.lpVerb = verb.as_ptr();
    request.lpFile = target.as_ptr();
    request.lpParameters = if arguments.len() > 1 { arguments.as_ptr() } else { std::ptr::null() };
    request.lpDirectory = directory.as_ref().map_or(std::ptr::null(), |path| path.as_ptr());
    request.nShow = SW_SHOWNORMAL;
    if unsafe { ShellExecuteExW(&mut request) } != 0 { return Ok(()); }
    let code = unsafe { GetLastError() };
    Err(match code {
        225 | 226 => format!("Windows 安全防护阻止了该应用（代码 {code}），请查看防护记录"),
        1223 => "已取消启动或权限确认".into(),
        _ => format!("Windows 无法启动该入口（代码 {code}）"),
    })
}

#[cfg(windows)]
fn launch_native(application: &LauncherApplication) -> Result<LaunchResult, String> {
    let target = application.target.trim();
    let shortcut = if application.kind == "shortcut" && Path::new(target).extension().is_some_and(|ext| ext.eq_ignore_ascii_case("lnk")) {
        shortcut_target(target)
    } else { None };
    let executable = shortcut.as_ref().map(|(path, _)| path.as_str()).unwrap_or(target);
    let process_name = (!application.process_name.trim().is_empty()).then(|| application.process_name.clone())
        .or_else(|| Path::new(executable).file_stem().map(|stem| stem.to_string_lossy().into_owned()));
    if matches!(application.kind.as_str(), "exe" | "shortcut") && activate_existing(executable)? {
        return Ok(LaunchResult { status: "activated".into(), process_name });
    }
    match application.kind.as_str() {
        "command" => {
            let command = crate::network_tools::system_executable("cmd.exe")?;
            // A terminal is intentional only for an explicit user-configured command entry.
            shell_open(&command.to_string_lossy(), &format!("/d /s /c {target}"), None)?;
        },
        "shortcut" if !application.arguments.is_empty() => {
            let (path, directory) = shortcut.ok_or("该快捷方式无法解析自定义参数，请直接编辑快捷方式或选择 EXE")?;
            shell_open(&path, &application.arguments, (!directory.is_empty()).then_some(directory.as_str()))?;
        },
        _ => shell_open(target, &application.arguments, None)?,
    }
    Ok(LaunchResult { status: "launched".into(), process_name })
}

#[tauri::command]
pub fn reveal_application_target(target: String) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() || target.starts_with("http://") || target.starts_with("https://") {
        return Err("没有可显示的 Windows 文件位置".into());
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("explorer.exe");
        if Path::new(target).is_file() { command.arg("/select,").arg(target); }
        else { command.arg(target); }
        command.spawn().map(|_| ()).map_err(|error| format!("无法打开所在位置：{error}"))
    }
    #[cfg(not(windows))]
    Err("打开文件位置仅支持 Windows 桌面应用".into())
}

pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        result.push(TABLE[(first >> 2) as usize] as char);
        result.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        result.push(if chunk.len() > 1 { TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char } else { '=' });
        result.push(if chunk.len() > 2 { TABLE[(third & 0x3f) as usize] as char } else { '=' });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{base64_decode, base64_encode, embedded_icon, internet_shortcut_url, read_application_file, save_application_file};
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

    struct ConfigDirectory(std::path::PathBuf);
    impl ConfigDirectory {
        fn new() -> Self {
            let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("application-config-test-{}-{unique}", std::process::id()));
            fs::create_dir(&path).unwrap(); Self(path)
        }
    }
    impl Drop for ConfigDirectory { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn config(name: &str) -> serde_json::Value { serde_json::json!({"version":2,"apps":[{"id":"test","name":name,"icon":"","type":"exe","target":"mock.exe","pinned":true,"order":0}]}) }

    fn application(kind: &str, target: &str, arguments: &str) -> super::LauncherApplication {
        super::LauncherApplication { name: "launch test".into(), kind: kind.into(), target: target.into(), arguments: arguments.into(), process_name: String::new() }
    }

    #[test]
    fn launch_rejects_invalid_targets_before_starting_any_process() {
        for entry in [application("exe", " ", ""), application("invalid", "app.exe", ""),
            application("exe", "bad\0.exe", ""), application("exe", "app.exe", "bad\0arg"),
            application("url", "file:///C:/app.exe", ""), application("url", "javascript:alert(1)", ""),
            application("exe", &"a".repeat(32768), "")] {
            assert!(super::validate_launch(&entry).is_err());
        }
        assert!(super::validate_launch(&application("url", "https://example.test/path", "")).is_ok());
        assert!(super::validate_launch(&application("exe", "C:\\测试 空格\\app.exe", r#""two words" "$literal; & value""#)).is_ok());
    }

    /// Opt-in Windows acceptance: only launches the disposable GUI fixture supplied by the developer.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn native_launch_acceptance() {
        use windows::{core::{Interface, PCWSTR}, Win32::{System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER}, UI::Shell::{IShellLinkW, ShellLink}}};
        let directory = std::path::PathBuf::from(std::env::var_os("GLEAMDESK_LAUNCH_FIXTURE").expect("set owned fixture directory"));
        let executable = directory.join("launch fixture.exe");
        assert!(executable.is_file());
        for name in ["direct.txt", "duplicate.txt", "shortcut.txt", "override.txt"] {
            match fs::remove_file(directory.join(name)) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => panic!("cannot reset owned fixture record: {error}"),
            }
        }
        let wait_record = |name: &str| {
            let record = directory.join(name);
            for _ in 0..100 { if let Ok(text) = fs::read_to_string(&record) { if text.lines().count() >= 4 { return text; } } std::thread::sleep(std::time::Duration::from_millis(100)); }
            panic!("fixture did not report: {name}");
        };
        let args = |name: &str, seconds: u32| format!(r#""{}" "two words" "$literal; & value" {seconds}"#, directory.join(name).display());
        let direct = application("exe", &executable.to_string_lossy(), &args("direct.txt", 4));
        assert_eq!(super::open_application(direct).unwrap().status, "launched");
        let record = wait_record("direct.txt");
        assert_eq!(record.lines().nth(1), Some("two words"));
        assert_eq!(record.lines().nth(2), Some("$literal; & value"));
        let repeated = super::open_application(application("exe", &executable.to_string_lossy(), &args("duplicate.txt", 4)));
        match repeated { Ok(result) => assert_eq!(result.status, "activated"), Err(error) => assert!(error.contains("应用已在运行"), "{error}") }
        assert!(!directory.join("duplicate.txt").exists(), "repeat click must not launch another instance");
        std::thread::sleep(std::time::Duration::from_secs(5));
        let shortcut = directory.join("快捷方式 fixture.lnk");
        unsafe {
            assert!(windows_sys::Win32::System::Com::CoInitializeEx(std::ptr::null(), 6) >= 0);
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
            link.SetPath(PCWSTR(super::wide_text(&executable.to_string_lossy()).as_ptr())).unwrap();
            link.SetWorkingDirectory(PCWSTR(super::wide_text(&directory.to_string_lossy()).as_ptr())).unwrap();
            link.SetArguments(PCWSTR(super::wide_text(&args("shortcut.txt", 4)).as_ptr())).unwrap();
            let file: IPersistFile = link.cast().unwrap();
            file.Save(PCWSTR(super::wide_text(&shortcut.to_string_lossy()).as_ptr()), true).unwrap();
            let (resolved, working_directory) = super::shortcut_target(&shortcut.to_string_lossy()).unwrap();
            assert_eq!(super::normalized_launch_path(&resolved), super::normalized_launch_path(&executable.to_string_lossy()));
            assert_eq!(super::normalized_launch_path(&working_directory), super::normalized_launch_path(&directory.to_string_lossy()));
            drop(file); drop(link);
            windows_sys::Win32::System::Com::CoUninitialize();
        }
        assert_eq!(super::open_application(application("shortcut", &shortcut.to_string_lossy(), "")).unwrap().status, "launched");
        assert!(wait_record("shortcut.txt").lines().last().unwrap().eq_ignore_ascii_case(&directory.to_string_lossy()));
        std::thread::sleep(std::time::Duration::from_secs(5));
        assert_eq!(super::open_application(application("shortcut", &shortcut.to_string_lossy(), &args("override.txt", 90))).unwrap().status, "launched");
        assert!(wait_record("override.txt").contains("two words"));
        assert!(super::open_application(application("exe", &directory.join("missing.exe").to_string_lossy(), "")).is_err());
    }

    #[test]
    fn application_config_preserves_previous_version_and_schema() {
        let dir = ConfigDirectory::new();
        save_application_file(&dir.0, &config("第一版")).unwrap();
        let first = fs::read(dir.0.join("applications.json")).unwrap();
        assert!(!dir.0.join("applications.previous.json").exists());
        save_application_file(&dir.0, &config("第二版")).unwrap();
        assert_eq!(fs::read(dir.0.join("applications.previous.json")).unwrap(), first);
        let second = fs::read(dir.0.join("applications.json")).unwrap();
        save_application_file(&dir.0, &config("第三版")).unwrap();
        assert_eq!(fs::read(dir.0.join("applications.previous.json")).unwrap(), second);
        assert_eq!(read_application_file(&dir.0.join("applications.json")).unwrap(), Some(config("第三版")));
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
    }

    #[test]
    fn application_config_corrupt_source_is_never_overwritten() {
        let dir = ConfigDirectory::new(); let path = dir.0.join("applications.json");
        for invalid in [b"broken json".as_slice(), br#"{"apps":null}"#, br#"{"apps":[{"name":""}]}"#] {
            fs::write(&path, invalid).unwrap();
            assert!(read_application_file(&path).is_err());
            assert!(save_application_file(&dir.0, &config("new")).is_err());
            assert_eq!(fs::read(&path).unwrap(), invalid);
            assert!(!dir.0.join("applications.previous.json").exists());
        }
    }

    #[test]
    fn application_config_backup_failure_leaves_original_intact() {
        let dir = ConfigDirectory::new(); save_application_file(&dir.0, &config("old")).unwrap();
        let before = fs::read(dir.0.join("applications.json")).unwrap();
        fs::create_dir(dir.0.join("applications.previous.json")).unwrap();
        assert!(save_application_file(&dir.0, &config("new")).unwrap_err().contains("无法备份"));
        assert_eq!(fs::read(dir.0.join("applications.json")).unwrap(), before);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
    }

    #[cfg(windows)]
    #[test]
    fn application_config_locked_destination_reports_failure_and_keeps_original() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = ConfigDirectory::new(); let path = dir.0.join("applications.json");
        save_application_file(&dir.0, &config("old")).unwrap();
        let before = fs::read(&path).unwrap();
        let lock = fs::OpenOptions::new().read(true).share_mode(1).open(&path).unwrap();
        assert!(save_application_file(&dir.0, &config("new")).unwrap_err().contains("保存失败"));
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(fs::read(dir.0.join("applications.previous.json")).unwrap(), before);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
        drop(lock);
    }

    #[test]
    fn base64_encodes_utf8_and_padding() {
        assert_eq!(base64_encode(b"Codex"), "Q29kZXg=");
        assert_eq!(base64_encode("桌面".as_bytes()), "5qGM6Z2i");
        assert_eq!(base64_decode("Q29kZXg="), Some(b"Codex".to_vec()));
        assert_eq!(base64_decode("%%%"), None);
    }

    #[test]
    fn recognizes_only_embedded_portable_icons() {
        assert_eq!(embedded_icon("data:image/png;base64,AA=="), Some(("png", "AA==")));
        assert_eq!(embedded_icon("C:\\icons\\codex.png"), None);
    }

    #[test]
    fn reads_http_url_from_internet_shortcut() {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("codex-desktop-{suffix}.url"));
        fs::write(&path, "[InternetShortcut]\nURL=https://example.test/console\n").unwrap();
        assert_eq!(internet_shortcut_url(&path).as_deref(), Some("https://example.test/console"));
        let _ = fs::remove_file(path);
    }
}

#[cfg(windows)]
pub(crate) fn open_public_url(value:&str)->Result<(),String>{
    let url=tauri::Url::parse(value).map_err(|_|"OAuth授权网址无效")?;
    if url.scheme()!="https"||!matches!(url.host_str(),Some("accounts.google.com"|"login.microsoftonline.com"))||!url.username().is_empty()||url.password().is_some(){return Err("OAuth授权目标不在官方白名单中".into());}
    let operation:Vec<u16>="open".encode_utf16().chain(Some(0)).collect();let target:Vec<u16>=value.encode_utf16().chain(Some(0)).collect();
    let result=unsafe{windows_sys::Win32::UI::Shell::ShellExecuteW(std::ptr::null_mut(),operation.as_ptr(),target.as_ptr(),std::ptr::null(),std::ptr::null(),1)} as isize;
    if result>32{Ok(())}else{Err("无法打开系统浏览器，请检查默认浏览器配置".into())}
}
