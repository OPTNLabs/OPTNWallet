//! Electrum servers and BCH P2P nodes discovered at run time, cached per
//! network (#75 §21.3).
//!
//! A cache, not user intent. It lives beside the network settings rather than
//! in them, so recording a peer is never a settings edit: it revokes no routes,
//! asks for no rebuild, and never travels in a portable backup. Disabling or
//! banning one of these servers *is* intent, and lives in the settings overlay
//! keyed by the server's stable ID. The cache keeps every entry the holder set
//! a disposition for, however long since anything named it, so that
//! disposition always has its entry to apply to: a node a seed names again
//! mid-build is dialled only when the catalog does not already hold it.

use crate::network_config::{lock_file, read_bounded, write_atomically};
use optn_core::network::Network;
use optn_runtime::bootstrap::{stable_source_id, DiscoveredPeer, MAX_DISCOVERED_PEERS};
use optn_runtime::chain::{Endpoint, EndpointKind, SourceId};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::net::IpAddr;
use std::path::PathBuf;

const MAX_BYTES: u64 = 64 * 1024;
const VERSION: u32 = 1;
/// A peer nothing has named for this long is forgotten.
const FORGET_AFTER_SECS: u64 = 30 * 24 * 60 * 60;
/// Seeing a known server again refreshes its date at most this often, so an
/// ordinary reconnect does not rewrite the file.
const REFRESH_AFTER_SECS: u64 = 24 * 60 * 60;
/// Entries kept for the holder's dispositions, beyond the bounds above. Set
/// by hand, one at a time, so far fewer than this in practice.
const MAX_KEPT: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum StoredKind {
    ElectrumTls,
    ElectrumTcp,
    /// A BCH P2P node, by IP address.
    P2p,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StoredPeer {
    kind: StoredKind,
    host: String,
    port: u16,
    advertised_by: String,
    last_seen: u64,
}

impl StoredPeer {
    fn from_peer(peer: &DiscoveredPeer, now_unix: u64) -> Option<Self> {
        let port = peer.endpoint.port.filter(|port| *port != 0)?;
        let host = peer
            .endpoint
            .host
            .trim()
            .trim_end_matches('.')
            .to_ascii_lowercase();
        let kind = match peer.endpoint.kind {
            EndpointKind::ElectrumTls => StoredKind::ElectrumTls,
            EndpointKind::ElectrumTcp => StoredKind::ElectrumTcp,
            EndpointKind::BchP2p if host.parse::<IpAddr>().is_ok() => StoredKind::P2p,
            _ => return None,
        };
        Some(Self {
            kind,
            host,
            port,
            advertised_by: peer.advertised_by.as_str().to_owned(),
            last_seen: now_unix,
        })
    }

    fn key(&self) -> (StoredKind, String, u16) {
        (self.kind, self.host.clone(), self.port)
    }

    fn id(&self) -> SourceId {
        SourceId::new(stable_source_id(&self.peer().endpoint))
    }

    /// Nodes are written without `tls`, which a build that predates them
    /// requires: it skips them instead of reading one as a server.
    fn to_json(&self) -> Value {
        let mut entry = json!({
            "host": self.host,
            "port": self.port,
            "advertised_by": self.advertised_by,
            "last_seen": self.last_seen,
        });
        match self.kind {
            StoredKind::P2p => entry["p2p"] = json!(true),
            StoredKind::ElectrumTls => entry["tls"] = json!(true),
            StoredKind::ElectrumTcp => entry["tls"] = json!(false),
        }
        entry
    }

    fn from_json(value: &Value) -> Option<Self> {
        let host = value.get("host")?.as_str()?.to_owned();
        let kind = if value.get("p2p").and_then(Value::as_bool) == Some(true) {
            host.parse::<IpAddr>().ok()?;
            StoredKind::P2p
        } else if value.get("tls")?.as_bool()? {
            StoredKind::ElectrumTls
        } else {
            StoredKind::ElectrumTcp
        };
        Some(Self {
            kind,
            host,
            port: u16::try_from(value.get("port")?.as_u64()?).ok()?,
            advertised_by: value.get("advertised_by")?.as_str()?.to_owned(),
            last_seen: value.get("last_seen")?.as_u64()?,
        })
    }

    fn peer(&self) -> DiscoveredPeer {
        DiscoveredPeer {
            endpoint: Endpoint {
                kind: match self.kind {
                    StoredKind::ElectrumTls => EndpointKind::ElectrumTls,
                    StoredKind::ElectrumTcp => EndpointKind::ElectrumTcp,
                    StoredKind::P2p => EndpointKind::BchP2p,
                },
                host: self.host.clone(),
                port: Some(self.port),
            },
            advertised_by: SourceId::new(self.advertised_by.clone()),
        }
    }
}

#[derive(Clone)]
pub struct DiscoveredPeersFile {
    path: PathBuf,
}

impl DiscoveredPeersFile {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// The servers and nodes last discovered for `network`, newest first.
    ///
    /// Missing, unreadable or for another network all read as none: losing a
    /// cache only means rediscovering it, and it must never stop the wallet
    /// from starting.
    pub fn load(&self, network: Network) -> Vec<DiscoveredPeer> {
        self.read(network)
            .into_iter()
            .map(|peer| peer.peer())
            .collect()
    }

    /// Merge newly discovered peers in, newest first, and write only when
    /// something changed. Returns whether the file was written.
    ///
    /// Servers and nodes are bounded apart. `keep` names the peers the holder
    /// set a disposition for: those stay, outside the bounds and however old.
    pub fn record(
        &self,
        network: Network,
        found: &[DiscoveredPeer],
        keep: &BTreeSet<SourceId>,
        now_unix: u64,
    ) -> Result<bool, String> {
        let _lock = lock_file(&self.path).map_err(|error| error.to_string())?;
        let before = self.read(network);
        let mut merged: Vec<StoredPeer> = Vec::new();
        for candidate in found
            .iter()
            .filter_map(|peer| StoredPeer::from_peer(peer, now_unix))
        {
            if merged.iter().all(|kept| kept.key() != candidate.key()) {
                merged.push(candidate);
            }
        }
        for old in &before {
            if merged.iter().all(|kept| kept.key() != old.key())
                && (now_unix.saturating_sub(old.last_seen) < FORGET_AFTER_SECS
                    || keep.contains(&old.id()))
            {
                merged.push(old.clone());
            }
        }
        // Seen again recently: keep the stored date, so a reconnect is a no-op.
        for peer in &mut merged {
            if let Some(old) = before.iter().find(|old| old.key() == peer.key()) {
                if now_unix.saturating_sub(old.last_seen) < REFRESH_AFTER_SECS {
                    peer.last_seen = old.last_seen;
                    peer.advertised_by = old.advertised_by.clone();
                }
            }
        }
        merged.sort_by(|a, b| b.last_seen.cmp(&a.last_seen).then(a.key().cmp(&b.key())));
        let (mut servers, mut nodes, mut kept) = (0, 0, 0);
        merged.retain(|peer| {
            let count = if keep.contains(&peer.id()) {
                kept += 1;
                return kept <= MAX_KEPT;
            } else if peer.kind == StoredKind::P2p {
                &mut nodes
            } else {
                &mut servers
            };
            *count += 1;
            *count <= MAX_DISCOVERED_PEERS
        });
        if merged == before {
            return Ok(false);
        }
        let stored = json!({
            "version": VERSION,
            "network": network.to_string(),
            "peers": merged.iter().map(StoredPeer::to_json).collect::<Vec<_>>(),
        });
        let bytes = serde_json::to_vec_pretty(&stored).map_err(|error| error.to_string())?;
        write_atomically(&self.path, &bytes).map_err(|error| error.to_string())?;
        Ok(true)
    }

    fn read(&self, network: Network) -> Vec<StoredPeer> {
        let Ok(Some(bytes)) = read_bounded(&self.path, MAX_BYTES) else {
            return Vec::new();
        };
        let Ok(stored) = serde_json::from_slice::<Value>(&bytes) else {
            return Vec::new();
        };
        let expected = network.to_string();
        if stored.get("version").and_then(Value::as_u64) != Some(u64::from(VERSION))
            || stored.get("network").and_then(Value::as_str) != Some(expected.as_str())
        {
            return Vec::new();
        }
        stored
            .get("peers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(StoredPeer::from_json)
            .filter(|peer| peer.port != 0 && !peer.host.is_empty())
            .take(2 * MAX_DISCOVERED_PEERS + MAX_KEPT)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    fn test_file(label: &str) -> (DiscoveredPeersFile, PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "optn-discovered-peers-{label}-{}-{}",
            std::process::id(),
            TEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("discovered-peers-mainnet.json");
        (DiscoveredPeersFile::new(path), directory)
    }

    fn peer(host: &str) -> DiscoveredPeer {
        DiscoveredPeer {
            endpoint: Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: host.into(),
                port: Some(50002),
            },
            advertised_by: SourceId::new("bootstrap:electrum-tls:advertiser.example:50002"),
        }
    }

    #[test]
    fn records_newest_first_bounded_and_only_when_something_changed() {
        let (file, directory) = test_file("record");
        let day = 24 * 60 * 60;
        assert!(file.load(Network::Mainnet).is_empty());
        let none = BTreeSet::new();
        assert!(file
            .record(
                Network::Mainnet,
                &[peer("a.example.org"), peer("A.example.org.")],
                &none,
                10 * day
            )
            .unwrap());
        assert_eq!(file.load(Network::Mainnet), vec![peer("a.example.org")]);

        // The same server again within a day is not a change.
        assert!(!file
            .record(
                Network::Mainnet,
                &[peer("a.example.org")],
                &none,
                10 * day + 60
            )
            .unwrap());
        // A new one is, and comes first.
        assert!(file
            .record(Network::Mainnet, &[peer("b.example.org")], &none, 11 * day)
            .unwrap());
        assert_eq!(
            file.load(Network::Mainnet),
            vec![peer("b.example.org"), peer("a.example.org")]
        );
        // A month unseen is forgotten.
        assert!(file
            .record(Network::Mainnet, &[peer("b.example.org")], &none, 41 * day)
            .unwrap());
        assert_eq!(file.load(Network::Mainnet), vec![peer("b.example.org")]);

        // Bounded, and never read for another network.
        let many: Vec<_> = (0..40)
            .map(|index| peer(&format!("peer{index}.example.org")))
            .collect();
        file.record(Network::Mainnet, &many, &none, 42 * day)
            .unwrap();
        assert_eq!(file.load(Network::Mainnet).len(), MAX_DISCOVERED_PEERS);
        assert!(file.load(Network::Chipnet).is_empty());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn an_unreadable_cache_reads_as_empty_and_is_replaced() {
        let (file, directory) = test_file("unreadable");
        std::fs::write(&file.path, b"not json").unwrap();
        assert!(file.load(Network::Mainnet).is_empty());
        assert!(file
            .record(
                Network::Mainnet,
                &[peer("a.example.org")],
                &BTreeSet::new(),
                1_000
            )
            .unwrap());
        assert_eq!(file.load(Network::Mainnet), vec![peer("a.example.org")]);
        let _ = std::fs::remove_dir_all(directory);
    }

    fn node(address: &str) -> DiscoveredPeer {
        DiscoveredPeer {
            endpoint: Endpoint {
                kind: EndpointKind::BchP2p,
                host: address.into(),
                port: Some(8333),
            },
            advertised_by: SourceId::new("bootstrap:p2p-seed:seed.example.org:8333"),
        }
    }

    /// Nodes a seed named are kept beside the servers, bounded apart from
    /// them, and only by address.
    #[test]
    fn nodes_are_cached_beside_servers_and_bounded_apart() {
        let (file, directory) = test_file("nodes");
        let none = BTreeSet::new();
        let mut found: Vec<_> = (0..40)
            .map(|index| node(&format!("203.0.113.{index}")))
            .collect();
        found.extend((0..40).map(|index| peer(&format!("peer{index}.example.org"))));
        // A name is not a node.
        found.push(node("node.example.org"));
        file.record(Network::Mainnet, &found, &none, 1_000).unwrap();
        let loaded = file.load(Network::Mainnet);
        let nodes = loaded
            .iter()
            .filter(|peer| peer.endpoint.kind == EndpointKind::BchP2p)
            .count();
        assert_eq!(nodes, MAX_DISCOVERED_PEERS);
        assert_eq!(loaded.len(), 2 * MAX_DISCOVERED_PEERS);
        assert!(loaded.contains(&node("203.0.113.0")));

        // A build that predates nodes reads only the servers: an entry
        // without `tls` is one it skips.
        let raw: Value = serde_json::from_slice(&std::fs::read(&file.path).unwrap()).unwrap();
        let entries = raw["peers"].as_array().unwrap();
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.get("tls").is_some())
                .count(),
            MAX_DISCOVERED_PEERS
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    /// A peer the holder banned or disabled stays cached however long since
    /// anything named it, so their choice always has an entry to hold on.
    #[test]
    fn a_peer_with_a_disposition_is_never_forgotten() {
        let (file, directory) = test_file("kept");
        let day = 24 * 60 * 60;
        let banned = node("203.0.113.9");
        let none = BTreeSet::new();
        file.record(
            Network::Mainnet,
            &[banned.clone(), node("203.0.113.10")],
            &none,
            day,
        )
        .unwrap();
        let keep = BTreeSet::from([SourceId::new("bootstrap:p2p:203.0.113.9:8333")]);
        // Two months later, with the cache full of newer nodes.
        let newer: Vec<_> = (0..40)
            .map(|index| node(&format!("198.51.100.{index}")))
            .collect();
        file.record(Network::Mainnet, &newer, &keep, 60 * day)
            .unwrap();
        let loaded = file.load(Network::Mainnet);
        assert!(loaded.contains(&banned));
        assert!(!loaded.contains(&node("203.0.113.10")));
        assert_eq!(loaded.len(), MAX_DISCOVERED_PEERS + 1);
        let _ = std::fs::remove_dir_all(directory);
    }
}
