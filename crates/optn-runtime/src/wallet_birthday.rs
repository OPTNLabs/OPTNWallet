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
    /// The holder asked for a rescan starting above where this wallet's
    /// history could begin.
    ///
    /// `skipped_below` is the floor the birthday would have used. Everything
    /// under it is outside the scan, including coins received earlier and
    /// still unspent, so the wallet is not complete and must not be shown as
    /// though it were.
    ManualRescan { skipped_below: u32 },
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

/// A rescan the holder asked for, kept apart from the birthday.
///
/// Provenance and instruction are different things. A birthday is a claim
/// about when this wallet's history could start; a rescan is an instruction
/// about what to read now. Storing the instruction in the birthday would let
/// one overwrite the other, which is how a wallet ends up unable to explain
/// why it is not showing an old coin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManualRescan {
    /// Inclusive: the scan covers this block.
    pub from_height: u32,
    /// What had been scanned when the request was made, kept so the wallet can
    /// still say what it knew before.
    pub previous_scanned_through: Option<u32>,
}

/// Durable per-wallet restore state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WalletRestoreState {
    pub birthday: WalletBirthday,
    /// Highest height whose scan result has been accepted for this wallet.
    pub scanned_through: Option<u32>,
    /// An explicit rescan instruction, if one is outstanding.
    ///
    /// `default` so wallets written before rescans existed still load.
    #[serde(default)]
    pub manual_rescan: Option<ManualRescan>,
}

impl WalletRestoreState {
    pub const fn new(birthday: WalletBirthday) -> Self {
        Self {
            birthday,
            scanned_through: None,
            manual_rescan: None,
        }
    }

    /// Ask for a rescan from `height`, inclusive.
    ///
    /// Nothing is cleared. The wallet keeps the history and balances it already
    /// has until the rescan produces results to reconcile against: a wallet
    /// that empties itself the moment a rescan begins is telling its holder
    /// their money is gone, and reservations, pending sends and anything in the
    /// outbox still refer to coins it would have just forgotten.
    ///
    /// Progress is rewound to just below `height` so the requested range is
    /// re-read rather than skipped as already done. Progress below it stays,
    /// because that scan really did happen.
    pub fn request_rescan_from(&mut self, height: u32) {
        self.manual_rescan = Some(ManualRescan {
            from_height: height,
            previous_scanned_through: self.scanned_through,
        });
        self.scanned_through = match height.checked_sub(1) {
            None => None,
            Some(below) => self.scanned_through.map(|current| current.min(below)),
        };
    }

    /// Drop an outstanding rescan instruction.
    ///
    /// For a holder withdrawing the request. Deliberately not called on
    /// completion: a rescan that started above the wallet's birthday leaves
    /// coverage genuinely short, and forgetting the instruction would erase the
    /// only record of why.
    pub fn clear_rescan_request(&mut self) {
        self.manual_rescan = None;
    }

    /// Where the birthday alone says a scan should start.
    ///
    /// `justified_lower_bound` is the caller's, with its justification. There
    /// is deliberately no built-in "recent floor" fallback: a blanket floor
    /// would silently exclude older history for exactly the wallets that need
    /// it most.
    fn birthday_scan_floor(
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

    /// Resolve where a scan should start and what it will cover.
    ///
    /// An outstanding rescan instruction wins over the birthday, in both
    /// directions and for the same reason: the holder said so.
    ///
    /// - An *earlier* height than the birthday justifies is honoured even when
    ///   the birthday is a confident answer, and even when it cannot be
    ///   resolved at all. A stale or wrong start time is exactly what someone
    ///   types a height to escape, so letting the birthday veto it would defeat
    ///   the feature.
    /// - A *later* height is honoured too, but the result is `Incomplete`.
    ///   Coins received below it and never spent are still the holder's, and
    ///   they are not in that scan.
    pub fn scan_floor(
        &self,
        view: &VerifiedHeaderView,
        lookback: u32,
        justified_lower_bound: Option<&JustifiedLowerBound>,
    ) -> ScanFloor {
        let from_birthday = self.birthday_scan_floor(view, lookback, justified_lower_bound);
        let Some(rescan) = self.manual_rescan else {
            return from_birthday;
        };
        let requested = rescan.from_height;
        match from_birthday {
            // At or below what the birthday justifies: the scan covers
            // everything that resolution would have, so any shortfall is the
            // birthday's rather than the rescan's and keeps its own reason.
            ScanFloor::Complete { from_height } if requested <= from_height => {
                ScanFloor::Complete {
                    from_height: requested,
                }
            }
            ScanFloor::Incomplete {
                from_height,
                reason,
            } if requested <= from_height => ScanFloor::Incomplete {
                from_height: requested,
                reason,
            },
            // Above it: the holder narrowed the scan, and that is not complete.
            ScanFloor::Complete { from_height } | ScanFloor::Incomplete { from_height, .. } => {
                ScanFloor::Incomplete {
                    from_height: requested,
                    reason: LowerBoundReason::ManualRescan {
                        skipped_below: from_height,
                    },
                }
            }
            ScanFloor::FullHistory if requested == 0 => ScanFloor::FullHistory,
            ScanFloor::FullHistory => ScanFloor::Incomplete {
                from_height: requested,
                reason: LowerBoundReason::ManualRescan { skipped_below: 0 },
            },
            // The birthday cannot be resolved, but a typed height still can be
            // acted on. Incomplete, because nothing establishes that this
            // wallet's history begins at or above it.
            ScanFloor::Undecidable(_) => ScanFloor::Incomplete {
                from_height: requested,
                reason: LowerBoundReason::ManualRescan { skipped_below: 0 },
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
            manual_rescan: None,
        };
        let encoded = serde_json::to_string(&state).expect("encodes");
        let restored: WalletRestoreState = serde_json::from_str(&encoded).expect("decodes");
        assert_eq!(restored, state);
    }

    /// A typed height is an instruction, and it wins over the birthday.
    ///
    /// Someone typing a height is usually doing it *because* the wallet's
    /// start time is wrong. A birthday that could veto it would defeat the
    /// only escape hatch they have.
    #[test]
    fn an_earlier_manual_height_overrides_a_confident_birthday() {
        let (view, _) = view_with(&rising(40), 4);
        let mut state = WalletRestoreState::new(WalletBirthday::ImportedAtHeight { height: 30 });
        assert_eq!(
            state.scan_floor(&view, 0, None),
            ScanFloor::Complete { from_height: 30 }
        );

        state.request_rescan_from(5);
        assert_eq!(
            state.scan_floor(&view, 0, None),
            ScanFloor::Complete { from_height: 5 },
            "an earlier explicit height should be honoured and still complete"
        );
    }

    /// H is inclusive, and asking for it does not empty the wallet.
    #[test]
    fn a_rescan_rewinds_progress_to_just_below_the_requested_block() {
        let mut state = WalletRestoreState::new(WalletBirthday::Unknown);
        state.record_scanned_through(900);

        state.request_rescan_from(500);
        // Inclusive: block 500 has not been scanned, 499 has.
        assert_eq!(state.scanned_through, Some(499));
        assert_eq!(
            state.manual_rescan,
            Some(ManualRescan {
                from_height: 500,
                previous_scanned_through: Some(900),
            }),
            "what the wallet knew before the request is kept"
        );
    }

    /// A rescan from genesis has nothing below it to have scanned.
    #[test]
    fn a_rescan_from_genesis_clears_progress_rather_than_underflowing() {
        let mut state = WalletRestoreState::new(WalletBirthday::Unknown);
        state.record_scanned_through(900);
        state.request_rescan_from(0);
        assert_eq!(state.scanned_through, None);
    }

    /// Progress below the requested height really did happen; keep it.
    #[test]
    fn a_rescan_above_existing_progress_leaves_it_alone() {
        let mut state = WalletRestoreState::new(WalletBirthday::Unknown);
        state.record_scanned_through(100);
        state.request_rescan_from(500);
        assert_eq!(state.scanned_through, Some(100));
    }

    /// Narrowing the scan is allowed, and it is not complete.
    #[test]
    fn a_later_manual_height_is_honoured_but_reported_incomplete() {
        let (view, _) = view_with(&rising(40), 4);
        let mut state = WalletRestoreState::new(WalletBirthday::ImportedAtHeight { height: 5 });
        state.request_rescan_from(20);
        assert_eq!(
            state.scan_floor(&view, 0, None),
            ScanFloor::Incomplete {
                from_height: 20,
                reason: LowerBoundReason::ManualRescan { skipped_below: 5 },
            },
            "coins received below the chosen height are still the holder's"
        );
    }

    /// An unresolvable birthday must not block an explicit instruction.
    #[test]
    fn a_manual_height_answers_even_when_the_birthday_cannot() {
        let (view, _) = view_with(&rising(12), 4);
        let mut state = WalletRestoreState::new(WalletBirthday::ImportedAtTime {
            // Older than anything retained, so the birthday alone is undecidable.
            requested_time: 1,
        });
        assert!(matches!(
            state.scan_floor(&view, 0, None),
            ScanFloor::Undecidable(_)
        ));

        state.request_rescan_from(3);
        assert_eq!(
            state.scan_floor(&view, 0, None),
            ScanFloor::Incomplete {
                from_height: 3,
                reason: LowerBoundReason::ManualRescan { skipped_below: 0 },
            }
        );
    }

    /// Full history stays full history when that is what was asked for.
    #[test]
    fn a_rescan_from_genesis_over_an_unknown_birthday_is_full_history() {
        let (view, _) = view_with(&rising(12), 4);
        let mut state = WalletRestoreState::new(WalletBirthday::Unknown);
        state.request_rescan_from(0);
        assert_eq!(state.scan_floor(&view, 0, None), ScanFloor::FullHistory);
    }

    /// Withdrawing the request restores the birthday's own answer.
    #[test]
    fn clearing_the_request_returns_to_the_birthday() {
        let (view, _) = view_with(&rising(40), 4);
        let mut state = WalletRestoreState::new(WalletBirthday::ImportedAtHeight { height: 12 });
        state.request_rescan_from(30);
        assert!(matches!(
            state.scan_floor(&view, 0, None),
            ScanFloor::Incomplete { .. }
        ));
        state.clear_rescan_request();
        assert_eq!(
            state.scan_floor(&view, 0, None),
            ScanFloor::Complete { from_height: 12 }
        );
    }

    /// Wallets written before rescans existed still load.
    #[test]
    fn restore_state_without_a_rescan_field_still_decodes() {
        let legacy = r#"{"birthday":{"ImportedAtHeight":{"height":42}},"scanned_through":100}"#;
        let state: WalletRestoreState = serde_json::from_str(legacy).expect("legacy state decodes");
        assert_eq!(state.scanned_through, Some(100));
        assert_eq!(state.manual_rescan, None);
    }
}
