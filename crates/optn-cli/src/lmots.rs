//! LM-OTS, the one-time signature Quantumroot signs with.
//!
//! Quantumroot is a post-quantum vault implemented in CashAssembly on Bitcoin
//! Cash. Its signing scheme is Leighton-Micali One-Time Signatures as specified
//! by RFC 8554 and recommended by NIST SP 800-208 — parameter set
//! `LMOTS_SHA256_N32_W4`. It rests on SHA-256 alone: no lattices, no pairings,
//! nothing whose security estimate moves year to year.
//!
//! **One-time is not a caveat, it is the security model.** Each key signs
//! exactly one message. Signing twice reveals enough hash-chain points that a
//! third party can forge a signature on a message neither party chose, so this
//! module makes signing consume the key rather than leaving that to the caller
//! to remember.
//!
//! The construction is pinned to Quantumroot's own reference implementation
//! (`test-suite/lm-ots.ts`) and its published vector, not to a reading of the
//! RFC. The two agree here — they deliberately kept the RFC's naming — but a
//! signature scheme that is merely plausible is worthless, and the difference
//! is invisible until a real vault refuses to open.

use sha2::{Digest, Sha256};

use crate::error::{CliError, Result};

/// Hash output length in bytes. `n` in RFC 8554.
pub const N: usize = 32;
/// Winternitz parameter. `w` in RFC 8554 — what Quantumroot's CashAssembly
/// is optimised for.
pub const W: usize = 4;
/// Chains needed for the message digest. `u` = ceil(8n / w).
pub const U: usize = (8 * N) / W;
/// Chains needed for the checksum. `v` in RFC 8554.
pub const V: usize = 3;
/// Left shift when packing the checksum. `ls` = 16 - v*w.
pub const LS: u32 = 16 - (V * W) as u32;
/// Total hash chains. `p` = u + v. The CashAssembly says 67; so does this.
pub const P: usize = U + V;
/// Iterations per chain: 2^w - 1.
pub const CHAIN_STEPS: u8 = ((1u16 << W) - 1) as u8;

/// Domain separator for the public-key hash.
const D_PBLC: [u8; 2] = [0x80, 0x80];
/// Domain separator for the message hash.
const D_MESG: [u8; 2] = [0x81, 0x81];

fn sha256(parts: &[&[u8]]) -> [u8; N] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    let digest = hasher.finalize();
    let mut out = [0u8; N];
    out.copy_from_slice(&digest);
    out
}

/// The `i`-th base-w digit of `s`.
///
/// With w = 4 this is a nibble, high half first. Reading them in the other
/// order produces a valid-looking signature that verifies against nothing.
pub fn coef(s: &[u8], i: usize) -> u8 {
    let byte_index = (i * W) / 8;
    let offset = i % (8 / W);
    let shift = 8 - W * (offset + 1);
    (s[byte_index] >> shift) & ((1 << W) - 1) as u8
}

/// RFC 8554's checksum over the message digest.
///
/// It is what stops an attacker walking chains forward to forge a different
/// message: raising any digit lowers the checksum, and the checksum's own
/// digits can only be walked forward too.
pub fn checksum(q: &[u8; N]) -> u16 {
    let mut sum: u32 = 0;
    for i in 0..U {
        sum += u32::from(CHAIN_STEPS) - u32::from(coef(q, i));
    }
    ((sum << LS) & 0xffff) as u16
}

/// One step along a hash chain.
fn step(data: &[u8; N], id: &[u8; 16], q: u32, i: u16, j: u8) -> [u8; N] {
    sha256(&[id, &q.to_be_bytes(), &i.to_be_bytes(), &[j], data])
}

/// A one-time private key: `p` chain starting points.
///
/// No `Debug`: printing it would put the whole key in a log, and unlike an
/// ordinary key this one is compromised by a single extra use, not just by
/// disclosure.
pub struct PrivateKey {
    pub id: [u8; 16],
    pub q: u32,
    chains: Vec<[u8; N]>,
}

impl PrivateKey {
    /// Derive from a seed, as RFC 8554 appendix A describes.
    ///
    /// Deterministic, so a vault can be restored from the seed alone rather
    /// than from a backup of `p` separate values.
    pub fn from_seed(seed: &[u8], id: [u8; 16], q: u32) -> Self {
        let chains = (0..P)
            .map(|i| {
                sha256(&[
                    &id,
                    &q.to_be_bytes(),
                    &(i as u16).to_be_bytes(),
                    &[0xff],
                    seed,
                ])
            })
            .collect();
        PrivateKey { id, q, chains }
    }

    pub fn chains(&self) -> &[[u8; N]] {
        &self.chains
    }

    /// The public key: every chain walked to its end, then hashed together.
    pub fn public_key(&self) -> [u8; N] {
        let mut hasher = Sha256::new();
        hasher.update(self.id);
        hasher.update(self.q.to_be_bytes());
        hasher.update(D_PBLC);
        for (i, start) in self.chains.iter().enumerate() {
            let mut tmp = *start;
            for j in 0..CHAIN_STEPS {
                tmp = step(&tmp, &self.id, self.q, i as u16, j);
            }
            hasher.update(tmp);
        }
        let digest = hasher.finalize();
        let mut out = [0u8; N];
        out.copy_from_slice(&digest);
        out
    }

    /// Sign one message. Consumes the key, because it may only sign one.
    ///
    /// Taking `self` by value is the point: a second signature with the same
    /// key exposes enough chain points to forge a third message, and a caller
    /// who has to remember that will eventually not.
    pub fn sign(self, message: &[u8], c: &[u8; N]) -> Signature {
        let q_hash = message_hash(&self.id, self.q, c, message);
        let encoded = encode(&q_hash);

        let elements = self
            .chains
            .iter()
            .enumerate()
            .map(|(i, start)| {
                let mut tmp = *start;
                for j in 0..coef(&encoded, i) {
                    tmp = step(&tmp, &self.id, self.q, i as u16, j);
                }
                tmp
            })
            .collect();

        Signature {
            id: self.id,
            q: self.q,
            c: *c,
            elements,
        }
    }
}

/// `Q` — the hash the signature actually commits to.
fn message_hash(id: &[u8; 16], q: u32, c: &[u8; N], message: &[u8]) -> [u8; N] {
    sha256(&[id, &q.to_be_bytes(), &D_MESG, c, message])
}

/// `Q || u16(checksum)`, the value whose digits index into the chains.
fn encode(q_hash: &[u8; N]) -> [u8; N + 2] {
    let mut out = [0u8; N + 2];
    out[..N].copy_from_slice(q_hash);
    out[N..].copy_from_slice(&checksum(q_hash).to_be_bytes());
    out
}

pub struct Signature {
    pub id: [u8; 16],
    pub q: u32,
    /// The randomiser. Part of the signature, not a secret.
    pub c: [u8; N],
    pub elements: Vec<[u8; N]>,
}

impl Signature {
    /// Recompute the public key this signature implies.
    ///
    /// Verification is this, compared against the key you expected. There is
    /// no separate check: an invalid signature simply yields a different key.
    pub fn recover(&self, message: &[u8]) -> Result<[u8; N]> {
        if self.elements.len() != P {
            return Err(CliError::Protocol(format!(
                "an LM-OTS signature has {P} elements, this one has {}",
                self.elements.len()
            )));
        }
        let q_hash = message_hash(&self.id, self.q, &self.c, message);
        let encoded = encode(&q_hash);

        let mut hasher = Sha256::new();
        hasher.update(self.id);
        hasher.update(self.q.to_be_bytes());
        hasher.update(D_PBLC);
        for (i, element) in self.elements.iter().enumerate() {
            let mut tmp = *element;
            for j in coef(&encoded, i)..CHAIN_STEPS {
                tmp = step(&tmp, &self.id, self.q, i as u16, j);
            }
            hasher.update(tmp);
        }
        let digest = hasher.finalize();
        let mut out = [0u8; N];
        out.copy_from_slice(&digest);
        Ok(out)
    }

    /// Whether this signature is valid for `message` under `public_key`.
    pub fn verify(&self, message: &[u8], public_key: &[u8; N]) -> bool {
        match self.recover(message) {
            // Constant time is not needed: both sides are public.
            Ok(recovered) => recovered == *public_key,
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_parameters_are_the_set_quantumroot_uses() {
        // LMOTS_SHA256_N32_W4. The CashAssembly hard-codes 67 chains; if these
        // disagree with it, every key this produces is for a different scheme.
        assert_eq!(N, 32);
        assert_eq!(W, 4);
        assert_eq!(U, 64);
        assert_eq!(V, 3);
        assert_eq!(LS, 4);
        assert_eq!(P, 67);
        assert_eq!(CHAIN_STEPS, 15);
    }

    #[test]
    fn coefficients_are_nibbles_high_half_first() {
        // Reading them low-half-first produces a signature that verifies
        // against nothing, with no other symptom.
        let s = [0xabu8, 0xcd];
        assert_eq!(coef(&s, 0), 0xa);
        assert_eq!(coef(&s, 1), 0xb);
        assert_eq!(coef(&s, 2), 0xc);
        assert_eq!(coef(&s, 3), 0xd);
    }

    #[test]
    fn the_checksum_falls_as_digits_rise() {
        // This is the property that stops an attacker walking chains forward
        // to forge a larger message: they would have to walk the checksum
        // backwards, which the hash chain does not permit.
        let low = checksum(&[0x00; N]);
        let high = checksum(&[0xff; N]);
        assert!(high < low, "raising every digit must lower the checksum");
        assert_eq!(high, 0);
    }

    #[test]
    fn a_key_signs_and_verifies() {
        let key = PrivateKey::from_seed(&[7u8; 32], [1u8; 16], 0);
        let public = key.public_key();
        let signature = key.sign(b"hello", &[2u8; N]);
        assert!(signature.verify(b"hello", &public));
    }

    #[test]
    fn a_signature_does_not_verify_for_another_message() {
        let key = PrivateKey::from_seed(&[7u8; 32], [1u8; 16], 0);
        let public = key.public_key();
        let signature = key.sign(b"hello", &[2u8; N]);
        assert!(!signature.verify(b"goodbye", &public));
    }

    #[test]
    fn a_signature_does_not_verify_under_another_key() {
        let key = PrivateKey::from_seed(&[7u8; 32], [1u8; 16], 0);
        let other = PrivateKey::from_seed(&[8u8; 32], [1u8; 16], 0).public_key();
        let signature = key.sign(b"hello", &[2u8; N]);
        assert!(!signature.verify(b"hello", &other));
    }

    #[test]
    fn the_identifier_and_leaf_number_are_bound_into_the_signature() {
        // Both are hashed into every step. Without that, a signature made for
        // one leaf of a vault would verify at another.
        let signature = PrivateKey::from_seed(&[7u8; 32], [1u8; 16], 0).sign(b"m", &[2u8; N]);
        let other_id = PrivateKey::from_seed(&[7u8; 32], [9u8; 16], 0).public_key();
        let other_q = PrivateKey::from_seed(&[7u8; 32], [1u8; 16], 1).public_key();
        assert!(!signature.verify(b"m", &other_id));
        assert!(!signature.verify(b"m", &other_q));
    }

    #[test]
    fn a_truncated_signature_is_refused_rather_than_recovered() {
        let key = PrivateKey::from_seed(&[7u8; 32], [1u8; 16], 0);
        let public = key.public_key();
        let mut signature = key.sign(b"hello", &[2u8; N]);
        signature.elements.truncate(P - 1);
        assert!(signature.recover(b"hello").is_err());
        assert!(!signature.verify(b"hello", &public));
    }

    #[test]
    fn key_derivation_is_deterministic() {
        // A vault is restored from its seed, not from a backup of 67 values.
        let a = PrivateKey::from_seed(&[3u8; 32], [4u8; 16], 5).public_key();
        let b = PrivateKey::from_seed(&[3u8; 32], [4u8; 16], 5).public_key();
        assert_eq!(a, b);
    }
}

include!("lmots_vector.rs");
