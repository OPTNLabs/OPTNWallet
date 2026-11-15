//! How one record is written to disk.
//!
//! A record is `(family, key, payload)`. On disk its key is
//! `HMAC-SHA256(index key, family || key)`, so equal records meet again and
//! nothing else about them shows, and its value is
//!
//! ```text
//! version (1) || nonce (24) || XChaCha20-Poly1305(frame, aad = version || disk key)
//! frame = length (4, LE) || family (1) || key length (4, LE) || key || payload || zeros
//! ```
//!
//! The frame is padded with Padmé (Nikitin et al., PURBs, 2019), at least
//! 256 bytes, so a value's length says little about what it holds. The disk
//! key is authenticated with the value, so a value copied over another
//! record's key does not open. Everything here is RustCrypto; the two keys are
//! HKDF-SHA256 of the root key the host gives.

use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::XChaCha20Poly1305;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::Fault;

/// The value layout. A store written with a later one is refused, not guessed at.
pub(crate) const VERSION: u8 = 1;
const NONCE: usize = 24;
const TAG: usize = 16;
/// No frame is shorter than this.
const SMALLEST_FRAME: usize = 256;

/// What a record is. The numbers are on disk (inside the sealed frame and in
/// the keyed hash); never renumber.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub(crate) enum Family {
    /// The one record that says this is a store, and whose key opens it.
    Header = 0,
    /// OpenMLS group state, one record per group and kind.
    MlsGroupData = 1,
    /// A group's own leaf nodes, in the order they were appended.
    MlsOwnLeafNodes = 2,
    /// A group's queued proposals, in the order they were queued.
    MlsProposals = 3,
    /// A group's HPKE key pairs, by epoch and leaf.
    MlsEpochKeyPairs = 4,
    MlsKeyPackage = 5,
    MlsPsk = 6,
    MlsSignatureKey = 7,
    MlsEncryptionKey = 8,
    Group = 9,
    GroupRelays = 10,
    /// A group's exporter secrets, by label and epoch.
    ExporterSecrets = 11,
    Message = 12,
    ProcessedMessage = 13,
    Welcome = 14,
    ProcessedWelcome = 15,
    /// A copy of a group's state taken before a commit (MIP-03).
    Snapshot = 16,
}

impl Family {
    pub(crate) fn from_u8(value: u8) -> Option<Self> {
        Some(match value {
            0 => Self::Header,
            1 => Self::MlsGroupData,
            2 => Self::MlsOwnLeafNodes,
            3 => Self::MlsProposals,
            4 => Self::MlsEpochKeyPairs,
            5 => Self::MlsKeyPackage,
            6 => Self::MlsPsk,
            7 => Self::MlsSignatureKey,
            8 => Self::MlsEncryptionKey,
            9 => Self::Group,
            10 => Self::GroupRelays,
            11 => Self::ExporterSecrets,
            12 => Self::Message,
            13 => Self::ProcessedMessage,
            14 => Self::Welcome,
            15 => Self::ProcessedWelcome,
            16 => Self::Snapshot,
            _ => return None,
        })
    }
}

/// A record read back from disk.
pub(crate) struct Record {
    pub(crate) family: Family,
    pub(crate) key: Vec<u8>,
    pub(crate) payload: Zeroizing<Vec<u8>>,
}

/// The two keys of a store.
pub(crate) struct Crypt {
    cipher: XChaCha20Poly1305,
    index_key: Zeroizing<[u8; 32]>,
}

impl Crypt {
    /// Derive the value key and the index key from the host's root key.
    pub(crate) fn new(root: &[u8; 32]) -> Self {
        let hkdf = Hkdf::<Sha256>::new(Some(b"optn-mdk-store v1"), root);
        let mut value_key = Zeroizing::new([0u8; 32]);
        let mut index_key = Zeroizing::new([0u8; 32]);
        hkdf.expand(b"record values", value_key.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        hkdf.expand(b"record index", index_key.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        Self {
            cipher: XChaCha20Poly1305::new(value_key.as_ref().into()),
            index_key,
        }
    }

    /// Where a record lives on disk.
    pub(crate) fn disk_key(&self, family: Family, key: &[u8]) -> [u8; 32] {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(self.index_key.as_ref())
            .expect("HMAC-SHA256 takes a key of any length");
        mac.update(&[family as u8]);
        mac.update(key);
        mac.finalize().into_bytes().into()
    }

    /// Seal a record for `disk_key`.
    pub(crate) fn seal(
        &self,
        disk_key: &[u8; 32],
        family: Family,
        key: &[u8],
        payload: &[u8],
    ) -> Result<Vec<u8>, Fault> {
        let body = 1 + 4 + key.len() + payload.len();
        let key_length = u32::try_from(key.len()).map_err(|_| Fault::new("record key too long"))?;
        let length = u32::try_from(body).map_err(|_| Fault::new("record too large"))?;
        let mut frame = Zeroizing::new(Vec::with_capacity(padded(4 + body)));
        frame.extend_from_slice(&length.to_le_bytes());
        frame.push(family as u8);
        frame.extend_from_slice(&key_length.to_le_bytes());
        frame.extend_from_slice(key);
        frame.extend_from_slice(payload);
        frame.resize(padded(4 + body), 0);

        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let sealed = self
            .cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: frame.as_slice(),
                    aad: &associated(disk_key),
                },
            )
            .map_err(|_| Fault::new("a record could not be sealed"))?;
        let mut value = Vec::with_capacity(1 + NONCE + sealed.len());
        value.push(VERSION);
        value.extend_from_slice(&nonce);
        value.extend_from_slice(&sealed);
        Ok(value)
    }

    /// Open the value found at `disk_key`. Fails if it was written with
    /// another key, for another disk key, or was changed since.
    pub(crate) fn open(&self, disk_key: &[u8; 32], value: &[u8]) -> Result<Record, Fault> {
        let damaged = || Fault::new("a record does not authenticate");
        if value.len() < 1 + NONCE + TAG || value[0] != VERSION {
            return Err(damaged());
        }
        let (nonce, sealed) = value[1..].split_at(NONCE);
        let frame = Zeroizing::new(
            self.cipher
                .decrypt(
                    nonce.into(),
                    Payload {
                        msg: sealed,
                        aad: &associated(disk_key),
                    },
                )
                .map_err(|_| damaged())?,
        );
        // Authentic from here on, so a frame that does not parse is ours.
        let malformed = || Fault::new("a record is malformed");
        let length = read_u32(&frame, 0).ok_or_else(malformed)? as usize;
        let body = frame.get(4..4 + length).ok_or_else(malformed)?;
        let family = body
            .first()
            .and_then(|byte| Family::from_u8(*byte))
            .ok_or_else(malformed)?;
        let key_length = read_u32(body, 1).ok_or_else(malformed)? as usize;
        let key = body.get(5..5 + key_length).ok_or_else(malformed)?;
        let payload = &body[5 + key_length..];
        if self.disk_key(family, key) != *disk_key {
            return Err(malformed());
        }
        Ok(Record {
            family,
            key: key.to_vec(),
            payload: Zeroizing::new(payload.to_vec()),
        })
    }
}

fn associated(disk_key: &[u8; 32]) -> [u8; 33] {
    let mut aad = [0u8; 33];
    aad[0] = VERSION;
    aad[1..].copy_from_slice(disk_key);
    aad
}

fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let four: [u8; 4] = bytes.get(at..at + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(four))
}

/// Padmé: round `length` up so that only its top `log2(log2(length)) + 1`
/// bits vary. At most about 12% is added, and at least [`SMALLEST_FRAME`].
pub(crate) fn padded(length: usize) -> usize {
    let length = length.max(SMALLEST_FRAME);
    let exponent = usize::BITS - 1 - length.leading_zeros();
    let kept = u32::BITS - exponent.leading_zeros();
    let mask = (1usize << (exponent - kept)) - 1;
    (length + mask) & !mask
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crypt(byte: u8) -> Crypt {
        Crypt::new(&[byte; 32])
    }

    #[test]
    fn padding_is_padme_and_never_short() {
        assert_eq!(padded(0), 256);
        assert_eq!(padded(1), 256);
        assert_eq!(padded(256), 256);
        // 257..=511 keeps 4 bits below the top one: multiples of 16.
        assert_eq!(padded(257), 272);
        assert_eq!(padded(511), 512);
        // 1 MiB + 1 keeps 5 bits: multiples of 32 KiB.
        assert_eq!(padded((1 << 20) + 1), (1 << 20) + (1 << 15));
        for length in [300usize, 1000, 4097, 65_000, 131_073, 5_000_000] {
            let out = padded(length);
            assert!(out >= length);
            assert!((out - length) * 100 <= length * 12, "{length} -> {out}");
        }
    }

    #[test]
    fn a_record_comes_back_as_it_went_in() {
        let crypt = crypt(1);
        let key = crypt.disk_key(Family::Message, b"which");
        let value = crypt
            .seal(&key, Family::Message, b"which", b"what")
            .unwrap();
        let record = crypt.open(&key, &value).unwrap();
        assert_eq!(record.family, Family::Message);
        assert_eq!(record.key, b"which");
        assert_eq!(record.payload.as_slice(), b"what");
        // The frame is padded, and the same record seals differently each time.
        assert_eq!(value.len(), 1 + NONCE + 256 + TAG);
        assert_ne!(
            value,
            crypt
                .seal(&key, Family::Message, b"which", b"what")
                .unwrap()
        );
    }

    #[test]
    fn the_family_is_part_of_where_a_record_lives() {
        let crypt = crypt(1);
        assert_ne!(
            crypt.disk_key(Family::Group, b"k"),
            crypt.disk_key(Family::GroupRelays, b"k")
        );
        assert_ne!(
            crypt.disk_key(Family::Group, b"k"),
            self::crypt(2).disk_key(Family::Group, b"k")
        );
    }

    #[test]
    fn another_key_a_moved_value_and_a_changed_byte_do_not_open() {
        let crypt = crypt(1);
        let key = crypt.disk_key(Family::Group, b"one");
        let value = crypt.seal(&key, Family::Group, b"one", b"secret").unwrap();

        assert!(self::crypt(2).open(&key, &value).is_err());
        let elsewhere = crypt.disk_key(Family::Group, b"two");
        assert!(crypt.open(&elsewhere, &value).is_err());
        for at in [0, 1, NONCE + 1, value.len() - 1] {
            let mut changed = value.clone();
            changed[at] ^= 1;
            assert!(crypt.open(&key, &changed).is_err(), "byte {at}");
        }
        assert!(crypt.open(&key, &value[..value.len() - 1]).is_err());
        assert!(crypt.open(&key, &[]).is_err());
    }

    #[test]
    fn a_frame_sealed_under_the_wrong_disk_key_is_refused() {
        // A value whose own (family, key) do not hash to the disk key it sits
        // at: sealed by us, for that disk key, but claiming to be another record.
        let crypt = crypt(1);
        let at = crypt.disk_key(Family::Group, b"one");
        let value = crypt.seal(&at, Family::Group, b"two", b"x").unwrap();
        assert!(crypt.open(&at, &value).is_err());
    }
}
