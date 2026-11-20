// Explicitly invoked Windows acceptance only. No production app setup, HTTP or credentials.
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use tauri_plugin_updater::UpdaterExt;

fn fixture_root() -> PathBuf {
    let expected = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../node_modules/.cache/upgrade-acceptance").canonicalize().unwrap();
    let supplied = PathBuf::from(std::env::var_os("GLEAMDESK_UPGRADE_ACCEPTANCE").expect("explicit fixture opt-in required"))
        .canonicalize().unwrap();
    assert_eq!(supplied, expected);
    expected
}

fn mock_updater(public_key: &str, installed_exe: &std::path::Path) -> tauri_plugin_updater::Updater {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = "org.gleamdesk.upgrade-acceptance".into();
    context.package_info_mut().name = "GleamDesk Upgrade Acceptance".into();
    context.package_info_mut().version = "0.1.2".parse().unwrap();
    context.config_mut().plugins.0.insert("updater".into(), json!({
        "pubkey":public_key, "requireSignedVersion":true, "allowDowngrades":false,
        "windows":{"installMode":"passive"}
    }));
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context).unwrap();
    app.updater_builder().pubkey(public_key).executable_path(installed_exe)
        .endpoints(vec!["https://example.invalid/never-requested.json".parse().unwrap()]).unwrap()
        .installer_arg("/NS").build().unwrap()
}

#[test]
#[ignore = "installs only the explicitly prepared independent synthetic NSIS fixture; exits this test process"]
fn isolated_nsis_upgrade_through_sdk() {
    let root = fixture_root();
    let marker: Value = serde_json::from_slice(&fs::read(root.join("prepared.json")).unwrap()).unwrap();
    assert_eq!(marker["product"], "GleamDesk Upgrade Acceptance");
    assert_eq!(marker["identifier"], "org.gleamdesk.upgrade-acceptance");
    let exe = root.join("installed/GleamDeskUpgradeFixture.exe");
    assert!(exe.is_file());
    let key = fs::read_to_string(root.join("fixture.key.pub")).unwrap();
    assert_ne!(key.trim(), super::PUBLIC_KEY.trim(), "fixture must never use production trust");
    let updater = mock_updater(key.trim(), &exe);
    let manifest: Value = serde_json::from_slice(&fs::read(root.join("latest.json")).unwrap()).unwrap();
    assert_eq!(manifest["version"], "0.1.3");
    assert_eq!(manifest["platforms"]["windows-x86_64"]["url"], "https://example.invalid/upgrade-fixture.exe");
    let update = updater.restore_update(manifest.clone()).unwrap().unwrap().restart_after_install(true);
    let bytes = fs::read(root.join("fixture-0.1.3-setup.exe")).unwrap();
    update.verify(&bytes).unwrap();
    let mut tampered = bytes.clone();
    tampered[512] ^= 1;
    assert!(update.verify(&tampered).is_err());
    let mut wrong_version = manifest;
    wrong_version["version"] = "9.0.0".into();
    assert!(updater.restore_update(wrong_version).unwrap().unwrap().verify(&bytes).is_err());
    fs::write(root.join("sdk-verified.json"), br#"{"signature":true,"tamperingRejected":true,"wrongVersionRejected":true,"networkRequests":0}"#).unwrap();
    // Windows SDK dispatches NSIS /P /UPDATE /R and exits. The controller must verify
    // the actual installed payload, registry version, restarted GUI and preserved data.
    update.install(bytes).unwrap();
    panic!("Windows updater unexpectedly returned without exiting");
}

#[test]
#[ignore = "verifies a prepared real release with the embedded production public key; never installs or downloads"]
fn prepared_release_signature_without_installing() {
    let root = PathBuf::from(std::env::var_os("GLEAMDESK_VERIFY_RELEASE").expect("explicit package directory required"));
    let manifest: Value = serde_json::from_slice(&fs::read(root.join("latest.json")).unwrap()).unwrap();
    let version = env!("CARGO_PKG_VERSION");
    let name = format!("GleamDesk_{version}_x64-setup.exe");
    assert_eq!(manifest["version"], version);
    assert_eq!(manifest["platforms"]["windows-x86_64"]["url"],
        format!("https://github.com/liuyuanlong3232-bit/GleamDesk/releases/download/v{version}/{name}"));
    let updater = mock_updater(super::PUBLIC_KEY.trim(), &root.join("GleamDesk-portable/GleamDesk.exe"));
    let update = updater.restore_update(manifest.clone()).unwrap().unwrap();
    let bytes = fs::read(root.join(name)).unwrap();
    update.verify(&bytes).unwrap();
    let mut tampered = bytes.clone(); tampered[512] ^= 1;
    assert!(update.verify(&tampered).is_err());
    let mut wrong = manifest; wrong["version"] = "9.0.0".into();
    assert!(updater.restore_update(wrong).unwrap().unwrap().verify(&bytes).is_err());
    println!("Prepared release {version}: actual SDK signature passed; tampering and version substitution rejected. No HTTP, no install.");
}
