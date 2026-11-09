//! Wallet-owned planning, signing and durable recovery for external settlement.
//! No x402, HTTP, provider-specific types or renderer code crosses this boundary.
use crate::{AppRuntime, AppRuntimeDriver, PublicationGuard, RuntimeRequest};
use optn_app::{AppEvent, AppState, AuthScope, HdBranch};
use optn_core::{
    cashaddr::Address,
    coins::{FreezeReason, Outpoint},
    payment::{PaymentIntent, PaymentRecord},
    tx,
};
use optn_transport::TransportError;
use std::collections::BTreeSet;
use tokio::sync::oneshot;

pub enum PaymentOperation {
    Prepare {
        intent: PaymentIntent,
        signed_hex: Option<String>,
    },
    /// Mark indeterminate before a signed payment can leave this device.
    Release {
        id: String,
    },
    Response {
        id: String,
        status: u16,
    },
}

fn failure(error: impl ToString) -> TransportError {
    TransportError::Other(error.to_string())
}

/// Reapply reservations after a refresh/reorg, even if an input disappeared in
/// a previous snapshot. An HTTP success is not chain confirmation.
pub(super) fn apply_holds(app: &mut AppState) {
    for input in app.payment_outbox.iter().flat_map(|record| &record.inputs) {
        if let Some((id, index)) = input.rsplit_once(':') {
            if let Ok(index) = index.parse() {
                if let Ok(outpoint) = Outpoint::parse(id, index) {
                    let _ = app.coins.freeze(outpoint, FreezeReason::ExternalPayment);
                }
            }
        }
    }
}

impl AppRuntime {
    /// Trusted host API, deliberately separate from the untrusted add-on protocol.
    pub async fn external_payment(
        &self,
        operation: PaymentOperation,
    ) -> Result<PaymentRecord, TransportError> {
        let (reply, received) = oneshot::channel();
        self.action_tx
            .send(RuntimeRequest::ExternalPayment(
                operation,
                Box::new(self.wallet_operation_guard()),
                reply,
            ))
            .await
            .map_err(|_| TransportError::Closed)?;
        received.await.map_err(|_| TransportError::Closed)?
    }
}

impl AppRuntimeDriver {
    pub(super) fn handle_external_payment(
        &mut self,
        operation: PaymentOperation,
        operation_guard: Box<crate::WalletOperationGuard>,
        reply: oneshot::Sender<Result<PaymentRecord, TransportError>>,
    ) {
        if reply.is_closed() {
            return;
        }
        let result = self.apply_external_payment(operation, &operation_guard, &reply);
        if matches!(result, Err(TransportError::AuthenticationRequired)) {
            self.publish(AppEvent::AppLockChanged);
        }
        self.expire_session();
        let _ = reply.send(result);
    }

    fn apply_external_payment(
        &mut self,
        operation: PaymentOperation,
        operation_guard: &crate::WalletOperationGuard,
        reply: &oneshot::Sender<Result<PaymentRecord, TransportError>>,
    ) -> Result<PaymentRecord, TransportError> {
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
            return Err(failure("Wallet payment session changed."));
        }
        let security = self.security.as_ref().ok_or(TransportError::Unsupported)?;
        security.require_durable_session(&self.state)?;
        // Legacy hosts still own additional live holds outside the sealed runtime
        // record. Until they share this lifecycle, absence of a hold is unprovable.
        if security.status(&self.state)?.legacy_source_id.is_some() {
            return Err(failure("This migrated wallet still uses legacy reservations. Exact payments require a runtime-managed wallet."));
        }
        let mut candidate = self.state.clone();
        let record = match operation {
            PaymentOperation::Prepare { intent, signed_hex } => {
                intent.validate().map_err(failure)?;
                if let Some(existing) = candidate
                    .payment_outbox
                    .iter()
                    .find(|r| r.intent.id == intent.id)
                {
                    if existing.intent != intent
                        || signed_hex
                            .as_ref()
                            .is_some_and(|raw| !existing.raw_hex.eq_ignore_ascii_case(raw))
                    {
                        return Err(failure("Payment id already belongs to a different request. Its transaction was not replaced."));
                    }
                    return Ok(existing.clone());
                }
                if !self.wallet_sync.coins_are_fresh() || candidate.wallet_sync.refreshing {
                    return Err(failure("Refresh the wallet before preparing a payment."));
                }
                if candidate.payment_outbox.len() >= 256 {
                    return Err(failure("Payment outbox is full."));
                }
                let snapshot = self
                    .wallet_sync
                    .reconciliation()
                    .authoritative
                    .as_ref()
                    .ok_or_else(|| failure("Sync the wallet before paying."))?;
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
                        "Payment account differs from the synchronized wallet.",
                    ));
                }
                let destination = Address::decode(&intent.destination).map_err(failure)?;
                if destination.prefix != candidate.network.prefix() {
                    return Err(failure("Payment network mismatch."));
                }
                apply_holds(&mut candidate);
                let held: BTreeSet<String> = candidate
                    .coins
                    .iter()
                    .filter(|coin| coin.freeze().is_some())
                    .map(|coin| coin.outpoint().to_string())
                    .collect();
                let coins = crate::wallet_spend::snapshot_spendable_coins(
                    &snapshot.value,
                    candidate.network,
                )
                .map_err(failure)?;
                let mut parents = Vec::new();
                let prepared = if let Some(raw) = signed_hex {
                    import_native(&candidate, &snapshot.value, &intent, &raw, &held)?
                } else {
                    // Authorization stays inside the actor, before signing. A watch-only
                    // wallet cannot reach this path even after password authentication.
                    let wallet =
                        security.wallet_for_operation(&mut self.state, AuthScope::Spend, now)?;
                    candidate.lock = self.state.lock.clone();
                    let allocation = candidate
                        .hd_addresses
                        .as_mut()
                        .ok_or_else(|| failure("No durable HD allocation."))?;
                    let index = allocation
                        .allocate(HdBranch::Change, book.allocation_last_used(), false)
                        .map_err(failure)?;
                    let change = optn_core::watch_only::address_under_account(
                        candidate.network,
                        &book.account_xpub,
                        1,
                        index,
                    )
                    .map_err(failure)?;
                    crate::wallet_spend::prepare_spend(
                        &wallet,
                        &coins,
                        &crate::wallet_spend::SpendRequest {
                            destination_script: destination.script_pubkey(),
                            amount_sats: intent.amount_sats,
                            fee_per_byte: intent.fee_per_byte,
                            change_script: Address::decode(&change.address)
                                .map_err(failure)?
                                .script_pubkey(),
                            held,
                        },
                    )
                    .map_err(failure)?
                };
                if prepared.fee_sats > intent.max_fee_sats {
                    return Err(failure("Payment exceeds the approved maximum network fee."));
                }
                for input in &prepared.inputs {
                    let (id, _) = input
                        .rsplit_once(':')
                        .ok_or_else(|| failure("Invalid prepared input."))?;
                    let parent = snapshot
                        .value
                        .transactions
                        .iter()
                        .find(|tx| {
                            let mut hash = tx.txid;
                            hash.reverse();
                            optn_core::payment::hex(&hash) == id
                        })
                        .ok_or_else(|| failure("Payment source transaction is unavailable."))?;
                    if !parents.contains(&parent.raw) {
                        parents.push(parent.raw.clone());
                    }
                }
                let record = PaymentRecord {
                    intent,
                    txid: prepared.txid,
                    raw_hex: prepared.raw_hex,
                    inputs: prepared.inputs,
                    parents,
                    fee_sats: prepared.fee_sats,
                    change_sats: prepared.change_sats,
                    released: false,
                    response_status: None,
                };
                candidate.payment_outbox.push(record.clone());
                record
            }
            PaymentOperation::Release { id } => {
                let record = candidate
                    .payment_outbox
                    .iter_mut()
                    .find(|r| r.intent.id == id)
                    .ok_or_else(|| failure("Unknown payment id."))?;
                record.released = true;
                record.clone()
            }
            PaymentOperation::Response { id, status } => {
                if !(100..=599).contains(&status) {
                    return Err(failure("Invalid HTTP status."));
                }
                let record = candidate
                    .payment_outbox
                    .iter_mut()
                    .find(|r| r.intent.id == id)
                    .ok_or_else(|| failure("Unknown payment id."))?;
                if !record.released {
                    return Err(failure("Payment was not submitted."));
                }
                record.response_status = Some(status);
                record.clone()
            }
        };
        optn_core::payment::validate_outbox(&candidate.payment_outbox).map_err(failure)?;
        apply_holds(&mut candidate);
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
                "Payment could not be saved. Reopen the wallet before retrying.",
            ));
        }
        security.checkpoint_published();
        self.publish(event);
        Ok(record)
    }
}

fn import_native(
    state: &AppState,
    snapshot: &crate::sync_worker::WalletNetworkSnapshot,
    intent: &PaymentIntent,
    raw_hex: &str,
    held: &BTreeSet<String>,
) -> Result<crate::wallet_spend::PreparedSpend, TransportError> {
    if raw_hex.len() > 200_000 {
        return Err(failure("Signed transaction is too large."));
    }
    let raw = optn_core::payment::decode_hex(raw_hex).map_err(failure)?;
    let decoded = tx::decode(&raw).map_err(failure)?;
    let destination = Address::decode(&intent.destination)
        .map_err(failure)?
        .script_pubkey();
    let book = snapshot
        .hd
        .as_ref()
        .ok_or_else(|| failure("No synchronized account."))?;
    let owned_scripts = book
        .branches
        .iter()
        .flatten()
        .map(|entry| {
            Address::decode(&entry.address)
                .map(|a| a.script_pubkey())
                .map_err(failure)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut total = 0u64;
    let mut inputs = Vec::new();
    for (wire, index, _) in &decoded.inputs {
        let mut id = *wire;
        id.reverse();
        let outpoint = Outpoint::new(id, *index);
        let coin = state
            .coins
            .get(outpoint)
            .ok_or_else(|| failure("Signed transaction spends an unknown or stale coin."))?;
        if coin.token().is_some()
            || coin.is_rpa()
            || coin.freeze().is_some()
            || held.contains(&outpoint.to_string())
            || inputs.contains(&outpoint.to_string())
        {
            return Err(failure("Signed transaction spends an unavailable coin."));
        }
        total = total
            .checked_add(coin.value_sats())
            .ok_or_else(|| failure("Input amount overflow."))?;
        inputs.push(outpoint.to_string());
    }
    let mut merchant = 0;
    let mut output_total = 0u64;
    let mut change = 0u64;
    for output in &decoded.outputs {
        if output.token.is_some() {
            return Err(failure("Native payment cannot contain CashTokens."));
        }
        if output.script_pubkey == destination {
            if output.value != intent.amount_sats {
                return Err(failure("Signed merchant amount differs from the quote."));
            }
            merchant += 1;
        } else if owned_scripts.contains(&output.script_pubkey) {
            change = change
                .checked_add(output.value)
                .ok_or_else(|| failure("Change overflow."))?;
        } else {
            return Err(failure("Signed transaction contains an unapproved output."));
        }
        output_total = output_total
            .checked_add(output.value)
            .ok_or_else(|| failure("Output overflow."))?;
    }
    let fee = total
        .checked_sub(output_total)
        .ok_or_else(|| failure("Outputs exceed inputs."))?;
    if inputs.is_empty()
        || merchant != 1
        || fee < (raw.len() as u64).saturating_mul(intent.fee_per_byte)
    {
        return Err(failure("Invalid merchant outputs or network fee."));
    }
    let mut id = tx::double_sha256(&raw);
    id.reverse();
    Ok(crate::wallet_spend::PreparedSpend {
        txid: optn_core::payment::hex(&id),
        raw_hex: raw_hex.to_ascii_lowercase(),
        fee_sats: fee,
        change_sats: change,
        input_count: inputs.len(),
        inputs,
        size_bytes: raw.len(),
    })
}

#[cfg(test)]
#[path = "external_payment_tests.rs"]
pub(crate) mod tests;
