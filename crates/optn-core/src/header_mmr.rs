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

    /// Proof to the new root for a leaf about to be appended. The caller must
    /// append that same leaf before using the proof. At most 64 hashes are
    /// retained; no historical leaves are required.
    pub fn proof_for_next_leaf(&self, leaf: Hash32) -> Vec<Hash32> {
        let mut proof = Vec::new();
        let mut current = leaf;
        let mut height = 0u32;
        let mut remaining = self.leaf_count;
        for left in self.peaks.iter().rev() {
            let left_height = remaining.trailing_zeros();
            while height < left_height {
                proof.push(current);
                current = sha256d_pair(&current, &current);
                height += 1;
            }
            proof.push(*left);
            current = sha256d_pair(left, &current);
            height += 1;
            remaining &= remaining - 1;
        }
        proof
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
        let peaks = data[8..].as_chunks::<32>().0.to_vec();
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

    #[test]
    fn appended_tip_proof_restores_every_peak_shape() {
        let mut accumulator = MmrAccumulator::new();
        for index in 0u64..257 {
            let leaf: Hash32 = Sha256::digest(index.to_le_bytes()).into();
            let proof = accumulator.proof_for_next_leaf(leaf);
            accumulator.extend(leaf);
            assert!(proof.len() <= 64);
            assert!(accumulator.verify_proof_to_root(index, leaf, &proof));
            let restored = MmrAccumulator::bootstrap_from_last_leaf_proof(index + 1, leaf, &proof)
                .expect("new tip proof restores its accumulator");
            assert_eq!(restored, accumulator);
            if !proof.is_empty() {
                let mut corrupt = proof.clone();
                corrupt[0][0] ^= 1;
                assert!(!accumulator.verify_proof_to_root(index, leaf, &corrupt));
            }
        }
    }

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

/// Cross-check against the reference accumulator's own published vectors.
///
/// Source: `A60AB5450353F40E/mmr-accumulator`, `test_vectors/mmr_test_vectors.json`
/// at commit `eb4f99afc0cd3c6cb56865bed71cd95fe14b64ae` ("Proof-to-Peak
/// optimization"), vendored to `test-vectors/shv-mmr-accumulator.json`. That is
/// the library the Electron Cash `mmr4` checkpoint extender imports, so these
/// vectors are the same ones the SHV reference implementation is held to.
///
/// The vectors carry real Bitcoin mainnet data: block Merkle roots, the first
/// sixteen header hashes, live Electrum `cp_height` proofs, and the
/// CVE-2012-2459 forgery. Agreement here is what makes "OPTN's MMR is the
/// commitment Fulcrum already serves" a checked statement rather than a claim.
#[cfg(test)]
mod reference_vectors {
    use super::*;
    use crate::header_hash::sha256d;
    use serde_json::Value;

    const RAW: &str = include_str!("../../../test-vectors/shv-mmr-accumulator.json");

    fn doc() -> Value {
        serde_json::from_str(RAW).expect("reference vectors are valid JSON")
    }

    /// Display hex is big-endian; the accumulator works in internal order.
    /// The reference does the same reversal when it takes Electrum branches.
    fn display_hash(value: &str) -> Hash32 {
        let mut bytes = decode_hex(value);
        bytes.reverse();
        bytes.try_into().expect("32-byte hash")
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        (0..value.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&value[i..i + 2], 16).expect("hex"))
            .collect()
    }

    fn accumulator_of(leaves: &[Hash32]) -> MmrAccumulator {
        let mut mmr = MmrAccumulator::new();
        for leaf in leaves {
            mmr.extend(*leaf);
        }
        mmr
    }

    fn branch_of(entry: &Value) -> Vec<Hash32> {
        entry["branch"]
            .as_array()
            .expect("branch")
            .iter()
            .map(|item| display_hash(item.as_str().expect("sibling")))
            .collect()
    }

    fn leaf_of(entry: &Value) -> Hash32 {
        sha256d(&decode_hex(entry["header"].as_str().expect("header")))
    }

    /// Every Bitcoin Merkle tree contains this MMR, so bagging the peaks over a
    /// block's transaction ids must reproduce that block's `merkleroot`.
    #[test]
    fn block_merkle_roots_match_the_bagged_peaks() {
        let doc = doc();
        let blocks = doc["blocks"].as_object().expect("blocks");
        assert!(!blocks.is_empty());
        for (height, block) in blocks {
            let leaves = block["tx"]
                .as_array()
                .expect("tx list")
                .iter()
                .map(|tx| display_hash(tx.as_str().expect("txid")))
                .collect::<Vec<_>>();
            let mut expected = display_hash(block["merkleroot"].as_str().expect("merkleroot"));
            let mmr = accumulator_of(&leaves);
            assert_eq!(mmr.root(), expected, "block {height}");
            expected[0] ^= 1;
            assert_ne!(mmr.root(), expected);
        }
    }

    /// Live Electrum `blockchain.block.header(height, cp_height)` proofs.
    ///
    /// For each checkpoint the last-leaf proof bootstraps the accumulator, and
    /// every other proof at that checkpoint then verifies against it.
    #[test]
    fn electrum_checkpoint_proofs_bootstrap_and_verify() {
        let doc = doc();
        let proofs = doc["electrum_proofs"].as_object().expect("electrum_proofs");
        assert!(proofs.len() >= 8, "vector set shrank unexpectedly");

        let mut checked_bootstraps = 0usize;
        let mut checked_members = 0usize;

        for proof in proofs.values() {
            let cp_height = proof["cp_height"].as_u64().expect("cp_height") as u32;
            let height = proof["height"].as_u64().expect("height") as u32;
            if height != cp_height {
                continue;
            }
            let root = display_hash(proof["root"].as_str().expect("root"));
            let restored = MmrAccumulator::bootstrap_from_last_leaf_proof(
                u64::from(cp_height) + 1,
                leaf_of(proof),
                &branch_of(proof),
            )
            .unwrap_or_else(|| panic!("cp {cp_height} last-leaf proof must bootstrap"));
            assert_eq!(restored.root(), root, "cp {cp_height} root");
            assert_eq!(restored.leaf_count(), u64::from(cp_height) + 1);
            assert_eq!(
                restored.peak_count(),
                restored.leaf_count().count_ones() as usize
            );
            checked_bootstraps += 1;

            for member in proofs.values() {
                if member["cp_height"].as_u64().expect("cp_height") as u32 != cp_height {
                    continue;
                }
                let member_height = member["height"].as_u64().expect("height") as u32;
                let member_leaf = leaf_of(member);
                let member_branch = branch_of(member);
                assert!(
                    restored.verify_proof_to_root(
                        u64::from(member_height),
                        member_leaf,
                        &member_branch
                    ),
                    "cp {cp_height} proof for height {member_height} must verify"
                );
                if let Some(first) = member_branch.first().copied() {
                    let mut tampered = member_branch.clone();
                    tampered[0][0] = first[0] ^ 1;
                    assert!(!restored.verify_proof_to_root(
                        u64::from(member_height),
                        member_leaf,
                        &tampered
                    ));
                }
                checked_members += 1;
            }
        }

        assert!(checked_bootstraps >= 3, "expected several checkpoints");
        assert!(checked_members >= 6, "expected several member proofs");
    }

    /// CVE-2012-2459: a 16-leaf tree of duplicated tail hashes bags to the same
    /// root as the real 11-leaf tree.
    ///
    /// Reproducing the collision proves our root function matches the
    /// reference. Refusing the phantom leaves is the part that matters: the
    /// real accumulator commits to 11 leaves, so a proof claiming index 11-15
    /// is rejected on the leaf count rather than on the hashes.
    #[test]
    fn the_cve_2012_2459_forgery_collides_but_is_not_accepted() {
        let doc = doc();
        let cve = &doc["cve_2012_2459"];
        let real_leaf_count = cve["real_leaf_count"].as_u64().expect("real_leaf_count");
        let forged_leaf_count = cve["forged_leaf_count"]
            .as_u64()
            .expect("forged_leaf_count");
        let root = display_hash(cve["root"].as_str().expect("root"));

        let hashes = |key: &str| -> Vec<Hash32> {
            doc["header_segments"][key]["header_hashes"]
                .as_array()
                .expect("header_hashes")
                .iter()
                .map(|item| display_hash(item.as_str().expect("hash")))
                .collect()
        };

        let real = accumulator_of(&hashes("first_16")[..real_leaf_count as usize]);
        assert_eq!(real.root(), root, "real 11-leaf root");

        let forged = accumulator_of(&hashes("first_16_forged")[..forged_leaf_count as usize]);
        assert_eq!(
            forged.root(),
            root,
            "the forged tree really does collide -- this is the CVE"
        );
        assert_ne!(real.leaf_count(), forged.leaf_count());

        let proofs = doc["electrum_proofs"].as_object().expect("electrum_proofs");
        for mapping in cve["forged_proof_mappings"]
            .as_array()
            .expect("forged_proof_mappings")
        {
            let forged_index = mapping["forged_index"].as_u64().expect("forged_index");
            let source = &proofs[mapping["proof_key"].as_str().expect("proof_key")];
            assert!(
                forged_index >= real.leaf_count(),
                "mapping should describe a phantom leaf"
            );
            assert!(
                !real.verify_proof_to_root(forged_index, leaf_of(source), &branch_of(source)),
                "phantom leaf {forged_index} must not verify against the real accumulator"
            );
        }
    }

    /// Extending leaf by leaf must land on the same state a bootstrap does.
    #[test]
    fn extending_the_first_sixteen_headers_matches_the_published_segment() {
        let doc = doc();
        let segment = &doc["header_segments"]["first_16"];
        assert_eq!(segment["start_height"].as_u64(), Some(0));
        let leaves = segment["header_hashes"]
            .as_array()
            .expect("header_hashes")
            .iter()
            .map(|item| display_hash(item.as_str().expect("hash")))
            .collect::<Vec<_>>();
        assert_eq!(leaves.len(), 16);

        let mut mmr = MmrAccumulator::new();
        for (index, leaf) in leaves.iter().enumerate() {
            let proof = mmr.proof_for_next_leaf(*leaf);
            mmr.extend(*leaf);
            assert_eq!(mmr.leaf_count(), index as u64 + 1);
            assert_eq!(mmr.peak_count(), mmr.leaf_count().count_ones() as usize);
            assert!(mmr.verify_proof_to_root(index as u64, *leaf, &proof));
            let restored =
                MmrAccumulator::bootstrap_from_last_leaf_proof(mmr.leaf_count(), *leaf, &proof)
                    .expect("tip proof restores the accumulator");
            assert_eq!(restored, mmr);
        }
        // 16 leaves is a single perfect tree: exactly one peak.
        assert_eq!(mmr.peak_count(), 1);
    }
}
