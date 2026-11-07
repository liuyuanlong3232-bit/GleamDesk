use std::{io::{BufRead, BufReader, Read, Write}, path::Path, process::{Child, Command, Stdio}, sync::mpsc, time::{Duration, Instant}};
use serde_json::Value;

const MAX_OUTPUT: usize = 256 * 1024;

#[cfg(windows)]
struct ProcessJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Drop for ProcessJob { fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); } } }
struct Process(Child, #[cfg(windows)] Option<ProcessJob>);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        #[cfg(windows)] { drop(self.1.take()); }
        let _ = self.0.wait();
    }
}
fn spawn(mut command: Command) -> Result<Process, String> {
    let mut child = command.spawn().map_err(|_| "CLI 无法启动".to_string())?;
    #[cfg(windows)] {
        use std::{ffi::c_void, os::windows::io::AsRawHandle};
        use windows_sys::Win32::System::JobObjects::*;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() { let _ = child.kill(); let _ = child.wait(); return Err("CLI 进程隔离不可用".into()); }
        let job = ProcessJob(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe { SetInformationJobObject(handle, JobObjectExtendedLimitInformation, &limits as *const _ as *const c_void, std::mem::size_of_val(&limits) as u32) } == 0
            || unsafe { AssignProcessToJobObject(handle, child.as_raw_handle() as _) } == 0 {
            let _ = child.kill(); let _ = child.wait(); return Err("CLI 进程隔离不可用".into());
        }
        Ok(Process(child, Some(job)))
    }
    #[cfg(not(windows))] { Ok(Process(child)) }
}
fn command(path: &Path) -> Command {
    let mut command = Command::new(path);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW; never opens a terminal.
    }
    command
}

pub fn read_cli_json(path: &Path, args: &[&str], timeout: Duration) -> Result<Value, String> {
    read_cli_json_input(path, args, timeout, None)
}
pub fn read_cli_json_input(path: &Path, args: &[&str], timeout: Duration, body: Option<&[u8]>) -> Result<Value, String> {
    let mut invocation = command(path); invocation.args(args);
    let mut child = spawn(invocation)?;
    if let Some(body) = body {
        if body.len() > 64*1024 { return Err("本机元数据输入超限".into()); }
        if let Some(input) = child.0.stdin.as_mut() { input.write_all(body).map_err(|_| "本机元数据输入失败")?; }
    }
    drop(child.0.stdin.take());
    let output = child.0.stdout.take().ok_or("CLI 输出不可用")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = output.take((MAX_OUTPUT + 1) as u64).read_to_end(&mut bytes);
        let _ = sender.send(if result.is_ok() && bytes.len() <= MAX_OUTPUT { Ok(bytes) } else { Err("CLI 输出超限或读取失败".to_string()) });
    });
    let result = receiver.recv_timeout(timeout).map_err(|_| "CLI 状态读取超时".to_string()).and_then(|result| result).and_then(|mut bytes| {
        let parsed = serde_json::from_slice(&bytes).map_err(|_| "CLI 状态格式无效".to_string());
        bytes.fill(0); parsed
    });
    drop(child);
    let _ = reader.join();
    result
}

/// Only initialize and two read-only account methods are ever sent. No login,
/// token refresh, inference, thread creation, credit consumption, or UI scraping.
pub fn read_codex_usage(path: &Path) -> Result<(Value, Value), String> {
    let mut invocation = command(path); invocation.args(["app-server", "--stdio"]);
    let mut child = spawn(invocation)?;
    let mut input = child.0.stdin.take().ok_or("Codex CLI 输入不可用")?;
    let output = child.0.stdout.take().ok_or("Codex CLI 输出不可用")?;
    let (sender, receiver) = mpsc::sync_channel(32);
    let reader = std::thread::spawn(move || {
        let mut output = BufReader::new(output);
        let mut total = 0usize;
        loop {
            let mut line = Vec::new();
            // Bound a single line too; an unterminated line must not allocate forever.
            match output.by_ref().take((MAX_OUTPUT + 1) as u64).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    total = total.saturating_add(line.len());
                    if total > MAX_OUTPUT { line.fill(0); let _ = sender.send(Err("Codex CLI 响应超限".to_string())); break; }
                    let parsed = serde_json::from_slice::<Value>(&line); line.fill(0);
                    if let Ok(value) = parsed { if sender.send(Ok(value)).is_err() { break; } }
                }
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    let result = (|| {
        let send = |input: &mut std::process::ChildStdin, value: Value| -> Result<(), String> {
            writeln!(input, "{}", value).map_err(|_| "Codex CLI 请求无法发送".to_string())
        };
        let receive = |id: u64| -> Result<Value, String> {
            loop {
                let remaining = deadline.checked_duration_since(Instant::now()).ok_or("Codex CLI 状态读取超时")?;
                let value = receiver.recv_timeout(remaining).map_err(|_| "Codex CLI 状态读取超时或进程退出".to_string())??;
                if value.get("method").is_some() || value.get("id").and_then(Value::as_u64) != Some(id) { continue; }
                if value.get("error").is_some_and(|error| !error.is_null()) {
                    return Err(format!("Codex CLI 状态接口读取失败（步骤{id}，代码{}）", value.pointer("/error/code").and_then(Value::as_i64).unwrap_or(0)));
                }
                return value.get("result").cloned().ok_or("Codex CLI 响应缺少结果".into());
            }
        };
        send(&mut input, serde_json::json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"codex_desktop_usage","title":"AgentRoom","version":"0.1.0"},"capabilities":{"experimentalApi":true}}}))?;
        receive(1)?;
        send(&mut input, serde_json::json!({"method":"initialized"}))?;
        send(&mut input, serde_json::json!({"id":2,"method":"account/read","params":{"refreshToken":false}}))?;
        let account = receive(2)?;
        if account.pointer("/account/type").and_then(Value::as_str) != Some("chatgpt") { return Ok((account, Value::Null)); }
        send(&mut input, serde_json::json!({"id":3,"method":"account/rateLimits/read"}))?;
        Ok((account, receive(3)?))
    })();
    drop(input); drop(child); drop(receiver);
    let _ = reader.join();
    result
}
