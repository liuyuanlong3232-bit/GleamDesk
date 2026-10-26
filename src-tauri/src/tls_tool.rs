use serde::Serialize;
use std::time::{Duration,Instant};
use windows::{core::HSTRING,Networking::{HostName,Sockets::{StreamSocket,SocketProtectionLevel}}};

#[derive(Serialize)]#[serde(rename_all="camelCase")]
pub struct TlsCertificate {
    pub target:String,pub port:u16,pub subject:Option<String>,pub issuer:Option<String>,pub valid_from_unix_ms:Option<i64>,pub valid_to_unix_ms:Option<i64>,pub sha256:Option<String>,pub protection_level:String,
}
fn unix_ms(value:i64)->Option<i64>{value.checked_sub(116444736000000000)?.checked_div(10000)}
fn text(value:windows::core::Result<HSTRING>)->Option<String>{value.ok().map(|value|value.to_string().chars().filter(|ch|!ch.is_control()).take(1024).collect::<String>()).filter(|value|!value.is_empty())}
fn level(value:i32)->String{match value{10=>"Tls13",8=>"Tls12",7=>"Tls11",6=>"Tls10",_=>return format!("Windows级别 {value}")}.into()}
use crate::windows_runtime::Apartment;
struct CloseSocket(StreamSocket);
impl Drop for CloseSocket{fn drop(&mut self){let _=self.0.Close();}}
pub fn inspect(target:&str,port:u16)->Result<TlsCertificate,String>{
    if port==0{return Err("端口必须为1到65535".into());}
    let _apartment=Apartment::new()?;let socket=CloseSocket(StreamSocket::new().map_err(|_|"Windows TLS套接字不可用")?);
    let host=HostName::CreateHostName(&HSTRING::from(target)).map_err(|_|"TLS主机名无效")?;
    // Default Windows certificate validation remains enabled. Never ignore certificate errors.
    let operation=socket.0.ConnectWithProtectionLevelAsync(&host,&HSTRING::from(port.to_string()),SocketProtectionLevel::Tls12).map_err(|_|"TLS连接无法开始")?;
    let deadline=Instant::now()+Duration::from_secs(15);
    loop{
        let status=operation.Status().map_err(|_|"TLS连接状态不可用")?;
        if status.0!=0{operation.GetResults().map_err(|error|format!("TLS连接或证书验证失败（Windows {:08X}）；未忽略证书错误",error.code().0 as u32))?;break;}
        if Instant::now()>deadline{let _=operation.Cancel();return Err("TLS探测达到15秒时限，连接已取消".into());}
        std::thread::sleep(Duration::from_millis(10));
    }
    let info=socket.0.Information().map_err(|_|"TLS连接信息不可用")?;
    let certificate=info.ServerCertificate().map_err(|_|"连接未返回可读取的服务器证书")?;
    let sha256=certificate.GetHashValueWithAlgorithm(&HSTRING::from("SHA256")).ok().filter(|bytes|bytes.len()==32).map(|bytes|bytes.iter().map(|byte|format!("{byte:02X}")).collect::<String>());
    Ok(TlsCertificate{target:target.into(),port,subject:text(certificate.Subject()),issuer:text(certificate.Issuer()),valid_from_unix_ms:certificate.ValidFrom().ok().and_then(|date|unix_ms(date.UniversalTime)),valid_to_unix_ms:certificate.ValidTo().ok().and_then(|date|unix_ms(date.UniversalTime)),sha256,protection_level:info.ProtectionLevel().map(|value|level(value.0)).unwrap_or_else(|_|"未知".into())})
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn winrt_certificate_times_keep_real_utc_milliseconds(){assert_eq!(unix_ms(116444736000000000),Some(0));assert_eq!(unix_ms(116444736012340000),Some(1234));assert_eq!(unix_ms(i64::MIN),None);}
 #[test]fn tls_socket_runtime_initializes_and_closes_without_network(){let _apartment=Apartment::new().unwrap();let socket=CloseSocket(StreamSocket::new().unwrap());drop(socket);}
 #[test]fn zero_port_is_rejected_before_network(){assert!(inspect("example.com",0).is_err());}
 #[test]#[ignore="manual read-only TLS handshake with the user-supplied public Muse site"]
 fn inspect_mues_public_certificate(){let result=inspect("mues.ai",443).unwrap();assert!(result.subject.is_some());assert!(result.issuer.is_some());assert_eq!(result.sha256.as_ref().map(String::len),Some(64));println!("{}",serde_json::to_string(&result).unwrap());}
}
