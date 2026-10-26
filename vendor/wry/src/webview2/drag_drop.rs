// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

// A silly implementation of file drop handling for Windows!

use crate::DragDropEvent;
#[path = "drop_data.rs"]
mod drop_data;
use drop_data::{OwnedMedium, url_from_data};

use std::{
  cell::UnsafeCell,
  ffi::OsString,
  os::{raw::c_void, windows::ffi::OsStringExt},
  path::PathBuf,
  ptr,
  rc::Rc,
};

use windows::{
  core::{implement, BOOL},
  Win32::{
    Foundation::{DRAGDROP_E_INVALIDHWND, HWND, LPARAM, POINT, POINTL},
    Graphics::Gdi::ScreenToClient,
    System::{
      Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL},
      Ole::{
        IDropTarget, IDropTarget_Impl, OleInitialize, OleUninitialize, RegisterDragDrop, RevokeDragDrop, CF_HDROP, DROPEFFECT,
        DROPEFFECT_COPY, DROPEFFECT_NONE,
      },
      SystemServices::MODIFIERKEYS_FLAGS,
    },
    UI::{
      Shell::{DragQueryFileW, HDROP},
      WindowsAndMessaging::EnumChildWindows,
    },
  },
};

#[derive(Default)]
pub(crate) struct DragDropController {
  drop_targets: Vec<(HWND, IDropTarget)>,
  ole_initialized: bool,
  hwnd: HWND,
  parent: HWND,
  handler: Option<Rc<dyn Fn(DragDropEvent) -> bool>>,
}

impl Drop for DragDropController {
  fn drop(&mut self) {
    for (hwnd, _) in &self.drop_targets { let _ = unsafe { RevokeDragDrop(*hwnd) }; }
    if self.ole_initialized { unsafe { OleUninitialize(); } }
  }
}

impl DragDropController {
  #[inline]
  pub(crate) fn new(hwnd: HWND, parent: HWND, handler: Box<dyn Fn(DragDropEvent) -> bool>) -> Self {
    let mut controller = DragDropController::default();
    controller.hwnd = hwnd;
    controller.parent = parent;
    controller.handler = Some(Rc::new(handler));

    // CoInitializeEx alone is insufficient for RegisterDragDrop: Windows
    // reports E_OUTOFMEMORY unless this thread has initialized OLE.
    controller.ole_initialized = unsafe { OleInitialize(None) }.is_ok();
    if !controller.ole_initialized { record_drop_diagnostic("ole-init-failed", 0); return controller; }
    controller.refresh();
    controller
  }

  pub(crate) fn refresh(&mut self) {
    if !self.ole_initialized { return; }
    let Some(handler) = self.handler.clone() else { return; };
    for (target, _) in &self.drop_targets { let _ = unsafe { RevokeDragDrop(*target) }; }
    self.drop_targets.clear();
    let hwnd = self.hwnd;
    let parent = self.parent;

    // WebView2 can create/replace child HWNDs after navigation or resizing.
    // Keep the stable parent registered so OLE can fall back to it when the
    // window under the pointer does not have its own registered drop target.
    self.inject_in_hwnd(hwnd, hwnd, handler.clone());
    // A transparent, borderless host can be the hit-test target instead of
    // WRY_WEBVIEW. Codex Desktop has one WebView per host window.
    if parent != hwnd { self.inject_in_hwnd(parent, hwnd, handler.clone()); }

    // Enumerate child windows to find the WebView2 "window" and override!
    {
      let mut callback = |child| self.inject_in_hwnd(child, hwnd, handler.clone());
      let mut trait_obj: &mut dyn FnMut(HWND) -> bool = &mut callback;
      let closure_pointer_pointer: *mut c_void = unsafe { std::mem::transmute(&mut trait_obj) };
      let lparam = LPARAM(closure_pointer_pointer as _);
      unsafe extern "system" fn enumerate_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let closure = &mut *(lparam.0 as *mut c_void as *mut &mut dyn FnMut(HWND) -> bool);
        closure(hwnd).into()
      }
      let _ = unsafe { EnumChildWindows(Some(hwnd), Some(enumerate_callback), lparam) };
    }

    record_drop_diagnostic("registered", self.drop_targets.len());
  }

  #[inline]
  fn inject_in_hwnd(&mut self, hwnd: HWND, coordinate_hwnd: HWND, handler: Rc<dyn Fn(DragDropEvent) -> bool>) -> bool {
    let drag_drop_target: IDropTarget = DragDropTarget::new(coordinate_hwnd, handler).into();
    if unsafe { RevokeDragDrop(hwnd) } != Err(DRAGDROP_E_INVALIDHWND.into())
      && unsafe { RegisterDragDrop(hwnd, &drag_drop_target) }.is_ok()
    {
      self.drop_targets.push((hwnd, drag_drop_target));
    }

    true
  }
}

fn record_drop_diagnostic(phase: &str, count: usize) {
  #[cfg(debug_assertions)] {
    use std::{io::Write, sync::atomic::{AtomicUsize, Ordering}};
    static COUNT: AtomicUsize = AtomicUsize::new(0);
    if COUNT.fetch_add(1, Ordering::Relaxed) < 64 {
      let path = std::env::temp_dir().join(format!("codex-desktop-drop-{}.log", std::process::id()));
      if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{phase} count={count}");
      }
    }
  }
  #[cfg(not(debug_assertions))] { let _ = (phase, count); }
}

#[implement(IDropTarget)]
pub struct DragDropTarget {
  hwnd: HWND,
  listener: Rc<dyn Fn(DragDropEvent) -> bool>,
  cursor_effect: UnsafeCell<DROPEFFECT>,
  enter_is_valid: UnsafeCell<bool>, /* If the currently hovered item is not valid there must not be any `HoveredFileCancelled` emitted */
}

impl DragDropTarget {
  pub fn new(hwnd: HWND, listener: Rc<dyn Fn(DragDropEvent) -> bool>) -> DragDropTarget {
    Self {
      hwnd,
      listener,
      cursor_effect: DROPEFFECT_NONE.into(),
      enter_is_valid: false.into(),
    }
  }

  unsafe fn iterate_filenames<F>(
    data_obj: windows_core::Ref<'_, IDataObject>,
    mut callback: F,
  ) -> bool
  where
    F: FnMut(PathBuf),
  {
    let drop_format = FORMATETC {
      cfFormat: CF_HDROP.0,
      ptd: ptr::null_mut(),
      dwAspect: DVASPECT_CONTENT.0,
      lindex: -1,
      tymed: TYMED_HGLOBAL.0 as u32,
    };

    let Some(data) = data_obj.as_ref() else { return false; };
    match data.GetData(&drop_format) {
      Ok(medium) => {
        let medium = OwnedMedium(medium);
        if medium.0.tymed != TYMED_HGLOBAL.0 as u32 { return false; }
        let hdrop = HDROP(medium.0.u.hGlobal.0 as _);

        // The second parameter (0xFFFFFFFF) instructs the function to return the item count
        let item_count = DragQueryFileW(hdrop, 0xFFFFFFFF, None);
        if item_count == 0 || item_count > 16 { return false; }

        for i in 0..item_count {
          // Get the length of the path string NOT including the terminating null character.
          // Previously, this was using a fixed size array of MAX_PATH length, but the
          // Windows API allows longer paths under certain circumstances.
          let character_count = DragQueryFileW(hdrop, i, None) as usize;
          if character_count > 2048 { return false; }

          // Fill path_buf with the null-terminated file name
          let str_len = character_count + 1;
          let mut path_buf = vec![0; str_len];
          DragQueryFileW(hdrop, i, Some(&mut path_buf));
          callback(OsString::from_wide(&path_buf[0..character_count]).into());
        }

        true
      }
      Err(_error) => {
        #[cfg(feature = "tracing")]
        tracing::warn!(
          "{}",
          match _error.code() {
            windows::Win32::Foundation::DV_E_FORMATETC => {
              // If the dropped item is not a file this error will occur.
              // In this case it is OK to return without taking further action.
              "Error occurred while processing dropped/hovered item: item is not a file."
            }
            _ => "Unexpected error occurred while processing dropped/hovered item.",
          }
        );
        if let Some(url) = url_from_data(data) { callback(url); true } else { false }
      }
    }
  }
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for DragDropTarget_Impl {
  fn DragEnter(
    &self,
    pDataObj: windows_core::Ref<'_, IDataObject>,
    _grfKeyState: MODIFIERKEYS_FLAGS,
    pt: &POINTL,
    pdwEffect: *mut DROPEFFECT,
  ) -> windows::core::Result<()> {
    let mut pt = POINT { x: pt.x, y: pt.y };
    let _ = unsafe { ScreenToClient(self.hwnd, &mut pt) };

    let mut paths = Vec::new();
    let enter_is_valid = unsafe { DragDropTarget::iterate_filenames(pDataObj, |path| paths.push(path)) };
    record_drop_diagnostic(if enter_is_valid { "enter-valid" } else { "enter-invalid" }, paths.len());
    unsafe { *self.enter_is_valid.get() = enter_is_valid; *self.cursor_effect.get() = DROPEFFECT_NONE; *pdwEffect = DROPEFFECT_NONE; }

    if !enter_is_valid {
      return Ok(());
    };

    unsafe {
      *self.enter_is_valid.get() = enter_is_valid;
    }

    (self.listener)(DragDropEvent::Enter {
      paths,
      position: (pt.x as _, pt.y as _),
    });

    let cursor_effect = if enter_is_valid {
      DROPEFFECT_COPY
    } else {
      DROPEFFECT_NONE
    };

    unsafe {
      *pdwEffect = cursor_effect;
      *self.cursor_effect.get() = cursor_effect;
    }

    Ok(())
  }

  fn DragOver(
    &self,
    _grfKeyState: MODIFIERKEYS_FLAGS,
    pt: &POINTL,
    pdwEffect: *mut DROPEFFECT,
  ) -> windows::core::Result<()> {
    if unsafe { *self.enter_is_valid.get() } {
      let mut pt = POINT { x: pt.x, y: pt.y };
      let _ = unsafe { ScreenToClient(self.hwnd, &mut pt) };
      (self.listener)(DragDropEvent::Over {
        position: (pt.x as _, pt.y as _),
      });
    }

    unsafe { *pdwEffect = *self.cursor_effect.get() };
    Ok(())
  }

  fn DragLeave(&self) -> windows::core::Result<()> {
    if unsafe { *self.enter_is_valid.get() } {
      (self.listener)(DragDropEvent::Leave);
    }
    unsafe { *self.enter_is_valid.get() = false; *self.cursor_effect.get() = DROPEFFECT_NONE; }
    Ok(())
  }

  fn Drop(
    &self,
    pDataObj: windows_core::Ref<'_, IDataObject>,
    _grfKeyState: MODIFIERKEYS_FLAGS,
    pt: &POINTL,
    pdwEffect: *mut DROPEFFECT,
  ) -> windows::core::Result<()> {
    let entered = unsafe { *self.enter_is_valid.get() };
    unsafe { *self.enter_is_valid.get() = false; *self.cursor_effect.get() = DROPEFFECT_NONE; *pdwEffect = DROPEFFECT_NONE; }
    if entered {
      let mut pt = POINT { x: pt.x, y: pt.y };
      let _ = unsafe { ScreenToClient(self.hwnd, &mut pt) };

      let mut paths = Vec::new();
      let valid = unsafe { DragDropTarget::iterate_filenames(pDataObj, |path| paths.push(path)) };
      unsafe { *pdwEffect = if valid { DROPEFFECT_COPY } else { DROPEFFECT_NONE }; }
      if !valid { return Ok(()); }
      (self.listener)(DragDropEvent::Drop {
        paths,
        position: (pt.x as _, pt.y as _),
      });

    }
    unsafe { *self.enter_is_valid.get() = false; *self.cursor_effect.get() = DROPEFFECT_NONE; }

    Ok(())
  }
}

#[cfg(test)]
mod event_tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn stable_parent_accepts_drops_before_webview_children_exist() {
        use windows::core::w;
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
        use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_CHILD, WS_OVERLAPPED};
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            struct Apartment;
            impl Drop for Apartment { fn drop(&mut self) { unsafe { CoUninitialize(); } } }
            let _apartment = Apartment;
            let hwnd = CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("Owned drop registration test"), WS_OVERLAPPED, 0, 0, 1, 1, None, None, None, None).unwrap();
            struct OwnedWindow(HWND);
            impl Drop for OwnedWindow { fn drop(&mut self) { unsafe { let _ = RevokeDragDrop(self.0); let _ = DestroyWindow(self.0); } } }
            let _window = OwnedWindow(hwnd);
            let container = CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("Owned webview container"), WS_CHILD, 0, 0, 1, 1, Some(hwnd), None, None, None).unwrap();
            let _container = OwnedWindow(container);
            let mut controller = DragDropController::new(container, hwnd, Box::new(|_| true));
            assert_eq!(controller.drop_targets.len(), 2, "host and container must be registered before browser children exist");
            controller.refresh();
            assert_eq!(controller.drop_targets.len(), 2);
            {
                let browser = CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("Owned late browser child"), WS_CHILD, 0, 0, 1, 1, Some(container), None, None, None).unwrap();
                let _browser = OwnedWindow(browser);
                controller.refresh();
                assert_eq!(controller.drop_targets.len(), 3, "late browser children must receive a target");
            }
            controller.refresh();
            assert_eq!(controller.drop_targets.len(), 2, "destroyed child targets must not accumulate");
        }
    }
    #[test]
    fn url_drag_enter_over_drop_and_leave_reset_without_duplicate_events() {
        let events=Rc::new(RefCell::new(Vec::new()));
        let captured=events.clone();
        let target:IDropTarget=DragDropTarget::new(HWND::default(),Rc::new(move|event|{captured.borrow_mut().push(event);true})).into();
        let bytes:Vec<u8>="https://example.com/Path\0".encode_utf16().flat_map(u16::to_le_bytes).collect();
        let object=drop_data::tests::fixture_data(13,bytes);
        let point=POINTL{x:10,y:20};let keys=MODIFIERKEYS_FLAGS(0);let mut effect=DROPEFFECT_NONE;
        unsafe {
            target.DragEnter(&object,keys,point,&mut effect).unwrap();
            assert_eq!(effect,DROPEFFECT_COPY);
            target.DragOver(keys,point,&mut effect).unwrap();
            target.DragOver(keys,point,&mut effect).unwrap();
            assert_eq!(effect,DROPEFFECT_COPY);
            target.Drop(&object,keys,point,&mut effect).unwrap();
            assert_eq!(effect,DROPEFFECT_COPY);
            target.DragOver(keys,point,&mut effect).unwrap();
            assert_eq!(effect,DROPEFFECT_NONE);
        }
        let captured=events.borrow();assert_eq!(captured.len(),4);
        assert!(matches!(&captured[0],DragDropEvent::Enter{paths,..} if paths==&[PathBuf::from("https://example.com/Path")]));
        assert!(matches!(&captured[1],DragDropEvent::Over{..}));
        assert!(matches!(&captured[2],DragDropEvent::Over{..}));
        assert!(matches!(&captured[3],DragDropEvent::Drop{paths,..} if paths==&[PathBuf::from("https://example.com/Path")]));
        drop(captured);
        unsafe {
            target.DragEnter(&object,keys,point,&mut effect).unwrap();
            target.DragLeave().unwrap();
            target.DragOver(keys,point,&mut effect).unwrap();
            assert_eq!(effect,DROPEFFECT_NONE);
        }
        assert_eq!(events.borrow().len(),6);
        let invalid:Vec<u8>="javascript:alert(1)\0".encode_utf16().flat_map(u16::to_le_bytes).collect();
        let object=drop_data::tests::fixture_data(13,invalid);
        unsafe {target.DragEnter(&object,keys,point,&mut effect).unwrap();target.DragOver(keys,point,&mut effect).unwrap();target.Drop(&object,keys,point,&mut effect).unwrap();}
        assert_eq!(effect,DROPEFFECT_NONE);assert_eq!(events.borrow().len(),6);
    }
}
