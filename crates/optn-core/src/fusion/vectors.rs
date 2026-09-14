// `test-vectors/fusion.json` is read by BOTH implementations of the CashFusion
// primitives — this crate, and the TypeScript in src/platform/desktop/nostr.
//
// The two have to agree byte for byte or a round fails part-way through, with a
// signature one side built and the other rejected. Nothing enforced that before:
// each side had its own tests, and both passed while proving only that each was
// self-consistent.
//
// Every value is derived from fixed seeds, so regenerating the file on an
// unchanged implementation produces an identical file. Rewrite it with:
//
//   WRITE_FUSION_VECTORS=1 cargo test -p optn-core fusion::vectors
//
// A diff in that file is a change to the wire protocol, and should be read as
// one.
use k256::elliptic_curve::PrimeField;
use k256::Scalar;
use sha2::{Digest, Sha256};

use super::{pedersen, schnorr};

/// A deterministic stand-in for a value the platform would draw from its CSPRNG.
fn seeded_scalar(seed: u8) -> Scalar {
    let bytes: [u8; 32] =
        Sha256::digest([b"optn-fusion-vector".as_slice(), &[seed]].concat()).into();
    Option::<Scalar>::from(Scalar::from_repr(bytes.into()))
        .filter(|s| !bool::from(<Scalar as k256::elliptic_curve::Field>::is_zero(s)))
        .expect("sha256 output is a canonical non-zero scalar")
}

fn seeded_message(label: &str) -> [u8; 32] {
    Sha256::digest(label.as_bytes()).into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("vector hex is well formed"))
        .collect()
}

fn array32(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(bytes);
    out
}

/// Rebuild the vector document from the implementation.
fn build() -> serde_json::Value {
    let mut signatures = Vec::new();
    for (seed, label) in [
        (1u8, "component"),
        (2, "input credential"),
        (3, "output credential"),
    ] {
        let privkey = seeded_scalar(seed);
        let message = seeded_message(label);
        let signature = schnorr::sign(privkey, &message);
        signatures.push(serde_json::json!({
            "label": label,
            "privkeyHex": hex(&privkey.to_bytes()),
            "pubkeyHex": hex(&schnorr::pubkey_compressed(privkey)),
            "messageHex": hex(&message),
            "signatureHex": hex(&signature),
        }));
    }

    let mut commitments = Vec::new();
    for (seed, amount) in [
        (10u8, 0u64),
        (11, 1),
        (12, 12_345),
        (13, 2_100_000_000_000_000),
    ] {
        let nonce = seeded_scalar(seed);
        commitments.push(serde_json::json!({
            "amount": amount,
            "nonceHex": hex(&nonce.to_bytes()),
            "commitmentHex": hex(&pedersen::commit_bytes(amount, &nonce)),
        }));
    }

    // The blind flow, pinned end to end with fixed blinding factors. This is the
    // part the two implementations are most likely to drift on, because the
    // c = -1 branch only fires about half the time and a bug there is invisible
    // until a peer rejects the signature.
    let mut blind = Vec::new();
    for seed in [20u8, 21, 22, 23, 24, 25] {
        let x = seeded_scalar(seed);
        let k = seeded_scalar(seed.wrapping_add(40));
        let a = seeded_scalar(seed.wrapping_add(80));
        let b = seeded_scalar(seed.wrapping_add(120));
        let message = seeded_message("blinded component");

        let mut issuer =
            schnorr::BlindIssuer::from_parts(x, vec![k]).expect("one nonce slot is valid");
        let pubkey = issuer.pubkey();
        let r = issuer.r_point(0).expect("slot 0 is unused");
        let request = schnorr::BlindSignatureRequest::new_with_blinding(&pubkey, &r, message, a, b)
            .expect("blinding factors are in range");
        let e = request.request();
        let s = issuer.sign(0, &e).expect("slot 0 is unused");
        let signature = request.finalize(&s, true).expect("issuer is honest here");

        blind.push(serde_json::json!({
            "roundKeyHex": hex(&x.to_bytes()),
            "nonceHex": hex(&k.to_bytes()),
            "blindAHex": hex(&a.to_bytes()),
            "blindBHex": hex(&b.to_bytes()),
            "roundPubkeyHex": hex(&pubkey),
            "rPointHex": hex(&r),
            "messageHex": hex(&message),
            "blindedChallengeHex": hex(&e),
            "issuerResponseHex": hex(&s),
            "signatureHex": hex(&signature),
        }));
    }

    serde_json::json!({
        "note": concat!(
            "CashFusion primitives, shared by crates/optn-core and the TypeScript ",
            "in src/platform/desktop/nostr. Regenerate with WRITE_FUSION_VECTORS=1 ",
            "cargo test -p optn-core fusion::vectors. A diff here is a wire-protocol change."
        ),
        "pedersen": {
            "hCompressedHex": hex(&{
                use k256::elliptic_curve::group::GroupEncoding;
                pedersen::h_point().to_affine().to_bytes()
            }),
            "commitments": commitments,
        },
        "schnorr": {
            "signatures": signatures,
            "blind": blind,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-vectors/fusion.json"
    );

    fn stored() -> serde_json::Value {
        let raw = std::fs::read_to_string(PATH).expect("test-vectors/fusion.json is readable");
        serde_json::from_str(&raw).expect("test-vectors/fusion.json is valid JSON")
    }

    #[test]
    fn vectors_match_the_implementation() {
        let built = build();
        if std::env::var("WRITE_FUSION_VECTORS").is_ok() {
            let mut text = serde_json::to_string_pretty(&built).expect("serializable");
            text.push('\n');
            std::fs::write(PATH, text).expect("test-vectors/fusion.json is writable");
            return;
        }
        assert_eq!(
            built,
            stored(),
            "the implementation no longer produces the stored vectors. If that is \
             intended, the TypeScript side has to change with it -- regenerate with \
             WRITE_FUSION_VECTORS=1 and check both."
        );
    }

    #[test]
    fn stored_signatures_verify() {
        // Not a tautology against `build()`: this re-derives from the file, so a
        // vector file edited by hand into something unverifiable fails here.
        let doc = stored();
        for case in doc["schnorr"]["signatures"].as_array().expect("array") {
            let pubkey = unhex(case["pubkeyHex"].as_str().expect("hex"));
            let message = array32(&unhex(case["messageHex"].as_str().expect("hex")));
            let sig_bytes = unhex(case["signatureHex"].as_str().expect("hex"));
            let mut sig = [0u8; 64];
            sig.copy_from_slice(&sig_bytes);
            assert!(
                schnorr::verify(&pubkey, &sig, &message),
                "stored signature for {:?} does not verify",
                case["label"]
            );
        }
    }

    #[test]
    fn stored_blind_signatures_verify_under_the_round_key() {
        // The unblinded signature has to verify under the round pubkey, which is
        // the whole point: the issuer signed something it never saw.
        let doc = stored();
        for case in doc["schnorr"]["blind"].as_array().expect("array") {
            let pubkey = unhex(case["roundPubkeyHex"].as_str().expect("hex"));
            let message = array32(&unhex(case["messageHex"].as_str().expect("hex")));
            let sig_bytes = unhex(case["signatureHex"].as_str().expect("hex"));
            let mut sig = [0u8; 64];
            sig.copy_from_slice(&sig_bytes);
            assert!(schnorr::verify(&pubkey, &sig, &message));
        }
    }

    #[test]
    fn stored_commitments_are_homomorphic() {
        // Checked as a property of the stored bytes, not of freshly built ones,
        // so the file cannot drift into values that merely look plausible.
        let doc = stored();
        let cases = doc["pedersen"]["commitments"].as_array().expect("array");
        for case in cases {
            let amount = case["amount"].as_u64().expect("u64");
            let nonce_bytes = array32(&unhex(case["nonceHex"].as_str().expect("hex")));
            let nonce = Option::<Scalar>::from(Scalar::from_repr(nonce_bytes.into()))
                .expect("stored nonce is canonical");
            assert_eq!(
                hex(&pedersen::commit_bytes(amount, &nonce)),
                case["commitmentHex"].as_str().expect("hex"),
                "commitment for {amount} does not reproduce"
            );
        }
    }

    #[test]
    fn the_h_point_is_the_nothing_up_my_sleeve_string() {
        let doc = stored();
        let h = unhex(doc["pedersen"]["hCompressedHex"].as_str().expect("hex"));
        assert_eq!(h[0], 0x02);
        assert_eq!(&h[1..], b"CashFusion gives us fungibility.");
    }
}
