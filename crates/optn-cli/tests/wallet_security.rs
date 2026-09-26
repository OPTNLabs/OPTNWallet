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

#[test]
fn wallet_asset_views_use_shared_renderer_and_refuse_locked_state() {
    let directory = test_directory();
    fixture(directory.path(), "public.optn", 0);
    let open =
        json!({"request":{"command":"open","handle":"public.optn","password":"old-password"}});
    let lock = json!({"action":WireAction::from(AppAction::LockWallet)});
    let output = run_cli(directory.path(), &["wallet", "--stdio"], &format!(
        "{{\"view\":\"assets\"}}\n{open}\n{{\"view\":\"assets\"}}\n{{\"view\":\"nfts\"}}\n{lock}\n{{\"view\":\"assets\"}}\n"
    ));
    assert!(output.status.success());
    let replies = responses(&output);
    assert_eq!(replies[0]["ok"], false);
    assert_eq!(replies[1]["ok"], true);
    assert_eq!(replies[2]["title"], "Assets");
    assert!(replies[3]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .any(|line| line
            .as_str()
            .is_some_and(|line| line.contains("no non-fungible tokens"))));
    assert_eq!(replies[5]["ok"], false);
    let prompt = run_cli(directory.path(), &["wallet"], "assets\nnfts\nquit\n");
    assert!(prompt.status.success());
    assert_eq!(responses(&prompt)[0]["ok"], false);
    assert_eq!(responses(&prompt)[1]["ok"], false);
}

#[test]
fn private_stdio_errors_do_not_echo_credentials_or_malformed_input() {
    let directory = test_directory();
    fixture(directory.path(), "public.optn", 0);
    let marker = "public-input-that-must-never-be-echoed";
    let rejected = json!({"request": {
        "command": "open", "handle": "public.optn", "password": marker,
    }});
    let malformed = format!("{{\"request\":{{\"password\":\"{marker}\"");
    let output = run_cli(
        directory.path(),
        &["wallet", "--stdio"],
        &format!("{rejected}\n{malformed}\n"),
    );
    assert!(output.status.success());
    for bytes in [&output.stdout, &output.stderr] {
        assert!(!String::from_utf8_lossy(bytes).contains(marker));
    }
    let replies = responses(&output);
    assert_eq!(replies.len(), 3);
    assert_eq!(replies[0]["ok"], false);
    assert_eq!(replies[1]["error"], "Invalid wallet command.");
    assert_eq!(replies[2]["locked"], true);

    // The bounded reader fails before parsing; its top-level error must also
    // omit the private line, including when the final newline is absent.
    let oversized = marker.repeat(262_145 / marker.len() + 1);
    let output = run_cli(directory.path(), &["wallet", "--stdio"], &oversized);
    assert!(!output.status.success());
    for bytes in [&output.stdout, &output.stderr] {
        assert!(!String::from_utf8_lossy(bytes).contains(marker));
    }
    assert_eq!(
        responses(&output)[0]["message"],
        "Private input is too large."
    );
}

#[test]
fn invalid_auto_lock_policy_stops_startup_without_echoing_file_contents() {
    let directory = test_directory();
    let policy = directory.path().join(".auto-lock");
    for bytes in [b"private-policy-marker".as_slice(), &[0xff], b"999"] {
        std::fs::write(&policy, bytes).unwrap();
        let output = run_cli(directory.path(), &["wallet", "--stdio"], "");
        assert!(!output.status.success());
        assert_eq!(
            responses(&output)[0]["message"],
            "Wallet auto-lock policy: invalid saved policy."
        );
        for output in [&output.stdout, &output.stderr] {
            assert!(!String::from_utf8_lossy(output).contains("private-policy-marker"));
        }
        assert_eq!(std::fs::read(&policy).unwrap(), bytes);
    }
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
fn imported_hd_inventory_is_validated_and_survives_cli_restart() {
    let directory = test_directory();
    fixture(directory.path(), "public.optn", 1);
    let open =
        json!({"request":{"command":"open","handle":"public.optn","password":"old-password"}});
    let wallet =
        optn_core::hd::Wallet::from_mnemonic(optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC, "TREZOR")
            .unwrap();
    let addresses: Vec<_> = [(0, 201), (2, 31)].into_iter().map(|(branch, index)| {
        json!({"branch":branch,"index":index,"address":wallet.address(
            optn_core::network::Network::Chipnet, &format!("m/44'/1'/1'/{branch}/{index}")).unwrap().encode()})
    }).collect();
    let inventory = json!({"request":{"command":"import_hd_inventory","epoch":1,
        "account_path":"m/44'/1'/1'","addresses":addresses}});
    let mut stale = inventory.clone();
    stale["request"]["epoch"] = json!(0);
    let mut wrong = inventory.clone();
    wrong["request"]["addresses"][0]["address"] = json!(address(0));
    let first = run_cli(
        directory.path(),
        &["wallet", "--stdio"],
        &format!("{open}\n{stale}\n{wrong}\n{inventory}\n"),
    );
    assert!(first.status.success());
    let replies = responses(&first);
    assert_eq!(replies[1]["ok"], false);
    assert_eq!(replies[2]["ok"], false);
    assert_eq!(replies[3]["ok"], true, "{:?}", replies[3]);
    assert_eq!(replies[3]["hd_addresses"]["next"], json!([202, 0, 0]));
    assert_eq!(replies[3]["hd_addresses"]["compatibility_horizon"], 32);
    assert_eq!(replies[3]["hd_addresses"]["current_receive"], 0);
    assert_eq!(replies[3]["receive_address"], address(1));
    assert_eq!(replies[3]["wallet_sync"]["utxos_fresh"], false);

    let restarted = run_cli(
        directory.path(),
        &["wallet", "--stdio"],
        &format!("{open}\n{inventory}\n"),
    );
    assert!(restarted.status.success());
    let after = responses(&restarted);
    assert_eq!(after[0]["ok"], true);
    assert_eq!(after[0]["hd_addresses"], replies[3]["hd_addresses"]);
    assert_eq!(after[1]["hd_addresses"], replies[3]["hd_addresses"]);
    assert_eq!(after[0]["wallet_sync"]["utxos_fresh"], false);
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
fn birthday_hints_survive_real_cli_restart_and_reject_stale_epoch() {
    let directory = test_directory();
    fixture(directory.path(), "public.optn", 0);
    let open =
        json!({"request":{"command":"open","handle":"public.optn","password":"old-password"}});
    let mut expected = json!({"kind":"unknown"});
    for (input, saved) in [
        (
            json!({"kind":"height","height":0}),
            json!({"kind":"imported_at_height","height":0}),
        ),
        (
            json!({"kind":"time","requested_time":172800}),
            json!({"kind":"imported_at_time","requested_time":172800}),
        ),
        (json!({"kind":"unknown"}), json!({"kind":"unknown"})),
    ] {
        let stale = json!({"request":{"command":"set_birthday","epoch":0,"birthday":input}});
        let update = json!({"request":{"command":"set_birthday","epoch":1,"birthday":input}});
        let status = json!({"request":{"command":"status"}});
        let output = run_cli(
            directory.path(),
            &["wallet", "--stdio"],
            &format!("{open}\n{stale}\n{status}\n{update}\n"),
        );
        assert!(output.status.success());
        let replies = responses(&output);
        assert_eq!(replies[0]["security"]["restore_birthday"], expected);
        assert_eq!(replies[1]["ok"], false);
        assert_eq!(replies[2]["security"]["restore_birthday"], expected);
        assert_eq!(replies[3]["ok"], true, "{:?}", replies[3]);
        assert_eq!(replies[3]["security"]["restore_birthday"], saved);
        assert_eq!(replies[3]["wallet_sync"]["utxos_fresh"], false);
        expected = saved;
    }
    let output = run_cli(
        directory.path(),
        &["wallet", "--stdio"],
        &format!("{open}\n"),
    );
    assert!(output.status.success());
    assert_eq!(
        responses(&output)[0]["security"]["restore_birthday"],
        expected
    );
}

#[test]
fn managed_watch_only_import_survives_stdio_restart_without_exposing_xpub() {
    let directory = test_directory();
    let xpub = optn_core::hd::Wallet::from_mnemonic(optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC, "")
        .unwrap()
        .account_xpub_at(optn_core::hd::AccountPath::new(1, 7).unwrap())
        .unwrap();
    let password = "managed-public-fixture-password";
    let wrong_password = "incorrect-public-fixture-password";
    let assert_hidden = |output: &Output| {
        for bytes in [&output.stdout, &output.stderr] {
            let text = String::from_utf8_lossy(bytes);
            assert!(
                !text.contains(&xpub),
                "stdio must not echo the account xpub"
            );
            assert!(!text.contains(password));
            assert!(!text.contains(wrong_password));
        }
    };
    let import = json!({"request": {
        "command": "import_watch_only",
        "name": "Saved public account",
        "account_xpub": xpub,
        "master_fingerprint": "73c5da0a",
        "password": password,
        "confirmation": password,
        "network": "chipnet",
        "account_path": "m/44'/1'/7'",
    }});
    let next = json!({"request": {"command": "next_receive", "epoch": 1}});
    let imported = run_cli(
        directory.path(),
        &["wallet", "--stdio"],
        &format!("{import}\n{next}\n"),
    );
    assert!(imported.status.success());
    assert_hidden(&imported);
    let replies = responses(&imported);
    assert_eq!(replies.len(), 3);
    assert_eq!(replies[0]["ok"], true);
    assert_eq!(replies[0]["security"]["has_password"], true);
    assert_eq!(replies[0]["hd_addresses"]["current_receive"], 0);
    assert_eq!(replies[1]["ok"], true);
    assert_eq!(replies[1]["hd_addresses"]["current_receive"], 1);
    assert_eq!(replies[2]["locked"], true);
    let handle = replies[0]["security"]["active"].as_str().unwrap();
    let receive = optn_core::watch_only::address_under_account(
        optn_core::network::Network::Chipnet,
        &xpub,
        0,
        1,
    )
    .unwrap()
    .address;
    assert_eq!(replies[1]["receive_address"], receive);
    let record = std::fs::read(directory.path().join(handle)).unwrap();
    assert!(!record
        .windows(xpub.len())
        .any(|window| window == xpub.as_bytes()));
    let checkpoint_files = std::fs::read_dir(directory.path().join(".state"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    assert!(!checkpoint_files.is_empty());
    for path in checkpoint_files {
        let bytes = std::fs::read(path).unwrap();
        assert!(!bytes
            .windows(xpub.len())
            .any(|window| window == xpub.as_bytes()));
    }

    // A separate process must discover the record while locked and must not
    // install any wallet authority after the deliberately incorrect password.
    let status = json!({"request": {"command": "status"}});
    let wrong = json!({"request": {
        "command": "open", "handle": handle, "password": wrong_password,
    }});
    let open = json!({"request": {
        "command": "open", "handle": handle, "password": password,
    }});
    let restarted = run_cli(
        directory.path(),
        &["wallet", "--stdio"],
        &format!("{status}\n{wrong}\n{status}\n{open}\n"),
    );
    assert!(restarted.status.success());
    assert_hidden(&restarted);
    let replies = responses(&restarted);
    assert_eq!(replies.len(), 5);
    assert_eq!(replies[0]["ok"], true);
    assert!(replies[0]["security"]["active"].is_null());
    assert_eq!(
        replies[0]["security"]["wallets"],
        json!([
            {"handle": handle, "name": "Saved public account"}
        ])
    );
    assert_eq!(replies[1]["ok"], false);
    assert_eq!(replies[2]["ok"], true);
    assert!(replies[2]["security"]["active"].is_null());
    assert!(replies[2]["receive_address"].is_null());
    assert!(replies[2]["hd_addresses"].is_null());
    assert_eq!(replies[3]["ok"], true);
    assert_eq!(replies[3]["security"]["active"], handle);
    assert_eq!(replies[3]["receive_address"], receive);
    assert_eq!(replies[3]["hd_addresses"]["current_receive"], 1);
    assert_eq!(replies[3]["wallet_sync"]["history_fresh"], false);
    assert_eq!(replies[4]["locked"], true);
    assert_eq!(
        std::fs::read(directory.path().join(handle)).unwrap(),
        record
    );
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
                    "blockchain.headers.subscribe" => {
                        json!({"height":0,"hex":optn_runtime::header_verifier::CHIPNET_GENESIS_HEADER_HEX})
                    }
                    "blockchain.block.headers" => json!({"count": 0, "hex": "", "max": 2016}),
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
            "--from-height",
            "0",
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
    assert_eq!(value["wallet_sync"]["scan_coverage"]["from_height"], 0);
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
    assert_eq!(responses(&output)[0]["security"]["manual_rescan_from"], 0);
    let open =
        json!({"request":{"command":"open","handle":"public.optn","password":"old-password"}});
    let stale = json!({"request":{"command":"clear_rescan","epoch":0}});
    let clear = json!({"request":{"command":"clear_rescan","epoch":1}});
    let output = run_cli(
        directory.path(),
        &["wallet", "--stdio"],
        &format!("{open}\n{stale}\n{clear}\n"),
    );
    assert!(output.status.success());
    let replies = responses(&output);
    assert_eq!(replies[1]["ok"], false);
    assert_eq!(replies[2]["ok"], true, "{:?}", replies[2]);
    assert!(replies[2]["security"]["manual_rescan_from"].is_null());
    assert_eq!(
        replies[2]["security"]["restore_birthday"]["kind"],
        "unknown"
    );
    let output = run_cli(
        directory.path(),
        &["wallet", "--stdio"],
        &format!("{open}\n"),
    );
    assert!(output.status.success());
    let reply = &responses(&output)[0];
    assert!(reply["security"]["manual_rescan_from"].is_null());
    assert!(reply["wallet_sync"]["scan_coverage"].is_null());
}

#[test]
fn stdio_airgap_routes_to_runtime_and_never_grants_broadcast() {
    let directory = test_directory();
    let input = [
        json!({"airgap":{"op":"prepare", "destination":"bchtest:qqaz6s295ncfs53m86qj0uw6sl8u2kuw0ymst35fx4", "amount_sats":1000}}),
        json!({"airgap":{"op":"finalize", "request_id":1, "signed_psbt_hex":"70736274ff"}}),
        json!({"airgap":{"op":"cancel"}}),
        json!({"airgap":{"op":"broadcast", "raw_transaction_hex":"00"}}),
        json!({"airgap":{"op":"finalize", "request_id":1, "signed_psbt_hex":"00", "broadcast":true}}),
    ].into_iter().map(|value| format!("{value}\n")).collect::<String>();
    let output = run_cli(directory.path(), &["wallet", "--stdio"], &input);
    assert!(output.status.success());
    let replies = responses(&output);
    assert_eq!(replies.len(), 6);
    for reply in &replies[..2] {
        assert_eq!(
            reply["ok"], false,
            "A locked console cannot prepare or finalize"
        );
        assert_ne!(
            reply["error"], "Invalid wallet command.",
            "Valid envelopes must reach the shared runtime"
        );
        assert!(reply.get("airgap").is_none());
    }
    assert_eq!(replies[2]["ok"], true);
    assert_eq!(replies[2]["sent"], false);
    assert_eq!(replies[2]["airgap"]["request_id"], 0);
    assert!(replies[2]["airgap"]["raw_transaction_hex"].is_null());
    for reply in &replies[3..5] {
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"], "Invalid wallet command.");
    }
}

#[test]
fn source_selection_is_shared_durable_and_invalid_edits_preserve_the_file() {
    let directory = test_directory();
    let selection = directory.path().join("selection.json");
    std::fs::write(
        &selection,
        serde_json::to_vec(&json!({
            "protocols":["Bip37"], "primary_scope":"MyInfrastructure",
            "fallback_scope":null, "preferred":[]
        }))
        .unwrap(),
    )
    .unwrap();
    let args = ["network", "configure", selection.to_str().unwrap()];
    let output = run_cli(directory.path(), &args, "");
    assert!(
        output.status.success(),
        "stderr={} stdout={}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    let config = directory.path().join("network-config/network-chipnet.json");
    let before = std::fs::read(&config).unwrap();
    let output = run_cli(directory.path(), &["network", "status"], "");
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["policy"]["primary_scope"], "UserInfrastructure");
    assert_eq!(value["policy"]["fallback_scope"], Value::Null);
    assert_eq!(value["policy"]["protocols"], json!(["Bip37"]));
    std::fs::write(
        &selection,
        serde_json::to_vec(&json!({
            "protocols":["Bip37"], "primary_scope":{"Selected":["missing-source"]},
            "fallback_scope":null, "preferred":[]
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(!run_cli(directory.path(), &args, "").status.success());
    assert_eq!(std::fs::read(&config).unwrap(), before);

    let exported = run_cli(directory.path(), &["network", "export"], "");
    assert!(exported.status.success());
    let mut archive: Value = serde_json::from_slice(&exported.stdout).unwrap();
    assert_eq!(archive["network"], "chipnet");
    let portable = directory.path().join("portable.json");
    std::fs::write(&portable, &exported.stdout).unwrap();
    let restored = test_directory();
    let import_args = ["network", "import", portable.to_str().unwrap()];
    let imported = run_cli(restored.path(), &import_args, "");
    assert!(
        imported.status.success(),
        "{}",
        String::from_utf8_lossy(&imported.stdout)
    );
    let status = run_cli(restored.path(), &["network", "status"], "");
    assert!(status.status.success());
    let restored_value: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(restored_value["policy"], value["policy"]);
    let restored_config = restored.path().join("network-config/network-chipnet.json");
    let accepted = std::fs::read(&restored_config).unwrap();
    archive["network"] = json!("mainnet");
    std::fs::write(&portable, serde_json::to_vec(&archive).unwrap()).unwrap();
    assert!(!run_cli(restored.path(), &import_args, "").status.success());
    assert_eq!(std::fs::read(&restored_config).unwrap(), accepted);
    std::fs::write(&portable, b"{invalid").unwrap();
    assert!(!run_cli(restored.path(), &import_args, "").status.success());
    assert_eq!(std::fs::read(&restored_config).unwrap(), accepted);
}

#[test]
fn source_mutations_keep_an_empty_exact_scope_after_a_cli_restart() {
    let directory = test_directory();
    let request = directory.path().join("source.json");
    std::fs::write(
        &request,
        serde_json::to_vec(&json!({
            "network":"chipnet",
            "label":"Temporary P2P",
            "kind":"p2p",
            "host":"temporary-source.example",
            "port":8333,
            "infrastructure_group":null,
        }))
        .unwrap(),
    )
    .unwrap();
    let source = "host:temporary-source.example";

    let added = run_cli(
        directory.path(),
        &["network", "add", request.to_str().unwrap()],
        "",
    );
    assert!(
        added.status.success(),
        "{}",
        String::from_utf8_lossy(&added.stderr)
    );
    let selected = run_cli(
        directory.path(),
        &["network", "select", source, "--protocol", "bip37"],
        "",
    );
    assert!(
        selected.status.success(),
        "{}",
        String::from_utf8_lossy(&selected.stderr)
    );
    let config = directory.path().join("network-config/network-chipnet.json");
    let before_invalid = std::fs::read(&config).unwrap();
    assert!(!run_cli(
        directory.path(),
        &["network", "disposition", source, "not-a-disposition"],
        "",
    )
    .status
    .success());
    assert_eq!(std::fs::read(&config).unwrap(), before_invalid);
    let selected_status: Value = serde_json::from_slice(&selected.stdout).unwrap();
    let bootstrap = selected_status["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["origin"].as_str().unwrap().starts_with("Bootstrap"))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        !run_cli(directory.path(), &["network", "remove", &bootstrap], "")
            .status
            .success()
    );
    assert_eq!(std::fs::read(&config).unwrap(), before_invalid);

    // Private stdio uses the same mutation path and must reject no state
    // between disable and re-enable. Both replies are public status only.
    let disposition = run_cli(
        directory.path(),
        &["wallet", "--stdio"],
        &format!(
            "{{\"network\":{{\"op\":\"disposition\",\"source\":\"{source}\",\"disposition\":\"disabled\"}}}}\n{{\"network\":{{\"op\":\"disposition\",\"source\":\"{source}\",\"disposition\":\"enabled\"}}}}\n"
        ),
    );
    assert!(
        disposition.status.success(),
        "{}",
        String::from_utf8_lossy(&disposition.stderr)
    );
    let replies = responses(&disposition);
    assert!(replies.len() >= 2);
    assert_eq!(replies[0]["ok"], true);
    assert_eq!(
        replies[0]["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == source)
            .unwrap()["disposition"],
        "Disabled"
    );
    assert_eq!(replies[1]["ok"], true);

    // The interactive wallet prompt reaches the same asynchronous remove path.
    let removed = run_cli(
        directory.path(),
        &["wallet"],
        &format!("network remove {source}\nquit\n"),
    );
    assert!(
        removed.status.success(),
        "{}",
        String::from_utf8_lossy(&removed.stderr)
    );
    assert_eq!(responses(&removed)[0]["ok"], true);

    // A new process must retain the holder's explicitly empty scope; Auto
    // would silently expand it back to the bootstrap catalog.
    let reopened = run_cli(directory.path(), &["network", "status"], "");
    assert!(
        reopened.status.success(),
        "{}",
        String::from_utf8_lossy(&reopened.stderr)
    );
    let status: Value = serde_json::from_slice(&reopened.stdout).unwrap();
    assert_eq!(status["policy"]["primary_scope"], "Explicit({})");
    assert_eq!(status["policy"]["fallback_scope"], Value::Null);
    assert!(status["primary"].as_array().unwrap().is_empty());
    assert!(status["sources"]
        .as_array()
        .unwrap()
        .iter()
        .all(|entry| entry["id"] != source));
}

#[test]
fn wallet_prompt_and_private_stdio_share_source_settings() {
    let directory = test_directory();
    let selection = json!({
        "protocols":["Bip37"], "primary_scope":"MyInfrastructure",
        "fallback_scope":null, "preferred":[]
    });
    let input = format!("network configure {selection}\nnetwork status\nquit\n");
    let output = run_cli(directory.path(), &["wallet"], &input);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let prompt = responses(&output);
    assert_eq!(prompt.len(), 2);
    assert_eq!(prompt[0]["ok"], true);
    assert_eq!(prompt[1]["policy"]["primary_scope"], "UserInfrastructure");
    let config = directory.path().join("network-config/network-chipnet.json");
    let before = std::fs::read(&config).unwrap();
    let input = concat!(
        "{\"network\":{\"op\":\"status\"}}\n",
        "{\"network\":{\"op\":\"select\",\"source\":\"missing-source\",\"protocol\":\"bip37\"}}\n",
        "{\"network\":{\"op\":\"status\",\"secret\":\"must-not-echo\"}}\n"
    );
    let output = run_cli(directory.path(), &["wallet", "--stdio"], input);
    assert!(output.status.success());
    let replies = responses(&output);
    assert_eq!(replies[0]["policy"], prompt[1]["policy"]);
    assert_eq!(replies[1]["ok"], false);
    assert_eq!(replies[2]["error"], "Invalid wallet command.");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("must-not-echo"));
    assert_eq!(std::fs::read(&config).unwrap(), before);
}

#[test]
fn named_policy_selection_is_shared_by_prompt_stdio_and_reopened_cli() {
    let directory = test_directory();
    for preset in [
        "own-infrastructure",
        "privacy",
        "electrum-only",
        "bip37-only",
        "neutrino-only",
        "auto",
    ] {
        let input = format!("network policy {preset}\nquit\n");
        let selected = run_cli(directory.path(), &["wallet"], &input);
        assert!(selected.status.success());
        let selected = responses(&selected);
        assert_eq!(selected[0]["ok"], true, "{preset}: {selected:?}");
        let reopened = run_cli(directory.path(), &["network", "status"], "");
        assert!(reopened.status.success());
        let reopened: Value = serde_json::from_slice(&reopened.stdout).unwrap();
        assert_eq!(reopened["policy"], selected[0]["policy"]);
        assert!(reopened["policy"]["fallback_scope"].is_null());
        if preset == "own-infrastructure" {
            assert_eq!(reopened["policy"]["primary_scope"], "UserInfrastructure");
        } else {
            assert_eq!(reopened["policy"]["primary_scope"], "AllEnabled");
        }
    }
    let one_shot = run_cli(
        directory.path(),
        &["network", "policy", "own-infrastructure"],
        "",
    );
    assert!(one_shot.status.success());
    let stdio = run_cli(
        directory.path(),
        &["wallet", "--stdio"],
        "{\"network\":{\"op\":\"policy\",\"preset\":\"auto\"}}\n",
    );
    assert!(stdio.status.success());
    assert_eq!(
        responses(&stdio)[0]["policy"]["primary_scope"],
        "AllEnabled"
    );
    let config = directory.path().join("network-config/network-chipnet.json");
    let before = std::fs::read(&config).unwrap();
    for invalid in ["custom", "unknown"] {
        assert!(
            !run_cli(directory.path(), &["network", "policy", invalid], "")
                .status
                .success()
        );
        assert_eq!(std::fs::read(&config).unwrap(), before);
    }
}

#[test]
fn rpc_credentials_refuse_unknown_sources_without_echoing_private_input() {
    let directory = test_directory();
    let marker = format!(
        "private-{}",
        directory.path().file_name().unwrap().to_string_lossy()
    );
    let request = json!({"network":{"op":"credentials","request":{"op":"set","source":"absent","username":marker,"password":marker}}});
    let output = run_cli(
        directory.path(),
        &["wallet", "--stdio"],
        &format!("{request}\n"),
    );
    assert!(output.status.success());
    assert_eq!(responses(&output)[0]["ok"], false);
    assert!(!String::from_utf8_lossy(&output.stdout).contains(&marker));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(&marker));
}

#[test]
#[ignore = "uses a disposable entry in the real operating-system credential store"]
fn rpc_credentials_survive_cli_restart_and_stay_out_of_export() {
    use optn_runtime::chain::{Endpoint, EndpointKind};
    use optn_runtime::network_config::{
        add_user_source, NetworkConfigEnvelope, SHIPPED_CATALOG_VERSION,
    };
    let directory = test_directory();
    let label = directory
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let mut envelope = NetworkConfigEnvelope::current(SHIPPED_CATALOG_VERSION, Default::default());
    let source = add_user_source(
        &mut envelope.overlay,
        &label,
        Endpoint {
            kind: EndpointKind::BchnRpc,
            host: "127.0.0.1".into(),
            port: Some(18443),
        },
        Some(&label),
    )
    .unwrap();
    let unique = optn_runtime::chain::SourceId::new(format!("credential-test-{label}"));
    envelope
        .overlay
        .user_sources
        .iter_mut()
        .find(|entry| entry.id == source)
        .unwrap()
        .id = unique.clone();
    let source = unique;
    let config = directory.path().join("network-config");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(
        config.join("network-chipnet.json"),
        optn_runtime::network_config::encode_envelope_json(&envelope).unwrap(),
    )
    .unwrap();
    let marker = format!("private-{label}");
    let call = |op: Value| {
        run_cli(
            directory.path(),
            &["wallet", "--stdio"],
            &format!("{}\n", json!({"network":{"op":"credentials","request":op}})),
        )
    };
    let set =
        call(json!({"op":"set","source":source.as_str(),"username":marker,"password":marker}));
    let status = call(json!({"op":"status","source":source.as_str()}));
    let exported = run_cli(directory.path(), &["network", "export"], "");
    // Clean up before assertions so a failed check cannot leave the public test credential behind.
    let removed = call(json!({"op":"remove","source":source.as_str()}));
    let missing = call(json!({"op":"status","source":source.as_str()}));
    for output in [&set, &status] {
        assert!(output.status.success());
        assert_eq!(
            responses(output)[0]["configured"],
            true,
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
    for output in [&removed, &missing] {
        assert!(output.status.success());
        assert_eq!(responses(output)[0]["configured"], false);
    }
    assert!(exported.status.success());
    for output in [&set, &status, &removed, &missing, &exported] {
        assert!(!String::from_utf8_lossy(&output.stdout).contains(&marker));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(&marker));
    }
}
