//! Public signing envelopes; these requests never carry wallet secrets or broadcast authority.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum AirgapRequest {
    Prepare {
        destination: String,
        amount_sats: u64,
        #[serde(default)]
        coin: Option<String>,
    },
    Finalize {
        request_id: u64,
        signed_psbt_hex: String,
    },
    Cancel,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AirgapResponse {
    pub request_id: u64,
    pub psbt_hex: String,
    pub fee_sats: u64,
    pub change_address: Option<String>,
    pub change_sats: u64,
    pub raw_transaction_hex: Option<String>,
    pub txid: Option<String>,
}
