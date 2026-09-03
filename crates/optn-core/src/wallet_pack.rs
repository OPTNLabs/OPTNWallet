//! Exporting a wallet as a pack, and reading one back.
//!
//! A pack is two files written side by side:
//!
//! - `<name>.optn` — the keystore, holding the encrypted seed. This is what
//!   "Export Wallet" has always produced.
//! - `<name>.optn-cold` — everything else the wallet knows: the address set, a
//!   UTXO snapshot, transaction history, coin labels, and fusion depth.
//!
//! **The data file never contains the seed.** The TypeScript format states that
//! with a `containsSecrets: false` field, which is a claim the file makes about
//! itself. Here it is a property of the type instead: [`ColdArchive`] has
//! nowhere to put key material, so a version of this code that leaked a seed
//! into the data file would not compile. [`ColdArchive::carries_no_secrets`]
//! then checks the serialised bytes as well, because a label or a memo is
//! free-form text and a user can paste anything into one.
//!
//! Either file can be imported alone. That is why the pairing rules live here
//! rather than in a file dialog: given a multi-select, exactly one keystore and
//! one data file are picked out, and a keystore's companion path is derived
//! rather than guessed at.
//!
//! One rule comes from a bug report rather than a design. The keystore used to
//! carry the wallet's name inside it, so renaming the file to
//! `wallet7 for testing.optn` and importing it showed the old name again. The
//! name the user typed into the save dialog is the one they meant, so
//! [`wallet_name_from_path`] prefers the filename stem.

use std::fmt;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{CliError, Result};

/// Extension of the keystore half of a pack.
pub const KEYSTORE_EXTENSION: &str = ".optn";
/// Extension of the data half of a pack.
pub const COLD_EXTENSION: &str = ".optn-cold";

/// Format tag written into a plaintext cold archive.
pub const COLD_ARCHIVE_FORMAT: &str = "optn-cold-archive-v1";
/// Format tag written into the encrypted envelope around one.
pub const COLD_ARCHIVE_ENCRYPTED_FORMAT: &str = "optn-cold-archive-enc-v1";

/// The marker every encrypted secret in this wallet carries.
///
/// Named here so a cold archive can be checked for one. Anything starting with
/// it is ciphertext over key material and has no business in the data file.
pub const SECRET_PREFIX: &str = "enc:v1:";

/// One address the wallet watches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchivedAddress {
    pub address: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_index: Option<u32>,
}

/// One unspent output, as the snapshot saw it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchivedUtxo {
    pub address: String,
    pub tx_hash: String,
    pub tx_pos: u32,
    /// Satoshis. An integer, never a float: a balance that went through an
    /// `f64` is a balance that can come back slightly different.
    pub value: u64,
    pub height: i64,
}

/// One transaction the wallet has seen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchivedTransaction {
    pub tx_hash: String,
    pub height: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<i64>,
}

/// A name the user gave something.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchivedLabel {
    pub kind: String,
    pub ref_key: String,
    pub label: String,
    pub updated_at: String,
}

/// What fusion knows about this wallet's coins.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchivedFusion {
    /// Outpoint to the number of rounds that coin has been through.
    #[serde(default)]
    pub coin_depth: Vec<(String, u32)>,
    /// Transactions this wallet knows were fusions.
    #[serde(default)]
    pub fusion_txids: Vec<String>,
}

/// The data half of a pack.
///
/// Note what is not here: no mnemonic, no extended private key, no password, no
/// ciphertext over any of them. There is nowhere to put one, which is a
/// stronger statement than a field saying there is not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColdArchive {
    pub format: String,
    pub exported_at: String,
    pub wallet_id: u64,
    pub network: String,
    /// Kept for the readers that check it. Always false, and it is a constant
    /// rather than a field a caller can set.
    pub contains_secrets: bool,
    pub disclaimer: String,
    #[serde(default)]
    pub addresses: Vec<ArchivedAddress>,
    #[serde(default)]
    pub utxos: Vec<ArchivedUtxo>,
    #[serde(default)]
    pub transactions: Vec<ArchivedTransaction>,
    #[serde(default)]
    pub labels: Vec<ArchivedLabel>,
    #[serde(default)]
    pub fusion: ArchivedFusion,
}

impl ColdArchive {
    /// The text shown to anyone who opens the file.
    pub const DISCLAIMER: &'static str =
        "This file holds wallet data only. It contains no seed phrase and no private keys, and \
         cannot be used to spend.";

    /// A new archive, stamped with the format and the disclaimer.
    pub fn new(wallet_id: u64, network: impl Into<String>, exported_at: impl Into<String>) -> Self {
        Self {
            format: COLD_ARCHIVE_FORMAT.to_string(),
            exported_at: exported_at.into(),
            wallet_id,
            network: network.into(),
            contains_secrets: false,
            disclaimer: Self::DISCLAIMER.to_string(),
            addresses: Vec::new(),
            utxos: Vec::new(),
            transactions: Vec::new(),
            labels: Vec::new(),
            fusion: ArchivedFusion::default(),
        }
    }

    /// Whether the serialised archive really carries no key material.
    ///
    /// The type has nowhere to put a secret, but a label, a disclaimer or an
    /// address is free-form text and a user can paste anything into one. This
    /// is the belt to the type's braces, and it is what the export path should
    /// call before writing a file.
    pub fn carries_no_secrets(&self) -> Result<()> {
        if self.contains_secrets {
            return Err(CliError::Internal(
                "a cold archive declared that it contains secrets; it must not".into(),
            ));
        }
        let serialised = serde_json::to_string(self).map_err(|error| {
            CliError::Internal(format!("cold archive is not encodable: {error}"))
        })?;
        if serialised.contains(SECRET_PREFIX) {
            return Err(CliError::Usage(format!(
                "the archive contains a value starting with '{SECRET_PREFIX}', which is encrypted \
                 key material and does not belong in the data file"
            )));
        }
        Ok(())
    }
}

/// The encrypted envelope a cold archive is written inside.
///
/// The ciphertext and the KDF salt are carried as opaque strings: which cipher
/// produced them is the storage layer's business, and this crate holds no
/// password and performs no key derivation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedColdArchive {
    pub format: String,
    pub version: u32,
    pub source_wallet_id: u64,
    pub kdf_salt: String,
    pub ciphertext: String,
}

impl EncryptedColdArchive {
    pub fn new(
        source_wallet_id: u64,
        kdf_salt: impl Into<String>,
        ciphertext: impl Into<String>,
    ) -> Self {
        Self {
            format: COLD_ARCHIVE_ENCRYPTED_FORMAT.to_string(),
            version: 1,
            source_wallet_id,
            kdf_salt: kdf_salt.into(),
            ciphertext: ciphertext.into(),
        }
    }

    /// Whether this envelope is one of ours, and one we understand.
    pub fn is_supported(&self) -> bool {
        self.format == COLD_ARCHIVE_ENCRYPTED_FORMAT && self.version == 1
    }
}

/// What an import is allowed to change.
///
/// Deliberately narrow. An imported snapshot is a picture of the wallet at some
/// past moment, and the live balance is not the archive's to overwrite: it
/// comes from the chain. Labels and fusion depth are the wallet's own
/// bookkeeping, which nothing else can recover, so those are what an import
/// restores.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportedField {
    Labels,
    FusionDepth,
    FusionTxids,
}

impl ImportedField {
    pub const ALL: &'static [Self] = &[Self::Labels, Self::FusionDepth, Self::FusionTxids];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Labels => "coin and address labels",
            Self::FusionDepth => "how many rounds each coin has been through",
            Self::FusionTxids => "which transactions were fusions",
        }
    }
}

/// Whether a path names the keystore half of a pack.
///
/// `.optn-cold` also ends in `optn`, so the data file is excluded explicitly
/// rather than by extension alone.
pub fn is_keystore_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(KEYSTORE_EXTENSION) && !is_cold_path(path)
}

/// Whether a path names the data half of a pack.
pub fn is_cold_path(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(COLD_EXTENSION)
}

/// The data file that belongs beside a keystore.
pub fn companion_cold_path(keystore_path: &str) -> String {
    if is_keystore_path(keystore_path) {
        let stem = &keystore_path[..keystore_path.len() - KEYSTORE_EXTENSION.len()];
        format!("{stem}{COLD_EXTENSION}")
    } else {
        format!("{keystore_path}{COLD_EXTENSION}")
    }
}

/// The two halves of a pack, picked out of whatever the user selected.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PackPaths {
    pub keystore: Option<String>,
    pub cold: Option<String>,
}

impl PackPaths {
    /// Whether there is anything to import at all.
    pub const fn is_empty(&self) -> bool {
        self.keystore.is_none() && self.cold.is_none()
    }
}

/// Sort a multi-select into the keystore and the data file.
///
/// Either may be absent: importing one alone is supported, and is why this
/// returns two options rather than a pair. Duplicates are ignored, and the
/// first of each kind wins, so selecting a folder twice changes nothing.
pub fn split_pack_paths(paths: &[String]) -> PackPaths {
    let mut seen: Vec<&str> = Vec::new();
    let mut found = PackPaths::default();
    for path in paths {
        let path = path.trim();
        if path.is_empty() || seen.contains(&path) {
            continue;
        }
        seen.push(path);
        if found.cold.is_none() && is_cold_path(path) {
            found.cold = Some(path.to_string());
        } else if found.keystore.is_none() && is_keystore_path(path) {
            found.keystore = Some(path.to_string());
        }
    }
    found
}

/// The wallet name a keystore path implies.
///
/// The name the user typed into the save dialog, not the one stored inside the
/// file. The keystore used to carry its own name, so a file renamed to
/// `wallet7 for testing.optn` imported as whatever it was called when it was
/// first created. `None` when the path does not name a keystore, or names one
/// with an empty stem.
pub fn wallet_name_from_path(path: &str) -> Option<&str> {
    let base = path.rsplit(['/', '\\']).next()?;
    if !is_keystore_path(base) {
        return None;
    }
    let stem = base[..base.len() - KEYSTORE_EXTENSION.len()].trim();
    (!stem.is_empty()).then_some(stem)
}

// ---------------------------------------------------------------------------
// The cipher
// ---------------------------------------------------------------------------

/// PBKDF2 rounds for a wallet password.
///
/// Six hundred thousand, matching what the desktop wallet already writes. The
/// number is the whole defence: a wallet password is chosen by a person, so the
/// only thing standing between a stolen file and its contents is how long each
/// guess takes. It is a constant rather than a parameter because a caller that
/// could lower it would be a caller that could quietly disable it.
pub const PBKDF2_ROUNDS: u32 = 600_000;

/// Bytes of salt a derivation needs.
pub const SALT_LEN: usize = 16;
/// Bytes of nonce AES-GCM needs.
pub const NONCE_LEN: usize = 12;

/// A key derived from a wallet password.
///
/// Zeroized on drop, and its `Debug` says nothing: this key decrypts the
/// wallet's cold data, and a log line carrying it would outlive the session it
/// came from.
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct PackKey([u8; 32]);

impl PackKey {
    pub const fn expose(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for PackKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PackKey(<redacted>)")
    }
}

/// Derive the pack key from a password and the wallet's stored salt.
///
/// The salt is the wallet's own, so two wallets sharing a password still get
/// different keys and neither file opens the other.
pub fn derive_key(password: &str, salt: &[u8]) -> Result<PackKey> {
    derive_key_with_rounds(password, salt, PBKDF2_ROUNDS)
}

/// The same derivation at a stated cost.
///
/// Only for tests and for reading a file written under an older cost. Never
/// call it to write one: [`derive_key`] is the rounds this wallet uses.
pub fn derive_key_with_rounds(password: &str, salt: &[u8], rounds: u32) -> Result<PackKey> {
    if salt.len() < SALT_LEN {
        return Err(CliError::Usage(format!(
            "a pack salt is at least {SALT_LEN} bytes, got {}",
            salt.len()
        )));
    }
    if rounds == 0 {
        return Err(CliError::Usage("a key derivation needs rounds".into()));
    }
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, rounds, &mut key);
    Ok(PackKey(key))
}

/// Encrypt a serialised cold archive.
///
/// The nonce must never repeat under one key. It is a parameter because this
/// crate has no randomness, and reusing one under AES-GCM does not merely leak
/// the plaintext: it leaks the authentication key, and with it the ability to
/// forge.
pub fn seal(key: &PackKey, nonce: &[u8; NONCE_LEN], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key.expose())
        .map_err(|_| CliError::Internal("a pack key is 32 bytes".into()))?;
    cipher
        .encrypt(nonce.into(), plaintext)
        .map_err(|_| CliError::Internal("could not encrypt the archive".into()))
}

/// Decrypt one, or say why not.
///
/// A wrong password and a tampered file are the same answer on purpose: any
/// other arrangement tells whoever has the file which of the two they got
/// right, and that turns a guessing attack into a search.
pub fn open(key: &PackKey, nonce: &[u8; NONCE_LEN], ciphertext: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key.expose())
        .map_err(|_| CliError::Internal("a pack key is 32 bytes".into()))?;
    cipher.decrypt(nonce.into(), ciphertext).map_err(|_| {
        CliError::Usage(
            "could not open this file: the password is wrong, or the file has been altered".into(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive() -> ColdArchive {
        let mut archive = ColdArchive::new(7, "chipnet", "2026-09-03T00:00:00Z");
        archive.addresses.push(ArchivedAddress {
            address: "bchtest:qqaz6s295ncfs53m86qj0uw6sl8u2kuw0ymst35fx4".into(),
            token_address: None,
            address_index: Some(0),
            change_index: None,
        });
        archive.utxos.push(ArchivedUtxo {
            address: "bchtest:qqaz6s295ncfs53m86qj0uw6sl8u2kuw0ymst35fx4".into(),
            tx_hash: "ab".repeat(32),
            tx_pos: 0,
            value: 100_000,
            height: 800_000,
        });
        archive.labels.push(ArchivedLabel {
            kind: "coin".into(),
            ref_key: format!("{}:0", "ab".repeat(32)),
            label: "rent".into(),
            updated_at: "2026-09-03T00:00:00Z".into(),
        });
        archive
            .fusion
            .coin_depth
            .push((format!("{}:0", "ab".repeat(32)), 3));
        archive
    }

    #[test]
    fn the_data_file_has_nowhere_to_put_a_seed() {
        // The TypeScript format says `containsSecrets: false`, which is a claim
        // the file makes about itself. Here the type has no field a seed could
        // go in, and the serialised bytes are checked too -- a label is
        // free-form text and someone can paste anything into one.
        let archive = archive();
        archive.carries_no_secrets().expect("a clean archive");

        let json = serde_json::to_string(&archive).expect("encodes");
        assert!(!json.contains("mnemonic"), "{json}");
        assert!(!json.contains("xprv"), "{json}");
        assert!(!json.contains(SECRET_PREFIX), "{json}");
        assert!(json.contains(r#""contains_secrets":false"#), "{json}");
    }

    #[test]
    fn a_secret_pasted_into_a_label_is_caught_before_the_file_is_written() {
        // The belt to the type's braces. Nothing stops a user naming a coin
        // after their encrypted seed, and the export path is the last place
        // that can notice.
        let mut archive = archive();
        archive.labels[0].label = format!("{SECRET_PREFIX}deadbeef");
        let error = archive.carries_no_secrets().expect_err("must be refused");
        assert!(error.to_string().contains(SECRET_PREFIX), "{error}");

        // And an archive that declares itself secret-bearing is refused even if
        // nothing in it looks like a secret.
        let mut lying = archive.clone();
        lying.labels[0].label = "rent".into();
        lying.contains_secrets = true;
        assert!(lying.carries_no_secrets().is_err());
    }

    #[test]
    fn the_two_halves_are_told_apart_even_though_both_end_in_optn() {
        assert!(is_keystore_path("wallet5.optn"));
        assert!(!is_keystore_path("wallet5.optn-cold"));
        assert!(is_cold_path("wallet5.optn-cold"));
        assert!(!is_cold_path("wallet5.optn"));
        // Case does not decide it: a file picker on Windows will hand back
        // whatever case the file was created with.
        assert!(is_keystore_path("WALLET5.OPTN"));
        assert!(is_cold_path("WALLET5.OPTN-COLD"));
    }

    #[test]
    fn a_keystores_companion_is_derived_rather_than_guessed_at() {
        assert_eq!(
            companion_cold_path("C:/wallets/wallet5.optn"),
            "C:/wallets/wallet5.optn-cold"
        );
        // A path that is not a keystore gets the extension appended, so the
        // caller still gets a usable name instead of a silent wrong one.
        assert_eq!(companion_cold_path("backup"), "backup.optn-cold");
        assert_eq!(
            companion_cold_path("wallet5.optn-cold"),
            "wallet5.optn-cold.optn-cold"
        );
    }

    #[test]
    fn a_multi_select_is_sorted_into_at_most_one_of_each() {
        let picked = vec![
            "/w/wallet5.optn-cold".to_string(),
            "/w/wallet5.optn".to_string(),
            "/w/wallet5.optn".to_string(),
            "/w/notes.txt".to_string(),
        ];
        let paths = split_pack_paths(&picked);
        assert_eq!(paths.keystore.as_deref(), Some("/w/wallet5.optn"));
        assert_eq!(paths.cold.as_deref(), Some("/w/wallet5.optn-cold"));
        assert!(!paths.is_empty());

        // Either alone is a valid selection: importing just the data file onto
        // an open wallet is the point of the split.
        let cold_only = split_pack_paths(&["/w/wallet5.optn-cold".to_string()]);
        assert_eq!(cold_only.keystore, None);
        assert!(cold_only.cold.is_some());

        let nothing = split_pack_paths(&["/w/notes.txt".to_string()]);
        assert!(nothing.is_empty());
    }

    #[test]
    fn the_name_comes_from_the_file_the_user_named() {
        // The bug behind this rule: the keystore carried the wallet's name
        // inside it, so a file renamed in the save dialog imported under
        // whatever it was called when it was first created.
        assert_eq!(
            wallet_name_from_path("C:/wallets/wallet7 for testing.optn"),
            Some("wallet7 for testing")
        );
        assert_eq!(
            wallet_name_from_path("/home/me/wallets/rent.optn"),
            Some("rent")
        );
        // Not a keystore, or nothing left after the extension.
        assert_eq!(wallet_name_from_path("/w/wallet5.optn-cold"), None);
        assert_eq!(wallet_name_from_path("/w/notes.txt"), None);
        assert_eq!(wallet_name_from_path("/w/.optn"), None);
        assert_eq!(wallet_name_from_path("/w/   .optn"), None);
    }

    #[test]
    fn an_import_restores_bookkeeping_and_never_the_balance() {
        // A snapshot is a picture of a past moment. The live balance comes from
        // the chain, and letting an archive overwrite it would show stale coins
        // as current ones. Labels and fusion depth are the only things nothing
        // else can recover.
        assert_eq!(ImportedField::ALL.len(), 3);
        assert!(ImportedField::ALL.contains(&ImportedField::Labels));
        assert!(ImportedField::ALL.contains(&ImportedField::FusionDepth));
        for field in ImportedField::ALL {
            assert!(!field.label().is_empty());
            assert!(
                !field.label().contains("balance"),
                "{field:?} must not restore a balance"
            );
        }
    }

    #[test]
    fn an_envelope_round_trips_and_an_unknown_one_is_not_claimed() {
        let envelope = EncryptedColdArchive::new(7, "c2FsdA==", "Y2lwaGVy");
        assert!(envelope.is_supported());
        let json = serde_json::to_string(&envelope).expect("encodes");
        let back: EncryptedColdArchive = serde_json::from_str(&json).expect("decodes");
        assert_eq!(back, envelope);

        let mut future = envelope.clone();
        future.version = 2;
        assert!(
            !future.is_supported(),
            "a later version is not ours to read"
        );

        let mut foreign = envelope;
        foreign.format = "someone-elses-archive".into();
        assert!(!foreign.is_supported());
    }

    /// A cheap derivation, for tests only. The shipped cost is deliberately
    /// slow, which is the point of it.
    fn test_key(password: &str, salt: &[u8]) -> PackKey {
        derive_key_with_rounds(password, salt, 32).expect("derives")
    }

    #[test]
    fn a_pack_round_trips_and_the_key_never_prints_itself() {
        let salt = [9u8; SALT_LEN];
        let nonce = [3u8; NONCE_LEN];
        let key = test_key("correct horse battery staple", &salt);

        let archive = archive();
        archive.carries_no_secrets().expect("clean");
        let plaintext = serde_json::to_vec(&archive).expect("encodes");

        let sealed = seal(&key, &nonce, &plaintext).expect("seals");
        assert_ne!(
            sealed, plaintext,
            "the file is not the archive in the clear"
        );
        assert!(
            sealed.len() > plaintext.len(),
            "and it carries an authentication tag"
        );

        let opened = open(&key, &nonce, &sealed).expect("opens");
        let back: ColdArchive = serde_json::from_slice(&opened).expect("decodes");
        assert_eq!(back, archive);

        // The key opens the whole of a wallet's cold data, so a log line
        // carrying it would outlive the session it came from.
        assert_eq!(format!("{key:?}"), "PackKey(<redacted>)");
    }

    #[test]
    fn a_wrong_password_and_a_tampered_file_give_the_same_answer() {
        // Deliberately indistinguishable. Any other arrangement tells whoever
        // holds the file which of the two they got right, which turns guessing
        // into a search.
        let salt = [9u8; SALT_LEN];
        let nonce = [3u8; NONCE_LEN];
        let key = test_key("right", &salt);
        let sealed = seal(&key, &nonce, b"the archive").expect("seals");

        let wrong_password = open(&test_key("wrong", &salt), &nonce, &sealed)
            .expect_err("a wrong password must not open it");

        let mut altered = sealed.clone();
        altered[0] ^= 0x01;
        let tampered = open(&key, &nonce, &altered).expect_err("a changed byte must not open it");

        assert_eq!(wrong_password.to_string(), tampered.to_string());
        assert!(wrong_password.to_string().contains("password is wrong"));

        // The tag covers the whole file, not just its start.
        let mut truncated = sealed;
        truncated.pop();
        assert!(open(&key, &nonce, &truncated).is_err());
    }

    #[test]
    fn each_wallets_salt_keeps_one_password_from_opening_two_files() {
        // Two wallets can share a password, and the salt is what stops one
        // file's key opening the other's.
        let password = "the same password";
        let first = test_key(password, &[1u8; SALT_LEN]);
        let second = test_key(password, &[2u8; SALT_LEN]);
        assert_ne!(first.expose(), second.expose());

        let nonce = [3u8; NONCE_LEN];
        let sealed = seal(&first, &nonce, b"wallet one").expect("seals");
        assert!(open(&second, &nonce, &sealed).is_err());
    }

    #[test]
    fn the_derivation_cost_is_a_constant_a_caller_cannot_lower() {
        // A wallet password is chosen by a person, so how long each guess takes
        // is the whole defence. A caller able to lower it is a caller able to
        // quietly disable it, which is why the shipped path takes no rounds
        // argument at all.
        assert_eq!(PBKDF2_ROUNDS, 600_000);

        // The escape hatch exists for tests and for reading an older file, and
        // it still refuses the values that mean "no derivation".
        assert!(derive_key_with_rounds("p", &[0u8; SALT_LEN], 0).is_err());
        // A short salt is refused too: it is what makes one wallet's key
        // different from another's.
        assert!(derive_key_with_rounds("p", &[0u8; SALT_LEN - 1], 32).is_err());
        assert!(derive_key_with_rounds("p", &[0u8; SALT_LEN], 32).is_ok());
    }

    #[test]
    fn the_envelope_carries_what_is_needed_to_open_it_and_nothing_more() {
        // The salt has to travel with the file -- it is not a secret -- but the
        // password never does, and neither does the key.
        let salt = [9u8; SALT_LEN];
        let nonce = [3u8; NONCE_LEN];
        let key = test_key("a password", &salt);
        let sealed = seal(&key, &nonce, b"the archive").expect("seals");

        let hex = |bytes: &[u8]| -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() };
        let envelope = EncryptedColdArchive::new(7, hex(&salt), hex(&sealed));
        let json = serde_json::to_string(&envelope).expect("encodes");
        assert!(!json.contains("a password"), "{json}");
        assert!(!json.contains(&hex(key.expose())), "{json}");
        assert!(json.contains(&hex(&salt)), "the salt travels with the file");
    }

    #[test]
    fn an_archive_round_trips_through_json() {
        let archive = archive();
        let json = serde_json::to_string(&archive).expect("encodes");
        let back: ColdArchive = serde_json::from_str(&json).expect("decodes");
        assert_eq!(back, archive);
        assert_eq!(back.format, COLD_ARCHIVE_FORMAT);
        assert_eq!(back.fusion.coin_depth[0].1, 3);
        assert_eq!(back.utxos[0].value, 100_000);
    }
}
