//! Shared desktop/CLI network-setting lookup.
//!
//! The CLI remains Tauri-free so it cross-compiles, but it reads the same
//! versioned per-network overlay that the desktop shell writes.

use std::env;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use optn_core::endpoint::{parse_electrum_endpoint, ElectrumEndpoint};
use optn_core::network::Network;
use optn_runtime::network_config::{decode_envelope_json, legacy_network_servers_from_overlay};

const APP_CONFIG_IDENTIFIER: &str = "com.optilabs.wallet";
const MAX_BYTES: u64 = 128 * 1024;

/// Load the desktop-selected encrypted Electrum endpoint for one network.
///
/// Missing settings deliberately return `None`, preserving the CLI's built-in
/// network default. A present but unsupported or corrupt setting returns an
/// error: falling back would violate an explicit user selection.
pub fn shared_electrum(
    network: Network,
    configured_directory: Option<&Path>,
) -> Result<Option<ElectrumEndpoint>, String> {
    let Some(path) =
        config_directory(configured_directory).map(|directory| directory.join(file_name(network)))
    else {
        return Ok(None);
    };
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not open {}: {error}", path.display())),
    };

    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(format!(
            "network settings file is too large: {}",
            path.display()
        ));
    }

    let text = std::str::from_utf8(&bytes)
        .map_err(|_| format!("network settings are not UTF-8: {}", path.display()))?;
    let envelope = decode_envelope_json(text)
        .map_err(|error| format!("invalid network settings in {}: {error:?}", path.display()))?;
    let servers = legacy_network_servers_from_overlay(&envelope.overlay).map_err(|error| {
        format!(
            "cannot enforce network settings in {}: {error}",
            path.display()
        )
    })?;
    let Some(entry) = servers.electrum else {
        return Ok(None);
    };
    let endpoint = parse_electrum_endpoint(&entry, network.default_port())
        .map_err(|error| format!("invalid shared Electrum endpoint: {error}"))?;
    if !endpoint.encrypted() {
        return Err("shared network settings selected plaintext Electrum".into());
    }
    Ok(Some(endpoint))
}

fn config_directory(configured_directory: Option<&Path>) -> Option<PathBuf> {
    configured_directory
        .map(Path::to_path_buf)
        .or_else(|| {
            env::var_os("OPTN_NETWORK_CONFIG_DIR")
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| dirs::config_dir().map(|directory| directory.join(APP_CONFIG_IDENTIFIER)))
}

fn file_name(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "network-mainnet.json",
        Network::Chipnet => "network-chipnet.json",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_runtime::chain::{
        CapabilitySet, ChainSource, ConnectionPolicy, Endpoint, EndpointKind, SourceDisposition,
        SourceId, SourceOrigin,
    };
    use optn_runtime::network_config::{
        encode_envelope_json, NetworkConfigEnvelope, UserNetworkOverlay,
    };
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = env::temp_dir().join(format!(
                "optn-cli-network-settings-{}-{}",
                std::process::id(),
                TEST_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn write(&self, network: Network, overlay: UserNetworkOverlay) {
            let contents =
                encode_envelope_json(&NetworkConfigEnvelope::current("test", overlay)).unwrap();
            fs::write(self.0.join(file_name(network)), contents).unwrap();
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn legacy_electrum(host: &str) -> UserNetworkOverlay {
        UserNetworkOverlay {
            user_sources: vec![ChainSource {
                id: SourceId::new("desktop-electrum"),
                label: "Desktop Electrum".into(),
                origin: SourceOrigin::UserAdded,
                endpoints: vec![Endpoint {
                    kind: EndpointKind::ElectrumTls,
                    host: host.into(),
                    port: Some(50002),
                }],
                capabilities: CapabilitySet::default(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            }],
            ..Default::default()
        }
    }

    #[test]
    fn reads_the_same_network_scoped_electrum_selection_as_desktop() {
        let directory = TestDirectory::new();
        directory.write(Network::Mainnet, legacy_electrum("desktop.example"));

        let endpoint = shared_electrum(Network::Mainnet, Some(&directory.0))
            .unwrap()
            .expect("desktop setting");
        assert_eq!(endpoint.host(), "desktop.example");
        assert_eq!(endpoint.port(), 50002);
        assert!(endpoint.encrypted());
        assert!(shared_electrum(Network::Chipnet, Some(&directory.0))
            .unwrap()
            .is_none());
    }

    #[test]
    fn refuses_an_advanced_policy_instead_of_using_a_default_server() {
        let directory = TestDirectory::new();
        let overlay = UserNetworkOverlay {
            connection_policy: ConnectionPolicy::own_infrastructure(),
            ..Default::default()
        };
        directory.write(Network::Mainnet, overlay);

        assert!(shared_electrum(Network::Mainnet, Some(&directory.0)).is_err());
    }
}
