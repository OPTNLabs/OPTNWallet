//! Portfolio totals, including the RPA stealth pool.
//!
//! Reusable Payment Address funds are tracked separately from the ordinary
//! UTXO set — the React selector says so outright: *"Stealth BCH sats already
//! claimed/scanned for this wallet. Not in UTXO total."*
//!
//! That separation is the whole hazard. Stealth sats have to be **added** to
//! the UTXO balance to get the portfolio total, and counting them inside the
//! UTXO set as well would double them. Getting it wrong in the other
//! direction hides real funds. So the two pools are separate fields here and
//! the total is the only place they meet.

use crate::format_bch;

/// What the wallet holds, split by where it is held.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PortfolioTotals {
    /// Ordinary spendable UTXOs.
    pub spendable_sats: u64,
    /// UTXOs held by a freeze or a pledge.
    pub reserved_sats: u64,
    /// RPA stealth funds. Never part of the UTXO totals above.
    pub stealth_sats: u64,
}

impl PortfolioTotals {
    /// Everything the wallet controls.
    ///
    /// Saturating because a balance is not worth wrapping: a wrapped total
    /// would read as near zero on a wallet that holds a great deal.
    pub const fn total_sats(&self) -> u64 {
        self.spendable_sats
            .saturating_add(self.reserved_sats)
            .saturating_add(self.stealth_sats)
    }

    /// The UTXO half alone, which is what a spend can draw on today.
    pub const fn utxo_sats(&self) -> u64 {
        self.spendable_sats.saturating_add(self.reserved_sats)
    }

    /// Whether the split is worth showing. The React home screen only breaks
    /// the total down when there is stealth to explain.
    pub const fn shows_split(&self) -> bool {
        self.stealth_sats > 0
    }

    /// `0.00100000 BCH spendable + 0.00050000 BCH stealth`, or `None` when
    /// there is no stealth balance to account for.
    pub fn split_label(&self) -> Option<String> {
        self.shows_split().then(|| {
            format!(
                "{} spendable + {} stealth",
                format_bch(self.spendable_sats),
                format_bch(self.stealth_sats)
            )
        })
    }
}

/// Stealth sats from a stored RPA record.
///
/// Ported from `rpaPayloadStealthSats`, including its defensiveness: the
/// record carries both a summary field and the outputs it was summed from,
/// and the larger of the two wins. The field was historically written as a
/// string and can be stale or absent, while a truncated output list would
/// under-report. Taking the maximum fails towards showing funds that exist
/// rather than hiding them.
pub fn stealth_sats_from_record(unspent_sats: Option<u64>, output_values: &[u64]) -> u64 {
    let from_outputs = output_values
        .iter()
        .copied()
        .fold(0u64, u64::saturating_add);
    unspent_sats.unwrap_or(0).max(from_outputs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stealth_is_added_to_the_total_and_never_folded_into_the_utxo_set() {
        let totals = PortfolioTotals {
            spendable_sats: 100_000,
            reserved_sats: 20_000,
            stealth_sats: 50_000,
        };
        // The hazard this module exists for: counted once, in the total.
        assert_eq!(totals.utxo_sats(), 120_000, "stealth is not a UTXO");
        assert_eq!(totals.total_sats(), 170_000);
    }

    #[test]
    fn the_split_is_only_shown_when_there_is_stealth_to_explain() {
        let plain = PortfolioTotals {
            spendable_sats: 100_000,
            reserved_sats: 0,
            stealth_sats: 0,
        };
        assert!(!plain.shows_split());
        assert_eq!(plain.split_label(), None);
        assert_eq!(plain.total_sats(), 100_000);

        let stealthy = PortfolioTotals {
            stealth_sats: 50_000,
            ..plain
        };
        assert!(stealthy.shows_split());
        assert_eq!(
            stealthy.split_label().as_deref(),
            Some("0.00100000 BCH spendable + 0.00050000 BCH stealth")
        );
    }

    #[test]
    fn a_record_reports_the_larger_of_its_summary_and_its_outputs() {
        // The summary field can be stale or absent; a truncated output list
        // under-reports. The larger wins, so the failure is towards showing
        // funds that exist rather than hiding them.
        assert_eq!(
            stealth_sats_from_record(Some(5_000), &[1_000, 2_000]),
            5_000
        );
        assert_eq!(
            stealth_sats_from_record(Some(1_000), &[3_000, 4_000]),
            7_000
        );
        assert_eq!(stealth_sats_from_record(None, &[3_000, 4_000]), 7_000);
        assert_eq!(stealth_sats_from_record(Some(9_000), &[]), 9_000);
        assert_eq!(stealth_sats_from_record(None, &[]), 0);
    }

    #[test]
    fn a_balance_saturates_rather_than_wrapping_to_nearly_nothing() {
        // A wrapped total would read as almost empty on a wallet holding a
        // great deal, which is the worst way for this to fail.
        let huge = PortfolioTotals {
            spendable_sats: u64::MAX,
            reserved_sats: 1,
            stealth_sats: 1,
        };
        assert_eq!(huge.total_sats(), u64::MAX);
        assert_eq!(huge.utxo_sats(), u64::MAX);
        assert_eq!(stealth_sats_from_record(None, &[u64::MAX, 10]), u64::MAX);
    }
}
