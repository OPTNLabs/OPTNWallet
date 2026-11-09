//! Credentials: the coordinator is the round's blind-Schnorr issuer, as a
//! fusion server is in classic CashFusion, and every component needs a
//! credential under the round key before it enters the CoinJoin
//! (`nostr/fusionBlindSchnorr.ts`, `nostr/fusionComponentV4.ts`,
//! `nostr/fusionPedersen.ts`, `nostr/fusionSession.ts`).
//!
//! A credential signs `sha256(serialized Electron Cash Component)`, salted by
//! a per-component commitment, so the coordinator authorizes exactly the
//! component it later sees without learning which peer sent it.

use std::collections::HashSet;

use k256::elliptic_curve::PrimeField;
use k256::Scalar;
use optn_core::fusion::{pedersen as core_pedersen, schnorr as core_schnorr};
use sha2::{Digest, Sha256};

use super::assemble::Contribution;
use super::wire::{AuthorizedOutput, ComponentCommitment, InputRef, OutputRef, SlotRequest};
use super::{fee_for_bytes, hex, random_bytes, unhex, unhex_array};
use crate::p2p_component::{encode_input_component, encode_output_component};

/// Nonce slots reserved per peer.
pub const CREDENTIAL_SLOTS_PER_PEER: usize = 24;
/// Most outputs one peer may contribute.
pub const MAX_OUTPUT_CREDENTIALS_PER_PEER: usize = 6;
/// Most inputs one peer may contribute.
pub const MAX_INPUT_CREDENTIALS_PER_PEER: usize =
    CREDENTIAL_SLOTS_PER_PEER - MAX_OUTPUT_CREDENTIALS_PER_PEER;

/// The first slot `peer` owns: peers sorted as strings, 24 slots each
/// (`peerCredentialSlotBase`).
pub fn peer_slot_base(participants: &[String], peer: &str) -> Option<usize> {
    let mut sorted: Vec<&str> = participants.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    sorted
        .iter()
        .position(|&key| key == peer)
        .map(|index| index * CREDENTIAL_SLOTS_PER_PEER)
}

pub fn total_slots(participants: usize) -> usize {
    participants * CREDENTIAL_SLOTS_PER_PEER
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// `sha256(salt)`, the Component's salt commitment.
pub fn salt_commitment(salt: &[u8; 32]) -> [u8; 32] {
    sha256(salt)
}

/// A fresh salt and its commitment.
pub fn fresh_salt() -> ([u8; 32], [u8; 32]) {
    let salt = random_bytes::<32>();
    (salt, salt_commitment(&salt))
}

/// Electron Cash's InitialCommitment hash, `sha256(salt || component)`.
pub fn salted_component_hash(salt: &[u8; 32], component: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(salt);
    hasher.update(component);
    hasher.finalize().into()
}

/// The serialized input Component. The txid arrives in display order and is
/// stored in wire order.
pub fn input_component(input: &InputRef, salt_commitment_hex: &str) -> Result<Vec<u8>, String> {
    let mut txid = unhex_array::<32>(&input.prev_txid).ok_or("prevTxid must be 32 bytes")?;
    txid.reverse();
    let pubkey = unhex(&input.pubkey).ok_or("pubkey is not hex")?;
    let salt = unhex_array::<32>(salt_commitment_hex).ok_or("saltCommitment must be 32 bytes")?;
    encode_input_component(&txid, input.prev_index, &pubkey, input.value, &salt)
}

/// The serialized output Component.
pub fn output_component(output: &OutputRef, salt_commitment_hex: &str) -> Result<Vec<u8>, String> {
    let script = unhex(&output.script).ok_or("script is not hex")?;
    let salt = unhex_array::<32>(salt_commitment_hex).ok_or("saltCommitment must be 32 bytes")?;
    encode_output_component(&script, output.value, &salt)
}

/// The message an input's credential signs (`inputCredentialMessageHash`).
pub fn input_credential_hash(
    input: &InputRef,
    salt_commitment_hex: &str,
) -> Result<[u8; 32], String> {
    Ok(sha256(&input_component(input, salt_commitment_hex)?))
}

/// The message an output's credential signs. The round context and serial
/// stay transport and nullifier data (`outputCredentialMessageHash`).
pub fn output_credential_hash(
    output: &OutputRef,
    salt_commitment_hex: &str,
) -> Result<[u8; 32], String> {
    Ok(sha256(&output_component(output, salt_commitment_hex)?))
}

/// An input pays its own size at the round's fee rate.
pub fn input_fee(input: &InputRef, feerate: u64) -> u64 {
    fee_for_bytes(108 + input.pubkey.len() as u64 / 2, feerate)
}

/// An output pays its own size too.
pub fn output_fee(output: &OutputRef, feerate: u64) -> u64 {
    fee_for_bytes(9 + output.script.len() as u64 / 2, feerate)
}

/// A non-zero canonical scalar from 32 bytes.
pub fn canonical_scalar(bytes: &[u8; 32]) -> Option<Scalar> {
    Option::<Scalar>::from(Scalar::from_repr((*bytes).into()))
        .filter(|scalar| !bool::from(scalar.is_zero()))
}

/// A fresh uniform non-zero scalar from the CSPRNG.
pub fn random_scalar() -> Scalar {
    loop {
        if let Some(scalar) = canonical_scalar(&random_bytes::<32>()) {
            return scalar;
        }
    }
}

/// `C = amount·H + nonce·G` as 65-byte uncompressed hex, for a signed
/// amount: an input commits `+value−fee`, an output `−(value+fee)`.
pub fn pedersen_commit(amount: i64, nonce: &Scalar) -> String {
    hex(&core_pedersen::encode_uncompressed(
        &core_pedersen::commit_point_signed(amount, nonce),
    ))
}

/// `Σ commitments == excess·H + total_nonce·G` (`pedersenBalanceHolds`).
/// Malformed points and nonces fail closed.
pub fn pedersen_balance_holds(
    commitments: &[String],
    excess_fee: u64,
    total_nonce_hex: &str,
) -> bool {
    if commitments.is_empty() {
        return false;
    }
    let Ok(excess) = i64::try_from(excess_fee) else {
        return false;
    };
    let mut sum = k256::ProjectivePoint::IDENTITY;
    for commitment in commitments {
        let Some(bytes) = unhex(commitment).filter(|bytes| bytes.len() == 65) else {
            return false;
        };
        let Ok(point) = core_schnorr::parse_point(&bytes) else {
            return false;
        };
        sum += point;
    }
    let Some(nonce) = unhex_array::<32>(total_nonce_hex).and_then(|bytes| canonical_scalar(&bytes))
    else {
        return false;
    };
    sum == core_pedersen::commit_point_signed(excess, &nonce)
}

/// One component's credential in progress: the blind request, kept so the
/// issuer's answer can be unblinded and checked.
pub struct Pending {
    request: core_schnorr::BlindSignatureRequest,
}

impl Pending {
    /// Unblind the issuer's scalar into the 64-byte credential, verifying it
    /// under the round key; an issuer that answered wrong is an error here.
    pub fn finalize(&self, s_hex: &str) -> Result<String, String> {
        let s = unhex_array::<32>(s_hex).ok_or("credential response is not 32-byte hex")?;
        Ok(hex(&self.request.finalize(&s, true)?))
    }
}

/// Everything one peer derives for its credential request
/// (`buildComponentCredentialRequests`).
pub struct CredentialPlan {
    pub requests: Vec<SlotRequest>,
    pub component_commitments: Vec<ComponentCommitment>,
    pub amount_commitments: Vec<String>,
    pub pedersen_total_nonce: String,
    pub excess_fee: u64,
    /// Parallel to `requests`: inputs first, then outputs.
    pub pending: Vec<Pending>,
    pub output_serials: Vec<String>,
    pub input_salt_commitments: Vec<String>,
    pub output_salt_commitments: Vec<String>,
}

fn blind_request(
    round_pubkey: &[u8],
    r_point_hex: &str,
    message: [u8; 32],
) -> Result<(core_schnorr::BlindSignatureRequest, [u8; 32]), String> {
    let r_point = unhex(r_point_hex).ok_or("blind nonce point is not hex")?;
    let request = core_schnorr::BlindSignatureRequest::new_with_blinding(
        round_pubkey,
        &r_point,
        message,
        random_scalar(),
        random_scalar(),
    )?;
    let e = request.request();
    Ok((request, e))
}

/// Build blind requests, Pedersen commitments and InitialCommitments for every
/// input and output this peer contributes, in its own slot range.
pub fn plan_credentials(
    contribution: &Contribution,
    participants: &[String],
    my_pubkey: &str,
    round_pubkey_hex: &str,
    blind_nonce_points: &[String],
    feerate: u64,
) -> Result<CredentialPlan, String> {
    let base = peer_slot_base(participants, my_pubkey).ok_or("peer not in participant set")?;
    let components = contribution.inputs.len() + contribution.outputs.len();
    if components > CREDENTIAL_SLOTS_PER_PEER {
        return Err(format!(
            "too many components for credential slots ({components} > {CREDENTIAL_SLOTS_PER_PEER})"
        ));
    }
    let round_pubkey = unhex(round_pubkey_hex).ok_or("round pubkey is not hex")?;
    let mut plan = CredentialPlan {
        requests: Vec::with_capacity(components),
        component_commitments: Vec::with_capacity(components),
        amount_commitments: Vec::with_capacity(components),
        pedersen_total_nonce: String::new(),
        excess_fee: 0,
        pending: Vec::with_capacity(components),
        output_serials: Vec::new(),
        input_salt_commitments: Vec::new(),
        output_salt_commitments: Vec::new(),
    };
    let mut excess: i128 = 0;
    let mut nonce_total = Scalar::ZERO;
    let mut add = |plan: &mut CredentialPlan,
                   index: usize,
                   salt: [u8; 32],
                   component: Vec<u8>,
                   message: [u8; 32],
                   amount: i64|
     -> Result<(), String> {
        let r_point = blind_nonce_points
            .get(index)
            .ok_or_else(|| format!("missing blind nonce point at slot {index}"))?;
        let (request, e) = blind_request(&round_pubkey, r_point, message)?;
        let nonce = random_scalar();
        let commitment = pedersen_commit(amount, &nonce);
        nonce_total += nonce;
        excess += i128::from(amount);
        let index = u32::try_from(index).map_err(|_| "slot index overflow")?;
        plan.requests.push(SlotRequest { index, e: hex(&e) });
        plan.component_commitments.push(ComponentCommitment {
            index,
            salted_component_hash: hex(&salted_component_hash(&salt, &component)),
            amount_commitment: commitment.clone(),
        });
        plan.amount_commitments.push(commitment);
        plan.pending.push(Pending { request });
        Ok(())
    };
    for (i, input) in contribution.inputs.iter().enumerate() {
        let (salt, commitment) = fresh_salt();
        let commitment = hex(&commitment);
        let component = input_component(input, &commitment)?;
        let amount = i64::try_from(input.value).map_err(|_| "input value overflow")?
            - i64::try_from(input_fee(input, feerate)).map_err(|_| "fee overflow")?;
        let message = sha256(&component);
        add(&mut plan, base + i, salt, component, message, amount)?;
        plan.input_salt_commitments.push(commitment);
    }
    for (i, output) in contribution.outputs.iter().enumerate() {
        let (salt, commitment) = fresh_salt();
        let commitment = hex(&commitment);
        let component = output_component(output, &commitment)?;
        let amount = -(i64::try_from(output.value).map_err(|_| "output value overflow")?
            + i64::try_from(output_fee(output, feerate)).map_err(|_| "fee overflow")?);
        let message = sha256(&component);
        add(
            &mut plan,
            base + contribution.inputs.len() + i,
            salt,
            component,
            message,
            amount,
        )?;
        plan.output_serials.push(hex(&random_bytes::<32>()));
        plan.output_salt_commitments.push(commitment);
    }
    if excess < 0 {
        return Err("pedersen excess fee is negative — outputs+fees exceed inputs".into());
    }
    plan.excess_fee = u64::try_from(excess).map_err(|_| "excess fee overflow")?;
    plan.pedersen_total_nonce = hex(&nonce_total.to_bytes());
    Ok(plan)
}

/// The coordinator's issuer: a round key and one nonce per slot, each usable
/// once. Reusing a nonce on two challenges would leak the round key, so a
/// second use is a hard error, never a re-sign.
pub struct Issuer {
    inner: core_schnorr::BlindIssuer,
    pub pubkey_hex: String,
    pub r_points_hex: Vec<String>,
}

impl Issuer {
    pub fn create(slots: usize) -> Result<Self, String> {
        if !(1..=1024).contains(&slots) {
            return Err("BlindIssuer needs 1..1024 nonce slots".into());
        }
        let inner = core_schnorr::BlindIssuer::from_parts(
            random_scalar(),
            (0..slots).map(|_| random_scalar()).collect(),
        )?;
        let pubkey_hex = hex(&inner.pubkey());
        let r_points_hex = inner
            .r_points()
            .into_iter()
            .map(|point| {
                point
                    .map(|point| hex(&point))
                    .ok_or("fresh issuer slot missing")
            })
            .collect::<Result<_, _>>()?;
        Ok(Self {
            inner,
            pubkey_hex,
            r_points_hex,
        })
    }

    /// Sign the blinded challenge at `index`, consuming that slot.
    pub fn sign(&mut self, index: u32, e_hex: &str) -> Result<String, String> {
        let e = unhex_array::<32>(e_hex).ok_or("blinded challenge must be 32 bytes")?;
        Ok(hex(&self.inner.sign(index as usize, &e)?))
    }
}

/// Verify a BCH Schnorr signature given as hex. Malformed input is `false`.
pub fn verify_schnorr_hex(pubkey_hex: &str, sig_hex: &str, message: &[u8; 32]) -> bool {
    match (unhex(pubkey_hex), unhex_array::<64>(sig_hex)) {
        (Some(pubkey), Some(sig)) => core_schnorr::verify(&pubkey, &sig, message),
        _ => false,
    }
}

/// Check the last peeler's reveal before assembly
/// (`verifyAuthorizedOutputBatch`): exactly the declared count, every output
/// distinct, every credential valid under the round key. The serials on
/// success, for the nullifier record.
pub fn verify_output_batch(
    outputs: &[AuthorizedOutput],
    expected: usize,
    issuer_pubkey_hex: &str,
) -> Result<Vec<String>, String> {
    if outputs.len() != expected || expected < 1 {
        return Err("output credential quota mismatch".into());
    }
    let mut serials = HashSet::new();
    let mut outputs_seen = HashSet::new();
    let mut hashes = HashSet::new();
    let mut ordered = Vec::with_capacity(outputs.len());
    for output in outputs {
        if super::onion::encode_authorized_output(output).is_err()
            || output.script.len() > super::wire::MAX_SCRIPT_HEX_CHARS
        {
            return Err("malformed authorized output".into());
        }
        let serial = output.credential_serial.to_ascii_lowercase();
        let id = format!("{}:{}", output.value, output.script.to_ascii_lowercase());
        let message = output_credential_hash(&output.output(), &output.salt_commitment)
            .map_err(|_| "malformed authorized output".to_string())?;
        if serials.contains(&serial) || outputs_seen.contains(&id) || hashes.contains(&message) {
            return Err("duplicate output credential or output".into());
        }
        if !verify_schnorr_hex(issuer_pubkey_hex, &output.credential_sig, &message) {
            return Err("invalid output credential".into());
        }
        serials.insert(serial.clone());
        outputs_seen.insert(id);
        hashes.insert(message);
        ordered.push(serial);
    }
    Ok(ordered)
}

/// Re-derive a blinded request from its `a || b` opening and compare it with
/// the one the issuer received (`verifyCredentialOpening`). Proves which slot
/// an anonymous component used without the issuer having been able to link
/// them at the time.
pub fn opening_matches(
    round_pubkey_hex: &str,
    r_point_hex: &str,
    message: [u8; 32],
    opening_hex: &str,
    request_hex: &str,
) -> bool {
    let (Some(round_pubkey), Some(r_point), Some(opening), Some(expected)) = (
        unhex(round_pubkey_hex),
        unhex(r_point_hex),
        unhex_array::<64>(opening_hex),
        unhex_array::<32>(request_hex),
    ) else {
        return false;
    };
    let (Some(a), Some(b)) = (
        canonical_scalar(opening[..32].try_into().expect("32 bytes")),
        canonical_scalar(opening[32..].try_into().expect("32 bytes")),
    ) else {
        return false;
    };
    core_schnorr::BlindSignatureRequest::new_with_blinding(&round_pubkey, &r_point, message, a, b)
        .map(|request| request.request() == expected)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> String {
        hex(&[byte; 32])
    }

    fn contribution() -> Contribution {
        let pubkey = hex(&core_schnorr::pubkey_compressed(Scalar::from(5u64)));
        Contribution {
            inputs: vec![InputRef {
                prev_txid: key(0xab),
                prev_index: 1,
                value: 200_000,
                pubkey,
            }],
            outputs: vec![
                OutputRef {
                    script: format!("76a914{}88ac", "11".repeat(20)),
                    value: 120_000,
                },
                OutputRef {
                    script: format!("76a914{}88ac", "22".repeat(20)),
                    value: 79_000,
                },
            ],
        }
    }

    #[test]
    fn slots_follow_the_sorted_participant_order() {
        let participants = vec![key(3), key(1), key(2)];
        assert_eq!(peer_slot_base(&participants, &key(1)), Some(0));
        assert_eq!(peer_slot_base(&participants, &key(3)), Some(48));
        assert_eq!(peer_slot_base(&participants, &key(9)), None);
    }

    #[test]
    fn a_full_credential_round_trip_balances_and_verifies() {
        let participants = vec![key(1), key(2), key(3)];
        let mut issuer = Issuer::create(total_slots(participants.len())).unwrap();
        let mine = contribution();
        let plan = plan_credentials(
            &mine,
            &participants,
            &key(2),
            &issuer.pubkey_hex,
            &issuer.r_points_hex,
            1_000,
        )
        .unwrap();
        assert_eq!(plan.requests[0].index, 24, "peer 2 of 3 starts at slot 24");
        assert!(pedersen_balance_holds(
            &plan.amount_commitments,
            plan.excess_fee,
            &plan.pedersen_total_nonce
        ));
        assert!(!pedersen_balance_holds(
            &plan.amount_commitments,
            plan.excess_fee + 1,
            &plan.pedersen_total_nonce
        ));
        let credentials: Vec<String> = plan
            .requests
            .iter()
            .zip(&plan.pending)
            .map(|(request, pending)| {
                pending
                    .finalize(&issuer.sign(request.index, &request.e).unwrap())
                    .unwrap()
            })
            .collect();
        let message =
            input_credential_hash(&mine.inputs[0], &plan.input_salt_commitments[0]).unwrap();
        assert!(verify_schnorr_hex(
            &issuer.pubkey_hex,
            &credentials[0],
            &message
        ));
        assert!(
            issuer
                .sign(plan.requests[0].index, &plan.requests[0].e)
                .is_err(),
            "a slot signs once"
        );

        let outputs: Vec<AuthorizedOutput> = mine
            .outputs
            .iter()
            .enumerate()
            .map(|(i, output)| AuthorizedOutput {
                script: output.script.clone(),
                value: output.value,
                credential_serial: plan.output_serials[i].clone(),
                credential_sig: credentials[1 + i].clone(),
                salt_commitment: plan.output_salt_commitments[i].clone(),
            })
            .collect();
        assert_eq!(
            verify_output_batch(&outputs, 2, &issuer.pubkey_hex)
                .unwrap()
                .len(),
            2
        );
        assert!(verify_output_batch(&outputs, 3, &issuer.pubkey_hex).is_err());
        let mut forged = outputs.clone();
        forged[0].value += 1;
        assert!(verify_output_batch(&forged, 2, &issuer.pubkey_hex).is_err());
    }

    #[test]
    fn outputs_beyond_the_inputs_are_refused_before_any_request() {
        let mut greedy = contribution();
        greedy.outputs[0].value = 500_000;
        let issuer = Issuer::create(3 * CREDENTIAL_SLOTS_PER_PEER).unwrap();
        assert!(plan_credentials(
            &greedy,
            &[key(1), key(2), key(3)],
            &key(1),
            &issuer.pubkey_hex,
            &issuer.r_points_hex,
            1_000
        )
        .is_err());
    }
}
