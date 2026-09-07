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
    Refresh(ProgressiveSyncError),
}

impl std::fmt::Display for WalletSyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => f.write_str("application runtime is closed"),
            Self::NoWallet => f.write_str("open a wallet before synchronizing"),
            Self::InvalidScope(reason)
            | Self::InvalidSnapshot(reason)
            | Self::HdDiscovery(reason) => f.write_str(reason),
            Self::Superseded => f.write_str("wallet sync request is no longer current"),
            Self::Refresh(error) => write!(f, "wallet refresh failed: {error:?}"),
        }
    }
}

impl std::error::Error for WalletSyncError {}

// This token never crosses a renderer transport. Arc identity prevents both
// network-away-and-back ABA and publication into another runtime instance.
pub(super) struct WalletSyncLease {
    id: Arc<()>,
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
                result = worker.refresh(service, lease.interests.clone(), None) => result,
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
                    let outcome = refreshed.map_err(WalletSyncError::Refresh)?;
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
        let outcome = refreshed.map_err(WalletSyncError::Refresh)?;
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
        !self.coins_are_fresh()
            && (matches!(
                action,
                AppAction::PrepareSend { .. }
                    | AppAction::PrepareFlipstarterPledge { .. }
                    | AppAction::AuthorizeSpend { .. }
                    | AppAction::AuthorizeBackground { .. }
            ) || matches!(action, AppAction::ConfirmAuth { .. })
                && app.lock.prompt == Some(AuthScope::Spend))
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

    fn invalidate(&mut self, reason: String) {
        self.active = None;
        self.cancellation_tx = None;
        self.abandoned = None;
        self.state.record_failure(reason);
        self.publish_status();
    }

    pub(super) fn handle(
        &mut self,
        request: WalletSyncRequest,
        app: &mut AppState,
        app_tx: &watch::Sender<AppState>,
        events: &broadcast::Sender<AppEvent>,
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
                    app.coins = checkpoint.coins;
                    app.spend = None;
                    self.state = checkpoint.state;
                    self.state
                        .record_failure("restored wallet state requires a live refresh");
                    self.publish_status();
                    app_tx.send_replace(app.clone());
                    let _ = events.send(AppEvent::CoinsChanged);
                }
                let _ = reply.send(outcome);
            }
            WalletSyncRequest::BeginHd(xpub, limits, reply) => {
                let outcome = self.begin_hd(app, xpub, limits);
                if outcome.is_ok() && app.spend.take().is_some() {
                    app_tx.send_replace(app.clone());
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
                    self.begin(app, addresses)
                };
                if outcome.is_ok() && app.spend.take().is_some() {
                    app_tx.send_replace(app.clone());
                    let _ = events.send(AppEvent::CoinsChanged);
                }
                let _ = reply.send(outcome);
            }
            WalletSyncRequest::Finish(lease, result, reply) => {
                let outcome = self.finish(app, lease, *result);
                if outcome == Ok(ReconciliationDecision::Accepted) {
                    app_tx.send_replace(app.clone());
                    let _ = events.send(AppEvent::CoinsChanged);
                }
                let _ = reply.send(outcome);
            }
            WalletSyncRequest::Invalidate(reason, reply) => {
                self.invalidate(reason);
                if app.spend.take().is_some() {
                    app_tx.send_replace(app.clone());
                    let _ = events.send(AppEvent::CoinsChanged);
                }
                let _ = reply.send(());
            }
        }
    }

    fn begin(
        &mut self,
        app: &AppState,
        addresses: Vec<String>,
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
        let lease = self.begin(app, scan.addresses())?;
        Ok((lease, scan))
    }

    fn finish(
        &mut self,
        app: &mut AppState,
        lease: WalletSyncLease,
        result: WalletReconciliation,
    ) -> Result<ReconciliationDecision, WalletSyncError> {
        if !self
            .active
            .as_ref()
            .is_some_and(|id| Arc::ptr_eq(id, &lease.id))
        {
            return Err(WalletSyncError::Superseded);
        }
        if lease
            .source_lifetime
            .as_ref()
            .is_some_and(|source| source.is_revoked())
        {
            self.invalidate("wallet source was revoked before publication".into());
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
            let snapshot = &next
                .authoritative
                .as_ref()
                .expect("accepted candidate")
                .value;
            if let Err(error) =
                snapshot.reconcile_coins(lease.network, &lease.addresses, &mut app.coins)
            {
                let reason = error.to_string();
                self.state.record_failure(reason.clone());
                self.publish_status();
                return Err(WalletSyncError::InvalidSnapshot(reason));
            }
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

    async fn runtime() -> AppRuntime {
        // Same non-HD address-observation session used by CLI balance/utxos.
        // Seed and hardware wallet sessions always require HD discovery.
        AppRuntime::spawn(AppState {
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
        })
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

    #[tokio::test]
    async fn interface_actions_cannot_inject_wallet_observations() {
        let runtime = runtime().await;
        let transport = DirectTransport::new(runtime.clone());
        let coin = optn_app::chipnet_demo_coin(4000, 1).unwrap();
        for action in [AppAction::InsertCoin(coin), AppAction::SetStealthSats(5000)] {
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
            assert_eq!(state.stealth_sats, 0);
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
