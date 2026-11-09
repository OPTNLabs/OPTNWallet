//! Round messages: the JSON inside each NIP-59 gift wrap.
//!
//! Field names, the `type` tag and every bound match the TypeScript
//! `RoundMessage` and `parseRoundMessage` (`nostr/fusionSession.ts`). The parser
//! is as strict as that one: a message it would drop, this drops too.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::blame::{self, BlameCode, BlameEvidence};
use super::credentials::{
    CREDENTIAL_SLOTS_PER_PEER, MAX_INPUT_CREDENTIALS_PER_PEER, MAX_OUTPUT_CREDENTIALS_PER_PEER,
};
use super::{is_compressed_pubkey_hex, is_hex_len, is_uncompressed_point_hex, MAX_MONEY};

/// `ROUND_MSG_VERSION`. Version 4 binds credentials to Electron Cash
/// components; earlier versions are refused, not downgraded.
pub const ROUND_MSG_VERSION: u64 = 4;
/// Longest decrypted message accepted, in UTF-16 code units as JavaScript
/// counts `content.length`.
pub const MAX_ROUND_MESSAGE_CHARS: usize = 64 * 1024;
/// Most participants a message may name.
pub const MAX_WIRE_PARTICIPANTS: usize = 20;
/// Most components one message may carry.
pub const MAX_COMPONENTS: usize = 120;
pub const MAX_SCRIPT_HEX_CHARS: usize = 20_000;
pub const MAX_TX_HEX_CHARS: usize = 200_000;
/// Oldest message accepted, by its own timestamp.
pub const MAX_MESSAGE_AGE_SECONDS: i64 = 300;
/// How far ahead a sender's clock may run.
pub const MAX_CLOCK_SKEW_SECONDS: i64 = 30;
/// Longest abort reason.
pub const MAX_ABORT_REASON_CHARS: usize = 240;
/// Smallest tier a round may name.
pub const MIN_TIER: u64 = 10_000;
/// Smallest output value (`validOutput`).
pub const MIN_OUTPUT_VALUE: u64 = 546;

/// The network a round runs on. Only these two exist on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PoolNetwork {
    Mainnet,
    Chipnet,
}

impl PoolNetwork {
    pub fn as_str(self) -> &'static str {
        match self {
            PoolNetwork::Mainnet => "mainnet",
            PoolNetwork::Chipnet => "chipnet",
        }
    }
}

/// An input a peer contributes (`FusionInputRef`). The txid is in display
/// order. Strings are kept exactly as sent: the canonical order sorts them as
/// strings, so normalising case here would sort differently from a
/// TypeScript peer.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRef {
    pub prev_txid: String,
    pub prev_index: u32,
    pub value: u64,
    pub pubkey: String,
}

impl InputRef {
    /// `${prevTxid}:${prevIndex}`, the key every outpoint check uses.
    pub fn key(&self) -> String {
        outpoint_key(&self.prev_txid, self.prev_index)
    }
}

/// `${prevTxid}:${prevIndex}`.
pub fn outpoint_key(prev_txid: &str, prev_index: u32) -> String {
    format!("{prev_txid}:{prev_index}")
}

/// An output a peer contributes (`FusionOutputRef`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputRef {
    pub script: String,
    pub value: u64,
}

/// An output with its unlinkable credential, as the last peeler reveals it
/// (`AuthorizedOnionOutput`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedOutput {
    pub script: String,
    pub value: u64,
    pub credential_serial: String,
    pub credential_sig: String,
    pub salt_commitment: String,
}

impl AuthorizedOutput {
    pub fn output(&self) -> OutputRef {
        OutputRef {
            script: self.script.clone(),
            value: self.value,
        }
    }
}

/// One input's finished scriptSig (`InputSig`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputSig {
    pub prev_txid: String,
    pub prev_index: u32,
    pub unlocking_bytecode: String,
}

impl InputSig {
    pub fn key(&self) -> String {
        outpoint_key(&self.prev_txid, self.prev_index)
    }
}

/// A blinded challenge bound to one nonce slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotRequest {
    pub index: u32,
    pub e: String,
}

/// The issuer's scalar for one slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotResponse {
    pub index: u32,
    pub s: String,
}

/// Electron Cash's InitialCommitment for one component.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentCommitment {
    pub index: u32,
    pub salted_component_hash: String,
    pub amount_commitment: String,
}

/// What a message says, by its `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Body {
    #[serde(rename_all = "camelCase")]
    RoundProposal {
        network: PoolNetwork,
        tier: u64,
        epoch: u64,
        participants: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    RoundAck {
        network: PoolNetwork,
        tier: u64,
        epoch: u64,
    },
    #[serde(rename_all = "camelCase")]
    RoundShrink {
        network: PoolNetwork,
        tier: u64,
        epoch: u64,
        remaining: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    RoundStart {
        network: PoolNetwork,
        tier: u64,
        epoch: u64,
        participants: Vec<String>,
    },
    Abort {
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    CredentialParams {
        round_pubkey: String,
        blind_nonce_points: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    CredentialRequest {
        requests: Vec<SlotRequest>,
        amount_commitments: Vec<String>,
        component_commitments: Vec<ComponentCommitment>,
        pedersen_total_nonce: String,
        excess_fee: u64,
        input_count: u32,
        output_count: u32,
    },
    CredentialResponse {
        responses: Vec<SlotResponse>,
    },
    #[serde(rename_all = "camelCase")]
    Inputs {
        inputs: Vec<InputRef>,
        credential_sigs: Vec<String>,
        salt_commitments: Vec<String>,
    },
    Outputs {
        outputs: Vec<AuthorizedOutput>,
    },
    #[serde(rename_all = "camelCase")]
    OnionOutput {
        onion: String,
        mix_order: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    OnionDeclare {
        output_count: u32,
    },
    ComponentsReady {},
    Assembled {
        inputs: Vec<InputRef>,
        outputs: Vec<OutputRef>,
    },
    Signature {
        sigs: Vec<InputSig>,
    },
    #[serde(rename_all = "camelCase")]
    Final {
        txid: String,
        tx_hex: String,
    },
    Blame {
        accused: String,
        code: BlameCode,
        evidence: Box<BlameEvidence>,
    },
    /// Legacy post-abort opening. Parsed so an old peer cannot crash a round,
    /// then dropped; this implementation never sends it.
    ComponentDisclosure {},
}

impl Body {
    /// The wire `type`.
    pub fn kind(&self) -> &'static str {
        match self {
            Body::RoundProposal { .. } => "round_proposal",
            Body::RoundAck { .. } => "round_ack",
            Body::RoundShrink { .. } => "round_shrink",
            Body::RoundStart { .. } => "round_start",
            Body::Abort { .. } => "abort",
            Body::CredentialParams { .. } => "credential_params",
            Body::CredentialRequest { .. } => "credential_request",
            Body::CredentialResponse { .. } => "credential_response",
            Body::Inputs { .. } => "inputs",
            Body::Outputs { .. } => "outputs",
            Body::OnionOutput { .. } => "onion_output",
            Body::OnionDeclare { .. } => "onion_declare",
            Body::ComponentsReady {} => "components_ready",
            Body::Assembled { .. } => "assembled",
            Body::Signature { .. } => "signature",
            Body::Final { .. } => "final",
            Body::Blame { .. } => "blame",
            Body::ComponentDisclosure {} => "component_disclosure",
        }
    }

    /// Transaction components travel under a throwaway key on a one-shot
    /// connection, so the coordinator cannot take the sender as their owner
    /// (`fusionTransport.ts` `isAnonymousOutput`). Everything else is the
    /// attributed control plane.
    pub fn is_anonymous(&self) -> bool {
        matches!(
            self,
            Body::Inputs { .. }
                | Body::Outputs { .. }
                | Body::OnionOutput { .. }
                | Body::Signature { .. }
        )
    }
}

/// A round message with its binding: the protocol version, a one-time nonce
/// and the sender's timestamp, against replay across and within rounds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoundMessage {
    pub version: u64,
    pub nonce: String,
    pub timestamp: u64,
    pub session: String,
    #[serde(flatten)]
    pub body: Body,
}

impl RoundMessage {
    /// A fresh message: version 4, a random 16-byte nonce, `now` as the
    /// timestamp (`messageBinding`).
    pub fn new(session: &str, body: Body, now_unix: u64) -> Self {
        Self {
            version: ROUND_MSG_VERSION,
            nonce: super::hex(&super::random_bytes::<16>()),
            timestamp: now_unix,
            session: session.to_owned(),
            body,
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("round messages always serialize")
    }
}

// ── The strict parser ──────────────────────────────────────────────────────

/// Parse and bound one decrypted relay message before any session code sees
/// it (`parseRoundMessage`). `None` for anything the TypeScript would drop.
pub fn parse_round_message(content: &str, now_unix: u64) -> Option<RoundMessage> {
    let length = content.encode_utf16().count();
    if length == 0 || length > MAX_ROUND_MESSAGE_CHARS {
        return None;
    }
    let value: Value = serde_json::from_str(content).ok()?;
    let object = value.as_object()?;
    if !valid_session(object.get("session")) || !valid_binding(object, now_unix) {
        return None;
    }
    let kind = object.get("type")?.as_str()?;
    let shaped = match kind {
        "round_proposal" | "round_start" => {
            valid_network(object)
                && int_in(object.get("tier"), MIN_TIER, MAX_MONEY)
                && int_in(object.get("epoch"), 0, MAX_SAFE_INTEGER)
                && valid_participants(object.get("participants"))
        }
        "round_ack" => {
            valid_network(object)
                && int_in(object.get("tier"), MIN_TIER, MAX_MONEY)
                && int_in(object.get("epoch"), 0, MAX_SAFE_INTEGER)
        }
        "round_shrink" => {
            valid_network(object)
                && int_in(object.get("tier"), MIN_TIER, MAX_MONEY)
                && int_in(object.get("epoch"), 0, MAX_SAFE_INTEGER)
                && valid_participants(object.get("remaining"))
        }
        "abort" => object
            .get("reason")
            .and_then(Value::as_str)
            .map(|reason| (1..=MAX_ABORT_REASON_CHARS).contains(&reason.encode_utf16().count()))
            .unwrap_or(false),
        "blame" => {
            let accused_ok = object
                .get("accused")
                .and_then(Value::as_str)
                .map(|accused| is_hex_len(accused, 64) || is_compressed_pubkey_hex(accused))
                .unwrap_or(false);
            let code = object
                .get("code")
                .and_then(|code| serde_json::from_value::<BlameCode>(code.clone()).ok());
            match (accused_ok, code) {
                (true, Some(code)) => blame::parse_evidence(code, object.get("evidence")).is_some(),
                _ => false,
            }
        }
        "component_disclosure" => valid_disclosure(object),
        "components_ready" => true,
        "credential_params" => {
            str_field(object, "roundPubkey").is_some_and(is_compressed_pubkey_hex)
                && object
                    .get("blindNoncePoints")
                    .and_then(Value::as_array)
                    .is_some_and(|points| {
                        (2..=1024).contains(&points.len())
                            && points
                                .iter()
                                .all(|point| point.as_str().is_some_and(is_compressed_pubkey_hex))
                    })
        }
        "credential_request" => valid_credential_request(object),
        "credential_response" => object
            .get("responses")
            .and_then(Value::as_array)
            .is_some_and(|responses| {
                (1..=MAX_COMPONENTS).contains(&responses.len())
                    && responses.iter().all(|slot| valid_slot(slot, "s"))
            }),
        "inputs" => {
            let inputs = valid_array(object.get("inputs"), valid_input)?;
            let parallel = |field: &str, len: usize| {
                object
                    .get(field)
                    .and_then(Value::as_array)
                    .is_some_and(|items| {
                        items.len() == inputs
                            && items
                                .iter()
                                .all(|item| item.as_str().is_some_and(|text| is_hex_len(text, len)))
                    })
            };
            parallel("credentialSigs", 128) && parallel("saltCommitments", 64)
        }
        "outputs" => valid_array(object.get("outputs"), valid_authorized_output).is_some(),
        "onion_output" => {
            str_field(object, "onion").is_some_and(|onion| !onion.is_empty())
                && valid_participants(object.get("mixOrder"))
        }
        "onion_declare" => int_in(
            object.get("outputCount"),
            1,
            MAX_OUTPUT_CREDENTIALS_PER_PEER as u64,
        ),
        "assembled" => match (
            valid_array(object.get("inputs"), valid_input),
            valid_array(object.get("outputs"), valid_output),
        ) {
            (Some(inputs), Some(outputs)) => inputs + outputs <= MAX_COMPONENTS,
            _ => false,
        },
        "signature" => valid_array(object.get("sigs"), valid_signature).is_some(),
        "final" => {
            str_field(object, "txid").is_some_and(|txid| is_hex_len(txid, 64))
                && str_field(object, "txHex").is_some_and(|tx| {
                    (2..=MAX_TX_HEX_CHARS).contains(&tx.len())
                        && tx.len().is_multiple_of(2)
                        && tx.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
        }
        _ => false,
    };
    if !shaped {
        return None;
    }
    serde_json::from_value(value).ok()
}

/// `Number.MAX_SAFE_INTEGER`: JavaScript peers lose precision above it.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn str_field<'a>(object: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
    object.get(field).and_then(Value::as_str)
}

/// `isSafeIntegerIn`: a JSON integer within `min..=max`.
fn int_in(value: Option<&Value>, min: u64, max: u64) -> bool {
    value
        .and_then(Value::as_u64)
        .is_some_and(|number| number <= MAX_SAFE_INTEGER && (min..=max).contains(&number))
}

/// `validSession`: 1–128 printable ASCII characters.
fn valid_session(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|session| {
        (1..=128).contains(&session.len())
            && session.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
    })
}

/// `validBinding`: version 4, a 16-byte hex nonce, and a timestamp no older
/// than five minutes and no more than 30 seconds ahead.
fn valid_binding(object: &Map<String, Value>, now_unix: u64) -> bool {
    if object.get("version").and_then(Value::as_u64) != Some(ROUND_MSG_VERSION) {
        return false;
    }
    if !str_field(object, "nonce").is_some_and(|nonce| is_hex_len(nonce, 32)) {
        return false;
    }
    let Some(timestamp) = object.get("timestamp").and_then(Value::as_u64) else {
        return false;
    };
    if timestamp > MAX_SAFE_INTEGER {
        return false;
    }
    let age = now_unix as i64 - timestamp as i64;
    (-MAX_CLOCK_SKEW_SECONDS..=MAX_MESSAGE_AGE_SECONDS).contains(&age)
}

fn valid_network(object: &Map<String, Value>) -> bool {
    matches!(str_field(object, "network"), Some("mainnet" | "chipnet"))
}

/// `validParticipants`: 2–20 distinct 32-byte x-only keys.
fn valid_participants(value: Option<&Value>) -> bool {
    let Some(items) = value.and_then(Value::as_array) else {
        return false;
    };
    if !(2..=MAX_WIRE_PARTICIPANTS).contains(&items.len()) {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    items.iter().all(|item| {
        item.as_str()
            .is_some_and(|key| is_hex_len(key, 64) && seen.insert(key.to_owned()))
    })
}

/// `validArray`: 1–120 items, each passing `check`. The item count on success.
fn valid_array(value: Option<&Value>, check: fn(&Value) -> bool) -> Option<usize> {
    let items = value.and_then(Value::as_array)?;
    ((1..=MAX_COMPONENTS).contains(&items.len()) && items.iter().all(check)).then_some(items.len())
}

fn valid_input(value: &Value) -> bool {
    let Some(input) = value.as_object() else {
        return false;
    };
    str_field(input, "prevTxid").is_some_and(|txid| is_hex_len(txid, 64))
        && int_in(input.get("prevIndex"), 0, u32::MAX as u64)
        && int_in(input.get("value"), 1, MAX_MONEY)
        && str_field(input, "pubkey").is_some_and(is_compressed_pubkey_hex)
}

fn valid_script_hex(script: &str, max_chars: usize) -> bool {
    !script.is_empty()
        && script.len() <= max_chars
        && script.len().is_multiple_of(2)
        && script.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_output(value: &Value) -> bool {
    let Some(output) = value.as_object() else {
        return false;
    };
    str_field(output, "script").is_some_and(|script| valid_script_hex(script, MAX_SCRIPT_HEX_CHARS))
        && int_in(output.get("value"), MIN_OUTPUT_VALUE, MAX_MONEY)
}

fn valid_authorized_output(value: &Value) -> bool {
    let Some(output) = value.as_object() else {
        return false;
    };
    valid_output(value)
        && str_field(output, "credentialSerial").is_some_and(|serial| is_hex_len(serial, 64))
        && str_field(output, "credentialSig").is_some_and(|sig| is_hex_len(sig, 128))
        && str_field(output, "saltCommitment").is_some_and(|salt| is_hex_len(salt, 64))
}

fn valid_signature(value: &Value) -> bool {
    let Some(sig) = value.as_object() else {
        return false;
    };
    str_field(sig, "prevTxid").is_some_and(|txid| is_hex_len(txid, 64))
        && int_in(sig.get("prevIndex"), 0, u32::MAX as u64)
        && str_field(sig, "unlockingBytecode")
            .is_some_and(|script| valid_script_hex(script, MAX_SCRIPT_HEX_CHARS))
}

/// One `{index, <field>}` slot with a 0–1023 index and a 32-byte hex scalar.
fn valid_slot(value: &Value, field: &str) -> bool {
    value.as_object().is_some_and(|slot| {
        int_in(slot.get("index"), 0, 1023)
            && str_field(slot, field).is_some_and(|hex| is_hex_len(hex, 64))
    })
}

fn valid_component_commitment(value: &Value) -> bool {
    value.as_object().is_some_and(|commitment| {
        int_in(commitment.get("index"), 0, 1023)
            && str_field(commitment, "saltedComponentHash").is_some_and(|hash| is_hex_len(hash, 64))
            && str_field(commitment, "amountCommitment").is_some_and(is_uncompressed_point_hex)
    })
}

fn valid_credential_request(object: &Map<String, Value>) -> bool {
    let (Some(requests), Some(amounts), Some(commitments)) = (
        object.get("requests").and_then(Value::as_array),
        object.get("amountCommitments").and_then(Value::as_array),
        object.get("componentCommitments").and_then(Value::as_array),
    ) else {
        return false;
    };
    let input_count = object.get("inputCount").and_then(Value::as_u64);
    let output_count = object.get("outputCount").and_then(Value::as_u64);
    if !(1..=MAX_COMPONENTS).contains(&requests.len())
        || !requests.iter().all(|slot| valid_slot(slot, "e"))
        || !(1..=MAX_COMPONENTS).contains(&amounts.len())
        || !amounts
            .iter()
            .all(|amount| amount.as_str().is_some_and(is_uncompressed_point_hex))
        || commitments.len() != requests.len()
        || !commitments.iter().all(valid_component_commitment)
        || !str_field(object, "pedersenTotalNonce").is_some_and(|nonce| is_hex_len(nonce, 64))
        || !int_in(object.get("excessFee"), 0, MAX_MONEY)
        || !int_in(
            object.get("inputCount"),
            1,
            MAX_INPUT_CREDENTIALS_PER_PEER as u64,
        )
        || !int_in(
            object.get("outputCount"),
            1,
            MAX_OUTPUT_CREDENTIALS_PER_PEER as u64,
        )
    {
        return false;
    }
    let (Some(input_count), Some(output_count)) = (input_count, output_count) else {
        return false;
    };
    let index_of = |slot: &Value| slot.get("index").and_then(Value::as_u64);
    let distinct: std::collections::HashSet<_> = requests.iter().map(index_of).collect();
    requests.len() as u64 == input_count + output_count
        && amounts.len() == requests.len()
        && requests.len() <= CREDENTIAL_SLOTS_PER_PEER
        && distinct.len() == requests.len()
        && commitments
            .iter()
            .zip(requests)
            .zip(amounts)
            .all(|((commitment, request), amount)| {
                index_of(commitment) == index_of(request)
                    && commitment
                        .get("amountCommitment")
                        .and_then(Value::as_str)
                        .zip(amount.as_str())
                        .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
            })
}

/// The legacy disclosure is bounded like every component-bearing message: it
/// arrives from an aborted round, exactly when a hostile peer has most reason
/// to send something oversized.
fn valid_disclosure(object: &Map<String, Value>) -> bool {
    let outpoint = |text: &str| {
        text.split_once(':').is_some_and(|(txid, index)| {
            is_hex_len(txid, 64) && !index.is_empty() && index.bytes().all(|b| b.is_ascii_digit())
        })
    };
    let (Some(outpoints), Some(serials)) = (
        object.get("outpoints").and_then(Value::as_array),
        object.get("serials").and_then(Value::as_array),
    ) else {
        return false;
    };
    if outpoints.len() > MAX_COMPONENTS
        || serials.len() > MAX_COMPONENTS
        || outpoints.len() + serials.len() == 0
        || !outpoints
            .iter()
            .all(|item| item.as_str().is_some_and(outpoint))
        || !serials
            .iter()
            .all(|item| item.as_str().is_some_and(|serial| is_hex_len(serial, 64)))
    {
        return false;
    }
    if let Some(openings) = object.get("openings") {
        let Some(openings) = openings.as_array() else {
            return false;
        };
        let opening_ok = |entry: &Value| {
            entry.as_object().is_some_and(|entry| {
                str_field(entry, "outpoint").is_some_and(outpoint)
                    && int_in(entry.get("slotIndex"), 0, 4095)
                    && str_field(entry, "openingHex").is_some_and(|hex| is_hex_len(hex, 128))
            })
        };
        if openings.len() > MAX_COMPONENTS || !openings.iter().all(opening_ok) {
            return false;
        }
    }
    if let Some(openings) = object.get("componentOpenings") {
        let Some(openings) = openings.as_array() else {
            return false;
        };
        let opening_ok = |entry: &Value| {
            entry.as_object().is_some_and(|entry| {
                let kind = str_field(entry, "kind");
                let common = int_in(entry.get("slotIndex"), 0, 4095)
                    && str_field(entry, "openingHex").is_some_and(|hex| is_hex_len(hex, 128))
                    && str_field(entry, "saltHex").is_some_and(|hex| is_hex_len(hex, 64))
                    && str_field(entry, "pedersenNonceHex").is_some_and(|hex| is_hex_len(hex, 64));
                common
                    && match kind {
                        Some("input") => str_field(entry, "outpoint").is_some_and(outpoint),
                        Some("output") => str_field(entry, "credentialSerial")
                            .is_some_and(|serial| is_hex_len(serial, 64)),
                        _ => false,
                    }
            })
        };
        if openings.len() > MAX_COMPONENTS || !openings.iter().all(opening_ok) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000;

    fn key(byte: u8) -> String {
        super::super::hex(&[byte; 32])
    }

    fn message(body: Body) -> RoundMessage {
        RoundMessage::new(&key(0xee), body, NOW)
    }

    #[test]
    fn a_message_round_trips_through_its_own_parser() {
        let messages = [
            message(Body::RoundProposal {
                network: PoolNetwork::Chipnet,
                tier: 100_000,
                epoch: 7,
                participants: vec![key(1), key(2), key(3), key(4)],
            }),
            message(Body::OnionDeclare { output_count: 3 }),
            message(Body::ComponentsReady {}),
            message(Body::Abort {
                reason: "cancelled".into(),
            }),
        ];
        for sent in messages {
            let json = sent.to_json();
            assert_eq!(parse_round_message(&json, NOW), Some(sent), "{json}");
        }
    }

    #[test]
    fn the_wire_shape_is_flat_with_a_type_tag() {
        let json = message(Body::RoundAck {
            network: PoolNetwork::Mainnet,
            tier: 1_000_000,
            epoch: 1,
        })
        .to_json();
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["type"], "round_ack");
        assert_eq!(value["version"], 4);
        assert_eq!(value["network"], "mainnet");
        assert_eq!(value["nonce"].as_str().unwrap().len(), 32);
    }

    #[test]
    fn binding_refuses_other_versions_and_stale_or_future_messages() {
        let base = message(Body::ComponentsReady {});
        let mut value: Value = serde_json::from_str(&base.to_json()).unwrap();
        value["version"] = 3.into();
        assert!(parse_round_message(&value.to_string(), NOW).is_none());
        value["version"] = 4.into();
        value["timestamp"] = (NOW - 301).into();
        assert!(parse_round_message(&value.to_string(), NOW).is_none());
        value["timestamp"] = (NOW + 31).into();
        assert!(parse_round_message(&value.to_string(), NOW).is_none());
        value["timestamp"] = (NOW + 30).into();
        assert!(parse_round_message(&value.to_string(), NOW).is_some());
        value["nonce"] = "abc".into();
        assert!(parse_round_message(&value.to_string(), NOW).is_none());
    }

    #[test]
    fn participants_must_be_distinct_x_only_keys() {
        let mut value: Value = serde_json::from_str(
            &message(Body::RoundStart {
                network: PoolNetwork::Chipnet,
                tier: 100_000,
                epoch: 7,
                participants: vec![key(1), key(2)],
            })
            .to_json(),
        )
        .unwrap();
        assert!(parse_round_message(&value.to_string(), NOW).is_some());
        value["participants"] = serde_json::json!([key(1), key(1)]);
        assert!(parse_round_message(&value.to_string(), NOW).is_none());
        value["participants"] = serde_json::json!([key(1)]);
        assert!(parse_round_message(&value.to_string(), NOW).is_none());
        value["participants"] = serde_json::json!([key(1), format!("02{}", key(2))]);
        assert!(parse_round_message(&value.to_string(), NOW).is_none());
        value["participants"] = serde_json::json!([key(1), key(2)]);
        value["tier"] = 9_999.into();
        assert!(parse_round_message(&value.to_string(), NOW).is_none());
    }

    #[test]
    fn a_credential_request_must_agree_with_itself() {
        let point = format!("04{}", "11".repeat(64));
        let request = |count: u32, index_of_commitment: u32| {
            serde_json::json!({
                "version": 4, "nonce": "00".repeat(16), "timestamp": NOW,
                "session": key(9), "type": "credential_request",
                "requests": (0..count).map(|i| serde_json::json!({"index": i, "e": "22".repeat(32)})).collect::<Vec<_>>(),
                "amountCommitments": (0..count).map(|_| point.clone()).collect::<Vec<_>>(),
                "componentCommitments": (0..count).map(|i| serde_json::json!({
                    "index": if i == 0 { index_of_commitment } else { i },
                    "saltedComponentHash": "33".repeat(32),
                    "amountCommitment": point.clone(),
                })).collect::<Vec<_>>(),
                "pedersenTotalNonce": "44".repeat(32),
                "excessFee": 1_000,
                "inputCount": 1, "outputCount": count - 1,
            })
        };
        assert!(parse_round_message(&request(3, 0).to_string(), NOW).is_some());
        assert!(
            parse_round_message(&request(3, 2).to_string(), NOW).is_none(),
            "commitment index differs from its request"
        );
        let mut counts = request(3, 0);
        counts["outputCount"] = 1.into();
        assert!(parse_round_message(&counts.to_string(), NOW).is_none());
    }

    #[test]
    fn unknown_types_and_oversized_content_are_dropped() {
        let mut value: Value =
            serde_json::from_str(&message(Body::ComponentsReady {}).to_json()).unwrap();
        value["type"] = "outputs_v2".into();
        assert!(parse_round_message(&value.to_string(), NOW).is_none());
        let huge = format!(
            r#"{{"version":4,"nonce":"{}","timestamp":{NOW},"session":"s","type":"abort","reason":"{}"}}"#,
            "00".repeat(16),
            "x".repeat(MAX_ROUND_MESSAGE_CHARS)
        );
        assert!(parse_round_message(&huge, NOW).is_none());
    }

    #[test]
    fn only_components_are_anonymous() {
        assert!(Body::Inputs {
            inputs: vec![],
            credential_sigs: vec![],
            salt_commitments: vec![]
        }
        .is_anonymous());
        assert!(Body::Signature { sigs: vec![] }.is_anonymous());
        assert!(!Body::ComponentsReady {}.is_anonymous());
        assert!(!Body::OnionDeclare { output_count: 1 }.is_anonymous());
    }
}
