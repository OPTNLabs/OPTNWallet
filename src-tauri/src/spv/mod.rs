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

use optn_core::header_pow::verify_link;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::fusion::{tor, Transport};

pub mod bloom;
pub mod merkleblock;
pub mod tx;

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
        "chipnet" => NetworkParams {
            magic: [0xe2, 0xb7, 0xda, 0xaf],
            default_port: 48333,
        },
        "testnet4" => NetworkParams {
            magic: [0xe2, 0xb7, 0xda, 0xaf],
            default_port: 28333,
        },
        "testnet" | "testnet3" => NetworkParams {
            magic: [0xf4, 0xe5, 0xf3, 0xf4],
            default_port: 18333,
        },
        "regtest" => NetworkParams {
            magic: [0xda, 0xb5, 0xbf, 0xfa],
            default_port: 18444,
        },
        // "mainnet" and anything unrecognized.
        _ => NetworkParams {
            magic: [0xe3, 0xe1, 0xf3, 0xe8],
            default_port: 8333,
        },
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
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                tor::connect_via_tor(ph, pp, host, port, &token),
            )
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

// ── Phase 2: block-header chain sync ─────────────────────────────────────────
//
// After the handshake, request block headers with `getheaders` and validate the
// returned chain LINKS to our locator (each header's prev-block == the previous
// header's hash). A node returns up to 2000 headers per `headers` message, so a
// full sync-to-tip loops with an updated locator. Each returned header proves
// its own declared target and predecessor link; network-difficulty transitions
// and checkpoint authority remain separate validation concerns.

/// Chain start hash (double-SHA256 of the genesis header, internal little-endian
/// byte order — the form used on the wire and by header_hash). Used as the
/// first getheaders locator. testnet4/chipnet/regtest are added when their sync
/// lands; unknown networks fall back to mainnet's genesis.
pub fn genesis_hash(network: &str) -> [u8; 32] {
    match network {
        // testnet4 + chipnet share a genesis (chipnet forked from testnet4 later):
        // 000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b
        "chipnet" | "testnet4" => [
            0x7b, 0x9f, 0xfd, 0x44, 0xdd, 0x73, 0xc0, 0x5f, 0x2a, 0x15, 0xd3, 0x74, 0x74, 0x79,
            0xcc, 0x18, 0x17, 0x75, 0x26, 0xce, 0x68, 0x86, 0x78, 0x9a, 0xc4, 0x10, 0xd4, 0x1d,
            0x00, 0x00, 0x00, 0x00,
        ],
        "testnet" | "testnet3" => [
            0x43, 0x49, 0x7f, 0xd7, 0xf8, 0x26, 0x95, 0x71, 0x08, 0xf4, 0xa3, 0x0f, 0xd9, 0xce,
            0xc3, 0xae, 0xba, 0x79, 0x97, 0x20, 0x84, 0xe9, 0x0e, 0xad, 0x01, 0xea, 0x33, 0x09,
            0x00, 0x00, 0x00, 0x00,
        ],
        _ => [
            0x6f, 0xe2, 0x8c, 0x0a, 0xb6, 0xf1, 0xb3, 0x72, 0xc1, 0xa6, 0xa2, 0x46, 0xae, 0x63,
            0xf7, 0x4f, 0x93, 0x1e, 0x83, 0x65, 0xe1, 0x5a, 0x08, 0x9c, 0x68, 0xd6, 0x19, 0x00,
            0x00, 0x00, 0x00, 0x00,
        ],
    }
}

/// A validated block header: its hash + back-reference + timestamp + difficulty.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HeaderInfo {
    pub hash: String,      // big-endian hex (block-explorer display order)
    pub prev_hash: String, // big-endian hex
    pub time: u32,
    pub bits: u32,
}

/// Reverse internal little-endian hash bytes into big-endian display hex.
fn hex_be(hash_le: &[u8; 32]) -> String {
    hash_le.iter().rev().map(|b| format!("{b:02x}")).collect()
}

fn build_getheaders_payload(locator: &[u8; 32]) -> Vec<u8> {
    let mut p = Vec::with_capacity(4 + 1 + 32 + 32);
    p.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    write_varint(&mut p, 1); // one locator hash
    p.extend_from_slice(locator);
    p.extend_from_slice(&[0u8; 32]); // hash_stop = 0 → as many as possible
    p
}

/// Parse a `headers` payload: varint count, then each entry = 80-byte header +
/// varint tx_count (always 0 in a headers message). Returns the raw headers.
fn parse_headers_payload(payload: &[u8]) -> Result<Vec<[u8; 80]>, String> {
    let mut pos = 0usize;
    let count = read_varint(payload, &mut pos)? as usize;
    let mut out = Vec::with_capacity(count.min(4000));
    for _ in 0..count {
        let raw = take(payload, &mut pos, 80)?;
        let mut hdr = [0u8; 80];
        hdr.copy_from_slice(raw);
        out.push(hdr);
        let _txn = read_varint(payload, &mut pos)?; // 0 in a headers message
    }
    Ok(out)
}

/// Handshake, then request and validate one batch of headers after `locator`.
/// Split from connection setup so it can be exercised over an in-memory duplex.
async fn sync_headers_batch<S>(
    stream: &mut S,
    magic: [u8; 4],
    locator: [u8; 32],
) -> Result<Vec<HeaderInfo>, String>
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    handshake(stream, magic).await?;
    let msg = encode_message(magic, "getheaders", &build_getheaders_payload(&locator));
    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&msg))
        .await
        .map_err(|_| "timed out sending getheaders".to_string())?
        .map_err(|e| format!("send failed: {e}"))?;

    // Skip anything the node volunteers (verack/sendheaders/inv/…) until headers;
    // answer pings so it doesn't drop us. Bounded so a chatty peer can't loop us.
    let mut raws: Option<Vec<[u8; 80]>> = None;
    for _ in 0..50 {
        let (cmd, payload) = read_message(stream, magic).await?;
        match cmd.as_str() {
            "headers" => {
                raws = Some(parse_headers_payload(&payload)?);
                break;
            }
            "ping" => {
                let _ = stream
                    .write_all(&encode_message(magic, "pong", &payload))
                    .await;
            }
            _ => continue,
        }
    }
    let raws = raws.ok_or("node did not return headers")?;

    // Validate the declared proof of work and linkage: the first header links
    // to the locator, each subsequent header to the previous one.
    let mut expected_prev = locator;
    let mut out = Vec::with_capacity(raws.len());
    for raw in &raws {
        let parsed = verify_link(expected_prev, raw)
            .map_err(|error| format!("header proof check failed: {error:?}"))?;
        out.push(HeaderInfo {
            hash: hex_be(&parsed.hash),
            prev_hash: hex_be(&parsed.prev_hash),
            time: parsed.time,
            bits: parsed.bits,
        });
        expected_prev = parsed.hash;
    }
    Ok(out)
}

/// Connect, handshake, and fetch one validated batch of headers after `locator`.
pub async fn fetch_headers_after(
    host: &str,
    port: u16,
    network: &str,
    transport: Transport<'_>,
    locator: [u8; 32],
) -> Result<Vec<HeaderInfo>, String> {
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
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                tor::connect_via_tor(ph, pp, host, port, &token),
            )
            .await
            .map_err(|_| format!("timed out connecting to {host}:{port} over Tor"))??
        }
    };
    sync_headers_batch(&mut stream, magic, locator).await
}

// ── Phase 3c: filterload + merkleblock download ──────────────────────────────
//
// Upload the wallet's bloom filter (filterload), then request a block as a
// FILTERED block (getdata, inv type MSG_FILTERED_BLOCK=3). The node replies with
// a `merkleblock` (verified by spv::merkleblock) plus a `tx` for each match.
// Phase 3c wires the download + verification; extracting UTXOs from the matched
// txs and driving a whole birth-height..tip scan is Phase 3d.

const MSG_FILTERED_BLOCK: u32 = 3;

fn build_getdata_filtered_block(block_hash: &[u8; 32]) -> Vec<u8> {
    let mut p = Vec::with_capacity(1 + 36);
    write_varint(&mut p, 1); // one inventory entry
    p.extend_from_slice(&MSG_FILTERED_BLOCK.to_le_bytes());
    p.extend_from_slice(block_hash);
    p
}

/// Handshake, load `filter`, request `block_hash` as a merkleblock, and return
/// the verified partial merkle tree (matched txids + validity).
async fn request_filtered_block<S>(
    stream: &mut S,
    magic: [u8; 4],
    block_hash: [u8; 32],
    filter: &bloom::BloomFilter,
) -> Result<merkleblock::MerkleBlock, String>
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    handshake(stream, magic).await?;

    let fl = encode_message(
        magic,
        "filterload",
        &filter.to_filterload_payload(bloom::BLOOM_UPDATE_ALL),
    );
    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&fl))
        .await
        .map_err(|_| "timed out sending filterload".to_string())?
        .map_err(|e| format!("send failed: {e}"))?;

    let gd = encode_message(magic, "getdata", &build_getdata_filtered_block(&block_hash));
    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&gd))
        .await
        .map_err(|_| "timed out sending getdata".to_string())?
        .map_err(|e| format!("send failed: {e}"))?;

    // Wait for the merkleblock, answering pings and ignoring other messages
    // (verack/sendheaders/inv/tx/…). Bounded so a peer can't loop us forever.
    for _ in 0..100 {
        let (cmd, payload) = read_message(stream, magic).await?;
        match cmd.as_str() {
            "merkleblock" => return merkleblock::parse_merkleblock(&payload),
            "ping" => {
                let _ = stream
                    .write_all(&encode_message(magic, "pong", &payload))
                    .await;
            }
            _ => continue,
        }
    }
    Err("node did not return a merkleblock".into())
}

/// Connect, load a bloom filter, and fetch one block as a verified merkleblock.
pub async fn scan_block(
    host: &str,
    port: u16,
    network: &str,
    transport: Transport<'_>,
    block_hash: [u8; 32],
    filter: &bloom::BloomFilter,
) -> Result<merkleblock::MerkleBlock, String> {
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
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                tor::connect_via_tor(ph, pp, host, port, &token),
            )
            .await
            .map_err(|_| format!("timed out connecting to {host}:{port} over Tor"))??
        }
    };
    request_filtered_block(&mut stream, magic, block_hash, filter).await
}

// ── Phase 3d driver: scan a block range into a UTXO delta ────────────────────
//
// Over ONE connection: filterload the wallet's scripts, then for each block send
// getdata(filtered block), verify the merkleblock, read its matched `tx`
// messages, and fold them through tx::match_tx. The caller applies the deltas to
// a persistent UTXO/history index and advances its sync height.

/// Owned output found while scanning: (txid display-hex, vout, value, pkh).
pub type OwnedUtxo = (String, u32, u64, [u8; 20]);

#[derive(Default, serde::Serialize)]
pub struct ScanResult {
    pub scanned_blocks: usize,
    /// New outputs paying the wallet.
    pub owned: Vec<OwnedUtxo>,
    /// Outpoints spent by scanned txs: (prev-txid display-hex, prev-vout).
    pub spent: Vec<(String, u32)>,
}

fn txid_hex(internal_le: &[u8; 32]) -> String {
    internal_le
        .iter()
        .rev()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Scan `block_hashes` (internal LE) for outputs/inputs touching `watched`.
pub async fn scan_blocks(
    host: &str,
    port: u16,
    network: &str,
    transport: Transport<'_>,
    block_hashes: &[[u8; 32]],
    watched: &std::collections::HashSet<[u8; 20]>,
) -> Result<ScanResult, String> {
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
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                tor::connect_via_tor(ph, pp, host, port, &token),
            )
            .await
            .map_err(|_| format!("timed out connecting to {host}:{port} over Tor"))??
        }
    };

    handshake(&mut stream, magic).await?;

    // Filter over the watched pubkey-hashes (BLOOM_UPDATE_ALL). Extra capacity
    // keeps the false-positive rate low; a random tweak avoids fingerprinting.
    let mut filter = bloom::BloomFilter::new((watched.len().max(1)) * 2, 0.0001, nonce() as u32);
    for h in watched {
        filter.insert(h);
    }
    let fl = encode_message(
        magic,
        "filterload",
        &filter.to_filterload_payload(bloom::BLOOM_UPDATE_ALL),
    );
    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&fl))
        .await
        .map_err(|_| "timed out sending filterload".to_string())?
        .map_err(|e| format!("send failed: {e}"))?;

    let mut result = ScanResult::default();
    for block_hash in block_hashes {
        let gd = encode_message(magic, "getdata", &build_getdata_filtered_block(block_hash));
        tokio::time::timeout(IO_TIMEOUT, stream.write_all(&gd))
            .await
            .map_err(|_| "timed out sending getdata".to_string())?
            .map_err(|e| format!("send failed: {e}"))?;

        // Read the merkleblock, then exactly its matched-tx count of `tx`
        // messages (some may be bloom false positives — match_tx filters those).
        let mut expected: Option<usize> = None;
        let mut got_txs = 0usize;
        for _ in 0..1000 {
            let (cmd, payload) = read_message(&mut stream, magic).await?;
            match cmd.as_str() {
                "merkleblock" => {
                    let mb = merkleblock::parse_merkleblock(&payload)?;
                    if !mb.valid {
                        return Err("merkleblock failed verification during scan".into());
                    }
                    expected = Some(mb.matched_txids.len());
                }
                "tx" => {
                    let t = tx::parse_tx(&payload)?;
                    let m = tx::match_tx(&t, watched);
                    for (vout, value, pkh) in m.owned_outputs {
                        result.owned.push((txid_hex(&t.txid), vout, value, pkh));
                    }
                    for (prev, vout) in m.spent_outpoints {
                        result.spent.push((txid_hex(&prev), vout));
                    }
                    got_txs += 1;
                }
                "ping" => {
                    let _ = stream
                        .write_all(&encode_message(magic, "pong", &payload))
                        .await;
                }
                _ => {}
            }
            if let Some(n) = expected {
                if got_txs >= n {
                    break;
                }
            }
        }
        result.scanned_blocks += 1;
    }
    Ok(result)
}

// ── Broadcast: announce a signed tx to the node over P2P ─────────────────────
//
// Standard relay handshake: send inv(MSG_TX, txid); the node replies getdata for
// the tx if it wants it; we then send the raw `tx`. Returns the txid. A `reject`
// (BIP61) reply surfaces as an error. This is the node write-path — the wallet's
// broadcastTransaction when a node is the active backend.

const MSG_TX: u32 = 1;
const RELAY_RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
const OBSERVER_RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RELAY_MESSAGES: usize = 30;

fn build_inv_tx(txid_internal: &[u8; 32]) -> Vec<u8> {
    let mut p = Vec::with_capacity(1 + 36);
    write_varint(&mut p, 1);
    p.extend_from_slice(&MSG_TX.to_le_bytes());
    p.extend_from_slice(txid_internal);
    p
}

fn txid_display(txid_internal: &[u8; 32]) -> String {
    txid_internal
        .iter()
        .rev()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn inventory_contains_tx(payload: &[u8], expected_txid: &[u8; 32]) -> Result<bool, String> {
    let mut pos = 0usize;
    let count = read_varint(payload, &mut pos)?;
    let max_entries = (MAX_PAYLOAD / 36) as u64;
    if count > max_entries {
        return Err(format!("inventory contains too many entries: {count}"));
    }

    let mut found = false;
    for _ in 0..count {
        let inventory_type = read_u32(payload, &mut pos)?;
        let hash = take(payload, &mut pos, 32)?;
        if inventory_type == MSG_TX && hash == expected_txid {
            found = true;
        }
    }
    if pos != payload.len() {
        return Err("trailing bytes in inventory message".into());
    }
    Ok(found)
}

async fn connect_peer(
    host: &str,
    port: u16,
    transport: Transport<'_>,
) -> Result<TcpStream, String> {
    match transport {
        Transport::Direct => {
            tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
                .await
                .map_err(|_| format!("timed out connecting to {host}:{port}"))?
                .map_err(|e| format!("could not connect to {host}:{port}: {e}"))
        }
        Transport::Tor { host: ph, port: pp } => {
            let token = format!("optn-node-{}", nonce());
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                tor::connect_via_tor(ph, pp, host, port, &token),
            )
            .await
            .map_err(|_| format!("timed out connecting to {host}:{port} over Tor"))?
        }
    }
}

/// Announce `tx_bytes` and send them only if this peer requests the exact txid.
///
/// The stream is generic so the complete inv/getdata/tx exchange can be tested
/// over an in-memory duplex. `Ok(false)` means the bounded request window ended
/// without the peer asking for this transaction; an explicit reject is an error.
async fn relay_tx_on_stream<S>(
    stream: &mut S,
    magic: [u8; 4],
    tx_bytes: &[u8],
    expected_txid: [u8; 32],
) -> Result<bool, String>
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    let inv = encode_message(magic, "inv", &build_inv_tx(&expected_txid));
    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&inv))
        .await
        .map_err(|_| "timed out sending inv".to_string())?
        .map_err(|e| format!("send failed: {e}"))?;

    let exchange = async {
        for _ in 0..MAX_RELAY_MESSAGES {
            let (command, payload) = read_message(stream, magic).await?;
            match command.as_str() {
                "getdata" if inventory_contains_tx(&payload, &expected_txid)? => {
                    let tx_message = encode_message(magic, "tx", tx_bytes);
                    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&tx_message))
                        .await
                        .map_err(|_| "timed out sending tx".to_string())?
                        .map_err(|e| format!("send failed: {e}"))?;
                    return Ok(true);
                }
                "reject" => {
                    return Err(format!(
                        "relay rejected tx {}",
                        txid_display(&expected_txid)
                    ))
                }
                "ping" => {
                    let pong = encode_message(magic, "pong", &payload);
                    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&pong))
                        .await
                        .map_err(|_| "timed out sending pong".to_string())?
                        .map_err(|e| format!("send failed: {e}"))?;
                }
                _ => {}
            }
        }
        Ok(false)
    };

    match tokio::time::timeout(RELAY_RESPONSE_TIMEOUT, exchange).await {
        Ok(result) => result,
        Err(_) => Ok(false),
    }
}

/// Ask an independent peer for one exact transaction.
///
/// `Ok(true)` is returned only for a `tx` message whose double-SHA256 equals
/// `expected_txid`. A matching `notfound` or a bounded wait returns `Ok(false)`;
/// a peer-provided transaction with any other txid is rejected as an error.
async fn observe_tx_on_stream<S>(
    stream: &mut S,
    magic: [u8; 4],
    expected_txid: [u8; 32],
) -> Result<bool, String>
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    let getdata = encode_message(magic, "getdata", &build_inv_tx(&expected_txid));
    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&getdata))
        .await
        .map_err(|_| "timed out requesting transaction from observer".to_string())?
        .map_err(|e| format!("send failed: {e}"))?;

    let exchange = async {
        for _ in 0..MAX_RELAY_MESSAGES {
            let (command, payload) = read_message(stream, magic).await?;
            match command.as_str() {
                "tx" => {
                    if double_sha256(&payload) != expected_txid {
                        return Err(format!(
                            "observer returned mismatched transaction for {}",
                            txid_display(&expected_txid)
                        ));
                    }
                    return Ok(true);
                }
                "notfound" if inventory_contains_tx(&payload, &expected_txid)? => return Ok(false),
                "reject" => {
                    return Err(format!(
                        "observer rejected getdata for {}",
                        txid_display(&expected_txid)
                    ))
                }
                "ping" => {
                    let pong = encode_message(magic, "pong", &payload);
                    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&pong))
                        .await
                        .map_err(|_| "timed out sending pong".to_string())?
                        .map_err(|e| format!("send failed: {e}"))?;
                }
                _ => {}
            }
        }
        Ok(false)
    };

    match tokio::time::timeout(OBSERVER_RESPONSE_TIMEOUT, exchange).await {
        Ok(result) => result,
        Err(_) => Ok(false),
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionRelayObservation {
    pub txid: String,
    pub relay_submitted: bool,
    pub observer_seen: bool,
}

/// Relay a transaction to one peer, then require an independent peer to return
/// the exact raw transaction by txid. Both connections are established before
/// announcement; separate `Transport::Tor` dials receive distinct isolation
/// tokens in `connect_peer`.
#[allow(clippy::too_many_arguments)]
pub async fn relay_broadcast_and_observe(
    relay_host: &str,
    relay_port: u16,
    relay_transport: Transport<'_>,
    observer_host: &str,
    observer_port: u16,
    observer_transport: Transport<'_>,
    network: &str,
    tx_bytes: Vec<u8>,
) -> Result<FusionRelayObservation, String> {
    if tx_bytes.is_empty() {
        return Err("transaction must not be empty".into());
    }

    let magic = params_for(network).magic;
    let expected_txid = double_sha256(&tx_bytes);
    let display_txid = txid_display(&expected_txid);

    let mut observer = connect_peer(observer_host, observer_port, observer_transport).await?;
    handshake(&mut observer, magic).await?;
    let mut relay = connect_peer(relay_host, relay_port, relay_transport).await?;
    handshake(&mut relay, magic).await?;

    let relay_submitted = relay_tx_on_stream(&mut relay, magic, &tx_bytes, expected_txid).await?;
    // Do not hard-fail when the observer misses: CashFusion servers (and any
    // prior announcer) may already have flooded the network, so peers often
    // never re-echo our inv. Callers re-check with Electrum `is_known` — a
    // hard Err here made that fallback unreachable and burned ~25s of Tor
    // wait before the UI could finish a successful round.
    let observer_seen = observe_tx_on_stream(&mut observer, magic, expected_txid)
        .await
        .unwrap_or(false);

    Ok(FusionRelayObservation {
        txid: display_txid,
        relay_submitted,
        observer_seen,
    })
}

pub async fn broadcast_tx(
    host: &str,
    port: u16,
    network: &str,
    transport: Transport<'_>,
    tx_bytes: Vec<u8>,
) -> Result<String, String> {
    let magic = params_for(network).magic;
    let txid_internal = double_sha256(&tx_bytes);
    let display_txid = txid_display(&txid_internal);
    let mut stream = connect_peer(host, port, transport).await?;

    handshake(&mut stream, magic).await?;
    let _submitted = relay_tx_on_stream(&mut stream, magic, &tx_bytes, txid_internal).await?;
    // Preserve the original broadcast contract: no request within the bounded
    // window means the peer may already have the transaction.
    Ok(display_txid)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live: filterload + request block 1 as a merkleblock from a public node,
    /// and verify the partial merkle tree against its header.
    ///   OPTN_NODE_HOST=bch.imaginary.cash cargo test -p optn-wallet-desktop \
    ///     spv::tests::live_filtered_block1_verifies -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_filtered_block1_verifies() {
        let host =
            std::env::var("OPTN_NODE_HOST").unwrap_or_else(|_| "bch.imaginary.cash".to_string());
        let port: u16 = std::env::var("OPTN_NODE_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8333);
        // Block 1 hash: display (big-endian) -> internal (little-endian) for the inv.
        let display = "00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048";
        let mut h = [0u8; 32];
        for i in 0..32 {
            h[31 - i] = u8::from_str_radix(&display[i * 2..i * 2 + 2], 16).unwrap();
        }
        let filter = bloom::BloomFilter::new(1, 0.001, 0);
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let mb = scan_block(&host, port, "mainnet", Transport::Direct, h, &filter)
                .await
                .expect("merkleblock request failed");
            println!(
                "merkleblock valid={} matched={}",
                mb.valid,
                mb.matched_txids.len()
            );
            assert!(mb.valid, "merkleblock must verify against its header");
        });
    }

    /// Live: fetch the first block hashes, then scan 3 blocks with an empty
    /// watch set — exercises filterload + per-block merkleblock verification in
    /// the scan loop end to end. (Empty filter => 0 matched txs.)
    #[test]
    #[ignore]
    fn live_scan_first_blocks_mainnet() {
        let host =
            std::env::var("OPTN_NODE_HOST").unwrap_or_else(|_| "bch.imaginary.cash".to_string());
        let port: u16 = std::env::var("OPTN_NODE_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8333);
        let network = std::env::var("OPTN_NODE_NETWORK").unwrap_or_else(|_| "mainnet".to_string());
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let headers = fetch_headers_after(
                &host,
                port,
                &network,
                Transport::Direct,
                genesis_hash(&network),
            )
            .await
            .unwrap();
            let hashes: Vec<[u8; 32]> = headers
                .iter()
                .take(3)
                .map(|h| {
                    let mut b = [0u8; 32];
                    for i in 0..32 {
                        b[31 - i] = u8::from_str_radix(&h.hash[i * 2..i * 2 + 2], 16).unwrap();
                    }
                    b
                })
                .collect();
            let watched = std::collections::HashSet::new();
            let res = scan_blocks(&host, port, &network, Transport::Direct, &hashes, &watched)
                .await
                .unwrap();
            println!(
                "scanned {} blocks, owned {}",
                res.scanned_blocks,
                res.owned.len()
            );
            assert_eq!(res.scanned_blocks, 3);
        });
    }

    #[test]
    fn getheaders_payload_has_locator_and_zero_stop() {
        let loc = [7u8; 32];
        let p = build_getheaders_payload(&loc);
        assert_eq!(p.len(), 4 + 1 + 32 + 32);
        assert_eq!(p[4], 1); // one locator hash
        assert_eq!(&p[5..37], &loc);
        assert_eq!(&p[37..69], &[0u8; 32]); // hash_stop = 0
    }

    fn mainnet_genesis_header() -> [u8; 80] {
        let hex = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
        (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
            .collect::<Vec<_>>()
            .try_into()
            .unwrap()
    }

    fn headers_payload(raw: [u8; 80]) -> Vec<u8> {
        let mut payload = Vec::with_capacity(82);
        write_varint(&mut payload, 1);
        payload.extend_from_slice(&raw);
        write_varint(&mut payload, 0);
        payload
    }

    async fn sync_one_header(raw: [u8; 80], locator: [u8; 32]) -> Result<Vec<HeaderInfo>, String> {
        let magic = params_for("mainnet").magic;
        let (mut client, mut server) = tokio::io::duplex(4096);
        let server_task = tokio::spawn(async move {
            let (command, _) = read_message(&mut server, magic).await.unwrap();
            assert_eq!(command, "version");
            server
                .write_all(&encode_message(magic, "version", &build_version_payload(1)))
                .await
                .unwrap();
            let (command, _) = read_message(&mut server, magic).await.unwrap();
            assert_eq!(command, "verack");
            let (command, payload) = read_message(&mut server, magic).await.unwrap();
            assert_eq!(command, "getheaders");
            assert_eq!(payload, build_getheaders_payload(&locator));
            server
                .write_all(&encode_message(magic, "headers", &headers_payload(raw)))
                .await
                .unwrap();
        });

        let result = sync_headers_batch(&mut client, magic, locator).await;
        server_task.await.unwrap();
        result
    }

    #[tokio::test]
    async fn header_batch_accepts_linked_declared_pow() {
        let headers = sync_one_header(mainnet_genesis_header(), [0; 32])
            .await
            .unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(
            headers[0].hash,
            "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
        );
    }

    #[tokio::test]
    async fn header_batch_rejects_insufficient_work() {
        let mut header = mainnet_genesis_header();
        header[72..76].copy_from_slice(&0x0300_0001u32.to_le_bytes());
        let error = sync_one_header(header, [0; 32]).await.unwrap_err();
        assert!(error.contains("InsufficientWork"), "{error}");
    }

    #[tokio::test]
    async fn header_batch_rejects_invalid_target() {
        let mut header = mainnet_genesis_header();
        header[72..76].copy_from_slice(&0x1d80_ffffu32.to_le_bytes());
        let error = sync_one_header(header, [0; 32]).await.unwrap_err();
        assert!(error.contains("NegativeTarget"), "{error}");
    }

    #[tokio::test]
    async fn header_batch_rejects_wrong_locator() {
        let error = sync_one_header(mainnet_genesis_header(), [1; 32])
            .await
            .unwrap_err();
        assert!(error.contains("LinkMismatch"), "{error}");
    }

    #[test]
    fn inv_tx_payload_shape() {
        let txid = [0xabu8; 32];
        let p = build_inv_tx(&txid);
        assert_eq!(p.len(), 1 + 4 + 32);
        assert_eq!(p[0], 1); // one inventory entry
        assert_eq!(&p[1..5], &MSG_TX.to_le_bytes()); // type = MSG_TX
        assert_eq!(&p[5..37], &txid);
    }

    fn three_byte_txid() -> [u8; 32] {
        [
            0x19, 0xc6, 0x19, 0x7e, 0x21, 0x40, 0xb9, 0xd0, 0x34, 0xfb, 0x20, 0xb9, 0xac, 0x7b,
            0xb7, 0x53, 0xa4, 0x12, 0x33, 0xca, 0xf1, 0xe1, 0xda, 0xfd, 0xa7, 0x31, 0x6a, 0x99,
            0xce, 0xf4, 0x14, 0x16,
        ]
    }

    #[test]
    fn relay_announces_and_sends_only_after_exact_request() {
        let magic = params_for("mainnet").magic;
        let tx = vec![1u8, 2, 3];
        let expected_txid = three_byte_txid();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(4096);
            let expected_tx = tx.clone();
            let server_task = tokio::spawn(async move {
                let (command, payload) = read_message(&mut server, magic).await.unwrap();
                assert_eq!(command, "inv");
                assert_eq!(payload, build_inv_tx(&expected_txid));

                server
                    .write_all(&encode_message(
                        magic,
                        "getdata",
                        &build_inv_tx(&[0x55; 32]),
                    ))
                    .await
                    .unwrap();
                assert!(
                    tokio::time::timeout(
                        Duration::from_millis(25),
                        read_message(&mut server, magic)
                    )
                    .await
                    .is_err(),
                    "relay sent raw tx for an unrelated inventory request"
                );

                server
                    .write_all(&encode_message(
                        magic,
                        "getdata",
                        &build_inv_tx(&expected_txid),
                    ))
                    .await
                    .unwrap();
                let (command, payload) = read_message(&mut server, magic).await.unwrap();
                assert_eq!(command, "tx");
                assert_eq!(payload, expected_tx);
            });

            assert!(relay_tx_on_stream(&mut client, magic, &tx, expected_txid)
                .await
                .unwrap());
            server_task.await.unwrap();
        });
    }

    #[test]
    fn relay_explicit_reject_fails() {
        let magic = params_for("mainnet").magic;
        let tx = vec![1u8, 2, 3];
        let expected_txid = three_byte_txid();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(4096);
            let server_task = tokio::spawn(async move {
                let _ = read_message(&mut server, magic).await.unwrap();
                server
                    .write_all(&encode_message(magic, "reject", &[]))
                    .await
                    .unwrap();
            });

            let err = relay_tx_on_stream(&mut client, magic, &tx, expected_txid)
                .await
                .unwrap_err();
            server_task.await.unwrap();
            assert!(err.contains("rejected"), "unexpected error: {err}");
        });
    }

    #[test]
    fn observer_accepts_only_the_exact_transaction() {
        let magic = params_for("mainnet").magic;
        let expected_txid = three_byte_txid();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(4096);
            let server_task = tokio::spawn(async move {
                let (command, payload) = read_message(&mut server, magic).await.unwrap();
                assert_eq!(command, "getdata");
                assert_eq!(payload, build_inv_tx(&expected_txid));
                server
                    .write_all(&encode_message(magic, "tx", &[1, 2, 3]))
                    .await
                    .unwrap();
            });

            assert!(observe_tx_on_stream(&mut client, magic, expected_txid)
                .await
                .unwrap());
            server_task.await.unwrap();
        });
    }

    #[test]
    fn observer_rejects_a_mismatched_transaction() {
        let magic = params_for("mainnet").magic;
        let expected_txid = three_byte_txid();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(4096);
            let server_task = tokio::spawn(async move {
                let _ = read_message(&mut server, magic).await.unwrap();
                server
                    .write_all(&encode_message(magic, "tx", &[4, 5, 6]))
                    .await
                    .unwrap();
            });

            let err = observe_tx_on_stream(&mut client, magic, expected_txid)
                .await
                .unwrap_err();
            server_task.await.unwrap();
            assert!(err.contains("mismatched"), "unexpected error: {err}");
        });
    }

    #[test]
    fn observer_notfound_is_false() {
        let magic = params_for("mainnet").magic;
        let expected_txid = three_byte_txid();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut client, mut server) = tokio::io::duplex(4096);
            let server_task = tokio::spawn(async move {
                let _ = read_message(&mut server, magic).await.unwrap();
                server
                    .write_all(&encode_message(
                        magic,
                        "notfound",
                        &build_inv_tx(&expected_txid),
                    ))
                    .await
                    .unwrap();
            });

            assert!(!observe_tx_on_stream(&mut client, magic, expected_txid)
                .await
                .unwrap());
            server_task.await.unwrap();
        });
    }

    /// Live: sync the first header batch after genesis from a public mainnet
    /// node and prove parse + chain linkage (block 1's hash is well-known).
    ///   OPTN_NODE_HOST=seed.bch.loping.net cargo test -p optn-wallet-desktop \
    ///     spv::tests::live_sync_first_headers_mainnet -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_sync_first_headers_mainnet() {
        let host =
            std::env::var("OPTN_NODE_HOST").unwrap_or_else(|_| "seed.bch.loping.net".to_string());
        let port: u16 = std::env::var("OPTN_NODE_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8333);
        let network = std::env::var("OPTN_NODE_NETWORK").unwrap_or_else(|_| "mainnet".to_string());
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let headers = fetch_headers_after(
                &host,
                port,
                &network,
                Transport::Direct,
                genesis_hash(&network),
            )
            .await
            .expect("header sync failed");
            println!(
                "synced {} headers on {}; first={}",
                headers.len(),
                network,
                headers.first().map(|h| h.hash.as_str()).unwrap_or("-")
            );
            assert!(headers.len() > 1, "expected a batch of headers");
            // Chain linkage back to the genesis locator is validated inside
            // fetch_headers_after; on mainnet also pin block 1's known hash.
            if network == "mainnet" {
                assert_eq!(
                    headers[0].hash,
                    "00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048"
                );
            }
        });
    }

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
        for n in [
            0u64,
            0xfc,
            0xfd,
            0xffff,
            0x1_0000,
            0xffff_ffff,
            0x1_0000_0000,
        ] {
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
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
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
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
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
        let port: u16 = std::env::var("OPTN_NODE_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8333);
        // Network magic must match the peer's chain, else it drops us (early eof).
        let network = std::env::var("OPTN_NODE_NETWORK").unwrap_or_else(|_| "mainnet".to_string());
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let probe = probe_node(&host, port, &network, Transport::Direct)
                .await
                .expect("handshake failed");
            println!(
                "node {host}:{port} -> ua={:?} version={} height={} services={:#x} serves_bloom={}",
                probe.user_agent,
                probe.protocol_version,
                probe.start_height,
                probe.services,
                probe.serves_bloom
            );
            assert!(!probe.user_agent.is_empty(), "peer sent no user agent");
            assert!(probe.start_height > 0, "peer reported no block height");
        });
    }
}
