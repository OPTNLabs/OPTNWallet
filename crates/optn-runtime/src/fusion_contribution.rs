//! A CashFusion round's contribution, prepared inside the runtime.
//!
//! A round needs each offered coin's signing key and a set of fresh output
//! scripts. Both are wallet authority, so both come from here, under the same
//! guards as a payment: a durable session, fresh coins, the synchronized
//! account, and Background authorization. Auto Fusion never prompts; the
//! holder consented when they turned it on, and a prompt mid-round would kill
//! the round.
//!
//! Outputs go to change addresses, as Electron Cash's fusion does
//! (`reserve_change_addresses`). They are reserved durably before any script
//! leaves the runtime, so a round that fails after disclosing them never hands
//! them out again. Change has no BIP44 receive-gap limit, and the runtime scans
//! every allocated index, so a saved wallet always finds the outputs.

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
pub struct FusionContributionRequest {
    /// Display-order `txid:vout` of each coin the round offers.
    pub outpoints: Vec<String>,
    /// Fresh outputs to reserve: the largest plan's output count.
    pub outputs: usize,
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

/// Everything a round needs from the wallet.
#[derive(Debug)]
pub struct FusionContribution {
    pub inputs: Vec<FusionInputSecret>,
    /// Fresh P2PKH scripts, each reserved durably.
    pub output_scripts: Vec<Vec<u8>>,
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
    /// Trusted host API: the coins' keys and reserved outputs for one round.
    pub async fn prepare_fusion_contribution(
        &self,
        request: FusionContributionRequest,
    ) -> Result<FusionContribution, TransportError> {
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
}

impl AppRuntimeDriver {
    pub(super) fn handle_fusion_contribution(
        &mut self,
        request: FusionContributionRequest,
        operation_guard: Box<crate::WalletOperationGuard>,
        reply: oneshot::Sender<Result<FusionContribution, TransportError>>,
    ) {
        if reply.is_closed() {
            return;
        }
        let result = self.apply_fusion_contribution(request, &operation_guard, &reply);
        if matches!(result, Err(TransportError::AuthenticationRequired)) {
            self.publish(AppEvent::AppLockChanged);
        }
        self.expire_session();
        let _ = reply.send(result);
    }

    fn apply_fusion_contribution(
        &mut self,
        request: FusionContributionRequest,
        operation_guard: &crate::WalletOperationGuard,
        reply: &oneshot::Sender<Result<FusionContribution, TransportError>>,
    ) -> Result<FusionContribution, TransportError> {
        let now = self.now_ms();
        let guard = PublicationGuard {
            generation: operation_guard.generation,
            revocation: &self.revocation,
            now_ms: &|| crate::elapsed_ms(self.started),
        };
        if operation_guard.is_revoked()
            || !guard.allows(&self.state, reply.is_closed())
            || self.state.surface.is_viewer_only()
        {
            return Err(failure("Wallet fusion session changed."));
        }
        if request.outpoints.is_empty()
            || request.outpoints.len() > MAX_CONTRIBUTION_ITEMS
            || request.outputs == 0
            || request.outputs > MAX_CONTRIBUTION_ITEMS
        {
            return Err(failure(
                "A fusion contribution needs 1 to 40 coins and 1 to 40 outputs.",
            ));
        }
        let security = self.security.as_ref().ok_or(TransportError::Unsupported)?;
        security.require_durable_session(&self.state)?;
        // A legacy host may hold coins outside the runtime's record, so their
        // absence here proves nothing.
        if security.status(&self.state)?.legacy_source_id.is_some() {
            return Err(failure(
                "This migrated wallet still uses legacy reservations. Fusing from the shared runtime needs a runtime-managed wallet.",
            ));
        }
        if !self.wallet_sync.coins_are_fresh() || self.state.wallet_sync.refreshing {
            return Err(failure("Refresh the wallet before fusing."));
        }

        let mut candidate = self.state.clone();
        crate::external_payment::apply_holds(&mut candidate);
        let (picked, account_xpub, last_used) = {
            let snapshot = self
                .wallet_sync
                .reconciliation()
                .authoritative
                .as_ref()
                .ok_or_else(|| failure("Sync the wallet before fusing."))?;
            let book = snapshot
                .value
                .hd
                .as_ref()
                .ok_or_else(|| failure("Sync the HD account first."))?;
            let opened = candidate
                .wallet
                .as_ref()
                .ok_or(TransportError::AuthenticationRequired)?;
            if opened.multisig_policy.is_some()
                || opened.account_xpub.as_ref() != Some(&book.account_xpub)
                || opened.account_path != book.account.to_string()
            {
                return Err(failure(
                    "Fusion account differs from the synchronized wallet.",
                ));
            }
            // Ordinary HD coins only: token outputs never appear here.
            let coins =
                crate::wallet_spend::snapshot_spendable_coins(&snapshot.value, candidate.network)
                    .map_err(failure)?;
            let mut picked = Vec::with_capacity(request.outpoints.len());
            for wanted in &request.outpoints {
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
                if candidate
                    .coins
                    .get(outpoint)
                    .is_some_and(|known| known.freeze().is_some())
                {
                    return Err(failure(format!(
                        "{wanted} is held and cannot join a fusion."
                    )));
                }
                if picked.iter().any(|(seen, _): &(String, _)| *seen == wanted) {
                    return Err(failure(format!("{wanted} is offered twice.")));
                }
                picked.push((wanted, coin.clone()));
            }
            (
                picked,
                book.account_xpub.clone(),
                book.allocation_last_used(),
            )
        };

        let wallet = security.wallet_for_operation(&mut self.state, AuthScope::Background, now)?;
        candidate.lock = self.state.lock.clone();
        let mut inputs = Vec::with_capacity(picked.len());
        for (_, coin) in &picked {
            let key = wallet.signing_key(&coin.path).map_err(failure)?;
            inputs.push(FusionInputSecret {
                txid: display_txid(coin.utxo.txid),
                vout: coin.utxo.vout,
                value_sats: coin.utxo.value,
                pubkey: wallet.public_key(&coin.path).map_err(failure)?,
                privkey: Zeroizing::new(key.to_bytes().into()),
            });
        }

        let allocation = candidate
            .hd_addresses
            .as_mut()
            .ok_or_else(|| failure("No durable HD allocation."))?;
        let mut output_scripts = Vec::with_capacity(request.outputs);
        for _ in 0..request.outputs {
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
            output_scripts.push(
                Address::decode(&change.address)
                    .map_err(failure)?
                    .script_pubkey(),
            );
        }

        // Saved before any script leaves the runtime.
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
                "Fusion outputs could not be reserved. Reopen the wallet before retrying.",
            ));
        }
        security.checkpoint_published();
        self.publish(event);
        Ok(FusionContribution {
            inputs,
            output_scripts,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_payment::tests::{fixture, sync_fixture};
    use std::sync::atomic::Ordering;

    fn funded_outpoint(runtime: &AppRuntime) -> String {
        let coin = runtime.state().coins.iter().next().cloned().unwrap();
        coin.outpoint().to_string()
    }

    #[tokio::test]
    async fn a_round_gets_its_keys_and_durably_reserved_change() {
        let (runtime, _storage, _checkpoints, _handle) = fixture().await;
        let request = |outpoints: Vec<String>| FusionContributionRequest {
            outpoints,
            outputs: 3,
        };
        // Nothing before the wallet is synchronized.
        assert!(runtime
            .prepare_fusion_contribution(request(vec!["00:0".into()]))
            .await
            .is_err());
        sync_fixture(&runtime).await;
        let outpoint = funded_outpoint(&runtime);
        let before = runtime.state().hd_addresses.unwrap().next_indexes();

        let contribution = runtime
            .prepare_fusion_contribution(request(vec![outpoint.to_uppercase()]))
            .await
            .unwrap();
        assert_eq!(contribution.inputs.len(), 1);
        let input = &contribution.inputs[0];
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
        // Three fresh change outputs, reserved and saved.
        assert_eq!(contribution.output_scripts.len(), 3);
        let after = runtime.state().hd_addresses.unwrap().next_indexes();
        assert_eq!(after[1], before[1] + 3);
        assert_eq!(after[0], before[0]);
        let mut distinct = contribution.output_scripts.clone();
        distinct.dedup();
        assert_eq!(distinct.len(), 3);
        assert!(!format!("{input:?}").contains("privkey: ["));

        // A second round never gets the same outputs.
        let again = runtime
            .prepare_fusion_contribution(request(vec![outpoint.clone()]))
            .await
            .unwrap();
        assert!(again
            .output_scripts
            .iter()
            .all(|script| !contribution.output_scripts.contains(script)));
    }

    #[tokio::test]
    async fn foreign_duplicate_or_held_coins_are_refused() {
        let (runtime, _storage, checkpoints, handle) = fixture().await;
        sync_fixture(&runtime).await;
        let outpoint = funded_outpoint(&runtime);
        let ask = |outpoints: Vec<String>, outputs: usize| {
            runtime.prepare_fusion_contribution(FusionContributionRequest { outpoints, outputs })
        };
        assert!(ask(vec![format!("{}:0", "ab".repeat(32))], 1)
            .await
            .is_err());
        assert!(ask(vec![outpoint.clone(), outpoint.clone()], 1)
            .await
            .is_err());
        assert!(ask(vec![outpoint.clone()], 0).await.is_err());
        assert!(ask(vec![outpoint.clone()], 41).await.is_err());
        assert!(ask(vec![], 1).await.is_err());

        // A failed save reserves nothing.
        let allocation = runtime.state().hd_addresses;
        checkpoints.fail.store(true, Ordering::SeqCst);
        assert!(ask(vec![outpoint.clone()], 1).await.is_err());
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
        assert!(ask(vec![outpoint.clone()], 1).await.is_ok());

        // A payment's held input cannot join.
        crate::external_payment::tests::prepare(&runtime, "held")
            .await
            .unwrap();
        assert!(ask(vec![outpoint], 1).await.is_err());
    }
}
