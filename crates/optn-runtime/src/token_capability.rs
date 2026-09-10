//! Executing the token capability plans, and refusing to answer beyond what
//! was actually observed.
//!
//! The planner says a category's supply can be derived from its UTXOs. That is
//! true, and only true if the UTXOs are *all* of them. A page of results, a
//! filtered subset, or a set an indexer truncated will each happily add up to a
//! number, and that number is wrong in the one way nobody notices: it looks
//! like a total.
//!
//! So every result carries what it covers. A derivation that needs the whole
//! set checks for it and declines otherwise, which turns "the supply is 40,000"
//! into either a supported claim or an explicit "not from this data" — never a
//! confident understatement.
//!
//! Two other things travel with a result, for the same reason:
//!
//! - **Evidence.** An indexer's word and a figure derived from a wallet's own
//!   verified coins are not the same claim, and a wallet that records them
//!   identically cannot later say which it relied on.
//! - **Chain position.** Any of these answers is only true as of some tip. A
//!   supply figure with no idea when it was true cannot be invalidated by a
//!   reorg, because nothing knows what it was counting.
//!
//! Nothing here is provider-shaped. An indexer answering directly and a local
//! derivation over generic primitives produce the same type, so removing a
//! specialized provider later is a routing change rather than a migration.

use std::collections::BTreeMap;

use optn_core::token::TokenData;

use crate::chain::{Evidence, Hash32};

/// A locking script: what actually holds a coin, before anyone renders it as
/// an address.
pub type HolderScript = Vec<u8>;

/// Who holds a category, and how much.
pub type HolderBalances = BTreeMap<HolderScript, u64>;

/// Holders ranked by amount, largest first.
pub type HolderRanking = Vec<(HolderScript, u64)>;

/// A wallet-visible coin carrying a token, as some source reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenUtxo {
    pub txid: Hash32,
    pub vout: u32,
    /// The locking script, which is what a holder actually is.
    pub script: Vec<u8>,
    pub token: TokenData,
}

/// How much of the thing an answer covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    /// Every member, as of the stated chain position.
    ///
    /// Only a source that can say so may claim this. "The page I received had
    /// no cursor" is not the same statement as "this is all of them", though
    /// it is often mistaken for it.
    Complete,
    /// A page or subset. Cannot support any global total.
    Partial {
        returned: usize,
        /// Where the rest continues, when the source offers a way through.
        cursor: Option<String>,
    },
    /// Scoped to this wallet's own coins.
    ///
    /// Complete for questions about the holder and meaningless for questions
    /// about a category: a wallet knowing all of *its* NFTs in a category says
    /// nothing about how many exist.
    Wallet,
}

impl Scope {
    /// Whether a global total may be computed from data with this scope.
    pub const fn supports_global_total(&self) -> bool {
        matches!(self, Self::Complete)
    }
}

/// An answer, with everything needed to judge it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Normalized<T> {
    pub value: T,
    pub scope: Scope,
    pub evidence: Evidence,
    /// The chain position this was true at, so a reorg can invalidate it.
    pub chain_tip: Option<(u32, Hash32)>,
}

impl<T> Normalized<T> {
    pub const fn new(
        value: T,
        scope: Scope,
        evidence: Evidence,
        chain_tip: Option<(u32, Hash32)>,
    ) -> Self {
        Self {
            value,
            scope,
            evidence,
            chain_tip,
        }
    }

    /// Whether a reorg past `height` invalidates this.
    pub fn invalidated_by_reorg_to(&self, height: u32) -> bool {
        self.chain_tip
            .is_some_and(|(observed, _)| observed >= height)
    }
}

/// Why a derivation declined to produce a result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DerivationError {
    /// The inputs do not cover the whole set, so a total would understate it.
    ///
    /// Not a failure to compute. A refusal to publish a number that would be
    /// read as a total when it is a subtotal.
    IncompleteScope { scope: Scope },
    /// The observations came from different chain positions, so combining
    /// them would describe a chain that never existed.
    MixedChainPositions,
    /// A total does not fit.
    AmountOverflow,
}

/// A category's fungible supply, from its complete UTXO set.
///
/// Declines on anything but a complete set. A supply figure is exactly the
/// kind of number that gets quoted without its caveats.
pub fn supply_from_utxos(
    utxos: &Normalized<Vec<TokenUtxo>>,
    category: [u8; 32],
) -> Result<Normalized<u64>, DerivationError> {
    if !utxos.scope.supports_global_total() {
        return Err(DerivationError::IncompleteScope {
            scope: utxos.scope.clone(),
        });
    }
    let mut total = 0u64;
    for utxo in &utxos.value {
        if utxo.token.category != category {
            continue;
        }
        total = total
            .checked_add(utxo.token.amount)
            .ok_or(DerivationError::AmountOverflow)?;
    }
    Ok(Normalized::new(
        total,
        Scope::Complete,
        utxos.evidence.clone(),
        utxos.chain_tip,
    ))
}

/// Who holds a category, and how much, from its complete UTXO set.
///
/// Keyed by locking script rather than address: a script is what actually
/// holds a coin, and rendering it as an address is a presentation decision
/// that belongs nowhere near the arithmetic.
pub fn holders_from_utxos(
    utxos: &Normalized<Vec<TokenUtxo>>,
    category: [u8; 32],
) -> Result<Normalized<HolderBalances>, DerivationError> {
    if !utxos.scope.supports_global_total() {
        return Err(DerivationError::IncompleteScope {
            scope: utxos.scope.clone(),
        });
    }
    let mut holders: HolderBalances = BTreeMap::new();
    for utxo in &utxos.value {
        if utxo.token.category != category {
            continue;
        }
        let entry = holders.entry(utxo.script.clone()).or_default();
        *entry = entry
            .checked_add(utxo.token.amount)
            .ok_or(DerivationError::AmountOverflow)?;
    }
    Ok(Normalized::new(
        holders,
        Scope::Complete,
        utxos.evidence.clone(),
        utxos.chain_tip,
    ))
}

/// The largest holders first.
///
/// Derived from holders, so it inherits their scope: a top-ten from a page is
/// the top ten *of that page*, which is not what anyone means by it.
pub fn top_holders(
    holders: &Normalized<HolderBalances>,
    limit: usize,
) -> Result<Normalized<HolderRanking>, DerivationError> {
    if !holders.scope.supports_global_total() {
        return Err(DerivationError::IncompleteScope {
            scope: holders.scope.clone(),
        });
    }
    let mut ranked: HolderRanking = holders
        .value
        .iter()
        .map(|(script, amount)| (script.clone(), *amount))
        .collect();
    // Amount descending, then script, so equal balances have a stable order
    // rather than one that depends on map iteration.
    ranked.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    ranked.truncate(limit);
    Ok(Normalized::new(
        ranked,
        Scope::Complete,
        holders.evidence.clone(),
        holders.chain_tip,
    ))
}

/// Every NFT in a category, from its complete UTXO set.
pub fn nfts_in_category(
    utxos: &Normalized<Vec<TokenUtxo>>,
    category: [u8; 32],
) -> Result<Normalized<Vec<TokenUtxo>>, DerivationError> {
    if !utxos.scope.supports_global_total() {
        return Err(DerivationError::IncompleteScope {
            scope: utxos.scope.clone(),
        });
    }
    let found = utxos
        .value
        .iter()
        .filter(|utxo| utxo.token.category == category && utxo.token.nft.is_some())
        .cloned()
        .collect();
    Ok(Normalized::new(
        found,
        Scope::Complete,
        utxos.evidence.clone(),
        utxos.chain_tip,
    ))
}

/// What this wallet holds, per category, from its own coins.
///
/// Always `Scope::Wallet`. Complete for "what do I own" and unusable for "how
/// many exist", which is the distinction the whole module is built around: the
/// wallet's own sync answers the first question without any indexer at all.
pub fn owned_balances(
    utxos: &Normalized<Vec<TokenUtxo>>,
) -> Result<Normalized<BTreeMap<[u8; 32], u64>>, DerivationError> {
    let mut balances: BTreeMap<[u8; 32], u64> = BTreeMap::new();
    for utxo in &utxos.value {
        let entry = balances.entry(utxo.token.category).or_default();
        *entry = entry
            .checked_add(utxo.token.amount)
            .ok_or(DerivationError::AmountOverflow)?;
    }
    Ok(Normalized::new(
        balances,
        Scope::Wallet,
        utxos.evidence.clone(),
        utxos.chain_tip,
    ))
}

/// This wallet's NFTs, per category.
///
/// A category with no fungible amount and no NFT still appears in
/// [`owned_balances`] with a zero balance; here it simply has no entries. Both
/// are deliberate: a zero-amount coin is still a coin the wallet controls.
pub fn owned_nfts(
    utxos: &Normalized<Vec<TokenUtxo>>,
) -> Normalized<BTreeMap<[u8; 32], Vec<TokenUtxo>>> {
    let mut inventory: BTreeMap<[u8; 32], Vec<TokenUtxo>> = BTreeMap::new();
    for utxo in &utxos.value {
        if utxo.token.nft.is_some() {
            inventory
                .entry(utxo.token.category)
                .or_default()
                .push(utxo.clone());
        }
    }
    Normalized::new(
        inventory,
        Scope::Wallet,
        utxos.evidence.clone(),
        utxos.chain_tip,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_core::token::{Capability, Nft};

    const ALPHA: [u8; 32] = [1; 32];
    const BETA: [u8; 32] = [2; 32];

    fn coin(script: u8, category: [u8; 32], amount: u64) -> TokenUtxo {
        TokenUtxo {
            txid: [script; 32],
            vout: 0,
            script: vec![script],
            token: TokenData::fungible(category, amount),
        }
    }

    fn nft(script: u8, category: [u8; 32]) -> TokenUtxo {
        TokenUtxo {
            txid: [script; 32],
            vout: 1,
            script: vec![script],
            token: TokenData {
                category,
                amount: 0,
                nft: Some(Nft {
                    capability: Capability::None,
                    commitment: vec![script],
                }),
            },
        }
    }

    fn complete(utxos: Vec<TokenUtxo>) -> Normalized<Vec<TokenUtxo>> {
        Normalized::new(
            utxos,
            Scope::Complete,
            Evidence::ServerAssertion,
            Some((800_000, [9; 32])),
        )
    }

    fn page(utxos: Vec<TokenUtxo>, cursor: Option<&str>) -> Normalized<Vec<TokenUtxo>> {
        let returned = utxos.len();
        Normalized::new(
            utxos,
            Scope::Partial {
                returned,
                cursor: cursor.map(str::to_owned),
            },
            Evidence::ServerAssertion,
            Some((800_000, [9; 32])),
        )
    }

    #[test]
    fn supply_adds_up_only_the_requested_category() {
        let utxos = complete(vec![
            coin(1, ALPHA, 1_000),
            coin(2, ALPHA, 2_500),
            coin(3, BETA, 9_999),
        ]);
        let supply = supply_from_utxos(&utxos, ALPHA).expect("a complete set totals");
        assert_eq!(supply.value, 3_500);
        assert_eq!(supply.scope, Scope::Complete);
        assert_eq!(supply.chain_tip, Some((800_000, [9; 32])));
    }

    /// The refusal this module exists for.
    ///
    /// A page adds up perfectly well. The number is just wrong, in the one way
    /// nobody catches: it looks like a total.
    #[test]
    fn a_page_cannot_produce_a_supply() {
        let utxos = page(vec![coin(1, ALPHA, 1_000)], Some("next"));
        assert!(matches!(
            supply_from_utxos(&utxos, ALPHA),
            Err(DerivationError::IncompleteScope { .. })
        ));
    }

    /// A page with no cursor is still a page.
    ///
    /// "The reply had no continuation" is not the same claim as "this is all of
    /// them", and treating them alike is how a truncated indexer response
    /// becomes a published total.
    #[test]
    fn a_final_page_is_still_not_a_complete_set() {
        let utxos = page(vec![coin(1, ALPHA, 1_000)], None);
        assert!(matches!(
            supply_from_utxos(&utxos, ALPHA),
            Err(DerivationError::IncompleteScope { .. })
        ));
    }

    /// The wallet's own coins answer about the wallet and nothing wider.
    #[test]
    fn wallet_scope_cannot_answer_a_global_question() {
        let mine = Normalized::new(
            vec![coin(1, ALPHA, 500)],
            Scope::Wallet,
            Evidence::FullNodeValidated {
                source: crate::chain::SourceId::new("own-node"),
            },
            Some((800_000, [9; 32])),
        );
        assert!(matches!(
            supply_from_utxos(&mine, ALPHA),
            Err(DerivationError::IncompleteScope {
                scope: Scope::Wallet
            })
        ));
        // But it answers about the holder perfectly well, with no indexer.
        let balances = owned_balances(&mine).expect("a wallet totals its own coins");
        assert_eq!(balances.value.get(&ALPHA), Some(&500));
        assert_eq!(balances.scope, Scope::Wallet);
    }

    #[test]
    fn holders_are_grouped_by_the_script_that_holds_them() {
        let utxos = complete(vec![
            coin(1, ALPHA, 100),
            coin(1, ALPHA, 400),
            coin(2, ALPHA, 250),
            coin(3, BETA, 700),
        ]);
        let holders = holders_from_utxos(&utxos, ALPHA).expect("a complete set groups");
        assert_eq!(holders.value.len(), 2);
        assert_eq!(holders.value.get(&vec![1u8]), Some(&500));
        assert_eq!(holders.value.get(&vec![2u8]), Some(&250));
    }

    #[test]
    fn top_holders_rank_by_amount_and_break_ties_stably() {
        let utxos = complete(vec![
            coin(1, ALPHA, 100),
            coin(2, ALPHA, 900),
            coin(3, ALPHA, 100),
        ]);
        let holders = holders_from_utxos(&utxos, ALPHA).expect("holders");
        let ranked = top_holders(&holders, 2).expect("a ranking");
        assert_eq!(ranked.value[0], (vec![2u8], 900));
        assert_eq!(ranked.value[1], (vec![1u8], 100));
    }

    /// A ranking is only as global as the set it came from.
    #[test]
    fn a_ranking_inherits_its_sets_scope() {
        let partial = Normalized::new(
            BTreeMap::from([(vec![1u8], 10u64)]),
            Scope::Partial {
                returned: 1,
                cursor: None,
            },
            Evidence::ServerAssertion,
            None,
        );
        assert!(matches!(
            top_holders(&partial, 10),
            Err(DerivationError::IncompleteScope { .. })
        ));
    }

    #[test]
    fn nft_enumeration_needs_the_whole_category() {
        let utxos = complete(vec![nft(1, ALPHA), coin(2, ALPHA, 5), nft(3, BETA)]);
        let found = nfts_in_category(&utxos, ALPHA).expect("a complete set enumerates");
        assert_eq!(found.value.len(), 1);
        assert_eq!(found.value[0].script, vec![1u8]);

        let partial = page(vec![nft(1, ALPHA)], Some("more"));
        assert!(matches!(
            nfts_in_category(&partial, ALPHA),
            Err(DerivationError::IncompleteScope { .. })
        ));
    }

    /// A wallet's own NFTs need no indexer, and claim nothing global.
    #[test]
    fn a_wallet_lists_its_own_nfts_without_an_indexer() {
        let mine = Normalized::new(
            vec![nft(1, ALPHA), nft(2, ALPHA), coin(3, BETA, 7)],
            Scope::Wallet,
            Evidence::ServerAssertion,
            Some((800_000, [9; 32])),
        );
        let inventory = owned_nfts(&mine);
        assert_eq!(inventory.value.get(&ALPHA).map(Vec::len), Some(2));
        assert_eq!(inventory.value.get(&BETA), None);
        assert_eq!(inventory.scope, Scope::Wallet);
    }

    /// A zero-amount coin is still a coin the wallet controls.
    #[test]
    fn zero_amount_categories_survive_the_balance_projection() {
        let mine = Normalized::new(
            vec![nft(1, ALPHA)],
            Scope::Wallet,
            Evidence::ServerAssertion,
            None,
        );
        let balances = owned_balances(&mine).expect("balances");
        assert_eq!(
            balances.value.get(&ALPHA),
            Some(&0),
            "an NFT-only category must not vanish from the wallet"
        );
    }

    #[test]
    fn a_total_that_would_overflow_is_refused_rather_than_wrapped() {
        let utxos = complete(vec![coin(1, ALPHA, u64::MAX), coin(2, ALPHA, 1)]);
        assert_eq!(
            supply_from_utxos(&utxos, ALPHA),
            Err(DerivationError::AmountOverflow)
        );
    }

    /// A result knows when it was true, so a reorg can throw it away.
    #[test]
    fn a_reorg_invalidates_results_observed_at_or_above_it() {
        let utxos = complete(vec![coin(1, ALPHA, 10)]);
        let supply = supply_from_utxos(&utxos, ALPHA).expect("supply");
        assert!(supply.invalidated_by_reorg_to(799_999));
        assert!(supply.invalidated_by_reorg_to(800_000));
        assert!(!supply.invalidated_by_reorg_to(800_001));

        let undated = Normalized::new(0u64, Scope::Complete, Evidence::ServerAssertion, None);
        assert!(
            !undated.invalidated_by_reorg_to(1),
            "a result with no chain position cannot be reasoned about this way"
        );
    }

    /// Evidence travels, so a wallet can say which answer it relied on.
    #[test]
    fn evidence_travels_with_the_derived_result() {
        let source = crate::chain::SourceId::new("own-node");
        let utxos = Normalized::new(
            vec![coin(1, ALPHA, 10)],
            Scope::Complete,
            Evidence::FullNodeValidated {
                source: source.clone(),
            },
            None,
        );
        let supply = supply_from_utxos(&utxos, ALPHA).expect("supply");
        assert_eq!(supply.evidence, Evidence::FullNodeValidated { source });
    }
}
