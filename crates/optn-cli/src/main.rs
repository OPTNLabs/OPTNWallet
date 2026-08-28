//! optn — the OPTN Wallet command-line interface.
//!
//! Built to be driven by scripts and agents as much as by people: every
//! command speaks `--json`, data goes to stdout and diagnostics to stderr so
//! piping works, and failures carry distinct exit codes (see error.rs).
//!
//! This crate deliberately does not depend on the desktop crate. src-tauri
//! pulls in tauri, which pulls in webkit2gtk on Linux — the reason the desktop
//! app cannot be cross-compiled. Staying Tauri-free is what lets `optn` build
//! for riscv64 and anything else Rust targets.

mod cashaddr;
mod electrum;
mod error;
mod hd;
mod network;
mod tx;

use clap::{Parser, Subcommand};
use serde_json::{json, Value};

use bip39::{Language, Mnemonic};

use cashaddr::Address;
use electrum::Client;
use error::{CliError, Result};
use hd::Wallet;
use network::Network;

#[derive(Parser)]
#[command(name = "optn", version, about = "OPTN Wallet command-line interface")]
struct Cli {
    /// Emit JSON instead of human-readable text.
    #[arg(long, global = true)]
    json: bool,

    /// Which chain to talk to.
    #[arg(long, global = true, default_value = "mainnet")]
    network: Network,

    /// Electrum host. Defaults to the server for the selected network.
    #[arg(long, global = true)]
    host: Option<String>,

    /// Electrum port.
    #[arg(long, global = true)]
    port: Option<u16>,

    /// Connect without TLS. Only useful against a local server.
    #[arg(long, global = true)]
    no_tls: bool,

    /// Seconds to wait for the server before giving up.
    #[arg(long, global = true, default_value_t = 30)]
    timeout: u64,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Check the server is reachable and report its version.
    Ping,
    /// Confirmed and unconfirmed balance of an address.
    Balance { address: String },
    /// Unspent outputs held by an address.
    Utxos { address: String },
    /// Show the scripthash and output script derived from an address.
    ///
    /// Worth reaching for when a balance looks wrong: an address with no
    /// history and an address whose scripthash was derived incorrectly both
    /// return nothing, and this is what tells them apart.
    Inspect { address: String },
    /// Fetch a transaction by id.
    Tx {
        txid: String,
        /// Ask the server to decode it rather than returning raw hex.
        #[arg(long)]
        verbose: bool,
    },
    /// Broadcast a signed, hex-encoded transaction.
    Broadcast { hex: String },
    /// Generate a new BIP39 recovery phrase.
    New {
        /// Word count. All five BIP39 lengths are offered; 12 is the common
        /// default and 24 carries 256 bits of entropy.
        #[arg(long, default_value_t = 12)]
        words: usize,
    },
    /// Derive an address from a recovery phrase.
    ///
    /// The phrase is read from OPTN_MNEMONIC or stdin, never from the command
    /// line — an argument would land in shell history and in the process list
    /// where any other user on the machine can read it.
    Address {
        #[arg(long, default_value_t = 0)]
        account: u32,
        #[arg(long, default_value_t = 0)]
        index: u32,
        /// Derive from the change chain instead of the receiving chain.
        #[arg(long)]
        change: bool,
        /// SLIP-44 coin type. Defaults to the network's own.
        #[arg(long)]
        coin_type: Option<u32>,
    },
    /// Send BCH to an address.
    ///
    /// Scans the wallet's own addresses for spendable outputs, builds and signs
    /// the transaction, and broadcasts it. Requires --yes: this binary is meant
    /// to be run by automation, so spending is never reachable by accident.
    Send {
        /// Destination CashAddr.
        to: String,
        /// Amount in satoshis.
        sats: u64,
        /// Satoshis per byte.
        #[arg(long, default_value_t = 1)]
        fee_rate: u64,
        /// Addresses per chain to scan for spendable outputs.
        #[arg(long, default_value_t = 20)]
        gap: u32,
        /// Build and sign, print the raw transaction, but do not broadcast.
        #[arg(long)]
        dry_run: bool,
        /// Required to actually broadcast.
        #[arg(long)]
        yes: bool,
    },
    /// Rebuild the wallet view from the chain.
    ///
    /// The desktop app keeps a local UTXO and history cache; this has none, so
    /// every run reads the chain fresh. That is slower but it is also the
    /// answer when a cached balance has drifted — there is no stale state here
    /// to be wrong.
    Rescan {
        /// Addresses per chain to scan.
        #[arg(long, default_value_t = 20)]
        gap: u32,
        /// Include addresses with no balance in the output.
        #[arg(long)]
        all: bool,
    },
    /// Transaction history across the wallet's own addresses.
    History {
        #[arg(long, default_value_t = 20)]
        gap: u32,
        /// Most recent entries to show.
        #[arg(long, default_value_t = 25)]
        limit: usize,
    },
    /// Find which derivation paths a phrase actually has history on.
    ///
    /// Scans the coin types and accounts documented in
    /// docs/bch-derivation-paths.md, because a seed restored from other BCH
    /// tooling may sit under a coin type this wallet would not choose.
    Discover {
        /// Addresses to check per chain before giving up on an account.
        #[arg(long, default_value_t = 20)]
        gap: u32,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    match run(&cli).await {
        Ok(value) => {
            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&value).unwrap_or_default()
                );
            } else {
                print_human(&cli.command, &value);
            }
        }
        Err(err) => {
            if cli.json {
                let payload =
                    json!({ "ok": false, "error": err.kind(), "message": err.to_string() });
                println!(
                    "{}",
                    serde_json::to_string_pretty(&payload).unwrap_or_default()
                );
            } else {
                eprintln!("error: {err}");
            }
            std::process::exit(err.exit_code());
        }
    }
}

async fn run(cli: &Cli) -> Result<Value> {
    let host = cli
        .host
        .clone()
        .unwrap_or_else(|| cli.network.default_host().to_string());
    let port = cli.port.unwrap_or_else(|| cli.network.default_port());
    let client = Client::new(host, port, !cli.no_tls, cli.timeout);

    match &cli.command {
        Command::Ping => {
            let version = client.server_version().await?;
            Ok(json!({
                "ok": true,
                "network": cli.network.to_string(),
                "endpoint": client.endpoint(),
                "server": version,
            }))
        }
        Command::Balance { address } => {
            let parsed = parse_address(address, cli.network)?;
            let scripthash = parsed.electrum_scripthash();
            let balance = client.balance(&scripthash).await?;
            Ok(json!({
                "ok": true,
                "network": cli.network.to_string(),
                "address": address,
                "scripthash": scripthash,
                "confirmed": balance.confirmed,
                "unconfirmed": balance.unconfirmed,
                "total": balance.confirmed + balance.unconfirmed,
            }))
        }
        Command::Utxos { address } => {
            let parsed = parse_address(address, cli.network)?;
            let scripthash = parsed.electrum_scripthash();
            let utxos = client.utxos(&scripthash).await?;
            let total: u64 = utxos.iter().map(|u| u.value).sum();
            Ok(json!({
                "ok": true,
                "network": cli.network.to_string(),
                "address": address,
                "count": utxos.len(),
                "total": total,
                "utxos": utxos.iter().map(|u| json!({
                    "txid": u.tx_hash,
                    "vout": u.tx_pos,
                    "height": u.height,
                    "value": u.value,
                })).collect::<Vec<_>>(),
            }))
        }
        Command::Inspect { address } => {
            let parsed = parse_address(address, cli.network)?;
            Ok(json!({
                "ok": true,
                "network": cli.network.to_string(),
                "address": address,
                "prefix": parsed.prefix,
                "kind": format!("{:?}", parsed.kind),
                "hash160": hex(&parsed.hash),
                "script": hex(&parsed.script_pubkey()),
                "scripthash": parsed.electrum_scripthash(),
            }))
        }
        Command::Tx { txid, verbose } => {
            if txid.len() != 64 || !txid.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(CliError::Usage(format!(
                    "'{txid}' is not a 64-character hex txid"
                )));
            }
            let tx = client.transaction(txid, *verbose).await?;
            Ok(json!({ "ok": true, "txid": txid, "transaction": tx }))
        }
        Command::New { words } => {
            if !matches!(words, 12 | 15 | 18 | 21 | 24) {
                return Err(CliError::Usage(format!(
                    "--words must be 12, 15, 18, 21 or 24 (got {words})"
                )));
            }
            // Generated by the bip39 crate from the OS RNG rather than by hand:
            // entropy for a recovery phrase is not somewhere to improvise.
            let mnemonic = Mnemonic::generate_in(Language::English, *words)
                .map_err(|e| CliError::Internal(format!("mnemonic generation failed: {e}")))?;
            Ok(json!({
                "ok": true,
                "words": words,
                "mnemonic": mnemonic.to_string(),
                "warning": "anyone with this phrase controls the funds; store it offline",
            }))
        }
        Command::Address {
            account,
            index,
            change,
            coin_type,
        } => {
            let wallet = read_wallet()?;
            let coin = coin_type.unwrap_or(default_coin_type(cli.network));
            let path = hd::address_path(coin, *account, *change, *index);
            let address = wallet.address(cli.network, &path)?;
            Ok(json!({
                "ok": true,
                "network": cli.network.to_string(),
                "path": path,
                "address": address.encode(),
                "scripthash": address.electrum_scripthash(),
            }))
        }
        Command::Send {
            to,
            sats,
            fee_rate,
            gap,
            dry_run,
            yes,
        } => {
            if !*yes && !*dry_run {
                return Err(CliError::Usage(
                    "refusing to spend without --yes (use --dry-run to preview)".to_string(),
                ));
            }
            let destination = parse_address(to, cli.network)?;
            let wallet = read_wallet()?;
            let coin = default_coin_type(cli.network);

            // Collect spendable outputs together with the path that controls
            // each, so the right key signs the right input.
            let mut spendable: Vec<(tx::Utxo, String)> = Vec::new();
            for change in [false, true] {
                for index in 0..*gap {
                    let path = hd::address_path(coin, 0, change, index);
                    let address = wallet.address(cli.network, &path)?;
                    for u in client.utxos(&address.electrum_scripthash()).await? {
                        let mut txid = decode_hex32(&u.tx_hash)?;
                        // Electrum reports txids big-endian; the wire format is
                        // little-endian. Skipping this reversal produces a
                        // transaction that spends nothing and is simply rejected.
                        txid.reverse();
                        spendable.push((
                            tx::Utxo {
                                txid,
                                vout: u.tx_pos,
                                value: u.value,
                                script_pubkey: address.script_pubkey(),
                            },
                            path.clone(),
                        ));
                    }
                }
            }
            if spendable.is_empty() {
                return Err(CliError::Usage(
                    "no spendable outputs found — check the network and the gap limit".to_string(),
                ));
            }

            let pool: Vec<tx::Utxo> = spendable.iter().map(|(u, _)| u.clone()).collect();
            let (chosen, fee) = tx::select_coins(&pool, *sats, *fee_rate, 2)?;
            let input_total: u64 = chosen.iter().map(|u| u.value).sum();
            let change_value = input_total - sats - fee;

            let mut outputs = vec![tx::Output {
                value: *sats,
                script_pubkey: destination.script_pubkey(),
            }];
            // Below the dust limit a change output cannot be spent, so it goes
            // to the miner as extra fee instead of being created unspendable.
            const DUST: u64 = 546;
            let change_path = hd::address_path(coin, 0, true, 0);
            if change_value >= DUST {
                outputs.push(tx::Output {
                    value: change_value,
                    script_pubkey: wallet.address(cli.network, &change_path)?.script_pubkey(),
                });
            }

            let transaction = tx::Transaction::new(chosen.clone(), outputs);
            let mut keys = Vec::with_capacity(chosen.len());
            for input in &chosen {
                let path = spendable
                    .iter()
                    .find(|(u, _)| u.txid == input.txid && u.vout == input.vout)
                    .map(|(_, p)| p.clone())
                    .ok_or_else(|| CliError::Internal("selected an unknown utxo".into()))?;
                keys.push(wallet.signing_key(&path)?);
            }
            let raw = transaction.sign(&keys)?;
            let raw_hex = hex(&raw);

            if *dry_run {
                return Ok(json!({
                    "ok": true,
                    "dry_run": true,
                    "network": cli.network.to_string(),
                    "to": to,
                    "sats": sats,
                    "fee": fee,
                    "change": if change_value >= DUST { change_value } else { 0 },
                    "inputs": chosen.len(),
                    "size_bytes": raw.len(),
                    "raw": raw_hex,
                }));
            }

            let txid = client.broadcast(&raw_hex).await?;
            Ok(json!({
                "ok": true,
                "network": cli.network.to_string(),
                "txid": txid,
                "to": to,
                "sats": sats,
                "fee": fee,
                "inputs": chosen.len(),
            }))
        }
        Command::Rescan { gap, all } => {
            let wallet = read_wallet()?;
            let coin = default_coin_type(cli.network);
            let mut addresses = Vec::new();
            let mut confirmed_total: i64 = 0;
            let mut unconfirmed_total: i64 = 0;
            let mut utxo_count = 0usize;

            for change in [false, true] {
                for index in 0..*gap {
                    let path = hd::address_path(coin, 0, change, index);
                    let address = wallet.address(cli.network, &path)?;
                    let scripthash = address.electrum_scripthash();
                    let balance = client.balance(&scripthash).await?;
                    let utxos = client.utxos(&scripthash).await?;
                    let has_funds = balance.confirmed != 0 || balance.unconfirmed != 0;
                    if has_funds {
                        confirmed_total += balance.confirmed;
                        unconfirmed_total += balance.unconfirmed;
                        utxo_count += utxos.len();
                    }
                    if has_funds || *all {
                        addresses.push(json!({
                            "path": path,
                            "address": address.encode(),
                            "chain": if change { "change" } else { "receiving" },
                            "index": index,
                            "confirmed": balance.confirmed,
                            "unconfirmed": balance.unconfirmed,
                            "utxos": utxos.len(),
                        }));
                    }
                }
            }
            Ok(json!({
                "ok": true,
                "network": cli.network.to_string(),
                "account_path": hd::account_path(coin, 0),
                "gap": gap,
                "confirmed": confirmed_total,
                "unconfirmed": unconfirmed_total,
                "total": confirmed_total + unconfirmed_total,
                "utxos": utxo_count,
                "addresses": addresses,
            }))
        }
        Command::History { gap, limit } => {
            let wallet = read_wallet()?;
            let coin = default_coin_type(cli.network);
            let mut entries: Vec<(i64, String, String, Option<u64>)> = Vec::new();

            for change in [false, true] {
                for index in 0..*gap {
                    let path = hd::address_path(coin, 0, change, index);
                    let address = wallet.address(cli.network, &path)?;
                    for e in client.history(&address.electrum_scripthash()).await? {
                        entries.push((e.height, e.tx_hash, path.clone(), e.fee));
                    }
                }
            }

            // An unconfirmed entry has height 0, and a negative height means it
            // has unconfirmed parents. Both belong at the top, not sorted as if
            // they were ancient blocks.
            entries.sort_by_key(|(height, ..)| if *height <= 0 { i64::MAX } else { *height });
            entries.reverse();
            entries.dedup_by(|a, b| a.1 == b.1);

            let shown: Vec<Value> = entries
                .iter()
                .take(*limit)
                .map(|(height, txid, path, fee)| {
                    json!({
                        "txid": txid,
                        "height": height,
                        "status": if *height > 0 { "confirmed" } else { "unconfirmed" },
                        "path": path,
                        // Servers report a fee only for mempool entries.
                        "fee": fee,
                    })
                })
                .collect();

            Ok(json!({
                "ok": true,
                "network": cli.network.to_string(),
                "count": entries.len(),
                "shown": shown.len(),
                "transactions": shown,
            }))
        }
        Command::Discover { gap } => {
            let wallet = read_wallet()?;
            let mut found = Vec::new();
            for &coin in hd::scan_coin_types(cli.network) {
                for &account in hd::SCAN_ACCOUNTS {
                    let mut total: i64 = 0;
                    let mut used = 0u32;
                    for change in [false, true] {
                        for index in 0..*gap {
                            let path = hd::address_path(coin, account, change, index);
                            let address = wallet.address(cli.network, &path)?;
                            let balance = client.balance(&address.electrum_scripthash()).await?;
                            if balance.confirmed != 0 || balance.unconfirmed != 0 {
                                used += 1;
                                total += balance.confirmed + balance.unconfirmed;
                            }
                        }
                    }
                    if used > 0 {
                        found.push(json!({
                            "account_path": hd::account_path(coin, account),
                            "coin_type": coin,
                            "account": account,
                            "addresses_with_balance": used,
                            "total": total,
                        }));
                    }
                }
            }
            Ok(json!({
                "ok": true,
                "network": cli.network.to_string(),
                "gap": gap,
                "scanned_coin_types": hd::scan_coin_types(cli.network),
                "found": found,
            }))
        }
        Command::Broadcast { hex: raw } => {
            if raw.is_empty() || !raw.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(CliError::Usage(
                    "transaction must be non-empty hex".to_string(),
                ));
            }
            let txid = client.broadcast(raw).await?;
            Ok(json!({ "ok": true, "network": cli.network.to_string(), "txid": txid }))
        }
    }
}

/// Decode an address and refuse it if it belongs to the other chain.
///
/// Without this check the command still succeeds: the server simply reports no
/// history, which is indistinguishable from an unused address. Failing here
/// turns a confusing empty answer into a clear one.
fn parse_address(input: &str, network: Network) -> Result<Address> {
    let parsed = Address::decode(input).map_err(CliError::Usage)?;
    if parsed.prefix != network.prefix() {
        return Err(CliError::Usage(format!(
            "'{}' is a {} address but --network is {}; \
             querying the wrong chain returns an empty result, not an error",
            input, parsed.prefix, network
        )));
    }
    Ok(parsed)
}

/// Read a recovery phrase from OPTN_MNEMONIC, or from stdin if unset.
///
/// Deliberately not a command-line argument. Arguments are visible in shell
/// history and in `ps` output to every other user on the machine, and a
/// recovery phrase is the whole wallet.
fn read_wallet() -> Result<Wallet> {
    let phrase = match std::env::var("OPTN_MNEMONIC") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => {
            use std::io::Read;
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf).map_err(|e| {
                CliError::Usage(format!("could not read the phrase from stdin: {e}"))
            })?;
            if buf.trim().is_empty() {
                return Err(CliError::Usage(
                    "no recovery phrase supplied — set OPTN_MNEMONIC or pipe the phrase on stdin"
                        .to_string(),
                ));
            }
            buf
        }
    };
    let passphrase = std::env::var("OPTN_PASSPHRASE").unwrap_or_default();
    Wallet::from_mnemonic(phrase.trim(), &passphrase)
}

/// Decode a 64-character hex string into 32 bytes.
fn decode_hex32(s: &str) -> Result<[u8; 32]> {
    if s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(CliError::Protocol(format!(
            "'{s}' is not a 32-byte hex hash"
        )));
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
            .map_err(|e| CliError::Protocol(format!("bad hex: {e}")))?;
    }
    Ok(out)
}

/// SLIP-44 coin type this wallet uses by default on a network.
fn default_coin_type(network: Network) -> u32 {
    match network {
        Network::Mainnet => 145,
        Network::Chipnet => 1,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn print_human(command: &Command, v: &Value) {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let n = |k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
    match command {
        Command::Ping => {
            println!("network   {}", s("network"));
            println!("endpoint  {}  reachable", s("endpoint"));
            println!("server    {}", v.get("server").unwrap_or(&Value::Null));
        }
        Command::Balance { .. } => {
            println!("address      {}", s("address"));
            println!("network      {}", s("network"));
            println!("confirmed    {} sats", n("confirmed"));
            println!("unconfirmed  {} sats", n("unconfirmed"));
            println!("total        {} sats", n("total"));
        }
        Command::Utxos { .. } => {
            println!("{} utxo(s), {} sats total", n("count"), n("total"));
            if let Some(list) = v.get("utxos").and_then(Value::as_array) {
                for u in list {
                    println!(
                        "  {}:{}  {} sats  height {}",
                        u.get("txid").and_then(Value::as_str).unwrap_or(""),
                        u.get("vout").and_then(Value::as_i64).unwrap_or(0),
                        u.get("value").and_then(Value::as_i64).unwrap_or(0),
                        u.get("height").and_then(Value::as_i64).unwrap_or(0),
                    );
                }
            }
        }
        Command::Inspect { .. } => {
            println!("address     {}", s("address"));
            println!("network     {}", s("network"));
            println!("kind        {}", s("kind"));
            println!("hash160     {}", s("hash160"));
            println!("script      {}", s("script"));
            println!("scripthash  {}", s("scripthash"));
        }
        _ => println!("{}", serde_json::to_string_pretty(v).unwrap_or_default()),
    }
}
