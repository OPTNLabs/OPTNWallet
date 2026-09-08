//! Real CLI process, temporary ciphertext only, no network or user keystore.
use optn_app::AppAction;
use optn_transport::WireAction;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{ChildStdin, ChildStdout, Command, Output, Stdio};

fn test_directory() -> tempfile::TempDir {
    let target = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(std::env::var_os("CARGO_TARGET_DIR").unwrap_or_else(|| "target".into()));
    std::fs::create_dir_all(&target).unwrap();
    tempfile::tempdir_in(target).unwrap()
}

fn fixture(directory: &Path, handle: &str, account: u32) {
    // Published BIP39 fixture only. Copy its existing ciphertext unchanged;
    // only public name/account metadata varies between these test wallets.
    let mut file = optn_core::wallet_file::WalletFile::parse(include_bytes!(
        "../../optn-core/tests/fixtures/legacy-wallet-v1.json"
    ))
    .unwrap();
    file.name = handle.into();
    file.derivation_path = Some(format!("m/44'/1'/{account}'"));
    std::fs::write(directory.join(handle), file.encode().unwrap()).unwrap();
    std::fs::write(directory.join(".auto-lock"), "0").unwrap();
}

fn run_cli(directory: &Path, args: &[&str], input: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_optn"))
        .args(["--network", "chipnet", "--json", "--wallet-directory"])
        .arg(directory)
        .args(["--network-config-dir"])
        .arg(directory.join("network-config"))
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            "1",
            "--no-tls",
            "--timeout",
            "1",
        ])
        .args(args)
        .env("OPTN_POLICY", "full")
        .env("OPTN_MNEMONIC", optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC)
        .env("OPTN_PASSPHRASE", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut timed_out = false;
    while child.try_wait().unwrap().is_none() {
        if std::time::Instant::now() >= deadline {
            timed_out = true;
            child.kill().unwrap();
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    for bytes in [&output.stdout, &output.stderr] {
        let text = String::from_utf8_lossy(bytes);
        assert!(!text.contains("old-password") && !text.contains("new-password"));
        assert!(!text.contains(optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC));
    }
    assert!(
        !timed_out,
        "CLI child timed out: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn responses(output: &Output) -> Vec<Value> {
    serde_json::Deserializer::from_slice(&output.stdout)
        .into_iter::<Value>()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn address(account: u32) -> String {
    optn_core::hd::Wallet::from_mnemonic(optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC, "TREZOR")
        .unwrap()
        .address(
            optn_core::network::Network::Chipnet,
            &format!("m/44'/1'/{account}'/0/0"),
        )
        .unwrap()
        .encode()
}

fn request(input: &mut ChildStdin, output: &mut BufReader<ChildStdout>, value: Value) -> Value {
    writeln!(input, "{value}").unwrap();
    input.flush().unwrap();
    let mut line = String::new();
    assert!(output.read_line(&mut line).unwrap() > 0);
    assert!(!line.contains("old-password") && !line.contains("new-password"));
    assert!(!line.contains(optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC));
    serde_json::from_str(&line).unwrap()
}

#[test]
fn migrated_ciphertext_password_and_account_work_through_the_real_cli() {
    let directory = test_directory();
    let path = directory.path().join("public-vector.optn");
    std::fs::write(
        &path,
        include_bytes!("../../optn-core/tests/fixtures/legacy-wallet-v1.json"),
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_optn"))
        .args([
            "--network",
            "chipnet",
            "--json",
            "wallet",
            "--stdio",
            "--directory",
        ])
        .arg(directory.path())
        .env("OPTN_POLICY", "full")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let status = request(
        &mut input,
        &mut output,
        json!({"request":{"command":"status"}}),
    );
    assert_eq!(status["security"]["needs_auto_lock_confirmation"], true);
    let open = json!({"request":{"command":"open","handle":"public-vector.optn","password":"old-password"}});
    assert_eq!(request(&mut input, &mut output, open.clone())["ok"], false);
    assert_eq!(
        request(
            &mut input,
            &mut output,
            json!({"action":WireAction::from(AppAction::SetAutoLockMinutes(0))})
        )["ok"],
        true
    );
    let status = request(&mut input, &mut output, open);
    assert_eq!(status["ok"], true);
    let epoch = status["security"]["epoch"].as_u64().unwrap();
    let no_current = json!({"request":{"command":"change_password","current":null,"password":"new-password","confirmation":"new-password","epoch":epoch}});
    assert_eq!(request(&mut input, &mut output, no_current)["ok"], false);
    let changed = request(
        &mut input,
        &mut output,
        json!({"request":{"command":"change_password","current":"old-password","password":"new-password","confirmation":"new-password","epoch":epoch}}),
    );
    assert_eq!(changed["ok"], true);
    assert_eq!(changed["security"]["has_password"], true);
    drop(input);
    let mut rest = String::new();
    output.read_to_string(&mut rest).unwrap();
    assert!(child.wait().unwrap().success());
    let file = optn_core::wallet_file::WalletFile::parse(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(file.source_id, 0);

    for (password, account, succeeds) in [
        ("old-password", "1", false),
        ("new-password", "0", false),
        ("new-password", "1", true),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_optn"))
            .args([
                "--network",
                "chipnet",
                "--json",
                "--wallet",
                "public-vector.optn",
                "--wallet-directory",
            ])
            .arg(directory.path())
            .args(["--password-stdin", "address", "--account", account])
            .env("OPTN_POLICY", "full")
            .env("OPTN_MNEMONIC", optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC)
            .env("OPTN_PASSPHRASE", "different public fallback")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        writeln!(child.stdin.take().unwrap(), "{password}").unwrap();
        let output = child.wait_with_output().unwrap();
        assert_eq!(
            output.status.success(),
            succeeds,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        if succeeds {
            let response: Value = serde_json::from_slice(&output.stdout).unwrap();
            let expected = optn_core::hd::Wallet::from_mnemonic(
                optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC,
                "TREZOR",
            )
            .unwrap()
            .address(optn_core::network::Network::Chipnet, "m/44'/1'/1'/0/0")
            .unwrap()
            .encode();
            assert_eq!(response["address"], expected);
        }
    }
}

#[test]
fn console_honors_wallet_and_directory_overrides_without_reusing_the_wrong_session() {
    let directory = test_directory();
    let other = test_directory();
    fixture(directory.path(), "a.optn", 0);
    fixture(directory.path(), "b.optn", 1);
    fixture(other.path(), "a.optn", 1);
    let input = format!(
        "address\nold-password\n\
         address --wallet b.optn --account 1\nold-password\n\
         address\n\
         address --wallet-directory '{}' --account 1\nold-password\n\
         address\nquit\n",
        other.path().display()
    );
    let output = run_cli(
        directory.path(),
        &[
            "--wallet",
            "a.optn",
            "--password-stdin",
            "console",
            "--json",
        ],
        &input,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let values = responses(&output);
    assert_eq!(
        values.len(),
        6,
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    for (value, account) in values.iter().zip([0, 1, 0, 1, 0]) {
        assert_eq!(value["address"], address(account));
    }
    assert_eq!(values[5]["console"], "closed");

    // Selecting a wallet inside a plain console must also beat the legacy seed.
    let output = run_cli(
        directory.path(),
        &["console", "--json"],
        "address --wallet b.optn --account 1 --password-stdin\nold-password\nquit\n",
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let values = responses(&output);
    assert_eq!(
        values.len(),
        2,
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(values[0]["address"], address(1));
}

#[test]
fn wallet_management_uses_global_directory_and_explicit_subcommand_override() {
    let directory = test_directory();
    let other = test_directory();
    fixture(directory.path(), "global.optn", 0);
    fixture(other.path(), "override.optn", 0);
    let input = "{\"request\":{\"command\":\"status\"}}\n";
    for (args, expected) in [
        (vec!["wallet", "--stdio"], "global.optn"),
        (
            vec![
                "wallet",
                "--stdio",
                "--directory",
                other.path().to_str().unwrap(),
            ],
            "override.optn",
        ),
    ] {
        let output = run_cli(directory.path(), &args, input);
        assert!(output.status.success());
        let values = responses(&output);
        assert_eq!(values[0]["ok"], true);
        let wallets = values[0]["security"]["wallets"].as_array().unwrap();
        assert_eq!(wallets.len(), 1);
        assert_eq!(wallets[0]["handle"], expected);
    }
}

#[test]
fn rpa_reads_use_the_selected_account_without_spend_authorization() {
    let directory = test_directory();
    for account in [0, 1] {
        fixture(
            directory.path(),
            &format!("account-{account}.optn"),
            account,
        );
    }
    for stored in [0, 1] {
        let handle = format!("account-{stored}.optn");
        for requested in ["0", "1"] {
            for mut args in [vec!["rpa", "code"], vec!["rpa", "scan", "00"]] {
                args.extend([
                    "--wallet",
                    &handle,
                    "--password-stdin",
                    "--account",
                    requested,
                ]);
                let output = run_cli(directory.path(), &args, "old-password\n");
                let values = responses(&output);
                if stored.to_string() == requested && args[1] == "code" {
                    assert!(output.status.success());
                    let wallet = optn_core::hd::Wallet::from_mnemonic(
                        optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC,
                        "TREZOR",
                    )
                    .unwrap();
                    let scan = wallet
                        .public_key(&optn_core::rpa::scan_path(1, stored))
                        .unwrap();
                    let spend = wallet
                        .public_key(&optn_core::rpa::spend_path(1, stored))
                        .unwrap();
                    let expected = optn_core::rpa::encode(
                        &scan,
                        &spend,
                        optn_core::network::Network::Chipnet,
                        optn_core::rpa::RPA_PREFIX_BITS,
                    );
                    assert_eq!(values[0]["cashcode"], expected);
                    continue;
                }
                assert!(!output.status.success());
                let message = values[0]["message"].as_str().unwrap();
                if stored.to_string() == requested {
                    // The legacy scan reaches only the explicit unavailable loopback
                    // endpoint supplied by run_cli after account/auth checks pass.
                    assert_eq!(values[0]["error"], "network", "{message}");
                } else {
                    assert!(
                        message.contains("Select that account explicitly"),
                        "{args:?}: {message}"
                    );
                }
            }
        }
    }
}

#[test]
fn managed_spend_refuses_without_shared_runtime_coin_freshness() {
    let directory = test_directory();
    fixture(directory.path(), "public.optn", 0);
    let destination = address(0);
    let output = run_cli(
        directory.path(),
        &[
            "--wallet",
            "public.optn",
            "--password-stdin",
            "send",
            &destination,
            "1000",
            "--dry-run",
        ],
        "old-password\n",
    );
    assert!(!output.status.success());
    let values = responses(&output);
    assert!(values[0]["message"]
        .as_str()
        .unwrap()
        .contains("Refresh the wallet"));
    assert!(values[0].get("raw").is_none() && values[0].get("txid").is_none());
}
