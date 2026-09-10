#![forbid(unsafe_code)]

//! Portable BCH P2P/BIP37 provider extracted from the legacy Tauri SPV engine.
//! Network sessions/cache are provider state; authoritative wallet state stays
//! in `optn-runtime`.

pub mod bloom;
pub mod merkleblock;
pub mod shv;
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
use optn_runtime::header_store::BlockHeaderSource;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

const PROTOCOL_VERSION: i32 = 70015;
const NODE_BLOOM: u64 = 1 << 2;
const USER_AGENT: &str = "/OPTNWallet:1.0/";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Tor gets its own budget: a SOCKS connect is a circuit build, not a TCP
/// handshake. Measured against a live daemon, an isolated circuit to one
/// peer usually lands in 2-5s but occasionally takes over 20s, and a
/// genesis-to-tip header sync is ~160 sequential connections. Sharing the
/// direct-TCP timeout made the privacy route the one route that could
/// never finish. Stream isolation per connection is kept.
const TOR_CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
const IO_TIMEOUT: Duration = Duration::from_secs(15);
/// Reading a message body over Tor is bounded by circuit bandwidth, not by
/// how fast the peer answers. A 2000-header batch is ~160 KB, which routinely
/// takes longer than the direct-TCP budget over three hops.
const TOR_IO_TIMEOUT: Duration = Duration::from_secs(90);

/// Per-message read budget for a transport. Direct TCP keeps the tighter value
/// so a dead peer is still detected quickly.
const fn io_timeout(transport: &Bip37Transport) -> Duration {
    match transport {
        Bip37Transport::Direct => IO_TIMEOUT,
        Bip37Transport::Tor { .. } => TOR_IO_TIMEOUT,
    }
}
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
        // Regtest genesis: version 1, nTime 1296688602, nBits 0x207fffff,
        // nonce 2. Display hash
        // 0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206,
        // stored here in internal order. Without this arm regtest silently
        // fell through to mainnet's genesis.
        "regtest" => [
            0x06, 0x22, 0x6e, 0x46, 0x11, 0x1a, 0x0b, 0x59, 0xca, 0xaf, 0x12, 0x60, 0x43, 0xeb,
            0x5b, 0xbf, 0x28, 0xc3, 0x4f, 0x3a, 0x5e, 0x33, 0x2a, 0x1f, 0xc7, 0xb2, 0xb7, 0x3c,
            0xf1, 0x88, 0x91, 0x0f,
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
    /// Budgets for one `getshv` attempt. `None` derives them from the
    /// transport. Set explicitly to tune a deployment, or to make a test
    /// deterministic without depending on wall-clock behaviour.
    pub shv_budget: Option<shv::ShvProbeBudget>,
}

impl Bip37Config {
    pub fn new(source_id: SourceId, endpoint: Endpoint, network: impl Into<String>) -> Self {
        Self {
            source_id,
            endpoint,
            network: network.into(),
            transport: Bip37Transport::Direct,
            shv_budget: None,
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
    /// Whether the peer advertises NODE_SHV -- i.e. it will answer `getshv`
    /// with historical header inclusion proofs.
    pub serves_shv: bool,
}

pub struct Bip37Backend {
    config: Bip37Config,
    capabilities: CapabilitySet,
    probe: NodeProbe,
    /// Read access to the runtime's accepted headers.
    ///
    /// Not a cache: this provider no longer keeps a chain of its own. It
    /// fetches headers, returns them as observations, and reads back whatever
    /// the runtime verified and accepted.
    headers: Arc<dyn BlockHeaderSource>,
    /// What the last unsuccessful SHV attempt established, and when to try
    /// again. A cooldown, not a verdict: the peer keeps every other capability
    /// it has, and is asked again once the time passes.
    shv_status: Mutex<Option<ShvCapabilityStatus>>,
}

/// Diagnostic state for one peer's proof route.
///
/// Deliberately small: a short reason and a retry time, no heights, hashes or
/// wallet material, so it can be surfaced without becoming a request log.
#[derive(Debug, Clone)]
pub struct ShvCapabilityStatus {
    pub reason: String,
    pub retry_after: tokio::time::Instant,
}

impl Bip37Backend {
    pub async fn connect(
        config: Bip37Config,
        headers: Arc<dyn BlockHeaderSource>,
    ) -> Result<Self, ChainBackendError> {
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
        if probe.serves_shv {
            // The proof route the privacy policies were missing: until a peer
            // advertises this, only an indexed Electrum server can answer a
            // historical header proof.
            capabilities.record(
                Capability::HeaderMerkleProof,
                CapabilityConfidence::Advertised,
                CapabilityDiscovery::P2pServiceBit {
                    bit: shv::NODE_SHV,
                    name: "NODE_SHV".into(),
                },
            );
        }
        Ok(Self {
            config,
            capabilities,
            probe,
            headers,
            shv_status: Mutex::new(None),
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
        // `getheaders` names its starting point by hash, so the block below
        // the requested height has to be one the runtime already accepted.
        let locator = self.headers.hash_at(start_height - 1).ok_or_else(|| {
            ChainBackendError::Rejected(format!(
                "no accepted header at {}: sync forward from the retained range {:?}",
                start_height - 1,
                self.headers.retained_span()
            ))
        })?;
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
        // Deliberately not stored here. These are unverified until the runtime
        // has checked linkage, proof-of-work and difficulty; writing them into
        // the accepted store from inside a provider is exactly the second
        // chain authority this migration removes.
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
                WalletInterest::Script(script) => {
                    let items = script_push_items(script);
                    if items.is_empty() {
                        return Err(ChainBackendError::Unsupported);
                    }
                    bloom_items.extend(items);
                }
                WalletInterest::Outpoint { .. } => {
                    if let Some(outpoint) = interest.serialized_outpoint() {
                        bloom_items.push(outpoint.to_vec());
                    }
                }
                WalletInterest::RpaPrefix(_) => return Err(ChainBackendError::Unsupported),
            }
        }
        if bloom_items.is_empty() {
            return Err(ChainBackendError::Rejected(
                "BIP37 refresh has no bloom-compatible wallet interests".into(),
            ));
        }
        // Flowee Pay gates its merkleblock download on `firstBlock() > 1` and
        // refuses to even assign peers to a wallet whose segment has no start
        // height (libs/p2p/SyncSPVAction.cpp). Treating a missing birth height
        // as "scan from block 1" is one `getdata`/`merkleblock` round trip per
        // block since genesis, which on Chipnet is ~322k round trips and does
        // not finish. Fail closed and say so instead of hanging.
        let Some(start) = from_height.map(|height| height.max(1)) else {
            return Err(ChainBackendError::Rejected(
                "BIP37 refresh needs a wallet birth height; a scan from the genesis block is not a supported sync".into(),
            ));
        };
        // One `getdata` per block, so the range has to be complete: a short
        // one would look like blocks with no wallet activity rather than
        // blocks that were never examined.
        let Some((_, tip_height)) = self.headers.retained_span() else {
            return Err(ChainBackendError::Rejected(
                "no accepted headers yet; header sync must run first".into(),
            ));
        };
        let blocks = self
            .headers
            .range_inclusive(start, tip_height)
            .map_err(|error| {
                ChainBackendError::Rejected(format!(
                    "accepted headers do not cover {start}..={tip_height}: {error:?}"
                ))
            })?;
        let tip = self
            .headers
            .tip()
            .map(|(height, hash)| ChainTip { height, hash });
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

    /// Ask a peer for one historical header plus its inclusion proof.
    ///
    /// The peer's own `target` is carried through untouched as a claim. It is
    /// the runtime's accumulator that decides whether the proof is evidence,
    /// so this observation stays `ServerAssertion` no matter what the peer
    /// asserts.
    async fn historical_header_proof(
        &self,
        height: u32,
        checkpoint_height: u32,
    ) -> Result<BackendObservation, ChainBackendError> {
        if !self.probe.serves_shv {
            return Err(ChainBackendError::Unsupported);
        }
        // A peer that already declined to answer is left alone for a while
        // rather than re-probed on every historical lookup.
        let retry_after = self
            .shv_status
            .lock()
            .await
            .as_ref()
            .map(|status| status.retry_after);
        if retry_after.is_some_and(|at| tokio::time::Instant::now() < at) {
            // Temporarily unavailable, with a reason already recorded. No
            // connection is opened.
            return Err(ChainBackendError::Timeout);
        }
        let request = shv::ShvRequest {
            target: shv::ProofTarget::Root,
            selector: shv::BlockSelector::Height(u64::from(height)),
            commitment_height: u64::from(checkpoint_height),
        };
        let payload = shv::encode_getshv(&[request]).map_err(ChainBackendError::Rejected)?;

        let budget = self
            .config
            .shv_budget
            .unwrap_or(match self.config.transport {
                Bip37Transport::Direct => shv::ShvProbeBudget::DIRECT,
                Bip37Transport::Tor { .. } => shv::ShvProbeBudget::TOR,
            });
        // Absolute, and taken before the connection so that connect, handshake,
        // send and every read share it. It is also the *only* clock on the
        // response path: `read_message`'s own per-read timeout is shorter than
        // this budget and would fire first, turning "this peer will not answer"
        // into a transport error.
        let deadline = tokio::time::Instant::now() + budget.deadline;

        let port = self
            .config
            .endpoint
            .port
            .unwrap_or_else(|| params_for(&self.config.network).default_port);
        let magic = params_for(&self.config.network).magic;

        let outcome = self
            .run_shv_attempt(&request, &payload, port, magic, deadline, budget)
            .await;

        match outcome {
            Ok(answer) => Ok(BackendObservation {
                payload: ChainPayload::HistoricalHeaderProof {
                    height,
                    checkpoint_height,
                    header: answer.header,
                    siblings: answer.proof,
                    root: answer.claimed_target,
                },
                // The peer's target is its claim. Only the runtime's
                // accumulator can promote this to HeaderMmrProven.
                evidence: Evidence::ServerAssertion,
                chain_tip: None,
            }),
            Err(failure) => Err(self.record_shv_outcome(failure).await),
        }
    }

    /// One `getshv` attempt, reported by the phase it ended in.
    async fn run_shv_attempt(
        &self,
        request: &shv::ShvRequest,
        payload: &[u8],
        port: u16,
        magic: [u8; 4],
        deadline: tokio::time::Instant,
        budget: shv::ShvProbeBudget,
    ) -> shv::ShvProbeOutcome {
        use shv::{ShvProbeFailure, ShvProbeLimit, ShvProbePhase};

        let io_timeout = io_timeout(&self.config.transport);
        let transport = |phase: ShvProbePhase, detail: String| {
            Err(ShvProbeFailure::Transport { phase, detail })
        };

        // Phase: connect. A deadline here says the peer is unreachable, which
        // is not evidence about what it serves.
        let connect = tokio::time::timeout_at(
            deadline,
            connect_peer(&self.config.endpoint.host, port, &self.config.transport),
        );
        let mut stream = match connect.await {
            Err(_) => {
                return transport(ShvProbePhase::Connect, "deadline expired".into());
            }
            Ok(Err(error)) => return transport(ShvProbePhase::Connect, error),
            Ok(Ok(stream)) => stream,
        };

        // Phase: handshake. Same reasoning — a peer that will not handshake is
        // a dead peer for every capability, not an SHV-less one.
        match tokio::time::timeout_at(deadline, handshake(&mut stream, magic, io_timeout)).await {
            Err(_) => return transport(ShvProbePhase::Handshake, "deadline expired".into()),
            Ok(Err(error)) => return transport(ShvProbePhase::Handshake, error),
            Ok(Ok(_)) => {}
        }

        // Phase: request.
        let framed = encode_message(magic, "getshv", payload);
        let sent = tokio::time::timeout_at(deadline, stream.write_all(&framed));
        match sent.await {
            Err(_) => return transport(ShvProbePhase::Request, "deadline expired".into()),
            Ok(Err(error)) => {
                return transport(
                    ShvProbePhase::Request,
                    format!("getshv send failed: {error}"),
                )
            }
            Ok(Ok(())) => {}
        }

        // Phase: awaiting the response. From here on, and only from here on,
        // an expired clock is a statement about SHV support.
        let mut remaining = budget.max_bytes;
        for _ in 0..budget.max_messages {
            let (command, body) =
                match read_message_bounded(&mut stream, magic, deadline, remaining).await {
                    Ok(message) => message,
                    Err(BoundedReadError::Deadline) => {
                        return Err(ShvProbeFailure::NotDemonstrated(ShvProbeLimit::Deadline))
                    }
                    Err(BoundedReadError::BudgetExceeded {
                        announced,
                        remaining,
                    }) => {
                        return Err(ShvProbeFailure::NotDemonstrated(ShvProbeLimit::Bytes {
                            announced,
                            remaining,
                        }))
                    }
                    Err(BoundedReadError::Framing(detail)) => {
                        return Err(ShvProbeFailure::Malformed(detail))
                    }
                    Err(BoundedReadError::Transport(detail)) => {
                        return transport(ShvProbePhase::AwaitingResponse, detail)
                    }
                };
            remaining = remaining.saturating_sub(body.len());
            match command.as_str() {
                "shv" => {
                    return match shv::decode_shv(&body) {
                        Err(detail) => Err(ShvProbeFailure::Malformed(detail)),
                        // A peer answers only what it accepted, so match on the
                        // fields the request pinned rather than on position.
                        Ok(responses) => match responses
                            .into_iter()
                            .find(|response| response.answers(request))
                        {
                            Some(answer) => Ok(answer),
                            None => Err(ShvProbeFailure::NoMatchingResponse),
                        },
                    };
                }
                "ping" => {
                    let _ = stream
                        .write_all(&encode_message(magic, "pong", &body))
                        .await;
                }
                _ => {}
            }
        }
        Err(ShvProbeFailure::NotDemonstrated(ShvProbeLimit::Messages))
    }

    /// Record what an unsuccessful attempt established, and map it to the
    /// error the planner sees.
    ///
    /// The three facts stay distinct. Only an outcome reached after the request
    /// went out puts the proof route on cooldown; a peer we could not reach has
    /// told us nothing about what it serves.
    async fn record_shv_outcome(&self, outcome: shv::ShvProbeFailure) -> ChainBackendError {
        use shv::ShvProbeFailure;

        if outcome.warrants_cooldown() {
            *self.shv_status.lock().await = Some(ShvCapabilityStatus {
                reason: outcome.reason(),
                retry_after: tokio::time::Instant::now() + shv::SHV_PROBE_COOLDOWN,
            });
        }
        match outcome {
            // Temporarily unresponsive, not unsupported: the advertisement
            // stands and the peer is asked again after the cooldown.
            ShvProbeFailure::NotDemonstrated(_) | ShvProbeFailure::NoMatchingResponse => {
                ChainBackendError::Timeout
            }
            // Something we could not parse. Observed, not judged.
            ShvProbeFailure::Malformed(detail) => ChainBackendError::InvalidResponse(detail),
            ShvProbeFailure::Transport { phase, detail } => {
                debug_assert!(!phase.informs_shv_support());
                ChainBackendError::Protocol(detail)
            }
        }
    }

    /// Current diagnostic status of this peer's proof route, if an attempt has
    /// left one. Carries a reason and a retry time, and no request detail.
    pub async fn shv_capability_status(&self) -> Option<ShvCapabilityStatus> {
        self.shv_status.lock().await.clone()
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
        handshake(&mut stream, magic, io_timeout(&self.config.transport))
            .await
            .map_err(ChainBackendError::Protocol)?;
        relay_tx_on_stream(
            &mut stream,
            magic,
            raw_tx,
            txid,
            io_timeout(&self.config.transport),
        )
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
            ChainOperation::HistoricalHeaderProof => self.probe.serves_shv,
            ChainOperation::TransactionLookup => false,
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
                ChainRequest::HistoricalHeaderProof {
                    height,
                    checkpoint_height,
                } => {
                    self.historical_header_proof(*height, *checkpoint_height)
                        .await
                }
                ChainRequest::TransactionLookup { .. } => Err(ChainBackendError::Unsupported),
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
/// Why a bounded read stopped.
///
/// Separated from `read_message`'s stringly error on purpose: the SHV probe
/// has to tell "the clock ran out" apart from "the frame was unparsable" apart
/// from "the socket broke", and a formatted string cannot carry that.
#[derive(Debug)]
enum BoundedReadError {
    /// The shared attempt deadline expired.
    Deadline,
    /// The announced payload would exceed the remaining budget. Refused before
    /// allocating or downloading it.
    BudgetExceeded { announced: usize, remaining: usize },
    /// Bad magic, oversized declared length, or a checksum mismatch.
    Framing(String),
    /// The socket itself failed.
    Transport(String),
}

/// Read one framed message under an absolute deadline and a byte budget.
///
/// Two differences from [`read_message`] that the probe needs:
///
/// * the only clock is `deadline`. `read_message` applies its own per-read
///   timeout, which is shorter than the probe's budget and would fire first,
///   turning "this peer will not answer" into a transport error;
/// * `remaining_bytes` is checked against the length the header *announces*,
///   before any allocation, so an oversized frame costs nothing to refuse.
///
/// The budget counts payload bytes; the 24-byte wire header is not charged.
async fn read_message_bounded<S: AsyncReadExt + Unpin>(
    stream: &mut S,
    magic: [u8; 4],
    deadline: tokio::time::Instant,
    remaining_bytes: usize,
) -> Result<(String, Vec<u8>), BoundedReadError> {
    let mut header = [0u8; 24];
    tokio::time::timeout_at(deadline, stream.read_exact(&mut header))
        .await
        .map_err(|_| BoundedReadError::Deadline)?
        .map_err(|e| BoundedReadError::Transport(format!("read failed: {e}")))?;
    if header[..4] != magic {
        return Err(BoundedReadError::Framing(
            "bad network magic — wrong network or not a BCH node".into(),
        ));
    }
    let end = header[4..16].iter().position(|&b| b == 0).unwrap_or(12);
    let command = String::from_utf8_lossy(&header[4..4 + end]).into_owned();
    let len = u32::from_le_bytes(header[16..20].try_into().expect("fixed slice")) as usize;
    if len > MAX_PAYLOAD {
        return Err(BoundedReadError::Framing(format!(
            "node message too large: {len}"
        )));
    }
    // Before the allocation, not after it.
    if len > remaining_bytes {
        return Err(BoundedReadError::BudgetExceeded {
            announced: len,
            remaining: remaining_bytes,
        });
    }
    let mut payload = vec![0u8; len];
    tokio::time::timeout_at(deadline, stream.read_exact(&mut payload))
        .await
        .map_err(|_| BoundedReadError::Deadline)?
        .map_err(|e| BoundedReadError::Transport(format!("read failed: {e}")))?;
    if double_sha256(&payload)[..4] != header[20..24] {
        return Err(BoundedReadError::Framing(format!(
            "bad checksum on '{command}' message"
        )));
    }
    Ok((command, payload))
}

async fn read_message<S: AsyncReadExt + Unpin>(
    stream: &mut S,
    magic: [u8; 4],
    io_timeout: Duration,
) -> Result<(String, Vec<u8>), String> {
    let mut header = [0u8; 24];
    tokio::time::timeout(io_timeout, stream.read_exact(&mut header))
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
    tokio::time::timeout(io_timeout, stream.read_exact(&mut payload))
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
        serves_shv: services & shv::NODE_SHV != 0,
    })
}
async fn handshake<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
    magic: [u8; 4],
    io_timeout: Duration,
) -> Result<NodeProbe, String> {
    stream
        .write_all(&encode_message(magic, "version", &build_version_payload(0)))
        .await
        .map_err(|e| format!("version send failed: {e}"))?;
    for _ in 0..20 {
        let (command, payload) = read_message(stream, magic, io_timeout).await?;
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
                TOR_CONNECT_TIMEOUT,
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
    handshake(
        &mut stream,
        params_for(network).magic,
        io_timeout(transport),
    )
    .await
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
    handshake(&mut stream, magic, io_timeout(transport)).await?;
    stream
        .write_all(&encode_message(
            magic,
            "getheaders",
            &build_getheaders_payload(&locator),
        ))
        .await
        .map_err(|e| format!("getheaders send failed: {e}"))?;
    for _ in 0..100 {
        let (cmd, payload) = read_message(&mut stream, magic, io_timeout(transport)).await?;
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
    let probe = handshake(&mut stream, magic, io_timeout(transport)).await?;
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
        // The peer decides what to send back, so every answer has to be tied
        // to what was asked for. A partial merkle tree only proves that its
        // hashes sit under the merkle root in the header attached to it, and
        // that header arrived from the same peer: on its own it proves a peer
        // can build a consistent tree, not that any of this is on the chain.
        // The block hash comes from the accepted header store, which is where
        // proof-of-work, linkage and difficulty were checked, so requiring the
        // returned header to hash to it is what makes the proof mean anything.
        let mut proven: Option<Vec<[u8; 32]>> = None;
        let mut delivered: Vec<[u8; 32]> = Vec::new();
        for _ in 0..MAX_MESSAGES {
            let (cmd, payload) = read_message(&mut stream, magic, io_timeout(transport)).await?;
            match cmd.as_str() {
                "merkleblock" => {
                    if proven.is_some() {
                        return Err(format!(
                            "peer sent more than one merkle proof for block {height}"
                        ));
                    }
                    let mb = merkleblock::parse_merkleblock(&payload)?;
                    if !mb.valid {
                        return Err("merkleblock failed verification during scan".into());
                    }
                    if double_sha256(&mb.header) != *block_hash {
                        return Err(format!(
                            "peer answered the request for block {height} with a different block"
                        ));
                    }
                    proven = Some(mb.matched_txids);
                }
                "tx" => {
                    // BIP37 sends the proof ahead of the transactions it
                    // commits to. One arriving first has nothing vouching for
                    // it, and accepting it would credit the wallet with a
                    // transaction no merkle root covers.
                    let Some(proven) = proven.as_ref() else {
                        return Err(format!(
                            "peer sent a transaction for block {height} before its merkle proof"
                        ));
                    };
                    let parsed = tx::parse_tx(&payload)?;
                    if !proven.contains(&parsed.txid) {
                        return Err(format!(
                            "peer sent a transaction the merkle proof for block {height} does not commit to"
                        ));
                    }
                    if delivered.contains(&parsed.txid) {
                        continue;
                    }
                    delivered.push(parsed.txid);
                    observed.push(ObservedTransaction {
                        txid: parsed.txid,
                        raw: parsed.raw,
                        block_height: Some(*height),
                    });
                }
                "ping" => {
                    let _ = stream
                        .write_all(&encode_message(magic, "pong", &payload))
                        .await;
                }
                _ => {}
            }
            if proven.as_ref().is_some_and(|txids| delivered.len() >= txids.len()) {
                break;
            }
        }
        let Some(proven) = proven else {
            return Err("node did not return merkleblock".into());
        };
        if delivered.len() < proven.len() {
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
    io_timeout: Duration,
) -> Result<bool, String> {
    stream
        .write_all(&encode_message(magic, "inv", &build_getdata(MSG_TX, &txid)))
        .await
        .map_err(|e| format!("inv send failed: {e}"))?;
    let exchange = async {
        for _ in 0..30 {
            let (cmd, payload) = read_message(stream, magic, io_timeout).await?;
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

    #[tokio::test]
    async fn unsupported_scope_is_rejected_before_scanning_blocks() {
        let backend = Bip37Backend {
            config: Bip37Config::new(
                SourceId::new("local-test"),
                Endpoint {
                    kind: EndpointKind::BchP2p,
                    host: "127.0.0.1".into(),
                    port: Some(1),
                },
                "chipnet",
            ),
            capabilities: CapabilitySet::default(),
            probe: NodeProbe {
                user_agent: "test".into(),
                protocol_version: 70015,
                services: 4,
                start_height: 0,
                serves_bloom: true,
                serves_shv: false,
            },
            headers: test_headers(),
            shv_status: Mutex::new(None),
        };
        for unsupported in [
            WalletInterest::rpa_prefix("ab").unwrap(),
            WalletInterest::script(vec![0x51]),
            WalletInterest::script(vec![]),
        ] {
            assert_eq!(
                backend
                    .wallet_refresh(&[WalletInterest::script(vec![1, 0x51]), unsupported,], None)
                    .await,
                Err(ChainBackendError::Unsupported)
            );
        }
    }

    #[tokio::test]
    async fn a_missing_birth_height_is_refused_rather_than_scanned_from_genesis() {
        // Flowee Pay will not start an SPV download for a segment whose
        // firstBlock() is unset, because the alternative is one merkleblock
        // round trip per block since genesis. Neither will we.
        let backend = Bip37Backend {
            config: Bip37Config::new(
                SourceId::new("local-test"),
                Endpoint {
                    kind: EndpointKind::BchP2p,
                    host: "127.0.0.1".into(),
                    port: Some(1),
                },
                "chipnet",
            ),
            capabilities: CapabilitySet::default(),
            probe: NodeProbe {
                user_agent: "test".into(),
                protocol_version: 70015,
                services: 4,
                start_height: 0,
                serves_bloom: true,
                serves_shv: false,
            },
            headers: test_headers(),
            shv_status: Mutex::new(None),
        };
        let mut script = vec![0x76, 0xa9, 0x14];
        script.extend_from_slice(&[9; 20]);
        script.extend_from_slice(&[0x88, 0xac]);
        let interests = [WalletInterest::script(script)];

        let refused = backend.wallet_refresh(&interests, None).await;
        assert!(
            matches!(&refused, Err(ChainBackendError::Rejected(message))
                if message.contains("birth height")),
            "expected a birth-height refusal, got {refused:?}"
        );

        // With a birth height the request gets past the gate and fails later,
        // on coverage: the shared store holds only genesis, so it cannot
        // supply a contiguous 500..=tip range. The message names the gap
        // rather than reporting an empty scan.
        let uncovered = backend.wallet_refresh(&interests, Some(500)).await;
        assert!(
            matches!(&uncovered, Err(ChainBackendError::Rejected(message))
                if message.contains("do not cover")),
            "expected a coverage refusal, got {uncovered:?}"
        );
    }

    fn probe(serves_shv: bool) -> NodeProbe {
        NodeProbe {
            user_agent: "test".into(),
            protocol_version: 70015,
            services: 4 | if serves_shv { shv::NODE_SHV } else { 0 },
            start_height: 0,
            serves_bloom: true,
            serves_shv,
        }
    }

    fn backend_with(probe: NodeProbe) -> Bip37Backend {
        Bip37Backend {
            config: Bip37Config::new(
                SourceId::new("local-test"),
                Endpoint {
                    kind: EndpointKind::BchP2p,
                    host: "127.0.0.1".into(),
                    port: Some(1),
                },
                "chipnet",
            ),
            capabilities: CapabilitySet::default(),
            probe,
            headers: test_headers(),
            shv_status: Mutex::new(None),
        }
    }

    /// Historical header proofs are gated on the peer's own advertisement.
    ///
    /// The reference node advertises `NODE_SHV` only when its MMR index is
    /// built, and ignores `getshv` entirely otherwise
    /// (`test/functional/bchn-p2p-shv.py`, `test_service_bit` and
    /// `test_disabled_mmrindex`). Claiming the capability against a peer that
    /// does not advertise it would turn a silent non-answer into a stall.
    #[tokio::test]
    async fn historical_header_proofs_follow_the_peers_node_shv_bit() {
        let without = backend_with(probe(false));
        assert!(!without.supports(ChainOperation::HistoricalHeaderProof));
        assert_eq!(
            without.historical_header_proof(1, 2).await,
            Err(ChainBackendError::Unsupported),
            "no advertisement means no request is sent at all"
        );

        let with = backend_with(probe(true));
        assert!(with.supports(ChainOperation::HistoricalHeaderProof));

        // Headers are served either way; the proof is the part that is gated.
        assert!(without.supports(ChainOperation::HeaderSync));
        assert!(with.supports(ChainOperation::HeaderSync));
    }

    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    /// What the scripted peer does once it has the request in hand.
    #[derive(Clone, Copy)]
    enum PeerScript {
        /// Handshake, confirm `getshv` arrived, then say nothing at all.
        MuteAfterRequest,
        /// Handshake, confirm `getshv`, then send unrelated traffic forever.
        ChatterAfterRequest,
        /// Handshake, confirm `getshv`, then announce a payload larger than
        /// the byte budget without ever sending the body.
        OversizedBodyAfterRequest,
        /// Accept the socket and never send a version.
        StallDuringHandshake,
    }

    /// A deliberately tiny byte budget, so the fixture needs no large writes
    /// and cannot race the scheduler under a paused clock.
    const TEST_BYTE_BUDGET: usize = 1_024;
    /// Legal filler that consumes most of that budget.
    const FILLER_PAYLOAD: usize = 768;
    /// Under MAX_PAYLOAD, over what remains after the filler.
    const OVERSIZED_ANNOUNCE: usize = 512;

    struct ScriptedPeer {
        port: u16,
        /// Connections accepted. Proves whether an attempt reached the wire.
        connections: Arc<AtomicUsize>,
        /// `getshv` messages actually parsed off the socket.
        requests: Arc<AtomicUsize>,
        handle: tokio::task::JoinHandle<()>,
    }

    impl ScriptedPeer {
        fn connections(&self) -> usize {
            self.connections.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn requests(&self) -> usize {
            self.requests.load(std::sync::atomic::Ordering::SeqCst)
        }

        /// Wait for the peer's task to account for `expected` requests.
        ///
        /// The client returning `Timeout` only says the client gave up. The
        /// peer parses and counts on its own task, so reading the counter the
        /// instant the client returns is a race -- one a quiet machine wins
        /// and a loaded CI runner loses. Yielding until the count arrives
        /// turns that into a wait rather than a coin toss; the assertion after
        /// it still has to hold.
        async fn await_requests(&self, expected: usize) {
            for _ in 0..10_000 {
                if self.requests() >= expected {
                    return;
                }
                tokio::task::yield_now().await;
            }
        }
    }

    /// Read one framed message straight off the socket, test-side.
    async fn peer_read_message(socket: &mut tokio::net::TcpStream) -> Option<(String, Vec<u8>)> {
        let mut header = [0u8; 24];
        tokio::io::AsyncReadExt::read_exact(socket, &mut header)
            .await
            .ok()?;
        let end = header[4..16].iter().position(|&b| b == 0).unwrap_or(12);
        let command = String::from_utf8_lossy(&header[4..4 + end]).into_owned();
        let len = u32::from_le_bytes(header[16..20].try_into().unwrap()) as usize;
        let mut payload = vec![0u8; len];
        tokio::io::AsyncReadExt::read_exact(socket, &mut payload)
            .await
            .ok()?;
        Some((command, payload))
    }

    async fn spawn_scripted_peer(script: PeerScript) -> ScriptedPeer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let magic = params_for("chipnet").magic;
        let connections = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(AtomicUsize::new(0));
        let (conn_counter, req_counter) = (connections.clone(), requests.clone());

        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                conn_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let req_counter = req_counter.clone();
                // One task per connection: a script that parks forever must
                // not stop the listener accepting the next attempt.
                tokio::spawn(async move {
                    if matches!(script, PeerScript::StallDuringHandshake) {
                        // Hold the socket open and send nothing.
                        std::future::pending::<()>().await;
                    }
                    let _ = socket
                        .write_all(&encode_message(magic, "version", &build_version_payload(0)))
                        .await;
                    let _ = socket
                        .write_all(&encode_message(magic, "verack", &[]))
                        .await;

                    // Drain until the request we are scripted around actually
                    // arrives, so a later assertion cannot pass from an earlier
                    // phase.
                    loop {
                        let Some((command, _)) = peer_read_message(&mut socket).await else {
                            break;
                        };
                        if command == "getshv" {
                            req_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            break;
                        }
                    }

                    match script {
                        PeerScript::MuteAfterRequest | PeerScript::StallDuringHandshake => {
                            std::future::pending::<()>().await;
                        }
                        PeerScript::ChatterAfterRequest => loop {
                            // Unrelated, individually cheap, and never `shv`.
                            if socket
                                .write_all(&encode_message(magic, "addr", &[0u8; 8]))
                                .await
                                .is_err()
                            {
                                break;
                            }
                            tokio::task::yield_now().await;
                        },
                        PeerScript::OversizedBodyAfterRequest => {
                            // First spend most of the byte budget on a legal
                            // message, so the next announcement is under the
                            // per-message maximum but over what is left.
                            let filler = vec![0u8; FILLER_PAYLOAD];
                            let _ = socket
                                .write_all(&encode_message(magic, "addr", &filler))
                                .await;
                            // Then announce a body that is legal in isolation and
                            // too large for the remaining budget -- and never send
                            // it. A client that waits for the body instead of
                            // checking the announced length would hang here.
                            let announced = OVERSIZED_ANNOUNCE as u32;
                            let mut frame = Vec::new();
                            frame.extend_from_slice(&magic);
                            let mut cmd = [0u8; 12];
                            cmd[..3].copy_from_slice(b"shv");
                            frame.extend_from_slice(&cmd);
                            frame.extend_from_slice(&announced.to_le_bytes());
                            frame.extend_from_slice(&[0u8; 4]);
                            let _ = socket.write_all(&frame).await;
                            std::future::pending::<()>().await;
                        }
                    }
                });
            }
        });

        ScriptedPeer {
            port,
            connections,
            requests,
            handle,
        }
    }

    /// A shared store seeded with genesis, standing in for the runtime's.
    fn test_headers() -> Arc<dyn BlockHeaderSource> {
        let store = optn_runtime::header_store::SharedHeaders::default();
        store.write(|retained| retained.insert_hash_only(0, genesis_hash("chipnet")));
        Arc::new(store)
    }

    fn backend_at(port: u16, serves_shv: bool) -> Bip37Backend {
        Bip37Backend {
            config: Bip37Config::new(
                SourceId::new("local-test"),
                Endpoint {
                    kind: EndpointKind::BchP2p,
                    host: "127.0.0.1".into(),
                    port: Some(port),
                },
                "chipnet",
            ),
            capabilities: CapabilitySet::default(),
            probe: probe(serves_shv),
            headers: test_headers(),
            shv_status: Mutex::new(None),
        }
    }

    /// Same peer, but with the byte budget shrunk so the oversized-body case
    /// is exercised by an announced length rather than by a large transfer.
    fn backend_with_tiny_byte_budget(port: u16) -> Bip37Backend {
        let mut backend = backend_at(port, true);
        backend.config.shv_budget = Some(shv::ShvProbeBudget {
            max_bytes: TEST_BYTE_BUDGET,
            // Short, and real. Its only job is to stop a genuine regression
            // hanging the suite; the byte budget is what the one test using
            // this helper is about, and DIRECT's 30 seconds is long enough to
            // be reached only if something is actually wrong.
            deadline: std::time::Duration::from_secs(5),
            ..shv::ShvProbeBudget::DIRECT
        });
        backend
    }

    /// The handshake completes, the request lands, and then nothing comes back.
    ///
    /// The peer confirms it parsed `getshv` before going quiet, so this cannot
    /// pass from an earlier phase. The inner per-read timeout (15s direct) is
    /// shorter than the probe deadline (30s), which is exactly the case that
    /// used to escape as `Protocol`.
    #[tokio::test(start_paused = true)]
    async fn silence_after_the_request_is_temporary_not_a_protocol_error() {
        let peer = spawn_scripted_peer(PeerScript::MuteAfterRequest).await;
        let backend = backend_at(peer.port, true);

        let outcome = backend.historical_header_proof(1, 2).await;
        assert_eq!(
            outcome,
            Err(ChainBackendError::Timeout),
            "temporarily unresponsive, not a broken connection"
        );
        peer.await_requests(1).await;
        assert_eq!(peer.requests(), 1, "the request really did reach the peer");

        let status = backend
            .shv_capability_status()
            .await
            .expect("an inconclusive attempt records a status");
        assert!(
            status.reason.contains("no shv reply"),
            "reason should name the budget: {}",
            status.reason
        );
        assert!(status.retry_after > tokio::time::Instant::now());

        // During the cooldown no new connection is opened at all.
        let before = peer.connections();
        assert_eq!(
            backend.historical_header_proof(1, 2).await,
            Err(ChainBackendError::Timeout)
        );
        assert_eq!(
            peer.connections(),
            before,
            "cooldown short-circuits dialing"
        );

        peer.handle.abort();
    }

    /// Unrelated traffic must not renew the wait: the deadline is absolute.
    #[tokio::test(start_paused = true)]
    async fn chatter_cannot_renew_the_deadline() {
        let peer = spawn_scripted_peer(PeerScript::ChatterAfterRequest).await;
        let backend = backend_at(peer.port, true);

        let outcome = backend.historical_header_proof(1, 2).await;
        assert_eq!(outcome, Err(ChainBackendError::Timeout));
        peer.await_requests(1).await;
        assert_eq!(peer.requests(), 1);

        let status = backend.shv_capability_status().await.expect("status");
        assert!(
            status.reason.contains("no shv reply"),
            "ran out of a budget: {}",
            status.reason
        );

        peer.handle.abort();
    }

    /// The byte budget is enforced against the announced length, before the
    /// body is read. The peer never sends the body, so a client that waited
    /// for it would hang until the deadline instead of refusing immediately.
    ///
    /// Real time on purpose, unlike its neighbours. Two refusals race here --
    /// the announced length overrunning the byte budget, and the deadline --
    /// and the test asserts which one wins. Under `start_paused` tokio
    /// advances the clock whenever every task is idle, and a client blocked on
    /// a real socket read is idle, so the runtime would jump straight to the
    /// deadline before the peer's announcement had been read. A quiet machine
    /// delivered the bytes first and a loaded CI runner did not, which is
    /// exactly the intermittent failure this replaces. With a real clock the
    /// announcement is already on the wire and wins deterministically.
    #[tokio::test]
    async fn an_oversized_announced_body_is_refused_before_it_is_downloaded() {
        let peer = spawn_scripted_peer(PeerScript::OversizedBodyAfterRequest).await;
        let backend = backend_with_tiny_byte_budget(peer.port);

        let outcome = backend.historical_header_proof(1, 2).await;
        assert_eq!(outcome, Err(ChainBackendError::Timeout));
        peer.await_requests(1).await;
        assert_eq!(peer.requests(), 1);

        let status = backend.shv_capability_status().await.expect("status");
        assert!(
            status.reason.contains("byte budget"),
            "the byte budget is what stopped it, not the clock: {}",
            status.reason
        );

        peer.handle.abort();
    }

    /// A peer that will not handshake is a dead peer for every capability.
    /// That is not evidence about SHV, so it sets no cooldown.
    #[tokio::test(start_paused = true)]
    async fn a_handshake_stall_is_transport_and_sets_no_cooldown() {
        let peer = spawn_scripted_peer(PeerScript::StallDuringHandshake).await;
        let backend = backend_at(peer.port, true);

        let outcome = backend.historical_header_proof(1, 2).await;
        assert!(
            matches!(outcome, Err(ChainBackendError::Protocol(_))),
            "expected a transport error, got {outcome:?}"
        );
        assert_eq!(peer.requests(), 0, "no request was ever sent");
        assert!(
            backend.shv_capability_status().await.is_none(),
            "reachability is not a statement about SHV support"
        );

        // So the next attempt still dials, rather than being short-circuited.
        let before = peer.connections();
        let _ = backend.historical_header_proof(1, 2).await;
        assert!(peer.connections() > before, "no cooldown was applied");

        peer.handle.abort();
    }

    /// A refused connection is likewise transport, and likewise no cooldown.
    #[tokio::test]
    async fn a_refused_connection_stays_a_protocol_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let backend = backend_at(port, true);
        let outcome = backend.historical_header_proof(1, 2).await;
        assert!(
            matches!(outcome, Err(ChainBackendError::Protocol(_))),
            "a refused connection is not an undemonstrated capability: {outcome:?}"
        );
        assert!(backend.shv_capability_status().await.is_none());
    }

    /// The cooldown is a delay, not a verdict.
    #[tokio::test(start_paused = true)]
    async fn an_inconclusive_probe_does_not_disable_other_capabilities() {
        let peer = spawn_scripted_peer(PeerScript::MuteAfterRequest).await;
        let backend = backend_at(peer.port, true);
        assert_eq!(
            backend.historical_header_proof(1, 2).await,
            Err(ChainBackendError::Timeout)
        );

        assert!(backend.supports(ChainOperation::HeaderSync));
        assert!(backend.supports(ChainOperation::Broadcast));
        assert!(backend.probe.serves_bloom, "Bloom support is unaffected");
        assert!(backend.probe.serves_shv, "the advertisement stands");
        assert!(
            backend.supports(ChainOperation::HistoricalHeaderProof),
            "and the capability is not written off permanently"
        );

        peer.handle.abort();
    }

    /// Once the cooldown expires the peer is dialled again.
    #[tokio::test(start_paused = true)]
    async fn a_later_attempt_dials_again_after_the_cooldown_expires() {
        let peer = spawn_scripted_peer(PeerScript::MuteAfterRequest).await;
        let backend = backend_at(peer.port, true);
        assert_eq!(
            backend.historical_header_proof(1, 2).await,
            Err(ChainBackendError::Timeout)
        );
        let after_first = peer.connections();

        tokio::time::advance(shv::SHV_PROBE_COOLDOWN + std::time::Duration::from_secs(1)).await;

        assert_eq!(
            backend.historical_header_proof(1, 2).await,
            Err(ChainBackendError::Timeout)
        );
        assert!(
            peer.connections() > after_first,
            "an expired cooldown lets the next attempt reach the wire"
        );
        peer.await_requests(2).await;
        assert_eq!(peer.requests(), 2, "and the request is sent again");

        peer.handle.abort();
    }

    /// Phase classification is the rule the mapping depends on.
    #[test]
    fn only_the_response_phase_says_anything_about_shv_support() {
        use shv::{ShvProbeFailure, ShvProbeLimit, ShvProbePhase};
        for phase in [
            ShvProbePhase::Connect,
            ShvProbePhase::Handshake,
            ShvProbePhase::Request,
        ] {
            assert!(!phase.informs_shv_support(), "{phase:?}");
            assert!(!ShvProbeFailure::Transport {
                phase,
                detail: "x".into()
            }
            .warrants_cooldown());
        }
        assert!(ShvProbePhase::AwaitingResponse.informs_shv_support());
        for limit in [
            ShvProbeLimit::Deadline,
            ShvProbeLimit::Messages,
            ShvProbeLimit::Bytes {
                announced: 1,
                remaining: 0,
            },
        ] {
            assert!(ShvProbeFailure::NotDemonstrated(limit).warrants_cooldown());
        }
        assert!(ShvProbeFailure::NoMatchingResponse.warrants_cooldown());
        // A frame we could not parse is observed behaviour, and does not put
        // the route on cooldown -- a version mismatch looks like this too.
        assert!(!ShvProbeFailure::Malformed("bad".into()).warrants_cooldown());
    }

    /// The budgets are three independent bounds.
    #[test]
    fn the_probe_budgets_are_bounded_and_tor_only_moves_the_clock() {
        let direct = shv::ShvProbeBudget::DIRECT;
        let tor = shv::ShvProbeBudget::TOR;
        assert!(
            tor.deadline > direct.deadline,
            "Tor gets longer, not looser"
        );
        assert_eq!(tor.max_messages, direct.max_messages);
        assert_eq!(tor.max_bytes, direct.max_bytes);
        assert_eq!(direct.max_messages, shv::MAX_MESSAGES_AWAITING_SHV);
        assert_eq!(direct.max_bytes, shv::MAX_BYTES_AWAITING_SHV);
        // The deadline must exceed the inner per-read timeouts, or the inner
        // timer would decide the outcome instead of the phase logic.
        assert!(direct.deadline > IO_TIMEOUT);
        assert!(tor.deadline > TOR_IO_TIMEOUT);
    }

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

    /// A merkle proof is only worth what its header is worth.
    ///
    /// A partial merkle tree proves its hashes hang under the merkle root of
    /// the header sent alongside it. Both come from the peer, so a peer that
    /// invents a header, puts whatever transactions it likes underneath, and
    /// builds a consistent tree produces something that verifies against
    /// itself. What makes it evidence is the block hash from the accepted
    /// header store, where proof-of-work, linkage and difficulty were already
    /// checked. These fixtures cover a peer answering with the wrong block,
    /// and a peer answering with the right block but the wrong transactions.
    mod merkle_binding {
        use super::*;
        use optn_runtime::header_store::{BlockHeaderSource, SharedHeaders};

        /// Coinbase-shaped and parseable; the contents do not matter, only
        /// that a peer could offer it and that it hashes to something.
        fn payment(marker: u8) -> Vec<u8> {
            let mut raw = Vec::new();
            raw.extend_from_slice(&1u32.to_le_bytes()); // version
            raw.push(1); // one input
            raw.extend_from_slice(&[0u8; 32]); // null outpoint
            raw.extend_from_slice(&0xffff_ffffu32.to_le_bytes());
            raw.push(2); // scriptSig: the marker keeps txids distinct
            raw.extend_from_slice(&[marker, marker]);
            raw.extend_from_slice(&0xffff_ffffu32.to_le_bytes()); // sequence
            raw.push(1); // one output
            raw.extend_from_slice(&5_000_000_000u64.to_le_bytes());
            raw.push(25);
            raw.extend_from_slice(&[0x76, 0xa9, 0x14]);
            raw.extend_from_slice(&[marker; 20]);
            raw.extend_from_slice(&[0x88, 0xac]);
            raw.extend_from_slice(&0u32.to_le_bytes()); // locktime
            raw
        }

        /// A header committing to exactly one transaction, so the merkle root
        /// is that txid. `marker` also varies the header, keeping the two
        /// blocks distinguishable by hash.
        fn header_over(txid: &[u8; 32], marker: u8) -> [u8; 80] {
            let mut header = [0u8; 80];
            header[0] = marker;
            header[36..68].copy_from_slice(txid);
            header
        }

        /// The wire form of a single-transaction partial merkle tree.
        fn merkleblock_payload(header: &[u8; 80], txid: &[u8; 32]) -> Vec<u8> {
            let mut payload = Vec::new();
            payload.extend_from_slice(header);
            payload.extend_from_slice(&1u32.to_le_bytes()); // one transaction
            payload.push(1); // one hash
            payload.extend_from_slice(txid);
            payload.push(1); // one flag byte
            payload.push(0x01); // matched leaf
            payload
        }

        /// Advertises NODE_BLOOM, because a scan is refused without it.
        fn bloom_version() -> Vec<u8> {
            let mut p = Vec::new();
            p.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
            p.extend_from_slice(&NODE_BLOOM.to_le_bytes());
            p.extend_from_slice(&0i64.to_le_bytes());
            p.extend_from_slice(&[0u8; 26]);
            p.extend_from_slice(&[0u8; 26]);
            p.extend_from_slice(&0u64.to_le_bytes());
            write_varstr(&mut p, b"/scripted-peer/");
            p.extend_from_slice(&0i32.to_le_bytes());
            p.push(0);
            p
        }

        /// Handshakes, then answers every `getdata` with the same scripted
        /// merkleblock and transactions regardless of what was asked for.
        async fn spawn_peer(merkleblock: Vec<u8>, txs: Vec<Vec<u8>>) -> u16 {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let magic = params_for("chipnet").magic;
            tokio::spawn(async move {
                while let Ok((mut socket, _)) = listener.accept().await {
                    let (merkleblock, txs) = (merkleblock.clone(), txs.clone());
                    tokio::spawn(async move {
                        let _ = socket
                            .write_all(&encode_message(magic, "version", &bloom_version()))
                            .await;
                        let _ = socket.write_all(&encode_message(magic, "verack", &[])).await;
                        while let Some((command, _)) = peer_read_message(&mut socket).await {
                            if command != "getdata" {
                                continue;
                            }
                            let _ = socket
                                .write_all(&encode_message(magic, "merkleblock", &merkleblock))
                                .await;
                            for tx in &txs {
                                let _ = socket.write_all(&encode_message(magic, "tx", tx)).await;
                            }
                        }
                    });
                }
            });
            port
        }

        /// One accepted block at height 7, and a scan asking only for it.
        async fn refresh_against(
            port: u16,
            accepted: [u8; 80],
        ) -> Result<BackendObservation, ChainBackendError> {
            let headers = Arc::new(SharedHeaders::default());
            headers.write(|store| store.insert_hash_only(7, double_sha256(&accepted)));
            let backend = Bip37Backend::connect(
                Bip37Config::new(
                    SourceId::new("scripted"),
                    Endpoint {
                        kind: EndpointKind::BchP2p,
                        host: "127.0.0.1".into(),
                        port: Some(port),
                    },
                    "chipnet",
                ),
                headers as Arc<dyn BlockHeaderSource>,
            )
            .await
            .expect("the scripted peer completes a handshake");
            backend
                .execute(&ChainRequest::WalletRefresh {
                    interests: vec![WalletInterest::script(vec![
                        0x76, 0xa9, 0x14, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11,
                        0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x88,
                        0xac,
                    ])],
                    from_height: Some(7),
                })
                .await
        }

        #[tokio::test]
        async fn a_self_consistent_proof_for_another_block_is_refused() {
            // The block the wallet accepted, and a block the peer made up.
            let honest = payment(0x11);
            let honest_header = header_over(&double_sha256(&honest), 0x11);
            let forged = payment(0x22);
            let forged_txid = double_sha256(&forged);
            let forged_header = header_over(&forged_txid, 0x22);

            // The forgery verifies against itself: that is the whole point.
            let payload = merkleblock_payload(&forged_header, &forged_txid);
            let parsed = merkleblock::parse_merkleblock(&payload).unwrap();
            assert!(parsed.valid, "the forged proof is internally consistent");
            assert_eq!(parsed.matched_txids, vec![forged_txid]);
            assert_ne!(double_sha256(&forged_header), double_sha256(&honest_header));

            let port = spawn_peer(payload, vec![forged]).await;
            match refresh_against(port, honest_header).await {
                Err(ChainBackendError::Protocol(message)) => assert!(
                    message.contains("different block"),
                    "expected the block-binding refusal, got: {message}"
                ),
                other => panic!("a forged block was not refused: {other:?}"),
            }
        }

        #[tokio::test]
        async fn a_transaction_the_proof_does_not_cover_is_refused() {
            // The right block, so the header check passes, then a transaction
            // the merkle root says nothing about.
            let honest = payment(0x11);
            let honest_header = header_over(&double_sha256(&honest), 0x11);
            let smuggled = payment(0x33);

            let payload = merkleblock_payload(&honest_header, &double_sha256(&honest));
            let port = spawn_peer(payload, vec![smuggled]).await;
            match refresh_against(port, honest_header).await {
                Err(ChainBackendError::Protocol(message)) => assert!(
                    message.contains("does not commit to"),
                    "expected the transaction-binding refusal, got: {message}"
                ),
                other => panic!("an uncommitted transaction was not refused: {other:?}"),
            }
        }

        /// The control: the checks above reject forgeries, not everything.
        #[tokio::test]
        async fn the_matching_block_and_its_own_transaction_are_accepted() {
            let honest = payment(0x11);
            let txid = double_sha256(&honest);
            let honest_header = header_over(&txid, 0x11);

            let payload = merkleblock_payload(&honest_header, &txid);
            let port = spawn_peer(payload, vec![honest.clone()]).await;
            let observation = refresh_against(port, honest_header)
                .await
                .expect("an honest answer is accepted");
            let ChainPayload::WalletRefresh { transactions, .. } = observation.payload else {
                panic!("expected a WalletRefresh payload");
            };
            assert_eq!(transactions.len(), 1);
            assert_eq!(transactions[0].txid, txid);
            assert_eq!(transactions[0].raw, honest);
            assert_eq!(transactions[0].block_height, Some(7));
        }
    }
}
