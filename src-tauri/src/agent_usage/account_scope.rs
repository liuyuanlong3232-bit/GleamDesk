//! Account-scoped cache ownership, following CodexBar's account/config guards and
//! BrimDeck's ClaudeQuotaCache: never hydrate a quota under another login source.
//! Reference revisions: CodexBar 7447bc77, BrimDeck 89b93972 (2026-11-12).
//! Digests remain native-only. IPC gets a per-process monotonic revision, not
//! emails, account IDs, token fingerprints, paths, or credentials.
use super::*;
use std::{io::Read, path::Path, sync::{Arc, Mutex}};

#[derive(Clone, Default)]
struct Entry {
    probes: RequestCache<(), String>,
    tracker: Arc<Mutex<Tracker>>,
}
#[derive(Clone,Default)]
pub(super) struct State { entries:Arc<Mutex<std::collections::BTreeMap<String,Entry>>> }

struct Tracker { signature: Option<String>, started: u64, generation: u64 }
impl Default for Tracker {
    fn default() -> Self { Self { signature:None, started:observed_unix_ms(), generation:0 } }
}
impl Tracker {
    fn observe(&mut self, signature:String) -> String {
        if self.signature.as_ref()!=Some(&signature) {
            self.signature=Some(signature);self.generation=self.generation.saturating_add(1);
        }
        format!("{}:{}:{}",std::process::id(),self.started,self.generation)
    }
}
impl State {
    fn entry(&self,id:&str)->Result<Entry,String>{
        if !QUOTA_AGENT_IDS.contains(&id){return Err("未知的 AI 客户端".into())}
        Ok(self.entries.lock().map_err(|_|"AI 账号状态暂时不可用")?.entry(id.into()).or_default().clone())
    }
    pub(super) fn revision(&self, id:&str, fresh:bool) -> Result<String,String> {
        let entry=self.entry(id)?;
        let signature=entry.probes.read((),if fresh {Duration::ZERO}else{Duration::from_secs(2)},Duration::from_secs(1),||fingerprint(id))?;
        let revision=entry.tracker.lock().map_err(|_|"AI 账号状态暂时不可用")?.observe(signature);
        Ok(revision)
    }
}

struct Bytes(Vec<u8>);
impl Drop for Bytes { fn drop(&mut self){self.0.fill(0)} }
fn bounded(path:&Path,cap:u64)->Result<Bytes,std::io::Error>{
    let mut bytes=Bytes(vec![]);std::fs::File::open(path)?.take(cap+1).read_to_end(&mut bytes.0)?;
    if bytes.0.len() as u64>cap{return Err(std::io::Error::other("login source exceeds bound"))}Ok(bytes)
}
pub(super) fn local_root(variable:&str,default:PathBuf)->Option<PathBuf>{
    let path=match std::env::var_os(variable){Some(value)if !value.is_empty()=>PathBuf::from(value),_=>default};
    (path.is_absolute()&&!path.to_string_lossy().starts_with("\\\\")).then_some(path)
}
pub(super) fn digest(value:&[u8])->Result<String,String>{
    #[cfg(windows)] {crate::analysis::sha256(value).map_err(|_|"AI 账号状态暂时不可用".into())}
    #[cfg(not(windows))] {let _=value;Err("此运行环境不支持本机账号识别".into())}
}
pub(super) fn file_scope(path:&Path)->Result<String,String>{
    let content=match bounded(path,1024*1024){
        Ok(bytes)=>digest(&bytes.0)?,
        Err(error)if error.kind()==std::io::ErrorKind::NotFound=>"missing".into(),
        Err(_)=>"unreadable".into(),
    };
    digest(format!("{}\n{content}",path.to_string_lossy().to_lowercase()).as_bytes())
}
fn codex_home()->Option<PathBuf>{
    local_root("CODEX_HOME",PathBuf::from(std::env::var_os("USERPROFILE")?).join(".codex"))
}
pub(super) fn codex_account_key()->Option<String>{
    let path=codex_home()?.join("auth.json");let bytes=bounded(&path,1024*1024).ok()?;
    let value:Value=serde_json::from_slice(&bytes.0).ok()?;
    let id=value.pointer("/tokens/account_id")?.as_str()?.trim();
    if id.is_empty()||id.len()>512{return None}
    digest(format!("codex-owner-v1\n{}\n{id}",path.to_string_lossy().to_lowercase()).as_bytes()).ok()
}
fn claude_scope()->Result<String,String>{
    let Some(path)=claude_oauth::credential_path()else{return Ok("no-claude-home".into())};
    let mut parts=vec![file_scope(&path)?];
    // Claude Code's active account metadata, in owner-selected config priority.
    // Read only oauthAccount; history and unrelated preferences never affect quota ownership.
    let root=path.parent().ok_or("AI 账号目录暂时不可用")?;
    let mut configs=vec![root.join(".config.json"),root.join(".claude.json")];
    if std::env::var_os("CLAUDE_CONFIG_DIR").is_none(){if let Some(home)=std::env::var_os("USERPROFILE"){configs.push(PathBuf::from(home).join(".claude.json"));}}
    for config in configs {
        match bounded(&config,4*1024*1024){
            Ok(bytes)=>{
                let account=serde_json::from_slice::<Value>(&bytes.0).ok().and_then(|value|value.get("oauthAccount").cloned()).unwrap_or(Value::Null);
                parts.push(digest(&serde_json::to_vec(&account).map_err(|_|"AI 账号状态暂时不可用")?)?);break;
            },
            Err(error)if error.kind()==std::io::ErrorKind::NotFound=>continue,
            Err(_)=>{parts.push("unreadable-profile".into());break;},
        }
    }
    digest(parts.join("\n").as_bytes())
}
fn fingerprint(id:&str)->Result<String,String>{
    let mut parts=vec![];
    if id=="codex"{if let Some(home)=codex_home(){parts.push(file_scope(&home.join("auth.json"))?);parts.push(file_scope(&home.join("config.toml"))?);}else{parts.push("no-codex-home".into())}}
    if id=="claude"{parts.push(claude_scope()?);}
    #[cfg(windows)] {
        match id {
            "kimi"=>parts.push(kimi::source_scope().unwrap_or_else(|_|"kimi-unconfirmed".into())),
            "cursor"=>parts.push(cursor::source_scope().unwrap_or_else(|_|"cursor-unconfirmed".into())),
            "doubao"=>parts.push(doubao::source_scope().unwrap_or_else(|_|"doubao-unconfirmed".into())),
            "antigravity"=>parts.push(antigravity_owner_scope().unwrap_or_else(|_|"antigravity-unconfirmed".into())),
            _=>{},
        }
    }
    digest(parts.join("\n").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn one_clients_exit_does_not_retire_another_clients_revision(){
        let state=State::default();let codex=state.entry("codex").unwrap();let antigravity=state.entry("antigravity").unwrap();
        let revision=codex.tracker.lock().unwrap().observe("same-codex-account".into());
        antigravity.tracker.lock().unwrap().observe("running-account".into());
        antigravity.tracker.lock().unwrap().observe("closed-service".into());
        assert_eq!(codex.tracker.lock().unwrap().observe("same-codex-account".into()),revision);
        assert!(state.entry("not-an-agent").is_err());
    }
    #[test]fn switching_away_and_back_never_reuses_an_in_flight_revision(){
        let mut state=Tracker::default();let a=state.observe("account-a".into());
        assert_eq!(state.observe("account-a".into()),a);
        let b=state.observe("account-b".into());let returned=state.observe("account-a".into());
        assert_ne!(a,b);assert_ne!(a,returned);assert_ne!(b,returned);
        assert!(!returned.contains("account-a"));
    }
    #[test]fn native_quota_cache_cannot_reuse_another_revision(){
        let cache=RequestCache::<String,u8>::default();let ttl=Duration::from_secs(300);
        assert_eq!(cache.read("scope-a".into(),ttl,ttl,||Ok(80)).unwrap(),80);
        assert_eq!(cache.read("scope-b".into(),ttl,ttl,||Ok(20)).unwrap(),20);
        assert_eq!(cache.read("scope-b".into(),ttl,ttl,||panic!("same scope is shared")).unwrap(),20);
    }
    #[test]fn file_replacement_and_sign_out_retire_the_previous_scope(){
        let dir=std::env::temp_dir().join(format!("gleamdesk-account-source-{}-{}",std::process::id(),observed_unix_ms()));
        std::fs::create_dir(&dir).unwrap();let path=dir.join("auth.json");
        std::fs::write(&path,b"synthetic-a").unwrap();let a=file_scope(&path).unwrap();
        std::fs::write(&path,b"synthetic-b").unwrap();let b=file_scope(&path).unwrap();
        std::fs::remove_file(&path).unwrap();let signed_out=file_scope(&path).unwrap();std::fs::remove_dir(dir).unwrap();
        assert_ne!(a,b);assert_ne!(b,signed_out);assert!(!a.contains("synthetic"));
    }
}
