//! NIP-44 v2: the ciphertext under the wallet's chat and its CashFusion
//! coordination.
//!
//! Two peers who have never met agree a key from their own secret and the
//! other's public key, and every message after that is encrypted and
//! authenticated under it. The scheme is deliberately not an AEAD: ChaCha20
//! encrypts, HMAC-SHA256 authenticates separately over the nonce and the
//! ciphertext, and the two use keys derived apart.
//!
//! Three properties are the reason it is written this way, and each is a test
//! below.
//!
//! **Length is hidden by padding.** A short message and a long one must not be
//! distinguishable by their ciphertext size, so plaintext is padded up to a
//! power-of-two-derived bucket before encryption. Fusion coordination in
//! particular sends short, structured messages whose length would otherwise say
//! which step of the round a peer is on.
//!
//! **The MAC covers the nonce.** It is the associated data. A payload whose
//! nonce was swapped for another would otherwise decrypt to garbage under a
//! valid-looking tag.
//!
//! **The tag is compared in constant time.** A comparison that returns early on
//! the first wrong byte tells an attacker how much of a forged tag was right,
//! and a few thousand attempts turn that into a whole tag.
//!
//! There is no randomness here. The 32-byte nonce is a parameter, as the salt
//! and IV are everywhere else in this crate: entropy belongs to the caller, and
//! this stays buildable for wasm32 without a JS shim.
//!
//! **Conformance.** The published NIP-44 vectors are vendored at
//! `tests/vectors/nip44.vectors.json` and run against this code: 35
//! conversation keys, 32 message-key expansions, every padded length, ten
//! payloads compared byte for byte in both directions, three long messages up
//! to the 65535-byte limit checked by digest, and every invalid case refused.
//! So this is not merely self-consistent -- it produces the same bytes as the
//! reference implementation, which is what a peer on another client needs.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use chacha20::cipher::{KeyIvInit, StreamCipher};
use chacha20::ChaCha20;
use hmac::{Hmac, Mac};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::{PublicKey, SecretKey};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{CliError, Result};

type HmacSha256 = Hmac<Sha256>;

/// The only version this wallet writes, and the only one it reads.
pub const NIP44_VERSION: u8 = 2;

/// The HKDF salt that separates this scheme's keys from any other use of the
/// same ECDH secret.
///
/// These eight bytes are the specification's own constant, not a name this
/// module chose: NIP-44 fixes the salt as `utf8_encode("nip44-v2")`. The
/// module is called `nip44`, the version constant is `NIP44_VERSION`, and the
/// binding here is `HKDF_SALT` -- but the *value* is wire-visible and shared
/// with every other client, so changing these bytes to match our spelling
/// would derive a different conversation key and silently stop us talking to
/// anyone. Rename the binding freely; never touch the literal.
const HKDF_SALT: &[u8] = b"nip44-v2";

/// Shortest and longest plaintext, in bytes.
pub const MIN_PLAINTEXT_LEN: usize = 1;
pub const MAX_PLAINTEXT_LEN: usize = 65_535;

/// Shortest and longest base64 payload, which bound the work done before any
/// key material is touched.
pub const MIN_PAYLOAD_LEN: usize = 132;
pub const MAX_PAYLOAD_LEN: usize = 87_472;

/// The key two peers share for as long as their keys do.
///
/// Derived once per conversation and kept, because deriving it costs an ECDH
/// and every message uses it. Zeroized on drop, and its `Debug` prints nothing:
/// this is the value that decrypts the whole history.
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct ConversationKey([u8; 32]);

impl ConversationKey {
    /// Only for a key that came from somewhere else, already derived.
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// The bytes. Named so a call site reads as an exposure.
    pub const fn expose(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for ConversationKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ConversationKey(<redacted>)")
    }
}

/// Agree the conversation key with a peer.
///
/// The ECDH secret is the x-coordinate of the shared point, unhashed, exactly
/// as the spec says -- and then run through HKDF-extract with a scheme-specific
/// salt, which is what stops the same peer pair reusing this key anywhere else.
///
/// Nostr public keys are x-only. The even-Y point is the one meant, which is
/// the convention every implementation uses.
pub fn conversation_key(
    secret: &[u8; 32],
    their_xonly_pubkey: &[u8; 32],
) -> Result<ConversationKey> {
    let secret_key = SecretKey::from_slice(secret)
        .map_err(|_| CliError::Usage("not a valid secp256k1 secret key".into()))?;

    let mut compressed = [0u8; 33];
    compressed[0] = 0x02;
    compressed[1..].copy_from_slice(their_xonly_pubkey);
    let public_key = PublicKey::from_sec1_bytes(&compressed)
        .map_err(|_| CliError::Usage("not a point on the curve".into()))?;

    let shared = k256::ecdh::diffie_hellman(secret_key.to_nonzero_scalar(), public_key.as_affine());
    let mut x = [0u8; 32];
    x.copy_from_slice(shared.raw_secret_bytes().as_slice());

    let key = hkdf_extract(HKDF_SALT, &x);
    x.zeroize();
    Ok(ConversationKey(key))
}

/// The x-only public key for a secret, which is what a peer needs to reply.
pub fn xonly_public_key(secret: &[u8; 32]) -> Result<[u8; 32]> {
    let secret_key = SecretKey::from_slice(secret)
        .map_err(|_| CliError::Usage("not a valid secp256k1 secret key".into()))?;
    let point = secret_key.public_key().to_encoded_point(true);
    let bytes = point.as_bytes();
    let mut xonly = [0u8; 32];
    xonly.copy_from_slice(&bytes[1..33]);
    Ok(xonly)
}

/// The three keys one message uses, all derived from the nonce.
struct MessageKeys {
    chacha_key: [u8; 32],
    chacha_nonce: [u8; 12],
    hmac_key: [u8; 32],
}

impl Drop for MessageKeys {
    fn drop(&mut self) {
        self.chacha_key.zeroize();
        self.hmac_key.zeroize();
    }
}

/// Per-message keys, expanded from the conversation key and this message's
/// nonce.
///
/// The nonce is the HKDF `info`, so two messages under one conversation key
/// never share a ChaCha20 key -- which is what makes reusing the conversation
/// key safe.
fn message_keys(key: &ConversationKey, nonce: &[u8; 32]) -> MessageKeys {
    let expanded = hkdf_expand(key.expose(), nonce, 76);
    let mut keys = MessageKeys {
        chacha_key: [0u8; 32],
        chacha_nonce: [0u8; 12],
        hmac_key: [0u8; 32],
    };
    keys.chacha_key.copy_from_slice(&expanded[..32]);
    keys.chacha_nonce.copy_from_slice(&expanded[32..44]);
    keys.hmac_key.copy_from_slice(&expanded[44..76]);
    keys
}

/// HKDF-Extract with SHA-256: the PRK is simply an HMAC under the salt.
fn hkdf_extract(salt: &[u8], ikm: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(salt).expect("HMAC takes any key length");
    mac.update(ikm);
    let mut out = [0u8; 32];
    out.copy_from_slice(&mac.finalize().into_bytes());
    out
}

/// HKDF-Expand with SHA-256, for the 76 bytes one message needs.
fn hkdf_expand(prk: &[u8; 32], info: &[u8], length: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(length);
    let mut previous: Vec<u8> = Vec::new();
    let mut counter: u8 = 1;
    while out.len() < length {
        let mut mac = HmacSha256::new_from_slice(prk).expect("HMAC takes any key length");
        mac.update(&previous);
        mac.update(info);
        mac.update(&[counter]);
        previous = mac.finalize().into_bytes().to_vec();
        out.extend_from_slice(&previous);
        counter += 1;
    }
    out.truncate(length);
    out
}

/// The padded length a plaintext of this size occupies.
///
/// Everything up to 32 bytes shares one bucket, so the shortest messages are
/// indistinguishable from each other. Above that the bucket grows with the next
/// power of two, in eighths of it, which keeps the overhead bounded while still
/// collapsing many lengths onto each size.
pub fn padded_length(unpadded: usize) -> usize {
    if unpadded <= 32 {
        return 32;
    }
    let next_power = 1usize << (usize::BITS - (unpadded - 1).leading_zeros());
    let chunk = if next_power <= 256 {
        32
    } else {
        next_power / 8
    };
    chunk * ((unpadded - 1) / chunk + 1)
}

/// `u16` length, the plaintext, then zeros to the bucket.
fn pad(plaintext: &[u8]) -> Result<Vec<u8>> {
    let len = plaintext.len();
    if !(MIN_PLAINTEXT_LEN..=MAX_PLAINTEXT_LEN).contains(&len) {
        return Err(CliError::Usage(format!(
            "a NIP-44 message is between {MIN_PLAINTEXT_LEN} and {MAX_PLAINTEXT_LEN} bytes, got \
             {len}"
        )));
    }
    let mut padded = Vec::with_capacity(2 + padded_length(len));
    padded.extend_from_slice(&(len as u16).to_be_bytes());
    padded.extend_from_slice(plaintext);
    padded.resize(2 + padded_length(len), 0);
    Ok(padded)
}

/// The plaintext back out, with the padding checked rather than trusted.
///
/// A declared length that disagrees with the bucket is a forged or corrupted
/// message, not a short one: accepting it would let a sender pick which bytes
/// the receiver reads out of a padded block.
fn unpad(padded: &[u8]) -> Result<Vec<u8>> {
    if padded.len() < 2 {
        return Err(CliError::Protocol("padded message is too short".into()));
    }
    let declared = usize::from(u16::from_be_bytes([padded[0], padded[1]]));
    let body = &padded[2..];
    if declared < MIN_PLAINTEXT_LEN || declared > body.len() {
        return Err(CliError::Protocol(
            "padded message declares a length it does not hold".into(),
        ));
    }
    if body.len() != padded_length(declared) {
        return Err(CliError::Protocol(
            "padded message is not the size its length implies".into(),
        ));
    }
    Ok(body[..declared].to_vec())
}

/// Encrypt one message.
///
/// The nonce must be 32 fresh random bytes and must never repeat under one
/// conversation key. It is a parameter because this crate holds no randomness.
pub fn encrypt(key: &ConversationKey, plaintext: &str, nonce: &[u8; 32]) -> Result<String> {
    let padded = pad(plaintext.as_bytes())?;
    let keys = message_keys(key, nonce);

    let mut ciphertext = padded;
    let mut cipher = ChaCha20::new(&keys.chacha_key.into(), &keys.chacha_nonce.into());
    cipher.apply_keystream(&mut ciphertext);

    let mac = tag(&keys.hmac_key, nonce, &ciphertext);

    let mut payload = Vec::with_capacity(1 + 32 + ciphertext.len() + 32);
    payload.push(NIP44_VERSION);
    payload.extend_from_slice(nonce);
    payload.extend_from_slice(&ciphertext);
    payload.extend_from_slice(&mac);
    Ok(BASE64.encode(payload))
}

/// Decrypt one message, or say why not.
pub fn decrypt(key: &ConversationKey, payload: &str) -> Result<String> {
    // A '#' payload is a future version by convention, and saying so is more
    // use than "bad base64".
    if payload.starts_with('#') {
        return Err(CliError::Protocol(
            "this message uses a newer encryption version than this wallet understands".into(),
        ));
    }
    if !(MIN_PAYLOAD_LEN..=MAX_PAYLOAD_LEN).contains(&payload.len()) {
        return Err(CliError::Protocol(format!(
            "a NIP-44 payload is between {MIN_PAYLOAD_LEN} and {MAX_PAYLOAD_LEN} characters, got \
             {}",
            payload.len()
        )));
    }
    let raw = BASE64
        .decode(payload)
        .map_err(|_| CliError::Protocol("payload is not base64".into()))?;
    if raw.len() < 1 + 32 + 32 + 1 {
        return Err(CliError::Protocol(
            "payload is too short to hold a message".into(),
        ));
    }
    if raw[0] != NIP44_VERSION {
        return Err(CliError::Protocol(format!(
            "unsupported NIP-44 version {}; this wallet speaks version {NIP44_VERSION}",
            raw[0]
        )));
    }

    // The length check above proves there are at least 33 bytes, so this
    // cannot fail. Saying that with a slice conversion states the invariant
    // where a zeroed buffer filled afterwards only implies it.
    let nonce: [u8; 32] = raw[1..33]
        .try_into()
        .expect("the payload was checked to be at least 66 bytes");
    let ciphertext = &raw[33..raw.len() - 32];
    let claimed = &raw[raw.len() - 32..];

    let keys = message_keys(key, &nonce);
    let expected = tag(&keys.hmac_key, &nonce, ciphertext);
    // Constant time: an early return on the first wrong byte tells a forger how
    // much of the tag was right, and a few thousand tries turn that into all of
    // it.
    if expected.ct_eq(claimed).unwrap_u8() != 1 {
        return Err(CliError::Protocol(
            "this message failed its authentication check; it was altered in transit or is not \
             for this conversation"
                .into(),
        ));
    }

    let mut padded = ciphertext.to_vec();
    let mut cipher = ChaCha20::new(&keys.chacha_key.into(), &keys.chacha_nonce.into());
    cipher.apply_keystream(&mut padded);

    let plaintext = unpad(&padded)?;
    String::from_utf8(plaintext)
        .map_err(|_| CliError::Protocol("decrypted message is not valid UTF-8".into()))
}

/// HMAC-SHA256 over the nonce and the ciphertext.
///
/// The nonce is the associated data. Without it a payload whose nonce was
/// swapped would decrypt to garbage under a tag that still verified.
fn tag(hmac_key: &[u8; 32], nonce: &[u8; 32], ciphertext: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(hmac_key).expect("HMAC takes any key length");
    mac.update(nonce);
    mac.update(ciphertext);
    let mut out = [0u8; 32];
    out.copy_from_slice(&mac.finalize().into_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two peers, from published documentation keys.
    fn peers() -> ([u8; 32], [u8; 32]) {
        let mut alice = [0u8; 32];
        alice[31] = 1;
        let mut bob = [0u8; 32];
        bob[31] = 2;
        (alice, bob)
    }

    fn nonce(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    // -----------------------------------------------------------------------
    // Conformance against the published vectors
    // -----------------------------------------------------------------------
    //
    // Everything above says this implementation agrees with itself. These say
    // it agrees with everyone else's, which is the only thing that matters to
    // a peer on another client. The file is `nip44.vectors.json` from the
    // reference repository, vendored so the suite stays offline and so a change
    // to it is a reviewable diff rather than a silent retest.

    mod vectors {
        use super::*;
        use serde_json::Value;
        use sha2::Digest;

        const VECTORS: &str = include_str!("../tests/vectors/nip44.vectors.json");

        fn load() -> Value {
            serde_json::from_str::<Value>(VECTORS).expect("the vector file parses")["v2"].clone()
        }

        fn unhex(text: &str) -> Vec<u8> {
            assert!(
                text.len().is_multiple_of(2),
                "hex has an even length: {text}"
            );
            (0..text.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
                .collect()
        }

        fn hex(bytes: &[u8]) -> String {
            bytes.iter().map(|b| format!("{b:02x}")).collect()
        }

        fn array32(text: &str) -> [u8; 32] {
            let bytes = unhex(text);
            let mut out = [0u8; 32];
            out.copy_from_slice(&bytes);
            out
        }

        fn sha256_hex(bytes: &[u8]) -> String {
            hex(&sha2::Sha256::digest(bytes))
        }

        #[test]
        fn every_published_conversation_key_matches() {
            let vectors = load();
            let cases = vectors["valid"]["get_conversation_key"]
                .as_array()
                .expect("an array");
            assert!(cases.len() >= 30, "the file should carry them all");

            for (index, case) in cases.iter().enumerate() {
                let secret = array32(case["sec1"].as_str().expect("sec1"));
                let peer = array32(case["pub2"].as_str().expect("pub2"));
                let expected = case["conversation_key"].as_str().expect("expected");

                let derived = conversation_key(&secret, &peer)
                    .unwrap_or_else(|error| panic!("case {index}: {error}"));
                assert_eq!(hex(derived.expose()), expected, "case {index}");
            }
        }

        #[test]
        fn every_published_message_key_expansion_matches() {
            // The most diagnostic of the four: an HKDF counter that restarted,
            // a chained block dropped, or the 76 bytes split at the wrong
            // offsets would all show up here and nowhere else.
            let vectors = load();
            let section = &vectors["valid"]["get_message_keys"];
            let key = ConversationKey::from_bytes(array32(
                section["conversation_key"]
                    .as_str()
                    .expect("conversation_key"),
            ));

            let cases = section["keys"].as_array().expect("an array");
            assert!(cases.len() >= 30);
            for (index, case) in cases.iter().enumerate() {
                let nonce = array32(case["nonce"].as_str().expect("nonce"));
                let keys = message_keys(&key, &nonce);
                assert_eq!(
                    hex(&keys.chacha_key),
                    case["chacha_key"].as_str().expect("chacha_key"),
                    "case {index}: chacha key"
                );
                assert_eq!(
                    hex(&keys.chacha_nonce),
                    case["chacha_nonce"].as_str().expect("chacha_nonce"),
                    "case {index}: chacha nonce"
                );
                assert_eq!(
                    hex(&keys.hmac_key),
                    case["hmac_key"].as_str().expect("hmac_key"),
                    "case {index}: hmac key"
                );
            }
        }

        #[test]
        fn every_published_padded_length_matches() {
            let vectors = load();
            let cases = vectors["valid"]["calc_padded_len"]
                .as_array()
                .expect("an array");
            assert!(cases.len() >= 20);
            for case in cases {
                let pair = case.as_array().expect("a pair");
                let unpadded = pair[0].as_u64().expect("unpadded") as usize;
                let expected = pair[1].as_u64().expect("padded") as usize;
                assert_eq!(padded_length(unpadded), expected, "for {unpadded}");
            }
        }

        #[test]
        fn every_published_payload_encrypts_and_decrypts_byte_for_byte() {
            // Both directions. Producing the published payload proves the
            // whole pipeline; reading it proves a peer's message opens.
            let vectors = load();
            let cases = vectors["valid"]["encrypt_decrypt"]
                .as_array()
                .expect("an array");
            assert!(cases.len() >= 8);

            for (index, case) in cases.iter().enumerate() {
                let sec1 = array32(case["sec1"].as_str().expect("sec1"));
                let sec2 = array32(case["sec2"].as_str().expect("sec2"));
                let nonce = array32(case["nonce"].as_str().expect("nonce"));
                let plaintext = case["plaintext"].as_str().expect("plaintext");
                let payload = case["payload"].as_str().expect("payload");

                // Each side derives the key from its own secret and the
                // other's public key, and both must land on the published one.
                let pub2 = xonly_public_key(&sec2).expect("a public key");
                let pub1 = xonly_public_key(&sec1).expect("a public key");
                let from_one = conversation_key(&sec1, &pub2).expect("agreed");
                let from_two = conversation_key(&sec2, &pub1).expect("agreed");
                assert_eq!(
                    hex(from_one.expose()),
                    case["conversation_key"].as_str().expect("conversation_key"),
                    "case {index}: key"
                );
                assert_eq!(hex(from_two.expose()), hex(from_one.expose()));

                assert_eq!(
                    encrypt(&from_one, plaintext, &nonce).expect("encrypts"),
                    payload,
                    "case {index}: our payload must be theirs, byte for byte"
                );
                assert_eq!(
                    decrypt(&from_two, payload).expect("decrypts"),
                    plaintext,
                    "case {index}: their payload must open here"
                );
            }
        }

        #[test]
        fn the_long_message_vectors_match_by_digest() {
            // Up to the 65535-byte limit, checked by hash because the payloads
            // are too large to carry inline.
            let vectors = load();
            let cases = vectors["valid"]["encrypt_decrypt_long_msg"]
                .as_array()
                .expect("an array");

            for (index, case) in cases.iter().enumerate() {
                let key = ConversationKey::from_bytes(array32(
                    case["conversation_key"].as_str().expect("conversation_key"),
                ));
                let nonce = array32(case["nonce"].as_str().expect("nonce"));
                let pattern = case["pattern"].as_str().expect("pattern");
                let repeat: usize = case["repeat"]
                    .as_u64()
                    .map(|n| n as usize)
                    .or_else(|| case["repeat"].as_str().and_then(|s| s.parse().ok()))
                    .expect("repeat");

                let plaintext = pattern.repeat(repeat);
                assert_eq!(
                    sha256_hex(plaintext.as_bytes()),
                    case["plaintext_sha256"].as_str().expect("plaintext_sha256"),
                    "case {index}: the plaintext we built is the one they meant"
                );

                let payload = encrypt(&key, &plaintext, &nonce).expect("encrypts");
                assert_eq!(
                    sha256_hex(payload.as_bytes()),
                    case["payload_sha256"].as_str().expect("payload_sha256"),
                    "case {index}: payload"
                );
                assert_eq!(decrypt(&key, &payload).expect("decrypts"), plaintext);
            }
        }

        #[test]
        fn every_published_invalid_case_is_refused() {
            let vectors = load();

            // Lengths outside 1..=65535.
            for case in vectors["invalid"]["encrypt_msg_lengths"]
                .as_array()
                .expect("an array")
            {
                let length = case.as_u64().expect("a length") as usize;
                let key = ConversationKey::from_bytes([1u8; 32]);
                let plaintext = "a".repeat(length);
                assert!(
                    encrypt(&key, &plaintext, &[0u8; 32]).is_err(),
                    "length {length} must be refused"
                );
            }

            // Keys off the curve, or not keys at all.
            for case in vectors["invalid"]["get_conversation_key"]
                .as_array()
                .expect("an array")
            {
                let sec1 = case["sec1"].as_str().expect("sec1");
                let pub2 = case["pub2"].as_str().expect("pub2");
                let note = case["note"].as_str().unwrap_or("");
                let (Ok(secret), Ok(peer)) = (
                    std::panic::catch_unwind(|| array32(sec1)),
                    std::panic::catch_unwind(|| array32(pub2)),
                ) else {
                    continue; // malformed hex is refused before this function
                };
                assert!(
                    conversation_key(&secret, &peer).is_err(),
                    "must be refused ({note})"
                );
            }

            // Payloads that must not decrypt: wrong MAC, bad padding, an
            // unsupported version, and so on.
            for case in vectors["invalid"]["decrypt"].as_array().expect("an array") {
                let key = ConversationKey::from_bytes(array32(
                    case["conversation_key"].as_str().expect("conversation_key"),
                ));
                let payload = case["payload"].as_str().expect("payload");
                let note = case["note"].as_str().unwrap_or("");
                assert!(
                    decrypt(&key, payload).is_err(),
                    "must be refused ({note}): {payload}"
                );
            }
        }
    }

    #[test]
    fn both_sides_agree_the_same_key_from_opposite_ends() {
        // The property the whole scheme rests on: neither peer sends a key, and
        // both arrive at the same one.
        let (alice, bob) = peers();
        let alice_pub = xonly_public_key(&alice).expect("a public key");
        let bob_pub = xonly_public_key(&bob).expect("a public key");

        let from_alice = conversation_key(&alice, &bob_pub).expect("agreed");
        let from_bob = conversation_key(&bob, &alice_pub).expect("agreed");
        assert_eq!(from_alice.expose(), from_bob.expose());

        // And a third party's key gives a different one.
        let mut carol = [0u8; 32];
        carol[31] = 3;
        let carol_pub = xonly_public_key(&carol).expect("a public key");
        let with_carol = conversation_key(&alice, &carol_pub).expect("agreed");
        assert_ne!(from_alice.expose(), with_carol.expose());
    }

    #[test]
    fn the_conversation_key_never_prints_itself() {
        // It decrypts the whole history, so a log line carrying it is the worst
        // kind of leak: silent, and retroactive.
        let (alice, bob) = peers();
        let bob_pub = xonly_public_key(&bob).expect("a public key");
        let key = conversation_key(&alice, &bob_pub).expect("agreed");
        let rendered = format!("{key:?}");
        assert_eq!(rendered, "ConversationKey(<redacted>)");
        assert!(!rendered.contains(&format!("{:02x}", key.expose()[0])) || key.expose()[0] == 0);
    }

    #[test]
    fn a_message_survives_the_round_trip_at_every_awkward_length() {
        let (alice, bob) = peers();
        let bob_pub = xonly_public_key(&bob).expect("a public key");
        let key = conversation_key(&alice, &bob_pub).expect("agreed");

        // The bucket edges, either side of each, plus a multibyte message --
        // padding counts bytes, and a length in characters would truncate here.
        for length in [1, 31, 32, 33, 63, 64, 65, 100, 255, 256, 257, 1000] {
            let plaintext = "a".repeat(length);
            let payload = encrypt(&key, &plaintext, &nonce(7)).expect("encrypts");
            assert_eq!(decrypt(&key, &payload).expect("decrypts"), plaintext);
        }

        let unicode = "fusion round 3 — 参加者 6/10 ✅";
        let payload = encrypt(&key, unicode, &nonce(9)).expect("encrypts");
        assert_eq!(decrypt(&key, &payload).expect("decrypts"), unicode);
    }

    #[test]
    fn length_is_hidden_by_padding_rather_than_merely_obscured() {
        // Fusion coordination sends short structured messages whose size would
        // otherwise say which step of the round a peer is on.
        assert_eq!(padded_length(1), 32);
        assert_eq!(padded_length(32), 32);
        assert_eq!(padded_length(33), 64);
        assert_eq!(padded_length(64), 64);
        assert_eq!(padded_length(65), 96);
        assert_eq!(padded_length(100), 128);
        assert_eq!(padded_length(256), 256);
        assert_eq!(padded_length(257), 320);

        // The properties that matter, whatever the exact buckets: never
        // shrinking, never smaller than the message, and never below 32.
        let mut previous = 0;
        for length in 1..=4096 {
            let padded = padded_length(length);
            assert!(padded >= length, "{length} -> {padded}");
            assert!(padded >= 32);
            assert!(padded >= previous, "buckets must not shrink at {length}");
            previous = padded;
        }

        // Two messages in the same bucket produce the same payload size, which
        // is the whole point.
        let (alice, bob) = peers();
        let bob_pub = xonly_public_key(&bob).expect("a public key");
        let key = conversation_key(&alice, &bob_pub).expect("agreed");
        let short = encrypt(&key, "yes", &nonce(1)).expect("encrypts");
        let longer = encrypt(&key, "no, and here is why not", &nonce(1)).expect("encrypts");
        assert_eq!(short.len(), longer.len());
    }

    #[test]
    fn any_altered_byte_fails_the_check_rather_than_decrypting_to_rubbish() {
        let (alice, bob) = peers();
        let bob_pub = xonly_public_key(&bob).expect("a public key");
        let key = conversation_key(&alice, &bob_pub).expect("agreed");
        let payload = encrypt(&key, "send 0.01 BCH to bob", &nonce(3)).expect("encrypts");

        let mut raw = BASE64.decode(&payload).expect("decodes");
        // Every region: the version, the nonce, the ciphertext, the tag.
        for index in [0, 1, 20, 40, raw.len() - 1] {
            let mut tampered = raw.clone();
            tampered[index] ^= 0x01;
            let re_encoded = BASE64.encode(&tampered);
            assert!(
                decrypt(&key, &re_encoded).is_err(),
                "a flipped bit at {index} must not decrypt"
            );
        }

        // Truncation too, which is how a stream ends up short rather than
        // altered.
        raw.truncate(raw.len() - 1);
        assert!(decrypt(&key, &BASE64.encode(&raw)).is_err());
    }

    #[test]
    fn the_nonce_is_authenticated_not_merely_carried() {
        // Swapping it would otherwise decrypt to garbage under a tag that still
        // verified, because the tag would not have covered the thing that
        // changed.
        let (alice, bob) = peers();
        let bob_pub = xonly_public_key(&bob).expect("a public key");
        let key = conversation_key(&alice, &bob_pub).expect("agreed");

        let payload = encrypt(&key, "the same words", &nonce(5)).expect("encrypts");
        let mut raw = BASE64.decode(&payload).expect("decodes");
        raw[1..33].copy_from_slice(&nonce(6));
        let error = decrypt(&key, &BASE64.encode(&raw)).expect_err("must fail");
        assert!(error.to_string().contains("authentication"), "{error}");
    }

    #[test]
    fn a_message_for_someone_else_does_not_open() {
        let (alice, bob) = peers();
        let mut carol = [0u8; 32];
        carol[31] = 3;
        let bob_pub = xonly_public_key(&bob).expect("a public key");
        let carol_pub = xonly_public_key(&carol).expect("a public key");

        let to_bob = conversation_key(&alice, &bob_pub).expect("agreed");
        let to_carol = conversation_key(&alice, &carol_pub).expect("agreed");

        let payload = encrypt(&to_bob, "meet at the usual relay", &nonce(11)).expect("encrypts");
        assert!(decrypt(&to_carol, &payload).is_err());
    }

    #[test]
    fn a_future_version_says_so_instead_of_failing_as_corruption() {
        let (alice, bob) = peers();
        let bob_pub = xonly_public_key(&bob).expect("a public key");
        let key = conversation_key(&alice, &bob_pub).expect("agreed");

        let payload = encrypt(&key, "hello", &nonce(13)).expect("encrypts");
        let mut raw = BASE64.decode(&payload).expect("decodes");
        raw[0] = 3;
        let error = decrypt(&key, &BASE64.encode(&raw)).expect_err("must fail");
        assert!(error.to_string().contains("version 3"), "{error}");

        // The '#' convention, which is what a much newer format looks like.
        let hashed = format!("#{}", "a".repeat(200));
        let error = decrypt(&key, &hashed).expect_err("must fail");
        assert!(
            error.to_string().contains("newer encryption version"),
            "{error}"
        );
    }

    #[test]
    fn a_message_outside_the_length_bounds_is_refused_before_any_key_is_used() {
        let (alice, bob) = peers();
        let bob_pub = xonly_public_key(&bob).expect("a public key");
        let key = conversation_key(&alice, &bob_pub).expect("agreed");

        assert!(encrypt(&key, "", &nonce(1)).is_err(), "an empty message");
        let too_long = "a".repeat(MAX_PLAINTEXT_LEN + 1);
        assert!(encrypt(&key, &too_long, &nonce(1)).is_err());

        // The payload bounds are checked before base64 is even decoded.
        assert!(decrypt(&key, "too short").is_err());
    }

    #[test]
    fn padding_that_lies_about_its_length_is_refused() {
        // Accepting it would let a sender choose which bytes of a padded block
        // the receiver reads out.
        assert_eq!(
            unpad(&pad(b"hello").expect("pads")).expect("unpads"),
            b"hello"
        );

        let mut forged = pad(b"hello").expect("pads");
        forged[0..2].copy_from_slice(&40u16.to_be_bytes()); // claims 40 of 32
        assert!(unpad(&forged).is_err());

        let mut zero_length = pad(b"hello").expect("pads");
        zero_length[0..2].copy_from_slice(&0u16.to_be_bytes());
        assert!(unpad(&zero_length).is_err());

        // A block that is not a whole bucket cannot have come from pad().
        let mut wrong_size = pad(b"hello").expect("pads");
        wrong_size.push(0);
        assert!(unpad(&wrong_size).is_err());
    }

    #[test]
    fn hkdf_expand_produces_the_same_bytes_across_its_block_boundary() {
        // 76 bytes needs three HMAC blocks, and a counter that restarted or a
        // chained block dropped would show up here rather than as a mysterious
        // decryption failure between two peers on different builds.
        let prk = [7u8; 32];
        let long = hkdf_expand(&prk, b"info", 76);
        assert_eq!(long.len(), 76);
        assert_eq!(hkdf_expand(&prk, b"info", 32), long[..32]);
        assert_eq!(hkdf_expand(&prk, b"info", 64), long[..64]);
        // Different info, different bytes -- which is what makes the nonce
        // separate one message's keys from another's.
        assert_ne!(hkdf_expand(&prk, b"other", 76), long);
    }

    #[test]
    fn two_messages_under_one_conversation_key_share_no_keystream() {
        // The nonce is HKDF info, so each message gets its own ChaCha20 key.
        // Reusing a keystream across two messages is the classic way a stream
        // cipher leaks both of them.
        let (alice, bob) = peers();
        let bob_pub = xonly_public_key(&bob).expect("a public key");
        let key = conversation_key(&alice, &bob_pub).expect("agreed");

        let first = encrypt(&key, "the same words", &nonce(1)).expect("encrypts");
        let second = encrypt(&key, "the same words", &nonce(2)).expect("encrypts");
        assert_ne!(
            first, second,
            "one nonce per message, one keystream per nonce"
        );

        // And the same nonce is deterministic, which is what makes the above a
        // statement about the nonce rather than about randomness.
        let repeat = encrypt(&key, "the same words", &nonce(1)).expect("encrypts");
        assert_eq!(first, repeat);
    }
}
