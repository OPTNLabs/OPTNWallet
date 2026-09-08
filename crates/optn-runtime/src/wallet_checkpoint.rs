//! Encrypted local HD restart state, distinct from an imported wallet pack.
//! Ownership, raw transaction projection and metadata are checked on restore.
//! A checkpoint never restores unlock authority, spend approval, or freshness.

use crate::{
    chain::{Evidence, Hash32, SourceId},
    chain_service::{ChainTip, ObservedTransaction},
    hd_sync::{HdAccountScan, HdSyncLimits, MAX_HD_BRANCH_ADDRESSES},
    sync_worker::WalletNetworkSnapshot,
    wallet_sync::WalletReconciliation,
};
use optn_app::AppState;
use optn_core::{
    cashaddr::Address,
    coins::{CoinSet, FreezeReason, Outpoint},
    hd::{parse_account_path, AccountPath},
    header_hash::sha256d,
    network::Network,
    wallet_pack::{self, PackKey, NONCE_LEN},
    watch_only::HdAddressAllocation,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Bounded before both decryption and JSON decoding. No secrets are stored, but
/// the public account and history are identifying and must remain encrypted.
pub const MAX_CHECKPOINT_BYTES: usize = 64 * 1024 * 1024;
const FORMAT: &str = "optn-hd-restart-v2";
const LEGACY_FORMAT: &str = "optn-hd-restart-v1";

/// Native persistence port. The runtime supplies a private-session key and an
/// opaque account identifier; adapters supply atomic ciphertext storage only.
pub trait WalletCheckpointStorage: Send {
    fn load(
        &self,
        id: &[u8; 32],
        key: &PackKey,
    ) -> Result<Option<(WalletCheckpoint, [u8; 32])>, String>;
    fn store(
        &self,
        id: &[u8; 32],
        checkpoint: &WalletCheckpoint,
        key: &PackKey,
        expected: Option<[u8; 32]>,
    ) -> Result<[u8; 32], String>;
}

/// Only captured by the runtime or constructed by authenticated decoding.
/// Hosts must supply a wallet-specific key after an actual unlock, never a
/// renderer-provided wallet id. This is not a key store or an unlock credential.
#[derive(Clone)]
pub struct WalletCheckpoint {
    pub(crate) network: Network,
    account: AccountPath,
    pub(crate) account_xpub: String,
    pub(crate) allocation: Option<HdAddressAllocation>,
    pub(crate) state: WalletReconciliation,
    pub(crate) coins: CoinSet,
}

impl std::fmt::Debug for WalletCheckpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WalletCheckpoint(<private wallet metadata>)")
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredCheckpoint {
    format: String,
    network: String,
    account_path: String,
    account_xpub: String,
    branch_lengths: Vec<u32>,
    source: Option<SourceId>,
    evidence: Option<Evidence>,
    tip: Option<(u32, Hash32)>,
    transactions: Vec<StoredTransaction>,
    annotations: Vec<StoredAnnotation>,
    #[serde(default)]
    allocation: Option<HdAddressAllocation>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredTransaction {
    raw: Vec<u8>,
    height: Option<u32>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredAnnotation {
    txid: Hash32,
    vout: u32,
    label: Option<String>,
    freeze: Option<FreezeReason>,
    fuse_depth: u32,
}

pub(crate) fn update_receive_address(app: &mut AppState) -> Result<(), String> {
    let Some(index) = app
        .hd_addresses
        .as_ref()
        .and_then(HdAddressAllocation::current_receive)
    else {
        return Ok(());
    };
    let wallet = app.wallet.as_mut().ok_or("open an HD wallet first")?;
    let xpub = wallet
        .account_xpub
        .as_deref()
        .ok_or("the wallet has no HD account")?;
    wallet.receive_address =
        optn_core::watch_only::address_under_account(app.network, xpub, 0, index)
            .map_err(|error| error.to_string())?
            .address;
    Ok(())
}

/// Raise durable allocation past observed history, including spent outputs.
/// Called on a candidate state before storage/publication, never by a renderer.
pub(crate) fn observe_allocation(
    app: &mut AppState,
    state: &WalletReconciliation,
) -> Result<(), String> {
    let Some(allocation) = app.hd_addresses.as_mut() else {
        return Ok(());
    };
    let used = allocation_history(state);
    allocation
        .observe(used)
        .map_err(|error| error.to_string())?;
    if allocation.current_receive().is_none()
        || allocation
            .current_receive()
            .zip(used[0])
            .is_some_and(|(current, last)| current <= last)
    {
        allocation
            .allocate(optn_app::HdBranch::Receive, used, false)
            .map_err(|error| error.to_string())?;
    }
    update_receive_address(app)
}

pub(crate) fn allocation_history(state: &WalletReconciliation) -> [Option<u32>; 3] {
    state
        .authoritative
        .as_ref()
        .and_then(|snapshot| snapshot.value.hd.as_ref())
        .map_or([None; 3], |book| book.allocation_last_used())
}

impl WalletCheckpoint {
    pub(crate) fn capture(app: &AppState, state: &WalletReconciliation) -> Result<Self, String> {
        let wallet = app
            .wallet
            .as_ref()
            .ok_or("open a wallet before saving its state")?;
        let book = state
            .authoritative
            .as_ref()
            .and_then(|snapshot| snapshot.value.hd.as_ref());
        let checkpoint = Self {
            network: app.network,
            account: parse_account_path(&wallet.account_path).map_err(|error| error.to_string())?,
            account_xpub: wallet
                .account_xpub
                .as_ref()
                .or_else(|| book.map(|book| &book.account_xpub))
                .ok_or("the wallet has no HD account")?
                .clone(),
            allocation: app.hd_addresses.clone(),
            state: state.clone(),
            coins: app.coins.clone(),
        };
        if state.authoritative.is_some() && book.is_none() {
            return Err("an HD checkpoint requires an account-wide snapshot".into());
        }
        if state.authoritative.is_none()
            && (checkpoint.allocation.is_none() || !app.coins.is_empty())
        {
            return Err("local allocation cannot invent chain observations".into());
        }
        checkpoint.validate_wallet(app)?;
        Ok(checkpoint)
    }

    pub(crate) fn validate_wallet(&self, app: &AppState) -> Result<(), String> {
        let wallet = app
            .wallet
            .as_ref()
            .ok_or("open a wallet before restoring its state")?;
        let book = self
            .state
            .authoritative
            .as_ref()
            .and_then(|snapshot| snapshot.value.hd.as_ref());
        if app.network != self.network
            || wallet.multisig_policy.is_some()
            || parse_account_path(&wallet.account_path).map_err(|error| error.to_string())?
                != self.account
            || wallet
                .account_xpub
                .as_ref()
                .is_some_and(|key| key.trim() != self.account_xpub.trim())
            || book.is_some_and(|book| {
                book.account != self.account || book.account_xpub.trim() != self.account_xpub.trim()
            })
        {
            return Err("checkpoint belongs to a different wallet, account, or network".into());
        }
        let receive = Address::decode(&wallet.receive_address)?;
        let current = self
            .allocation
            .as_ref()
            .and_then(HdAddressAllocation::current_receive);
        if let Some(index) = current {
            optn_core::watch_only::address_under_account(
                self.network,
                &self.account_xpub,
                0,
                index,
            )
            .map_err(|error| error.to_string())?;
        }
        let owns_receive = [Some(0), current].into_iter().flatten().any(|index| {
            optn_core::watch_only::address_under_account(self.network, &self.account_xpub, 0, index)
                .is_ok_and(|address| address.address == wallet.receive_address)
        }) || book.is_some_and(|book| {
            book.branches[0].iter().any(|entry| {
                Address::decode(&entry.address)
                    .is_ok_and(|address| address.script_pubkey() == receive.script_pubkey())
            })
        });
        if receive.prefix != self.network.prefix() || !owns_receive {
            return Err("checkpoint does not own the opened wallet's receive address".into());
        }
        if let Some(snapshot) = &self.state.authoritative {
            snapshot
                .value
                .wallet_view()
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn same_wallet(&self, other: &Self) -> bool {
        self.network == other.network
            && self.account == other.account
            && self.account_xpub.trim() == other.account_xpub.trim()
    }

    /// Nonces must be unique under this key. Native storage generates a fresh
    /// nonce with OS randomness for each write; UI/transport never chooses one.
    pub fn seal(&self, key: &PackKey, nonce: &[u8; NONCE_LEN]) -> Result<Vec<u8>, String> {
        let snapshot = self.state.authoritative.as_ref();
        let book = snapshot.and_then(|snapshot| snapshot.value.hd.as_ref());
        let stored = StoredCheckpoint {
            format: FORMAT.into(),
            network: self.network.to_string(),
            account_path: self.account.to_string(),
            account_xpub: self.account_xpub.clone(),
            branch_lengths: (0..4)
                .map(|branch| book.map_or(0, |book| book.branches[branch].len() as u32))
                .collect(),
            source: snapshot.map(|snapshot| snapshot.source.clone()),
            evidence: snapshot.map(|snapshot| snapshot.evidence.clone()),
            tip: snapshot.and_then(|snapshot| snapshot.chain_tip),
            transactions: snapshot
                .into_iter()
                .flat_map(|snapshot| &snapshot.value.transactions)
                .map(|tx| StoredTransaction {
                    raw: tx.raw.clone(),
                    height: tx.block_height,
                })
                .collect(),
            annotations: self
                .coins
                .iter()
                .map(|coin| StoredAnnotation {
                    txid: coin.outpoint().txid(),
                    vout: coin.outpoint().vout(),
                    label: coin.label().map(str::to_owned),
                    freeze: coin.freeze(),
                    fuse_depth: coin.fuse_depth(),
                })
                .collect(),
            allocation: self.allocation.clone(),
        };
        let plaintext =
            serde_json::to_vec(&stored).map_err(|_| "cannot encode wallet checkpoint")?;
        if plaintext.len() + NONCE_LEN + 16 > MAX_CHECKPOINT_BYTES {
            return Err("wallet checkpoint exceeds the storage limit".into());
        }
        let mut bytes = nonce.to_vec();
        bytes.extend(wallet_pack::seal(key, nonce, &plaintext).map_err(|error| error.to_string())?);
        Ok(bytes)
    }

    pub fn open(key: &PackKey, bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < NONCE_LEN + 16 || bytes.len() > MAX_CHECKPOINT_BYTES {
            return Err("invalid wallet checkpoint size".into());
        }
        let nonce: &[u8; NONCE_LEN] = bytes[..NONCE_LEN].try_into().expect("checked length");
        let plaintext = wallet_pack::open(key, nonce, &bytes[NONCE_LEN..])
            .map_err(|error| error.to_string())?;
        let stored: StoredCheckpoint =
            serde_json::from_slice(&plaintext).map_err(|_| "invalid wallet checkpoint data")?;
        if ![FORMAT, LEGACY_FORMAT].contains(&stored.format.as_str()) {
            return Err("unsupported wallet checkpoint format or source".into());
        }
        let branch_lengths: [u32; 4] =
            match (stored.format.as_str(), stored.branch_lengths.as_slice()) {
                (LEGACY_FORMAT, [receive, change, old_defi]) if stored.allocation.is_none() => {
                    // v1 used branch 2. Never reinterpret that history as branch 7.
                    [*receive, *change, 0, *old_defi]
                }
                (FORMAT, [receive, change, defi, compatibility]) => {
                    [*receive, *change, *defi, *compatibility]
                }
                _ => return Err("invalid checkpoint branch layout".into()),
            };
        let network = stored.network.parse::<Network>()?;
        let account =
            parse_account_path(&stored.account_path).map_err(|error| error.to_string())?;
        let account_xpub = stored.account_xpub;
        let mut scan = HdAccountScan::new(
            network,
            account_xpub.clone(),
            account,
            HdSyncLimits {
                gap_limit: 1,
                addresses_per_branch: MAX_HD_BRANCH_ADDRESSES,
            },
            Default::default(),
        )?;
        let (source, evidence) = match (stored.source, stored.evidence) {
            (Some(source), Some(evidence))
                if !source.as_str().is_empty() && source.as_str().len() <= 256 =>
            {
                (source, evidence)
            }
            (None, None)
                if stored.format == FORMAT
                    && stored.allocation.is_some()
                    && branch_lengths == [0; 4]
                    && stored.tip.is_none()
                    && stored.transactions.is_empty()
                    && stored.annotations.is_empty() =>
            {
                // Addresses issued offline are not an authoritative empty scan.
                return Ok(Self {
                    network,
                    account,
                    account_xpub,
                    allocation: stored.allocation,
                    state: WalletReconciliation::default(),
                    coins: CoinSet::new(),
                });
            }
            _ => return Err("invalid checkpoint scan provenance".into()),
        };
        scan.restore_horizons(branch_lengths)?;
        let mut snapshot = WalletNetworkSnapshot {
            hd: None,
            interests: scan.interests(),
            transactions: stored
                .transactions
                .into_iter()
                .map(|tx| ObservedTransaction {
                    txid: sha256d(&tx.raw),
                    raw: tx.raw,
                    block_height: tx.height,
                })
                .collect(),
            tip: stored.tip.map(|(height, hash)| ChainTip { height, hash }),
        };
        if !scan.advance(&snapshot)? {
            return Err("stored HD history does not cover its address book".into());
        }
        snapshot.hd = Some(scan.address_book());
        if let Some(allocation) = &stored.allocation {
            let next = allocation.next_indexes();
            if snapshot
                .hd
                .as_ref()
                .expect("address book restored")
                .last_used
                .iter()
                .zip(next)
                .any(|(used, next)| used.is_some_and(|index| index >= next))
            {
                return Err("allocation precedes observed HD history".into());
            }
        }
        let mut coins = CoinSet::new();
        snapshot
            .reconcile_coins(network, &scan.addresses(), &mut coins)
            .map_err(|error| error.to_string())?;
        let mut seen = HashSet::new();
        // Amounts, tokens and addresses are re-derived from raw observations;
        // the stored annotations cannot create or alter a chain output.
        for annotation in stored.annotations {
            let outpoint = Outpoint::new(annotation.txid, annotation.vout);
            if !seen.insert(outpoint) {
                return Err("duplicate coin annotations in wallet checkpoint".into());
            }
            coins
                .restore_annotations(
                    outpoint,
                    annotation.label,
                    annotation.freeze,
                    annotation.fuse_depth,
                )
                .map_err(|error| error.to_string())?;
        }
        if seen.len() != coins.len() {
            return Err("wallet checkpoint omitted coin bookkeeping".into());
        }
        let mut state = WalletReconciliation::default();
        state.reconcile_candidate(snapshot, source, evidence, stored.tip, true);
        // Authenticated old observations are still old. No fresh/spend flag is
        // accepted from disk, and a restored file is not a trusted header anchor.
        state.record_failure("restored wallet state requires a live refresh");
        Ok(Self {
            network,
            account,
            account_xpub,
            allocation: stored.allocation,
            state,
            coins,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_core::{
        hd::{Wallet, BIP39_TEST_VECTOR_MNEMONIC},
        watch_only::address_under_account,
    };

    fn fixture() -> (PackKey, StoredCheckpoint) {
        let account = AccountPath::new(1, 1).unwrap();
        let wallet = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "TREZOR").unwrap();
        (
            wallet.checkpoint_key(Network::Chipnet, account).unwrap(),
            StoredCheckpoint {
                format: FORMAT.into(),
                network: "chipnet".into(),
                account_path: account.to_string(),
                account_xpub: wallet.account_xpub_at(account).unwrap(),
                branch_lengths: vec![0; 4],
                source: None,
                evidence: None,
                tip: None,
                transactions: vec![],
                annotations: vec![],
                allocation: Some(HdAddressAllocation::default()),
            },
        )
    }

    // Authenticated codec fixtures, never a production key or encryption entry point.
    fn encoded(key: &PackKey, stored: &StoredCheckpoint, sequence: u8) -> Vec<u8> {
        let nonce = [sequence; NONCE_LEN];
        let mut bytes = nonce.to_vec();
        bytes.extend(wallet_pack::seal(key, &nonce, &serde_json::to_vec(stored).unwrap()).unwrap());
        bytes
    }

    #[test]
    fn offline_allocation_is_not_an_empty_authoritative_scan() {
        let (key, mut stored) = fixture();
        stored
            .allocation
            .as_mut()
            .unwrap()
            .allocate(optn_app::HdBranch::Receive, [None; 3], false)
            .unwrap();
        let restored = WalletCheckpoint::open(&key, &encoded(&key, &stored, 1)).unwrap();
        assert_eq!(restored.allocation.unwrap().current_receive(), Some(0));
        assert!(restored.state.authoritative.is_none());
        assert!(!restored.state.sync.utxos_fresh);
        for index in 0..4 {
            match index {
                0 => stored.tip = Some((1, [1; 32])),
                1 => {
                    stored.tip = None;
                    stored.evidence = Some(Evidence::ServerAssertion);
                }
                2 => {
                    stored.evidence = None;
                    stored.branch_lengths = vec![1; 4];
                }
                _ => {
                    stored.branch_lengths = vec![0; 4];
                    stored.allocation = None;
                }
            }
            assert!(WalletCheckpoint::open(&key, &encoded(&key, &stored, index + 2)).is_err());
        }
    }

    #[test]
    fn v1_keeps_branch_two_funds_and_never_relabels_them_as_branch_seven() {
        let (key, mut stored) = fixture();
        let old = address_under_account(Network::Chipnet, &stored.account_xpub, 2, 0).unwrap();
        let script = Address::decode(&old.address).unwrap().script_pubkey();
        // Raw transaction serialization fixture only, not consensus/broadcast evidence.
        let mut raw = vec![2, 0, 0, 0, 0, 1];
        raw.extend_from_slice(&1200u64.to_le_bytes());
        raw.push(script.len() as u8);
        raw.extend(script);
        raw.extend([0; 4]);
        let mut txid = sha256d(&raw);
        txid.reverse();
        stored.format = LEGACY_FORMAT.into();
        stored.allocation = None;
        stored.branch_lengths = vec![2; 3];
        stored.source = Some(SourceId::new("public-migration-fixture"));
        stored.evidence = Some(Evidence::ServerAssertion);
        stored.transactions = vec![StoredTransaction { raw, height: None }];
        stored.annotations = vec![StoredAnnotation {
            txid,
            vout: 0,
            label: Some("retained hold".into()),
            freeze: Some(FreezeReason::User),
            fuse_depth: 0,
        }];
        let restored = WalletCheckpoint::open(&key, &encoded(&key, &stored, 8)).unwrap();
        let coin = restored.coins.iter().next().unwrap();
        assert_eq!(coin.address(), old.address);
        assert_eq!(coin.value_sats(), 1200);
        assert_eq!(coin.label(), Some("retained hold"));
        assert_eq!(coin.freeze(), Some(FreezeReason::User));
        let book = restored
            .state
            .authoritative
            .as_ref()
            .unwrap()
            .value
            .hd
            .as_ref()
            .unwrap();
        assert!(book.branches[2].is_empty());
        assert!(book.branches[3][0].path.ends_with("/2/0"));
        assert_eq!(book.last_used, [None, None, None, Some(0)]);
        assert!(!restored.state.sync.utxos_fresh);
        let v2 =
            WalletCheckpoint::open(&key, &restored.seal(&key, &[9; NONCE_LEN]).unwrap()).unwrap();
        assert_eq!(restored.coins, v2.coins);
        assert!(v2.state.authoritative.unwrap().value.hd.unwrap().branches[2].is_empty());

        // Allocation cannot masquerade as a v1 field or precede observed usage.
        stored.allocation = Some(HdAddressAllocation::default());
        assert!(WalletCheckpoint::open(&key, &encoded(&key, &stored, 10)).is_err());
        stored.format = FORMAT.into();
        stored.branch_lengths = vec![2, 2, 2, 2];
        // Branch 2 is discovery-only, so it does not consume DeFi (7) allocation.
        assert!(WalletCheckpoint::open(&key, &encoded(&key, &stored, 11)).is_ok());
    }
}
