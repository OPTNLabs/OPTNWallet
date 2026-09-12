//! Watch-only BCH account validation and public address derivation.
//!
//! This is intentionally pure Rust: mobile, desktop, web and future renderers
//! must agree on what constitutes a valid account xPub and on the first
//! receive/change addresses. No private key material enters this module.

use bip32::{ChildNumber, XPub};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::cashaddr::{Address, AddressKind};
use crate::error::{CliError, Result};
use crate::hd::{account_path, hash160};
use crate::network::Network;

const MAX_XPUB_LENGTH: usize = 256;

/// Shared bound on the number of addresses in each ordinary HD branch.
pub const MAX_HD_ADDRESSES_PER_BRANCH: u32 = 10_000;

/// Receive, change, DeFi, and the compatibility chain scanned by early Rust
/// wallets. Only the first three slots allocate new addresses. RPA (3) is a key
/// gate and is excluded; DeFi contract discovery is separate from P2PKH scanning.
pub const HD_SCAN_BRANCHES: [u32; 4] = [0, 1, 7, 2];

/// Allocatable ordinary branches. Derivation indexes differ from array slots:
/// DeFi derives on chain 7, while occupying allocation slot 2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HdBranch {
    Receive,
    Change,
    Defi,
}

impl HdBranch {
    pub const fn index(self) -> u32 {
        HD_SCAN_BRANCHES[self.slot()]
    }

    pub const fn slot(self) -> usize {
        match self {
            Self::Receive => 0,
            Self::Change => 1,
            Self::Defi => 2,
        }
    }
}

/// Local allocation, independent of prederived scan inventory and coin balance.
/// An issued or reserved index is consumed even if its intended payment fails.
/// The runtime must durably store an updated candidate before exposing its address.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "StoredHdAddressAllocation")]
pub struct HdAddressAllocation {
    next: [u32; 3],
    current_receive: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredHdAddressAllocation {
    next: [u32; 3],
    current_receive: Option<u32>,
}

impl TryFrom<StoredHdAddressAllocation> for HdAddressAllocation {
    type Error = CliError;

    fn try_from(stored: StoredHdAddressAllocation) -> Result<Self> {
        if stored
            .next
            .iter()
            .any(|&next| next > MAX_HD_ADDRESSES_PER_BRANCH)
        {
            return Err(CliError::Usage(
                "HD allocation counter exceeds the branch limit".into(),
            ));
        }
        if stored
            .current_receive
            .is_some_and(|current| current >= stored.next[0])
        {
            return Err(CliError::Usage(
                "current receive index must precede the next allocation".into(),
            ));
        }
        Ok(Self {
            next: stored.next,
            current_receive: stored.current_receive,
        })
    }
}

impl HdAddressAllocation {
    pub const fn next_indexes(&self) -> [u32; 3] {
        self.next
    }

    /// The most recently allocated receive index. None also permits a nonzero
    /// receive counter when history was observed before any local allocation.
    pub const fn current_receive(&self) -> Option<u32> {
        self.current_receive
    }

    /// Advance past observed transaction history, including spent addresses.
    /// Reorgs or older observations cannot lower a counter. Invalid observations
    /// leave the entire allocation unchanged.
    pub fn observe(&mut self, last_used: [Option<u32>; 3]) -> Result<()> {
        self.next = self.observed_next(last_used)?;
        Ok(())
    }

    /// Reserve the next index after incorporating history, as one transaction.
    /// BIP44 warns beyond 20 unused external receive addresses; allocating past
    /// that gap requires explicit acknowledgement for each new receive address.
    /// Unknown history is treated conservatively as no known used address.
    /// Acknowledgement never overrides the hard branch limit.
    pub fn allocate(
        &mut self,
        branch: HdBranch,
        last_used: [Option<u32>; 3],
        acknowledge_gap: bool,
    ) -> Result<u32> {
        let mut next = self.observed_next(last_used)?;
        let slot = branch.slot();
        let index = next[slot];
        if index >= MAX_HD_ADDRESSES_PER_BRANCH {
            return Err(CliError::Usage("HD address branch is exhausted".into()));
        }
        let first_unused = last_used[slot].map_or(0, |used| used + 1);
        if branch == HdBranch::Receive
            && !acknowledge_gap
            && index >= first_unused + crate::discovery::GAP_LIMIT
        {
            return Err(CliError::Usage(
                "HD allocation exceeds the BIP44 recovery gap of 20 unused addresses; explicitly acknowledge the recovery gap to continue".into(),
            ));
        }
        next[slot] = index + 1;
        self.next = next;
        if branch == HdBranch::Receive {
            self.current_receive = Some(index);
        }
        Ok(index)
    }

    fn observed_next(&self, last_used: [Option<u32>; 3]) -> Result<[u32; 3]> {
        let mut next = self.next;
        for (next, used) in next.iter_mut().zip(last_used) {
            if let Some(used) = used {
                if used >= MAX_HD_ADDRESSES_PER_BRANCH {
                    return Err(CliError::Usage(
                        "observed HD address index exceeds the branch limit".into(),
                    ));
                }
                *next = (*next).max(used + 1);
            }
        }
        Ok(next)
    }
}

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

/// Public address-book scope discovered for a selected HD account. Branches
/// follow `HD_SCAN_BRANCHES`, with each branch in address-index order. An empty
/// DeFi slot can represent unscanned scope restored from a v1 checkpoint.
/// This carries no private key or claim of authenticated storage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HdAddressBook {
    pub account: crate::hd::AccountPath,
    pub account_xpub: String,
    pub branches: [Vec<PublicAddressPreview>; 4],
    pub last_used: [Option<u32>; 4],
}

impl HdAddressBook {
    /// History for the three allocatable branches. Compatibility chain 2 must
    /// never advance the DeFi chain 7 allocation counter.
    pub const fn allocation_last_used(&self) -> [Option<u32>; 3] {
        [self.last_used[0], self.last_used[1], self.last_used[2]]
    }
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

/// The same, for a cosigner in a multisig wallet.
///
/// Multisig accounts are one level deeper than single-sig ones. BIP-48 puts
/// the script type there -- `m/48'/coin'/account'/script_type'` -- and it is
/// what Sparrow, Specter, Keystone and BIP-129's own test vectors all use.
/// Requiring depth 3 here rejected every one of them, including the records
/// published in the specification this wallet claims to read.
///
/// Depth 4 is admitted, and nothing else is. The hardened check stays for both
/// depths and is the part that matters: an unhardened or shallower key is a
/// leaf or a branch rather than an account, and deriving `/branch/index` from
/// one produces addresses that look right and belong to a different wallet.
pub fn parse_multisig_account_xpub(raw: &str) -> Result<XPub> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CliError::Usage("enter a valid BCH account xPub".into()));
    }
    let xpub: XPub = trimmed
        .parse()
        .map_err(|_| CliError::Usage("enter a valid BIP32 public key".into()))?;
    let attrs = xpub.attrs();
    if !matches!(attrs.depth, 3 | 4) || !attrs.child_number.is_hardened() {
        return Err(CliError::Usage(
            "use a hardened account xPub: depth 3 for BIP44, or depth 4 for a BIP48 multisig              account"
                .into(),
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

    #[test]
    fn allocation_branches_are_distinct_and_exclude_rpa() {
        let mut allocation = HdAddressAllocation::default();
        assert_eq!(allocation.next_indexes(), [0, 0, 0]);
        assert_eq!(allocation.current_receive(), None);
        for (branch, index) in [
            (HdBranch::Receive, 0),
            (HdBranch::Change, 1),
            (HdBranch::Defi, 7),
        ] {
            assert_eq!(branch.index(), index);
            assert_eq!(allocation.allocate(branch, [None; 3], false).unwrap(), 0);
            assert_eq!(allocation.current_receive(), Some(0));
            let encoded = serde_json::to_string(&branch).unwrap();
            assert_eq!(serde_json::from_str::<HdBranch>(&encoded).unwrap(), branch);
        }
        assert_eq!(allocation.next_indexes(), [1, 1, 1]);
        assert_eq!(
            allocation
                .allocate(HdBranch::Receive, [None; 3], false)
                .unwrap(),
            1
        );
        assert_eq!(allocation.current_receive(), Some(1));
        assert_eq!(allocation.next_indexes(), [2, 1, 1]);
        for invalid in ["2", "3", "\"rpa\"", "\"compatibility\"", "\"7\""] {
            assert!(serde_json::from_str::<HdBranch>(invalid).is_err());
        }
    }

    #[test]
    fn allocation_defi_uses_chain_seven_and_ignores_compatibility_history() {
        assert_eq!(HD_SCAN_BRANCHES, [0, 1, 7, 2]);
        assert_eq!(HdBranch::Defi.slot(), 2);
        assert_eq!(HdBranch::Defi.index(), 7);
        let xpub = account_xpub(Network::Chipnet, 0);
        let book = HdAddressBook {
            account: crate::hd::AccountPath::new(1, 0).unwrap(),
            account_xpub: xpub.clone(),
            branches: Default::default(),
            last_used: [Some(4), Some(5), Some(6), Some(9999)],
        };
        assert_eq!(book.allocation_last_used(), [Some(4), Some(5), Some(6)]);
        let mut allocation = HdAddressAllocation::default();
        let index = allocation
            .allocate(HdBranch::Defi, book.allocation_last_used(), false)
            .unwrap();
        assert_eq!(index, 7);
        assert_eq!(allocation.next_indexes(), [5, 6, 8]);
        assert_eq!(allocation.current_receive(), None);
        let defi =
            address_under_account(Network::Chipnet, &xpub, HdBranch::Defi.index(), index).unwrap();
        let compatibility = address_under_account(Network::Chipnet, &xpub, 2, index).unwrap();
        assert_eq!(defi.path, "m/44'/1'/0'/7/7");
        assert_eq!(compatibility.path, "m/44'/1'/0'/2/7");
        assert_ne!(defi.address, compatibility.address);
    }

    #[test]
    fn allocation_observations_and_reorgs_never_reuse_indexes() {
        let mut allocation = HdAddressAllocation::default();
        allocation.observe([Some(4), Some(8), Some(2)]).unwrap();
        assert_eq!(allocation.next_indexes(), [5, 9, 3]);
        assert_eq!(allocation.current_receive(), None);
        allocation.observe([Some(1), None, Some(0)]).unwrap();
        assert_eq!(allocation.next_indexes(), [5, 9, 3]);
        assert_eq!(
            allocation
                .allocate(HdBranch::Receive, [None; 3], false)
                .unwrap(),
            5
        );
        assert_eq!(
            allocation
                .allocate(HdBranch::Change, [Some(9), Some(10), None], false)
                .unwrap(),
            11
        );
        assert_eq!(allocation.next_indexes(), [10, 12, 3]);
        assert_eq!(allocation.current_receive(), Some(5));
        allocation.observe([None; 3]).unwrap();
        assert_eq!(allocation.next_indexes(), [10, 12, 3]);
    }

    #[test]
    fn allocation_invalid_history_is_transactional_for_every_branch() {
        let mut allocation = HdAddressAllocation::default();
        allocation
            .allocate(HdBranch::Receive, [None; 3], false)
            .unwrap();
        let before = allocation.clone();
        for slot in 0..3 {
            for invalid in [MAX_HD_ADDRESSES_PER_BRANCH, u32::MAX] {
                let mut history = [Some(10); 3];
                history[slot] = Some(invalid);
                assert!(allocation.observe(history).is_err());
                assert_eq!(allocation, before);
                assert!(allocation
                    .allocate(HdBranch::Receive, history, true)
                    .is_err());
                assert_eq!(allocation, before);
            }
        }
    }

    #[test]
    fn allocation_gap_requires_acknowledgement_without_mutating_observations() {
        let branch = HdBranch::Receive;
        let mut allocation = HdAddressAllocation::default();
        for expected in 0..20 {
            assert_eq!(
                allocation.allocate(branch, [None; 3], false).unwrap(),
                expected
            );
        }
        let before = allocation.clone();
        let history = [None, Some(3), Some(3)];
        let error = allocation.allocate(branch, history, false).unwrap_err();
        assert!(matches!(error, CliError::Usage(ref message) if message.contains("acknowledge")));
        assert_eq!(
            allocation, before,
            "failed allocation must not commit other branches' history"
        );
        assert_eq!(allocation.allocate(branch, history, true).unwrap(), 20);
        let after_ack = allocation.clone();
        assert!(allocation.allocate(branch, history, false).is_err());
        assert_eq!(
            allocation, after_ack,
            "one acknowledgement is not permanent permission"
        );
    }

    #[test]
    fn allocation_external_gap_policy_does_not_consume_receive_for_other_branches() {
        let mut allocation = HdAddressAllocation::default();
        for branch in [HdBranch::Change, HdBranch::Defi] {
            for expected in 0..25 {
                assert_eq!(
                    allocation.allocate(branch, [None; 3], false).unwrap(),
                    expected
                );
            }
        }
        assert_eq!(allocation.next_indexes(), [0, 25, 25]);
        assert_eq!(allocation.current_receive(), None);
    }

    #[test]
    fn allocation_gap_uses_last_used_history_not_allocation_count() {
        let mut allocation = HdAddressAllocation::default();
        let history = [Some(99), None, None];
        for expected in 100..120 {
            assert_eq!(
                allocation
                    .allocate(HdBranch::Receive, history, false)
                    .unwrap(),
                expected
            );
        }
        let before = allocation.clone();
        assert!(allocation
            .allocate(HdBranch::Receive, history, false)
            .is_err());
        assert_eq!(allocation, before);
        assert_eq!(
            allocation
                .allocate(HdBranch::Receive, [Some(100), None, None], false)
                .unwrap(),
            120
        );
        let before_reorg = allocation.clone();
        assert!(allocation
            .allocate(HdBranch::Receive, [None; 3], false)
            .is_err());
        assert_eq!(allocation, before_reorg);
        assert_eq!(
            allocation
                .allocate(HdBranch::Receive, [None; 3], true)
                .unwrap(),
            121
        );
    }

    #[test]
    fn allocation_exhaustion_never_wraps_or_overrides_with_acknowledgement() {
        for branch in [HdBranch::Receive, HdBranch::Change, HdBranch::Defi] {
            let mut allocation = HdAddressAllocation::default();
            let mut history = [None; 3];
            history[branch.slot()] = Some(MAX_HD_ADDRESSES_PER_BRANCH - 2);
            assert_eq!(
                allocation.allocate(branch, history, false).unwrap(),
                MAX_HD_ADDRESSES_PER_BRANCH - 1
            );
            let before = allocation.clone();
            for acknowledge in [false, true] {
                let mut newer_history = [Some(3); 3];
                newer_history[branch.slot()] = Some(MAX_HD_ADDRESSES_PER_BRANCH - 1);
                assert!(allocation
                    .allocate(branch, newer_history, acknowledge)
                    .is_err());
                assert_eq!(allocation, before);
            }
            let encoded = serde_json::to_string(&allocation).unwrap();
            assert_eq!(
                serde_json::from_str::<HdAddressAllocation>(&encoded).unwrap(),
                allocation
            );
        }
        let mut observed = HdAddressAllocation::default();
        observed
            .observe([Some(MAX_HD_ADDRESSES_PER_BRANCH - 1); 3])
            .unwrap();
        assert_eq!(observed.next_indexes(), [MAX_HD_ADDRESSES_PER_BRANCH; 3]);
        assert_eq!(observed.current_receive(), None);
    }

    #[test]
    fn allocation_serialization_preserves_history_only_and_issued_state() {
        let mut allocation = HdAddressAllocation::default();
        let empty = serde_json::json!({"next": [0, 0, 0], "current_receive": null});
        assert_eq!(serde_json::to_value(&allocation).unwrap(), empty);
        assert_eq!(
            serde_json::from_value::<HdAddressAllocation>(empty).unwrap(),
            allocation
        );
        allocation.observe([Some(5), Some(7), None]).unwrap();
        let observed = serde_json::json!({"next": [6, 8, 0], "current_receive": null});
        assert_eq!(
            serde_json::from_value::<HdAddressAllocation>(observed).unwrap(),
            allocation
        );
        allocation
            .allocate(HdBranch::Receive, [None; 3], false)
            .unwrap();
        let issued = serde_json::json!({"next": [7, 8, 0], "current_receive": 6});
        assert_eq!(serde_json::to_value(&allocation).unwrap(), issued);
        let mut restored = serde_json::from_value::<HdAddressAllocation>(issued).unwrap();
        assert_eq!(
            restored
                .allocate(HdBranch::Receive, [None; 3], false)
                .unwrap(),
            7
        );
    }

    #[test]
    fn allocation_deserialization_rejects_invalid_counters_and_current_receive() {
        for invalid in [
            r#"{"next":[10001,0,0],"current_receive":null}"#,
            r#"{"next":[0,10001,0],"current_receive":null}"#,
            r#"{"next":[0,0,10001],"current_receive":null}"#,
            r#"{"next":[-1,0,0],"current_receive":null}"#,
            r#"{"next":[4294967296,0,0],"current_receive":null}"#,
            r#"{"next":[0,0],"current_receive":null}"#,
            r#"{"next":[0,0,0,0],"current_receive":null}"#,
            r#"{"next":[0,1,1],"current_receive":0}"#,
            r#"{"next":[3,0,0],"current_receive":3}"#,
            r#"{"next":[3,0,0],"current_receive":4}"#,
            r#"{"next":[10000,0,0],"current_receive":10000}"#,
            r#"{"next":[0,0,0],"current_receive":null,"rpa":0}"#,
        ] {
            assert!(
                serde_json::from_str::<HdAddressAllocation>(invalid).is_err(),
                "accepted {invalid}"
            );
        }
    }
}
