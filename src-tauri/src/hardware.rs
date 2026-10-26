use serde::Serialize;
use std::{sync::{Arc, Mutex}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareSnapshot {
    pub sampled_at_unix_ms: u64,
    pub cpu: CpuMetrics,
    pub memory: MemoryMetrics,
    pub disks: DiskMetrics,
    pub network: NetworkMetrics,
    pub gpu: GpuMetrics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuMetrics {
    pub usage_percent: Option<f64>,
    pub usage_status: String,
    pub temperature_c: Option<f64>,
    pub temperature_status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMetrics {
    pub used_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub usage_percent: Option<f64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskVolume {
    pub name: String,
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub usage_percent: f64,
    pub read_bytes_per_second: Option<f64>,
    pub write_bytes_per_second: Option<f64>,
    pub io_status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskMetrics {
    pub volumes: Vec<DiskVolume>,
    pub status: String,
    pub read_bytes_per_second: Option<f64>,
    pub write_bytes_per_second: Option<f64>,
    pub io_status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMetrics {
    pub upload_bytes_per_second: Option<f64>,
    pub download_bytes_per_second: Option<f64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuMetrics {
    pub name: Option<String>,
    pub usage_percent: Option<f64>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub temperature_c: Option<f64>,
    pub status: String,
    pub usage_status: String,
    pub memory_status: String,
    pub temperature_status: String,
    pub source: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Copy)]
struct CpuTimes { idle: u64, kernel: u64, user: u64 }

#[derive(Clone)]
struct NetworkInterfaceCounters { luid: u64, index: u32, received: u64, sent: u64 }

struct NetworkTotals { interfaces: Vec<NetworkInterfaceCounters> }

#[derive(Default)]
struct HardwareSamplingState {
    last_sampled_at: Option<Instant>,
    previous_cpu: Option<CpuTimes>,
    previous_network: Option<NetworkTotals>,
    last_snapshot: Option<HardwareSnapshot>,
    #[cfg(windows)]
    gpu: crate::gpu::GpuSampler,
    #[cfg(windows)]
    disk_io: DiskIoSampler,
}

#[derive(Default)]
pub struct HardwareSampler(Arc<Mutex<HardwareSamplingState>>);

#[tauri::command]
pub async fn read_hardware_snapshot(state: State<'_, HardwareSampler>, minimum_interval_ms: Option<u64>) -> Result<HardwareSnapshot, String> {
    let sampler = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || read_snapshot(&sampler, minimum_interval_ms)).await
        .map_err(|_| "hardware sampling worker failed".to_string())?
}

fn read_snapshot(sampler: &Mutex<HardwareSamplingState>, minimum_interval_ms: Option<u64>) -> Result<HardwareSnapshot, String> {
    let mut state = sampler.lock().map_err(|_| "hardware sampler lock is unavailable".to_string())?;
    let now = Instant::now();
    let minimum = Duration::from_millis(minimum_interval_ms.unwrap_or(1_000).clamp(1_000, 60_000));
    if state.last_sampled_at.is_some_and(|previous| now.duration_since(previous) < minimum) {
        if let Some(snapshot) = state.last_snapshot.as_ref() { return Ok(snapshot.clone()); }
    }

    #[cfg(windows)]
    let snapshot = sample_windows(&mut state, now)?;
    #[cfg(not(windows))]
    let snapshot = {
        let _ = (&mut state, now);
        return Err("本机硬件 Provider 仅支持 Windows 桌面应用".into());
    };

    state.last_sampled_at = Some(now);
    state.last_snapshot = Some(snapshot.clone());
    Ok(snapshot)
}

fn cpu_usage_percent(previous: CpuTimes, current: CpuTimes) -> Option<f64> {
    let idle = current.idle.checked_sub(previous.idle)?;
    let kernel = current.kernel.checked_sub(previous.kernel)?;
    let user = current.user.checked_sub(previous.user)?;
    let total = kernel.checked_add(user)?;
    if total == 0 || idle > total { return None; }
    Some(((total - idle) as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
}

fn valid_counter_interval(elapsed: Duration) -> bool {
    !elapsed.is_zero() && elapsed <= Duration::from_secs(60)
}

fn network_rates(previous: &NetworkTotals, current: &NetworkTotals, elapsed: Duration) -> Option<(f64, f64)> {
    if !valid_counter_interval(elapsed) || previous.interfaces.is_empty()
        || previous.interfaces.len() != current.interfaces.len() { return None; }
    let seconds = elapsed.as_secs_f64();
    let mut received = 0u64;
    let mut sent = 0u64;
    for (before, after) in previous.interfaces.iter().zip(&current.interfaces) {
        if (before.luid, before.index) != (after.luid, after.index) { return None; }
        received = received.checked_add(after.received.checked_sub(before.received)?)?;
        sent = sent.checked_add(after.sent.checked_sub(before.sent)?)?;
    }
    Some((received as f64 / seconds, sent as f64 / seconds))
}

#[cfg(windows)]
fn sample_windows(state: &mut HardwareSamplingState, now: Instant) -> Result<HardwareSnapshot, String> {
    let sampled_at_unix_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64;
    let cpu_times = read_cpu_times().ok();
    let memory = read_memory();
    let mut disks = read_disks();
    state.disk_io.sample(&mut disks, now);
    let disk_io = aggregate_disk_io(&disks);
    let network_totals = read_network_totals().ok();
    let network_available = network_totals.is_some();
    let elapsed = state.last_sampled_at.map(|last| now.duration_since(last)).unwrap_or_default();

    let cpu_usage = valid_counter_interval(elapsed).then(|| state.previous_cpu.zip(cpu_times))
        .flatten().and_then(|(previous, current)| cpu_usage_percent(previous, current));
    state.previous_cpu = cpu_times;
    let (network_download, network_upload) = state.previous_network.as_ref().zip(network_totals.as_ref())
        .and_then(|(previous, current)| network_rates(previous, current, elapsed))
        .map(|(download, upload)| (Some(download), Some(upload)))
        .unwrap_or((None, None));
    // A failed read breaks the counter interval. The next successful read starts
    // a new baseline rather than dividing a multi-interval delta by one interval.
    state.previous_network = network_totals;

    let cpu_status = if cpu_times.is_none() { "unavailable" } else if cpu_usage.is_some() { "available" } else { "sampling" };
    let network_status = if !network_available { "unavailable" } else if network_download.is_some() { "available" } else { "sampling" };
    let memory_status = if memory.is_some() { "available" } else { "unavailable" };
    let disk_status = if disks.is_empty() { "unavailable" } else { "available" };
    if cpu_times.is_none() && memory.is_none() && disks.is_empty() && !network_available {
        return Err("Windows 本机硬件指标均不可读取".into());
    }

    let memory = memory.unwrap_or(MemoryMetrics { used_bytes: None, total_bytes: None, usage_percent: None, status: memory_status.into() });
    Ok(HardwareSnapshot {
        sampled_at_unix_ms,
        cpu: CpuMetrics { usage_percent: cpu_usage, usage_status: cpu_status.into(), temperature_c: None, temperature_status: "unsupported".into() },
        memory,
        disks: DiskMetrics { volumes: disks, status: disk_status.into(), read_bytes_per_second: disk_io.0, write_bytes_per_second: disk_io.1, io_status: disk_io.2.into() },
        network: NetworkMetrics { upload_bytes_per_second: network_upload, download_bytes_per_second: network_download, status: network_status.into() },
        gpu: state.gpu.sample(now),
    })
}

#[cfg(windows)]
fn read_cpu_times() -> Result<CpuTimes, String> {
    use windows_sys::Win32::{Foundation::FILETIME, System::Threading::GetSystemTimes};
    let mut idle = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 { return Err("GetSystemTimes failed".into()); }
    Ok(CpuTimes { idle: filetime_value(idle), kernel: filetime_value(kernel), user: filetime_value(user) })
}

#[cfg(windows)]
fn filetime_value(value: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

#[cfg(windows)]
fn read_memory() -> Option<MemoryMetrics> {
    use std::mem::size_of;
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 || status.ullTotalPhys == 0 { return None; }
    let used = status.ullTotalPhys.saturating_sub(status.ullAvailPhys);
    Some(MemoryMetrics {
        used_bytes: Some(used),
        total_bytes: Some(status.ullTotalPhys),
        usage_percent: Some((used as f64 / status.ullTotalPhys as f64 * 100.0).clamp(0.0, 100.0)),
        status: "available".into(),
    })
}

#[cfg(windows)]
fn read_disks() -> Vec<DiskVolume> {
    use windows_sys::Win32::{Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives}, System::WindowsProgramming::DRIVE_FIXED};
    let drives = unsafe { GetLogicalDrives() };
    if drives == 0 { return Vec::new(); }
    let mut volumes = Vec::new();
    for index in 0..26 {
        if drives & (1 << index) == 0 { continue; }
        let letter = char::from(b'A' + index as u8);
        let root: Vec<u16> = format!("{letter}:\\").encode_utf16().chain(std::iter::once(0)).collect();
        if unsafe { GetDriveTypeW(root.as_ptr()) } != DRIVE_FIXED { continue; }
        let mut available = 0u64;
        let mut total = 0u64;
        let mut total_free = 0u64;
        if unsafe { GetDiskFreeSpaceExW(root.as_ptr(), &mut available, &mut total, &mut total_free) } == 0 || total == 0 { continue; }
        let used = total.saturating_sub(total_free);
        volumes.push(DiskVolume {
            name: format!("{letter}:"),
            used_bytes: used,
            total_bytes: total,
            usage_percent: (used as f64 / total as f64 * 100.0).clamp(0.0, 100.0),
            read_bytes_per_second: None, write_bytes_per_second: None, io_status: "sampling".into(),
        });
    }
    volumes
}

fn valid_disk_rate(value: f64) -> Option<f64> {
    (value.is_finite() && value >= 0.0).then_some(value)
}
fn aggregate_disk_io(volumes: &[DiskVolume]) -> (Option<f64>, Option<f64>, &'static str) {
    if volumes.is_empty() || volumes.iter().any(|v| v.io_status == "unavailable") { return (None, None, "unavailable"); }
    if volumes.iter().any(|v| v.io_status != "available") { return (None, None, "sampling"); }
    let total = volumes.iter().try_fold((0.0,0.0), |(read,write),v| {
        Some((valid_disk_rate(read + valid_disk_rate(v.read_bytes_per_second?)?)?,valid_disk_rate(write + valid_disk_rate(v.write_bytes_per_second?)?)?))
    });
    total.map(|(read,write)|(Some(read),Some(write),"available")).unwrap_or((None,None,"unavailable"))
}

#[cfg(windows)]
#[derive(Default)]
struct DiskIoSampler {
    // Opaque native handles are stored as integers and only used under HardwareSampler's mutex.
    // Closing the query releases all its counters; no live handle escapes this sampler.
    query: usize,
    counters: Vec<(String, usize, usize)>,
    previous_at: Option<Instant>,
}
#[cfg(windows)]
impl Drop for DiskIoSampler {
    fn drop(&mut self) { if self.query != 0 { unsafe { windows_sys::Win32::System::Performance::PdhCloseQuery(self.query as _); } } }
}
#[cfg(windows)]
impl DiskIoSampler {
    fn configure(&mut self, volumes: &[DiskVolume]) {
        use windows_sys::Win32::System::Performance::{PdhOpenQueryW,PdhAddEnglishCounterW};
        *self = Self::default();
        let mut query = std::ptr::null_mut();
        if unsafe { PdhOpenQueryW(std::ptr::null(),0,&mut query) } != 0 || query.is_null() { return; }
        self.query = query as usize;
        for volume in volumes {
            let add = |name: &str| {
                let path: Vec<u16> = format!(r"\LogicalDisk({})\{}",volume.name,name).encode_utf16().chain(std::iter::once(0)).collect();
                let mut counter = std::ptr::null_mut();
                if unsafe { PdhAddEnglishCounterW(query,path.as_ptr(),0,&mut counter) } == 0 { counter as usize } else { 0 }
            };
            self.counters.push((volume.name.clone(),add("Disk Read Bytes/sec"),add("Disk Write Bytes/sec")));
        }
    }
    fn sample(&mut self, volumes: &mut [DiskVolume], now: Instant) {
        use windows_sys::Win32::System::Performance::{PdhCollectQueryData,PdhGetFormattedCounterValue,PDH_FMT_DOUBLE,PDH_FMT_COUNTERVALUE,PDH_CSTATUS_VALID_DATA,PDH_CSTATUS_NEW_DATA};
        if self.query == 0 || self.counters.iter().map(|v|&v.0).ne(volumes.iter().map(|v|&v.name)) { self.configure(volumes); }
        if self.query == 0 || unsafe { PdhCollectQueryData(self.query as _) } != 0 {
            for volume in volumes { volume.io_status = "unavailable".into(); }
            *self = Self::default();
            return;
        }
        let interval = self.previous_at.map(|before|now.duration_since(before));
        self.previous_at = Some(now);
        let ready = interval.is_some_and(|elapsed|elapsed >= Duration::from_secs(1) && valid_counter_interval(elapsed));
        let read_counter = |counter: usize| -> Option<f64> {
            if counter == 0 { return None; }
            let mut value = PDH_FMT_COUNTERVALUE::default();
            if unsafe { PdhGetFormattedCounterValue(counter as _,PDH_FMT_DOUBLE,std::ptr::null_mut(),&mut value) } != 0 || ![PDH_CSTATUS_VALID_DATA,PDH_CSTATUS_NEW_DATA].contains(&value.CStatus) { return None; }
            valid_disk_rate(unsafe { value.Anonymous.doubleValue })
        };
        for (volume,(_,read,write)) in volumes.iter_mut().zip(&self.counters) {
            if *read == 0 || *write == 0 { volume.io_status = "unavailable".into();continue; }
            if !ready { volume.io_status = "sampling".into();continue; }
            match (read_counter(*read),read_counter(*write)) {
                (Some(read),Some(write)) => { volume.read_bytes_per_second=Some(read);volume.write_bytes_per_second=Some(write);volume.io_status="available".into(); },
                _ => { volume.io_status="unavailable".into(); },
            }
        }
    }
}

#[cfg(windows)]
struct MibTable(*mut windows_sys::Win32::NetworkManagement::IpHelper::MIB_IF_TABLE2);

#[cfg(windows)]
impl Drop for MibTable {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { windows_sys::Win32::NetworkManagement::IpHelper::FreeMibTable(self.0.cast()); }
        }
    }
}

#[cfg(windows)]
fn read_network_totals() -> Result<NetworkTotals, String> {
    use std::slice;
    use windows_sys::Win32::NetworkManagement::{IpHelper::{GetIfTable2, MIB_IF_TABLE2, IF_TYPE_SOFTWARE_LOOPBACK}, Ndis::IfOperStatusUp};
    let mut raw: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    let result = unsafe { GetIfTable2(&mut raw) };
    if result != 0 || raw.is_null() { return Err(format!("GetIfTable2 failed: {result}")); }
    let table = MibTable(raw);
    let view = unsafe { &*table.0 };
    let rows = unsafe { slice::from_raw_parts(view.Table.as_ptr(), view.NumEntries as usize) };
    let mut interfaces = Vec::new();
    for row in rows {
        let hardware = row.InterfaceAndOperStatusFlags._bitfield & 1 != 0;
        if !hardware || row.OperStatus != IfOperStatusUp || row.Type == IF_TYPE_SOFTWARE_LOOPBACK { continue; }
        interfaces.push(NetworkInterfaceCounters { luid: unsafe { row.InterfaceLuid.Value }, index: row.InterfaceIndex,
            received: row.InOctets, sent: row.OutOctets });
    }
    if interfaces.is_empty() { return Err("no active hardware network interfaces".into()); }
    interfaces.sort_unstable_by_key(|interface| (interface.luid, interface.index));
    Ok(NetworkTotals { interfaces })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_io_totals_require_all_volumes_and_finite_nonnegative_rates() {
        let volume = |name: &str, read: Option<f64>, write: Option<f64>, status: &str| DiskVolume {name:name.into(),used_bytes:1,total_bytes:2,usage_percent:50.0,read_bytes_per_second:read,write_bytes_per_second:write,io_status:status.into()};
        let c=volume("C:",Some(100.0),Some(200.0),"available");let d=volume("D:",Some(300.0),Some(400.0),"available");
        assert_eq!(aggregate_disk_io(&[c.clone(),d]),(Some(400.0),Some(600.0),"available"));
        assert_eq!(aggregate_disk_io(&[c.clone(),volume("D:",None,None,"sampling")]),(None,None,"sampling"));
        assert_eq!(aggregate_disk_io(&[c,volume("D:",None,None,"unavailable")]),(None,None,"unavailable"));
        assert_eq!(aggregate_disk_io(&[]),(None,None,"unavailable"));
        for value in [f64::NAN,f64::INFINITY,-1.0] { assert_eq!(valid_disk_rate(value),None); }
        assert_eq!(valid_disk_rate(0.0),Some(0.0));
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "reads actual local Windows disk performance counters"]
    fn native_disk_io_reads_two_samples() {
        let mut sampler=DiskIoSampler::default();let mut volumes=read_disks();assert!(!volumes.is_empty());
        sampler.sample(&mut volumes,Instant::now());
        assert!(volumes.iter().all(|v|v.read_bytes_per_second.is_none()&&v.write_bytes_per_second.is_none()));
        std::thread::sleep(Duration::from_millis(1200));
        let mut volumes=read_disks();sampler.sample(&mut volumes,Instant::now());
        for volume in &volumes { println!("{} read={:?} B/s write={:?} B/s status={}",volume.name,volume.read_bytes_per_second,volume.write_bytes_per_second,volume.io_status); }
        assert_eq!(aggregate_disk_io(&volumes).2,"available");
    }

    #[test]
    fn cpu_usage_is_calculated_from_kernel_user_and_idle_deltas() {
        let previous = CpuTimes { idle: 100, kernel: 400, user: 300 };
        let current = CpuTimes { idle: 200, kernel: 600, user: 500 };
        assert_eq!(cpu_usage_percent(previous, current), Some(75.0));
        assert_eq!(cpu_usage_percent(current, previous), None);
    }

    #[test]
    fn network_rates_use_counter_deltas_and_elapsed_time() {
        let previous = network(1, 1_000, 4_000);
        let current = network(1, 3_000, 5_000);
        assert_eq!(network_rates(&previous, &current, Duration::from_secs(2)), Some((1_000.0, 500.0)));
        assert_eq!(network_rates(&current, &previous, Duration::from_secs(2)), None);
    }

    fn network(luid: u64, received: u64, sent: u64) -> NetworkTotals {
        NetworkTotals { interfaces: vec![NetworkInterfaceCounters { luid, index: 1, received, sent }] }
    }

    #[test]
    fn adapter_changes_and_long_sampling_pauses_reset_counter_rates() {
        let previous = network(1, 1_000, 4_000);
        assert_eq!(network_rates(&previous, &network(2, 30_000, 50_000), Duration::from_secs(2)), None);
        assert_eq!(network_rates(&previous, &network(1, 30_000, 50_000), Duration::from_secs(61)), None);
        assert!(!valid_counter_interval(Duration::ZERO));
        assert!(valid_counter_interval(Duration::from_secs(15)));
        assert!(!valid_counter_interval(Duration::from_secs(61)));
        let before = NetworkTotals { interfaces: vec![previous.interfaces[0].clone(), NetworkInterfaceCounters { luid: 2, index: 2, received: 10, sent: 10 }] };
        let after = NetworkTotals { interfaces: vec![NetworkInterfaceCounters { luid: 1, index: 1, received: 0, sent: 0 },
            NetworkInterfaceCounters { luid: 2, index: 2, received: 100_000, sent: 100_000 }] };
        assert_eq!(network_rates(&before, &after, Duration::from_secs(2)), None);
    }
}
