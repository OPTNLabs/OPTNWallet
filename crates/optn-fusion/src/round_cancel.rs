//! Per-round cancellation registry.
//!
//! The renderer prepares an ID before it derives any signing material, then
//! starts the awaited native round with that exact ID. This two-step handshake
//! removes the cancel-before-register race: a cancellation can always find the
//! prepared entry, even if `fusion_run` has not started polling yet.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use tokio::sync::watch;

const MAX_REGISTERED_ROUNDS: usize = 64;
const PREPARED_ROUND_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_ROUND_ID_LEN: usize = 128;

#[derive(Clone)]
pub struct CancelFlag {
    sender: Arc<watch::Sender<bool>>,
}

impl CancelFlag {
    pub(crate) fn new() -> Self {
        let (sender, _receiver) = watch::channel(false);
        Self {
            sender: Arc::new(sender),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        *self.sender.borrow()
    }

    pub fn cancel(&self) {
        self.sender.send_replace(true);
    }

    pub fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err("fusion round cancelled".into())
        } else {
            Ok(())
        }
    }

    /// Wait without a missed-notification race. `watch` retains the current
    /// state, unlike a bare `Notify::notify_waiters`.
    pub async fn cancelled(&self) {
        let mut receiver = self.sender.subscribe();
        if *receiver.borrow() {
            return;
        }
        while receiver.changed().await.is_ok() {
            if *receiver.borrow() {
                return;
            }
        }
    }
}

struct RoundEntry {
    flag: CancelFlag,
    prepared_at: Instant,
    running: bool,
}

static REGISTRY: Lazy<Mutex<HashMap<String, RoundEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn valid_round_id(round_id: &str) -> bool {
    !round_id.is_empty()
        && round_id.len() <= MAX_ROUND_ID_LEN
        && round_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn with_registry<R>(f: impl FnOnce(&mut HashMap<String, RoundEntry>) -> R) -> R {
    let mut guard = REGISTRY.lock().unwrap_or_else(|error| error.into_inner());
    f(&mut guard)
}

fn purge_expired_prepared(map: &mut HashMap<String, RoundEntry>) {
    let now = Instant::now();
    map.retain(|_, entry| {
        entry.running || now.saturating_duration_since(entry.prepared_at) <= PREPARED_ROUND_TTL
    });
}

/// Reserve a bounded round ID before any key derivation or native network work.
pub fn prepare_round(round_id: &str) -> Result<(), String> {
    if !valid_round_id(round_id) {
        return Err("invalid fusion round id".into());
    }
    with_registry(|map| {
        purge_expired_prepared(map);
        if map.contains_key(round_id) {
            return Err("fusion round id is already prepared".into());
        }
        if map.len() >= MAX_REGISTERED_ROUNDS {
            return Err("too many prepared fusion rounds".into());
        }
        map.insert(
            round_id.to_string(),
            RoundEntry {
                flag: CancelFlag::new(),
                prepared_at: Instant::now(),
                running: false,
            },
        );
        Ok(())
    })
}

/// RAII ownership of a running registry entry. Every Rust return path removes
/// it, including argument decoding, transport errors, and cancellation.
pub struct RoundRegistration {
    round_id: String,
    flag: CancelFlag,
}

impl RoundRegistration {
    pub fn flag(&self) -> CancelFlag {
        self.flag.clone()
    }
}

impl Drop for RoundRegistration {
    fn drop(&mut self) {
        with_registry(|map| {
            map.remove(&self.round_id);
        });
    }
}

/// Convert a prepared entry to a running entry.
pub fn acquire_round(round_id: &str) -> Result<RoundRegistration, String> {
    with_registry(|map| {
        purge_expired_prepared(map);
        let entry = map
            .get_mut(round_id)
            .ok_or_else(|| "fusion round was not prepared".to_string())?;
        if entry.running {
            return Err("fusion round is already running".into());
        }
        entry.running = true;
        Ok(RoundRegistration {
            round_id: round_id.to_string(),
            flag: entry.flag.clone(),
        })
    })
}

/// Cancel a round. A prepared-but-not-running entry is removed immediately;
/// a running entry remains until its RAII guard observes cancellation and drops.
pub fn cancel_round(round_id: &str) -> bool {
    let flag = with_registry(|map| {
        let entry = map.get(round_id)?;
        let flag = entry.flag.clone();
        if !entry.running {
            map.remove(round_id);
        }
        Some(flag)
    });
    if let Some(flag) = flag {
        flag.cancel();
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_acquire_cancel_and_drop_lifecycle() {
        let id = "test-round-1";
        prepare_round(id).expect("first prepare succeeds");
        let registration = acquire_round(id).expect("prepared round starts");
        let flag = registration.flag();
        assert!(!flag.is_cancelled());
        flag.check().expect("not cancelled yet");

        assert!(prepare_round(id).is_err());
        assert!(acquire_round(id).is_err());

        assert!(cancel_round(id));
        assert!(flag.is_cancelled());
        assert!(flag.check().is_err());

        drop(registration);
        prepare_round(id).expect("drop removes the running entry");
        assert!(cancel_round(id));
    }

    #[test]
    fn cancel_unknown_round_returns_false() {
        assert!(!cancel_round("nonexistent"));
    }

    #[test]
    fn cancellation_before_run_removes_the_prepared_entry() {
        let id = "cancel-before-run";
        prepare_round(id).unwrap();
        assert!(cancel_round(id));
        assert!(acquire_round(id).is_err());
    }

    #[test]
    fn rejects_unbounded_or_unsafe_round_ids() {
        assert!(prepare_round("").is_err());
        assert!(prepare_round("contains spaces").is_err());
        assert!(prepare_round(&"a".repeat(MAX_ROUND_ID_LEN + 1)).is_err());
    }

    #[test]
    fn async_waiter_observes_cancellation() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let flag = CancelFlag::new();
            let waiter = {
                let flag = flag.clone();
                tokio::spawn(async move { flag.cancelled().await })
            };
            flag.cancel();
            tokio::time::timeout(Duration::from_millis(100), waiter)
                .await
                .expect("waiter should wake")
                .expect("waiter task");
        });
    }
}
