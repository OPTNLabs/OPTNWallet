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

#[derive(Default)]
pub struct BroadcastCoordinator;

impl BroadcastCoordinator {
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
        let id = backend.id.clone();
        let mut catalog = SourceCatalog::default();
        catalog
            .insert(ChainSource {
                id: id.clone(),
                label: "server".into(),
                origin: SourceOrigin::UserAdded,
                endpoints: vec![backend.endpoint.clone()],
                capabilities: CapabilitySet::default(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            })
            .unwrap();
        let mut service = ChainService::new(catalog, ConnectionPolicy::auto());
        service.register(Arc::new(backend));
        service
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
        let txid = [9; 32];
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
}
