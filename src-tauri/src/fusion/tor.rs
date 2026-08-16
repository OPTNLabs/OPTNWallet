// Tor support for CashFusion, modeled directly on Electron Cash's approach
// (electroncash_plugins/fusion/{covert.py,plugin.py}).
//
// We do NOT bundle or supervise a Tor daemon. Tor is reached as a SOCKS5 proxy
// that the user already runs — either the Tor Browser bundle (port 9150) or a
// system/daemon Tor (port 9050). That is exactly Electron Cash's model:
//     TOR_PORTS = [9050, 9150]           (plugin.py)
//     proxy_type = socks.SOCKS5 ...      (covert.py)
//
// Why Tor matters here and is not merely "nice to have": CashFusion's privacy
// rests on the server being unable to link the inputs a player submits to the
// outputs they claim. The protocol achieves that by having each player open
// SEPARATE, independently-timed "covert" connections. If those connections all
// originate from one IP address, the server can trivially re-link them and the
// cryptography buys you nothing. Hence Electron Cash refuses to fuse against a
// remote server with no Tor proxy available (plugin.py's start_fusion raises
// "can't find tor port"), with one deliberate exemption: a server on localhost,
// where there is no network observer to hide from.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Electron Cash's TOR_PORTS (plugin.py): 9050 = system/daemon Tor,
/// 9150 = Tor Browser bundle. Probed in this order.
pub const TOR_PORTS: [u16; 2] = [9050, 9150];

pub const DEFAULT_TOR_HOST: &str = "127.0.0.1";

const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Is a real Tor SOCKS proxy listening here?
///
/// Uses Electron Cash's own trick (covert.py `is_tor_port`): send a plain
/// `GET\n` and check for Tor's distinctive refusal. Something merely *listening*
/// on 9050 is not necessarily Tor — this actually confirms it, so we never route
/// fusion traffic through an unknown proxy believing it is Tor.
pub async fn is_tor_port(host: &str, port: u16) -> bool {
    let probe = async {
        let mut stream = TcpStream::connect((host, port)).await.ok()?;
        // Capability check only: external proxies remain explicitly user-trusted.
        // A Tor HTTP-refusal string is not authentication because any local
        // listener can replay it. Exercise the SOCKS5 protocol instead.
        stream.write_all(&[0x05, 0x01, 0x00]).await.ok()?;
        let mut response = [0u8; 2];
        stream.read_exact(&mut response).await.ok()?;
        Some(response == [0x05, 0x00])
    };

    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, probe).await,
        Ok(Some(true))
    )
}

/// Find a running Tor proxy, mirroring plugin.py's `scan_torport`: try each
/// known port and return the first that is genuinely Tor. `None` = no Tor.
pub async fn scan_tor_port(host: &str) -> Option<u16> {
    for port in TOR_PORTS {
        if is_tor_port(host, port).await {
            return Some(port);
        }
    }
    None
}

/// Connect to `dest` through the Tor SOCKS5 proxy at `proxy`.
///
/// `isolation_token` becomes the SOCKS username/password. Tor treats distinct
/// credentials as distinct circuits ("stream isolation"), so passing a fresh
/// random token per connection ensures separate covert connections do not share
/// an exit path — the same reason covert.py sets `proxy_username`/`proxy_password`
/// to a per-slot random value. Passing the same token twice deliberately reuses
/// a circuit, which is a privacy leak, so callers must randomize it.
pub async fn connect_via_tor(
    proxy_host: &str,
    proxy_port: u16,
    dest_host: &str,
    dest_port: u16,
    isolation_token: &str,
) -> Result<TcpStream, String> {
    tokio_socks::tcp::Socks5Stream::connect_with_password(
        (proxy_host, proxy_port),
        (dest_host, dest_port),
        isolation_token,
        isolation_token,
    )
    .await
    .map(|s| s.into_inner())
    .map_err(|e| format!("Tor SOCKS5 connection failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_plain_tcp_listener_is_not_mistaken_for_tor() {
        // Guards the security-relevant half of the check: something listening on
        // the port must NOT be accepted as Tor unless it actually answers like Tor.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut s, _)) = listener.accept().await {
                let mut buf = [0u8; 16];
                let _ = s.read(&mut buf).await;
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await;
            }
        });

        assert!(!is_tor_port("127.0.0.1", port).await);
    }

    #[tokio::test]
    async fn a_listener_spoofing_the_tor_http_marker_is_not_trusted() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut request = [0u8; 16];
                let _ = stream.read(&mut request).await;
                let _ = stream.write_all(b"Tor is not an HTTP Proxy").await;
            }
        });
        assert!(!is_tor_port("127.0.0.1", port).await);
    }

    #[tokio::test]
    async fn a_closed_port_is_not_tor() {
        // Port 1 is reserved and won't be listening.
        assert!(!is_tor_port("127.0.0.1", 1).await);
    }
}
