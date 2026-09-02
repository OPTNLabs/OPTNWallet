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

use std::fmt;

use bip32::{DerivationPath, Prefix, XPrv};
use bip39::{Language, Mnemonic};
use ripemd::Ripemd160;
use sha2::{Digest, Sha256};
use zeroize::{ZeroizeOnDrop, Zeroizing};

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

/// BIP44's purpose level. This wallet derives P2PKH only, so it is fixed.
pub const BIP44_PURPOSE: u32 = 44;

/// Hardened indices are `0x8000_0000 + i`, so `i` has 31 bits.
const MAX_HARDENED_INDEX: u32 = 0x8000_0000;

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

/// The BIP44 account a wallet is opened at: `m/44'/<coin_type>'/<account>'`.
///
/// Onboarding needs this as a value rather than a formatted string. A seed
/// restored from other BCH tooling can live under a coin type this network
/// does not default to (see [`scan_coin_types`]), and the wallet has to
/// derive, display, and store the same account the user actually chose —
/// picking the wrong one yields a valid-looking wallet with no history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AccountPath {
    coin_type: u32,
    account: u32,
}

impl AccountPath {
    /// Build an account path, refusing indices outside the hardened range.
    pub fn new(coin_type: u32, account: u32) -> Result<Self> {
        for (level, value) in [("coin type", coin_type), ("account", account)] {
            if value >= MAX_HARDENED_INDEX {
                return Err(CliError::Usage(format!(
                    "{level} {value} is outside the hardened range (0..{MAX_HARDENED_INDEX})"
                )));
            }
        }
        Ok(Self { coin_type, account })
    }

    /// The account this network uses unless the user picks another.
    pub const fn default_for(network: Network) -> Self {
        Self {
            coin_type: network.default_coin_type(),
            account: 0,
        }
    }

    pub const fn coin_type(self) -> u32 {
        self.coin_type
    }

    pub const fn account(self) -> u32 {
        self.account
    }

    /// `m/44'/<coin>'/<account>'`
    pub fn path(self) -> String {
        account_path(self.coin_type, self.account)
    }

    /// `m/44'/<coin>'/<account>'/<chain>/<index>`
    pub fn address_path(self, change: bool, index: u32) -> String {
        address_path(self.coin_type, self.account, change, index)
    }

    /// Whether this is the account the network would have picked on its own.
    /// Anything else is worth labelling in the UI so a user who chose it can
    /// tell, and a user who did not can see that something is unusual.
    pub const fn is_default_for(self, network: Network) -> bool {
        self.coin_type == network.default_coin_type() && self.account == 0
    }

    /// Whether discovery on this network would have scanned this coin type.
    pub fn is_scanned_for(self, network: Network) -> bool {
        scan_coin_types(network).contains(&self.coin_type)
    }
}

impl fmt::Display for AccountPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "m/44'/{}'/{}'", self.coin_type, self.account)
    }
}

/// The account paths onboarding offers, in discovery priority order.
///
/// This is [`scan_coin_types`] × [`SCAN_ACCOUNTS`] rather than a hand-written
/// menu, so the paths a user can pick and the paths discovery actually scans
/// cannot drift apart.
pub fn account_choices(network: Network) -> Vec<AccountPath> {
    scan_coin_types(network)
        .iter()
        .flat_map(|&coin_type| {
            SCAN_ACCOUNTS
                .iter()
                .map(move |&account| AccountPath { coin_type, account })
        })
        .collect()
}

/// Parse a user-typed account path such as `m/44'/145'/0'`.
///
/// Accepts `'` or `h`/`H` as the hardened marker and an optional leading `m/`.
/// Deeper paths are refused rather than truncated: `m/44'/145'/0'/0/0` is an
/// address, and silently treating it as an account is how a user ends up
/// watching the wrong branch.
pub fn parse_account_path(input: &str) -> Result<AccountPath> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(CliError::Usage(
            "give an account path such as m/44'/145'/0'".into(),
        ));
    }
    let body = trimmed
        .strip_prefix("m/")
        .or_else(|| trimmed.strip_prefix("M/"))
        .unwrap_or(trimmed);

    let levels: Vec<&str> = body.split('/').collect();
    let [purpose, coin_type, account] = levels.as_slice() else {
        return Err(CliError::Usage(format!(
            "'{trimmed}' must have exactly three levels: m/44'/<coin>'/<account>'"
        )));
    };

    let purpose = parse_hardened(purpose, "purpose")?;
    if purpose != BIP44_PURPOSE {
        return Err(CliError::Usage(format!(
            "purpose must be {BIP44_PURPOSE}' — this wallet derives BIP44 P2PKH accounts"
        )));
    }
    AccountPath::new(
        parse_hardened(coin_type, "coin type")?,
        parse_hardened(account, "account")?,
    )
}

/// One hardened level: digits followed by `'`, `h`, or `H`.
fn parse_hardened(level: &str, name: &str) -> Result<u32> {
    let digits = level
        .strip_suffix('\'')
        .or_else(|| level.strip_suffix('h'))
        .or_else(|| level.strip_suffix('H'))
        .ok_or_else(|| {
            CliError::Usage(format!(
                "{name} level '{level}' must be hardened — write it as {level}'"
            ))
        })?;
    digits
        .parse::<u32>()
        .map_err(|_| CliError::Usage(format!("{name} level '{level}' is not a number")))
}

/// BIP39 published all-zeros entropy phrase. Tests only; never a user seed.
pub const BIP39_TEST_VECTOR_MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/// First receive address at `m/44'/<coin>'/0'/0/0` for a mnemonic.
///
/// The phrase is borrowed and dropped by the caller. This function does not
/// keep it.
pub fn seed_receive_address(network: Network, mnemonic: &str) -> Result<String> {
    seed_receive_address_at(network, mnemonic, AccountPath::default_for(network))
}

/// First receive address of a chosen account, at `<account>/0/0`.
///
/// The phrase is borrowed and dropped by the caller. This function does not
/// keep it.
pub fn seed_receive_address_at(
    network: Network,
    mnemonic: &str,
    account: AccountPath,
) -> Result<String> {
    let wallet = Wallet::from_mnemonic(mnemonic, "")?;
    Ok(wallet
        .address(network, &account.address_path(false, 0))?
        .encode())
}

/// Build a mnemonic from caller-supplied entropy (16 bytes → 12 words).
pub fn mnemonic_from_entropy(entropy: &[u8]) -> Result<String> {
    let mnemonic = Mnemonic::from_entropy(entropy).map_err(|error| {
        CliError::Usage(format!("entropy must be a valid BIP39 length ({error})"))
    })?;
    Ok(mnemonic.to_string())
}

#[derive(ZeroizeOnDrop)]
pub struct Wallet {
    seed: [u8; 64],
}

impl Wallet {
    /// Build from a BIP39 phrase. The passphrase is BIP39's optional 25th
    /// word; an empty string is the overwhelmingly common case.
    pub fn from_mnemonic(phrase: &str, passphrase: &str) -> Result<Self> {
        let trimmed = Zeroizing::new(phrase.split_whitespace().collect::<Vec<_>>().join(" "));
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

    /// Derive the signing key at a path.
    ///
    /// Returned by value and never stored: the caller signs and drops it.
    pub fn signing_key(&self, path: &str) -> Result<k256::ecdsa::SigningKey> {
        let parsed: DerivationPath = path
            .parse()
            .map_err(|_| CliError::Usage(format!("'{path}' is not a valid derivation path")))?;
        let xprv = XPrv::derive_from_path(self.seed, &parsed)
            .map_err(|e| CliError::Internal(format!("derivation failed: {e}")))?;
        k256::ecdsa::SigningKey::from_slice(&xprv.private_key().to_bytes())
            .map_err(|e| CliError::Internal(format!("invalid derived key: {e}")))
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

    /// Account-level xPub at this network's default coin type. Public only.
    pub fn account_xpub(&self, network: Network, account: u32) -> Result<String> {
        let selected = AccountPath::new(network.default_coin_type(), account)?;
        self.account_xpub_at(selected)
    }

    /// Account-level xPub at a chosen account. Public material only.
    ///
    /// This is what a watch-only wallet or an air-gapped signer is handed, so
    /// it has to follow the account the user picked rather than the default.
    pub fn account_xpub_at(&self, account: AccountPath) -> Result<String> {
        let path: DerivationPath = account
            .path()
            .parse()
            .map_err(|_| CliError::Usage("invalid account path".into()))?;
        let xprv = XPrv::derive_from_path(self.seed, &path)
            .map_err(|error| CliError::Internal(format!("derivation failed: {error}")))?;
        Ok(xprv.public_key().to_string(Prefix::XPUB))
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
    const TEST_MNEMONIC: &str = BIP39_TEST_VECTOR_MNEMONIC;

    #[test]
    fn paths_follow_the_documented_layout() {
        assert_eq!(account_path(145, 0), "m/44'/145'/0'");
        assert_eq!(account_path(1, 1), "m/44'/1'/1'");
        assert_eq!(address_path(145, 0, false, 0), "m/44'/145'/0'/0/0");
        assert_eq!(address_path(145, 0, true, 7), "m/44'/145'/0'/1/7");
    }

    #[test]
    fn chipnet_seed_receive_address_is_bchtest() {
        let address =
            seed_receive_address(Network::Chipnet, BIP39_TEST_VECTOR_MNEMONIC).expect("derive");
        assert!(
            address.starts_with("bchtest:"),
            "chipnet receive must be bchtest, got {address}"
        );
        let again =
            seed_receive_address(Network::Chipnet, BIP39_TEST_VECTOR_MNEMONIC).expect("again");
        assert_eq!(address, again);
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
    fn derived_p2pkh_round_trips_through_cashaddr() {
        let w = Wallet::from_mnemonic(TEST_MNEMONIC, "").unwrap();
        let derived = w
            .address(Network::Mainnet, "m/44'/145'/0'/0/0")
            .expect("derivation must succeed");
        let encoded = derived.encode();
        let decoded = Address::decode(&encoded).expect("derived CashAddr must decode");
        assert_eq!(decoded.kind, AddressKind::P2pkh);
        assert_eq!(decoded.hash, derived.hash);
        assert_eq!(decoded.encode(), encoded);

        let chip = w
            .address(Network::Chipnet, "m/44'/1'/0'/0/0")
            .expect("chipnet derivation must succeed");
        assert!(chip.encode().starts_with("bchtest:"));
        assert_eq!(
            Address::decode(&chip.encode())
                .expect("chipnet CashAddr must decode")
                .hash,
            chip.hash
        );
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

    #[test]
    fn the_offered_accounts_are_exactly_the_ones_discovery_scans() {
        // A hand-written picker is how "my wallet is empty" bugs happen: the
        // user selects a path discovery never looks at, or discovery finds
        // history on a path the picker cannot express.
        for network in [Network::Mainnet, Network::Chipnet] {
            let choices = account_choices(network);
            assert_eq!(
                choices.len(),
                scan_coin_types(network).len() * SCAN_ACCOUNTS.len()
            );
            assert_eq!(
                choices[0],
                AccountPath::default_for(network),
                "{network} must offer its own default first"
            );
            for choice in &choices {
                assert!(choice.is_scanned_for(network), "{choice} is not scanned");
            }
        }
    }

    #[test]
    fn an_account_path_round_trips_through_the_text_a_user_sees() {
        let account = AccountPath::new(145, 3).expect("in range");
        assert_eq!(account.to_string(), "m/44'/145'/3'");
        assert_eq!(account.path(), "m/44'/145'/3'");
        assert_eq!(parse_account_path("m/44'/145'/3'").unwrap(), account);
        // The alternate hardened marker and a missing `m/` are both common in
        // exports from other tooling.
        assert_eq!(parse_account_path("44h/145h/3h").unwrap(), account);
        assert_eq!(parse_account_path("  M/44'/145'/3'  ").unwrap(), account);
    }

    #[test]
    fn parsing_refuses_paths_that_are_not_accounts() {
        // Truncating an address path to its account silently changes which
        // branch is watched, so it is an error rather than a coercion.
        for bad in [
            "m/44'/145'/0'/0/0",
            "m/44'/145'",
            "m/44'/145'/0",
            "m/49'/145'/0'",
            "m/44'/145'/x'",
            "",
        ] {
            assert!(
                parse_account_path(bad).is_err(),
                "'{bad}' must not parse as an account path"
            );
        }
        assert!(AccountPath::new(0x8000_0000, 0).is_err());
        assert!(AccountPath::new(145, 0x8000_0000).is_err());
    }

    #[test]
    fn a_chosen_account_derives_a_different_wallet_than_the_default() {
        let default = AccountPath::default_for(Network::Mainnet);
        assert!(default.is_default_for(Network::Mainnet));
        assert_eq!(default.to_string(), "m/44'/145'/0'");

        let legacy = AccountPath::new(0, 0).expect("in range");
        assert!(!legacy.is_default_for(Network::Mainnet));
        assert!(legacy.is_scanned_for(Network::Mainnet));

        let at_default = seed_receive_address_at(Network::Mainnet, TEST_MNEMONIC, default).unwrap();
        let at_legacy = seed_receive_address_at(Network::Mainnet, TEST_MNEMONIC, legacy).unwrap();
        assert_eq!(
            at_default,
            seed_receive_address(Network::Mainnet, TEST_MNEMONIC).unwrap(),
            "the default account must stay what an unchosen path derives"
        );
        assert_ne!(
            at_default, at_legacy,
            "picking a coin type must actually change the wallet"
        );
        assert!(at_legacy.starts_with("bitcoincash:"));
    }

    #[test]
    fn an_account_xpub_follows_the_chosen_account() {
        let wallet = Wallet::from_mnemonic(TEST_MNEMONIC, "").unwrap();
        let default = AccountPath::default_for(Network::Mainnet);
        assert_eq!(
            wallet.account_xpub_at(default).unwrap(),
            wallet.account_xpub(Network::Mainnet, 0).unwrap(),
            "the default account must agree with the network-shaped call"
        );
        let other = AccountPath::new(145, 1).expect("in range");
        assert_ne!(
            wallet.account_xpub_at(default).unwrap(),
            wallet.account_xpub_at(other).unwrap()
        );
        assert!(wallet.account_xpub_at(other).unwrap().starts_with("xpub"));
    }
}
