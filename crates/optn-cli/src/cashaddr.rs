//! CashAddr decoding and the scripthash derivation Electrum indexes by.
//!
//! Electrum servers do not index addresses. They index the SHA-256 of the
//! output script, byte-reversed — so every balance or UTXO query has to go
//! address -> hash160 -> script -> sha256 -> reverse. Getting the reversal
//! wrong returns an empty result rather than an error, which looks exactly
//! like an address with no history.

use sha2::{Digest, Sha256};

const CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressKind {
    P2pkh,
    P2sh,
}

#[derive(Debug, Clone)]
pub struct Address {
    pub kind: AddressKind,
    pub hash: [u8; 20],
    pub prefix: String,
}

fn polymod(values: &[u8]) -> u64 {
    let mut c: u64 = 1;
    for &d in values {
        let c0 = (c >> 35) as u8;
        c = ((c & 0x07_ffff_ffff) << 5) ^ u64::from(d);
        if c0 & 0x01 != 0 {
            c ^= 0x98_f2bc_8e61;
        }
        if c0 & 0x02 != 0 {
            c ^= 0x79_b76d_99e2;
        }
        if c0 & 0x04 != 0 {
            c ^= 0xf3_3e5f_b3c4;
        }
        if c0 & 0x08 != 0 {
            c ^= 0xae_2eab_e2a8;
        }
        if c0 & 0x10 != 0 {
            c ^= 0x1e_4f43_e470;
        }
    }
    c ^ 1
}

fn convert_bits(data: &[u8], from: u32, to: u32, pad: bool) -> Option<Vec<u8>> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::new();
    let maxv: u32 = (1 << to) - 1;
    for &value in data {
        if (u32::from(value) >> from) != 0 {
            return None;
        }
        acc = (acc << from) | u32::from(value);
        bits += from;
        while bits >= to {
            bits -= to;
            out.push(((acc >> bits) & maxv) as u8);
        }
    }
    if pad {
        if bits > 0 {
            out.push(((acc << (to - bits)) & maxv) as u8);
        }
    } else if bits >= from || ((acc << (to - bits)) & maxv) != 0 {
        return None;
    }
    Some(out)
}

impl Address {
    /// Parse a CashAddr, with or without its `bitcoincash:` / `bchtest:` prefix.
    pub fn decode(input: &str) -> Result<Self, String> {
        let lower = input.trim().to_lowercase();
        let (prefix, payload) = match lower.split_once(':') {
            Some((p, rest)) => (p.to_string(), rest.to_string()),
            // A bare address is valid and common; mainnet is the only sane default.
            None => ("bitcoincash".to_string(), lower.clone()),
        };
        if payload.is_empty() {
            return Err("address payload is empty".into());
        }

        let mut values = Vec::with_capacity(prefix.len() + 1 + payload.len());
        for b in prefix.bytes() {
            values.push(b & 0x1f);
        }
        values.push(0);
        for ch in payload.bytes() {
            let idx = CHARSET
                .iter()
                .position(|&c| c == ch)
                .ok_or_else(|| format!("invalid character '{}' in address", ch as char))?;
            values.push(idx as u8);
        }

        if polymod(&values) != 0 {
            return Err(format!(
                "checksum failed for '{input}' — check for a typo, or that the prefix matches the network"
            ));
        }

        let data_end = values.len() - 8;
        let payload5 = &values[prefix.len() + 1..data_end];
        let payload8 = convert_bits(payload5, 5, 8, false)
            .ok_or_else(|| "address payload is not a whole number of bytes".to_string())?;
        if payload8.len() != 21 {
            return Err(format!(
                "expected a 21-byte payload, got {} bytes",
                payload8.len()
            ));
        }

        let version = payload8[0];
        let kind = match version >> 3 {
            0 => AddressKind::P2pkh,
            1 => AddressKind::P2sh,
            other => return Err(format!("unsupported address type {other}")),
        };
        let mut hash = [0u8; 20];
        hash.copy_from_slice(&payload8[1..]);
        Ok(Address { kind, hash, prefix })
    }

    /// The output script this address pays to.
    pub fn script_pubkey(&self) -> Vec<u8> {
        match self.kind {
            // OP_DUP OP_HASH160 <20> ... OP_EQUALVERIFY OP_CHECKSIG
            AddressKind::P2pkh => {
                let mut s = Vec::with_capacity(25);
                s.extend_from_slice(&[0x76, 0xa9, 0x14]);
                s.extend_from_slice(&self.hash);
                s.extend_from_slice(&[0x88, 0xac]);
                s
            }
            // OP_HASH160 <20> ... OP_EQUAL
            AddressKind::P2sh => {
                let mut s = Vec::with_capacity(23);
                s.extend_from_slice(&[0xa9, 0x14]);
                s.extend_from_slice(&self.hash);
                s.push(0x87);
                s
            }
        }
    }

    /// Electrum's index key: SHA-256 of the script, byte-reversed, hex.
    pub fn electrum_scripthash(&self) -> String {
        let digest = Sha256::digest(self.script_pubkey());
        let mut bytes = digest.to_vec();
        bytes.reverse();
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The example address from the CashAddr specification. If the base32
    // decode, the bit conversion or the payload split regress, this hash
    // changes.
    const SPEC_P2PKH: &str = "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a";
    const SPEC_HASH160: &str = "76a04053bda0a88bda5177b86a15c3b29f559873";

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn decodes_the_specification_example() {
        let a = Address::decode(SPEC_P2PKH).expect("spec address must decode");
        assert_eq!(a.kind, AddressKind::P2pkh);
        assert_eq!(a.prefix, "bitcoincash");
        assert_eq!(hex(&a.hash), SPEC_HASH160);
    }

    #[test]
    fn builds_a_p2pkh_script() {
        let a = Address::decode(SPEC_P2PKH).unwrap();
        // OP_DUP OP_HASH160 <20> ... OP_EQUALVERIFY OP_CHECKSIG
        assert_eq!(hex(&a.script_pubkey()), format!("76a914{SPEC_HASH160}88ac"));
    }

    #[test]
    fn scripthash_is_reversed() {
        // Electrum indexes by the byte-reversed SHA-256 of the script. A
        // forward-order hash returns an empty result rather than an error,
        // which is indistinguishable from an address with no history — so the
        // reversal is asserted directly.
        use sha2::{Digest, Sha256};
        let a = Address::decode(SPEC_P2PKH).unwrap();
        let forward = hex(&Sha256::digest(a.script_pubkey()));
        let got = a.electrum_scripthash();
        assert_ne!(got, forward, "scripthash must not be in forward order");
        let mut bytes = hex_to_bytes(&got);
        bytes.reverse();
        assert_eq!(hex(&bytes), forward);
    }

    fn hex_to_bytes(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn a_bare_address_assumes_mainnet() {
        let bare = SPEC_P2PKH.split_once(':').unwrap().1;
        let a = Address::decode(bare).expect("bare address must decode");
        assert_eq!(a.prefix, "bitcoincash");
        assert_eq!(hex(&a.hash), SPEC_HASH160);
    }

    #[test]
    fn rejects_a_mutated_checksum() {
        let mut chars: Vec<char> = SPEC_P2PKH.chars().collect();
        let last = chars.len() - 1;
        chars[last] = if chars[last] == 'a' { 'c' } else { 'a' };
        let mutated: String = chars.into_iter().collect();
        let err = Address::decode(&mutated).unwrap_err();
        assert!(err.contains("checksum"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_a_character_outside_the_charset() {
        // 'b' is deliberately absent from the CashAddr charset.
        let err =
            Address::decode("bitcoincash:bpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a").unwrap_err();
        assert!(err.contains("invalid character"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_an_empty_payload() {
        let err = Address::decode("bitcoincash:").unwrap_err();
        assert!(err.contains("empty"), "unexpected error: {err}");
    }
}
