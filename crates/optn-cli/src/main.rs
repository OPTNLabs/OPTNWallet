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
mod contract;
mod electrum;
mod error;
mod hd;
mod keychain;
mod msgsign;
mod network;
mod serve;
mod skills;
mod token;
mod tx;
mod x402;

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

    /// Which stored wallet to use, when more than one is in the keychain.
    ///
    /// Keyed with the network, so a mainnet and a chipnet wallet may share a
    /// profile name without one overwriting the other.
    #[arg(long, global = true, default_value = "default")]
    profile: String,

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
        /// Emit the token-aware form, which renders with a `z` rather than a
        /// `q`. Sending tokens to a non-token address destroys them, so the two
        /// forms are distinct on purpose.
        #[arg(long)]
        token: bool,
    },
    /// CashToken balances held by the wallet.
    Tokens {
        #[arg(long, default_value_t = 20)]
        gap: u32,
    },
    /// Decode a raw transaction, including any CashToken outputs.
    Decode {
        /// Raw transaction hex.
        hex: String,
    },
    /// Send a CashToken NFT.
    ///
    /// An NFT is identified by its category and commitment together: one
    /// category can hold many NFTs, so the commitment is what picks which.
    SendNft {
        /// Token-aware destination address.
        to: String,
        /// 64-character category id.
        #[arg(long)]
        category: String,
        /// Commitment hex identifying which NFT. Omit only when the category
        /// holds exactly one.
        #[arg(long, default_value = "")]
        commitment: String,
        #[arg(long, default_value_t = 1)]
        fee_rate: u64,
        #[arg(long, default_value_t = 20)]
        gap: u32,
        /// Build and sign without broadcasting.
        #[arg(long)]
        dry_run: bool,
        /// Required to actually broadcast.
        #[arg(long)]
        yes: bool,
    },
    /// Send fungible CashTokens.
    ///
    /// The destination must be a token-aware address. Sending tokens to a plain
    /// address destroys them, so the form is checked rather than trusted.
    TokenSend {
        /// Token-aware destination address.
        to: String,
        /// Token amount to send.
        amount: u64,
        /// 64-character category id.
        #[arg(long)]
        category: String,
        #[arg(long, default_value_t = 1)]
        fee_rate: u64,
        #[arg(long, default_value_t = 20)]
        gap: u32,
        /// Build and sign without broadcasting.
        #[arg(long)]
        dry_run: bool,
        /// Required to actually broadcast.
        #[arg(long)]
        yes: bool,
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
    /// Serve the same commands over local JSON-RPC.
    ///
    /// An agent that shells out pays process startup on every call. This
    /// answers the same commands over HTTP, parsed by the same parser and
    /// gated by the same policy — a second implementation of what `balance`
    /// means would be a second place for it to be wrong.
    Serve {
        #[arg(long, default_value_t = 8787)]
        port: u16,
        /// Address to bind. Loopback unless --allow-remote is also given.
        #[arg(long, default_value = "127.0.0.1")]
        bind: String,
        /// Bearer token. Generated and printed once when not supplied.
        #[arg(long)]
        token: Option<String>,
        /// Permit commands that move funds. Off by default.
        #[arg(long)]
        allow_spend: bool,
        /// Bind somewhere other than loopback. Read the refusal first.
        #[arg(long)]
        allow_remote: bool,
    },
    /// CashScript covenants: the contracts this wallet ships.
    ///
    /// Nothing here compiles CashScript. The artifacts are already compiled and
    /// built into this binary; the work is deriving the same redeem script, and
    /// so the same address, that the desktop wallet does.
    Contract {
        #[command(subcommand)]
        action: ContractCommand,
    },
    /// Describe every command, what it may do, and the active policy.
    ///
    /// Meant to be read by an agent harness rather than a person. `--help` is
    /// prose, and parsing prose to decide whether a command spends money is
    /// not a safety mechanism.
    Skills,
    /// Keep a recovery phrase in the operating system's keychain.
    ///
    /// The alternatives are worse: an argument lands in shell history and in
    /// `ps` output, and an environment variable is inherited by every child
    /// process and readable from /proc. This is the platform's own answer.
    Keychain {
        #[command(subcommand)]
        action: KeychainCommand,
    },
    /// Pay for an HTTP resource with x402.
    ///
    /// x402 turns HTTP 402 into a working status code: the server answers with
    /// what it charges, the client pays on-chain, and the request is repeated
    /// carrying proof. Payment is batched — one funding transaction covers many
    /// later calls — which is what makes it usable by an agent that makes
    /// hundreds of requests.
    X402 {
        #[command(subcommand)]
        action: X402Command,
    },
}

#[derive(Subcommand)]
enum ContractCommand {
    /// The contracts built into this binary.
    List,
    /// A contract's constructor parameters and spendable functions.
    Info {
        /// Contract or artifact name, e.g. `TransferWithTimeout` or `escrow`.
        name: String,
    },
    /// Derive a contract's address from its constructor arguments.
    ///
    /// Arguments are given in declaration order and parsed against the type the
    /// artifact declares, not guessed from how they look.
    Address {
        name: String,
        /// One constructor argument, repeated in order.
        #[arg(long = "arg")]
        args: Vec<String>,
    },
}

#[derive(Subcommand)]
enum KeychainCommand {
    /// Store a phrase, read from OPTN_MNEMONIC or stdin.
    ///
    /// Never from an argument: this is the one secret whose exposure loses the
    /// whole wallet, and an argument is visible to every other user on the
    /// machine.
    Store {
        /// Replace an existing entry rather than refusing.
        #[arg(long)]
        force: bool,
    },
    /// Report whether a phrase is stored, without revealing it.
    Status,
    /// Delete the stored phrase.
    Remove,
}

#[derive(Subcommand)]
enum X402Command {
    /// Ask what a resource costs. Reads only; never spends.
    Check {
        url: String,
        /// Extra request header, as `Name: value`. Repeatable.
        #[arg(long = "header", short = 'H')]
        headers: Vec<String>,
        #[arg(long, short = 'X', default_value = "GET")]
        method: String,
        /// Request body.
        #[arg(long)]
        data: Option<String>,
    },
    /// Fetch a paid resource, authorising payment for it.
    ///
    /// Without --fund this debits an existing funding output and spends
    /// nothing on-chain, which is the normal case once a server is funded.
    /// --fund broadcasts a funding transaction first and needs --yes.
    Pay {
        url: String,
        /// Fund the server with this many satoshis before authorising.
        ///
        /// Pay more than the request costs: the surplus stays as credit and
        /// later calls debit it without touching the chain.
        #[arg(long)]
        fund: Option<u64>,
        /// Debit this funding output rather than letting the server find one.
        #[arg(long)]
        txid: Option<String>,
        #[arg(long)]
        vout: Option<u32>,
        /// Satoshis the named output holds.
        #[arg(long)]
        funded: Option<u64>,
        /// Satoshis to authorise. Defaults to what the server asks for.
        #[arg(long)]
        value: Option<u64>,
        /// Receiving address index whose key signs the authorisation.
        ///
        /// The Facilitator credits the debit against the address it recovers
        /// from the signature, so a server funded under one index must be paid
        /// under the same one.
        #[arg(long, default_value_t = 0)]
        from_index: u32,
        #[arg(long = "header", short = 'H')]
        headers: Vec<String>,
        #[arg(long, short = 'X', default_value = "GET")]
        method: String,
        #[arg(long)]
        data: Option<String>,
        #[arg(long, default_value_t = 1)]
        fee_rate: u64,
        #[arg(long, default_value_t = 20)]
        gap: u32,
        /// Show the payment that would be sent without funding or requesting.
        #[arg(long)]
        dry_run: bool,
        /// Required before any on-chain funding.
        #[arg(long)]
        yes: bool,
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

/// The command as it appears in the skill manifest.
fn command_name(command: &Command) -> &'static str {
    match command {
        Command::Ping => "ping",
        Command::Balance { .. } => "balance",
        Command::Utxos { .. } => "utxos",
        Command::Inspect { .. } => "inspect",
        Command::Tx { .. } => "tx",
        Command::Broadcast { .. } => "broadcast",
        Command::New { .. } => "new",
        Command::Address { .. } => "address",
        Command::Tokens { .. } => "tokens",
        Command::Decode { .. } => "decode",
        Command::SendNft { .. } => "send-nft",
        Command::TokenSend { .. } => "token-send",
        Command::Send { .. } => "send",
        Command::Rescan { .. } => "rescan",
        Command::History { .. } => "history",
        Command::Discover { .. } => "discover",
        Command::Contract { .. } => "contract",
        Command::Serve { .. } => "serve",
        Command::Skills => "skills",
        Command::Keychain { .. } => "keychain",
        Command::X402 { .. } => "x402",
    }
}

async fn run(cli: &Cli) -> Result<Value> {
    // Before anything else, including opening a connection. A refusal should
    // cost nothing and reveal nothing about the wallet.
    skills::enforce(skills::Policy::from_env()?, command_name(&cli.command))?;

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
            token,
        } => {
            let wallet = read_wallet(cli)?;
            let coin = coin_type.unwrap_or(default_coin_type(cli.network));
            let path = hd::address_path(coin, *account, *change, *index);
            let mut address = wallet.address(cli.network, &path)?;
            if *token {
                address.kind = address.kind.token_aware();
            }
            Ok(json!({
                "ok": true,
                "network": cli.network.to_string(),
                "path": path,
                "address": address.encode(),
                "token_aware": address.kind.accepts_tokens(),
                // Both forms lock to the same script, so the scripthash is
                // identical and a balance query returns the same result either
                // way. Only the encoding differs.
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
            let wallet = read_wallet(cli)?;
            let spend = spend_to(
                &client,
                cli.network,
                &wallet,
                destination.script_pubkey(),
                *sats,
                *fee_rate,
                *gap,
                !*dry_run,
            )
            .await?;

            if *dry_run {
                return Ok(json!({
                    "ok": true,
                    "dry_run": true,
                    "network": cli.network.to_string(),
                    "to": to,
                    "sats": sats,
                    "fee": spend.fee,
                    "change": spend.change,
                    "inputs": spend.inputs,
                    "size_bytes": spend.size_bytes,
                    "raw": spend.raw_hex,
                }));
            }

            Ok(json!({
                "ok": true,
                "network": cli.network.to_string(),
                "txid": spend.txid,
                "to": to,
                "sats": sats,
                "fee": spend.fee,
                "inputs": spend.inputs,
            }))
        }
        Command::Decode { hex: raw } => {
            let bytes = decode_hex(raw)?;
            let d = tx::decode(&bytes)?;
            Ok(json!({
                "ok": true,
                "version": d.version,
                "locktime": d.locktime,
                "size_bytes": bytes.len(),
                "inputs": d.inputs.iter().map(|(txid, vout, sequence)| {
                    let mut display = *txid;
                    // Stored little-endian on the wire, shown big-endian.
                    display.reverse();
                    json!({ "txid": hex(&display), "vout": vout, "sequence": sequence })
                }).collect::<Vec<_>>(),
                "outputs": d.outputs.iter().map(|o| json!({
                    "value": o.value,
                    "script": hex(&o.script_pubkey),
                    "token": o.token.as_ref().map(|t| json!({
                        "category": t.category_hex(),
                        "amount": t.amount,
                        "nft": t.nft.as_ref().map(|n| json!({
                            "capability": n.capability.as_str(),
                            "commitment": hex(&n.commitment),
                        })),
                    })),
                })).collect::<Vec<_>>(),
            }))
        }
        Command::SendNft {
            to,
            category,
            commitment,
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
            if !destination.kind.accepts_tokens() {
                return Err(CliError::Usage(format!(
                    "{to} is not a token-aware address; sending an NFT to a plain address \
                     destroys it"
                )));
            }
            let wanted = token::parse_category(category)?;
            let wallet = read_wallet(cli)?;
            let coin = default_coin_type(cli.network);
            const TOKEN_DUST: u64 = 1000;

            let mut matches: Vec<(tx::Utxo, String, token::Nft, u64)> = Vec::new();
            let mut plain_inputs: Vec<(tx::Utxo, String)> = Vec::new();

            for change in [false, true] {
                for index in 0..*gap {
                    let path = hd::address_path(coin, 0, change, index);
                    let address = wallet.address(cli.network, &path)?;
                    for u in client.utxos(&address.electrum_scripthash()).await? {
                        let mut txid = decode_hex32(&u.tx_hash)?;
                        txid.reverse();
                        let utxo = tx::Utxo {
                            txid,
                            vout: u.tx_pos,
                            value: u.value,
                            script_pubkey: address.script_pubkey(),
                        };
                        match &u.token_data {
                            Some(t) if t.category.eq_ignore_ascii_case(category) => {
                                let Some(nft) = &t.nft else { continue };
                                let held = nft.commitment.clone().unwrap_or_default();
                                if !commitment.is_empty() && !held.eq_ignore_ascii_case(commitment)
                                {
                                    continue;
                                }
                                let capability = match nft.capability.as_deref() {
                                    Some("mutable") => token::Capability::Mutable,
                                    Some("minting") => token::Capability::Minting,
                                    _ => token::Capability::None,
                                };
                                let bytes = decode_hex(&held)?;
                                let fungible: u64 =
                                    t.amount.as_deref().unwrap_or("0").parse().unwrap_or(0);
                                matches.push((
                                    utxo,
                                    path.clone(),
                                    token::Nft {
                                        capability,
                                        commitment: bytes,
                                    },
                                    fungible,
                                ));
                            }
                            Some(_) => {}
                            None => plain_inputs.push((utxo, path.clone())),
                        }
                    }
                }
            }

            if matches.is_empty() {
                return Err(CliError::Usage(format!(
                    "no NFT found for category {category}{}",
                    if commitment.is_empty() {
                        String::new()
                    } else {
                        format!(" with commitment {commitment}")
                    }
                )));
            }
            if matches.len() > 1 {
                // Picking one arbitrarily would move an NFT the caller did not
                // name, and NFTs are not interchangeable.
                let seen: Vec<String> = matches
                    .iter()
                    .map(|(_, _, nft, _)| hex(&nft.commitment))
                    .collect();
                return Err(CliError::Usage(format!(
                    "category {category} holds {} NFTs; pass --commitment to choose one of: {}",
                    matches.len(),
                    seen.join(", ")
                )));
            }

            let (nft_utxo, nft_path, nft, fungible) = matches.remove(0);
            // The NFT keeps its capability and commitment. Any fungible amount
            // riding on the same output travels with it, since dropping it here
            // would destroy those tokens.
            let moved = token::TokenData {
                category: wanted,
                amount: fungible,
                nft: Some(nft.clone()),
            };
            let outputs = vec![tx::Output::with_tokens(
                TOKEN_DUST,
                destination.script_pubkey(),
                moved.encode_prefix()?,
            )];

            let pool: Vec<tx::Utxo> = plain_inputs.iter().map(|(u, _)| u.clone()).collect();
            let (funding, fee) = tx::select_coins(
                &pool,
                TOKEN_DUST.saturating_sub(nft_utxo.value),
                *fee_rate,
                2,
            )?;

            let mut inputs = vec![nft_utxo.clone()];
            inputs.extend(funding.iter().cloned());
            let mut outputs = outputs;
            let funded: u64 = funding.iter().map(|u| u.value).sum();
            let bch_change = (nft_utxo.value + funded).saturating_sub(TOKEN_DUST + fee);
            let change_path = hd::address_path(coin, 0, true, 0);
            if bch_change >= 546 {
                outputs.push(tx::Output::new(
                    bch_change,
                    wallet.address(cli.network, &change_path)?.script_pubkey(),
                ));
            }

            let transaction = tx::Transaction::new(inputs.clone(), outputs);
            let mut keys = Vec::with_capacity(inputs.len());
            for input in &inputs {
                let path = if input.txid == nft_utxo.txid && input.vout == nft_utxo.vout {
                    nft_path.clone()
                } else {
                    plain_inputs
                        .iter()
                        .find(|(u, _)| u.txid == input.txid && u.vout == input.vout)
                        .map(|(_, p)| p.clone())
                        .ok_or_else(|| CliError::Internal("selected an unknown utxo".into()))?
                };
                keys.push(wallet.signing_key(&path)?);
            }
            let raw = transaction.sign(&keys)?;
            let raw_hex = hex(&raw);

            if *dry_run {
                return Ok(json!({
                    "ok": true,
                    "dry_run": true,
                    "network": cli.network.to_string(),
                    "category": category,
                    "commitment": hex(&nft.commitment),
                    "capability": nft.capability.as_str(),
                    "to": to,
                    "fee": fee,
                    "raw": raw_hex,
                }));
            }

            let txid = client.broadcast(&raw_hex).await?;
            Ok(json!({
                "ok": true,
                "network": cli.network.to_string(),
                "txid": txid,
                "category": category,
                "commitment": hex(&nft.commitment),
                "capability": nft.capability.as_str(),
                "to": to,
                "fee": fee,
            }))
        }
        Command::TokenSend {
            to,
            amount,
            category,
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
            if !destination.kind.accepts_tokens() {
                return Err(CliError::Usage(format!(
                    "{to} is not a token-aware address. Sending tokens to a plain address \
                     destroys them; ask for the form beginning with z, or derive one with \
                     `optn address --token`."
                )));
            }
            let wanted = token::parse_category(category)?;
            let wallet = read_wallet(cli)?;
            let coin = default_coin_type(cli.network);

            // A token output still carries BCH. 1000 sats clears the dust
            // threshold for the larger output a token prefix produces; the
            // familiar 546 figure applies to a bare P2PKH.
            const TOKEN_DUST: u64 = 1000;

            let mut token_inputs: Vec<(tx::Utxo, String, u64)> = Vec::new();
            let mut plain_inputs: Vec<(tx::Utxo, String)> = Vec::new();

            for change in [false, true] {
                for index in 0..*gap {
                    let path = hd::address_path(coin, 0, change, index);
                    let address = wallet.address(cli.network, &path)?;
                    for u in client.utxos(&address.electrum_scripthash()).await? {
                        let mut txid = decode_hex32(&u.tx_hash)?;
                        txid.reverse();
                        let utxo = tx::Utxo {
                            txid,
                            vout: u.tx_pos,
                            value: u.value,
                            script_pubkey: address.script_pubkey(),
                        };
                        match &u.token_data {
                            Some(t) if t.category.eq_ignore_ascii_case(category) => {
                                let held: u64 =
                                    t.amount.as_deref().unwrap_or("0").parse().map_err(|_| {
                                        CliError::Protocol("token amount is not a number".into())
                                    })?;
                                token_inputs.push((utxo, path.clone(), held));
                            }
                            // An output holding a different category cannot fund
                            // the fee without destroying that token, so only
                            // token-free outputs do.
                            Some(_) => {}
                            None => plain_inputs.push((utxo, path.clone())),
                        }
                    }
                }
            }

            token_inputs.sort_by_key(|e| std::cmp::Reverse(e.2));
            let mut selected: Vec<(tx::Utxo, String, u64)> = Vec::new();
            let mut gathered: u64 = 0;
            for entry in token_inputs {
                gathered = gathered.saturating_add(entry.2);
                selected.push(entry);
                if gathered >= *amount {
                    break;
                }
            }
            if gathered < *amount {
                return Err(CliError::Usage(format!(
                    "holding {gathered} of category {category}, need {amount}"
                )));
            }
            let token_change = gathered - amount;

            let mut outputs = vec![tx::Output::with_tokens(
                TOKEN_DUST,
                destination.script_pubkey(),
                token::TokenData::fungible(wanted, *amount).encode_prefix()?,
            )];

            let change_path = hd::address_path(coin, 0, true, 0);
            let plain_change = wallet.address(cli.network, &change_path)?;
            if token_change > 0 {
                // Token change must land on a token-aware address for the same
                // reason the destination must: a plain one destroys it.
                let mut token_change_address = plain_change.clone();
                token_change_address.kind = token_change_address.kind.token_aware();
                outputs.push(tx::Output::with_tokens(
                    TOKEN_DUST,
                    token_change_address.script_pubkey(),
                    token::TokenData::fungible(wanted, token_change).encode_prefix()?,
                ));
            }

            // Token inputs bring their own BCH; only the shortfall needs funding.
            let token_bch: u64 = selected.iter().map(|(u, ..)| u.value).sum();
            let needed = TOKEN_DUST * outputs.len() as u64;
            let pool: Vec<tx::Utxo> = plain_inputs.iter().map(|(u, _)| u.clone()).collect();
            let (funding, fee) = tx::select_coins(
                &pool,
                needed.saturating_sub(token_bch),
                *fee_rate,
                outputs.len() + 1,
            )?;

            let mut inputs: Vec<tx::Utxo> = selected.iter().map(|(u, ..)| u.clone()).collect();
            inputs.extend(funding.iter().cloned());

            let funded: u64 = funding.iter().map(|u| u.value).sum();
            let bch_change = (token_bch + funded).saturating_sub(needed + fee);
            if bch_change >= 546 {
                outputs.push(tx::Output::new(bch_change, plain_change.script_pubkey()));
            }

            let transaction = tx::Transaction::new(inputs.clone(), outputs);
            let mut keys = Vec::with_capacity(inputs.len());
            for input in &inputs {
                let path = selected
                    .iter()
                    .find(|(u, ..)| u.txid == input.txid && u.vout == input.vout)
                    .map(|(_, p, _)| p.clone())
                    .or_else(|| {
                        plain_inputs
                            .iter()
                            .find(|(u, _)| u.txid == input.txid && u.vout == input.vout)
                            .map(|(_, p)| p.clone())
                    })
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
                    "category": category,
                    "to": to,
                    "amount": amount,
                    "token_change": token_change,
                    "fee": fee,
                    "inputs": inputs.len(),
                    "raw": raw_hex,
                }));
            }

            let txid = client.broadcast(&raw_hex).await?;
            Ok(json!({
                "ok": true,
                "network": cli.network.to_string(),
                "txid": txid,
                "category": category,
                "to": to,
                "amount": amount,
                "fee": fee,
            }))
        }
        Command::Tokens { gap } => {
            let wallet = read_wallet(cli)?;
            let coin = default_coin_type(cli.network);
            // category -> (fungible total, nft count)
            let mut fungible: std::collections::BTreeMap<String, u128> = Default::default();
            let mut nfts: Vec<Value> = Vec::new();
            let mut token_utxos = 0usize;

            for change in [false, true] {
                for index in 0..*gap {
                    let path = hd::address_path(coin, 0, change, index);
                    let address = wallet.address(cli.network, &path)?;
                    for u in client.utxos(&address.electrum_scripthash()).await? {
                        let Some(t) = u.token_data else { continue };
                        token_utxos += 1;
                        if let Some(amount) = t.amount.as_deref() {
                            // Sent as a decimal string because the top of the
                            // range does not survive a JSON number.
                            let parsed: u128 = amount.parse().map_err(|_| {
                                CliError::Protocol(format!(
                                    "token amount '{amount}' is not a number"
                                ))
                            })?;
                            if parsed > 0 {
                                *fungible.entry(t.category.clone()).or_default() += parsed;
                            }
                        }
                        if let Some(nft) = t.nft {
                            nfts.push(json!({
                                "category": t.category,
                                "capability": nft.capability.unwrap_or_else(|| "none".into()),
                                "commitment": nft.commitment.unwrap_or_default(),
                                "txid": u.tx_hash,
                                "vout": u.tx_pos,
                                "path": path,
                            }));
                        }
                    }
                }
            }

            Ok(json!({
                "ok": true,
                "network": cli.network.to_string(),
                "token_utxos": token_utxos,
                "fungible": fungible.iter().map(|(category, amount)| json!({
                    "category": category,
                    "amount": amount.to_string(),
                })).collect::<Vec<_>>(),
                "nfts": nfts,
            }))
        }
        Command::Rescan { gap, all } => {
            let wallet = read_wallet(cli)?;
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
            let wallet = read_wallet(cli)?;
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
            let wallet = read_wallet(cli)?;
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
        Command::Serve {
            port,
            bind,
            token,
            allow_spend,
            allow_remote,
        } => {
            let address = serve::resolve_bind(bind, *port, *allow_remote)?;
            if *allow_remote && token.is_none() {
                return Err(CliError::Usage(
                    "--allow-remote needs --token: a generated token printed to \
                     a terminal is not a credential anyone off this machine has"
                        .to_string(),
                ));
            }

            let generated = token.is_none();
            let token = token.clone().unwrap_or_else(serve::generate_token);
            let mut base_args = vec!["--network".to_string(), cli.network.to_string()];
            if cli.profile != "default" {
                base_args.push("--profile".to_string());
                base_args.push(cli.profile.clone());
            }

            let config = std::sync::Arc::new(serve::Config {
                address,
                token: token.clone(),
                allow_spend: *allow_spend,
                policy: skills::Policy::from_env()?,
                base_args,
            });

            // Reaching stdin here would block forever rather than prompt —
            // there is nobody at the other end of a server's stdin.
            SERVING.store(true, std::sync::atomic::Ordering::SeqCst);

            // To stderr, so `optn serve >log` still shows the token to the
            // person who started it and does not bury it in a log file.
            eprintln!("optn serving on http://{address}");
            eprintln!(
                "  token      {}{}",
                token,
                if generated { "  (generated)" } else { "" }
            );
            eprintln!(
                "  spending   {}",
                if *allow_spend { "enabled" } else { "refused" }
            );
            eprintln!("  policy     {}", config.policy.ceiling());
            eprintln!(
                "  try        curl -H 'Authorization: Bearer {token}' http://{address}/skills"
            );

            // A LocalSet rather than tokio::spawn: `listen` dispatches back
            // into `run`, and that cycle cannot be proved Send. Connections
            // are still handled concurrently, just on this thread — which is
            // ample for a loopback endpoint serving one agent.
            let local = tokio::task::LocalSet::new();
            local.run_until(listen(config)).await?;
            Ok(json!({ "ok": true, "served": address.to_string() }))
        }
        Command::Contract { action } => match action {
            ContractCommand::List => {
                let mut contracts = Vec::new();
                for (file, source) in contract::BUNDLED {
                    let name = file.trim_end_matches(".json");
                    match serde_json::from_str::<contract::Artifact>(source) {
                        Ok(artifact) => {
                            // Assembling here rather than only when someone
                            // tries to use it: an artifact that cannot be
                            // assembled is broken now, and finding that out
                            // while trying to move funds is far worse.
                            let assembled = contract::assemble(&artifact.bytecode);
                            contracts.push(json!({
                                "name": artifact.contract_name,
                                "artifact": name,
                                "constructor_inputs": artifact.constructor_inputs.len(),
                                "functions": artifact.abi.len(),
                                "compiler": artifact.compiler.as_ref()
                                    .map(|c| format!("{} {}", c.name, c.version)),
                                "assembles": assembled.is_ok(),
                                "bytes": assembled.as_ref().map(|b| b.len()).unwrap_or(0),
                                "error": assembled.err().map(|e| e.to_string()),
                            }));
                        }
                        Err(e) => contracts.push(json!({
                            "name": name,
                            "artifact": name,
                            "assembles": false,
                            "error": e.to_string(),
                        })),
                    }
                }
                Ok(json!({ "ok": true, "contracts": contracts }))
            }
            ContractCommand::Info { name } => {
                let artifact = contract::bundled(name)?;
                let script = contract::assemble(&artifact.bytecode)?;
                Ok(json!({
                    "ok": true,
                    "name": artifact.contract_name,
                    "compiler": artifact.compiler.as_ref()
                        .map(|c| format!("{} {}", c.name, c.version)),
                    "bytes": script.len(),
                    "constructor": artifact.constructor_inputs.iter().map(|p| json!({
                        "name": p.name,
                        "type": p.kind,
                    })).collect::<Vec<_>>(),
                    "functions": artifact.abi.iter().map(|f| json!({
                        "name": f.name,
                        "inputs": f.inputs.iter().map(|p| json!({
                            "name": p.name,
                            "type": p.kind,
                        })).collect::<Vec<_>>(),
                    })).collect::<Vec<_>>(),
                }))
            }
            ContractCommand::Address { name, args } => {
                let artifact = contract::bundled(name)?;
                if args.len() != artifact.constructor_inputs.len() {
                    // Named before parsing, because "wrong count" is a clearer
                    // answer than a type error on whichever argument happens to
                    // line up with the wrong parameter.
                    return Err(CliError::Usage(format!(
                        "{} takes {} constructor argument(s), got {}: expected {}",
                        artifact.contract_name,
                        artifact.constructor_inputs.len(),
                        args.len(),
                        artifact
                            .constructor_inputs
                            .iter()
                            .map(|p| format!("{} ({})", p.name, p.kind))
                            .collect::<Vec<_>>()
                            .join(", "),
                    )));
                }

                let mut parsed = Vec::with_capacity(args.len());
                for (parameter, raw) in artifact.constructor_inputs.iter().zip(args) {
                    parsed.push(contract::parse_argument(parameter, raw)?);
                }

                let script = contract::redeem_script(&artifact, &parsed)?;
                let locking = contract::p2sh32_script_pubkey(&script);
                Ok(json!({
                    "ok": true,
                    "name": artifact.contract_name,
                    "network": cli.network.to_string(),
                    "address": contract::p2sh32_address(&script, cli.network, false),
                    "token_address": contract::p2sh32_address(&script, cli.network, true),
                    "redeem_script": hex(&script),
                    "locking_script": hex(&locking),
                    "bytes": script.len(),
                }))
            }
        },
        Command::Skills => Ok(skills::manifest(skills::Policy::from_env()?)),
        Command::Keychain { action } => {
            let (label, persists) = keychain::backend();
            match action {
                KeychainCommand::Store { force } => {
                    if !*force && keychain::load(cli.network, &cli.profile)?.is_some() {
                        return Err(CliError::Usage(format!(
                            "a phrase is already stored for {} profile '{}'; \
                             pass --force to replace it",
                            cli.network, cli.profile
                        )));
                    }
                    // Validated before storing. An unusable phrase written to
                    // the keychain fails later, at the point someone is trying
                    // to spend, with nothing to say it was wrong when stored.
                    let phrase = read_phrase()?;
                    Wallet::from_mnemonic(phrase.trim(), "")?;
                    keychain::store(cli.network, &cli.profile, &phrase)?;
                    Ok(json!({
                        "ok": true,
                        "stored": true,
                        "network": cli.network.to_string(),
                        "profile": cli.profile,
                        "backend": label,
                        "survives_reboot": persists,
                    }))
                }
                KeychainCommand::Status => {
                    // Presence only. Printing the phrase would put it in a
                    // terminal scrollback and in any log capturing stdout.
                    let stored = keychain::load(cli.network, &cli.profile)?;
                    Ok(json!({
                        "ok": true,
                        "stored": stored.is_some(),
                        "network": cli.network.to_string(),
                        "profile": cli.profile,
                        "backend": label,
                        "survives_reboot": persists,
                        "words": stored.map(|p| p.split_whitespace().count()),
                    }))
                }
                KeychainCommand::Remove => Ok(json!({
                    "ok": true,
                    "removed": keychain::remove(cli.network, &cli.profile)?,
                    "network": cli.network.to_string(),
                    "profile": cli.profile,
                    "backend": label,
                })),
            }
        }
        Command::X402 { action } => match action {
            X402Command::Check {
                url,
                headers,
                method,
                data,
            } => {
                let spec = request_spec(url, method, data, headers)?;
                let attempt = x402::Http::new(cli.timeout)?.send(&spec, None).await?;
                if !attempt.is_payment_required() {
                    // Not every resource charges. Reporting the body rather
                    // than an error is what lets a caller use this to probe.
                    return Ok(json!({
                        "ok": true,
                        "url": url,
                        "status": attempt.status,
                        "payment_required": false,
                        "body": attempt.json_or_text(),
                    }));
                }

                let required = x402::PaymentRequired::parse(&attempt.body)?;
                let chosen = x402::choose_bch(&required)?;
                // Decoding under our own network rejects a server quoting the
                // other chain, which would otherwise be paid for real and
                // never credited.
                parse_address(&chosen.pay_to, cli.network)?;
                Ok(json!({
                    "ok": true,
                    "url": url,
                    "status": attempt.status,
                    "payment_required": true,
                    "x402_version": required.version,
                    "scheme": chosen.scheme,
                    "chain": chosen.network,
                    "pay_to": chosen.pay_to,
                    "sats": chosen.satoshis()?,
                    "asset": chosen.asset,
                    "timeout_seconds": chosen.max_timeout_seconds,
                    "options_offered": required.accepts.len(),
                }))
            }
            X402Command::Pay {
                url,
                fund,
                txid,
                vout,
                funded,
                value,
                from_index,
                headers,
                method,
                data,
                fee_rate,
                gap,
                dry_run,
                yes,
            } => {
                if fund.is_some() && !*yes && !*dry_run {
                    return Err(CliError::Usage(
                        "refusing to fund without --yes (use --dry-run to preview)".to_string(),
                    ));
                }
                // Either name a funding output completely or leave it to the
                // server. A half-named one would be signed with a null vout
                // against a real txid, which the Facilitator rejects without
                // saying which half was missing.
                let named = [txid.is_some(), vout.is_some(), funded.is_some()];
                if named.iter().any(|n| *n) && !named.iter().all(|n| *n) {
                    return Err(CliError::Usage(
                        "--txid, --vout and --funded name one funding output and go together"
                            .to_string(),
                    ));
                }

                let spec = request_spec(url, method, data, headers)?;
                let http = x402::Http::new(cli.timeout)?;
                let first = http.send(&spec, None).await?;
                if !first.is_payment_required() {
                    return Ok(json!({
                        "ok": true,
                        "url": url,
                        "status": first.status,
                        "paid": false,
                        "reason": "the server did not ask for payment",
                        "body": first.json_or_text(),
                    }));
                }

                let required = x402::PaymentRequired::parse(&first.body)?;
                let chosen = x402::choose_bch(&required)?;
                let destination = parse_address(&chosen.pay_to, cli.network)?;
                let asked = chosen.satoshis()?;
                let debit = value.unwrap_or(asked);
                if debit < asked {
                    return Err(CliError::Usage(format!(
                        "the server asks for {asked} satoshis; --value {debit} is short"
                    )));
                }

                let wallet = read_wallet(cli)?;
                let coin = default_coin_type(cli.network);
                // The address whose key signs the authorisation. The
                // Facilitator recovers it from the signature and credits the
                // debit against that payer, so it is stated rather than
                // inferred from whichever coins funded the transaction.
                let payer_path = hd::address_path(coin, 0, false, *from_index);
                let payer = wallet.address(cli.network, &payer_path)?;

                let mut funding = json!(null);
                let authorization = if let Some(sats) = fund {
                    if *sats < asked {
                        return Err(CliError::Usage(format!(
                            "--fund {sats} is below the {asked} satoshis this call costs"
                        )));
                    }
                    let spend = spend_to(
                        &client,
                        cli.network,
                        &wallet,
                        destination.script_pubkey(),
                        *sats,
                        *fee_rate,
                        *gap,
                        !*dry_run,
                    )
                    .await?;
                    funding = json!({
                        "txid": spend.txid,
                        "vout": 0,
                        "sats": sats,
                        "fee": spend.fee,
                        "inputs": spend.inputs,
                        "broadcast": !*dry_run,
                    });
                    // The funding output is built first, so it is vout 0.
                    x402::Authorization::against(
                        payer.encode(),
                        chosen.pay_to.clone(),
                        debit,
                        spend.txid.clone().unwrap_or_default(),
                        0,
                        *sats,
                    )
                } else if let (Some(txid), Some(vout), Some(funded)) = (txid, vout, funded) {
                    x402::Authorization::against(
                        payer.encode(),
                        chosen.pay_to.clone(),
                        debit,
                        txid.clone(),
                        *vout,
                        *funded,
                    )
                } else {
                    // No funding named: debit whatever credit the server
                    // already holds for us. Nothing is spent on-chain, which
                    // is the ordinary case after the first call.
                    x402::Authorization::tab(payer.encode(), chosen.pay_to.clone(), debit)
                };

                let key = wallet.signing_key(&payer_path)?;
                let signature = msgsign::sign_message(&key, &authorization.signing_bytes()?)?;
                let payload = x402::PaymentPayload {
                    version: required.version,
                    resource: required.resource.clone(),
                    accepted: chosen.clone(),
                    payload: x402::Inner {
                        signature,
                        authorization,
                    },
                    extensions: json!({}),
                };
                let header = x402::header_value(&payload)?;

                if *dry_run {
                    return Ok(json!({
                        "ok": true,
                        "dry_run": true,
                        "url": url,
                        "pay_to": chosen.pay_to,
                        "from": payer.encode(),
                        "sats": debit,
                        "funding": funding,
                        "header_name": x402::PAYMENT_HEADER,
                        "header": header,
                    }));
                }

                let paid = http.send(&spec, Some(&header)).await?;
                Ok(json!({
                    "ok": paid.status < 400,
                    "url": url,
                    "status": paid.status,
                    "paid": paid.status < 400,
                    "pay_to": chosen.pay_to,
                    "from": payer.encode(),
                    "sats": debit,
                    "funding": funding,
                    "payment_response": paid.payment_response,
                    "body": paid.json_or_text(),
                }))
            }
        },
    }
}

/// A payment that has been built and signed, and broadcast unless previewed.
struct Spend {
    /// Set once broadcast; absent on a preview.
    txid: Option<String>,
    raw_hex: String,
    fee: u64,
    change: u64,
    inputs: usize,
    size_bytes: usize,
}

/// Build, sign, and broadcast a payment out of the wallet's own coins.
///
/// Shared by `send` and by x402 funding. Both need the same coin selection,
/// dust handling, and per-input key lookup, and a second copy of that would be
/// a second place for the change arithmetic to be wrong.
#[allow(clippy::too_many_arguments)]
async fn spend_to(
    client: &Client,
    network: Network,
    wallet: &Wallet,
    script_pubkey: Vec<u8>,
    sats: u64,
    fee_rate: u64,
    gap: u32,
    broadcast: bool,
) -> Result<Spend> {
    let coin = default_coin_type(network);

    // Collect spendable outputs together with the path that controls each, so
    // the right key signs the right input.
    let mut spendable: Vec<(tx::Utxo, String)> = Vec::new();
    for change in [false, true] {
        for index in 0..gap {
            let path = hd::address_path(coin, 0, change, index);
            let address = wallet.address(network, &path)?;
            for u in client.utxos(&address.electrum_scripthash()).await? {
                let mut txid = decode_hex32(&u.tx_hash)?;
                // Electrum reports txids big-endian; the wire format is
                // little-endian. Skipping this reversal produces a transaction
                // that spends nothing and is simply rejected.
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
    let (chosen, fee) = tx::select_coins(&pool, sats, fee_rate, 2)?;
    let input_total: u64 = chosen.iter().map(|u| u.value).sum();
    let change_value = input_total - sats - fee;

    let mut outputs = vec![tx::Output::new(sats, script_pubkey)];
    // Below the dust limit a change output cannot be spent, so it goes to the
    // miner as extra fee instead of being created unspendable.
    const DUST: u64 = 546;
    let change_path = hd::address_path(coin, 0, true, 0);
    if change_value >= DUST {
        outputs.push(tx::Output::new(
            change_value,
            wallet.address(network, &change_path)?.script_pubkey(),
        ));
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

    let txid = if broadcast {
        Some(client.broadcast(&raw_hex).await?)
    } else {
        None
    };

    Ok(Spend {
        txid,
        raw_hex,
        fee,
        change: if change_value >= DUST {
            change_value
        } else {
            0
        },
        inputs: chosen.len(),
        size_bytes: raw.len(),
    })
}

/// Assemble an HTTP request from the command-line pieces.
///
/// Plain HTTP is refused off localhost. The payment header carries a signed
/// authorisation to debit our funded credit, so anyone able to read it in
/// transit can spend that credit on their own requests.
fn request_spec(
    url: &str,
    method: &str,
    data: &Option<String>,
    headers: &[String],
) -> Result<x402::RequestSpec> {
    let insecure = url.strip_prefix("http://");
    if let Some(rest) = insecure {
        let host = rest.split(['/', ':', '?']).next().unwrap_or("");
        if !matches!(host, "localhost" | "127.0.0.1" | "[::1]") {
            return Err(CliError::Usage(format!(
                "refusing plain HTTP to {host}: the payment header authorises a debit \
                 and can be replayed by anyone who reads it — use https"
            )));
        }
    } else if !url.starts_with("https://") {
        return Err(CliError::Usage(format!("'{url}' is not an http(s) URL")));
    }

    let mut spec = x402::RequestSpec::get(url);
    spec.method = method.to_ascii_uppercase();
    spec.body = data.clone();
    for raw in headers {
        spec.headers.push(x402::parse_header(raw)?);
    }
    Ok(spec)
}

/// Set while `serve` is running, so a command cannot block on stdin.
static SERVING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Accept connections and answer them until the process is stopped.
async fn listen(config: serve::Shared) -> Result<()> {
    use http_body_util::{BodyExt, Full};
    use hyper::body::Bytes;
    use hyper::service::service_fn;
    use hyper::{Method, Request as HyperRequest, Response, StatusCode};
    use hyper_util::rt::TokioIo;

    let listener = tokio::net::TcpListener::bind(config.address)
        .await
        .map_err(|e| CliError::Usage(format!("could not bind {}: {e}", config.address)))?;

    loop {
        let (stream, _) = listener
            .accept()
            .await
            .map_err(|e| CliError::Network(format!("could not accept a connection: {e}")))?;
        let config = config.clone();

        tokio::task::spawn_local(async move {
            let service = service_fn(move |request: HyperRequest<hyper::body::Incoming>| {
                let config = config.clone();
                async move {
                    let reply = |status: StatusCode, body: Value| {
                        Response::builder()
                            .status(status)
                            .header("content-type", "application/json")
                            // No browser origin may read this. A page on any
                            // site can already POST to localhost; without this
                            // it could also read the answer.
                            .header("access-control-allow-origin", "null")
                            .body(Full::new(Bytes::from(body.to_string())))
                            .expect("a JSON response always builds")
                    };

                    let presented = request
                        .headers()
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.strip_prefix("Bearer "))
                        .unwrap_or("");
                    if !serve::token_matches(&config.token, presented) {
                        return Ok::<_, std::convert::Infallible>(reply(
                            StatusCode::UNAUTHORIZED,
                            serve::rpc_error(None, -32001, "a bearer token is required"),
                        ));
                    }

                    if request.method() == Method::GET && request.uri().path() == "/skills" {
                        return Ok(reply(StatusCode::OK, serve::manifest(&config)));
                    }
                    if request.method() != Method::POST {
                        return Ok(reply(
                            StatusCode::METHOD_NOT_ALLOWED,
                            serve::rpc_error(None, -32600, "POST / or GET /skills"),
                        ));
                    }

                    // Bounded before it is read: an unbounded body from a
                    // local caller is still a way to exhaust this process.
                    let collected = match request.into_body().collect().await {
                        Ok(body) => body.to_bytes(),
                        Err(e) => {
                            return Ok(reply(
                                StatusCode::BAD_REQUEST,
                                serve::rpc_error(None, -32700, &format!("unreadable body: {e}")),
                            ))
                        }
                    };
                    if collected.len() > 256 * 1024 {
                        return Ok(reply(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            serve::rpc_error(None, -32600, "request body is too large"),
                        ));
                    }

                    let parsed: serve::Request = match serde_json::from_slice(&collected) {
                        Ok(request) => request,
                        Err(e) => {
                            return Ok(reply(
                                StatusCode::BAD_REQUEST,
                                serve::rpc_error(None, -32700, &format!("bad JSON: {e}")),
                            ))
                        }
                    };
                    let id = parsed.id.clone();

                    if let Err(error) = serve::admits(&config, &parsed) {
                        return Ok(reply(
                            StatusCode::FORBIDDEN,
                            serve::rpc_error(id, -32601, &error.to_string()),
                        ));
                    }

                    let argv = serve::argv(&config, &parsed);
                    let parsed_cli = match Cli::try_parse_from(&argv) {
                        Ok(cli) => cli,
                        Err(e) => {
                            return Ok(reply(
                                StatusCode::BAD_REQUEST,
                                serve::rpc_error(id, -32602, &e.to_string()),
                            ))
                        }
                    };

                    // Boxed to break the recursion: `run` reaches `listen`
                    // reaches `run`, and the future type would be infinite.
                    match Box::pin(run(&parsed_cli)).await {
                        Ok(value) => Ok(reply(StatusCode::OK, serve::rpc_result(id, value))),
                        Err(error) => Ok(reply(
                            StatusCode::OK,
                            serve::rpc_error(id, -32000, &error.to_string()),
                        )),
                    }
                }
            });

            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
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
/// A recovery phrase from the environment or stdin.
///
/// Never from an argument. Arguments appear in shell history and in `ps`
/// output to every other user on the machine, and a recovery phrase is the
/// whole wallet.
fn read_phrase() -> Result<String> {
    if let Ok(v) = std::env::var("OPTN_MNEMONIC") {
        if !v.trim().is_empty() {
            return Ok(v);
        }
    }
    if SERVING.load(std::sync::atomic::Ordering::SeqCst) {
        // Nobody is at the other end of a server's stdin, so reading it would
        // hang the request rather than prompt anyone.
        return Err(CliError::Usage(
            "no recovery phrase available — store one with `optn keychain store` \
             or set OPTN_MNEMONIC before starting the server"
                .to_string(),
        ));
    }
    use std::io::Read;
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| CliError::Usage(format!("could not read the phrase from stdin: {e}")))?;
    if buf.trim().is_empty() {
        return Err(CliError::Usage(
            "no recovery phrase supplied — set OPTN_MNEMONIC or pipe the phrase on stdin"
                .to_string(),
        ));
    }
    Ok(buf)
}

/// The wallet for this invocation.
///
/// Sources in order: `OPTN_MNEMONIC`, then the keychain, then stdin. The
/// environment wins so a scripted run can override without clearing a stored
/// phrase, and stdin comes last because reaching it means blocking on input —
/// which for a binary designed to be driven by automation is a hang, not a
/// prompt.
fn read_wallet(cli: &Cli) -> Result<Wallet> {
    let passphrase = std::env::var("OPTN_PASSPHRASE").unwrap_or_default();

    if let Ok(v) = std::env::var("OPTN_MNEMONIC") {
        if !v.trim().is_empty() {
            return Wallet::from_mnemonic(v.trim(), &passphrase);
        }
    }
    if let Some(stored) = keychain::load(cli.network, &cli.profile)? {
        return Wallet::from_mnemonic(stored.trim(), &passphrase);
    }
    Wallet::from_mnemonic(read_phrase()?.trim(), &passphrase)
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

/// Decode an even-length hex string.
fn decode_hex(s: &str) -> Result<Vec<u8>> {
    if s.len() % 2 != 0 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(CliError::Usage(format!("'{s}' is not valid hex")));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&s[i..i + 2], 16)
                .map_err(|e| CliError::Usage(format!("bad hex: {e}")))
        })
        .collect()
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
        Command::X402 { action } => match action {
            X402Command::Check { .. } => {
                if v.get("payment_required").and_then(Value::as_bool) != Some(true) {
                    println!("status    {}  no payment required", n("status"));
                } else {
                    println!("status    {}  payment required", n("status"));
                    println!("price     {} sats", n("sats"));
                    println!("pay to    {}", s("pay_to"));
                    println!("chain     {}", s("chain"));
                    println!("scheme    {}", s("scheme"));
                }
            }
            X402Command::Pay { .. } => {
                if v.get("dry_run").and_then(Value::as_bool) == Some(true) {
                    println!("would pay {} sats to {}", n("sats"), s("pay_to"));
                    println!("as        {}", s("from"));
                    println!("{}: {}", s("header_name"), s("header"));
                    return;
                }
                println!("status    {}", n("status"));
                if v.get("paid").and_then(Value::as_bool) == Some(true) {
                    println!("paid      {} sats to {}", n("sats"), s("pay_to"));
                }
                if let Some(funding) = v.get("funding").filter(|f| !f.is_null()) {
                    println!("funded    {}", funding);
                }
                println!(
                    "{}",
                    serde_json::to_string_pretty(v.get("body").unwrap_or(&Value::Null))
                        .unwrap_or_default()
                );
            }
        },
        _ => println!("{}", serde_json::to_string_pretty(v).unwrap_or_default()),
    }
}

#[cfg(test)]
mod manifest_tests {
    use super::*;
    use clap::CommandFactory;

    /// Every subcommand clap knows about, as the user types it.
    fn clap_subcommands() -> Vec<String> {
        Cli::command()
            .get_subcommands()
            .map(|c| c.get_name().to_string())
            .collect()
    }

    #[test]
    fn every_command_is_classified_in_the_skill_manifest() {
        // The gate refuses anything it cannot classify, so a command missing
        // here does not silently become permitted — it becomes unusable. Both
        // are bugs, and this is where they are cheap to find.
        let missing: Vec<String> = clap_subcommands()
            .into_iter()
            .filter(|name| name != "help" && skills::find(name).is_none())
            .collect();
        assert!(
            missing.is_empty(),
            "not in the skill manifest: {}",
            missing.join(", ")
        );
    }

    #[test]
    fn the_manifest_lists_no_command_that_does_not_exist() {
        // The other direction. A stale entry tells an agent it can invoke
        // something that was renamed or removed.
        let known = clap_subcommands();
        let stale: Vec<&str> = skills::SKILLS
            .iter()
            .map(|s| s.name)
            .filter(|name| !known.iter().any(|k| k == name))
            .collect();
        assert!(
            stale.is_empty(),
            "in the manifest but not a command: {}",
            stale.join(", ")
        );
    }

    #[test]
    fn command_name_agrees_with_clap_for_every_command() {
        // command_name() is what the gate looks up. If it returned a name clap
        // does not use, the lookup would miss and the command would be refused
        // as unknown — or worse, match a different skill's capability.
        let known = clap_subcommands();
        for skill in skills::SKILLS {
            assert!(
                known.iter().any(|k| k == skill.name),
                "{} is not a clap subcommand",
                skill.name
            );
        }
    }

    #[test]
    fn commands_that_need_a_wallet_are_never_merely_read() {
        // Reading the phrase is not a read-only act. A command marked
        // needs_wallet but classified Read would be reachable under a
        // read-only policy and would still derive keys.
        for skill in skills::SKILLS.iter().filter(|s| s.needs_wallet) {
            assert_ne!(
                skill.capability,
                skills::Capability::Read,
                "{} needs the wallet but is classified read-only",
                skill.name
            );
        }
    }
}
