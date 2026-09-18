//! Durable record of which coins are held, and by what.
//!
//! The wallet already has the policy: `optn_core::coins` says a held coin is
//! unavailable to an ordinary send, to Fusion selection and to a new pledge,
//! and that only a `User` hold is the user's to lift — a pledge, an authhead
//! and a running fusion each belong to something with a lifecycle, so
//! unfreezing behind its back is how the coin gets spent out from under it.
//!
//! What was missing is somewhere to keep that decision across restarts, and a
//! way for a renderer to ask. This module is that record: outpoints, their
//! reason, and an optional note, with the reason rules enforced here rather
//! than in whichever screen happens to be calling.
//!
//! It stays free of I/O so every host can persist it the way it persists
//! everything else.

use optn_core::coins::{CoinError, FreezeReason, Outpoint};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const COIN_HOLDS_SCHEMA_VERSION: u32 = 1;

/// A coin the wallet is not free to spend, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoinHold {
    /// Display-order txid, as every wallet surface shows it.
    pub txid: String,
    pub vout: u32,
    /// `user` | `flipstarter-pledge` | `authhead` | `fusion-in-flight`.
    pub reason: String,
    /// The holder's own note. Labels for unheld coins live with the wallet's
    /// label store; this one travels with the hold so the reason a coin was
    /// frozen survives with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoinHolds {
    pub schema_version: u32,
    pub holds: Vec<CoinHold>,
}

impl Default for CoinHolds {
    fn default() -> Self {
        Self {
            schema_version: COIN_HOLDS_SCHEMA_VERSION,
            holds: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoinHoldError {
    /// A file from a newer build. Rewriting it would drop holds this build
    /// cannot see, and a dropped hold is a coin that gets spent.
    UnsupportedSchema { found: u32, current: u32 },
    InvalidOutpoint,
    UnknownReason(String),
    AlreadyHeld(FreezeReason),
    NotHeld,
    /// Someone asked to release a hold that is not theirs to release.
    NotUserReversible(FreezeReason),
}

impl std::fmt::Display for CoinHoldError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedSchema { found, current } => write!(
                formatter,
                "coin holds were written by a newer version (schema {found}, this build reads {current})"
            ),
            Self::InvalidOutpoint => write!(formatter, "that is not a valid outpoint"),
            Self::UnknownReason(reason) => write!(formatter, "unknown hold reason '{reason}'"),
            Self::AlreadyHeld(reason) => {
                write!(formatter, "that coin is already held ({})", reason.as_str())
            }
            Self::NotHeld => write!(formatter, "that coin is not held"),
            Self::NotUserReversible(reason) => write!(
                formatter,
                "a {} hold is released by the thing that took it, not from the coin list",
                reason.as_str()
            ),
        }
    }
}

impl From<CoinError> for CoinHoldError {
    fn from(_: CoinError) -> Self {
        Self::InvalidOutpoint
    }
}

pub fn parse_reason(value: &str) -> Result<FreezeReason, CoinHoldError> {
    Ok(match value {
        "user" => FreezeReason::User,
        "flipstarter-pledge" => FreezeReason::FlipstarterPledge,
        "authhead" => FreezeReason::Authhead,
        "fusion-in-flight" => FreezeReason::FusionInFlight,
        other => return Err(CoinHoldError::UnknownReason(other.to_owned())),
    })
}

impl CoinHolds {
    /// Read a stored record, refusing one this build does not understand.
    pub fn accept(self) -> Result<Self, CoinHoldError> {
        if self.schema_version != COIN_HOLDS_SCHEMA_VERSION {
            return Err(CoinHoldError::UnsupportedSchema {
                found: self.schema_version,
                current: COIN_HOLDS_SCHEMA_VERSION,
            });
        }
        // Every stored reason has to be one this build can enforce. A hold it
        // cannot name is a coin it would treat as spendable.
        for hold in &self.holds {
            parse_reason(&hold.reason)?;
            Outpoint::parse(&hold.txid, hold.vout)?;
        }
        Ok(self)
    }

    fn position(&self, txid: &str, vout: u32) -> Option<usize> {
        self.holds
            .iter()
            .position(|hold| hold.vout == vout && hold.txid.eq_ignore_ascii_case(txid))
    }

    pub fn reason_for(&self, txid: &str, vout: u32) -> Option<FreezeReason> {
        let hold = self.holds.get(self.position(txid, vout)?)?;
        parse_reason(&hold.reason).ok()
    }

    pub fn is_held(&self, txid: &str, vout: u32) -> bool {
        self.position(txid, vout).is_some()
    }

    /// Take a hold. Re-holding an already-held coin is refused rather than
    /// overwritten: the second reason would silently replace the first, and the
    /// first is what something else is relying on.
    pub fn hold(
        &mut self,
        txid: &str,
        vout: u32,
        reason: FreezeReason,
        note: Option<String>,
    ) -> Result<(), CoinHoldError> {
        let outpoint = Outpoint::parse(txid, vout)?;
        if let Some(existing) = self.reason_for(txid, vout) {
            return Err(CoinHoldError::AlreadyHeld(existing));
        }
        self.holds.push(CoinHold {
            // Store the canonical spelling so two cases of the same txid cannot
            // become two holds, only one of which a filter would find.
            txid: outpoint.txid_hex(),
            vout,
            reason: reason.as_str().to_owned(),
            note,
        });
        self.holds.sort_by(|left, right| {
            (&left.txid, left.vout).cmp(&(&right.txid, right.vout))
        });
        Ok(())
    }

    /// Release a hold the user took.
    ///
    /// Anything else is refused here, where the rule is one line, rather than
    /// in each screen that offers an unfreeze button.
    pub fn release_user_hold(&mut self, txid: &str, vout: u32) -> Result<(), CoinHoldError> {
        let index = self.position(txid, vout).ok_or(CoinHoldError::NotHeld)?;
        let reason = parse_reason(&self.holds[index].reason)?;
        if !reason.is_user_reversible() {
            return Err(CoinHoldError::NotUserReversible(reason));
        }
        self.holds.remove(index);
        Ok(())
    }

    /// Release a hold whose owner is finishing with it — a pledge cancelled, a
    /// fusion round over. Not reachable from a coin list.
    pub fn release_for(&mut self, txid: &str, vout: u32, reason: FreezeReason) -> Result<(), CoinHoldError> {
        let index = self.position(txid, vout).ok_or(CoinHoldError::NotHeld)?;
        let held = parse_reason(&self.holds[index].reason)?;
        if held != reason {
            return Err(CoinHoldError::NotUserReversible(held));
        }
        self.holds.remove(index);
        Ok(())
    }

    /// Held outpoints as `txid:vout`, the spelling every renderer keys on.
    pub fn held_outpoints(&self) -> BTreeMap<String, String> {
        self.holds
            .iter()
            .map(|hold| {
                (
                    format!("{}:{}", hold.txid.to_lowercase(), hold.vout),
                    hold.reason.clone(),
                )
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TXID: &str = "1111111111111111111111111111111111111111111111111111111111111111";

    #[test]
    fn only_a_user_hold_can_be_lifted_from_the_coin_list() {
        // The rule is optn_core's: a pledge, an authhead and a running fusion
        // are each held by something with a lifecycle, so releasing one from a
        // list is how the coin gets spent out from under it.
        for reason in [
            FreezeReason::FlipstarterPledge,
            FreezeReason::Authhead,
            FreezeReason::FusionInFlight,
        ] {
            let mut holds = CoinHolds::default();
            holds.hold(TXID, 0, reason, None).unwrap();
            assert_eq!(
                holds.release_user_hold(TXID, 0),
                Err(CoinHoldError::NotUserReversible(reason))
            );
            assert!(holds.is_held(TXID, 0), "the refused release changed nothing");

            // Its owner can still finish with it.
            holds.release_for(TXID, 0, reason).unwrap();
            assert!(!holds.is_held(TXID, 0));
        }

        let mut holds = CoinHolds::default();
        holds.hold(TXID, 0, FreezeReason::User, None).unwrap();
        holds.release_user_hold(TXID, 0).unwrap();
        assert!(!holds.is_held(TXID, 0));
    }

    #[test]
    fn releasing_one_reason_never_releases_another() {
        let mut holds = CoinHolds::default();
        holds
            .hold(TXID, 0, FreezeReason::FlipstarterPledge, None)
            .unwrap();
        assert!(holds
            .release_for(TXID, 0, FreezeReason::FusionInFlight)
            .is_err());
        assert_eq!(
            holds.reason_for(TXID, 0),
            Some(FreezeReason::FlipstarterPledge)
        );
    }

    #[test]
    fn a_second_hold_does_not_overwrite_the_first() {
        let mut holds = CoinHolds::default();
        holds.hold(TXID, 1, FreezeReason::User, None).unwrap();
        assert_eq!(
            holds.hold(TXID, 1, FreezeReason::FusionInFlight, None),
            Err(CoinHoldError::AlreadyHeld(FreezeReason::User))
        );
        assert_eq!(holds.holds.len(), 1);
    }

    #[test]
    fn a_txid_in_either_case_is_the_same_coin() {
        // Two spellings becoming two entries would leave a filter finding one
        // of them and spending the other.
        let mut holds = CoinHolds::default();
        holds.hold(&TXID.to_uppercase(), 0, FreezeReason::User, None).unwrap();
        assert!(holds.is_held(TXID, 0));
        assert!(holds.hold(TXID, 0, FreezeReason::User, None).is_err());
        assert_eq!(
            holds.held_outpoints().keys().next().map(String::as_str),
            Some(format!("{TXID}:0").as_str())
        );
    }

    #[test]
    fn a_record_from_a_newer_build_is_refused_rather_than_rewritten() {
        // Rewriting it would drop holds this build cannot see, and a dropped
        // hold is a coin that gets spent.
        let stored = CoinHolds {
            schema_version: COIN_HOLDS_SCHEMA_VERSION + 1,
            holds: Vec::new(),
        };
        assert!(matches!(
            stored.accept(),
            Err(CoinHoldError::UnsupportedSchema { .. })
        ));

        let unknown_reason = CoinHolds {
            schema_version: COIN_HOLDS_SCHEMA_VERSION,
            holds: vec![CoinHold {
                txid: TXID.into(),
                vout: 0,
                reason: "escrow".into(),
                note: None,
            }],
        };
        assert!(matches!(
            unknown_reason.accept(),
            Err(CoinHoldError::UnknownReason(_))
        ));
    }

    #[test]
    fn a_malformed_outpoint_is_refused_at_the_boundary() {
        let mut holds = CoinHolds::default();
        assert_eq!(
            holds.hold("not-a-txid", 0, FreezeReason::User, None),
            Err(CoinHoldError::InvalidOutpoint)
        );
        assert!(holds.holds.is_empty());
    }
}
