//! Independent CLI navigation over the same Rust wallet runtime. No GUI dependency.
use crate::error::{CliError, Result};
use optn_app::{AppAction, AppState, SecretText};
use optn_runtime::{wallet_security::WalletSecurity, AppRuntime};
use optn_transport::{
    TransportError, WalletSecurityRequest as Request, WalletSecurityStatus, WireAction, WireState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, IsTerminal, Read, Write},
    path::PathBuf,
};
use zeroize::Zeroizing;

fn message(error: TransportError) -> String {
    match error {
        TransportError::Other(message) | TransportError::InvalidData(message) => message,
        _ => "Wallet security is unavailable on this interface.".into(),
    }
}

fn password(prompt: &str) -> Result<SecretText> {
    rpassword::prompt_password(prompt)
        .map(SecretText::new)
        .map_err(|_| {
            CliError::Usage(
                "Could not read the hidden password prompt. Use --stdio for automation.".into(),
            )
        })
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Input {
    Security { request: Request },
    Action { action: WireAction },
    Chain { chain: ChainCommand },
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ChainCommand {
    Sync,
    History,
}

async fn sync_wallet(cli: &crate::Cli, runtime: &AppRuntime) -> Result<()> {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(crate::timeout_seconds(cli)),
        async {
            let selection = crate::configured_chain(cli)?.ok_or_else(|| {
                CliError::Usage(
                    "Wallet sync requires the shared source policy; remove the --host, --port or --no-tls override and use network select --protocol to select a source.".into(),
                )
            })?;
            let state = runtime.state();
            if state.network != cli.network {
                return Err(CliError::Usage(
                    "The saved wallet belongs to a different network. Select its network explicitly.".into(),
                ));
            }
            let xpub = state.wallet.as_ref()
                .and_then(|wallet| wallet.account_xpub.clone())
                .ok_or_else(|| CliError::Usage("Open a saved HD wallet before syncing.".into()))?;
            let stack = optn_chain_native::build_native_chain_stack(
                selection.catalog,
                selection.policy,
                &cli.network.to_string(),
                &optn_chain_native::NativeChainSecrets::default(),
            ).await;
            let mut worker = optn_runtime::sync_worker::ProgressiveSyncWorker::new(Default::default());
            let decision = runtime.sync_hd_wallet(
                &mut *stack.service.lock().await,
                &mut worker,
                xpub,
                optn_runtime::hd_sync::HdSyncLimits::default(),
            ).await.map_err(|error| CliError::Network(error.to_string()))?;
            if decision != optn_runtime::reconciliation::ReconciliationDecision::Accepted {
                return Err(CliError::Network("Wallet refresh was incomplete; retained history remains stale.".into()));
            }
            Ok(())
        },
    ).await.unwrap_or_else(|_| Err(CliError::Network("Wallet refresh timed out; retained history remains stale.".into())));
    if let Err(error) = &result {
        runtime
            .invalidate_wallet_sync(error.to_string())
            .await
            .map_err(|error| CliError::Network(error.to_string()))?;
    }
    result
}

fn success_reply(state: &AppState, status: WalletSecurityStatus) -> Value {
    json!({"ok": true, "security": status,
        "receive_address": state.wallet.as_ref().map(|wallet| &wallet.receive_address),
        "hd_addresses": state.hd_addresses,
        "wallet_sync": WireState::from(state).wallet_sync})
}

fn print_history(sync: &optn_app::WalletSyncView) {
    println!(
        "Source: {}  Evidence: {}",
        sync.source.as_deref().unwrap_or("unknown"),
        sync.evidence.as_deref().unwrap_or("unknown")
    );
    println!(
        "History fresh: {}  UTXOs fresh: {}  Refreshing: {}",
        sync.history_fresh, sync.utxos_fresh, sync.refreshing
    );
    println!(
        "Confirmed: {} sats  Pending: {} sats  Total: {} sats",
        sync.confirmed_sats
            .map(|sats| sats.to_string())
            .unwrap_or_else(|| "unknown".into()),
        sync.pending_sats,
        sync.total_sats()
            .map(|sats| sats.to_string())
            .unwrap_or_else(|| "unknown".into())
    );
    for entry in &sync.history {
        println!(
            "{:?}  {}  {} sats  {}  height={}  reserved={}",
            entry.kind,
            entry.txid,
            entry.amount_sats,
            entry.address,
            entry
                .block_height
                .map(|height| height.to_string())
                .unwrap_or_else(|| "unknown".into()),
            entry.reserved
        );
    }
    if let Some(error) = &sync.error {
        eprintln!("{error}");
    }
}

async fn execute(
    cli: &crate::Cli,
    runtime: &AppRuntime,
    input: Input,
) -> std::result::Result<WalletSecurityStatus, TransportError> {
    match input {
        Input::Chain { chain } => {
            if matches!(chain, ChainCommand::Sync) {
                sync_wallet(cli, runtime)
                    .await
                    .map_err(|error| TransportError::Other(error.to_string()))?;
            }
            runtime.wallet_security(Request::Status).await
        }
        Input::Security { request } => runtime.wallet_security(request).await,
        Input::Action { action } => {
            let action = AppAction::try_from(action)?;
            // This console's public action surface is intentionally just security navigation.
            if !matches!(
                action,
                AppAction::LockWallet
                    | AppAction::SetAutoLockMinutes(_)
                    | AppAction::AuthorizeSpend { .. }
                    | AppAction::RequestReveal { .. }
                    | AppAction::CancelAuth
                    | AppAction::RecordActivity { .. }
                    | AppAction::IdleCheck { .. }
            ) {
                return Err(TransportError::Unsupported);
            }
            runtime
                .dispatch(action)
                .await
                .map_err(|_| TransportError::Closed)?;
            runtime.wallet_security(Request::Status).await
        }
    }
}

pub async fn run(directory: Option<PathBuf>, stdio: bool, cli: &crate::Cli) -> Result<()> {
    let directory = directory
        .or_else(|| dirs::data_dir().map(|root| root.join("com.optilabs.wallet").join("wallets")))
        .ok_or_else(|| CliError::Usage("Specify a wallet directory.".into()))?;
    let checkpoints =
        optn_chain_native::wallet_checkpoint::WalletCheckpointDirectory(directory.join(".state"));
    let storage = optn_platform_native::wallet_storage::NativeWalletStorage::new(directory);
    let service =
        WalletSecurity::new(Box::new(storage), None).with_checkpoints(Box::new(checkpoints));
    let initial = AppState {
        network: cli.network,
        ..Default::default()
    };
    let (runtime, driver) = AppRuntime::new_with_security(initial, service)
        .map_err(|error| CliError::Usage(message(error)))?;
    // Native work and password derivation must not block terminal input handling.
    let driver_thread = std::thread::spawn(move || {
        match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(executor) => executor.block_on(driver.run()),
            Err(_) => eprintln!("Wallet runtime could not start."),
        }
    });
    if stdio {
        if io::stdin().is_terminal() {
            return Err(CliError::Usage(
                "--stdio requires piped input so credentials are not echoed.".into(),
            ));
        }
        let mut input = io::stdin().lock();
        while let Some(line) = private_line(&mut input, 262_144)? {
            let output = match serde_json::from_str::<Input>(&line) {
                Ok(input) => match execute(cli, &runtime, input).await {
                    Ok(status) => success_reply(&runtime.state(), status),
                    Err(error) => json!({"ok": false, "error": message(error)}),
                },
                Err(_) => json!({"ok": false, "error": "Invalid wallet command."}),
            };
            println!("{output}");
        }
    } else {
        eprintln!("Wallet commands: list, open <file>, import, receive [--acknowledge-gap], sync, history, password, autolock <minutes>, lock, authorize, reveal, quit");
        loop {
            eprint!("wallet> ");
            io::stderr().flush().ok();
            let mut line = String::new();
            if io::stdin()
                .read_line(&mut line)
                .map_err(|_| CliError::Usage("Could not read command.".into()))?
                == 0
            {
                break;
            }
            let line = line.trim();
            let (command, argument) = line.split_once(' ').unwrap_or((line, ""));
            let status = runtime
                .wallet_security(Request::Status)
                .await
                .map_err(|error| CliError::Usage(message(error)))?;
            let request = match command {
                "quit" | "exit" => break,
                "list" => Some(Request::Status),
                "sync" | "history" => {
                    let chain = if command == "sync" {
                        ChainCommand::Sync
                    } else {
                        ChainCommand::History
                    };
                    match execute(cli, &runtime, Input::Chain { chain }).await {
                        Ok(_) => print_history(&runtime.state().wallet_sync),
                        Err(error) => eprintln!("{}", message(error)),
                    }
                    continue;
                }
                "receive" => match argument {
                    "" | "--acknowledge-gap" => Some(Request::NextReceive {
                        epoch: status.epoch,
                        acknowledge_gap: argument == "--acknowledge-gap",
                    }),
                    _ => {
                        eprintln!("Use receive, or receive --acknowledge-gap after reviewing the recovery warning.");
                        None
                    }
                },
                "open" => Some(Request::Open {
                    handle: argument.into(),
                    password: password("Wallet password (empty if none): ")?,
                }),
                "import" => {
                    eprint!("Wallet name: ");
                    io::stderr().flush().ok();
                    let mut name = String::new();
                    io::stdin()
                        .read_line(&mut name)
                        .map_err(|_| CliError::Usage("Could not read name.".into()))?;
                    let mnemonic = password("Recovery phrase: ")?;
                    let new = password("New password (empty for none): ")?;
                    let confirmation = password("Confirm new password: ")?;
                    Some(Request::Create {
                        name: name.trim().into(),
                        mnemonic,
                        bip39_passphrase: SecretText::default(),
                        password: new,
                        confirmation,
                        network: runtime.state().network.to_string(),
                        account_path: optn_core::hd::AccountPath::default_for(
                            runtime.state().network,
                        )
                        .path(),
                    })
                }
                "password" => Some(Request::ChangePassword {
                    current: if status.has_password == Some(false) {
                        None
                    } else {
                        Some(password("Current password: ")?)
                    },
                    password: password("New password: ")?,
                    confirmation: password("Confirm new password: ")?,
                    epoch: status.epoch,
                }),
                "lock" => {
                    runtime
                        .dispatch(AppAction::LockWallet)
                        .await
                        .map_err(|_| CliError::Usage("Wallet runtime stopped.".into()))?;
                    Some(Request::Status)
                }
                "autolock" => {
                    let minutes = argument.parse::<u32>().map_err(|_| {
                        CliError::Usage("Use 0, 15, 30, 60, 120 or 240 minutes.".into())
                    })?;
                    if ![0, 15, 30, 60, 120, 240].contains(&minutes) {
                        eprintln!("Use 0, 15, 30, 60, 120 or 240 minutes.");
                        continue;
                    }
                    runtime
                        .dispatch(AppAction::SetAutoLockMinutes(minutes))
                        .await
                        .map_err(|_| CliError::Usage("Wallet runtime stopped.".into()))?;
                    Some(Request::Status)
                }
                "authorize" | "reveal" => {
                    let action = if command == "reveal" {
                        AppAction::RequestReveal { now_ms: 0 }
                    } else {
                        AppAction::AuthorizeSpend { now_ms: 0 }
                    };
                    runtime
                        .dispatch(action)
                        .await
                        .map_err(|_| CliError::Usage("Wallet runtime stopped.".into()))?;
                    if runtime.state().lock.prompt.is_some() {
                        Some(Request::Authenticate {
                            password: password("Confirm wallet password: ")?,
                            epoch: status.epoch,
                        })
                    } else {
                        Some(Request::Status)
                    }
                }
                "" => None,
                _ => {
                    eprintln!("Unknown wallet command.");
                    None
                }
            };
            if let Some(request) = request {
                match execute(cli, &runtime, Input::Security { request }).await {
                    Ok(status) => {
                        for wallet in status.wallets {
                            println!("{}  {}", wallet.handle, wallet.name);
                        }
                        println!("Open: {}", status.active.as_deref().unwrap_or("none"));
                        if let Some(wallet) = runtime.state().wallet {
                            println!("Receive: {}", wallet.receive_address);
                        }
                        if let Some(warning) = status.warning {
                            eprintln!("{warning}");
                        }
                    }
                    Err(error) => eprintln!("{}", message(error)),
                }
            }
        }
    }
    runtime
        .dispatch(AppAction::LockWallet)
        .await
        .map_err(|_| CliError::Usage("Wallet runtime stopped.".into()))?;
    drop(runtime);
    driver_thread
        .join()
        .map_err(|_| CliError::Usage("Wallet runtime stopped unexpectedly.".into()))?;
    if stdio {
        // Literal public bookkeeping. Do not return runtime state (or any
        // value that touched a password request) to the process-wide printer.
        println!("{{\"ok\":true,\"locked\":true}}");
    }
    Ok(())
}

// Bound allocation before reading and wipe private command/password buffers on drop.
fn private_line(reader: &mut impl BufRead, limit: usize) -> Result<Option<Zeroizing<String>>> {
    let mut bytes = Zeroizing::new(Vec::new());
    let count = reader
        .take((limit + 2) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| CliError::Usage("Could not read private input.".into()))?;
    if count == 0 {
        return Ok(None);
    }
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
    }
    if bytes.len() > limit {
        return Err(CliError::Usage("Private input is too large.".into()));
    }
    let value = std::str::from_utf8(&bytes)
        .map_err(|_| CliError::Usage("Private input must be UTF-8.".into()))?;
    Ok(Some(Zeroizing::new(value.to_owned())))
}

fn managed_password(cli: &crate::Cli, prompt: &str) -> Result<SecretText> {
    if cli.password_stdin {
        if io::stdin().is_terminal() {
            return Err(CliError::Usage(
                "--password-stdin requires piped input.".into(),
            ));
        }
        let line = private_line(&mut io::stdin().lock(), 4096)?
            .ok_or_else(|| CliError::Usage("No wallet password was supplied on stdin.".into()))?;
        Ok(SecretText::new(line.to_string()))
    } else {
        password(prompt)
    }
}

/// The saved-wallet runtime is also the owner of HD observations and restart state.
pub async fn open_managed_runtime(cli: &crate::Cli) -> Result<&AppRuntime> {
    let handle = cli
        .wallet
        .as_deref()
        .ok_or_else(|| CliError::Usage("Select a saved wallet.".into()))?;
    let runtime = cli
        .wallet_session
        .get_or_try_init(|| async {
            let directory = cli
                .wallet_directory
                .clone()
                .or_else(|| {
                    dirs::data_dir().map(|root| root.join("com.optilabs.wallet").join("wallets"))
                })
                .ok_or_else(|| CliError::Usage("Specify --wallet-directory.".into()))?;
            let checkpoints = optn_chain_native::wallet_checkpoint::WalletCheckpointDirectory(
                directory.join(".state"),
            );
            let storage = optn_platform_native::wallet_storage::NativeWalletStorage::new(directory);
            let (runtime, driver) = AppRuntime::new_with_security(
                AppState {
                    network: cli.network,
                    ..Default::default()
                },
                WalletSecurity::new(Box::new(storage), None)
                    .with_checkpoints(Box::new(checkpoints)),
            )
            .map_err(|error| CliError::Usage(message(error)))?;
            tokio::spawn(driver.run());
            Ok::<_, CliError>(runtime)
        })
        .await?;
    let status = runtime
        .wallet_security(Request::Status)
        .await
        .map_err(|error| CliError::Usage(message(error)))?;
    if status.active.as_deref() != Some(handle) {
        runtime
            .wallet_security(Request::Open {
                handle: handle.into(),
                password: managed_password(cli, "Wallet password (empty if none): ")?,
            })
            .await
            .map_err(|error| CliError::Usage(message(error)))?;
    }
    if runtime.state().network != cli.network {
        return Err(CliError::Usage(
            "The saved wallet belongs to a different network. Select its network explicitly."
                .into(),
        ));
    }
    Ok(runtime)
}

pub async fn read_managed_wallet(cli: &crate::Cli) -> Result<optn_core::hd::Wallet> {
    let runtime = open_managed_runtime(cli).await?;
    let state = runtime.state();
    let stored_account = optn_core::hd::parse_account_path(
        &state
            .wallet
            .as_ref()
            .ok_or_else(|| CliError::Usage("Unlock the wallet first.".into()))?
            .account_path,
    )?;
    let requested_account = match &cli.command {
        crate::Command::Address {
            account, coin_type, ..
        } => optn_core::hd::AccountPath::new(
            coin_type.unwrap_or(cli.network.default_coin_type()),
            *account,
        )?,
        crate::Command::Rpa {
            action: crate::RpaCommand::Code { account } | crate::RpaCommand::Scan { account, .. },
        } => optn_core::hd::AccountPath::new(cli.network.default_coin_type(), *account)?,
        crate::Command::Rescan {
            account_path: Some(path),
            ..
        } => optn_core::hd::parse_account_path(path)?,
        crate::Command::Discover { .. } => stored_account,
        _ => optn_core::hd::AccountPath::default_for(cli.network),
    };
    if stored_account != requested_account {
        return Err(CliError::Usage(format!("This wallet uses {stored_account}. Select that account explicitly; this command cannot silently use a different account.")));
    }
    let command = crate::command_name(&cli.command);
    // The CLI policy classifies the entire RPA group conservatively; these
    // two operations only derive/read keys, like Address, without authorizing a spend.
    let reads_rpa = matches!(
        cli.command,
        crate::Command::Rpa {
            action: crate::RpaCommand::Code { .. } | crate::RpaCommand::Scan { .. },
        }
    );
    let scope = if !reads_rpa
        && crate::skills::SKILLS.iter().any(|skill| {
            skill.name == command && skill.capability >= crate::skills::Capability::Sign
        }) {
        optn_app::AuthScope::Spend
    } else {
        optn_app::AuthScope::Chat
    };
    match runtime.wallet_for_operation(scope).await {
        Ok(wallet) => Ok(wallet),
        Err(TransportError::AuthenticationRequired) => {
            runtime
                .wallet_security(Request::Authenticate {
                    password: managed_password(cli, "Confirm wallet password: ")?,
                    epoch: runtime.state().lock.unlock_epoch,
                })
                .await
                .map_err(|error| CliError::Usage(message(error)))?;
            runtime
                .wallet_for_operation(scope)
                .await
                .map_err(|error| CliError::Usage(message(error)))
        }
        Err(error) => Err(CliError::Usage(message(error))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn console_history_preserves_retained_projection_and_sync_requires_open_wallet() {
        use clap::Parser;
        let directory = tempfile::tempdir().unwrap();
        let mut cli =
            crate::Cli::try_parse_from(["optn", "--network", "chipnet", "wallet", "--stdio"])
                .unwrap();
        cli.network_config_dir = Some(directory.path().join("network-config"));
        let storage = optn_platform_native::wallet_storage::NativeWalletStorage::new(
            directory.path().to_path_buf(),
        );
        let (runtime, driver) = AppRuntime::new_with_security(
            AppState {
                network: optn_app::Network::Chipnet,
                ..Default::default()
            },
            WalletSecurity::new(Box::new(storage), None),
        )
        .unwrap();
        let task = tokio::spawn(driver.run());
        let history = serde_json::from_str(r#"{"chain":"history"}"#).unwrap();
        let status = execute(&cli, &runtime, history).await.unwrap();
        let reply = success_reply(&runtime.state(), status.clone());
        assert_eq!(reply["wallet_sync"]["confirmed_sats"], Value::Null);
        assert_eq!(reply["wallet_sync"]["history_fresh"], false);
        assert_eq!(reply["wallet_sync"]["utxos_fresh"], false);
        assert_eq!(reply["wallet_sync"]["source"], Value::Null);
        let sync = serde_json::from_str(r#"{"chain":"sync"}"#).unwrap();
        let error = execute(&cli, &runtime, sync).await.unwrap_err();
        assert!(message(error).contains("Open a saved HD wallet"));
        assert!(!runtime.state().wallet_sync.history_fresh);
        assert!(!runtime.state().wallet_sync.utxos_fresh);

        // The console projects retained runtime history even when no live coin remains.
        let mut retained = runtime.state();
        retained.wallet_sync = optn_app::WalletSyncView {
            source: Some("saved-provider".into()),
            evidence: Some("ProviderReported".into()),
            confirmed_sats: Some(3_000),
            pending_sats: -500,
            history: vec![optn_app::HistoryEntry {
                kind: optn_app::HistoryKind::Sent,
                txid: "11".repeat(32),
                amount_sats: 500,
                address: "bchtest:qhistory".into(),
                reserved: false,
                block_height: Some(250_000),
            }],
            ..Default::default()
        };
        let reply = success_reply(&retained, status);
        assert_eq!(reply["wallet_sync"]["source"], "saved-provider");
        assert_eq!(reply["wallet_sync"]["evidence"], "ProviderReported");
        assert_eq!(reply["wallet_sync"]["confirmed_sats"], 3_000);
        assert_eq!(reply["wallet_sync"]["pending_sats"], -500);
        assert_eq!(reply["wallet_sync"]["history_fresh"], false);
        assert_eq!(
            reply["wallet_sync"]["history"],
            json!([{
                "kind":"sent", "txid":"11".repeat(32), "amount_sats":500,
                "address":"bchtest:qhistory", "reserved":false, "block_height":250_000,
            }])
        );
        assert!(reply.get("security").is_some());
        assert!(reply.get("receive_address").is_some());
        assert!(reply.get("hd_addresses").is_some());
        assert!(serde_json::from_str::<Input>(r#"{"chain":"broadcast"}"#).is_err());
        drop(runtime);
        task.await.unwrap();
    }

    #[test]
    fn private_input_is_bounded_and_preserves_empty_and_whitespace_passwords() {
        let mut input = &b"\r\n  password  \n"[..];
        assert_eq!(&**private_line(&mut input, 4096).unwrap().unwrap(), "");
        assert_eq!(
            &**private_line(&mut input, 4096).unwrap().unwrap(),
            "  password  "
        );
        assert!(private_line(&mut &b"123456789"[..], 8).is_err());
    }
}
