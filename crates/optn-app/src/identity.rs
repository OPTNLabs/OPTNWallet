//! Settings → Wallet info, and what the eye toggle hides.
//!
//! The React screen states the rule: a public summary is always visible, while
//! the derivation path, account xPub, master fingerprint and wallet hash sit
//! behind an eye toggle that requires the wallet password or biometric, "so
//! shoulder-surfing cannot copy identifying key material".
//!
//! That rule is enforced by the type here rather than by the renderer. The
//! gated fields live inside an `Option<RevealedIdentity>` which is `None`
//! until a reveal is authorised, so a renderer cannot show them by forgetting
//! a conditional — it does not have them to show. A second renderer therefore
//! cannot leak them either, which a boolean flag beside the values would not
//! have guaranteed.
//!
//! Nothing here is secret in the cryptographic sense; it is all public
//! material. It is *identifying*, which is a different reason to gate it.

use crate::{Network, OpenedWallet, WalletKind};

/// The wallet type, as the Settings row words it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalletTypeLabel {
    Standard,
    WatchOnly,
    Hardware,
    Multisig,
}

impl WalletTypeLabel {
    pub const fn text(self) -> &'static str {
        match self {
            Self::Standard => "Standard",
            Self::WatchOnly => "Watch-only",
            Self::Hardware => "Hardware",
            Self::Multisig => "Multisig",
        }
    }

    /// Multisig is reported ahead of watch-only. A shared wallet *is*
    /// watch-only on this device, but "Watch-only" would hide the fact that
    /// spending needs the other cosigners.
    pub fn of(wallet: &OpenedWallet) -> Self {
        if wallet.multisig_policy.is_some() {
            return Self::Multisig;
        }
        match wallet.kind {
            WalletKind::Seed => Self::Standard,
            WalletKind::WatchOnly => Self::WatchOnly,
            WalletKind::Hardware => Self::Hardware,
        }
    }
}

/// The identifying fields, only ever constructed after a reveal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevealedIdentity {
    pub derivation_path: String,
    pub account_xpub: Option<String>,
    pub master_fingerprint: Option<String>,
    /// `sha256` of the account xPub, for comparing two devices by eye.
    pub wallet_hash: Option<String>,
    pub first_receive: Option<String>,
}

/// Everything Settings shows about the open wallet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletIdentity {
    // Always visible.
    pub name: String,
    /// Local id for this machine only; it does not travel with the wallet.
    pub internal_id: Option<u32>,
    pub wallet_type: WalletTypeLabel,
    pub network: Network,
    /// Absolute `.optn` path when known.
    pub file_path: Option<String>,
    /// The path is a predicted name, not a file that exists.
    pub file_missing: bool,
    /// Whether an eye toggle should even be offered.
    pub can_reveal: bool,
    /// `None` until a reveal is authorised.
    pub revealed: Option<RevealedIdentity>,
}

impl WalletIdentity {
    /// True while the identifying fields are on screen.
    pub const fn is_revealed(&self) -> bool {
        self.revealed.is_some()
    }
}

/// Build the Settings wallet-info summary.
///
/// `revealed` comes from the lock: a reveal is always prompted for, and
/// locking clears it.
pub fn wallet_identity(
    wallet: Option<&OpenedWallet>,
    network: Network,
    internal_id: Option<u32>,
    file_path: Option<&str>,
    file_missing: bool,
    revealed: bool,
) -> Option<WalletIdentity> {
    let wallet = wallet?;
    let account_xpub = wallet.account_xpub.clone();
    Some(WalletIdentity {
        name: wallet.name.clone(),
        internal_id,
        wallet_type: WalletTypeLabel::of(wallet),
        network,
        file_path: file_path.map(str::to_owned),
        file_missing,
        // Nothing to reveal is not the same as hiding something: a wallet with
        // no recorded account offers no toggle rather than an empty one.
        can_reveal: !wallet.account_path.is_empty() || account_xpub.is_some(),
        revealed: revealed.then(|| RevealedIdentity {
            derivation_path: wallet.account_path.clone(),
            wallet_hash: account_xpub
                .as_deref()
                .map(optn_core::watch_only::account_hash),
            account_xpub,
            master_fingerprint: wallet.master_fingerprint.clone(),
            first_receive: Some(wallet.receive_address.clone()),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wallet(kind: WalletKind) -> OpenedWallet {
        OpenedWallet {
            kind,
            name: "wallet 8".into(),
            receive_address: "bchtest:qqexample".into(),
            master_fingerprint: Some("0f0f0f0f".into()),
            account_path: "m/44'/1'/0'".into(),
            multisig_policy: None,
            account_xpub: Some("xpub-under-test".into()),
        }
    }

    #[test]
    fn the_public_summary_is_visible_and_the_identity_is_not() {
        let hidden = wallet_identity(
            Some(&wallet(WalletKind::Seed)),
            Network::Chipnet,
            Some(1),
            Some("C:/wallets/wallet5_id1.optn"),
            false,
            false,
        )
        .expect("a wallet is open");

        // Always visible.
        assert_eq!(hidden.name, "wallet 8");
        assert_eq!(hidden.internal_id, Some(1));
        assert_eq!(hidden.wallet_type, WalletTypeLabel::Standard);
        assert_eq!(hidden.network, Network::Chipnet);
        assert_eq!(
            hidden.file_path.as_deref(),
            Some("C:/wallets/wallet5_id1.optn")
        );

        // The identifying fields are not merely flagged hidden -- they are
        // absent, so a renderer cannot show them by forgetting a conditional.
        assert!(!hidden.is_revealed());
        assert_eq!(hidden.revealed, None);
        assert!(hidden.can_reveal);
    }

    #[test]
    fn revealing_returns_the_identifying_fields_and_a_comparable_hash() {
        let shown = wallet_identity(
            Some(&wallet(WalletKind::Seed)),
            Network::Chipnet,
            Some(1),
            None,
            false,
            true,
        )
        .expect("a wallet is open");

        let revealed = shown.revealed.expect("revealed");
        assert_eq!(revealed.derivation_path, "m/44'/1'/0'");
        assert_eq!(revealed.account_xpub.as_deref(), Some("xpub-under-test"));
        assert_eq!(revealed.master_fingerprint.as_deref(), Some("0f0f0f0f"));
        assert_eq!(revealed.first_receive.as_deref(), Some("bchtest:qqexample"));

        // The hash is sha256 of the xPub, so two devices restored from the
        // same account can be compared by eye.
        let hash = revealed.wallet_hash.expect("hash");
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            hash,
            optn_core::watch_only::account_hash("  xpub-under-test  "),
            "surrounding whitespace is not a different wallet"
        );
    }

    #[test]
    fn a_shared_wallet_says_multisig_rather_than_watch_only() {
        // True but misleading: a multisig wallet is watch-only on this device,
        // and saying so would hide that spending needs the other cosigners.
        let mut shared = wallet(WalletKind::WatchOnly);
        shared.multisig_policy = Some("2 of 3".into());
        assert_eq!(WalletTypeLabel::of(&shared), WalletTypeLabel::Multisig);
        assert_eq!(WalletTypeLabel::Multisig.text(), "Multisig");

        assert_eq!(
            WalletTypeLabel::of(&wallet(WalletKind::Hardware)),
            WalletTypeLabel::Hardware
        );
        assert_eq!(
            WalletTypeLabel::of(&wallet(WalletKind::WatchOnly)),
            WalletTypeLabel::WatchOnly
        );
    }

    #[test]
    fn there_is_no_wallet_info_without_a_wallet() {
        assert!(wallet_identity(None, Network::Mainnet, None, None, false, true).is_none());
    }

    #[test]
    fn a_wallet_with_nothing_to_reveal_offers_no_toggle() {
        let mut bare = wallet(WalletKind::Seed);
        bare.account_path = String::new();
        bare.account_xpub = None;
        let identity =
            wallet_identity(Some(&bare), Network::Mainnet, None, None, true, false).expect("open");
        assert!(
            !identity.can_reveal,
            "an empty toggle is worse than no toggle"
        );
        assert!(identity.file_missing);
    }
}
