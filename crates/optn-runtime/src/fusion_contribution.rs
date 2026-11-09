//! A CashFusion round's contribution, prepared inside the runtime.
//!
//! A round needs each offered coin's signing key and a set of fresh output
//! scripts. Both are wallet authority, so both come from here, under the same
//! guards as a payment: a durable session, fresh coins, the synchronized
//! account, and Background authorization. Auto Fusion never prompts; the
//! holder consented when they turned it on, and a prompt mid-round would kill
//! the round.
//!
//! They are two requests because the second depends on the first: how many
//! outputs a round needs comes from its tier plans, and the plans are made
//! from the offered coins' public keys.
//!
//! Outputs go to change addresses, as Electron Cash's fusion does
//! (`reserve_change_addresses`). They are reserved durably before any script
//! leaves the runtime, so a round that fails after disclosing them never hands
//! them out again. Change has no BIP44 receive-gap limit, and the runtime scans
//! every allocated index, so a saved wallet always finds the outputs. A host's
//! ordinary send reserves its change the same way
//! ([`AppRuntime::reserve_change_outputs`]).
//!
//! What a round did is recorded here too: the wallet's fusion depth record
//! (`optn_core::fusion::depth`) lives in its state and is sealed with its
//! checkpoint, so it is as durable and as private as the wallet's history.

use crate::{AppRuntime, AppRuntimeDriver, PublicationGuard, RuntimeRequest};
use optn_app::{AppEvent, AuthScope, HdBranch};
use optn_core::{cashaddr::Address, coins::Outpoint};
use optn_transport::TransportError;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

/// Most coins, and most outputs, one contribution may carry (Electron Cash
/// `MAX_COMPONENTS`).
pub const MAX_CONTRIBUTION_ITEMS: usize = 40;

/// What a round asks the wallet for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FusionContributionRequest {
    /// The signing keys of the coins a round will offer, each named by its
    /// display-order `txid:vout`. Changes nothing.
    InputKeys { outpoints: Vec<String> },
    /// Reserve `count` fresh change outputs, durably.
    ReserveChange { count: usize },
    /// Record a round the network holds in the depth record, durably.
    RecordRound {
        spent: Vec<String>,
        created: Vec<String>,
        at_ms: u64,
    },
    /// Merge a depth record kept outside the runtime (the CLI's former
    /// plaintext file) into the wallet's, durably.
    ImportDepth {
        coins: Option<String>,
        tx_depth: Option<String>,
        txids: Vec<String>,
    },
}

/// One offered coin and the key that signs it.
pub struct FusionInputSecret {
    /// Display-order txid.
    pub txid: String,
    pub vout: u32,
    pub value_sats: u64,
    /// Compressed public key.
    pub pubkey: [u8; 33],
    pub privkey: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for FusionInputSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FusionInputSecret")
            .field("txid", &self.txid)
            .field("vout", &self.vout)
            .field("value_sats", &self.value_sats)
            .finish_non_exhaustive()
    }
}

/// The runtime's answer to a [`FusionContributionRequest`].
#[derive(Debug)]
pub enum FusionContributionReply {
    InputKeys(Vec<FusionInputSecret>),
    /// Fresh P2PKH scripts, each reserved durably.
    Outputs(Vec<Vec<u8>>),
    /// The depth record changed and was saved, or needed no change.
    Recorded,
}

fn failure(error: impl ToString) -> TransportError {
    TransportError::Other(error.to_string())
}

fn display_txid(wire: [u8; 32]) -> String {
    let mut display = wire;
    display.reverse();
    display.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What the guards both requests share established.
struct Preconditions {
    /// The synchronized account's public key.
    account_xpub: String,
    /// Its observed last-used indexes.
    last_used: [Option<u32>; 3],
    /// A migrated wallet's holds, read from its host's store.
    host_held: Option<crate::coin_holds::CoinHolds>,
}

/// Coins rounds in this process are using, under the legacy id of the wallet
/// whose host keeps its other holds (`None` for a runtime-managed wallet).
///
/// Kept in memory and nowhere else. A round does not survive the process, so
/// neither may its holds: written to the host's file, a crash mid-round would
/// leave the coins frozen under a hold only the round could lift.
#[derive(Debug, Default)]
pub(crate) struct FusionHolds(BTreeMap<Option<u32>, BTreeSet<String>>);

/// The coins one round holds, released when this is dropped -- however the
/// round ends.
#[must_use = "the coins are released as soon as the hold is dropped"]
pub struct FusionHold {
    owner: Option<u32>,
    outpoints: Vec<String>,
    holds: Arc<Mutex<FusionHolds>>,
}

impl FusionHold {
    /// The held coins, display-order `txid:vout`, lowercase.
    pub fn outpoints(&self) -> &[String] {
        &self.outpoints
    }
}

impl Drop for FusionHold {
    fn drop(&mut self) {
        let mut holds = self
            .holds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(held) = holds.0.get_mut(&self.owner) {
            for outpoint in &self.outpoints {
                held.remove(outpoint);
            }
            if held.is_empty() {
                holds.0.remove(&self.owner);
            }
        }
    }
}

/// `txid:vout` with a valid txid, lowercase.
fn canonical_outpoint(text: &str) -> Result<String, TransportError> {
    let text = text.trim().to_ascii_lowercase();
    let (txid, vout) = text
        .split_once(':')
        .ok_or_else(|| failure(format!("{text} is not a coin.")))?;
    let vout: u32 = vout
        .parse()
        .map_err(|_| failure(format!("{text} is not a coin.")))?;
    Outpoint::parse(txid, vout).map_err(|_| failure(format!("{text} is not a coin.")))?;
    Ok(format!("{txid}:{vout}"))
}

impl AppRuntime {
    /// Trusted host API: hold `outpoints` for the round about to use them, in
    /// this process only, until the returned hold is dropped.
    ///
    /// A host shows these alongside its own durable holds for the same wallet
    /// ([`AppRuntime::fusion_holds`]), so a send cannot take a coin a round is
    /// using. A coin another round holds is refused.
    pub async fn hold_for_fusion(
        &self,
        outpoints: &[String],
    ) -> Result<FusionHold, TransportError> {
        if outpoints.is_empty() || outpoints.len() > MAX_CONTRIBUTION_ITEMS {
            return Err(failure("A fusion round offers 1 to 40 coins."));
        }
        let mut canonical = Vec::with_capacity(outpoints.len());
        for outpoint in outpoints {
            let outpoint = canonical_outpoint(outpoint)?;
            if canonical.contains(&outpoint) {
                return Err(failure(format!("{outpoint} is offered twice.")));
            }
            canonical.push(outpoint);
        }
        let status = self
            .wallet_security(optn_transport::WalletSecurityRequest::Status)
            .await?;
        if status.active.is_none() {
            return Err(TransportError::AuthenticationRequired);
        }
        let owner = status.legacy_source_id;
        let mut holds = self
            .fusion_holds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(taken) = canonical
            .iter()
            .find(|outpoint| holds.0.values().any(|held| held.contains(*outpoint)))
        {
            return Err(failure(format!("{taken} is already in a fusion round.")));
        }
        holds
            .0
            .entry(owner)
            .or_default()
            .extend(canonical.iter().cloned());
        Ok(FusionHold {
            owner,
            outpoints: canonical,
            holds: Arc::clone(&self.fusion_holds),
        })
    }

    /// The wallet's coins as fusion coin selection sees them, from this
    /// runtime's own synchronized record. Every interface chooses from the
    /// same list:
    /// - mined, by its snapshot's heights;
    /// - held, by its state, a payment in its outbox, or a round in this
    ///   process;
    /// - depth, from its sealed record.
    ///
    /// Cash Code coins are left out: their keys are not HD keys, and a round
    /// asks for HD keys only. Holds a migrated wallet's host keeps are the
    /// host's to add.
    pub fn fusion_candidates(
        &self,
    ) -> Result<Vec<optn_core::fusion::coin_selection::FusionCoin>, TransportError> {
        let mut state = self.state();
        crate::external_payment::apply_holds(&mut state);
        let confirmed: BTreeSet<String> = {
            let reconciliation = self.wallet_sync_rx.borrow();
            let snapshot = reconciliation
                .authoritative
                .as_ref()
                .ok_or_else(|| failure("Sync the wallet first."))?;
            snapshot
                .value
                .transactions
                .iter()
                .filter(|transaction| transaction.block_height.is_some())
                .map(|transaction| display_txid(transaction.txid))
                .collect()
        };
        let in_round: BTreeSet<String> = self
            .fusion_holds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0
            .values()
            .flatten()
            .cloned()
            .collect();
        let book = state.fusion_depth.clone().unwrap_or_default();
        Ok(state
            .coins
            .iter()
            .filter(|coin| !coin.is_rpa())
            .map(|coin| {
                let outpoint = coin.outpoint().to_string();
                optn_core::fusion::coin_selection::FusionCoin {
                    confirmed: confirmed.contains(&coin.outpoint().txid_hex()),
                    address: coin.address().to_owned(),
                    value_sats: coin.value_sats(),
                    token: coin.token().is_some(),
                    frozen: coin.freeze().is_some() || in_round.contains(&outpoint),
                    depth: book.depth_of(&outpoint),
                    outpoint,
                }
            })
            .collect())
    }

    /// The coins rounds in this process hold for the migrated wallet whose
    /// legacy id is `wallet_id`, display-order `txid:vout`.
    pub fn fusion_holds(&self, wallet_id: u32) -> BTreeSet<String> {
        self.fusion_holds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0
            .get(&Some(wallet_id))
            .cloned()
            .unwrap_or_default()
    }
    async fn fusion_contribution(
        &self,
        request: FusionContributionRequest,
    ) -> Result<FusionContributionReply, TransportError> {
        let (reply, received) = oneshot::channel();
        self.action_tx
            .send(RuntimeRequest::FusionContribution(
                request,
                Box::new(self.wallet_operation_guard()),
                reply,
            ))
            .await
            .map_err(|_| TransportError::Closed)?;
        received.await.map_err(|_| TransportError::Closed)?
    }

    /// Trusted host API: the signing keys of the coins a round will offer.
    pub async fn fusion_input_keys(
        &self,
        outpoints: Vec<String>,
    ) -> Result<Vec<FusionInputSecret>, TransportError> {
        match self
            .fusion_contribution(FusionContributionRequest::InputKeys { outpoints })
            .await?
        {
            FusionContributionReply::InputKeys(keys) => Ok(keys),
            _ => Err(failure("Unexpected fusion reply.")),
        }
    }

    /// Trusted host API: `count` fresh change outputs, reserved durably, for
    /// a fusion round's outputs or a send's change.
    pub async fn reserve_change_outputs(
        &self,
        count: usize,
    ) -> Result<Vec<Vec<u8>>, TransportError> {
        match self
            .fusion_contribution(FusionContributionRequest::ReserveChange { count })
            .await?
        {
            FusionContributionReply::Outputs(scripts) => Ok(scripts),
            _ => Err(failure("Unexpected fusion reply.")),
        }
    }

    /// The wallet's fusion depth record, as last saved.
    pub fn fusion_depth(&self) -> optn_core::fusion::depth::FusionDepthBook {
        self.state().fusion_depth.unwrap_or_default()
    }

    /// Trusted host API: record a round the network holds -- the coins it
    /// spent and the outputs it created, each `txid:vout` -- in the depth
    /// record, saved with the wallet's checkpoint before this returns.
    pub async fn record_fusion_round(
        &self,
        spent: Vec<String>,
        created: Vec<String>,
        at_ms: u64,
    ) -> Result<(), TransportError> {
        match self
            .fusion_contribution(FusionContributionRequest::RecordRound {
                spent,
                created,
                at_ms,
            })
            .await?
        {
            FusionContributionReply::Recorded => Ok(()),
            _ => Err(failure("Unexpected fusion reply.")),
        }
    }

    /// Trusted host API: merge a depth record kept outside the runtime, in
    /// its stored forms, into the wallet's. Depths only rise in a merge.
    pub async fn import_fusion_depth(
        &self,
        coins: Option<String>,
        tx_depth: Option<String>,
        txids: Vec<String>,
    ) -> Result<(), TransportError> {
        match self
            .fusion_contribution(FusionContributionRequest::ImportDepth {
                coins,
                tx_depth,
                txids,
            })
            .await?
        {
            FusionContributionReply::Recorded => Ok(()),
            _ => Err(failure("Unexpected fusion reply.")),
        }
    }
}

impl AppRuntimeDriver {
    pub(super) fn handle_fusion_contribution(
        &mut self,
        request: FusionContributionRequest,
        operation_guard: Box<crate::WalletOperationGuard>,
        reply: oneshot::Sender<Result<FusionContributionReply, TransportError>>,
    ) {
        if reply.is_closed() {
            return;
        }
        let result = match request {
            FusionContributionRequest::InputKeys { outpoints } => self
                .fusion_input_keys(outpoints, &operation_guard, &reply)
                .map(FusionContributionReply::InputKeys),
            FusionContributionRequest::ReserveChange { count } => self
                .reserve_change_outputs(count, &operation_guard, &reply)
                .map(FusionContributionReply::Outputs),
            FusionContributionRequest::RecordRound {
                spent,
                created,
                at_ms,
            } => self
                .change_fusion_depth(&operation_guard, &reply, |book| {
                    book.record_round(&spent, &created, at_ms);
                })
                .map(|()| FusionContributionReply::Recorded),
            FusionContributionRequest::ImportDepth {
                coins,
                tx_depth,
                txids,
            } => self
                .change_fusion_depth(&operation_guard, &reply, |book| {
                    book.merge_stored(coins.as_deref(), tx_depth.as_deref());
                    book.add_txids(txids.iter().map(String::as_str));
                })
                .map(|()| FusionContributionReply::Recorded),
        };
        if matches!(result, Err(TransportError::AuthenticationRequired)) {
            self.publish(AppEvent::AppLockChanged);
        }
        self.expire_session();
        let _ = reply.send(result);
    }

    /// The guards both requests share.
    fn fusion_preconditions(
        &self,
        operation_guard: &crate::WalletOperationGuard,
        reply_closed: bool,
    ) -> Result<Preconditions, TransportError> {
        let guard = PublicationGuard {
            generation: operation_guard.generation,
            revocation: &self.revocation,
            now_ms: &|| crate::elapsed_ms(self.started),
        };
        if operation_guard.is_revoked()
            || !guard.allows(&self.state, reply_closed)
            || self.state.surface.is_viewer_only()
        {
            return Err(failure("Wallet session changed."));
        }
        let security = self.security.as_ref().ok_or(TransportError::Unsupported)?;
        security.require_durable_session(&self.state)?;
        // A migrated wallet's host may hold coins outside the runtime's record,
        // so their absence here proves nothing -- unless the host's own store
        // is read. Without one, the wallet cannot fuse here.
        let host_held = match security.status(&self.state)?.legacy_source_id {
            None => None,
            Some(id) => {
                let store = security.host_holds().filter(|_| id > 0).ok_or_else(|| {
                    failure(
                        "This migrated wallet still uses legacy reservations. This needs a runtime-managed wallet.",
                    )
                })?;
                Some(store.load(id).map_err(|error| {
                    failure(format!(
                        "The wallet's coin holds could not be read: {error}"
                    ))
                })?)
            }
        };
        if !self.wallet_sync.coins_are_fresh() || self.state.wallet_sync.refreshing {
            return Err(failure("Refresh the wallet first."));
        }
        let snapshot = self
            .wallet_sync
            .reconciliation()
            .authoritative
            .as_ref()
            .ok_or_else(|| failure("Sync the wallet first."))?;
        let book = snapshot
            .value
            .hd
            .as_ref()
            .ok_or_else(|| failure("Sync the HD account first."))?;
        let opened = self
            .state
            .wallet
            .as_ref()
            .ok_or(TransportError::AuthenticationRequired)?;
        if opened.multisig_policy.is_some()
            || opened.account_xpub.as_ref() != Some(&book.account_xpub)
            || opened.account_path != book.account.to_string()
        {
            return Err(failure("Account differs from the synchronized wallet."));
        }
        Ok(Preconditions {
            account_xpub: book.account_xpub.clone(),
            last_used: book.allocation_last_used(),
            host_held,
        })
    }

    fn fusion_input_keys(
        &mut self,
        outpoints: Vec<String>,
        operation_guard: &crate::WalletOperationGuard,
        reply: &oneshot::Sender<Result<FusionContributionReply, TransportError>>,
    ) -> Result<Vec<FusionInputSecret>, TransportError> {
        let Preconditions { host_held, .. } =
            self.fusion_preconditions(operation_guard, reply.is_closed())?;
        if outpoints.is_empty() || outpoints.len() > MAX_CONTRIBUTION_ITEMS {
            return Err(failure("A fusion round offers 1 to 40 coins."));
        }
        let mut held = self.state.clone();
        crate::external_payment::apply_holds(&mut held);
        let snapshot = self
            .wallet_sync
            .reconciliation()
            .authoritative
            .as_ref()
            .ok_or_else(|| failure("Sync the wallet first."))?;
        // Ordinary HD coins only: token outputs never appear here.
        let coins = crate::wallet_spend::snapshot_spendable_coins(&snapshot.value, held.network)
            .map_err(failure)?;
        let mut picked: Vec<(String, crate::wallet_spend::SpendableCoin)> =
            Vec::with_capacity(outpoints.len());
        for wanted in &outpoints {
            let wanted = wanted.trim().to_ascii_lowercase();
            let coin = coins
                .iter()
                .find(|coin| {
                    format!("{}:{}", display_txid(coin.utxo.txid), coin.utxo.vout) == wanted
                })
                .ok_or_else(|| {
                    failure(format!("{wanted} is not a spendable coin of this wallet."))
                })?;
            let outpoint = Outpoint::parse(&display_txid(coin.utxo.txid), coin.utxo.vout)
                .map_err(|error| failure(format!("{error:?}")))?;
            if held
                .coins
                .get(outpoint)
                .is_some_and(|known| known.freeze().is_some())
                || host_held
                    .as_ref()
                    .is_some_and(|holds| holds.is_held(&outpoint.txid_hex(), coin.utxo.vout))
            {
                return Err(failure(format!(
                    "{wanted} is held and cannot join a fusion."
                )));
            }
            if picked.iter().any(|(seen, _)| *seen == wanted) {
                return Err(failure(format!("{wanted} is offered twice.")));
            }
            picked.push((wanted, coin.clone()));
        }

        let now = self.now_ms();
        let security = self.security.as_ref().ok_or(TransportError::Unsupported)?;
        let wallet = security.wallet_for_operation(&mut self.state, AuthScope::Background, now)?;
        self.wallet_sync.project_status(&mut self.state);
        self.publish_state();
        picked
            .iter()
            .map(|(_, coin)| {
                let key = wallet.signing_key(&coin.path).map_err(failure)?;
                Ok(FusionInputSecret {
                    txid: display_txid(coin.utxo.txid),
                    vout: coin.utxo.vout,
                    value_sats: coin.utxo.value,
                    pubkey: wallet.public_key(&coin.path).map_err(failure)?,
                    privkey: Zeroizing::new(key.to_bytes().into()),
                })
            })
            .collect()
    }

    /// Change the depth record and save it with the checkpoint. Unlike the
    /// round's own requests this asks only that the same wallet session is
    /// still open, not that its coins are fresh or untouched: a round already
    /// finished, and its result must be kept whatever a refresh does
    /// meanwhile.
    fn change_fusion_depth(
        &mut self,
        operation_guard: &crate::WalletOperationGuard,
        reply: &oneshot::Sender<Result<FusionContributionReply, TransportError>>,
        change: impl FnOnce(&mut optn_core::fusion::depth::FusionDepthBook),
    ) -> Result<(), TransportError> {
        let guard = PublicationGuard {
            generation: operation_guard.generation,
            revocation: &self.revocation,
            now_ms: &|| crate::elapsed_ms(self.started),
        };
        if !guard.allows(&self.state, reply.is_closed())
            || self.state.wallet.is_none()
            || self.state.surface.is_viewer_only()
        {
            return Err(failure("Wallet session changed."));
        }
        let security = self.security.as_mut().ok_or(TransportError::Unsupported)?;
        security.require_durable_session(&self.state)?;
        let mut candidate = self.state.clone();
        change(candidate.fusion_depth.get_or_insert_with(Default::default));
        if candidate.fusion_depth.clone().unwrap_or_default()
            == self.state.fusion_depth.clone().unwrap_or_default()
        {
            return Ok(());
        }
        let restore = self.wallet_sync.restore_state().clone();
        let event = self.wallet_sync.persist_annotation(
            &mut candidate,
            self.state.clone(),
            &restore,
            |app, sync, restore, progress, cache| {
                security.persist_checkpoint(app, sync, restore, progress, cache)
            },
            |app| guard.allows(app, reply.is_closed()),
        );
        self.state = candidate;
        if event != AppEvent::CoinsChanged {
            self.publish(event);
            return Err(failure(
                "The fusion depth record could not be saved. Reopen the wallet before retrying.",
            ));
        }
        security.checkpoint_published();
        self.publish(event);
        Ok(())
    }

    fn reserve_change_outputs(
        &mut self,
        count: usize,
        operation_guard: &crate::WalletOperationGuard,
        reply: &oneshot::Sender<Result<FusionContributionReply, TransportError>>,
    ) -> Result<Vec<Vec<u8>>, TransportError> {
        let Preconditions {
            account_xpub,
            last_used,
            ..
        } = self.fusion_preconditions(operation_guard, reply.is_closed())?;
        if count == 0 || count > MAX_CONTRIBUTION_ITEMS {
            return Err(failure("Reserve 1 to 40 change outputs."));
        }
        let mut candidate = self.state.clone();
        let allocation = candidate
            .hd_addresses
            .as_mut()
            .ok_or_else(|| failure("No durable HD allocation."))?;
        let mut scripts = Vec::with_capacity(count);
        for _ in 0..count {
            let index = allocation
                .allocate(HdBranch::Change, last_used, false)
                .map_err(failure)?;
            let change = optn_core::watch_only::address_under_account(
                candidate.network,
                &account_xpub,
                1,
                index,
            )
            .map_err(failure)?;
            scripts.push(
                Address::decode(&change.address)
                    .map_err(failure)?
                    .script_pubkey(),
            );
        }

        // Saved before any script leaves the runtime.
        let guard = PublicationGuard {
            generation: operation_guard.generation,
            revocation: &self.revocation,
            now_ms: &|| crate::elapsed_ms(self.started),
        };
        let security = self.security.as_mut().ok_or(TransportError::Unsupported)?;
        let restore = self.wallet_sync.restore_state().clone();
        let event = self.wallet_sync.persist_annotation(
            &mut candidate,
            self.state.clone(),
            &restore,
            |app, sync, restore, progress, cache| {
                security.persist_checkpoint(app, sync, restore, progress, cache)
            },
            |app| !operation_guard.is_revoked() && guard.allows(app, reply.is_closed()),
        );
        self.state = candidate;
        if event != AppEvent::CoinsChanged {
            self.publish(event);
            return Err(failure(
                "Change outputs could not be reserved. Reopen the wallet before retrying.",
            ));
        }
        security.checkpoint_published();
        self.publish(event);
        Ok(scripts)
    }
}

#[cfg(test)]
mod tests {
    use crate::external_payment::tests::{fixture, prepare, secret, start, sync_fixture};
    use crate::AppRuntime;
    use optn_core::fusion::depth::FusionDepthBook;
    use std::sync::atomic::Ordering;

    fn funded_outpoint(runtime: &AppRuntime) -> String {
        let coin = runtime.state().coins.iter().next().cloned().unwrap();
        coin.outpoint().to_string()
    }

    #[tokio::test]
    async fn a_round_gets_its_coins_keys_and_durably_reserved_change() {
        let (runtime, _storage, _checkpoints, _handle) = fixture().await;
        // Nothing before the wallet is synchronized.
        assert!(runtime
            .fusion_input_keys(vec!["00:0".into()])
            .await
            .is_err());
        assert!(runtime.reserve_change_outputs(1).await.is_err());
        sync_fixture(&runtime).await;
        let outpoint = funded_outpoint(&runtime);
        let before = runtime.state().hd_addresses.unwrap().next_indexes();

        let keys = runtime
            .fusion_input_keys(vec![outpoint.to_uppercase()])
            .await
            .unwrap();
        assert_eq!(keys.len(), 1);
        let input = &keys[0];
        assert_eq!(format!("{}:{}", input.txid, input.vout), outpoint);
        assert_eq!(input.value_sats, 20_000);
        // The key signs for the coin's own address (receive index 0).
        let wallet =
            optn_core::hd::Wallet::from_mnemonic(optn_core::hd::BIP39_TEST_VECTOR_MNEMONIC, "")
                .unwrap();
        let path = optn_core::hd::AccountPath::default_for(optn_core::network::Network::Chipnet)
            .address_path(false, 0);
        assert_eq!(input.pubkey, wallet.public_key(&path).unwrap());
        assert_eq!(
            input.privkey.as_slice(),
            wallet.signing_key(&path).unwrap().to_bytes().as_slice()
        );
        assert!(!format!("{input:?}").contains("privkey"));
        // Asking for keys reserves nothing.
        assert_eq!(runtime.state().hd_addresses.unwrap().next_indexes(), before);

        let outputs = runtime.reserve_change_outputs(3).await.unwrap();
        assert_eq!(outputs.len(), 3);
        let after = runtime.state().hd_addresses.unwrap().next_indexes();
        assert_eq!(after[1], before[1] + 3);
        assert_eq!(after[0], before[0]);
        let mut distinct = outputs.clone();
        distinct.sort();
        distinct.dedup();
        assert_eq!(distinct.len(), 3);
        // A second round never gets the same outputs.
        let again = runtime.reserve_change_outputs(3).await.unwrap();
        assert!(again.iter().all(|script| !outputs.contains(script)));
    }

    #[tokio::test]
    async fn foreign_duplicate_held_or_out_of_range_requests_are_refused() {
        let (runtime, _storage, checkpoints, handle) = fixture().await;
        sync_fixture(&runtime).await;
        let outpoint = funded_outpoint(&runtime);
        let keys = |outpoints: Vec<String>| runtime.fusion_input_keys(outpoints);
        assert!(keys(vec![format!("{}:0", "ab".repeat(32))]).await.is_err());
        assert!(keys(vec![outpoint.clone(), outpoint.clone()])
            .await
            .is_err());
        assert!(keys(vec![]).await.is_err());
        assert!(runtime.reserve_change_outputs(0).await.is_err());
        assert!(runtime.reserve_change_outputs(41).await.is_err());

        // A failed save reserves nothing.
        let allocation = runtime.state().hd_addresses;
        checkpoints.fail.store(true, Ordering::SeqCst);
        assert!(runtime.reserve_change_outputs(1).await.is_err());
        assert_eq!(runtime.state().hd_addresses, allocation);
        checkpoints.fail.store(false, Ordering::SeqCst);
        // As with a payment, a failed save asks for the wallet to be reopened.
        // After that the same request succeeds, so the refusal was the save.
        runtime
            .wallet_security(optn_transport::WalletSecurityRequest::Open {
                handle,
                password: optn_app::SecretText::new(String::new()),
            })
            .await
            .unwrap();
        sync_fixture(&runtime).await;
        assert!(runtime.reserve_change_outputs(1).await.is_ok());
        assert!(keys(vec![outpoint.clone()]).await.is_ok());

        // A payment's held input cannot join.
        prepare(&runtime, "held").await.unwrap();
        assert!(keys(vec![outpoint]).await.is_err());
    }

    /// The depth record is sealed with the wallet's checkpoint before the
    /// call returns, so a fresh runtime over the same storage -- the next
    /// start after a hard stop -- reads every recorded round.
    #[tokio::test]
    async fn a_recorded_round_survives_a_restart_sealed_with_the_wallet() {
        let (runtime, storage, checkpoints, handle) = fixture().await;
        sync_fixture(&runtime).await;
        let spent = funded_outpoint(&runtime);
        let fusion = "cd".repeat(32);
        let created = vec![format!("{fusion}:0"), format!("{fusion}:1")];
        assert_eq!(runtime.fusion_depth(), FusionDepthBook::new());

        runtime
            .record_fusion_round(vec![spent.clone()], created.clone(), 1_000)
            .await
            .unwrap();
        let book = runtime.fusion_depth();
        assert_eq!(book.depth_of(&created[0]), 1);
        assert_eq!(book.depth_of(&spent), 0);
        assert!(book.is_fusion_transaction(&fusion));

        // A second round on one of its outputs goes one deeper.
        let deeper = format!("{}:0", "ef".repeat(32));
        runtime
            .record_fusion_round(vec![created[0].clone()], vec![deeper.clone()], 2_000)
            .await
            .unwrap();
        assert_eq!(runtime.fusion_depth().depth_of(&deeper), 2);

        drop(runtime);
        let restarted = start(storage, checkpoints);
        restarted
            .wallet_security(optn_transport::WalletSecurityRequest::Open {
                handle,
                password: secret(""),
            })
            .await
            .unwrap();
        let reopened = restarted.fusion_depth();
        assert_eq!(reopened.depth_of(&deeper), 2);
        assert_eq!(reopened.depth_of(&created[1]), 1);
        assert!(reopened.is_fusion_transaction(&fusion));
    }

    /// A round whose save fails is not recorded: the record stays as last
    /// saved, and the wallet asks to be reopened, as a failed payment save
    /// does.
    #[tokio::test]
    async fn a_round_whose_save_fails_is_not_recorded() {
        let (runtime, _storage, checkpoints, _handle) = fixture().await;
        sync_fixture(&runtime).await;
        let created = format!("{}:0", "ab".repeat(32));
        checkpoints.fail.store(true, Ordering::SeqCst);
        assert!(runtime
            .record_fusion_round(vec![], vec![created.clone()], 1)
            .await
            .is_err());
        assert_eq!(runtime.fusion_depth().depth_of(&created), 0);
    }

    /// A migrated wallet's host holds, as the desktop's hold file would.
    #[derive(Clone, Default)]
    struct HostHolds {
        holds: std::sync::Arc<std::sync::Mutex<crate::coin_holds::CoinHolds>>,
        asked_for: std::sync::Arc<std::sync::Mutex<Vec<u32>>>,
    }

    impl crate::coin_holds::HostHoldStore for HostHolds {
        fn load(&self, wallet_id: u32) -> Result<crate::coin_holds::CoinHolds, String> {
            self.asked_for.lock().unwrap().push(wallet_id);
            Ok(self.holds.lock().unwrap().clone())
        }
    }

    const LEGACY_ID: u32 = 7;

    /// The fixture wallet, migrated from a host that names it `LEGACY_ID`,
    /// reopened in a fresh runtime with or without that host's hold store.
    async fn migrated(host: Option<HostHolds>) -> (AppRuntime, String) {
        use optn_platform::WalletStorage;
        let (runtime, storage, checkpoints, handle) = fixture().await;
        drop(runtime);
        let original = storage.read(&handle).unwrap();
        let mut file = optn_core::wallet_file::WalletFile::parse(&original).unwrap();
        file.extra
            .insert("legacySourceId".into(), serde_json::json!(LEGACY_ID));
        storage
            .save(&handle, Some(&original), &file.encode().unwrap())
            .unwrap();
        let mut security = crate::wallet_security::WalletSecurity::new(Box::new(storage), None)
            .with_checkpoints(Box::new(checkpoints));
        if let Some(host) = host {
            security = security.with_host_holds(Box::new(host));
        }
        let (runtime, driver) =
            AppRuntime::new_with_security(optn_app::AppState::default(), security).unwrap();
        tokio::spawn(driver.run());
        runtime
            .wallet_security(optn_transport::WalletSecurityRequest::Open {
                handle: handle.clone(),
                password: secret(""),
            })
            .await
            .unwrap();
        sync_fixture(&runtime).await;
        let outpoint = funded_outpoint(&runtime);
        (runtime, outpoint)
    }

    /// Without its host's hold store, a migrated wallet's held coins are
    /// invisible here, so it cannot fuse at all.
    #[tokio::test]
    async fn a_migrated_wallet_without_its_hosts_holds_cannot_fuse() {
        let (runtime, outpoint) = migrated(None).await;
        let refused = runtime.fusion_input_keys(vec![outpoint]).await.unwrap_err();
        assert!(
            matches!(refused, optn_transport::TransportError::Other(ref message) if message.contains("legacy reservations")),
            "{refused:?}"
        );
        assert!(runtime.reserve_change_outputs(1).await.is_err());
    }

    /// With it, a coin held there cannot join a round and an unheld one can.
    #[tokio::test]
    async fn a_migrated_wallet_fuses_only_coins_its_host_does_not_hold() {
        let host = HostHolds::default();
        let (runtime, outpoint) = migrated(Some(host.clone())).await;
        let (txid, vout) = outpoint.split_once(':').unwrap();
        host.holds
            .lock()
            .unwrap()
            .hold(
                &txid.to_uppercase(),
                vout.parse().unwrap(),
                optn_core::coins::FreezeReason::User,
                None,
            )
            .unwrap();
        let refused = runtime
            .fusion_input_keys(vec![outpoint.clone()])
            .await
            .unwrap_err();
        assert!(format!("{refused:?}").contains("is held"), "{refused:?}");
        // The store is asked under the wallet's own legacy id.
        assert!(host
            .asked_for
            .lock()
            .unwrap()
            .iter()
            .all(|id| *id == LEGACY_ID));

        *host.holds.lock().unwrap() = Default::default();
        let keys = runtime.fusion_input_keys(vec![outpoint]).await.unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(runtime.reserve_change_outputs(2).await.unwrap().len(), 2);
    }

    /// A round's holds are its own: another round cannot take the coins, the
    /// host can see them under the wallet's legacy id, and they go the moment
    /// the round lets go -- however it ended.
    #[tokio::test]
    async fn a_round_holds_its_coins_until_it_lets_go() {
        let (runtime, outpoint) = migrated(Some(HostHolds::default())).await;
        let hold = runtime
            .hold_for_fusion(&[outpoint.to_uppercase()])
            .await
            .unwrap();
        assert_eq!(hold.outpoints(), std::slice::from_ref(&outpoint));
        assert!(runtime.fusion_holds(LEGACY_ID).contains(&outpoint));
        assert!(runtime.fusion_holds(LEGACY_ID + 1).is_empty());
        let refused = runtime
            .hold_for_fusion(std::slice::from_ref(&outpoint))
            .await
            .err()
            .unwrap();
        assert!(format!("{refused:?}").contains("already in a fusion round"));
        // Holding does not stop the round itself from getting the keys.
        assert!(runtime
            .fusion_input_keys(vec![outpoint.clone()])
            .await
            .is_ok());

        drop(hold);
        assert!(runtime.fusion_holds(LEGACY_ID).is_empty());
        let again = runtime
            .hold_for_fusion(std::slice::from_ref(&outpoint))
            .await
            .unwrap();
        drop(again);

        // Nonsense, duplicates and empty requests are refused outright.
        for bad in [
            vec!["nonsense".to_string()],
            vec![outpoint.clone(), outpoint.clone()],
            vec![],
        ] {
            assert!(runtime.hold_for_fusion(&bad).await.is_err(), "{bad:?}");
        }
    }

    /// Selection chooses from the runtime's own record: a synced coin is a
    /// candidate, a coin a round holds is frozen, a payment's input is
    /// frozen, and a recorded round's output carries its depth.
    #[tokio::test]
    async fn candidates_come_from_the_runtimes_own_record() {
        let (runtime, _storage, _checkpoints, _handle) = fixture().await;
        assert!(
            runtime.fusion_candidates().is_err(),
            "nothing before a sync"
        );
        sync_fixture(&runtime).await;
        let outpoint = funded_outpoint(&runtime);
        let find = |coins: Vec<optn_core::fusion::coin_selection::FusionCoin>| {
            coins
                .into_iter()
                .find(|coin| coin.outpoint == outpoint)
                .unwrap()
        };
        let coin = find(runtime.fusion_candidates().unwrap());
        assert!(!coin.frozen && !coin.token);
        assert_eq!((coin.value_sats, coin.depth), (20_000, 0));

        let hold = runtime
            .hold_for_fusion(std::slice::from_ref(&outpoint))
            .await
            .unwrap();
        assert!(find(runtime.fusion_candidates().unwrap()).frozen);
        drop(hold);
        assert!(!find(runtime.fusion_candidates().unwrap()).frozen);

        runtime
            .record_fusion_round(vec![], vec![outpoint.clone()], 1)
            .await
            .unwrap();
        assert_eq!(find(runtime.fusion_candidates().unwrap()).depth, 1);

        prepare(&runtime, "held").await.unwrap();
        assert!(find(runtime.fusion_candidates().unwrap()).frozen);
    }

    /// A runtime-managed wallet's rounds hold coins too, under no legacy id.
    #[tokio::test]
    async fn a_runtime_managed_wallets_round_holds_coins_under_no_legacy_id() {
        let (runtime, _storage, _checkpoints, _handle) = fixture().await;
        sync_fixture(&runtime).await;
        let outpoint = funded_outpoint(&runtime);
        let hold = runtime
            .hold_for_fusion(std::slice::from_ref(&outpoint))
            .await
            .unwrap();
        assert!(runtime.fusion_holds(LEGACY_ID).is_empty());
        assert!(runtime
            .hold_for_fusion(std::slice::from_ref(&outpoint))
            .await
            .is_err());
        drop(hold);
    }

    /// A record kept outside the runtime merges in: the deeper entry wins,
    /// and txids are added.
    #[tokio::test]
    async fn an_imported_record_merges_deeper_entries_and_txids() {
        let (runtime, _storage, _checkpoints, _handle) = fixture().await;
        sync_fixture(&runtime).await;
        let first = format!("{}:0", "ab".repeat(32));
        let second = format!("{}:0", "ba".repeat(32));
        let mut outside = FusionDepthBook::new();
        outside.record_round(&[], std::slice::from_ref(&first), 5);
        outside.record_round(
            std::slice::from_ref(&first),
            std::slice::from_ref(&second),
            6,
        );
        outside.record_fusion_txid(&"99".repeat(32));
        runtime
            .import_fusion_depth(
                Some(outside.stored_coins()),
                Some(outside.stored_tx_depth()),
                outside.fusion_txids().map(str::to_owned).collect(),
            )
            .await
            .unwrap();
        let book = runtime.fusion_depth();
        assert_eq!(book.depth_of(&second), 2);
        assert!(book.is_fusion_transaction(&"99".repeat(32)));

        // A shallower copy of the same coin does not lower it.
        let mut shallower = FusionDepthBook::new();
        shallower.record_round(&[], std::slice::from_ref(&second), 7);
        runtime
            .import_fusion_depth(Some(shallower.stored_coins()), None, vec![])
            .await
            .unwrap();
        assert_eq!(runtime.fusion_depth().depth_of(&second), 2);
    }
}
