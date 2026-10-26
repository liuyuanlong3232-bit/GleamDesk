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

/// Keep the launcher above Explorer's desktop hosts but below ordinary apps.
/// It never activates itself; normal app activation continues to raise apps.
pub(crate) fn place_below_apps(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.set_always_on_top(false).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::{Foundation::{HWND, LPARAM}, UI::WindowsAndMessaging::*};
        struct Order { process: u32, last: HWND, dock: HWND, seen: bool, apps_below: usize }
        unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> i32 {
            let order = &mut *(data as *mut Order);
            if hwnd == order.dock { order.seen = true; return 1; }
            if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 || !GetWindow(hwnd, GW_OWNER).is_null() { return 1; }
            let mut process = 0;
            GetWindowThreadProcessId(hwnd, &mut process);
            if process == order.process || GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & (WS_EX_TOOLWINDOW | WS_EX_TOPMOST) as isize != 0 { return 1; }
            let mut class = [0u16; 128];
            let count = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
            if count > 0 && !desktop_host(&String::from_utf16_lossy(&class[..count as usize])) {
                // Remember the bottom-most ordinary window in the entire Z order,
                // including windows currently above the Dock. Inserting after
                // that window keeps every normal application in front of it.
                order.last = hwnd;
                if order.seen { order.apps_below += 1; }
            }
            1
        }
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
        let mut order = Order { process: std::process::id(), last: std::ptr::null_mut(), dock: hwnd, seen: false, apps_below: 0 };
        if EnumWindows(Some(visit), &mut order as *mut Order as LPARAM) == 0 { return Err("无法读取窗口层级".into()); }
        let after = if order.last.is_null() { HWND_TOP } else { order.last };
        if SetWindowPos(hwnd, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) == 0 {
            return Err("无法设置启动栏桌面层级".into());
        }
        #[cfg(debug_assertions)] {
            order.seen = false; order.apps_below = 0;
            let _ = EnumWindows(Some(visit), &mut order as *mut Order as LPARAM);
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let status = serde_json::json!({ "topmost": style & WS_EX_TOPMOST as isize != 0, "noActivate": style & WS_EX_NOACTIVATE as isize != 0, "ordinaryAppsBelowDock": order.apps_below });
            let path = std::env::temp_dir().join(format!("codex-desktop-layer-{}.json", std::process::id()));
            let _ = std::fs::write(path, status.to_string());
        }
    }
    Ok(())
}

fn desktop_host(class: &str) -> bool {
    matches!(class, "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
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
    #[test]
    fn desktop_hosts_are_distinct_from_file_manager_and_application_windows() {
        for class in ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"] { assert!(super::desktop_host(class)); }
        for class in ["CabinetWClass", "Chrome_WidgetWin_1", "Notepad"] { assert!(!super::desktop_host(class)); }
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
