// Live handshake against a real, public CashFusion server.
//
// Ignored by default so `cargo test` stays hermetic and offline-safe; CI never
// depends on a third-party host being up. Run explicitly with:
//   cargo test --test fusion_live -- --ignored --nocapture
//
// This performs ONLY the read-only ClientHello/ServerHello handshake — it joins
// no pool, submits no coins, and signs nothing, so it cannot touch funds. No
// wallet or mainnet key material is involved at any point.
//
// Server default taken from Electron Cash's own conf.py (`fusion.servo.cash:8789`, SSL).

use app_lib::fusion;

#[tokio::test]
#[ignore = "requires network; hits a live third-party CashFusion server"]
async fn handshake_against_the_public_default_server() {
    // Direct (no Tor) — this test only reads public server params, touches no
    // wallet or coins, so IP privacy is irrelevant here.
    let status = fusion::server_status(
        "fusion.servo.cash",
        8789,
        true,
        fusion::Transport::Direct,
        None,
    )
    .await
    .expect("handshake with fusion.servo.cash failed");

    println!("ServerHello from fusion.servo.cash:8789 => {status:#?}");

    // A real fusion server must advertise at least one pool tier and a
    // non-zero component budget; empty values would mean we decoded garbage
    // rather than a genuine ServerHello.
    assert!(!status.tiers.is_empty(), "server advertised no tiers");
    assert!(status.num_components > 0, "server advertised no components");
}
