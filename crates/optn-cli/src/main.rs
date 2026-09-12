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

mod console;
mod contract;
mod electrum;
mod keychain;
mod lmots;
mod msgsign;
mod network_settings;
mod serve;
mod skills;
mod token;
mod tx;
mod wallet_security;
mod x402;

// These modules live in optn-core so the wallet can reach the same code
// through wasm32. Re-exported under their old paths so every `crate::rpa::...`
// in this binary keeps resolving.
pub(crate) use optn_core::{cashaddr, error, hd, network, rpa};

use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use bip39::{Language, Mnemonic};
use optn_chain_native::{build_native_chain_stack, NativeChainSecrets};
use optn_multisig_core::{inspect_p2sh20, Network as MultisigNetwork};
use optn_runtime::chain::{build_selection_plan, ProtocolFamily};
use optn_runtime::chain_service::{ChainOperation, ChainPayload, ChainRequest};
use optn_runtime::tx_broadcast::{BroadcastCoordinator, BroadcastState};

use cashaddr::Address;
use electrum::Client;
use error::{CliError, Result};
use hd::Wallet;
use network::Network;

#[derive(Parser)]
#[command(name = "optn", version, about = "OPTN Wallet command-line interface")]
struct Cli {
    /// Open a saved encrypted wallet instead of the legacy phrase/keychain sources.
    #[arg(long, global = true, value_name = "FILE")]
    wallet: Option<String>,
    /// Directory shared with the native GUI (override for portable wallets).
    #[arg(long, global = true)]
    wallet_directory: Option<PathBuf>,
    /// Read wallet passwords from piped stdin, never from command arguments.
    #[arg(long, global = true, requires = "wallet")]
    password_stdin: bool,
    #[arg(skip)]
    wallet_session: std::sync::Arc<tokio::sync::OnceCell<optn_runtime::AppRuntime>>,

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

    /// Directory holding the desktop wallet's persisted network settings.
    /// Defaults to the normal app config directory; OPTN_NETWORK_CONFIG_DIR
    /// provides the same override for scripts.
    #[arg(long, global = true, value_name = "DIR")]
    network_config_dir: Option<PathBuf>,

    /// Which stored wallet to use, when more than one is in the keychain.
    ///
    /// Keyed with the network, so a mainnet and a chipnet wallet may share a
    /// profile name without one overwriting the other.
    #[arg(long, global = true, default_value = "default")]
    profile: String,

    /// Seconds to wait before giving up. Defaults to 300 for rescan, history,
    /// and wallet; 30 otherwise.
    #[arg(long, global = true)]
    timeout: Option<u64>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Manage saved encrypted wallets through the same runtime as the native GUI.
    Wallet {
        /// Override the shared native wallet directory.
        #[arg(long)]
        directory: Option<PathBuf>,
        /// Read private JSON requests from stdin and emit public JSON responses.
        #[arg(long)]
        stdio: bool,
    },
    /// Check the server is reachable and report its version.
    Ping,
    /// Inspect the durable source policy shared with the desktop host.
    Network {
        #[command(subcommand)]
        action: NetworkCommand,
    },
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
        /// Decode the transaction (locally when using the shared chain policy).
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
    /// Refresh through the shared Rust HD runtime. Saved encrypted wallets
    /// retain the same checkpoint as the GUI; restored data remains stale
    /// until a complete live refresh succeeds.
    Rescan {
        /// Consecutive unused addresses required on each HD branch.
        #[arg(long, default_value_t = 20)]
        gap: u32,
        /// Fail incomplete if a branch reaches this bound before its unused gap.
        #[arg(long, default_value_t = 200)]
        max_addresses: u32,
        /// Selected BIP44 origin, including imported nondefault coin types.
        #[arg(long)]
        account_path: Option<String>,
        /// Public account key. Omit to derive it from the selected stored wallet.
        #[arg(long)]
        xpub: Option<String>,
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
    /// Quantumroot's post-quantum signatures (LM-OTS).
    ///
    /// Quantumroot is a vault implemented in CashAssembly whose signing scheme
    /// is Leighton-Micali One-Time Signatures — RFC 8554, parameter set
    /// LMOTS_SHA256_N32_W4, resting on SHA-256 alone.
    ///
    /// One-time is the security model, not a caveat: a key that signs twice
    /// can be forged against.
    Quantumroot {
        #[command(subcommand)]
        action: QuantumrootCommand,
    },
    /// An interactive console over the same commands.
    ///
    /// The command line is fine for one question and tiresome for ten: each
    /// invocation re-reads the phrase, reconnects, and re-parses the same
    /// flags. This keeps them and takes commands as you would type them.
    Console {
        /// Print JSON rather than the human-readable form.
        #[arg(long)]
        json: bool,
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
    /// Inspect a deterministic shared P2SH20 multisig policy from public keys.
    ///
    /// This is read-only: it neither derives keys nor accesses a wallet,
    /// network, keychain, or transaction state.
    Multisig {
        #[command(subcommand)]
        action: MultisigCommand,
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
    /// Reusable payment addresses — cashcodes.
    ///
    /// One published code, a fresh on-chain address per payment. The sender
    /// derives it by ECDH against the code's scan key plus the first input's
    /// outpoint, so nothing on chain links two payments to the same code.
    Rpa {
        #[command(subcommand)]
        action: RpaCommand,
    },
}

#[derive(Subcommand)]
enum NetworkCommand {
    /// Show sources, policy, and the primary/fallback selection order.
    Status,
    /// Select an existing shared source without a public fallback.
    Select {
        source: String,
        #[arg(long, value_enum)]
        protocol: ChainProtocol,
    },
    /// Fetch live headers and check predecessor link, declared PoW, and ASERT.
    Headers {
        /// First height. Defaults to a window ending at the current tip.
        #[arg(long)]
        start: Option<u32>,
        /// Headers to fetch and verify. Must be at least 2.
        #[arg(long, default_value_t = 8)]
        count: u32,
    },
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum ChainProtocol {
    Electrum,
    Bip37,
    Neutrino,
    NodeRpc,
    NodeEvents,
}

impl From<ChainProtocol> for ProtocolFamily {
    fn from(value: ChainProtocol) -> Self {
        match value {
            ChainProtocol::Electrum => Self::Electrum,
            ChainProtocol::Bip37 => Self::Bip37,
            ChainProtocol::Neutrino => Self::Neutrino,
            ChainProtocol::NodeRpc => Self::BchnRpc,
            ChainProtocol::NodeEvents => Self::BchnZmq,
        }
    }
}

#[derive(Subcommand)]
enum RpaCommand {
    /// Sweep discovered BCH-only Cash Code receipts to one ordinary address.
    Sweep {
        destination: String,
        #[arg(long)]
        from_height: u32,
        #[arg(long, default_value_t = 0)]
        account: u32,
        #[arg(long, default_value_t = 1)]
        fee_rate: u64,
        /// Sign and show the transaction without broadcasting it.
        #[arg(long, conflicts_with = "yes")]
        dry_run: bool,
        /// Authorize sweeping all discovered non-token receipts, minus the fee.
        #[arg(long)]
        yes: bool,
    },
    /// Discover and reconcile Cash Code receipts using the selected shared chain
    /// policy. BIP37 downloads complete blocks locally; there is no server fallback.
    Discover {
        /// Inclusive wallet birth height; never silently restricted to recent blocks.
        #[arg(long)]
        from_height: u32,
        #[arg(long, default_value_t = 0)]
        account: u32,
    },
    /// Print this wallet's cashcode.
    Code {
        /// BIP44 account index.
        #[arg(long, default_value_t = 0)]
        account: u32,
    },
    /// Inspect a Cash Code without spending anything.
    Decode {
        /// The code to read.
        code: String,
    },
    /// Scan one transaction for payments to this wallet's cashcode.
    ///
    /// Public chipnet servers do not implement Fulcrum's `blockchain.reusable.*`,
    /// so the txid has to come from somewhere else — a sender telling you, or a
    /// server that does index it.
    Scan {
        /// Transaction to examine.
        txid: String,
        #[arg(long, default_value_t = 0)]
        account: u32,
    },
    /// Pay a cashcode.
    Pay {
        /// Recipient's Cash Code. A legacy paycode: is not accepted.
        code: String,
        /// Amount in satoshis.
        sats: u64,
        #[arg(long, default_value_t = 1)]
        fee_rate: u64,
        #[arg(long, default_value_t = 20)]
        gap: u32,
        /// Build, grind and sign, print the raw transaction, but do not broadcast.
        #[arg(long)]
        dry_run: bool,
        /// Required to actually broadcast.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum QuantumrootCommand {
    /// Derive a one-time public key from a seed.
    ///
    /// Deterministic, so a vault is restored from its seed rather than from a
    /// backup of 67 separate values.
    Keygen {
        /// 16-byte vault identifier, hex. `I` in RFC 8554.
        #[arg(long)]
        id: String,
        /// Leaf number within the vault. `q` in RFC 8554.
        #[arg(long, default_value_t = 0)]
        leaf: u32,
        /// Also print the private chains. They are the key; treat them so.
        #[arg(long)]
        reveal_private: bool,
    },
    /// Sign a message hash with a one-time key.
    Sign {
        /// The message to sign, hex.
        message: String,
        #[arg(long)]
        id: String,
        #[arg(long, default_value_t = 0)]
        leaf: u32,
        /// 32-byte randomiser, hex. `C` in RFC 8554; generated when absent.
        #[arg(long)]
        c: Option<String>,
        /// Required: this key can only ever sign once.
        #[arg(long)]
        yes: bool,
    },
    /// Check a signature against a public key.
    Verify {
        /// The message, hex.
        message: String,
        /// The signature: C followed by 67 elements, hex.
        #[arg(long)]
        signature: String,
        /// The 32-byte public key, hex.
        #[arg(long)]
        public_key: String,
        #[arg(long)]
        id: String,
        #[arg(long, default_value_t = 0)]
        leaf: u32,
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
enum MultisigCommand {
    /// Validate public keys and produce the BIP-67 redeem script and P2SH20 addresses.
    Inspect {
        /// Signatures required by the policy.
        #[arg(long)]
        threshold: u8,
        /// One compressed secp256k1 public key, as hex. Repeat for every cosigner.
        #[arg(long = "pubkey", required = true)]
        public_keys: Vec<String>,
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

fn emit_cli_error(cli: &Cli, line_protocol: bool, err: CliError) -> ! {
    if cli.json || line_protocol {
        let payload = json!({ "ok": false, "error": err.kind(), "message": err.to_string() });
        if line_protocol {
            println!("{payload}");
        } else {
            println!(
                "{}",
                serde_json::to_string_pretty(&payload).unwrap_or_default()
            );
        }
    } else {
        eprintln!("error: {err}");
    }
    std::process::exit(err.exit_code());
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    // Wallet console prints its own public replies. Do not funnel password
    // prompts or HD xpubs through this process-wide JSON printer.
    if let Command::Wallet { directory, stdio } = &cli.command {
        match wallet_security::run(
            directory.clone().or_else(|| cli.wallet_directory.clone()),
            *stdio,
            &cli,
        )
        .await
        {
            Ok(()) => return,
            Err(err) => emit_cli_error(&cli, *stdio, err),
        }
    }
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
            if value["ok"] == false {
                std::process::exit(if value["state"] == "rejected" { 5 } else { 3 });
            }
        }
        Err(err) => emit_cli_error(&cli, false, err),
    }
}

/// The command as it appears in the skill manifest.
fn command_name(command: &Command) -> &'static str {
    match command {
        Command::Wallet { .. } => "wallet",
        Command::Ping => "ping",
        Command::Network {
            action: NetworkCommand::Select { .. },
        } => "network select",
        Command::Network {
            action: NetworkCommand::Headers { .. },
        } => "network headers",
        Command::Network { .. } => "network",
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
        Command::Multisig { .. } => "multisig",
        Command::Console { .. } => "console",
        Command::Quantumroot { .. } => "quantumroot",
        Command::Serve { .. } => "serve",
        Command::Skills => "skills",
        Command::Keychain { .. } => "keychain",
        Command::X402 { .. } => "x402",
        Command::Rpa { .. } => "rpa",
    }
}

fn client_for(cli: &Cli) -> Result<Client> {
    if cli.host.is_some() || cli.port.is_some() || cli.no_tls {
        return Client::new(
            cli.host
                .clone()
                .unwrap_or_else(|| cli.network.default_host().to_string()),
            cli.port.unwrap_or_else(|| cli.network.default_port()),
            !cli.no_tls,
            timeout_seconds(cli),
        );
    }

    let endpoint =
        network_settings::shared_electrum(cli.network, cli.network_config_dir.as_deref())
            .map_err(CliError::Usage)?;
    match endpoint {
        Some(endpoint) => Client::new(
            endpoint.host().to_owned(),
            endpoint.port(),
            endpoint.encrypted(),
            timeout_seconds(cli),
        ),
        None => Client::new(
            cli.network.default_host().to_owned(),
            cli.network.default_port(),
            true,
            timeout_seconds(cli),
        ),
    }
}

fn timeout_seconds(cli: &Cli) -> u64 {
    cli.timeout.unwrap_or({
        if matches!(
            &cli.command,
            Command::Rescan { .. }
                | Command::History { .. }
                | Command::Wallet { .. }
                | Command::Rpa {
                    action: RpaCommand::Discover { .. } | RpaCommand::Sweep { .. }
                }
        ) {
            300
        } else {
            30
        }
    })
}

fn append_network_config_dir(base: &mut Vec<String>, directory: Option<&Path>) -> Result<()> {
    let Some(directory) = directory else {
        return Ok(());
    };
    let directory = directory.to_str().ok_or_else(|| {
        CliError::Usage("--network-config-dir must be valid Unicode for console and serve".into())
    })?;
    base.push("--network-config-dir".into());
    base.push(directory.into());
    Ok(())
}

fn shared_network_status(cli: &Cli) -> Result<Value> {
    let Some(selection) =
        network_settings::shared_chain_selection(cli.network, cli.network_config_dir.as_deref())
            .map_err(CliError::Usage)?
    else {
        return Ok(json!({
            "ok": true,
            "network": cli.network.to_string(),
            "configured": false,
            "sources": [],
            "primary": [],
            "fallback": [],
            "message": "no durable shared source policy is configured",
        }));
    };
    let plan = build_selection_plan(&selection.catalog, &selection.policy);
    let protocols = [
        ProtocolFamily::Electrum,
        ProtocolFamily::Bip37,
        ProtocolFamily::Neutrino,
        ProtocolFamily::BchnRpc,
        ProtocolFamily::BchnZmq,
    ]
    .into_iter()
    .filter(|protocol| selection.policy.protocols.contains(*protocol))
    .map(|protocol| format!("{protocol:?}"))
    .collect::<Vec<_>>();
    let sources = selection
        .catalog
        .iter()
        .map(|source| {
            json!({
                "id": source.id.as_str(),
                "label": source.label,
                "origin": format!("{:?}", source.origin),
                "disposition": format!("{:?}", source.disposition),
                "priority": source.priority,
                "endpoints": source.endpoints.iter().map(|endpoint| json!({
                    "kind": format!("{:?}", endpoint.kind),
                    "host": endpoint.host,
                    "port": endpoint.port,
                })).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "ok": true,
        "network": cli.network.to_string(),
        "configured": true,
        "policy": {
            "protocols": protocols,
            "primary_scope": format!("{:?}", selection.policy.primary_scope),
            "fallback_scope": selection.policy.fallback_scope.as_ref().map(|scope| format!("{scope:?}")),
            "preferred": selection.policy.preferred.iter().map(|source| source.as_str()).collect::<Vec<_>>(),
        },
        "sources": sources,
        "primary": plan.primary.iter().map(|source| source.as_str()).collect::<Vec<_>>(),
        "fallback": plan.fallback.iter().map(|source| source.as_str()).collect::<Vec<_>>(),
    }))
}

async fn verify_selected_headers(cli: &Cli, start: Option<u32>, count: u32) -> Result<Value> {
    if count < 2 {
        return Err(CliError::Usage(
            "header verification needs at least 2 consecutive headers".into(),
        ));
    }
    let client = client_for(cli)?;
    let (tip_height, _) = client.tip().await?;
    let count = count.min(2016);
    let start_height = match start {
        Some(height) => height,
        None => tip_height.saturating_sub(count.saturating_sub(1)),
    };
    if start_height > tip_height {
        return Err(CliError::Usage(format!(
            "start height {start_height} is above tip {tip_height}"
        )));
    }
    let available = tip_height.saturating_sub(start_height).saturating_add(1);
    let count = count.min(available);
    let headers = client.block_headers(start_height, count).await?;
    if headers.len() < 2 {
        return Err(CliError::Protocol(
            "server returned fewer than 2 headers".into(),
        ));
    }
    let checked = verify_header_batch(cli.network, start_height, &headers)?;
    Ok(json!({
        "ok": true,
        "network": cli.network.to_string(),
        "endpoint": client.endpoint(),
        "tip_height": tip_height,
        "start_height": start_height,
        "count": headers.len(),
        "asert": true,
        "evidence": "HeaderLinked",
        "last_height": start_height + u32::try_from(headers.len().saturating_sub(1))
            .map_err(|_| CliError::Protocol("header count exceeds u32".into()))?,
        "last_hash": hex(&checked),
    }))
}

fn verify_header_batch(
    network: Network,
    start_height: u32,
    headers: &[[u8; 80]],
) -> Result<[u8; 32]> {
    use optn_core::asert::{verify_header_extension, AsertAnchor, AsertCheck, AsertParams};
    use optn_core::header_pow::verify_declared_pow;

    let mut previous = verify_declared_pow(&headers[0])
        .map_err(|e| CliError::Protocol(format!("header {start_height} failed PoW: {e:?}")))?;
    for (offset, header) in headers.iter().enumerate().skip(1) {
        let previous_height = start_height
            .checked_add(u32::try_from(offset - 1).expect("header offset fits u32"))
            .ok_or_else(|| CliError::Protocol("header height overflow".into()))?;
        previous = verify_header_extension(
            previous.hash,
            header,
            Some(AsertCheck {
                params: AsertParams::for_network(network),
                anchor: AsertAnchor::for_network(network),
                previous_height,
                previous_time: i64::from(previous.time),
            }),
        )
        .map_err(|e| {
            CliError::Protocol(format!(
                "header {} failed ASERT/link check: {e}",
                previous_height + 1
            ))
        })?;
    }
    Ok(previous.hash)
}

async fn ping_selected_chain(cli: &Cli) -> Result<Value> {
    // Command-line endpoint flags are an explicit per-invocation override.
    // Without one, the CLI uses the exact durable selection shared with Tauri.
    if cli.host.is_some() || cli.port.is_some() || cli.no_tls {
        let client = client_for(cli)?;
        let version = client.server_version().await?;
        return Ok(json!({
            "ok": true,
            "network": cli.network.to_string(),
            "selection": "command-line-electrum",
            "endpoint": client.endpoint(),
            "server": version,
        }));
    }

    let Some(selection) =
        network_settings::shared_chain_selection(cli.network, cli.network_config_dir.as_deref())
            .map_err(CliError::Usage)?
    else {
        let client = client_for(cli)?;
        let version = client.server_version().await?;
        return Ok(json!({
            "ok": true,
            "network": cli.network.to_string(),
            "selection": "legacy-electrum-default",
            "endpoint": client.endpoint(),
            "server": version,
        }));
    };

    let stack = build_native_chain_stack(
        selection.catalog,
        selection.policy,
        &cli.network.to_string(),
        &NativeChainSecrets::default(),
    )
    .await;
    let routes = stack
        .service
        .lock()
        .await
        .routes_for_operation(ChainOperation::HeaderSync);
    if routes.is_empty() {
        let failures = stack
            .failures
            .iter()
            .map(|failure| {
                format!(
                    "{:?} {}:{}: {}",
                    failure.protocol,
                    failure.endpoint.host,
                    failure.endpoint.port.unwrap_or_default(),
                    failure.error
                )
            })
            .collect::<Vec<_>>();
        return Err(CliError::Network(format!(
            "the selected shared chain policy has no usable header route{}",
            if failures.is_empty() {
                String::new()
            } else {
                format!(": {}", failures.join("; "))
            }
        )));
    }
    Ok(json!({
        "ok": true,
        "network": cli.network.to_string(),
        "selection": "shared-native-policy",
        "routes": routes.into_iter().map(|route| json!({
            "source": route.source.as_str(),
            "protocol": format!("{:?}", route.protocol),
            "endpoint": route.endpoint.map(|endpoint| json!({
                "kind": format!("{:?}", endpoint.kind),
                "host": endpoint.host,
                "port": endpoint.port,
            })),
        })).collect::<Vec<_>>(),
    }))
}

fn decoded_transaction_json(bytes: &[u8]) -> Result<Value> {
    let d = tx::decode(bytes)?;
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

fn configured_chain(cli: &Cli) -> Result<Option<network_settings::SharedChainSelection>> {
    if cli.host.is_some() || cli.port.is_some() || cli.no_tls {
        Ok(None)
    } else {
        network_settings::shared_chain_selection(cli.network, cli.network_config_dir.as_deref())
            .map_err(CliError::Usage)
    }
}

async fn transaction_selected_chain(cli: &Cli, txid: &str, verbose: bool) -> Result<Value> {
    let mut requested = decode_hex32(txid)?;
    requested.reverse();
    let Some(selection) = configured_chain(cli)? else {
        let transaction = client_for(cli)?.transaction(txid, verbose).await?;
        return Ok(json!({"ok": true, "txid": txid, "transaction": transaction}));
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(timeout_seconds(cli)),
        async {
            let stack = build_native_chain_stack(
                selection.catalog,
                selection.policy,
                &cli.network.to_string(),
                &NativeChainSecrets::default(),
            )
            .await;
            let observation = stack
                .service
                .lock()
                .await
                .execute(&ChainRequest::TransactionLookup { txid: requested })
                .await
                .map_err(|error| {
                    CliError::Network(format!("shared transaction lookup failed: {error:?}"))
                })?;
            let ChainPayload::Transaction(transaction) = observation.value else {
                return Err(CliError::Protocol(
                    "transaction route returned an unexpected payload".into(),
                ));
            };
            let value = if verbose {
                decoded_transaction_json(&transaction.raw)?
            } else {
                Value::String(hex(&transaction.raw))
            };
            Ok(json!({
                "ok": true, "txid": txid, "transaction": value,
                "network": cli.network.to_string(), "selection": "shared-native-policy",
                "source": observation.source.as_str(),
                "evidence": format!("{:?}", observation.evidence),
            }))
        },
    )
    .await
    .map_err(|_| CliError::Network("shared transaction lookup timed out".into()))?
}

async fn broadcast_selected_chain(cli: &Cli, raw: &str) -> Result<Value> {
    let bytes = decode_hex(raw)?;
    if bytes.is_empty() {
        return Err(CliError::Usage("transaction must be non-empty hex".into()));
    }
    let txid = optn_core::header_hash::sha256d(&bytes);
    let Some(selection) = configured_chain(cli)? else {
        let txid = client_for(cli)?.broadcast(raw).await?;
        return Ok(json!({"ok": true, "network": cli.network.to_string(), "txid": txid}));
    };
    let budget = std::time::Duration::from_secs(timeout_seconds(cli));
    let stack = tokio::time::timeout(
        budget,
        build_native_chain_stack(
            selection.catalog,
            selection.policy,
            &cli.network.to_string(),
            &NativeChainSecrets::default(),
        ),
    )
    .await;
    let outcome = match stack {
        Err(_) => BroadcastState::Unavailable { txid },
        Ok(stack) => {
            let mut service = stack.service.lock().await;
            tokio::time::timeout(
                budget,
                BroadcastCoordinator.submit(&mut service, bytes, txid),
            )
            .await
            .unwrap_or(BroadcastState::Uncertain {
                txid,
                attempts: vec![],
            })
        }
    };
    let (state, ok, source) = match outcome {
        BroadcastState::Submitted { via, .. } => ("submitted", true, Some(via)),
        BroadcastState::Observed { via, .. } => ("observed", true, Some(via)),
        BroadcastState::Uncertain { .. } => ("uncertain", false, None),
        BroadcastState::Rejected { .. } => ("rejected", false, None),
        BroadcastState::Unavailable { .. } | BroadcastState::Prepared { .. } => {
            ("unavailable", false, None)
        }
    };
    let mut display = txid;
    display.reverse();
    Ok(
        json!({"ok": ok, "network": cli.network.to_string(), "selection": "shared-native-policy",
            "txid": hex(&display), "state": state, "source": source.map(|source| source.as_str().to_owned()),
        }),
    )
}

async fn address_selected_chain(cli: &Cli, address: &str, include_outputs: bool) -> Result<Value> {
    let parsed = parse_address(address, cli.network)?;
    let scripthash = parsed.electrum_scripthash();
    let Some(selection) = configured_chain(cli)? else {
        if include_outputs {
            let utxos = client_for(cli)?.utxos(&scripthash).await?;
            let total: u64 = utxos.iter().map(|output| output.value).sum();
            return Ok(
                json!({"ok": true, "network": cli.network.to_string(), "address": address,
                "count": utxos.len(), "total": total, "utxos": utxos.iter().map(|output| json!({
                    "txid":output.tx_hash, "vout":output.tx_pos, "height":output.height, "value":output.value,
                })).collect::<Vec<_>>()}),
            );
        }
        let balance = client_for(cli)?.balance(&scripthash).await?;
        return Ok(
            json!({"ok": true, "network": cli.network.to_string(), "address": address,
            "scripthash": scripthash, "confirmed": balance.confirmed, "unconfirmed": balance.unconfirmed,
            "total": balance.confirmed + balance.unconfirmed}),
        );
    };
    tokio::time::timeout(std::time::Duration::from_secs(timeout_seconds(cli)), async {
        let mut worker = hd_sync_worker(cli.network, &selection.policy)?;
        let stack = build_native_chain_stack(
            selection.catalog,
            selection.policy,
            &cli.network.to_string(),
            &NativeChainSecrets::default(),
        )
        .await;
        let script = parsed.script_pubkey();
        // A one-address observation session, not the user's stored HD wallet.
        // Use the same publication/reconciliation path as other Rust interfaces.
        let runtime = optn_runtime::AppRuntime::spawn(optn_app::AppState {
            network: cli.network,
            wallet: Some(optn_app::OpenedWallet {
                kind: optn_app::WalletKind::WatchOnly,
                name: "Address observation".into(),
                receive_address: address.to_owned(),
                master_fingerprint: None,
                account_path: String::new(),
                multisig_policy: None,
                account_xpub: None,
            }),
            ..Default::default()
        });
        runtime
            .sync_wallet(
                &mut *stack.service.lock().await,
                &mut worker,
                vec![address.to_owned()],
                None,
            )
            .await
            .map_err(|error| {
                CliError::Network(format!("shared wallet refresh failed: {error:?}"))
            })?;
        let status = runtime.subscribe_wallet_sync().borrow().clone();
        if !status.sync.history_fresh || !status.sync.utxos_fresh {
            return Err(CliError::Network("wallet refresh did not publish a fresh snapshot".into()));
        }
        let snapshot = status
            .authoritative
            .as_ref()
            .ok_or_else(|| {
                CliError::Protocol("refresh produced no authoritative snapshot".into())
            })?;
        let (confirmed, unconfirmed) = snapshot.value.script_balance(&script)?;
        let mut value =
            json!({"ok": true, "network": cli.network.to_string(), "address": address,
            "scripthash": scripthash, "confirmed": confirmed, "unconfirmed": unconfirmed,
            "total": confirmed + unconfirmed, "selection": "shared-native-policy",
            "source": snapshot.source.as_str(), "evidence": format!("{:?}", snapshot.evidence)});
        if include_outputs {
            let coins = runtime.state().coins;
            let heights = snapshot.value.transactions.iter().map(|tx| (tx.txid, tx.block_height))
                .collect::<std::collections::BTreeMap<_,_>>();
            value["count"] = json!(coins.len());
            value["utxos"] = json!(coins.iter().map(|coin| {
                let mut internal = coin.outpoint().txid();
                internal.reverse();
                json!({"txid":coin.outpoint().txid_hex(), "vout":coin.outpoint().vout(), "value":coin.value_sats(),
                    "height":heights.get(&internal).copied().flatten().unwrap_or(0),
                    "token":coin.token().map(|token| json!({
                        "category":token.category_hex(), "amount":token.amount,
                        "nft":token.nft.as_ref().map(|nft| json!({"capability":nft.capability.as_str(), "commitment":hex(&nft.commitment)})),
                    })),
                })
            }).collect::<Vec<_>>());
        }
        Ok(value)
    })
    .await
    .map_err(|_| CliError::Network("shared wallet refresh timed out".into()))?
}

async fn rescan_shared_wallet(
    cli: &Cli,
    gap: u32,
    cap: u32,
    all: bool,
    account_path: Option<&str>,
    xpub: Option<&str>,
) -> Result<Value> {
    use optn_runtime::chain::{
        ChainSource, ConnectionPolicy, Endpoint, EndpointKind, SourceCatalog, SourceDisposition,
        SourceId, SourceOrigin,
    };
    optn_runtime::hd_sync::HdSyncLimits {
        gap_limit: gap,
        addresses_per_branch: cap,
    }
    .validate()
    .map_err(CliError::Usage)?;
    let managed = if cli.wallet.is_some() {
        Some(wallet_security::open_managed_runtime(cli).await?)
    } else {
        None
    };
    let stored = managed.and_then(|runtime| runtime.state().wallet);
    let default_account = stored
        .as_ref()
        .map(|wallet| hd::parse_account_path(&wallet.account_path))
        .transpose()?
        .unwrap_or_else(|| hd::AccountPath::default_for(cli.network));
    let account = account_path
        .map(hd::parse_account_path)
        .transpose()?
        .unwrap_or(default_account);
    if managed.is_some() && account != default_account {
        return Err(CliError::Usage(
            "The rescan account must match the selected saved wallet.".into(),
        ));
    }
    let xpub = match xpub {
        Some(xpub) => xpub.to_owned(),
        None if managed.is_some() => stored
            .as_ref()
            .and_then(|wallet| wallet.account_xpub.clone())
            .ok_or_else(|| CliError::Usage("The selected wallet has no HD account.".into()))?,
        // Drop the temporary seed-holding Wallet before starting provider I/O.
        None => read_wallet(cli).await?.account_xpub_at(account)?,
    };
    if managed.is_some()
        && stored
            .as_ref()
            .and_then(|wallet| wallet.account_xpub.as_deref())
            != Some(xpub.as_str())
    {
        return Err(CliError::Usage(
            "The rescan xpub must match the selected saved wallet.".into(),
        ));
    }
    let receive = optn_core::watch_only::address_under_account(cli.network, &xpub, 0, 0)?;
    let selection = match configured_chain(cli)? {
        Some(selection) => selection,
        None => {
            let id = SourceId::new("cli-electrum");
            let mut catalog = SourceCatalog::default();
            catalog
                .insert(ChainSource {
                    id: id.clone(),
                    label: "CLI Electrum selection".into(),
                    origin: SourceOrigin::UserAdded,
                    endpoints: vec![Endpoint {
                        kind: if cli.no_tls {
                            EndpointKind::ElectrumTcp
                        } else {
                            EndpointKind::ElectrumTls
                        },
                        host: cli
                            .host
                            .clone()
                            .unwrap_or_else(|| cli.network.default_host().into()),
                        port: Some(cli.port.unwrap_or_else(|| cli.network.default_port())),
                    }],
                    capabilities: Default::default(),
                    disposition: SourceDisposition::Enabled,
                    priority: 0,
                })
                .map_err(|error| CliError::Usage(format!("invalid chain selection: {error:?}")))?;
            network_settings::SharedChainSelection {
                catalog,
                policy: ConnectionPolicy::exact(id, ProtocolFamily::Electrum),
            }
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(timeout_seconds(cli)), async {
        let runtime = managed.cloned().unwrap_or_else(|| optn_runtime::AppRuntime::spawn(optn_app::AppState {
            network: cli.network,
            wallet: Some(optn_app::OpenedWallet {
                kind: optn_app::WalletKind::WatchOnly, name: "HD account rescan".into(),
                receive_address: receive.address, master_fingerprint: None, account_path: account.to_string(),
                multisig_policy: None, account_xpub: Some(xpub.clone()),
            }), ..Default::default()
        }));
        let mut worker = hd_sync_worker(cli.network, &selection.policy)?;
        let stack = build_native_chain_stack(selection.catalog, selection.policy, &cli.network.to_string(), &NativeChainSecrets::default()).await;
        runtime.sync_hd_wallet(&mut *stack.service.lock().await, &mut worker, xpub,
            optn_runtime::hd_sync::HdSyncLimits { gap_limit: gap, addresses_per_branch: cap })
            .await.map_err(|error| CliError::Network(format!("HD rescan incomplete: {error}")))?;
        let status = runtime.subscribe_wallet_sync().borrow().clone();
        if !status.sync.history_fresh || !status.sync.utxos_fresh {
            return Err(CliError::Network("HD rescan did not publish a complete account".into()));
        }
        let snapshot = status.authoritative.ok_or_else(|| CliError::Protocol("HD rescan has no snapshot".into()))?;
        let book = snapshot.value.hd.as_ref().ok_or_else(|| CliError::Protocol("HD rescan has no address book".into()))?;
        let mut addresses = Vec::new();
        for (branch, entries) in book.branches.iter().enumerate() {
            for (index, address) in entries.iter().enumerate() {
                let script = Address::decode(&address.address).map_err(CliError::Protocol)?.script_pubkey();
                let (confirmed, unconfirmed) = snapshot.value.script_balance(&script)?;
                let utxos = snapshot.value.script_outputs(&script)?;
                if all || confirmed != 0 || unconfirmed != 0 || !utxos.is_empty() {
                    addresses.push(json!({"path": address.path, "address": address.address,
                        "chain": (["receiving", "change", "defi", "compatibility"][branch]),
                        "branch":optn_core::watch_only::HD_SCAN_BRANCHES[branch], "index": index,
                        "confirmed": confirmed, "unconfirmed": unconfirmed, "utxos": utxos.len()}));
                }
            }
        }
        let state = runtime.state();
        if !state.wallet_sync.history_fresh || !state.wallet_sync.utxos_fresh || state.wallet.is_none() {
            return Err(CliError::Network("HD wallet session ended before reporting its result".into()));
        }
        let confirmed_total = state.wallet_sync.confirmed_sats.ok_or_else(|| CliError::Protocol("HD balance is unavailable".into()))?;
        let unconfirmed_total = state.wallet_sync.pending_sats;
        let total = state.wallet_sync.total_sats().ok_or_else(|| CliError::Protocol("HD total balance overflow".into()))?;
        Ok(json!({"ok":true, "hd":true, "complete":true, "network":cli.network.to_string(),
            "account_path":account.to_string(), "gap":gap, "max_addresses":cap,
            "selection":"shared-native-policy", "source":snapshot.source.as_str(),
            "evidence":format!("{:?}",snapshot.evidence),
            "header_verifier": worker.header_verifier().is_some(),
            "mmr": worker.header_verifier().is_some()
                && !matches!(snapshot.evidence, optn_runtime::chain::Evidence::ServerAssertion),
            "branches":optn_core::watch_only::HD_SCAN_BRANCHES, "last_used":book.last_used,
            "scanned_addresses":snapshot.value.interests.len(), "confirmed":confirmed_total,
            "unconfirmed":unconfirmed_total, "total":total, "utxos":state.coins.len(), "addresses":addresses,
            "wallet_sync":optn_transport::WireState::from(&state).wallet_sync}))
    }).await.map_err(|_| CliError::Network("HD rescan timed out before completing the account".into()))?
}

fn hd_sync_worker(
    network: Network,
    policy: &optn_runtime::chain::ConnectionPolicy,
) -> Result<optn_runtime::sync_worker::ProgressiveSyncWorker> {
    use optn_runtime::chain::ProtocolFamily;
    let worker = optn_runtime::sync_worker::ProgressiveSyncWorker::new(Default::default());
    let p2p = policy.protocols.contains(ProtocolFamily::Bip37)
        || policy.protocols.contains(ProtocolFamily::Neutrino);
    if !p2p {
        return Ok(worker);
    }
    if network != Network::Chipnet {
        return Err(CliError::Usage(
            "BIP37/Neutrino refresh needs a host-authenticated header checkpoint for this network"
                .into(),
        ));
    }
    let verifier = optn_runtime::header_verifier::shipped_chipnet_header_verifier()
        .map_err(|e| CliError::Usage(format!("Chipnet header verifier: {e:?}")))?;
    worker
        .with_header_verifier(network, verifier)
        .map_err(|e| CliError::Usage(format!("header verifier: {e:?}")))
}

async fn run(cli: &Cli) -> Result<Value> {
    // Before anything else, including opening a connection. A refusal should
    // cost nothing and reveal nothing about the wallet.
    skills::enforce(skills::Policy::from_env()?, command_name(&cli.command))?;
    if cli.wallet.is_some()
        && (matches!(cli.command, Command::Serve { .. })
            || SERVING.load(std::sync::atomic::Ordering::SeqCst))
    {
        return Err(CliError::Usage(
            "Saved wallet sessions require local terminal or private stdio authentication.".into(),
        ));
    }

    if let Command::Wallet { .. } = &cli.command {
        unreachable!("wallet console is handled in main before run()");
    }
    match &cli.command {
        Command::Wallet { .. } => unreachable!("handled before network setup"),
        Command::Network {
            action: NetworkCommand::Status,
        } => return shared_network_status(cli),
        Command::Network {
            action: NetworkCommand::Select { source, protocol },
        } => {
            network_settings::select_source(
                cli.network,
                cli.network_config_dir.as_deref(),
                source,
                (*protocol).into(),
            )
            .map_err(CliError::Usage)?;
            return shared_network_status(cli);
        }
        Command::Network {
            action: NetworkCommand::Headers { start, count },
        } => return verify_selected_headers(cli, *start, *count).await,
        Command::Ping => return ping_selected_chain(cli).await,
        Command::Tx { txid, verbose } => {
            return transaction_selected_chain(cli, txid, *verbose).await
        }
        Command::Broadcast { hex } => return broadcast_selected_chain(cli, hex).await,
        Command::Balance { address } => return address_selected_chain(cli, address, false).await,
        Command::Utxos { address } => return address_selected_chain(cli, address, true).await,
        _ => {}
    }

    // Resolve the legacy route only when an operation actually needs it.
    // Cache it for the command so a settings edit cannot mix endpoints mid-scan.
    let legacy_client = std::cell::OnceCell::new();
    let client = || -> Result<&Client> {
        if legacy_client.get().is_none() {
            let _ = legacy_client.set(client_for(cli)?);
        }
        Ok(legacy_client.get().expect("client initialized above"))
    };

    match &cli.command {
        Command::Wallet { .. } => unreachable!("handled before network setup"),
        Command::Ping
        | Command::Network { .. }
        | Command::Tx { .. }
        | Command::Broadcast { .. } => {
            unreachable!("handled before Electrum setup")
        }
        Command::Balance { .. } | Command::Utxos { .. } => {
            unreachable!("handled before Electrum setup")
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
        Command::Multisig { action } => match action {
            MultisigCommand::Inspect {
                threshold,
                public_keys,
            } => {
                let network = match cli.network {
                    Network::Mainnet => MultisigNetwork::Mainnet,
                    // The multisig core models two chains. Regtest shares
                    // chipnet's address encoding, which is all this inspection
                    // depends on, and saying so beats silently widening that
                    // crate's own network model.
                    Network::Chipnet | Network::Regtest => MultisigNetwork::Chipnet,
                };
                let public_key_refs = public_keys.iter().map(String::as_str).collect::<Vec<_>>();
                let inspection = inspect_p2sh20(network, *threshold, &public_key_refs)
                    .map_err(|error| CliError::Usage(error.to_string()))?;
                Ok(json!({
                    "ok": true,
                    "network": cli.network.to_string(),
                    "threshold": inspection.threshold,
                    "total_signatures": inspection.total_signatures,
                    "sorted_public_keys": inspection.sorted_public_keys.iter().map(|key| hex(key)).collect::<Vec<_>>(),
                    "redeem_script": hex(&inspection.redeem_script),
                    "locking_script": hex(&inspection.locking_script),
                    "address": inspection.address,
                    "token_address": inspection.token_address,
                }))
            }
        },
        Command::New { words } => {
            // Lengths live in optn-core so the wallet UI cannot drift from `optn new`.
            hd::entropy_len_for_word_count(*words)?;
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
            let wallet = read_wallet(cli).await?;
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
            let wallet = read_wallet(cli).await?;
            let spend = spend_to(
                client()?,
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
        Command::Decode { hex: raw } => decoded_transaction_json(&decode_hex(raw)?),
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
            let wallet = read_wallet(cli).await?;
            let coin = default_coin_type(cli.network);
            const TOKEN_DUST: u64 = 1000;

            let mut matches: Vec<(tx::Utxo, String, token::Nft, u64)> = Vec::new();
            let mut plain_inputs: Vec<(tx::Utxo, String)> = Vec::new();

            for change in [false, true] {
                for index in 0..*gap {
                    let path = hd::address_path(coin, 0, change, index);
                    let address = wallet.address(cli.network, &path)?;
                    for u in client()?.utxos(&address.electrum_scripthash()).await? {
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

            let txid = client()?.broadcast(&raw_hex).await?;
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
            let wallet = read_wallet(cli).await?;
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
                    for u in client()?.utxos(&address.electrum_scripthash()).await? {
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

            let txid = client()?.broadcast(&raw_hex).await?;
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
            let wallet = read_wallet(cli).await?;
            let coin = default_coin_type(cli.network);
            // category -> (fungible total, nft count)
            let mut fungible: std::collections::BTreeMap<String, u128> = Default::default();
            let mut nfts: Vec<Value> = Vec::new();
            let mut token_utxos = 0usize;

            for change in [false, true] {
                for index in 0..*gap {
                    let path = hd::address_path(coin, 0, change, index);
                    let address = wallet.address(cli.network, &path)?;
                    for u in client()?.utxos(&address.electrum_scripthash()).await? {
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
        Command::Rescan {
            gap,
            all,
            max_addresses,
            account_path,
            xpub,
        } => {
            rescan_shared_wallet(
                cli,
                *gap,
                *max_addresses,
                *all,
                account_path.as_deref(),
                xpub.as_deref(),
            )
            .await
        }
        Command::History { gap, limit } => {
            let result = rescan_shared_wallet(
                cli,
                *gap,
                optn_core::discovery::ADDRESS_CAP.max(*gap),
                false,
                None,
                None,
            )
            .await?;
            let entries = result["wallet_sync"]["history"]
                .as_array()
                .ok_or_else(|| CliError::Protocol("shared wallet history is unavailable".into()))?;
            let shown = entries.iter().take(*limit).cloned().collect::<Vec<_>>();
            Ok(json!({"ok":true, "network":cli.network.to_string(),
                "count":entries.len(), "shown":shown.len(), "transactions":shown,
                "source":result["source"], "evidence":result["evidence"],
                "header_verifier": result["header_verifier"],
                "mmr": result["mmr"],
                "confirmed":result["confirmed"], "unconfirmed":result["unconfirmed"],
                "total":result["total"], "complete":result["complete"]}))
        }
        Command::Discover { gap } => {
            let wallet = read_wallet(cli).await?;
            let mut found = Vec::new();
            for &coin in hd::scan_coin_types(cli.network) {
                for &account in hd::SCAN_ACCOUNTS {
                    let mut total: i64 = 0;
                    let mut used = 0u32;
                    for change in [false, true] {
                        for index in 0..*gap {
                            let path = hd::address_path(coin, account, change, index);
                            let address = wallet.address(cli.network, &path)?;
                            let balance = client()?.balance(&address.electrum_scripthash()).await?;
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
        Command::Quantumroot { action } => {
            let vault_id = |raw: &str| -> Result<[u8; 16]> {
                let bytes = decode_hex(raw)?;
                if bytes.len() != 16 {
                    return Err(CliError::Usage(format!(
                        "--id is the 16-byte vault identifier, got {} bytes",
                        bytes.len()
                    )));
                }
                let mut id = [0u8; 16];
                id.copy_from_slice(&bytes);
                Ok(id)
            };

            match action {
                QuantumrootCommand::Keygen {
                    id,
                    leaf,
                    reveal_private,
                } => {
                    let seed = read_phrase()?;
                    let key =
                        lmots::PrivateKey::from_seed(seed.trim().as_bytes(), vault_id(id)?, *leaf);
                    let public = key.public_key();
                    let mut out = json!({
                        "ok": true,
                        "scheme": "LMOTS_SHA256_N32_W4",
                        "id": id,
                        "leaf": leaf,
                        "public_key": hex(&public),
                        "chains": lmots::P,
                    });
                    if *reveal_private {
                        // Behind a flag, because this is the whole key and
                        // stdout is not a safe place for it by default.
                        out["private_chains"] =
                            json!(key.chains().iter().map(|c| hex(c)).collect::<Vec<_>>());
                    }
                    Ok(out)
                }

                QuantumrootCommand::Sign {
                    message,
                    id,
                    leaf,
                    c,
                    yes,
                } => {
                    if !*yes {
                        // Not a spend, but as irreversible: this key may never
                        // sign again, and nothing on the chain will stop it.
                        return Err(CliError::Usage(
                            "refusing to sign without --yes: an LM-OTS key signs once, \
                             and signing a second time lets anyone forge a third message"
                                .to_string(),
                        ));
                    }
                    let randomiser = match c {
                        Some(given) => {
                            let bytes = decode_hex(given)?;
                            if bytes.len() != lmots::N {
                                return Err(CliError::Usage(format!(
                                    "--c is {} bytes, got {}",
                                    lmots::N,
                                    bytes.len()
                                )));
                            }
                            let mut out = [0u8; lmots::N];
                            out.copy_from_slice(&bytes);
                            out
                        }
                        None => {
                            use rand::RngCore;
                            let mut out = [0u8; lmots::N];
                            rand::rngs::OsRng.fill_bytes(&mut out);
                            out
                        }
                    };

                    let seed = read_phrase()?;
                    let id_bytes = vault_id(id)?;
                    let key = lmots::PrivateKey::from_seed(seed.trim().as_bytes(), id_bytes, *leaf);
                    let public = key.public_key();
                    let signature = key.sign(&decode_hex(message)?, &randomiser);

                    Ok(json!({
                        "ok": true,
                        "scheme": "LMOTS_SHA256_N32_W4",
                        "id": id,
                        "leaf": leaf,
                        "public_key": hex(&public),
                        "c": hex(&signature.c),
                        "signature": signature.elements.iter().map(|e| hex(e))
                            .collect::<Vec<_>>().join(""),
                        "elements": signature.elements.len(),
                        "warning": "this key has now signed; it must never sign again",
                    }))
                }

                QuantumrootCommand::Verify {
                    message,
                    signature,
                    public_key,
                    id,
                    leaf,
                } => {
                    let raw = decode_hex(signature)?;
                    // C followed by the elements, which is how sign emits it.
                    let expected = lmots::N * (lmots::P + 1);
                    if raw.len() != expected {
                        return Err(CliError::Usage(format!(
                            "a signature is {expected} bytes (C plus {} elements), got {}",
                            lmots::P,
                            raw.len()
                        )));
                    }
                    let mut c = [0u8; lmots::N];
                    c.copy_from_slice(&raw[..lmots::N]);
                    let elements: Vec<[u8; lmots::N]> = raw[lmots::N..]
                        .chunks(lmots::N)
                        .map(|chunk| {
                            let mut out = [0u8; lmots::N];
                            out.copy_from_slice(chunk);
                            out
                        })
                        .collect();

                    let key_bytes = decode_hex(public_key)?;
                    if key_bytes.len() != lmots::N {
                        return Err(CliError::Usage(format!(
                            "--public-key is {} bytes, got {}",
                            lmots::N,
                            key_bytes.len()
                        )));
                    }
                    let mut expected_key = [0u8; lmots::N];
                    expected_key.copy_from_slice(&key_bytes);

                    let parsed = lmots::Signature {
                        id: vault_id(id)?,
                        q: *leaf,
                        c,
                        elements,
                    };
                    let bytes = decode_hex(message)?;
                    let valid = parsed.verify(&bytes, &expected_key);
                    Ok(json!({
                        "ok": true,
                        "valid": valid,
                        "scheme": "LMOTS_SHA256_N32_W4",
                        "expected_public_key": hex(&expected_key),
                        // Only when it fails: on success it is the expected key
                        // and repeating it says nothing, but on failure it is
                        // the one piece of evidence about what went wrong.
                        "recovered_public_key": if valid {
                            Value::Null
                        } else {
                            json!(hex(&parsed.recover(&bytes)?))
                        },
                    }))
                }
            }
        }
        Command::Console { json } => {
            use std::io::Write;

            let mut base = vec!["--network".to_string(), cli.network.to_string()];
            if cli.profile != "default" {
                base.push("--profile".to_string());
                base.push(cli.profile.clone());
            }
            append_network_config_dir(&mut base, cli.network_config_dir.as_deref())?;
            let policy = skills::Policy::from_env()?;

            eprintln!("optn console — {} ({})", cli.network, policy.ceiling());
            eprintln!("`help` lists commands, `quit` leaves.");

            let stdin = std::io::stdin();
            loop {
                eprint!("optn> ");
                let _ = std::io::stderr().flush();

                // Release stdin before dispatch so wallet authentication can read it.
                let mut line = String::new();
                if stdin
                    .read_line(&mut line)
                    .map_err(|e| CliError::Usage(format!("could not read input: {e}")))?
                    == 0
                {
                    break;
                }

                let parsed = match console::parse(&line) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        eprintln!("error: {error}");
                        continue;
                    }
                };

                match parsed {
                    console::Line::Empty => continue,
                    console::Line::Quit => break,
                    console::Line::Help => {
                        // From the manifest, so it cannot list a command the
                        // gate would refuse or omit one it allows.
                        for skill in skills::SKILLS {
                            let mark = if policy.admits(skill.capability) {
                                ' '
                            } else {
                                'x'
                            };
                            eprintln!(
                                "  {mark} {:<12} {:<7} {}",
                                skill.name,
                                skill.capability.as_str(),
                                skill.summary
                            );
                        }
                        eprintln!("  (x = refused by the current policy)");
                        continue;
                    }
                    console::Line::Command(args) => {
                        let argv = console::argv(&base, &args, *json);
                        // Clap's nested parser can exceed the Windows main-thread stack
                        // while this dispatch frame is live. Parse on the blocking pool.
                        let parsed = tokio::task::spawn_blocking(move || Cli::try_parse_from(argv))
                            .await
                            .map_err(|_| {
                                CliError::Internal("Console argument parsing failed.".into())
                            })?;
                        let mut parsed_cli = match parsed {
                            Ok(parsed) => parsed,
                            Err(error) => {
                                // clap already formats this well; printing it
                                // whole is better than paraphrasing it.
                                eprintln!("{error}");
                                continue;
                            }
                        };

                        parsed_cli.wallet = parsed_cli.wallet.or_else(|| cli.wallet.clone());
                        parsed_cli.wallet_directory = parsed_cli
                            .wallet_directory
                            .or_else(|| cli.wallet_directory.clone());
                        parsed_cli.password_stdin |= cli.password_stdin;
                        // Only reuse authentication for the same resolved wallet selection.
                        // An explicit override keeps the parser's fresh session.
                        if parsed_cli.wallet == cli.wallet
                            && parsed_cli.wallet_directory == cli.wallet_directory
                            && parsed_cli.network == cli.network
                        {
                            parsed_cli.wallet_session = std::sync::Arc::clone(&cli.wallet_session);
                        }

                        // Boxed for the same reason as serve: the console is
                        // reached from run, and reaches it back.
                        match Box::pin(run(&parsed_cli)).await {
                            Ok(value) => {
                                if *json {
                                    println!(
                                        "{}",
                                        serde_json::to_string_pretty(&value).unwrap_or_default()
                                    );
                                } else {
                                    print_human(&parsed_cli.command, &value);
                                }
                            }
                            // Printed, not returned: one bad command should not
                            // end the session.
                            Err(error) => eprintln!("error: {error}"),
                        }
                    }
                }
            }

            Ok(json!({ "ok": true, "console": "closed" }))
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
            append_network_config_dir(&mut base_args, cli.network_config_dir.as_deref())?;

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
        Command::Rpa { action } => match action {
            RpaCommand::Sweep {
                destination,
                from_height,
                account,
                fee_rate,
                dry_run,
                yes,
            } => {
                use optn_runtime::chain_service::{
                    ChainBackendError, ChainOperation, ChainServiceError,
                };
                if !*dry_run && !*yes {
                    return Err(CliError::Usage(
                        "Cash Code sweep requires --dry-run or --yes".into(),
                    ));
                }
                parse_address(destination, cli.network)?;
                let selection = configured_chain(cli)?.ok_or_else(|| CliError::Usage("Cash Code sweep requires a saved shared source policy; host overrides are not permitted".into()))?;
                let wallet = read_wallet(cli).await?;
                let keys = optn_runtime::rpa_receive::CashcodeScanKeys::from_wallet(
                    &wallet,
                    cli.network,
                    optn_core::hd::AccountPath::new(cli.network.default_coin_type(), *account)?,
                )
                .map_err(CliError::Usage)?;
                let worker = hd_sync_worker(cli.network, &selection.policy)?;
                let budget = std::time::Duration::from_secs(timeout_seconds(cli));
                let stack = tokio::time::timeout(
                    budget,
                    build_native_chain_stack(
                        selection.catalog,
                        selection.policy,
                        &cli.network.to_string(),
                        &NativeChainSecrets::default(),
                    ),
                )
                .await
                .map_err(|_| {
                    CliError::Network("Cash Code source connection timed out before signing".into())
                })?;
                let mut worker = worker.with_accepted_headers(stack.headers.clone());
                let mut service = stack.service.lock().await;
                let scan = tokio::time::timeout(budget, optn_runtime::rpa_receive::scan_cashcode(&mut service, &mut worker, &keys, *from_height))
                    .await.map_err(|_| CliError::Network("Cash Code discovery timed out before signing; no transaction was broadcast".into()))?.map_err(CliError::Network)?;
                let sweep = optn_runtime::rpa_receive::prepare_cashcode_sweep(
                    &keys,
                    &scan,
                    destination,
                    *fee_rate,
                )
                .map_err(CliError::Usage)?;
                let state = if *dry_run {
                    "not_broadcast"
                } else {
                    let route = service.routes_for_operation(ChainOperation::Broadcast).into_iter().find(|route|
                        route.source == scan.source && route.protocol == scan.protocol && route.endpoint == scan.endpoint)
                        .ok_or_else(|| CliError::Network("The exact discovery endpoint cannot broadcast; no fallback is allowed".into()))?;
                    match tokio::time::timeout(
                        budget,
                        service.execute_on_route(
                            &route,
                            &ChainRequest::Broadcast {
                                raw_tx: sweep.raw.clone(),
                                txid: sweep.txid,
                            },
                        ),
                    )
                    .await
                    {
                        Ok(Ok(observed)) if matches!(observed.value, ChainPayload::BroadcastObserved { txid } if txid == sweep.txid) => {
                            "submitted"
                        }
                        Ok(Err(
                            ChainServiceError::NoEligibleProvider
                            | ChainServiceError::RouteUnavailable,
                        )) => "unavailable",
                        Ok(Err(ChainServiceError::Exhausted { attempts }))
                            if !attempts.is_empty()
                                && attempts.iter().all(|attempt| {
                                    matches!(attempt.error, ChainBackendError::Rejected(_))
                                }) =>
                        {
                            "rejected"
                        }
                        _ => "uncertain",
                    }
                };
                let mut display = sweep.txid;
                display.reverse();
                Ok(
                    json!({ "ok": matches!(state, "not_broadcast" | "submitted"), "network": cli.network.to_string(),
                    "dry_run": dry_run, "state": state, "txid": hex(&display), "destination": destination,
                    "amount_sats": sweep.amount_sats, "fee_sats": sweep.fee_sats, "inputs": sweep.input_count,
                    "raw_hex": if *dry_run { Some(hex(&sweep.raw)) } else { None },
                    "source": scan.source.as_str(), "protocol": format!("{:?}", scan.protocol), "includes_mempool": scan.includes_mempool,
                    "warning": if !scan.includes_mempool { Some("Confirmed-chain-only scan: unconfirmed spends were not checked. Submitted is not confirmation; never blindly retry an uncertain broadcast.") }
                        else if state == "uncertain" { Some("Broadcast acceptance is uncertain. Check this txid before retrying.") } else { None } }),
                )
            }
            RpaCommand::Discover {
                from_height,
                account,
            } => {
                let selection = configured_chain(cli)?.ok_or_else(|| CliError::Usage(
                    "Cash Code discovery requires a saved exact source policy; use network select --protocol. Host overrides cannot select a fallback.".into()
                ))?;
                let wallet = read_wallet(cli).await?;
                let keys = optn_runtime::rpa_receive::CashcodeScanKeys::from_wallet(
                    &wallet,
                    cli.network,
                    optn_core::hd::AccountPath::new(cli.network.default_coin_type(), *account)?,
                )
                .map_err(CliError::Usage)?;
                let worker = hd_sync_worker(cli.network, &selection.policy)?;
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(timeout_seconds(cli)),
                    async {
                        let stack = build_native_chain_stack(
                            selection.catalog,
                            selection.policy,
                            &cli.network.to_string(),
                            &NativeChainSecrets::default(),
                        )
                        .await;
                        let mut worker = worker.with_accepted_headers(stack.headers.clone());
                        let mut service = stack.service.lock().await;
                        optn_runtime::rpa_receive::scan_cashcode(
                            &mut service,
                            &mut worker,
                            &keys,
                            *from_height,
                        )
                        .await
                    },
                )
                .await
                .map_err(|_| {
                    CliError::Network(
                        "Cash Code discovery timed out; no complete result is available".into(),
                    )
                })?
                .map_err(CliError::Network)?;
                Ok(
                    json!({ "ok": true, "network": cli.network.to_string(), "from_height": result.from_height,
                    "tip_height": result.tip.height, "source": result.source.as_str(), "protocol": format!("{:?}", result.protocol),
                    "evidence": format!("{:?}", result.evidence), "complete_requested_scope": true, "includes_mempool": result.includes_mempool,
                    "receipts": result.receipts }),
                )
            }
            RpaCommand::Code { account } => {
                let wallet = read_wallet(cli).await?;
                let coin = default_coin_type(cli.network);
                let scan_path = rpa::scan_path(coin, *account);
                let spend_path = rpa::spend_path(coin, *account);
                let scan = wallet.public_key(&scan_path)?;
                let spend = wallet.public_key(&spend_path)?;
                Ok(json!({
                    "ok": true,
                    "network": cli.network.to_string(),
                    "cashcode": rpa::encode(&scan, &spend, cli.network, rpa::RPA_PREFIX_BITS),
                    "prefix_bits": rpa::RPA_PREFIX_BITS,
                    "grind_string": rpa::grind_string(&scan, rpa::RPA_PREFIX_BITS)?,
                    "scan_path": scan_path,
                    "spend_path": spend_path,
                }))
            }
            RpaCommand::Decode { code } => {
                let d = rpa::decode(code)?;
                Ok(json!({
                    "ok": true,
                    "prefix": d.prefix,
                    "network": d.network().to_string(),
                    "version": d.version,
                    "prefix_bits": d.prefix_bits,
                    "scan_pubkey": hex(&d.scan_pubkey),
                    "spend_pubkey": hex(&d.spend_pubkey),
                    "expiry": d.expiry,
                }))
            }
            RpaCommand::Scan { txid, account } => {
                let wallet = read_wallet(cli).await?;
                let coin = default_coin_type(cli.network);
                let scan_priv: [u8; 32] = wallet
                    .signing_key(&rpa::scan_path(coin, *account))?
                    .to_bytes()
                    .into();
                let spend_pub = wallet.public_key(&rpa::spend_path(coin, *account))?;
                let raw_hex = client()?.transaction(txid, false).await?;
                let raw_hex = raw_hex.as_str().ok_or_else(|| {
                    CliError::Protocol("server did not return raw transaction hex".into())
                })?;
                let raw = decode_hex(raw_hex)?;
                let found = rpa::scan_transaction(&raw, &scan_priv, &spend_pub, cli.network)?;

                // Detection alone does not mean the coin can be moved. Derive
                // the spending key for each match and check it really controls
                // the address that was paid.
                let spend_priv: [u8; 32] = wallet
                    .signing_key(&rpa::spend_path(coin, *account))?
                    .to_bytes()
                    .into();
                let mut spendable = Vec::with_capacity(found.len());
                for m in &found {
                    let controlled =
                        rpa::spending_key_address(&spend_priv, &m.secret, 0, cli.network)?;
                    spendable.push(controlled.encode() == m.address);
                }

                Ok(json!({
                    "ok": true,
                    "network": cli.network.to_string(),
                    "txid": txid,
                    "matches": found.iter().zip(&spendable).map(|(m, ok)| json!({
                        "output_index": m.output_index,
                        "address": m.address,
                        "sats": m.value,
                        "spendable": ok,
                        "derived_from": { "txid": m.prevout_txid, "vout": m.prevout_index },
                    })).collect::<Vec<_>>(),
                    "total": found.iter().map(|m| m.value).sum::<u64>(),
                }))
            }
            RpaCommand::Pay {
                code,
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
                // Named before the generic refusal below, so pasting a
                // legacy PayCode says what is wrong with it rather than
                // "not a Cash Code".
                if rpa::is_legacy_paycode(code) {
                    return Err(CliError::Usage(rpa::LEGACY_PAYCODE_REJECTION.to_string()));
                }
                if !rpa::looks_like_rpa(code) {
                    return Err(CliError::Usage(format!(
                        "'{code}' is not a Cash Code — expected a cashcode: or cashcodetest: string. To send to an ordinary address, use `send`."
                    )));
                }
                let decoded = rpa::decode(code)?;
                if decoded.network() != cli.network {
                    return Err(CliError::Usage(format!(
                        "that code is for {}, but this is {}",
                        decoded.network(),
                        cli.network
                    )));
                }
                if let Some(reason) = rpa::send_block_reason(&decoded) {
                    return Err(CliError::Usage(reason));
                }
                let wallet = read_wallet(cli).await?;
                let paid = rpa_pay(
                    client()?,
                    cli.network,
                    &wallet,
                    &decoded,
                    *sats,
                    *fee_rate,
                    *gap,
                    !*dry_run,
                )
                .await?;
                Ok(json!({
                    "ok": true,
                    "dry_run": *dry_run,
                    "network": cli.network.to_string(),
                    "txid": paid.txid,
                    "stealth_address": paid.stealth_address,
                    "sats": sats,
                    "fee": paid.fee,
                    "change": paid.change,
                    "grind_tries": paid.grind_tries,
                    "sequence": paid.sequence,
                    "raw": if *dry_run { Some(paid.raw_hex) } else { None },
                }))
            }
        },
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
                let attempt = x402::Http::new(timeout_seconds(cli))?
                    .send(&spec, None)
                    .await?;
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
                let http = x402::Http::new(timeout_seconds(cli))?;
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

                let wallet = read_wallet(cli).await?;
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
                        client()?,
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

struct RpaSpend {
    txid: Option<String>,
    stealth_address: String,
    fee: u64,
    change: u64,
    grind_tries: u32,
    sequence: u32,
    raw_hex: String,
}

/// Build, grind and optionally broadcast a payment to a cashcode.
///
/// Two things make this different from an ordinary send. The destination is
/// not known until the coins are chosen — it is derived from input 0's
/// outpoint — and the transaction then has to be ground so the recipient's
/// prefix filter will surface it.
#[allow(clippy::too_many_arguments)]
async fn rpa_pay(
    client: &Client,
    network: Network,
    wallet: &Wallet,
    code: &rpa::Cashcode,
    sats: u64,
    fee_rate: u64,
    gap: u32,
    broadcast: bool,
) -> Result<RpaSpend> {
    let coin = default_coin_type(network);

    // Keep the display txid alongside each coin. The shared secret hashes the
    // outpoint as Electrum reports it, while tx::Utxo stores the reversed wire
    // form — using the wrong one derives an address the recipient never scans.
    let mut spendable: Vec<(tx::Utxo, String, String)> = Vec::new();
    for change in [false, true] {
        for index in 0..gap {
            let path = hd::address_path(coin, 0, change, index);
            let address = wallet.address(network, &path)?;
            for u in client.utxos(&address.electrum_scripthash()).await? {
                let mut txid = decode_hex32(&u.tx_hash)?;
                txid.reverse();
                spendable.push((
                    tx::Utxo {
                        txid,
                        vout: u.tx_pos,
                        value: u.value,
                        script_pubkey: address.script_pubkey(),
                    },
                    path.clone(),
                    u.tx_hash.clone(),
                ));
            }
        }
    }
    if spendable.is_empty() {
        return Err(CliError::Usage(
            "no spendable outputs found - check the network and the gap limit".to_string(),
        ));
    }

    let pool: Vec<tx::Utxo> = spendable.iter().map(|(u, _, _)| u.clone()).collect();

    let lookup = |input: &tx::Utxo| -> Result<(String, String)> {
        spendable
            .iter()
            .find(|(u, _, _)| u.txid == input.txid && u.vout == input.vout)
            .map(|(_, path, display)| (path.clone(), display.clone()))
            .ok_or_else(|| CliError::Internal("selected an unknown utxo".into()))
    };

    // Reported in the refusal below, so the message says what was actually
    // attempted rather than a number the reader has to go and look up.
    let budget = rpa::grind_budget(code.prefix_bits)?;

    // Grinding can exhaust its budget, and when it does the fix is a different
    // transaction, not a different user. Rotating the pool puts a different
    // coin at input 0, which changes the outpoint the destination derives from
    // and so re-rolls the whole search — an independent attempt rather than a
    // retry of the same arithmetic. Telling the caller to "try again with a
    // different coin" was accurate advice and still the wrong place to put it:
    // the grind is deterministic, so the identical command always fails
    // identically, and picking the next coin is something the wallet can do
    // for itself.
    //
    // Bounded by the pool: each rotation is an independent 1-in-2900 failure,
    // so even two leave no realistic chance of surfacing this.
    let rotations = pool.len().clamp(1, 4);
    let mut outcome = None;
    let mut last_err = None;
    for rotation in 0..rotations {
        let mut rotated = pool.clone();
        rotated.rotate_left(rotation);
        let (chosen, fee) = match tx::select_coins(&rotated, sats, fee_rate, 2) {
            Ok(v) => v,
            Err(e) => {
                last_err = Some(e);
                continue;
            }
        };
        let input_total: u64 = chosen.iter().map(|u| u.value).sum();
        let change_value = input_total - sats - fee;

        // The destination depends on input 0, so coin selection has to happen
        // first — and has to happen again for every rotation.
        let first = &chosen[0];
        let (first_path, first_display) = lookup(first)?;
        let first_priv: [u8; 32] = wallet.signing_key(&first_path)?.to_bytes().into();
        let secret =
            rpa::shared_secret(&first_priv, &code.scan_pubkey, &first_display, first.vout)?;
        let stealth = rpa::payment_address(&code.spend_pubkey, &secret, network, 0)?;

        let mut outputs = vec![tx::Output::new(sats, stealth.script_pubkey())];
        const DUST: u64 = 546;
        if change_value >= DUST {
            outputs.push(tx::Output::new(
                change_value,
                wallet
                    .address(network, &hd::address_path(coin, 0, true, 0))?
                    .script_pubkey(),
            ));
        }

        let mut transaction = tx::Transaction::new(chosen.clone(), outputs);
        let mut keys = Vec::with_capacity(chosen.len());
        for input in &chosen {
            keys.push(wallet.signing_key(&lookup(input)?.0)?);
        }

        // Grind in the shared core. The recipient asks their server for
        // transactions whose input hash starts with their scan prefix, so
        // without this the payment is on chain but invisible to them — and a
        // sender that grinds differently from the core is a sender the
        // recipient cannot find.
        if let Some(ground) =
            rpa::grind_transaction(&mut transaction, &keys, &code.scan_pubkey, code.prefix_bits)?
        {
            outcome = Some((
                ground.raw,
                ground.grind_tries,
                ground.sequence,
                stealth,
                fee,
                change_value,
            ));
            break;
        }
    }
    let (raw, grind_tries, sequence, stealth, fee, change_value) = match outcome {
        Some(v) => v,
        None => {
            return Err(last_err.unwrap_or_else(|| {
                CliError::Usage(format!(
                    "could not grind an input prefix for this code after {rotations} coin \
                     selections of {budget} attempts each - the wallet may hold too few \
                     coins to reshape the transaction"
                ))
            }))
        }
    };

    let raw_hex = hex(&raw);
    let txid = if broadcast {
        Some(client.broadcast(&raw_hex).await?)
    } else {
        None
    };

    Ok(RpaSpend {
        txid,
        stealth_address: stealth.encode(),
        fee,
        change: change_value,
        grind_tries,
        sequence,
        raw_hex,
    })
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
async fn read_wallet(cli: &Cli) -> Result<Wallet> {
    if cli.wallet.is_some() {
        return wallet_security::read_managed_wallet(cli).await;
    }
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
    // Delegates rather than restating the table: two copies of the same
    // mapping is how they drift apart.
    network.default_coin_type()
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

#[cfg(test)]
mod rpa_sweep_tests {
    use super::*;

    #[tokio::test]
    async fn sweep_requires_confirmation_before_wallet_or_network_access() {
        let cli = Cli::try_parse_from([
            "optn",
            "--network",
            "chipnet",
            "rpa",
            "sweep",
            "not-an-address",
            "--from-height",
            "1",
        ])
        .unwrap();
        let error = run(&cli).await.unwrap_err().to_string();
        assert!(error.contains("requires --dry-run or --yes"), "{error}");
        assert!(Cli::try_parse_from([
            "optn",
            "rpa",
            "sweep",
            "destination",
            "--from-height",
            "1",
            "--dry-run",
            "--yes"
        ])
        .is_err());
        assert!(Cli::try_parse_from(["optn", "rpa", "sweep", "destination", "--dry-run"]).is_err());
    }
}

#[cfg(test)]
mod header_batch_tests {
    use super::verify_header_batch;
    use optn_core::network::Network;

    fn header_from_hex(hex: &str) -> [u8; 80] {
        let mut header = [0u8; 80];
        for i in 0..80 {
            header[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        header
    }

    #[test]
    fn electrum_hd_worker_does_not_claim_mmr() {
        let policy = optn_runtime::chain::ConnectionPolicy::exact(
            optn_runtime::chain::SourceId::new("cli-electrum"),
            optn_runtime::chain::ProtocolFamily::Electrum,
        );
        let worker = super::hd_sync_worker(Network::Chipnet, &policy).unwrap();
        assert!(worker.header_verifier().is_none());
    }

    #[test]
    fn chipnet_p2p_worker_attaches_shipped_genesis_verifier() {
        let policy = optn_runtime::chain::ConnectionPolicy::exact(
            optn_runtime::chain::SourceId::new("chipnet-peer"),
            optn_runtime::chain::ProtocolFamily::Bip37,
        );
        let worker = super::hd_sync_worker(Network::Chipnet, &policy).unwrap();
        let verifier = worker.header_verifier().expect("P2P must attach SHV");
        assert!(verifier.has_difficulty_context());
        assert_eq!(verifier.state().unwrap().height, 0);
    }

    #[test]
    fn chipnet_electrum_headers_pass_asert_on_the_cli_path() {
        // Same consecutive Chipnet headers as optn-core asert tests (height 322752).
        let prev = header_from_hex("00e0ff3fce8f6b81aa0ed30a9cf02730fd5c5c3d31e5ea79c50c908fa91200000000000059497c97770f494c32670e39a38a5f7282b6089c3713b8ee336d1cb9a9a0f5dafbdca06a45031a1aa04d838d");
        let cur = header_from_hex("0000ff3fdcd2ef553db3e4ef9ac52fcdd900c994a7c8829bdd9c1fdfcd0e00000000000065dfdfbf2166cb985df2ab752e52815440aad540359c80c172211163ccaf434dcee1a06affff001de4aba516");
        let hash = verify_header_batch(Network::Chipnet, 322_752, &[prev, cur]).expect("asert");
        assert_ne!(hash, [0u8; 32]);
    }
}

fn print_human(command: &Command, v: &Value) {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let n = |k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
    match command {
        Command::Ping => {
            println!("network   {}", s("network"));
            if let Some(routes) = v.get("routes").and_then(Value::as_array) {
                for route in routes {
                    println!("route     {route}");
                }
            } else {
                println!("endpoint  {}  reachable", s("endpoint"));
                println!("server    {}", v.get("server").unwrap_or(&Value::Null));
            }
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
        // The console has already printed each command's result. Its own
        // return value is bookkeeping, and echoing it at exit reads like one
        // last command ran.
        Command::Console { .. } | Command::Wallet { .. } => {}
        _ => println!("{}", serde_json::to_string_pretty(v).unwrap_or_default()),
    }
}

#[cfg(test)]
mod manifest_tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn network_selection_is_configure_only_before_any_file_access() {
        let cli = Cli::try_parse_from([
            "optn",
            "network",
            "select",
            "my-node",
            "--protocol",
            "bip37",
        ])
        .unwrap();
        let name = command_name(&cli.command);
        assert_eq!(name, "network select");
        assert!(skills::enforce(skills::Policy::parse("read").unwrap(), name).is_err());
        assert!(skills::enforce(skills::Policy::parse("configure").unwrap(), name).is_ok());
        assert!(skills::enforce(skills::Policy::parse("configure").unwrap(), "send").is_err());
    }

    #[test]
    fn timeout_defaults_follow_command_and_honor_override() {
        for (command, seconds) in [
            ("ping", 30),
            ("rescan", 300),
            ("history", 300),
            ("wallet", 300),
        ] {
            let default = Cli::try_parse_from(["optn", command]).unwrap();
            let explicit = Cli::try_parse_from(["optn", command, "--timeout", "1"]).unwrap();
            assert_eq!(timeout_seconds(&default), seconds);
            assert_eq!(timeout_seconds(&explicit), 1);
        }
    }

    fn command_path_exists(path: &str) -> bool {
        let root = Cli::command();
        let mut current = &root;
        for part in path.split_whitespace() {
            let Some(child) = current.find_subcommand(part) else {
                return false;
            };
            current = child;
        }
        true
    }

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
        let stale: Vec<&str> = skills::SKILLS
            .iter()
            .map(|s| s.name)
            .filter(|name| !command_path_exists(name))
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
        for skill in skills::SKILLS {
            assert!(
                command_path_exists(skill.name),
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
