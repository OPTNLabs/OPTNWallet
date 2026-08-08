// CashFusion Pedersen commitments — matches Electron Cash byte-for-byte.
//
// A Pedersen commitment hides a component's amount while letting the server
// verify the round balances. It is additively homomorphic:
//
//     commit(a1, n1) + commit(a2, n2) == commit(a1 + a2, n1 + n2)
//
// so the server sums every player's `amount_commitment` and checks the total
// against the transaction's known input/output totals — never seeing an
// individual amount. Each player's `pedersen_total_nonce` (Σ of its nonces) is
// what makes the nonce term cancel in that check.
//
// Reference (Electron Cash, electroncash_plugins/fusion/):
//   pedersen.py  — commitment = amount*H + nonce*G; amount_commitment is the
//                  65-byte UNCOMPRESSED point (0x04 prefix); scalars big-endian.
//   protocol.py  — H = PedersenSetup(b'\x02CashFusion gives us fungibility.'):
//                  the 33 bytes ARE the compressed encoding of H (0x02 even-y
//                  prefix + the 32-ASCII-byte string as the x-coordinate). A
//                  nothing-up-my-sleeve point with unknown discrete log vs G.

use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, EncodedPoint, ProjectivePoint, Scalar};
use once_cell::sync::Lazy;
use rand_core::{OsRng, RngCore};

/// The nothing-up-my-sleeve generator H, exactly as Electron Cash derives it:
/// the 33-byte compressed point `0x02 || "CashFusion gives us fungibility."`.
static H: Lazy<ProjectivePoint> = Lazy::new(|| {
    const SEED: &[u8; 32] = b"CashFusion gives us fungibility.";
    let mut compressed = [0u8; 33];
    compressed[0] = 0x02; // even-y prefix
    compressed[1..].copy_from_slice(SEED);
    let ep = EncodedPoint::from_bytes(compressed).expect("H compressed encoding is well-formed");
    let ap = Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&ep))
        .expect("H lies on secp256k1");
    ProjectivePoint::from(ap)
});

/// H as a projective point (decompressed once, cached).
pub fn h_point() -> ProjectivePoint {
    *H
}

/// The Pedersen commitment point for `amount` sats under blinding `nonce`:
/// `amount*H + nonce*G`. Returned as a curve point so callers can sum them for
/// the homomorphic balance check; use [`encode_uncompressed`] for the wire form.
pub fn commit_point(amount: u64, nonce: &Scalar) -> ProjectivePoint {
    // k256 scalar mul is already constant-time, so we can compute the result
    // directly; Electron Cash's `((amount-nonce)*H + nonce*(H+G))` rearrangement
    // is only a timing dodge for its variable-time backend and yields the SAME
    // point, so the serialized commitment is identical on the wire.
    *H * Scalar::from(amount) + ProjectivePoint::GENERATOR * nonce
}

/// Serialize a commitment point as the 65-byte uncompressed encoding (0x04
/// prefix) the protocol's `amount_commitment` field expects.
pub fn encode_uncompressed(point: &ProjectivePoint) -> [u8; 65] {
    let ep = point.to_affine().to_encoded_point(false);
    let mut out = [0u8; 65];
    out.copy_from_slice(ep.as_bytes());
    out
}

/// Convenience: commitment for `amount`/`nonce` directly as the 65-byte wire form.
pub fn commit_bytes(amount: u64, nonce: &Scalar) -> [u8; 65] {
    encode_uncompressed(&commit_point(amount, nonce))
}

/// A Pedersen commitment with its nonce retained. The nonce is needed later for
/// the blame `Proof` and for `pedersen_total_nonce` (the per-player Σ of nonces).
pub struct Commitment {
    pub nonce: Scalar,
    pub p_uncompressed: [u8; 65],
}

/// Commit to a SIGNED amount with a fresh nonce, as the round does per component:
/// an input commits `+value-fee`, an output `-value-fee`, a blank `0`, so the
/// player's amounts sum to its excess fee. Mirrors Electron Cash `PEDERSEN.commit`.
pub fn commit(amount: i64) -> Commitment {
    let nonce = random_nonce();
    let point = *H * scalar_from_i64(amount) + ProjectivePoint::GENERATOR * nonce;
    Commitment {
        nonce,
        p_uncompressed: encode_uncompressed(&point),
    }
}

/// 32 cryptographically-random bytes — for salts and the round's random number.
/// OS CSPRNG; never the counter+clock Tor-isolation token.
pub fn random_32() -> [u8; 32] {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    b
}

/// A signed integer as a scalar mod n: negatives map to `n - |amount|`.
pub fn scalar_from_i64(v: i64) -> Scalar {
    if v >= 0 {
        Scalar::from(v as u64)
    } else {
        -Scalar::from(v.unsigned_abs())
    }
}

/// A fresh, cryptographically-random blinding nonce (uniform mod the group
/// order). One per component; never reuse. Sourced from the OS CSPRNG.
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
    use k256::elliptic_curve::group::GroupEncoding;
    use k256::elliptic_curve::Group; // brings ProjectivePoint::is_identity into scope

    #[test]
    fn h_is_on_curve_and_distinct_from_g() {
        let h = h_point();
        // Decompression succeeding (in the Lazy init) already proves on-curve;
        // assert it's neither the identity nor equal to G / -G.
        assert!(!bool::from(h.is_identity()));
        assert_ne!(h, ProjectivePoint::GENERATOR);
        assert_ne!(h, -ProjectivePoint::GENERATOR);
    }

    #[test]
    fn h_compressed_encoding_is_the_nothing_up_my_sleeve_string() {
        // The whole point of H: its compressed form must be exactly
        // 0x02 || "CashFusion gives us fungibility." so anyone can verify no
        // trapdoor. Round-trip the cached point back to compressed and check.
        let compressed = h_point().to_affine().to_bytes();
        assert_eq!(compressed[0], 0x02);
        assert_eq!(&compressed[1..], b"CashFusion gives us fungibility.");
    }

    #[test]
    fn commitment_is_additively_homomorphic() {
        // The property the server relies on:
        //   commit(a1,n1) + commit(a2,n2) == commit(a1+a2, n1+n2)
        let n1 = random_nonce();
        let n2 = random_nonce();
        let (a1, a2) = (12_345u64, 67_890u64);

        let sum = commit_point(a1, &n1) + commit_point(a2, &n2);
        let combined = commit_point(a1 + a2, &(n1 + n2));
        assert_eq!(sum, combined);
    }

    #[test]
    fn wire_form_is_65_byte_uncompressed() {
        let c = commit_bytes(10_000, &random_nonce());
        assert_eq!(c.len(), 65);
        assert_eq!(c[0], 0x04); // uncompressed prefix
    }

    #[test]
    fn zero_amount_still_commits_and_hides_via_nonce() {
        // A blank/zero component must still produce a valid, nonce-hidden point.
        let n = random_nonce();
        let c = commit_point(0, &n);
        assert!(!bool::from(c.is_identity()));
        assert_eq!(c, ProjectivePoint::GENERATOR * n);
    }

    #[test]
    fn random_nonces_are_distinct() {
        let a = random_nonce();
        let b = random_nonce();
        assert_ne!(a, b);
        assert!(!bool::from(a.is_zero()));
    }
}
