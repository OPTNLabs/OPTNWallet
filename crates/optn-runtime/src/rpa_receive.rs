//! Cash Code discovery shared by native hosts. Keys never enter a provider request.
//! Hosts bind publication/persistence to their wallet session; this module returns
//! public observations, not unlock authority or permission to spend.

use crate::{
    chain::{Evidence, ProtocolFamily, SourceId},
    chain_service::{
        ChainPayload, ChainRequest, ChainService, ChainTip, ObservedTransaction, WalletInterest,
    },
    reconciliation::ReconciliationDecision,
    sync_worker::{ProgressiveSyncWorker, RefreshScope},
};
use optn_core::{
    cashaddr::Address,
    hd::{AccountPath, Wallet},
    network::Network,
    rpa,
};
use zeroize::{Zeroize, Zeroizing};

/// Private, native-only scan context. No Debug/Serialize implementation.
pub struct CashcodeScanKeys {
    network: Network,
    scan: Zeroizing<[u8; 32]>,
    spend: Option<Zeroizing<[u8; 32]>>,
    scan_public: [u8; 33],
    spend_public: [u8; 33],
}

impl CashcodeScanKeys {
    /// IPC boundary: take ownership and wipe the received private byte buffer,
    /// including on malformed lengths and invalid public keys.
    pub fn from_scan_bytes(
        network: &str,
        scan: Vec<u8>,
        spend_public: Vec<u8>,
    ) -> Result<Self, String> {
        let scan = Zeroizing::new(scan);
        let network = network.parse::<Network>()?;
        let private: [u8; 32] = scan
            .as_slice()
            .try_into()
            .map_err(|_| "Cash Code scan key must be 32 bytes")?;
        let public: [u8; 33] = spend_public
            .as_slice()
            .try_into()
            .map_err(|_| "Cash Code spend public key must be 33 bytes")?;
        Self::from_scan_key(network, private, public)
    }
    /// For scan-authorized legacy/native wallets. Possession of the scan key
    /// permits detection, not signing; callers retain their existing spend gate.
    pub fn from_scan_key(
        network: Network,
        scan: [u8; 32],
        spend_public: [u8; 33],
    ) -> Result<Self, String> {
        let scan = Zeroizing::new(scan);
        let scan_public = rpa::scan_public_key(&scan).map_err(|e| e.to_string())?;
        rpa::decode(&rpa::encode(
            &scan_public,
            &spend_public,
            network,
            rpa::RPA_PREFIX_BITS,
        ))
        .map_err(|e| e.to_string())?;
        Ok(Self {
            network,
            scan,
            spend: None,
            scan_public,
            spend_public,
        })
    }
    pub fn from_wallet(
        wallet: &Wallet,
        network: Network,
        account: AccountPath,
    ) -> Result<Self, String> {
        if !account.is_scanned_for(network) {
            return Err("Cash Code account does not belong to this network".into());
        }
        let scan_path = rpa::scan_path(account.coin_type(), account.account());
        let spend_path = rpa::spend_path(account.coin_type(), account.account());
        Ok(Self {
            network,
            scan: Zeroizing::new(
                wallet
                    .signing_key(&scan_path)
                    .map_err(|e| e.to_string())?
                    .to_bytes()
                    .into(),
            ),
            spend: Some(Zeroizing::new(
                wallet
                    .signing_key(&spend_path)
                    .map_err(|e| e.to_string())?
                    .to_bytes()
                    .into(),
            )),
            scan_public: wallet.public_key(&scan_path).map_err(|e| e.to_string())?,
            spend_public: wallet.public_key(&spend_path).map_err(|e| e.to_string())?,
        })
    }
}

/// Public spending recipe only. Never persist an ECDH secret or derived key.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CashcodeReceipt {
    pub txid: String,
    pub vout: u32,
    pub address: String,
    pub value_sats: u64,
    pub token: Option<optn_core::token::TokenData>,
    pub prevout_txid: String,
    pub prevout_index: u32,
    pub sender_pubkey_hex: String,
    pub block_height: Option<u32>,
    /// Unspent in the returned observation scope, not an authorization to spend.
    pub unspent: bool,
}

#[derive(Debug, Clone)]
pub struct CashcodeScanResult {
    /// Inclusive floor supplied by the holder, never silently moved to the tip.
    pub from_height: u32,
    pub tip: ChainTip,
    pub source: SourceId,
    pub protocol: ProtocolFamily,
    pub endpoint: Option<crate::chain::Endpoint>,
    pub evidence: Evidence,
    /// BIP37 block discovery does not observe unconfirmed spends or receipts.
    pub includes_mempool: bool,
    pub receipts: Vec<CashcodeReceipt>,
}

/// Signed transaction bytes are public; private derivation stays in core/native memory.
pub struct CashcodeSweep {
    pub raw: Vec<u8>,
    pub txid: [u8; 32],
    pub amount_sats: u64,
    pub fee_sats: u64,
    pub input_count: usize,
}

/// Sweep only non-token, unspent receipts from a freshly completed scan.
/// This native-only helper does not authorize spending or broadcast anything.
pub fn prepare_cashcode_sweep(
    keys: &CashcodeScanKeys,
    scan: &CashcodeScanResult,
    destination: &str,
    fee_rate: u64,
) -> Result<CashcodeSweep, String> {
    use optn_core::tx::{Output, Transaction, Utxo};
    let spend = keys
        .spend
        .as_ref()
        .ok_or("A scan-only Cash Code cannot authorize a spend")?;
    let destination = Address::decode(destination)?;
    if destination.prefix != keys.network.prefix() {
        return Err("Sweep destination belongs to another network".into());
    }
    if fee_rate == 0 {
        return Err("Sweep fee rate must be at least 1 satoshi per byte".into());
    }
    let mut inputs = Vec::new();
    let mut signing = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let mut total = 0u64;
    for receipt in scan
        .receipts
        .iter()
        .filter(|receipt| receipt.unspent && receipt.token.is_none())
    {
        if inputs.len() >= 500 {
            return Err("Cash Code sweep exceeds the 500-input transaction limit".into());
        }
        let point = optn_core::coins::Outpoint::parse(&receipt.txid, receipt.vout)
            .map_err(|e| e.to_string())?;
        if !seen.insert((point.txid(), point.vout())) {
            return Err("Duplicate Cash Code sweep input".into());
        }
        if receipt.sender_pubkey_hex.len() != 66 || !receipt.sender_pubkey_hex.is_ascii() {
            return Err("Invalid Cash Code sender public key".into());
        }
        let mut public = [0u8; 33];
        for (index, byte) in public.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&receipt.sender_pubkey_hex[index * 2..index * 2 + 2], 16)
                .map_err(|_| "Invalid Cash Code sender public key")?;
        }
        signing.push(
            rpa::signing_key_for_receipt(
                &keys.scan,
                spend,
                &receipt.prevout_txid,
                receipt.prevout_index,
                &public,
                &receipt.address,
                keys.network,
            )
            .map_err(|e| e.to_string())?,
        );
        total = total
            .checked_add(receipt.value_sats)
            .ok_or("Cash Code sweep amount overflow")?;
        if total > 2_100_000_000_000_000 {
            return Err("Cash Code sweep exceeds the BCH monetary range".into());
        }
        let mut txid = point.txid();
        txid.reverse();
        inputs.push(Utxo {
            txid,
            vout: receipt.vout,
            value: receipt.value_sats,
            script_pubkey: Address::decode(&receipt.address)?.script_pubkey(),
        });
    }
    if inputs.is_empty() {
        return Err("No unspent, non-token Cash Code receipts to sweep".into());
    }
    let script = destination.script_pubkey();
    let output_bytes = 8 + optn_core::tx::varint(script.len() as u64).len() + script.len();
    // BCHN default relay dust policy (1 sat/byte), independent of the user's
    // transaction fee rate: three times output serialization plus 148 bytes.
    let dust_threshold = 3 * (output_bytes as u64 + 148);
    // Maximum compressed P2PKH DER input length; CompactSize grows at 253 inputs.
    let maximum_bytes = 4
        + optn_core::tx::varint(inputs.len() as u64).len()
        + 149 * inputs.len()
        + 1
        + output_bytes
        + 4;
    let fee = fee_rate
        .checked_mul(maximum_bytes as u64)
        .ok_or("Cash Code sweep fee overflow")?;
    let amount = total
        .checked_sub(fee)
        .filter(|amount| *amount >= dust_threshold)
        .ok_or("Cash Code receipts cannot cover the fee and a non-dust output")?;
    let input_count = inputs.len();
    let raw = Transaction::new(inputs, vec![Output::new(amount, script)])
        .sign(&signing)
        .map_err(|e| e.to_string())?;
    if raw.len() > maximum_bytes {
        return Err("Signed sweep exceeded its reviewed fee size".into());
    }
    Ok(CashcodeSweep {
        txid: optn_core::header_hash::sha256d(&raw),
        raw,
        amount_sats: amount,
        fee_sats: fee,
        input_count,
    })
}

/// Discover through the selected policy and reconcile spends on the SAME route.
/// BIP37's all-match scan already includes spending transactions; never upload
/// derived stealth scripts in a second bloom filter. Fulcrum needs the scripts'
/// full histories because an RPA prefix index only finds incoming candidates.
/// A backend range/byte limit is an error, never a truncated successful result.
pub async fn scan_cashcode(
    service: &mut ChainService,
    worker: &mut ProgressiveSyncWorker,
    keys: &CashcodeScanKeys,
    from_height: u32,
) -> Result<CashcodeScanResult, String> {
    if from_height == 0 {
        return Err("Cash Code discovery requires an explicit nonzero birth height".into());
    }
    let lifetime = service.revocation();
    if let Some(route) = service
        .routes_for_operation(crate::chain_service::ChainOperation::WalletRefresh)
        .into_iter()
        .next()
        .filter(|route| route.protocol == ProtocolFamily::Bip37)
    {
        return scan_bip37(service, worker, keys, from_height, &route).await;
    }
    let prefix =
        rpa::grind_string(&keys.scan_public, rpa::RPA_PREFIX_BITS).map_err(|e| e.to_string())?;
    // This is a dedicated receive pass, not a partial update of an HD wallet.
    worker.restore(Default::default());
    let outcome = worker
        .refresh_with_scope(
            service,
            vec![WalletInterest::rpa_prefix(prefix)?],
            RefreshScope::Complete {
                floor: Some(from_height),
            },
        )
        .await
        .map_err(|e| {
            worker
                .reconciliation()
                .sync
                .degraded_reason
                .clone()
                .unwrap_or_else(|| format!("Cash Code discovery failed: {e:?}"))
        })?;
    if outcome.decision != ReconciliationDecision::Accepted {
        return Err("Cash Code discovery did not complete its requested scope".into());
    }
    let observed = worker
        .reconciliation()
        .authoritative
        .as_ref()
        .ok_or("Cash Code discovery has no snapshot")?;
    let tip = observed
        .value
        .tip
        .clone()
        .ok_or("Cash Code discovery has no chain tip")?;
    if from_height > tip.height {
        return Err("Cash Code birth height is beyond the selected chain tip".into());
    }
    let evidence = observed.evidence.clone();
    let mut transactions = observed.value.transactions.clone();
    let mut receipts = detect(keys, &transactions, &tip)?;
    if outcome.route.protocol != ProtocolFamily::Bip37 && !receipts.is_empty() {
        let mut interests = receipts
            .iter()
            .map(|receipt| {
                Address::decode(&receipt.address)
                    .map(|address| WalletInterest::Script(address.script_pubkey()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        interests.sort();
        interests.dedup();
        let observed = service
            .execute_on_route(
                &outcome.route,
                &ChainRequest::WalletRefresh {
                    interests,
                    from_height: Some(from_height),
                },
            )
            .await
            .map_err(|e| format!("Cash Code spend reconciliation failed: {e}"))?;
        let ChainPayload::WalletRefresh {
            transactions: history,
            tip: history_tip,
        } = observed.value
        else {
            return Err("Cash Code history returned an unexpected payload".into());
        };
        if history_tip.as_ref() != Some(&tip) || observed.chain_tip != Some((tip.height, tip.hash))
        {
            return Err(
                "Chain tip changed during Cash Code discovery; retry the complete pass".into(),
            );
        }
        if crate::reconciliation::evidence_strength(&observed.evidence)
            < crate::reconciliation::evidence_strength(&evidence)
        {
            return Err("Cash Code history has weaker evidence than discovery".into());
        }
        transactions.extend(history);
    }
    reconcile(&mut receipts, &transactions, &tip)?;
    if lifetime.is_revoked() {
        return Err("Cash Code source or privacy policy changed during discovery".into());
    }
    Ok(CashcodeScanResult {
        from_height,
        tip,
        source: outcome.route.source,
        protocol: outcome.route.protocol,
        endpoint: outcome.route.endpoint,
        evidence,
        includes_mempool: outcome.route.protocol != ProtocolFamily::Bip37,
        receipts,
    })
}

async fn scan_bip37(
    service: &mut ChainService,
    worker: &mut ProgressiveSyncWorker,
    keys: &CashcodeScanKeys,
    from_height: u32,
    route: &crate::chain_service::CapabilityRoute,
) -> Result<CashcodeScanResult, String> {
    let lifetime = service.revocation();
    worker
        .prime_headers_on_same_route(service, route)
        .await
        .map_err(|e| format!("Cash Code accepted-header synchronization failed: {e:?}"))?;
    let (height, hash) = worker
        .header_view()
        .and_then(|view| view.tip())
        .ok_or("Cash Code discovery requires an accepted header tip")?;
    let tip = ChainTip { height, hash };
    if from_height > height {
        return Err("Cash Code birth height is beyond the accepted tip".into());
    }
    let mut receipts = std::collections::BTreeMap::new();
    // ponytail: one full block per bounded batch; reuse peer sessions when profiling
    // warrants it. Unrelated chain transactions are discarded after each block.
    for current in from_height..=height {
        let observed = service
            .execute_on_route(
                route,
                &ChainRequest::CashcodeBlockRange {
                    from_height: current,
                    to_height: current,
                },
            )
            .await
            .map_err(|e| format!("Cash Code block {current} was not completely scanned: {e}"))?;
        let ChainPayload::WalletRefresh {
            transactions,
            tip: batch_tip,
        } = observed.value
        else {
            return Err("Cash Code block range returned an unexpected payload".into());
        };
        if batch_tip.as_ref() != Some(&tip)
            || observed.chain_tip != Some((height, hash))
            || transactions
                .iter()
                .any(|tx| tx.block_height != Some(current))
            || lifetime.is_revoked()
        {
            return Err(
                "Cash Code scan source or accepted chain changed; retry the complete pass".into(),
            );
        }
        for mut receipt in detect(keys, &transactions, &tip)? {
            receipt.unspent = true;
            let point = optn_core::coins::Outpoint::parse(&receipt.txid, receipt.vout)
                .map_err(|e| e.to_string())?;
            let mut wire = point.txid();
            wire.reverse();
            receipts.insert((wire, receipt.vout), receipt);
        }
        if receipts.len() > 100_000 {
            return Err("Cash Code receipts exceed the local storage limit".into());
        }
        for transaction in transactions {
            for (txid, vout, _) in optn_core::tx::decode(&transaction.raw)
                .map_err(|e| e.to_string())?
                .inputs
            {
                if let Some(receipt) = receipts.get_mut(&(txid, vout)) {
                    receipt.unspent = false;
                }
            }
        }
    }
    Ok(CashcodeScanResult {
        from_height,
        tip,
        source: route.source.clone(),
        protocol: ProtocolFamily::Bip37,
        endpoint: route.endpoint.clone(),
        // Merkle inclusion is checked by the adapter, but does not establish full
        // transaction validity or mempool absence. Preserve the conservative label.
        evidence: Evidence::ServerAssertion,
        includes_mempool: false,
        receipts: receipts.into_values().collect(),
    })
}

fn validate(transactions: &[ObservedTransaction], tip: &ChainTip) -> Result<(), String> {
    let mut identities = std::collections::BTreeMap::new();
    let mut bytes = 0usize;
    for transaction in transactions {
        bytes = bytes
            .checked_add(transaction.raw.len())
            .ok_or("Cash Code history size overflow")?;
        if bytes > 64 * 1024 * 1024 || transactions.len() > 100_000 {
            return Err("Cash Code history exceeds the local scan limit".into());
        }
        if optn_core::header_hash::sha256d(&transaction.raw) != transaction.txid
            || transaction
                .block_height
                .is_some_and(|height| height == 0 || height > tip.height)
            || identities
                .insert(transaction.txid, transaction.block_height)
                .is_some_and(|prior| prior != transaction.block_height)
        {
            return Err("Invalid transaction identity or height in Cash Code history".into());
        }
    }
    Ok(())
}

fn detect(
    keys: &CashcodeScanKeys,
    transactions: &[ObservedTransaction],
    tip: &ChainTip,
) -> Result<Vec<CashcodeReceipt>, String> {
    validate(transactions, tip)?;
    let mut receipts = std::collections::BTreeMap::new();
    for transaction in transactions {
        let found = rpa::scan_transaction(
            &transaction.raw,
            &keys.scan,
            &keys.spend_public,
            keys.network,
        )
        .map_err(|e| e.to_string())?;
        let outputs = optn_core::tx::decode(&transaction.raw)
            .map_err(|e| e.to_string())?
            .outputs;
        for mut payment in found {
            let controlled = keys
                .spend
                .as_ref()
                .map(|spend| rpa::spending_key_address(spend, &payment.secret, 0, keys.network))
                .transpose();
            payment.secret.zeroize();
            if controlled
                .map_err(|e| e.to_string())?
                .is_some_and(|address| address.encode() != payment.address)
            {
                return Err("Cash Code detection did not reproduce the spending address".into());
            }
            let mut txid = transaction.txid;
            txid.reverse();
            receipts.insert(
                (transaction.txid, payment.output_index),
                CashcodeReceipt {
                    txid: optn_core::coins::Outpoint::new(txid, payment.output_index).txid_hex(),
                    vout: payment.output_index,
                    address: payment.address,
                    value_sats: payment.value,
                    token: outputs[payment.output_index as usize].token.clone(),
                    prevout_txid: payment.prevout_txid,
                    prevout_index: payment.prevout_index,
                    sender_pubkey_hex: payment.sender_pubkey_hex,
                    block_height: transaction.block_height,
                    unspent: false,
                },
            );
        }
    }
    Ok(receipts.into_values().collect())
}

fn reconcile(
    receipts: &mut [CashcodeReceipt],
    transactions: &[ObservedTransaction],
    tip: &ChainTip,
) -> Result<(), String> {
    validate(transactions, tip)?;
    let scripts = receipts
        .iter()
        .map(|receipt| Address::decode(&receipt.address).map(|address| address.script_pubkey()))
        .collect::<Result<Vec<_>, _>>()?;
    let outputs =
        optn_core::tx::unspent_outputs(transactions.iter().map(|tx| tx.raw.as_slice()), &scripts)
            .map_err(|e| e.to_string())?;
    let unspent = outputs
        .into_iter()
        .map(|output| {
            let mut txid = output.txid;
            txid.reverse();
            (
                optn_core::coins::Outpoint::new(txid, output.vout).txid_hex(),
                output.vout,
            )
        })
        .collect::<std::collections::BTreeSet<_>>();
    for receipt in receipts {
        receipt.unspent = unspent.contains(&(receipt.txid.clone(), receipt.vout));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::{
        Capability, CapabilityConfidence, CapabilityDiscovery, CapabilitySet, ChainSource,
        ConnectionPolicy, Endpoint, EndpointKind, ProviderHealth, SourceCatalog, SourceDisposition,
        SourceOrigin,
    };
    use crate::chain_service::{
        BackendObservation, ChainBackend, ChainBackendError, ChainFuture, ChainOperation,
    };
    use optn_core::{
        hd::BIP39_TEST_VECTOR_MNEMONIC,
        tx::{Output, Transaction, Utxo},
    };
    use std::sync::{Arc, Mutex};

    fn fixture() -> (
        CashcodeScanKeys,
        ObservedTransaction,
        ObservedTransaction,
        ChainTip,
    ) {
        fixture_with_token(true)
    }

    fn fixture_with_token(
        with_token: bool,
    ) -> (
        CashcodeScanKeys,
        ObservedTransaction,
        ObservedTransaction,
        ChainTip,
    ) {
        let wallet = Wallet::from_mnemonic(BIP39_TEST_VECTOR_MNEMONIC, "TREZOR").unwrap();
        let keys = CashcodeScanKeys::from_wallet(
            &wallet,
            Network::Chipnet,
            AccountPath::default_for(Network::Chipnet),
        )
        .unwrap();
        let sender = wallet.signing_key("m/44'/1'/0'/0/4").unwrap();
        let parent = optn_core::coins::Outpoint::new([9; 32], 2);
        let secret = rpa::shared_secret(
            &sender.to_bytes().into(),
            &keys.scan_public,
            &parent.txid_hex(),
            parent.vout(),
        )
        .unwrap();
        let address =
            rpa::payment_address(&keys.spend_public, &secret, Network::Chipnet, 0).unwrap();
        let token = optn_core::token::TokenData::fungible([3; 32], 9)
            .encode_prefix()
            .unwrap();
        let raw = Transaction::new(
            vec![Utxo {
                txid: parent.txid(),
                vout: parent.vout(),
                value: 7000,
                script_pubkey: vec![0x51],
            }],
            vec![if with_token {
                Output::with_tokens(6000, address.script_pubkey(), token)
            } else {
                Output::new(6000, address.script_pubkey())
            }],
        )
        .sign(std::slice::from_ref(&sender))
        .unwrap();
        let txid = optn_core::header_hash::sha256d(&raw);
        // Projection fixture, not a consensus-valid token transfer or live spend.
        let spend = Transaction::new(
            vec![Utxo {
                txid,
                vout: 0,
                value: 6000,
                script_pubkey: address.script_pubkey(),
            }],
            vec![Output::new(5000, vec![0x51])],
        )
        .sign(&[sender])
        .unwrap();
        (
            keys,
            ObservedTransaction {
                txid,
                raw,
                block_height: Some(10),
            },
            ObservedTransaction {
                txid: optn_core::header_hash::sha256d(&spend),
                raw: spend,
                block_height: None,
            },
            ChainTip {
                height: 11,
                hash: [1; 32],
            },
        )
    }

    #[test]
    fn receipt_survives_token_detection_and_mempool_spend_is_not_unspent() {
        let (keys, incoming, spend, tip) = fixture();
        let mut receipts = detect(&keys, &[incoming.clone(), incoming.clone()], &tip).unwrap();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].token.as_ref().unwrap().amount, 9);
        reconcile(&mut receipts, std::slice::from_ref(&incoming), &tip).unwrap();
        assert!(receipts[0].unspent);
        reconcile(&mut receipts, &[incoming, spend], &tip).unwrap();
        assert!(!receipts[0].unspent);
        let public = serde_json::to_value(&receipts[0]).unwrap();
        assert!(public.get("secret").is_none());
        assert!(public.get("scan").is_none());
    }

    #[test]
    fn sweep_signs_owned_bch_receipts_and_excludes_tokens_and_spent_receipts() {
        let (keys, incoming, _, tip) = fixture_with_token(false);
        let mut receipts = detect(&keys, std::slice::from_ref(&incoming), &tip).unwrap();
        reconcile(&mut receipts, std::slice::from_ref(&incoming), &tip).unwrap();
        let (_, token, _, _) = fixture();
        let mut token_receipts = detect(&keys, &[token], &tip).unwrap();
        token_receipts[0].unspent = true;
        receipts.extend(token_receipts);
        let mut scan = CashcodeScanResult {
            from_height: 8,
            tip: tip.clone(),
            source: SourceId::new("fixture"),
            protocol: ProtocolFamily::Electrum,
            endpoint: None,
            evidence: Evidence::ServerAssertion,
            includes_mempool: true,
            receipts,
        };
        let destination = Address::from_hash(
            Network::Chipnet.prefix(),
            optn_core::cashaddr::AddressKind::P2pkh,
            [7; 20],
        )
        .encode();
        let signed = prepare_cashcode_sweep(&keys, &scan, &destination, 1).unwrap();
        let decoded = optn_core::tx::decode(&signed.raw).unwrap();
        assert_eq!(signed.input_count, 1);
        assert_eq!(decoded.inputs.len(), 1);
        assert_eq!(decoded.outputs.len(), 1);
        assert_eq!(decoded.outputs[0].value + signed.fee_sats, 6000);
        assert_eq!(
            decoded.outputs[0].script_pubkey,
            Address::decode(&destination).unwrap().script_pubkey()
        );
        let spent = ObservedTransaction {
            txid: signed.txid,
            raw: signed.raw,
            block_height: None,
        };
        let mut remaining = scan.receipts[..1].to_vec();
        reconcile(&mut remaining, &[incoming, spent], &tip).unwrap();
        assert!(!remaining[0].unspent);
        assert!(prepare_cashcode_sweep(&keys, &scan, &destination, u64::MAX).is_err());
        assert!(prepare_cashcode_sweep(&keys, &scan, &destination, 0).is_err());
        let scan_only =
            CashcodeScanKeys::from_scan_key(Network::Chipnet, *keys.scan, keys.spend_public)
                .unwrap();
        assert!(prepare_cashcode_sweep(&scan_only, &scan, &destination, 1).is_err());
        let p2sh = Address::from_hash(
            Network::Chipnet.prefix(),
            optn_core::cashaddr::AddressKind::P2sh,
            [8; 20],
        )
        .encode();
        scan.receipts[0].value_sats = 731; // 191-byte fee plus 540-sat P2SH20 dust.
        assert_eq!(
            prepare_cashcode_sweep(&keys, &scan, &p2sh, 1)
                .unwrap()
                .amount_sats,
            540
        );
        scan.receipts[0].value_sats = 730;
        assert!(prepare_cashcode_sweep(&keys, &scan, &p2sh, 1).is_err());
        let mut payload = vec![0x0b]; // Address currently rejects P2SH32, before signing.
        payload.extend_from_slice(&[8; 32]);
        let p2sh32 = optn_core::cashaddr::encode_payload(Network::Chipnet.prefix(), &payload);
        assert!(prepare_cashcode_sweep(&keys, &scan, &p2sh32, 1).is_err());
        scan.receipts[0].prevout_index += 1;
        assert!(prepare_cashcode_sweep(&keys, &scan, &destination, 1).is_err());
        scan.receipts[0].unspent = false;
        assert!(prepare_cashcode_sweep(&keys, &scan, &destination, 1).is_err());
    }

    #[test]
    fn rejects_wrong_identity_height_and_private_key_without_receipts() {
        let (keys, mut incoming, _, tip) = fixture();
        incoming.txid[0] ^= 1;
        assert!(detect(&keys, &[incoming.clone()], &tip).is_err());
        incoming.txid[0] ^= 1;
        incoming.block_height = Some(12);
        assert!(detect(&keys, &[incoming], &tip).is_err());
        assert!(
            CashcodeScanKeys::from_scan_key(Network::Chipnet, [0; 32], keys.spend_public).is_err()
        );
        assert!(CashcodeScanKeys::from_scan_key(Network::Chipnet, *keys.scan, [0; 33]).is_err());
    }

    struct Backend {
        protocol: ProtocolFamily,
        id: SourceId,
        endpoint: Endpoint,
        caps: CapabilitySet,
        incoming: ObservedTransaction,
        spend: ObservedTransaction,
        tip: ChainTip,
        fail_history: bool,
        requests: Arc<Mutex<Vec<ChainRequest>>>,
    }
    impl ChainBackend for Backend {
        fn source_id(&self) -> &SourceId {
            &self.id
        }
        fn protocol(&self) -> ProtocolFamily {
            self.protocol
        }
        fn endpoint(&self) -> Option<&Endpoint> {
            Some(&self.endpoint)
        }
        fn capabilities(&self) -> &CapabilitySet {
            &self.caps
        }
        fn health(&self) -> ProviderHealth {
            ProviderHealth::Healthy
        }
        fn supports(&self, operation: ChainOperation) -> bool {
            matches!(
                operation,
                ChainOperation::WalletRefresh | ChainOperation::HeaderSync
            )
        }
        fn execute<'a>(&'a self, request: &'a ChainRequest) -> ChainFuture<'a, BackendObservation> {
            Box::pin(async move {
                self.requests.lock().unwrap().push(request.clone());
                if let ChainRequest::HeaderSync { start_height, .. } = request {
                    return Ok(BackendObservation {
                        payload: ChainPayload::Headers {
                            start_height: *start_height,
                            headers: vec![],
                        },
                        evidence: Evidence::ServerAssertion,
                        chain_tip: None,
                    });
                }
                if let ChainRequest::CashcodeBlockRange {
                    from_height,
                    to_height,
                } = request
                {
                    assert_eq!(from_height, to_height);
                    if self.fail_history && *from_height == 146 {
                        return Err(ChainBackendError::Timeout);
                    }
                    return Ok(BackendObservation {
                        payload: ChainPayload::WalletRefresh {
                            transactions: [&self.incoming, &self.spend]
                                .into_iter()
                                .filter(|tx| tx.block_height == Some(*from_height))
                                .cloned()
                                .collect(),
                            tip: Some(self.tip.clone()),
                        },
                        evidence: Evidence::ServerAssertion,
                        chain_tip: Some((self.tip.height, self.tip.hash)),
                    });
                }
                let ChainRequest::WalletRefresh { interests, .. } = request else {
                    return Err(ChainBackendError::Unsupported);
                };
                let discovering = interests
                    .iter()
                    .any(|interest| matches!(interest, WalletInterest::RpaPrefix(_)));
                if !discovering && self.fail_history {
                    return Err(ChainBackendError::Timeout);
                }
                Ok(BackendObservation {
                    payload: ChainPayload::WalletRefresh {
                        transactions: if discovering {
                            vec![self.incoming.clone()]
                        } else {
                            vec![self.incoming.clone(), self.spend.clone()]
                        },
                        tip: Some(self.tip.clone()),
                    },
                    evidence: Evidence::ServerAssertion,
                    chain_tip: Some((self.tip.height, self.tip.hash)),
                })
            })
        }
    }

    #[tokio::test]
    async fn fulcrum_requires_same_route_spend_history_before_reporting_success() {
        for fail_history in [false, true] {
            let (keys, incoming, spend, tip) = fixture();
            let keys =
                CashcodeScanKeys::from_scan_key(Network::Chipnet, *keys.scan, keys.spend_public)
                    .unwrap();
            let id = SourceId::new("chosen-server");
            let endpoint = Endpoint {
                kind: EndpointKind::ElectrumTcp,
                host: "fixture.invalid".into(),
                port: Some(50001),
            };
            let mut catalog = SourceCatalog::default();
            catalog
                .insert(ChainSource {
                    id: id.clone(),
                    label: "fixture".into(),
                    origin: SourceOrigin::UserAdded,
                    endpoints: vec![endpoint.clone()],
                    capabilities: Default::default(),
                    disposition: SourceDisposition::Enabled,
                    priority: 0,
                })
                .unwrap();
            let mut caps = CapabilitySet::default();
            caps.record(
                Capability::UtxoQuery,
                CapabilityConfidence::Verified,
                CapabilityDiscovery::ActiveProbe,
            );
            let requests = Arc::new(Mutex::new(Vec::new()));
            let mut service = ChainService::new(
                catalog,
                ConnectionPolicy::exact(id.clone(), ProtocolFamily::Electrum),
            );
            service.register(Arc::new(Backend {
                protocol: ProtocolFamily::Electrum,
                id,
                endpoint,
                caps,
                incoming,
                spend,
                tip,
                fail_history,
                requests: requests.clone(),
            }));
            let mut worker = ProgressiveSyncWorker::new(Default::default());
            let result = scan_cashcode(&mut service, &mut worker, &keys, 8).await;
            if fail_history {
                assert!(result.is_err());
            } else {
                let result = result.unwrap();
                assert_eq!(result.receipts.len(), 1);
                assert!(!result.receipts[0].unspent);
                assert_eq!(result.from_height, 8);
            }
            let requests = requests.lock().unwrap();
            assert_eq!(requests.len(), 2);
            assert!(
                matches!(&requests[0], ChainRequest::WalletRefresh { interests, from_height: Some(8) } if matches!(&interests[0], WalletInterest::RpaPrefix(_)))
            );
            assert!(
                matches!(&requests[1], ChainRequest::WalletRefresh { interests, from_height: Some(8) } if matches!(&interests[0], WalletInterest::Script(_)))
            );
        }
    }

    #[tokio::test]
    async fn bip37_streams_beyond_144_blocks_and_never_publishes_partial_receipts() {
        use crate::chain::{BlockHeaderBytes, HeaderVerifier};
        for fail_history in [false, true] {
            let (keys, mut incoming, mut spend, _) = fixture();
            incoming.block_height = Some(145);
            spend.block_height = Some(146);
            let (mut verifier, headers) = crate::sync_worker::tests::header_fixture_to(146);
            verifier
                .extend(
                    &headers
                        .into_iter()
                        .map(BlockHeaderBytes)
                        .collect::<Vec<_>>(),
                )
                .unwrap();
            let tip = ChainTip {
                height: 146,
                hash: verifier.last_hash().unwrap(),
            };
            let id = SourceId::new("chosen-node");
            let endpoint = Endpoint {
                kind: EndpointKind::BchP2p,
                host: "fixture.invalid".into(),
                port: Some(48333),
            };
            let mut catalog = SourceCatalog::default();
            catalog
                .insert(ChainSource {
                    id: id.clone(),
                    label: "fixture".into(),
                    origin: SourceOrigin::UserAdded,
                    endpoints: vec![endpoint.clone()],
                    capabilities: Default::default(),
                    disposition: SourceDisposition::Enabled,
                    priority: 0,
                })
                .unwrap();
            let mut caps = CapabilitySet::default();
            for capability in [Capability::UtxoQuery, Capability::HeaderStream] {
                caps.record(
                    capability,
                    CapabilityConfidence::Verified,
                    CapabilityDiscovery::ActiveProbe,
                );
            }
            let requests = Arc::new(Mutex::new(Vec::new()));
            let mut service = ChainService::new(
                catalog,
                ConnectionPolicy::exact(id.clone(), ProtocolFamily::Bip37),
            );
            service.register(Arc::new(Backend {
                protocol: ProtocolFamily::Bip37,
                id,
                endpoint,
                caps,
                incoming,
                spend,
                tip,
                fail_history,
                requests: requests.clone(),
            }));
            let mut worker = ProgressiveSyncWorker::new(Default::default())
                .with_header_verifier(Network::Chipnet, verifier)
                .unwrap();
            let result = scan_cashcode(&mut service, &mut worker, &keys, 1).await;
            if fail_history {
                assert!(result.is_err());
            } else {
                let result = result.unwrap();
                assert_eq!(result.receipts.len(), 1);
                assert!(!result.receipts[0].unspent);
                assert!(!result.includes_mempool);
                assert_eq!(result.tip.height, 146);
            }
            let requests = requests.lock().unwrap();
            let ranges = requests
                .iter()
                .filter_map(|request| match request {
                    ChainRequest::CashcodeBlockRange {
                        from_height,
                        to_height,
                    } => Some((*from_height, *to_height)),
                    ChainRequest::HeaderSync { .. } => None,
                    _ => panic!("Cash Code keys/scripts/prefixes must never enter node requests"),
                })
                .collect::<Vec<_>>();
            assert_eq!(
                ranges,
                (1..=146).map(|height| (height, height)).collect::<Vec<_>>()
            );
        }
    }
}
