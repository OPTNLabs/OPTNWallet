// CashFusion blame-phase encryption (ECIES) — matches Electron Cash encrypt.py.
//
// In the blame phase a player reveals its component proofs (salt + Pedersen
// nonce) to OTHER players, encrypted to each recipient's per-component
// communication key, so cheaters can be identified without leaking anything to
// the server or to uninvolved players. This is that encryption primitive.
//
// Scheme (encrypt.py):
//   ephemeral keypair (nonce_sec, nonce_pub=nonce_sec*G, compressed)
//   key = sha256(compressed(nonce_sec * recipient_pubkey))          [ECDH]
//   plaintext = len(message)(4-byte BE) || message || zero-pad to a multiple of 16
//   ciphertext = AES256-CBC(key, iv=0) of plaintext (no PKCS pad; already block-aligned)
//   mac = HMAC-SHA256(key, ciphertext)[:16]
//   output = nonce_pub(33) || ciphertext || mac(16)
// Decryption redoes the ECDH from the recipient's private key, checks the MAC in
// constant time, then strips the length prefix + padding.

use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use k256::{ProjectivePoint, Scalar};
use sha2::{Digest, Sha256};

use super::pedersen::random_nonce;
use super::schnorr::{compressed, parse_point};

type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
type HmacSha256 = Hmac<Sha256>;

/// ECDH shared key: sha256 of the compressed shared point `scalar * point`.
fn ecdh_key(scalar: Scalar, point: &ProjectivePoint) -> [u8; 32] {
    let shared = compressed(&(*point * scalar));
    Sha256::digest(shared).into()
}

fn hmac16(key: &[u8; 32], ciphertext: &[u8]) -> [u8; 16] {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("hmac key");
    mac.update(ciphertext);
    let full = mac.finalize().into_bytes();
    let mut out = [0u8; 16];
    out.copy_from_slice(&full[..16]);
    out
}

/// Encrypt `message` to `recipient_pubkey` (33/65-byte serialized point).
/// `pad_to_length` (if given) must be a multiple of 16 and >= len(message)+4;
/// otherwise the smallest block-aligned length is used.
pub fn encrypt(
    message: &[u8],
    recipient_pubkey: &[u8],
    pad_to_length: Option<usize>,
) -> Result<Vec<u8>, String> {
    let pubpoint = parse_point(recipient_pubkey)?;
    let nonce_sec = random_nonce();
    let nonce_pub = compressed(&(ProjectivePoint::GENERATOR * nonce_sec));
    let key = ecdh_key(nonce_sec, &pubpoint);

    let mut plaintext = Vec::with_capacity(4 + message.len());
    plaintext.extend_from_slice(&(message.len() as u32).to_be_bytes());
    plaintext.extend_from_slice(message);
    match pad_to_length {
        None => {
            let pad = (16 - plaintext.len() % 16) % 16;
            plaintext.extend(std::iter::repeat(0u8).take(pad));
        }
        Some(n) => {
            if n % 16 != 0 {
                return Err(format!("pad_to_length {n} not a multiple of 16"));
            }
            if n < plaintext.len() {
                return Err(format!("pad_to_length {n} < {}", plaintext.len()));
            }
            plaintext.resize(n, 0u8);
        }
    }

    // AES256-CBC, iv=0, no padding (plaintext is already block-aligned).
    let iv = [0u8; 16];
    let ciphertext = Aes256CbcEnc::new(&key.into(), &iv.into())
        .encrypt_padded_vec_mut::<aes::cipher::block_padding::NoPadding>(&plaintext);

    let mac = hmac16(&key, &ciphertext);

    let mut out = Vec::with_capacity(33 + ciphertext.len() + 16);
    out.extend_from_slice(&nonce_pub);
    out.extend_from_slice(&ciphertext);
    out.extend_from_slice(&mac);
    Ok(out)
}

/// Decrypt with the recipient's private scalar. Returns the original message.
pub fn decrypt(data: &[u8], privkey: Scalar) -> Result<Vec<u8>, String> {
    if data.len() < 33 + 16 + 16 {
        return Err("ciphertext too short".into());
    }
    let nonce_point = parse_point(&data[..33])?;
    let key = ecdh_key(privkey, &nonce_point);
    decrypt_with_symmkey(data, &key)
}

/// Decrypt when the symmetric key is already known (the first 33 bytes are then
/// ignored). Verifies the MAC in constant time before decrypting.
pub fn decrypt_with_symmkey(data: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if data.len() < 33 + 16 + 16 {
        return Err("ciphertext too short".into());
    }
    let ciphertext = &data[33..data.len() - 16];
    let tag = &data[data.len() - 16..];
    if ciphertext.len() % 16 != 0 {
        return Err("ciphertext not block-aligned".into());
    }

    let expected = hmac16(key, ciphertext);
    // Constant-time compare (ct crate via subtle is transitively available; a
    // simple fold is fine here since both are 16 fixed bytes and we return the
    // same error regardless).
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(tag.iter()) {
        diff |= a ^ b;
    }
    if diff != 0 {
        return Err("MAC check failed — wrong key or tampered ciphertext".into());
    }

    let iv = [0u8; 16];
    let plaintext = Aes256CbcDec::new(&(*key).into(), &iv.into())
        .decrypt_padded_vec_mut::<aes::cipher::block_padding::NoPadding>(ciphertext)
        .map_err(|_| "AES decrypt failed".to_string())?;

    if plaintext.len() < 4 {
        return Err("plaintext too short".into());
    }
    let msglen =
        u32::from_be_bytes([plaintext[0], plaintext[1], plaintext[2], plaintext[3]]) as usize;
    if 4 + msglen > plaintext.len() {
        return Err("declared message length exceeds plaintext".into());
    }
    Ok(plaintext[4..4 + msglen].to_vec())
}

#[cfg(test)]
mod tests {
    use super::super::schnorr::pubkey_compressed;
    use super::*;

    #[test]
    fn encrypt_decrypt_round_trip() {
        let priv_k = random_nonce();
        let pubkey = pubkey_compressed(priv_k);
        let msg = b"salt+nonce blame proof bytes";
        let ct = encrypt(msg, &pubkey, None).unwrap();
        let pt = decrypt(&ct, priv_k).unwrap();
        assert_eq!(pt, msg);
    }

    #[test]
    fn wrong_private_key_fails_mac() {
        let pubkey = pubkey_compressed(random_nonce());
        let ct = encrypt(b"secret", &pubkey, None).unwrap();
        // A different private key derives a different ECDH key -> MAC mismatch.
        assert!(decrypt(&ct, random_nonce()).is_err());
    }

    #[test]
    fn tampered_ciphertext_fails_mac() {
        let priv_k = random_nonce();
        let pubkey = pubkey_compressed(priv_k);
        let mut ct = encrypt(b"important", &pubkey, None).unwrap();
        let n = ct.len();
        ct[n - 20] ^= 0x01; // flip a byte inside the ciphertext
        assert!(decrypt(&ct, priv_k).is_err());
    }

    #[test]
    fn fixed_padding_hides_message_length() {
        let priv_k = random_nonce();
        let pubkey = pubkey_compressed(priv_k);
        // Two different-length messages padded to the same length -> same output size.
        let a = encrypt(b"short", &pubkey, Some(80)).unwrap();
        let b = encrypt(b"a somewhat longer message here", &pubkey, Some(80)).unwrap();
        assert_eq!(a.len(), b.len());
        assert_eq!(decrypt(&a, priv_k).unwrap(), b"short");
        assert_eq!(
            decrypt(&b, priv_k).unwrap(),
            b"a somewhat longer message here"
        );
    }

    #[test]
    fn pad_length_must_be_valid() {
        let pubkey = pubkey_compressed(random_nonce());
        assert!(encrypt(b"x", &pubkey, Some(15)).is_err()); // not multiple of 16
        assert!(encrypt(&[0u8; 100], &pubkey, Some(16)).is_err()); // too small
    }
}
