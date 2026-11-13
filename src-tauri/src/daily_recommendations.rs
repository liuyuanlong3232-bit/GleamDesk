use serde_json::{json,Value};
use std::{fs,io::Write,path::{Path,PathBuf},sync::Mutex,time::{Duration,Instant}};
use tauri::{AppHandle,Manager};
use crate::credentials::{self,CredentialSource};

#[derive(Default)]
pub struct DailyState(Mutex<()>,Mutex<Option<(Instant,u64,Value)>>,Mutex<MimoRecovery>);
#[derive(Default)]
struct MimoRecovery{last_attempt:Option<(Instant,u64)>,generation:u64}
impl MimoRecovery{
    fn begin(&mut self,now:Instant,revision:u64)->Option<u64>{
        if self.last_attempt.is_some_and(|(at,version)|version==revision&&now.saturating_duration_since(at)<Duration::from_secs(300)){return None}
        self.last_attempt=Some((now,revision));Some(self.generation)
    }
    fn cancel(&mut self){self.generation=self.generation.saturating_add(1);}
}
const MODEL:&str="mimo-v2.6-flash";
const MAX_BYTES:u64=256*1024;

#[cfg(windows)]
pub(crate) fn clock()->Result<(String,String),String>{
    use windows_sys::Win32::{Foundation::{FILETIME,SYSTEMTIME},System::{SystemInformation::GetSystemTimeAsFileTime,Time::FileTimeToSystemTime}};
    let mut file:FILETIME=unsafe{std::mem::zeroed()};unsafe{GetSystemTimeAsFileTime(&mut file)};
    let mut utc:SYSTEMTIME=unsafe{std::mem::zeroed()};
    if unsafe{FileTimeToSystemTime(&file,&mut utc)}==0{return Err("无法读取日期".into());}
    let ticks=((file.dwHighDateTime as u64)<<32|file.dwLowDateTime as u64)+8*3600*10_000_000;
    let bjt=FILETIME{dwHighDateTime:(ticks>>32) as u32,dwLowDateTime:ticks as u32};let mut time:SYSTEMTIME=unsafe{std::mem::zeroed()};
    if unsafe{FileTimeToSystemTime(&bjt,&mut time)}==0{return Err("无法读取北京时间".into());}
    Ok((format!("{:04}-{:02}-{:02}",time.wYear,time.wMonth,time.wDay),format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",utc.wYear,utc.wMonth,utc.wDay,utc.wHour,utc.wMinute,utc.wSecond)))
}
#[cfg(not(windows))]pub(crate) fn clock()->Result<(String,String),String>{Err("每日推荐仅支持 Windows 桌面应用".into())}
fn directory(app:&AppHandle)->Result<PathBuf,String>{let path=app.path().app_data_dir().map_err(|_|"应用数据目录不可用")?;fs::create_dir_all(&path).map_err(|_|"应用数据目录不可写")?;Ok(path)}
fn load(path:&Path)->Result<Option<Value>,String>{
    if !path.exists(){return Ok(None);}
    if fs::metadata(path).map_err(|_|"缓存不可读")?.len()>MAX_BYTES{return Err("推荐缓存超过上限".into());}
    let value=serde_json::from_slice(&fs::read(path).map_err(|_|"缓存不可读")?).map_err(|_|"推荐缓存格式无效")?;Ok(Some(value))
}
fn save(path:&Path,value:&Value)->Result<(),String>{
    let bytes=serde_json::to_vec(value).map_err(|_|"缓存无法编码")?;if bytes.len() as u64>MAX_BYTES{return Err("缓存超过上限".into());}
    let temporary=path.with_extension("json.tmp");let mut file=fs::File::create(&temporary).map_err(|_|"缓存不可写")?;
    file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|_|"缓存保存失败")?;
    fs::rename(temporary,path).map_err(|_|"缓存替换失败".into())
}
fn valid_repo(repo:&str)->bool{
    let parts:Vec<_>=repo.split('/').collect();parts.len()==2&&parts.iter().all(|part|!part.is_empty()&&*part!="."&&*part!=".."&&part.len()<=100&&part.bytes().all(|c|c.is_ascii_alphanumeric()||b"-_.".contains(&c)))
}
fn validate_snapshot(value:&Value)->Result<(),String>{
    let items=value["items"].as_array().ok_or("推荐没有项目")?;
    if value["schemaVersion"]!=1||value["source"]!="GitHub Trending"||items.is_empty()||items.len()>8{return Err("推荐来源无效".into());}
    let date=value["date"].as_str().ok_or("推荐缺少日期")?;
    if date.len()!=10||!date.bytes().enumerate().all(|(i,b)|if i==4||i==7{b==b'-'}else{b.is_ascii_digit()}){return Err("推荐日期无效".into());}
    let mut seen=std::collections::HashSet::new();
    for item in items{
        let repo=item["repo"].as_str().ok_or("推荐缺少仓库")?;
        if !valid_repo(repo)||!seen.insert(repo)||item["url"]!=format!("https://github.com/{repo}"){return Err("推荐仓库地址无效".into());}
        for key in ["description","language","stars","todayStars"]{if !item[key].as_str().is_some_and(|text|text.chars().count()<=700){return Err("推荐文字无效".into());}}
    }
    Ok(())
}
fn read_daily(app:&AppHandle)->Result<Value,String>{
    crate::simulation::require_live()?;
    let connection=crate::agriculture::connection(app)?;
    if !connection.github_enabled{return Err("PUBLIC_SOURCE_DISABLED: 请在设置 → 数据来源启用每日推荐公开榜单".into());}
    let path=directory(app)?.join("daily-opensource.json");let(today,_)=clock()?;
    let mut value=load(&path)?.ok_or("PUBLIC_CACHE_MISS: 尚无本机公开榜单")?;
    validate_snapshot(&value)?;
    if value["date"]!=today{value["status"]=json!("STALE");}
    Ok(value)
}
#[tauri::command]pub fn save_public_daily_recommendations(app:AppHandle,view:tauri::Webview,snapshot:Value)->Result<Value,String>{
    if !matches!(view.label(),"main"|"dashboard"){return Err("仅主屏和工作台可保存公开榜单".into());}
    crate::simulation::require_live()?;
    if !crate::agriculture::connection(&app)?.github_enabled{return Err("公开榜单已关闭".into());}
    validate_snapshot(&snapshot)?;
    let(today,_)=clock()?;
    if snapshot["date"]!=today||snapshot["translationStatus"]!="pending"||snapshot["status"]!="OK"{return Err("公开榜单日期或状态无效".into());}
    crate::public_sources::validate_github_receipt(&app,&snapshot)?;
    let state=app.state::<DailyState>();let _lock=state.0.lock().map_err(|_|"每日推荐忙碌")?;
    let path=directory(&app)?.join("daily-opensource.json");
    if let Some(old)=load(&path)?{if old["date"]==today{validate_snapshot(&old)?;return Ok(old);}}
    save(&path,&snapshot)?;Ok(snapshot)
}
#[tauri::command]
pub async fn read_daily_recommendations(app:AppHandle)->Result<Value,String>{
    tauri::async_runtime::spawn_blocking(move||{let state=app.state::<DailyState>();let _lock=state.0.lock().map_err(|_|"每日推荐忙碌")?;read_daily(&app)}).await.map_err(|_|"推荐任务失败")?
}
#[cfg(windows)]fn secret()->Result<credentials::Secret,String>{
    let value=credentials::read(CredentialSource::Mimo)?;
    if !value.as_str().starts_with("sk-"){return Err("此入口使用 MiMo 按量计费 API Key（sk-）；Token Plan 凭据不能混用".into());}Ok(value)
}
#[tauri::command]
pub async fn mimo_connection_status()->Result<Value,String>{
    tauri::async_runtime::spawn_blocking(||{
        #[cfg(windows)]{
            let key=secret()?;let(status,bytes)=crate::http::get("api.xiaomimimo.com",443,true,"/v1/models",&format!("api-key: {}\r\nAccept: application/json\r\n",key.as_str()))?;
            if status!=200{return Err(format!("MiMo 连接验证失败（HTTP {status}），未调用推理接口"));}
            let value:Value=serde_json::from_slice(&bytes).map_err(|_|"模型列表格式无效")?;
            if !value["data"].as_array().is_some_and(|items|items.iter().any(|item|item["id"]==MODEL)){return Err("模型列表未返回 mimo-v2.6-flash，请核对账户权限".into());}
            Ok(json!({"model":MODEL,"connected":true,"balanceAvailable":false}))
        }
        #[cfg(not(windows))]{Err("连接验证需要 Windows 桌面应用".into())}
    }).await.map_err(|_|"连接验证任务失败")?
}
#[tauri::command]
pub async fn read_mimo_usage(app:AppHandle)->Result<Value,String>{
    let permit=crate::simulation::require_live()?;
    tauri::async_runtime::spawn_blocking(move||{
        let(today,at)=clock()?;let ledger=load(&directory(&app)?.join("mimo-recommendation-usage.json"))?;
        let (today_cost,month_cost)=recommendation_estimates(ledger.as_ref(),&today)?;
        let mut account=json!({"id":"mimo","name":"MiMo","state":"normal","balance":null,"currency":"CNY","observedAt":at,"sourceUrl":"https://platform.xiaomimimo.com/","availabilityReason":"balance-unavailable","periodStart":null,"periodEnd":null});
        #[cfg(windows)] if credentials::exists(CredentialSource::MimoConsole)? {
            let state=app.state::<DailyState>();let revision=credentials::revision();let mut cache=state.1.lock().map_err(|_|"余额缓存忙碌")?;
            let cached=cache.as_ref().filter(|(stamp,version,_)|*version==revision&&stamp.elapsed()<Duration::from_secs(60)).map(|(_,_,value)|value.clone());
            let balance=if let Some(value)=cached{value}else{
                permit.check()?;
                let key=credentials::read(CredentialSource::MimoConsole)?;
                let mut result=fetch_balance_result(key.as_str());
                if credentials::read(CredentialSource::MimoConsole)?.as_str()!=key.as_str(){return Err(MimoError::ConnectionChanged.message())}
                if matches!(result,Err(MimoError::LoginRequired)){
                    result=recover_mimo_session(&app,key.as_str(),&||permit.check());
                }
                permit.check()?;
                if result==Err(MimoError::ConnectionChanged){return Err(MimoError::ConnectionChanged.message())}
                let value=match result{Ok(value)=>value,Err(error)=>json!({"error":true,"loginRequired":error==MimoError::LoginRequired})};
                *cache=Some((Instant::now(),credentials::revision(),value.clone()));value
            };
            if balance["error"]==true {account["state"]=json!("warning");account["availabilityReason"]=json!(if balance["loginRequired"]==true{"balance-login-required"}else{"balance-read-failed"});}
            else {
                account["name"]=json!("MiMo");account["balance"]=balance["balance"].clone();account["currency"]=balance["currency"].clone();account["observedAt"]=balance["observedAt"].clone();account["availabilityReason"]=json!("mimo-console-balance");
            }
        }
        Ok(mimo_money_snapshot(&today,&at,account,today_cost,month_cost))
    }).await.map_err(|_|"MiMo 本机用量读取失败")?
}

fn recommendation_estimates(ledger:Option<&Value>,today:&str)->Result<(Option<f64>,Option<f64>),String>{
    let Some(ledger)=ledger else{return Ok((None,None))};
    let calls=ledger["calls"].as_array().ok_or("MiMo 用量记录无效")?;
    let sum=|period:&str|->Option<f64>{
        let rows:Vec<_>=calls.iter().filter(|row|row["date"].as_str().is_some_and(|day|day.starts_with(period))).collect();
        let mut total=0.;for row in rows{let cost=row["estimatedCostCny"].as_f64().filter(|cost|cost.is_finite()&&*cost>=0.)?;total+=cost;}
        total.is_finite().then_some(total)
    };
    Ok((sum(today),sum(&today[..7])))
}

// Keep official balance and local recommendation estimates in separate rows,
// with independent currencies, observation times and reporting periods.
fn mimo_money_snapshot(today:&str,at:&str,mut balance:Value,today_cost:Option<f64>,month_cost:Option<f64>)->Value{
    balance["name"]=json!("MiMo · 账户余额");balance["amountScope"]=json!("balance");
    balance["todayCost"]=Value::Null;balance["monthCost"]=Value::Null;
    if balance["balance"].is_null()&&balance["state"]=="normal"{balance["state"]=json!("unknown")}
    let estimate=json!({"id":"mimo-estimate","name":"MiMo · 本机推荐","state":"normal","amountScope":"local-estimate","balance":null,"currency":"CNY",
        "todayCost":today_cost,"monthCost":month_cost,"observedAt":at,"sourceUrl":"local:mimo-recommendation-ledger","availabilityReason":"local-recommendation-estimate",
        "periodTimeZone":"Asia/Shanghai","periodStart":format!("{}-01T00:00:00+08:00",&today[..7]),"periodEnd":at,"todayPeriodStart":format!("{today}T00:00:00+08:00"),"todayPeriodEnd":at});
    json!({"observedAt":at,"accounts":[balance,estimate]})
}

#[cfg(test)]mod money_tests{
    use super::*;
    #[test]fn absent_ledger_is_unknown_but_confirmed_empty_ledger_is_zero(){
        assert_eq!(recommendation_estimates(None,"2026-10-19").unwrap(),(None,None));
        assert_eq!(recommendation_estimates(Some(&json!({"calls":[]})),"2026-10-19").unwrap(),(Some(0.),Some(0.)));
        let unknown=json!({"calls":[{"date":"2026-10-19","estimatedCostCny":null}]});assert_eq!(recommendation_estimates(Some(&unknown),"2026-10-19").unwrap(),(None,None));
    }
    #[test]fn official_usd_balance_does_not_convert_or_hide_the_cny_local_estimate(){
        let value=mimo_money_snapshot("2026-10-19","2026-10-18T16:30:00Z",json!({"id":"mimo","balance":5,"currency":"USD","state":"normal","observedAt":"2026-10-18T16:29:00Z"}),Some(0.02),Some(0.3));
        assert_eq!(value["accounts"][0]["currency"],"USD");assert!(value["accounts"][0]["monthCost"].is_null());assert_eq!(value["accounts"][0]["observedAt"],"2026-10-18T16:29:00Z");
        assert_eq!(value["accounts"][1]["currency"],"CNY");assert_eq!(value["accounts"][1]["monthCost"],0.3);assert_eq!(value["accounts"][1]["todayPeriodStart"],"2026-10-19T00:00:00+08:00");assert_eq!(value["accounts"][1]["observedAt"],"2026-10-18T16:30:00Z");
    }
    #[test]fn missing_balance_and_unknown_estimates_never_become_zero(){
        let value=mimo_money_snapshot("2026-10-19","2026-10-19T00:00:00Z",json!({"id":"mimo","balance":null,"currency":"CNY","state":"normal"}),None,None);
        assert_eq!(value["accounts"][0]["state"],"unknown");assert!(value["accounts"][1]["todayCost"].is_null());assert!(value["accounts"][1]["monthCost"].is_null());
        let zero=mimo_money_snapshot("2026-10-19","2026-10-19T00:00:00Z",json!({"id":"mimo","balance":0,"currency":"CNY","state":"normal"}),Some(0.),Some(0.));assert_eq!(zero["accounts"][0]["balance"],0);assert_eq!(zero["accounts"][1]["monthCost"],0.);
    }
}


// Console protocol follows CodexBar MiMoUsageFetcher (7447bc77). Its web
// session is distinct from the model API key. Never import another browser's jar.
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
enum MimoError{LoginRequired,Unavailable,InvalidResponse,ConnectionChanged}
impl MimoError{
 fn message(self)->String{match self{
  Self::LoginRequired=>"MiMo 登录已失效，自动恢复未成功，请完成官方登录",
  Self::Unavailable=>"MiMo 余额服务暂不可用，请稍后刷新",
  Self::InvalidResponse=>"MiMo 余额返回格式暂不支持，请稍后重试",
  Self::ConnectionChanged=>"MiMo 连接已变化，请刷新后重试",
 }.into()}
}
fn parse_mimo_balance(status:u32,bytes:&[u8],at:&str)->Result<Value,MimoError>{
 if matches!(status,300..=399|401|403){return Err(MimoError::LoginRequired)}
 if status!=200||bytes.len()>65536{return Err(MimoError::Unavailable)}
 let root:Value=serde_json::from_slice(bytes).map_err(|_|MimoError::InvalidResponse)?;
 if root["code"]!=0{return Err(MimoError::InvalidResponse)}
 let balance=root["data"]["balance"].as_str().and_then(|value|value.parse::<f64>().ok()).or_else(||root["data"]["balance"].as_f64())
  .filter(|number|number.is_finite()&&number.abs()<=1e12).ok_or(MimoError::InvalidResponse)?;
 let currency=root["data"]["currency"].as_str().filter(|value|matches!(*value,"CNY"|"USD")).ok_or(MimoError::InvalidResponse)?;
 Ok(json!({"balance":balance,"currency":currency,"observedAt":at}))
}
#[cfg(windows)]
fn fetch_balance_result(cookie:&str)->Result<Value,MimoError>{
 credentials::validate(cookie).map_err(|_|MimoError::InvalidResponse)?;
 let headers=credentials::Secret::from_string(format!("Cookie: {cookie}\r\nAccept: application/json\r\nOrigin: https://platform.xiaomimimo.com\r\nReferer: https://platform.xiaomimimo.com/#/console/balance\r\nx-timeZone: UTC+08:00\r\n"));
 let(status,mut bytes)=crate::http::get("platform.xiaomimimo.com",443,true,"/api/v1/balance",headers.as_str()).map_err(|_|MimoError::Unavailable)?;
 let(_,at)=clock().map_err(|_|MimoError::Unavailable)?;
 let result=parse_mimo_balance(status,&bytes,&at);bytes.fill(0);result
}
const MIMO_COOKIES:[&str;4]=["api-platform_serviceToken","userId","api-platform_ph","api-platform_slh"];
fn mimo_cookie<'a>(header:&'a str,name:&str)->Option<&'a str>{
 header.split("; ").filter_map(|part|part.split_once('=')).find(|(key,_)|*key==name).map(|(_,value)|value)
}
fn mimo_header<'a>(pairs:impl IntoIterator<Item=(&'a str,&'a str)>)->Result<credentials::Secret,MimoError>{
 let mut selected=std::collections::BTreeMap::new();
 for (name,value) in pairs{
  if !MIMO_COOKIES.contains(&name){continue}
  if value.is_empty()||value.len()>2000||!value.bytes().all(|byte|(32..=126).contains(&byte)&&byte!=b';'){return Err(MimoError::InvalidResponse)}
  if selected.insert(name,value).is_some_and(|previous|previous!=value){return Err(MimoError::ConnectionChanged)}
 }
 if !selected.contains_key("api-platform_serviceToken")||!selected.contains_key("userId"){return Err(MimoError::LoginRequired)}
 let secret=credentials::Secret::from_string(selected.into_iter().map(|(name,value)|format!("{name}={value}")).collect::<Vec<_>>().join("; "));
 credentials::validate(secret.as_str()).map_err(|_|MimoError::InvalidResponse)?;Ok(secret)
}
fn same_mimo_account(original:&str,current:&str)->bool{
 match (mimo_cookie(original,"userId"),mimo_cookie(current,"userId")){
  (Some(a),Some(b))=>!a.is_empty()&&a==b,_=>false,
 }
}
fn mimo_navigation(url:&tauri::Url)->bool{
 url.scheme()=="https"&&url.host_str().is_some_and(|host|["mi.com","xiaomimimo.com","xiaomi.com"].iter().any(|domain|host==*domain||host.ends_with(&format!(".{domain}"))))
}
fn mimo_window(app:&AppHandle,label:&str,visible:bool)->Result<tauri::WebviewWindow,String>{
 let url=tauri::Url::parse("https://platform.xiaomimimo.com/#/console/balance").map_err(|_|"MiMo 官方网址无效")?;
 let profile=directory(app)?.join("mimo-console-profile");fs::create_dir_all(&profile).map_err(|_|"MiMo 登录配置目录无法创建")?;
 tauri::WebviewWindowBuilder::new(app,label,tauri::WebviewUrl::External(url))
  .title("MiMo 官方账户 · 登录后返回工作台连接余额")
  .inner_size(1080.,760.).data_directory(profile).visible(visible).focused(visible).skip_taskbar(!visible)
  .on_navigation(mimo_navigation).on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny)
  .build().map_err(|_|"MiMo 官方登录窗口创建失败".into())
}
fn capture_mimo_session(view:&tauri::WebviewWindow)->Result<credentials::Secret,MimoError>{
 let current=view.url().map_err(|_|MimoError::Unavailable)?;
 if current.scheme()!="https"||current.host_str()!=Some("platform.xiaomimimo.com"){return Err(MimoError::LoginRequired)}
 let url=tauri::Url::parse("https://platform.xiaomimimo.com/api/v1/balance").map_err(|_|MimoError::Unavailable)?;
 let cookies=view.cookies_for_url(url).map_err(|_|MimoError::Unavailable)?;
 mimo_header(cookies.iter().map(|cookie|(cookie.name(),cookie.value())))
}
#[cfg(windows)]
fn recover_mimo_session(app:&AppHandle,expected:&str,check:&impl Fn()->Result<(),String>)->Result<Value,MimoError>{
 check().map_err(|_|MimoError::ConnectionChanged)?;
 // Do not navigate, hide, or close a window the user is already logging into.
 if app.get_webview_window("mimo-account").is_some(){return Err(MimoError::LoginRequired)}
 let state=app.state::<DailyState>();let generation=state.2.lock().map_err(|_|MimoError::Unavailable)?
  .begin(Instant::now(),credentials::revision()).ok_or(MimoError::LoginRequired)?;
 let view=mimo_window(app,"mimo-session-restore",false).map_err(|_|MimoError::Unavailable)?;
 struct RestoreWindow(tauri::WebviewWindow);impl Drop for RestoreWindow{fn drop(&mut self){let _=self.0.close();}}
 let _close=RestoreWindow(view.clone());
 let deadline=Instant::now()+Duration::from_secs(12);let mut last_candidate=None::<credentials::Secret>;
 while Instant::now()<deadline{
  check().map_err(|_|MimoError::ConnectionChanged)?;
  if state.2.lock().map_err(|_|MimoError::Unavailable)?.generation!=generation{return Err(MimoError::ConnectionChanged)}
  if credentials::read(CredentialSource::MimoConsole).ok().is_none_or(|value|value.as_str()!=expected){return Err(MimoError::ConnectionChanged)}
  if let Ok(candidate)=capture_mimo_session(&view){
   if !same_mimo_account(expected,candidate.as_str()){return Err(MimoError::LoginRequired)}
   let changed=mimo_cookie(expected,"api-platform_serviceToken")!=mimo_cookie(candidate.as_str(),"api-platform_serviceToken");
   let untried=last_candidate.as_ref().is_none_or(|previous|previous.as_str()!=candidate.as_str());
   if changed&&untried{
    match fetch_balance_result(candidate.as_str()){
     Ok(value)=>{
      check().map_err(|_|MimoError::ConnectionChanged)?;
      let current=capture_mimo_session(&view)?;
      if !same_mimo_account(candidate.as_str(),current.as_str())||mimo_cookie(candidate.as_str(),"api-platform_serviceToken")!=mimo_cookie(current.as_str(),"api-platform_serviceToken"){return Err(MimoError::ConnectionChanged)}
      let flow=state.2.lock().map_err(|_|MimoError::Unavailable)?;
      if flow.generation!=generation{return Err(MimoError::ConnectionChanged)}
      if !credentials::refresh_mimo_console(expected,current.as_str()).map_err(|_|MimoError::Unavailable)?{return Err(MimoError::ConnectionChanged)}
      return Ok(value)
     },
     Err(MimoError::LoginRequired)=>{},Err(error)=>return Err(error),
    }
    last_candidate=Some(candidate);
   }
  }
  std::thread::sleep(Duration::from_millis(300));
 }
 Err(MimoError::LoginRequired)
}
#[tauri::command]
pub async fn mimo_balance_open(app:AppHandle,window:tauri::Webview)->Result<(),String>{
 if !matches!(window.label(),"main"|"dashboard"){return Err("此窗口不能连接 MiMo 账户".into())}
 crate::simulation::require_live()?;
 app.state::<DailyState>().2.lock().map_err(|_|"MiMo 连接忙碌")?.cancel();
 if let Some(view)=app.get_webview_window("mimo-session-restore"){let _=view.close();}
 if let Some(view)=app.get_webview_window("mimo-account"){
  view.show().map_err(|_|"MiMo 登录窗口无法显示")?;return view.set_focus().map_err(|_|"MiMo 登录窗口无法聚焦".into())
 }
 mimo_window(&app,"mimo-account",true)?;Ok(())
}
#[tauri::command]
pub async fn mimo_balance_connect(app:AppHandle,window:tauri::Webview,consent:bool)->Result<Value,String>{
 if !consent||!matches!(window.label(),"main"|"dashboard"){return Err("尚未同意连接 MiMo 余额账户".into())}
 let permit=crate::simulation::require_live()?;
 tauri::async_runtime::spawn_blocking(move||{
  #[cfg(windows)]{
   permit.check()?;
   let view=app.get_webview_window("mimo-account").ok_or("请先打开 MiMo 官方账户并完成登录")?;
   let header=capture_mimo_session(&view).map_err(MimoError::message)?;
   let balance=fetch_balance_result(header.as_str()).map_err(MimoError::message)?;
   let current=capture_mimo_session(&view).map_err(MimoError::message)?;
   if !same_mimo_account(header.as_str(),current.as_str())||mimo_cookie(header.as_str(),"api-platform_serviceToken")!=mimo_cookie(current.as_str(),"api-platform_serviceToken"){return Err("MiMo 登录账号发生变化，请重新连接".into())}
   permit.check()?;
   credentials::save(CredentialSource::MimoConsole,current.as_str())?;
   let state=app.state::<DailyState>();
   *state.1.lock().map_err(|_|"余额缓存忙碌")?=Some((Instant::now(),credentials::revision(),balance.clone()));
   let _=view.close();Ok(balance)
  }
  #[cfg(not(windows))]{let _=(app,permit);Err("余额账户连接需要 Windows 桌面应用".into())}
 }).await.map_err(|_|"余额账户连接任务失败")?
}

#[cfg(test)]
mod mimo_session_tests{
 use super::*;
 #[test]fn only_official_auth_failures_request_session_recovery(){
  for status in [301,401,403]{assert_eq!(parse_mimo_balance(status,b"{}","stamp"),Err(MimoError::LoginRequired))}
  for status in [429,500,503]{assert_eq!(parse_mimo_balance(status,b"{}","stamp"),Err(MimoError::Unavailable))}
  assert_eq!(parse_mimo_balance(200,b"not-json","stamp"),Err(MimoError::InvalidResponse));
  assert_eq!(parse_mimo_balance(200,br#"{"code":1}"#,"stamp"),Err(MimoError::InvalidResponse));
  let value=parse_mimo_balance(200,br#"{"code":0,"data":{"balance":"0","currency":"USD"}}"#,"stamp").unwrap();
  assert_eq!(value["balance"],0.);assert_eq!(value["currency"],"USD");
 }
 #[test]fn recovery_is_bounded_and_a_manual_login_cancels_its_generation(){
  let mut state=MimoRecovery::default();let now=Instant::now();let generation=state.begin(now,1).unwrap();
  assert_eq!(state.begin(now+Duration::from_secs(299),1),None);
  assert!(state.begin(now+Duration::from_secs(300),1).is_some());
  assert!(state.begin(now,2).is_some());state.cancel();assert_ne!(state.generation,generation);
 }
 #[test]fn refresh_cannot_switch_the_account_or_accept_injected_cookies(){
  let a=mimo_header([("api-platform_serviceToken","old"),("userId","synthetic-a")]).unwrap();
  let same=mimo_header([("api-platform_serviceToken","new"),("userId","synthetic-a"),("unrelated","ignored")]).unwrap();
  let other=mimo_header([("api-platform_serviceToken","new"),("userId","synthetic-b")]).unwrap();
  assert!(same_mimo_account(a.as_str(),same.as_str()));assert!(!same_mimo_account(a.as_str(),other.as_str()));
  assert!(!same.as_str().contains("unrelated"));assert!(mimo_header([("userId","partial")]).is_err());
  for bad in ["bad\r\nheader","bad;another=value"]{assert!(mimo_header([("api-platform_serviceToken",bad),("userId","synthetic-a")]).is_err())}
  assert!(mimo_header([("api-platform_serviceToken","new"),("userId","synthetic-a"),("userId","synthetic-b")]).is_err());
  for url in ["http://platform.xiaomimimo.com","https://xiaomimimo.com.evil.example","file:///C:/secret"]{assert!(!mimo_navigation(&tauri::Url::parse(url).unwrap()))}
 }
}
