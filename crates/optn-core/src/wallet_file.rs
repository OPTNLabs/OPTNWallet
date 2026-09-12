//! The existing `optn-wallet` v1 ciphertext format, shared by native interfaces.
//! Password verification always decrypts the wallet; there is no separate verifier
//! whose success could open unrelated ciphertext. Keys and plaintext are temporary.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

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
        if password.len() > 4096 {
            return Err(invalid());
        }
        let salt = STANDARD.decode(&self.kdf_salt).map_err(|_| invalid())?;
        if !(16..=64).contains(&salt.len()) {
            return Err(invalid());
        }
        wallet_pack::derive_key(password, &salt)
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
