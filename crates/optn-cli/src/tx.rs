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
pub fn estimate_size(inputs: usize, outputs: usize) -> usize {
    10 + inputs * 148 + outputs * 34
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
    let mut sorted = available.to_vec();
    sorted.sort_by_key(|u| std::cmp::Reverse(u.value));

    let mut chosen: Vec<Utxo> = Vec::new();
    let mut total: u64 = 0;

    for utxo in sorted {
        total = total.saturating_add(utxo.value);
        chosen.push(utxo);

        // Recompute the fee each round: it grows with every input added.
        let fee = estimate_size(chosen.len(), output_count) as u64 * fee_per_byte;
        if total >= target.saturating_add(fee) {
            return Ok((chosen, fee));
        }
    }

    let fee = estimate_size(chosen.len().max(1), output_count) as u64 * fee_per_byte;
    Err(CliError::Usage(format!(
        "not enough funds: need {} sats (including about {} sats of fee) but only {} sats are spendable",
        target.saturating_add(fee),
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
    match first {
        0..=0xfc => Ok(u64::from(first)),
        0xfd => read(2),
        0xfe => read(4),
        _ => read(8),
    }
}

fn take(b: &[u8], i: &mut usize, n: usize) -> Result<Vec<u8>> {
    if b.len() < *i + n {
        return Err(CliError::Protocol("transaction is truncated".into()));
    }
    let v = b[*i..*i + n].to_vec();
    *i += n;
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
        let script_len = take_varint(bytes, &mut i)? as usize;
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
        let field_len = take_varint(bytes, &mut i)? as usize;
        let field = take(bytes, &mut i, field_len)?;
        let (token, script_pubkey) = match crate::token::TokenData::decode_prefix(&field) {
            Ok((data, used)) => (Some(data), field[used..].to_vec()),
            // No prefix is the ordinary case, not an error.
            Err(_) => (None, field),
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
        for cut in 1..raw.len() {
            let _ = decode(&raw[..cut]);
        }
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
        let pool = vec![utxo(10_000), utxo(5_000), utxo(1_000)];
        let (chosen, fee) = select_coins(&pool, 9_000, 1, 2).unwrap();
        let total: u64 = chosen.iter().map(|u| u.value).sum();
        assert!(total >= 9_000 + fee, "selection must cover target plus fee");
        assert!(fee > 0, "a real transaction always costs something");
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
