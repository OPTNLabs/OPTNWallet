//! Chipnet send planning.
//!
//! Seed wallets produce a fully specified spend that still needs a seed to
//! sign. Watch-only wallets produce an unsigned PSBT intent and never enter
//! the seed-signing function. Frozen coins are not selectable.
//!
//! SIGHASH_ALL|FORKID is `0x41`.

use crate::cashaddr::Address;
use crate::coins::{Coin, CoinSet, Outpoint};
use crate::fee::{FeeRate, RELAY_MINIMUM_FEE_RATE};
use crate::network::Network;
use std::fmt;

/// SIGHASH_ALL (0x01) | SIGHASH_FORKID (0x40).
pub const SIGHASH_ALL_FORKID: u8 = 0x41;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpendingCapability {
    Seed,
    WatchOnly,
    /// Public keys live here; the private key stays on a connected device.
    Hardware,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpendKind {
    /// Inputs, destination, amount, and sighash are fixed. Signing still
    /// requires the seed, which this crate does not store.
    SeedSpecified,
    /// Unsigned PSBT intent. Must not call [`sign_seed_spend`].
    WatchOnlyUnsignedPsbt,
    /// Unsigned PSBT intent to be signed on the device. Also must not call
    /// [`sign_seed_spend`] — a hardware wallet has no seed here to sign with.
    HardwareUnsignedPsbt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendPlan {
    pub selected: Outpoint,
    pub amount_sats: u64,
    pub destination: String,
    pub sighash: u8,
    pub kind: SpendKind,
    /// Final app-owned fee rate selected before provider/broadcast routing.
    ///
    /// The transaction builder still computes the exact fee from the final
    /// serialized byte length. Carrying the rate here ensures seed,
    /// watch-only/PSBT and hardware paths all build from the same resolved
    /// application policy, regardless of whether broadcast later uses
    /// Electrum, P2P or BCHN RPC.
    pub fee_rate: FeeRate,
}

impl SpendPlan {
    pub const fn uses_seed_signing(&self) -> bool {
        matches!(self.kind, SpendKind::SeedSpecified)
    }

    pub const fn fee_for_serialized_bytes(&self, bytes: u64) -> u64 {
        self.fee_rate.fee_for_bytes(bytes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedSpend {
    pub plan: SpendPlan,
    pub compressed_pubkey: [u8; 33],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpendError {
    NoWallet,
    EmptyDestination,
    InvalidDestination(String),
    NetworkMismatch {
        address: String,
        expected: Network,
    },
    ZeroAmount,
    InsufficientSpendable {
        needed: u64,
        available: u64,
    },
    FrozenCoin,
    /// Coin control: the chosen coin is not in this wallet.
    UnknownCoin,
    /// Coin control: the chosen coin does not cover the amount. Distinct from
    /// InsufficientSpendable, which is about the wallet as a whole -- here the
    /// wallet may hold plenty, just not in the coin the user picked.
    CoinTooSmall {
        needed: u64,
        coin_value: u64,
    },
    WatchOnlyCannotSign,
    HardwareMustSignOnDevice,
    AccountNetworkMismatch {
        account: String,
        expected: Network,
    },
    Seed(String),
}

impl fmt::Display for SpendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoWallet => write!(f, "open a wallet first"),
            Self::EmptyDestination => write!(f, "enter a destination address"),
            Self::InvalidDestination(address) => {
                write!(f, "invalid destination address {address}")
            }
            Self::NetworkMismatch { address, expected } => {
                write!(f, "destination {address} is not a {expected} address")
            }
            Self::ZeroAmount => write!(f, "send amount must be greater than zero"),
            Self::InsufficientSpendable { needed, available } => {
                write!(
                    f,
                    "need {needed} spendable sats, only {available} available"
                )
            }
            Self::FrozenCoin => write!(f, "frozen coins cannot be selected for a send"),
            Self::UnknownCoin => write!(f, "that coin is not in this wallet"),
            Self::CoinTooSmall { needed, coin_value } => write!(
                f,
                "that coin holds {coin_value} sats, which does not cover {needed}"
            ),
            Self::WatchOnlyCannotSign => {
                write!(
                    f,
                    "watch-only wallets produce an unsigned PSBT and cannot seed-sign"
                )
            }
            Self::HardwareMustSignOnDevice => {
                write!(
                    f,
                    "hardware wallets sign on the device; there is no seed here to sign with"
                )
            }
            Self::AccountNetworkMismatch { account, expected } => {
                write!(f, "account {account} is not derived for {expected}")
            }
            Self::Seed(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for SpendError {}

/// Choose a spendable coin and build a send plan at the relay-minimum rate.
///
/// Kept for compatibility with callers that have not yet supplied the
/// application preference. New application code should use
/// [`prepare_spend_with_fee`] after resolving `FeePreferences`.
pub fn prepare_spend(
    coins: &CoinSet,
    network: Network,
    destination: &str,
    amount_sats: u64,
    capability: SpendingCapability,
) -> Result<SpendPlan, SpendError> {
    prepare_spend_with_fee(
        coins,
        network,
        destination,
        amount_sats,
        capability,
        RELAY_MINIMUM_FEE_RATE,
    )
}

/// Build a plan with an explicitly resolved app-wide fee rate.
pub fn prepare_spend_with_fee(
    coins: &CoinSet,
    network: Network,
    destination: &str,
    amount_sats: u64,
    capability: SpendingCapability,
    fee_rate: FeeRate,
) -> Result<SpendPlan, SpendError> {
    prepare_spend_with_fee_and_coin(
        coins,
        network,
        destination,
        amount_sats,
        capability,
        fee_rate,
        None,
    )
}

/// Coin control: build the same plan from a coin the user picked.
///
/// `chosen` of `None` selects automatically, which is what `prepare_spend`
/// does. Naming a coin means the wallet uses that coin or says why it cannot;
/// silently substituting another would defeat the entire point of coin
/// control, which people use to keep specific histories apart.
///
/// This compatibility entry point uses the relay-minimum rate. App code with a
/// resolved `FeePreferences` value should call
/// [`prepare_spend_with_fee_and_coin`].
pub fn prepare_spend_with(
    coins: &CoinSet,
    network: Network,
    destination: &str,
    amount_sats: u64,
    capability: SpendingCapability,
    chosen: Option<Outpoint>,
) -> Result<SpendPlan, SpendError> {
    prepare_spend_with_fee_and_coin(
        coins,
        network,
        destination,
        amount_sats,
        capability,
        RELAY_MINIMUM_FEE_RATE,
        chosen,
    )
}

/// Coin control plus an explicitly resolved application fee rate.
pub fn prepare_spend_with_fee_and_coin(
    coins: &CoinSet,
    network: Network,
    destination: &str,
    amount_sats: u64,
    capability: SpendingCapability,
    fee_rate: FeeRate,
    chosen: Option<Outpoint>,
) -> Result<SpendPlan, SpendError> {
    let trimmed = destination.trim();
    if trimmed.is_empty() {
        return Err(SpendError::EmptyDestination);
    }
    if amount_sats == 0 {
        return Err(SpendError::ZeroAmount);
    }
    let address =
        Address::decode(trimmed).map_err(|_| SpendError::InvalidDestination(trimmed.to_owned()))?;
    if address.prefix != network.prefix() {
        return Err(SpendError::NetworkMismatch {
            address: trimmed.to_owned(),
            expected: network,
        });
    }

    // A named coin is judged on its own before the wallet-wide balance,
    // because "that coin is frozen" answers the question the user actually
    // asked. Reporting a zero spendable balance would be true and useless.
    let selected = match chosen {
        // Coin control: the user named the coin, so the wallet must use that
        // one or explain why it cannot -- never quietly substitute another.
        Some(outpoint) => {
            let coin = coins.get(outpoint).ok_or(SpendError::UnknownCoin)?;
            if coin.is_reserved() {
                return Err(SpendError::FrozenCoin);
            }
            if coin.value_sats() < amount_sats {
                return Err(SpendError::CoinTooSmall {
                    needed: amount_sats,
                    coin_value: coin.value_sats(),
                });
            }
            coin
        }
        None => {
            let available = coins.spendable_sats();
            if available < amount_sats {
                return Err(SpendError::InsufficientSpendable {
                    needed: amount_sats,
                    available,
                });
            }
            let coin = coins
                .spendable()
                .find(|coin| coin.value_sats() >= amount_sats)
                .ok_or(SpendError::InsufficientSpendable {
                    needed: amount_sats,
                    available,
                })?;
            if coin.is_reserved() {
                return Err(SpendError::FrozenCoin);
            }
            coin
        }
    };

    Ok(SpendPlan {
        selected: selected.outpoint(),
        amount_sats,
        destination: address.encode(),
        sighash: SIGHASH_ALL_FORKID,
        kind: match capability {
            SpendingCapability::Seed => SpendKind::SeedSpecified,
            SpendingCapability::WatchOnly => SpendKind::WatchOnlyUnsignedPsbt,
            SpendingCapability::Hardware => SpendKind::HardwareUnsignedPsbt,
        },
        fee_rate,
    })
}

/// Seed-signing entry point. Watch-only and hardware plans must not call this.
///
/// The account is passed in rather than assumed: a wallet opened at a chosen
/// BIP44 account must be signed with that account's key, and deriving the
/// network default here would produce a signature from a key that does not
/// own the input.
pub fn sign_seed_spend(
    plan: &SpendPlan,
    mnemonic: &str,
    network: Network,
    account: crate::hd::AccountPath,
) -> Result<SignedSpend, SpendError> {
    match plan.kind {
        SpendKind::SeedSpecified => {}
        SpendKind::WatchOnlyUnsignedPsbt => return Err(SpendError::WatchOnlyCannotSign),
        SpendKind::HardwareUnsignedPsbt => return Err(SpendError::HardwareMustSignOnDevice),
    }
    // An account this network never scans is a mix-up, not a preference —
    // signing a mainnet plan with a testnet-coin-type key produces a valid
    // signature from a key that owns nothing on this chain.
    if !account.is_scanned_for(network) {
        return Err(SpendError::AccountNetworkMismatch {
            account: account.to_string(),
            expected: network,
        });
    }
    let wallet = crate::hd::Wallet::from_mnemonic(mnemonic, "")
        .map_err(|error| SpendError::Seed(error.to_string()))?;
    let path = account.address_path(false, 0);
    let compressed_pubkey = wallet
        .public_key(&path)
        .map_err(|error| SpendError::Seed(error.to_string()))?;
    Ok(SignedSpend {
        plan: plan.clone(),
        compressed_pubkey,
    })
}

pub fn assert_coin_is_spendable(coin: &Coin) -> Result<(), SpendError> {
    if coin.is_reserved() {
        Err(SpendError::FrozenCoin)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cashaddr::{Address, AddressKind};
    use crate::coins::FreezeReason;
    use crate::flipstarter::chipnet_demo_coin;
    use crate::hd::BIP39_TEST_VECTOR_MNEMONIC;

    fn dest() -> String {
        Address::from_hash(Network::Chipnet.prefix(), AddressKind::P2pkh, [0x7a; 20]).encode()
    }

    /// One spendable 8_000 sat chipnet coin.
    fn funded() -> CoinSet {
        let mut coins = CoinSet::new();
        coins
            .insert(chipnet_demo_coin(8_000, 1).expect("coin"))
            .expect("insert");
        coins
    }

    #[test]
    fn spendable_coin_is_selected_and_frozen_coin_is_not() {
        let mut coins = CoinSet::new();
        let spendable = chipnet_demo_coin(8_000, 1).expect("spendable");
        let frozen = chipnet_demo_coin(8_000, 2).expect("frozen");
        let frozen_out = frozen.outpoint();
        coins.insert(spendable).expect("insert spendable");
        coins.insert(frozen).expect("insert frozen");
        coins
            .freeze(frozen_out, FreezeReason::User)
            .expect("freeze");

        let plan = prepare_spend(
            &coins,
            Network::Chipnet,
            &dest(),
            8_000,
            SpendingCapability::Seed,
        )
        .expect("prepare");
        assert_eq!(plan.sighash, SIGHASH_ALL_FORKID);
        assert_eq!(plan.kind, SpendKind::SeedSpecified);
        assert_eq!(plan.fee_rate, RELAY_MINIMUM_FEE_RATE);
        assert!(plan.uses_seed_signing());
        assert_ne!(plan.selected, frozen_out);

        let mut only_frozen = CoinSet::new();
        only_frozen
            .insert(chipnet_demo_coin(8_000, 3).expect("coin"))
            .expect("insert");
        let only = only_frozen.iter().next().expect("coin").outpoint();
        only_frozen
            .freeze(only, FreezeReason::User)
            .expect("freeze");
        assert!(matches!(
            prepare_spend(
                &only_frozen,
                Network::Chipnet,
                &dest(),
                8_000,
                SpendingCapability::Seed,
            ),
            Err(SpendError::InsufficientSpendable { .. })
        ));
    }

    #[test]
    fn explicit_fee_rate_survives_into_every_spend_kind() {
        let coins = funded();
        let rate = FeeRate::from_satoshis_per_kb(1700);
        for capability in [
            SpendingCapability::Seed,
            SpendingCapability::WatchOnly,
            SpendingCapability::Hardware,
        ] {
            let plan = prepare_spend_with_fee(
                &coins,
                Network::Chipnet,
                &dest(),
                5_000,
                capability,
                rate,
            )
            .expect("prepare");
            assert_eq!(plan.fee_rate, rate);
            assert_eq!(plan.fee_for_serialized_bytes(250), 425);
        }
    }

    #[test]
    fn watch_only_prepare_returns_unsigned_psbt_and_cannot_seed_sign() {
        let mut coins = CoinSet::new();
        coins
            .insert(chipnet_demo_coin(5_000, 4).expect("coin"))
            .expect("insert");
        let plan = prepare_spend(
            &coins,
            Network::Chipnet,
            &dest(),
            5_000,
            SpendingCapability::WatchOnly,
        )
        .expect("prepare");
        assert_eq!(plan.kind, SpendKind::WatchOnlyUnsignedPsbt);
        assert!(!plan.uses_seed_signing());
        assert_eq!(plan.sighash, 0x41);
        let chipnet_account = crate::hd::AccountPath::default_for(Network::Chipnet);
        assert_eq!(
            sign_seed_spend(
                &plan,
                BIP39_TEST_VECTOR_MNEMONIC,
                Network::Chipnet,
                chipnet_account
            ),
            Err(SpendError::WatchOnlyCannotSign)
        );
    }

    #[test]
    fn coin_control_spends_the_named_coin_or_explains_why_not() {
        // The point of coin control is keeping histories apart, so a named
        // coin must never be silently swapped for a more convenient one.
        let mut coins = CoinSet::new();
        let small = chipnet_demo_coin(3_000, 1).expect("small");
        let large = chipnet_demo_coin(9_000, 2).expect("large");
        let small_out = small.outpoint();
        let large_out = large.outpoint();
        coins.insert(small).expect("insert");
        coins.insert(large).expect("insert");

        // Automatic selection is free to take either.
        let auto = prepare_spend(
            &coins,
            Network::Chipnet,
            &dest(),
            2_000,
            SpendingCapability::Seed,
        )
        .expect("auto");
        assert!(auto.selected == small_out || auto.selected == large_out);

        // Naming the large coin uses exactly that coin.
        let picked = prepare_spend_with(
            &coins,
            Network::Chipnet,
            &dest(),
            2_000,
            SpendingCapability::Seed,
            Some(large_out),
        )
        .expect("named coin");
        assert_eq!(picked.selected, large_out);

        // A coin that cannot cover the amount is refused by name, even though
        // the wallet as a whole holds plenty. Falling back to the other coin
        // would spend a history the user was keeping separate.
        assert_eq!(
            prepare_spend_with(
                &coins,
                Network::Chipnet,
                &dest(),
                5_000,
                SpendingCapability::Seed,
                Some(small_out),
            ),
            Err(SpendError::CoinTooSmall {
                needed: 5_000,
                coin_value: 3_000,
            })
        );

        // A coin from another wallet is not silently ignored.
        let stranger = chipnet_demo_coin(9_000, 9).expect("stranger");
        assert_eq!(
            prepare_spend_with(
                &coins,
                Network::Chipnet,
                &dest(),
                1_000,
                SpendingCapability::Seed,
                Some(stranger.outpoint()),
            ),
            Err(SpendError::UnknownCoin)
        );
    }

    #[test]
    fn a_frozen_coin_is_refused_even_when_named_directly() {
        // Freezing is the whole reservation primitive: Flipstarter pledges and
        // user freezes both use it. Naming a frozen coin must not be a way
        // around it.
        let mut coins = CoinSet::new();
        let coin = chipnet_demo_coin(9_000, 1).expect("coin");
        let outpoint = coin.outpoint();
        coins.insert(coin).expect("insert");
        coins
            .freeze(outpoint, FreezeReason::FlipstarterPledge)
            .expect("freeze");

        assert_eq!(
            prepare_spend_with(
                &coins,
                Network::Chipnet,
                &dest(),
                1_000,
                SpendingCapability::Seed,
                Some(outpoint),
            ),
            Err(SpendError::FrozenCoin)
        );
        // And it is not reachable automatically either.
        assert!(matches!(
            prepare_spend(
                &coins,
                Network::Chipnet,
                &dest(),
                1_000,
                SpendingCapability::Seed
            ),
            Err(SpendError::InsufficientSpendable { .. })
        ));
    }

    #[test]
    fn a_hardware_plan_is_unsigned_and_refuses_to_seed_sign() {
        let coins = funded();
        let plan = prepare_spend(
            &coins,
            Network::Chipnet,
            &dest(),
            5_000,
            SpendingCapability::Hardware,
        )
        .expect("prepare");
        assert_eq!(plan.kind, SpendKind::HardwareUnsignedPsbt);
        assert!(
            !plan.uses_seed_signing(),
            "a hardware plan must never take the seed-signing path"
        );
        assert_eq!(
            sign_seed_spend(
                &plan,
                BIP39_TEST_VECTOR_MNEMONIC,
                Network::Chipnet,
                crate::hd::AccountPath::default_for(Network::Chipnet)
            ),
            Err(SpendError::HardwareMustSignOnDevice)
        );
    }

    #[test]
    fn seed_signing_uses_the_wallets_account_and_refuses_a_foreign_one() {
        let coins = funded();
        let plan = prepare_spend(
            &coins,
            Network::Chipnet,
            &dest(),
            5_000,
            SpendingCapability::Seed,
        )
        .expect("prepare");

        let default = crate::hd::AccountPath::default_for(Network::Chipnet);
        let second = crate::hd::AccountPath::new(1, 1).expect("in range");
        let first_key =
            sign_seed_spend(&plan, BIP39_TEST_VECTOR_MNEMONIC, Network::Chipnet, default)
                .expect("default account signs")
                .compressed_pubkey;
        let second_key =
            sign_seed_spend(&plan, BIP39_TEST_VECTOR_MNEMONIC, Network::Chipnet, second)
                .expect("second account signs")
                .compressed_pubkey;
        assert_ne!(
            first_key, second_key,
            "the signing key must follow the wallet's account, not the network default"
        );

        // Coin type 145 is scanned on chipnet, but 0 is only scanned via the
        // legacy list; a mainnet-only account on chipnet is still a mix-up.
        let foreign = crate::hd::AccountPath::new(9999, 0).expect("in range");
        assert_eq!(
            sign_seed_spend(&plan, BIP39_TEST_VECTOR_MNEMONIC, Network::Chipnet, foreign),
            Err(SpendError::AccountNetworkMismatch {
                account: "m/44'/9999'/0'".to_string(),
                expected: Network::Chipnet,
            })
        );
    }
}
