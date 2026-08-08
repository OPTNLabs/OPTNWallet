// BIP37 merkleblock — partial merkle tree parse + verification (Phase 3b).
//
// When a bloom filter matches, a node returns a `merkleblock`: the 80-byte block
// header, the total tx count, and a PARTIAL merkle tree (a list of hashes + a
// bit-flag stream) that proves which transactions matched without sending the
// whole block. We re-walk that tree, recompute the merkle root, and check it
// equals the header's root — that is the SPV proof a matched tx is really in the
// block. Includes the CVE-2012-2459 guard: an internal node whose two children
// hash to the same value is a malleability attack and is rejected.

use super::double_sha256;

/// Result of verifying a merkleblock's partial merkle tree.
pub struct MerkleBlock {
    /// The raw 80-byte block header (its merkle root is what we verified against).
    pub header: [u8; 80],
    /// True iff the reconstructed root equals the header's root and the proof is
    /// well-formed (no malleability, all hashes/bits consumed).
    pub valid: bool,
    /// Matched transaction ids (internal little-endian byte order).
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

/// Height of the merkle tree for `total` transactions.
fn tree_height(total: u32) -> u32 {
    let mut h = 0u32;
    while (1u32 << h) < total {
        h += 1;
    }
    h
}

impl PartialMerkle {
    /// Number of nodes at a given height (width narrows as height increases).
    fn width(&self, height: u32) -> u32 {
        (self.total + (1 << height) - 1) >> height
    }

    fn next_bit(&mut self) -> bool {
        let byte = self.bit_idx / 8;
        let off = self.bit_idx % 8;
        self.bit_idx += 1;
        match self.flags.get(byte) {
            Some(b) => (b >> off) & 1 == 1,
            None => {
                self.bad = true;
                false
            }
        }
    }

    fn next_hash(&mut self) -> [u8; 32] {
        match self.hashes.get(self.hash_idx) {
            Some(h) => {
                self.hash_idx += 1;
                *h
            }
            None => {
                self.bad = true;
                [0u8; 32]
            }
        }
    }

    /// Depth-first walk (BIP37): a flag bit decides each node. At a leaf, or at
    /// any node whose flag is 0, the hash is taken from the list; an internal
    /// node with flag 1 is recomputed from its children. Matched leaves (flag 1,
    /// height 0) are collected.
    fn traverse(&mut self, height: u32, pos: u32) -> [u8; 32] {
        let flag = self.next_bit();
        if height == 0 || !flag {
            let h = self.next_hash();
            if height == 0 && flag {
                self.matched.push(h);
            }
            return h;
        }
        let left = self.traverse(height - 1, pos * 2);
        let right = if pos * 2 + 1 < self.width(height - 1) {
            let r = self.traverse(height - 1, pos * 2 + 1);
            // CVE-2012-2459: a genuine right child must not duplicate the left.
            if r == left {
                self.bad = true;
            }
            r
        } else {
            // Odd node at this level: Bitcoin duplicates the last hash.
            left
        };
        let mut cat = [0u8; 64];
        cat[..32].copy_from_slice(&left);
        cat[32..].copy_from_slice(&right);
        double_sha256(&cat)
    }
}

/// Parse and verify a `merkleblock` payload.
pub fn parse_merkleblock(payload: &[u8]) -> Result<MerkleBlock, String> {
    let header: [u8; 80] = payload
        .get(0..80)
        .ok_or("merkleblock shorter than a header")?
        .try_into()
        .unwrap();
    let mut pos = 80usize;
    let total = super::read_u32(payload, &mut pos)?;
    if total == 0 {
        return Err("merkleblock with zero transactions".into());
    }

    let hash_count = super::read_varint(payload, &mut pos)? as usize;
    let mut hashes = Vec::with_capacity(hash_count.min(1 << 16));
    for _ in 0..hash_count {
        let h: [u8; 32] = super::take(payload, &mut pos, 32)?.try_into().unwrap();
        hashes.push(h);
    }
    let flag_len = super::read_varint(payload, &mut pos)? as usize;
    let flags = super::take(payload, &mut pos, flag_len)?.to_vec();

    let mut pm = PartialMerkle {
        total,
        hashes,
        flags,
        hash_idx: 0,
        bit_idx: 0,
        matched: Vec::new(),
        bad: false,
    };
    let root = pm.traverse(tree_height(total), 0);

    // A well-formed proof consumes every hash, and only trailing pad bits of the
    // flag stream may remain. The reconstructed root must equal the header's.
    let all_hashes_used = pm.hash_idx == pm.hashes.len();
    let flag_bits_ok = pm.bit_idx.div_ceil(8) == pm.flags.len();
    let root_ok = root == header[36..68];
    let valid = !pm.bad && all_hashes_used && flag_bits_ok && root_ok;

    Ok(MerkleBlock {
        header,
        valid,
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

    // Build a 4-tx block, prove that tx `a` (index 0) is included, and verify the
    // partial tree reconstructs the header's merkle root and reports the match.
    fn four_tx_proof_of_a() -> (Vec<u8>, [u8; 32]) {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let c = [3u8; 32];
        let d = [4u8; 32];
        let ab = cat(&a, &b);
        let cd = cat(&c, &d);
        let root = cat(&ab, &cd);

        let mut header = [0u8; 80];
        header[36..68].copy_from_slice(&root);

        // Depth-first flags for matching only `a`:
        //   root=1, left(ab)=1, a=1(match), b=0, right(cd)=0  -> bits 1,1,1,0,0
        // => byte 0b0000_0111 = 0x07. Hashes provided: a, b, cd.
        let mut p = Vec::new();
        p.extend_from_slice(&header);
        p.extend_from_slice(&4u32.to_le_bytes());
        p.push(3); // hash count
        p.extend_from_slice(&a);
        p.extend_from_slice(&b);
        p.extend_from_slice(&cd);
        p.push(1); // flag byte count
        p.push(0x07);
        (p, a)
    }

    #[test]
    fn verifies_root_and_reports_match() {
        let (payload, a) = four_tx_proof_of_a();
        let mb = parse_merkleblock(&payload).unwrap();
        assert!(
            mb.valid,
            "valid proof should verify against the header root"
        );
        assert_eq!(mb.matched_txids, vec![a]);
    }

    #[test]
    fn rejects_tampered_root() {
        let (mut payload, _) = four_tx_proof_of_a();
        payload[36] ^= 0x01; // corrupt one byte of the header's merkle root
        let mb = parse_merkleblock(&payload).unwrap();
        assert!(!mb.valid, "a root mismatch must not verify");
    }
}
