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
mod network;

use clap::{Parser, Subcommand};
use serde_json::{json, Value};

use cashaddr::Address;
use electrum::Client;
use error::{CliError, Result};
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
