// Live verification of the Tor path against a locally-running Tor SOCKS proxy
// (Tor Browser on 9150, or a daemon on 9050). Ignored by default; run with:
//   cargo test --test tor_live -- --ignored --nocapture
//
// Read-only: confirms the proxy is genuinely Tor, then completes the fusion
// ClientHello/ServerHello handshake THROUGH Tor (so the server sees the exit
// node, not us). No wallet, no keys, no coins.

use app_lib::fusion::{self, tor, Transport};

#[tokio::test]
#[ignore = "requires a running Tor SOCKS proxy (Tor Browser 9150 / daemon 9050)"]
async fn detects_tor_and_completes_fusion_handshake_over_tor() {
    let port = tor::scan_tor_port("127.0.0.1")
        .await
        .expect("no Tor SOCKS proxy found on 9050/9150 — start Tor first");
    println!("Tor SOCKS proxy detected on port {port}");

    let status = fusion::server_status(
        "fusion.servo.cash",
        8789,
        true,
        Transport::Tor {
            host: "127.0.0.1",
            port,
        },
        None,
    )
    .await
    .expect("fusion handshake over Tor failed");

    println!("ServerHello over Tor => {status:#?}");
    assert!(!status.tiers.is_empty(), "no tiers in ServerHello");
    assert!(status.num_components > 0, "no components in ServerHello");
}
