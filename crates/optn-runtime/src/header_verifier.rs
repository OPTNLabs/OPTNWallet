//! Provider-neutral SHV/MMR header verifier for issue #75.

use crate::chain::{
    BlockHeaderBytes, CheckpointProvenance, Hash32, HeaderAccumulatorState, HeaderCheckpoint,
    HeaderVerificationMode, HeaderVerifier, HistoricalHeaderProof,
};
use optn_core::{
    asert::{verify_expected_bits, AsertAnchor, AsertError, AsertParams},
    header_hash::sha256d,
    header_mmr::MmrAccumulator,
    header_pow::{verify_declared_pow, verify_link, HeaderPowError},
};

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
    difficulty: Option<DifficultyContext>,
}

impl ShvMmrHeaderVerifier {
    pub fn empty(provenance: CheckpointProvenance) -> Self {
        Self {
            accumulator: MmrAccumulator::new(),
            provenance,
            last_hash: None,
            last_time: None,
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
        let accumulator = MmrAccumulator::bootstrap_from_last_leaf_proof(
            leaf_count,
            parsed.hash,
            proof,
        )
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
}

impl HeaderVerifier for ShvMmrHeaderVerifier {
    type Error = ShvMmrError;

    fn mode(&self) -> HeaderVerificationMode {
        HeaderVerificationMode::ShvMmr
    }

    fn extend(&mut self, headers: &[BlockHeaderBytes]) -> Result<(), Self::Error> {
        for header in headers {
            if let (Some(context), Some(previous_time)) = (self.difficulty, self.last_time) {
                let previous_height = self
                    .accumulator
                    .leaf_count()
                    .checked_sub(1)
                    .ok_or(ShvMmrError::EmptyAccumulator)?;
                let previous_height =
                    u32::try_from(previous_height).map_err(|_| ShvMmrError::HeightOverflow)?;
                verify_expected_bits(
                    context.params,
                    context.anchor,
                    previous_height,
                    i64::from(previous_time),
                    &header.0,
                )?;
            }

            let parsed = match self.last_hash {
                Some(expected_prev) => verify_link(expected_prev, &header.0)?,
                None => verify_declared_pow(&header.0)?,
            };
            self.accumulator.extend(parsed.hash);
            self.last_hash = Some(parsed.hash);
            self.last_time = Some(parsed.time);
        }
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
