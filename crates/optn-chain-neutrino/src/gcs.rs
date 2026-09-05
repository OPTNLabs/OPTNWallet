//! bchd committed-filter (GCS) decoder/matcher.
//!
//! Parameters match `bchutil/gcs/builder`: P=19, M=784931, SipHash-2-4 with
//! the first 16 bytes of the block hash as a little-endian key.

use siphasher::sip::SipHasher24;
use std::hash::Hasher;

pub const BASIC_P: u8 = 19;
pub const BASIC_M: u64 = 784_931;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GcsError {
    Truncated,
    InvalidCount,
    Overflow,
}

#[derive(Debug, Clone)]
pub struct GcsFilter {
    n: u32,
    data: Vec<u8>,
}

impl GcsFilter {
    pub fn from_nbytes(encoded: &[u8]) -> Result<Self, GcsError> {
        let mut pos = 0usize;
        let n = read_varint(encoded, &mut pos)?;
        let n = u32::try_from(n).map_err(|_| GcsError::InvalidCount)?;
        Ok(Self { n, data: encoded.get(pos..).ok_or(GcsError::Truncated)?.to_vec() })
    }

    pub const fn len(&self) -> u32 { self.n }
    pub const fn is_empty(&self) -> bool { self.n == 0 }

    pub fn match_any(&self, block_hash: &[u8; 32], items: &[Vec<u8>]) -> Result<bool, GcsError> {
        if self.n == 0 || items.is_empty() { return Ok(false); }
        let modulus = u64::from(self.n).checked_mul(BASIC_M).ok_or(GcsError::Overflow)?;
        let mut values = items
            .iter()
            .map(|item| fast_reduce(siphash24(block_hash, item), modulus))
            .collect::<Vec<_>>();
        values.sort_unstable();
        values.dedup();

        let mut reader = BitReader::new(&self.data);
        let mut filter_value = 0u64;
        let mut query_index = 0usize;

        for _ in 0..self.n {
            let delta = read_delta(&mut reader, BASIC_P)?;
            filter_value = filter_value.checked_add(delta).ok_or(GcsError::Overflow)?;
            while query_index < values.len() && values[query_index] < filter_value {
                query_index += 1;
            }
            if query_index == values.len() { return Ok(false); }
            if values[query_index] == filter_value { return Ok(true); }
        }
        Ok(false)
    }
}

fn siphash24(block_hash: &[u8; 32], data: &[u8]) -> u64 {
    let k0 = u64::from_le_bytes(block_hash[..8].try_into().expect("fixed slice"));
    let k1 = u64::from_le_bytes(block_hash[8..16].try_into().expect("fixed slice"));
    let mut hasher = SipHasher24::new_with_keys(k0, k1);
    hasher.write(data);
    hasher.finish()
}

fn fast_reduce(value: u64, modulus: u64) -> u64 {
    ((u128::from(value) * u128::from(modulus)) >> 64) as u64
}

fn read_delta(reader: &mut BitReader<'_>, p: u8) -> Result<u64, GcsError> {
    let mut quotient = 0u64;
    while reader.read_bit()? {
        quotient = quotient.checked_add(1).ok_or(GcsError::Overflow)?;
    }
    let remainder = reader.read_bits(p)?;
    quotient
        .checked_shl(u32::from(p))
        .and_then(|value| value.checked_add(remainder))
        .ok_or(GcsError::Overflow)
}

struct BitReader<'a> {
    bytes: &'a [u8],
    bit: usize,
}

impl<'a> BitReader<'a> {
    const fn new(bytes: &'a [u8]) -> Self { Self { bytes, bit: 0 } }

    fn read_bit(&mut self) -> Result<bool, GcsError> {
        let byte = *self.bytes.get(self.bit / 8).ok_or(GcsError::Truncated)?;
        let shift = 7 - (self.bit % 8);
        self.bit += 1;
        Ok((byte & (1 << shift)) != 0)
    }

    fn read_bits(&mut self, count: u8) -> Result<u64, GcsError> {
        let mut value = 0u64;
        for _ in 0..count {
            value = (value << 1) | if self.read_bit()? { 1 } else { 0 };
        }
        Ok(value)
    }
}

fn read_varint(data: &[u8], pos: &mut usize) -> Result<u64, GcsError> {
    let first = *data.get(*pos).ok_or(GcsError::Truncated)?;
    *pos += 1;
    match first {
        0xfd => {
            let bytes = take(data, pos, 2)?;
            Ok(u64::from(u16::from_le_bytes(bytes.try_into().expect("fixed slice"))))
        }
        0xfe => {
            let bytes = take(data, pos, 4)?;
            Ok(u64::from(u32::from_le_bytes(bytes.try_into().expect("fixed slice"))))
        }
        0xff => {
            let bytes = take(data, pos, 8)?;
            Ok(u64::from_le_bytes(bytes.try_into().expect("fixed slice")))
        }
        value => Ok(u64::from(value)),
    }
}

fn take<'a>(data: &'a [u8], pos: &mut usize, len: usize) -> Result<&'a [u8], GcsError> {
    let end = pos.checked_add(len).ok_or(GcsError::Overflow)?;
    let value = data.get(*pos..end).ok_or(GcsError::Truncated)?;
    *pos = end;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn siphash_matches_standard_empty_vector() {
        let mut key = [0u8; 32];
        for (index, byte) in key[..16].iter_mut().enumerate() { *byte = index as u8; }
        assert_eq!(siphash24(&key, &[]), 0x726f_db47_dd0e_0e31);
    }

    #[test]
    fn empty_filter_never_matches() {
        let filter = GcsFilter::from_nbytes(&[0]).unwrap();
        assert!(filter.is_empty());
        assert!(!filter.match_any(&[0; 32], &[b"x".to_vec()]).unwrap());
    }

    #[test]
    fn truncated_filter_is_rejected_while_decoding_values() {
        let filter = GcsFilter::from_nbytes(&[1]).unwrap();
        assert_eq!(filter.match_any(&[0; 32], &[b"x".to_vec()]), Err(GcsError::Truncated));
    }
}
