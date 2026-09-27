//! Automatic refresh timing shared by native hosts and the persistent CLI.
//!
//! Hosts supply their existing selected-source refresh future. This module never
//! chooses a provider, changes scan coverage, or publishes a candidate snapshot.

use crate::AppRuntime;
use optn_app::AppState;
use optn_core::network::Network;
use std::{
    future::Future,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tokio::{
    sync::{watch, Mutex, MutexGuard},
    time::Instant,
};

const REFRESH_INTERVAL: Duration = Duration::from_secs(60);
const RETRY_INITIAL: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(60);
const STALE_REASON: &str = "Wallet refresh unavailable; retained history remains stale.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshOutcome {
    Refreshed,
    /// Another refresh or chain operation owns the adapter. This is not failure
    /// evidence and must not invalidate that operation's accepted snapshot.
    Busy,
}

#[derive(Clone, PartialEq, Eq)]
struct Scope {
    epoch: u64,
    network: Network,
    account: String,
}

impl Scope {
    fn of(state: &AppState) -> Option<Self> {
        Some(Self {
            epoch: state.lock.unlock_epoch,
            network: state.network,
            account: state.wallet.as_ref()?.account_xpub.clone()?,
        })
    }
}

fn fresh(state: &AppState) -> bool {
    state.wallet_sync.utxos_fresh && state.wallet_sync.history_fresh
}

struct Schedule {
    scope: Option<Scope>,
    fresh: bool,
    refreshing: bool,
    next: Instant,
    retry: Duration,
}

impl Schedule {
    fn new(now: Instant) -> Self {
        Self {
            scope: None,
            fresh: false,
            refreshing: false,
            next: now,
            retry: RETRY_INITIAL,
        }
    }

    fn observe(&mut self, state: &AppState, now: Instant) {
        let scope = Scope::of(state);
        if self.scope != scope {
            self.next = now;
            self.retry = RETRY_INITIAL;
        } else if fresh(state) && (!self.fresh || self.refreshing) {
            // A manual refresh also satisfies this cycle. Do not immediately
            // scan the same account again after the manual pass completes.
            self.next = now + REFRESH_INTERVAL;
            self.retry = RETRY_INITIAL;
        } else if self.fresh && !fresh(state) && !state.wallet_sync.refreshing {
            self.next = now;
        }
        self.scope = scope;
        self.fresh = fresh(state);
        self.refreshing = state.wallet_sync.refreshing;
    }

    fn finished(
        &mut self,
        state: &AppState,
        now: Instant,
        result: &Result<RefreshOutcome, String>,
    ) {
        self.observe(state, now);
        match result {
            Ok(RefreshOutcome::Refreshed) => {
                self.next = now + REFRESH_INTERVAL;
                self.retry = RETRY_INITIAL;
            }
            Ok(RefreshOutcome::Busy) => self.next = now + RETRY_INITIAL,
            Err(_) => {
                self.next = now + self.retry;
                self.retry = self.retry.saturating_mul(2).min(RETRY_MAX);
            }
        }
    }
}

/// One cycle per host wallet runtime. Manual and automatic entry points must
/// share this instance. Dropping `run` drops its in-flight refresh; there is no
/// detached I/O task or runtime-owned executor here.
pub struct WalletRefresh {
    runtime: AppRuntime,
    active: Mutex<()>,
    pauses: AtomicUsize,
    changes: watch::Sender<u64>,
}

struct PauseRequest<'a>(&'a WalletRefresh);

impl Drop for PauseRequest<'_> {
    fn drop(&mut self) {
        self.0.pauses.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Holds refresh setup and scans out of a host policy/credential mutation.
pub struct RefreshPause<'a> {
    _active: MutexGuard<'a, ()>,
    _request: PauseRequest<'a>,
}

impl WalletRefresh {
    pub fn new(runtime: AppRuntime) -> Self {
        Self {
            runtime,
            active: Mutex::new(()),
            pauses: AtomicUsize::new(0),
            changes: watch::channel(0).0,
        }
    }

    /// Revoke pending setup before waiting for its gate, then prevent another
    /// attempt until the host finishes its policy write. Cancellation of this
    /// method also releases the pause; no detached task or permanent latch.
    pub async fn pause(&self) -> RefreshPause<'_> {
        self.pauses.fetch_add(1, Ordering::SeqCst);
        let request = PauseRequest(self);
        self.changes
            .send_modify(|revision| *revision = revision.wrapping_add(1));
        RefreshPause {
            _active: self.active.lock().await,
            _request: request,
        }
    }

    /// Execute the host's existing refresh once, or coalesce with ongoing work.
    /// The runtime's sync lease still owns validation and durable publication.
    pub async fn refresh<F, Fut>(&self, refresh: F) -> Result<RefreshOutcome, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<RefreshOutcome, String>>,
    {
        let Ok(_active) = self.active.try_lock() else {
            return Ok(RefreshOutcome::Busy);
        };
        if self.pauses.load(Ordering::SeqCst) != 0 {
            return Ok(RefreshOutcome::Busy);
        }
        let mut states = self.runtime.subscribe_state();
        let mut operations = self.runtime.operation_changes.subscribe();
        let mut changes = self.changes.subscribe();
        let revision = *changes.borrow_and_update();
        let state = states.borrow_and_update().clone();
        if state.wallet_sync.refreshing {
            return Ok(RefreshOutcome::Busy);
        }
        let scope = Scope::of(&state).ok_or("Open an HD wallet before refreshing.")?;
        // Unlike a spend guard, sync must be allowed to begin with stale coins.
        // The retained generation also catches lock/network-away-and-back ABA.
        let generation = self.runtime.revocation.load(Ordering::SeqCst);
        let work = refresh();
        tokio::pin!(work);
        let result = loop {
            if self.runtime.revocation.load(Ordering::SeqCst) != generation
                || Scope::of(&states.borrow()) != Some(scope.clone())
                || self.pauses.load(Ordering::SeqCst) != 0
                || *changes.borrow() != revision
            {
                return Err("Wallet refresh was superseded.".into());
            }
            tokio::select! {
                biased;
                changed = states.changed() => {
                    changed.map_err(|_| "Wallet runtime stopped.")?;
                }
                changed = operations.changed() => {
                    // A lock/network request revokes before actor publication.
                    // Waking here must not treat our own sync publications as
                    // cancellation: only the retained scope/generation above do.
                    changed.map_err(|_| "Wallet runtime stopped.")?;
                }
                _ = changes.changed() => {},
                result = &mut work => break result,
            }
        };
        let current = self.runtime.state();
        if self.runtime.revocation.load(Ordering::SeqCst) != generation
            || Scope::of(&current) != Some(scope)
            || self.pauses.load(Ordering::SeqCst) != 0
            || *changes.borrow() != revision
        {
            return Err("Wallet refresh was superseded.".into());
        }
        if result.is_err() && !current.wallet_sync.refreshing {
            // Covers failures before BeginHd (source setup or header context).
            // Busy is deliberately excluded; it cannot cancel a manual pass.
            self.runtime
                .invalidate_wallet_sync(STALE_REASON.into())
                .await
                .map_err(|error| error.to_string())?;
        }
        result
    }

    /// Watches open/unlock and freshness changes, with bounded periodic/retry
    /// timing. An overdue timer performs one pass after suspension, not a burst
    /// of missed ticks. Locked and non-HD sessions perform no refresh work.
    pub async fn run<F, Fut>(&self, mut refresh: F)
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<RefreshOutcome, String>>,
    {
        let mut states = self.runtime.subscribe_state();
        let mut schedule = Schedule::new(Instant::now());
        loop {
            let state = states.borrow_and_update().clone();
            schedule.observe(&state, Instant::now());
            if schedule.scope.is_none() {
                if states.changed().await.is_err() {
                    return;
                }
                continue;
            }
            if Instant::now() >= schedule.next {
                let scope = schedule.scope.clone();
                let result = self.refresh(&mut refresh).await;
                let state = states.borrow_and_update().clone();
                if Scope::of(&state) == scope {
                    schedule.finished(&state, Instant::now(), &result);
                } else {
                    schedule.observe(&state, Instant::now());
                }
                continue;
            }
            tokio::select! {
                changed = states.changed() => if changed.is_err() { return; },
                _ = tokio::time::sleep_until(schedule.next) => {},
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_app::{AppAction, OpenedWallet, WalletKind};
    use std::sync::Arc;
    use tokio::sync::{mpsc, oneshot};

    fn open_state() -> AppState {
        AppState {
            wallet: Some(OpenedWallet {
                kind: WalletKind::WatchOnly,
                name: "public scheduling fixture".into(),
                receive_address: String::new(),
                master_fingerprint: None,
                account_path: "m/44'/1'/0'".into(),
                multisig_policy: None,
                // The scheduling layer never derives or queries this value.
                account_xpub: Some("public fixture account".into()),
            }),
            network: Network::Chipnet,
            ..Default::default()
        }
    }

    #[test]
    fn open_resume_retry_and_manual_completion_share_one_schedule() {
        let now = Instant::now();
        let mut schedule = Schedule::new(now);
        let mut state = open_state();
        schedule.observe(&state, now);
        assert_eq!(schedule.next, now);
        let failed = Err("offline".into());
        for expected in [5, 10, 20, 40, 60, 60] {
            schedule.finished(&state, now, &failed);
            assert_eq!(schedule.next, now + Duration::from_secs(expected));
            schedule.observe(&state, now); // repeated stale snapshots cannot hot-loop
            assert_eq!(schedule.next, now + Duration::from_secs(expected));
        }
        state.wallet_sync.refreshing = true;
        schedule.observe(&state, now);
        state.wallet_sync.refreshing = false;
        state.wallet_sync.history_fresh = true;
        state.wallet_sync.utxos_fresh = true;
        schedule.observe(&state, now);
        assert_eq!(schedule.next, now + REFRESH_INTERVAL);
        let resumed = now + Duration::from_secs(600);
        schedule.observe(&state, resumed);
        assert!(schedule.next < resumed);
        schedule.finished(&state, resumed, &Ok(RefreshOutcome::Refreshed));
        assert_eq!(schedule.next, resumed + REFRESH_INTERVAL);
        state.lock.unlock_epoch += 1;
        schedule.observe(&state, resumed);
        assert_eq!(schedule.next, resumed);
        state.wallet = None;
        schedule.observe(&state, resumed);
        assert!(schedule.scope.is_none());
    }

    #[tokio::test]
    async fn busy_coalesces_without_invalidating_fresh_coins() {
        let mut state = open_state();
        state.wallet_sync.history_fresh = true;
        state.wallet_sync.utxos_fresh = true;
        let runtime = AppRuntime::spawn(state);
        let refresh = Arc::new(WalletRefresh::new(runtime.clone()));
        let (started, begun) = oneshot::channel();
        let worker = refresh.clone();
        let task = tokio::spawn(async move {
            worker
                .refresh(|| async {
                    started.send(()).unwrap();
                    std::future::pending().await
                })
                .await
        });
        begun.await.unwrap();
        assert_eq!(
            refresh.refresh(|| async { panic!("duplicate scan") }).await,
            Ok(RefreshOutcome::Busy)
        );
        assert!(fresh(&runtime.state()));
        runtime.dispatch(AppAction::LockWallet).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
    }

    #[tokio::test]
    async fn startup_runs_existing_adapter_and_lock_drops_pending_work() {
        let runtime = AppRuntime::spawn(open_state());
        let refresh = WalletRefresh::new(runtime.clone());
        let (calls, mut called) = mpsc::unbounded_channel();
        let (dropped, drop_seen) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let mut dropped = Some(dropped);
            refresh
                .run(|| {
                    calls.send(()).unwrap();
                    let guard = dropped.take();
                    async move {
                        let _guard = guard;
                        std::future::pending().await
                    }
                })
                .await;
        });
        tokio::time::timeout(Duration::from_secs(1), called.recv())
            .await
            .unwrap()
            .unwrap();
        runtime.dispatch(AppAction::LockWallet).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(1), drop_seen)
            .await
            .unwrap()
            .is_err());
        assert!(called.try_recv().is_err());
        task.abort();
    }

    #[tokio::test]
    async fn queued_lock_cancels_setup_before_actor_publishes() {
        use std::{future::poll_fn, task::Poll};
        let (runtime, _driver) = AppRuntime::new(open_state());
        let refresh = WalletRefresh::new(runtime.clone());
        let (started, begun) = oneshot::channel();
        let task = tokio::spawn(async move {
            refresh
                .refresh(|| async {
                    started.send(()).unwrap();
                    std::future::pending().await
                })
                .await
        });
        begun.await.unwrap();
        // Leave the actor unpolled. The queued lock must wake and cancel setup
        // while the previous open snapshot is still visible.
        let lock = runtime.dispatch(AppAction::LockWallet);
        tokio::pin!(lock);
        assert!(poll_fn(|cx| Poll::Ready(lock.as_mut().poll(cx)))
            .await
            .is_pending());
        assert!(runtime.state().wallet.is_some());
        assert!(tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
    }

    #[tokio::test]
    async fn result_cannot_escape_revocation_and_self_publications_do_not_cancel() {
        let (runtime, _driver) = AppRuntime::new(open_state());
        let refresh = WalletRefresh::new(runtime.clone());
        let result = refresh
            .refresh(|| async {
                runtime.cancel_wallet_operations(); // sync/hold revision, not a wallet change
                tokio::task::yield_now().await;
                Ok(RefreshOutcome::Refreshed)
            })
            .await;
        assert_eq!(result, Ok(RefreshOutcome::Refreshed));
        let result = refresh
            .refresh(|| async {
                // Revoke with a ready result and no actor publication, exercising
                // the post-completion check instead of select's wake-up branches.
                runtime.revocation.fetch_add(1, Ordering::SeqCst);
                Ok(RefreshOutcome::Refreshed)
            })
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn policy_pause_cancels_setup_before_waiting_and_resumes_on_drop() {
        let runtime = AppRuntime::spawn(open_state());
        let refresh = Arc::new(WalletRefresh::new(runtime));
        let (started, begun) = oneshot::channel();
        let worker = refresh.clone();
        let task = tokio::spawn(async move {
            worker
                .refresh(|| async {
                    started.send(()).unwrap();
                    std::future::pending().await
                })
                .await
        });
        begun.await.unwrap();
        let pause = tokio::time::timeout(Duration::from_secs(1), refresh.pause())
            .await
            .expect("pause must revoke setup before waiting for its gate");
        assert!(task.await.unwrap().is_err());
        assert_eq!(
            refresh
                .refresh(|| async { panic!("refresh during policy write") })
                .await,
            Ok(RefreshOutcome::Busy)
        );
        drop(pause);
        assert_eq!(
            refresh
                .refresh(|| async { Ok(RefreshOutcome::Refreshed) })
                .await,
            Ok(RefreshOutcome::Refreshed)
        );
    }

    #[tokio::test]
    async fn setup_failure_marks_retained_snapshot_stale_but_busy_does_not() {
        let mut state = open_state();
        state.wallet_sync.history_fresh = true;
        state.wallet_sync.utxos_fresh = true;
        state.wallet_sync.confirmed_sats = Some(42);
        let runtime = AppRuntime::spawn(state);
        let refresh = WalletRefresh::new(runtime.clone());
        assert_eq!(
            refresh.refresh(|| async { Ok(RefreshOutcome::Busy) }).await,
            Ok(RefreshOutcome::Busy)
        );
        assert!(fresh(&runtime.state()));
        assert!(refresh
            .refresh(|| async { Err("adapter unavailable".into()) })
            .await
            .is_err());
        assert!(!fresh(&runtime.state()));
        assert_eq!(
            runtime.state().wallet_sync.error.as_deref(),
            Some(STALE_REASON)
        );
    }
}
