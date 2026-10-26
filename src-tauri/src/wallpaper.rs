use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperInfo {
    path: Option<String>,
    luminance: Option<f64>,
    profile: &'static str,
}

#[tauri::command]
pub fn read_wallpaper_profile() -> Result<WallpaperInfo, String> {
    #[cfg(windows)]
    { read_windows_wallpaper_profile() }
    #[cfg(not(windows))]
    { Err("wallpaper detection is available only on Windows".into()) }
}

#[cfg(windows)]
fn read_windows_wallpaper_profile() -> Result<WallpaperInfo, String> {
    use std::ffi::c_void;
    const SPI_GETDESKWALLPAPER: u32 = 0x0073;
    const SAMPLE_GRID: u32 = 12;

    #[repr(C)]
    struct GdiplusStartupInput {
        version: u32,
        debug_event_callback: *const c_void,
        suppress_background_thread: i32,
        suppress_external_codecs: i32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SystemParametersInfoW(action: u32, param: u32, output: *mut c_void, flags: u32) -> i32;
    }
    #[link(name = "gdiplus")]
    unsafe extern "system" {
        fn GdiplusStartup(token: *mut usize, input: *const GdiplusStartupInput, output: *mut c_void) -> i32;
        fn GdiplusShutdown(token: usize);
        fn GdipCreateBitmapFromFile(path: *const u16, image: *mut *mut c_void) -> i32;
        fn GdipGetImageWidth(image: *mut c_void, width: *mut u32) -> i32;
        fn GdipGetImageHeight(image: *mut c_void, height: *mut u32) -> i32;
        fn GdipBitmapGetPixel(image: *mut c_void, x: u32, y: u32, color: *mut u32) -> i32;
        fn GdipDisposeImage(image: *mut c_void) -> i32;
    }

    let mut buffer = vec![0u16; 32_768];
    let success = unsafe {
        SystemParametersInfoW(SPI_GETDESKWALLPAPER, buffer.len() as u32, buffer.as_mut_ptr().cast(), 0)
    };
    if success == 0 { return Err("Windows did not return the current wallpaper path".into()); }
    let length = buffer.iter().position(|value| *value == 0).unwrap_or(buffer.len());
    if length == 0 { return Ok(WallpaperInfo { path: None, luminance: None, profile: "unknown" }); }
    let path = String::from_utf16(&buffer[..length]).map_err(|error| error.to_string())?;
    let path_wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

    let startup = GdiplusStartupInput { version: 1, debug_event_callback: std::ptr::null(), suppress_background_thread: 0, suppress_external_codecs: 0 };
    let mut token = 0usize;
    if unsafe { GdiplusStartup(&mut token, &startup, std::ptr::null_mut()) } != 0 {
        return Ok(WallpaperInfo { path: Some(path), luminance: None, profile: "unknown" });
    }

    let mut image = std::ptr::null_mut();
    let loaded = unsafe { GdipCreateBitmapFromFile(path_wide.as_ptr(), &mut image) } == 0 && !image.is_null();
    let luminance = if loaded {
        let mut width = 0u32;
        let mut height = 0u32;
        let size_ok = unsafe { GdipGetImageWidth(image, &mut width) == 0 && GdipGetImageHeight(image, &mut height) == 0 };
        if size_ok && width > 0 && height > 0 {
            let mut total = 0.0;
            let mut count = 0u32;
            for row in 0..SAMPLE_GRID {
                for column in 0..SAMPLE_GRID {
                    let x = ((column as u64 * 2 + 1) * width as u64 / (SAMPLE_GRID as u64 * 2)).min(width as u64 - 1) as u32;
                    let y = ((row as u64 * 2 + 1) * height as u64 / (SAMPLE_GRID as u64 * 2)).min(height as u64 - 1) as u32;
                    let mut argb = 0u32;
                    if unsafe { GdipBitmapGetPixel(image, x, y, &mut argb) } == 0 {
                        let [red, green, blue] = [((argb >> 16) & 0xff) as f64, ((argb >> 8) & 0xff) as f64, (argb & 0xff) as f64];
                        total += (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255.0;
                        count += 1;
                    }
                }
            }
            (count > 0).then_some(total / count as f64)
        } else { None }
    } else { None };
    if loaded { unsafe { GdipDisposeImage(image); } }
    unsafe { GdiplusShutdown(token); }

    let profile = luminance.map(|value| if value < 0.44 { "dark" } else { "light" }).unwrap_or("unknown");
    Ok(WallpaperInfo { path: Some(path), luminance, profile })
}
