//! BCH signing shared by dApp connectors and native callers.
//!
//! The caller supplies a previously approved transaction and its source outputs.
//! This module validates the signing context, encodes CashTokens and constructs
//! the exact BCH signing serialization; it does not authorize a session or spend.
//! CashTokens reference: https://cashtokens.org/docs/spec/chip/#sighash_utxos

use k256::elliptic_curve::PrimeField;
use k256::Scalar;
use ripemd::Ripemd160;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use zeroize::Zeroizing;

use crate::fusion::schnorr;

pub const ALL_OUTPUTS: u8 = 0x41;
pub const ALL_OUTPUTS_ALL_UTXOS: u8 = 0x61;
const MAX_MONEY: u64 = 21_000_000 * 100_000_000;
// Resource bounds for connector requests, not consensus limits.
const MAX_ITEMS: usize = 10_000;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    /// Transaction id in display order, as in libauth; reversed on the wire.
    pub outpoint_transaction_hash: Vec<u8>,
    pub outpoint_index: u32,
    pub sequence_number: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Output {
    /// Decimal strings preserve integer precision across the WASM boundary.
    #[serde(with = "decimal")]
    pub value_satoshis: u64,
    pub locking_bytecode: Vec<u8>,
    pub token: Option<Token>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Token {
    pub category: Vec<u8>,
    #[serde(with = "decimal")]
    pub amount: u64,
    pub nft: Option<Nft>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Nft {
    pub capability: Capability,
    pub commitment: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    None,
    Mutable,
    Minting,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Transaction {
    pub version: u32,
    pub locktime: u32,
    pub inputs: Vec<Input>,
    pub outputs: Vec<Output>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SigningContext {
    pub input_index: usize,
    pub transaction: Transaction,
    pub source_outputs: Vec<Output>,
}

pub fn parse_context(json: &str) -> Result<SigningContext> {
    if json.len() > MAX_REQUEST_BYTES {
        return Err("connector signing context exceeds the wallet resource limit".into());
    }
    serde_json::from_str(json).map_err(|_| "malformed connector signing context".into())
}

mod decimal {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(D::Error::custom(
                "amount must be an unsigned decimal integer",
            ));
        }
        value
            .parse()
            .map_err(|_| D::Error::custom("amount is out of range"))
    }
}

fn compact(value: u64, out: &mut Vec<u8>) {
    match value {
        0..=252 => out.push(value as u8),
        253..=65535 => {
            out.push(253);
            out.extend_from_slice(&(value as u16).to_le_bytes());
        }
        65536..=0xffff_ffff => {
            out.push(254);
            out.extend_from_slice(&(value as u32).to_le_bytes());
        }
        _ => {
            out.push(255);
            out.extend_from_slice(&value.to_le_bytes());
        }
    }
}

pub fn hash256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(Sha256::digest(bytes)).into()
}

fn token_prefix(token: &Option<Token>) -> Result<Vec<u8>> {
    let Some(token) = token else {
        return Ok(Vec::new());
    };
    if token.category.len() != 32 {
        return Err("token category must contain 32 bytes".into());
    }
    let quantity = token.amount;
    if quantity > i64::MAX as u64 {
        return Err("token amount is out of range".into());
    }
    if quantity == 0 && token.nft.is_none() {
        return Err("token prefix must encode tokens".into());
    }
    let mut flags = if quantity > 0 { 0x10 } else { 0 };
    if let Some(nft) = &token.nft {
        if nft.commitment.len() > 40 {
            return Err("NFT commitment exceeds 40 bytes".into());
        }
        flags |= 0x20
            | match nft.capability {
                Capability::None => 0,
                Capability::Mutable => 1,
                Capability::Minting => 2,
            };
        if !nft.commitment.is_empty() {
            flags |= 0x40;
        }
    }
    let mut prefix = vec![0xef];
    prefix.extend(token.category.iter().rev());
    prefix.push(flags);
    if let Some(nft) = &token.nft {
        if !nft.commitment.is_empty() {
            compact(nft.commitment.len() as u64, &mut prefix);
            prefix.extend_from_slice(&nft.commitment);
        }
    }
    if quantity > 0 {
        compact(quantity, &mut prefix);
    }
    Ok(prefix)
}

fn encode_output(output: &Output, out: &mut Vec<u8>) -> Result<u64> {
    if output.locking_bytecode.len() > MAX_REQUEST_BYTES {
        return Err("output script exceeds the wallet resource limit".into());
    }
    let value = output.value_satoshis;
    if value > MAX_MONEY {
        return Err("satoshi amount is out of range".into());
    }
    let prefix = token_prefix(&output.token)?;
    out.extend_from_slice(&value.to_le_bytes());
    compact((prefix.len() + output.locking_bytecode.len()) as u64, out);
    out.extend_from_slice(&prefix);
    out.extend_from_slice(&output.locking_bytecode);
    if out.len() > MAX_REQUEST_BYTES {
        return Err("outputs exceed the wallet resource limit".into());
    }
    Ok(value)
}

fn encode_outputs(outputs: &[Output]) -> Result<(Vec<u8>, u64)> {
    let mut encoded = Vec::new();
    let mut total = 0u64;
    for output in outputs {
        total = total
            .checked_add(encode_output(output, &mut encoded)?)
            .filter(|value| *value <= MAX_MONEY)
            .ok_or("total output value exceeds the monetary range")?;
    }
    Ok((encoded, total))
}

/// Only the two complete-output modes used by these connectors are accepted.
/// This API cannot silently downgrade a requested UTXO commitment.
pub fn signing_serialization(
    context: &SigningContext,
    covered: &[u8],
    mode: u8,
) -> Result<Vec<u8>> {
    if !matches!(mode, ALL_OUTPUTS | ALL_OUTPUTS_ALL_UTXOS) {
        return Err("unsupported connector signing mode".into());
    }
    let tx = &context.transaction;
    if tx.inputs.is_empty()
        || tx.outputs.is_empty()
        || tx.inputs.len() > MAX_ITEMS
        || tx.outputs.len() > MAX_ITEMS
        || context.source_outputs.len() != tx.inputs.len()
        || covered.len() > MAX_REQUEST_BYTES
    {
        return Err("incomplete or oversized connector signing context".into());
    }
    let input = tx
        .inputs
        .get(context.input_index)
        .ok_or("input index is out of range")?;
    let source = &context.source_outputs[context.input_index];
    let mut prevouts = Vec::with_capacity(tx.inputs.len() * 36);
    let mut sequences = Vec::with_capacity(tx.inputs.len() * 4);
    let mut seen = HashSet::new();
    for input in &tx.inputs {
        if input.outpoint_transaction_hash.len() != 32 {
            return Err("input transaction id must contain 32 bytes".into());
        }
        if !seen.insert((&input.outpoint_transaction_hash, input.outpoint_index)) {
            return Err("duplicate transaction input".into());
        }
        prevouts.extend(input.outpoint_transaction_hash.iter().rev());
        prevouts.extend_from_slice(&input.outpoint_index.to_le_bytes());
        sequences.extend_from_slice(&input.sequence_number.to_le_bytes());
    }
    let (utxos, available) = encode_outputs(&context.source_outputs)?;
    let (outputs, spent) = encode_outputs(&tx.outputs)?;
    if spent > available {
        return Err("transaction outputs exceed source value".into());
    }
    let mut result = Vec::with_capacity(256 + covered.len());
    result.extend_from_slice(&tx.version.to_le_bytes());
    result.extend_from_slice(&hash256(&prevouts));
    if mode == ALL_OUTPUTS_ALL_UTXOS {
        result.extend_from_slice(&hash256(&utxos));
    }
    result.extend_from_slice(&hash256(&sequences));
    result.extend(input.outpoint_transaction_hash.iter().rev());
    result.extend_from_slice(&input.outpoint_index.to_le_bytes());
    result.extend_from_slice(&token_prefix(&source.token)?);
    compact(covered.len() as u64, &mut result);
    result.extend_from_slice(covered);
    result.extend_from_slice(&source.value_satoshis.to_le_bytes());
    result.extend_from_slice(&input.sequence_number.to_le_bytes());
    result.extend_from_slice(&hash256(&outputs));
    result.extend_from_slice(&tx.locktime.to_le_bytes());
    result.extend_from_slice(&u32::from(mode).to_le_bytes());
    Ok(result)
}

fn scalar(key: &[u8]) -> Result<Scalar> {
    let bytes: [u8; 32] = key
        .try_into()
        .map_err(|_| "private key must contain 32 bytes")?;
    Option::<Scalar>::from(Scalar::from_repr(bytes.into()))
        .filter(|value| !bool::from(value.is_zero()))
        .ok_or_else(|| "invalid secp256k1 private key".into())
}

pub fn public_key(private_key: Vec<u8>) -> Result<Vec<u8>> {
    let secret = Zeroizing::new(private_key);
    Ok(schnorr::pubkey_compressed(scalar(&secret)?).to_vec())
}

pub fn p2pkh_lock(public_key: &[u8]) -> Result<Vec<u8>> {
    if public_key.len() != 33 || k256::PublicKey::from_sec1_bytes(public_key).is_err() {
        return Err("invalid compressed public key".into());
    }
    let hash = Ripemd160::digest(Sha256::digest(public_key));
    let mut lock = vec![0x76, 0xa9, 0x14];
    lock.extend_from_slice(&hash);
    lock.extend_from_slice(&[0x88, 0xac]);
    Ok(lock)
}

/// Signs an approved P2PKH or P2SH input, returning a BCH signature plus mode.
/// The key is owned and erased on every return, including validation errors.
pub fn sign_input(
    context: &SigningContext,
    private_key: Vec<u8>,
    covered: &[u8],
    mode: u8,
) -> Result<Vec<u8>> {
    let secret = Zeroizing::new(private_key);
    let preimage = signing_serialization(context, covered, mode)?;
    let key = scalar(&secret)?;
    let source = &context.source_outputs[context.input_index];
    let public_key = schnorr::pubkey_compressed(key);
    let p2pkh = p2pkh_lock(&public_key)?;
    let mut p2sh20 = vec![0xa9, 0x14];
    p2sh20.extend_from_slice(&Ripemd160::digest(Sha256::digest(covered)));
    p2sh20.push(0x87);
    let mut p2sh32 = vec![0xaa, 0x20];
    p2sh32.extend_from_slice(&hash256(covered));
    p2sh32.push(0x87);
    if !((source.locking_bytecode == p2pkh && covered == p2pkh)
        || source.locking_bytecode == p2sh20
        || source.locking_bytecode == p2sh32)
    {
        return Err("signing script or key does not match the source output".into());
    }
    let mut signature = schnorr::sign(key, &hash256(&preimage)).to_vec();
    signature.push(mode);
    Ok(signature)
}

pub fn sign_p2pkh(context: &SigningContext, private_key: Vec<u8>, mode: u8) -> Result<Vec<u8>> {
    let mut key = Zeroizing::new(private_key);
    let public_key = schnorr::pubkey_compressed(scalar(&key)?);
    let covered = p2pkh_lock(&public_key)?;
    let signature = sign_input(context, std::mem::take(&mut *key), &covered, mode)?;
    let mut unlocking = Vec::with_capacity(100);
    unlocking.push(signature.len() as u8);
    unlocking.extend_from_slice(&signature);
    unlocking.push(public_key.len() as u8);
    unlocking.extend_from_slice(&public_key);
    Ok(unlocking)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Vectors {
        vectors: Vec<Vector>,
    }
    #[derive(Deserialize)]
    struct Vector {
        context: SigningContext,
        covered: Vec<u8>,
        mode: u8,
        preimage: String,
        signature: String,
    }

    fn vectors() -> Vec<Vector> {
        serde_json::from_str::<Vectors>(include_str!("../../../test-vectors/connect-signing.json"))
            .expect("public reference vectors parse")
            .vectors
    }

    fn key() -> Vec<u8> {
        let mut key = vec![0; 32];
        key[31] = 1;
        key
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn native_signing_matches_external_bch_and_cashtokens_vectors() {
        for vector in vectors() {
            assert_eq!(
                hex(&signing_serialization(&vector.context, &vector.covered, vector.mode).unwrap()),
                vector.preimage
            );
            assert_eq!(
                hex(&sign_input(&vector.context, key(), &vector.covered, vector.mode).unwrap()),
                vector.signature
            );
        }
    }

    #[test]
    fn invalid_contexts_and_keys_fail_before_signing() {
        let vector = vectors().remove(0);
        let mut missing = vector.context.clone();
        missing.source_outputs.pop();
        assert!(sign_input(&missing, key(), &vector.covered, vector.mode).is_err());
        let mut duplicate = vector.context.clone();
        duplicate.transaction.inputs[1] = duplicate.transaction.inputs[0].clone();
        assert!(sign_input(&duplicate, key(), &vector.covered, vector.mode).is_err());
        for length in 0..65 {
            assert!(sign_input(
                &vector.context,
                vec![0; length],
                &vector.covered,
                vector.mode
            )
            .is_err());
        }
        for mode in 0..=255 {
            if !matches!(mode, ALL_OUTPUTS | ALL_OUTPUTS_ALL_UTXOS) {
                assert!(sign_input(&vector.context, key(), &vector.covered, mode).is_err());
            }
        }
    }

    #[test]
    fn malformed_json_and_large_values_cannot_panic_or_round() {
        let vector = vectors().remove(0);
        let json = serde_json::to_string(&vector.context).unwrap();
        for end in 0..json.len() {
            assert!(parse_context(&json[..end]).is_err());
        }
        for invalid in ["-1", "+1", "1.5", "NaN", "18446744073709551616"] {
            assert!(parse_context(&json.replace("100000", invalid)).is_err());
        }
        let mut oversized = vector.context;
        oversized.source_outputs[0].value_satoshis = MAX_MONEY + 1;
        assert!(sign_input(&oversized, key(), &vector.covered, vector.mode).is_err());
    }
}
