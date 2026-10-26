use tauri::{AppHandle,Emitter,Webview};
use serde::Serialize;
use windows::core::{Interface,PWSTR};
use webview2_com::{CoTaskMemPWSTR,FaviconChangedEventHandler,GetFaviconCompletedHandler,SourceChangedEventHandler,Microsoft::Web::WebView2::Win32::{ICoreWebView2,ICoreWebView2_15,COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG}};

#[derive(Clone,Serialize)]#[serde(rename_all="camelCase")]
struct Metadata{id:String,registered_url:String,title:Option<String>,icon:Option<String>}
#[derive(Clone,Serialize)]#[serde(rename_all="camelCase")]
struct WebAppAddress{id:String,registered_url:String,url:String}
fn safe_source_url(value:&str)->Option<String>{
    if value.len()>4096{return None;}
    let url=tauri::Url::parse(value).ok()?;
    if !matches!(url.scheme(),"http"|"https")||url.host_str().is_none()||!url.username().is_empty()||url.password().is_some(){return None;}
    Some(url.to_string())
}
fn source_url(core:&ICoreWebView2)->Option<String>{
    let mut raw=PWSTR::null();unsafe{core.Source(&mut raw).ok()?;}
    let owned=CoTaskMemPWSTR::from(raw);if raw.is_null(){return None;}
    let value=unsafe{owned.as_ref().as_pcwstr().to_string().ok()?};
    safe_source_url(&value)
}
fn at_registered_page(core:&ICoreWebView2,registered:&str)->bool{
    source_url(core).as_deref()==Some(registered)
}
pub fn install_source_changed(view:&Webview,app:AppHandle,id:String,registered_url:String){
    let _=view.with_webview(move|platform|{
        let Ok(core)=(unsafe{platform.controller().CoreWebView2()})else{return;};
        let handler=SourceChangedEventHandler::create(Box::new(move|sender,_|{
            let Some(sender)=sender else{return Ok(());};
            let Some(url)=source_url(&sender)else{return Ok(());};
            let _=app.emit_to("dashboard","webapp-url-changed",WebAppAddress{id:id.clone(),registered_url:registered_url.clone(),url});
            Ok(())
        }));
        let mut token=0;let _=unsafe{core.add_SourceChanged(&handler,&mut token)};
    });
}
pub fn png_icon(bytes:&[u8])->Option<String>{
    if bytes.len()<24||bytes.len()>16384||bytes[..8]!=[137,80,78,71,13,10,26,10]||&bytes[12..16]!=b"IHDR"{return None;}
    let width=u32::from_be_bytes(bytes[16..20].try_into().ok()?);let height=u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    if !(1..=256).contains(&width)||!(1..=256).contains(&height){return None;}
    use base64::{Engine,engine::general_purpose::STANDARD};Some(format!("data:image/png;base64,{}",STANDARD.encode(bytes)))
}
pub fn publish_title(view:Webview,app:AppHandle,id:String,registered_url:String,title:String){
    let title=title.chars().filter(|ch|!ch.is_control()).take(180).collect::<String>();if title.trim().is_empty(){return;}
    let _=view.with_webview(move|platform|{
        let Ok(core)=(unsafe{platform.controller().CoreWebView2()})else{return;};
        if at_registered_page(&core,&registered_url){let _=app.emit_to("dashboard","webapp-metadata",Metadata{id,registered_url,title:Some(title),icon:None});}
    });
}
pub fn install_favicon(view:&Webview,app:AppHandle,id:String,registered_url:String){
    let _=view.with_webview(move|platform|{
        let Ok(core)=(unsafe{platform.controller().CoreWebView2()})else{return;};let Ok(version)=core.cast::<ICoreWebView2_15>()else{return;};
        let handler=FaviconChangedEventHandler::create(Box::new(move|sender,_|{
            let Some(sender)=sender else{return Ok(());};if !at_registered_page(&sender,&registered_url){return Ok(());}
            let Ok(version)=sender.cast::<ICoreWebView2_15>()else{return Ok(());};
            let app=app.clone();let id=id.clone();let registered_url=registered_url.clone();
            let completed=GetFaviconCompletedHandler::create(Box::new(move|result,stream|{
                if result.is_err(){return Ok(());}let Some(stream)=stream else{return Ok(());};
                let mut bytes=Vec::new();loop{
                    let mut part=[0u8;1024];let mut count=0;
                    if unsafe{stream.Read(part.as_mut_ptr().cast(),part.len() as u32,Some(&mut count))}.is_err(){return Ok(());}
                    if count==0{break;}if count as usize>part.len()||bytes.len()+count as usize>16384{return Ok(());}
                    bytes.extend_from_slice(&part[..count as usize]);
                }
                if let Some(icon)=png_icon(&bytes){let _=app.emit_to("dashboard","webapp-metadata",Metadata{id:id.clone(),registered_url:registered_url.clone(),title:None,icon:Some(icon)});}Ok(())
            }));
            let _=unsafe{version.GetFavicon(COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG,&completed)};Ok(())
        }));
        let mut token=0;let _=unsafe{version.add_FaviconChanged(&handler,&mut token)};
    });
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn address_updates_accept_only_bounded_remote_http_urls(){
  assert_eq!(safe_source_url("https://example.com/article?ref=home").as_deref(),Some("https://example.com/article?ref=home"));
  for value in ["file:///C:/secret","tauri://localhost/main.html","https://user:pass@example.com/",""]{assert!(safe_source_url(value).is_none());}
  assert!(safe_source_url(&format!("https://example.com/{}", "a".repeat(4090))).is_none());
 }
 #[test]fn favicon_png_is_bounded_and_has_small_dimensions(){
  let mut bytes=vec![0u8;24];bytes[..8].copy_from_slice(&[137,80,78,71,13,10,26,10]);bytes[12..16].copy_from_slice(b"IHDR");bytes[16..20].copy_from_slice(&32u32.to_be_bytes());bytes[20..24].copy_from_slice(&32u32.to_be_bytes());assert!(png_icon(&bytes).unwrap().starts_with("data:image/png;base64,"));
  bytes[16..20].copy_from_slice(&10000u32.to_be_bytes());assert!(png_icon(&bytes).is_none());assert!(png_icon(&vec![0;16385]).is_none());assert!(png_icon(b"<svg><script/></svg>").is_none());
 }
}
