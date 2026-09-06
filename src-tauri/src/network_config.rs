//! Durable, network-scoped persistence for the existing chain source overlay.
//!
//! This adapter intentionally handles only the legacy one-Electrum/one-peer/
//! one-explorer settings that the current app state can represent. Richer
//! overlays remain on disk and reject writes rather than being silently lost.

use crate::chain_runtime::catalog_and_policy_from_app_state;
use optn_app::{AppState, NetworkServers, ServerKind, ServerOverrides};
use optn_core::network::Network;
use optn_runtime::chain::{
    ConnectionPolicy, Endpoint, EndpointKind, SourceDisposition, SourceOrigin,
};
use optn_runtime::network_config::{
    decode_envelope_json, encode_envelope_json, NetworkConfigEnvelope, NetworkConfigStore,
    UserNetworkOverlay,
};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_BYTES: u64 = 128 * 1024;
const LEGACY_CATALOG_VERSION: &str = "legacy-server-overrides-v1";
static TEMP_ID: AtomicU64 = AtomicU64::new(0);

struct NetworkConfigFile {
    path: PathBuf,
}

impl NetworkConfigFile {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl NetworkConfigStore for NetworkConfigFile {
    fn load(&self) -> Result<Option<NetworkConfigEnvelope>, String> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("network configuration file is too large".into());
        }
        decode_envelope_json(
            std::str::from_utf8(&bytes)
                .map_err(|_| "network configuration is not UTF-8".to_string())?,
        )
        .map(Some)
        .map_err(|error| format!("invalid network configuration: {error:?}"))
    }

    fn store_atomic(&self, value: &NetworkConfigEnvelope) -> Result<(), String> {
        let bytes =
            encode_envelope_json(value).map_err(|error| format!("encode network config: {error:?}"))?;
        write_atomically(&self.path, bytes.as_bytes()).map_err(|error| error.to_string())
    }
}

/// Tauri-owned files, one per chain network because the runtime envelope has no
/// network discriminator.
pub struct NetworkSettingsStore {
    mainnet: NetworkConfigFile,
    chipnet: NetworkConfigFile,
    // A network edit snapshots the selected network before saving, then
    // publishes it. Serialize that sequence with network switches.
    pub(crate) write_lock: tokio::sync::Mutex<()>,
}

impl NetworkSettingsStore {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            mainnet: NetworkConfigFile::new(directory.join("network-mainnet.json")),
            chipnet: NetworkConfigFile::new(directory.join("network-chipnet.json")),
            write_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn restore(&self, state: &mut AppState) -> Result<(), String> {
        let mut restored = state.clone();
        for network in [Network::Mainnet, Network::Chipnet] {
            let Some(envelope) = self.file_for(network).load()? else {
                continue;
            };
            let servers = network_servers_from_overlay(&envelope.overlay)?;
            apply_servers(&mut restored, network, &servers)?;
        }
        *state = restored;
        Ok(())
    }

    /// Validate and atomically save the selected network before its reducer
    /// event is published. A richer on-disk overlay is deliberately rejected
    /// here so this compatibility bridge cannot overwrite it.
    pub fn save_for_network(&self, state: &AppState, network: Network) -> Result<(), String> {
        let file = self.file_for(network);
        let catalog_version = match file.load()? {
            Some(existing) => {
                network_servers_from_overlay(&existing.overlay)?;
                existing.bootstrap_catalog_version_seen
            }
            None => LEGACY_CATALOG_VERSION.into(),
        };
        file.store_atomic(&envelope_from_state(state, network, catalog_version)?)
    }

    fn file_for(&self, network: Network) -> &NetworkConfigFile {
        match network {
            Network::Mainnet => &self.mainnet,
            Network::Chipnet => &self.chipnet,
        }
    }
}

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

fn network_servers_from_overlay(overlay: &UserNetworkOverlay) -> Result<NetworkServers, String> {
    if !overlay.bootstrap_overrides.is_empty()
        || overlay.connection_policy != ConnectionPolicy::auto()
    {
        return Err(
            "this network configuration uses source policy features the current settings screen cannot edit"
                .into(),
        );
    }

    let mut servers = NetworkServers::new();
    for source in &overlay.user_sources {
        if !matches!(&source.origin, SourceOrigin::UserAdded)
            || source.disposition != SourceDisposition::Enabled
            || source.priority != 0
        {
            return Err(
                "this network configuration has a source the current settings screen cannot represent"
                    .into(),
            );
        }
        for endpoint in &source.endpoints {
            let (kind, entry) = match endpoint.kind {
                EndpointKind::ElectrumTls => (
                    ServerKind::Electrum,
                    host_port(&endpoint.host, required_port(endpoint)?)?,
                ),
                EndpointKind::ElectrumTcp => (
                    ServerKind::Electrum,
                    format!("ws://{}", host_port(&endpoint.host, required_port(endpoint)?)?),
                ),
                EndpointKind::BchP2p => (
                    ServerKind::Peer,
                    host_port(&endpoint.host, required_port(endpoint)?)?,
                ),
                _ => {
                    return Err(
                        "this network configuration has an endpoint the current settings screen cannot represent"
                            .into(),
                    )
                }
            };
            set_once(&mut servers, kind, entry)?;
        }
    }
    if let Some(explorer) = &overlay.explorer {
        if explorer.kind != EndpointKind::ExplorerHttps {
            return Err(
                "this network configuration has a non-HTTPS explorer the current settings screen cannot represent"
                    .into(),
            );
        }
        set_once(
            &mut servers,
            ServerKind::Explorer,
            format!("https://{}", host_port_optional(&explorer.host, explorer.port)?),
        )?;
    }
    Ok(servers)
}

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

fn set_once(
    servers: &mut NetworkServers,
    kind: ServerKind,
    value: String,
) -> Result<(), String> {
    if servers.get(kind).is_some() {
        return Err(
            "this network configuration has multiple endpoints of one kind, which the current settings screen cannot represent"
                .into(),
        );
    }
    let mut validated = ServerOverrides::new();
    validated
        .set(Network::Mainnet, kind, &value)
        .map_err(|error| format!("invalid persisted {} endpoint: {error}", kind.id()))?;
    let value = validated
        .for_network(Network::Mainnet)
        .get(kind)
        .expect("validated endpoint was stored")
        .to_owned();
    match kind {
        ServerKind::Electrum => servers.electrum = Some(value),
        ServerKind::Peer => servers.peer = Some(value),
        ServerKind::Explorer => servers.explorer = Some(value),
    }
    Ok(())
}

fn required_port(endpoint: &Endpoint) -> Result<u16, String> {
    endpoint
        .port
        .ok_or_else(|| "this network configuration has an endpoint without a port".into())
}

fn host_port(host: &str, port: u16) -> Result<String, String> {
    Ok(format!("{}:{port}", host_port_optional(host, None)?))
}

fn host_port_optional(host: &str, port: Option<u16>) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() || host.contains(['/', '\\', '@', '?', '#', ' ']) {
        return Err("this network configuration has an invalid endpoint host".into());
    }
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    Ok(match port {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

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

fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let directory = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "network configuration directory is unavailable",
        )
    })?;
    fs::create_dir_all(directory)?;
    let temporary = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

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
            restored.servers.for_network(Network::Mainnet).electrum.as_deref(),
            Some("main.example:50002")
        );
        assert_eq!(
            restored.servers.for_network(Network::Chipnet).peer.as_deref(),
            Some("chip.example:8333")
        );
        assert_eq!(
            restored.servers.for_network(Network::Chipnet).explorer.as_deref(),
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
        let before = fs::read(&store.mainnet.path).unwrap();

        let mut state = AppState::default();
        state
            .servers
            .set(Network::Mainnet, ServerKind::Electrum, "main.example:50002")
            .unwrap();
        assert!(store.save_for_network(&state, Network::Mainnet).is_err());
        assert_eq!(fs::read(&store.mainnet.path).unwrap(), before);
    }

    #[test]
    fn invalid_persisted_endpoint_is_not_loaded_or_overwritten() {
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
        store
            .mainnet
            .store_atomic(&NetworkConfigEnvelope::current("bad", overlay))
            .unwrap();
        let before = fs::read(&store.mainnet.path).unwrap();

        let mut state = AppState::default();
        assert!(store.restore(&mut state).is_err());
        assert!(store.save_for_network(&state, Network::Mainnet).is_err());
        assert_eq!(fs::read(&store.mainnet.path).unwrap(), before);
    }

    #[test]
    fn restore_is_all_or_nothing_across_networks() {
        let directory = TestDirectory::new();
        let store = directory.store();
        let mut saved = AppState::default();
        saved
            .servers
            .set(Network::Mainnet, ServerKind::Electrum, "saved.example:50002")
            .unwrap();
        store.save_for_network(&saved, Network::Mainnet).unwrap();
        fs::write(&store.chipnet.path, b"{").unwrap();

        let mut state = AppState::default();
        state
            .servers
            .set(Network::Mainnet, ServerKind::Electrum, "kept.example:50002")
            .unwrap();
        assert!(store.restore(&mut state).is_err());
        assert_eq!(
            state.servers.for_network(Network::Mainnet).electrum.as_deref(),
            Some("kept.example:50002")
        );
    }
}
