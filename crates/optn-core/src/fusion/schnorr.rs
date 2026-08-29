// BCH Schnorr signatures + the CashFusion blind-signature protocol.
//
// Matches Electron Cash (electroncash/schnorr.py) exactly, so blind signatures
// built here unblind to signatures a fusion server — and BCH consensus — will
// accept.
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
//
// This lived twice: once here in Rust for the desktop backend and once in
// TypeScript for the browser-side P2P round, whose own header said the two had
// to match. Two hand-kept implementations of a blind signature scheme is the
// kind of duplication that goes wrong quietly — the failure is not a crash but
// a signature the other side rejects, mid-round.
//
// Randomness is the caller's. `a`, `b` and the issuer's key and nonces are
// parameters, not internals, so this compiles to wasm32 without a getrandom
// shim and so every value below is reproducible from a test vector. The
// platform layers keep their own thin constructors over the OS CSPRNG.
use hmac::{Hmac, Mac};
use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::{Group, PrimeField};
use k256::{AffinePoint, EncodedPoint, ProjectivePoint, Scalar, U256};
use num_bigint::BigUint;
use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};

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
pub fn parse_point(bytes: &[u8]) -> Result<ProjectivePoint, String> {
    let ep =
        EncodedPoint::from_bytes(bytes).map_err(|_| "point could not be parsed".to_string())?;
    Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&ep))
        .map(ProjectivePoint::from)
        .ok_or_else(|| "point not on curve".to_string())
}

/// Reduce 32 big-endian bytes into a scalar mod the group order n.
pub fn scalar_reduce(bytes: [u8; 32]) -> Scalar {
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

/// The compressed pubkey for a private scalar.
pub fn pubkey_compressed(privkey: Scalar) -> [u8; 33] {
    compressed(&(ProjectivePoint::GENERATOR * privkey))
}

/// The BCH Schnorr challenge e = sha256(R.x || compressed(P) || msg32), mod n.
pub fn challenge(rx: &[u8; 32], pubkey_point: &ProjectivePoint, msg32: &[u8; 32]) -> Scalar {
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

    // s must be canonical (< n); a signer sending s >= n is invalid.
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

/// Electron Cash / libsecp256k1's modified RFC6979 nonce derivation, algorithm
/// domain `Schnorr+SHA256  `. Deterministic on purpose: it removes an RNG
/// dependence for long-lived wallet keys and makes interop vectors reproducible.
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

/// Create a BCH Schnorr signature (64 bytes: R.x || s) over `msg32`. Forces R to
/// have a quadratic-residue y per the BCH convention so it verifies. Byte-for-byte
/// compatible with Electron Cash and accepted by BCH consensus.
pub fn sign(privkey: Scalar, msg32: &[u8; 32]) -> [u8; 64] {
    let pubkey_point = ProjectivePoint::GENERATOR * privkey;
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

/// Requester side of the CashFusion blind Schnorr signature.
///
/// Construct one per component with the issuer's `round_pubkey`, one of its
/// nonce points `R`, and the 32-byte message hash. `request()` is the 32-byte
/// scalar sent to the issuer; feed the issuer's 32-byte response to `finalize()`
/// to get the unblinded 64-byte signature.
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
    /// Blinding factors are parameters rather than drawn here. They must be
    /// uniform, secret, and never reused — a repeated `a` across two requests
    /// against the same nonce breaks unlinkability.
    pub fn new_with_blinding(
        round_pubkey: &[u8],
        r: &[u8],
        message_hash: [u8; 32],
        a: Scalar,
        b: Scalar,
    ) -> Result<Self, String> {
        let pubkey_point = parse_point(round_pubkey)?;
        let r_point = parse_point(r)?;

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

    /// The 32-byte blinded challenge to send to the issuer.
    pub fn request(&self) -> [u8; 32] {
        self.e.to_bytes().into()
    }

    /// Unblind the issuer's 32-byte response into the final 64-byte signature.
    /// With `check`, verifies the result under the round pubkey and returns an
    /// error if the issuer cheated.
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
                return Err("blind signature verification failed — issuer cheated".into());
            }
        }
        Ok(sig)
    }
}

/// Blind-signature **issuer**: the CashFusion server role, and the elected P2P
/// coordinator role.
///
/// Holds a round private key `x` and a pool of one-shot nonces `k_i`. Each
/// `R_i = k_i·G` is published once; signing a blinded challenge at index `i`
/// **consumes** `k_i`. Reusing a nonce across two different challenges would
/// leak `x` (classic Schnorr nonce reuse), so the second call at the same index
/// is a hard error — not a silent re-sign.
pub struct BlindIssuer {
    x: Scalar,
    /// `Some(k)` while unused; `None` once the slot is consumed. Index is stable
    /// for the life of the issuer.
    nonces: Vec<Option<Scalar>>,
}

impl BlindIssuer {
    /// The key and nonces are supplied by the caller, which owns the CSPRNG.
    pub fn from_parts(x: Scalar, nonces: Vec<Scalar>) -> Result<Self, String> {
        if nonces.is_empty() {
            return Err("BlindIssuer needs at least one nonce slot".into());
        }
        if nonces.len() > 1024 {
            return Err("BlindIssuer refuses more than 1024 nonce slots".into());
        }
        Ok(Self {
            x,
            nonces: nonces.into_iter().map(Some).collect(),
        })
    }

    /// Compressed round pubkey `P = x·G` — published in StartRound.
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

    /// All nonce points in slot order, `None` at consumed indices so callers
    /// that publish the vector once at round start keep stable indexing.
    pub fn r_points(&self) -> Vec<Option<[u8; 33]>> {
        self.nonces
            .iter()
            .map(|slot| {
                slot.as_ref()
                    .map(|k| compressed(&(ProjectivePoint::GENERATOR * k)))
            })
            .collect()
    }

    /// Number of slots this issuer was created with (used and unused).
    pub fn capacity(&self) -> usize {
        self.nonces.len()
    }

    /// Sign a blinded challenge `e` at `index`, consuming that slot. Returns the
    /// 32-byte scalar `s = k + e·x`. A second call at the same index fails —
    /// it never reuses `k`.
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

    /// Deterministic stand-ins for values the platform would draw from a CSPRNG.
    fn scalar(seed: u8) -> Scalar {
        let mut bytes = [0u8; 32];
        bytes[0] = seed.wrapping_add(1);
        bytes[31] = seed.wrapping_mul(3).wrapping_add(5);
        Option::<Scalar>::from(Scalar::from_repr(bytes.into())).expect("in range")
    }

    fn msg(text: &[u8]) -> [u8; 32] {
        Sha256::digest(text).into()
    }

    #[test]
    fn a_signature_verifies_under_its_own_key() {
        let x = scalar(1);
        let m = msg(b"a fusion component");
        let sig = sign(x, &m);
        assert!(verify(&pubkey_compressed(x), &sig, &m));
    }

    #[test]
    fn signing_is_deterministic() {
        // RFC6979 with the Schnorr+SHA256 domain: the same key and message must
        // always give the same bytes, or the interop vectors mean nothing.
        let x = scalar(2);
        let m = msg(b"determinism");
        assert_eq!(sign(x, &m), sign(x, &m));
    }

    #[test]
    fn a_signature_does_not_verify_for_another_message_or_key() {
        let x = scalar(3);
        let m = msg(b"the real message");
        let sig = sign(x, &m);
        assert!(!verify(
            &pubkey_compressed(x),
            &sig,
            &msg(b"a different message")
        ));
        assert!(!verify(&pubkey_compressed(scalar(4)), &sig, &m));
    }

    #[test]
    fn a_tampered_signature_is_rejected() {
        let x = scalar(5);
        let m = msg(b"tamper");
        let mut sig = sign(x, &m);
        sig[63] ^= 0x01;
        assert!(!verify(&pubkey_compressed(x), &sig, &m));
    }

    #[test]
    fn a_non_canonical_s_is_rejected() {
        // s >= n must fail rather than be reduced: accepting it would make
        // signatures malleable.
        let x = scalar(6);
        let m = msg(b"canonical");
        let mut sig = sign(x, &m);
        sig[32..].copy_from_slice(&[0xff; 32]);
        assert!(!verify(&pubkey_compressed(x), &sig, &m));
    }

    #[test]
    fn blind_round_trip_produces_a_valid_signature() {
        // Full flow: request -> issuer -> finalize -> verify. Several blinding
        // pairs, because the c = -1 branch only fires about half the time.
        for seed in 0u8..24 {
            let mut issuer =
                BlindIssuer::from_parts(scalar(seed), vec![scalar(seed.wrapping_add(64))]).unwrap();
            let pubkey = issuer.pubkey();
            let r = issuer.r_point(0).unwrap();
            let m = msg(b"a fusion component");

            let req = BlindSignatureRequest::new_with_blinding(
                &pubkey,
                &r,
                m,
                scalar(seed.wrapping_add(128)),
                scalar(seed.wrapping_add(192)),
            )
            .unwrap();
            let e = req.request();
            let s = issuer.sign(0, &e).unwrap();
            let sig = req.finalize(&s, true).unwrap();
            assert!(verify(&pubkey, &sig, &m), "unblinded sig must verify");
        }
    }

    #[test]
    fn the_issuer_never_sees_what_it_signed() {
        // The issuer sees (R, e); the world sees (R'.x, s'). They must differ,
        // or there is no blinding at all.
        let mut issuer = BlindIssuer::from_parts(scalar(7), vec![scalar(8)]).unwrap();
        let pubkey = issuer.pubkey();
        let r = issuer.r_point(0).unwrap();
        let m = msg(b"unlinkable");

        let req = BlindSignatureRequest::new_with_blinding(&pubkey, &r, m, scalar(9), scalar(10))
            .unwrap();
        let e = req.request();
        let s = issuer.sign(0, &e).unwrap();
        let sig = req.finalize(&s, true).unwrap();

        assert_ne!(&sig[..32], &r[1..]);
        assert_ne!(&sig[32..], &e[..]);
        assert_ne!(&sig[32..], &s[..]);
    }

    #[test]
    fn a_nonce_slot_cannot_be_used_twice() {
        // Reuse would leak the round key. It has to be an error, not a re-sign.
        let mut issuer = BlindIssuer::from_parts(scalar(11), vec![scalar(12)]).unwrap();
        assert!(issuer.sign(0, &[7u8; 32]).is_ok());
        assert!(issuer.sign(0, &[8u8; 32]).is_err());
        assert!(issuer.r_point(0).is_err());
    }

    #[test]
    fn finalize_rejects_a_cheating_issuer() {
        let mut issuer = BlindIssuer::from_parts(scalar(13), vec![scalar(14)]).unwrap();
        let pubkey = issuer.pubkey();
        let r = issuer.r_point(0).unwrap();
        let m = msg(b"cheat");
        let req = BlindSignatureRequest::new_with_blinding(&pubkey, &r, m, scalar(15), scalar(16))
            .unwrap();
        let mut s = issuer.sign(0, &req.request()).unwrap();
        s[0] ^= 0xff;
        assert!(req.finalize(&s, true).is_err());
    }
}
