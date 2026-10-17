//! Credentials travel separately from renderable state and ordinary actions.
use optn_app::SecretText;
use serde::{Deserialize, Serialize};

/// Submit an already signed transaction from the retained wallet interface.
/// The host authenticates the wallet binding; this request grants no signing authority.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WalletBroadcastRequest {
    pub wallet_id: u32,
    pub epoch: u64,
    pub network: String,
    pub raw_hex: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WalletBroadcastStatus {
    Accepted,
    Uncertain,
    Rejected,
    /// No submission was made by this call. Does not disprove an earlier attempt.
    Deferred,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletBroadcastResponse {
    pub txid: String,
    pub status: WalletBroadcastStatus,
    pub message: Option<String>,
}

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

/// A recovery phrase the runtime drew for a new wallet, shown once for the
/// holder to write down.
///
/// The renderer never draws entropy: the runtime does, and keeps the phrase.
/// `Create` then names the draft rather than sending words back, so what is
/// stored is exactly what the runtime drew. Never `Clone`; `Debug` redacts.
#[derive(Debug, Serialize, Deserialize)]
pub struct SeedDraft {
    pub draft: String,
    /// The words, separated by single spaces.
    pub phrase: SecretText,
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
        /// Empty when `draft` names a phrase the runtime drew.
        mnemonic: SecretText,
        #[serde(default)]
        bip39_passphrase: SecretText,
        password: SecretText,
        confirmation: SecretText,
        network: String,
        account_path: String,
        /// A [`SeedDraft`] to create from, in place of `mnemonic`.
        #[serde(default)]
        draft: Option<String>,
    },
    /// Forget an unused [`SeedDraft`]: the holder left the create screen.
    DiscardSeedDraft,
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
    /// Legacy hold-file owner from the authenticated wallet record, never a
    /// renderer-selected identifier. Native wallets may have no legacy mirror.
    #[serde(default)]
    pub legacy_source_id: Option<u32>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drafted_create_names_its_draft_and_older_requests_still_read() {
        let request = WalletSecurityRequest::Create {
            name: "Drafted".into(),
            mnemonic: SecretText::default(),
            bip39_passphrase: SecretText::default(),
            password: SecretText::new("pw".into()),
            confirmation: SecretText::new("pw".into()),
            network: "chipnet".into(),
            account_path: "m/44'/1'/0'".into(),
            draft: Some("00ff".into()),
        };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["command"], "create");
        assert_eq!(json["draft"], "00ff");
        let back: WalletSecurityRequest = serde_json::from_value(json).unwrap();
        assert!(
            matches!(back, WalletSecurityRequest::Create { draft: Some(id), .. } if id == "00ff")
        );

        // A request written before drafts existed carries no draft.
        let older = serde_json::json!({
            "command": "create", "name": "Typed", "mnemonic": "words",
            "password": "", "confirmation": "", "network": "chipnet",
            "account_path": "m/44'/1'/0'",
        });
        let older: WalletSecurityRequest = serde_json::from_value(older).unwrap();
        assert!(matches!(
            older,
            WalletSecurityRequest::Create { draft: None, .. }
        ));

        let discard = serde_json::to_value(WalletSecurityRequest::DiscardSeedDraft).unwrap();
        assert_eq!(
            discard,
            serde_json::json!({"command": "discard_seed_draft"})
        );
    }

    #[test]
    fn a_seed_draft_travels_but_never_prints() {
        let draft = SeedDraft {
            draft: "00ff".into(),
            phrase: SecretText::new("abandon ability able".into()),
        };
        assert!(!format!("{draft:?}").contains("abandon"));
        let json = serde_json::to_value(&draft).unwrap();
        let back: SeedDraft = serde_json::from_value(json).unwrap();
        assert_eq!(back.phrase.expose(), "abandon ability able");
        assert_eq!(back.draft, "00ff");
    }
}
