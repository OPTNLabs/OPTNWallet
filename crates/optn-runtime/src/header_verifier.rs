//! Provider-neutral SHV/MMR header verifier for issue #75.

use crate::chain::{
    BlockHeaderBytes, CheckpointProvenance, Hash32, HeaderAccumulatorState, HeaderCheckpoint,
    HeaderVerificationMode, HeaderVerifier, HistoricalHeaderProof,
};
use optn_core::network::Network;
use optn_core::{
    asert::{
        verify_header_extension, AsertAnchor, AsertCheck, AsertError, AsertParams,
        HeaderExtensionError,
    },
    header_hash::sha256d,
    header_mmr::MmrAccumulator,
    header_pow::{verify_declared_pow, HeaderPowError},
};
use serde::{Deserialize, Serialize};

const MAX_CHECKPOINT_BYTES: usize = 16 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredCheckpoint {
    schema: u32,
    network: String,
    height: u32,
    commitment: Hash32,
    header: Vec<u8>,
    proof: Vec<Hash32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShvMmrError {
    InvalidCheckpointProof,
    CheckpointCommitmentMismatch { expected: Hash32, actual: Hash32 },
    Header(HeaderPowError),
    Difficulty(AsertError),
    HistoricalTargetMismatch { expected: Hash32, actual: Hash32 },
    HistoricalProofInvalid,
    HeightOverflow,
    EmptyAccumulator,
    InvalidStoredCheckpoint,
    StoredCheckpointTooLarge,
    StoredCheckpointNetworkMismatch,
    StoredCheckpointTrustMismatch,
}

impl From<HeaderPowError> for ShvMmrError {
    fn from(value: HeaderPowError) -> Self {
        Self::Header(value)
    }
}

impl From<AsertError> for ShvMmrError {
    fn from(value: AsertError) -> Self {
        Self::Difficulty(value)
    }
}

impl From<HeaderExtensionError> for ShvMmrError {
    fn from(value: HeaderExtensionError) -> Self {
        match value {
            HeaderExtensionError::Pow(error) => Self::Header(error),
            HeaderExtensionError::Difficulty(error) => Self::Difficulty(error),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct DifficultyContext {
    params: AsertParams,
    anchor: AsertAnchor,
}

/// Minimal client-side verified header state: MMR peaks plus the latest hash
/// and timestamp needed to validate linkage and expected BCH difficulty for
/// extension. Historical full headers can be pruned outside the separately
/// configured reorg window.
#[derive(Debug, Clone)]
pub struct ShvMmrHeaderVerifier {
    accumulator: MmrAccumulator,
    provenance: CheckpointProvenance,
    last_hash: Option<Hash32>,
    last_time: Option<u32>,
    last_header: Option<BlockHeaderBytes>,
    last_leaf_proof: Vec<Hash32>,
    difficulty: Option<DifficultyContext>,
}

impl ShvMmrHeaderVerifier {
    pub fn empty(provenance: CheckpointProvenance) -> Self {
        Self {
            accumulator: MmrAccumulator::new(),
            provenance,
            last_hash: None,
            last_time: None,
            last_header: None,
            last_leaf_proof: Vec::new(),
            difficulty: None,
        }
    }

    /// Bootstrap from an already trusted checkpoint commitment and a proof for
    /// the checkpoint header (the last leaf at `checkpoint_height`).
    ///
    /// The standard Electrum checkpoint branch is valid bootstrap material for
    /// the MMR accumulator after its root is checked against the trusted
    /// commitment. ASERT validation is applied to every locally extended header
    /// once [`with_asert`] supplies the network anchor/parameters.
    pub fn from_checkpoint_proof(
        checkpoint_height: u32,
        checkpoint_header: BlockHeaderBytes,
        proof: &[Hash32],
        trusted_commitment: Hash32,
        provenance: CheckpointProvenance,
    ) -> Result<Self, ShvMmrError> {
        let parsed = verify_declared_pow(&checkpoint_header.0)?;
        let leaf_count = u64::from(checkpoint_height) + 1;
        let accumulator =
            MmrAccumulator::bootstrap_from_last_leaf_proof(leaf_count, parsed.hash, proof)
                .ok_or(ShvMmrError::InvalidCheckpointProof)?;
        let actual = accumulator.root();
        if actual != trusted_commitment {
            return Err(ShvMmrError::CheckpointCommitmentMismatch {
                expected: trusted_commitment,
                actual,
            });
        }

        Ok(Self {
            accumulator,
            provenance,
            last_hash: Some(parsed.hash),
            last_time: Some(parsed.time),
            last_header: Some(checkpoint_header),
            last_leaf_proof: proof.to_vec(),
            difficulty: None,
        })
    }

    /// Enable expected-difficulty validation for all future extensions.
    ///
    /// This does not retroactively reinterpret a trusted checkpoint: the
    /// checkpoint's provenance/root establishes the historical commitment. From
    /// this point onward, every appended header must both satisfy its own target
    /// and declare the ASERT-expected `nBits` for the supplied network anchor.
    pub fn with_asert(mut self, params: AsertParams, anchor: AsertAnchor) -> Self {
        self.difficulty = Some(DifficultyContext { params, anchor });
        self
    }

    pub fn accumulator(&self) -> &MmrAccumulator {
        &self.accumulator
    }

    pub fn state(&self) -> Result<HeaderAccumulatorState, ShvMmrError> {
        let height = self
            .accumulator
            .leaf_count()
            .checked_sub(1)
            .ok_or(ShvMmrError::EmptyAccumulator)?;
        let height = u32::try_from(height).map_err(|_| ShvMmrError::HeightOverflow)?;
        Ok(HeaderAccumulatorState {
            height,
            peaks: self.accumulator.peaks().to_vec(),
            commitment: self.accumulator.root(),
        })
    }

    pub fn last_hash(&self) -> Option<Hash32> {
        self.last_hash
    }

    pub fn last_time(&self) -> Option<u32> {
        self.last_time
    }

    pub fn has_difficulty_context(&self) -> bool {
        self.difficulty.is_some()
    }

    /// Material for restoring this verified tip with `from_checkpoint_proof`.
    /// The host must separately authenticate the root and bind it to a network;
    /// a proof fetched alongside an untrusted root does not establish trust.
    pub fn tip_checkpoint_proof(&self) -> Option<(&BlockHeaderBytes, &[Hash32])> {
        Some((self.last_header.as_ref()?, &self.last_leaf_proof))
    }

    /// Encode public resume material. The host separately persists the trusted
    /// checkpoint commitment through its authenticated storage provider.
    pub fn encode_checkpoint_json(&self, network: Network) -> Result<String, ShvMmrError> {
        let state = self.state()?;
        let (header, proof) = self
            .tip_checkpoint_proof()
            .ok_or(ShvMmrError::EmptyAccumulator)?;
        let record = StoredCheckpoint {
            schema: 1,
            network: network.to_string(),
            height: state.height,
            commitment: state.commitment,
            header: header.0.to_vec(),
            proof: proof.to_vec(),
        };
        serde_json::to_string(&record).map_err(|_| ShvMmrError::InvalidStoredCheckpoint)
    }

    /// Restore against an independently trusted, network-scoped commitment.
    /// Never obtain `trusted` from the same unauthenticated file or peer.
    /// Difficulty rules are deliberately absent from the record: the host
    /// must attach the selected network's context with `with_asert`.
    pub fn from_checkpoint_json(
        json: &str,
        network: Network,
        trusted: &HeaderCheckpoint,
    ) -> Result<Self, ShvMmrError> {
        if json.len() > MAX_CHECKPOINT_BYTES {
            return Err(ShvMmrError::StoredCheckpointTooLarge);
        }
        let record: StoredCheckpoint =
            serde_json::from_str(json).map_err(|_| ShvMmrError::InvalidStoredCheckpoint)?;
        if record.schema != 1 || record.proof.len() > 32 {
            return Err(ShvMmrError::InvalidStoredCheckpoint);
        }
        if record.network != network.to_string() {
            return Err(ShvMmrError::StoredCheckpointNetworkMismatch);
        }
        if record.height != trusted.height || record.commitment != trusted.commitment {
            return Err(ShvMmrError::StoredCheckpointTrustMismatch);
        }
        let header = BlockHeaderBytes(
            record
                .header
                .try_into()
                .map_err(|_| ShvMmrError::InvalidStoredCheckpoint)?,
        );
        Self::from_checkpoint_proof(
            record.height,
            header,
            &record.proof,
            trusted.commitment,
            trusted.provenance.clone(),
        )
    }
}

impl HeaderVerifier for ShvMmrHeaderVerifier {
    type Error = ShvMmrError;

    fn mode(&self) -> HeaderVerificationMode {
        HeaderVerificationMode::ShvMmr
    }

    fn extend(&mut self, headers: &[BlockHeaderBytes]) -> Result<(), Self::Error> {
        // A rejected peer batch must not advance the trusted cursor or MMR.
        // Only peaks and the current header context are cloned, not history.
        let mut candidate = self.clone();
        for header in headers {
            let parsed = match candidate.last_hash {
                Some(expected_prev) => {
                    let previous_height = candidate
                        .accumulator
                        .leaf_count()
                        .checked_sub(1)
                        .ok_or(ShvMmrError::EmptyAccumulator)?;
                    let previous_height =
                        u32::try_from(previous_height).map_err(|_| ShvMmrError::HeightOverflow)?;
                    let difficulty = match (candidate.difficulty, candidate.last_time) {
                        (Some(context), Some(previous_time)) => Some(AsertCheck {
                            params: context.params,
                            anchor: context.anchor,
                            previous_height,
                            previous_time: i64::from(previous_time),
                        }),
                        _ => None,
                    };
                    verify_header_extension(expected_prev, &header.0, difficulty)?
                }
                None => verify_declared_pow(&header.0)?,
            };
            candidate.last_leaf_proof = candidate.accumulator.proof_for_next_leaf(parsed.hash);
            candidate.accumulator.extend(parsed.hash);
            candidate.last_header = Some(header.clone());
            candidate.last_hash = Some(parsed.hash);
            candidate.last_time = Some(parsed.time);
        }
        *self = candidate;
        Ok(())
    }

    fn verify_historical(&self, proof: &HistoricalHeaderProof) -> Result<(), Self::Error> {
        let expected = self.accumulator.root();
        if proof.target != expected {
            return Err(ShvMmrError::HistoricalTargetMismatch {
                expected,
                actual: proof.target,
            });
        }
        let parsed = verify_declared_pow(&proof.header.0)?;
        if !self.accumulator.verify_proof_to_root(
            u64::from(proof.height),
            parsed.hash,
            &proof.proof,
        ) {
            return Err(ShvMmrError::HistoricalProofInvalid);
        }
        Ok(())
    }

    fn checkpoint(&self) -> HeaderCheckpoint {
        let height = self
            .accumulator
            .leaf_count()
            .saturating_sub(1)
            .min(u64::from(u32::MAX)) as u32;
        HeaderCheckpoint {
            height,
            commitment: self.accumulator.root(),
            provenance: self.provenance.clone(),
        }
    }
}

/// Compute the MMR leaf for a serialized BCH header. Kept here as a small
/// helper for providers that already established stronger header validity.
pub fn header_leaf(header: &BlockHeaderBytes) -> Hash32 {
    sha256d(&header.0)
}

/// Chipnet / testnet4 genesis header (BCHN `CreateGenesisBlock`).
///
/// Hash `000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b`.
/// This is independently reviewed chain identity, not an Electrum server tip.
pub const CHIPNET_GENESIS_HEADER_HEX: &str = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4af1a93c5fffff001d01d3cd06";

fn decode_header_hex(hex: &str) -> BlockHeaderBytes {
    let mut header = [0u8; 80];
    for i in 0..80 {
        header[i] =
            u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("shipped header hex is valid");
    }
    BlockHeaderBytes(header)
}

/// Regtest genesis header (BCHN `CreateGenesisBlock`, regtest parameters).
///
/// Hash `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`,
/// confirmed against a live BCHD regtest node's reported chain state. Version
/// 1, nTime 1296688602, nBits 0x207fffff, nonce 2.
pub const REGTEST_GENESIS_HEADER_HEX: &str = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000";

/// A verifier anchored at the regtest genesis.
///
/// The same shape as the Chipnet one and for the same reason: an accumulator
/// numbers its leaves by height, so a sync that starts anywhere other than the
/// next leaf silently mis-attributes every header it is given. Anchoring at
/// genesis is what makes "extend with heights 1..N" mean what it says.
///
/// Regtest's difficulty context says the chain does not retarget, so ASERT has
/// nothing to assert here -- but declared proof-of-work and linkage are still
/// checked on every header.
pub fn regtest_header_verifier() -> Result<ShvMmrHeaderVerifier, ShvMmrError> {
    let header = decode_header_hex(REGTEST_GENESIS_HEADER_HEX);
    let commitment = header_leaf(&header);
    Ok(ShvMmrHeaderVerifier::from_checkpoint_proof(
        0,
        header,
        &[],
        commitment,
        CheckpointProvenance::SelfDerived,
    )?
    .with_asert(
        AsertParams::for_network(Network::Regtest),
        AsertAnchor::for_network(Network::Regtest),
    ))
}

/// Trusted Chipnet checkpoint at height 0 plus Chipnet ASERT context.
///
/// BIP37/Neutrino workers must attach this (or a later host-authenticated
/// checkpoint) before publishing balances. Electrum first-paint stays
/// `ServerAssertion` and must not be labeled MMR.
pub fn shipped_chipnet_header_verifier() -> Result<ShvMmrHeaderVerifier, ShvMmrError> {
    let header = decode_header_hex(CHIPNET_GENESIS_HEADER_HEX);
    let commitment = header_leaf(&header);
    Ok(ShvMmrHeaderVerifier::from_checkpoint_proof(
        0,
        header,
        &[],
        commitment,
        CheckpointProvenance::ShippedReviewed,
    )?
    .with_asert(
        AsertParams::for_network(Network::Chipnet),
        AsertAnchor::for_network(Network::Chipnet),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn genesis() -> BlockHeaderBytes {
        let hex = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>();
        BlockHeaderBytes(bytes.try_into().unwrap())
    }

    #[test]
    fn rejected_batch_preserves_accumulator_and_header_cursor() {
        let mut verifier = ShvMmrHeaderVerifier::empty(CheckpointProvenance::ShippedReviewed);
        let before = verifier.checkpoint();
        // The first header is valid; the second cannot link to it.
        assert!(verifier.extend(&[genesis(), genesis()]).is_err());
        assert_eq!(verifier.checkpoint(), before);
        assert_eq!(verifier.last_hash(), None);
        assert_eq!(verifier.last_time(), None);
        assert_eq!(verifier.state(), Err(ShvMmrError::EmptyAccumulator));
        verifier.extend(&[genesis()]).unwrap();
        let accepted = verifier.state().unwrap();
        assert!(verifier.extend(&[genesis()]).is_err());
        assert_eq!(verifier.state().unwrap(), accepted);
    }

    #[test]
    fn one_leaf_checkpoint_bootstraps_and_round_trips() {
        let header = genesis();
        let commitment = header_leaf(&header);
        let verifier = ShvMmrHeaderVerifier::from_checkpoint_proof(
            0,
            header,
            &[],
            commitment,
            CheckpointProvenance::ShippedReviewed,
        )
        .unwrap();
        assert_eq!(verifier.checkpoint().height, 0);
        assert_eq!(verifier.checkpoint().commitment, commitment);
        assert_eq!(verifier.state().unwrap().peaks.len(), 1);
        assert_eq!(verifier.last_time(), Some(1_231_006_505));
    }

    #[test]
    fn persisted_checkpoint_requires_matching_network_trust_and_header_proof() {
        let mut verifier = ShvMmrHeaderVerifier::empty(CheckpointProvenance::SelfDerived);
        verifier.extend(&[genesis()]).unwrap();
        let trusted = verifier.checkpoint();
        let json = verifier.encode_checkpoint_json(Network::Mainnet).unwrap();
        let restored =
            ShvMmrHeaderVerifier::from_checkpoint_json(&json, Network::Mainnet, &trusted).unwrap();
        assert_eq!(restored.state(), verifier.state());
        assert_eq!(restored.last_time(), verifier.last_time());
        assert!(!restored.has_difficulty_context());
        assert!(matches!(
            ShvMmrHeaderVerifier::from_checkpoint_json(&json, Network::Chipnet, &trusted),
            Err(ShvMmrError::StoredCheckpointNetworkMismatch)
        ));
        let mut wrong_trust = trusted.clone();
        wrong_trust.commitment[0] ^= 1;
        assert!(matches!(
            ShvMmrHeaderVerifier::from_checkpoint_json(&json, Network::Mainnet, &wrong_trust),
            Err(ShvMmrError::StoredCheckpointTrustMismatch)
        ));
        let mut record: StoredCheckpoint = serde_json::from_str(&json).unwrap();
        record.header[68] ^= 1;
        let corrupt = serde_json::to_string(&record).unwrap();
        assert!(
            ShvMmrHeaderVerifier::from_checkpoint_json(&corrupt, Network::Mainnet, &trusted)
                .is_err()
        );
        assert!(matches!(
            ShvMmrHeaderVerifier::from_checkpoint_json(
                &" ".repeat(MAX_CHECKPOINT_BYTES + 1),
                Network::Mainnet,
                &trusted
            ),
            Err(ShvMmrError::StoredCheckpointTooLarge)
        ));
        record.schema = 2;
        assert!(matches!(
            ShvMmrHeaderVerifier::from_checkpoint_json(
                &serde_json::to_string(&record).unwrap(),
                Network::Mainnet,
                &trusted
            ),
            Err(ShvMmrError::InvalidStoredCheckpoint)
        ));
    }

    #[test]
    fn shipped_chipnet_checkpoint_has_asert_and_known_genesis_hash() {
        let verifier = shipped_chipnet_header_verifier().unwrap();
        assert!(verifier.has_difficulty_context());
        assert_eq!(verifier.checkpoint().height, 0);
        assert_eq!(
            verifier.checkpoint().provenance,
            CheckpointProvenance::ShippedReviewed
        );
        let expected = [
            0x7b, 0x9f, 0xfd, 0x44, 0xdd, 0x73, 0xc0, 0x5f, 0x2a, 0x15, 0xd3, 0x74, 0x74, 0x79,
            0xcc, 0x18, 0x17, 0x75, 0x26, 0xce, 0x68, 0x86, 0x78, 0x9a, 0xc4, 0x10, 0xd4, 0x1d, 0,
            0, 0, 0,
        ];
        assert_eq!(verifier.last_hash(), Some(expected));
        assert_eq!(verifier.checkpoint().commitment, expected);
        crate::sync_worker::ProgressiveSyncWorker::new(Default::default())
            .with_header_verifier(Network::Chipnet, verifier)
            .expect("genesis plus ASERT is enough to enable verified P2P sync");
    }

    #[test]
    fn mismatched_checkpoint_commitment_fails_closed() {
        let err = ShvMmrHeaderVerifier::from_checkpoint_proof(
            0,
            genesis(),
            &[],
            [9; 32],
            CheckpointProvenance::ShippedReviewed,
        )
        .unwrap_err();
        assert!(matches!(
            err,
            ShvMmrError::CheckpointCommitmentMismatch { .. }
        ));
    }
}
