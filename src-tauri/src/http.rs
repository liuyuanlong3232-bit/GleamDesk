    use std::{ffi::c_void, ptr};

    type HInternet = *mut c_void;
    const WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY: u32 = 4;
    const WINHTTP_FLAG_SECURE: u32 = 0x0080_0000;
    const WINHTTP_QUERY_STATUS_CODE: u32 = 19;
    const WINHTTP_QUERY_FLAG_NUMBER: u32 = 0x2000_0000;
    const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

    #[link(name = "Winhttp")]
    unsafe extern "system" {
        fn WinHttpOpen(agent: *const u16, access_type: u32, proxy: *const u16, bypass: *const u16, flags: u32) -> HInternet;
        fn WinHttpConnect(session: HInternet, server: *const u16, port: u16, reserved: u32) -> HInternet;
        fn WinHttpOpenRequest(connect: HInternet, verb: *const u16, object_name: *const u16, version: *const u16,
            referrer: *const u16, accept_types: *const *const u16, flags: u32) -> HInternet;
        fn WinHttpSetTimeouts(handle: HInternet, resolve: i32, connect: i32, send: i32, receive: i32) -> i32;
        fn WinHttpSetOption(handle: HInternet, option: u32, buffer: *const c_void, length: u32) -> i32;
        fn WinHttpSendRequest(request: HInternet, headers: *const u16, header_length: u32, optional: *mut c_void,
            optional_length: u32, total_length: u32, context: usize) -> i32;
        fn WinHttpReceiveResponse(request: HInternet, reserved: *mut c_void) -> i32;
        fn WinHttpQueryHeaders(request: HInternet, level: u32, name: *const u16, buffer: *mut c_void,
            buffer_length: *mut u32, index: *mut u32) -> i32;
        fn WinHttpQueryDataAvailable(request: HInternet, available: *mut u32) -> i32;
        fn WinHttpReadData(request: HInternet, buffer: *mut c_void, bytes_to_read: u32, bytes_read: *mut u32) -> i32;
        fn WinHttpCloseHandle(handle: HInternet) -> i32;
    }

    struct Handle(HInternet);
    impl Drop for Handle { fn drop(&mut self) { if !self.0.is_null() { unsafe { WinHttpCloseHandle(self.0); } } } }

    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }

    // Fixed diagnostic tokens only: never include URLs, headers or response text.
    fn public_transport_failure(host: &str, anonymous: bool, stage: &str, code: Option<i32>) -> String {
        if anonymous && host == "fred.stlouisfed.org" && matches!(stage, "send" | "receive") {
            return format!("FRED_HTTP_{stage}_{}", code.filter(|v| *v > 0).unwrap_or(0));
        }
        "服务 网络连接失败或请求超时".into()
    }

    pub fn get(host_name: &str, port: u16, secure: bool, path: &str, header_text: &str) -> Result<(u32, Vec<u8>), String> {
        get_request(host_name,port,secure,path,header_text,false,MAX_RESPONSE_BYTES,&||Ok(()))
    }
    pub(crate) fn anonymous_get(host:&str,port:u16,path:&str,check:&impl Fn()->Result<(),String>)->Result<(u32,Vec<u8>),String>{
        get_request(host,port,true,path,"Accept: application/json\r\n",true,512*1024,check)
    }
    pub(crate) fn vps_service_get(host:&str,port:u16,secure:bool,path:&str,headers:&str,check:&impl Fn()->Result<(),String>)->Result<(u32,Vec<u8>),String>{
        // User-configured service: explicit Bearer only, no automatic Windows auth,
        // cookies, redirects or retries. Endpoint policy is checked by vps_services.
        get_request(host,port,secure,path,headers,true,256*1024,check)
    }
    pub(crate) fn china_futures_get(path:&str,check:&impl Fn()->Result<(),String>)->Result<(u32,Vec<u8>),String>{
        get_request("hq.sinajs.cn",443,true,path,"Accept: text/plain\r\nReferer: https://finance.sina.com.cn/\r\n",true,65536,check)
    }
    pub(crate) fn wasde_get(path:&str,check:&impl Fn()->Result<(),String>)->Result<(u32,Vec<u8>),String>{
        // Only the fixed USDA report page and validated monthly XML get the larger cap.
        if path!=crate::public_sources::WASDE_PAGE && !crate::public_sources::wasde_xml_path(path).is_some_and(|(_,p)|p==path){return Err("USDA 地址无效".into());}
        let cap=if path==crate::public_sources::WASDE_PAGE{512*1024}else{4*1024*1024};
        get_request("www.usda.gov",443,true,path,"Accept: application/xml,text/html\r\n",true,cap,check)
    }
    pub(crate) fn nass_get(path:&str,check:&impl Fn()->Result<(),String>)->Result<(u32,Vec<u8>),String>{
        let annual=path=="/publication/crop-production-annual-summary"||crate::public_sources::nass_report_kind(path)==Some("nass-annual");
        if !annual&&path!="/publication/crop-progress"&&crate::public_sources::nass_report_kind(path)!=Some("crop-progress"){return Err("NASS 地址无效".into());}
        get_request("esmis.nal.usda.gov",443,true,path,"Accept: text/plain,text/html\r\n",true,if annual{1024*1024}else{512*1024},check)
    }
    pub(crate) fn argentina_get(path:&str,check:&impl Fn()->Result<(),String>)->Result<(u32,Vec<u8>),String>{
        let page=crate::argentina::directory_path(path);
        if !page&&!crate::argentina::file_path(path).is_some_and(|p|p==path){return Err("阿根廷月报地址无效".into());}
        get_request("www.magyp.gob.ar",443,true,path,"Accept: application/pdf,text/html\r\n",true,if page{512*1024}else{4*1024*1024},check)
    }
    pub(crate) fn conab_get(path:&str,check:&impl Fn()->Result<(),String>)->Result<(u32,Vec<u8>),String>{
        let page=path==crate::conab::PAGE;
        if !page&&!crate::conab::file_path(path).is_some_and(|p|p==path){return Err("CONAB 地址无效".into());}
        get_request("www.gov.br",443,true,path,"Accept: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/html\r\n",true,if page{512*1024}else{2*1024*1024},check)
    }
    pub(crate) fn worldbank_get(host:&str,path:&str,check:&impl Fn()->Result<(),String>)->Result<(u32,Vec<u8>),String>{
        let page=host=="www.worldbank.org"&&path==crate::worldbank::PAGE;
        let file=host=="thedocs.worldbank.org"&&crate::worldbank::file_path(path).is_some_and(|p|p==path);
        if !page&&!file{return Err("世界银行地址无效".into());}
        get_request(host,443,true,path,"Accept: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/html\r\n",true,if file{2*1024*1024}else{512*1024},check)
    }
    fn get_request(host_name:&str,port:u16,secure:bool,path:&str,header_text:&str,anonymous:bool,max_bytes:usize,check:&impl Fn()->Result<(),String>)->Result<(u32,Vec<u8>),String>{
        let deadline=std::time::Instant::now()+std::time::Duration::from_secs(20);
        let ensure=||->Result<(),String>{check()?;if anonymous&&std::time::Instant::now()>=deadline{return Err("自定义接口读取超时".into());}Ok(())};
        ensure()?;
        let agent = wide("AgentRoom/0.1");
        let host = wide(host_name);
        let verb = wide("GET");
        let target = wide(path);
        let mut headers = wide(header_text);
        let session = Handle(unsafe { WinHttpOpen(agent.as_ptr(), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, ptr::null(), ptr::null(), 0) });
        if session.0.is_null() { return Err("无法初始化 Windows HTTP 客户端".into()); }
        if unsafe { WinHttpSetTimeouts(session.0, 5_000, 8_000, 8_000, 8_000) } == 0 {
            headers.fill(0); return Err("无法设置网络超时".into());
        }
        if anonymous {let attempts=0u32;if unsafe{WinHttpSetOption(session.0,4,&attempts as *const _ as *const c_void,4)}==0{return Err("自定义接口连接策略设置失败".into());}}
        let connection = Handle(unsafe { WinHttpConnect(session.0, host.as_ptr(), port, 0) });
        if connection.0.is_null() { headers.fill(0); return Err("无法连接到 服务".into()); }
        let flags = if secure { WINHTTP_FLAG_SECURE } else { 0 };
        let request = Handle(unsafe { WinHttpOpenRequest(connection.0, verb.as_ptr(), target.as_ptr(), ptr::null(), ptr::null(), ptr::null(), flags) });
        if request.0.is_null() { headers.fill(0); return Err("无法创建服务 API 请求".into()); }
        if anonymous {
            // Disable automatic Windows authentication, cookies and redirects for user-selected hosts.
            let disabled=1u32|2u32|4u32; // WINHTTP_DISABLE_COOKIES | REDIRECTS | AUTHENTICATION
            if unsafe{WinHttpSetOption(request.0,63,&disabled as *const _ as *const c_void,4)}==0{return Err("自定义接口匿名读取策略设置失败".into());}
        }
        let redirect_policy = 0_u32;
        if unsafe { WinHttpSetOption(request.0, 88, &redirect_policy as *const _ as *const c_void, 4) } == 0 {
            headers.fill(0); return Err("无法设置 HTTP 重定向策略".into());
        }
        ensure()?;
        let sent = unsafe { WinHttpSendRequest(request.0, headers.as_ptr(), u32::MAX, ptr::null_mut(), 0, 0, 0) } != 0;
        let send_error = if !sent { Some(std::io::Error::last_os_error().raw_os_error()) } else { None };
        headers.fill(0);
        if let Some(code) = send_error {
            return Err(public_transport_failure(host_name, anonymous, "send", code));
        }
        if unsafe { WinHttpReceiveResponse(request.0, ptr::null_mut()) } == 0 {
            let code = std::io::Error::last_os_error().raw_os_error();
            return Err(public_transport_failure(host_name, anonymous, "receive", code));
        }
        let mut status = 0_u32;
        let mut status_size = std::mem::size_of::<u32>() as u32;
        if unsafe { WinHttpQueryHeaders(request.0, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, ptr::null(), &mut status as *mut _ as *mut c_void, &mut status_size, ptr::null_mut()) } == 0 {
            return Err("无法读取 服务 API 响应状态".into());
        }
        let mut response = Vec::new();
        loop {
            ensure()?;
            let mut available = 0_u32;
            if unsafe { WinHttpQueryDataAvailable(request.0, &mut available) } == 0 { return Err("读取 服务 API 响应失败".into()); }
            if available == 0 { break; }
            if response.len().saturating_add(available as usize)>max_bytes{return Err(if max_bytes==256*1024{"服务响应超过 256 KB，暂不可用"}else if max_bytes==512*1024{"接口响应超过 512 KB，请缩小查询范围"}else if max_bytes==MAX_RESPONSE_BYTES{"服务 API 响应超过 2 MB 限制"}else{"USDA 月报超过 4 MB 限制，暂不可用"}.into());}
            let start = response.len();
            response.resize(start + available as usize, 0);
            let mut received = 0_u32;
            if unsafe { WinHttpReadData(request.0, response[start..].as_mut_ptr() as *mut c_void, available, &mut received) } == 0 {
                return Err("读取 服务 API 响应失败".into());
            }
            response.truncate(start + received as usize);
        }
        ensure()?;Ok((status, response))
    }

    pub(crate) fn public_dns_json(host: &str, path: &str, deadline: std::time::Instant) -> Result<Vec<u8>, String> {
        if !matches!(host, "cloudflare-dns.com" | "dns.google") { return Err("DNS服务地址无效".into()); }
        public_metadata_json(host,path,deadline,&||Ok(()))
    }
    pub(crate) fn ip_location_json(ip:&str,language:&str,deadline:std::time::Instant,check:&impl Fn()->Result<(),String>)->Result<Vec<u8>,String>{
        let ip=ip.parse::<std::net::IpAddr>().map_err(|_|"所在地IP无效")?;
        if !crate::beszel::public_location_ip(ip){return Err("所在地查询仅支持公网IP".into())}
        if !matches!(language,"en"|"zh-CN"){return Err("所在地语言无效".into())}
        public_metadata_json("ipwho.is",&format!("/{ip}?lang={language}&fields=success,ip,country,country_code,city"),deadline,check)
    }
    fn public_metadata_json(host:&str,path:&str,deadline:std::time::Instant,check:&impl Fn()->Result<(),String>)->Result<Vec<u8>,String>{
        let remaining = || -> Result<i32,String> {
            check()?;
            let ms=deadline.checked_duration_since(std::time::Instant::now()).ok_or("公共DNS查询超时")?.as_millis();
            if ms==0 { return Err("公共DNS查询超时".into()); } Ok(ms.min(i32::MAX as u128) as i32)
        };
        let timeouts = |handle:HInternet| -> Result<(),String> {
            let ms=remaining()?;
            if unsafe {WinHttpSetTimeouts(handle,ms.min(2000),ms.min(3000),ms.min(3000),ms)}==0 {return Err("DNS超时设置失败".into());} Ok(())
        };
        let agent=wide("AgentRoom DNS compare");let server=wide(host);let target=wide(path);let verb=wide("GET");
        let session=Handle(unsafe{WinHttpOpen(agent.as_ptr(),WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,ptr::null(),ptr::null(),0)});
        if session.0.is_null(){return Err("公共DNS客户端不可用".into());} timeouts(session.0)?;
        let attempts=0u32;if unsafe{WinHttpSetOption(session.0,4,&attempts as *const _ as *const c_void,4)}==0 {return Err("DNS连接策略设置失败".into());}
        let connection=Handle(unsafe{WinHttpConnect(session.0,server.as_ptr(),443,0)});
        if connection.0.is_null(){return Err("DNS服务连接失败".into());}
        let request=Handle(unsafe{WinHttpOpenRequest(connection.0,verb.as_ptr(),target.as_ptr(),ptr::null(),ptr::null(),ptr::null(),WINHTTP_FLAG_SECURE)});
        if request.0.is_null(){return Err("DNS请求创建失败".into());}
        let redirect=0u32;let disable=1u32|4u32;
        if unsafe{WinHttpSetOption(request.0,88,&redirect as *const _ as *const c_void,4)}==0
            || unsafe{WinHttpSetOption(request.0,63,&disable as *const _ as *const c_void,4)}==0 {return Err("DNS请求策略设置失败".into());}
        let headers=wide(if host=="ipwho.is"{"Accept: application/json\r\n"}else{"Accept: application/dns-json\r\n"});timeouts(request.0)?;
        if unsafe{WinHttpSendRequest(request.0,headers.as_ptr(),u32::MAX,ptr::null_mut(),0,0,0)}==0 {return Err("DNS请求发送失败".into());}
        timeouts(request.0)?;
        if unsafe{WinHttpReceiveResponse(request.0,ptr::null_mut())}==0 {return Err("DNS响应读取失败".into());}
        remaining()?;let mut status=0u32;let mut size=4u32;
        if unsafe{WinHttpQueryHeaders(request.0,WINHTTP_QUERY_STATUS_CODE|WINHTTP_QUERY_FLAG_NUMBER,ptr::null(),&mut status as *mut _ as *mut c_void,&mut size,ptr::null_mut())}==0 {return Err("DNS HTTP状态不可读".into());}
        if status!=200 {return Err(format!("DNS服务返回HTTP {status}"));}
        let mut response=Vec::new();
        loop {
            timeouts(request.0)?;let mut available=0u32;
            if unsafe{WinHttpQueryDataAvailable(request.0,&mut available)}==0 {return Err("DNS响应不可读".into());}remaining()?;
            if available==0 {break;}
            if response.len().saturating_add(available as usize)>65536 {return Err("DNS响应超过64KB".into());}
            let start=response.len();response.resize(start+available as usize,0);timeouts(request.0)?;let mut received=0u32;
            if unsafe{WinHttpReadData(request.0,response[start..].as_mut_ptr() as *mut c_void,available,&mut received)}==0 {return Err("DNS响应读取失败".into());}
            response.truncate(start+received as usize);remaining()?;if received==0 {break;}
        }
        Ok(response)
    }

    pub(crate) fn local_ollama_json(path: &str, body: Option<&[u8]>) -> Result<(u32, Vec<u8>), String> {
        if !matches!((path, body.is_some()), ("/api/tags", false) | ("/api/ps", false) | ("/api/show", true)) {
            return Err("Ollama 元数据接口无效".into());
        }
        local_json_request(11434, path, body)
    }

    fn local_json_request(port: u16, path: &str, body: Option<&[u8]>) -> Result<(u32, Vec<u8>), String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
        let remaining = || -> Result<i32, String> {
            let ms = deadline.checked_duration_since(std::time::Instant::now()).ok_or("Ollama 本地读取超时")?.as_millis();
            if ms == 0 { return Err("Ollama 本地读取超时".into()); }
            Ok(ms.min(i32::MAX as u128) as i32)
        };
        let timeouts = |handle: HInternet| -> Result<(), String> {
            let ms = remaining()?;
            if unsafe { WinHttpSetTimeouts(handle, ms.min(1000), ms.min(1000), ms.min(1000), ms) } == 0 { return Err("本地 HTTP 超时设置失败".into()); }
            Ok(())
        };
        let agent = wide("AgentRoom local metadata"); let host = wide("127.0.0.1"); let target = wide(path);
        let verb = wide(if body.is_some() { "POST" } else { "GET" });
        // A numeric loopback host and NO_PROXY prevent local metadata from being sent to a proxy.
        let session = Handle(unsafe { WinHttpOpen(agent.as_ptr(), 1, ptr::null(), ptr::null(), 0) });
        if session.0.is_null() { return Err("本地 HTTP 初始化失败".into()); }
        timeouts(session.0)?;
        let connection = Handle(unsafe { WinHttpConnect(session.0, host.as_ptr(), port, 0) });
        if connection.0.is_null() { return Err("Ollama 服务不可达".into()); }
        let request = Handle(unsafe { WinHttpOpenRequest(connection.0, verb.as_ptr(), target.as_ptr(), ptr::null(), ptr::null(), ptr::null(), 0) });
        if request.0.is_null() { return Err("本地 HTTP 请求失败".into()); }
        let redirect_policy = 0u32; let disable = 1u32 | 4u32;
        if unsafe { WinHttpSetOption(request.0, 88, &redirect_policy as *const _ as *const c_void, 4) } == 0
            || unsafe { WinHttpSetOption(request.0, 63, &disable as *const _ as *const c_void, 4) } == 0 { return Err("本地 HTTP 策略设置失败".into()); }
        let body = body.unwrap_or_default(); if body.len() > 1024 { return Err("模型信息请求超限".into()); }
        let headers = wide("Content-Type: application/json\r\nAccept: application/json\r\n");
        timeouts(request.0)?;
        if unsafe { WinHttpSendRequest(request.0, headers.as_ptr(), u32::MAX, body.as_ptr() as *mut c_void, body.len() as u32, body.len() as u32, 0) } == 0 { return Err("Ollama 服务不可达".into()); }
        timeouts(request.0)?;
        if unsafe { WinHttpReceiveResponse(request.0, ptr::null_mut()) } == 0 { return Err("Ollama 本地读取失败".into()); }
        remaining()?;
        let mut status = 0u32; let mut size = 4u32;
        if unsafe { WinHttpQueryHeaders(request.0, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, ptr::null(), &mut status as *mut _ as *mut c_void, &mut size, ptr::null_mut()) } == 0 { return Err("本地 HTTP 状态不可读".into()); }
        if status != 200 { return Ok((status, Vec::new())); }
        let mut response = Vec::new();
        loop {
            timeouts(request.0)?;
            let mut available = 0u32;
            if unsafe { WinHttpQueryDataAvailable(request.0, &mut available) } == 0 { return Err("Ollama 本地响应读取失败".into()); }
            remaining()?;
            if available == 0 { break; }
            if response.len().saturating_add(available as usize) > MAX_RESPONSE_BYTES { return Err("Ollama 元数据超过2MiB".into()); }
            let start = response.len(); response.resize(start + available as usize, 0);
            timeouts(request.0)?;
            let mut received = 0u32;
            if unsafe { WinHttpReadData(request.0, response[start..].as_mut_ptr() as *mut c_void, available, &mut received) } == 0 { return Err("Ollama 本地响应读取失败".into()); }
            response.truncate(start + received as usize); remaining()?;
            if received == 0 { break; }
        }
        Ok((status, response))
    }

    // A single manually initiated inference request. No retry, redirect, cookies, or custom host.
    // Recompute the remaining absolute deadline before each potentially blocking operation.
    pub fn post_json(host_name: &str, path: &str, header_text: &str, body: &[u8], deadline: std::time::Instant,
        check: &impl Fn() -> Result<(),String>) -> Result<(u32,Vec<u8>),String> {
        if !matches!((host_name,path),("api.deepseek.com","/chat/completions")|("api.anthropic.com","/v1/messages")|("api.xiaomimimo.com","/v1/chat/completions")) || body.len() > 256*1024 {
            return Err("推理请求目标或大小无效".into());
        }
        post_request_json(host_name,443,true,path,header_text,body,deadline,check)
    }

    pub(crate) fn post_pocketbase_auth(host_name: &str, port: u16, secure: bool, path: &str, body: &[u8],
        deadline: std::time::Instant, check: &impl Fn() -> Result<(),String>) -> Result<(u32,Vec<u8>),String> {
        if (!secure && !matches!(host_name,"127.0.0.1"|"::1"|"localhost"))
            || !path.starts_with('/') || !path.ends_with("/api/collections/users/auth-with-password") || body.len()>16*1024 {
            return Err("Beszel 账户登录需要 HTTPS Hub 或本机回环地址，以及标准用户认证接口".into());
        }
        post_request_json(host_name,port,secure,path,"Content-Type: application/json\r\nAccept: application/json\r\n",body,deadline,check)
    }

    // Room-specific allowlist: no arbitrary hosts, redirects or attachment upload endpoints.
    pub(crate) fn post_room_json(host:&str,path:&str,headers:&str,body:&[u8],deadline:std::time::Instant,check:&impl Fn()->Result<(),String>)->Result<(u32,Vec<u8>),String>{
        let fixed=matches!((host,path),("api.deepseek.com","/chat/completions")|("api.openai.com","/v1/chat/completions")|("api.anthropic.com","/v1/messages")|("api.xiaomimimo.com","/v1/chat/completions")|("dashscope.aliyuncs.com","/compatible-mode/v1/chat/completions")|("api.moonshot.cn","/v1/chat/completions")|("api.x.ai","/v1/chat/completions")|("ark.cn-beijing.volces.com","/api/v3/chat/completions"));
        let gemini=host=="generativelanguage.googleapis.com"&&path.strip_prefix("/v1beta/models/").and_then(|v|v.strip_suffix(":generateContent")).is_some_and(|model|!model.is_empty()&&model.len()<=180&&!model.contains("..")&&model.bytes().all(|b|b.is_ascii_alphanumeric()||b"-_.".contains(&b)));
        if (!fixed&&!gemini)||body.len()>700*1024{return Err("聊天室请求目标或大小无效".into())}
        post_request_json(host,443,true,path,headers,body,deadline,check)
    }
    pub(crate) fn post_room_ollama(body:&[u8],deadline:std::time::Instant,check:&impl Fn()->Result<(),String>)->Result<(u32,Vec<u8>),String>{
        if body.len()>700*1024{return Err("聊天室本地请求超过上限".into())}
        post_request_json("127.0.0.1",11434,false,"/api/chat","Content-Type: application/json\r\n",body,deadline,check)
    }

    pub(crate) fn post_ollama_chat(body:&[u8],deadline:std::time::Instant,check:&impl Fn()->Result<(),String>)->Result<(u32,Vec<u8>),String>{
        if body.len()>64*1024{return Err("本地讨论请求超过上限".into());}
        post_request_json("127.0.0.1",11434,false,"/api/chat","Content-Type: application/json\r\n",body,deadline,check)
    }
    pub(crate) fn post_mail_oauth(host:&str,path:&str,body:&[u8],deadline:std::time::Instant)->Result<(u32,Vec<u8>),String>{
        if !matches!((host,path),("oauth2.googleapis.com","/token")|("login.microsoftonline.com","/common/oauth2/v2.0/token"))||body.len()>32768{return Err("邮箱OAuth目标或大小无效".into());}
        post_request_json(host,443,true,path,"Content-Type: application/x-www-form-urlencoded\r\nAccept: application/json\r\n",body,deadline,&||Ok(()))
    }
    pub(crate) fn mail_get_http(host:&str,path:&str,headers:&str,deadline:std::time::Instant)->Result<(u32,Vec<u8>),String>{
        if !matches!(host,"gmail.googleapis.com"|"graph.microsoft.com")||path.len()>3000||path.contains("..")||path.contains('\r')||path.contains('\n'){return Err("邮箱读取目标无效".into());}
        post_request_json(host,443,true,path,headers,b"",deadline,&||Ok(()))
    }
    pub(crate) fn mail_mark_read_http(host:&str,path:&str,method:&str,headers:&str,body:&[u8],deadline:std::time::Instant)->Result<(u32,Vec<u8>),String>{
        let allowed=match (host,method){
            ("gmail.googleapis.com","POST")=>path.starts_with("/gmail/v1/users/me/messages/")&&path.ends_with("/modify")&&body==b"{\"removeLabelIds\":[\"UNREAD\"]}",
            ("graph.microsoft.com","PATCH")=>path.starts_with("/v1.0/me/messages/")&&body==b"{\"isRead\":true}",
            _=>false,
        };
        if !allowed||path.contains("..")||path.contains('?')||path.len()>1800{return Err("邮箱状态操作不在允许范围内".into());}
        post_request_json(host,443,true,path,headers,body,deadline,&||Ok(()))
    }
    fn post_request_json(host_name: &str, port: u16, secure: bool, path: &str, header_text: &str, body: &[u8],
        deadline: std::time::Instant, check: &impl Fn() -> Result<(),String>) -> Result<(u32,Vec<u8>),String> {
        struct Headers(Vec<u16>);
        impl Drop for Headers { fn drop(&mut self) { self.0.fill(0); } }
        let mut headers = Headers(wide(header_text));
        let agent = wide("AgentRoom/0.1"); let host = wide(host_name); let verb = wide(if host_name=="graph.microsoft.com"{if body.is_empty(){"GET"}else{"PATCH"}}else if host_name=="gmail.googleapis.com"&&body.is_empty(){"GET"}else{"POST"}); let target = wide(path);
        let remaining = || -> Result<i32,String> {
            check()?;
            let millis = deadline.checked_duration_since(std::time::Instant::now()).ok_or("推理请求达到 60 秒总超时；未自动重试")?.as_millis();
            if millis == 0 { return Err("推理请求达到 60 秒总超时；未自动重试".into()); }
            Ok(millis.min(i32::MAX as u128) as i32)
        };
        let timeouts = |handle: HInternet| -> Result<(),String> {
            let ms = remaining()?;
            let phase = (ms/3).max(1);
            if unsafe { WinHttpSetTimeouts(handle,phase.min(5_000),phase.min(8_000),phase.min(8_000),ms.min(30_000)) } == 0 { return Err("无法设置推理请求超时".into()); }
            Ok(())
        };
        remaining()?;
        let session = Handle(unsafe { WinHttpOpen(agent.as_ptr(),if !secure && matches!(host_name,"127.0.0.1"|"localhost"|"::1") {1} else {WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY},ptr::null(),ptr::null(),0) });
        if session.0.is_null() { return Err("无法初始化推理 HTTP 客户端".into()); }
        timeouts(session.0)?;
        let connect_attempts = 1u32;
        let failed_retries = [0u32,0u32];
        if unsafe { WinHttpSetOption(session.0,4,&connect_attempts as *const _ as *const c_void,4) } == 0
            || unsafe { WinHttpSetOption(session.0,162,failed_retries.as_ptr() as *const c_void,8) } == 0 { return Err("此 Windows HTTP 版本无法禁用推理重试".into()); }
        let connection = Handle(unsafe { WinHttpConnect(session.0,host.as_ptr(),port,0) });
        if connection.0.is_null() { return Err("无法连接推理服务".into()); }
        remaining()?;
        let flags=if secure {WINHTTP_FLAG_SECURE} else {0};
        let request = Handle(unsafe { WinHttpOpenRequest(connection.0,verb.as_ptr(),target.as_ptr(),ptr::null(),ptr::null(),ptr::null(),flags) });
        if request.0.is_null() { return Err("无法创建推理请求".into()); }
        let redirect_policy = 0u32;
        let disable = 0x0000_0001u32 | 0x0000_0004u32; // WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION
        if unsafe { WinHttpSetOption(request.0,88,&redirect_policy as *const _ as *const c_void,4) } == 0
            || unsafe { WinHttpSetOption(request.0,63,&disable as *const _ as *const c_void,4) } == 0 { return Err("无法设置推理请求策略".into()); }
        timeouts(request.0)?;
        let sent = unsafe { WinHttpSendRequest(request.0,headers.0.as_ptr(),u32::MAX,body.as_ptr() as *mut c_void,body.len() as u32,body.len() as u32,0) } != 0;
        headers.0.fill(0);
        remaining()?;
        if !sent { return Err("推理请求发送失败或超时；未自动重试".into()); }
        timeouts(request.0)?;
        let header_deadline = remaining()?.min(30_000) as u32;
        if unsafe { WinHttpSetOption(request.0,7,&header_deadline as *const _ as *const c_void,4) } == 0 { return Err("无法设置推理响应头超时".into()); }
        if unsafe { WinHttpReceiveResponse(request.0,ptr::null_mut()) } == 0 { return Err("推理响应失败或超时；未自动重试".into()); }
        remaining()?;
        let mut status = 0u32; let mut size = 4u32;
        if unsafe { WinHttpQueryHeaders(request.0,WINHTTP_QUERY_STATUS_CODE|WINHTTP_QUERY_FLAG_NUMBER,ptr::null(),&mut status as *mut _ as *mut c_void,&mut size,ptr::null_mut()) } == 0 { return Err("无法读取推理响应状态".into()); }
        // Do not parse or expose remote error bodies; they can echo sensitive input.
        if status != 200 { return Ok((status,Vec::new())); }
        let mut response = Vec::new();
        loop {
            timeouts(request.0)?;
            let mut available = 0u32;
            if unsafe { WinHttpQueryDataAvailable(request.0,&mut available) } == 0 { return Err("读取推理响应失败或超时".into()); }
            remaining()?;
            if available == 0 { break; }
            if response.len().saturating_add(available as usize) > 256*1024 { return Err("推理响应超过 256 KiB 上限".into()); }
            timeouts(request.0)?;
            let start = response.len(); response.resize(start+available as usize,0);
            let mut received = 0u32;
            if unsafe { WinHttpReadData(request.0,response[start..].as_mut_ptr() as *mut c_void,available,&mut received) } == 0 { return Err("读取推理响应失败或超时".into()); }
            remaining()?;
            if received == 0 { return Err("推理响应意外中断".into()); }
            response.truncate(start+received as usize);
        }
        Ok((status,response))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn fred_diagnostics_are_fixed_stage_and_numeric_code_without_network() {
            assert_eq!(public_transport_failure("fred.stlouisfed.org",true,"receive",Some(12002)),"FRED_HTTP_receive_12002");
            assert_eq!(public_transport_failure("fred.stlouisfed.org",true,"send",Some(12029)),"FRED_HTTP_send_12029");
            assert_eq!(public_transport_failure("fred.stlouisfed.org",true,"send",None),"FRED_HTTP_send_0");
            assert_eq!(public_transport_failure("fred.stlouisfed.org",true,"send",Some(-1)),"FRED_HTTP_send_0");
            for (host,anonymous,stage) in [("other.test",true,"send"),("fred.stlouisfed.org",false,"receive"),("fred.stlouisfed.org",true,"header-secret")] {
                assert_eq!(public_transport_failure(host,anonymous,stage,Some(12002)),"服务 网络连接失败或请求超时");
            }
        }
        #[test]
        fn loopback_ollama_transport_reads_started_empty_multiple_running_and_show_then_stops() {
            use std::{io::{Read,Write}, net::TcpListener, time::{Duration,Instant}};
            let listener=TcpListener::bind("127.0.0.1:0").unwrap();
            let port=listener.local_addr().unwrap().port();
            let fixture=std::thread::spawn(move||{
                let bodies=[r#"{"models":[]}"#,r#"{"models":[{"name":"qwen2.5:3b","size":100},{"name":"deepseek:8b","size":200}]}"#,r#"{"models":[{"name":"qwen2.5:3b","size_vram":50}]}"#,r#"{"details":{"family":"qwen2","parameter_size":"3B"},"capabilities":["completion"]}"#];
                for (index,body) in bodies.into_iter().enumerate(){
                    let (mut stream,_)=listener.accept().unwrap();stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                    let mut request=Vec::new();let mut bytes=[0u8;2048];
                    loop{
                        let count=stream.read(&mut bytes).unwrap();if count==0{break;}request.extend_from_slice(&bytes[..count]);
                        if let Some(end)=request.windows(4).position(|part|part==b"\r\n\r\n"){
                            let headers=String::from_utf8_lossy(&request[..end]);
                            let length=headers.lines().find_map(|line|line.split_once(':').filter(|(key,_)|key.eq_ignore_ascii_case("content-length")).and_then(|(_,value)|value.trim().parse::<usize>().ok())).unwrap_or(0);
                            if request.len()>=end+4+length{break;}
                        }
                    }
                    assert!(String::from_utf8_lossy(&request).starts_with(if index==3{"POST /api/show"}else if index==2{"GET /api/ps"}else{"GET /api/tags"}));
                    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
                }
            });
            let read=|path|{let(status,bytes)=local_json_request(port,path,None).unwrap();assert_eq!(status,200);serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()};
            let empty=read("/api/tags");let running_empty=serde_json::json!({"models":[]});
            assert_eq!(crate::ollama::snapshot_from_responses(&empty,&running_empty).unwrap().model_count,Some(0));
            let multiple=read("/api/tags");let running=read("/api/ps");
            assert_eq!(crate::ollama::snapshot_from_responses(&multiple,&running).unwrap().model_count,Some(2));
            let(status,show)=local_json_request(port,"/api/show",Some(br#"{"model":"qwen2.5:3b"}"#)).unwrap();assert_eq!(status,200);assert!(String::from_utf8_lossy(&show).contains("completion"));
            fixture.join().unwrap();let start=Instant::now();assert!(local_json_request(port,"/api/tags",None).is_err());assert!(start.elapsed()<Duration::from_secs(5));
        }
        #[test]
        fn inference_transport_denies_other_endpoints_and_cancelled_requests_before_any_http() {
            let deadline = std::time::Instant::now()+std::time::Duration::from_secs(60);
            assert!(post_json("localhost","/chat/completions","",b"{}",deadline,&||Ok(())).is_err());
            assert!(post_json("api.deepseek.com","/other","",b"{}",deadline,&||Ok(())).is_err());
            assert!(post_json("api.deepseek.com","/chat/completions","",b"{}",deadline,&||Err("cancelled".into())).unwrap_err().contains("cancelled"));
        }
        #[test]
        fn native_http_supports_the_required_no_retry_policy_without_network_or_credentials() {
            let agent = wide("AgentRoom policy check");
            let session = Handle(unsafe { WinHttpOpen(agent.as_ptr(),WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,ptr::null(),ptr::null(),0) });
            assert!(!session.0.is_null());
            let attempts = 1u32; let retries = [0u32,0u32];
            assert_ne!(unsafe { WinHttpSetOption(session.0,4,&attempts as *const _ as *const c_void,4) },0);
            assert_ne!(unsafe { WinHttpSetOption(session.0,162,retries.as_ptr() as *const c_void,8) },0,"Windows HTTP does not support the inference no-retry policy");
        }
        #[test]
        fn account_auth_transport_denies_plaintext_remote_hosts_and_other_endpoints() {
            let deadline=std::time::Instant::now()+std::time::Duration::from_secs(30);
            assert!(post_pocketbase_auth("example.com",80,false,"/api/collections/users/auth-with-password",b"{}",deadline,&||Ok(())).is_err());
            assert!(post_pocketbase_auth("localhost",8090,false,"/api/collections/_superusers/auth-with-password",b"{}",deadline,&||Ok(())).is_err());
            assert!(post_pocketbase_auth("localhost",8090,false,"/api/collections/users/auth-with-password",b"{}",deadline,&||Err("cancelled".into())).unwrap_err().contains("cancelled"));
        }
        #[test]
        fn location_transport_validates_and_cancels_before_any_network(){
            let deadline=std::time::Instant::now()+std::time::Duration::from_secs(1);
            assert!(ip_location_json("https://example.com","en",deadline,&||Ok(())).is_err());
            assert!(ip_location_json("10.0.0.1","en",deadline,&||Ok(())).is_err());
            assert!(ip_location_json("1.1.1.1","en&extra=1",deadline,&||Ok(())).is_err());
            assert!(ip_location_json("1.1.1.1","en",deadline,&||Err("fixture stopped".into())).unwrap_err().contains("fixture stopped"));
        }
        #[test]
        fn wasde_transport_is_fixed_and_cancellable_before_network(){
            for path in ["/other.xml","https://evil.test/file.xml","https://www.usda.gov/oce/commodity/wasde/wasde1026.xml"]{assert!(wasde_get(path,&||Ok(())).unwrap_err().contains("地址无效"));}
            for path in [crate::public_sources::WASDE_PAGE,"/oce/commodity/wasde/wasde1026.xml"]{assert!(wasde_get(path,&||Err("fixture cancelled".into())).unwrap_err().contains("fixture cancelled"));}
        }
    }


    pub(crate) fn decode_gbk(bytes:&[u8])->Result<String,String>{
        #[link(name="Kernel32")]unsafe extern "system"{fn MultiByteToWideChar(code_page:u32,flags:u32,input:*const u8,length:i32,output:*mut u16,capacity:i32)->i32;}
        if bytes.is_empty()||bytes.len()>65536{return Err("公开行情响应为空或超过64KB".into());}
        let count=unsafe{MultiByteToWideChar(936,8,bytes.as_ptr(),bytes.len() as i32,std::ptr::null_mut(),0)};
        if count<=0{return Err("公开行情响应GBK编码无效".into());}
        let mut utf16=vec![0u16;count as usize];
        if unsafe{MultiByteToWideChar(936,8,bytes.as_ptr(),bytes.len() as i32,utf16.as_mut_ptr(),count)}!=count{return Err("公开行情响应GBK解码失败".into());}
        String::from_utf16(&utf16).map_err(|_|"公开行情响应名称编码无效".into())
    }
