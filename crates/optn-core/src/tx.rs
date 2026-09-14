//! Transaction construction, BCH sighash, and P2PKH signing.
//!
//! Bitcoin Cash uses the BIP143 sighash algorithm with a mandatory `FORKID`
//! bit, so the preimage commits to the input's value — a replay of a BTC-style
//! signature cannot spend a BCH output and vice versa. Getting the preimage
//! wrong does not produce an error here; it produces a signature the network
//! rejects at broadcast, which is why the preimage layout is asserted directly
//! in the tests rather than only end-to-end.

use k256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use crate::error::{CliError, Result};

/// SIGHASH_ALL | SIGHASH_FORKID. FORKID is mandatory on BCH.
pub const SIGHASH_ALL_FORKID: u32 = 0x41;

/// A P2PKH output being spent.
#[derive(Debug, Clone)]
pub struct Utxo {
    pub txid: [u8; 32],
    pub vout: u32,
    pub value: u64,
    /// The output script this UTXO pays to.
    pub script_pubkey: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct Output {
    pub value: u64,
    pub script_pubkey: Vec<u8>,
    /// CashTokens prefix, when this output carries tokens.
    ///
    /// The prefix precedes the locking script on the wire and is length-counted
    /// with it, so it must be included wherever the script is serialised — the
    /// output itself and the sighash's hashOutputs alike. Committing to one but
    /// not the other produces a signature the network rejects.
    pub token_prefix: Option<Vec<u8>>,
}

impl Output {
    pub fn new(value: u64, script_pubkey: Vec<u8>) -> Self {
        Output {
            value,
            script_pubkey,
            token_prefix: None,
        }
    }

    pub fn with_tokens(value: u64, script_pubkey: Vec<u8>, token_prefix: Vec<u8>) -> Self {
        Output {
            value,
            script_pubkey,
            token_prefix: Some(token_prefix),
        }
    }

    /// Prefix and locking script as one length-counted field.
    fn locking_field(&self) -> Vec<u8> {
        match &self.token_prefix {
            Some(prefix) => {
                let mut v = Vec::with_capacity(prefix.len() + self.script_pubkey.len());
                v.extend_from_slice(prefix);
                v.extend_from_slice(&self.script_pubkey);
                v
            }
            None => self.script_pubkey.clone(),
        }
    }
}

pub fn double_sha256(bytes: &[u8]) -> [u8; 32] {
    let first = Sha256::digest(bytes);
    let second = Sha256::digest(first);
    let mut out = [0u8; 32];
    out.copy_from_slice(&second);
    out
}

/// Bitcoin's variable-length integer.
pub fn varint(n: u64) -> Vec<u8> {
    match n {
        0..=0xfc => vec![n as u8],
        0xfd..=0xffff => {
            let mut v = vec![0xfd];
            v.extend_from_slice(&(n as u16).to_le_bytes());
            v
        }
        0x1_0000..=0xffff_ffff => {
            let mut v = vec![0xfe];
            v.extend_from_slice(&(n as u32).to_le_bytes());
            v
        }
        _ => {
            let mut v = vec![0xff];
            v.extend_from_slice(&n.to_le_bytes());
            v
        }
    }
}

fn push_data(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 5);
    match data.len() {
        0..=75 => out.push(data.len() as u8),
        76..=255 => {
            out.push(0x4c);
            out.push(data.len() as u8);
        }
        _ => {
            out.push(0x4d);
            out.extend_from_slice(&(data.len() as u16).to_le_bytes());
        }
    }
    out.extend_from_slice(data);
    out
}

/// An unsigned transaction, plus the values it spends.
#[derive(Debug, Clone)]
pub struct Transaction {
    pub version: u32,
    pub inputs: Vec<Utxo>,
    pub outputs: Vec<Output>,
    pub locktime: u32,
    /// Per-input `nSequence`. `0xffffffff` disables locktime.
    pub sequence: u32,
}

impl Transaction {
    pub fn new(inputs: Vec<Utxo>, outputs: Vec<Output>) -> Self {
        Transaction {
            version: 2,
            inputs,
            outputs,
            locktime: 0,
            sequence: 0xffff_ffff,
        }
    }

    fn hash_prevouts(&self) -> [u8; 32] {
        let mut buf = Vec::with_capacity(self.inputs.len() * 36);
        for i in &self.inputs {
            buf.extend_from_slice(&i.txid);
            buf.extend_from_slice(&i.vout.to_le_bytes());
        }
        double_sha256(&buf)
    }

    fn hash_sequence(&self) -> [u8; 32] {
        let mut buf = Vec::with_capacity(self.inputs.len() * 4);
        for _ in &self.inputs {
            buf.extend_from_slice(&self.sequence.to_le_bytes());
        }
        double_sha256(&buf)
    }

    fn hash_outputs(&self) -> [u8; 32] {
        let mut buf = Vec::new();
        for o in &self.outputs {
            let field = o.locking_field();
            buf.extend_from_slice(&o.value.to_le_bytes());
            buf.extend_from_slice(&varint(field.len() as u64));
            buf.extend_from_slice(&field);
        }
        double_sha256(&buf)
    }

    /// The BIP143 preimage for one input.
    ///
    /// `scriptCode` is the UTXO's own output script for P2PKH.
    pub fn sighash_preimage(&self, index: usize) -> Result<Vec<u8>> {
        let input = self
            .inputs
            .get(index)
            .ok_or_else(|| CliError::Internal(format!("no input at index {index}")))?;

        let mut p = Vec::with_capacity(256);
        p.extend_from_slice(&self.version.to_le_bytes());
        p.extend_from_slice(&self.hash_prevouts());
        p.extend_from_slice(&self.hash_sequence());
        p.extend_from_slice(&input.txid);
        p.extend_from_slice(&input.vout.to_le_bytes());
        p.extend_from_slice(&varint(input.script_pubkey.len() as u64));
        p.extend_from_slice(&input.script_pubkey);
        p.extend_from_slice(&input.value.to_le_bytes());
        p.extend_from_slice(&self.sequence.to_le_bytes());
        p.extend_from_slice(&self.hash_outputs());
        p.extend_from_slice(&self.locktime.to_le_bytes());
        p.extend_from_slice(&SIGHASH_ALL_FORKID.to_le_bytes());
        Ok(p)
    }

    pub fn sighash(&self, index: usize) -> Result<[u8; 32]> {
        Ok(double_sha256(&self.sighash_preimage(index)?))
    }

    /// Sign every input with its key and serialise the result.
    ///
    /// `keys[i]` must be the key controlling `inputs[i]`.
    pub fn sign(&self, keys: &[SigningKey]) -> Result<Vec<u8>> {
        Ok(self.sign_detailed(keys)?.0)
    }

    /// Sign, returning the raw transaction *and* each input's scriptSig.
    ///
    /// RPA grinds `hash256` of input 0's wire serialization until it matches
    /// the recipient's scan prefix, so the sender needs the scriptSig back
    /// rather than only the assembled transaction.
    pub fn sign_detailed(&self, keys: &[SigningKey]) -> Result<(Vec<u8>, Vec<Vec<u8>>)> {
        if keys.len() != self.inputs.len() {
            return Err(CliError::Internal(format!(
                "{} inputs but {} keys",
                self.inputs.len(),
                keys.len()
            )));
        }

        let mut script_sigs = Vec::with_capacity(self.inputs.len());
        for (index, key) in keys.iter().enumerate() {
            let digest = self.sighash(index)?;
            let signature: Signature = key
                .sign_prehash(&digest)
                .map_err(|e| CliError::Internal(format!("signing failed: {e}")))?;
            // Low-S is a consensus rule on BCH. k256 can emit high-S, and a
            // high-S signature is rejected at broadcast rather than at signing.
            let normalized = signature.normalize_s().unwrap_or(signature);

            let mut sig_bytes = normalized.to_der().as_bytes().to_vec();
            sig_bytes.push(SIGHASH_ALL_FORKID as u8);

            let pubkey = key.verifying_key().to_encoded_point(true);
            let mut script_sig = push_data(&sig_bytes);
            script_sig.extend_from_slice(&push_data(pubkey.as_bytes()));
            script_sigs.push(script_sig);
        }

        Ok((self.serialize(&script_sigs), script_sigs))
    }

    /// One input's wire serialization: outpoint, scriptSig, sequence — the
    /// same bytes `serialize` writes for it, and what RPA hashes.
    pub fn serialize_input(&self, index: usize, script_sig: &[u8]) -> Result<Vec<u8>> {
        let input = self
            .inputs
            .get(index)
            .ok_or_else(|| CliError::Internal(format!("no input at index {index}")))?;
        let mut out = Vec::with_capacity(32 + 4 + 1 + script_sig.len() + 4);
        out.extend_from_slice(&input.txid);
        out.extend_from_slice(&input.vout.to_le_bytes());
        out.extend_from_slice(&varint(script_sig.len() as u64));
        out.extend_from_slice(script_sig);
        out.extend_from_slice(&self.sequence.to_le_bytes());
        Ok(out)
    }

    fn serialize(&self, script_sigs: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&self.version.to_le_bytes());
        out.extend_from_slice(&varint(self.inputs.len() as u64));
        for (i, input) in self.inputs.iter().enumerate() {
            out.extend_from_slice(&input.txid);
            out.extend_from_slice(&input.vout.to_le_bytes());
            let empty = Vec::new();
            let sig = script_sigs.get(i).unwrap_or(&empty);
            out.extend_from_slice(&varint(sig.len() as u64));
            out.extend_from_slice(sig);
            out.extend_from_slice(&self.sequence.to_le_bytes());
        }
        out.extend_from_slice(&varint(self.outputs.len() as u64));
        for o in &self.outputs {
            let field = o.locking_field();
            out.extend_from_slice(&o.value.to_le_bytes());
            out.extend_from_slice(&varint(field.len() as u64));
            out.extend_from_slice(&field);
        }
        out.extend_from_slice(&self.locktime.to_le_bytes());
        out
    }
}

/// Serialized size of a signed P2PKH transaction, for fee estimation.
///
/// A P2PKH scriptSig is a 71-72 byte DER signature plus a 33-byte compressed
/// pubkey plus two push opcodes; 148 bytes per input is the standard worst
/// case. Over-estimating costs a few satoshis, under-estimating gets the
/// transaction rejected, so the worst case is the right side to err on.
pub fn estimate_size(inputs: usize, outputs: usize) -> Result<usize> {
    inputs
        .checked_mul(148)
        .and_then(|bytes| bytes.checked_add(outputs.checked_mul(34)?))
        .and_then(|bytes| bytes.checked_add(10))
        .ok_or_else(|| CliError::Usage("transaction size exceeds this platform".into()))
}

/// Select UTXOs to cover `target` plus fee, largest first.
///
/// Returns the chosen UTXOs and the fee that was assumed. Largest-first keeps
/// the input count and therefore the fee down; it is not privacy-optimal, and
/// the wallet's own coin selection is the better long-term home for this.
pub fn select_coins(
    available: &[Utxo],
    target: u64,
    fee_per_byte: u64,
    output_count: usize,
) -> Result<(Vec<Utxo>, u64)> {
    let cost = |inputs| -> Result<(u64, u64)> {
        let fee = (estimate_size(inputs, output_count)? as u64)
            .checked_mul(fee_per_byte)
            .ok_or_else(|| CliError::Usage("transaction fee exceeds the amount range".into()))?;
        let needed = target.checked_add(fee).ok_or_else(|| {
            CliError::Usage("send amount plus fee exceeds the amount range".into())
        })?;
        Ok((needed, fee))
    };
    let (mut needed, mut fee) = cost(1)?;
    let mut outpoints = BTreeSet::new();
    for utxo in available {
        if !outpoints.insert((utxo.txid, utxo.vout)) {
            return Err(CliError::Protocol("duplicate funding outpoint".into()));
        }
    }
    let mut sorted = available.to_vec();
    sorted.sort_by_key(|u| std::cmp::Reverse(u.value));

    let mut chosen: Vec<Utxo> = Vec::new();
    let mut total: u64 = 0;

    for utxo in sorted {
        total = total
            .checked_add(utxo.value)
            .ok_or_else(|| CliError::Protocol("funding total exceeds the amount range".into()))?;
        chosen.push(utxo);

        // Recompute the fee each round: it grows with every input added.
        (needed, fee) = cost(chosen.len())?;
        if total >= needed {
            return Ok((chosen, fee));
        }
    }

    Err(CliError::Usage(format!(
        "not enough funds: need {} sats (including about {} sats of fee) but only {} sats are spendable",
        needed,
        fee,
        total
    )))
}

/// One decoded output.
#[derive(Debug, Clone)]
pub struct DecodedOutput {
    pub value: u64,
    pub script_pubkey: Vec<u8>,
    pub token: Option<crate::token::TokenData>,
}

/// A decoded transaction.
#[derive(Debug, Clone)]
pub struct Decoded {
    pub version: u32,
    pub inputs: Vec<([u8; 32], u32, u32)>,
    pub outputs: Vec<DecodedOutput>,
    pub locktime: u32,
}

/// A locally identified output, retaining CashTokens separately from its script.
#[derive(Debug, Clone)]
pub struct UnspentOutput {
    /// Internal/wire hash order.
    pub txid: [u8; 32],
    pub vout: u32,
    pub output: DecodedOutput,
}

/// BCH received and spent by one transaction within the supplied script scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletTransaction {
    /// Internal/wire hash order, as in `UnspentOutput`.
    pub txid: [u8; 32],
    pub received_sats: u64,
    /// Only owned prevouts present in the supplied transaction set are counted.
    pub spent_sats: u64,
}

/// Project relevant history, including spent and zero-value owned outputs.
/// Results are sorted by internal txid; order and duplicate observations do not
/// change them. This proves neither inclusion nor completeness of the history.
pub fn wallet_history(
    transactions: &[Vec<u8>],
    scripts: &[Vec<u8>],
) -> Result<Vec<WalletTransaction>> {
    let projection = wallet_projection(transactions.iter().map(Vec::as_slice), scripts)?;
    let mut history = BTreeMap::new();
    for (outpoint, output) in projection.outputs {
        let received = history.entry(output.txid).or_insert(WalletTransaction {
            txid: output.txid,
            received_sats: 0,
            spent_sats: 0,
        });
        received.received_sats = received
            .received_sats
            .checked_add(output.output.value)
            .ok_or_else(|| CliError::Protocol("wallet received value exceeds u64 range".into()))?;
        if let Some(&txid) = projection.spent.get(&outpoint) {
            let spent = history.entry(txid).or_insert(WalletTransaction {
                txid,
                received_sats: 0,
                spent_sats: 0,
            });
            spent.spent_sats = spent
                .spent_sats
                .checked_add(output.output.value)
                .ok_or_else(|| CliError::Protocol("wallet spent value exceeds u64 range".into()))?;
        }
    }
    Ok(history.into_values().collect())
}

/// Project a complete transaction set for the supplied scripts. Order and
/// duplicate observations do not change the result. This proves neither
/// transaction inclusion nor that a provider supplied complete history.
pub fn unspent_outputs<'a>(
    transactions: impl IntoIterator<Item = &'a [u8]>,
    scripts: &[Vec<u8>],
) -> Result<Vec<UnspentOutput>> {
    let mut projection = wallet_projection(transactions, scripts)?;
    projection
        .outputs
        .retain(|outpoint, _| !projection.spent.contains_key(outpoint));
    Ok(projection.outputs.into_values().collect())
}

struct WalletProjection {
    outputs: BTreeMap<([u8; 32], u32), UnspentOutput>,
    spent: BTreeMap<([u8; 32], u32), [u8; 32]>,
}

fn wallet_projection<'a>(
    transactions: impl IntoIterator<Item = &'a [u8]>,
    scripts: &[Vec<u8>],
) -> Result<WalletProjection> {
    let scripts: BTreeSet<_> = scripts.iter().map(Vec::as_slice).collect();
    let mut seen = BTreeSet::new();
    let mut spent = BTreeMap::new();
    let mut outputs = BTreeMap::new();
    for raw in transactions {
        let txid = double_sha256(raw);
        if !seen.insert(txid) {
            continue;
        }
        let decoded = decode(raw)?;
        for (previous, vout, _) in decoded.inputs {
            if previous == [0; 32] && vout == u32::MAX {
                continue;
            }
            if spent.insert((previous, vout), txid).is_some() {
                return Err(CliError::Protocol(
                    "conflicting transactions require reconciliation before wallet projection"
                        .into(),
                ));
            }
        }
        for (vout, output) in decoded.outputs.into_iter().enumerate() {
            if scripts.contains(output.script_pubkey.as_slice()) {
                let vout = u32::try_from(vout)
                    .map_err(|_| CliError::Protocol("output index exceeds BCH range".into()))?;
                outputs.insert((txid, vout), UnspentOutput { txid, vout, output });
            }
        }
    }
    Ok(WalletProjection { outputs, spent })
}

fn take_varint(b: &[u8], i: &mut usize) -> Result<u64> {
    let first = *b
        .get(*i)
        .ok_or_else(|| CliError::Protocol("transaction ends mid-varint".into()))?;
    *i += 1;
    let mut read = |n: usize| -> Result<u64> {
        if b.len() < *i + n {
            return Err(CliError::Protocol("transaction ends mid-varint".into()));
        }
        let mut buf = [0u8; 8];
        buf[..n].copy_from_slice(&b[*i..*i + n]);
        *i += n;
        Ok(u64::from_le_bytes(buf))
    };
    let value = match first {
        0..=0xfc => Ok(u64::from(first)),
        0xfd => read(2),
        0xfe => read(4),
        _ => read(8),
    }?;
    let minimum = match first {
        0xfd => 0xfd,
        0xfe => 0x10000,
        0xff => 0x100000000,
        _ => 0,
    };
    if value < minimum {
        return Err(CliError::Protocol("non-canonical CompactSize".into()));
    }
    Ok(value)
}

fn take(b: &[u8], i: &mut usize, n: usize) -> Result<Vec<u8>> {
    let end = i
        .checked_add(n)
        .filter(|end| *end <= b.len())
        .ok_or_else(|| CliError::Protocol("transaction is truncated".into()))?;
    let v = b[*i..end].to_vec();
    *i = end;
    Ok(v)
}

/// Decode a raw transaction.
///
/// Outputs are checked for a CashTokens prefix. The prefix is not part of the
/// locking script but shares its length field, so a decoder that ignores it
/// reports the script as unparseable rather than reporting a token.
pub fn decode(bytes: &[u8]) -> Result<Decoded> {
    let mut i = 0usize;
    let version = u32::from_le_bytes(
        take(bytes, &mut i, 4)?
            .try_into()
            .map_err(|_| CliError::Protocol("bad version".into()))?,
    );

    let input_count = take_varint(bytes, &mut i)?;
    let mut inputs = Vec::new();
    for _ in 0..input_count {
        let txid: [u8; 32] = take(bytes, &mut i, 32)?
            .try_into()
            .map_err(|_| CliError::Protocol("bad outpoint".into()))?;
        let vout = u32::from_le_bytes(
            take(bytes, &mut i, 4)?
                .try_into()
                .map_err(|_| CliError::Protocol("bad vout".into()))?,
        );
        let script_len = usize::try_from(take_varint(bytes, &mut i)?)
            .map_err(|_| CliError::Protocol("script length exceeds this platform".into()))?;
        take(bytes, &mut i, script_len)?;
        let sequence = u32::from_le_bytes(
            take(bytes, &mut i, 4)?
                .try_into()
                .map_err(|_| CliError::Protocol("bad sequence".into()))?,
        );
        inputs.push((txid, vout, sequence));
    }

    let output_count = take_varint(bytes, &mut i)?;
    let mut outputs = Vec::new();
    for _ in 0..output_count {
        let value = u64::from_le_bytes(
            take(bytes, &mut i, 8)?
                .try_into()
                .map_err(|_| CliError::Protocol("bad value".into()))?,
        );
        let field_len = usize::try_from(take_varint(bytes, &mut i)?)
            .map_err(|_| CliError::Protocol("output length exceeds this platform".into()))?;
        let field = take(bytes, &mut i, field_len)?;
        let (token, script_pubkey) = if field.first() == Some(&0xef) {
            let (data, used) = crate::token::TokenData::decode_prefix(&field)?;
            (Some(data), field[used..].to_vec())
        } else {
            (None, field)
        };
        outputs.push(DecodedOutput {
            value,
            script_pubkey,
            token,
        });
    }

    let locktime = u32::from_le_bytes(
        take(bytes, &mut i, 4)?
            .try_into()
            .map_err(|_| CliError::Protocol("bad locktime".into()))?,
    );
    if i != bytes.len() {
        return Err(CliError::Protocol("transaction has trailing bytes".into()));
    }
    Ok(Decoded {
        version,
        inputs,
        outputs,
        locktime,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utxo(value: u64) -> Utxo {
        Utxo {
            txid: [7u8; 32],
            vout: 0,
            value,
            script_pubkey: vec![0x76, 0xa9, 0x14]
                .into_iter()
                .chain([9u8; 20])
                .chain([0x88, 0xac])
                .collect(),
        }
    }

    #[test]
    fn wallet_history_counts_receive_and_spend_with_change_in_any_order() {
        let prefix = crate::token::TokenData::fungible([9; 32], 42)
            .encode_prefix()
            .unwrap();
        let parent = Transaction::new(
            vec![utxo(100_000)],
            vec![
                Output::new(10_000, vec![0x51]),
                Output::with_tokens(1000, vec![0x53], prefix),
                Output::new(80_000, vec![0x52]),
            ],
        )
        .serialize(&[]);
        let parent_txid = double_sha256(&parent);
        let child = Transaction::new(
            (0..3)
                .map(|vout| Utxo {
                    txid: parent_txid,
                    vout,
                    ..utxo(0)
                })
                .collect(),
            vec![
                Output::new(3000, vec![0x51]),
                Output::new(2000, vec![0x53]),
                Output::new(85_000, vec![0x52]),
            ],
        )
        .serialize(&[]);
        let child_txid = double_sha256(&child);
        let unrelated = Transaction::new(
            vec![Utxo {
                txid: [8; 32],
                ..utxo(1000)
            }],
            vec![Output::new(900, vec![0x52])],
        )
        .serialize(&[]);
        let scripts = [vec![0x51], vec![0x53], vec![0x51]];
        let mut expected = vec![
            WalletTransaction {
                txid: parent_txid,
                received_sats: 11_000,
                spent_sats: 0,
            },
            WalletTransaction {
                txid: child_txid,
                received_sats: 5000,
                spent_sats: 11_000,
            },
        ];
        expected.sort_by_key(|tx| tx.txid);
        for transactions in [
            vec![parent.clone(), child.clone(), unrelated.clone()],
            vec![child.clone(), unrelated, parent.clone(), parent, child],
        ] {
            assert_eq!(wallet_history(&transactions, &scripts).unwrap(), expected);
            let outputs =
                unspent_outputs(transactions.iter().map(Vec::as_slice), &scripts).unwrap();
            assert_eq!(outputs.len(), 2);
            assert!(outputs.iter().all(|output| output.txid == child_txid));
            assert_eq!(
                outputs
                    .iter()
                    .map(|output| output.output.value)
                    .sum::<u64>(),
                5000
            );
            assert!(wallet_history(&transactions, &[]).unwrap().is_empty());
        }
        assert!(wallet_history(&[], &scripts).unwrap().is_empty());
    }

    #[test]
    fn wallet_history_retains_zero_value_token_receives_and_spends() {
        let prefix = crate::token::TokenData::fungible([9; 32], 42)
            .encode_prefix()
            .unwrap();
        let parent = Transaction::new(
            vec![utxo(1000)],
            vec![Output::with_tokens(0, vec![0x51], prefix)],
        )
        .serialize(&[]);
        let child = Transaction::new(
            vec![Utxo {
                txid: double_sha256(&parent),
                ..utxo(0)
            }],
            vec![Output::new(0, vec![0x52])],
        )
        .serialize(&[]);
        let transactions = [child, parent];
        let mut expected: Vec<_> = transactions
            .iter()
            .map(|raw| WalletTransaction {
                txid: double_sha256(raw),
                received_sats: 0,
                spent_sats: 0,
            })
            .collect();
        expected.sort_by_key(|tx| tx.txid);
        assert_eq!(
            wallet_history(&transactions, &[vec![0x51]]).unwrap(),
            expected
        );
    }

    #[test]
    fn wallet_history_rejects_malformed_and_conflicting_observations() {
        let transaction = Transaction::new(vec![utxo(1000)], vec![Output::new(900, vec![0x51])]);
        let raw = transaction.serialize(&[]);
        let mut invalid: Vec<Vec<Vec<u8>>> = (0..raw.len())
            .map(|cut| vec![raw[..cut].to_vec()])
            .collect();
        let mut trailing = raw.clone();
        trailing.push(0);
        let mut noncanonical = raw.clone();
        noncanonical.splice(4..5, [0xfd, 1, 0]);
        let malformed_token = Transaction::new(vec![utxo(1000)], vec![Output::new(0, vec![0xef])]);
        let duplicate_inputs =
            Transaction::new(vec![utxo(1000), utxo(1000)], transaction.outputs.clone());
        let conflict = Transaction::new(vec![utxo(1000)], vec![Output::new(800, vec![0x51])]);
        invalid.extend([
            vec![trailing],
            vec![noncanonical],
            vec![malformed_token.serialize(&[])],
            vec![duplicate_inputs.serialize(&[])],
            vec![raw, conflict.serialize(&[])],
        ]);
        for transactions in invalid {
            for scripts in [vec![vec![0x51]], vec![vec![0x52]], vec![]] {
                let history_error = wallet_history(&transactions, &scripts).unwrap_err();
                let output_error =
                    unspent_outputs(transactions.iter().map(Vec::as_slice), &scripts).unwrap_err();
                assert!(matches!(history_error, CliError::Protocol(_)));
                assert_eq!(history_error.to_string(), output_error.to_string());
            }
        }
    }

    #[test]
    fn wallet_history_checks_received_and_spent_sums() {
        let received_overflow = Transaction::new(
            vec![utxo(0)],
            vec![
                Output::new(u64::MAX, vec![0x51]),
                Output::new(1, vec![0x51]),
            ],
        )
        .serialize(&[]);
        assert!(
            matches!(wallet_history(&[received_overflow], &[vec![0x51]]), Err(CliError::Protocol(message)) if message.contains("received"))
        );
        let parents: Vec<_> = [u64::MAX, 1]
            .into_iter()
            .enumerate()
            .map(|(vout, value)| {
                Transaction::new(
                    vec![Utxo {
                        vout: vout as u32,
                        ..utxo(0)
                    }],
                    vec![Output::new(value, vec![0x51])],
                )
                .serialize(&[])
            })
            .collect();
        let child = Transaction::new(
            parents
                .iter()
                .map(|raw| Utxo {
                    txid: double_sha256(raw),
                    ..utxo(0)
                })
                .collect(),
            vec![Output::new(0, vec![0x52])],
        )
        .serialize(&[]);
        let transactions = [vec![child], parents].concat();
        assert!(
            matches!(wallet_history(&transactions, &[vec![0x51]]), Err(CliError::Protocol(message)) if message.contains("spent"))
        );
    }

    #[test]
    fn output_projection_is_order_independent_and_preserves_tokens() {
        let key = SigningKey::from_slice(&[0x33; 32]).unwrap();
        let prefix = crate::token::TokenData::fungible([9; 32], 42)
            .encode_prefix()
            .unwrap();
        let parent = Transaction::new(
            vec![utxo(100_000)],
            vec![
                Output::new(10_000, vec![0x51]),
                Output::with_tokens(1000, vec![0x51], prefix),
                Output::new(80_000, vec![0x52]),
            ],
        )
        .sign(std::slice::from_ref(&key))
        .unwrap();
        let input = Utxo {
            txid: double_sha256(&parent),
            vout: 0,
            value: 10_000,
            script_pubkey: vec![0x51],
        };
        let child = Transaction::new(vec![input.clone()], vec![Output::new(9000, vec![0x52])])
            .sign(std::slice::from_ref(&key))
            .unwrap();
        for transactions in [
            vec![parent.as_slice(), child.as_slice()],
            vec![child.as_slice(), parent.as_slice(), parent.as_slice()],
        ] {
            let found = unspent_outputs(transactions, &[vec![0x51]]).unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].vout, 1);
            assert_eq!(found[0].txid, double_sha256(&parent));
            assert_eq!(found[0].output.value, 1000);
            assert_eq!(found[0].output.token.as_ref().unwrap().amount, 42);
        }
        let conflict = Transaction::new(vec![input], vec![Output::new(8000, vec![0x52])])
            .sign(&[key])
            .unwrap();
        assert!(unspent_outputs(
            [parent.as_slice(), child.as_slice(), conflict.as_slice()],
            &[vec![0x51]]
        )
        .is_err());
    }

    #[test]
    fn a_signed_transaction_decodes_back() {
        let key = SigningKey::from_slice(&[0x22u8; 32]).unwrap();
        let tx = Transaction::new(vec![utxo(100_000)], vec![Output::new(90_000, vec![0x51])]);
        let raw = tx.sign(&[key]).unwrap();
        let back = decode(&raw).expect("our own output must decode");
        assert_eq!(back.version, 2);
        assert_eq!(back.inputs.len(), 1);
        assert_eq!(back.outputs.len(), 1);
        assert_eq!(back.outputs[0].value, 90_000);
        assert!(back.outputs[0].token.is_none());
    }

    #[test]
    fn a_token_output_decodes_with_its_prefix() {
        // The prefix shares the locking script's length field, so a decoder
        // that ignores it reports an unparseable script instead of a token.
        let key = SigningKey::from_slice(&[0x33u8; 32]).unwrap();
        let category = [9u8; 32];
        let prefix = crate::token::TokenData::fungible(category, 4242)
            .encode_prefix()
            .unwrap();
        let tx = Transaction::new(
            vec![utxo(100_000)],
            vec![Output::with_tokens(1000, vec![0x51], prefix)],
        );
        let raw = tx.sign(&[key]).unwrap();
        let back = decode(&raw).unwrap();
        let token = back.outputs[0].token.as_ref().expect("token must be found");
        assert_eq!(token.amount, 4242);
        assert_eq!(token.category, category);
        assert_eq!(back.outputs[0].script_pubkey, vec![0x51]);
    }

    #[test]
    fn a_truncated_transaction_errors_rather_than_panicking() {
        let key = SigningKey::from_slice(&[0x44u8; 32]).unwrap();
        let tx = Transaction::new(vec![utxo(100_000)], vec![Output::new(90_000, vec![0x51])]);
        let raw = tx.sign(&[key]).unwrap();
        for cut in 0..raw.len() {
            assert!(decode(&raw[..cut]).is_err());
        }
        let mut trailing = raw.clone();
        trailing.push(0);
        assert!(decode(&trailing).is_err());
        let mut noncanonical = raw.clone();
        noncanonical.splice(4..5, [0xfd, 1, 0]);
        assert!(decode(&noncanonical).is_err());
        let malformed = Transaction::new(vec![utxo(100_000)], vec![Output::new(1000, vec![0xef])]);
        assert!(decode(
            &malformed
                .sign(&[SigningKey::from_slice(&[0x44; 32]).unwrap()])
                .unwrap()
        )
        .is_err());
    }

    #[test]
    fn varint_uses_the_shortest_encoding() {
        assert_eq!(varint(0), vec![0x00]);
        assert_eq!(varint(0xfc), vec![0xfc]);
        assert_eq!(varint(0xfd), vec![0xfd, 0xfd, 0x00]);
        assert_eq!(varint(0xffff), vec![0xfd, 0xff, 0xff]);
        assert_eq!(varint(0x1_0000), vec![0xfe, 0x00, 0x00, 0x01, 0x00]);
    }

    #[test]
    fn the_preimage_has_the_bip143_layout() {
        // 4 version + 32 hashPrevouts + 32 hashSequence + 36 outpoint
        // + 1 scriptCode varint + 25 scriptCode + 8 value + 4 sequence
        // + 32 hashOutputs + 4 locktime + 4 sighash type = 182
        let tx = Transaction::new(
            vec![utxo(100_000)],
            vec![Output::new(90_000, utxo(0).script_pubkey)],
        );
        let p = tx.sighash_preimage(0).unwrap();
        assert_eq!(p.len(), 182, "unexpected preimage length");
        assert_eq!(&p[0..4], &2u32.to_le_bytes(), "version");
        assert_eq!(
            &p[p.len() - 4..],
            &SIGHASH_ALL_FORKID.to_le_bytes(),
            "sighash type"
        );
    }

    #[test]
    fn the_preimage_commits_to_the_input_value() {
        // This is what FORKID adds and what stops a signature being replayed
        // against an output of a different amount.
        let a = Transaction::new(vec![utxo(100_000)], vec![Output::new(1, vec![0x51])]);
        let b = Transaction::new(vec![utxo(200_000)], vec![Output::new(1, vec![0x51])]);
        assert_ne!(a.sighash(0).unwrap(), b.sighash(0).unwrap());
    }

    #[test]
    fn changing_an_output_changes_every_sighash() {
        let base = Transaction::new(
            vec![utxo(100_000), utxo(50_000)],
            vec![Output::new(90_000, vec![0x51])],
        );
        let mut altered = base.clone();
        altered.outputs[0].value = 89_999;
        for i in 0..2 {
            assert_ne!(
                base.sighash(i).unwrap(),
                altered.sighash(i).unwrap(),
                "input {i} must commit to the outputs"
            );
        }
    }

    #[test]
    fn signing_produces_a_parseable_script_sig() {
        let key = SigningKey::from_slice(&[0x11u8; 32]).unwrap();
        let tx = Transaction::new(vec![utxo(100_000)], vec![Output::new(90_000, vec![0x51])]);
        let raw = tx.sign(&[key]).unwrap();
        // version(4) + in count(1) + outpoint(36) + scriptSig len(1) + ...
        assert_eq!(&raw[0..4], &2u32.to_le_bytes());
        assert_eq!(raw[4], 1, "one input");
        let sig_len = raw[41] as usize;
        // push(sig 71-73 incl. hashtype) + push(33 pubkey) = ~106-108
        assert!(
            (105..=110).contains(&sig_len),
            "scriptSig length {sig_len} outside the expected P2PKH range"
        );
        let hashtype_pos = 42 + raw[42] as usize;
        assert_eq!(
            raw[hashtype_pos], SIGHASH_ALL_FORKID as u8,
            "signature must end with SIGHASH_ALL|FORKID"
        );
    }

    #[test]
    fn coin_selection_covers_the_fee_not_just_the_target() {
        let pool: Vec<_> = [10_000, 5_000, 1_000]
            .into_iter()
            .enumerate()
            .map(|(index, value)| Utxo {
                vout: index as u32,
                ..utxo(value)
            })
            .collect();
        let (chosen, fee) = select_coins(&pool, 9_000, 1, 2).unwrap();
        let total: u64 = chosen.iter().map(|u| u.value).sum();
        assert!(total >= 9_000 + fee, "selection must cover target plus fee");
        assert!(fee > 0, "a real transaction always costs something");
    }

    #[test]
    fn coin_selection_rejects_overflow_and_duplicate_outpoints() {
        let coin = utxo(10_000);
        // 226 * 2^63 wraps to zero in an unchecked release build.
        assert!(select_coins(std::slice::from_ref(&coin), 1_000, 1 << 63, 2).is_err());
        assert!(select_coins(&[coin.clone(), coin.clone()], 15_000, 1, 2).is_err());
        assert!(select_coins(std::slice::from_ref(&coin), 1_000, 1, usize::MAX).is_err());
        assert!(select_coins(&[], u64::MAX, 1, 2).is_err());
        let mut second = coin.clone();
        second.vout = 1;
        let (selected, fee) = select_coins(&[coin, second], 15_000, 1, 2).unwrap();
        assert_eq!(selected.len(), 2);
        assert_eq!(fee, 374);
        assert!(select_coins(&[utxo(u64::MAX)], u64::MAX, 1, 2).is_err());
        let huge = utxo(u64::MAX / 2 + 1);
        let other = Utxo {
            vout: 1,
            ..huge.clone()
        };
        assert!(select_coins(&[huge, other], u64::MAX - 500, 1, 2).is_err());
    }

    #[test]
    fn coin_selection_refuses_when_the_fee_makes_it_unaffordable() {
        // Exactly the target, so any fee at all makes it impossible.
        let pool = vec![utxo(9_000)];
        let err = select_coins(&pool, 9_000, 1, 2).unwrap_err();
        assert!(
            err.to_string().contains("not enough funds"),
            "unexpected: {err}"
        );
    }
}
