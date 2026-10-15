//! `optn fusion`: CashFusion rounds for a saved wallet, through a server or
//! peer to peer over Nostr.
//!
//! Everything a round does runs in the shared native fusion host
//! (`optn-fusion-native`), the same code the desktop uses: coins chosen by
//! `optn_core::fusion::coin_selection`, keys and fresh change outputs from the
//! wallet runtime, tier plans, the Electron Cash protocol or the P2P one, and
//! a wait for the network to hold the transaction. This file only reads the
//! holder's settings, keeps the loop, and reports.
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

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use optn_app::fusion::{
    AUTO_FUSION_COOLDOWN_MS, AUTO_FUSION_DEPTH_MET_IDLE_MS, AUTO_FUSION_RETRY_MS,
};
use optn_core::fusion::coin_selection::{select_fusion_coins, FusionCoin, FusionTrigger};
use optn_core::fusion::depth::FusionDepthBook;
use optn_core::fusion::FusionMode;
use optn_fusion_native::depth_file::DepthFile;
use optn_fusion_native::lookups::LookupEndpoint;
use optn_fusion_native::p2p_round::{
    relay_host, run_p2p_round, P2pRoundSettings, FUSION_CORE_RELAYS,
};
use optn_fusion_native::server_round::{
    run_server_round, FusedRound, ServerRoundSettings, ServerTarget,
};
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

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
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

/// The synchronized wallet's coins, as coin selection sees them. Cash Code
/// coins are left out: their keys are not HD keys, and the round asks the
/// runtime for HD keys only.
fn fusion_coins(synced: &crate::SyncedHdWallet, book: &FusionDepthBook) -> Vec<FusionCoin> {
    let confirmed: std::collections::BTreeSet<String> = synced
        .snapshot
        .value
        .transactions
        .iter()
        .filter(|transaction| transaction.block_height.is_some())
        .map(|transaction| {
            let mut display = transaction.txid;
            display.reverse();
            optn_core::payment::hex(&display)
        })
        .collect();
    synced
        .state
        .coins
        .iter()
        .filter(|coin| !coin.is_rpa())
        .map(|coin| {
            let outpoint = coin.outpoint().to_string();
            FusionCoin {
                confirmed: confirmed.contains(&coin.outpoint().txid_hex()),
                address: coin.address().to_owned(),
                value_sats: coin.value_sats(),
                token: coin.token().is_some(),
                frozen: coin.freeze().is_some(),
                depth: book.depth_of(&outpoint),
                outpoint,
            }
        })
        .collect()
}

/// Sleep, unless the holder interrupts. Returns false when interrupted.
async fn pause(milliseconds: u64) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(milliseconds)) => true,
        _ = tokio::signal::ctrl_c() => false,
    }
}

/// Why no choice of `eligible` can fund a tier on the server, or `None` when
/// one might (or the server could not be asked, which proves nothing).
async fn unaffordable_reason(
    settings: &ServerRoundSettings,
    eligible: &[&FusionCoin],
) -> Option<String> {
    let hello = optn_fusion_native::server_round::server_hello(settings)
        .await
        .ok()?;
    let addresses: std::collections::BTreeSet<&str> =
        eligible.iter().map(|coin| coin.address.as_str()).collect();
    let values: Vec<u64> = eligible.iter().map(|coin| coin.value_sats).collect();
    optn_fusion::allocate::never_affordable(&hello, addresses.len(), &values)
        .ok()?
        .then(|| {
            format!(
                "No choice of this wallet's {} eligible coin(s) ({} sats at {} address(es)) can fund a fusion tier on this server; waiting for the wallet to change.",
                values.len(),
                values.iter().sum::<u64>(),
                addresses.len()
            )
        })
}

/// A round's settings, for the venue the holder chose.
enum Rounds {
    Server(ServerRoundSettings),
    P2p(P2pRoundSettings),
}

impl Rounds {
    fn mode(&self) -> FusionMode {
        match self {
            Rounds::Server(_) => FusionMode::Server,
            Rounds::P2p(_) => FusionMode::P2p,
        }
    }

    fn verified_proxy(&self) -> Option<u16> {
        match self {
            Rounds::Server(settings) => settings.verified_proxy,
            Rounds::P2p(settings) => settings.verified_proxy,
        }
    }

    /// Where rounds meet, for the progress lines and the result.
    fn venue(&self) -> Value {
        match self {
            Rounds::Server(settings) => json!({
                "mode": "server",
                "server": format!("{}:{}", settings.server.host, settings.server.port),
            }),
            Rounds::P2p(settings) => json!({"mode": "p2p", "relays": settings.relays}),
        }
    }

    async fn run(
        &self,
        runtime: &AppRuntime,
        coins: &[String],
        round_id: &str,
        status: &(dyn Fn(&str) + Send + Sync),
    ) -> std::result::Result<FusedRound, String> {
        match self {
            Rounds::Server(settings) => {
                run_server_round(runtime, settings, coins, round_id, status).await
            }
            Rounds::P2p(settings) => {
                run_p2p_round(runtime, settings, coins, round_id, status).await
            }
        }
    }

    /// Why no choice of `eligible` can fund a tier, when a server can say. A
    /// P2P pool has no server to ask.
    async fn unaffordable_reason(&self, eligible: &[&FusionCoin]) -> Option<String> {
        match self {
            Rounds::Server(settings) => unaffordable_reason(settings, eligible).await,
            Rounds::P2p(_) => None,
        }
    }
}

/// After `streak` rounds in a row that missed every tier by the draw: the
/// retry wait doubled each time, up to the idle wait.
fn unaffordable_backoff(streak: u32) -> u64 {
    AUTO_FUSION_RETRY_MS
        .saturating_mul(1u64 << streak.min(16))
        .min(AUTO_FUSION_DEPTH_MET_IDLE_MS)
}

pub(crate) async fn run(cli: &Cli, args: FusionArgs<'_>) -> Result<Value> {
    let handle = cli
        .wallet
        .as_deref()
        .ok_or_else(|| CliError::Usage("CashFusion needs a saved wallet: pass --wallet.".into()))?;
    let lookup_servers = lookup_servers(cli)?;
    let rounds = match args.venue {
        Venue::Server(server) => {
            let server = ServerTarget::parse(server).map_err(CliError::Usage)?;
            let verified_proxy =
                verified_proxy(cli, std::slice::from_ref(&server.host), &lookup_servers).await?;
            Rounds::Server(ServerRoundSettings {
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
            Rounds::P2p(P2pRoundSettings {
                network: cli.network,
                relays,
                verified_proxy,
                lookup_servers,
                auto: args.auto,
            })
        }
    };
    let legacy_depth = DepthFile::new(depth_path(cli, handle)?);
    let mut depth_imported = false;
    let trigger = if args.auto {
        FusionTrigger::Auto
    } else {
        FusionTrigger::Manual
    };
    // Without --auto, one round unless --rounds asks for more.
    let wanted = args.rounds.or((!args.auto).then_some(1));
    let mut fused = Vec::new();
    let mut attempts = 0u32;
    let mut stopped = None;
    // The eligible coins no choice of which can fund a tier, and how many
    // rounds in a row missed every tier by the draw.
    let mut never_for: Option<Vec<String>> = None;
    let mut unaffordable_streak = 0u32;

    loop {
        let synced =
            crate::sync_shared_wallet(cli, args.gap, args.max_addresses, None, None, None).await?;
        let runtime = wallet_security::open_managed_runtime(cli).await?;
        if !depth_imported {
            if let Some(path) = import_legacy_depth(runtime, &legacy_depth).await? {
                report(json!({"event": "depth_imported", "from": path}));
            }
            depth_imported = true;
        }
        let book = runtime.fusion_depth();
        let coins = fusion_coins(&synced, &book);
        let selection = select_fusion_coins(
            rounds.mode(),
            trigger,
            &coins,
            args.fuse_depth,
            &mut optn_fusion::allocate::os_uniform(),
        )
        .map_err(CliError::Usage)?;
        let eligible: Vec<&FusionCoin> = selection
            .classification
            .iter()
            .flat_map(|split| split.eligible.iter().flat_map(|bucket| bucket.coins.iter()))
            .collect();
        let mut eligible_outpoints: Vec<String> =
            eligible.iter().map(|coin| coin.outpoint.clone()).collect();
        eligible_outpoints.sort();
        if never_for.as_ref() == Some(&eligible_outpoints) {
            match rounds.unaffordable_reason(&eligible).await {
                Some(reason) => {
                    report(json!({"event": "idle", "reason": reason}));
                    if !pause(AUTO_FUSION_DEPTH_MET_IDLE_MS).await {
                        stopped = Some("interrupted".into());
                        break;
                    }
                    continue;
                }
                None => never_for = None,
            }
        } else if never_for.is_some() {
            // The wallet changed: rounds are worth trying again.
            never_for = None;
            unaffordable_streak = 0;
        }
        if selection.selected.is_empty() {
            let outpoints: Vec<String> = coins
                .iter()
                .filter(|coin| !coin.token && !coin.frozen)
                .map(|coin| coin.outpoint.clone())
                .collect();
            let reason = selection.empty_reason.clone().unwrap_or_else(|| {
                optn_core::fusion::depth::depth_met_message(
                    &book.eligibility(&outpoints, args.fuse_depth),
                )
            });
            if !args.auto {
                stopped = Some(reason);
                break;
            }
            report(json!({"event": "idle", "reason": reason}));
            if !pause(AUTO_FUSION_DEPTH_MET_IDLE_MS).await {
                stopped = Some("interrupted".into());
                break;
            }
            continue;
        }

        attempts += 1;
        let round_id = format!("cli-{}-{attempts}", std::process::id());
        let outpoints: Vec<String> = selection
            .selected
            .iter()
            .map(|coin| coin.outpoint.clone())
            .collect();
        let mut event = rounds.venue();
        event["event"] = json!("round");
        event["coins"] = json!(outpoints.len());
        report(event);
        // Ctrl-C cancels the round through the engine, which still finishes
        // what it must once components are disclosed.
        let interrupted = Arc::new(AtomicBool::new(false));
        let watcher = tokio::spawn({
            let interrupted = interrupted.clone();
            let round_id = round_id.clone();
            async move {
                if tokio::signal::ctrl_c().await.is_ok() {
                    interrupted.store(true, Ordering::SeqCst);
                    optn_fusion::round_cancel::cancel_round(&round_id);
                }
            }
        });
        let status = |line: &str| report(json!({"event": "status", "message": line}));
        let attempt = rounds.run(runtime, &outpoints, &round_id, &status).await;
        watcher.abort();
        if interrupted.load(Ordering::SeqCst) {
            stopped = Some("interrupted".into());
            break;
        }
        match attempt {
            Ok(round) => {
                unaffordable_streak = 0;
                // Only a transaction the network holds moves depth; a round
                // the network never saw leaves its coins where they were.
                if round.seen {
                    runtime
                        .record_fusion_round(round.spent.clone(), round.created.clone(), now_ms())
                        .await
                        .map_err(|error| CliError::Usage(wallet_security::message(error)))?;
                }
                let result = json!({
                    "txid": round.txid,
                    "seen": round.seen,
                    "spent": round.spent,
                    "created": round.created,
                });
                report(json!({"event": "fused", "round": result}));
                fused.push(result);
                if wanted.is_some_and(|wanted| fused.len() as u32 >= wanted) {
                    break;
                }
                if !pause(AUTO_FUSION_COOLDOWN_MS).await {
                    stopped = Some("interrupted".into());
                    break;
                }
            }
            Err(error) => {
                if !args.auto {
                    return Err(CliError::Network(error));
                }
                if optn_fusion::allocate::is_unaffordable(&error) {
                    if let Some(reason) = rounds.unaffordable_reason(&eligible).await {
                        never_for = Some(eligible_outpoints.clone());
                        report(json!({"event": "idle", "reason": reason}));
                        if !pause(AUTO_FUSION_DEPTH_MET_IDLE_MS).await {
                            stopped = Some("interrupted".into());
                            break;
                        }
                        continue;
                    }
                    // Above the floor, but the random output count missed
                    // every tier. Try again, less often each time.
                    unaffordable_streak += 1;
                    let delay = unaffordable_backoff(unaffordable_streak);
                    report(
                        json!({"event": "retry", "error": error, "transient": false, "next_in_ms": delay}),
                    );
                    if !pause(delay).await {
                        stopped = Some("interrupted".into());
                        break;
                    }
                    continue;
                }
                let transient = optn_app::fusion::is_auto_transient_failure(&error);
                report(json!({"event": "retry", "error": error, "transient": transient}));
                if !pause(AUTO_FUSION_RETRY_MS).await {
                    stopped = Some("interrupted".into());
                    break;
                }
            }
        }
    }

    let mut result = rounds.venue();
    for (key, value) in [
        ("ok", json!(true)),
        ("network", json!(cli.network.to_string())),
        ("tor", json!(rounds.verified_proxy())),
        ("rounds", json!(fused)),
        ("stopped", json!(stopped)),
        ("depth_record", json!("sealed with the wallet")),
    ] {
        result[key] = value;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

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
