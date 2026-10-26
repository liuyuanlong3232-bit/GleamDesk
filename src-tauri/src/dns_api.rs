use serde::{Deserialize,Serialize};
use std::{collections::BTreeSet,time::{Instant,Duration},sync::atomic::{AtomicBool,Ordering}};
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct DnsQuery {domain:String,record_type:String}
#[derive(Clone,Debug,PartialEq,Eq,Deserialize,Serialize)]
pub struct DnsAnswer {name:String,#[serde(rename="type")]kind:u16,#[serde(rename="TTL")]ttl:u32,data:String}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct ResolverResult {provider:&'static str,rcode:Option<u16>,answers:Vec<DnsAnswer>,error:Option<String>}
#[derive(Debug,PartialEq,Eq,Serialize)]
#[serde(rename_all="kebab-case")]
pub enum Comparison {Matching,Different,NoAnswer,Incomplete}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct DnsResult {domain:String,record_type:String,comparison:Comparison,resolvers:Vec<ResolverResult>,completed_at_unix_ms:u64}
#[derive(Deserialize)]
struct Question {name:String,#[serde(rename="type")]kind:u16}
#[derive(Deserialize)]
struct Response {#[serde(rename="Status")]status:u16,#[serde(rename="Question")]question:Vec<Question>,#[serde(rename="Answer",default)]answers:Vec<DnsAnswer>,#[serde(rename="TC")]truncated:bool}
fn normalize_domain(value:&str)->Result<String,String> {
    let value=value.trim().trim_end_matches('.').to_ascii_lowercase();
    if value.len()>253||!value.contains('.')||value.parse::<std::net::IpAddr>().is_ok()
        ||value.ends_with(".local")||value.ends_with(".localhost")||value.split('.').any(|label|label.is_empty()||label.len()>63||label.starts_with('-')||label.ends_with('-')||!label.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_')) {return Err("请输入完整ASCII域名，不含网址路径；国际化域名请使用Punycode。".into());}
    Ok(value)
}
fn query_type(value:&str)->Result<u16,String> {match value {"A"=>Ok(1),"AAAA"=>Ok(28),"CNAME"=>Ok(5),"MX"=>Ok(15),"TXT"=>Ok(16),"NS"=>Ok(2),_=>Err("DNS记录类型无效".into())}}
fn parse_response(bytes:&[u8],domain:&str,kind:u16)->Result<(u16,Vec<DnsAnswer>),String> {
    if bytes.len()>65536 {return Err("DNS响应超过64KB".into());}
    let response:Response=serde_json::from_slice(bytes).map_err(|_|"DNS响应格式未知")?;
    if response.status>15||response.truncated||response.question.len()!=1||normalize_domain(&response.question[0].name)?!=domain||response.question[0].kind!=kind {return Err("DNS响应与查询不匹配或已截断".into());}
    if response.answers.len()>128||response.answers.iter().any(|answer|answer.name.len()>253||answer.data.len()>4096||answer.data.contains('\0')) {return Err("DNS记录超过显示上限".into());}
    Ok((response.status,response.answers))
}
fn signatures(answers:&[DnsAnswer])->BTreeSet<(String,u16,String)> {
    answers.iter().map(|answer|{
        let data=match answer.kind {1|28=>answer.data.parse::<std::net::IpAddr>().map(|ip|ip.to_string()).unwrap_or_else(|_|answer.data.clone()),2|5=>answer.data.trim_end_matches('.').to_ascii_lowercase(),15=>answer.data.to_ascii_lowercase(),_=>answer.data.clone()};
        (answer.name.trim_end_matches('.').to_ascii_lowercase(),answer.kind,data)
    }).collect()
}
fn compare(resolvers:&[ResolverResult])->Comparison {
    if resolvers.len()!=2||resolvers.iter().any(|item|item.error.is_some()||item.rcode.is_none()||!matches!(item.rcode,Some(0|3))) {return Comparison::Incomplete;}
    if resolvers.iter().all(|item|item.rcode==Some(3)) {return Comparison::NoAnswer;}
    if resolvers.iter().all(|item|item.answers.is_empty()) {return if resolvers[0].rcode==resolvers[1].rcode {Comparison::NoAnswer}else{Comparison::Different};}
    if resolvers[0].rcode==resolvers[1].rcode&&signatures(&resolvers[0].answers)==signatures(&resolvers[1].answers) {Comparison::Matching}else{Comparison::Different}
}
#[cfg(windows)]
fn run(query:DnsQuery)->Result<DnsResult,String> {
    let domain=normalize_domain(&query.domain)?;let kind=query_type(&query.record_type)?;
    static BUSY:AtomicBool=AtomicBool::new(false);
    if BUSY.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).is_err(){return Err("已有公共DNS查询进行中".into());}
    struct Lease;impl Drop for Lease {fn drop(&mut self){BUSY.store(false,Ordering::SeqCst);}}let _lease=Lease;
    let deadline=Instant::now()+Duration::from_secs(8);
    let resolvers=std::thread::scope(|scope| {
        let tasks:Vec<_>=[("Cloudflare","cloudflare-dns.com","/dns-query"),("Google Public DNS","dns.google","/resolve")].into_iter().map(|(provider,host,path)|{
            let domain=&domain;
            scope.spawn(move||{
                let subnet=if host=="dns.google"{"&edns_client_subnet=0.0.0.0/0"}else{""};
                let path=format!("{path}?name={domain}&type={kind}{subnet}");
                match crate::http::public_dns_json(host,&path,deadline).and_then(|bytes|parse_response(&bytes,domain,kind)) {
                    Ok((rcode,answers))=>ResolverResult{provider,rcode:Some(rcode),answers,error:None},
                    Err(error)=>ResolverResult{provider,rcode:None,answers:vec![],error:Some(error)},
                }
            })
        }).collect();
        tasks.into_iter().map(|task|task.join().map_err(|_|"DNS查询任务失败".to_string())).collect::<Result<Vec<_>,_>>()
    })?;
    let comparison=compare(&resolvers);
    Ok(DnsResult{domain,record_type:query.record_type,comparison,resolvers,completed_at_unix_ms:std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64})
}
#[tauri::command]
pub async fn dns_api_compare(query:DnsQuery)->Result<DnsResult,String> {
    #[cfg(windows)]{tauri::async_runtime::spawn_blocking(move||run(query)).await.map_err(|_|"DNS查询任务失败".to_string())?}
    #[cfg(not(windows))]{let _=query;Err("公共DNS工具需要Windows桌面程序".into())}
}
#[cfg(test)]mod tests {
    use super::*;
    fn answer(data:&str,ttl:u32)->DnsAnswer {DnsAnswer{name:"EXAMPLE.COM.".into(),kind:1,ttl,data:data.into()}}
    fn resolver(answers:Vec<DnsAnswer>)->ResolverResult {ResolverResult{provider:"fixture",rcode:Some(0),answers,error:None}}
    #[test]fn domain_and_record_types_are_bounded(){
        for value in ["https://example.com/","example.com?token=x","foo..com","localhost","192.0.2.1","example.com & calc","x.local","a\r\n.com","中文.com"] {assert!(normalize_domain(value).is_err(),"{value}");}
        assert_eq!(normalize_domain(" EXAMPLE.COM. ").unwrap(),"example.com");assert_eq!(query_type("AAAA").unwrap(),28);assert!(query_type("ANY").is_err());
    }
    #[test]fn response_must_match_query_and_not_be_truncated(){
        let value=br#"{"Status":0,"TC":false,"Question":[{"name":"example.com.","type":1}],"Answer":[{"name":"example.com.","type":1,"TTL":60,"data":"192.0.2.1"}]}"#;
        assert_eq!(parse_response(value,"example.com",1).unwrap().1.len(),1);
        assert!(parse_response(value,"other.example",1).is_err());assert!(parse_response(value,"example.com",28).is_err());
        assert!(parse_response(br#"{"Status":0,"TC":true,"Question":[{"name":"example.com.","type":1}]}"#,"example.com",1).is_err());
        assert!(parse_response(b"{}","example.com",1).is_err());
    }
    #[test]fn comparison_ignores_order_and_ttl_but_never_hides_failures(){
        assert_eq!(compare(&[resolver(vec![answer("192.0.2.1",60),answer("192.0.2.2",30)]),resolver(vec![answer("192.0.2.2",5),answer("192.0.2.1",10)])]),Comparison::Matching);
        assert_eq!(compare(&[resolver(vec![answer("192.0.2.1",60)]),resolver(vec![answer("192.0.2.2",30)])]),Comparison::Different);
        assert_eq!(compare(&[resolver(vec![]),resolver(vec![])]),Comparison::NoAnswer);
        let mut failed=resolver(vec![]);failed.error=Some("timeout".into());assert_eq!(compare(&[resolver(vec![]),failed]),Comparison::Incomplete);
    }
    #[test]fn txt_case_is_preserved_and_service_failure_is_incomplete(){
        let mut first=answer("Token-A",5);first.kind=16;let mut second=first.clone();second.data="token-a".into();
        assert_eq!(compare(&[resolver(vec![first]),resolver(vec![second])]),Comparison::Different);
        let mut failed=resolver(vec![]);failed.rcode=Some(2);assert_eq!(compare(&[resolver(vec![]),failed]),Comparison::Incomplete);
    }
}
