// CONAB monthly national production table. Fixed official source; workbook stays in memory.
use calamine::{Data,Range,Reader,Xlsx};
use serde_json::{json,Value};
use std::io::Cursor;
pub(crate) const PAGE:&str="/conab/pt-br/atuacao/informacoes-agropecuarias/safras/safra-de-graos/boletim-da-safra-de-graos";
const MONTHS:[&str;12]=["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
const FULL_MONTHS:[&str;12]=["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
const PRODUCTS:[(&str,&str,bool);8]=[("total","BRASIL (2)",false),("soybeans","SOJA",false),("corn","MILHO TOTAL",false),("corn-first","Milho 1ª Safra",false),("corn-second","Milho 2ª Safra",false),("corn-third","Milho 3ª Safra",false),("cotton-lint","ALGODÃO - PLUMA",false),("wheat","TRIGO",true)];
#[derive(Debug,Clone)]struct Report{path:String,month:String,season:String,previous_season:String,number:u8,published:String}
fn file_info(value:&str)->Option<Report>{
 let path=value.strip_prefix("https://www.gov.br").unwrap_or(value);
 let rest=path.strip_prefix(&format!("{PAGE}/"))?;let(folder,file)=rest.split_once('/')?;
 let(n,years)=folder.split_once("o-levantamento-safra-")?;let number=n.parse::<u8>().ok()?;if !(1..=12).contains(&number)||n!=number.to_string(){return None;}
 if years.len()!=7||!years.is_ascii()||&years[4..5]!="-"{return None;}
 let year=years[..4].parse::<u16>().ok()?;if !(2000..=2098).contains(&year)||years[5..].parse::<u16>().ok()? !=(year+1)%100{return None;}
 let tail=file.strip_prefix("site_previsao_de_safra-por_produto-")?.strip_suffix(".xlsx")?;
 let(mon,y)=tail.split_once('-')?;let month=MONTHS.iter().position(|m|*m==mon)?+1;
 if y.len()!=4||!y.bytes().all(|b|b.is_ascii_digit()){return None;}let publication_year=y.parse::<u16>().ok()?;
 if publication_year!=if month>=10{year}else{year+1}{return None;}
 Some(Report{path:path.into(),month:format!("{publication_year:04}-{month:02}"),season:format!("{year:04}/{:02}",(year+1)%100),previous_season:format!("{:04}/{:02}",year-1,year%100),number,published:String::new()})
}
pub(crate) fn file_path(value:&str)->Option<String>{file_info(value).map(|r|r.path)}
fn date(s:&str)->Option<String>{
 if s.len()!=10||!s.is_ascii()||&s[2..3]!="/"||&s[5..6]!="/"{return None;}
 let day=s[..2].parse::<u8>().ok()?;let month=s[3..5].parse::<u8>().ok()?;let year=s[6..].parse::<u16>().ok()?;
 let max=match month{2=>if year%4==0&&(year%100!=0||year%400==0){29}else{28},4|6|9|11=>30,1|3|5|7|8|10|12=>31,_=>return None};
 if !(2000..=2099).contains(&year)||day==0||day>max{return None;}Some(format!("{year:04}-{month:02}-{day:02}"))
}
fn discover(html:&str,at:&str)->Result<Report,String>{
 // Only the first listed bulletin: a broken current entry must not fall back to an older year.
 let block=html.split_once("<h2 class=\"headline\">").ok_or("CONAB 最新发布区缺失")?.1.split("<h2 class=\"headline\">").next().ok_or("CONAB 发布区变化")?;
 let mut reports=Vec::new();
 for fragment in block.split("href=").skip(1){let fragment=fragment.trim_start();let quote=fragment.chars().next().unwrap_or(' ');if !matches!(quote,'\''|'"'){continue;}if let Some(end)=fragment[1..].find(quote){let link=&fragment[1..end+1];if link.starts_with("https://www.gov.br/"){if let Some(r)=file_info(link){reports.push(r);}}}}
 reports.sort_by(|a,b|a.path.cmp(&b.path));reports.dedup_by(|a,b|a.path==b.path);if reports.len()!=1{return Err("CONAB 当期数据表链接缺失或不唯一".into());}let mut r=reports.remove(0);
 let heading=block.split_once("</h2>").ok_or("CONAB 报告标题缺失")?.0;
 if !heading.contains(&format!("{}º Levantamento - Safra {}",r.number,r.season)){return Err("CONAB 报告期与数据链接不符".into());}
 let published=block.split_once("class=\"documentPublished\"").ok_or("CONAB 发布日期缺失")?.1.split_once("class=\"value\">").ok_or("CONAB 发布日期格式变化")?.1.get(..10).and_then(date).ok_or("CONAB 发布日期无效")?;
 if published.get(..7)!=Some(r.month.as_str())||published.as_str()>at.get(..10).unwrap_or(""){return Err("CONAB 发布月份超前或不匹配".into());}r.published=published;Ok(r)
}
fn text(cell:Option<&Data>)->&str{match cell{Some(Data::String(s))=>s.trim(),_=>""}}
fn numeric(cell:Option<&Data>)->Result<Option<f64>,String>{
 let value=match cell{None|Some(Data::Empty)=>return Ok(None),Some(Data::String(s))if matches!(s.trim(),""|"-"|"…"|"NA")=>return Ok(None),Some(Data::Float(n))=>*n,Some(Data::Int(n))=>*n as f64,_=>return Err("CONAB 产量类型变化".into())};
 if !value.is_finite()||value<0.0{return Err("CONAB 产量数值无效".into());}Ok(Some(value))
}
fn table(range:&Range<Data>,report:&Report)->Result<Value,String>{
 if range.height()<12||range.height()>300||range.width()>40{return Err("CONAB 全国表范围变化".into());}
 let rows:Vec<_>=range.rows().collect();let locate=|label:&str|->Result<usize,String>{let hits:Vec<_>=rows.iter().enumerate().filter(|(_,r)|text(r.first())==label).map(|(i,_)|i).collect();if hits.len()!=1{return Err("CONAB 全国表列头缺失或重复".into());}Ok(hits[0])};
 let summer=locate("PRODUTO")?;let winter=locate("CULTURAS DE INVERNO")?;if winter<=summer+2{return Err("CONAB 冬季表位置变化".into());}
 let group=|header:usize|->Result<(usize,String,String),String>{
  let hits:Vec<_>=rows[header].iter().enumerate().filter(|(_,c)|text(Some(c))=="PRODUÇÃO (Em mil t)").map(|(i,_)|i).collect();if hits.len()!=1{return Err("CONAB 产量千吨单位缺失或重复".into());}let col=hits[0];let periods=rows.get(header+1).ok_or("CONAB 年度行缺失")?;
  let previous=text(periods.get(col));let current=text(periods.get(col+1));if text(periods.get(col+2))!="VAR. %"{return Err("CONAB 产量列顺序变化".into());}
  Ok((col,previous.into(),current.into()))
 };
 let(sp,sy0,sy)=group(summer)?;let(wp,wy0,wy)=group(winter)?;
 let season_year=report.season[..4].parse::<u16>().map_err(|_|"CONAB 作物年度无效")?;
 if sp!=wp||sy0!=format!("Safra {}",&report.previous_season[2..])||sy!=format!("Safra {}",&report.season[2..])||wy0!=season_year.to_string()||wy!=(season_year+1).to_string(){return Err("CONAB 表内年度与报告不符".into());}
 let month=report.month[5..].parse::<usize>().map_err(|_|"CONAB 月份无效")?;
 if !rows.iter().any(|r|text(r.first())==format!("Nota: Estimativa em {}/{}.",FULL_MONTHS[month-1],&report.month[..4]))||!rows.iter().any(|r|text(r.first())=="Fonte: Conab.")||!rows.iter().any(|r|text(r.first())=="Legenda: (1) Produção de caroço de algodão; (2) Exclui a produção de algodão em pluma"){return Err("CONAB 来源、估算月或总量范围变化".into());}
 let mut items=Vec::new();
 for (id,label,is_winter) in PRODUCTS{
  let found:Vec<_>=rows.iter().enumerate().filter(|(_,r)|text(r.first())==label).collect();if found.len()>1{return Err("CONAB 商品行重复".into());}
  let(col,period,previous_period)=if is_winter{(wp,wy.clone(),wy0.clone())}else{(sp,report.season.clone(),report.previous_season.clone())};
  let(value,previous)=if let Some((i,row))=found.first(){
   let wrong_section=if id=="total"{*i<=winter+2}else if is_winter{*i<=winter+2}else{*i<=summer+2||*i>=winter};
   if wrong_section{return Err("CONAB 商品年度区块不符".into());}(numeric(row.get(col+1))?,numeric(row.get(col))?)
  }else{(None,None)};
  items.push(json!({"id":id,"value":value,"previous":previous,"period":period,"previousPeriod":previous_period}));
 }
 if !items.iter().any(|i|i["value"].is_number()){return Err("CONAB 没有可用产量".into());}
 Ok(json!({"reportMonth":report.month,"season":report.season,"previousSeason":report.previous_season,"surveyNumber":report.number,"publishedDate":report.published,"unit":"mil t","scope":"Brasil","totalExcludes":"algodão em pluma","items":items}))
}
fn parse(bytes:&[u8],report:&Report)->Result<Value,String>{
 if bytes.len()>2*1024*1024||!bytes.starts_with(b"PK\x03\x04"){return Err("CONAB 内容不是受支持的 XLSX 数据表".into());}
 let mut workbook=Xlsx::new(Cursor::new(bytes)).map_err(|_|"CONAB 工作簿无效")?;
 let range=workbook.worksheet_range("Brasil - Total por Produto").map_err(|_|"CONAB 全国分品种工作表缺失")?;table(&range,report)
}
#[cfg(windows)]pub(crate) fn fetch(check:&impl Fn()->Result<(),String>)->Result<Value,String>{
 let(status,page)=crate::http::conab_get(PAGE,check)?;if status!=200{return Err(format!("CONAB 目录返回 HTTP {status}"));}
 let html=String::from_utf8(page).map_err(|_|"CONAB 目录编码无效")?;check()?;let(_,at)=crate::daily_recommendations::clock()?;let report=discover(&html,&at)?;
 let(status,bytes)=crate::http::conab_get(&report.path,check)?;if status!=200{return Err(format!("CONAB 表格返回 HTTP {status}"));}
 check()?;let payload=parse(&bytes,&report)?;check()?;let(_,collected)=crate::daily_recommendations::clock()?;
 Ok(json!({"key":"conab-crops","collectedAt":collected,"sourceUrl":format!("https://www.gov.br{}",report.path),"body":payload.to_string()}))
}

#[cfg(test)]mod tests{
 use super::*;
 fn link()->String{format!("https://www.gov.br{PAGE}/1o-levantamento-safra-2026-27/site_previsao_de_safra-por_produto-out-2026.xlsx")}
 fn block()->String{format!("<h2 class=\"headline\"><a>1º Levantamento - Safra 2026/27</a></h2><span class=\"documentPublished\"><span class=\"value\">15/10/2026 09h00</span></span><a href='{}'>table</a>",link())}
 fn report()->Report{discover(&block(),"2026-10-24T00:00:00Z").unwrap()}
 fn fixture()->Range<Data>{
  let mut r=Range::new((0,0),(17,9));
  for(row,label)in [(0,"PRODUTO"),(10,"CULTURAS DE INVERNO")]{r.set_value((row,0),Data::String(label.into()));r.set_value((row,7),Data::String("PRODUÇÃO (Em mil t)".into()));r.set_value((row+1,9),Data::String("VAR. %".into()));}
  for(pos,label)in [((1,7),"Safra 25/26"),((1,8),"Safra 26/27"),((11,7),"2026"),((11,8),"2027")]{r.set_value(pos,Data::String(label.into()));}
  for (i,(_,label,_))in PRODUCTS.iter().enumerate().skip(1).take(6){let row=i as u32+2;r.set_value((row,0),Data::String((*label).into()));r.set_value((row,7),Data::Float(20.0));r.set_value((row,8),Data::Float(i as f64));}
  // Winter product follows its header and marker rows, total follows the winter section.
  r.set_value((13,0),Data::String("TRIGO".into()));r.set_value((13,7),Data::Float(20.0));r.set_value((13,8),Data::Float(7.0));
  r.set_value((14,0),Data::String("BRASIL (2)".into()));r.set_value((14,7),Data::Float(20.0));r.set_value((14,8),Data::Float(0.0));
  r.set_value((15,0),Data::String("Fonte: Conab.".into()));r.set_value((16,0),Data::String("Nota: Estimativa em outubro/2026.".into()));r.set_value((17,0),Data::String("Legenda: (1) Produção de caroço de algodão; (2) Exclui a produção de algodão em pluma".into()));r
 }
 #[test]fn official_files_only_no_guessed_url_or_season(){assert!(file_path(&link()).is_some());for v in [link().replace("www.gov.br","evil.test"),link().replace("safra-2026-27","safra-2026-28"),format!("{}?key=x",link()),link().replace("-out-2026","-out-2027"),link().replace("/1o-","/01o-"),link().replace("/1o-","/13o-"),link().replace("/1o-","/../1o-"),link().replace(".xlsx",".xlsm")]{assert!(file_path(&v).is_none(),"{v}");}}
 #[test]fn first_bulletin_only_no_old_fallback(){let html=format!("<h2 class=\"headline\">current missing</h2>{}",block());assert!(discover(&html,"2026-10-24").is_err());assert!(discover(&format!("{}<a href='{}'>other</a>",block(),link().replace("-out-2026","-nov-2026")),"2026-10-24").is_err());}
 #[test]fn publication_date_is_not_page_modified_or_fetch_date(){let r=report();assert_eq!(r.published,"2026-10-15");assert_eq!(r.month,"2026-10");for html in [block().replace("15/10/2026","31/11/2026"),block().replace("15/10/2026","15/09/2026"),block().replace("1º Levantamento","2º Levantamento")]{assert!(discover(&html,"2026-10-24").is_err());}assert!(discover(&block(),"2026-10-14").is_err());}
 #[test]fn production_only_keeps_winter_year_and_excludes_lint_from_total(){let v=table(&fixture(),&report()).unwrap();assert_eq!(v["items"][0]["value"],0.0);assert_eq!(v["items"][1]["period"],"2026/27");assert_eq!(v["items"][7]["period"],"2027");assert_eq!(v["items"][7]["previousPeriod"],"2026");assert_eq!(v["unit"],"mil t");assert_eq!(v["totalExcludes"],"algodão em pluma");}
 #[test]fn missing_fields_stay_null_no_zero_or_previous_substitution(){let mut r=fixture();r.set_value((3,8),Data::Empty);let v=table(&r,&report()).unwrap();assert!(v["items"][1]["value"].is_null());assert_eq!(v["items"][1]["previous"],20.0);r.set_value((3,8),Data::String("-".into()));assert!(table(&r,&report()).unwrap()["items"][1]["value"].is_null());}
 #[test]fn unit_scope_note_year_and_bad_numbers_fail_closed(){for(pos,cell)in [((0,7),Data::String("ÁREA (Em mil ha)".into())),((1,8),Data::String("Safra 27/28".into())),((11,8),Data::String("2026".into())),((16,0),Data::String("Nota: Estimativa em setembro/2026.".into())),((17,0),Data::String("total includes lint".into())),((3,8),Data::Float(-1.0)),((3,8),Data::Error(calamine::CellErrorType::Div0)),((4,0),Data::String("SOJA".into()))]{let mut r=fixture();r.set_value(pos,cell);assert!(table(&r,&report()).is_err());}}
 #[test]fn config_missing_field_stays_off_and_fresh_default_on(){let fresh=crate::agriculture::SnapshotConnection::default();assert!(fresh.conab_enabled);let old:crate::agriculture::SnapshotConnection=serde_json::from_str(r#"{"enabled":false,"sshAlias":"","dataRoot":"","radarRoot":""}"#).unwrap();assert!(!old.conab_enabled);}
 #[cfg(windows)]#[test]fn addresses_and_cancellation_are_checked_before_network(){assert!(crate::http::conab_get("/conab/other",&||Ok(())).unwrap_err().contains("地址无效"));for path in [PAGE.to_string(),file_path(&link()).unwrap()]{assert_eq!(crate::http::conab_get(&path,&||Err("fixture cancelled".into())).unwrap_err(),"fixture cancelled");}}
 #[test]#[ignore="explicit saved-workbook offline replay only"]fn replay_saved_workbook(){let p=std::env::var_os("CONAB_REPLAY_DIR").expect("explicit replay directory");let p=std::path::Path::new(&p);let html=std::fs::read_to_string(p.join(".tmp-conab-page.html")).unwrap();let r=discover(&html,"2026-10-24T12:00:00Z").unwrap();let bytes=std::fs::read(p.join(".tmp-conab-workbook.xlsx")).unwrap();let payload=parse(&bytes,&r).unwrap();assert_eq!(payload["items"].as_array().unwrap().len(),8);assert_eq!(payload["unit"],"mil t");println!("CONAB_REPLAY:{}",payload);}
 #[cfg(windows)]#[test]#[ignore="explicit two-GET public native check only"]fn live_official_source(){assert_eq!(std::env::var("CONAB_LIVE_CHECK").as_deref(),Ok("two-public-get-requests"));println!("CONAB_RECEIPT:{}",fetch(&||Ok(())).unwrap());}
}
