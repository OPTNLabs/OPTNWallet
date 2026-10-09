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

use crate::{AppRuntime, AppRuntimeDriver, PublicationGuard, RuntimeRequest};
use optn_app::{AppEvent, AuthScope, HdBranch};
use optn_core::{cashaddr::Address, coins::Outpoint};
use optn_transport::TransportError;
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
}

fn failure(error: impl ToString) -> TransportError {
    TransportError::Other(error.to_string())
}

fn display_txid(wire: [u8; 32]) -> String {
    let mut display = wire;
    display.reverse();
    display.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl AppRuntime {
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
            FusionContributionReply::Outputs(_) => Err(failure("Unexpected fusion reply.")),
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
            FusionContributionReply::InputKeys(_) => Err(failure("Unexpected fusion reply.")),
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
        };
        if matches!(result, Err(TransportError::AuthenticationRequired)) {
            self.publish(AppEvent::AppLockChanged);
        }
        self.expire_session();
        let _ = reply.send(result);
    }

    /// The guards both requests share; returns the synchronized account's
    /// public key and its observed last-used indexes.
    fn fusion_preconditions(
        &self,
        operation_guard: &crate::WalletOperationGuard,
        reply_closed: bool,
    ) -> Result<(String, [Option<u32>; 3]), TransportError> {
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
        // A legacy host may hold coins outside the runtime's record, so their
        // absence here proves nothing.
        if security.status(&self.state)?.legacy_source_id.is_some() {
            return Err(failure(
                "This migrated wallet still uses legacy reservations. This needs a runtime-managed wallet.",
            ));
        }
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
        Ok((book.account_xpub.clone(), book.allocation_last_used()))
    }

    fn fusion_input_keys(
        &mut self,
        outpoints: Vec<String>,
        operation_guard: &crate::WalletOperationGuard,
        reply: &oneshot::Sender<Result<FusionContributionReply, TransportError>>,
    ) -> Result<Vec<FusionInputSecret>, TransportError> {
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

    fn reserve_change_outputs(
        &mut self,
        count: usize,
        operation_guard: &crate::WalletOperationGuard,
        reply: &oneshot::Sender<Result<FusionContributionReply, TransportError>>,
    ) -> Result<Vec<Vec<u8>>, TransportError> {
        let (account_xpub, last_used) =
            self.fusion_preconditions(operation_guard, reply.is_closed())?;
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
    use crate::external_payment::tests::{fixture, prepare, sync_fixture};
    use crate::AppRuntime;
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
}
