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
    run_cli_at(directory, args, input, 1)
}

fn run_cli_at(directory: &Path, args: &[&str], input: &str, port: u16) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_optn"))
        .args(["--network", "chipnet", "--json", "--wallet-directory"])
        .arg(directory)
        .args(["--network-config-dir"])
        .arg(directory.join("network-config"))
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
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
    // One console child runs the full multiwallet sequence with repeated real
    // 600,000-round PBKDF2 derivations. Allow slower CI CPUs a bounded total budget.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
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

#[test]
fn stdio_console_keeps_every_reply_including_eof_on_one_json_line() {
    let directory = test_directory();
    let output = run_cli(
        directory.path(),
        &["wallet", "--stdio"],
        "{\"request\":{\"command\":\"status\"}}\n",
    );
    assert!(output.status.success());
    let lines = String::from_utf8(output.stdout).unwrap();
    let replies = lines
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["ok"], true);
    assert_eq!(replies[1]["locked"], true);
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
fn issued_receive_addresses_survive_cli_restart_and_wrong_epochs_do_not_allocate() {
    let directory = test_directory();
    fixture(directory.path(), "public.optn", 1);
    let open =
        json!({"request":{"command":"open","handle":"public.optn","password":"old-password"}});
    let next = json!({"request":{"command":"next_receive","epoch":1}});
    let stale = json!({"request":{"command":"next_receive","epoch":0}});
    let first = run_cli(
        directory.path(),
        &["wallet", "--stdio"],
        &format!("{open}\n{stale}\n{next}\n"),
    );
    assert!(first.status.success());
    let first = responses(&first);
    assert_eq!(first[0]["receive_address"], address(1));
    assert_eq!(first[0]["hd_addresses"]["current_receive"], 0);
    assert_eq!(first[1]["ok"], false);
    assert_eq!(first[2]["ok"], true, "{:?}", first[2]);
    assert_eq!(first[2]["hd_addresses"]["current_receive"], 1);
    let expected =
        optn_core::hd::Wallet::from_mnemonic(optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC, "TREZOR")
            .unwrap()
            .address(optn_core::network::Network::Chipnet, "m/44'/1'/1'/0/1")
            .unwrap()
            .encode();
    assert_eq!(first[2]["receive_address"], expected);
    let restarted = run_cli(
        directory.path(),
        &["wallet", "--stdio"],
        &format!("{open}\n{next}\n"),
    );
    assert!(restarted.status.success());
    let restarted = responses(&restarted);
    assert_eq!(restarted[0]["receive_address"], expected);
    assert_eq!(restarted[1]["hd_addresses"]["current_receive"], 2);
    assert_eq!(restarted[1]["hd_addresses"]["next"], json!([3, 0, 0]));
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

#[test]
fn managed_rescan_persists_the_selected_hd_account_and_reopens_it_after_restart() {
    use optn_runtime::wallet_checkpoint::WalletCheckpointStorage;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let directory = test_directory();
    fixture(directory.path(), "public.optn", 1); // Nondefault account must be retained.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let server = std::thread::spawn(move || {
        let mut histories = 0;
        while !stop.load(Ordering::SeqCst) {
            let stream = match listener.accept() {
                Ok((stream, _)) => stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    continue;
                }
                Err(error) => panic!("loopback listener: {error}"),
            };
            // Windows accepted sockets inherit the listener's nonblocking mode.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut stream = BufReader::new(stream);
            loop {
                let mut line = String::new();
                if stream.read_line(&mut line).unwrap() == 0 {
                    break;
                }
                let request: Value = serde_json::from_str(&line).unwrap();
                let result = match request["method"].as_str().unwrap() {
                    "server.version" => json!(["loopback-fixture", "1.6"]),
                    "server.features" => {
                        json!({"genesis_hash": "000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b"})
                    }
                    "server.peers.subscribe" | "blockchain.scripthash.get_mempool" => json!([]),
                    "blockchain.scripthash.get_history" => {
                        histories += 1;
                        json!([])
                    }
                    "blockchain.headers.subscribe" => Value::Null,
                    method => panic!("unexpected loopback request: {method}"),
                };
                writeln!(
                    stream.get_mut(),
                    "{}",
                    json!({"id":request["id"],"result":result})
                )
                .unwrap();
            }
        }
        histories
    });
    let output = run_cli_at(
        directory.path(),
        &[
            "--wallet",
            "public.optn",
            "--password-stdin",
            "rescan",
            "--gap",
            "1",
            "--max-addresses",
            "4",
        ],
        "old-password\n",
        port,
    );
    stopped.store(true, Ordering::SeqCst);
    assert_eq!(
        server.join().unwrap(),
        4,
        "all ordinary HD branches must be queried"
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let value = &responses(&output)[0];
    assert_eq!(value["account_path"], "m/44'/1'/1'");
    assert_eq!(value["complete"], true);
    assert_eq!(value["scanned_addresses"], 4);
    let account = optn_core::hd::AccountPath::new(1, 1).unwrap();
    let key =
        optn_core::hd::Wallet::from_mnemonic(optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC, "TREZOR")
            .unwrap()
            .checkpoint_key(optn_app::Network::Chipnet, account)
            .unwrap();
    let id = optn_core::header_hash::sha256d(b"public.optn\0chipnet\0m/44'/1'/1'");
    let disk = optn_chain_native::wallet_checkpoint::WalletCheckpointDirectory(
        directory.path().join(".state"),
    );
    let (_, revision) = disk
        .load(&id, &key)
        .unwrap()
        .expect("CLI saved authenticated account state");
    // A new process authenticates and loads the saved account.
    // No signing or broadcast is attempted.
    let output = run_cli(directory.path(), &[
        "--wallet", "public.optn", "--password-stdin", "wallet", "--stdio",
    ], "{\"request\":{\"command\":\"open\",\"handle\":\"public.optn\",\"password\":\"old-password\"}}\n");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(responses(&output)[0]["ok"], true);
    assert_eq!(disk.load(&id, &key).unwrap().unwrap().1, revision);
}
