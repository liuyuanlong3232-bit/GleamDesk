use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, Window};

pub(crate) fn install_borderless_guard(window: &Window) -> Result<(), String> {
    if !matches!(window.label(), "main" | "dock") { return Ok(()); }
    #[cfg(windows)]
    unsafe { native_borderless::install(window.hwnd().map_err(|error| error.to_string())?.0) }
    #[cfg(not(windows))]
    { Ok(()) }
}

pub(crate) fn install_passthrough_escape(window: &Window) -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        let main = window.clone();
        native_borderless::install_escape(window.hwnd().map_err(|error| error.to_string())?.0, Box::new(move || {
            // Disable natively first, even if the webview has no keyboard focus.
            match main.set_ignore_cursor_events(false) {
                Ok(()) => for label in ["main", "dashboard"] {
                    if let Err(error) = main.app_handle().emit_to(label, "mouse-passthrough-disabled", ()) { eprintln!("{error}"); }
                },
                Err(error) => eprintln!("无法退出鼠标穿透：{error}"),
            }
        }))
    }
    #[cfg(not(windows))]
    { let _ = window; Ok(()) }
}

#[cfg(windows)]
mod native_borderless {
    use std::cell::Cell;
    use windows_sys::Win32::{Foundation::{HWND, LPARAM, LRESULT, WPARAM, GetLastError, SetLastError},
        UI::WindowsAndMessaging::*};
    type SubclassProc = unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM, usize, usize) -> LRESULT;
    #[link(name = "comctl32")]
    unsafe extern "system" {
        fn SetWindowSubclass(hwnd: HWND, callback: SubclassProc, id: usize, data: usize) -> i32;
        fn RemoveWindowSubclass(hwnd: HWND, callback: SubclassProc, id: usize) -> i32;
        fn DefSubclassProc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT;
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn RegisterHotKey(hwnd: HWND, id: i32, modifiers: u32, key: u32) -> i32;
        fn UnregisterHotKey(hwnd: HWND, id: i32) -> i32;
    }
    const GUARD_ID: usize = 0x43444247;
    const ESCAPE_ID: usize = 0x43445045;
    const ESCAPE_HOTKEY: i32 = 0x4344;
    const ESCAPE_MODIFIERS: u32 = 0x0002 | 0x0004 | 0x4000; // Ctrl + Shift, no autorepeat.
    // Unit tests use F24 so an open application need not release its Space hotkey.
    const ESCAPE_KEY: u32 = if cfg!(test) { 0x87 } else { 0x20 };
    struct EscapeContext { on_escape: Box<dyn Fn()> }

    unsafe extern "system" fn escape_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, _: usize, data: usize) -> LRESULT {
        if message == WM_HOTKEY && wparam == ESCAPE_HOTKEY as usize {
            (&*(data as *const EscapeContext)).on_escape.as_ref()();
            return 0;
        }
        if message == WM_NCDESTROY {
            UnregisterHotKey(hwnd, ESCAPE_HOTKEY);
            RemoveWindowSubclass(hwnd, escape_proc, ESCAPE_ID);
            drop(Box::from_raw(data as *mut EscapeContext));
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    pub(super) unsafe fn install_escape(hwnd: HWND, on_escape: Box<dyn Fn()>) -> Result<(), String> {
        // Called from Tauri setup on the window's owning UI thread.
        // RegisterHotKey does not change any persistent Windows setting.
        if RegisterHotKey(hwnd, ESCAPE_HOTKEY, ESCAPE_MODIFIERS, ESCAPE_KEY) == 0 {
            return Err(format!("Ctrl + Shift + Space 无法注册（可能被其他程序占用，Windows错误 {}）；请在设置中关闭穿透", GetLastError()));
        }
        let context = Box::into_raw(Box::new(EscapeContext { on_escape }));
        if SetWindowSubclass(hwnd, escape_proc, ESCAPE_ID, context as usize) == 0 {
            UnregisterHotKey(hwnd, ESCAPE_HOTKEY);
            drop(Box::from_raw(context));
            return Err("无法安装鼠标穿透退出键；请在设置中关闭穿透".into());
        }
        Ok(())
    }
    const FRAME: u32 = WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
    const EX_FRAME: u32 = WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_DLGMODALFRAME | WS_EX_STATICEDGE;
    thread_local! { static UPDATING: Cell<bool> = const { Cell::new(false) }; }
    struct Updating;
    impl Drop for Updating { fn drop(&mut self) { UPDATING.with(|flag| flag.set(false)); } }
    fn clean(index: i32, value: u32) -> u32 {
        match index { GWL_STYLE => value & !FRAME, GWL_EXSTYLE => value & !EX_FRAME, _ => value }
    }
    unsafe fn write_style(hwnd: HWND, index: i32, value: u32) -> Result<(), String> {
        SetLastError(0);
        if SetWindowLongPtrW(hwnd, index, value as isize) == 0 && GetLastError() != 0 {
            return Err("无法清除透明窗口原生边框".into());
        }
        Ok(())
    }
    unsafe fn enforce(hwnd: HWND) -> Result<(), String> {
        if IsWindow(hwnd) == 0 || UPDATING.with(|flag| flag.replace(true)) { return Ok(()); }
        let _updating = Updating;
        let mut changed = false;
        for index in [GWL_STYLE, GWL_EXSTYLE] {
            let current = GetWindowLongPtrW(hwnd, index) as u32;
            let next = clean(index, current);
            if current != next { write_style(hwnd, index, next)?; changed = true; }
        }
        if changed && SetWindowPos(hwnd, std::ptr::null_mut(), 0, 0, 0, 0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE) == 0 {
            return Err("无法刷新透明窗口原生边框".into());
        }
        Ok(())
    }
    unsafe extern "system" fn guard(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, _: usize, _: usize) -> LRESULT {
        if message == WM_STYLECHANGING && lparam != 0 {
            // Filter Tao's proposed styles before they reach Windows, without
            // touching layered/transparent/visibility/activation/Z-order bits.
            let styles = &mut *(lparam as *mut STYLESTRUCT);
            styles.styleNew = clean(wparam as i32, styles.styleNew);
        }
        if message == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, guard, GUARD_ID);
            return DefSubclassProc(hwnd, message, wparam, lparam);
        }
        // Main and Dock have no non-client UI. Do not draw classic frames.
        if matches!(message, WM_NCPAINT | WM_NCCALCSIZE) { return 0; }
        // Keep Tao's activation/focus bookkeeping, but suppress DefWindowProc's
        // non-client repaint (documented WM_NCACTIVATE lParam=-1).
        let forwarded = if message == WM_NCACTIVATE { -1 } else { lparam };
        let result = DefSubclassProc(hwnd, message, wparam, forwarded);
        if matches!(message, WM_STYLECHANGED | WM_SHOWWINDOW | WM_WINDOWPOSCHANGED | WM_NCACTIVATE | WM_THEMECHANGED | WM_DWMCOMPOSITIONCHANGED) {
            if let Err(error) = enforce(hwnd) { eprintln!("{error}"); }
        }
        result
    }
    pub(super) unsafe fn install(hwnd: HWND) -> Result<(), String> {
        if SetWindowSubclass(hwnd, guard, GUARD_ID, 0) == 0 {
            return Err("无法安装主屏无边框保护".into());
        }
        if let Err(error) = enforce(hwnd) {
            RemoveWindowSubclass(hwnd, guard, GUARD_ID);
            return Err(error);
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        fn assert_borderless(hwnd: HWND) {
            unsafe {
                assert_eq!(GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 & FRAME, 0);
                assert_eq!(GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & EX_FRAME, 0);
            }
        }
        #[test]
        fn global_escape_handles_only_its_hotkey_and_unregisters_on_destroy() {
            use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
            let calls = Arc::new(AtomicUsize::new(0));
            let class: Vec<u16> = "STATIC".encode_utf16().chain(Some(0)).collect();
            unsafe {
                let hwnd = CreateWindowExW(0, class.as_ptr(), std::ptr::null(), 0, -32000, -32000, 80, 80,
                    std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null());
                assert!(!hwnd.is_null());
                struct TestWindow(HWND);
                impl Drop for TestWindow { fn drop(&mut self) { unsafe { DestroyWindow(self.0); } } }
                let window = TestWindow(hwnd);
                install(hwnd).unwrap();
                let seen = calls.clone();
                install_escape(hwnd, Box::new(move || { seen.fetch_add(1, Ordering::SeqCst); })).unwrap();
                let second = CreateWindowExW(0, class.as_ptr(), std::ptr::null(), 0, -32000, -32000, 80, 80,
                    std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null());
                assert!(!second.is_null());
                let second_window = TestWindow(second);
                assert!(install_escape(second, Box::new(|| panic!("occupied shortcut must not install"))).is_err());
                drop(second_window);
                SendMessageW(hwnd, WM_HOTKEY, (ESCAPE_HOTKEY + 1) as usize, 0);
                assert_eq!(calls.load(Ordering::SeqCst), 0);
                SendMessageW(hwnd, WM_HOTKEY, ESCAPE_HOTKEY as usize, 0);
                assert_eq!(calls.load(Ordering::SeqCst), 1);
                assert_borderless(hwnd);
                drop(window);
                // The destroyed window must release the global shortcut.
                assert_ne!(RegisterHotKey(std::ptr::null_mut(), ESCAPE_HOTKEY, ESCAPE_MODIFIERS, ESCAPE_KEY), 0);
                assert_ne!(UnregisterHotKey(std::ptr::null_mut(), ESCAPE_HOTKEY), 0);
            }
        }
        #[test]
        fn strips_only_frame_bits_and_preserves_passthrough_visibility_and_z_order() {
            let style = FRAME | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN;
            assert_eq!(clean(GWL_STYLE, style), style & !FRAME);
            let ex = EX_FRAME | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_APPWINDOW;
            assert_eq!(clean(GWL_EXSTYLE, ex), ex & !EX_FRAME);
            assert_eq!(clean(100, 0xFFFFFFFF), 0xFFFFFFFF);
        }
        #[test]
        fn native_guard_survives_repeated_style_show_hide_and_bottom_updates() {
            // A disposable, off-screen test window: no Tauri profile, credentials or user data.
            let class: Vec<u16> = "STATIC".encode_utf16().chain(Some(0)).collect();
            let title: Vec<u16> = "native-borderless-guard-test".encode_utf16().chain(Some(0)).collect();
            unsafe {
                let hwnd = CreateWindowExW(EX_FRAME | WS_EX_NOACTIVATE, class.as_ptr(), title.as_ptr(),
                    FRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX, -32000, -32000, 80, 80,
                    std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null());
                assert!(!hwnd.is_null());
                struct TestWindow(HWND);
                impl Drop for TestWindow { fn drop(&mut self) { unsafe { DestroyWindow(self.0); } } }
                let _window = TestWindow(hwnd);
                install(hwnd).unwrap();
                assert_borderless(hwnd); // Before the first show.
                for _ in 0..4 {
                    ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    assert_borderless(hwnd);
                    for passthrough in [true, false] {
                        let proposed = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 | FRAME;
                        SetWindowLongPtrW(hwnd, GWL_STYLE, proposed as isize);
                        let mut ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 | EX_FRAME;
                        if passthrough { ex |= WS_EX_TRANSPARENT | WS_EX_LAYERED; }
                        else { ex &= !(WS_EX_TRANSPARENT | WS_EX_LAYERED); }
                        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex as isize);
                        assert_borderless(hwnd);
                        assert_eq!(GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TRANSPARENT != 0, passthrough);
                    }
                    SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0,
                        SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                    assert_borderless(hwnd);
                    SendMessageW(hwnd, WM_NCACTIVATE, 1, 0);
                    SendMessageW(hwnd, WM_NCACTIVATE, 0, 0);
                    SendMessageW(hwnd, WM_NCPAINT, 1, 0);
                    SendMessageW(hwnd, WM_THEMECHANGED, 0, 0);
                    assert_borderless(hwnd);
                    ShowWindow(hwnd, SW_HIDE);
                    assert_borderless(hwnd);
                }
            }
        }
        #[test]
        fn activation_is_forwarded_without_nonclient_paint_and_client_messages_remain_intact() {
            #[derive(Default)]
            struct Seen { activation:usize, activation_param:isize, nonclient_paint:usize, client_paint:usize }
            unsafe extern "system" fn observe(hwnd:HWND,message:u32,wparam:WPARAM,lparam:LPARAM,_:usize,data:usize)->LRESULT {
                let seen=&mut *(data as *mut Seen);
                match message { WM_NCACTIVATE=>{seen.activation+=1;seen.activation_param=lparam;}, WM_NCPAINT=>seen.nonclient_paint+=1,WM_PAINT=>seen.client_paint+=1,_=>{} }
                DefSubclassProc(hwnd,message,wparam,lparam)
            }
            let mut seen=Box::new(Seen::default());
            let class:Vec<u16>="STATIC".encode_utf16().chain(Some(0)).collect();
            unsafe {
                let hwnd=CreateWindowExW(0,class.as_ptr(),std::ptr::null(),FRAME,-32000,-32000,80,80,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null());
                assert!(!hwnd.is_null());
                struct TestWindow(HWND);
                impl Drop for TestWindow {fn drop(&mut self){unsafe{DestroyWindow(self.0);}}}
                let _window=TestWindow(hwnd);
                assert_ne!(SetWindowSubclass(hwnd,observe,GUARD_ID+1,&mut *seen as *mut Seen as usize),0);
                install(hwnd).unwrap();
                let before=seen.activation;
                SendMessageW(hwnd,WM_NCACTIVATE,1,0);
                assert_eq!(seen.activation,before+1);
                assert_eq!(seen.activation_param,-1);
                let paints=seen.nonclient_paint;
                SendMessageW(hwnd,WM_NCPAINT,1,0);
                assert_eq!(seen.nonclient_paint,paints);
                let clients=seen.client_paint;
                SendMessageW(hwnd,WM_PAINT,0,0);
                assert!(seen.client_paint>clients);
                assert_borderless(hwnd);
            }
        }
    }
}

#[derive(Deserialize)]
pub struct MainWindowHitRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[tauri::command]
pub fn set_main_window_hit_regions(app: AppHandle, regions: Vec<MainWindowHitRegion>) -> Result<(), String> {
    let Some(window) = app.get_window("main") else { return Ok(()); };
    #[cfg(windows)]
    return apply_region(&window, regions);
    #[cfg(not(windows))]
    {
        let _ = (window, regions);
        Ok(())
    }
}

#[tauri::command]
pub fn set_dock_window_hit_regions(app: AppHandle, regions: Vec<MainWindowHitRegion>) -> Result<(), String> {
    let Some(window) = app.get_window("dock") else { return Ok(()); };
    #[cfg(windows)]
    return apply_region(&window, regions);
    #[cfg(not(windows))]
    {
        let _ = (window, regions);
        Ok(())
    }
}

#[cfg(windows)]
fn apply_region(window: &Window, regions: Vec<MainWindowHitRegion>) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Gdi::{CombineRgn, CreateRectRgn, DeleteObject, EqualRgn, GetWindowRgn, RedrawWindow, SetWindowRgn, RGN_OR, RDW_INVALIDATE, RDW_NOERASE, RDW_NOFRAME};

    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let max_x = size.width.min(i32::MAX as u32) as i32;
    let max_y = size.height.min(i32::MAX as u32) as i32;
    let region = unsafe { CreateRectRgn(0, 0, 0, 0) };
    if region.is_null() { return Err("无法创建主屏点击区域".into()); }

    let mut rect_count = 0usize;
    for item in regions {
        if ![item.x, item.y, item.width, item.height, scale].iter().all(|value| value.is_finite()) || item.width <= 0.0 || item.height <= 0.0 || scale <= 0.0 {
            continue;
        }
        let left = (item.x * scale).floor().clamp(0.0, max_x as f64) as i32;
        let top = (item.y * scale).floor().clamp(0.0, max_y as f64) as i32;
        let right = ((item.x + item.width) * scale).ceil().clamp(0.0, max_x as f64) as i32;
        let bottom = ((item.y + item.height) * scale).ceil().clamp(0.0, max_y as f64) as i32;
        if right <= left || bottom <= top { continue; }
        let part = unsafe { CreateRectRgn(left, top, right, bottom) };
        if part.is_null() {
            unsafe { DeleteObject(region.cast()); }
            return Err("无法创建主屏点击区域".into());
        }
        let combined = unsafe { CombineRgn(region, region, part, RGN_OR) };
        unsafe { DeleteObject(part.cast()); }
        if combined == 0 {
            unsafe { DeleteObject(region.cast()); }
            return Err("无法合并主屏点击区域".into());
        }
        rect_count += 1;
    }
    if rect_count == 0 {
        unsafe { DeleteObject(region.cast()); }
        return Err("主屏交互区域为空".into());
    }
    // A region belongs to Windows after SetWindowRgn succeeds. Compare before
    // transferring ownership; do not erase the transparent window on redraw.
    let previous = unsafe { CreateRectRgn(0, 0, 0, 0) };
    if previous.is_null() { unsafe { DeleteObject(region.cast()); } return Err("无法读取原有点击区域".into()); }
    let same = unsafe { GetWindowRgn(hwnd, previous) != 0 && EqualRgn(previous, region) != 0 };
    unsafe { DeleteObject(previous.cast()); }
    if same { unsafe { DeleteObject(region.cast()); } return Ok(()); }
    if unsafe { SetWindowRgn(hwnd, region, 0) } == 0 {
        unsafe { DeleteObject(region.cast()); }
        return Err("无法应用主屏点击区域".into());
    }
    if unsafe { RedrawWindow(hwnd, std::ptr::null(), std::ptr::null_mut(), RDW_INVALIDATE | RDW_NOERASE | RDW_NOFRAME) } == 0 {
        return Err("无法刷新透明窗口点击区域".into());
    }
    Ok(())
}
