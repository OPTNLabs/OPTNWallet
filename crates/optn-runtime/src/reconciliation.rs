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
            self.sync.verification = VerificationState::Degraded;
            self.sync.degraded_reason = Some("provider response incomplete".into());
            return ReconciliationDecision::PreservedIncomplete;
        }

        if let Some(current) = &self.authoritative {
            // Never replace stronger cryptographic evidence with a weaker server
            // assertion merely because that server answered later/faster.
            if evidence_strength(&evidence) < evidence_strength(&current.evidence)
                && current.chain_tip == chain_tip
            {
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

    /// Record a provider/runtime failure without mutating the last valid wallet
    /// snapshot. This is the explicit "timeout != empty wallet" invariant.
    pub fn record_failure(&mut self, reason: impl Into<String>) -> ReconciliationDecision {
        self.sync.verification = VerificationState::Degraded;
        self.sync.degraded_reason = Some(reason.into());
        ReconciliationDecision::PreservedFailure
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
    }

    #[test]
    fn weaker_same_tip_assertion_does_not_replace_stronger_evidence() {
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
        assert_eq!(
            state.reconcile_candidate(
                "server",
                SourceId::new("fast"),
                Evidence::ServerAssertion,
                Some((7, [2; 32])),
                true,
            ),
            ReconciliationDecision::PreservedWeakerEvidence
        );
        assert_eq!(state.authoritative.as_ref().unwrap().value, "verified");
    }
}
