#![forbid(unsafe_code)]

//! Rust-native Bitcoin Cash Node RPC adapter.
//!
//! BCHN is a fully validating source, but ordinary RPC is not silently treated
//! as a wallet-history index. Capabilities are limited to what this configured
//! node can actually answer; future node extensions can advertise more through
//! the same provider-neutral capability model.

use optn_core::header_hash::sha256d;
use optn_runtime::chain::{
    Capability, CapabilityConfidence, CapabilityDiscovery, CapabilitySet, Endpoint, EndpointKind,
    Evidence, ProtocolFamily, ProviderHealth, SourceId,
};
use optn_runtime::chain_service::{
    BackendObservation, ChainBackend, ChainBackendError, ChainFuture, ChainOperation, ChainPayload,
    ChainRequest, ObservedTransaction, OutpointSpentness,
};
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::fmt;
use std::time::Duration;
use zeroize::{Zeroize, ZeroizeOnDrop};

// BCHN RPC replies include transaction hex, so keep the same ceiling as the
// native Electrum transport rather than relying on reqwest's unbounded JSON
// convenience reader.
const MAX_RPC_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub enum RpcAuth {
    None,
    Basic { username: String, password: String },
}

impl fmt::Debug for RpcAuth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::None => formatter.write_str("RpcAuth::None"),
            // User names can identify an operator just as passwords can grant
            // access. Neither belongs in a diagnostic or a test failure.
            Self::Basic { .. } => formatter.write_str("RpcAuth::Basic([REDACTED])"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct BchnRpcConfig {
    pub source_id: SourceId,
    pub endpoint: Endpoint,
    pub auth: RpcAuth,
    pub https: bool,
    /// `getrawtransaction` for arbitrary historical txids requires txindex (or
    /// a transaction still available from mempool/wallet context).
    pub txindex: bool,
    pub request_timeout: Duration,
}

impl BchnRpcConfig {
    pub fn new(source_id: SourceId, endpoint: Endpoint, auth: RpcAuth) -> Self {
        Self {
            source_id,
            endpoint,
            auth,
            https: false,
            txindex: false,
            request_timeout: Duration::from_secs(15),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BchnInfo {
    pub chain: String,
    pub blocks: u32,
    pub best_block_hash: [u8; 32],
}

pub struct BchnRpcBackend {
    config: BchnRpcConfig,
    client: Client,
    url: Url,
    capabilities: CapabilitySet,
    info: BchnInfo,
}

impl BchnRpcBackend {
    pub async fn connect(config: BchnRpcConfig) -> Result<Self, ChainBackendError> {
        if config.endpoint.kind != EndpointKind::BchnRpc {
            return Err(ChainBackendError::Rejected(
                "BCHN RPC backend requires a BCHN RPC endpoint".into(),
            ));
        }
        let host = config.endpoint.host.trim();
        let port = config.endpoint.port.ok_or_else(|| {
            ChainBackendError::Rejected("BCHN RPC endpoint requires a port".into())
        })?;
        if host.is_empty() {
            return Err(ChainBackendError::Rejected(
                "BCHN RPC endpoint host is empty".into(),
            ));
        }
        let scheme = if config.https { "https" } else { "http" };
        let url = Url::parse(&format!("{scheme}://{host}:{port}/"))
            .map_err(|error| ChainBackendError::Rejected(error.to_string()))?;
        let client = rpc_client(config.request_timeout)?;

        let mut backend = Self {
            config,
            client,
            url,
            capabilities: CapabilitySet::default(),
            info: BchnInfo {
                chain: String::new(),
                blocks: 0,
                best_block_hash: [0; 32],
            },
        };
        let info = backend.rpc("getblockchaininfo", json!([])).await?;
        backend.info = parse_blockchain_info(&info)?;
        backend.capabilities.record(
            Capability::RpcQueries,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ActiveProbe,
        );
        backend.capabilities.record(
            Capability::FullNodeValidation,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ActiveProbe,
        );
        for capability in [Capability::Broadcast, Capability::HeaderStream] {
            backend.capabilities.record(
                capability,
                CapabilityConfidence::Advertised,
                CapabilityDiscovery::ExplicitConfiguration,
            );
        }
        // A node added through either interface has no shell-only txindex
        // override. Discover its actual index instead of leaving historical
        // lookup unreachable. Older nodes may not implement getindexinfo.
        let index_probed = if backend.config.txindex {
            false
        } else {
            backend
                .rpc("getindexinfo", json!(["txindex"]))
                .await
                .is_ok_and(|value| {
                    value.get("txindex").is_some_and(|index| {
                        index.get("synced").and_then(Value::as_bool) == Some(true)
                            && index
                                .get("best_block_height")
                                .and_then(Value::as_u64)
                                .is_some_and(|height| height >= u64::from(backend.info.blocks))
                    })
                })
        };
        backend.config.txindex |= index_probed;
        if backend.config.txindex {
            backend.capabilities.record(
                Capability::TransactionQuery,
                CapabilityConfidence::Advertised,
                if index_probed {
                    CapabilityDiscovery::ActiveProbe
                } else {
                    CapabilityDiscovery::ExplicitConfiguration
                },
            );
        }
        // `gettxout` reads the UTXO set and does not need txindex. A null
        // response is still only `Unknown`, never proof that an output spent.
        backend.capabilities.record(
            Capability::OutpointUnspentLookup,
            CapabilityConfidence::Advertised,
            CapabilityDiscovery::ExplicitConfiguration,
        );
        Ok(backend)
    }

    pub fn info(&self) -> &BchnInfo {
        &self.info
    }

    pub async fn raw_call(&self, method: &str, params: Value) -> Result<Value, ChainBackendError> {
        self.rpc(method, params).await
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, ChainBackendError> {
        let body = json!({
            "jsonrpc": "1.0",
            "id": "optn",
            "method": method,
            "params": params,
        });
        let mut request = self.client.post(self.url.clone()).json(&body);
        if let RpcAuth::Basic { username, password } = &self.config.auth {
            request = request.basic_auth(username, Some(password));
        }
        let response = request.send().await.map_err(map_reqwest)?;
        if !response.status().is_success() {
            return Err(ChainBackendError::Protocol(format!(
                "BCHN RPC HTTP status {}",
                response.status()
            )));
        }
        let value = read_rpc_value(response).await?;
        if let Some(error) = value.get("error") {
            if !error.is_null() {
                return Err(ChainBackendError::Protocol(error.to_string()));
            }
        }
        value.get("result").cloned().ok_or_else(|| {
            ChainBackendError::InvalidResponse("BCHN RPC response lacks result".into())
        })
    }

    async fn transaction_lookup(
        &self,
        txid: [u8; 32],
    ) -> Result<BackendObservation, ChainBackendError> {
        if !self.config.txindex {
            return Err(ChainBackendError::Unsupported);
        }
        let raw_hex = self
            .rpc("getrawtransaction", json!([display_hash(txid), false]))
            .await?
            .as_str()
            .ok_or_else(|| {
                ChainBackendError::InvalidResponse("getrawtransaction did not return hex".into())
            })?
            .to_owned();
        let raw = hex::decode(raw_hex).map_err(|error| {
            ChainBackendError::InvalidResponse(format!("invalid transaction hex: {error}"))
        })?;
        if sha256d(&raw) != txid {
            return Err(ChainBackendError::InvalidResponse(
                "BCHN transaction bytes do not match requested txid".into(),
            ));
        }
        Ok(BackendObservation {
            payload: ChainPayload::Transaction(ObservedTransaction {
                txid,
                raw,
                block_height: None,
            }),
            evidence: Evidence::FullNodeValidated {
                source: self.config.source_id.clone(),
            },
            chain_tip: Some((self.info.blocks, self.info.best_block_hash)),
        })
    }

    async fn outpoint_spentness(
        &self,
        txid: [u8; 32],
        vout: u32,
    ) -> Result<BackendObservation, ChainBackendError> {
        let result = self
            .rpc("gettxout", json!([display_hash(txid), vout, true]))
            .await?;
        Ok(BackendObservation {
            payload: ChainPayload::OutpointSpentness(parse_gettxout_result(txid, vout, &result)?),
            evidence: Evidence::FullNodeValidated {
                source: self.config.source_id.clone(),
            },
            // `gettxout.bestblock` has no height. Do not mislabel the tip
            // captured during connect as this response's current chain tip.
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
        let result = self
            .rpc("sendrawtransaction", json!([hex::encode(raw_tx)]))
            .await?;
        let returned = result.as_str().ok_or_else(|| {
            ChainBackendError::InvalidResponse("sendrawtransaction did not return txid".into())
        })?;
        if decode_display_hash(returned)? != txid {
            return Err(ChainBackendError::InvalidResponse(
                "BCHN returned a different transaction id".into(),
            ));
        }
        Ok(BackendObservation {
            payload: ChainPayload::BroadcastObserved { txid },
            evidence: Evidence::FullNodeValidated {
                source: self.config.source_id.clone(),
            },
            chain_tip: Some((self.info.blocks, self.info.best_block_hash)),
        })
    }

    async fn header_sync(
        &self,
        start_height: u32,
        count: u32,
    ) -> Result<BackendObservation, ChainBackendError> {
        let mut headers = Vec::with_capacity(count as usize);
        for height in start_height..start_height.saturating_add(count) {
            if height > self.info.blocks {
                break;
            }
            let block_hash = self.rpc("getblockhash", json!([height])).await?;
            let block_hash = block_hash.as_str().ok_or_else(|| {
                ChainBackendError::InvalidResponse("getblockhash did not return hash".into())
            })?;
            let header_hex = self
                .rpc("getblockheader", json!([block_hash, false]))
                .await?
                .as_str()
                .ok_or_else(|| {
                    ChainBackendError::InvalidResponse("getblockheader did not return hex".into())
                })?
                .to_owned();
            headers.push(parse_header_hex(&header_hex)?);
        }
        Ok(BackendObservation {
            payload: ChainPayload::Headers {
                start_height,
                headers,
            },
            evidence: Evidence::FullNodeValidated {
                source: self.config.source_id.clone(),
            },
            chain_tip: Some((self.info.blocks, self.info.best_block_hash)),
        })
    }
}

fn rpc_client(request_timeout: Duration) -> Result<Client, ChainBackendError> {
    Client::builder()
        .timeout(request_timeout)
        // A configured BCHN endpoint is an exact selected infrastructure
        // destination. Ambient proxy settings must not retarget it, and a
        // redirect must not send RPC credentials or wallet queries elsewhere.
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| ChainBackendError::Protocol(error.to_string()))
}

async fn read_rpc_value(mut response: reqwest::Response) -> Result<Value, ChainBackendError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RPC_RESPONSE_BYTES as u64)
    {
        return Err(rpc_response_too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(map_reqwest)? {
        append_rpc_chunk(&mut body, &chunk)?;
    }
    serde_json::from_slice(&body).map_err(|_| {
        ChainBackendError::InvalidResponse("BCHN RPC response is not valid JSON".into())
    })
}

fn append_rpc_chunk(body: &mut Vec<u8>, chunk: &[u8]) -> Result<(), ChainBackendError> {
    if chunk.len() > MAX_RPC_RESPONSE_BYTES.saturating_sub(body.len()) {
        return Err(rpc_response_too_large());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

fn rpc_response_too_large() -> ChainBackendError {
    ChainBackendError::InvalidResponse(format!(
        "BCHN RPC response exceeds {MAX_RPC_RESPONSE_BYTES} byte limit"
    ))
}

impl ChainBackend for BchnRpcBackend {
    fn source_id(&self) -> &SourceId {
        &self.config.source_id
    }

    fn protocol(&self) -> ProtocolFamily {
        ProtocolFamily::BchnRpc
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
            ChainOperation::TransactionLookup => self.config.txindex,
            ChainOperation::OutpointSpentness => true,
            ChainOperation::Broadcast | ChainOperation::HeaderSync => true,
            ChainOperation::WalletRefresh
            | ChainOperation::OutpointSpender
            | ChainOperation::HistoricalHeaderProof => false,
        }
    }

    fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
        Box::pin(async move {
            match request {
                ChainRequest::CashcodeBlockRange { .. } => Err(ChainBackendError::Unsupported),
                ChainRequest::TransactionLookup { txid } => self.transaction_lookup(*txid).await,
                ChainRequest::OutpointSpentness { txid, vout } => {
                    self.outpoint_spentness(*txid, *vout).await
                }
                ChainRequest::Broadcast { raw_tx, txid } => self.broadcast(raw_tx, *txid).await,
                ChainRequest::HeaderSync {
                    start_height,
                    count,
                } => self.header_sync(*start_height, *count).await,
                ChainRequest::HeaderSyncFromLocator { .. } => Err(ChainBackendError::Unsupported),
                ChainRequest::WalletRefresh { .. }
                | ChainRequest::OutpointSpender { .. }
                | ChainRequest::HistoricalHeaderProof { .. } => Err(ChainBackendError::Unsupported),
            }
        })
    }
}

fn parse_blockchain_info(value: &Value) -> Result<BchnInfo, ChainBackendError> {
    let object = value.as_object().ok_or_else(|| {
        ChainBackendError::InvalidResponse("getblockchaininfo result is not an object".into())
    })?;
    let chain = object
        .get("chain")
        .and_then(Value::as_str)
        .ok_or_else(|| ChainBackendError::InvalidResponse("chain is missing".into()))?
        .to_owned();
    let blocks = object
        .get("blocks")
        .and_then(Value::as_u64)
        .ok_or_else(|| ChainBackendError::InvalidResponse("blocks is missing".into()))?;
    let best = object
        .get("bestblockhash")
        .and_then(Value::as_str)
        .ok_or_else(|| ChainBackendError::InvalidResponse("bestblockhash is missing".into()))?;
    Ok(BchnInfo {
        chain,
        blocks: u32::try_from(blocks)
            .map_err(|_| ChainBackendError::InvalidResponse("block height exceeds u32".into()))?,
        best_block_hash: decode_display_hash(best)?,
    })
}

fn parse_header_hex(value: &str) -> Result<[u8; 80], ChainBackendError> {
    let bytes = hex::decode(value).map_err(|error| {
        ChainBackendError::InvalidResponse(format!("invalid block header hex: {error}"))
    })?;
    bytes.try_into().map_err(|bytes: Vec<u8>| {
        ChainBackendError::InvalidResponse(format!(
            "block header must be 80 bytes, got {}",
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

fn map_reqwest(error: reqwest::Error) -> ChainBackendError {
    if error.is_timeout() {
        ChainBackendError::Timeout
    } else if error.is_connect() {
        ChainBackendError::Offline
    } else {
        ChainBackendError::Protocol(error.to_string())
    }
}

/// Parse the fixed `gettxout` fields that establish an unspent assertion.
/// BCHN does not echo the requested outpoint, so this adapter binds the typed
/// result to its request and `ChainService` verifies that binding.
fn parse_gettxout_result(
    txid: [u8; 32],
    vout: u32,
    value: &Value,
) -> Result<OutpointSpentness, ChainBackendError> {
    if value.is_null() {
        return Ok(OutpointSpentness::Unknown { txid, vout });
    }
    let object = value.as_object().ok_or_else(|| {
        ChainBackendError::InvalidResponse("gettxout result is neither null nor an object".into())
    })?;
    let best_block = object
        .get("bestblock")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ChainBackendError::InvalidResponse("gettxout bestblock is missing".into())
        })?;
    let best_block = decode_display_hash(best_block)?;
    object
        .get("confirmations")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            ChainBackendError::InvalidResponse("gettxout confirmations are missing".into())
        })?;
    let value_sats =
        parse_bch_value_sats(object.get("value").ok_or_else(|| {
            ChainBackendError::InvalidResponse("gettxout value is missing".into())
        })?)?;
    let script = object
        .get("scriptPubKey")
        .and_then(Value::as_object)
        .and_then(|script| script.get("hex"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ChainBackendError::InvalidResponse("gettxout scriptPubKey hex is missing".into())
        })?;
    let script_pubkey = hex::decode(script).map_err(|_| {
        ChainBackendError::InvalidResponse("gettxout scriptPubKey hex is invalid".into())
    })?;
    if !object.get("coinbase").is_some_and(Value::is_boolean) {
        return Err(ChainBackendError::InvalidResponse(
            "gettxout coinbase is missing or not boolean".into(),
        ));
    }
    Ok(OutpointSpentness::Unspent {
        txid,
        vout,
        value_sats,
        script_pubkey,
        best_block,
    })
}

/// Parse BCHN's JSON amount without accepting a binary float approximation.
///
/// BCHN supplies a JSON number, but its lexical form is still security
/// relevant: a negative amount, scientific notation, or more than eight
/// decimal places cannot identify an exact number of satoshis.
fn parse_bch_value_sats(value: &Value) -> Result<u64, ChainBackendError> {
    const SATS_PER_BCH: u64 = 100_000_000;
    const BCH_DECIMALS: usize = 8;

    let raw = value
        .as_number()
        .map(serde_json::Number::as_str)
        .ok_or_else(|| {
            ChainBackendError::InvalidResponse("gettxout value is not a JSON number".into())
        })?;
    let (whole, fraction) = raw.split_once('.').unwrap_or((raw, ""));
    if whole.is_empty()
        || fraction.len() > BCH_DECIMALS
        || fraction.contains('.')
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ChainBackendError::InvalidResponse(
            "gettxout value is not an exact non-negative BCH decimal".into(),
        ));
    }
    let whole_sats = whole
        .parse::<u64>()
        .map_err(|_| ChainBackendError::InvalidResponse("gettxout value is too large".into()))?
        .checked_mul(SATS_PER_BCH)
        .ok_or_else(|| ChainBackendError::InvalidResponse("gettxout value is too large".into()))?;
    let mut fraction_sats = if fraction.is_empty() {
        0
    } else {
        fraction.parse::<u64>().map_err(|_| {
            ChainBackendError::InvalidResponse("gettxout fraction is invalid".into())
        })?
    };
    for _ in fraction.len()..BCH_DECIMALS {
        fraction_sats *= 10;
    }
    whole_sats
        .checked_add(fraction_sats)
        .ok_or_else(|| ChainBackendError::InvalidResponse("gettxout value is too large".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::thread;

    #[test]
    fn blockchain_info_parses_display_hash_to_internal_order() {
        let value = json!({
            "chain": "main",
            "blocks": 900000,
            "bestblockhash": "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
        });
        let info = parse_blockchain_info(&value).unwrap();
        assert_eq!(info.blocks, 900000);
        assert_eq!(info.best_block_hash[0], 0x20);
        assert_eq!(info.best_block_hash[31], 0x01);
    }

    #[test]
    fn rpc_is_not_silently_a_wallet_history_index() {
        let mut capabilities = CapabilitySet::default();
        capabilities.record(
            Capability::RpcQueries,
            CapabilityConfidence::Verified,
            CapabilityDiscovery::ActiveProbe,
        );
        assert!(!capabilities.is_usable(Capability::FastHistory));
        assert!(!capabilities.is_usable(Capability::RpaIndex));
    }

    #[test]
    fn rpc_auth_debug_never_formats_credentials() {
        let auth = RpcAuth::Basic {
            username: "operator@example".into(),
            password: "correct-horse".into(),
        };
        let auth_debug = format!("{auth:?}");
        assert!(!auth_debug.contains("operator@example"));
        assert!(!auth_debug.contains("correct-horse"));
        let config = BchnRpcConfig::new(
            SourceId::new("local"),
            Endpoint {
                kind: EndpointKind::BchnRpc,
                host: "127.0.0.1".into(),
                port: Some(8332),
            },
            auth,
        );
        let config_debug = format!("{config:?}");
        assert!(!config_debug.contains("operator@example"));
        assert!(!config_debug.contains("correct-horse"));
    }

    fn response_server(headers: String, body: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = socket.read(&mut request);
            let mut wire = format!("HTTP/1.1 {headers}\r\nConnection: close\r\n\r\n").into_bytes();
            wire.extend_from_slice(&body);
            socket.write_all(&wire).unwrap();
        });
        format!("http://{address}/")
    }

    fn read_json_request(socket: &mut TcpStream) -> Value {
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 1024];
        let header_end = loop {
            let count = socket.read(&mut chunk).unwrap();
            assert_ne!(count, 0, "HTTP request ended before headers");
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break end + 4;
            }
        };
        let header = std::str::from_utf8(&bytes[..header_end]).unwrap();
        let content_length = header
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then_some(value.trim())
            })
            .unwrap()
            .parse::<usize>()
            .unwrap();
        while bytes.len() < header_end + content_length {
            let count = socket.read(&mut chunk).unwrap();
            assert_ne!(count, 0, "HTTP request ended before body");
            bytes.extend_from_slice(&chunk[..count]);
        }
        serde_json::from_slice(&bytes[header_end..header_end + content_length]).unwrap()
    }

    fn rpc_server(results: Vec<Value>) -> (Endpoint, mpsc::Receiver<Value>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (requests_tx, requests_rx) = mpsc::channel();
        thread::spawn(move || {
            for result in results {
                let (mut socket, _) = listener.accept().unwrap();
                let request = read_json_request(&mut socket);
                requests_tx.send(request).unwrap();
                let body = serde_json::to_vec(&json!({
                    "result": result,
                    "error": null,
                    "id": "optn",
                }))
                .unwrap();
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .unwrap();
                socket.write_all(&body).unwrap();
            }
        });
        (
            Endpoint {
                kind: EndpointKind::BchnRpc,
                host: "127.0.0.1".into(),
                port: Some(address.port()),
            },
            requests_rx,
        )
    }

    fn blockchain_info_result() -> Value {
        json!({
            "chain": "chipnet",
            "blocks": 100,
            "bestblockhash": display_hash([9; 32]),
        })
    }

    fn unspent_gettxout_result() -> Value {
        json!({
            "bestblock": display_hash([9; 32]),
            "confirmations": 1,
            "value": 0.00001,
            "scriptPubKey": {"hex": "51"},
            "coinbase": false,
        })
    }

    #[tokio::test]
    async fn gettxout_unspent_response_is_bound_to_the_requested_outpoint() {
        let (endpoint, requests) = rpc_server(vec![
            blockchain_info_result(),
            json!({"txindex":{"synced":true,"best_block_height":100}}),
            unspent_gettxout_result(),
        ]);
        let source = SourceId::new("owned-bchn");
        let backend =
            BchnRpcBackend::connect(BchnRpcConfig::new(source.clone(), endpoint, RpcAuth::None))
                .await
                .unwrap();
        let txid = [7; 32];
        let observation = backend
            .execute(&ChainRequest::OutpointSpentness { txid, vout: 4 })
            .await
            .unwrap();
        assert_eq!(
            observation.payload,
            ChainPayload::OutpointSpentness(OutpointSpentness::Unspent {
                txid,
                vout: 4,
                value_sats: 1_000,
                script_pubkey: vec![0x51],
                best_block: [9; 32],
            })
        );
        assert_eq!(observation.chain_tip, None);
        let startup = requests.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(startup["method"], "getblockchaininfo");
        let index = requests.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(index["method"], "getindexinfo");
        assert_eq!(index["params"], json!(["txindex"]));
        assert!(backend.supports(ChainOperation::TransactionLookup));
        let lookup = requests.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(lookup["method"], "gettxout");
        assert_eq!(lookup["params"], json!([display_hash(txid), 4, true]));
        assert!(backend
            .capabilities()
            .is_usable(Capability::OutpointUnspentLookup));
    }

    #[tokio::test]
    async fn unavailable_or_unsynced_index_does_not_advertise_historical_lookup() {
        for index in [
            json!({}),
            json!({"txindex":{"synced":false,"best_block_height":100}}),
            json!({"txindex":{"synced":true,"best_block_height":99}}),
            json!({"txindex":{"synced":"true","best_block_height":100}}),
        ] {
            let (endpoint, _requests) = rpc_server(vec![blockchain_info_result(), index]);
            let backend = BchnRpcBackend::connect(BchnRpcConfig::new(
                SourceId::new("local-node"),
                endpoint,
                RpcAuth::None,
            ))
            .await
            .unwrap();
            assert!(!backend.supports(ChainOperation::TransactionLookup));
            assert!(backend.supports(ChainOperation::OutpointSpentness));
        }
    }

    #[test]
    fn gettxout_null_is_unknown_not_spent() {
        assert_eq!(
            parse_gettxout_result([2; 32], 3, &Value::Null),
            Ok(OutpointSpentness::Unknown {
                txid: [2; 32],
                vout: 3,
            })
        );
    }

    #[test]
    fn gettxout_accepts_an_empty_consensus_script() {
        let mut result = unspent_gettxout_result();
        result["scriptPubKey"]["hex"] = Value::String(String::new());
        assert!(matches!(
            parse_gettxout_result([2; 32], 3, &result),
            Ok(OutpointSpentness::Unspent {
                script_pubkey,
                ..
            }) if script_pubkey.is_empty()
        ));
    }

    #[test]
    fn malformed_gettxout_object_is_rejected() {
        assert!(matches!(
            parse_gettxout_result([2; 32], 3, &json!({"bestblock": display_hash([9; 32])})),
            Err(ChainBackendError::InvalidResponse(_))
        ));
    }

    #[test]
    fn gettxout_rejects_non_integral_or_negative_satoshi_values() {
        let valid = unspent_gettxout_result();
        for invalid_value in [
            serde_json::from_str("-0.00001").unwrap(),
            serde_json::from_str("0.000000001").unwrap(),
        ] {
            let mut malformed = valid.clone();
            malformed["value"] = invalid_value;
            assert!(matches!(
                parse_gettxout_result([2; 32], 3, &malformed),
                Err(ChainBackendError::InvalidResponse(_))
            ));
        }
    }

    #[test]
    fn gettxout_amount_preserves_one_satoshi_exactly() {
        let one_sat = serde_json::from_str("0.00000001").unwrap();
        assert_eq!(parse_bch_value_sats(&one_sat), Ok(1));
    }

    #[tokio::test]
    async fn rpc_client_refuses_redirects_to_a_different_listener() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let target_address = target.local_addr().unwrap();
        let (observed_tx, observed_rx) = mpsc::channel();
        thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_millis(250);
            loop {
                match target.accept() {
                    Ok(_) => {
                        observed_tx.send(true).unwrap();
                        return;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() >= deadline {
                            observed_tx.send(false).unwrap();
                            return;
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("capture listener failed: {error}"),
                }
            }
        });
        let source = response_server(
            format!("302 Found\r\nLocation: http://{target_address}/capture\r\nContent-Length: 0"),
            Vec::new(),
        );

        let response = rpc_client(Duration::from_secs(1))
            .unwrap()
            .post(source)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        assert!(!observed_rx.recv_timeout(Duration::from_secs(1)).unwrap());
    }

    #[tokio::test]
    async fn rpc_response_body_is_refused_from_its_announced_size_before_json_decode() {
        let source = response_server(
            format!("200 OK\r\nContent-Length: {}", MAX_RPC_RESPONSE_BYTES + 1),
            Vec::new(),
        );
        let response = rpc_client(Duration::from_secs(1))
            .unwrap()
            .post(source)
            .send()
            .await
            .unwrap();
        assert_eq!(
            read_rpc_value(response).await,
            Err(rpc_response_too_large())
        );
    }

    #[test]
    fn rpc_response_body_cap_is_cumulative_without_content_length() {
        let mut body = vec![0; MAX_RPC_RESPONSE_BYTES];
        assert_eq!(
            append_rpc_chunk(&mut body, &[0]),
            Err(rpc_response_too_large())
        );
        assert_eq!(body.len(), MAX_RPC_RESPONSE_BYTES);
    }
}
