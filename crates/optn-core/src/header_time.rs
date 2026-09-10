//! Pure height-for-time primitives for restore scans.
//!
//! A wallet imported with a date needs a *conservative* scan start: a height at
//! or before the first block that could hold the wallet's earliest transaction.
//! This module owns that search and nothing else — no network, no persistence,
//! no provider. `optn-runtime` owns the authoritative index this operates on.
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

/// One retained `(height, median_time_past)` sample.
///
/// The index is sparse on purpose: keeping an anchor every N blocks is what
/// lets header storage be pruned without losing the ability to answer a
/// height-for-time question over the retained range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeAnchor {
    pub height: u32,
    pub median_time_past: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeIndexError {
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

/// Sparse, prune-tolerant `(height -> median-time-past)` index.
///
/// Holds no headers and no hashes: it is the minimum needed to answer "which
/// height should a restore start from", and it stays valid when the header
/// store behind it is pruned.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SparseTimeIndex {
    anchors: Vec<TimeAnchor>,
}

impl SparseTimeIndex {
    pub const fn new() -> Self {
        Self {
            anchors: Vec::new(),
        }
    }

    /// Append an anchor. Rejects any sample that would break height or
    /// median-time monotonicity rather than silently corrupting the search.
    pub fn insert(&mut self, anchor: TimeAnchor) -> Result<(), TimeIndexError> {
        if let Some(last) = self.anchors.last() {
            if anchor.height <= last.height {
                return Err(TimeIndexError::HeightWentBackwards {
                    last: last.height,
                    offered: anchor.height,
                });
            }
            if anchor.median_time_past < last.median_time_past {
                return Err(TimeIndexError::MedianTimeWentBackwards {
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

    pub fn oldest(&self) -> Option<TimeAnchor> {
        self.anchors.first().copied()
    }

    pub fn newest(&self) -> Option<TimeAnchor> {
        self.anchors.last().copied()
    }

    pub fn len(&self) -> usize {
        self.anchors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.anchors.is_empty()
    }

    pub fn anchors(&self) -> &[TimeAnchor] {
        &self.anchors
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
        // A plausible run of timestamps with two backwards steps in it.
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

    fn index_of(samples: &[(u32, u32)]) -> SparseTimeIndex {
        let mut index = SparseTimeIndex::new();
        for &(height, median_time_past) in samples {
            index
                .insert(TimeAnchor {
                    height,
                    median_time_past,
                })
                .expect("monotonic fixture");
        }
        index
    }

    #[test]
    fn an_empty_index_answers_empty_rather_than_guessing() {
        assert_eq!(
            SparseTimeIndex::new().conservative_height_for_time(1_000, 0),
            TimeLookup::Empty
        );
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
        // Exactly on an anchor still selects that anchor.
        assert_eq!(
            index.conservative_height_for_time(6_000, 0),
            TimeLookup::Height(2_000)
        );
        // Between anchors rounds down, never up.
        assert_eq!(
            index.conservative_height_for_time(6_999, 0),
            TimeLookup::Height(2_000)
        );
        // Past the newest anchor still resolves to the newest anchor.
        assert_eq!(
            index.conservative_height_for_time(9_999, 0),
            TimeLookup::Height(3_000)
        );
        // The lookback is applied on top.
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
            index.insert(TimeAnchor {
                height: 900,
                median_time_past: 6_000
            }),
            Err(TimeIndexError::HeightWentBackwards {
                last: 1_000,
                offered: 900
            })
        );
        assert_eq!(
            index.insert(TimeAnchor {
                height: 1_100,
                median_time_past: 4_999
            }),
            Err(TimeIndexError::MedianTimeWentBackwards {
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
        // A question about the pruned range is now reported, not answered.
        assert_eq!(
            index.conservative_height_for_time(5_000, 0),
            TimeLookup::BeforeIndex {
                oldest_height: 2_000,
                oldest_median_time_past: 6_000,
            }
        );
        // The retained range still answers.
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
}
