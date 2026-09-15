//! Stateless BCH P2SH20 multisig derivation.
//!
//! This crate deliberately has no wallet, storage, network, signing, or global
//! state. Consumers supply public keys for one concrete address and receive
//! the BIP-67-sorted redeem script and its P2SH20 representation.

use std::fmt;

use k256::PublicKey;
use ripemd::Ripemd160;
use sha2::{Digest, Sha256};

const MAX_COSIGNERS: usize = 15;
const COMPRESSED_PUBLIC_KEY_LEN: usize = 33;
const OP_CHECKMULTISIG: u8 = 0xae;
const OP_HASH160: u8 = 0xa9;
const OP_EQUAL: u8 = 0x87;
const CASHADDR_CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/// BCH network prefixes supported by the desktop and CLI wallet surfaces.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Network {
    Mainnet,
    Chipnet,
}

impl Network {
    pub fn parse(value: &str) -> Result<Self, MultisigError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "mainnet" | "bitcoincash" => Ok(Self::Mainnet),
            "chipnet" | "bchtest" => Ok(Self::Chipnet),
            _ => Err(MultisigError::Network(value.to_string())),
        }
    }

    pub fn prefix(self) -> &'static str {
        match self {
            Self::Mainnet => "bitcoincash",
            Self::Chipnet => "bchtest",
        }
    }
}

/// A validation failure from a stateless multisig derivation request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MultisigError {
    Network(String),
    Policy(String),
    PublicKey { index: usize, reason: &'static str },
}

impl fmt::Display for MultisigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Network(value) => write!(f, "unsupported multisig network '{value}'"),
            Self::Policy(message) => f.write_str(message),
            Self::PublicKey { index, reason } => {
                write!(f, "multisig public key {} {reason}", index + 1)
            }
        }
    }
}

impl std::error::Error for MultisigError {}

/// The complete read-only result for one concrete P2SH20 multisig address.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MultisigInspection {
    pub threshold: u8,
    pub total_signatures: u8,
    /// Keys in the exact BIP-67 order committed by `redeem_script`.
    pub sorted_public_keys: Vec<[u8; COMPRESSED_PUBLIC_KEY_LEN]>,
    /// `OP_m <pubkeys...> OP_n OP_CHECKMULTISIG`.
    pub redeem_script: Vec<u8>,
    /// HASH160 of `redeem_script`, the payload committed by P2SH20.
    pub script_hash: [u8; 20],
    /// `OP_HASH160 <20-byte hash> OP_EQUAL`.
    pub locking_script: [u8; 23],
    /// Standard BCH CashAddr P2SH20 representation.
    pub address: String,
    /// Token-aware BCH CashAddr P2SH20 representation of the same script.
    pub token_address: String,
}

/// Parse and validate a compressed secp256k1 public key encoded as hex.
///
/// Shape checks alone are not enough: accepting a 33-byte value which is not a
/// curve point produces an address which no signer can spend. `k256` performs
/// the SEC1 point validation using its pure-Rust secp256k1 implementation.
pub fn parse_compressed_public_key(
    value: &str,
    index: usize,
) -> Result<[u8; COMPRESSED_PUBLIC_KEY_LEN], MultisigError> {
    let value = value.trim();
    if value.len() != COMPRESSED_PUBLIC_KEY_LEN * 2 || !value.is_ascii() {
        return Err(MultisigError::PublicKey {
            index,
            reason: "must be 33 compressed bytes encoded as 66 hexadecimal characters",
        });
    }

    let mut key = [0u8; COMPRESSED_PUBLIC_KEY_LEN];
    for (offset, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = hex_nibble(pair[0]).ok_or(MultisigError::PublicKey {
            index,
            reason: "contains a non-hexadecimal character",
        })?;
        let low = hex_nibble(pair[1]).ok_or(MultisigError::PublicKey {
            index,
            reason: "contains a non-hexadecimal character",
        })?;
        key[offset] = (high << 4) | low;
    }
    if !matches!(key[0], 0x02 | 0x03) {
        return Err(MultisigError::PublicKey {
            index,
            reason: "is not compressed (it must begin with 02 or 03)",
        });
    }
    PublicKey::from_sec1_bytes(&key).map_err(|_| MultisigError::PublicKey {
        index,
        reason: "is not a valid secp256k1 point",
    })?;
    Ok(key)
}

/// Build one concrete BCH P2SH20 multisig address from public key hex.
///
/// This operation is deterministic and read-only. It intentionally accepts
/// already-derived keys, not xPubs: BIP-67 sorting must happen separately for
/// each child address, after HD derivation.
pub fn inspect_p2sh20(
    network: Network,
    threshold: u8,
    public_keys_hex: &[&str],
) -> Result<MultisigInspection, MultisigError> {
    let public_keys = public_keys_hex
        .iter()
        .enumerate()
        .map(|(index, key)| parse_compressed_public_key(key, index))
        .collect::<Result<Vec<_>, _>>()?;
    inspect_p2sh20_keys(network, threshold, public_keys)
}

/// Build one concrete BCH P2SH20 multisig address from validated public keys.
pub fn inspect_p2sh20_keys(
    network: Network,
    threshold: u8,
    mut public_keys: Vec<[u8; COMPRESSED_PUBLIC_KEY_LEN]>,
) -> Result<MultisigInspection, MultisigError> {
    if !(2..=MAX_COSIGNERS).contains(&public_keys.len()) {
        return Err(MultisigError::Policy(format!(
            "a P2SH multisig policy needs between 2 and {MAX_COSIGNERS} cosigners"
        )));
    }
    if threshold < 2 || usize::from(threshold) > public_keys.len() {
        return Err(MultisigError::Policy(format!(
            "multisig threshold must be between 2 and {}",
            public_keys.len()
        )));
    }

    public_keys.sort_unstable();
    if public_keys.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(MultisigError::Policy(
            "multisig public keys must be unique; duplicate keys make the threshold a fiction"
                .into(),
        ));
    }

    let total_signatures = public_keys.len() as u8;
    let mut redeem_script = Vec::with_capacity(3 + public_keys.len() * 34);
    redeem_script.push(opcode_for_small_integer(threshold)?);
    for public_key in &public_keys {
        redeem_script.push(COMPRESSED_PUBLIC_KEY_LEN as u8);
        redeem_script.extend_from_slice(public_key);
    }
    redeem_script.push(opcode_for_small_integer(total_signatures)?);
    redeem_script.push(OP_CHECKMULTISIG);
    if redeem_script.len() > 520 {
        return Err(MultisigError::Policy(
            "multisig redeem script exceeds BCH's 520-byte push limit".into(),
        ));
    }

    let script_hash = hash160(&redeem_script);
    let mut locking_script = [0u8; 23];
    locking_script[0] = OP_HASH160;
    locking_script[1] = 20;
    locking_script[2..22].copy_from_slice(&script_hash);
    locking_script[22] = OP_EQUAL;

    Ok(MultisigInspection {
        threshold,
        total_signatures,
        sorted_public_keys: public_keys,
        redeem_script,
        script_hash,
        locking_script,
        address: cashaddr_p2sh20(network, false, script_hash),
        token_address: cashaddr_p2sh20(network, true, script_hash),
    })
}

fn opcode_for_small_integer(value: u8) -> Result<u8, MultisigError> {
    if !(1..=16).contains(&value) {
        return Err(MultisigError::Policy(
            "multisig values must fit the OP_1 through OP_16 opcode range".into(),
        ));
    }
    Ok(0x50 + value)
}

fn hash160(data: &[u8]) -> [u8; 20] {
    let sha = Sha256::digest(data);
    let ripemd = Ripemd160::digest(sha);
    let mut hash = [0u8; 20];
    hash.copy_from_slice(&ripemd);
    hash
}

fn cashaddr_p2sh20(network: Network, token_aware: bool, script_hash: [u8; 20]) -> String {
    // Type is 1 (P2SH) or 3 (token-aware P2SH), both with a 20-byte hash.
    let version = if token_aware { 0x18 } else { 0x08 };
    let mut payload = Vec::with_capacity(21);
    payload.push(version);
    payload.extend_from_slice(&script_hash);
    encode_cashaddr(network.prefix(), &payload)
}

fn encode_cashaddr(prefix: &str, payload: &[u8]) -> String {
    let payload5 = convert_bits(payload, 8, 5, true).expect("byte input always converts");
    let mut checksum_input: Vec<u8> = prefix
        .bytes()
        .map(|byte| byte & 0x1f)
        .chain(std::iter::once(0))
        .chain(payload5.iter().copied())
        .collect();
    checksum_input.extend_from_slice(&[0u8; 8]);
    let checksum = cashaddr_polymod(&checksum_input);

    let mut encoded = String::with_capacity(prefix.len() + 1 + payload5.len() + 8);
    encoded.push_str(prefix);
    encoded.push(':');
    for value in payload5 {
        encoded.push(CASHADDR_CHARSET[value as usize] as char);
    }
    for index in 0..8 {
        let value = ((checksum >> (5 * (7 - index))) & 0x1f) as usize;
        encoded.push(CASHADDR_CHARSET[value] as char);
    }
    encoded
}

fn cashaddr_polymod(values: &[u8]) -> u64 {
    let mut checksum = 1u64;
    for &value in values {
        let top = (checksum >> 35) as u8;
        checksum = ((checksum & 0x07_ffff_ffff) << 5) ^ u64::from(value);
        if top & 0x01 != 0 {
            checksum ^= 0x98_f2bc_8e61;
        }
        if top & 0x02 != 0 {
            checksum ^= 0x0079_b76d_99e2;
        }
        if top & 0x04 != 0 {
            checksum ^= 0xf3_3e5f_b3c4;
        }
        if top & 0x08 != 0 {
            checksum ^= 0xae_2eab_e2a8;
        }
        if top & 0x10 != 0 {
            checksum ^= 0x1e_4f43_e470;
        }
    }
    checksum ^ 1
}

fn convert_bits(data: &[u8], from: u32, to: u32, pad: bool) -> Option<Vec<u8>> {
    let mut accumulator = 0u32;
    let mut bits = 0u32;
    let mut converted = Vec::new();
    let max_value = (1 << to) - 1;
    for &value in data {
        if u32::from(value) >> from != 0 {
            return None;
        }
        accumulator = (accumulator << from) | u32::from(value);
        bits += from;
        while bits >= to {
            bits -= to;
            converted.push(((accumulator >> bits) & max_value) as u8);
        }
    }
    if pad {
        if bits > 0 {
            converted.push(((accumulator << (to - bits)) & max_value) as u8);
        }
    } else if bits >= from || ((accumulator << (to - bits)) & max_value) != 0 {
        return None;
    }
    Some(converted)
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTOR_1_KEYS: [&str; 2] = [
        "02ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f8",
        "02fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f",
    ];
    const VECTOR_1_SCRIPT: &str = "522102fe6f0a5a297eb38c391581c4413e084773ea23954d93f7753db7dc0adc188b2f2102ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f852ae";
    const VECTOR_1_CHIPNET_ADDRESS: &str = "bchtest:ppttar4f8yf0xa592s4z4pj22cq03zn82syer0akm8";
    const VECTOR_1_CHIPNET_TOKEN_ADDRESS: &str =
        "bchtest:rpttar4f8yf0xa592s4z4pj22cq03zn82srns3nsy5";

    #[test]
    fn bip67_vector_1_is_sorted_and_encoded_canonically() {
        let result = inspect_p2sh20(Network::Mainnet, 2, &VECTOR_1_KEYS).unwrap();
        assert_eq!(hex(&result.redeem_script), VECTOR_1_SCRIPT);
        assert_eq!(
            result
                .sorted_public_keys
                .iter()
                .map(|key| hex(key))
                .collect::<Vec<_>>(),
            vec![VECTOR_1_KEYS[1].to_string(), VECTOR_1_KEYS[0].to_string()]
        );
        assert_eq!(result.locking_script[0], 0xa9);
        assert_eq!(result.locking_script[1], 0x14);
        assert_eq!(result.locking_script[22], 0x87);
    }

    #[test]
    fn key_input_order_does_not_change_the_result() {
        let first = inspect_p2sh20(Network::Mainnet, 2, &VECTOR_1_KEYS).unwrap();
        let second =
            inspect_p2sh20(Network::Mainnet, 2, &[VECTOR_1_KEYS[1], VECTOR_1_KEYS[0]]).unwrap();
        assert_eq!(first.redeem_script, second.redeem_script);
        assert_eq!(first.address, second.address);
    }

    #[test]
    fn token_and_network_forms_only_change_cashaddr_encoding() {
        let mainnet = inspect_p2sh20(Network::Mainnet, 2, &VECTOR_1_KEYS).unwrap();
        let chipnet = inspect_p2sh20(Network::Chipnet, 2, &VECTOR_1_KEYS).unwrap();
        assert_eq!(mainnet.redeem_script, chipnet.redeem_script);
        assert_eq!(mainnet.script_hash, chipnet.script_hash);
        assert!(mainnet.address.starts_with("bitcoincash:p"));
        assert!(mainnet.token_address.starts_with("bitcoincash:r"));
        assert_eq!(chipnet.address, VECTOR_1_CHIPNET_ADDRESS);
        assert_eq!(chipnet.token_address, VECTOR_1_CHIPNET_TOKEN_ADDRESS);
    }

    #[test]
    fn rejects_insecure_or_noncanonical_policies_before_derivation() {
        assert!(inspect_p2sh20(Network::Mainnet, 1, &VECTOR_1_KEYS).is_err());
        assert!(inspect_p2sh20(Network::Mainnet, 3, &VECTOR_1_KEYS).is_err());
        assert!(inspect_p2sh20(Network::Mainnet, 2, &[VECTOR_1_KEYS[0]]).is_err());
        assert!(
            inspect_p2sh20(Network::Mainnet, 2, &[VECTOR_1_KEYS[0], VECTOR_1_KEYS[0]]).is_err()
        );
        assert!(inspect_p2sh20(
            Network::Mainnet,
            2,
            &[
                "04ff12471208c14bd580709cb2358d98975247d8765f92bc25eab3b2763ed605f8",
                VECTOR_1_KEYS[1]
            ],
        )
        .is_err());
    }
}
