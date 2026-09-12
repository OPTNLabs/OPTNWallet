//! Provider work runs outside the reducer; publication runs inside it. A result
//! is usable only by its issuing runtime, wallet/network session, and request.

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
    addresses: Vec<String>,
    interests: Vec<WalletInterest>,
    baseline: Box<WalletReconciliation>,
    cancelled: watch::Receiver<()>,
    source_lifetime: Option<crate::chain_service::ChainRevocation>,
    // Closing this sender also covers caller timeouts and aborted tasks. The
    // driver observes it directly, so cleanup cannot be lost to a full queue.
    _completion: oneshot::Sender<()>,
}

pub(super) enum WalletSyncRequest {
    Checkpoint(oneshot::Sender<Result<WalletCheckpoint, WalletSyncError>>),
    Restore(
        Box<WalletCheckpoint>,
        oneshot::Sender<Result<(), WalletSyncError>>,
    ),
    BeginHd(
        String,
        HdSyncLimits,
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
    /// Supplying it is what makes P2P discovery possible at all. BIP37 and
    /// Neutrino both refuse a refresh with no floor rather than reading the
    /// chain from genesis, so an HD account that passes `None` can only ever be
    /// served by Electrum or RPC.
    pub async fn sync_hd_wallet_from_floor(
        &self,
        service: &mut ChainService,
        worker: &mut ProgressiveSyncWorker,
        account_xpub: String,
        limits: HdSyncLimits,
        floor: Option<u32>,
    ) -> Result<ReconciliationDecision, WalletSyncError> {
        let (reply, received) = oneshot::channel();
        self.action_tx
            .send(RuntimeRequest::WalletSync(WalletSyncRequest::BeginHd(
                account_xpub,
                limits,
                reply,
            )))
            .await
            .map_err(|_| WalletSyncError::Closed)?;
        let (mut lease, mut scan) = received.await.map_err(|_| WalletSyncError::Closed)??;
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
                    }
                    if let Err(reason) = &completion {
                        worker.reconciliation_mut().record_failure(reason.clone());
                    }
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
            },
            state_rx,
        )
    }

    pub(super) fn on_event(&mut self, event: &AppEvent) {
        match event {
            AppEvent::WalletOpened | AppEvent::WalletLocked | AppEvent::NetworkChanged(_) => {
                self.active = None;
                self.cancellation_tx = None;
                self.abandoned = None;
                self.state = WalletReconciliation::default();
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
            app.wallet_sync = optn_app::WalletSyncView::empty();
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
    }

    fn publish_app(&self, app: &mut AppState, app_tx: &watch::Sender<AppState>) {
        self.project_status(app);
        crate::publish_state(app, app_tx);
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
        app.wallet_sync = checkpoint
            .state
            .authoritative
            .as_ref()
            .map(|snapshot| snapshot.value.wallet_view())
            .transpose()
            .expect("checkpoint projection validated before installation")
            .unwrap_or_default();
        app.coins = checkpoint.coins;
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
        persist: impl FnOnce(
            &AppState,
            &WalletReconciliation,
        ) -> Result<(), optn_transport::TransportError>,
        may_publish: impl Fn(&AppState) -> bool,
    ) -> AppEvent {
        if !may_publish(app) || persist(app, &self.state).is_err() || !may_publish(app) {
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
            WalletSyncRequest::Checkpoint(reply) => {
                let _ = reply.send(
                    WalletCheckpoint::capture(app, &self.state)
                        .map_err(WalletSyncError::InvalidSnapshot),
                );
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
            WalletSyncRequest::BeginHd(xpub, limits, reply) => {
                let outcome = self.begin_hd(app, xpub, limits, guard.generation);
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
                let outcome = self.finish(
                    app,
                    lease,
                    *result,
                    |app, state| match security.as_deref_mut() {
                        Some(security) => security.persist_checkpoint(app, state),
                        None => Ok(()),
                    },
                    |app| guard.allows(app, reply.is_closed()),
                );
                if outcome == Ok(ReconciliationDecision::Accepted) {
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
            addresses: watched.values().cloned().collect(),
            interests: watched
                .keys()
                .cloned()
                .map(WalletInterest::Script)
                .collect(),
            baseline: Box::new(self.state.clone()),
            cancelled,
            source_lifetime: None,
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
        let scan = HdAccountScan::new(app.network, xpub, account, limits, required)
            .map_err(WalletSyncError::InvalidScope)?;
        let lease = self.begin(app, scan.addresses(), generation)?;
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
            candidate_app.wallet_sync = match snapshot.wallet_view() {
                Ok(view) => view,
                Err(error) => {
                    let reason = error.to_string();
                    self.state.record_failure(reason.clone());
                    self.publish_status();
                    return Err(WalletSyncError::InvalidSnapshot(reason));
                }
            };
            if !may_publish(app) {
                self.invalidate("wallet refresh cancelled before persistence".into());
                return Err(WalletSyncError::Superseded);
            }
            if let Err(error) = persist(&candidate_app, &next) {
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
            // A prepared spend may refer to outputs removed by this refresh.
            app.spend = None;
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
        chain::{Evidence, SourceId},
        chain_service::ObservedTransaction,
        DirectTransport,
    };
    use optn_app::AppAction;
    use optn_core::{cashaddr::AddressKind, coins::FreezeReason};
    use optn_transport::AppTransport;

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
                |_, _| panic!("cancelled work must not write"),
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
            |candidate, _| {
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
            |_, _| {
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
                    |_, _| Ok(()),
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
                |app, _| {
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
        // Both kinds of coin: an RPA payment is an observation like any
        // other, and an interface must not be able to inject one either.
        let rpa = optn_app::rpa_demo_coin(5000, 2).unwrap();
        for action in [AppAction::InsertCoin(coin), AppAction::InsertCoin(rpa)] {
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
}
