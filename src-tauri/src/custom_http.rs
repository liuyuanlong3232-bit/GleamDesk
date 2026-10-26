use serde::{Serialize,Deserialize};
use serde_json::{json,Value};
use std::{collections::HashMap,sync::{Arc,Mutex},time::{Instant,Duration}};
use tauri::{AppHandle,Manager};

#[derive(Clone,Debug,PartialEq,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct QuoteFields{pub symbol:String,pub price:String,pub name:String,pub change_pct:String,pub quote_at:String,pub collected_at:String,pub unit:String,pub currency:String}
#[derive(Clone,Debug,PartialEq,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct CustomHttpSource{
 pub id:String,pub name:String,pub enabled:bool,pub url:String,pub auto_refresh:bool,pub refresh_minutes:u32,pub rows_path:String,pub row_mode:String,
 pub data_type:String,pub time_format:String,pub collection_format:String,pub change_scale:String,pub stale_minutes:u32,pub fields:QuoteFields,
}
fn valid_path(path:&str)->bool{path.len()<=160&&(path.is_empty()||path.split('.').all(|s|!s.is_empty()&&!matches!(s,"__proto__"|"prototype"|"constructor")&&!s.chars().any(|c|c.is_whitespace()||"[]{}()".contains(c))))}
pub(crate) fn endpoint(raw:&str)->Result<(String,u16,String),String>{
 if raw.len()>2048||raw.chars().any(|c|c.is_control()||c.is_whitespace()||c=='\\'){return Err("接口地址无效".into());}
 let url=tauri::Url::parse(raw).map_err(|_|"接口地址无效")?;
 if url.scheme()!="https"||url.fragment().is_some(){return Err("首版仅支持不带片段的 HTTPS 公开 GET 接口".into());}
 let authority=raw.split("//").nth(1).unwrap_or("").split(['/', '?','#']).next().unwrap_or("");
 if !url.username().is_empty()||url.password().is_some()||authority.contains('@'){return Err("地址不能携带用户名、密码或鉴权信息".into());}
 let host=url.host_str().ok_or("接口缺少主机名")?.trim_matches(['[',']']).trim_end_matches('.').to_ascii_lowercase();
 if let Ok(ip)=host.parse::<std::net::IpAddr>(){if !crate::beszel::public_location_ip(ip){return Err("首版不支持本机、内网或保留 IP 地址".into());}}
 else if !host.contains('.')||["localhost","local","internal"].iter().any(|suffix|host==*suffix||host.ends_with(&format!(".{suffix}"))){return Err("首版请使用公开接口的完整域名".into());}
 for(key,_)in url.query_pairs(){let k=key.to_ascii_lowercase();if k.ends_with("key")||k.contains("token")||k.contains("secret")||k.contains("password")||k.contains("credential")||k.contains("authorization")||k.contains("cookie")||k.contains("signature")||k=="auth"{return Err("首版不支持带密钥或鉴权参数的接口".into());}}
 let lower=raw.to_ascii_lowercase();if ["%00","%0a","%0d"].iter().any(|s|lower.contains(s)){return Err("接口地址含无效控制字符".into());}
 let mut path=url.path().to_string();if let Some(query)=url.query(){path.push('?');path.push_str(query);}
 Ok((host,url.port_or_known_default().ok_or("接口端口无效")?,path))
}
impl CustomHttpSource{
 pub(crate) fn validate(&self)->Result<(),String>{
  if self.id.is_empty()||self.id.len()>64||!self.id.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'){return Err("自定义来源标识无效".into());}
  if self.name.trim().is_empty()||self.name.chars().count()>60||self.name.chars().any(char::is_control){return Err("请填写 60 字以内的来源名称".into());}
  endpoint(&self.url)?;
  if !(5..=1440).contains(&self.refresh_minutes)||!(1..=1440).contains(&self.stale_minutes){return Err("刷新间隔须为 5–1440 分钟，盘中过期阈值须为 1–1440 分钟".into());}
  if !matches!(self.row_mode.as_str(),"list"|"single")||!matches!(self.data_type.as_str(),"daily"|"intraday")||!matches!(self.change_scale.as_str(),"percent"|"ratio")||[&self.time_format,&self.collection_format].iter().any(|s|!matches!(s.as_str(),"iso"|"yyyymmdd"|"unixSeconds"|"unixMilliseconds")){return Err("行情类型或字段格式无效".into());}
  if self.fields.symbol.is_empty()||self.fields.price.is_empty(){return Err("请填写代码和价格的字段位置".into());}
  for path in [&self.rows_path,&self.fields.symbol,&self.fields.price,&self.fields.name,&self.fields.change_pct,&self.fields.quote_at,&self.fields.collected_at,&self.fields.unit,&self.fields.currency]{if !valid_path(path){return Err("字段位置只支持点分隔字段名和数组下标".into());}}
  Ok(())
 }
}
#[derive(Default)]struct Entry{config:String,attempt:Option<Instant>,good:Option<Value>,error:Option<String>}
#[derive(Default)]pub struct CustomHttpState(Mutex<HashMap<String,Arc<Mutex<Entry>>>>);
fn cached_read(entry:&mut Entry,source:&CustomHttpSource,refresh:bool,fetch:impl FnOnce()->Result<Value,String>)->Value{
 let key=serde_json::to_string(source).unwrap_or_default();if entry.config!=key{*entry=Entry{config:key,..Default::default()};}
 let due=entry.attempt.is_none_or(|at|at.elapsed()>=Duration::from_secs(u64::from(source.refresh_minutes)*60));
 let throttled=entry.attempt.is_some_and(|at|at.elapsed()<Duration::from_secs(5));
 if !throttled&&(refresh||source.auto_refresh&&due){let result=fetch();entry.attempt=Some(Instant::now());match result{Ok(value)=>{entry.good=Some(value);entry.error=None;},Err(error)=>entry.error=Some(error)}}
 let expired=entry.attempt.is_some_and(|at|at.elapsed()>=Duration::from_secs(u64::from(source.refresh_minutes)*60));
 let mut out=entry.good.clone().unwrap_or_else(||json!({"receivedAt":null,"payload":null}));
 out["id"]=json!(source.id);out["status"]=json!(if entry.good.is_some(){if entry.error.is_some()||expired{"stale"}else{"normal"}}else if entry.error.is_some(){"error"}else{"unread"});
 out["error"]=json!(entry.error.as_deref().unwrap_or(if expired{"缓存已过期，请手动读取"}else{""}));out
}
#[tauri::command]pub async fn read_custom_http_source(app:AppHandle,view:tauri::Webview,id:String,refresh:bool)->Result<Value,String>{
 if !matches!(view.label(),"main"|"dashboard"){return Err("仅主屏和工作台可读取自定义行情".into());}
 crate::simulation::require_live()?;
 tauri::async_runtime::spawn_blocking(move||{
  let config=crate::agriculture::connection(&app)?;
  let source=config.custom_sources.iter().find(|s|s.id==id&&s.enabled).cloned().ok_or("自定义来源未启用或已移除")?;source.validate()?;
  let state=app.state::<CustomHttpState>();let slot={let mut slots=state.0.lock().map_err(|_|"自定义来源缓存不可用")?;slots.retain(|id,_|config.custom_sources.iter().any(|s|s.id==*id));slots.entry(id.clone()).or_default().clone()};
  let mut entry=slot.lock().map_err(|_|"该接口正在读取")?;
  crate::simulation::require_live()?;
  let current=crate::agriculture::connection(&app)?;if !current.custom_sources.contains(&source){return Err("来源配置已更改，请重新读取".into());}
  let result=cached_read(&mut entry,&source,refresh,||{
   #[cfg(windows)]{
    let permit=crate::simulation::require_live()?;let(host,port,path)=endpoint(&source.url)?;
    let(status,bytes)=crate::http::anonymous_get(&host,port,&path,&||permit.check())?;
    if status!=200{return Err(format!("接口返回 HTTP {status}，暂不可用"));}
    let payload:Value=serde_json::from_slice(&bytes).map_err(|_|"接口没有返回有效 JSON")?;if !payload.is_object()&&!payload.is_array(){return Err("接口 JSON 须为对象或数组".into());}
    let(_,at)=crate::daily_recommendations::clock()?;Ok(json!({"receivedAt":at,"payload":payload}))
   }
   #[cfg(not(windows))]{Err("自定义读取目前需要 Windows 桌面程序".into())}
  });
  if !crate::agriculture::connection(&app)?.custom_sources.contains(&source){return Err("来源配置已更改，忽略旧响应".into());}Ok(result)
 }).await.map_err(|_|"自定义行情读取任务失败")?
}
#[cfg(test)]mod tests{
 use super::*;
 fn source()->CustomHttpSource{serde_json::from_value(json!({"id":"test","name":"示例","enabled":true,"url":"https://example.org/quotes?symbol=A","autoRefresh":false,"refreshMinutes":15,"rowsPath":"data","rowMode":"list","dataType":"daily","timeFormat":"iso","collectionFormat":"iso","changeScale":"percent","staleMinutes":15,"fields":{"symbol":"code","price":"price","name":"","changePct":"","quoteAt":"date","collectedAt":"","unit":"","currency":""}})).unwrap()}
 #[test]fn urls_reject_auth_private_hosts_controls_and_schemes(){for url in ["http://example.org/","https://user:pass@example.org/","https://127.0.0.1/","https://[::1]/","https://10.0.0.1/","https://localhost/","https://x.local/","https://example.org/?api%5Fkey=secret","https://example.org/?token=x","https://example.org/#x","https://example.org/%0Dtest","file:///tmp/x"]{assert!(endpoint(url).is_err(),"{url}");}assert_eq!(endpoint("https://example.org:8443/a?symbol=A").unwrap(),("example.org".into(),8443,"/a?symbol=A".into()));}
 #[test]fn mapping_and_intervals_are_checked(){let mut source=source();assert!(source.validate().is_ok());source.fields.price="constructor.x".into();assert!(source.validate().is_err());source=super::tests::source();source.refresh_minutes=1;assert!(source.validate().is_err());}
 #[test]fn manual_mode_never_fetches_on_load(){let mut entry=Entry::default();assert_eq!(cached_read(&mut entry,&source(),false,||panic!("must not connect"))["status"],"unread");}
 #[test]fn manual_click_once_and_other_windows_reuse_cache(){let mut entry=Entry::default();let mut calls=0;for _ in 0..3{cached_read(&mut entry,&source(),true,||{calls+=1;Ok(json!({"receivedAt":"2026-10-22T00:00:00Z","payload":[]}))});}assert_eq!(calls,1);}
 #[test]fn changed_config_cannot_reuse_previous_source(){let mut entry=Entry::default();cached_read(&mut entry,&source(),true,||Ok(json!({"payload":[1]})));let mut next=source();next.url="https://example.org/other".into();let value=cached_read(&mut entry,&next,false,||panic!());assert_eq!(value["status"],"unread");assert!(value["payload"].is_null());}
 #[test]fn failure_retains_actual_timestamp_and_never_counts_as_success(){let mut entry=Entry::default();let s=source();cached_read(&mut entry,&s,true,||Ok(json!({"receivedAt":"2026-10-21T00:00:00Z","payload":[1]})));entry.attempt=Some(Instant::now()-Duration::from_secs(6));let result=cached_read(&mut entry,&s,true,||Err("offline".into()));assert_eq!(result["status"],"stale");assert_eq!(result["receivedAt"],"2026-10-21T00:00:00Z");}
 #[test]fn automatic_refresh_obeys_configured_interval(){let mut entry=Entry::default();let mut s=source();s.auto_refresh=true;let mut calls=0;for _ in 0..3{cached_read(&mut entry,&s,false,||{calls+=1;Ok(json!({"payload":[]}))});}assert_eq!(calls,1);entry.attempt=Some(Instant::now()-Duration::from_secs(901));cached_read(&mut entry,&s,false,||{calls+=1;Ok(json!({"payload":[]}))});assert_eq!(calls,2);}
 #[test]fn throttle_starts_after_completion_so_waiting_windows_reuse_the_result(){let mut entry=Entry::default();let mut completed=Instant::now();cached_read(&mut entry,&source(),true,||{completed=Instant::now();Ok(json!({"payload":[]}))});assert!(entry.attempt.unwrap()>=completed);}
 #[cfg(windows)]#[test]fn anonymous_transport_cancels_before_network(){assert_eq!(crate::http::anonymous_get("example.org",443,"/",&||Err("fixture cancelled".into())).unwrap_err(),"fixture cancelled");}
}
