// Live proof that the native TCP+TLS Electrum transport actually speaks to a
// real server. Ignored by default so CI stays offline-safe; run with:
//   cargo test --test electrum_tcp_live -- --ignored --nocapture
//
// Read-only: sends `server.version` and reads the reply. No wallet, no keys, no
// coins — cannot touch funds. Uses a public server on its raw TCP-SSL port 50002
// (the port the web/WSS build cannot reach, which is the whole point).

use app_lib::electrum_tcp::{open_stream, ElectrumStream};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
#[ignore = "requires network; hits a live third-party Electrum server over TCP-SSL"]
async fn server_version_round_trip_over_tcp_ssl() {
    let stream = open_stream("electrum.imaginary.cash", 50002, true)
        .await
        .expect("TCP+TLS connect failed");

    // Electrum is newline-delimited JSON-RPC.
    let request = b"{\"id\":0,\"method\":\"server.version\",\"params\":[\"optn-test\",\"1.4\"]}\n";

    // One small helper closure over both stream variants.
    async fn round_trip<S: AsyncReadExt + AsyncWriteExt + Unpin>(mut s: S, req: &[u8]) -> String {
        s.write_all(req).await.expect("write failed");
        let mut buf = vec![0u8; 4096];
        let n = s.read(&mut buf).await.expect("read failed");
        String::from_utf8_lossy(&buf[..n]).into_owned()
    }

    let reply = match stream {
        ElectrumStream::Plain(s) => round_trip(s, request).await,
        ElectrumStream::Tls(s) => round_trip(*s, request).await,
    };

    println!("server.version reply: {reply}");
    // A real Electrum server echoes our id and returns a result array
    // (server software string + protocol version).
    assert!(
        reply.contains("\"id\": 0") || reply.contains("\"id\":0"),
        "no matching id in reply: {reply}"
    );
    assert!(reply.contains("\"result\""), "no result in reply: {reply}");
}
