// BIP37 merkleblock partial-merkle verification, extracted from legacy SPV.

use super::double_sha256;

#[derive(Debug, Clone)]
pub struct MerkleBlock {
    pub header: [u8; 80],
    pub valid: bool,
    pub matched_txids: Vec<[u8; 32]>,
}

struct PartialMerkle {
    total: u32,
    hashes: Vec<[u8; 32]>,
    flags: Vec<u8>,
    hash_idx: usize,
    bit_idx: usize,
    matched: Vec<[u8; 32]>,
    bad: bool,
}

fn tree_height(total: u32) -> u32 {
    let mut h = 0u32;
    while (1u32 << h) < total { h += 1; }
    h
}

impl PartialMerkle {
    fn width(&self, height: u32) -> u32 {
        (self.total + (1 << height) - 1) >> height
    }

    fn next_bit(&mut self) -> bool {
        let byte = self.bit_idx / 8;
        let off = self.bit_idx % 8;
        self.bit_idx += 1;
        match self.flags.get(byte) {
            Some(b) => (b >> off) & 1 == 1,
            None => { self.bad = true; false }
        }
    }

    fn next_hash(&mut self) -> [u8; 32] {
        match self.hashes.get(self.hash_idx) {
            Some(h) => { self.hash_idx += 1; *h }
            None => { self.bad = true; [0u8; 32] }
        }
    }

    fn traverse(&mut self, height: u32, pos: u32) -> [u8; 32] {
        let flag = self.next_bit();
        if height == 0 || !flag {
            let h = self.next_hash();
            if height == 0 && flag { self.matched.push(h); }
            return h;
        }
        let left = self.traverse(height - 1, pos * 2);
        let right = if pos * 2 + 1 < self.width(height - 1) {
            let r = self.traverse(height - 1, pos * 2 + 1);
            if r == left { self.bad = true; }
            r
        } else {
            left
        };
        let mut cat = [0u8; 64];
        cat[..32].copy_from_slice(&left);
        cat[32..].copy_from_slice(&right);
        double_sha256(&cat)
    }
}

pub fn parse_merkleblock(payload: &[u8]) -> Result<MerkleBlock, String> {
    let header: [u8; 80] = payload.get(0..80).ok_or("merkleblock shorter than a header")?.try_into().unwrap();
    let mut pos = 80usize;
    let total = super::read_u32(payload, &mut pos)?;
    if total == 0 { return Err("merkleblock with zero transactions".into()); }

    let hash_count = super::read_varint(payload, &mut pos)? as usize;
    let mut hashes = Vec::with_capacity(hash_count.min(1 << 16));
    for _ in 0..hash_count {
        hashes.push(super::take(payload, &mut pos, 32)?.try_into().unwrap());
    }
    let flag_len = super::read_varint(payload, &mut pos)? as usize;
    let flags = super::take(payload, &mut pos, flag_len)?.to_vec();

    let mut pm = PartialMerkle {
        total, hashes, flags, hash_idx: 0, bit_idx: 0, matched: Vec::new(), bad: false,
    };
    let root = pm.traverse(tree_height(total), 0);
    let all_hashes_used = pm.hash_idx == pm.hashes.len();
    let flag_bits_ok = pm.bit_idx.div_ceil(8) == pm.flags.len();
    let root_ok = root == header[36..68];
    Ok(MerkleBlock {
        header,
        valid: !pm.bad && all_hashes_used && flag_bits_ok && root_ok,
        matched_txids: pm.matched,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat(x: &[u8; 32], y: &[u8; 32]) -> [u8; 32] {
        let mut v = [0u8; 64];
        v[..32].copy_from_slice(x);
        v[32..].copy_from_slice(y);
        double_sha256(&v)
    }

    #[test]
    fn verifies_partial_tree_and_rejects_tamper() {
        let a = [1u8; 32]; let b = [2u8; 32]; let c = [3u8; 32]; let d = [4u8; 32];
        let root = cat(&cat(&a, &b), &cat(&c, &d));
        let mut header = [0u8; 80]; header[36..68].copy_from_slice(&root);
        let mut p = Vec::new();
        p.extend_from_slice(&header); p.extend_from_slice(&4u32.to_le_bytes());
        p.push(3); p.extend_from_slice(&a); p.extend_from_slice(&b); p.extend_from_slice(&cat(&c, &d));
        p.push(1); p.push(0x07);
        let mb = parse_merkleblock(&p).unwrap();
        assert!(mb.valid); assert_eq!(mb.matched_txids, vec![a]);
        p[36] ^= 1; assert!(!parse_merkleblock(&p).unwrap().valid);
    }
}
