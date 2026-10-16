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

use bip32::{ChildNumber, DerivationPath, ExtendedKey, Prefix, XPrv, XPub};
use bip39::{Language, Mnemonic};
use ripemd::Ripemd160;
use sha2::{Digest, Sha256, Sha512};
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
        Network::Testnet3 | Network::Testnet4 | Network::Chipnet => &[1, 145, 0],
        // A locally mined chain has no legacy wallets to rediscover, so the
        // scan is just its own coin type.
        Network::Regtest => &[1],
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

/// BIP39 word counts this wallet creates and imports.
///
/// Same set as `optn new --words`. 12 is the default; 24 is 256 bits of entropy.
pub const BIP39_WORD_COUNTS: [usize; 5] = [12, 15, 18, 21, 24];

/// Default create length. Matches `optn new` when `--words` is omitted.
pub const BIP39_DEFAULT_WORD_COUNT: usize = 12;

/// Entropy bytes for a BIP39 word count. Shared by the CLI and the wallet UI.
pub fn entropy_len_for_word_count(words: usize) -> Result<usize> {
    match words {
        12 => Ok(16),
        15 => Ok(20),
        18 => Ok(24),
        21 => Ok(28),
        24 => Ok(32),
        other => Err(CliError::Usage(format!(
            "word count must be 12, 15, 18, 21 or 24 (got {other})"
        ))),
    }
}

/// Build a mnemonic from caller-supplied entropy.
///
/// Valid lengths are 16, 20, 24, 28, and 32 bytes (12–24 words). The caller
/// gathers the bytes (Web Crypto, OS RNG); this function does not.
pub fn mnemonic_from_entropy(entropy: &[u8]) -> Result<String> {
    let mnemonic = Mnemonic::from_entropy(entropy).map_err(|error| {
        CliError::Usage(format!("entropy must be a valid BIP39 length ({error})"))
    })?;
    Ok(mnemonic.to_string())
}

/// Whether `phrase` is an English BIP39 mnemonic written exactly as BIP39
/// writes one: lowercase words from the list, single spaces, no padding, a
/// valid checksum, 12 to 24 words.
///
/// Exact rather than forgiving, like bip39.js's `validateMnemonic`: the text
/// that passes is the text the seed is computed from (see [`bip39_seed`]), so
/// a phrase with stray capitals or spaces must be normalized by the caller
/// first, not accepted here and then hashed as typed.
pub fn is_canonical_mnemonic(phrase: &str) -> bool {
    Mnemonic::parse_in_normalized(Language::English, phrase)
        .is_ok_and(|mnemonic| mnemonic.to_string() == phrase)
}

/// PBKDF2 rounds BIP39 fixes for mnemonic-to-seed.
const BIP39_SEED_ROUNDS: u32 = 2048;

/// BIP39's mnemonic-to-seed over the phrase exactly as given.
///
/// BIP39 defines the seed for any sentence, valid or not, and bip39.js's
/// `mnemonicToSeed` computes it that way, without trimming or collapsing
/// spaces. Every wallet the TypeScript side ever stored derives from that
/// seed, so this reproduces it byte for byte rather than refusing or
/// reshaping a phrase that may already hold funds. [`Wallet::from_mnemonic`]
/// stays the checked entry point for a phrase being typed in.
///
/// Both strings must already be NFKD-normalized, as BIP39 requires; this
/// crate leaves Unicode normalization to the caller, as `from_mnemonic` does.
pub fn bip39_seed(phrase: &str, passphrase: &str) -> Zeroizing<[u8; 64]> {
    let salt = Zeroizing::new(format!("mnemonic{passphrase}"));
    let mut seed = Zeroizing::new([0u8; 64]);
    pbkdf2::pbkdf2_hmac::<Sha512>(
        phrase.as_bytes(),
        salt.as_bytes(),
        BIP39_SEED_ROUNDS,
        seed.as_mut(),
    );
    seed
}

/// Extended public keys are `xpub` on mainnet and `tpub` on every test
/// network, the version bytes libauth, Electron Cash and hardware wallets use.
fn public_prefix(network: Network) -> Prefix {
    match network {
        Network::Mainnet => Prefix::XPUB,
        _ => Prefix::TPUB,
    }
}

/// `xprv` on mainnet, `tprv` on every test network.
fn private_prefix(network: Network) -> Prefix {
    match network {
        Network::Mainnet => Prefix::XPRV,
        _ => Prefix::TPRV,
    }
}

fn not_an_hd_public_key() -> CliError {
    CliError::Usage("Enter a valid BIP32 public key.".into())
}

/// Parse an `xpub` or `tpub`. Other version bytes are refused: `ypub` and
/// `zpub` name script types this wallet does not derive, and a private key
/// is not something a watch-only path should be handed.
fn parse_hd_public_key(text: &str) -> Result<(ExtendedKey, XPub)> {
    let key: ExtendedKey = text.parse().map_err(|_| not_an_hd_public_key())?;
    if key.prefix != Prefix::XPUB && key.prefix != Prefix::TPUB {
        return Err(not_an_hd_public_key());
    }
    let xpub = XPub::try_from(key.clone()).map_err(|_| not_an_hd_public_key())?;
    Ok((key, xpub))
}

/// The compressed public key at non-hardened child `index` of an extended
/// public key. A hardened index cannot be derived from public material, so it
/// is refused rather than wrapped.
pub fn hd_public_key_child(hd_public_key: &str, index: u32) -> Result<[u8; 33]> {
    let (_, xpub) = parse_hd_public_key(hd_public_key.trim())?;
    let child_number = ChildNumber::new(index, false)
        .map_err(|_| CliError::Usage(format!("child index {index} must be below 2^31")))?;
    let child = xpub
        .derive_child(child_number)
        .map_err(|error| CliError::Internal(format!("public derivation failed: {error}")))?;
    Ok(child.to_bytes())
}

/// Re-serialize an extended public key with `network`'s version bytes.
///
/// The node (depth, parent, index, chain code, key) is unchanged; only the
/// `xpub`/`tpub` prefix moves. A Trezor asked for "Bcash Testnet" hands back
/// a `tpub`, and a chipnet export may later be opened on mainnet, while the
/// on-chain keys are the same either way. A key already in the right form is
/// returned as given, trimmed.
pub fn align_hd_public_key_network(network: Network, hd_public_key: &str) -> Result<String> {
    let raw = hd_public_key.trim();
    let (mut key, _) = parse_hd_public_key(raw)?;
    let target = public_prefix(network);
    if key.prefix == target {
        return Ok(raw.to_owned());
    }
    key.prefix = target;
    Ok(key.to_string())
}

#[derive(ZeroizeOnDrop)]
pub struct Wallet {
    seed: [u8; 64],
}

impl Wallet {
    /// Private restart-state key, independent of the wallet-file password.
    /// RFC 5869 context separates this from signing, other accounts and chains.
    /// It is never an unlock credential and must not cross a renderer boundary.
    pub fn checkpoint_key(
        &self,
        network: Network,
        account: AccountPath,
    ) -> Result<crate::wallet_pack::PackKey> {
        let hk = hkdf::Hkdf::<Sha256>::new(Some(b"OPTN/HD-wallet-checkpoint/v1"), &self.seed);
        let mut key = Zeroizing::new([0u8; 32]);
        hk.expand(format!("{network}\0{account}").as_bytes(), key.as_mut())
            .map_err(|_| CliError::Internal("invalid checkpoint key length".into()))?;
        Ok(crate::wallet_pack::PackKey::from_bytes(*key))
    }

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

    /// Build from a seed already computed, e.g. by [`bip39_seed`].
    pub fn from_seed(seed: &[u8; 64]) -> Self {
        Wallet { seed: *seed }
    }

    /// The extended private key at a path.
    fn xprv_at(&self, path: &str) -> Result<XPrv> {
        let parsed: DerivationPath = path
            .parse()
            .map_err(|_| CliError::Usage(format!("'{path}' is not a valid derivation path")))?;
        XPrv::derive_from_path(self.seed, &parsed)
            .map_err(|e| CliError::Internal(format!("derivation failed: {e}")))
    }

    /// Derive the compressed public key at a path.
    pub fn public_key(&self, path: &str) -> Result<[u8; 33]> {
        Ok(self.xprv_at(path)?.public_key().to_bytes())
    }

    /// Derive the signing key at a path.
    ///
    /// Returned by value and never stored: the caller signs and drops it.
    pub fn signing_key(&self, path: &str) -> Result<k256::ecdsa::SigningKey> {
        let xprv = self.xprv_at(path)?;
        k256::ecdsa::SigningKey::from_slice(&xprv.private_key().to_bytes())
            .map_err(|e| CliError::Internal(format!("invalid derived key: {e}")))
    }

    /// The raw 32-byte private key at a path, wiped when dropped. For a
    /// boundary that must hand key bytes on; signing in Rust uses
    /// [`Wallet::signing_key`].
    pub fn private_key(&self, path: &str) -> Result<Zeroizing<[u8; 32]>> {
        Ok(Zeroizing::new(self.xprv_at(path)?.to_bytes()))
    }

    /// The private key and its compressed public key at a path, from one
    /// derivation.
    pub fn key_pair(&self, path: &str) -> Result<(Zeroizing<[u8; 32]>, [u8; 33])> {
        let xprv = self.xprv_at(path)?;
        Ok((
            Zeroizing::new(xprv.to_bytes()),
            xprv.public_key().to_bytes(),
        ))
    }

    /// The extended public key at a path, `xpub` or `tpub` by network.
    pub fn xpub_at(&self, network: Network, path: &str) -> Result<String> {
        Ok(self
            .xprv_at(path)?
            .public_key()
            .to_string(public_prefix(network)))
    }

    /// The extended private key at a path, `xprv` or `tprv` by network.
    pub fn xprv_string_at(&self, network: Network, path: &str) -> Result<Zeroizing<String>> {
        Ok(self.xprv_at(path)?.to_string(private_prefix(network)))
    }

    /// BIP32 master fingerprint: the first four bytes of HASH160 of the root
    /// public key, which PSBTs and descriptors use to name the seed a key
    /// belongs to.
    pub fn master_fingerprint(&self) -> Result<[u8; 4]> {
        let root = self.xprv_at("m")?;
        let mut fingerprint = [0u8; 4];
        fingerprint.copy_from_slice(&hash160(&root.public_key().to_bytes())[..4]);
        Ok(fingerprint)
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

    #[test]
    fn checkpoint_key_matches_independent_rfc5869_vector_and_separates_contexts() {
        // Public BIP39/TREZOR fixture. Oracle: Python hashlib PBKDF2 + hmac
        // extract/expand, not this implementation or the wallet-file password.
        let wallet = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "TREZOR").unwrap();
        let account = AccountPath::new(1, 0).unwrap();
        let key = wallet.checkpoint_key(Network::Chipnet, account).unwrap();
        assert_eq!(
            key.expose(),
            &[
                0x64, 0xc4, 0xed, 0x90, 0x04, 0xc9, 0xc1, 0xe7, 0x24, 0x24, 0x7a, 0xa9, 0x3d, 0x5f,
                0x9b, 0x97, 0x3d, 0x61, 0x54, 0x78, 0x00, 0xb6, 0x35, 0xce, 0x22, 0xb8, 0x0b, 0x5b,
                0x71, 0x81, 0x8e, 0x97,
            ]
        );
        assert_eq!(
            key,
            wallet.checkpoint_key(Network::Chipnet, account).unwrap()
        );
        assert_ne!(
            key,
            wallet.checkpoint_key(Network::Mainnet, account).unwrap()
        );
        assert_ne!(
            key,
            wallet
                .checkpoint_key(Network::Chipnet, AccountPath::new(1, 1).unwrap())
                .unwrap()
        );
        assert_ne!(
            key,
            Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "")
                .unwrap()
                .checkpoint_key(Network::Chipnet, account)
                .unwrap()
        );
        assert_eq!(format!("{key:?}"), "PackKey(<redacted>)");
    }

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
        for words in BIP39_WORD_COUNTS {
            let entropy_bytes = entropy_len_for_word_count(words).expect("supported count");
            let entropy = vec![0x2a_u8; entropy_bytes];
            let phrase = mnemonic_from_entropy(&entropy)
                .unwrap_or_else(|e| panic!("{entropy_bytes} bytes of entropy must be valid: {e}"));
            assert_eq!(
                phrase.split_whitespace().count(),
                words,
                "{entropy_bytes} bytes should give {words} words"
            );
            let wallet = Wallet::from_mnemonic(&phrase, "")
                .unwrap_or_else(|e| panic!("{words}-word phrase must import: {e}"));
            let address = wallet
                .address(Network::Mainnet, "m/44'/145'/0'/0/0")
                .expect("derivation must succeed");
            assert!(address.encode().starts_with("bitcoincash:"));
        }
        assert!(entropy_len_for_word_count(13).is_err());
        assert_eq!(BIP39_DEFAULT_WORD_COUNT, 12);
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
            // Counted rather than interpolated: a derivation path formatted
            // into a panic message is flagged as cleartext logging of account
            // material, and the count is the stronger assertion anyway.
            let unscanned = choices
                .iter()
                .filter(|choice| !choice.is_scanned_for(network))
                .count();
            assert_eq!(
                unscanned, 0,
                "every offered account must be one {network} discovery scans"
            );
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

    // The vectors below come from the implementation this replaces in the
    // wallet: bip39.js 3.1.0 and libauth 3.1.0-next.8, run on the BIP39
    // all-zeros phrase. They are an oracle independent of this crate, and the
    // published values among them (the TREZOR seed, fingerprint 73c5da0a)
    // pin both.
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn vector_wallet() -> Wallet {
        Wallet::from_seed(&bip39_seed(TEST_MNEMONIC, ""))
    }

    #[test]
    fn the_seed_matches_bip39_js_for_any_text() {
        assert_eq!(
            hex(bip39_seed(TEST_MNEMONIC, "TREZOR").as_ref()),
            "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f\
             09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04"
        );
        assert_eq!(
            hex(bip39_seed(TEST_MNEMONIC, "").as_ref()),
            "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1\
             9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4"
        );
        // Not canonical and not reshaped: a stored phrase keeps the seed it
        // has always had. The passphrase is NFKD already, as the caller must
        // supply it.
        let raw = "  Abandon  abandon abandon abandon abandon abandon abandon \
                   abandon abandon abandon abandon about ";
        assert_eq!(
            hex(bip39_seed(raw, "pa\u{0308}ssword").as_ref()),
            "6b57f5807315ce12840628b776ed964014a9138bd2f008233be5861c584ab766\
             5b1fe5ce08bb3e9bd1607cbe55d0708ff86cba15acf6a47b68b03a598ec68903"
        );
    }

    #[test]
    fn the_seed_agrees_with_the_checked_entry_point() {
        let checked = Wallet::from_mnemonic(TEST_MNEMONIC, "TREZOR").unwrap();
        let raw = Wallet::from_seed(&bip39_seed(TEST_MNEMONIC, "TREZOR"));
        assert_eq!(
            checked.xpub_at(Network::Mainnet, "m/44'/145'/0'").unwrap(),
            raw.xpub_at(Network::Mainnet, "m/44'/145'/0'").unwrap()
        );
    }

    #[test]
    fn canonical_mnemonics_are_exactly_the_ones_bip39_js_accepts() {
        for (phrase, valid) in [
            (TEST_MNEMONIC.to_owned(), true),
            (TEST_MNEMONIC.to_uppercase(), false),
            (format!(" {TEST_MNEMONIC}"), false),
            (TEST_MNEMONIC.replacen(' ', "  ", 1), false),
            (TEST_MNEMONIC.replace("about", "abandon"), false),
            (
                "legal winner thank year wave sausage worth useful legal winner \
                 thank year wave sausage wise"
                    .to_owned(),
                true,
            ),
            (format!("{}vote", "zoo ".repeat(23)), true),
            ("not actually a mnemonic".to_owned(), false),
        ] {
            assert_eq!(is_canonical_mnemonic(&phrase), valid, "{phrase}");
        }
        assert_eq!(
            mnemonic_from_entropy(&[0x7f; 20]).unwrap(),
            "legal winner thank year wave sausage worth useful legal winner \
             thank year wave sausage wise"
        );
    }

    #[test]
    fn extended_keys_match_libauth_by_network() {
        let wallet = vector_wallet();
        assert_eq!(
            wallet.xpub_at(Network::Mainnet, "m/44'/145'/0'/0").unwrap(),
            "xpub6F2iaK2JUPcgrZ6RTGH6t8VybLPu1XzfrHsDsaKvK6NfULznU6i6aw6ZoefDW2Dp\
             NruSLw73RwQg46qvpqB3eryeJJ2tkFCF4Z6gbr8Pjja"
        );
        assert_eq!(
            wallet.xpub_at(Network::Chipnet, "m/44'/1'/0'/0").unwrap(),
            "tpubDEQBfiy13hMZzGT4NWqNnaSWwVqYQ58kuu2pDYjkrf8F6DLKAprm8c65Pyh7Przo\
             dXHtJuEXFu5yf6JbvYaL8rz7v28zapwbuzZzr7z4UvR"
        );
        assert_eq!(
            wallet
                .xprv_string_at(Network::Mainnet, "m/44'/145'/0'")
                .unwrap()
                .as_str(),
            "xprv9xywTsqYa9uDLdJs8QpXf7xwRWgPw4rq5FtkcShsDoZTqfNQjVQ3dDCdyedXX3Fq\
             B18U8e8PfVMeFqkhzPGseKVMDjGe5rPdiUXMxy7BQNJ"
        );
        assert_eq!(
            wallet
                .xprv_string_at(Network::Chipnet, "m/44'/1'/0'")
                .unwrap()
                .as_str(),
            "tprv8fPDJN9UQqg6pFsQsrVxTwHZmXLvHpfGGcsCA9rtnatUgVtBKxhtFeqiyaYKSWyd\
             unKpjhvgJf6PwTwgirwuCbFq8YKgpQiaVJf3JCrNmkR"
        );
        assert_eq!(hex(&wallet.master_fingerprint().unwrap()), "73c5da0a");
    }

    #[test]
    fn keys_at_a_path_match_libauth_and_public_derivation_agrees() {
        let wallet = vector_wallet();
        let path = "m/44'/145'/0'/0/4";
        assert_eq!(
            hex(wallet.private_key(path).unwrap().as_ref()),
            "c7e1bfbb861270227865ef22dc539230a97a716775fd8d7f0e612f71cbac2b15"
        );
        let public_key = wallet.public_key(path).unwrap();
        assert_eq!(
            hex(&public_key),
            "029c75f034981dcb99bc1b5fb2e1a001f83d37ec21fd5a1006cada901b2133b196"
        );
        let receive = wallet.xpub_at(Network::Mainnet, "m/44'/145'/0'/0").unwrap();
        assert_eq!(hd_public_key_child(&receive, 4).unwrap(), public_key);
        // The same node behind a tpub derives the same child.
        let as_tpub = align_hd_public_key_network(Network::Chipnet, &receive).unwrap();
        assert_eq!(hd_public_key_child(&as_tpub, 4).unwrap(), public_key);
        assert!(hd_public_key_child(&receive, 0x8000_0000).is_err());
        assert_eq!(
            hex(&hash160(&public_key)),
            "56231f7128a5ce118349f508d88ee7f2d4dd6a96"
        );
    }

    #[test]
    fn aligning_moves_only_the_version_bytes() {
        let receive = vector_wallet()
            .xpub_at(Network::Mainnet, "m/44'/145'/0'/0")
            .unwrap();
        let tpub = align_hd_public_key_network(Network::Chipnet, &receive).unwrap();
        assert_eq!(
            tpub,
            "tpubDFQM6YqzBfa98MHGuTGC63qLvTVYzvVjPvTXE8P4f18ZDdfVYKZBjNmQ3gk12XB4\
             AmSLxWcuy3EikHLYDh2HYJRwMtnCRmrUeWh6MuFhbJ7"
        );
        assert_eq!(
            align_hd_public_key_network(Network::Mainnet, &tpub).unwrap(),
            receive
        );
        assert_eq!(
            align_hd_public_key_network(Network::Mainnet, &format!(" {receive} ")).unwrap(),
            receive
        );
        let xprv = vector_wallet()
            .xprv_string_at(Network::Mainnet, "m/44'/145'/0'")
            .unwrap();
        for bad in ["", "xpub", xprv.as_str()] {
            assert!(align_hd_public_key_network(Network::Mainnet, bad).is_err());
        }
    }
}
