//! ServerHello and wallet contribution validation for server CashFusion.
//!
//! Output amounts are randomized in the renderer because that layer owns the
//! wallet address database. Native code treats those plans as untrusted input:
//! it checks every fee/value invariant, registers every feasible tier, and only
//! selects the matching plan after the live server sends `FusionBegin`.

use std::collections::{BTreeMap, HashSet};

use super::pb;

pub const MAX_COMPONENT_FEERATE: u64 = 5_000;
pub const MAX_EXCESS_FEE: u64 = 10_000;
pub const MAX_COMPONENTS: usize = 40;
pub const MAX_FEE: u64 = 45_000;
pub const MIN_TX_COMPONENTS: usize = 11;
pub const MIN_OUTPUT: u64 = 10_000;
// Electron Cash's reference server advertises 6 decades x 12 E12 values = 72
// tiers. Bound hostile replies while leaving headroom for compatible servers.
const MAX_TIERS: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedHello {
    pub tiers: Vec<u64>,
    pub num_components: u32,
    pub component_feerate: u64,
    pub min_excess_fee: u64,
    pub max_excess_fee: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionTierPlan {
    pub tier: u64,
    pub output_values: Vec<u64>,
    pub excess_fee: u64,
}

pub fn component_fee(size: u64, feerate: u64) -> Result<u64, String> {
    size.checked_mul(feerate)
        .ok_or_else(|| "component fee overflow".to_string())
        .map(|product| product.div_ceil(1_000))
}

fn canonical_tiers(tiers: &[u64]) -> Result<Vec<u64>, String> {
    if tiers.is_empty() || tiers.len() > MAX_TIERS {
        return Err("server advertised an invalid number of tiers".into());
    }
    let mut canonical = tiers.to_vec();
    if canonical.iter().any(|tier| *tier < MIN_OUTPUT) {
        return Err("server advertised an invalid tier".into());
    }
    canonical.sort_unstable();
    canonical.dedup();
    if canonical.len() != tiers.len() {
        return Err("server advertised duplicate tiers".into());
    }
    Ok(canonical)
}

pub fn validate_server_hello(hello: &pb::ServerHello) -> Result<(), String> {
    canonical_tiers(&hello.tiers)?;
    if hello.component_feerate > MAX_COMPONENT_FEERATE {
        return Err("excessive component feerate from server".into());
    }
    if hello.min_excess_fee > 400 {
        return Err("excessive min excess fee from server".into());
    }
    if hello.min_excess_fee > hello.max_excess_fee {
        return Err("bad config on server: fees".into());
    }
    if hello.num_components < 17 {
        return Err("bad config on server: too few components".into());
    }
    if hello.num_components as usize > MAX_COMPONENTS {
        return Err("bad config on server: too many components".into());
    }
    Ok(())
}

pub fn validate_hello_match(
    live: &pb::ServerHello,
    expected: &ExpectedHello,
) -> Result<(), String> {
    let live_tiers = canonical_tiers(&live.tiers)?;
    let expected_tiers = canonical_tiers(&expected.tiers)?;
    let mut mismatches = Vec::new();
    if live_tiers != expected_tiers {
        mismatches.push("tiers");
    }
    if live.num_components != expected.num_components {
        mismatches.push("num_components");
    }
    if live.component_feerate != expected.component_feerate {
        mismatches.push("component_feerate");
    }
    if live.min_excess_fee != expected.min_excess_fee {
        mismatches.push("min_excess_fee");
    }
    if live.max_excess_fee != expected.max_excess_fee {
        mismatches.push("max_excess_fee");
    }
    if mismatches.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "live ServerHello does not match the expected snapshot (changed: {})",
            mismatches.join(", ")
        ))
    }
}

fn is_standard_p2pkh(script: &[u8]) -> bool {
    script.len() == 25 && script[0..3] == [0x76, 0xa9, 0x14] && script[23..25] == [0x88, 0xac]
}

/// Check all renderer-produced plans and return them indexed by tier.
pub fn validate_and_index_plans(
    hello: &pb::ServerHello,
    input_pubkeys: &[Vec<u8>],
    input_values: &[u64],
    output_scripts: &[Vec<u8>],
    plans: &[FusionTierPlan],
) -> Result<BTreeMap<u64, FusionTierPlan>, String> {
    validate_server_hello(hello)?;
    if input_pubkeys.is_empty() || input_pubkeys.len() != input_values.len() {
        return Err("invalid fusion input plan".into());
    }
    if input_pubkeys
        .iter()
        .any(|pubkey| pubkey.len() != 33 || !matches!(pubkey[0], 0x02 | 0x03))
    {
        return Err("server fusion requires compressed P2PKH input keys".into());
    }
    if output_scripts.is_empty()
        || output_scripts
            .iter()
            .any(|script| !is_standard_p2pkh(script))
    {
        return Err("server fusion requires fresh standard P2PKH output scripts".into());
    }
    if plans.is_empty() {
        return Err("no feasible server fusion tier plans".into());
    }

    let max_components = hello.num_components as usize;
    let max_outputs = max_components
        .checked_sub(input_pubkeys.len())
        .ok_or_else(|| "too many inputs for the server component count".to_string())?;
    if max_outputs == 0 {
        return Err("too many inputs for the server component count".into());
    }
    let distinct_inputs = input_pubkeys
        .iter()
        .map(Vec::as_slice)
        .collect::<HashSet<_>>()
        .len();
    let min_outputs = MIN_TX_COMPONENTS.saturating_sub(distinct_inputs).max(1);
    if max_outputs < min_outputs {
        return Err("too few distinct inputs for the required output count".into());
    }

    let sum_in = input_values.iter().try_fold(0u64, |sum, value| {
        sum.checked_add(*value)
            .ok_or_else(|| "fusion input value overflow".to_string())
    })?;
    let input_fees = input_pubkeys.iter().try_fold(0u64, |sum, pubkey| {
        let fee = component_fee(108 + pubkey.len() as u64, hello.component_feerate)?;
        sum.checked_add(fee)
            .ok_or_else(|| "fusion input fee overflow".to_string())
    })?;
    let output_component_fee = component_fee(34, hello.component_feerate)?;
    let server_tiers = canonical_tiers(&hello.tiers)?
        .into_iter()
        .collect::<HashSet<_>>();
    let max_allowed_excess = hello.max_excess_fee.min(MAX_EXCESS_FEE);

    let mut indexed = BTreeMap::new();
    let mut largest_output_count = 0usize;
    for plan in plans {
        if !server_tiers.contains(&plan.tier) {
            return Err(format!(
                "tier {} was not advertised by the live server",
                plan.tier
            ));
        }
        if indexed.contains_key(&plan.tier) {
            return Err("duplicate server fusion tier plan".into());
        }
        if plan.output_values.len() < min_outputs || plan.output_values.len() > max_outputs {
            return Err(format!("tier {} has an unsafe output count", plan.tier));
        }
        if plan.output_values.iter().any(|value| *value < MIN_OUTPUT) {
            return Err(format!(
                "tier {} creates an output below the wallet minimum",
                plan.tier
            ));
        }
        let sum_out = plan.output_values.iter().try_fold(0u64, |sum, value| {
            sum.checked_add(*value)
                .ok_or_else(|| "fusion output value overflow".to_string())
        })?;
        let total_fee = sum_in
            .checked_sub(sum_out)
            .ok_or_else(|| format!("tier {} spends more than its inputs", plan.tier))?;
        let output_fees = output_component_fee
            .checked_mul(plan.output_values.len() as u64)
            .ok_or_else(|| "fusion output fee overflow".to_string())?;
        let required_component_fees = input_fees
            .checked_add(output_fees)
            .ok_or_else(|| "fusion component fee overflow".to_string())?;
        let derived_excess = total_fee
            .checked_sub(required_component_fees)
            .ok_or_else(|| format!("tier {} underpays component fees", plan.tier))?;
        if derived_excess != plan.excess_fee {
            return Err(format!("tier {} has an inconsistent excess fee", plan.tier));
        }
        if plan.excess_fee < hello.min_excess_fee || plan.excess_fee > max_allowed_excess {
            return Err(format!("tier {} exceeds the allowed excess fee", plan.tier));
        }
        if total_fee > MAX_FEE {
            return Err(format!("tier {} exceeds the wallet fee limit", plan.tier));
        }

        largest_output_count = largest_output_count.max(plan.output_values.len());
        indexed.insert(plan.tier, plan.clone());
    }

    if output_scripts.len() != largest_output_count {
        return Err("fresh output script pool does not match the largest tier plan".into());
    }
    Ok(indexed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello() -> pb::ServerHello {
        pb::ServerHello {
            tiers: vec![10_000, 100_000],
            num_components: 17,
            component_feerate: 1_000,
            min_excess_fee: 10,
            max_excess_fee: 10_000,
            donation_address: None,
        }
    }

    fn p2pkh(seed: u8) -> Vec<u8> {
        let mut script = vec![0x76, 0xa9, 0x14];
        script.extend_from_slice(&[seed; 20]);
        script.extend_from_slice(&[0x88, 0xac]);
        script
    }

    #[test]
    fn hello_rejects_unbounded_components_and_duplicate_tiers() {
        let mut oversized = hello();
        oversized.num_components = 41;
        assert!(validate_server_hello(&oversized)
            .unwrap_err()
            .contains("too many components"));

        let mut duplicate = hello();
        duplicate.tiers.push(10_000);
        assert!(validate_server_hello(&duplicate)
            .unwrap_err()
            .contains("duplicate tiers"));
    }

    #[test]
    fn hello_accepts_the_reference_servers_72_e12_tiers() {
        let factors = [10_u64, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82];
        let bases = [
            10_000_u64,
            100_000,
            1_000_000,
            10_000_000,
            100_000_000,
            1_000_000_000,
        ];
        let tiers = bases
            .into_iter()
            .flat_map(|base| factors.map(|factor| base * factor / 10))
            .collect::<Vec<_>>();
        assert_eq!(tiers.len(), 72);

        let mut reference = hello();
        reference.tiers = tiers;
        validate_server_hello(&reference).unwrap();
    }

    #[test]
    fn hello_match_treats_tier_order_as_semantically_equal() {
        let live = hello();
        let expected = ExpectedHello {
            tiers: vec![100_000, 10_000],
            num_components: 17,
            component_feerate: 1_000,
            min_excess_fee: 10,
            max_excess_fee: 10_000,
        };
        validate_hello_match(&live, &expected).unwrap();
    }

    #[test]
    fn plans_preserve_value_and_fee_invariants() {
        let live = hello();
        let pubkeys = (0..6)
            .map(|seed| {
                let mut key = vec![0x02; 33];
                key[1] = seed;
                key
            })
            .collect::<Vec<_>>();
        let inputs = vec![30_000; 6];
        // Six inputs at 141 sat each + five outputs at 34 sat each + 10 excess.
        let outputs = vec![35_794, 35_795, 35_795, 35_795, 35_795];
        let plans = vec![FusionTierPlan {
            tier: 10_000,
            output_values: outputs,
            excess_fee: 10,
        }];
        let scripts = (0..5).map(p2pkh).collect::<Vec<_>>();

        let indexed = validate_and_index_plans(&live, &pubkeys, &inputs, &scripts, &plans).unwrap();
        assert_eq!(indexed.keys().copied().collect::<Vec<_>>(), vec![10_000]);
    }

    #[test]
    fn plans_reject_fee_burn_and_script_pool_mismatch() {
        let live = hello();
        let pubkeys = (0..6)
            .map(|seed| {
                let mut key = vec![0x02; 33];
                key[1] = seed;
                key
            })
            .collect::<Vec<_>>();
        let inputs = vec![30_000; 6];
        let bad = vec![FusionTierPlan {
            tier: 10_000,
            output_values: vec![10_000; 5],
            excess_fee: 10,
        }];
        let scripts = (0..5).map(p2pkh).collect::<Vec<_>>();
        assert!(
            validate_and_index_plans(&live, &pubkeys, &inputs, &scripts, &bad)
                .unwrap_err()
                .contains("inconsistent excess fee")
        );

        let good = vec![FusionTierPlan {
            tier: 10_000,
            output_values: vec![35_794, 35_795, 35_795, 35_795, 35_795],
            excess_fee: 10,
        }];
        assert!(
            validate_and_index_plans(&live, &pubkeys, &inputs, &scripts[..4], &good)
                .unwrap_err()
                .contains("script pool")
        );
    }
}
