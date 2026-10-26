use std::{collections::VecDeque, sync::{Arc, Mutex}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestMetrics {
    pub commands: u64,
    pub loads: u64,
    pub reused: u64,
    pub failures: u64,
    pub in_flight: bool,
    pub recent_loads_unix_ms: VecDeque<u64>,
}
struct ActiveLoad { metrics: Arc<Mutex<RequestMetrics>>, failed: bool }
impl Drop for ActiveLoad {
    fn drop(&mut self) {
        if let Ok(mut metrics) = self.metrics.lock() {
            metrics.in_flight = false;
            if self.failed { metrics.failures = metrics.failures.saturating_add(1); }
        }
    }
}

struct Cached<K, V, E> { key: K, started_at: Instant, completed_at: Instant, result: Result<V, E> }

/// One bounded, demand-only cache per native provider. Holding the mutex through
/// the load lets callers from independent WebViews share its completed result.
/// The most recent configuration replaces the previous one; no timers or tasks
/// survive the command that requested the data.
pub struct RequestCache<K, V, E = String>(Arc<Mutex<Option<Cached<K, V, E>>>>, Arc<Mutex<RequestMetrics>>);

impl<K, V, E> Default for RequestCache<K, V, E> {
    fn default() -> Self { Self(Arc::new(Mutex::new(None)), Arc::new(Mutex::new(RequestMetrics::default()))) }
}
impl<K, V, E> Clone for RequestCache<K, V, E> {
    fn clone(&self) -> Self { Self(self.0.clone(), self.1.clone()) }
}
impl<K, V, E> RequestCache<K, V, E> {
    pub fn metrics(&self) -> Option<RequestMetrics> { self.1.lock().ok().map(|metrics| metrics.clone()) }
    fn update_metrics(&self, update: impl FnOnce(&mut RequestMetrics)) {
        if let Ok(mut metrics) = self.1.lock() { update(&mut metrics); }
    }
}
impl<K: PartialEq, V: Clone, E: Clone + From<String>> RequestCache<K, V, E> {
    pub fn read(&self, key: K, success_ttl: Duration, failure_ttl: Duration,
        load: impl FnOnce() -> Result<V, E>) -> Result<V, E> {
        self.update_metrics(|metrics| metrics.commands = metrics.commands.saturating_add(1));
        let mut cached = self.0.lock().map_err(|_| E::from("原生数据读取协调不可用".to_string()))?;
        if let Some(previous) = &*cached {
            // Match the frontend's interval measured from load start. Reserve
            // one second after a slow load so queued callers still share it.
            let margin = Duration::from_millis(250).min(success_ttl / 10);
            let fresh = if previous.result.is_ok() {
                previous.started_at.elapsed() < success_ttl.saturating_sub(margin)
                    || previous.completed_at.elapsed() < success_ttl.min(Duration::from_secs(1))
            } else { previous.completed_at.elapsed() < failure_ttl };
            if previous.key == key && fresh {
                self.update_metrics(|metrics| metrics.reused = metrics.reused.saturating_add(1));
                return previous.result.clone();
            }
        }
        let started_at = Instant::now();
        self.update_metrics(|metrics| {
            metrics.loads = metrics.loads.saturating_add(1);
            metrics.in_flight = true;
            if metrics.recent_loads_unix_ms.len() == 16 { metrics.recent_loads_unix_ms.pop_front(); }
            metrics.recent_loads_unix_ms.push_back(observed_unix_ms());
        });
        let mut active_load = ActiveLoad { metrics: self.1.clone(), failed: true };
        let result = load();
        active_load.failed = result.is_err();
        drop(active_load);
        *cached = Some(Cached { key, started_at, completed_at: Instant::now(), result: result.clone() });
        result
    }
}

pub fn observed_unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Barrier, atomic::{AtomicUsize, Ordering}};

    #[test]
    fn independent_threads_share_one_native_load() {
        let cache = RequestCache::<u64, u64>::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8).map(|_| {
            let (cache, calls, barrier) = (cache.clone(), calls.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                cache.read(1, Duration::from_secs(60), Duration::from_secs(1), || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(20));
                    Ok(42)
                }).unwrap()
            })
        }).collect();
        for worker in workers { assert_eq!(worker.join().unwrap(), 42); }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let metrics = cache.metrics().unwrap();
        assert_eq!((metrics.commands, metrics.loads, metrics.reused, metrics.failures), (8, 1, 7, 0));
        assert!(!metrics.in_flight);
        assert_eq!(metrics.recent_loads_unix_ms.len(), 1);
    }

    #[test]
    fn expiry_configuration_and_credential_revision_control_reuse() {
        let cache = RequestCache::<(&str, u64), u64>::default();
        let ttl = Duration::from_secs(60);
        assert_eq!(cache.read(("one", 0), ttl, ttl, || Ok(1)).unwrap(), 1);
        assert_eq!(cache.read(("one", 0), ttl, ttl, || panic!("cached")).unwrap(), 1);
        assert_eq!(cache.read(("two", 0), ttl, ttl, || Ok(2)).unwrap(), 2);
        assert_eq!(cache.read(("two", 1), ttl, ttl, || Ok(3)).unwrap(), 3);
        assert_eq!(cache.read(("two", 1), Duration::ZERO, ttl, || Ok(4)).unwrap(), 4);
        assert_eq!(cache.read(("one", 0), ttl, ttl, || Ok(5)).unwrap(), 5);
    }

    #[test]
    fn errors_are_shared_then_retried_without_caching_a_success() {
        let cache = RequestCache::<u8, u8>::default();
        let ttl = Duration::from_secs(60);
        assert_eq!(cache.read(1, ttl, ttl, || Err("failed".into())).unwrap_err(), "failed");
        assert!(cache.read(1, ttl, ttl, || panic!("cached error")).is_err());
        assert_eq!(cache.read(1, ttl, Duration::ZERO, || Ok(9)).unwrap(), 9);
    }

    #[test]
    fn a_slow_load_still_has_a_short_completed_result_for_waiters() {
        let cache = RequestCache::<u8, u8>::default();
        let ttl = Duration::from_secs(60);
        assert_eq!(cache.read(1, ttl, ttl, || Ok(7)).unwrap(), 7);
        // Model a long load without imposing a timing-sensitive short sleep.
        cache.0.lock().unwrap().as_mut().unwrap().started_at -= Duration::from_secs(120);
        assert_eq!(cache.read(1, ttl, ttl, || panic!("queued caller must share the completed read")).unwrap(), 7);
    }

    #[test]
    fn first_scheduled_refresh_expires_from_load_start_instead_of_completion() {
        let cache = RequestCache::<u8, u8>::default();
        let ttl = Duration::from_secs(60);
        assert_eq!(cache.read(1, ttl, ttl, || Ok(7)).unwrap(), 7);
        {
            let mut locked = cache.0.lock().unwrap();
            let previous = locked.as_mut().unwrap();
            previous.started_at -= Duration::from_secs(60);
            previous.completed_at -= Duration::from_secs(59);
            assert!(previous.completed_at.elapsed() < ttl, "The old completion-based cache would still reuse this sample");
        }
        assert_eq!(cache.read(1, ttl, ttl, || Ok(8)).unwrap(), 8);
        assert_eq!(cache.read(1, ttl, ttl, || panic!("simultaneous waiter must share refreshed sample")).unwrap(), 8);
    }

    #[test]
    fn poisoned_coordinator_fails_without_an_uncoordinated_load() {
        let cache = RequestCache::<u8, u8>::default();
        let worker = cache.clone();
        assert!(std::thread::spawn(move || worker.read(1, Duration::ZERO, Duration::ZERO, || panic!("test"))).join().is_err());
        assert!(cache.read(1, Duration::ZERO, Duration::ZERO, || panic!("must not load")).is_err());
        assert!(!cache.metrics().unwrap().in_flight);
    }

    #[test]
    fn metrics_keep_only_bounded_load_times_and_count_real_failures() {
        let cache = RequestCache::<u8, u8>::default();
        for _ in 0..20 { assert!(cache.read(1, Duration::ZERO, Duration::ZERO, || Err("failed".into())).is_err()); }
        let metrics = cache.metrics().unwrap();
        assert_eq!((metrics.commands, metrics.loads, metrics.reused, metrics.failures), (20, 20, 0, 20));
        assert_eq!(metrics.recent_loads_unix_ms.len(), 16);
        assert!(!metrics.in_flight);
    }
}
