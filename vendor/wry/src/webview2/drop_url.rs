// SPDX-License-Identifier: Apache-2.0 OR MIT
// Shared pure decoding for the bounded Windows URL drop bridge.
pub fn decode_wide_url(units: &[u16]) -> Option<String> {
    let end = units.iter().position(|unit| *unit == 0)?;
    if end > 4096 { return None; }
    accepted_url(String::from_utf16(&units[..end]).ok()?)
}
pub fn decode_ascii_url(bytes: &[u8]) -> Option<String> {
    let end = bytes.iter().position(|byte| *byte == 0)?;
    if end > 4096 || !bytes[..end].is_ascii() { return None; }
    accepted_url(String::from_utf8(bytes[..end].to_vec()).ok()?)
}
fn accepted_url(value: String) -> Option<String> {
    let value = value.trim();
    if value.len() > 2000 || value.chars().any(char::is_control) { return None; }
    let lower = value.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")).then(|| value.to_owned())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_bounded_terminated_http_urls_and_preserves_case() {
        let wide: Vec<_> = "https://example.com/Path\0".encode_utf16().collect();
        assert_eq!(decode_wide_url(&wide).as_deref(), Some("https://example.com/Path"));
        assert_eq!(decode_ascii_url(b"http://example.com/\0").as_deref(), Some("http://example.com/"));
        for value in ["javascript:alert(1)\0", "file:///C:/private\0", "C:\\app.exe\0", "https://example.com/\nother\0"] {
            assert!(decode_wide_url(&value.encode_utf16().collect::<Vec<_>>()).is_none());
        }
        assert!(decode_wide_url(&[0xd800,0]).is_none());
        assert!(decode_ascii_url(b"https://example.com/").is_none());
        assert!(decode_wide_url(&format!("https://example.com/{}\0", "a".repeat(2100)).encode_utf16().collect::<Vec<_>>()).is_none());
    }
}
