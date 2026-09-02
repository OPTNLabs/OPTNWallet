//! UTXO freeze and reserve policy.
//!
//! A frozen coin is reserved: it is not available for ordinary send, Fusion
//! selection, or a new Flipstarter pledge. The freeze reason is part of the
//! domain model so Flipstarter holds are not mixed with user holds or with
//! FundMe.

use std::fmt;

/// Transaction outpoint. `txid` is the 32-byte transaction hash as stored on
/// chain (displayed as hex, not reversed for RPC).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Outpoint {
    txid: [u8; 32],
    vout: u32,
}

impl Outpoint {
    pub const fn new(txid: [u8; 32], vout: u32) -> Self {
        Self { txid, vout }
    }

    pub fn parse(txid_hex: &str, vout: u32) -> Result<Self, CoinError> {
        Ok(Self {
            txid: parse_txid(txid_hex)?,
            vout,
        })
    }

    pub const fn txid(&self) -> [u8; 32] {
        self.txid
    }

    pub const fn vout(&self) -> u32 {
        self.vout
    }

    pub fn txid_hex(&self) -> String {
        hex_encode(&self.txid)
    }
}

impl fmt::Display for Outpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.txid_hex(), self.vout)
    }
}

/// Why a coin is reserved. Flipstarter pledges use their own reason so a
/// FundMe flag cannot masquerade as a Flipstarter hold, and a user freeze
/// cannot be confused with a campaign pledge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FreezeReason {
    User,
    FlipstarterPledge,
    Authhead,
}

impl FreezeReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::FlipstarterPledge => "flipstarter-pledge",
            Self::Authhead => "authhead",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Coin {
    outpoint: Outpoint,
    value_sats: u64,
    address: String,
    label: Option<String>,
    freeze: Option<FreezeReason>,
}

impl Coin {
    pub fn new(
        outpoint: Outpoint,
        value_sats: u64,
        address: impl Into<String>,
    ) -> Result<Self, CoinError> {
        let address = address.into();
        if value_sats == 0 {
            return Err(CoinError::ZeroValue);
        }
        if address.trim().is_empty() {
            return Err(CoinError::EmptyAddress);
        }
        Ok(Self {
            outpoint,
            value_sats,
            address,
            label: None,
            freeze: None,
        })
    }

    pub const fn outpoint(&self) -> Outpoint {
        self.outpoint
    }

    pub const fn value_sats(&self) -> u64 {
        self.value_sats
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    pub fn label(&self) -> Option<&str> {
        self.label.as_deref()
    }

    pub const fn freeze(&self) -> Option<FreezeReason> {
        self.freeze
    }

    pub const fn is_spendable(&self) -> bool {
        self.freeze.is_none()
    }

    pub const fn is_reserved(&self) -> bool {
        self.freeze.is_some()
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        let label = label.into();
        self.label = if label.trim().is_empty() {
            None
        } else {
            Some(label)
        };
        self
    }

    pub fn set_label(&mut self, label: Option<String>) {
        self.label = label.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_owned())
            }
        });
    }

    /// Rebuild freeze state from a persisted snapshot. User freeze/unfreeze
    /// still go through [`CoinSet`].
    pub fn restore_freeze(&mut self, freeze: Option<FreezeReason>) {
        self.freeze = freeze;
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CoinSet {
    coins: Vec<Coin>,
}

impl CoinSet {
    pub const fn new() -> Self {
        Self { coins: Vec::new() }
    }

    pub fn len(&self) -> usize {
        self.coins.len()
    }

    pub fn is_empty(&self) -> bool {
        self.coins.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Coin> {
        self.coins.iter()
    }

    pub fn insert(&mut self, coin: Coin) -> Result<(), CoinError> {
        if self
            .coins
            .iter()
            .any(|existing| existing.outpoint == coin.outpoint)
        {
            return Err(CoinError::DuplicateOutpoint);
        }
        self.coins.push(coin);
        Ok(())
    }

    pub fn get(&self, outpoint: Outpoint) -> Option<&Coin> {
        self.coins.iter().find(|coin| coin.outpoint == outpoint)
    }

    pub fn freeze(&mut self, outpoint: Outpoint, reason: FreezeReason) -> Result<(), CoinError> {
        let coin = self
            .coins
            .iter_mut()
            .find(|coin| coin.outpoint == outpoint)
            .ok_or(CoinError::UnknownOutpoint)?;
        if coin.freeze.is_some() {
            return Err(CoinError::AlreadyFrozen);
        }
        coin.freeze = Some(reason);
        Ok(())
    }

    pub fn unfreeze(&mut self, outpoint: Outpoint) -> Result<FreezeReason, CoinError> {
        let coin = self
            .coins
            .iter_mut()
            .find(|coin| coin.outpoint == outpoint)
            .ok_or(CoinError::UnknownOutpoint)?;
        match coin.freeze.take() {
            Some(reason) => Ok(reason),
            None => Err(CoinError::NotFrozen),
        }
    }

    pub fn spendable(&self) -> impl Iterator<Item = &Coin> {
        self.coins.iter().filter(|coin| coin.is_spendable())
    }

    pub fn reserved(&self) -> impl Iterator<Item = &Coin> {
        self.coins.iter().filter(|coin| coin.is_reserved())
    }

    pub fn spendable_sats(&self) -> u64 {
        self.spendable().map(Coin::value_sats).sum()
    }

    pub fn reserved_sats(&self) -> u64 {
        self.reserved().map(Coin::value_sats).sum()
    }

    pub fn find_exact_spendable(&self, amount_sats: u64) -> Option<&Coin> {
        self.spendable().find(|coin| coin.value_sats == amount_sats)
    }

    /// Drop chain/UTXO state. The opened seed session lives outside this set.
    pub fn clear(&mut self) {
        self.coins.clear();
    }

    pub fn set_label(
        &mut self,
        outpoint: Outpoint,
        label: Option<String>,
    ) -> Result<(), CoinError> {
        let coin = self
            .coins
            .iter_mut()
            .find(|coin| coin.outpoint == outpoint)
            .ok_or(CoinError::UnknownOutpoint)?;
        coin.set_label(label);
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoinError {
    DuplicateOutpoint,
    UnknownOutpoint,
    AlreadyFrozen,
    NotFrozen,
    ZeroValue,
    EmptyAddress,
    InvalidTxid,
}

impl fmt::Display for CoinError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateOutpoint => write!(f, "that coin is already in the set"),
            Self::UnknownOutpoint => write!(f, "unknown coin"),
            Self::AlreadyFrozen => write!(f, "coin is already frozen"),
            Self::NotFrozen => write!(f, "coin is not frozen"),
            Self::ZeroValue => write!(f, "coin value must be greater than zero"),
            Self::EmptyAddress => write!(f, "coin address is empty"),
            Self::InvalidTxid => write!(f, "txid must be 32 bytes of hex"),
        }
    }
}

impl std::error::Error for CoinError {}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn parse_txid(txid_hex: &str) -> Result<[u8; 32], CoinError> {
    let hex = txid_hex.trim();
    if hex.len() != 64 {
        return Err(CoinError::InvalidTxid);
    }
    let mut txid = [0u8; 32];
    for (index, chunk) in hex.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        let hi = hex_nibble(chunk[0]).ok_or(CoinError::InvalidTxid)?;
        let lo = hex_nibble(chunk[1]).ok_or(CoinError::InvalidTxid)?;
        txid[index] = (hi << 4) | lo;
    }
    Ok(txid)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coin(slot: u8, value: u64) -> Coin {
        let mut txid = [0u8; 32];
        txid[31] = slot;
        Coin::new(
            Outpoint::new(txid, 0),
            value,
            "bchtest:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
        )
        .expect("coin")
    }

    #[test]
    fn frozen_coins_are_reserved_not_spendable() {
        let mut set = CoinSet::new();
        set.insert(coin(1, 10_000)).expect("insert");
        set.insert(coin(2, 20_000)).expect("insert");
        let frozen = coin(1, 10_000).outpoint();
        set.freeze(frozen, FreezeReason::User).expect("freeze");

        assert_eq!(set.spendable_sats(), 20_000);
        assert_eq!(set.reserved_sats(), 10_000);
        assert!(set.get(frozen).is_some_and(Coin::is_reserved));
        assert_eq!(
            set.get(frozen).and_then(Coin::freeze),
            Some(FreezeReason::User)
        );
        assert!(set.find_exact_spendable(10_000).is_none());
        assert_eq!(
            set.find_exact_spendable(20_000).map(Coin::outpoint),
            Some(coin(2, 20_000).outpoint())
        );
    }

    #[test]
    fn unfreeze_returns_the_reason_and_restores_spendable() {
        let mut set = CoinSet::new();
        let item = coin(3, 5_000);
        let outpoint = item.outpoint();
        set.insert(item).expect("insert");
        set.freeze(outpoint, FreezeReason::FlipstarterPledge)
            .expect("freeze");
        assert_eq!(
            set.unfreeze(outpoint).expect("unfreeze"),
            FreezeReason::FlipstarterPledge
        );
        assert_eq!(set.spendable_sats(), 5_000);
        assert_eq!(set.unfreeze(outpoint), Err(CoinError::NotFrozen));
    }

    #[test]
    fn zero_value_and_duplicate_outpoints_are_rejected() {
        let mut txid = [0u8; 32];
        txid[0] = 9;
        let outpoint = Outpoint::new(txid, 1);
        assert_eq!(
            Coin::new(outpoint, 0, "bchtest:qq").err(),
            Some(CoinError::ZeroValue)
        );
        let mut set = CoinSet::new();
        set.insert(coin(4, 1_000)).expect("insert");
        assert_eq!(
            set.insert(coin(4, 2_000)),
            Err(CoinError::DuplicateOutpoint)
        );
    }

    #[test]
    fn clear_wipes_chain_coins_and_keeps_the_set_usable() {
        let mut set = CoinSet::new();
        set.insert(coin(5, 7_000)).expect("insert");
        set.freeze(coin(5, 7_000).outpoint(), FreezeReason::User)
            .expect("freeze");
        assert_eq!(set.len(), 1);
        set.clear();
        assert!(set.is_empty());
        assert_eq!(set.spendable_sats(), 0);
        set.insert(coin(6, 3_000)).expect("insert after rebuild");
        assert_eq!(set.spendable_sats(), 3_000);
    }
}
