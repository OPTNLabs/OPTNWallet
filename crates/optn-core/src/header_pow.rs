//! Pure BCH block-header validation primitives.
//!
//! This module validates serialization, previous-hash linkage and that a header
//! hash satisfies the target encoded in its own `nBits`. Network-specific
//! difficulty-transition/ASERT validation is deliberately a separate concern;
//! callers must not equate `DeclaredPowValid` with a fully validated BCH chain.

use crate::header_hash::{sha256d, Hash32};
use num_bigint::BigUint;

pub const HEADER_LEN: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParsedHeader {
    pub hash: Hash32,
    pub prev_hash: Hash32,
    pub time: u32,
    pub bits: u32,
    pub nonce: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderPowError {
    NegativeTarget,
    ZeroTarget,
    TargetOverflow,
    InsufficientWork,
    LinkMismatch { expected: Hash32, actual: Hash32 },
}

pub fn parse_header(header: &[u8; HEADER_LEN]) -> ParsedHeader {
    let mut prev_hash = [0u8; 32];
    prev_hash.copy_from_slice(&header[4..36]);
    ParsedHeader {
        hash: sha256d(header),
        prev_hash,
        time: u32::from_le_bytes(header[68..72].try_into().expect("fixed header slice")),
        bits: u32::from_le_bytes(header[72..76].try_into().expect("fixed header slice")),
        nonce: u32::from_le_bytes(header[76..80].try_into().expect("fixed header slice")),
    }
}

/// Decode Bitcoin compact target (`nBits`). Reject negative, zero, or >256-bit
/// targets instead of silently normalizing malformed encodings.
pub fn target_from_compact(bits: u32) -> Result<BigUint, HeaderPowError> {
    let exponent = (bits >> 24) as u32;
    let mantissa = bits & 0x007f_ffff;
    if bits & 0x0080_0000 != 0 {
        return Err(HeaderPowError::NegativeTarget);
    }
    if mantissa == 0 {
        return Err(HeaderPowError::ZeroTarget);
    }

    let mut target = BigUint::from(mantissa);
    if exponent <= 3 {
        target >>= 8 * (3 - exponent);
    } else {
        target <<= 8 * (exponent - 3);
    }
    if target.bits() > 256 {
        return Err(HeaderPowError::TargetOverflow);
    }
    if target == BigUint::from(0u8) {
        return Err(HeaderPowError::ZeroTarget);
    }
    Ok(target)
}

/// Verify the header hash is <= the target declared by the header itself.
pub fn verify_declared_pow(header: &[u8; HEADER_LEN]) -> Result<ParsedHeader, HeaderPowError> {
    let parsed = parse_header(header);
    let target = target_from_compact(parsed.bits)?;
    // Bitcoin uint256 comparison interprets the digest bytes as little-endian.
    let hash_value = BigUint::from_bytes_le(&parsed.hash);
    if hash_value > target {
        return Err(HeaderPowError::InsufficientWork);
    }
    Ok(parsed)
}

pub fn verify_link(
    expected_prev_hash: Hash32,
    header: &[u8; HEADER_LEN],
) -> Result<ParsedHeader, HeaderPowError> {
    let parsed = verify_declared_pow(header)?;
    if parsed.prev_hash != expected_prev_hash {
        return Err(HeaderPowError::LinkMismatch {
            expected: expected_prev_hash,
            actual: parsed.prev_hash,
        });
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mainnet_genesis() -> [u8; 80] {
        let hex = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>();
        bytes.try_into().unwrap()
    }

    #[test]
    fn mainnet_genesis_satisfies_declared_pow() {
        let parsed = verify_declared_pow(&mainnet_genesis()).unwrap();
        assert_eq!(parsed.bits, 0x1d00ffff);
        assert_eq!(
            parsed.hash,
            [
                0x6f, 0xe2, 0x8c, 0x0a, 0xb6, 0xf1, 0xb3, 0x72, 0xc1, 0xa6, 0xa2, 0x46,
                0xae, 0x63, 0xf7, 0x4f, 0x93, 0x1e, 0x83, 0x65, 0xe1, 0x5a, 0x08, 0x9c,
                0x68, 0xd6, 0x19, 0x00, 0x00, 0x00, 0x00, 0x00,
            ]
        );
    }

    #[test]
    fn malformed_negative_target_is_rejected() {
        assert_eq!(
            target_from_compact(0x1d80ffff),
            Err(HeaderPowError::NegativeTarget)
        );
    }

    #[test]
    fn wrong_link_is_rejected_even_when_pow_is_valid() {
        let err = verify_link([1; 32], &mainnet_genesis()).unwrap_err();
        assert!(matches!(err, HeaderPowError::LinkMismatch { .. }));
    }
}
