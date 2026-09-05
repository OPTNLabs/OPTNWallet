//! Bootstrap feed normalization for issue #75.
//!
//! Upstream seed/server lists are discovery hints, not trust anchors. The same
//! endpoint can appear in several projects; deduplication must retain *all*
//! provenance instead of allowing the first feed to erase the others.

use crate::chain::{
    BootstrapProject, CapabilitySet, ChainSource, Endpoint, EndpointKind, SourceDisposition,
    SourceId, SourceOrigin,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct BootstrapProvenance {
    pub project: BootstrapProject,
    pub reference: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapCandidate {
    pub endpoint: Endpoint,
    pub provenance: BTreeSet<BootstrapProvenance>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct EndpointKey {
    kind: u8,
    host: String,
    port: Option<u16>,
}

#[derive(Debug, Clone, Default)]
pub struct BootstrapCatalog {
    candidates: BTreeMap<EndpointKey, BootstrapCandidate>,
}

impl BootstrapCatalog {
    pub fn ingest(
        &mut self,
        mut endpoint: Endpoint,
        project: BootstrapProject,
        reference: impl Into<String>,
    ) {
        endpoint.host = normalize_host(&endpoint.host);
        let key = EndpointKey {
            kind: endpoint_kind_code(endpoint.kind),
            host: endpoint.host.clone(),
            port: endpoint.port,
        };
        let provenance = BootstrapProvenance {
            project,
            reference: reference.into(),
        };
        self.candidates
            .entry(key)
            .and_modify(|candidate| {
                candidate.provenance.insert(provenance.clone());
            })
            .or_insert_with(|| BootstrapCandidate {
                endpoint,
                provenance: BTreeSet::from([provenance]),
            });
    }

    pub fn candidates(&self) -> impl Iterator<Item = &BootstrapCandidate> {
        self.candidates.values()
    }

    pub fn len(&self) -> usize {
        self.candidates.len()
    }

    pub fn is_empty(&self) -> bool {
        self.candidates.is_empty()
    }

    /// Materialize the provider-neutral source used by existing selection code.
    /// The complete multi-feed provenance remains available on this catalog;
    /// `SourceOrigin` receives a deterministic representative only for backward
    /// compatibility with the current source type.
    pub fn materialize_source(
        &self,
        candidate: &BootstrapCandidate,
        priority: u16,
    ) -> ChainSource {
        let representative = candidate
            .provenance
            .iter()
            .next()
            .expect("bootstrap candidate always has provenance");
        let id = SourceId::new(stable_source_id(&candidate.endpoint));
        ChainSource {
            id,
            label: candidate.endpoint.host.clone(),
            origin: SourceOrigin::Bootstrap {
                project: representative.project,
                provenance: representative.reference.clone(),
            },
            endpoints: vec![candidate.endpoint.clone()],
            capabilities: CapabilitySet::default(),
            disposition: SourceDisposition::Enabled,
            priority,
        }
    }

    pub fn provenance_for(&self, endpoint: &Endpoint) -> Option<&BTreeSet<BootstrapProvenance>> {
        let key = EndpointKey {
            kind: endpoint_kind_code(endpoint.kind),
            host: normalize_host(&endpoint.host),
            port: endpoint.port,
        };
        self.candidates.get(&key).map(|candidate| &candidate.provenance)
    }
}

pub fn stable_source_id(endpoint: &Endpoint) -> String {
    let host = normalize_host(&endpoint.host);
    let kind = endpoint_kind_label(endpoint.kind);
    match endpoint.port {
        Some(port) => format!("bootstrap:{kind}:{host}:{port}"),
        None => format!("bootstrap:{kind}:{host}"),
    }
}

fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

const fn endpoint_kind_code(kind: EndpointKind) -> u8 {
    match kind {
        EndpointKind::BchP2p => 0,
        EndpointKind::ElectrumTls => 1,
        EndpointKind::ElectrumTcp => 2,
        EndpointKind::BchnRpc => 3,
        EndpointKind::BchnZmq => 4,
        EndpointKind::ExplorerHttp => 5,
        EndpointKind::ExplorerHttps => 6,
    }
}

const fn endpoint_kind_label(kind: EndpointKind) -> &'static str {
    match kind {
        EndpointKind::BchP2p => "p2p",
        EndpointKind::ElectrumTls => "electrum-tls",
        EndpointKind::ElectrumTcp => "electrum-tcp",
        EndpointKind::BchnRpc => "rpc",
        EndpointKind::BchnZmq => "zmq",
        EndpointKind::ExplorerHttp => "explorer-http",
        EndpointKind::ExplorerHttps => "explorer-https",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn electrum(host: &str) -> Endpoint {
        Endpoint {
            kind: EndpointKind::ElectrumTls,
            host: host.into(),
            port: Some(50002),
        }
    }

    #[test]
    fn same_endpoint_from_multiple_feeds_is_one_candidate_with_all_provenance() {
        let mut catalog = BootstrapCatalog::default();
        catalog.ingest(
            electrum("Example.COM."),
            BootstrapProject::ElectronCash,
            "electroncash/servers.json",
        );
        catalog.ingest(
            electrum("example.com"),
            BootstrapProject::FulcrumPeerNetwork,
            "server.peers.subscribe",
        );

        assert_eq!(catalog.len(), 1);
        let candidate = catalog.candidates().next().unwrap();
        assert_eq!(candidate.endpoint.host, "example.com");
        assert_eq!(candidate.provenance.len(), 2);
    }

    #[test]
    fn different_protocol_endpoints_on_same_host_do_not_collapse() {
        let mut catalog = BootstrapCatalog::default();
        catalog.ingest(
            electrum("example.com"),
            BootstrapProject::ElectronCash,
            "servers",
        );
        catalog.ingest(
            Endpoint {
                kind: EndpointKind::BchP2p,
                host: "example.com".into(),
                port: Some(8333),
            },
            BootstrapProject::Bchn,
            "dns seed",
        );
        assert_eq!(catalog.len(), 2);
    }

    #[test]
    fn materialized_source_does_not_pretend_bootstrap_capabilities_are_verified() {
        let mut catalog = BootstrapCatalog::default();
        let endpoint = electrum("example.com");
        catalog.ingest(
            endpoint.clone(),
            BootstrapProject::ElectronCash,
            "servers",
        );
        let candidate = catalog.candidates().next().unwrap();
        let source = catalog.materialize_source(candidate, 10);
        assert!(source.capabilities.claim(crate::chain::Capability::ElectrumProtocol).is_none());
        assert_eq!(catalog.provenance_for(&endpoint).unwrap().len(), 1);
    }
}
