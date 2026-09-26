//! Provider work runs outside the reducer; publication runs inside it. A result
//! is usable only by its issuing runtime, wallet/network session, and request.

use crate::wallet_birthday::{JustifiedLowerBound, ScanFloor, WalletRestoreState};
use crate::wallet_checkpoint::WalletCheckpoint;
use crate::{
    chain_service::{ChainService, WalletInterest},
    hd_sync::{HdAccountScan, HdSyncLimits},
    reconciliation::{ReconciliationDecision, ReconciliationState},
    sync_worker::{
        wallet_scripts, ProgressiveSyncError, ProgressiveSyncWorker, WalletNetworkSnapshot,
    },
    AppRuntime, RuntimeRequest,
};
use optn_app::{AppEvent, AppState};
use optn_core::{cashaddr::Address, network::Network};
use std::sync::Arc;
use tokio::sync::{broadcast, oneshot, watch};

pub type WalletReconciliation = ReconciliationState<WalletNetworkSnapshot>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WalletSyncError {
    Closed,
    NoWallet,
    InvalidScope(String),
    HistoryHeadersRequired(crate::wallet_birthday::UndecidableReason),
    Superseded,
    InvalidSnapshot(String),
    HdDiscovery(String),
    Persistence(String),
    Refresh {
        error: ProgressiveSyncError,
        reason: Option<String>,
    },
}

impl std::fmt::Display for WalletSyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => f.write_str("application runtime is closed"),
            Self::NoWallet => f.write_str("open a wallet before synchronizing"),
            Self::HistoryHeadersRequired(reason) => write!(f,
                "Wallet history start needs authenticated headers ({reason:?}); choose Unknown for full history or an explicit rescan height."),
            Self::InvalidScope(reason)
            | Self::InvalidSnapshot(reason)
            | Self::Persistence(reason)
            | Self::HdDiscovery(reason) => f.write_str(reason),
            Self::Superseded => f.write_str("wallet sync request is no longer current"),
            Self::Refresh {
                reason: Some(reason),
                ..
            } => f.write_str(reason),
            Self::Refresh {
                error,
                reason: None,
            } => write!(f, "wallet refresh failed: {error:?}"),
        }
    }
}

impl std::error::Error for WalletSyncError {}

// This token never crosses a renderer transport. Arc identity prevents both
// network-away-and-back ABA and publication into another runtime instance.
pub(super) struct WalletSyncLease {
    id: Arc<()>,
    generation: u64,
    network: Network,
    floor: Option<u32>,
    coverage: Option<optn_app::ScanCoverageView>,
    addresses: Vec<String>,
    interests: Vec<WalletInterest>,
    baseline: Box<WalletReconciliation>,
    cancelled: watch::Receiver<()>,
    source_lifetime: Option<crate::chain_service::ChainRevocation>,
    header_progress: Option<crate::wallet_checkpoint::StoredHeaderProgress>,
    identities:
        Option<std::collections::BTreeMap<[u8; 32], crate::token_metadata::OwnedCategoryIdentity>>,
    // Closing this sender also covers caller timeouts and aborted tasks. The
    // driver observes it directly, so cleanup cannot be lost to a full queue.
    _completion: oneshot::Sender<()>,
}

impl WalletSyncLease {
    pub(super) fn capture_header_progress(
        &mut self,
        view: Option<&crate::header_view::VerifiedHeaderView>,
    ) -> Result<(), WalletSyncError> {
        if let Some(view) = view {
            if view.network() != self.network {
                return Err(WalletSyncError::InvalidSnapshot(
                    "header progress belongs to another network".into(),
                ));
            }
            self.header_progress = Some(crate::wallet_checkpoint::StoredHeaderProgress {
                view: view
                    .encode()
                    .map_err(|error| WalletSyncError::InvalidSnapshot(format!("{error:?}")))?,
                trusted: view.checkpoint(),
            });
        }
        Ok(())
    }
}

pub(super) enum WalletSyncRequest {
    /// The header progress a restored checkpoint brought back, if any.
    RestoredHeaderProgress(oneshot::Sender<Option<crate::wallet_checkpoint::StoredHeaderProgress>>),
    ScanFloor {
        view: crate::header_view::VerifiedHeaderView,
        lookback: u32,
        justified_lower_bound: Option<JustifiedLowerBound>,
        reply: oneshot::Sender<Result<ScanFloor, WalletSyncError>>,
    },
    Checkpoint(oneshot::Sender<Result<WalletCheckpoint, WalletSyncError>>),
    Restore(
        Box<WalletCheckpoint>,
        oneshot::Sender<Result<(), WalletSyncError>>,
    ),
    BeginHd(
        String,
        HdSyncLimits,
        Option<crate::header_view::VerifiedHeaderView>,
        u64,
        oneshot::Sender<Result<(WalletSyncLease, HdAccountScan), WalletSyncError>>,
    ),
    Begin(
        Vec<String>,
        oneshot::Sender<Result<WalletSyncLease, WalletSyncError>>,
    ),
    Finish(
        WalletSyncLease,
        Box<WalletReconciliation>,
        oneshot::Sender<Result<ReconciliationDecision, WalletSyncError>>,
    ),
    Invalidate(String, oneshot::Sender<()>),
}

impl AppRuntime {
    /// Record and persist intent before provider setup can fail or time out.
    pub async fn request_wallet_rescan(&self, height: u32) -> Result<(), WalletSyncError> {
        self.dispatch(optn_app::AppAction::RequestRescanFrom { height })
            .await
            .map_err(|_| WalletSyncError::Closed)?;
        if self.state().wallet_sync.rescan_requested != Some(height) {
            return Err(WalletSyncError::Persistence(
                "the wallet rescan request could not be recorded".into(),
            ));
        }
        Ok(())
    }

    /// Capture wallet state in the same actor turn as its local annotations.
    /// Native/browser storage encrypts this with the unlocked wallet's key.
    pub async fn wallet_checkpoint(&self) -> Result<WalletCheckpoint, WalletSyncError> {
        let (reply, received) = oneshot::channel();
        self.action_tx
            .send(RuntimeRequest::WalletSync(WalletSyncRequest::Checkpoint(
                reply,
            )))
            .await
            .map_err(|_| WalletSyncError::Closed)?;
        received.await.map_err(|_| WalletSyncError::Closed)?
    }

    /// Restore only into an already opened, matching, untouched wallet session.
    /// This never opens a wallet or marks its coins fresh/spendable by itself.
    pub async fn restore_wallet_checkpoint(
        &self,
        checkpoint: WalletCheckpoint,
    ) -> Result<(), WalletSyncError> {
        let (reply, received) = oneshot::channel();
        self.action_tx
            .send(RuntimeRequest::WalletSync(WalletSyncRequest::Restore(
                Box::new(checkpoint),
                reply,
            )))
            .await
            .map_err(|_| WalletSyncError::Closed)?;
        received.await.map_err(|_| WalletSyncError::Closed)?
    }
    /// The verified header progress this wallet last had sealed, if any.
    ///
    /// Restored on open, before any pass runs. A host seeds its worker from
    /// this so the accumulator resumes at the height the wallet reached
    /// rather than at genesis; `None` means a fresh wallet, a record written
    /// before progress was persisted, or a wallet that has never completed a
    /// header pass -- all of which correctly start from the shipped anchor.
    pub async fn restored_header_progress(
        &self,
    ) -> Result<Option<crate::wallet_checkpoint::StoredHeaderProgress>, WalletSyncError> {
        let (reply, received) = oneshot::channel();
        self.action_tx
            .send(RuntimeRequest::WalletSync(
                WalletSyncRequest::RestoredHeaderProgress(reply),
            ))
            .await
            .map_err(|_| WalletSyncError::Closed)?;
        received.await.map_err(|_| WalletSyncError::Closed)
    }

    /// Resolve the persisted wallet birthday against a caller-supplied
    /// authenticated header view. The view is cloned into the actor request;
    /// no renderer value can become a trusted anchor or a scan floor.
    pub async fn wallet_scan_floor(
        &self,
        view: &crate::header_view::VerifiedHeaderView,
        lookback: u32,
        justified_lower_bound: Option<JustifiedLowerBound>,
    ) -> Result<ScanFloor, WalletSyncError> {
        let (reply, received) = oneshot::channel();
        self.action_tx
            .send(RuntimeRequest::WalletSync(WalletSyncRequest::ScanFloor {
                view: view.clone(),
                lookback,
                justified_lower_bound,
                reply,
            }))
            .await
            .map_err(|_| WalletSyncError::Closed)?;
        received.await.map_err(|_| WalletSyncError::Closed)?
    }

    /// Synchronize the selected HD account from public material only, covering
    /// receive/change/DeFi until each branch reaches its history-based gap.
    /// No partial round publishes coins; session invalidation applies to the
    /// entire discovery operation. P2P still requires a trusted header worker.
    pub async fn sync_hd_wallet(
        &self,
        service: &mut ChainService,
        worker: &mut ProgressiveSyncWorker,
        account_xpub: String,
        limits: HdSyncLimits,
    ) -> Result<ReconciliationDecision, WalletSyncError> {
        self.sync_hd_wallet_from_floor(service, worker, account_xpub, limits, None)
            .await
    }

    /// The same discovery, starting at a resolved scan floor.
    ///
    /// `floor` is where this wallet's history can begin -- its birthday, or a
    /// height its holder asked to rescan from. It is not a resume point and it
    /// does not merge onto a baseline: each round is a complete answer that
    /// happens to start there.
    ///
    /// `None` uses the durable birthday and any outstanding manual rescan.
    /// Unknown provenance resolves to an explicit genesis floor, including
    /// for P2P providers; unresolved dates never become a guessed recent floor.
    pub async fn sync_hd_wallet_from_floor(
        &self,
        service: &mut ChainService,
        worker: &mut ProgressiveSyncWorker,
        account_xpub: String,
        limits: HdSyncLimits,
        floor: Option<u32>,
    ) -> Result<ReconciliationDecision, WalletSyncError> {
        if let Some(height) = floor {
            self.request_wallet_rescan(height).await?;
        }
        let generation = self.revocation.load(std::sync::atomic::Ordering::SeqCst);
        let mut begun = self
            .begin_hd_scan(account_xpub.clone(), limits, worker, generation)
            .await;
        if matches!(begun, Err(WalletSyncError::HistoryHeadersRequired(_)))
            && worker.header_view().is_some()
        {
            // Acquire only authenticated headers on a permitted wallet route;
            // never query wallet history with a guessed floor. Each route gets
            // one existing bounded header pass before the actor resolves again.
            service.retry_offline_routes();
            let mut state = self.subscribe_state();
            for route in
                service.routes_for_operation(crate::chain_service::ChainOperation::WalletRefresh)
            {
                if self.revocation.load(std::sync::atomic::Ordering::SeqCst) != generation {
                    return Err(WalletSyncError::Superseded);
                }
                let acquired = {
                    let headers = worker.prime_headers_on_same_route(service, &route);
                    tokio::pin!(headers);
                    loop {
                        tokio::select! {
                            biased;
                            changed = state.changed() => {
                                changed.map_err(|_| WalletSyncError::Closed)?;
                                if self.revocation.load(std::sync::atomic::Ordering::SeqCst) != generation {
                                    return Err(WalletSyncError::Superseded);
                                }
                            }
                            result = &mut headers => break result,
                        }
                    }
                };
                if service.revocation().is_revoked()
                    || self.revocation.load(std::sync::atomic::Ordering::SeqCst) != generation
                {
                    return Err(WalletSyncError::Superseded);
                }
                if acquired.is_ok() {
                    begun = self
                        .begin_hd_scan(account_xpub.clone(), limits, worker, generation)
                        .await;
                    break;
                }
            }
        }
        let (mut lease, mut scan) = begun?;
        let floor = lease.floor;
        lease.source_lifetime = Some(service.revocation());
        worker.restore((*lease.baseline).clone());
        loop {
            let refreshed = tokio::select! {
                biased;
                _ = lease.cancelled.changed() => return Err(WalletSyncError::Superseded),
                result = worker.refresh_with_scope(
                    service,
                    lease.interests.clone(),
                    crate::sync_worker::RefreshScope::Complete { floor },
                ) => result,
            };
            let advance = match &refreshed {
                Ok(outcome) if outcome.decision == ReconciliationDecision::Accepted => scan
                    .advance(
                        &worker
                            .reconciliation()
                            .authoritative
                            .as_ref()
                            .expect("accepted snapshot")
                            .value,
                    ),
                _ => Ok(true),
            };
            match advance {
                Ok(false) => {
                    lease.addresses = scan.addresses();
                    lease.interests = scan.interests();
                }
                completion => {
                    if completion == Ok(true)
                        && refreshed.as_ref().is_ok_and(|outcome| {
                            outcome.decision == ReconciliationDecision::Accepted
                        })
                    {
                        worker
                            .reconciliation_mut()
                            .authoritative
                            .as_mut()
                            .expect("accepted HD snapshot")
                            .value
                            .hd = Some(scan.address_book());
                        let snapshot = &worker
                            .reconciliation()
                            .authoritative
                            .as_ref()
                            .expect("accepted HD snapshot")
                            .value;
                        let mut coins = Default::default();
                        snapshot
                            .reconcile_coins(lease.network, &lease.addresses, &mut coins)
                            .map_err(|error| WalletSyncError::InvalidSnapshot(error.to_string()))?;
                        let categories = coins
                            .iter()
                            .filter_map(|coin| coin.token().map(|token| token.category))
                            .collect();
                        lease.identities = Some(tokio::select! {
                            biased;
                            _ = lease.cancelled.changed() => return Err(WalletSyncError::Superseded),
                            result = crate::token_metadata::resolve_selected_identities(
                                service, categories, &snapshot.transactions,
                            ) => result,
                        });
                    }
                    if let Err(reason) = &completion {
                        worker.reconciliation_mut().record_failure(reason.clone());
                    }
                    lease.capture_header_progress(worker.header_view())?;
                    let decision = self
                        .finish_wallet_sync(lease, worker.reconciliation().clone())
                        .await?;
                    completion.map_err(WalletSyncError::HdDiscovery)?;
                    let outcome = refreshed.map_err(|error| WalletSyncError::Refresh {
                        error,
                        reason: worker.reconciliation().sync.degraded_reason.clone(),
                    })?;
                    return Ok(if outcome.decision == ReconciliationDecision::Accepted {
                        decision
                    } else {
                        outcome.decision
                    });
                }
            }
        }
    }

    async fn begin_hd_scan(
        &self,
        xpub: String,
        limits: HdSyncLimits,
        worker: &ProgressiveSyncWorker,
        generation: u64,
    ) -> Result<(WalletSyncLease, HdAccountScan), WalletSyncError> {
        let (reply, received) = oneshot::channel();
        self.action_tx
            .send(RuntimeRequest::WalletSync(WalletSyncRequest::BeginHd(
                xpub,
                limits,
                worker.header_view().cloned(),
                generation,
                reply,
            )))
            .await
            .map_err(|_| WalletSyncError::Closed)?;
        received.await.map_err(|_| WalletSyncError::Closed)?
    }

    /// Refresh an explicit public address-observation session. Seed, hardware,
    /// multisig and HD watch-only wallets cannot use this to claim account
    /// completeness; use `sync_hd_wallet` for ordinary HD accounts. Retained
    /// watched scripts and coins must remain covered by subsequent queries.
    ///
    /// The host supplies the selected chain service and, for P2P, a worker seeded
    /// with a trusted checkpoint. Provider completeness remains evidence-labelled.
    pub async fn sync_wallet(
        &self,
        service: &mut ChainService,
        worker: &mut ProgressiveSyncWorker,
        addresses: Vec<String>,
        from_height: Option<u32>,
    ) -> Result<ReconciliationDecision, WalletSyncError> {
        let mut lease = self.begin_wallet_sync(addresses).await?;
        lease.source_lifetime = Some(service.revocation());
        worker.restore((*lease.baseline).clone());
        let refreshed = tokio::select! {
            biased;
            _ = lease.cancelled.changed() => return Err(WalletSyncError::Superseded),
            result = worker.refresh(service, lease.interests.clone(), from_height) => result,
        };
        lease.capture_header_progress(worker.header_view())?;
        let decision = self
            .finish_wallet_sync(lease, worker.reconciliation().clone())
            .await?;
        let outcome = refreshed.map_err(|error| WalletSyncError::Refresh {
            error,
            reason: worker.reconciliation().sync.degraded_reason.clone(),
        })?;
        if decision == ReconciliationDecision::PreservedFailure
            && outcome.decision != ReconciliationDecision::Accepted
        {
            return Ok(outcome.decision);
        }
        Ok(decision)
    }

    /// Invalidate in-flight work when native source, credentials, or privacy
    /// policy changes without an AppAction. Retained evidence is not erased.
    pub async fn invalidate_wallet_sync(&self, reason: String) -> Result<(), WalletSyncError> {
        let (reply, received) = oneshot::channel();
        self.action_tx
            .send(RuntimeRequest::WalletSync(WalletSyncRequest::Invalidate(
                reason, reply,
            )))
            .await
            .map_err(|_| WalletSyncError::Closed)?;
        received.await.map_err(|_| WalletSyncError::Closed)
    }

    /// Includes freshness and provenance; a coin balance alone is not sync status.
    pub fn subscribe_wallet_sync(&self) -> watch::Receiver<WalletReconciliation> {
        self.wallet_sync_rx.clone()
    }

    async fn begin_wallet_sync(
        &self,
        addresses: Vec<String>,
    ) -> Result<WalletSyncLease, WalletSyncError> {
        let (reply, received) = oneshot::channel();
        self.action_tx
            .send(RuntimeRequest::WalletSync(WalletSyncRequest::Begin(
                addresses, reply,
            )))
            .await
            .map_err(|_| WalletSyncError::Closed)?;
        received.await.map_err(|_| WalletSyncError::Closed)?
    }

    async fn finish_wallet_sync(
        &self,
        lease: WalletSyncLease,
        result: WalletReconciliation,
    ) -> Result<ReconciliationDecision, WalletSyncError> {
        let (reply, received) = oneshot::channel();
        self.action_tx
            .send(RuntimeRequest::WalletSync(WalletSyncRequest::Finish(
                lease,
                Box::new(result),
                reply,
            )))
            .await
            .map_err(|_| WalletSyncError::Closed)?;
        received.await.map_err(|_| WalletSyncError::Closed)?
    }
}

pub(super) struct WalletSyncSession {
    active: Option<Arc<()>>,
    cancellation_tx: Option<watch::Sender<()>>,
    abandoned: Option<oneshot::Receiver<()>>,
    state: WalletReconciliation,
    state_tx: watch::Sender<WalletReconciliation>,
    /// Registry fetch attempts for this session. Transport results only; the
    /// authchain walk still decides whether they may become Current.
    registry_fetches: Vec<(String, crate::token_metadata::FetchAttempt)>,
    /// The most recent verified header progress, awaiting a seal.
    header_progress: Option<crate::wallet_checkpoint::StoredHeaderProgress>,
    /// Private durable wallet-origin state. The app view only carries
    /// projections; this remains inside the runtime/checkpoint path.
    restore_state: WalletRestoreState,
}

impl WalletSyncSession {
    pub(super) async fn wait_for_abandonment(&mut self) {
        match self.abandoned.as_mut() {
            Some(completion) => {
                let _ = completion.await;
            }
            None => std::future::pending::<()>().await,
        }
    }

    pub(super) fn cancel_abandoned(&mut self) {
        self.invalidate("wallet refresh cancelled before completion".into());
    }

    pub(super) fn rescan_requested(&mut self) {
        self.invalidate("wallet rescan requested; retained observations need refresh".into());
    }

    pub(super) fn restore_state(&self) -> &WalletRestoreState {
        &self.restore_state
    }

    pub(super) fn install_restore_state(&mut self, restore_state: WalletRestoreState) {
        self.restore_state = restore_state;
    }

    pub(super) fn birthday_changed(&mut self, restore_state: WalletRestoreState) {
        self.restore_state = restore_state;
        self.invalidate("wallet birthday changed; retained observations need refresh".into());
    }

    pub(super) fn coins_are_fresh(&self) -> bool {
        self.state.sync.history_fresh && self.state.sync.utxos_fresh
    }

    pub(super) fn requires_fresh_coins(
        &self,
        action: &optn_app::AppAction,
        app: &AppState,
    ) -> bool {
        use optn_app::{AppAction, AuthScope};
        match action {
            AppAction::PrepareSend { .. }
            | AppAction::PrepareFlipstarterPledge { .. }
            | AppAction::AuthorizeSpend { .. } => self.requires_fresh_coins_for(AuthScope::Spend),
            AppAction::AuthorizeBackground { .. } => {
                self.requires_fresh_coins_for(AuthScope::Background)
            }
            AppAction::ConfirmAuth { .. } => app
                .lock
                .prompt
                .is_some_and(|scope| self.requires_fresh_coins_for(scope)),
            _ => false,
        }
    }

    pub(super) fn requires_fresh_coins_for(&self, scope: optn_app::AuthScope) -> bool {
        !self.coins_are_fresh()
            && matches!(
                scope,
                optn_app::AuthScope::Spend | optn_app::AuthScope::Background
            )
    }

    pub(super) fn new() -> (Self, watch::Receiver<WalletReconciliation>) {
        let (state_tx, state_rx) = watch::channel(WalletReconciliation::default());
        (
            Self {
                active: None,
                cancellation_tx: None,
                abandoned: None,
                state: WalletReconciliation::default(),
                state_tx,
                registry_fetches: Vec::new(),
                header_progress: None,
                restore_state: WalletRestoreState::default(),
            },
            state_rx,
        )
    }

    #[cfg(test)]
    pub(super) fn record_registry_fetches(
        &mut self,
        fetches: Vec<(String, crate::token_metadata::FetchAttempt)>,
    ) {
        self.registry_fetches = fetches;
    }

    pub(super) fn on_event(&mut self, event: &AppEvent) {
        match event {
            AppEvent::WalletOpened | AppEvent::WalletLocked | AppEvent::NetworkChanged(_) => {
                self.active = None;
                self.cancellation_tx = None;
                self.abandoned = None;
                self.state = WalletReconciliation::default();
                self.registry_fetches.clear();
                self.header_progress = None;
                self.restore_state = WalletRestoreState::default();
                self.publish_status();
            }
            AppEvent::ServersChanged | AppEvent::WalletRebuilt => {
                self.invalidate("wallet or chain settings changed".into());
            }
            _ => {}
        }
    }

    fn publish_status(&self) {
        self.state_tx.send_replace(self.state.clone());
    }

    pub(super) fn project_status(&self, app: &mut AppState) {
        if self.state.authoritative.is_none() {
            let requested = app.wallet_sync.rescan_requested;
            app.wallet_sync = optn_app::WalletSyncView::empty();
            app.wallet_sync.rescan_requested = requested;
        }
        let view = &mut app.wallet_sync;
        view.refreshing = self.active.is_some();
        view.history_fresh = self.state.sync.history_fresh;
        view.utxos_fresh = self.state.sync.utxos_fresh;
        view.error.clone_from(&self.state.sync.degraded_reason);
        view.source = self
            .state
            .authoritative
            .as_ref()
            .map(|snapshot| snapshot.source.as_str().to_owned());
        view.evidence = self.state.authoritative.as_ref().map(|snapshot| {
            match &snapshot.evidence {
                crate::chain::Evidence::ServerAssertion => "Server assertion",
                crate::chain::Evidence::MempoolObservation => "Mempool observation",
                crate::chain::Evidence::HeaderLinked { .. } => "Header linked",
                crate::chain::Evidence::HeaderPowVerified { .. } => "Header proof of work",
                crate::chain::Evidence::HeaderMmrProven { .. } => "Header MMR proof",
                crate::chain::Evidence::MerkleTransactionIncluded { .. } => {
                    "Transaction inclusion proof"
                }
                crate::chain::Evidence::FullNodeValidated { .. } => "Full node validation",
            }
            .to_owned()
        });
        view.tip_height = self
            .state
            .authoritative
            .as_ref()
            .and_then(|snapshot| snapshot.chain_tip.map(|tip| tip.0));
        if !view.utxos_fresh || !view.history_fresh {
            for identity in app.token_identities.values_mut() {
                identity.status = match identity.status {
                    optn_app::IdentityStatus::Verified => optn_app::IdentityStatus::Stale,
                    optn_app::IdentityStatus::Unpublished => optn_app::IdentityStatus::Unresolved,
                    status => status,
                };
            }
        }
    }

    fn publish_app(&self, app: &mut AppState, app_tx: &watch::Sender<AppState>) {
        self.project_status(app);
        crate::publish_state(app, app_tx);
    }

    pub(super) fn header_progress(
        &self,
    ) -> Option<&crate::wallet_checkpoint::StoredHeaderProgress> {
        self.header_progress.as_ref()
    }

    pub(super) fn reconciliation(&self) -> &WalletReconciliation {
        &self.state
    }

    fn invalidate(&mut self, reason: String) {
        self.active = None;
        self.cancellation_tx = None;
        self.abandoned = None;
        self.state.record_failure(reason);
        self.publish_status();
    }

    /// Open/restore callers validate account ownership before installing it.
    pub(super) fn install_checkpoint(&mut self, checkpoint: WalletCheckpoint, app: &mut AppState) {
        let token_identities = checkpoint.restored_token_identities();
        // Carried into the session so the host can seed its worker with the
        // accumulator this wallet last verified, instead of starting over at
        // genesis. Kept as the session's current progress too: if the next
        // pass never publishes, the seal that follows should preserve what
        // was already durable rather than drop back to nothing.
        self.header_progress = checkpoint.header_progress().cloned();
        self.restore_state = checkpoint.restore_state().clone();
        app.wallet_sync = checkpoint
            .state
            .authoritative
            .as_ref()
            .map(|snapshot| snapshot.value.wallet_view())
            .transpose()
            .expect("checkpoint projection validated before installation")
            .unwrap_or_default();
        app.wallet_sync.scan_coverage = checkpoint.scan_coverage;
        app.wallet_sync.rescan_requested = checkpoint.rescan_requested;
        app.coins = checkpoint.coins;
        // The cache is useful presentation, never live authchain evidence.
        // `WalletCheckpoint` downgrades it before this actor publishes it.
        app.token_identities = token_identities;
        app.hd_addresses = checkpoint.allocation;
        if app.hd_addresses.is_some() {
            let wallet = app
                .wallet
                .as_mut()
                .expect("checkpoint wallet validated before installation");
            wallet.account_xpub = Some(checkpoint.account_xpub);
        }
        crate::wallet_checkpoint::update_receive_address(app)
            .expect("checkpoint ownership and allocation validated before installation");
        app.spend = None;
        self.state = checkpoint.state;
        self.state
            .record_failure("restored wallet state requires a live refresh");
        self.project_status(app);
        self.publish_status();
    }

    pub(super) fn persist_annotation(
        &mut self,
        app: &mut AppState,
        previous: AppState,
        restore_state: &WalletRestoreState,
        persist: impl FnOnce(
            &AppState,
            &WalletReconciliation,
            &WalletRestoreState,
            Option<&crate::wallet_checkpoint::StoredHeaderProgress>,
        ) -> Result<(), optn_transport::TransportError>,
        may_publish: impl Fn(&AppState) -> bool,
    ) -> AppEvent {
        if !may_publish(app)
            || persist(
                app,
                &self.state,
                restore_state,
                self.header_progress.as_ref(),
            )
            .is_err()
            || !may_publish(app)
        {
            *app = previous;
            app.spend = None;
            app.notice = Some("Wallet annotation could not be saved or publication was cancelled. Reopen the wallet before continuing.".into());
            self.invalidate(
                "wallet annotation save failed or was cancelled; reopen before continuing".into(),
            );
            return AppEvent::NoticeChanged;
        }
        AppEvent::CoinsChanged
    }

    pub(super) fn handle(
        &mut self,
        request: WalletSyncRequest,
        app: &mut AppState,
        app_tx: &watch::Sender<AppState>,
        events: &broadcast::Sender<AppEvent>,
        mut security: Option<&mut crate::wallet_security::WalletSecurity>,
        guard: crate::PublicationGuard<'_>,
    ) {
        match request {
            WalletSyncRequest::RestoredHeaderProgress(reply) => {
                let _ = reply.send(self.header_progress.clone());
            }
            WalletSyncRequest::ScanFloor {
                view,
                lookback,
                justified_lower_bound,
                reply,
            } => {
                let result = if app.wallet.is_none() {
                    Err(WalletSyncError::NoWallet)
                } else {
                    Ok(self.restore_state.scan_floor(
                        &view,
                        lookback,
                        justified_lower_bound.as_ref(),
                    ))
                };
                let _ = reply.send(result);
            }
            WalletSyncRequest::Checkpoint(reply) => {
                let captured = WalletCheckpoint::capture(app, &self.state, &self.restore_state)
                    .map_err(WalletSyncError::InvalidSnapshot)
                    .and_then(|checkpoint| match self.header_progress.as_ref() {
                        None => Ok(checkpoint),
                        Some(progress) => checkpoint
                            .with_stored_header_progress(progress.clone())
                            .map_err(WalletSyncError::InvalidSnapshot),
                    });
                let _ = reply.send(captured);
            }
            WalletSyncRequest::Restore(checkpoint, reply) => {
                let outcome = if self.active.is_some()
                    || self.state.authoritative.is_some()
                    || !app.coins.is_empty()
                {
                    Err(WalletSyncError::InvalidSnapshot(
                        "cannot replace a running wallet with stored state".into(),
                    ))
                } else {
                    checkpoint
                        .validate_wallet(app)
                        .map_err(WalletSyncError::InvalidSnapshot)
                };
                if outcome.is_ok() {
                    self.install_checkpoint(*checkpoint, app);
                    self.publish_app(app, app_tx);
                    let _ = events.send(AppEvent::CoinsChanged);
                }
                let _ = reply.send(outcome);
            }
            WalletSyncRequest::BeginHd(xpub, limits, view, generation, reply) => {
                let outcome = if generation == guard.generation {
                    self.begin_hd(app, xpub, limits, view, generation)
                } else {
                    Err(WalletSyncError::Superseded)
                };
                if outcome.is_ok() {
                    app.spend = None;
                    self.publish_app(app, app_tx);
                    let _ = events.send(AppEvent::CoinsChanged);
                }
                let _ = reply.send(outcome);
            }
            WalletSyncRequest::Begin(addresses, reply) => {
                let outcome = if app.wallet.as_ref().is_some_and(|wallet| {
                    wallet.kind != optn_app::WalletKind::WatchOnly
                        || wallet.account_xpub.is_some()
                        || wallet.multisig_policy.is_some()
                }) || self
                    .state
                    .authoritative
                    .as_ref()
                    .is_some_and(|snapshot| snapshot.value.hd.is_some())
                {
                    Err(WalletSyncError::InvalidScope(
                        "an HD wallet requires account-wide synchronization".into(),
                    ))
                } else {
                    self.begin(app, addresses, guard.generation)
                };
                if outcome.is_ok() {
                    app.spend = None;
                    self.publish_app(app, app_tx);
                    let _ = events.send(AppEvent::CoinsChanged);
                }
                let _ = reply.send(outcome);
            }
            WalletSyncRequest::Finish(lease, result, reply) => {
                let guard = crate::PublicationGuard {
                    generation: lease.generation,
                    ..guard
                };
                // Cloned before `finish` borrows the session, and passed to
                // the save so a restart resumes the accumulator where this
                // pass left it instead of at genesis.
                let progress = lease
                    .header_progress
                    .clone()
                    .or_else(|| self.header_progress.clone());
                let outcome = self.finish(
                    app,
                    lease,
                    *result,
                    |app, state, restore_state| match security.as_deref_mut() {
                        Some(security) => security.persist_checkpoint(
                            app,
                            state,
                            restore_state,
                            progress.as_ref(),
                        ),
                        None => Ok(()),
                    },
                    |app| guard.allows(app, reply.is_closed()),
                );
                if outcome == Ok(ReconciliationDecision::Accepted) {
                    self.header_progress = progress;
                    if let Some(security) = security {
                        security.checkpoint_published();
                    }
                    let _ = events.send(AppEvent::CoinsChanged);
                }
                self.publish_app(app, app_tx);
                let _ = reply.send(outcome);
            }
            WalletSyncRequest::Invalidate(reason, reply) => {
                self.invalidate(reason);
                if app.spend.take().is_some() {
                    let _ = events.send(AppEvent::CoinsChanged);
                }
                self.publish_app(app, app_tx);
                let _ = reply.send(());
            }
        }
    }

    fn begin(
        &mut self,
        app: &AppState,
        addresses: Vec<String>,
        generation: u64,
    ) -> Result<WalletSyncLease, WalletSyncError> {
        let wallet = app.wallet.as_ref().ok_or(WalletSyncError::NoWallet)?;
        let watched = wallet_scripts(app.network, &addresses, &app.coins)
            .map_err(|error| WalletSyncError::InvalidScope(error.to_string()))?;
        let receive =
            Address::decode(&wallet.receive_address).map_err(WalletSyncError::InvalidScope)?;
        if receive.prefix != app.network.prefix() || !watched.contains_key(&receive.script_pubkey())
        {
            return Err(WalletSyncError::InvalidScope(
                "wallet receive address is outside the selected sync scope".into(),
            ));
        }
        // Empty previous branches still carry history/evidence and cannot be
        // dropped just because they currently contain no coins.
        if self.state.authoritative.as_ref().is_some_and(|previous| {
            previous.value.interests.iter().any(|interest| {
            !matches!(interest, WalletInterest::Script(script) if watched.contains_key(script))
        })
        }) {
            return Err(WalletSyncError::InvalidScope(
                "wallet refresh cannot omit previously watched scripts".into(),
            ));
        }
        let id = Arc::new(());
        let (cancellation_tx, cancelled) = watch::channel(());
        let (completion, abandoned) = oneshot::channel();
        let lease = WalletSyncLease {
            id: id.clone(),
            generation,
            network: app.network,
            floor: app.wallet_sync.rescan_requested.or_else(|| {
                app.wallet_sync
                    .scan_coverage
                    .map(|coverage| coverage.from_height)
            }),
            coverage: app
                .wallet_sync
                .rescan_requested
                .map(|height| optn_app::ScanCoverageView {
                    from_height: height,
                    skipped_below: (height > 0).then_some(height),
                    chosen_by_holder: true,
                })
                .or(app.wallet_sync.scan_coverage),
            addresses: watched.values().cloned().collect(),
            interests: watched
                .keys()
                .cloned()
                .map(WalletInterest::Script)
                .collect(),
            baseline: Box::new(self.state.clone()),
            cancelled,
            source_lifetime: None,
            header_progress: None,
            identities: None,
            _completion: completion,
        };
        self.active = Some(id);
        self.cancellation_tx = Some(cancellation_tx);
        self.abandoned = Some(abandoned);
        self.state.sync.history_fresh = false;
        self.state.sync.utxos_fresh = false;
        self.state.sync.degraded_reason = Some("wallet refresh in progress".into());
        self.publish_status();
        Ok(lease)
    }

    fn begin_hd(
        &mut self,
        app: &AppState,
        xpub: String,
        limits: HdSyncLimits,
        view: Option<crate::header_view::VerifiedHeaderView>,
        generation: u64,
    ) -> Result<(WalletSyncLease, HdAccountScan), WalletSyncError> {
        let wallet = app.wallet.as_ref().ok_or(WalletSyncError::NoWallet)?;
        if wallet.multisig_policy.is_some() {
            return Err(WalletSyncError::InvalidScope(
                "multisig discovery requires its complete public descriptor".into(),
            ));
        }
        if wallet
            .account_xpub
            .as_ref()
            .is_some_and(|known| known.trim() != xpub.trim())
        {
            return Err(WalletSyncError::InvalidScope(
                "HD account differs from the opened wallet".into(),
            ));
        }
        let account = optn_core::hd::parse_account_path(&wallet.account_path)
            .map_err(|error| WalletSyncError::InvalidScope(error.to_string()))?;
        let mut required = std::collections::BTreeSet::new();
        if let Some(allocation) = &app.hd_addresses {
            // Retain every issued/reserved branch horizon, even if no provider
            // has seen funds there yet. The scan covers all intervening indexes.
            for (branch, next) in allocation.next_indexes().into_iter().enumerate() {
                if let Some(index) = next.checked_sub(1) {
                    let address = optn_core::watch_only::address_under_account(
                        app.network,
                        &xpub,
                        optn_core::watch_only::HD_SCAN_BRANCHES[branch],
                        index,
                    )
                    .map_err(|error| WalletSyncError::InvalidScope(error.to_string()))?;
                    required.insert(
                        Address::decode(&address.address)
                            .map_err(WalletSyncError::InvalidScope)?
                            .script_pubkey(),
                    );
                }
            }
        }
        required.insert(
            Address::decode(&wallet.receive_address)
                .map_err(WalletSyncError::InvalidScope)?
                .script_pubkey(),
        );
        for coin in app.coins.iter() {
            required.insert(
                Address::decode(coin.address())
                    .map_err(WalletSyncError::InvalidScope)?
                    .script_pubkey(),
            );
        }
        if let Some(previous) = &self.state.authoritative {
            for interest in &previous.value.interests {
                let WalletInterest::Script(script) = interest else {
                    return Err(WalletSyncError::InvalidScope(
                        "HD discovery cannot discard a non-script wallet scope".into(),
                    ));
                };
                required.insert(script.clone());
            }
        }
        // Resolve under the same actor turn that issues the lease. Reading a
        // birthday first and issuing a lease later could cross a wallet switch.
        // An empty view supplies no date/creation evidence; explicit heights
        // and Unknown still have well-defined conservative behavior.
        let view = view.unwrap_or_else(|| {
            crate::header_view::VerifiedHeaderView::new(
                app.network,
                crate::header_verifier::ShvMmrHeaderVerifier::empty(
                    crate::chain::CheckpointProvenance::SelfDerived,
                ),
            )
        });
        if view.network() != app.network {
            return Err(WalletSyncError::InvalidScope(
                "header view belongs to another network".into(),
            ));
        }
        let (from_height, skipped_below, chosen_by_holder) =
            match self.restore_state.scan_floor(&view, 0, None) {
                ScanFloor::FullHistory => (0, None, false),
                ScanFloor::Complete { from_height } => {
                    let chosen = self.restore_state.manual_rescan.is_some()
                        || !matches!(
                            self.restore_state.birthday,
                            crate::wallet_birthday::WalletBirthday::CreatedAt(_)
                        );
                    // A user-supplied origin remains a claim: keep the UI's
                    // warning that observations below this height are absent.
                    (
                        from_height,
                        (chosen && from_height > 0).then_some(from_height),
                        chosen,
                    )
                }
                ScanFloor::Incomplete { from_height, .. } => {
                    (from_height, (from_height > 0).then_some(from_height), true)
                }
                ScanFloor::Undecidable(reason) => {
                    return Err(WalletSyncError::HistoryHeadersRequired(reason))
                }
            };
        let scan = HdAccountScan::new(app.network, xpub, account, limits, required)
            .map_err(WalletSyncError::InvalidScope)?;
        let mut lease = self.begin(app, scan.addresses(), generation)?;
        lease.floor = Some(from_height);
        lease.coverage = Some(optn_app::ScanCoverageView {
            from_height,
            skipped_below,
            chosen_by_holder,
        });
        Ok((lease, scan))
    }

    fn finish(
        &mut self,
        app: &mut AppState,
        lease: WalletSyncLease,
        result: WalletReconciliation,
        persist: impl FnOnce(
            &AppState,
            &WalletReconciliation,
            &WalletRestoreState,
        ) -> Result<(), optn_transport::TransportError>,
        may_publish: impl Fn(&AppState) -> bool,
    ) -> Result<ReconciliationDecision, WalletSyncError> {
        if !self
            .active
            .as_ref()
            .is_some_and(|id| Arc::ptr_eq(id, &lease.id))
        {
            return Err(WalletSyncError::Superseded);
        }
        let may_publish = |app: &AppState| {
            may_publish(app)
                && !lease
                    .source_lifetime
                    .as_ref()
                    .is_some_and(|source| source.is_revoked())
        };
        if !may_publish(app) {
            self.invalidate("wallet refresh cancelled before publication".into());
            return Err(WalletSyncError::Superseded);
        }
        self.active = None;
        self.cancellation_tx = None;
        self.abandoned = None;
        if !result.sync.history_fresh || !result.sync.utxos_fresh || result.authoritative.is_none()
        {
            self.state.record_failure(
                result
                    .sync
                    .degraded_reason
                    .unwrap_or_else(|| "wallet refresh incomplete".into()),
            );
            self.publish_status();
            return Ok(ReconciliationDecision::PreservedFailure);
        }
        let candidate = result.authoritative.expect("checked above");
        if candidate.value.hd.is_none()
            && self
                .state
                .authoritative
                .as_ref()
                .is_some_and(|previous| previous.value.hd.is_some())
        {
            let reason = "an HD wallet requires account-wide synchronization".to_string();
            self.state.record_failure(reason.clone());
            self.publish_status();
            return Err(WalletSyncError::InvalidSnapshot(reason));
        }
        let tip = candidate
            .value
            .tip
            .as_ref()
            .map(|tip| (tip.height, tip.hash));
        if lease
            .floor
            .is_some_and(|floor| tip.is_none_or(|(height, _)| floor > height))
        {
            let reason = "wallet rescan floor is above the observed tip or the tip is unavailable"
                .to_owned();
            self.state.record_failure(reason.clone());
            self.publish_status();
            return Err(WalletSyncError::InvalidSnapshot(reason));
        }
        if candidate.value.interests != lease.interests || tip != candidate.chain_tip {
            let reason = "wallet snapshot scope or chain tip differs from its request".to_string();
            self.state.record_failure(reason.clone());
            self.publish_status();
            return Err(WalletSyncError::InvalidSnapshot(reason));
        }
        let mut next = self.state.clone();
        let decision = next.reconcile_candidate(
            candidate.value,
            candidate.source,
            candidate.evidence,
            candidate.chain_tip,
            true,
        );
        if decision == ReconciliationDecision::Accepted {
            let mut next_restore_state = self.restore_state.clone();
            if let Some((height, _)) = candidate.chain_tip {
                // A complete accepted rescan can end below the previous tip
                // after a reorg. Persist its actual coverage, not a stale max.
                next_restore_state.scanned_through = Some(height);
            }
            let mut candidate_app = app.clone();
            let snapshot = &next
                .authoritative
                .as_ref()
                .expect("accepted candidate")
                .value;
            if let Err(error) =
                snapshot.reconcile_coins(lease.network, &lease.addresses, &mut candidate_app.coins)
            {
                let reason = error.to_string();
                self.state.record_failure(reason.clone());
                self.publish_status();
                return Err(WalletSyncError::InvalidSnapshot(reason));
            }
            if let Err(reason) =
                crate::wallet_checkpoint::observe_allocation(&mut candidate_app, &next)
            {
                self.state.record_failure(reason.clone());
                self.publish_status();
                return Err(WalletSyncError::InvalidSnapshot(reason));
            }
            let evidence = next
                .authoritative
                .as_ref()
                .expect("accepted candidate")
                .evidence
                .clone();
            let collection = crate::token_metadata::IdentityCollection::from_observed(
                &snapshot.transactions,
                self.registry_fetches.clone(),
                evidence,
            );
            let observations = lease.identities.unwrap_or_else(|| {
                crate::token_metadata::collect_owned_token_identities(
                    crate::token_metadata::owned_token_categories(&candidate_app),
                    &collection,
                )
            });
            crate::token_metadata::apply_owned_token_identities(&mut candidate_app, &observations);
            candidate_app.wallet_sync = match snapshot.wallet_view() {
                Ok(view) => view,
                Err(error) => {
                    let reason = error.to_string();
                    self.state.record_failure(reason.clone());
                    self.publish_status();
                    return Err(WalletSyncError::InvalidSnapshot(reason));
                }
            };
            candidate_app.wallet_sync.scan_coverage = lease.coverage;
            if !may_publish(app) {
                self.invalidate("wallet refresh cancelled before persistence".into());
                return Err(WalletSyncError::Superseded);
            }
            if let Err(error) = persist(&candidate_app, &next, &next_restore_state) {
                let reason = match error {
                    optn_transport::TransportError::Other(reason) => reason,
                    _ => "wallet state could not be saved".into(),
                };
                self.state.record_failure(reason.clone());
                self.publish_status();
                return Err(WalletSyncError::Persistence(reason));
            }
            // Storage can block while a lock or source change is queued. A saved
            // checkpoint may be restored later, but it grants no fresh authority.
            if !may_publish(app) {
                self.invalidate("wallet refresh cancelled during persistence".into());
                return Err(WalletSyncError::Superseded);
            }
            app.coins = candidate_app.coins;
            app.hd_addresses = candidate_app.hd_addresses;
            app.wallet = candidate_app.wallet;
            app.wallet_sync = candidate_app.wallet_sync;
            app.token_identities = candidate_app.token_identities;
            // A prepared spend may refer to outputs removed by this refresh.
            app.spend = None;
            self.restore_state = next_restore_state;
        }
        self.state = next;
        self.publish_status();
        Ok(decision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        chain::{
            Capability, CapabilityConfidence, CapabilityDiscovery, CapabilitySet, ChainSource,
            ConnectionPolicy, Endpoint, EndpointKind, Evidence, ProtocolFamily, ProviderHealth,
            SourceCatalog, SourceDisposition, SourceId, SourceOrigin,
        },
        chain_service::{
            BackendObservation, ChainBackend, ChainBackendError, ChainFuture, ChainOperation,
            ChainPayload, ChainRequest, ChainService, ChainTip, ObservedTransaction,
            OutpointSpentness,
        },
        DirectTransport,
    };
    use optn_app::{AppAction, IdentityStatus, OpenedWallet, WalletKind};
    use optn_core::{
        cashaddr::AddressKind,
        coins::FreezeReason,
        hd::{AccountPath, Wallet, BIP39_TEST_VECTOR_MNEMONIC},
        watch_only::address_under_account,
    };
    use optn_transport::AppTransport;
    use std::{
        collections::BTreeMap,
        sync::{
            atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
            Arc,
        },
    };

    fn address() -> String {
        Address::from_hash("bchtest", AddressKind::P2pkh, [1; 20]).encode()
    }

    fn open() -> AppAction {
        AppAction::OpenImportedWallet {
            name: "public test wallet".into(),
            receive_address: address(),
            account_path: "m/44'/1'/0'".into(),
        }
    }

    fn observation_app() -> AppState {
        // Same non-HD address-observation session used by CLI balance/utxos.
        // Seed and hardware wallet sessions always require HD discovery.
        AppState {
            network: Network::Chipnet,
            wallet: Some(optn_app::OpenedWallet {
                kind: optn_app::WalletKind::WatchOnly,
                name: "public address observation".into(),
                receive_address: address(),
                master_fingerprint: None,
                account_path: "m/44'/1'/0'".into(),
                multisig_policy: None,
                account_xpub: None,
            }),
            ..Default::default()
        }
    }

    async fn runtime() -> AppRuntime {
        AppRuntime::spawn(observation_app())
    }

    fn hd_identity_app() -> (AppState, String, optn_core::wallet_pack::PackKey) {
        let account = AccountPath::new(1, 1).expect("fixture account");
        let wallet =
            Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "TREZOR").expect("fixture wallet");
        let xpub = wallet
            .account_xpub_at(account)
            .expect("fixture account xpub");
        let receive = address_under_account(Network::Chipnet, &xpub, 0, 0)
            .expect("fixture receive address")
            .address;
        let key = wallet
            .checkpoint_key(Network::Chipnet, account)
            .expect("fixture checkpoint key");
        (
            AppState {
                network: Network::Chipnet,
                wallet: Some(OpenedWallet {
                    kind: WalletKind::WatchOnly,
                    name: "HD metadata checkpoint fixture".into(),
                    receive_address: receive,
                    master_fingerprint: None,
                    account_path: account.to_string(),
                    multisig_policy: None,
                    account_xpub: Some(xpub.clone()),
                }),
                ..Default::default()
            },
            xpub,
            key,
        )
    }

    fn candidate(evidence: Evidence) -> WalletReconciliation {
        let script = Address::decode(&address()).unwrap().script_pubkey();
        // Serialization fixture only, not a mined or spendable transaction.
        let mut raw = vec![2, 0, 0, 0, 0, 1];
        raw.extend_from_slice(&1000u64.to_le_bytes());
        raw.extend_from_slice(&optn_core::tx::varint(script.len() as u64));
        raw.extend_from_slice(&script);
        raw.extend_from_slice(&[0; 4]);
        let mut state = WalletReconciliation::default();
        state.reconcile_candidate(
            WalletNetworkSnapshot {
                hd: None,
                interests: vec![WalletInterest::script(script)],
                transactions: vec![ObservedTransaction {
                    txid: optn_core::header_hash::sha256d(&raw),
                    raw,
                    block_height: None,
                }],
                tip: None,
            },
            SourceId::new("fixture"),
            evidence,
            None,
            true,
        );
        state
    }

    #[test]
    fn checkpoint_publication_cancelled_old_finish_keeps_newer_lease() {
        use crate::PublicationGuard;
        use std::sync::atomic::AtomicU64;

        let mut app = observation_app();
        let (mut session, status) = WalletSyncSession::new();
        let old = session.begin(&app, vec![address()], 0).unwrap();
        let newer = session.begin(&app, vec![address()], 0).unwrap();
        let (app_tx, _) = watch::channel(app.clone());
        let (events, _) = broadcast::channel(4);
        let revocation = AtomicU64::new(0);
        let (reply, received) = oneshot::channel();
        drop(received);
        session.handle(
            WalletSyncRequest::Finish(old, Box::new(candidate(Evidence::ServerAssertion)), reply),
            &mut app,
            &app_tx,
            &events,
            None,
            PublicationGuard {
                generation: 0,
                revocation: &revocation,
                now_ms: &|| 1,
            },
        );
        assert!(Arc::ptr_eq(session.active.as_ref().unwrap(), &newer.id));
        assert!(newer.cancelled.has_changed().is_ok());

        let (reply, mut received) = oneshot::channel();
        session.handle(
            WalletSyncRequest::Finish(newer, Box::new(candidate(Evidence::ServerAssertion)), reply),
            &mut app,
            &app_tx,
            &events,
            None,
            PublicationGuard {
                generation: 0,
                revocation: &revocation,
                now_ms: &|| 1,
            },
        );
        assert_eq!(
            received.try_recv().unwrap(),
            Ok(ReconciliationDecision::Accepted)
        );
        assert_eq!(app.coins.len(), 1);
        assert!(status.borrow().sync.utxos_fresh);
    }

    #[test]
    fn checkpoint_publication_closed_reply_skips_store() {
        use crate::PublicationGuard;
        use std::sync::atomic::AtomicU64;

        let mut app = observation_app();
        let (mut session, status) = WalletSyncSession::new();
        let lease = session.begin(&app, vec![address()], 0).unwrap();
        let revocation = AtomicU64::new(0);
        let guard = PublicationGuard {
            generation: 0,
            revocation: &revocation,
            now_ms: &|| 1,
        };
        let (reply, received) = oneshot::channel::<()>();
        drop(received);
        assert_eq!(
            session.finish(
                &mut app,
                lease,
                candidate(Evidence::ServerAssertion),
                |_, _, _| panic!("cancelled work must not write"),
                |app| guard.allows(app, reply.is_closed()),
            ),
            Err(WalletSyncError::Superseded)
        );
        assert!(session.active.is_none());
        assert!(app.coins.is_empty());
        assert!(!status.borrow().sync.utxos_fresh);
    }

    #[test]
    fn checkpoint_publication_cancel_during_store_keeps_commit_without_publishing() {
        use crate::PublicationGuard;
        use std::{cell::Cell, sync::atomic::AtomicU64};

        let mut app = observation_app();
        let (mut session, status) = WalletSyncSession::new();
        let lease = session.begin(&app, vec![address()], 0).unwrap();
        let revocation = AtomicU64::new(0);
        let guard = PublicationGuard {
            generation: 0,
            revocation: &revocation,
            now_ms: &|| 1,
        };
        let (reply, received) = oneshot::channel::<()>();
        let committed_revision = Cell::new(0);
        // Synchronous storage hook closes the real reply receiver at the same
        // boundary as a caller timing out while native storage is blocked.
        let result = session.finish(
            &mut app,
            lease,
            candidate(Evidence::ServerAssertion),
            |candidate, _, _| {
                assert_eq!(candidate.coins.len(), 1);
                committed_revision.set(1);
                drop(received);
                Ok(())
            },
            |app| guard.allows(app, reply.is_closed()),
        );
        assert_eq!(result, Err(WalletSyncError::Superseded));
        assert_eq!(committed_revision.get(), 1);
        assert!(app.coins.is_empty());
        assert!(status.borrow().authoritative.is_none());
        assert!(!status.borrow().sync.utxos_fresh);
    }

    #[test]
    fn checkpoint_publication_idle_deadline_during_store_refuses_freshness() {
        use crate::PublicationGuard;
        use std::{cell::Cell, sync::atomic::AtomicU64};

        let mut app = observation_app();
        app.lock.auto_lock = optn_app::AutoLockMinutes::Fifteen;
        app.lock.mark_unlocked();
        app.lock.record_activity(1);
        let (mut session, status) = WalletSyncSession::new();
        let lease = session.begin(&app, vec![address()], 0).unwrap();
        let now = Cell::new(900_000);
        let revocation = AtomicU64::new(0);
        let clock = || now.get();
        let guard = PublicationGuard {
            generation: 0,
            revocation: &revocation,
            now_ms: &clock,
        };
        assert!(guard.allows(&app, false));
        let result = session.finish(
            &mut app,
            lease,
            candidate(Evidence::ServerAssertion),
            |_, _, _| {
                now.set(900_001);
                Ok(())
            },
            |app| guard.allows(app, false),
        );
        assert_eq!(result, Err(WalletSyncError::Superseded));
        assert!(app.coins.is_empty());
        assert!(status.borrow().authoritative.is_none());
        assert!(!status.borrow().sync.utxos_fresh);
    }

    #[test]
    fn checkpoint_publication_annotations_recheck_reply_revocation_and_idle_after_store() {
        use crate::PublicationGuard;
        use std::{
            cell::Cell,
            sync::atomic::{AtomicU64, Ordering},
        };

        for cause in 0..3 {
            let mut app = observation_app();
            app.lock.auto_lock = optn_app::AutoLockMinutes::Fifteen;
            app.lock.mark_unlocked();
            app.lock.record_activity(1);
            let (mut session, status) = WalletSyncSession::new();
            let lease = session.begin(&app, vec![address()], 0).unwrap();
            session
                .finish(
                    &mut app,
                    lease,
                    candidate(Evidence::ServerAssertion),
                    |_, _, _| Ok(()),
                    |_| true,
                )
                .unwrap();
            let previous = app.clone();
            let outpoint = app.coins.iter().next().unwrap().outpoint();
            assert_eq!(
                app.reduce_intent(AppAction::FreezeCoin(outpoint)),
                Some(AppEvent::CoinsChanged)
            );
            let now = Cell::new(1);
            let revocation = AtomicU64::new(0);
            let clock = || now.get();
            let guard = PublicationGuard {
                generation: 0,
                revocation: &revocation,
                now_ms: &clock,
            };
            let (reply, received) = oneshot::channel::<()>();
            let mut received = Some(received);
            let committed = Cell::new(false);
            let event = session.persist_annotation(
                &mut app,
                previous.clone(),
                &session.restore_state().clone(),
                |app, _, _, _| {
                    assert_eq!(
                        app.coins.get(outpoint).unwrap().freeze(),
                        Some(FreezeReason::User)
                    );
                    committed.set(true);
                    match cause {
                        0 => drop(received.take()),
                        1 => {
                            revocation.fetch_add(1, Ordering::SeqCst);
                        }
                        _ => now.set(900_001),
                    }
                    Ok(())
                },
                |app| guard.allows(app, reply.is_closed()),
            );
            assert!(committed.get());
            assert_eq!(reply.is_closed(), cause == 0);
            assert_eq!(event, AppEvent::NoticeChanged);
            assert_eq!(app.coins, previous.coins);
            assert!(app.spend.is_none());
            assert!(!status.borrow().sync.utxos_fresh);
        }
    }

    #[tokio::test]
    async fn header_progress_is_bound_to_an_accepted_sync_and_cleared_on_lock() {
        use crate::header_verifier::shipped_header_verifier;
        use crate::header_view::VerifiedHeaderView;

        let runtime = runtime().await;
        let verifier = shipped_header_verifier(Network::Chipnet).expect("anchor");
        let view = VerifiedHeaderView::new(Network::Chipnet, verifier);

        let mut old = runtime.begin_wallet_sync(vec![address()]).await.unwrap();
        old.capture_header_progress(Some(&view)).unwrap();
        let mut current = runtime.begin_wallet_sync(vec![address()]).await.unwrap();
        assert_eq!(
            runtime
                .finish_wallet_sync(old, candidate(Evidence::ServerAssertion))
                .await,
            Err(WalletSyncError::Superseded)
        );
        assert!(runtime.restored_header_progress().await.unwrap().is_none());
        let foreign = VerifiedHeaderView::new(
            Network::Regtest,
            shipped_header_verifier(Network::Regtest).unwrap(),
        );
        assert!(current.capture_header_progress(Some(&foreign)).is_err());
        current.capture_header_progress(Some(&view)).unwrap();
        assert_eq!(
            runtime
                .finish_wallet_sync(current, candidate(Evidence::ServerAssertion))
                .await
                .unwrap(),
            ReconciliationDecision::Accepted
        );
        let saved = runtime.restored_header_progress().await.unwrap().unwrap();
        assert_eq!(saved.trusted, view.checkpoint());
        assert_eq!(saved.view, view.encode().unwrap());
        runtime.dispatch(AppAction::LockWallet).await.unwrap();
        assert!(runtime.restored_header_progress().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn checkpoint_publication_open_status_failure_cannot_keep_previous_wallet_freshness() {
        use crate::wallet_security::{tests::Storage, WalletSecurity};
        use optn_app::SecretText;
        use optn_platform::{PlatformError, PlatformResult, WalletBiometrics, WalletStorage};
        use optn_transport::WalletSecurityRequest;

        struct FailedEnrollmentStatus;
        impl WalletBiometrics for FailedEnrollmentStatus {
            fn available(&self) -> bool {
                true
            }
            fn enrolled(&self, _: &str) -> PlatformResult<bool> {
                Err(PlatformError::Unavailable)
            }
            fn unlock(&self, _: &str) -> PlatformResult<Option<Vec<u8>>> {
                panic!("not requested")
            }
            fn enroll(&self, _: &str, _: &[u8]) -> PlatformResult<()> {
                panic!("not requested")
            }
            fn remove(&self, _: &str) -> PlatformResult<()> {
                panic!("not requested")
            }
        }

        // Published BIP39 fixture; deterministic entropy is test-only. Use the
        // real wallet-file encryption and password verification unchanged.
        let none = String::new();
        let file = optn_core::wallet_file::WalletFile::create(
            "new public fixture",
            optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC,
            &none,
            &none,
            &none,
            Network::Chipnet,
            optn_core::hd::AccountPath::default_for(Network::Chipnet),
            &std::array::from_fn(|i| i as u8),
        )
        .unwrap();
        let storage = Storage::default();
        storage
            .save("new.optn", None, &file.encode().unwrap())
            .unwrap();
        let mut previous = observation_app();
        let reconciliation = candidate(Evidence::ServerAssertion);
        reconciliation
            .authoritative
            .as_ref()
            .unwrap()
            .value
            .reconcile_coins(Network::Chipnet, &[address()], &mut previous.coins)
            .unwrap();
        let security =
            WalletSecurity::new(Box::new(storage), Some(Box::new(FailedEnrollmentStatus)));
        let (runtime, mut driver) =
            AppRuntime::new_with_security(previous.clone(), security).unwrap();
        driver.wallet_sync.state = reconciliation;
        driver.wallet_sync.publish_status();
        let mut events = runtime.subscribe_events();
        let task = tokio::spawn(driver.run());

        assert!(runtime
            .wallet_security(WalletSecurityRequest::Open {
                handle: "missing.optn".into(),
                password: SecretText::new(String::new()),
            })
            .await
            .is_err());
        assert_eq!(events.try_recv().unwrap(), AppEvent::AppLockChanged);
        assert_eq!(
            runtime.state().lock.unlock_epoch,
            previous.lock.unlock_epoch
        );
        assert_eq!(runtime.state().coins, previous.coins);
        assert!(runtime.subscribe_wallet_sync().borrow().sync.utxos_fresh);

        // Open succeeds before the final enrolled() status query fails.
        assert!(runtime
            .wallet_security(WalletSecurityRequest::Open {
                handle: "new.optn".into(),
                password: SecretText::new(String::new()),
            })
            .await
            .is_err());
        assert_eq!(events.try_recv().unwrap(), AppEvent::WalletOpened);
        assert_eq!(runtime.state().wallet.unwrap().name, "new public fixture");
        assert!(runtime.state().lock.unlock_epoch > previous.lock.unlock_epoch);
        assert!(runtime.state().coins.is_empty());
        let status = runtime.subscribe_wallet_sync();
        assert!(status.borrow().authoritative.is_none());
        assert!(!status.borrow().sync.history_fresh);
        assert!(!status.borrow().sync.utxos_fresh);
        drop(runtime);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn interface_actions_cannot_inject_wallet_observations() {
        let runtime = runtime().await;
        let transport = DirectTransport::new(runtime.clone());
        let coin = optn_app::chipnet_demo_coin(4000, 1).unwrap();
        for action in [AppAction::InsertCoin(coin)] {
            // Same typed conversion used by remote GUI commands, then the
            // direct transport used by in-process interfaces.
            let wire = optn_transport::WireAction::from(action);
            transport
                .dispatch(AppAction::try_from(wire).unwrap())
                .await
                .unwrap();
            assert_eq!(
                transport.next_event().await.unwrap(),
                Some(AppEvent::NoticeChanged)
            );
            let state = transport.snapshot().await.unwrap();
            assert!(state.coins.is_empty());
            // Stealth is a breakdown of the coin set now, so an empty coin
            // set is the whole assertion: there is no second pool to check.
            assert_eq!(state.coins.rpa_sats(), 0);
            assert!(state.notice.unwrap().contains("sync service"));
        }
    }

    #[tokio::test]
    async fn revocation_refuses_a_result_already_prepared_for_publication() {
        let runtime = runtime().await;
        let mut lease = runtime.begin_wallet_sync(vec![address()]).await.unwrap();
        let lifetime = crate::chain_service::ChainRevocation::default();
        lease.source_lifetime = Some(lifetime.clone());
        let result = candidate(Evidence::ServerAssertion);
        lifetime.revoke();
        assert_eq!(
            runtime.finish_wallet_sync(lease, result).await,
            Err(WalletSyncError::Superseded)
        );
        assert!(runtime.state().coins.is_empty());
        assert!(!runtime.subscribe_wallet_sync().borrow().sync.utxos_fresh);
    }

    #[tokio::test]
    async fn publication_preserves_annotations_and_exposes_only_reconciled_state() {
        let runtime = runtime().await;
        let transport = DirectTransport::new(runtime.clone());
        let status = runtime.subscribe_wallet_sync();
        let result = candidate(Evidence::ServerAssertion);
        let lease = runtime.begin_wallet_sync(vec![address()]).await.unwrap();
        assert_eq!(
            runtime
                .finish_wallet_sync(lease, result.clone())
                .await
                .unwrap(),
            ReconciliationDecision::Accepted
        );
        assert_eq!(
            transport.next_event().await.unwrap(),
            Some(AppEvent::CoinsChanged)
        );
        let coin = transport
            .snapshot()
            .await
            .unwrap()
            .coins
            .iter()
            .next()
            .unwrap()
            .clone();
        let outpoint = coin.outpoint();
        assert_eq!(coin.value_sats(), 1000);
        assert!(status.borrow().sync.utxos_fresh);
        assert_eq!(
            status.borrow().sync.verification,
            crate::chain::VerificationState::Discovered
        );

        let lease = runtime.begin_wallet_sync(vec![address()]).await.unwrap();
        transport
            .dispatch(AppAction::FreezeCoin(outpoint))
            .await
            .unwrap();
        transport
            .dispatch(AppAction::SetCoinLabel {
                outpoint,
                label: Some("keep locally".into()),
            })
            .await
            .unwrap();
        runtime
            .finish_wallet_sync(lease, result.clone())
            .await
            .unwrap();
        let state = transport.snapshot().await.unwrap();
        let retained = state.coins.get(outpoint).unwrap();
        assert_eq!(retained.freeze(), Some(FreezeReason::User));
        assert_eq!(retained.label(), Some("keep locally"));

        let before = state.coins;
        let lease = runtime.begin_wallet_sync(vec![address()]).await.unwrap();
        let mut invalid = result.clone();
        invalid.authoritative.as_mut().unwrap().value.transactions[0].raw[0] ^= 1;
        assert!(matches!(
            runtime.finish_wallet_sync(lease, invalid).await,
            Err(WalletSyncError::InvalidSnapshot(_))
        ));
        assert_eq!(runtime.state().coins, before);
        assert!(!status.borrow().sync.utxos_fresh);

        let lease = runtime.begin_wallet_sync(vec![address()]).await.unwrap();
        let mut failed = result;
        failed.record_failure("disconnected");
        assert_eq!(
            runtime.finish_wallet_sync(lease, failed).await.unwrap(),
            ReconciliationDecision::PreservedFailure
        );
        assert_eq!(runtime.state().coins, before);
        assert_eq!(
            status.borrow().sync.degraded_reason.as_deref(),
            Some("disconnected")
        );
    }

    #[tokio::test]
    async fn old_results_cannot_cross_sessions_policies_or_newer_requests() {
        let result = candidate(Evidence::ServerAssertion);
        for change in 0..5 {
            let runtime = runtime().await;
            let lease = runtime.begin_wallet_sync(vec![address()]).await.unwrap();
            match change {
                0 => {
                    runtime.dispatch(AppAction::LockWallet).await.unwrap();
                    runtime.dispatch(open()).await.unwrap();
                }
                1 => {
                    runtime
                        .dispatch(AppAction::SetNetwork(Network::Mainnet))
                        .await
                        .unwrap();
                    runtime
                        .dispatch(AppAction::SetNetwork(Network::Chipnet))
                        .await
                        .unwrap();
                }
                2 => {
                    runtime.dispatch(open()).await.unwrap();
                }
                3 => {
                    runtime
                        .invalidate_wallet_sync("privacy policy changed".into())
                        .await
                        .unwrap();
                }
                _ => {
                    let _newer = runtime.begin_wallet_sync(vec![address()]).await.unwrap();
                }
            }
            assert_eq!(
                runtime.finish_wallet_sync(lease, result.clone()).await,
                Err(WalletSyncError::Superseded)
            );
            assert!(runtime.state().coins.is_empty());
        }
        let runtime = runtime().await;
        let other = self::runtime().await;
        let foreign = other.begin_wallet_sync(vec![address()]).await.unwrap();
        let current = runtime.begin_wallet_sync(vec![address()]).await.unwrap();
        assert_eq!(
            runtime.finish_wallet_sync(foreign, result.clone()).await,
            Err(WalletSyncError::Superseded)
        );
        assert_eq!(
            runtime.finish_wallet_sync(current, result).await.unwrap(),
            ReconciliationDecision::Accepted
        );
    }

    #[tokio::test]
    async fn shared_worker_restores_evidence_and_cannot_shrink_discovery_scope() {
        let runtime = runtime().await;
        let second = Address::from_hash("bchtest", AddressKind::P2pkh, [2; 20]);
        let addresses = vec![address(), second.encode()];
        let lease = runtime.begin_wallet_sync(addresses.clone()).await.unwrap();
        let mut verified = candidate(Evidence::FullNodeValidated {
            source: SourceId::new("fixture"),
        });
        let interests = &mut verified.authoritative.as_mut().unwrap().value.interests;
        interests.push(WalletInterest::script(second.script_pubkey()));
        interests.sort();
        runtime.finish_wallet_sync(lease, verified).await.unwrap();
        let before = runtime.state().coins;
        // Even a now-empty branch must remain in the next discovery scope.
        assert!(matches!(
            runtime.begin_wallet_sync(vec![address()]).await,
            Err(WalletSyncError::InvalidScope(_))
        ));
        let mut worker = ProgressiveSyncWorker::new(Default::default());
        let mut service =
            crate::sync_worker::tests::wallet_service(crate::chain::ProtocolFamily::Electrum);
        assert_eq!(
            runtime
                .sync_wallet(&mut service, &mut worker, addresses, None)
                .await
                .unwrap(),
            ReconciliationDecision::PreservedWeakerEvidence
        );
        assert_eq!(runtime.state().coins, before);
        let status = runtime.subscribe_wallet_sync();
        assert!(matches!(
            status.borrow().authoritative.as_ref().unwrap().evidence,
            Evidence::FullNodeValidated { .. }
        ));
        assert!(!status.borrow().sync.utxos_fresh);
        runtime.dispatch(AppAction::LockWallet).await.unwrap();
        assert!(matches!(
            runtime.begin_wallet_sync(vec![address()]).await,
            Err(WalletSyncError::NoWallet)
        ));
        assert!(status.borrow().authoritative.is_none());
    }

    #[tokio::test]
    async fn actor_checkpoint_reopen_downgrades_unpublished_and_drops_oversized_cache() {
        let (mut app, xpub, key) = hd_identity_app();
        let receive = app.wallet.as_ref().unwrap().receive_address.clone();
        let script = Address::decode(&receive).unwrap().script_pubkey();
        let (mut candidate, category, body) =
            identity_candidate_for_script(script, true, true, false, |category| {
                registry_body("Bitcats", category)
            });
        let (mut session, _) = WalletSyncSession::new();
        session.record_registry_fetches(vec![(
            optn_core::bcmr::RegistryPublication::resolve_uri("example.com"),
            Ok(body),
        )]);
        let (lease, mut scan) = session
            .begin_hd(
                &app,
                xpub,
                crate::hd_sync::HdSyncLimits {
                    gap_limit: 1,
                    addresses_per_branch: 2,
                },
                None,
                0,
            )
            .unwrap();
        let snapshot = &mut candidate.authoritative.as_mut().unwrap().value;
        snapshot.interests = scan.interests();
        scan.advance(snapshot).unwrap();
        snapshot.hd = Some(scan.address_book());
        snapshot.tip = Some(ChainTip {
            height: 0,
            hash: [0; 32],
        });
        candidate.authoritative.as_mut().unwrap().chain_tip = Some((0, [0; 32]));
        assert_eq!(
            session.finish(&mut app, lease, candidate, |_, _, _| Ok(()), |_| true),
            Ok(ReconciliationDecision::Accepted)
        );
        let category_hex: String = category.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(
            app.token_identities.get(&category_hex).unwrap().status,
            IdentityStatus::Unresolved
        );
        // `Unpublished` is a live authhead conclusion. It must not survive a
        // restart as a current conclusion either.
        app.token_identities.insert(
            "bb".repeat(32),
            optn_app::TokenIdentity {
                name: "previously unpublished".into(),
                ticker: None,
                decimals: 0,
                status: IdentityStatus::Unpublished,
                presentation: Default::default(),
            },
        );
        // A registry can legitimately return a label beyond the restart-cache
        // budget. It remains usable for this run, but cannot block sealing the
        // wallet's reconciled coins and valid cached presentation.
        app.token_identities.insert(
            "cc".repeat(32),
            optn_app::TokenIdentity {
                name: "x".repeat(513),
                ticker: None,
                decimals: 0,
                status: IdentityStatus::Verified,
                presentation: Default::default(),
            },
        );
        let (app_tx, _) = watch::channel(app.clone());
        let (events, _) = broadcast::channel(4);
        let revocation = AtomicU64::new(0);
        let (reply, received) = oneshot::channel();
        session.handle(
            WalletSyncRequest::Checkpoint(reply),
            &mut app,
            &app_tx,
            &events,
            None,
            crate::PublicationGuard {
                generation: 0,
                revocation: &revocation,
                now_ms: &|| 1,
            },
        );
        let checkpoint = received.await.unwrap().unwrap();
        let bytes = checkpoint
            .seal(&key, &[7; optn_core::wallet_pack::NONCE_LEN])
            .unwrap();
        let reopened = WalletCheckpoint::open(&key, &bytes).unwrap();

        let (restored_app, _, _) = hd_identity_app();
        let restored = AppRuntime::spawn(restored_app);
        restored.restore_wallet_checkpoint(reopened).await.unwrap();
        let state = restored.state();
        assert_eq!(
            state.token_identities.get(&category_hex).unwrap().status,
            IdentityStatus::Unresolved
        );
        assert_eq!(
            state.token_identities.get(&"bb".repeat(32)).unwrap().status,
            IdentityStatus::Unresolved
        );
        assert!(!state.token_identities.contains_key(&"cc".repeat(32)));
        assert!(!state.wallet_sync.history_fresh);
        assert!(!state.wallet_sync.utxos_fresh);
        assert!(state.spend.is_none());
    }

    fn registry_body(name: &str, category: [u8; 32]) -> Vec<u8> {
        let hex: String = category.iter().map(|byte| format!("{byte:02x}")).collect();
        format!(
            r#"{{"identities":{{"{hex}":{{"2023-11-14T22:13:20.000Z":{{"name":"{name}","token":{{"category":"{hex}","symbol":"BCAT","decimals":2}}}}}}}}}}"#
        )
        .into_bytes()
    }

    fn raw_tx(inputs: &[([u8; 32], u32)], outputs: &[(u64, &[u8])]) -> Vec<u8> {
        let mut raw = vec![2, 0, 0, 0];
        raw.extend_from_slice(&optn_core::tx::varint(inputs.len() as u64));
        for (txid, vout) in inputs {
            raw.extend_from_slice(txid);
            raw.extend_from_slice(&vout.to_le_bytes());
            raw.push(0);
            raw.extend_from_slice(&0xffff_ffffu32.to_le_bytes());
        }
        raw.extend_from_slice(&optn_core::tx::varint(outputs.len() as u64));
        for (value, script) in outputs {
            raw.extend_from_slice(&value.to_le_bytes());
            raw.extend_from_slice(&optn_core::tx::varint(script.len() as u64));
            raw.extend_from_slice(script);
        }
        raw.extend_from_slice(&[0; 4]);
        raw
    }

    fn p2pkh() -> Vec<u8> {
        let mut script = vec![0x76, 0xa9, 0x14];
        script.extend_from_slice(&[0u8; 20]);
        script.extend_from_slice(&[0x88, 0xac]);
        script
    }

    fn publication_script(contents: &[u8], uri: &str) -> Vec<u8> {
        let hash =
            optn_core::bcmr::RegistryPublication::committing_to(contents, vec![uri.to_owned()])
                .content_hash;
        let mut script = optn_core::bcmr::PUBLICATION_PREFIX.to_vec();
        script.push(32);
        script.extend_from_slice(&hash);
        script.push(u8::try_from(uri.len()).expect("short uri"));
        script.extend_from_slice(uri.as_bytes());
        script
    }

    fn genesis_raw() -> Vec<u8> {
        let identity = p2pkh();
        raw_tx(&[], &[(546, &identity)])
    }

    fn authhead_raw(parent: [u8; 32], contents: &[u8], uri: &str, publishes: bool) -> Vec<u8> {
        let identity = p2pkh();
        if publishes {
            let publication = publication_script(contents, uri);
            raw_tx(&[(parent, 0)], &[(546, &identity), (0, &publication)])
        } else {
            raw_tx(&[(parent, 0)], &[(546, &identity)])
        }
    }

    fn token_raw(script: &[u8], tokens: &[optn_core::token::TokenData]) -> Vec<u8> {
        let mut raw = vec![2, 0, 0, 0, 0];
        raw.extend_from_slice(&optn_core::tx::varint(tokens.len() as u64));
        for token in tokens {
            let prefix = token.encode_prefix().expect("token prefix");
            raw.extend_from_slice(&1000u64.to_le_bytes());
            raw.extend_from_slice(&optn_core::tx::varint((prefix.len() + script.len()) as u64));
            raw.extend_from_slice(&prefix);
            raw.extend_from_slice(script);
        }
        raw.extend_from_slice(&[0; 4]);
        raw
    }

    fn identity_candidate(
        include_authchain: bool,
        publishes: bool,
        extra_nft: bool,
        body_for: impl Fn([u8; 32]) -> Vec<u8>,
    ) -> (WalletReconciliation, [u8; 32], Vec<u8>) {
        identity_candidate_for_script(
            Address::decode(&address()).unwrap().script_pubkey(),
            include_authchain,
            publishes,
            extra_nft,
            body_for,
        )
    }

    fn identity_candidate_for_script(
        script: Vec<u8>,
        include_authchain: bool,
        publishes: bool,
        extra_nft: bool,
        body_for: impl Fn([u8; 32]) -> Vec<u8>,
    ) -> (WalletReconciliation, [u8; 32], Vec<u8>) {
        let genesis = genesis_raw();
        let authbase = optn_core::header_hash::sha256d(&genesis);
        let mut category = authbase;
        category.reverse();
        assert_ne!(
            category, authbase,
            "fixture must expose byte-order mistakes"
        );
        let body = body_for(category);
        let mut tokens = vec![optn_core::token::TokenData::fungible(category, 10)];
        if extra_nft {
            tokens.push(optn_core::token::TokenData {
                category,
                amount: 0,
                nft: Some(optn_core::token::Nft {
                    capability: optn_core::token::Capability::None,
                    commitment: b"\x01".to_vec(),
                }),
            });
        }
        let holder = token_raw(&script, &tokens);
        let mut transactions = vec![ObservedTransaction {
            txid: optn_core::header_hash::sha256d(&holder),
            raw: holder,
            block_height: None,
        }];
        if include_authchain {
            let head = authhead_raw(authbase, &body, "example.com", publishes);
            transactions.push(ObservedTransaction {
                txid: authbase,
                raw: genesis,
                block_height: None,
            });
            transactions.push(ObservedTransaction {
                txid: optn_core::header_hash::sha256d(&head),
                raw: head,
                block_height: None,
            });
        }
        let mut state = WalletReconciliation::default();
        state.reconcile_candidate(
            WalletNetworkSnapshot {
                hd: None,
                interests: vec![WalletInterest::script(script)],
                transactions,
                tip: None,
            },
            SourceId::new("fixture"),
            Evidence::ServerAssertion,
            None,
            true,
        );
        (state, category, body)
    }

    struct IdentityBackend {
        id: SourceId,
        endpoint: Endpoint,
        capabilities: CapabilitySet,
        transactions: BTreeMap<[u8; 32], ObservedTransaction>,
        spentness: OutpointSpentness,
        wallet_history: Option<Vec<ObservedTransaction>>,
    }

    impl ChainBackend for IdentityBackend {
        fn source_id(&self) -> &SourceId {
            &self.id
        }

        fn protocol(&self) -> ProtocolFamily {
            ProtocolFamily::Electrum
        }

        fn endpoint(&self) -> Option<&Endpoint> {
            Some(&self.endpoint)
        }

        fn capabilities(&self) -> &CapabilitySet {
            &self.capabilities
        }

        fn health(&self) -> ProviderHealth {
            ProviderHealth::Healthy
        }

        fn supports(&self, operation: ChainOperation) -> bool {
            matches!(
                operation,
                ChainOperation::WalletRefresh
                    | ChainOperation::TransactionLookup
                    | ChainOperation::OutpointSpentness
                    | ChainOperation::OutpointSpender
            )
        }

        fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
            Box::pin(async move {
                let response = match request {
                    ChainRequest::WalletRefresh { .. } => BackendObservation {
                        payload: ChainPayload::WalletRefresh {
                            transactions: self
                                .wallet_history
                                .clone()
                                .unwrap_or_else(|| self.transactions.values().cloned().collect()),
                            tip: Some(ChainTip {
                                height: 100,
                                hash: [7; 32],
                            }),
                        },
                        evidence: Evidence::ServerAssertion,
                        chain_tip: Some((100, [7; 32])),
                    },
                    ChainRequest::TransactionLookup { txid } => BackendObservation {
                        payload: self
                            .transactions
                            .get(txid)
                            .cloned()
                            .map(ChainPayload::Transaction)
                            .ok_or_else(|| {
                                ChainBackendError::InvalidResponse(
                                    "fixture transaction was not available".into(),
                                )
                            })?,
                        evidence: Evidence::FullNodeValidated {
                            source: self.id.clone(),
                        },
                        chain_tip: Some((100, [7; 32])),
                    },
                    ChainRequest::OutpointSpentness { txid, vout } => BackendObservation {
                        payload: ChainPayload::OutpointSpentness(match &self.spentness {
                            OutpointSpentness::Unspent {
                                txid: known,
                                vout: index,
                                ..
                            }
                            | OutpointSpentness::Unknown {
                                txid: known,
                                vout: index,
                            } if known == txid && index == vout => self.spentness.clone(),
                            _ => OutpointSpentness::Unknown {
                                txid: *txid,
                                vout: *vout,
                            },
                        }),
                        evidence: Evidence::FullNodeValidated {
                            source: self.id.clone(),
                        },
                        chain_tip: None,
                    },
                    ChainRequest::OutpointSpender { txid, vout, .. } => BackendObservation {
                        payload: ChainPayload::OutpointSpender {
                            txid: *txid,
                            vout: *vout,
                            spender: self
                                .transactions
                                .values()
                                .find(|transaction| {
                                    optn_core::tx::decode(&transaction.raw)
                                        .unwrap()
                                        .inputs
                                        .iter()
                                        .any(|(parent, index, _)| parent == txid && index == vout)
                                })
                                .cloned(),
                        },
                        evidence: Evidence::ServerAssertion,
                        chain_tip: None,
                    },
                    _ => return Err(ChainBackendError::Unsupported),
                };
                Ok(response)
            })
        }
    }

    fn identity_service(
        transactions: Vec<ObservedTransaction>,
        spentness: OutpointSpentness,
    ) -> ChainService {
        identity_service_with_wallet_history(transactions, spentness, None)
    }

    fn identity_service_with_wallet_history(
        transactions: Vec<ObservedTransaction>,
        spentness: OutpointSpentness,
        wallet_history: Option<Vec<ObservedTransaction>>,
    ) -> ChainService {
        let id = SourceId::new("identity-fixture");
        let endpoint = Endpoint {
            kind: EndpointKind::ElectrumTcp,
            host: "fixture".into(),
            port: Some(50001),
        };
        let mut capabilities = CapabilitySet::default();
        for capability in [
            Capability::UtxoQuery,
            Capability::TransactionQuery,
            Capability::OutpointUnspentLookup,
        ] {
            capabilities.record(
                capability,
                CapabilityConfidence::Verified,
                CapabilityDiscovery::ActiveProbe,
            );
        }
        if wallet_history.is_some() {
            capabilities.record(
                Capability::OutpointSpenderLookup,
                CapabilityConfidence::Advertised,
                CapabilityDiscovery::ElectrumServerVersion,
            );
        }
        let backend = Arc::new(IdentityBackend {
            id: id.clone(),
            endpoint: endpoint.clone(),
            capabilities,
            transactions: transactions.into_iter().map(|tx| (tx.txid, tx)).collect(),
            spentness,
            wallet_history,
        });
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(ChainSource {
                id: id.clone(),
                label: "identity fixture".into(),
                origin: SourceOrigin::UserAdded,
                endpoints: vec![endpoint],
                capabilities: Default::default(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            })
            .unwrap();
        let mut service = ChainService::new(
            catalog,
            ConnectionPolicy::exact(id, ProtocolFamily::Electrum),
        );
        service.register(backend);
        service
    }

    struct FixtureRegistryFetcher {
        body: Vec<u8>,
        candidate_only: bool,
        calls: Arc<AtomicUsize>,
        entered: Option<Arc<tokio::sync::Notify>>,
        hold: Option<Arc<tokio::sync::Notify>>,
        cancelled: Option<Arc<AtomicBool>>,
    }

    struct FetchCancellationProbe(Arc<AtomicBool>);

    impl Drop for FetchCancellationProbe {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    impl crate::token_metadata::RegistryFetcher for FixtureRegistryFetcher {
        fn registry_candidates(&self, category: [u8; 32]) -> Vec<String> {
            if self.candidate_only {
                vec![format!(
                    "https://indexer.example/api/registries/{}/latest/",
                    category
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>()
                )]
            } else {
                vec![]
            }
        }

        fn fetch<'a>(
            &'a self,
            uri: &'a str,
            _: crate::token_metadata::FetchLimits,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = crate::token_metadata::FetchAttempt> + Send + 'a>,
        > {
            let body = self.body.clone();
            let calls = self.calls.clone();
            let entered = self.entered.clone();
            let hold = self.hold.clone();
            let cancelled = self.cancelled.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                if self.candidate_only && !uri.starts_with("https://indexer.example/") {
                    return Err(crate::token_metadata::FetchError::PolicyRefused {
                        detail: "publisher outside selected source scope".into(),
                    });
                }
                if let Some(entered) = entered {
                    entered.notify_one();
                }
                let _cancellation_probe = cancelled.map(FetchCancellationProbe);
                if let Some(hold) = hold {
                    hold.notified().await;
                }
                Ok(body)
            })
        }
    }

    fn identity_hd_runtime() -> (AppRuntime, String, Vec<u8>) {
        let account = AccountPath::new(145, 1).unwrap();
        let xpub = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "")
            .unwrap()
            .account_xpub_at(account)
            .unwrap();
        let receive = address_under_account(Network::Chipnet, &xpub, 0, 0).unwrap();
        let script = Address::decode(&receive.address).unwrap().script_pubkey();
        let runtime = AppRuntime::spawn(AppState {
            network: Network::Chipnet,
            wallet: Some(OpenedWallet {
                kind: WalletKind::WatchOnly,
                name: "identity HD fixture".into(),
                receive_address: receive.address,
                master_fingerprint: None,
                account_path: account.to_string(),
                multisig_policy: None,
                account_xpub: Some(xpub.clone()),
            }),
            ..Default::default()
        });
        (runtime, xpub, script)
    }

    #[tokio::test]
    async fn hd_sync_publishes_identity_only_after_selected_unspent_and_permitted_fetch() {
        let limits = HdSyncLimits {
            gap_limit: 2,
            addresses_per_branch: 6,
        };
        for (
            name,
            return_unspent,
            install_fetcher,
            return_matching_body,
            bind_output,
            expected,
            fetch_calls,
        ) in [
            (
                "discovery indexer accepted",
                true,
                true,
                true,
                true,
                IdentityStatus::Verified,
                2,
            ),
            (
                "discovery without terminal unspent",
                false,
                true,
                true,
                true,
                IdentityStatus::Unresolved,
                0,
            ),
            (
                "indexer accepted",
                true,
                true,
                true,
                true,
                IdentityStatus::Verified,
                2,
            ),
            (
                "indexer hash mismatch",
                true,
                true,
                false,
                true,
                IdentityStatus::Unresolved,
                2,
            ),
            (
                "indexer cannot replace spentness",
                false,
                true,
                true,
                true,
                IdentityStatus::Unresolved,
                0,
            ),
            (
                "accepted",
                true,
                true,
                true,
                true,
                IdentityStatus::Verified,
                1,
            ),
            (
                "null",
                false,
                true,
                true,
                true,
                IdentityStatus::Unresolved,
                0,
            ),
            (
                "hash mismatch",
                true,
                true,
                false,
                true,
                IdentityStatus::Unresolved,
                1,
            ),
            (
                "no registry transport",
                true,
                false,
                true,
                true,
                IdentityStatus::Unresolved,
                0,
            ),
            (
                "outpoint value mismatch",
                true,
                true,
                true,
                false,
                IdentityStatus::Unresolved,
                0,
            ),
        ] {
            let (runtime, xpub, script) = identity_hd_runtime();
            let initial = runtime.state();
            let (candidate, _category, body) =
                identity_candidate_for_script(script, true, true, false, |category| {
                    registry_body("Bitcats", category)
                });
            let transactions = candidate
                .authoritative
                .as_ref()
                .unwrap()
                .value
                .transactions
                .clone();
            let head = transactions.last().expect("authhead fixture");
            let output = optn_core::tx::decode(&head.raw).unwrap().outputs.remove(0);
            let spentness = if return_unspent {
                OutpointSpentness::Unspent {
                    txid: head.txid,
                    vout: 0,
                    value_sats: if bind_output {
                        output.value
                    } else {
                        output.value.saturating_add(1)
                    },
                    script_pubkey: output.script_pubkey,
                    best_block: [9; 32],
                }
            } else {
                OutpointSpentness::Unknown {
                    txid: head.txid,
                    vout: 0,
                }
            };
            let wallet_history = name
                .starts_with("discovery")
                .then(|| vec![transactions[0].clone()]);
            let mut service =
                identity_service_with_wallet_history(transactions, spentness, wallet_history);
            let calls = Arc::new(AtomicUsize::new(0));
            if install_fetcher {
                service.set_registry_fetcher(Arc::new(FixtureRegistryFetcher {
                    candidate_only: name.contains("indexer"),
                    body: if return_matching_body {
                        body
                    } else {
                        b"wrong publication body".to_vec()
                    },
                    calls: calls.clone(),
                    entered: None,
                    hold: None,
                    cancelled: None,
                }));
            }
            let result = runtime
                .sync_hd_wallet(
                    &mut service,
                    &mut ProgressiveSyncWorker::new(Default::default()),
                    xpub,
                    limits,
                )
                .await;
            assert_eq!(result, Ok(ReconciliationDecision::Accepted), "{name}");
            let identity = optn_app::assets_view_model(&runtime.state()).categories[0]
                .identity
                .clone()
                .expect("the token remains visible");
            assert_eq!(identity.status, expected, "{name}");
            assert_eq!(calls.load(Ordering::SeqCst), fetch_calls, "{name}");
            if expected == IdentityStatus::Verified {
                assert_eq!(identity.name, "Bitcats");
                // This is the actual selected-route resolver result that
                // `Finish` published. Capture through the actor before any
                // invalidation, then prove a restart preserves presentation
                // without preserving current-authchain authority.
                let checkpoint = runtime.wallet_checkpoint().await.unwrap();
                let account = AccountPath::new(145, 1).unwrap();
                let key = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "")
                    .unwrap()
                    .checkpoint_key(Network::Chipnet, account)
                    .unwrap();
                let bytes = checkpoint
                    .seal(&key, &[23; optn_core::wallet_pack::NONCE_LEN])
                    .unwrap();
                let reopened = WalletCheckpoint::open(&key, &bytes).unwrap();
                let restored = AppRuntime::spawn(initial);
                restored.restore_wallet_checkpoint(reopened).await.unwrap();
                let restored_state = restored.state();
                let restored_identity = optn_app::assets_view_model(&restored_state).categories[0]
                    .identity
                    .clone()
                    .expect("cached identity remains visible after reopen");
                assert_eq!(restored_identity.name, "Bitcats");
                assert_eq!(restored_identity.status, IdentityStatus::Stale);
                assert_eq!(restored_state.coins, runtime.state().coins);
                assert!(!restored_state.wallet_sync.history_fresh);
                assert!(!restored_state.wallet_sync.utxos_fresh);
                assert!(restored_state.spend.is_none());
                let account_xpub = restored_state
                    .wallet
                    .as_ref()
                    .unwrap()
                    .account_xpub
                    .clone()
                    .unwrap();
                assert_eq!(
                    restored
                        .sync_hd_wallet(
                            &mut service,
                            &mut ProgressiveSyncWorker::new(Default::default()),
                            account_xpub,
                            limits,
                        )
                        .await,
                    Ok(ReconciliationDecision::Accepted)
                );
                let refreshed = restored.state();
                assert_eq!(
                    optn_app::assets_view_model(&refreshed).categories[0]
                        .identity
                        .as_ref()
                        .unwrap()
                        .status,
                    IdentityStatus::Verified
                );
                assert!(refreshed.wallet_sync.history_fresh && refreshed.wallet_sync.utxos_fresh);
                assert_eq!(refreshed.coins, runtime.state().coins);
                runtime
                    .invalidate_wallet_sync("fixture source changed".into())
                    .await
                    .unwrap();
                let stale = optn_app::assets_view_model(&runtime.state()).categories[0]
                    .identity
                    .clone()
                    .expect("published identity remains visible with a caveat");
                assert_eq!(stale.status, IdentityStatus::Stale);
                assert_eq!(stale.name, "Bitcats");
            } else {
                assert_ne!(identity.name, "Bitcats");
            }
        }
    }

    #[tokio::test]
    async fn hd_sync_cancels_a_pending_registry_fetch_when_its_source_is_revoked() {
        let (runtime, xpub, script) = identity_hd_runtime();
        let (candidate, _category, body) =
            identity_candidate_for_script(script, true, true, false, |category| {
                registry_body("Bitcats", category)
            });
        let transactions = candidate
            .authoritative
            .as_ref()
            .unwrap()
            .value
            .transactions
            .clone();
        let (head_txid, output) = {
            let head = transactions.last().expect("authhead fixture");
            (
                head.txid,
                optn_core::tx::decode(&head.raw).unwrap().outputs.remove(0),
            )
        };
        let mut service = identity_service(
            transactions,
            OutpointSpentness::Unspent {
                txid: head_txid,
                vout: 0,
                value_sats: output.value,
                script_pubkey: output.script_pubkey,
                best_block: [9; 32],
            },
        );
        let source_lifetime = service.revocation();
        let calls = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(tokio::sync::Notify::new());
        let hold = Arc::new(tokio::sync::Notify::new());
        let cancelled = Arc::new(AtomicBool::new(false));
        service.set_registry_fetcher(Arc::new(FixtureRegistryFetcher {
            candidate_only: false,
            body,
            calls: calls.clone(),
            entered: Some(entered.clone()),
            hold: Some(hold),
            cancelled: Some(cancelled.clone()),
        }));

        let running = runtime.clone();
        let task = tokio::spawn(async move {
            running
                .sync_hd_wallet(
                    &mut service,
                    &mut ProgressiveSyncWorker::new(Default::default()),
                    xpub,
                    HdSyncLimits {
                        gap_limit: 2,
                        addresses_per_branch: 6,
                    },
                )
                .await
        });
        entered.notified().await;
        source_lifetime.revoke();

        assert_eq!(task.await.unwrap(), Err(WalletSyncError::Superseded));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(cancelled.load(Ordering::SeqCst));
        assert!(runtime.state().coins.is_empty());
        assert!(runtime.state().token_identities.is_empty());
    }

    fn finish_collected(
        include_authchain: bool,
        publishes: bool,
        extra_nft: bool,
        attempt: impl Fn(&[u8]) -> crate::token_metadata::FetchAttempt,
    ) -> AppState {
        let (candidate, _, body) =
            identity_candidate(include_authchain, publishes, extra_nft, |category| {
                registry_body("Bitcats", category)
            });
        let mut app = observation_app();
        let (mut session, _) = WalletSyncSession::new();
        session.record_registry_fetches(vec![(
            optn_core::bcmr::RegistryPublication::resolve_uri("example.com"),
            attempt(&body),
        )]);
        let lease = session.begin(&app, vec![address()], 0).unwrap();
        assert_eq!(
            session.finish(&mut app, lease, candidate, |_, _, _| Ok(()), |_| true),
            Ok(ReconciliationDecision::Accepted)
        );
        app
    }

    #[test]
    fn wallet_sync_finish_cannot_infer_authhead_from_wallet_history() {
        use optn_app::IdentityStatus;

        let (candidate, category, body) = identity_candidate(true, true, true, |category| {
            registry_body("Bitcats", category)
        });
        let mut app = observation_app();
        let (mut session, _) = WalletSyncSession::new();
        session.record_registry_fetches(vec![(
            optn_core::bcmr::RegistryPublication::resolve_uri("example.com"),
            Ok(body),
        )]);
        let lease = session.begin(&app, vec![address()], 0).unwrap();
        assert_eq!(
            session.finish(&mut app, lease, candidate, |_, _, _| Ok(()), |_| true),
            Ok(ReconciliationDecision::Accepted)
        );
        let assets = optn_app::assets_view_model(&app);
        let category_name: String = category.iter().map(|byte| format!("{byte:02x}")).collect();
        let identity = assets.categories[0]
            .identity
            .as_ref()
            .expect("resolved identity");
        assert_eq!(identity.name, category_name);
        assert_eq!(identity.status, IdentityStatus::Unresolved);
        assert_eq!(identity.status.caveat(), Some("unverified"));
        let nfts = optn_app::nfts_view_model(&app);
        assert_eq!(
            nfts.nfts[0]
                .identity
                .as_ref()
                .map(|item| item.name.as_str()),
            Some(category_name.as_str())
        );
        app.reduce_intent(AppAction::SetTokenIdentity {
            category_hex: category.iter().map(|byte| format!("{byte:02x}")).collect(),
            identity: optn_app::TokenIdentity {
                name: "Totally Real Coin".into(),
                ticker: None,
                decimals: 0,
                status: IdentityStatus::Verified,
                presentation: Default::default(),
            },
        });
        assert_eq!(
            optn_app::assets_view_model(&app).categories[0]
                .identity
                .as_ref()
                .map(|item| item.name.as_str()),
            Some(category_name.as_str())
        );
    }

    #[test]
    fn wallet_sync_finish_does_not_treat_a_mismatch_as_current() {
        use optn_app::IdentityStatus;

        let app = finish_collected(true, true, false, |_| Ok(b"something else".to_vec()));
        let identity = optn_app::assets_view_model(&app).categories[0]
            .identity
            .clone()
            .expect("named");
        assert_eq!(identity.status, IdentityStatus::Unresolved);
        assert_ne!(identity.name, "Bitcats");
        assert!(identity.status.caveat().is_some());
    }

    #[test]
    fn wallet_sync_finish_keeps_coins_visible_without_claiming_withdrawal() {
        use optn_app::IdentityStatus;

        let app = finish_collected(true, false, false, |body| Ok(body.to_vec()));
        let identity = optn_app::assets_view_model(&app).categories[0]
            .identity
            .clone()
            .expect("status");
        assert_eq!(identity.status, IdentityStatus::Unresolved);
        assert_eq!(identity.status.caveat(), Some("unverified"));
        assert_eq!(app.coins.len(), 1);

        let app = finish_collected(false, false, false, |body| Ok(body.to_vec()));
        let identity = optn_app::assets_view_model(&app).categories[0]
            .identity
            .clone()
            .expect("status");
        assert_eq!(identity.status, IdentityStatus::Unresolved);
        assert_eq!(identity.status.caveat(), Some("unverified"));
        assert_eq!(app.coins.len(), 1);
    }
}
