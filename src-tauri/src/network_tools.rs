use serde::{Deserialize,Serialize};
use std::{io::Read,net::{TcpStream,SocketAddr},process::{Command,Stdio},time::{Duration,Instant}};
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct NetworkQuery {kind:String,target:String,port:Option<u16>}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct NetworkResult {source:&'static str,output:String,completed_at_unix_ms:u64,
    #[cfg(windows)]#[serde(skip_serializing_if="Option::is_none")]certificate:Option<crate::tls_tool::TlsCertificate>,
}
fn target(value:&str)->Result<&str,String>{
    if value.is_empty()||value.len()>253||value.starts_with('-')||value.starts_with('.')||value.ends_with('.')||!value.bytes().all(|b|b.is_ascii_alphanumeric()||b".-:".contains(&b)){return Err("请输入IP或ASCII域名，不含网址路径、空格或命令参数".into());}Ok(value)
}
#[cfg(windows)]
pub(crate) fn system_executable(name:&str)->Result<std::path::PathBuf,String>{
    #[link(name="kernel32")] unsafe extern "system" {fn GetSystemDirectoryW(buffer:*mut u16,size:u32)->u32;}
    let mut buffer=[0u16;32768];let length=unsafe{GetSystemDirectoryW(buffer.as_mut_ptr(),buffer.len() as u32)} as usize;
    if length==0||length>=buffer.len(){return Err("Windows系统目录不可用".into());}
    Ok(std::path::PathBuf::from(String::from_utf16(&buffer[..length]).map_err(|_|"系统路径无效")?).join(name))
}
#[cfg(windows)]
fn system_output(bytes:&[u8])->String{
    #[link(name="kernel32")] unsafe extern "system" {fn GetOEMCP()->u32;fn MultiByteToWideChar(code:u32,flags:u32,input:*const u8,length:i32,output:*mut u16,capacity:i32)->i32;}
    let code=unsafe{GetOEMCP()};let size=unsafe{MultiByteToWideChar(code,0,bytes.as_ptr(),bytes.len() as i32,std::ptr::null_mut(),0)};
    if size<=0{return String::from_utf8_lossy(bytes).to_string();}let mut output=vec![0u16;size as usize];unsafe{MultiByteToWideChar(code,0,bytes.as_ptr(),bytes.len() as i32,output.as_mut_ptr(),size)};String::from_utf16_lossy(&output)
}
fn run(query:NetworkQuery)->Result<NetworkResult,String>{
    let target=target(&query.target)?;let started=Instant::now();
    #[cfg(windows)]let mut certificate=None;
    let output=match query.kind.as_str(){
        "ssl"=>{
            #[cfg(windows)]{certificate=Some(crate::tls_tool::inspect(target,query.port.unwrap_or(443))?);"TLS握手完成；下方显示本机连接实际返回的证书。".into()}
            #[cfg(not(windows))]{return Err("证书检测使用Windows原生TLS能力".into());}
        },
        "port"=>{
            let port=query.port.unwrap_or(443);if port==0{return Err("端口必须为1到65535".into());}
            let address=SocketAddr::new(target.parse().map_err(|_|"端口探测请输入IP；域名可先用DNS工具解析")?,port);
            let reachable=TcpStream::connect_timeout(&address,Duration::from_secs(2)).is_ok();format!("{address} · {}",if reachable{"TCP连接成功"}else{"不可达或连接超时"})
        },
        "dns"|"ping"|"traceroute"=>{
            #[cfg(windows)]{
                use std::os::windows::process::CommandExt;
                let args=if query.kind=="ping"{vec!["-n","2","-w","1500",target]}else if query.kind=="dns"{vec![target]}else{vec!["-d","-h","12","-w","500",target]};
                let executable=system_executable(if query.kind=="ping"{"ping.exe"}else if query.kind=="dns"{"nslookup.exe"}else{"tracert.exe"})?;
                let mut child=Command::new(executable).args(args).creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_|"无法运行Windows网络工具")?;
                let stdout=child.stdout.take().ok_or("网络工具输出不可用")?;
                let reader=std::thread::spawn(move||{let mut bytes=Vec::new();let _=stdout.take(64*1024).read_to_end(&mut bytes);bytes});
                let timeout=if query.kind=="ping"{8}else{20};let mut timed_out=false;
                loop{if child.try_wait().map_err(|_|"网络工具状态不可读")?.is_some(){break;}if started.elapsed()>Duration::from_secs(timeout){let _=child.kill();let _=child.wait();timed_out=true;break;}std::thread::sleep(Duration::from_millis(30));}
                let bytes=reader.join().map_err(|_|"网络工具输出任务失败")?;let mut output=system_output(&bytes);if timed_out{output.push_str("\n已达到探测时限，子进程已结束。");}output
            }
            #[cfg(not(windows))]{return Err("此探测使用Windows原生工具".into());}
        },_=>return Err("不支持的网络工具".into())
    };
    Ok(NetworkResult{source:"本机Windows网络能力（不代表全球可达性）",output,#[cfg(windows)]certificate,completed_at_unix_ms:std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64})
}
#[tauri::command]
pub async fn network_tool_run(query:NetworkQuery)->Result<NetworkResult,String>{tauri::async_runtime::spawn_blocking(move||run(query)).await.map_err(|_|"网络探测任务失败".to_string())?}
#[cfg(test)]mod tests{use super::*;
 #[test]fn shell_syntax_and_option_injection_are_rejected(){for value in ["-n","example.com & calc","example.com;whoami","https://example.com/","$(cmd)","a\r\n"]{assert!(target(value).is_err());}assert!(target("example.com").is_ok());assert!(target("127.0.0.1").is_ok());assert!(target("::1").is_ok());}
}
