//! Durable externally submitted payment identity. Transport protocols stay in adapters.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentIntent {
    /// Caller-generated operation id. Retrying this id must reuse the same bytes.
    pub id: String,
    /// Digest of the resource request and the exact accepted merchant quote.
    pub binding: [u8; 32],
    pub destination: String,
    pub amount_sats: u64,
    pub fee_per_byte: u64,
    pub max_fee_sats: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentRecord {
    pub intent: PaymentIntent,
    pub txid: String,
    pub raw_hex: String,
    pub inputs: Vec<String>,
    /// Authenticated parent bytes retained for SDK verification on an exact retry.
    pub parents: Vec<Vec<u8>>,
    pub fee_sats: u64,
    pub change_sats: u64,
    /// Persisted before giving a signed transaction to an external settlement service.
    /// True means it may have been broadcast, even if no HTTP response arrived.
    pub released: bool,
    pub response_status: Option<u16>,
}

impl PaymentIntent {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 128
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            return Err(
                "payment id must contain 1-128 letters, digits, dashes, dots or underscores".into(),
            );
        }
        if self.destination.len() > 256
            || self.amount_sats == 0
            || self.fee_per_byte == 0
            || self.fee_per_byte > 10_000
            || self.max_fee_sats == 0
        {
            return Err("invalid payment amount, address or fee limits".into());
        }
        Ok(())
    }
}

pub fn validate_outbox(records: &[PaymentRecord]) -> Result<(), String> {
    if records.len() > 256 {
        return Err("payment outbox is full".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    let mut reserved = std::collections::BTreeSet::new();
    let mut bytes = 0usize;
    for record in records {
        record.intent.validate()?;
        bytes = bytes
            .saturating_add(record.raw_hex.len())
            .saturating_add(record.parents.iter().map(Vec::len).sum::<usize>());
        if !ids.insert(&record.intent.id)
            || record.raw_hex.len() > 200_000
            || record.inputs.is_empty()
            || record.inputs.len() > 1_000
            || record.parents.len() > 1_000
            || record.fee_sats > record.intent.max_fee_sats
            || record
                .response_status
                .is_some_and(|s| !(100..=599).contains(&s))
        {
            return Err("invalid payment outbox record".into());
        }
        let raw = decode_hex(&record.raw_hex)?;
        let decoded = crate::tx::decode(&raw).map_err(|e| e.to_string())?;
        let mut txid = crate::tx::double_sha256(&raw);
        txid.reverse();
        if hex(&txid) != record.txid {
            return Err("payment transaction id mismatch".into());
        }
        let inputs: Vec<String> = decoded
            .inputs
            .iter()
            .map(|(id, index, _)| {
                let mut id = *id;
                id.reverse();
                format!("{}:{index}", hex(&id))
            })
            .collect();
        if inputs != record.inputs {
            return Err("payment input reservation mismatch".into());
        }
        if record.inputs.iter().any(|input| !reserved.insert(input)) {
            return Err("overlapping payment reservations".into());
        }
        for parent in &record.parents {
            if parent.len() > 100_000 {
                return Err("payment parent is too large".into());
            }
            crate::tx::decode(parent).map_err(|e| e.to_string())?;
        }
        validate_native_record(record)?;
    }
    if bytes > 8 * 1024 * 1024 {
        return Err("payment outbox exceeds storage limit".into());
    }
    Ok(())
}

pub fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) {
        return Err("invalid transaction hex".into());
    }
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let digit = |b: u8| {
                (b as char)
                    .to_digit(16)
                    .map(|n| n as u8)
                    .ok_or("invalid transaction hex".to_string())
            };
            Ok((digit(pair[0])? << 4) | digit(pair[1])?)
        })
        .collect()
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut text, b| {
            let _ = write!(text, "{b:02x}");
            text
        })
}

/// Verify the exact native P2PKH bytes independently of the transport adapter.
/// Only ALL|FORKID is admitted; every output and every input is committed.
fn validate_native_record(record: &PaymentRecord) -> Result<(), String> {
    use crate::tx::{self, Output, Transaction, Utxo};
    let bad = || "invalid signed native payment".to_owned();
    let raw = decode_hex(&record.raw_hex)?;
    let (decoded, scripts) = tx::decode_with_input_scripts(&raw).map_err(|e| e.to_string())?;
    let parents: std::collections::BTreeMap<_, _> = record
        .parents
        .iter()
        .map(|raw| {
            Ok((
                tx::double_sha256(raw),
                tx::decode(raw).map_err(|e| e.to_string())?,
            ))
        })
        .collect::<Result<_, String>>()?;
    let mut inputs = Vec::new();
    for (id, vout, _) in &decoded.inputs {
        let output = parents
            .get(id)
            .and_then(|p| p.outputs.get(*vout as usize))
            .ok_or_else(bad)?;
        if output.token.is_some() {
            return Err(bad());
        }
        inputs.push(Utxo {
            txid: *id,
            vout: *vout,
            value: output.value,
            script_pubkey: output.script_pubkey.clone(),
        });
    }
    let mut output_total = 0u64;
    let merchant = crate::cashaddr::Address::decode(&record.intent.destination)?.script_pubkey();
    let mut merchant_count = 0;
    let mut change = 0u64;
    for output in &decoded.outputs {
        if output.token.is_some() {
            return Err(bad());
        }
        output_total = output_total.checked_add(output.value).ok_or_else(bad)?;
        if output.script_pubkey == merchant {
            merchant_count += 1;
            if output.value != record.intent.amount_sats {
                return Err(bad());
            }
        } else {
            change = change.checked_add(output.value).ok_or_else(bad)?;
        }
    }
    let total = inputs
        .iter()
        .try_fold(0u64, |sum, input| sum.checked_add(input.value))
        .ok_or_else(bad)?;
    if merchant_count != 1
        || total.checked_sub(output_total) != Some(record.fee_sats)
        || change != record.change_sats
        || record.fee_sats < (raw.len() as u64).saturating_mul(record.intent.fee_per_byte)
        || (record.response_status.is_some() && !record.released)
    {
        return Err(bad());
    }
    let sequences = decoded
        .inputs
        .iter()
        .map(|input| input.2)
        .collect::<Vec<_>>();
    let transaction = Transaction {
        version: decoded.version,
        inputs,
        outputs: decoded
            .outputs
            .into_iter()
            .map(|o| Output::new(o.value, o.script_pubkey))
            .collect(),
        locktime: decoded.locktime,
        sequence: u32::MAX,
    };
    for (index, script) in scripts.iter().enumerate() {
        let size = usize::from(*script.first().ok_or_else(bad)?);
        if !(9..=73).contains(&size) || script.len() != size + 35 || script[size + 1] != 33 {
            return Err(bad());
        }
        let signature = &script[1..=size];
        let key = &script[size + 2..];
        let source = &transaction.inputs[index].script_pubkey;
        if source.len() != 25
            || source[..3] != [0x76, 0xa9, 0x14]
            || source[23..] != [0x88, 0xac]
            || source[3..23] != crate::hd::hash160(key)
        {
            return Err(bad());
        }
        let digest = tx::double_sha256(
            &transaction
                .sighash_preimage_with_sequences(index, &sequences)
                .map_err(|e| e.to_string())?,
        );
        let verified =
            tx::verified_p2pkh_script_sig(key, signature, &digest).map_err(|e| e.to_string())?;
        if verified != *script {
            return Err(bad());
        }
    }
    Ok(())
}
