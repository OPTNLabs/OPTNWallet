//! How many CashFusion rounds each coin has been through: Electron Cash's
//! `fuse_depth`, and Auto's stopping condition.
//!
//! Without a stopping condition Auto would re-fuse the same coins forever,
//! paying a fee every round. Electron Cash bounds this per coin, not per
//! wallet: a coin that has been through `fuse_depth` rounds is left alone,
//! while newly received coins still fuse.
//!
//! A local record, never on chain and never presented as verifiable. Three
//! facts are kept, in the stored forms every desktop build has written:
//! - each live coin's depth, by outpoint;
//! - each fusion transaction's depth, by txid, because an outpoint key can
//!   miss (index or case drift, Electrum lag) and a miss used to reset every
//!   round to depth 1;
//! - the set of fusion txids, which outlives the coins for history labels.
//!
//! Eviction is evidence only. A round removes the coins it spent, and
//! [`FusionDepthBook::prune_spent`] removes coins a fresh wallet snapshot no
//! longer holds. Nothing expires by age or count: a forgotten coin reads as
//! depth 0, and Auto would pay again to redo mixing it already has.
//!
//! Pure: the caller stores the book and supplies the time.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

/// One coin's depth and when it was recorded (epoch ms).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoinDepth {
    pub depth: u32,
    pub at_ms: u64,
}

/// A wallet's fusion depth record.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FusionDepthBook {
    coins: BTreeMap<String, CoinDepth>,
    tx_depth: BTreeMap<String, u32>,
    fusion_txids: BTreeSet<String>,
}

/// `txid:vout` with the txid lower-cased, so display or Electrum case cannot
/// hide a coin's depth.
pub fn normalize_outpoint(outpoint: &str) -> String {
    let raw = outpoint.trim();
    match raw.rfind(':') {
        Some(colon) if colon > 0 => {
            format!("{}:{}", raw[..colon].to_lowercase(), &raw[colon + 1..])
        }
        _ => raw.to_lowercase(),
    }
}

fn txid_of(outpoint: &str) -> &str {
    match outpoint.rfind(':') {
        Some(colon) if colon > 0 => &outpoint[..colon],
        _ => outpoint,
    }
}

/// A 64-character txid, lower-cased, or `None`.
fn normalize_txid(txid: &str) -> Option<String> {
    let txid = txid.trim().to_lowercase();
    (txid.len() == 64).then_some(txid)
}

/// A finite, non-negative JSON number, truncated.
fn whole(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number.is_finite() && number >= 0.0).then(|| number.trunc() as u64)
}

fn depth_number(value: &Value) -> Option<u32> {
    whole(value).map(|depth| depth.min(u64::from(u32::MAX)) as u32)
}

/// A JSON object, or nothing for anything unreadable: a damaged record reads
/// as empty rather than failing the wallet.
fn object(raw: Option<&str>) -> Map<String, Value> {
    match raw.and_then(|raw| serde_json::from_str::<Value>(raw).ok()) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Coin entries from their stored form, `{outpoint: {d, at}}`; on a key that
/// normalizes twice, the deeper entry wins.
fn coin_entries(map: &Map<String, Value>) -> BTreeMap<String, CoinDepth> {
    let mut coins: BTreeMap<String, CoinDepth> = BTreeMap::new();
    for (key, value) in map {
        let (Some(depth), Some(at)) = (
            value.get("d").and_then(depth_number),
            value
                .get("at")
                .and_then(Value::as_f64)
                .filter(|at| at.is_finite()),
        ) else {
            continue;
        };
        let key = normalize_outpoint(key);
        if coins.get(&key).is_none_or(|known| depth >= known.depth) {
            coins.insert(
                key,
                CoinDepth {
                    depth,
                    at_ms: at.max(0.0) as u64,
                },
            );
        }
    }
    coins
}

fn tx_entries(map: &Map<String, Value>) -> BTreeMap<String, u32> {
    map.iter()
        .filter_map(|(txid, value)| Some((txid.to_lowercase(), depth_number(value)?)))
        .collect()
}

/// What the wallet's coins look like against a depth target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DepthEligibility {
    pub total: usize,
    /// Below the target: Auto may still fuse these.
    pub eligible: usize,
    pub at_or_above: usize,
    pub target: u32,
    pub min_depth: u32,
    pub max_depth: u32,
}

impl FusionDepthBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read the stored forms: coins `{outpoint: {d, at}}`, txid depths
    /// `{txid: n}` and the txid list. Each part that is missing or unreadable
    /// reads as empty.
    pub fn from_stored(coins: Option<&str>, tx_depth: Option<&str>, txids: Option<&str>) -> Self {
        let mut book = Self {
            coins: coin_entries(&object(coins)),
            tx_depth: tx_entries(&object(tx_depth)),
            fusion_txids: BTreeSet::new(),
        };
        if let Some(Value::Array(list)) = txids.and_then(|raw| serde_json::from_str(raw).ok()) {
            book.add_txids(list.iter().filter_map(Value::as_str));
        }
        book
    }

    pub fn stored_coins(&self) -> String {
        Value::Object(
            self.coins
                .iter()
                .map(|(outpoint, coin)| {
                    (
                        outpoint.clone(),
                        json!({ "d": coin.depth, "at": coin.at_ms }),
                    )
                })
                .collect(),
        )
        .to_string()
    }

    pub fn stored_tx_depth(&self) -> String {
        json!(self.tx_depth).to_string()
    }

    pub fn stored_txids(&self) -> String {
        json!(self.fusion_txids).to_string()
    }

    /// Fold in another window's copy: the deeper entry wins, and an empty
    /// coin map never wipes a populated one.
    pub fn merge_stored(&mut self, coins: Option<&str>, tx_depth: Option<&str>) {
        let incoming = coin_entries(&object(coins));
        if !(incoming.is_empty() && !self.coins.is_empty()) {
            for (outpoint, coin) in incoming {
                if self
                    .coins
                    .get(&outpoint)
                    .is_none_or(|known| coin.depth >= known.depth)
                {
                    self.coins.insert(outpoint, coin);
                }
            }
        }
        for (txid, depth) in tx_entries(&object(tx_depth)) {
            let known = self.tx_depth.entry(txid).or_insert(0);
            *known = (*known).max(depth);
        }
    }

    /// Add fusion txids (from durable storage or a recovery file). Returns how
    /// many were new; anything that is not a txid is ignored.
    pub fn add_txids<'a>(&mut self, txids: impl IntoIterator<Item = &'a str>) -> usize {
        txids
            .into_iter()
            .filter_map(normalize_txid)
            .filter(|txid| self.fusion_txids.insert(txid.clone()))
            .count()
    }

    pub fn fusion_txids(&self) -> impl Iterator<Item = &str> {
        self.fusion_txids.iter().map(String::as_str)
    }

    /// Rounds this coin has been through: its own entry, else its parent
    /// transaction's depth, else 1 when the parent is a recorded fusion, else 0.
    pub fn depth_of(&self, outpoint: &str) -> u32 {
        let key = normalize_outpoint(outpoint);
        if let Some(coin) = self.coins.get(&key) {
            return coin.depth;
        }
        let txid = txid_of(&key);
        match self.tx_depth.get(txid) {
            Some(&depth) if depth >= 1 => depth,
            _ if self.fusion_txids.contains(txid) => 1,
            _ => 0,
        }
    }

    /// Record a completed round: the coins it spent are gone, and the coins it
    /// created are one round deeper than the SHALLOWEST coin it spent.
    ///
    /// The minimum mirrors Electron Cash's recursive `is_fuz_coin`, which calls
    /// a coin fused to depth N only when every wallet-owned ancestor reaches
    /// N-1. Depth is a privacy claim, not a fee budget: a round that mixes a
    /// thrice-fused coin with a fresh one produces outputs whose anonymity is
    /// bounded by the fresh coin's history, and calling them depth 4 would
    /// tell the holder they are better hidden than they are. The claim can
    /// understate privacy, never overstate it. A wallet that keeps receiving
    /// keeps fusing, which is intended: new money needs mixing.
    pub fn record_round(&mut self, spent: &[String], created: &[String], now_ms: u64) {
        let next = spent
            .iter()
            .map(|outpoint| self.depth_of(outpoint))
            .min()
            .map_or(1, |shallowest| shallowest.saturating_add(1));
        for outpoint in spent {
            self.coins.remove(&normalize_outpoint(outpoint));
        }
        for outpoint in created {
            let outpoint = normalize_outpoint(outpoint);
            let txid = txid_of(&outpoint).to_owned();
            self.coins.insert(
                outpoint,
                CoinDepth {
                    depth: next,
                    at_ms: now_ms,
                },
            );
            if txid.len() == 64 {
                let known = self.tx_depth.entry(txid.clone()).or_insert(0);
                *known = (*known).max(next);
                self.fusion_txids.insert(txid);
            }
        }
    }

    /// Remember a fusion transaction, and floor its outputs at depth 1 until
    /// they are recorded by outpoint. False when `txid` is not a txid.
    pub fn record_fusion_txid(&mut self, txid: &str) -> bool {
        let Some(txid) = normalize_txid(txid) else {
            return false;
        };
        let depth = self.tx_depth.entry(txid.clone()).or_insert(0);
        *depth = (*depth).max(1);
        self.fusion_txids.insert(txid);
        true
    }

    /// Drop coins a fresh wallet snapshot no longer holds. An empty snapshot
    /// means "unknown", not "everything is spent", and changes nothing.
    /// Returns whether anything was dropped.
    pub fn prune_spent(&mut self, live: &[String]) -> bool {
        if live.is_empty() {
            return false;
        }
        let live: BTreeSet<String> = live.iter().map(|o| normalize_outpoint(o)).collect();
        let before = self.coins.len();
        self.coins.retain(|outpoint, _| live.contains(outpoint));
        self.coins.len() != before
    }

    /// Whether `txid` is a fusion this wallet took part in.
    pub fn is_fusion_transaction(&self, txid: &str) -> bool {
        let Some(txid) = normalize_txid(txid) else {
            return false;
        };
        self.fusion_txids.contains(&txid)
            || self.coins.keys().any(|outpoint| txid_of(outpoint) == txid)
            || self.tx_depth.get(&txid).is_some_and(|depth| *depth >= 1)
    }

    /// Merge an exported record (`{coinDepth, fusionTxids}`, as cold export
    /// writes it): per coin, an imported depth replaces one no deeper; txids
    /// are united. Returns (coins taken, txids added).
    pub fn import(&mut self, state: &str, now_ms: u64) -> (usize, usize) {
        let state = object(Some(state));
        let mut coins = 0;
        if let Some(Value::Object(incoming)) = state.get("coinDepth") {
            for (outpoint, raw) in incoming {
                if !outpoint.contains(':') {
                    continue;
                }
                let (depth, at_ms) = match raw {
                    Value::Number(_) => (depth_number(raw).unwrap_or(0), now_ms),
                    Value::Object(entry) => (
                        entry.get("d").and_then(depth_number).unwrap_or(0),
                        entry
                            .get("at")
                            .and_then(Value::as_f64)
                            .filter(|at| at.is_finite())
                            .map_or(now_ms, |at| at.max(0.0) as u64),
                    ),
                    _ => continue,
                };
                let key = normalize_outpoint(outpoint);
                if self
                    .coins
                    .get(&key)
                    .is_none_or(|known| depth >= known.depth)
                {
                    self.coins.insert(key, CoinDepth { depth, at_ms });
                    coins += 1;
                }
            }
        }
        let txids = match state.get("fusionTxids") {
            Some(Value::Array(list)) => self.add_txids(list.iter().filter_map(Value::as_str)),
            _ => 0,
        };
        (coins, txids)
    }

    /// The wallet's coins against a depth `target`.
    pub fn eligibility(&self, outpoints: &[String], target: u32) -> DepthEligibility {
        let depths: Vec<u32> = outpoints.iter().map(|o| self.depth_of(o)).collect();
        let eligible = depths.iter().filter(|depth| **depth < target).count();
        DepthEligibility {
            total: depths.len(),
            eligible,
            at_or_above: depths.len() - eligible,
            target,
            min_depth: depths.iter().copied().min().unwrap_or(0),
            max_depth: depths.iter().copied().max().unwrap_or(0),
        }
    }
}

fn depth_range(min: u32, max: u32) -> String {
    if min == max {
        min.to_string()
    } else {
        format!("{min}–{max}")
    }
}

/// Auto's status when no coin is below the target. The target is always the
/// holder's setting, never a fixed number.
pub fn depth_met_message(eligibility: &DepthEligibility) -> String {
    if eligibility.total == 0 {
        return "Auto: no BCH coins to fuse (wallet empty of non-token UTXOs).".into();
    }
    format!(
        "Auto: all {} coin(s) already at rounds-per-coin depth (target = number in the box). \
         Current coin depth {}. Idle until send/receive/tx or you raise rounds-per-coin to fuse further.",
        eligibility.total,
        depth_range(eligibility.min_depth, eligibility.max_depth)
    )
}

/// One progress line while Auto still has coins below the target.
pub fn depth_gate_log(eligibility: &DepthEligibility) -> String {
    format!(
        "{} eligible below rounds-per-coin (target = box {}; current depth {})",
        eligibility.eligible,
        eligibility.target,
        depth_range(eligibility.min_depth, eligibility.max_depth)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn round(book: &mut FusionDepthBook, spent: &[&str], created: &[&str]) {
        book.record_round(&ops(spent), &ops(created), 1_000);
    }

    #[test]
    fn a_never_fused_coin_is_depth_zero() {
        assert_eq!(FusionDepthBook::new().depth_of("aaa:0"), 0);
    }

    #[test]
    fn the_txid_half_is_case_insensitive() {
        let tx = "Ab".repeat(32);
        let mut book = FusionDepthBook::new();
        round(&mut book, &["seed:0"], &[&format!("{tx}:1")]);
        assert_eq!(book.depth_of(&format!("{}:1", tx.to_lowercase())), 1);
        assert_eq!(book.depth_of(&format!("{}:1", tx.to_uppercase())), 1);
    }

    #[test]
    fn created_coins_are_one_round_deeper_than_the_shallowest_spent() {
        let mut book = FusionDepthBook::new();
        round(&mut book, &["aaa:0"], &["bbb:0"]);
        assert_eq!(book.depth_of("bbb:0"), 1);
        round(&mut book, &["bbb:0"], &["ccc:0"]);
        assert_eq!(book.depth_of("ccc:0"), 2);
        // A fresh input caps the whole output set.
        round(&mut book, &["ccc:0", "fresh:0"], &["out1:0", "out2:0"]);
        assert_eq!(book.depth_of("out1:0"), 1);
        assert_eq!(book.depth_of("out2:0"), 1);
        // Equal depths advance together.
        round(&mut book, &["s1:0"], &["a:0"]);
        round(&mut book, &["s2:0"], &["b:0"]);
        round(&mut book, &["a:0", "b:0"], &["both:0"]);
        assert_eq!(book.depth_of("both:0"), 2);
        // A round with no recorded inputs still counts once.
        round(&mut book, &[], &["lone:0"]);
        assert_eq!(book.depth_of("lone:0"), 1);
    }

    #[test]
    fn a_parent_txid_carries_depth_when_the_outpoint_misses() {
        let first = "aabbccdd".repeat(8);
        let second = "11223344".repeat(8);
        let mut book = FusionDepthBook::new();
        round(&mut book, &["seed:0"], &[&format!("{first}:0")]);
        round(
            &mut book,
            &[&format!("{first}:99")],
            &[&format!("{second}:0")],
        );
        assert_eq!(book.depth_of(&format!("{second}:0")), 2);
    }

    #[test]
    fn spent_inputs_are_dropped() {
        let mut book = FusionDepthBook::new();
        round(&mut book, &["spent:0"], &["made:0"]);
        assert_eq!(book.depth_of("spent:0"), 0);
        assert_eq!(book.depth_of("made:0"), 1);
    }

    #[test]
    fn fusion_txids_label_history_and_floor_their_outputs() {
        let txid = "ab".repeat(32);
        let mut book = FusionDepthBook::new();
        assert!(!book.is_fusion_transaction(&txid));
        assert!(book.record_fusion_txid(&txid.to_uppercase()));
        assert!(book.is_fusion_transaction(&txid));
        assert_eq!(book.depth_of(&format!("{txid}:0")), 1);
        assert!(!book.record_fusion_txid("short"));
        // A stamped txid then a round climbs.
        let next = "bb".repeat(32);
        round(&mut book, &[&format!("{txid}:0")], &[&format!("{next}:0")]);
        assert_eq!(book.depth_of(&format!("{next}:0")), 2);
        assert!(book.is_fusion_transaction(&next));
    }

    #[test]
    fn eviction_is_evidence_only() {
        let mut book = FusionDepthBook::new();
        for i in 0..200 {
            round(&mut book, &[&format!("in{i}:0")], &[&format!("out{i}:0")]);
        }
        assert_eq!(book.depth_of("out0:0"), 1);
        assert_eq!(book.depth_of("out199:0"), 1);
        assert!(!book.prune_spent(&[]));
        assert_eq!(book.depth_of("out0:0"), 1);
        assert!(book.prune_spent(&ops(&["OUT1:0"])));
        assert_eq!(book.depth_of("out1:0"), 1);
        assert_eq!(book.depth_of("out0:0"), 0);
    }

    #[test]
    fn the_stored_forms_round_trip_and_damage_reads_as_empty() {
        let mut book = FusionDepthBook::new();
        round(&mut book, &["a:0"], &[&format!("{}:3", "cd".repeat(32))]);
        book.record_fusion_txid(&"ef".repeat(32));
        let again = FusionDepthBook::from_stored(
            Some(&book.stored_coins()),
            Some(&book.stored_tx_depth()),
            Some(&book.stored_txids()),
        );
        assert_eq!(again, book);
        assert_eq!(
            FusionDepthBook::from_stored(Some("not json"), Some("[1]"), Some("{}")),
            FusionDepthBook::new()
        );
        // Keys that normalize together keep the deeper entry; junk is skipped.
        let merged = FusionDepthBook::from_stored(
            Some(r#"{"AB:0":{"d":2,"at":5},"ab:0":{"d":1,"at":6},"x:0":{"d":-1,"at":1},"y:0":7}"#),
            None,
            None,
        );
        assert_eq!(merged.depth_of("ab:0"), 2);
        assert_eq!(merged.depth_of("x:0"), 0);
        assert_eq!(merged.depth_of("y:0"), 0);
    }

    #[test]
    fn another_windows_copy_merges_by_depth_and_never_wipes() {
        let mut book = FusionDepthBook::new();
        round(&mut book, &["a:0"], &["kept:0"]);
        book.merge_stored(Some("{}"), None);
        assert_eq!(book.depth_of("kept:0"), 1);
        book.merge_stored(
            Some(r#"{"kept:0":{"d":3,"at":9},"new:0":{"d":2,"at":9}}"#),
            Some(r#"{"AA":4}"#),
        );
        assert_eq!(book.depth_of("kept:0"), 3);
        assert_eq!(book.depth_of("new:0"), 2);
        book.merge_stored(Some(r#"{"kept:0":{"d":1,"at":9}}"#), Some(r#"{"aa":2}"#));
        assert_eq!(book.depth_of("kept:0"), 3);
        assert_eq!(book.stored_tx_depth(), r#"{"aa":4}"#);
    }

    #[test]
    fn an_import_keeps_the_deeper_record_and_unites_txids() {
        let mut book = FusionDepthBook::new();
        round(&mut book, &["a:0"], &["b:0"]);
        round(&mut book, &["b:0"], &["deep:0"]);
        let (coins, txids) = book.import(
            &json!({
                "coinDepth": {"deep:0": 1, "plain:0": {"d": 4, "at": 7}, "nocolon": 3},
                "fusionTxids": ["AA".repeat(32), "short", "aa".repeat(32)]
            })
            .to_string(),
            50,
        );
        assert_eq!((coins, txids), (1, 1));
        assert_eq!(book.depth_of("deep:0"), 2);
        assert_eq!(book.depth_of("plain:0"), 4);
        assert_eq!(book.import("garbage", 1), (0, 0));
    }

    #[test]
    fn eligibility_and_messages_use_the_holders_target() {
        let mut book = FusionDepthBook::new();
        round(&mut book, &["i:0"], &["d1:0"]);
        round(&mut book, &["d1:0"], &["d2:0"]);
        round(&mut book, &["d2:0"], &["maxed:0"]);
        let all = book.eligibility(&ops(&["maxed:0", "new:0"]), 3);
        assert_eq!((all.total, all.eligible, all.at_or_above), (2, 1, 1));
        assert_eq!((all.min_depth, all.max_depth), (0, 3));
        assert_eq!(
            depth_gate_log(&all),
            "1 eligible below rounds-per-coin (target = box 3; current depth 0–3)"
        );
        let met = book.eligibility(&ops(&["maxed:0"]), 3);
        let message = depth_met_message(&met);
        assert!(message.contains("Current coin depth 3."));
        assert!(!message.contains("≥"));
        assert_eq!(
            depth_met_message(&book.eligibility(&[], 3)),
            "Auto: no BCH coins to fuse (wallet empty of non-token UTXOs)."
        );
    }
}
