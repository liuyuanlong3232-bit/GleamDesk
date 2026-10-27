use crate::provider_requests::RequestCache;
use semver::Version;
use serde::Serialize;
use serde_json::Value;
use std::{sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

const REPOSITORY: &str = "https://github.com/liuyuanlong3232-bit/GleamDesk";
const PUBLIC_KEY: &str = include_str!("../updater-public-key.txt");

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Release {
    version: String,
    tag: String,
    notes: String,
    release_url: String,
    signed_assets: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    latest_version: String,
    newer: bool,
    can_install: bool,
    notes: String,
    release_url: String,
    install_hint: String,
}
#[derive(Default)]
pub struct AppUpdateState {
    cache: RequestCache<(), Release>,
    installing: Arc<AtomicBool>,
}
struct InstallGuard(Arc<AtomicBool>);
impl Drop for InstallGuard { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }

fn stable_version(value: &str) -> Result<Version, String> {
    let version = Version::parse(value.strip_prefix('v').unwrap_or(value)).map_err(|_| "发布版本号无效")?;
    if !version.pre.is_empty() || !version.build.is_empty() { return Err("仅检查正式发布版本".into()); }
    Ok(version)
}
fn parse_release(value: &Value) -> Result<Release, String> {
    if value["draft"].as_bool() != Some(false) || value["prerelease"].as_bool() != Some(false) { return Err("不是正式发布版本".into()); }
    let tag = value["tag_name"].as_str().filter(|s| s.len() < 80).ok_or("发布版本缺失")?;
    let version = stable_version(tag)?;
    let release_url = format!("{REPOSITORY}/releases/tag/{tag}");
    if value["html_url"].as_str() != Some(&release_url) { return Err("发布页面来源不符".into()); }
    let assets = value["assets"].as_array().ok_or("发布附件缺失")?;
    let has = |name: &str| assets.iter().any(|asset| {
        asset["name"].as_str() == Some(name)
            && asset["browser_download_url"].as_str() == Some(&format!("{REPOSITORY}/releases/download/{tag}/{name}"))
            && asset["size"].as_u64().is_some_and(|n| n > 0 && n <= 256 * 1024 * 1024)
    });
    let installer = format!("GleamDesk_{version}_x64-setup.exe");
    Ok(Release { version: version.to_string(), tag: tag.into(), release_url,
        notes: value["body"].as_str().unwrap_or("").chars().take(2000).collect(),
        signed_assets: has("latest.json") && has(&installer) && has(&format!("{installer}.sig")),
    })
}
fn status(release: &Release, current: &str, installed: bool) -> Result<UpdateStatus, String> {
    let newer = stable_version(&release.version)? > Version::parse(current).map_err(|_| "当前版本号无效")?;
    let can_install = newer && installed && release.signed_assets;
    let install_hint = if !newer { "" }
        else if !installed { "便携版或开发版请到发布页手动下载；安装版支持应用内更新。" }
        else if !release.signed_assets { "此版本尚未提供完整的签名更新附件，请到发布页下载。" }
        else { "安装前请保存输入；确认后会关闭 Dock、HUD 和工作台并更新程序，保留配置和历史。" };
    Ok(UpdateStatus { current_version: current.into(), latest_version: release.version.clone(), newer,
        can_install, notes: release.notes.clone(), release_url: release.release_url.clone(), install_hint: install_hint.into() })
}
#[cfg(windows)]
fn installed_copy() -> bool {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    if cfg!(debug_assertions) { return false; }
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let key = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GleamDesk");
    let name = wide("InstallLocation");
    let mut buffer = vec![0u16; 32768];
    let mut bytes = (buffer.len() * 2) as u32;
    let result = unsafe { RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ,
        std::ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut bytes) };
    if result != 0 || bytes as usize > buffer.len() * 2 { return false; }
    let length = buffer.iter().position(|&c| c == 0).unwrap_or(0);
    let folder = String::from_utf16_lossy(&buffer[..length]);
    let Ok(folder) = std::fs::canonicalize(folder.trim_matches('"')) else { return false; };
    let Ok(exe) = std::env::current_exe().and_then(std::fs::canonicalize) else { return false; };
    exe.parent().is_some_and(|parent| parent.to_string_lossy().eq_ignore_ascii_case(&folder.to_string_lossy()))
        && folder.join("uninstall.exe").is_file()
}
#[cfg(not(windows))]
fn installed_copy() -> bool { false }

#[tauri::command]
pub async fn check_app_update(app: tauri::AppHandle, state: tauri::State<'_, AppUpdateState>, force: Option<bool>) -> Result<UpdateStatus, String> {
    let permit = crate::simulation::require_live()?;
    let cache = state.cache.clone();
    let release = tauri::async_runtime::spawn_blocking(move || cache.read((),
        if force == Some(true) { Duration::ZERO } else { Duration::from_secs(3600) }, Duration::from_secs(15), || {
            permit.check()?;
            #[cfg(windows)] {
                let (code, bytes) = crate::http::anonymous_get("api.github.com", 443,
                    "/repos/liuyuanlong3232-bit/GleamDesk/releases/latest", &|| permit.check())?;
                permit.check()?;
                if code == 403 || code == 429 { return Err("GitHub 暂时限制请求，请稍后再检查".into()); }
                if code != 200 { return Err("暂时无法读取 GitHub 正式发布信息".into()); }
                let value = serde_json::from_slice(&bytes).map_err(|_| "GitHub 发布信息格式无效")?;
                parse_release(&value)
            }
            #[cfg(not(windows))] { Err("此构建暂不支持版本检查".into()) }
        })).await.map_err(|_| "更新检查任务失败")??;
    let report = status(&release, &app.package_info().version.to_string(), installed_copy())?;
    let _ = app.emit("gleamdesk-update-checked", &report);
    Ok(report)
}
fn installation_allowed(release: &Release, current: &str, expected: &str, consent: bool, installed: bool) -> Result<(), String> {
    if !consent { return Err("请先保存输入并确认退出安装".into()); }
    let report = status(release, current, installed)?;
    if !report.newer || release.version != expected { return Err("目标版本已变化，请重新检查更新".into()); }
    if !report.can_install { return Err(report.install_hint); }
    Ok(())
}
#[tauri::command]
pub async fn install_app_update(app: tauri::AppHandle, state: tauri::State<'_, AppUpdateState>, expected_version: String, consent: bool) -> Result<(), String> {
    let permit = crate::simulation::require_live()?;
    if !consent { return Err("请先保存输入并确认退出安装".into()); }
    if state.installing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() { return Err("更新已在进行中".into()); }
    let _guard = InstallGuard(state.installing.clone());
    // The cached selection is obtained natively; the UI cannot supply a URL or signature.
    let cache = state.cache.clone();
    let release = tauri::async_runtime::spawn_blocking(move || cache.read((), Duration::from_secs(3600), Duration::ZERO,
        || Err("请先检查更新".into()))).await.map_err(|_| "更新信息读取失败")??;
    installation_allowed(&release, &app.package_info().version.to_string(), &expected_version, consent, installed_copy())?;
    permit.check()?;
    let endpoint = format!("{REPOSITORY}/releases/download/{}/latest.json", release.tag).parse().map_err(|_| "更新地址无效")?;
    let updater = app.updater_builder().pubkey(PUBLIC_KEY.trim()).endpoints(vec![endpoint]).map_err(|_| "更新配置无效")?
        .timeout(Duration::from_secs(120)).configure_client(|client| client.https_only(true)).build().map_err(|_| "更新配置不可用")?;
    let update = updater.check().await.map_err(|_| "签名更新信息读取失败，请到发布页手动下载")?.ok_or("已无可安装更新，请重新检查")?.restart_after_install(true);
    let expected_url = format!("{REPOSITORY}/releases/download/{}/GleamDesk_{}_x64-setup.exe", release.tag, release.version);
    if update.version != expected_version || update.download_url.as_str() != expected_url { return Err("更新附件与已检查版本不一致，已停止".into()); }
    permit.check()?;
    let progress_app = app.clone();
    let mut received = 0u64;
    let mut previous_percent = 101;
    let bytes = update.download(move |chunk, length| {
        received = received.saturating_add(chunk as u64);
        let percent = length.filter(|&n| n > 0).map(|total| (received.saturating_mul(100) / total).min(100) as u32);
        if let Some(percent)=percent { if percent != previous_percent { previous_percent = percent; let _ = progress_app.emit("gleamdesk-update-progress", Some(percent)); } }
    }, || {}).await.map_err(|_| "下载或更新签名校验失败，当前版本未替换")?;
    permit.check()?;
    // The plugin verifies the signature and signed version again before invoking NSIS /UPDATE.
    update.install(bytes).map_err(|_| "无法启动更新安装器，当前版本未替换".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(version: &str, signed: bool) -> Value {
        let tag = format!("v{version}");
        let names = if signed { vec!["latest.json".into(), format!("GleamDesk_{version}_x64-setup.exe"), format!("GleamDesk_{version}_x64-setup.exe.sig")] } else { vec![] };
        serde_json::json!({"draft":false,"prerelease":false,"tag_name":tag,"html_url":format!("{REPOSITORY}/releases/tag/{tag}"),"body":"<script>plain text</script>",
          "assets":names.iter().map(|name|serde_json::json!({"name":name,"size":10,"browser_download_url":format!("{REPOSITORY}/releases/download/{tag}/{name}")})).collect::<Vec<_>>()})
    }
    #[test] fn stable_semver_handles_multi_digit_versions_and_rejects_previews(){
        assert!(stable_version("0.1.10").unwrap() > stable_version("v0.1.9").unwrap());
        for invalid in ["0.1", "0.2.0-beta.1", "0.2.0+build", "../../evil", "0.1.3/other"] { assert!(stable_version(invalid).is_err()); }
    }
    #[test] fn only_fixed_repository_and_complete_release_assets_enable_install(){
        let release = parse_release(&fixture("0.2.0", true)).unwrap();
        assert!(status(&release, "0.1.2", true).unwrap().can_install);
        assert!(!status(&release, "0.1.2", false).unwrap().can_install);
        assert!(!status(&release, "0.2.0", true).unwrap().newer);
        assert!(!status(&release, "0.3.0", true).unwrap().newer);
        assert!(!status(&parse_release(&fixture("0.2.0", false)).unwrap(), "0.1.2", true).unwrap().can_install);
        let mut value=fixture("0.2.0",true);value["assets"][0]["browser_download_url"]="https://evil.test/latest.json".into();
        assert!(!parse_release(&value).unwrap().signed_assets);
        value["html_url"]="https://evil.test/release".into();assert!(parse_release(&value).is_err());
    }
    #[test] fn prerelease_draft_missing_and_oversize_assets_are_not_installable(){
        for field in ["draft","prerelease"] { let mut value=fixture("0.2.0",true);value[field]=true.into();assert!(parse_release(&value).is_err()); }
        let mut value=fixture("0.2.0",true);value["assets"][1]["size"]=(257u64*1024*1024).into();assert!(!parse_release(&value).unwrap().signed_assets);
        value["assets"]=Value::Null;assert!(parse_release(&value).is_err());
    }
    #[test] fn installation_requires_consent_expected_newer_version_and_installed_copy(){
        let release=parse_release(&fixture("0.2.0",true)).unwrap();
        assert!(installation_allowed(&release,"0.1.2","0.2.0",true,true).is_ok());
        assert!(installation_allowed(&release,"0.1.2","0.2.0",false,true).is_err());
        assert!(installation_allowed(&release,"0.1.2","0.2.0",true,false).is_err());
        assert!(installation_allowed(&release,"0.1.2","0.3.0",true,true).is_err());
        assert!(installation_allowed(&release,"0.2.0","0.2.0",true,true).is_err());
    }
    #[test] fn installation_lock_releases_after_failure(){
        let flag=Arc::new(AtomicBool::new(true));{let _guard=InstallGuard(flag.clone());}assert!(!flag.load(Ordering::SeqCst));
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "one read-only GitHub request; no installation or user accounts"]
    fn github_release_metadata_without_installing(){
        let (code,bytes)=crate::http::anonymous_get("api.github.com",443,"/repos/liuyuanlong3232-bit/GleamDesk/releases/latest",&||Ok(())).unwrap();
        assert_eq!(code,200,"GitHub metadata unavailable, HTTP {code}");
        let release=parse_release(&serde_json::from_slice(&bytes).unwrap()).unwrap();
        let report=status(&release,env!("CARGO_PKG_VERSION"),false).unwrap();
        assert!(!report.can_install);
        println!("Public GitHub release: {}; newer: {}; signed assets: {}. No install.",release.version,report.newer,release.signed_assets);
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "verifies an explicitly supplied synthetic signed package; never installs"]
    fn signed_fixture_matches_embedded_public_key_and_rejects_tampering(){
        use base64::Engine;
        let directory=std::path::PathBuf::from(std::env::var_os("GLEAMDESK_UPDATER_FIXTURE").expect("synthetic fixture directory required"));
        let package=directory.join(format!("GleamDesk_{}_x64-setup.exe",env!("CARGO_PKG_VERSION")));
        let bytes=std::fs::read(&package).unwrap();
        assert_eq!(bytes,b"GleamDesk synthetic update verification fixture\n");
        let manifest:Value=serde_json::from_slice(&std::fs::read(directory.join("latest.json")).unwrap()).unwrap();
        let decode=|value:&str|String::from_utf8(base64::engine::general_purpose::STANDARD.decode(value.trim()).unwrap()).unwrap();
        let public_text=decode(PUBLIC_KEY);
        let key=minisign_verify::PublicKey::decode(&public_text).unwrap();
        let signature_text=decode(manifest["platforms"]["windows-x86_64"]["signature"].as_str().unwrap());
        let signature=minisign_verify::Signature::decode(&signature_text).unwrap();
        key.verify(&bytes,&signature,true).unwrap();
        assert!(signature.trusted_comment().split('\t').any(|field|field==format!("version:{}",env!("CARGO_PKG_VERSION"))));
        assert!(key.verify(b"tampered synthetic update",&signature,true).is_err());
        let mut changed_signature=signature_text.clone().into_bytes();
        let signature_start=changed_signature.iter().position(|&b|b==b'\n').unwrap()+1;
        changed_signature[signature_start+24]=if changed_signature[signature_start+24]==b'A'{b'B'}else{b'A'};
        let invalid=String::from_utf8(changed_signature).unwrap();
        assert!(minisign_verify::Signature::decode(&invalid).and_then(|signature|key.verify(&bytes,&signature,true)).is_err());
        let config:Value=serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["plugins"]["updater"]["pubkey"].as_str().unwrap(),PUBLIC_KEY.trim());
        assert_eq!(config["plugins"]["updater"]["requireSignedVersion"],true);
    }
}
