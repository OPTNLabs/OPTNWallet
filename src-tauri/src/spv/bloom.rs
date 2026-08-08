// BIP37 bloom filter — Phase 3 (first piece).
//
// An SPV client uploads a bloom filter of the scripts/outpoints it cares about;
// the node then returns only matching transactions (as merkleblocks), so the
// wallet never downloads the full chain. The filter is a bit array; each item is
// hashed nHashFuncs times with MurmurHash3(seed = i*0xFBA4C795 + nTweak) and the
// resulting bits set. Sizing follows BIP37's formulas from the target element
// count and false-positive rate.

const MAX_FILTER_SIZE: usize = 36_000; // BIP37 MAX_BLOOM_FILTER_SIZE (bytes)
const MAX_HASH_FUNCS: u32 = 50; // BIP37 MAX_HASH_FUNCS
const LN2: f64 = std::f64::consts::LN_2;

/// nFlags: how the node updates the filter as it matches (BIP37).
pub const BLOOM_UPDATE_ALL: u8 = 1;

/// 32-bit MurmurHash3 (x86_32), the hash BIP37 filters use.
fn murmur3_32(seed: u32, data: &[u8]) -> u32 {
    const C1: u32 = 0xcc9e_2d51;
    const C2: u32 = 0x1b87_3593;
    let mut h1 = seed;
    let nblocks = data.len() / 4;

    for i in 0..nblocks {
        let b = i * 4;
        let mut k1 = u32::from_le_bytes([data[b], data[b + 1], data[b + 2], data[b + 3]]);
        k1 = k1.wrapping_mul(C1);
        k1 = k1.rotate_left(15);
        k1 = k1.wrapping_mul(C2);
        h1 ^= k1;
        h1 = h1.rotate_left(13);
        h1 = h1.wrapping_mul(5).wrapping_add(0xe654_6b64);
    }

    let tail = &data[nblocks * 4..];
    let mut k1 = 0u32;
    if tail.len() >= 3 {
        k1 ^= (tail[2] as u32) << 16;
    }
    if tail.len() >= 2 {
        k1 ^= (tail[1] as u32) << 8;
    }
    if !tail.is_empty() {
        k1 ^= tail[0] as u32;
        k1 = k1.wrapping_mul(C1);
        k1 = k1.rotate_left(15);
        k1 = k1.wrapping_mul(C2);
        h1 ^= k1;
    }

    h1 ^= data.len() as u32;
    h1 ^= h1 >> 16;
    h1 = h1.wrapping_mul(0x85eb_ca6b);
    h1 ^= h1 >> 13;
    h1 = h1.wrapping_mul(0xc2b2_ae35);
    h1 ^= h1 >> 16;
    h1
}

pub struct BloomFilter {
    data: Vec<u8>,
    n_hash_funcs: u32,
    tweak: u32,
}

impl BloomFilter {
    /// Size the filter for `n_elements` with false-positive rate `fp_rate`
    /// (BIP37 formulas, clamped to the protocol maxima).
    pub fn new(n_elements: usize, fp_rate: f64, tweak: u32) -> Self {
        let n = (n_elements.max(1)) as f64;
        let size_bits = (-1.0 / (LN2 * LN2) * n * fp_rate.ln())
            .min((MAX_FILTER_SIZE * 8) as f64)
            .max(8.0);
        let size = ((size_bits / 8.0) as usize).clamp(1, MAX_FILTER_SIZE);
        let n_hash = ((size * 8) as f64 / n * LN2) as u32;
        let n_hash_funcs = n_hash.clamp(1, MAX_HASH_FUNCS);
        BloomFilter {
            data: vec![0u8; size],
            n_hash_funcs,
            tweak,
        }
    }

    fn bit_index(&self, i: u32, item: &[u8]) -> u32 {
        let seed = i.wrapping_mul(0xFBA4_C795).wrapping_add(self.tweak);
        murmur3_32(seed, item) % ((self.data.len() * 8) as u32)
    }

    pub fn insert(&mut self, item: &[u8]) {
        for i in 0..self.n_hash_funcs {
            let bit = self.bit_index(i, item);
            self.data[(bit >> 3) as usize] |= 1u8 << (bit & 7);
        }
    }

    pub fn contains(&self, item: &[u8]) -> bool {
        (0..self.n_hash_funcs).all(|i| {
            let bit = self.bit_index(i, item);
            self.data[(bit >> 3) as usize] & (1u8 << (bit & 7)) != 0
        })
    }

    /// `filterload` payload: varbytes(filter) + nHashFuncs(LE) + nTweak(LE) + nFlags.
    pub fn to_filterload_payload(&self, flags: u8) -> Vec<u8> {
        let mut p = Vec::with_capacity(self.data.len() + 12);
        super::write_varint(&mut p, self.data.len() as u64);
        p.extend_from_slice(&self.data);
        p.extend_from_slice(&self.n_hash_funcs.to_le_bytes());
        p.extend_from_slice(&self.tweak.to_le_bytes());
        p.push(flags);
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// The canonical BIP37 / Bitcoin Core test vector: 3 elements, fpRate 0.01,
    /// nTweak 0. The serialized filterload payload must equal
    /// 03614e9b050000000000000001.
    #[test]
    fn bip37_reference_vector() {
        let mut f = BloomFilter::new(3, 0.01, 0);
        f.insert(&hex("99108ad8ed9bb6274d3980bab5a85c048f0950c8"));
        assert!(f.contains(&hex("99108ad8ed9bb6274d3980bab5a85c048f0950c8")));
        // A one-bit-off item must NOT match.
        assert!(!f.contains(&hex("19108ad8ed9bb6274d3980bab5a85c048f0950c8")));
        f.insert(&hex("b5a2c786d9ef4658287ced5914b37a1b4aa32eee"));
        assert!(f.contains(&hex("b5a2c786d9ef4658287ced5914b37a1b4aa32eee")));
        f.insert(&hex("b9300670b4c5366e95b2699e8b18bc75e5f729c5"));
        assert!(f.contains(&hex("b9300670b4c5366e95b2699e8b18bc75e5f729c5")));

        let payload = f.to_filterload_payload(BLOOM_UPDATE_ALL);
        let got: String = payload.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(got, "03614e9b050000000000000001");
    }
}
