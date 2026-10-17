//! Immutable payment bytes and source outputs supplied by OPTN's runtime.
use crate::BchTransactionRequest;
use async_trait::async_trait;
use std::{collections::HashMap, sync::Arc};
use x402_chain_bch::{
    address::CashAddr, v2_bch_exact::client::BchWallet, BchChainProvider, BchChainReference,
    BchOutpointStatus, BchProviderError, BchTransaction, BchTransactionStatus, BchUtxo, OutPoint,
    SourceOutput, TxId,
};
use x402_types::chain::{ChainId, ChainProviderOps};

#[derive(Clone)]
pub struct PreparedWallet {
    request: BchTransactionRequest,
    raw: Arc<Vec<u8>>,
}
impl PreparedWallet {
    pub fn new(request: BchTransactionRequest, raw: Vec<u8>) -> Result<Self, String> {
        if raw.is_empty() || raw.len() > 100_000 {
            return Err("payment transaction is too large or empty".into());
        }
        BchTransaction::parse(&raw).map_err(|e| e.to_string())?;
        Ok(Self {
            request,
            raw: Arc::new(raw),
        })
    }
}
#[async_trait]
impl BchWallet for PreparedWallet {
    async fn create_payment(&self, request: BchTransactionRequest) -> Result<Vec<u8>, String> {
        if request != self.request {
            return Err("SDK request differs from the wallet-approved payment".into());
        }
        Ok(self.raw.as_ref().clone())
    }
}

/// Source bytes have already passed OPTN's selected-route reconciliation (or
/// authenticated checkpoint restore for a retry). No hidden SDK Fulcrum client.
#[derive(Clone)]
pub struct PaymentSources {
    network: BchChainReference,
    outputs: Arc<HashMap<OutPoint, SourceOutput>>,
}
impl PaymentSources {
    pub fn new(network: BchChainReference, parents: &[Vec<u8>]) -> Result<Self, String> {
        if parents.len() > 1_000 || parents.iter().map(Vec::len).sum::<usize>() > 8 * 1024 * 1024 {
            return Err("payment sources exceed their bound".into());
        }
        let mut outputs = HashMap::new();
        for raw in parents {
            if raw.len() > 100_000 {
                return Err("source transaction is too large".into());
            }
            let parent = BchTransaction::parse(raw).map_err(|e| e.to_string())?;
            let txid = parent.txid();
            for (index, output) in parent.outputs.into_iter().enumerate() {
                outputs.insert(
                    OutPoint {
                        txid,
                        vout: index as u32,
                    },
                    SourceOutput {
                        value: output.value,
                        script_pubkey: output.script_pubkey,
                        token: output.token,
                    },
                );
            }
        }
        Ok(Self {
            network,
            outputs: Arc::new(outputs),
        })
    }
}
impl ChainProviderOps for PaymentSources {
    fn signer_addresses(&self) -> Vec<String> {
        Vec::new()
    }
    fn chain_id(&self) -> ChainId {
        self.network.chain_id()
    }
}
fn unavailable() -> BchProviderError {
    BchProviderError::Transport(
        "OPTN source snapshot is not a network or settlement provider".into(),
    )
}
#[async_trait]
impl BchChainProvider for PaymentSources {
    async fn source_output(&self, outpoint: &OutPoint) -> Result<SourceOutput, BchProviderError> {
        self.outputs
            .get(outpoint)
            .cloned()
            .ok_or(BchProviderError::NotFound)
    }
    async fn outpoint_status(
        &self,
        _: &OutPoint,
        _: &SourceOutput,
    ) -> Result<BchOutpointStatus, BchProviderError> {
        Ok(BchOutpointStatus::Unknown)
    }
    async fn list_utxos(&self, _: &CashAddr) -> Result<Vec<BchUtxo>, BchProviderError> {
        Err(unavailable())
    }
    async fn broadcast(&self, _: &[u8]) -> Result<TxId, BchProviderError> {
        Err(unavailable())
    }
    async fn transaction_status(&self, _: &TxId) -> Result<BchTransactionStatus, BchProviderError> {
        Ok(BchTransactionStatus::Unknown)
    }
    async fn tip_height(&self) -> Result<u64, BchProviderError> {
        Err(unavailable())
    }
    async fn has_double_spend_proof(&self, _: &TxId) -> Result<bool, BchProviderError> {
        Err(unavailable())
    }
}
