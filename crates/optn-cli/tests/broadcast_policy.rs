use optn_runtime::network_config::{
    encode_envelope_json, NetworkConfigEnvelope, UserNetworkOverlay,
};
use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn unavailable_broadcast_has_nonzero_exit_and_read_policy_cannot_submit() {
    let directory = std::env::temp_dir().join(format!(
        "optn-broadcast-policy-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&directory).unwrap();
    let config = directory.join("network-chipnet.json");
    fs::write(
        &config,
        encode_envelope_json(&NetworkConfigEnvelope::current(
            "test",
            UserNetworkOverlay::default(),
        ))
        .unwrap(),
    )
    .unwrap();
    let invoke = |policy: &str| {
        Command::new(env!("CARGO_BIN_EXE_optn"))
            .args([
                "--json",
                "--network",
                "chipnet",
                "--timeout",
                "1",
                "--network-config-dir",
            ])
            .arg(&directory)
            .args(["broadcast", "00"])
            .env_remove("OPTN_MNEMONIC")
            .env("OPTN_POLICY", policy)
            .output()
            .unwrap()
    };
    let unavailable = invoke("spend");
    let denied = invoke("read");
    fs::remove_file(config).unwrap();
    fs::remove_dir(directory).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&unavailable.stdout).unwrap();
    assert_eq!(unavailable.status.code(), Some(3), "{value}");
    assert_eq!(value["ok"], false);
    assert_eq!(value["state"], "unavailable");
    assert_eq!(value["txid"].as_str().unwrap().len(), 64);
    let value: serde_json::Value = serde_json::from_slice(&denied.stdout).unwrap();
    assert_eq!(denied.status.code(), Some(2), "{value}");
    assert_eq!(value["error"], "usage");
}
