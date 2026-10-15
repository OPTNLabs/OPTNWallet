//! Provable protocol faults (`nostr/fusionBlame.ts`).
//!
//! Prove or don't blame: a report names a round key only with evidence any
//! peer can re-check, and every peer re-checks before acting on one. A missing
//! signature, a timeout or a late join is an ambiguous abort and names nobody.
//! The accused is the throwaway round key, never a person.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::credentials::{
    canonical_scalar, input_component, input_credential_hash, opening_matches, output_component,
    pedersen_balance_holds, pedersen_commit, peer_slot_base, salt_commitment,
    salted_component_hash, verify_schnorr_hex, CREDENTIAL_SLOTS_PER_PEER,
};
use super::wire::{InputRef, OutputRef};
use super::{
    fee_for_bytes, hex, is_compressed_pubkey_hex, is_hex_len, is_uncompressed_point_hex,
    unhex_array,
};

/// Faults that carry cryptographic or structural evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlameCode {
    PedersenUnbalanced,
    InvalidComponentCommitment,
    CredentialSlotOob,
    InvalidInputCredential,
    DuplicateOutpoint,
    /// Parsed for compatibility; never accepted as evidence.
    InvalidSignatureSet,
}

impl BlameCode {
    fn label(self) -> &'static str {
        match self {
            BlameCode::PedersenUnbalanced => "Pedersen balance failed",
            BlameCode::InvalidComponentCommitment => "component commitment opening failed",
            BlameCode::CredentialSlotOob => "credential slot out of range",
            BlameCode::InvalidInputCredential => "invalid input credential",
            BlameCode::DuplicateOutpoint => "duplicate outpoint",
            BlameCode::InvalidSignatureSet => "invalid signature set",
        }
    }
}

/// The anonymous component an `invalid_component_commitment` opens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpenedComponent {
    #[serde(rename_all = "camelCase")]
    Input {
        input: InputRef,
        salt_commitment_hex: String,
    },
    #[serde(rename_all = "camelCase")]
    Output {
        output: OutputRef,
        salt_commitment_hex: String,
        credential_serial: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialCommitment {
    pub salted_component_hash: String,
    pub amount_commitment: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedOpening {
    pub outpoint: String,
    pub slot_index: u32,
    pub opening_hex: String,
    pub request_hex: String,
    pub r_point_hex: String,
    pub salt_commitment_hex: String,
}

/// The evidence for each code, tagged by `kind` as on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BlameEvidence {
    #[serde(rename_all = "camelCase")]
    PedersenUnbalanced {
        amount_commitments: Vec<String>,
        pedersen_total_nonce: String,
        excess_fee: u64,
    },
    #[serde(rename_all = "camelCase")]
    InvalidComponentCommitment {
        feerate: u64,
        component: OpenedComponent,
        salt_hex: String,
        pedersen_nonce_hex: String,
        initial_commitment: InitialCommitment,
        round_pubkey: String,
        r_point_hex: String,
        request_hex: String,
        opening_hex: String,
    },
    #[serde(rename_all = "camelCase")]
    CredentialSlotOob {
        slots: Vec<u64>,
        participants: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    InvalidInputCredential {
        round_pubkey: String,
        inputs: Vec<InputRef>,
        credential_sigs: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        failed_openings: Option<Vec<FailedOpening>>,
    },
    #[serde(rename_all = "camelCase")]
    DuplicateOutpoint {
        prev_txid: String,
        prev_index: u64,
        claimants: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    InvalidSignatureSet {
        expected_outpoints: Vec<String>,
        received_outpoints: Vec<String>,
    },
}

impl BlameEvidence {
    pub fn code(&self) -> BlameCode {
        match self {
            BlameEvidence::PedersenUnbalanced { .. } => BlameCode::PedersenUnbalanced,
            BlameEvidence::InvalidComponentCommitment { .. } => {
                BlameCode::InvalidComponentCommitment
            }
            BlameEvidence::CredentialSlotOob { .. } => BlameCode::CredentialSlotOob,
            BlameEvidence::InvalidInputCredential { .. } => BlameCode::InvalidInputCredential,
            BlameEvidence::DuplicateOutpoint { .. } => BlameCode::DuplicateOutpoint,
            BlameEvidence::InvalidSignatureSet { .. } => BlameCode::InvalidSignatureSet,
        }
    }
}

/// Evidence from the wire, only when its `kind` is the message's `code`
/// (`parseBlameEvidence`).
pub fn parse_evidence(code: BlameCode, raw: Option<&Value>) -> Option<BlameEvidence> {
    let evidence: BlameEvidence = serde_json::from_value(raw?.clone()).ok()?;
    (evidence.code() == code).then_some(evidence)
}

/// A blame report (`BlameReport`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlameReport {
    pub session: String,
    pub accused: String,
    pub code: BlameCode,
    pub evidence: BlameEvidence,
}

/// What a peer checks a report against.
pub struct VerifyContext<'a> {
    pub session: &'a str,
    pub participants: &'a [String],
    pub feerate: Option<u64>,
}

/// The abort reason shown for a verified report. It names the fault, never
/// the key (`formatBlameAbortReason`).
pub fn abort_reason(code: BlameCode) -> String {
    format!(
        "Protocol fault ({}). Round aborted safely. Not a network timeout — others may retry together.",
        code.label()
    )
}

fn valid_session_pubkey(text: &str) -> bool {
    is_hex_len(text, 64) || is_compressed_pubkey_hex(text)
}

fn valid_input(input: &InputRef) -> bool {
    is_hex_len(&input.prev_txid, 64) && input.value >= 1 && is_compressed_pubkey_hex(&input.pubkey)
}

fn valid_output(output: &OutputRef) -> bool {
    (2..=20_000).contains(&output.script.len())
        && output.script.len().is_multiple_of(2)
        && output.script.bytes().all(|byte| byte.is_ascii_hexdigit())
        && output.value >= 1
}

/// The component bytes and signed amount an opening commits to.
fn component_material(feerate: u64, component: &OpenedComponent) -> Option<(Vec<u8>, i64)> {
    match component {
        OpenedComponent::Input {
            input,
            salt_commitment_hex,
        } => {
            if !valid_input(input) {
                return None;
            }
            let fee = fee_for_bytes(108 + input.pubkey.len() as u64 / 2, feerate);
            let amount = i64::try_from(input.value).ok()? - i64::try_from(fee).ok()?;
            Some((input_component(input, salt_commitment_hex).ok()?, amount))
        }
        OpenedComponent::Output {
            output,
            salt_commitment_hex,
            credential_serial,
        } => {
            if !valid_output(output) || !is_hex_len(credential_serial, 64) {
                return None;
            }
            let fee = fee_for_bytes(9 + output.script.len() as u64 / 2, feerate);
            let amount = -(i64::try_from(output.value).ok()? + i64::try_from(fee).ok()?);
            Some((output_component(output, salt_commitment_hex).ok()?, amount))
        }
    }
}

fn component_salt_commitment(component: &OpenedComponent) -> &str {
    match component {
        OpenedComponent::Input {
            salt_commitment_hex,
            ..
        }
        | OpenedComponent::Output {
            salt_commitment_hex,
            ..
        } => salt_commitment_hex,
    }
}

/// Re-verify a report before acting on it (`verifyBlameReport`). Without this
/// a coordinator could frame any peer with gossip alone.
pub fn verify(report: &BlameReport, ctx: &VerifyContext<'_>) -> Result<(), String> {
    if report.session != ctx.session {
        return Err("session mismatch".into());
    }
    if !valid_session_pubkey(&report.accused) {
        return Err("invalid accused pubkey".into());
    }
    if !ctx.participants.contains(&report.accused) {
        return Err("accused not in participant set".into());
    }
    if report.evidence.code() != report.code {
        return Err("evidence kind mismatch".into());
    }
    match &report.evidence {
        BlameEvidence::PedersenUnbalanced {
            amount_commitments,
            pedersen_total_nonce,
            excess_fee,
        } => {
            if amount_commitments.is_empty()
                || amount_commitments.len() > 64
                || !amount_commitments
                    .iter()
                    .all(|c| is_uncompressed_point_hex(c))
                || !is_hex_len(pedersen_total_nonce, 64)
                || *excess_fee > super::wire::MAX_SAFE_INTEGER
            {
                return Err("malformed pedersen evidence".into());
            }
            if pedersen_balance_holds(amount_commitments, *excess_fee, pedersen_total_nonce) {
                return Err("pedersen actually balanced".into());
            }
            Ok(())
        }
        BlameEvidence::InvalidComponentCommitment {
            feerate,
            component,
            salt_hex,
            pedersen_nonce_hex,
            initial_commitment,
            round_pubkey,
            r_point_hex,
            request_hex,
            opening_hex,
        } => {
            if *feerate < 1
                || *feerate > super::wire::MAX_SAFE_INTEGER
                || ctx.feerate.is_some_and(|expected| expected != *feerate)
                || !is_hex_len(&initial_commitment.salted_component_hash, 64)
                || !is_uncompressed_point_hex(&initial_commitment.amount_commitment)
                || !is_hex_len(salt_hex, 64)
                || !is_hex_len(pedersen_nonce_hex, 64)
                || !is_compressed_pubkey_hex(round_pubkey)
                || !is_compressed_pubkey_hex(r_point_hex)
                || !is_hex_len(request_hex, 64)
                || !is_hex_len(opening_hex, 128)
                || !is_hex_len(component_salt_commitment(component), 64)
            {
                return Err("malformed component commitment evidence".into());
            }
            let Some((bytes, amount)) = component_material(*feerate, component) else {
                return Err("component is not bound to accused slot".into());
            };
            let message: [u8; 32] = {
                use sha2::{Digest, Sha256};
                Sha256::digest(&bytes).into()
            };
            // The blind opening is the unlinkable proof that this anonymous
            // component used a slot issued to the accused.
            if !opening_matches(round_pubkey, r_point_hex, message, opening_hex, request_hex) {
                return Err("component is not bound to accused slot".into());
            }
            let salt = unhex_array::<32>(salt_hex).expect("checked above");
            let opens = hex(&salt_commitment(&salt))
                .eq_ignore_ascii_case(component_salt_commitment(component))
                && hex(&salted_component_hash(&salt, &bytes))
                    .eq_ignore_ascii_case(&initial_commitment.salted_component_hash)
                && unhex_array::<32>(pedersen_nonce_hex)
                    .and_then(|nonce| canonical_scalar(&nonce))
                    .is_some_and(|nonce| {
                        pedersen_commit(amount, &nonce)
                            .eq_ignore_ascii_case(&initial_commitment.amount_commitment)
                    });
            if opens {
                return Err("component commitment actually matches".into());
            }
            Ok(())
        }
        BlameEvidence::CredentialSlotOob {
            slots,
            participants,
        } => {
            if slots.is_empty()
                || slots.len() > 64
                || slots
                    .iter()
                    .any(|&slot| slot > super::wire::MAX_SAFE_INTEGER)
                || participants.is_empty()
            {
                return Err("malformed slot evidence".into());
            }
            let mut theirs = participants.clone();
            let mut ours = ctx.participants.to_vec();
            theirs.sort();
            ours.sort();
            if theirs.join(",") != ours.join(",") {
                return Err("participant set mismatch".into());
            }
            let base = peer_slot_base(ctx.participants, &report.accused)
                .ok_or("accused not in set for slots")? as u64;
            let end = base + CREDENTIAL_SLOTS_PER_PEER as u64;
            if !slots.iter().any(|&slot| slot < base || slot >= end) {
                return Err("all slots in range".into());
            }
            Ok(())
        }
        BlameEvidence::InvalidInputCredential {
            round_pubkey,
            inputs,
            credential_sigs,
            failed_openings,
        } => {
            if !is_compressed_pubkey_hex(round_pubkey)
                || inputs.is_empty()
                || inputs.len() > 16
                || !inputs.iter().all(valid_input)
            {
                return Err("malformed credential evidence".into());
            }
            if let Some(openings) = failed_openings
                .as_ref()
                .filter(|openings| !openings.is_empty())
            {
                if openings.len() > 16 {
                    return Err("malformed credential evidence".into());
                }
                for opening in openings {
                    let input = inputs
                        .iter()
                        .find(|input| input.key() == opening.outpoint)
                        .ok_or("opening outpoint not in inputs")?;
                    let message = input_credential_hash(input, &opening.salt_commitment_hex)
                        .map_err(|_| "malformed credential evidence".to_string())?;
                    if opening_matches(
                        round_pubkey,
                        &opening.r_point_hex,
                        message,
                        &opening.opening_hex,
                        &opening.request_hex,
                    ) {
                        return Err("opening actually verifies".into());
                    }
                }
                return Ok(());
            }
            if inputs.len() != credential_sigs.len()
                || !credential_sigs.iter().all(|sig| is_hex_len(sig, 128))
            {
                return Err("malformed credential evidence".into());
            }
            // Any salt names the hash domain; the claim is only that a
            // credential fails under the round key.
            let dummy_salt = "00".repeat(32);
            let any_invalid = inputs.iter().zip(credential_sigs).any(|(input, sig)| {
                input_credential_hash(input, &dummy_salt)
                    .map(|message| !verify_schnorr_hex(round_pubkey, sig, &message))
                    .unwrap_or(true)
            });
            if !any_invalid {
                return Err("all credentials verify".into());
            }
            Ok(())
        }
        BlameEvidence::DuplicateOutpoint {
            prev_txid,
            prev_index,
            claimants,
        } => {
            if !is_hex_len(prev_txid, 64)
                || *prev_index > super::wire::MAX_SAFE_INTEGER
                || claimants.len() < 2
                || !claimants.iter().all(|claimant| {
                    valid_session_pubkey(claimant) && ctx.participants.contains(claimant)
                })
            {
                return Err("malformed outpoint evidence".into());
            }
            if !claimants.contains(&report.accused) {
                return Err("accused not among claimants".into());
            }
            Ok(())
        }
        BlameEvidence::InvalidSignatureSet { .. } => {
            Err("signature absence is not blame evidence".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> String {
        hex(&[byte; 32])
    }

    #[test]
    fn a_slot_report_must_name_a_slot_outside_the_accused_range() {
        let participants = vec![key(1), key(2), key(3)];
        let report = |slots: Vec<u64>| BlameReport {
            session: "s".into(),
            accused: key(2),
            code: BlameCode::CredentialSlotOob,
            evidence: BlameEvidence::CredentialSlotOob {
                slots,
                participants: participants.clone(),
            },
        };
        let ctx = VerifyContext {
            session: "s",
            participants: &participants,
            feerate: Some(1_000),
        };
        // Peer 2 of 3 owns 24..48.
        assert!(verify(&report(vec![24, 47]), &ctx).is_err());
        assert!(verify(&report(vec![24, 48]), &ctx).is_ok());
        let wrong_session = VerifyContext {
            session: "t",
            ..ctx
        };
        assert!(verify(&report(vec![48]), &wrong_session).is_err());
    }

    #[test]
    fn a_balanced_pedersen_claim_is_a_frame_and_is_refused() {
        use super::super::credentials::{pedersen_commit, random_scalar};
        let nonce = random_scalar();
        let commitment = pedersen_commit(1_000, &nonce);
        let report = |excess_fee| BlameReport {
            session: "s".into(),
            accused: key(1),
            code: BlameCode::PedersenUnbalanced,
            evidence: BlameEvidence::PedersenUnbalanced {
                amount_commitments: vec![commitment.clone()],
                pedersen_total_nonce: hex(&nonce.to_bytes()),
                excess_fee,
            },
        };
        let participants = vec![key(1), key(2)];
        let ctx = VerifyContext {
            session: "s",
            participants: &participants,
            feerate: None,
        };
        assert_eq!(
            verify(&report(1_000), &ctx),
            Err("pedersen actually balanced".into())
        );
        assert!(verify(&report(999), &ctx).is_ok());
    }

    #[test]
    fn signature_absence_never_names_anyone() {
        let participants = vec![key(1), key(2)];
        let report = BlameReport {
            session: "s".into(),
            accused: key(1),
            code: BlameCode::InvalidSignatureSet,
            evidence: BlameEvidence::InvalidSignatureSet {
                expected_outpoints: vec![],
                received_outpoints: vec![],
            },
        };
        let ctx = VerifyContext {
            session: "s",
            participants: &participants,
            feerate: None,
        };
        assert!(verify(&report, &ctx).is_err());
    }

    #[test]
    fn evidence_must_match_its_code() {
        let raw = serde_json::json!({"kind": "credential_slot_oob", "slots": [1], "participants": [key(1)]});
        assert!(parse_evidence(BlameCode::CredentialSlotOob, Some(&raw)).is_some());
        assert!(parse_evidence(BlameCode::DuplicateOutpoint, Some(&raw)).is_none());
    }
}
