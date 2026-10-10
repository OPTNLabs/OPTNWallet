//! Shared desktop/CLI network-setting lookup.
//!
//! The CLI remains Tauri-free so it cross-compiles, but it reads the same
//! versioned per-network overlay that the desktop shell writes.

use std::env;
use std::path::{Path, PathBuf};

use optn_chain_native::network_config::NetworkConfigFile;
use optn_core::endpoint::{parse_electrum_endpoint, ElectrumEndpoint};
use optn_core::network::Network;
use optn_runtime::chain::{
    ConnectionPolicy, Endpoint, EndpointKind, SourceCatalog, SourceDisposition, SourceId,
};
use optn_runtime::network_config::{
    legacy_network_servers_from_overlay, resolve_shipped_chain_selection, NetworkConfigEnvelope,
    NetworkConfigStore,
};

const APP_CONFIG_IDENTIFIER: &str = "com.optilabs.wallet";

/// All native CLI operations honor the same persisted proxy confirmations.
pub async fn build_stack(
    network: Network,
    directory: Option<&Path>,
    selection: SharedChainSelection,
) -> optn_chain_native::NativeChainStack {
    let trusted = trusted_socks_ports(network, directory);
    let credentials = optn_platform_native::NativeSecureStorage::new(
        optn_runtime::rpc_credentials::RPC_CREDENTIAL_SERVICE,
    );
    let secrets = match optn_runtime::rpc_credentials::load_selected(
        &credentials,
        network,
        &selection.catalog,
        &selection.policy,
    )
    .await
    {
        Ok(secrets) => optn_chain_native::NativeChainSecrets::from_credentials(secrets),
        Err(_) => {
            return optn_chain_native::NativeChainStack::unavailable(
                "RPC secure storage is unavailable; credentials were not bypassed.",
            )
        }
    };
    let stack = optn_chain_native::build_native_chain_stack_via(
        selection.catalog,
        selection.policy,
        &network.to_string(),
        &secrets,
        optn_chain_native::TorProxyTrust {
            managed: &[],
            trusted: &trusted,
        },
    )
    .await;
    // Kept for a later run's failover, in the cache the desktop keeps too,
    // with every peer the holder set a disposition for kept however old.
    // Settings that cannot be read leave the cache as it is.
    if !stack.discovered_peers.is_empty() && network != Network::Regtest {
        if let (Some(file), Ok(envelope)) = (
            discovered_file(network, directory),
            shared_envelope(network, directory),
        ) {
            let keep = envelope
                .map(|envelope| envelope.overlay.bootstrap_overrides.into_keys().collect())
                .unwrap_or_default();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_secs());
            let _ = file.record(network, &stack.discovered_peers, &keep, now);
        }
    }
    stack
}

fn discovered_file(
    network: Network,
    directory: Option<&Path>,
) -> Option<optn_chain_native::discovered_peers_file::DiscoveredPeersFile> {
    config_directory(directory).map(|directory| {
        optn_chain_native::discovered_peers_file::DiscoveredPeersFile::new(
            directory.join(format!("discovered-peers-{network}.json")),
        )
    })
}

pub fn export_sources(network: Network, directory: Option<&Path>) -> Result<String, String> {
    let directory =
        config_directory(directory).ok_or("network configuration directory is unavailable")?;
    NetworkConfigFile::new(directory.join(file_name(network))).export_portable(network)
}

pub fn import_sources(
    network: Network,
    directory: Option<&Path>,
    json: &str,
) -> Result<(), String> {
    let directory =
        config_directory(directory).ok_or("network configuration directory is unavailable")?;
    NetworkConfigFile::new(directory.join(file_name(network)))
        .import_portable(network, json)
        .map(|_| ())
}

/// Apply the same complete selection accepted by GUI adapters, atomically.
pub fn configure_sources(
    network: Network,
    directory: Option<&Path>,
    selection: &optn_transport::chain_sources::WireConnectionPolicy,
) -> Result<(), String> {
    let directory =
        config_directory(directory).ok_or("network configuration directory is unavailable")?;
    NetworkConfigFile::new(directory.join(file_name(network)))
        .update(|existing| {
            let mut envelope = existing.unwrap_or_else(|| {
                NetworkConfigEnvelope::current(
                    optn_runtime::network_config::SHIPPED_CATALOG_VERSION,
                    Default::default(),
                )
            });
            optn_runtime::network_config::promote_legacy_policy(&mut envelope);
            let (catalog, _) = resolve_shipped_chain_selection(network, Some(&envelope))
                .map_err(|error| format!("invalid network settings: {error:?}"))?;
            envelope.overlay.connection_policy = optn_runtime::source_selection::policy(
                &catalog,
                selection,
                envelope.overlay.connection_policy.transport,
            )?;
            Ok(envelope)
        })
        .map(|_| ())
}

pub fn select_source(
    network: Network,
    directory: Option<&Path>,
    source: &str,
    protocol: optn_runtime::chain::ProtocolFamily,
) -> Result<(), String> {
    let directory =
        config_directory(directory).ok_or("network configuration directory is unavailable")?;
    NetworkConfigFile::new(directory.join(file_name(network)))
        .update(|existing| {
            let mut envelope = existing.unwrap_or_else(|| {
                NetworkConfigEnvelope::current(
                    optn_runtime::network_config::SHIPPED_CATALOG_VERSION,
                    Default::default(),
                )
            });
            optn_runtime::network_config::promote_legacy_policy(&mut envelope);
            let (catalog, _) = resolve_shipped_chain_selection(network, Some(&envelope))
                .map_err(|error| format!("invalid network settings: {error:?}"))?;
            let id = optn_runtime::chain::SourceId::new(source);
            // Pinning a source changes which one is used, never how.
            let policy = ConnectionPolicy {
                transport: envelope.overlay.connection_policy.transport,
                ..ConnectionPolicy::exact(id.clone(), protocol)
            };
            if !optn_runtime::chain::build_selection_plan(&catalog, &policy)
                .primary
                .contains(&id)
            {
                return Err(
                    "source is missing, disabled, banned, or has no endpoint for this protocol"
                        .into(),
                );
            }
            envelope.overlay.connection_policy = policy;
            Ok(envelope)
        })
        .map(|_| ())
}

/// Add one user-entered endpoint with the same request shape as the GUI host.
///
/// The requested network, when present, is an assertion from an imported or
/// scripted payload. It may not redirect a command into another network file.
pub fn add_source(
    network: Network,
    directory: Option<&Path>,
    request: &optn_transport::chain_sources::AddSourceRequest,
) -> Result<(), String> {
    validate_request_network(network, request.network.as_deref())?;
    if request.services.len() > 15 {
        return Err("A source supports at most sixteen services per edit".into());
    }
    let mut endpoints = vec![Endpoint {
        kind: parse_endpoint_kind(&request.kind)?,
        host: request.host.clone(),
        port: request.port,
    }];
    for service in &request.services {
        endpoints.push(Endpoint {
            kind: parse_endpoint_kind(&service.kind)?,
            host: request.host.clone(),
            port: service.port,
        });
    }
    let directory =
        config_directory(directory).ok_or("network configuration directory is unavailable")?;
    NetworkConfigFile::new(directory.join(file_name(network)))
        .update(|existing| {
            let mut envelope = existing.unwrap_or_else(|| {
                NetworkConfigEnvelope::current(
                    optn_runtime::network_config::SHIPPED_CATALOG_VERSION,
                    Default::default(),
                )
            });
            optn_runtime::network_config::promote_legacy_policy(&mut envelope);
            optn_runtime::network_config::add_user_source_services(
                &mut envelope.overlay,
                &request.label,
                endpoints.clone(),
                request.infrastructure_group.as_deref(),
            )?;
            Ok(envelope)
        })
        .map(|_| ())
}

/// Change a source disposition without accepting an arbitrary override key.
pub fn set_source_disposition(
    network: Network,
    directory: Option<&Path>,
    source: &str,
    disposition: &str,
) -> Result<(), String> {
    let disposition = parse_source_disposition(disposition)?;
    let directory =
        config_directory(directory).ok_or("network configuration directory is unavailable")?;
    NetworkConfigFile::new(directory.join(file_name(network)))
        .update(|existing| {
            let mut envelope = existing.unwrap_or_else(|| {
                NetworkConfigEnvelope::current(
                    optn_runtime::network_config::SHIPPED_CATALOG_VERSION,
                    Default::default(),
                )
            });
            optn_runtime::network_config::promote_legacy_policy(&mut envelope);
            let (catalog, _) = resolve_shipped_chain_selection(network, Some(&envelope))
                .map_err(|error| format!("invalid network settings: {error:?}"))?;
            let id = SourceId::new(source);
            if catalog.get(&id).is_none() {
                return Err("source is not in this network catalog".into());
            }
            optn_runtime::network_config::set_source_disposition(
                &mut envelope.overlay,
                &id,
                disposition,
            )?;
            Ok(envelope)
        })
        .map(|_| ())
}

/// Clear any endpoint-bound local RPC credential before removing its source.
///
/// Clearing first is deliberately fail-closed: secure-storage trouble leaves
/// the route configured instead of deleting its visible configuration while a
/// machine-local credential remains behind.
pub async fn remove_source(
    network: Network,
    directory: Option<&Path>,
    source: &str,
) -> Result<(), String> {
    use optn_runtime::rpc_credentials as rpc;

    let selection =
        shared_chain_selection(network, directory)?.ok_or("Source catalog is unavailable.")?;
    let id = SourceId::new(source);
    let configured = selection
        .catalog
        .get(&id)
        .ok_or("source is not in this network catalog")?;
    if !configured.can_remove() {
        return Err(
            "bootstrap sources cannot be deleted; disable or ban the source instead".into(),
        );
    }

    let store = optn_platform_native::NativeSecureStorage::new(rpc::RPC_CREDENTIAL_SERVICE);
    rpc::remove(&store, network, &selection.catalog, source)
        .await
        .map_err(|_| "RPC credential operation failed; source was not removed.".to_owned())?;

    let directory =
        config_directory(directory).ok_or("network configuration directory is unavailable")?;
    NetworkConfigFile::new(directory.join(file_name(network)))
        .update(|existing| {
            let mut envelope = existing.ok_or("source configuration was not found")?;
            optn_runtime::network_config::promote_legacy_policy(&mut envelope);
            let (catalog, _) = resolve_shipped_chain_selection(network, Some(&envelope))
                .map_err(|error| format!("invalid network settings: {error:?}"))?;
            let current = catalog
                .get(&id)
                .ok_or("source is not in this network catalog")?;
            if !current.can_remove() {
                return Err(
                    "bootstrap sources cannot be deleted; disable or ban the source instead".into(),
                );
            }
            if current.endpoints != configured.endpoints {
                return Err(
                    "source endpoints changed while clearing RPC credentials; source was not removed"
                        .into(),
                );
            }
            optn_runtime::network_config::remove_user_source(&mut envelope.overlay, &id)?;
            Ok(envelope)
        })
        .map(|_| ())
}

fn validate_request_network(network: Network, requested: Option<&str>) -> Result<(), String> {
    let Some(requested) = requested else {
        return Ok(());
    };
    let parsed = requested
        .parse::<Network>()
        .map_err(|_| "source request has an invalid network".to_owned())?;
    if parsed != network {
        return Err("source request targets a different network".into());
    }
    Ok(())
}

fn parse_endpoint_kind(value: &str) -> Result<EndpointKind, String> {
    match value {
        "p2p" => Ok(EndpointKind::BchP2p),
        "electrum-tls" => Ok(EndpointKind::ElectrumTls),
        "electrum-tcp" => Ok(EndpointKind::ElectrumTcp),
        "node-rpc" => Ok(EndpointKind::BchnRpc),
        "node-zmq" => Ok(EndpointKind::BchnZmq),
        "ipfs-gateway" => Ok(EndpointKind::IpfsGatewayHttps),
        "bcmr-indexer" => Ok(EndpointKind::BcmrIndexerHttps),
        "p2p-seed" => Ok(EndpointKind::BchDnsSeed),
        "explorer-https" => Ok(EndpointKind::ExplorerHttps),
        "explorer-http" => Ok(EndpointKind::ExplorerHttp),
        other => Err(format!("unknown endpoint kind '{other}'")),
    }
}

fn parse_source_disposition(value: &str) -> Result<SourceDisposition, String> {
    match value {
        "enabled" => Ok(SourceDisposition::Enabled),
        "disabled" => Ok(SourceDisposition::Disabled),
        "banned" => Ok(SourceDisposition::Banned),
        other => Err(format!("unknown source disposition '{other}'")),
    }
}

pub fn parse_policy_preset(
    value: &str,
) -> Result<optn_runtime::network_config::ChainPolicyPreset, String> {
    serde_json::from_value(serde_json::Value::String(value.replace('-', "_"))).map_err(|_| {
        "Use auto, privacy, own-infrastructure, electrum-only, bip37-only or neutrino-only.".into()
    })
}

pub fn set_policy_preset(
    network: Network,
    directory: Option<&Path>,
    preset: optn_runtime::network_config::ChainPolicyPreset,
) -> Result<(), String> {
    let directory =
        config_directory(directory).ok_or("network configuration directory is unavailable")?;
    NetworkConfigFile::new(directory.join(file_name(network)))
        .update(|existing| {
            let mut envelope = existing.unwrap_or_else(|| {
                NetworkConfigEnvelope::current(
                    optn_runtime::network_config::SHIPPED_CATALOG_VERSION,
                    Default::default(),
                )
            });
            optn_runtime::network_config::promote_legacy_policy(&mut envelope);
            optn_runtime::network_config::set_policy_preset(&mut envelope.overlay, preset)?;
            Ok(envelope)
        })
        .map(|_| ())
}

/// Turn Tor on or off for this network. Which sources are selected is left
/// exactly as it was.
/// Trust, or stop trusting, the SOCKS proxy on `127.0.0.1:port` as the
/// holder's Tor: the same edit the desktop's Privacy & Transport makes. A
/// greeting alone never proves Tor; the holder's declaration is the
/// provenance, and every surface reads it from this one overlay.
pub fn set_trusted_socks_port(
    network: Network,
    directory: Option<&Path>,
    port: u16,
    trusted: bool,
) -> Result<Vec<u16>, String> {
    if port == 0 {
        return Err("0 is not a port".into());
    }
    let directory =
        config_directory(directory).ok_or("network configuration directory is unavailable")?;
    let mut ports = Vec::new();
    NetworkConfigFile::new(directory.join(file_name(network))).update(|existing| {
        let mut envelope = existing.unwrap_or_else(|| {
            NetworkConfigEnvelope::current(
                optn_runtime::network_config::SHIPPED_CATALOG_VERSION,
                Default::default(),
            )
        });
        optn_runtime::network_config::promote_legacy_policy(&mut envelope);
        let trusted_ports = &mut envelope.overlay.trusted_socks_ports;
        trusted_ports.retain(|entry| *entry != port);
        if trusted {
            trusted_ports.push(port);
            trusted_ports.sort_unstable();
        }
        ports = trusted_ports.clone();
        Ok(envelope)
    })?;
    Ok(ports)
}

pub fn set_transport(
    network: Network,
    directory: Option<&Path>,
    transport: optn_runtime::chain::TransportPolicy,
) -> Result<(), String> {
    let directory =
        config_directory(directory).ok_or("network configuration directory is unavailable")?;
    NetworkConfigFile::new(directory.join(file_name(network)))
        .update(|existing| {
            let mut envelope = existing.unwrap_or_else(|| {
                NetworkConfigEnvelope::current(
                    optn_runtime::network_config::SHIPPED_CATALOG_VERSION,
                    Default::default(),
                )
            });
            optn_runtime::network_config::promote_legacy_policy(&mut envelope);
            envelope.overlay.connection_policy.transport = transport;
            Ok(envelope)
        })
        .map(|_| ())
}

/// The holder's Tor switch for `network`, and whether `host` is a node they
/// declared as their own. Unreadable settings read as Tor on and not their
/// own: a broken file must never be what allows a direct connection.
pub fn transport_for_host(
    network: Network,
    directory: Option<&Path>,
    host: &str,
) -> (optn_runtime::chain::TransportPolicy, bool) {
    let Ok(Some(selection)) = shared_chain_selection(network, directory) else {
        return (optn_runtime::chain::TransportPolicy::default(), false);
    };
    let host = host.trim_end_matches('.');
    let own = selection.catalog.iter().any(|source| {
        source.is_enabled()
            && source.is_user_infrastructure()
            && source.endpoints.iter().any(|endpoint| {
                endpoint
                    .host
                    .trim_end_matches('.')
                    .eq_ignore_ascii_case(host)
            })
    });
    (selection.policy.transport, own)
}

/// `on` or `off`, as typed after `network tor`.
pub fn parse_tor_switch(value: &str) -> Result<optn_runtime::chain::TransportPolicy, String> {
    match value.trim() {
        "on" => Ok(optn_runtime::chain::TransportPolicy::Tor),
        "off" => Ok(optn_runtime::chain::TransportPolicy::Direct),
        _ => Err("Use network tor on|off.".into()),
    }
}

/// The durable source catalog and policy shared by native wallet surfaces.
///
/// The CLI has no private network-settings shape: it either uses this exact
/// selection or reports that an older Electrum-only command cannot express it.
#[derive(Debug, Clone)]
pub struct SharedChainSelection {
    pub catalog: SourceCatalog,
    pub policy: ConnectionPolicy,
}

/// Load the full persisted source selection without flattening it to Electrum.
pub fn shared_chain_selection(
    network: Network,
    configured_directory: Option<&Path>,
) -> Result<Option<SharedChainSelection>, String> {
    let envelope = shared_envelope(network, configured_directory)?;
    // Servers discovered from peer lists rank after every shipped one, with
    // the holder's dispositions applied; see `optn_runtime::bootstrap`.
    let discovered = if network == Network::Regtest {
        Vec::new()
    } else {
        discovered_file(network, configured_directory)
            .map(|file| file.load(network))
            .unwrap_or_default()
    };
    let (catalog, policy) =
        optn_runtime::bootstrap::resolve_with_discovered(network, envelope.as_ref(), &discovered)
            .map_err(|error| format!("cannot enforce network settings: {error:?}"))?;
    Ok(Some(SharedChainSelection { catalog, policy }))
}

/// Loopback SOCKS ports the holder confirmed are their own Tor.
///
/// The CLI has no Tor of its own to own, so a confirmed port is the only way
/// it can use one at all. Read from the same overlay the desktop writes, which
/// is what makes "I confirmed my Tor" mean the same thing on both.
///
/// A missing or unreadable file yields none, which refuses rather than leaks.
pub fn trusted_socks_ports(network: Network, configured_directory: Option<&Path>) -> Vec<u16> {
    shared_envelope(network, configured_directory)
        .ok()
        .flatten()
        .map(|envelope| envelope.overlay.trusted_socks_ports)
        .unwrap_or_default()
}

/// Load the desktop-selected encrypted Electrum endpoint for one network: the
/// first of [`shared_electrum_servers`].
#[cfg(test)]
fn shared_electrum(
    network: Network,
    configured_directory: Option<&Path>,
) -> Result<Option<ElectrumEndpoint>, String> {
    Ok(shared_electrum_servers(network, configured_directory)?
        .and_then(|servers| servers.into_iter().next()))
}

/// The encrypted Electrum servers an Electrum-only command may use on one
/// network, in the order the shared settings rank them.
///
/// The one server the desktop's older fields name, when they name one. Under
/// any other selection (Auto, Privacy, a preset), every encrypted Electrum
/// endpoint the shared selection plan picks, primary sources first: the same
/// servers `rescan` and the desktop would use, never a default of the CLI's.
///
/// Missing settings return `None`, preserving the CLI's built-in network
/// default. A direct BCH P2P selection, plaintext Electrum, or a selection with
/// no Electrum at all is refused: falling back would violate it.
pub fn shared_electrum_servers(
    network: Network,
    configured_directory: Option<&Path>,
) -> Result<Option<Vec<ElectrumEndpoint>>, String> {
    let Some(envelope) = shared_envelope(network, configured_directory)? else {
        return Ok(None);
    };
    let legacy = legacy_network_servers_from_overlay(&envelope.overlay);
    if let Ok(servers) = &legacy {
        if servers.peer.is_some() {
            return Err(
                "shared network settings include a direct BCH P2P route that this Electrum-only CLI cannot enforce"
                    .into(),
            );
        }
        if let Some(entry) = &servers.electrum {
            let endpoint = parse_electrum_endpoint(entry, network.default_port())
                .map_err(|error| format!("invalid shared Electrum endpoint: {error}"))?;
            if !endpoint.encrypted() {
                return Err("shared network settings selected plaintext Electrum".into());
            }
            return Ok(Some(vec![endpoint]));
        }
    }
    let selected = selected_electrum_servers(network, configured_directory)?;
    if !selected.is_empty() {
        return Ok(Some(selected));
    }
    Err(match legacy {
        Err(error) => {
            format!("cannot enforce network settings in an Electrum-only command: {error}")
        }
        Ok(_) => {
            "shared network settings contain no Electrum route; refusing a default server".into()
        }
    })
}

/// Every encrypted Electrum endpoint the shared selection plan picks, primary
/// sources before fallback ones, each once.
fn selected_electrum_servers(
    network: Network,
    configured_directory: Option<&Path>,
) -> Result<Vec<ElectrumEndpoint>, String> {
    let Some(selection) = shared_chain_selection(network, configured_directory)? else {
        return Ok(Vec::new());
    };
    if !selection
        .policy
        .protocols
        .contains(optn_runtime::chain::ProtocolFamily::Electrum)
    {
        return Ok(Vec::new());
    }
    let plan = optn_runtime::chain::build_selection_plan(&selection.catalog, &selection.policy);
    let mut servers: Vec<ElectrumEndpoint> = Vec::new();
    for source in plan
        .primary
        .iter()
        .chain(plan.fallback.iter())
        .filter_map(|id| selection.catalog.get(id))
    {
        for endpoint in &source.endpoints {
            if endpoint.kind != optn_runtime::chain::EndpointKind::ElectrumTls {
                continue;
            }
            let Some(port) = endpoint.port else {
                continue;
            };
            let Ok(server) = parse_electrum_endpoint(&format!("{}:{port}", endpoint.host), port)
            else {
                continue;
            };
            if server.encrypted()
                && !servers
                    .iter()
                    .any(|known| known.host() == server.host() && known.port() == server.port())
            {
                servers.push(server);
            }
        }
    }
    Ok(servers)
}

fn shared_envelope(
    network: Network,
    configured_directory: Option<&Path>,
) -> Result<Option<NetworkConfigEnvelope>, String> {
    let Some(path) =
        config_directory(configured_directory).map(|directory| directory.join(file_name(network)))
    else {
        return Ok(None);
    };
    NetworkConfigFile::new(path).load()
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

/// One file per network. The three test chains share an address prefix, so
/// only this separation keeps a testnet4 server out of a chipnet wallet.
fn file_name(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "network-mainnet.json",
        Network::Testnet3 => "network-testnet3.json",
        Network::Testnet4 => "network-testnet4.json",
        Network::Chipnet => "network-chipnet.json",
        // Its own file, so a regtest source can never be read by a wallet on
        // a network anyone else uses.
        Network::Regtest => "network-regtest.json",
    }
}

/// Private local request: public replies contain presence only.
pub async fn rpc_credentials(
    network: Network,
    directory: Option<&Path>,
    request: optn_transport::chain_sources::RpcCredentialRequest,
) -> Result<optn_transport::chain_sources::RpcCredentialStatus, String> {
    use optn_runtime::rpc_credentials as rpc;
    use optn_transport::chain_sources::RpcCredentialRequest;
    let selection =
        shared_chain_selection(network, directory)?.ok_or("Source catalog is unavailable.")?;
    let source = request.source().to_owned();
    let store = optn_platform_native::NativeSecureStorage::new(rpc::RPC_CREDENTIAL_SERVICE);
    let result = async {
        match request {
            RpcCredentialRequest::Set {
                username, password, ..
            } => {
                rpc::set(
                    &store,
                    network,
                    &selection.catalog,
                    &source,
                    username.expose(),
                    password.expose(),
                )
                .await?
            }
            RpcCredentialRequest::Remove { .. } => {
                rpc::remove(&store, network, &selection.catalog, &source).await?;
                return Ok(false);
            }
            RpcCredentialRequest::Status { .. } => {}
        }
        rpc::status(&store, network, &selection.catalog, &source).await
    }
    .await
    .map_err(|_| "RPC credential operation failed; no credentials were exposed.".to_owned())?;
    Ok(optn_transport::chain_sources::RpcCredentialStatus { configured: result })
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_runtime::chain::{
        CapabilitySet, ChainSource, ConnectionPolicy, Endpoint, EndpointKind, ProtocolFamily,
        SourceDisposition, SourceId, SourceOrigin,
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

    #[tokio::test]
    async fn offline_commands_do_not_require_a_usable_chain_policy() {
        use clap::Parser;
        let directory = TestDirectory::new();
        let address = optn_core::flipstarter::chipnet_demo_coin(1000, 0)
            .unwrap()
            .address()
            .to_owned();
        for corrupt in [false, true] {
            if corrupt {
                fs::write(directory.0.join(file_name(Network::Chipnet)), b"not JSON").unwrap();
            } else {
                directory.write(
                    Network::Chipnet,
                    UserNetworkOverlay {
                        connection_policy: ConnectionPolicy::own_infrastructure(),
                        ..Default::default()
                    },
                );
            }
            let base = [
                "optn",
                "--network",
                "chipnet",
                "--network-config-dir",
                directory.0.to_str().unwrap(),
            ];
            for command in [
                vec!["inspect", address.as_str()],
                vec!["decode", "01000000000000000000"],
                vec!["skills"],
            ] {
                let cli = crate::Cli::try_parse_from(base.into_iter().chain(command)).unwrap();
                assert!(
                    crate::run(&cli).await.is_ok(),
                    "local command was blocked by network settings"
                );
            }
            let cli =
                crate::Cli::try_parse_from(base.into_iter().chain(["balance", address.as_str()]))
                    .unwrap();
            assert!(
                crate::run(&cli).await.is_err(),
                "network commands must still enforce settings"
            );
        }
    }

    #[test]
    fn fresh_cli_uses_shared_auto_without_persisting_defaults() {
        let directory = TestDirectory::new();
        let selection = shared_chain_selection(Network::Chipnet, Some(&directory.0))
            .unwrap()
            .unwrap();
        let (expected, policy) = resolve_shipped_chain_selection(Network::Chipnet, None).unwrap();
        assert_eq!(selection.catalog, expected);
        assert_eq!(selection.policy, policy);
        assert!(!directory.0.join(file_name(Network::Chipnet)).exists());

        let indexer = expected
            .iter()
            .find(|source| source.endpoints[0].kind == EndpointKind::BcmrIndexerHttps)
            .unwrap();
        assert!(select_source(
            Network::Chipnet,
            Some(&directory.0),
            indexer.id.as_str(),
            ProtocolFamily::Electrum
        )
        .is_err());
        assert!(!directory.0.join(file_name(Network::Chipnet)).exists());
        let id = expected
            .iter()
            .find(|source| source.endpoints[0].kind == EndpointKind::ElectrumTls)
            .unwrap()
            .id
            .clone();
        select_source(
            Network::Chipnet,
            Some(&directory.0),
            id.as_str(),
            ProtocolFamily::Electrum,
        )
        .unwrap();
        let pinned = shared_chain_selection(Network::Chipnet, Some(&directory.0))
            .unwrap()
            .unwrap();
        assert_eq!(
            pinned.policy,
            ConnectionPolicy::exact(id, ProtocolFamily::Electrum)
        );
        let stored = shared_envelope(Network::Chipnet, Some(&directory.0))
            .unwrap()
            .unwrap();
        assert!(
            stored.overlay.user_sources.is_empty(),
            "shipped entries are not user records"
        );
    }

    #[test]
    fn switching_tor_keeps_the_selection() {
        use optn_runtime::chain::TransportPolicy;
        assert_eq!(parse_tor_switch("on"), Ok(TransportPolicy::Tor));
        assert_eq!(parse_tor_switch("off"), Ok(TransportPolicy::Direct));
        assert!(parse_tor_switch("direct").is_err());

        let directory = TestDirectory::new();
        let mut overlay = legacy_electrum("127.0.0.1");
        overlay.connection_policy =
            ConnectionPolicy::exact(overlay.user_sources[0].id.clone(), ProtocolFamily::Electrum);
        let pinned = overlay.connection_policy.clone();
        directory.write(Network::Chipnet, overlay);
        set_transport(
            Network::Chipnet,
            Some(&directory.0),
            TransportPolicy::Direct,
        )
        .unwrap();
        let selection = shared_chain_selection(Network::Chipnet, Some(&directory.0))
            .unwrap()
            .unwrap();
        assert_eq!(selection.policy.transport, TransportPolicy::Direct);
        assert!(selection.policy.selects_like(&pinned));
    }

    /// The CLI declares a Tor proxy the way the desktop does, in the same
    /// overlay, so a headless runner can fuse without the desktop.
    #[test]
    fn trusting_a_tor_port_is_one_shared_overlay_edit() {
        let directory = TestDirectory::new();
        directory.write(Network::Chipnet, UserNetworkOverlay::default());
        assert_eq!(
            set_trusted_socks_port(Network::Chipnet, Some(&directory.0), 9150, true).unwrap(),
            vec![9150]
        );
        assert_eq!(
            set_trusted_socks_port(Network::Chipnet, Some(&directory.0), 9050, true).unwrap(),
            vec![9050, 9150]
        );
        // Trusting twice keeps one entry; removing leaves the other.
        set_trusted_socks_port(Network::Chipnet, Some(&directory.0), 9050, true).unwrap();
        assert_eq!(
            set_trusted_socks_port(Network::Chipnet, Some(&directory.0), 9150, false).unwrap(),
            vec![9050]
        );
        assert_eq!(
            trusted_socks_ports(Network::Chipnet, Some(&directory.0)),
            vec![9050]
        );
        assert!(set_trusted_socks_port(Network::Chipnet, Some(&directory.0), 0, true).is_err());
        // Other networks are untouched.
        assert!(trusted_socks_ports(Network::Mainnet, Some(&directory.0)).is_empty());
    }

    #[test]
    fn pinning_a_source_keeps_the_chosen_transport() {
        use optn_runtime::chain::TransportPolicy;
        let directory = TestDirectory::new();
        let mut overlay = UserNetworkOverlay::default();
        overlay.connection_policy.transport = TransportPolicy::Direct;
        directory.write(Network::Chipnet, overlay);
        let (catalog, _) = resolve_shipped_chain_selection(Network::Chipnet, None).unwrap();
        let id = catalog
            .iter()
            .find(|source| source.endpoints[0].kind == EndpointKind::ElectrumTls)
            .unwrap()
            .id
            .clone();
        select_source(
            Network::Chipnet,
            Some(&directory.0),
            id.as_str(),
            ProtocolFamily::Electrum,
        )
        .unwrap();
        let pinned = shared_chain_selection(Network::Chipnet, Some(&directory.0))
            .unwrap()
            .unwrap();
        assert_eq!(pinned.policy.transport, TransportPolicy::Direct);
        assert!(pinned
            .policy
            .selects_like(&ConnectionPolicy::exact(id, ProtocolFamily::Electrum)));
    }

    #[tokio::test]
    async fn send_dry_run_drives_spend_to_on_a_loopback_electrum() {
        use clap::Parser;
        use serde_json::{json, Value};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let mnemonic = optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC;
        std::env::set_var("OPTN_MNEMONIC", mnemonic);
        let wallet = optn_core::hd::Wallet::from_mnemonic(mnemonic, "").unwrap();
        let path = optn_core::hd::address_path(1, 0, false, 0);
        let address = wallet.address(Network::Chipnet, &path).unwrap();
        let scripthash = address.electrum_scripthash();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let Ok((socket, _)) = listener.accept().await else {
                    break;
                };
                let mut stream = BufReader::new(socket);
                let mut line = String::new();
                if stream.read_line(&mut line).await.unwrap() == 0 {
                    continue;
                }
                let request: Value = serde_json::from_str(&line).unwrap();
                let result = match request["method"].as_str().unwrap() {
                    "blockchain.scripthash.listunspent" => {
                        if request["params"][0] == scripthash {
                            json!([{
                                "tx_hash": "11".repeat(32),
                                "tx_pos": 0,
                                "height": 5,
                                "value": 100_000
                            }])
                        } else {
                            json!([])
                        }
                    }
                    other => panic!("unexpected RPC {other}"),
                };
                let response = json!({"id": request["id"], "result": result, "error": null});
                stream
                    .get_mut()
                    .write_all(format!("{response}\n").as_bytes())
                    .await
                    .unwrap();
            }
        });
        let cli = crate::Cli::try_parse_from([
            "optn",
            "--network",
            "chipnet",
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--no-tls",
            "--timeout",
            "5",
            "send",
            &address.encode(),
            "1000",
            "--dry-run",
            "--gap",
            "1",
        ])
        .unwrap();
        let result = crate::run(&cli).await.unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["dry_run"], true);
        assert_eq!(result["sats"], 1000);
        assert_eq!(result["inputs"], 1);
        assert!(result["fee"].as_u64().unwrap() > 0);
        assert!(result["raw"].as_str().unwrap().len() > 20);
        server.abort();
        std::env::remove_var("OPTN_MNEMONIC");
    }

    #[tokio::test]
    async fn cli_transactions_use_shared_policy_and_preserve_broadcast_ambiguity() {
        use clap::Parser;
        use optn_runtime::chain::ProtocolFamily;
        use serde_json::{json, Value};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let directory = TestDirectory::new();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut overlay = legacy_electrum("127.0.0.1");
        let source = &mut overlay.user_sources[0];
        source.endpoints[0].kind = EndpointKind::ElectrumTcp;
        source.endpoints[0].port = Some(listener.local_addr().unwrap().port());
        overlay.connection_policy =
            ConnectionPolicy::exact(source.id.clone(), ProtocolFamily::Electrum);
        directory.write(Network::Chipnet, overlay);
        // A serialization fixture, not a mined or spendable transaction.
        let account = optn_core::hd::AccountPath::new(145, 1).unwrap();
        let xpub =
            optn_core::hd::Wallet::from_mnemonic(optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC, "")
                .unwrap()
                .account_xpub_at(account)
                .unwrap();
        let address = optn_core::watch_only::address_under_account(Network::Chipnet, &xpub, 0, 1)
            .unwrap()
            .address;
        let script = crate::parse_address(&address, Network::Chipnet)
            .unwrap()
            .script_pubkey();
        let mut output_field = optn_core::token::TokenData::fungible([9; 32], 42)
            .encode_prefix()
            .unwrap();
        output_field.extend_from_slice(&script);
        let raw = format!(
            "0100000001{}ffffffff020101ffffffff01e803000000000000{:02x}{}00000000",
            "00".repeat(32),
            output_field.len(),
            crate::hex(&output_field)
        );
        let bytes = crate::decode_hex(&raw).unwrap();
        let mut hash = optn_core::header_hash::sha256d(&bytes);
        hash.reverse();
        let txid = crate::hex(&hash);
        let expected_txid = txid.clone();
        let response_raw = raw.clone();
        let server = tokio::spawn(async move {
            let mut lookups = 0;
            let mut broadcasts = 0;
            // One probe per invocation, then its lookup or full HD refresh rounds.
            loop {
                let Ok(Ok((socket, _))) =
                    tokio::time::timeout(std::time::Duration::from_millis(750), listener.accept())
                        .await
                else {
                    break;
                };
                let mut stream = BufReader::new(socket);
                loop {
                    let mut line = String::new();
                    if stream.read_line(&mut line).await.unwrap() == 0 {
                        break;
                    }
                    let request: Value = serde_json::from_str(&line).unwrap();
                    let result = match request["method"].as_str().unwrap() {
                        "server.version" => json!(["cli-test", "1.6"]),
                        "server.features" => {
                            json!({"genesis_hash": "000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b"})
                        }
                        "server.peers.subscribe" => json!([]),
                        "blockchain.headers.subscribe" => json!({"height":7,"hex":"00".repeat(80)}),
                        "blockchain.block.headers" => {
                            json!({"count": 0, "hex": "", "max": 2016})
                        }
                        "blockchain.scripthash.get_history" => {
                            json!([{"tx_hash":expected_txid,"height":5}])
                        }
                        "blockchain.scripthash.get_mempool" => json!([]),
                        // Asked alongside each lookup for the block height.
                        "blockchain.transaction.get_merkle" => {
                            json!({"block_height": 5, "merkle": [], "pos": 0})
                        }
                        // The token's authbase: this fixture holds no authchain,
                        // so its identity stays unresolved and its coin visible.
                        "blockchain.transaction.get"
                            if request["params"][0] != json!(expected_txid) =>
                        {
                            Value::Null
                        }
                        "blockchain.transaction.get" => {
                            assert_eq!(request["params"], json!([expected_txid, false]));
                            lookups += 1;
                            if lookups == 3 {
                                json!("ff")
                            } else {
                                json!(response_raw)
                            }
                        }
                        "blockchain.transaction.broadcast" => {
                            assert_eq!(request["params"], json!([response_raw]));
                            broadcasts += 1;
                            if broadcasts == 2 {
                                break;
                            } // Accepted bytes, lost reply.
                            json!(expected_txid)
                        }
                        other => panic!("unexpected RPC {other}"),
                    };
                    let response = json!({"id": request["id"], "result": result, "error": null});
                    stream
                        .get_mut()
                        .write_all(format!("{response}\n").as_bytes())
                        .await
                        .unwrap();
                }
            }
            assert_eq!(lookups, 7);
            assert_eq!(broadcasts, 2);
        });
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let args = [
                "optn",
                "--network",
                "chipnet",
                "--timeout",
                "2",
                "--network-config-dir",
                directory.0.to_str().unwrap(),
                "tx",
                txid.as_str(),
            ];
            let cli = crate::Cli::try_parse_from(args).unwrap();
            let result = crate::run(&cli).await.unwrap();
            assert_eq!(result["selection"], "shared-native-policy");
            assert_eq!(result["source"], "desktop-electrum");
            assert_eq!(result["transaction"], raw);
            let verbose_cli =
                crate::Cli::try_parse_from(args.into_iter().chain(["--verbose"])).unwrap();
            let verbose = crate::run(&verbose_cli).await.unwrap();
            assert_eq!(verbose["transaction"]["version"], 1);
            assert_eq!(verbose["transaction"]["outputs"][0]["value"], 1000);
            assert!(crate::run(&cli).await.is_err(), "substitution must fail");
            let broadcast_cli = crate::Cli::try_parse_from([
                "optn",
                "--network",
                "chipnet",
                "--timeout",
                "2",
                "--network-config-dir",
                directory.0.to_str().unwrap(),
                "broadcast",
                raw.as_str(),
            ])
            .unwrap();
            let submitted = crate::run(&broadcast_cli).await.unwrap();
            assert_eq!(submitted["state"], "submitted");
            assert_eq!(submitted["ok"], true);
            assert_eq!(submitted["txid"], txid);
            let uncertain = crate::run(&broadcast_cli).await.unwrap();
            assert_eq!(uncertain["state"], "uncertain");
            assert_eq!(uncertain["ok"], false);
            assert_eq!(uncertain["txid"], txid);
            let balance_cli = crate::Cli::try_parse_from([
                "optn",
                "--network",
                "chipnet",
                "--timeout",
                "2",
                "--network-config-dir",
                directory.0.to_str().unwrap(),
                "balance",
                address.as_str(),
            ])
            .unwrap();
            let balance = crate::run(&balance_cli).await.unwrap();
            assert_eq!(balance["selection"], "shared-native-policy");
            assert_eq!(balance["confirmed"], 1000);
            assert_eq!(balance["unconfirmed"], 0);
            assert_eq!(balance["evidence"], "ServerAssertion");
            let utxo_cli = crate::Cli::try_parse_from([
                "optn",
                "--network",
                "chipnet",
                "--timeout",
                "2",
                "--network-config-dir",
                directory.0.to_str().unwrap(),
                "utxos",
                address.as_str(),
            ])
            .unwrap();
            let utxos = crate::run(&utxo_cli).await.unwrap();
            assert_eq!(utxos["total"], balance["total"]);
            assert_eq!(utxos["count"], 1);
            assert_eq!(utxos["utxos"][0]["txid"], txid);
            assert_eq!(utxos["utxos"][0]["vout"], 0);
            assert_eq!(utxos["utxos"][0]["height"], 5);
            assert_eq!(utxos["utxos"][0]["token"]["amount"], 42);
            let rescan_cli = crate::Cli::try_parse_from([
                "optn",
                "--network",
                "chipnet",
                "--timeout",
                "2",
                "--network-config-dir",
                directory.0.to_str().unwrap(),
                "rescan",
                "--gap",
                "2",
                "--max-addresses",
                "6",
                "--all",
                "--account-path",
                "m/44'/145'/1'",
                "--xpub",
                &xpub,
            ])
            .unwrap();
            let rescan = crate::run(&rescan_cli).await.unwrap();
            assert_eq!(rescan["hd"], true);
            assert_eq!(rescan["complete"], true);
            assert_eq!(rescan["account_path"], "m/44'/145'/1'");
            assert_eq!(rescan["scanned_addresses"], 10);
            assert_eq!(rescan["branches"], json!([0, 1, 7, 2]));
            assert_eq!(rescan["last_used"], json!([1, null, null, null]));
            assert_eq!(rescan["utxos"], 1);
            assert_eq!(rescan["total"], 1000);
            assert_eq!(rescan["addresses"].as_array().unwrap().len(), 10);
            assert!(rescan["addresses"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["chain"] == "defi" && entry["branch"] == 7));
            assert!(rescan["addresses"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["chain"] == "compatibility" && entry["branch"] == 2));
            server.await.unwrap();
            directory.write(Network::Chipnet, UserNetworkOverlay::default());
            assert!(
                crate::run(&cli).await.is_err(),
                "empty policy must not use public defaults"
            );
            let unavailable = crate::run(&broadcast_cli).await.unwrap();
            assert_eq!(unavailable["state"], "unavailable");
            assert_eq!(unavailable["ok"], false);
        })
        .await
        .unwrap();
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

    #[tokio::test]
    async fn legacy_override_reader_and_cli_routes_never_gain_bootstrap_fallback() {
        use clap::Parser;
        use optn_runtime::chain::build_selection_plan;
        use optn_runtime::network_config::{legacy_server_policy, LEGACY_SERVER_CATALOG_VERSION};
        use serde_json::json;

        let directory = TestDirectory::new();
        let path = directory.0.join(file_name(Network::Chipnet));
        let base = [
            "optn",
            "--network",
            "chipnet",
            "--network-config-dir",
            directory.0.to_str().unwrap(),
        ];
        let status_cli =
            crate::Cli::try_parse_from(base.into_iter().chain(["network", "status"])).unwrap();
        let ping_cli = crate::Cli::try_parse_from(base.into_iter().chain(["ping"])).unwrap();
        for old_auto in [true, false] {
            let mut overlay = legacy_electrum("127.0.0.1");
            overlay.user_sources[0].endpoints[0].port = Some(1);
            let chosen = overlay.user_sources[0].id.clone();
            let explicit = legacy_server_policy(&overlay.user_sources);
            overlay.connection_policy = if old_auto {
                ConnectionPolicy::auto()
            } else {
                explicit.clone()
            };
            for availability in ["enabled", "disabled", "missing"] {
                let mut candidate = overlay.clone();
                match availability {
                    "disabled" => {
                        candidate.user_sources[0].disposition = SourceDisposition::Disabled;
                    }
                    "missing" => {
                        // Retain the chosen identity. An empty old Auto overlay
                        // means an intentional reset, not a missing pinned source.
                        candidate.connection_policy = explicit.clone();
                        candidate.user_sources.clear();
                    }
                    _ => {}
                }
                let saved =
                    NetworkConfigEnvelope::current(LEGACY_SERVER_CATALOG_VERSION, candidate);
                fs::write(&path, encode_envelope_json(&saved).unwrap()).unwrap();
                let before = fs::read(&path).unwrap();

                // Exactly the file reader and shared resolver used by Tauri's
                // NetworkSettingsStore::chain_selection, without linking Tauri.
                let reopened = NetworkConfigFile::new(path.clone())
                    .load()
                    .unwrap()
                    .unwrap();
                let gui_selection =
                    resolve_shipped_chain_selection(Network::Chipnet, Some(&reopened)).unwrap();
                let cli_selection = shared_chain_selection(Network::Chipnet, Some(&directory.0))
                    .unwrap()
                    .unwrap();
                assert_eq!(cli_selection.catalog, gui_selection.0);
                assert_eq!(cli_selection.policy, gui_selection.1);
                assert!(cli_selection
                    .catalog
                    .iter()
                    .any(|source| matches!(source.origin, SourceOrigin::Bootstrap { .. })));
                let plan = build_selection_plan(&cli_selection.catalog, &cli_selection.policy);
                let expected = if availability == "enabled" {
                    vec![chosen.clone()]
                } else {
                    Vec::new()
                };
                assert_eq!(
                    plan.primary, expected,
                    "old_auto={old_auto}, {availability}"
                );
                assert!(plan.fallback.is_empty());

                let status = crate::run(&status_cli).await.unwrap();
                assert!(status["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|source| source["origin"].as_str().unwrap().starts_with("Bootstrap")));
                assert_eq!(
                    status["primary"],
                    json!(expected.iter().map(SourceId::as_str).collect::<Vec<_>>())
                );
                assert_eq!(status["fallback"], json!([]));
                // Exercise the real CLI native builder only after proving its
                // plan cannot attempt any public endpoint, even on regression.
                let error =
                    tokio::time::timeout(std::time::Duration::from_secs(5), crate::run(&ping_cli))
                        .await
                        .expect("local failure must be bounded")
                        .unwrap_err()
                        .to_string();
                assert!(error.contains("no usable header route"), "{error}");
                if availability == "enabled" {
                    assert!(error.contains("127.0.0.1:1"), "{error}");
                }
                assert_eq!(
                    fs::read(&path).unwrap(),
                    before,
                    "reading must not rewrite policy"
                );
            }
        }
    }

    /// Under the desktop's default Auto selection, Electrum-only commands use
    /// the selection's own servers, in plan order, never a CLI default.
    #[test]
    fn auto_selection_offers_its_own_electrum_servers_in_order() {
        let directory = TestDirectory::new();
        directory.write(Network::Chipnet, UserNetworkOverlay::default());
        let servers = shared_electrum_servers(Network::Chipnet, Some(&directory.0))
            .unwrap()
            .expect("present configuration");
        let selection = shared_chain_selection(Network::Chipnet, Some(&directory.0))
            .unwrap()
            .unwrap();
        let plan = optn_runtime::chain::build_selection_plan(&selection.catalog, &selection.policy);
        let planned: Vec<(String, u16)> = plan
            .primary
            .iter()
            .filter_map(|id| selection.catalog.get(id))
            .flat_map(|source| source.endpoints.iter())
            .filter(|endpoint| endpoint.kind == EndpointKind::ElectrumTls)
            .map(|endpoint| (endpoint.host.clone(), endpoint.port.unwrap()))
            .collect();
        assert!(!planned.is_empty());
        let offered: Vec<(String, u16)> = servers
            .iter()
            .map(|server| (server.host().to_owned(), server.port()))
            .collect();
        assert_eq!(offered[..planned.len()], planned[..]);
        assert!(servers.iter().all(ElectrumEndpoint::encrypted));
        assert_eq!(
            shared_electrum(Network::Chipnet, Some(&directory.0))
                .unwrap()
                .map(|server| server.host().to_owned()),
            Some(planned[0].0.clone())
        );
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

    #[test]
    fn selecting_a_source_preserves_catalog_and_rejects_invalid_edits() {
        let directory = TestDirectory::new();
        let overlay = legacy_electrum("desktop.example");
        directory.write(Network::Chipnet, overlay.clone());
        select_source(
            Network::Chipnet,
            Some(&directory.0),
            "desktop-electrum",
            optn_runtime::chain::ProtocolFamily::Electrum,
        )
        .unwrap();
        let selected = shared_chain_selection(Network::Chipnet, Some(&directory.0))
            .unwrap()
            .unwrap();
        for source in &overlay.user_sources {
            assert_eq!(selected.catalog.get(&source.id), Some(source));
        }
        let plan = optn_runtime::chain::build_selection_plan(&selected.catalog, &selected.policy);
        assert_eq!(plan.primary, vec![SourceId::new("desktop-electrum")]);
        assert!(plan.fallback.is_empty());
        assert_eq!(
            selected.policy,
            ConnectionPolicy::exact(
                SourceId::new("desktop-electrum"),
                optn_runtime::chain::ProtocolFamily::Electrum
            )
        );
        let path = directory.0.join(file_name(Network::Chipnet));
        let before = fs::read(&path).unwrap();
        assert!(select_source(
            Network::Chipnet,
            Some(&directory.0),
            "missing",
            optn_runtime::chain::ProtocolFamily::Electrum
        )
        .is_err());
        assert!(select_source(
            Network::Chipnet,
            Some(&directory.0),
            "desktop-electrum",
            optn_runtime::chain::ProtocolFamily::Bip37
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        let lock = fs::OpenOptions::new()
            .write(true)
            .open(path.with_extension("lock"))
            .unwrap();
        lock.lock().unwrap();
        assert!(select_source(
            Network::Chipnet,
            Some(&directory.0),
            "desktop-electrum",
            optn_runtime::chain::ProtocolFamily::Electrum
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn selecting_unknown_source_without_overlay_fails_closed_for_every_protocol() {
        let directory = TestDirectory::new();
        for protocol in [
            optn_runtime::chain::ProtocolFamily::Electrum,
            optn_runtime::chain::ProtocolFamily::Bip37,
            optn_runtime::chain::ProtocolFamily::Neutrino,
            optn_runtime::chain::ProtocolFamily::BchnRpc,
        ] {
            let error = select_source(
                Network::Chipnet,
                Some(&directory.0),
                "public-fulcrum",
                protocol,
            )
            .unwrap_err();
            assert!(
                error.contains("source is missing, disabled, banned"),
                "{protocol:?}: {error}"
            );
        }
        assert!(
            !directory.0.join(file_name(Network::Chipnet)).exists(),
            "fail-closed select must not write a public Electrum overlay"
        );
    }

    #[test]
    fn empty_private_selection_never_becomes_a_public_default() {
        let directory = TestDirectory::new();
        directory.write(
            Network::Chipnet,
            UserNetworkOverlay {
                connection_policy: ConnectionPolicy::own_infrastructure(),
                ..Default::default()
            },
        );

        let selection = shared_chain_selection(Network::Chipnet, Some(&directory.0))
            .unwrap()
            .expect("present configuration");
        let plan = optn_runtime::chain::build_selection_plan(&selection.catalog, &selection.policy);
        assert!(plan.primary.is_empty());
        assert!(plan.fallback.is_empty());
        let error = shared_electrum(Network::Chipnet, Some(&directory.0)).unwrap_err();
        assert!(error.contains("cannot enforce network settings"));
        // A different network with no configuration remains distinguishable.
        assert!(shared_electrum(Network::Mainnet, Some(&directory.0))
            .unwrap()
            .is_none());
    }

    #[test]
    fn exposes_the_full_shared_selection_to_protocol_neutral_commands() {
        let directory = TestDirectory::new();
        let source = ChainSource {
            id: SourceId::new("my-peer"),
            label: "My node".into(),
            origin: SourceOrigin::UserInfrastructure {
                group: "home".into(),
            },
            endpoints: vec![Endpoint {
                kind: EndpointKind::BchP2p,
                host: "127.0.0.1".into(),
                port: Some(8333),
            }],
            capabilities: CapabilitySet::default(),
            disposition: SourceDisposition::Enabled,
            priority: 0,
        };
        let policy = ConnectionPolicy::exact(
            source.id.clone(),
            optn_runtime::chain::ProtocolFamily::Bip37,
        );
        directory.write(
            Network::Mainnet,
            UserNetworkOverlay {
                user_sources: vec![source.clone()],
                connection_policy: policy.clone(),
                ..Default::default()
            },
        );

        let selection = shared_chain_selection(Network::Mainnet, Some(&directory.0))
            .unwrap()
            .unwrap();
        assert_eq!(selection.policy, policy);
        assert_eq!(selection.catalog.get(&source.id), Some(&source));
    }

    #[test]
    fn refuses_a_direct_peer_route_instead_of_using_a_public_electrum_server() {
        let directory = TestDirectory::new();
        let overlay = UserNetworkOverlay {
            user_sources: vec![ChainSource {
                id: SourceId::new("desktop-peer"),
                label: "Desktop peer".into(),
                origin: SourceOrigin::UserAdded,
                endpoints: vec![Endpoint {
                    kind: EndpointKind::BchP2p,
                    host: "peer.example".into(),
                    port: Some(8333),
                }],
                capabilities: CapabilitySet::default(),
                disposition: SourceDisposition::Enabled,
                priority: 0,
            }],
            ..Default::default()
        };
        directory.write(Network::Mainnet, overlay);

        assert!(shared_electrum(Network::Mainnet, Some(&directory.0)).is_err());
    }
}
