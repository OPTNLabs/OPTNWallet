//! Per-wallet restore metadata: birthday, resolved scan floor, scan progress.
//!
//! Deliberately separate from [`crate::header_view`]. The verified header/time
//! view is shared per network and survives a provider switch; a birthday
//! belongs to one wallet and means something different for a wallet created
//! here than for a seed imported from elsewhere.
//!
//! Nothing in this module talks to a provider. It turns "what do we know about
//! this wallet's origin" plus the runtime's verified view into an explicit
//! decision about what a scan covers — including the answer "we cannot decide".

use serde::{Deserialize, Serialize};

use crate::chain::Hash32;
use crate::header_view::{RestoreStart, RestoreStartUnavailable, VerifiedHeaderView};

/// A verified point on the chain that a wallet's history cannot predate.
///
/// Height alone is not enough: after a reorg the same height is a different
/// block, and a birthday that silently follows a reorg is not an anchor. The
/// hash is what makes it checkable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreationAnchor {
    pub height: u32,
    pub block_hash: Hash32,
}

/// Why a lower bound on a scan is defensible.
///
/// A checkpoint is not one of these. A checkpoint says where verification may
/// begin; it says nothing about when an imported wallet first received funds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum LowerBoundReason {
    /// The network did not exist below this height.
    NetworkGenesis,
    /// A protocol feature this wallet depends on activated at this height.
    FeatureActivation { feature: String },
    /// The user was shown what would be skipped and accepted it.
    UserAccepted,
}

/// A justified floor supplied by the caller, with the justification attached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JustifiedLowerBound {
    pub height: u32,
    pub reason: LowerBoundReason,
}

/// What is known about where a wallet's history starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WalletBirthday {
    /// Created on this device against a verified tip. Nothing earlier exists,
    /// because the wallet did not.
    CreatedAt(CreationAnchor),
    /// Imported, with a date the user supplied.
    ImportedAtTime { requested_time: u32 },
    /// Imported, with a height the user supplied.
    ImportedAtHeight { height: u32 },
    /// Imported with nothing to go on.
    ///
    /// This is *not* "use the current tip". Substituting the import-time tip
    /// for an existing seed's birthday silently discards its entire history.
    Unknown,
}

/// What a scan starting at the resolved floor actually covers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScanFloor {
    /// Complete: no wallet history can exist below `from_height`.
    Complete { from_height: u32 },
    /// Deliberately shortened. History below `from_height` is **not** covered
    /// and the wallet must be presented as incomplete.
    Incomplete {
        from_height: u32,
        reason: LowerBoundReason,
    },
    /// Nothing justifies a floor, so recovery has to cover full history.
    FullHistory,
    /// The verified view cannot answer yet. Not a height, not a guess.
    Undecidable(UndecidableReason),
}

/// Serializable mirror of [`RestoreStartUnavailable`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UndecidableReason {
    NothingVerified,
    /// Anchors exist but their medians have not been re-derived from
    /// authenticated headers since restore. The caller re-authenticates them
    /// and asks again rather than scanning on a value it cannot vouch for.
    AnchorsNotReauthenticated {
        retained_anchors: usize,
    },
    OlderThanRetained {
        oldest_height: u32,
        oldest_median_time_past: u32,
    },
}

impl From<RestoreStartUnavailable> for UndecidableReason {
    fn from(value: RestoreStartUnavailable) -> Self {
        match value {
            RestoreStartUnavailable::NothingVerified => Self::NothingVerified,
            RestoreStartUnavailable::AnchorsNotReauthenticated { retained_anchors } => {
                Self::AnchorsNotReauthenticated { retained_anchors }
            }
            RestoreStartUnavailable::OlderThanRetained {
                oldest_height,
                oldest_median_time_past,
            } => Self::OlderThanRetained {
                oldest_height,
                oldest_median_time_past,
            },
        }
    }
}

/// Durable per-wallet restore state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WalletRestoreState {
    pub birthday: WalletBirthday,
    /// Highest height whose scan result has been accepted for this wallet.
    pub scanned_through: Option<u32>,
}

impl WalletRestoreState {
    pub const fn new(birthday: WalletBirthday) -> Self {
        Self {
            birthday,
            scanned_through: None,
        }
    }

    /// Resolve where a scan should start and what it will cover.
    ///
    /// `justified_lower_bound` is the caller's, with its justification. There
    /// is deliberately no built-in "recent floor" fallback: a blanket floor
    /// would silently exclude older history for exactly the wallets that need
    /// it most.
    pub fn scan_floor(
        &self,
        view: &VerifiedHeaderView,
        lookback: u32,
        justified_lower_bound: Option<&JustifiedLowerBound>,
    ) -> ScanFloor {
        match &self.birthday {
            WalletBirthday::CreatedAt(anchor) => ScanFloor::Complete {
                from_height: anchor.height,
            },
            WalletBirthday::ImportedAtHeight { height } => ScanFloor::Complete {
                from_height: *height,
            },
            WalletBirthday::ImportedAtTime { requested_time } => {
                match view.restore_start_for_time(*requested_time, lookback) {
                    RestoreStart::Height { height, .. } => ScanFloor::Complete {
                        from_height: height,
                    },
                    RestoreStart::Unavailable(reason) => ScanFloor::Undecidable(reason.into()),
                }
            }
            WalletBirthday::Unknown => match justified_lower_bound {
                Some(bound) => ScanFloor::Incomplete {
                    from_height: bound.height,
                    reason: bound.reason.clone(),
                },
                None => ScanFloor::FullHistory,
            },
        }
    }

    /// Re-check a creation anchor against the verified view after a reorg.
    ///
    /// Returns `false` when the view now commits to a different block at the
    /// anchor's height, which means the anchor is stale and the wallet's
    /// birthday must be re-established rather than trusted.
    pub fn creation_anchor_still_holds(&self, view: &VerifiedHeaderView) -> Option<bool> {
        let WalletBirthday::CreatedAt(anchor) = &self.birthday else {
            return None;
        };
        let (tip_height, tip_hash) = view.tip()?;
        if tip_height < anchor.height {
            // The view rolled back past the anchor entirely.
            return Some(false);
        }
        if tip_height == anchor.height {
            return Some(tip_hash == anchor.block_hash);
        }
        // Deeper than the tip: the accumulator commits to it, but confirming
        // *which* block sits there needs a historical proof, which is a
        // separate provider-served step.
        None
    }

    /// Record scan progress. Never moves backwards on its own.
    pub fn record_scanned_through(&mut self, height: u32) {
        self.scanned_through = Some(match self.scanned_through {
            Some(current) => current.max(height),
            None => height,
        });
    }

    /// Invalidate progress at or above a reorg point.
    pub fn invalidate_from(&mut self, height: u32) {
        let Some(current) = self.scanned_through else {
            return;
        };
        if current < height {
            // The reorg is above anything we had accepted.
            return;
        }
        self.scanned_through = height.checked_sub(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::{BlockHeaderBytes, CheckpointProvenance};
    use crate::header_verifier::ShvMmrHeaderVerifier;
    use optn_core::header_hash::sha256d;
    use optn_core::header_pow::verify_declared_pow;
    use optn_core::network::Network;

    fn chain(times: &[u32]) -> Vec<BlockHeaderBytes> {
        let mut out = Vec::new();
        let mut prev = [0u8; 32];
        for &time in times {
            let mut nonce = 0u32;
            let block = loop {
                let mut raw = [0u8; 80];
                raw[0..4].copy_from_slice(&1u32.to_le_bytes());
                raw[4..36].copy_from_slice(&prev);
                raw[68..72].copy_from_slice(&time.to_le_bytes());
                raw[72..76].copy_from_slice(&0x207f_ffffu32.to_le_bytes());
                raw[76..80].copy_from_slice(&nonce.to_le_bytes());
                if verify_declared_pow(&raw).is_ok() {
                    break BlockHeaderBytes(raw);
                }
                nonce += 1;
            };
            prev = sha256d(&block.0);
            out.push(block);
        }
        out
    }

    fn view_with(times: &[u32], interval: u32) -> (VerifiedHeaderView, Vec<BlockHeaderBytes>) {
        let mut view = VerifiedHeaderView::with_anchor_interval(
            Network::Chipnet,
            ShvMmrHeaderVerifier::empty(CheckpointProvenance::SelfDerived),
            interval,
        );
        let headers = chain(times);
        view.extend(&headers).expect("fixture chain verifies");
        (view, headers)
    }

    fn rising(count: usize) -> Vec<u32> {
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
    fn a_wallet_created_here_covers_everything_from_its_anchor() {
        let (view, headers) = view_with(&rising(40), 4);
        let anchor = CreationAnchor {
            height: 30,
            block_hash: sha256d(&headers[30].0),
        };
        let state = WalletRestoreState::new(WalletBirthday::CreatedAt(anchor));
        assert_eq!(
            state.scan_floor(&view, 0, None),
            ScanFloor::Complete { from_height: 30 }
        );
    }

    #[test]
    fn an_unknown_birthday_never_becomes_a_recent_floor() {
        let (view, _) = view_with(&rising(40), 4);
        let state = WalletRestoreState::new(WalletBirthday::Unknown);
        // No justification: full history, not the tip and not a magic number.
        assert_eq!(state.scan_floor(&view, 0, None), ScanFloor::FullHistory);

        // A justified bound shortens the scan, and the result says so.
        let bound = JustifiedLowerBound {
            height: 12,
            reason: LowerBoundReason::UserAccepted,
        };
        assert_eq!(
            state.scan_floor(&view, 0, Some(&bound)),
            ScanFloor::Incomplete {
                from_height: 12,
                reason: LowerBoundReason::UserAccepted,
            }
        );
    }

    #[test]
    fn an_imported_date_older_than_the_index_is_undecidable_not_guessed() {
        let (view, _) = view_with(&rising(40), 4);
        let oldest = view.times().oldest().expect("an anchor");
        let state = WalletRestoreState::new(WalletBirthday::ImportedAtTime {
            requested_time: oldest.median_time_past - 1,
        });
        assert_eq!(
            state.scan_floor(&view, 0, None),
            ScanFloor::Undecidable(UndecidableReason::OlderThanRetained {
                oldest_height: oldest.height,
                oldest_median_time_past: oldest.median_time_past,
            })
        );
    }

    #[test]
    fn an_imported_date_inside_the_index_resolves_conservatively() {
        let (view, _) = view_with(&rising(60), 4);
        let newest = view.times().newest().expect("an anchor");
        let state = WalletRestoreState::new(WalletBirthday::ImportedAtTime {
            requested_time: newest.median_time_past,
        });
        let ScanFloor::Complete { from_height } = state.scan_floor(&view, 8, None) else {
            panic!("expected a resolved floor");
        };
        assert!(from_height <= newest.height);
    }

    #[test]
    fn a_creation_anchor_is_checked_by_hash_not_by_height() {
        let (view, headers) = view_with(&rising(40), 4);
        let (tip_height, tip_hash) = view.tip().expect("a tip");

        let good = WalletRestoreState::new(WalletBirthday::CreatedAt(CreationAnchor {
            height: tip_height,
            block_hash: tip_hash,
        }));
        assert_eq!(good.creation_anchor_still_holds(&view), Some(true));

        // Same height, different block: a reorg, and the anchor is stale.
        let stale = WalletRestoreState::new(WalletBirthday::CreatedAt(CreationAnchor {
            height: tip_height,
            block_hash: sha256d(&headers[0].0),
        }));
        assert_eq!(stale.creation_anchor_still_holds(&view), Some(false));

        // Below the tip the view alone cannot say; that needs a proof.
        let deep = WalletRestoreState::new(WalletBirthday::CreatedAt(CreationAnchor {
            height: tip_height - 5,
            block_hash: sha256d(&headers[0].0),
        }));
        assert_eq!(deep.creation_anchor_still_holds(&view), None);

        // A non-created birthday has no anchor to check.
        assert_eq!(
            WalletRestoreState::new(WalletBirthday::Unknown).creation_anchor_still_holds(&view),
            None
        );
    }

    #[test]
    fn scan_progress_moves_forward_and_is_invalidated_by_a_reorg() {
        let mut state = WalletRestoreState::new(WalletBirthday::ImportedAtHeight { height: 10 });
        state.record_scanned_through(50);
        state.record_scanned_through(40);
        assert_eq!(state.scanned_through, Some(50), "progress never regresses");

        state.invalidate_from(60);
        assert_eq!(state.scanned_through, Some(50), "a later reorg is a no-op");

        state.invalidate_from(30);
        assert_eq!(state.scanned_through, Some(29));

        state.invalidate_from(0);
        assert_eq!(state.scanned_through, None);
    }

    #[test]
    fn restore_state_survives_a_serde_round_trip() {
        let state = WalletRestoreState {
            birthday: WalletBirthday::CreatedAt(CreationAnchor {
                height: 322_831,
                block_hash: [7; 32],
            }),
            scanned_through: Some(322_900),
        };
        let encoded = serde_json::to_string(&state).expect("encodes");
        let restored: WalletRestoreState = serde_json::from_str(&encoded).expect("decodes");
        assert_eq!(restored, state);
    }
}
