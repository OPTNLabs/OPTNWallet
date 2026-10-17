//! The HPKE under optn-chat's MLS (vendor/hpke-rs-0.6.1, through MDK 0.8 and
//! openmls_rust_crypto) reproduces RFC 9180's published test vectors for
//! DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM: Appendix A.1.1 (base
//! mode) and A.1.2 (PSK mode).
//!
//! The key schedule context RFC 9180 lists for each, `mode || psk_id_hash ||
//! info_hash`, comes from the two LabeledExtract calls whose salt OPTN's copy
//! writes differently from upstream (see vendor/hpke-rs-0.6.1/OPTN.md), and
//! every exported value below depends on it. A change to that salt that moved
//! a single byte would fail here, as would any other drift in the patched
//! crate, and every peer would then derive different MLS keys.

use hpke_rs::hpke_types::{AeadAlgorithm, KdfAlgorithm, KemAlgorithm};
use hpke_rs::rustcrypto::HpkeRustCrypto;
use hpke_rs::{Hpke, Mode};

fn bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
        .collect()
}

/// `exporter_context`, `exported_value` pairs, all with L = 32.
type Exports<'a> = [(&'a str, &'a str); 3];

fn check(mode: Mode, shared_secret: &str, psk: &str, psk_id: &str, exports: Exports<'_>) {
    let hpke = Hpke::<HpkeRustCrypto>::new(
        mode,
        KemAlgorithm::DhKem25519,
        KdfAlgorithm::HkdfSha256,
        AeadAlgorithm::Aes128Gcm,
    );
    // "Ode on a Grecian Urn", A.1's info for every vector.
    let info = bytes("4f6465206f6e2061204772656369616e2055726e");
    let context = hpke
        .key_schedule(&bytes(shared_secret), &info, &bytes(psk), &bytes(psk_id))
        .expect("the RFC's inputs are valid");
    for (exporter_context, expected) in exports {
        assert_eq!(
            context
                .export(&bytes(exporter_context), 32)
                .expect("32 bytes export"),
            bytes(expected),
            "exporter_context {exporter_context:?}"
        );
    }
}

#[test]
fn base_mode_matches_rfc_9180_a_1_1() {
    check(
        Mode::Base,
        "fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc",
        "",
        "",
        [
            (
                "",
                "3853fe2b4035195a573ffc53856e77058e15d9ea064de3e59f4961d0095250ee",
            ),
            (
                "00",
                "2e8f0b54673c7029649d4eb9d5e33bf1872cf76d623ff164ac185da9e88c21a5",
            ),
            (
                "54657374436f6e74657874",
                "e9e43065102c3836401bed8c3c3c75ae46be1639869391d62c61f1ec7af54931",
            ),
        ],
    );
}

#[test]
fn psk_mode_matches_rfc_9180_a_1_2() {
    check(
        Mode::Psk,
        "727699f009ffe3c076315019c69648366b69171439bd7dd0807743bde76986cd",
        "0247fd33b913760fa1fa51e1892d9f307fbe65eb171e8132c2af18555a738b82",
        "456e6e796e20447572696e206172616e204d6f726961",
        [
            (
                "",
                "dff17af354c8b41673567db6259fd6029967b4e1aad13023c2ae5df8f4f43bf6",
            ),
            (
                "00",
                "6a847261d8207fe596befb52928463881ab493da345b10e1dcc645e3b94e2d95",
            ),
            (
                "54657374436f6e74657874",
                "8aff52b45a1be3a734bc7a41e20b4e055ad4c4d22104b0c20285a7c4302401cd",
            ),
        ],
    );
}
