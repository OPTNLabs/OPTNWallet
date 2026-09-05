//! Exact Bitcoin Cash transaction fee-rate primitives.
//!
//! Rates are stored as satoshis per 1000 bytes rather than floating point, so
//! the application can represent legacy UI values such as 1.1 sat/B exactly as
//! 1100 sat/kB. Provider/server estimates are inputs; they never own policy.

/// BCH relay floor used by the existing wallet fee policy: ~1 sat/byte.
///
/// Kept in the shared domain layer rather than a provider so changing from
/// Fulcrum to P2P/RPC cannot silently change the user's transaction policy.
pub const RELAY_MINIMUM_FEE_RATE: FeeRate = FeeRate::from_satoshis_per_kb(1000);

/// The historical custom editor starts at 1.1 sat/byte.
///
/// This value is only the remembered custom choice while Auto is selected; it
/// does not override the relay-floor Automatic behavior.
pub const DEFAULT_CUSTOM_FEE_RATE: FeeRate = FeeRate::from_satoshis_per_kb(1100);

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

/// The existing application-wide fee choice. This is wallet policy, not a
/// chain-provider mode: changing Fulcrum/BIP37/RPC routes must not mutate it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FeeMode {
    Auto,
    Custom,
}

/// App-wide user fee policy.
///
/// `auto` accepts a recommendation from the wallet/runtime; `custom` uses the
/// user's requested rate. The final rate is always clamped to the active relay
/// minimum supplied by chain policy. Keeping the floor as an input means this
/// type does not freeze a network policy constant into wallet preferences.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FeePreferences {
    pub mode: FeeMode,
    pub custom_rate: FeeRate,
}

impl FeePreferences {
    pub const fn new(mode: FeeMode, custom_rate: FeeRate) -> Self {
        Self { mode, custom_rate }
    }

    pub const fn auto(custom_rate: FeeRate) -> Self {
        Self::new(FeeMode::Auto, custom_rate)
    }

    pub const fn custom(custom_rate: FeeRate) -> Self {
        Self::new(FeeMode::Custom, custom_rate)
    }

    /// The legacy app-wide preference: Automatic, with 1.1 sat/B remembered
    /// for the custom editor if the user switches modes.
    pub const fn app_default() -> Self {
        Self::auto(DEFAULT_CUSTOM_FEE_RATE)
    }

    /// Resolve one final wallet-owned rate. A provider estimate is advisory
    /// input to Auto; neither that provider nor the selected transport owns the
    /// preference or may bypass the relay floor.
    pub const fn resolve(self, auto_rate: FeeRate, relay_minimum: FeeRate) -> FeeRate {
        let requested = match self.mode {
            FeeMode::Auto => auto_rate,
            FeeMode::Custom => self.custom_rate,
        };
        requested.max(relay_minimum)
    }
}

impl Default for FeePreferences {
    fn default() -> Self {
        Self::app_default()
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
    fn app_default_matches_existing_auto_and_custom_editor_values() {
        let preferences = FeePreferences::app_default();
        assert_eq!(preferences.mode, FeeMode::Auto);
        assert_eq!(preferences.custom_rate, DEFAULT_CUSTOM_FEE_RATE);
        assert_eq!(
            preferences.resolve(RELAY_MINIMUM_FEE_RATE, RELAY_MINIMUM_FEE_RATE),
            RELAY_MINIMUM_FEE_RATE
        );
    }

    #[test]
    fn fee_rounds_up_not_below_rate() {
        let rate = FeeRate::from_satoshis_per_kb(1100);
        assert_eq!(rate.fee_for_bytes(1), 2);
        assert_eq!(rate.fee_for_bytes(1000), 1100);
    }

    #[test]
    fn custom_below_relay_minimum_is_clamped() {
        let relay = FeeRate::from_satoshis_per_kb(1000);
        let preferences = FeePreferences::custom(FeeRate::from_satoshis_per_kb(500));
        assert_eq!(
            preferences.resolve(FeeRate::from_satoshis_per_kb(2500), relay),
            relay
        );
    }

    #[test]
    fn custom_above_floor_is_preserved() {
        let requested = FeeRate::from_satoshis_per_kb(1700);
        let preferences = FeePreferences::custom(requested);
        assert_eq!(
            preferences.resolve(
                FeeRate::from_satoshis_per_kb(2500),
                FeeRate::from_satoshis_per_kb(1000)
            ),
            requested
        );
    }

    #[test]
    fn auto_is_also_clamped_to_relay_minimum() {
        let relay = FeeRate::from_satoshis_per_kb(1000);
        let preferences = FeePreferences::auto(FeeRate::from_satoshis_per_kb(1100));
        assert_eq!(
            preferences.resolve(FeeRate::from_satoshis_per_kb(250), relay),
            relay
        );
    }
}
