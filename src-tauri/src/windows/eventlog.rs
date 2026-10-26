use serde::Serialize;
use std::time::Duration;
use crate::provider_requests::{RequestCache, observed_unix_ms};

const MAX_EVENTS_PER_CHANNEL: usize = 100;
const MAX_EVENT_MESSAGE_CHARS: usize = 2_000;
const MAX_RENDER_BYTES: usize = 256 * 1024;
const SYSTEM_QUERY: &str = "*[System[TimeCreated[timediff(@SystemTime) <= 604800000] and (((Level=1 or Level=2) and (Provider[@Name='Microsoft-Windows-Kernel-Power'] or Provider[@Name='Microsoft-Windows-WHEA-Logger'] or Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting'] or Provider[@Name='BugCheck'] or Provider[@Name='Display'] or Provider[@Name='nvlddmkm'] or Provider[@Name='Disk'] or Provider[@Name='Ntfs'])) or (Provider[@Name='Microsoft-Windows-Kernel-Power'] and EventID=41) or (Provider[@Name='Microsoft-Windows-WHEA-Logger'] and (EventID=17 or EventID=18 or EventID=19 or EventID=20)) or (Provider[@Name='Display'] and EventID=4101) or (Provider[@Name='Disk'] and (EventID=7 or EventID=11 or EventID=51 or EventID=153)) or (Provider[@Name='Ntfs'] and EventID=55))]]";
const APPLICATION_QUERY: &str = "*[System[TimeCreated[timediff(@SystemTime) <= 604800000] and (((Level=1 or Level=2) and (Provider[@Name='Application Error'] or Provider[@Name='Application Hang'] or Provider[@Name='Windows Error Reporting'])) or (Provider[@Name='Application Error'] and EventID=1000) or (Provider[@Name='Application Hang'] and EventID=1002) or (Provider[@Name='Windows Error Reporting'] and EventID=1001))]]";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemEvent {
    pub id: String,
    pub timestamp: String,
    pub channel: String,
    pub record_id: String,
    pub source: String,
    pub event_id: u32,
    pub level: String,
    pub category: String,
    pub message: String,
    pub severity: String,
    pub related_process: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventLogScan {
    pub scanned_at_unix_ms: u64,
    pub status: &'static str,
    pub warnings: Vec<String>,
    pub events: Vec<SystemEvent>,
}

pub fn read_recent_events(limit: Option<usize>) -> Result<EventLogScan, String> {
    #[cfg(windows)]
    {
        let limit = limit.unwrap_or(60).clamp(1, MAX_EVENTS_PER_CHANNEL);
        let system_result = windows::read_channel("System", SYSTEM_QUERY, limit);
        let application_result = windows::read_channel("Application", APPLICATION_QUERY, limit);
        let mut warnings = Vec::new();
        let mut events = Vec::new();
        let successful_channels = if system_result.is_ok() { 1 } else { 0 }
            + if application_result.is_ok() { 1 } else { 0 };

        match system_result {
            Ok(mut result) => events.append(&mut result),
            Err(error) => warnings.push(error),
        }
        match application_result {
            Ok(mut result) => events.append(&mut result),
            Err(error) => warnings.push(error),
        }

        events.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
        events.dedup_by(|left, right| left.id == right.id);
        events.truncate(limit.saturating_mul(2));
        let status = if successful_channels == 0 { "unavailable" }
            else if warnings.is_empty() { "ok" }
            else { "partial" };
        Ok(EventLogScan { scanned_at_unix_ms: observed_unix_ms(), status, warnings, events })
    }
    #[cfg(not(windows))]
    {
        let _ = limit;
        Err("Windows Event Log 仅能在 Windows 桌面应用中读取".into())
    }
}

fn is_high_value(channel: &str, source: &str, event_id: u32, level: u32) -> bool {
    if channel.eq_ignore_ascii_case("Application") {
        let app_event = (source.eq_ignore_ascii_case("Application Error") && event_id == 1000)
            || (source.eq_ignore_ascii_case("Application Hang") && event_id == 1002)
            || (source.eq_ignore_ascii_case("Windows Error Reporting") && event_id == 1001);
        return app_event && (1..=3).contains(&level);
    }
    if !channel.eq_ignore_ascii_case("System") { return false; }

    if level == 1 || level == 2 {
        return [
            "Microsoft-Windows-Kernel-Power", "Microsoft-Windows-WHEA-Logger",
            "Microsoft-Windows-WER-SystemErrorReporting", "BugCheck", "Display",
            "nvlddmkm", "Disk", "Ntfs",
        ].iter().any(|known| source.eq_ignore_ascii_case(known));
    }
    if level != 3 { return false; }

    (source.eq_ignore_ascii_case("Microsoft-Windows-Kernel-Power") && event_id == 41)
        || (source.eq_ignore_ascii_case("Microsoft-Windows-WHEA-Logger") && matches!(event_id, 17 | 18 | 19 | 20))
        || (source.eq_ignore_ascii_case("Display") && event_id == 4101)
        || (source.eq_ignore_ascii_case("Disk") && matches!(event_id, 7 | 11 | 51 | 153))
        || (source.eq_ignore_ascii_case("Ntfs") && event_id == 55)
}

fn parse_event_xml(channel: &str, xml: &str, rendered_message: Option<String>) -> Option<SystemEvent> {
    let source = xml_attribute(xml, "Provider", "Name")?;
    let event_id = element_text(xml, "EventID")?.parse::<u32>().ok()?;
    let level_number = element_text(xml, "Level")?.parse::<u32>().ok()?;
    if !is_high_value(channel, &source, event_id, level_number) { return None; }
    let timestamp = xml_attribute(xml, "TimeCreated", "SystemTime")?;
    let record_id = element_text(xml, "EventRecordID")?;
    let category = event_category(channel, &source, event_id);
    let level = match level_number { 1 => "严重", 2 => "错误", _ => "警告" }.to_string();
    let severity = match level_number { 1 => "critical", 2 => "error", _ => "warning" }.to_string();
    let message = rendered_message.filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback_message(event_id, xml));
    let message = compact_message(&message, MAX_EVENT_MESSAGE_CHARS);
    let related_process = related_process(xml);
    let id = format!("{channel}:{record_id}:{timestamp}");

    Some(SystemEvent {
        id, timestamp, channel: channel.into(), record_id, source, event_id,
        level, category, message, severity, related_process,
    })
}

fn event_category(channel: &str, source: &str, event_id: u32) -> String {
    if channel.eq_ignore_ascii_case("Application") {
        return if source.eq_ignore_ascii_case("Application Hang") || event_id == 1002 { "应用无响应" }
            else { "应用崩溃" }.into();
    }
    if source.eq_ignore_ascii_case("Microsoft-Windows-Kernel-Power") && event_id == 41 { "非正常关机记录" }
    else if source.eq_ignore_ascii_case("Microsoft-Windows-WHEA-Logger") { "硬件错误记录" }
    else if source.eq_ignore_ascii_case("Microsoft-Windows-WER-SystemErrorReporting") || source.eq_ignore_ascii_case("BugCheck") { "蓝屏记录" }
    else if source.eq_ignore_ascii_case("Display") || source.eq_ignore_ascii_case("nvlddmkm") { "显示驱动事件" }
    else if source.eq_ignore_ascii_case("Disk") || source.eq_ignore_ascii_case("Ntfs") { "磁盘事件" }
    else { "系统事件" }.into()
}

fn fallback_message(event_id: u32, xml: &str) -> String {
    let mut values = Vec::new();
    let mut remainder = xml;
    while values.len() < 8 {
        let Some(start) = remainder.find("<Data") else { break; };
        let Some(open_end_relative) = remainder[start..].find('>') else { break; };
        let value_start = start + open_end_relative + 1;
        let Some(end_relative) = remainder[value_start..].find("</Data>") else { break; };
        let value = decode_xml(&remainder[value_start..value_start + end_relative]);
        if !value.trim().is_empty() { values.push(value.trim().to_string()); }
        remainder = &remainder[value_start + end_relative + 7..];
    }
    if values.is_empty() { format!("事件消息暂不可用 · Event ID {event_id}") }
    else { format!("Event ID {event_id} · {}", values.join(" · ")) }
}

fn related_process(xml: &str) -> Option<String> {
    ["AppName", "ApplicationName", "ProcessName", "param1"]
        .iter().find_map(|name| named_data(xml, name))
        .filter(|value| !value.trim().is_empty())
        .map(|value| compact_message(&value, 260))
}

fn named_data(xml: &str, name: &str) -> Option<String> {
    let mut remainder = xml;
    while let Some(start) = remainder.find("<Data") {
        let open_end = remainder[start..].find('>')? + start;
        let opening = &remainder[start..=open_end];
        if xml_attribute(opening, "Data", "Name").as_deref() == Some(name) {
            let value_start = open_end + 1;
            let end = remainder[value_start..].find("</Data>")? + value_start;
            return Some(decode_xml(&remainder[value_start..end]));
        }
        remainder = &remainder[open_end + 1..];
    }
    None
}

fn element_text(xml: &str, name: &str) -> Option<String> {
    let opening_tag = format!("<{name}");
    let start = xml.find(&opening_tag)?;
    let open_end = xml[start..].find('>')? + start;
    let closing_tag = format!("</{name}>");
    let end = xml[open_end + 1..].find(&closing_tag)? + open_end + 1;
    Some(decode_xml(xml[open_end + 1..end].trim()))
}

fn xml_attribute(xml: &str, element: &str, attribute: &str) -> Option<String> {
    let opening_tag = format!("<{element}");
    let start = xml.find(&opening_tag)?;
    let boundary=xml.as_bytes().get(start+opening_tag.len())?;
    if !boundary.is_ascii_whitespace() && !b"/>".contains(boundary){return None;}
    let end = xml[start..].find('>')? + start;
    let opening = &xml[start+opening_tag.len()..end];
    for (position,_) in opening.match_indices(attribute){
        if position>0 && !opening.as_bytes()[position-1].is_ascii_whitespace(){continue;}
        let after=opening[position+attribute.len()..].trim_start();
        let Some(after)=after.strip_prefix('=') else{continue;};
        let after=after.trim_start();let quote=after.chars().next()?;
        if quote!='\'' && quote!='"'{return None;}
        let value=&after[1..];let value_end=value.find(quote)?;
        return Some(decode_xml(&value[..value_end]));
    }
    None
}


fn decode_xml(value: &str) -> String {
    value.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn compact_message(value: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(max_chars).collect()
}

#[tauri::command]
pub async fn read_windows_events(state: tauri::State<'_, EventLogState>, limit: Option<usize>) -> Result<EventLogScan, String> {
    let cache = state.cache.clone();
    let limit = limit.unwrap_or(60).clamp(1, MAX_EVENTS_PER_CHANNEL);
    tauri::async_runtime::spawn_blocking(move || cache.read(limit, Duration::from_secs(60), Duration::from_millis(500), || {
        let scan = read_recent_events(Some(limit))?;
        if scan.status == "unavailable" { return Err(scan.warnings.join("；")); }
        Ok(scan)
    }))
        .await.map_err(|_| "Windows 日志读取任务无法完成".to_string())?
}

#[derive(Default)]
pub struct EventLogState { cache: RequestCache<usize, EventLogScan> }
impl EventLogState {
    pub fn metrics(&self) -> Option<crate::provider_requests::RequestMetrics> { self.cache.metrics() }
}

#[cfg(windows)]
mod windows {
    use super::{parse_event_xml, MAX_RENDER_BYTES};
    use std::{collections::HashMap, ffi::c_void, ptr};

    type EvtHandle = *mut c_void;
    const EVT_QUERY_CHANNEL_PATH: u32 = 0x1;
    const EVT_QUERY_REVERSE_DIRECTION: u32 = 0x200;
    const EVT_RENDER_EVENT_XML: u32 = 0x1;
    const EVT_FORMAT_MESSAGE_EVENT: u32 = 0x1;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const ERROR_NO_MORE_ITEMS: u32 = 259;
    const ERROR_ACCESS_DENIED: u32 = 5;

    #[link(name = "wevtapi")]
    unsafe extern "system" {
        fn EvtQuery(session: EvtHandle, path: *const u16, query: *const u16, flags: u32) -> EvtHandle;
        fn EvtNext(results: EvtHandle, size: u32, events: *mut EvtHandle, timeout: u32, flags: u32, returned: *mut u32) -> i32;
        fn EvtRender(context: EvtHandle, fragment: EvtHandle, flags: u32, buffer_size: u32, buffer: *mut c_void, buffer_used: *mut u32, property_count: *mut u32) -> i32;
        fn EvtOpenPublisherMetadata(session: EvtHandle, publisher: *const u16, log_path: *const u16, locale: u32, flags: u32) -> EvtHandle;
        fn EvtFormatMessage(metadata: EvtHandle, event: EvtHandle, message_id: u32, value_count: u32, values: *const c_void, flags: u32, buffer_size: u32, buffer: *mut u16, buffer_used: *mut u32) -> i32;
        fn EvtClose(handle: EvtHandle) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" { fn GetLastError() -> u32; }

    struct SafeHandle(EvtHandle);
    impl Drop for SafeHandle {
        fn drop(&mut self) { if !self.0.is_null() { unsafe { EvtClose(self.0); } } }
    }

    pub fn read_channel(channel: &str, query: &str, limit: usize) -> Result<Vec<super::SystemEvent>, String> {
        let channel_wide = wide(channel);
        let query_wide = wide(query);
        let results = unsafe { EvtQuery(ptr::null_mut(), channel_wide.as_ptr(), query_wide.as_ptr(), EVT_QUERY_CHANNEL_PATH | EVT_QUERY_REVERSE_DIRECTION) };
        if results.is_null() { return Err(format_error(channel, unsafe { GetLastError() })); }
        let results = SafeHandle(results);
        let mut events_out = Vec::new();
        let mut publisher_cache: HashMap<String, SafeHandle> = HashMap::new();
        let scan_cap = limit.saturating_mul(4).clamp(32, 400);
        let mut examined = 0usize;

        while events_out.len() < limit && examined < scan_cap {
            let batch_size = (scan_cap - examined).min(24).max(1);
            let mut handles = vec![ptr::null_mut(); batch_size];
            let mut returned = 0u32;
            let ok = unsafe { EvtNext(results.0, batch_size as u32, handles.as_mut_ptr(), 0, 0, &mut returned) };
            if ok == 0 {
                let error = unsafe { GetLastError() };
                if error == ERROR_NO_MORE_ITEMS { break; }
                return Err(format_error(channel, error));
            }
            if returned == 0 { break; }
            examined += returned as usize;

            let batch: Vec<SafeHandle> = handles.into_iter().take(returned as usize).map(SafeHandle).collect();
            for event in batch {
                let Some(xml) = render_xml(event.0) else { continue; };
                let source = super::xml_attribute(&xml, "Provider", "Name").unwrap_or_default();
                let formatted = format_message(event.0, &source, &mut publisher_cache);
                if let Some(parsed) = parse_event_xml(channel, &xml, formatted) { events_out.push(parsed); }
                if events_out.len() >= limit { break; }
            }
        }
        Ok(events_out)
    }

    fn render_xml(event: EvtHandle) -> Option<String> {
        let mut needed = 0u32;
        let mut properties = 0u32;
        unsafe { EvtRender(ptr::null_mut(), event, EVT_RENDER_EVENT_XML, 0, ptr::null_mut(), &mut needed, &mut properties); }
        if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || needed == 0 || needed as usize > MAX_RENDER_BYTES { return None; }
        let mut buffer = vec![0u16; needed as usize / 2 + 1];
        let ok = unsafe { EvtRender(ptr::null_mut(), event, EVT_RENDER_EVENT_XML, (buffer.len() * 2) as u32, buffer.as_mut_ptr() as *mut c_void, &mut needed, &mut properties) };
        if ok == 0 { return None; }
        Some(String::from_utf16_lossy(&buffer).trim_end_matches('\0').to_string())
    }

    fn format_message(event: EvtHandle, source: &str, cache: &mut HashMap<String, SafeHandle>) -> Option<String> {
        if source.is_empty() { return None; }
        if !cache.contains_key(source) {
            let publisher = wide(source);
            let metadata = unsafe { EvtOpenPublisherMetadata(ptr::null_mut(), publisher.as_ptr(), ptr::null(), 0, 0) };
            if metadata.is_null() { return None; }
            cache.insert(source.to_string(), SafeHandle(metadata));
        }
        let metadata = cache.get(source)?.0;
        let mut needed = 0u32;
        unsafe { EvtFormatMessage(metadata, event, 0, 0, ptr::null(), EVT_FORMAT_MESSAGE_EVENT, 0, ptr::null_mut(), &mut needed); }
        if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || needed == 0 || needed > 8_192 { return None; }
        let mut buffer = vec![0u16; needed as usize + 1];
        let ok = unsafe { EvtFormatMessage(metadata, event, 0, 0, ptr::null(), EVT_FORMAT_MESSAGE_EVENT, buffer.len() as u32, buffer.as_mut_ptr(), &mut needed) };
        if ok == 0 { return None; }
        let message = String::from_utf16_lossy(&buffer).trim_end_matches('\0').to_string();
        let message = message.trim().to_string();
        if message.is_empty() { None } else { Some(message) }
    }

    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(std::iter::once(0)).collect() }

    fn format_error(channel: &str, error: u32) -> String {
        if error == ERROR_ACCESS_DENIED { format!("当前用户没有读取 {channel} 事件日志的权限") }
        else { format!("读取 {channel} 事件日志失败（Windows 错误 {error}）") }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_high_value, parse_event_xml, APPLICATION_QUERY, SYSTEM_QUERY};

    #[cfg(windows)]
    #[test]
    #[ignore = "reads this Windows machine's event logs"]
    fn native_concurrent_scans_share_one_real_read() {
        use super::{Duration, EventLogState, read_recent_events};
        use std::sync::{Arc, Barrier, atomic::{AtomicUsize, Ordering}};
        let state = EventLogState::default();
        let barrier = Arc::new(Barrier::new(8));
        let loads = Arc::new(AtomicUsize::new(0));
        let workers: Vec<_> = (0..8).map(|_| {
            let (cache, barrier, loads) = (state.cache.clone(), barrier.clone(), loads.clone());
            std::thread::spawn(move || {
                barrier.wait();
                cache.read(60, Duration::from_secs(60), Duration::from_millis(500), || {
                    loads.fetch_add(1, Ordering::SeqCst);
                    read_recent_events(Some(60))
                }).unwrap()
            })
        }).collect();
        let scans: Vec<_> = workers.into_iter().map(|worker| worker.join().unwrap()).collect();
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        let first = &scans[0];
        assert!(first.status == "ok" || first.status == "partial");
        for scan in &scans {
            assert_eq!(scan.scanned_at_unix_ms, first.scanned_at_unix_ms);
            assert_eq!(scan.events.iter().map(|event| &event.id).collect::<Vec<_>>(), first.events.iter().map(|event| &event.id).collect::<Vec<_>>());
        }
        println!("native event log requests=8 loads={} status={} events={} scannedAtUnixMs={}", loads.load(Ordering::SeqCst), first.status, first.events.len(), first.scanned_at_unix_ms);
        // No event messages, process names, or full records are printed.
    }

    fn sample_xml(source: &str, event_id: u32, level: u32) -> String {
        format!(r#"<Event><System><Provider Name="{source}"/><EventID>{event_id}</EventID><Level>{level}</Level><TimeCreated SystemTime="2026-10-04T08:20:00.000Z"/><EventRecordID>912</EventRecordID><Channel>System</Channel></System><EventData><Data Name="AppName">demo.exe</Data></EventData></Event>"#)
    }

    #[test]
    fn filters_only_known_high_value_events() {
        assert!(is_high_value("System", "Microsoft-Windows-Kernel-Power", 41, 3));
        assert!(is_high_value("System", "Microsoft-Windows-WHEA-Logger", 17, 3));
        assert!(is_high_value("System", "Display", 4101, 3));
        assert!(is_high_value("Application", "Application Error", 1000, 2));
        assert!(is_high_value("Application", "Windows Error Reporting", 1001, 3));
        assert!(is_high_value("Application", "Application Hang", 1002, 3));
        assert!(!is_high_value("System", "Unrelated-Provider", 1, 2));
        assert!(!is_high_value("System", "Microsoft-Windows-Kernel-Power", 42, 3));
        assert!(!is_high_value("Application", "Application Error", 1000, 4));
    }

    #[test]
    fn event_log_queries_have_balanced_xpath_predicates() {
        for query in [SYSTEM_QUERY, APPLICATION_QUERY] {
            let mut parentheses = 0i32;
            let mut brackets = 0i32;
            for character in query.chars() {
                match character {
                    '(' => parentheses += 1,
                    ')' => parentheses -= 1,
                    '[' => brackets += 1,
                    ']' => brackets -= 1,
                    _ => {}
                }
                assert!(parentheses >= 0 && brackets >= 0, "unbalanced query: {query}");
            }
            assert_eq!(parentheses, 0, "unbalanced parentheses: {query}");
            assert_eq!(brackets, 0, "unbalanced predicates: {query}");
        }
    }

    #[test]
    fn parses_selected_event_fields_and_falls_back_to_event_data() {
        let xml = sample_xml("Application Error", 1000, 2);
        let event = parse_event_xml("Application", &xml, None).unwrap();
        assert_eq!(event.id, "Application:912:2026-10-04T08:20:00.000Z");
        assert_eq!(event.category, "应用崩溃");
        assert_eq!(event.severity, "error");
        assert!(event.message.contains("demo.exe"));
        assert_eq!(event.related_process.as_deref(), Some("demo.exe"));
        assert!(parse_event_xml("Application", &sample_xml("Other", 1000, 2), None).is_none());
    }

    #[test]
    fn native_single_quoted_attributes_and_spaces_are_supported(){
        let xml=sample_xml("Application Error",1000,2).replace('"',"'");
        let event=parse_event_xml("Application",&xml,None).unwrap();
        assert_eq!(event.source,"Application Error");assert_eq!(event.related_process.as_deref(),Some("demo.exe"));
        assert_eq!(super::xml_attribute("<Provider OtherName='wrong' Name = 'Application Error'/>","Provider","Name"),Some("Application Error".into()));
        assert_eq!(super::xml_attribute("<ProviderAlias Name='wrong'/>","Provider","Name"),None);
        assert_eq!(super::xml_attribute("<Provider Name='unterminated>","Provider","Name"),None);
    }
}
