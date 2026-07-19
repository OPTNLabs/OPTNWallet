// BCH Schnorr signatures + the CashFusion blind-signature requester side.
// Matches Electron Cash (electroncash/schnorr.py) exactly so blind signatures we
// build unblind to signatures a fusion server (and BCH consensus) will accept.
//
// BCH Schnorr convention: signature is R.x(32) || s(32); challenge
//   e = sha256(R.x || compressed(P) || msg32); verification checks
//   R = s*G - e*P has R.x == the signature's R.x AND jacobi(R.y, p) == +1.
// The Jacobi (quadratic-residue) rule is why only R.x travels — the verifier
// reconstructs the unique R whose y is a QR.
//
// Blind scheme (electroncash/schnorr.py BlindSignatureRequest), signer holds
// pubkey P=x*G and nonce R=k*G:
//   a,b random;  R' = c*(R + a*G + b*P),  c = ±1 chosen so jacobi(R'.y)=+1
//   e' = sha256(R'.x || compressed(P) || msg32);  e = (c*e' + b) mod n   [-> signer]
//   signer returns s = k + e*x;  s' = c*(s + a) mod n
//   unblinded signature = R'.x || s'
// The signer never sees (R'.x, s'), so it cannot link the request to the sig.

use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::{Group, PrimeField};
use k256::{AffinePoint, EncodedPoint, ProjectivePoint, Scalar, U256};
use num_bigint::BigUint;
use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};

use super::pedersen::random_nonce;

/// secp256k1 field prime p (NOT the group order). Used only for the Jacobi test.
static FIELD_P: Lazy<BigUint> = Lazy::new(|| {
    BigUint::parse_bytes(
        b"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F",
        16,
    )
    .expect("valid field prime")
});

/// Jacobi symbol of `y` mod the field prime, as BCH Schnorr uses it: since p is
/// prime this is the Legendre symbol y^((p-1)/2) mod p. Returns true iff `y` is a
/// non-zero quadratic residue (the "+1" case the convention requires).
fn y_is_quadratic_residue(y_be: &[u8]) -> bool {
    let y = BigUint::from_bytes_be(y_be);
    let exp = (&*FIELD_P - 1u32) >> 1u32;
    y.modpow(&exp, &FIELD_P) == BigUint::from(1u32)
}

/// Parse a serialized secp256k1 point (33-byte compressed or 65-byte uncompressed).
fn parse_point(bytes: &[u8]) -> Result<ProjectivePoint, String> {
    let ep = EncodedPoint::from_bytes(bytes).map_err(|_| "point could not be parsed".to_string())?;
    Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&ep))
        .map(ProjectivePoint::from)
        .ok_or_else(|| "point not on curve".to_string())
}

/// Reduce 32 big-endian bytes into a scalar mod the group order n.
fn scalar_reduce(bytes: [u8; 32]) -> Scalar {
    <Scalar as Reduce<U256>>::reduce_bytes(&bytes.into())
}

/// (x, y) affine coordinates of a point as 32-byte big-endian arrays.
fn affine_xy(point: &ProjectivePoint) -> ([u8; 32], [u8; 32]) {
    let ep = point.to_affine().to_encoded_point(false);
    let mut x = [0u8; 32];
    let mut y = [0u8; 32];
    x.copy_from_slice(ep.x().expect("affine has x"));
    y.copy_from_slice(ep.y().expect("uncompressed has y"));
    (x, y)
}

fn compressed(point: &ProjectivePoint) -> [u8; 33] {
    let ep = point.to_affine().to_encoded_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(ep.as_bytes());
    out
}

/// The BCH Schnorr challenge e = sha256(R.x || compressed(P) || msg32), mod n.
fn challenge(rx: &[u8; 32], pubkey_point: &ProjectivePoint, msg32: &[u8; 32]) -> Scalar {
    let mut h = Sha256::new();
    h.update(rx);
    h.update(compressed(pubkey_point));
    h.update(msg32);
    let e: [u8; 32] = h.finalize().into();
    scalar_reduce(e)
}

/// Verify a 64-byte BCH Schnorr signature (R.x || s) over `msg32` under `pubkey`
/// (33- or 65-byte serialized). Returns false on any malformed input.
pub fn verify(pubkey: &[u8], sig: &[u8; 64], msg32: &[u8; 32]) -> bool {
    let p = match parse_point(pubkey) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let mut rbytes = [0u8; 32];
    rbytes.copy_from_slice(&sig[..32]);
    let mut sbytes = [0u8; 32];
    sbytes.copy_from_slice(&sig[32..]);

    // s must be canonical (< n); a server sending s >= n is invalid.
    let s = match Option::<Scalar>::from(Scalar::from_repr(sbytes.into())) {
        Some(s) => s,
        None => return false,
    };

    let e = challenge(&rbytes, &p, msg32);
    // R = s*G - e*P
    let r = ProjectivePoint::GENERATOR * s - p * e;
    if bool::from(r.is_identity()) {
        return false;
    }
    let (rx, ry) = affine_xy(&r);
    if !y_is_quadratic_residue(&ry) {
        return false;
    }
    rx == rbytes
}

/// Requester side of the CashFusion blind Schnorr signature.
///
/// Construct one per component with the server's `round_pubkey`, one of its
/// `blind_nonce_points` (R), and the 32-byte message hash (sha256 of the
/// component). `request()` is the 32-byte scalar sent to the server; feed the
/// server's 32-byte response to `finalize()` to get the unblinded 64-byte sig.
pub struct BlindSignatureRequest {
    pubkey_point: ProjectivePoint,
    message_hash: [u8; 32],
    a: Scalar,
    rx_new: [u8; 32],
    /// c in {+1,-1}: true means c = -1 (negate).
    sign_flip: bool,
    e: Scalar,
}

impl BlindSignatureRequest {
    pub fn new(round_pubkey: &[u8], r: &[u8], message_hash: [u8; 32]) -> Result<Self, String> {
        let pubkey_point = parse_point(round_pubkey)?;
        let r_point = parse_point(r)?;

        let a = random_nonce();
        let b = random_nonce();

        // R_new = R + a*G + b*P
        let r_new = r_point + ProjectivePoint::GENERATOR * a + pubkey_point * b;
        if bool::from(r_new.is_identity()) {
            return Err("blinded R is the identity — retry".into());
        }
        let (rx_new, ry_new) = affine_xy(&r_new);
        // c = jacobi(R_new.y): +1 if QR else -1.
        let sign_flip = !y_is_quadratic_residue(&ry_new);

        // e = (c * sha256(R_new.x || compressed(P) || m) + b) mod n
        let e_hash = challenge(&rx_new, &pubkey_point, &message_hash);
        let c_e_hash = if sign_flip { -e_hash } else { e_hash };
        let e = c_e_hash + b;

        Ok(Self { pubkey_point, message_hash, a, rx_new, sign_flip, e })
    }

    /// The 32-byte blinded challenge to send to the signer (PlayerCommit's
    /// `blind_sig_requests`).
    pub fn request(&self) -> [u8; 32] {
        self.e.to_bytes().into()
    }

    /// Unblind the signer's 32-byte response into the final 64-byte signature.
    /// With `check`, verifies the result under the round pubkey and returns an
    /// error if the signer cheated.
    pub fn finalize(&self, s_response: &[u8; 32], check: bool) -> Result<[u8; 64], String> {
        let s = scalar_reduce(*s_response);
        // s_new = c * (s + a) mod n
        let s_a = s + self.a;
        let s_new = if self.sign_flip { -s_a } else { s_a };

        let mut sig = [0u8; 64];
        sig[..32].copy_from_slice(&self.rx_new);
        sig[32..].copy_from_slice(&s_new.to_bytes());

        if check {
            let pubkey = compressed(&self.pubkey_point);
            if !verify(&pubkey, &sig, &self.message_hash) {
                return Err("blind signature verification failed — signer cheated".into());
            }
        }
        Ok(sig)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::elliptic_curve::group::GroupEncoding;

    /// Minimal signer side, mirroring electroncash schnorr.BlindSigner, for the
    /// round-trip test: holds x (priv), k (nonce); R = k*G; s = k + e*x.
    struct Signer {
        x: Scalar,
        k: Scalar,
    }
    impl Signer {
        fn new() -> Self {
            Self { x: random_nonce(), k: random_nonce() }
        }
        fn pubkey(&self) -> [u8; 33] {
            compressed(&(ProjectivePoint::GENERATOR * self.x))
        }
        fn r(&self) -> [u8; 33] {
            compressed(&(ProjectivePoint::GENERATOR * self.k))
        }
        fn sign(&self, ebytes: &[u8; 32]) -> [u8; 32] {
            let e = scalar_reduce(*ebytes);
            (self.k + e * self.x).to_bytes().into()
        }
    }

    #[test]
    fn blind_round_trip_produces_a_valid_bch_schnorr_signature() {
        // Full flow: request -> signer -> finalize -> verify. If this passes, our
        // blinding math and BCH-Schnorr verify agree with the reference.
        for _ in 0..25 {
            let signer = Signer::new();
            let pubkey = signer.pubkey();
            let msg: [u8; 32] = Sha256::digest(b"a fusion component").into();

            let req = BlindSignatureRequest::new(&pubkey, &signer.r(), msg).unwrap();
            let e = req.request();
            let s = signer.sign(&e);
            // finalize with check=true internally verifies; also verify explicitly.
            let sig = req.finalize(&s, true).unwrap();
            assert!(verify(&pubkey, &sig, &msg), "unblinded sig must verify");
        }
    }

    #[test]
    fn unblinding_is_unlinkable_signer_never_sees_the_output() {
        // The signer sees (R, e); the world sees (R'.x, s'). They must differ, or
        // there'd be no blinding. (Sanity check, not a formal unlinkability proof.)
        let signer = Signer::new();
        let msg: [u8; 32] = Sha256::digest(b"component").into();
        let req = BlindSignatureRequest::new(&signer.pubkey(), &signer.r(), msg).unwrap();
        let sig = req.finalize(&signer.sign(&req.request()), true).unwrap();
        // R'.x (first 32 of sig) should not equal the signer's R.x.
        let signer_rx = &signer.r()[1..];
        assert_ne!(&sig[..32], signer_rx);
    }

    #[test]
    fn verify_rejects_a_tampered_signature() {
        let signer = Signer::new();
        let msg: [u8; 32] = Sha256::digest(b"pay 1000").into();
        let req = BlindSignatureRequest::new(&signer.pubkey(), &signer.r(), msg).unwrap();
        let mut sig = req.finalize(&signer.sign(&req.request()), true).unwrap();
        sig[40] ^= 0x01; // flip a bit in s
        assert!(!verify(&signer.pubkey(), &sig, &msg));
    }

    #[test]
    fn finalize_check_catches_a_cheating_signer() {
        // A signer that returns garbage s must be caught by finalize(check=true).
        let signer = Signer::new();
        let msg: [u8; 32] = Sha256::digest(b"c").into();
        let req = BlindSignatureRequest::new(&signer.pubkey(), &signer.r(), msg).unwrap();
        let bad_s = [0x11u8; 32];
        assert!(req.finalize(&bad_s, true).is_err());
    }

    #[test]
    fn known_generator_sanity() {
        // G compressed must be the standard secp256k1 generator encoding.
        let g = compressed(&ProjectivePoint::GENERATOR);
        assert_eq!(
            hex(&g),
            "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        );
        // and the affine round-trips through our GroupEncoding import.
        assert_eq!(ProjectivePoint::GENERATOR.to_affine().to_bytes().as_slice(), &g);
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}
