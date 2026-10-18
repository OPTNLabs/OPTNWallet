#![forbid(unsafe_code)]
//! Protocol adapter only. OPTN supplies its wallet and source observations;
//! this crate opens no sockets, selects no coins and holds no signing keys.

use base64::{engine::general_purpose::STANDARD, Engine};
mod prepared;
pub use prepared::{PaymentSources, PreparedWallet};
use serde_json::Value;
use x402_chain_bch::{
    address::CashAddr,
    transaction::{parse_cash_token_nft, payment_target_with_nft},
    v2_bch_exact::{
        client::{BchWallet, V2BchExactWalletClient},
        types::{BchRecipient, BchTransactionNetwork, PaymentRequirements},
    },
    BchChainProvider, BchChainReference, BchPaymentTarget, BchPolicy,
};
use x402_types::{proto::PaymentRequired, scheme::client::X402SchemeClient};

pub use x402_chain_bch;
pub use x402_chain_bch::v2_bch_exact::types::BchTransactionRequest;
pub use x402_types;

pub const PAYMENT_REQUIRED: &str = "PAYMENT-REQUIRED";
pub const PAYMENT_SIGNATURE: &str = "PAYMENT-SIGNATURE";
pub const PAYMENT_RESPONSE: &str = "PAYMENT-RESPONSE";
pub const MAX_REQUIREMENTS_BYTES: usize = 64 * 1024;

/// The selected offer retains the original JSON, including extension fields.
/// Reconstructing `accepted` from only known fields changes the merchant's quote.
pub struct Offer {
    required: PaymentRequired,
    pub request: BchTransactionRequest,
    pub accepted: Value,
    /// Resource and extensions are part of approval, as well as the selected offer.
    pub binding: Value,
}

impl Offer {
    /// A present header is authoritative. Invalid headers never downgrade to a
    /// different body quote. The JSON body fallback accommodates v2 servers.
    pub fn parse(
        header: Option<&str>,
        body: &str,
        network: BchChainReference,
    ) -> Result<Self, String> {
        Self::parse_with_capability(header, body, network, false)
    }

    pub fn parse_native(
        header: Option<&str>,
        body: &str,
        network: BchChainReference,
    ) -> Result<Self, String> {
        Self::parse_with_capability(header, body, network, true)
    }

    fn parse_with_capability(
        header: Option<&str>,
        body: &str,
        network: BchChainReference,
        native_only: bool,
    ) -> Result<Self, String> {
        let bytes = if let Some(header) = header {
            if header.len() > MAX_REQUIREMENTS_BYTES * 4 / 3 + 4 {
                return Err("x402 requirements header is too large".into());
            }
            STANDARD
                .decode(header)
                .map_err(|_| "invalid PAYMENT-REQUIRED base64")?
        } else {
            body.as_bytes().to_vec()
        };
        if bytes.len() > MAX_REQUIREMENTS_BYTES {
            return Err("x402 requirements document is too large".into());
        }
        let mut required: x402_types::proto::v2::PaymentRequired<x402_types::proto::OriginalJson> =
            serde_json::from_slice(&bytes)
                .map_err(|error| format!("invalid x402 requirements: {error}"))?;
        if required.accepts.len() > 64 {
            return Err("too many x402 payment options".into());
        }
        let mut selected = None;
        for original in &required.accepts {
            let Ok(requirements) = PaymentRequirements::try_from(original) else {
                continue;
            };
            if requirements.network != network.chain_id()
                || requirements.extra.payment_flow != "upfront"
            {
                continue;
            }
            let Ok(request) = normalized_request(&requirements, network) else {
                continue;
            };
            if native_only && request.token.is_some() {
                continue;
            }
            selected = Some((original.clone(), request));
            break;
        }
        let (original, request) =
            selected.ok_or("no supported BCH exact offer for this network")?;
        let accepted = serde_json::to_value(&original).map_err(|error| error.to_string())?;
        required.accepts = vec![original];
        let binding = serde_json::json!({"accepted":accepted,"resource":required.resource,"extensions":required.extensions});
        Ok(Self {
            required: PaymentRequired::V2(required),
            request,
            accepted,
            binding,
        })
    }

    /// SDK wallet mode: the SDK asks OPTN for the exact transaction and checks
    /// it against supplied source outputs. It never receives wallet secrets.
    pub async fn payment_header<W, P>(&self, wallet: W, provider: P) -> Result<String, String>
    where
        W: BchWallet + Clone + 'static,
        P: BchChainProvider + Clone + 'static,
    {
        let client = V2BchExactWalletClient::new(wallet, provider);
        let candidate = client
            .accept(&self.required)
            .into_iter()
            .next()
            .ok_or("the SDK refused the selected BCH offer")?;
        candidate
            .signer
            .sign_payment()
            .await
            .map_err(|error| error.to_string())
    }
}

fn normalized_request(
    r: &PaymentRequirements,
    network: BchChainReference,
) -> Result<BchTransactionRequest, String> {
    let method = r.extra.asset_transfer_method.as_str();
    if !matches!((r.asset.as_str(), method), ("BCH", "native"))
        && (r.asset == "BCH" || method != "cashtoken")
    {
        return Err("unsupported BCH asset transfer method".into());
    }
    // A native BCH quote must not smuggle a token into its wallet request.
    if method == "native" && r.extra.token.is_some() {
        return Err("native BCH quote contains token instructions".into());
    }
    let merchant = CashAddr::decode_script(&r.pay_to, network).map_err(|e| e.to_string())?;
    let nft = match &r.extra.token {
        Some(token) => {
            if token.category != r.asset || token.amount != r.amount {
                return Err("token details differ from the quoted asset or amount".into());
            }
            parse_cash_token_nft(
                token.nft.as_ref().map(|n| n.capability.as_str()),
                token.nft.as_ref().map(|n| n.commitment.as_str()),
            )
            .map_err(|e| e.to_string())?
        }
        None => None,
    };
    let target = payment_target_with_nft(
        &r.asset,
        &r.amount,
        method,
        r.extra.token_output_value.as_deref(),
        nft,
        &merchant.locking_script(),
        BchPolicy::default(),
    )
    .map_err(|e| e.to_string())?;
    if method == "cashtoken" && !merchant.token_support {
        return Err("CashTokens require a token-aware merchant address".into());
    }
    let value = match target {
        BchPaymentTarget::Native { merchant_value, .. }
        | BchPaymentTarget::CashToken { merchant_value, .. } => merchant_value,
    };
    let token =
        (method == "cashtoken").then(|| x402_chain_bch::v2_bch_exact::types::BchTokenRequest {
            category: r.asset.clone(),
            amount: r.amount.clone(),
            nft: r.extra.token.as_ref().and_then(|token| token.nft.clone()),
        });
    Ok(BchTransactionRequest {
        network: match network {
            BchChainReference::Mainnet => BchTransactionNetwork::Mainnet,
            BchChainReference::Chipnet => BchTransactionNetwork::Chipnet,
        },
        recipient: BchRecipient {
            address: r.pay_to.clone(),
        },
        value: value.to_string(),
        token,
    })
}

/// A server receipt is a settlement claim, never independent chain proof.
pub fn settlement_receipt(
    header: &str,
    txid: &str,
    network: BchChainReference,
) -> Result<Value, String> {
    if header.len() > MAX_REQUIREMENTS_BYTES {
        return Err("settlement receipt is too large".into());
    }
    let bytes = STANDARD
        .decode(header)
        .map_err(|_| "invalid PAYMENT-RESPONSE base64")?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "invalid settlement receipt JSON")?;
    let receipt: x402_types::proto::v2::SettleResponse =
        serde_json::from_value(value.clone()).map_err(|_| "invalid settlement receipt")?;
    match receipt {
        x402_types::proto::v2::SettleResponse::Success {
            transaction,
            network: chain,
            ..
        } if transaction.eq_ignore_ascii_case(txid) && chain == network.chain_id().to_string() => {
            Ok(value)
        }
        _ => Err("settlement receipt does not confirm this transaction and network".into()),
    }
}

#[cfg(test)]
mod tests;
