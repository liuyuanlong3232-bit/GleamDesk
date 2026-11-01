#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod storage;
mod app_updates;
mod wallpaper;
mod beszel;
mod vps_services;
mod windows;
mod launcher;
mod application_runtime;
mod hardware;
#[cfg(windows)]
mod gpu;
mod notifications;
mod credentials;
mod api_usage;
mod analysis;
mod analysis_history;
mod provider_requests;
mod provider_diagnostics;
mod cli_reader;
mod agent_usage;
mod doubao_membership;
mod ollama;
mod desktop_ingress;
mod dock_window;
mod window_regions;
mod webapps;
#[cfg(windows)]
mod webapp_metadata;
mod agent_room;
mod simulation;
mod network_tools;
mod dns_api;
#[cfg(windows)]
mod tls_tool;
#[cfg(windows)]
mod windows_runtime;
mod agriculture;
mod public_sources;
mod worldbank;
mod conab;
mod argentina;
mod custom_http;
mod daily_recommendations;
mod mail;
#[cfg(windows)]
mod mail_display;
#[cfg(windows)]
mod mail_imap;
#[cfg(windows)]
mod mail_oauth;
#[cfg(all(test, windows))]
#[allow(dead_code, unexpected_cfgs)]
#[path = "../../vendor/wry/src/webview2/drag_drop.rs"]
mod native_drop_bridge_tests;
#[cfg(all(test, windows))]
pub use wry::DragDropEvent;
#[cfg(windows)]
mod http;

use std::{path::PathBuf, sync::{Mutex, atomic::{AtomicBool, Ordering}}};
use tauri::{AppHandle, Emitter, Manager, Monitor, WebviewUrl, Window, WebviewWindowBuilder, WindowEvent};

#[derive(Default)]
struct DesktopMode(AtomicBool);
#[derive(Default)]
struct PassthroughEscapeReady(AtomicBool);
#[derive(Default)]
struct WindowOperations(Mutex<()>);
#[derive(Default)]
struct DashboardOnPrimary(AtomicBool);

#[tauri::command]
fn window_visible(window: Window) -> bool {
    let visible = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
    provider_diagnostics::record_visibility(window.app_handle(), window.label(), visible);
    visible
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorSummary {
    id: String,
    name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
    is_primary: bool,
}

#[tauri::command]
fn list_monitors(app: AppHandle) -> Result<Vec<MonitorSummary>, String> {
    let monitors = app.available_monitors().map_err(|error| error.to_string())?;
    let primary_position = app.primary_monitor().map_err(|error| error.to_string())?.map(|monitor| *monitor.position());

    Ok(monitors.into_iter().enumerate().map(|(index, monitor)| {
        let position = monitor.position();
        let size = monitor.size();
        let name = monitor.name().cloned().unwrap_or_else(|| format!("显示器 {}", index + 1));
        MonitorSummary {
            id: format!("{}-{}-{}", name, position.x, position.y),
            name,
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            scale_factor: monitor.scale_factor(),
            is_primary: primary_position == Some(*position),
        }
    }).collect())
}

fn target_monitors(app: &AppHandle) -> Result<(Vec<Monitor>, Option<Monitor>, Option<Monitor>), String> {
    let monitors = app.available_monitors().map_err(|error| error.to_string())?;
    let primary = app.primary_monitor().map_err(|error| error.to_string())?;
    let primary_position = primary.as_ref().map(|monitor| *monitor.position());
    let secondary = monitors.iter().find(|monitor| Some(*monitor.position()) != primary_position).cloned();
    Ok((monitors, primary, secondary))
}

fn place_on_monitor(window: &Window, monitor: &Monitor) -> Result<(), String> {
    let position = *monitor.position();
    let size = *monitor.size();
    if window.outer_position().ok() != Some(position) {
        window.set_position(position).map_err(|error| error.to_string())?;
    }
    if window.inner_size().ok() != Some(size) {
        window.set_size(size).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn restore_window_positions(app: &AppHandle) -> Result<(), String> {
    let (_, primary, secondary) = target_monitors(app)?;
    if let Some(dock) = app.get_window("dock") {
        let size = dock.inner_size().map_err(|error| error.to_string())?;
        let scale = dock.scale_factor().map_err(|error| error.to_string())?;
        dock_window::position_dock_window(app.clone(), size.width as f64 / scale, size.height as f64 / scale)?;
    }
    if let Some(monitor) = primary.as_ref() {
        if let Some(main) = app.get_window("main") {
            place_on_monitor(&main, monitor)?;
        }
    }
    if let Some(dashboard) = app.get_window("dashboard") {
        let on_primary = app.state::<DashboardOnPrimary>().0.load(Ordering::Relaxed);
        if let Some(monitor) = if on_primary { primary.as_ref() } else { secondary.as_ref().or(primary.as_ref()) } {
            place_on_monitor(&dashboard, monitor)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn restore_windows(app: AppHandle) -> Result<(), String> {
    restore_window_positions(&app)
}

#[tauri::command]
fn set_desktop_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    let was_desktop_mode = app.state::<DesktopMode>().0.swap(enabled, Ordering::Relaxed);
    if let Some(main) = app.get_window("main") {
        main.set_always_on_bottom(enabled).map_err(|error| error.to_string())?;
        if was_desktop_mode && !enabled { main.set_focus().map_err(|error| error.to_string())?; }
    }
    // Keep the control console reachable above normal windows when it is opened.
    if let Some(dashboard) = app.get_window("dashboard") {
        dashboard.set_always_on_bottom(false).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_mouse_passthrough(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    if enabled && !app.state::<PassthroughEscapeReady>().0.load(Ordering::Relaxed) {
        if let Some(main) = app.get_window("main") { main.set_ignore_cursor_events(false).map_err(|error| error.to_string())?; }
        return Err("鼠标穿透未开启：Ctrl + Shift + Space 退出键不可用或被其他程序占用".into());
    }
    if let Some(main) = app.get_window("main") {
        main.set_ignore_cursor_events(enabled).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn runtime_status() -> &'static str {
    "Rust command bridge ready"
}

fn dashboard_url() -> Result<WebviewUrl, String> {
    Ok(WebviewUrl::App(PathBuf::from("dashboard.html")))
}

// Limit this shortcut policy to the three local UI webviews. Embedded websites
// and account login windows keep their own browser and accessibility behavior.
fn configure_workbench_text_input(view: tauri::Webview) -> Result<(), String> {
    #[cfg(windows)]
    view.with_webview(|platform| {
        let callback = webview2_com::AcceleratorKeyPressedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                let mut key = 0_u32;
                unsafe { args.VirtualKey(&mut key)?; }
                if key == 0x76 { // VK_F7: prevent accidental caret browsing toggles.
                    unsafe { args.SetHandled(true)?; }
                }
            }
            Ok(())
        }));
        let mut token = 0_i64;
        if unsafe { platform.controller().add_AcceleratorKeyPressed(&callback, &mut token) }.is_err() {
            eprintln!("Workbench F7 guard could not be registered");
        }
    }).map_err(|_| "工作台文字光标快捷键保护设置失败".to_string())?;
    #[cfg(not(windows))]
    let _ = view;
    Ok(())
}

fn create_dashboard(app: AppHandle) -> Result<(), String> {
    let operations = app.state::<WindowOperations>();
    let _guard = operations.0.lock().map_err(|_| "窗口创建状态不可用".to_string())?;
    let (monitors, primary, secondary) = target_monitors(&app)?;
    let on_primary = app.state::<DashboardOnPrimary>().0.load(Ordering::Relaxed);
    let target = if on_primary { primary.as_ref() } else { secondary.as_ref().or(primary.as_ref()) };
    if let Some(window) = app.get_window("dashboard") {
        if let Some(monitor) = target { place_on_monitor(&window, monitor)?; }
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        let _ = window.emit_to(window.label(), "window-visibility-changed", window_visible(window.clone()));
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(&app, "dashboard", dashboard_url()?)
        .title("GleamDesk · 工作台")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true);
    if let Some(monitor) = target {
        let scale = monitor.scale_factor();
        builder = builder
            .position(monitor.position().x as f64 / scale, monitor.position().y as f64 / scale)
            .inner_size(monitor.size().width as f64 / scale, monitor.size().height as f64 / scale);
    }
    let window = builder.build().map_err(|error| format!("无法打开工作台：{error}"))?;
    if let Some(view) = app.get_webview("dashboard") {
        if configure_workbench_text_input(view).is_err() { eprintln!("Dashboard F7 guard setup failed"); }
    }
    let _ = window.emit_to(window.label(), "window-visibility-changed", window_visible(window.as_ref().window()));
    if on_primary || monitors.len() < 2 { window.set_focus().map_err(|error| error.to_string())?; }
    Ok(())
}

#[tauri::command]
async fn open_dashboard(app: AppHandle, primary: Option<bool>) -> Result<(), String> {
    if let Some(primary) = primary { app.state::<DashboardOnPrimary>().0.store(primary, Ordering::Relaxed); }
    // WebView2 creation must run outside synchronous command handlers on Windows.
    tauri::async_runtime::spawn_blocking(move || create_dashboard(app)).await.map_err(|_| "窗口创建任务失败".to_string())?
}

#[tauri::command]
fn show_main(app: AppHandle) -> Result<(), String> {
    if let Some(dock) = app.get_window("dock") { dock.show().map_err(|error| error.to_string())?; }
    if let Some(dashboard) = app.get_window("dashboard") {
        dashboard.hide().map_err(|error| error.to_string())?;
        provider_diagnostics::record_visibility(&app, dashboard.label(), false);
        let _ = dashboard.emit_to(dashboard.label(), "window-visibility-changed", false);
    }
    if let Some(main) = app.get_window("main") {
        main.show().map_err(|error| error.to_string())?;
        main.set_focus().map_err(|error| error.to_string())?;
        let _ = main.emit_to(main.label(), "window-visibility-changed", window_visible(main.clone()));
    }
    Ok(())
}

fn startup_visibility(mode: &str, show_main: bool, show_dashboard: bool) -> (bool, bool) {
    match mode {
        "dashboard" => (false, true),
        "custom" => (show_main, show_dashboard),
        _ => (true, false),
    }
}

#[tauri::command]
async fn apply_startup_preferences(app: AppHandle, mode: String, show_main: bool, show_dashboard: bool, desktop_mode: bool) -> Result<(), String> {
    set_desktop_mode(app.clone(), desktop_mode)?;
    let (main_visible, dashboard_visible) = startup_visibility(&mode, show_main, show_dashboard);
    if let Some(dock) = app.get_window("dock") {
        if main_visible { dock.show().map_err(|error| error.to_string())?; } else { dock.hide().map_err(|error| error.to_string())?; }
    }
    if main_visible {
        if let Some(main) = app.get_window("main") { main.show().map_err(|error| error.to_string())?; let _ = main.emit_to(main.label(), "window-visibility-changed", window_visible(main.clone())); }
    } else if let Some(main) = app.get_window("main") { main.hide().map_err(|error| error.to_string())?; provider_diagnostics::record_visibility(&app, main.label(), false); let _ = main.emit_to(main.label(), "window-visibility-changed", false); }

    if dashboard_visible { open_dashboard(app.clone(), None).await?; }
    else if let Some(dashboard) = app.get_window("dashboard") { dashboard.hide().map_err(|error| error.to_string())?; provider_diagnostics::record_visibility(&app, dashboard.label(), false); let _ = dashboard.emit_to(dashboard.label(), "window-visibility-changed", false); }
    restore_window_positions(&app)
}

#[cfg(test)]
mod startup_preference_tests {
    use super::startup_visibility;
    #[test]
    fn default_and_legacy_desktop_start_only_hud_and_dock() {
        for mode in ["desktop", "main", "", "unknown"] {
            assert_eq!(startup_visibility(mode, false, true), (true, false));
        }
    }
    #[test]
    fn explicit_dashboard_and_custom_preferences_are_preserved() {
        assert_eq!(startup_visibility("dashboard", true, false), (false, true));
        for main in [false, true] {
            for dashboard in [false, true] {
                assert_eq!(startup_visibility("custom", main, dashboard), (main, dashboard));
            }
        }
    }
    #[test]
    fn default_startup_has_no_monitor_count_dependency() {
        let body = include_str!("lib.rs").split_once("async fn apply_startup_preferences(").unwrap().1.split("#[cfg(test)]").next().unwrap();
        assert!(body.contains("startup_visibility(&mode, show_main, show_dashboard)"));
        assert!(!body.contains("target_monitors") && !body.contains("monitors.len()"));
        assert!(body.contains("if dashboard_visible { open_dashboard"));
    }
}

fn may_quit_application(label:&str,confirmed:bool)->bool{confirmed&&matches!(label,"dock"|"main"|"dashboard")}
#[tauri::command]
fn quit_app(app:AppHandle,view:tauri::Webview,confirmed:bool)->Result<(),String>{
    if !may_quit_application(view.label(),confirmed){return Err("请从本机菜单确认退出程序".into());}
    app.exit(0);Ok(())
}
#[cfg(test)]mod application_exit_tests{
    #[test]fn exit_requires_local_window_and_confirmation(){for label in ["dock","main","dashboard"]{assert!(super::may_quit_application(label,true));assert!(!super::may_quit_application(label,false));}for label in ["remote-1","","muse"]{assert!(!super::may_quit_application(label,true));}}
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_updates::AppUpdateState::default())
        .manage(DesktopMode::default())
        .manage(PassthroughEscapeReady::default())
        .manage(WindowOperations::default())
        .manage(DashboardOnPrimary::default())
        .manage(provider_diagnostics::VisibilityDiagnostics::default())
        .manage(provider_diagnostics::HiddenWindowCheck::default())
        .manage(hardware::HardwareSampler::default())
        .manage(api_usage::ApiUsageState::default())
        .manage(agent_usage::AgentUsageState::default())
        .manage(ollama::OllamaState::default())
        .manage(analysis::AnalysisState::default())
        .manage(beszel::BeszelState::default())
        .manage(vps_services::ServiceState::default())
        .manage(windows::eventlog::EventLogState::default())
        .manage(application_runtime::ApplicationRuntimeState::default())
        .manage(webapps::WebAppPool::default())
        .manage(agent_room::AgentRoomState::default())
        .manage(custom_http::CustomHttpState::default())
        .manage(public_sources::PublicSourceState::default())
        .manage(agriculture::AgricultureState::default())
        .manage(agriculture::Jin10NewsState::default())
        .manage(daily_recommendations::DailyState::default())
        .manage(mail_oauth::OAuthState::default())
        .invoke_handler(|invoke: tauri::ipc::Invoke| {
            let view=invoke.message.webview_ref();
            let trusted=["main","dashboard","dock"].contains(&view.label()) && view.url().map(|url|webapps::trusted_local_origin(view.label(),&url,cfg!(debug_assertions))).unwrap_or(false);
            if !trusted {
                #[cfg(debug_assertions)] if view.label().starts_with("remote-"){webapps::REMOTE_DENIED.fetch_add(1,Ordering::Relaxed);}
                invoke.resolver.reject("远程网页没有本机命令权限");return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            simulation::set_simulation_mode,
            beszel::read_vps_location,
            webapps::webapp_mount,
            network_tools::network_tool_run,
            dns_api::dns_api_compare,
            custom_http::read_custom_http_source,
            public_sources::read_public_weather,
            public_sources::read_builtin_public_source,
            public_sources::fetch_public_github_trending,
            daily_recommendations::save_public_daily_recommendations,
            agriculture::read_agriculture_snapshot,
            agriculture::load_snapshot_connection,
            agriculture::save_snapshot_connection,
            agriculture::read_jin10_news,
            daily_recommendations::read_daily_recommendations,
            daily_recommendations::generate_daily_recommendations,
            daily_recommendations::read_mimo_usage,
            daily_recommendations::mimo_connection_status,
            daily_recommendations::mimo_balance_open,
            daily_recommendations::mimo_balance_connect,
            doubao_membership::doubao_membership_open,
            doubao_membership::read_doubao_membership,
            mail::mail_configured,
            mail::mail_save_authorization,
            mail::mail_disconnect,
            mail::mail_read_snapshot,
            mail::mail_read_detail,
            mail::mail_mark_read,
            mail_oauth::mail_oauth_connect,
            mail_oauth::mail_oauth_cancel,
            agent_room::agent_room_chat_load,
            agent_room::workspace::agent_room_workspace_load,
            agent_room::workspace::agent_room_workspace_save_room,
            agent_room::workspace::agent_room_workspace_configure,
            agent_room::workspace::agent_room_workspace_enable_paid,
            agent_room::workspace::agent_room_workspace_save_limits,
            agent_room::workspace::agent_room_workspace_send,
            agent_room::agent_room_chat_send,
            agent_room::agent_room_chat_pause,
            agent_room::agent_room_chat_enable_paid,
            agent_room::agent_room_reply,
            agent_room::agent_room_cancel,
            webapps::webapp_release,
            webapps::webapp_discard,
            webapps::webapp_set_covered,
            webapps::webapp_navigate,
            #[cfg(debug_assertions)]
            webapps::webapp_security_probe,
            list_monitors,
            dock_window::position_dock_window,
            window_regions::set_main_window_hit_regions,
            window_regions::set_dock_window_hit_regions,
            window_visible,
            quit_app,
            open_dashboard,
            show_main,
            restore_windows,
            set_desktop_mode,
            set_mouse_passthrough,
            apply_startup_preferences,
            windows::read_windows_desktop_settings,
            windows::set_windows_autostart,
            windows::set_windows_desktop_icons,
            runtime_status,
            app_updates::check_app_update,
            app_updates::install_app_update,
            application_runtime::read_application_statuses,
            provider_diagnostics::provider_request_diagnostics,
            provider_diagnostics::check_hidden_window_refresh,
            launcher::scan_applications,
            desktop_ingress::extract_original_app_icons,
            launcher::open_application,
            launcher::reveal_application_target,
            launcher::load_applications,
            launcher::save_applications,
            launcher::pick_application_target,
            beszel::save_beszel_token,
            beszel::has_beszel_token,
            beszel::inspect_beszel_token,
            beszel::connect_beszel_account,
            beszel::clear_beszel_token,
            beszel::fetch_beszel_snapshot,
            beszel::ensure_local_beszel_hub,
            vps_services::load_vps_services,
            vps_services::save_vps_services,
            vps_services::vps_service_token,
            vps_services::read_vps_service,
            vps_services::read_xui_details,
            vps_services::read_sing_box_details,
            vps_services::read_tailscale_details,
            credentials::credential_save,
            credentials::credential_exists,
            credentials::credential_clear,
            credentials::credential_legacy_available,
            credentials::credential_import_legacy,
            api_usage::read_api_usage,
            agent_usage::read_agent_usage,
            agent_usage::read_codex_activity,
            agent_usage::read_agent_runtime,
            ollama::read_ollama_status,
            ollama::read_ollama_model_info,
            ollama::open_ollama_terminal,
            analysis::analyze_history_remote,
            analysis::cancel_history_analysis,
            windows::eventlog::read_windows_events,
            storage::storage_insert,
            storage::storage_query,
            storage::storage_query_range,
            storage::storage_count,
            storage::storage_delete,
            storage::storage_prune,
            wallpaper::read_wallpaper_profile,
            hardware::read_hardware_snapshot,
            notifications::notification_apply,
            notifications::notification_state,
            notifications::notification_acknowledge
        ];
            handler(invoke)
        })
        .on_window_event(|window, event| {
            if window.label() == "dock" && matches!(event, WindowEvent::Focused(true)) {
                if let Some(dock) = window.app_handle().get_webview_window("dock") { let _ = dock_window::place_below_apps(&dock); }
            }
            if matches!(event, WindowEvent::Focused(_) | WindowEvent::Resized(_)) {
                let visible = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
                provider_diagnostics::record_visibility(window.app_handle(), window.label(), visible);
                let _ = window.emit_to(window.label(), "window-visibility-changed", visible);
            }
            if window.label() == "dock" && matches!(event, WindowEvent::ScaleFactorChanged { .. }) {
                let _ = restore_window_positions(&window.app_handle());
            }
            if ["main","dashboard"].contains(&window.label()) && matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }) {
                let _ = restore_window_positions(&window.app_handle());
            }
        })
        .setup(|app| {
            // Install before either transparent desktop window becomes visible.
            for label in ["main", "dock"] {
                if let Some(window) = app.handle().get_window(label) {
                    window_regions::install_borderless_guard(&window)?;
                }
            }
            if let Some(main) = app.handle().get_window("main") {
                match window_regions::install_passthrough_escape(&main) {
                    Ok(()) => app.state::<PassthroughEscapeReady>().0.store(true, Ordering::Relaxed),
                    Err(error) => eprintln!("{error}"),
                }
            }
            for label in ["main", "dock"] {
                if let Some(view) = app.handle().get_webview(label) {
                    if configure_workbench_text_input(view).is_err() { eprintln!("Workbench F7 guard setup failed"); }
                }
            }
            if let Some(main) = app.handle().get_window("main") {
                if let Some(monitor) = app.handle().primary_monitor()? { let _ = place_on_monitor(&main, &monitor); }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running GleamDesk");
}
