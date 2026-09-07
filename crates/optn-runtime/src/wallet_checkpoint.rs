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
    hd::parse_account_path,
    header_hash::sha256d,
    network::Network,
    wallet_pack::{self, PackKey, NONCE_LEN},
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Bounded before both decryption and JSON decoding. No secrets are stored, but
/// the public account and history are identifying and must remain encrypted.
pub const MAX_CHECKPOINT_BYTES: usize = 64 * 1024 * 1024;
const FORMAT: &str = "optn-hd-restart-v1";

/// Only captured by the runtime or constructed by authenticated decoding.
/// Hosts must supply a wallet-specific key after an actual unlock, never a
/// renderer-provided wallet id. This is not a key store or an unlock credential.
#[derive(Clone)]
pub struct WalletCheckpoint {
    pub(crate) network: Network,
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
    branch_lengths: [u32; 3],
    source: SourceId,
    evidence: Evidence,
    tip: Option<(u32, Hash32)>,
    transactions: Vec<StoredTransaction>,
    annotations: Vec<StoredAnnotation>,
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

impl WalletCheckpoint {
    pub(crate) fn capture(app: &AppState, state: &WalletReconciliation) -> Result<Self, String> {
        let checkpoint = Self {
            network: app.network,
            state: state.clone(),
            coins: app.coins.clone(),
        };
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
            .and_then(|snapshot| snapshot.value.hd.as_ref())
            .ok_or("complete HD synchronization before saving a checkpoint")?;
        if app.network != self.network
            || wallet.multisig_policy.is_some()
            || parse_account_path(&wallet.account_path).map_err(|error| error.to_string())?
                != book.account
            || wallet
                .account_xpub
                .as_ref()
                .is_some_and(|key| key.trim() != book.account_xpub.trim())
        {
            return Err("checkpoint belongs to a different wallet, account, or network".into());
        }
        let receive = Address::decode(&wallet.receive_address)?;
        if receive.prefix != self.network.prefix()
            || !book.branches[0].iter().any(|entry| {
                Address::decode(&entry.address)
                    .is_ok_and(|address| address.script_pubkey() == receive.script_pubkey())
            })
        {
            return Err("checkpoint does not own the opened wallet's receive address".into());
        }
        Ok(())
    }

    pub fn same_wallet(&self, other: &Self) -> bool {
        let own = self
            .state
            .authoritative
            .as_ref()
            .and_then(|snapshot| snapshot.value.hd.as_ref());
        let other_book = other
            .state
            .authoritative
            .as_ref()
            .and_then(|snapshot| snapshot.value.hd.as_ref());
        self.network == other.network
            && own.zip(other_book).is_some_and(|(a, b)| {
                a.account == b.account && a.account_xpub.trim() == b.account_xpub.trim()
            })
    }

    /// Nonces must be unique under this key. Native storage generates a fresh
    /// nonce with OS randomness for each write; UI/transport never chooses one.
    pub fn seal(&self, key: &PackKey, nonce: &[u8; NONCE_LEN]) -> Result<Vec<u8>, String> {
        let snapshot = self
            .state
            .authoritative
            .as_ref()
            .ok_or("no wallet snapshot")?;
        let book = snapshot.value.hd.as_ref().ok_or("no HD address book")?;
        let stored = StoredCheckpoint {
            format: FORMAT.into(),
            network: self.network.to_string(),
            account_path: book.account.to_string(),
            account_xpub: book.account_xpub.clone(),
            branch_lengths: std::array::from_fn(|branch| book.branches[branch].len() as u32),
            source: snapshot.source.clone(),
            evidence: snapshot.evidence.clone(),
            tip: snapshot.chain_tip,
            transactions: snapshot
                .value
                .transactions
                .iter()
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
        if stored.format != FORMAT
            || stored.source.as_str().is_empty()
            || stored.source.as_str().len() > 256
        {
            return Err("unsupported wallet checkpoint format or source".into());
        }
        let network = stored.network.parse::<Network>()?;
        let account =
            parse_account_path(&stored.account_path).map_err(|error| error.to_string())?;
        let mut scan = HdAccountScan::new(
            network,
            stored.account_xpub,
            account,
            HdSyncLimits {
                gap_limit: 1,
                addresses_per_branch: MAX_HD_BRANCH_ADDRESSES,
            },
            Default::default(),
        )?;
        scan.restore_horizons(stored.branch_lengths)?;
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
        state.reconcile_candidate(snapshot, stored.source, stored.evidence, stored.tip, true);
        // Authenticated old observations are still old. No fresh/spend flag is
        // accepted from disk, and a restored file is not a trusted header anchor.
        state.record_failure("restored wallet state requires a live refresh");
        Ok(Self {
            network,
            state,
            coins,
        })
    }
}
