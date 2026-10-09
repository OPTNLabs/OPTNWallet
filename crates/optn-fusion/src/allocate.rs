//! Which tiers a contribution can join, and the randomized output amounts for
//! each: Electron Cash's `allocate_outputs` and `random_outputs_for_tier`
//! (`fusion.py`, `util.py`).
//!
//! One implementation for every surface, entered through [`plan_contribution`].
//! It used to live in the desktop renderer; `test-vectors/fusion-allocation.json`
//! was generated from that TypeScript and pins this port to it.
//!
//! The randomness is passed in as uniform samples in `[0, 1)`, consumed in a
//! fixed order (per tier: one for the fuzz fee, then one per drawn output), so
//! the same samples always give the same plans.

use std::collections::{BTreeMap, HashSet};

use crate::server_plan::{
    component_fee, validate_expected_hello, ExpectedHello, FusionTierPlan, MAX_COMPONENTS,
    MAX_EXCESS_FEE, MAX_FEE, MIN_OUTPUT, MIN_TX_COMPONENTS,
};

/// A P2PKH output's serialized size (`util.py`).
pub const P2PKH_OUTPUT_SIZE: u64 = 34;

/// A P2PKH input's serialized size for a pubkey of `pubkey_len` bytes.
pub const fn size_of_input(pubkey_len: u64) -> u64 {
    108 + pubkey_len
}

/// The fee each P2PKH output pays at `feerate` (sat/kB).
pub fn fee_per_output(feerate: u64) -> Result<u64, String> {
    component_fee(P2PKH_OUTPUT_SIZE, feerate)
}

/// One tier this contribution can join.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TierAllocation {
    /// Output values, after each output's own fee.
    pub values: Vec<u64>,
    pub excess_fee: u64,
    pub input_fees: u64,
}

/// A uniform sample in `[0, 1)`, or an error for anything else.
fn uniform(sample: &mut dyn FnMut() -> f64) -> Result<f64, String> {
    let value = sample();
    if !value.is_finite() || !(0.0..1.0).contains(&value) {
        return Err("fusion random source returned an invalid sample".into());
    }
    Ok(value)
}

/// Exponentially distributed output amounts for one tier, summing exactly to
/// `input_amount`, each at least `offset`. `None` when the amount does not fit
/// the distribution (too small, or more than `max_count` outputs).
pub fn random_outputs_for_tier(
    sample: &mut dyn FnMut() -> f64,
    input_amount: u64,
    scale: u64,
    offset: u64,
    max_count: usize,
) -> Result<Option<Vec<u64>>, String> {
    if input_amount < offset || scale == 0 || offset == 0 || max_count == 0 {
        return Ok(None);
    }
    let mut remaining = i128::from(input_amount);
    let mut values: Vec<f64> = Vec::new();
    for _ in 0..=max_count {
        // Exponential variate: -scale * ln(1 - U).
        let value = -(scale as f64) * (1.0 - uniform(sample)?).ln();
        remaining -= value.ceil() as i128 + i128::from(offset);
        if remaining < 0 {
            break;
        }
        values.push(value);
    }
    if values.is_empty() || values.len() > max_count {
        return Ok(None);
    }
    let count = values.len() as u64;
    let Some(desired) = input_amount.checked_sub(count * offset) else {
        return Ok(None);
    };
    // Rescale and round in cumulative space, as Electron Cash does, so the
    // rounding error never accumulates into the last output.
    let mut cumulative = Vec::with_capacity(values.len());
    let mut total = 0.0;
    for value in &values {
        total += value;
        cumulative.push(total);
    }
    let rescale = desired as f64 / total;
    let mut outputs = Vec::with_capacity(values.len());
    let mut previous = 0u64;
    for sum in cumulative {
        let rounded = (rescale * sum).round() as u64;
        outputs.push(offset + rounded - previous);
        previous = rounded;
    }
    Ok(Some(outputs))
}

/// Every tier the server offers that `sum_in` from `input_pubkeys` can fund,
/// with its randomized outputs. `only_tiers` restricts the search, so wallets
/// that must meet can pin the same one; an empty list restricts nothing.
pub fn allocate_feasible_tiers(
    hello: &ExpectedHello,
    sum_in: u64,
    input_pubkeys: &[Vec<u8>],
    sample: &mut dyn FnMut() -> f64,
    only_tiers: Option<&[u64]>,
) -> Result<BTreeMap<u64, TierAllocation>, String> {
    let only_tiers = only_tiers.filter(|wanted| !wanted.is_empty());
    let mut plans = BTreeMap::new();
    let num_inputs = input_pubkeys.len();
    if sum_in == 0
        || num_inputs == 0
        || input_pubkeys
            .iter()
            .any(|key| key.len() != 33 || !matches!(key[0], 0x02 | 0x03))
    {
        return Ok(plans);
    }
    let max_outputs = (hello.num_components as usize).saturating_sub(num_inputs);
    if max_outputs < 1 {
        return Ok(plans);
    }
    let distinct = input_pubkeys.iter().collect::<HashSet<_>>().len();
    let min_outputs = MIN_TX_COMPONENTS.saturating_sub(distinct).max(1);
    if max_outputs < min_outputs {
        return Ok(plans);
    }
    let mut input_fees = 0u64;
    for key in input_pubkeys {
        input_fees += component_fee(size_of_input(key.len() as u64), hello.component_feerate)?;
    }
    let avail_for_outputs =
        i128::from(sum_in) - i128::from(input_fees) - i128::from(hello.min_excess_fee);
    let output_fee = fee_per_output(hello.component_feerate)?;
    let offset_per_output = MIN_OUTPUT + output_fee;
    if avail_for_outputs < i128::from(offset_per_output) {
        return Ok(plans);
    }

    for &scale in &hello.tiers {
        if only_tiers.is_some_and(|wanted| !wanted.contains(&scale)) {
            continue;
        }
        // Fuzz fee: up to tier / 1,000,000 (Electron Cash: scale // 1000000).
        let fuzz_fee_max = (scale / 1_000_000) as i128;
        let reduced_max = fuzz_fee_max
            .min(i128::from(MAX_EXCESS_FEE) - i128::from(hello.min_excess_fee))
            .min(i128::from(hello.max_excess_fee) - i128::from(hello.min_excess_fee));
        if reduced_max < 0 {
            continue;
        }
        let fuzz_fee = (uniform(sample)? * (reduced_max + 1) as f64).floor() as i128;
        let reduced_avail = avail_for_outputs - fuzz_fee;
        if reduced_avail < i128::from(offset_per_output) {
            continue;
        }
        let reduced_avail = reduced_avail as u64;
        let Some(outputs) =
            random_outputs_for_tier(sample, reduced_avail, scale, offset_per_output, max_outputs)?
        else {
            continue;
        };
        if outputs.len() < min_outputs {
            continue;
        }
        let values: Vec<u64> = outputs.iter().map(|output| output - output_fee).collect();
        if values.iter().any(|value| *value < MIN_OUTPUT)
            || num_inputs + values.len() > MAX_COMPONENTS
        {
            continue;
        }
        let excess_fee = sum_in - input_fees - reduced_avail;
        let total_fee = input_fees + values.len() as u64 * output_fee + excess_fee;
        if total_fee > MAX_FEE {
            continue;
        }
        plans.insert(
            scale,
            TierAllocation {
                values,
                excess_fee,
                input_fees,
            },
        );
    }
    Ok(plans)
}

/// The plans a contribution of `inputs` (compressed public key, value)
/// registers with a server advertising `hello`, in the form a round takes them.
///
/// Refuses a hello outside Electron Cash's limits, a key that is not a
/// compressed public key, and a contribution that funds no tier. With tiers
/// pinned, the refusal names them: the answer is then a different tier, not
/// more coins.
pub fn plan_contribution(
    hello: &ExpectedHello,
    inputs: &[(Vec<u8>, u64)],
    only_tiers: Option<&[u64]>,
    sample: &mut dyn FnMut() -> f64,
) -> Result<Vec<FusionTierPlan>, String> {
    validate_expected_hello(hello)?;
    if inputs.is_empty() {
        return Err("no fusion inputs".into());
    }
    if inputs
        .iter()
        .any(|(key, _)| key.len() != 33 || !matches!(key[0], 0x02 | 0x03))
    {
        return Err("Fusion input has an invalid compressed public key.".into());
    }
    let sum_in = inputs
        .iter()
        .try_fold(0u64, |sum, (_, value)| sum.checked_add(*value))
        .ok_or_else(|| "fusion input value overflow".to_string())?;
    let keys: Vec<Vec<u8>> = inputs.iter().map(|(key, _)| key.clone()).collect();
    let plans = allocate_feasible_tiers(hello, sum_in, &keys, sample, only_tiers)?;
    if plans.is_empty() {
        return Err(match only_tiers.filter(|wanted| !wanted.is_empty()) {
            Some(wanted) => format!(
                "Selected inputs cannot fund the requested tier(s): {} sats.",
                wanted
                    .iter()
                    .map(u64::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            None => "Selected inputs cannot afford any fusion tier.".into(),
        });
    }
    Ok(plans
        .into_iter()
        .map(|(tier, plan)| FusionTierPlan {
            tier,
            output_values: plan.values,
            excess_fee: plan.excess_fee,
        })
        .collect())
}

/// Uniform samples from the operating system's random source.
pub fn os_uniform() -> impl FnMut() -> f64 {
    use rand_core::{OsRng, RngCore};
    || (OsRng.next_u64() >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const VECTORS: &str = include_str!("../../../test-vectors/fusion-allocation.json");

    /// The generator's fixed sequence: x = x * 1664525 + 1013904223 mod 2^32.
    fn sequence(seed: u32) -> impl FnMut() -> f64 {
        let mut x = seed;
        move || {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            f64::from(x) / 4_294_967_296.0
        }
    }

    fn hello_from(value: &Value) -> ExpectedHello {
        ExpectedHello {
            tiers: value["tiers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t.as_u64().unwrap())
                .collect(),
            num_components: value["numComponents"].as_u64().unwrap() as u32,
            component_feerate: value["componentFeerate"].as_u64().unwrap(),
            min_excess_fee: value["minExcessFee"].as_u64().unwrap(),
            max_excess_fee: value["maxExcessFee"].as_u64().unwrap(),
        }
    }

    fn u64s(value: &Value) -> Vec<u64> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect()
    }

    #[test]
    fn output_draws_match_the_vectors() {
        let vectors: Value = serde_json::from_str(VECTORS).unwrap();
        for case in vectors["outputs"].as_array().unwrap() {
            let expected = (!case["values"].is_null()).then(|| u64s(&case["values"]));
            let got = random_outputs_for_tier(
                &mut sequence(case["seed"].as_u64().unwrap() as u32),
                case["input"].as_u64().unwrap(),
                case["scale"].as_u64().unwrap(),
                case["offset"].as_u64().unwrap(),
                case["max"].as_u64().unwrap() as usize,
            )
            .unwrap();
            assert_eq!(got, expected, "{case}");
            if let Some(values) = got {
                assert_eq!(values.iter().sum::<u64>(), case["input"].as_u64().unwrap());
            }
        }
    }

    #[test]
    fn tier_plans_match_the_vectors() {
        let vectors: Value = serde_json::from_str(VECTORS).unwrap();
        let small = hello_from(&vectors["hello"]);
        let reference = hello_from(&vectors["reference"]);
        let mut compared = 0;
        for case in vectors["allocations"].as_array().unwrap() {
            let hello = if case["hello"] == "reference" {
                &reference
            } else {
                &small
            };
            let pubkeys: Vec<Vec<u8>> = case["pubkeys"]
                .as_array()
                .unwrap()
                .iter()
                .map(|k| hex::decode(k.as_str().unwrap()).unwrap())
                .collect();
            let only = case.get("onlyTiers").filter(|v| !v.is_null()).map(u64s);
            let got = allocate_feasible_tiers(
                hello,
                case["sumIn"].as_u64().unwrap(),
                &pubkeys,
                &mut sequence(case["seed"].as_u64().unwrap() as u32),
                only.as_deref(),
            )
            .unwrap();
            let expected: BTreeMap<u64, TierAllocation> = case["plans"]
                .as_array()
                .unwrap()
                .iter()
                .map(|plan| {
                    (
                        plan["tier"].as_u64().unwrap(),
                        TierAllocation {
                            values: u64s(&plan["values"]),
                            excess_fee: plan["excessFee"].as_u64().unwrap(),
                            input_fees: plan["inputFees"].as_u64().unwrap(),
                        },
                    )
                })
                .collect();
            assert_eq!(got, expected, "{}", case["name"]);
            compared += expected.len();
        }
        assert!(compared >= 10, "the vectors exercise real plans");
    }

    #[test]
    fn every_plan_balances_and_respects_the_limits() {
        let vectors: Value = serde_json::from_str(VECTORS).unwrap();
        let hello = hello_from(&vectors["reference"]);
        let keys: Vec<Vec<u8>> = (1..=3u8)
            .map(|b| [vec![0x02], vec![b; 32]].concat())
            .collect();
        for seed in 0..50 {
            let plans =
                allocate_feasible_tiers(&hello, 17_972_595, &keys, &mut sequence(seed), None)
                    .unwrap();
            for (tier, plan) in plans {
                let output_fee = fee_per_output(hello.component_feerate).unwrap();
                let spent: u64 = plan.values.iter().sum::<u64>()
                    + plan.values.len() as u64 * output_fee
                    + plan.input_fees
                    + plan.excess_fee;
                assert_eq!(spent, 17_972_595, "tier {tier}");
                assert!(plan.values.iter().all(|v| *v >= MIN_OUTPUT));
                assert!(plan.excess_fee >= hello.min_excess_fee);
                assert!(keys.len() + plan.values.len() <= MAX_COMPONENTS);
            }
        }
    }

    #[test]
    fn output_draws_balance_and_respect_their_bounds() {
        assert_eq!(
            random_outputs_for_tier(&mut sequence(1), 99, 1000, 100, 5).unwrap(),
            None
        );
        for seed in 0..50 {
            for max in [3, 10] {
                let Some(values) =
                    random_outputs_for_tier(&mut sequence(seed), 500_000, 100_000, 10_170, max)
                        .unwrap()
                else {
                    continue;
                };
                assert_eq!(values.iter().sum::<u64>(), 500_000);
                assert!(values.len() <= max);
                assert!(values.iter().all(|v| *v >= 10_170));
            }
        }
    }

    fn pinning_hello() -> ExpectedHello {
        ExpectedHello {
            tiers: vec![10_000, 100_000, 1_000_000, 10_000_000],
            num_components: 23,
            component_feerate: 1000,
            min_excess_fee: 10,
            max_excess_fee: 300_000,
        }
    }

    /// Ten distinct keys. Electron Cash needs MIN_TX_COMPONENTS (11)
    /// components and min outputs = 11 - distinct inputs, so two inputs would
    /// need nine outputs, which no tier here allows.
    fn ten_keys() -> Vec<Vec<u8>> {
        (1..=10u8)
            .map(|b| [vec![0x02], vec![b; 32]].concat())
            .collect()
    }

    /// Two wallets with different amounts otherwise land in different pools
    /// and wait with nothing on screen saying why. Pinning makes them meet.
    #[test]
    fn pinning_registers_only_the_pinned_tier() {
        let hello = pinning_hello();
        let keys = ten_keys();
        let plan = |only: Option<&[u64]>| {
            allocate_feasible_tiers(&hello, 5_000_000, &keys, &mut || 0.5, only).unwrap()
        };
        let all = plan(None);
        assert!(!all.is_empty());
        let target = *all.keys().next().unwrap();
        assert_eq!(
            plan(Some(&[target])).keys().copied().collect::<Vec<_>>(),
            vec![target]
        );
        // Unfundable or unadvertised: nothing, never every tier instead.
        assert!(plan(Some(&[10_000_000])).is_empty());
        assert!(plan(Some(&[777])).is_empty());
        // An empty list is no preference.
        assert_eq!(plan(Some(&[])), all);
    }

    #[test]
    fn small_inputs_fund_only_the_small_tier() {
        let hello = ExpectedHello {
            tiers: vec![10_000, 100_000, 1_000_000],
            num_components: 23,
            component_feerate: 1000,
            min_excess_fee: 10,
            max_excess_fee: 10_000,
        };
        // Six distinct keys, 30k each: min outputs = 11 - 6 = 5.
        let keys: Vec<Vec<u8>> = (0..6u8)
            .map(|b| [vec![0x02, b], vec![0; 31]].concat())
            .collect();
        let plans = allocate_feasible_tiers(&hello, 180_000, &keys, &mut || 0.5, None).unwrap();
        assert!(plans.contains_key(&10_000));
        assert!(!plans.contains_key(&1_000_000));
        for plan in plans.values() {
            let spent = plan.input_fees
                + plan.values.len() as u64 * 34
                + plan.values.iter().sum::<u64>()
                + plan.excess_fee;
            assert_eq!(spent, 180_000);
            assert!((hello.min_excess_fee..=MAX_EXCESS_FEE).contains(&plan.excess_fee));
        }
    }

    #[test]
    fn a_contribution_plans_in_round_form() {
        let hello = pinning_hello();
        let inputs: Vec<(Vec<u8>, u64)> =
            ten_keys().into_iter().map(|key| (key, 500_000)).collect();
        let plans = plan_contribution(&hello, &inputs, None, &mut || 0.5).unwrap();
        let direct =
            allocate_feasible_tiers(&hello, 5_000_000, &ten_keys(), &mut || 0.5, None).unwrap();
        assert_eq!(
            plans,
            direct
                .into_iter()
                .map(|(tier, plan)| FusionTierPlan {
                    tier,
                    output_values: plan.values,
                    excess_fee: plan.excess_fee,
                })
                .collect::<Vec<_>>()
        );
        let wire = serde_json::to_value(&plans[0]).unwrap();
        assert!(wire.get("outputValues").is_some() && wire.get("excessFee").is_some());

        assert_eq!(
            plan_contribution(&hello, &inputs, Some(&[10_000_000, 777]), &mut || 0.5).unwrap_err(),
            "Selected inputs cannot fund the requested tier(s): 10000000, 777 sats."
        );
        assert_eq!(
            plan_contribution(&hello, &inputs[..1], None, &mut || 0.5).unwrap_err(),
            "Selected inputs cannot afford any fusion tier."
        );
    }

    #[test]
    fn a_contribution_is_refused_before_any_draw() {
        let never = &mut || -> f64 { panic!("drew a sample for a refused contribution") };
        let mut bad = pinning_hello();
        bad.component_feerate = 5_001;
        let inputs = vec![(ten_keys()[0].clone(), 1_000_000)];
        assert!(plan_contribution(&bad, &inputs, None, never)
            .unwrap_err()
            .contains("feerate"));
        let uncompressed = vec![(vec![0x04; 65], 1_000_000)];
        assert!(
            plan_contribution(&pinning_hello(), &uncompressed, None, never)
                .unwrap_err()
                .contains("compressed public key")
        );
        let overflow = vec![
            (ten_keys()[0].clone(), u64::MAX),
            (ten_keys()[1].clone(), 1),
        ];
        assert!(plan_contribution(&pinning_hello(), &overflow, None, never)
            .unwrap_err()
            .contains("overflow"));
        assert!(plan_contribution(&pinning_hello(), &[], None, never).is_err());
    }

    #[test]
    fn bad_samples_and_bad_keys_are_refused() {
        let hello = ExpectedHello {
            tiers: vec![1_000_000],
            num_components: 23,
            component_feerate: 1000,
            min_excess_fee: 29,
            max_excess_fee: 10_000,
        };
        let key = [vec![0x02], vec![7; 32]].concat();
        assert!(allocate_feasible_tiers(
            &hello,
            5_000_000,
            std::slice::from_ref(&key),
            &mut || 1.0,
            None
        )
        .is_err());
        assert!(
            allocate_feasible_tiers(&hello, 5_000_000, &[vec![0x04; 65]], &mut || 0.5, None)
                .unwrap()
                .is_empty()
        );
        let mut os = os_uniform();
        for _ in 0..1000 {
            let u = os();
            assert!((0.0..1.0).contains(&u));
        }
    }
}
