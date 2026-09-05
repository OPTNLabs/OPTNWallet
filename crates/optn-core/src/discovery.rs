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

/// How many consecutive unused addresses end a path's scan.
///
/// The BIP44 gap limit. Twenty unused addresses in a row is the point at which
/// a wallet is entitled to conclude there is nothing further along this branch.
pub const GAP_LIMIT: u32 = 20;

/// How many addresses a single path may be scanned to before giving up.
///
/// A safety cap, not an answer. Reaching it means the gap was never found, so
/// the scan is abandoned *without* a result rather than reported as empty.
pub const ADDRESS_CAP: u32 = 200;

/// Why a path's scan stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanStop {
    /// A full unused gap was seen. The count of used addresses is trustworthy.
    GapReached,
    /// The safety cap was hit first.
    ///
    /// This is a **failure**, not an empty result. The wallet may well have
    /// more history past the cap, so the path must be reported as unanswered --
    /// absent from [`decide`]'s `probed` list -- rather than as a path with a
    /// known, small balance. Handing a partial count to `decide` would let a
    /// scan limit masquerade as a confirmed answer, which is the thing this
    /// module exists to prevent.
    CapReached,
}

impl ScanStop {
    /// Whether a count gathered under this stop may be used as a probe result.
    pub const fn is_trustworthy(self) -> bool {
        matches!(self, Self::GapReached)
    }
}

/// Walking one path's addresses, in order, deciding when to stop.
///
/// Ported from the derivation-path prober, which stated the rule as: "Stop
/// after a valid 20-address unused gap, and fail closed if the 200-address
/// safety cap is reached first." Both halves are policy rather than I/O, so
/// they live here where there is one copy of them, instead of being reinvented
/// by every transport that does the fetching.
///
/// The caller supplies whether each address has ever been used; this decides
/// whether to ask for another.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GapScan {
    examined: u32,
    used: u32,
    consecutive_unused: u32,
    gap_limit: u32,
    cap: u32,
}

impl Default for GapScan {
    fn default() -> Self {
        Self::new()
    }
}

impl GapScan {
    pub const fn new() -> Self {
        Self::with_limits(GAP_LIMIT, ADDRESS_CAP)
    }

    /// Custom limits, for a caller that has a reason. The cap must leave room
    /// for at least one full gap, or the scan could never succeed.
    pub const fn with_limits(gap_limit: u32, cap: u32) -> Self {
        Self {
            examined: 0,
            used: 0,
            consecutive_unused: 0,
            gap_limit,
            cap,
        }
    }

    /// Record one address, and say whether the scan should stop.
    ///
    /// `None` means keep going.
    pub fn observe(&mut self, address_was_used: bool) -> Option<ScanStop> {
        self.examined = self.examined.saturating_add(1);
        if address_was_used {
            self.used = self.used.saturating_add(1);
            self.consecutive_unused = 0;
        } else {
            self.consecutive_unused = self.consecutive_unused.saturating_add(1);
        }
        self.stop()
    }

    /// The current stop condition, if any.
    ///
    /// The gap is checked first: a scan that completes its gap exactly as it
    /// reaches the cap has still answered the question.
    pub const fn stop(&self) -> Option<ScanStop> {
        if self.consecutive_unused >= self.gap_limit {
            Some(ScanStop::GapReached)
        } else if self.examined >= self.cap {
            Some(ScanStop::CapReached)
        } else {
            None
        }
    }

    /// How many addresses on this path have ever been used.
    ///
    /// Only meaningful once [`Self::stop`] reports [`ScanStop::GapReached`];
    /// [`Self::probe`] is the safe way to get at it.
    pub const fn used_addresses(&self) -> u32 {
        self.used
    }

    pub const fn examined(&self) -> u32 {
        self.examined
    }

    /// This path's result, or `None` if the scan cannot be trusted.
    ///
    /// `None` is what keeps a capped scan out of [`decide`]'s results, so the
    /// path counts as unanswered and the outcome stays incomplete.
    pub fn probe(&self, account: AccountPath, satoshis: u64) -> Option<PathProbe> {
        self.stop()
            .filter(|stop| stop.is_trustworthy())
            .map(|_| PathProbe::new(account, self.used, satoshis))
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

    /// Walk a path whose used addresses are at the given indices.
    fn scan_to_stop(used_at: &[u32]) -> (GapScan, ScanStop) {
        let mut scan = GapScan::new();
        let mut index = 0u32;
        loop {
            if let Some(stop) = scan.observe(used_at.contains(&index)) {
                return (scan, stop);
            }
            index += 1;
        }
    }

    #[test]
    fn a_scan_ends_on_a_full_gap_and_the_count_can_be_trusted() {
        // Twenty unused in a row is the point at which there is entitled to be
        // nothing further along this branch.
        let (scan, stop) = scan_to_stop(&[0, 1, 5]);
        assert_eq!(stop, ScanStop::GapReached);
        assert!(stop.is_trustworthy());
        assert_eq!(scan.used_addresses(), 3);
        // Six used-or-not addresses up to index 5, then the twenty-address gap.
        assert_eq!(scan.examined(), 6 + GAP_LIMIT);
        assert!(scan.examined() < ADDRESS_CAP);
        assert_eq!(
            scan.probe(account(145, 0), 1_000),
            Some(PathProbe::new(account(145, 0), 3, 1_000))
        );
    }

    #[test]
    fn hitting_the_safety_cap_yields_no_probe_at_all() {
        // The failure this cap exists for, and the reason it fails closed: a
        // path with activity every few addresses never opens a gap, so the scan
        // runs out of room. What it saw is a floor, not a total -- reporting it
        // as a result would let a scan limit look like a confirmed answer.
        let busy: Vec<u32> = (0..ADDRESS_CAP).step_by(5).collect();
        let (scan, stop) = scan_to_stop(&busy);
        assert_eq!(stop, ScanStop::CapReached);
        assert!(!stop.is_trustworthy());
        assert_eq!(scan.examined(), ADDRESS_CAP);
        assert!(scan.used_addresses() > 0, "it did see history");
        assert_eq!(
            scan.probe(account(145, 0), 500_000),
            None,
            "a capped scan must not become a probe result"
        );
    }

    #[test]
    fn a_capped_path_leaves_the_outcome_unknown_rather_than_empty() {
        // The two halves joined up: a path that could not be scanned is absent
        // from the results, so the wallet is told "we do not know" instead of
        // "you have no coins" -- which is the whole point of the module.
        let busy: Vec<u32> = (0..ADDRESS_CAP).step_by(5).collect();
        let (capped, _) = scan_to_stop(&busy);
        let (clean, _) = scan_to_stop(&[]);

        let probed: Vec<PathProbe> = [
            capped.probe(account(145, 0), 900_000),
            clean.probe(account(0, 0), 0),
        ]
        .into_iter()
        .flatten()
        .collect();

        let outcome = decide(2, probed);
        assert!(outcome.is_incomplete());
        assert!(outcome.is_unknown());
        assert!(!outcome.found_nothing());
        assert!(!outcome.safe_to_adopt());
        assert_eq!(outcome.unchecked(), 1);
    }

    #[test]
    fn an_untouched_path_still_costs_exactly_one_gap() {
        let (scan, stop) = scan_to_stop(&[]);
        assert_eq!(stop, ScanStop::GapReached);
        assert_eq!(scan.examined(), GAP_LIMIT);
        assert_eq!(scan.used_addresses(), 0);
        // Answered, and answered with nothing -- which is a real answer.
        assert_eq!(
            scan.probe(account(145, 0), 0),
            Some(PathProbe::new(account(145, 0), 0, 0))
        );
        assert!(decide(1, vec![scan.probe(account(145, 0), 0).expect("a probe")]).found_nothing());
    }

    #[test]
    fn a_gap_that_finishes_on_the_cap_still_counts_as_an_answer() {
        // The order of the two checks: a scan that completes its gap exactly as
        // it runs out of room has still answered the question.
        let mut scan = GapScan::with_limits(3, 5);
        assert_eq!(scan.observe(true), None);
        assert_eq!(scan.observe(true), None);
        assert_eq!(scan.observe(false), None);
        assert_eq!(scan.observe(false), None);
        assert_eq!(scan.observe(false), Some(ScanStop::GapReached));
        assert_eq!(scan.examined(), 5);
        assert_eq!(scan.used_addresses(), 2);
    }
}
