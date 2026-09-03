//! Watch-only BCH account validation and public address derivation.
//!
//! This is intentionally pure Rust: mobile, desktop, web and future renderers
//! must agree on what constitutes a valid account xPub and on the first
//! receive/change addresses. No private key material enters this module.

use bip32::{ChildNumber, XPub};
use sha2::{Digest, Sha256};

use crate::cashaddr::{Address, AddressKind};
use crate::error::{CliError, Result};
use crate::hd::{account_path, hash160};
use crate::network::Network;

const MAX_XPUB_LENGTH: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicAddressPreview {
    pub path: String,
    pub address: String,
    pub token_address: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchOnlyAccountPreview {
    pub account_path: String,
    pub receive: PublicAddressPreview,
    pub change: PublicAddressPreview,
}

/// Normalize the optional four-byte master fingerprint used by PSBT key origins.
pub fn normalize_master_fingerprint(raw: &str) -> Result<Option<String>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() != 8 || !trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(CliError::Usage(
            "master fingerprint must be exactly 8 hexadecimal characters".into(),
        ));
    }
    Ok(Some(trimmed.to_ascii_lowercase()))
}

/// Parse and validate a BIP44 account-level public key.
///
/// An account xPub must be depth 3 and the final account component must be
/// hardened. Public derivation below that account is then possible without
/// importing or exposing any private key.
pub fn parse_account_xpub(raw: &str) -> Result<XPub> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_XPUB_LENGTH {
        return Err(CliError::Usage("enter a valid BCH account xPub".into()));
    }
    let xpub: XPub = trimmed
        .parse()
        .map_err(|_| CliError::Usage("enter a valid BIP32 public key".into()))?;
    let attrs = xpub.attrs();
    if attrs.depth != 3 || !attrs.child_number.is_hardened() {
        return Err(CliError::Usage(
            "use a hardened BIP44 account xPub at depth 3".into(),
        ));
    }
    Ok(xpub)
}

fn child_index(number: ChildNumber) -> u32 {
    u32::from(number) & !ChildNumber::HARDENED_FLAG
}

fn derive_public_address(
    account: &XPub,
    network: Network,
    account_index: u32,
    branch: u32,
    index: u32,
) -> Result<PublicAddressPreview> {
    let branch_key = account
        .derive_child(
            ChildNumber::new(branch, false)
                .map_err(|e| CliError::Internal(format!("invalid branch index: {e}")))?,
        )
        .map_err(|e| CliError::Usage(format!("could not derive public wallet branch: {e}")))?;
    let child = branch_key
        .derive_child(
            ChildNumber::new(index, false)
                .map_err(|e| CliError::Internal(format!("invalid address index: {e}")))?,
        )
        .map_err(|e| CliError::Usage(format!("could not derive public wallet address: {e}")))?;

    let hash = hash160(&child.to_bytes());
    let plain = Address::from_hash(network.prefix(), AddressKind::P2pkh, hash).encode();
    let token = Address::from_hash(network.prefix(), AddressKind::P2pkhToken, hash).encode();
    let account_path = account_path(network.default_coin_type(), account_index);

    Ok(PublicAddressPreview {
        path: format!("{account_path}/{branch}/{index}"),
        address: plain,
        token_address: token,
    })
}

/// A stable fingerprint of an account xPub, for telling wallets apart.
///
/// `sha256(utf8(xpub.trim()))`, hex. Two devices restored from the same
/// account produce the same hash, which is how a user confirms they are
/// looking at the same wallet without comparing a long key by eye. It is
/// derived from public material and reveals nothing the xPub does not, but it
/// still identifies the wallet, so it sits behind the same reveal gate.
pub fn account_hash(account_xpub: &str) -> String {
    let digest = Sha256::digest(account_xpub.trim().as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Derive one address under an account xPub, at `<branch>/<index>`.
///
/// Unhardened child derivation from a *public* key, so scanning an account
/// never needs the seed. Account-path discovery walks hundreds of addresses
/// across several candidate accounts; doing that from a seed would mean
/// holding private material for the whole walk to answer a question that is
/// entirely about public history.
///
/// `branch` is 0 for receive and 1 for change. Branch 3 is RPA and must not
/// be walked as an address chain — it is a key gate, not a sequence of
/// addresses.
pub fn address_under_account(
    network: Network,
    account_xpub: &str,
    branch: u32,
    index: u32,
) -> Result<PublicAddressPreview> {
    let account = parse_account_xpub(account_xpub)?;
    let account_index = child_index(account.attrs().child_number);
    derive_public_address(&account, network, account_index, branch, index)
}

/// Validate an account xPub and derive the same first receive/change preview
/// shown by the existing wallet onboarding flow.
pub fn account_preview(
    network: Network,
    raw_account_xpub: &str,
) -> Result<WatchOnlyAccountPreview> {
    let account = parse_account_xpub(raw_account_xpub)?;
    let account_index = child_index(account.attrs().child_number);
    let path = account_path(network.default_coin_type(), account_index);

    Ok(WatchOnlyAccountPreview {
        account_path: path,
        receive: derive_public_address(&account, network, account_index, 0, 0)?,
        change: derive_public_address(&account, network, account_index, 1, 0)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bip32::{Prefix, XPrv};
    use bip39::{Language, Mnemonic};

    const TEST_MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn account_xpub(network: Network, account: u32) -> String {
        let mnemonic = Mnemonic::parse_in_normalized(Language::English, TEST_MNEMONIC).unwrap();
        let seed = mnemonic.to_seed_normalized("");
        let coin = network.default_coin_type();
        let path = format!("m/44'/{coin}'/{account}'").parse().unwrap();
        XPrv::derive_from_path(seed, &path)
            .unwrap()
            .public_key()
            .to_string(Prefix::XPUB)
    }

    #[test]
    fn fingerprint_is_optional_and_canonical() {
        assert_eq!(normalize_master_fingerprint("").unwrap(), None);
        assert_eq!(
            normalize_master_fingerprint(" DEADBEEF ").unwrap(),
            Some("deadbeef".into())
        );
        assert!(normalize_master_fingerprint("abc").is_err());
        assert!(normalize_master_fingerprint("zzzzzzzz").is_err());
    }

    #[test]
    fn account_preview_derives_receive_and_change_without_secrets() {
        let xpub = account_xpub(Network::Mainnet, 0);
        let preview = account_preview(Network::Mainnet, &xpub).unwrap();
        assert_eq!(preview.account_path, "m/44'/145'/0'");
        assert_eq!(preview.receive.path, "m/44'/145'/0'/0/0");
        assert_eq!(preview.change.path, "m/44'/145'/0'/1/0");
        assert!(preview.receive.address.starts_with("bitcoincash:q"));
        assert!(preview.receive.token_address.starts_with("bitcoincash:z"));
        assert_ne!(preview.receive.address, preview.change.address);
    }

    #[test]
    fn account_index_comes_from_the_xpub() {
        let xpub = account_xpub(Network::Chipnet, 1);
        let preview = account_preview(Network::Chipnet, &xpub).unwrap();
        assert_eq!(preview.account_path, "m/44'/1'/1'");
        assert!(preview.receive.address.starts_with("bchtest:q"));
    }

    #[test]
    fn chipnet_watch_only_receive_is_bchtest_and_fingerprint_is_public_only() {
        let xpub = account_xpub(Network::Chipnet, 0);
        let preview = account_preview(Network::Chipnet, &xpub).unwrap();
        assert!(preview.receive.address.starts_with("bchtest:"));
        let fingerprint = normalize_master_fingerprint("4c9a1f7b").unwrap();
        assert_eq!(fingerprint.as_deref(), Some("4c9a1f7b"));
        assert!(
            !xpub.to_lowercase().contains("mnemonic"),
            "watch-only preview is public account material only"
        );
    }

    #[test]
    fn scanning_an_account_needs_no_seed() {
        // Discovery walks hundreds of addresses per candidate account. It does
        // that from the account xPub alone, so no private material is held for
        // the walk.
        let xpub = account_xpub(Network::Mainnet, 0);

        let first = address_under_account(Network::Mainnet, &xpub, 0, 0).unwrap();
        let preview = account_preview(Network::Mainnet, &xpub).unwrap();
        assert_eq!(
            first.address, preview.receive.address,
            "the same key must give the same first receive address"
        );

        // Walking the chain gives distinct addresses, and change is its own
        // branch rather than a continuation of receive.
        let second = address_under_account(Network::Mainnet, &xpub, 0, 1).unwrap();
        let change = address_under_account(Network::Mainnet, &xpub, 1, 0).unwrap();
        assert_ne!(first.address, second.address);
        assert_ne!(first.address, change.address);
        assert_eq!(change.address, preview.change.address);
        assert_eq!(second.path, "m/44'/145'/0'/0/1");

        // Deeper indices stay derivable, which is what a gap-limit walk needs.
        let far = address_under_account(Network::Mainnet, &xpub, 0, 199).unwrap();
        assert_eq!(far.path, "m/44'/145'/0'/0/199");
        assert!(far.address.starts_with("bitcoincash:q"));

        // Rubbish in is still refused here rather than deeper in a scan.
        assert!(address_under_account(Network::Mainnet, "not-an-xpub", 0, 0).is_err());
    }

    #[test]
    fn rejects_non_account_depth_public_keys() {
        let mnemonic = Mnemonic::parse_in_normalized(Language::English, TEST_MNEMONIC).unwrap();
        let seed = mnemonic.to_seed_normalized("");
        let path = "m/44'/145'/0'/0".parse().unwrap();
        let branch = XPrv::derive_from_path(seed, &path)
            .unwrap()
            .public_key()
            .to_string(Prefix::XPUB);
        assert!(parse_account_xpub(&branch).is_err());
    }
}
