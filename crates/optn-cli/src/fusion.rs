//! `optn fusion`: CashFusion rounds for a saved wallet, through a server or
//! peer to peer over Nostr.
//!
//! Everything a round does runs in the shared native fusion host
//! (`optn-fusion-native`), the same code the desktop uses: coins chosen by
//! `optn_core::fusion::coin_selection`, keys and fresh change outputs from the
//! wallet runtime, tier plans, the Electron Cash protocol or the P2P one, and
//! a wait for the network to hold the transaction. The loop itself -- coin
//! choice, holds, the depth record and Auto's timing -- is the shared driver
//! (`optn_fusion_native::driver`), the one the desktop and the docker lab
//! run. This file only reads the holder's settings and reports.
//!
//! Tor follows the desktop's rule: CashFusion runs only while the holder's
//! transport keeps public destinations on Tor, and every remote leg goes
//! through a verified proxy. A loopback server, loopback relays and loopback
//! lookup servers need neither.
//!
//! The depth record (`optn_core::fusion::depth`) is the wallet runtime's,
//! sealed with the wallet's encrypted checkpoint: a round the network holds is
//! saved there before the next one starts. Earlier builds kept it in a
//! plaintext file beside the wallet; that file is merged in once and removed.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use optn_fusion_native::depth_file::DepthFile;
use optn_fusion_native::driver::{self, DriverError, DriverOptions, FusionHost, FusionWallet};
use optn_fusion_native::lookups::LookupEndpoint;
use optn_fusion_native::p2p_round::{relay_host, P2pRoundSettings, FUSION_CORE_RELAYS};
use optn_fusion_native::server_round::{ServerRoundSettings, ServerTarget};
use optn_runtime::AppRuntime;
use serde_json::{json, Value};

use crate::error::{CliError, Result};
use crate::{network_settings, wallet_security, Cli};

const FUSION_NEEDS_TOR: &str =
    "CashFusion needs Tor, and Tor is off for this network. Turn it on (optn network tor on) to fuse.";

/// How many of the holder's Electrum servers a round checks inputs with, as
/// on the desktop.
const LOOKUP_SERVER_LIMIT: usize = 8;

/// Where a round meets the wallets it fuses with.
pub(crate) enum Venue<'a> {
    /// A CashFusion server: host[:port][:s|:t].
    Server(&'a str),
    /// Peer to peer over these Nostr relays; the desktop's set when empty.
    P2p { relays: &'a [String] },
}

pub(crate) struct FusionArgs<'a> {
    pub venue: Venue<'a>,
    pub auto: bool,
    pub rounds: Option<u32>,
    pub fuse_depth: u32,
    pub tiers: &'a [u64],
    pub gap: u32,
    pub max_addresses: u32,
}

/// A progress line on stderr, so stdout stays the command's one JSON result.
fn report(event: Value) {
    eprintln!("{event}");
}

/// The holder's Electrum servers for checking inputs: an explicit `--host`,
/// else the shared selection, else the network's default.
fn lookup_servers(cli: &Cli) -> Result<Vec<LookupEndpoint>> {
    if let Some(host) = &cli.host {
        return Ok(vec![LookupEndpoint {
            host: host.clone(),
            port: cli.port.unwrap_or_else(|| cli.network.default_port()),
            tls: !cli.no_tls,
        }]);
    }
    let selected =
        network_settings::shared_electrum_servers(cli.network, cli.network_config_dir.as_deref())
            .map_err(CliError::Usage)?;
    Ok(match selected {
        Some(servers) => servers
            .iter()
            .take(LOOKUP_SERVER_LIMIT)
            .map(|server| LookupEndpoint {
                host: server.host().to_owned(),
                port: server.port(),
                tls: server.encrypted(),
            })
            .collect(),
        None => vec![LookupEndpoint {
            host: cli.network.default_host().to_owned(),
            port: cli.network.default_port(),
            tls: true,
        }],
    })
}

/// The verified Tor proxy every remote leg needs, or `None` when every leg is
/// loopback. `hosts` are where the round meets: the server, or the relays.
async fn verified_proxy(
    cli: &Cli,
    hosts: &[String],
    lookups: &[LookupEndpoint],
) -> Result<Option<u16>> {
    let remote = hosts
        .iter()
        .map(String::as_str)
        .chain(lookups.iter().map(|lookup| lookup.host.as_str()))
        .any(|host| !optn_fusion::is_local_server(host));
    if !remote {
        return Ok(None);
    }
    for host in hosts {
        let (transport, _) = network_settings::transport_for_host(
            cli.network,
            cli.network_config_dir.as_deref(),
            host,
        );
        if !transport.tor_for(false) {
            return Err(CliError::Usage(FUSION_NEEDS_TOR.into()));
        }
    }
    let trusted =
        network_settings::trusted_socks_ports(cli.network, cli.network_config_dir.as_deref());
    match optn_chain_native::tor_status_from_trust(optn_chain_native::TorProxyTrust {
        managed: &[],
        trusted: &trusted,
    })
    .await
    {
        optn_core::tor::TorStatus::Verified { socks_port } => Ok(Some(socks_port)),
        status => Err(CliError::Usage(format!(
            "CashFusion needs a verified Tor proxy for its remote legs ({status:?}). Start \
             Tor and trust its port under Privacy & Transport in the desktop; the CLI reads \
             the same shared settings."
        ))),
    }
}

/// Where this wallet's depth record lives: beside its wallet file.
/// Where earlier builds kept the depth record, in plaintext.
fn depth_path(cli: &Cli, handle: &str) -> Result<PathBuf> {
    let directory = cli
        .wallet_directory
        .clone()
        .or_else(|| dirs::data_dir().map(|root| root.join("com.optilabs.wallet").join("wallets")))
        .ok_or_else(|| CliError::Usage("Specify --wallet-directory.".into()))?;
    let name: String = handle
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    Ok(directory
        .join(".state")
        .join(format!("fusion-depth-{}-{name}.json", cli.network)))
}

/// Merge the plaintext depth record earlier builds kept beside the wallet into
/// the runtime's sealed one, then remove the file. The merge keeps the deeper
/// entry, so nothing recorded on either side is lost. Returns the file's path
/// when there was one.
async fn import_legacy_depth(runtime: &AppRuntime, file: &DepthFile) -> Result<Option<String>> {
    if !file.path().exists() {
        return Ok(None);
    }
    let book = file.load().map_err(CliError::Usage)?;
    runtime
        .import_fusion_depth(
            Some(book.stored_coins()),
            Some(book.stored_tx_depth()),
            book.fusion_txids().map(str::to_owned).collect(),
        )
        .await
        .map_err(|error| CliError::Usage(wallet_security::message(error)))?;
    let path = file.path().display().to_string();
    std::fs::remove_file(file.path()).map_err(|error| {
        CliError::Usage(format!(
            "The depth record from {path} is now sealed with the wallet, but the file could not be removed: {error}"
        ))
    })?;
    Ok(Some(path))
}

/// The CLI's side of the shared driver: it syncs the saved wallet before each
/// round, keeps no holds of its own, prints progress on stderr, and stops on
/// Ctrl-C -- cancelling a running round through the engine, which still
/// finishes what it must once components are disclosed.
struct CliHost<'a> {
    cli: &'a Cli,
    gap: u32,
    max_addresses: u32,
    interrupted: Arc<AtomicBool>,
    round: Arc<Mutex<Option<String>>>,
    wake: Arc<tokio::sync::Notify>,
    /// The error that stopped a sync, kept whole for the exit status.
    failure: Mutex<Option<CliError>>,
}

impl FusionHost for CliHost<'_> {
    async fn refresh(&self) -> std::result::Result<&dyn FusionWallet, String> {
        let synced = async {
            crate::sync_shared_wallet(self.cli, self.gap, self.max_addresses, None, None, None)
                .await?;
            wallet_security::open_managed_runtime(self.cli).await
        }
        .await;
        match synced {
            Ok(runtime) => Ok(runtime as &dyn FusionWallet),
            Err(error) => {
                let message = error.to_string();
                *self.failure.lock().unwrap_or_else(|p| p.into_inner()) = Some(error);
                Err(message)
            }
        }
    }

    async fn held(&self) -> std::result::Result<BTreeSet<String>, String> {
        Ok(BTreeSet::new())
    }

    fn report(&self, event: Value) {
        report(event);
    }

    async fn pause(&self, ms: u64) -> bool {
        // Registered before the check, so a Ctrl-C between the two still
        // wakes this wait.
        let woken = self.wake.notified();
        if self.interrupted.load(Ordering::SeqCst) {
            return false;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(ms)) => {
                !self.interrupted.load(Ordering::SeqCst)
            }
            _ = woken => false,
        }
    }

    fn round_started(&self, round_id: &str) {
        *self.round.lock().unwrap_or_else(|p| p.into_inner()) = Some(round_id.to_owned());
    }

    fn stopped(&self) -> bool {
        self.interrupted.load(Ordering::SeqCst)
    }
}

pub(crate) async fn run(cli: &Cli, args: FusionArgs<'_>) -> Result<Value> {
    let handle = cli
        .wallet
        .as_deref()
        .ok_or_else(|| CliError::Usage("CashFusion needs a saved wallet: pass --wallet.".into()))?;
    let lookup_servers = lookup_servers(cli)?;
    let venue = match args.venue {
        Venue::Server(server) => {
            let server = ServerTarget::parse(server).map_err(CliError::Usage)?;
            let verified_proxy =
                verified_proxy(cli, std::slice::from_ref(&server.host), &lookup_servers).await?;
            driver::Venue::Server(ServerRoundSettings {
                network: cli.network,
                server,
                verified_proxy,
                lookup_servers,
                wallet_tag: handle.to_owned(),
                join_inactive_timeout: args
                    .auto
                    .then_some(optn_fusion::run::EC_AUTOFUSE_INACTIVE_TIMEOUT),
                only_tiers: (!args.tiers.is_empty()).then(|| args.tiers.to_vec()),
            })
        }
        Venue::P2p { relays } => {
            let relays: Vec<String> = if relays.is_empty() {
                FUSION_CORE_RELAYS
                    .iter()
                    .map(|relay| relay.to_string())
                    .collect()
            } else {
                relays.to_vec()
            };
            let hosts = relays
                .iter()
                .map(|relay| {
                    relay_host(relay).ok_or_else(|| {
                        CliError::Usage(format!("{relay} is not a Nostr relay address"))
                    })
                })
                .collect::<Result<Vec<String>>>()?;
            let verified_proxy = verified_proxy(cli, &hosts, &lookup_servers).await?;
            driver::Venue::P2p(P2pRoundSettings {
                network: cli.network,
                relays,
                verified_proxy,
                lookup_servers,
                auto: args.auto,
            })
        }
    };
    // An earlier build's plaintext depth record is merged in once, before the
    // first round chooses coins by depth.
    let runtime = wallet_security::open_managed_runtime(cli).await?;
    let legacy_depth = DepthFile::new(depth_path(cli, handle)?);
    if let Some(path) = import_legacy_depth(runtime, &legacy_depth).await? {
        report(json!({"event": "depth_imported", "from": path}));
    }

    let host = CliHost {
        cli,
        gap: args.gap,
        max_addresses: args.max_addresses,
        interrupted: Arc::default(),
        round: Arc::default(),
        wake: Arc::default(),
        failure: Mutex::default(),
    };
    let watcher = tokio::spawn({
        let (interrupted, round, wake) = (
            Arc::clone(&host.interrupted),
            Arc::clone(&host.round),
            Arc::clone(&host.wake),
        );
        async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                interrupted.store(true, Ordering::SeqCst);
                if let Some(id) = round.lock().unwrap_or_else(|p| p.into_inner()).clone() {
                    optn_fusion::round_cancel::cancel_round(&id);
                }
                wake.notify_waiters();
            }
        }
    });
    let outcome = driver::run(
        &host,
        &venue,
        DriverOptions {
            auto: args.auto,
            rounds: args.rounds,
            fuse_depth: args.fuse_depth,
        },
    )
    .await;
    watcher.abort();
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(DriverError::Round(error)) => return Err(CliError::Network(error)),
        Err(DriverError::Other(error)) => {
            let synced = host
                .failure
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take();
            return Err(synced.unwrap_or(CliError::Usage(error)));
        }
    };

    let mut result = venue.describe();
    for (key, value) in [
        ("ok", json!(true)),
        ("network", json!(cli.network.to_string())),
        ("tor", json!(venue.verified_proxy())),
        ("rounds", json!(outcome.fused)),
        ("stopped", json!(outcome.stopped)),
        ("depth_record", json!("sealed with the wallet")),
    ] {
        result[key] = value;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_core::fusion::depth::FusionDepthBook;

    #[test]
    fn earlier_builds_kept_the_depth_record_beside_the_wallet_per_network() {
        use clap::Parser;
        let cli = Cli::parse_from([
            "optn",
            "--network",
            "chipnet",
            "--wallet-directory",
            "wallets",
            "--wallet",
            "fleet 01.optnwallet",
            "ping",
        ]);
        assert_eq!(
            depth_path(&cli, "fleet 01.optnwallet").unwrap(),
            PathBuf::from("wallets")
                .join(".state")
                .join("fusion-depth-chipnet-fleet_01.optnwallet.json")
        );
    }

    /// The plaintext record an earlier build left beside the wallet is merged
    /// into the runtime's, sealed with the wallet, and removed; a fresh
    /// runtime over the same directory reads it back.
    #[tokio::test]
    async fn an_earlier_builds_plaintext_record_is_sealed_with_the_wallet_and_removed() {
        use optn_app::{AppState, SecretText};
        use optn_core::hd::{AccountPath, BIP39_TEST_VECTOR_MNEMONIC};
        use optn_core::network::Network;
        use optn_runtime::wallet_security::WalletSecurity;
        use optn_transport::WalletSecurityRequest as Request;

        let directory = tempfile::tempdir().unwrap();
        let secret = |text: &str| SecretText::new(text.into());
        let start = || {
            let storage = optn_platform_native::wallet_storage::NativeWalletStorage::new(
                directory.path().to_path_buf(),
            );
            let checkpoints = optn_chain_native::wallet_checkpoint::WalletCheckpointDirectory(
                directory.path().join(".state"),
            );
            let (runtime, driver) = AppRuntime::new_with_security(
                AppState {
                    network: Network::Chipnet,
                    ..Default::default()
                },
                WalletSecurity::new(Box::new(storage), None)
                    .with_checkpoints(Box::new(checkpoints)),
            )
            .unwrap();
            (runtime, tokio::spawn(driver.run()))
        };

        let (runtime, task) = start();
        let handle = runtime
            .wallet_security(Request::Create {
                name: "depth".into(),
                mnemonic: secret(BIP39_TEST_VECTOR_MNEMONIC),
                bip39_passphrase: secret(""),
                password: secret(""),
                confirmation: secret(""),
                network: "chipnet".into(),
                account_path: AccountPath::default_for(Network::Chipnet).to_string(),
                draft: None,
            })
            .await
            .unwrap()
            .active
            .unwrap();

        let fused = format!("{}:0", "ab".repeat(32));
        let mut earlier = FusionDepthBook::new();
        earlier.record_round(&[], std::slice::from_ref(&fused), 5);
        let file = DepthFile::new(
            directory
                .path()
                .join(".state")
                .join("fusion-depth-chipnet-depth.json"),
        );
        file.save(&earlier).unwrap();

        assert_eq!(
            import_legacy_depth(&runtime, &file).await.unwrap(),
            Some(file.path().display().to_string())
        );
        assert!(!file.path().exists());
        assert_eq!(runtime.fusion_depth().depth_of(&fused), 1);
        assert_eq!(import_legacy_depth(&runtime, &file).await.unwrap(), None);
        drop(runtime);
        task.await.unwrap();

        let (runtime, task) = start();
        runtime
            .wallet_security(Request::Open {
                handle,
                password: secret(""),
            })
            .await
            .unwrap();
        assert_eq!(runtime.fusion_depth().depth_of(&fused), 1);
        drop(runtime);
        task.await.unwrap();
    }
}
