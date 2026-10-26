//! Optional read-only service connections. No installation, login or service control.
//! XUI response fields/GET path adapted from zbndev/3x-ui-exporter/client/client.go;
//! Clash version/counter fields adapted from artyfarty/singbox-exporter/collector.
//! See licenses/vps-services/ for upstream MIT notices and revision identifiers.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::Path, sync::{Mutex, atomic::{AtomicU64, Ordering}}, time::Duration};
use tauri::{AppHandle, Emitter, Manager, Webview};
use crate::provider_requests::{observed_unix_ms, RequestCache};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum Kind {
    #[serde(rename="3x-ui")] Xui,
    #[serde(rename="sing-box")] SingBox,
    #[serde(rename="tailscale")] Tailscale,
}
impl Kind { fn name(self)->&'static str { match self { Self::Xui=>"3x-ui",Self::SingBox=>"sing-box",Self::Tailscale=>"tailscale" } } }
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Connection {
    kind:Kind,
    endpoint:String,
    #[serde(default)] enabled:bool,
    #[serde(default)] auto_refresh:bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Snapshot {
    kind:Kind, endpoint:String, state:&'static str, detail:&'static str,
    version:Option<String>, upload_bytes:Option<u64>, download_bytes:Option<u64>,
    connections:Option<u64>, checked_at_unix_ms:u64,
}
type Cache = RequestCache<(Connection,u64,u64),Snapshot>;
#[derive(Default)] pub struct ServiceState { xui:Cache, sing_box:Cache, tailscale:Cache, xui_details:RequestCache<(Connection,u64,u64),XuiDetails>, sing_box_details:RequestCache<(Connection,u64,u64),SingBoxDetails>, tailscale_details:RequestCache<(Connection,u64,u64),TailscaleDetails> }
static CONFIG_REVISION:AtomicU64=AtomicU64::new(0);
static SAVING:Mutex<()>=Mutex::new(());
const CONFIG_FILE:&str="vps-services.json";
const MAX_RESPONSE:usize=256*1024;

fn require_dashboard(view:&Webview)->Result<(),String>{
    let url=view.url().map_err(|_|"无法确认工作台来源")?;
    if view.label()!="dashboard" || !crate::webapps::trusted_local_origin(view.label(),&url,cfg!(debug_assertions)) {
        return Err("仅本地工作台可管理和读取 VPS 服务".into());
    } Ok(())
}
fn alias(value:&str)->bool {
    !value.is_empty() && value.len()<=80 && value.bytes().next().is_some_and(|b|b.is_ascii_alphanumeric())
        && value.bytes().all(|b|b.is_ascii_alphanumeric()||b"-_.".contains(&b))
}
fn http_endpoint(value:&str)->Result<tauri::Url,String>{
    if value.len()>500 || value.chars().any(|c|c.is_control()||c.is_whitespace()) || value.contains('\\') || value.contains('%') {
        return Err("服务地址无效；不要包含凭据、查询参数或编码路径".into());
    }
    let url=tauri::Url::parse(value).map_err(|_|"请输入完整的服务 HTTP(S) 地址")?;
    let host=url.host_str().ok_or("服务主机名为空")?;
    let loopback=host.eq_ignore_ascii_case("localhost") || host.trim_matches(['[',']']).parse::<std::net::IpAddr>().is_ok_and(|ip|ip.is_loopback());
    if !matches!(url.scheme(),"http"|"https") || (url.scheme()=="http"&&!loopback)
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        || url.port_or_known_default()==Some(0) || matches!(host,"tauri.localhost"|"ipc.localhost"|"asset.localhost") {
        return Err("远程服务使用 HTTPS；HTTP 仅支持本机回环地址，不接受嵌入凭据或查询参数".into());
    }
    Ok(url)
}
fn normalize(mut connections:Vec<Connection>)->Result<Vec<Connection>,String>{
    if connections.len()>3 {return Err("每类服务最多添加一个连接".into());}
    let mut seen=Vec::new();
    for c in &mut connections {
        if seen.contains(&c.kind){return Err("同类服务不能重复添加".into());}seen.push(c.kind);
        c.endpoint=c.endpoint.trim().to_string();
        if c.endpoint.is_empty() && !c.enabled {c.auto_refresh=false;continue;}
        if c.kind==Kind::Tailscale {
            if !alias(&c.endpoint){return Err("Tailscale 填写已有 SSH 别名，仅支持字母、数字、点、下划线和连字符".into());}
        } else {c.endpoint=http_endpoint(&c.endpoint)?.to_string().trim_end_matches('/').to_string();}
        if !c.enabled {c.auto_refresh=false;}
    }
    Ok(connections)
}
fn load_file(path:&Path)->Result<Vec<Connection>,String>{
    match fs::metadata(path) {
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(Vec::new()),
        Ok(meta) if meta.len()<=8192=>{},
        _=>return Err("服务配置不可读或超过上限，原文件已保留".into()),
    }
    let bytes=fs::read(path).map_err(|_|"服务配置无法读取，原文件已保留")?;
    normalize(serde_json::from_slice(&bytes).map_err(|_|"服务配置无法解析，原文件已保留")?)
}
fn load(app:&AppHandle)->Result<Vec<Connection>,String>{load_file(&app.path().app_data_dir().map_err(|_|"应用配置目录不可用")?.join(CONFIG_FILE))}
fn save_file(directory:&Path, connections:Vec<Connection>)->Result<Vec<Connection>,String>{
    let _lock=SAVING.lock().map_err(|_|"服务配置忙碌")?;
    let connections=normalize(connections)?;let path=directory.join(CONFIG_FILE);
    load_file(&path)?;
    let previous=match fs::read(&path){Ok(v)=>Some(v),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>None,_=>return Err("无法备份服务配置".into())};
    fs::create_dir_all(directory).map_err(|_|"服务配置目录不可写")?;
    if let Some(previous)=previous {crate::launcher::replace_config_bytes(&directory.join("vps-services.previous.json"),&previous).map_err(|_|"备份失败，已停止保存")?;}
    let bytes=serde_json::to_vec_pretty(&connections).map_err(|_|"服务配置无法编码")?;
    crate::launcher::replace_config_bytes(&path,&bytes).map_err(|_|"服务配置保存失败，原文件已保留")?;
    CONFIG_REVISION.fetch_add(1,Ordering::SeqCst);Ok(connections)
}
#[tauri::command]pub fn load_vps_services(app:AppHandle,view:Webview)->Result<Vec<Connection>,String>{require_dashboard(&view)?;load(&app)}
#[tauri::command]pub fn save_vps_services(app:AppHandle,view:Webview,connections:Vec<Connection>)->Result<Vec<Connection>,String>{
    require_dashboard(&view)?;
    let result=save_file(&app.path().app_data_dir().map_err(|_|"应用配置目录不可用")?,connections)?;
    let _=app.emit("vps-services-changed",());Ok(result)
}
// Endpoint-scoped targets prevent sending a saved token to a newly edited host.
fn credential_target(c:&Connection)->Result<String,String>{
    if c.kind==Kind::Tailscale {return Err("Tailscale 复用已有 SSH，不保存 API 令牌".into());}
    http_endpoint(&c.endpoint)?;
    Ok(format!("CodexDesktop.VpsService.{}.{}",c.kind.name(),c.endpoint.as_bytes().iter().map(|b|format!("{b:02x}")).collect::<String>()))
}
fn configured(app:&AppHandle,kind:Kind)->Result<Connection,String>{load(app)?.into_iter().find(|c|c.kind==kind).ok_or("服务未配置".into())}
#[tauri::command]pub fn vps_service_token(app:AppHandle,view:Webview,kind:Kind,endpoint:String,action:String,token:Option<String>)->Result<bool,String>{
    require_dashboard(&view)?;let c=configured(&app,kind)?;
    if c.endpoint!=endpoint{return Err("服务地址已改变，请重新打开设置后管理令牌".into());}
    let target=credential_target(&c)?;
    #[cfg(windows)] {match action.as_str(){
        "inspect"=>crate::credentials::exists_named(&target),
        "save"=>{let secret=crate::credentials::Secret::from_string(token.ok_or("请输入令牌")?);crate::credentials::validate(secret.as_str())?;crate::credentials::save_named(&target,secret.as_str())?;let _=app.emit("vps-services-changed",());Ok(true)},
        "clear"=>{crate::credentials::clear_named(&target)?;let _=app.emit("vps-services-changed",());Ok(false)},
        _=>Err("不支持的凭据操作".into())
    }}
    #[cfg(not(windows))] {let _=(action,token,target);Err("服务凭据需要 Windows 桌面版".into())}
}
fn snapshot(c:&Connection)->Snapshot{Snapshot{kind:c.kind,endpoint:c.endpoint.clone(),state:"unknown",detail:"状态未确认",version:None,upload_bytes:None,download_bytes:None,connections:None,checked_at_unix_ms:observed_unix_ms()}}
fn json(bytes:&[u8])->Result<Value,String>{
    if bytes.is_empty()||bytes.len()>MAX_RESPONSE{return Err("服务响应为空或超过 256 KB".into());}
    serde_json::from_slice(bytes).map_err(|_|"服务响应不是有效 JSON，请检查地址和接口版本".into())
}
fn version(value:&Value)->Option<String>{value.as_str().filter(|s|!s.is_empty()&&s.len()<=80&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b" ._+-()".contains(&b))).map(str::to_string)}
fn counter(value:&Value)->Option<u64>{value.as_u64().filter(|v|*v<=9_007_199_254_740_991)}
fn parse_xui(c:&Connection,bytes:&[u8])->Result<Snapshot,String>{
    let value=json(bytes)?;
    if value["success"].as_bool()!=Some(true)||!value["obj"].is_object(){return Err("3x-ui 未返回成功的服务器状态；请核对接口版本和权限".into());}
    let obj=&value["obj"];let state=obj["xray"]["state"].as_str().ok_or("3x-ui 未提供 Xray 状态")?;
    let mut result=snapshot(c);
    (result.state,result.detail)=match state {"running"=>("online","Xray 运行中"),"stop"|"stopped"=>("offline","Xray 已停止"),_=>("unknown","Xray 状态未确认")};
    result.version=version(&obj["xray"]["version"]);
    // netIO is SERVER network traffic, not per-client/Xray traffic or quota.
    result.upload_bytes=counter(&obj["netIO"]["up"]);result.download_bytes=counter(&obj["netIO"]["down"]);
    Ok(result)
}
fn parse_sing_box(c:&Connection,version_bytes:&[u8],connection_bytes:&[u8])->Result<Snapshot,String>{
    let build=sing_box_version(version_bytes)?;
    let value=json(connection_bytes)?;
    let entries=value["connections"].as_array().ok_or("sing-box 未提供连接列表")?;
    let upload=counter(&value["uploadTotal"]).ok_or("sing-box 上传累计值无效")?;
    let download=counter(&value["downloadTotal"]).ok_or("sing-box 下载累计值无效")?;
    let mut result=snapshot(c);result.state="online";result.detail="Clash API 可读取";result.version=Some(build);
    result.upload_bytes=Some(upload);result.download_bytes=Some(download);result.connections=Some(entries.len() as u64);Ok(result)
}
fn sing_box_version(bytes:&[u8])->Result<String,String>{
    let value=json(bytes)?;
    version(&value["version"]).filter(|s|s.to_ascii_lowercase().starts_with("sing-box ")).ok_or("接口未确认是 sing-box，不能用其他 Clash 内核冒充".into())
}
fn read_http(c:&Connection,get:&mut impl FnMut(&str)->Result<Vec<u8>,String>,check:&impl Fn()->Result<(),String>)->Result<Snapshot,String>{
    check()?;
    match c.kind {
        Kind::Xui=>{let bytes=get("/panel/api/server/status")?;check()?;parse_xui(c,&bytes)},
        Kind::SingBox=>{let build=get("/version")?;check()?;sing_box_version(&build)?;let connections=get("/connections")?;check()?;parse_sing_box(c,&build,&connections)},
        Kind::Tailscale=>Err("Tailscale 通过 SSH 读取，不调用 HTTP".into())
    }
}
fn parse_tailscale(c:&Connection,bytes:&[u8])->Result<Snapshot,String>{
    let value=json(bytes)?;let backend=value["BackendState"].as_str().ok_or("Tailscale 未提供 BackendState")?;
    let mut result=snapshot(c);result.version=version(&value["Version"]);
    (result.state,result.detail)=match (backend,value["Self"]["Online"].as_bool()) {
        ("Running",Some(true))=>("online","VPS 已连接 Tailscale"),
        ("Running",Some(false))=>("offline","VPS 未连接 Tailscale"),
        ("Stopped",_)=>("offline","Tailscale 已停止"),
        ("NeedsLogin",_)=>("unknown","Tailscale 尚未登录"),
        ("NeedsMachineAuth",_)=>("unknown","Tailscale 等待设备授权"),
        _=>("unknown","Tailscale 状态未确认")
    };Ok(result)
}
#[derive(Debug,Clone,Serialize)]#[serde(rename_all="camelCase")]
pub struct XuiClient {
    name:String,enabled:Option<bool>,upload_bytes:Option<u64>,download_bytes:Option<u64>,
    quota_bytes:Option<u64>,expiry_time:Option<i64>,last_online_at_unix_ms:Option<u64>,
}
#[derive(Debug,Clone,Serialize)]#[serde(rename_all="camelCase")]
pub struct XuiInbound {
    id:u64,name:Option<String>,node_id:Option<u64>,protocol:Option<String>,port:Option<u64>,
    enabled:Option<bool>,upload_bytes:Option<u64>,download_bytes:Option<u64>,quota_bytes:Option<u64>,
    expiry_time:Option<i64>,clients:Option<Vec<XuiClient>>,
}
#[derive(Debug,Clone,Serialize)]#[serde(rename_all="camelCase")]
pub struct XuiNode {
    id:u64,name:Option<String>,address:Option<String>,port:Option<u64>,enabled:Option<bool>,
    state:&'static str,inbound_count:Option<u64>,client_count:Option<u64>,
    heartbeat_at_unix_ms:Option<u64>,xray_version:Option<String>,panel_version:Option<String>,
}
#[derive(Debug,Clone,Serialize)]#[serde(rename_all="camelCase")]
pub struct XuiDetails {
    kind:Kind,endpoint:String,checked_at_unix_ms:u64,
    inbounds:Option<Vec<XuiInbound>>,nodes:Option<Vec<XuiNode>>,
    inbounds_error:Option<&'static str>,nodes_error:Option<&'static str>,
}
fn label(value:&Value)->Option<String>{value.as_str().filter(|s|!s.trim().is_empty()&&s.len()<=240&&!s.chars().any(char::is_control)).map(str::to_string)}
fn expiry(value:&Value)->Option<i64>{value.as_i64().filter(|v|*v==0||(*v>=946_684_800_000&&*v<=8_640_000_000_000_000)||(*v<0&&v.checked_abs().is_some_and(|v|v<=3_153_600_000_000)))}
fn millis(value:&Value,now:u64)->Option<u64>{counter(value).filter(|v|*v>=946_684_800_000&&*v<=now.saturating_add(300_000))}
fn response_list(bytes:&[u8])->Result<Vec<Value>,String>{
    let value=json(bytes)?;if value["success"].as_bool()!=Some(true){return Err("3x-ui 未返回成功的详情列表".into());}
    value["obj"].as_array().cloned().ok_or("3x-ui 详情列表格式无效".into())
}
fn parse_xui_inbounds(bytes:&[u8],now:u64)->Result<Vec<XuiInbound>,String>{
    use std::collections::{HashMap,HashSet};
    let list=response_list(bytes)?;if list.len()>200{return Err("入站超过 200 项，暂不可用".into());}
    let mut seen=HashSet::new();let mut client_count=0;
    list.into_iter().map(|row|{
        let id=counter(&row["id"]).filter(|v|*v>0).ok_or("入站 ID 缺失或无效")?;
        if !seen.insert(id){return Err("入站 ID 重复，无法确认详情".into());}
        let settings=match row.get("settings") {
            Some(Value::String(raw))=>serde_json::from_str(raw).map_err(|_|"入站用户配置格式无效")?,
            Some(value)=>value.clone(),None=>Value::Null,
        };
        let clients=if let Some(items)=settings.get("clients").and_then(Value::as_array){
            client_count+=items.len();if client_count>2000{return Err("用户条目超过 2000 项，暂不可用".into());}
            let mut stats=HashMap::new();
            if let Some(entries)=row.get("clientStats").and_then(Value::as_array){
                if entries.len()>2000{return Err("用户流量条目超过上限".into());}
                for stat in entries {
                    let name=label(&stat["email"]).ok_or("用户流量标识缺失")?;
                    if stat.get("inboundId").is_some_and(|v|!v.is_null()&&counter(v)!=Some(id)) || stats.insert(name,stat).is_some(){return Err("用户流量归属冲突".into());}
                }
            }
            let mut names=HashSet::new();
            Some(items.iter().map(|entry|{
                let name=label(&entry["email"]).ok_or("用户标识缺失")?;
                if !names.insert(name.clone()){return Err("入站内用户标识重复".into());}
                let stat=stats.get(&name).copied().unwrap_or(&Value::Null);
                let enabled=if entry["enable"].as_bool()==Some(false)||stat["enable"].as_bool()==Some(false){Some(false)}else{entry["enable"].as_bool().or_else(||stat["enable"].as_bool())};
                Ok(XuiClient{name,enabled,upload_bytes:counter(&stat["up"]),download_bytes:counter(&stat["down"]),quota_bytes:counter(&stat["total"]),expiry_time:expiry(&stat["expiryTime"]),last_online_at_unix_ms:millis(&stat["lastOnline"],now)})
            }).collect::<Result<Vec<_>,String>>()?)
        }else{None};
        Ok(XuiInbound{id,name:label(&row["remark"]),node_id:match row.get("nodeId"){Some(Value::Null)=>Some(0),Some(v)=>counter(v),None=>None},protocol:row["protocol"].as_str().filter(|s|!s.is_empty()&&s.len()<=32&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b"-_".contains(&b))).map(str::to_string),port:counter(&row["port"]).filter(|v|(1..=65535).contains(v)),enabled:row["enable"].as_bool(),upload_bytes:counter(&row["up"]),download_bytes:counter(&row["down"]),quota_bytes:counter(&row["total"]),expiry_time:expiry(&row["expiryTime"]),clients})
    }).collect()
}
fn parse_xui_nodes(bytes:&[u8],now:u64)->Result<Vec<XuiNode>,String>{
    use std::collections::HashSet;
    let list=response_list(bytes)?;if list.len()>200{return Err("远程节点超过 200 项，暂不可用".into());}let mut seen=HashSet::new();
    list.into_iter().map(|row|{
        let id=counter(&row["id"]).filter(|v|*v>0).ok_or("节点 ID 缺失或无效")?;if !seen.insert(id){return Err("节点 ID 重复，无法确认详情".into());}
        Ok(XuiNode{id,name:label(&row["name"]),address:row["address"].as_str().filter(|s|!s.is_empty()&&s.len()<=253&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b".-:[]".contains(&b))).map(str::to_string),port:counter(&row["port"]).filter(|v|(1..=65535).contains(v)),enabled:row["enable"].as_bool(),state:match row["status"].as_str(){Some("online")=>"online",Some("offline")=>"offline",_=>"unknown"},inbound_count:counter(&row["inboundCount"]),client_count:counter(&row["clientCount"]),heartbeat_at_unix_ms:counter(&row["lastHeartbeat"]).and_then(|v|v.checked_mul(1000)).filter(|v|*v>=946_684_800_000&&*v<=now.saturating_add(300_000)),xray_version:version(&row["xrayVersion"]),panel_version:version(&row["panelVersion"])})
    }).collect()
}
fn collect_xui_details(c:&Connection,get:&mut impl FnMut(&str)->Result<Vec<u8>,String>,check:&impl Fn()->Result<(),String>)->Result<XuiDetails,String>{
    if c.kind!=Kind::Xui{return Err("详情接口仅支持 3x-ui".into());}check()?;
    // Slim omits client UUID/password/subscription secrets; never fall back to full payloads.
    let inbounds=get("/panel/api/inbounds/list/slim").and_then(|bytes|parse_xui_inbounds(&bytes,observed_unix_ms()));check()?;
    let checked_at_unix_ms=observed_unix_ms();
    let nodes=get("/panel/api/nodes/list").and_then(|bytes|parse_xui_nodes(&bytes,observed_unix_ms()));check()?;
    let inbounds_error=inbounds.as_ref().err().map(|_|"入站或用户暂不可用，请核对接口版本和读取权限");
    let nodes_error=nodes.as_ref().err().map(|_|"远程节点暂不可用，请核对接口版本和读取权限");
    Ok(XuiDetails{kind:c.kind,endpoint:c.endpoint.clone(),checked_at_unix_ms,inbounds:inbounds.ok(),nodes:nodes.ok(),inbounds_error,nodes_error})
}
#[derive(Debug,Clone,Serialize)]#[serde(rename_all="camelCase")]
pub struct SingBoxProxy {name:String,proxy_type:Option<String>,udp:Option<bool>,members:Option<Vec<String>>,selected:Option<String>,delay_ms:Option<u64>,delay_at_unix_ms:Option<u64>}
#[derive(Debug,Clone,Serialize)]#[serde(rename_all="camelCase")]
pub struct SingBoxConnection {destination:Option<String>,port:Option<u64>,network:Option<String>,inbound:Option<String>,chains:Option<Vec<String>>,upload_bytes:Option<u64>,download_bytes:Option<u64>,started_at_unix_ms:Option<u64>}
#[derive(Debug,Clone,Serialize)]#[serde(rename_all="camelCase")]
pub struct SingBoxConnections {upload_bytes:u64,download_bytes:u64,entries:Vec<SingBoxConnection>}
#[derive(Debug,Clone,Serialize)]#[serde(rename_all="camelCase")]
pub struct SingBoxDetails {kind:Kind,endpoint:String,version:String,checked_at_unix_ms:u64,proxies:Option<Vec<SingBoxProxy>>,connections:Option<SingBoxConnections>,proxies_error:Option<&'static str>,connections_error:Option<&'static str>}

// Go service timestamps use RFC3339Nano, including offsets. No locale/date guessing.
fn service_time(value:&Value,now:u64)->Option<u64>{
    let s=value.as_str()?;let b=s.as_bytes();if b.len()<20||b.len()>35||!s.is_ascii(){return None;}
    for (i,c) in [(4,b'-'),(7,b'-'),(10,b'T'),(13,b':'),(16,b':')]{if b[i]!=c{return None;}}
    let number=|a:usize,z:usize|->Option<i64>{let v=b.get(a..z)?;if !v.iter().all(u8::is_ascii_digit){return None;}s[a..z].parse().ok()};
    let (year,month,day,hour,minute,second)=(number(0,4)?,number(5,7)?,number(8,10)?,number(11,13)?,number(14,16)?,number(17,19)?);
    let leap=|y:i64|y%4==0&&(y%100!=0||y%400==0);
    if !(1970..=9999).contains(&year)||!(1..=12).contains(&month)||hour>23||minute>59||second>59{return None;}
    let months=[31,if leap(year){29}else{28},31,30,31,30,31,31,30,31,30,31];if day<1||day>months[(month-1) as usize]{return None;}
    let mut end=19;let mut millis=0;
    if b[end]==b'.'{end+=1;let start=end;while end<b.len()&&b[end].is_ascii_digit(){end+=1;}let n=end-start;if n==0||n>9{return None;}for i in 0..3{millis=millis*10+if i<n{(b[start+i]-b'0') as i64}else{0};}}
    let offset=if b.get(end)==Some(&b'Z')&&end+1==b.len(){0}else{
        if end+6!=b.len()||!matches!(b[end],b'+'|b'-')||b[end+3]!=b':'{return None;}
        let h=number(end+1,end+3)?;let m=number(end+4,end+6)?;if h>23||m>59{return None;}(h*60+m)*60*if b[end]==b'+'{1}else{-1}
    };
    let leaps=|y:i64|y/4-y/100+y/400;
    let days=(year-1970)*365+leaps(year-1)-leaps(1969)+months[..(month-1) as usize].iter().sum::<i64>()+day-1;
    let stamp=((days*86400+hour*3600+minute*60+second-offset)*1000+millis).try_into().ok()?;
    if stamp>now.saturating_add(1000){None}else{Some(stamp)}
}
fn sing_box_names(value:&Value,max:usize)->Result<Vec<String>,String>{
    let rows=value.as_array().ok_or("列表格式无效")?;if rows.len()>max{return Err("列表超过上限".into());}
    let mut seen=std::collections::HashSet::new();rows.iter().map(|v|{let name=label(v).ok_or("名称缺失或无效")?;if !seen.insert(name.clone()){return Err("列表名称重复".into());}Ok(name)}).collect()
}
fn parse_sing_box_proxies(bytes:&[u8],now:u64)->Result<Vec<SingBoxProxy>,String>{
    let value=json(bytes)?;let entries=value["proxies"].as_object().ok_or("sing-box 未提供节点列表")?;
    if entries.len()>500{return Err("节点超过 500 条，未截断展示".into());}
    entries.iter().map(|(key,row)|{
        let name=label(&Value::String(key.clone())).ok_or("节点名称无效")?;
        if !row.is_object()||!row["name"].is_null()&&label(&row["name"]).as_ref()!=Some(&name){return Err("节点名称与索引不匹配".into());}
        let members=if row.get("all").is_some(){Some(sing_box_names(&row["all"],500)?)}else{None};
        let latest=row["history"].as_array().and_then(|history|history.iter().filter_map(|v|service_time(&v["time"],now).map(|stamp|(stamp,v))).max_by_key(|(stamp,_)|*stamp));
        let delay=latest.and_then(|(stamp,v)|counter(&v["delay"]).filter(|n|*n<=65535).map(|n|(stamp,n)));
        Ok(SingBoxProxy{name,proxy_type:label(&row["type"]),udp:row["udp"].as_bool(),members,selected:label(&row["now"]),delay_ms:delay.map(|(_,n)|n),delay_at_unix_ms:delay.map(|(stamp,_)|stamp)})
    }).collect()
}
fn parse_sing_box_connections(bytes:&[u8],now:u64)->Result<SingBoxConnections,String>{
    let value=json(bytes)?;let rows=value["connections"].as_array().ok_or("sing-box 未提供连接列表")?;if rows.len()>2000{return Err("连接超过 2000 条，未截断展示".into());}
    let upload_bytes=counter(&value["uploadTotal"]).ok_or("累计上传无效")?;let download_bytes=counter(&value["downloadTotal"]).ok_or("累计下载无效")?;
    let entries=rows.iter().map(|row|{
        if !row.is_object(){return Err("连接格式无效".into());}let m=&row["metadata"];
        let port=counter(&m["destinationPort"]).or_else(||m["destinationPort"].as_str().filter(|s|s.len()<=5&&s.bytes().all(|b|b.is_ascii_digit())).and_then(|s|s.parse().ok())).filter(|p|(1..=65535).contains(p));
        Ok(SingBoxConnection{destination:label(&m["host"]).or_else(||label(&m["destinationIP"])),port,network:label(&m["network"]),inbound:label(&m["type"]),chains:if row["chains"].is_null(){None}else{Some(sing_box_names(&row["chains"],64)?)},upload_bytes:counter(&row["upload"]),download_bytes:counter(&row["download"]),started_at_unix_ms:service_time(&row["start"],now)})
    }).collect::<Result<Vec<_>,String>>()?;
    Ok(SingBoxConnections{upload_bytes,download_bytes,entries})
}
fn collect_sing_box_details(c:&Connection,get:&mut impl FnMut(&str)->Result<Vec<u8>,String>,check:&impl Fn()->Result<(),String>)->Result<SingBoxDetails,String>{
    if c.kind!=Kind::SingBox{return Err("详情接口仅支持 sing-box".into());}check()?;
    let build=get("/version")?;check()?;let version=sing_box_version(&build)?;
    // Fixed passive GET snapshots only: no delay probes, selectors, DELETE or WebSocket.
    let proxies=get("/proxies").and_then(|b|parse_sing_box_proxies(&b,observed_unix_ms()));check()?;
    let checked_at_unix_ms=observed_unix_ms();
    let connections=get("/connections").and_then(|b|parse_sing_box_connections(&b,observed_unix_ms()));check()?;
    let proxies_error=proxies.as_ref().err().map(|_|"节点与分组暂不可用，请核对接口版本和读取权限");
    let connections_error=connections.as_ref().err().map(|_|"连接与流量暂不可用，请核对接口版本和读取权限");
    Ok(SingBoxDetails{kind:c.kind,endpoint:c.endpoint.clone(),version,checked_at_unix_ms,proxies:proxies.ok(),connections:connections.ok(),proxies_error,connections_error})
}
#[derive(Debug,Clone,Serialize)]#[serde(rename_all="camelCase")]
pub struct TailscaleDevice {
    row_id:u64,name:Option<String>,dns_name:Option<String>,os:Option<String>,ips:Option<Vec<String>>,
    online:Option<bool>,active:Option<bool>,connection:&'static str,relay_region:Option<String>,
    upload_bytes:Option<u64>,download_bytes:Option<u64>,last_seen_at_unix_ms:Option<u64>,last_handshake_at_unix_ms:Option<u64>,
    exit_node:Option<bool>,exit_node_option:Option<bool>,tags:Option<Vec<String>>,primary_routes:Option<Vec<String>>,
    expired:Option<bool>,key_expiry_at_unix_ms:Option<u64>,
}
#[derive(Debug,Clone,Serialize)]#[serde(rename_all="camelCase")]
pub struct TailscaleDetails {
    kind:Kind,endpoint:String,version:Option<String>,backend_state:String,checked_at_unix_ms:u64,
    self_node:Option<TailscaleDevice>,peers:Option<Vec<TailscaleDevice>>,self_error:Option<&'static str>,peers_error:Option<&'static str>,
    health_warning_count:Option<u64>,magic_dns_enabled:Option<bool>,
}
fn tailscale_addresses(value:&Value,prefixes:bool)->Result<Option<Vec<String>>,String>{
    if value.is_null(){return Ok(None);}let list=sing_box_names(value,64)?;
    for item in &list {let valid=if prefixes {
        item.split_once('/').is_some_and(|(ip,bits)|ip.parse::<std::net::IpAddr>().is_ok_and(|ip|bits.parse::<u8>().is_ok_and(|bits|bits<=if ip.is_ipv4(){32}else{128})))
    }else{item.parse::<std::net::IpAddr>().is_ok()};if !valid{return Err("设备地址或路由格式无效".into());}}
    Ok(Some(list))
}
fn parse_tailscale_device(row:&Value,row_id:u64,now:u64)->Result<TailscaleDevice,String>{
    if !row.is_object(){return Err("设备格式无效".into());}
    let active=row["Active"].as_bool();
    // Relay is a preferred DERP region even while idle, so it alone proves no live route.
    let direct=row["CurAddr"].as_str().is_some_and(|s|s.parse::<std::net::SocketAddr>().is_ok());
    let peer_relay=row["PeerRelay"].as_str().is_some_and(|s|s.rsplit_once(':').is_some_and(|(address,vni)|address.parse::<std::net::SocketAddr>().is_ok()&&vni.parse::<u32>().is_ok()));
    let region=row["Relay"].as_str().filter(|s|!s.is_empty()&&s.len()<=24&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'));
    let connection=if active!=Some(true){"unknown"}else if direct{"direct"}else if peer_relay{"peer-relay"}else if region.is_some(){"derp"}else{"unknown"};
    Ok(TailscaleDevice{row_id,name:label(&row["HostName"]),dns_name:label(&row["DNSName"]),os:label(&row["OS"]),ips:tailscale_addresses(&row["TailscaleIPs"],false)?,online:row["Online"].as_bool(),active,connection,
        relay_region:if connection=="derp"{region.map(str::to_string)}else{None},
        upload_bytes:counter(&row["TxBytes"]),download_bytes:counter(&row["RxBytes"]),last_seen_at_unix_ms:service_time(&row["LastSeen"],now),last_handshake_at_unix_ms:service_time(&row["LastHandshake"],now),exit_node:row["ExitNode"].as_bool(),exit_node_option:row["ExitNodeOption"].as_bool(),
        tags:if row["Tags"].is_null(){None}else{Some(sing_box_names(&row["Tags"],64)?)},primary_routes:tailscale_addresses(&row["PrimaryRoutes"],true)?,expired:row["Expired"].as_bool(),key_expiry_at_unix_ms:service_time(&row["KeyExpiry"],u64::MAX)})
}
fn parse_tailscale_details(c:&Connection,bytes:&[u8],now:u64)->Result<TailscaleDetails,String>{
    let value=json(bytes)?;let raw=label(&value["BackendState"]).ok_or("Tailscale 未提供服务状态")?;
    let backend_state=if ["NoState","NeedsLogin","NeedsMachineAuth","Stopped","Starting","Running"].contains(&raw.as_str()){raw}else{"Unknown".into()};
    let self_node=if value["Self"].is_null(){Ok(None)}else{parse_tailscale_device(&value["Self"],0,now).map(Some)};
    let peers=(||->Result<Vec<TailscaleDevice>,String>{
        let peer=value.get("Peer").ok_or("未提供设备列表")?;if peer.is_null(){return Ok(Vec::new());}
        let list=peer.as_object().ok_or("设备列表格式无效")?;if list.len()>500{return Err("设备超过 500 条，未截断展示".into());}
        let mut ids=std::collections::HashSet::new();
        list.values().filter(|row|row["ShareeNode"].as_bool()!=Some(true)).enumerate().map(|(i,row)|{
            if let Some(id)=label(&row["ID"]){if !ids.insert(id){return Err("设备标识重复，无法确认归属".into());}}
            parse_tailscale_device(row,i as u64+1,now)
        }).collect()
    })();
    let self_error=self_node.as_ref().err().map(|_|"VPS 本机详情暂不可用，请核对状态格式");
    let peers_error=peers.as_ref().err().map(|_|"对等设备暂不可用，请核对状态格式与版本");
    Ok(TailscaleDetails{kind:c.kind,endpoint:c.endpoint.clone(),version:version(&value["Version"]),backend_state,checked_at_unix_ms:now,self_node:self_node.ok().flatten(),peers:peers.ok(),self_error,peers_error,
        health_warning_count:value["Health"].as_array().filter(|a|a.len()<=200&&a.iter().all(Value::is_string)).map(|a|a.len() as u64),magic_dns_enabled:value["CurrentTailnet"]["MagicDNSEnabled"].as_bool()})
}
fn collect_tailscale_details(c:&Connection,read:&mut impl FnMut()->Result<Vec<u8>,String>,check:&impl Fn()->Result<(),String>)->Result<TailscaleDetails,String>{
    if c.kind!=Kind::Tailscale||!alias(&c.endpoint){return Err("Tailscale 需使用有效的已配置 SSH 别名".into());}check()?;
    let bytes=read()?;check()?;parse_tailscale_details(c,&bytes,observed_unix_ms())
}
#[cfg(windows)]fn service_get(c:&Connection,path:&str,check:&impl Fn()->Result<(),String>)->Result<Vec<u8>,String>{
    check()?;let url=http_endpoint(&c.endpoint)?;
    let token=match crate::credentials::exists_named(&credential_target(c)?)? {
        true=>Some(crate::credentials::read_named(&credential_target(c)?)?),false=>None
    };
    if c.kind==Kind::Xui&&token.is_none(){return Err("请先保存此地址的 3x-ui API 令牌".into());}
    let mut headers=match token.as_ref(){Some(secret)=>format!("Accept: application/json\r\nAuthorization: Bearer {}\r\n",secret.as_str()),None=>"Accept: application/json\r\n".into()};
    let route=format!("{}{}",url.path().trim_end_matches('/'),path);
    let response=crate::http::vps_service_get(url.host_str().unwrap().trim_matches(['[',']']),url.port_or_known_default().unwrap(),url.scheme()=="https",&route,&headers,check);
    // Headers and raw responses never enter logs or the frontend.
    unsafe{headers.as_bytes_mut().fill(0);}
    let (status,bytes)=response?;
    match status {200=>Ok(bytes),401|403=>Err("认证失败或权限不足，请检查该地址的 API 令牌".into()),404=>Err("接口不存在，请核对服务地址、路径和版本".into()),300..=399=>Err("服务返回跳转，已停止读取；请填写最终地址".into()),_=>Err(format!("服务读取失败（HTTP {status}）"))}
}
#[cfg(windows)]fn tailscale_status(c:&Connection,check:&impl Fn()->Result<(),String>)->Result<Vec<u8>,String>{
    use std::{io::Read,process::{Command,Stdio},os::windows::process::CommandExt,time::Instant};
    if !alias(&c.endpoint){return Err("SSH 别名无效".into());}check()?;
    let executable=crate::network_tools::system_executable("OpenSSH/ssh.exe")?;
    let mut child=Command::new(executable).args(["-T","-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","-o","ConnectTimeout=8","-o","ConnectionAttempts=1",&c.endpoint,"tailscale status --json"])
        .creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_|"无法启动现有 SSH；请先配置 Windows OpenSSH 和别名")?;
    let stdout=match child.stdout.take(){Some(v)=>v,None=>{let _=child.kill();let _=child.wait();return Err("SSH 输出不可用".into())}};
    let reader=std::thread::spawn(move||{let mut bytes=Vec::new();let result=stdout.take((MAX_RESPONSE+1) as u64).read_to_end(&mut bytes);(result,bytes)});
    let started=Instant::now();
    let result=loop {
        if let Err(error)=check(){break Err(error);}
        if started.elapsed()>Duration::from_secs(12){break Err("SSH 状态读取超时".into());}
        match child.try_wait(){Ok(Some(status))=>break if status.success(){Ok(())}else{Err("SSH 连接、权限或 Tailscale 命令不可用；未判定服务离线".into())},Ok(None)=>{},Err(_)=>break Err("无法检查 SSH 子进程".into())}
        std::thread::sleep(Duration::from_millis(25));
    };
    // Kill before joining if timed out/cancelled, including a full stdout pipe.
    if result.is_err(){let _=child.kill();}let _=child.wait();
    let (read,bytes)=reader.join().map_err(|_|"SSH 输出读取失败")?;result?;read.map_err(|_|"SSH 输出读取失败")?;
    if bytes.len()>MAX_RESPONSE{return Err("Tailscale 状态超过 256 KB，暂不可用".into());}check()?;Ok(bytes)
}
#[tauri::command]pub async fn read_vps_service(app:AppHandle,view:Webview,state:tauri::State<'_,ServiceState>,kind:Kind,endpoint:String)->Result<Snapshot,String>{
    require_dashboard(&view)?;let live=crate::simulation::require_live()?;
    let c=configured(&app,kind)?;if !c.enabled{return Err("服务连接已关闭".into());}
    if c.endpoint!=endpoint{return Err("服务地址已改变，本次读取已阻止".into());}
    let revision=CONFIG_REVISION.load(Ordering::SeqCst);let credentials=crate::credentials::revision();
    let cache=match kind {Kind::Xui=>state.xui.clone(),Kind::SingBox=>state.sing_box.clone(),Kind::Tailscale=>state.tailscale.clone()};
    tauri::async_runtime::spawn_blocking(move||{
        let check=||{live.check()?;if revision!=CONFIG_REVISION.load(Ordering::SeqCst)||credentials!=crate::credentials::revision(){return Err("连接或凭据已更改，本次结果已丢弃".into());}Ok(())};
        check()?;
        let result=cache.read((c.clone(),revision,credentials),Duration::from_secs(60),Duration::from_secs(60),||{
            check()?;
            #[cfg(windows)]{if kind==Kind::Tailscale {parse_tailscale(&c,&tailscale_status(&c,&check)?)}else{read_http(&c,&mut|path|service_get(&c,path,&check),&check)}}
            #[cfg(not(windows))]{Err("服务读取仅支持 Windows 桌面版".into())}
        });check()?;result
    }).await.map_err(|_|"服务读取任务无法完成".to_string())?
}

#[tauri::command]pub async fn read_xui_details(app:AppHandle,view:Webview,state:tauri::State<'_,ServiceState>,endpoint:String)->Result<XuiDetails,String>{
    require_dashboard(&view)?;let live=crate::simulation::require_live()?;let c=configured(&app,Kind::Xui)?;
    if !c.enabled||c.endpoint!=endpoint{return Err("服务已关闭或地址已改变，本次详情读取已阻止".into());}
    let revision=CONFIG_REVISION.load(Ordering::SeqCst);let credentials=crate::credentials::revision();let cache=state.xui_details.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let check=||{live.check()?;if revision!=CONFIG_REVISION.load(Ordering::SeqCst)||credentials!=crate::credentials::revision(){return Err("连接或凭据已更改，本次详情已丢弃".into());}Ok(())};check()?;
        let result=cache.read((c.clone(),revision,credentials),Duration::from_secs(60),Duration::from_secs(60),||{
            #[cfg(windows)]{collect_xui_details(&c,&mut|path|service_get(&c,path,&check),&check)}
            #[cfg(not(windows))]{Err("服务详情需要 Windows 桌面版".into())}
        });check()?;result
    }).await.map_err(|_|"服务详情任务无法完成".to_string())?
}

#[tauri::command]pub async fn read_sing_box_details(app:AppHandle,view:Webview,state:tauri::State<'_,ServiceState>,endpoint:String)->Result<SingBoxDetails,String>{
    require_dashboard(&view)?;let live=crate::simulation::require_live()?;let c=configured(&app,Kind::SingBox)?;
    if !c.enabled||c.endpoint!=endpoint{return Err("服务已关闭或地址已改变，本次详情读取已阻止".into());}
    let revision=CONFIG_REVISION.load(Ordering::SeqCst);let credentials=crate::credentials::revision();let cache=state.sing_box_details.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let check=||{live.check()?;if revision!=CONFIG_REVISION.load(Ordering::SeqCst)||credentials!=crate::credentials::revision(){return Err("连接或凭据已更改，本次详情已丢弃".into());}Ok(())};check()?;
        let result=cache.read((c.clone(),revision,credentials),Duration::from_secs(60),Duration::from_secs(60),||{
            #[cfg(windows)]{collect_sing_box_details(&c,&mut|path|service_get(&c,path,&check),&check)}
            #[cfg(not(windows))]{Err("服务详情需要 Windows 桌面版".into())}
        });check()?;result
    }).await.map_err(|_|"服务详情任务无法完成".to_string())?
}

#[tauri::command]pub async fn read_tailscale_details(app:AppHandle,view:Webview,state:tauri::State<'_,ServiceState>,endpoint:String)->Result<TailscaleDetails,String>{
    require_dashboard(&view)?;let live=crate::simulation::require_live()?;let c=configured(&app,Kind::Tailscale)?;
    if !c.enabled||c.endpoint!=endpoint{return Err("服务已关闭或 SSH 别名已改变，本次详情读取已阻止".into());}
    let revision=CONFIG_REVISION.load(Ordering::SeqCst);let credentials=crate::credentials::revision();let cache=state.tailscale_details.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let check=||{live.check()?;if revision!=CONFIG_REVISION.load(Ordering::SeqCst)||credentials!=crate::credentials::revision(){return Err("连接或凭据已更改，本次详情已丢弃".into());}Ok(())};check()?;
        let result=cache.read((c.clone(),revision,credentials),Duration::from_secs(60),Duration::from_secs(60),||{
            #[cfg(windows)]{collect_tailscale_details(&c,&mut||tailscale_status(&c,&check),&check)}
            #[cfg(not(windows))]{Err("服务详情需要 Windows 桌面版".into())}
        });check()?;result
    }).await.map_err(|_|"服务详情任务无法完成".to_string())?
}

#[cfg(test)]mod tests {
    use super::*;
    fn c(kind:Kind)->Connection{Connection{kind,endpoint:if kind==Kind::Tailscale{"my-vps".into()}else{"https://service.example/base".into()},enabled:true,auto_refresh:false}}
    fn tailscale_fixture()->Value{serde_json::json!({"Version":"1.90.0","BackendState":"Running","AuthURL":"SECRET-AUTH","User":{"1":{"LoginName":"SECRET-EMAIL"}},"Health":["SECRET-HEALTH"],"CurrentTailnet":{"MagicDNSEnabled":true},"Self":{"HostName":"vps-self","Online":false,"TailscaleIPs":["100.64.0.1"],"TxBytes":0},"Peer":{"SECRET-PUBLIC-KEY":{"ID":"node-1","HostName":"desktop","DNSName":"desktop.example.ts.net.","OS":"windows","TailscaleIPs":["100.64.0.2","fd7a:115c:a1e0::2"],"Online":true,"Active":true,"CurAddr":"203.0.113.1:41641","Relay":"fra","TxBytes":0,"RxBytes":2048,"LastSeen":"0001-01-01T00:00:00Z","LastHandshake":"2026-10-24T10:00:00+08:00","ExitNode":false,"ExitNodeOption":true,"Tags":["tag:personal"],"PrimaryRoutes":["192.168.1.0/24"],"KeyExpiry":"2030-01-01T00:00:00Z","PublicKey":"SECRET-PUBLIC","PeerAPIURL":["SECRET-URL"]}}})}
    fn tailscale_details(value:&Value)->TailscaleDetails{parse_tailscale_details(&c(Kind::Tailscale),&serde_json::to_vec(value).unwrap(),observed_unix_ms()).unwrap()}
    #[test]fn tailscale_details_keep_vps_identity_and_strip_unneeded_fields(){
        let result=tailscale_details(&tailscale_fixture());assert_eq!(result.self_node.as_ref().unwrap().online,Some(false));let p=&result.peers.as_ref().unwrap()[0];
        assert_eq!(p.online,Some(true));assert_eq!(p.upload_bytes,Some(0));assert_eq!(p.download_bytes,Some(2048));assert_eq!(p.connection,"direct");assert_eq!(p.ips.as_ref().unwrap().len(),2);assert_eq!(p.last_seen_at_unix_ms,None);assert_eq!(p.last_handshake_at_unix_ms,Some(1792807200000));assert!(p.key_expiry_at_unix_ms.unwrap()>observed_unix_ms());assert_eq!(result.health_warning_count,Some(1));assert!(!serde_json::to_string(&result).unwrap().contains("SECRET-"));
    }
    #[test]fn tailscale_idle_region_is_not_an_active_relay_and_paths_follow_source_fields(){
        let now=observed_unix_ms();let device=|v:Value|parse_tailscale_device(&v,1,now).unwrap();
        assert_eq!(device(serde_json::json!({"Active":false,"Relay":"fra","CurAddr":"203.0.113.1:1"})).connection,"unknown");
        assert_eq!(device(serde_json::json!({"Active":true,"Relay":"fra"})).connection,"derp");
        assert_eq!(device(serde_json::json!({"Active":true,"Relay":"fra","PeerRelay":"100.64.0.9:4000:1"})).connection,"peer-relay");
        assert_eq!(device(serde_json::json!({"Active":true,"Relay":"fra","PeerRelay":"100.64.0.9:4000:1","CurAddr":"[2001:db8::1]:123"})).connection,"direct");
        assert_eq!(device(serde_json::json!({"Active":true,"CurAddr":"not-an-address","Relay":"https://invalid"})).connection,"unknown");
    }
    #[test]fn tailscale_null_peer_is_a_valid_empty_snapshot_but_missing_peer_is_unknown(){
        let mut v=tailscale_fixture();v["Peer"]=Value::Null;assert!(tailscale_details(&v).peers.unwrap().is_empty());v.as_object_mut().unwrap().remove("Peer");let d=tailscale_details(&v);assert!(d.peers.is_none()&&d.peers_error.is_some());assert!(d.self_node.is_some());
        v["Peer"]=serde_json::json!({});assert!(tailscale_details(&v).peers.unwrap().is_empty());v["Self"]=Value::Null;assert!(tailscale_details(&v).self_node.is_none());v["BackendState"]=serde_json::json!("NeedsLogin");assert_eq!(tailscale_details(&v).backend_state,"NeedsLogin");
        v.as_object_mut().unwrap().remove("BackendState");assert!(parse_tailscale_details(&c(Kind::Tailscale),&serde_json::to_vec(&v).unwrap(),observed_unix_ms()).is_err());
    }
    #[test]fn tailscale_detail_sections_fail_separately_and_missing_counters_stay_unknown(){
        let mut v=tailscale_fixture();v["Peer"]["SECRET-PUBLIC-KEY"]["TailscaleIPs"]=serde_json::json!(["not-an-ip"]);let d=tailscale_details(&v);assert!(d.peers.is_none()&&d.peers_error.is_some()&&d.self_node.is_some());
        let mut v=tailscale_fixture();v["Self"]["TailscaleIPs"]=serde_json::json!(["bad"]);let d=tailscale_details(&v);assert!(d.self_node.is_none()&&d.self_error.is_some()&&d.peers.is_some());
        let d=parse_tailscale_device(&serde_json::json!({"TxBytes":-1,"RxBytes":"2","LastHandshake":"2036-01-01T00:00:00Z"}),1,observed_unix_ms()).unwrap();assert_eq!(d.upload_bytes,None);assert_eq!(d.download_bytes,None);assert_eq!(d.online,None);assert_eq!(d.ips,None);assert_eq!(d.last_handshake_at_unix_ms,None);assert_eq!(d.key_expiry_at_unix_ms,None);
    }
    #[test]fn tailscale_same_names_remain_distinct_and_hidden_sharees_are_not_devices(){
        let mut v=tailscale_fixture();let p=v["Peer"]["SECRET-PUBLIC-KEY"].clone();let mut other=p.clone();other["ID"]=serde_json::json!("node-2");v["Peer"]["second"]=other;v["Peer"]["hidden"]=serde_json::json!({"ShareeNode":true});let d=tailscale_details(&v);let peers=d.peers.unwrap();assert_eq!(peers.len(),2);assert_ne!(peers[0].row_id,peers[1].row_id);assert_eq!(peers[0].name,peers[1].name);
        v["Peer"]["second"]=p;assert!(tailscale_details(&v).peers_error.is_some());
        v["Peer"]=serde_json::json!((0..501).map(|i|(format!("key{i}"),serde_json::json!({}))).collect::<serde_json::Map<_,_>>());assert!(tailscale_details(&v).peers.is_none());
    }
    #[test]fn tailscale_detail_plan_reads_once_and_cannot_bypass_cancel_or_alias_checks(){
        use std::cell::Cell;let n=Cell::new(0);let read=||{n.set(n.get()+1);Ok(serde_json::to_vec(&tailscale_fixture()).unwrap())};let mut read=read;
        assert!(collect_tailscale_details(&c(Kind::Tailscale),&mut read,&||Err("simulation".into())).is_err());assert_eq!(n.get(),0);
        assert!(collect_tailscale_details(&c(Kind::Tailscale),&mut read,&||if n.get()>0{Err("changed".into())}else{Ok(())}).is_err());assert_eq!(n.get(),1);
        assert!(collect_tailscale_details(&c(Kind::Tailscale),&mut read,&||Ok(())).is_ok());assert_eq!(n.get(),2);
        let mut bad=c(Kind::Tailscale);bad.endpoint="-oProxyCommand=whoami".into();assert!(collect_tailscale_details(&bad,&mut||panic!("must not execute"),&||Ok(())).is_err());assert!(collect_tailscale_details(&c(Kind::Xui),&mut||panic!("must not execute"),&||Ok(())).is_err());
        let mut calls=0;assert!(collect_tailscale_details(&c(Kind::Tailscale),&mut||{calls+=1;Err("failed".into())},&||Ok(())).is_err());assert_eq!(calls,1);
    }
    #[test]fn sing_box_rfc3339_preserves_offsets_and_rejects_invalid_dates(){
        let now=observed_unix_ms();let z=service_time(&serde_json::json!("2026-10-25T03:00:00.123456789Z"),now).unwrap();
        assert_eq!(z,1792897200123);assert_eq!(service_time(&serde_json::json!("2026-10-25T11:00:00.123+08:00"),now),Some(z));
        assert_eq!(service_time(&serde_json::json!("2026-10-24T22:00:00.123-05:00"),now),Some(z));
        assert!(service_time(&serde_json::json!("2024-02-29T00:00:00Z"),now).is_some());
        for bad in ["2026-02-29T00:00:00Z","2026-10-25T24:00:00Z","2026-10-25T03:00:00","2026-10-25T03:00:00.+08:00","2026-10-25T03:00:00+24:00","2026-10-25T03:00:00.1234567890Z","2036-01-01T00:00:00Z","x"]{assert_eq!(service_time(&serde_json::json!(bad),now),None,"{bad}");}
    }
    fn proxy_fixture()->Vec<u8>{serde_json::to_vec(&serde_json::json!({"proxies":{
        "edge":{"name":"edge","type":"VLESS","udp":true,"history":[{"time":"2026-10-24T01:00:00Z","delay":23},{"time":"2026-10-24T10:00:00+08:00","delay":0}],"password":"SECRET-PASSWORD"},
        "never":{"type":"Shadowsocks","history":[]},"bad-time":{"type":"Direct","history":[{"time":"bad","delay":12}]},
        "GROUP":{"type":"Selector","now":"missing","all":["edge","never"],"history":[]}
    }})).unwrap()}
    #[test]fn sing_box_proxies_keep_groups_and_delay_failure_separate_from_missing(){
        let rows=parse_sing_box_proxies(&proxy_fixture(),observed_unix_ms()).unwrap();
        let edge=rows.iter().find(|r|r.name=="edge").unwrap();assert_eq!(edge.delay_ms,Some(0));assert_eq!(edge.delay_at_unix_ms,Some(1792807200000));assert_eq!(edge.members,None);
        for name in ["never","bad-time"]{assert_eq!(rows.iter().find(|r|r.name==name).unwrap().delay_ms,None);}
        let group=rows.iter().find(|r|r.name=="GROUP").unwrap();assert_eq!(group.selected.as_deref(),Some("missing"));assert_eq!(group.members.as_ref().unwrap().len(),2);
        assert!(!serde_json::to_string(&rows).unwrap().contains("SECRET-"));
    }
    #[test]fn sing_box_proxy_ownership_and_bounds_are_checked(){
        for raw in [br#"{"proxies":{"a":{"name":"b"}}}"#.as_slice(),br#"{"proxies":{"g":{"all":["x","x"]}}}"#,br#"{"proxies":{"g":{"all":null}}}"#,br#"{"proxies":[]}"#,b"<html>login</html>"]{assert!(parse_sing_box_proxies(raw,observed_unix_ms()).is_err());}
        let too_many=serde_json::json!({"proxies":(0..501).map(|i|(format!("node{i}"),serde_json::json!({}))).collect::<serde_json::Map<_,_>>()});assert!(parse_sing_box_proxies(&serde_json::to_vec(&too_many).unwrap(),observed_unix_ms()).is_err());
    }
    fn sing_connection_fixture()->Vec<u8>{serde_json::to_vec(&serde_json::json!({"uploadTotal":0,"downloadTotal":1024,"connections":[{"id":"SECRET-ID","metadata":{"host":"example.com","destinationIP":"203.0.113.1","destinationPort":"443","network":"tcp","type":"mixed/in","sourceIP":"SECRET-SOURCE","processPath":"SECRET-PROCESS"},"chains":["edge","GROUP"],"upload":0,"download":12,"start":"2026-10-24T10:00:00+08:00","rule":"SECRET-RULE"},{}]})).unwrap()}
    #[test]fn sing_box_connections_whitelist_fields_and_keep_zero_distinct(){
        let result=parse_sing_box_connections(&sing_connection_fixture(),observed_unix_ms()).unwrap();assert_eq!(result.upload_bytes,0);assert_eq!(result.entries.len(),2);
        let first=&result.entries[0];assert_eq!(first.destination.as_deref(),Some("example.com"));assert_eq!(first.port,Some(443));assert_eq!(first.upload_bytes,Some(0));assert_eq!(first.started_at_unix_ms,Some(1792807200000));assert!(result.entries[1].upload_bytes.is_none());
        assert!(!serde_json::to_string(&result).unwrap().contains("SECRET-"));
        for raw in [br#"{"uploadTotal":-1,"downloadTotal":0,"connections":[]}"#.as_slice(),br#"{"uploadTotal":0,"downloadTotal":0,"connections":null}"#]{assert!(parse_sing_box_connections(raw,observed_unix_ms()).is_err());}
    }
    #[test]fn sing_box_detail_plan_is_passive_fixed_and_partial_without_retries(){
        let mut paths=Vec::new();let result=collect_sing_box_details(&c(Kind::SingBox),&mut|path|{paths.push(path.to_string());match path{"/version"=>Ok(br#"{"version":"sing-box 1.12.0"}"#.to_vec()),"/proxies"=>Ok(proxy_fixture()),_=>Err("SECRET-ERROR".into())}},&||Ok(())).unwrap();
        assert_eq!(paths,vec!["/version","/proxies","/connections"]);assert!(result.proxies.is_some()&&result.connections.is_none());assert!(result.connections_error.is_some());assert!(!serde_json::to_string(&result).unwrap().contains("SECRET-"));
        let mut count=0;assert!(collect_sing_box_details(&c(Kind::SingBox),&mut |_|{count+=1;Ok(br#"{"version":"mihomo 1.2"}"#.to_vec())},&||Ok(())).is_err());assert_eq!(count,1);
        assert!(collect_sing_box_details(&c(Kind::Xui),&mut |_|panic!("wrong type"),&||Ok(())).is_err());
    }
    #[test]fn sing_box_detail_gate_cancels_between_passive_requests(){
        use std::cell::Cell;let count=Cell::new(0);
        assert!(collect_sing_box_details(&c(Kind::SingBox),&mut |_|panic!("blocked"),&||Err("simulation".into())).is_err());
        assert!(collect_sing_box_details(&c(Kind::SingBox),&mut |_|{count.set(count.get()+1);Ok(br#"{"version":"sing-box 1.12.0"}"#.to_vec())},&||if count.get()>0{Err("changed".into())}else{Ok(())}).is_err());assert_eq!(count.get(),1);
    }
    #[test]fn defaults_are_disabled_manual_and_no_fixed_servers(){
        let values:Vec<Connection>=serde_json::from_str(r#"[{"kind":"3x-ui","endpoint":""}]"#).unwrap();
        let values=normalize(values).unwrap();assert!(!values[0].enabled&&!values[0].auto_refresh);
        assert!(serde_json::from_str::<Connection>(r#"{"kind":"3x-ui","endpoint":"","token":"secret"}"#).is_err());
    }
    fn slim_fixture()->Vec<u8>{serde_json::to_vec(&serde_json::json!({"success":true,"obj":[{"id":1,"nodeId":null,"remark":"local-vless","protocol":"vless","port":443,"enable":true,"up":0,"down":1024,"total":0,"expiryTime":0,"settings":{"clients":[{"email":"alice","enable":true,"id":"SECRET-UUID","password":"SECRET-PASSWORD","subId":"SECRET-SUB"}]},"clientStats":[{"email":"alice","inboundId":1,"up":0,"down":2048,"total":4096,"expiryTime":-604800000,"enable":false,"uuid":"SECRET-UUID","subId":"SECRET-SUB"}]}]})).unwrap()}
    #[test]fn slim_details_keep_field_semantics_and_strip_secrets(){
        let rows=parse_xui_inbounds(&slim_fixture(),observed_unix_ms()).unwrap();assert_eq!(rows[0].node_id,Some(0));assert_eq!(rows[0].quota_bytes,Some(0));
        let client=&rows[0].clients.as_ref().unwrap()[0];assert_eq!(client.name,"alice");assert_eq!(client.enabled,Some(false));assert_eq!(client.expiry_time,Some(-604800000));assert_eq!(client.upload_bytes,Some(0));assert_eq!(client.download_bytes,Some(2048));
        assert!(!serde_json::to_string(&rows).unwrap().contains("SECRET-"));
    }
    #[test]fn missing_details_do_not_become_unlimited_or_zero_users(){
        let rows=parse_xui_inbounds(br#"{"success":true,"obj":[{"id":2,"settings":{"clients":[{"email":"new"}]}}]}"#,observed_unix_ms()).unwrap();
        let client=&rows[0].clients.as_ref().unwrap()[0];assert_eq!(client.enabled,None);assert_eq!(client.quota_bytes,None);assert_eq!(client.expiry_time,None);assert_eq!(client.upload_bytes,None);assert_eq!(rows[0].node_id,None);
        assert!(parse_xui_inbounds(br#"{"success":true,"obj":[{"id":2}]}"#,observed_unix_ms()).unwrap()[0].clients.is_none());
        assert!(parse_xui_inbounds(br#"{"success":true,"obj":[]}"#,observed_unix_ms()).unwrap().is_empty());
    }
    #[test]fn duplicate_ids_or_conflicting_client_ownership_fail_closed(){
        for raw in [br#"{"success":true,"obj":[{"id":1},{"id":1}]}"#.as_slice(),br#"{"success":true,"obj":[{"id":1,"settings":{"clients":[{"email":"a"},{"email":"a"}]}}]}"#,br#"{"success":true,"obj":[{"id":1,"settings":{"clients":[{"email":"a"}]},"clientStats":[{"email":"a","inboundId":2}]}]}"#]{assert!(parse_xui_inbounds(raw,observed_unix_ms()).is_err());}
        let rows=parse_xui_inbounds(br#"{"success":true,"obj":[{"id":1,"settings":{"clients":[{"email":"shared"}]}},{"id":2,"settings":{"clients":[{"email":"shared"}]}}]}"#,observed_unix_ms()).unwrap();assert_eq!(rows.len(),2);assert!(rows.iter().all(|r|r.clients.as_ref().unwrap().len()==1));
    }
    #[test]fn node_heartbeat_is_seconds_and_sensitive_settings_are_discarded(){
        let now=observed_unix_ms();let bytes=serde_json::to_vec(&serde_json::json!({"success":true,"obj":[{"id":3,"name":"edge-1","address":"node.example","port":2053,"enable":true,"status":"online","lastHeartbeat":now/1000-30,"inboundCount":0,"clientCount":2,"apiToken":"SECRET-TOKEN","privateKey":"SECRET-KEY","lastError":"SECRET-URL"}]})).unwrap();
        let nodes=parse_xui_nodes(&bytes,now).unwrap();assert_eq!(nodes[0].heartbeat_at_unix_ms,Some((now/1000-30)*1000));assert_eq!(nodes[0].inbound_count,Some(0));assert!(!serde_json::to_string(&nodes).unwrap().contains("SECRET-"));
        assert_eq!(expiry(&serde_json::json!(1700000000)),None);assert_eq!(expiry(&Value::Null),None);assert_eq!(expiry(&serde_json::json!(0)),Some(0));
    }
    #[test]fn detail_requests_are_fixed_and_partial_failures_are_separate(){
        let mut paths=Vec::new();let value=collect_xui_details(&c(Kind::Xui),&mut|path|{paths.push(path.to_string());if path.ends_with("/slim"){Ok(slim_fixture())}else{Err("SECRET-ERROR".into())}},&||Ok(())).unwrap();
        assert_eq!(paths,vec!["/panel/api/inbounds/list/slim","/panel/api/nodes/list"]);assert!(value.inbounds.is_some()&&value.nodes.is_none());assert!(value.nodes_error.is_some());assert!(!serde_json::to_string(&value).unwrap().contains("SECRET-"));
        let mut count=0;let value=collect_xui_details(&c(Kind::Xui),&mut |_|{count+=1;Err("404".into())},&||Ok(())).unwrap();assert_eq!(count,2);assert!(value.inbounds.is_none()&&value.nodes.is_none());
    }
    #[test]fn detail_simulation_or_midflight_cancel_blocks_requests(){
        use std::cell::Cell;let count=Cell::new(0);
        assert!(collect_xui_details(&c(Kind::Xui),&mut |_|{count.set(count.get()+1);Ok(slim_fixture())},&||Err("blocked".into())).is_err());assert_eq!(count.get(),0);
        assert!(collect_xui_details(&c(Kind::Xui),&mut |_|{count.set(count.get()+1);Ok(slim_fixture())},&||if count.get()>0{Err("changed".into())}else{Ok(())}).is_err());assert_eq!(count.get(),1);
        assert!(collect_xui_details(&c(Kind::SingBox),&mut |_|panic!("wrong type must not request"),&||Ok(())).is_err());
    }
    #[test]fn endpoint_policy_rejects_credentials_redirect_targets_and_plain_remote_http(){
        for bad in ["http://server.example","https://user:pass@server.example","https://server.example/?token=x","https://server.example/#x","https://server.example/%0a","https://server.example\\x","https://server.example/ x","https://server.example:0","file:///etc/passwd","https://tauri.localhost"] {assert!(http_endpoint(bad).is_err(),"{bad}");}
        for good in ["https://server.example/panel","http://127.0.0.1:9090","http://[::1]:9090","http://localhost:9090"]{assert!(http_endpoint(good).is_ok(),"{good}");}
    }
    #[test]fn alias_and_duplicate_checks_block_command_injection(){
        for bad in ["-oProxyCommand=x","user@host","a b","a;id","$(id)","a\nx"]{assert!(!alias(bad));}
        assert!(alias("my-vps_1.local"));assert!(normalize(vec![c(Kind::Xui),c(Kind::Xui)]).is_err());
    }
    #[test]fn credentials_are_scoped_by_full_endpoint_and_service(){
        let first=c(Kind::Xui);let mut second=first.clone();second.endpoint="https://other.example/base".into();
        assert_ne!(credential_target(&first).unwrap(),credential_target(&second).unwrap());second.endpoint=first.endpoint.clone();second.kind=Kind::SingBox;
        assert_ne!(credential_target(&first).unwrap(),credential_target(&second).unwrap());assert!(credential_target(&c(Kind::Tailscale)).is_err());
        assert!(!serde_json::to_string(&first).unwrap().contains("token"));
    }
    #[test]fn xui_state_and_server_counter_semantics_are_kept(){
        let data=br#"{"success":true,"obj":{"xray":{"state":"running","version":"v25.1"},"netIO":{"up":1234,"down":0}}}"#;
        let result=parse_xui(&c(Kind::Xui),data).unwrap();assert_eq!(result.state,"online");assert_eq!(result.upload_bytes,Some(1234));assert_eq!(result.download_bytes,Some(0));assert!(result.connections.is_none());
        assert_eq!(parse_xui(&c(Kind::Xui),br#"{"success":true,"obj":{"xray":{"state":"stop"}}}"#).unwrap().state,"offline");
        assert_eq!(parse_xui(&c(Kind::Xui),br#"{"success":true,"obj":{"xray":{"state":"future"},"netIO":{"up":-1}}}"#).unwrap().state,"unknown");
        assert!(parse_xui(&c(Kind::Xui),br#"{"success":false,"msg":"secret"}"#).unwrap_err().find("secret").is_none());
        assert!(parse_xui(&c(Kind::Xui),b"<html>login</html>").is_err());
    }
    #[test]fn sing_box_requires_its_identity_and_aggregate_fields(){
        let build=br#"{"version":"sing-box 1.12.0","premium":true}"#;
        let data=br#"{"uploadTotal":0,"downloadTotal":4096,"connections":[{"metadata":{"sourceIP":"PRIVATE","host":"PRIVATE"}}]}"#;
        let value=parse_sing_box(&c(Kind::SingBox),build,data).unwrap();assert_eq!(value.connections,Some(1));assert_eq!(value.upload_bytes,Some(0));
        assert!(!serde_json::to_string(&value).unwrap().contains("PRIVATE"));
        assert!(parse_sing_box(&c(Kind::SingBox),br#"{"version":"mihomo 1.2"}"#,data).is_err());
        for invalid in [br#"{"uploadTotal":-1,"downloadTotal":1,"connections":[]}"#.as_slice(),br#"{"uploadTotal":0,"connections":[]}"#,br#"{"uploadTotal":1,"downloadTotal":2,"connections":null}"#]{assert!(parse_sing_box(&c(Kind::SingBox),build,invalid).is_err());}
    }
    #[test]fn tailscale_reads_vps_self_not_peer_online_status(){
        let value=parse_tailscale(&c(Kind::Tailscale),br#"{"BackendState":"Running","Self":{"Online":false},"Peer":{"private":{"Online":true}},"Version":"1.90.0"}"#).unwrap();
        assert_eq!(value.state,"offline");assert!(!serde_json::to_string(&value).unwrap().contains("private"));
        assert_eq!(parse_tailscale(&c(Kind::Tailscale),br#"{"BackendState":"Running","Self":{"Online":true}}"#).unwrap().state,"online");
        assert_eq!(parse_tailscale(&c(Kind::Tailscale),br#"{"BackendState":"NeedsLogin"}"#).unwrap().state,"unknown");
        assert_eq!(parse_tailscale(&c(Kind::Tailscale),br#"{"BackendState":"Running"}"#).unwrap().state,"unknown");
        assert!(parse_tailscale(&c(Kind::Tailscale),br#"{"Peer":{}}"#).is_err());
    }
    #[test]fn response_bounds_and_bad_counters_do_not_become_zero(){
        assert!(json(&vec![b' ';MAX_RESPONSE+1]).is_err());assert!(json(b"").is_err());
        for bad in [serde_json::json!(-1),serde_json::json!(1.5),serde_json::json!("123"),serde_json::json!(9_007_199_254_740_992u64),Value::Null]{assert_eq!(counter(&bad),None);}
    }
    #[test]fn transport_plan_is_bounded_read_only_and_no_retry(){
        let mut routes=Vec::new();let result=read_http(&c(Kind::SingBox),&mut|path|{routes.push(path.to_string());Ok(if path=="/version"{br#"{"version":"sing-box 1.12"}"#.to_vec()}else{br#"{"uploadTotal":0,"downloadTotal":0,"connections":[]}"#.to_vec()})},&||Ok(())).unwrap();
        assert_eq!(result.state,"online");assert_eq!(routes,vec!["/version","/connections"]);
        let mut calls=0;assert!(read_http(&c(Kind::Xui),&mut |_|{calls+=1;Err("fixture failure".into())},&||Ok(())).is_err());assert_eq!(calls,1);
    }
    #[test]fn blocked_simulation_never_enters_transport(){
        let mut calls=0;assert!(read_http(&c(Kind::Xui),&mut |_|{calls+=1;panic!("must not request")},&||Err("simulation blocked".into())).is_err());assert_eq!(calls,0);
        let mut calls=0;assert!(read_http(&c(Kind::SingBox),&mut |_|{calls+=1;Ok(br#"{"version":"mihomo 1.2"}"#.to_vec())},&||Ok(())).is_err());assert_eq!(calls,1);
    }
    #[test]fn cancellation_between_requests_blocks_the_second_get(){
        use std::cell::Cell;
        let calls=Cell::new(0);
        let result=read_http(&c(Kind::SingBox),&mut |_|{calls.set(calls.get()+1);Ok(br#"{"version":"sing-box 1.12"}"#.to_vec())},&||if calls.get()>0{Err("configuration changed".into())}else{Ok(())});
        assert!(result.is_err());assert_eq!(calls.get(),1);
    }
    #[test]fn corrupt_config_is_not_overwritten_and_good_config_is_backed_up(){
        let dir=std::env::temp_dir().join(format!("agentroom-vps-service-{}-{}",std::process::id(),observed_unix_ms()));fs::create_dir(&dir).unwrap();
        let path=dir.join(CONFIG_FILE);assert!(load_file(&path).unwrap().is_empty());assert!(!path.exists());
        save_file(&dir,vec![c(Kind::Xui)]).unwrap();let old=fs::read(&path).unwrap();save_file(&dir,vec![]).unwrap();assert_eq!(fs::read(dir.join("vps-services.previous.json")).unwrap(),old);
        fs::write(&path,b"invalid").unwrap();assert!(save_file(&dir,vec![]).is_err());assert_eq!(fs::read(&path).unwrap(),b"invalid");
        assert_eq!(dir.parent(),Some(std::env::temp_dir().as_path()));fs::remove_dir_all(dir).unwrap();
    }
}
