use std::sync::OnceLock;

// windows-rs caches agile WinRT factories for the process lifetime. Keep the MTA
// alive for that same lifetime; uninitializing the last worker alone would leave
// those cached factories pointing at unloaded implementations.
static MTA_USAGE:OnceLock<Result<usize,String>>=OnceLock::new();
fn keep_mta_alive()->Result<(),String>{
    MTA_USAGE.get_or_init(||{
        let mut cookie=std::ptr::null_mut();
        let result=unsafe{windows_sys::Win32::System::Com::CoIncrementMTAUsage(&mut cookie)};
        if result<0||cookie.is_null(){Err("Windows运行时MTA初始化失败".into())}else{Ok(cookie as usize)}
    }).as_ref().map(|_|()).map_err(Clone::clone)
}
pub struct Apartment;
impl Apartment{
    pub fn new()->Result<Self,String>{
        keep_mta_alive()?;
        #[link(name="combase.dll",kind="raw-dylib",modifiers="+verbatim")]
        unsafe extern "system"{fn RoInitialize(kind:u32)->i32;}
        if unsafe{RoInitialize(1)}<0{return Err("Windows线程运行时初始化失败".into());}Ok(Self)
    }
}
impl Drop for Apartment{
    fn drop(&mut self){
        #[link(name="combase.dll",kind="raw-dylib",modifiers="+verbatim")]
        unsafe extern "system"{fn RoUninitialize();}
        unsafe{RoUninitialize();}
    }
}
#[cfg(test)]mod tests{use super::*;
    #[test]fn cached_socket_factories_survive_sequential_worker_lifetimes(){
        for _ in 0..12{std::thread::spawn(||{
            let _apartment=Apartment::new().unwrap();
            let socket=windows::Networking::Sockets::StreamSocket::new().unwrap();socket.Close().unwrap();
        }).join().unwrap();}
        assert!(MTA_USAGE.get().is_some_and(Result::is_ok));
    }
}
