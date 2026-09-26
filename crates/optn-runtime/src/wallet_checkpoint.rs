//! Encrypted local HD restart state, distinct from an imported wallet pack.
//! Ownership, raw transaction projection and metadata are checked on restore.
//! A checkpoint never restores unlock authority, spend approval, or freshness.

use crate::{
    chain::{CheckpointProvenance, Evidence, Hash32, HeaderCheckpoint, SourceId},
    chain_service::{ChainTip, ObservedTransaction},
    hd_sync::{HdAccountScan, HdSyncLimits, MAX_HD_BRANCH_ADDRESSES},
    sync_worker::WalletNetworkSnapshot,
    wallet_birthday::{WalletBirthday, WalletRestoreState},
    wallet_sync::WalletReconciliation,
};
use optn_app::{AppState, IdentityStatus, TokenIdentity, TokenPresentation};
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
use std::collections::{BTreeMap, HashSet};

/// Bounded before both decryption and JSON decoding. No secrets are stored, but
/// the public account and history are identifying and must remain encrypted.
pub const MAX_CHECKPOINT_BYTES: usize = 64 * 1024 * 1024;
const FORMAT: &str = "optn-hd-restart-v3";
const ALLOCATION_FORMAT: &str = "optn-hd-restart-v2";
const LEGACY_FORMAT: &str = "optn-hd-restart-v1";
/// A checkpoint is wallet-private, but it is still decoded before its content
/// is projected. Keep cached presentation metadata bounded independently of
/// the much larger transaction-history budget.
const MAX_CACHED_TOKEN_IDENTITIES: usize = 4_096;
const MAX_TOKEN_IDENTITY_NAME_BYTES: usize = 512;
const MAX_TOKEN_IDENTITY_TICKER_BYTES: usize = 64;
const TOKEN_CATEGORY_HEX_BYTES: usize = 64;

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
    pub(crate) scan_coverage: Option<optn_app::ScanCoverageView>,
    pub(crate) rescan_requested: Option<u32>,
    /// Authenticated, encrypted wallet-origin metadata. Legacy checkpoints
    /// deserialize this as `Unknown`.
    pub(crate) restore_state: WalletRestoreState,
    pub(crate) state: WalletReconciliation,
    pub(crate) coins: CoinSet,
    /// Cached chain-authenticated presentation only. It is deliberately
    /// downgraded before a restored checkpoint reaches application state.
    token_identities: BTreeMap<String, TokenIdentity>,
    pub(crate) header_progress: Option<StoredHeaderProgress>,
}

impl std::fmt::Debug for WalletCheckpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WalletCheckpoint(<private wallet metadata>)")
    }
}

/// Verified header progress, carried inside the sealed checkpoint.
///
/// A restored view is only worth anything against a commitment the holder can
/// trust, and a file may not assert its own: an attacker who can rewrite the
/// blob can rewrite a commitment beside it and the two will agree. So both
/// travel inside the AEAD container the host already authenticates, and
/// `VerifiedHeaderView::restore` takes its trusted value from the same sealed
/// record rather than from a second file that could be edited independently.
///
/// Public chain material either way -- headers are not secret. What the seal
/// buys is integrity, which is the only property that matters here.
#[derive(Clone)]
pub struct StoredHeaderProgress {
    /// `VerifiedHeaderView::encode` output.
    pub view: String,
    pub trusted: HeaderCheckpoint,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredHeaderView {
    view: String,
    height: u32,
    commitment: Hash32,
    provenance: String,
}

fn provenance_name(provenance: &CheckpointProvenance) -> &'static str {
    match provenance {
        CheckpointProvenance::SelfDerived => "self-derived",
        CheckpointProvenance::ShippedReviewed => "shipped-reviewed",
        CheckpointProvenance::SampledIndependentSources => "sampled-independent-sources",
        CheckpointProvenance::UserProvided => "user-provided",
    }
}

/// Unknown provenance is refused rather than downgraded. Reading a record
/// written by a newer build as "self-derived" would silently weaken the claim
/// the holder's own wallet made about where its trust came from.
fn provenance_from_name(name: &str) -> Result<CheckpointProvenance, String> {
    match name {
        "self-derived" => Ok(CheckpointProvenance::SelfDerived),
        "shipped-reviewed" => Ok(CheckpointProvenance::ShippedReviewed),
        "sampled-independent-sources" => Ok(CheckpointProvenance::SampledIndependentSources),
        "user-provided" => Ok(CheckpointProvenance::UserProvided),
        other => Err(format!("unknown header checkpoint provenance '{other}'")),
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
    #[serde(default)]
    scan_coverage: Option<(u32, Option<u32>, bool)>,
    #[serde(default)]
    rescan_requested: Option<u32>,
    /// Absent in checkpoints written before durable wallet birthday support;
    /// absence is deliberately the conservative `Unknown` value.
    #[serde(default)]
    restore_state: WalletRestoreState,
    /// Absent in records written before header progress was persisted, which
    /// simply resume from the shipped genesis anchor as they always did.
    #[serde(default)]
    header_view: Option<StoredHeaderView>,
    /// Older authenticated checkpoints did not carry token presentation.
    #[serde(default)]
    token_identities: BTreeMap<String, StoredTokenIdentity>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredTokenIdentity {
    name: String,
    ticker: Option<String>,
    decimals: u8,
    status: StoredIdentityStatus,
    #[serde(default)]
    presentation: TokenPresentation,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum StoredIdentityStatus {
    Verified,
    Stale,
    Unpublished,
    #[serde(other)]
    Unresolved,
}

impl From<IdentityStatus> for StoredIdentityStatus {
    fn from(status: IdentityStatus) -> Self {
        match status {
            IdentityStatus::Verified => Self::Verified,
            IdentityStatus::Stale => Self::Stale,
            IdentityStatus::Unpublished => Self::Unpublished,
            IdentityStatus::Unresolved => Self::Unresolved,
        }
    }
}

impl From<StoredIdentityStatus> for IdentityStatus {
    fn from(status: StoredIdentityStatus) -> Self {
        match status {
            StoredIdentityStatus::Verified => Self::Verified,
            StoredIdentityStatus::Stale => Self::Stale,
            StoredIdentityStatus::Unpublished => Self::Unpublished,
            StoredIdentityStatus::Unresolved => Self::Unresolved,
        }
    }
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

fn validate_scan_coverage(
    coverage: Option<optn_app::ScanCoverageView>,
    tip: Option<(u32, Hash32)>,
) -> Result<(), String> {
    if coverage.is_some_and(|coverage| {
        tip.is_none_or(|(height, _)| coverage.from_height > height)
            || coverage
                .skipped_below
                .is_some_and(|skipped| skipped == 0 || skipped > coverage.from_height)
            || (coverage.chosen_by_holder
                && coverage.from_height > 0
                && coverage.skipped_below != Some(coverage.from_height))
    }) {
        return Err("invalid stored wallet scan coverage".into());
    }
    Ok(())
}

fn category_key_is_valid(category: &str) -> bool {
    category.len() == TOKEN_CATEGORY_HEX_BYTES
        && category
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn identity_is_cacheable(category: &str, identity: &TokenIdentity) -> bool {
    category_key_is_valid(category)
        && identity.presentation.is_valid()
        && !identity.name.is_empty()
        && identity.name.len() <= MAX_TOKEN_IDENTITY_NAME_BYTES
        && identity
            .ticker
            .as_ref()
            .is_none_or(|ticker| ticker.len() <= MAX_TOKEN_IDENTITY_TICKER_BYTES)
}

fn stored_identity_is_cacheable(category: &str, identity: &StoredTokenIdentity) -> bool {
    category_key_is_valid(category)
        && identity.presentation.is_valid()
        && !identity.name.is_empty()
        && identity.name.len() <= MAX_TOKEN_IDENTITY_NAME_BYTES
        && identity
            .ticker
            .as_ref()
            .is_none_or(|ticker| ticker.len() <= MAX_TOKEN_IDENTITY_TICKER_BYTES)
}

fn cacheable_token_identities(
    identities: &BTreeMap<String, TokenIdentity>,
) -> BTreeMap<String, TokenIdentity> {
    identities
        .iter()
        .filter(|(category, identity)| identity_is_cacheable(category, identity))
        .take(MAX_CACHED_TOKEN_IDENTITIES)
        .map(|(category, identity)| {
            let mut identity = identity.clone();
            identity.presentation = identity.authenticated_presentation();
            (category.clone(), identity)
        })
        .collect()
}

fn decode_token_identities(
    stored: &BTreeMap<String, StoredTokenIdentity>,
) -> Result<BTreeMap<String, TokenIdentity>, String> {
    if stored.len() > MAX_CACHED_TOKEN_IDENTITIES {
        return Err("too many cached token identities in wallet checkpoint".into());
    }
    stored
        .iter()
        .map(|(category, identity)| {
            if !stored_identity_is_cacheable(category, identity) {
                return Err("invalid cached token identity in wallet checkpoint".into());
            }
            let mut decoded = TokenIdentity {
                name: identity.name.clone(),
                ticker: identity.ticker.clone(),
                decimals: identity.decimals,
                status: identity.status.into(),
                presentation: identity.presentation.clone(),
            };
            decoded.presentation = decoded.authenticated_presentation();
            Ok((category.clone(), decoded))
        })
        .collect()
}

fn validate_restore_state(
    restore_state: &WalletRestoreState,
    tip: Option<(u32, Hash32)>,
) -> Result<(), String> {
    if restore_state
        .scanned_through
        .is_some_and(|scanned| tip.is_some_and(|(height, _)| scanned > height))
    {
        return Err("stored wallet restore progress exceeds its chain tip".into());
    }
    Ok(())
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
    pub(crate) fn capture(
        app: &AppState,
        state: &WalletReconciliation,
        restore_state: &WalletRestoreState,
    ) -> Result<Self, String> {
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
            scan_coverage: app.wallet_sync.scan_coverage,
            rescan_requested: app.wallet_sync.rescan_requested,
            restore_state: restore_state.clone(),
            state: state.clone(),
            coins: app.coins.clone(),
            token_identities: cacheable_token_identities(&app.token_identities),
            // The view lives on the sync worker, which the host owns; it is
            // attached with `with_header_progress` rather than read from
            // application state, which never holds it.
            header_progress: None,
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

    /// Attach verified header progress to a checkpoint about to be sealed.
    ///
    /// Called by the host, which owns both the sync worker the view comes from
    /// and the storage the checkpoint goes to. The runtime never reads it back
    /// out of application state, because it is not there.
    pub fn with_header_progress(
        mut self,
        view: &crate::header_view::VerifiedHeaderView,
    ) -> Result<Self, String> {
        let trusted = view.checkpoint();
        let encoded = view.encode().map_err(|error| format!("{error:?}"))?;
        self.header_progress = Some(StoredHeaderProgress {
            view: encoded,
            trusted,
        });
        Ok(self)
    }

    /// The same, from progress the runtime already holds encoded.
    pub fn with_stored_header_progress(
        mut self,
        progress: StoredHeaderProgress,
    ) -> Result<Self, String> {
        self.header_progress = Some(progress);
        Ok(self)
    }

    /// The header progress a restored checkpoint carries, if it has any.
    ///
    /// Absent on records written before this existed, and on wallets that have
    /// never completed a header pass. Both resume from the shipped genesis
    /// anchor, which is what happened for every record until now.
    pub fn header_progress(&self) -> Option<&StoredHeaderProgress> {
        self.header_progress.as_ref()
    }

    /// The encrypted wallet-origin state restored with this checkpoint.
    pub fn restore_state(&self) -> &WalletRestoreState {
        &self.restore_state
    }

    /// Cached registry presentation cannot establish the current authchain on
    /// a later run. Keep a previously verified name visible as last-known;
    /// any absence/unpublished claim must be resolved again from live sources.
    pub(crate) fn restored_token_identities(&self) -> BTreeMap<String, TokenIdentity> {
        self.token_identities
            .iter()
            .map(|(category, identity)| {
                let mut identity = identity.clone();
                identity.status = match identity.status {
                    IdentityStatus::Verified | IdentityStatus::Stale => IdentityStatus::Stale,
                    IdentityStatus::Unpublished | IdentityStatus::Unresolved => {
                        IdentityStatus::Unresolved
                    }
                };
                identity.presentation = identity.authenticated_presentation();
                (category.clone(), identity)
            })
            .collect()
    }

    pub(crate) fn validate_wallet(&self, app: &AppState) -> Result<(), String> {
        validate_scan_coverage(
            self.scan_coverage,
            self.state
                .authoritative
                .as_ref()
                .and_then(|snapshot| snapshot.chain_tip),
        )?;
        validate_restore_state(
            &self.restore_state,
            self.state
                .authoritative
                .as_ref()
                .and_then(|snapshot| snapshot.chain_tip),
        )?;
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
        validate_scan_coverage(
            self.scan_coverage,
            snapshot.and_then(|snapshot| snapshot.chain_tip),
        )?;
        validate_restore_state(
            &self.restore_state,
            snapshot.and_then(|snapshot| snapshot.chain_tip),
        )?;
        let book = snapshot.and_then(|snapshot| snapshot.value.hd.as_ref());
        let stored = StoredCheckpoint {
            format: FORMAT.into(),
            network: self.network.to_string(),
            account_path: self.account.to_string(),
            account_xpub: self.account_xpub.clone(),
            branch_lengths: (0..4)
                .map(|branch| book.map_or(0, |book| book.branches[branch].len() as u32))
                .collect(),
            header_view: self
                .header_progress
                .as_ref()
                .map(|progress| StoredHeaderView {
                    view: progress.view.clone(),
                    height: progress.trusted.height,
                    commitment: progress.trusted.commitment,
                    provenance: provenance_name(&progress.trusted.provenance).to_owned(),
                }),
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
            scan_coverage: self.scan_coverage.map(|coverage| {
                (
                    coverage.from_height,
                    coverage.skipped_below,
                    coverage.chosen_by_holder,
                )
            }),
            rescan_requested: self.rescan_requested,
            restore_state: self.restore_state.clone(),
            token_identities: self
                .token_identities
                .iter()
                .map(|(category, identity)| {
                    (
                        category.clone(),
                        StoredTokenIdentity {
                            name: identity.name.clone(),
                            ticker: identity.ticker.clone(),
                            decimals: identity.decimals,
                            status: identity.status.into(),
                            presentation: identity.authenticated_presentation(),
                        },
                    )
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
        if ![FORMAT, ALLOCATION_FORMAT, LEGACY_FORMAT].contains(&stored.format.as_str()) {
            return Err("unsupported wallet checkpoint format or source".into());
        }
        if stored.format != FORMAT
            && (stored.scan_coverage.is_some() || stored.rescan_requested.is_some())
        {
            return Err("scan preferences require checkpoint format v3".into());
        }
        // Decoded before either construction path so a record that carries
        // header progress cannot resume without it on one branch and with it
        // on the other.
        let header_progress = match stored.header_view.as_ref() {
            None => None,
            Some(sealed) => Some(StoredHeaderProgress {
                view: sealed.view.clone(),
                trusted: HeaderCheckpoint {
                    height: sealed.height,
                    commitment: sealed.commitment,
                    provenance: provenance_from_name(&sealed.provenance)?,
                },
            }),
        };
        let scan_coverage =
            stored
                .scan_coverage
                .map(
                    |(from_height, skipped_below, chosen_by_holder)| optn_app::ScanCoverageView {
                        from_height,
                        skipped_below,
                        chosen_by_holder,
                    },
                );
        validate_scan_coverage(scan_coverage, stored.tip)?;
        // Checkpoints written before durable birthday metadata still carried
        // the old floor projections. Preserve that intent in the shared
        // restore state before the sync actor consumes the checkpoint.
        let mut restore_state = stored.restore_state;
        if matches!(&restore_state.birthday, WalletBirthday::Unknown)
            && restore_state.manual_rescan.is_none()
        {
            let legacy_floor = stored.rescan_requested.or_else(|| {
                scan_coverage
                    .as_ref()
                    .filter(|coverage| coverage.chosen_by_holder)
                    .map(|coverage| coverage.from_height)
            });
            if let Some(height) = legacy_floor {
                restore_state.request_rescan_from(height);
            }
        }
        validate_restore_state(&restore_state, stored.tip)?;
        let token_identities = decode_token_identities(&stored.token_identities)?;
        let branch_lengths: [u32; 4] =
            match (stored.format.as_str(), stored.branch_lengths.as_slice()) {
                (LEGACY_FORMAT, [receive, change, old_defi]) if stored.allocation.is_none() => {
                    // v1 used branch 2. Never reinterpret that history as branch 7.
                    [*receive, *change, 0, *old_defi]
                }
                (FORMAT | ALLOCATION_FORMAT, [receive, change, defi, compatibility]) => {
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
                if [FORMAT, ALLOCATION_FORMAT].contains(&stored.format.as_str())
                    && stored.allocation.is_some()
                    && branch_lengths == [0; 4]
                    && stored.tip.is_none()
                    && scan_coverage.is_none()
                    && stored.transactions.is_empty()
                    && stored.annotations.is_empty() =>
            {
                // Addresses issued offline are not an authoritative empty scan.
                return Ok(Self {
                    network,
                    account,
                    account_xpub,
                    allocation: stored.allocation,
                    scan_coverage: None,
                    rescan_requested: stored.rescan_requested,
                    restore_state,
                    state: WalletReconciliation::default(),
                    coins: CoinSet::new(),
                    token_identities: BTreeMap::new(),
                    header_progress,
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
            scan_coverage,
            rescan_requested: stored.rescan_requested,
            restore_state,
            state,
            coins,
            token_identities,
            header_progress,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet_birthday::WalletBirthday;
    use optn_core::{
        hd::{Wallet, BIP39_TEST_VECTOR_MNEMONIC},
        watch_only::address_under_account,
    };

    fn fixture_nonce(which: u64) -> [u8; NONCE_LEN] {
        core::array::from_fn(|i| {
            let lane = (which.wrapping_mul(0x9E3779B97F4A7C15) >> ((i % 8) * 8)) as u8;
            lane.wrapping_add(i as u8).wrapping_add(1)
        })
    }

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
                header_view: None,
                source: None,
                evidence: None,
                tip: None,
                transactions: vec![],
                annotations: vec![],
                scan_coverage: None,
                rescan_requested: None,
                restore_state: WalletRestoreState::default(),
                allocation: Some(HdAddressAllocation::default()),
                token_identities: BTreeMap::new(),
            },
        )
    }

    // Authenticated codec fixtures, never a production key or encryption entry point.
    fn encoded(key: &PackKey, stored: &StoredCheckpoint, sequence: u8) -> Vec<u8> {
        encoded_value(key, &serde_json::to_value(stored).unwrap(), sequence)
    }

    fn encoded_value(key: &PackKey, value: &serde_json::Value, sequence: u8) -> Vec<u8> {
        let nonce = fixture_nonce(u64::from(sequence) + 1);
        let mut bytes = nonce.to_vec();
        bytes.extend(wallet_pack::seal(key, &nonce, &serde_json::to_vec(value).unwrap()).unwrap());
        bytes
    }

    /// Header progress survives the seal, and resumes above genesis.
    ///
    /// This is the whole point of persisting it: before, every restart
    /// restarted the accumulator at height 0, so a wallet on a chain of any
    /// length re-walked the chain before it could do anything at all.
    #[test]
    fn sealed_header_progress_resumes_above_genesis() {
        use crate::header_verifier::shipped_header_verifier;
        use crate::header_view::VerifiedHeaderView;

        let (key, mut stored) = fixture();
        let verifier = shipped_header_verifier(Network::Chipnet).expect("chipnet anchor");
        let view = VerifiedHeaderView::new(Network::Chipnet, verifier);
        let trusted = view.checkpoint();

        stored.header_view = Some(StoredHeaderView {
            view: view.encode().expect("encodes"),
            height: trusted.height,
            commitment: trusted.commitment,
            provenance: provenance_name(&trusted.provenance).to_owned(),
        });

        let reopened = WalletCheckpoint::open(&key, &encoded(&key, &stored, 40)).expect("opens");
        let progress = reopened
            .header_progress()
            .expect("a sealed record carries its header progress");
        assert_eq!(progress.trusted, trusted);

        // And it restores into a working view against its own sealed
        // commitment -- the value a plain file could not be trusted to assert.
        let restored =
            VerifiedHeaderView::restore(&progress.view, Network::Chipnet, &progress.trusted)
                .expect("restores");
        assert_eq!(restored.checkpoint(), trusted);
    }

    /// A record with no header progress still opens, and resumes as before.
    #[test]
    fn a_record_without_header_progress_still_opens() {
        let (key, stored) = fixture();
        let reopened = WalletCheckpoint::open(&key, &encoded(&key, &stored, 41)).expect("opens");
        assert!(reopened.header_progress().is_none());
    }

    #[test]
    fn durable_restore_state_survives_checkpoint_round_trip() {
        let (key, mut stored) = fixture();
        stored.restore_state = WalletRestoreState {
            birthday: WalletBirthday::ImportedAtHeight { height: 12 },
            scanned_through: Some(11),
            manual_rescan: Some(crate::wallet_birthday::ManualRescan {
                from_height: 12,
                previous_scanned_through: Some(11),
            }),
        };
        let reopened = WalletCheckpoint::open(&key, &encoded(&key, &stored, 43)).expect("opens");
        assert_eq!(reopened.restore_state(), &stored.restore_state);
    }

    #[test]
    fn legacy_checkpoint_without_restore_state_defaults_to_unknown() {
        let (key, stored) = fixture();
        let mut value = serde_json::to_value(&stored).expect("encodes");
        value
            .as_object_mut()
            .expect("checkpoint object")
            .remove("restore_state");
        let reopened =
            WalletCheckpoint::open(&key, &encoded_value(&key, &value, 44)).expect("opens");
        assert_eq!(reopened.restore_state().birthday, WalletBirthday::Unknown);
        assert_eq!(reopened.restore_state().scanned_through, None);
        assert!(reopened.restored_token_identities().is_empty());
    }

    #[test]
    fn cached_identity_decode_rejects_invalid_category_and_unbounded_labels() {
        for (category, name) in [
            ("AA".repeat(32), "Bitcats".into()),
            ("aa".repeat(32), "x".repeat(513)),
        ] {
            let (key, mut stored) = fixture();
            stored.token_identities.insert(
                category,
                StoredTokenIdentity {
                    name,
                    ticker: Some("BCAT".into()),
                    decimals: 2,
                    status: StoredIdentityStatus::Verified,
                    presentation: Default::default(),
                },
            );
            assert!(WalletCheckpoint::open(&key, &encoded(&key, &stored, 91)).is_err());
        }
    }

    #[test]
    fn authenticated_presentation_projects_seals_and_reopens_as_stale() {
        use crate::token_metadata::{
            observe_identity, resolve, IdentityMetadata, StaleReason, UnresolvedReason,
        };
        use optn_core::bcmr::RegistryPublication;
        // Non-palindromic display-order category catches accidental txid reversal.
        let category: [u8; 32] = core::array::from_fn(|i| i as u8);
        let category_hex: String = category.iter().map(|b| format!("{b:02x}")).collect();
        let rich = serde_json::json!({
            "description": "Authenticated tickets", "uris": {"icon": "ipfs://bafy/ticket.png"},
            "nfts": {"parse": {"types": {"01": {"name": "Ticket", "description": "Admission"}}}}
        });
        let body = serde_json::to_vec(
            &serde_json::json!({"identities": {&category_hex: {"2023-11-14T22:13:20.000Z": {
                "name": "Tickets", "description": rich["description"], "uris": rich["uris"],
                "token": {"category": category_hex, "symbol": "TKT", "nfts": rich["nfts"]}
            }}}}),
        )
        .unwrap();
        let publication =
            RegistryPublication::committing_to(&body, vec!["https://example.test".into()]);
        let current = resolve(
            &publication,
            &[("https://example.test".into(), Ok(body.clone()))],
        );
        for (metadata, expected) in [
            (current, IdentityStatus::Verified),
            (
                IdentityMetadata::LastKnown {
                    contents: body.clone(),
                    authhead: [3; 32],
                    reason: StaleReason::AuthheadAdvanced,
                },
                IdentityStatus::Stale,
            ),
            (IdentityMetadata::Unpublished, IdentityStatus::Unpublished),
            (
                IdentityMetadata::Unresolved {
                    reason: UnresolvedReason::AuthchainIncomplete,
                },
                IdentityStatus::Unresolved,
            ),
            (
                resolve(
                    &publication,
                    &[("https://example.test".into(), Ok(b"tampered".to_vec()))],
                ),
                IdentityStatus::Unresolved,
            ),
        ] {
            let optn_app::AppAction::SetTokenIdentity {
                category_hex: projected_category,
                identity,
            } = observe_identity(category, metadata)
            else {
                panic!("identity observation")
            };
            assert_eq!(projected_category, category_hex);
            assert_eq!(identity.status, expected);
            let authenticated =
                matches!(expected, IdentityStatus::Verified | IdentityStatus::Stale);
            assert_eq!(identity.presentation.description.is_some(), authenticated);
            if authenticated {
                assert_eq!(serde_json::to_value(&identity.presentation).unwrap(), rich);
            }

            let (key, mut stored) = fixture();
            stored.source = Some(SourceId::new("presentation-fixture"));
            stored.evidence = Some(Evidence::ServerAssertion);
            stored.tip = Some((100, [3; 32]));
            stored.branch_lengths = vec![1; 4];
            stored.token_identities.insert(
                category_hex.clone(),
                StoredTokenIdentity {
                    name: identity.name,
                    ticker: identity.ticker,
                    decimals: identity.decimals,
                    status: identity.status.into(),
                    presentation: identity.presentation.clone(),
                },
            );
            let reopened = WalletCheckpoint::open(&key, &encoded(&key, &stored, 92)).unwrap();
            assert_eq!(reopened.network, Network::Chipnet);
            assert_eq!(reopened.account_xpub, stored.account_xpub);
            let identities = reopened.restored_token_identities();
            assert_eq!(
                identities[&category_hex].status,
                if authenticated {
                    IdentityStatus::Stale
                } else {
                    IdentityStatus::Unresolved
                }
            );
            assert_eq!(
                identities[&category_hex].presentation,
                identity.presentation
            );
            let resealed = reopened.seal(&key, &fixture_nonce(200)).unwrap();
            let twice = WalletCheckpoint::open(&key, &resealed).unwrap();
            assert_eq!(twice.restored_token_identities(), identities);
        }
    }

    #[test]
    fn checkpoint_presentation_defaults_rejects_invalid_and_cannot_promote_unknown_status() {
        let (key, mut stored) = fixture();
        let category = "aa".repeat(32);
        stored.source = Some(SourceId::new("presentation-fixture"));
        stored.evidence = Some(Evidence::ServerAssertion);
        stored.tip = Some((100, [3; 32]));
        stored.branch_lengths = vec![1; 4];
        stored.token_identities.insert(
            category.clone(),
            StoredTokenIdentity {
                name: "Tickets".into(),
                ticker: None,
                decimals: 0,
                status: StoredIdentityStatus::Verified,
                presentation: Default::default(),
            },
        );
        let mut legacy = serde_json::to_value(&stored).unwrap();
        legacy["token_identities"][&category]
            .as_object_mut()
            .unwrap()
            .remove("presentation");
        let reopened = WalletCheckpoint::open(&key, &encoded_value(&key, &legacy, 93)).unwrap();
        assert_eq!(
            reopened.restored_token_identities()[&category].presentation,
            TokenPresentation::default()
        );
        assert_eq!(
            reopened.restored_token_identities()[&category].status,
            IdentityStatus::Stale
        );

        for invalid in [
            serde_json::json!({"description": "x".repeat(4097)}),
            serde_json::json!({"uris": {"icon": "file:///private"}}),
            serde_json::json!({"nfts": {"parse": {"types": []}}}),
            serde_json::json!({"nfts": {"parse": {"types": {"": {"name": "NFT", "extensions": {"huge": "x".repeat(65536)}}}}}}),
        ] {
            let mut value = legacy.clone();
            value["token_identities"][&category]["presentation"] = invalid;
            assert!(WalletCheckpoint::open(&key, &encoded_value(&key, &value, 94)).is_err());
        }
        for status in ["unpublished", "unresolved", "future-status"] {
            let mut value = legacy.clone();
            value["token_identities"][&category]["status"] = status.into();
            value["token_identities"][&category]["presentation"] =
                serde_json::json!({"description": "Cannot confer authority"});
            let reopened = WalletCheckpoint::open(&key, &encoded_value(&key, &value, 95)).unwrap();
            assert_eq!(
                reopened.restored_token_identities()[&category].status,
                IdentityStatus::Unresolved
            );
            assert_eq!(
                reopened.restored_token_identities()[&category].presentation,
                TokenPresentation::default()
            );
        }
    }

    #[test]
    fn legacy_floor_projection_migrates_to_manual_rescan() {
        let (key, mut stored) = fixture();
        stored.rescan_requested = Some(50);
        let mut value = serde_json::to_value(&stored).expect("encodes");
        value
            .as_object_mut()
            .expect("checkpoint object")
            .remove("restore_state");
        let reopened =
            WalletCheckpoint::open(&key, &encoded_value(&key, &value, 46)).expect("opens");
        assert_eq!(
            reopened.restore_state().manual_rescan,
            Some(crate::wallet_birthday::ManualRescan {
                from_height: 50,
                previous_scanned_through: None,
            })
        );

        let (key, mut stored) = fixture();
        stored.source = Some(SourceId::new("legacy-floor-fixture"));
        stored.evidence = Some(Evidence::ServerAssertion);
        stored.tip = Some((100, [3; 32]));
        stored.branch_lengths = vec![1; 4];
        stored.scan_coverage = Some((50, Some(50), true));
        let mut value = serde_json::to_value(&stored).expect("encodes");
        value
            .as_object_mut()
            .expect("checkpoint object")
            .remove("restore_state");
        let reopened =
            WalletCheckpoint::open(&key, &encoded_value(&key, &value, 47)).expect("opens");
        assert_eq!(
            reopened.restore_state().manual_rescan,
            Some(crate::wallet_birthday::ManualRescan {
                from_height: 50,
                previous_scanned_through: None,
            })
        );
    }

    #[test]
    fn existing_imported_birthday_is_not_reinterpreted_as_legacy_floor() {
        let (key, mut stored) = fixture();
        stored.restore_state.birthday = WalletBirthday::ImportedAtHeight { height: 9 };
        stored.rescan_requested = Some(50);
        let reopened = WalletCheckpoint::open(&key, &encoded(&key, &stored, 48)).expect("opens");
        assert_eq!(
            reopened.restore_state().birthday,
            WalletBirthday::ImportedAtHeight { height: 9 }
        );
        assert_eq!(reopened.restore_state().manual_rescan, None);
    }

    #[test]
    fn restore_progress_above_authenticated_tip_is_refused() {
        let (key, mut stored) = fixture();
        stored.tip = Some((10, [2; 32]));
        stored.restore_state.scanned_through = Some(11);
        let error = WalletCheckpoint::open(&key, &encoded(&key, &stored, 45))
            .expect_err("progress beyond the stored tip must fail closed");
        assert!(error.contains("restore progress"), "{error}");
    }

    /// Provenance a newer build wrote is refused, not quietly downgraded.
    ///
    /// Reading it as "self-derived" would weaken what the holder's own wallet
    /// recorded about where its trust came from, which is the one field here
    /// whose whole job is to say that.
    #[test]
    fn unknown_header_provenance_is_refused() {
        let (key, mut stored) = fixture();
        stored.header_view = Some(StoredHeaderView {
            view: "{}".into(),
            height: 0,
            commitment: [7; 32],
            provenance: "attested-by-a-future-build".into(),
        });
        let error = WalletCheckpoint::open(&key, &encoded(&key, &stored, 42))
            .expect_err("unknown provenance must not open");
        assert!(error.contains("provenance"), "{error}");
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
    fn v2_migrates_and_v3_retains_pending_rescan_without_inventing_coverage() {
        let (key, mut stored) = fixture();
        stored.format = ALLOCATION_FORMAT.into();
        let previous = WalletCheckpoint::open(&key, &encoded(&key, &stored, 20)).unwrap();
        assert_eq!(previous.scan_coverage, None);
        assert_eq!(previous.rescan_requested, None);
        stored.rescan_requested = Some(50);
        assert!(WalletCheckpoint::open(&key, &encoded(&key, &stored, 21)).is_err());
        stored.format = FORMAT.into();
        let pending = WalletCheckpoint::open(&key, &encoded(&key, &stored, 22)).unwrap();
        let resumed =
            WalletCheckpoint::open(&key, &pending.seal(&key, &fixture_nonce(24)).unwrap()).unwrap();
        assert_eq!(resumed.rescan_requested, Some(50));
        assert!(resumed.state.authoritative.is_none());
        assert_eq!(resumed.scan_coverage, None);
        // A pending instruction is not proof that any range has been scanned.
        stored.scan_coverage = Some((50, Some(50), true));
        assert!(WalletCheckpoint::open(&key, &encoded(&key, &stored, 25)).is_err());
        let mut invalid = pending;
        invalid.scan_coverage = Some(optn_app::ScanCoverageView {
            from_height: 50,
            skipped_below: Some(50),
            chosen_by_holder: true,
        });
        assert!(invalid.seal(&key, &fixture_nonce(27)).is_err());
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
            WalletCheckpoint::open(&key, &restored.seal(&key, &fixture_nonce(9)).unwrap()).unwrap();
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
