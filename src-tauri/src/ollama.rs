use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use crate::provider_requests::{RequestCache, observed_unix_ms};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    name: String, size_bytes: Option<u64>, family: Option<String>, parameter_size: Option<String>, quantization: Option<String>,
    size_vram_bytes: Option<u64>, expires_at: Option<String>, remote: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaSnapshot {
    service_status: &'static str, source: &'static str, models: Vec<Model>, running_models: Vec<Model>,
    usage:Option<Value>,
    pub(crate) model_count: Option<usize>, truncated: bool, observed_at_unix_ms: u64, error: Option<&'static str>,
}
#[derive(Default)]
pub struct OllamaState { cache: RequestCache<(), OllamaSnapshot> }
impl OllamaState { pub fn metrics(&self)->Option<crate::provider_requests::RequestMetrics>{self.cache.metrics()} }
fn text(value: Option<&Value>) -> Option<String> { value.and_then(Value::as_str).filter(|text| text.len() <= 256 && !text.chars().any(char::is_control)).map(str::to_owned) }
fn model_name(value: &str) -> bool { !value.is_empty() && value.len() <= 256 && !value.starts_with('/') && !value.contains("..") && value.chars().all(|c| c.is_ascii_alphanumeric() || "_-.:/".contains(c)) }
fn remote_model(value: &Value) -> bool {
    ["remote_host", "remote_model"].iter().any(|key| value.get(*key).is_some_and(|value| !value.is_null()))
}
fn models(root: &Value) -> Result<Vec<Model>, String> {
    let entries = root.get("models").and_then(Value::as_array).filter(|entries| entries.len() <= 4096).ok_or("模型列表格式无效")?;
    entries.iter().take(128).map(|entry| {
        let name = text(entry.get("name")).filter(|name| model_name(name)).ok_or("模型名称无效")?;
        Ok(Model { remote: entry.get("remote_host").is_some_and(|value| !value.is_null()) || entry.get("remote_model").is_some_and(|value| !value.is_null()) || name.ends_with(":cloud") || name.ends_with("-cloud"),
            name, size_bytes: entry.get("size").and_then(Value::as_u64), family: text(entry.pointer("/details/family")),
            parameter_size: text(entry.pointer("/details/parameter_size")), quantization: text(entry.pointer("/details/quantization_level")),
            size_vram_bytes: entry.get("size_vram").and_then(Value::as_u64), expires_at: text(entry.get("expires_at")) })
    }).collect()
}
pub(crate) fn snapshot_from_responses(tags: &Value, running: &Value) -> Result<OllamaSnapshot, String> {
    let installed_models = models(tags)?; let running_models = models(running)?;
    let model_count = tags["models"].as_array().map(Vec::len);
    Ok(OllamaSnapshot { service_status: "online", source: "http://127.0.0.1:11434", models: installed_models, running_models, usage:None, model_count,
        truncated: model_count.is_some_and(|count| count > 128) || running["models"].as_array().is_some_and(|entries| entries.len() > 128),
        observed_at_unix_ms: observed_unix_ms(), error: None })
}
fn load() -> OllamaSnapshot {
    #[cfg(windows)] {
        let read = |path| -> Result<Value, String> {
            let (status, body) = crate::http::local_ollama_json(path, None)?;
            if status != 200 { return Err("本地模型接口不可用".into()); }
            serde_json::from_slice(&body).map_err(|_| "本地模型响应格式无效".into())
        };
        match read("/api/tags").and_then(|tags| read("/api/ps").and_then(|running| snapshot_from_responses(&tags, &running))) {
            Ok(snapshot) => return snapshot,
            Err(_) => return OllamaSnapshot { service_status: "offline", source: "http://127.0.0.1:11434", models: Vec::new(), running_models: Vec::new(), usage:None, model_count: None, truncated: false, observed_at_unix_ms: observed_unix_ms(), error: Some("本机 Ollama API 不可达或返回无效数据；模型列表未知") },
        }
    }
    #[cfg(not(windows))] {
        OllamaSnapshot { service_status: "unknown", source: "http://127.0.0.1:11434", models: Vec::new(), running_models: Vec::new(), usage:None, model_count: None, truncated: false, observed_at_unix_ms: observed_unix_ms(), error: Some("当前平台未接入本地模型读取") }
    }
}
#[tauri::command]
pub async fn read_ollama_status(app:tauri::AppHandle,state: tauri::State<'_, OllamaState>) -> Result<OllamaSnapshot, String> {
    let cache = state.cache.clone();
    tauri::async_runtime::spawn_blocking(move || {let mut snapshot=cache.read((), Duration::from_secs(30), Duration::from_secs(3), || Ok(load()))?;snapshot.usage=read_workbench_usage(&app).ok();Ok(snapshot)})
        .await.map_err(|_| "Ollama 本地检测任务失败".to_string())?
}
#[tauri::command]
pub async fn read_ollama_model_info(name: String) -> Result<Value, String> {
    if !model_name(&name) { return Err("模型名称无效".into()); }
    #[cfg(windows)] {
        tauri::async_runtime::spawn_blocking(move || {
            let body = serde_json::to_vec(&serde_json::json!({"model":name,"verbose":false})).map_err(|_| "模型请求无法生成")?;
            let (status, bytes) = crate::http::local_ollama_json("/api/show", Some(&body))?;
            if status != 200 { return Err("Ollama 模型信息不可读取".into()); }
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| "模型信息格式无效")?;
            let capabilities: Vec<_> = value["capabilities"].as_array().map(|items| items.iter().take(16).filter_map(|item| text(Some(item))).collect()).unwrap_or_default();
            Ok(serde_json::json!({"details":{"family":text(value.pointer("/details/family")),"parameterSize":text(value.pointer("/details/parameter_size")),"quantization":text(value.pointer("/details/quantization_level"))},"capabilities":capabilities,"remote":value.get("remote_host").is_some_and(|value| !value.is_null()) || value.get("remote_model").is_some_and(|value| !value.is_null())}))
        }).await.map_err(|_| "模型信息任务失败".to_string())?
    }
    #[cfg(not(windows))] { Err("当前平台无法读取 Ollama 模型信息".into()) }
}

#[tauri::command]
pub async fn open_ollama_terminal(name: String) -> Result<(), String> {
    if !model_name(&name) { return Err("模型名称无效".into()); }
    #[cfg(windows)] {
        tauri::async_runtime::spawn_blocking(move || {
            let snapshot=load();
            if snapshot.service_status!="online" || !snapshot.models.iter().any(|model|model.name==name&&!model.remote) { return Err("只能打开本地API中已有的本地模型".into()); }
            let body=serde_json::to_vec(&serde_json::json!({"model":name,"verbose":false})).map_err(|_| "模型请求无法生成")?;
            let (status,bytes)=crate::http::local_ollama_json("/api/show",Some(&body))?;
            let details:Value=serde_json::from_slice(&bytes).map_err(|_| "模型信息格式无效")?;
            if status!=200 || !details.is_object() || remote_model(&details) { return Err("此模型不是当前可确认的本地模型".into()); }
            let mut candidates=Vec::new();
            if let Some(home)=std::env::var_os("USERPROFILE"){candidates.push(std::path::PathBuf::from(home).join("AppData/Local/Programs/Ollama/ollama.exe"));}
            if let Some(programs)=std::env::var_os("ProgramFiles"){candidates.push(std::path::PathBuf::from(programs).join("Ollama/ollama.exe"));}
            if let Some(paths)=std::env::var_os("PATH"){candidates.extend(std::env::split_paths(&paths).take(64).map(|path|path.join("ollama.exe")));}
            let path=candidates.into_iter().find(|path|path.is_absolute()&&path.is_file()).ok_or("本机 Ollama CLI 未检测到；服务可能位于容器或其他环境")?;
            use std::os::windows::process::CommandExt;
            std::process::Command::new(path).args(["run",&name]).creation_flags(0x00000010).spawn().map_err(|_| "无法打开 Ollama 终端聊天")?;
            Ok(())
        }).await.map_err(|_| "本地模型入口任务失败".to_string())?
    }
    #[cfg(not(windows))] { Err("终端入口仅支持 Windows".into()) }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn online_empty_and_multi_model_states_come_from_api_metadata() {
        let empty = snapshot_from_responses(&serde_json::json!({"models":[]}), &serde_json::json!({"models":[]})).unwrap();
        assert_eq!(empty.service_status, "online"); assert_eq!(empty.model_count, Some(0));
        let multi = snapshot_from_responses(&serde_json::json!({"models":[{"name":"qwen2.5:3b","size":100,"details":{"family":"qwen2"}},{"name":"deepseek:8b","size":200}]}), &serde_json::json!({"models":[{"name":"qwen2.5:3b","size_vram":50}]})).unwrap();
        assert_eq!(multi.model_count, Some(2)); assert_eq!(multi.running_models.len(),1); assert_eq!(multi.running_models[0].size_vram_bytes,Some(50));
    }
    #[test]
    fn invalid_model_lists_and_names_fail_without_inventing_models() {
        assert!(!model_name("../secret")); assert!(!model_name("C:\\model"));
        assert!(snapshot_from_responses(&Value::Null,&Value::Null).is_err());
    }
    #[test]
    fn terminal_rechecks_remote_model_metadata_before_launching() {
        assert!(remote_model(&serde_json::json!({"remote_host":"https://example.test"})));
        assert!(remote_model(&serde_json::json!({"remote_model":"model"})));
        assert!(!remote_model(&serde_json::json!({"remote_host":null,"details":{}})));
    }
}

pub(crate) fn validate_local_chat_model(name:&str)->Result<(),String>{
    if !model_name(name){return Err("本地模型名称无效".into());}
    let snapshot=load();if snapshot.service_status!="online"||!snapshot.models.iter().any(|model|model.name==name&&!model.remote){return Err("只能请求已检测到的本地模型；不会安装或调用云模型".into());}
    #[cfg(windows)] {let body=serde_json::to_vec(&serde_json::json!({"model":name,"verbose":false})).map_err(|_|"模型请求编码失败")?;let (status,bytes)=crate::http::local_ollama_json("/api/show",Some(&body))?;let data:Value=serde_json::from_slice(&bytes).map_err(|_|"模型信息无效")?;if status!=200||!data.is_object()||remote_model(&data){return Err("无法确认此模型只在本机运行".into());}}
    Ok(())
}
static USAGE_WRITE:std::sync::Mutex<()>=std::sync::Mutex::new(());
fn usage_path(app:&tauri::AppHandle)->Result<std::path::PathBuf,String>{
    use tauri::Manager;let root=app.path().app_data_dir().map_err(|_|"用量目录不可用")?;std::fs::create_dir_all(&root).map_err(|_|"用量目录不可写")?;Ok(root.join("ollama-workbench-usage.json"))
}
fn read_workbench_usage(app:&tauri::AppHandle)->Result<Value,String>{
    let path=usage_path(app)?;
    if !path.is_file(){return Ok(serde_json::json!({"scope":"workbench-only","requests":0,"inputTokens":0,"outputTokens":0,"unmeasuredRequests":0,"recordingSinceAtUnixMs":observed_unix_ms()}));}
    if std::fs::metadata(&path).map_err(|_|"用量记录不可读")?.len()>16384{return Err("用量记录超限".into());}
    let value:Value=serde_json::from_slice(&std::fs::read(path).map_err(|_|"用量记录不可读")?).map_err(|_|"用量记录格式无效")?;
    if value["scope"]!="workbench-only"||["requests","inputTokens","outputTokens","unmeasuredRequests","recordingSinceAtUnixMs"].iter().any(|key|value[*key].as_u64().is_none()){return Err("用量记录字段无效".into());}Ok(value)
}
pub(crate) fn record_workbench_usage(app:&tauri::AppHandle,input:Option<u64>,output:Option<u64>)->Result<(),String>{
    let _lock=USAGE_WRITE.lock().map_err(|_|"用量写入忙碌")?;let mut value=read_workbench_usage(app)?;
    for (key,addition) in [("requests",1),("inputTokens",input.unwrap_or(0)),("outputTokens",output.unwrap_or(0)),("unmeasuredRequests",u64::from(input.is_none()||output.is_none()))]{let old=value[key].as_u64().ok_or("用量字段无效")?;value[key]=serde_json::json!(old.checked_add(addition).ok_or("用量累计超限")?);}
    value["lastRecordedAtUnixMs"]=serde_json::json!(observed_unix_ms());let path=usage_path(app)?;let temp=path.with_extension("json.tmp");let bytes=serde_json::to_vec(&value).map_err(|_|"用量无法编码")?;std::fs::write(&temp,bytes).and_then(|_|std::fs::rename(temp,path)).map_err(|_|"用量保存失败".into())
}
