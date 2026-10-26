use crate::mail::{MailProvider,MailSecret,MailMessage,MailSnapshot,now_ms};
use std::time::{Instant,Duration};
use windows::{core::HSTRING,Networking::{HostName,Sockets::{StreamSocket,SocketProtectionLevel}},Storage::Streams::{DataReader,DataWriter,InputStreamOptions}};

fn tls_error(stage:&str,error:windows::core::Error)->String{
    // Only a static operation label and HRESULT; never echo commands, credentials or server bodies.
    format!("{stage}失败（Windows错误码 0x{:08X}）",error.code().0 as u32)
}
fn command_stage(command:&str)->&'static str{
    match command.split_whitespace().next().unwrap_or("") {
        "LOGIN"=>"邮箱登录","ID"=>"客户端登记","EXAMINE"|"SELECT"=>"打开收件箱",
        "STATUS"=>"读取未读数量","FETCH"=>"读取邮件列表","UID"=>"读取邮件详情",
        "LOGOUT"=>"退出邮箱",_=>"邮箱协议通信",
    }
}
macro_rules! wait {
    ($operation:expr,$deadline:expr)=>{wait!($operation,$deadline,"TLS连接")};
    ($operation:expr,$deadline:expr,$stage:expr)=>{{
        let operation=$operation.map_err(|error|tls_error($stage,error))?;
        loop{
            let status=operation.Status().map_err(|error|tls_error($stage,error))?;
            if status.0!=0{break operation.GetResults().map_err(|error|tls_error($stage,error));}
            if Instant::now()>$deadline{let _=operation.Cancel();break Err(format!("{}达到读取总时限",$stage));}
            std::thread::sleep(Duration::from_millis(10));
        }
    }};
}
struct Frame {line:String,literal:Option<Vec<u8>>}
struct Socket {socket:StreamSocket,reader:DataReader,writer:DataWriter,deadline:Instant,total:usize,stage:&'static str}
impl Drop for Socket{fn drop(&mut self){let _=self.reader.Close();let _=self.writer.Close();let _=self.socket.Close();}}
impl Socket {
    fn byte(&mut self)->Result<u8,String>{
        if self.total>=256*1024{return Err("邮箱响应超过256KB上限".into());}
        if self.reader.UnconsumedBufferLength().map_err(|_|"邮箱缓冲不可用")?==0{let count=wait!(self.reader.LoadAsync(1024),self.deadline,self.stage)?;if count==0{return Err("邮箱连接中断".into());}}
        self.total+=1;self.reader.ReadByte().map_err(|_|"邮箱数据不可读".into())
    }
    fn line(&mut self)->Result<String,String>{let mut bytes=Vec::new();loop{let byte=self.byte()?;bytes.push(byte);if byte==b'\n'{break;}if bytes.len()>32768{return Err("邮箱协议行超过上限".into());}}Ok(String::from_utf8_lossy(&bytes).trim_end_matches(['\r','\n']).to_string())}
    fn literal(&mut self,count:usize)->Result<Vec<u8>,String>{if count>65536{return Err("邮件内容超过读取上限".into());}let mut bytes=Vec::with_capacity(count);for _ in 0..count{bytes.push(self.byte()?);}Ok(bytes)}
    fn command(&mut self,tag:&str,command:&str)->Result<Vec<Frame>,String>{
        self.stage=command_stage(command);
        let mut bytes=format!("{tag} {command}\r\n").into_bytes();self.writer.WriteBytes(&bytes).map_err(|_|"邮箱请求不可写")?;bytes.fill(0);wait!(self.writer.StoreAsync(),self.deadline,self.stage)?;
        if !wait!(self.writer.FlushAsync(),self.deadline,self.stage)?{return Err(format!("{}请求未完整发送",self.stage));}
        let mut rows=Vec::new();loop{let line=self.line()?;if line.starts_with(&format!("{tag} ")){if !line.starts_with(&format!("{tag} OK")){return Err("邮箱拒绝当前读取操作；请检查IMAP服务与授权码".into());}return Ok(rows);}
            let literal=line.rsplit_once('{').and_then(|(_,tail)|tail.strip_suffix('}')).and_then(|size|size.parse::<usize>().ok());let literal=if let Some(count)=literal{Some(self.literal(count)?)}else{None};rows.push(Frame{line,literal});if rows.len()>500{return Err("邮箱响应条目超过上限".into());}}
    }
}
use crate::windows_runtime::Apartment;
fn quote(value:&str)->Result<String,String>{if value.is_empty()||value.len()>4096||value.chars().any(char::is_control){return Err("邮箱登录字段无效".into());}Ok(format!("\"{}\"",value.replace('\\',"\\\\").replace('"',"\\\"")))}
pub fn decode_header(value:&str)->String {
    use base64::{Engine,engine::general_purpose::STANDARD};
    let mut result=String::new();let mut rest=value;
    while let Some(start)=rest.find("=?"){
        result.push_str(&rest[..start]);let tail=&rest[start+2..];let Some(end)=tail.find("?=")else{result.push_str(&rest[start..]);return result;};
        let encoded=&tail[..end];let parts:Vec<_>=encoded.splitn(3,'?').collect();let decoded=if parts.len()==3 {match parts[1].to_ascii_uppercase().as_str(){"B"=>STANDARD.decode(parts[2]).ok(),"Q"=>{let input=parts[2].as_bytes();let mut bytes=Vec::new();let mut i=0;while i<input.len(){if input[i]==b'='&&i+2<input.len(){if let Ok(byte)=u8::from_str_radix(&String::from_utf8_lossy(&input[i+1..i+3]),16){bytes.push(byte);i+=3;continue;}}bytes.push(if input[i]==b'_'{b' '}else{input[i]});i+=1;}Some(bytes)},_=>None}}else{None};
        if let Some(bytes)=decoded{if let Ok(value)=crate::mail_display::decode_bytes(&bytes,parts[0]){result.push_str(&value);}else{result.push_str(&rest[start..start+2+end+2]);}}else{result.push_str(&rest[start..start+2+end+2]);}
        rest=&tail[end+2..];if rest.starts_with(' ')&&rest.trim_start().starts_with("=?"){rest=rest.trim_start();}
    }
    result.push_str(rest);result.chars().take(500).collect()
}
pub fn message_from_header(id:String,header:&str,unread:bool)->MailMessage{
    let mut fields=std::collections::HashMap::<String,String>::new();let mut current=String::new();
    for line in header.lines(){if line.starts_with([' ','\t']){if let Some(value)=fields.get_mut(&current){value.push(' ');value.push_str(line.trim());}}else if let Some((name,value))=line.split_once(':'){current=name.to_ascii_lowercase();fields.insert(current.clone(),value.trim().to_owned());}}
    let subject=decode_header(fields.get("subject").map(String::as_str).unwrap_or(""));let sender=decode_header(fields.get("from").map(String::as_str).unwrap_or(""));
    MailMessage{id,important:["验证码","账单","security","invoice","安全","login"].iter().any(|word|subject.to_lowercase().contains(word)),subject,sender,received_at:fields.remove("date").unwrap_or_default(),unread:Some(unread)}
}
pub fn snapshot(provider:MailProvider,secret:&MailSecret)->Result<MailSnapshot,String>{
    let _apartment=Apartment::new()?;let deadline=Instant::now()+Duration::from_secs(45);let host=provider.imap_host().ok_or("账户不是IMAP类型")?;
    let socket=StreamSocket::new().map_err(|_|"Windows TLS套接字不可用")?;
    let connect=wait!(socket.ConnectWithProtectionLevelAsync(&HostName::CreateHostName(&HSTRING::from(host)).map_err(|_|"邮箱主机无效")?,&HSTRING::from("993"),SocketProtectionLevel::Tls12),deadline);
    if let Err(error)=connect{let _=socket.Close();return Err(error);}
    let reader=DataReader::CreateDataReader(&socket.InputStream().map_err(|_|"邮箱输入流不可用")?).map_err(|_|"邮箱读取器不可用")?;reader.SetInputStreamOptions(InputStreamOptions::Partial).map_err(|_|"邮箱读取策略不可用")?;
    let writer=DataWriter::CreateDataWriter(&socket.OutputStream().map_err(|_|"邮箱输出流不可用")?).map_err(|_|"邮箱写入器不可用")?;
    let mut connection=Socket{socket,reader,writer,deadline,total:0,stage:"读取服务欢迎信息"};let greeting=connection.line()?;if !greeting.starts_with("* OK"){return Err("邮箱服务没有接受IMAP连接".into());}
    let mut login=format!("LOGIN {} {}",quote(&secret.email)?,quote(&secret.authorization)?);let result=connection.command("A1",&login);unsafe{login.as_bytes_mut().fill(0);}result?;
    if provider==MailProvider::Netease{connection.command("ID1","ID (\"name\" \"AI Desktop\" \"version\" \"0.1\" \"vendor\" \"AgentRoom\")")?;}
    // EXAMINE + BODY.PEEK keep the mailbox and message read flags unchanged.
    let examined=connection.command("A2","EXAMINE INBOX")?;let exists=examined.iter().find_map(|frame|frame.line.strip_prefix("* ").and_then(|s|s.strip_suffix(" EXISTS")).and_then(|s|s.parse::<u64>().ok())).unwrap_or(0);
    let status=connection.command("A3","STATUS INBOX (UNSEEN)")?;let count=status.iter().find_map(|frame|frame.line.split_once("UNSEEN ").and_then(|(_,tail)|tail.trim_end_matches(')').parse::<u64>().ok()));
    let mut messages=Vec::new();if exists>0{let start=exists.saturating_sub(11).max(1);let rows=connection.command("A4",&format!("FETCH {start}:{exists} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])"))?;
        let validity=examined.iter().find_map(|frame|frame.line.split_once("UIDVALIDITY ").and_then(|(_,tail)|tail.split(']').next()).and_then(|value|value.parse::<u64>().ok())).ok_or("收件箱UID版本未知，不能安全定位邮件")?;
        for index in 0..rows.len(){let frame=&rows[index];if !frame.line.starts_with("* ")||!frame.line.contains(" FETCH ("){continue;}
            if let Some(header)=frame.literal.as_ref(){let tail=rows.get(index+1).filter(|next|!next.line.starts_with("* ")).map(|next|next.line.as_str()).unwrap_or("");let metadata=format!("{} {}",frame.line,tail);
                let uid=metadata.split_once("UID ").and_then(|(_,tail)|tail.split(|ch:char|ch.is_whitespace()||ch==')').next()).and_then(|value|value.parse::<u64>().ok()).ok_or("邮件UID缺失")?;
                let flags=metadata.split_once("FLAGS (").and_then(|(_,tail)|tail.split_once(')').map(|(flags,_)|flags));
                let mut message=message_from_header(format!("{validity}:{uid}"),&String::from_utf8_lossy(header),false);message.unread=flags.map(|flags|!flags.contains("\\Seen"));messages.push(message);
            }
        }messages.reverse();}
    let _=connection.command("A5","LOGOUT");Ok(MailSnapshot{provider,account:secret.email.clone(),unread_count:count,messages,observed_at_unix_ms:now_ms(),source:format!("TLS IMAP · {host}:993 · EXAMINE / BODY.PEEK")})
}
#[cfg(test)]mod tests {use super::*;
    #[test]fn command_diagnostics_never_include_login_fields(){
        assert_eq!(command_stage("LOGIN \"test@163.com\" \"fake-secret\""),"邮箱登录");
        assert_eq!(command_stage("STATUS INBOX (UNSEEN)"),"读取未读数量");
        assert_eq!(command_stage("FETCH 1:12 (UID FLAGS)"),"读取邮件列表");
        let error=tls_error("邮箱登录",windows::core::Error::from_hresult(windows::core::HRESULT(0x80072746u32 as i32)));
        assert!(error.contains("0x80072746"));assert!(!error.contains("fake-secret"));assert!(!error.contains("@"));
    }
 #[test]fn headers_decode_gbk_without_replacement_characters(){assert_eq!(decode_header("=?GBK?B?xOO6ww==?="),"你好");}
 #[test]fn headers_decode_utf8_and_keep_folding(){let message=message_from_header("1".into(),"Subject: =?UTF-8?B?5L2g5aW9?=\r\nFrom: Example\r\n <a@example.com>\r\nDate: today\r\n",true);assert_eq!(message.subject,"你好");assert_eq!(message.sender,"Example <a@example.com>");assert_eq!(message.unread,Some(true));assert!(quote("x\r\nLOGOUT").is_err());}
}

fn open_mailbox(provider:MailProvider,secret:&MailSecret,writable:bool)->Result<(Socket,u64),String>{
    let _=provider.imap_host().ok_or("此账户不使用IMAP")?;let deadline=Instant::now()+Duration::from_secs(45);let host=provider.imap_host().unwrap();
    let socket=StreamSocket::new().map_err(|_|"Windows TLS套接字不可用")?;
    if let Err(error)=wait!(socket.ConnectWithProtectionLevelAsync(&HostName::CreateHostName(&HSTRING::from(host)).map_err(|_|"主机无效")?,&HSTRING::from("993"),SocketProtectionLevel::Tls12),deadline){let _=socket.Close();return Err(error);}
    let reader=DataReader::CreateDataReader(&socket.InputStream().map_err(|_|"输入流不可用")?).map_err(|_|"读取器不可用")?;reader.SetInputStreamOptions(InputStreamOptions::Partial).map_err(|_|"读取策略不可用")?;
    let writer=DataWriter::CreateDataWriter(&socket.OutputStream().map_err(|_|"输出流不可用")?).map_err(|_|"写入器不可用")?;
    let mut connection=Socket{socket,reader,writer,deadline,total:0,stage:"读取服务欢迎信息"};if !connection.line()?.starts_with("* OK"){return Err("IMAP服务未接受连接".into());}
    let mut login=format!("LOGIN {} {}",quote(&secret.email)?,quote(&secret.authorization)?);let result=connection.command("B1",&login);unsafe{login.as_bytes_mut().fill(0);}result?;
    if provider==MailProvider::Netease{connection.command("ID1","ID (\"name\" \"AI Desktop\" \"version\" \"0.1\" \"vendor\" \"AgentRoom\")")?;}
    let rows=connection.command("B2",if writable{"SELECT INBOX"}else{"EXAMINE INBOX"})?;
    let validity=rows.iter().find_map(|frame|frame.line.split_once("UIDVALIDITY ").and_then(|(_,tail)|tail.split(']').next()).and_then(|value|value.parse::<u64>().ok())).ok_or("IMAP收件箱版本未知")?;Ok((connection,validity))
}
fn verify_uid(id:&str,validity:u64)->Result<u64,String>{let (expected,uid)=id.split_once(':').ok_or("邮件版本缺失")?;if expected.parse::<u64>().ok()!=Some(validity){return Err("收件箱版本已变化，请重新读取列表").map_err(str::to_owned);}uid.parse::<u64>().ok().filter(|uid|*uid>0).ok_or("邮件UID无效".into())}
pub fn detail(provider:MailProvider,secret:&MailSecret,id:&str)->Result<(String,bool),String>{
    let _apartment=Apartment::new()?;let (mut connection,validity)=open_mailbox(provider,secret,false)?;let uid=verify_uid(id,validity)?;
    let header=connection.command("B3",&format!("UID FETCH {uid} (BODY.PEEK[HEADER.FIELDS (CONTENT-TYPE CONTENT-TRANSFER-ENCODING)])"))?.into_iter().find_map(|frame|frame.literal).ok_or("正文格式元数据不可用")?;
    let body=connection.command("B4",&format!("UID FETCH {uid} (BODY.PEEK[TEXT]<0.65536>)"))?.into_iter().find_map(|frame|frame.literal).ok_or("正文不可用")?;let truncated=body.len()>=65536;let text=crate::mail_display::mime_bytes(&String::from_utf8_lossy(&header),&body)?;let _=connection.command("B5","LOGOUT");Ok((text,truncated))
}
pub fn mark_read(provider:MailProvider,secret:&MailSecret,id:&str)->Result<(),String>{let _apartment=Apartment::new()?;let (mut connection,validity)=open_mailbox(provider,secret,true)?;let uid=verify_uid(id,validity)?;connection.command("B3",&format!("UID STORE {uid} +FLAGS.SILENT (\\Seen)"))?;let _=connection.command("B4","LOGOUT");Ok(())}

#[cfg(test)]mod runtime_tests{use super::*;
    #[test]fn command_flushes_after_store_before_reading_response(){
        let source=include_str!("mail_imap.rs");
        let body=source.split_once("fn command(&mut self").unwrap().1.split("use crate::windows_runtime::Apartment;").next().unwrap();
        let write=body.find("self.writer.WriteBytes").unwrap();
        let clear=body.find("bytes.fill(0)").unwrap();
        let store=body.find("self.writer.StoreAsync()").unwrap();
        let flush=body.find("self.writer.FlushAsync()").expect("发送请求必须完成 FlushAsync");
        let read=body.find("let mut rows=").unwrap();
        assert!(write<clear&&clear<store&&store<flush&&flush<read);
        assert!(body.contains("if !wait!(self.writer.FlushAsync()"),"刷新返回 false 时不能读取响应");
    }
    fn memory_connection(response:&[u8])->(Socket,windows::Storage::Streams::InMemoryRandomAccessStream){
        let response_writer=DataWriter::new().unwrap();response_writer.WriteBytes(response).unwrap();
        let reader=DataReader::FromBuffer(&response_writer.DetachBuffer().unwrap()).unwrap();
        let stream=windows::Storage::Streams::InMemoryRandomAccessStream::new().unwrap();
        let writer=DataWriter::CreateDataWriter(&stream.GetOutputStreamAt(0).unwrap()).unwrap();
        (Socket{socket:StreamSocket::new().unwrap(),reader,writer,deadline:Instant::now()+Duration::from_secs(2),total:0,stage:"模拟邮箱响应"},stream)
    }
    #[test]fn command_uses_windows_memory_stream_and_parses_literal_response_without_network()->Result<(),String>{
        let _apartment=Apartment::new().unwrap();
        let header=b"Subject: synthetic\r\n";
        let response=format!("* 1 FETCH (UID 7 FLAGS () BODY[HEADER] {{{}}}\r\n{})\r\nA4 OK completed\r\n",header.len(),String::from_utf8_lossy(header));
        let (mut connection,stream)=memory_connection(response.as_bytes());
        let rows=connection.command("A4","FETCH 1:1 (UID FLAGS BODY.PEEK[HEADER])").unwrap();
        assert_eq!(rows.len(),2);assert_eq!(rows[0].literal.as_deref(),Some(header.as_slice()));
        let wire_reader=DataReader::CreateDataReader(&stream.GetInputStreamAt(0).unwrap()).unwrap();
        let size=stream.Size().unwrap() as u32;
        let loaded=wait!(wire_reader.LoadAsync(size),connection.deadline).unwrap();assert_eq!(loaded,size);
        let mut bytes=vec![0;size as usize];wire_reader.ReadBytes(&mut bytes).unwrap();
        assert_eq!(bytes,b"A4 FETCH 1:1 (UID FLAGS BODY.PEEK[HEADER])\r\n");
        Ok(())
    }
    #[test]fn command_write_failure_does_not_consume_response(){
        let _apartment=Apartment::new().unwrap();
        let (mut connection,_stream)=memory_connection(b"A3 OK completed\r\n");
        connection.writer.Close().unwrap();
        assert!(connection.command("A3","STATUS INBOX (UNSEEN)").is_err());
        assert_eq!(connection.total,0);
    }
    #[test]fn windows_tls_factory_can_be_created_and_closed_without_network(){let _apartment=Apartment::new().unwrap();let socket=StreamSocket::new().unwrap();socket.Close().unwrap();}
    #[test]fn mailbox_generation_changes_reject_an_old_uid(){assert_eq!(verify_uid("12:34",12).unwrap(),34);assert!(verify_uid("12:34",13).is_err());assert!(verify_uid("12:0",12).is_err());}
}
