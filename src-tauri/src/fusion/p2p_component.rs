//! P2P CashFusion v4 — EC component plane (Phase B).
//!
//! Blind credentials must cover `sha256(serialized Component)`, the same bytes
//! Electron Cash and the classic server path use (`components.rs`). This module
//! is the shared encode + hash surface the Nostr path will call; it does **not**
//! bump the live round wire version by itself.
//!
//! Spec: `docs/p2p-ec-component-plane-v4.md`.

use prost::Message;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::pb;

const MAX_PUBKEY: usize = 65;
const MAX_SCRIPT: usize = 10_000;
const SALT_COMMITMENT_LEN: usize = 32;
const TXID_LEN: usize = 32;

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn hex_decode(s: &str, field: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return Err(format!("{field}: odd-length hex"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&s[i..i + 2], 16)
                .map_err(|_| format!("{field}: bad hex"))
        })
        .collect()
}

fn require_len(bytes: &[u8], expected: usize, field: &str) -> Result<(), String> {
    if bytes.len() != expected {
        return Err(format!(
            "{field}: expected {expected} bytes, got {}",
            bytes.len()
        ));
    }
    Ok(())
}

/// Blind-credential message for one component — Electron Cash / server rule.
pub fn component_blind_message(component_ser: &[u8]) -> [u8; 32] {
    sha256(component_ser)
}

/// Encode a finalized input `Component` (salt_commitment already set).
/// `prev_txid_wire` is **little-endian** (wire order), as in fusion.proto.
pub fn encode_input_component(
    prev_txid_wire: &[u8],
    prev_index: u32,
    pubkey: &[u8],
    amount: u64,
    salt_commitment: &[u8],
) -> Result<Vec<u8>, String> {
    require_len(prev_txid_wire, TXID_LEN, "prev_txid")?;
    require_len(salt_commitment, SALT_COMMITMENT_LEN, "salt_commitment")?;
    if pubkey.is_empty() || pubkey.len() > MAX_PUBKEY {
        return Err("pubkey length out of range".into());
    }
    let comp = pb::Component {
        salt_commitment: salt_commitment.to_vec(),
        component: Some(pb::component::Component::Input(pb::InputComponent {
            prev_txid: prev_txid_wire.to_vec(),
            prev_index,
            pubkey: pubkey.to_vec(),
            amount,
        })),
    };
    Ok(comp.encode_to_vec())
}

/// Encode a finalized output `Component`.
pub fn encode_output_component(
    scriptpubkey: &[u8],
    amount: u64,
    salt_commitment: &[u8],
) -> Result<Vec<u8>, String> {
    require_len(salt_commitment, SALT_COMMITMENT_LEN, "salt_commitment")?;
    if scriptpubkey.is_empty() || scriptpubkey.len() > MAX_SCRIPT {
        return Err("scriptpubkey length out of range".into());
    }
    let comp = pb::Component {
        salt_commitment: salt_commitment.to_vec(),
        component: Some(pb::component::Component::Output(pb::OutputComponent {
            scriptpubkey: scriptpubkey.to_vec(),
            amount,
        })),
    };
    Ok(comp.encode_to_vec())
}

/// Encode a finalized blank `Component`.
pub fn encode_blank_component(salt_commitment: &[u8]) -> Result<Vec<u8>, String> {
    require_len(salt_commitment, SALT_COMMITMENT_LEN, "salt_commitment")?;
    let comp = pb::Component {
        salt_commitment: salt_commitment.to_vec(),
        component: Some(pb::component::Component::Blank(pb::BlankComponent {})),
    };
    Ok(comp.encode_to_vec())
}

// ── Tauri-facing request/response ──────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct P2pComponentEncodeRequest {
    /// `input` | `output` | `blank`
    pub kind: String,
    /// 32-byte salt commitment, hex.
    pub salt_commitment: String,
    /// Display (big-endian) prev txid hex — reversed to wire order for inputs.
    pub prev_txid: Option<String>,
    pub prev_index: Option<u32>,
    pub pubkey: Option<String>,
    pub script: Option<String>,
    pub amount: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pComponentEncodeResponse {
    /// Always `p2p-v4-ec-component` so the renderer cannot confuse this with v3 string hashes.
    pub protocol: &'static str,
    pub component_hex: String,
    /// `sha256(component)` — the only legal blind-credential message for v4.
    pub blind_message_hex: String,
}

pub const P2P_COMPONENT_PROTOCOL: &str = "p2p-v4-ec-component";

pub fn encode_component_for_p2p(
    request: P2pComponentEncodeRequest,
) -> Result<P2pComponentEncodeResponse, String> {
    let salt = hex_decode(&request.salt_commitment, "saltCommitment")?;
    let (component_ser, _kind_label) = match request.kind.as_str() {
        "input" => {
            let txid_display = request
                .prev_txid
                .as_deref()
                .ok_or("input requires prevTxid")?;
            let mut txid = hex_decode(txid_display, "prevTxid")?;
            require_len(&txid, TXID_LEN, "prevTxid")?;
            txid.reverse(); // display big-endian → wire little-endian
            let prev_index = request.prev_index.ok_or("input requires prevIndex")?;
            let pubkey = hex_decode(request.pubkey.as_deref().ok_or("input requires pubkey")?, "pubkey")?;
            let amount = request.amount.ok_or("input requires amount")?;
            (
                encode_input_component(&txid, prev_index, &pubkey, amount, &salt)?,
                "input",
            )
        }
        "output" => {
            let script = hex_decode(
                request.script.as_deref().ok_or("output requires script")?,
                "script",
            )?;
            let amount = request.amount.ok_or("output requires amount")?;
            (
                encode_output_component(&script, amount, &salt)?,
                "output",
            )
        }
        "blank" => (encode_blank_component(&salt)?, "blank"),
        other => return Err(format!("unknown component kind: {other}")),
    };

    let msg = component_blind_message(&component_ser);
    Ok(P2pComponentEncodeResponse {
        protocol: P2P_COMPONENT_PROTOCOL,
        component_hex: hex::encode(component_ser),
        blind_message_hex: hex::encode(msg),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same vector as `components.rs::canonical_input_component_matches_electron_cash_protobuf_wire_vector`.
    const EC_INPUT_COMPONENT_HEX: &str = concat!(
        "0a20",
        "1111111111111111111111111111111111111111111111111111111111111111",
        "124b0a20",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "10031a21",
        "020202020202020202020202020202020202020202020202020202020202020202",
        "20c09a0c"
    );

    #[test]
    fn encode_input_matches_electron_cash_protobuf_wire_vector() {
        let ser = encode_input_component(
            &[0xaa; 32],
            3,
            &[0x02; 33],
            200_000,
            &[0x11; 32],
        )
        .unwrap();
        assert_eq!(hex::encode(&ser), EC_INPUT_COMPONENT_HEX);
    }

    #[test]
    fn blind_message_is_sha256_of_component_bytes() {
        let ser = encode_input_component(
            &[0xaa; 32],
            3,
            &[0x02; 33],
            200_000,
            &[0x11; 32],
        )
        .unwrap();
        let msg = component_blind_message(&ser);
        assert_eq!(msg, sha256(&ser));
        // Not equal to hashing a v3-style UTF-8 domain string of the same fields.
        let v3_style = format!(
            "optn-p2p-component-v3|chipnet|session|10000|input|{}|200000|serial",
            "02".repeat(33)
        );
        assert_ne!(msg, sha256(v3_style.as_bytes()));
    }

    #[test]
    fn tauri_request_reverses_display_txid_to_wire() {
        // Display big-endian all-0xaa is also all-0xaa little-endian; use a
        // patterned id so reverse is observable.
        let mut display = [0u8; 32];
        for (i, b) in display.iter_mut().enumerate() {
            *b = i as u8;
        }
        let display_hex = hex::encode(display);
        let mut wire = display;
        wire.reverse();

        let resp = encode_component_for_p2p(P2pComponentEncodeRequest {
            kind: "input".into(),
            salt_commitment: "11".repeat(32),
            prev_txid: Some(display_hex),
            prev_index: Some(1),
            pubkey: Some("02".repeat(33)),
            script: None,
            amount: Some(50_000),
        })
        .unwrap();

        let direct = encode_input_component(&wire, 1, &[0x02; 33], 50_000, &[0x11; 32]).unwrap();
        assert_eq!(resp.component_hex, hex::encode(direct));
        assert_eq!(resp.protocol, P2P_COMPONENT_PROTOCOL);
        assert_eq!(resp.blind_message_hex.len(), 64);
    }

    #[test]
    fn output_and_blank_encode() {
        let out = encode_output_component(&[0x76, 0xa9, 0x14], 10_000, &[0x22; 32]).unwrap();
        assert!(!out.is_empty());
        assert_eq!(component_blind_message(&out), sha256(&out));

        let blank = encode_blank_component(&[0x33; 32]).unwrap();
        assert!(!blank.is_empty());
        assert_eq!(component_blind_message(&blank), sha256(&blank));
    }
}
