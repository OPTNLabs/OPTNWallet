//! Collecting signatures from cosigners, one at a time.
//!
//! A multisig wallet is watch-only until the moment it spends. Its addresses
//! come from public keys, so balances and receive addresses need no device
//! plugged in at all — that is [`crate::multisig`]. This module is the other
//! half: the session that carries one transaction from "I want to send this"
//! to a broadcast, gathering signatures on the way.
//!
//! **Cosigners sign one after another, never together.** The coordinator hands
//! the transaction to the first, gets it back, hands the result to the second,
//! and broadcasts once the threshold is met. Nothing requires two devices to be
//! connected at once, and no step cares what kind of cosigner it is talking to:
//! a hardware wallet on a cable, an air-gapped device across a QR round trip
//! and a seed signer are interchangeable here, because BIP32 settles what the
//! keys are and BIP174 settles what a partial signature looks like. Mixing
//! brands is not a special case; it is the ordinary one.
//!
//! **A session only ever moves forward.** [`SpendStage`] is ordered, and an
//! advance to an earlier stage is refused. That is what stops a broadcast
//! transaction being dragged back to `Sign` and signed again into a second,
//! conflicting spend — which is the mistake worth being unable to make.
//! Rejection is outside the order, because giving up is always available.
//!
//! **Duplicate signatures collapse.** The same cosigner signing twice — a
//! double tap, a retried scan, a device reconnected after a timeout — must
//! count once, or a 2-of-3 would call itself complete with one participant.

use std::fmt;

use crate::error::{CliError, Result};

/// Where a spend has got to.
///
/// Ordered. `Rejected` sits outside the order rather than at the end: it is
/// reachable from anywhere, and nothing is reachable from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SpendStage {
    /// Somebody said what they want to send.
    Intent,
    /// The unsigned transaction exists.
    Build,
    /// Signatures are being collected.
    Sign,
    /// The collected signatures are being combined.
    Merge,
    /// The combined transaction is being checked.
    Validate,
    /// Ready to go out.
    Broadcast,
    /// Handed to the network.
    Submitted,
    /// Seen in a block.
    Confirmed,
    /// Abandoned.
    Rejected,
}

impl SpendStage {
    pub const ALL: &'static [Self] = &[
        Self::Intent,
        Self::Build,
        Self::Sign,
        Self::Merge,
        Self::Validate,
        Self::Broadcast,
        Self::Submitted,
        Self::Confirmed,
        Self::Rejected,
    ];

    /// Position in the flow. `Rejected` is deliberately far past the end.
    pub const fn order(self) -> u8 {
        match self {
            Self::Intent => 0,
            Self::Build => 1,
            Self::Sign => 2,
            Self::Merge => 3,
            Self::Validate => 4,
            Self::Broadcast => 5,
            Self::Submitted => 6,
            Self::Confirmed => 7,
            Self::Rejected => 99,
        }
    }

    /// Whether the session is over, either way.
    pub const fn is_final(self) -> bool {
        matches!(self, Self::Confirmed | Self::Rejected)
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Intent => "Preparing",
            Self::Build => "Built",
            Self::Sign => "Collecting signatures",
            Self::Merge => "Combining signatures",
            Self::Validate => "Checking",
            Self::Broadcast => "Ready to send",
            Self::Submitted => "Sent",
            Self::Confirmed => "Confirmed",
            Self::Rejected => "Cancelled",
        }
    }
}

impl fmt::Display for SpendStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

/// One transaction being taken round the cosigners.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendSession {
    pub session_id: String,
    pub wallet_id: u64,
    /// Which multisig policy this spends from.
    pub policy_id: String,
    /// Identifies the transaction the cosigners agreed to sign.
    ///
    /// Every signature must be against this. A cosigner handed a *different*
    /// transaction would produce a signature that is individually valid and
    /// combines into nothing, which is a confusing way to lose an afternoon.
    pub unsigned_tx_hash: String,
    pub psbt: Vec<u8>,
    pub stage: SpendStage,
    /// The partial signatures gathered so far, deduplicated.
    signatures: Vec<String>,
    /// The finished transaction, once there is one.
    pub raw_tx_hex: Option<String>,
    pub retry_count: u32,
}

impl SpendSession {
    /// Start one. A new session is at [`SpendStage::Intent`] with nothing
    /// gathered.
    pub fn new(
        session_id: impl Into<String>,
        wallet_id: u64,
        policy_id: impl Into<String>,
        unsigned_tx_hash: impl Into<String>,
        psbt: Vec<u8>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            wallet_id,
            policy_id: policy_id.into(),
            unsigned_tx_hash: unsigned_tx_hash.into(),
            psbt,
            stage: SpendStage::Intent,
            signatures: Vec::new(),
            raw_tx_hex: None,
            retry_count: 0,
        }
    }

    /// How many distinct signatures are in hand.
    pub fn signature_count(&self) -> usize {
        self.signatures.len()
    }

    pub fn signatures(&self) -> &[String] {
        &self.signatures
    }

    /// Whether enough cosigners have signed.
    pub fn threshold_met(&self, required: u8) -> bool {
        self.signature_count() >= usize::from(required)
    }

    /// How many more are needed. Zero once the threshold is met.
    pub fn still_needed(&self, required: u8) -> usize {
        usize::from(required).saturating_sub(self.signature_count())
    }

    /// Add one cosigner's partial signature.
    ///
    /// The same signature twice counts once. A cosigner tapping twice, a scan
    /// retried after a bad frame, or a device reconnected after a timeout must
    /// not make a 2-of-3 believe two people have signed.
    ///
    /// Returns whether this one was new.
    pub fn add_signature(&mut self, signature: impl Into<String>) -> bool {
        let signature = signature.into();
        if self.signatures.contains(&signature) {
            return false;
        }
        self.signatures.push(signature);
        true
    }

    /// Move the session on.
    ///
    /// Refuses to go backwards, and refuses to move at all once the session has
    /// finished. Going back from `Broadcast` to `Sign` would let the same
    /// transaction be signed a second time into a conflicting spend, which is
    /// the whole reason the order exists.
    pub fn advance(&mut self, to: SpendStage) -> Result<()> {
        if self.stage.is_final() {
            return Err(CliError::Usage(format!(
                "this spend is already {}; start a new one",
                self.stage.label().to_lowercase()
            )));
        }
        // Giving up is always available, from anywhere.
        if to != SpendStage::Rejected && to.order() < self.stage.order() {
            return Err(CliError::Usage(format!(
                "cannot move a spend from {} back to {}",
                self.stage.label(),
                to.label()
            )));
        }
        self.stage = to;
        Ok(())
    }

    /// Record that a step was tried again.
    pub fn note_retry(&mut self) {
        self.retry_count = self.retry_count.saturating_add(1);
    }

    /// Whether a signature or a device belongs to *this* spend.
    ///
    /// Checked before anything is accepted, because a signature from another
    /// session is valid on its own transaction and worthless on this one --
    /// and combining them yields a transaction that fails at broadcast for a
    /// reason nobody can see.
    pub fn accepts(&self, wallet_id: u64, policy_id: &str, unsigned_tx_hash: &str) -> Result<()> {
        if self.stage.is_final() {
            return Err(CliError::Usage(format!(
                "this spend is already {}",
                self.stage.label().to_lowercase()
            )));
        }
        if self.wallet_id != wallet_id {
            return Err(CliError::Usage(
                "that signature is for a different wallet".into(),
            ));
        }
        if self.policy_id != policy_id {
            return Err(CliError::Usage(
                "that signature is for a different multisig policy".into(),
            ));
        }
        if self.unsigned_tx_hash != unsigned_tx_hash {
            return Err(CliError::Usage(
                "that signature is for a different transaction. Each cosigner has to sign the \
                 same one."
                    .into(),
            ));
        }
        Ok(())
    }

    /// What to tell the user about where this is.
    pub fn progress(&self, required: u8) -> String {
        match self.stage {
            SpendStage::Sign => {
                let needed = self.still_needed(required);
                if needed == 0 {
                    format!("{} of {required} signed", self.signature_count())
                } else if needed == 1 {
                    format!(
                        "{} of {required} signed — one more cosigner",
                        self.signature_count()
                    )
                } else {
                    format!(
                        "{} of {required} signed — {needed} more cosigners",
                        self.signature_count()
                    )
                }
            }
            other => other.label().to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> SpendSession {
        SpendSession::new("ms-1", 7, "policy-a", "ab".repeat(32), vec![0x70, 0x73])
    }

    #[test]
    fn cosigners_sign_one_after_another_and_the_count_is_what_finishes_it() {
        // The coordinator hands the transaction round. Nothing requires two
        // devices at once, and the kind of cosigner never comes into it.
        let mut spend = session();
        spend.advance(SpendStage::Build).expect("built");
        spend.advance(SpendStage::Sign).expect("signing");

        assert_eq!(spend.still_needed(2), 2);
        assert!(spend.add_signature("ledger-partial"), "first cosigner");
        assert_eq!(spend.progress(2), "1 of 2 signed — one more cosigner");
        assert!(!spend.threshold_met(2));

        // A different brand, same flow -- BIP32 settles the keys and BIP174
        // settles the partial signature, so mixing is the ordinary case.
        assert!(spend.add_signature("trezor-partial"), "second cosigner");
        assert!(spend.threshold_met(2));
        assert_eq!(spend.still_needed(2), 0);
        assert_eq!(spend.progress(2), "2 of 2 signed");
    }

    #[test]
    fn the_same_cosigner_signing_twice_counts_once() {
        // A double tap, a scan retried after a bad frame, a device reconnected
        // after a timeout. Counting it twice would let a 2-of-3 call itself
        // complete with one participant.
        let mut spend = session();
        assert!(spend.add_signature("ledger-partial"));
        assert!(!spend.add_signature("ledger-partial"), "not new");
        assert_eq!(spend.signature_count(), 1);
        assert!(!spend.threshold_met(2), "one person is not two");
    }

    #[test]
    fn a_spend_cannot_be_dragged_back_and_signed_again() {
        // The reason the order exists: a broadcast transaction returned to
        // Sign could be signed into a second, conflicting spend.
        let mut spend = session();
        for stage in [
            SpendStage::Build,
            SpendStage::Sign,
            SpendStage::Merge,
            SpendStage::Validate,
            SpendStage::Broadcast,
        ] {
            spend.advance(stage).expect("forwards is fine");
        }

        let error = spend.advance(SpendStage::Sign).expect_err("backwards");
        assert!(error.to_string().contains("back to"), "{error}");
        assert_eq!(spend.stage, SpendStage::Broadcast, "and it did not move");

        // Standing still is allowed: a step that reports its own stage again
        // should not be an error.
        spend.advance(SpendStage::Broadcast).expect("same stage");
    }

    #[test]
    fn giving_up_is_available_from_anywhere_and_is_the_end() {
        let mut spend = session();
        spend.advance(SpendStage::Build).expect("built");
        spend.advance(SpendStage::Rejected).expect("cancelled");
        assert!(spend.stage.is_final());

        // Nothing moves after that, forwards included.
        let error = spend.advance(SpendStage::Sign).expect_err("finished");
        assert!(error.to_string().contains("already cancelled"), "{error}");

        // Confirmed is the other end, and equally final.
        let mut done = session();
        done.advance(SpendStage::Confirmed).expect("straight there");
        assert!(done.stage.is_final());
        assert!(done.advance(SpendStage::Rejected).is_err());
    }

    #[test]
    fn a_signature_for_another_transaction_is_refused_before_it_is_counted() {
        // It would be individually valid and combine into nothing, which is a
        // confusing way to lose an afternoon.
        let spend = session();
        let txid = "ab".repeat(32);
        spend.accepts(7, "policy-a", &txid).expect("this one");

        assert!(spend.accepts(8, "policy-a", &txid).is_err(), "other wallet");
        assert!(spend.accepts(7, "policy-b", &txid).is_err(), "other policy");
        let error = spend
            .accepts(7, "policy-a", &"cd".repeat(32))
            .expect_err("other transaction");
        assert!(error.to_string().contains("same one"), "{error}");
    }

    #[test]
    fn the_stage_order_puts_rejection_outside_the_flow() {
        // Reachable from anywhere, and nothing reachable from it.
        let mut previous = 0;
        for stage in SpendStage::ALL {
            if *stage == SpendStage::Rejected {
                continue;
            }
            assert!(stage.order() >= previous, "{stage:?} is out of order");
            previous = stage.order();
            assert!(!stage.label().is_empty());
        }
        assert!(SpendStage::Rejected.order() > SpendStage::Confirmed.order());
        assert!(SpendStage::Confirmed.is_final());
        assert!(SpendStage::Rejected.is_final());
        assert!(!SpendStage::Sign.is_final());
    }

    #[test]
    fn a_retry_is_counted_rather_than_hidden() {
        // A step tried three times is worth knowing about when someone asks
        // why a spend is taking so long.
        let mut spend = session();
        assert_eq!(spend.retry_count, 0);
        spend.note_retry();
        spend.note_retry();
        assert_eq!(spend.retry_count, 2);
    }
}
