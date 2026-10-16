//! Real CLI, supplied public fixtures, no wallet/storage/network access.
use serde_json::Value;
use std::process::Command;

#[test]
fn offline_review_and_finalization_use_the_shared_core() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../test-vectors/seedcash-cashtokens.json"
    ))
    .unwrap();
    let case = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "mega-mix-genesis-mint-mutate-ft-nft-burn")
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("original.hex");
    let signed = dir.path().join("signed.hex");
    std::fs::write(&original, case["psbt_hex"].as_str().unwrap()).unwrap();
    std::fs::write(&signed, case["signed_psbt_hex"].as_str().unwrap()).unwrap();
    let run = |network, finalize| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_optn"));
        command
            .env("OPTN_POLICY", "read")
            .args([
                "--network",
                network,
                "--json",
                "--host",
                "invalid.invalid",
                "--timeout",
                "1",
                "psbt",
            ])
            .arg(&original);
        if finalize {
            command.arg("--signed").arg(&signed);
        }
        command.output().unwrap()
    };
    let output = run("chipnet", false);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reviewed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        reviewed["review"]["genesis_candidates"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(reviewed["sent"], false);
    assert!(reviewed["raw_transaction_hex"].is_null());
    let output = run("chipnet", true);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let finalized: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        finalized["raw_transaction_hex"],
        case["raw_transaction_hex"]
    );
    assert_eq!(finalized["sent"], false);
    assert!(!run("mainnet", true).status.success());
    std::fs::write(&signed, case["psbt_hex"].as_str().unwrap()).unwrap();
    assert!(!run("chipnet", true).status.success());
}
