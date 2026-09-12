//! Durable, network-scoped persistence for the existing chain source overlay.
//!
//! This adapter intentionally handles only the legacy one-Electrum/one-peer/
//! one-explorer settings that the current app state can represent. Richer
//! overlays remain on disk and reject writes rather than being silently lost.

use crate::chain_runtime::catalog_and_policy_from_app_state;
use optn_app::{AppState, NetworkServers, ServerKind};
use optn_chain_native::network_config::NetworkConfigFile;
use optn_core::network::Network;
use optn_runtime::chain::{ConnectionPolicy, Endpoint, EndpointKind, SourceCatalog};
use optn_runtime::network_config::{
    legacy_network_servers_from_overlay, resolve_shipped_chain_selection, NetworkConfigEnvelope,
    NetworkConfigStore, UserNetworkOverlay,
};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

const LEGACY_CATALOG_VERSION: &str = "legacy-server-overrides-v1";

/// Tauri-owned files, one per chain network because the runtime envelope has no
/// network discriminator.
#[derive(Clone)]
pub struct NetworkSettingsStore {
    mainnet: NetworkConfigFile,
    chipnet: NetworkConfigFile,
    /// Its own file for the same reason the others have theirs: a locally
    /// mined chain's sources must not be readable by a wallet on a network
    /// anyone else uses.
    regtest: NetworkConfigFile,
    // A network edit snapshots the selected network before saving, then
    // publishes it. Serialize that sequence with network switches.
    pub(crate) write_lock: Arc<tokio::sync::Mutex<()>>,
}

impl NetworkSettingsStore {
    /// Bind separate mainnet and Chipnet files without loading or creating them.
    pub fn new(directory: PathBuf) -> Self {
        Self {
            mainnet: NetworkConfigFile::new(directory.join("network-mainnet.json")),
            chipnet: NetworkConfigFile::new(directory.join("network-chipnet.json")),
            regtest: NetworkConfigFile::new(directory.join("network-regtest.json")),
            write_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// Restore both networks into a clone, publishing only after all reads succeed.
    /// Rich overlays remain available to the chain runtime without being flattened
    /// into the legacy server fields; missing files leave existing fields unchanged.
    pub fn restore(&self, state: &mut AppState) -> Result<(), String> {
        let mut restored = state.clone();
        for network in [Network::Mainnet, Network::Chipnet] {
            let Some(envelope) = self.file_for(network).load()? else {
                continue;
            };
            // The legacy reducer state can render only one Electrum endpoint
            // and one P2P endpoint. A richer persisted policy is still valid
            // and is used by `NativeChainRuntime`; never reject or flatten it
            // merely because this compatibility view cannot display it.
            if let Ok(servers) = legacy_network_servers_from_overlay(&envelope.overlay) {
                apply_servers(&mut restored, network, &servers)?;
            }
        }
        *state = restored;
        Ok(())
    }

    /// Resolve the exact persisted catalog and policy for the selected
    /// network over the same reviewed bootstrap base as the CLI. Missing files
    /// preserve the app-state bridge, which keeps the landing network-idle.
    pub fn chain_selection(
        &self,
        network: Network,
    ) -> Result<Option<(SourceCatalog, ConnectionPolicy)>, String> {
        self.file_for(network)
            .load()?
            .map(|envelope| {
                resolve_shipped_chain_selection(network, Some(&envelope))
                    .map_err(|error| format!("invalid network configuration: {error:?}"))
            })
            .transpose()
    }

    /// Validate and atomically save the selected network before its reducer
    /// event is published. A richer on-disk overlay is deliberately rejected
    /// here so this compatibility bridge cannot overwrite it.
    pub fn save_for_network(&self, state: &AppState, network: Network) -> Result<(), String> {
        let file = self.file_for(network);
        file.update(|existing| {
            let catalog_version = match existing {
                Some(existing) => {
                    legacy_network_servers_from_overlay(&existing.overlay)?;
                    existing.bootstrap_catalog_version_seen
                }
                None => LEGACY_CATALOG_VERSION.into(),
            };
            envelope_from_state(state, network, catalog_version)
        })
        .map(|_| ())
    }

    /// Select the file whose contents belong exclusively to this chain network.
    fn file_for(&self, network: Network) -> &NetworkConfigFile {
        match network {
            Network::Mainnet => &self.mainnet,
            Network::Chipnet => &self.chipnet,
            Network::Regtest => &self.regtest,
        }
    }
}

/// Snapshot one network's legacy settings as an overlay, preserving the
/// catalog version and rejecting explorer URLs that cannot represent an origin.
fn envelope_from_state(
    state: &AppState,
    network: Network,
    bootstrap_catalog_version_seen: String,
) -> Result<NetworkConfigEnvelope, String> {
    let mut scoped = state.clone();
    scoped.network = network;
    let (catalog, policy) = catalog_and_policy_from_app_state(&scoped);
    let explorer = scoped
        .servers
        .for_network(network)
        .explorer
        .as_deref()
        .map(explorer_endpoint)
        .transpose()?;
    Ok(NetworkConfigEnvelope::current(
        bootstrap_catalog_version_seen,
        UserNetworkOverlay {
            user_sources: catalog.iter().cloned().collect(),
            bootstrap_overrides: BTreeMap::new(),
            connection_policy: policy,
            explorer,
        },
    ))
}

/// Reset and validate each legacy server override on the caller's working state.
/// This can fail after a partial update, so restoration passes an unpublished clone.
fn apply_servers(
    state: &mut AppState,
    network: Network,
    servers: &NetworkServers,
) -> Result<(), String> {
    state.servers.use_network_default(network);
    for (kind, value) in [
        (ServerKind::Electrum, servers.electrum.as_deref()),
        (ServerKind::Peer, servers.peer.as_deref()),
        (ServerKind::Explorer, servers.explorer.as_deref()),
    ] {
        if let Some(value) = value {
            state.servers.set(network, kind, value)?;
        }
    }
    Ok(())
}

/// Accept an HTTPS origin, including its optional port, without credentials,
/// path, query, or fragment that the endpoint representation would discard.
fn explorer_endpoint(entry: &str) -> Result<Endpoint, String> {
    let url = reqwest::Url::parse(entry)
        .map_err(|_| "the explorer setting is not a valid HTTPS URL".to_string())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "network settings persist an explorer origin only; remove its path, credentials, query, and fragment"
                .into(),
        );
    }
    Ok(Endpoint {
        kind: EndpointKind::ExplorerHttps,
        host: url.host_str().expect("checked above").to_owned(),
        port: url.port(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    static TEMP_ID: AtomicU64 = AtomicU64::new(0);
    use optn_runtime::chain::{ConnectionPolicy, SourceDisposition, SourceOrigin};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "optn-network-config-test-{}-{}",
                std::process::id(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn store(&self) -> NetworkSettingsStore {
            NetworkSettingsStore::new(self.0.clone())
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn restart_restores_network_scoped_server_overrides() {
        let directory = TestDirectory::new();
        let store = directory.store();
        let mut state = AppState::default();
        state
            .servers
            .set(Network::Mainnet, ServerKind::Electrum, "main.example:50002")
            .unwrap();
        state
            .servers
            .set(Network::Chipnet, ServerKind::Peer, "chip.example:8333")
            .unwrap();
        state
            .servers
            .set(
                Network::Chipnet,
                ServerKind::Explorer,
                "https://explorer.example",
            )
            .unwrap();
        store.save_for_network(&state, Network::Mainnet).unwrap();
        store.save_for_network(&state, Network::Chipnet).unwrap();

        let mut restored = AppState::default();
        store.restore(&mut restored).unwrap();
        assert_eq!(
            restored
                .servers
                .for_network(Network::Mainnet)
                .electrum
                .as_deref(),
            Some("main.example:50002")
        );
        assert_eq!(
            restored
                .servers
                .for_network(Network::Chipnet)
                .peer
                .as_deref(),
            Some("chip.example:8333")
        );
        assert_eq!(
            restored
                .servers
                .for_network(Network::Chipnet)
                .explorer
                .as_deref(),
            Some("https://explorer.example")
        );
        assert!(restored
            .servers
            .for_network(Network::Mainnet)
            .peer
            .is_none());
    }

    #[test]
    fn richer_overlay_is_not_overwritten_by_legacy_settings() {
        let directory = TestDirectory::new();
        let store = directory.store();
        let overlay = UserNetworkOverlay {
            connection_policy: ConnectionPolicy::own_infrastructure(),
            ..Default::default()
        };
        let envelope = NetworkConfigEnvelope::current("advanced", overlay);
        store.mainnet.store_atomic(&envelope).unwrap();
        let before = fs::read(directory.0.join("network-mainnet.json")).unwrap();

        let mut state = AppState::default();
        state
            .servers
            .set(Network::Mainnet, ServerKind::Electrum, "main.example:50002")
            .unwrap();
        assert!(store.save_for_network(&state, Network::Mainnet).is_err());
        assert_eq!(
            fs::read(directory.0.join("network-mainnet.json")).unwrap(),
            before
        );
    }

    #[test]
    fn invalid_persisted_endpoint_is_rejected_before_any_host_uses_it() {
        let directory = TestDirectory::new();
        let store = directory.store();
        let mut overlay = UserNetworkOverlay::default();
        overlay.user_sources.push(optn_runtime::chain::ChainSource {
            id: optn_runtime::chain::SourceId::new("host:bad.example"),
            label: "bad.example".into(),
            origin: SourceOrigin::UserAdded,
            endpoints: vec![Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: "bad.example".into(),
                port: Some(0),
            }],
            capabilities: Default::default(),
            disposition: SourceDisposition::Enabled,
            priority: 0,
        });
        let invalid = NetworkConfigEnvelope::current("bad", overlay);
        assert!(store.mainnet.store_atomic(&invalid).is_err());
        // Simulate a corrupt external file independently of the validated writer.
        fs::write(
            directory.0.join("network-mainnet.json"),
            optn_runtime::network_config::encode_envelope_json(&invalid).unwrap(),
        )
        .unwrap();

        assert!(store.chain_selection(Network::Mainnet).is_err());
        assert!(store.restore(&mut AppState::default()).is_err());
    }

    #[test]
    fn rich_persisted_selection_drives_native_runtime_without_legacy_reduction() {
        let directory = TestDirectory::new();
        let store = directory.store();
        let mut overlay = UserNetworkOverlay::default();
        overlay.user_sources.push(optn_runtime::chain::ChainSource {
            id: optn_runtime::chain::SourceId::new("local-peer"),
            label: "Local node".into(),
            origin: SourceOrigin::UserInfrastructure {
                group: "lab".into(),
            },
            endpoints: vec![Endpoint {
                kind: EndpointKind::ElectrumTcp,
                host: "127.0.0.1".into(),
                port: Some(50003),
            }],
            capabilities: Default::default(),
            disposition: SourceDisposition::Enabled,
            priority: 0,
        });
        overlay.connection_policy = ConnectionPolicy::own_infrastructure();
        store
            .mainnet
            .store_atomic(&NetworkConfigEnvelope::current("advanced", overlay.clone()))
            .unwrap();
        let before = fs::read(directory.0.join("network-mainnet.json")).unwrap();

        let mut state = AppState::default();
        store.restore(&mut state).unwrap();
        let (catalog, policy) = store.chain_selection(Network::Mainnet).unwrap().unwrap();
        assert_eq!(policy, overlay.connection_policy);
        let selection = optn_runtime::chain::build_selection_plan(&catalog, &policy);
        assert_eq!(
            selection.primary,
            vec![optn_runtime::chain::SourceId::new("local-peer")]
        );
        assert!(selection.fallback.is_empty());
        assert!(state.servers.for_network(Network::Mainnet).is_empty());
        assert!(store.save_for_network(&state, Network::Mainnet).is_err());
        assert_eq!(
            fs::read(directory.0.join("network-mainnet.json")).unwrap(),
            before
        );
    }

    #[test]
    fn restore_is_all_or_nothing_across_networks() {
        let directory = TestDirectory::new();
        let store = directory.store();
        let mut saved = AppState::default();
        saved
            .servers
            .set(
                Network::Mainnet,
                ServerKind::Electrum,
                "saved.example:50002",
            )
            .unwrap();
        store.save_for_network(&saved, Network::Mainnet).unwrap();
        fs::write(directory.0.join("network-chipnet.json"), b"{").unwrap();

        let mut state = AppState::default();
        state
            .servers
            .set(Network::Mainnet, ServerKind::Electrum, "kept.example:50002")
            .unwrap();
        assert!(store.restore(&mut state).is_err());
        assert_eq!(
            state
                .servers
                .for_network(Network::Mainnet)
                .electrum
                .as_deref(),
            Some("kept.example:50002")
        );
    }
}
