//! Real CLI processes, published Chipnet fixture keys, loopback-only providers.
use optn_core::{
    hd::{Wallet, BIP39_TEST_VECTOR_MNEMONIC},
    network::Network,
    payment::hex,
    tx,
};
use optn_x402::x402_types::util::Base64Bytes;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
fn run(directory: &Path, args: &[&str], input: &str) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_optn"))
        .args(["--network", "chipnet", "--json", "--wallet-directory"])
        .arg(directory)
        .arg("--network-config-dir")
        .arg(directory.join("network-config"))
        .args(["--timeout", "10"])
        .args(args)
        .env("OPTN_POLICY", "full")
        .env_remove("OPTN_MNEMONIC")
        .env_remove("OPTN_PASSPHRASE")
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
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while child.try_wait().unwrap().is_none() {
        if std::time::Instant::now() > deadline {
            child.kill().unwrap();
            panic!("CLI deadline");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    for bytes in [&output.stdout, &output.stderr] {
        let s = String::from_utf8_lossy(bytes);
        assert!(!s.contains("old-password"));
        assert!(!s.contains(BIP39_TEST_VECTOR_MNEMONIC));
    }
    serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
        panic!(
            "args={args:?} stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}
fn fixture(directory: &Path, port: u16) {
    let mut file = optn_core::wallet_file::WalletFile::parse(include_bytes!(
        "../../optn-core/tests/fixtures/legacy-wallet-v1.json"
    ))
    .unwrap();
    file.name = "Public x402 fixture".into();
    file.source_id = 0;
    file.extra.remove("legacySourceId");
    file.derivation_path = Some("m/44'/1'/0'".into());
    std::fs::write(directory.join("fixture.optn"), file.encode().unwrap()).unwrap();
    std::fs::write(directory.join(".auto-lock"), "0").unwrap();
    use optn_runtime::{
        chain::{ConnectionPolicy, Endpoint, EndpointKind, ProtocolFamily},
        network_config::{
            add_user_source, encode_envelope_json, NetworkConfigEnvelope, SHIPPED_CATALOG_VERSION,
        },
    };
    let mut config = NetworkConfigEnvelope::current(SHIPPED_CATALOG_VERSION, Default::default());
    let id = add_user_source(
        &mut config.overlay,
        "Loopback fixture",
        Endpoint {
            kind: EndpointKind::ElectrumTcp,
            host: "127.0.0.1".into(),
            port: Some(port),
        },
        None,
    )
    .unwrap();
    config.overlay.connection_policy = ConnectionPolicy::exact(id, ProtocolFamily::Electrum);
    std::fs::create_dir_all(directory.join("network-config")).unwrap();
    std::fs::write(
        directory.join("network-config/network-chipnet.json"),
        encode_envelope_json(&config).unwrap(),
    )
    .unwrap();
}
fn hd_loopback(
    raw: &[u8],
) -> (
    u16,
    std::sync::Arc<std::sync::atomic::AtomicBool>,
    std::thread::JoinHandle<Vec<String>>,
) {
    use sha2::{Digest, Sha256};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let scripts: Vec<String> = if raw.is_empty() {
        Vec::new()
    } else {
        optn_core::tx::decode(raw)
            .unwrap()
            .outputs
            .iter()
            .map(|output| {
                Sha256::digest(&output.script_pubkey)
                    .iter()
                    .rev()
                    .map(|byte| format!("{byte:02x}"))
                    .collect()
            })
            .collect()
    };
    let txid: String = optn_core::header_hash::sha256d(raw)
        .iter()
        .rev()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let raw_hex: String = raw.iter().map(|byte| format!("{byte:02x}")).collect();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let server = std::thread::spawn(move || {
        let mut histories = Vec::new();
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
                        let script = request["params"][0].as_str().unwrap().to_owned();
                        histories.push(script.clone());
                        if scripts.contains(&script) {
                            json!([{"tx_hash":txid,"height":0}])
                        } else {
                            json!([])
                        }
                    }
                    "blockchain.transaction.get" if request["params"][0] == txid => {
                        json!(raw_hex)
                    }
                    // No registry/authchain transaction is available in this
                    // fixture. Unresolved metadata must not hide owned tokens.
                    "blockchain.transaction.get" => Value::Null,
                    // Token identity now resolves over Electrum too; this
                    // fixture has no chain for it, so these say nothing.
                    "blockchain.transaction.get_merkle" | "blockchain.utxo.get_info" => Value::Null,
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
    (port, stopped, server)
}

struct Merchant {
    url: String,
    stopped: Arc<AtomicBool>,
    payments: Arc<Mutex<Vec<Value>>>,
    amount: Arc<AtomicU64>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Merchant {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn merchant(address: String) -> Merchant {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/item", listener.local_addr().unwrap());
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let payments = Arc::new(Mutex::new(Vec::new()));
    let received = payments.clone();
    let amount = Arc::new(AtomicU64::new(10_000));
    let price = amount.clone();
    let resource = url.clone();
    let thread = std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            let (stream, _) = match listener.accept() {
                Ok(s) => s,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(e) => panic!("{e}"),
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut stream = BufReader::new(stream);
            let mut payment = None;
            loop {
                let mut line = String::new();
                if stream.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("payment-signature") {
                        payment = Some(value.trim().to_owned());
                    }
                }
            }
            let (status, header, body) = if let Some(payment) = payment {
                let value: Value = serde_json::from_slice(
                    &Base64Bytes::from(payment.as_bytes()).decode().unwrap(),
                )
                .unwrap();
                let raw =
                    Base64Bytes::from(value["payload"]["transaction"].as_str().unwrap().as_bytes())
                        .decode()
                        .unwrap();
                let mut id = tx::double_sha256(&raw);
                id.reverse();
                let mut payments = received.lock().unwrap();
                payments.push(value);
                if payments.len() == 1 {
                    continue;
                } // Settlement could have occurred; lose the HTTP reply.
                (200,"PAYMENT-RESPONSE",Base64Bytes::encode(json!({"success":true,"payer":"public-fixture","transaction":hex(&id),"network":"bch:bchtest"}).to_string()).to_string())
            } else {
                (402,"PAYMENT-REQUIRED",Base64Bytes::encode(json!({"x402Version":2,"resource":{"url":resource},"extensions":{"fixture":{"info":{"order":"one"}}},"accepts":[{
                    "scheme":"exact","network":"bch:bchtest","asset":"BCH","amount":price.load(Ordering::SeqCst).to_string(),"payTo":address,"maxTimeoutSeconds":60,
                    "extra":{"assetTransferMethod":"native","paymentFlow":"upfront","invoiceId":"one"}}]}).to_string()).to_string())
            };
            write!(stream.get_mut(),"HTTP/1.1 {status} Fixture\r\n{header}: {body}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
        }
    });
    Merchant {
        url,
        stopped,
        payments,
        amount,
        thread: Some(thread),
    }
}
fn pay(directory: &Path, url: &str, id: &str, extra: &[&str]) -> Value {
    let mut args = vec![
        "--wallet",
        "fixture.optn",
        "--password-stdin",
        "x402",
        "pay",
        url,
        "--payment-id",
        id,
        "--max-sats",
        "10000",
        "--max-fee-sats",
        "1000",
        "--gap",
        "1",
        "--yes",
    ];
    args.extend_from_slice(extra);
    run(directory, &args, "old-password\nold-password\n")
}
#[test]
fn saved_wallet_sdk_roundtrip_uncertain_retry_and_signed_import() {
    let wallet = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "TREZOR").unwrap();
    let payer = wallet.address(Network::Chipnet, "m/44'/1'/0'/0/0").unwrap();
    let destination = wallet.address(Network::Chipnet, "m/44'/1'/5'/0/0").unwrap();
    let parent = tx::Transaction::new(
        vec![tx::Utxo {
            txid: [7; 32],
            vout: 0,
            value: 21_000,
            script_pubkey: payer.script_pubkey(),
        }],
        vec![tx::Output::new(20_000, payer.script_pubkey())],
    )
    .sign(&[wallet.signing_key("m/44'/1'/0'/0/0").unwrap()])
    .unwrap();
    let (port, stop, server) = hd_loopback(&parent);
    let resource = merchant(destination.encode());
    let directory = tempfile::tempdir().unwrap();
    fixture(directory.path(), port);
    let dry = run(
        directory.path(),
        &[
            "x402",
            "pay",
            &resource.url,
            "--payment-id",
            "purchase",
            "--max-sats",
            "10000",
            "--dry-run",
        ],
        "",
    );
    assert_eq!(dry["dry_run"], true, "{dry}");
    assert!(!directory.path().join(".state").exists());
    let first = pay(directory.path(), &resource.url, "purchase", &[]);
    assert_eq!(first["settlement"], "uncertain", "{first}");
    let second = pay(directory.path(), &resource.url, "purchase", &[]);
    assert_eq!(second["paid"], true, "{second}");
    assert_eq!(first["txid"], second["txid"]);
    let payloads = resource.payments.lock().unwrap().clone();
    assert_eq!(payloads.len(), 2);
    assert_eq!(payloads[0], payloads[1]);
    let raw = Base64Bytes::from(
        payloads[0]["payload"]["transaction"]
            .as_str()
            .unwrap()
            .as_bytes(),
    )
    .decode()
    .unwrap();
    let outputs = tx::decode(&raw).unwrap().outputs;
    assert_eq!(outputs[0].value, 10_000);
    assert_eq!(outputs[0].script_pubkey, destination.script_pubkey());
    assert!(outputs.iter().all(|o| o.token.is_none()));
    assert_eq!(
        pay(directory.path(), &resource.url, "different", &[])["ok"],
        false
    );
    let status = run(
        directory.path(),
        &[
            "--wallet",
            "fixture.optn",
            "--password-stdin",
            "x402",
            "status",
            "--payment-id",
            "purchase",
        ],
        "old-password\n",
    );
    assert_eq!(status["txid"], first["txid"]);
    assert!(status.get("raw_hex").is_none());
    assert_eq!(status["http_status"], 200);
    let legacy = run(
        directory.path(),
        &[
            "--wallet",
            "fixture.optn",
            "--password-stdin",
            "send",
            &destination.encode(),
            "1000",
            "--yes",
        ],
        "old-password\n",
    );
    assert_eq!(legacy["ok"], false);
    assert!(
        legacy["message"].as_str().unwrap().contains("reservations"),
        "{legacy}"
    );
    resource.amount.store(9_999, Ordering::SeqCst);
    assert_eq!(
        pay(directory.path(), &resource.url, "purchase", &[])["ok"],
        false
    );
    resource.amount.store(10_000, Ordering::SeqCst);
    assert_eq!(resource.payments.lock().unwrap().len(), 2);
    let imported = tempfile::tempdir().unwrap();
    fixture(imported.path(), port);
    let file = imported.path().join("transaction.hex");
    let mut bad = raw.clone();
    bad[50] ^= 1;
    std::fs::write(&file, hex(&bad)).unwrap();
    assert_eq!(
        pay(
            imported.path(),
            &resource.url,
            "import",
            &["--transaction", file.to_str().unwrap()]
        )["ok"],
        false
    );
    std::fs::write(&file, hex(&raw)).unwrap();
    let result = pay(
        imported.path(),
        &resource.url,
        "import",
        &["--transaction", file.to_str().unwrap()],
    );
    assert_eq!(result["paid"], true, "{result}");
    assert_eq!(result["txid"], first["txid"]);
    stop.store(true, Ordering::SeqCst);
    assert!(!server.join().unwrap().is_empty());
}
