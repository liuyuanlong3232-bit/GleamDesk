use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State, Webview};

const MAX_PROMPT_CHARS: usize = 8_000;
const MAX_OUTPUT_CHARS: usize = 80_000;
const MAX_LINE_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Agent {
    Codex,
    Claude,
    Antigravity,
    Opencode,
}

impl Agent {
    fn id(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Antigravity => "antigravity",
            Self::Opencode => "opencode",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude Code",
            Self::Antigravity => "Antigravity",
            Self::Opencode => "OpenCode",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        match id {
            "codex" => Some(Self::Codex),
            "claude" => Some(Self::Claude),
            "antigravity" => Some(Self::Antigravity),
            "opencode" => Some(Self::Opencode),
            _ => None,
        }
    }

    fn executable(self) -> &'static str {
        match self {
            Self::Codex => "codex.exe",
            Self::Claude => "claude.exe",
            Self::Antigravity => "agy.exe",
            Self::Opencode => "opencode.exe",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskProvider {
    id: &'static str,
    name: &'static str,
    available: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTaskRequest {
    task_id: String,
    agent: String,
    directory: String,
    prompt: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentTaskEvent {
    task_id: String,
    agent: String,
    status: &'static str,
    output: Option<String>,
    diagnostic: Option<String>,
    exit_code: Option<i32>,
    message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskReceipt {
    task_id: String,
    agent: String,
    status: &'static str,
    exit_code: Option<i32>,
}

#[derive(Default)]
pub struct AgentTaskState {
    active: Arc<Mutex<Option<ActiveTask>>>,
}

#[derive(Clone)]
struct ActiveTask {
    id: String,
    cancelled: Arc<AtomicBool>,
}

struct ActiveGuard {
    active: Arc<Mutex<Option<ActiveTask>>>,
    id: String,
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            if active.as_ref().is_some_and(|task| task.id == self.id) {
                *active = None;
            }
        }
    }
}

#[derive(Clone, Copy)]
enum StreamKind {
    Output,
    Diagnostic,
}

struct StreamLine {
    kind: StreamKind,
    text: String,
    truncated: bool,
}

fn require_dashboard(view: &Webview) -> Result<(), String> {
    if view.label() == "dashboard" {
        Ok(())
    } else {
        Err("本机 Agent 任务只能从工作区启动".into())
    }
}

fn executable(agent: Agent) -> Option<PathBuf> {
    let name = agent.executable();
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).take(64).map(|path| path.join(name)).collect())
        .unwrap_or_default();

    if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        candidates.extend([
            home.join(".local/bin").join(name),
            home.join("AppData/Local/Programs").join(name),
        ]);
        if agent == Agent::Codex {
            let root = home.join("AppData/Local/OpenAI/Codex/bin");
            if let Ok(entries) = std::fs::read_dir(root) {
                let mut versions: Vec<_> = entries
                    .take(32)
                    .filter_map(Result::ok)
                    .map(|entry| entry.path().join(name))
                    .filter(|path| path.is_file())
                    .collect();
                versions.sort_by_key(|path| {
                    std::fs::metadata(path).and_then(|metadata| metadata.modified()).ok()
                });
                versions.reverse();
                candidates.extend(versions);
            }
        }
    }
    if agent == Agent::Antigravity {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            candidates.push(local.join("agy/bin").join(name));
        }
    }
    candidates.into_iter().find(|path| path.is_absolute() && path.is_file())
}

#[tauri::command]
pub fn agent_task_list(view: Webview) -> Result<Vec<AgentTaskProvider>, String> {
    require_dashboard(&view)?;
    Ok([Agent::Codex, Agent::Claude, Agent::Antigravity, Agent::Opencode]
        .into_iter()
        .map(|agent| AgentTaskProvider {
            id: agent.id(),
            name: agent.name(),
            available: executable(agent).is_some(),
        })
        .collect())
}

#[tauri::command]
pub fn agent_task_pick_directory(view: Webview, app: AppHandle) -> Result<Option<String>, String> {
    require_dashboard(&view)?;
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::{
            System::Com::CoTaskMemFree,
            UI::Shell::{
                SHBrowseForFolderW, SHGetPathFromIDListW, BROWSEINFOW, BIF_NEWDIALOGSTYLE,
                BIF_RETURNONLYFSDIRS,
            },
        };

        let owner = app
            .get_window("dashboard")
            .and_then(|window| window.hwnd().ok().map(|handle| handle.0))
            .unwrap_or(std::ptr::null_mut());
        let title: Vec<u16> = "选择本机 Agent 的工作目录\0".encode_utf16().collect();
        let mut display = vec![0u16; 32_768];
        let dialog = BROWSEINFOW {
            hwndOwner: owner,
            pidlRoot: std::ptr::null_mut(),
            pszDisplayName: display.as_mut_ptr(),
            lpszTitle: title.as_ptr(),
            ulFlags: BIF_NEWDIALOGSTYLE | BIF_RETURNONLYFSDIRS,
            lpfn: None,
            lParam: 0,
            iImage: 0,
        };
        let selected = SHBrowseForFolderW(&dialog);
        if selected.is_null() {
            return Ok(None);
        }
        let mut path = vec![0u16; 32_768];
        let valid = SHGetPathFromIDListW(selected, path.as_mut_ptr());
        CoTaskMemFree(selected.cast());
        if valid == 0 {
            return Err("Windows 无法读取所选目录".into());
        }
        let end = path.iter().position(|unit| *unit == 0).unwrap_or(path.len());
        if end == 0 {
            return Err("没有选择工作目录".into());
        }
        Ok(Some(std::ffi::OsString::from_wide(&path[..end]).to_string_lossy().into_owned()))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("目录选择器仅在 Windows 桌面端可用".into())
    }
}

fn validate_request(request: &AgentTaskRequest) -> Result<(Agent, PathBuf), String> {
    if request.task_id.is_empty()
        || request.task_id.len() > 80
        || !request.task_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("任务标识无效".into());
    }
    let agent = Agent::from_id(&request.agent).ok_or("没有选择可用的 Agent")?;
    let prompt = request.prompt.trim();
    if prompt.is_empty() || prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err("任务说明不能为空，且最多 8000 字".into());
    }
    let directory = Path::new(request.directory.trim())
        .canonicalize()
        .map_err(|_| "工作目录不存在或无法读取")?;
    if !directory.is_dir() {
        return Err("工作目录必须是一个文件夹".into());
    }
    Ok((agent, directory))
}

fn command_args(agent: Agent, prompt: &str, directory: &Path) -> Vec<String> {
    let directory = directory.to_string_lossy().into_owned();
    match agent {
        Agent::Codex => vec![
            "exec".into(),
            "--json".into(),
            "--cd".into(),
            directory,
            prompt.into(),
        ],
        Agent::Claude => vec![
            "-p".into(),
            prompt.into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
        ],
        Agent::Antigravity => vec![
            "-p".into(),
            prompt.into(),
            "--output-format".into(),
            "stream-json".into(),
        ],
        Agent::Opencode => vec![
            "run".into(),
            "--format".into(),
            "json".into(),
            "--dir".into(),
            directory,
            prompt.into(),
        ],
    }
}

#[tauri::command]
pub async fn agent_task_run(
    view: Webview,
    app: AppHandle,
    state: State<'_, AgentTaskState>,
    request: AgentTaskRequest,
) -> Result<AgentTaskReceipt, String> {
    require_dashboard(&view)?;
    crate::simulation::require_live()?;
    let (agent, directory) = validate_request(&request)?;
    let exe = executable(agent).ok_or_else(|| format!("没有找到 {} CLI；请先自行安装并登录，再重新打开 GleamDesk", agent.name()))?;
    let active = state.active.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut slot = active.lock().map_err(|_| "本机 Agent 状态不可用")?;
        if slot.is_some() {
            return Err("已有一项本机 Agent 任务正在运行".into());
        }
        *slot = Some(ActiveTask { id: request.task_id.clone(), cancelled: cancelled.clone() });
    }

    let task_id = request.task_id.clone();
    let prompt = request.prompt.trim().to_owned();
    let agent_name = agent.name().to_owned();
    let app_for_task = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = ActiveGuard { active, id: task_id.clone() };
        run_task(app_for_task, agent, exe, directory, task_id, prompt, cancelled)
    })
    .await
    .map_err(|_| "本机 Agent 任务意外中断")?;

    result.map(|(status, exit_code)| AgentTaskReceipt {
        task_id: request.task_id,
        agent: agent_name,
        status,
        exit_code,
    })
}

#[tauri::command]
pub fn agent_task_cancel(
    view: Webview,
    state: State<'_, AgentTaskState>,
    task_id: String,
) -> Result<(), String> {
    require_dashboard(&view)?;
    let active = state.active.lock().map_err(|_| "本机 Agent 状态不可用")?;
    if let Some(task) = active.as_ref().filter(|task| task.id == task_id) {
        task.cancelled.store(true, Ordering::SeqCst);
    }
    Ok(())
}

fn emit(app: &AppHandle, event: AgentTaskEvent) {
    let _ = app.emit_to("dashboard", "agent-task-event", event);
}

fn run_task(
    app: AppHandle,
    agent: Agent,
    exe: PathBuf,
    directory: PathBuf,
    task_id: String,
    prompt: String,
    cancelled: Arc<AtomicBool>,
) -> Result<(&'static str, Option<i32>), String> {
    emit(&app, AgentTaskEvent {
        task_id: task_id.clone(), agent: agent.id().into(), status: "running",
        output: None, diagnostic: None, exit_code: None, message: None,
    });

    let mut child = Command::new(&exe)
        .args(command_args(agent, &prompt, &directory))
        .current_dir(&directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| format!("无法启动 {} CLI；请确认安装和登录状态", agent.name()))?;

    let (sender, receiver) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        let sender = sender.clone();
        thread::spawn(move || read_stream(stdout, StreamKind::Output, sender));
    }
    if let Some(stderr) = child.stderr.take() {
        let sender = sender.clone();
        thread::spawn(move || read_stream(stderr, StreamKind::Diagnostic, sender));
    }
    drop(sender);

    let mut output = String::new();
    let mut diagnostics = String::new();
    let mut child_status: Option<ExitStatus> = None;
    let mut cancelled_by_user = false;
    let mut streamed_text = false;
    let mut truncated_line = false;

    loop {
        if cancelled.load(Ordering::SeqCst) && child_status.is_none() {
            cancelled_by_user = true;
            let _ = child.kill();
        }

        match receiver.recv_timeout(Duration::from_millis(80)) {
            Ok(line) => {
                if line.truncated && !truncated_line {
                    truncated_line = true;
                    emit(&app, AgentTaskEvent {
                        task_id: task_id.clone(), agent: agent.id().into(), status: "running",
                        output: None, diagnostic: Some("客户端输出中有过长行，已截短".into()),
                        exit_code: None, message: None,
                    });
                }
                let is_output = matches!(line.kind, StreamKind::Output);
                let text = extract_text(agent, line.kind, &line.text, &mut streamed_text);
                let Some(text) = text.filter(|text| !text.is_empty()) else { continue };
                let target = if is_output { &mut output } else { &mut diagnostics };
                let room = MAX_OUTPUT_CHARS.saturating_sub(target.chars().count());
                if room == 0 { continue; }
                let piece: String = text.chars().take(room).collect();
                target.push_str(&piece);
                let (output, diagnostic) = if is_output { (Some(piece), None) } else { (None, Some(piece)) };
                emit(&app, AgentTaskEvent {
                    task_id: task_id.clone(), agent: agent.id().into(), status: "running",
                    output, diagnostic,
                    exit_code: None, message: None,
                });
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if child_status.is_some() { break; }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        if child_status.is_none() {
            child_status = child.try_wait().map_err(|_| "无法读取本机 Agent 任务状态")?;
        }
    }

    let exit_status = match child_status {
        Some(status) => status,
        None => child.wait().map_err(|_| "无法等待本机 Agent 任务结束")?,
    };
    let exit_code = exit_status.code();
    let status = if cancelled_by_user {
        "cancelled"
    } else if exit_status.success() {
        "completed"
    } else {
        "failed"
    };
    let message = if status == "failed" && diagnostics.trim().is_empty() {
        Some(format!("{} 退出码：{}", agent.name(), exit_code.map_or("未知".into(), |code| code.to_string())))
    } else {
        None
    };
    emit(&app, AgentTaskEvent {
        task_id: task_id.clone(), agent: agent.id().into(), status,
        output: None, diagnostic: None, exit_code, message,
    });
    Ok((status, exit_code))
}

fn read_stream<R: std::io::Read + Send + 'static>(mut reader: R, kind: StreamKind, sender: mpsc::Sender<StreamLine>) {
    let mut chunk = [0u8; 4096];
    let mut line = Vec::new();
    let mut truncated = false;
    loop {
        let count = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        for byte in &chunk[..count] {
            if *byte == b'\n' {
                let text = String::from_utf8_lossy(&line).trim_end_matches('\r').to_owned();
                if sender.send(StreamLine { kind, text, truncated }).is_err() { return; }
                line.clear();
                truncated = false;
            } else if line.len() < MAX_LINE_BYTES {
                line.push(*byte);
            } else {
                truncated = true;
            }
        }
    }
    if !line.is_empty() || truncated {
        let text = String::from_utf8_lossy(&line).trim_end_matches('\r').to_owned();
        let _ = sender.send(StreamLine { kind, text, truncated });
    }
}

fn extract_text(agent: Agent, kind: StreamKind, line: &str, streamed_text: &mut bool) -> Option<String> {
    if line.trim().is_empty() { return None; }
    if matches!(kind, StreamKind::Diagnostic) {
        let clean = clean_text(line);
        return (!clean.is_empty()).then_some(clean + "\n");
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        let clean = clean_text(line);
        return (!clean.is_empty()).then_some(clean + "\n");
    };

    let (text, final_text) = match agent {
        Agent::Codex => {
            if value["type"] == "item.completed" && value["item"]["type"] == "agent_message" {
                (value["item"]["text"].as_str().map(str::to_owned), true)
            } else if value["type"] == "item.delta" && value["item"]["type"] == "agent_message" {
                (value["delta"].as_str().map(str::to_owned), false)
            } else {
                (None, false)
            }
        }
        Agent::Claude => {
            if value["type"] == "stream_event" && value["event"]["delta"]["type"] == "text_delta" {
                (value["event"]["delta"]["text"].as_str().map(str::to_owned), false)
            } else if value["type"] == "result" {
                (value["result"].as_str().map(str::to_owned), true)
            } else {
                (None, false)
            }
        }
        Agent::Antigravity => {
            if value["event"] == "step_update" && value["step_update"]["step_type"] == "agent_response" {
                (value["step_update"]["text_delta"].as_str().map(str::to_owned), false)
            } else if value["event"] == "result" {
                (value["result"]["response"].as_str().map(str::to_owned), true)
            } else {
                (None, false)
            }
        }
        Agent::Opencode => {
            if value["type"] == "text" {
                (value["part"]["text"].as_str().map(str::to_owned).or_else(|| value["text"].as_str().map(str::to_owned)), false)
            } else {
                (None, false)
            }
        }
    };
    if final_text && *streamed_text { return None; }
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        *streamed_text = true;
        Some(text)
    } else {
        None
    }
}

fn clean_text(line: &str) -> String {
    line.chars().filter(|character| !character.is_control() || *character == '\t').collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_agent_gets_its_documented_noninteractive_command() {
        let directory = Path::new("C:\\my project");
        let prompt = "inspect this folder";
        assert_eq!(command_args(Agent::Codex, prompt, directory), ["exec", "--json", "--cd", "C:\\my project", prompt]);
        assert_eq!(command_args(Agent::Claude, prompt, directory), ["-p", prompt, "--output-format", "stream-json", "--verbose"]);
        assert_eq!(command_args(Agent::Antigravity, prompt, directory), ["-p", prompt, "--output-format", "stream-json"]);
        assert_eq!(command_args(Agent::Opencode, prompt, directory), ["run", "--format", "json", "--dir", "C:\\my project", prompt]);
    }

    #[test]
    fn prompts_are_passed_as_single_arguments_and_not_shell_fragments() {
        let prompt = "inspect & report `$(whoami)`";
        for agent in [Agent::Codex, Agent::Claude, Agent::Antigravity, Agent::Opencode] {
            assert!(command_args(agent, prompt, Path::new("C:\\work")).contains(&prompt.to_string()));
        }
    }

    #[test]
    fn antigravity_streaming_text_and_final_fallback_are_parsed() {
        let mut streamed = false;
        let delta = r#"{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"working"}}"#;
        assert_eq!(extract_text(Agent::Antigravity, StreamKind::Output, delta, &mut streamed).as_deref(), Some("working"));
        let result = r#"{"event":"result","result":{"response":"working"}}"#;
        assert!(extract_text(Agent::Antigravity, StreamKind::Output, result, &mut streamed).is_none());
        let mut empty = false;
        assert_eq!(extract_text(Agent::Antigravity, StreamKind::Output, result, &mut empty).as_deref(), Some("working"));
    }

    #[test]
    fn each_adapter_extracts_only_its_assistant_text() {
        let mut streamed = false;
        let codex = r#"{"type":"item.completed","item":{"type":"agent_message","text":"codex reply"}}"#;
        assert_eq!(extract_text(Agent::Codex, StreamKind::Output, codex, &mut streamed).as_deref(), Some("codex reply"));

        let mut streamed = false;
        let claude = r#"{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"claude reply"}}}"#;
        assert_eq!(extract_text(Agent::Claude, StreamKind::Output, claude, &mut streamed).as_deref(), Some("claude reply"));

        let mut streamed = false;
        let opencode = r#"{"type":"text","part":{"text":"opencode reply"}}"#;
        assert_eq!(extract_text(Agent::Opencode, StreamKind::Output, opencode, &mut streamed).as_deref(), Some("opencode reply"));
    }
}
