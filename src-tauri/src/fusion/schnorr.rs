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

use hmac::{Hmac, Mac};
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
pub(crate) fn parse_point(bytes: &[u8]) -> Result<ProjectivePoint, String> {
    let ep =
        EncodedPoint::from_bytes(bytes).map_err(|_| "point could not be parsed".to_string())?;
    Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&ep))
        .map(ProjectivePoint::from)
        .ok_or_else(|| "point not on curve".to_string())
}

/// Reduce 32 big-endian bytes into a scalar mod the group order n.
pub(crate) fn scalar_reduce(bytes: [u8; 32]) -> Scalar {
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

/// Compressed 33-byte encoding of a point.
pub fn compressed(point: &ProjectivePoint) -> [u8; 33] {
    let ep = point.to_affine().to_encoded_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(ep.as_bytes());
    out
}

/// A fresh secp256k1 keypair for a per-component communication key. Returns the
/// private scalar (kept for decrypting blame proofs) and its compressed pubkey.
pub fn gen_keypair() -> (Scalar, [u8; 33]) {
    let k = random_nonce();
    let pub_c = compressed(&(ProjectivePoint::GENERATOR * k));
    (k, pub_c)
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

/// Create a BCH Schnorr signature (64 bytes: R.x || s) over `msg32` with
/// `privkey`. Uses Electron Cash/libsecp256k1's modified RFC6979 nonce derivation
/// (algorithm domain `Schnorr+SHA256  `), and forces R to have a
/// quadratic-residue y per the BCH convention so it verifies. The result is
/// byte-for-byte compatible with Electron Cash and accepted by BCH consensus.
fn deterministic_nonce(privkey: &Scalar, msg32: &[u8; 32]) -> Scalar {
    type HmacSha256 = Hmac<Sha256>;
    const ALGO16: &[u8; 16] = b"Schnorr+SHA256  ";
    let mut v = [1u8; 32];
    let mut k = [0u8; 32];
    let key: [u8; 32] = privkey.to_bytes().into();
    let mut blob = Vec::with_capacity(80);
    blob.extend_from_slice(&key);
    blob.extend_from_slice(msg32);
    blob.extend_from_slice(ALGO16);

    let mut mac = HmacSha256::new_from_slice(&k).expect("HMAC accepts any key size");
    mac.update(&v);
    mac.update(&[0]);
    mac.update(&blob);
    k.copy_from_slice(&mac.finalize().into_bytes());
    let mut mac = HmacSha256::new_from_slice(&k).expect("HMAC accepts any key size");
    mac.update(&v);
    v.copy_from_slice(&mac.finalize().into_bytes());

    let mut mac = HmacSha256::new_from_slice(&k).expect("HMAC accepts any key size");
    mac.update(&v);
    mac.update(&[1]);
    mac.update(&blob);
    k.copy_from_slice(&mac.finalize().into_bytes());
    let mut mac = HmacSha256::new_from_slice(&k).expect("HMAC accepts any key size");
    mac.update(&v);
    v.copy_from_slice(&mac.finalize().into_bytes());

    loop {
        let mut mac = HmacSha256::new_from_slice(&k).expect("HMAC accepts any key size");
        mac.update(&v);
        v.copy_from_slice(&mac.finalize().into_bytes());
        if let Some(nonce) = Option::<Scalar>::from(Scalar::from_repr(v.into())) {
            if !bool::from(nonce.is_zero()) {
                return nonce;
            }
        }
        let mut mac = HmacSha256::new_from_slice(&k).expect("HMAC accepts any key size");
        mac.update(&v);
        mac.update(&[0]);
        k.copy_from_slice(&mac.finalize().into_bytes());
        let mut mac = HmacSha256::new_from_slice(&k).expect("HMAC accepts any key size");
        mac.update(&v);
        v.copy_from_slice(&mac.finalize().into_bytes());
    }
}

pub fn sign(privkey: Scalar, msg32: &[u8; 32]) -> [u8; 64] {
    let pubkey_point = ProjectivePoint::GENERATOR * privkey;
    // Electron Cash/libsecp256k1's modified RFC6979 nonce function. The
    // 16-byte algorithm domain is consensus-independent, but exact parity is
    // important for reproducible interop vectors and avoids RNG dependence for
    // long-lived wallet transaction keys. Blind/Pedersen nonces remain CSPRNG.
    let k0 = deterministic_nonce(&privkey, msg32);
    let r_point = ProjectivePoint::GENERATOR * k0;
    let (rx, ry) = affine_xy(&r_point);
    // Force jacobi(R.y) = +1: only R.x travels, so the verifier reconstructs the
    // R whose y is a QR; flip k if ours isn't.
    let k = if y_is_quadratic_residue(&ry) { k0 } else { -k0 };
    let e = challenge(&rx, &pubkey_point, msg32);
    let s = k + e * privkey;

    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&rx);
    sig[32..].copy_from_slice(&s.to_bytes());
    sig
}

/// The compressed pubkey for a private scalar (for building P2PKH scriptCode etc.).
pub fn pubkey_compressed(privkey: Scalar) -> [u8; 33] {
    compressed(&(ProjectivePoint::GENERATOR * privkey))
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

        Ok(Self {
            pubkey_point,
            message_hash,
            a,
            rx_new,
            sign_flip,
            e,
        })
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

/// Production blind-signature **issuer** (the CashFusion server role, and the
/// elected P2P coordinator role).
///
/// Holds a long-lived round private key `x` and a pool of one-shot nonces `k_i`.
/// Each `R_i = k_i·G` is published once; signing a blinded challenge at index `i`
/// **consumes** `k_i`. Reusing a nonce across two different challenges would leak
/// `x` (classic Schnorr nonce reuse), so the second call at the same index is a
/// hard error — not a silent re-sign.
///
/// Mirrors Electron Cash `schnorr.BlindSigner`, with the one-shot invariant made
/// explicit for the P2P case where the issuer is a peer rather than a dedicated
/// server process.
pub struct BlindIssuer {
    x: Scalar,
    /// `Some(k)` while unused; `None` after the slot is consumed or if never
    /// allocated. Index is stable for the life of the issuer.
    nonces: Vec<Option<Scalar>>,
}

impl BlindIssuer {
    /// Create an issuer with `num_nonces` fresh one-shot slots. Callers must
    /// size this to every component that will need a credential this round
    /// (e.g. participants × max-components-per-peer).
    pub fn new(num_nonces: usize) -> Result<Self, String> {
        if num_nonces == 0 {
            return Err("BlindIssuer needs at least one nonce slot".into());
        }
        if num_nonces > 1024 {
            return Err("BlindIssuer refuses more than 1024 nonce slots".into());
        }
        Ok(Self {
            x: random_nonce(),
            nonces: (0..num_nonces).map(|_| Some(random_nonce())).collect(),
        })
    }

    /// Compressed round pubkey `P = x·G` — published in StartRound / credential_params.
    pub fn pubkey(&self) -> [u8; 33] {
        compressed(&(ProjectivePoint::GENERATOR * self.x))
    }

    /// Compressed nonce point `R_i = k_i·G` for an unused slot. Errors if the
    /// index is out of range or the slot was already consumed (there is no `k`
    /// left to re-derive R from).
    pub fn r_point(&self, index: usize) -> Result<[u8; 33], String> {
        let k = self
            .nonces
            .get(index)
            .and_then(|slot| slot.as_ref())
            .ok_or_else(|| format!("blind nonce slot {index} is missing or already used"))?;
        Ok(compressed(&(ProjectivePoint::GENERATOR * k)))
    }

    /// All currently-unused R points, in slot order. Consumed slots are omitted
    /// from the list only if you filter — this returns `None` at consumed indices
    /// so callers that publish the full vector once at round start can keep
    /// stable indexing.
    pub fn r_points(&self) -> Vec<Option<[u8; 33]>> {
        self.nonces
            .iter()
            .map(|slot| {
                slot.as_ref()
                    .map(|k| compressed(&(ProjectivePoint::GENERATOR * k)))
            })
            .collect()
    }

    /// Number of slots this issuer was created with (used + unused).
    pub fn capacity(&self) -> usize {
        self.nonces.len()
    }

    /// Sign a blinded challenge `e` at `index`, consuming that slot.
    /// Returns the 32-byte scalar `s = k + e·x`. A second call at the same
    /// index fails — never reuses `k`.
    pub fn sign(&mut self, index: usize, e_bytes: &[u8; 32]) -> Result<[u8; 32], String> {
        if index >= self.nonces.len() {
            return Err(format!("blind nonce index {index} out of range"));
        }
        let k = self.nonces[index]
            .take()
            .ok_or_else(|| format!("blind nonce slot {index} already used"))?;
        let e = scalar_reduce(*e_bytes);
        let s = k + e * self.x;
        Ok(s.to_bytes().into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::elliptic_curve::group::GroupEncoding;

    #[test]
    fn blind_round_trip_produces_a_valid_bch_schnorr_signature() {
        // Full flow: request -> issuer -> finalize -> verify. If this passes, our
        // blinding math and BCH-Schnorr verify agree with the reference.
        for _ in 0..25 {
            let mut issuer = BlindIssuer::new(1).unwrap();
            let pubkey = issuer.pubkey();
            let r = issuer.r_point(0).unwrap();
            let msg: [u8; 32] = Sha256::digest(b"a fusion component").into();

            let req = BlindSignatureRequest::new(&pubkey, &r, msg).unwrap();
            let e = req.request();
            let s = issuer.sign(0, &e).unwrap();
            // finalize with check=true internally verifies; also verify explicitly.
            let sig = req.finalize(&s, true).unwrap();
            assert!(verify(&pubkey, &sig, &msg), "unblinded sig must verify");
        }
    }

    #[test]
    fn unblinding_is_unlinkable_signer_never_sees_the_output() {
        // The issuer sees (R, e); the world sees (R'.x, s'). They must differ, or
        // there'd be no blinding. (Sanity check, not a formal unlinkability proof.)
        let mut issuer = BlindIssuer::new(1).unwrap();
        let r = issuer.r_point(0).unwrap();
        let msg: [u8; 32] = Sha256::digest(b"component").into();
        let req = BlindSignatureRequest::new(&issuer.pubkey(), &r, msg).unwrap();
        let sig = req
            .finalize(&issuer.sign(0, &req.request()).unwrap(), true)
            .unwrap();
        // R'.x (first 32 of sig) should not equal the issuer's R.x.
        let signer_rx = &r[1..];
        assert_ne!(&sig[..32], signer_rx);
    }

    #[test]
    fn verify_rejects_a_tampered_signature() {
        let mut issuer = BlindIssuer::new(1).unwrap();
        let r = issuer.r_point(0).unwrap();
        let msg: [u8; 32] = Sha256::digest(b"pay 1000").into();
        let req = BlindSignatureRequest::new(&issuer.pubkey(), &r, msg).unwrap();
        let mut sig = req
            .finalize(&issuer.sign(0, &req.request()).unwrap(), true)
            .unwrap();
        sig[40] ^= 0x01; // flip a bit in s
        assert!(!verify(&issuer.pubkey(), &sig, &msg));
    }

    #[test]
    fn finalize_check_catches_a_cheating_signer() {
        // An issuer that returns garbage s must be caught by finalize(check=true).
        let issuer = BlindIssuer::new(1).unwrap();
        let r = issuer.r_point(0).unwrap();
        let msg: [u8; 32] = Sha256::digest(b"c").into();
        let req = BlindSignatureRequest::new(&issuer.pubkey(), &r, msg).unwrap();
        let bad_s = [0x11u8; 32];
        assert!(req.finalize(&bad_s, true).is_err());
    }

    #[test]
    fn issuer_refuses_to_reuse_a_nonce_slot() {
        // Nonce reuse leaks x. The second sign at the same index must hard-fail.
        let mut issuer = BlindIssuer::new(2).unwrap();
        let e1 = [0x01u8; 32];
        let e2 = [0x02u8; 32];
        assert!(issuer.sign(0, &e1).is_ok());
        let err = issuer.sign(0, &e2).unwrap_err();
        assert!(
            err.contains("already used"),
            "expected already-used error, got: {err}"
        );
        // A different slot still works.
        assert!(issuer.sign(1, &e2).is_ok());
        // And that slot is then spent too.
        assert!(issuer.sign(1, &e1).unwrap_err().contains("already used"));
    }

    #[test]
    fn issuer_r_point_disappears_after_sign() {
        let mut issuer = BlindIssuer::new(1).unwrap();
        assert!(issuer.r_point(0).is_ok());
        issuer.sign(0, &[0x03u8; 32]).unwrap();
        assert!(issuer.r_point(0).unwrap_err().contains("already used"));
    }

    #[test]
    fn sign_produces_a_verifiable_bch_schnorr_signature() {
        for _ in 0..25 {
            let priv_k = random_nonce();
            let pubkey = pubkey_compressed(priv_k);
            let msg: [u8; 32] = Sha256::digest(b"an input sighash").into();
            let sig = sign(priv_k, &msg);
            assert!(verify(&pubkey, &sig, &msg), "own signature must verify");
            // Wrong message must not verify.
            let other: [u8; 32] = Sha256::digest(b"different").into();
            assert!(!verify(&pubkey, &sig, &other));
        }
    }

    #[test]
    fn transaction_signature_matches_electron_cash_golden_vector() {
        // Electron Cash electroncash/tests/test_schnorr.py, itself copied from
        // Bitcoin ABC src/test/key_tests.cpp.
        let privkey = Scalar::from_repr(
            hex32("12b004fff7f4b69ef8650e767f18f11ede158148b425660723b9f9a66e61f747").into(),
        )
        .unwrap();
        let msg = hex32("5255683da567900bfd3e786ed8836a4e7763c221bf1ac20ece2a5171b9199e8a");
        assert_eq!(
            hex(&sign(privkey, &msg)),
            "2c56731ac2f7a7e7f11518fc7722a166b02438924ca9d8b4d111347b81d0717571846de67ad3d913a8fdf9d8f3f73161a4c48ae81cb183b214765feb86e255ce"
        );
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
        assert_eq!(
            ProjectivePoint::GENERATOR.to_affine().to_bytes().as_slice(),
            &g
        );
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn hex32(value: &str) -> [u8; 32] {
        let decoded = hex::decode(value).unwrap();
        decoded.try_into().unwrap()
    }
}
