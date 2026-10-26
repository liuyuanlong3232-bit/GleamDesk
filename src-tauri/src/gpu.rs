//! First-party, read-only NVIDIA adapter. ABI layouts follow the documented
//! NVML utilization/memory/device query interfaces; no vendor SDK is bundled.
use crate::hardware::GpuMetrics;
use std::{ffi::{c_char, c_void}, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::{FreeLibrary, HMODULE}, System::{Com::CoTaskMemFree,
    LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32},
    SystemInformation::GetSystemDirectoryW}, UI::Shell::{SHGetKnownFolderPath, FOLDERID_ProgramFilesX64}};

const SUCCESS: i32 = 0;
const NOT_SUPPORTED: i32 = 3;
const GPU_LOST: i32 = 15;
#[repr(transparent)]
#[derive(Clone, Copy)]
struct Device(*mut c_void);
#[repr(C)]
#[derive(Default)]
struct Utilization { gpu: u32, memory: u32 }
#[repr(C)]
#[derive(Default)]
struct Memory { total: u64, free: u64, used: u64 }
type Init = unsafe extern "C" fn() -> i32;
type Count = unsafe extern "C" fn(*mut u32) -> i32;
type Handle = unsafe extern "C" fn(u32, *mut Device) -> i32;
type Name = unsafe extern "C" fn(Device, *mut c_char, u32) -> i32;
type Usage = unsafe extern "C" fn(Device, *mut Utilization) -> i32;
type MemoryInfo = unsafe extern "C" fn(Device, *mut Memory) -> i32;
type Temperature = unsafe extern "C" fn(Device, u32, *mut u32) -> i32;

struct Library(HMODULE);
impl Drop for Library {
    fn drop(&mut self) { unsafe { FreeLibrary(self.0); } }
}
impl Library {
    fn load() -> Option<Self> {
        for path in library_paths() {
            let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
            let module = unsafe { LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32) };
            if !module.is_null() { return Some(Self(module)); }
        }
        None
    }
    unsafe fn symbol<F: Copy>(&self, name: &[u8]) -> Option<F> {
        let function = GetProcAddress(self.0, name.as_ptr())?;
        if std::mem::size_of::<F>() != std::mem::size_of_val(&function) { return None; }
        Some(std::mem::transmute_copy(&function))
    }
}

fn library_paths() -> Vec<String> {
    let mut paths = Vec::new();
    let mut system = [0u16; 512];
    let length = unsafe { GetSystemDirectoryW(system.as_mut_ptr(), system.len() as u32) } as usize;
    if length > 0 && length < system.len() { paths.push(format!("{}\\nvml.dll", String::from_utf16_lossy(&system[..length]))); }
    let mut raw = std::ptr::null_mut();
    if unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramFilesX64, 0, std::ptr::null_mut(), &mut raw) } >= 0 && !raw.is_null() {
        let mut length = 0;
        while length < 32_768 && unsafe { *raw.add(length) } != 0 { length += 1; }
        if length < 32_768 {
            let base = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(raw, length) });
            paths.push(format!("{base}\\NVIDIA Corporation\\NVSMI\\nvml.dll"));
        }
    }
    if !raw.is_null() { unsafe { CoTaskMemFree(raw.cast()); } }
    paths
}

struct Session {
    _library: Library,
    initialized: bool,
    shutdown: Init,
    device: Device,
    usage: Usage,
    memory: MemoryInfo,
    temperature: Temperature,
    name: Option<String>,
    count: u32,
}
// NVML documents thread-safe queries. This owned session moves between workers
// only while the shared hardware sampler mutex serializes all access and Drop.
unsafe impl Send for Session {}
impl Drop for Session {
    fn drop(&mut self) { if self.initialized { unsafe { (self.shutdown)(); } } }
}
impl Session {
    fn load() -> Result<Self, (&'static str, &'static str)> {
        let library = Library::load().ok_or(("unsupported", "未找到 NVIDIA NVML；AMD/Intel 适配器尚未接入"))?;
        let missing = ("unavailable", "NVIDIA 驱动缺少所需的只读查询接口");
        let init: Init = unsafe { library.symbol(b"nvmlInit_v2\0") }.ok_or(missing)?;
        let shutdown: Init = unsafe { library.symbol(b"nvmlShutdown\0") }.ok_or(missing)?;
        let count: Count = unsafe { library.symbol(b"nvmlDeviceGetCount_v2\0") }.ok_or(missing)?;
        let handle: Handle = unsafe { library.symbol(b"nvmlDeviceGetHandleByIndex_v2\0") }.ok_or(missing)?;
        let name: Name = unsafe { library.symbol(b"nvmlDeviceGetName\0") }.ok_or(missing)?;
        let usage: Usage = unsafe { library.symbol(b"nvmlDeviceGetUtilizationRates\0") }.ok_or(missing)?;
        let memory: MemoryInfo = unsafe { library.symbol(b"nvmlDeviceGetMemoryInfo\0") }.ok_or(missing)?;
        let temperature: Temperature = unsafe { library.symbol(b"nvmlDeviceGetTemperature\0") }.ok_or(missing)?;
        let mut session = Self { _library: library, initialized: false, shutdown, device: Device(std::ptr::null_mut()),
            usage, memory, temperature, name: None, count: 0 };
        let result = unsafe { init() };
        if result != SUCCESS { return Err((status(result), "NVIDIA NVML 初始化失败；保留其他硬件指标")); }
        session.initialized = true;
        let result = unsafe { count(&mut session.count) };
        if result != SUCCESS { return Err((status(result), "NVIDIA GPU 设备数量无法读取")); }
        if session.count == 0 { return Err(("unsupported", "NVIDIA NVML 没有发现可用设备")); }
        let result = unsafe { handle(0, &mut session.device) };
        if result != SUCCESS || session.device.0.is_null() { return Err(("unavailable", "NVIDIA GPU 0 当前不可读取")); }
        let mut buffer = [0u8; 128];
        if unsafe { name(session.device, buffer.as_mut_ptr().cast(), buffer.len() as u32) } == SUCCESS {
            let end = buffer.iter().position(|part| *part == 0).unwrap_or(buffer.len());
            if end > 0 { session.name = Some(String::from_utf8_lossy(&buffer[..end]).into_owned()); }
        }
        Ok(session)
    }
    fn read(&self) -> (GpuMetrics, bool) {
        let mut utilization = Utilization::default();
        let mut memory = Memory::default();
        let mut temperature = 0;
        let usage_code = unsafe { (self.usage)(self.device, &mut utilization) };
        let memory_code = unsafe { (self.memory)(self.device, &mut memory) };
        let temperature_code = unsafe { (self.temperature)(self.device, 0, &mut temperature) };
        let usage = (usage_code == SUCCESS && utilization.gpu <= 100).then_some(utilization.gpu as f64);
        let valid_memory = memory_code == SUCCESS && valid_memory(&memory);
        let temp = (temperature_code == SUCCESS && temperature <= 200).then_some(temperature as f64);
        let usage_status = metric_status(usage_code, usage.is_some());
        let memory_status = metric_status(memory_code, valid_memory);
        let temperature_status = metric_status(temperature_code, temp.is_some());
        let all = [usage_status, memory_status, temperature_status];
        let overall = if all.contains(&"available") { "available" }
            else if all.iter().all(|state| *state == "unsupported") { "unsupported" } else { "unavailable" };
        (GpuMetrics { name: self.name.clone(), usage_percent: usage,
            memory_used_bytes: valid_memory.then_some(memory.used), memory_total_bytes: valid_memory.then_some(memory.total),
            temperature_c: temp, status: overall.into(), usage_status: usage_status.into(), memory_status: memory_status.into(),
            temperature_status: temperature_status.into(), source: Some("NVIDIA NVML".into()),
            detail: Some(format!("NVIDIA NVML · GPU 0 / {} 台设备；利用率为驱动采样窗口内的 GPU 活动时间占比", self.count)) },
            [usage_code, memory_code, temperature_code].contains(&GPU_LOST))
    }
}

fn valid_memory(memory: &Memory) -> bool {
    memory.total > 0 && memory.total <= 9_007_199_254_740_991 && memory.used <= memory.total && memory.free <= memory.total
        && memory.used.checked_add(memory.free).is_some_and(|sum| sum <= memory.total)
}
fn status(code: i32) -> &'static str { if code == NOT_SUPPORTED { "unsupported" } else { "unavailable" } }
fn metric_status(code: i32, valid: bool) -> &'static str { if code == SUCCESS && valid { "available" } else { status(code) } }
fn empty(status: &str, detail: &str) -> GpuMetrics {
    GpuMetrics { name: None, usage_percent: None, memory_used_bytes: None, memory_total_bytes: None, temperature_c: None,
        status: status.into(), usage_status: status.into(), memory_status: status.into(), temperature_status: status.into(),
        source: None, detail: Some(detail.into()) }
}

pub(crate) struct GpuSampler {
    session: Option<Session>, last_attempt: Option<Instant>, unavailable: (&'static str, &'static str),
}
impl Default for GpuSampler {
    fn default() -> Self { Self { session: None, last_attempt: None, unavailable: ("unsupported", "GPU 数据源尚未检测") } }
}
impl GpuSampler {
    pub(crate) fn sample(&mut self, now: Instant) -> GpuMetrics {
        if self.session.is_none() && self.last_attempt.is_none_or(|last| now.duration_since(last) >= Duration::from_secs(60)) {
            self.last_attempt = Some(now);
            match Session::load() { Ok(session) => self.session = Some(session), Err(error) => self.unavailable = error }
        }
        if let Some(session) = self.session.as_ref() {
            let (metrics, lost) = session.read();
            if lost {
                self.session = None; self.last_attempt = Some(now);
                self.unavailable = ("unavailable", "NVIDIA GPU 暂时失联；将在后续按需采样时重新检测");
            }
            return metrics;
        }
        empty(self.unavailable.0, self.unavailable.1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nvml_status_and_invalid_values_remain_distinct_from_zero() {
        assert_eq!(metric_status(SUCCESS, true), "available");
        assert_eq!(metric_status(SUCCESS, false), "unavailable");
        assert_eq!(metric_status(NOT_SUPPORTED, false), "unsupported");
        assert_eq!(metric_status(GPU_LOST, false), "unavailable");
        assert!(valid_memory(&Memory { total: 100, used: 60, free: 40 }));
        assert!(!valid_memory(&Memory { total: 100, used: u64::MAX, free: 0 }));
        assert!(!valid_memory(&Memory { total: 100, used: 60, free: 60 }));
        assert_eq!(std::mem::size_of::<Device>(), std::mem::size_of::<*mut c_void>());
        assert_eq!(std::mem::size_of::<Utilization>(), 8);
        assert_eq!(std::mem::size_of::<Memory>(), 24);
    }
    #[test]
    #[ignore = "requires a real NVIDIA device and installed NVML driver"]
    fn native_nvml_readonly_smoke() {
        let mut sampler = GpuSampler::default();
        for _ in 0..3 {
            let metrics = sampler.sample(Instant::now());
            println!("{}", serde_json::to_string(&metrics).unwrap());
            assert_eq!(metrics.usage_status, "available");
            assert_eq!(metrics.memory_status, "available");
            assert_eq!(metrics.temperature_status, "available");
            assert!(metrics.name.as_deref().is_some_and(|name| name.contains("NVIDIA")));
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}
