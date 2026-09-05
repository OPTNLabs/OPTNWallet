#![forbid(unsafe_code)]

//! Portable BCH P2P/BIP37 provider extracted from the legacy Tauri SPV engine.
//! Network sessions/cache are provider state; authoritative wallet state stays
//! in `optn-runtime`.

pub mod bloom;
pub mod merkleblock;
pub mod tx;

use bloom::{BloomFilter, BLOOM_UPDATE_ALL};
use optn_runtime::chain::{
    Capability, CapabilityConfidence, CapabilityDiscovery, CapabilitySet, Endpoint, EndpointKind,
    Evidence, ProtocolFamily, ProviderHealth, SourceId,
};
use optn_runtime::chain_service::{
    BackendObservation, ChainBackend, ChainBackendError, ChainFuture, ChainOperation, ChainPayload,
    ChainRequest, ChainTip, ObservedTransaction, WalletInterest,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

const PROTOCOL_VERSION: i32 = 70015;
const NODE_BLOOM: u64 = 1 << 2;
const USER_AGENT: &str = "/OPTNWallet:1.0/";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(15);
const RELAY_RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PAYLOAD: usize = 2 * 1024 * 1024;
const MAX_MESSAGES: usize = 1000;
const MSG_TX: u32 = 1;
const MSG_FILTERED_BLOCK: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetworkParams {
    pub magic: [u8; 4],
    pub default_port: u16,
}

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
        _ => NetworkParams {
            magic: [0xe3, 0xe1, 0xf3, 0xe8],
            default_port: 8333,
        },
    }
}

pub fn genesis_hash(network: &str) -> [u8; 32] {
    match network {
        "chipnet" | "testnet4" => [
            0x7b, 0x9f, 0xfd, 0x44, 0xdd, 0x73, 0xc0, 0x5f, 0x2a, 0x15, 0xd3, 0x74, 0x74, 0x79,
            0xcc, 0x18, 0x17, 0x75, 0x26, 0xce, 0x68, 0x86, 0x78, 0x9a, 0xc4, 0x10, 0xd4, 0x1d, 0,
            0, 0, 0,
        ],
        "testnet" | "testnet3" => [
            0x43, 0x49, 0x7f, 0xd7, 0xf8, 0x26, 0x95, 0x71, 0x08, 0xf4, 0xa3, 0x0f, 0xd9, 0xce,
            0xc3, 0xae, 0xba, 0x79, 0x97, 0x20, 0x84, 0xe9, 0x0e, 0xad, 0x01, 0xea, 0x33, 0x09, 0,
            0, 0, 0,
        ],
        _ => [
            0x6f, 0xe2, 0x8c, 0x0a, 0xb6, 0xf1, 0xb3, 0x72, 0xc1, 0xa6, 0xa2, 0x46, 0xae, 0x63,
            0xf7, 0x4f, 0x93, 0x1e, 0x83, 0x65, 0xe1, 0x5a, 0x08, 0x9c, 0x68, 0xd6, 0x19, 0, 0, 0,
            0, 0,
        ],
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bip37Transport {
    Direct,
    Tor { proxy_host: String, proxy_port: u16 },
}

#[derive(Debug, Clone)]
pub struct Bip37Config {
    pub source_id: SourceId,
    pub endpoint: Endpoint,
    pub network: String,
    pub transport: Bip37Transport,
}

impl Bip37Config {
    pub fn new(source_id: SourceId, endpoint: Endpoint, network: impl Into<String>) -> Self {
        Self {
            source_id,
            endpoint,
            network: network.into(),
            transport: Bip37Transport::Direct,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NodeProbe {
    pub user_agent: String,
    pub protocol_version: i32,
    pub services: u64,
    pub start_height: i32,
    pub serves_bloom: bool,
}

#[derive(Default)]
struct HeaderCache {
    by_height: BTreeMap<u32, [u8; 32]>,
}

pub struct Bip37Backend {
    config: Bip37Config,
    capabilities: CapabilitySet,
    probe: NodeProbe,
    headers: Mutex<HeaderCache>,
}

impl Bip37Backend {
    pub async fn connect(config: Bip37Config) -> Result<Self, ChainBackendError> {
        if config.endpoint.kind != EndpointKind::BchP2p {
            return Err(ChainBackendError::Rejected(
                "BIP37 requires a BCH P2P endpoint".into(),
            ));
        }
        let port = config
            .endpoint
            .port
            .unwrap_or_else(|| params_for(&config.network).default_port);
        let probe = probe_node(
            &config.endpoint.host,
            port,
            &config.network,
            &config.transport,
        )
        .await
        .map_err(ChainBackendError::Protocol)?;
        let mut capabilities = CapabilitySet::default();
        capabilities.record(
            Capability::HeaderStream,
            CapabilityConfidence::Advertised,
            CapabilityDiscovery::ActiveProbe,
        );
        capabilities.record(
            Capability::Broadcast,
            CapabilityConfidence::Advertised,
            CapabilityDiscovery::ActiveProbe,
        );
        if probe.serves_bloom {
            let discovery = CapabilityDiscovery::P2pServiceBit {
                bit: NODE_BLOOM,
                name: "NODE_BLOOM".into(),
            };
            capabilities.record(
                Capability::Bip37BloomFiltering,
                CapabilityConfidence::Advertised,
                discovery.clone(),
            );
            capabilities.record(
                Capability::UtxoQuery,
                CapabilityConfidence::Advertised,
                discovery.clone(),
            );
            capabilities.record(
                Capability::TransactionMerkleProof,
                CapabilityConfidence::Advertised,
                discovery,
            );
        }
        let mut headers = HeaderCache::default();
        headers.by_height.insert(0, genesis_hash(&config.network));
        Ok(Self {
            config,
            capabilities,
            probe,
            headers: Mutex::new(headers),
        })
    }

    pub fn probe(&self) -> &NodeProbe {
        &self.probe
    }

    async fn header_sync(
        &self,
        start_height: u32,
        count: u32,
    ) -> Result<BackendObservation, ChainBackendError> {
        if start_height == 0 {
            return Err(ChainBackendError::Rejected(
                "BIP37 getheaders starts after a locator; request height 1 or later".into(),
            ));
        }
        let locator = self.headers.lock().await.by_height.get(&(start_height - 1)).copied().ok_or_else(|| ChainBackendError::Rejected("BIP37 header cursor is not cached; sync sequentially from the known checkpoint".into()))?;
        let port = self
            .config
            .endpoint
            .port
            .unwrap_or_else(|| params_for(&self.config.network).default_port);
        let mut headers = fetch_headers_after_raw(
            &self.config.endpoint.host,
            port,
            &self.config.network,
            &self.config.transport,
            locator,
        )
        .await
        .map_err(ChainBackendError::Protocol)?;
        headers.truncate(count as usize);
        let mut cache = self.headers.lock().await;
        for (offset, header) in headers.iter().enumerate() {
            cache.by_height.insert(
                start_height.saturating_add(offset as u32),
                double_sha256(header),
            );
        }
        let last = headers.last().map(|header| {
            (
                start_height + headers.len() as u32 - 1,
                double_sha256(header),
            )
        });
        Ok(BackendObservation {
            payload: ChainPayload::Headers {
                start_height,
                headers,
            },
            evidence: last
                .map(|(height, block_hash)| Evidence::HeaderLinked { block_hash, height })
                .unwrap_or(Evidence::ServerAssertion),
            chain_tip: last,
        })
    }

    async fn wallet_refresh(
        &self,
        interests: &[WalletInterest],
        from_height: Option<u32>,
    ) -> Result<BackendObservation, ChainBackendError> {
        if !self.probe.serves_bloom {
            return Err(ChainBackendError::Unsupported);
        }
        let mut bloom_items = Vec::<Vec<u8>>::new();
        for interest in interests {
            match interest {
                WalletInterest::Script(script) => bloom_items.extend(script_push_items(script)),
                WalletInterest::Outpoint { .. } => {
                    if let Some(outpoint) = interest.serialized_outpoint() {
                        bloom_items.push(outpoint.to_vec());
                    }
                }
                WalletInterest::RpaPrefix(_) => {}
            }
        }
        if bloom_items.is_empty() {
            return Err(ChainBackendError::Rejected(
                "BIP37 refresh has no bloom-compatible wallet interests".into(),
            ));
        }
        let start = from_height.unwrap_or(1).max(1);
        let cache = self.headers.lock().await;
        let blocks = cache
            .by_height
            .range(start..)
            .map(|(height, hash)| (*height, *hash))
            .collect::<Vec<_>>();
        let tip = cache
            .by_height
            .iter()
            .next_back()
            .map(|(height, hash)| ChainTip {
                height: *height,
                hash: *hash,
            });
        drop(cache);
        if blocks.is_empty() {
            return Err(ChainBackendError::Rejected(
                "BIP37 has no cached headers in the requested range; header sync must run first"
                    .into(),
            ));
        }
        let port = self
            .config
            .endpoint
            .port
            .unwrap_or_else(|| params_for(&self.config.network).default_port);
        let transactions = scan_blocks_observed(
            &self.config.endpoint.host,
            port,
            &self.config.network,
            &self.config.transport,
            &blocks,
            &bloom_items,
        )
        .await
        .map_err(ChainBackendError::Protocol)?;
        let chain_tip = tip.as_ref().map(|tip| (tip.height, tip.hash));
        Ok(BackendObservation {
            payload: ChainPayload::WalletRefresh { transactions, tip },
            evidence: Evidence::ServerAssertion,
            chain_tip,
        })
    }

    async fn broadcast(
        &self,
        raw_tx: &[u8],
        txid: [u8; 32],
    ) -> Result<BackendObservation, ChainBackendError> {
        if raw_tx.is_empty() || double_sha256(raw_tx) != txid {
            return Err(ChainBackendError::Rejected(
                "broadcast txid does not match transaction bytes".into(),
            ));
        }
        let port = self
            .config
            .endpoint
            .port
            .unwrap_or_else(|| params_for(&self.config.network).default_port);
        let mut stream = connect_peer(&self.config.endpoint.host, port, &self.config.transport)
            .await
            .map_err(ChainBackendError::Protocol)?;
        let magic = params_for(&self.config.network).magic;
        handshake(&mut stream, magic)
            .await
            .map_err(ChainBackendError::Protocol)?;
        relay_tx_on_stream(&mut stream, magic, raw_tx, txid)
            .await
            .map_err(ChainBackendError::Protocol)?;
        Ok(BackendObservation {
            payload: ChainPayload::BroadcastObserved { txid },
            evidence: Evidence::ServerAssertion,
            chain_tip: None,
        })
    }
}

impl ChainBackend for Bip37Backend {
    fn source_id(&self) -> &SourceId {
        &self.config.source_id
    }
    fn protocol(&self) -> ProtocolFamily {
        ProtocolFamily::Bip37
    }
    fn endpoint(&self) -> Option<&Endpoint> {
        Some(&self.config.endpoint)
    }
    fn capabilities(&self) -> &CapabilitySet {
        &self.capabilities
    }
    fn health(&self) -> ProviderHealth {
        ProviderHealth::Healthy
    }
    fn supports(&self, operation: ChainOperation) -> bool {
        match operation {
            ChainOperation::WalletRefresh => self.capabilities.is_usable(Capability::UtxoQuery),
            ChainOperation::Broadcast | ChainOperation::HeaderSync => true,
            ChainOperation::TransactionLookup | ChainOperation::HistoricalHeaderProof => false,
        }
    }
    fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
        Box::pin(async move {
            match request {
                ChainRequest::WalletRefresh {
                    interests,
                    from_height,
                } => self.wallet_refresh(interests, *from_height).await,
                ChainRequest::Broadcast { raw_tx, txid } => self.broadcast(raw_tx, *txid).await,
                ChainRequest::HeaderSync {
                    start_height,
                    count,
                } => self.header_sync(*start_height, *count).await,
                ChainRequest::TransactionLookup { .. }
                | ChainRequest::HistoricalHeaderProof { .. } => Err(ChainBackendError::Unsupported),
            }
        })
    }
}

/// Extract pushed data from a locking script for BIP37. Standard P2PKH/P2SH,
/// P2PK and token-prefixed scripts therefore contribute the values the peer's
/// bloom matcher actually tests, rather than incorrectly hashing the whole script.
fn script_push_items(script: &[u8]) -> Vec<Vec<u8>> {
    let mut items = Vec::new();
    let mut pos = 0usize;
    while pos < script.len() {
        let op = script[pos];
        pos += 1;
        let len = match op {
            1..=75 => op as usize,
            0x4c => {
                if pos >= script.len() {
                    break;
                }
                let n = script[pos] as usize;
                pos += 1;
                n
            }
            0x4d => {
                if pos + 2 > script.len() {
                    break;
                }
                let n = u16::from_le_bytes([script[pos], script[pos + 1]]) as usize;
                pos += 2;
                n
            }
            0x4e => {
                if pos + 4 > script.len() {
                    break;
                }
                let n = u32::from_le_bytes(script[pos..pos + 4].try_into().unwrap()) as usize;
                pos += 4;
                n
            }
            _ => continue,
        };
        if pos.checked_add(len).is_none_or(|end| end > script.len()) {
            break;
        }
        items.push(script[pos..pos + len].to_vec());
        pos += len;
    }
    items
}

fn double_sha256(data: &[u8]) -> [u8; 32] {
    let first = Sha256::digest(data);
    let second = Sha256::digest(first);
    let mut out = [0u8; 32];
    out.copy_from_slice(&second);
    out
}
fn nonce() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    nanos ^ n.wrapping_mul(0x9e37_79b9_7f4a_7c15)
}
fn write_varint(buf: &mut Vec<u8>, n: u64) {
    if n < 0xfd {
        buf.push(n as u8)
    } else if n <= 0xffff {
        buf.push(0xfd);
        buf.extend_from_slice(&(n as u16).to_le_bytes())
    } else if n <= 0xffff_ffff {
        buf.push(0xfe);
        buf.extend_from_slice(&(n as u32).to_le_bytes())
    } else {
        buf.push(0xff);
        buf.extend_from_slice(&n.to_le_bytes())
    }
}
fn write_varstr(buf: &mut Vec<u8>, s: &[u8]) {
    write_varint(buf, s.len() as u64);
    buf.extend_from_slice(s)
}
fn take<'a>(data: &'a [u8], pos: &mut usize, n: usize) -> Result<&'a [u8], String> {
    let end = pos.checked_add(n).ok_or("length overflow")?;
    let slice = data.get(*pos..end).ok_or("truncated message")?;
    *pos = end;
    Ok(slice)
}
fn read_u32(data: &[u8], pos: &mut usize) -> Result<u32, String> {
    Ok(u32::from_le_bytes(take(data, pos, 4)?.try_into().unwrap()))
}
fn read_u64(data: &[u8], pos: &mut usize) -> Result<u64, String> {
    Ok(u64::from_le_bytes(take(data, pos, 8)?.try_into().unwrap()))
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
        0xfd => u16::from_le_bytes(take(data, pos, 2)?.try_into().unwrap()) as u64,
        n => n as u64,
    })
}

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
async fn read_message<S: AsyncReadExt + Unpin>(
    stream: &mut S,
    magic: [u8; 4],
) -> Result<(String, Vec<u8>), String> {
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
    let len = u32::from_le_bytes(header[16..20].try_into().unwrap()) as usize;
    if len > MAX_PAYLOAD {
        return Err(format!("node message too large: {len}"));
    }
    let mut payload = vec![0u8; len];
    tokio::time::timeout(IO_TIMEOUT, stream.read_exact(&mut payload))
        .await
        .map_err(|_| "timed out reading node message body".to_string())?
        .map_err(|e| format!("read failed: {e}"))?;
    if double_sha256(&payload)[..4] != header[20..24] {
        return Err(format!("bad checksum on '{command}' message"));
    }
    Ok((command, payload))
}
fn build_version_payload(start_height: i32) -> Vec<u8> {
    let mut p = Vec::with_capacity(90);
    p.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    p.extend_from_slice(&0u64.to_le_bytes());
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    p.extend_from_slice(&ts.to_le_bytes());
    p.extend_from_slice(&[0u8; 26]);
    p.extend_from_slice(&[0u8; 26]);
    p.extend_from_slice(&nonce().to_le_bytes());
    write_varstr(&mut p, USER_AGENT.as_bytes());
    p.extend_from_slice(&start_height.to_le_bytes());
    p.push(0);
    p
}
fn parse_version_payload(payload: &[u8]) -> Result<NodeProbe, String> {
    let mut pos = 0;
    let protocol_version = read_i32(payload, &mut pos)?;
    let services = read_u64(payload, &mut pos)?;
    let _ = read_i64(payload, &mut pos)?;
    take(payload, &mut pos, 26)?;
    take(payload, &mut pos, 26)?;
    let _ = read_u64(payload, &mut pos)?;
    let ua_len = read_varint(payload, &mut pos)? as usize;
    let user_agent = String::from_utf8_lossy(take(payload, &mut pos, ua_len)?).into_owned();
    let start_height = read_i32(payload, &mut pos)?;
    Ok(NodeProbe {
        user_agent,
        protocol_version,
        services,
        start_height,
        serves_bloom: services & NODE_BLOOM != 0,
    })
}
async fn handshake<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
    magic: [u8; 4],
) -> Result<NodeProbe, String> {
    stream
        .write_all(&encode_message(magic, "version", &build_version_payload(0)))
        .await
        .map_err(|e| format!("version send failed: {e}"))?;
    for _ in 0..20 {
        let (command, payload) = read_message(stream, magic).await?;
        if command == "version" {
            let probe = parse_version_payload(&payload)?;
            stream
                .write_all(&encode_message(magic, "verack", &[]))
                .await
                .map_err(|e| format!("verack failed: {e}"))?;
            return Ok(probe);
        }
    }
    Err("node did not send a version message".into())
}
async fn connect_peer(
    host: &str,
    port: u16,
    transport: &Bip37Transport,
) -> Result<TcpStream, String> {
    match transport {
        Bip37Transport::Direct => {
            tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
                .await
                .map_err(|_| format!("timed out connecting to {host}:{port}"))?
                .map_err(|e| format!("could not connect to {host}:{port}: {e}"))
        }
        Bip37Transport::Tor {
            proxy_host,
            proxy_port,
        } => {
            let token = format!("optn-node-{}", nonce());
            let proxy = format!("{proxy_host}:{proxy_port}");
            let target = format!("{host}:{port}");
            let socks = tokio::time::timeout(
                CONNECT_TIMEOUT,
                tokio_socks::tcp::Socks5Stream::connect_with_password(
                    proxy.as_str(),
                    target.as_str(),
                    &token,
                    &token,
                ),
            )
            .await
            .map_err(|_| format!("timed out connecting to {host}:{port} over Tor"))?
            .map_err(|e| format!("Tor connect failed: {e}"))?;
            Ok(socks.into_inner())
        }
    }
}
pub async fn probe_node(
    host: &str,
    port: u16,
    network: &str,
    transport: &Bip37Transport,
) -> Result<NodeProbe, String> {
    let mut stream = connect_peer(host, port, transport).await?;
    handshake(&mut stream, params_for(network).magic).await
}

fn build_getheaders_payload(locator: &[u8; 32]) -> Vec<u8> {
    let mut p = Vec::with_capacity(69);
    p.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    write_varint(&mut p, 1);
    p.extend_from_slice(locator);
    p.extend_from_slice(&[0u8; 32]);
    p
}
fn parse_headers_payload(payload: &[u8]) -> Result<Vec<[u8; 80]>, String> {
    let mut pos = 0;
    let count = read_varint(payload, &mut pos)? as usize;
    let mut out = Vec::with_capacity(count.min(4000));
    for _ in 0..count {
        out.push(take(payload, &mut pos, 80)?.try_into().unwrap());
        let _ = read_varint(payload, &mut pos)?;
    }
    Ok(out)
}
pub async fn fetch_headers_after_raw(
    host: &str,
    port: u16,
    network: &str,
    transport: &Bip37Transport,
    locator: [u8; 32],
) -> Result<Vec<[u8; 80]>, String> {
    let magic = params_for(network).magic;
    let mut stream = connect_peer(host, port, transport).await?;
    handshake(&mut stream, magic).await?;
    stream
        .write_all(&encode_message(
            magic,
            "getheaders",
            &build_getheaders_payload(&locator),
        ))
        .await
        .map_err(|e| format!("getheaders send failed: {e}"))?;
    for _ in 0..100 {
        let (cmd, payload) = read_message(&mut stream, magic).await?;
        if cmd == "headers" {
            let raws = parse_headers_payload(&payload)?;
            let mut expected = locator;
            for raw in &raws {
                let prev: [u8; 32] = raw[4..36].try_into().unwrap();
                if prev != expected {
                    return Err("header chain does not link to locator/previous header".into());
                }
                expected = double_sha256(raw)
            }
            return Ok(raws);
        }
        if cmd == "ping" {
            let _ = stream
                .write_all(&encode_message(magic, "pong", &payload))
                .await;
        }
    }
    Err("node did not return headers".into())
}

fn build_getdata(kind: u32, hash: &[u8; 32]) -> Vec<u8> {
    let mut p = Vec::with_capacity(37);
    write_varint(&mut p, 1);
    p.extend_from_slice(&kind.to_le_bytes());
    p.extend_from_slice(hash);
    p
}
async fn scan_blocks_observed(
    host: &str,
    port: u16,
    network: &str,
    transport: &Bip37Transport,
    blocks: &[(u32, [u8; 32])],
    bloom_items: &[Vec<u8>],
) -> Result<Vec<ObservedTransaction>, String> {
    let magic = params_for(network).magic;
    let mut stream = connect_peer(host, port, transport).await?;
    let probe = handshake(&mut stream, magic).await?;
    if !probe.serves_bloom {
        return Err("peer does not advertise NODE_BLOOM".into());
    }
    let mut filter = BloomFilter::new(bloom_items.len().max(1) * 2, 0.0001, nonce() as u32);
    for item in bloom_items {
        filter.insert(item)
    }
    stream
        .write_all(&encode_message(
            magic,
            "filterload",
            &filter.to_filterload_payload(BLOOM_UPDATE_ALL),
        ))
        .await
        .map_err(|e| format!("filterload failed: {e}"))?;
    let mut observed = Vec::new();
    for (height, block_hash) in blocks {
        stream
            .write_all(&encode_message(
                magic,
                "getdata",
                &build_getdata(MSG_FILTERED_BLOCK, block_hash),
            ))
            .await
            .map_err(|e| format!("getdata failed: {e}"))?;
        let mut expected = None;
        let mut got = 0usize;
        for _ in 0..MAX_MESSAGES {
            let (cmd, payload) = read_message(&mut stream, magic).await?;
            match cmd.as_str() {
                "merkleblock" => {
                    let mb = merkleblock::parse_merkleblock(&payload)?;
                    if !mb.valid {
                        return Err("merkleblock failed verification during scan".into());
                    }
                    expected = Some(mb.matched_txids.len())
                }
                "tx" => {
                    let parsed = tx::parse_tx(&payload)?;
                    observed.push(ObservedTransaction {
                        txid: parsed.txid,
                        raw: parsed.raw,
                        block_height: Some(*height),
                    });
                    got += 1
                }
                "ping" => {
                    let _ = stream
                        .write_all(&encode_message(magic, "pong", &payload))
                        .await;
                }
                _ => {}
            }
            if expected.is_some_and(|n| got >= n) {
                break;
            }
        }
        if expected.is_none() {
            return Err("node did not return merkleblock".into());
        }
        if got < expected.unwrap_or(0) {
            return Err("node did not return all matched transactions".into());
        }
    }
    Ok(observed)
}
fn inventory_contains_tx(payload: &[u8], expected: &[u8; 32]) -> Result<bool, String> {
    let mut pos = 0;
    let count = read_varint(payload, &mut pos)?;
    if count > (MAX_PAYLOAD / 36) as u64 {
        return Err("inventory contains too many entries".into());
    }
    let mut found = false;
    for _ in 0..count {
        let kind = read_u32(payload, &mut pos)?;
        let hash = take(payload, &mut pos, 32)?;
        if kind == MSG_TX && hash == expected {
            found = true
        }
    }
    Ok(found)
}
async fn relay_tx_on_stream<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
    magic: [u8; 4],
    raw_tx: &[u8],
    txid: [u8; 32],
) -> Result<bool, String> {
    stream
        .write_all(&encode_message(magic, "inv", &build_getdata(MSG_TX, &txid)))
        .await
        .map_err(|e| format!("inv send failed: {e}"))?;
    let exchange = async {
        for _ in 0..30 {
            let (cmd, payload) = read_message(stream, magic).await?;
            match cmd.as_str() {
                "getdata" if inventory_contains_tx(&payload, &txid)? => {
                    stream
                        .write_all(&encode_message(magic, "tx", raw_tx))
                        .await
                        .map_err(|e| format!("tx send failed: {e}"))?;
                    return Ok(true);
                }
                "reject" => return Err("relay rejected transaction".into()),
                "ping" => {
                    let _ = stream
                        .write_all(&encode_message(magic, "pong", &payload))
                        .await;
                }
                _ => {}
            }
        }
        Ok(false)
    };
    match tokio::time::timeout(RELAY_RESPONSE_TIMEOUT, exchange).await {
        Ok(v) => v,
        Err(_) => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn p2pkh_script_produces_hash_push() {
        let mut script = vec![0x76, 0xa9, 0x14];
        script.extend_from_slice(&[9; 20]);
        script.extend_from_slice(&[0x88, 0xac]);
        assert_eq!(script_push_items(&script), vec![vec![9; 20]])
    }
    #[test]
    fn version_service_bit_discovers_bloom() {
        let mut payload = build_version_payload(123);
        payload[4..12].copy_from_slice(&NODE_BLOOM.to_le_bytes());
        assert!(parse_version_payload(&payload).unwrap().serves_bloom)
    }
}
