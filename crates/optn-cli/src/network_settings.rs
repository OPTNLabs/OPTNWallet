//! Shared desktop/CLI network-setting lookup.
//!
//! The CLI remains Tauri-free so it cross-compiles, but it reads the same
//! versioned per-network overlay that the desktop shell writes.

use std::env;
use std::path::{Path, PathBuf};

use optn_chain_native::network_config::NetworkConfigFile;
use optn_core::endpoint::{parse_electrum_endpoint, ElectrumEndpoint};
use optn_core::network::Network;
use optn_runtime::chain::{ConnectionPolicy, SourceCatalog};
use optn_runtime::network_config::{
    legacy_network_servers_from_overlay,
    resolve_chain_selection as resolve_persisted_chain_selection, NetworkConfigEnvelope,
    NetworkConfigStore,
};

const APP_CONFIG_IDENTIFIER: &str = "com.optilabs.wallet";

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
            let mut envelope =
                existing.ok_or("no shared sources are configured; configure a source first")?;
            let (catalog, _) =
                resolve_persisted_chain_selection(&SourceCatalog::default(), &envelope)
                    .map_err(|error| format!("invalid network settings: {error:?}"))?;
            let id = optn_runtime::chain::SourceId::new(source);
            let policy = ConnectionPolicy::exact(id.clone(), protocol);
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
    let Some(envelope) = shared_envelope(network, configured_directory)? else {
        return Ok(None);
    };
    let (catalog, policy) = resolve_persisted_chain_selection(&SourceCatalog::default(), &envelope)
        .map_err(|error| format!("cannot enforce network settings: {error:?}"))?;
    Ok(Some(SharedChainSelection { catalog, policy }))
}

/// Load the desktop-selected encrypted Electrum endpoint for one network.
///
/// Missing settings deliberately return `None`, preserving the CLI's built-in
/// network default. A present but unsupported or corrupt setting returns an
/// error: falling back would violate an explicit user selection.
pub fn shared_electrum(
    network: Network,
    configured_directory: Option<&Path>,
) -> Result<Option<ElectrumEndpoint>, String> {
    let Some(envelope) = shared_envelope(network, configured_directory)? else {
        return Ok(None);
    };
    let servers = legacy_network_servers_from_overlay(&envelope.overlay).map_err(|error| {
        format!("cannot enforce network settings in an Electrum-only command: {error}")
    })?;
    if servers.peer.is_some() {
        return Err(
            "shared network settings include a direct BCH P2P route that this Electrum-only CLI cannot enforce"
                .into(),
        );
    }
    let Some(entry) = servers.electrum else {
        return Err(
            "shared network settings contain no Electrum route; refusing a default server".into(),
        );
    };
    let endpoint = parse_electrum_endpoint(&entry, network.default_port())
        .map_err(|error| format!("invalid shared Electrum endpoint: {error}"))?;
    if !endpoint.encrypted() {
        return Err("shared network settings selected plaintext Electrum".into());
    }
    Ok(Some(endpoint))
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
            for _ in 0..17 {
                let (socket, _) = listener.accept().await.unwrap();
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
                        "blockchain.scripthash.get_history" => {
                            json!([{"tx_hash":expected_txid,"height":5}])
                        }
                        "blockchain.scripthash.get_mempool" => json!([]),
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
        assert_eq!(
            selected.catalog.iter().cloned().collect::<Vec<_>>(),
            overlay.user_sources
        );
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
    fn select_without_overlay_fails_closed_for_every_protocol() {
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
                error.contains("no shared sources are configured"),
                "{protocol:?}: {error}"
            );
        }
        assert!(
            !directory.0.join(file_name(Network::Chipnet)).exists(),
            "fail-closed select must not write a public Electrum overlay"
        );
    }

    #[test]
    fn empty_persisted_selection_never_becomes_a_public_default() {
        let directory = TestDirectory::new();
        directory.write(Network::Chipnet, UserNetworkOverlay::default());

        let selection = shared_chain_selection(Network::Chipnet, Some(&directory.0))
            .unwrap()
            .expect("present configuration");
        assert_eq!(selection.catalog.iter().count(), 0);
        let error = shared_electrum(Network::Chipnet, Some(&directory.0)).unwrap_err();
        assert!(error.contains("refusing a default server"));
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
