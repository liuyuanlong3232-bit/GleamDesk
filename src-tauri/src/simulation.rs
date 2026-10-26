use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

const BLOCKED: &str = "模拟模式已开启或状态尚未同步，已阻止真实模型调用";
struct SimulationGate { enabled: AtomicBool, generation: AtomicU64 }
impl SimulationGate {
    const fn new() -> Self { Self { enabled: AtomicBool::new(true), generation: AtomicU64::new(0) } }
    fn set(&self, enabled: bool) {
        if self.enabled.swap(enabled, Ordering::SeqCst) != enabled { self.generation.fetch_add(1, Ordering::SeqCst); }
    }
    fn acquire(&self) -> Result<LivePermit<'_>, String> {
        let permit = LivePermit { gate: self, generation: self.generation.load(Ordering::SeqCst) };
        permit.check()?;
        Ok(permit)
    }
}
#[derive(Clone, Copy)]
pub(crate) struct LivePermit<'a> { gate: &'a SimulationGate, generation: u64 }
impl LivePermit<'_> {
    pub(crate) fn check(&self) -> Result<(), String> {
        if self.gate.enabled.load(Ordering::SeqCst) || self.gate.generation.load(Ordering::SeqCst) != self.generation {
            Err(BLOCKED.into())
        } else { Ok(()) }
    }
}
static GATE: SimulationGate = SimulationGate::new();
pub(crate) fn require_live() -> Result<LivePermit<'static>, String> { GATE.acquire() }

#[tauri::command]
pub fn set_simulation_mode(view: tauri::Webview, enabled: bool) -> Result<(), String> {
    if !matches!(view.label(), "main" | "dashboard") { return Err("仅主屏和工作台可同步模拟状态".into()); }
    GATE.set(enabled);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn unsynchronized_and_simulated_requests_never_run_the_callback() {
        let gate=SimulationGate::new();let mut calls=0;
        let result=gate.acquire().and_then(|permit|{permit.check()?;calls+=1;Ok(())});
        assert!(result.is_err());assert_eq!(calls,0);
    }
    #[test] fn confirmed_live_mode_keeps_normal_dispatch() {
        let gate=SimulationGate::new();gate.set(false);let permit=gate.acquire().unwrap();
        assert!(permit.check().is_ok());gate.set(false);assert!(permit.check().is_ok());
    }
    #[test] fn enabling_simulation_stops_queued_and_later_group_turns() {
        let gate=SimulationGate::new();gate.set(false);let permit=gate.acquire().unwrap();let mut calls=0;
        permit.check().unwrap();calls+=1;gate.set(true);
        assert!(permit.check().is_err());assert!(gate.acquire().is_err());assert_eq!(calls,1);
    }
    #[test] fn leaving_simulation_does_not_revive_an_old_request() {
        let gate=SimulationGate::new();gate.set(false);let old=gate.acquire().unwrap();gate.set(true);gate.set(false);
        assert!(old.check().is_err());assert!(gate.acquire().unwrap().check().is_ok());
    }
}
