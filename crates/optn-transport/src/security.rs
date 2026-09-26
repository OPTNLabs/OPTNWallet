//! Credentials travel separately from renderable state and ordinary actions.
use optn_app::SecretText;
use serde::{Deserialize, Serialize};

/// User-supplied wallet-origin information.
///
/// This deliberately has no `CreatedAt` variant. A creation anchor is a
/// host-authenticated fact and can only be exposed as read-only status after
/// the runtime has verified it against its header view.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WalletBirthdayInput {
    #[default]
    Unknown,
    Height {
        height: u32,
    },
    Time {
        requested_time: u32,
    },
}

/// Read-only birthday information returned by the authenticated runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WalletBirthdayView {
    Unknown,
    ImportedAtHeight { height: u32 },
    ImportedAtTime { requested_time: u32 },
    CreatedAt { height: u32, block_hash: [u8; 32] },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum WalletSecurityRequest {
    Status,
    SetBirthday {
        epoch: u64,
        birthday: WalletBirthdayInput,
    },
    ClearRescan {
        epoch: u64,
    },
    NextReceive {
        epoch: u64,
        #[serde(default)]
        acknowledge_gap: bool,
    },
    /// Public high-water marks from an existing wallet. The runtime verifies
    /// ownership and saves them before widening the next scan; this is not
    /// evidence of transaction history or a fresh balance.
    ImportHdInventory {
        epoch: u64,
        account_path: String,
        addresses: Vec<optn_app::HdInventoryAddress>,
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
    ImportWatchOnly {
        name: String,
        account_xpub: SecretText,
        #[serde(default)]
        master_fingerprint: String,
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
    /// Authenticated, read-only restore provenance. `None` means no wallet is
    /// open or the host has not installed restore metadata yet.
    #[serde(default)]
    pub restore_birthday: Option<WalletBirthdayView>,
    #[serde(default)]
    pub manual_rescan_from: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredWallet {
    pub handle: String,
    pub name: String,
}
