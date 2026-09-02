//! Chipnet send planning.
//!
//! Seed wallets produce a fully specified spend that still needs a seed to
//! sign. Watch-only wallets produce an unsigned PSBT intent and never enter
//! the seed-signing function. Frozen coins are not selectable.
//!
//! SIGHASH_ALL|FORKID is `0x41`.

use crate::cashaddr::Address;
use crate::coins::{Coin, CoinSet, Outpoint};
use crate::network::Network;
use std::fmt;

/// SIGHASH_ALL (0x01) | SIGHASH_FORKID (0x40).
pub const SIGHASH_ALL_FORKID: u8 = 0x41;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpendingCapability {
    Seed,
    WatchOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpendKind {
    /// Inputs, destination, amount, and sighash are fixed. Signing still
    /// requires the seed, which this crate does not store.
    SeedSpecified,
    /// Unsigned PSBT intent. Must not call [`sign_seed_spend`].
    WatchOnlyUnsignedPsbt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendPlan {
    pub selected: Outpoint,
    pub amount_sats: u64,
    pub destination: String,
    pub sighash: u8,
    pub kind: SpendKind,
}

impl SpendPlan {
    pub const fn uses_seed_signing(&self) -> bool {
        matches!(self.kind, SpendKind::SeedSpecified)
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
    NetworkMismatch { address: String, expected: Network },
    ZeroAmount,
    InsufficientSpendable { needed: u64, available: u64 },
    FrozenCoin,
    WatchOnlyCannotSign,
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
            Self::WatchOnlyCannotSign => {
                write!(
                    f,
                    "watch-only wallets produce an unsigned PSBT and cannot seed-sign"
                )
            }
            Self::Seed(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for SpendError {}

/// Choose a spendable coin and build a Chipnet (or matching-network) send plan.
pub fn prepare_spend(
    coins: &CoinSet,
    network: Network,
    destination: &str,
    amount_sats: u64,
    capability: SpendingCapability,
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

    let available = coins.spendable_sats();
    if available < amount_sats {
        return Err(SpendError::InsufficientSpendable {
            needed: amount_sats,
            available,
        });
    }

    let selected = coins
        .spendable()
        .find(|coin| coin.value_sats() >= amount_sats)
        .ok_or(SpendError::InsufficientSpendable {
            needed: amount_sats,
            available,
        })?;
    if selected.is_reserved() {
        return Err(SpendError::FrozenCoin);
    }

    Ok(SpendPlan {
        selected: selected.outpoint(),
        amount_sats,
        destination: address.encode(),
        sighash: SIGHASH_ALL_FORKID,
        kind: match capability {
            SpendingCapability::Seed => SpendKind::SeedSpecified,
            SpendingCapability::WatchOnly => SpendKind::WatchOnlyUnsignedPsbt,
        },
    })
}

/// Seed-signing entry point. Watch-only plans must not call this.
pub fn sign_seed_spend(
    plan: &SpendPlan,
    mnemonic: &str,
    network: Network,
) -> Result<SignedSpend, SpendError> {
    if !plan.uses_seed_signing() {
        return Err(SpendError::WatchOnlyCannotSign);
    }
    let wallet = crate::hd::Wallet::from_mnemonic(mnemonic, "")
        .map_err(|error| SpendError::Seed(error.to_string()))?;
    let path = crate::hd::address_path(network.default_coin_type(), 0, false, 0);
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
        assert_eq!(
            sign_seed_spend(&plan, BIP39_TEST_VECTOR_MNEMONIC, Network::Chipnet),
            Err(SpendError::WatchOnlyCannotSign)
        );
    }
}
