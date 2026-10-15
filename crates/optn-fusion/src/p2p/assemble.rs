//! The canonical CoinJoin every peer rebuilds, the gate a peer passes before
//! signing, and the check of the final transaction (`nostr/fusionRound.ts`,
//! `nostr/fusionSign.ts`).
//!
//! The coordinator has no say over the order: inputs sort by their outpoint
//! string and outputs by value then script, BIP69-style, so each peer
//! reproduces the transaction it signs instead of trusting the coordinator's
//! copy. The strings sort exactly as JavaScript sorts them, `"…:10"` before
//! `"…:9"` included, or a Rust peer would build a different transaction from
//! a TypeScript one.

use std::collections::{HashMap, HashSet};

use super::wire::{outpoint_key, InputRef, InputSig, OutputRef};
use super::{fee_for_bytes, unhex, unhex_array};
use crate::tx::{FusionTx, P2pInput, P2pOutput};

/// A fusion transaction must not pay more than this multiple of its minimum
/// fee: a coordinator could otherwise burn peers' coins to miners.
pub const MAX_FEE_FACTOR: u64 = 3;
/// Version 4 + locktime 4 + the two count varints, as Electron Cash sizes it.
const TX_OVERHEAD: u64 = 10;
const SEQUENCE: u32 = 0xffff_ffff;
const TX_VERSION: u32 = 2;
const SIGHASH_ALL_FORKID: u8 = 0x41;

/// The CoinJoin in canonical order (`AssembledFusionTx`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assembled {
    pub inputs: Vec<InputRef>,
    pub outputs: Vec<OutputRef>,
}

/// One peer's inputs and outputs (`PeerContribution`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Contribution {
    pub inputs: Vec<InputRef>,
    pub outputs: Vec<OutputRef>,
}

/// Merge contributions into the canonical order, refusing a duplicate
/// outpoint — a peer registering someone else's coin (`assembleFusionTx`).
pub fn assemble<'a>(
    contributions: impl IntoIterator<Item = (&'a [InputRef], &'a [OutputRef])>,
) -> Result<Assembled, String> {
    let mut inputs = Vec::new();
    let mut outputs = Vec::new();
    let mut seen = HashSet::new();
    for (contributed_inputs, contributed_outputs) in contributions {
        for input in contributed_inputs {
            let key = input.key();
            if !seen.insert(key.clone()) {
                return Err(format!("duplicate input {key}"));
            }
            inputs.push(input.clone());
        }
        outputs.extend(contributed_outputs.iter().cloned());
    }
    inputs.sort_by_key(InputRef::key);
    outputs.sort_by(|a, b| a.value.cmp(&b.value).then_with(|| a.script.cmp(&b.script)));
    Ok(Assembled { inputs, outputs })
}

impl Assembled {
    /// Estimated size with Electron Cash's fusion formulas: 108 bytes plus
    /// the pubkey per input, 9 plus the script per output, 10 overhead.
    pub fn estimated_size(&self) -> u64 {
        TX_OVERHEAD
            + self
                .inputs
                .iter()
                .map(|input| 108 + input.pubkey.len() as u64 / 2)
                .sum::<u64>()
            + self
                .outputs
                .iter()
                .map(|output| 9 + output.script.len() as u64 / 2)
                .sum::<u64>()
    }

    /// The least fee this transaction may pay at `feerate` sats per 1,000
    /// bytes.
    pub fn minimum_fee(&self, feerate: u64) -> u64 {
        fee_for_bytes(self.estimated_size(), feerate)
    }

    pub fn total_in(&self) -> u64 {
        self.inputs.iter().map(|input| input.value).sum()
    }

    pub fn total_out(&self) -> u64 {
        self.outputs.iter().map(|output| output.value).sum()
    }

    /// The template as the shared transaction builder sees it.
    pub fn fusion_tx(&self) -> Result<FusionTx, String> {
        let inputs = self
            .inputs
            .iter()
            .map(|input| {
                Ok(P2pInput {
                    prev_txid: unhex_array::<32>(&input.prev_txid)
                        .ok_or("input txid is not 32-byte hex")?,
                    prev_index: input.prev_index,
                    pubkey: unhex(&input.pubkey).ok_or("input pubkey is not hex")?,
                    value: input.value,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let outputs = self
            .outputs
            .iter()
            .map(|output| {
                Ok(P2pOutput {
                    script: unhex(&output.script).ok_or("output script is not hex")?,
                    value: output.value,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        FusionTx::from_p2p(&inputs, &outputs)
    }
}

/// Why it is or is not safe to sign (`SafetyResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Safety {
    pub ok: bool,
    pub reason: Option<String>,
    pub total_in: u64,
    pub total_out: u64,
    pub fee: i128,
    pub required_fee: u64,
}

/// The signing gate (`verifyFusionSafety`): every one of my inputs is in the
/// transaction, every one of my outputs is there at its exact value, nothing
/// inflates, and the fee is neither too low to confirm nor more than three
/// times the minimum. Outputs match as a multiset of (value, script), so
/// another peer's identical output cannot stand in for mine.
pub fn verify_safety(tx: &Assembled, mine: &Contribution, feerate: u64) -> Safety {
    let total_in = tx.total_in();
    let total_out = tx.total_out();
    let fee = i128::from(total_in) - i128::from(total_out);
    let required_fee = tx.minimum_fee(feerate);
    let refuse = |reason: String| Safety {
        ok: false,
        reason: Some(reason),
        total_in,
        total_out,
        fee,
        required_fee,
    };
    let keys: HashSet<String> = tx.inputs.iter().map(InputRef::key).collect();
    for input in &mine.inputs {
        if !keys.contains(&input.key()) {
            return refuse(format!("my input {} missing", input.key()));
        }
    }
    let mut available: HashMap<(u64, &str), usize> = HashMap::new();
    for output in &tx.outputs {
        *available.entry((output.value, &output.script)).or_default() += 1;
    }
    for output in &mine.outputs {
        let slot = available.entry((output.value, &output.script)).or_default();
        if *slot == 0 {
            let prefix: String = output.script.chars().take(12).collect();
            return refuse(format!(
                "my output {} sats to {prefix}… missing",
                output.value
            ));
        }
        *slot -= 1;
    }
    if total_out > total_in {
        return refuse("inflation: outputs exceed inputs".into());
    }
    if fee < i128::from(required_fee) {
        return refuse(format!("fee {fee} underpays (need {required_fee})"));
    }
    if fee > i128::from(required_fee * MAX_FEE_FACTOR) {
        return refuse(format!(
            "fee {fee} too high (max {})",
            required_fee * MAX_FEE_FACTOR
        ));
    }
    Safety {
        ok: true,
        reason: None,
        total_in,
        total_out,
        fee,
        required_fee,
    }
}

fn compact_size(n: u64, out: &mut Vec<u8>) {
    match n {
        0..=0xfc => out.push(n as u8),
        0xfd..=0xffff => {
            out.push(0xfd);
            out.extend_from_slice(&(n as u16).to_le_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(0xfe);
            out.extend_from_slice(&(n as u32).to_le_bytes());
        }
        _ => {
            out.push(0xff);
            out.extend_from_slice(&n.to_le_bytes());
        }
    }
}

fn double_sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(Sha256::digest(bytes)).into()
}

/// The display txid of raw transaction bytes.
pub fn txid_of(raw: &[u8]) -> String {
    let mut hash = double_sha256(raw);
    hash.reverse();
    super::hex(&hash)
}

/// Encode `tx` with `unlocking[i]` as input i's scriptSig.
fn encode(tx: &Assembled, unlocking: &[Vec<u8>]) -> Result<Vec<u8>, String> {
    let mut raw = Vec::new();
    raw.extend_from_slice(&TX_VERSION.to_le_bytes());
    compact_size(tx.inputs.len() as u64, &mut raw);
    for (input, script) in tx.inputs.iter().zip(unlocking) {
        let mut txid =
            unhex_array::<32>(&input.prev_txid).ok_or("input txid is not 32-byte hex")?;
        txid.reverse();
        raw.extend_from_slice(&txid);
        raw.extend_from_slice(&input.prev_index.to_le_bytes());
        compact_size(script.len() as u64, &mut raw);
        raw.extend_from_slice(script);
        raw.extend_from_slice(&SEQUENCE.to_le_bytes());
    }
    compact_size(tx.outputs.len() as u64, &mut raw);
    for output in &tx.outputs {
        let script = unhex(&output.script).ok_or("output script is not hex")?;
        raw.extend_from_slice(&output.value.to_le_bytes());
        compact_size(script.len() as u64, &mut raw);
        raw.extend_from_slice(&script);
    }
    raw.extend_from_slice(&0u32.to_le_bytes());
    Ok(raw)
}

/// The signed transaction (`finalizeFusionTx`): each input's scriptSig from
/// the collected signatures, or an error naming the first unsigned input.
pub fn finalize(tx: &Assembled, sigs: &[InputSig]) -> Result<(String, String), String> {
    let by_key: HashMap<String, &str> = sigs
        .iter()
        .map(|sig| (sig.key(), sig.unlocking_bytecode.as_str()))
        .collect();
    let unlocking = tx
        .inputs
        .iter()
        .map(|input| {
            let key = input.key();
            let script = by_key
                .get(&key)
                .ok_or_else(|| format!("missing signature for input {key}"))?;
            unhex(script).ok_or_else(|| format!("signature for {key} is not hex"))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let raw = encode(tx, &unlocking)?;
    Ok((super::hex(&raw), txid_of(&raw)))
}

/// A raw transaction's parts, as far as this check needs them.
struct Decoded {
    version: u32,
    inputs: Vec<([u8; 32], u32, Vec<u8>, u32)>,
    outputs: Vec<(u64, Vec<u8>)>,
    locktime: u32,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.at.checked_add(n)?;
        let slice = self.bytes.get(self.at..end)?;
        self.at = end;
        Some(slice)
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }
    fn compact_size(&mut self) -> Option<u64> {
        Some(match *self.take(1)?.first()? {
            0xfd => u64::from(u16::from_le_bytes(self.take(2)?.try_into().ok()?)),
            0xfe => u64::from(self.u32()?),
            0xff => self.u64()?,
            small => u64::from(small),
        })
    }
    fn bytes(&mut self) -> Option<Vec<u8>> {
        let len = usize::try_from(self.compact_size()?).ok()?;
        Some(self.take(len)?.to_vec())
    }
}

fn decode(raw: &[u8]) -> Option<Decoded> {
    let mut reader = Reader { bytes: raw, at: 0 };
    let version = reader.u32()?;
    let input_count = reader.compact_size()?;
    let mut inputs = Vec::new();
    for _ in 0..input_count {
        let txid: [u8; 32] = reader.take(32)?.try_into().ok()?;
        let index = reader.u32()?;
        let script = reader.bytes()?;
        let sequence = reader.u32()?;
        inputs.push((txid, index, script, sequence));
    }
    let output_count = reader.compact_size()?;
    let mut outputs = Vec::new();
    for _ in 0..output_count {
        let value = reader.u64()?;
        outputs.push((value, reader.bytes()?));
    }
    let locktime = reader.u32()?;
    (reader.at == raw.len()).then_some(Decoded {
        version,
        inputs,
        outputs,
        locktime,
    })
}

/// A P2PKH scriptSig as every honest peer writes it:
/// `push65(sig64 || 0x41) push33(pubkey)`. The 64-byte BCH Schnorr signature.
fn schnorr_scriptsig(script: &[u8], pubkey: &[u8]) -> Option<[u8; 64]> {
    if script.len() != 1 + 65 + 1 + 33
        || script[0] != 65
        || script[65] != SIGHASH_ALL_FORKID
        || script[66] != 33
        || &script[67..] != pubkey
    {
        return None;
    }
    script[1..65].try_into().ok()
}

/// Check the coordinator's final transaction byte for byte against the
/// template this peer approved, then every signature against its input
/// (`verifyFinalFusionTx`). Without it a peer could accept a different or
/// half-signed transaction after sending its own signatures.
///
/// The TypeScript runs libauth's BCH VM here; this verifies each P2PKH
/// spend directly: the exact scriptSig shape, the input's own pubkey, and a
/// Schnorr signature over the BIP143 `SIGHASH_ALL|FORKID` digest. Every
/// signer in this protocol produces that shape.
pub fn verify_final(
    approved: &Assembled,
    tx_hex: &str,
    claimed_txid: &str,
) -> Result<String, String> {
    if tx_hex.is_empty()
        || tx_hex.len() > 2_000_000
        || !tx_hex.len().is_multiple_of(2)
        || !tx_hex.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("invalid final Fusion transaction encoding".into());
    }
    if !super::is_hex_len(claimed_txid, 64) {
        return Err("invalid final Fusion transaction id".into());
    }
    let raw = unhex(tx_hex).ok_or("invalid final Fusion transaction encoding")?;
    let txid = txid_of(&raw);
    if txid != claimed_txid.to_ascii_lowercase() {
        return Err("final Fusion transaction id does not match its bytes".into());
    }
    let decoded = decode(&raw).ok_or("invalid final Fusion transaction")?;
    if decoded.version != TX_VERSION
        || decoded.locktime != 0
        || decoded.inputs.len() != approved.inputs.len()
        || decoded.outputs.len() != approved.outputs.len()
    {
        return Err("final Fusion transaction differs from approved template".into());
    }
    let template = approved.fusion_tx()?;
    for (index, (input, wanted)) in decoded.inputs.iter().zip(&approved.inputs).enumerate() {
        let mut wanted_txid =
            unhex_array::<32>(&wanted.prev_txid).ok_or("approved input txid is not hex")?;
        wanted_txid.reverse();
        if input.0 != wanted_txid
            || input.1 != wanted.prev_index
            || input.3 != SEQUENCE
            || input.2.is_empty()
        {
            return Err("final Fusion transaction input differs from approved template".into());
        }
        let pubkey = unhex(&wanted.pubkey).ok_or("approved input pubkey is not hex")?;
        let signature = schnorr_scriptsig(&input.2, &pubkey)
            .ok_or("final Fusion transaction failed BCH validation: unexpected scriptSig")?;
        if !optn_core::fusion::schnorr::verify(&pubkey, &signature, &template.sighash(index)?) {
            return Err("final Fusion transaction failed BCH validation: bad signature".into());
        }
    }
    for (output, wanted) in decoded.outputs.iter().zip(&approved.outputs) {
        let script = unhex(&wanted.script).ok_or("approved output script is not hex")?;
        if output.0 != wanted.value || output.1 != script {
            return Err("final Fusion transaction output differs from approved template".into());
        }
    }
    Ok(txid)
}

/// Sign this wallet's own inputs of an approved template with the keys it
/// holds, as `push(sig||0x41) push(pubkey)` (`signMyInputs`). Only for
/// tests and simulated peers: a real wallet signs through the native
/// `p2p_sign` boundary, which repeats the safety checks.
pub fn sign_own_inputs(
    tx: &Assembled,
    keys: &HashMap<String, [u8; 32]>,
) -> Result<Vec<InputSig>, String> {
    use k256::elliptic_curve::PrimeField;
    let template = tx.fusion_tx()?;
    let mut sigs = Vec::new();
    for (index, input) in tx.inputs.iter().enumerate() {
        let Some(secret) = keys.get(&input.pubkey) else {
            continue;
        };
        let scalar = Option::<k256::Scalar>::from(k256::Scalar::from_repr((*secret).into()))
            .ok_or("signing key is not a scalar")?;
        let signature = optn_core::fusion::schnorr::sign(scalar, &template.sighash(index)?);
        let pubkey = unhex(&input.pubkey).ok_or("input pubkey is not hex")?;
        let mut script = vec![65];
        script.extend_from_slice(&signature);
        script.push(SIGHASH_ALL_FORKID);
        script.push(pubkey.len() as u8);
        script.extend_from_slice(&pubkey);
        sigs.push(InputSig {
            prev_txid: input.prev_txid.clone(),
            prev_index: input.prev_index,
            unlocking_bytecode: super::hex(&script),
        });
    }
    Ok(sigs)
}

/// `${txid}:${index}` keys of `sigs`, for set comparisons.
pub fn sig_keys(sigs: &[InputSig]) -> Vec<String> {
    sigs.iter()
        .map(|sig| outpoint_key(&sig.prev_txid, sig.prev_index))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::elliptic_curve::PrimeField;

    fn pubkey_of(secret: [u8; 32]) -> String {
        let scalar = Option::<k256::Scalar>::from(k256::Scalar::from_repr(secret.into())).unwrap();
        super::super::hex(&optn_core::fusion::schnorr::pubkey_compressed(scalar))
    }

    fn input(txid_byte: u8, index: u32, value: u64, secret: [u8; 32]) -> InputRef {
        InputRef {
            prev_txid: super::super::hex(&[txid_byte; 32]),
            prev_index: index,
            value,
            pubkey: pubkey_of(secret),
        }
    }

    fn p2pkh(byte: u8) -> String {
        format!("76a914{}88ac", super::super::hex(&[byte; 20]))
    }

    #[test]
    fn outpoints_sort_as_strings_like_javascript() {
        let a = input(0xaa, 9, 1_000, [1; 32]);
        let b = input(0xaa, 10, 1_000, [1; 32]);
        let tx = assemble([(&[a.clone(), b.clone()][..], &[][..])]).unwrap();
        assert_eq!(tx.inputs, vec![b, a], "\"…:10\" sorts before \"…:9\"");
        assert!(assemble([(
            &[input(1, 0, 5, [1; 32]), input(1, 0, 5, [1; 32])][..],
            &[][..]
        )])
        .is_err());
    }

    #[test]
    fn the_gate_refuses_a_missing_output_and_a_fee_out_of_range() {
        let mine = Contribution {
            inputs: vec![input(1, 0, 100_000, [1; 32])],
            outputs: vec![OutputRef {
                script: p2pkh(1),
                value: 99_000,
            }],
        };
        let tx = assemble([(&mine.inputs[..], &mine.outputs[..])]).unwrap();
        // 10 + 141 + 34 = 185 bytes, 185 sats at 1 sat/byte; fee 1,000 > 555.
        let verdict = verify_safety(&tx, &mine, 1_000);
        assert!(!verdict.ok && verdict.reason.unwrap().contains("too high"));
        assert!(verify_safety(&tx, &mine, 2_000).ok);
        let dropped = Assembled {
            outputs: vec![OutputRef {
                script: p2pkh(2),
                value: 99_000,
            }],
            ..tx
        };
        assert!(!verify_safety(&dropped, &mine, 2_000).ok);
    }

    #[test]
    fn a_finalized_transaction_passes_the_final_check_and_a_tampered_one_does_not() {
        let secrets = [[1u8; 32], [2u8; 32]];
        let inputs = [
            input(1, 0, 60_000, secrets[0]),
            input(2, 3, 50_000, secrets[1]),
        ];
        let outputs = [
            OutputRef {
                script: p2pkh(1),
                value: 55_000,
            },
            OutputRef {
                script: p2pkh(2),
                value: 54_500,
            },
        ];
        let tx = assemble([(&inputs[..], &outputs[..])]).unwrap();
        let keys: HashMap<String, [u8; 32]> = secrets
            .iter()
            .map(|secret| (pubkey_of(*secret), *secret))
            .collect();
        let sigs = sign_own_inputs(&tx, &keys).unwrap();
        assert_eq!(sigs.len(), 2);
        let (tx_hex, txid) = finalize(&tx, &sigs).unwrap();
        assert_eq!(verify_final(&tx, &tx_hex, &txid).unwrap(), txid);

        // Swap the two signatures: shapes still parse, signatures do not verify.
        let swapped: Vec<InputSig> = vec![
            InputSig {
                unlocking_bytecode: sigs[1].unlocking_bytecode.clone(),
                ..sigs[0].clone()
            },
            InputSig {
                unlocking_bytecode: sigs[0].unlocking_bytecode.clone(),
                ..sigs[1].clone()
            },
        ];
        let (bad_hex, bad_txid) = finalize(&tx, &swapped).unwrap();
        assert!(verify_final(&tx, &bad_hex, &bad_txid).is_err());
        assert!(
            verify_final(&tx, &tx_hex, &bad_txid).is_err(),
            "txid must match the bytes"
        );
        assert!(finalize(&tx, &sigs[..1]).is_err());
    }
}
