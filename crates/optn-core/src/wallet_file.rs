//! Distinct password-encrypted seed and watch-only records for native interfaces.
//! Password verification always decrypts the wallet; there is no separate verifier
//! whose success could open unrelated ciphertext. Keys and plaintext are temporary.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::{
    error::{CliError, Result},
    hd::{AccountPath, Wallet},
    network::Network,
    wallet_pack::{self, PackKey, NONCE_LEN, SECRET_PREFIX},
};

pub const MAX_WALLET_FILE_BYTES: usize = 256 * 1024;

/// A password or recovery phrase crossing the private command channel. Never Debug.
#[derive(Default)]
pub struct SecretText(Zeroizing<String>);

impl SecretText {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretText(<redacted>)")
    }
}

impl Serialize for SecretText {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.expose())
    }
}

impl<'de> Deserialize<'de> for SecretText {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        String::deserialize(deserializer).map(Self::new)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletFile {
    pub format: String,
    pub version: u32,
    #[serde(default)]
    pub source_id: u64,
    pub name: String,
    pub wallet_type: String,
    pub encrypted_mnemonic: String,
    #[serde(default)]
    pub encrypted_passphrase: String,
    pub kdf_salt: String,
    #[serde(default)]
    pub network: Option<String>,
    #[serde(default)]
    pub derivation_path: Option<String>,
    #[serde(default)]
    pub derivation_path_source: Option<String>,
    // Preserve optional data written by another interface when changing a password.
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
}

fn invalid() -> CliError {
    CliError::Usage("Wallet password is incorrect or the wallet file is invalid.".into())
}

fn password_key(password: &str, kdf_salt: &str) -> Result<PackKey> {
    if password.len() > 4096 {
        return Err(invalid());
    }
    let salt = STANDARD.decode(kdf_salt).map_err(|_| invalid())?;
    if !(16..=64).contains(&salt.len()) {
        return Err(invalid());
    }
    wallet_pack::derive_key(password, &salt)
}

pub fn validate_new_password(password: &str, confirmation: &str) -> Result<()> {
    if password.len() > 4096 || confirmation.len() > 4096 {
        return Err(CliError::Usage("Password is too long.".into()));
    }
    // Match the existing UI's UTF-16 length policy, including non-ASCII passwords.
    if !password.is_empty() && password.encode_utf16().count() < 8 {
        return Err(CliError::Usage(
            "Leave empty for no password, or use at least 8 characters.".into(),
        ));
    }
    if password != confirmation {
        return Err(CliError::Usage("Passwords do not match.".into()));
    }
    Ok(())
}

impl WalletFile {
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        name: &str,
        mnemonic: &str,
        passphrase: &str,
        password: &str,
        confirmation: &str,
        network: Network,
        account: AccountPath,
        entropy: &[u8; 56],
    ) -> Result<Self> {
        validate_new_password(password, confirmation)?;
        if name.trim().is_empty() || name.chars().count() > 80 {
            return Err(CliError::Usage(
                "Give the wallet a name of 1 to 80 characters.".into(),
            ));
        }
        let _verified = Wallet::from_mnemonic(mnemonic, passphrase)?;
        let mut file = Self {
            format: "optn-wallet".into(),
            version: 1,
            source_id: 0,
            name: name.trim().into(),
            wallet_type: "standard".into(),
            encrypted_mnemonic: String::new(),
            encrypted_passphrase: String::new(),
            kdf_salt: String::new(),
            network: Some(network.to_string()),
            derivation_path: Some(account.path()),
            derivation_path_source: Some("custom".into()),
            extra: Default::default(),
        };
        file.reseal(mnemonic, passphrase, password, entropy)?;
        Ok(file)
    }

    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_WALLET_FILE_BYTES {
            return Err(invalid());
        }
        let file: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if file.format != "optn-wallet"
            || file.version != 1
            || !matches!(file.wallet_type.as_str(), "standard" | "quantumroot")
            || !file.encrypted_mnemonic.starts_with(SECRET_PREFIX)
        {
            return Err(invalid());
        }
        Ok(file)
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|_| invalid())?;
        if bytes.len() > MAX_WALLET_FILE_BYTES {
            return Err(invalid());
        }
        Ok(bytes)
    }

    pub fn account(&self, fallback: Network) -> Result<(Network, AccountPath)> {
        let network = match self.network.as_deref() {
            Some("mainnet") => Network::Mainnet,
            Some("chipnet") => Network::Chipnet,
            None => fallback,
            _ => return Err(invalid()),
        };
        let account = match self.derivation_path.as_deref() {
            Some(path) => crate::hd::parse_account_path(path)?,
            None => AccountPath::default_for(network),
        };
        Ok((network, account))
    }

    fn key(&self, password: &str) -> Result<PackKey> {
        password_key(password, &self.kdf_salt)
    }

    fn decrypt(key: &PackKey, text: &str) -> Result<Zeroizing<String>> {
        let data = STANDARD
            .decode(text.strip_prefix(SECRET_PREFIX).ok_or_else(invalid)?)
            .map_err(|_| invalid())?;
        if data.len() < NONCE_LEN + 16 {
            return Err(invalid());
        }
        let nonce: &[u8; NONCE_LEN] = data[..NONCE_LEN].try_into().map_err(|_| invalid())?;
        let plain = Zeroizing::new(wallet_pack::open(key, nonce, &data[NONCE_LEN..])?);
        let text = std::str::from_utf8(&plain).map_err(|_| invalid())?;
        Ok(Zeroizing::new(text.to_owned()))
    }

    fn encrypt(key: &PackKey, nonce: &[u8; NONCE_LEN], text: &str) -> Result<String> {
        let mut bytes = nonce.to_vec();
        bytes.extend(wallet_pack::seal(key, nonce, text.as_bytes())?);
        Ok(format!("{SECRET_PREFIX}{}", STANDARD.encode(bytes)))
    }

    pub fn unlock(&self, password: &str) -> Result<Wallet> {
        let key = self.key(password)?;
        let mnemonic = Self::decrypt(&key, &self.encrypted_mnemonic)?;
        let passphrase = if self.encrypted_passphrase.is_empty() {
            Zeroizing::new(String::new())
        } else {
            Self::decrypt(&key, &self.encrypted_passphrase)?
        };
        Wallet::from_mnemonic(&mnemonic, &passphrase).map_err(|_| invalid())
    }

    /// Caller supplies fresh OS entropy: salt, mnemonic nonce, passphrase nonce.
    pub fn change_password(
        &self,
        old: &str,
        new: &str,
        confirmation: &str,
        entropy: &[u8; 56],
    ) -> Result<Self> {
        validate_new_password(new, confirmation)?;
        let old_key = self.key(old)?;
        let mnemonic = Self::decrypt(&old_key, &self.encrypted_mnemonic)?;
        let passphrase = if self.encrypted_passphrase.is_empty() {
            Zeroizing::new(String::new())
        } else {
            Self::decrypt(&old_key, &self.encrypted_passphrase)?
        };
        let _verified = Wallet::from_mnemonic(&mnemonic, &passphrase).map_err(|_| invalid())?;
        let mut next = self.clone();
        next.reseal(&mnemonic, &passphrase, new, entropy)?;
        // The old DB mirror replaces/deletes files by sourceId. Once Rust owns
        // the new ciphertext, that stale mirror must not roll its password back.
        if next.source_id > 0 {
            next.extra
                .insert("legacySourceId".into(), next.source_id.into());
            next.source_id = 0;
        }
        Ok(next)
    }

    fn reseal(
        &mut self,
        mnemonic: &str,
        passphrase: &str,
        password: &str,
        entropy: &[u8; 56],
    ) -> Result<()> {
        let first: &[u8; 12] = entropy[32..44].try_into().map_err(|_| invalid())?;
        let second: &[u8; 12] = entropy[44..56].try_into().map_err(|_| invalid())?;
        if first == second {
            return Err(CliError::Usage("Encryption nonces must differ.".into()));
        }
        let key = wallet_pack::derive_key(password, &entropy[..32])?;
        self.kdf_salt = STANDARD.encode(&entropy[..32]);
        self.encrypted_mnemonic = Self::encrypt(&key, first, mnemonic)?;
        self.encrypted_passphrase = if passphrase.is_empty() {
            String::new()
        } else {
            Self::encrypt(&key, second, passphrase)?
        };
        Ok(())
    }
}

const WATCH_ONLY_FORMAT: &str = "optn-watch-only";
const WATCH_ONLY_PAYLOAD_FORMAT: &str = "optn-watch-only-payload";
const MAX_WATCH_ONLY_BYTES: usize = 8 * 1024;
const MAX_WATCH_ONLY_PLAINTEXT: usize = 4 * 1024;

/// A separately typed, encrypted public-account record, never a seed wallet.
/// Only its name and format header are listable without a password. The name
/// is authenticated against the encrypted payload on unlock, not on listing.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchOnlyFile {
    pub format: String,
    pub version: u32,
    pub name: String,
    encrypted_payload: String,
    kdf_salt: String,
}

impl std::fmt::Debug for WatchOnlyFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WatchOnlyFile(<redacted>)")
    }
}

/// Public derivation material plus an independently random private storage key.
/// No mnemonic, private HD key, or signing capability is represented here.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct UnlockedWatchOnly {
    #[zeroize(skip)]
    pub network: Network,
    #[zeroize(skip)]
    pub account: AccountPath,
    pub account_xpub: String,
    pub master_fingerprint: Option<String>,
    pub checkpoint_key: PackKey,
}

impl std::fmt::Debug for UnlockedWatchOnly {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("UnlockedWatchOnly(<redacted>)")
    }
}

// Every owned plaintext string, including partially deserialized payloads,
// zeroizes on drop. The serialized/decrypted JSON and decoded key do likewise.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WatchOnlyPayload {
    format: SecretText,
    version: u32,
    name: SecretText,
    network: SecretText,
    account_path: SecretText,
    account_xpub: SecretText,
    master_fingerprint: Option<SecretText>,
    checkpoint_key: SecretText,
}

impl WatchOnlyPayload {
    fn validate(&self, name: &str) -> Result<UnlockedWatchOnly> {
        if self.format.expose() != WATCH_ONLY_PAYLOAD_FORMAT
            || self.version != 1
            || self.name.expose() != name
            || self.account_path.expose().len() > 64
            || self.account_xpub.expose().len() > 256
            || self.checkpoint_key.expose().len() != 44
        {
            return Err(invalid());
        }
        let network = match self.network.expose() {
            "mainnet" => Network::Mainnet,
            "chipnet" => Network::Chipnet,
            "regtest" => Network::Regtest,
            _ => return Err(invalid()),
        };
        let account =
            crate::hd::parse_account_path(self.account_path.expose()).map_err(|_| invalid())?;
        let xpub = crate::watch_only::parse_account_xpub(self.account_xpub.expose())
            .map_err(|_| invalid())?;
        if account.path() != self.account_path.expose()
            || xpub.to_string(bip32::Prefix::XPUB) != self.account_xpub.expose()
            || u32::from(xpub.attrs().child_number) & 0x7fff_ffff != account.account()
        {
            return Err(invalid());
        }
        let fingerprint = match &self.master_fingerprint {
            None => None,
            Some(value) => {
                let normalized = crate::watch_only::normalize_master_fingerprint(value.expose())
                    .map_err(|_| invalid())?;
                if normalized.as_deref() != Some(value.expose()) {
                    return Err(invalid());
                }
                normalized
            }
        };
        let decoded = Zeroizing::new(
            STANDARD
                .decode(self.checkpoint_key.expose())
                .map_err(|_| invalid())?,
        );
        if decoded.len() != 32 || decoded.iter().all(|&byte| byte == 0) {
            return Err(invalid());
        }
        let mut key = Zeroizing::new([0; 32]);
        key.copy_from_slice(&decoded);
        Ok(UnlockedWatchOnly {
            network,
            account,
            account_xpub: self.account_xpub.expose().to_owned(),
            master_fingerprint: fingerprint,
            checkpoint_key: PackKey::from_bytes(*key),
        })
    }
}

impl WatchOnlyFile {
    /// Supply fresh OS entropy independently for each argument. The first 32
    /// bytes of `entropy` are the public KDF salt, the next 12 the AEAD nonce;
    /// the remaining 12 are reserved for signature parity with seed records.
    /// `checkpoint_entropy` is private, stable storage-key material, not a salt.
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        name: &str,
        account_xpub: &str,
        master_fingerprint: &str,
        password: &str,
        confirmation: &str,
        network: Network,
        account: AccountPath,
        entropy: &[u8; 56],
        checkpoint_entropy: &[u8; 32],
    ) -> Result<Self> {
        validate_new_password(password, confirmation)?;
        if name.trim().is_empty() || name.chars().count() > 80 {
            return Err(CliError::Usage(
                "Give the wallet a name of 1 to 80 characters.".into(),
            ));
        }
        if account_xpub.len() > 256
            || !(account_xpub.trim().starts_with("xpub") || account_xpub.trim().starts_with("tpub"))
            || master_fingerprint.len() > 64
        {
            return Err(invalid());
        }
        let xpub = crate::watch_only::parse_account_xpub(account_xpub).map_err(|_| invalid())?;
        let fingerprint = crate::watch_only::normalize_master_fingerprint(master_fingerprint)
            .map_err(|_| invalid())?;
        let payload = WatchOnlyPayload {
            format: SecretText::new(WATCH_ONLY_PAYLOAD_FORMAT.into()),
            version: 1,
            name: SecretText::new(name.trim().into()),
            network: SecretText::new(network.to_string()),
            account_path: SecretText::new(account.path()),
            account_xpub: SecretText::new(xpub.to_string(bip32::Prefix::XPUB)),
            master_fingerprint: fingerprint.map(SecretText::new),
            checkpoint_key: SecretText::new(STANDARD.encode(checkpoint_entropy)),
        };
        let mut file = Self {
            format: WATCH_ONLY_FORMAT.into(),
            version: 1,
            name: name.trim().into(),
            encrypted_payload: String::new(),
            kdf_salt: String::new(),
        };
        file.reseal(&payload, password, entropy)?;
        Ok(file)
    }

    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_WATCH_ONLY_BYTES {
            return Err(invalid());
        }
        let file: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        file.validate_header()?;
        Ok(file)
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate_header()?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|_| invalid())?;
        if bytes.len() > MAX_WATCH_ONLY_BYTES {
            return Err(invalid());
        }
        Ok(bytes)
    }

    fn validate_header(&self) -> Result<()> {
        if self.format != WATCH_ONLY_FORMAT
            || self.version != 1
            || self.name.is_empty()
            || self.name.trim() != self.name
            || self.name.chars().count() > 80
            || self.kdf_salt.len() != 44
            || self.encrypted_payload.len() > MAX_WATCH_ONLY_BYTES - 1024
        {
            return Err(invalid());
        }
        let salt = STANDARD.decode(&self.kdf_salt).map_err(|_| invalid())?;
        let ciphertext = STANDARD
            .decode(
                self.encrypted_payload
                    .strip_prefix(SECRET_PREFIX)
                    .ok_or_else(invalid)?,
            )
            .map_err(|_| invalid())?;
        if salt.len() != 32
            || !(NONCE_LEN + 16..=MAX_WATCH_ONLY_PLAINTEXT + NONCE_LEN + 16)
                .contains(&ciphertext.len())
        {
            return Err(invalid());
        }
        Ok(())
    }

    fn payload(&self, password: &str) -> Result<(WatchOnlyPayload, UnlockedWatchOnly)> {
        self.validate_header()?;
        let key = password_key(password, &self.kdf_salt)?;
        let plaintext =
            WalletFile::decrypt(&key, &self.encrypted_payload).map_err(|_| invalid())?;
        let payload: WatchOnlyPayload = serde_json::from_str(&plaintext).map_err(|_| invalid())?;
        let unlocked = payload.validate(&self.name)?;
        let salt = STANDARD.decode(&self.kdf_salt).map_err(|_| invalid())?;
        if unlocked.checkpoint_key.expose().as_slice() == salt {
            return Err(invalid());
        }
        Ok((payload, unlocked))
    }

    pub fn unlock(&self, password: &str) -> Result<UnlockedWatchOnly> {
        Ok(self.payload(password)?.1)
    }

    /// Reencrypt with fresh salt/nonce while retaining the private checkpoint key.
    pub fn change_password(
        &self,
        old: &str,
        new: &str,
        confirmation: &str,
        entropy: &[u8; 56],
    ) -> Result<Self> {
        validate_new_password(new, confirmation)?;
        let (payload, _) = self.payload(old)?;
        let mut next = self.clone();
        next.reseal(&payload, new, entropy)?;
        Ok(next)
    }

    fn reseal(
        &mut self,
        payload: &WatchOnlyPayload,
        password: &str,
        entropy: &[u8; 56],
    ) -> Result<()> {
        let unlocked = payload.validate(&self.name)?;
        if unlocked.checkpoint_key.expose().as_slice() == &entropy[..32] {
            return Err(invalid());
        }
        let plaintext = Zeroizing::new(serde_json::to_string(payload).map_err(|_| invalid())?);
        if plaintext.len() > MAX_WATCH_ONLY_PLAINTEXT {
            return Err(invalid());
        }
        let key = wallet_pack::derive_key(password, &entropy[..32])?;
        let nonce = entropy[32..44].try_into().map_err(|_| invalid())?;
        self.kdf_salt = STANDARD.encode(&entropy[..32]);
        self.encrypted_payload = WalletFile::encrypt(&key, nonce, &plaintext)?;
        self.validate_header()
    }
}

#[cfg(test)]
mod watch_only_file_tests {
    use super::*;
    use crate::hd::BIP39_TEST_VECTOR_MNEMONIC;

    fn entropy(round: u8) -> [u8; 56] {
        std::array::from_fn(|i| round.wrapping_mul(71).wrapping_add(i as u8))
    }

    fn checkpoint_entropy() -> [u8; 32] {
        std::array::from_fn(|i| (i as u8).wrapping_mul(13).wrapping_add(3))
    }

    fn xpub() -> String {
        Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "")
            .unwrap()
            .account_xpub_at(AccountPath::new(145, 2).unwrap())
            .unwrap()
    }

    fn create(password: &str) -> WatchOnlyFile {
        WatchOnlyFile::create(
            "Public watch fixture",
            &xpub(),
            " A1B2C3D4 ",
            password,
            password,
            Network::Chipnet,
            AccountPath::new(145, 2).unwrap(),
            &entropy(1),
            &checkpoint_entropy(),
        )
        .unwrap()
    }

    #[test]
    fn encrypted_watch_only_round_trip_and_rotation_keep_private_checkpoint_key() {
        let file = create("");
        let encoded = file.encode().unwrap();
        let text = std::str::from_utf8(&encoded).unwrap();
        assert!(text.contains("Public watch fixture"));
        for private in [
            xpub(),
            "chipnet".into(),
            "m/44'/145'/2'".into(),
            "a1b2c3d4".into(),
            STANDARD.encode(checkpoint_entropy()),
        ] {
            assert!(!text.contains(&private));
        }
        let parsed = WatchOnlyFile::parse(&encoded).unwrap();
        let unlocked = parsed.unlock("").unwrap();
        assert_eq!(unlocked.network, Network::Chipnet);
        assert_eq!(unlocked.account.path(), "m/44'/145'/2'");
        assert_eq!(unlocked.account_xpub, xpub());
        assert_eq!(unlocked.master_fingerprint.as_deref(), Some("a1b2c3d4"));
        assert_eq!(unlocked.checkpoint_key.expose(), &checkpoint_entropy());
        assert_ne!(
            unlocked.checkpoint_key.expose().as_slice(),
            &entropy(1)[..32]
        );
        assert_eq!(format!("{parsed:?}"), "WatchOnlyFile(<redacted>)");
        assert_eq!(format!("{unlocked:?}"), "UnlockedWatchOnly(<redacted>)");
        let checkpoint_nonce: [u8; 12] = entropy(9)[32..44].try_into().unwrap();
        let checkpoint = wallet_pack::seal(
            &unlocked.checkpoint_key,
            &checkpoint_nonce,
            b"checkpoint fixture",
        )
        .unwrap();
        let rotated = parsed
            .change_password(
                "",
                "new fixture password",
                "new fixture password",
                &entropy(2),
            )
            .unwrap();
        assert_ne!(rotated.kdf_salt, parsed.kdf_salt);
        assert_ne!(rotated.encrypted_payload, parsed.encrypted_payload);
        assert!(rotated.unlock("").is_err());
        let reopened = WatchOnlyFile::parse(&rotated.encode().unwrap())
            .unwrap()
            .unlock("new fixture password")
            .unwrap();
        assert_eq!(reopened.checkpoint_key, unlocked.checkpoint_key);
        assert_eq!(reopened.account_xpub, unlocked.account_xpub);
        assert_eq!(reopened.master_fingerprint, unlocked.master_fingerprint);
        assert_eq!(
            wallet_pack::open(&reopened.checkpoint_key, &checkpoint_nonce, &checkpoint).unwrap(),
            b"checkpoint fixture"
        );
        assert_eq!(
            file.encode().unwrap(),
            encoded,
            "rotation does not mutate the original"
        );
    }

    #[test]
    fn watch_only_authentication_and_record_types_fail_closed() {
        let file = create("fixture password");
        let original = file.encode().unwrap();
        assert!(file.unlock("wrong fixture password").is_err());
        assert!(file
            .change_password("wrong fixture password", "", "", &entropy(2))
            .is_err());
        assert!(WalletFile::parse(&original).is_err());
        let key = password_key("fixture password", &file.kdf_salt).unwrap();
        let mut tampered = file.clone();
        let mut ciphertext = STANDARD
            .decode(
                tampered
                    .encrypted_payload
                    .strip_prefix(SECRET_PREFIX)
                    .unwrap(),
            )
            .unwrap();
        *ciphertext.last_mut().unwrap() ^= 1;
        tampered.encrypted_payload = format!("{SECRET_PREFIX}{}", STANDARD.encode(ciphertext));
        assert!(tampered.unlock("fixture password").is_err());
        tampered = file.clone();
        tampered.kdf_salt = STANDARD.encode(&entropy(2)[..32]);
        assert!(tampered.unlock("fixture password").is_err());
        tampered = file.clone();
        tampered.name = "Another listed name".into();
        assert!(tampered.unlock("fixture password").is_err());
        tampered = file.clone();
        // Even a valid seed plaintext encrypted with this password/key is not
        // a watch-only payload, and cannot gain public-account storage authority.
        tampered.encrypted_payload = WalletFile::encrypt(
            &key,
            &entropy(3)[32..44].try_into().unwrap(),
            BIP39_TEST_VECTOR_MNEMONIC,
        )
        .unwrap();
        assert!(tampered.unlock("fixture password").is_err());
        let seed = WalletFile::create(
            "Public seed fixture",
            BIP39_TEST_VECTOR_MNEMONIC,
            "",
            "",
            "",
            Network::Chipnet,
            AccountPath::default_for(Network::Chipnet),
            &entropy(4),
        )
        .unwrap();
        assert!(WatchOnlyFile::parse(&seed.encode().unwrap()).is_err());
        assert_eq!(file.encode().unwrap(), original);
    }

    #[test]
    fn watch_only_header_parsing_is_bounded_strict_and_rechecked_on_unlock() {
        let file = create("");
        let value = serde_json::to_value(&file).unwrap();
        for (field, replacement) in [
            ("format", serde_json::json!("optn-wallet")),
            ("version", serde_json::json!(2)),
            ("version", serde_json::json!("1")),
            ("name", serde_json::json!(" ")),
            ("name", serde_json::json!("n".repeat(81))),
            ("kdfSalt", serde_json::json!("invalid")),
            (
                "encryptedPayload",
                serde_json::json!(format!("{SECRET_PREFIX}AA==")),
            ),
            (
                "encryptedMnemonic",
                serde_json::json!("seed type confusion"),
            ),
        ] {
            let mut malformed = value.clone();
            malformed[field] = replacement;
            assert!(
                WatchOnlyFile::parse(&serde_json::to_vec(&malformed).unwrap()).is_err(),
                "accepted field {field}"
            );
        }
        assert!(WatchOnlyFile::parse(&vec![b' '; MAX_WATCH_ONLY_BYTES + 1]).is_err());
        assert!(WatchOnlyFile::parse(
            br#"{"format":"optn-watch-only","format":"optn-watch-only"}"#
        )
        .is_err());
        let mut changed = file;
        changed.version = 2;
        assert!(changed.encode().is_err());
        assert!(changed.unlock("").is_err());
    }

    #[test]
    fn watch_only_rejects_authenticated_malformed_or_noncanonical_payloads() {
        let file = create("");
        let (payload, _) = file.payload("").unwrap();
        let value = serde_json::to_value(&payload).unwrap();
        let key = password_key("", &file.kdf_salt).unwrap();
        let mutations = [
            ("format", serde_json::json!("optn-wallet")),
            ("version", serde_json::json!(2)),
            ("network", serde_json::json!("testnet")),
            ("accountPath", serde_json::json!("m/44'/145'/2'/0/0")),
            ("accountPath", serde_json::json!("44h/145h/2h")),
            ("accountPath", serde_json::json!("m/44'/145'/02'")),
            ("accountPath", serde_json::json!("m/44'/145'/3'")),
            ("accountPath", serde_json::json!("m/44'/145'/2147483648'")),
            ("accountPath", serde_json::json!("m/44'/145'/2")),
            ("accountXpub", serde_json::json!(format!(" {}", xpub()))),
            ("masterFingerprint", serde_json::json!("A1B2C3D4")),
            ("masterFingerprint", serde_json::json!("")),
            ("checkpointKey", serde_json::json!(STANDARD.encode([0; 32]))),
            ("checkpointKey", serde_json::json!(STANDARD.encode([7; 31]))),
            ("checkpointKey", serde_json::json!(file.kdf_salt)),
            ("mnemonic", serde_json::json!(BIP39_TEST_VECTOR_MNEMONIC)),
        ];
        for (i, (field, replacement)) in mutations.into_iter().enumerate() {
            let mut malformed = value.clone();
            malformed[field] = replacement;
            let mut changed = file.clone();
            changed.encrypted_payload = WalletFile::encrypt(
                &key,
                &entropy(i as u8 + 10)[32..44].try_into().unwrap(),
                &serde_json::to_string(&malformed).unwrap(),
            )
            .unwrap();
            assert!(
                changed.unlock("").is_err(),
                "accepted payload field {field}"
            );
        }
    }

    #[test]
    fn watch_only_creation_validates_public_origin_password_and_independent_entropy() {
        let public = xpub();
        let account = AccountPath::new(145, 2).unwrap();
        let make = |xpub: &str,
                    fingerprint: &str,
                    password: &str,
                    confirmation: &str,
                    origin,
                    key: &[u8; 32]| {
            WatchOnlyFile::create(
                "Public origin fixture",
                xpub,
                fingerprint,
                password,
                confirmation,
                Network::Regtest,
                origin,
                &entropy(5),
                key,
            )
        };
        assert!(make(
            &public,
            "",
            "short",
            "short",
            account,
            &checkpoint_entropy()
        )
        .is_err());
        assert!(make(&public, "", "", "mismatch", account, &checkpoint_entropy()).is_err());
        assert!(make(
            &public,
            "",
            &"p".repeat(4097),
            &"p".repeat(4097),
            account,
            &checkpoint_entropy()
        )
        .is_err());
        assert!(make(&public, "zzzzzzzz", "", "", account, &checkpoint_entropy()).is_err());
        assert!(make(
            &public,
            "",
            "",
            "",
            AccountPath::new(145, 1).unwrap(),
            &checkpoint_entropy()
        )
        .is_err());
        assert!(make(
            &public,
            "",
            "",
            "",
            account,
            &entropy(5)[..32].try_into().unwrap()
        )
        .is_err());
        assert!(make(&public, "", "", "", account, &[0; 32]).is_err());
        let private =
            bip32::XPrv::derive_from_path([1; 32], &account.path().parse().unwrap()).unwrap();
        assert!(make(
            &private.to_string(bip32::Prefix::XPRV),
            "",
            "",
            "",
            account,
            &checkpoint_entropy()
        )
        .is_err());
        assert!(make(
            &private.to_string(bip32::Prefix::TPRV),
            "",
            "",
            "",
            account,
            &checkpoint_entropy()
        )
        .is_err());
        let file = make(&public, "", "", "", account, &checkpoint_entropy()).unwrap();
        let unlocked = file.unlock("").unwrap();
        assert_eq!(unlocked.network, Network::Regtest);
        assert_eq!(unlocked.master_fingerprint, None);
        let mut bad_rotation = entropy(6);
        bad_rotation[..32].copy_from_slice(&checkpoint_entropy());
        assert!(file.change_password("", "", "", &bad_rotation).is_err());

        let public_parsed = crate::watch_only::parse_account_xpub(&public).unwrap();
        let tpub = public_parsed.to_string(bip32::Prefix::TPUB);
        assert_eq!(
            crate::watch_only::parse_account_xpub(&tpub)
                .unwrap()
                .to_string(bip32::Prefix::XPUB),
            public
        );
        let from_tpub = make(&tpub, "", "", "", account, &checkpoint_entropy())
            .expect("a valid account tpub must normalize to canonical xpub");
        let reopened = from_tpub.unlock("").unwrap();
        assert_eq!(reopened.account_xpub, public);
        assert_eq!(reopened.account, account);
    }
}
