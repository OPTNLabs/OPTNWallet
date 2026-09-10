//! Retained header anchors: height-for-time search and `getheaders` locators.
//!
//! A wallet imported with a date needs a *conservative* scan start: a height at
//! or before the first block that could hold the wallet's earliest transaction.
//! A client that has pruned headers also needs to be able to ask a peer for a
//! range again, and `getheaders` takes **block hashes**, not heights.
//!
//! Both needs are served by the same sparse set of retained anchors, so this
//! module owns one index carrying height, block hash and median-time-past. It
//! has no network, no persistence and no provider; `optn-runtime` owns the
//! authoritative instance.
//!
//! # Why not a binary search over `nTime`
//!
//! Raw block timestamps are **not** monotonic in height. Consensus only
//! requires a block's timestamp to exceed the *median* of the preceding
//! [`MEDIAN_TIME_SPAN`] blocks, and to be no more than a couple of hours ahead
//! of network-adjusted time. A miner may therefore publish a block whose
//! `nTime` is lower than its parent's, and a plain binary search over `nTime`
//! can walk into the wrong half of the chain.
//!
//! Median-time-past is monotonic, and that is what this module searches.
//! Sliding the 11-block window forward removes one sample and adds a new one
//! that consensus already forced above the old median, so the median can never
//! move backwards.
//!
//! # What an anchor is and is not
//!
//! An anchor records a height that was verified *at the time it was recorded*.
//! Monotonic ordering is an integrity check on the series, not an
//! authentication of it. A restored index becomes trustworthy again only when
//! its anchors are re-checked against accumulator-backed header material; the
//! runtime owns that step, and the block hash retained here is what makes it
//! possible.

use crate::header_hash::Hash32;

/// Blocks in the median-time-past window. Consensus value, not a tunable.
pub const MEDIAN_TIME_SPAN: usize = 11;

/// Blocks subtracted from a resolved height before scanning.
///
/// Covers three separate slacks, all of which push a wallet's real first use
/// *earlier* than the height a timestamp search returns:
///
/// * median-time-past lags the block's own timestamp by roughly half the
///   11-block window;
/// * a block's `nTime` may sit up to two hours ahead of real time, which is
///   another ~12 blocks at a ten-minute target;
/// * a user supplying "the day I made the wallet" is not supplying a block.
///
/// One day of blocks covers all three with room to spare and costs 144
/// merkleblocks, so the default is deliberately generous rather than tight.
pub const DEFAULT_SAFETY_LOOKBACK_BLOCKS: u32 = 144;

/// Dense entries at the head of a `getheaders` locator before the gaps start
/// doubling. Matches the long-standing Bitcoin locator shape.
pub const LOCATOR_DENSE_ENTRIES: usize = 10;

/// Median-time-past of a window of consecutive block timestamps.
///
/// `times` is the window ending at (and including) the block in question,
/// oldest first, at most [`MEDIAN_TIME_SPAN`] entries. Returns `None` for an
/// empty window. Order of the input does not matter to the result; the slice is
/// copied and sorted rather than mutated in place.
pub fn median_time_past(times: &[u32]) -> Option<u32> {
    if times.is_empty() {
        return None;
    }
    let window = times.len().min(MEDIAN_TIME_SPAN);
    let mut recent = times[times.len() - window..].to_vec();
    recent.sort_unstable();
    Some(recent[recent.len() / 2])
}

/// Timestamp field of a serialized 80-byte BCH header.
///
/// A plain field read, not a validation step. Only call it for a header the
/// verifier has already accepted; reading `nTime` out of an unverified header
/// tells you what a peer claimed, not what the chain says.
pub const fn header_timestamp(header: &[u8; 80]) -> u32 {
    u32::from_le_bytes([header[68], header[69], header[70], header[71]])
}

/// One retained anchor: a height, the block that was verified at it, and the
/// median-time-past at that point.
///
/// The block hash is what lets a pruned client rebuild a `getheaders` locator
/// and what lets the runtime re-authenticate the anchor later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeaderAnchor {
    pub height: u32,
    pub block_hash: Hash32,
    pub median_time_past: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderIndexError {
    /// Anchors must be appended in increasing height order.
    HeightWentBackwards { last: u32, offered: u32 },
    /// Median-time-past is monotonic by consensus. A sample that decreases it
    /// means the caller mixed chains, replayed a stale fork, or mis-derived the
    /// window — it is rejected rather than stored.
    MedianTimeWentBackwards { last: u32, offered: u32 },
}

/// What a height-for-time question resolved to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeLookup {
    /// A conservative scan start. Never later than the first block whose
    /// median-time-past reaches the requested instant.
    Height(u32),
    /// The requested instant predates everything retained. The caller must
    /// decide between a full-history scan and reporting the restore as
    /// incomplete; this type deliberately does not guess a height.
    BeforeIndex {
        oldest_height: u32,
        oldest_median_time_past: u32,
    },
    /// Nothing is indexed yet.
    Empty,
}

/// Sparse, prune-tolerant index of verified header anchors.
///
/// Holds no full headers: it is the minimum needed to answer "which height
/// should a restore start from" and "what locator do I send to ask for this
/// range again". It stays valid when the header store behind it is pruned.
///
/// Sparse means one anchor per configured interval, so this is sub-linear in
/// chain length. It is *not* a substitute for retained headers when an
/// operation needs every block hash in a range — a Bloom scan does, and that
/// storage is a separate, linear cost the runtime accounts for on its own.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SparseHeaderIndex {
    anchors: Vec<HeaderAnchor>,
}

impl SparseHeaderIndex {
    pub const fn new() -> Self {
        Self {
            anchors: Vec::new(),
        }
    }

    /// Append an anchor. Rejects any sample that would break height or
    /// median-time monotonicity rather than silently corrupting the search.
    pub fn insert(&mut self, anchor: HeaderAnchor) -> Result<(), HeaderIndexError> {
        if let Some(last) = self.anchors.last() {
            if anchor.height <= last.height {
                return Err(HeaderIndexError::HeightWentBackwards {
                    last: last.height,
                    offered: anchor.height,
                });
            }
            if anchor.median_time_past < last.median_time_past {
                return Err(HeaderIndexError::MedianTimeWentBackwards {
                    last: last.median_time_past,
                    offered: anchor.median_time_past,
                });
            }
        }
        self.anchors.push(anchor);
        Ok(())
    }

    /// Drop anchors below `height`, mirroring a header prune.
    pub fn prune_below(&mut self, height: u32) {
        self.anchors.retain(|anchor| anchor.height >= height);
    }

    /// Drop anchors at or above `height`, mirroring a reorg rollback.
    pub fn rewind_to(&mut self, height: u32) {
        self.anchors.retain(|anchor| anchor.height < height);
    }

    pub fn oldest(&self) -> Option<HeaderAnchor> {
        self.anchors.first().copied()
    }

    pub fn newest(&self) -> Option<HeaderAnchor> {
        self.anchors.last().copied()
    }

    pub fn len(&self) -> usize {
        self.anchors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.anchors.is_empty()
    }

    pub fn anchors(&self) -> &[HeaderAnchor] {
        &self.anchors
    }

    /// The retained height span, if anything is retained.
    pub fn retained_span(&self) -> Option<(u32, u32)> {
        Some((self.oldest()?.height, self.newest()?.height))
    }

    /// The anchor recorded exactly at `height`, if it was one of the retained
    /// ones.
    pub fn anchor_at(&self, height: u32) -> Option<HeaderAnchor> {
        let index = self
            .anchors
            .binary_search_by_key(&height, |anchor| anchor.height)
            .ok()?;
        Some(self.anchors[index])
    }

    /// The newest retained anchor at or below `height`.
    pub fn anchor_at_or_below(&self, height: u32) -> Option<HeaderAnchor> {
        let index = self
            .anchors
            .partition_point(|anchor| anchor.height <= height);
        (index > 0).then(|| self.anchors[index - 1])
    }

    /// Block-hash locator for a `getheaders` starting at or below `height`.
    ///
    /// `getheaders` does not take a height. The peer walks the locator and
    /// replies from the first hash it recognises, so the list runs newest
    /// first: [`LOCATOR_DENSE_ENTRIES`] retained anchors densely, then
    /// exponentially widening gaps, always ending at the oldest anchor we
    /// still hold.
    ///
    /// Only retained anchors appear, so a pruned client asks for the oldest
    /// range it can still name rather than inventing a hash it never verified.
    /// An empty result means nothing at or below `height` is retained and the
    /// caller must recover by another route.
    pub fn locator(&self, height: u32) -> Vec<Hash32> {
        let end = self
            .anchors
            .partition_point(|anchor| anchor.height <= height);
        if end == 0 {
            return Vec::new();
        }
        let mut locator = Vec::new();
        let mut index = end - 1;
        let mut step = 1usize;
        let mut taken = 0usize;
        loop {
            locator.push(self.anchors[index].block_hash);
            taken += 1;
            if index == 0 {
                break;
            }
            if taken > LOCATOR_DENSE_ENTRIES {
                step = step.saturating_mul(2);
            }
            index = index.saturating_sub(step);
        }
        locator
    }

    /// Conservative scan start for `target_time`.
    ///
    /// Resolves to the newest anchor whose median-time-past is still at or
    /// below `target_time`, then steps back `lookback` blocks. Rounding down to
    /// an anchor is what makes a sparse index safe: the answer is early, never
    /// late. The result is clamped to the oldest retained anchor, because
    /// scanning below the retained range is a different decision that belongs
    /// to the caller.
    pub fn conservative_height_for_time(&self, target_time: u32, lookback: u32) -> TimeLookup {
        let Some(oldest) = self.oldest() else {
            return TimeLookup::Empty;
        };
        if target_time < oldest.median_time_past {
            return TimeLookup::BeforeIndex {
                oldest_height: oldest.height,
                oldest_median_time_past: oldest.median_time_past,
            };
        }
        // Anchors are monotonic in both fields, so partition_point is exact.
        let index = self
            .anchors
            .partition_point(|anchor| anchor.median_time_past <= target_time);
        let chosen = self.anchors[index.saturating_sub(1)];
        TimeLookup::Height(chosen.height.saturating_sub(lookback).max(oldest.height))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_of_a_window_ignores_the_order_it_arrives_in() {
        assert_eq!(median_time_past(&[]), None);
        assert_eq!(median_time_past(&[7]), Some(7));
        // Out-of-order timestamps are legal on chain; the median is unchanged.
        assert_eq!(median_time_past(&[10, 30, 20]), Some(20));
        assert_eq!(median_time_past(&[30, 20, 10]), Some(20));
        // Only the trailing MEDIAN_TIME_SPAN samples participate.
        let times: Vec<u32> = (0..20).collect();
        assert_eq!(median_time_past(&times), Some(14));
    }

    /// The property that makes this search sound: a block whose own timestamp
    /// is lower than its parent's does not lower the median.
    #[test]
    fn median_time_past_never_decreases_across_a_backwards_timestamp() {
        let times: [u32; 16] = [
            1000, 1100, 1200, 1300, 1250, 1400, 1500, 1450, 1600, 1700, 1800, 1900, 1850, 2000,
            2100, 2200,
        ];
        let mut previous = 0;
        for end in 1..=times.len() {
            let mtp = median_time_past(&times[..end]).unwrap();
            assert!(
                mtp >= previous,
                "median-time-past went backwards at {end}: {previous} -> {mtp}"
            );
            previous = mtp;
        }
        // Raw nTime, by contrast, does go backwards here — which is exactly why
        // the search key is the median and not the timestamp.
        assert!(times.windows(2).any(|pair| pair[1] < pair[0]));
    }

    fn hash_for(height: u32) -> Hash32 {
        let mut hash = [0u8; 32];
        hash[..4].copy_from_slice(&height.to_le_bytes());
        hash
    }

    fn index_of(samples: &[(u32, u32)]) -> SparseHeaderIndex {
        let mut index = SparseHeaderIndex::new();
        for &(height, median_time_past) in samples {
            index
                .insert(HeaderAnchor {
                    height,
                    block_hash: hash_for(height),
                    median_time_past,
                })
                .expect("monotonic fixture");
        }
        index
    }

    #[test]
    fn an_empty_index_answers_empty_rather_than_guessing() {
        assert_eq!(
            SparseHeaderIndex::new().conservative_height_for_time(1_000, 0),
            TimeLookup::Empty
        );
        assert!(SparseHeaderIndex::new().locator(1_000).is_empty());
        assert_eq!(SparseHeaderIndex::new().retained_span(), None);
    }

    #[test]
    fn a_time_below_the_retained_range_is_reported_not_rounded_up() {
        let index = index_of(&[(1_000, 5_000), (2_000, 6_000)]);
        assert_eq!(
            index.conservative_height_for_time(4_999, 0),
            TimeLookup::BeforeIndex {
                oldest_height: 1_000,
                oldest_median_time_past: 5_000,
            }
        );
    }

    #[test]
    fn resolution_rounds_down_to_an_anchor_and_then_steps_back() {
        let index = index_of(&[(1_000, 5_000), (2_000, 6_000), (3_000, 7_000)]);
        assert_eq!(
            index.conservative_height_for_time(6_000, 0),
            TimeLookup::Height(2_000)
        );
        assert_eq!(
            index.conservative_height_for_time(6_999, 0),
            TimeLookup::Height(2_000)
        );
        assert_eq!(
            index.conservative_height_for_time(9_999, 0),
            TimeLookup::Height(3_000)
        );
        assert_eq!(
            index.conservative_height_for_time(6_000, 144),
            TimeLookup::Height(1_856)
        );
    }

    #[test]
    fn the_lookback_cannot_walk_below_the_retained_range() {
        let index = index_of(&[(1_000, 5_000), (2_000, 6_000)]);
        assert_eq!(
            index.conservative_height_for_time(6_000, 100_000),
            TimeLookup::Height(1_000)
        );
    }

    #[test]
    fn a_resolved_height_is_never_later_than_the_first_block_reaching_the_target() {
        let samples: Vec<(u32, u32)> = (0..40).map(|i| (i * 100, 1_000 + i * 10)).collect();
        let index = index_of(&samples);
        for target in [1_000u32, 1_005, 1_150, 1_155, 1_390] {
            let TimeLookup::Height(start) = index.conservative_height_for_time(target, 0) else {
                panic!("expected a height for {target}");
            };
            let first_at_or_after = samples
                .iter()
                .find(|(_, mtp)| *mtp >= target)
                .map(|(height, _)| *height)
                .unwrap_or(u32::MAX);
            assert!(
                start <= first_at_or_after,
                "start {start} is later than {first_at_or_after} for target {target}"
            );
        }
    }

    #[test]
    fn non_monotonic_samples_are_rejected_instead_of_stored() {
        let mut index = index_of(&[(1_000, 5_000)]);
        assert_eq!(
            index.insert(HeaderAnchor {
                height: 900,
                block_hash: hash_for(900),
                median_time_past: 6_000
            }),
            Err(HeaderIndexError::HeightWentBackwards {
                last: 1_000,
                offered: 900
            })
        );
        assert_eq!(
            index.insert(HeaderAnchor {
                height: 1_100,
                block_hash: hash_for(1_100),
                median_time_past: 4_999
            }),
            Err(HeaderIndexError::MedianTimeWentBackwards {
                last: 5_000,
                offered: 4_999
            })
        );
        assert_eq!(index.len(), 1);
    }

    #[test]
    fn pruning_and_rewinding_keep_the_index_answerable() {
        let mut index = index_of(&[(1_000, 5_000), (2_000, 6_000), (3_000, 7_000)]);

        index.prune_below(2_000);
        assert_eq!(index.oldest().unwrap().height, 2_000);
        assert_eq!(
            index.conservative_height_for_time(5_000, 0),
            TimeLookup::BeforeIndex {
                oldest_height: 2_000,
                oldest_median_time_past: 6_000,
            }
        );
        assert_eq!(
            index.conservative_height_for_time(7_000, 0),
            TimeLookup::Height(3_000)
        );

        index.rewind_to(3_000);
        assert_eq!(index.newest().unwrap().height, 2_000);
        assert_eq!(
            index.conservative_height_for_time(9_999, 0),
            TimeLookup::Height(2_000)
        );
    }

    #[test]
    fn anchors_can_be_looked_up_exactly_or_rounded_down() {
        let index = index_of(&[(1_000, 5_000), (2_000, 6_000), (3_000, 7_000)]);
        assert_eq!(index.anchor_at(2_000).unwrap().block_hash, hash_for(2_000));
        assert_eq!(index.anchor_at(2_500), None, "only retained heights");
        assert_eq!(index.anchor_at_or_below(2_500).unwrap().height, 2_000);
        assert_eq!(index.anchor_at_or_below(999), None);
        assert_eq!(index.retained_span(), Some((1_000, 3_000)));
    }

    /// `getheaders` takes hashes, so the locator is what a pruned client needs
    /// in order to ask for a range at all.
    #[test]
    fn a_locator_runs_newest_first_and_ends_at_the_oldest_retained_anchor() {
        let samples: Vec<(u32, u32)> = (0..40).map(|i| (i * 100, 1_000 + i * 10)).collect();
        let index = index_of(&samples);
        let locator = index.locator(3_900);

        assert_eq!(locator[0], hash_for(3_900), "newest first");
        assert_eq!(
            *locator.last().unwrap(),
            hash_for(0),
            "always reaches the oldest retained anchor"
        );
        // Dense at the head, then widening.
        for (step, entry) in locator.iter().take(LOCATOR_DENSE_ENTRIES).enumerate() {
            assert_eq!(*entry, hash_for(3_900 - (step as u32) * 100));
        }
        assert!(
            locator.len() < samples.len(),
            "gaps widen rather than listing every anchor"
        );
        // No duplicates, and strictly descending by construction.
        let mut seen = locator.clone();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), locator.len());
    }

    #[test]
    fn a_locator_never_names_a_height_we_did_not_retain() {
        let mut index = index_of(&[(1_000, 5_000), (2_000, 6_000), (3_000, 7_000)]);
        index.prune_below(2_000);

        // Asking from above the retained range still starts at what we hold.
        let locator = index.locator(9_999);
        assert_eq!(locator[0], hash_for(3_000));
        assert_eq!(*locator.last().unwrap(), hash_for(2_000));
        assert!(!locator.contains(&hash_for(1_000)), "pruned anchor is gone");

        // Asking from below the retained range yields nothing to send.
        assert!(index.locator(1_500).is_empty());
    }
}
