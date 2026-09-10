//! Replaying history the wallet no longer retains, and proving the replay is
//! the history it already accepted.
//!
//! A wallet that has pruned, or that is restoring from a checkpoint, can still
//! be asked about blocks it does not hold. Fetching those headers again is easy
//! and proves nothing: `getheaders` is an acquisition mechanism, and a peer can
//! answer an old locator with a plausible fork. Accepting that as history
//! because it links and carries work would let a peer choose the past.
//!
//! What the wallet already has is a commitment: an accumulator state it
//! verified, at a height it recorded, plus authenticated anchors along the way.
//! A replay is believed when it *reproduces* that commitment. Recomputing the
//! same Merkle Mountain Range root over a different chain would be a hash
//! collision, so a replay that lands on the accepted commitment is the accepted
//! history, and one that does not is rejected with the height where it parted.
//!
//! Three things follow from that, and they are the reason this is a separate
//! staged accumulator rather than a method on the live one:
//!
//! - The live accumulator is never touched. Its leaves are already counted;
//!   appending recovered history to it a second time would corrupt the very
//!   commitment the replay is being checked against.
//! - An accumulator is only reproducible from leaf zero, so a replay starts at
//!   genesis. That is why it is bounded, resumable and restart-safe rather than
//!   a single call: on a long chain it is a lot of headers, and it must survive
//!   being interrupted.
//! - Resume material is written by this wallet for itself, and it does not have
//!   to be trusted. Tampering with it cannot forge an authentication, because
//!   the final comparison is against a commitment the host holds separately;
//!   the worst a corrupted resume file can do is waste the work and fail.
//!
//! Acquiring the headers is the caller's job, which is what keeps source and
//! transport policy where it belongs: this module never dials anything. It says
//! which height it needs next and judges what it is given.
//!
//! Unavailable history is reported as [`ReplayStep::Incomplete`]. It is never
//! an authenticated empty result, because "we could not read the past" and
//! "nothing happened in the past" are different answers and only one of them is
//! safe to show a wallet holder.

use std::collections::BTreeMap;

use optn_core::asert::{AsertAnchor, AsertParams};
use optn_core::header_hash::sha256d;
use optn_core::network::Network;
use serde::{Deserialize, Serialize};

use crate::chain::{BlockHeaderBytes, CheckpointProvenance, Hash32, HeaderVerifier};
use crate::header_verifier::{ShvMmrError, ShvMmrHeaderVerifier};

/// The commitment a replay has to reproduce to be believed.
///
/// This comes from the wallet's own verified view, not from the source serving
/// the headers. A peer that could choose this could authenticate anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedCommitment {
    pub height: u32,
    pub commitment: Hash32,
}

/// Work a replay may do before it must report back.
///
/// A replay from genesis is unbounded by nature, so the caller sets what it is
/// willing to spend and gets a resumable position back when that runs out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplayBudget {
    pub max_headers: u32,
    pub max_batches: u32,
}

impl Default for ReplayBudget {
    fn default() -> Self {
        Self {
            max_headers: 50_000,
            max_batches: 64,
        }
    }
}

/// Where a replay stopped, and how to carry on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncompleteReplay {
    /// The caller's budget ran out. Resumable exactly here.
    BudgetExhausted { next_height: u32, headers_seen: u32 },
    /// The caller stopped it.
    Cancelled { next_height: u32, headers_seen: u32 },
    /// The source stopped serving before the target was reached. Another
    /// source may be able to continue from the same position.
    SourceExhausted { next_height: u32, headers_seen: u32 },
}

impl IncompleteReplay {
    /// The height a resumed replay asks for first.
    pub const fn next_height(&self) -> u32 {
        match self {
            Self::BudgetExhausted { next_height, .. }
            | Self::Cancelled { next_height, .. }
            | Self::SourceExhausted { next_height, .. } => *next_height,
        }
    }
}

/// Why a replay is not the accepted history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DivergenceReason {
    /// An authenticated anchor says a different block sits at this height.
    /// Caught here rather than at the end, so the answer names where the
    /// supplied chain parted from the accepted one.
    AnchorMismatch {
        height: u32,
        expected: Hash32,
        found: Hash32,
    },
    /// The replay reached the target height with a different accumulator.
    /// Same length, same work, different history.
    CommitmentMismatch {
        height: u32,
        expected: Hash32,
        found: Hash32,
    },
    /// The headers themselves did not verify: linkage, declared
    /// proof-of-work, or the network's difficulty rule.
    Verification(ShvMmrError),
}

/// The result of feeding a batch to a replay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayStep {
    /// Keep going from this height.
    NeedHeaders { from_height: u32 },
    /// The replay reproduced the accepted commitment.
    Authenticated {
        through_height: u32,
        anchors_matched: usize,
    },
    /// Stopped without an answer. Not an empty history.
    Incomplete(IncompleteReplay),
    /// The supplied history is not the accepted history.
    Diverged(DivergenceReason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayError {
    /// The network has no difficulty context, so headers cannot be judged.
    MissingDifficultyContext,
    /// A target at genesis or below has nothing to reconstruct.
    TargetTooLow {
        height: u32,
    },
    /// An anchor sits at or beyond the target, so reaching it would not be
    /// covered by the commitment comparison.
    AnchorOutsideTarget {
        height: u32,
    },
    /// Resume material could not be read.
    InvalidResumeRecord,
    Verification(ShvMmrError),
}

/// Resume material. Written by the wallet for itself; see the module docs on
/// why it does not need to be trusted.
#[derive(Serialize, Deserialize)]
struct ReplayResume {
    schema: u32,
    network: String,
    /// Staged accumulator height, i.e. the last leaf replayed.
    height: u32,
    commitment: Hash32,
    header: Vec<u8>,
    proof: Vec<Hash32>,
    headers_seen: u32,
    anchors_matched: usize,
}

const RESUME_SCHEMA: u32 = 1;
const MAX_RESUME_BYTES: usize = 64 * 1024;

/// A staged reconstruction of history, checked against what was accepted.
#[derive(Debug, Clone)]
pub struct HistoricalReplay {
    network: Network,
    /// Rebuilt from genesis, and deliberately not the live accumulator.
    staged: ShvMmrHeaderVerifier,
    target: AcceptedCommitment,
    /// Authenticated heights the replay must agree with as it passes them.
    anchors: BTreeMap<u32, Hash32>,
    budget: ReplayBudget,
    headers_seen: u32,
    batches_seen: u32,
    anchors_matched: usize,
    finished: bool,
}

impl HistoricalReplay {
    /// Start a replay for `network` that must reproduce `target`.
    ///
    /// `anchors` are heights the wallet already authenticated; each is checked
    /// as the replay passes it, so a divergence is reported at the block where
    /// it happened rather than only at the end.
    pub fn begin(
        network: Network,
        target: AcceptedCommitment,
        anchors: BTreeMap<u32, Hash32>,
        budget: ReplayBudget,
    ) -> Result<Self, ReplayError> {
        if target.height == 0 {
            return Err(ReplayError::TargetTooLow {
                height: target.height,
            });
        }
        if let Some((&height, _)) = anchors.iter().next_back() {
            if height >= target.height {
                return Err(ReplayError::AnchorOutsideTarget { height });
            }
        }
        let staged = Self::staged_verifier(network);
        if !staged.has_difficulty_context() {
            return Err(ReplayError::MissingDifficultyContext);
        }
        Ok(Self {
            network,
            staged,
            target,
            anchors,
            budget,
            headers_seen: 0,
            batches_seen: 0,
            anchors_matched: 0,
            finished: false,
        })
    }

    /// An empty accumulator carrying the network's difficulty rule.
    ///
    /// Self-derived on purpose: nothing about this reconstruction is trusted
    /// until it reproduces the accepted commitment.
    fn staged_verifier(network: Network) -> ShvMmrHeaderVerifier {
        ShvMmrHeaderVerifier::empty(CheckpointProvenance::SelfDerived).with_asert(
            AsertParams::for_network(network),
            AsertAnchor::for_network(network),
        )
    }

    /// The height the replay wants next.
    pub fn next_height(&self) -> u32 {
        self.staged
            .state()
            .map(|state| state.height.saturating_add(1))
            .unwrap_or(0)
    }

    pub const fn headers_seen(&self) -> u32 {
        self.headers_seen
    }

    pub const fn anchors_matched(&self) -> usize {
        self.anchors_matched
    }

    /// Whether this replay has produced its final answer.
    pub const fn is_finished(&self) -> bool {
        self.finished
    }

    /// Stop without an answer, keeping the position for a later resume.
    pub fn cancel(&mut self) -> ReplayStep {
        self.finished = true;
        ReplayStep::Incomplete(IncompleteReplay::Cancelled {
            next_height: self.next_height(),
            headers_seen: self.headers_seen,
        })
    }

    /// Judge one batch of acquired headers.
    ///
    /// Headers past the target are ignored rather than rejected: a peer serving
    /// a fixed batch size will overshoot, and that is not misbehaviour.
    pub fn feed(&mut self, headers: &[BlockHeaderBytes]) -> ReplayStep {
        if self.finished {
            return ReplayStep::Incomplete(IncompleteReplay::Cancelled {
                next_height: self.next_height(),
                headers_seen: self.headers_seen,
            });
        }
        let start = self.next_height();
        if headers.is_empty() {
            self.finished = true;
            return ReplayStep::Incomplete(IncompleteReplay::SourceExhausted {
                next_height: start,
                headers_seen: self.headers_seen,
            });
        }
        if self.batches_seen >= self.budget.max_batches
            || self.headers_seen >= self.budget.max_headers
        {
            self.finished = true;
            return ReplayStep::Incomplete(IncompleteReplay::BudgetExhausted {
                next_height: start,
                headers_seen: self.headers_seen,
            });
        }
        self.batches_seen = self.batches_seen.saturating_add(1);

        // Never replay past the commitment being reproduced: leaves beyond it
        // are not covered by the comparison and would change the accumulator.
        let wanted = (self.target.height - start + 1) as usize;
        let remaining_budget = (self.budget.max_headers - self.headers_seen) as usize;
        let take = headers.len().min(wanted).min(remaining_budget);
        let batch = &headers[..take];

        if let Err(error) = self.staged.extend(batch) {
            self.finished = true;
            return ReplayStep::Diverged(DivergenceReason::Verification(error));
        }
        self.headers_seen = self.headers_seen.saturating_add(take as u32);

        // Anchors first: they name the height where the chains parted, which a
        // commitment mismatch on its own cannot.
        for (offset, header) in batch.iter().enumerate() {
            let height = start + offset as u32;
            if let Some(expected) = self.anchors.get(&height) {
                let found = sha256d(&header.0);
                if found != *expected {
                    self.finished = true;
                    return ReplayStep::Diverged(DivergenceReason::AnchorMismatch {
                        height,
                        expected: *expected,
                        found,
                    });
                }
                self.anchors_matched += 1;
            }
        }

        let state = match self.staged.state() {
            Ok(state) => state,
            Err(error) => {
                self.finished = true;
                return ReplayStep::Diverged(DivergenceReason::Verification(error));
            }
        };
        if state.height < self.target.height {
            if self.headers_seen >= self.budget.max_headers {
                self.finished = true;
                return ReplayStep::Incomplete(IncompleteReplay::BudgetExhausted {
                    next_height: self.next_height(),
                    headers_seen: self.headers_seen,
                });
            }
            return ReplayStep::NeedHeaders {
                from_height: self.next_height(),
            };
        }

        self.finished = true;
        if state.commitment != self.target.commitment {
            return ReplayStep::Diverged(DivergenceReason::CommitmentMismatch {
                height: self.target.height,
                expected: self.target.commitment,
                found: state.commitment,
            });
        }
        ReplayStep::Authenticated {
            through_height: self.target.height,
            anchors_matched: self.anchors_matched,
        }
    }

    /// Write resume material for an interrupted replay.
    pub fn encode(&self) -> Result<String, ReplayError> {
        let state = self.staged.state().map_err(ReplayError::Verification)?;
        let (header, proof) = self
            .staged
            .tip_checkpoint_proof()
            .ok_or(ReplayError::Verification(ShvMmrError::EmptyAccumulator))?;
        let record = ReplayResume {
            schema: RESUME_SCHEMA,
            network: self.network.to_string(),
            height: state.height,
            commitment: state.commitment,
            header: header.0.to_vec(),
            proof: proof.to_vec(),
            headers_seen: self.headers_seen,
            anchors_matched: self.anchors_matched,
        };
        serde_json::to_string(&record).map_err(|_| ReplayError::InvalidResumeRecord)
    }

    /// Continue an interrupted replay.
    ///
    /// The target and anchors are supplied again by the caller rather than read
    /// from the record, so resume material cannot nominate what it will be
    /// judged against.
    pub fn restore(
        json: &str,
        network: Network,
        target: AcceptedCommitment,
        anchors: BTreeMap<u32, Hash32>,
        budget: ReplayBudget,
    ) -> Result<Self, ReplayError> {
        if json.len() > MAX_RESUME_BYTES {
            return Err(ReplayError::InvalidResumeRecord);
        }
        let record: ReplayResume =
            serde_json::from_str(json).map_err(|_| ReplayError::InvalidResumeRecord)?;
        if record.schema != RESUME_SCHEMA
            || record.network != network.to_string()
            || record.proof.len() > 32
        {
            return Err(ReplayError::InvalidResumeRecord);
        }
        if record.height >= target.height {
            return Err(ReplayError::InvalidResumeRecord);
        }
        let header = BlockHeaderBytes(
            record
                .header
                .try_into()
                .map_err(|_| ReplayError::InvalidResumeRecord)?,
        );
        // Self-derived, because it is: this is the wallet's own partial work,
        // and it earns no trust until the commitment comparison passes.
        let staged = ShvMmrHeaderVerifier::from_checkpoint_proof(
            record.height,
            header,
            &record.proof,
            record.commitment,
            CheckpointProvenance::SelfDerived,
        )
        .map_err(ReplayError::Verification)?
        .with_asert(
            AsertParams::for_network(network),
            AsertAnchor::for_network(network),
        );
        Ok(Self {
            network,
            staged,
            target,
            anchors,
            budget,
            headers_seen: record.headers_seen,
            batches_seen: 0,
            anchors_matched: record.anchors_matched,
            finished: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_core::header_pow::verify_declared_pow;

    /// A short regtest-shaped chain. Regtest does not retarget, so headers are
    /// cheap to make and the difficulty rule is still applied as the rule for
    /// that chain rather than skipped.
    /// Build a fixture chain of `len` headers.
    ///
    /// `variant` only distinguishes one generated chain from another -- it is
    /// mixed into the merkle root and the timestamp so two chains of equal
    /// length and work differ. It is not a cryptographic value, and naming it
    /// otherwise made CodeQL read every `chain(n, 0)` call as a hard-coded
    /// one and fail the PR on fourteen alerts in this test module.
    fn chain(len: u32, variant: u32) -> Vec<BlockHeaderBytes> {
        let bits = AsertParams::for_network(Network::Regtest).max_bits;
        let mut previous = [0u8; 32];
        let mut headers = Vec::new();
        for height in 0..len {
            let mut header = [0u8; 80];
            header[0..4].copy_from_slice(&1u32.to_le_bytes());
            header[4..36].copy_from_slice(&previous);
            header[36..68].copy_from_slice(&[(height as u8).wrapping_add(variant as u8); 32]);
            header[68..72].copy_from_slice(&((height + 1) * 600 + variant).to_le_bytes());
            header[72..76].copy_from_slice(&bits.to_le_bytes());
            let mut accepted = None;
            for nonce in 0u32..100_000 {
                header[76..80].copy_from_slice(&nonce.to_le_bytes());
                if verify_declared_pow(&header).is_ok() {
                    accepted = Some(header);
                    break;
                }
            }
            let header = accepted.expect("regtest difficulty is trivially satisfiable");
            previous = sha256d(&header);
            headers.push(BlockHeaderBytes(header));
        }
        headers
    }

    /// The commitment the wallet would already hold for that chain.
    fn accepted_for(headers: &[BlockHeaderBytes]) -> AcceptedCommitment {
        let mut verifier = HistoricalReplay::staged_verifier(Network::Regtest);
        verifier
            .extend(headers)
            .expect("the fixture chain verifies");
        let state = verifier.state().expect("a state");
        AcceptedCommitment {
            height: state.height,
            commitment: state.commitment,
        }
    }

    fn anchors_at(headers: &[BlockHeaderBytes], heights: &[u32]) -> BTreeMap<u32, Hash32> {
        heights
            .iter()
            .map(|height| (*height, sha256d(&headers[*height as usize].0)))
            .collect()
    }

    #[test]
    fn a_faithful_replay_reproduces_the_accepted_commitment() {
        let headers = chain(8, 0);
        let target = accepted_for(&headers);
        let anchors = anchors_at(&headers, &[2, 5]);
        let mut replay = HistoricalReplay::begin(
            Network::Regtest,
            target.clone(),
            anchors,
            ReplayBudget::default(),
        )
        .unwrap();

        assert_eq!(replay.next_height(), 0);
        assert_eq!(
            replay.feed(&headers),
            ReplayStep::Authenticated {
                through_height: target.height,
                anchors_matched: 2,
            }
        );
    }

    /// Same length, same work, different history.
    #[test]
    fn a_different_chain_of_the_same_length_is_refused() {
        let accepted = chain(8, 0);
        let target = accepted_for(&accepted);
        let fork = chain(8, 7);
        assert_ne!(accepted[3], fork[3]);

        let mut replay = HistoricalReplay::begin(
            Network::Regtest,
            target,
            BTreeMap::new(),
            ReplayBudget::default(),
        )
        .unwrap();
        match replay.feed(&fork) {
            ReplayStep::Diverged(DivergenceReason::CommitmentMismatch { height, .. }) => {
                assert_eq!(height, 7);
            }
            other => panic!("a fork was not refused: {other:?}"),
        }
    }

    /// An anchor names where the chains parted; a commitment alone cannot.
    #[test]
    fn an_anchor_reports_the_height_where_history_parted() {
        let accepted = chain(8, 0);
        let target = accepted_for(&accepted);
        let anchors = anchors_at(&accepted, &[4]);
        let fork = chain(8, 9);

        let mut replay =
            HistoricalReplay::begin(Network::Regtest, target, anchors, ReplayBudget::default())
                .unwrap();
        match replay.feed(&fork) {
            ReplayStep::Diverged(DivergenceReason::AnchorMismatch { height, .. }) => {
                assert_eq!(height, 4, "the divergence should be named at the anchor");
            }
            other => panic!("an anchor mismatch was not caught: {other:?}"),
        }
    }

    /// Budget runs out, and the position survives.
    #[test]
    fn an_exhausted_budget_is_resumable_rather_than_final() {
        let headers = chain(8, 0);
        let target = accepted_for(&headers);
        let budget = ReplayBudget {
            max_headers: 4,
            max_batches: 8,
        };
        let mut replay =
            HistoricalReplay::begin(Network::Regtest, target.clone(), BTreeMap::new(), budget)
                .unwrap();

        let stopped = replay.feed(&headers);
        let ReplayStep::Incomplete(IncompleteReplay::BudgetExhausted { next_height, .. }) = stopped
        else {
            panic!("expected the budget to stop this: {stopped:?}");
        };
        assert_eq!(next_height, 4);

        // Unavailable history is never an authenticated empty answer.
        assert!(!matches!(stopped, ReplayStep::Authenticated { .. }));

        // Resuming with room finishes the job.
        let json = replay.encode().unwrap();
        let mut resumed = HistoricalReplay::restore(
            &json,
            Network::Regtest,
            target.clone(),
            BTreeMap::new(),
            ReplayBudget::default(),
        )
        .unwrap();
        assert_eq!(resumed.next_height(), 4);
        assert_eq!(
            resumed.feed(&headers[4..]),
            ReplayStep::Authenticated {
                through_height: target.height,
                anchors_matched: 0,
            }
        );
    }

    /// Resume material is the wallet's own work, and forging it buys nothing.
    #[test]
    fn tampered_resume_material_cannot_authenticate_a_fork() {
        let accepted = chain(8, 0);
        let target = accepted_for(&accepted);
        let fork = chain(8, 3);

        // A replay that got four blocks into a *different* chain, saved.
        let budget = ReplayBudget {
            max_headers: 4,
            max_batches: 8,
        };
        let mut attacker =
            HistoricalReplay::begin(Network::Regtest, target.clone(), BTreeMap::new(), budget)
                .unwrap();
        attacker.feed(&fork);
        let forged = attacker.encode().unwrap();

        // Restoring it is allowed; it simply cannot reach the commitment.
        let mut resumed = HistoricalReplay::restore(
            &forged,
            Network::Regtest,
            target,
            BTreeMap::new(),
            ReplayBudget::default(),
        )
        .unwrap();
        match resumed.feed(&fork[4..]) {
            ReplayStep::Diverged(DivergenceReason::CommitmentMismatch { .. }) => {}
            other => panic!("forged resume material was believed: {other:?}"),
        }
    }

    /// A source that stops early is incomplete, not an empty history.
    #[test]
    fn a_source_that_stops_early_is_incomplete() {
        let headers = chain(8, 0);
        let target = accepted_for(&headers);
        let mut replay = HistoricalReplay::begin(
            Network::Regtest,
            target,
            BTreeMap::new(),
            ReplayBudget::default(),
        )
        .unwrap();
        assert_eq!(
            replay.feed(&headers[..3]),
            ReplayStep::NeedHeaders { from_height: 3 }
        );
        match replay.feed(&[]) {
            ReplayStep::Incomplete(IncompleteReplay::SourceExhausted { next_height, .. }) => {
                assert_eq!(next_height, 3);
            }
            other => panic!("an exhausted source was not reported as incomplete: {other:?}"),
        }
    }

    /// A peer serving fixed-size batches overshoots; that is not misbehaviour,
    /// and the extra leaves must not enter the staged accumulator.
    #[test]
    fn headers_past_the_target_are_ignored_rather_than_replayed() {
        let headers = chain(10, 0);
        // Target the chain as it stood at height 5.
        let target = accepted_for(&headers[..6]);
        let mut replay = HistoricalReplay::begin(
            Network::Regtest,
            target,
            BTreeMap::new(),
            ReplayBudget::default(),
        )
        .unwrap();
        assert_eq!(
            replay.feed(&headers),
            ReplayStep::Authenticated {
                through_height: 5,
                anchors_matched: 0,
            }
        );
        assert_eq!(replay.headers_seen(), 6);
    }

    /// Cancellation keeps a position rather than producing an answer.
    #[test]
    fn cancelling_yields_a_resumable_position() {
        let headers = chain(8, 0);
        let target = accepted_for(&headers);
        let mut replay = HistoricalReplay::begin(
            Network::Regtest,
            target,
            BTreeMap::new(),
            ReplayBudget::default(),
        )
        .unwrap();
        replay.feed(&headers[..2]);
        match replay.cancel() {
            ReplayStep::Incomplete(IncompleteReplay::Cancelled { next_height, .. }) => {
                assert_eq!(next_height, 2);
            }
            other => panic!("cancel did not yield a position: {other:?}"),
        }
        assert!(replay.is_finished());
    }

    /// An anchor at or past the target would not be covered by the comparison.
    #[test]
    fn anchors_must_sit_inside_the_replayed_span() {
        let headers = chain(8, 0);
        let target = accepted_for(&headers);
        let anchors = anchors_at(&headers, &[7]);
        assert_eq!(
            HistoricalReplay::begin(Network::Regtest, target, anchors, ReplayBudget::default())
                .unwrap_err(),
            ReplayError::AnchorOutsideTarget { height: 7 }
        );
    }

    /// The obvious shortcut: claim in resume material to have already arrived.
    ///
    /// A record at or past the target would make the commitment comparison
    /// vacuous -- there would be nothing left to replay before declaring
    /// success -- so it is refused rather than restored.
    #[test]
    fn resume_material_cannot_claim_to_have_already_arrived() {
        let headers = chain(8, 0);
        let target = accepted_for(&headers);

        let mut honest = HistoricalReplay::begin(
            Network::Regtest,
            target.clone(),
            BTreeMap::new(),
            ReplayBudget::default(),
        )
        .unwrap();
        honest.feed(&headers);
        // A record written at the target height, with the real commitment.
        let arrived = honest.encode().unwrap();

        assert_eq!(
            HistoricalReplay::restore(
                &arrived,
                Network::Regtest,
                target,
                BTreeMap::new(),
                ReplayBudget::default(),
            )
            .unwrap_err(),
            ReplayError::InvalidResumeRecord
        );
    }

    /// Resume material belongs to the network it was made on.
    #[test]
    fn resume_material_is_scoped_to_its_network() {
        let headers = chain(8, 0);
        let target = accepted_for(&headers);
        let mut replay = HistoricalReplay::begin(
            Network::Regtest,
            target.clone(),
            BTreeMap::new(),
            ReplayBudget {
                max_headers: 4,
                max_batches: 8,
            },
        )
        .unwrap();
        replay.feed(&headers);
        let json = replay.encode().unwrap();

        assert_eq!(
            HistoricalReplay::restore(
                &json,
                Network::Chipnet,
                target,
                BTreeMap::new(),
                ReplayBudget::default(),
            )
            .unwrap_err(),
            ReplayError::InvalidResumeRecord
        );
    }
}
