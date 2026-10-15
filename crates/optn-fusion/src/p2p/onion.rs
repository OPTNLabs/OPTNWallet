//! The output onion: every output is wrapped in one layer per peeler, and
//! each peeler removes a layer, shuffles the batch and passes it on
//! (`nostr/onionCrypto.ts`).
//!
//! What it buys, stated precisely: the last peeler sees every output, but no
//! peeler can say which peer contributed which, because every hop shuffled
//! the batch. One honest hop is enough.
//!
//! A layer is `ephemeral pubkey (33) || IV (12) || AES-256-GCM ciphertext`,
//! keyed by `sha256(x(ECDH))`. Every plaintext is the same fixed 384-byte
//! block, so the credential an output carries does not make its blob longer
//! than another's.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::{AffinePoint, EncodedPoint, ProjectivePoint, Scalar};
use sha2::{Digest, Sha256};

use super::wire::{AuthorizedOutput, MIN_OUTPUT_VALUE};
use super::{is_hex_len, random_bytes};

/// Every plaintext block is this long (`ONION_PAD_SIZE`).
pub const ONION_PAD_SIZE: usize = 384;
const EPHEMERAL_LEN: usize = 33;
const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// `script|value|serial|credential|saltCommitment`, all hex lowercase
/// (`encodeAuthorizedOutput`).
pub fn encode_authorized_output(output: &AuthorizedOutput) -> Result<String, String> {
    if output.script.is_empty()
        || !output.script.len().is_multiple_of(2)
        || !output.script.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("authorized output script must be canonical hex".into());
    }
    if output.value < MIN_OUTPUT_VALUE || output.value > super::wire::MAX_SAFE_INTEGER {
        return Err("authorized output value is below dust or invalid".into());
    }
    if !is_hex_len(&output.credential_serial, 64) {
        return Err("authorized output serial must be 32-byte hex".into());
    }
    if !is_hex_len(&output.credential_sig, 128) {
        return Err("authorized output credential must be 64-byte hex".into());
    }
    if !is_hex_len(&output.salt_commitment, 64) {
        return Err("authorized output saltCommitment must be 32-byte hex".into());
    }
    Ok(format!(
        "{}|{}|{}|{}|{}",
        output.script.to_ascii_lowercase(),
        output.value,
        output.credential_serial.to_ascii_lowercase(),
        output.credential_sig.to_ascii_lowercase(),
        output.salt_commitment.to_ascii_lowercase()
    ))
}

/// The inverse, refusing a non-canonical value such as `0100`
/// (`decodeAuthorizedOutput`).
pub fn decode_authorized_output(payload: &str) -> Result<AuthorizedOutput, String> {
    let parts: Vec<&str> = payload.split('|').collect();
    let [script, value_text, serial, sig, salt] = parts.as_slice() else {
        return Err("malformed authorized output".into());
    };
    let value: u64 = value_text
        .parse()
        .map_err(|_| "authorized output value is not canonical".to_string())?;
    if value.to_string() != *value_text {
        return Err("authorized output value is not canonical".into());
    }
    let output = AuthorizedOutput {
        script: (*script).to_owned(),
        value,
        credential_serial: (*serial).to_owned(),
        credential_sig: (*sig).to_owned(),
        salt_commitment: (*salt).to_owned(),
    };
    encode_authorized_output(&output)?;
    Ok(output)
}

/// A peeler's key as a point. Mix-order entries are Nostr x-only keys, lifted
/// with an even Y: `d·G` and `-d·G` share an x-coordinate, so the peeler
/// derives the same secret whichever parity its key has (`liftPeelerPubKey`).
fn peeler_point(pubkey_hex: &str) -> Result<ProjectivePoint, String> {
    let bytes = match pubkey_hex.len() {
        64 => super::unhex(&format!("02{pubkey_hex}")),
        66 => super::unhex(pubkey_hex),
        n => {
            return Err(format!(
                "onion: peeler pubkey must be 64 (x-only) or 66 (compressed) hex chars, got {n}"
            ))
        }
    }
    .ok_or("onion: peeler pubkey is not hex")?;
    parse_point(&bytes)
}

fn parse_point(bytes: &[u8]) -> Result<ProjectivePoint, String> {
    let encoded = EncodedPoint::from_bytes(bytes).map_err(|_| "onion: not a curve point")?;
    Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&encoded))
        .map(ProjectivePoint::from)
        .ok_or_else(|| "onion: not a curve point".into())
}

fn scalar(bytes: &[u8; 32]) -> Result<Scalar, String> {
    use k256::elliptic_curve::PrimeField;
    Option::<Scalar>::from(Scalar::from_repr((*bytes).into()))
        .filter(|scalar| !bool::from(scalar.is_zero()))
        .ok_or_else(|| "onion: key is not a valid scalar".into())
}

/// `sha256(x(secret · point))`.
fn shared_key(secret: &Scalar, point: &ProjectivePoint) -> [u8; 32] {
    let shared = (*point * secret).to_affine().to_encoded_point(true);
    Sha256::digest(&shared.as_bytes()[1..33]).into()
}

/// One layer to `peeler` (`onionLayer`).
pub fn layer(data: &[u8], peeler_hex: &str) -> Result<Vec<u8>, String> {
    let peeler = peeler_point(peeler_hex)?;
    let ephemeral = loop {
        if let Ok(candidate) = scalar(&random_bytes::<32>()) {
            break candidate;
        }
    };
    let ephemeral_pub = (ProjectivePoint::GENERATOR * ephemeral)
        .to_affine()
        .to_encoded_point(true);
    let key = shared_key(&ephemeral, &peeler);
    let iv = random_bytes::<IV_LEN>();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "onion: bad key length")?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&iv), data)
        .map_err(|_| "onion: encryption failed")?;
    let mut blob = Vec::with_capacity(EPHEMERAL_LEN + IV_LEN + ciphertext.len());
    blob.extend_from_slice(ephemeral_pub.as_bytes());
    blob.extend_from_slice(&iv);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

/// Remove one layer with the peeler's secret key (`onionPeel`).
pub fn peel(blob: &[u8], secret: &[u8; 32]) -> Result<Vec<u8>, String> {
    if blob.len() < EPHEMERAL_LEN + IV_LEN + TAG_LEN {
        return Err("onion: layer too short".into());
    }
    let ephemeral = parse_point(&blob[..EPHEMERAL_LEN])?;
    let key = shared_key(&scalar(secret)?, &ephemeral);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "onion: bad key length")?;
    cipher
        .decrypt(
            Nonce::from_slice(&blob[EPHEMERAL_LEN..EPHEMERAL_LEN + IV_LEN]),
            &blob[EPHEMERAL_LEN + IV_LEN..],
        )
        .map_err(|_| "onion: layer does not decrypt".into())
}

/// Pad `payload` to the fixed block and wrap it for every peeler, last
/// peeler innermost (`onionWrap`). An over-long payload is a protocol error,
/// never truncated: the fixed size is what makes the blobs alike.
pub fn wrap(payload: &str, peelers: &[String]) -> Result<Vec<u8>, String> {
    let raw = payload.as_bytes();
    if raw.len() >= ONION_PAD_SIZE {
        return Err(format!(
            "onion payload too large: {} bytes, limit {}",
            raw.len(),
            ONION_PAD_SIZE - 1
        ));
    }
    let mut data = vec![0u8; ONION_PAD_SIZE];
    data[..raw.len()].copy_from_slice(raw);
    data[raw.len()] = 1;
    for peeler in peelers.iter().rev() {
        data = layer(&data, peeler)?;
    }
    Ok(data)
}

/// The payload before the first `0x01` sentinel (`onionUnpadRaw`).
pub fn unpad(data: &[u8]) -> String {
    let end = data
        .iter()
        .position(|&byte| byte == 1)
        .filter(|&index| index > 0)
        .unwrap_or(data.len());
    String::from_utf8_lossy(&data[..end]).into_owned()
}

/// Standard padded base64, as `btoa` writes it.
pub fn to_base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The inverse of [`to_base64`].
pub fn from_base64(text: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| "onion: blob is not base64".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keypair(byte: u8) -> ([u8; 32], String) {
        let secret = [byte; 32];
        let point = (ProjectivePoint::GENERATOR * scalar(&secret).unwrap())
            .to_affine()
            .to_encoded_point(true);
        // The x-only Nostr form.
        (secret, super::super::hex(&point.as_bytes()[1..33]))
    }

    fn output() -> AuthorizedOutput {
        AuthorizedOutput {
            script: format!("76a914{}88ac", "22".repeat(20)),
            value: 123_456,
            credential_serial: "33".repeat(32),
            credential_sig: "44".repeat(64),
            salt_commitment: "55".repeat(32),
        }
    }

    #[test]
    fn each_peeler_removes_exactly_its_layer() {
        let peelers: Vec<([u8; 32], String)> = (1..=3).map(keypair).collect();
        let order: Vec<String> = peelers.iter().map(|(_, public)| public.clone()).collect();
        let payload = encode_authorized_output(&output()).unwrap();
        let mut blob = wrap(&payload, &order).unwrap();
        for (secret, _) in &peelers {
            blob = peel(&blob, secret).unwrap();
        }
        assert_eq!(blob.len(), ONION_PAD_SIZE);
        assert_eq!(decode_authorized_output(&unpad(&blob)).unwrap(), output());
    }

    #[test]
    fn a_layer_for_someone_else_does_not_open() {
        let (_, first) = keypair(1);
        let (other, _) = keypair(2);
        let blob = layer(b"hello", &first).unwrap();
        assert!(peel(&blob, &other).is_err());
    }

    #[test]
    fn every_blob_at_one_hop_count_has_the_same_length() {
        let order: Vec<String> = (1..=2).map(|byte| keypair(byte).1).collect();
        let short = wrap("a|1000", &order).unwrap();
        let long = wrap(&encode_authorized_output(&output()).unwrap(), &order).unwrap();
        assert_eq!(short.len(), long.len());
        assert!(wrap(&"x".repeat(ONION_PAD_SIZE), &order).is_err());
    }

    #[test]
    fn output_payloads_are_canonical() {
        let payload = encode_authorized_output(&output()).unwrap();
        assert!(decode_authorized_output(&payload.replace("|123456|", "|0123456|")).is_err());
        assert!(decode_authorized_output("a|b").is_err());
        let mut dust = output();
        dust.value = 545;
        assert!(encode_authorized_output(&dust).is_err());
    }
}
