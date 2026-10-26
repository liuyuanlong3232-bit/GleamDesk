use serde_json::Value;
use serde::{Serialize,Deserialize};
use tauri::{AppHandle,Manager,Emitter};
use std::{fs,path::Path};
use std::{sync::Mutex,time::{Instant,Duration}};
#[derive(Default)]pub struct AgricultureState(Mutex<Option<(Instant,SnapshotConnection,Value)>>);
#[derive(Default)]pub struct Jin10NewsState(Mutex<Option<(Instant,SnapshotConnection,Value)>>);

#[derive(Clone,Copy,Debug,PartialEq,Serialize,Deserialize)]
#[serde(rename_all="lowercase")]
pub enum MonthlySource { Worldbank, Fred }
fn legacy_monthly_source()->MonthlySource{MonthlySource::Fred}

#[derive(Clone,Debug,PartialEq,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct SnapshotConnection {
    pub enabled:bool,
    pub ssh_alias:String,
    pub data_root:String,
    pub radar_root:String,
    #[serde(default)] pub weather_enabled:bool,
    #[serde(default)] pub github_enabled:bool,
    #[serde(default="public_enabled")] pub news_enabled:bool,
    #[serde(default="public_enabled")] pub market_enabled:bool,
    #[serde(default)] pub a_shares_enabled:bool,
    #[serde(default)] pub china_futures_enabled:bool,
    #[serde(default)] pub overseas_futures_enabled:bool,
    #[serde(default)] pub conab_enabled:bool,
    #[serde(default)] pub argentina_enabled:bool,
    #[serde(default="public_enabled")] pub cftc_enabled:bool,
    #[serde(default="public_enabled")] pub wasde_enabled:bool,
    #[serde(default="public_enabled")] pub inspections_enabled:bool,
    #[serde(default="public_enabled")] pub noaa_enabled:bool,
    #[serde(default="public_enabled")] pub nass_annual_enabled:bool,
    #[serde(default="public_enabled")] pub crop_progress_enabled:bool,
    #[serde(default="public_enabled")] pub monthly_enabled:bool,
    #[serde(default="legacy_monthly_source")] pub monthly_source:MonthlySource,
    #[serde(default="public_enabled")] pub ibge_enabled:bool,
    #[serde(default)] pub custom_sources:Vec<crate::custom_http::CustomHttpSource>,
}
fn public_enabled()->bool{true}
impl Default for SnapshotConnection {
    fn default()->Self{Self{enabled:false,ssh_alias:String::new(),data_root:String::new(),radar_root:String::new(),weather_enabled:true,github_enabled:false,news_enabled:true,market_enabled:true,a_shares_enabled:true,china_futures_enabled:true,overseas_futures_enabled:true,conab_enabled:true,argentina_enabled:true,cftc_enabled:true,wasde_enabled:true,inspections_enabled:true,noaa_enabled:true,nass_annual_enabled:true,crop_progress_enabled:true,monthly_enabled:true,monthly_source:MonthlySource::Worldbank,ibge_enabled:true,custom_sources:Vec::new()}}
}
impl SnapshotConnection {
    fn validate(&self)->Result<(),String>{
        if self.custom_sources.len()>4{return Err("首版最多添加 4 个自定义行情来源".into());}
        let mut ids=std::collections::HashSet::new();for source in &self.custom_sources{source.validate()?;if !ids.insert(&source.id){return Err("自定义来源标识重复".into());}}
        if (!self.ssh_alias.is_empty() && (self.ssh_alias.len()>80 || !self.ssh_alias.bytes().next().is_some_and(|c|c.is_ascii_alphanumeric()) || !self.ssh_alias.bytes().all(|c|c.is_ascii_alphanumeric()||b"-_.".contains(&c))))
            || (self.enabled && self.ssh_alias.is_empty()) {return Err("SSH 别名只能包含字母、数字、点、下划线和连字符，且不能以选项开头".into());}
        for (path,required) in [(&self.data_root,self.enabled),(&self.radar_root,false)] {
            if path.is_empty() && !required {continue;}
            if path.len()>500 || !path.starts_with('/') || path.chars().any(char::is_control) || path.split('/').any(|part|part==".."||part==".") {return Err("数据目录须为远程绝对路径，不能包含控制字符或上级目录跳转".into());}
        }
        Ok(())
    }
    fn require_enabled(&self)->Result<(),String>{self.validate()?;if !self.enabled{return Err("SNAPSHOT_UNCONFIGURED: 数据源未启用，请在设置中配置可选 SSH 数据源".into());}Ok(())}
    fn origin(&self)->String{format!("ssh:{}",serde_json::json!([&self.ssh_alias,&self.data_root,&self.radar_root]))}
    fn script(&self,script:&str)->Result<String,String>{
        self.require_enabled()?;
        let config=serde_json::to_string(self).map_err(|_|"数据源配置无法编码")?;
        let literal=serde_json::to_string(&config).map_err(|_|"数据源配置无法编码")?;
        Ok(format!("import json\nCONFIG=json.loads({literal})\n{script}"))
    }
}
fn load_connection_file(path:&Path)->Result<SnapshotConnection,String>{
    let bytes=match fs::metadata(path){
        Ok(meta) if meta.len()<=32768=>fs::read(path).map_err(|_|"无法读取数据源配置，原文件已保留")?,
        Ok(_)=>return Err("数据源配置超过上限，原文件已保留".into()),
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(SnapshotConnection::default()),
        Err(_)=>return Err("无法读取数据源配置，原文件已保留".into()),
    };
    let config:SnapshotConnection=serde_json::from_slice(&bytes).map_err(|_|"数据源配置无法解析，原文件已保留")?;
    config.validate()?;Ok(config)
}
pub(crate) fn connection(app:&AppHandle)->Result<SnapshotConnection,String>{
    let path=app.path().app_data_dir().map_err(|_|"应用配置目录不可用")?.join("snapshot-connection.json");
    load_connection_file(&path)
}
fn save_connection_file(directory:&Path,config:&SnapshotConnection)->Result<(),String>{
    static SAVING:Mutex<()>=Mutex::new(());
    let _lock=SAVING.lock().map_err(|_|"数据源配置忙碌")?;
    config.validate()?;
    let path=directory.join("snapshot-connection.json");
    load_connection_file(&path)?; // Never overwrite an unreadable or corrupt existing file.
    let previous=match fs::read(&path){Ok(bytes)=>Some(bytes),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>None,Err(_)=>return Err("无法读取原配置，已停止保存".into())};
    fs::create_dir_all(directory).map_err(|_|"配置目录不可写")?;
    if let Some(bytes)=previous {crate::launcher::replace_config_bytes(&directory.join("snapshot-connection.previous.json"),&bytes).map_err(|_|"上一版数据源配置备份失败，已停止保存")?;}
    let bytes=serde_json::to_vec_pretty(config).map_err(|_|"配置无法编码")?;
    crate::launcher::replace_config_bytes(&path,&bytes).map_err(|_|"数据源配置保存失败，原文件已保留".into())
}
#[tauri::command]pub fn load_snapshot_connection(app:AppHandle,view:tauri::Webview)->Result<SnapshotConnection,String>{
    if !matches!(view.label(),"main"|"dashboard"){return Err("仅主屏和工作台可读取数据源配置".into());}connection(&app)
}
#[tauri::command]pub fn save_snapshot_connection(app:AppHandle,view:tauri::Webview,config:SnapshotConnection)->Result<(),String>{
    if !matches!(view.label(),"main"|"dashboard"){return Err("仅主屏和工作台可保存数据源配置".into());}
    let directory=app.path().app_data_dir().map_err(|_|"应用配置目录不可用")?;
    save_connection_file(&directory,&config)?;
    let _=app.emit("snapshot-connection-changed",());Ok(())
}
const JIN10_SCRIPT:&str=r#"
import json,datetime
from pathlib import Path
p=Path(CONFIG['dataRoot'])/'workbench/jin10_news.json'
if not p.is_file() or p.stat().st_size>512000:raise ValueError('Jin10 cache unavailable')
raw=json.loads(p.read_text(encoding='utf-8'))
if raw.get('schemaVersion')!=1 or raw.get('source')!='Jin10 MCP':raise ValueError('Jin10 cache source unknown')
out={key:raw.get(key) for key in ['schemaVersion','source','last_attempt','last_success','latest_observation','status']}
out['fetchedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
out['news']=[{k:row[k] for k in ['eventId','title','summary','source','url','epoch','publishedAt','priority','confirmedPriority'] if k in row} for row in raw.get('news',[])[:100] if isinstance(row,dict) and row.get('source')=='Jin10 MCP']
print(json.dumps(out,ensure_ascii=False))
"#;
// Keep one observation per source date, choosing the latest collection for that date.
const MARKET_QUERY:&str=r#"SELECT name,symbol,sourceDate,price,collectedDate,changePct FROM (
 SELECT "品種" AS name,"代碼" AS symbol,"日期" AS sourceDate,"最新價" AS price,"抓取日" AS collectedDate,"日漲跌幅%" AS changePct,
 ROW_NUMBER() OVER(PARTITION BY "日期" ORDER BY "抓取日" DESC,rowid DESC) AS dateRank
 FROM yahoo_futures WHERE "代碼"=? AND "日期" IS NOT NULL AND trim("日期")<>''
) WHERE dateRank=1 ORDER BY sourceDate DESC LIMIT 30"#;
const SCRIPT:&str=r#"
import json,re,datetime
from pathlib import Path
DATA_ROOT=Path(CONFIG['dataRoot'])
__RADAR_READER__
def safe(value):
    if isinstance(value,dict):return {k:safe(v) for k,v in value.items() if not re.search('token|secret|password|api.?key',k,re.I)}
    if isinstance(value,list):return [safe(item) for item in value[:100]]
    if isinstance(value,str):return value[:10000]
    return value
result={}
allowed={'global_snapshot':['generated_at_bjt','scope','prices','exchange_rates','weather','noaa_observed_weather','usda_export_inspections','usda_nass','alpha_vantage_commodities','cftc_weekly','south_america_estimates','news'],'china_snapshot':['generated_at_bjt','scope','futures_as_of_trade_date','futures_trade_date_status','futures','weather','manual_watch','notes']}
for name in allowed:
    path=DATA_ROOT/'agriculture_publication/data/daily'/(name+'.json')
    if path.is_file() and path.stat().st_size<=256000:
        raw=json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(raw,dict):continue
        result[name]={'path':str(path),'fileModifiedAt':datetime.datetime.fromtimestamp(path.stat().st_mtime,datetime.timezone.utc).isoformat(),'payload':safe({key:raw[key] for key in allowed[name] if key in raw})}
history=[]
history_root=DATA_ROOT/'agriculture_publication/data/daily/history'
if history_root.is_dir():
    for path in sorted(history_root.glob('global_snapshot_*.json'),reverse=True)[:30]:
        if path.resolve().parent!=history_root.resolve() or not path.is_file() or path.stat().st_size>256000:continue
        try:
            raw=json.loads(path.read_text(encoding='utf-8'))
            prices=raw.get('prices',[]) if isinstance(raw,dict) else []
            history.append({'generatedAt':raw.get('generated_at_bjt'),'prices':safe(prices)})
        except (ValueError,OSError):continue
market=[]
try:
    import sqlite3
    connection=sqlite3.connect((DATA_ROOT/'hermes.db').as_uri()+'?mode=ro',uri=True,timeout=2)
    connection.row_factory=sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    for symbol in ['SI=F','GC=F','CL=F','DX-Y.NYB','ZC=F','ZS=F','ZW=F','ZL=F','ZM=F','CT=F','SB=F','000426.SZ','000960.SZ','SN.SHF','AG.SHF','LME-SN']:
        rows=connection.execute("""__MARKET_QUERY__""",(symbol,)).fetchall()
        market.append({'symbol':symbol,'history':[dict(row) for row in reversed(rows)]})
    finance_news=[]
    try:
        rows=connection.execute('SELECT "\u6a19\u984c" AS title,"\u4f86\u6e90" AS source,"\u767c\u5e03\u6642\u9593" AS publishedAt,"\u63cf\u8ff0" AS summary,"URL" AS url,"\u6293\u53d6\u65e5" AS collectedAt FROM financial_news ORDER BY "\u767c\u5e03\u6642\u9593" DESC,"\u6293\u53d6\u65e5" DESC,rowid DESC LIMIT 100').fetchall()
        finance_news=[dict(row) for row in rows]
    except sqlite3.Error:
        finance_news=[]
    china_futures=[]
    try:
        symbols=[row[0] for row in connection.execute('SELECT DISTINCT symbol FROM cn_futures ORDER BY symbol').fetchall()]
        for symbol in symbols[:40]:
            rows=connection.execute("SELECT name,symbol,CASE WHEN length(date)=8 THEN substr(date,1,4)||'-'||substr(date,5,2)||'-'||substr(date,7,2) ELSE date END AS sourceDate,close AS price,fetched_at AS collectedDate,pre_close AS previousClose,change_pct AS changePct,unit,source FROM cn_futures WHERE symbol=? ORDER BY date DESC,fetched_at DESC,rowid DESC LIMIT 60",(symbol,)).fetchall()
            china_futures.append({'symbol':symbol,'history':[dict(row) for row in rows]})
    except sqlite3.Error:
        china_futures=[]
    usda_reports=[]
    usda_tables=[('soybeans_supply','agri_USDA\u5927\u8c46\u4f9b\u9700'),('wheat_supply','agri_USDA\u5c0f\u9ea6\u4f9b\u9700'),('cotton_supply','agri_USDA\u68c9\u82b1\u4f9b\u9700'),('corn_supply','agri_USDA\u7389\u7c73\u4f9b\u9700'),('soybeans_progress','agri_USDA\u5927\u8c46\u79cd\u690d\u8fdb\u5ea6'),('wheat_progress','agri_USDA\u5c0f\u9ea6\u79cd\u690d\u8fdb\u5ea6'),('cotton_progress','agri_USDA\u68c9\u82b1\u79cd\u690d\u8fdb\u5ea6'),('corn_progress','agri_USDA\u7389\u7c73\u79cd\u690d\u8fdb\u5ea6')]
    for key,table in usda_tables:
        try:
            rows=connection.execute('SELECT report_date,report_type,commodity,metric_name,value,unit,value_outlier FROM "'+table+'" ORDER BY report_date DESC,rowid DESC LIMIT 80').fetchall()
            records=[];seen=set()
            for row in rows:
                item=dict(row);identity=tuple(item.get(field) for field in ('report_date','report_type','commodity','metric_name','value','unit'))
                if identity in seen:continue
                seen.add(identity);records.append(item)
            usda_reports.append({'id':key,'records':records[:50]})
        except sqlite3.Error:
            continue
    connection.close()
except (OSError,sqlite3.Error):
    market=[]
    finance_news=[];china_futures=[];usda_reports=[]
radar=read_saved_radar(Path(CONFIG['radarRoot'])) if CONFIG['radarRoot'] else {'status':'unavailable','quotes':[],'mainContracts':[]}
radar['mainContracts'].extend(read_cn_futures_main_contracts(DATA_ROOT/'meta/cn_futures'))
print(json.dumps({'schemaVersion':1,'origin':'ssh:'+json.dumps([CONFIG['sshAlias'],CONFIG['dataRoot'],CONFIG['radarRoot']],ensure_ascii=False,separators=(',',':')),'fetchedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'snapshots':result,'history':history,'market':market,'radar':radar,'chinaFutures':china_futures,'financeNews':finance_news,'usdaReports':usda_reports},ensure_ascii=False))
"#;
#[cfg(windows)]pub(crate) fn read_remote(script:&str,config:&SnapshotConnection)->Result<Value,String>{
    use std::{process::{Command,Stdio},io::{Read,Write},os::windows::process::CommandExt};
    config.require_enabled()?;
    let live=crate::simulation::require_live().map_err(|_|"模拟模式已暂停 SSH 数据读取")?;
    let script=config.script(script)?;
    let path=crate::network_tools::system_executable("OpenSSH/ssh.exe")?;
    if !path.is_file(){return Err("Windows OpenSSH 客户端不可用".into());}
    live.check().map_err(|_|"模拟模式已暂停 SSH 数据读取")?;
    let mut child=Command::new(path).args(["-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","-o","ConnectTimeout=8",&config.ssh_alias,"python3","-B","-"]).creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_|"无法启动既有SSH只读连接")?;
    let mut input=child.stdin.take().ok_or("SSH输入不可用")?;let output=child.stdout.take().ok_or("SSH输出不可用")?;
    input.write_all(script.as_bytes()).map_err(|_|"SSH读取请求未成功提交")?;drop(input);
    let reader=std::thread::spawn(move||{let mut bytes=Vec::new();let _=output.take(512*1024+1).read_to_end(&mut bytes);bytes});
    let started=Instant::now();let exit=loop{if let Some(exit)=child.try_wait().map_err(|_|"SSH状态不可读")?{break Some(exit);}if started.elapsed()>Duration::from_secs(20){let _=child.kill();let _=child.wait();break None;}std::thread::sleep(Duration::from_millis(30));};
    let bytes=reader.join().map_err(|_|"SSH输出读取任务失败")?;
    if !exit.is_some_and(|exit|exit.success())||bytes.len()>512*1024{return Err("农业VPS读取失败、超时或输出超限；不会修改远程系统".into());}
    let value:Value=serde_json::from_slice(&bytes).map_err(|_|"农业快照不是有效JSON")?;
    Ok(value)
}
#[cfg(windows)]fn read(config:&SnapshotConnection)->Result<Value,String>{
    let value=read_remote(&SCRIPT.replace("__MARKET_QUERY__",MARKET_QUERY).replace("__RADAR_READER__",include_str!("market_radar_read.py")),config)?;
    if value["schemaVersion"]!=1||value["origin"]!=config.origin()||!value["snapshots"].is_object(){return Err("农业快照来源或格式未知".into());}Ok(value)
}
#[tauri::command]pub async fn read_agriculture_snapshot(app:AppHandle,state:tauri::State<'_,AgricultureState>)->Result<Value,String>{
    crate::simulation::require_live().map_err(|_|"模拟模式已暂停 SSH 数据读取")?;
    let config=connection(&app)?;config.require_enabled()?;
    if let Some((at,source,value))=state.0.lock().map_err(|_|"农业缓存不可用")?.as_ref(){if *source==config&&at.elapsed()<Duration::from_secs(300){return Ok(value.clone());}}
    let selected=config.clone();
    let value=tauri::async_runtime::spawn_blocking(move||{
        #[cfg(windows)]{read(&selected)}
        #[cfg(not(windows))]{Err("农业只读连接需要Windows SSH客户端".into())}
    }).await.map_err(|_|"农业只读任务失败")??;
    if connection(&app)?!=config{return Err("数据源已切换，请重新读取".into());}
    *state.0.lock().map_err(|_|"农业缓存不可用")?=Some((Instant::now(),config,value.clone()));Ok(value)
}

#[tauri::command]pub async fn read_jin10_news(app:AppHandle,state:tauri::State<'_,Jin10NewsState>)->Result<Value,String>{
    crate::simulation::require_live().map_err(|_|"模拟模式已暂停 SSH 数据读取")?;
    let config=connection(&app)?;config.require_enabled()?;
    if let Some((at,source,value))=state.0.lock().map_err(|_|"金十缓存不可用")?.as_ref(){if *source==config&&at.elapsed()<Duration::from_secs(55){return Ok(value.clone());}}
    let selected=config.clone();
    let value=tauri::async_runtime::spawn_blocking(move||{
        #[cfg(windows)]{read_remote(JIN10_SCRIPT,&selected)}
        #[cfg(not(windows))]{Err("金十快讯读取需要Windows SSH客户端".into())}
    }).await.map_err(|_|"金十快讯读取任务失败")??;
    if value["schemaVersion"]!=1||value["source"]!="Jin10 MCP"||!value["news"].is_array(){return Err("金十快讯来源或格式未知".into());}
    if connection(&app)?!=config{return Err("数据源已切换，请重新读取".into());}
    *state.0.lock().map_err(|_|"金十缓存不可用")?=Some((Instant::now(),config,value.clone()));Ok(value)
}

#[cfg(test)]mod tests{
 use super::*;
 fn fixture()->SnapshotConnection{SnapshotConnection{enabled:true,ssh_alias:"my-data".into(),data_root:"/srv/market data".into(),radar_root:String::new(),..Default::default()}}
 struct Temporary(std::path::PathBuf);
 impl Temporary{fn new()->Self{let path=std::env::temp_dir().join(format!("snapshot-config-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir_all(&path).unwrap();Self(path)}}
 impl Drop for Temporary{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
 #[test]fn snapshot_config_defaults_never_connect_ssh(){let dir=Temporary::new();let p=dir.0.join("absent.json");let config=load_connection_file(&p).unwrap();assert!(!config.enabled);assert!(config.require_enabled().unwrap_err().starts_with("SNAPSHOT_UNCONFIGURED:"));assert!(!p.exists());}
 #[test]fn legacy_config_keeps_weather_github_off(){let config:SnapshotConnection=serde_json::from_str(r#"{"enabled":false,"sshAlias":"","dataRoot":"","radarRoot":""}"#).unwrap();assert!(!config.weather_enabled&&!config.github_enabled&&config.custom_sources.is_empty());}
 #[test]fn monthly_new_default_and_legacy_preserve_distinct_sources(){assert_eq!(SnapshotConnection::default().monthly_source,MonthlySource::Worldbank);let old:SnapshotConnection=serde_json::from_str(r#"{"enabled":false,"sshAlias":"","dataRoot":"","radarRoot":""}"#).unwrap();assert_eq!(old.monthly_source,MonthlySource::Fred);let mut off=old;off.monthly_enabled=false;off.monthly_source=MonthlySource::Worldbank;let saved:SnapshotConnection=serde_json::from_str(&serde_json::to_string(&off).unwrap()).unwrap();assert_eq!(off,saved);assert!(serde_json::from_str::<SnapshotConnection>(r#"{"enabled":false,"sshAlias":"","dataRoot":"","radarRoot":"","monthlySource":"other"}"#).is_err());}
 #[test]fn new_install_weather_is_on_but_explicit_opt_out_is_preserved(){assert!(SnapshotConnection::default().weather_enabled);let config:SnapshotConnection=serde_json::from_str(r#"{"enabled":false,"sshAlias":"","dataRoot":"","radarRoot":"","weatherEnabled":false}"#).unwrap();assert!(!config.weather_enabled);}
 #[test]fn cftc_default_on_and_explicit_opt_out_survives(){assert!(SnapshotConnection::default().cftc_enabled);let mut config=fixture();config.cftc_enabled=false;config.wasde_enabled=false;let loaded:SnapshotConnection=serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();assert!(!loaded.cftc_enabled&&!loaded.wasde_enabled);let legacy:SnapshotConnection=serde_json::from_str(r#"{"enabled":false,"sshAlias":"","dataRoot":"","radarRoot":""}"#).unwrap();assert!(legacy.cftc_enabled&&legacy.wasde_enabled&&!legacy.enabled);}
 #[test]fn free_news_and_market_default_on_but_explicit_opt_out_survives(){assert!(SnapshotConnection::default().news_enabled&&SnapshotConnection::default().market_enabled);let old:SnapshotConnection=serde_json::from_str(r#"{"enabled":false,"sshAlias":"","dataRoot":"","radarRoot":""}"#).unwrap();assert!(old.news_enabled&&old.market_enabled);let mut off=old;off.news_enabled=false;off.market_enabled=false;let roundtrip:SnapshotConnection=serde_json::from_str(&serde_json::to_string(&off).unwrap()).unwrap();assert!(!roundtrip.news_enabled&&!roundtrip.market_enabled);}
 #[test]fn snapshot_config_rejects_options_and_traversal(){
  for alias in ["-oProxyCommand=bad","user@host","a b","a\nfoo"]{let mut c=fixture();c.ssh_alias=alias.into();assert!(c.validate().is_err());}
  for path in ["relative","/srv/../private","/srv/./data","/srv/line\nfeed"]{let mut c=fixture();c.data_root=path.into();assert!(c.validate().is_err());}
  assert!(fixture().validate().is_ok());
 }
 #[test]fn added_public_switches_default_on_preserve_explicit_opt_out_and_remain_ssh_independent(){let old:SnapshotConnection=serde_json::from_str(r#"{"enabled":false,"sshAlias":"","dataRoot":"","radarRoot":""}"#).unwrap();assert!(old.noaa_enabled&&old.inspections_enabled&&old.nass_annual_enabled&&old.crop_progress_enabled&&old.monthly_enabled&&old.ibge_enabled&&!old.enabled);let mut off=old;off.noaa_enabled=false;off.inspections_enabled=false;off.nass_annual_enabled=false;off.crop_progress_enabled=false;off.monthly_enabled=false;off.ibge_enabled=false;let saved:SnapshotConnection=serde_json::from_str(&serde_json::to_string(&off).unwrap()).unwrap();assert_eq!(saved,off);}
 #[test]fn snapshot_config_script_is_data_not_python_interpolation(){let mut config=fixture();config.data_root="/srv/a'\";print('injected')".into();let script=config.script("pass").unwrap();let literal=script.lines().nth(1).unwrap().strip_prefix("CONFIG=json.loads(").unwrap().strip_suffix(')').unwrap();let inner:String=serde_json::from_str(literal).unwrap();assert_eq!(serde_json::from_str::<SnapshotConnection>(&inner).unwrap(),config);assert!(script.ends_with("\npass"));}
 #[test]fn snapshot_config_save_keeps_previous_and_corruption(){
  let dir=Temporary::new();let first=fixture();save_connection_file(&dir.0,&first).unwrap();let bytes=fs::read(dir.0.join("snapshot-connection.json")).unwrap();let mut next=first.clone();next.enabled=false;save_connection_file(&dir.0,&next).unwrap();assert_eq!(load_connection_file(&dir.0.join("snapshot-connection.json")).unwrap(),next);assert_eq!(fs::read(dir.0.join("snapshot-connection.previous.json")).unwrap(),bytes);
  fs::write(dir.0.join("snapshot-connection.json"),b"broken").unwrap();assert!(save_connection_file(&dir.0,&first).is_err());assert_eq!(fs::read(dir.0.join("snapshot-connection.json")).unwrap(),b"broken");
 }
 #[test]fn snapshot_config_backup_failure_does_not_replace_source(){let dir=Temporary::new();save_connection_file(&dir.0,&fixture()).unwrap();let path=dir.0.join("snapshot-connection.json");let before=fs::read(&path).unwrap();fs::create_dir(dir.0.join("snapshot-connection.previous.json")).unwrap();let mut next=fixture();next.ssh_alias="other".into();assert!(save_connection_file(&dir.0,&next).is_err());assert_eq!(fs::read(&path).unwrap(),before);}
 #[test]fn snapshot_config_cache_scope_changes_with_each_location(){let a=fixture();let mut b=a.clone();b.data_root="/srv/other".into();assert_ne!(a,b);assert_ne!(a.origin(),b.origin());b=a.clone();b.radar_root="/srv/radar".into();assert_ne!(a.origin(),b.origin());}
 #[cfg(windows)]#[test]fn disabled_remote_reader_stops_before_ssh(){assert!(read_remote("raise RuntimeError('must not run')",&SnapshotConnection::default()).unwrap_err().starts_with("SNAPSHOT_UNCONFIGURED:"));}
 #[test]fn market_history_selects_latest_collection_for_each_source_date(){
  let db=rusqlite::Connection::open_in_memory().unwrap();
  db.execute_batch("CREATE TABLE yahoo_futures (品種 TEXT,代碼 TEXT,日期 TEXT,最新價 REAL,抓取日 TEXT,\"日漲跌幅%\" REAL);").unwrap();
  for (symbol,date,price,at) in [("SI=F","2026-10-06",50.,"2026-10-06T08:00"),("SI=F","2026-10-07",60.,"2026-10-07T08:00"),("SI=F","2026-10-07",61.,"2026-10-07T09:00"),("SI=F","2026-10-07",62.,"2026-10-07T09:00"),("GC=F","2026-10-08",4000.,"2026-10-08T09:00"),("SI=F","",70.,"2026-10-08T09:00")]{
   db.execute("INSERT INTO yahoo_futures VALUES ('test',?1,?2,?3,?4,-7.928)",rusqlite::params![symbol,date,price,at]).unwrap();
  }
  let mut query=db.prepare(MARKET_QUERY).unwrap();
  let rows=query.query_map(["SI=F"],|row|Ok((row.get::<_,String>(2)?,row.get::<_,f64>(3)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
  assert_eq!(rows,vec![("2026-10-07".into(),62.),("2026-10-06".into(),50.)]);
  let change:f64=db.query_row(&format!("SELECT changePct FROM ({MARKET_QUERY}) LIMIT 1"),["SI=F"],|row|row.get(0)).unwrap();
  assert_eq!(change,-7.928);
 }
}

#[cfg(test)]mod a_stock_config_tests{use super::*;#[test]fn new_a_stock_opt_in_preserves_old_configuration(){assert!(SnapshotConnection::default().a_shares_enabled);let old:SnapshotConnection=serde_json::from_str(r#"{"enabled":false,"sshAlias":"","dataRoot":"","radarRoot":""}"#).unwrap();assert!(!old.a_shares_enabled);let mut enabled=old;enabled.a_shares_enabled=true;let round:SnapshotConnection=serde_json::from_str(&serde_json::to_string(&enabled).unwrap()).unwrap();assert!(round.a_shares_enabled);}}
