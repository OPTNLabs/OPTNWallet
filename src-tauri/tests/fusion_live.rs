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

/// Handshake against a LOCAL Electron Cash fusion server.
///
/// The point of this one is interop with the reference implementation itself,
/// not with our own mock. `fusion::run::tests::full_round_against_a_mock_server`
/// proves we speak the protocol we think we speak; only a real `server.py`
/// proves that is the same protocol Electron Cash speaks.
///
/// Bring one up first (chipnet, loopback, plain TCP — the EC server does no TLS
/// of its own):
///
///   python run_fusion_server.py 8787
///
/// Then:
///
///   cargo test --test fusion_live local_ -- --ignored --nocapture
///
/// Override the endpoint with FUSION_LOCAL_HOST / FUSION_LOCAL_PORT.
#[tokio::test]
#[ignore = "requires a locally running Electron Cash fusion server"]
async fn local_server_handshake_matches_electron_cash() {
    let host = std::env::var("FUSION_LOCAL_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("FUSION_LOCAL_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);

    let status = fusion::server_status(&host, port, false, fusion::Transport::Direct, None)
        .await
        .unwrap_or_else(|e| panic!("handshake with local server {host}:{port} failed: {e:?}"));

    println!("ServerHello from {host}:{port} => {status:#?}");

    assert!(!status.tiers.is_empty(), "server advertised no tiers");
    assert!(status.num_components > 0, "server advertised no components");
    // Electron Cash's own default. A different number here would mean we are
    // talking to something that is not server.py, so the test would be proving
    // nothing about interop.
    assert_eq!(
        status.num_components, 23,
        "expected Electron Cash's default component budget"
    );
}
