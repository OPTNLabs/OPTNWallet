#![forbid(unsafe_code)]

//! Rust-native Electrum/Fulcrum adapter for OPTN's provider-neutral chain runtime.
//!
//! This crate owns the Electrum wire protocol, not wallet state. It translates
//! responses into `optn-runtime` typed observations. Standard Electrum checkpoint
//! Merkle branches remain proof *material*; SHV/MMR validation is performed by
//! the shared runtime verifier rather than being asserted by this adapter.

use optn_core::header_hash::sha256d;
use optn_runtime::chain::{
    Capability, CapabilityConfidence, CapabilityDiscovery, CapabilitySet, Endpoint, EndpointKind,
    Evidence, ProtocolFamily, ProviderHealth, SourceId,
};
use optn_runtime::chain_service::{
    BackendObservation, ChainBackend, ChainBackendError, ChainFuture, ChainOperation, ChainPayload,
    ChainRequest, ChainTip, ObservedTransaction,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::rustls::{
    pki_types::ServerName, ClientConfig, RootCertStore,
};
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
    /// SOCKS5 isolation credentials should be fresh per logical connection when
    /// the caller wants Tor stream isolation. TLS may be layered over SOCKS.
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
            client_name: CLIENT_NAME.to_owned(),
            protocol_min: PROTOCOL_MIN.to_owned(),
            protocol_max: PROTOCOL_MAX.to_owned(),
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
    /// Probe the endpoint before registration. `server.version` is deliberately
    /// the first Electrum request on the connection.
    pub async fn connect(config: ElectrumConfig) -> Result<Self, ChainBackendError> {
        validate_endpoint(&config)?;
        let mut session = Session::connect(&config).await?;
        let (software, protocol) = session.negotiate(&config).await?;
        let features = session.call("server.features", json!([])).await?;
        let peers = session
            .call("server.peers.subscribe", json!([]))
            .await
            .unwrap_or_else(|_| Value::Array(Vec::new()));

        let mut capabilities = CapabilitySet::default();
        capabilities.record(
            Capability::ElectrumProtocol,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ElectrumServerVersion,
        );

        // Negotiated standard protocol methods are usable routes but have not
        // all necessarily been exercised on this connection yet.
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

        // Future compatible extensions can advertise stable OPTN capability
        // names without changing the source model.
        if extension_enabled(&features, "tokens") || feature_enabled(&features, "cash_tokens") {
            capabilities.record(
                Capability::CashTokenIndex,
                CapabilityConfidence::Advertised,
                CapabilityDiscovery::ElectrumServerFeatures,
            );
        }
        if extension_enabled(&features, "bcmr") || feature_enabled(&features, "bcmr") {
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

    /// Actively exercise the RPA extension before promoting it from Advertised
    /// to Verified. Call this before placing the backend into an `Arc` registry.
    pub async fn verify_rpa_prefix(&mut self, prefix: &str) -> Result<(), ChainBackendError> {
        if !self.capabilities.is_usable(Capability::RpaIndex) {
            return Err(ChainBackendError::Unsupported);
        }
        let mut session = self.session().await?;
        session
            .call("blockchain.rpa.get_history", json!([prefix]))
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
        interests: &[Vec<u8>],
    ) -> Result<BackendObservation, ChainBackendError> {
        let mut session = self.session().await?;
        let tip_value = session.call("blockchain.headers.subscribe", json!([])).await?;
        let tip = parse_tip(&tip_value)?;

        // txid -> reported height. Multiple interests can point at one tx.
        let mut txs = BTreeMap::<[u8; 32], i64>::new();
        for interest in interests {
            if interest.len() != 32 {
                return Err(ChainBackendError::InvalidResponse(
                    "Electrum wallet interests must be 32-byte script hashes".into(),
                ));
            }
            let scripthash = hex::encode(interest);
            let history = session
                .call("blockchain.scripthash.get_history", json!([scripthash]))
                .await?;
            let entries = history.as_array().ok_or_else(|| {
                ChainBackendError::InvalidResponse("scripthash history is not an array".into())
            })?;
            for entry in entries {
                let object = entry.as_object().ok_or_else(|| {
                    ChainBackendError::InvalidResponse("history entry is not an object".into())
                })?;
                let tx_hash = object
                    .get("tx_hash")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ChainBackendError::InvalidResponse("history entry lacks tx_hash".into())
                    })?;
                let txid = decode_display_hash(tx_hash)?;
                let height = object.get("height").and_then(Value::as_i64).unwrap_or(0);
                txs.entry(txid)
                    .and_modify(|known| *known = (*known).max(height))
                    .or_insert(height);
            }
        }

        let mut transactions = Vec::with_capacity(txs.len());
        for (txid, height) in txs {
            let raw_hex = session
                .call("blockchain.transaction.get", json!([display_hash(txid), false]))
                .await?
                .as_str()
                .ok_or_else(|| {
                    ChainBackendError::InvalidResponse("transaction.get did not return hex".into())
                })?
                .to_owned();
            let raw = hex::decode(&raw_hex).map_err(|error| {
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
            .call("blockchain.transaction.get", json!([display_hash(txid), false]))
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
            .call("blockchain.transaction.broadcast", json!([hex::encode(raw_tx)]))
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
            // Successful submission is still a server assertion; later exact
            // mempool/P2P observation may strengthen it.
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
            .call(
                "blockchain.block.headers",
                json!([start_height, count, 0]),
            )
            .await?;
        let headers = parse_headers_result(&result)?;
        Ok(BackendObservation {
            payload: ChainPayload::Headers {
                start_height,
                headers,
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
        let header = parse_header_hex(
            object
                .get("header")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ChainBackendError::InvalidResponse("header proof lacks header".into())
                })?,
        )?;
        let siblings = object
            .get("branch")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ChainBackendError::InvalidResponse("header proof lacks branch".into())
            })?
            .iter()
            .map(|item| {
                item.as_str()
                    .ok_or_else(|| {
                        ChainBackendError::InvalidResponse(
                            "header proof branch contains non-string hash".into(),
                        )
                    })
                    .and_then(decode_display_hash)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let root = decode_display_hash(
            object
                .get("root")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ChainBackendError::InvalidResponse("header proof lacks root".into())
                })?,
        )?;

        Ok(BackendObservation {
            payload: ChainPayload::HistoricalHeaderProof {
                height,
                checkpoint_height,
                header,
                siblings,
                root,
            },
            // The adapter has only parsed the standard Electrum checkpoint
            // branch. `ShvMmrHeaderVerifier` must verify it before stronger
            // evidence is assigned.
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
        let capability = optn_runtime::chain_service::operation_capability(operation);
        self.capabilities.is_usable(capability)
    }

    fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
        Box::pin(async move {
            match request {
                ChainRequest::WalletRefresh { interests, .. } => {
                    self.wallet_refresh(interests).await
                }
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
        let io = connect_transport(config).await?;
        Ok(Self {
            reader: BufReader::new(io),
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
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut bytes = serde_json::to_vec(&request)
            .map_err(|error| ChainBackendError::Protocol(error.to_string()))?;
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
                let response: Value = serde_json::from_str(line.trim()).map_err(|error| {
                    ChainBackendError::InvalidResponse(format!("invalid Electrum JSON: {error}"))
                })?;
                if response.get("id").and_then(Value::as_u64) != Some(id) {
                    // Subscription notification or a response to a request this
                    // simple session does not own. Ignore it and wait for ours.
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
        ElectrumTransport::Tcp => {
            let stream = connect_tcp(host, port, config.request_timeout).await?;
            Ok(Box::new(stream))
        }
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
            .map_err(|error| ChainBackendError::Offline)?;
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
        .map_err(|error| ChainBackendError::Protocol(format!("Electrum TLS failed: {error}")))
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
    let actual_tls = match config.transport {
        ElectrumTransport::Tls => true,
        ElectrumTransport::Tcp => false,
        ElectrumTransport::Tor { tls, .. } => tls,
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
        Some(Value::Bool(value)) => *value,
        Some(Value::Null) | None => false,
        Some(_) => true,
    }
}

fn extension_enabled(features: &Value, key: &str) -> bool {
    features
        .get("optn_extensions")
        .and_then(Value::as_object)
        .and_then(|extensions| extensions.get(key))
        .is_some_and(|value| !value.is_null() && value != &Value::Bool(false))
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
        height: u32::try_from(height).map_err(|_| {
            ChainBackendError::InvalidResponse("tip height exceeds u32".into())
        })?,
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
        .map(|index| parse_header_hex(&concatenated[index * 160..(index + 1) * 160]))
        .collect()
}

fn parse_header_hex(value: &str) -> Result<[u8; 80], ChainBackendError> {
    let bytes = hex::decode(value).map_err(|error| {
        ChainBackendError::InvalidResponse(format!("invalid header hex: {error}"))
    })?;
    bytes.try_into().map_err(|bytes: Vec<u8>| {
        ChainBackendError::InvalidResponse(format!(
            "header must be 80 bytes, got {}",
            bytes.len()
        ))
    })
}

fn decode_display_hash(value: &str) -> Result<[u8; 32], ChainBackendError> {
    let mut bytes = hex::decode(value).map_err(|error| {
        ChainBackendError::InvalidResponse(format!("invalid hash hex: {error}"))
    })?;
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

fn map_io(_error: std::io::Error) -> ChainBackendError {
    ChainBackendError::Offline
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_protocol_16_header_array() {
        let header = "00".repeat(80);
        let value = json!({"count": 2, "headers": [header, "11".repeat(80)]});
        let parsed = parse_headers_result(&value).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], [0; 80]);
        assert_eq!(parsed[1], [0x11; 80]);
    }

    #[test]
    fn parses_legacy_concatenated_headers() {
        let value = json!({"count": 2, "hex": format!("{}{}", "22".repeat(80), "33".repeat(80))});
        let parsed = parse_headers_result(&value).unwrap();
        assert_eq!(parsed, vec![[0x22; 80], [0x33; 80]]);
    }

    #[test]
    fn display_hash_round_trips_internal_digest_order() {
        let hash = [7; 32];
        assert_eq!(decode_display_hash(&display_hash(hash)).unwrap(), hash);
    }

    #[test]
    fn optional_extensions_are_capabilities_not_modes() {
        let features = json!({
            "rpa": true,
            "optn_extensions": {
                "tokens": "1.0",
                "bcmr": "1.0",
                "chaingraph": "1.0"
            }
        });
        assert!(feature_enabled(&features, "rpa"));
        assert!(extension_enabled(&features, "tokens"));
        assert!(extension_enabled(&features, "bcmr"));
        assert!(extension_enabled(&features, "chaingraph"));
    }
}
