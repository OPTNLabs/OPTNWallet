//! Progressive wallet synchronization over capability routes.
//!
//! A timeout/partial provider never becomes an empty authoritative wallet. The
//! worker keeps the last reconciled snapshot and may retry another allowed
//! route. Route-local prerequisites (BIP37/Neutrino header cursors) stay on the
//! same endpoint via `ChainService::execute_on_route`.

use crate::chain::{BlockHeaderBytes, ProtocolFamily, SourceId};
use crate::chain_service::{
    CapabilityRoute, ChainOperation, ChainPayload, ChainRequest, ChainService, ChainServiceError,
    ChainTip, ObservedTransaction, WalletInterest,
};
use crate::header_store::{HeaderStoreError, SharedHeaders};
use crate::header_verifier::{ShvMmrError, ShvMmrHeaderVerifier};
use crate::header_view::{HeaderViewError, VerifiedHeaderView};
use crate::reconciliation::{evidence_strength, ReconciliationDecision, ReconciliationState};
use optn_core::network::Network;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletNetworkSnapshot {
    /// Runtime-derived public account scope; never supplied by a provider.
    pub hd: Option<optn_core::watch_only::HdAddressBook>,
    pub interests: Vec<WalletInterest>,
    pub transactions: Vec<ObservedTransaction>,
    pub tip: Option<ChainTip>,
}

impl WalletNetworkSnapshot {
    /// Project one account-wide history and balance from the same validated raw
    /// transactions used for coins. Heights alone do not prove confirmation.
    pub fn wallet_view(&self) -> optn_core::error::Result<optn_app::WalletSyncView> {
        use optn_core::error::CliError;
        let scripts = self
            .interests
            .iter()
            .map(|interest| match interest {
                WalletInterest::Script(script) => Ok(script.clone()),
                _ => Err(CliError::Protocol(
                    "wallet projection requires scripts".into(),
                )),
            })
            .collect::<optn_core::error::Result<Vec<_>>>()?;
        let first = scripts
            .first()
            .ok_or_else(|| CliError::Protocol("wallet scope is empty".into()))?;
        self.validate_script_scope(first)?;
        let raws = self
            .transactions
            .iter()
            .map(|tx| tx.raw.clone())
            .collect::<Vec<_>>();
        let heights = self
            .transactions
            .iter()
            .map(|tx| (tx.txid, tx.block_height))
            .collect::<std::collections::BTreeMap<_, _>>();
        let mut history = optn_core::tx::wallet_history(&raws, &scripts)?
            .into_iter()
            .map(|entry| {
                let height = heights.get(&entry.txid).copied().flatten();
                let mut display = entry.txid;
                display.reverse();
                optn_app::HistoryEntry {
                    kind: match entry.received_sats.cmp(&entry.spent_sats) {
                        std::cmp::Ordering::Greater => optn_app::HistoryKind::Received,
                        std::cmp::Ordering::Less => optn_app::HistoryKind::Sent,
                        std::cmp::Ordering::Equal => optn_app::HistoryKind::Transfer,
                    },
                    txid: optn_core::coins::Outpoint::new(display, 0).txid_hex(),
                    amount_sats: entry.received_sats.abs_diff(entry.spent_sats),
                    address: String::new(),
                    reserved: false,
                    block_height: height,
                }
            })
            .collect::<Vec<_>>();
        // Mempool first; height order is deterministic, not a made-up timestamp.
        history.sort_by(|a, b| {
            b.block_height
                .unwrap_or(u32::MAX)
                .cmp(&a.block_height.unwrap_or(u32::MAX))
                .then(a.txid.cmp(&b.txid))
        });
        let total = |confirmed_only: bool| -> optn_core::error::Result<i64> {
            optn_core::tx::unspent_outputs(
                self.transactions
                    .iter()
                    .filter(|tx| !confirmed_only || tx.block_height.is_some())
                    .map(|tx| tx.raw.as_slice()),
                &scripts,
            )?
            .into_iter()
            .try_fold(0i64, |sum, output| {
                i64::try_from(output.output.value)
                    .ok()
                    .and_then(|value| sum.checked_add(value))
                    .ok_or_else(|| {
                        CliError::Protocol("wallet balance exceeds supported range".into())
                    })
            })
        };
        let confirmed = total(true)?;
        Ok(optn_app::WalletSyncView {
            confirmed_sats: Some(confirmed as u64),
            pending_sats: total(false)? - confirmed,
            history,
            ..Default::default()
        })
    }

    /// Project the complete supplied script scope into coin records atomically.
    /// Hosts must additionally bind this snapshot to the active wallet session.
    pub fn reconcile_coins(
        &self,
        network: optn_core::network::Network,
        addresses: &[String],
        coins: &mut optn_core::coins::CoinSet,
    ) -> optn_core::error::Result<()> {
        use optn_core::{
            coins::{Coin, Outpoint},
            error::CliError,
        };
        let watched = wallet_scripts(network, addresses, coins)?;
        if self.interests.iter().any(|interest| match interest {
            WalletInterest::Script(script) => !watched.contains_key(script),
            _ => true,
        }) {
            return Err(CliError::Protocol(
                "coin projection requires an exact nonempty script scope".into(),
            ));
        }
        for script in watched.keys() {
            if !self
                .interests
                .contains(&WalletInterest::Script(script.clone()))
            {
                return Err(CliError::Protocol(
                    "coin projection has an unscanned script".into(),
                ));
            }
        }
        self.validate_script_scope(watched.keys().next().expect("nonempty scope"))?;
        let scripts = watched.keys().cloned().collect::<Vec<_>>();
        let outputs = optn_core::tx::unspent_outputs(
            self.transactions.iter().map(|tx| tx.raw.as_slice()),
            &scripts,
        )?;
        let replacement = outputs
            .into_iter()
            .map(|output| {
                let address = watched
                    .get(&output.output.script_pubkey)
                    .expect("projection matches watched scripts");
                let mut display = output.txid;
                display.reverse();
                Coin::from_observation(
                    Outpoint::new(display, output.vout),
                    output.output.value,
                    address.clone(),
                    output.output.token,
                )
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CliError::Protocol(error.to_string()))?;
        coins
            .replace_chain_outputs(replacement)
            .map_err(|error| CliError::Protocol(error.to_string()))
    }

    fn validate_script_scope(&self, script: &[u8]) -> optn_core::error::Result<()> {
        use optn_core::error::CliError;
        if !self.interests.iter().any(|interest| {
            matches!(interest,
            WalletInterest::Script(watched) if watched == script)
        }) {
            return Err(CliError::Protocol(
                "script was not covered by this wallet snapshot".into(),
            ));
        }
        let mut heights = std::collections::BTreeMap::new();
        for transaction in &self.transactions {
            if heights
                .insert(transaction.txid, transaction.block_height)
                .is_some_and(|previous| previous != transaction.block_height)
            {
                return Err(CliError::Protocol(
                    "conflicting transaction heights in snapshot".into(),
                ));
            }
            if optn_core::header_hash::sha256d(&transaction.raw) != transaction.txid {
                return Err(CliError::Protocol(
                    "snapshot transaction identity mismatch".into(),
                ));
            }
            if transaction.block_height.is_some_and(|height| {
                height == 0 || !self.tip.as_ref().is_some_and(|tip| height <= tip.height)
            }) {
                return Err(CliError::Protocol(
                    "snapshot transaction height exceeds its chain scope".into(),
                ));
            }
        }
        Ok(())
    }

    /// Locally derived outputs, including token data. These are not a claim
    /// that the outputs are mature, confirmed, or permitted for spending.
    pub fn script_outputs(
        &self,
        script: &[u8],
    ) -> optn_core::error::Result<Vec<optn_core::tx::UnspentOutput>> {
        self.validate_script_scope(script)?;
        optn_core::tx::unspent_outputs(
            self.transactions.iter().map(|tx| tx.raw.as_slice()),
            &[script.to_vec()],
        )
    }

    /// Script history includes spent and zero-value outputs. A UTXO-only query
    /// cannot decide an HD unused gap or the next receive/change index.
    pub(crate) fn used_scripts(
        &self,
    ) -> optn_core::error::Result<std::collections::BTreeSet<Vec<u8>>> {
        let first = self
            .interests
            .iter()
            .find_map(|interest| match interest {
                WalletInterest::Script(script) => Some(script),
                _ => None,
            })
            .ok_or_else(|| {
                optn_core::error::CliError::Protocol("HD snapshot has no scripts".into())
            })?;
        self.validate_script_scope(first)?;
        let mut used = std::collections::BTreeSet::new();
        for tx in &self.transactions {
            for output in optn_core::tx::decode(&tx.raw)?.outputs {
                used.insert(output.script_pubkey);
            }
        }
        Ok(used)
    }

    /// Derive confirmed balance and pending delta from this snapshot's exact
    /// script scope. Provider heights remain assertions until independently proven.
    pub fn script_balance(&self, script: &[u8]) -> optn_core::error::Result<(i64, i64)> {
        use optn_core::error::CliError;
        self.validate_script_scope(script)?;
        let total = |confirmed_only: bool| -> optn_core::error::Result<i64> {
            let outputs = optn_core::tx::unspent_outputs(
                self.transactions
                    .iter()
                    .filter(|transaction| !confirmed_only || transaction.block_height.is_some())
                    .map(|transaction| transaction.raw.as_slice()),
                &[script.to_vec()],
            )?;
            outputs.into_iter().try_fold(0i64, |sum, output| {
                i64::try_from(output.output.value)
                    .ok()
                    .and_then(|value| sum.checked_add(value))
                    .ok_or_else(|| {
                        CliError::Protocol("wallet balance exceeds supported range".into())
                    })
            })
        };
        let confirmed = total(true)?;
        let unconfirmed = total(false)?
            .checked_sub(confirmed)
            .ok_or_else(|| CliError::Protocol("pending balance exceeds supported range".into()))?;
        Ok((confirmed, unconfirmed))
    }
}

/// Validate host-supplied discovery scope against the selected chain and all
/// retained coins. The host must obtain addresses from its wallet address book.
pub(crate) fn wallet_scripts(
    network: optn_core::network::Network,
    addresses: &[String],
    coins: &optn_core::coins::CoinSet,
) -> optn_core::error::Result<std::collections::BTreeMap<Vec<u8>, String>> {
    use optn_core::{cashaddr::Address, error::CliError};
    let mut watched = std::collections::BTreeMap::new();
    for address in addresses {
        let parsed = Address::decode(address).map_err(CliError::Protocol)?;
        if parsed.prefix != network.prefix() {
            return Err(CliError::Protocol(
                "projection address belongs to another network".into(),
            ));
        }
        watched.insert(parsed.script_pubkey(), parsed.encode());
    }
    if watched.is_empty() {
        return Err(CliError::Protocol("wallet script scope is empty".into()));
    }
    for coin in coins.iter() {
        let parsed = Address::decode(coin.address()).map_err(CliError::Protocol)?;
        if parsed.prefix != network.prefix() || !watched.contains_key(&parsed.script_pubkey()) {
            return Err(CliError::Protocol(
                "partial or cross-network projection cannot replace wallet coins".into(),
            ));
        }
    }
    Ok(watched)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgressiveSyncConfig {
    /// Legacy startup hint. Verified sync derives its cursor from the trusted
    /// accumulator instead; this field cannot override that cursor.
    pub header_start_height: u32,
    pub header_batch_size: u32,
    /// Safety bound against a malicious peer that never terminates header sync.
    pub max_header_batches: u32,
}

impl Default for ProgressiveSyncConfig {
    fn default() -> Self {
        Self {
            header_start_height: 1,
            header_batch_size: 2_000,
            max_header_batches: 1_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncOutcome {
    pub route: CapabilityRoute,
    pub decision: ReconciliationDecision,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProgressiveSyncError {
    NoWalletRoute,
    MissingHeaderRoute {
        source: SourceId,
        protocol: ProtocolFamily,
    },
    HeaderSafetyLimit,
    MissingTrustedHeaderVerifier,
    MissingRefreshBaseline,
    InconsistentRefreshScope,
    HeaderVerification(ShvMmrError),
    HeaderView(HeaderViewError),
    /// Accepted headers did not join the dense store they were destined for.
    ///
    /// The view and the store are one accepted chain; if they disagree about
    /// what precedes a batch, neither is advanced.
    HeaderStore(HeaderStoreError),
    InvalidHeaderRange,
    Chain(ChainServiceError),
    UnexpectedPayload,
    Exhausted,
}

/// What a refresh is asking a provider for.
///
/// `from_height` used to carry two meanings at once: the floor handed to the
/// provider, and a signal to merge the answer onto an existing baseline. They
/// are not the same request. A wallet scanning from its birthday wants a
/// complete answer that happens to start there; a wallet topping up wants only
/// the suffix. Conflating them means a rescan from an earlier height either
/// gets rejected for having no baseline or gets merged onto one that already
/// claims to cover more than it does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshScope {
    /// Everything this wallet's floor covers, replacing the snapshot.
    ///
    /// `floor` is where coverage begins, not a resume point. BIP37 and
    /// Neutrino both refuse a scan with no floor rather than reading the chain
    /// from genesis, so an HD wallet needs one here to use them at all.
    Complete { floor: Option<u32> },
    /// A top-up above an existing complete baseline, merged onto it.
    Incremental { from_height: u32 },
}

impl RefreshScope {
    /// The floor the provider is asked to start at.
    const fn provider_floor(&self) -> Option<u32> {
        match self {
            Self::Complete { floor } => *floor,
            Self::Incremental { from_height } => Some(*from_height),
        }
    }

    /// The height above which results merge onto a baseline, if any.
    const fn incremental_start(&self) -> Option<u32> {
        match self {
            Self::Complete { .. } => None,
            Self::Incremental { from_height } => Some(*from_height),
        }
    }
}

pub struct ProgressiveSyncWorker {
    config: ProgressiveSyncConfig,
    reconciliation: ReconciliationState<WalletNetworkSnapshot>,
    /// The runtime's shared verified header view, not a worker-local cache.
    /// Header truth is per network and outlives any one provider or sync run.
    header_view: Option<VerifiedHeaderView>,
    /// The dense accepted store the providers read back.
    ///
    /// The view proves the chain; this is where the headers it accepted are
    /// kept so a Bloom or compact-filter scan can ask "which block is at
    /// height h" and get the same answer the verifier reached. Without it the
    /// store never advances past genesis and every scan correctly refuses to
    /// run, so a host that verifies headers but never publishes them has a
    /// wallet that cannot sync.
    accepted: Option<Arc<SharedHeaders>>,
}

impl ProgressiveSyncWorker {
    pub fn new(config: ProgressiveSyncConfig) -> Self {
        Self {
            config,
            reconciliation: ReconciliationState::default(),
            header_view: None,
            accepted: None,
        }
    }

    /// Publish accepted headers into the store providers read.
    ///
    /// Give the worker the same store the provider stack was built with, or
    /// the two hold different ideas of the accepted chain.
    pub fn with_accepted_headers(mut self, headers: Arc<SharedHeaders>) -> Self {
        self.accepted = Some(headers);
        self
    }

    pub fn accepted_headers(&self) -> Option<&Arc<SharedHeaders>> {
        self.accepted.as_ref()
    }

    /// The host supplies a trusted checkpoint and the selected network's
    /// difficulty context. Provider responses must never choose either.
    ///
    /// The network is required because a verified header view belongs to one
    /// chain; a checkpoint without the chain it was taken on is not trusted
    /// material.
    pub fn with_header_verifier(
        self,
        network: Network,
        verifier: ShvMmrHeaderVerifier,
    ) -> Result<Self, ProgressiveSyncError> {
        if !verifier.has_difficulty_context() || verifier.state().is_err() {
            return Err(ProgressiveSyncError::MissingTrustedHeaderVerifier);
        }
        self.with_header_view(VerifiedHeaderView::new(network, verifier))
    }

    /// Attach an existing shared view, so a sync run joins the runtime's
    /// verified progress instead of starting its own.
    pub fn with_header_view(
        mut self,
        view: VerifiedHeaderView,
    ) -> Result<Self, ProgressiveSyncError> {
        if !view.verifier().has_difficulty_context() || view.verifier().state().is_err() {
            return Err(ProgressiveSyncError::MissingTrustedHeaderVerifier);
        }
        self.header_view = Some(view);
        Ok(self)
    }

    pub fn header_view(&self) -> Option<&VerifiedHeaderView> {
        self.header_view.as_ref()
    }

    /// Take the advanced view back, so the host can persist it and hand it to
    /// the next sync run or a different provider.
    pub fn into_header_view(self) -> Option<VerifiedHeaderView> {
        self.header_view
    }

    pub fn header_verifier(&self) -> Option<&ShvMmrHeaderVerifier> {
        self.header_view.as_ref().map(VerifiedHeaderView::verifier)
    }

    pub fn reconciliation(&self) -> &ReconciliationState<WalletNetworkSnapshot> {
        &self.reconciliation
    }
    pub fn reconciliation_mut(&mut self) -> &mut ReconciliationState<WalletNetworkSnapshot> {
        &mut self.reconciliation
    }

    pub fn restore(&mut self, state: ReconciliationState<WalletNetworkSnapshot>) {
        self.reconciliation = state;
    }

    /// Refresh, where `Some(height)` means an incremental top-up.
    ///
    /// Kept for callers that only ever meant that. A scan that starts at a
    /// floor without claiming a baseline is [`Self::refresh_with_scope`] with
    /// [`RefreshScope::Complete`].
    pub async fn refresh(
        &mut self,
        service: &mut ChainService,
        interests: Vec<WalletInterest>,
        from_height: Option<u32>,
    ) -> Result<SyncOutcome, ProgressiveSyncError> {
        let scope = match from_height.filter(|height| *height > 0) {
            Some(from_height) => RefreshScope::Incremental { from_height },
            None => RefreshScope::Complete { floor: None },
        };
        self.refresh_with_scope(service, interests, scope).await
    }

    pub async fn refresh_with_scope(
        &mut self,
        service: &mut ChainService,
        mut interests: Vec<WalletInterest>,
        scope: RefreshScope,
    ) -> Result<SyncOutcome, ProgressiveSyncError> {
        interests.sort();
        interests.dedup();
        let from_height = scope.provider_floor();
        let incremental_start = scope.incremental_start();
        if let Some(start) = incremental_start {
            let Some(previous) = &self.reconciliation.authoritative else {
                self.reconciliation
                    .record_failure("incremental refresh requires a complete baseline");
                return Err(ProgressiveSyncError::MissingRefreshBaseline);
            };
            if previous.value.interests != interests
                || !previous
                    .value
                    .tip
                    .as_ref()
                    .is_some_and(|tip| u64::from(start) <= u64::from(tip.height) + 1)
            {
                self.reconciliation.record_failure(
                    "incremental refresh scope differs from its baseline or leaves a height gap",
                );
                return Err(ProgressiveSyncError::InconsistentRefreshScope);
            }
        }
        service.retry_offline_routes();
        let routes = service.routes_for_operation(ChainOperation::WalletRefresh);
        if routes.is_empty() {
            self.reconciliation
                .record_failure("no wallet route is available under the current policy");
            return Err(ProgressiveSyncError::NoWalletRoute);
        }

        for route in routes {
            if matches!(
                route.protocol,
                ProtocolFamily::Bip37 | ProtocolFamily::Neutrino
            ) {
                if let Err(error) = self.prime_headers_on_same_route(service, &route).await {
                    self.reconciliation
                        .record_failure(format!("header prerequisite failed: {error:?}"));
                    continue;
                }
            }

            let request = ChainRequest::WalletRefresh {
                interests: interests.clone(),
                from_height,
            };
            match service.execute_on_route(&route, &request).await {
                Ok(observation) => {
                    let ChainPayload::WalletRefresh { transactions, tip } = observation.value
                    else {
                        self.reconciliation
                            .record_failure("wallet route returned unexpected payload");
                        continue;
                    };
                    if matches!(
                        route.protocol,
                        ProtocolFamily::Bip37 | ProtocolFamily::Neutrino
                    ) {
                        let verified_tip =
                            self.header_view.as_ref().and_then(VerifiedHeaderView::tip);
                        let reported_tip = tip.as_ref().map(|tip| (tip.height, tip.hash));
                        if verified_tip.is_none()
                            || reported_tip != verified_tip
                            || observation.chain_tip != verified_tip
                        {
                            self.reconciliation.record_failure(
                                "wallet snapshot does not match the verified header tip",
                            );
                            continue;
                        }
                    }
                    let mut evidence = observation.evidence;
                    let transactions = if let Some(start) = incremental_start {
                        if !tip
                            .as_ref()
                            .is_some_and(|tip| tip.height >= start.saturating_sub(1))
                        {
                            self.reconciliation.record_failure(
                                "incremental refresh does not cover its requested height",
                            );
                            continue;
                        }
                        let mut merged = std::collections::BTreeMap::new();
                        if let Some(previous) = &self.reconciliation.authoritative {
                            // The new scan covers only the suffix. It cannot upgrade
                            // evidence for the retained prefix, even when that prefix
                            // contains no known transactions.
                            if evidence_strength(&previous.evidence) < evidence_strength(&evidence)
                            {
                                evidence = previous.evidence.clone();
                            }
                            for transaction in &previous.value.transactions {
                                // A block scan's omission does not prove mempool eviction.
                                // Pending entries need explicit conflict/eviction evidence.
                                if transaction.block_height.is_none_or(|height| height < start) {
                                    merged.insert(transaction.txid, transaction.clone());
                                }
                            }
                        }
                        for transaction in transactions {
                            merged.insert(transaction.txid, transaction);
                        }
                        merged.into_values().collect()
                    } else {
                        transactions
                    };
                    let snapshot = WalletNetworkSnapshot {
                        hd: None,
                        interests: interests.clone(),
                        transactions,
                        tip,
                    };
                    let decision = self.reconciliation.reconcile_candidate(
                        snapshot,
                        observation.source,
                        evidence,
                        observation.chain_tip,
                        true,
                    );
                    return Ok(SyncOutcome { route, decision });
                }
                Err(error) => {
                    self.reconciliation
                        .record_failure(format!("wallet refresh failed: {error}"));
                }
            }
        }
        Err(ProgressiveSyncError::Exhausted)
    }

    pub(crate) async fn prime_headers_on_same_route(
        &mut self,
        service: &mut ChainService,
        wallet_route: &CapabilityRoute,
    ) -> Result<(), ProgressiveSyncError> {
        // Verify each batch before publishing it. P2P getheaders needs the
        // accepted hash of the preceding batch as its next locator. A later
        // failure leaves both authorities at the last fully verified batch;
        // it never marks wallet history fresh or accepts the failed batch.
        let mut view = self
            .header_view
            .clone()
            .ok_or(ProgressiveSyncError::MissingTrustedHeaderVerifier)?;
        let header_route = service
            .routes_for_operation(ChainOperation::HeaderSync)
            .into_iter()
            .find(|candidate| {
                candidate.source == wallet_route.source
                    && candidate.protocol == wallet_route.protocol
                    && candidate.endpoint == wallet_route.endpoint
            })
            .ok_or_else(|| ProgressiveSyncError::MissingHeaderRoute {
                source: wallet_route.source.clone(),
                protocol: wallet_route.protocol,
            })?;

        let mut start = view
            .verifier()
            .state()
            .map_err(ProgressiveSyncError::HeaderVerification)?
            .height
            .checked_add(1)
            .ok_or(ProgressiveSyncError::HeaderSafetyLimit)?;
        for _ in 0..self.config.max_header_batches {
            let request = ChainRequest::HeaderSync {
                start_height: start,
                count: self.config.header_batch_size.max(1),
            };
            let observation = service
                .execute_on_route(&header_route, &request)
                .await
                .map_err(ProgressiveSyncError::Chain)?;
            let ChainPayload::Headers {
                start_height,
                headers,
            } = observation.value
            else {
                return Err(ProgressiveSyncError::UnexpectedPayload);
            };
            if start_height != start
                || headers.len() > self.config.header_batch_size.max(1) as usize
            {
                return Err(ProgressiveSyncError::InvalidHeaderRange);
            }
            if headers.is_empty() {
                return Ok(());
            }
            let returned = u32::try_from(headers.len())
                .map_err(|_| ProgressiveSyncError::HeaderSafetyLimit)?;
            let batch: Vec<BlockHeaderBytes> = headers.into_iter().map(BlockHeaderBytes).collect();
            view.extend(&batch)
                .map_err(ProgressiveSyncError::HeaderView)?;
            let staged = batch
                .into_iter()
                .enumerate()
                .map(|(offset, header)| (start_height + offset as u32, header))
                .collect();
            self.publish_headers(view.clone(), staged)?;
            start = start_height
                .checked_add(returned)
                .ok_or(ProgressiveSyncError::HeaderSafetyLimit)?;
            if returned < self.config.header_batch_size.max(1) {
                return Ok(());
            }
        }
        Err(ProgressiveSyncError::HeaderSafetyLimit)
    }

    /// Commit one bounded verified batch: the verified view and the dense store
    /// advance together, or neither does.
    ///
    /// The join is checked before anything is written, so a batch that does not
    /// continue the store cannot leave it half-extended. Everything after the
    /// first header links to the one before it, which the view already proved,
    /// so that single check covers the batch.
    fn publish_headers(
        &mut self,
        view: VerifiedHeaderView,
        staged: Vec<(u32, BlockHeaderBytes)>,
    ) -> Result<(), ProgressiveSyncError> {
        if let Some(store) = self.accepted.as_ref() {
            store
                .write(|retained| {
                    if let Some((height, header)) = staged.first() {
                        if let Some(parent) = height
                            .checked_sub(1)
                            .and_then(|before| retained.hash_at(before))
                        {
                            if header.0[4..36] != parent {
                                return Err(HeaderStoreError::Linkage { height: *height });
                            }
                        }
                    }
                    for (height, header) in staged {
                        retained.insert_verified(height, header)?;
                    }
                    Ok(())
                })
                .map_err(ProgressiveSyncError::HeaderStore)?;
        }
        self.header_view = Some(view);
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    // The worker itself drives the shared view; these tests still exercise the
    // verifier trait directly to build fixtures.
    use crate::chain::HeaderVerifier;
    use crate::chain::{
        Capability, CapabilityConfidence, CapabilityDiscovery, CapabilitySet, ChainSource,
        ConnectionPolicy, Endpoint, EndpointKind, Evidence, ProviderHealth, SourceCatalog,
        SourceDisposition, SourceOrigin,
    };
    use crate::chain_service::{BackendObservation, ChainBackend, ChainFuture};
    use std::sync::Arc;

    struct WalletBackend {
        id: SourceId,
        endpoint: Endpoint,
        caps: CapabilitySet,
        protocol: ProtocolFamily,
        headers: Vec<[u8; 80]>,
        header_height_offset: u32,
        wallet_evidence: Evidence,
        /// Every floor this backend was asked to scan from, in order.
        asked_from: Arc<std::sync::Mutex<Vec<Option<u32>>>>,
        locator_store: Option<Arc<SharedHeaders>>,
    }
    impl ChainBackend for WalletBackend {
        fn source_id(&self) -> &SourceId {
            &self.id
        }
        fn protocol(&self) -> ProtocolFamily {
            self.protocol
        }
        fn endpoint(&self) -> Option<&Endpoint> {
            Some(&self.endpoint)
        }
        fn capabilities(&self) -> &CapabilitySet {
            &self.caps
        }
        fn health(&self) -> ProviderHealth {
            ProviderHealth::Healthy
        }
        fn supports(&self, op: ChainOperation) -> bool {
            matches!(
                op,
                ChainOperation::WalletRefresh | ChainOperation::HeaderSync
            )
        }
        fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
            Box::pin(async move {
                if let ChainRequest::HeaderSync {
                    start_height,
                    count,
                } = request
                {
                    if *start_height > 1 {
                        if let Some(store) = &self.locator_store {
                            use crate::header_store::BlockHeaderSource;
                            if store.hash_at(start_height - 1).is_none() {
                                return Err(crate::chain_service::ChainBackendError::Rejected(
                                    "previous batch is not available as an accepted locator".into(),
                                ));
                            }
                        }
                    }
                    return Ok(BackendObservation {
                        payload: ChainPayload::Headers {
                            start_height: start_height + self.header_height_offset,
                            headers: self
                                .headers
                                .iter()
                                .skip((*start_height - 1) as usize)
                                .take(*count as usize)
                                .copied()
                                .collect(),
                        },
                        evidence: Evidence::ServerAssertion,
                        chain_tip: None,
                    });
                }
                if let ChainRequest::WalletRefresh { from_height, .. } = request {
                    self.asked_from
                        .lock()
                        .expect("floor recorder")
                        .push(*from_height);
                }
                Ok(BackendObservation {
                    payload: ChainPayload::WalletRefresh {
                        transactions: vec![],
                        tip: Some(ChainTip {
                            height: 7,
                            hash: [7; 32],
                        }),
                    },
                    evidence: self.wallet_evidence.clone(),
                    chain_tip: Some((7, [7; 32])),
                })
            })
        }
    }

    pub(crate) fn wallet_service(protocol: ProtocolFamily) -> ChainService {
        service_with_headers(protocol, vec![], 0, Evidence::ServerAssertion)
    }

    fn service_with_headers(
        protocol: ProtocolFamily,
        headers: Vec<[u8; 80]>,
        header_height_offset: u32,
        wallet_evidence: Evidence,
    ) -> ChainService {
        service_with_header_locator(
            protocol,
            headers,
            header_height_offset,
            wallet_evidence,
            None,
        )
    }

    fn service_with_header_locator(
        protocol: ProtocolFamily,
        headers: Vec<[u8; 80]>,
        header_height_offset: u32,
        wallet_evidence: Evidence,
        locator_store: Option<Arc<SharedHeaders>>,
    ) -> ChainService {
        let id = SourceId::new("server");
        let endpoint = Endpoint {
            kind: if protocol == ProtocolFamily::Electrum {
                EndpointKind::ElectrumTcp
            } else {
                EndpointKind::BchP2p
            },
            host: "server".into(),
            port: Some(50001),
        };
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(ChainSource {
                id: id.clone(),
                label: "server".into(),
                origin: SourceOrigin::UserAdded,
                endpoints: vec![endpoint.clone()],
                capabilities: CapabilitySet::default(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            })
            .unwrap();
        let mut caps = CapabilitySet::default();
        caps.record(
            Capability::UtxoQuery,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ActiveProbe,
        );
        caps.record(
            Capability::HeaderStream,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ActiveProbe,
        );
        let mut service = ChainService::new(catalog, ConnectionPolicy::auto());
        service.register(Arc::new(WalletBackend {
            id,
            endpoint,
            caps,
            protocol,
            headers,
            header_height_offset,
            wallet_evidence,
            asked_from: Arc::new(std::sync::Mutex::new(Vec::new())),
            locator_store,
        }));
        service
    }

    /// A service whose only provider reports the scan floors it was given.
    fn service_recording_floors(
        protocol: ProtocolFamily,
    ) -> (ChainService, Arc<std::sync::Mutex<Vec<Option<u32>>>>) {
        let asked_from = Arc::new(std::sync::Mutex::new(Vec::new()));
        let id = SourceId::new("recorder");
        let endpoint = Endpoint {
            kind: EndpointKind::ElectrumTcp,
            host: "recorder".into(),
            port: Some(50001),
        };
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(ChainSource {
                id: id.clone(),
                label: "recorder".into(),
                origin: SourceOrigin::UserAdded,
                endpoints: vec![endpoint.clone()],
                capabilities: CapabilitySet::default(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            })
            .unwrap();
        let mut caps = CapabilitySet::default();
        caps.record(
            Capability::UtxoQuery,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ActiveProbe,
        );
        caps.record(
            Capability::HeaderStream,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ActiveProbe,
        );
        let mut service = ChainService::new(catalog, ConnectionPolicy::auto());
        service.register(Arc::new(WalletBackend {
            id,
            endpoint,
            caps,
            protocol,
            headers: Vec::new(),
            header_height_offset: 0,
            wallet_evidence: Evidence::ServerAssertion,
            asked_from: asked_from.clone(),
            locator_store: None,
        }));
        (service, asked_from)
    }

    // Synthetic low-difficulty chain, used only to exercise verifier wiring.
    // These parameters and checkpoint must never be used for a real network.
    fn header_fixture() -> (ShvMmrHeaderVerifier, Vec<[u8; 80]>) {
        header_fixture_to(2)
    }

    pub(crate) fn header_fixture_to(end: u32) -> (ShvMmrHeaderVerifier, Vec<[u8; 80]>) {
        use optn_core::asert::{next_bits, AsertAnchor, AsertParams};
        use optn_core::header_pow::verify_declared_pow;
        let params = AsertParams {
            half_life: 172800,
            ideal_block_time: 600,
            max_bits: 0x207fffff,
            retargets: true,
        };
        let anchor = AsertAnchor {
            height: 0,
            bits: params.max_bits,
            prev_time: 0,
        };
        let mut previous_hash = [0; 32];
        let mut headers = Vec::new();
        for height in 0u32..=end {
            let mut header = [0u8; 80];
            header[0..4].copy_from_slice(&1u32.to_le_bytes());
            header[4..36].copy_from_slice(&previous_hash);
            header[68..72].copy_from_slice(&((height + 1) * 600).to_le_bytes());
            let bits = if height == 0 {
                params.max_bits
            } else {
                next_bits(params, anchor, height - 1, i64::from(height * 600)).unwrap()
            };
            header[72..76].copy_from_slice(&bits.to_le_bytes());
            let mut valid = None;
            for nonce in 0u32..10000 {
                header[76..80].copy_from_slice(&nonce.to_le_bytes());
                if let Ok(parsed) = verify_declared_pow(&header) {
                    valid = Some(parsed.hash);
                    break;
                }
            }
            previous_hash = valid.expect("bounded test header mining");
            headers.push(header);
        }
        let checkpoint = BlockHeaderBytes(headers.remove(0));
        let commitment = crate::header_verifier::header_leaf(&checkpoint);
        let verifier = ShvMmrHeaderVerifier::from_checkpoint_proof(
            0,
            checkpoint,
            &[],
            commitment,
            crate::chain::CheckpointProvenance::ShippedReviewed,
        )
        .unwrap()
        .with_asert(params, anchor);
        (verifier, headers)
    }

    #[tokio::test]
    async fn header_pass_verifies_multiple_batches_and_keeps_cursor_on_rejection() {
        for protocol in [ProtocolFamily::Bip37, ProtocolFamily::Neutrino] {
            let (verifier, headers) = header_fixture();
            let mut expected = verifier.clone();
            expected
                .extend(
                    &headers
                        .iter()
                        .copied()
                        .map(BlockHeaderBytes)
                        .collect::<Vec<_>>(),
                )
                .unwrap();
            let mut accepted_prefix = verifier.clone();
            accepted_prefix
                .extend(&[BlockHeaderBytes(headers[0])])
                .unwrap();
            let (tip_header, tip_proof) = expected.tip_checkpoint_proof().unwrap();
            let checkpoint = expected.checkpoint();
            let restored = ShvMmrHeaderVerifier::from_checkpoint_proof(
                checkpoint.height,
                tip_header.clone(),
                tip_proof,
                checkpoint.commitment,
                checkpoint.provenance,
            )
            .unwrap();
            assert_eq!(restored.state().unwrap(), expected.state().unwrap());
            assert_eq!(restored.last_hash(), expected.last_hash());
            assert_eq!(restored.last_time(), expected.last_time());
            let config = ProgressiveSyncConfig {
                header_batch_size: 1,
                ..Default::default()
            };
            let mut worker = ProgressiveSyncWorker::new(config)
                .with_header_verifier(Network::Chipnet, verifier.clone())
                .unwrap();
            let mut service =
                service_with_headers(protocol, headers.clone(), 0, Evidence::ServerAssertion);
            let route = service
                .routes_for_operation(ChainOperation::WalletRefresh)
                .remove(0);
            worker
                .prime_headers_on_same_route(&mut service, &route)
                .await
                .unwrap();
            assert_eq!(
                worker.header_verifier().unwrap().state().unwrap(),
                expected.state().unwrap()
            );
            // Retrying begins at the verified cursor, not the legacy config hint.
            worker
                .prime_headers_on_same_route(&mut service, &route)
                .await
                .unwrap();
            assert_eq!(
                worker.header_verifier().unwrap().state().unwrap(),
                expected.state().unwrap()
            );

            let mut bad_headers = headers.clone();
            bad_headers[1][4] ^= 1;
            let mut rejected = ProgressiveSyncWorker::new(config)
                .with_header_verifier(Network::Chipnet, verifier.clone())
                .unwrap();
            let mut bad_service =
                service_with_headers(protocol, bad_headers, 0, Evidence::ServerAssertion);
            assert!(rejected
                .prime_headers_on_same_route(&mut bad_service, &route)
                .await
                .is_err());
            assert_eq!(
                rejected.header_verifier().unwrap().state().unwrap(),
                accepted_prefix.state().unwrap()
            );

            let mut gap_service =
                service_with_headers(protocol, headers, 1, Evidence::ServerAssertion);
            assert_eq!(
                rejected
                    .prime_headers_on_same_route(&mut gap_service, &route)
                    .await,
                Err(ProgressiveSyncError::InvalidHeaderRange)
            );
            assert_eq!(
                rejected.header_verifier().unwrap().state().unwrap(),
                accepted_prefix.state().unwrap()
            );

            // This backend advertises wallet tip 7 even though only headers
            // through height 2 were verified. It cannot become wallet truth.
            assert_eq!(
                worker.refresh(&mut service, vec![], None).await,
                Err(ProgressiveSyncError::Exhausted)
            );
            assert!(worker.reconciliation().authoritative.is_none());
        }
    }

    #[tokio::test]
    async fn p2p_refresh_cannot_accept_a_snapshot_without_trusted_headers() {
        for protocol in [ProtocolFamily::Bip37, ProtocolFamily::Neutrino] {
            let mut service = wallet_service(protocol);
            let mut worker = ProgressiveSyncWorker::new(ProgressiveSyncConfig::default());
            assert_eq!(
                worker.refresh(&mut service, vec![], None).await,
                Err(ProgressiveSyncError::Exhausted)
            );
            assert!(worker.reconciliation().authoritative.is_none());
        }
    }

    /// Verified progress is the runtime's, not a sync run's.
    ///
    /// The worker borrows the shared view, advances it, and hands it back. A
    /// later run -- or a run against a different provider -- resumes from that
    /// state instead of re-verifying, which is what makes persisting the view
    /// worth doing.
    #[tokio::test]
    async fn the_advanced_view_can_be_handed_to_the_next_worker() {
        let (verifier, headers) = header_fixture();
        let worker = ProgressiveSyncWorker::new(ProgressiveSyncConfig {
            header_start_height: 1,
            header_batch_size: 2,
            max_header_batches: 8,
        })
        .with_header_verifier(Network::Chipnet, verifier)
        .expect("a trusted verifier enables verified P2P sync");

        let before = worker
            .header_view()
            .expect("the worker holds the shared view")
            .tip();

        let mut worker = worker;
        let mut service =
            service_with_headers(ProtocolFamily::Bip37, headers, 0, Evidence::ServerAssertion);
        let route = service
            .routes_for_operation(ChainOperation::WalletRefresh)
            .remove(0);
        worker
            .prime_headers_on_same_route(&mut service, &route)
            .await
            .expect("headers prime on the wallet route");

        let advanced = worker
            .header_view()
            .expect("still holds the view")
            .tip()
            .expect("a tip after priming");
        assert_ne!(Some(advanced), before, "the sync run advanced the view");

        // Hand it to a fresh worker: the state travels, not the worker.
        let carried = worker.into_header_view().expect("view is recoverable");
        let carried_state = carried.verifier().state().expect("state");
        let carried_anchors = carried.times().anchors().to_vec();

        let next = ProgressiveSyncWorker::new(ProgressiveSyncConfig::default())
            .with_header_view(carried)
            .expect("an advanced view is still a trusted one");
        let resumed = next.header_view().expect("the next worker holds it");
        assert_eq!(resumed.verifier().state().expect("state"), carried_state);
        assert_eq!(resumed.times().anchors(), carried_anchors.as_slice());
        assert_eq!(resumed.tip(), Some(advanced));
    }

    #[test]
    fn empty_verifier_cannot_enable_verified_sync() {
        let verifier =
            ShvMmrHeaderVerifier::empty(crate::chain::CheckpointProvenance::ShippedReviewed);
        assert!(matches!(
            ProgressiveSyncWorker::new(ProgressiveSyncConfig::default())
                .with_header_verifier(Network::Chipnet, verifier),
            Err(ProgressiveSyncError::MissingTrustedHeaderVerifier)
        ));
    }

    #[tokio::test]
    async fn incremental_refresh_preserves_baseline_and_refuses_scope_gaps() {
        let mut service = wallet_service(ProtocolFamily::Electrum);
        let mut worker = ProgressiveSyncWorker::new(ProgressiveSyncConfig::default());
        let interests = vec![WalletInterest::script(vec![0x51])];
        assert_eq!(
            worker
                .refresh(&mut service, interests.clone(), Some(5))
                .await,
            Err(ProgressiveSyncError::MissingRefreshBaseline)
        );
        let confirmed = ObservedTransaction {
            txid: [1; 32],
            raw: vec![1],
            block_height: Some(1),
        };
        let pending = ObservedTransaction {
            txid: [2; 32],
            raw: vec![2],
            block_height: None,
        };
        worker.reconciliation_mut().reconcile_candidate(
            WalletNetworkSnapshot {
                hd: None,
                interests: interests.clone(),
                transactions: vec![confirmed.clone(), pending.clone()],
                tip: Some(ChainTip {
                    height: 6,
                    hash: [6; 32],
                }),
            },
            SourceId::new("server"),
            Evidence::ServerAssertion,
            Some((6, [6; 32])),
            true,
        );
        let outcome = worker
            .refresh(&mut service, interests.clone(), Some(5))
            .await
            .unwrap();
        assert_eq!(outcome.decision, ReconciliationDecision::Accepted);
        let baseline = worker.reconciliation().authoritative.clone().unwrap();
        assert_eq!(baseline.value.transactions, vec![confirmed, pending]);
        assert_eq!(
            worker.refresh(&mut service, interests, Some(9)).await,
            Err(ProgressiveSyncError::InconsistentRefreshScope)
        );
        assert_eq!(
            worker
                .refresh(
                    &mut service,
                    vec![WalletInterest::script(vec![0x52])],
                    Some(5)
                )
                .await,
            Err(ProgressiveSyncError::InconsistentRefreshScope)
        );
        assert_eq!(
            worker.reconciliation().authoritative.as_ref(),
            Some(&baseline)
        );
    }

    #[tokio::test]
    async fn incremental_evidence_cannot_upgrade_the_unscanned_prefix() {
        let mut service = wallet_service(ProtocolFamily::Electrum);
        let mut worker = ProgressiveSyncWorker::new(ProgressiveSyncConfig::default());
        let interests = vec![WalletInterest::script(vec![0x51])];
        worker
            .refresh(&mut service, interests.clone(), None)
            .await
            .unwrap();
        let stronger = Evidence::FullNodeValidated {
            source: SourceId::new("server"),
        };
        let mut stronger_service =
            service_with_headers(ProtocolFamily::Electrum, vec![], 0, stronger.clone());
        worker
            .refresh(&mut stronger_service, interests.clone(), Some(5))
            .await
            .unwrap();
        assert_eq!(
            worker
                .reconciliation()
                .authoritative
                .as_ref()
                .unwrap()
                .evidence,
            Evidence::ServerAssertion
        );
        assert_eq!(
            worker.reconciliation().sync.verification,
            crate::chain::VerificationState::Discovered
        );
        // A complete rescan can establish stronger evidence for the entire scope.
        worker
            .refresh(&mut stronger_service, interests, None)
            .await
            .unwrap();
        assert_eq!(
            worker
                .reconciliation()
                .authoritative
                .as_ref()
                .unwrap()
                .evidence,
            stronger
        );
    }

    #[test]
    fn coin_projection_keeps_zero_value_tokens_and_refuses_partial_replacement() {
        use optn_core::{
            cashaddr::{Address, AddressKind},
            coins::{Coin, CoinSet, FreezeReason, Outpoint},
            network::Network,
        };
        let address = Address::from_hash("bchtest", AddressKind::P2pkh, [1; 20]);
        let script = address.script_pubkey();
        let token = optn_core::token::TokenData::fungible([9; 32], 42);
        let mut field = token.encode_prefix().unwrap();
        field.extend_from_slice(&script);
        // Serialization fixture only; no proof or spendability claim.
        let mut raw = vec![2, 0, 0, 0, 0, 2];
        for (value, field) in [(1000u64, script.clone()), (0, field)] {
            raw.extend_from_slice(&value.to_le_bytes());
            raw.extend_from_slice(&optn_core::tx::varint(field.len() as u64));
            raw.extend_from_slice(&field);
        }
        raw.extend_from_slice(&[0; 4]);
        let txid = optn_core::header_hash::sha256d(&raw);
        let snapshot = WalletNetworkSnapshot {
            hd: None,
            interests: vec![WalletInterest::script(script)],
            transactions: vec![ObservedTransaction {
                txid,
                raw,
                block_height: Some(1),
            }],
            tip: Some(ChainTip {
                height: 7,
                hash: [7; 32],
            }),
        };
        let mut display = txid;
        display.reverse();
        let outpoint = Outpoint::new(display, 0);
        let mut coins = CoinSet::new();
        coins
            .insert(
                Coin::new(outpoint, 222, address.encode())
                    .unwrap()
                    .with_label("local")
                    .with_fuse_depth(2),
            )
            .unwrap();
        coins.freeze(outpoint, FreezeReason::User).unwrap();
        snapshot
            .reconcile_coins(Network::Chipnet, &[address.encode()], &mut coins)
            .unwrap();
        let first = coins.get(outpoint).unwrap();
        assert_eq!(first.value_sats(), 1000);
        assert_eq!(first.label(), Some("local"));
        assert_eq!(first.fuse_depth(), 2);
        assert_eq!(first.freeze(), Some(FreezeReason::User));
        let zero = coins.get(Outpoint::new(display, 1)).unwrap();
        assert_eq!(zero.value_sats(), 0);
        assert_eq!(zero.token(), Some(&token));
        assert!(!zero.is_spendable());
        let wire = serde_json::to_string(&optn_transport::WireCoin::from(zero)).unwrap();
        let restored =
            Coin::try_from(serde_json::from_str::<optn_transport::WireCoin>(&wire).unwrap())
                .unwrap();
        assert_eq!(&restored, zero);
        coins
            .insert(
                Coin::new(
                    Outpoint::new([8; 32], 0),
                    1000,
                    Address::from_hash("bchtest", AddressKind::P2pkh, [2; 20]).encode(),
                )
                .unwrap(),
            )
            .unwrap();
        let before = coins.clone();
        assert!(snapshot
            .reconcile_coins(Network::Chipnet, &[address.encode()], &mut coins)
            .is_err());
        assert!(snapshot
            .reconcile_coins(Network::Mainnet, &[address.encode()], &mut coins)
            .is_err());
        assert_eq!(coins, before);
    }

    #[test]
    fn script_balance_projects_pending_spends_and_checks_scope() {
        // Serialization fixtures, not mined or spendable transactions.
        let mut parent = vec![1, 0, 0, 0, 0, 1];
        parent.extend_from_slice(&1000u64.to_le_bytes());
        parent.extend_from_slice(&[1, 0x51, 0, 0, 0, 0]);
        let parent_id = optn_core::header_hash::sha256d(&parent);
        let mut child = vec![1, 0, 0, 0, 1];
        child.extend_from_slice(&parent_id);
        child.extend_from_slice(&[0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 1]);
        child.extend_from_slice(&900u64.to_le_bytes());
        child.extend_from_slice(&[1, 0x52, 0, 0, 0, 0]);
        let mut snapshot = WalletNetworkSnapshot {
            hd: None,
            interests: vec![WalletInterest::script(vec![0x51])],
            transactions: vec![
                ObservedTransaction {
                    txid: optn_core::header_hash::sha256d(&child),
                    raw: child,
                    block_height: None,
                },
                ObservedTransaction {
                    txid: parent_id,
                    raw: parent,
                    block_height: Some(2),
                },
            ],
            tip: Some(ChainTip {
                height: 7,
                hash: [7; 32],
            }),
        };
        assert_eq!(snapshot.script_balance(&[0x51]).unwrap(), (1000, -1000));
        assert!(snapshot.script_outputs(&[0x51]).unwrap().is_empty());
        let mut duplicate = snapshot.transactions[1].clone();
        duplicate.block_height = None;
        snapshot.transactions.push(duplicate);
        assert!(snapshot.script_balance(&[0x51]).is_err());
        assert!(snapshot.script_outputs(&[0x51]).is_err());
        snapshot.transactions.pop();
        assert!(snapshot.script_balance(&[0x52]).is_err());
        snapshot.transactions[1].block_height = Some(8);
        assert!(snapshot.script_balance(&[0x51]).is_err());
        snapshot.transactions[1].block_height = Some(2);
        snapshot.transactions[1].txid = [9; 32];
        assert!(snapshot.script_balance(&[0x51]).is_err());
    }

    #[tokio::test]
    async fn successful_refresh_reconciles_snapshot() {
        let mut service = wallet_service(ProtocolFamily::Electrum);
        let mut worker = ProgressiveSyncWorker::new(ProgressiveSyncConfig::default());
        let outcome = worker.refresh(&mut service, vec![], None).await.unwrap();
        assert_eq!(outcome.decision, ReconciliationDecision::Accepted);
        assert_eq!(
            worker
                .reconciliation()
                .authoritative
                .as_ref()
                .unwrap()
                .value
                .tip
                .as_ref()
                .unwrap()
                .height,
            7
        );
        let retained = worker.reconciliation().authoritative.clone();
        *service.catalog_mut() = SourceCatalog::default();
        assert_eq!(
            worker.refresh(&mut service, vec![], None).await,
            Err(ProgressiveSyncError::NoWalletRoute)
        );
        assert_eq!(worker.reconciliation().authoritative, retained);
        assert!(!worker.reconciliation().sync.history_fresh);
        assert!(!worker.reconciliation().sync.utxos_fresh);
    }

    /// The verified view and the dense store are one accepted chain.
    ///
    /// Nothing used to write accepted headers where a provider could read them:
    /// the worker verified into its view and stopped, the shared store stayed at
    /// whatever it was seeded with, and every Bloom or compact-filter scan then
    /// correctly refused to run because the accepted chain did not cover the
    /// range it was asked about. Verifying headers and publishing them are one
    /// step or the wallet cannot sync.
    #[tokio::test]
    async fn a_header_pass_advances_the_view_and_the_store_together() {
        use crate::header_store::BlockHeaderSource;

        let (verifier, headers) = header_fixture();
        let config = ProgressiveSyncConfig {
            header_batch_size: 1,
            ..Default::default()
        };
        let store = Arc::new(SharedHeaders::default());
        let mut worker = ProgressiveSyncWorker::new(config)
            .with_header_verifier(Network::Chipnet, verifier)
            .unwrap()
            .with_accepted_headers(store.clone());
        let mut service = service_with_header_locator(
            ProtocolFamily::Bip37,
            headers.clone(),
            0,
            Evidence::ServerAssertion,
            Some(store.clone()),
        );
        let route = service
            .routes_for_operation(ChainOperation::WalletRefresh)
            .remove(0);
        worker
            .prime_headers_on_same_route(&mut service, &route)
            .await
            .unwrap();

        let view_tip = worker
            .header_view()
            .and_then(VerifiedHeaderView::tip)
            .expect("a verified tip");
        assert_eq!(
            store.tip(),
            Some(view_tip),
            "the accepted store did not follow the verified view"
        );

        // The lookups a scan actually performs, over what was just published.
        let (first, last) = store.retained_span().expect("a retained span");
        let range = store
            .range_inclusive(first, last)
            .expect("accepted headers are contiguous");
        assert_eq!(range.len() as u32, last - first + 1);
        for (height, hash) in &range {
            assert_eq!(store.hash_at(*height), Some(*hash));
            assert_eq!(store.height_of(hash), Some(*height));
        }
    }

    /// A rejected later batch leaves both authorities at the accepted prefix.
    #[tokio::test]
    async fn a_rejected_header_batch_preserves_only_the_verified_prefix() {
        use crate::header_store::BlockHeaderSource;

        let (verifier, headers) = header_fixture();
        let config = ProgressiveSyncConfig {
            header_batch_size: 1,
            ..Default::default()
        };
        let store = Arc::new(SharedHeaders::default());
        let mut worker = ProgressiveSyncWorker::new(config)
            .with_header_verifier(Network::Chipnet, verifier)
            .unwrap()
            .with_accepted_headers(store.clone());

        let mut tampered = headers;
        tampered[1][4] ^= 1;
        let mut service = service_with_headers(
            ProtocolFamily::Bip37,
            tampered,
            0,
            Evidence::ServerAssertion,
        );
        let route = service
            .routes_for_operation(ChainOperation::WalletRefresh)
            .remove(0);
        assert!(worker
            .prime_headers_on_same_route(&mut service, &route)
            .await
            .is_err());

        assert_eq!(worker.header_verifier().unwrap().state().unwrap().height, 1);
        assert_eq!(store.retained_span(), Some((1, 1)));
        assert_eq!(
            store.tip(),
            worker.header_view().and_then(VerifiedHeaderView::tip)
        );
        assert_eq!(store.hash_at(2), None);
    }

    /// A floor and a baseline are different requests.
    ///
    /// Both used to arrive as `from_height`, so a wallet asking to scan from
    /// its birthday was told it needed a baseline it had never built. That is
    /// why an HD wallet could not use BIP37 or Neutrino at all: those refuse a
    /// scan with no floor, and the only way to supply one demanded a prior
    /// complete result.
    #[tokio::test]
    async fn a_floor_does_not_require_a_baseline_but_a_top_up_does() {
        let (mut service, asked_from) = service_recording_floors(ProtocolFamily::Electrum);
        let mut worker = ProgressiveSyncWorker::new(ProgressiveSyncConfig::default());

        // No baseline anywhere, and a floor is still a legitimate request.
        worker
            .refresh_with_scope(
                &mut service,
                vec![],
                RefreshScope::Complete { floor: Some(5) },
            )
            .await
            .expect("a complete scan from a floor needs no baseline");
        assert_eq!(
            asked_from.lock().unwrap().last().copied(),
            Some(Some(5)),
            "the floor has to reach the provider or BIP37 and Neutrino refuse"
        );

        // The same number, meant as a top-up, still needs one.
        let (mut fresh, _) = service_recording_floors(ProtocolFamily::Electrum);
        let mut topping_up = ProgressiveSyncWorker::new(ProgressiveSyncConfig::default());
        assert_eq!(
            topping_up
                .refresh_with_scope(
                    &mut fresh,
                    vec![],
                    RefreshScope::Incremental { from_height: 5 },
                )
                .await,
            Err(ProgressiveSyncError::MissingRefreshBaseline)
        );
    }

    /// A complete scan replaces the snapshot rather than merging onto it.
    #[tokio::test]
    async fn a_complete_scan_from_a_floor_does_not_merge_a_prefix() {
        let (mut service, _) = service_recording_floors(ProtocolFamily::Electrum);
        let mut worker = ProgressiveSyncWorker::new(ProgressiveSyncConfig::default());

        // Establish a baseline the incremental path would have merged onto.
        worker
            .refresh_with_scope(&mut service, vec![], RefreshScope::Complete { floor: None })
            .await
            .expect("a baseline");
        assert!(worker.reconciliation().authoritative.is_some());

        // A rescan from a floor is a fresh answer, not an extension of that.
        worker
            .refresh_with_scope(
                &mut service,
                vec![],
                RefreshScope::Complete { floor: Some(3) },
            )
            .await
            .expect("a rescan from a floor is accepted");
        let snapshot = worker
            .reconciliation()
            .authoritative
            .as_ref()
            .expect("a snapshot");
        assert!(
            snapshot.value.transactions.is_empty(),
            "a complete scan reports what it found, not what a baseline remembered"
        );
    }

    /// The compatibility wrapper still means "top-up".
    #[tokio::test]
    async fn the_plain_refresh_entry_point_keeps_its_meaning() {
        let (mut service, _) = service_recording_floors(ProtocolFamily::Electrum);
        let mut worker = ProgressiveSyncWorker::new(ProgressiveSyncConfig::default());
        assert_eq!(
            worker.refresh(&mut service, vec![], Some(5)).await,
            Err(ProgressiveSyncError::MissingRefreshBaseline)
        );
    }
}
