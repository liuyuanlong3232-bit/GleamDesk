use std::{collections::{HashMap, VecDeque}, sync::{Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{AppHandle, Emitter, Manager, Window};
use crate::provider_requests::{observed_unix_ms, RequestMetrics};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibilityChange { label: String, visible: bool, at_unix_ms: u64 }
#[derive(Default)]
struct VisibilityHistory { current: HashMap<String, bool>, changes: VecDeque<VisibilityChange> }
#[derive(Default)]
pub struct VisibilityDiagnostics(Mutex<VisibilityHistory>);
#[derive(Default)]
pub struct HiddenWindowCheck(AtomicBool);

pub fn record_visibility(app: &AppHandle, label: &str, visible: bool) {
    if !matches!(label, "main" | "dashboard") { return; }
    let state = app.state::<VisibilityDiagnostics>();
    if let Ok(mut history) = state.0.lock() {
        if history.current.get(label) == Some(&visible) { return; }
        history.current.insert(label.to_string(), visible);
        if history.changes.len() == 16 { history.changes.pop_front(); }
        history.changes.push_back(VisibilityChange { label: label.to_string(), visible, at_unix_ms: observed_unix_ms() });
    };
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowDemand { label: &'static str, visible: bool }
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderMetrics { id: &'static str, metrics: Option<RequestMetrics> }
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDiagnostics {
    observed_at_unix_ms: u64,
    windows: Vec<WindowDemand>,
    visibility_changes: VecDeque<VisibilityChange>,
    providers: Vec<ProviderMetrics>,
    debug_checks_available: bool,
}

#[tauri::command]
pub fn provider_request_diagnostics(app: AppHandle) -> ProviderDiagnostics {
    let windows = ["main", "dashboard"].into_iter().map(|label| {
        let visible = app.get_window(label).is_some_and(|window| crate::window_visible(window));
        WindowDemand { label, visible }
    }).collect();
    let [deepseek, anthropic, openai] = app.state::<crate::api_usage::ApiUsageState>().metrics();
    let providers = vec![
        ProviderMetrics { id: "windows-health", metrics: app.state::<crate::windows::eventlog::EventLogState>().metrics() },
        ProviderMetrics { id: "vps-status", metrics: app.state::<crate::beszel::BeszelState>().metrics() },
        ProviderMetrics { id: "api-deepseek", metrics: deepseek },
        ProviderMetrics { id: "api-anthropic", metrics: anthropic },
        ProviderMetrics { id: "api-openai", metrics: openai },
        ProviderMetrics { id: "agent-quotas", metrics: app.state::<crate::agent_usage::AgentUsageState>().metrics() },
        ProviderMetrics { id: "ollama-local", metrics: app.state::<crate::ollama::OllamaState>().metrics() },
    ];
    let visibility_changes = app.state::<VisibilityDiagnostics>().0.lock().ok().map(|history| history.changes.clone()).unwrap_or_default();
    ProviderDiagnostics { observed_at_unix_ms: observed_unix_ms(), windows, visibility_changes, providers, debug_checks_available: cfg!(debug_assertions) }
}

struct RestoreWindows { app: AppHandle, windows: Vec<Window>, caller: Window }
impl Drop for RestoreWindows {
    fn drop(&mut self) {
        for window in &self.windows {
            let _ = window.show();
            let visible = crate::window_visible(window.clone());
            let _ = window.emit_to(window.label(), "window-visibility-changed", visible);
        }
        let _ = crate::restore_window_positions(&self.app);
        let _ = self.caller.set_focus();
        self.app.state::<HiddenWindowCheck>().0.store(false, Ordering::SeqCst);
    }
}

/// Debug-only, bounded UI acceptance action. It preserves preferences and restores
/// only windows that were visible before the check, including on early failure.
#[tauri::command]
pub async fn check_hidden_window_refresh(app: AppHandle, window: Window, scope: String) -> Result<(), String> {
    if !cfg!(debug_assertions) || !matches!(window.label(), "main" | "dashboard") || !crate::window_visible(window.clone()) {
        return Err("仅调试构建的可见窗口可执行显隐检查".into());
    }
    let labels = match scope.as_str() {
        "dashboard" => vec!["dashboard"],
        "both" => vec!["main", "dashboard", "dock"],
        _ => return Err("显隐检查范围无效".into()),
    };
    if app.state::<HiddenWindowCheck>().0.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("已有显隐检查正在执行".into());
    }
    let windows = labels.into_iter().filter_map(|label| app.get_window(label)).filter(|candidate| crate::window_visible(candidate.clone())).collect();
    let restore = RestoreWindows { app, windows, caller: window };
    tauri::async_runtime::spawn_blocking(move || {
        for window in &restore.windows {
            window.hide().map_err(|_| "无法隐藏检查窗口".to_string())?;
            record_visibility(&restore.app, window.label(), false);
            let _ = window.emit_to(window.label(), "window-visibility-changed", false);
        }
        std::thread::sleep(Duration::from_secs(75));
        drop(restore);
        Ok(())
    }).await.map_err(|_| "显隐检查任务失败".to_string())?
}
