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

use serde::{Deserialize, Serialize};

use optn_core::asert::{AsertAnchor, AsertParams};
use optn_core::header_time::{
    header_timestamp, median_time_past, HeaderAnchor, HeaderIndexError, SparseHeaderIndex,
    TimeLookup, MEDIAN_TIME_SPAN,
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

/// Ceiling on a persisted view. Peaks are O(log n) and anchors are one per
/// retarget interval, so a real record is kilobytes; anything far larger is a
/// malformed or hostile file rather than a chain that grew.
const MAX_PERSISTED_VIEW_BYTES: usize = 1024 * 1024;

/// Bumped when the record shape changes. A record from an older schema is
/// refused rather than partially understood; the view rebuilds from its
/// checkpoint instead.
const PERSISTED_VIEW_SCHEMA: u32 = 2;

/// Durable form of a [`VerifiedHeaderView`].
///
/// Deliberately does not carry the trusted commitment or the difficulty
/// context. Both are re-supplied on restore, so editing this file cannot move
/// what the view will accept.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedAnchor {
    height: u32,
    block_hash: Hash32,
    median_time_past: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedHeaderView {
    schema: u32,
    network: String,
    checkpoint: String,
    anchors: Vec<PersistedAnchor>,
    window: Vec<u32>,
    anchor_interval: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderViewError {
    Verification(ShvMmrError),
    TimeIndex(HeaderIndexError),
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
    /// The persisted record is malformed, oversized, or for another chain.
    InvalidPersistedView,
    /// Nothing is retained at the height a re-authentication named.
    NoAnchorAtHeight {
        height: u32,
    },
    /// A proof authenticated a different block than the retained anchor claims.
    AnchorMismatch {
        height: u32,
        retained: Hash32,
    },
}

impl From<ShvMmrError> for HeaderViewError {
    fn from(value: ShvMmrError) -> Self {
        Self::Verification(value)
    }
}

impl From<HeaderIndexError> for HeaderViewError {
    fn from(value: HeaderIndexError) -> Self {
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
    times: SparseHeaderIndex,
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
            times: SparseHeaderIndex::new(),
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

    pub fn times(&self) -> &SparseHeaderIndex {
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
            // The leaf the accumulator just committed to is this block's hash;
            // retaining it is what lets a pruned client build a `getheaders`
            // locator and re-authenticate the anchor later.
            self.record_anchor(
                height,
                crate::header_verifier::header_leaf(header),
                header_timestamp(&header.0),
            )?;
        }
        Ok(())
    }

    fn record_anchor(
        &mut self,
        height: u64,
        block_hash: Hash32,
        timestamp: u32,
    ) -> Result<(), HeaderViewError> {
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
        self.times.insert(HeaderAnchor {
            height,
            block_hash,
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
    /// Accept a proof that terminates at a peak rather than at the bagged root.
    ///
    /// The SHV wire protocol offers both. A peak proof is shorter, and a client
    /// that already holds the peaks -- which this view does, that being the
    /// whole point of the accumulator -- can check it without bagging. The
    /// binding is the same: the claimed peak must be one of *ours*, not one the
    /// peer supplied alongside its own proof.
    pub fn accept_historical_peak_proof(
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
        let accumulator = self.verifier.accumulator();
        if !accumulator.peaks().contains(&proof.target) {
            return Err(HeaderViewError::UnacceptedRoot {
                expected: accumulator.root(),
                offered: proof.target,
            });
        }
        let leaf_count = accumulator.leaf_count();
        if u64::from(proof.height) >= leaf_count {
            return Err(HeaderViewError::HeightOutsideAccumulator {
                height: proof.height,
                leaf_count,
            });
        }
        let parsed = optn_core::header_pow::verify_declared_pow(&proof.header.0)
            .map_err(|error| HeaderViewError::Verification(ShvMmrError::Header(error)))?;
        if !accumulator.verify_proof_to_peak(u64::from(proof.height), parsed.hash, &proof.proof) {
            return Err(HeaderViewError::Verification(
                ShvMmrError::HistoricalProofInvalid,
            ));
        }
        Ok(Evidence::HeaderMmrProven {
            block_hash: parsed.hash,
            height: proof.height,
        })
    }

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

    /// Block-hash locator for asking a peer to resend headers from `height`.
    ///
    /// `getheaders` has no height parameter — it takes a locator and the peer
    /// answers from the first hash it recognises. A pruned client can therefore
    /// only ask for ranges it can still name, which is precisely what the
    /// retained anchors record.
    ///
    /// An empty locator means nothing at or below `height` is retained: the
    /// caller must recover by another route rather than fabricate a starting
    /// point.
    pub fn getheaders_locator(&self, height: u32) -> Vec<Hash32> {
        self.times.locator(height)
    }

    /// The retained anchor span, or `None` when nothing is retained.
    pub fn retained_span(&self) -> Option<(u32, u32)> {
        self.times.retained_span()
    }

    /// Re-authenticate a retained anchor against accumulator-backed material.
    ///
    /// Monotonic ordering is an integrity check on a restored series, not an
    /// authentication of it. This is the step that turns a persisted anchor
    /// back into something trusted: the proof must satisfy the usual network,
    /// height and accepted-root binding **and** carry the very block the
    /// anchor claims at that height.
    pub fn reauthenticate_anchor(
        &self,
        network: Network,
        proof: &HistoricalHeaderProof,
    ) -> Result<Evidence, HeaderViewError> {
        let Some(anchor) = self.times.anchor_at(proof.height) else {
            return Err(HeaderViewError::NoAnchorAtHeight {
                height: proof.height,
            });
        };
        let evidence = self.accept_historical_proof(network, proof)?;
        let Evidence::HeaderMmrProven { block_hash, .. } = evidence else {
            return Err(HeaderViewError::AnchorMismatch {
                height: proof.height,
                retained: anchor.block_hash,
            });
        };
        if block_hash != anchor.block_hash {
            return Err(HeaderViewError::AnchorMismatch {
                height: proof.height,
                retained: anchor.block_hash,
            });
        }
        Ok(evidence)
    }

    /// Encode this view for durable storage.
    ///
    /// The accumulator half reuses the verifier's own checkpoint record, so the
    /// same trust rule applies on the way back in: the commitment must be
    /// re-supplied from authenticated storage, never taken from this blob.
    pub fn encode(&self) -> Result<String, HeaderViewError> {
        let record = PersistedHeaderView {
            schema: PERSISTED_VIEW_SCHEMA,
            network: self.network.to_string(),
            checkpoint: self.verifier.encode_checkpoint_json(self.network)?,
            anchors: self
                .times
                .anchors()
                .iter()
                .map(|anchor| PersistedAnchor {
                    height: anchor.height,
                    block_hash: anchor.block_hash,
                    median_time_past: anchor.median_time_past,
                })
                .collect(),
            window: self.window.iter().copied().collect(),
            anchor_interval: self.anchor_interval,
        };
        serde_json::to_string(&record).map_err(|_| HeaderViewError::InvalidPersistedView)
    }

    /// Restore a view against an independently trusted checkpoint.
    ///
    /// `trusted` must come from authenticated storage, not from the same blob:
    /// a record that carries its own commitment proves nothing. The network's
    /// difficulty context is re-attached here rather than persisted, because a
    /// stored ASERT anchor would be one more thing an attacker could edit.
    ///
    /// Anchors are replayed through the index's own monotonicity checks, so a
    /// tampered or reordered time series is rejected instead of loaded.
    pub fn restore(
        json: &str,
        network: Network,
        trusted: &HeaderCheckpoint,
    ) -> Result<Self, HeaderViewError> {
        if json.len() > MAX_PERSISTED_VIEW_BYTES {
            return Err(HeaderViewError::InvalidPersistedView);
        }
        let record: PersistedHeaderView =
            serde_json::from_str(json).map_err(|_| HeaderViewError::InvalidPersistedView)?;
        if record.schema != PERSISTED_VIEW_SCHEMA || record.network != network.to_string() {
            return Err(HeaderViewError::InvalidPersistedView);
        }
        if record.window.len() > MEDIAN_TIME_SPAN {
            return Err(HeaderViewError::InvalidPersistedView);
        }

        let verifier =
            ShvMmrHeaderVerifier::from_checkpoint_json(&record.checkpoint, network, trusted)?
                .with_asert(
                    AsertParams::for_network(network),
                    AsertAnchor::for_network(network),
                );

        let mut view = Self::with_anchor_interval(network, verifier, record.anchor_interval);
        for anchor in record.anchors {
            view.times.insert(HeaderAnchor {
                height: anchor.height,
                block_hash: anchor.block_hash,
                median_time_past: anchor.median_time_past,
            })?;
        }
        view.window = record.window.into_iter().collect();
        Ok(view)
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
    // The parameter is the grinding attempt, and it is named that way on
    // purpose: it lands in the header's nonce field, but it is a
    // proof-of-work search counter, not a cryptographic nonce. Calling it
    // `nonce` made CodeQL read `0` flowing into it as a hard-coded
    // cryptographic value and fail the PR on a test fixture.
    fn header(prev: Hash32, time: u32, attempt: u32) -> BlockHeaderBytes {
        let mut raw = [0u8; 80];
        raw[0..4].copy_from_slice(&1u32.to_le_bytes());
        raw[4..36].copy_from_slice(&prev);
        raw[68..72].copy_from_slice(&time.to_le_bytes());
        raw[72..76].copy_from_slice(&0x207f_ffffu32.to_le_bytes());
        raw[76..80].copy_from_slice(&attempt.to_le_bytes());
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
            let mut attempt = 0u32;
            let block = loop {
                let candidate = header(prev, time, attempt);
                if verify_declared_pow(&candidate.0).is_ok() {
                    break candidate;
                }
                attempt += 1;
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

    /// A view bootstrapped from a real checkpoint, so `encode` has a
    /// checkpoint record to reuse. `empty()` cannot be encoded by design.
    fn bootstrapped_view() -> (VerifiedHeaderView, HeaderCheckpoint) {
        let headers = chain(&wobbly_times(1));
        let header = headers[0].clone();
        let commitment = crate::header_verifier::header_leaf(&header);
        let verifier = ShvMmrHeaderVerifier::from_checkpoint_proof(
            0,
            header,
            &[],
            commitment,
            CheckpointProvenance::SelfDerived,
        )
        .expect("single-leaf checkpoint bootstraps")
        .with_asert(
            AsertParams::for_network(Network::Chipnet),
            AsertAnchor::for_network(Network::Chipnet),
        );
        let trusted = HeaderCheckpoint {
            height: 0,
            commitment,
            provenance: CheckpointProvenance::SelfDerived,
        };
        (
            VerifiedHeaderView::with_anchor_interval(Network::Chipnet, verifier, 4),
            trusted,
        )
    }

    #[test]
    fn a_view_survives_a_restart_and_refuses_a_tampered_record() {
        let (view, trusted) = bootstrapped_view();
        let encoded = view.encode().expect("a bootstrapped view encodes");

        let restored = VerifiedHeaderView::restore(&encoded, Network::Chipnet, &trusted)
            .expect("restores against the trusted checkpoint");
        assert_eq!(restored.tip(), view.tip());
        assert_eq!(restored.times().anchors(), view.times().anchors());
        assert_eq!(
            restored.verifier().accumulator().root(),
            view.verifier().accumulator().root()
        );
        assert!(
            restored.verifier().has_difficulty_context(),
            "difficulty context is re-attached, not restored from the file"
        );

        // A commitment the host did not authenticate is refused, even though
        // the record is internally consistent with itself.
        let mut foreign = trusted.clone();
        foreign.commitment[0] ^= 1;
        assert!(VerifiedHeaderView::restore(&encoded, Network::Chipnet, &foreign).is_err());

        // Wrong network.
        assert!(VerifiedHeaderView::restore(&encoded, Network::Mainnet, &trusted).is_err());

        // Garbage and oversized records are refused rather than parsed.
        assert!(matches!(
            VerifiedHeaderView::restore("not json", Network::Chipnet, &trusted),
            Err(HeaderViewError::InvalidPersistedView)
        ));
        let oversized = "x".repeat(MAX_PERSISTED_VIEW_BYTES + 1);
        assert!(matches!(
            VerifiedHeaderView::restore(&oversized, Network::Chipnet, &trusted),
            Err(HeaderViewError::InvalidPersistedView)
        ));
    }

    #[test]
    fn a_restored_view_rejects_a_non_monotonic_time_series() {
        let (view, trusted) = bootstrapped_view();
        let encoded = view.encode().expect("encodes");
        // Splice in anchors whose median-time-past goes backwards. Ordering is
        // the only integrity check a restored series gets, so it has to hold.
        let hash = format!("[{}]", ["0"; 32].join(","));
        let anchors = format!(
            "\"anchors\":[\
             {{\"height\":4,\"block_hash\":{hash},\"median_time_past\":5000}},\
             {{\"height\":8,\"block_hash\":{hash},\"median_time_past\":4000}}]"
        );
        let tampered = encoded.replace("\"anchors\":[]", &anchors);
        assert_ne!(
            tampered, encoded,
            "fixture must actually change the anchors"
        );
        assert!(matches!(
            VerifiedHeaderView::restore(&tampered, Network::Chipnet, &trusted),
            Err(HeaderViewError::TimeIndex(_))
        ));
    }

    /// `getheaders` takes a locator of block hashes, not a height, so a pruned
    /// client can only re-ask for ranges it can still name.
    #[test]
    fn a_locator_is_built_from_retained_anchors_and_bounded_by_them() {
        let mut view = view_with_interval(4);
        let headers = chain(&wobbly_times(60));
        view.extend(&headers).expect("extends");

        let (oldest, newest) = view.retained_span().expect("anchors retained");
        let locator = view.getheaders_locator(newest);
        assert!(!locator.is_empty());
        assert_eq!(
            locator[0],
            crate::header_verifier::header_leaf(&headers[newest as usize]),
            "the locator starts at the newest retained anchor"
        );
        assert_eq!(
            *locator.last().expect("non-empty"),
            crate::header_verifier::header_leaf(&headers[oldest as usize]),
            "and reaches back to the oldest one we still hold"
        );
        // Every entry names a block this view actually verified.
        for hash in &locator {
            assert!(
                headers
                    .iter()
                    .any(|header| crate::header_verifier::header_leaf(header) == *hash),
                "locator must not name a block we never verified"
            );
        }

        // After pruning, the locator shortens rather than naming a pruned block.
        view.prune_below(newest);
        let pruned = view.getheaders_locator(newest);
        assert_eq!(pruned.len(), 1);
        assert!(
            view.getheaders_locator(oldest).is_empty(),
            "nothing to send"
        );
    }

    /// Ordering is an integrity check on a restored series, not authentication.
    /// Re-authentication is the step that binds an anchor back to the
    /// accumulator, and it must reject a proof for a different block.
    #[test]
    fn an_anchor_is_reauthenticated_against_the_block_it_claims() {
        let mut view = view_with_interval(4);
        let headers = chain(&wobbly_times(40));
        view.extend(&headers).expect("extends");

        let anchor = view.times().newest().expect("an anchor");
        let root = view.verifier().accumulator().root();

        // No anchor at that height at all.
        let orphan = HistoricalHeaderProof {
            height: anchor.height + 1,
            header: headers[(anchor.height + 1) as usize].clone(),
            proof: Vec::new(),
            target: root,
        };
        assert!(matches!(
            view.reauthenticate_anchor(Network::Chipnet, &orphan),
            Err(HeaderViewError::NoAnchorAtHeight { .. })
        ));

        // A proof for the right height but the wrong block is refused. It fails
        // the accumulator first, which is the stronger of the two checks.
        let impostor = HistoricalHeaderProof {
            height: anchor.height,
            header: headers[0].clone(),
            proof: Vec::new(),
            target: root,
        };
        assert!(view
            .reauthenticate_anchor(Network::Chipnet, &impostor)
            .is_err());

        // And the accepted-root binding still applies underneath.
        let mut foreign = impostor.clone();
        foreign.target[0] ^= 1;
        assert!(matches!(
            view.reauthenticate_anchor(Network::Chipnet, &foreign),
            Err(HeaderViewError::UnacceptedRoot { .. })
        ));
    }

    /// A peak proof is bound to one of *our* peaks, not to whatever the peer
    /// sent alongside it.
    #[test]
    fn a_peak_proof_binds_to_a_peak_this_runtime_holds() {
        let mut view = view_with_interval(4);
        let headers = chain(&wobbly_times(11));
        view.extend(&headers).expect("extends");

        let accumulator = view.verifier().accumulator();
        assert!(
            accumulator.peak_count() > 1,
            "fixture should have several peaks"
        );

        // Leaf 0 lives under the tallest peak. Rebuild its path to that peak
        // independently of the crate under test.
        let leaves: Vec<[u8; 32]> = headers.iter().map(|h| sha256d(&h.0)).collect();
        let tallest = accumulator.peaks()[0];
        let mut level: Vec<[u8; 32]> = leaves[..8].to_vec();
        let mut siblings = Vec::new();
        let mut index = 0usize;
        while level.len() > 1 {
            siblings.push(level[index ^ 1]);
            let mut next = Vec::with_capacity(level.len() / 2);
            let mut i = 0;
            while i + 1 < level.len() {
                let mut joined = Vec::with_capacity(64);
                joined.extend_from_slice(&level[i]);
                joined.extend_from_slice(&level[i + 1]);
                next.push(sha256d(&joined));
                i += 2;
            }
            level = next;
            index /= 2;
        }
        assert_eq!(level[0], tallest, "rebuilt the tallest peak independently");

        let proof = HistoricalHeaderProof {
            height: 0,
            header: headers[0].clone(),
            proof: siblings.clone(),
            target: tallest,
        };
        assert_eq!(
            view.accept_historical_peak_proof(Network::Chipnet, &proof),
            Ok(Evidence::HeaderMmrProven {
                block_hash: leaves[0],
                height: 0,
            })
        );

        // A peak we do not hold is refused even with a self-consistent proof.
        let mut foreign = proof.clone();
        foreign.target[0] ^= 1;
        assert!(matches!(
            view.accept_historical_peak_proof(Network::Chipnet, &foreign),
            Err(HeaderViewError::UnacceptedRoot { .. })
        ));

        // Wrong network, and a height the accumulator does not commit to.
        assert!(matches!(
            view.accept_historical_peak_proof(Network::Mainnet, &proof),
            Err(HeaderViewError::NetworkMismatch { .. })
        ));
        let mut too_high = proof.clone();
        too_high.height = 10_000;
        assert!(matches!(
            view.accept_historical_peak_proof(Network::Chipnet, &too_high),
            Err(HeaderViewError::HeightOutsideAccumulator { .. })
        ));

        // A tampered sibling fails verification rather than being waved through.
        let mut tampered = proof.clone();
        tampered.proof[0][0] ^= 1;
        assert!(view
            .accept_historical_peak_proof(Network::Chipnet, &tampered)
            .is_err());
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
