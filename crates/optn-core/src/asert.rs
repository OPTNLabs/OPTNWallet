//! Bitcoin Cash ASERT difficulty-adjustment primitives.
//!
//! Integer ASERTI3-2d follows the established Electron Cash/BCH algorithm. It
//! is separate from raw header PoW: a header can satisfy its own declared
//! `nBits` while still declaring the wrong network difficulty.

use crate::header_hash::Hash32;
use crate::header_pow::{
    parse_header, target_from_compact, verify_link, HeaderPowError, ParsedHeader, HEADER_LEN,
};
use crate::network::Network;
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

    /// Chipnet follows the testnet half-life, same as Electron Cash `ChipNet`.
    pub const fn for_network(network: Network) -> Self {
        match network {
            Network::Mainnet => Self::mainnet(),
            Network::Chipnet => Self::testnet(),
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

impl AsertAnchor {
    /// Published ASERTI3-2d anchors used by Electron Cash / BCHN.
    ///
    /// Mainnet: height 661647, bits 402971390, prev_time 1605447844.
    /// Chipnet (testnet4): height 16844, bits 486604799, prev_time 1605451779.
    pub const fn for_network(network: Network) -> Self {
        match network {
            Network::Mainnet => Self {
                height: 661_647,
                bits: 402_971_390,
                prev_time: 1_605_447_844,
            },
            Network::Chipnet => Self {
                height: 16_844,
                bits: 486_604_799,
                prev_time: 1_605_451_779,
            },
        }
    }
}

/// Previous-block context required to check the next header's expected `nBits`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AsertCheck {
    pub params: AsertParams,
    pub anchor: AsertAnchor,
    pub previous_height: u32,
    pub previous_time: i64,
}

impl AsertCheck {
    pub const fn applies(&self) -> bool {
        self.previous_height >= self.anchor.height
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderExtensionError {
    Pow(HeaderPowError),
    Difficulty(AsertError),
}

impl std::fmt::Display for HeaderExtensionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pow(error) => write!(f, "{error:?}"),
            Self::Difficulty(error) => write!(f, "{error:?}"),
        }
    }
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
    // Chipnet/testnet keep Bitcoin's 20-minute minimum-difficulty exception.
    // Electron Cash `blockchain.py` returns MAX_BITS when the gap exceeds
    // 20 minutes; a strict ASERT-only check would reject real Chipnet blocks.
    if params.half_life == TESTNET_HALF_LIFE {
        let gap = i64::from(parsed.time).saturating_sub(previous_time);
        if gap > 20 * 60 {
            if parsed.bits != params.max_bits {
                return Err(AsertError::UnexpectedBits {
                    expected: params.max_bits,
                    actual: parsed.bits,
                });
            }
            return Ok(parsed);
        }
    }
    let expected = next_bits(params, anchor, previous_height, previous_time)?;
    if parsed.bits != expected {
        return Err(AsertError::UnexpectedBits {
            expected,
            actual: parsed.bits,
        });
    }
    Ok(parsed)
}

/// Validate predecessor linkage, declared PoW, and (after the ASERT anchor)
/// the expected BCH difficulty transition. Callers that already have a trusted
/// checkpoint still have to attach [`AsertCheck`] for every locally extended
/// header; skipping it is how a linked easy-target chain gets accepted.
pub fn verify_header_extension(
    expected_prev: Hash32,
    header: &[u8; HEADER_LEN],
    difficulty: Option<AsertCheck>,
) -> Result<ParsedHeader, HeaderExtensionError> {
    if let Some(check) = difficulty.filter(AsertCheck::applies) {
        verify_expected_bits(
            check.params,
            check.anchor,
            check.previous_height,
            check.previous_time,
            header,
        )
        .map_err(HeaderExtensionError::Difficulty)?;
    }
    verify_link(expected_prev, header).map_err(HeaderExtensionError::Pow)
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
        u32::try_from(target.bits().div_ceil(8)).map_err(|_| AsertError::ArithmeticRange)?;
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

    #[test]
    fn published_network_anchors_match_electron_cash() {
        let main = AsertAnchor::for_network(Network::Mainnet);
        assert_eq!(main.height, 661_647);
        assert_eq!(main.bits, 402_971_390);
        assert_eq!(main.prev_time, 1_605_447_844);
        let chip = AsertAnchor::for_network(Network::Chipnet);
        assert_eq!(chip.height, 16_844);
        assert_eq!(chip.bits, 486_604_799);
        assert_eq!(chip.prev_time, 1_605_451_779);
        assert_eq!(AsertParams::for_network(Network::Chipnet).half_life, 3_600);
    }

    fn mine_header(prev: Hash32, time: u32, bits: u32) -> [u8; 80] {
        let mut header = [0u8; 80];
        header[0..4].copy_from_slice(&1u32.to_le_bytes());
        header[4..36].copy_from_slice(&prev);
        header[68..72].copy_from_slice(&time.to_le_bytes());
        header[72..76].copy_from_slice(&bits.to_le_bytes());
        for nonce in 0u32..50_000 {
            header[76..80].copy_from_slice(&nonce.to_le_bytes());
            if crate::header_pow::verify_declared_pow(&header).is_ok() {
                return header;
            }
        }
        panic!("could not mine a test header at bits {bits:#x}");
    }

    #[test]
    fn linked_easy_target_is_rejected_when_asert_applies() {
        use crate::header_pow::verify_declared_pow;

        let params = AsertParams {
            half_life: 172_800,
            ideal_block_time: 600,
            max_bits: 0x207f_ffff,
        };
        let anchor = AsertAnchor {
            height: 1,
            bits: 0x207f_ffff,
            prev_time: 0,
        };
        let prev = [7u8; 32];
        // Fast blocks pull the expected target below the proof-of-work floor.
        let expected = next_bits(params, anchor, 10, 10).unwrap();
        assert_ne!(
            expected, params.max_bits,
            "fixture must not sit at the floor"
        );

        let valid = mine_header(prev, 610, expected);
        let parsed = verify_header_extension(
            prev,
            &valid,
            Some(AsertCheck {
                params,
                anchor,
                previous_height: 10,
                previous_time: 10,
            }),
        )
        .unwrap();
        assert_eq!(parsed.bits, expected);
        assert!(verify_declared_pow(&valid).is_ok());

        let easy = mine_header(prev, 610, params.max_bits);
        assert!(
            verify_declared_pow(&easy).is_ok(),
            "the attack header must satisfy its own easy target"
        );
        let err = verify_header_extension(
            prev,
            &easy,
            Some(AsertCheck {
                params,
                anchor,
                previous_height: 10,
                previous_time: 10,
            }),
        )
        .unwrap_err();
        assert!(
            matches!(
                err,
                HeaderExtensionError::Difficulty(AsertError::UnexpectedBits { actual, .. })
                    if actual == params.max_bits
            ),
            "{err:?}"
        );
    }

    #[test]
    fn asert_does_not_apply_before_the_anchor() {
        let hex = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
        let header: [u8; 80] = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();
        verify_header_extension(
            [0u8; 32],
            &header,
            Some(AsertCheck {
                params: AsertParams::testnet(),
                anchor: AsertAnchor::for_network(Network::Chipnet),
                previous_height: 0,
                previous_time: 0,
            }),
        )
        .expect("pre-anchor genesis-era headers are linkage/PoW only");
    }

    fn header_from_hex(hex: &str) -> [u8; 80] {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>()
            .try_into()
            .unwrap()
    }

    #[test]
    fn chipnet_tip_headers_from_electrum_satisfy_asert() {
        // Consecutive Chipnet headers at height 322752 -> 322753, fetched from
        // chipnet.imaginary.cash `blockchain.block.header`. Height is past the
        // ASERT anchor (16844). The successor used the testnet 20-minute
        // min-difficulty exception (bits 0x1d00ffff).
        let prev = header_from_hex("00e0ff3fce8f6b81aa0ed30a9cf02730fd5c5c3d31e5ea79c50c908fa91200000000000059497c97770f494c32670e39a38a5f7282b6089c3713b8ee336d1cb9a9a0f5dafbdca06a45031a1aa04d838d");
        let cur = header_from_hex("0000ff3fdcd2ef553db3e4ef9ac52fcdd900c994a7c8829bdd9c1fdfcd0e00000000000065dfdfbf2166cb985df2ab752e52815440aad540359c80c172211163ccaf434dcee1a06affff001de4aba516");
        let prev_parsed = crate::header_pow::verify_declared_pow(&prev).unwrap();
        let cur_parsed = verify_header_extension(
            prev_parsed.hash,
            &cur,
            Some(AsertCheck {
                params: AsertParams::for_network(Network::Chipnet),
                anchor: AsertAnchor::for_network(Network::Chipnet),
                previous_height: 322_752,
                previous_time: i64::from(prev_parsed.time),
            }),
        )
        .expect("live Chipnet successor must pass the shipped extension check");
        assert_eq!(cur_parsed.bits, DEFAULT_MAX_BITS);
        assert_eq!(cur_parsed.prev_hash, prev_parsed.hash);
        assert!(i64::from(cur_parsed.time) - i64::from(prev_parsed.time) > 20 * 60);
    }
}
