//! Flipstarter assurance-campaign pledges.
//!
//! This is the wallet-side workflow for public Flipstarter campaigns,
//! including self-hosted sites. It is not FundMe / CashStarter.
//!
//! Campaign sites hand the pledger a JSON object encoded as UTF-16LE then
//! base64 ("COPY DETAILS"). The wallet:
//! 1. decodes that blob
//! 2. requires a spendable coin of exactly `donation.amount`
//! 3. freezes that coin as [`FreezeReason::FlipstarterPledge`]
//! 4. signs the assurance input with SIGHASH_ALL|FORKID|ANYONECANPAY (`0xC1`)
//!
//! Cancel unfreezes the coin and records that it must be spent to self so the
//! campaign can no longer collect it. Signing itself lives in the runtime;
//! this module owns decode, freeze, and cancel policy.
//!
//! Reference: https://flipstarter.cash/how-to-pledge

use crate::cashaddr::Address;
use crate::coins::{Coin, CoinError, CoinSet, FreezeReason, Outpoint};
use crate::network::Network;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Deserialize;
use std::fmt;

/// SIGHASH_ALL (0x01) | SIGHASH_FORKID (0x40) | SIGHASH_ANYONECANPAY (0x80).
/// The Flipstarter assurance input commits to all campaign outputs and only
/// the pledger's own input.
pub const PLEDGE_SIGHASH: u8 = 0xC1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CampaignOutput {
    pub value_sats: u64,
    pub address: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Campaign {
    pub outputs: Vec<CampaignOutput>,
    pub donation_sats: u64,
    pub alias: Option<String>,
    pub comment: Option<String>,
    pub expires: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PledgeStatus {
    Frozen,
    /// Unfrozen; the coin must be spent to self before the campaign can use it.
    Cancelled {
        spend_to_self: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlipstarterPledge {
    pub id: u32,
    pub outpoint: Outpoint,
    pub amount_sats: u64,
    pub alias: Option<String>,
    pub comment: Option<String>,
    pub campaign_expires: Option<u64>,
    pub outputs: Vec<CampaignOutput>,
    pub status: PledgeStatus,
}

#[derive(Debug, Deserialize)]
struct RawCampaign {
    outputs: Vec<RawOutput>,
    #[serde(default)]
    data: RawData,
    donation: RawDonation,
    #[serde(default)]
    expires: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct RawOutput {
    value: u64,
    address: String,
}

#[derive(Debug, Deserialize, Default)]
struct RawData {
    #[serde(default)]
    alias: Option<String>,
    #[serde(default)]
    comment: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawDonation {
    amount: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlipstarterError {
    EmptyBlob,
    InvalidBase64,
    InvalidUtf16,
    InvalidJson(String),
    MissingOutputs,
    ZeroDonation,
    ZeroOutput,
    NetworkMismatch { address: String, expected: Network },
    InvalidAddress(String),
    Expired,
    NoExactCoin { amount_sats: u64 },
    Coin(CoinError),
    UnknownPledge,
    PledgeNotFrozen,
}

impl fmt::Display for FlipstarterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyBlob => write!(f, "paste the Flipstarter campaign details first"),
            Self::InvalidBase64 => write!(f, "campaign details are not valid base64"),
            Self::InvalidUtf16 => {
                write!(f, "campaign details are not UTF-16LE JSON")
            }
            Self::InvalidJson(message) => write!(f, "campaign JSON is invalid: {message}"),
            Self::MissingOutputs => write!(f, "campaign has no outputs"),
            Self::ZeroDonation => write!(f, "pledge amount must be greater than zero"),
            Self::ZeroOutput => write!(f, "campaign output value must be greater than zero"),
            Self::NetworkMismatch { address, expected } => {
                write!(f, "campaign address {address} is not a {expected} address")
            }
            Self::InvalidAddress(address) => write!(f, "invalid campaign address {address}"),
            Self::Expired => write!(f, "this campaign has expired"),
            Self::NoExactCoin { amount_sats } => write!(
                f,
                "need a spendable coin of exactly {amount_sats} sats (create a self-send first)"
            ),
            Self::Coin(error) => write!(f, "{error}"),
            Self::UnknownPledge => write!(f, "unknown Flipstarter pledge"),
            Self::PledgeNotFrozen => write!(f, "that pledge is not frozen"),
        }
    }
}

impl std::error::Error for FlipstarterError {}

impl From<CoinError> for FlipstarterError {
    fn from(value: CoinError) -> Self {
        Self::Coin(value)
    }
}

/// Encode JSON campaign details the way Flipstarter campaign sites do:
/// UTF-16LE code units, then standard base64.
pub fn encode_campaign_blob(json: &str) -> String {
    let mut utf16le = Vec::with_capacity(json.len() * 2);
    for unit in json.encode_utf16() {
        utf16le.extend_from_slice(&unit.to_le_bytes());
    }
    BASE64.encode(utf16le)
}

/// Decode a Flipstarter "COPY DETAILS" blob and check every recipient address
/// against `network`. Tests must construct Chipnet JSON and run it through
/// [`encode_campaign_blob`]; do not paste mainnet campaign blobs into tests.
pub fn decode_campaign_blob(blob: &str, network: Network) -> Result<Campaign, FlipstarterError> {
    let trimmed = blob.trim();
    if trimmed.is_empty() {
        return Err(FlipstarterError::EmptyBlob);
    }

    let bytes = BASE64
        .decode(trimmed.as_bytes())
        .map_err(|_| FlipstarterError::InvalidBase64)?;
    let json = utf16le_to_string(&bytes)?;
    let raw: RawCampaign = serde_json::from_str(&json)
        .map_err(|error| FlipstarterError::InvalidJson(error.to_string()))?;

    if raw.outputs.is_empty() {
        return Err(FlipstarterError::MissingOutputs);
    }
    if raw.donation.amount == 0 {
        return Err(FlipstarterError::ZeroDonation);
    }

    let expected_prefix = network.prefix();
    let mut outputs = Vec::with_capacity(raw.outputs.len());
    for output in raw.outputs {
        if output.value == 0 {
            return Err(FlipstarterError::ZeroOutput);
        }
        let address = Address::decode(&output.address)
            .map_err(|_| FlipstarterError::InvalidAddress(output.address.clone()))?;
        if address.prefix != expected_prefix {
            return Err(FlipstarterError::NetworkMismatch {
                address: output.address,
                expected: network,
            });
        }
        outputs.push(CampaignOutput {
            value_sats: output.value,
            address: address.encode(),
        });
    }

    Ok(Campaign {
        outputs,
        donation_sats: raw.donation.amount,
        alias: nonempty(raw.data.alias),
        comment: nonempty(raw.data.comment),
        expires: raw.expires,
    })
}

/// Freeze an exact-amount spendable coin as a Flipstarter pledge.
///
/// `now_unix` is seconds since epoch when the caller wants expiry checked.
/// Pass `None` to skip the clock (the UI should pass a clock).
pub fn prepare_pledge(
    coins: &mut CoinSet,
    pledges: &mut Vec<FlipstarterPledge>,
    network: Network,
    blob: &str,
    now_unix: Option<u64>,
) -> Result<u32, FlipstarterError> {
    let campaign = decode_campaign_blob(blob, network)?;
    if let (Some(expires), Some(now)) = (campaign.expires, now_unix) {
        if expires <= now {
            return Err(FlipstarterError::Expired);
        }
    }

    let coin = coins.find_exact_spendable(campaign.donation_sats).ok_or(
        FlipstarterError::NoExactCoin {
            amount_sats: campaign.donation_sats,
        },
    )?;
    let outpoint = coin.outpoint();
    coins.freeze(outpoint, FreezeReason::FlipstarterPledge)?;

    let id = pledges.iter().map(|pledge| pledge.id).max().unwrap_or(0) + 1;
    pledges.push(FlipstarterPledge {
        id,
        outpoint,
        amount_sats: campaign.donation_sats,
        alias: campaign.alias,
        comment: campaign.comment,
        campaign_expires: campaign.expires,
        outputs: campaign.outputs,
        status: PledgeStatus::Frozen,
    });
    Ok(id)
}

/// Unfreeze the pledged coin and record that it must be spent to self.
pub fn cancel_pledge(
    coins: &mut CoinSet,
    pledges: &mut [FlipstarterPledge],
    pledge_id: u32,
) -> Result<Outpoint, FlipstarterError> {
    let pledge = pledges
        .iter_mut()
        .find(|pledge| pledge.id == pledge_id)
        .ok_or(FlipstarterError::UnknownPledge)?;
    if !matches!(pledge.status, PledgeStatus::Frozen) {
        return Err(FlipstarterError::PledgeNotFrozen);
    }
    coins.unfreeze(pledge.outpoint)?;
    pledge.status = PledgeStatus::Cancelled {
        spend_to_self: true,
    };
    Ok(pledge.outpoint)
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    })
}

fn utf16le_to_string(bytes: &[u8]) -> Result<String, FlipstarterError> {
    let mut data = bytes;
    if data.len() >= 2 && data[0] == 0xff && data[1] == 0xfe {
        data = &data[2..];
    }
    if !data.len().is_multiple_of(2) {
        return Err(FlipstarterError::InvalidUtf16);
    }
    let units: Vec<u16> = data
        .as_chunks::<2>()
        .0
        .iter()
        .map(|chunk| u16::from_le_bytes(*chunk))
        .collect();
    String::from_utf16(&units).map_err(|_| FlipstarterError::InvalidUtf16)
}

/// Chipnet campaign blob for tests and the tools demo. Recipients are Chipnet
/// P2PKH; never a mainnet address.
pub fn sample_chipnet_campaign_blob(donation_sats: u64) -> String {
    let address = Address::from_hash(
        Network::Chipnet.prefix(),
        crate::cashaddr::AddressKind::P2pkh,
        [0x42; 20],
    )
    .encode();
    encode_campaign_blob(&format!(
        r#"{{"outputs":[{{"value":500000,"address":"{address}"}}],"data":{{"alias":"Ada","comment":"chipnet demo"}},"donation":{{"amount":{donation_sats}}},"expires":4102444800}}"#
    ))
}

/// Chipnet helper used by tests and the Leptos tools demo. Not a chain sync.
pub fn chipnet_demo_coin(value_sats: u64, slot: u8) -> Result<Coin, CoinError> {
    let mut txid = [0u8; 32];
    txid[0] = 0x0c;
    txid[1] = 0x11;
    txid[31] = slot;
    let hash = [slot.saturating_add(0x21); 20];
    let address = Address::from_hash(
        Network::Chipnet.prefix(),
        crate::cashaddr::AddressKind::P2pkh,
        hash,
    )
    .encode();
    let coin = Coin::new(Outpoint::new(txid, 0), value_sats, address)?
        .with_label(format!("chipnet-demo-{slot}"));
    Ok(coin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cashaddr::AddressKind;

    fn chipnet_address() -> String {
        Address::from_hash(Network::Chipnet.prefix(), AddressKind::P2pkh, [0x42; 20]).encode()
    }

    fn campaign_json(donation: u64, address: &str) -> String {
        format!(
            r#"{{"outputs":[{{"value":500000,"address":"{address}"}}],"data":{{"alias":"Ada","comment":"ship it"}},"donation":{{"amount":{donation}}},"expires":4102444800}}"#
        )
    }

    #[test]
    fn chipnet_blob_round_trips_through_the_shipped_encoder() {
        let address = chipnet_address();
        let blob = encode_campaign_blob(&campaign_json(12_345, &address));
        let campaign = decode_campaign_blob(&blob, Network::Chipnet).expect("decode");
        assert_eq!(campaign.donation_sats, 12_345);
        assert_eq!(campaign.alias.as_deref(), Some("Ada"));
        assert_eq!(campaign.comment.as_deref(), Some("ship it"));
        assert_eq!(campaign.outputs[0].address, address);
        assert_eq!(PLEDGE_SIGHASH, 0xC1);
    }

    #[test]
    fn mainnet_campaign_is_rejected_on_chipnet() {
        let mainnet = Address::from_hash("bitcoincash", AddressKind::P2pkh, [0x11; 20]).encode();
        let blob = encode_campaign_blob(&campaign_json(1_000, &mainnet));
        match decode_campaign_blob(&blob, Network::Chipnet) {
            Err(FlipstarterError::NetworkMismatch { expected, .. }) => {
                assert_eq!(expected, Network::Chipnet);
            }
            other => panic!("expected network mismatch, got {other:?}"),
        }
    }

    #[test]
    fn prepare_freezes_exact_coin_and_cancel_requires_spend_to_self() {
        let address = chipnet_address();
        let blob = encode_campaign_blob(&campaign_json(8_000, &address));
        let mut coins = CoinSet::new();
        let exact = chipnet_demo_coin(8_000, 1).expect("exact");
        let other = chipnet_demo_coin(9_000, 2).expect("other");
        let exact_out = exact.outpoint();
        coins.insert(exact).expect("insert exact");
        coins.insert(other).expect("insert other");

        let mut pledges = Vec::new();
        let id = prepare_pledge(
            &mut coins,
            &mut pledges,
            Network::Chipnet,
            &blob,
            Some(1_700_000_000),
        )
        .expect("prepare");

        assert_eq!(coins.reserved_sats(), 8_000);
        assert_eq!(coins.spendable_sats(), 9_000);
        assert_eq!(
            coins.get(exact_out).and_then(Coin::freeze),
            Some(FreezeReason::FlipstarterPledge)
        );
        assert!(matches!(pledges[0].status, PledgeStatus::Frozen));
        assert_eq!(pledges[0].id, id);

        let cancelled = cancel_pledge(&mut coins, &mut pledges, id).expect("cancel");
        assert_eq!(cancelled, exact_out);
        assert!(coins.get(exact_out).is_some_and(Coin::is_spendable));
        assert_eq!(
            pledges[0].status,
            PledgeStatus::Cancelled {
                spend_to_self: true
            }
        );
    }

    #[test]
    fn frozen_user_coin_is_not_selected_for_a_pledge() {
        let address = chipnet_address();
        let blob = encode_campaign_blob(&campaign_json(3_000, &address));
        let mut coins = CoinSet::new();
        let coin = chipnet_demo_coin(3_000, 7).expect("coin");
        let outpoint = coin.outpoint();
        coins.insert(coin).expect("insert");
        coins
            .freeze(outpoint, FreezeReason::User)
            .expect("user freeze");

        let mut pledges = Vec::new();
        assert_eq!(
            prepare_pledge(&mut coins, &mut pledges, Network::Chipnet, &blob, None),
            Err(FlipstarterError::NoExactCoin { amount_sats: 3_000 })
        );
        assert!(pledges.is_empty());
    }

    #[test]
    fn expired_campaign_is_rejected_when_a_clock_is_supplied() {
        let address = chipnet_address();
        let json = format!(
            r#"{{"outputs":[{{"value":1,"address":"{address}"}}],"donation":{{"amount":1000}},"expires":10}}"#
        );
        let blob = encode_campaign_blob(&json);
        let mut coins = CoinSet::new();
        coins
            .insert(chipnet_demo_coin(1_000, 4).expect("coin"))
            .expect("insert");
        let mut pledges = Vec::new();
        assert_eq!(
            prepare_pledge(&mut coins, &mut pledges, Network::Chipnet, &blob, Some(11)),
            Err(FlipstarterError::Expired)
        );
    }
}
