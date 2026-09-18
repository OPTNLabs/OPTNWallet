// CashFusion Pedersen commitments — matches Electron Cash byte-for-byte.
//
// A Pedersen commitment hides a component's amount while letting the round
// verify that it balances. It is additively homomorphic:
//
//     commit(a1, n1) + commit(a2, n2) == commit(a1 + a2, n1 + n2)
//
// so the sum of every player's `amount_commitment` can be checked against the
// transaction's known input/output totals without any individual amount being
// seen. Each player's `pedersen_total_nonce` (the sum of its nonces) is what
// makes the nonce term cancel in that check.
//
// Reference (Electron Cash, electroncash_plugins/fusion/):
//   pedersen.py  — commitment = amount*H + nonce*G; amount_commitment is the
//                  65-byte UNCOMPRESSED point (0x04 prefix); scalars big-endian.
//   protocol.py  — H = PedersenSetup(b'\x02CashFusion gives us fungibility.'):
//                  the 33 bytes ARE the compressed encoding of H (0x02 even-y
//                  prefix + the 32-ASCII-byte string as the x-coordinate). A
//                  nothing-up-my-sleeve point with unknown discrete log vs G.
//
// Nothing here draws randomness. Nonce generation belongs to the platform: the
// desktop backend has the OS CSPRNG and the browser has crypto.getRandomValues,
// while this crate also compiles to wasm32, where pulling in an RNG would mean
// a getrandom JS shim for code that does not need one. Callers pass nonces in,
// which also makes every value below reproducible from a test vector.
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::{AffinePoint, EncodedPoint, ProjectivePoint, Scalar};
use once_cell::sync::Lazy;

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
    // k256 scalar mul is already constant-time, so the result is computed
    // directly; Electron Cash's `((amount-nonce)*H + nonce*(H+G))` rearrangement
    // is only a timing dodge for its variable-time backend and yields the SAME
    // point, so the serialized commitment is identical on the wire.
    *H * Scalar::from(amount) + ProjectivePoint::GENERATOR * nonce
}

/// The commitment point for a SIGNED amount, as a round does per component: an
/// input commits `+value-fee`, an output `-value-fee`, a blank `0`, so a
/// player's amounts sum to its excess fee.
pub fn commit_point_signed(amount: i64, nonce: &Scalar) -> ProjectivePoint {
    *H * scalar_from_i64(amount) + ProjectivePoint::GENERATOR * nonce
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

/// A signed integer as a scalar mod n: negatives map to `n - |amount|`.
pub fn scalar_from_i64(v: i64) -> Scalar {
    if v >= 0 {
        Scalar::from(v as u64)
    } else {
        -Scalar::from(v.unsigned_abs())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::elliptic_curve::group::GroupEncoding;
    use k256::elliptic_curve::{Group, PrimeField};

    fn scalar(byte: u8) -> Scalar {
        let mut bytes = [0u8; 32];
        bytes[31] = byte;
        bytes[0] = byte.wrapping_add(7);
        Option::<Scalar>::from(Scalar::from_repr(bytes.into())).expect("in range")
    }

    #[test]
    fn h_is_on_curve_and_distinct_from_g() {
        let h = h_point();
        assert!(!bool::from(h.is_identity()));
        assert_ne!(h, ProjectivePoint::GENERATOR);
        assert_ne!(h, -ProjectivePoint::GENERATOR);
    }

    #[test]
    fn h_compressed_encoding_is_the_nothing_up_my_sleeve_string() {
        // The whole point of H: its compressed form must be exactly
        // 0x02 || "CashFusion gives us fungibility." so anyone can verify there
        // is no trapdoor.
        let compressed = h_point().to_affine().to_bytes();
        assert_eq!(compressed[0], 0x02);
        assert_eq!(&compressed[1..], b"CashFusion gives us fungibility.");
    }

    #[test]
    fn commitment_is_additively_homomorphic() {
        // The property the round's balance check relies on.
        let (n1, n2) = (scalar(3), scalar(9));
        let (a1, a2) = (12_345u64, 67_890u64);

        let sum = commit_point(a1, &n1) + commit_point(a2, &n2);
        let combined = commit_point(a1 + a2, &(n1 + n2));
        assert_eq!(sum, combined);
    }

    #[test]
    fn wire_form_is_65_byte_uncompressed() {
        let c = commit_bytes(10_000, &scalar(5));
        assert_eq!(c.len(), 65);
        assert_eq!(c[0], 0x04);
    }

    #[test]
    fn zero_amount_still_commits_and_hides_via_nonce() {
        let n = scalar(11);
        let c = commit_point(0, &n);
        assert!(!bool::from(c.is_identity()));
        assert_eq!(c, ProjectivePoint::GENERATOR * n);
    }

    #[test]
    fn a_negative_amount_is_the_inverse_of_its_positive() {
        // An output commits the negative of what an input commits, and the two
        // have to cancel exactly or the round's balance check is meaningless.
        let n = scalar(23);
        let plus = commit_point_signed(5_000, &n);
        let minus = commit_point_signed(-5_000, &n);
        assert_eq!(plus + minus, ProjectivePoint::GENERATOR * (n + n));
    }
}
