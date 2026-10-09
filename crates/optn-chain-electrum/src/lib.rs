#![forbid(unsafe_code)]

//! Rust-native Electrum/Fulcrum adapter for OPTN's provider-neutral chain runtime.
//! The adapter owns wire translation, not wallet state or verification policy.

use optn_core::header_hash::sha256d;
use optn_runtime::chain::{
    Capability, CapabilityConfidence, CapabilityDiscovery, CapabilitySet, Endpoint, EndpointKind,
    Evidence, ProtocolFamily, ProviderHealth, SourceId,
};
use optn_runtime::chain_service::{
    BackendObservation, ChainBackend, ChainBackendError, ChainFuture, ChainOperation, ChainPayload,
    ChainRequest, ChainTip, ObservedTransaction, OutpointSpentness, WalletInterest,
};
use optn_runtime::tx_broadcast::{classify_node_message, NodeBroadcastReply, MEMPOOL_CONFLICT};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::{timeout, Instant};
use tokio_rustls::rustls::{pki_types::ServerName, ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

trait AsyncIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T> AsyncIo for T where T: AsyncRead + AsyncWrite + Unpin + Send {}
type DynIo = Box<dyn AsyncIo>;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
// Bound pending RPCs and peer-controlled response allocation on every transport.
const MAX_PENDING_REQUESTS: usize = 64;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PIPELINE_BYTES: usize = 32 * 1024 * 1024;
const MAX_WALLET_TRANSACTIONS: usize = 100_000;
const MAX_SPENDER_TRANSACTIONS: usize = 128;
/// rnbrady's cap on the unspent-output phase: the outputs still at the address
/// plus the ancestors walked back from them. Past this the history scan is
/// cheaper than guessing.
const MAX_SPENDER_HEURISTIC_FETCHES: usize = 30;
/// How far a walk back from an unspent output follows arbitrary inputs. A walk
/// that has only ever followed output-0 links is following an authchain, and
/// the fetch cap alone bounds it.
const MAX_WALK_BACK_DEPTH: u32 = 3;
const MAX_SPENDER_RAW_BYTES: usize = 2 * 1024 * 1024;
/// A script's unspent list longer than this is refused when it is evidence
/// against someone (see [`ElectrumBackend::script_unspent_values`]).
const MAX_SCRIPT_UNSPENT_ENTRIES: usize = 1_024;
const SPENDER_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a parked connection stays eligible for reuse: long enough to carry
/// one refresh and the lookups that follow it, short enough that a silently
/// dropped Tor circuit is not the first thing the next refresh meets.
const IDLE_SESSION_TTL: Duration = Duration::from_secs(30);
const CLIENT_NAME: &str = "OPTN Wallet";
const PROTOCOL_MIN: &str = "1.4";
const PROTOCOL_MAX: &str = "1.6";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElectrumTransport {
    Tcp,
    Tls,
    Tor {
        proxy_host: String,
        proxy_port: u16,
        username: String,
        password: String,
        tls: bool,
    },
}

#[derive(Debug, Clone)]
pub struct ElectrumConfig {
    pub source_id: SourceId,
    pub endpoint: Endpoint,
    pub transport: ElectrumTransport,
    /// Host-selected chain identity in internal hash byte order.
    pub expected_genesis: [u8; 32],
    pub client_name: String,
    pub protocol_min: String,
    pub protocol_max: String,
    pub request_timeout: Duration,
}

impl ElectrumConfig {
    pub fn new(
        source_id: SourceId,
        endpoint: Endpoint,
        transport: ElectrumTransport,
        expected_genesis: [u8; 32],
    ) -> Self {
        Self {
            source_id,
            endpoint,
            transport,
            expected_genesis,
            client_name: CLIENT_NAME.into(),
            protocol_min: PROTOCOL_MIN.into(),
            protocol_max: PROTOCOL_MAX.into(),
            request_timeout: DEFAULT_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ElectrumServerInfo {
    pub software: Option<String>,
    pub protocol: String,
    pub features: Value,
    pub peers: Value,
}

pub struct ElectrumBackend {
    config: ElectrumConfig,
    capabilities: CapabilitySet,
    server_info: ElectrumServerInfo,
    /// One negotiated connection kept between requests. A new session costs a
    /// TCP/TLS handshake plus `server.version` and `server.features` -- over Tor,
    /// several round trips -- and an authchain walk asks a few small questions
    /// per hop. Paying that per question would put ordinary walks past the
    /// runtime's deadline.
    idle: Arc<Mutex<Option<IdleSession>>>,
}

struct IdleSession {
    session: Session,
    parked: Instant,
}

impl ElectrumBackend {
    /// Probe before registration. `server.version` is deliberately the first
    /// request on every connection, per Electrum Cash protocol >=1.4.
    pub async fn connect(config: ElectrumConfig) -> Result<Self, ChainBackendError> {
        validate_endpoint(&config)?;
        let mut session = Session::connect(&config).await?;
        let (software, protocol) = session.negotiate(&config).await?;
        let features = session.call("server.features", json!([])).await?;
        validate_genesis(&features, config.expected_genesis)?;
        let peers = session
            .call("server.peers.subscribe", json!([]))
            .await
            .unwrap_or_else(|_| Value::Array(vec![]));

        let mut capabilities = CapabilitySet::default();
        capabilities.record(
            Capability::ElectrumProtocol,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ElectrumServerVersion,
        );
        for capability in [
            Capability::FastHistory,
            Capability::OutpointSpenderLookup,
            // `blockchain.utxo.get_info` from protocol 1.4.4, the address's
            // unspent list before that. Either way it is the server's word.
            Capability::OutpointUnspentLookup,
            Capability::ScriptSubscriptions,
            Capability::UtxoQuery,
            Capability::TransactionQuery,
            Capability::Broadcast,
            Capability::HeaderStream,
            Capability::HeaderMerkleProof,
            Capability::TransactionMerkleProof,
        ] {
            capabilities.record(
                capability,
                CapabilityConfidence::Advertised,
                CapabilityDiscovery::ElectrumServerVersion,
            );
        }
        if feature_enabled(&features, "rpa") {
            capabilities.record(
                Capability::RpaIndex,
                CapabilityConfidence::Advertised,
                CapabilityDiscovery::ElectrumServerFeatures,
            );
        }
        if feature_enabled(&features, "dsproof") || feature_enabled(&features, "dsproofs") {
            capabilities.record(
                Capability::DoubleSpendProofs,
                CapabilityConfidence::Advertised,
                CapabilityDiscovery::ElectrumServerFeatures,
            );
        }
        if feature_enabled(&features, "cashtokens")
            || feature_enabled(&features, "cash_tokens")
            || extension_enabled(&features, "tokens")
        {
            // Generic CashTokens support means wallet-scoped queries can carry
            // token_data. It does NOT prove category -> all UTXOs/holders/supply
            // reverse indexes exist (those are separate granular capabilities).
            capabilities.record(
                Capability::CashTokenData,
                CapabilityConfidence::Advertised,
                CapabilityDiscovery::ElectrumServerFeatures,
            );
        }
        if feature_enabled(&features, "bcmr") || extension_enabled(&features, "bcmr") {
            capabilities.record(
                Capability::BcmrResolver,
                CapabilityConfidence::Advertised,
                CapabilityDiscovery::ElectrumServerFeatures,
            );
        }
        if extension_enabled(&features, "chaingraph")
            || extension_enabled(&features, "graph")
            || feature_enabled(&features, "graph_queries")
        {
            capabilities.record(
                Capability::GraphQueries,
                CapabilityConfidence::Advertised,
                CapabilityDiscovery::ElectrumServerFeatures,
            );
        }

        Ok(Self {
            config,
            capabilities,
            server_info: ElectrumServerInfo {
                software,
                protocol,
                features,
                peers,
            },
            idle: Arc::new(Mutex::new(None)),
        }
        .parked_with(session))
    }

    /// Park the probe's connection: it already paid for the handshake and
    /// checked the chain, and the first request usually follows at once.
    fn parked_with(self, session: Session) -> Self {
        let parked = Instant::now();
        if let Ok(mut slot) = self.idle.try_lock() {
            *slot = Some(IdleSession { session, parked });
        }
        Self::reap_after_ttl(&self.idle, parked);
        self
    }

    /// Close a parked connection once its reuse window has passed, so a
    /// backend that is never asked again does not hold a socket open. Weak, so
    /// dropping the backend still closes its connection at once.
    fn reap_after_ttl(idle: &Arc<Mutex<Option<IdleSession>>>, parked: Instant) {
        let idle = Arc::downgrade(idle);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                tokio::time::sleep(IDLE_SESSION_TTL).await;
                let Some(idle) = idle.upgrade() else {
                    return;
                };
                let mut slot = idle.lock().await;
                if slot.as_ref().is_some_and(|idle| idle.parked == parked) {
                    *slot = None;
                }
            });
        }
    }

    pub fn server_info(&self) -> &ElectrumServerInfo {
        &self.server_info
    }

    /// Exercise the real RPA method before promotion from Advertised to Verified.
    pub async fn verify_rpa_prefix(
        &mut self,
        prefix: &str,
        from_height: u32,
    ) -> Result<(), ChainBackendError> {
        validate_rpa_prefix(prefix)?;
        if !self.capabilities.is_usable(Capability::RpaIndex) {
            return Err(ChainBackendError::Unsupported);
        }
        let mut session = self.session().await?;
        session
            .call(
                "blockchain.rpa.get_history",
                json!([prefix, from_height, -1]),
            )
            .await?;
        self.capabilities.record(
            Capability::RpaIndex,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ActiveProbe,
        );
        Ok(())
    }

    pub async fn raw_call(&self, method: &str, params: Value) -> Result<Value, ChainBackendError> {
        let mut session = self.session().await?;
        session.call(method, params).await
    }

    /// For each `(script_pubkey, txid, vout)` (txid in internal byte order),
    /// the value at which the script's unspent list holds that output, or
    /// `None` when it does not: the check a CashFusion peer's claimed input
    /// must pass. All are asked together on one connection.
    ///
    /// "Not unspent" can count against a peer, so each list must be well
    /// formed throughout -- canonical hashes, every field present, no output
    /// listed twice, at most [`MAX_SCRIPT_UNSPENT_ENTRIES`] entries -- or that
    /// answer is an error. Fields beyond those, such as an output's
    /// `token_data`, are ignored. An error answers only its own question; the
    /// outer error is a connection that failed them all.
    pub async fn script_unspent_values(
        &self,
        outputs: &[(Vec<u8>, [u8; 32], u32)],
    ) -> Result<Vec<Result<Option<u64>, ChainBackendError>>, ChainBackendError> {
        if outputs.is_empty() {
            return Ok(Vec::new());
        }
        let scripthashes: Vec<String> = outputs
            .iter()
            .map(|(script, _, _)| electrum_scripthash(script))
            .collect();
        let (mut session, reused) = self.checkout().await?;
        let mut listed = Self::list_unspent(&mut session, &scripthashes).await;
        // As for other read-only requests: a parked connection the server has
        // since closed gets one fresh attempt.
        if reused && matches!(listed, Err(ChainBackendError::Offline)) {
            session = self.session().await?;
            listed = Self::list_unspent(&mut session, &scripthashes).await;
        }
        let listed = listed?;
        if !session.poisoned {
            self.park(session).await;
        }
        Ok(outputs
            .iter()
            .zip(listed)
            .map(|((_, txid, vout), reply)| {
                reply.and_then(|list| strict_unspent_value(&list, &display_hash(*txid), *vout))
            })
            .collect())
    }

    async fn list_unspent(
        session: &mut Session,
        scripthashes: &[String],
    ) -> Result<Vec<Result<Value, ChainBackendError>>, ChainBackendError> {
        let mut replies = Vec::with_capacity(scripthashes.len());
        for chunk in scripthashes.chunks(MAX_PENDING_REQUESTS) {
            let requests: Vec<(&str, Value)> = chunk
                .iter()
                .map(|scripthash| ("blockchain.scripthash.listunspent", json!([scripthash])))
                .collect();
            replies.extend(session.call_many_lenient(&requests).await?);
        }
        Ok(replies)
    }

    async fn session(&self) -> Result<Session, ChainBackendError> {
        let mut session = Session::connect(&self.config).await?;
        session.negotiate(&self.config).await?;
        let features = session.call("server.features", json!([])).await?;
        validate_genesis(&features, self.config.expected_genesis)?;
        Ok(session)
    }

    /// The parked connection while it is fresh, otherwise a new one. The flag
    /// says which: a parked connection may have been closed by the server since.
    async fn checkout(&self) -> Result<(Session, bool), ChainBackendError> {
        if let Some(idle) = self.idle.lock().await.take() {
            if idle.parked.elapsed() < IDLE_SESSION_TTL {
                return Ok((idle.session, true));
            }
        }
        Ok((self.session().await?, false))
    }

    /// Keep a connection for the next request. One is kept; a newer one
    /// replaces it, which closes the older.
    async fn park(&self, session: Session) {
        let parked = Instant::now();
        *self.idle.lock().await = Some(IdleSession { session, parked });
        Self::reap_after_ttl(&self.idle, parked);
    }

    /// Read-only requests run on a reused connection when one is parked.
    async fn pooled(
        &self,
        request: &ChainRequest,
    ) -> Result<BackendObservation, ChainBackendError> {
        let (mut session, reused) = self.checkout().await?;
        let mut result = self.dispatch(&mut session, request).await;
        // A parked connection the server has since closed fails before any
        // reply. That is the connection's fault, not the request's, and these
        // requests change nothing, so they get one fresh attempt.
        if reused && matches!(result, Err(ChainBackendError::Offline)) {
            session = self.session().await?;
            result = self.dispatch(&mut session, request).await;
        }
        if !session.poisoned
            && (result.is_ok() || matches!(result, Err(ChainBackendError::Unsupported)))
        {
            self.park(session).await;
        }
        result
    }

    async fn dispatch(
        &self,
        session: &mut Session,
        request: &ChainRequest,
    ) -> Result<BackendObservation, ChainBackendError> {
        match request {
            ChainRequest::WalletRefresh {
                interests,
                from_height,
            } => self.wallet_refresh(session, interests, *from_height).await,
            ChainRequest::TransactionLookup { txid } => {
                self.transaction_lookup(session, *txid).await
            }
            ChainRequest::OutpointSpentness { txid, vout } => {
                self.outpoint_spentness(session, *txid, *vout).await
            }
            ChainRequest::OutpointSpender {
                txid,
                vout,
                script_pubkey,
                from_height,
            } => {
                self.outpoint_spender(session, *txid, *vout, script_pubkey, *from_height)
                    .await
            }
            ChainRequest::HeaderSync {
                start_height,
                count,
            } => self.header_sync(session, *start_height, *count).await,
            ChainRequest::HistoricalHeaderProof {
                height,
                checkpoint_height,
            } => {
                self.historical_header_proof(session, *height, *checkpoint_height)
                    .await
            }
            ChainRequest::CashcodeBlockRange { .. }
            | ChainRequest::HeaderSyncFromLocator { .. }
            | ChainRequest::Broadcast { .. } => Err(ChainBackendError::Unsupported),
        }
    }

    async fn wallet_refresh(
        &self,
        session: &mut Session,
        interests: &[WalletInterest],
        from_height: Option<u32>,
    ) -> Result<BackendObservation, ChainBackendError> {
        if interests.iter().any(|interest| match interest {
            WalletInterest::Outpoint { .. } => true,
            WalletInterest::RpaPrefix(_) => !self.capabilities.is_usable(Capability::RpaIndex),
            WalletInterest::Script(_) => false,
        }) {
            return Err(ChainBackendError::Unsupported);
        }
        let tip = parse_tip(
            &session
                .call("blockchain.headers.subscribe", json!([]))
                .await?,
        )?;
        let mut txs = BTreeMap::<[u8; 32], i64>::new();

        for group in interests.chunks(MAX_PENDING_REQUESTS / 2) {
            let mut requests = Vec::with_capacity(group.len() * 2);
            for interest in group {
                match interest {
                    WalletInterest::Script(script) => {
                        let sh = electrum_scripthash(script);
                        let params = if protocol_at_least(&session.protocol, 1, 5, 1) {
                            json!([sh, from_height.unwrap_or(0), -1])
                        } else {
                            json!([sh])
                        };
                        requests.push(("blockchain.scripthash.get_history", params));
                        // Modern paginated history excludes mempool; require both replies.
                        requests.push(("blockchain.scripthash.get_mempool", json!([sh])));
                    }
                    WalletInterest::RpaPrefix(prefix) => {
                        validate_rpa_prefix(prefix)?;
                        let start = from_height
                            .unwrap_or_else(|| rpa_starting_height(&self.server_info.features));
                        requests.push(("blockchain.rpa.get_history", json!([prefix, start, -1])));
                        requests.push(("blockchain.rpa.get_mempool", json!([prefix])));
                    }
                    WalletInterest::Outpoint { .. } => {
                        unreachable!("outpoint interests rejected above")
                    }
                }
            }
            for response in session.call_many(&requests).await? {
                merge_history(&mut txs, &response)?;
            }
        }

        let txs = txs.into_iter().collect::<Vec<_>>();
        let mut transactions = Vec::with_capacity(txs.len());
        let mut raw_bytes = 0usize;
        for group in txs.chunks(MAX_PENDING_REQUESTS) {
            let requests = group
                .iter()
                .map(|(txid, _)| {
                    (
                        "blockchain.transaction.get",
                        json!([display_hash(*txid), false]),
                    )
                })
                .collect::<Vec<_>>();
            for ((txid, height), response) in group.iter().zip(session.call_many(&requests).await?)
            {
                let raw_hex = response.as_str().ok_or_else(|| {
                    ChainBackendError::InvalidResponse("transaction.get did not return hex".into())
                })?;
                let raw = hex::decode(raw_hex).map_err(|error| {
                    ChainBackendError::InvalidResponse(format!("invalid transaction hex: {error}"))
                })?;
                raw_bytes = raw_bytes
                    .checked_add(raw.len())
                    .filter(|bytes| *bytes <= optn_runtime::wallet_checkpoint::MAX_CHECKPOINT_BYTES)
                    .ok_or_else(|| {
                        ChainBackendError::InvalidResponse(
                            "wallet transaction data exceeds storage limit".into(),
                        )
                    })?;
                if sha256d(&raw) != *txid {
                    return Err(ChainBackendError::InvalidResponse(
                        "transaction bytes do not match returned txid".into(),
                    ));
                }
                transactions.push(ObservedTransaction {
                    txid: *txid,
                    raw,
                    block_height: (*height > 0).then_some(*height as u32),
                });
            }
        }
        let chain_tip = tip.as_ref().map(|tip| (tip.height, tip.hash));
        Ok(BackendObservation {
            payload: ChainPayload::WalletRefresh { transactions, tip },
            evidence: Evidence::ServerAssertion,
            chain_tip,
        })
    }

    async fn transaction_lookup(
        &self,
        session: &mut Session,
        txid: [u8; 32],
    ) -> Result<BackendObservation, ChainBackendError> {
        let display = display_hash(txid);
        let mut requests = vec![("blockchain.transaction.get", json!([display, false]))];
        // The block height bounds a later history search to what came after
        // this transaction (rnbrady's `from_height`). Asked in the same round
        // trip; an unconfirmed transaction has none, and the server answers
        // that with an error rather than a height.
        if protocol_at_least(&session.protocol, 1, 4, 5) {
            requests.push(("blockchain.transaction.get_merkle", json!([display])));
        }
        let mut replies = session.call_many_lenient(&requests).await?.into_iter();
        let raw = transaction_bytes(&replies.next().unwrap_or(Ok(Value::Null))?, txid)?;
        let block_height = replies
            .next()
            .and_then(Result::ok)
            .and_then(|merkle| merkle.get("block_height").and_then(Value::as_u64))
            .and_then(|height| u32::try_from(height).ok())
            .filter(|height| *height > 0);
        Ok(BackendObservation {
            payload: ChainPayload::Transaction(ObservedTransaction {
                txid,
                raw,
                block_height,
            }),
            evidence: Evidence::ServerAssertion,
            chain_tip: None,
        })
    }

    /// Whether `txid:vout` is in the server's UTXO view, mempool included.
    ///
    /// One round trip carries three questions: the tip the answer is evaluated
    /// at, the transaction itself so the answer is bound to that output's script
    /// and value, and the lookup. `blockchain.utxo.get_info` answers directly
    /// from protocol 1.4.4; older servers are asked for the address's unspent
    /// list. An absent output is `Unknown`: the server saying it is not unspent
    /// does not name what spent it.
    async fn outpoint_spentness(
        &self,
        session: &mut Session,
        txid: [u8; 32],
        vout: u32,
    ) -> Result<BackendObservation, ChainBackendError> {
        let display = display_hash(txid);
        let direct = protocol_at_least(&session.protocol, 1, 4, 4);
        let mut requests = vec![
            ("blockchain.headers.subscribe", json!([])),
            ("blockchain.transaction.get", json!([display, false])),
        ];
        if direct {
            requests.push(("blockchain.utxo.get_info", json!([display, vout])));
        }
        let mut replies = session.call_many_lenient(&requests).await?.into_iter();
        let tip = parse_tip(&replies.next().unwrap_or(Ok(Value::Null))?)?.ok_or_else(|| {
            ChainBackendError::InvalidResponse("headers.subscribe returned no tip".into())
        })?;
        let raw = transaction_bytes(&replies.next().unwrap_or(Ok(Value::Null))?, txid)?;
        let decoded = optn_core::tx::decode(&raw).map_err(|error| {
            ChainBackendError::InvalidResponse(format!("invalid transaction: {error}"))
        })?;
        let output = usize::try_from(vout)
            .ok()
            .and_then(|index| decoded.outputs.get(index))
            .ok_or_else(|| {
                ChainBackendError::InvalidResponse("the transaction has no such output".into())
            })?;
        let scripthash = electrum_scripthash(&output.script_pubkey);
        // A server that advertises the protocol but refuses the method is asked
        // the older way, rather than being marked unhealthy for wallet sync.
        let direct_reply = replies.next().and_then(Result::ok).filter(|_| direct);
        let unspent = if let Some(reply) = direct_reply {
            match reply {
                Value::Null => false,
                Value::Object(info) => {
                    let same_script = info
                        .get("scripthash")
                        .and_then(Value::as_str)
                        .is_some_and(|reported| reported.eq_ignore_ascii_case(&scripthash));
                    let same_value =
                        info.get("value").and_then(Value::as_u64) == Some(output.value);
                    if !same_script || !same_value {
                        return Err(ChainBackendError::InvalidResponse(
                            "utxo.get_info disagrees with the transaction's own output".into(),
                        ));
                    }
                    true
                }
                _ => {
                    return Err(ChainBackendError::InvalidResponse(
                        "utxo.get_info returned neither an object nor null".into(),
                    ))
                }
            }
        } else {
            let listed = session
                .call("blockchain.scripthash.listunspent", json!([scripthash]))
                .await?;
            match listed_unspent_value(&listed, &display, vout)? {
                Some(value) if value == output.value => true,
                Some(_) => {
                    return Err(ChainBackendError::InvalidResponse(
                        "listunspent disagrees with the transaction's own output".into(),
                    ))
                }
                None => false,
            }
        };
        Ok(BackendObservation {
            payload: ChainPayload::OutpointSpentness(if unspent {
                OutpointSpentness::Unspent {
                    txid,
                    vout,
                    value_sats: output.value,
                    script_pubkey: output.script_pubkey.clone(),
                    best_block: tip.hash,
                }
            } else {
                OutpointSpentness::Unknown { txid, vout }
            }),
            evidence: Evidence::ServerAssertion,
            chain_tip: Some((tip.height, tip.hash)),
        })
    }

    async fn outpoint_spender(
        &self,
        session: &mut Session,
        txid: [u8; 32],
        vout: u32,
        script_pubkey: &[u8],
        from_height: Option<u32>,
    ) -> Result<BackendObservation, ChainBackendError> {
        let (spender, descendants) = match timeout(
            SPENDER_TIMEOUT,
            self.find_outpoint_spender(session, txid, vout, script_pubkey, from_height),
        )
        .await
        {
            // A deadline is a budget running out, not an answer.
            Ok(Err(ChainBackendError::Timeout)) | Err(_) => (None, Vec::new()),
            Ok(result) => result?,
        };
        Ok(BackendObservation {
            payload: ChainPayload::OutpointSpender {
                txid,
                vout,
                spender,
                descendants,
            },
            evidence: Evidence::ServerAssertion,
            chain_tip: None,
        })
    }

    /// Bounded discovery of whatever spends `txid:vout`, after rnbrady's
    /// Electron Cash authchain work.
    ///
    /// First the outputs still sitting at the address: each one's transaction
    /// may be the spender itself, or a descendant that leads back to it. The
    /// walk back follows any input for three hops, and follows output-0 links
    /// for as long as the fetch cap allows -- an unspent output at the end of an
    /// authchain walks straight back to the spender, finding every hop between
    /// in the same pass. Then the address's history after `from_height`, oldest
    /// first, since a spender follows what it spends.
    ///
    /// Every candidate is checked for the exact input before it is reported.
    /// Nothing found is unknown: a missing spender is never evidence of an
    /// unspent output, and neither is running out of budget.
    async fn find_outpoint_spender(
        &self,
        session: &mut Session,
        txid: [u8; 32],
        vout: u32,
        script_pubkey: &[u8],
        from_height: Option<u32>,
    ) -> Result<(Option<ObservedTransaction>, Vec<ObservedTransaction>), ChainBackendError> {
        let target = (txid, vout);
        let sh = electrum_scripthash(script_pubkey);
        let floor = i64::from(from_height.unwrap_or(0));
        let eligible = |candidate: &[u8; 32], height: i64| {
            *candidate != txid && (height <= 0 || height >= floor)
        };
        let mut search = SpenderSearch::default();

        let mut unspent = BTreeMap::new();
        merge_history(
            &mut unspent,
            &session
                .call("blockchain.scripthash.listunspent", json!([sh]))
                .await?,
        )?;
        let mut frontier: Vec<WalkStep> = chronological(unspent)
            .into_iter()
            .filter(|(candidate, height)| eligible(candidate, *height))
            .map(|(candidate, height)| WalkStep {
                txid: candidate,
                height,
                depth: 0,
                output_zero_path: true,
            })
            .collect();
        let mut walked = 0;
        while !frontier.is_empty() && walked < MAX_SPENDER_HEURISTIC_FETCHES {
            // Authchain-shaped paths first, then the shallowest. Stable, so
            // equal steps keep chronological order.
            frontier.sort_by_key(|step| (!step.output_zero_path, step.depth));
            let room = (MAX_SPENDER_HEURISTIC_FETCHES - walked)
                .min(MAX_PENDING_REQUESTS)
                .min(search.room())
                .min(frontier.len());
            if room == 0 {
                return Ok((None, Vec::new()));
            }
            let batch: Vec<WalkStep> = frontier.drain(..room).collect();
            walked += batch.len();
            let group: Vec<_> = batch
                .iter()
                .map(|step| (step.txid, step.height, step.depth > 0))
                .collect();
            if !search.fetch(session, &group).await? {
                return Ok((None, Vec::new()));
            }
            if let Some(spender) =
                search.spender_among(batch.iter().map(|step| step.txid), target)?
            {
                return Ok(search.report(spender));
            }
            for step in &batch {
                let Some(found) = search.found.get(&step.txid) else {
                    continue;
                };
                for &(parent, index) in &found.inputs {
                    let output_zero_path = step.output_zero_path && index == 0;
                    let depth = step.depth + 1;
                    if parent == txid
                        || parent == [0; 32]
                        || search.requested.contains(&parent)
                        || search.via.contains_key(&parent)
                        || frontier.iter().any(|queued| queued.txid == parent)
                        || (depth > MAX_WALK_BACK_DEPTH && !output_zero_path)
                    {
                        continue;
                    }
                    search.via.insert(parent, step.txid);
                    frontier.push(WalkStep {
                        txid: parent,
                        height: 0,
                        depth,
                        output_zero_path,
                    });
                }
            }
        }

        let params = if protocol_at_least(&session.protocol, 1, 5, 1) {
            json!([sh, from_height.unwrap_or(0), -1])
        } else {
            json!([sh])
        };
        let mut history = BTreeMap::new();
        for response in session
            .call_many(&[
                ("blockchain.scripthash.get_history", params),
                ("blockchain.scripthash.get_mempool", json!([sh])),
            ])
            .await?
        {
            merge_history(&mut history, &response)?;
        }
        let candidates: Vec<_> = chronological(history)
            .into_iter()
            .filter(|(candidate, height)| {
                eligible(candidate, *height) && !search.requested.contains(candidate)
            })
            .collect();
        for group in candidates.chunks(MAX_PENDING_REQUESTS) {
            let group = &group[..group.len().min(search.room())];
            if group.is_empty() {
                return Ok((None, Vec::new()));
            }
            let fetches: Vec<_> = group
                .iter()
                .map(|(candidate, height)| (*candidate, *height, false))
                .collect();
            if !search.fetch(session, &fetches).await? {
                return Ok((None, Vec::new()));
            }
            // Discovery only: reject conflicts actually observed, then let the
            // runtime validate the candidate without scanning further.
            if let Some(spender) =
                search.spender_among(group.iter().map(|(candidate, _)| *candidate), target)?
            {
                return Ok((Some(search.observed(spender)), Vec::new()));
            }
        }
        Ok((None, Vec::new()))
    }

    async fn broadcast(
        &self,
        raw_tx: &[u8],
        txid: [u8; 32],
    ) -> Result<BackendObservation, ChainBackendError> {
        if sha256d(raw_tx) != txid {
            return Err(ChainBackendError::Rejected(
                "locally supplied txid does not match transaction bytes".into(),
            ));
        }
        // Never a reused connection, and never retried: had a reused connection
        // dropped mid-request, nobody could say whether the server relayed it.
        // The parked one is closed first, so a broadcast is never this
        // wallet's second open connection to the server.
        drop(self.idle.lock().await.take());
        let mut session = self.session().await?;
        let returned = match session
            .call(
                "blockchain.transaction.broadcast",
                json!([hex::encode(raw_tx)]),
            )
            .await
        {
            Ok(returned) => returned,
            Err(ChainBackendError::Protocol(error)) => {
                return match broadcast_error_reply(&error) {
                    // The server's node has this exact transaction: observed,
                    // not rejected.
                    NodeBroadcastReply::AlreadyHas => Ok(BackendObservation {
                        payload: ChainPayload::BroadcastObserved { txid },
                        evidence: Evidence::ServerAssertion,
                        chain_tip: None,
                    }),
                    NodeBroadcastReply::Conflict => Err(ChainBackendError::Rejected(format!(
                        "another transaction already spends these coins ({MEMPOOL_CONFLICT})"
                    ))),
                    NodeBroadcastReply::Other => Err(ChainBackendError::Protocol(error)),
                };
            }
            Err(error) => return Err(error),
        };
        let returned_txid = returned.as_str().ok_or_else(|| {
            ChainBackendError::InvalidResponse("broadcast result is not a txid".into())
        })?;
        if decode_display_hash(returned_txid)? != txid {
            return Err(ChainBackendError::InvalidResponse(
                "broadcast server returned a different txid".into(),
            ));
        }
        Ok(BackendObservation {
            payload: ChainPayload::BroadcastObserved { txid },
            evidence: Evidence::ServerAssertion,
            chain_tip: None,
        })
    }

    async fn header_sync(
        &self,
        session: &mut Session,
        start_height: u32,
        count: u32,
    ) -> Result<BackendObservation, ChainBackendError> {
        let result = session
            .call("blockchain.block.headers", json!([start_height, count, 0]))
            .await?;
        Ok(BackendObservation {
            payload: ChainPayload::Headers {
                start_height,
                headers: parse_headers_result(&result)?,
            },
            evidence: Evidence::ServerAssertion,
            chain_tip: None,
        })
    }

    async fn historical_header_proof(
        &self,
        session: &mut Session,
        height: u32,
        checkpoint_height: u32,
    ) -> Result<BackendObservation, ChainBackendError> {
        if checkpoint_height < height {
            return Err(ChainBackendError::Rejected(
                "checkpoint height must be at or above requested header".into(),
            ));
        }
        let result = session
            .call(
                "blockchain.block.header",
                json!([height, checkpoint_height]),
            )
            .await?;
        let object = result.as_object().ok_or_else(|| {
            ChainBackendError::InvalidResponse("checkpoint header proof is not an object".into())
        })?;
        let header = parse_header_hex(object.get("header").and_then(Value::as_str).ok_or_else(
            || ChainBackendError::InvalidResponse("header proof lacks header".into()),
        )?)?;
        let siblings = object
            .get("branch")
            .and_then(Value::as_array)
            .ok_or_else(|| ChainBackendError::InvalidResponse("header proof lacks branch".into()))?
            .iter()
            .map(|item| {
                item.as_str()
                    .ok_or_else(|| {
                        ChainBackendError::InvalidResponse(
                            "header branch contains non-string hash".into(),
                        )
                    })
                    .and_then(decode_display_hash)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let root =
            decode_display_hash(object.get("root").and_then(Value::as_str).ok_or_else(|| {
                ChainBackendError::InvalidResponse("header proof lacks root".into())
            })?)?;
        Ok(BackendObservation {
            payload: ChainPayload::HistoricalHeaderProof {
                height,
                checkpoint_height,
                header,
                siblings,
                root,
            },
            // Standard Electrum checkpoint Merkle proof material is not an MMR proof.
            evidence: Evidence::ServerAssertion,
            chain_tip: None,
        })
    }
}

impl ChainBackend for ElectrumBackend {
    fn source_id(&self) -> &SourceId {
        &self.config.source_id
    }
    fn protocol(&self) -> ProtocolFamily {
        ProtocolFamily::Electrum
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
        self.capabilities
            .is_usable(optn_runtime::chain_service::operation_capability(operation))
    }
    fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
        Box::pin(async move {
            match request {
                ChainRequest::CashcodeBlockRange { .. }
                | ChainRequest::HeaderSyncFromLocator { .. } => Err(ChainBackendError::Unsupported),
                ChainRequest::Broadcast { raw_tx, txid } => self.broadcast(raw_tx, *txid).await,
                request => self.pooled(request).await,
            }
        })
    }
}

struct Session {
    reader: BufReader<DynIo>,
    next_id: u64,
    request_timeout: Duration,
    protocol: String,
    /// Set while a request group is in flight, cleared once every reply is
    /// read. A connection left mid-frame or with replies outstanding would hand
    /// them to the next caller, so it is never reused.
    poisoned: bool,
}
impl Session {
    async fn connect(config: &ElectrumConfig) -> Result<Self, ChainBackendError> {
        Ok(Self {
            reader: BufReader::new(connect_transport(config).await?),
            next_id: 1,
            request_timeout: config.request_timeout,
            protocol: String::new(),
            poisoned: false,
        })
    }
    async fn negotiate(
        &mut self,
        config: &ElectrumConfig,
    ) -> Result<(Option<String>, String), ChainBackendError> {
        let result = self
            .call(
                "server.version",
                json!([
                    config.client_name,
                    [config.protocol_min, config.protocol_max]
                ]),
            )
            .await?;
        let negotiated = match result {
            Value::Array(values) if values.len() >= 2 => {
                let software = values.first().and_then(Value::as_str).map(str::to_owned);
                let protocol = values
                    .get(1)
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ChainBackendError::InvalidResponse(
                            "server.version lacks negotiated protocol".into(),
                        )
                    })?
                    .to_owned();
                Ok((software, protocol))
            }
            Value::String(protocol) => Ok((None, protocol)),
            _ => Err(ChainBackendError::InvalidResponse(
                "unexpected server.version result".into(),
            )),
        }?;
        self.protocol.clone_from(&negotiated.1);
        Ok(negotiated)
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, ChainBackendError> {
        self.call_many(&[(method, params)])
            .await?
            .pop()
            .ok_or_else(|| {
                ChainBackendError::InvalidResponse("Electrum response is missing".into())
            })
    }

    /// Pipeline ordinary newline-framed RPCs on this exact connection. This
    /// avoids a Tor round trip per address without requiring JSON-array batches.
    /// All request IDs must complete; reordered replies are restored to input order.
    async fn call_many(
        &mut self,
        requests: &[(&str, Value)],
    ) -> Result<Vec<Value>, ChainBackendError> {
        self.call_many_bounded(requests, None)
            .await?
            .ok_or_else(|| {
                ChainBackendError::InvalidResponse("Electrum response is missing".into())
            })
    }

    async fn call_many_bounded(
        &mut self,
        requests: &[(&str, Value)],
        byte_budget: Option<usize>,
    ) -> Result<Option<Vec<Value>>, ChainBackendError> {
        match self.exchange(requests, byte_budget, false).await? {
            Some(replies) => replies.into_iter().collect::<Result<Vec<_>, _>>().map(Some),
            None => Ok(None),
        }
    }

    /// Like [`Self::call_many`], but an error reply answers only its own
    /// request. Used where the server refusing one question -- "no such
    /// transaction", "not in a block" -- is an ordinary answer.
    async fn call_many_lenient(
        &mut self,
        requests: &[(&str, Value)],
    ) -> Result<Vec<Result<Value, ChainBackendError>>, ChainBackendError> {
        self.exchange(requests, None, true).await?.ok_or_else(|| {
            ChainBackendError::InvalidResponse("Electrum response is missing".into())
        })
    }

    async fn exchange(
        &mut self,
        requests: &[(&str, Value)],
        byte_budget: Option<usize>,
        lenient: bool,
    ) -> Result<Option<Vec<Result<Value, ChainBackendError>>>, ChainBackendError> {
        if requests.is_empty() || requests.len() > MAX_PENDING_REQUESTS {
            return Err(ChainBackendError::Rejected(
                "invalid Electrum request group size".into(),
            ));
        }
        let first = self.next_id;
        self.next_id = first
            .checked_add(requests.len() as u64)
            .ok_or_else(|| ChainBackendError::Rejected("Electrum request IDs exhausted".into()))?;
        self.poisoned = true;
        let mut bytes = Vec::new();
        for (index, (method, params)) in requests.iter().enumerate() {
            serde_json::to_writer(
                &mut bytes,
                &json!({"jsonrpc":"2.0", "id":first+index as u64,
                "method":method, "params":params}),
            )
            .map_err(|e| ChainBackendError::Protocol(e.to_string()))?;
            bytes.push(b'\n');
        }
        timeout(self.request_timeout, async {
            self.reader
                .get_mut()
                .write_all(&bytes)
                .await
                .map_err(map_io)?;
            self.reader.get_mut().flush().await.map_err(map_io)?;
            let mut results = vec![None; requests.len()];
            let mut received = 0;
            let mut total_bytes = 0usize;
            while received < requests.len() {
                let mut line = Vec::new();
                let read_limit = byte_budget
                    .map(|budget| budget.saturating_sub(total_bytes))
                    .unwrap_or(MAX_RESPONSE_BYTES + 1)
                    .min(MAX_RESPONSE_BYTES + 1);
                let read = (&mut self.reader)
                    .take(read_limit as u64)
                    .read_until(b'\n', &mut line)
                    .await
                    .map_err(map_io)?;
                if byte_budget.is_some_and(|budget| total_bytes + read >= budget) {
                    // The caller must drop this session after a partial frame.
                    return Ok(None);
                }
                if read == 0 {
                    return Err(ChainBackendError::Offline);
                }
                total_bytes = total_bytes
                    .checked_add(read)
                    .filter(|size| *size <= MAX_PIPELINE_BYTES)
                    .ok_or_else(|| {
                        ChainBackendError::InvalidResponse(
                            "Electrum responses exceed byte limit".into(),
                        )
                    })?;
                if read > MAX_RESPONSE_BYTES || line.last() != Some(&b'\n') {
                    return Err(ChainBackendError::InvalidResponse(
                        "Electrum response is oversized or truncated".into(),
                    ));
                }
                let mut response: Value = serde_json::from_slice(&line).map_err(|e| {
                    ChainBackendError::InvalidResponse(format!("invalid Electrum JSON: {e}"))
                })?;
                if response.get("id").is_none_or(Value::is_null)
                    && response.get("method").and_then(Value::as_str).is_some()
                {
                    continue; // Subscription notifications are not RPC completions.
                }
                let index = response
                    .get("id")
                    .and_then(Value::as_u64)
                    .and_then(|id| id.checked_sub(first))
                    .and_then(|id| usize::try_from(id).ok())
                    .filter(|index| *index < results.len())
                    .ok_or_else(|| {
                        ChainBackendError::InvalidResponse(
                            "Electrum reply has an unexpected request ID".into(),
                        )
                    })?;
                if results[index].is_some() {
                    return Err(ChainBackendError::InvalidResponse(
                        "duplicate Electrum reply".into(),
                    ));
                }
                if let Some(error) = response.get("error").filter(|error| !error.is_null()) {
                    if !lenient {
                        return Err(ChainBackendError::Protocol(error.to_string()));
                    }
                    results[index] = Some(Err(ChainBackendError::Protocol(error.to_string())));
                    received += 1;
                    continue;
                }
                results[index] = Some(Ok(response.get_mut("result").map(Value::take).ok_or_else(
                    || ChainBackendError::InvalidResponse("Electrum response lacks result".into()),
                )?));
                received += 1;
            }
            let replies = results
                .into_iter()
                .map(|result| {
                    result.ok_or_else(|| {
                        ChainBackendError::InvalidResponse("Electrum response is missing".into())
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            // Every reply to this group has been read; the stream is clean.
            self.poisoned = false;
            Ok(Some(replies))
        })
        .await
        .map_err(|_| ChainBackendError::Timeout)?
    }
}

async fn connect_transport(config: &ElectrumConfig) -> Result<DynIo, ChainBackendError> {
    let host = config.endpoint.host.as_str();
    let port = config.endpoint.port.ok_or_else(|| {
        ChainBackendError::Rejected("Electrum endpoint requires an explicit port".into())
    })?;
    match &config.transport {
        ElectrumTransport::Tcp => Ok(Box::new(
            connect_tcp(host, port, config.request_timeout).await?,
        )),
        ElectrumTransport::Tls => {
            let stream = connect_tcp(host, port, config.request_timeout).await?;
            Ok(Box::new(
                connect_tls(host, stream, config.request_timeout).await?,
            ))
        }
        ElectrumTransport::Tor {
            proxy_host,
            proxy_port,
            username,
            password,
            tls,
        } => {
            let proxy = format!("{proxy_host}:{proxy_port}");
            let target = format!("{host}:{port}");
            let socks = timeout(
                config.request_timeout,
                tokio_socks::tcp::Socks5Stream::connect_with_password(
                    proxy.as_str(),
                    target.as_str(),
                    username,
                    password,
                ),
            )
            .await
            .map_err(|_| ChainBackendError::Timeout)?
            .map_err(|_| ChainBackendError::Offline)?;
            let stream = socks.into_inner();
            if *tls {
                Ok(Box::new(
                    connect_tls(host, stream, config.request_timeout).await?,
                ))
            } else {
                Ok(Box::new(stream))
            }
        }
    }
}
async fn connect_tcp(
    host: &str,
    port: u16,
    request_timeout: Duration,
) -> Result<TcpStream, ChainBackendError> {
    timeout(request_timeout, TcpStream::connect((host, port)))
        .await
        .map_err(|_| ChainBackendError::Timeout)?
        .map_err(map_io)
}
async fn connect_tls(
    host: &str,
    stream: TcpStream,
    request_timeout: Duration,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, ChainBackendError> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    // A host may enable another Rustls provider through unrelated dependencies.
    // Select ours explicitly rather than panic on process-wide feature unification.
    let config = ClientConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|error| ChainBackendError::Protocol(format!("TLS configuration: {error}")))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(config));
    let server_name = ServerName::try_from(host.to_owned()).map_err(|_| {
        ChainBackendError::Rejected("Electrum TLS endpoint has an invalid DNS name".into())
    })?;
    timeout(request_timeout, connector.connect(server_name, stream))
        .await
        .map_err(|_| ChainBackendError::Timeout)?
        .map_err(|e| ChainBackendError::Protocol(format!("Electrum TLS failed: {e}")))
}

fn validate_endpoint(config: &ElectrumConfig) -> Result<(), ChainBackendError> {
    let expected_tls = match config.endpoint.kind {
        EndpointKind::ElectrumTls => true,
        EndpointKind::ElectrumTcp => false,
        _ => {
            return Err(ChainBackendError::Rejected(
                "Electrum backend requires an Electrum endpoint kind".into(),
            ))
        }
    };
    let actual_tls = match &config.transport {
        ElectrumTransport::Tls => true,
        ElectrumTransport::Tcp => false,
        ElectrumTransport::Tor { tls, .. } => *tls,
    };
    if expected_tls != actual_tls {
        return Err(ChainBackendError::Rejected(
            "Electrum endpoint kind and transport TLS setting disagree".into(),
        ));
    }
    if config.endpoint.host.trim().is_empty() || config.endpoint.port.is_none() {
        return Err(ChainBackendError::Rejected(
            "Electrum endpoint must contain host and port".into(),
        ));
    }
    Ok(())
}
/// The Electrum servers a server says it peers with (`server.peers.subscribe`),
/// as endpoints worth trying later (#75 §21.3).
///
/// Hints, never trust: each is connected to, negotiated and genesis-checked
/// like any other source before it serves anything. An entry is
/// `[ip, hostname, [features]]`, where `s50002` names a TLS port and `t50001`
/// a plaintext one (a bare `s` or `t` means the default port). Only TLS is
/// kept for an ordinary hostname. An onion host is kept only when `allow_onion`
/// says Tor is in use, and then on either port, since Tor encrypts the hop.
///
/// IP literals and local or single-label names are dropped: a server must not
/// be able to aim this wallet at the holder's own network.
pub fn advertised_peers(peers: &Value, allow_onion: bool, limit: usize) -> Vec<Endpoint> {
    let mut found: Vec<Endpoint> = Vec::new();
    for entry in peers.as_array().into_iter().flatten() {
        if found.len() >= limit {
            break;
        }
        let Some(fields) = entry.as_array() else {
            continue;
        };
        let Some(host) = fields.get(1).and_then(Value::as_str) else {
            continue;
        };
        let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
        if !plausible_peer_host(&host) {
            continue;
        }
        let onion = host.ends_with(".onion");
        if onion && !allow_onion {
            continue;
        }
        let mut tls = None;
        let mut plain = None;
        for feature in fields
            .get(2)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let (slot, default) = match feature.chars().next() {
                Some('s') => (&mut tls, 50002),
                Some('t') => (&mut plain, 50001),
                _ => continue,
            };
            let port = match &feature[1..] {
                "" => Some(default),
                digits => digits.parse::<u16>().ok().filter(|port| *port != 0),
            };
            if slot.is_none() {
                *slot = port;
            }
        }
        let endpoint = match (tls, plain) {
            (Some(port), _) => Endpoint {
                kind: EndpointKind::ElectrumTls,
                host,
                port: Some(port),
            },
            (None, Some(port)) if onion => Endpoint {
                kind: EndpointKind::ElectrumTcp,
                host,
                port: Some(port),
            },
            _ => continue,
        };
        if !found.contains(&endpoint) {
            found.push(endpoint);
        }
    }
    found
}

/// A public DNS name: at least two labels, letters, digits and hyphens only,
/// not all digits (an IPv4 literal), and not a name reserved for local use.
fn plausible_peer_host(host: &str) -> bool {
    const LOCAL_SUFFIXES: &[&str] = &[
        ".localhost",
        ".local",
        ".lan",
        ".home",
        ".internal",
        ".intranet",
        ".corp",
        ".home.arpa",
        ".in-addr.arpa",
        ".ip6.arpa",
    ];
    let labels: Vec<&str> = host.split('.').collect();
    host.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
        && !labels
            .iter()
            .all(|label| label.bytes().all(|byte| byte.is_ascii_digit()))
        && !LOCAL_SUFFIXES.iter().any(|suffix| host.ends_with(suffix))
}

fn feature_enabled(features: &Value, key: &str) -> bool {
    match features.get(key) {
        Some(Value::Bool(v)) => *v,
        Some(Value::Null) | None => false,
        Some(_) => true,
    }
}
fn extension_enabled(features: &Value, key: &str) -> bool {
    features
        .get("optn_extensions")
        .and_then(Value::as_object)
        .and_then(|v| v.get(key))
        .is_some_and(|v| !v.is_null() && v != &Value::Bool(false))
}
fn rpa_starting_height(features: &Value) -> u32 {
    features
        .get("rpa")
        .and_then(Value::as_object)
        .and_then(|v| v.get("starting_height"))
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(0)
}
fn validate_rpa_prefix(prefix: &str) -> Result<(), ChainBackendError> {
    if prefix.is_empty() || !prefix.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ChainBackendError::Rejected(
            "RPA prefix must be non-empty hexadecimal text".into(),
        ));
    }
    Ok(())
}
/// One step of the walk back from an address's unspent outputs.
struct WalkStep {
    txid: [u8; 32],
    /// The server's reported height, or 0 when unknown (walked-back ancestors).
    height: i64,
    depth: u32,
    /// Every link from the unspent output to here spent an output 0: the shape
    /// of an authchain, so the walk may follow it past the depth limit.
    output_zero_path: bool,
}

struct FoundTransaction {
    raw: Vec<u8>,
    inputs: Vec<([u8; 32], u32)>,
    height: i64,
}

/// What one bounded spender search has asked for and learned.
#[derive(Default)]
struct SpenderSearch {
    /// Every transaction asked for, answered or not. Counts against the budget.
    requested: BTreeSet<[u8; 32]>,
    raw_bytes: usize,
    found: BTreeMap<[u8; 32], FoundTransaction>,
    /// Walked-back ancestor -> the transaction it was reached from.
    via: BTreeMap<[u8; 32], [u8; 32]>,
}

impl SpenderSearch {
    fn room(&self) -> usize {
        MAX_SPENDER_TRANSACTIONS.saturating_sub(self.requested.len())
    }

    /// Fetch one pipelined group of `(txid, height, may_be_missing)`. Returns
    /// `false` once the byte budget is spent; the session is then mid-frame
    /// and is not reused. A walked-back ancestor the server does not know is
    /// skipped; anything else it refuses, or bytes that are not the requested
    /// transaction, fail the search.
    async fn fetch(
        &mut self,
        session: &mut Session,
        group: &[([u8; 32], i64, bool)],
    ) -> Result<bool, ChainBackendError> {
        if self.raw_bytes == MAX_SPENDER_RAW_BYTES {
            return Ok(false);
        }
        self.requested.extend(group.iter().map(|(txid, ..)| *txid));
        let requests: Vec<_> = group
            .iter()
            .map(|(txid, ..)| {
                (
                    "blockchain.transaction.get",
                    json!([display_hash(*txid), false]),
                )
            })
            .collect();
        // Include framing in the remaining hex budget so an oversized response
        // is stopped on the wire, before allocating raw bytes.
        let Some(replies) = session
            .exchange(
                &requests,
                Some((MAX_SPENDER_RAW_BYTES - self.raw_bytes) * 2),
                true,
            )
            .await?
        else {
            return Ok(false);
        };
        for ((txid, height, may_be_missing), reply) in group.iter().zip(replies) {
            let reply = match reply {
                Ok(reply) => reply,
                Err(_) if *may_be_missing => continue,
                Err(error) => return Err(error),
            };
            let raw_hex = reply.as_str().ok_or_else(|| {
                ChainBackendError::InvalidResponse("transaction.get did not return hex".into())
            })?;
            if raw_hex.len() / 2 > MAX_SPENDER_RAW_BYTES - self.raw_bytes {
                return Ok(false);
            }
            let raw = transaction_bytes(&reply, *txid)?;
            self.raw_bytes += raw.len();
            let decoded = optn_core::tx::decode(&raw).map_err(|error| {
                ChainBackendError::InvalidResponse(format!("invalid transaction: {error}"))
            })?;
            self.found.insert(
                *txid,
                FoundTransaction {
                    raw,
                    inputs: decoded
                        .inputs
                        .into_iter()
                        .map(|(parent, index, _)| (parent, index))
                        .collect(),
                    height: *height,
                },
            );
        }
        Ok(true)
    }

    /// The one fetched transaction among `candidates` spending `target`. Two
    /// distinct spenders actually observed is a server describing two chains.
    fn spender_among(
        &self,
        candidates: impl Iterator<Item = [u8; 32]>,
        target: ([u8; 32], u32),
    ) -> Result<Option<[u8; 32]>, ChainBackendError> {
        let mut spender = None;
        for candidate in candidates {
            if self
                .found
                .get(&candidate)
                .is_some_and(|found| found.inputs.contains(&target))
            {
                if spender.is_some_and(|known| known != candidate) {
                    return Err(ChainBackendError::InvalidResponse(
                        "multiple transactions spend the requested outpoint".into(),
                    ));
                }
                spender = Some(candidate);
            }
        }
        Ok(spender)
    }

    fn observed(&self, txid: [u8; 32]) -> ObservedTransaction {
        let found = &self.found[&txid];
        ObservedTransaction {
            txid,
            raw: found.raw.clone(),
            block_height: (found.height > 0).then_some(found.height as u32),
        }
    }

    /// The spender, and the walk that led back to it, nearest first.
    fn report(&self, spender: [u8; 32]) -> (Option<ObservedTransaction>, Vec<ObservedTransaction>) {
        let mut descendants = Vec::new();
        let mut at = spender;
        while let Some(child) = self.via.get(&at) {
            if !self.found.contains_key(child) || descendants.len() >= MAX_SPENDER_HEURISTIC_FETCHES
            {
                break;
            }
            descendants.push(self.observed(*child));
            at = *child;
        }
        (Some(self.observed(spender)), descendants)
    }
}

/// Oldest first, unconfirmed last, then by txid so the order is stable. A
/// spender follows what it spends, so it is usually among the first entries
/// after `from_height`.
fn chronological(entries: BTreeMap<[u8; 32], i64>) -> Vec<([u8; 32], i64)> {
    let mut entries: Vec<_> = entries.into_iter().collect();
    entries.sort_by_key(|(txid, height)| (*height <= 0, *height, *txid));
    entries
}

/// Raw transaction bytes from a `transaction.get` reply, bound to `txid`.
fn transaction_bytes(reply: &Value, txid: [u8; 32]) -> Result<Vec<u8>, ChainBackendError> {
    let raw_hex = reply.as_str().ok_or_else(|| {
        ChainBackendError::InvalidResponse("transaction.get did not return hex".into())
    })?;
    let raw = hex::decode(raw_hex).map_err(|error| {
        ChainBackendError::InvalidResponse(format!("invalid transaction hex: {error}"))
    })?;
    if sha256d(&raw) != txid {
        return Err(ChainBackendError::InvalidResponse(
            "transaction bytes do not match requested txid".into(),
        ));
    }
    Ok(raw)
}

/// The value listed for `tx_hash:tx_pos` in a `listunspent` reply, if listed.
fn listed_unspent_value(
    listed: &Value,
    tx_hash: &str,
    tx_pos: u32,
) -> Result<Option<u64>, ChainBackendError> {
    let entries = listed.as_array().ok_or_else(|| {
        ChainBackendError::InvalidResponse("listunspent result is not an array".into())
    })?;
    for entry in entries {
        let same_outpoint = entry
            .get("tx_hash")
            .and_then(Value::as_str)
            .is_some_and(|hash| hash.eq_ignore_ascii_case(tx_hash))
            && entry.get("tx_pos").and_then(Value::as_u64) == Some(u64::from(tx_pos));
        if same_outpoint {
            return entry
                .get("value")
                .and_then(Value::as_u64)
                .map(Some)
                .ok_or_else(|| {
                    ChainBackendError::InvalidResponse("listunspent entry lacks a value".into())
                });
        }
    }
    Ok(None)
}

/// The value of `tx_hash:tx_pos` in a script's unspent list, or `None` when
/// the list, well formed throughout, does not hold it.
fn strict_unspent_value(
    listed: &Value,
    tx_hash: &str,
    tx_pos: u32,
) -> Result<Option<u64>, ChainBackendError> {
    let invalid = |why: &str| ChainBackendError::InvalidResponse(format!("listunspent {why}"));
    let entries = listed
        .as_array()
        .ok_or_else(|| invalid("result is not an array"))?;
    if entries.len() > MAX_SCRIPT_UNSPENT_ENTRIES {
        return Err(invalid("result has too many entries"));
    }
    let mut seen = BTreeSet::new();
    let mut found = None;
    for entry in entries {
        let hash = entry
            .get("tx_hash")
            .and_then(Value::as_str)
            .filter(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
            .ok_or_else(|| invalid("entry has no canonical tx_hash"))?;
        let pos = entry
            .get("tx_pos")
            .and_then(Value::as_u64)
            .and_then(|pos| u32::try_from(pos).ok())
            .ok_or_else(|| invalid("entry has no tx_pos"))?;
        let value = entry
            .get("value")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("entry has no value"))?;
        entry
            .get("height")
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid("entry has no height"))?;
        if !seen.insert((hash, pos)) {
            return Err(invalid("lists an output twice"));
        }
        if hash == tx_hash && pos == tx_pos {
            found = Some(value);
        }
    }
    Ok(found)
}

fn electrum_scripthash(script: &[u8]) -> String {
    let mut hash = Sha256::digest(script).to_vec();
    hash.reverse();
    hex::encode(hash)
}
fn protocol_at_least(value: &str, major: u32, minor: u32, patch: u32) -> bool {
    let mut parts = value
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0));
    let got = (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    );
    got >= (major, minor, patch)
}
fn merge_history(
    txs: &mut BTreeMap<[u8; 32], i64>,
    value: &Value,
) -> Result<(), ChainBackendError> {
    let entries = value.as_array().ok_or_else(|| {
        ChainBackendError::InvalidResponse("history result is not an array".into())
    })?;
    for entry in entries {
        let object = entry.as_object().ok_or_else(|| {
            ChainBackendError::InvalidResponse("history entry is not an object".into())
        })?;
        let txid = decode_display_hash(object.get("tx_hash").and_then(Value::as_str).ok_or_else(
            || ChainBackendError::InvalidResponse("history entry lacks tx_hash".into()),
        )?)?;
        let height = object
            .get("height")
            .and_then(Value::as_i64)
            .filter(|height| (-1..=i64::from(u32::MAX)).contains(height))
            .ok_or_else(|| {
                ChainBackendError::InvalidResponse(
                    "history height is missing or outside BCH range".into(),
                )
            })?;
        if txs.len() >= MAX_WALLET_TRANSACTIONS && !txs.contains_key(&txid) {
            return Err(ChainBackendError::InvalidResponse(
                "wallet history exceeds transaction limit".into(),
            ));
        }
        txs.entry(txid)
            .and_modify(|known| *known = (*known).max(height))
            .or_insert(height);
    }
    Ok(())
}
fn parse_tip(value: &Value) -> Result<Option<ChainTip>, ChainBackendError> {
    let Some(object) = value.as_object() else {
        return Ok(None);
    };
    let Some(height) = object.get("height").and_then(Value::as_u64) else {
        return Ok(None);
    };
    let header_hex = object
        .get("hex")
        .or_else(|| object.get("header"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ChainBackendError::InvalidResponse("headers.subscribe lacks header hex".into())
        })?;
    let header = parse_header_hex(header_hex)?;
    Ok(Some(ChainTip {
        height: u32::try_from(height)
            .map_err(|_| ChainBackendError::InvalidResponse("tip height exceeds u32".into()))?,
        hash: sha256d(&header),
    }))
}
fn parse_headers_result(value: &Value) -> Result<Vec<[u8; 80]>, ChainBackendError> {
    let object = value.as_object().ok_or_else(|| {
        ChainBackendError::InvalidResponse("block.headers result is not an object".into())
    })?;
    if let Some(headers) = object.get("headers").and_then(Value::as_array) {
        return headers
            .iter()
            .map(|header| {
                header
                    .as_str()
                    .ok_or_else(|| {
                        ChainBackendError::InvalidResponse(
                            "headers array contains non-string value".into(),
                        )
                    })
                    .and_then(parse_header_hex)
            })
            .collect();
    }
    let concatenated = object.get("hex").and_then(Value::as_str).ok_or_else(|| {
        ChainBackendError::InvalidResponse(
            "block.headers result has neither headers[] nor hex".into(),
        )
    })?;
    if concatenated.len() % 160 != 0 {
        return Err(ChainBackendError::InvalidResponse(
            "concatenated header hex is not a multiple of 80 bytes".into(),
        ));
    }
    (0..concatenated.len() / 160)
        .map(|i| parse_header_hex(&concatenated[i * 160..(i + 1) * 160]))
        .collect()
}
fn parse_header_hex(value: &str) -> Result<[u8; 80], ChainBackendError> {
    let bytes = hex::decode(value)
        .map_err(|e| ChainBackendError::InvalidResponse(format!("invalid header hex: {e}")))?;
    bytes.try_into().map_err(|bytes: Vec<u8>| {
        ChainBackendError::InvalidResponse(format!("header must be 80 bytes, got {}", bytes.len()))
    })
}
fn validate_genesis(features: &Value, expected: [u8; 32]) -> Result<(), ChainBackendError> {
    let advertised = features["genesis_hash"].as_str().ok_or_else(|| {
        ChainBackendError::InvalidResponse("server omitted its chain genesis identity".into())
    })?;
    if decode_display_hash(advertised)? != expected {
        return Err(ChainBackendError::InvalidResponse(
            "server genesis differs from the selected chain".into(),
        ));
    }
    // A matching genesis is a network-mismatch guard, not consensus proof:
    // forks sharing genesis still require trusted post-fork checkpoints.
    Ok(())
}

/// What a server's error reply to `blockchain.transaction.broadcast` says.
///
/// Fulcrum and ElectrumX pass the node's message on after a fixed preamble,
/// `the transaction was rejected by network rules.`, a blank line, and then
/// the message on a line of its own (ElectrumX then appends the transaction).
/// Only the node's own words are read, and only exactly (see
/// `classify_node_message`).
fn broadcast_error_reply(error: &str) -> NodeBroadcastReply {
    let message = serde_json::from_str::<Value>(error).ok().and_then(|error| {
        error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let node = message
        .as_deref()
        .and_then(|message| message.strip_prefix("the transaction was rejected by network rules."))
        .and_then(|rest| rest.trim_start().lines().next());
    node.map_or(NodeBroadcastReply::Other, classify_node_message)
}

fn decode_display_hash(value: &str) -> Result<[u8; 32], ChainBackendError> {
    let mut bytes = hex::decode(value)
        .map_err(|e| ChainBackendError::InvalidResponse(format!("invalid hash hex: {e}")))?;
    if bytes.len() != 32 {
        return Err(ChainBackendError::InvalidResponse(format!(
            "hash must be 32 bytes, got {}",
            bytes.len()
        )));
    }
    bytes.reverse();
    bytes.try_into().map_err(|_| {
        ChainBackendError::InvalidResponse("hash conversion failed unexpectedly".into())
    })
}
fn display_hash(mut hash: [u8; 32]) -> String {
    hash.reverse();
    hex::encode(hash)
}
fn map_io(_: std::io::Error) -> ChainBackendError {
    ChainBackendError::Offline
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertised_peers_keep_public_tls_names_and_onions_only_over_tor() {
        let peers = json!([
            [
                "203.0.113.7",
                "Fulcrum.Example.org.",
                ["v1.5.2", "s50002", "t50001"]
            ],
            ["203.0.113.8", "bch.example.net", ["v1.5", "s", "p10000"]],
            ["203.0.113.9", "plain.example.net", ["v1.4", "t50001"]],
            [
                "198.51.100.1",
                "exampleonionaddressxyz.onion",
                ["v1.5", "t50001"]
            ],
            ["192.168.1.5", "192.168.1.5", ["s50002"]],
            ["10.0.0.2", "router", ["s50002"]],
            ["127.0.0.1", "localhost", ["s50002"]],
            ["10.0.0.3", "node.local", ["s50002"]],
            ["10.0.0.4", "node.home.arpa", ["s50002"]],
            ["203.0.113.10", "bad_name.example.org", ["s50002"]],
            ["203.0.113.11", "zero.example.org", ["s0"]],
            ["203.0.113.12", "fulcrum.example.org", ["s50002"]],
            "not an entry",
            ["203.0.113.13"]
        ]);
        let tls = |host: &str, port| Endpoint {
            kind: EndpointKind::ElectrumTls,
            host: host.into(),
            port: Some(port),
        };
        assert_eq!(
            advertised_peers(&peers, false, 32),
            vec![
                tls("fulcrum.example.org", 50002),
                tls("bch.example.net", 50002),
            ]
        );
        let with_tor = advertised_peers(&peers, true, 32);
        assert_eq!(
            with_tor.last(),
            Some(&Endpoint {
                kind: EndpointKind::ElectrumTcp,
                host: "exampleonionaddressxyz.onion".into(),
                port: Some(50001),
            })
        );
        assert_eq!(advertised_peers(&peers, true, 1).len(), 1);
        assert!(advertised_peers(&json!({"not": "a list"}), true, 32).is_empty());
    }

    #[tokio::test]
    async fn pipelined_requests_require_every_matching_reply_and_preserve_order() {
        for mode in ["reordered", "duplicate", "missing", "foreign", "error"] {
            let (client, server) = tokio::io::duplex(8192);
            let mut session = Session {
                reader: BufReader::new(Box::new(client)),
                next_id: 1,
                request_timeout: Duration::from_secs(2),
                protocol: String::new(),
                poisoned: false,
            };
            let peer = tokio::spawn(async move {
                let mut server = BufReader::new(server);
                let mut ids = Vec::new();
                // Refuse to respond until all requests arrive: serial calls deadlock.
                for _ in 0..3 {
                    let mut line = String::new();
                    server.read_line(&mut line).await.unwrap();
                    ids.push(serde_json::from_str::<Value>(&line).unwrap()["id"].clone());
                }
                let responses = match mode {
                    "reordered" => vec![
                        json!({"method":"blockchain.headers.subscribe","params":[]}),
                        json!({"id":ids[2],"result":30}),
                        json!({"id":ids[0],"result":10}),
                        json!({"id":ids[1],"result":null}),
                    ],
                    "duplicate" => vec![
                        json!({"id":ids[0],"result":10}),
                        json!({"id":ids[0],"result":10}),
                    ],
                    "missing" => vec![json!({"id":ids[0],"result":10})],
                    "foreign" => vec![json!({"id":99,"result":10})],
                    _ => vec![json!({"id":ids[0],"error":{"code":1,"message":"rejected"}})],
                };
                for response in responses {
                    server
                        .get_mut()
                        .write_all(format!("{response}\n").as_bytes())
                        .await
                        .unwrap();
                }
            });
            let result = session
                .call_many(&[
                    ("first", json!([])),
                    ("second", json!([])),
                    ("third", json!([])),
                ])
                .await;
            if mode == "reordered" {
                assert_eq!(result.unwrap(), vec![json!(10), Value::Null, json!(30)]);
            } else {
                assert!(
                    result.is_err(),
                    "{mode} must not acknowledge a complete group"
                );
            }
            peer.await.unwrap();
        }
        for height in [
            json!(null),
            json!(-2),
            json!(u64::from(u32::MAX) + 1),
            json!(1.5),
        ] {
            assert!(merge_history(
                &mut BTreeMap::new(),
                &json!([{"tx_hash":"ab".repeat(32),"height":height}])
            )
            .is_err());
        }
    }

    #[tokio::test]
    async fn full_pipeline_preserves_all_reordered_replies_above_legacy_limit() {
        const REQUEST_COUNT: usize = 64;
        let (client, server) = tokio::io::duplex(8192);
        let mut session = Session {
            reader: BufReader::new(Box::new(client)),
            next_id: 7,
            request_timeout: Duration::from_secs(2),
            protocol: String::new(),
            poisoned: false,
        };
        let peer = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            let mut ids = Vec::new();
            // Require the whole window before replying, including requests beyond 16.
            for index in 0..REQUEST_COUNT {
                let mut line = String::new();
                assert!(server.read_line(&mut line).await.unwrap() > 0);
                let request: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(request["id"], json!(7 + index));
                assert_eq!(request["params"], json!([index]));
                ids.push(request["id"].clone());
            }
            // The complete response group exceeds the duplex buffer size.
            for index in (0..REQUEST_COUNT).rev() {
                let response = json!({
                    "id": ids[index],
                    "result": [index, "x".repeat(256)],
                });
                server
                    .get_mut()
                    .write_all(format!("{response}\n").as_bytes())
                    .await
                    .unwrap();
            }
        });
        let requests: Vec<_> = (0..REQUEST_COUNT)
            .map(|index| ("fixture", json!([index])))
            .collect();
        let expected: Vec<_> = (0..REQUEST_COUNT)
            .map(|index| json!([index, "x".repeat(256)]))
            .collect();
        assert_eq!(session.call_many(&requests).await.unwrap(), expected);
        assert_eq!(session.next_id, 7 + REQUEST_COUNT as u64);
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn oversized_pipeline_is_rejected_before_io() {
        let (client, mut server) = tokio::io::duplex(8192);
        let mut session = Session {
            reader: BufReader::new(Box::new(client)),
            next_id: 7,
            request_timeout: Duration::from_secs(2),
            protocol: String::new(),
            poisoned: false,
        };
        let requests = vec![("fixture", json!([])); MAX_PENDING_REQUESTS + 1];
        assert!(matches!(
            session.call_many(&requests).await,
            Err(ChainBackendError::Rejected(message))
                if message == "invalid Electrum request group size"
        ));
        assert_eq!(session.next_id, 7);
        drop(session);
        let mut written = Vec::new();
        server.read_to_end(&mut written).await.unwrap();
        assert!(written.is_empty());
    }

    #[tokio::test]
    async fn oversized_rpc_frame_is_rejected_before_parsing() {
        let (client, server) = tokio::io::duplex(8192);
        let mut session = Session {
            reader: BufReader::new(Box::new(client)),
            next_id: 1,
            request_timeout: Duration::from_secs(5),
            protocol: String::new(),
            poisoned: false,
        };
        let peer = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            let mut request = String::new();
            server.read_line(&mut request).await.unwrap();
            server
                .get_mut()
                .write_all(&vec![b' '; MAX_RESPONSE_BYTES + 1])
                .await
                .unwrap();
        });
        assert!(matches!(
            session.call("server.features", json!([])).await,
            Err(ChainBackendError::InvalidResponse(message))
                if message.contains("oversized or truncated")
        ));
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn tls_configuration_reaches_handshake_without_global_provider_setup() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let peer = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut hello = [0; 5];
            stream.read_exact(&mut hello).await.unwrap();
            // Deliberately invalid TLS. It must return an error, never panic
            // before the handshake or silently accept a plaintext endpoint.
            stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
        });
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        assert!(matches!(
            connect_tls("localhost", stream, Duration::from_secs(2)).await,
            Err(ChainBackendError::Protocol(_))
        ));
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn transaction_lookup_crosses_real_wire_adapter_and_shared_service() {
        use optn_runtime::chain::{
            ChainSource, ConnectionPolicy, SourceCatalog, SourceDisposition, SourceOrigin,
        };
        use optn_runtime::chain_service::ChainService;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // Opaque byte fixtures exercise identity checking, not BCH validity.
        let raw = vec![1u8, 2, 3];
        let txid = sha256d(&raw);
        let expected_id = display_hash(txid);
        let response_hex = hex::encode(&raw);
        let server = tokio::spawn(async move {
            let mut lookups = 0;
            for connection in 0..3 {
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut first = true;
                loop {
                    let mut line = String::new();
                    if stream.read_line(&mut line).await.unwrap() == 0 {
                        break;
                    }
                    let request: Value = serde_json::from_str(&line).unwrap();
                    let method = request["method"].as_str().unwrap();
                    if first {
                        assert_eq!(method, "server.version");
                        first = false;
                    }
                    let result = match method {
                        "server.version" => json!(["local-test", "1.6"]),
                        "server.features" => match connection {
                            1 => json!({"genesis_hash": hex::encode([8; 32])}),
                            2 => json!({}),
                            _ => json!({"genesis_hash": hex::encode([9; 32])}),
                        },
                        "server.peers.subscribe" => json!([]),
                        "blockchain.transaction.get" => {
                            // A wrong-chain connection must never be told the txid.
                            assert_eq!(connection, 0);
                            assert_eq!(request["params"][0], expected_id);
                            assert_eq!(request["params"][1], false);
                            lookups += 1;
                            if lookups == 1 {
                                json!(response_hex)
                            } else {
                                json!("ff")
                            }
                        }
                        "blockchain.transaction.get_merkle" => {
                            assert_eq!(request["params"], json!([expected_id]));
                            json!({"block_height": 77, "merkle": [], "pos": 0})
                        }
                        other => panic!("unexpected request: {other}"),
                    };
                    let response = json!({"id": request["id"], "result": result, "error": null});
                    stream
                        .get_mut()
                        .write_all(format!("{response}\n").as_bytes())
                        .await
                        .unwrap();
                }
            }
            assert_eq!(lookups, 2);
        });
        timeout(Duration::from_secs(5), async {
            let id = SourceId::new("local-query");
            let endpoint = Endpoint {
                kind: EndpointKind::ElectrumTcp,
                host: "127.0.0.1".into(),
                port: Some(port),
            };
            let backend = ElectrumBackend::connect(ElectrumConfig::new(
                id.clone(),
                endpoint.clone(),
                ElectrumTransport::Tcp,
                [9; 32],
            ))
            .await
            .unwrap();
            let mut catalog = SourceCatalog::default();
            for interests in [
                vec![
                    WalletInterest::script(vec![0x51]),
                    WalletInterest::outpoint(txid, 0),
                ],
                vec![
                    WalletInterest::script(vec![0x51]),
                    WalletInterest::rpa_prefix("ab").unwrap(),
                ],
            ] {
                assert_eq!(
                    backend
                        .execute(&ChainRequest::WalletRefresh {
                            interests,
                            from_height: None,
                        })
                        .await,
                    Err(ChainBackendError::Unsupported)
                );
            }
            catalog
                .insert(ChainSource {
                    id: id.clone(),
                    label: "Local test".into(),
                    origin: SourceOrigin::UserAdded,
                    endpoints: vec![endpoint],
                    capabilities: CapabilitySet::default(),
                    disposition: SourceDisposition::Enabled,
                    priority: 0,
                })
                .unwrap();
            let mut service = ChainService::new(
                catalog,
                ConnectionPolicy::exact(id.clone(), ProtocolFamily::Electrum),
            );
            let backend = Arc::new(backend);
            service.register(backend.clone());
            let observation = service
                .execute(&ChainRequest::TransactionLookup { txid })
                .await
                .unwrap();
            assert_eq!(observation.source, id);
            let ChainPayload::Transaction(transaction) = observation.value else {
                panic!("wrong payload");
            };
            assert_eq!(transaction.raw, raw);
            assert_eq!(transaction.txid, txid);
            assert_eq!(transaction.block_height, Some(77));
            assert!(service
                .execute(&ChainRequest::TransactionLookup { txid })
                .await
                .is_err());
            // The failed reply discarded the connection. Reconnects must recheck
            // chain identity before revealing the txid.
            for _ in 0..2 {
                assert!(matches!(
                    backend
                        .execute(&ChainRequest::TransactionLookup { txid })
                        .await,
                    Err(ChainBackendError::InvalidResponse(_))
                ));
            }
            drop(service);
            drop(backend);
            server.await.unwrap();
        })
        .await
        .expect("bounded loopback adapter test");
    }

    /// A loopback Electrum server for outpoint lookups. Every connection is
    /// counted; replies follow the scripted protocol and UTXO answer.
    async fn spentness_server(
        protocol: &'static str,
        raw: Vec<u8>,
        utxo: Value,
        listed: Value,
    ) -> (u16, tokio::task::JoinHandle<(usize, Vec<Value>)>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let mut connections = 0;
            let mut calls = Vec::new();
            while let Ok(Ok((stream, _))) =
                timeout(Duration::from_millis(500), listener.accept()).await
            {
                connections += 1;
                let mut stream = BufReader::new(stream);
                loop {
                    let mut line = String::new();
                    if stream.read_line(&mut line).await.unwrap_or(0) == 0 {
                        break;
                    }
                    let request: Value = serde_json::from_str(&line).unwrap();
                    calls.push(request.clone());
                    let method = request["method"].as_str().unwrap();
                    if method == "blockchain.utxo.get_info" && utxo == json!("refuse") {
                        let response = json!({"id": request["id"], "result": null,
                            "error": {"code": -32601, "message": "unknown method"}});
                        if stream
                            .get_mut()
                            .write_all(
                                format!(
                                    "{response}
"
                                )
                                .as_bytes(),
                            )
                            .await
                            .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                    let result = match method {
                        "server.version" => json!(["spentness-test", protocol]),
                        "server.features" => json!({"genesis_hash": display_hash([9; 32])}),
                        "server.peers.subscribe" => json!([]),
                        "blockchain.headers.subscribe" => {
                            json!({"height": 500, "hex": "11".repeat(80)})
                        }
                        "blockchain.transaction.get" => json!(hex::encode(&raw)),
                        "blockchain.utxo.get_info" => utxo.clone(),
                        "blockchain.scripthash.listunspent" => listed.clone(),
                        other => panic!("unexpected request: {other}"),
                    };
                    let response = json!({"id": request["id"], "result": result, "error": null});
                    if stream
                        .get_mut()
                        .write_all(format!("{response}\n").as_bytes())
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
            (connections, calls)
        });
        (port, server)
    }

    fn one_output_transaction(script: &[u8], value: u64) -> Vec<u8> {
        let mut raw = 2u32.to_le_bytes().to_vec();
        raw.push(1);
        raw.extend([4; 32]);
        raw.extend(0u32.to_le_bytes());
        raw.push(0);
        raw.extend(u32::MAX.to_le_bytes());
        raw.push(1);
        raw.extend(value.to_le_bytes());
        raw.push(script.len() as u8);
        raw.extend(script);
        raw.extend(0u32.to_le_bytes());
        optn_core::tx::decode(&raw).expect("structurally valid fixture");
        raw
    }

    async fn spentness(
        protocol: &'static str,
        raw: Vec<u8>,
        utxo: Value,
        listed: Value,
    ) -> (
        Result<BackendObservation, ChainBackendError>,
        usize,
        Vec<Value>,
    ) {
        let txid = sha256d(&raw);
        let (port, server) = spentness_server(protocol, raw, utxo, listed).await;
        let backend = ElectrumBackend::connect(ElectrumConfig::new(
            SourceId::new("spentness-test"),
            Endpoint {
                kind: EndpointKind::ElectrumTcp,
                host: "127.0.0.1".into(),
                port: Some(port),
            },
            ElectrumTransport::Tcp,
            [9; 32],
        ))
        .await
        .unwrap();
        assert!(backend.supports(ChainOperation::OutpointSpentness));
        let result = backend
            .execute(&ChainRequest::OutpointSpentness { txid, vout: 0 })
            .await;
        drop(backend);
        let (connections, calls) = server.await.unwrap();
        (result, connections, calls)
    }

    #[tokio::test]
    async fn utxo_info_binds_an_unspent_answer_to_the_output_and_the_tip() {
        let script = [0x51];
        let raw = one_output_transaction(&script, 1234);
        let txid = sha256d(&raw);
        let info = json!({"scripthash": electrum_scripthash(&script), "value": 1234});
        let (result, connections, calls) = spentness("1.5", raw, info, Value::Null).await;
        let tip = sha256d(&[0x11; 80]);
        assert_eq!(
            result.unwrap(),
            BackendObservation {
                payload: ChainPayload::OutpointSpentness(OutpointSpentness::Unspent {
                    txid,
                    vout: 0,
                    value_sats: 1234,
                    script_pubkey: script.to_vec(),
                    best_block: tip,
                }),
                evidence: Evidence::ServerAssertion,
                chain_tip: Some((500, tip)),
            }
        );
        // The probe connection carried the lookup: one handshake in all.
        assert_eq!(connections, 1);
        let methods: Vec<_> = calls.iter().map(|call| call["method"].clone()).collect();
        assert_eq!(
            methods[methods.len() - 3..],
            [
                json!("blockchain.headers.subscribe"),
                json!("blockchain.transaction.get"),
                json!("blockchain.utxo.get_info"),
            ]
        );
    }

    #[tokio::test]
    async fn an_absent_utxo_is_unknown_never_spent() {
        let raw = one_output_transaction(&[0x51], 1234);
        let txid = sha256d(&raw);
        let (result, ..) = spentness("1.6", raw, Value::Null, Value::Null).await;
        assert_eq!(
            result.unwrap().payload,
            ChainPayload::OutpointSpentness(OutpointSpentness::Unknown { txid, vout: 0 })
        );
    }

    #[tokio::test]
    async fn a_utxo_answer_that_contradicts_the_transaction_is_refused() {
        let script = [0x51];
        for info in [
            json!({"scripthash": electrum_scripthash(&[0x52]), "value": 1234}),
            json!({"scripthash": electrum_scripthash(&script), "value": 1235}),
            json!({"value": 1234}),
            json!(true),
        ] {
            let raw = one_output_transaction(&script, 1234);
            let (result, ..) = spentness("1.6", raw, info, Value::Null).await;
            assert!(
                matches!(result, Err(ChainBackendError::InvalidResponse(_))),
                "{result:?}"
            );
        }
    }

    #[tokio::test]
    async fn servers_before_utxo_info_answer_from_the_address_unspent_list() {
        let script = [0x51];
        let raw = one_output_transaction(&script, 1234);
        let txid = sha256d(&raw);
        let listed = json!([
            {"tx_hash": display_hash(txid), "tx_pos": 1, "height": 9, "value": 7},
            {"tx_hash": display_hash(txid), "tx_pos": 0, "height": 9, "value": 1234},
        ]);
        let (result, _, calls) = spentness("1.4.3", raw.clone(), Value::Null, listed).await;
        assert!(matches!(
            result.unwrap().payload,
            ChainPayload::OutpointSpentness(OutpointSpentness::Unspent {
                value_sats: 1234,
                ..
            })
        ));
        assert!(calls
            .iter()
            .all(|call| call["method"] != "blockchain.utxo.get_info"));
        let listunspent = calls
            .iter()
            .find(|call| call["method"] == "blockchain.scripthash.listunspent")
            .expect("the fallback asks for the address's unspent outputs");
        assert_eq!(listunspent["params"], json!([electrum_scripthash(&script)]));

        let (result, ..) = spentness("1.4", raw, Value::Null, json!([])).await;
        assert!(matches!(
            result.unwrap().payload,
            ChainPayload::OutpointSpentness(OutpointSpentness::Unknown { .. })
        ));
    }

    #[tokio::test]
    async fn a_server_refusing_utxo_info_is_asked_the_older_way() {
        let script = [0x51];
        let raw = one_output_transaction(&script, 1234);
        let txid = sha256d(&raw);
        let listed = json!([
            {"tx_hash": display_hash(txid), "tx_pos": 0, "height": 9, "value": 1234},
        ]);
        let (result, connections, calls) = spentness("1.6", raw, json!("refuse"), listed).await;
        assert!(matches!(
            result.unwrap().payload,
            ChainPayload::OutpointSpentness(OutpointSpentness::Unspent {
                value_sats: 1234,
                ..
            })
        ));
        // Same connection throughout: the refusal is an answer, not a failure.
        assert_eq!(connections, 1);
        assert!(calls
            .iter()
            .any(|call| call["method"] == "blockchain.scripthash.listunspent"));
    }

    async fn script_unspent(
        listed: Value,
        outputs: &[(Vec<u8>, [u8; 32], u32)],
    ) -> (
        Result<Vec<Result<Option<u64>, ChainBackendError>>, ChainBackendError>,
        usize,
        Vec<Value>,
    ) {
        let (port, server) = spentness_server("1.5", vec![], Value::Null, listed).await;
        let backend = ElectrumBackend::connect(ElectrumConfig::new(
            SourceId::new("fusion-lookup-test"),
            Endpoint {
                kind: EndpointKind::ElectrumTcp,
                host: "127.0.0.1".into(),
                port: Some(port),
            },
            ElectrumTransport::Tcp,
            [9; 32],
        ))
        .await
        .unwrap();
        let result = backend.script_unspent_values(outputs).await;
        drop(backend);
        let (connections, calls) = server.await.unwrap();
        (result, connections, calls)
    }

    #[tokio::test]
    async fn a_script_unspent_list_answers_each_output_on_one_connection() {
        let txid = [7; 32];
        let listed = json!([
            {"tx_hash": display_hash(txid), "tx_pos": 3, "height": 0, "value": 200_000},
            {"tx_hash": display_hash([8; 32]), "tx_pos": 0, "height": 9, "value": 1,
             "token_data": {"category": "aa".repeat(32), "amount": "1"}},
        ]);
        let script = vec![0x76, 0xa9, 0x14, 1, 2, 0x88, 0xac];
        let (result, connections, calls) = script_unspent(
            listed,
            &[(script.clone(), txid, 3), (script.clone(), txid, 4)],
        )
        .await;
        let answers: Vec<_> = result.unwrap().into_iter().map(Result::unwrap).collect();
        // Unconfirmed counts; a token output beside it does not spoil the list.
        assert_eq!(answers, vec![Some(200_000), None]);
        assert_eq!(connections, 1, "the probe's connection carried both");
        let asked: Vec<_> = calls
            .iter()
            .filter(|call| call["method"] == "blockchain.scripthash.listunspent")
            .map(|call| call["params"].clone())
            .collect();
        assert_eq!(asked, vec![json!([electrum_scripthash(&script)]); 2]);
    }

    #[tokio::test]
    async fn a_malformed_script_unspent_list_is_never_an_absence() {
        // Letters in the hash, so its case can be wrong.
        let txid = [0xab; 32];
        let good = json!({"tx_hash": display_hash(txid), "tx_pos": 3, "height": 1, "value": 5});
        for listed in [
            json!({"not": "a list"}),
            json!([good.clone(), good.clone()]),
            json!([{"tx_hash": display_hash(txid).to_uppercase(), "tx_pos": 3, "height": 1, "value": 5}]),
            json!([{"tx_hash": display_hash(txid), "tx_pos": 3, "value": 5}]),
            json!([{"tx_hash": display_hash(txid), "tx_pos": 3, "height": 1}]),
            json!([{"tx_hash": "00", "tx_pos": 3, "height": 1, "value": 5}]),
            Value::Array(
                (0..=MAX_SCRIPT_UNSPENT_ENTRIES as u32)
                    .map(|pos| json!({"tx_hash": display_hash(txid), "tx_pos": pos, "height": 1, "value": 5}))
                    .collect(),
            ),
        ] {
            let (result, ..) = script_unspent(listed.clone(), &[(vec![0x51], [6; 32], 0)]).await;
            assert!(
                matches!(
                    result.unwrap().as_slice(),
                    [Err(ChainBackendError::InvalidResponse(_))]
                ),
                "{listed}"
            );
        }
    }

    #[test]
    fn scripthash_matches_protocol_byte_order() {
        let script = hex::decode("76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac").unwrap();
        assert_eq!(
            electrum_scripthash(&script),
            "8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161"
        )
    }
    #[test]
    fn version_compare_handles_151_and_16() {
        assert!(!protocol_at_least("1.5", 1, 5, 1));
        assert!(protocol_at_least("1.5.1", 1, 5, 1));
        assert!(protocol_at_least("1.6", 1, 5, 1));
    }
    #[test]
    fn rpa_prefix_keeps_odd_nibble() {
        assert!(validate_rpa_prefix("abc").is_ok());
        assert!(validate_rpa_prefix("not-hex").is_err());
    }
    #[test]
    fn parses_both_header_encodings() {
        let v = json!({"headers":["00".repeat(80),"11".repeat(80)]});
        assert_eq!(parse_headers_result(&v).unwrap().len(), 2);
        let v = json!({"hex":format!("{}{}","22".repeat(80),"33".repeat(80))});
        assert_eq!(parse_headers_result(&v).unwrap().len(), 2);
    }

    /// Broadcast once against a loopback server that answers with `error`,
    /// Fulcrum's way: code 1 and the node's message after its preamble.
    async fn broadcast_meeting(
        node_message: &str,
    ) -> Result<BackendObservation, ChainBackendError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let message = format!("the transaction was rejected by network rules.\n\n{node_message}\n");
        let server = tokio::spawn(async move {
            while let Ok(Ok((stream, _))) =
                timeout(Duration::from_millis(500), listener.accept()).await
            {
                let mut stream = BufReader::new(stream);
                loop {
                    let mut line = String::new();
                    if stream.read_line(&mut line).await.unwrap_or(0) == 0 {
                        break;
                    }
                    let request: Value = serde_json::from_str(&line).unwrap();
                    let response = match request["method"].as_str().unwrap() {
                        "blockchain.transaction.broadcast" => json!({"id": request["id"],
                            "result": null, "error": {"code": 1, "message": message}}),
                        method => {
                            let result = match method {
                                "server.version" => json!(["broadcast-test", "1.5"]),
                                "server.features" => {
                                    json!({"genesis_hash": display_hash([9; 32])})
                                }
                                "server.peers.subscribe" => json!([]),
                                "blockchain.headers.subscribe" => {
                                    json!({"height": 500, "hex": "11".repeat(80)})
                                }
                                other => panic!("unexpected request: {other}"),
                            };
                            json!({"id": request["id"], "result": result, "error": null})
                        }
                    };
                    if stream
                        .get_mut()
                        .write_all(format!("{response}\n").as_bytes())
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        });
        let backend = ElectrumBackend::connect(ElectrumConfig::new(
            SourceId::new("broadcast-test"),
            Endpoint {
                kind: EndpointKind::ElectrumTcp,
                host: "127.0.0.1".into(),
                port: Some(port),
            },
            ElectrumTransport::Tcp,
            [9; 32],
        ))
        .await
        .unwrap();
        let raw = one_output_transaction(&[0x51], 1234);
        let txid = sha256d(&raw);
        let result = backend
            .execute(&ChainRequest::Broadcast { raw_tx: raw, txid })
            .await;
        drop(backend);
        server.await.unwrap();
        result
    }

    #[tokio::test]
    async fn a_transaction_the_node_already_has_was_broadcast_not_rejected() {
        for node_message in [
            "txn-already-in-mempool (code 18)",
            "txn-already-known (code 18)",
            "transaction already in block chain",
        ] {
            let observation = broadcast_meeting(node_message)
                .await
                .unwrap_or_else(|error| panic!("{node_message}: {error:?}"));
            assert!(
                matches!(observation.payload, ChainPayload::BroadcastObserved { .. }),
                "{node_message}"
            );
            assert_eq!(observation.evidence, Evidence::ServerAssertion);
        }
    }

    #[tokio::test]
    async fn a_conflicting_spend_is_rejected_and_other_refusals_stay_uncertain() {
        assert!(matches!(
            broadcast_meeting("txn-mempool-conflict (code 18)").await,
            Err(ChainBackendError::Rejected(reason)) if reason.contains("txn-mempool-conflict")
        ));
        assert!(matches!(
            broadcast_meeting("bad-txns-inputs-missingorspent (code 16)").await,
            Err(ChainBackendError::Protocol(_))
        ));
    }
}
