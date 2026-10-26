// Monthly national crop report from Argentina's agriculture secretariat. No regional summation.
use serde_json::{json,Value};
pub(crate) const PAGE:&str="/sitio/areas/estimaciones/estimaciones/informes/";
const ROOT:&str="/sitio/areas/estimaciones/_archivos/estimaciones/";
const MONTHS:[&str;12]=["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const SHORT_MONTHS:[&str;12]=["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
#[derive(Debug,Clone)]struct Report{path:String,date:String}
fn date(day:&str,month:&str,year:&str)->Option<String>{
 let d=day.parse::<u8>().ok()?;let m=month.parse::<u8>().ok()?;let y=year.parse::<u16>().ok()?;
 let max=match m{2=>if y%4==0&&(y%100!=0||y%400==0){29}else{28},4|6|9|11=>30,1|3|5|7|8|10|12=>31,_=>return None};if !(2000..=2099).contains(&y)||d==0||d>max{return None;}Some(format!("{y:04}-{m:02}-{d:02}"))
}
fn file_info(value:&str)->Option<Report>{
 let encoded=value.replace(' ',"%20");let path=encoded.strip_prefix("https://www.magyp.gob.ar").unwrap_or(&encoded);
 let parts:Vec<_>=path.strip_prefix(ROOT)?.split('/').collect();if parts.len()!=3{return None;}
 let (prefix,tail)=parts[2].split_once("Informe%20Mensual%20al%20")?;let stamp=tail.strip_suffix(".pdf")?;
 if stamp.len()!=10||!stamp.is_ascii()||&stamp[2..3]!="_"||&stamp[5..6]!="_"{return None;}
 let day=&stamp[..2];let month=&stamp[3..5];let year=&stamp[6..];let at=date(day,month,year)?;
 if prefix.strip_suffix('_').or_else(||prefix.strip_suffix("%20"))?!=format!("{}{month}{day}",&year[2..]){return None;}
 let month_num=month.parse::<usize>().ok()?;let name=MONTHS[month_num-1];let title=format!("{}{}",name[..1].to_uppercase(),&name[1..]);
 if parts[0]!=format!("{}0000_{year}",&year[2..])||parts[1]!=format!("{}{month}00_{title}",&year[2..]){return None;}
 Some(Report{path:path.into(),date:at})
}
pub(crate) fn file_path(value:&str)->Option<String>{file_info(value).map(|r|r.path)}
pub(crate) fn directory_path(path:&str)->bool{
 if path==PAGE{return true;}let Some(month)=path.strip_prefix(&format!("{PAGE}?mes="))else{return false;};
 month.len()==7&&month.is_ascii()&&&month[4..5]=="-"&&date("01",&month[5..],&month[..4]).is_some()
}
fn links(html:&str)->Vec<&str>{let mut out=Vec::new();for fragment in html.split("href=").skip(1){let fragment=fragment.trim_start();let q=fragment.chars().next().unwrap_or(' ');if matches!(q,'\''|'"'){if let Some(end)=fragment[1..].find(q){out.push(&fragment[1..end+1]);}}}out}
fn discover(html:&str,at:&str)->Result<(Option<Report>,Option<String>),String>{
 if !html.contains("name=\"mes\""){return Err("阿根廷月报目录格式变化".into());}
 let mut reports:Vec<_>=links(html).iter().filter_map(|v|file_info(v)).filter(|r|r.date.as_str()<=at.get(..10).unwrap_or("")).collect();reports.sort_by(|a,b|a.date.cmp(&b.date));
 let latest=reports.pop();if latest.as_ref().is_some_and(|last|reports.iter().any(|r|r.date==last.date&&r.path!=last.path)){return Err("阿根廷当期月报链接不唯一".into());}
 let mut previous:Vec<_>=links(html).into_iter().filter_map(|link|link.strip_prefix("?mes=")).filter(|m|directory_path(&format!("{PAGE}?mes={m}"))&&*m<at.get(..7).unwrap_or("")).collect();previous.sort();previous.dedup();
 Ok((latest,previous.pop().map(|m|format!("{PAGE}?mes={m}"))))
}
fn pages(bytes:&[u8])->Result<Vec<String>,String>{
 if bytes.len()>4*1024*1024||!bytes.starts_with(b"%PDF-"){return Err("阿根廷来源不是受支持的月报PDF".into());}
 let result=std::panic::catch_unwind(||pdf_extract::extract_text_from_mem_by_pages(bytes)).map_err(|_|"阿根廷PDF结构不支持")?.map_err(|_|"阿根廷PDF文本读取失败")?;
 if result.is_empty()||result.len()>80||result.iter().map(String::len).sum::<usize>()>1024*1024{return Err("阿根廷月报文本范围异常".into());}Ok(result)
}
fn cell(text:&str)->Result<Option<u64>,String>{
 if text=="-"{return Ok(None);}let groups:Vec<_>=text.split('.').collect();
 if groups.is_empty()||groups[0].is_empty()||groups.iter().any(|g|!g.bytes().all(|b|b.is_ascii_digit()))||groups.len()>1&&(groups[0].len()>3||groups[1..].iter().any(|g|g.len()!=3)){return Err("阿根廷数量格式变化".into());}
 let n=groups.join("").parse::<u64>().map_err(|_|"阿根廷数量无效")?;if n>9_007_199_254_740_991{return Err("阿根廷数量超限".into());}Ok(Some(n))
}
fn triplet(tokens:&[&str],label:&[&str])->Result<[Option<u64>;3],String>{
 let hits:Vec<_>=tokens.windows(label.len()).enumerate().filter(|(_,w)|*w==label).map(|(i,_)|i+label.len()).collect();if hits.len()!=1{return Err("阿根廷表格指标缺失或重复".into());}let start=hits[0];let values=tokens.get(start..start+3).ok_or("阿根廷表格数值缺失")?;Ok([cell(values[0])?,cell(values[1])?,cell(values[2])?])
}
fn parse_text(pages:&[String],report:&Report)->Result<Value,String>{
 let m=report.date[5..7].parse::<usize>().map_err(|_|"阿根廷报告月份无效")?;let y=&report.date[..4];let d=report.date[8..].parse::<u8>().map_err(|_|"阿根廷报告日期无效")?;
 let heading=format!("Informe Mensual {d} de {} de {y}",MONTHS[m-1]);
 let normalized:Vec<_>=pages.iter().map(|p|p.split_whitespace().collect::<Vec<_>>().join(" ")).collect();
 if normalized.first().is_none_or(|p|!p.contains(&format!("Informe Mensual {d} de {} de {y}",MONTHS[m-1]))){return Err("阿根廷月报封面日期与链接不符".into());}
 let mut items=Vec::new();
 for (id,crop)in [("wheat","TRIGO"),("corn","MAÍZ"),("soybeans","SOJA")]{
  let hits:Vec<_>=pages.iter().enumerate().filter(|(i,p)|p.lines().any(|l|l.trim()==crop)&&normalized[*i].contains("Campaña")&&normalized[*i].contains("Producción estimada (ton)")).collect();
  if hits.len()!=1{return Err("阿根廷作物全国表缺失或重复".into());}let(index,_)=hits[0];let text=&normalized[index];if !text.contains(&heading){return Err("阿根廷作物报告日期不一致".into());}
  let tokens:Vec<_>=text.split_whitespace().collect();
  let season=tokens.windows(2).find_map(|w|if w[0]=="Campaña"&&w[1].len()==7&&w[1].is_ascii()&&w[1].as_bytes()[4]==b'/'{Some(w[1])}else{None}).ok_or("阿根廷作物年度缺失")?;
  let year=season[..4].parse::<u16>().map_err(|_|"阿根廷作物年度无效")?;
  if !(2000..=2098).contains(&year)||season[5..].parse::<u16>().ok()!=Some((year+1)%100){return Err("阿根廷作物年度不连续".into());}
  let previous=format!("{:04}/{:02}",year-1,year%100);if !text.contains(&format!("Campaña {}",&previous[2..]))||!text.contains(&format!("Campaña {}",&season[2..])){return Err("阿根廷表内年度列变化".into());}
  let area_label=["Superficie","implantada","(ha)"];let first_metric=tokens.iter().position(|w|*w=="Superficie").ok_or("阿根廷面积表头缺失")?;
  let before=&tokens[..first_metric];if before.len()<4||before[before.len()-2]!=SHORT_MONTHS[m-1]||before[before.len()-1]!=&y[2..]{return Err("阿根廷当期月份列顺序未确认".into());}
  if before.windows(4).filter(|w|*w==["Campaña",&previous[2..],"Campaña",&season[2..]]).count()!=1{return Err("阿根廷上年与本年列顺序未确认".into());}
  let area=triplet(&tokens,&area_label)?;let production=triplet(&tokens,&["Producción","estimada","(ton)"])?;
  items.push(json!({"id":id,"season":season,"previousSeason":previous,"areaHa":area[2],"previousAreaHa":area[0],"productionTonnes":production[2],"previousProductionTonnes":production[0],"page":index+1}));
 }
 let mut next=None;for text in &normalized{let t:Vec<_>=text.split_whitespace().collect();for w in t.windows(6){if w[0..2]==["PRÓXIMO","REPORTE"]&&w[4]=="de"{if let Some(month)=MONTHS.iter().position(|m|*m==w[5]){if let Some(day)=date(w[3],&format!("{:02}",month+1),w[2]){if day>report.date{if next.as_ref().is_some_and(|old|*old!=day){return Err("阿根廷下次报告计划不唯一".into());}next=Some(day);}}}}}}
 Ok(json!({"publishedDate":report.date,"unitArea":"ha","unitProduction":"ton","scope":"Argentina nacional","items":items,"nextReportDate":next}))
}
fn parse(bytes:&[u8],report:&Report)->Result<Value,String>{parse_text(&pages(bytes)?,report)}
#[cfg(windows)]pub(crate) fn fetch(check:&impl Fn()->Result<(),String>)->Result<Value,String>{
 let(status,bytes)=crate::http::argentina_get(PAGE,check)?;if status!=200{return Err(format!("阿根廷月报目录返回 HTTP {status}"));}let html=String::from_utf8(bytes).map_err(|_|"阿根廷目录编码无效")?;check()?;let(_,at)=crate::daily_recommendations::clock()?;let(found,previous)=discover(&html,&at)?;
 let report=if let Some(r)=found{r}else{let previous=previous.ok_or("阿根廷目录没有可核对的月报")?;let(status,bytes)=crate::http::argentina_get(&previous,check)?;if status!=200{return Err(format!("阿根廷上月目录返回 HTTP {status}"));}let html=String::from_utf8(bytes).map_err(|_|"阿根廷目录编码无效")?;discover(&html,&at)?.0.ok_or("阿根廷上月目录没有可核对的月报")?};
 let(status,bytes)=crate::http::argentina_get(&report.path,check)?;if status!=200{return Err(format!("阿根廷月报返回 HTTP {status}"));}check()?;let payload=parse(&bytes,&report)?;check()?;let(_,collected)=crate::daily_recommendations::clock()?;
 Ok(json!({"key":"argentina-crops","collectedAt":collected,"sourceUrl":format!("https://www.magyp.gob.ar{}",report.path),"body":payload.to_string()}))
}
#[cfg(test)]mod tests{
 use super::*;
 fn link()->String{format!("https://www.magyp.gob.ar{ROOT}260000_2026/261000_Octubre/261015%20Informe%20Mensual%20al%2015_10_2026.pdf")}
 fn report()->Report{file_info(&link()).unwrap()}
 fn fixture()->Vec<String>{
  let mut v=vec!["Informe Mensual 15 de octubre de 2026".into()];
  for crop in ["TRIGO","MAÍZ","SOJA"]{v.push(format!("ESTIMACIONES AGRÍCOLAS Informe Mensual 15 de octubre de 2026\n{crop}\nCampaña 2026/27\nCampaña 25/26 Campaña 26/27 Oct 26 vs Sep 26 Oct 26 vs 25/26 Sep 26 Oct 26\n{}Superficie implantada (ha) 1.000 2.000 0 0 % 0 %\nProducción estimada (ton) 3.000 - - - -",if crop=="MAÍZ"{"Superficie destinada a grano cosechada(ha) 4.000 - - - -\n"}else{""}));}
  v.push("PRÓXIMO REPORTE 2026 19 de noviembre".into());v
 }
 #[test]fn report_links_are_fixed_dated_monthly_pdf_only(){assert!(file_path(&link()).is_some());for value in [link().replace("www.magyp.gob.ar","evil.test"),link().replace("Mensual","Semanal"),format!("{}?token=x",link()),link().replace("261000_Octubre","261100_Noviembre"),link().replace("261015","261016"),link().replace("15_10_2026","31_02_2026")]{assert!(file_path(&value).is_none());}assert!(directory_path(PAGE));assert!(directory_path(&format!("{PAGE}?mes=2026-09")));assert!(!directory_path(&format!("{PAGE}?mes=2026-13")));assert!(!directory_path(&format!("{PAGE}?mes=2026-09&token=x")));}
 #[test]fn directory_discovers_latest_existing_not_guessed_filename(){let html=format!("<input name=\"mes\"><a href='{}'>report</a><a href='?mes=2026-09'>prev</a>",link());let(r,p)=discover(&html,"2026-10-24").unwrap();assert_eq!(r.unwrap().date,"2026-10-15");assert_eq!(p.unwrap(),format!("{PAGE}?mes=2026-09"));assert!(discover(&html,"2026-10-14").unwrap().0.is_none());assert!(discover("<html>login</html>","2026-10-24").is_err());}
 #[test]fn original_units_years_and_missing_production_not_replaced_by_area_or_previous(){let v=parse_text(&fixture(),&report()).unwrap();assert_eq!(v["items"].as_array().unwrap().len(),3);for i in 0..3{assert!(v["items"][i]["productionTonnes"].is_null());assert_eq!(v["items"][i]["previousProductionTonnes"],3000);assert_eq!(v["items"][i]["areaHa"],0);assert_eq!(v["items"][i]["season"],"2026/27");}assert_eq!(v["nextReportDate"],"2026-11-19");}
 #[test]fn mismatch_dates_units_columns_or_duplicate_crops_fail_closed(){for(a,b)in [("15 de octubre de 2026","16 de octubre de 2026"),("(ton)","(millones ton)"),("Sep 26 Oct 26\n","Oct 26 Sep 26\n"),("Campaña 25/26","Campaña 24/25"),("Campaña 25/26 Campaña 26/27","Campaña 26/27 Campaña 25/26"),("3.000 - -","3.000 - invalid")]{let v:Vec<String>=fixture().iter().map(|s|s.replace(a,b)).collect();assert!(parse_text(&v,&report()).is_err(),"{a}");}let mut v=fixture();v.push(v[1].clone());assert!(parse_text(&v,&report()).is_err());}
 #[test]fn spanish_thousands_and_zero_are_exact_and_unknown_not_zero(){assert_eq!(cell("0").unwrap(),Some(0));assert_eq!(cell("1.234.567").unwrap(),Some(1234567));assert_eq!(cell("-").unwrap(),None);for s in ["1,2","12.34","-1","NaN","","1e6"]{assert!(cell(s).is_err());}}
 #[test]fn no_next_plan_is_inferred_from_regular_monthly_schedule(){let mut p=fixture();p.pop();assert!(parse_text(&p,&report()).unwrap()["nextReportDate"].is_null());}
 #[cfg(windows)]#[test]fn target_and_cancel_are_checked_before_network(){assert!(crate::http::argentina_get("/wrong",&||Ok(())).is_err());for p in [PAGE.to_string(),report().path]{assert_eq!(crate::http::argentina_get(&p,&||Err("fixture cancelled".into())).unwrap_err(),"fixture cancelled");}}
 #[test]fn old_config_stays_disabled(){let old:crate::agriculture::SnapshotConnection=serde_json::from_str(r#"{"enabled":false,"sshAlias":"","dataRoot":"","radarRoot":""}"#).unwrap();assert!(!old.argentina_enabled);assert!(crate::agriculture::SnapshotConnection::default().argentina_enabled);}
 #[test]#[ignore="explicit saved official PDF inspection only"]fn inspect_saved_pdf(){let p=std::env::var_os("ARGENTINA_REPLAY_PDF").expect("explicit saved file");let bytes=std::fs::read(p).unwrap();for(i,page)in pages(&bytes).unwrap().iter().enumerate(){if page.contains("TRIGO")||page.contains("MAÍZ")||page.contains("SOJA"){println!("ARG_PAGE_{}:{}",i+1,serde_json::to_string(page).unwrap());}}}
 #[test]#[ignore="explicit saved official PDF replay only"]fn replay_saved_pdf(){let p=std::env::var_os("ARGENTINA_REPLAY_PDF").expect("explicit saved file");let html=std::fs::read_to_string(std::env::var_os("ARGENTINA_REPLAY_INDEX").expect("explicit saved directory page")).unwrap();let report=discover(&html,"2026-10-24T00:00:00Z").unwrap().0.unwrap();let v=parse(&std::fs::read(p).unwrap(),&report).unwrap();assert_eq!(v["items"].as_array().unwrap().len(),3);assert_eq!(v["nextReportDate"],"2026-11-19");println!("ARGENTINA_REPLAY:{}",v);}
 #[cfg(windows)]#[test]#[ignore="explicit official directory and PDF native read only"]fn live_official_source(){assert_eq!(std::env::var("ARGENTINA_LIVE_CHECK").as_deref(),Ok("official-monthly-read"));println!("ARGENTINA_RECEIPT:{}",fetch(&||Ok(())).unwrap());}
}
