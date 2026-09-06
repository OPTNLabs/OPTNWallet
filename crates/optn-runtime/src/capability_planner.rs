
//! Token/BCMR capability planning above the provider router.
//!
//! This module intentionally contains no TokenIndex-, Fulcrum-, BCHN-, or
//! BCMR-indexer-specific client. It describes stable operations and the generic
//! capabilities from which OPTN can answer them. Provider adapters only
//! advertise capabilities; source policy and `ChainService` decide which route
//! is eligible.

use crate::chain::Capability;

/// Stable token/BCMR operation requested by runtime/application code.
///
/// These are deliberately not provider names. A specialized service may answer
/// one directly today while Fulcrum/BCHN primitives allow the same operation to
/// be derived locally later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TokenCapabilityOperation {
    OwnedTokenBalances,
    OwnedNftInventory,
    CategoryUtxos,
    CategorySupply,
    CategoryHolders,
    CategoryTopHolders,
    NftEnumeration,
    Discovery,
    OutpointSpender,
    BcmrAuthchainEvidence,
    BcmrAuthhead,
    BcmrRegistryCandidate,
}

/// Provider-neutral local composition that turns lower-level observations into
/// a stable operation result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalDerivation {
    OwnedTokenBalancesFromWalletState,
    OwnedNftInventoryFromWalletState,
    CategorySupplyFromUtxos,
    CategoryHoldersFromUtxos,
    CategoryTopHoldersFromHolders,
    CategoryTopHoldersFromUtxos,
    NftEnumerationFromCategoryUtxos,
    BcmrAuthchainFromSpenderLookup,
    BcmrAuthheadFromSpenderLookup,
    BcmrRegistryCandidateFromTransaction,
}

/// One candidate execution shape. Selection of a concrete source/endpoint is
/// still performed by the existing capability router and policy model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapabilityPlan {
    /// One provider advertises the exact normalized capability.
    Direct { capability: Capability },
    /// OPTN derives the result locally from generic capabilities. Required
    /// primitives may come from different eligible routes inside the same
    /// source policy; provider identity never leaks into the result type.
    Derived {
        derivation: LocalDerivation,
        requires: Vec<Capability>,
    },
}

impl CapabilityPlan {
    pub fn requirements(&self) -> &[Capability] {
        match self {
            Self::Direct { capability } => std::slice::from_ref(capability),
            Self::Derived { requires, .. } => requires,
        }
    }

    pub const fn is_direct(&self) -> bool {
        matches!(self, Self::Direct { .. })
    }
}

/// Return every semantically valid execution plan for an operation.
///
/// This function does not choose a provider and does not weaken source/privacy
/// policy. Use `viable_plans` with `ChainService::has_route_for_capability` (or
/// an equivalent policy-aware route predicate) to discard impossible plans.
pub fn candidate_plans(operation: TokenCapabilityOperation) -> Vec<CapabilityPlan> {
    use Capability::*;
    use LocalDerivation::*;

    match operation {
        TokenCapabilityOperation::OwnedTokenBalances => vec![CapabilityPlan::Derived {
            derivation: OwnedTokenBalancesFromWalletState,
            requires: vec![UtxoQuery],
        }],
        TokenCapabilityOperation::OwnedNftInventory => vec![CapabilityPlan::Derived {
            derivation: OwnedNftInventoryFromWalletState,
            requires: vec![UtxoQuery],
        }],
        TokenCapabilityOperation::CategoryUtxos => vec![CapabilityPlan::Direct {
            capability: TokenCategoryUtxos,
        }],
        TokenCapabilityOperation::CategorySupply => vec![
            CapabilityPlan::Direct {
                capability: TokenCategorySupply,
            },
            CapabilityPlan::Derived {
                derivation: CategorySupplyFromUtxos,
                requires: vec![TokenCategoryUtxos],
            },
        ],
        TokenCapabilityOperation::CategoryHolders => vec![
            CapabilityPlan::Direct {
                capability: TokenCategoryHolders,
            },
            CapabilityPlan::Derived {
                derivation: CategoryHoldersFromUtxos,
                requires: vec![TokenCategoryUtxos],
            },
        ],
        TokenCapabilityOperation::CategoryTopHolders => vec![
            CapabilityPlan::Direct {
                capability: TokenCategoryTopHolders,
            },
            CapabilityPlan::Derived {
                derivation: CategoryTopHoldersFromHolders,
                requires: vec![TokenCategoryHolders],
            },
            CapabilityPlan::Derived {
                derivation: CategoryTopHoldersFromUtxos,
                requires: vec![TokenCategoryUtxos],
            },
        ],
        TokenCapabilityOperation::NftEnumeration => vec![
            CapabilityPlan::Direct {
                capability: TokenNftEnumeration,
            },
            CapabilityPlan::Derived {
                derivation: NftEnumerationFromCategoryUtxos,
                requires: vec![TokenCategoryUtxos],
            },
        ],
        TokenCapabilityOperation::Discovery => vec![CapabilityPlan::Direct {
            capability: TokenDiscovery,
        }],
        TokenCapabilityOperation::OutpointSpender => vec![CapabilityPlan::Direct {
            capability: OutpointSpenderLookup,
        }],
        TokenCapabilityOperation::BcmrAuthchainEvidence => vec![
            CapabilityPlan::Direct {
                capability: BcmrAuthchainEvidence,
            },
            CapabilityPlan::Derived {
                derivation: BcmrAuthchainFromSpenderLookup,
                requires: vec![OutpointSpenderLookup, TransactionQuery],
            },
        ],
        TokenCapabilityOperation::BcmrAuthhead => vec![
            CapabilityPlan::Direct {
                capability: BcmrAuthhead,
            },
            CapabilityPlan::Derived {
                derivation: BcmrAuthheadFromSpenderLookup,
                requires: vec![OutpointSpenderLookup, TransactionQuery],
            },
        ],
        TokenCapabilityOperation::BcmrRegistryCandidate => vec![
            CapabilityPlan::Direct {
                capability: BcmrRegistryCandidate,
            },
            CapabilityPlan::Derived {
                derivation: BcmrRegistryCandidateFromTransaction,
                requires: vec![TransactionQuery],
            },
        ],
    }
}

/// Filter candidate plans using a policy-aware exact-capability route predicate.
///
/// No provider is preferred here. The caller can rank the surviving plans by
/// source ownership, privacy cost, evidence, health, latency, and computation
/// cost using the existing selection model.
pub fn viable_plans(
    operation: TokenCapabilityOperation,
    mut has_route: impl FnMut(Capability) -> bool,
) -> Vec<CapabilityPlan> {
    candidate_plans(operation)
        .into_iter()
        .filter(|plan| plan.requirements().iter().copied().all(&mut has_route))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn owned_assets_collapse_to_normal_wallet_sync() {
        for operation in [
            TokenCapabilityOperation::OwnedTokenBalances,
            TokenCapabilityOperation::OwnedNftInventory,
        ] {
            let plans = candidate_plans(operation);
            assert_eq!(plans.len(), 1);
            assert_eq!(plans[0].requirements(), &[Capability::UtxoQuery]);
            assert!(!plans[0].is_direct());
            assert!(!plans[0]
                .requirements()
                .contains(&Capability::CashTokenIndex));
        }
    }

    #[test]
    fn category_supply_can_migrate_one_primitive_at_a_time() {
        let mut available = BTreeSet::from([Capability::TokenCategoryUtxos]);
        let derived_only = viable_plans(TokenCapabilityOperation::CategorySupply, |capability| {
            available.contains(&capability)
        });
        assert_eq!(derived_only.len(), 1);
        assert!(matches!(derived_only[0], CapabilityPlan::Derived { .. }));

        available.insert(Capability::TokenCategorySupply);
        let both = viable_plans(TokenCapabilityOperation::CategorySupply, |capability| {
            available.contains(&capability)
        });
        assert_eq!(both.len(), 2);
        assert!(both.iter().any(CapabilityPlan::is_direct));
    }

    #[test]
    fn bcmr_authhead_can_collapse_to_generic_spender_and_tx_lookup() {
        let available = BTreeSet::from([
            Capability::OutpointSpenderLookup,
            Capability::TransactionQuery,
        ]);
        let plans = viable_plans(TokenCapabilityOperation::BcmrAuthhead, |capability| {
            available.contains(&capability)
        });
        assert_eq!(plans.len(), 1);
        assert!(matches!(
            plans[0],
            CapabilityPlan::Derived {
                derivation: LocalDerivation::BcmrAuthheadFromSpenderLookup,
                ..
            }
        ));
    }

    #[test]
    fn missing_optional_global_capability_degrades_without_fake_fallback() {
        let plans = viable_plans(TokenCapabilityOperation::Discovery, |_| false);
        assert!(plans.is_empty());
    }
}
