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
    header_timestamp, median_time_past, AnchorTrust, HeaderAnchor, HeaderIndexError,
    SparseHeaderIndex, TimeLookup, MEDIAN_TIME_SPAN,
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
const PERSISTED_VIEW_SCHEMA: u32 = 3;
/// Schema 2 is schema 3 without the reorg ring, so it is read as one whose
/// ring is empty: nothing in it is misunderstood.
const OLDEST_READABLE_VIEW_SCHEMA: u32 = 2;

/// Blocks a reorg is expected to reach back. BCHN finalizes a block once ten
/// more are built on it, so a deeper reorg is not an ordinary event.
pub const REORG_WINDOW: u32 = 10;

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
    /// Absent before schema 3.
    #[serde(default)]
    ring: Option<PersistedRing>,
}

/// The reorg ring as stored: its oldest state and the headers after it. The
/// states in between are never stored; restore re-derives them by extending
/// the oldest one, and keeps them only if that reproduces the trusted tip.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedRing {
    base: String,
    headers: Vec<Vec<u8>>,
}

/// The view as it stood after one block.
#[derive(Debug, Clone)]
struct ViewSnapshot {
    height: u32,
    verifier: ShvMmrHeaderVerifier,
    window: VecDeque<u32>,
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
    /// The supplied median-time window is the wrong length, does not link, or
    /// carries no usable timestamps.
    UnusableTimeWindow {
        height: u32,
    },
    /// A rollback named a height the reorg ring does not hold.
    NoSnapshotAtHeight {
        height: u32,
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
    /// Anchors were restored but their medians have not been re-derived from
    /// authenticated headers. Recoverable, and deliberately not an answer.
    AnchorsNotReauthenticated { retained_anchors: usize },
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
    /// The view after each of the last [`REORG_WINDOW`] blocks and the one
    /// before them, oldest first. A reorg rolls back to a state the verifier
    /// really had: the accumulator is append-only and is never edited.
    snapshots: VecDeque<ViewSnapshot>,
    /// The headers after the oldest snapshot, one per later snapshot, so a
    /// stored ring can be re-derived and checked against the trusted tip.
    ring_headers: VecDeque<BlockHeaderBytes>,
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
            snapshots: VecDeque::new(),
            ring_headers: VecDeque::new(),
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

        // Stage every part of the view together. The verifier, the anchor
        // index and the median window are one logical version: advancing the
        // accumulator and then failing to record an anchor would leave them at
        // different heights, and the next extend would compute the wrong
        // median from a window that never saw the missing block.
        let mut staged = self.clone();
        if staged.snapshots.is_empty() {
            // The state before this batch is where a reorg of its first block
            // would roll back to.
            staged.push_snapshot(None);
        }
        for (offset, header) in headers.iter().enumerate() {
            let height = first_height + offset as u64;
            // One header at a time, so the ring holds the state after each.
            staged.verifier.extend(std::slice::from_ref(header))?;
            // The leaf the accumulator just committed to is this block's hash;
            // retaining it is what lets a pruned client build a `getheaders`
            // locator and re-authenticate the anchor later.
            staged.record_anchor(
                height,
                crate::header_verifier::header_leaf(header),
                header_timestamp(&header.0),
            )?;
            staged.push_snapshot(Some(header));
        }
        *self = staged;
        Ok(())
    }

    /// Keep the current state in the reorg ring, `header` being the block
    /// that produced it. The first state kept is the ring's base.
    fn push_snapshot(&mut self, header: Option<&BlockHeaderBytes>) {
        let Ok(state) = self.verifier.state() else {
            return;
        };
        if let (Some(header), false) = (header, self.snapshots.is_empty()) {
            self.ring_headers.push_back(header.clone());
        }
        self.snapshots.push_back(ViewSnapshot {
            height: state.height,
            verifier: self.verifier.clone(),
            window: self.window.clone(),
        });
        while self.snapshots.len() > REORG_WINDOW as usize + 1 {
            self.snapshots.pop_front();
            self.ring_headers.pop_front();
        }
    }

    /// Roll the view back to the state it had after block `height`, one of the
    /// last [`REORG_WINDOW`] blocks.
    ///
    /// The accumulator is append-only, so this does not edit its peaks: it
    /// returns to a state the verifier actually had. Extending from here gives
    /// exactly what extending straight to the same headers would have.
    pub fn rollback_to(&mut self, height: u32) -> Result<(), HeaderViewError> {
        let index = self
            .snapshots
            .iter()
            .position(|snapshot| snapshot.height == height)
            .ok_or(HeaderViewError::NoSnapshotAtHeight { height })?;
        let snapshot = self.snapshots[index].clone();
        self.verifier = snapshot.verifier;
        self.window = snapshot.window;
        self.snapshots.truncate(index + 1);
        self.ring_headers.truncate(index);
        self.times.rewind_to(height.saturating_add(1));
        Ok(())
    }

    /// The oldest height a rollback can reach, if any.
    pub fn rollback_floor(&self) -> Option<u32> {
        self.snapshots.front().map(|snapshot| snapshot.height)
    }

    /// Whether `block` is this view's tip or a block its reorg ring holds:
    /// a height and hash these verified headers vouch for.
    pub fn holds(&self, block: (u32, Hash32)) -> bool {
        self.tip() == Some(block) || self.ring_hash_at(block.0) == Some(block.1)
    }

    /// The hash of this view's block at `height`, while the ring holds it.
    pub fn ring_hash_at(&self, height: u32) -> Option<Hash32> {
        self.snapshots
            .iter()
            .find(|snapshot| snapshot.height == height)
            .and_then(|snapshot| snapshot.verifier.last_hash())
    }

    /// This view's headers above `height` that the ring holds, oldest first:
    /// what a rollback to `height` would orphan.
    pub fn ring_headers_above(&self, height: u32) -> Vec<BlockHeaderBytes> {
        let Some(floor) = self.rollback_floor() else {
            return Vec::new();
        };
        self.ring_headers
            .iter()
            .enumerate()
            .filter(|(index, _)| floor.saturating_add(1).saturating_add(*index as u32) > height)
            .map(|(_, header)| header.clone())
            .collect()
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
            // Derived here, from headers this verifier just accepted.
            trust: AnchorTrust::Authenticated,
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
            TimeLookup::Unauthenticated { retained_anchors } => {
                RestoreStart::Unavailable(RestoreStartUnavailable::AnchorsNotReauthenticated {
                    retained_anchors,
                })
            }
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

    /// Re-derive a restored anchor's median from an authenticated header
    /// window, without needing a proof server.
    ///
    /// `window` is the consecutive run of headers ending at the anchor, oldest
    /// first — the same eleven blocks consensus uses, or fewer near the start
    /// of the chain. It is authenticated the way any header range is: each
    /// header must link to its predecessor, and the last must hash to the block
    /// the anchor already names. That final equality is what ties the window to
    /// something already accepted; eleven arbitrary timestamps are not
    /// median-time context.
    ///
    /// The recomputed median must equal the stored one. A mismatch drops the
    /// anchor rather than correcting it: a saved value that disagrees with the
    /// chain says the snapshot cannot be trusted piecemeal.
    ///
    /// Deliberately independent of SHV. Requiring a proof here would make the
    /// compatibility path depend on the very service it exists to do without.
    pub fn reauthenticate_anchor_window(
        &mut self,
        height: u32,
        window: &[BlockHeaderBytes],
    ) -> Result<(), HeaderViewError> {
        let Some(anchor) = self.times.anchor_at(height) else {
            return Err(HeaderViewError::NoAnchorAtHeight { height });
        };
        if window.is_empty() {
            return Err(HeaderViewError::UnusableTimeWindow { height });
        }
        // Near the chain start the window is shorter, exactly as the median is.
        let expected = MEDIAN_TIME_SPAN.min(height as usize + 1);
        if window.len() != expected {
            return Err(HeaderViewError::UnusableTimeWindow { height });
        }

        let mut previous: Option<Hash32> = None;
        let mut times = Vec::with_capacity(window.len());
        for header in window {
            let parsed = optn_core::header_pow::verify_declared_pow(&header.0)
                .map_err(|error| HeaderViewError::Verification(ShvMmrError::Header(error)))?;
            if let Some(expected_prev) = previous {
                if parsed.prev_hash != expected_prev {
                    return Err(HeaderViewError::UnusableTimeWindow { height });
                }
            }
            times.push(parsed.time);
            previous = Some(parsed.hash);
        }
        // The window only means anything because it terminates at the block the
        // anchor already commits to.
        if previous != Some(anchor.block_hash) {
            return Err(HeaderViewError::AnchorMismatch {
                height,
                retained: anchor.block_hash,
            });
        }

        let recomputed =
            median_time_past(&times).ok_or(HeaderViewError::UnusableTimeWindow { height })?;
        self.times.authenticate(height, recomputed)?;
        Ok(())
    }

    /// Retained anchors, and how many have been re-derived. Surfaced so a
    /// caller can report coverage instead of implying full authentication.
    pub fn anchor_authentication(&self) -> (usize, usize) {
        (self.times.authenticated_count(), self.times.len())
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
            ring: self
                .snapshots
                .front()
                .map(|base| -> Result<PersistedRing, HeaderViewError> {
                    Ok(PersistedRing {
                        base: base.verifier.encode_checkpoint_json(self.network)?,
                        headers: self
                            .ring_headers
                            .iter()
                            .map(|header| header.0.to_vec())
                            .collect(),
                    })
                })
                .transpose()?,
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
        if !(OLDEST_READABLE_VIEW_SCHEMA..=PERSISTED_VIEW_SCHEMA).contains(&record.schema)
            || record.network != network.to_string()
        {
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
                // Ordering survived the round trip; the timestamps behind the
                // median did not come back authenticated. Until they are
                // re-derived these are retrieval hints, not date answers.
                trust: AnchorTrust::Provisional,
            })?;
        }
        // The trailing window feeds the next median, so a restored one is
        // untrusted for the same reason and is rebuilt from live headers.
        view.window.clear();
        if let Some(ring) = record.ring {
            let (snapshots, ring_headers) =
                replay_ring(ring, network, record.anchor_interval, trusted)?;
            view.snapshots = snapshots;
            view.ring_headers = ring_headers;
        }
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

/// Re-derive a stored reorg ring and keep it only if it reaches `trusted`.
///
/// The stored base is loaded at the commitment it claims and extended with
/// the stored headers, which are checked like any others: linkage,
/// proof-of-work, difficulty. Only if that ends at the trusted tip are the
/// states kept, and they are the ones the replay produced, never stored ones.
fn replay_ring(
    ring: PersistedRing,
    network: Network,
    anchor_interval: u32,
    trusted: &HeaderCheckpoint,
) -> Result<(VecDeque<ViewSnapshot>, VecDeque<BlockHeaderBytes>), HeaderViewError> {
    if ring.headers.len() > REORG_WINDOW as usize {
        return Err(HeaderViewError::InvalidPersistedView);
    }
    let headers = ring
        .headers
        .into_iter()
        .map(|bytes| <[u8; 80]>::try_from(bytes).map(BlockHeaderBytes))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| HeaderViewError::InvalidPersistedView)?;
    let claimed = ShvMmrHeaderVerifier::claimed_checkpoint(&ring.base)?;
    let base = ShvMmrHeaderVerifier::from_checkpoint_json(&ring.base, network, &claimed)?
        .with_asert(
            AsertParams::for_network(network),
            AsertAnchor::for_network(network),
        );
    let mut replay = VerifiedHeaderView::with_anchor_interval(network, base, anchor_interval);
    replay.push_snapshot(None);
    replay.extend(&headers)?;
    let reached = replay.checkpoint();
    if reached.height != trusted.height || reached.commitment != trusted.commitment {
        return Err(HeaderViewError::InvalidPersistedView);
    }
    Ok((replay.snapshots, replay.ring_headers))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::CheckpointProvenance;
    use optn_core::header_hash::sha256d;

    /// Build a linkable header. `bits` stays at regtest's proof-of-work limit
    /// so declared proof-of-work passes with little grinding, which makes
    /// these regtest chains: under any other network's limit the headers
    /// would be refused.
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
            Network::Regtest,
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
            AsertParams::for_network(Network::Regtest),
            AsertAnchor::for_network(Network::Regtest),
        );
        let trusted = HeaderCheckpoint {
            height: 0,
            commitment,
            provenance: CheckpointProvenance::SelfDerived,
        };
        (
            VerifiedHeaderView::with_anchor_interval(Network::Regtest, verifier, 4),
            trusted,
        )
    }

    #[test]
    fn a_view_survives_a_restart_and_refuses_a_tampered_record() {
        let (view, trusted) = bootstrapped_view();
        let encoded = view.encode().expect("a bootstrapped view encodes");

        let restored = VerifiedHeaderView::restore(&encoded, Network::Regtest, &trusted)
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
        assert!(VerifiedHeaderView::restore(&encoded, Network::Regtest, &foreign).is_err());

        // Wrong network.
        assert!(VerifiedHeaderView::restore(&encoded, Network::Mainnet, &trusted).is_err());

        // Garbage and oversized records are refused rather than parsed.
        assert!(matches!(
            VerifiedHeaderView::restore("not json", Network::Regtest, &trusted),
            Err(HeaderViewError::InvalidPersistedView)
        ));
        let oversized = "x".repeat(MAX_PERSISTED_VIEW_BYTES + 1);
        assert!(matches!(
            VerifiedHeaderView::restore(&oversized, Network::Regtest, &trusted),
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
            VerifiedHeaderView::restore(&tampered, Network::Regtest, &trusted),
            Err(HeaderViewError::TimeIndex(_))
        ));
    }

    /// Whole-operation atomicity.
    ///
    /// `extend` validates through the verifier before it touches the anchor
    /// index. A failure in the second half must not leave the accumulator ahead
    /// of the index: the next extend would then compute a median from a window
    /// that never saw the missing block.
    #[test]
    fn a_failure_after_verifier_validation_advances_nothing() {
        let mut view = view_with_interval(1);
        // Rising timestamps first, so anchors exist and the median is high.
        let rising = (0..24u32)
            .map(|i| 1_600_000_000 + i * 600)
            .collect::<Vec<_>>();
        let headers = chain(&rising);
        view.extend(&headers).expect("rising chain extends");

        let tip_before = view.tip().expect("a tip");
        let anchors_before = view.times().anchors().to_vec();
        let root_before = view.verifier().accumulator().root();

        // A continuation whose timestamps collapse, dragging the sliding
        // median backwards. The headers themselves are valid and link, so the
        // verifier accepts them and the index is what refuses.
        let mut collapsing = rising.clone();
        collapsing.extend((0..12).map(|_| 1_500_000_000u32));
        let longer = chain(&collapsing);
        let error = view
            .extend(&longer[headers.len()..])
            .expect_err("a falling median must be refused");
        assert!(
            matches!(error, HeaderViewError::TimeIndex(_)),
            "expected the index to refuse, got {error:?}"
        );

        assert_eq!(view.tip(), Some(tip_before), "the tip did not move");
        assert_eq!(
            view.verifier().accumulator().root(),
            root_before,
            "the accumulator did not advance"
        );
        assert_eq!(
            view.times().anchors(),
            anchors_before.as_slice(),
            "the index did not advance"
        );
        // And the view is still usable afterwards.
        let (authenticated, retained) = view.anchor_authentication();
        assert_eq!(authenticated, retained);
    }

    /// A restored snapshot is monotonic but not authenticated. Its medians must
    /// not answer a date question until they are re-derived.
    #[test]
    fn restored_anchors_are_provisional_until_reauthenticated() {
        let (mut view, _) = bootstrapped_view();
        let headers = chain(&wobbly_times(40));
        view.extend(&headers[1..])
            .expect("extends past the checkpoint");
        // The host persists the commitment for the state it actually saved.
        let trusted = view.checkpoint();
        let (authenticated, retained) = view.anchor_authentication();
        assert!(retained > 0 && authenticated == retained);

        let encoded = view.encode().expect("encodes");
        let restored =
            VerifiedHeaderView::restore(&encoded, Network::Regtest, &trusted).expect("restores");

        let (authenticated, retained) = restored.anchor_authentication();
        assert_eq!(authenticated, 0, "nothing comes back authenticated");
        assert!(retained > 0, "but the anchors are still there");

        // A date question is refused, and says why, rather than answered from
        // a value nobody has vouched for.
        assert_eq!(
            restored.restore_start_for_time(u32::MAX, 0),
            RestoreStart::Unavailable(RestoreStartUnavailable::AnchorsNotReauthenticated {
                retained_anchors: retained,
            })
        );
        // The hashes remain usable as retrieval hints -- that is the point of
        // keeping them.
        assert!(!restored.getheaders_locator(u32::MAX).is_empty());
    }

    /// The non-SHV path: re-derive the median from a linked header window.
    ///
    /// Also the case the directive singles out -- a genuine block, an altered
    /// but still-monotonic saved median -- which must be refused.
    #[test]
    fn a_window_reauthenticates_an_anchor_and_catches_an_altered_median() {
        let (mut view, _) = bootstrapped_view();
        let times = wobbly_times(40);
        let headers = chain(&times);
        view.extend(&headers[1..]).expect("extends");
        let trusted = view.checkpoint();
        let encoded = view.encode().expect("encodes");

        let anchor = view.times().newest().expect("an anchor");
        let height = anchor.height as usize;
        let window_len = MEDIAN_TIME_SPAN.min(height + 1);
        let window = &headers[height + 1 - window_len..=height];

        // Honest snapshot: the window re-derives the stored median.
        let mut restored =
            VerifiedHeaderView::restore(&encoded, Network::Regtest, &trusted).expect("restores");
        restored
            .reauthenticate_anchor_window(anchor.height, window)
            .expect("an honest window re-derives the stored median");
        assert!(restored
            .times()
            .anchor_at(anchor.height)
            .expect("still retained")
            .is_authenticated());

        // A window that does not terminate at the block the anchor names.
        let mut restored =
            VerifiedHeaderView::restore(&encoded, Network::Regtest, &trusted).expect("restores");
        let wrong = &headers[..window_len];
        assert!(matches!(
            restored.reauthenticate_anchor_window(anchor.height, wrong),
            Err(HeaderViewError::AnchorMismatch { .. })
        ));

        // A window of the wrong length, and one that does not link.
        let mut broken = window.to_vec();
        broken.pop();
        assert!(matches!(
            restored.reauthenticate_anchor_window(anchor.height, &broken),
            Err(HeaderViewError::UnusableTimeWindow { .. })
        ));
        let mut unlinked = window.to_vec();
        unlinked[1] = headers[0].clone();
        assert!(matches!(
            restored.reauthenticate_anchor_window(anchor.height, &unlinked),
            Err(HeaderViewError::UnusableTimeWindow { .. })
        ));

        // The altered-median case: the snapshot's ordering still holds, the
        // block is genuine, and the stored time is a lie.
        let stored = format!("\"median_time_past\":{}", anchor.median_time_past);
        let bumped = format!("\"median_time_past\":{}", anchor.median_time_past + 1);
        let altered = encoded.replace(&stored, &bumped);
        assert_ne!(altered, encoded, "fixture must change the saved median");
        let mut tampered = VerifiedHeaderView::restore(&altered, Network::Regtest, &trusted)
            .expect("an altered-but-monotonic snapshot still loads");
        let error = tampered
            .reauthenticate_anchor_window(anchor.height, window)
            .expect_err("the recomputed median must not match");
        assert!(
            matches!(
                error,
                HeaderViewError::TimeIndex(
                    optn_core::header_time::HeaderIndexError::MedianTimeMismatch { .. }
                )
            ),
            "expected a median mismatch, got {error:?}"
        );
        // The anchor is dropped rather than corrected.
        assert!(tampered.times().anchor_at(anchor.height).is_none());
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
            view.reauthenticate_anchor(Network::Regtest, &orphan),
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
            .reauthenticate_anchor(Network::Regtest, &impostor)
            .is_err());

        // And the accepted-root binding still applies underneath.
        let mut foreign = impostor.clone();
        foreign.target[0] ^= 1;
        assert!(matches!(
            view.reauthenticate_anchor(Network::Regtest, &foreign),
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
            view.accept_historical_peak_proof(Network::Regtest, &proof),
            Ok(Evidence::HeaderMmrProven {
                block_hash: leaves[0],
                height: 0,
            })
        );

        // A peak we do not hold is refused even with a self-consistent proof.
        let mut foreign = proof.clone();
        foreign.target[0] ^= 1;
        assert!(matches!(
            view.accept_historical_peak_proof(Network::Regtest, &foreign),
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
            view.accept_historical_peak_proof(Network::Regtest, &too_high),
            Err(HeaderViewError::HeightOutsideAccumulator { .. })
        ));

        // A tampered sibling fails verification rather than being waved through.
        let mut tampered = proof.clone();
        tampered.proof[0][0] ^= 1;
        assert!(view
            .accept_historical_peak_proof(Network::Regtest, &tampered)
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
                expected: Network::Regtest,
                actual: Network::Mainnet,
            })
        );

        // A root this runtime never accepted is refused even though the proof
        // is internally consistent with it.
        let mut foreign = proof.clone();
        foreign.target[0] ^= 1;
        assert!(matches!(
            view.accept_historical_proof(Network::Regtest, &foreign),
            Err(HeaderViewError::UnacceptedRoot { .. })
        ));

        // A height the accumulator does not commit to is refused.
        let mut too_high = proof.clone();
        too_high.height = 10_000;
        assert!(matches!(
            view.accept_historical_proof(Network::Regtest, &too_high),
            Err(HeaderViewError::HeightOutsideAccumulator { .. })
        ));

        // An empty sibling list for a non-trivial tree fails verification
        // rather than being waved through.
        assert!(view
            .accept_historical_proof(Network::Regtest, &proof)
            .is_err());
        proof.proof.clear();
    }

    /// Headers that build on `prev`, ground to the regtest limit.
    fn chain_from(mut prev: Hash32, times: &[u32]) -> Vec<BlockHeaderBytes> {
        use optn_core::header_pow::verify_declared_pow;
        let mut out = Vec::new();
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

    /// Rolling back to a block in the ring and extending again gives exactly
    /// what a straight extension gives, and another branch is accepted from
    /// the same point: a reorg, without editing the accumulator.
    #[test]
    fn a_rollback_then_extension_matches_a_straight_extension() {
        let headers = chain(&wobbly_times(30));
        let (mut straight, _) = bootstrapped_view();
        straight.extend(&headers[1..]).unwrap();
        let (mut rolled, _) = bootstrapped_view();
        rolled.extend(&headers[1..]).unwrap();
        let tip = rolled.tip().unwrap().0;
        let fork_point = tip - 4;

        rolled.rollback_to(fork_point).unwrap();
        assert_eq!(
            rolled.tip(),
            Some((
                fork_point,
                crate::header_verifier::header_leaf(&headers[fork_point as usize])
            ))
        );
        assert!(rolled
            .times()
            .anchors()
            .iter()
            .all(|anchor| anchor.height <= fork_point));
        rolled.extend(&headers[fork_point as usize + 1..]).unwrap();
        assert_eq!(rolled.checkpoint(), straight.checkpoint());

        // Another branch from the same block.
        rolled.rollback_to(fork_point).unwrap();
        let branch = chain_from(
            crate::header_verifier::header_leaf(&headers[fork_point as usize]),
            &[
                2_000_000_000,
                2_000_000_600,
                2_000_001_200,
                2_000_001_800,
                2_000_002_400,
            ],
        );
        rolled.extend(&branch).unwrap();
        assert_eq!(rolled.tip().unwrap().0, fork_point + 5);
        assert_ne!(rolled.checkpoint(), straight.checkpoint());
    }

    #[test]
    fn the_ring_holds_the_reorg_window_and_no_further() {
        let headers = chain(&wobbly_times(30));
        let (mut view, _) = bootstrapped_view();
        view.extend(&headers[1..]).unwrap();
        let tip = view.tip().unwrap().0;
        assert_eq!(view.rollback_floor(), Some(tip - REORG_WINDOW));
        let below = tip - REORG_WINDOW - 1;
        assert_eq!(
            view.rollback_to(below),
            Err(HeaderViewError::NoSnapshotAtHeight { height: below })
        );
        assert_eq!(
            view.tip().unwrap().0,
            tip,
            "a refused rollback changes nothing"
        );

        // Fewer blocks than the window: the ring reaches back to the start.
        let (mut short, _) = bootstrapped_view();
        short.extend(&headers[1..4]).unwrap();
        assert_eq!(short.rollback_floor(), Some(0));
        short.rollback_to(0).unwrap();
        assert_eq!(short.tip().unwrap().0, 0);
    }

    /// A stored ring is re-derived from its oldest state and the headers
    /// after it, and kept only if that reaches the trusted tip.
    #[test]
    fn a_stored_ring_is_rederived_and_must_reach_the_trusted_tip() {
        let headers = chain(&wobbly_times(30));
        let (mut view, _) = bootstrapped_view();
        view.extend(&headers[1..]).unwrap();
        let trusted = view.checkpoint();
        let encoded = view.encode().unwrap();
        let tip = view.tip().unwrap().0;

        let mut restored =
            VerifiedHeaderView::restore(&encoded, Network::Regtest, &trusted).unwrap();
        assert_eq!(restored.rollback_floor(), view.rollback_floor());
        restored.rollback_to(tip - 2).unwrap();
        restored.extend(&headers[tip as usize - 1..]).unwrap();
        assert_eq!(restored.checkpoint(), trusted);

        // One stored header altered.
        let mut altered: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        let byte = &mut altered["ring"]["headers"][3][40];
        *byte = serde_json::json!(byte.as_u64().unwrap() ^ 1);
        assert!(
            VerifiedHeaderView::restore(&altered.to_string(), Network::Regtest, &trusted).is_err()
        );
        // A ring that stops short of the trusted tip.
        let mut short: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        short["ring"]["headers"].as_array_mut().unwrap().pop();
        assert!(
            VerifiedHeaderView::restore(&short.to_string(), Network::Regtest, &trusted).is_err()
        );
        // A ring longer than the window is not read at all.
        let mut long: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        let first = long["ring"]["headers"][0].clone();
        long["ring"]["headers"].as_array_mut().unwrap().push(first);
        assert!(
            VerifiedHeaderView::restore(&long.to_string(), Network::Regtest, &trusted).is_err()
        );
    }

    #[test]
    fn a_schema_2_record_reads_with_an_empty_ring() {
        let headers = chain(&wobbly_times(12));
        let (mut view, _) = bootstrapped_view();
        view.extend(&headers[1..]).unwrap();
        let trusted = view.checkpoint();
        let mut record: serde_json::Value = serde_json::from_str(&view.encode().unwrap()).unwrap();
        assert_eq!(record["schema"], 3);
        record["schema"] = serde_json::json!(2);
        record.as_object_mut().unwrap().remove("ring");
        let restored =
            VerifiedHeaderView::restore(&record.to_string(), Network::Regtest, &trusted).unwrap();
        assert_eq!(restored.rollback_floor(), None);
        assert_eq!(restored.tip(), view.tip());

        record["schema"] = serde_json::json!(4);
        assert!(
            VerifiedHeaderView::restore(&record.to_string(), Network::Regtest, &trusted).is_err()
        );
    }
}
