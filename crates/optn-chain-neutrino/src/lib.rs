#![forbid(unsafe_code)]

//! bchd-compatible compact-filter (Neutrino-style) BCH provider.
//!
//! This adapter treats compact filters as a discovery mechanism, not consensus.
//! It validates P2P framing, block-header linkage, the committed-filter hash
//! chain, each returned filter hash, and full-block merkle roots before emitting
//! wallet observations. Stronger chain trust still belongs to shared header
//! verification/reconciliation.

pub mod gcs;

use gcs::GcsFilter;
use optn_core::header_hash::sha256d;
use optn_runtime::chain::{
    Capability, CapabilityConfidence, CapabilityDiscovery, CapabilitySet, Endpoint, EndpointKind,
    Evidence, ProtocolFamily, ProviderHealth, SourceId,
};
use optn_runtime::chain_service::{
    BackendObservation, ChainBackend, ChainBackendError, ChainFuture, ChainOperation, ChainPayload,
    ChainRequest, ChainTip, ObservedTransaction, WalletInterest,
};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

const PROTOCOL_VERSION: i32 = 70015;
const SF_NODE_CF: u64 = 1 << 8;
const USER_AGENT: &str = "/OPTNWallet:1.0/";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_GENERAL_PAYLOAD: usize = 8 * 1024 * 1024;
const MAX_BLOCK_PAYLOAD: usize = 256 * 1024 * 1024;
const MAX_CF_RANGE: u32 = 1000;
const MAX_CF_HEADERS: u32 = 2000;
const MSG_BLOCK: u32 = 2;
const FILTER_TYPE_BASIC: u8 = 0;

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
pub enum NeutrinoTransport {
    Direct,
    Tor { proxy_host: String, proxy_port: u16 },
}

#[derive(Debug, Clone)]
pub struct NeutrinoConfig {
    pub source_id: SourceId,
    pub endpoint: Endpoint,
    pub network: String,
    pub transport: NeutrinoTransport,
}

impl NeutrinoConfig {
    pub fn new(source_id: SourceId, endpoint: Endpoint, network: impl Into<String>) -> Self {
        Self {
            source_id,
            endpoint,
            network: network.into(),
            transport: NeutrinoTransport::Direct,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeProbe {
    pub user_agent: String,
    pub protocol_version: i32,
    pub services: u64,
    pub start_height: i32,
    pub serves_compact_filters: bool,
}

#[derive(Default)]
struct HeaderCache {
    by_height: BTreeMap<u32, [u8; 32]>,
}

#[derive(Default)]
struct FilterCache {
    hashes: BTreeMap<u32, [u8; 32]>,
    headers: BTreeMap<u32, [u8; 32]>,
}

pub struct NeutrinoBackend {
    config: NeutrinoConfig,
    capabilities: CapabilitySet,
    probe: NodeProbe,
    headers: Mutex<HeaderCache>,
    filters: Mutex<FilterCache>,
}

impl NeutrinoBackend {
    pub async fn connect(config: NeutrinoConfig) -> Result<Self, ChainBackendError> {
        if config.endpoint.kind != EndpointKind::BchP2p {
            return Err(ChainBackendError::Rejected(
                "Neutrino requires a BCH P2P endpoint".into(),
            ));
        }
        let port = config
            .endpoint
            .port
            .unwrap_or_else(|| params_for(&config.network).default_port);
        let (mut stream, probe) = connect_handshaken(
            &config.endpoint.host,
            port,
            &config.network,
            &config.transport,
        )
        .await?;

        let mut capabilities = CapabilitySet::default();
        capabilities.record(
            Capability::HeaderStream,
            CapabilityConfidence::Advertised,
            CapabilityDiscovery::ActiveProbe,
        );

        let mut filters = FilterCache::default();
        if probe.serves_compact_filters {
            let discovery = CapabilityDiscovery::P2pServiceBit {
                bit: SF_NODE_CF,
                name: "SFNodeCF".into(),
            };
            capabilities.record(
                Capability::CompactFilters,
                CapabilityConfidence::Advertised,
                discovery,
            );
            match probe_genesis_filter(
                &mut stream,
                params_for(&config.network).magic,
                genesis_hash(&config.network),
            )
            .await
            {
                Ok((filter_hash, filter_header)) => {
                    filters.hashes.insert(0, filter_hash);
                    filters.headers.insert(0, filter_header);
                    capabilities.record(
                        Capability::CompactFilters,
                        CapabilityConfidence::Verified,
                        CapabilityDiscovery::ActiveProbe,
                    );
                    capabilities.record(
                        Capability::UtxoQuery,
                        CapabilityConfidence::Advertised,
                        CapabilityDiscovery::ActiveProbe,
                    );
                }
                Err(_) => {
                    capabilities.record(
                        Capability::CompactFilters,
                        CapabilityConfidence::Rejected,
                        CapabilityDiscovery::ActiveProbe,
                    );
                }
            }
        } else {
            capabilities.record(
                Capability::CompactFilters,
                CapabilityConfidence::Rejected,
                CapabilityDiscovery::ActiveProbe,
            );
        }

        let mut headers = HeaderCache::default();
        headers.by_height.insert(0, genesis_hash(&config.network));
        Ok(Self {
            config,
            capabilities,
            probe,
            headers: Mutex::new(headers),
            filters: Mutex::new(filters),
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
                "getheaders starts after a locator; request height 1 or later".into(),
            ));
        }
        let locator = self
            .headers
            .lock()
            .await
            .by_height
            .get(&(start_height - 1))
            .copied()
            .ok_or_else(|| {
                ChainBackendError::Rejected("header cursor is not cached; sync sequentially".into())
            })?;
        let port = self
            .config
            .endpoint
            .port
            .unwrap_or_else(|| params_for(&self.config.network).default_port);
        let (mut stream, _) = connect_handshaken(
            &self.config.endpoint.host,
            port,
            &self.config.network,
            &self.config.transport,
        )
        .await?;
        let mut headers =
            request_headers(&mut stream, params_for(&self.config.network).magic, locator).await?;
        headers.truncate(count as usize);

        let mut expected_prev = locator;
        let mut cache = self.headers.lock().await;
        for (offset, header) in headers.iter().enumerate() {
            if header[4..36] != expected_prev {
                return Err(ChainBackendError::InvalidResponse(
                    "header chain does not link to locator".into(),
                ));
            }
            let hash = sha256d(header);
            cache
                .by_height
                .insert(start_height.saturating_add(offset as u32), hash);
            expected_prev = hash;
        }
        let last = headers
            .last()
            .map(|header| (start_height + headers.len() as u32 - 1, sha256d(header)));
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
        if !self.capabilities.is_usable(Capability::UtxoQuery) {
            return Err(ChainBackendError::Unsupported);
        }

        let (query_items, watched_scripts, watched_outpoints) = query_items(interests);
        if query_items.is_empty() {
            return Err(ChainBackendError::Rejected(
                "compact-filter refresh has no script/outpoint interests".into(),
            ));
        }

        let tip = {
            let cache = self.headers.lock().await;
            let Some((&tip_height, &tip_hash)) = cache.by_height.iter().next_back() else {
                return Err(ChainBackendError::Rejected("header cache is empty".into()));
            };
            ChainTip {
                height: tip_height,
                hash: tip_hash,
            }
        };
        let start = from_height.unwrap_or(1);
        if start > tip.height {
            let chain_tip = Some((tip.height, tip.hash));
            return Ok(BackendObservation {
                payload: ChainPayload::WalletRefresh {
                    transactions: Vec::new(),
                    tip: Some(tip),
                },
                evidence: Evidence::ServerAssertion,
                chain_tip,
            });
        }

        let port = self
            .config
            .endpoint
            .port
            .unwrap_or_else(|| params_for(&self.config.network).default_port);
        let (mut stream, _) = connect_handshaken(
            &self.config.endpoint.host,
            port,
            &self.config.network,
            &self.config.transport,
        )
        .await?;
        let magic = params_for(&self.config.network).magic;
        let mut found = BTreeMap::<[u8; 32], ObservedTransaction>::new();
        let mut chunk_start = start;

        while chunk_start <= tip.height {
            let chunk_end = chunk_start.saturating_add(MAX_CF_RANGE - 1).min(tip.height);
            self.ensure_filter_headers(&mut stream, magic, chunk_end)
                .await?;
            let expected_hashes = {
                let cache = self.headers.lock().await;
                (chunk_start..=chunk_end)
                    .map(|height| {
                        cache.by_height.get(&height).copied().ok_or_else(|| {
                            ChainBackendError::Rejected(format!(
                                "missing block hash at height {height}"
                            ))
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?
            };
            let stop_hash = *expected_hashes.last().expect("non-empty range");
            let filters = request_cfilters(
                &mut stream,
                magic,
                chunk_start,
                stop_hash,
                expected_hashes.len(),
            )
            .await?;

            for (offset, filter) in filters.into_iter().enumerate() {
                let height = chunk_start + offset as u32;
                let block_hash = expected_hashes[offset];
                if filter.block_hash != block_hash {
                    return Err(ChainBackendError::InvalidResponse(
                        "cfilter block hash/order mismatch".into(),
                    ));
                }
                let expected_filter_hash = self
                    .filters
                    .lock()
                    .await
                    .hashes
                    .get(&height)
                    .copied()
                    .ok_or_else(|| {
                    ChainBackendError::Rejected(format!(
                        "missing committed filter hash at height {height}"
                    ))
                })?;
                if sha256d(&filter.data) != expected_filter_hash {
                    return Err(ChainBackendError::InvalidResponse(
                        "cfilter bytes do not match cfheaders commitment".into(),
                    ));
                }
                let gcs = GcsFilter::from_nbytes(&filter.data).map_err(|error| {
                    ChainBackendError::InvalidResponse(format!("invalid GCS filter: {error:?}"))
                })?;
                if gcs.match_any(&block_hash, &query_items).map_err(|error| {
                    ChainBackendError::InvalidResponse(format!("GCS match failed: {error:?}"))
                })? {
                    let block = request_block(&mut stream, magic, block_hash).await?;
                    for tx in parse_relevant_block(
                        &block,
                        block_hash,
                        height,
                        &watched_scripts,
                        &watched_outpoints,
                    )? {
                        found.insert(tx.txid, tx);
                    }
                }
            }

            if chunk_end == u32::MAX {
                break;
            }
            chunk_start = chunk_end + 1;
        }

        let chain_tip = Some((tip.height, tip.hash));
        Ok(BackendObservation {
            payload: ChainPayload::WalletRefresh {
                transactions: found.into_values().collect(),
                tip: Some(tip),
            },
            evidence: Evidence::ServerAssertion,
            chain_tip,
        })
    }

    async fn ensure_filter_headers(
        &self,
        stream: &mut TcpStream,
        magic: [u8; 4],
        stop_height: u32,
    ) -> Result<(), ChainBackendError> {
        loop {
            let start = {
                let cache = self.filters.lock().await;
                cache
                    .headers
                    .keys()
                    .next_back()
                    .map(|height| height.saturating_add(1))
                    .unwrap_or(0)
            };
            if start > stop_height {
                return Ok(());
            }
            let end = start.saturating_add(MAX_CF_HEADERS - 1).min(stop_height);
            let stop_hash = self
                .headers
                .lock()
                .await
                .by_height
                .get(&end)
                .copied()
                .ok_or_else(|| {
                    ChainBackendError::Rejected(format!("missing block header at height {end}"))
                })?;
            let expected_prev = if start == 0 {
                [0; 32]
            } else {
                self.filters
                    .lock()
                    .await
                    .headers
                    .get(&(start - 1))
                    .copied()
                    .ok_or_else(|| {
                        ChainBackendError::Rejected(format!(
                            "missing filter header at height {}",
                            start - 1
                        ))
                    })?
            };
            let response = request_cfheaders(stream, magic, start, stop_hash).await?;
            if response.stop_hash != stop_hash || response.prev_filter_header != expected_prev {
                return Err(ChainBackendError::InvalidResponse(
                    "cfheaders chain anchor mismatch".into(),
                ));
            }
            let expected_count = end - start + 1;
            if response.filter_hashes.len() != expected_count as usize {
                return Err(ChainBackendError::InvalidResponse(
                    "cfheaders returned unexpected count".into(),
                ));
            }
            let mut cache = self.filters.lock().await;
            let mut prev = expected_prev;
            for (offset, filter_hash) in response.filter_hashes.into_iter().enumerate() {
                let height = start + offset as u32;
                let header = hash_pair(filter_hash, prev);
                cache.hashes.insert(height, filter_hash);
                cache.headers.insert(height, header);
                prev = header;
            }
        }
    }
}

impl ChainBackend for NeutrinoBackend {
    fn source_id(&self) -> &SourceId {
        &self.config.source_id
    }
    fn protocol(&self) -> ProtocolFamily {
        ProtocolFamily::Neutrino
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
            ChainOperation::HeaderSync => true,
            ChainOperation::TransactionLookup
            | ChainOperation::Broadcast
            | ChainOperation::HistoricalHeaderProof => false,
        }
    }
    fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
        Box::pin(async move {
            match request {
                ChainRequest::WalletRefresh {
                    interests,
                    from_height,
                } => self.wallet_refresh(interests, *from_height).await,
                ChainRequest::HeaderSync {
                    start_height,
                    count,
                } => self.header_sync(*start_height, *count).await,
                _ => Err(ChainBackendError::Unsupported),
            }
        })
    }
}

fn query_items(
    interests: &[WalletInterest],
) -> (Vec<Vec<u8>>, Vec<Vec<u8>>, BTreeSet<([u8; 32], u32)>) {
    let mut query = Vec::new();
    let mut scripts = Vec::new();
    let mut outpoints = BTreeSet::new();
    for interest in interests {
        match interest {
            WalletInterest::Script(script) if !script.is_empty() => {
                query.push(script.clone());
                scripts.push(script.clone());
            }
            WalletInterest::Outpoint { txid, vout } => {
                if let Some(serialized) = interest.serialized_outpoint() {
                    query.push(serialized.to_vec());
                }
                outpoints.insert((*txid, *vout));
            }
            WalletInterest::RpaPrefix(_) | WalletInterest::Script(_) => {}
        }
    }
    (query, scripts, outpoints)
}

async fn probe_genesis_filter(
    stream: &mut TcpStream,
    magic: [u8; 4],
    genesis: [u8; 32],
) -> Result<([u8; 32], [u8; 32]), ChainBackendError> {
    let headers = request_cfheaders(stream, magic, 0, genesis).await?;
    if headers.stop_hash != genesis
        || headers.prev_filter_header != [0; 32]
        || headers.filter_hashes.len() != 1
    {
        return Err(ChainBackendError::InvalidResponse(
            "genesis cfheaders probe mismatch".into(),
        ));
    }
    let filters = request_cfilters(stream, magic, 0, genesis, 1).await?;
    let filter = filters
        .into_iter()
        .next()
        .ok_or_else(|| ChainBackendError::InvalidResponse("missing genesis cfilter".into()))?;
    if filter.block_hash != genesis || sha256d(&filter.data) != headers.filter_hashes[0] {
        return Err(ChainBackendError::InvalidResponse(
            "genesis cfilter commitment mismatch".into(),
        ));
    }
    GcsFilter::from_nbytes(&filter.data).map_err(|error| {
        ChainBackendError::InvalidResponse(format!("genesis GCS decode failed: {error:?}"))
    })?;
    let filter_hash = headers.filter_hashes[0];
    Ok((filter_hash, hash_pair(filter_hash, [0; 32])))
}

#[derive(Debug)]
struct CFHeaders {
    stop_hash: [u8; 32],
    prev_filter_header: [u8; 32],
    filter_hashes: Vec<[u8; 32]>,
}

#[derive(Debug)]
struct CFilter {
    block_hash: [u8; 32],
    data: Vec<u8>,
}

async fn request_cfheaders(
    stream: &mut TcpStream,
    magic: [u8; 4],
    start_height: u32,
    stop_hash: [u8; 32],
) -> Result<CFHeaders, ChainBackendError> {
    let mut payload = Vec::with_capacity(37);
    payload.push(FILTER_TYPE_BASIC);
    payload.extend_from_slice(&start_height.to_le_bytes());
    payload.extend_from_slice(&stop_hash);
    send_message(stream, magic, "getcfheaders", &payload).await?;
    for _ in 0..100 {
        let (command, payload) = read_message(stream, magic).await?;
        match command.as_str() {
            "cfheaders" => return parse_cfheaders(&payload),
            "ping" => send_message(stream, magic, "pong", &payload).await?,
            _ => {}
        }
    }
    Err(ChainBackendError::Timeout)
}

fn parse_cfheaders(payload: &[u8]) -> Result<CFHeaders, ChainBackendError> {
    let mut pos = 0usize;
    if *take(payload, &mut pos, 1)?.first().expect("one byte") != FILTER_TYPE_BASIC {
        return Err(ChainBackendError::InvalidResponse(
            "unsupported compact filter type".into(),
        ));
    }
    let stop_hash = take(payload, &mut pos, 32)?
        .try_into()
        .expect("fixed slice");
    let prev_filter_header = take(payload, &mut pos, 32)?
        .try_into()
        .expect("fixed slice");
    let count = read_varint(payload, &mut pos)?;
    if count > u64::from(MAX_CF_HEADERS) {
        return Err(ChainBackendError::InvalidResponse(
            "too many cfheaders".into(),
        ));
    }
    let mut filter_hashes = Vec::with_capacity(count as usize);
    for _ in 0..count {
        filter_hashes.push(
            take(payload, &mut pos, 32)?
                .try_into()
                .expect("fixed slice"),
        );
    }
    if pos != payload.len() {
        return Err(ChainBackendError::InvalidResponse(
            "trailing bytes in cfheaders".into(),
        ));
    }
    Ok(CFHeaders {
        stop_hash,
        prev_filter_header,
        filter_hashes,
    })
}

async fn request_cfilters(
    stream: &mut TcpStream,
    magic: [u8; 4],
    start_height: u32,
    stop_hash: [u8; 32],
    expected_count: usize,
) -> Result<Vec<CFilter>, ChainBackendError> {
    if expected_count > MAX_CF_RANGE as usize {
        return Err(ChainBackendError::Rejected(
            "getcfilters range exceeds bchd limit".into(),
        ));
    }
    let mut payload = Vec::with_capacity(37);
    payload.push(FILTER_TYPE_BASIC);
    payload.extend_from_slice(&start_height.to_le_bytes());
    payload.extend_from_slice(&stop_hash);
    send_message(stream, magic, "getcfilters", &payload).await?;
    let mut filters = Vec::with_capacity(expected_count);
    for _ in 0..(expected_count.saturating_mul(4).max(20)) {
        let (command, payload) = read_message(stream, magic).await?;
        match command.as_str() {
            "cfilter" => {
                filters.push(parse_cfilter(&payload)?);
                if filters.len() == expected_count {
                    return Ok(filters);
                }
            }
            "ping" => send_message(stream, magic, "pong", &payload).await?,
            "reject" | "notfound" => {
                return Err(ChainBackendError::Rejected(
                    "peer rejected compact-filter request".into(),
                ))
            }
            _ => {}
        }
    }
    Err(ChainBackendError::Timeout)
}

fn parse_cfilter(payload: &[u8]) -> Result<CFilter, ChainBackendError> {
    let mut pos = 0usize;
    if *take(payload, &mut pos, 1)?.first().expect("one byte") != FILTER_TYPE_BASIC {
        return Err(ChainBackendError::InvalidResponse(
            "unsupported compact filter type".into(),
        ));
    }
    let block_hash = take(payload, &mut pos, 32)?
        .try_into()
        .expect("fixed slice");
    let len = usize::try_from(read_varint(payload, &mut pos)?)
        .map_err(|_| ChainBackendError::InvalidResponse("cfilter length overflow".into()))?;
    if len > 4 * 1024 * 1024 {
        return Err(ChainBackendError::InvalidResponse(
            "cfilter exceeds bchd maximum".into(),
        ));
    }
    let data = take(payload, &mut pos, len)?.to_vec();
    if pos != payload.len() {
        return Err(ChainBackendError::InvalidResponse(
            "trailing bytes in cfilter".into(),
        ));
    }
    Ok(CFilter { block_hash, data })
}

async fn request_headers(
    stream: &mut TcpStream,
    magic: [u8; 4],
    locator: [u8; 32],
) -> Result<Vec<[u8; 80]>, ChainBackendError> {
    let mut payload = Vec::with_capacity(69);
    payload.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    write_varint(&mut payload, 1);
    payload.extend_from_slice(&locator);
    payload.extend_from_slice(&[0; 32]);
    send_message(stream, magic, "getheaders", &payload).await?;
    for _ in 0..100 {
        let (command, payload) = read_message(stream, magic).await?;
        match command.as_str() {
            "headers" => return parse_headers(&payload),
            "ping" => send_message(stream, magic, "pong", &payload).await?,
            _ => {}
        }
    }
    Err(ChainBackendError::Timeout)
}

fn parse_headers(payload: &[u8]) -> Result<Vec<[u8; 80]>, ChainBackendError> {
    let mut pos = 0usize;
    let count = read_varint(payload, &mut pos)?;
    if count > 2000 {
        return Err(ChainBackendError::InvalidResponse(
            "too many headers".into(),
        ));
    }
    let mut headers = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let header = take(payload, &mut pos, 80)?
            .try_into()
            .expect("fixed slice");
        if read_varint(payload, &mut pos)? != 0 {
            return Err(ChainBackendError::InvalidResponse(
                "headers message has non-zero tx count".into(),
            ));
        }
        headers.push(header);
    }
    Ok(headers)
}

async fn request_block(
    stream: &mut TcpStream,
    magic: [u8; 4],
    block_hash: [u8; 32],
) -> Result<Vec<u8>, ChainBackendError> {
    let mut payload = Vec::with_capacity(37);
    write_varint(&mut payload, 1);
    payload.extend_from_slice(&MSG_BLOCK.to_le_bytes());
    payload.extend_from_slice(&block_hash);
    send_message(stream, magic, "getdata", &payload).await?;
    for _ in 0..200 {
        let (command, payload) = read_message(stream, magic).await?;
        match command.as_str() {
            "block" => {
                let header = payload.get(..80).ok_or_else(|| {
                    ChainBackendError::InvalidResponse("block shorter than header".into())
                })?;
                if sha256d(header) != block_hash {
                    return Err(ChainBackendError::InvalidResponse(
                        "peer returned wrong block".into(),
                    ));
                }
                return Ok(payload);
            }
            "ping" => send_message(stream, magic, "pong", &payload).await?,
            "notfound" => {
                return Err(ChainBackendError::Rejected(
                    "peer does not have requested block".into(),
                ))
            }
            _ => {}
        }
    }
    Err(ChainBackendError::Timeout)
}

fn parse_relevant_block(
    block: &[u8],
    expected_hash: [u8; 32],
    height: u32,
    watched_scripts: &[Vec<u8>],
    watched_outpoints: &BTreeSet<([u8; 32], u32)>,
) -> Result<Vec<ObservedTransaction>, ChainBackendError> {
    let header: [u8; 80] = block
        .get(..80)
        .ok_or_else(|| ChainBackendError::InvalidResponse("block shorter than 80 bytes".into()))?
        .try_into()
        .expect("fixed slice");
    if sha256d(&header) != expected_hash {
        return Err(ChainBackendError::InvalidResponse(
            "block header hash mismatch".into(),
        ));
    }
    let mut pos = 80usize;
    let count = read_varint(block, &mut pos)?;
    if count == 0 || count > 10_000_000 {
        return Err(ChainBackendError::InvalidResponse(
            "invalid block transaction count".into(),
        ));
    }
    let mut txids = Vec::with_capacity((count as usize).min(1_000_000));
    let mut relevant = Vec::new();
    for _ in 0..count {
        let start = pos;
        let touches_wallet = parse_tx_shape(block, &mut pos, watched_scripts, watched_outpoints)?;
        let raw = block.get(start..pos).ok_or_else(|| {
            ChainBackendError::InvalidResponse("transaction slice overflow".into())
        })?;
        let txid = sha256d(raw);
        txids.push(txid);
        if touches_wallet {
            relevant.push(ObservedTransaction {
                txid,
                raw: raw.to_vec(),
                block_height: Some(height),
            });
        }
    }
    if pos != block.len() {
        return Err(ChainBackendError::InvalidResponse(
            "trailing bytes after block transactions".into(),
        ));
    }
    let root = merkle_root(txids)?;
    if root != header[36..68] {
        return Err(ChainBackendError::InvalidResponse(
            "full block merkle root mismatch".into(),
        ));
    }
    Ok(relevant)
}

fn parse_tx_shape(
    data: &[u8],
    pos: &mut usize,
    watched_scripts: &[Vec<u8>],
    watched_outpoints: &BTreeSet<([u8; 32], u32)>,
) -> Result<bool, ChainBackendError> {
    take(data, pos, 4)?;
    let input_count = read_varint(data, pos)?;
    if input_count > 1_000_000 {
        return Err(ChainBackendError::InvalidResponse(
            "too many tx inputs".into(),
        ));
    }
    let mut relevant = false;
    for _ in 0..input_count {
        let prev_txid: [u8; 32] = take(data, pos, 32)?.try_into().expect("fixed slice");
        let vout = read_u32(data, pos)?;
        if watched_outpoints.contains(&(prev_txid, vout)) {
            relevant = true;
        }
        let script_len = usize::try_from(read_varint(data, pos)?)
            .map_err(|_| ChainBackendError::InvalidResponse("script length overflow".into()))?;
        take(data, pos, script_len)?;
        take(data, pos, 4)?;
    }
    let output_count = read_varint(data, pos)?;
    if output_count > 1_000_000 {
        return Err(ChainBackendError::InvalidResponse(
            "too many tx outputs".into(),
        ));
    }
    for _ in 0..output_count {
        take(data, pos, 8)?;
        let script_len = usize::try_from(read_varint(data, pos)?)
            .map_err(|_| ChainBackendError::InvalidResponse("script length overflow".into()))?;
        let script = take(data, pos, script_len)?;
        if watched_scripts
            .iter()
            .any(|candidate| candidate.as_slice() == script)
        {
            relevant = true;
        }
    }
    take(data, pos, 4)?;
    Ok(relevant)
}

fn merkle_root(mut layer: Vec<[u8; 32]>) -> Result<[u8; 32], ChainBackendError> {
    if layer.is_empty() {
        return Err(ChainBackendError::InvalidResponse(
            "empty merkle tree".into(),
        ));
    }
    while layer.len() > 1 {
        let mut next = Vec::with_capacity(layer.len().div_ceil(2));
        let mut index = 0usize;
        while index < layer.len() {
            let left = layer[index];
            let right = if index + 1 < layer.len() {
                let right = layer[index + 1];
                if right == left {
                    return Err(ChainBackendError::InvalidResponse(
                        "duplicate merkle siblings".into(),
                    ));
                }
                right
            } else {
                left
            };
            next.push(hash_pair(left, right));
            index += 2;
        }
        layer = next;
    }
    Ok(layer[0])
}

fn hash_pair(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let mut pair = [0u8; 64];
    pair[..32].copy_from_slice(&left);
    pair[32..].copy_from_slice(&right);
    sha256d(&pair)
}

async fn connect_handshaken(
    host: &str,
    port: u16,
    network: &str,
    transport: &NeutrinoTransport,
) -> Result<(TcpStream, NodeProbe), ChainBackendError> {
    let mut stream = connect_peer(host, port, transport).await?;
    let probe = handshake(&mut stream, params_for(network).magic).await?;
    Ok((stream, probe))
}

async fn connect_peer(
    host: &str,
    port: u16,
    transport: &NeutrinoTransport,
) -> Result<TcpStream, ChainBackendError> {
    match transport {
        NeutrinoTransport::Direct => {
            tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
                .await
                .map_err(|_| ChainBackendError::Timeout)?
                .map_err(|_| ChainBackendError::Offline)
        }
        NeutrinoTransport::Tor {
            proxy_host,
            proxy_port,
        } => {
            let token = format!("optn-cf-{}", nonce());
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
            .map_err(|_| ChainBackendError::Timeout)?
            .map_err(|_| ChainBackendError::Offline)?;
            Ok(socks.into_inner())
        }
    }
}

async fn handshake(stream: &mut TcpStream, magic: [u8; 4]) -> Result<NodeProbe, ChainBackendError> {
    send_message(stream, magic, "version", &build_version_payload()).await?;
    for _ in 0..50 {
        let (command, payload) = read_message(stream, magic).await?;
        match command.as_str() {
            "version" => {
                let probe = parse_version(&payload)?;
                send_message(stream, magic, "verack", &[]).await?;
                return Ok(probe);
            }
            "ping" => send_message(stream, magic, "pong", &payload).await?,
            _ => {}
        }
    }
    Err(ChainBackendError::Timeout)
}

fn build_version_payload() -> Vec<u8> {
    let mut payload = Vec::with_capacity(90);
    payload.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    payload.extend_from_slice(&0u64.to_le_bytes());
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0);
    payload.extend_from_slice(&timestamp.to_le_bytes());
    payload.extend_from_slice(&[0; 26]);
    payload.extend_from_slice(&[0; 26]);
    payload.extend_from_slice(&nonce().to_le_bytes());
    write_varint(&mut payload, USER_AGENT.len() as u64);
    payload.extend_from_slice(USER_AGENT.as_bytes());
    payload.extend_from_slice(&0i32.to_le_bytes());
    payload.push(0);
    payload
}

fn parse_version(payload: &[u8]) -> Result<NodeProbe, ChainBackendError> {
    let mut pos = 0usize;
    let protocol_version = read_i32(payload, &mut pos)?;
    let services = read_u64(payload, &mut pos)?;
    take(payload, &mut pos, 8)?;
    take(payload, &mut pos, 26)?;
    take(payload, &mut pos, 26)?;
    take(payload, &mut pos, 8)?;
    let ua_len = usize::try_from(read_varint(payload, &mut pos)?)
        .map_err(|_| ChainBackendError::InvalidResponse("user-agent length overflow".into()))?;
    let user_agent = String::from_utf8_lossy(take(payload, &mut pos, ua_len)?).into_owned();
    let start_height = read_i32(payload, &mut pos)?;
    Ok(NodeProbe {
        user_agent,
        protocol_version,
        services,
        start_height,
        serves_compact_filters: services & SF_NODE_CF != 0,
    })
}

async fn send_message(
    stream: &mut TcpStream,
    magic: [u8; 4],
    command: &str,
    payload: &[u8],
) -> Result<(), ChainBackendError> {
    let message = encode_message(magic, command, payload);
    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&message))
        .await
        .map_err(|_| ChainBackendError::Timeout)?
        .map_err(|_| ChainBackendError::Offline)
}

fn encode_message(magic: [u8; 4], command: &str, payload: &[u8]) -> Vec<u8> {
    let mut cmd = [0u8; 12];
    let bytes = command.as_bytes();
    let len = bytes.len().min(12);
    cmd[..len].copy_from_slice(&bytes[..len]);
    let checksum = sha256d(payload);
    let mut message = Vec::with_capacity(24 + payload.len());
    message.extend_from_slice(&magic);
    message.extend_from_slice(&cmd);
    message.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    message.extend_from_slice(&checksum[..4]);
    message.extend_from_slice(payload);
    message
}

async fn read_message(
    stream: &mut TcpStream,
    magic: [u8; 4],
) -> Result<(String, Vec<u8>), ChainBackendError> {
    let mut header = [0u8; 24];
    tokio::time::timeout(IO_TIMEOUT, stream.read_exact(&mut header))
        .await
        .map_err(|_| ChainBackendError::Timeout)?
        .map_err(|_| ChainBackendError::Offline)?;
    if header[..4] != magic {
        return Err(ChainBackendError::InvalidResponse(
            "wrong BCH network magic".into(),
        ));
    }
    let end = header[4..16]
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(12);
    let command = String::from_utf8_lossy(&header[4..4 + end]).into_owned();
    let len = u32::from_le_bytes(header[16..20].try_into().expect("fixed slice")) as usize;
    let limit = if command == "block" {
        MAX_BLOCK_PAYLOAD
    } else {
        MAX_GENERAL_PAYLOAD
    };
    if len > limit {
        return Err(ChainBackendError::InvalidResponse(format!(
            "{command} payload too large: {len}"
        )));
    }
    let mut payload = vec![0u8; len];
    tokio::time::timeout(IO_TIMEOUT, stream.read_exact(&mut payload))
        .await
        .map_err(|_| ChainBackendError::Timeout)?
        .map_err(|_| ChainBackendError::Offline)?;
    if sha256d(&payload)[..4] != header[20..24] {
        return Err(ChainBackendError::InvalidResponse(format!(
            "bad checksum on {command}"
        )));
    }
    Ok((command, payload))
}

fn take<'a>(data: &'a [u8], pos: &mut usize, len: usize) -> Result<&'a [u8], ChainBackendError> {
    let end = pos
        .checked_add(len)
        .ok_or_else(|| ChainBackendError::InvalidResponse("length overflow".into()))?;
    let value = data
        .get(*pos..end)
        .ok_or_else(|| ChainBackendError::InvalidResponse("truncated message".into()))?;
    *pos = end;
    Ok(value)
}

fn read_u32(data: &[u8], pos: &mut usize) -> Result<u32, ChainBackendError> {
    Ok(u32::from_le_bytes(
        take(data, pos, 4)?.try_into().expect("fixed slice"),
    ))
}
fn read_u64(data: &[u8], pos: &mut usize) -> Result<u64, ChainBackendError> {
    Ok(u64::from_le_bytes(
        take(data, pos, 8)?.try_into().expect("fixed slice"),
    ))
}
fn read_i32(data: &[u8], pos: &mut usize) -> Result<i32, ChainBackendError> {
    Ok(read_u32(data, pos)? as i32)
}
fn read_varint(data: &[u8], pos: &mut usize) -> Result<u64, ChainBackendError> {
    let first = *take(data, pos, 1)?.first().expect("one byte");
    Ok(match first {
        0xfd => u64::from(u16::from_le_bytes(
            take(data, pos, 2)?.try_into().expect("fixed slice"),
        )),
        0xfe => u64::from(read_u32(data, pos)?),
        0xff => read_u64(data, pos)?,
        value => u64::from(value),
    })
}
fn write_varint(buffer: &mut Vec<u8>, value: u64) {
    if value < 0xfd {
        buffer.push(value as u8);
    } else if value <= 0xffff {
        buffer.push(0xfd);
        buffer.extend_from_slice(&(value as u16).to_le_bytes());
    } else if value <= 0xffff_ffff {
        buffer.push(0xfe);
        buffer.extend_from_slice(&(value as u32).to_le_bytes());
    } else {
        buffer.push(0xff);
        buffer.extend_from_slice(&value.to_le_bytes());
    }
}

fn nonce() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos() as u64)
        .unwrap_or(0);
    nanos ^ counter.wrapping_mul(0x9e37_79b9_7f4a_7c15)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bchd_compact_filter_service_bit_is_1_shift_8() {
        assert_eq!(SF_NODE_CF, 256);
    }

    #[test]
    fn parses_relevant_full_block_and_merkle_root() {
        let watched_script = vec![0x51];
        let mut tx = Vec::new();
        tx.extend_from_slice(&1u32.to_le_bytes());
        tx.push(1);
        tx.extend_from_slice(&[0; 32]);
        tx.extend_from_slice(&u32::MAX.to_le_bytes());
        tx.push(1);
        tx.push(0);
        tx.extend_from_slice(&u32::MAX.to_le_bytes());
        tx.push(1);
        tx.extend_from_slice(&1000u64.to_le_bytes());
        tx.push(1);
        tx.push(0x51);
        tx.extend_from_slice(&0u32.to_le_bytes());
        let txid = sha256d(&tx);

        let mut header = [0u8; 80];
        header[36..68].copy_from_slice(&txid);
        let block_hash = sha256d(&header);
        let mut block = header.to_vec();
        block.push(1);
        block.extend_from_slice(&tx);

        let relevant =
            parse_relevant_block(&block, block_hash, 1, &[watched_script], &BTreeSet::new())
                .unwrap();
        assert_eq!(relevant.len(), 1);
        assert_eq!(relevant[0].txid, txid);
        assert_eq!(relevant[0].block_height, Some(1));
    }

    #[test]
    fn cfheaders_parser_rejects_wrong_filter_type() {
        let mut payload = vec![1];
        payload.extend_from_slice(&[0; 64]);
        payload.push(0);
        assert!(parse_cfheaders(&payload).is_err());
    }
}
