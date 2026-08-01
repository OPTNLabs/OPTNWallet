// CashFusion blame-phase primitives, ported from Electron Cash fusion.py,
// validation.py, and util.py. This module deliberately contains no run-loop
// wiring or blockchain access.

use std::collections::HashSet;
use std::fmt;

use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::{Group, PrimeField};
use k256::{ProjectivePoint, Scalar};
use prost::Message;
use sha2::{Digest, Sha256};

use super::components::RoundCommit;
use super::{encrypt, pb, pedersen, schnorr};

pub const PROOF_PADDING_LENGTH: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlameError(String);

impl BlameError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for BlameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BlameError {}

/// A proof is only internally valid until an external blockchain service
/// confirms an input's outpoint, amount, script, and confirmation state.
#[derive(Debug, Clone, PartialEq)]
pub enum ValidatedProof {
    InternallyValidNonInput,
    InputNeedsBlockchainLookup(pb::InputComponent),
}

#[derive(Debug, Clone, PartialEq)]
pub struct InputLookupRequired {
    pub relayed_proof_index: usize,
    pub source_commitment_index: usize,
    pub input: pb::InputComponent,
    /// Retained so a failed external lookup can make the protocol-required
    /// session-key blame without decrypting the proof again.
    pub session_key: [u8; 32],
}

#[derive(Debug, Clone, PartialEq)]
pub struct RelayedProofReview {
    pub blames: pb::Blames,
    pub inputs_requiring_blockchain_lookup: Vec<InputLookupRequired>,
    pub internally_valid_non_inputs: usize,
}

impl InputLookupRequired {
    /// Convert a failed external input lookup into the blame message expected
    /// by the server. Callers must not use this for transport/lookup failures.
    pub fn blockchain_mismatch_blame(
        &self,
        reason: impl Into<String>,
    ) -> Result<pb::blames::BlameProof, BlameError> {
        Ok(pb::blames::BlameProof {
            which_proof: u32::try_from(self.relayed_proof_index)
                .map_err(|_| BlameError::new("relayed proof index exceeds uint32"))?,
            need_lookup_blockchain: Some(true),
            blame_reason: Some(format!(
                "input does not match blockchain: {}",
                reason.into()
            )),
            decrypter: Some(pb::blames::blame_proof::Decrypter::SessionKey(
                self.session_key.to_vec(),
            )),
        })
    }
}

/// Electron Cash `rand_position`: SHA256(seed || counter_be32), take the first
/// big-endian u64, then Lemire-map it uniformly into `[0, num_positions)`.
pub fn rand_position(seed: &[u8], num_positions: usize, counter: u32) -> Result<usize, BlameError> {
    if num_positions == 0 {
        return Err(BlameError::new("num_positions must be non-zero"));
    }
    let mut h = Sha256::new();
    h.update(seed);
    h.update(counter.to_be_bytes());
    let digest = h.finalize();
    let sample = u64::from_be_bytes(digest[..8].try_into().expect("eight bytes"));
    Ok(((sample as u128 * num_positions as u128) >> 64) as usize)
}

/// Reveal this player's proofs and route each one to the deterministic
/// non-owned commitment selected by the committed random number.
pub fn build_my_proofs_list(
    round_commit: &RoundCommit,
    all_commitments: &[Vec<u8>],
    my_commitment_indices: &[usize],
    my_component_indices: &[usize],
) -> Result<pb::MyProofsList, BlameError> {
    let count = round_commit.player_commit.initial_commitments.len();
    if count == 0
        || round_commit.components_sorted.len() != count
        || round_commit.proofs.len() != count
        || round_commit.communication_private_keys.len() != count
        || my_commitment_indices.len() != count
        || my_component_indices.len() != count
    {
        return Err(BlameError::new(
            "inconsistent local commitment state counts",
        ));
    }
    if round_commit.player_commit.random_number_commitment.len() != 32
        || sha256(&round_commit.random_number)
            != round_commit
                .player_commit
                .random_number_commitment
                .as_slice()
    {
        return Err(BlameError::new("random number does not match commitment"));
    }

    validate_unique_commitments(all_commitments)?;
    let mut mine = HashSet::with_capacity(count);
    for (local_idx, &global_idx) in my_commitment_indices.iter().enumerate() {
        if global_idx >= all_commitments.len() {
            return Err(BlameError::new("owned commitment index out of range"));
        }
        if !mine.insert(global_idx) {
            return Err(BlameError::new("duplicate owned commitment index"));
        }
        if all_commitments[global_idx] != round_commit.player_commit.initial_commitments[local_idx]
        {
            return Err(BlameError::new(
                "owned commitment index does not match local order",
            ));
        }
    }
    let mut owned_components = HashSet::with_capacity(count);
    for &global_idx in my_component_indices {
        if global_idx >= all_commitments.len() {
            return Err(BlameError::new("owned component index out of range"));
        }
        if !owned_components.insert(global_idx) {
            return Err(BlameError::new("duplicate owned component index"));
        }
    }

    let others: Vec<usize> = (0..all_commitments.len())
        .filter(|idx| !mine.contains(idx))
        .collect();
    if others.is_empty() {
        return Err(BlameError::new("cannot route proofs with no other player"));
    }

    let mut encrypted_proofs = Vec::with_capacity(count);
    for (local_idx, (&global_component_idx, &(salt, nonce))) in my_component_indices
        .iter()
        .zip(&round_commit.proofs)
        .enumerate()
    {
        let counter = u32::try_from(local_idx)
            .map_err(|_| BlameError::new("local proof index exceeds uint32"))?;
        let route = rand_position(&round_commit.random_number, others.len(), counter)?;
        let destination: pb::InitialCommitment =
            strict_decode(&all_commitments[others[route]], "destination commitment")?;
        validate_commitment(&destination)?;
        let component_idx = u32::try_from(global_component_idx)
            .map_err(|_| BlameError::new("component index exceeds uint32"))?;
        let proof = pb::Proof {
            component_idx,
            salt: salt.to_vec(),
            pedersen_nonce: nonce.to_vec(),
        };
        let encrypted = encrypt::encrypt(
            &proof.encode_to_vec(),
            &destination.communication_key,
            Some(PROOF_PADDING_LENGTH),
        )
        .map_err(|e| BlameError::new(format!("proof encryption failed: {e}")))?;
        encrypted_proofs.push(encrypted);
    }

    Ok(pb::MyProofsList {
        encrypted_proofs,
        random_number: round_commit.random_number.to_vec(),
    })
}

/// Strictly validate a decrypted proof and its committed component. An input
/// is returned as `InputNeedsBlockchainLookup`; this function never claims an
/// input is spendable or otherwise valid on chain.
pub fn validate_proof_internal(
    proof_blob: &[u8],
    commitment_blob: &[u8],
    all_components: &[Vec<u8>],
    bad_components: &[u32],
    component_feerate: u64,
) -> Result<ValidatedProof, BlameError> {
    let proof: pb::Proof = strict_decode(proof_blob, "proof")?;
    let commitment: pb::InitialCommitment = strict_decode(commitment_blob, "source commitment")?;
    validate_commitment(&commitment)?;
    validate_bad_components(bad_components, all_components.len())?;

    let component_idx = proof.component_idx as usize;
    let component_blob = all_components
        .get(component_idx)
        .ok_or_else(|| BlameError::new("component index out of range"))?;
    if bad_components.contains(&proof.component_idx) {
        return Err(BlameError::new("component in bad list"));
    }
    let component: pb::Component = strict_decode(component_blob, "component")?;
    validate_component(&component)?;

    if proof.salt.len() != 32 {
        return Err(BlameError::new("salt wrong length"));
    }
    if sha256(&proof.salt) != component.salt_commitment.as_slice() {
        return Err(BlameError::new("salt commitment mismatch"));
    }
    let mut salted = Sha256::new();
    salted.update(&proof.salt);
    salted.update(component_blob);
    if salted.finalize().as_slice() != commitment.salted_component_hash {
        return Err(BlameError::new("salted component hash mismatch"));
    }

    let nonce = parse_nonzero_scalar(&proof.pedersen_nonce, "pedersen nonce")?;
    let point = pedersen::h_point() * component_contribution(&component, component_feerate)?
        + ProjectivePoint::GENERATOR * nonce;
    if bool::from(point.is_identity()) {
        return Err(BlameError::new("pedersen commitment is point at infinity"));
    }
    let encoded = point.to_affine().to_encoded_point(false);
    if encoded.as_bytes() != commitment.amount_commitment {
        return Err(BlameError::new("pedersen commitment mismatch"));
    }

    match component.component {
        Some(pb::component::Component::Input(input)) => {
            Ok(ValidatedProof::InputNeedsBlockchainLookup(input))
        }
        Some(_) => Ok(ValidatedProof::InternallyValidNonInput),
        None => Err(BlameError::new("missing component details")),
    }
}

/// Decrypt and review the proofs relayed to this player. Internal proof errors
/// produce session-key blames; undecryptable ciphertext produces a private-key
/// blame. Valid inputs are returned for an external blockchain lookup.
pub fn review_relayed_proofs(
    round_commit: &RoundCommit,
    theirs: &pb::TheirProofsList,
    all_commitments: &[Vec<u8>],
    all_components: &[Vec<u8>],
    bad_components: &[u32],
    component_feerate: u64,
) -> Result<RelayedProofReview, BlameError> {
    validate_unique_commitments(all_commitments)?;
    validate_unique_blobs(all_components, "component")?;
    validate_bad_components(bad_components, all_components.len())?;

    let local_count = round_commit.player_commit.initial_commitments.len();
    if local_count == 0 || round_commit.communication_private_keys.len() != local_count {
        return Err(BlameError::new("inconsistent communication key count"));
    }
    let mut owned_global = HashSet::with_capacity(local_count);
    for (local_idx, local_blob) in round_commit
        .player_commit
        .initial_commitments
        .iter()
        .enumerate()
    {
        let global_idx = all_commitments
            .iter()
            .position(|blob| blob == local_blob)
            .ok_or_else(|| BlameError::new("local commitment absent from global list"))?;
        owned_global.insert(global_idx);
        let local_commit: pb::InitialCommitment = strict_decode(local_blob, "local commitment")?;
        validate_commitment(&local_commit)?;
        let scalar = parse_nonzero_scalar(
            &round_commit.communication_private_keys[local_idx],
            "communication private key",
        )?;
        if schnorr::compressed(&(ProjectivePoint::GENERATOR * scalar)).as_slice()
            != local_commit.communication_key
        {
            return Err(BlameError::new("communication private key mismatch"));
        }
    }
    if theirs.proofs.len() > all_commitments.len().saturating_sub(local_count) {
        return Err(BlameError::new("too many relayed proofs"));
    }

    let mut sources = HashSet::with_capacity(theirs.proofs.len());
    let mut blames = Vec::new();
    let mut inputs_requiring_blockchain_lookup = Vec::new();
    let mut internally_valid_non_inputs = 0usize;

    for (proof_index, relayed) in theirs.proofs.iter().enumerate() {
        let source_idx = relayed.src_commitment_idx as usize;
        if source_idx >= all_commitments.len() {
            return Err(BlameError::new("source commitment index out of range"));
        }
        if owned_global.contains(&source_idx) {
            return Err(BlameError::new("server relayed our own proof"));
        }
        if !sources.insert(source_idx) {
            return Err(BlameError::new("duplicate source commitment index"));
        }
        let destination_idx = relayed.dst_key_idx as usize;
        let private_bytes = round_commit
            .communication_private_keys
            .get(destination_idx)
            .ok_or_else(|| BlameError::new("destination key index out of range"))?;
        let private_scalar = parse_nonzero_scalar(private_bytes, "communication private key")?;
        let which_proof = u32::try_from(proof_index)
            .map_err(|_| BlameError::new("relayed proof index exceeds uint32"))?;

        let (proof_blob, session_key) =
            match decrypt_with_session_key(&relayed.encrypted_proof, private_scalar) {
                Ok(value) => value,
                Err(_) => {
                    blames.push(pb::blames::BlameProof {
                        which_proof,
                        need_lookup_blockchain: None,
                        blame_reason: Some("undecryptable".into()),
                        decrypter: Some(pb::blames::blame_proof::Decrypter::Privkey(
                            private_bytes.to_vec(),
                        )),
                    });
                    continue;
                }
            };

        match validate_proof_internal(
            &proof_blob,
            &all_commitments[source_idx],
            all_components,
            bad_components,
            component_feerate,
        ) {
            Ok(ValidatedProof::InternallyValidNonInput) => {
                internally_valid_non_inputs += 1;
            }
            Ok(ValidatedProof::InputNeedsBlockchainLookup(input)) => {
                inputs_requiring_blockchain_lookup.push(InputLookupRequired {
                    relayed_proof_index: proof_index,
                    source_commitment_index: source_idx,
                    input,
                    session_key,
                });
            }
            Err(error) => blames.push(pb::blames::BlameProof {
                which_proof,
                need_lookup_blockchain: None,
                blame_reason: Some(error.to_string()),
                decrypter: Some(pb::blames::blame_proof::Decrypter::SessionKey(
                    session_key.to_vec(),
                )),
            }),
        }
    }

    Ok(RelayedProofReview {
        blames: pb::Blames { blames },
        inputs_requiring_blockchain_lookup,
        internally_valid_non_inputs,
    })
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn strict_decode<M: Message + Default>(blob: &[u8], label: &str) -> Result<M, BlameError> {
    let message = M::decode(blob).map_err(|_| BlameError::new(format!("{label} decode error")))?;
    if message.encode_to_vec() != blob {
        return Err(BlameError::new(format!(
            "{label} has unknown, duplicate, or non-canonical fields"
        )));
    }
    Ok(message)
}

fn validate_unique_blobs(blobs: &[Vec<u8>], label: &str) -> Result<(), BlameError> {
    let mut seen = HashSet::with_capacity(blobs.len());
    if blobs.iter().any(|blob| !seen.insert(blob.as_slice())) {
        return Err(BlameError::new(format!("duplicate {label}")));
    }
    Ok(())
}

fn validate_unique_commitments(commitments: &[Vec<u8>]) -> Result<(), BlameError> {
    validate_unique_blobs(commitments, "commitment")?;
    for blob in commitments {
        let commitment: pb::InitialCommitment = strict_decode(blob, "commitment")?;
        validate_commitment(&commitment)?;
    }
    Ok(())
}

fn validate_bad_components(bad: &[u32], count: usize) -> Result<(), BlameError> {
    let mut seen = HashSet::with_capacity(bad.len());
    for &idx in bad {
        if idx as usize >= count {
            return Err(BlameError::new("bad-component index out of range"));
        }
        if !seen.insert(idx) {
            return Err(BlameError::new("duplicate bad-component index"));
        }
    }
    Ok(())
}

fn validate_commitment(commitment: &pb::InitialCommitment) -> Result<(), BlameError> {
    if commitment.salted_component_hash.len() != 32 {
        return Err(BlameError::new("bad salted component hash"));
    }
    if commitment.amount_commitment.len() != 65 || commitment.amount_commitment[0] != 4 {
        return Err(BlameError::new("bad amount commitment"));
    }
    schnorr::parse_point(&commitment.amount_commitment)
        .map_err(|_| BlameError::new("bad amount commitment"))?;
    if commitment.communication_key.len() != 33 || !matches!(commitment.communication_key[0], 2 | 3)
    {
        return Err(BlameError::new("bad communication key"));
    }
    schnorr::parse_point(&commitment.communication_key)
        .map_err(|_| BlameError::new("bad communication key"))?;
    Ok(())
}

fn validate_component(component: &pb::Component) -> Result<(), BlameError> {
    if component.salt_commitment.len() != 32 {
        return Err(BlameError::new("bad salt commitment"));
    }
    match component.component.as_ref() {
        Some(pb::component::Component::Input(input)) => {
            if input.prev_txid.len() != 32 {
                return Err(BlameError::new("bad input txid"));
            }
            let serialized_ok = (input.pubkey.len() == 33
                && matches!(input.pubkey.first(), Some(2 | 3)))
                || (input.pubkey.len() == 65 && input.pubkey.first() == Some(&4));
            if !serialized_ok || schnorr::parse_point(&input.pubkey).is_err() {
                return Err(BlameError::new("bad input pubkey"));
            }
        }
        Some(pb::component::Component::Output(_)) | Some(pb::component::Component::Blank(_)) => {}
        None => return Err(BlameError::new("missing component details")),
    }
    Ok(())
}

fn component_contribution(component: &pb::Component, feerate: u64) -> Result<Scalar, BlameError> {
    let fee = |size: usize| -> Result<u64, BlameError> {
        let numerator = (size as u128)
            .checked_mul(feerate as u128)
            .and_then(|v| v.checked_add(999))
            .ok_or_else(|| BlameError::new("component fee overflow"))?;
        u64::try_from(numerator / 1000).map_err(|_| BlameError::new("component fee overflow"))
    };
    match component.component.as_ref() {
        Some(pb::component::Component::Input(input)) => {
            Ok(Scalar::from(input.amount) - Scalar::from(fee(108 + input.pubkey.len())?))
        }
        Some(pb::component::Component::Output(output)) => {
            Ok(-Scalar::from(output.amount) - Scalar::from(fee(9 + output.scriptpubkey.len())?))
        }
        Some(pb::component::Component::Blank(_)) => Ok(Scalar::ZERO),
        None => Err(BlameError::new("missing component details")),
    }
}

fn parse_nonzero_scalar(bytes: &[u8], label: &str) -> Result<Scalar, BlameError> {
    let array: [u8; 32] = bytes
        .try_into()
        .map_err(|_| BlameError::new(format!("{label} wrong length")))?;
    let scalar = Option::<Scalar>::from(Scalar::from_repr(array.into()))
        .ok_or_else(|| BlameError::new(format!("{label} out of range")))?;
    if bool::from(scalar.is_zero()) {
        return Err(BlameError::new(format!("{label} is zero")));
    }
    Ok(scalar)
}

fn decrypt_with_session_key(
    ciphertext: &[u8],
    private_key: Scalar,
) -> Result<(Vec<u8>, [u8; 32]), String> {
    if ciphertext.len() < 33 {
        return Err("ciphertext too short".into());
    }
    let ephemeral = schnorr::parse_point(&ciphertext[..33])?;
    let shared = schnorr::compressed(&(ephemeral * private_key));
    let session_key: [u8; 32] = Sha256::digest(shared).into();
    let plaintext = encrypt::decrypt_with_symmkey(ciphertext, &session_key)?;
    Ok((plaintext, session_key))
}

#[cfg(test)]
mod tests {
    use super::super::components::{build_round_commit, FusionInput};
    use super::*;

    fn peer_fixture(input: bool) -> (Vec<u8>, Vec<u8>, pb::Proof) {
        let salt = [0x11; 32];
        let nonce = Scalar::from(7u64);
        let component = pb::Component {
            salt_commitment: sha256(&salt).to_vec(),
            component: Some(if input {
                pb::component::Component::Input(pb::InputComponent {
                    prev_txid: vec![0x22; 32],
                    prev_index: 3,
                    pubkey: schnorr::compressed(&(ProjectivePoint::GENERATOR * Scalar::from(9u64)))
                        .to_vec(),
                    amount: 50_000,
                })
            } else {
                pb::component::Component::Blank(pb::BlankComponent {})
            }),
        };
        let component_blob = component.encode_to_vec();
        let contribution = component_contribution(&component, 1000).unwrap();
        let amount_point = pedersen::h_point() * contribution + ProjectivePoint::GENERATOR * nonce;
        let communication_key =
            schnorr::compressed(&(ProjectivePoint::GENERATOR * Scalar::from(13u64)));
        let mut salted = Sha256::new();
        salted.update(salt);
        salted.update(&component_blob);
        let commitment = pb::InitialCommitment {
            salted_component_hash: salted.finalize().to_vec(),
            amount_commitment: amount_point
                .to_affine()
                .to_encoded_point(false)
                .as_bytes()
                .to_vec(),
            communication_key: communication_key.to_vec(),
        }
        .encode_to_vec();
        let proof = pb::Proof {
            component_idx: 0,
            salt: salt.to_vec(),
            pedersen_nonce: nonce.to_bytes().to_vec(),
        };
        (commitment, component_blob, proof)
    }

    fn local_round_commit() -> RoundCommit {
        let round_key = Scalar::from(3u64);
        let blind_nonce = Scalar::from(5u64);
        build_round_commit(
            &[FusionInput {
                prev_txid: "44".repeat(32),
                prev_index: 0,
                pubkey: schnorr::compressed(&(ProjectivePoint::GENERATOR * Scalar::from(17u64)))
                    .to_vec(),
                value: 100_000,
            }],
            &[],
            1,
            1000,
            &schnorr::compressed(&(ProjectivePoint::GENERATOR * round_key)),
            &[schnorr::compressed(&(ProjectivePoint::GENERATOR * blind_nonce)).to_vec()],
        )
        .unwrap()
    }

    #[test]
    fn random_routing_matches_reference_vectors() {
        assert_eq!(rand_position(b"seed", 17, 0).unwrap(), 3);
        assert_eq!(rand_position(b"seed", 17, 1).unwrap(), 7);
        assert_eq!(rand_position(b"seed", 17, 2).unwrap(), 0);
        assert_eq!(rand_position(&[0u8; 32], 1_000, 42).unwrap(), 646);
        assert!(rand_position(b"seed", 0, 0).is_err());
    }

    #[test]
    fn proof_list_uses_committed_seed_component_index_and_fixed_padding() {
        let local = local_round_commit();
        let (peer_commitment, _, _) = peer_fixture(false);
        let message = build_my_proofs_list(
            &local,
            &[
                local.player_commit.initial_commitments[0].clone(),
                peer_commitment,
            ],
            &[0],
            &[1],
        )
        .unwrap();
        assert_eq!(message.random_number, local.random_number);
        assert_eq!(
            message.encrypted_proofs[0].len(),
            33 + PROOF_PADDING_LENGTH + 16
        );
        let plaintext =
            encrypt::decrypt(&message.encrypted_proofs[0], Scalar::from(13u64)).unwrap();
        let proof: pb::Proof = strict_decode(&plaintext, "test proof").unwrap();
        // Commitments and components are independently shuffled by the server.
        // The revealed proof must identify the component mapping, not reuse the
        // unrelated commitment index.
        assert_eq!(proof.component_idx, 1);
        assert_eq!(proof.salt, local.proofs[0].0);
        assert_eq!(proof.pedersen_nonce, local.proofs[0].1);
    }

    #[test]
    fn validates_a_well_formed_internal_proof() {
        let (commitment, component, proof) = peer_fixture(false);
        assert_eq!(
            validate_proof_internal(&proof.encode_to_vec(), &commitment, &[component], &[], 1000)
                .unwrap(),
            ValidatedProof::InternallyValidNonInput
        );
    }

    #[test]
    fn rejects_tampered_salt() {
        let (commitment, component, mut proof) = peer_fixture(false);
        proof.salt[0] ^= 1;
        let error =
            validate_proof_internal(&proof.encode_to_vec(), &commitment, &[component], &[], 1000)
                .unwrap_err();
        assert!(error.to_string().contains("salt commitment mismatch"));
    }

    #[test]
    fn rejects_wrong_pedersen_nonce() {
        let (commitment, component, mut proof) = peer_fixture(false);
        proof.pedersen_nonce = Scalar::from(8u64).to_bytes().to_vec();
        let error =
            validate_proof_internal(&proof.encode_to_vec(), &commitment, &[component], &[], 1000)
                .unwrap_err();
        assert!(error.to_string().contains("pedersen commitment mismatch"));
    }

    #[test]
    fn undecryptable_relay_produces_private_key_blame() {
        let local = local_round_commit();
        let (peer_commitment, peer_component, _) = peer_fixture(false);
        let theirs = pb::TheirProofsList {
            proofs: vec![pb::their_proofs_list::RelayedProof {
                encrypted_proof: vec![0u8; 12],
                src_commitment_idx: 1,
                dst_key_idx: 0,
            }],
        };
        let review = review_relayed_proofs(
            &local,
            &theirs,
            &[
                local.player_commit.initial_commitments[0].clone(),
                peer_commitment,
            ],
            &[local.components_sorted[0].clone(), peer_component],
            &[],
            1000,
        )
        .unwrap();
        assert_eq!(review.blames.blames.len(), 1);
        assert!(matches!(
            review.blames.blames[0].decrypter,
            Some(pb::blames::blame_proof::Decrypter::Privkey(_))
        ));
    }

    #[test]
    fn valid_input_is_explicitly_returned_for_external_lookup() {
        let local = local_round_commit();
        let (peer_commitment, peer_component, mut proof) = peer_fixture(true);
        // A failed round may legitimately have fewer submitted components than
        // initial commitments; that is one reason the server enters blame.
        let missing_peer_commitment =
            local_round_commit().player_commit.initial_commitments[0].clone();
        proof.component_idx = 1;
        let encrypted = encrypt::encrypt(
            &proof.encode_to_vec(),
            &schnorr::compressed(
                &(ProjectivePoint::GENERATOR
                    * parse_nonzero_scalar(&local.communication_private_keys[0], "test key")
                        .unwrap()),
            ),
            Some(PROOF_PADDING_LENGTH),
        )
        .unwrap();
        let theirs = pb::TheirProofsList {
            proofs: vec![pb::their_proofs_list::RelayedProof {
                encrypted_proof: encrypted,
                src_commitment_idx: 1,
                dst_key_idx: 0,
            }],
        };
        let review = review_relayed_proofs(
            &local,
            &theirs,
            &[
                local.player_commit.initial_commitments[0].clone(),
                peer_commitment,
                missing_peer_commitment,
            ],
            &[local.components_sorted[0].clone(), peer_component],
            &[],
            1000,
        )
        .unwrap();
        assert!(review.blames.blames.is_empty());
        assert_eq!(review.inputs_requiring_blockchain_lookup.len(), 1);
        assert_eq!(
            review.inputs_requiring_blockchain_lookup[0].input.amount,
            50_000
        );
        let blame = review.inputs_requiring_blockchain_lookup[0]
            .blockchain_mismatch_blame("spent")
            .unwrap();
        assert_eq!(blame.need_lookup_blockchain, Some(true));
        assert!(matches!(
            blame.decrypter,
            Some(pb::blames::blame_proof::Decrypter::SessionKey(_))
        ));
    }

    #[test]
    fn internally_bad_decrypted_proof_uses_session_key_blame() {
        let local = local_round_commit();
        let (peer_commitment, peer_component, mut proof) = peer_fixture(false);
        proof.component_idx = 1;
        proof.salt[0] ^= 1;
        let local_commit: pb::InitialCommitment =
            strict_decode(&local.player_commit.initial_commitments[0], "local").unwrap();
        let encrypted = encrypt::encrypt(
            &proof.encode_to_vec(),
            &local_commit.communication_key,
            Some(PROOF_PADDING_LENGTH),
        )
        .unwrap();
        let theirs = pb::TheirProofsList {
            proofs: vec![pb::their_proofs_list::RelayedProof {
                encrypted_proof: encrypted,
                src_commitment_idx: 1,
                dst_key_idx: 0,
            }],
        };
        let review = review_relayed_proofs(
            &local,
            &theirs,
            &[
                local.player_commit.initial_commitments[0].clone(),
                peer_commitment,
            ],
            &[local.components_sorted[0].clone(), peer_component],
            &[],
            1000,
        )
        .unwrap();
        assert!(matches!(
            review.blames.blames[0].decrypter,
            Some(pb::blames::blame_proof::Decrypter::SessionKey(_))
        ));
        assert!(review.blames.blames[0]
            .blame_reason
            .as_deref()
            .unwrap()
            .contains("salt commitment mismatch"));
    }
}
