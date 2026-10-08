//! Electrum servers discovered from peer lists, cached per network (#75 §21.3).
//!
//! A cache, not user intent. It lives beside the network settings rather than
//! in them, so recording a peer is never a settings edit: it revokes no routes,
//! asks for no rebuild, and never travels in a portable backup. Disabling or
//! banning one of these servers *is* intent, and lives in the settings overlay
//! keyed by the server's stable ID, so it survives the server being dropped
//! from here and found again.

use crate::network_config::{lock_file, read_bounded, write_atomically};
use optn_core::network::Network;
use optn_runtime::bootstrap::{DiscoveredPeer, MAX_DISCOVERED_PEERS};
use optn_runtime::chain::{Endpoint, EndpointKind, SourceId};
use serde_json::{json, Value};
use std::path::PathBuf;

const MAX_BYTES: u64 = 64 * 1024;
const VERSION: u32 = 1;
/// A server no peer list has named for this long is forgotten.
const FORGET_AFTER_SECS: u64 = 30 * 24 * 60 * 60;
/// Seeing a known server again refreshes its date at most this often, so an
/// ordinary reconnect does not rewrite the file.
const REFRESH_AFTER_SECS: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
struct StoredPeer {
    tls: bool,
    host: String,
    port: u16,
    advertised_by: String,
    last_seen: u64,
}

impl StoredPeer {
    fn key(&self) -> (bool, String, u16) {
        (self.tls, self.host.clone(), self.port)
    }

    fn to_json(&self) -> Value {
        json!({
            "tls": self.tls,
            "host": self.host,
            "port": self.port,
            "advertised_by": self.advertised_by,
            "last_seen": self.last_seen,
        })
    }

    fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            tls: value.get("tls")?.as_bool()?,
            host: value.get("host")?.as_str()?.to_owned(),
            port: u16::try_from(value.get("port")?.as_u64()?).ok()?,
            advertised_by: value.get("advertised_by")?.as_str()?.to_owned(),
            last_seen: value.get("last_seen")?.as_u64()?,
        })
    }

    fn peer(&self) -> DiscoveredPeer {
        DiscoveredPeer {
            endpoint: Endpoint {
                kind: if self.tls {
                    EndpointKind::ElectrumTls
                } else {
                    EndpointKind::ElectrumTcp
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

    /// The servers last discovered for `network`, newest first.
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

    /// Merge newly advertised servers in, newest first and bounded, and write
    /// only when something changed. Returns whether the file was written.
    pub fn record(
        &self,
        network: Network,
        found: &[DiscoveredPeer],
        now_unix: u64,
    ) -> Result<bool, String> {
        let _lock = lock_file(&self.path).map_err(|error| error.to_string())?;
        let before = self.read(network);
        let mut merged: Vec<StoredPeer> = Vec::new();
        for peer in found {
            let Some(port) = peer.endpoint.port.filter(|port| *port != 0) else {
                continue;
            };
            let tls = match peer.endpoint.kind {
                EndpointKind::ElectrumTls => true,
                EndpointKind::ElectrumTcp => false,
                _ => continue,
            };
            let candidate = StoredPeer {
                tls,
                host: peer
                    .endpoint
                    .host
                    .trim()
                    .trim_end_matches('.')
                    .to_ascii_lowercase(),
                port,
                advertised_by: peer.advertised_by.as_str().to_owned(),
                last_seen: now_unix,
            };
            if merged.iter().all(|kept| kept.key() != candidate.key()) {
                merged.push(candidate);
            }
        }
        for old in &before {
            if merged.iter().all(|kept| kept.key() != old.key())
                && now_unix.saturating_sub(old.last_seen) < FORGET_AFTER_SECS
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
        merged.truncate(MAX_DISCOVERED_PEERS);
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
            .take(MAX_DISCOVERED_PEERS)
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
        assert!(file
            .record(
                Network::Mainnet,
                &[peer("a.example.org"), peer("A.example.org.")],
                10 * day
            )
            .unwrap());
        assert_eq!(file.load(Network::Mainnet), vec![peer("a.example.org")]);

        // The same server again within a day is not a change.
        assert!(!file
            .record(Network::Mainnet, &[peer("a.example.org")], 10 * day + 60)
            .unwrap());
        // A new one is, and comes first.
        assert!(file
            .record(Network::Mainnet, &[peer("b.example.org")], 11 * day)
            .unwrap());
        assert_eq!(
            file.load(Network::Mainnet),
            vec![peer("b.example.org"), peer("a.example.org")]
        );
        // A month unseen is forgotten.
        assert!(file
            .record(Network::Mainnet, &[peer("b.example.org")], 41 * day)
            .unwrap());
        assert_eq!(file.load(Network::Mainnet), vec![peer("b.example.org")]);

        // Bounded, and never read for another network.
        let many: Vec<_> = (0..40)
            .map(|index| peer(&format!("peer{index}.example.org")))
            .collect();
        file.record(Network::Mainnet, &many, 42 * day).unwrap();
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
            .record(Network::Mainnet, &[peer("a.example.org")], 1_000)
            .unwrap());
        assert_eq!(file.load(Network::Mainnet), vec![peer("a.example.org")]);
        let _ = std::fs::remove_dir_all(directory);
    }
}
