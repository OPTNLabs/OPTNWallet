//! How a peer splits its inputs into outputs (`nostr/fusionP2pAllocation.ts`).
//!
//! Two to six random-valued outputs, each on a grid that depends on the tier,
//! so different tiers look alike on chain. The peer pays only its own measured
//! share of the transaction's bytes; every other satoshi stays in outputs the
//! wallet controls.

use super::credentials::MAX_OUTPUT_CREDENTIALS_PER_PEER;

pub const DEFAULT_MIN_OUTPUT: u64 = 10_000;
const MAX_PARTICIPANTS: usize = 20;
const MAX_INPUTS_PER_PEER: usize = 20;
const TX_OVERHEAD_BYTES: f64 = 10.0;
const P2PKH_OUTPUT_BYTES: u64 = 34;
/// Fee fuzz stays under 0.5% of the fee and 500 sats.
const MAX_FEE_FUZZ_FRACTION: f64 = 0.005;
const MAX_FEE_FUZZ_SATS: u64 = 500;

/// The value grid for `tier` (`quantizationGrid`): 100 sats for small tiers,
/// a twentieth of the tier's power of ten above that.
pub fn quantization_grid(tier: u64) -> u64 {
    if tier == 0 {
        return 1;
    }
    let magnitude = 10f64.powi((tier as f64).log10().floor() as i32);
    100u64.max((magnitude / 20.0).round() as u64)
}

/// A planned split: output values and the fee this peer pays.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputPlan {
    pub values: Vec<u64>,
    pub fee_share: u64,
}

/// This peer's fee for its inputs, `outputs` P2PKH outputs and its share of
/// the transaction overhead.
fn local_fee_share(
    pubkey_lens: &[usize],
    outputs: usize,
    participants: usize,
    feerate: u64,
) -> u64 {
    let bytes = pubkey_lens
        .iter()
        .map(|len| 108.0 + *len as f64 / 2.0)
        .sum::<f64>()
        + (outputs as u64 * P2PKH_OUTPUT_BYTES) as f64
        + TX_OVERHEAD_BYTES / participants as f64;
    // `Math.ceil(bytes * feerate / 1000)` on a fractional byte count.
    (bytes * feerate as f64 / 1_000.0).ceil() as u64
}

/// Plan outputs for inputs given as `(value, pubkey hex length)`
/// (`planP2pOutputValues`). `random_unit` returns `[0, 1)`; production passes
/// the CSPRNG.
pub fn plan_output_values(
    inputs: &[(u64, usize)],
    participants: usize,
    feerate: u64,
    min_output: u64,
    tier: Option<u64>,
    mut random_unit: impl FnMut() -> f64,
) -> Result<OutputPlan, String> {
    if !(2..=MAX_PARTICIPANTS).contains(&participants) {
        return Err("invalid P2P Fusion participant count".into());
    }
    if !(1..=100_000).contains(&feerate) {
        return Err("invalid P2P Fusion fee rate".into());
    }
    if inputs.is_empty()
        || inputs.len() > MAX_INPUTS_PER_PEER
        || inputs.iter().any(|&(value, len)| value == 0 || len != 66)
    {
        return Err("invalid P2P Fusion input set".into());
    }
    if min_output < 546 {
        return Err("invalid P2P Fusion minimum output".into());
    }
    let sum_in: u64 = inputs.iter().map(|&(value, _)| value).sum();
    let pubkey_lens: Vec<usize> = inputs.iter().map(|&(_, len)| len).collect();
    let mut checked = || {
        let value = random_unit();
        if !(0.0..1.0).contains(&value) {
            return Err("invalid secure random sample".to_string());
        }
        Ok(value)
    };

    let max_outputs = (2..=MAX_OUTPUT_CREDENTIALS_PER_PEER)
        .rev()
        .find(|&count| {
            let fee = local_fee_share(&pubkey_lens, count, participants, feerate);
            sum_in.saturating_sub(fee) >= min_output * count as u64 && sum_in >= fee
        })
        .ok_or("Selected inputs cannot fund two Fusion outputs plus fee.")?;

    let count = 2 + (checked()? * (max_outputs - 1) as f64).floor() as usize;
    let fee_share = local_fee_share(&pubkey_lens, count, participants, feerate);

    let tier = tier.unwrap_or_else(|| inputs.iter().map(|&(value, _)| value).max().unwrap_or(0));
    let grid = quantization_grid(tier);
    let max_fuzz = ((fee_share as f64 * MAX_FEE_FUZZ_FRACTION).floor() as u64)
        .min(MAX_FEE_FUZZ_SATS)
        .min(grid);
    let headroom = sum_in.saturating_sub(fee_share + min_output * count as u64);
    let fuzz_budget = max_fuzz.min(headroom);
    let fee_fuzz = if fuzz_budget > 0 {
        (checked()? * fuzz_budget as f64).floor() as u64
    } else {
        0
    };
    let fuzzed_fee = fee_share + fee_fuzz;
    let output_total = sum_in - fuzzed_fee;
    let distributable = output_total.saturating_sub(min_output * count as u64);
    let weights = (0..count)
        .map(|_| checked().map(|unit| unit + 0.1))
        .collect::<Result<Vec<f64>, String>>()?;
    let weight_total: f64 = weights.iter().sum();
    let mut values: Vec<u64> = weights
        .iter()
        .map(|weight| {
            min_output
                + ((weight / weight_total * distributable as f64) / grid as f64).floor() as u64
                    * grid
        })
        .collect();
    let used: u64 = values.iter().sum();
    let remainder = (checked()? * count as f64).floor() as usize;
    values[remainder] += output_total - used;
    Ok(OutputPlan {
        values,
        fee_share: fuzzed_fee,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grids_scale_with_the_tier() {
        assert_eq!(quantization_grid(10_000), 500);
        assert_eq!(quantization_grid(100_000), 5_000);
        assert_eq!(quantization_grid(1_000), 100);
        assert_eq!(quantization_grid(0), 1);
    }

    #[test]
    fn a_plan_spends_exactly_the_inputs_minus_its_fee() {
        let mut state = 0x1234_5678_u64;
        let mut rng = move || {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            (state >> 11) as f64 / (1u64 << 53) as f64
        };
        for _ in 0..200 {
            let plan = plan_output_values(
                &[(250_000, 66), (90_000, 66)],
                6,
                1_000,
                DEFAULT_MIN_OUTPUT,
                Some(100_000),
                &mut rng,
            )
            .unwrap();
            assert!((2..=6).contains(&plan.values.len()));
            assert!(plan.values.iter().all(|&value| value >= DEFAULT_MIN_OUTPUT));
            assert_eq!(plan.values.iter().sum::<u64>() + plan.fee_share, 340_000);
        }
    }

    #[test]
    fn too_little_to_split_is_refused() {
        assert!(
            plan_output_values(&[(15_000, 66)], 6, 1_000, DEFAULT_MIN_OUTPUT, None, || 0.5)
                .is_err()
        );
        assert!(
            plan_output_values(&[(15_000, 64)], 6, 1_000, DEFAULT_MIN_OUTPUT, None, || 0.5)
                .is_err()
        );
    }
}
