//! The OpenMLS crypto under MDK 0.8 (vendor/openmls_rust_crypto-0.5.1 and
//! vendor/openmls_basic_credential-0.5.0) after their move to p256 0.14,
//! ed25519-dalek 3 and hpke-rs 0.8 (see each OPTN.md).
//!
//! Signing is pinned to published answers: RFC 6979 A.2.5 (P-256, SHA-256,
//! message "sample"), whose nonce is deterministic, so the DER signature is
//! exact, and RFC 8032 section 7.1 test 1 (Ed25519, empty message). Key
//! generation must keep the stored formats: a 32-byte private scalar and a
//! 65-byte uncompressed SEC1 point for P-256, 32 bytes each for Ed25519.

use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::signatures::Signer;
use openmls_traits::types::{
    CryptoError, HpkeAeadType, HpkeConfig, HpkeKdfType, HpkeKemType, SignatureScheme,
};

const P256: SignatureScheme = SignatureScheme::ECDSA_SECP256R1_SHA256;
const ED25519: SignatureScheme = SignatureScheme::ED25519;

fn bytes(hex: &str) -> Vec<u8> {
    hex::decode(hex).expect("hex")
}

/// RFC 6979 A.2.5: private key x, public key U, and the SHA-256 signature
/// (r, s) over "sample", DER-encoded as OpenMLS stores ECDSA signatures.
fn rfc6979_p256() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    (
        bytes("c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721"),
        bytes(
            "0460fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6\
             7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299",
        ),
        bytes(
            "3046022100efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716\
             022100f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8",
        ),
    )
}

/// RFC 8032 section 7.1, test 1: secret key, public key, signature of "".
fn rfc8032_test1() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    (
        bytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"),
        bytes("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
        bytes(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155\
             5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
        ),
    )
}

#[test]
fn p256_signing_reproduces_rfc6979() {
    let crypto = RustCrypto::default();
    let (private, public, signature) = rfc6979_p256();
    assert_eq!(crypto.sign(P256, b"sample", &private).unwrap(), signature);
    crypto
        .verify_signature(P256, b"sample", &public, &signature)
        .expect("the RFC's signature verifies");
    assert_eq!(
        crypto.verify_signature(P256, b"sampLe", &public, &signature),
        Err(CryptoError::InvalidSignature)
    );
}

#[test]
fn p256_signing_refuses_a_key_of_the_wrong_length() {
    let crypto = RustCrypto::default();
    for key in [vec![1u8; 31], vec![1u8; 33]] {
        assert_eq!(
            crypto.sign(P256, b"sample", &key),
            Err(CryptoError::InvalidLength),
            "a {}-byte key",
            key.len()
        );
    }
}

#[test]
fn ed25519_signing_reproduces_rfc8032() {
    let crypto = RustCrypto::default();
    let (private, public, signature) = rfc8032_test1();
    assert_eq!(crypto.sign(ED25519, b"", &private).unwrap(), signature);
    crypto
        .verify_signature(ED25519, b"", &public, &signature)
        .expect("the RFC's signature verifies");
    assert_eq!(
        crypto.verify_signature(ED25519, b"x", &public, &signature),
        Err(CryptoError::InvalidSignature)
    );
}

#[test]
fn generated_keys_keep_their_stored_formats_and_sign() {
    let crypto = RustCrypto::default();
    for (scheme, private_len, public_len) in [(P256, 32, 65), (ED25519, 32, 32)] {
        let (private, public) = crypto.signature_key_gen(scheme).unwrap();
        assert_eq!(private.len(), private_len, "{scheme:?} private key");
        assert_eq!(public.len(), public_len, "{scheme:?} public key");
        if scheme == P256 {
            assert_eq!(public[0], 0x04, "an uncompressed SEC1 point");
        }
        let signature = crypto.sign(scheme, b"payload", &private).unwrap();
        crypto
            .verify_signature(scheme, b"payload", &public, &signature)
            .expect("a fresh key's signature verifies");
    }
}

#[test]
fn basic_credentials_sign_with_both_schemes() {
    let crypto = RustCrypto::default();
    let (private, public, signature) = rfc6979_p256();
    let known = SignatureKeyPair::from_raw(P256, private, public);
    assert_eq!(known.sign(b"sample").unwrap(), signature);

    for scheme in [P256, ED25519] {
        let key_pair = SignatureKeyPair::new(scheme).unwrap();
        let signature = key_pair.sign(b"payload").unwrap();
        crypto
            .verify_signature(scheme, b"payload", key_pair.public(), &signature)
            .expect("a new credential's signature verifies");
    }
}

#[test]
fn hpke_seals_and_opens_with_p256_and_x25519() {
    let crypto = RustCrypto::default();
    for kem in [HpkeKemType::DhKemP256, HpkeKemType::DhKem25519] {
        let config = || HpkeConfig(kem, HpkeKdfType::HkdfSha256, HpkeAeadType::AesGcm128);
        let key_pair = crypto.derive_hpke_keypair(config(), &[7u8; 32]).unwrap();
        let sealed = crypto
            .hpke_seal(config(), &key_pair.public, b"info", b"aad", b"welcome")
            .unwrap();
        let opened = crypto
            .hpke_open(config(), &sealed, &key_pair.private, b"info", b"aad")
            .unwrap();
        assert_eq!(opened, b"welcome", "{kem:?}");
        assert!(
            crypto
                .hpke_open(config(), &sealed, &key_pair.private, b"info", b"other")
                .is_err(),
            "{kem:?} with the wrong aad"
        );
    }
}
