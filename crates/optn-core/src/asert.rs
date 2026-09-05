//! Bitcoin Cash ASERT difficulty-adjustment primitives.
//!
//! Integer ASERTI3-2d follows the established Electron Cash/BCH algorithm. It
//! is separate from raw header PoW: a header can satisfy its own declared
//! `nBits` while still declaring the wrong network difficulty.

use crate::header_pow::{
    parse_header, target_from_compact, HeaderPowError, ParsedHeader, HEADER_LEN,
};
use num_bigint::BigUint;

const RBITS: i64 = 16;
const RADIX: i64 = 1 << RBITS;
pub const IDEAL_BLOCK_TIME: i64 = 10 * 60;
pub const MAINNET_HALF_LIFE: i64 = 2 * 24 * 60 * 60;
pub const TESTNET_HALF_LIFE: i64 = 60 * 60;
pub const DEFAULT_MAX_BITS: u32 = 0x1d00ffff;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AsertParams {
    pub half_life: i64,
    pub ideal_block_time: i64,
    pub max_bits: u32,
}

impl AsertParams {
    pub const fn mainnet() -> Self {
        Self {
            half_life: MAINNET_HALF_LIFE,
            ideal_block_time: IDEAL_BLOCK_TIME,
            max_bits: DEFAULT_MAX_BITS,
        }
    }

    pub const fn testnet() -> Self {
        Self {
            half_life: TESTNET_HALF_LIFE,
            ideal_block_time: IDEAL_BLOCK_TIME,
            max_bits: DEFAULT_MAX_BITS,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AsertAnchor {
    pub height: u32,
    pub bits: u32,
    /// Timestamp of the block immediately preceding the anchor block.
    pub prev_time: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AsertError {
    InvalidParams,
    InvalidAnchor(HeaderPowError),
    InvalidMaxTarget(HeaderPowError),
    ArithmeticRange,
    UnexpectedBits { expected: u32, actual: u32 },
}

/// Calculate the expected `nBits` for the block after `previous_height`.
///
/// This mirrors Electron Cash's call shape:
/// `next_bits(anchor.bits, previous_time-anchor.prev_time,
///            previous_height-anchor.height)`.
pub fn next_bits(
    params: AsertParams,
    anchor: AsertAnchor,
    previous_height: u32,
    previous_time: i64,
) -> Result<u32, AsertError> {
    if params.half_life <= 0 || params.ideal_block_time <= 0 {
        return Err(AsertError::InvalidParams);
    }
    let mut target = target_from_compact(anchor.bits).map_err(AsertError::InvalidAnchor)?;
    let max_target = target_from_compact(params.max_bits).map_err(AsertError::InvalidMaxTarget)?;

    let height_diff = i64::from(previous_height) - i64::from(anchor.height);
    let time_diff = previous_time
        .checked_sub(anchor.prev_time)
        .ok_or(AsertError::ArithmeticRange)?;
    let ideal = params
        .ideal_block_time
        .checked_mul(
            height_diff
                .checked_add(1)
                .ok_or(AsertError::ArithmeticRange)?,
        )
        .ok_or(AsertError::ArithmeticRange)?;
    let schedule_error = time_diff
        .checked_sub(ideal)
        .ok_or(AsertError::ArithmeticRange)?;

    // C++/Python reference semantics truncate signed integer division toward
    // zero. Use i128 for the fixed-point intermediate so hostile timestamps do
    // not overflow before we reject an out-of-range exponent.
    let scaled = i128::from(schedule_error)
        .checked_mul(i128::from(RADIX))
        .ok_or(AsertError::ArithmeticRange)?;
    let exponent_i128 = scaled / i128::from(params.half_life);
    let exponent = i64::try_from(exponent_i128).map_err(|_| AsertError::ArithmeticRange)?;

    let shifts = exponent >> RBITS;
    let fractional = exponent
        .checked_sub(
            shifts
                .checked_mul(RADIX)
                .ok_or(AsertError::ArithmeticRange)?,
        )
        .ok_or(AsertError::ArithmeticRange)?;
    if !(0..RADIX).contains(&fractional) {
        return Err(AsertError::ArithmeticRange);
    }

    let e = fractional as u128;
    let polynomial = 195_766_423_245_049u128
        .saturating_mul(e)
        .saturating_add(971_821_376u128.saturating_mul(e.saturating_mul(e)))
        .saturating_add(5_127u128.saturating_mul(e.saturating_mul(e).saturating_mul(e)))
        .saturating_add(1u128 << 47)
        >> (RBITS * 3);
    let factor = u64::try_from(u128::from(RADIX as u64) + polynomial)
        .map_err(|_| AsertError::ArithmeticRange)?;
    target *= factor;

    if shifts < 0 {
        let right = usize::try_from(-shifts).map_err(|_| AsertError::ArithmeticRange)?;
        target >>= right;
    } else {
        let left = usize::try_from(shifts).map_err(|_| AsertError::ArithmeticRange)?;
        // Avoid constructing absurdly large BigUints from adversarial dates.
        if left > 512 {
            return Ok(params.max_bits);
        }
        target <<= left;
    }
    target >>= RBITS as usize;

    if target == BigUint::from(0u8) {
        return target_to_compact(&BigUint::from(1u8), &max_target);
    }
    if target > max_target {
        return Ok(params.max_bits);
    }
    target_to_compact(&target, &max_target)
}

pub fn verify_expected_bits(
    params: AsertParams,
    anchor: AsertAnchor,
    previous_height: u32,
    previous_time: i64,
    header: &[u8; HEADER_LEN],
) -> Result<ParsedHeader, AsertError> {
    let parsed = parse_header(header);
    let expected = next_bits(params, anchor, previous_height, previous_time)?;
    if parsed.bits != expected {
        return Err(AsertError::UnexpectedBits {
            expected,
            actual: parsed.bits,
        });
    }
    Ok(parsed)
}

fn target_to_compact(target: &BigUint, max_target: &BigUint) -> Result<u32, AsertError> {
    let target = if target > max_target {
        max_target.clone()
    } else {
        target.clone()
    };
    if target == BigUint::from(0u8) {
        return Err(AsertError::ArithmeticRange);
    }

    let mut size =
        u32::try_from((target.bits() + 7) / 8).map_err(|_| AsertError::ArithmeticRange)?;
    let compact_value = if size <= 3 {
        target << (8 * (3 - size)) as usize
    } else {
        target >> (8 * (size - 3)) as usize
    };
    let bytes = compact_value.to_bytes_le();
    let mut compact = 0u32;
    for (index, byte) in bytes.iter().take(4).enumerate() {
        compact |= u32::from(*byte) << (8 * index);
    }
    if compact & 0x0080_0000 != 0 {
        compact >>= 8;
        size = size.checked_add(1).ok_or(AsertError::ArithmeticRange)?;
    }
    compact &= 0x007f_ffff;
    if size >= 256 {
        return Err(AsertError::ArithmeticRange);
    }
    Ok(compact | (size << 24))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steady_six_hundred_second_blocks_keep_arbitrary_target() {
        let params = AsertParams::mainnet();
        let anchor = AsertAnchor {
            height: 1,
            bits: 0x1a2b3c4d,
            prev_time: 0,
        };
        for (height, time) in [(1, 600), (2, 1200), (3, 1800), (10, 6000)] {
            assert_eq!(next_bits(params, anchor, height, time).unwrap(), 0x1a2b3c4d);
        }
    }

    #[test]
    fn steady_blocks_at_pow_limit_stay_at_pow_limit() {
        let params = AsertParams::mainnet();
        let anchor = AsertAnchor {
            height: 1,
            bits: 0x1d00ffff,
            prev_time: 0,
        };
        assert_eq!(next_bits(params, anchor, 10, 6000).unwrap(), 0x1d00ffff);
    }

    #[test]
    fn one_halflife_schedule_jump_doubles_minimum_target() {
        // Electron Cash test_asert.py reference vector.
        let params = AsertParams::mainnet();
        let anchor = AsertAnchor {
            height: 1,
            bits: 0x01010000,
            prev_time: 0,
        };
        assert_eq!(next_bits(params, anchor, 1, 173_400).unwrap(), 0x01020000);
        assert_eq!(next_bits(params, anchor, 2, 346_800).unwrap(), 0x01040000);
    }
}
