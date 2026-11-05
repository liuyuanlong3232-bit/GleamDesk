// TLS pre-login ID handling adapted from Daozai MIT b93dd84/src/mail.rs.
    //! TLS 连接 + 163/126 的 pre-login `ID` 握手。
    //!
    //! `imap` 2.4 只在已登录的 `Session` 上暴露 `run_command_and_check_ok`，
    //! 而网易要求 greeting → ID → LOGIN 的顺序，所以这里手工读问候、发 ID，
    //! 再把「已经读掉的开头字节」原样交回给 imap。

    use super::{Account,Provider,Secret,Cursor,Incoming};
use std::sync::atomic::{AtomicBool,Ordering};
    use imap::extensions::idle::SetReadTimeout;
    use native_tls::{TlsConnector, TlsStream};
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    pub type Stream = TlsStream<TcpStream>;

    /// 先吐出预先读到的问候字节，再透传给底层流。
    pub struct Prefixed<S> {
        head: Vec<u8>,
        pos: usize,
        inner: S,
    }

    impl<S> Prefixed<S> {
        fn new(head: Vec<u8>, inner: S) -> Self {
            Self { head, pos: 0, inner }
        }
    }

    impl<S: Read> Read for Prefixed<S> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.pos < self.head.len() {
                let n = (self.head.len() - self.pos).min(buf.len());
                buf[..n].copy_from_slice(&self.head[self.pos..self.pos + n]);
                self.pos += n;
                Ok(n)
            } else {
                self.inner.read(buf)
            }
        }
    }

    impl<S: Write> Write for Prefixed<S> {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.inner.write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.inner.flush()
        }
    }

    impl SetReadTimeout for Prefixed<Stream> {
        fn set_read_timeout(&mut self, timeout: Option<Duration>) -> imap::Result<()> {
            self.inner
                .get_ref()
                // imap 结束 IDLE 时传入 None；恢复普通命令的超时，避免无限阻塞。
                .set_read_timeout(timeout.or(Some(Duration::from_secs(20))))
                .map_err(imap::Error::Io)
        }
    }

    fn read_line(stream: &mut Stream, buf: &mut Vec<u8>) -> Result<(), String> {
        let mut byte = [0u8; 1];
        loop {
            match stream.read(&mut byte) {
                Ok(0) => return Err("服务器关闭了连接".into()),
                Ok(_) => {
                    buf.push(byte[0]);
                    if buf.ends_with(b"\r\n") {
                        return Ok(());
                    }
                    if buf.len() > 8192 {
                        return Err("服务器响应过长".into());
                    }
                }
                Err(e) => return Err(format!("读取失败：{e}")),
            }
        }
    }

    pub fn connect(account: &Account, password: &str) -> Result<imap::Session<Prefixed<Stream>>, String> {
        let tls = TlsConnector::builder()
            .min_protocol_version(Some(native_tls::Protocol::Tlsv12))
            .build()
            .map_err(|_| "邮箱连接失败，请检查网络及服务设置".to_string())?;
        let host=account.provider.host().ok_or("不支持的 IMAP 邮箱")?;let port=993;let username=account.email.as_str();
        let tcp = std::net::ToSocketAddrs::to_socket_addrs(&(host,port)).map_err(|_|"邮箱域名无法解析")?.take(4).find_map(|address|TcpStream::connect_timeout(&address,Duration::from_secs(5)).ok()).ok_or_else(||std::io::Error::new(std::io::ErrorKind::TimedOut,"connect"))
            .map_err(|_| "邮箱连接失败，请检查网络及服务设置".to_string())?;
        let timeout = Some(Duration::from_secs(20));
        let _ = tcp.set_read_timeout(timeout);
        let _ = tcp.set_write_timeout(timeout);
        let mut stream = tls.connect(&host, tcp).map_err(|_| "邮箱连接失败，请检查网络及服务设置".to_string())?;

        // 1) 读问候，直到 "* OK" / "* PREAUTH"
        let mut greeting = Vec::new();
        loop {
            let mut line = Vec::new();
            read_line(&mut stream, &mut line)?;
            let upper = String::from_utf8_lossy(&line).to_ascii_uppercase();
            greeting.extend_from_slice(&line);
            if upper.starts_with("* BYE") {
                return Err("服务器拒绝连接".into());
            }
            if upper.starts_with("* OK") || upper.starts_with("* PREAUTH") {
                break;
            }
            if greeting.len() > 8192 {
                return Err("服务器问候异常".into());
            }
        }

        // 2) 网易系：LOGIN 之前先发 ID（RFC 2971）
        if account.provider==Provider::Mail163 {
            stream
                .write_all(b"A0001 ID (\"name\" \"GleamDesk\" \"version\" \"0.5.5\" \"vendor\" \"GleamDesk\")\r\n")
                .map_err(|_| "邮箱连接失败，请检查网络及服务设置".to_string())?;
            let _ = stream.flush();
            let mut ok = false;
            for _ in 0..20 {
                let mut line = Vec::new();
                read_line(&mut stream, &mut line)?;
                let text = String::from_utf8_lossy(&line).to_string();
                if text.starts_with("A0001 ") {
                    ok = text.to_ascii_uppercase().contains(" OK");
                    break;
                }
            }
            if !ok {
                return Err("服务器不接受 ID 命令".into());
            }
        }

        // 3) 把问候交回 imap，再正常登录
        let mut client = imap::Client::new(Prefixed::new(greeting, stream));
        client.read_greeting().map_err(|_| "邮箱连接失败，请检查网络及服务设置".to_string())?;
        let session = client
            .login(username, password)
            .map_err(|(e, _)| login_error(e))?;
        Ok(session)
    }

    pub fn login_error(e: imap::Error) -> String {
        match e {
            imap::Error::No(_) | imap::Error::Bad(_) => "登录被拒绝，请检查用户名、授权码和管理员的 IMAP/认证策略（不支持 OAuth-only）".into(),
            imap::Error::Io(_) => "登录时网络连接中断，请重试".into(),
            _ => "IMAP 登录失败，请核对服务器及认证方式".into(),
        }
    }

    /// 测试连接：连上、登录、选 INBOX，然后退出。
    pub fn probe(provider: Provider, secret: &Secret) -> Result<(), String> {
        let account=Account{id:String::new(),provider,email:secret.email.clone(),enabled:false};
        let mut session = connect(&account, &secret.authorization)?;
        session.examine("INBOX").map_err(|_|"无法只读打开收件箱")?;
        let _ = session.logout();
        Ok(())
    }

pub fn watch(account:&Account,secret:&Secret,mut cursor:Cursor,cancel:&AtomicBool,mut accept:impl FnMut(Cursor,Vec<Incoming>)->Result<(),String>)->Result<(),String>{
 let mut session=connect(account,&secret.authorization)?;
 let mailbox=session.examine("INBOX").map_err(|_|"无法只读打开收件箱")?;
 let validity=mailbox.uid_validity.ok_or("邮箱没有返回 UIDVALIDITY")?;
 if cursor.validity!=validity {cursor=Cursor{validity,..Cursor::default()};}
 let idle_supported=session.capabilities().map_err(|_|"无法读取邮箱功能")?.has_str("IDLE");
 while !cancel.load(Ordering::SeqCst){
  let permit=crate::simulation::require_live()?;
  let (next,items)=read_batch(&mut session,&cursor,||{permit.check()?;if cancel.load(Ordering::SeqCst){return Err("邮箱监听已停止".into())}Ok(())})?;
  accept(next.clone(),items)?;cursor=next;
  if cancel.load(Ordering::SeqCst){break}
  if idle_supported {
   // Short IDLE windows bound stop/remove latency; no detached socket survives indefinitely.
   session.idle().map_err(|_|"邮箱不接受监听命令")?.wait_with_timeout(Duration::from_secs(10)).map_err(|_|"邮箱监听中断，正在重连")?;
  }else{super::pause(cancel,30);session.noop().map_err(|_|"邮箱连接已断开")?;}
 }
 let _=session.logout();Ok(())
}


fn read_batch<S:Read+Write>(session:&mut imap::Session<S>,cursor:&Cursor,check:impl Fn()->Result<(),String>)->Result<(Cursor,Vec<Incoming>),String>{let validity=cursor.validity;
  let query=if cursor.uid==0 {format!("SINCE {}",(chrono::Utc::now()-chrono::Duration::days(1)).format("%d-%b-%Y"))}else{format!("UID {}:*",cursor.uid.saturating_add(1))};
  let mut uids=session.uid_search(query).map_err(|_|"无法检查新邮件")?.into_iter().filter(|u|*u>cursor.uid).collect::<Vec<_>>();
  uids.sort_unstable();
  // A reconnect only catches up the newest 20 messages, with an independent five-minute age guard.
  let mut next=cursor.clone();let mut items=Vec::new();
  for uid in uids.into_iter().rev().take(20).collect::<Vec<_>>().into_iter().rev(){
   check()?;
   let fetched=session.uid_fetch(uid.to_string(),"(UID INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER])").map_err(|_|"无法读取新邮件信息")?;
   let fetch=fetched.iter().find(|f|f.uid==Some(uid)).ok_or("新邮件尚未可读")?;
   let received=fetch.internal_date().map(|d|d.timestamp().max(0) as u64*1000).ok_or("邮件缺少接收时间")?;
   next.uid=next.uid.max(uid);
   if super::now_ms().saturating_sub(received)>300_000||fetch.size.unwrap_or(u32::MAX)>192*1024{continue}
   check()?;
   let fetched=session.uid_fetch(uid.to_string(),"(UID BODY.PEEK[])").map_err(|_|"无法只读读取验证码邮件")?;
   let Some(raw)=fetched.iter().find(|f|f.uid==Some(uid)).and_then(|f|f.body())else{continue};
   let Some((sender,subject,body))=super::api::parse_mime(raw)else{continue};
   items.push(Incoming{id:format!("{validity}-{uid}"),sender,subject,body,received});
  }

Ok((next,items))}

#[cfg(test)]mod tests{
 use super::*;use std::{io::Cursor as IoCursor,sync::{Arc,Mutex}};
 #[derive(Debug)]struct Wire{input:IoCursor<Vec<u8>>,output:Arc<Mutex<Vec<u8>>>}
 impl Read for Wire{fn read(&mut self,b:&mut[u8])->std::io::Result<usize>{self.input.read(b)}}
 impl Write for Wire{fn write(&mut self,b:&[u8])->std::io::Result<usize>{self.output.lock().unwrap().extend_from_slice(b);Ok(b.len())}fn flush(&mut self)->std::io::Result<()>{Ok(())}}
 fn run(age:i64,size:u32,body_response:bool)->(Cursor,Vec<Incoming>,String){
  let output=Arc::new(Mutex::new(Vec::new()));let date=(chrono::Utc::now()-chrono::Duration::seconds(age)).format("%d-%b-%Y %H:%M:%S +0000").to_string();
  let header="From: Example\r\nSubject: Login code\r\nContent-Type: text/plain\r\n\r\n";let raw=format!("{header}Your verification code is 834921.");
  let mut reply=format!("a1 OK login\r\n* SEARCH 41 42\r\na2 OK search\r\n* 1 FETCH (UID 42 INTERNALDATE \"{date}\" RFC822.SIZE {size} BODY[HEADER] {{{}}}\r\n{header})\r\na3 OK fetch\r\n",header.len());
  if body_response{reply.push_str(&format!("* 1 FETCH (UID 42 BODY[] {{{}}}\r\n{raw})\r\na4 OK fetch\r\n",raw.len()))}
  let mut session=imap::Client::new(Wire{input:IoCursor::new(reply.into_bytes()),output:output.clone()}).login("test","test").unwrap();
  let (cursor,items)=read_batch(&mut session,&Cursor{uid:41,validity:7,seen:vec![]},||Ok(())).unwrap();
  let commands=String::from_utf8(output.lock().unwrap().clone()).unwrap();(cursor,items,commands)
 }
 #[test]fn reconnect_uses_uid_cursor_and_peek_without_marking_read(){let (cursor,items,commands)=run(0,150,true);assert_eq!(cursor.uid,42);assert_eq!(items.len(),1);assert_eq!(items[0].id,"7-42");assert!(commands.contains("UID SEARCH UID 42:*"));assert!(commands.contains("BODY.PEEK[]"));assert!(!commands.contains("STORE")&&!commands.contains("SELECT"));}
 #[test]fn old_or_large_mail_advances_cursor_without_reading_body(){for (age,size) in [(400,100),(0,300_000)]{let (cursor,items,commands)=run(age,size,false);assert_eq!(cursor.uid,42);assert!(items.is_empty());assert!(!commands.contains("BODY.PEEK[]"));}}
}
