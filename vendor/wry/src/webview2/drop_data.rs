// SPDX-License-Identifier: Apache-2.0 OR MIT
use std::{path::PathBuf, ptr};
use windows::Win32::System::{
    Com::{IDataObject, STGMEDIUM, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL},
    DataExchange::RegisterClipboardFormatW,
    Memory::{GlobalLock, GlobalSize, GlobalUnlock},
    Ole::ReleaseStgMedium,
};
#[path = "drop_url.rs"]
mod drop_url;

pub(super) struct OwnedMedium(pub(super) STGMEDIUM);
impl Drop for OwnedMedium {
    fn drop(&mut self) { unsafe { ReleaseStgMedium(&mut self.0); } }
}

pub(super) unsafe fn url_from_data(data: &IDataObject) -> Option<PathBuf> {
    let wide_name: Vec<_> = "UniformResourceLocatorW\0".encode_utf16().collect();
    let ascii_name: Vec<_> = "UniformResourceLocator\0".encode_utf16().collect();
    let formats = [(RegisterClipboardFormatW(windows::core::PCWSTR(wide_name.as_ptr())), true),
        (13, true), (RegisterClipboardFormatW(windows::core::PCWSTR(ascii_name.as_ptr())), false)];
    for (format, wide) in formats {
        if format == 0 { continue; }
        let format = FORMATETC { cfFormat: format as u16, ptd: ptr::null_mut(), dwAspect: DVASPECT_CONTENT.0, lindex: -1, tymed: TYMED_HGLOBAL.0 as u32 };
        if let Ok(medium) = data.GetData(&format) {
            let medium = OwnedMedium(medium);
            if medium.0.tymed != TYMED_HGLOBAL.0 as u32 { continue; }
            let handle = medium.0.u.hGlobal;
            let size = GlobalSize(handle);
            if size == 0 || size > 16_384 || (wide && size % 2 != 0) { continue; }
            let pointer = GlobalLock(handle);
            if pointer.is_null() { continue; }
            let result = if wide { drop_url::decode_wide_url(std::slice::from_raw_parts(pointer as *const u16, size / 2)) }
                else { drop_url::decode_ascii_url(std::slice::from_raw_parts(pointer as *const u8, size)) };
            let _ = GlobalUnlock(handle);
            if let Some(url) = result { return Some(PathBuf::from(url)); }
        }
    }
    None
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::{mem::ManuallyDrop, sync::{Arc,atomic::{AtomicUsize,Ordering}}};
    use windows::{core::{implement,BOOL,Error,HRESULT,Ref,Interface},Win32::{Foundation::{HGLOBAL,GlobalFree,DV_E_FORMATETC,E_NOTIMPL},System::{Com::{IDataObject_Impl,IAdviseSink,IEnumFORMATETC,IEnumSTATDATA,ISequentialStream,ISequentialStream_Impl,STGMEDIUM_0},Memory::{GlobalAlloc,GMEM_MOVEABLE}}}};
    #[implement(ISequentialStream)]
    struct StorageOwner { handle: HGLOBAL, released: Arc<AtomicUsize> }
    impl Drop for StorageOwner {
        fn drop(&mut self) {
            unsafe { let _=GlobalFree(Some(self.handle)); }
            self.released.fetch_add(1,Ordering::SeqCst);
        }
    }
    impl ISequentialStream_Impl for StorageOwner_Impl {
        fn Read(&self,_:*mut core::ffi::c_void,_:u32,_:*mut u32)->HRESULT{E_NOTIMPL}
        fn Write(&self,_:*const core::ffi::c_void,_:u32,_:*mut u32)->HRESULT{E_NOTIMPL}
    }
    #[implement(IDataObject)]
    struct UrlFixture { format: u16, bytes: Vec<u8>, issued: Arc<AtomicUsize>, released: Arc<AtomicUsize> }
    impl IDataObject_Impl for UrlFixture_Impl {
        fn GetData(&self, format: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
            if format.is_null() || unsafe { (*format).cfFormat } != self.format { return Err(Error::from_hresult(DV_E_FORMATETC)); }
            unsafe {
                let handle=GlobalAlloc(GMEM_MOVEABLE,self.bytes.len())?;
                let pointer=GlobalLock(handle);assert!(!pointer.is_null());
                ptr::copy_nonoverlapping(self.bytes.as_ptr(),pointer as *mut u8,self.bytes.len());
                let _=GlobalUnlock(handle);
                let owner:ISequentialStream=StorageOwner{handle,released:self.released.clone()}.into(); self.issued.fetch_add(1,Ordering::SeqCst);
                Ok(STGMEDIUM {tymed:TYMED_HGLOBAL.0 as u32,u:STGMEDIUM_0{hGlobal:handle},pUnkForRelease:ManuallyDrop::new(Some(owner.cast()?))})
            }
        }
        fn GetDataHere(&self,_:*const FORMATETC,_:*mut STGMEDIUM)->windows::core::Result<()>{Err(Error::from_hresult(E_NOTIMPL))}
        fn QueryGetData(&self,_:*const FORMATETC)->HRESULT{E_NOTIMPL}
        fn GetCanonicalFormatEtc(&self,_:*const FORMATETC,_:*mut FORMATETC)->HRESULT{E_NOTIMPL}
        fn SetData(&self,_:*const FORMATETC,_:*const STGMEDIUM,_:BOOL)->windows::core::Result<()>{Err(Error::from_hresult(E_NOTIMPL))}
        fn EnumFormatEtc(&self,_:u32)->windows::core::Result<IEnumFORMATETC>{Err(Error::from_hresult(E_NOTIMPL))}
        fn DAdvise(&self,_:*const FORMATETC,_:u32,_:Ref<IAdviseSink>)->windows::core::Result<u32>{Err(Error::from_hresult(E_NOTIMPL))}
        fn DUnadvise(&self,_:u32)->windows::core::Result<()>{Err(Error::from_hresult(E_NOTIMPL))}
        fn EnumDAdvise(&self)->windows::core::Result<IEnumSTATDATA>{Err(Error::from_hresult(E_NOTIMPL))}
    }
    pub(crate) fn fixture_data(format:u16,bytes:Vec<u8>)->IDataObject { UrlFixture { format,bytes,issued:Arc::new(AtomicUsize::new(0)),released:Arc::new(AtomicUsize::new(0)) }.into() }
    fn inspect_fixture(format:u16,bytes:Vec<u8>)->Option<PathBuf>{
        let issued=Arc::new(AtomicUsize::new(0));let released=Arc::new(AtomicUsize::new(0));
        let object:IDataObject=UrlFixture{format,bytes,issued:issued.clone(),released:released.clone()}.into();
        let result=unsafe {url_from_data(&object)};
        assert!(issued.load(Ordering::SeqCst)>0); assert_eq!(released.load(Ordering::SeqCst),issued.load(Ordering::SeqCst),"every STGMEDIUM must invoke its release owner exactly once");
        result
    }
    #[test]
    fn native_url_data_object_formats_decode_and_release_owned_storage(){
        let wide:Vec<u8>="https://example.com/Path\0".encode_utf16().flat_map(u16::to_le_bytes).collect();
        let wide_format:Vec<_>="UniformResourceLocatorW\0".encode_utf16().collect();
        let ascii_format:Vec<_>="UniformResourceLocator\0".encode_utf16().collect();
        for format in [13,unsafe {RegisterClipboardFormatW(windows::core::PCWSTR(wide_format.as_ptr()))} as u16]{
            assert_eq!(inspect_fixture(format,wide.clone()),Some(PathBuf::from("https://example.com/Path")));
        }
        let ascii=unsafe {RegisterClipboardFormatW(windows::core::PCWSTR(ascii_format.as_ptr()))} as u16;
        assert_eq!(inspect_fixture(ascii,b"http://example.com/\0".to_vec()),Some(PathBuf::from("http://example.com/")));
        let bad:Vec<u8>="javascript:alert(1)\0".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert!(inspect_fixture(13,bad).is_none());
        assert!(inspect_fixture(13,vec![b'x';18_000]).is_none());
    }
}
