//! Exact Bitcoin Cash transaction fee-rate primitives.
//!
//! Rates are stored as satoshis per 1000 bytes rather than floating point, so
//! the application can represent legacy UI values such as 1.1 sat/B exactly as
//! 1100 sat/kB. Provider/server estimates are inputs; they never own policy.

/// Exact fee rate in satoshis per 1000 serialized transaction bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FeeRate {
    satoshis_per_kb: u64,
}

impl FeeRate {
    pub const fn from_satoshis_per_kb(satoshis_per_kb: u64) -> Self {
        Self { satoshis_per_kb }
    }

    pub const fn satoshis_per_kb(self) -> u64 {
        self.satoshis_per_kb
    }

    /// Construct from thousandths of a satoshi per byte. Numerically this is
    /// identical to satoshis per kB: 1.1 sat/B = 1100 milli-sat/B = 1100 sat/kB.
    pub const fn from_millisatoshi_per_byte(millisatoshi_per_byte: u64) -> Self {
        Self::from_satoshis_per_kb(millisatoshi_per_byte)
    }

    pub const fn millisatoshi_per_byte(self) -> u64 {
        self.satoshis_per_kb
    }

    pub const fn max(self, other: Self) -> Self {
        if self.satoshis_per_kb >= other.satoshis_per_kb {
            self
        } else {
            other
        }
    }

    /// Fee for an exact serialized byte length, rounded upward so the effective
    /// fee rate never falls below the requested rate because of integer division.
    pub const fn fee_for_bytes(self, bytes: u64) -> u64 {
        if bytes == 0 || self.satoshis_per_kb == 0 {
            return 0;
        }
        let product = self.satoshis_per_kb.saturating_mul(bytes);
        product.saturating_add(999) / 1000
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_one_point_one_sat_per_byte_is_exact_without_float() {
        let rate = FeeRate::from_millisatoshi_per_byte(1100);
        assert_eq!(rate.satoshis_per_kb(), 1100);
        assert_eq!(rate.fee_for_bytes(250), 275);
    }

    #[test]
    fn fee_rounds_up_not_below_rate() {
        let rate = FeeRate::from_satoshis_per_kb(1100);
        assert_eq!(rate.fee_for_bytes(1), 2);
        assert_eq!(rate.fee_for_bytes(1000), 1100);
    }

    #[test]
    fn max_is_a_relay_floor_primitive() {
        let relay = FeeRate::from_satoshis_per_kb(1000);
        assert_eq!(FeeRate::from_satoshis_per_kb(500).max(relay), relay);
        assert_eq!(
            FeeRate::from_satoshis_per_kb(1500).max(relay),
            FeeRate::from_satoshis_per_kb(1500)
        );
    }
}
