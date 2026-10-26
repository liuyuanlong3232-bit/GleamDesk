// Public, fixed HTTPS sources. No SSH, keys, Python installation or model calls.
use serde_json::{json,Value};
use std::{collections::HashMap,sync::{Arc,Mutex},time::{Instant,Duration}};
use tauri::{AppHandle,Manager};

type Cached=Option<(Instant,Result<Value,String>)>;
pub(crate) fn nass_report_kind(path:&str)->Option<&'static str>{
 let rest=path.strip_prefix("/sites/default/release-files/")?;let parts:Vec<_>=rest.split('/').collect();
 if !(2..=4).contains(&parts.len())||parts[..parts.len()-1].iter().any(|s|s.is_empty()||!s.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b))){return None;}
 let file=parts.last()?.strip_suffix(".txt")?;
 if file.strip_prefix("cropan").is_some_and(|s|s.len()==2&&s.bytes().all(|b|b.is_ascii_digit())){return Some("nass-annual");}
 if let Some(s)=file.strip_prefix("prog"){if s.len()==4&&s.bytes().all(|b|b.is_ascii_digit())&&(1..=53).contains(&s[..2].parse::<u8>().ok()?){return Some("crop-progress");}}
 None
}
#[cfg(windows)]fn fetch_nass(key:&str,page:&str,check:&impl Fn()->Result<(),String>)->Result<Value,String>{
 let(status,bytes)=crate::http::nass_get(page,check)?;if status!=200{return Err(format!("NASS 发布页返回 HTTP {status}"));}
 let html=String::from_utf8(bytes).map_err(|_|"NASS 发布页编码无效")?;
 let tail=html.rsplit_once("Latest Release").map(|(_,tail)|tail).ok_or("NASS 最新发布区未找到")?;
 let table=tail.split_once("</table>").map(|(table,_)|table).ok_or("NASS 最新发布表变化")?;
 let mut paths=Vec::new();
 for fragment in table.split("href=").skip(1){let fragment=fragment.trim_start();let quote=fragment.chars().next().unwrap_or(' ');if !matches!(quote,'\''|'"'){continue;}if let Some(end)=fragment[1..].find(quote){let link=&fragment[1..end+1];let path=link.strip_prefix("https://esmis.nal.usda.gov").unwrap_or(link);if nass_report_kind(path)==Some(key){paths.push(path.to_string());}}}
 paths.sort();paths.dedup();if paths.len()!=1{return Err("NASS 最新文本报告链接不唯一".into());}
 check()?;let path=&paths[0];let(status,bytes)=crate::http::nass_get(path,check)?;if status!=200{return Err(format!("NASS 报告返回 HTTP {status}"));}
 // Legacy reports contain a few non-UTF8 punctuation characters. The numeric tables are ASCII and are validated in the parser.
 let body=String::from_utf8_lossy(&bytes).into_owned();check()?;let(_,at)=crate::daily_recommendations::clock()?;
 Ok(json!({"key":key,"sourceUrl":format!("https://esmis.nal.usda.gov{path}"),"collectedAt":at,"body":body}))
}
pub(crate) const WASDE_PAGE:&str="/about-usda/general-information/staff-offices/office-chief-economist/commodity-markets/wasde-report";
pub(crate) fn wasde_xml_path(value:&str)->Option<(String,String)>{
 let path=value.strip_prefix("https://www.usda.gov").unwrap_or(value);
 let code=path.strip_prefix("/oce/commodity/wasde/wasde")?.strip_suffix(".xml")?;
 if code.len()!=4||!code.bytes().all(|b|b.is_ascii_digit()){return None;}
 let month=code[..2].parse::<u8>().ok()?;if !(1..=12).contains(&month){return None;}
 Some((format!("20{}-{}",&code[2..],&code[..2]),path.to_string()))
}
fn latest_wasde_path(html:&str,at:&str)->Result<String,String>{
 // Inspect only quoted href values; never infer a filename from today's date.
 let mut links=Vec::new();
 for fragment in html.split("href=").skip(1){
  let fragment=fragment.trim_start();let quote=fragment.chars().next().unwrap_or(' ');
  if !matches!(quote,'\''|'"'){continue;}
  if let Some(end)=fragment[1..].find(quote){if let Some((month,path))=wasde_xml_path(&fragment[1..end+1]){if month.as_str()<=at.get(..7).unwrap_or(""){links.push((month,path));}}}
 }
 links.sort();links.pop().map(|(_,path)|path).ok_or("USDA 页面没有可核对的月报 XML 链接".into())
}
#[cfg(windows)]fn fetch_wasde(check:&impl Fn()->Result<(),String>)->Result<Value,String>{
 let(_,at)=crate::daily_recommendations::clock()?;
 let(status,page)=crate::http::wasde_get(WASDE_PAGE,check)?;
 if status!=200{return Err(format!("USDA 报告目录返回 HTTP {status}"));}
 let page=String::from_utf8(page).map_err(|_|"USDA 目录编码无效")?;
 let path=latest_wasde_path(&page,&at)?;
 check()?;let(status,xml)=crate::http::wasde_get(&path,check)?;
 if status!=200{return Err(format!("USDA 月报返回 HTTP {status}"));}
 let body=String::from_utf8(xml).map_err(|_|"USDA 月报编码无效")?;
 check()?;let(_,collected)=crate::daily_recommendations::clock()?;
 Ok(json!({"key":"wasde","collectedAt":collected,"sourceUrl":format!("https://www.usda.gov{path}"),"body":body}))
}
#[derive(Default)]pub struct PublicSourceState {weather:Mutex<Cached>,github:Mutex<Cached>,builtin:Mutex<HashMap<String,Arc<Mutex<Cached>>>>,metal_gate:Mutex<Option<Instant>>}
#[cfg(windows)]fn noaa_window()->Result<(String,String),String>{
 let seconds=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_|"NOAA 请求日期不可用")?.as_secs();
 noaa_window_at(seconds)
}
#[cfg(windows)]fn noaa_window_at(seconds:u64)->Result<(String,String),String>{
 use windows_sys::Win32::{Foundation::{FILETIME,SYSTEMTIME},System::Time::FileTimeToSystemTime};
 let today=seconds/86400;
 let date=|days:u64|->Result<String,String>{
  let seconds=today.checked_sub(days).ok_or("NOAA 请求日期不可用")?*86400;
  let ticks=(seconds+11644473600)*10_000_000;
  let file=FILETIME{dwHighDateTime:(ticks>>32) as u32,dwLowDateTime:ticks as u32};let mut utc:SYSTEMTIME=unsafe{std::mem::zeroed()};
  if unsafe{FileTimeToSystemTime(&file,&mut utc)}==0{return Err("NOAA 请求日期不可用".into());}
  Ok(format!("{:04}-{:02}-{:02}",utc.wYear,utc.wMonth,utc.wDay))
 };
 Ok((date(30)?,date(1)?))
}
#[cfg(windows)]fn fetch_noaa(check:&impl Fn()->Result<(),String>)->Result<Value,String>{
 let(start,end)=noaa_window()?;
 let stations:Vec<Value>=serde_json::from_str(include_str!("../../src/domain/agriculture/publicNoaaStations.json")).map_err(|_|"NOAA 站点配置无效")?;
 let ids=stations.iter().map(|s|s["id"].as_str().filter(|id|id.len()==11&&id.bytes().all(|b|b.is_ascii_alphanumeric())).ok_or("NOAA 站点编号无效")).collect::<Result<Vec<_>,_>>()?.join(",");
 let path=format!("/access/services/data/v1?dataset=daily-summaries&stations={ids}&dataTypes=PRCP,TMAX,TMIN&startDate={start}&endDate={end}&units=metric&format=json&includeAttributes=true&includeStationName=true");
 let(status,bytes)=crate::http::anonymous_get("www.ncei.noaa.gov",443,&path,check)?;
 if status!=200{return Err(format!("NOAA 站点服务返回 HTTP {status}，暂不可用"));}
 let body=String::from_utf8(bytes).map_err(|_|"NOAA 数据编码无效")?;check()?;
 let(_,at)=crate::daily_recommendations::clock()?;
 Ok(json!({"key":"noaa-observed","collectedAt":at,"windowStart":start,"windowEnd":end,"units":"metric","body":body}))
}
fn cached(slot:&Mutex<Cached>,fetch:impl FnOnce()->Result<Value,String>)->Result<Value,String>{
    cached_for(slot,3600,fetch)
}
fn cached_weather(slot:&Mutex<Cached>,at:&str,fetch:impl FnOnce()->Result<Value,String>)->Result<Value,String>{
    {let mut entry=slot.lock().map_err(|_|"天气来源忙碌")?;
     if entry.as_ref().is_some_and(|(_,r)|r.as_ref().is_ok_and(|v|v["collectedAt"].as_str().and_then(|s|s.get(..10))!=at.get(..10))){*entry=None;}}
    cached(slot,fetch)
}
fn cached_for(slot:&Mutex<Cached>,seconds:u64,fetch:impl FnOnce()->Result<Value,String>)->Result<Value,String>{
    let mut slot=slot.lock().map_err(|_|"公开来源正在读取")?;
    if let Some((at,result))=slot.as_ref(){if at.elapsed()<Duration::from_secs(if result.is_ok(){seconds}else{300}){return result.clone();}}
    let result=fetch();*slot=Some((Instant::now(),result.clone()));result
}
// Only this fixed list can be requested; no user URLs, history/key endpoints or remote execution.
const CFTC_PATH:&str=concat!("/resource/72hh-3qpy.json?$select=cftc_contract_market_code,market_and_exchange_names,report_date_as_yyyy_mm_dd,open_interest_all,m_money_positions_long_all,m_money_positions_short_all,change_in_m_money_long_all,change_in_m_money_short_all,contract_units,futonly_or_combined",
    "&$where=cftc_contract_market_code%20in%28%27002602%27,%27005602%27,%27007601%27,%27026603%27,%27001612%27,%27001602%27%29%20AND%20futonly_or_combined%3D%27FutOnly%27&$order=report_date_as_yyyy_mm_dd%20DESC,cftc_contract_market_code%20ASC&$limit=60");
fn builtin_source(key:&str)->Result<(&'static str,&'static str,u64,bool),String>{
    match key {
        "news-china"=>Ok(("www.chinanews.com.cn","/rss/finance.xml",900,true)),
        "news-fed"=>Ok(("www.federalreserve.gov","/feeds/press_monetary.xml",900,true)),
        "news-ecb"=>Ok(("www.ecb.europa.eu","/rss/press.html",900,true)),
        "a-shares"=>Ok(("qt.gtimg.cn","/q=",60,false)),
        "overseas-futures"=>Ok(("query1.finance.yahoo.com","/v7/finance/spark",300,false)),
        "cn-futures"=>Ok(("hq.sinajs.cn","/list=",60,false)),
        "em-cotton"=>Ok(("futsseapi.eastmoney.com","/static/108_CT00Y_qt?field=name,sc,dm,p,utime,zsjd",300,false)),
        "em-tin"=>Ok(("futsseapi.eastmoney.com","/static/109_LTNT_qt?field=name,sc,dm,p,utime,zsjd",300,false)),
        "gold"=>Ok(("api.gold-api.com","/price/XAU",300,false)),
        "silver"=>Ok(("api.gold-api.com","/price/XAG",300,false)),
        "fx-ecb"=>Ok(("www.ecb.europa.eu","/stats/eurofxref/eurofxref-daily.xml",3600,false)),
        "usda-inspections"=>Ok(("www.ams.usda.gov","/mnreports/wa_gr101.txt",21600,false)),
        "noaa-observed"=>Ok(("www.ncei.noaa.gov","/access/services/data/v1",21600,false)),
        "nass-annual"=>Ok(("esmis.nal.usda.gov","/publication/crop-production-annual-summary",86400,false)),
        "crop-progress"=>Ok(("esmis.nal.usda.gov","/publication/crop-progress",21600,false)),
        "monthly-commodities"=>Ok(("fred.stlouisfed.org","/graph/fredgraph.csv?id=PMAIZMTUSDM,PWHEAMTUSDM,PCOTTINDUSDM,PSUGAISAUSDM",86400,false)),
        "worldbank-monthly"=>Ok(("www.worldbank.org",crate::worldbank::PAGE,86400,false)),
        "argentina-crops"=>Ok(("www.magyp.gob.ar",crate::argentina::PAGE,86400,false)),
        "conab-crops"=>Ok(("www.gov.br",crate::conab::PAGE,86400,false)),
        "ibge-crops"=>Ok(("apisidra.ibge.gov.br","/values/t/6588/n1/1/v/35/p/last%201/c48/39428,39441,39442,39443,39445",86400,false)),
        "wasde"=>Ok(("www.usda.gov",WASDE_PAGE,21600,false)),
        "cftc-agri"=>Ok(("publicreporting.cftc.gov",CFTC_PATH,3600,false)),
        _=>Err("未知的内置公开来源".into())
    }
}

fn overseas_futures_path(symbols:&[String])->Result<String,String>{
 if symbols.is_empty()||symbols.len()>11{return Err("海外公开行情代码数量须为1到11个".into());}
 let mut codes=Vec::new();
 for symbol in symbols{
  if !matches!(symbol.as_str(),"DX-Y.NYB"|"GC=F"|"SI=F"|"CL=F"|"ZC=F"|"ZS=F"|"ZW=F"|"ZL=F"|"ZM=F"|"CT=F"|"SB=F"){return Err("暂不支持该海外行情代码".into());}
  codes.push(symbol.replace('=',"%3D"));
 }
 codes.sort();codes.dedup();if codes.len()!=symbols.len(){return Err("海外期货代码重复".into());}
 Ok(format!("/v7/finance/spark?symbols={}&range=1d&interval=1d",codes.join("%2C")))
}
fn a_stock_path(symbols:&[String])->Result<String,String>{
 if symbols.is_empty()||symbols.len()>60{return Err("A股代码数量须为1到60个".into());}
 let mut codes=Vec::new();
 for symbol in symbols{
  let (code,market)=symbol.rsplit_once('.').ok_or("股票代码须含市场后缀")?;
  if market=="HK" && code.len()==5 && code!="00000" && code.bytes().all(|b|b.is_ascii_digit()){codes.push(format!("hk{code}"));continue;}
  if market=="US" && !code.is_empty() && code.len()<=14 && code.as_bytes()[0].is_ascii_uppercase() && code.bytes().all(|b|b.is_ascii_uppercase()||b.is_ascii_digit()||b==b'.'||b==b'-') && !code.contains("..") && !code.contains("--") && !code.ends_with(['.','-']){codes.push(format!("us{code}"));continue;}
  if code.len()!=6||!code.bytes().all(|b|b.is_ascii_digit()){return Err("股票代码无效".into());}
  let accepted=match market{"SH"=>matches!(&code[..3],"600"|"601"|"603"|"605"|"688"|"689"),"SZ"=>matches!(&code[..3],"000"|"001"|"002"|"003"|"300"|"301"),"BJ"=>code.starts_with('4')||code.starts_with('8')||code.starts_with("920"),_=>false};
  if !accepted{return Err("仅支持明确的沪深北A股代码".into());}
  codes.push(format!("{}{code}",market.to_ascii_lowercase()));
 }
 codes.sort();codes.dedup();if codes.len()!=symbols.len(){return Err("A股代码重复".into());}
 Ok(format!("/q={}",codes.join(",")))
}
#[cfg(windows)]fn fetch_a_stocks(path:&str,check:&impl Fn()->Result<(),String>)->Result<Value,String>{
 let(status,bytes)=crate::http::anonymous_get("qt.gtimg.cn",443,path,check)?;
 if status!=200{return Err(format!("A股公开来源返回HTTP {status}"));}
 let body=crate::http::decode_gbk(&bytes)?;check()?;let(_,at)=crate::daily_recommendations::clock()?;
 Ok(json!({"key":"a-shares","collectedAt":at,"body":body}))
}

fn china_futures_path(symbols:&[String])->Result<String,String>{
 if symbols.is_empty()||symbols.len()>60{return Err("国内期货代码数量须为1到60个".into());}
 let mut codes=Vec::new();
 for symbol in symbols{
  let (code,exchange)=symbol.split_once('.').ok_or("须指定月份及交易所")?;
  if !code.is_ascii()||!(5..=6).contains(&code.len()){return Err("仅支持明确四位月份合约".into());}
  let (product,month)=code.split_at(code.len()-4);
  let expected=match product{"AG"|"SN"=>"SHF","A"|"C"|"CS"|"M"|"Y"|"P"|"JD"|"LH"=>"DCE","WH"|"SR"|"CF"|"OI"=>"ZCE",_=>return Err("暂不支持该期货品种".into())};
  if exchange!=expected||!month.bytes().all(|b|b.is_ascii_digit())||!(1..=12).contains(&month[2..].parse::<u8>().unwrap_or(0)){return Err("合约月份或交易所无效".into());}
  codes.push(format!("nf_{code}"));
 }
 codes.sort();codes.dedup();if codes.len()!=symbols.len(){return Err("国内期货代码重复".into());}
 Ok(format!("/list={}",codes.join(",")))
}
#[cfg(windows)]fn fetch_china_futures(path:&str,check:&impl Fn()->Result<(),String>)->Result<Value,String>{
 let(status,bytes)=crate::http::china_futures_get(path,check)?;
 if status!=200{return Err(format!("国内期货来源返回HTTP {status}"));}
 let body=crate::http::decode_gbk(&bytes)?;check()?;let(_,at)=crate::daily_recommendations::clock()?;
 Ok(json!({"key":"cn-futures","collectedAt":at,"body":body}))
}

fn builtin_enabled(app:&AppHandle,key:&str)->Result<(),String>{
    crate::simulation::require_live()?;
    let (_,_,_,news)=builtin_source(key)?;
    let config=crate::agriculture::connection(app)?;
    let allowed=match key{"argentina-crops"=>config.argentina_enabled,"conab-crops"=>config.conab_enabled,"overseas-futures"|"em-cotton"|"em-tin"=>config.overseas_futures_enabled,"cn-futures"=>config.china_futures_enabled,"a-shares"=>config.a_shares_enabled,"nass-annual"=>config.nass_annual_enabled,"crop-progress"=>config.crop_progress_enabled,"monthly-commodities"|"worldbank-monthly"=>monthly_allowed(&config,key),"ibge-crops"=>config.ibge_enabled,"noaa-observed"=>config.noaa_enabled,"usda-inspections"=>config.inspections_enabled,"wasde"=>config.wasde_enabled,"cftc-agri"=>config.cftc_enabled,_=>if news{config.news_enabled}else{config.market_enabled}};
    if allowed{Ok(())}else{Err("内置免费来源已关闭".into())}
}
fn monthly_allowed(config:&crate::agriculture::SnapshotConnection,key:&str)->bool{
    use crate::agriculture::MonthlySource;
    config.monthly_enabled&&matches!((key,config.monthly_source),("worldbank-monthly",MonthlySource::Worldbank)|("monthly-commodities",MonthlySource::Fred))
}
#[tauri::command]pub async fn read_builtin_public_source(app:AppHandle,view:tauri::Webview,key:String,symbols:Option<Vec<String>>)->Result<Value,String>{
    if !matches!(view.label(),"main"|"dashboard"){return Err("仅主屏和工作台可读取公开来源".into());}
    builtin_enabled(&app,&key)?;
    let stock_path=match key.as_str(){"overseas-futures"=>Some(overseas_futures_path(symbols.as_deref().unwrap_or(&[]))?),"a-shares"=>Some(a_stock_path(symbols.as_deref().unwrap_or(&[]))?),"cn-futures"=>Some(china_futures_path(symbols.as_deref().unwrap_or(&[]))?),_=>{if symbols.is_some(){return Err("此来源不接收自选代码".into());}None}};
    tauri::async_runtime::spawn_blocking(move||{
        builtin_enabled(&app,&key)?;
        let(host,path,seconds,_)=builtin_source(&key)?;
        let state=app.state::<PublicSourceState>();
        let cache_key=stock_path.as_ref().map(|p|format!("{key}:{p}")).unwrap_or_else(||key.clone());
        let slot={let mut entries=state.builtin.lock().map_err(|_|"公开来源忙碌")?;
            if matches!(key.as_str(),"a-shares"|"cn-futures"|"overseas-futures")&&!entries.contains_key(&cache_key){let prefix=format!("{key}:");if entries.keys().filter(|k|k.starts_with(&prefix)).count()>=8{entries.retain(|k,_|!k.starts_with(&prefix));}}
            entries.entry(cache_key).or_insert_with(||Arc::new(Mutex::new(None))).clone()};
        #[cfg(windows)]if key=="noaa-observed"{
            let(_,end)=noaa_window()?;let mut entry=slot.lock().map_err(|_|"NOAA 来源忙碌")?;
            if entry.as_ref().is_some_and(|(_,r)|r.as_ref().is_ok_and(|v|v["windowEnd"].as_str()!=Some(end.as_str()))){*entry=None;}
        }
        cached_for(&slot,seconds,||{
            let permit=crate::simulation::require_live()?;
            // The provider asks clients not to burst requests. Space the two metal reads,
            // including concurrent windows, without delaying independent RSS/FX sources.
            if matches!(key.as_str(),"gold"|"silver"){
                let mut at=state.metal_gate.lock().map_err(|_|"金银来源忙碌")?;
                if let Some(previous)=*at{let gap=Duration::from_millis(1100).saturating_sub(previous.elapsed());if !gap.is_zero(){std::thread::sleep(gap);}}
                permit.check()?;builtin_enabled(&app,&key)?;*at=Some(Instant::now());
            }
            #[cfg(windows)]{
                if matches!(key.as_str(),"nass-annual"|"crop-progress"){return fetch_nass(&key,path,&||{permit.check()?;builtin_enabled(&app,&key)});}
                if key=="cn-futures"{return fetch_china_futures(stock_path.as_deref().ok_or("国内期货代码未提供")?,&||{permit.check()?;builtin_enabled(&app,&key)});}
                if key=="a-shares"{return fetch_a_stocks(stock_path.as_deref().ok_or("A股代码未提供")?,&||{permit.check()?;builtin_enabled(&app,&key)});}
                if key=="noaa-observed"{return fetch_noaa(&||{permit.check()?;builtin_enabled(&app,&key)});}
                if key=="wasde"{return fetch_wasde(&||{permit.check()?;builtin_enabled(&app,&key)});}
                if key=="argentina-crops"{return crate::argentina::fetch(&||{permit.check()?;builtin_enabled(&app,&key)});}
                if key=="conab-crops"{return crate::conab::fetch(&||{permit.check()?;builtin_enabled(&app,&key)});}
                if key=="worldbank-monthly"{return crate::worldbank::fetch(&||{permit.check()?;builtin_enabled(&app,&key)});}
                let(status,bytes)=crate::http::anonymous_get(host,443,stock_path.as_deref().unwrap_or(path),&||{permit.check()?;builtin_enabled(&app,&key)})?;
                permit.check()?;builtin_enabled(&app,&key)?;
                if status!=200{return Err(format!("公开来源返回 HTTP {status}，暂不可用"));}
                let body=String::from_utf8(bytes).map_err(|_|"公开来源编码无效")?;
                let(_,at)=crate::daily_recommendations::clock()?;
                Ok(json!({"key":key,"collectedAt":at,"body":body}))
            }
            #[cfg(not(windows))]{let _=(host,path,permit);Err("公开来源目前需要 Windows 桌面程序".into())}
        })
    }).await.map_err(|_|"公开来源读取任务失败")?
}
fn weather_path()->Result<String,String>{
    let regions:Vec<Value>=serde_json::from_str(include_str!("../../src/domain/agriculture/publicWeatherRegions.json")).map_err(|_|"天气产区配置无效")?;
    let values=|key:&str|regions.iter().map(|r|r[key].as_f64().map(|n|n.to_string()).ok_or("天气坐标无效")).collect::<Result<Vec<_>,_>>().map(|v|v.join(","));
    Ok(format!("/v1/forecast?latitude={}&longitude={}&daily=temperature_2m_max,precipitation_sum&forecast_days=7&timezone=GMT&temperature_unit=celsius&precipitation_unit=mm",values("latitude")?,values("longitude")?))
}
#[cfg(windows)]fn fetch(host:&str,path:&str,html:bool)->Result<Value,String>{
    let permit=crate::simulation::require_live()?;permit.check()?;
    let(status,bytes)=crate::http::get(host,443,true,path,if html{"Accept: text/html\r\n"}else{"Accept: application/json\r\n"})?;
    permit.check()?;
    if status!=200{return Err(format!("公开来源返回 HTTP {status}，暂停 5 分钟后再读取"));}
    let(_,at)=crate::daily_recommendations::clock()?;
    if html{let html=String::from_utf8(bytes).map_err(|_|"GitHub 页面编码无效")?;Ok(json!({"source":"GitHub Trending","collectedAt":at,"html":html}))}
    else{let payload:Value=serde_json::from_slice(&bytes).map_err(|_|"天气来源格式无效")?;Ok(json!({"source":"Open-Meteo","collectedAt":at,"payload":payload}))}
}
fn authorize(app:&AppHandle,view:&tauri::Webview,weather:bool)->Result<(),String>{
    if !matches!(view.label(),"main"|"dashboard"){return Err("仅主屏和工作台可读取公开来源".into());}
    enabled(app,weather)
}
fn enabled(app:&AppHandle,weather:bool)->Result<(),String>{
    crate::simulation::require_live()?;
    let config=crate::agriculture::connection(app)?;
    if !(if weather{config.weather_enabled}else{config.github_enabled}){return Err("PUBLIC_SOURCE_DISABLED: 请在设置 → 数据来源启用此公开来源".into());}Ok(())
}
pub(crate) fn validate_github_receipt(app:&AppHandle,snapshot:&Value)->Result<(),String>{
    let state=app.state::<PublicSourceState>();let slot=state.github.lock().map_err(|_|"榜单正在读取")?;
    match slot.as_ref(){Some((_,Ok(receipt))) if receipt["collectedAt"]==snapshot["collectedAt"]=>Ok(()),_=>Err("榜单采集时间与本机响应不一致".into())}
}
#[tauri::command]pub async fn read_public_weather(app:AppHandle,view:tauri::Webview)->Result<Value,String>{
    authorize(&app,&view,true)?;
    tauri::async_runtime::spawn_blocking(move||{
        enabled(&app,true)?;
        let state=app.state::<PublicSourceState>();
        let(_,at)=crate::daily_recommendations::clock()?;
        cached_weather(&state.weather,&at,||{
            #[cfg(windows)]{
                let permit=crate::simulation::require_live()?;
                let(status,bytes)=crate::http::anonymous_get("api.open-meteo.com",443,&weather_path()?,&||{permit.check()?;enabled(&app,true)})?;
                permit.check()?;enabled(&app,true)?;
                if status!=200{return Err(format!("天气来源返回 HTTP {status}，暂不可用"));}
                let payload:Value=serde_json::from_slice(&bytes).map_err(|_|"天气来源格式无效")?;
                let(_,at)=crate::daily_recommendations::clock()?;
                Ok(json!({"source":"Open-Meteo","collectedAt":at,"payload":payload}))
            }
            #[cfg(not(windows))]{Err("公开来源目前需要 Windows 桌面程序".into())}
        })
    }).await.map_err(|_|"天气读取任务失败")?
}
#[tauri::command]pub async fn fetch_public_github_trending(app:AppHandle,view:tauri::Webview)->Result<Value,String>{
    authorize(&app,&view,false)?;
    tauri::async_runtime::spawn_blocking(move||{
        enabled(&app,false)?;
        let state=app.state::<PublicSourceState>();
        cached(&state.github,||{
            #[cfg(windows)]{fetch("github.com","/trending?since=daily",true)}
            #[cfg(not(windows))]{Err("公开来源目前需要 Windows 桌面程序".into())}
        })
    }).await.map_err(|_|"榜单读取任务失败")?
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn monthly_selection_cannot_call_the_other_source(){use crate::agriculture::{SnapshotConnection,MonthlySource};let mut c=SnapshotConnection::default();assert!(!c.enabled);assert!(monthly_allowed(&c,"worldbank-monthly"));assert!(!monthly_allowed(&c,"monthly-commodities"));c.monthly_source=MonthlySource::Fred;assert!(monthly_allowed(&c,"monthly-commodities"));assert!(!monthly_allowed(&c,"worldbank-monthly"));c.monthly_enabled=false;assert!(!monthly_allowed(&c,"monthly-commodities"));let(h,p,ttl,news)=builtin_source("worldbank-monthly").unwrap();assert_eq!(h,"www.worldbank.org");assert_eq!(p,crate::worldbank::PAGE);assert_eq!(ttl,86400);assert!(!news);}
 #[test]fn nass_report_paths_are_scoped_to_linked_text_reports(){for(path,kind)in [("/sites/default/release-files/example/cropan26.txt","nass-annual"),("/sites/default/release-files/a/b/c/prog4226.txt","crop-progress")]{assert_eq!(nass_report_kind(path),Some(kind));}for path in ["/sites/default/release-files/../cropan26.txt","/sites/default/release-files/a/prog0026.txt","/sites/default/release-files/a/prog5426.txt","/sites/default/release-files/a/cropan26.txt?key=x","https://evil.test/sites/default/release-files/a/cropan26.txt","/sites/default/release-files/a/report.txt","/sites/default/release-files/a/cropan26.pdf"]{assert!(nass_report_kind(path).is_none());}}
 #[test]fn new_public_sources_use_separate_fixed_hosts_and_cache_windows(){for(key,host,seconds)in [("nass-annual","esmis.nal.usda.gov",86400),("crop-progress","esmis.nal.usda.gov",21600),("monthly-commodities","fred.stlouisfed.org",86400),("ibge-crops","apisidra.ibge.gov.br",86400),("noaa-observed","www.ncei.noaa.gov",21600),("usda-inspections","www.ams.usda.gov",21600)]{let(h,p,ttl,news)=builtin_source(key).unwrap();assert_eq!(h,host);assert_eq!(ttl,seconds);assert!(!news);assert!(!p.contains("api_key"));}let(_,path,_,_)=builtin_source("ibge-crops").unwrap();assert!(path.contains("39441,39442"));}
 #[cfg(windows)]#[test]fn noaa_windows_cover_thirty_complete_days_across_leap_and_year_boundaries(){for(seconds,start,end)in [(1792713600,"2026-09-23","2026-10-22"),(1709251200,"2024-01-31","2024-02-29"),(1767225600,"2025-12-02","2025-12-31")]{assert_eq!(noaa_window_at(seconds).unwrap(),(start.into(),end.into()));assert_eq!(noaa_window_at(seconds+86399).unwrap(),(start.into(),end.into()));}assert!(noaa_window_at(0).is_err());}
 #[test]fn wasde_discovers_only_published_official_xml(){let html=r#"<a href="https://www.usda.gov/oce/commodity/wasde/wasde0926.xml">old</a><a href='/oce/commodity/wasde/wasde1026.xml'>latest</a><a href="https://evil.test/oce/commodity/wasde/wasde1126.xml">bad</a><a href="/oce/commodity/wasde/wasde1126.xml">future</a>"#;assert_eq!(latest_wasde_path(html,"2026-10-23T00:00:00Z").unwrap(),"/oce/commodity/wasde/wasde1026.xml");assert!(latest_wasde_path("no XML","2026-10-23").is_err());for path in ["/oce/commodity/wasde/wasde1326.xml","/oce/commodity/wasde/wasde1026.xml?x=1","https://www.usda.gov.evil/oce/commodity/wasde/wasde1026.xml","//evil.test/wasde1026.xml"]{assert!(wasde_xml_path(path).is_none());}let(host,_,ttl,_)=builtin_source("wasde").unwrap();assert_eq!(host,"www.usda.gov");assert_eq!(ttl,21600);}
 #[test]fn weather_request_is_one_fixed_batch(){let path=weather_path().unwrap();assert!(path.starts_with("/v1/forecast?latitude=41.5,39,-13"));assert!(path.contains("forecast_days=7&timezone=GMT"));assert!(!path.contains("apikey"));}
 #[test]fn weather_cache_drops_yesterdays_forecast_even_within_hour(){let slot=Mutex::new(Some((Instant::now(),Ok(json!({"collectedAt":"2026-10-22T23:55:00Z"})))));let mut calls=0;let result=cached_weather(&slot,"2026-10-23T00:01:00Z",||{calls+=1;Ok(json!({"collectedAt":"2026-10-23T00:01:00Z"}))}).unwrap();assert_eq!(calls,1);assert_eq!(result["collectedAt"],"2026-10-23T00:01:00Z");let _=cached_weather(&slot,"2026-10-23T00:02:00Z",||{calls+=1;Err("must reuse".into())});assert_eq!(calls,1);}
 #[test]fn successes_are_reused_across_windows(){let slot=Mutex::new(None);let mut calls=0;for _ in 0..3{assert_eq!(cached(&slot,||{calls+=1;Ok(json!({"value":0}))}).unwrap()["value"],0);}assert_eq!(calls,1);}
 #[test]fn failures_are_cooled_down_without_retries(){let slot=Mutex::new(None);let mut calls=0;for _ in 0..3{assert!(cached(&slot,||{calls+=1;Err("offline".into())}).is_err());}assert_eq!(calls,1);}
 #[test]fn expired_cache_is_refreshed_once(){let slot=Mutex::new(Some((Instant::now()-Duration::from_secs(3601),Ok(json!("old")))));assert_eq!(cached(&slot,||Ok(json!("new"))).unwrap(),json!("new"));}
 #[test]fn builtin_list_is_fixed_and_never_contains_keys_or_history(){for key in ["news-china","news-fed","news-ecb","gold","silver","fx-ecb","cftc-agri"]{let(host,path,ttl,news)=builtin_source(key).unwrap();assert!(!host.contains('/'));assert!(!path.contains("history")&&!path.contains("api_key"));assert!(ttl>=300);assert_eq!(news,key.starts_with("news-"));}for key in ["https://example.test","../gold","gold/history",""]{assert!(builtin_source(key).is_err());}}
 #[test]fn cftc_reads_only_six_markets_and_sixty_rows(){let(host,path,ttl,news)=builtin_source("cftc-agri").unwrap();assert_eq!(host,"publicreporting.cftc.gov");assert_eq!(ttl,3600);assert!(!news);let url=tauri::Url::parse(&format!("https://{host}{path}")).unwrap();let query:std::collections::HashMap<_,_>=url.query_pairs().collect();assert_eq!(query["$limit"],"60");assert_eq!(query["$order"],"report_date_as_yyyy_mm_dd DESC,cftc_contract_market_code ASC");for code in ["002602","005602","026603","007601","001612","001602"]{assert!(query["$where"].contains(code));}assert!(query["$where"].contains("futonly_or_combined='FutOnly'"));}
 #[test]fn builtin_five_minute_cache_does_not_use_hour_weather_ttl(){let slot=Mutex::new(Some((Instant::now()-Duration::from_secs(301),Ok(json!("old")))));assert_eq!(cached_for(&slot,300,||Ok(json!("new"))).unwrap(),json!("new"));}
 #[test]fn rss_failure_is_cached_without_automatic_retry(){let slot=Mutex::new(None);let mut calls=0;for _ in 0..3{assert!(cached_for(&slot,900,||{calls+=1;Err("offline".into())}).is_err());}assert_eq!(calls,1);}
}

#[cfg(test)]mod a_stock_tests{
 use super::*;
 #[test]fn a_stock_codes_are_explicit_and_cannot_be_urls(){
  assert_eq!(a_stock_path(&["000960.SZ".into(),"000426.SZ".into(),"600000.SH".into(),"920001.BJ".into()]).unwrap(),"/q=bj920001,sh600000,sz000426,sz000960");
  for bad in ["sz000426","000001.SH","GC=F","000426.SZ&x=y","http://example.test","600000.SZ","000426.SZ/","000426.sz"]{assert!(a_stock_path(&[bad.into()]).is_err());}
  assert!(a_stock_path(&[]).is_err());assert!(a_stock_path(&vec!["000426.SZ".into();61]).is_err());assert!(a_stock_path(&["000426.SZ".into(),"000426.SZ".into()]).is_err());
 }
 #[test]fn a_stock_source_is_fixed_and_not_a_paid_api(){let(host,path,ttl,news)=builtin_source("a-shares").unwrap();assert_eq!((host,path,ttl,news),("qt.gtimg.cn","/q=",60,false));}
 #[test]fn hk_us_stock_paths_keep_market_and_ticker_explicit(){
  assert_eq!(a_stock_path(&["00700.HK".into(),"AAPL.US".into(),"BRK.B.US".into()]).unwrap(),"/q=hk00700,usAAPL,usBRK.B");
  for bad in ["00000.HK","AAPL.US&x=y","AAPL/US","aapl.US","https://host.US"]{assert!(a_stock_path(&[bad.into()]).is_err(),"{bad}");}
 }
 #[cfg(windows)]#[test]fn a_stock_gbk_names_and_bad_bytes(){assert_eq!(crate::http::decode_gbk(&[0xd0,0xcb,0xd2,0xb5,0xd2,0xf8,0xce,0xfd]).unwrap(),"兴业银锡");assert!(crate::http::decode_gbk(&[0x81]).is_err());assert!(crate::http::decode_gbk(&[]).is_err());}
 #[cfg(windows)]#[test]#[ignore]fn a_stock_live_receipt(){
  let path=a_stock_path(&["000426.SZ".into(),"000960.SZ".into()]).unwrap();let value=fetch_a_stocks(&path,&||Ok(())).unwrap();println!("ASTOCK_RECEIPT:{}",value);
 }
}

#[cfg(test)]mod overseas_futures_tests{
 use super::*;
 #[test]fn overseas_path_is_one_fixed_encoded_batch(){
  assert_eq!(overseas_futures_path(&["SI=F".into(),"GC=F".into()]).unwrap(),"/v7/finance/spark?symbols=GC%3DF%2CSI%3DF&range=1d&interval=1d");
  assert_eq!(overseas_futures_path(&["DX-Y.NYB".into()]).unwrap(),"/v7/finance/spark?symbols=DX-Y.NYB&range=1d&interval=1d");
  for bad in ["gc=f","GC=F&crumb=secret","GC=F/","XAU","LME-SN","DXY","https://example.test","GCZ26"]{assert!(overseas_futures_path(&[bad.into()]).is_err());}
  assert!(overseas_futures_path(&[]).is_err());assert!(overseas_futures_path(&vec!["GC=F".into();11]).is_err());assert!(overseas_futures_path(&["GC=F".into(),"GC=F".into()]).is_err());
 }
 #[test]fn overseas_source_has_independent_opt_in_for_existing_configs(){
  assert_eq!(builtin_source("overseas-futures").unwrap(),("query1.finance.yahoo.com","/v7/finance/spark",300,false));
  let fresh=crate::agriculture::SnapshotConnection::default();assert!(fresh.overseas_futures_enabled);
  let old:crate::agriculture::SnapshotConnection=serde_json::from_str(r#"{"enabled":false,"sshAlias":"","dataRoot":"","radarRoot":""}"#).unwrap();assert!(!old.overseas_futures_enabled);
  let round:crate::agriculture::SnapshotConnection=serde_json::from_str(&serde_json::to_string(&fresh).unwrap()).unwrap();assert!(round.overseas_futures_enabled);
 }
 #[cfg(windows)]#[test]fn cancelled_overseas_request_never_opens_network(){assert_eq!(crate::http::anonymous_get("query1.finance.yahoo.com",443,&overseas_futures_path(&["GC=F".into()]).unwrap(),&||Err("fixture cancelled".into())).unwrap_err(),"fixture cancelled");}
 #[test]fn eastmoney_cotton_is_fixed_anonymous_source(){assert_eq!(builtin_source("em-cotton").unwrap(),("futsseapi.eastmoney.com","/static/108_CT00Y_qt?field=name,sc,dm,p,utime,zsjd",300,false));}
 #[test]fn eastmoney_tin_is_fixed_anonymous_source(){assert_eq!(builtin_source("em-tin").unwrap(),("futsseapi.eastmoney.com","/static/109_LTNT_qt?field=name,sc,dm,p,utime,zsjd",300,false));}
 #[cfg(windows)]#[test]#[ignore="explicit Eastmoney tin anonymous read"]fn eastmoney_tin_live_receipt(){let(host,path,_,_)=builtin_source("em-tin").unwrap();let(status,bytes)=crate::http::anonymous_get(host,443,path,&||Ok(())).unwrap();assert_eq!(status,200);let body=String::from_utf8(bytes).unwrap();let(_,at)=crate::daily_recommendations::clock().unwrap();println!("TIN_RECEIPT:{}",json!({"key":"em-tin","collectedAt":at,"body":body}));}
 #[cfg(windows)]#[test]#[ignore="explicit Eastmoney cotton anonymous read"]fn eastmoney_cotton_live_receipt(){let(host,path,_,_)=builtin_source("em-cotton").unwrap();let(status,bytes)=crate::http::anonymous_get(host,443,path,&||Ok(())).unwrap();assert_eq!(status,200);let body=String::from_utf8(bytes).unwrap();let(_,at)=crate::daily_recommendations::clock().unwrap();println!("COTTON_RECEIPT:{}",json!({"key":"em-cotton","collectedAt":at,"body":body}));}
 #[cfg(windows)]#[test]#[ignore]fn overseas_futures_live_receipt(){
  let symbols=["DX-Y.NYB","GC=F","SI=F","CL=F","ZC=F","ZS=F","ZW=F","ZL=F","ZM=F","CT=F","SB=F"].map(String::from);
  let path=overseas_futures_path(&symbols).unwrap();let(status,bytes)=crate::http::anonymous_get("query1.finance.yahoo.com",443,&path,&||Ok(())).unwrap();assert_eq!(status,200);
  let body=String::from_utf8(bytes).unwrap();let(_,at)=crate::daily_recommendations::clock().unwrap();println!("OVERSEAS_RECEIPT:{}",json!({"key":"overseas-futures","collectedAt":at,"body":body}));
 }
}
#[cfg(test)]mod china_futures_tests{
 use super::*;
 #[test]fn explicit_contracts_only_no_guessed_main_or_options(){
  assert_eq!(china_futures_path(&["C2701.DCE".into(),"CF2701.ZCE".into(),"AG2612.SHF".into()]).unwrap(),"/list=nf_AG2612,nf_C2701,nf_CF2701");
  for bad in ["AG.SHF","AG0.SHF","AG2612","AG2612.DCE","CF701.ZCE","AG2613.SHF","AG2600.SHF","AG2612C15000.SHF","AG2612.SHF&x=y","AG2612.shf","白银2612.SHF","https://example.test"]{assert!(china_futures_path(&[bad.into()]).is_err(),"{bad}");}
  assert!(china_futures_path(&[]).is_err());assert!(china_futures_path(&vec!["AG2612.SHF".into();61]).is_err());assert!(china_futures_path(&["AG2612.SHF".into(),"AG2612.SHF".into()]).is_err());
 }
 #[test]fn all_supported_products_have_explicit_exchange(){for (p,e) in [("AG","SHF"),("SN","SHF"),("A","DCE"),("C","DCE"),("CS","DCE"),("M","DCE"),("Y","DCE"),("P","DCE"),("JD","DCE"),("LH","DCE"),("WH","ZCE"),("SR","ZCE"),("CF","ZCE"),("OI","ZCE")]{assert_eq!(china_futures_path(&[format!("{p}2701.{e}")]).unwrap(),format!("/list=nf_{p}2701"));}}
 #[test]fn futures_source_is_fixed_and_separate_from_stock_switch(){let(h,p,ttl,news)=builtin_source("cn-futures").unwrap();assert_eq!((h,p,ttl,news),("hq.sinajs.cn","/list=",60,false));let fresh=crate::agriculture::SnapshotConnection::default();assert!(fresh.china_futures_enabled);let old:crate::agriculture::SnapshotConnection=serde_json::from_str(r#"{"enabled":false,"sshAlias":"","dataRoot":"","radarRoot":""}"#).unwrap();assert!(!old.china_futures_enabled);let round:crate::agriculture::SnapshotConnection=serde_json::from_str(&serde_json::to_string(&fresh).unwrap()).unwrap();assert!(round.china_futures_enabled);}
 #[cfg(windows)]#[test]fn cancelled_futures_read_cannot_start_network(){assert_eq!(fetch_china_futures("/list=nf_AG2612",&||Err("fixture cancelled".into())).unwrap_err(),"fixture cancelled");}
 #[cfg(windows)]#[test]#[ignore]fn china_futures_live_receipt(){let path=china_futures_path(&["AG2612.SHF".into(),"C2701.DCE".into(),"CF2701.ZCE".into()]).unwrap();let value=fetch_china_futures(&path,&||Ok(())).unwrap();println!("CN_FUTURES_RECEIPT:{}",value);}
}
