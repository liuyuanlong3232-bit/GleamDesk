use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub(crate) const MAX_READ_BYTES: usize = 256 * 1024;
pub(crate) const MAX_SEARCH_MATCHES: usize = 100;
const MAX_DIRECTORY_ENTRIES: usize = 200;
const MAX_SEARCH_FILES: usize = 500;
const MAX_SEARCH_BYTES: usize = 24 * 1024 * 1024;
const MAX_EDIT_BYTES: usize = 256 * 1024;
const MAX_EDIT_FRAGMENT_BYTES: usize = 32 * 1024;
const MAX_PATH_BYTES: usize = 2048;
static NEXT_EDIT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceEntry { pub(crate) path: String, pub(crate) name: String, pub(crate) is_directory: bool }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchMatch { pub(crate) path: String, pub(crate) line: usize, pub(crate) text: String }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingEdit { pub(crate) id: String, pub(crate) path: String, pub(crate) before: String, pub(crate) after: String }

#[derive(Clone, Debug)]
pub(crate) struct WorkspaceRoot { root: PathBuf }

impl WorkspaceRoot {
    pub(crate) fn new(path: &str) -> Result<Self, String> {
        if path.trim().is_empty() || path.len() > MAX_PATH_BYTES { return Err("工作目录无效".into()); }
        let root = Path::new(path.trim()).canonicalize().map_err(|_| "工作目录不存在或无法读取")?;
        if !root.is_dir() { return Err("所选工作目录不是文件夹".into()); }
        Ok(Self { root })
    }

    pub(crate) fn canonical_path(&self) -> &Path { &self.root }

    fn relative(&self, value: &str, allow_root: bool) -> Result<(PathBuf, String), String> {
        if value.len() > MAX_PATH_BYTES || value.chars().any(char::is_control) || value.starts_with('/') || value.starts_with('\\') {
            return Err("只能使用工作目录内的相对路径".into());
        }
        let path = Path::new(value);
        if path.is_absolute() { return Err("绝对路径不在所选工作目录内".into()); }
        let mut clean = PathBuf::new();
        let mut display = Vec::new();
        for component in path.components() {
            match component {
                Component::Normal(part) => {
                    let part = part.to_string_lossy();
                    if part.contains(':') || part.is_empty() { return Err("路径包含不支持的字符".into()); }
                    if hidden_path_component(&part) { return Err("此类敏感或生成文件不可访问".into()); }
                    clean.push(part.as_ref()); display.push(part.replace('\\', "/"));
                }
                Component::CurDir => {}
                _ => return Err("不允许离开所选工作目录".into()),
            }
        }
        if clean.as_os_str().is_empty() && !allow_root { return Err("需要指定工作目录内的文件".into()); }
        Ok((clean, display.join("/")))
    }

    fn resolve(&self, value: &str, allow_root: bool) -> Result<(PathBuf, String), String> {
        let (relative, display) = self.relative(value, allow_root)?;
        let mut candidate = self.root.clone();
        for component in relative.components() {
            let Component::Normal(part) = component else { return Err("工作区路径无效".into()) };
            candidate.push(part);
            let metadata = fs::symlink_metadata(&candidate).map_err(|_| "工作区路径不存在或无法读取")?;
            if is_link_or_reparse(&metadata) { return Err("工作区不跟随符号链接或重解析点".into()); }
        }
        let canonical = candidate.canonicalize().map_err(|_| "工作区路径不存在或无法读取")?;
        if !path_within(&self.root, &canonical) { return Err("路径越出了所选工作目录".into()); }
        let metadata=fs::metadata(&canonical).map_err(|_|"无法读取工作区路径")?;
        if metadata.is_file()&&file_is_hard_link(&canonical,&metadata){return Err("工作区不读取或修改硬链接文件".into());}
        Ok((canonical, display))
    }

    pub(crate) fn list_files(&self, relative_path: &str) -> Result<Vec<WorkspaceEntry>, String> {
        let (directory, parent) = self.resolve(relative_path, true)?;
        if !directory.is_dir() { return Err("指定路径不是文件夹".into()); }
        let mut entries = Vec::new();
        for item in fs::read_dir(directory).map_err(|_| "无法读取文件夹")? {
            let item = item.map_err(|_| "无法读取文件夹条目")?;
            let name = item.file_name().to_string_lossy().into_owned();
            let metadata = fs::symlink_metadata(item.path()).map_err(|_| "无法读取文件夹条目")?;
            if is_link_or_reparse(&metadata) || hidden_path_component(&name) { continue; }
            if !metadata.is_file() && !metadata.is_dir() { continue; }
            let path = if parent.is_empty() { name.clone() } else { format!("{parent}/{name}") };
            entries.push(WorkspaceEntry { path, name, is_directory: metadata.is_dir() });
            if entries.len() >= MAX_DIRECTORY_ENTRIES { break; }
        }
        entries.sort_by(|a,b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(entries)
    }

    pub(crate) fn read_text(&self, relative_path: &str) -> Result<String, String> {
        let (path, _) = self.resolve(relative_path, false)?;
        let metadata = fs::metadata(&path).map_err(|_| "无法读取文件")?;
        if !metadata.is_file() { return Err("指定路径不是普通文件".into()); }
        if metadata.len() as usize > MAX_READ_BYTES { return Err("文件超过本机任务单文件读取上限".into()); }
        let bytes = fs::read(path).map_err(|_| "无法读取文件")?;
        let text = String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 文本，未发送给模型")?;
        validate_text_content(&text)?;
        Ok(text)
    }

    pub(crate) fn search_text(&self, query: &str, relative_path: &str) -> Result<Vec<SearchMatch>, String> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 200 || query.chars().any(char::is_control) {
            return Err("搜索内容不能为空，且最多 200 字".into());
        }
        let (start, display) = self.resolve(relative_path, true)?;
        if !start.is_dir() { return Err("搜索范围不是文件夹".into()); }
        let needle = query.to_lowercase();
        let mut pending = vec![(start, display, 0usize)];
        let mut scanned_files = 0usize;
        let mut scanned_bytes = 0usize;
        let mut results = Vec::new();
        while let Some((directory, relative, depth)) = pending.pop() {
            if depth > 16 || results.len() >= MAX_SEARCH_MATCHES { continue; }
            let Ok(entries) = fs::read_dir(&directory) else { continue };
            for item in entries.flatten() {
                if results.len() >= MAX_SEARCH_MATCHES || scanned_files >= MAX_SEARCH_FILES || scanned_bytes >= MAX_SEARCH_BYTES { break; }
                let name = item.file_name().to_string_lossy().into_owned();
                if hidden_path_component(&name) { continue; }
                let metadata = match fs::symlink_metadata(item.path()) { Ok(value) if !is_link_or_reparse(&value) => value, _ => continue };
                let child_relative = if relative.is_empty() { name.clone() } else { format!("{relative}/{name}") };
                if metadata.is_dir() { pending.push((item.path(), child_relative, depth + 1)); continue; }
                if !metadata.is_file() || metadata.len() > 512 * 1024 { continue; }
                if file_is_hard_link(&item.path(), &metadata) { continue; }
                scanned_files += 1;
                scanned_bytes = scanned_bytes.saturating_add(metadata.len() as usize);
                let Ok(bytes) = fs::read(item.path()) else { continue };
                let Ok(text) = String::from_utf8(bytes) else { continue };
                if validate_text_content(&text).is_err() { continue; }
                for (line_number, line) in text.lines().enumerate() {
                    if line.to_lowercase().contains(&needle) {
                        results.push(SearchMatch { path: child_relative.clone(), line: line_number + 1, text: line.chars().take(500).collect() });
                        if results.len() >= MAX_SEARCH_MATCHES { break; }
                    }
                }
            }
        }
        Ok(results)
    }

    pub(crate) fn propose_edit(&self, relative_path: &str, old_text: &str, new_text: &str) -> Result<PendingEdit, String> {
        if old_text.is_empty() || old_text.len() > MAX_EDIT_FRAGMENT_BYTES || new_text.len() > MAX_EDIT_FRAGMENT_BYTES
            || old_text.chars().any(|c| c == '\0') || new_text.chars().any(|c| c == '\0') {
            return Err("修改内容为空或超过本机任务上限".into());
        }
        let (path, display) = self.resolve(relative_path, false)?;
        let metadata = fs::metadata(&path).map_err(|_| "无法读取待修改文件")?;
        if !metadata.is_file() || metadata.len() as usize > MAX_EDIT_BYTES { return Err("待修改文件不是普通文件或超过修改上限".into()); }
        let before = fs::read_to_string(&path).map_err(|_| "待修改文件不是 UTF-8 文本")?;
        validate_text_content(&before)?;
        let occurrences = before.match_indices(old_text).count();
        if occurrences != 1 { return Err("待修改原文必须在文件中恰好出现一次".into()); }
        let after = before.replacen(old_text, new_text, 1);
        if after.len() > MAX_EDIT_BYTES { return Err("修改后的文件超过本机任务上限".into()); }
        let id = NEXT_EDIT_ID.fetch_add(1, Ordering::Relaxed);
        Ok(PendingEdit { id: format!("edit-{}-{id}", std::process::id()), path: display, before, after })
    }

    pub(crate) fn apply_edit(&self, edit: &PendingEdit, approved: bool) -> Result<(), String> {
        if !approved { return Err("用户拒绝了文件修改".into()); }
        let (path, display) = self.resolve(&edit.path, false)?;
        if display != edit.path { return Err("待修改路径发生变化".into()); }
        let current = fs::read_to_string(&path).map_err(|_| "待修改文件不再是 UTF-8 文本")?;
        if current != edit.before { return Err("文件内容已变化，拒绝覆盖；请重新读取后提出修改".into()); }
        if edit.after.len() > MAX_EDIT_BYTES { return Err("修改后的文件超过本机任务上限".into()); }
        fs::write(path, edit.after.as_bytes()).map_err(|_| "写入修改失败".to_owned())
    }
}

fn hidden_path_component(name: &str) -> bool {
    let name = name.to_lowercase();
    matches!(name.as_str(), ".git" | ".ssh" | "node_modules" | "target" | "dist" | "build" | ".next" | ".turbo" | "coverage" | ".venv" | "venv")
        || name.starts_with(".env")
        || matches!(name.as_str(), ".npmrc" | ".pypirc" | ".netrc" | "credentials.json" | "secrets.json" | "id_rsa" | "id_ed25519" | "id_ecdsa" | "id_dsa")
        || [".pem", ".key", ".p12", ".pfx", ".ppk"].iter().any(|suffix| name.ends_with(suffix))
}

fn validate_text_content(text: &str) -> Result<(), String> {
    if text.contains('\0') || text.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) { return Err("文件疑似二进制或含不支持字符".into()); }
    if text.contains("-----BEGIN PRIVATE KEY-----") || text.contains("-----BEGIN RSA PRIVATE KEY-----")
        || text.contains("-----BEGIN OPENSSH PRIVATE KEY-----") || text.contains("-----BEGIN EC PRIVATE KEY-----") {
        return Err("疑似私钥内容不可读取".into());
    }
    Ok(())
}

fn path_within(root: &Path, candidate: &Path) -> bool {
    #[cfg(windows)]
    { let root = root.to_string_lossy().trim_end_matches(['\\','/']).to_lowercase(); let candidate = candidate.to_string_lossy().to_lowercase(); candidate == root || candidate.strip_prefix(&root).is_some_and(|tail| tail.starts_with('\\') || tail.starts_with('/')) }
    #[cfg(not(windows))]
    { candidate == root || candidate.starts_with(root) }
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; return metadata.file_attributes() & 0x400 != 0; }
    #[cfg(not(windows))]
    { false }
}

fn has_multiple_hard_links(link_count:u32)->bool{link_count>1}

#[cfg(windows)]
fn hard_link_count(path:&Path)->Option<u32>{
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{Foundation::HANDLE,Storage::FileSystem::{GetFileInformationByHandle,BY_HANDLE_FILE_INFORMATION}};
    let file=fs::File::open(path).ok()?;
    let mut info:BY_HANDLE_FILE_INFORMATION=unsafe{std::mem::zeroed()};
    (unsafe{GetFileInformationByHandle(file.as_raw_handle() as HANDLE,&mut info)}!=0).then_some(info.nNumberOfLinks)
}

#[cfg(unix)]
fn hard_link_count(metadata:&fs::Metadata)->u32{use std::os::unix::fs::MetadataExt;metadata.nlink() as u32}

fn file_is_hard_link(path:&Path,_metadata:&fs::Metadata)->bool{
    #[cfg(windows)]
    {hard_link_count(path).is_none_or(has_multiple_hard_links)}
    #[cfg(unix)]
    {let _=path;has_multiple_hard_links(hard_link_count(_metadata))}
    #[cfg(not(any(windows,unix)))]
    {let _=(path,_metadata);false}
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, sync::atomic::{AtomicU64, Ordering}};

    static NEXT: AtomicU64 = AtomicU64::new(1);
    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("agent-room-tools-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn rejects_absolute_parent_unc_and_alternate_stream_paths() {
        let dir = TestDir::new();
        let root = WorkspaceRoot::new(dir.0.to_str().unwrap()).unwrap();
        assert!(root.read_text("../outside.txt").is_err());
        assert!(root.read_text(dir.0.join("inside.txt").to_str().unwrap()).is_err());
        assert!(root.read_text("\\\\server\\share\\secret.txt").is_err());
        assert!(root.read_text("notes.txt:secret").is_err());
    }

    #[test]
    fn lists_and_reads_skip_sensitive_and_generated_paths() {
        let dir = TestDir::new();
        for path in ["src", ".git", "target", "dist", "node_modules", ".env.local", "id_rsa", "server.pem"] {
            let full = dir.0.join(path);
            if path == "src" { fs::create_dir_all(&full).unwrap(); fs::write(full.join("main.rs"), "fn main() {}\n").unwrap(); }
            else if [".git", "target", "dist", "node_modules"].contains(&path) { fs::create_dir_all(&full).unwrap(); fs::write(full.join("ignored.txt"), "secret").unwrap(); }
            else { fs::write(full, "private").unwrap(); }
        }
        let root = WorkspaceRoot::new(dir.0.to_str().unwrap()).unwrap();
        let names: Vec<_> = root.list_files("").unwrap().into_iter().map(|entry| entry.name).collect();
        assert_eq!(names, vec!["src"]);
        assert!(root.read_text(".env.local").is_err());
        assert!(root.read_text("id_rsa").is_err());
        assert!(root.read_text("server.pem").is_err());
        assert!(root.search_text("secret", "").unwrap().is_empty());
        assert_eq!(root.read_text("src/main.rs").unwrap(), "fn main() {}\n");
    }

    #[test]
    fn refuses_symlink_escape_when_platform_allows_creating_symlinks() {
        let root_dir = TestDir::new();
        let outside = TestDir::new();
        fs::write(outside.0.join("secret.txt"), "outside").unwrap();
        let link = root_dir.0.join("linked");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside.0, &link).is_ok();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside.0, &link).is_ok();
        #[cfg(not(any(windows, unix)))]
        let linked = false;
        if linked {
            let root = WorkspaceRoot::new(root_dir.0.to_str().unwrap()).unwrap();
            assert!(root.read_text("linked/secret.txt").is_err());
            assert!(root.list_files("linked").is_err());
        }
    }

    #[test]
    fn refuses_hard_links_that_refer_to_files_outside_the_workspace() {
        let root_dir = TestDir::new();
        let outside = TestDir::new();
        let outside_file = outside.0.join("secret.txt");
        fs::write(&outside_file, "outside secret").unwrap();
        let link = root_dir.0.join("linked.txt");
        if let Err(error)=fs::hard_link(&outside_file, &link){
            assert_eq!(error.kind(),std::io::ErrorKind::PermissionDenied,"hard link setup failed unexpectedly: {error}");
            eprintln!("hard link integration setup is blocked by this Windows sandbox");
            return;
        }
        let root = WorkspaceRoot::new(root_dir.0.to_str().unwrap()).unwrap();
        assert!(root.read_text("linked.txt").is_err());
        assert!(root.search_text("secret", "").unwrap().is_empty());
        assert!(root.propose_edit("linked.txt", "outside", "changed").is_err());
        assert_eq!(fs::read_to_string(outside_file).unwrap(), "outside secret");
    }

    #[test]
    fn hard_link_guard_rejects_shared_file_identity(){assert!(!has_multiple_hard_links(1));assert!(has_multiple_hard_links(2));}

    #[test]
    fn bounds_text_size_rejects_binary_and_limits_search_results() {
        let dir = TestDir::new();
        fs::write(dir.0.join("binary.dat"), [0, 1, 2, 0xff]).unwrap();
        fs::write(dir.0.join("huge.txt"), vec![b'x'; MAX_READ_BYTES + 1]).unwrap();
        for index in 0..(MAX_SEARCH_MATCHES + 5) {
            fs::write(dir.0.join(format!("match-{index}.txt")), "needle here\n").unwrap();
        }
        let root = WorkspaceRoot::new(dir.0.to_str().unwrap()).unwrap();
        assert!(root.read_text("binary.dat").is_err());
        assert!(root.read_text("huge.txt").is_err());
        assert_eq!(root.search_text("needle", "").unwrap().len(), MAX_SEARCH_MATCHES);
    }

    #[test]
    fn edit_preview_is_read_only_apply_requires_approval_and_fresh_source() {
        let dir = TestDir::new();
        let file = dir.0.join("main.rs");
        fs::write(&file, "fn main() { old(); }\n").unwrap();
        let root = WorkspaceRoot::new(dir.0.to_str().unwrap()).unwrap();
        let edit = root.propose_edit("main.rs", "old()", "new()").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "fn main() { old(); }\n");
        assert!(root.apply_edit(&edit, false).is_err());
        fs::write(&file, "fn main() { concurrent(); }\n").unwrap();
        assert!(root.apply_edit(&edit, true).is_err());
        fs::write(&file, "fn main() { old(); }\n").unwrap();
        root.apply_edit(&edit, true).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "fn main() { new(); }\n");
    }

    #[test]
    fn search_returns_only_bounded_relative_matches() {
        let dir = TestDir::new();
        fs::create_dir_all(dir.0.join("src")).unwrap();
        fs::write(dir.0.join("src/lib.rs"), "first needle\nsecond line\nthird needle\n").unwrap();
        let root = WorkspaceRoot::new(dir.0.to_str().unwrap()).unwrap();
        let matches = root.search_text("needle", "src").unwrap();
        assert_eq!(matches.len(), 2);
        assert!(matches.iter().all(|item| item.path == "src/lib.rs"));
        assert_eq!(matches[0].line, 1);
        assert!(!matches[0].text.contains(dir.0.to_str().unwrap()));
    }
}
