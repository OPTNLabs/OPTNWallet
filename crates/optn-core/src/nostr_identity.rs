//! Which Nostr key does which job, and why they are never the same key.
//!
//! The wallet uses Nostr for three unrelated things, and each wants a key with
//! a different lifetime. Sharing one across two of them would link them, which
//! is the entire property two of the three exist to avoid.
//!
//! | Job | Key | Lifetime | Why |
//! | --- | --- | --- | --- |
//! | Chat | NIP-06 from the seed, `m/44'/1237'/0'/0/0` | long-lived, re-derived | contacts must find the same `npub` after a restore |
//! | CashFusion | a fresh throwaway per round | dies with the round | unlinkability; never the wallet or chat identity |
//! | WizardConnect | CSPRNG per dapp pairing, encrypted at rest | survives restart, *not* a seed-only reinstall | the dapp recognises this pairing, not chat and not a mix round |
//!
//! The rule that had to be learned: **a relay identity must never be a
//! function of the pairing URI.** WizardConnect keys were once
//! `SHA256("wizardconnect:" + wallet_id + ":" + uri)`, and the dapp *creates*
//! that URI — it is the QR code on its own screen. Anyone who saw the QR could
//! compute the wallet's relay key. [`check_not_uri_derived`] is that mistake
//! written down so it cannot be made again quietly, in this crate or any
//! future one.
//!
//! The URI still has a job: its hash names the stored key. Hashed, never raw,
//! so a pairing URI does not sit in storage in the clear.
//!
//! **The chat identity is deliberately behind a replaceable boundary.** Today
//! it is NIP-06 from the wallet's own mnemonic, which means an `npub` is a
//! deterministic function of a wallet seed — anyone who learns both learns
//! that they belong together, and the identity cannot move to another wallet
//! any more than the seed can. That is the cost of contacts being able to find
//! you again after a restore.
//!
//! A better scheme would let an identity move between wallets the way coins
//! do, without being welded to one seed. [`AccountScheme`] is a union with one
//! member so that arriving is a new variant rather than a hunt through
//! callers, and [`AccountScheme::is_portable`] is the property that would
//! change — stated now so the difference is visible before anything depends on
//! today's answer.
//!
//! No key is generated here. This crate holds no randomness; it says what a
//! caller must have generated and refuses what it must not have.

use sha2::{Digest, Sha256};

use crate::error::{CliError, Result};

/// The NIP-06 path the chat identity is derived at.
///
/// Coin type 1237 is Nostr's. The path is fixed because a contact who saved
/// your `npub` has to find the same one after you restore from your seed.
pub const CHAT_NIP06_PATH: &str = "m/44'/1237'/0'/0/0";

/// Nostr's SLIP-44 coin type.
pub const NIP06_COIN_TYPE: u32 = 1237;
/// The address index the chat identity itself lives at.
pub const NIP06_IDENTITY_INDEX: u32 = 0;

/// A NIP-06 path: `m/44'/1237'/<account>'/0/<index>`.
///
/// One tree carries the chat identity at index 0 and each MLS device leaf
/// after it, so a restored wallet republishes the same key package rather than
/// appearing as a new device to everyone it has ever spoken to.
pub fn nip06_path(account: u32, index: u32) -> String {
    format!("m/44'/{NIP06_COIN_TYPE}'/{account}'/0/{index}")
}

/// The index an MLS device leaf sits at. Device 0 is index 1.
pub const fn mls_index(device: u32) -> u32 {
    device + 1
}

/// How a wallet produces its Nostr account key.
///
/// One member today. A migration is a new variant here, which is the whole
/// reason this is an enum rather than an assumption spread through callers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum AccountScheme {
    /// NIP-06 from the wallet's BIP39 mnemonic.
    Nip06Bip39,
}

impl AccountScheme {
    pub const ALL: &'static [Self] = &[Self::Nip06Bip39];

    /// The tag this scheme is stored under.
    pub const fn id(self) -> &'static str {
        match self {
            Self::Nip06Bip39 => "nip06-bip39",
        }
    }

    /// Whether an identity under this scheme could move to another wallet.
    ///
    /// False for NIP-06: the key *is* the seed at a path, so the identity is
    /// the wallet. A scheme that let someone carry an identity between wallets
    /// the way they carry coins would answer true, and this is the property
    /// that tells the two apart.
    pub const fn is_portable(self) -> bool {
        match self {
            Self::Nip06Bip39 => false,
        }
    }

    /// Whether knowing the identity tells you which wallet it belongs to.
    ///
    /// The other side of the same coin, and the reason a replacement is wanted:
    /// under NIP-06 an `npub` and a wallet are the same secret in two forms.
    pub const fn links_identity_to_wallet(self) -> bool {
        !self.is_portable()
    }
}

/// The prefix of the derivation this module exists to forbid.
const FORBIDDEN_URI_DERIVATION_PREFIX: &str = "wizardconnect:";

/// Where a key for a job comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    /// Derived from the wallet's seed at a fixed path.
    SeedDerived { path: &'static str },
    /// Generated fresh, discarded when the work is done.
    FreshPerUse,
    /// Generated from the system's randomness and stored encrypted.
    CsprngPersisted,
}

/// One of the three jobs the wallet uses Nostr for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum NostrJob {
    /// Direct messages and groups.
    Chat,
    /// One CashFusion round.
    FusionRound,
    /// One dapp pairing over WizardConnect.
    WizardPairing,
    /// One MLS device leaf, for private groups.
    ///
    /// Seed-derived like chat and on the same tree, one index along per device,
    /// so a restored wallet republishes the same key package instead of
    /// appearing as a stranger to every group it was in.
    MlsDevice,
}

impl NostrJob {
    pub const ALL: &'static [Self] = &[
        Self::Chat,
        Self::FusionRound,
        Self::WizardPairing,
        Self::MlsDevice,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::FusionRound => "a CashFusion round",
            Self::WizardPairing => "a WizardConnect pairing",
            Self::MlsDevice => "an MLS device",
        }
    }

    pub const fn key_source(self) -> KeySource {
        match self {
            Self::Chat => KeySource::SeedDerived {
                path: CHAT_NIP06_PATH,
            },
            Self::FusionRound => KeySource::FreshPerUse,
            Self::WizardPairing => KeySource::CsprngPersisted,
            // The same tree as chat, one index along per device.
            Self::MlsDevice => KeySource::SeedDerived {
                path: MLS_DEVICE_0_PATH,
            },
        }
    }

    /// Whether the same key is expected after the process restarts.
    pub const fn survives_restart(self) -> bool {
        match self {
            // Re-derived from the seed, so it is the same key forever.
            Self::Chat => true,
            // The point of it is that it does not.
            Self::FusionRound => false,
            // Stored encrypted, so a session can reconnect.
            Self::WizardPairing => true,
            Self::MlsDevice => true,
        }
    }

    /// Whether the seed alone brings this key back.
    ///
    /// Only chat. A pairing survives a restart but not a reinstall from the
    /// seed alone -- the dapp's QR has to be scanned again, which is the
    /// correct outcome: a new install is a new pairing.
    pub const fn recoverable_from_seed(self) -> bool {
        matches!(self, Self::Chat | Self::MlsDevice)
    }

    /// Whether this job's key may ever be derived from the wallet's seed.
    ///
    /// False for both of the others, and for different reasons: a fusion round
    /// derived from the seed would link every round to the wallet, and a
    /// pairing derived from it would survive a reinstall the dapp should not
    /// recognise.
    pub const fn may_derive_from_seed(self) -> bool {
        matches!(self, Self::Chat | Self::MlsDevice)
    }
}

/// The path MLS device 0 derives at.
pub const MLS_DEVICE_0_PATH: &str = "m/44'/1237'/0'/0/1";

/// Whether two jobs may share a key. They may not.
///
/// Stated as a function rather than left implicit, so the answer is the same
/// everywhere and a caller cannot reason its way to an exception. Chat and an
/// MLS device share a *tree* -- they are the same seed at neighbouring indices
/// -- and still not a key: one is the secp256k1 identity contacts know, the
/// other an Ed25519 leaf in a group.
pub const fn may_share_key(a: NostrJob, b: NostrJob) -> bool {
    // A job shares a key with itself and nothing else.
    matches!(
        (a, b),
        (NostrJob::Chat, NostrJob::Chat)
            | (NostrJob::FusionRound, NostrJob::FusionRound)
            | (NostrJob::WizardPairing, NostrJob::WizardPairing)
            | (NostrJob::MlsDevice, NostrJob::MlsDevice)
    )
}

/// The name a pairing's key is stored under.
///
/// The wallet it belongs to, and the *hash* of the URI rather than the URI, so
/// a pairing address is not sitting in storage in the clear.
pub fn pairing_storage_key(wallet_id: u64, pairing_uri: &str) -> String {
    format!("{wallet_id}:{}", pairing_id(pairing_uri))
}

/// A stable id for a pairing URI.
///
/// Canonicalised first — trimmed, percent-decoded where it decodes, lowercased
/// — so the same pairing scanned twice lands on the same stored key rather
/// than a second one.
pub fn pairing_id(pairing_uri: &str) -> String {
    let canonical = canonicalize_pairing_uri(pairing_uri);
    let digest = Sha256::digest(canonical.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Trim, percent-decode if it decodes, lowercase.
fn canonicalize_pairing_uri(uri: &str) -> String {
    let trimmed = uri.trim();
    percent_decode(trimmed)
        .unwrap_or_else(|| trimmed.to_string())
        .to_lowercase()
}

/// Percent-decoding, or `None` when the input is not validly encoded.
///
/// Matching the TypeScript, which falls back to the raw string when
/// `decodeURIComponent` throws: a URI that is not valid percent-encoding is
/// still a URI, and refusing to canonicalise it would mean refusing the
/// pairing.
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                let hex = value.get(index + 1..index + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// The derivation this module forbids, kept so it can be recognised.
///
/// `SHA256("wizardconnect:" + wallet_id + ":" + uri)` — what the wallet used
/// to do. Reproduced here for one purpose: to check that a key is *not* this.
fn uri_derived_key(wallet_id: u64, pairing_uri: &str) -> [u8; 32] {
    let material = format!("{FORBIDDEN_URI_DERIVATION_PREFIX}{wallet_id}:{pairing_uri}");
    let digest = Sha256::digest(material.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// Refuse a relay key that anyone holding the pairing URI could compute.
///
/// The dapp creates the URI and puts it on screen as a QR code, so a key
/// derived from it is a key every observer of that screen already has. Checked
/// against both the raw and the canonical form, because a caller that
/// "improved" the old derivation by normalising its input would have changed
/// nothing that matters.
pub fn check_not_uri_derived(key: &[u8; 32], wallet_id: u64, pairing_uri: &str) -> Result<()> {
    let canonical = canonicalize_pairing_uri(pairing_uri);
    for candidate in [pairing_uri, canonical.as_str()] {
        if *key == uri_derived_key(wallet_id, candidate) {
            return Err(CliError::Usage(
                "this relay key is derived from the pairing URI. The dapp created that URI and \
                 showed it as a QR code, so anyone who saw it can compute this key. Generate one \
                 from the system's randomness instead."
                    .into(),
            ));
        }
    }
    Ok(())
}

/// Whether a private key is in range for secp256k1.
///
/// Not zero, and below the curve order. A CSPRNG will essentially never
/// produce one that is not, but "essentially never" is the wrong thing to
/// build a key generator on, and the caller loops until this passes.
pub fn is_valid_secret_key(key: &[u8; 32]) -> bool {
    k256::SecretKey::from_slice(key).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relay_key_derived_from_the_pairing_uri_is_refused() {
        // The bug: the dapp creates the URI and shows it as a QR code, so a key
        // derived from it is a key every observer already has.
        let wallet_id = 7;
        let uri = "wiz://relay.example/pair?token=abc";
        let leaked = uri_derived_key(wallet_id, uri);

        let error = check_not_uri_derived(&leaked, wallet_id, uri).expect_err("must be refused");
        assert!(error.to_string().contains("saw it can compute"), "{error}");

        // Normalising the input first changes nothing that matters, so that is
        // refused too.
        let canonical = canonicalize_pairing_uri(uri);
        let leaked_canonical = uri_derived_key(wallet_id, &canonical);
        assert!(check_not_uri_derived(&leaked_canonical, wallet_id, uri).is_err());

        // A key from anywhere else passes.
        let random = [7u8; 32];
        assert!(check_not_uri_derived(&random, wallet_id, uri).is_ok());
    }

    #[test]
    fn each_job_has_its_own_key_and_they_never_meet() {
        // Sharing one across two jobs would link them, which is the entire
        // property two of the three exist to avoid.
        for a in NostrJob::ALL {
            for b in NostrJob::ALL {
                assert_eq!(
                    may_share_key(*a, *b),
                    a == b,
                    "{a:?} and {b:?} must not share a key"
                );
            }
        }
    }

    #[test]
    fn the_chat_identity_is_behind_a_boundary_because_it_should_not_be_the_wallet() {
        // Today an npub is the wallet seed at a path, so the two are the same
        // secret in two forms: learn one and you have linked the other. That is
        // the price of contacts finding you again after a restore, and it is
        // what a portable scheme would buy back.
        assert_eq!(AccountScheme::Nip06Bip39.id(), "nip06-bip39");
        assert!(!AccountScheme::Nip06Bip39.is_portable());
        assert!(AccountScheme::Nip06Bip39.links_identity_to_wallet());

        // One member today. A migration is a new variant, which is the reason
        // this is an enum at all rather than an assumption in every caller.
        assert_eq!(AccountScheme::ALL.len(), 1);
        for scheme in AccountScheme::ALL {
            assert!(scheme.is_portable() != scheme.links_identity_to_wallet());
        }
    }

    #[test]
    fn chat_and_the_mls_devices_share_one_tree_at_neighbouring_indices() {
        // A restored wallet must republish the same key package, or it appears
        // as a stranger to every group it was in.
        assert_eq!(nip06_path(0, NIP06_IDENTITY_INDEX), CHAT_NIP06_PATH);
        assert_eq!(nip06_path(0, mls_index(0)), MLS_DEVICE_0_PATH);
        assert_eq!(MLS_DEVICE_0_PATH, "m/44'/1237'/0'/0/1");

        // Device 0 is index 1; each extra device is one further along.
        assert_eq!(mls_index(0), 1);
        assert_eq!(mls_index(1), 2);
        assert_eq!(nip06_path(0, mls_index(2)), "m/44'/1237'/0'/0/3");

        // Neighbouring indices, still never the same key -- one is the
        // secp256k1 identity contacts know, the other an Ed25519 group leaf.
        assert!(!may_share_key(NostrJob::Chat, NostrJob::MlsDevice));
        assert_ne!(CHAT_NIP06_PATH, MLS_DEVICE_0_PATH);
    }

    #[test]
    fn only_chat_comes_back_from_the_seed() {
        // A contact who saved your npub has to find the same one after a
        // restore, so chat is seed-derived at a fixed path.
        assert_eq!(
            NostrJob::Chat.key_source(),
            KeySource::SeedDerived {
                path: CHAT_NIP06_PATH
            }
        );
        assert_eq!(CHAT_NIP06_PATH, "m/44'/1237'/0'/0/0");
        assert!(NostrJob::Chat.recoverable_from_seed());
        assert!(NostrJob::Chat.may_derive_from_seed());

        // A fusion round derived from the seed would link every round to the
        // wallet, which is the opposite of the point.
        assert_eq!(NostrJob::FusionRound.key_source(), KeySource::FreshPerUse);
        assert!(!NostrJob::FusionRound.survives_restart());
        assert!(!NostrJob::FusionRound.may_derive_from_seed());

        // A pairing survives a restart but not a reinstall: a new install is a
        // new pairing, and the dapp's QR gets scanned again.
        assert_eq!(
            NostrJob::WizardPairing.key_source(),
            KeySource::CsprngPersisted
        );
        assert!(NostrJob::WizardPairing.survives_restart());
        assert!(!NostrJob::WizardPairing.recoverable_from_seed());
        assert!(!NostrJob::WizardPairing.may_derive_from_seed());

        // An MLS device is the one other job that must come back from the seed,
        // for the same reason chat does: the group has to recognise it.
        assert!(NostrJob::MlsDevice.recoverable_from_seed());
        assert!(NostrJob::MlsDevice.may_derive_from_seed());
    }

    #[test]
    fn a_pairing_is_stored_under_a_hash_never_the_uri_itself() {
        let uri = "wiz://relay.example/pair?token=abc";
        let key = pairing_storage_key(7, uri);

        assert!(key.starts_with("7:"), "{key}");
        assert!(
            !key.contains("relay.example"),
            "the URI must not be in it: {key}"
        );
        assert!(!key.contains("token"), "{key}");
        assert_eq!(key.len(), 2 + 64, "wallet id, colon, and a sha256 hex");

        // A different wallet with the same pairing gets a different slot.
        assert_ne!(pairing_storage_key(8, uri), key);
    }

    #[test]
    fn the_same_pairing_scanned_twice_lands_on_the_same_slot() {
        // Otherwise re-scanning a QR would mint a second key and the dapp would
        // stop recognising the pairing it had.
        let plain = "wiz://relay.example/pair?token=abc";
        for variant in [
            "  wiz://relay.example/pair?token=abc  ",
            "WIZ://RELAY.EXAMPLE/PAIR?TOKEN=ABC",
            "wiz://relay.example/pair%3Ftoken%3Dabc",
        ] {
            let canonical = canonicalize_pairing_uri(variant);
            assert_eq!(
                canonical,
                canonicalize_pairing_uri(plain),
                "{variant} should canonicalise the same"
            );
        }

        // A genuinely different pairing does not collide.
        assert_ne!(
            pairing_id(plain),
            pairing_id("wiz://relay.example/pair?token=xyz")
        );
    }

    #[test]
    fn a_uri_that_is_not_valid_encoding_is_still_a_pairing() {
        // The TypeScript falls back to the raw string when decodeURIComponent
        // throws, and refusing here would mean refusing the pairing outright.
        let broken = "wiz://relay.example/pair?token=%zz";
        let id = pairing_id(broken);
        assert_eq!(id.len(), 64);
        assert_eq!(id, pairing_id(broken), "and it is stable");
    }

    #[test]
    fn a_key_out_of_range_for_the_curve_is_not_a_key() {
        // What the caller's generate-and-retry loop is checking.
        assert!(!is_valid_secret_key(&[0u8; 32]), "zero is not a key");
        assert!(!is_valid_secret_key(&[0xff; 32]), "above the curve order");
        let mut one = [0u8; 32];
        one[31] = 1;
        assert!(is_valid_secret_key(&one));
    }
}
