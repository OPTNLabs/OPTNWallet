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
mod token;
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
            token,
        } => {
            let wallet = read_wallet()?;
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

            let mut outputs = vec![tx::Output::new(*sats, destination.script_pubkey())];
            // Below the dust limit a change output cannot be spent, so it goes
            // to the miner as extra fee instead of being created unspendable.
            const DUST: u64 = 546;
            let change_path = hd::address_path(coin, 0, true, 0);
            if change_value >= DUST {
                outputs.push(tx::Output::new(
                    change_value,
                    wallet.address(cli.network, &change_path)?.script_pubkey(),
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
            let wallet = read_wallet()?;
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
            let wallet = read_wallet()?;
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
            let wallet = read_wallet()?;
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
        _ => println!("{}", serde_json::to_string_pretty(v).unwrap_or_default()),
    }
}
