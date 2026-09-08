//! Independent CLI navigation over the same Rust wallet runtime. No GUI dependency.
use crate::error::{CliError, Result};
use optn_app::{AppAction, AppState, SecretText};
use optn_runtime::{wallet_security::WalletSecurity, AppRuntime};
use optn_transport::{
    TransportError, WalletSecurityRequest as Request, WalletSecurityStatus, WireAction,
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
}

async fn execute(
    runtime: &AppRuntime,
    input: Input,
) -> std::result::Result<WalletSecurityStatus, TransportError> {
    match input {
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

pub async fn run(
    directory: Option<PathBuf>,
    stdio: bool,
    network: optn_app::Network,
) -> Result<Value> {
    let directory = directory
        .or_else(|| dirs::data_dir().map(|root| root.join("com.optilabs.wallet").join("wallets")))
        .ok_or_else(|| CliError::Usage("Specify a wallet directory.".into()))?;
    let storage = optn_platform_native::wallet_storage::NativeWalletStorage::new(directory);
    let service = WalletSecurity::new(Box::new(storage), None);
    let initial = AppState {
        network,
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
                Ok(input) => match execute(&runtime, input).await {
                    Ok(status) => json!({"ok": true, "security": status}),
                    Err(error) => json!({"ok": false, "error": message(error)}),
                },
                Err(_) => json!({"ok": false, "error": "Invalid wallet command."}),
            };
            println!("{output}");
        }
    } else {
        eprintln!("Wallet commands: list, open <file>, import, password, autolock <minutes>, lock, authorize, reveal, quit");
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
                match runtime.wallet_security(request).await {
                    Ok(status) => {
                        for wallet in status.wallets {
                            println!("{}  {}", wallet.handle, wallet.name);
                        }
                        println!("Open: {}", status.active.as_deref().unwrap_or("none"));
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
    Ok(json!({"ok":true,"locked":true}))
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

pub async fn read_managed_wallet(cli: &crate::Cli) -> Result<optn_core::hd::Wallet> {
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
            let storage = optn_platform_native::wallet_storage::NativeWalletStorage::new(directory);
            let (runtime, driver) = AppRuntime::new_with_security(
                AppState {
                    network: cli.network,
                    ..Default::default()
                },
                WalletSecurity::new(Box::new(storage), None),
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
