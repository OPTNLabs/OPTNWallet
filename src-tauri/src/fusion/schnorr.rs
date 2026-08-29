// BCH Schnorr + the CashFusion blind-signature protocol.
//
// The math lives in `optn_core::fusion::schnorr` and is shared with the
// browser-side P2P round through wasm, pinned by `test-vectors/fusion.json`.
// It used to live here, in parallel with a second hand-maintained TypeScript
// copy whose own header said the two had to match — with nothing checking it.
//
// What stays here is the randomness. The core takes nonces and blinding factors
// as parameters so it compiles to wasm32 without a getrandom shim and so its
// values are reproducible from vectors; this module is the desktop backend's
// binding of that to the OS CSPRNG.
pub use optn_core::fusion::schnorr::{
    challenge, compressed, parse_point, pubkey_compressed, scalar_reduce, sign, verify,
    BlindIssuer, BlindSignatureRequest,
};

use k256::{ProjectivePoint, Scalar};

use super::pedersen::random_nonce;

/// A fresh secp256k1 keypair for a per-component communication key. Returns the
/// private scalar (kept for decrypting blame proofs) and its compressed pubkey.
pub fn gen_keypair() -> (Scalar, [u8; 33]) {
    let k = random_nonce();
    let pub_c = compressed(&(ProjectivePoint::GENERATOR * k));
    (k, pub_c)
}

/// Blind a message for the issuer, drawing the blinding factors `a` and `b` from
/// the OS CSPRNG. They must never be reused: a repeated `a` against the same
/// nonce breaks the unlinkability the whole scheme exists for.
pub fn new_blind_request(
    round_pubkey: &[u8],
    r: &[u8],
    message_hash: [u8; 32],
) -> Result<BlindSignatureRequest, String> {
    BlindSignatureRequest::new_with_blinding(
        round_pubkey,
        r,
        message_hash,
        random_nonce(),
        random_nonce(),
    )
}

/// An issuer with `num_nonces` fresh one-shot slots, keyed from the OS CSPRNG.
/// Size it to every component that will need a credential this round.
pub fn new_blind_issuer(num_nonces: usize) -> Result<BlindIssuer, String> {
    if num_nonces == 0 {
        return Err("BlindIssuer needs at least one nonce slot".into());
    }
    if num_nonces > 1024 {
        return Err("BlindIssuer refuses more than 1024 nonce slots".into());
    }
    BlindIssuer::from_parts(
        random_nonce(),
        (0..num_nonces).map(|_| random_nonce()).collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn blind_round_trip_produces_a_valid_bch_schnorr_signature() {
        // The core has its own coverage with fixed blinding factors. This runs
        // the same flow against real randomness, which is what production does
        // and what would catch a bad CSPRNG binding here.
        for _ in 0..25 {
            let mut issuer = new_blind_issuer(1).unwrap();
            let pubkey = issuer.pubkey();
            let r = issuer.r_point(0).unwrap();
            let msg: [u8; 32] = Sha256::digest(b"a fusion component").into();

            let req = new_blind_request(&pubkey, &r, msg).unwrap();
            let e = req.request();
            let s = issuer.sign(0, &e).unwrap();
            let sig = req.finalize(&s, true).unwrap();
            assert!(verify(&pubkey, &sig, &msg), "unblinded sig must verify");
        }
    }

    #[test]
    fn unblinding_is_unlinkable_the_issuer_never_sees_the_output() {
        let mut issuer = new_blind_issuer(1).unwrap();
        let pubkey = issuer.pubkey();
        let r = issuer.r_point(0).unwrap();
        let msg: [u8; 32] = Sha256::digest(b"unlinkable").into();

        let req = new_blind_request(&pubkey, &r, msg).unwrap();
        let e = req.request();
        let s = issuer.sign(0, &e).unwrap();
        let sig = req.finalize(&s, true).unwrap();

        assert_ne!(&sig[..32], &r[1..]);
        assert_ne!(&sig[32..], &e[..]);
    }

    #[test]
    fn a_nonce_slot_is_one_shot() {
        let mut issuer = new_blind_issuer(2).unwrap();
        assert!(issuer.sign(0, &[3u8; 32]).is_ok());
        assert!(issuer.sign(0, &[4u8; 32]).is_err());
        assert!(issuer.sign(1, &[5u8; 32]).is_ok());
    }

    #[test]
    fn issuer_sizes_are_bounded() {
        assert!(new_blind_issuer(0).is_err());
        assert!(new_blind_issuer(1025).is_err());
        assert_eq!(new_blind_issuer(4).unwrap().capacity(), 4);
    }

    #[test]
    fn two_issuers_do_not_share_a_round_key() {
        // A binding that forgot to draw fresh randomness would produce equal
        // keys here and leak across rounds.
        assert_ne!(
            new_blind_issuer(1).unwrap().pubkey(),
            new_blind_issuer(1).unwrap().pubkey()
        );
    }
}
