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
    ChainRequest, ObservedTransaction,
};
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcAuth {
    None,
    Basic { username: String, password: String },
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
        let client = Client::builder()
            .timeout(config.request_timeout)
            .build()
            .map_err(|error| ChainBackendError::Protocol(error.to_string()))?;

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
        if backend.config.txindex {
            backend.capabilities.record(
                Capability::TransactionQuery,
                CapabilityConfidence::Advertised,
                CapabilityDiscovery::ExplicitConfiguration,
            );
        }
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
        let value: Value = response.json().await.map_err(map_reqwest)?;
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
            ChainOperation::Broadcast | ChainOperation::HeaderSync => true,
            ChainOperation::WalletRefresh | ChainOperation::HistoricalHeaderProof => false,
        }
    }

    fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
        Box::pin(async move {
            match request {
                ChainRequest::TransactionLookup { txid } => self.transaction_lookup(*txid).await,
                ChainRequest::Broadcast { raw_tx, txid } => self.broadcast(raw_tx, *txid).await,
                ChainRequest::HeaderSync {
                    start_height,
                    count,
                } => self.header_sync(*start_height, *count).await,
                ChainRequest::WalletRefresh { .. } | ChainRequest::HistoricalHeaderProof { .. } => {
                    Err(ChainBackendError::Unsupported)
                }
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
