use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}};
use tauri::{AppHandle, Manager, Webview, WebviewUrl, LogicalPosition, LogicalSize};
use tauri::webview::{WebviewBuilder, NewWindowResponse};

struct CachedView { id:String, registered_url:String, visible:Arc<AtomicBool> }
#[derive(Default)]
pub struct PoolState { covered:bool, active:Option<String>, cached:VecDeque<CachedView> }
#[derive(Default)]
pub struct WebAppPool(pub Mutex<PoolState>);
const CACHE_LIMIT:usize=2;
impl PoolState {
    fn reserve_for(&mut self, id:&str, mut close:impl FnMut(&str)->Result<(),String>)->Result<(),String> {
        while self.cached.iter().filter(|cached|cached.id!=id).count()>=CACHE_LIMIT {
            let index=self.cached.iter().position(|cached|cached.id!=id).ok_or("网页缓存状态无效")?;
            let oldest=&self.cached[index].id;
            // Keep the record when closing fails so the view remains managed.
            close(oldest)?;
            if self.active.as_deref()==Some(oldest.as_str()){self.active=None;}
            self.cached.remove(index);
        }
        Ok(())
    }
    fn remember(&mut self, cached:CachedView) {
        self.cached.retain(|previous|previous.id!=cached.id);
        self.cached.push_back(cached);
    }
}
// Called after hiding. Completion may arrive after a subsequent show, so resume
// again when visibility has changed. No callback takes the pool lock.
fn set_view_visible(view:&Webview, desired:Arc<AtomicBool>, visible:bool)->Result<(),String>{
    desired.store(visible,Ordering::SeqCst);
    if visible { view.show() } else { view.hide() }.map_err(|e|e.to_string())?;
    #[cfg(windows)]
    view.with_webview(move|platform|{
        use windows::core::Interface;
        use webview2_com::{TrySuspendCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2_3};
        let Ok(core)=(unsafe{platform.controller().CoreWebView2()})else{return;};
        let Ok(core)=core.cast::<ICoreWebView2_3>()else{return;};
        if desired.load(Ordering::SeqCst){let _=unsafe{core.Resume()};return;}
        let resume=core.clone();
        let callback=TrySuspendCompletedHandler::create(Box::new(move|result,success|{
            if result.is_err()||!success {eprintln!("Hidden webpage suspension was not confirmed");}
            if desired.load(Ordering::SeqCst){let _=unsafe{resume.Resume()};}Ok(())
        }));
        if unsafe{core.TrySuspend(&callback)}.is_err(){eprintln!("Hidden webpage suspension unavailable");}
    }).map_err(|e|e.to_string())?;
    Ok(())
}
fn close_popups(app:&AppHandle)->Result<(),String>{
    for (label,window) in app.webview_windows(){if label.starts_with("remote-popup-"){window.close().map_err(|e|e.to_string())?;}}
    Ok(())
}
#[cfg(debug_assertions)]
pub static REMOTE_DENIED:AtomicU64=AtomicU64::new(0);
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct WebAppRequest { id:String, url:String, x:f64, y:f64, width:f64, height:f64 }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct WebAppReceipt { pub id:String, pub state:String, pub url:String }

pub fn trusted_local_origin(label:&str,url:&tauri::Url,debug:bool)->bool {
    let path=match label {"main"=>"/main.html","dashboard"=>"/dashboard.html","dock"=>"/dock.html",_=>return false};
    if url.path()!=path || !url.username().is_empty() || url.password().is_some() {return false;}
    let packaged=(url.scheme()=="http" && url.host_str()==Some("tauri.localhost") && url.port().is_none()) || (url.scheme()=="tauri" && url.host_str()==Some("localhost") && url.port().is_none());
    let development=debug&&url.scheme()=="http"&&url.host_str()==Some("127.0.0.1")&&url.port()==Some(1420);
    packaged||development
}
fn remote_url(value:&str)->Result<tauri::Url,String>{
    if value.len()>4096{return Err("网址过长".into());}
    let url=tauri::Url::parse(value).map_err(|_|"网址无效")?;
    if !matches!(url.scheme(),"http"|"https")||url.host_str().is_none()||matches!(url.host_str(),Some("tauri.localhost"|"ipc.localhost"|"asset.localhost"))||!url.username().is_empty()||url.password().is_some(){return Err("仅支持无嵌入凭据的 HTTP(S) 网页".into());}
    Ok(url)
}
fn remote_navigation(url:&tauri::Url)->bool {remote_url(url.as_str()).is_ok()}
fn valid_id(id:&str)->bool {!id.is_empty()&&id.len()<=64&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-')}
fn validate_bounds(request:&WebAppRequest)->Result<(),String>{
    if ![request.x,request.y,request.width,request.height].iter().all(|n|n.is_finite()) ||request.x<0.0||request.y<0.0||request.width<100.0||request.height<100.0||request.width>10000.0||request.height>10000.0{return Err("网页显示区域无效".into());}Ok(())
}
fn mount(app:AppHandle,request:WebAppRequest)->Result<WebAppReceipt,String>{
    if !valid_id(&request.id){return Err("网页应用标识无效".into());}validate_bounds(&request)?;
    let url=remote_url(&request.url)?;
    let state=app.state::<WebAppPool>();let mut pool=state.0.lock().map_err(|_|"网页资源锁不可用")?;
    let label=format!("remote-app-{}",request.id);
    if pool.active.as_deref()!=Some(&request.id){close_popups(&app)?;}
    for cached in &pool.cached {if cached.id!=request.id {if let Some(view)=app.get_webview(&format!("remote-app-{}",cached.id)){set_view_visible(&view,cached.visible.clone(),false)?;}}}
    let previous=pool.cached.iter().find(|cached|cached.id==request.id);
    let desired=previous.map(|cached|cached.visible.clone()).unwrap_or_default();
    if previous.is_some_and(|cached|cached.registered_url!=request.url){if let Some(view)=app.get_webview(&label){view.close().map_err(|e|e.to_string())?;}}
    let reused=app.get_webview(&label).is_some();
    pool.reserve_for(&request.id,|id|{if let Some(view)=app.get_webview(&format!("remote-app-{id}")){view.close().map_err(|e|e.to_string())?;}Ok(())})?;
    let view=if let Some(view)=app.get_webview(&label){view} else {
        let dashboard=app.get_window("dashboard").ok_or("控制台窗口未打开")?;
        let profile=app.path().app_data_dir().map_err(|e|e.to_string())?.join("webapp-profiles").join(&request.id);
        std::fs::create_dir_all(&profile).map_err(|_|"无法创建独立网页配置目录")?;
        let popup_app=app.clone();
        let metadata_app=app.clone();let metadata_id=request.id.clone();let metadata_url=url.to_string();
        let builder=WebviewBuilder::new(&label,WebviewUrl::External(url.clone()))
            .data_directory(profile)
            .on_document_title_changed(move|view,title|{
                #[cfg(windows)]crate::webapp_metadata::publish_title(view,metadata_app.clone(),metadata_id.clone(),metadata_url.clone(),title);
            })
            .on_navigation(remote_navigation)
            .on_new_window(move |url,features|{
                if !remote_navigation(&url){return NewWindowResponse::Deny;}
                // Creating from the opener features shares WebView2's environment/profile.
                if popup_app.webview_windows().keys().any(|label|label.starts_with("remote-popup-")){return NewWindowResponse::Deny;}
                static SEQUENCE:AtomicU64=AtomicU64::new(1);
                let label=format!("remote-popup-{}",SEQUENCE.fetch_add(1,Ordering::Relaxed));
                match tauri::WebviewWindowBuilder::new(&popup_app,label,WebviewUrl::External("about:blank".parse().unwrap()))
                    .window_features(features).title("网页登录 / 新窗口").on_navigation(remote_navigation).build(){
                    Ok(window)=>NewWindowResponse::Create{window},Err(_)=>NewWindowResponse::Deny
                }
            });
        let view=dashboard.add_child(builder,LogicalPosition::new(request.x,request.y),LogicalSize::new(request.width,request.height)).map_err(|e|format!("无法创建网页视图：{e}"))?;
        #[cfg(windows)]{
            crate::webapp_metadata::install_source_changed(&view,app.clone(),request.id.clone(),request.url.clone());
            crate::webapp_metadata::install_favicon(&view,app.clone(),request.id.clone(),url.to_string());
        }
        view
    };
    // Track a created/reused view before fallible sizing or visibility operations.
    pool.remember(CachedView{id:request.id.clone(),registered_url:request.url.clone(),visible:desired.clone()});
    view.set_position(LogicalPosition::new(request.x,request.y)).map_err(|e|e.to_string())?;
    view.set_size(LogicalSize::new(request.width,request.height)).map_err(|e|e.to_string())?;
    set_view_visible(&view,desired.clone(),!pool.covered)?;
    pool.active=Some(request.id.clone());
    Ok(WebAppReceipt{id:request.id,state:if reused{"restored"}else{"active"}.into(),url:view.url().unwrap_or(url).to_string()})
}
#[tauri::command]
pub async fn webapp_mount(app:AppHandle,request:WebAppRequest)->Result<WebAppReceipt,String>{
    tauri::async_runtime::spawn_blocking(move||mount(app,request)).await.map_err(|_|"网页创建任务失败")?
}
#[tauri::command]
pub fn webapp_release(app:AppHandle,id:String)->Result<(),String>{
    if !valid_id(&id){return Err("应用标识无效".into());}
    let state=app.state::<WebAppPool>();let mut pool=state.0.lock().map_err(|_|"网页资源锁不可用")?;
    if let Some(cached)=pool.cached.iter().find(|cached|cached.id==id){if let Some(view)=app.get_webview(&format!("remote-app-{id}")){set_view_visible(&view,cached.visible.clone(),false)?;}}
    if pool.active.as_deref()==Some(&id){pool.active=None;close_popups(&app)?;}Ok(())
}
#[tauri::command]
pub fn webapp_discard(app:AppHandle,id:String)->Result<(),String>{
    if !valid_id(&id){return Err("应用标识无效".into());}
    let state=app.state::<WebAppPool>();let mut pool=state.0.lock().map_err(|_|"网页资源锁不可用")?;
    if let Some(view)=app.get_webview(&format!("remote-app-{id}")){view.close().map_err(|e|e.to_string())?;}
    pool.cached.retain(|cached|cached.id!=id);
    if pool.active.as_deref()==Some(&id){pool.active=None;close_popups(&app)?;}Ok(())
}
#[cfg(test)]
fn embedded_remote_label(label: &str) -> bool {
    label.strip_prefix("remote-app-").is_some_and(valid_id)
}
fn cover_views(app: AppHandle, covered: bool) -> Result<(), String> {
    let state = app.state::<WebAppPool>();
    let mut current = state.0.lock().map_err(|_| "网页资源锁不可用")?;
    current.covered = covered;
    for cached in &current.cached {
        if let Some(view)=app.get_webview(&format!("remote-app-{}",cached.id)) {
            set_view_visible(&view,cached.visible.clone(),!covered&&current.active.as_deref()==Some(&cached.id))?;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn webapp_set_covered(app: AppHandle, covered: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cover_views(app, covered)).await.map_err(|_| "网页显示调整任务失败")?
}
#[tauri::command]
pub fn webapp_navigate(app:AppHandle,id:String,url:String)->Result<(),String>{
    if !valid_id(&id){return Err("应用标识无效".into());}
    let url=remote_url(&url)?;let view:Webview=app.get_webview(&format!("remote-app-{id}")).ok_or("网页未激活")?;
    view.navigate(url).map_err(|e|e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn cached(id:&str)->CachedView {CachedView{id:id.into(),registered_url:format!("https://{id}.example/"),visible:Arc::new(AtomicBool::new(false))}}
    fn ids(pool:&PoolState)->Vec<&str> {pool.cached.iter().map(|view|view.id.as_str()).collect()}
    #[test]
    fn failed_close_keeps_cache_record_and_active_identity() {
        let mut pool=PoolState::default();pool.remember(cached("first"));pool.remember(cached("second"));pool.active=Some("first".into());
        let result=pool.reserve_for("third",|id|{assert_eq!(id,"first");Err("close failed".into())});
        assert_eq!(result,Err("close failed".into()));assert_eq!(ids(&pool),vec!["first","second"]);assert_eq!(pool.active.as_deref(),Some("first"));
    }
    #[test]
    fn third_website_evicts_only_oldest_after_success_and_reuse_is_recent() {
        let mut pool=PoolState::default();pool.remember(cached("first"));pool.remember(cached("second"));
        pool.reserve_for("first",|_|panic!("reusing a cached view must not evict")).unwrap();pool.remember(cached("first"));
        assert_eq!(ids(&pool),vec!["second","first"]);
        let mut closed=Vec::new();pool.reserve_for("third",|id|{closed.push(id.to_string());Ok(())}).unwrap();
        assert_eq!(closed,vec!["second"]);pool.remember(cached("third"));assert_eq!(ids(&pool),vec!["first","third"]);assert_eq!(pool.cached.len(),CACHE_LIMIT);
    }
    #[test]
    fn remembered_view_retains_visibility_identity_and_has_one_record() {
        let mut pool=PoolState::default();let visibility=Arc::new(AtomicBool::new(true));
        pool.remember(cached("first"));pool.remember(CachedView{id:"first".into(),registered_url:"https://new.example/".into(),visible:visibility.clone()});
        assert_eq!(ids(&pool),vec!["first"]);assert!(Arc::ptr_eq(&pool.cached[0].visible,&visibility));assert_eq!(pool.cached[0].registered_url,"https://new.example/");
    }
    #[test]
    fn notification_cover_only_targets_embedded_remote_views() {
        for label in ["main", "dashboard", "dock", "remote-popup-1", "remote-app-", "remote-app-../main"] { assert!(!embedded_remote_label(label)); }
        assert!(embedded_remote_label("remote-app-mues"));
        assert!(!WebAppPool::default().0.lock().unwrap().covered);
    }
    #[test] fn remote_views_never_gain_local_privileges(){
        for label in ["remote-app-mues","remote-popup-1","main-child","dashboard-child"]{assert!(!trusted_local_origin(label,&"http://tauri.localhost/dashboard.html".parse().unwrap(),true));}
        for url in ["https://mues.ai/dashboard.html","http://127.0.0.1:8090/dashboard.html","http://tauri.localhost.evil/dashboard.html","http://tauri.localhost/main.html"]{assert!(!trusted_local_origin("dashboard",&url.parse().unwrap(),true));}
        assert!(trusted_local_origin("dashboard",&"http://tauri.localhost/dashboard.html".parse().unwrap(),false));
        assert!(trusted_local_origin("dashboard",&"http://127.0.0.1:1420/dashboard.html".parse().unwrap(),true));
        assert!(!trusted_local_origin("dashboard",&"http://127.0.0.1:1420/dashboard.html".parse().unwrap(),false));
    }
    #[test] fn remote_navigation_and_profile_inputs_are_bounded(){
        for url in ["file:///C:/secret","tauri://localhost/main.html","javascript:alert(1)","https://user:pass@example.com/"]{assert!(remote_url(url).is_err());}
        assert!(remote_url("https://mues.ai/").is_ok());assert!(!valid_id("../main"));assert!(valid_id("mues"));
        assert!(validate_bounds(&WebAppRequest{id:"a".into(),url:"https://mues.ai".into(),x:0.0,y:0.0,width:f64::NAN,height:100.0}).is_err());
    }
}

// Debug-only real WebView2 probe. No secrets, file writes, launcher targets or external hosts.
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn webapp_security_probe(app:AppHandle)->Result<serde_json::Value,String>{
    tauri::async_runtime::spawn_blocking(move||{
        use std::{io::{Read,Write},net::TcpListener,time::{Duration,Instant},sync::mpsc};
        let state=app.state::<WebAppPool>();let _lock=state.0.lock().map_err(|_|"网页资源锁不可用")?;
        REMOTE_DENIED.store(0,Ordering::Relaxed);
        let server=TcpListener::bind("127.0.0.1:0").map_err(|_|"无法打开本机权限测试页面")?;
        let address=server.local_addr().map_err(|_|"无法读取测试端口")?;
        server.set_nonblocking(true).map_err(|_|"测试服务配置失败")?;
        let script=r#"<!doctype html><meta charset=utf-8><title>probe-loading</title><script>
        (async()=>{const commands=['runtime_status','credential_exists','open_application','storage_query'];let blocked=0,aclDenied=0,guardDenied=0,errors=[];
        if(typeof window.__TAURI_INTERNALS__?.invoke!=='function'){document.title='probe-no-ipc';return;}
        for(const command of commands){try{await Promise.race([window.__TAURI_INTERNALS__.invoke(command,{}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('probe-timeout')),1200))]);}catch(error){errors.push(String(error).slice(0,100));if(String(error)==='远程网页没有本机命令权限'){blocked++;guardDenied++;}else if(String(error)===command+' not allowed. Plugin not found'){blocked++;aclDenied++;}}}
        document.title='probe-blocked-'+blocked+'-ACL'+aclDenied+'-Guard'+guardDenied+'-'+JSON.stringify(errors);})();</script>"#;
        let worker=std::thread::spawn(move||{let started=Instant::now();while started.elapsed()<Duration::from_secs(10){match server.accept(){Ok((mut stream,_))=>{let _=stream.set_read_timeout(Some(Duration::from_secs(2)));let _=stream.set_write_timeout(Some(Duration::from_secs(2)));let mut request=[0u8;1024];let _=stream.read(&mut request);let reply=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",script.len(),script);let _=stream.write_all(reply.as_bytes());break;},Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>std::thread::sleep(Duration::from_millis(20)),Err(_)=>break}}});
        let (tx,rx)=mpsc::channel();
        let builder=WebviewBuilder::new("remote-security-probe",WebviewUrl::External(format!("http://{address}/").parse().map_err(|_|"测试网址无效")?))
            .on_navigation(remote_navigation).on_new_window(|_,_|NewWindowResponse::Deny)
            .on_document_title_changed(move|_,title|{if title.starts_with("probe-blocked-")||title=="probe-no-ipc"{let _=tx.send(title);}});
        let window=app.get_window("dashboard").ok_or("控制台未打开")?;
        let view=window.add_child(builder,LogicalPosition::new(20,200),LogicalSize::new(120,120)).map_err(|_|"权限测试视图创建失败")?;
        let _=view.show();
        let result=rx.recv_timeout(Duration::from_secs(12));let _=view.close();let _=worker.join();
        match result{Ok(title)=>Ok(serde_json::json!({"customCommands":4,"blocked":title.starts_with("probe-blocked-4-"),"result":title,"externalNetwork":false,"nativeDenied":REMOTE_DENIED.load(Ordering::Relaxed)})),Err(_)=>Err("权限测试未获得完整结果，不能视为通过".into())}
    }).await.map_err(|_|"权限测试任务失败".to_string())?
}
