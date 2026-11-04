// Kimi Code reader adapted from MoFeng2223/BrimDeck, commit
// 5cbf5596a4163803d2411b96b37f16d925a11986: KimiUsage.cs / UsageService.cs.
// Copyright BrimDeck contributors. Apache-2.0; see docs/licenses/brimdeck-APACHE-2.0.txt.
// Changed: Rust/Tauri integration, fixed official endpoints, existing consent and cache.
use super::*;

const BASE_CN:&str="https://api.kimi.com/coding/v1";
const BASE_GLOBAL:&str="https://api.kimi.ai/coding/v1";
const AUTH_CN:&str="https://auth.kimi.com";
const AUTH_GLOBAL:&str="https://auth.kimi.ai";

fn number(value:&Value)->Option<f64>{
    value.as_f64().or_else(||value.as_str()?.parse().ok()).filter(|n|n.is_finite())
}
fn share(value:&Value)->Option<f64>{
    let limit=number(&value["limit"]).filter(|n|*n>0.)?;
    let used=number(&value["used"]).or_else(||number(&value["remaining"]).map(|n|limit-n))?;
    Some(used/limit*100.)
}
fn reset(value:&Value)->Option<u64>{
    for key in ["resetTime","reset_time","resetAt","reset_at"]{
        if let Some(at)=timestamp_ms(&value[key]){return Some(at)}
    }
    None
}
fn window(id:&str,label:String,minutes:u64,used:f64,reset:Option<u64>)->UsageWindow{
    UsageWindow{id:id.into(),title:Some(label),used_percent:used.clamp(0.,100.),window_duration_mins:Some(minutes),resets_at_unix_ms:reset}
}
fn usages(root:&Value)->Vec<UsageWindow>{
    let mut rows=vec![];
    if root["usages"].is_object(){
        for (id,label,minutes) in [("limit_5h","5 小时额度",300),("limit_7d","每周额度",10080),("limit_month_total","每月额度",43200)]{
            let value=&root["usages"][id];
            if let Some(ratio)=number(&value["used_ratio"]){rows.push(window(id,label.into(),minutes,ratio*100.,reset(value)))}
        }
    }else{
        for value in root["limits"].as_array().into_iter().flatten().take(32){
            let period=&value["window"];
            let minutes=number(&period["duration"]).unwrap_or(0.)*match period["timeUnit"].as_str(){Some("TIME_UNIT_SECOND")=>1./60.,Some("TIME_UNIT_MINUTE")=>1.,Some("TIME_UNIT_HOUR")=>60.,Some("TIME_UNIT_DAY")=>1440.,_=>0.};
            if !minutes.is_finite()||!(1.0..1_000_000.).contains(&minutes){continue}
            let minutes=minutes.round() as u64;
            let Some(used)=share(&value["detail"])else{continue};
            let label=match minutes{300=>"5 小时额度".into(),10080=>"每周额度".into(),43200|44640=>"每月额度".into(),_=>format!("{minutes} 分钟额度")};
            if !rows.iter().any(|row|row.title.as_ref()==Some(&label)){rows.push(window(&format!("limit_{minutes}"),label,minutes,used,reset(&value["detail"])))}
        }
        if !rows.iter().any(|row|row.window_duration_mins==Some(10080)){
            if let Some(used)=share(&root["usage"]){rows.push(window("usage","每周额度".into(),10080,used,reset(&root["usage"])))}
        }
    }
    rows.sort_by_key(|row|row.window_duration_mins);rows
}

// Same limited TOML reader as upstream: only the managed provider and its OAuth table.
fn table_keys(line:&str)->Option<Vec<String>>{
    if !line.starts_with('[')||line.starts_with("[["){return None}
    let mut keys=vec![];let mut current=String::new();let mut quote=None;let mut chars=line[1..].chars();
    while let Some(c)=chars.next(){
        if let Some(q)=quote{if c==q{quote=None}else if c=='\\'&&q=='"'{current.push(chars.next()?)}else{current.push(c)}}
        else{match c{'"'|'\''=>quote=Some(c),'.'=>{keys.push(current.trim().into());current.clear()},']'=>{keys.push(current.trim().into());return Some(keys)},_=>current.push(c)}}
    }
    None
}
fn configured(text:&str,table:Option<&str>,name:&str)->Option<String>{
    let mut expected=vec!["providers","managed:kimi-code"];if let Some(table)=table{expected.push(table)}
    let mut inside=false;
    for line in text.lines().map(str::trim){
        if line.is_empty()||line.starts_with('#'){continue}
        if line.starts_with('['){inside=table_keys(line).is_some_and(|keys|keys==expected);continue}
        if !inside{continue}let Some((key,value))=line.split_once('=')else{continue};
        if key.trim().trim_matches(['"','\''])!=name{continue}
        let value=value.trim();let quote=value.chars().next()?;
        if quote!='"'&&quote!='\''{return None}let end=value[1..].find(quote)?+1;
        return Some(value[1..end].into())
    }
    None
}
fn credential_name(key:&str)->Option<String>{
    let name=key.trim().strip_prefix("oauth/").unwrap_or(key.trim());
    if name.is_empty()||name.len()>120||name.starts_with('.')||name.chars().any(|c|c.is_control()||"/\\:<>\"|?*".contains(c)){None}else{Some(name.into())}
}
fn credential_key(host:Option<&str>,base:&str)->Option<String>{
    let host=host.unwrap_or(AUTH_CN).trim().trim_end_matches('/');let base=base.trim().trim_end_matches('/');
    if host==AUTH_CN&&base==BASE_CN{return Some("kimi-code".into())}
    // Field order is significant for Kimi's credential filename.
    let json=format!("{{\"oauthHost\":{},\"baseUrl\":{}}}",serde_json::to_string(host).ok()?,serde_json::to_string(base).ok()?);
    Some(format!("kimi-code-env-{}",&crate::analysis::sha256(json.as_bytes()).ok()?[..16]))
}
fn service(config:&str,env_base:Option<&str>,env_host:Option<&str>,region:Option<&str>)->Option<(&'static str,String)>{
    let env_base=env_base.map(str::trim).filter(|s|!s.is_empty());let env_host=env_host.map(str::trim).filter(|s|!s.is_empty());
    let base=configured(config,None,"base_url");let key=configured(config,Some("oauth"),"key");
    let host=configured(config,Some("oauth"),"oauth_host").or_else(||configured(config,Some("oauth"),"oauthHost"));
    let signal_global=match env_host.or(host.as_deref()).map(|s|s.trim_end_matches('/')){
        Some(AUTH_GLOBAL)=>true,Some(AUTH_CN)=>false,_=>if key.as_deref().is_some_and(|s|s=="oauth/kimi-code"||s=="kimi-code"){false}else{region==Some("global")}
    };
    let base=env_base.or(base.as_deref()).unwrap_or(if signal_global{BASE_GLOBAL}else{BASE_CN}).trim_end_matches('/');
    // A custom gateway is not an official account endpoint: never forward its login token there.
    let api_host=match base{BASE_CN=>"api.kimi.com",BASE_GLOBAL=>"api.kimi.ai",_=>return None};
    let name=if env_base.is_some()||env_host.is_some(){credential_key(env_host,base)}
        else if let Some(key)=key{credential_name(&key)}else{credential_key(host.as_deref(),if configured(config,None,"base_url").is_some(){base}else{BASE_CN})}?;
    Some((api_host,name))
}
fn bounded_file(path:&std::path::Path,cap:u64)->Result<Vec<u8>,std::io::Error>{
    use std::io::Read;
    let file=std::fs::File::open(path)?;let mut bytes=vec![];
    file.take(cap+1).read_to_end(&mut bytes)?;
    if bytes.len() as u64>cap{bytes.fill(0);return Err(std::io::Error::other("Kimi file exceeds bound"))}Ok(bytes)
}
fn credential(bytes:&[u8],now:u64)->Result<crate::credentials::Secret,&'static str>{
    #[derive(serde::Deserialize)]struct Login{access_token:String,#[serde(default)]expires_at:Value}
    let login:Login=serde_json::from_slice(bytes).map_err(|_|"read-failed")?;
    let token=crate::credentials::Secret::from_string(login.access_token);
    if token.as_str().is_empty()||token.as_str().len()>32768||!token.as_str().bytes().all(|b|b.is_ascii_graphic()){return Err("read-failed")}
    let expiry=if login.expires_at.is_null(){None}else{
        Some(number(&login.expires_at).filter(|n|*n>0.&&*n<253_402_300_800.).map(|n|(n*1000.) as u64).or_else(||timestamp_ms(&login.expires_at)).ok_or("read-failed")?)
    };
    if expiry.is_some_and(|at|at<=now){return Err("not-logged-in")}Ok(token)
}
pub(super) fn read()->AgentObservation{
    let mut result=account("kimi","Kimi Code");result.source="kimi-code-api";
    let Some(home)=std::env::var_os("KIMI_CODE_HOME").map(PathBuf::from).filter(|p|p.is_absolute()&&!p.to_string_lossy().starts_with("\\\\"))
        .or_else(||std::env::var_os("USERPROFILE").map(|p|PathBuf::from(p).join(".kimi-code")))else{return result};
    if !home.is_absolute()||home.to_string_lossy().starts_with("\\\\"){return result}
    let config_path=home.join("config.toml");result.configuration_detected=Some(config_path.is_file());
    result.installed=home.is_dir();result.cli_detected=executable("kimi.exe").is_some();
    if !result.installed&&!result.cli_detected{return result}
    result.running=load_runtime().clients.iter().any(|client|client.id=="kimi");
    let config=match bounded_file(&config_path,1024*1024){Ok(bytes)=>match String::from_utf8(bytes){Ok(s)=>s,Err(_)=>{result.reason="read-failed";return result}},Err(e)if e.kind()==std::io::ErrorKind::NotFound=>String::new(),Err(_)=>{result.reason="read-failed";return result}};
    let region=if std::env::var("KIMI_CODE_REGION_MARKER").is_ok_and(|s|s.trim().eq_ignore_ascii_case("off")){None}else{bounded_file(&home.join("region"),128).ok().and_then(|b|String::from_utf8(b).ok())};
    let env_base=std::env::var("KIMI_CODE_BASE_URL").ok();let env_host=std::env::var("KIMI_CODE_OAUTH_HOST").ok().filter(|s|!s.trim().is_empty()).or_else(||std::env::var("KIMI_OAUTH_HOST").ok());
    let Some((host,name))=service(&config,env_base.as_deref(),env_host.as_deref(),region.as_deref().map(str::trim))else{result.reason="unsupported-account";return result};
    let mut bytes=match bounded_file(&home.join("credentials").join(format!("{name}.json")),1024*1024){Ok(b)=>b,Err(e)=>{result.reason=if e.kind()==std::io::ErrorKind::NotFound{"not-logged-in"}else{"read-failed"};if result.reason=="not-logged-in"{result.login_status="not-logged-in"}return result}};
    let token=credential(&bytes,observed_unix_ms());bytes.fill(0);
    let token=match token{Ok(token)=>token,Err(reason)=>{result.reason=reason;if reason=="not-logged-in"{result.login_status="not-logged-in"}return result}};
    result.login_status="configured";
    let headers=crate::credentials::Secret::from_string(format!("Authorization: Bearer {}\r\nAccept: application/json\r\n",token.as_str()));
    match crate::http::vps_service_get(host,443,true,"/coding/v1/usages",headers.as_str(),&||Ok(())){
        Ok((200,mut bytes))=>{let parsed=serde_json::from_slice::<Value>(&bytes);bytes.fill(0);match parsed{Ok(value)if value.is_object()=>{result.windows=usages(&value);finish_quota(&mut result,"kimi-code-api")},_=>result.reason="read-failed"}},
        Ok((401,_))=>{result.login_status="not-logged-in";result.reason="not-logged-in"},
        Ok((402|404,_))=>result.reason="quota-unavailable",
        _=>result.reason="read-failed"
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn kimi_current_windows_keep_monthly_and_ignore_coding_subset() {
        let rows=usages(&json!({"usages":{"limit_5h":{"used_ratio":0.306,"reset_time":"2026-10-24T07:48:58Z"},"limit_month_total":{"used_ratio":0.0122},"limit_month_code":{"used_ratio":0.5}},"limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"100","used":"31"}}]}));
        assert_eq!(rows.len(),2);assert!((rows[0].used_percent-30.6).abs()<1e-9);
        assert_eq!(rows[0].resets_at_unix_ms,Some(1792828138000));
        assert_eq!(rows[1].window_duration_mins,Some(43200));assert_eq!(rows[1].title.as_deref(),Some("每月额度"));
        assert!((rows[1].used_percent-1.22).abs()<1e-9);
    }
    #[test]
    fn kimi_legacy_counts_and_weekly_only_are_not_fabricated() {
        let rows=usages(&json!({"usage":{"limit":"1000","used":"250"},"limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"100","remaining":"69"}},{"window":{"duration":2,"timeUnit":"TIME_UNIT_HOUR"},"detail":{"limit":"10","used":"5"}}]}));
        assert_eq!(rows.iter().map(|r|r.window_duration_mins).collect::<Vec<_>>(),vec![Some(120),Some(300),Some(10080)]);
        assert!((rows[1].used_percent-31.).abs()<1e-9);assert_eq!(rows[2].used_percent,25.);
        let rows=usages(&json!({"usages":{"limit_7d":{"used_ratio":"0.5"},"limit_5h":{"used_ratio":1.2}}}));
        assert_eq!(rows.len(),2);assert_eq!(rows[0].used_percent,100.);assert_eq!(rows[1].used_percent,50.);
        assert!(usages(&json!({"usages":{}})).is_empty());assert!(usages(&json!([])).is_empty());
        assert!(usages(&json!({"usages":{"limit_5h":{"used_ratio":"NaN"}}})).is_empty());
    }
    #[test]
    fn kimi_service_uses_matching_region_and_safe_credential_name() {
        assert_eq!(service("",None,None,None),Some(("api.kimi.com","kimi-code".into())));
        let config="[providers.other]\nbase_url='https://wrong.example'\n[providers.\"managed:kimi-code\"]\nbase_url='https://api.kimi.ai/coding/v1/' # global\n[providers.'managed:kimi-code'.oauth]\nkey='oauth/global-login'\noauth_host='https://auth.kimi.ai'";
        assert_eq!(service(config,None,None,None),Some(("api.kimi.ai","global-login".into())));
        assert_eq!(service(config,Some("https://api.kimi.com/coding/v1"),Some("https://auth.kimi.com"),None),Some(("api.kimi.com","kimi-code".into())));
        assert!(service(&config.replace("oauth/global-login","oauth/../wrong"),None,None,None).is_none());
        for address in ["http://api.kimi.com/coding/v1","https://api.kimi.com.attacker.example/coding/v1","https://api.kimi.com/coding/v1?x=1"] { assert!(service("",Some(address),None,None).is_none()); }
        assert_eq!(service("",Some(BASE_GLOBAL),Some(AUTH_GLOBAL),None),Some(("api.kimi.ai","kimi-code-env-0e4f99c69cc27850".into())));
        assert_eq!(service("[providers.'managed:kimi-code'.oauth]\nkey='oauth/kimi-code'",None,None,Some("global")),Some(("api.kimi.com","kimi-code".into())));
    }
    #[test]
    fn kimi_expired_or_invalid_login_is_rejected_before_transport(){
        let valid=br#"{"access_token":"fixture-access","refresh_token":"do-not-use","expires_at":2000000000}"#;
        assert_eq!(credential(valid,1_999_999_999_000).unwrap().as_str(),"fixture-access");
        assert!(matches!(credential(valid,2_000_000_000_000),Err("not-logged-in")));
        for bytes in [br#"{"access_token":"bad\r\nheader"}"#.as_slice(),br#"{"access_token":""}"#,br#"{"access_token":"fixture","expires_at":"bad"}"#,br#"{"refresh_token":"do-not-use"}"#]{
            assert!(matches!(credential(bytes,0),Err("read-failed")));
        }
        assert_eq!(credential(br#"{"access_token":"fixture","expires_at":"2033-05-18T03:33:20Z"}"#,0).unwrap().as_str(),"fixture");
    }
}
