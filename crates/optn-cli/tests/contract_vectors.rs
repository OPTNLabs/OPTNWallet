//! The CLI must derive the same contract addresses the desktop wallet does.
//!
//! These vectors were generated with the `cashscript` library itself against
//! the artifacts this wallet ships. That is the point: an address derived by a
//! plausible-looking reimplementation is worse than no address at all, because
//! funds sent to it are locked under a script for which nobody holds a spending
//! path. Nothing here is asserted from a reading of how the library probably
//! works — only against what it actually produced.

use std::process::Command;

/// Run the CLI and return its parsed JSON output.
fn run(args: &[&str]) -> serde_json::Value {
    let binary = env!("CARGO_BIN_EXE_optn");
    let output = Command::new(binary)
        .args(args)
        .env_remove("OPTN_MNEMONIC")
        .env_remove("OPTN_POLICY")
        .output()
        .expect("could not run the optn binary");
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).unwrap_or_else(|e| {
        panic!(
            "output was not JSON ({e})\nargs: {args:?}\nstdout: {stdout}\nstderr: {}",
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[derive(serde::Deserialize)]
struct Vector {
    #[serde(rename = "contractName")]
    contract_name: String,
    network: String,
    args: Vec<String>,
    #[serde(rename = "redeemScriptHex")]
    redeem_script_hex: String,
    address: String,
    #[serde(rename = "tokenAddress")]
    token_address: String,
}

#[derive(serde::Deserialize)]
struct Document {
    vectors: Vec<Vector>,
}

fn vectors() -> Vec<Vector> {
    let source = include_str!("vectors/contracts.json");
    let document: Document = serde_json::from_str(source).expect("vectors are valid JSON");
    assert!(
        !document.vectors.is_empty(),
        "a truncated fixture would make every assertion below vacuous"
    );
    document.vectors
}

#[test]
fn derives_the_same_address_as_the_cashscript_library() {
    for vector in vectors() {
        let mut args: Vec<String> = vec![
            "--json".into(),
            "--network".into(),
            vector.network.clone(),
            "contract".into(),
            "address".into(),
            vector.contract_name.clone(),
        ];
        for argument in &vector.args {
            args.push("--arg".into());
            args.push(argument.clone());
        }

        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
        let value = run(&borrowed);

        let label = format!("{} on {}", vector.contract_name, vector.network);
        assert_eq!(
            value["ok"],
            true,
            "{label} failed: {}",
            value["message"].as_str().unwrap_or("")
        );
        assert_eq!(
            value["redeem_script"], vector.redeem_script_hex,
            "{label}: redeem script differs from the library's"
        );
        assert_eq!(value["address"], vector.address, "{label}: address differs");
        assert_eq!(
            value["token_address"], vector.token_address,
            "{label}: token address differs"
        );
    }
}

#[test]
fn every_bundled_contract_is_listed() {
    let value = run(&["--json", "contract", "list"]);
    assert_eq!(value["ok"], true);
    let contracts = value["contracts"].as_array().expect("contracts array");
    assert!(!contracts.is_empty(), "no contracts are bundled");

    // Every artifact must parse and assemble. A contract that only fails when
    // someone tries to use it is a contract nobody finds out about until they
    // are trying to move funds.
    for contract in contracts {
        assert!(
            contract["assembles"].as_bool().unwrap_or(false),
            "{} does not assemble: {}",
            contract["name"],
            contract["error"].as_str().unwrap_or("")
        );
    }
}

#[test]
fn info_reports_the_constructor_and_the_functions() {
    let value = run(&["--json", "contract", "info", "TransferWithTimeout"]);
    assert_eq!(value["ok"], true);
    assert_eq!(value["name"], "TransferWithTimeout");

    let inputs = value["constructor"].as_array().expect("constructor");
    let names: Vec<&str> = inputs
        .iter()
        .map(|i| i["name"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(names, ["sender", "recipient", "timeout"]);

    let functions = value["functions"].as_array().expect("functions");
    let function_names: Vec<&str> = functions
        .iter()
        .map(|f| f["name"].as_str().unwrap_or(""))
        .collect();
    assert!(function_names.contains(&"transfer"));
    assert!(function_names.contains(&"timeout"));
}

#[test]
fn the_wrong_argument_count_is_refused_before_an_address_is_produced() {
    // An address derived from the wrong arguments is a real address that
    // nobody can spend from. Refusing is the only safe answer.
    let value = run(&[
        "--json",
        "contract",
        "address",
        "TransferWithTimeout",
        "--arg",
        "02aa",
    ]);
    assert_eq!(value["ok"], false);
    let message = value["message"].as_str().unwrap_or("");
    assert!(
        message.contains("3") && message.contains("argument"),
        "the error should say how many are needed: {message}"
    );
}

#[test]
fn an_unknown_contract_names_the_ones_that_exist() {
    let value = run(&["--json", "contract", "info", "NotAContract"]);
    assert_eq!(value["ok"], false);
    let message = value["message"].as_str().unwrap_or("");
    assert!(
        message.contains("p2pkh") || message.contains("escrow"),
        "the error should list what is available: {message}"
    );
}
