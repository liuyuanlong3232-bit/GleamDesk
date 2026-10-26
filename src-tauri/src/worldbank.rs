// World Bank Pink Sheet: official monthly workbook, read in memory only.
use calamine::{Data, Range, Reader, Xlsx};
use serde_json::{json, Value};
use std::io::Cursor;

pub(crate) const PAGE:&str="/en/research/commodity-markets";
const SERIES:[(&str,&str);5]=[("Maize","($/mt)"),("Wheat, US SRW","($/mt)"),("Wheat, US HRW","($/mt)"),("Sugar, world","($/kg)"),("Cotton, A Index","($/kg)")];

pub(crate) fn file_path(value:&str)->Option<String>{
    let path=value.strip_prefix("https://thedocs.worldbank.org").unwrap_or(value);
    let middle=path.strip_prefix("/en/doc/")?.strip_suffix("/related/CMO-Historical-Data-Monthly.xlsx")?;
    if middle.is_empty()||middle.len()>160||!middle.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'){return None;}
    Some(path.into())
}
fn discover(html:&str)->Result<String,String>{
    let mut paths=Vec::new();
    for fragment in html.split("href=").skip(1){
        let fragment=fragment.trim_start();let quote=fragment.chars().next().unwrap_or(' ');
        if !matches!(quote,'\''|'"'){continue;}
        if let Some(end)=fragment[1..].find(quote){
            let link=&fragment[1..end+1];
            if link.starts_with("https://thedocs.worldbank.org/"){if let Some(path)=file_path(link){paths.push(path);}}
        }
    }
    paths.sort();paths.dedup();
    if paths.len()!=1{return Err("世界银行月表链接不唯一或未找到".into());}
    Ok(paths.remove(0))
}
fn text(cell:Option<&Data>)->&str{match cell{Some(Data::String(s))=>s.trim(),_=>""}}
fn period(value:&str)->Option<String>{
    if value.len()!=7||!value.is_ascii()||&value[4..5]!="M"{return None;}
    let year=value[..4].parse::<u16>().ok()?;let month=value[5..].parse::<u8>().ok()?;
    if !(1960..=2099).contains(&year)||!(1..=12).contains(&month){return None;}
    Some(format!("{year:04}-{month:02}-01"))
}
fn updated(value:&str)->Option<String>{
    let value=value.strip_prefix("Updated on ")?;let parts:Vec<_>=value.split_whitespace().collect();if parts.len()!=3{return None;}
    let months=["January","February","March","April","May","June","July","August","September","October","November","December"];
    let month=months.iter().position(|m|*m==parts[0])?+1;
    let day=parts[1].strip_suffix(',')?.parse::<u8>().ok()?;let year=parts[2].parse::<u16>().ok()?;
    let max=match month{2=>if year%4==0&&(year%100!=0||year%400==0){29}else{28},4|6|9|11=>30,_=>31};
    if !(1960..=2099).contains(&year)||day==0||day>max{return None;}
    Some(format!("{year:04}-{month:02}-{day:02}"))
}
fn table(range:&Range<Data>,at:&str)->Result<Value,String>{
    let rows:Vec<_>=range.rows().collect();
    if rows.len()>2000||rows.len()<7||range.width()>128{return Err("世界银行月表范围变化".into());}
    if text(rows[0].first())!="World Bank Commodity Price Data (The Pink Sheet)"||!text(rows[1].first()).contains("monthly prices in nominal US dollars"){return Err("世界银行月表标题或美元口径变化".into());}
    let updates:Vec<_>=rows.iter().take(5).filter_map(|r|updated(text(r.first()))).collect();
    if updates.len()!=1||updates[0].as_str()>at.get(..10).unwrap_or(""){return Err("世界银行文件更新日期无效".into());}
    let headers:Vec<_>=rows.iter().take(10).enumerate().filter(|(_,r)|r.iter().any(|c|text(Some(c))=="Maize")).map(|(i,_)|i).collect();
    if headers.len()!=1{return Err("世界银行商品列头变化".into());}
    let header=headers[0];let units=rows.get(header+1).ok_or("世界银行单位行缺失")?;
    let mut columns=Vec::new();
    for (name,unit) in SERIES{
        let matches:Vec<_>=rows[header].iter().enumerate().filter(|(_,c)|text(Some(c))==name).map(|(i,_)|i).collect();
        if matches.len()!=1||text(units.get(matches[0]))!=unit{return Err("世界银行商品或单位变化".into());}
        columns.push(matches[0]);
    }
    let mut previous=String::new();let mut values:Vec<Option<(String,f64)>>=vec![None;SERIES.len()];
    for row in rows.iter().skip(header+2){
        if row.iter().all(|c|matches!(c,Data::Empty)){continue;}
        let date=period(text(row.first())).ok_or("世界银行月份格式变化")?;
        if date<=previous||date.as_str()>at.get(..10).unwrap_or("")||date>updates[0]{return Err("世界银行月份重复、逆序或超前".into());}
        previous=date.clone();
        for (i,col) in columns.iter().enumerate(){
            let value=match row.get(*col){Some(Data::Empty)|None=>None,Some(Data::String(s)) if matches!(s.trim(),""|".."|"…"|"NA"|"n/a")=>None,Some(Data::Float(n))=>Some(*n),Some(Data::Int(n))=>Some(*n as f64),_=>return Err("世界银行价格类型变化".into())};
            if let Some(n)=value{if !n.is_finite()||n<0.0{return Err("世界银行价格数值无效".into());}values[i]=Some((date.clone(),n));}
        }
    }
    if previous.is_empty()||values.iter().all(Option::is_none){return Err("世界银行月表没有可用价格".into());}
    let items:Vec<_>=SERIES.iter().zip(values).map(|((header,unit),found)|match found{Some((date,value))=>json!({"header":header,"unit":unit,"date":date,"value":value}),None=>json!({"header":header,"unit":unit,"date":null,"value":null})}).collect();
    Ok(json!({"period":previous,"updatedOn":updates[0],"items":items}))
}
pub(crate) fn parse(bytes:&[u8],at:&str)->Result<Value,String>{
    if bytes.len()>2*1024*1024||!bytes.starts_with(b"PK\x03\x04"){return Err("世界银行返回内容不是受支持的月表".into());}
    let mut workbook=Xlsx::new(Cursor::new(bytes)).map_err(|_|"世界银行工作簿无效")?;
    let range=workbook.worksheet_range("Monthly Prices").map_err(|_|"世界银行月价工作表缺失")?;
    table(&range,at)
}
#[cfg(windows)]pub(crate) fn fetch(check:&impl Fn()->Result<(),String>)->Result<Value,String>{
    let(status,page)=crate::http::worldbank_get("www.worldbank.org",PAGE,check)?;
    if status!=200{return Err(format!("世界银行目录返回 HTTP {status}"));}
    let html=String::from_utf8(page).map_err(|_|"世界银行目录编码无效")?;let path=discover(&html)?;
    check()?;let(status,bytes)=crate::http::worldbank_get("thedocs.worldbank.org",&path,check)?;
    if status!=200{return Err(format!("世界银行月表返回 HTTP {status}"));}
    check()?;let(_,at)=crate::daily_recommendations::clock()?;let payload=parse(&bytes,&at)?;check()?;
    Ok(json!({"key":"worldbank-monthly","collectedAt":at,"sourceUrl":format!("https://thedocs.worldbank.org{path}"),"body":payload.to_string()}))
}

#[cfg(test)]mod tests{
    use super::*;
    fn fixture()->Range<Data>{
        let mut r=Range::new((0,0),(8,5));
        r.set_value((0,0),Data::String("World Bank Commodity Price Data (The Pink Sheet)".into()));
        r.set_value((1,0),Data::String("monthly prices in nominal US dollars, 1960 to present".into()));
        r.set_value((3,0),Data::String("Updated on October 02, 2026".into()));
        for(i,(h,u))in SERIES.iter().enumerate(){r.set_value((4,i as u32+1),Data::String((*h).into()));r.set_value((5,i as u32+1),Data::String((*u).into()));}
        for(row,p)in [(6,"2026M08"),(7,"2026M09")]{r.set_value((row,0),Data::String(p.into()));for col in 1..=5{r.set_value((row,col),Data::Float(if row==6{10.0}else{col as f64-1.0}));}}r
    }
    #[test]fn links_only_accept_one_official_monthly_workbook(){let link="https://thedocs.worldbank.org/en/doc/example-0050012026/related/CMO-Historical-Data-Monthly.xlsx";assert!(discover(&format!("<a href='{link}'>month</a><a href='{link}'>duplicate</a>")).is_ok());assert!(discover(&format!("<a href='{link}'/><a href='{}'/>",link.replace("example-","other-"))).is_err());for s in [link.replace("thedocs.worldbank.org","evil.test"),link.replace("example-","../"),format!("{link}?key=x"),link.replace("Monthly","Annual"),link.replace("worldbank.org/","worldbank.org.evil/")]{assert!(file_path(&s).is_none());}assert!(discover("no link").is_err());}
    #[test]fn columns_keep_both_wheats_and_original_units(){let result=table(&fixture(),"2026-10-23").unwrap();assert_eq!(result["period"],"2026-09-01");assert_eq!(result["updatedOn"],"2026-10-02");assert_eq!(result["items"][0]["value"].as_f64(),Some(0.0));assert_eq!(result["items"][1]["header"],"Wheat, US SRW");assert_eq!(result["items"][2]["header"],"Wheat, US HRW");assert_eq!(result["items"][4]["unit"],"($/kg)");}
    #[test]fn missing_latest_value_keeps_real_older_month(){let mut r=fixture();r.set_value((7,2),Data::Empty);let v=table(&r,"2026-10-23").unwrap();assert_eq!(v["items"][1]["date"],"2026-08-01");assert_eq!(v["items"][1]["value"].as_f64(),Some(10.0));}
    #[test]fn malformed_schema_dates_and_prices_fail_closed(){for(pos,value)in [((5,1),Data::String("cents/lb".into())),((4,2),Data::String("Maize".into())),((7,0),Data::String("2026M08".into())),((7,0),Data::String("2026M13".into())),((7,0),Data::String("2027M01".into())),((3,0),Data::String("Updated on February 30, 2026".into())),((7,1),Data::Bool(true)),((7,1),Data::Float(-1.0)),((7,1),Data::Float(f64::NAN))]{let mut r=fixture();r.set_value(pos,value);assert!(table(&r,"2026-10-23").is_err());}}
    #[test]fn invalid_xlsx_is_never_treated_as_data(){for b in [b"<html>HTTP 200</html>".as_slice(),b"PK\x03\x04bad"]{assert!(parse(b,"2026-10-23").is_err());}}
    #[cfg(windows)]#[test]fn transport_is_scoped_and_cancels_before_network(){for(host,path)in [("evil.test",PAGE),("www.worldbank.org","/other"),("thedocs.worldbank.org","/en/doc/../related/CMO-Historical-Data-Monthly.xlsx")]{assert!(crate::http::worldbank_get(host,path,&||Ok(())).unwrap_err().contains("地址无效"));}for(host,path)in [("www.worldbank.org",PAGE),("thedocs.worldbank.org","/en/doc/example/related/CMO-Historical-Data-Monthly.xlsx")]{assert!(crate::http::worldbank_get(host,path,&||Err("fixture cancelled".into())).unwrap_err().contains("fixture cancelled"));}}
    #[cfg(windows)]#[test]#[ignore="explicit two-GET public integration check only; never run by default"]fn live_official_source(){assert_eq!(std::env::var("WORLDBANK_LIVE_CHECK").as_deref(),Ok("two-public-get-requests"));let result=fetch(&||Ok(())).unwrap();println!("{result}");assert_eq!(result["key"],"worldbank-monthly");}
    #[test]#[ignore="explicit local official-workbook replay only; no network"]fn replay_official_workbook(){let p=std::env::var_os("WORLDBANK_REPLAY_XLSX").expect("explicit replay path");let bytes=std::fs::read(p).unwrap();let v=parse(&bytes,"2026-10-23T00:00:00Z").unwrap();assert_eq!(v["period"],"2026-09-01");assert_eq!(v["items"][0]["value"],239.6);assert_eq!(v["items"][1]["value"],278.6);assert_eq!(v["items"][2]["value"],347.0);assert_eq!(v["items"][3]["value"],0.41);assert_eq!(v["items"][4]["value"],2.1);println!("{}",v);}
}
