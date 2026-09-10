//! The runtime's authoritative verified header view, shared across providers.
//!
//! Issue #75 requires one verified header view per network, sitting *beneath*
//! the providers rather than inside one of them: "preserve one verified header
//! view across all network providers". This module is that view. It owns the
//! SHV/MMR accumulator, the height-for-time index, pruning, and reorg rollback.
//!
//! Providers do not own header truth. They fetch headers and proofs and hand
//! them over as observations; BIP37, Neutrino, Electrum and BCHN all feed the
//! same view, and none of them depends on another provider crate to do it.
//! Switching providers therefore preserves verified progress.
//!
//! Wallet birthdays and scan progress are deliberately *not* here. They are
//! per-wallet metadata; this view is per network and selected chain.

use std::collections::VecDeque;

use optn_core::header_time::{
    header_timestamp, median_time_past, SparseTimeIndex, TimeAnchor, TimeIndexError, TimeLookup,
    MEDIAN_TIME_SPAN,
};
use optn_core::network::Network;

use crate::chain::{
    BlockHeaderBytes, Evidence, Hash32, HeaderCheckpoint, HeaderVerifier, HistoricalHeaderProof,
};
use crate::header_verifier::{ShvMmrError, ShvMmrHeaderVerifier};

/// Blocks between retained time anchors.
///
/// The index is sparse so that header storage can be pruned underneath it.
/// 2016 keeps the whole of Chipnet's ~322k blocks in about 160 anchors, which
/// is roughly 1.2 KB of state, while bounding a resolved start to one
/// retarget interval before the requested instant.
pub const DEFAULT_ANCHOR_INTERVAL: u32 = 2016;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderViewError {
    Verification(ShvMmrError),
    TimeIndex(TimeIndexError),
    /// A proof arrived for a different chain than this view tracks.
    NetworkMismatch {
        expected: Network,
        actual: Network,
    },
    /// A proof was offered against a root this runtime has not accepted.
    ///
    /// The root a server sends alongside its own proof is not evidence. Only
    /// the accumulator this view built is.
    UnacceptedRoot {
        expected: Hash32,
        offered: Hash32,
    },
    /// The proof names a height this view cannot commit to.
    HeightOutsideAccumulator {
        height: u32,
        leaf_count: u64,
    },
}

impl From<ShvMmrError> for HeaderViewError {
    fn from(value: ShvMmrError) -> Self {
        Self::Verification(value)
    }
}

impl From<TimeIndexError> for HeaderViewError {
    fn from(value: TimeIndexError) -> Self {
        Self::TimeIndex(value)
    }
}

/// Why a height-for-time question could not be answered from retained state.
///
/// Issue #75 forbids papering over a gap with an unverified value or an
/// indexer call, so an unanswerable question is reported as such.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreStartUnavailable {
    /// Nothing has been verified into this view yet.
    NothingVerified,
    /// The requested instant is older than the retained range. The caller
    /// chooses between a full-history scan and a documented shortened scan.
    OlderThanRetained {
        oldest_height: u32,
        oldest_median_time_past: u32,
    },
}

/// Outcome of resolving a restore start from a requested instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreStart {
    /// A conservative start height, already stepped back by `lookback`.
    Height {
        height: u32,
        lookback: u32,
    },
    Unavailable(RestoreStartUnavailable),
}

/// One verified header view for one network.
#[derive(Debug, Clone)]
pub struct VerifiedHeaderView {
    network: Network,
    verifier: ShvMmrHeaderVerifier,
    times: SparseTimeIndex,
    /// Trailing timestamps for the median-time-past window.
    window: VecDeque<u32>,
    anchor_interval: u32,
}

impl VerifiedHeaderView {
    pub fn new(network: Network, verifier: ShvMmrHeaderVerifier) -> Self {
        Self::with_anchor_interval(network, verifier, DEFAULT_ANCHOR_INTERVAL)
    }

    pub fn with_anchor_interval(
        network: Network,
        verifier: ShvMmrHeaderVerifier,
        anchor_interval: u32,
    ) -> Self {
        Self {
            network,
            verifier,
            times: SparseTimeIndex::new(),
            window: VecDeque::with_capacity(MEDIAN_TIME_SPAN),
            anchor_interval: anchor_interval.max(1),
        }
    }

    pub const fn network(&self) -> Network {
        self.network
    }

    pub fn verifier(&self) -> &ShvMmrHeaderVerifier {
        &self.verifier
    }

    pub fn times(&self) -> &SparseTimeIndex {
        &self.times
    }

    pub fn checkpoint(&self) -> HeaderCheckpoint {
        self.verifier.checkpoint()
    }

    /// Verified tip, or `None` before anything is accepted.
    pub fn tip(&self) -> Option<(u32, Hash32)> {
        Some((
            self.verifier.state().ok()?.height,
            self.verifier.last_hash()?,
        ))
    }

    /// Verify a header batch, then index the timestamps it carried.
    ///
    /// Verification runs first and the whole batch is rejected together, so a
    /// peer cannot get a timestamp into the index without also getting the
    /// header past linkage, proof-of-work and difficulty. Timestamps are only
    /// read after that succeeds.
    pub fn extend(&mut self, headers: &[BlockHeaderBytes]) -> Result<(), HeaderViewError> {
        if headers.is_empty() {
            return Ok(());
        }
        let first_height = match self.verifier.state() {
            Ok(state) => u64::from(state.height) + 1,
            // An empty accumulator starts at the genesis leaf.
            Err(ShvMmrError::EmptyAccumulator) => 0,
            Err(error) => return Err(error.into()),
        };

        self.verifier.extend(headers)?;

        for (offset, header) in headers.iter().enumerate() {
            let height = first_height + offset as u64;
            self.record_time(height, header_timestamp(&header.0))?;
        }
        Ok(())
    }

    fn record_time(&mut self, height: u64, timestamp: u32) -> Result<(), HeaderViewError> {
        if self.window.len() == MEDIAN_TIME_SPAN {
            self.window.pop_front();
        }
        self.window.push_back(timestamp);

        // A partial window is not a median-time-past: it is missing the older,
        // smaller samples, so it can still fall as the window fills. Anchoring
        // only once the window is full keeps the index monotonic, which is what
        // makes the search sound.
        if self.window.len() < MEDIAN_TIME_SPAN {
            return Ok(());
        }
        let Ok(height) = u32::try_from(height) else {
            return Ok(());
        };
        if height % self.anchor_interval != 0 {
            return Ok(());
        }
        let samples = self.window.iter().copied().collect::<Vec<_>>();
        let Some(median_time_past) = median_time_past(&samples) else {
            return Ok(());
        };
        // A repeated median at a later height is normal and carries no new
        // information, so it is skipped rather than rejected.
        if self
            .times
            .newest()
            .is_some_and(|last| median_time_past == last.median_time_past)
        {
            return Ok(());
        }
        self.times.insert(TimeAnchor {
            height,
            median_time_past,
        })?;
        Ok(())
    }

    /// Resolve a conservative scan start for a requested instant.
    ///
    /// Never returns a height later than the first block that could hold a
    /// transaction made at `target_time`, and never invents one when the
    /// retained range cannot answer.
    pub fn restore_start_for_time(&self, target_time: u32, lookback: u32) -> RestoreStart {
        match self
            .times
            .conservative_height_for_time(target_time, lookback)
        {
            TimeLookup::Height(height) => RestoreStart::Height { height, lookback },
            TimeLookup::BeforeIndex {
                oldest_height,
                oldest_median_time_past,
            } => RestoreStart::Unavailable(RestoreStartUnavailable::OlderThanRetained {
                oldest_height,
                oldest_median_time_past,
            }),
            TimeLookup::Empty => {
                RestoreStart::Unavailable(RestoreStartUnavailable::NothingVerified)
            }
        }
    }

    /// Accept a historical header proof and say what it actually established.
    ///
    /// Binds the proof to this view's network, to a height the accumulator
    /// commits to, and to the root **this runtime built** rather than the root
    /// the proof arrived with. A provider's own root is an assertion; matching
    /// it against the accumulator is what turns it into evidence.
    pub fn accept_historical_proof(
        &self,
        network: Network,
        proof: &HistoricalHeaderProof,
    ) -> Result<Evidence, HeaderViewError> {
        if network != self.network {
            return Err(HeaderViewError::NetworkMismatch {
                expected: self.network,
                actual: network,
            });
        }
        let accepted_root = self.verifier.accumulator().root();
        if proof.target != accepted_root {
            return Err(HeaderViewError::UnacceptedRoot {
                expected: accepted_root,
                offered: proof.target,
            });
        }
        let leaf_count = self.verifier.accumulator().leaf_count();
        if u64::from(proof.height) >= leaf_count {
            return Err(HeaderViewError::HeightOutsideAccumulator {
                height: proof.height,
                leaf_count,
            });
        }
        self.verifier.verify_historical(proof)?;
        Ok(Evidence::HeaderMmrProven {
            block_hash: optn_core::header_hash::sha256d(&proof.header.0),
            height: proof.height,
        })
    }

    /// Drop time anchors below `height`, mirroring a header prune.
    ///
    /// The accumulator is untouched: pruning headers is exactly what SHV/MMR
    /// exists to make safe, and the peaks still commit to the pruned range.
    pub fn prune_below(&mut self, height: u32) {
        self.times.prune_below(height);
    }

    /// Invalidate indexed time at or above `height` after a reorg.
    ///
    /// This is the index half of a rollback only. The accumulator cannot be
    /// rewound in place — it is append-only — so a reorg below the verified tip
    /// still requires rebuilding it from a checkpoint. Dropping the anchors
    /// first stops a stale height being handed out in the meantime.
    pub fn rewind_to(&mut self, height: u32) {
        self.times.rewind_to(height);
        self.window.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::CheckpointProvenance;
    use optn_core::header_hash::sha256d;

    /// Build a linkable header. `bits` stays at the regtest-friendly maximum so
    /// declared proof-of-work passes without mining.
    fn header(prev: Hash32, time: u32, nonce: u32) -> BlockHeaderBytes {
        let mut raw = [0u8; 80];
        raw[0..4].copy_from_slice(&1u32.to_le_bytes());
        raw[4..36].copy_from_slice(&prev);
        raw[68..72].copy_from_slice(&time.to_le_bytes());
        raw[72..76].copy_from_slice(&0x207f_ffffu32.to_le_bytes());
        raw[76..80].copy_from_slice(&nonce.to_le_bytes());
        BlockHeaderBytes(raw)
    }

    /// A chain whose timestamps deliberately go backwards in places.
    ///
    /// `0x207fffff` still encodes a target just under 2^255, so roughly half of
    /// candidate hashes miss it. The fixture grinds the nonce rather than
    /// weakening the verifier for tests.
    fn chain(times: &[u32]) -> Vec<BlockHeaderBytes> {
        use optn_core::header_pow::verify_declared_pow;
        let mut out = Vec::new();
        let mut prev = [0u8; 32];
        for &time in times {
            let mut nonce = 0u32;
            let block = loop {
                let candidate = header(prev, time, nonce);
                if verify_declared_pow(&candidate.0).is_ok() {
                    break candidate;
                }
                nonce += 1;
            };
            prev = sha256d(&block.0);
            out.push(block);
        }
        out
    }

    fn view_with_interval(interval: u32) -> VerifiedHeaderView {
        VerifiedHeaderView::with_anchor_interval(
            Network::Chipnet,
            ShvMmrHeaderVerifier::empty(CheckpointProvenance::SelfDerived),
            interval,
        )
    }

    /// Timestamps that fall as well as rise, as consensus permits.
    fn wobbly_times(count: usize) -> Vec<u32> {
        (0..count)
            .map(|i| {
                let base = 1_600_000_000u32 + (i as u32) * 600;
                if i % 7 == 3 {
                    base.saturating_sub(900)
                } else {
                    base
                }
            })
            .collect()
    }

    #[test]
    fn extending_indexes_time_and_keeps_the_accumulator_in_step() {
        let mut view = view_with_interval(4);
        let times = wobbly_times(40);
        let headers = chain(&times);
        view.extend(&headers).expect("verified chain extends");

        let (height, _) = view.tip().expect("a tip after extending");
        assert_eq!(height, 39);
        assert!(!view.times().is_empty(), "anchors were recorded");
        // Monotonic despite the backwards timestamps in the fixture.
        let anchors = view.times().anchors();
        assert!(anchors
            .windows(2)
            .all(|pair| pair[0].height < pair[1].height
                && pair[0].median_time_past <= pair[1].median_time_past));
        assert!(times.windows(2).any(|pair| pair[1] < pair[0]));
    }

    #[test]
    fn a_rejected_batch_indexes_no_timestamps() {
        let mut view = view_with_interval(1);
        let headers = chain(&wobbly_times(20));
        // Second batch does not link to the first.
        view.extend(&headers[..10]).expect("first batch");
        let before = view.times().clone();
        let unlinked = chain(&wobbly_times(20));
        assert!(view.extend(&unlinked[15..]).is_err());
        assert_eq!(
            view.times(),
            &before,
            "a rejected batch must not move the index"
        );
    }

    #[test]
    fn a_restore_start_is_conservative_and_says_when_it_cannot_answer() {
        let mut view = view_with_interval(4);
        assert_eq!(
            view.restore_start_for_time(1_600_000_000, 0),
            RestoreStart::Unavailable(RestoreStartUnavailable::NothingVerified)
        );

        let times = wobbly_times(60);
        view.extend(&chain(&times)).expect("extends");

        let oldest = view.times().oldest().expect("an anchor");
        // Older than anything retained: reported, not guessed.
        assert_eq!(
            view.restore_start_for_time(oldest.median_time_past - 1, 0),
            RestoreStart::Unavailable(RestoreStartUnavailable::OlderThanRetained {
                oldest_height: oldest.height,
                oldest_median_time_past: oldest.median_time_past,
            })
        );

        let newest = view.times().newest().expect("an anchor");
        let RestoreStart::Height { height, lookback } =
            view.restore_start_for_time(newest.median_time_past, 8)
        else {
            panic!("expected a height");
        };
        assert_eq!(lookback, 8);
        assert!(height <= newest.height, "the start is never later");
        assert!(height >= oldest.height, "clamped to the retained range");
    }

    #[test]
    fn pruning_narrows_the_answerable_range_without_breaking_the_accumulator() {
        let mut view = view_with_interval(4);
        view.extend(&chain(&wobbly_times(60))).expect("extends");
        let root_before = view.verifier().accumulator().root();
        let newest = view.times().newest().expect("an anchor");

        view.prune_below(newest.height);
        assert_eq!(
            view.verifier().accumulator().root(),
            root_before,
            "pruning time anchors must not disturb the MMR"
        );
        assert_eq!(view.times().oldest().unwrap().height, newest.height);
        assert!(matches!(
            view.restore_start_for_time(0, 0),
            RestoreStart::Unavailable(RestoreStartUnavailable::OlderThanRetained { .. })
        ));
    }

    #[test]
    fn a_reorg_rewind_drops_stale_anchors() {
        let mut view = view_with_interval(4);
        view.extend(&chain(&wobbly_times(60))).expect("extends");
        let newest = view.times().newest().expect("an anchor");

        view.rewind_to(newest.height);
        assert!(view.times().newest().unwrap().height < newest.height);
    }

    /// Verified progress belongs to the view, not to whoever supplied it.
    ///
    /// The view has no provider identity by construction, so a batch fetched
    /// over BIP37 and a batch fetched over Electrum land in the same
    /// accumulator and the same index. Switching providers mid-sync therefore
    /// continues from the verified cursor instead of restarting, and neither
    /// provider crate is involved in holding that state.
    #[test]
    fn switching_provider_mid_sync_continues_from_the_same_verified_state() {
        let times = wobbly_times(48);
        let headers = chain(&times);

        // One view, fed in three separate batches as if by three providers.
        let mut shared = view_with_interval(4);
        shared.extend(&headers[..16]).expect("first provider");
        let after_first = shared.tip().expect("a tip");
        shared.extend(&headers[16..32]).expect("second provider");
        shared.extend(&headers[32..]).expect("third provider");

        // The same chain delivered in one batch by a single provider.
        let mut single = view_with_interval(4);
        single.extend(&headers).expect("one provider");

        assert_eq!(shared.tip(), single.tip(), "same verified tip");
        assert_eq!(
            shared.verifier().accumulator().root(),
            single.verifier().accumulator().root(),
            "same accumulator regardless of who delivered the headers"
        );
        assert_eq!(
            shared.times().anchors(),
            single.times().anchors(),
            "same time index regardless of batch boundaries"
        );
        assert_ne!(
            after_first,
            shared.tip().expect("a tip"),
            "the later providers did advance the view"
        );
    }

    #[test]
    fn a_proof_must_match_this_network_and_this_runtime_root() {
        let mut view = view_with_interval(4);
        let headers = chain(&wobbly_times(40));
        view.extend(&headers).expect("extends");
        let root = view.verifier().accumulator().root();

        let mut proof = HistoricalHeaderProof {
            height: 10,
            header: headers[10].clone(),
            proof: Vec::new(),
            target: root,
        };

        // Wrong network is refused before any hashing.
        assert_eq!(
            view.accept_historical_proof(Network::Mainnet, &proof),
            Err(HeaderViewError::NetworkMismatch {
                expected: Network::Chipnet,
                actual: Network::Mainnet,
            })
        );

        // A root this runtime never accepted is refused even though the proof
        // is internally consistent with it.
        let mut foreign = proof.clone();
        foreign.target[0] ^= 1;
        assert!(matches!(
            view.accept_historical_proof(Network::Chipnet, &foreign),
            Err(HeaderViewError::UnacceptedRoot { .. })
        ));

        // A height the accumulator does not commit to is refused.
        let mut too_high = proof.clone();
        too_high.height = 10_000;
        assert!(matches!(
            view.accept_historical_proof(Network::Chipnet, &too_high),
            Err(HeaderViewError::HeightOutsideAccumulator { .. })
        ));

        // An empty sibling list for a non-trivial tree fails verification
        // rather than being waved through.
        assert!(view
            .accept_historical_proof(Network::Chipnet, &proof)
            .is_err());
        proof.proof.clear();
    }
}
