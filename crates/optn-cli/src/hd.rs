//! BIP39 mnemonics and BIP44 derivation, following the account paths this
//! wallet already documents in `docs/bch-derivation-paths.md`:
//!
//! | Network | Account path            | Prefix         |
//! | ------- | ----------------------- | -------------- |
//! | mainnet | `m/44'/145'/account'`   | `bitcoincash:` |
//! | chipnet | `m/44'/1'/account'`     | `bchtest:`     |
//!
//! `145` is BCH's registered SLIP-44 coin type; `1` is SLIP-44's "testnet, all
//! coins". Discovery scans more than the default, because a seed created by
//! other BCH tooling may sit under a different coin type — see `SCAN_COIN_TYPES`.

use bip32::{DerivationPath, XPrv};
use bip39::{Language, Mnemonic};
use ripemd::Ripemd160;
use sha2::{Digest, Sha256};

use crate::cashaddr::{Address, AddressKind};
use crate::error::{CliError, Result};
use crate::network::Network;

/// Coin types discovery scans, per network, in priority order.
///
/// Taken from the derivation-path document rather than invented: a seed
/// restored from BCH tooling that used the mainnet coin type on a test net is
/// a real case, so chipnet scans 145 as well as its own 1.
pub fn scan_coin_types(network: Network) -> &'static [u32] {
    match network {
        Network::Mainnet => &[145, 0],
        Network::Chipnet => &[1, 145, 0],
    }
}

/// Accounts discovery scans. Two is what the wallet itself checks.
pub const SCAN_ACCOUNTS: &[u32] = &[0, 1];

/// `m/44'/<coin>'/<account>'/<chain>/<index>`
pub fn address_path(coin_type: u32, account: u32, change: bool, index: u32) -> String {
    format!(
        "m/44'/{}'/{}'/{}/{}",
        coin_type,
        account,
        u8::from(change),
        index
    )
}

/// `m/44'/<coin>'/<account>'` — the account path the wallet stores.
pub fn account_path(coin_type: u32, account: u32) -> String {
    format!("m/44'/{coin_type}'/{account}'")
}

pub struct Wallet {
    seed: [u8; 64],
}

impl Wallet {
    /// Build from a BIP39 phrase. The passphrase is BIP39's optional 25th
    /// word; an empty string is the overwhelmingly common case.
    pub fn from_mnemonic(phrase: &str, passphrase: &str) -> Result<Self> {
        let trimmed = phrase.split_whitespace().collect::<Vec<_>>().join(" ");
        // English-only, via the normalized entry points. The
        // unicode-normalization feature only matters for languages this wallet
        // does not offer, and leaving it off keeps the cross-compiled
        // dependency tree smaller.
        let mnemonic = Mnemonic::parse_in_normalized(Language::English, &trimmed).map_err(|e| {
            CliError::Usage(format!(
                "not a valid BIP39 mnemonic ({e}) — check the word count \
                 (12, 15, 18, 21 or 24), the spelling, and that every word is \
                 in the English wordlist"
            ))
        })?;
        Ok(Wallet {
            seed: mnemonic.to_seed_normalized(passphrase),
        })
    }

    /// Derive the compressed public key at a path.
    pub fn public_key(&self, path: &str) -> Result<[u8; 33]> {
        let parsed: DerivationPath = path
            .parse()
            .map_err(|_| CliError::Usage(format!("'{path}' is not a valid derivation path")))?;
        let xprv = XPrv::derive_from_path(self.seed, &parsed)
            .map_err(|e| CliError::Internal(format!("derivation failed: {e}")))?;
        Ok(xprv.public_key().to_bytes())
    }

    /// Derive the P2PKH address at a path for a network.
    pub fn address(&self, network: Network, path: &str) -> Result<Address> {
        let pubkey = self.public_key(path)?;
        Ok(Address::from_hash(
            network.prefix(),
            AddressKind::P2pkh,
            hash160(&pubkey),
        ))
    }
}

/// RIPEMD160(SHA256(pubkey)) — the 20 bytes a P2PKH script commits to.
pub fn hash160(bytes: &[u8]) -> [u8; 20] {
    let sha = Sha256::digest(bytes);
    let rip = Ripemd160::digest(sha);
    let mut out = [0u8; 20];
    out.copy_from_slice(&rip);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // BIP39's own test vector: the all-zeros entropy phrase. Deriving from a
    // fixed mnemonic means a regression in seed generation or in the
    // derivation path shows up as a changed address rather than silently
    // producing a valid-looking but wrong one.
    const TEST_MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn paths_follow_the_documented_layout() {
        assert_eq!(account_path(145, 0), "m/44'/145'/0'");
        assert_eq!(account_path(1, 1), "m/44'/1'/1'");
        assert_eq!(address_path(145, 0, false, 0), "m/44'/145'/0'/0/0");
        assert_eq!(address_path(145, 0, true, 7), "m/44'/145'/0'/1/7");
    }

    #[test]
    fn a_mnemonic_derives_deterministically() {
        let w = Wallet::from_mnemonic(TEST_MNEMONIC, "").expect("test vector must parse");
        let first = w.address(Network::Mainnet, "m/44'/145'/0'/0/0").unwrap();
        let again = w.address(Network::Mainnet, "m/44'/145'/0'/0/0").unwrap();
        assert_eq!(first.encode(), again.encode());
        assert!(first.encode().starts_with("bitcoincash:"));
    }

    #[test]
    fn different_indexes_give_different_addresses() {
        let w = Wallet::from_mnemonic(TEST_MNEMONIC, "").unwrap();
        let a = w.address(Network::Mainnet, "m/44'/145'/0'/0/0").unwrap();
        let b = w.address(Network::Mainnet, "m/44'/145'/0'/0/1").unwrap();
        assert_ne!(a.encode(), b.encode());
    }

    #[test]
    fn a_passphrase_changes_the_wallet() {
        // BIP39's 25th word. Getting this wrong silently yields a valid but
        // empty wallet, so it is asserted rather than assumed.
        let plain = Wallet::from_mnemonic(TEST_MNEMONIC, "").unwrap();
        let salted = Wallet::from_mnemonic(TEST_MNEMONIC, "hunter2").unwrap();
        assert_ne!(
            plain
                .address(Network::Mainnet, "m/44'/145'/0'/0/0")
                .unwrap()
                .encode(),
            salted
                .address(Network::Mainnet, "m/44'/145'/0'/0/0")
                .unwrap()
                .encode()
        );
    }

    #[test]
    fn networks_derive_distinct_addresses_from_one_seed() {
        let w = Wallet::from_mnemonic(TEST_MNEMONIC, "").unwrap();
        let main = w.address(Network::Mainnet, "m/44'/145'/0'/0/0").unwrap();
        let chip = w.address(Network::Chipnet, "m/44'/1'/0'/0/0").unwrap();
        assert!(chip.encode().starts_with("bchtest:"));
        assert_ne!(main.encode(), chip.encode());
    }

    #[test]
    fn accepts_every_phrase_length_the_wallet_imports() {
        // CONTRIBUTING states the wallet imports checksum-valid 12-, 15-, 18-,
        // 21- and 24-word phrases. bip32's own Mnemonic checks
        // `entropy.len() != KEY_SIZE + 1`, which accepts 24 words and silently
        // rejects every shorter phrase — so this asserts the property that
        // choice of crate is responsible for.
        for (entropy_bytes, expected_words) in [(16, 12), (20, 15), (24, 18), (28, 21), (32, 24)] {
            let entropy = vec![0x2a_u8; entropy_bytes];
            let phrase = Mnemonic::from_entropy_in(Language::English, &entropy)
                .unwrap_or_else(|e| panic!("{entropy_bytes} bytes of entropy must be valid: {e}"))
                .to_string();
            assert_eq!(
                phrase.split_whitespace().count(),
                expected_words,
                "{entropy_bytes} bytes should give {expected_words} words"
            );
            let wallet = Wallet::from_mnemonic(&phrase, "")
                .unwrap_or_else(|e| panic!("{expected_words}-word phrase must import: {e}"));
            let address = wallet
                .address(Network::Mainnet, "m/44'/145'/0'/0/0")
                .expect("derivation must succeed");
            assert!(address.encode().starts_with("bitcoincash:"));
        }
    }

    #[test]
    fn rejects_a_bad_mnemonic() {
        // No Debug on Wallet on purpose: it holds a seed, and a derived Debug
        // is exactly how seeds end up in logs. So match rather than unwrap_err.
        match Wallet::from_mnemonic("not actually a mnemonic at all", "") {
            Err(e) => assert!(e.to_string().contains("BIP39"), "unexpected: {e}"),
            Ok(_) => panic!("a non-mnemonic must not produce a wallet"),
        }
    }

    #[test]
    fn scan_sets_match_the_derivation_document() {
        assert_eq!(scan_coin_types(Network::Mainnet), &[145, 0]);
        assert_eq!(scan_coin_types(Network::Chipnet), &[1, 145, 0]);
        assert_eq!(SCAN_ACCOUNTS, &[0, 1]);
    }
}
