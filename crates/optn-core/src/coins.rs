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
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum FreezeReason {
    User,
    FlipstarterPledge,
    Authhead,
    /// Committed to a CashFusion round that has not finished.
    ///
    /// An ordinary send that spent one of these would double-spend the round's
    /// own inputs: the fusion dies, and the attempt is visible on chain as a
    /// conflict. The desktop implementation states the rule as preventing
    /// "ordinary sends from reusing in-flight Fusion inputs", and freezing is
    /// this crate's reservation primitive, so it is expressed as a reason of
    /// its own rather than borrowed from `User` -- a hold the round must
    /// release cannot be the same thing as a freeze only the user may lift.
    FusionInFlight,
}

impl FreezeReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::FlipstarterPledge => "flipstarter-pledge",
            Self::Authhead => "authhead",
            Self::FusionInFlight => "fusion-in-flight",
        }
    }

    /// Whether the user may lift this hold from the coin list.
    ///
    /// Only their own. A pledge, an authhead and a fusion round are each held
    /// by something with a lifecycle, and unfreezing behind its back is how the
    /// coin gets spent out from under it.
    pub const fn is_user_reversible(self) -> bool {
        matches!(self, Self::User)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Coin {
    token: Option<crate::token::TokenData>,
    outpoint: Outpoint,
    value_sats: u64,
    address: String,
    label: Option<String>,
    freeze: Option<FreezeReason>,
    /// How many CashFusion rounds this coin has been through.
    ///
    /// A local wallet record, never on-chain, and never presented as
    /// verifiable. It exists because auto-fusion needs a stopping condition:
    /// without one it re-fuses the same coins forever, paying a real fee every
    /// round, which is the difference between a privacy feature and a slow
    /// drain. Electron Cash bounds this per coin rather than per wallet, so a
    /// well-fused coin is left alone while newly received coins still fuse.
    fuse_depth: u32,
}

impl Coin {
    pub fn new(
        outpoint: Outpoint,
        value_sats: u64,
        address: impl Into<String>,
    ) -> Result<Self, CoinError> {
        if value_sats == 0 {
            return Err(CoinError::ZeroValue);
        }
        Self::from_observation(outpoint, value_sats, address, None)
    }

    /// Preserve observed outputs, including zero-satoshi token custody. This
    /// constructs a record, not evidence of inclusion or permission to spend.
    pub fn from_observation(
        outpoint: Outpoint,
        value_sats: u64,
        address: impl Into<String>,
        token: Option<crate::token::TokenData>,
    ) -> Result<Self, CoinError> {
        let address = address.into();
        if address.trim().is_empty() {
            return Err(CoinError::EmptyAddress);
        }
        Ok(Self {
            token,
            outpoint,
            value_sats,
            address,
            label: None,
            freeze: None,
            fuse_depth: 0,
        })
    }

    pub const fn outpoint(&self) -> Outpoint {
        self.outpoint
    }

    pub fn token(&self) -> Option<&crate::token::TokenData> {
        self.token.as_ref()
    }

    /// Token custody is independent of user freeze state. Ordinary BCH/Fusion
    /// selection must not consume it, even if a user freeze is lifted.
    pub fn with_token(mut self, token: crate::token::TokenData) -> Self {
        self.token = Some(token);
        self
    }

    pub const fn value_sats(&self) -> u64 {
        self.value_sats
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    /// Rounds of CashFusion this coin has been through. Local record only.
    pub const fn fuse_depth(&self) -> u32 {
        self.fuse_depth
    }

    /// The badge text, or `None` when the coin has never been fused.
    ///
    /// `Fused` for one round, `Fused ×N` beyond that, matching the wallet's
    /// existing chip.
    pub fn fusion_label(&self) -> Option<String> {
        match self.fuse_depth {
            0 => None,
            1 => Some("Fused".to_string()),
            depth => Some(format!("Fused ×{depth}")),
        }
    }

    /// Record another completed round.
    pub fn record_fusion_round(&mut self) {
        self.fuse_depth = self.fuse_depth.saturating_add(1);
    }

    pub fn with_fuse_depth(mut self, depth: u32) -> Self {
        self.fuse_depth = depth;
        self
    }

    /// Whether auto-fusion should still pick this coin.
    ///
    /// A frozen coin is never fused -- freezing is the reservation primitive
    /// Flipstarter pledges share, and fusing a pledged coin would spend it.
    /// A coin at or past `max_depth` is done: continuing would pay fees
    /// forever for privacy it already has.
    pub const fn is_fusable(&self, max_depth: u32) -> bool {
        self.is_spendable() && self.fuse_depth < max_depth
    }

    pub fn label(&self) -> Option<&str> {
        self.label.as_deref()
    }

    pub const fn freeze(&self) -> Option<FreezeReason> {
        self.freeze
    }

    pub const fn is_spendable(&self) -> bool {
        self.value_sats > 0 && self.freeze.is_none() && self.token.is_none()
    }

    pub const fn is_reserved(&self) -> bool {
        !self.is_spendable()
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
        self.coins
            .iter()
            .try_fold(coin.value_sats, |total, existing| {
                total.checked_add(existing.value_sats)
            })
            .ok_or(CoinError::AmountOverflow)?;
        self.coins.push(coin);
        Ok(())
    }

    pub fn get(&self, outpoint: Outpoint) -> Option<&Coin> {
        self.coins.iter().find(|coin| coin.outpoint == outpoint)
    }

    /// Apply authenticated local bookkeeping to an already projected output.
    /// This cannot create a coin or change its amount, script, or token data.
    pub fn restore_annotations(
        &mut self,
        outpoint: Outpoint,
        label: Option<String>,
        freeze: Option<FreezeReason>,
        fuse_depth: u32,
    ) -> Result<(), CoinError> {
        let coin = self
            .coins
            .iter_mut()
            .find(|coin| coin.outpoint == outpoint)
            .ok_or(CoinError::UnknownOutpoint)?;
        coin.set_label(label);
        coin.restore_freeze(freeze);
        coin.fuse_depth = fuse_depth;
        Ok(())
    }

    /// Replace a complete wallet-scoped chain projection atomically. Chain
    /// fields come from the projection; local annotations never come from peers.
    /// The caller must establish completeness and wallet/network ownership first.
    pub fn replace_chain_outputs(&mut self, mut outputs: Vec<Coin>) -> Result<(), CoinError> {
        use std::collections::{HashMap, HashSet};
        let previous: HashMap<_, _> = self
            .coins
            .iter()
            .map(|coin| (coin.outpoint, coin))
            .collect();
        let mut seen = HashSet::new();
        let mut total = 0u64;
        for coin in &mut outputs {
            if !seen.insert(coin.outpoint) {
                return Err(CoinError::DuplicateOutpoint);
            }
            total = total
                .checked_add(coin.value_sats)
                .ok_or(CoinError::AmountOverflow)?;
            let prior = previous.get(&coin.outpoint);
            coin.label = prior.and_then(|coin| coin.label.clone());
            coin.freeze = prior.and_then(|coin| coin.freeze);
            coin.fuse_depth = prior.map_or(0, |coin| coin.fuse_depth);
        }
        self.coins = outputs;
        Ok(())
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
    AmountOverflow,
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
            Self::AmountOverflow => write!(
                f,
                "wallet output values overflow the supported amount range"
            ),
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
mod fusion_tests {
    use super::*;

    fn coin(slot: u8, sats: u64) -> Coin {
        Coin::new(
            Outpoint::parse(&format!("{:064x}", slot), 0).expect("outpoint"),
            sats,
            "bchtest:qqexample",
        )
        .expect("coin")
    }

    #[test]
    fn the_badge_reads_the_way_the_wallet_already_shows_it() {
        let mut c = coin(1, 5_000);
        assert_eq!(c.fusion_label(), None, "never fused shows no chip");

        c.record_fusion_round();
        assert_eq!(c.fusion_label().as_deref(), Some("Fused"));

        c.record_fusion_round();
        assert_eq!(c.fusion_label().as_deref(), Some("Fused ×2"));

        assert_eq!(
            coin(2, 5_000).with_fuse_depth(7).fusion_label().as_deref(),
            Some("Fused ×7")
        );
    }

    #[test]
    fn auto_fusion_stops_at_the_configured_depth() {
        // The reason depth is tracked at all: without a stopping condition
        // auto-fusion re-fuses the same coins forever, paying a real fee each
        // round. That is a slow drain, not a privacy feature.
        let max = 3;
        assert!(coin(1, 5_000).with_fuse_depth(0).is_fusable(max));
        assert!(coin(1, 5_000).with_fuse_depth(2).is_fusable(max));
        assert!(
            !coin(1, 5_000).with_fuse_depth(3).is_fusable(max),
            "a coin at the limit is done"
        );
        assert!(!coin(1, 5_000).with_fuse_depth(9).is_fusable(max));

        // Bounded per coin, not per wallet: a fresh coin still fuses even when
        // an older one is finished.
        let fresh = coin(2, 5_000);
        assert!(fresh.is_fusable(max));
    }

    #[test]
    fn a_frozen_coin_is_never_fused() {
        // Fusing spends its inputs, so fusing a Flipstarter pledge would spend
        // the coin the pledge is holding.
        let mut coins = CoinSet::new();
        let pledged = coin(1, 9_000);
        let outpoint = pledged.outpoint();
        coins.insert(pledged).expect("insert");
        coins
            .freeze(outpoint, FreezeReason::FlipstarterPledge)
            .expect("freeze");
        assert!(!coins.get(outpoint).expect("coin").is_fusable(3));

        coins.unfreeze(outpoint).expect("unfreeze");
        assert!(coins.get(outpoint).expect("coin").is_fusable(3));
    }

    #[test]
    fn depth_saturates_rather_than_wrapping_to_never_fused() {
        // Wrapping would turn a heavily fused coin back into a fresh one and
        // restart the fee drain.
        let mut c = coin(1, 5_000).with_fuse_depth(u32::MAX);
        c.record_fusion_round();
        assert_eq!(c.fuse_depth(), u32::MAX);
        assert!(c.fusion_label().is_some());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overflowing_observations_preserve_the_previous_coin_set() {
        let mut set = CoinSet::new();
        set.insert(coin(1, u64::MAX)).unwrap();
        let before = set.clone();
        assert_eq!(set.insert(coin(2, 1)), Err(CoinError::AmountOverflow));
        assert_eq!(set, before);
        assert_eq!(set.spendable_sats(), u64::MAX);
        assert_eq!(
            set.replace_chain_outputs(vec![coin(2, u64::MAX), coin(3, 1)]),
            Err(CoinError::AmountOverflow)
        );
        assert_eq!(set, before);
        set.replace_chain_outputs(vec![coin(2, u64::MAX - 1), coin(3, 1)])
            .unwrap();
        assert_eq!(set.spendable_sats(), u64::MAX);
    }

    #[test]
    fn chain_replacement_preserves_local_records_and_is_atomic() {
        let token = crate::token::TokenData::fungible([9; 32], 42);
        let mut set = CoinSet::new();
        let existing = coin(1, 8000).with_label("local label").with_fuse_depth(3);
        let outpoint = existing.outpoint();
        set.insert(existing).unwrap();
        set.insert(coin(2, 1000)).unwrap();
        set.freeze(outpoint, FreezeReason::FusionInFlight).unwrap();
        let mut added = coin(3, 2000).with_label("peer label").with_fuse_depth(99);
        added.restore_freeze(Some(FreezeReason::User));
        set.replace_chain_outputs(vec![coin(1, 7000).with_token(token.clone()), added])
            .unwrap();
        let restored = set.get(outpoint).unwrap();
        assert_eq!(
            restored.value_sats(),
            7000,
            "chain fields are authoritative"
        );
        assert_eq!(restored.token(), Some(&token));
        assert_eq!(restored.label(), Some("local label"));
        assert_eq!(restored.freeze(), Some(FreezeReason::FusionInFlight));
        assert_eq!(restored.fuse_depth(), 3);
        assert!(set.get(coin(2, 1000).outpoint()).is_none());
        let added = set.get(coin(3, 2000).outpoint()).unwrap();
        assert_eq!(added.label(), None);
        assert_eq!(added.freeze(), None);
        assert_eq!(added.fuse_depth(), 0);
        let retained = set.clone();
        assert_eq!(
            set.replace_chain_outputs(vec![coin(3, 2000), coin(3, 2000)]),
            Err(CoinError::DuplicateOutpoint)
        );
        assert_eq!(set, retained);
    }

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

    #[test]
    fn a_coin_committed_to_a_fusion_round_is_out_of_reach_of_an_ordinary_send() {
        // An ordinary send that spent one of these would double-spend the
        // round's own inputs: the fusion dies and the attempt shows up on chain
        // as a conflict. Freezing is the reservation primitive, so the hold is
        // expressed with it.
        let mut set = CoinSet::new();
        set.insert(coin(1, 10_000)).expect("insert");
        set.insert(coin(2, 20_000)).expect("insert");
        let fusing = coin(1, 10_000).outpoint();
        set.freeze(fusing, FreezeReason::FusionInFlight)
            .expect("hold it for the round");

        assert_eq!(
            set.spendable_sats(),
            20_000,
            "the round's coin is not spendable"
        );
        assert_eq!(set.reserved_sats(), 10_000);

        let held = set.get(fusing).expect("still in the set");
        assert!(held.is_reserved());
        // Nor may it be pulled into a second round while the first is running.
        assert!(!held.is_fusable(5));
        assert_eq!(held.freeze(), Some(FreezeReason::FusionInFlight));
        assert_eq!(FreezeReason::FusionInFlight.as_str(), "fusion-in-flight");
    }

    #[test]
    fn only_a_user_freeze_is_the_users_to_lift() {
        // Each of the others is held by something with a lifecycle -- a
        // campaign, an authhead, a running fusion round -- and unfreezing
        // behind its back is how the coin gets spent out from under it.
        assert!(FreezeReason::User.is_user_reversible());
        for held in [
            FreezeReason::FlipstarterPledge,
            FreezeReason::Authhead,
            FreezeReason::FusionInFlight,
        ] {
            assert!(!held.is_user_reversible(), "{held:?}");
            // And each stays distinguishable, so releasing one never releases
            // another.
            assert_ne!(held.as_str(), FreezeReason::User.as_str());
        }
    }
}
