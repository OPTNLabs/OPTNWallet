//! "Not seeing your coins?" — deciding which account path a wallet lives on.
//!
//! A wallet restored from another app may hold its coins under a different
//! BIP44 account. This module owns the *decision*: given what each candidate
//! path reported, which one should the wallet adopt, and is that answer even
//! safe to act on. The probing itself is I/O and lives above this.
//!
//! The whole design turns on one distinction the React implementation states
//! outright and this port keeps:
//!
//! > `chosen == None && incomplete` means **"we do not know"**, not
//! > **"there is nothing"**. Callers must not present those the same way.
//!
//! A path whose probe failed is **absent** from the results — never recorded
//! as a zero. One unreachable server must not be allowed to conclude that a
//! path is empty, because that is exactly how a wallet decides it has no coins
//! and moves on. So the count of answers, not a flag, is what says whether the
//! scan was complete.
//!
//! Nothing here changes a wallet. Adoption is a separate, explicit step.

use crate::hd::AccountPath;

/// What one candidate path reported.
///
/// Only built for a path that actually answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PathProbe {
    pub account: AccountPath,
    /// Addresses on this path that have ever been used, summed across the
    /// receive, change and DeFi branches.
    pub used_addresses: u32,
    /// Confirmed plus unconfirmed satoshis currently held.
    ///
    /// A 64-bit integer, never a float: the JS original uses `bigint`
    /// precisely so a balance cannot lose precision on the way to a decision.
    pub satoshis: u64,
}

impl PathProbe {
    pub const fn new(account: AccountPath, used_addresses: u32, satoshis: u64) -> Self {
        Self {
            account,
            used_addresses,
            satoshis,
        }
    }

    pub const fn holds_coins(&self) -> bool {
        self.satoshis > 0
    }

    pub const fn has_history(&self) -> bool {
        self.used_addresses > 0
    }
}

/// The result of a scan, and whether it can be acted on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryOutcome {
    /// The path to adopt, or `None` when nothing was found — which is only
    /// meaningful together with [`Self::is_complete`].
    pub chosen: Option<AccountPath>,
    /// Paths that answered. A path that failed is absent, not zero.
    pub probed: Vec<PathProbe>,
    /// How many candidates were offered to the scan.
    pub candidates_total: usize,
    /// More than one path could reasonably be adopted.
    pub ambiguous: bool,
    /// The paths an ambiguous result is between, for the user to choose from.
    pub ambiguous_between: Vec<AccountPath>,
}

impl DiscoveryOutcome {
    /// Every candidate answered.
    pub fn is_complete(&self) -> bool {
        self.probed.len() >= self.candidates_total
    }

    /// Some candidate never answered, so part of the wallet is unexamined.
    pub fn is_incomplete(&self) -> bool {
        !self.is_complete()
    }

    /// "We do not know." Nothing was found *and* something went unchecked.
    ///
    /// Must never be shown as "you have no coins": an unchecked path may hold
    /// all of them.
    pub fn is_unknown(&self) -> bool {
        self.chosen.is_none() && self.is_incomplete()
    }

    /// "There is genuinely nothing." Every candidate answered, none had coins
    /// or history.
    pub fn found_nothing(&self) -> bool {
        self.chosen.is_none() && self.is_complete()
    }

    /// Whether this result may drive a change to the wallet.
    ///
    /// A partial answer is not safe to act on even when a checked path has
    /// history, because an unchecked path may hold more. This is deliberately
    /// checked ahead of every adoption branch so a transport failure can never
    /// become a path decision.
    pub fn safe_to_adopt(&self) -> bool {
        self.chosen.is_some() && self.is_complete()
    }

    /// How many candidates never answered.
    pub fn unchecked(&self) -> usize {
        self.candidates_total.saturating_sub(self.probed.len())
    }
}

/// Decide which path to adopt from the paths that answered.
///
/// The rule, in order:
/// 1. Any path holding coins wins; the highest balance is chosen, and more
///    than one funded path is ambiguous.
/// 2. Otherwise any path with history wins; the most-used is chosen, and more
///    than one is ambiguous. A spent-down path is still the right one to
///    adopt, because new addresses must continue from where it left off.
/// 3. Otherwise nothing is chosen.
///
/// `candidates_total` is how many paths the scan set out to check, which is
/// what makes a missing answer visible.
pub fn decide(candidates_total: usize, probed: Vec<PathProbe>) -> DiscoveryOutcome {
    let funded: Vec<&PathProbe> = probed.iter().filter(|p| p.holds_coins()).collect();

    let (chosen, ambiguous_between) = if !funded.is_empty() {
        let best = funded
            .iter()
            .max_by_key(|p| p.satoshis)
            .map(|p| p.account)
            .expect("non-empty");
        let between = if funded.len() > 1 {
            funded.iter().map(|p| p.account).collect()
        } else {
            Vec::new()
        };
        (Some(best), between)
    } else {
        let used: Vec<&PathProbe> = probed.iter().filter(|p| p.has_history()).collect();
        if used.is_empty() {
            (None, Vec::new())
        } else {
            let best = used
                .iter()
                .max_by_key(|p| p.used_addresses)
                .map(|p| p.account)
                .expect("non-empty");
            let between = if used.len() > 1 {
                used.iter().map(|p| p.account).collect()
            } else {
                Vec::new()
            };
            (Some(best), between)
        }
    };

    DiscoveryOutcome {
        chosen,
        candidates_total,
        ambiguous: ambiguous_between.len() > 1,
        ambiguous_between,
        probed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hd::account_choices;
    use crate::network::Network;

    fn account(coin: u32, index: u32) -> AccountPath {
        AccountPath::new(coin, index).expect("in range")
    }

    #[test]
    fn a_failed_probe_is_absent_not_a_zero() {
        // The property this module exists for. Four candidates were offered,
        // three answered and none had anything. That is NOT "you have no
        // coins" — the unchecked path may hold all of them.
        let outcome = decide(
            4,
            vec![
                PathProbe::new(account(145, 0), 0, 0),
                PathProbe::new(account(145, 1), 0, 0),
                PathProbe::new(account(0, 0), 0, 0),
            ],
        );
        assert!(outcome.is_incomplete());
        assert!(outcome.is_unknown(), "must read as 'we do not know'");
        assert!(!outcome.found_nothing(), "must not read as 'nothing here'");
        assert!(!outcome.safe_to_adopt());
        assert_eq!(outcome.unchecked(), 1);

        // All four answered and all were empty: now it genuinely is nothing.
        let complete = decide(
            4,
            vec![
                PathProbe::new(account(145, 0), 0, 0),
                PathProbe::new(account(145, 1), 0, 0),
                PathProbe::new(account(0, 0), 0, 0),
                PathProbe::new(account(0, 1), 0, 0),
            ],
        );
        assert!(complete.found_nothing());
        assert!(!complete.is_unknown());
    }

    #[test]
    fn a_partial_answer_is_never_safe_to_act_on() {
        // Even with a clearly funded path, an unchecked candidate may hold
        // more. A transport failure must not become a path decision.
        let outcome = decide(
            4,
            vec![
                PathProbe::new(account(145, 0), 3, 500_000),
                PathProbe::new(account(145, 1), 0, 0),
            ],
        );
        assert_eq!(outcome.chosen, Some(account(145, 0)));
        assert!(outcome.is_incomplete());
        assert!(
            !outcome.safe_to_adopt(),
            "a chosen path on an incomplete scan must not be adopted"
        );
    }

    #[test]
    fn coins_beat_history_and_the_largest_balance_wins() {
        let outcome = decide(
            4,
            vec![
                // Lots of history but spent to zero.
                PathProbe::new(account(145, 0), 40, 0),
                PathProbe::new(account(145, 1), 1, 10_000),
                PathProbe::new(account(0, 0), 1, 900_000),
                PathProbe::new(account(0, 1), 0, 0),
            ],
        );
        assert_eq!(outcome.chosen, Some(account(0, 0)));
        assert!(outcome.safe_to_adopt());
        assert!(outcome.ambiguous, "two funded paths is a user choice");
        assert_eq!(
            outcome.ambiguous_between,
            vec![account(145, 1), account(0, 0)],
            "an ambiguous funded result lists only the funded paths"
        );
    }

    #[test]
    fn a_spent_down_path_is_still_the_right_one_to_adopt() {
        // No coins anywhere, but one path has been used. New addresses must
        // continue from where that chain left off.
        let outcome = decide(
            4,
            vec![
                PathProbe::new(account(145, 0), 0, 0),
                PathProbe::new(account(145, 1), 12, 0),
                PathProbe::new(account(0, 0), 0, 0),
                PathProbe::new(account(0, 1), 0, 0),
            ],
        );
        assert_eq!(outcome.chosen, Some(account(145, 1)));
        assert!(!outcome.ambiguous);
        assert!(outcome.safe_to_adopt());
    }

    #[test]
    fn history_only_ambiguity_lists_the_used_paths() {
        let outcome = decide(
            4,
            vec![
                PathProbe::new(account(145, 0), 5, 0),
                PathProbe::new(account(0, 0), 9, 0),
                PathProbe::new(account(145, 1), 0, 0),
                PathProbe::new(account(0, 1), 0, 0),
            ],
        );
        // Most-used wins, and both used paths are offered to the user.
        assert_eq!(outcome.chosen, Some(account(0, 0)));
        assert!(outcome.ambiguous);
        assert_eq!(
            outcome.ambiguous_between,
            vec![account(145, 0), account(0, 0)]
        );
    }

    #[test]
    fn one_funded_path_is_not_ambiguous() {
        let outcome = decide(
            2,
            vec![
                PathProbe::new(account(145, 0), 2, 1),
                PathProbe::new(account(145, 1), 7, 0),
            ],
        );
        assert_eq!(outcome.chosen, Some(account(145, 0)));
        assert!(!outcome.ambiguous, "a single funded path needs no choice");
        assert!(outcome.ambiguous_between.is_empty());
    }

    #[test]
    fn the_candidate_set_is_the_one_discovery_already_offers() {
        // The scan and the onboarding picker must not drift apart: a path the
        // user can select but discovery never checks, or the reverse, is how
        // "my wallet is empty" happens.
        assert_eq!(account_choices(Network::Mainnet).len(), 4);
        assert_eq!(account_choices(Network::Chipnet).len(), 6);
        assert_eq!(
            account_choices(Network::Chipnet)
                .iter()
                .map(AccountPath::to_string)
                .collect::<Vec<_>>(),
            vec![
                "m/44'/1'/0'",
                "m/44'/1'/1'",
                "m/44'/145'/0'",
                "m/44'/145'/1'",
                "m/44'/0'/0'",
                "m/44'/0'/1'",
            ],
            "coin-type-major, matching candidateAccountPaths"
        );

        // A scan over the real candidate set, fully answered.
        let candidates = account_choices(Network::Mainnet);
        let probed = candidates
            .iter()
            .map(|account| PathProbe::new(*account, 0, 0))
            .collect();
        assert!(decide(candidates.len(), probed).found_nothing());
    }

    #[test]
    fn satoshis_survive_amounts_a_float_would_round() {
        // 2^53 + 1 is the first integer f64 cannot represent. A balance
        // decision must not depend on the difference being invisible.
        let big = 9_007_199_254_740_993_u64;
        let outcome = decide(
            2,
            vec![
                PathProbe::new(account(145, 0), 1, big),
                PathProbe::new(account(145, 1), 1, big - 1),
            ],
        );
        assert_eq!(outcome.chosen, Some(account(145, 0)));
    }
}
