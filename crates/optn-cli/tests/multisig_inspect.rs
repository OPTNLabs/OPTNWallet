use std::process::Command;

const KEY_A: &str = "02ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f8";
const KEY_B: &str = "02fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f";
const REDEEM_SCRIPT: &str = "522102fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f2102ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f852ae";

#[test]
fn multisig_inspect_uses_the_shared_bip67_core() {
    let output = Command::new(env!("CARGO_BIN_EXE_optn"))
        .args([
            "--json",
            "--network",
            "chipnet",
            "multisig",
            "inspect",
            "--threshold",
            "2",
            "--pubkey",
            KEY_A,
            "--pubkey",
            KEY_B,
        ])
        .env_remove("OPTN_MNEMONIC")
        .env_remove("OPTN_POLICY")
        .output()
        .expect("could not run optn");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("multisig inspect emits JSON");
    assert_eq!(value["ok"], true);
    assert_eq!(value["network"], "chipnet");
    assert_eq!(value["redeem_script"], REDEEM_SCRIPT);
    assert_eq!(
        value["sorted_public_keys"],
        serde_json::json!([KEY_B, KEY_A])
    );
    assert!(value["address"].as_str().unwrap().starts_with("bchtest:p"));
    assert!(value["token_address"]
        .as_str()
        .unwrap()
        .starts_with("bchtest:r"));
}
