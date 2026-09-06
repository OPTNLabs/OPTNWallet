//! Progressive wallet synchronization over capability routes.
//!
//! A timeout/partial provider never becomes an empty authoritative wallet. The
//! worker keeps the last reconciled snapshot and may retry another allowed
//! route. Route-local prerequisites (BIP37/Neutrino header cursors) stay on the
//! same endpoint via `ChainService::execute_on_route`.

use crate::chain::{ProtocolFamily, SourceId};
use crate::chain_service::{
    CapabilityRoute, ChainOperation, ChainPayload, ChainRequest, ChainService, ChainServiceError,
    ChainTip, ObservedTransaction, WalletInterest,
};
use crate::reconciliation::{ReconciliationDecision, ReconciliationState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletNetworkSnapshot {
    pub transactions: Vec<ObservedTransaction>,
    pub tip: Option<ChainTip>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgressiveSyncConfig {
    /// First header after the locally trusted/persisted cursor. Fresh BIP37
    /// providers currently seed height 0 (genesis), so the cold-start default is 1.
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
    Chain(ChainServiceError),
    UnexpectedPayload,
    Exhausted,
}

pub struct ProgressiveSyncWorker {
    config: ProgressiveSyncConfig,
    reconciliation: ReconciliationState<WalletNetworkSnapshot>,
}

impl ProgressiveSyncWorker {
    pub fn new(config: ProgressiveSyncConfig) -> Self {
        Self {
            config,
            reconciliation: ReconciliationState::default(),
        }
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

    pub async fn refresh(
        &mut self,
        service: &mut ChainService,
        interests: Vec<WalletInterest>,
        from_height: Option<u32>,
    ) -> Result<SyncOutcome, ProgressiveSyncError> {
        let routes = service.routes_for_operation(ChainOperation::WalletRefresh);
        if routes.is_empty() {
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
                    let snapshot = WalletNetworkSnapshot { transactions, tip };
                    let decision = self.reconciliation.reconcile_candidate(
                        snapshot,
                        observation.source,
                        observation.evidence,
                        observation.chain_tip,
                        true,
                    );
                    return Ok(SyncOutcome { route, decision });
                }
                Err(error) => {
                    self.reconciliation
                        .record_failure(format!("wallet refresh failed: {error:?}"));
                }
            }
        }
        Err(ProgressiveSyncError::Exhausted)
    }

    async fn prime_headers_on_same_route(
        &mut self,
        service: &mut ChainService,
        wallet_route: &CapabilityRoute,
    ) -> Result<(), ProgressiveSyncError> {
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

        let mut start = self.config.header_start_height.max(1);
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
            if headers.is_empty() {
                return Ok(());
            }
            let returned = u32::try_from(headers.len())
                .map_err(|_| ProgressiveSyncError::HeaderSafetyLimit)?;
            start = start_height
                .checked_add(returned)
                .ok_or(ProgressiveSyncError::HeaderSafetyLimit)?;
            if returned < self.config.header_batch_size.max(1) {
                return Ok(());
            }
        }
        Err(ProgressiveSyncError::HeaderSafetyLimit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
    }
    impl ChainBackend for WalletBackend {
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
        fn supports(&self, op: ChainOperation) -> bool {
            matches!(op, ChainOperation::WalletRefresh)
        }
        fn execute<'a>(&'a self, _: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
            Box::pin(async move {
                Ok(BackendObservation {
                    payload: ChainPayload::WalletRefresh {
                        transactions: vec![],
                        tip: Some(ChainTip {
                            height: 7,
                            hash: [7; 32],
                        }),
                    },
                    evidence: Evidence::ServerAssertion,
                    chain_tip: Some((7, [7; 32])),
                })
            })
        }
    }

    #[tokio::test]
    async fn successful_refresh_reconciles_snapshot() {
        let id = SourceId::new("server");
        let endpoint = Endpoint {
            kind: EndpointKind::ElectrumTcp,
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
        let mut service = ChainService::new(catalog, ConnectionPolicy::auto());
        service.register(Arc::new(WalletBackend { id, endpoint, caps }));
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
    }
}
