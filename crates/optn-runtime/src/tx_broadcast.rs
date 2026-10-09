//! Broadcast state tracking for issue #75.
//!
//! A transport timeout after submission is not proof that a transaction was not
//! accepted. The runtime therefore preserves an explicit `Uncertain` state
//! instead of collapsing every provider failure into "broadcast failed".

use crate::chain::{Hash32, SourceId};
use crate::chain_service::{
    AttemptFailure, ChainBackendError, ChainPayload, ChainRequest, ChainService, ChainServiceError,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BroadcastState {
    Prepared {
        txid: Hash32,
    },
    /// A provider accepted the broadcast call. This is not yet independent
    /// mempool/chain observation.
    Submitted {
        txid: Hash32,
        via: SourceId,
    },
    /// A later chain observation independently found the exact transaction.
    Observed {
        txid: Hash32,
        via: SourceId,
    },
    /// Submission may have reached one or more peers, but the runtime cannot
    /// establish acceptance or deterministic rejection.
    Uncertain {
        txid: Hash32,
        attempts: Vec<AttemptFailure>,
    },
    /// Every attempted route produced an explicit deterministic rejection.
    Rejected {
        txid: Hash32,
        attempts: Vec<AttemptFailure>,
    },
    /// No permitted provider can currently broadcast.
    Unavailable {
        txid: Hash32,
    },
}

impl BroadcastState {
    pub const fn txid(&self) -> Hash32 {
        match self {
            Self::Prepared { txid }
            | Self::Submitted { txid, .. }
            | Self::Observed { txid, .. }
            | Self::Uncertain { txid, .. }
            | Self::Rejected { txid, .. }
            | Self::Unavailable { txid } => *txid,
        }
    }

    pub const fn is_terminal_failure(&self) -> bool {
        matches!(self, Self::Rejected { .. })
    }
}

/// BCHN's words for "this node already has this exact transaction".
///
/// From BCHN's `validation.cpp` (`AcceptToMemoryPool`, reject code
/// `REJECT_DUPLICATE`, 0x12) and `node/transaction.cpp`
/// (`BroadcastTransaction`, RPC -27). A node that already holds the
/// transaction has observed it: a broadcast that meets one of these was not
/// rejected.
pub const ALREADY_IN_MEMPOOL: &str = "txn-already-in-mempool";
pub const ALREADY_KNOWN: &str = "txn-already-known";
pub const ALREADY_IN_CHAIN: &str = "transaction already in block chain";
/// Shares `REJECT_DUPLICATE` with the two above, but means a different
/// transaction already spends the same coins: a rejection. Matching is
/// therefore on the exact reason, never on the code.
pub const MEMPOOL_CONFLICT: &str = "txn-mempool-conflict";
const REJECT_DUPLICATE: u8 = 0x12;

/// What a node's answer to a broadcast says about the transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeBroadcastReply {
    /// The node already has this exact transaction.
    AlreadyHas,
    /// Another transaction already spends the same coins.
    Conflict,
    /// Anything else, decided by the caller as before.
    Other,
}

/// Read a P2P `reject` for this transaction (BIP61): code and bare reason.
pub fn classify_reject(code: u8, reason: &str) -> NodeBroadcastReply {
    match (code, reason) {
        (REJECT_DUPLICATE, ALREADY_IN_MEMPOOL | ALREADY_KNOWN) => NodeBroadcastReply::AlreadyHas,
        (REJECT_DUPLICATE, MEMPOOL_CONFLICT) => NodeBroadcastReply::Conflict,
        _ => NodeBroadcastReply::Other,
    }
}

/// Read `sendrawtransaction`'s error message, as BCHN words it: RPC -27's
/// text, or a reject reason followed by ` (code N)` (`FormatStateMessage`).
/// Exact matches only, so nothing that merely mentions a phrase is read as
/// success.
pub fn classify_node_message(message: &str) -> NodeBroadcastReply {
    let message = message.trim();
    if message == ALREADY_IN_CHAIN {
        return NodeBroadcastReply::AlreadyHas;
    }
    let Some(reason) = message.strip_suffix(" (code 18)") else {
        return NodeBroadcastReply::Other;
    };
    classify_reject(REJECT_DUPLICATE, reason)
}

#[derive(Default)]
pub struct BroadcastCoordinator;

impl BroadcastCoordinator {
    /// Submit only while the wallet snapshot remains current. Dropping a
    /// provider future stops pending setup; it cannot retract handed-off bytes.
    pub async fn submit_guarded(
        &self,
        service: &mut ChainService,
        raw_tx: Vec<u8>,
        txid: Hash32,
        guard: &crate::WalletOperationGuard,
    ) -> BroadcastState {
        guard_submission(guard, txid, self.submit(service, raw_tx, txid)).await
    }

    pub async fn submit(
        &self,
        service: &mut ChainService,
        raw_tx: Vec<u8>,
        txid: Hash32,
    ) -> BroadcastState {
        match service
            .execute(&ChainRequest::Broadcast { raw_tx, txid })
            .await
        {
            Ok(observation) => match observation.value {
                ChainPayload::BroadcastObserved { txid: observed } if observed == txid => {
                    BroadcastState::Submitted {
                        txid,
                        via: observation.source,
                    }
                }
                _ => BroadcastState::Uncertain {
                    txid,
                    attempts: Vec::new(),
                },
            },
            Err(ChainServiceError::NoEligibleProvider | ChainServiceError::RouteUnavailable) => {
                BroadcastState::Unavailable { txid }
            }
            Err(ChainServiceError::Exhausted { attempts }) => {
                if !attempts.is_empty()
                    && attempts
                        .iter()
                        .all(|attempt| matches!(attempt.error, ChainBackendError::Rejected(_)))
                {
                    BroadcastState::Rejected { txid, attempts }
                } else {
                    // Timeout/offline/protocol ambiguity is intentionally not
                    // collapsed to rejection. The tx may already be in flight.
                    BroadcastState::Uncertain { txid, attempts }
                }
            }
        }
    }

    /// Promote a submitted/uncertain transaction only after an exact chain
    /// lookup returns the same txid. A failed lookup does not demote the state:
    /// propagation may simply not have reached the queried route yet.
    pub async fn observe(
        &self,
        service: &mut ChainService,
        current: BroadcastState,
    ) -> BroadcastState {
        let txid = current.txid();
        match service
            .execute(&ChainRequest::TransactionLookup { txid })
            .await
        {
            Ok(observation) => match observation.value {
                ChainPayload::Transaction(transaction) if transaction.txid == txid => {
                    BroadcastState::Observed {
                        txid,
                        via: observation.source,
                    }
                }
                _ => current,
            },
            Err(_) => current,
        }
    }
}

async fn guard_submission(
    guard: &crate::WalletOperationGuard,
    txid: Hash32,
    submission: impl std::future::Future<Output = BroadcastState>,
) -> BroadcastState {
    if guard.is_revoked() {
        return BroadcastState::Unavailable { txid };
    }
    let uncertain = || BroadcastState::Uncertain {
        txid,
        attempts: Vec::new(),
    };
    let outcome = tokio::select! {
        biased;
        _ = guard.cancelled() => return uncertain(),
        outcome = submission => outcome,
    };
    if guard.is_revoked() {
        uncertain()
    } else {
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::{
        Capability, CapabilityConfidence, CapabilityDiscovery, CapabilitySet, ChainSource,
        ConnectionPolicy, Endpoint, EndpointKind, Evidence, ProtocolFamily, ProviderHealth,
        SourceCatalog, SourceDisposition, SourceOrigin,
    };
    use crate::chain_service::{
        BackendObservation, ChainBackend, ChainFuture, ChainOperation, ObservedTransaction,
    };
    use std::sync::Arc;

    struct MockBackend {
        id: SourceId,
        endpoint: Endpoint,
        caps: CapabilitySet,
        broadcast: Result<BackendObservation, ChainBackendError>,
        lookup: Result<BackendObservation, ChainBackendError>,
    }

    fn mock_endpoint() -> Endpoint {
        Endpoint {
            kind: EndpointKind::ElectrumTcp,
            host: "server".into(),
            port: Some(50001),
        }
    }

    impl ChainBackend for MockBackend {
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
            &self.caps
        }
        fn health(&self) -> ProviderHealth {
            ProviderHealth::Healthy
        }
        fn supports(&self, operation: ChainOperation) -> bool {
            matches!(
                operation,
                ChainOperation::Broadcast | ChainOperation::TransactionLookup
            )
        }
        fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
            let result = match request {
                ChainRequest::Broadcast { .. } => self.broadcast.clone(),
                ChainRequest::TransactionLookup { .. } => self.lookup.clone(),
                _ => Err(ChainBackendError::Unsupported),
            };
            Box::pin(async move { result })
        }
    }

    fn service(backend: MockBackend) -> ChainService {
        let mut service = ChainService::new(SourceCatalog::default(), ConnectionPolicy::auto());
        register_backend(&mut service, backend, 0);
        service
    }

    fn register_backend(service: &mut ChainService, backend: MockBackend, priority: u16) {
        service
            .catalog_mut()
            .insert(ChainSource {
                id: backend.id.clone(),
                label: "server".into(),
                origin: SourceOrigin::UserAdded,
                endpoints: vec![backend.endpoint.clone()],
                capabilities: CapabilitySet::default(),
                disposition: SourceDisposition::Enabled,
                priority,
            })
            .unwrap();
        service.register(Arc::new(backend));
    }

    fn caps() -> CapabilitySet {
        let mut caps = CapabilitySet::default();
        for capability in [Capability::Broadcast, Capability::TransactionQuery] {
            caps.record(
                capability,
                CapabilityConfidence::Verified,
                CapabilityDiscovery::ActiveProbe,
            );
        }
        caps
    }

    #[tokio::test]
    async fn broadcast_cancellation_stops_pending_submission_and_preserves_uncertainty() {
        use crate::{chain::SourceId, tx_broadcast::BroadcastState, AppRuntime};
        use optn_app::{AppAction, AppState, Network, WalletSyncView};
        use std::sync::atomic::{AtomicBool, Ordering};

        let preview = optn_app::seed_wallet_preview(
            Network::Chipnet,
            "Public cancellation fixture",
            optn_app::BIP39_TEST_VECTOR_MNEMONIC,
        )
        .unwrap();
        let mut state = AppState {
            network: Network::Chipnet,
            ..Default::default()
        };
        state.reduce(AppAction::OpenImportedWallet {
            name: preview.name,
            receive_address: preview.receive_address,
            account_path: preview.account_path,
        });
        state.wallet_sync = WalletSyncView {
            utxos_fresh: true,
            history_fresh: true,
            ..Default::default()
        };
        let (runtime, _driver) = AppRuntime::new(state);
        let submitted = || BroadcastState::Submitted {
            txid: [3; 32],
            via: SourceId::new("fixture"),
        };
        let txid = [3; 32];
        let guard = runtime.wallet_operation_guard();
        assert!(matches!(
            super::guard_submission(&guard, txid, async { submitted() }).await,
            BroadcastState::Submitted { .. }
        ));

        let sent = AtomicBool::new(false);
        let (started, connecting) = tokio::sync::oneshot::channel();
        let (continue_setup, setup) = tokio::sync::oneshot::channel();
        let submission = async {
            started.send(()).unwrap();
            setup.await.unwrap();
            sent.store(true, Ordering::SeqCst);
            submitted()
        };
        let (result, ()) = tokio::join!(super::guard_submission(&guard, txid, submission), async {
            connecting.await.unwrap();
            runtime.cancel_wallet_operations();
            // Both futures are now ready: cancellation must win before
            // provider setup can continue to the transaction write.
            let _ = continue_setup.send(());
        });
        assert!(matches!(result, BroadcastState::Uncertain { txid: id, .. } if id == txid));
        assert!(!sent.load(Ordering::SeqCst));
        assert!(matches!(
            super::guard_submission(&guard, txid, async {
                panic!("a revoked guard must not poll the provider")
            })
            .await,
            BroadcastState::Unavailable { .. }
        ));

        // A server may already have the bytes when cancellation arrives.
        // Never convert that race into either success or "not sent".
        let guard = runtime.wallet_operation_guard();
        let error = super::guard_submission(&guard, txid, async {
            sent.store(true, Ordering::SeqCst);
            runtime.cancel_wallet_operations();
            submitted()
        })
        .await;
        assert!(sent.load(Ordering::SeqCst));
        assert!(matches!(error, BroadcastState::Uncertain { txid: id, .. } if id == txid));
    }

    #[tokio::test]
    async fn timeout_is_uncertain_not_rejected() {
        let backend = MockBackend {
            id: SourceId::new("a"),
            endpoint: mock_endpoint(),
            caps: caps(),
            broadcast: Err(ChainBackendError::Timeout),
            lookup: Err(ChainBackendError::Offline),
        };
        let state = BroadcastCoordinator
            .submit(&mut service(backend), vec![1], [1; 32])
            .await;
        assert!(matches!(state, BroadcastState::Uncertain { .. }));
    }

    #[tokio::test]
    async fn ambiguous_broadcast_preserves_all_attempts_without_using_a_later_route() {
        let txid = [1; 32];
        for error in [
            ChainBackendError::Timeout,
            ChainBackendError::Offline,
            ChainBackendError::Protocol("reply lost after submission".into()),
            ChainBackendError::InvalidResponse("malformed reply after submission".into()),
        ] {
            let mut service = service(MockBackend {
                id: SourceId::new("unsupported"),
                endpoint: mock_endpoint(),
                caps: caps(),
                broadcast: Err(ChainBackendError::Unsupported),
                lookup: Err(ChainBackendError::Offline),
            });
            let rejection = ChainBackendError::Rejected("policy".into());
            for (priority, id, result) in [
                (1, "rejected", Err(rejection.clone())),
                (2, "uncertain", Err(error.clone())),
                (
                    3,
                    "later",
                    Ok(BackendObservation {
                        payload: ChainPayload::BroadcastObserved { txid },
                        evidence: Evidence::ServerAssertion,
                        chain_tip: None,
                    }),
                ),
            ] {
                register_backend(
                    &mut service,
                    MockBackend {
                        id: SourceId::new(id),
                        endpoint: mock_endpoint(),
                        caps: caps(),
                        broadcast: result,
                        lookup: Err(ChainBackendError::Offline),
                    },
                    priority,
                );
            }
            let state = BroadcastCoordinator
                .submit(&mut service, vec![1], txid)
                .await;
            assert_eq!(
                state,
                BroadcastState::Uncertain {
                    txid,
                    attempts: vec![
                        AttemptFailure {
                            source: SourceId::new("unsupported"),
                            protocol: ProtocolFamily::Electrum,
                            error: ChainBackendError::Unsupported,
                        },
                        AttemptFailure {
                            source: SourceId::new("rejected"),
                            protocol: ProtocolFamily::Electrum,
                            error: rejection,
                        },
                        AttemptFailure {
                            source: SourceId::new("uncertain"),
                            protocol: ProtocolFamily::Electrum,
                            error,
                        },
                    ],
                }
            );
        }
    }

    #[tokio::test]
    async fn explicit_rejection_is_terminal() {
        let backend = MockBackend {
            id: SourceId::new("a"),
            endpoint: mock_endpoint(),
            caps: caps(),
            broadcast: Err(ChainBackendError::Rejected("policy".into())),
            lookup: Err(ChainBackendError::Offline),
        };
        let state = BroadcastCoordinator
            .submit(&mut service(backend), vec![1], [1; 32])
            .await;
        assert!(state.is_terminal_failure());
    }

    #[tokio::test]
    async fn exact_lookup_promotes_to_observed() {
        let txid = optn_core::header_hash::sha256d(&[1]);
        let backend = MockBackend {
            id: SourceId::new("a"),
            endpoint: mock_endpoint(),
            caps: caps(),
            broadcast: Ok(BackendObservation {
                payload: ChainPayload::BroadcastObserved { txid },
                evidence: Evidence::ServerAssertion,
                chain_tip: None,
            }),
            lookup: Ok(BackendObservation {
                payload: ChainPayload::Transaction(ObservedTransaction {
                    txid,
                    raw: vec![1],
                    block_height: None,
                }),
                evidence: Evidence::MempoolObservation,
                chain_tip: None,
            }),
        };
        let mut service = service(backend);
        let coordinator = BroadcastCoordinator;
        let submitted = coordinator.submit(&mut service, vec![1], txid).await;
        let observed = coordinator.observe(&mut service, submitted).await;
        assert!(matches!(observed, BroadcastState::Observed { .. }));
    }

    #[tokio::test]
    async fn substituted_lookup_bytes_cannot_confirm_a_broadcast() {
        let txid = optn_core::header_hash::sha256d(&[1]);
        let backend = MockBackend {
            id: SourceId::new("substitution"),
            endpoint: mock_endpoint(),
            caps: caps(),
            broadcast: Err(ChainBackendError::Timeout),
            lookup: Ok(BackendObservation {
                payload: ChainPayload::Transaction(ObservedTransaction {
                    txid,
                    raw: vec![2],
                    block_height: None,
                }),
                evidence: Evidence::MempoolObservation,
                chain_tip: None,
            }),
        };
        let mut service = service(backend);
        let submitted = BroadcastCoordinator
            .submit(&mut service, vec![1], txid)
            .await;
        let observed = BroadcastCoordinator.observe(&mut service, submitted).await;
        assert!(matches!(observed, BroadcastState::Uncertain { .. }));
    }
}

#[cfg(test)]
mod node_replies {
    use super::*;

    #[test]
    fn a_node_that_already_has_the_transaction_did_not_reject_it() {
        for message in [
            "transaction already in block chain",
            "txn-already-in-mempool (code 18)",
            "txn-already-known (code 18)",
            "  txn-already-in-mempool (code 18)\n",
        ] {
            assert_eq!(
                classify_node_message(message),
                NodeBroadcastReply::AlreadyHas,
                "{message:?}"
            );
        }
        assert_eq!(
            classify_reject(0x12, ALREADY_IN_MEMPOOL),
            NodeBroadcastReply::AlreadyHas
        );
        assert_eq!(
            classify_reject(0x12, ALREADY_KNOWN),
            NodeBroadcastReply::AlreadyHas
        );
    }

    #[test]
    fn a_conflict_is_a_rejection_though_it_shares_the_code() {
        assert_eq!(
            classify_node_message("txn-mempool-conflict (code 18)"),
            NodeBroadcastReply::Conflict
        );
        assert_eq!(
            classify_reject(0x12, MEMPOOL_CONFLICT),
            NodeBroadcastReply::Conflict
        );
    }

    #[test]
    fn only_exact_wording_counts() {
        for message in [
            "txn-already-in-mempool",
            "txn-already-in-mempool (code 16)",
            "txn-already-in-mempool, extra (code 18)",
            "bad-txns-inputs-missingorspent (code 16)",
            "missing inputs: transaction already in block chain",
            "Missing inputs",
            "",
        ] {
            assert_eq!(
                classify_node_message(message),
                NodeBroadcastReply::Other,
                "{message:?}"
            );
        }
        assert_eq!(
            classify_reject(0x10, ALREADY_IN_MEMPOOL),
            NodeBroadcastReply::Other
        );
        assert_eq!(classify_reject(0x12, "bad"), NodeBroadcastReply::Other);
    }
}
