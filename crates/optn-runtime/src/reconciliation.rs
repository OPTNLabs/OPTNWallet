//! Evidence-aware reconciliation for issue #75.
//!
//! Providers never overwrite wallet state directly. A caller supplies a typed
//! candidate snapshot plus whether the provider completed the requested scope;
//! incomplete/failed work preserves the last authoritative snapshot.

use crate::chain::{Evidence, Hash32, SourceId, VerificationState, WalletSyncState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciledSnapshot<T> {
    pub value: T,
    pub source: SourceId,
    pub evidence: Evidence,
    pub chain_tip: Option<(u32, Hash32)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciliationState<T> {
    pub authoritative: Option<ReconciledSnapshot<T>>,
    pub sync: WalletSyncState,
}

impl<T> Default for ReconciliationState<T> {
    fn default() -> Self {
        Self {
            authoritative: None,
            sync: WalletSyncState::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconciliationDecision {
    Accepted,
    PreservedIncomplete,
    PreservedWeakerEvidence,
    PreservedFailure,
}

impl<T: Clone> ReconciliationState<T> {
    /// Apply a complete candidate snapshot. `complete=false` means a timeout,
    /// partial scan, truncated history, or any other response that cannot prove
    /// the requested wallet scope. Such a result must never clear old state.
    pub fn reconcile_candidate(
        &mut self,
        candidate: T,
        source: SourceId,
        evidence: Evidence,
        chain_tip: Option<(u32, Hash32)>,
        complete: bool,
    ) -> ReconciliationDecision {
        if !complete {
            self.sync.history_fresh = false;
            self.sync.utxos_fresh = false;
            self.sync.verification = VerificationState::Degraded;
            self.sync.degraded_reason = Some("provider response incomplete".into());
            return ReconciliationDecision::PreservedIncomplete;
        }

        if let Some(current) = &self.authoritative {
            // Never replace stronger cryptographic evidence with a weaker server
            // assertion merely because that server answered later/faster.
            if evidence_strength(&evidence) < evidence_strength(&current.evidence) {
                self.sync.history_fresh = false;
                self.sync.utxos_fresh = false;
                self.sync.degraded_reason =
                    Some("candidate evidence is weaker than the retained snapshot".into());
                return ReconciliationDecision::PreservedWeakerEvidence;
            }
        }

        self.authoritative = Some(ReconciledSnapshot {
            value: candidate,
            source: source.clone(),
            evidence: evidence.clone(),
            chain_tip,
        });
        self.sync.primary_source = Some(source);
        self.sync.chain_tip = chain_tip;
        self.sync.history_fresh = true;
        self.sync.utxos_fresh = true;
        self.sync.verification = verification_state_for(&evidence);
        self.sync.degraded_reason = None;
        ReconciliationDecision::Accepted
    }

    /// [`Self::reconcile_candidate`] for a wallet refresh.
    ///
    /// The evidence rule protects a snapshot from a weaker one about the same
    /// chain. It must not keep the wallet at an old tip forever once its
    /// stronger source is gone, as when a holder moves from BIP37 to
    /// Electrum. So a weaker candidate is accepted when its tip is newer than
    /// the retained one and `verified` vouches for that tip: a server
    /// asserting a height is not enough. The downgrade is labelled in the
    /// verification state and the degraded reason. At the same or an older
    /// tip, or at an unverified one, the stronger snapshot stays.
    pub fn reconcile_refresh(
        &mut self,
        candidate: T,
        source: SourceId,
        evidence: Evidence,
        chain_tip: Option<(u32, Hash32)>,
        verified: impl Fn((u32, Hash32)) -> bool,
    ) -> ReconciliationDecision {
        let replaced = self.authoritative.as_ref().and_then(|current| {
            let tip = chain_tip?;
            let weaker = evidence_strength(&evidence) < evidence_strength(&current.evidence);
            let newer = current.chain_tip.is_some_and(|(height, _)| tip.0 > height);
            (weaker && newer && verified(tip)).then(|| current.evidence.clone())
        });
        let Some(replaced) = replaced else {
            return self.reconcile_candidate(candidate, source, evidence, chain_tip, true);
        };
        let lowered = evidence_label(&evidence);
        self.authoritative = None;
        let decision = self.reconcile_candidate(candidate, source, evidence, chain_tip, true);
        self.sync.degraded_reason = Some(format!(
            "evidence lowered from {} to {lowered} at a newer verified tip",
            evidence_label(&replaced)
        ));
        decision
    }

    /// Say why something beside the snapshot is behind (headers that did not
    /// advance) without touching the snapshot, its freshness or what it is
    /// verified by. A reason already given is kept beside it.
    pub fn note_degraded(&mut self, reason: impl Into<String>) {
        let reason = reason.into();
        self.sync.degraded_reason = Some(match self.sync.degraded_reason.take() {
            Some(earlier) if earlier.contains(&reason) => earlier,
            Some(earlier) if !reason.contains(&earlier) => format!("{earlier}; {reason}"),
            _ => reason,
        });
    }

    /// Record a provider/runtime failure without mutating the last valid wallet
    /// snapshot. This is the explicit "timeout != empty wallet" invariant.
    pub fn record_failure(&mut self, reason: impl Into<String>) -> ReconciliationDecision {
        self.sync.history_fresh = false;
        self.sync.utxos_fresh = false;
        self.sync.verification = VerificationState::Degraded;
        self.sync.degraded_reason = Some(reason.into());
        ReconciliationDecision::PreservedFailure
    }
}

/// A short name for an evidence level, for the holder.
pub const fn evidence_label(evidence: &Evidence) -> &'static str {
    match evidence {
        Evidence::ServerAssertion => "server-reported",
        Evidence::MempoolObservation => "seen in a mempool",
        Evidence::HeaderLinked { .. } => "header-linked",
        Evidence::HeaderPowVerified { .. } => "proof-of-work verified",
        Evidence::HeaderMmrProven { .. } => "header-proven",
        Evidence::MerkleTransactionIncluded { .. } => "merkle-proven",
        Evidence::FullNodeValidated { .. } => "node-validated",
    }
}

pub const fn evidence_strength(evidence: &Evidence) -> u8 {
    match evidence {
        Evidence::ServerAssertion => 0,
        Evidence::MempoolObservation => 1,
        Evidence::HeaderLinked { .. } => 2,
        Evidence::HeaderPowVerified { .. } => 3,
        Evidence::HeaderMmrProven { .. } => 4,
        Evidence::MerkleTransactionIncluded { .. } => 5,
        Evidence::FullNodeValidated { .. } => 6,
    }
}

pub const fn verification_state_for(evidence: &Evidence) -> VerificationState {
    match evidence {
        Evidence::ServerAssertion | Evidence::MempoolObservation => VerificationState::Discovered,
        Evidence::HeaderLinked { .. } | Evidence::HeaderPowVerified { .. } => {
            VerificationState::PartiallyVerified
        }
        Evidence::HeaderMmrProven { .. }
        | Evidence::MerkleTransactionIncluded { .. }
        | Evidence::FullNodeValidated { .. } => VerificationState::Verified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_empty_response_cannot_zero_previous_wallet() {
        let mut state = ReconciliationState::default();
        assert_eq!(
            state.reconcile_candidate(
                vec!["utxo"],
                SourceId::new("good"),
                Evidence::FullNodeValidated {
                    source: SourceId::new("good")
                },
                Some((100, [1; 32])),
                true,
            ),
            ReconciliationDecision::Accepted
        );

        assert_eq!(
            state.reconcile_candidate(
                Vec::<&str>::new(),
                SourceId::new("timed-out"),
                Evidence::ServerAssertion,
                Some((100, [1; 32])),
                false,
            ),
            ReconciliationDecision::PreservedIncomplete
        );
        assert_eq!(state.authoritative.as_ref().unwrap().value, vec!["utxo"]);
    }

    #[test]
    fn failure_preserves_snapshot() {
        let mut state = ReconciliationState::default();
        state.reconcile_candidate(
            42u64,
            SourceId::new("a"),
            Evidence::ServerAssertion,
            None,
            true,
        );
        state.record_failure("timeout");
        assert_eq!(state.authoritative.as_ref().unwrap().value, 42);
        assert_eq!(state.sync.verification, VerificationState::Degraded);
        assert!(!state.sync.history_fresh);
        assert!(!state.sync.utxos_fresh);
    }

    /// A weaker refresh replaces a stronger snapshot only at a newer tip the
    /// verified headers vouch for, and says it did.
    #[test]
    fn a_weaker_refresh_advances_only_to_a_newer_verified_tip() {
        let proven = |height| Evidence::HeaderMmrProven {
            block_hash: [2; 32],
            height,
        };
        let fresh = || {
            let mut state = ReconciliationState::default();
            state.reconcile_candidate(
                "bip37",
                SourceId::new("peer"),
                proven(7),
                Some((7, [2; 32])),
                true,
            );
            state
        };
        let verified = |tip: (u32, Hash32)| tip == (9, [9; 32]);

        // Newer and verified: accepted, labelled as a downgrade.
        let mut state = fresh();
        assert_eq!(
            state.reconcile_refresh(
                "electrum",
                SourceId::new("server"),
                Evidence::ServerAssertion,
                Some((9, [9; 32])),
                verified,
            ),
            ReconciliationDecision::Accepted
        );
        assert_eq!(state.authoritative.as_ref().unwrap().value, "electrum");
        assert_eq!(state.sync.chain_tip, Some((9, [9; 32])));
        assert_eq!(state.sync.verification, VerificationState::Discovered);
        assert!(state.sync.history_fresh && state.sync.utxos_fresh);
        assert_eq!(
            state.sync.degraded_reason.as_deref(),
            Some("evidence lowered from header-proven to server-reported at a newer verified tip")
        );

        // Same tip, an older one, an unverified newer one, or no tip: kept.
        for tip in [
            Some((7, [2; 32])),
            Some((6, [6; 32])),
            Some((9, [8; 32])),
            None,
        ] {
            let mut state = fresh();
            let retained = state.authoritative.clone();
            assert_eq!(
                state.reconcile_refresh(
                    "electrum",
                    SourceId::new("server"),
                    Evidence::ServerAssertion,
                    tip,
                    verified,
                ),
                ReconciliationDecision::PreservedWeakerEvidence,
                "{tip:?}"
            );
            assert_eq!(state.authoritative, retained);
        }

        // Equal or stronger evidence follows the ordinary rule.
        let mut state = fresh();
        assert_eq!(
            state.reconcile_refresh(
                "peer",
                SourceId::new("peer"),
                proven(8),
                Some((8, [8; 32])),
                |_| false
            ),
            ReconciliationDecision::Accepted
        );
        assert!(state.sync.degraded_reason.is_none());
    }

    #[test]
    fn notes_are_kept_beside_each_other_once() {
        let mut state = ReconciliationState::<()>::default();
        state.note_degraded("evidence lowered");
        state.note_degraded("headers did not advance");
        state.note_degraded("headers did not advance");
        state.note_degraded("evidence lowered");
        assert_eq!(
            state.sync.degraded_reason.as_deref(),
            Some("evidence lowered; headers did not advance")
        );
        state.note_degraded("evidence lowered; headers did not advance; more");
        assert_eq!(
            state.sync.degraded_reason.as_deref(),
            Some("evidence lowered; headers did not advance; more")
        );
    }

    #[test]
    fn weaker_assertion_cannot_replace_stronger_evidence_at_any_tip() {
        let mut state = ReconciliationState::default();
        state.reconcile_candidate(
            "verified",
            SourceId::new("proof"),
            Evidence::HeaderMmrProven {
                block_hash: [2; 32],
                height: 7,
            },
            Some((7, [2; 32])),
            true,
        );
        let retained = state.authoritative.clone();
        for tip in [Some((7, [2; 32])), Some((8, [3; 32])), None] {
            assert_eq!(
                state.reconcile_candidate(
                    "server",
                    SourceId::new("fast"),
                    Evidence::ServerAssertion,
                    tip,
                    true,
                ),
                ReconciliationDecision::PreservedWeakerEvidence
            );
            assert_eq!(state.authoritative, retained);
            assert_eq!(state.sync.chain_tip, Some((7, [2; 32])));
            assert!(!state.sync.history_fresh);
            assert!(!state.sync.utxos_fresh);
        }
    }
}
