use serde_json::{json,Value};
use tauri::{AppHandle,Manager,Webview,WebviewUrl,WebviewWindowBuilder};
use std::{fs,sync::mpsc,time::Duration};
const SCRIPT:&str=r#"(()=>{
  const visible=el=>el&&el.nodeType===1&&el.getClientRects().length>0&&el.ownerDocument.defaultView.getComputedStyle(el).visibility!=="hidden";
  const documents=[document];
  for(const frame of [...document.querySelectorAll('iframe')].slice(0,12)){
    try{
      if(!visible(frame))continue;
      const doc=frame.contentDocument,url=doc&&new URL(doc.URL);
      if(doc&&url.protocol==='https:'&&url.hostname==='www.doubao.com'&&url.pathname==='/member/quota-management')documents.push(doc);
    }catch{/* Cross-origin frames are deliberately excluded. */}
  }
  // Only the official subscription-management panel, never the surrounding chat or sales page.
  const anchors=documents.flatMap(doc=>[...doc.querySelectorAll('h1,h2,h3,h4,p,span,div')]).filter(el=>visible(el)&&(el.innerText||'').trim()==='订阅与额度管理');
  let panel=null;
  for(const anchor of anchors){
    for(let el=anchor.parentElement,depth=0;el&&el!==anchor.ownerDocument.body&&depth<9;el=el.parentElement,depth++){
      const text=el.innerText||'';
      if(text.length>8000)break;
      if(/当前时段/.test(text)&&/近\s*7\s*天/.test(text)&&/已用/.test(text)&&/订阅记录/.test(text)){panel=el;break;}
    }
    if(panel)break;
  }
  if(!panel||panel.querySelector('input[type="password"]'))return {available:false,readIssue:"panel-not-found"};
  const lines=(panel.innerText||'').split('\n').map(s=>s.trim()).filter(Boolean);
  const plan=lines.find(s=>/^(标准|专业|高级|基础|免费|旗舰|尊享)(套餐|版|会员)$/.test(s))||null;
  const expiry=lines.find(s=>s.length<=100&&/免费体验至|到期|有效期|会员期限/.test(s)&&/\d{1,4}[年月\/-]\d{1,2}/.test(s))||null;
  const benefits=[];
  for(const label of ['当前时段','近7天']){
    const index=lines.findIndex(s=>s.replace(/\s/g,'')===label);
    if(index<0)continue;
    const parts=[];
    for(let i=index+1;i<Math.min(index+7,lines.length);i++){
      if(/^(当前时段|近\s*7\s*天|订阅记录)$/.test(lines[i]))break;
      if(/^(?:已用|已使用)\s*[<＜]?\s*\d+(?:\.\d+)?\s*%$/.test(lines[i])||(/重置/.test(lines[i])&&lines[i].length<=70))parts.push(lines[i]);
    }
    if(parts.some(s=>/已用|已使用/.test(s)))benefits.push({label,detail:label+' · '+parts.join(' · ')});
  }
  if(!plan||benefits.length!==2)return {available:false,readIssue:"fields-not-found"};
  return {available:true,planName:plan,expiryText:expiry,benefits};
})()"#;

fn path(app:&AppHandle)->Result<std::path::PathBuf,String>{let folder=app.path().app_data_dir().map_err(|_|"会员缓存目录不可用")?;fs::create_dir_all(&folder).map_err(|_|"会员缓存目录不可写")?;Ok(folder.join("doubao-membership.json"))}
pub(crate) fn snapshot(app:&AppHandle,refresh:bool)->Value{
    let cached=path(app).ok().and_then(|path|fs::metadata(&path).ok().filter(|meta|meta.len()<=16384).and_then(|_|fs::read(&path).ok())).and_then(|bytes|serde_json::from_slice::<Value>(&bytes).ok());
    let unavailable=|reason:&str|{let mut value=cached.clone().unwrap_or(json!({"available":false}));value["cached"]=json!(true);value["readIssue"]=json!(reason);value};
    if !refresh{return unavailable("cached-only");}
    #[cfg(windows)]{
        let Some(view)=app.get_webview_window("doubao-membership")else{return unavailable("window-not-ready");};
        let Ok(url)=view.url()else{return unavailable("window-not-ready");};
        if url.scheme()!="https"||!matches!(url.host_str(),Some("www.doubao.com"|"doubao.com")){return unavailable("official-page-required");}
        let(sender,receiver)=mpsc::sync_channel(1);
        let dispatched=view.with_webview(move|platform|{
            let Ok(core)=(unsafe{platform.controller().CoreWebView2()})else{return;};
            let handler=webview2_com::ExecuteScriptCompletedHandler::create(Box::new(move|result,value|{
                if result.is_ok(){let _=sender.send(value);}Ok(())
            }));
            let _=unsafe{core.ExecuteScript(&windows::core::HSTRING::from(SCRIPT),&handler)};
        });
        if dispatched.is_err(){return unavailable("script-dispatch-failed");}
        let Ok(text)=receiver.recv_timeout(Duration::from_secs(3))else{return unavailable("script-timeout");};
        if text.len()>16384{return unavailable("script-result-invalid");}
        let Ok(raw)=serde_json::from_str::<Value>(&text)else{return unavailable("script-result-invalid");};
        if raw["available"]!=true{return unavailable(match raw["readIssue"].as_str(){Some("panel-not-found")=>"panel-not-found",Some("fields-not-found")=>"fields-not-found",_=>"script-result-invalid"});}
        let safe_text=|value:&Value,max:usize|value.as_str().filter(|text|!text.chars().any(char::is_control)&&text.chars().count()<=max).map(str::to_owned);
        let benefits:Vec<_>=raw["benefits"].as_array().into_iter().flatten().take(8).filter_map(|row|Some(json!({"label":safe_text(&row["label"],40)?,"detail":safe_text(&row["detail"],150)?}))).collect();
        let value=json!({"available":true,"source":"doubao-member-page","planName":safe_text(&raw["planName"],32),"expiryText":safe_text(&raw["expiryText"],100),"benefits":benefits,"observedAtUnixMs":crate::provider_requests::observed_unix_ms(),"cached":false});
        if let Ok(path)=path(app){let temporary=path.with_extension("json.tmp");if let Ok(bytes)=serde_json::to_vec(&value){if fs::write(&temporary,bytes).is_ok(){let _=fs::rename(temporary,path);}}}
        value
    }
    #[cfg(not(windows))]{unavailable("unsupported-platform")}
}
#[tauri::command]
pub async fn doubao_membership_open(app:AppHandle,view:Webview)->Result<(),String>{
    if view.label()!="dashboard"{return Err("请从工作台设置连接豆包会员".into());}
    let url=tauri::Url::parse("https://www.doubao.com/member/quota-management?quota_tab=personal&is_setting_iframe=1&theme=light").map_err(|_|"豆包官方地址无效")?;
    if let Some(window)=app.get_webview_window("doubao-membership"){window.navigate(url).map_err(|_|"会员页面无法打开")?;window.show().map_err(|_|"会员窗口无法显示")?;return window.set_focus().map_err(|_|"会员窗口无法聚焦".into());}
    let profile=app.path().app_data_dir().map_err(|_|"会员窗口配置不可用")?.join("doubao-member-profile");fs::create_dir_all(&profile).map_err(|_|"会员窗口配置无法创建")?;
    WebviewWindowBuilder::new(&app,"doubao-membership",WebviewUrl::External(url)).title("豆包官方会员 · 订阅与额度管理").inner_size(1080.,760.).data_directory(profile).on_navigation(|url|url.scheme()=="https"&&url.host_str().is_some_and(|host|host=="doubao.com"||host.ends_with(".doubao.com")||host.ends_with(".bytedance.com")||host.ends_with(".douyin.com"))).build().map_err(|_|"豆包会员窗口无法创建")?;
    Ok(())
}
#[tauri::command]
pub async fn read_doubao_membership(app:AppHandle,view:Webview)->Result<Value,String>{
    if view.label()!="dashboard"{return Err("请从工作台读取豆包会员".into());}
    tauri::async_runtime::spawn_blocking(move||Ok(snapshot(&app,true))).await.map_err(|_|"豆包会员读取任务失败".to_string())?
}
