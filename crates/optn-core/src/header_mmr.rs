//! Simplified Header Verification (SHV) Merkle-Mountain-Range accumulator.
//!
//! This is a Rust port of the accumulator semantics used by
//! `A60AB5450353F40E/mmr-accumulator` commit
//! `231c426cd0cdebe05aff13fcddd9103e8a09fb3c`, referenced by the Electron Cash
//! `mmr4` checkpoint-extension work. It intentionally contains no networking,
//! persistence, Tauri, or UI code.

use sha2::{Digest, Sha256};

pub type Hash32 = [u8; 32];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MmrError {
    PeakCountMismatch { expected: usize, actual: usize },
    InvalidSerializedLength { expected: usize, actual: usize },
    SerializationTooShort(usize),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MmrAccumulator {
    leaf_count: u64,
    /// Peaks ordered tallest to shortest (left to right in the tree).
    peaks: Vec<Hash32>,
}

impl MmrAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_parts(leaf_count: u64, peaks: Vec<Hash32>) -> Result<Self, MmrError> {
        let expected = leaf_count.count_ones() as usize;
        if peaks.len() != expected {
            return Err(MmrError::PeakCountMismatch {
                expected,
                actual: peaks.len(),
            });
        }
        Ok(Self { leaf_count, peaks })
    }

    pub const fn leaf_count(&self) -> u64 {
        self.leaf_count
    }

    pub fn peak_count(&self) -> usize {
        self.peaks.len()
    }

    pub fn peaks(&self) -> &[Hash32] {
        &self.peaks
    }

    pub const fn is_empty(&self) -> bool {
        self.leaf_count == 0
    }

    pub fn clear(&mut self) {
        self.leaf_count = 0;
        self.peaks.clear();
    }

    /// Append a validated leaf hash. The number of merges is the count of
    /// trailing one bits in the current leaf count.
    pub fn extend(&mut self, leaf: Hash32) {
        let merge_count = self.leaf_count.trailing_ones();
        let mut current = leaf;
        for _ in 0..merge_count {
            let left = self
                .peaks
                .pop()
                .expect("MMR peak invariant: trailing-one merge requires a peak");
            current = sha256d_pair(&left, &current);
        }
        self.peaks.push(current);
        self.leaf_count = self
            .leaf_count
            .checked_add(1)
            .expect("MMR leaf count overflow");
    }

    /// Bitcoin-style Merkle root produced by bagging the MMR peaks from the
    /// shortest/rightmost peak toward the tallest/leftmost peak, duplicating
    /// nodes as necessary to equalize heights.
    pub fn root(&self) -> Hash32 {
        if self.leaf_count == 0 {
            return [0; 32];
        }
        if self.peaks.len() == 1 {
            return self.peaks[0];
        }

        let mut current = *self
            .peaks
            .last()
            .expect("non-empty MMR must have at least one peak");
        let mut remaining = self.leaf_count;
        let mut height = countr_zero(remaining);

        for i in (1..self.peaks.len()).rev() {
            remaining &= remaining - 1;
            let next_height = countr_zero(remaining);
            while height < next_height {
                current = sha256d_pair(&current, &current);
                height += 1;
            }
            current = sha256d_pair(&self.peaks[i - 1], &current);
            height += 1;
        }
        current
    }

    /// Verify a proof only to the trusted peak containing `leaf_index`.
    pub fn verify_proof_to_peak(&self, leaf_index: u64, leaf: Hash32, siblings: &[Hash32]) -> bool {
        if leaf_index >= self.leaf_count {
            return false;
        }

        let mut remaining = self.leaf_count;
        let mut mountain_start = 0u64;
        let mut mountain_height = 0u32;
        let mut peak_index = 0usize;

        while remaining > 0 {
            mountain_height = bit_width(remaining) - 1;
            let mountain_size = 1u64 << mountain_height;
            if leaf_index < mountain_start + mountain_size {
                break;
            }
            mountain_start += mountain_size;
            remaining -= mountain_size;
            peak_index += 1;
        }

        if siblings.len() != mountain_height as usize || peak_index >= self.peaks.len() {
            return false;
        }

        let mut current = leaf;
        let mut idx = leaf_index;
        for sibling in siblings {
            current = if idx & 1 == 1 {
                sha256d_pair(sibling, &current)
            } else {
                sha256d_pair(&current, sibling)
            };
            idx >>= 1;
        }

        current == self.peaks[peak_index]
    }

    /// Verify a full proof against the bagged root.
    ///
    /// The left-sibling duplicate rejection is the CVE-2012-2459 ambiguity
    /// protection used by the reference accumulator. Legitimate duplication
    /// produced while bagging appears as a right sibling.
    pub fn verify_proof_to_root(&self, leaf_index: u64, leaf: Hash32, siblings: &[Hash32]) -> bool {
        if leaf_index >= self.leaf_count {
            return false;
        }
        if self.leaf_count == 1 {
            return siblings.is_empty() && self.peaks.first() == Some(&leaf);
        }

        let expected_length = bit_width(self.leaf_count - 1) as usize;
        if siblings.len() != expected_length {
            return false;
        }

        let mut current = leaf;
        let mut idx = leaf_index;
        for sibling in siblings {
            if idx & 1 == 1 && sibling == &current {
                return false;
            }
            current = if idx & 1 == 1 {
                sha256d_pair(sibling, &current)
            } else {
                sha256d_pair(&current, sibling)
            };
            idx >>= 1;
        }
        current == self.root()
    }

    /// Bootstrap the accumulator from the proof-to-root for the last leaf.
    /// Returns `None` for malformed or structurally ambiguous proofs.
    pub fn bootstrap_from_last_leaf_proof(
        leaf_count: u64,
        last_leaf: Hash32,
        siblings: &[Hash32],
    ) -> Option<Self> {
        if leaf_count == 0 {
            return siblings.is_empty().then(Self::new);
        }
        if leaf_count == 1 {
            return siblings
                .is_empty()
                .then(|| Self::from_parts(1, vec![last_leaf]).ok())
                .flatten();
        }

        let expected_length = bit_width(leaf_count - 1) as usize;
        if siblings.len() != expected_length {
            return None;
        }

        let peak_count = leaf_count.count_ones() as usize;
        let mut peaks = vec![None; peak_count];
        let mut remaining = leaf_count;
        let mut proof_idx = 0usize;
        let mut peak_idx = peak_count;
        let mut current_height = 0u32;
        let mut computed = last_leaf;
        let mut idx = leaf_count - 1;

        while remaining > 0 {
            let peak_height = countr_zero(remaining);

            while current_height < peak_height {
                let sibling = *siblings.get(proof_idx)?;
                if idx & 1 == 1 && sibling == computed {
                    return None;
                }
                computed = if idx & 1 == 1 {
                    sha256d_pair(&sibling, &computed)
                } else {
                    sha256d_pair(&computed, &sibling)
                };
                idx >>= 1;
                proof_idx += 1;
                current_height += 1;
            }

            peak_idx = peak_idx.checked_sub(1)?;
            if peak_height == 0 && peak_idx == peak_count - 1 {
                peaks[peak_idx] = Some(last_leaf);
            } else if proof_idx < siblings.len() {
                let sibling = siblings[proof_idx];
                peaks[peak_idx] = Some(sibling);
                if idx & 1 == 1 && sibling == computed {
                    return None;
                }
                computed = if idx & 1 == 1 {
                    sha256d_pair(&sibling, &computed)
                } else {
                    sha256d_pair(&computed, &sibling)
                };
                idx >>= 1;
                proof_idx += 1;
                current_height += 1;
            } else {
                peaks[peak_idx] = Some(computed);
            }
            remaining &= remaining - 1;
        }

        if proof_idx != siblings.len() || peak_idx != 0 {
            return None;
        }
        let peaks = peaks.into_iter().collect::<Option<Vec<_>>>()?;
        let accumulator = Self::from_parts(leaf_count, peaks).ok()?;
        accumulator
            .verify_proof_to_root(leaf_count - 1, last_leaf, siblings)
            .then_some(accumulator)
    }

    /// 8-byte little-endian leaf count followed by 32-byte peaks.
    pub fn serialize(&self) -> Vec<u8> {
        let mut result = Vec::with_capacity(8 + self.peaks.len() * 32);
        result.extend_from_slice(&self.leaf_count.to_le_bytes());
        for peak in &self.peaks {
            result.extend_from_slice(peak);
        }
        result
    }

    pub fn deserialize(data: &[u8]) -> Result<Self, MmrError> {
        if data.len() < 8 {
            return Err(MmrError::SerializationTooShort(data.len()));
        }
        let mut count_bytes = [0u8; 8];
        count_bytes.copy_from_slice(&data[..8]);
        let leaf_count = u64::from_le_bytes(count_bytes);
        let peak_count = leaf_count.count_ones() as usize;
        let expected = 8 + peak_count * 32;
        if data.len() != expected {
            return Err(MmrError::InvalidSerializedLength {
                expected,
                actual: data.len(),
            });
        }
        let peaks = data[8..]
            .chunks_exact(32)
            .map(|chunk| {
                let mut hash = [0u8; 32];
                hash.copy_from_slice(chunk);
                hash
            })
            .collect();
        Self::from_parts(leaf_count, peaks)
    }
}

fn sha256d_pair(left: &Hash32, right: &Hash32) -> Hash32 {
    let mut first = Sha256::new();
    first.update(left);
    first.update(right);
    let first = first.finalize();
    let second = Sha256::digest(first);
    second.into()
}

const fn bit_width(value: u64) -> u32 {
    u64::BITS - value.leading_zeros()
}

const fn countr_zero(value: u64) -> u32 {
    if value == 0 {
        u64::BITS
    } else {
        value.trailing_zeros()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(value: u8) -> Hash32 {
        [value; 32]
    }

    fn hex(hash: Hash32) -> String {
        hash.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn reference_roots_match_bitcoincashautist_accumulator() {
        let expected = [
            (
                1u64,
                "0101010101010101010101010101010101010101010101010101010101010101",
            ),
            (
                2,
                "39ce20bede82c96b8908bec4a157b09c549b3db90b9b474bda9ae9b9030310b4",
            ),
            (
                3,
                "223e023fadf1f053df26988871f893c821c28edf77d64a955e6c2a02d547bdac",
            ),
            (
                4,
                "085aabaef98668701b87c9a1986bdf116726a9949802326b69895697d4e8c812",
            ),
            (
                5,
                "26e2870f72368b3f8baef83fa26282d95d9c194e1f33d90a12932e0f6022e5d3",
            ),
            (
                7,
                "5cda317f9f94e784d7811b9b9884f3082f0baafc8a93a7db6f95f57ea52e9269",
            ),
            (
                8,
                "c1105948cfffba7d4dcf98de63a5eb1e4bd9c0ae1ff9dfcf0f34b9ad7eb758fc",
            ),
            (
                11,
                "00118133e5f9cf9c0da5443ad80ed3c69ec37cead6a6f7926c7452e1278ba554",
            ),
        ];

        let mut mmr = MmrAccumulator::new();
        let mut next = 1u8;
        for (count, expected_root) in expected {
            while mmr.leaf_count() < count {
                mmr.extend(leaf(next));
                next += 1;
            }
            assert_eq!(hex(mmr.root()), expected_root);
            assert_eq!(mmr.peak_count(), count.count_ones() as usize);
        }
    }

    #[test]
    fn serialize_round_trip_preserves_minimal_state() {
        let mut mmr = MmrAccumulator::new();
        for value in 1..=11 {
            mmr.extend(leaf(value));
        }
        let restored = MmrAccumulator::deserialize(&mmr.serialize()).unwrap();
        assert_eq!(restored, mmr);
        assert_eq!(restored.root(), mmr.root());
    }

    #[test]
    fn proof_to_root_rejects_cve_2012_2459_left_duplicate() {
        let mmr = MmrAccumulator::from_parts(2, vec![sha256d_pair(&leaf(1), &leaf(2))]).unwrap();
        // Leaf index 1 is a right child. A sibling equal to the current node is
        // the ambiguous left-duplicate shape rejected by the reference code.
        assert!(!mmr.verify_proof_to_root(1, leaf(2), &[leaf(2)]));
    }

    #[test]
    fn peak_proof_for_two_leaves_verifies() {
        let root = sha256d_pair(&leaf(1), &leaf(2));
        let mmr = MmrAccumulator::from_parts(2, vec![root]).unwrap();
        assert!(mmr.verify_proof_to_peak(0, leaf(1), &[leaf(2)]));
        assert!(mmr.verify_proof_to_peak(1, leaf(2), &[leaf(1)]));
    }
}
