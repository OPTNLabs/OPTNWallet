//! Credentials travel separately from renderable state and ordinary actions.
use optn_app::SecretText;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum WalletSecurityRequest {
    Status,
    NextReceive {
        epoch: u64,
        #[serde(default)]
        acknowledge_gap: bool,
    },
    Create {
        name: String,
        mnemonic: SecretText,
        #[serde(default)]
        bip39_passphrase: SecretText,
        password: SecretText,
        confirmation: SecretText,
        network: String,
        account_path: String,
    },
    Open {
        handle: String,
        password: SecretText,
    },
    UnlockBiometric {
        handle: String,
    },
    Authenticate {
        password: SecretText,
        epoch: u64,
    },
    ChangePassword {
        current: Option<SecretText>,
        password: SecretText,
        confirmation: SecretText,
        epoch: u64,
    },
    SetBiometric {
        enabled: bool,
        password: Option<SecretText>,
        epoch: u64,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WalletSecurityStatus {
    pub available: bool,
    pub wallets: Vec<StoredWallet>,
    pub active: Option<String>,
    pub has_password: Option<bool>,
    pub biometric_available: bool,
    pub biometric_enabled: bool,
    pub epoch: u64,
    pub warning: Option<String>,
    #[serde(default)]
    pub needs_auto_lock_confirmation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredWallet {
    pub handle: String,
    pub name: String,
}
