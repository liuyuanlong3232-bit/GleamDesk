use base64::{Engine,engine::general_purpose::{STANDARD,URL_SAFE_NO_PAD,URL_SAFE}};
use serde_json::Value;

pub fn html_text(html:&str)->String{
    let lower=html.to_ascii_lowercase();let mut output=String::new();let mut offset=0;
    while offset<html.len(){
        if lower[offset..].starts_with("<script")||lower[offset..].starts_with("<style"){
            let end_tag=if lower[offset..].starts_with("<script"){"</script>"}else{"</style>"};
            if let Some(end)=lower[offset..].find(end_tag){offset+=end+end_tag.len();continue;}break;
        }
        if html.as_bytes()[offset]==b'<'{if let Some(end)=html[offset..].find('>'){let tag=&lower[offset+1..offset+end];if tag.starts_with("br")||tag.starts_with("/p")||tag.starts_with("/div")||tag.starts_with("/li"){output.push('\n');}offset+=end+1;continue;}}
        let ch=html[offset..].chars().next().unwrap();output.push(ch);offset+=ch.len_utf8();if output.len()>128*1024{break;}
    }
    output.replace("&nbsp;"," ").replace("&lt;","<").replace("&gt;",">").replace("&quot;","\"").replace("&#39;","'").replace("&amp;","&")
}
fn b64(value:&str)->Option<Vec<u8>>{URL_SAFE_NO_PAD.decode(value).or_else(|_|URL_SAFE.decode(value)).or_else(|_|STANDARD.decode(value)).ok()}
pub fn decode_bytes(bytes:&[u8],charset:&str)->Result<String,String>{
    if bytes.len()>256*1024{return Err("邮件文本超过解码上限".into());}if bytes.is_empty(){return Ok(String::new());}
    let charset=charset.trim().trim_matches('"').to_ascii_lowercase();
    match charset.as_str(){
        ""|"utf-8"|"utf8"=>String::from_utf8(bytes.to_vec()).map_err(|_|"邮件UTF-8内容不完整或无效，请在网页邮箱查看".into()),
        "us-ascii"|"ascii"=>{if bytes.is_ascii(){Ok(String::from_utf8(bytes.to_vec()).unwrap())}else{Err("邮件ASCII编码声明与内容不符".into())}},
        "iso-8859-1"|"latin1"=>Ok(bytes.iter().copied().map(char::from).collect()),
        "gbk"|"gb2312"|"gb18030"|"big5"|"windows-1252"=>{
            let code=match charset.as_str(){"gb18030"=>54936,"big5"=>950,"windows-1252"=>1252,_=>936};
            #[link(name="kernel32")]unsafe extern "system"{fn MultiByteToWideChar(code:u32,flags:u32,input:*const u8,length:i32,output:*mut u16,capacity:i32)->i32;}
            let size=unsafe{MultiByteToWideChar(code,8,bytes.as_ptr(),bytes.len() as i32,std::ptr::null_mut(),0)};
            if size<=0{return Err("邮件字符编码无效，未用乱码替代原文".into());}
            let mut output=vec![0u16;size as usize];let written=unsafe{MultiByteToWideChar(code,8,bytes.as_ptr(),bytes.len() as i32,output.as_mut_ptr(),size)};
            if written!=size{return Err("邮件字符解码失败".into());}String::from_utf16(&output).map_err(|_|"邮件字符内容无效".into())
        },_=>Err(format!("邮件字符集尚未支持：{}；请在网页邮箱查看",charset.chars().take(40).collect::<String>())),
    }
}
fn header_value(headers:&str,name:&str)->Option<String>{
    let mut found=false;let mut value=String::new();
    for line in headers.lines(){
        if line.starts_with([' ','\t']){if found{value.push(' ');value.push_str(line.trim());}continue;}
        if found{break;}if let Some((key,text))=line.split_once(':'){if key.eq_ignore_ascii_case(name){found=true;value=text.trim().to_owned();}}
    }
    found.then_some(value)
}
fn parameter(value:&str,name:&str)->Option<String>{value.split(';').skip(1).find_map(|part|part.trim().split_once('=').filter(|(key,_)|key.eq_ignore_ascii_case(name)).map(|(_,value)|value.trim().trim_matches('"').to_owned()))}
fn quoted_printable(input:&[u8])->Vec<u8>{
    let mut output=Vec::new();let mut i=0;while i<input.len(){if input[i]==b'='{
        if input.get(i+1)==Some(&b'\r')&&input.get(i+2)==Some(&b'\n'){i+=3;continue;}if input.get(i+1)==Some(&b'\n'){i+=2;continue;}
        if i+2<input.len(){if let Ok(value)=u8::from_str_radix(&String::from_utf8_lossy(&input[i+1..i+3]),16){output.push(value);i+=3;continue;}}
    }output.push(input[i]);i+=1;}output
}
fn decode_transfer(body:&[u8],encoding:&str)->Result<Vec<u8>,String>{
    match encoding.trim().to_ascii_lowercase().as_str(){"base64"=>STANDARD.decode(body.iter().copied().filter(|byte|!byte.is_ascii_whitespace()).collect::<Vec<_>>()).map_err(|_|"邮件Base64内容无效".into()),"quoted-printable"=>Ok(quoted_printable(body)),""|"7bit"|"8bit"|"binary"=>Ok(body.to_vec()),_=>Err("邮件传输编码尚未支持".into())}
}
fn split_sections<'a>(body:&'a[u8],boundary:&[u8])->Vec<&'a[u8]>{
    let mut out=Vec::new();let mut rest=body;
    while out.len()<31{let Some(start)=rest.windows(boundary.len()).position(|part|part==boundary)else{break;};rest=&rest[start+boundary.len()..];let end=rest.windows(boundary.len()).position(|part|part==boundary).unwrap_or(rest.len());out.push(&rest[..end]);}
    out
}
pub fn mime_bytes(headers:&str,body:&[u8])->Result<String,String>{
    fn part(headers:&str,body:&[u8],depth:usize,plain:&mut Vec<String>,html:&mut Vec<String>,errors:&mut Vec<String>){
        if depth>6{return;}if header_value(headers,"content-disposition").is_some_and(|value|value.to_ascii_lowercase().starts_with("attachment")){return;}
        let content=header_value(headers,"content-type").unwrap_or_else(||"text/plain".into());let kind=content.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        if kind.starts_with("multipart/"){
            if let Some(boundary)=parameter(&content,"boundary").filter(|value|!value.is_empty()&&value.len()<200){
                let marker=format!("--{boundary}");for section in split_sections(body,marker.as_bytes()).into_iter().take(30){
                    if section.starts_with(b"--"){break;}let section=if section.starts_with(b"\r\n"){&section[2..]}else if section.starts_with(b"\n"){&section[1..]}else{section};
                    let separator=section.windows(4).position(|part|part==b"\r\n\r\n").map(|index|(index,4)).or_else(||section.windows(2).position(|part|part==b"\n\n").map(|index|(index,2)));
                    if let Some((index,width))=separator{if let Ok(headers)=std::str::from_utf8(&section[..index]){let mut content=&section[index+width..];if content.ends_with(b"\r\n"){content=&content[..content.len()-2];}part(headers,content,depth+1,plain,html,errors);}}
                }
            }return;
        }
        if kind!="text/plain"&&kind!="text/html"{return;}
        let decoded=decode_transfer(body,&header_value(headers,"content-transfer-encoding").unwrap_or_default()).and_then(|bytes|decode_bytes(&bytes,&parameter(&content,"charset").unwrap_or_default()));
        match decoded{Ok(text)=>{if kind=="text/plain"{plain.push(text);}else{html.push(html_text(&text));}},Err(error)=>errors.push(error)}
    }
    if body.len()>256*1024{return Err("邮件正文超过读取上限".into());}
    let mut plain=Vec::new();let mut html=Vec::new();let mut errors=Vec::new();part(headers,body,0,&mut plain,&mut html,&mut errors);
    let output=if plain.is_empty(){html.join("\n")}else{plain.join("\n")};if output.trim().is_empty(){Err(errors.into_iter().next().unwrap_or_else(||"正文格式尚未支持，请在网页邮箱查看".into()))}else{Ok(output.chars().take(64000).collect())}
}
pub fn gmail_body(payload:&Value)->Result<(String,bool),String>{
    fn collect(value:&Value,plain:&mut Vec<String>,html:&mut Vec<String>,errors:&mut Vec<String>,depth:usize){
        if depth>8||value["filename"].as_str().is_some_and(|name|!name.is_empty()){return;}
        let mime=value["mimeType"].as_str().unwrap_or("");
        let headers=value["headers"].as_array().map(|items|items.iter().filter_map(|item|Some(format!("{}: {}",item["name"].as_str()?,item["value"].as_str()?))).collect::<Vec<_>>().join("\r\n")).unwrap_or_default();
        let content=header_value(&headers,"content-type").unwrap_or_else(||mime.into());
        if header_value(&headers,"content-disposition").is_some_and(|value|value.to_ascii_lowercase().starts_with("attachment")){return;}
        if let Some(data)=value.pointer("/body/data").and_then(Value::as_str).filter(|data|data.len()<256*1024){if let Some(bytes)=b64(data){match decode_bytes(&bytes,&parameter(&content,"charset").unwrap_or_default()){Ok(text)=>{if mime=="text/plain"{plain.push(text);}else if mime=="text/html"{html.push(html_text(&text));}},Err(error)=>errors.push(error)}}}
        if mime.starts_with("multipart/"){if let Some(parts)=value["parts"].as_array(){for child in parts.iter().take(40){collect(child,plain,html,errors,depth+1);}}}
    }
    let mut plain=Vec::new();let mut html=Vec::new();let mut errors=Vec::new();collect(payload,&mut plain,&mut html,&mut errors,0);
    let body=if plain.is_empty(){html.join("\n")}else{plain.join("\n")};if body.is_empty(){return Err(errors.into_iter().next().unwrap_or_else(||"此邮件正文不可用；请在网页邮箱查看加密内容或附件".into()));}
    let truncated=body.chars().count()>64000;Ok((body.chars().take(64000).collect(),truncated))
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn html_preview_never_keeps_active_content(){assert_eq!(html_text("<p>hello</p><script>alert(1)</script><img src='https://track.test/'>"),"hello\n");}
 #[test]fn mime_prefers_text_and_decodes_transfers(){let body=b"--x\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--x--\r\n";assert_eq!(mime_bytes("Content-Type: multipart/mixed; boundary=\"x\"",body).unwrap(),"hello");let payload=serde_json::json!({"mimeType":"text/plain","body":{"data":"aGVsbG8"}});assert_eq!(gmail_body(&payload).unwrap().0,"hello");}
 #[test]fn chinese_bytes_remain_intact_until_charset_decode(){let gbk=[0xc4,0xe3,0xba,0xc3];assert_eq!(decode_bytes(&gbk,"gb2312").unwrap(),"你好");assert_eq!(decode_bytes(&gbk,"gb18030").unwrap(),"你好");assert_eq!(mime_bytes("Content-Type: text/plain; charset=GBK",&gbk).unwrap(),"你好");assert_eq!(mime_bytes("Content-Type: text/plain; charset=GBK\r\nContent-Transfer-Encoding: quoted-printable",b"=C4=E3=BA=C3").unwrap(),"你好");assert!(decode_bytes(&gbk,"utf-8").is_err());assert!(decode_bytes(b"x","unsupported").is_err());}
 #[test]fn folded_headers_and_text_attachments_do_not_become_body(){let body=b"--x\r\nContent-Type: text/plain; charset=GBK\r\n\r\n\xc4\xe3\xba\xc3\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=a.txt\r\n\r\nSECRET_ATTACHMENT\r\n--x--\r\n";assert_eq!(mime_bytes("Content-Type: multipart/mixed;\r\n boundary=\"x\"",body).unwrap(),"你好");}
 #[test]fn gmail_declared_charset_is_used_and_attachments_are_excluded(){let payload=serde_json::json!({"mimeType":"multipart/mixed","parts":[{"mimeType":"text/plain","headers":[{"name":"Content-Type","value":"text/plain; charset=GBK"}],"body":{"data":URL_SAFE_NO_PAD.encode([0xc4,0xe3,0xba,0xc3])}},{"mimeType":"text/plain","filename":"secret.txt","body":{"data":"U0VDUkVU"}}]});assert_eq!(gmail_body(&payload).unwrap().0,"你好");}
}
