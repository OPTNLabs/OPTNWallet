// Live verification of the bundled-Tor manager against a real tor binary.
// Ignored by default; the binary path is provided via OPTN_TOR_BIN so CI or a
// developer can point it at a fetched Tor Expert Bundle. Run with e.g.:
//   OPTN_TOR_BIN="C:\...\Tor\tor.exe" \
//   OPTN_TOR_GEOIP="C:\...\Data\Tor\geoip" \
//   OPTN_TOR_GEOIP6="C:\...\Data\Tor\geoip6" \
//   cargo test --test tor_manager_live -- --ignored --nocapture
//
// Starts tor on a dedicated SOCKS port (not the standard 9050/9150, so it
// won't clash with any already-running Tor), waits for bootstrap, completes a
// read-only fusion handshake THROUGH that tor, then stops it.

use std::path::PathBuf;
use std::time::Duration;

use app_lib::fusion::tor_manager::{self, TorPaths};
use app_lib::fusion::{self, Transport};

#[tokio::test]
#[ignore = "requires a real tor binary via OPTN_TOR_BIN"]
async fn starts_bundled_tor_and_fuses_through_it() {
    let bin = match std::env::var("OPTN_TOR_BIN") {
        Ok(b) => PathBuf::from(b),
        Err(_) => {
            eprintln!("OPTN_TOR_BIN not set — skipping");
            return;
        }
    };
    let data_dir = std::env::temp_dir().join("optn-tor-manager-test");
    let paths = TorPaths {
        binary: bin,
        data_dir,
        geoip: std::env::var("OPTN_TOR_GEOIP").ok().map(PathBuf::from),
        geoip6: std::env::var("OPTN_TOR_GEOIP6").ok().map(PathBuf::from),
    };

    // Dedicated port so we don't collide with a running Tor Browser (9150).
    let socks_port = 9251;
    let port = tor_manager::start(paths, socks_port, Duration::from_secs(90))
        .await
        .expect("bundled tor failed to start/bootstrap");
    println!("bundled tor bootstrapped, SOCKS on {port}");
    assert_eq!(port, socks_port);
    assert!(tor_manager::status().running);
    assert_eq!(tor_manager::status().bootstrap_percent, 100);

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
    .expect("fusion handshake through bundled tor failed");
    println!(
        "ServerHello through bundled tor => num_components={}",
        status.num_components
    );
    assert!(status.num_components > 0);

    tor_manager::stop().await.unwrap();
    assert!(!tor_manager::status().running);
    println!("bundled tor stopped cleanly");
}
