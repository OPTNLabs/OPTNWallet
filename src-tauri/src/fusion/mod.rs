// CashFusion classic (server) client — full path shipped for PR #12.
//
// Why this lives in Rust rather than the frontend: CashFusion's wire protocol
// is raw TCP with TLS and protobuf framing. A WebView can only open
// HTTP/WebSocket connections, so it cannot speak this protocol at all.
//
// Scope (see docs/cashfusion-implementation-scope.md): handshake + pool/round
// participation — Pedersen, blind Schnorr, covert circuits, Tor, blame, plan
// validation (`pedersen`, `schnorr`, `covert`, `run`, `session`, `tor`, …).
// P2P CashFusion (Nostr) is a separate TS path under platform/desktop/nostr/.
//
// Every wire-level constant here is taken from the reference implementation
// (Electron Cash, electroncash_plugins/fusion/), not inferred:
//   - frame format + magic:  connection.py  (`<8-byte magic><4-byte BE length><msg>`)
//   - MAX_MSG_LENGTH:        connection.py  (200 KiB)
//   - protocol version:      protocol.py    (VERSION = b'alpha13')
//   - message shapes:        protobuf/fusion.proto (vendored, MIT, © 2020 Mark B. Lundeberg)

use std::sync::Arc;
use std::time::Duration;

use prost::Message;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

pub mod blame;
pub mod components;
pub mod covert;
pub mod electrum_input;
pub mod encrypt;
pub mod p2p_component;
pub mod p2p_sign;
pub mod pedersen;
pub mod round;
pub mod round_cancel;
pub mod run;
pub mod schnorr;
pub mod server_plan;
pub mod session;
pub mod tor;
pub mod tor_manager;
pub mod tx;

/// A connected, framed transport to a fusion server — either a plain TCP stream
/// or a TLS stream, over Direct or Tor. Boxed so `connect_stream` can return one
/// type regardless of which leg was taken, and the round logic can be written
/// against a single stream type.
pub(crate) trait FusionIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> FusionIo for T {}
pub(crate) type FusionStream = Box<dyn FusionIo>;

// Generated from proto/fusion.proto by build.rs (package `fusion`).
pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/fusion.rs"));
}

/// How to reach a fusion server: directly, or through a Tor SOCKS5 proxy.
#[derive(Debug, Clone, Copy)]
pub enum Transport<'a> {
    Direct,
    Tor { host: &'a str, port: u16 },
}

/// A server reachable without Tor. Electron Cash grants exactly one exemption
/// from its Tor requirement — a server on localhost, where there is no network
/// observer to hide from (plugin.py: "as a special exemption for the local
/// fusion server, we don't use Tor").
pub fn is_local_server(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// Frame magic — connection.py: `magic = bytes.fromhex("765be8b4e4396dcf")`.
const MAGIC: [u8; 8] = [0x76, 0x5b, 0xe8, 0xb4, 0xe4, 0x39, 0x6d, 0xcf];

/// connection.py: `MAX_MSG_LENGTH = 200*1024`. Enforced on receive so a hostile
/// or broken server cannot make us allocate an unbounded buffer.
const MAX_MSG_LENGTH: u32 = 200 * 1024;

/// protocol.py: `VERSION = b'alpha13'`. A server on a different protocol
/// version rejects the ClientHello, which is the intended behavior.
pub(crate) const VERSION: &[u8] = b"alpha13";

/// Native execution remains guarded here so a renderer cannot bypass the
/// wallet's safety boundary. The required reservation, output tracking,
/// integrity validation, cancellation, signing, Tor routing, and post-broadcast
/// verification protections are now implemented.
pub(crate) const FUSION_EXECUTION_PAUSED_MESSAGE: &str =
    "CashFusion execution is paused until wallet safety protections are complete.";

/// Keep this deny-by-default switch in the native process so a renderer cannot
/// bypass the disabled settings control by invoking the command directly.
pub(crate) const fn fusion_execution_ready() -> bool {
    true
}

pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const IO_TIMEOUT: Duration = Duration::from_secs(15);

/// What Phase 1 can actually report: the server's real, protocol-level fusion
/// parameters. Serialized straight to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FusionServerStatus {
    pub tiers: Vec<u64>,
    pub num_components: u32,
    pub component_feerate: u64,
    pub min_excess_fee: u64,
    pub max_excess_fee: u64,
    pub donation_address: Option<String>,
}

/// Write one framed message: magic ++ big-endian u32 length ++ payload.
pub(crate) async fn send_frame<S>(stream: &mut S, payload: &[u8]) -> Result<(), String>
where
    S: AsyncWriteExt + Unpin,
{
    let mut frame = Vec::with_capacity(12 + payload.len());
    frame.extend_from_slice(&MAGIC);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);

    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&frame))
        .await
        .map_err(|_| "timed out sending to fusion server".to_string())?
        .map_err(|e| format!("send failed: {e}"))?;
    Ok(())
}

/// Read one framed message, validating magic and length before allocating.
pub(crate) async fn recv_frame<S>(stream: &mut S) -> Result<Vec<u8>, String>
where
    S: AsyncReadExt + Unpin,
{
    recv_frame_with_timeout(stream, IO_TIMEOUT).await
}

/// Read one framed message with the wait window required by the current
/// protocol phase. CashFusion deliberately pauses for about 30 seconds between
/// `FusionBegin` and `StartRound`, so the short handshake timeout cannot be
/// reused for that phase.
pub(crate) async fn recv_frame_with_timeout<S>(
    stream: &mut S,
    wait: Duration,
) -> Result<Vec<u8>, String>
where
    S: AsyncReadExt + Unpin,
{
    tokio::time::timeout(wait, recv_frame_unbounded(stream))
        .await
        .map_err(|_| "timed out waiting for fusion server".to_string())?
}

/// Read a frame without imposing the handshake timeout. Long-lived protocol
/// phases wrap this in one authoritative phase deadline and cancellation
/// select, covering both header and body without a hidden shorter timer.
pub(crate) async fn recv_frame_unbounded<S>(stream: &mut S) -> Result<Vec<u8>, String>
where
    S: AsyncReadExt + Unpin,
{
    let mut header = [0u8; 12];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|e| format!("receive failed: {e}"))?;

    if header[..8] != MAGIC {
        return Err("bad magic in frame — not a CashFusion server".into());
    }

    let len = u32::from_be_bytes([header[8], header[9], header[10], header[11]]);
    if len > MAX_MSG_LENGTH {
        return Err(format!("frame too large: {len} > {MAX_MSG_LENGTH}"));
    }

    let mut payload = vec![0u8; len as usize];
    stream
        .read_exact(&mut payload)
        .await
        .map_err(|e| format!("receive failed: {e}"))?;
    Ok(payload)
}

/// Run the Phase 1 handshake over an already-established stream.
/// Split out from the connection setup so it can be tested against an
/// in-memory duplex stream with no real network involved.
async fn handshake<S>(
    stream: &mut S,
    genesis_hash: Option<Vec<u8>>,
) -> Result<FusionServerStatus, String>
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    let hello = pb::ClientMessage {
        msg: Some(pb::client_message::Msg::Clienthello(pb::ClientHello {
            version: VERSION.to_vec(),
            genesis_hash,
        })),
    };
    send_frame(stream, &hello.encode_to_vec()).await?;

    let raw = recv_frame(stream).await?;
    let reply = pb::ServerMessage::decode(raw.as_slice())
        .map_err(|e| format!("could not decode server message: {e}"))?;

    match reply.msg {
        Some(pb::server_message::Msg::Serverhello(h)) => Ok(FusionServerStatus {
            tiers: h.tiers,
            num_components: h.num_components,
            component_feerate: h.component_feerate,
            min_excess_fee: h.min_excess_fee,
            max_excess_fee: h.max_excess_fee,
            donation_address: h.donation_address,
        }),
        // The server reports version mismatches and the like through this.
        Some(pb::server_message::Msg::Error(e)) => Err(format!(
            "server rejected us: {}",
            e.message.unwrap_or_default()
        )),
        _ => Err("unexpected reply — expected ServerHello".into()),
    }
}

/// Connect to a CashFusion server, complete the hello handshake, and return the
/// server's fusion parameters. Opens a fresh connection and closes it; holds no
/// state and joins no pool.
///
/// When `transport` is `Tor`, the TCP leg is dialed through the SOCKS5 proxy and
/// TLS is then negotiated *over* that tunnel — so the server sees the exit node,
/// not the user, while certificate verification still applies end-to-end.
pub async fn server_status(
    host: &str,
    port: u16,
    use_ssl: bool,
    transport: Transport<'_>,
    genesis_hash: Option<Vec<u8>>,
) -> Result<FusionServerStatus, String> {
    let mut stream = connect_stream(host, port, use_ssl, transport).await?;
    handshake(&mut stream, genesis_hash).await
}

/// Open a connection to a fusion server and return a framed stream, taking the
/// Direct or Tor leg and layering TLS on top when `use_ssl`. Shared by the
/// status handshake and the fusion round (round.rs) so both dial identically.
///
/// Over Tor the TCP leg is dialed through the SOCKS5 proxy and TLS is negotiated
/// *over* that tunnel — the server sees the exit node, not the user, while
/// certificate verification still applies end-to-end. Each call gets a fresh Tor
/// circuit (isolation token), which is exactly what the covert phase relies on.
pub(crate) async fn connect_stream(
    host: &str,
    port: u16,
    use_ssl: bool,
    transport: Transport<'_>,
) -> Result<FusionStream, String> {
    let tcp = match transport {
        Transport::Direct => {
            tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
                .await
                .map_err(|_| format!("timed out connecting to {host}:{port}"))?
                .map_err(|e| format!("could not connect to {host}:{port}: {e}"))?
        }
        Transport::Tor {
            host: proxy_host,
            port: proxy_port,
        } => {
            let token = format!("optn-{}", fastrand_token());
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                tor::connect_via_tor(proxy_host, proxy_port, host, port, &token),
            )
            .await
            .map_err(|_| format!("timed out connecting to {host}:{port} over Tor"))??
        }
    };

    if !use_ssl {
        return Ok(Box::new(tcp));
    }

    // rustls refuses to pick a crypto provider implicitly when more than one is
    // compiled in (both ring and aws-lc-rs are reachable through this app's
    // dependency tree), so name it explicitly rather than depend on feature
    // resolution that could silently change as dependencies shift.
    let roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config = ClientConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| format!("TLS setup failed: {e}"))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let server_name = ServerName::try_from(host.to_string())
        .map_err(|_| format!("invalid server name: {host}"))?;

    let stream = TlsConnector::from(Arc::new(config))
        .connect(server_name, tcp)
        .await
        .map_err(|e| format!("TLS handshake failed: {e}"))?;

    Ok(Box::new(stream))
}

/// Unique token per connection, for Tor stream isolation (see tor.rs). Only has
/// to be *distinct* per connection, not unpredictable — Tor keys circuits off
/// the SOCKS credentials, it doesn't treat them as a secret. A monotonic counter
/// plus the clock gives that without pulling in an RNG dependency.
fn fastrand_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}-{n:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_header_matches_reference_format() {
        // magic ++ 4-byte big-endian length. Guards the exact bytes on the wire
        // against an accidental endianness or ordering change.
        let payload = [0xAAu8; 3];
        let mut expected = Vec::new();
        expected.extend_from_slice(&MAGIC);
        expected.extend_from_slice(&[0, 0, 0, 3]);
        expected.extend_from_slice(&payload);

        let (mut client, mut server) = tokio::io::duplex(64);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            send_frame(&mut client, &payload).await.unwrap();
            let mut got = vec![0u8; expected.len()];
            tokio::io::AsyncReadExt::read_exact(&mut server, &mut got)
                .await
                .unwrap();
            assert_eq!(got, expected);
        });
    }

    #[test]
    fn rejects_a_frame_that_is_not_cashfusion() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(64);
            // Anything that isn't the magic must be refused rather than parsed.
            let mut junk = vec![0u8; 12];
            junk[..8].copy_from_slice(b"NOTFUSIO");
            tokio::io::AsyncWriteExt::write_all(&mut server, &junk)
                .await
                .unwrap();

            let err = recv_frame(&mut client).await.unwrap_err();
            assert!(err.contains("bad magic"), "unexpected error: {err}");
        });
    }

    #[test]
    fn frame_receive_can_use_a_protocol_specific_wait_window() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(64);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(25)).await;
                send_frame(&mut server, b"after-warmup").await.unwrap();
            });

            let frame = recv_frame_with_timeout(&mut client, Duration::from_millis(100))
                .await
                .unwrap();
            assert_eq!(frame, b"after-warmup");
        });
    }

    #[test]
    fn handshake_round_trips_against_a_stub_server() {
        // Drives the real client handshake against a stub speaking the real
        // frame format, so the ClientHello encoding and ServerHello decoding
        // are both exercised end to end without touching the network.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(4096);

            let server_task = tokio::spawn(async move {
                let raw = recv_frame(&mut server).await.unwrap();
                let msg = pb::ClientMessage::decode(raw.as_slice()).unwrap();
                match msg.msg {
                    Some(pb::client_message::Msg::Clienthello(h)) => {
                        assert_eq!(h.version, VERSION.to_vec());
                    }
                    _ => panic!("expected a ClientHello"),
                }

                let hello = pb::ServerMessage {
                    msg: Some(pb::server_message::Msg::Serverhello(pb::ServerHello {
                        tiers: vec![10_000, 100_000],
                        num_components: 23,
                        component_feerate: 1_000,
                        min_excess_fee: 10,
                        max_excess_fee: 10_000,
                        donation_address: None,
                    })),
                };
                send_frame(&mut server, &hello.encode_to_vec())
                    .await
                    .unwrap();
            });

            let status = handshake(&mut client, None).await.unwrap();
            server_task.await.unwrap();

            assert_eq!(status.tiers, vec![10_000, 100_000]);
            assert_eq!(status.num_components, 23);
            assert_eq!(status.component_feerate, 1_000);
        });
    }

    #[test]
    fn surfaces_a_server_error_reply() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(4096);

            let server_task = tokio::spawn(async move {
                let _ = recv_frame(&mut server).await.unwrap();
                let err = pb::ServerMessage {
                    msg: Some(pb::server_message::Msg::Error(pb::Error {
                        message: Some("incompatible version".to_string()),
                    })),
                };
                send_frame(&mut server, &err.encode_to_vec()).await.unwrap();
            });

            let err = handshake(&mut client, None).await.unwrap_err();
            server_task.await.unwrap();
            assert!(err.contains("incompatible version"), "unexpected: {err}");
        });
    }

    #[test]
    fn execution_gate_opens_after_the_wallet_safety_work_is_complete() {
        assert!(fusion_execution_ready());
        assert!(FUSION_EXECUTION_PAUSED_MESSAGE.contains("safety"));
    }
}
