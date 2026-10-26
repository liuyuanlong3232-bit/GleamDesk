use serde::{Deserialize,Serialize};
use std::time::Duration;
use crate::provider_requests::{RequestCache,observed_unix_ms};
#[derive(Clone,Deserialize,PartialEq)]#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ApplicationProbe{pub id:String,pub kind:String,pub target:String,pub process_name:Option<String>}
#[derive(Clone,Serialize)]#[serde(rename_all="camelCase")]
pub struct ApplicationStatus{pub id:String,pub state:&'static str,pub basis:&'static str,pub observed_at_unix_ms:u64}
#[derive(Default)]pub struct ApplicationRuntimeState(pub RequestCache<Vec<ApplicationProbe>,Vec<ApplicationStatus>>);
struct ProcessIdentity{name:String,path:Option<String>}
fn normalized_path(value:&str)->String{value.trim().replace('/',"\\").trim_start_matches("\\\\?\\").to_lowercase()}
fn process_name(value:&str)->String{value.rsplit(['\\','/']).next().unwrap_or(value).to_lowercase().trim_end_matches(".exe").to_owned()}
fn status(probe:&ApplicationProbe,processes:&[ProcessIdentity],at:u64)->ApplicationStatus{
    let result=|state,basis|ApplicationStatus{id:probe.id.clone(),state,basis,observed_at_unix_ms:at};
    if !matches!(probe.kind.as_str(),"exe"|"shortcut")||probe.target.trim().is_empty(){return result("unsupported","none");}
    let absolute_exe=probe.kind=="exe"&&probe.target.to_ascii_lowercase().ends_with(".exe")&&(probe.target.contains('\\')||probe.target.contains('/'));
    let name=probe.process_name.as_deref().filter(|name|!name.trim().is_empty()).map(process_name).unwrap_or_else(||process_name(&probe.target));
    if probe.kind=="shortcut"&&probe.process_name.as_deref().unwrap_or("").is_empty(){return result("unknown","none");}
    if probe.kind=="exe"&&!probe.target.to_ascii_lowercase().ends_with(".exe"){return result("unsupported","none");}
    let candidates=processes.iter().filter(|process|process.name==name).collect::<Vec<_>>();
    if absolute_exe{
        let target=normalized_path(&probe.target);
        if candidates.iter().any(|process|process.path.as_ref().is_some_and(|path|normalized_path(path)==target)){return result("running","path");}
        return if candidates.iter().any(|process|process.path.is_none()){result("unknown","path")}else{result("not-running","path")};
    }
    if candidates.is_empty(){result("not-running","process-name")}else{result("running","process-name")}
}
#[cfg(windows)]fn inspect(probes:&[ApplicationProbe])->Result<Vec<ApplicationStatus>,String>{
    use windows_sys::Win32::{Foundation::{CloseHandle,GetLastError,ERROR_NO_MORE_FILES,INVALID_HANDLE_VALUE,HANDLE},System::{Diagnostics::ToolHelp::{CreateToolhelp32Snapshot,Process32FirstW,Process32NextW,PROCESSENTRY32W,TH32CS_SNAPPROCESS},Threading::{OpenProcess,QueryFullProcessImageNameW,PROCESS_QUERY_LIMITED_INFORMATION}}};
    struct Handle(HANDLE);impl Drop for Handle{fn drop(&mut self){if !self.0.is_null()&&self.0!=INVALID_HANDLE_VALUE{unsafe{CloseHandle(self.0);}}}}
    let snapshot=Handle(unsafe{CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0)});if snapshot.0==INVALID_HANDLE_VALUE||snapshot.0.is_null(){return Err("无法读取本机进程状态".into());}
    let wanted=probes.iter().filter(|probe|matches!(probe.kind.as_str(),"exe"|"shortcut")).map(|probe|probe.process_name.as_deref().filter(|name|!name.trim().is_empty()).map(process_name).unwrap_or_else(||process_name(&probe.target))).collect::<std::collections::HashSet<_>>();
    let mut entry:PROCESSENTRY32W=unsafe{std::mem::zeroed()};entry.dwSize=std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut more=unsafe{Process32FirstW(snapshot.0,&mut entry)}!=0;if !more&&unsafe{GetLastError()}!=ERROR_NO_MORE_FILES{return Err("进程枚举暂不可读".into());}let mut processes=Vec::new();let mut examined=0;
    while more&&examined<4096{
        examined+=1;let end=entry.szExeFile.iter().position(|value|*value==0).unwrap_or(entry.szExeFile.len());let name=process_name(&String::from_utf16_lossy(&entry.szExeFile[..end]));
        if wanted.contains(&name){
            let handle=Handle(unsafe{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,0,entry.th32ProcessID)});
            let path=if handle.0.is_null(){None}else{let mut bytes=vec![0u16;32768];let mut length=bytes.len() as u32;if unsafe{QueryFullProcessImageNameW(handle.0,0,bytes.as_mut_ptr(),&mut length)}!=0{Some(String::from_utf16_lossy(&bytes[..length as usize]))}else{None}};
            processes.push(ProcessIdentity{name,path});
        }
        more=unsafe{Process32NextW(snapshot.0,&mut entry)}!=0;if !more&&unsafe{GetLastError()}!=ERROR_NO_MORE_FILES{return Err("进程枚举未完成，状态暂未知".into());}
    }
    if more{return Err("进程枚举达到上限，状态暂未知".into());}
    let at=observed_unix_ms();Ok(probes.iter().map(|probe|status(probe,&processes,at)).collect())
}
#[tauri::command]pub async fn read_application_statuses(state:tauri::State<'_,ApplicationRuntimeState>,mut probes:Vec<ApplicationProbe>)->Result<Vec<ApplicationStatus>,String>{
    if probes.len()>100||probes.iter().any(|probe|probe.id.is_empty()||probe.id.len()>128||probe.target.len()>4096||probe.process_name.as_ref().is_some_and(|name|name.len()>260||name.chars().any(char::is_control))){return Err("应用状态查询超出范围".into());}
    probes.sort_by(|a,b|a.id.cmp(&b.id));let cache=state.0.clone();
    tauri::async_runtime::spawn_blocking(move||cache.read(probes.clone(),Duration::from_secs(10),Duration::from_secs(2),||{
        #[cfg(windows)]{inspect(&probes)}
        #[cfg(not(windows))]{Err("应用进程检查仅支持Windows".into())}
    })).await.map_err(|_|"应用状态任务失败".to_string())?
}
#[cfg(test)]mod tests{use super::*;
 fn probe(kind:&str,target:&str,hint:Option<&str>)->ApplicationProbe{ApplicationProbe{id:"a".into(),kind:kind.into(),target:target.into(),process_name:hint.map(str::to_owned)}}
 #[test]fn executable_paths_do_not_confuse_same_name_programs(){let processes=[ProcessIdentity{name:"app".into(),path:Some("D:\\other\\app.exe".into())}];assert_eq!(status(&probe("exe","C:\\app\\app.exe",None),&processes,1).state,"not-running");assert_eq!(status(&probe("exe","d:/other/APP.exe",None),&processes,1).state,"running");}
 #[test]fn access_denied_and_unresolved_shortcuts_are_unknown(){let processes=[ProcessIdentity{name:"app".into(),path:None}];assert_eq!(status(&probe("exe","C:\\app.exe",None),&processes,1).state,"unknown");assert_eq!(status(&probe("shortcut","C:\\name.lnk",None),&processes,1).state,"unknown");assert_eq!(status(&probe("shortcut","C:\\name.lnk",Some("app")),&processes,1).basis,"process-name");assert_eq!(status(&probe("url","https://example.com",None),&processes,1).state,"unsupported");}
 #[test]fn current_test_executable_is_detected_without_launching_anything(){let target=std::env::current_exe().unwrap().to_string_lossy().into_owned();assert_eq!(inspect(&[probe("exe",&target,None)]).unwrap()[0].state,"running");}
}
