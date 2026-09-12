// CashFusion Pedersen commitments.
//
// The math lives in `optn_core::fusion::pedersen` and is shared with the
// browser-side P2P round through wasm, pinned by `test-vectors/fusion.json`.
// What stays here is the randomness: the core takes nonces as parameters so it
// compiles to wasm32 without a getrandom shim, and this module is the desktop
// backend's binding of that to the OS CSPRNG.
pub use optn_core::fusion::pedersen::{
    commit_bytes, commit_point, commit_point_signed, encode_uncompressed, h_point, scalar_from_i64,
};

use k256::elliptic_curve::PrimeField;
use k256::Scalar;
use rand_core::{OsRng, RngCore};

/// A Pedersen commitment with its nonce retained. The nonce is needed later for
/// the blame `Proof` and for `pedersen_total_nonce` (the per-player sum).
pub struct Commitment {
    pub nonce: Scalar,
    pub p_uncompressed: [u8; 65],
}

/// Commit to a SIGNED amount with a fresh nonce, as the round does per
/// component: an input commits `+value-fee`, an output `-value-fee`, a blank
/// `0`, so the player's amounts sum to its excess fee.
pub fn commit(amount: i64) -> Commitment {
    let nonce = random_nonce();
    Commitment {
        nonce,
        p_uncompressed: encode_uncompressed(&commit_point_signed(amount, &nonce)),
    }
}

/// 32 cryptographically-random bytes — for salts and the round's random number.
/// OS CSPRNG; never the counter+clock Tor-isolation token.
pub fn random_32() -> [u8; 32] {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    b
}

/// A fresh, cryptographically-random blinding nonce (uniform mod the group
/// order). One per component; never reuse.
pub fn random_nonce() -> Scalar {
    // Rejection-sample a 32-byte value into a canonical scalar. Scalar::from_repr
    // returns None for the ~2^-128 chance of landing >= the order; loop until in
    // range so the result is uniform and canonical.
    loop {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        if let Some(s) = Option::<Scalar>::from(Scalar::from_repr(bytes.into())) {
            // Reject zero too (a zero nonce would expose amount*H directly).
            if !bool::from(s.is_zero()) {
                return s;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::elliptic_curve::Group;
    use k256::ProjectivePoint;

    #[test]
    fn commitment_is_additively_homomorphic_with_real_nonces() {
        // The core proves this with fixed nonces; this proves the CSPRNG binding
        // here produces scalars the same arithmetic holds for.
        let (n1, n2) = (random_nonce(), random_nonce());
        let (a1, a2) = (12_345u64, 67_890u64);
        assert_eq!(
            commit_point(a1, &n1) + commit_point(a2, &n2),
            commit_point(a1 + a2, &(n1 + n2))
        );
    }

    #[test]
    fn commit_returns_the_wire_form_and_keeps_its_nonce() {
        let c = commit(-5_000);
        assert_eq!(c.p_uncompressed[0], 0x04);
        assert_eq!(
            c.p_uncompressed,
            encode_uncompressed(&commit_point_signed(-5_000, &c.nonce))
        );
    }

    #[test]
    fn random_nonces_are_distinct_and_non_zero() {
        let (a, b) = (random_nonce(), random_nonce());
        assert_ne!(a, b);
        assert!(!bool::from(a.is_zero()));
    }

    #[test]
    fn a_zero_amount_still_commits_to_a_real_point() {
        let n = random_nonce();
        let c = commit_point(0, &n);
        assert!(!bool::from(c.is_identity()));
        assert_eq!(c, ProjectivePoint::GENERATOR * n);
    }
}
