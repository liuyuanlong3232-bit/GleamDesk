use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

#[tauri::command]
pub fn position_dock_window(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let Some(window) = app.get_webview_window("dock") else { return Ok(()); };
    let Some(monitor) = app.primary_monitor().map_err(|error| error.to_string())? else { return Ok(()); };
    let scale = monitor.scale_factor();
    let position = monitor.position();
    let size = monitor.size();
    let mut area = (position.x, position.y, position.x + size.width as i32, position.y + size.height as i32);
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::{Foundation::POINT, Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST}};
        let handle = MonitorFromPoint(POINT { x: position.x + size.width as i32 / 2, y: position.y + size.height as i32 / 2 }, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(handle, &mut info) != 0 { area = (info.rcWork.left, info.rcWork.top, info.rcWork.right, info.rcWork.bottom); }
    }
    if !width.is_finite() || !height.is_finite() { return Err("Dock 尺寸无效".into()); }
    let (x, y, w, h) = dock_bounds(area, scale, width, height);
    let size = PhysicalSize::new(w, h);
    let position = PhysicalPosition::new(x, y);
    if window.inner_size().ok() != Some(size) { window.set_size(size).map_err(|error| error.to_string())?; }
    if window.outer_position().ok() != Some(position) { window.set_position(position).map_err(|error| error.to_string())?; }
    place_below_apps(&window)?;
    Ok(())
}

/// Keep the desktop launcher beneath ordinary apps without taking keyboard focus.
fn place_below_apps(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    return lower_without_activation(window.hwnd().map_err(|error| error.to_string())?.0);
    #[cfg(not(windows))]
    window.set_always_on_bottom(true).map_err(|error|error.to_string())
}

#[cfg(windows)]
fn lower_without_activation(hwnd:windows_sys::Win32::Foundation::HWND)->Result<(),String>{
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    if unsafe{SetWindowPos(hwnd,HWND_BOTTOM,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)}==0{
        return Err("无法设置 Dock 窗口层级".into());
    }
    Ok(())
}

#[tauri::command]
pub fn set_dock_menu_open(window:tauri::Window,open:bool)->Result<(),String>{
    if window.label()!="dock"{return Err("只能由 Dock 操作菜单焦点".into());}
    // A no-activate launcher cannot lose focus on outside clicks. Temporarily
    // activate its popup; closing restores the launcher's non-activating mode.
    window.set_focusable(open).map_err(|error|error.to_string())?;
    if open {
        if let Err(error)=window.set_focus(){let _=window.set_focusable(false);return Err(error.to_string());}
    }
    Ok(())
}

fn dock_bounds(area: (i32, i32, i32, i32), scale: f64, width: f64, height: f64) -> (i32, i32, u32, u32) {
    let available_width = (area.2 - area.0).max(1);
    let available_height = (area.3 - area.1).max(1);
    let w = ((width.clamp(64.0, 2400.0) * scale).round() as i32).min(available_width);
    let h = ((height.clamp(64.0, 450.0) * scale).round() as i32).min(available_height);
    (area.0 + (available_width - w) / 2, (area.3 - h - (8.0 * scale).round() as i32).max(area.1), w as u32, h as u32)
}

#[cfg(test)]
mod tests {
    use super::dock_bounds;
    #[cfg(windows)]
    #[test]
    fn launcher_is_below_apps_without_activating_or_changing_its_bounds(){
        use windows_sys::Win32::{Foundation::RECT,UI::WindowsAndMessaging::*};
        let class:Vec<u16>="STATIC".encode_utf16().chain(Some(0)).collect();
        unsafe{
            let hwnd=CreateWindowExW(WS_EX_NOACTIVATE|WS_EX_TOPMOST,class.as_ptr(),std::ptr::null(),0,-32000,-32000,64,64,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null());
            assert!(!hwnd.is_null());
            struct TestWindow(windows_sys::Win32::Foundation::HWND);
            impl Drop for TestWindow{fn drop(&mut self){unsafe{DestroyWindow(self.0);}}}
            let _window=TestWindow(hwnd);
            let ordinary=CreateWindowExW(WS_EX_NOACTIVATE,class.as_ptr(),std::ptr::null(),0,-32000,-32000,80,80,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null());
            assert!(!ordinary.is_null());let _ordinary=TestWindow(ordinary);
            let foreground=GetForegroundWindow();
            let mut before:RECT=std::mem::zeroed();assert_ne!(GetWindowRect(hwnd,&mut before),0);
            super::lower_without_activation(hwnd).unwrap();
            let style=GetWindowLongPtrW(hwnd,GWL_EXSTYLE) as u32;
            assert_eq!(style&WS_EX_TOPMOST,0,"Dock must not cover ordinary applications");assert_ne!(style&WS_EX_NOACTIVATE,0);
            // Compare controlled app windows; system/shell windows also occupy
            // this global list, so being its absolute final item is not required.
            let mut higher=GetWindow(hwnd,GW_HWNDPREV);let mut ordinary_above=false;
            for _ in 0..4096{if higher.is_null(){break}if higher==ordinary{ordinary_above=true;break}higher=GetWindow(higher,GW_HWNDPREV);}
            assert!(ordinary_above,"Dock must remain beneath an ordinary app window");
            assert_eq!(GetForegroundWindow(),foreground);
            let mut rect:RECT=std::mem::zeroed();assert_ne!(GetWindowRect(hwnd,&mut rect),0);
            assert_eq!((rect.left,rect.top,rect.right,rect.bottom),(before.left,before.top,before.right,before.bottom));
        }
    }
    #[test]
    fn dock_centers_above_taskbar_at_scaled_and_negative_monitor_positions() {
        assert_eq!(dock_bounds((0, 0, 2560, 1392), 1.25, 1080.0, 192.0), (605, 1142, 1350, 240));
        assert_eq!(dock_bounds((-1920, 0, 0, 1040), 1.0, 1080.0, 450.0), (-1500, 582, 1080, 450));
    }
    #[test]
    fn collapsed_avatar_has_a_small_real_window_at_each_scale() {
        assert_eq!(dock_bounds((0,0,2560,1392),1.25,64.0,64.0),(1240,1302,80,80));
        assert_eq!(dock_bounds((-1920,0,0,1040),1.0,64.0,64.0),(-992,968,64,64));
    }
    #[test]
    fn dock_remains_inside_small_work_area() {
        assert_eq!(dock_bounds((0, 0, 800, 400), 2.0, 2400.0, 450.0), (0, 0, 800, 400));
    }
}
