//! Which coins a CashFusion round offers, for every surface.
//!
//! Server rounds follow Electron Cash's `select_coins`, `select_random_coins`
//! and `FUSE_DEPTH_THRESHOLD` (`plugin.py`): the address is the linkage
//! bucket, buckets are offered whole and at random, and Auto stops once
//! nearly all eligible value is fused deep enough. P2P rounds offer the
//! wallet's plain coins below the rounds-per-coin depth, largest first.
//!
//! Adopted differences from Electron Cash, carried over from the engine this
//! replaces:
//! - an address with more than three usable coins keeps its three largest
//!   instead of being skipped (one reused receive address otherwise had eight
//!   coins and none eligible), and is reported as crowded so the wallet can
//!   consolidate it first;
//! - unconfirmed coins are eligible, so rounds chain on fresh fusion outputs
//!   (Electron Cash maintainers endorse fusing 0-conf coins on BCH; waiting
//!   for a block costs liquidity and privacy, and a replaced parent is rare);
//! - depth completion is by eligible value and stops at 99.9%.
//!
//! A coin carrying a CashToken is never offered: a fusion has no token data,
//! so the token would burn. A frozen coin is never offered either: freezing is
//! how a pledge, an authhead or another round holds a coin.
//!
//! Pure. The caller supplies the coins, each coin's recorded depth and a
//! uniform random source, so every result can be reproduced in a test.

use serde::{Deserialize, Serialize};

use super::FusionMode;

/// More usable coins than this on one address make it crowded.
pub const MAX_COINS_PER_ADDRESS: usize = 3;
/// Electron Cash `DEFAULT_MAX_COINS`.
pub const MAX_SELECTED_COINS: usize = 20;
/// Auto stops once this share of eligible value is fused deep enough.
pub const DEPTH_VALUE_THRESHOLD: f64 = 0.999;
/// Electron Cash's "normal" mode offers each address with this probability.
pub const SERVER_BUCKET_FRACTION: f64 = 0.5;

/// Who asked for the round. Depth bounds automatic spending only: a holder
/// who starts a round by hand may re-fuse a coin already at the limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FusionTrigger {
    Auto,
    Manual,
}

/// One of the wallet's coins, as selection sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FusionCoin {
    /// `txid:vout`, display-order txid. Results name coins by this string.
    pub outpoint: String,
    pub address: String,
    pub value_sats: u64,
    /// Mined, as far as the wallet knows.
    pub confirmed: bool,
    /// Carries a CashToken.
    pub token: bool,
    /// Held by the holder, a pledge, an authhead or another round.
    pub frozen: bool,
    /// CashFusion rounds this coin has been through (a local record).
    pub depth: u32,
}

/// Why an address offers nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    Unconfirmed,
    Token,
    Frozen,
    EmptyAddress,
}

impl SkipReason {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Unconfirmed => "unconfirmed",
            Self::Token => "token",
            Self::Frozen => "frozen",
            Self::EmptyAddress => "empty-address",
        }
    }
}

/// An address and the coins it contributes, offered or skipped as one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddressBucket {
    pub address: String,
    pub coins: Vec<FusionCoin>,
    pub value_sats: u64,
    pub skip: Option<SkipReason>,
}

impl AddressBucket {
    fn new(address: &str, coins: Vec<FusionCoin>, skip: Option<SkipReason>) -> Self {
        Self {
            address: address.to_owned(),
            value_sats: coins.iter().map(|coin| coin.value_sats).sum(),
            coins,
            skip,
        }
    }
}

/// The wallet's addresses, split into those a server round may offer and
/// those it may not.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Classification {
    pub eligible: Vec<AddressBucket>,
    pub ineligible: Vec<AddressBucket>,
    pub total_value_sats: u64,
    pub has_unconfirmed: bool,
    /// Skipped addresses per reason, in the order first seen.
    pub skip_counts: Vec<(SkipReason, usize)>,
}

fn skip_reason(coin: &FusionCoin, require_confirmed: bool) -> Option<SkipReason> {
    if coin.token {
        Some(SkipReason::Token)
    } else if coin.frozen {
        Some(SkipReason::Frozen)
    } else if require_confirmed && !coin.confirmed {
        Some(SkipReason::Unconfirmed)
    } else {
        None
    }
}

/// Coins grouped by address, addresses in the order first seen: every coin,
/// and the ones a round may use.
fn by_address(
    coins: &[FusionCoin],
    require_confirmed: bool,
) -> Vec<(String, Vec<FusionCoin>, Vec<FusionCoin>)> {
    let mut groups: Vec<(String, Vec<FusionCoin>, Vec<FusionCoin>)> = Vec::new();
    for coin in coins {
        let slot = match groups
            .iter()
            .position(|(address, _, _)| *address == coin.address)
        {
            Some(slot) => slot,
            None => {
                groups.push((coin.address.clone(), Vec::new(), Vec::new()));
                groups.len() - 1
            }
        };
        groups[slot].1.push(coin.clone());
        if !coin.address.is_empty() && skip_reason(coin, require_confirmed).is_none() {
            groups[slot].2.push(coin.clone());
        }
    }
    groups
}

/// The three largest coins, largest first; ties keep wallet order.
fn largest_usable(mut usable: Vec<FusionCoin>) -> Vec<FusionCoin> {
    usable.sort_by_key(|coin| std::cmp::Reverse(coin.value_sats));
    usable.truncate(MAX_COINS_PER_ADDRESS);
    usable
}

/// Split the wallet's addresses for a server round. `require_confirmed`
/// leaves unconfirmed coins behind, as classic Electron Cash does.
pub fn classify(coins: &[FusionCoin], require_confirmed: bool) -> Classification {
    let mut result = Classification {
        total_value_sats: coins.iter().map(|coin| coin.value_sats).sum(),
        has_unconfirmed: coins.iter().any(|coin| !coin.confirmed),
        ..Classification::default()
    };
    for (address, all, usable) in by_address(coins, require_confirmed) {
        if usable.is_empty() {
            let reason = if address.is_empty() {
                SkipReason::EmptyAddress
            } else {
                skip_reason(&all[0], require_confirmed).unwrap_or(SkipReason::EmptyAddress)
            };
            match result
                .skip_counts
                .iter_mut()
                .find(|(seen, _)| *seen == reason)
            {
                Some((_, count)) => *count += 1,
                None => result.skip_counts.push((reason, 1)),
            }
            result
                .ineligible
                .push(AddressBucket::new(&address, all, Some(reason)));
        } else {
            result
                .eligible
                .push(AddressBucket::new(&address, largest_usable(usable), None));
        }
    }
    result
}

/// Addresses holding more usable plain coins than one round takes, most
/// crowded first. The wallet can consolidate these before fusing.
pub fn crowded_buckets(coins: &[FusionCoin], require_confirmed: bool) -> Vec<AddressBucket> {
    let mut crowded: Vec<AddressBucket> = by_address(coins, require_confirmed)
        .into_iter()
        .filter(|(_, _, usable)| usable.len() > MAX_COINS_PER_ADDRESS)
        .map(|(address, _, usable)| AddressBucket::new(&address, usable, None))
        .collect();
    crowded.sort_by_key(|bucket| std::cmp::Reverse(bucket.coins.len()));
    crowded
}

/// Why a server round has no eligible address, for a holder to read.
pub fn empty_reason(classification: &Classification, auto: bool) -> String {
    let prefix = if auto { "Auto: " } else { "" };
    let why = if !classification.skip_counts.is_empty() {
        format!(
            " Skips: {}.",
            classification
                .skip_counts
                .iter()
                .map(|(reason, count)| format!("{}={count}", reason.label()))
                .collect::<Vec<_>>()
                .join(", ")
        )
    } else if !classification.ineligible.is_empty() {
        format!(
            " {} address bucket(s) skipped.",
            classification.ineligible.len()
        )
    } else {
        String::new()
    };
    let unconfirmed = classification.has_unconfirmed
        && classification
            .skip_counts
            .iter()
            .any(|(reason, count)| *reason == SkipReason::Unconfirmed && *count > 0);
    format!(
        "{prefix}no eligible server CashFusion address buckets.{why} \
         Need 1–3 plain BCH coins on an address (no tokens, not frozen{}). \
         A crowded address now uses its 3 largest plain coins. \
         Auto still stops at the rounds-per-coin box.",
        if unconfirmed {
            ", confirmed height"
        } else {
            ""
        }
    )
}

/// A uniform sample in `[0, 1)`, or an error for anything else.
fn uniform(sample: &mut dyn FnMut() -> f64) -> Result<f64, String> {
    let value = sample();
    if !value.is_finite() || !(0.0..1.0).contains(&value) {
        return Err("fusion coin selection drew an invalid random sample".into());
    }
    Ok(value)
}

/// Offer whole addresses at random, each with probability `fraction`, never
/// past `max_coins`. When the draw offers nothing, the first address that
/// fits is offered, as Electron Cash does. `shuffle` is off only for tests
/// that need a fixed order.
pub fn select_buckets(
    eligible: &[AddressBucket],
    fraction: f64,
    max_coins: usize,
    shuffle: bool,
    sample: &mut dyn FnMut() -> f64,
) -> Result<Vec<AddressBucket>, String> {
    if !fraction.is_finite() {
        return Err("fusion coin selection fraction must be finite".into());
    }
    let fraction = fraction.clamp(0.0, 1.0);
    let mut candidates = eligible.to_vec();
    if shuffle {
        for i in (1..candidates.len()).rev() {
            let j = (uniform(sample)? * (i + 1) as f64).floor() as usize;
            candidates.swap(i, j);
        }
    }
    let mut selected = Vec::new();
    let mut taken = 0usize;
    for bucket in &candidates {
        if taken >= max_coins {
            break;
        }
        if taken + bucket.coins.len() > max_coins {
            continue;
        }
        if uniform(sample)? > fraction {
            continue;
        }
        taken += bucket.coins.len();
        selected.push(bucket.clone());
    }
    if selected.is_empty() {
        if let Some(fallback) = candidates
            .iter()
            .find(|bucket| !bucket.coins.is_empty() && bucket.coins.len() <= max_coins)
        {
            selected.push(fallback.clone());
        }
    }
    Ok(selected)
}

/// How much of the eligible value is fused deep enough.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DepthStatus {
    pub satisfied: bool,
    pub ratio: f64,
    pub eligible_value_sats: u64,
    pub satisfied_value_sats: u64,
}

/// Electron Cash's stopping rule: an address counts as fused when any of its
/// coins has reached `fuse_depth`, and Auto stops at 99.9% of eligible value.
pub fn depth_status(eligible: &[AddressBucket], fuse_depth: u32) -> DepthStatus {
    let eligible_value_sats: u64 = eligible.iter().map(|bucket| bucket.value_sats).sum();
    let satisfied_value_sats: u64 = eligible
        .iter()
        .filter(|bucket| fuse_depth > 0 && bucket.coins.iter().any(|coin| coin.depth >= fuse_depth))
        .map(|bucket| bucket.value_sats)
        .sum();
    let ratio = if eligible_value_sats > 0 {
        satisfied_value_sats as f64 / eligible_value_sats as f64
    } else {
        0.0
    };
    DepthStatus {
        satisfied: fuse_depth > 0 && eligible_value_sats > 0 && ratio >= DEPTH_VALUE_THRESHOLD,
        ratio,
        eligible_value_sats,
        satisfied_value_sats,
    }
}

/// What a round should do with the wallet's coins.
#[derive(Debug, Clone, PartialEq)]
pub struct CoinSelection {
    /// The coins offered to the round, in the order it gets them.
    pub selected: Vec<FusionCoin>,
    /// The coins depth reporting covers.
    pub depth_coins: Vec<FusionCoin>,
    /// Server Auto only: nearly all eligible value is fused deep enough.
    pub depth_satisfied: bool,
    /// Addresses to consolidate before fusing.
    pub crowded: Vec<AddressBucket>,
    /// Server rounds: why no address is eligible, worded for the trigger.
    pub empty_reason: Option<String>,
    /// Server rounds: how the addresses were split.
    pub classification: Option<Classification>,
}

/// Choose the coins for one round.
pub fn select_fusion_coins(
    mode: FusionMode,
    trigger: FusionTrigger,
    coins: &[FusionCoin],
    fuse_depth: u32,
    sample: &mut dyn FnMut() -> f64,
) -> Result<CoinSelection, String> {
    let auto = trigger == FusionTrigger::Auto;
    match mode {
        FusionMode::Server => {
            let classification = classify(coins, false);
            let crowded = crowded_buckets(coins, false);
            let depth_coins: Vec<FusionCoin> = classification
                .eligible
                .iter()
                .flat_map(|bucket| bucket.coins.iter().cloned())
                .collect();
            let empty_reason = classification
                .eligible
                .is_empty()
                .then(|| empty_reason(&classification, auto));
            let depth = depth_status(&classification.eligible, fuse_depth);
            let selected = if auto && depth.satisfied && crowded.is_empty() {
                Vec::new()
            } else {
                select_buckets(
                    &classification.eligible,
                    SERVER_BUCKET_FRACTION,
                    MAX_SELECTED_COINS,
                    true,
                    sample,
                )?
                .into_iter()
                .flat_map(|bucket| bucket.coins)
                .collect()
            };
            Ok(CoinSelection {
                selected,
                depth_coins,
                depth_satisfied: auto && depth.satisfied && crowded.is_empty(),
                crowded,
                empty_reason,
                classification: Some(classification),
            })
        }
        FusionMode::P2p => {
            let plain: Vec<FusionCoin> = coins
                .iter()
                .filter(|coin| !coin.token && !coin.frozen)
                .cloned()
                .collect();
            let mut eligible: Vec<FusionCoin> = plain
                .iter()
                .filter(|coin| !auto || coin.depth < fuse_depth)
                .cloned()
                .collect();
            if eligible.len() > MAX_SELECTED_COINS {
                eligible.sort_by_key(|coin| std::cmp::Reverse(coin.value_sats));
                eligible.truncate(MAX_SELECTED_COINS);
            }
            Ok(CoinSelection {
                selected: eligible,
                crowded: crowded_buckets(&plain, false),
                depth_coins: plain,
                depth_satisfied: false,
                empty_reason: None,
                classification: None,
            })
        }
    }
}

/// A selection request as a renderer sends it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoinSelectionRequest {
    pub mode: FusionMode,
    pub trigger: FusionTrigger,
    pub fuse_depth: u32,
    pub coins: Vec<FusionCoin>,
}

/// An address on the wire, its coins named by outpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketView {
    pub address: String,
    pub outpoints: Vec<String>,
    pub value_sats: u64,
}

/// A selection on the wire, coins named by outpoint.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoinSelectionView {
    pub selected: Vec<String>,
    pub depth_coins: Vec<String>,
    pub depth_satisfied: bool,
    pub crowded: Vec<BucketView>,
    pub empty_reason: Option<String>,
    pub eligible_buckets: usize,
    pub eligible_coins: usize,
    /// Skipped addresses per reason label, in the order first seen.
    pub skip_counts: Vec<(String, usize)>,
}

impl From<&CoinSelection> for CoinSelectionView {
    fn from(selection: &CoinSelection) -> Self {
        let outpoints = |coins: &[FusionCoin]| -> Vec<String> {
            coins.iter().map(|coin| coin.outpoint.clone()).collect()
        };
        let classification = selection.classification.as_ref();
        Self {
            selected: outpoints(&selection.selected),
            depth_coins: outpoints(&selection.depth_coins),
            depth_satisfied: selection.depth_satisfied,
            crowded: selection
                .crowded
                .iter()
                .map(|bucket| BucketView {
                    address: bucket.address.clone(),
                    outpoints: outpoints(&bucket.coins),
                    value_sats: bucket.value_sats,
                })
                .collect(),
            empty_reason: selection.empty_reason.clone(),
            eligible_buckets: classification.map_or(0, |c| c.eligible.len()),
            eligible_coins: classification
                .map_or(0, |c| c.eligible.iter().map(|b| b.coins.len()).sum()),
            skip_counts: classification.map_or_else(Vec::new, |c| {
                c.skip_counts
                    .iter()
                    .map(|(reason, count)| (reason.label().to_owned(), *count))
                    .collect()
            }),
        }
    }
}

/// Run a renderer's request: JSON in, JSON out.
pub fn select_fusion_coins_json(
    request: &str,
    sample: &mut dyn FnMut() -> f64,
) -> Result<String, String> {
    let request: CoinSelectionRequest =
        serde_json::from_str(request).map_err(|error| format!("bad selection request: {error}"))?;
    let selection = select_fusion_coins(
        request.mode,
        request.trigger,
        &request.coins,
        request.fuse_depth,
        sample,
    )?;
    serde_json::to_string(&CoinSelectionView::from(&selection)).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coin(address: &str, n: u32) -> FusionCoin {
        FusionCoin {
            outpoint: format!("{n:064x}:0"),
            address: address.into(),
            value_sats: 1_000,
            confirmed: true,
            token: false,
            frozen: false,
            depth: 0,
        }
    }

    fn with(mut coin: FusionCoin, change: impl FnOnce(&mut FusionCoin)) -> FusionCoin {
        change(&mut coin);
        coin
    }

    fn addresses(buckets: &[AddressBucket]) -> Vec<&str> {
        buckets
            .iter()
            .map(|bucket| bucket.address.as_str())
            .collect()
    }

    #[test]
    fn token_and_frozen_coins_stay_behind_and_their_addresses_skip_when_empty() {
        let coins = vec![
            coin("eligible", 1),
            coin("eligible", 2),
            coin("token-address", 3),
            with(coin("token-address", 4), |c| c.token = true),
            with(coin("frozen-address", 5), |c| c.frozen = true),
            with(coin("unconfirmed-address", 6), |c| c.confirmed = false),
        ];
        let result = classify(&coins, true);
        assert_eq!(addresses(&result.eligible), ["eligible", "token-address"]);
        assert_eq!(result.eligible[0].coins.len(), 2);
        assert_eq!(result.eligible[1].coins.len(), 1);
        assert_eq!(
            addresses(&result.ineligible),
            ["frozen-address", "unconfirmed-address"]
        );
        assert!(result.has_unconfirmed);
        assert_eq!(result.total_value_sats, 6_000);
        assert_eq!(
            result.skip_counts,
            [(SkipReason::Frozen, 1), (SkipReason::Unconfirmed, 1)]
        );
    }

    #[test]
    fn a_crowded_address_keeps_its_three_largest_and_is_reported() {
        let coins: Vec<FusionCoin> = [100, 400, 200, 800, 50]
            .into_iter()
            .enumerate()
            .map(|(n, value)| with(coin("crowded", n as u32), |c| c.value_sats = value))
            .collect();
        let result = classify(&coins, false);
        assert_eq!(result.eligible.len(), 1);
        assert_eq!(
            result.eligible[0]
                .coins
                .iter()
                .map(|c| c.value_sats)
                .collect::<Vec<_>>(),
            [800, 400, 200]
        );
        assert!(result.ineligible.is_empty());

        let mut more = coins.clone();
        more.push(coin("ok", 9));
        let crowded = crowded_buckets(&more, false);
        assert_eq!(addresses(&crowded), ["crowded"]);
        assert_eq!(crowded[0].coins.len(), 5);
    }

    #[test]
    fn whole_addresses_are_offered_within_the_twenty_coin_cap() {
        let coins: Vec<FusionCoin> = (0..8)
            .flat_map(|a| (0..3).map(move |c| coin(&format!("address-{a}"), a * 10 + c)))
            .collect();
        let eligible = classify(&coins, false).eligible;
        let selected =
            select_buckets(&eligible, 1.0, MAX_SELECTED_COINS, true, &mut || 0.0).unwrap();
        assert_eq!(selected.iter().map(|b| b.coins.len()).sum::<usize>(), 18);
        assert!(selected.iter().all(|b| b.coins.len() == 3));
    }

    #[test]
    fn an_empty_draw_falls_back_to_the_first_address() {
        let eligible = classify(&[coin("first", 1), coin("second", 2)], false).eligible;
        let selected =
            select_buckets(&eligible, 0.0, MAX_SELECTED_COINS, false, &mut || 0.9).unwrap();
        assert_eq!(addresses(&selected), ["first"]);
        assert!(select_buckets(&eligible, 0.5, 20, true, &mut || 1.0).is_err());
        assert!(select_buckets(&eligible, f64::NAN, 20, true, &mut || 0.5).is_err());
    }

    #[test]
    fn auto_stops_at_the_value_threshold() {
        let at = |large: u64, dust: u64| {
            classify(
                &[
                    with(coin("large", 1), |c| {
                        c.value_sats = large;
                        c.depth = 3;
                    }),
                    with(coin("dust", 2), |c| c.value_sats = dust),
                ],
                false,
            )
            .eligible
        };
        let met = depth_status(&at(999_000, 1_000), 3);
        assert!(met.satisfied);
        assert!((met.ratio - 0.999).abs() < 1e-12);
        assert!(!depth_status(&at(998_999, 1_001), 3).satisfied);
        assert!(!depth_status(&at(999_000, 1_000), 0).satisfied);
    }

    #[test]
    fn an_address_is_fused_when_any_of_its_coins_is() {
        let eligible = classify(
            &[
                with(coin("shared", 1), |c| {
                    c.value_sats = 600;
                    c.depth = 3;
                }),
                with(coin("shared", 2), |c| c.value_sats = 400),
            ],
            false,
        )
        .eligible;
        let status = depth_status(&eligible, 3);
        assert!(status.satisfied);
        assert_eq!(status.eligible_value_sats, 1_000);
        assert_eq!(status.satisfied_value_sats, 1_000);
    }

    #[test]
    fn unconfirmed_coins_are_eligible_unless_confirmation_is_required() {
        let fresh = [with(coin("fresh-fusion", 1), |c| c.confirmed = false)];
        assert_eq!(
            addresses(&classify(&fresh, false).eligible),
            ["fresh-fusion"]
        );
        let required = classify(&fresh, true);
        let auto = empty_reason(&required, true);
        let manual = empty_reason(&required, false);
        assert!(auto.starts_with("Auto:"));
        assert!(!manual.starts_with("Auto:"));
        assert!(manual.contains("unconfirmed=1"));
        assert!(manual.contains("confirmed height"));
    }

    #[test]
    fn server_auto_offers_nothing_once_depth_is_met() {
        let coins = [with(coin("a", 1), |c| c.depth = 3)];
        let auto = select_fusion_coins(
            FusionMode::Server,
            FusionTrigger::Auto,
            &coins,
            3,
            &mut || 0.0,
        )
        .unwrap();
        assert!(auto.selected.is_empty());
        assert!(auto.depth_satisfied);
        assert_eq!(auto.depth_coins, coins);
        let manual = select_fusion_coins(
            FusionMode::Server,
            FusionTrigger::Manual,
            &coins,
            3,
            &mut || 0.0,
        )
        .unwrap();
        assert_eq!(manual.selected, coins);
        assert!(!manual.depth_satisfied);
    }

    #[test]
    fn server_explains_an_address_list_with_nothing_to_offer() {
        let coins = [
            with(coin("a", 1), |c| c.token = true),
            with(coin("a", 2), |c| c.token = true),
        ];
        let selection = select_fusion_coins(
            FusionMode::Server,
            FusionTrigger::Manual,
            &coins,
            3,
            &mut || 0.0,
        )
        .unwrap();
        assert!(selection.selected.is_empty());
        assert!(selection
            .empty_reason
            .as_deref()
            .unwrap()
            .contains("token=1"));
    }

    #[test]
    fn server_takes_up_to_three_coins_from_a_crowded_address_and_reports_it() {
        let coins: Vec<FusionCoin> = (1..=4).map(|n| coin("crowded", n)).collect();
        let selection = select_fusion_coins(
            FusionMode::Server,
            FusionTrigger::Manual,
            &coins,
            3,
            &mut || 0.0,
        )
        .unwrap();
        assert_eq!(selection.selected.len(), 3);
        assert_eq!(addresses(&selection.crowded), ["crowded"]);
    }

    #[test]
    fn p2p_leaves_tokens_frozen_and_deep_coins_and_keeps_the_twenty_largest() {
        let coins = [
            coin("a", 1),
            with(coin("b", 2), |c| c.token = true),
            with(coin("c", 3), |c| c.frozen = true),
            with(coin("d", 4), |c| c.depth = 3),
        ];
        let auto =
            select_fusion_coins(FusionMode::P2p, FusionTrigger::Auto, &coins, 3, &mut || 0.0)
                .unwrap();
        assert_eq!(auto.selected, [coins[0].clone()]);
        assert_eq!(auto.depth_coins, [coins[0].clone(), coins[3].clone()]);
        let manual = select_fusion_coins(
            FusionMode::P2p,
            FusionTrigger::Manual,
            &coins,
            3,
            &mut || 0.0,
        )
        .unwrap();
        assert_eq!(manual.selected, [coins[0].clone(), coins[3].clone()]);

        let many: Vec<FusionCoin> = (0..25)
            .map(|n| {
                with(coin(&format!("a{n}"), n), |c| {
                    c.value_sats = 1_000 + u64::from(n)
                })
            })
            .collect();
        let limited = select_fusion_coins(
            FusionMode::P2p,
            FusionTrigger::Manual,
            &many,
            3,
            &mut || 0.0,
        )
        .unwrap();
        assert_eq!(limited.selected.len(), MAX_SELECTED_COINS);
        assert_eq!(limited.selected[0].value_sats, 1_024);
        assert_eq!(limited.selected[19].value_sats, 1_005);
    }

    #[test]
    fn the_wire_names_coins_by_outpoint() {
        let request = serde_json::json!({
            "mode": "server",
            "trigger": "manual",
            "fuseDepth": 3,
            "coins": [
                {"outpoint": "aa:0", "address": "x", "valueSats": 5000, "confirmed": true,
                 "token": false, "frozen": false, "depth": 0},
                {"outpoint": "bb:1", "address": "y", "valueSats": 7000, "confirmed": false,
                 "token": true, "frozen": false, "depth": 0}
            ]
        });
        let view: serde_json::Value = serde_json::from_str(
            &select_fusion_coins_json(&request.to_string(), &mut || 0.0).unwrap(),
        )
        .unwrap();
        assert_eq!(view["selected"], serde_json::json!(["aa:0"]));
        assert_eq!(view["eligibleBuckets"], 1);
        assert_eq!(view["skipCounts"], serde_json::json!([["token", 1]]));
        assert!(select_fusion_coins_json(r#"{"mode":"server"}"#, &mut || 0.0).is_err());
    }
}
