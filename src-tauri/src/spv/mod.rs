// BIP37 SPV — Phase 1: BCH P2P framing + version/verack handshake + node probe.
//
// A full node speaks the raw Bitcoin Cash P2P protocol, not Electrum JSON-RPC,
// so — like CashFusion — the client must live in Rust; a WebView cannot open a
// raw TCP peer connection. Phase 1 does exactly one verifiable thing: connect,
// complete the version/verack handshake, and report the peer's advertised
// parameters (user-agent, protocol version, services incl. NODE_BLOOM/BIP37,
// block height). It does NOT sync headers, load a bloom filter, or track UTXOs
// — those are later phases (see the plan).
//
// Wire constants come from Bitcoin Cash Node src/chainparams.cpp (net magic +
// default P2P port per network) and the P2P message spec: a 24-byte header
// (4 magic, 12 command, 4 LE length, 4 checksum = first 4 bytes of
// double-SHA256(payload)), little-endian integers, and CompactSize varints.

use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::fusion::{tor, Transport};

// We advertise a modern protocol version; nodes negotiate down as needed.
const PROTOCOL_VERSION: i32 = 70015;
/// BIP111 service bit: the peer will serve BIP37 bloom filters. `1 << 2`.
const NODE_BLOOM: u64 = 1 << 2;
const USER_AGENT: &str = "/OPTNWallet:1.0/";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(15);
// version/verack are tiny; bound payloads so a hostile peer cannot make us
// allocate unboundedly during the handshake. Later phases that read blocks will
// raise this deliberately.
const MAX_PAYLOAD: usize = 2 * 1024 * 1024;

/// Network magic + default P2P port for a BCH network (chainparams.cpp).
#[derive(Debug, Clone, Copy)]
pub struct NetworkParams {
    pub magic: [u8; 4],
    pub default_port: u16,
}

/// Resolve params from the app's network label. testnet4 and chipnet share the
/// same magic and are distinguished only by port (28333 vs 48333). Unknown
/// labels fall back to mainnet.
pub fn params_for(network: &str) -> NetworkParams {
    match network {
        "chipnet" => NetworkParams { magic: [0xe2, 0xb7, 0xda, 0xaf], default_port: 48333 },
        "testnet4" => NetworkParams { magic: [0xe2, 0xb7, 0xda, 0xaf], default_port: 28333 },
        "testnet" | "testnet3" => NetworkParams { magic: [0xf4, 0xe5, 0xf3, 0xf4], default_port: 18333 },
        "regtest" => NetworkParams { magic: [0xda, 0xb5, 0xbf, 0xfa], default_port: 18444 },
        // "mainnet" and anything unrecognized.
        _ => NetworkParams { magic: [0xe3, 0xe1, 0xf3, 0xe8], default_port: 8333 },
    }
}

/// What the Phase 1 probe reports about a node.
#[derive(Debug, Clone, serde::Serialize)]
pub struct NodeProbe {
    pub user_agent: String,
    pub protocol_version: i32,
    pub services: u64,
    pub start_height: i32,
    /// Whether the peer advertises NODE_BLOOM — i.e. it will serve BIP37.
    pub serves_bloom: bool,
}

fn double_sha256(data: &[u8]) -> [u8; 32] {
    let first = Sha256::digest(data);
    let second = Sha256::digest(first);
    let mut out = [0u8; 32];
    out.copy_from_slice(&second);
    out
}

// ── CompactSize varint + fixed-width readers (all bounds-checked) ────────────

fn write_varint(buf: &mut Vec<u8>, n: u64) {
    if n < 0xfd {
        buf.push(n as u8);
    } else if n <= 0xffff {
        buf.push(0xfd);
        buf.extend_from_slice(&(n as u16).to_le_bytes());
    } else if n <= 0xffff_ffff {
        buf.push(0xfe);
        buf.extend_from_slice(&(n as u32).to_le_bytes());
    } else {
        buf.push(0xff);
        buf.extend_from_slice(&n.to_le_bytes());
    }
}

fn write_varstr(buf: &mut Vec<u8>, s: &[u8]) {
    write_varint(buf, s.len() as u64);
    buf.extend_from_slice(s);
}

fn take<'a>(data: &'a [u8], pos: &mut usize, n: usize) -> Result<&'a [u8], String> {
    let end = pos.checked_add(n).ok_or("length overflow")?;
    let slice = data.get(*pos..end).ok_or("truncated message")?;
    *pos = end;
    Ok(slice)
}

fn read_u16(data: &[u8], pos: &mut usize) -> Result<u16, String> {
    let b = take(data, pos, 2)?;
    Ok(u16::from_le_bytes([b[0], b[1]]))
}
fn read_u32(data: &[u8], pos: &mut usize) -> Result<u32, String> {
    let b = take(data, pos, 4)?;
    Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}
fn read_u64(data: &[u8], pos: &mut usize) -> Result<u64, String> {
    let b = take(data, pos, 8)?;
    Ok(u64::from_le_bytes(b.try_into().unwrap()))
}
fn read_i32(data: &[u8], pos: &mut usize) -> Result<i32, String> {
    Ok(read_u32(data, pos)? as i32)
}
fn read_i64(data: &[u8], pos: &mut usize) -> Result<i64, String> {
    Ok(read_u64(data, pos)? as i64)
}

fn read_varint(data: &[u8], pos: &mut usize) -> Result<u64, String> {
    let first = *take(data, pos, 1)?.first().unwrap();
    Ok(match first {
        0xff => read_u64(data, pos)?,
        0xfe => read_u32(data, pos)? as u64,
        0xfd => read_u16(data, pos)? as u64,
        n => n as u64,
    })
}

// ── Message framing ──────────────────────────────────────────────────────────

/// Frame one message: magic ++ 12-byte command ++ LE length ++ 4-byte checksum
/// ++ payload. `command` must be <= 12 ASCII bytes.
fn encode_message(magic: [u8; 4], command: &str, payload: &[u8]) -> Vec<u8> {
    let mut cmd = [0u8; 12];
    let bytes = command.as_bytes();
    let n = bytes.len().min(12);
    cmd[..n].copy_from_slice(&bytes[..n]);

    let checksum = double_sha256(payload);
    let mut msg = Vec::with_capacity(24 + payload.len());
    msg.extend_from_slice(&magic);
    msg.extend_from_slice(&cmd);
    msg.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    msg.extend_from_slice(&checksum[..4]);
    msg.extend_from_slice(payload);
    msg
}

/// Read one framed message, validating magic, the length bound, and the
/// checksum before returning (command, payload).
async fn read_message<S>(stream: &mut S, magic: [u8; 4]) -> Result<(String, Vec<u8>), String>
where
    S: AsyncReadExt + Unpin,
{
    let mut header = [0u8; 24];
    tokio::time::timeout(IO_TIMEOUT, stream.read_exact(&mut header))
        .await
        .map_err(|_| "timed out waiting for node message header".to_string())?
        .map_err(|e| format!("read failed: {e}"))?;

    if header[..4] != magic {
        return Err("bad network magic — wrong network or not a BCH node".into());
    }
    let end = header[4..16].iter().position(|&b| b == 0).unwrap_or(12);
    let command = String::from_utf8_lossy(&header[4..4 + end]).into_owned();
    let len = u32::from_le_bytes([header[16], header[17], header[18], header[19]]) as usize;
    if len > MAX_PAYLOAD {
        return Err(format!("node message too large: {len} > {MAX_PAYLOAD}"));
    }
    let expected = &header[20..24];

    let mut payload = vec![0u8; len];
    tokio::time::timeout(IO_TIMEOUT, stream.read_exact(&mut payload))
        .await
        .map_err(|_| "timed out reading node message body".to_string())?
        .map_err(|e| format!("read failed: {e}"))?;

    if &double_sha256(&payload)[..4] != expected {
        return Err(format!("bad checksum on '{command}' message"));
    }
    Ok((command, payload))
}

/// Build our `version` payload. addr_recv/addr_from are left zeroed (permitted);
/// relay=0 asks the peer not to flood us with txs before a filter is loaded.
fn build_version_payload(start_height: i32) -> Vec<u8> {
    let mut p = Vec::with_capacity(90);
    p.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    p.extend_from_slice(&0u64.to_le_bytes()); // our services: none (SPV client)
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    p.extend_from_slice(&ts.to_le_bytes());
    p.extend_from_slice(&[0u8; 26]); // addr_recv (services + ip + port)
    p.extend_from_slice(&[0u8; 26]); // addr_from
    p.extend_from_slice(&nonce().to_le_bytes());
    write_varstr(&mut p, USER_AGENT.as_bytes());
    p.extend_from_slice(&start_height.to_le_bytes());
    p.push(0x00); // relay
    p
}

/// Parse a peer's `version` payload into a NodeProbe.
fn parse_version_payload(payload: &[u8]) -> Result<NodeProbe, String> {
    let mut pos = 0usize;
    let protocol_version = read_i32(payload, &mut pos)?;
    let services = read_u64(payload, &mut pos)?;
    let _timestamp = read_i64(payload, &mut pos)?;
    take(payload, &mut pos, 26)?; // addr_recv
    take(payload, &mut pos, 26)?; // addr_from
    let _nonce = read_u64(payload, &mut pos)?;
    let ua_len = read_varint(payload, &mut pos)? as usize;
    let ua = take(payload, &mut pos, ua_len)?;
    let user_agent = String::from_utf8_lossy(ua).into_owned();
    let start_height = read_i32(payload, &mut pos)?;
    Ok(NodeProbe {
        user_agent,
        protocol_version,
        services,
        start_height,
        serves_bloom: services & NODE_BLOOM != 0,
    })
}

/// Send our version, read until the peer's version arrives (skipping any
/// pre-version chatter), ack with verack, and return the parsed parameters.
/// Split from connection setup so it can be tested over an in-memory duplex.
async fn handshake<S>(stream: &mut S, magic: [u8; 4]) -> Result<NodeProbe, String>
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    let version = encode_message(magic, "version", &build_version_payload(0));
    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&version))
        .await
        .map_err(|_| "timed out sending version".to_string())?
        .map_err(|e| format!("send failed: {e}"))?;

    // Bound the loop so a peer that never sends a version can't spin us forever.
    for _ in 0..20 {
        let (command, payload) = read_message(stream, magic).await?;
        if command == "version" {
            let probe = parse_version_payload(&payload)?;
            let verack = encode_message(magic, "verack", &[]);
            let _ = stream.write_all(&verack).await;
            return Ok(probe);
        }
        // Ignore anything the peer volunteers before its version.
    }
    Err("node did not send a version message".into())
}

/// Connect to a BCH full node, complete the handshake, and report its
/// parameters. Opens a fresh connection and drops it; holds no state.
///
/// `Transport::Tor` dials the node through the SOCKS5 proxy with a fresh
/// isolation token (own circuit); LAN/localhost callers pass `Direct`.
pub async fn probe_node(
    host: &str,
    port: u16,
    network: &str,
    transport: Transport<'_>,
) -> Result<NodeProbe, String> {
    let magic = params_for(network).magic;
    let mut stream = match transport {
        Transport::Direct => {
            tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
                .await
                .map_err(|_| format!("timed out connecting to {host}:{port}"))?
                .map_err(|e| format!("could not connect to {host}:{port}: {e}"))?
        }
        Transport::Tor { host: ph, port: pp } => {
            let token = format!("optn-node-{}", nonce());
            tokio::time::timeout(CONNECT_TIMEOUT, tor::connect_via_tor(ph, pp, host, port, &token))
                .await
                .map_err(|_| format!("timed out connecting to {host}:{port} over Tor"))??
        }
    };
    handshake(&mut stream, magic).await
}

/// Distinct-per-connection nonce (Tor circuit isolation + version nonce). Only
/// needs to be distinct, not unpredictable — a counter plus the clock suffices.
fn nonce() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    nanos ^ (n.wrapping_mul(0x9e37_79b9_7f4a_7c15))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mainnet_magic_matches_bchn() {
        assert_eq!(params_for("mainnet").magic, [0xe3, 0xe1, 0xf3, 0xe8]);
        assert_eq!(params_for("mainnet").default_port, 8333);
        // testnet4 and chipnet share magic, differ by port.
        assert_eq!(params_for("chipnet").magic, params_for("testnet4").magic);
        assert_eq!(params_for("chipnet").default_port, 48333);
        assert_eq!(params_for("testnet4").default_port, 28333);
    }

    #[test]
    fn header_has_length_and_double_sha256_checksum() {
        let payload = b"hello";
        let magic = [0xe3, 0xe1, 0xf3, 0xe8];
        let msg = encode_message(magic, "version", payload);
        assert_eq!(&msg[..4], &magic);
        assert_eq!(&msg[4..11], b"version");
        assert_eq!(msg[11], 0); // null padding after the command
        assert_eq!(u32::from_le_bytes([msg[16], msg[17], msg[18], msg[19]]), 5);
        assert_eq!(&msg[20..24], &double_sha256(payload)[..4]);
        assert_eq!(&msg[24..], payload);
    }

    #[test]
    fn varint_round_trips_across_size_classes() {
        for n in [0u64, 0xfc, 0xfd, 0xffff, 0x1_0000, 0xffff_ffff, 0x1_0000_0000] {
            let mut buf = Vec::new();
            write_varint(&mut buf, n);
            let mut pos = 0;
            assert_eq!(read_varint(&buf, &mut pos).unwrap(), n);
            assert_eq!(pos, buf.len());
        }
    }

    #[test]
    fn version_payload_round_trips() {
        // Build a peer 'version' the way we build ours, then parse it back.
        let magic = [0xe3, 0xe1, 0xf3, 0xe8];
        let mut payload = build_version_payload(842_000);
        // Flip services to include NODE_BLOOM so serves_bloom is exercised.
        payload[4..12].copy_from_slice(&NODE_BLOOM.to_le_bytes());
        let probe = parse_version_payload(&payload).unwrap();
        assert_eq!(probe.protocol_version, PROTOCOL_VERSION);
        assert_eq!(probe.start_height, 842_000);
        assert_eq!(probe.user_agent, USER_AGENT);
        assert!(probe.serves_bloom);
        // And the whole thing frames/checksums cleanly.
        let framed = encode_message(magic, "version", &payload);
        assert_eq!(&framed[20..24], &double_sha256(&payload)[..4]);
    }

    #[test]
    fn handshake_parses_peer_version_and_sends_verack() {
        let magic = [0xe3, 0xe1, 0xf3, 0xe8];
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(4096);

            let server_task = tokio::spawn(async move {
                // Expect our version first.
                let (cmd, _) = read_message(&mut server, magic).await.unwrap();
                assert_eq!(cmd, "version");
                // Reply with a NODE_BLOOM version, then observe the verack.
                let mut vpayload = build_version_payload(101);
                vpayload[4..12].copy_from_slice(&NODE_BLOOM.to_le_bytes());
                let vmsg = encode_message(magic, "version", &vpayload);
                server.write_all(&vmsg).await.unwrap();
                let (ack, _) = read_message(&mut server, magic).await.unwrap();
                assert_eq!(ack, "verack");
            });

            let probe = handshake(&mut client, magic).await.unwrap();
            server_task.await.unwrap();
            assert_eq!(probe.start_height, 101);
            assert!(probe.serves_bloom);
        });
    }

    #[test]
    fn rejects_wrong_magic() {
        let magic = [0xe3, 0xe1, 0xf3, 0xe8];
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(64);
            // A message under a different network's magic must be refused.
            let junk = encode_message([0xda, 0xb5, 0xbf, 0xfa], "version", b"x");
            server.write_all(&junk).await.unwrap();
            let err = read_message(&mut client, magic).await.unwrap_err();
            assert!(err.contains("bad network magic"), "unexpected: {err}");
        });
    }

    /// Live probe against a public BCH mainnet node. Ignored by default (needs
    /// network + a reachable peer); run with:
    ///   OPTN_NODE_HOST=seed.bchd.cash cargo test -p optn-wallet-desktop \
    ///     spv::tests::live_probe_mainnet_node -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_probe_mainnet_node() {
        let host = std::env::var("OPTN_NODE_HOST").unwrap_or_else(|_| "seed.bchd.cash".to_string());
        let port: u16 = std::env::var("OPTN_NODE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8333);
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let probe = probe_node(&host, port, "mainnet", Transport::Direct)
                .await
                .expect("handshake failed");
            println!(
                "node {host}:{port} -> ua={:?} version={} height={} services={:#x} serves_bloom={}",
                probe.user_agent, probe.protocol_version, probe.start_height, probe.services, probe.serves_bloom
            );
            assert!(!probe.user_agent.is_empty(), "peer sent no user agent");
            assert!(probe.start_height > 0, "peer reported no block height");
        });
    }
}
