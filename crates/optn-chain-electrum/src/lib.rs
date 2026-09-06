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
    ChainRequest, ChainTip, ObservedTransaction, WalletInterest,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::rustls::{pki_types::ServerName, ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

trait AsyncIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T> AsyncIo for T where T: AsyncRead + AsyncWrite + Unpin + Send {}
type DynIo = Box<dyn AsyncIo>;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
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
    pub client_name: String,
    pub protocol_min: String,
    pub protocol_max: String,
    pub request_timeout: Duration,
}

impl ElectrumConfig {
    pub fn new(source_id: SourceId, endpoint: Endpoint, transport: ElectrumTransport) -> Self {
        Self {
            source_id,
            endpoint,
            transport,
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
}

impl ElectrumBackend {
    /// Probe before registration. `server.version` is deliberately the first
    /// request on every connection, per Electrum Cash protocol >=1.4.
    pub async fn connect(config: ElectrumConfig) -> Result<Self, ChainBackendError> {
        validate_endpoint(&config)?;
        let mut session = Session::connect(&config).await?;
        let (software, protocol) = session.negotiate(&config).await?;
        let features = session.call("server.features", json!([])).await?;
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
        })
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

    async fn session(&self) -> Result<Session, ChainBackendError> {
        let mut session = Session::connect(&self.config).await?;
        session.negotiate(&self.config).await?;
        Ok(session)
    }

    async fn wallet_refresh(
        &self,
        interests: &[WalletInterest],
        from_height: Option<u32>,
    ) -> Result<BackendObservation, ChainBackendError> {
        let mut session = self.session().await?;
        let tip = parse_tip(
            &session
                .call("blockchain.headers.subscribe", json!([]))
                .await?,
        )?;
        let mut txs = BTreeMap::<[u8; 32], i64>::new();

        for interest in interests {
            match interest {
                WalletInterest::Script(script) => {
                    let sh = electrum_scripthash(script);
                    let params = if protocol_at_least(&self.server_info.protocol, 1, 5, 1) {
                        json!([sh, from_height.unwrap_or(0), -1])
                    } else {
                        json!([sh])
                    };
                    let history = session
                        .call("blockchain.scripthash.get_history", params)
                        .await?;
                    merge_history(&mut txs, &history)?;
                    // get_history pagination excludes mempool in modern servers;
                    // explicitly merge mempool to keep wallet refresh complete.
                    let mempool = session
                        .call("blockchain.scripthash.get_mempool", json!([sh]))
                        .await?;
                    merge_history(&mut txs, &mempool)?;
                }
                WalletInterest::RpaPrefix(prefix) => {
                    validate_rpa_prefix(prefix)?;
                    if !self.capabilities.is_usable(Capability::RpaIndex) {
                        continue;
                    }
                    let start = from_height
                        .unwrap_or_else(|| rpa_starting_height(&self.server_info.features));
                    let history = session
                        .call("blockchain.rpa.get_history", json!([prefix, start, -1]))
                        .await?;
                    merge_history(&mut txs, &history)?;
                    let mempool = session
                        .call("blockchain.rpa.get_mempool", json!([prefix]))
                        .await?;
                    merge_history(&mut txs, &mempool)?;
                }
                // Standard Electrum wallet discovery is script-indexed. Another
                // provider may satisfy Outpoint directly without changing intent.
                WalletInterest::Outpoint { .. } => {}
            }
        }

        let mut transactions = Vec::with_capacity(txs.len());
        for (txid, height) in txs {
            let raw_hex = session
                .call(
                    "blockchain.transaction.get",
                    json!([display_hash(txid), false]),
                )
                .await?
                .as_str()
                .ok_or_else(|| {
                    ChainBackendError::InvalidResponse("transaction.get did not return hex".into())
                })?
                .to_owned();
            let raw = hex::decode(raw_hex).map_err(|error| {
                ChainBackendError::InvalidResponse(format!("invalid transaction hex: {error}"))
            })?;
            if sha256d(&raw) != txid {
                return Err(ChainBackendError::InvalidResponse(
                    "transaction bytes do not match returned txid".into(),
                ));
            }
            transactions.push(ObservedTransaction {
                txid,
                raw,
                block_height: (height > 0).then_some(height as u32),
            });
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
        txid: [u8; 32],
    ) -> Result<BackendObservation, ChainBackendError> {
        let mut session = self.session().await?;
        let raw_hex = session
            .call(
                "blockchain.transaction.get",
                json!([display_hash(txid), false]),
            )
            .await?
            .as_str()
            .ok_or_else(|| {
                ChainBackendError::InvalidResponse("transaction.get did not return hex".into())
            })?
            .to_owned();
        let raw = hex::decode(raw_hex).map_err(|error| {
            ChainBackendError::InvalidResponse(format!("invalid transaction hex: {error}"))
        })?;
        if sha256d(&raw) != txid {
            return Err(ChainBackendError::InvalidResponse(
                "transaction bytes do not match requested txid".into(),
            ));
        }
        Ok(BackendObservation {
            payload: ChainPayload::Transaction(ObservedTransaction {
                txid,
                raw,
                block_height: None,
            }),
            evidence: Evidence::ServerAssertion,
            chain_tip: None,
        })
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
        let mut session = self.session().await?;
        let returned = session
            .call(
                "blockchain.transaction.broadcast",
                json!([hex::encode(raw_tx)]),
            )
            .await?;
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
        start_height: u32,
        count: u32,
    ) -> Result<BackendObservation, ChainBackendError> {
        let mut session = self.session().await?;
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
        height: u32,
        checkpoint_height: u32,
    ) -> Result<BackendObservation, ChainBackendError> {
        if checkpoint_height < height {
            return Err(ChainBackendError::Rejected(
                "checkpoint height must be at or above requested header".into(),
            ));
        }
        let mut session = self.session().await?;
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
                ChainRequest::WalletRefresh {
                    interests,
                    from_height,
                } => self.wallet_refresh(interests, *from_height).await,
                ChainRequest::TransactionLookup { txid } => self.transaction_lookup(*txid).await,
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
            }
        })
    }
}

struct Session {
    reader: BufReader<DynIo>,
    next_id: u64,
    request_timeout: Duration,
}
impl Session {
    async fn connect(config: &ElectrumConfig) -> Result<Self, ChainBackendError> {
        Ok(Self {
            reader: BufReader::new(connect_transport(config).await?),
            next_id: 1,
            request_timeout: config.request_timeout,
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
        match result {
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
        }
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, ChainBackendError> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let mut bytes =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
                .map_err(|e| ChainBackendError::Protocol(e.to_string()))?;
        bytes.push(b'\n');
        timeout(self.request_timeout, async {
            self.reader
                .get_mut()
                .write_all(&bytes)
                .await
                .map_err(map_io)?;
            self.reader.get_mut().flush().await.map_err(map_io)?;
            loop {
                let mut line = String::new();
                let read = self.reader.read_line(&mut line).await.map_err(map_io)?;
                if read == 0 {
                    return Err(ChainBackendError::Offline);
                }
                let response: Value = serde_json::from_str(line.trim()).map_err(|e| {
                    ChainBackendError::InvalidResponse(format!("invalid Electrum JSON: {e}"))
                })?;
                if response.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if let Some(error) = response.get("error") {
                    if !error.is_null() {
                        return Err(ChainBackendError::Protocol(error.to_string()));
                    }
                }
                return response.get("result").cloned().ok_or_else(|| {
                    ChainBackendError::InvalidResponse("Electrum response lacks result".into())
                });
            }
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
    let config = ClientConfig::builder()
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
        let height = object.get("height").and_then(Value::as_i64).unwrap_or(0);
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
}
