//! Watch-only BCH account validation and public address derivation.
//!
//! This is intentionally pure Rust: mobile, desktop, web and future renderers
//! must agree on what constitutes a valid account xPub and on the first
//! receive/change addresses. No private key material enters this module.

use bip32::{ChildNumber, XPub};

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
