//! Bootstrap feed normalization for issue #75.
//!
//! Upstream seed/server lists are discovery hints, not trust anchors. The same
//! endpoint can appear in several projects; deduplication must retain *all*
//! provenance instead of allowing the first feed to erase the others.

use crate::chain::{
    BootstrapProject, CapabilitySet, ChainSource, Endpoint, EndpointKind, SourceCatalog,
    SourceDisposition, SourceId, SourceOrigin,
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
    pub fn materialize_source(&self, candidate: &BootstrapCandidate, priority: u16) -> ChainSource {
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
        self.candidates
            .get(&key)
            .map(|candidate| &candidate.provenance)
    }
}

/// The catalog a fresh install starts from.
///
/// Without this the base catalog is empty, and "Auto" has nothing to choose
/// between: the wallet opens, finds no route, and asks its holder to type in a
/// server before it will do anything. That is a reasonable position for a
/// wallet that refuses to guess, and an unreasonable one to ship to someone who
/// just wants to receive a payment.
///
/// Pinned Electron Cash and General Protocols (`electrum-cash/servers`) snapshots
/// supply network-specific TLS endpoints; a host both ship is one candidate
/// credited to both. The DNS seeds of BCHN, Flowee the Hub, bchd and Knuth
/// supply the BCH P2P side the same way (#75 §21.3). A shipped record grants no
/// capability or health evidence; selection and transport policy still decide
/// which candidates may be contacted. Regtest has no public hints.
pub fn shipped_bootstrap_catalog(network: optn_core::network::Network) -> BootstrapCatalog {
    use optn_core::network::Network;

    let (snapshot, filename) = match network {
        Network::Mainnet => (include_str!("bootstrap/servers.json"), "servers.json"),
        Network::Chipnet => (
            include_str!("bootstrap/servers_chipnet.json"),
            "servers_chipnet.json",
        ),
        Network::Testnet3 => (
            include_str!("bootstrap/servers_testnet.json"),
            "servers_testnet.json",
        ),
        Network::Testnet4 => (
            include_str!("bootstrap/servers_testnet4.json"),
            "servers_testnet4.json",
        ),
        Network::Regtest => return BootstrapCatalog::default(),
    };
    let servers: BTreeMap<String, SnapshotServer> = serde_json::from_str(snapshot)
        .expect("reviewed embedded Electron Cash catalog must be valid JSON");
    let provenance = format!("https://github.com/Electron-Cash/Electron-Cash/blob/bb67161b162c1eea2ed2128dc224f7c55532cb8f/electroncash/{filename}");
    let mut catalog = BootstrapCatalog::default();
    ingest_tls_snapshot(
        &mut catalog,
        servers,
        BootstrapProject::ElectronCash,
        &provenance,
    );
    // General Protocols publishes no testnet3 list; its "testnet" is testnet4.
    let electrum_cash = match network {
        Network::Mainnet => Some(("mainnet", "mainnet.ts")),
        Network::Chipnet => Some(("chipnet", "chipnet.ts")),
        Network::Testnet4 => Some(("testnet4", "testnet.ts")),
        Network::Testnet3 | Network::Regtest => None,
    };
    if let Some((key, file)) = electrum_cash {
        let mut networks: BTreeMap<String, BTreeMap<String, SnapshotServer>> =
            serde_json::from_str(include_str!("bootstrap/servers_electrum_cash.json"))
                .expect("reviewed embedded electrum-cash catalog must be valid JSON");
        let servers = networks.remove(key).unwrap_or_default();
        ingest_tls_snapshot(
            &mut catalog,
            servers,
            BootstrapProject::ElectrumCash,
            &format!("https://gitlab.com/electrum-cash/servers/-/blob/36ffc06fa6ccbf98d171bf56a32e93ba3145b132/source/{file}"),
        );
    }
    // Reviewed upstream deployment examples identify separate chains. These are
    // optional candidate-byte services, never chain or token-ownership evidence.
    // Keep stable IDs so replacing the maintained catalog preserves user bans.
    let metadata = match network {
        Network::Mainnet => Some(("bcmr.paytaca.com", ".env.mainnet.example")),
        Network::Chipnet => Some(("bcmr-chipnet.paytaca.com", ".env.chipnet.example")),
        _ => None,
    };
    if let Some((host, deployment)) = metadata {
        catalog.ingest(
            Endpoint { kind: EndpointKind::BcmrIndexerHttps, host: host.into(), port: Some(443) },
            BootstrapProject::Paytaca,
            format!("https://github.com/paytaca/bitcoincash-explorer/blob/fa85e5017b405b0999a0b266c2db797e34ae8386/{deployment}"),
        );
    }
    // IPFS content addressing is network independent, and the runtime checks
    // every byte against this chain's own publication hash, so a gateway is an
    // untrusted transport and more of them only add reachability. One is not
    // enough: public gateways rate-limit, Tor exits most of all, and a registry
    // published only on IPFS is otherwise unreadable while one is refusing.
    if network != Network::Regtest {
        for (host, provenance) in IPFS_GATEWAYS {
            catalog.ingest(
                Endpoint {
                    kind: EndpointKind::IpfsGatewayHttps,
                    host: (*host).into(),
                    port: Some(443),
                },
                BootstrapProject::Ipfs,
                *provenance,
            );
        }
    }
    ingest_p2p_seeds(&mut catalog, network);
    catalog
}

/// The reviewed DNS seed snapshot (`bootstrap/p2p_seeds.json`): each node
/// implementation's seeds per network, as the source it pins lists them, and
/// each network's P2P port, on which all four agree.
#[derive(serde::Deserialize)]
struct SeedSnapshot {
    ports: BTreeMap<String, u16>,
    projects: Vec<SeedProject>,
}

#[derive(serde::Deserialize)]
struct SeedProject {
    project: String,
    source: String,
    seeds: BTreeMap<String, Vec<String>>,
}

/// The node implementations' DNS seeds, as `BchDnsSeed` candidates. A seed
/// several of them list is one candidate credited to each.
fn ingest_p2p_seeds(catalog: &mut BootstrapCatalog, network: optn_core::network::Network) {
    let snapshot: SeedSnapshot = serde_json::from_str(include_str!("bootstrap/p2p_seeds.json"))
        .expect("reviewed embedded DNS seed list must be valid JSON");
    // Regtest is a private chain: no seeds, and no port entry either.
    let Some(&port) = snapshot.ports.get(network.as_str()) else {
        return;
    };
    for project in &snapshot.projects {
        let id = match project.project.as_str() {
            "bchn" => BootstrapProject::Bchn,
            "flowee" => BootstrapProject::FloweeTheHub,
            "bchd" => BootstrapProject::Bchd,
            "knuth" => BootstrapProject::Knuth,
            other => panic!("reviewed DNS seed list names an unknown project {other:?}"),
        };
        for host in project.seeds.get(network.as_str()).into_iter().flatten() {
            catalog.ingest(
                Endpoint {
                    kind: EndpointKind::BchDnsSeed,
                    host: host.clone(),
                    port: Some(port),
                },
                id,
                project.source.as_str(),
            );
        }
    }
}

/// Path-style gateways that answered `/ipfs/<cid>` with the exact committed
/// bytes when reviewed (2026-10-08). Subdomain-redirecting gateways are left
/// out: the registry fetcher stays on the origin it was given.
const IPFS_GATEWAYS: &[(&str, &str)] = &[
    (
        "ipfs.optnlabs.com",
        "OPTN Labs gateway, the legacy app's first default (src/utils/servers/InfraUrls.ts)",
    ),
    (
        "ipfs.io",
        "https://docs.ipfs.tech/concepts/public-utilities/",
    ),
    (
        "ipfs.filebase.io",
        "https://docs.filebase.com/ipfs-concepts/what-is-an-ipfs-gateway",
    ),
    (
        "gateway.pinata.cloud",
        "https://docs.pinata.cloud/gateways/retrieving-files",
    ),
];

/// One host entry in a pinned Electrum server snapshot. Only the TLS port is
/// read; plain-TCP (`t`) entries are not enabled by this loader.
#[derive(serde::Deserialize)]
struct SnapshotServer {
    s: Option<String>,
}

fn ingest_tls_snapshot(
    catalog: &mut BootstrapCatalog,
    servers: BTreeMap<String, SnapshotServer>,
    project: BootstrapProject,
    provenance: &str,
) {
    for (host, server) in servers {
        let Some(port) = server.s else { continue };
        let port: u16 = port.parse().expect("reviewed TLS port must fit u16");
        assert_ne!(port, 0, "reviewed TLS port must be nonzero");
        catalog.ingest(
            Endpoint {
                kind: EndpointKind::ElectrumTls,
                host,
                port: Some(port),
            },
            project,
            provenance,
        );
    }
}

/// At most this many discovered servers are kept per network, and as many
/// discovered BCH P2P nodes besides.
pub const MAX_DISCOVERED_PEERS: usize = 32;

/// A source found at run time rather than shipped (#75 §21.3): an Electrum
/// server another server advertised in `server.peers.subscribe`, or a BCH P2P
/// node a DNS seed named. A hint like any bootstrap entry, never a trust anchor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredPeer {
    pub endpoint: Endpoint,
    /// The source whose peer list, or the seed whose answer, named it.
    pub advertised_by: SourceId,
}

/// Whether a source was discovered at run time rather than shipped.
pub fn is_discovered(source: &ChainSource) -> bool {
    matches!(
        source.origin,
        SourceOrigin::Bootstrap {
            project: BootstrapProject::FulcrumPeerNetwork | BootstrapProject::BchPeerNetwork,
            ..
        }
    )
}

/// The catalog entry for a discovered peer, or `None` for one that cannot be
/// one: an Electrum server is named by host, a P2P node only by IP address.
/// A name would be another seed, reaching whichever node it resolved to, and
/// so not one node a holder could disable or ban.
///
/// Used both for peers read back from the cache and for nodes a seed names
/// while a stack is built, so an entry has one ID and origin however it came.
pub fn discovered_source(peer: &DiscoveredPeer, priority: u16) -> Option<ChainSource> {
    let mut endpoint = peer.endpoint.clone();
    let (project, provenance) = match endpoint.kind {
        EndpointKind::ElectrumTls | EndpointKind::ElectrumTcp => {
            endpoint.host = normalize_host(&endpoint.host);
            (
                BootstrapProject::FulcrumPeerNetwork,
                format!("advertised by {}", peer.advertised_by.as_str()),
            )
        }
        EndpointKind::BchP2p => {
            let address: std::net::IpAddr = endpoint.host.trim().parse().ok()?;
            // One spelling per address, so one node is one ID.
            endpoint.host = match address {
                std::net::IpAddr::V6(v6) => v6
                    .to_ipv4_mapped()
                    .map_or_else(|| v6.to_string(), |v4| v4.to_string()),
                std::net::IpAddr::V4(v4) => v4.to_string(),
            };
            (
                BootstrapProject::BchPeerNetwork,
                format!("named by {}", peer.advertised_by.as_str()),
            )
        }
        _ => return None,
    };
    if endpoint.host.is_empty() || endpoint.port.is_none_or(|port| port == 0) {
        return None;
    }
    Some(ChainSource {
        id: SourceId::new(stable_source_id(&endpoint)),
        label: endpoint.host.clone(),
        origin: SourceOrigin::Bootstrap {
            project,
            provenance,
        },
        endpoints: vec![endpoint],
        capabilities: CapabilitySet::default(),
        disposition: SourceDisposition::Enabled,
        priority,
    })
}

/// The catalog plus servers and nodes discovered at run time, ranked after
/// every source already in it.
///
/// A discovered source is a bootstrap candidate: public, so only the scopes
/// that admit public sources select it; never removable, only disabled or
/// banned through the same overrides, which stay keyed by its stable ID; and
/// gone again once nothing names it. One already in the catalog keeps its
/// entry and its place. At most [`MAX_DISCOVERED_PEERS`] servers are added,
/// and as many P2P nodes.
pub fn with_discovered_peers(
    mut catalog: SourceCatalog,
    peers: &[DiscoveredPeer],
) -> SourceCatalog {
    let mut priority = catalog
        .iter()
        .map(|source| source.priority)
        .max()
        .map_or(0, |last| last.saturating_add(1));
    let (mut servers, mut nodes) = (0, 0);
    for peer in peers {
        let Some(source) = discovered_source(peer, priority) else {
            continue;
        };
        let added = if peer.endpoint.kind == EndpointKind::BchP2p {
            &mut nodes
        } else {
            &mut servers
        };
        if *added >= MAX_DISCOVERED_PEERS || is_listed(&catalog, &source) {
            continue;
        }
        if catalog.insert(source).is_ok() {
            *added += 1;
            priority = priority.saturating_add(1);
        }
    }
    catalog
}

/// Whether `catalog` already holds `source`, by ID or by endpoint.
pub fn is_listed(catalog: &SourceCatalog, source: &ChainSource) -> bool {
    catalog.get(&source.id).is_some()
        || catalog.iter().any(|existing| {
            existing.endpoints.iter().any(|endpoint| {
                source.endpoints.iter().any(|candidate| {
                    endpoint.kind == candidate.kind
                        && endpoint.port == candidate.port
                        && normalize_host(&endpoint.host) == normalize_host(&candidate.host)
                })
            })
        })
}

/// A persisted selection over the shipped catalog plus discovered servers.
///
/// Discovered servers join the base before the holder's overrides apply, so a
/// disable or ban recorded for one holds wherever it reappears. Without an
/// envelope the shipped default policy applies.
pub fn resolve_with_discovered(
    network: optn_core::network::Network,
    envelope: Option<&crate::network_config::NetworkConfigEnvelope>,
    peers: &[DiscoveredPeer],
) -> Result<
    (SourceCatalog, crate::chain::ConnectionPolicy),
    crate::network_config::NetworkConfigError,
> {
    let base = with_discovered_peers(shipped_source_catalog(network), peers);
    match envelope {
        Some(envelope) => crate::network_config::resolve_chain_selection(&base, envelope),
        None => Ok((base, crate::chain::ConnectionPolicy::auto())),
    }
}

/// The same unverified discovery candidates for every native interface.
/// Materialization performs no network I/O and never persists defaults as intent.
pub fn shipped_source_catalog(network: optn_core::network::Network) -> SourceCatalog {
    let bootstrap = shipped_bootstrap_catalog(network);
    let mut catalog = SourceCatalog::default();
    for (priority, candidate) in bootstrap.candidates().enumerate() {
        catalog
            .insert(bootstrap.materialize_source(candidate, priority as u16))
            .expect("shipped source ids are unique");
    }
    catalog
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
        EndpointKind::IpfsGatewayHttps => 7,
        EndpointKind::BcmrIndexerHttps => 8,
        EndpointKind::BchDnsSeed => 9,
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
        EndpointKind::IpfsGatewayHttps => "ipfs-gateway",
        EndpointKind::BcmrIndexerHttps => "bcmr-indexer",
        EndpointKind::BchDnsSeed => "p2p-seed",
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
    fn discovered_servers_rank_last_and_never_displace_a_shipped_one() {
        use crate::chain::{build_selection_plan, ConnectionPolicy};
        let network = optn_core::network::Network::Mainnet;
        let shipped = shipped_source_catalog(network);
        let shipped_last = shipped.iter().map(|source| source.priority).max().unwrap();
        let existing = shipped.iter().next().unwrap().endpoints[0].clone();
        let advertiser = SourceId::new("bootstrap:electrum-tls:advertiser.example:50002");
        let peer = |endpoint: Endpoint| DiscoveredPeer {
            endpoint,
            advertised_by: advertiser.clone(),
        };
        let mut new = electrum("New.Example.org.");
        new.port = Some(50002);
        let catalog = with_discovered_peers(
            shipped.clone(),
            &[
                peer(existing.clone()),
                peer(new.clone()),
                peer(new.clone()),
                peer(Endpoint {
                    kind: EndpointKind::BchP2p,
                    host: "p2p.example.org".into(),
                    port: Some(8333),
                }),
            ],
        );
        // One new entry: the shipped host keeps its own, the duplicate and
        // the P2P endpoint named by host rather than address are dropped.
        assert_eq!(catalog.iter().count(), shipped.iter().count() + 1);
        let id = SourceId::new("bootstrap:electrum-tls:new.example.org:50002");
        let discovered = catalog.get(&id).unwrap();
        assert!(is_discovered(discovered));
        assert!(discovered.is_public() && !discovered.can_remove());
        assert_eq!(discovered.priority, shipped_last + 1);
        assert!(!is_discovered(
            catalog.get(&shipped.iter().next().unwrap().id).unwrap()
        ));

        // Public scopes reach it after every shipped source; own-only never.
        let plan = build_selection_plan(&catalog, &ConnectionPolicy::auto());
        assert_eq!(plan.primary.last(), Some(&id));
        let own = build_selection_plan(&catalog, &ConnectionPolicy::own_infrastructure());
        assert!(!own.primary.contains(&id) && !own.fallback.contains(&id));

        // A server the holder added themselves is not added twice.
        let mut mine = SourceCatalog::default();
        mine.insert(ChainSource {
            id: SourceId::new("host:new.example.org"),
            label: "Mine".into(),
            origin: SourceOrigin::UserAdded,
            endpoints: vec![new.clone()],
            capabilities: CapabilitySet::default(),
            disposition: SourceDisposition::Enabled,
            priority: 0,
        })
        .unwrap();
        assert_eq!(
            with_discovered_peers(mine, &[peer(new.clone())])
                .iter()
                .count(),
            1
        );

        // The holder's ban applies to a discovered server like any other.
        let mut overlay = crate::network_config::UserNetworkOverlay::default();
        overlay
            .bootstrap_overrides
            .insert(id.clone(), SourceDisposition::Banned);
        let envelope = crate::network_config::NetworkConfigEnvelope::current(
            crate::network_config::SHIPPED_CATALOG_VERSION,
            overlay,
        );
        let (banned, _) =
            resolve_with_discovered(network, Some(&envelope), &[peer(new.clone())]).unwrap();
        assert_eq!(
            banned.get(&id).unwrap().disposition,
            SourceDisposition::Banned
        );
        let (fresh, policy) = resolve_with_discovered(network, None, &[peer(new.clone())]).unwrap();
        assert!(fresh.get(&id).unwrap().is_enabled());
        assert_eq!(policy, ConnectionPolicy::auto());

        // Bounded.
        let many: Vec<_> = (0..40)
            .map(|index| peer(electrum(&format!("peer{index}.example.org"))))
            .collect();
        let bounded = with_discovered_peers(SourceCatalog::default(), &many);
        assert_eq!(bounded.iter().count(), MAX_DISCOVERED_PEERS);
    }

    /// A node a seed named is listed by its address, so one entry is one node
    /// whatever spelling found it, and kept apart from the servers' bound.
    #[test]
    fn a_seed_named_node_is_a_discovered_p2p_source_by_address_only() {
        use crate::chain::{build_selection_plan, ConnectionPolicy, ProtocolFamily, ProtocolSet};
        let seed = SourceId::new("bootstrap:p2p-seed:seed.example.org:8333");
        let node = |host: &str| DiscoveredPeer {
            endpoint: Endpoint {
                kind: EndpointKind::BchP2p,
                host: host.into(),
                port: Some(8333),
            },
            advertised_by: seed.clone(),
        };
        let catalog = with_discovered_peers(
            SourceCatalog::default(),
            &[
                node("203.0.113.7"),
                // The same address written as IPv4-mapped IPv6.
                node("::ffff:203.0.113.7"),
                node("2001:DB8:0:0::1"),
                // A name is a seed of its own, not a node.
                node("node.example.org"),
            ],
        );
        assert_eq!(catalog.iter().count(), 2);
        let v4 = catalog
            .get(&SourceId::new("bootstrap:p2p:203.0.113.7:8333"))
            .expect("one ID per address");
        assert!(is_discovered(v4) && v4.is_public() && !v4.can_remove());
        assert!(matches!(
            &v4.origin,
            SourceOrigin::Bootstrap { project: BootstrapProject::BchPeerNetwork, provenance }
                if provenance == "named by bootstrap:p2p-seed:seed.example.org:8333"
        ));
        assert!(catalog
            .get(&SourceId::new("bootstrap:p2p:2001:db8::1:8333"))
            .is_some());

        // Selected where P2P and public sources are; never as own infrastructure.
        let mut privacy = ConnectionPolicy::auto();
        privacy.protocols = ProtocolSet::only(ProtocolFamily::Bip37);
        privacy.protocols.insert(ProtocolFamily::Neutrino);
        assert!(build_selection_plan(&catalog, &privacy)
            .primary
            .contains(&v4.id));
        let own = build_selection_plan(&catalog, &ConnectionPolicy::own_infrastructure());
        assert!(own.primary.is_empty() && own.fallback.is_empty());

        // Servers and nodes are bounded apart: many of one never crowd out the other.
        let mut many: Vec<_> = (0..40)
            .map(|index| node(&format!("203.0.113.{index}")))
            .collect();
        many.extend((0..40).map(|index| DiscoveredPeer {
            endpoint: electrum(&format!("peer{index}.example.org")),
            advertised_by: seed.clone(),
        }));
        let bounded = with_discovered_peers(SourceCatalog::default(), &many);
        let nodes = bounded
            .iter()
            .filter(|source| source.endpoints[0].kind == EndpointKind::BchP2p)
            .count();
        assert_eq!(nodes, MAX_DISCOVERED_PEERS);
        assert_eq!(bounded.iter().count(), 2 * MAX_DISCOVERED_PEERS);
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
        catalog.ingest(endpoint.clone(), BootstrapProject::ElectronCash, "servers");
        let candidate = catalog.candidates().next().unwrap();
        let source = catalog.materialize_source(candidate, 10);
        assert!(source
            .capabilities
            .claim(crate::chain::Capability::ElectrumProtocol)
            .is_none());
        assert_eq!(catalog.provenance_for(&endpoint).unwrap().len(), 1);
    }
}

#[cfg(test)]
mod shipped {
    use super::*;
    use optn_core::network::Network;

    /// A fresh install has somewhere to start.
    ///
    /// An empty base catalog is what makes "Auto" ask its holder to type in a
    /// server before the wallet will do anything.
    #[test]
    fn the_production_networks_ship_a_starting_point() {
        for network in [
            Network::Mainnet,
            Network::Chipnet,
            Network::Testnet3,
            Network::Testnet4,
        ] {
            let catalog = shipped_bootstrap_catalog(network);
            assert!(
                !catalog.is_empty(),
                "{network} ships no bootstrap candidates, so Auto has nothing to select"
            );
            for candidate in catalog.candidates() {
                assert!(candidate.endpoint.port.is_some_and(|port| port > 0));
                assert!(
                    !candidate.provenance.is_empty(),
                    "a bootstrap entry without provenance cannot be refreshed or audited"
                );
            }
        }
    }

    #[test]
    fn chipnet_snapshot_retains_network_specific_ports_and_existing_ids() {
        let catalog = shipped_source_catalog(Network::Chipnet);
        assert_eq!(
            catalog
                .iter()
                .filter(|source| source
                    .endpoints
                    .iter()
                    .any(|endpoint| endpoint.kind == EndpointKind::ElectrumTls))
                .count(),
            5
        );
        let expected = [
            ("chipnet.imaginary.cash", 50002),
            ("chipnet.bch.ninja", 50002),
            ("blackie.c3-soft.com", 64002),
            ("chipnet.c3-soft.com", 64002),
            ("cbch.loping.net", 62102),
        ];
        for (host, port) in expected {
            let id = SourceId::new(format!("bootstrap:electrum-tls:{host}:{port}"));
            let source = catalog.get(&id).expect("stable bootstrap ID");
            assert_eq!(source.endpoints[0].port, Some(port));
            assert!(source.capabilities.iter().next().is_none());
            assert!(
                matches!(&source.origin, SourceOrigin::Bootstrap { provenance, .. } if provenance.contains("bb67161b"))
            );
        }
    }

    /// General Protocols' list adds the hosts Electron Cash lacks and is credited
    /// on the ones both ship, without displacing Electron Cash as their origin.
    #[test]
    fn electrum_cash_list_adds_missing_hosts_and_shares_the_rest() {
        let projects = |network, host: &str| -> BTreeSet<BootstrapProject> {
            let endpoint = Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: host.into(),
                port: Some(50002),
            };
            shipped_bootstrap_catalog(network)
                .provenance_for(&endpoint)
                .unwrap_or_else(|| panic!("{host} is not shipped for {network}"))
                .iter()
                .map(|provenance| provenance.project)
                .collect()
        };
        let only_electrum_cash = BTreeSet::from([BootstrapProject::ElectrumCash]);
        let both = BTreeSet::from([
            BootstrapProject::ElectronCash,
            BootstrapProject::ElectrumCash,
        ]);

        assert_eq!(
            projects(Network::Testnet4, "testnet4.imaginary.cash"),
            only_electrum_cash
        );
        assert_eq!(
            projects(Network::Mainnet, "fulcrum.greyh.at"),
            only_electrum_cash
        );
        assert_eq!(projects(Network::Chipnet, "chipnet.imaginary.cash"), both);
        assert_eq!(projects(Network::Mainnet, "bch.imaginary.cash"), both);

        let shared = shipped_source_catalog(Network::Chipnet);
        let source = shared
            .get(&SourceId::new(
                "bootstrap:electrum-tls:chipnet.bch.ninja:50002",
            ))
            .expect("stable bootstrap ID");
        assert!(matches!(
            &source.origin,
            SourceOrigin::Bootstrap {
                project: BootstrapProject::ElectronCash,
                ..
            }
        ));

        assert!(shipped_bootstrap_catalog(Network::Testnet3)
            .candidates()
            .all(|candidate| candidate
                .provenance
                .iter()
                .all(|provenance| provenance.project != BootstrapProject::ElectrumCash)));
    }

    /// #75 §21.3: the BCH P2P side starts from the DNS seeds of BCHN, Flowee
    /// the Hub, bchd and Knuth, each seed one candidate credited to every
    /// project that lists it.
    #[test]
    fn the_node_implementations_dns_seeds_ship_with_merged_provenance() {
        use BootstrapProject::{Bchd, Bchn, FloweeTheHub, Knuth};
        let seed = |network, host: &str| -> BTreeSet<BootstrapProject> {
            let port = match network {
                Network::Mainnet => 8333,
                Network::Testnet3 => 18333,
                Network::Testnet4 => 28333,
                Network::Chipnet => 48333,
                Network::Regtest => unreachable!(),
            };
            shipped_bootstrap_catalog(network)
                .provenance_for(&Endpoint {
                    kind: EndpointKind::BchDnsSeed,
                    host: host.into(),
                    port: Some(port),
                })
                .unwrap_or_else(|| panic!("{host} is not a {network} seed"))
                .iter()
                .map(|provenance| provenance.project)
                .collect()
        };
        assert_eq!(
            seed(Network::Mainnet, "seed.bchd.cash"),
            BTreeSet::from([Bchn, FloweeTheHub, Bchd, Knuth])
        );
        assert_eq!(
            seed(Network::Mainnet, "seed.flowee.cash"),
            BTreeSet::from([Bchn, FloweeTheHub, Knuth])
        );
        assert_eq!(
            seed(Network::Mainnet, "dnsseed.electroncash.de"),
            BTreeSet::from([Knuth])
        );
        assert_eq!(
            seed(Network::Testnet3, "testnet-seed-bch.bitcoinforks.org"),
            BTreeSet::from([FloweeTheHub, Bchd])
        );
        assert_eq!(
            seed(Network::Testnet4, "testnet4.imaginary.cash"),
            BTreeSet::from([Bchd])
        );
        assert_eq!(
            seed(Network::Chipnet, "chipnet.bitjson.com"),
            BTreeSet::from([Bchn, FloweeTheHub, Bchd, Knuth])
        );
        for (network, distinct) in [
            (Network::Mainnet, 8),
            (Network::Testnet3, 4),
            (Network::Testnet4, 6),
            (Network::Chipnet, 4),
            (Network::Regtest, 0),
        ] {
            let seeds: Vec<_> = shipped_bootstrap_catalog(network)
                .candidates()
                .filter(|candidate| candidate.endpoint.kind == EndpointKind::BchDnsSeed)
                .map(|candidate| candidate.provenance.clone())
                .collect();
            assert_eq!(seeds.len(), distinct, "{network}");
            // Each credit points at the exact upstream file it was read from.
            for provenance in seeds.iter().flatten() {
                assert!(
                    [
                        "abd433abe04f74780744b9eac06731f3690ce68a",
                        "69efc094a72dcc6733aaff55e088f27ebf77bad5",
                        "cd36a6472f8ca7a5319439b8e9a81bba5c4023e5",
                        "875fe334b8c28db706b1e60285092bbde39ea664",
                    ]
                    .iter()
                    .any(|commit| provenance.reference.contains(commit)),
                    "{provenance:?}"
                );
            }
        }
    }

    /// A seed is selected as a discovery source, by scope and disposition like
    /// any entry, but never as a route: it carries no protocol.
    #[test]
    fn a_shipped_seed_is_never_a_route_and_ranks_after_the_servers() {
        use crate::chain::{build_endpoint_selection_plan, build_selection_plan, ConnectionPolicy};
        let catalog = shipped_source_catalog(Network::Mainnet);
        let id = SourceId::new("bootstrap:p2p-seed:seed.bchd.cash:8333");
        let seed = catalog.get(&id).expect("stable seed ID");
        assert!(matches!(
            seed.origin,
            SourceOrigin::Bootstrap {
                project: BootstrapProject::Bchn,
                ..
            }
        ));
        assert!(!is_discovered(seed));
        let auto = ConnectionPolicy::auto();
        let routes = build_selection_plan(&catalog, &auto);
        assert!(!routes.primary.contains(&id) && !routes.fallback.contains(&id));
        assert!(
            build_endpoint_selection_plan(&catalog, &auto, EndpointKind::BchDnsSeed)
                .primary
                .contains(&id)
        );
        assert!(build_endpoint_selection_plan(
            &catalog,
            &ConnectionPolicy::own_infrastructure(),
            EndpointKind::BchDnsSeed
        )
        .primary
        .is_empty());
        // Wallet operations still go to the servers first.
        let last_server = catalog
            .iter()
            .filter(|source| source.endpoints[0].kind == EndpointKind::ElectrumTls)
            .map(|source| source.priority)
            .max()
            .unwrap();
        assert!(catalog
            .iter()
            .filter(|source| source.endpoints[0].kind == EndpointKind::BchDnsSeed)
            .all(|source| source.priority > last_server));
    }

    /// Mainnet and chipnet do not share a starting point.
    #[test]
    fn each_network_starts_somewhere_of_its_own() {
        let mainnet: Vec<_> = shipped_bootstrap_catalog(Network::Mainnet)
            .candidates()
            .map(|candidate| candidate.endpoint.host.clone())
            .collect();
        let chipnet: Vec<_> = shipped_bootstrap_catalog(Network::Chipnet)
            .candidates()
            .map(|candidate| candidate.endpoint.host.clone())
            .collect();
        assert_ne!(mainnet, chipnet);
    }

    /// A regtest build is one the operator started. Pointing it at somebody
    /// else's infrastructure would be pointing a private chain at a public one.
    #[test]
    fn regtest_ships_no_discovery_hints() {
        assert!(shipped_bootstrap_catalog(Network::Regtest).is_empty());
    }

    #[test]
    fn metadata_bootstrap_is_network_scoped_unverified_and_keeps_bans_on_refresh() {
        use crate::network_config::{set_source_disposition, UserNetworkOverlay};
        for (network, expected) in [
            (Network::Mainnet, "bcmr.paytaca.com"),
            (Network::Chipnet, "bcmr-chipnet.paytaca.com"),
        ] {
            let base = shipped_source_catalog(network);
            let metadata: Vec<_> = base
                .iter()
                .filter(|source| source.endpoints[0].kind == EndpointKind::BcmrIndexerHttps)
                .collect();
            assert_eq!(metadata.len(), 1);
            assert_eq!(metadata[0].endpoints[0].host, expected);
            assert!(metadata[0].capabilities.iter().next().is_none());
            assert!(matches!(
                metadata[0].origin,
                SourceOrigin::Bootstrap {
                    project: BootstrapProject::Paytaca,
                    ..
                }
            ));
            let mut overlay = UserNetworkOverlay::default();
            set_source_disposition(&mut overlay, &metadata[0].id, SourceDisposition::Banned)
                .unwrap();
            let refreshed = crate::network_config::merge_bootstrap_with_user_overlay(
                &shipped_source_catalog(network),
                &crate::network_config::NetworkConfigEnvelope::current("metadata-v1", overlay),
            )
            .unwrap();
            assert_eq!(
                refreshed.get(&metadata[0].id).unwrap().disposition,
                SourceDisposition::Banned
            );
            assert_eq!(
                base.iter()
                    .filter(|source| source.endpoints[0].kind == EndpointKind::IpfsGatewayHttps)
                    .count(),
                IPFS_GATEWAYS.len()
            );
        }
        for network in [Network::Testnet3, Network::Testnet4, Network::Regtest] {
            assert!(shipped_source_catalog(network)
                .iter()
                .all(|source| source.endpoints[0].kind != EndpointKind::BcmrIndexerHttps));
        }
    }

    /// Content addressing does not depend on the chain, so every network but
    /// regtest can read an IPFS-published registry -- through more than one
    /// gateway, each an unverified hint like any other shipped entry.
    #[test]
    fn ipfs_gateways_ship_on_every_public_network_as_unverified_hints() {
        for network in [
            Network::Mainnet,
            Network::Chipnet,
            Network::Testnet3,
            Network::Testnet4,
        ] {
            let catalog = shipped_source_catalog(network);
            let gateways: Vec<_> = catalog
                .iter()
                .filter(|source| source.endpoints[0].kind == EndpointKind::IpfsGatewayHttps)
                .collect();
            assert_eq!(gateways.len(), IPFS_GATEWAYS.len(), "{network:?}");
            for gateway in &gateways {
                assert_eq!(gateway.endpoints[0].port, Some(443));
                assert!(gateway.capabilities.iter().next().is_none());
                assert!(matches!(
                    gateway.origin,
                    SourceOrigin::Bootstrap {
                        project: BootstrapProject::Ipfs,
                        ..
                    }
                ));
            }
        }
        assert!(shipped_source_catalog(Network::Regtest)
            .iter()
            .all(|source| source.endpoints[0].kind != EndpointKind::IpfsGatewayHttps));
    }

    /// Shipped entries are hints, not trust. They arrive enabled and unprobed.
    #[test]
    fn a_shipped_entry_earns_no_capabilities_from_being_shipped() {
        let catalog = shipped_bootstrap_catalog(Network::Mainnet);
        let candidate = catalog.candidates().next().expect("a candidate");
        let source = catalog.materialize_source(candidate, 0);
        assert_eq!(source.disposition, SourceDisposition::Enabled);
        assert!(
            source.capabilities.iter().next().is_none(),
            "a bootstrap entry must prove its capabilities by probing, not by shipping"
        );
        assert!(matches!(source.origin, SourceOrigin::Bootstrap { .. }));
    }
}
