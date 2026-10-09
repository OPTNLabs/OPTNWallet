//! One CashFusion server round for a wallet's coins, from the server's
//! advertised settings to a transaction the network holds.
//!
//! The steps, each in the crate that owns it:
//! 1. the server's settings, through a handshake that declares the wallet's
//!    chain (`optn_fusion::server_status`), refused if outside Electron Cash's
//!    limits;
//! 2. the offered coins' keys, from the wallet runtime;
//! 3. tier plans for those coins (`optn_fusion::allocate`);
//! 4. as many fresh outputs as the largest plan needs, reserved durably by the
//!    runtime;
//! 5. the round itself (`optn_fusion::run`), checking peers' inputs through the
//!    holder's own Electrum servers ([`crate::lookups`]);
//! 6. waiting for a selected server to hold the transaction. The fusion server
//!    broadcasts it; Electron Cash likewise waits up to a minute for its wallet
//!    to see the transaction before calling a round complete.
//!
//! Every remote leg goes through the verified Tor proxy. Only a loopback
//! server or lookup server is dialled directly.

use std::sync::Arc;
use std::time::Duration;

use optn_core::network::Network;
use optn_fusion::lookup::InputLookups;
use optn_fusion::run::{FusionInputKey, FusionRunParams, FusionTiming};
use optn_fusion::server_plan::ExpectedHello;
use optn_fusion::Transport;
use optn_runtime::AppRuntime;

use crate::lookups::{ChainInputLookups, LookupEndpoint};

/// Electron Cash's default server port.
pub const DEFAULT_SERVER_PORT: u16 = 8789;

/// How long a completed round waits for a selected server to hold its
/// transaction.
pub const BROADCAST_WAIT: Duration = Duration::from_secs(60);
const BROADCAST_POLL: Duration = Duration::from_secs(3);

/// A CashFusion server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerTarget {
    pub host: String,
    pub port: u16,
    pub use_ssl: bool,
}

impl ServerTarget {
    /// `host[:port][:s|:t]`, as Electron Cash and the desktop write a server.
    ///
    /// Without a suffix, a local server is plain TCP, because Electron Cash's
    /// `server.py` speaks no TLS of its own, and a remote one is TLS, because
    /// sending fusion traffic to the internet in the clear is the worse
    /// mistake. An explicit `:s` or `:t` always wins.
    pub fn parse(text: &str) -> Result<Self, String> {
        let invalid = || "CashFusion server address is invalid.".to_string();
        let token = text.split_whitespace().next().ok_or_else(invalid)?;
        let mut parts = token.split(':');
        let host = parts
            .next()
            .filter(|host| !host.is_empty())
            .ok_or_else(invalid)?;
        let mut port = None;
        let mut scheme = None;
        for part in parts {
            match part {
                "s" | "t" if scheme.is_none() => scheme = Some(part == "s"),
                digits if port.is_none() && scheme.is_none() => {
                    port = Some(
                        digits
                            .parse::<u16>()
                            .ok()
                            .filter(|port| *port > 0)
                            .ok_or_else(invalid)?,
                    );
                }
                _ => return Err(invalid()),
            }
        }
        Ok(Self {
            host: host.to_owned(),
            port: port.unwrap_or(DEFAULT_SERVER_PORT),
            use_ssl: scheme.unwrap_or(!optn_fusion::is_local_server(host)),
        })
    }
}

/// Everything about a round that is not the coins.
#[derive(Debug, Clone)]
pub struct ServerRoundSettings {
    pub network: Network,
    pub server: ServerTarget,
    /// The verified Tor proxy's SOCKS port on 127.0.0.1. Required whenever the
    /// server or a lookup server is remote.
    pub verified_proxy: Option<u16>,
    /// The holder's selected Electrum servers, primary first.
    pub lookup_servers: Vec<LookupEndpoint>,
    /// Stable per wallet. Hashed with a per-process salt into Electron Cash's
    /// self-fusion tag, so the server never puts this wallet in one fusion
    /// twice.
    pub wallet_tag: String,
    /// Auto's inactivity limit (Electron Cash: 600 s). `None` for a round a
    /// holder started by hand, which waits until cancelled.
    pub join_inactive_timeout: Option<Duration>,
    /// Register only these tiers, so wallets that must meet can.
    pub only_tiers: Option<Vec<u64>>,
}

/// A completed round.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FusedRound {
    /// Display order.
    pub txid: String,
    pub tx_hex: String,
    /// The wallet's coins the round spent, display-order `txid:vout`.
    pub spent: Vec<String>,
    /// The wallet's outputs in the fusion, display-order `txid:vout`.
    pub created: Vec<String>,
    /// A selected Electrum server held the transaction within
    /// [`BROADCAST_WAIT`].
    pub seen: bool,
}

/// A wallet runtime refusal, in words.
fn runtime_refusal(error: optn_transport::TransportError) -> String {
    use optn_transport::TransportError;
    match error {
        TransportError::Other(message) | TransportError::InvalidData(message) => message,
        TransportError::AuthenticationRequired => "The wallet is locked; unlock it to fuse.".into(),
        TransportError::Unsupported => {
            "This wallet cannot sign fusion inputs: it is watch-only or not runtime-managed.".into()
        }
        TransportError::Closed => "The wallet runtime stopped.".into(),
    }
}

/// The chain's genesis hash in internal byte order: the hash of the runtime's
/// own anchored genesis header, so a round declares exactly the chain the
/// wallet verifies headers from.
pub fn genesis_hash(network: Network) -> Result<[u8; 32], String> {
    let header =
        optn_core::payment::decode_hex(optn_runtime::header_verifier::genesis_header_hex(network))?;
    Ok(optn_core::header_hash::sha256d(&header))
}

/// The route for one leg: loopback directly, anything else only through the
/// verified proxy.
pub fn transport_for(
    host: &str,
    verified_proxy: Option<u16>,
) -> Result<Transport<'static>, String> {
    if optn_fusion::is_local_server(host) {
        return Ok(Transport::Direct);
    }
    let port = verified_proxy
        .ok_or_else(|| format!("{host} is remote and no verified Tor proxy is available"))?;
    Ok(Transport::Tor {
        host: optn_fusion::tor::DEFAULT_TOR_HOST,
        port,
    })
}

/// The wallet's outputs in a fusion transaction, display-order `txid:vout`.
pub fn wallet_outputs(
    txid: &str,
    tx_hex: &str,
    scripts: &[Vec<u8>],
) -> Result<Vec<String>, String> {
    let raw = optn_core::payment::decode_hex(tx_hex)?;
    let decoded = optn_core::tx::decode(&raw).map_err(|error| error.to_string())?;
    Ok(decoded
        .outputs
        .iter()
        .enumerate()
        .filter(|(_, output)| scripts.contains(&output.script_pubkey))
        .map(|(vout, _)| format!("{}:{vout}", txid.to_ascii_lowercase()))
        .collect())
}

/// Wait until a selected server holds `txid` (display order), up to `limit`.
pub async fn wait_until_seen(lookups: &dyn InputLookups, txid: &str, limit: Duration) -> bool {
    let Ok(mut wire) = optn_core::payment::decode_hex(txid) else {
        return false;
    };
    wire.reverse();
    let Ok(wire): Result<[u8; 32], _> = wire.try_into() else {
        return false;
    };
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        if let Ok(true) = lookups.transaction_is_known(wire).await {
            return true;
        }
        if tokio::time::Instant::now() + BROADCAST_POLL > deadline {
            return false;
        }
        tokio::time::sleep(BROADCAST_POLL).await;
    }
}

/// Run one server round for `coins` (display-order `txid:vout`) of the wallet
/// open in `runtime`. `round_id` names the round in the cancellation registry
/// (`optn_fusion::round_cancel::cancel_round`). `status` receives short
/// progress lines.
pub async fn run_server_round(
    runtime: &AppRuntime,
    settings: &ServerRoundSettings,
    coins: &[String],
    round_id: &str,
    status: &(dyn Fn(&str) + Send + Sync),
) -> Result<FusedRound, String> {
    optn_fusion::round_cancel::prepare_round(round_id)?;
    let registration = optn_fusion::round_cancel::acquire_round(round_id)?;
    let server = &settings.server;
    let main_transport = transport_for(&server.host, settings.verified_proxy)?;
    for lookup in &settings.lookup_servers {
        transport_for(&lookup.host, settings.verified_proxy)?;
    }
    if settings.lookup_servers.is_empty() {
        return Err("no Electrum server is selected to check this round's inputs".into());
    }
    let genesis = genesis_hash(settings.network)?;

    status(&format!(
        "Contacting fusion server {}:{}…",
        server.host, server.port
    ));
    let advertised = optn_fusion::server_status(
        &server.host,
        server.port,
        server.use_ssl,
        main_transport,
        Some(genesis.to_vec()),
    )
    .await?;
    let expected_hello = ExpectedHello {
        tiers: advertised.tiers,
        num_components: advertised.num_components,
        component_feerate: advertised.component_feerate,
        min_excess_fee: advertised.min_excess_fee,
        max_excess_fee: advertised.max_excess_fee,
    };
    registration.flag().check()?;

    status("Preparing inputs…");
    let keys = runtime
        .fusion_input_keys(coins.to_vec())
        .await
        .map_err(runtime_refusal)?;
    let contribution: Vec<(Vec<u8>, u64)> = keys
        .iter()
        .map(|key| (key.pubkey.to_vec(), key.value_sats))
        .collect();
    let tier_plans = optn_fusion::allocate::plan_contribution(
        &expected_hello,
        &contribution,
        settings.only_tiers.as_deref(),
        &mut optn_fusion::allocate::os_uniform(),
    )?;
    let outputs = tier_plans
        .iter()
        .map(|plan| plan.output_values.len())
        .max()
        .unwrap_or(0);
    registration.flag().check()?;
    let output_scripts = runtime
        .reserve_change_outputs(outputs)
        .await
        .map_err(runtime_refusal)?;

    let lookups = Arc::new(ChainInputLookups::electrum(
        settings.network,
        settings.lookup_servers.clone(),
        settings.verified_proxy,
    ));
    status(&format!(
        "In the server pool ({} tier(s), {} coin(s)), waiting for other wallets…",
        tier_plans.len(),
        keys.len()
    ));
    let outcome = optn_fusion::run::run_fusion(FusionRunParams {
        host: &server.host,
        port: server.port,
        use_ssl: server.use_ssl,
        tier_plans,
        inputs: keys
            .iter()
            .map(|key| FusionInputKey {
                prev_txid: key.txid.clone(),
                prev_index: key.vout,
                pubkey: key.pubkey.to_vec(),
                value: key.value_sats,
                privkey: *key.privkey,
            })
            .collect(),
        output_scripts: output_scripts.clone(),
        genesis_hash: genesis,
        main_transport,
        remote_transport: settings.verified_proxy.map(|port| Transport::Tor {
            host: optn_fusion::tor::DEFAULT_TOR_HOST,
            port,
        }),
        lookups: lookups.clone(),
        timing: FusionTiming::default(),
        join_inactive_timeout: settings.join_inactive_timeout,
        cancel: registration.flag(),
        expected_hello,
        wallet_tag_seed: settings.wallet_tag.clone().into_bytes(),
        // Electron Cash's default (conf.py SelfFusePlayers = 1): never place
        // this wallet in a fusion with itself.
        self_fuse_limit: 1,
    })
    .await?;
    drop(registration);
    if !outcome.ok {
        return Err(outcome.message);
    }
    let (Some(txid), Some(tx_hex)) = (outcome.txid, outcome.tx_hex) else {
        return Err("the round finished without a signed transaction".into());
    };
    let created = wallet_outputs(&txid, &tx_hex, &output_scripts)?;

    status("Round complete; waiting for the network to show the transaction…");
    let seen = wait_until_seen(lookups.as_ref(), &txid, BROADCAST_WAIT).await;
    Ok(FusedRound {
        txid: txid.to_ascii_lowercase(),
        tx_hex,
        spent: coins
            .iter()
            .map(|coin| coin.trim().to_ascii_lowercase())
            .collect(),
        created,
        seen,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_addresses_parse_like_the_desktop() {
        assert_eq!(
            ServerTarget::parse("fusion.example:8789").unwrap(),
            ServerTarget {
                host: "fusion.example".into(),
                port: 8789,
                use_ssl: true
            }
        );
        assert_eq!(
            ServerTarget::parse("localhost:8788:t").unwrap(),
            ServerTarget {
                host: "localhost".into(),
                port: 8788,
                use_ssl: false
            }
        );
        // A local server speaks plain TCP unless told otherwise.
        assert!(!ServerTarget::parse("127.0.0.1:8787").unwrap().use_ssl);
        assert!(ServerTarget::parse("127.0.0.1:8787:s").unwrap().use_ssl);
        assert!(
            !ServerTarget::parse("fusion.servo.cash:8789:t")
                .unwrap()
                .use_ssl
        );
        assert_eq!(ServerTarget::parse("fusion.example").unwrap().port, 8789);
        for bad in [
            "",
            ":8789",
            "host:70000",
            "host:0",
            "host:x",
            "host:1:s:t",
            "host:s:1",
        ] {
            assert!(ServerTarget::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn remote_legs_need_the_verified_proxy() {
        assert!(matches!(
            transport_for("127.0.0.1", None).unwrap(),
            Transport::Direct
        ));
        assert!(transport_for("fusion.example", None).is_err());
        assert!(matches!(
            transport_for("fusion.example", Some(9050)).unwrap(),
            Transport::Tor { port: 9050, .. }
        ));
    }

    #[test]
    fn a_round_declares_the_chain_the_wallet_verifies() {
        let mut chipnet = genesis_hash(Network::Chipnet).unwrap();
        chipnet.reverse();
        assert_eq!(
            optn_core::payment::hex(&chipnet),
            "000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b"
        );
        let mut mainnet = genesis_hash(Network::Mainnet).unwrap();
        mainnet.reverse();
        assert_eq!(
            optn_core::payment::hex(&mainnet),
            "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
        );
    }

    #[test]
    fn the_wallets_outputs_are_found_by_script() {
        let ours = vec![0x76, 0xa9, 0x14, 1, 2, 3];
        let theirs = vec![0x51];
        let transaction = optn_core::tx::Transaction::new(
            vec![],
            vec![
                optn_core::tx::Output::new(5_000, theirs),
                optn_core::tx::Output::new(6_000, ours.clone()),
            ],
        )
        .sign(&[])
        .unwrap();
        let tx_hex = optn_core::payment::hex(&transaction);
        assert_eq!(
            wallet_outputs("AB", &tx_hex, &[ours]).unwrap(),
            vec!["ab:1".to_string()]
        );
        assert!(wallet_outputs("ab", "zz", &[]).is_err());
    }
}
