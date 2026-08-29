//! Bitcoin signed messages.
//!
//! x402-bch authorises a debit by signing `JSON.stringify(authorization)` and
//! sending the signature for the Facilitator to check against the payer's
//! address. That uses the long-standing "Bitcoin Signed Message" construction,
//! not a bare ECDSA signature over the raw bytes:
//!
//! ```text
//! digest = dSHA256( varint(24) ++ "Bitcoin Signed Message:\n"
//!                   ++ varint(len(message)) ++ message )
//! ```
//!
//! The magic prefix is what stops a signature obtained for a message being
//! replayed as a signature over a transaction — without it, a caller could be
//! tricked into signing something that is also a valid sighash.
//!
//! The result is 65 bytes: a header carrying the recovery id, then r and s.
//! The header also records whether the key was compressed, because the
//! verifier recovers a public key and must know which address form to compare
//! against. Getting that flag wrong recovers a valid key that hashes to a
//! different address, so verification fails with no indication why.

use k256::ecdsa::SigningKey;

use crate::error::{CliError, Result};
use crate::tx::{double_sha256, varint};

const MAGIC: &[u8] = b"Bitcoin Signed Message:\n";

/// The digest a Bitcoin signed message commits to.
pub fn message_digest(message: &[u8]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(MAGIC.len() + message.len() + 18);
    buf.extend_from_slice(&varint(MAGIC.len() as u64));
    buf.extend_from_slice(MAGIC);
    buf.extend_from_slice(&varint(message.len() as u64));
    buf.extend_from_slice(message);
    double_sha256(&buf)
}

/// Sign a message, returning the base64 form wallets exchange.
///
/// Always marks the key as compressed: every address this wallet derives comes
/// from a compressed public key, so claiming otherwise would make the verifier
/// recover the uncompressed form and compare against an address that was never
/// ours.
pub fn sign_message(key: &SigningKey, message: &[u8]) -> Result<String> {
    let digest = message_digest(message);
    let (signature, recovery_id) = key
        .sign_prehash_recoverable(&digest)
        .map_err(|e| CliError::Internal(format!("message signing failed: {e}")))?;
    let normalized = signature.normalize_s().unwrap_or(signature);

    // 27 base, +4 for a compressed key, + the recovery id.
    let header = 27u8 + 4 + recovery_id.to_byte();
    let mut out = Vec::with_capacity(65);
    out.push(header);
    out.extend_from_slice(&normalized.to_bytes());
    Ok(base64(&out))
}

/// Base64 with the standard alphabet and padding.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> SigningKey {
        SigningKey::from_slice(&[0x55u8; 32]).unwrap()
    }

    #[test]
    fn base64_matches_known_vectors() {
        // RFC 4648 examples, including both padding lengths.
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn the_digest_includes_the_magic_prefix() {
        // Without the prefix a message signature could be replayed as a
        // signature over a transaction, so its presence is asserted rather
        // than assumed.
        let with = message_digest(b"hello");
        let without = double_sha256(b"hello");
        assert_ne!(with, without);
    }

    #[test]
    fn the_digest_length_prefixes_the_message() {
        // Length prefixing is what stops "ab" ++ "c" and "a" ++ "bc" hashing
        // alike, which would let one signature cover two different messages.
        assert_ne!(message_digest(b"abc"), message_digest(b"ab"));
        assert_ne!(message_digest(b"ab"), message_digest(b"a"));
    }

    #[test]
    fn a_signature_is_65_bytes_and_marks_the_key_compressed() {
        let sig = sign_message(&key(), b"authorization").unwrap();
        let raw = decode_base64(&sig);
        assert_eq!(raw.len(), 65, "header + r + s");
        // 31..=34 is the compressed range; 27..=30 would claim uncompressed and
        // recover a key that hashes to an address we never derived.
        assert!(
            (31..=34).contains(&raw[0]),
            "header {} outside the compressed range",
            raw[0]
        );
    }

    #[test]
    fn signing_is_deterministic() {
        // RFC 6979. A second signature over the same message must match, or a
        // verifier comparing two authorisations would see them as different.
        let a = sign_message(&key(), b"same").unwrap();
        let b = sign_message(&key(), b"same").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn different_messages_sign_differently() {
        assert_ne!(
            sign_message(&key(), b"one").unwrap(),
            sign_message(&key(), b"two").unwrap()
        );
    }

    fn decode_base64(s: &str) -> Vec<u8> {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let mut acc = 0u32;
        let mut bits = 0u32;
        for c in s.bytes().filter(|c| *c != b'=') {
            let v = ALPHABET.iter().position(|a| *a == c).unwrap() as u32;
            acc = (acc << 6) | v;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
            }
        }
        out
    }
}
