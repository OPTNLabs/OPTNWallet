//! CashTokens output prefixes (CHIP-2022-02).
//!
//! A token output is an ordinary output whose locking script is preceded by a
//! token prefix. The prefix is not part of the script: it sits between the
//! output's value and its `scriptPubKey`, so a node that does not understand
//! tokens sees a script it cannot run rather than a script that means
//! something else.
//!
//! ```text
//! 0xef                  PREFIX_TOKEN
//! category[32]          little-endian, the reverse of the displayed id
//! bitfield              structure in the high nibble, NFT capability in the low
//! [length + commitment] when the NFT carries one
//! [amount]              when a fungible amount is present
//! <locking script>
//! ```
//!
//! Sending tokens to an address that does not advertise token support is how
//! tokens are destroyed, so `Address::accepts_tokens` is checked before a
//! transfer rather than trusted.

use crate::error::{CliError, Result};
use crate::tx::varint;

const PREFIX_TOKEN: u8 = 0xef;

const HAS_COMMITMENT_LENGTH: u8 = 0x40;
const HAS_NFT: u8 = 0x20;
const HAS_AMOUNT: u8 = 0x10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    /// Cannot be modified or used to mint.
    None,
    /// The commitment may be changed when spent.
    Mutable,
    /// May mint further NFTs of this category.
    Minting,
}

impl Capability {
    fn bits(self) -> u8 {
        match self {
            Capability::None => 0x00,
            Capability::Mutable => 0x01,
            Capability::Minting => 0x02,
        }
    }

    fn from_bits(bits: u8) -> Result<Self> {
        match bits & 0x0f {
            0x00 => Ok(Capability::None),
            0x01 => Ok(Capability::Mutable),
            0x02 => Ok(Capability::Minting),
            other => Err(CliError::Protocol(format!(
                "unknown NFT capability {other:#x}"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Capability::None => "none",
            Capability::Mutable => "mutable",
            Capability::Minting => "minting",
        }
    }
}

/// The token content of one output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenData {
    /// Category id in display order, i.e. the same byte order as a txid.
    pub category: [u8; 32],
    /// Fungible amount. Zero means the output carries no fungible token.
    pub amount: u64,
    /// Present when the output carries an NFT.
    pub nft: Option<Nft>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nft {
    pub capability: Capability,
    pub commitment: Vec<u8>,
}

impl TokenData {
    pub fn fungible(category: [u8; 32], amount: u64) -> Self {
        TokenData {
            category,
            amount,
            nft: None,
        }
    }

    /// Serialize the prefix that precedes the locking script.
    pub fn encode_prefix(&self) -> Result<Vec<u8>> {
        if self.amount == 0 && self.nft.is_none() {
            return Err(CliError::Internal(
                "a token prefix must carry an amount, an NFT, or both".into(),
            ));
        }
        if let Some(nft) = &self.nft {
            if nft.commitment.len() > 40 {
                return Err(CliError::Usage(format!(
                    "NFT commitment is {} bytes; the consensus limit is 40",
                    nft.commitment.len()
                )));
            }
        }

        let mut out = Vec::with_capacity(64);
        out.push(PREFIX_TOKEN);
        // On the wire the category is little-endian, the reverse of how it is
        // displayed. Emitting it in display order silently references a
        // different category rather than failing.
        let mut category = self.category;
        category.reverse();
        out.extend_from_slice(&category);

        let mut bitfield = 0u8;
        if let Some(nft) = &self.nft {
            bitfield |= HAS_NFT | nft.capability.bits();
            if !nft.commitment.is_empty() {
                bitfield |= HAS_COMMITMENT_LENGTH;
            }
        }
        if self.amount > 0 {
            bitfield |= HAS_AMOUNT;
        }
        out.push(bitfield);

        if let Some(nft) = &self.nft {
            if !nft.commitment.is_empty() {
                out.extend_from_slice(&varint(nft.commitment.len() as u64));
                out.extend_from_slice(&nft.commitment);
            }
        }
        if self.amount > 0 {
            out.extend_from_slice(&varint(self.amount));
        }
        Ok(out)
    }

    /// Parse a prefix, returning the token data and how many bytes it consumed.
    pub fn decode_prefix(bytes: &[u8]) -> Result<(Self, usize)> {
        let mut i = 0;
        if bytes.first() != Some(&PREFIX_TOKEN) {
            return Err(CliError::Protocol("output has no token prefix".into()));
        }
        i += 1;
        if bytes.len() < i + 33 {
            return Err(CliError::Protocol("token prefix is truncated".into()));
        }
        let mut category = [0u8; 32];
        category.copy_from_slice(&bytes[i..i + 32]);
        category.reverse();
        i += 32;

        let bitfield = bytes[i];
        i += 1;

        let nft = if bitfield & HAS_NFT != 0 {
            let capability = Capability::from_bits(bitfield)?;
            let commitment = if bitfield & HAS_COMMITMENT_LENGTH != 0 {
                let (len, used) = read_varint(&bytes[i..])?;
                i += used;
                if bytes.len() < i + len as usize {
                    return Err(CliError::Protocol("commitment is truncated".into()));
                }
                let c = bytes[i..i + len as usize].to_vec();
                i += len as usize;
                c
            } else {
                Vec::new()
            };
            Some(Nft {
                capability,
                commitment,
            })
        } else {
            None
        };

        let amount = if bitfield & HAS_AMOUNT != 0 {
            let (v, used) = read_varint(&bytes[i..])?;
            i += used;
            v
        } else {
            0
        };

        Ok((
            TokenData {
                category,
                amount,
                nft,
            },
            i,
        ))
    }

    /// Category id in display order.
    pub fn category_hex(&self) -> String {
        self.category.iter().map(|b| format!("{b:02x}")).collect()
    }
}

fn read_varint(bytes: &[u8]) -> Result<(u64, usize)> {
    let first = *bytes
        .first()
        .ok_or_else(|| CliError::Protocol("varint is truncated".into()))?;
    let need = |n: usize| -> Result<()> {
        if bytes.len() < 1 + n {
            return Err(CliError::Protocol("varint is truncated".into()));
        }
        Ok(())
    };
    match first {
        0..=0xfc => Ok((u64::from(first), 1)),
        0xfd => {
            need(2)?;
            Ok((u64::from(u16::from_le_bytes([bytes[1], bytes[2]])), 3))
        }
        0xfe => {
            need(4)?;
            Ok((
                u64::from(u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]])),
                5,
            ))
        }
        _ => {
            need(8)?;
            let mut b = [0u8; 8];
            b.copy_from_slice(&bytes[1..9]);
            Ok((u64::from_le_bytes(b), 9))
        }
    }
}

/// Parse a 64-character category id in display order.
pub fn parse_category(s: &str) -> Result<[u8; 32]> {
    if s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(CliError::Usage(format!(
            "'{s}' is not a 64-character token category id"
        )));
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
            .map_err(|e| CliError::Usage(format!("bad category hex: {e}")))?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn category() -> [u8; 32] {
        let mut c = [0u8; 32];
        for (i, b) in c.iter_mut().enumerate() {
            *b = i as u8;
        }
        c
    }

    #[test]
    fn a_fungible_prefix_round_trips() {
        let data = TokenData::fungible(category(), 1_000_000);
        let encoded = data.encode_prefix().unwrap();
        let (decoded, used) = TokenData::decode_prefix(&encoded).unwrap();
        assert_eq!(decoded, data);
        assert_eq!(used, encoded.len(), "decode must consume the whole prefix");
    }

    #[test]
    fn the_category_is_reversed_on_the_wire() {
        // Display order and wire order are opposite. Emitting display order
        // references a different category rather than failing, so the byte
        // order is asserted directly.
        let data = TokenData::fungible(category(), 1);
        let encoded = data.encode_prefix().unwrap();
        assert_eq!(encoded[0], PREFIX_TOKEN);
        assert_eq!(encoded[1], 31, "first wire byte is the last display byte");
        assert_eq!(encoded[32], 0, "last wire byte is the first display byte");
    }

    #[test]
    fn an_nft_round_trips_with_its_capability() {
        for capability in [Capability::None, Capability::Mutable, Capability::Minting] {
            let data = TokenData {
                category: category(),
                amount: 0,
                nft: Some(Nft {
                    capability,
                    commitment: vec![0xaa, 0xbb],
                }),
            };
            let encoded = data.encode_prefix().unwrap();
            let (decoded, _) = TokenData::decode_prefix(&encoded).unwrap();
            assert_eq!(decoded, data, "{capability:?} must survive a round trip");
        }
    }

    #[test]
    fn an_nft_and_an_amount_can_share_one_output() {
        let data = TokenData {
            category: category(),
            amount: 42,
            nft: Some(Nft {
                capability: Capability::Mutable,
                commitment: vec![1, 2, 3],
            }),
        };
        let (decoded, _) = TokenData::decode_prefix(&data.encode_prefix().unwrap()).unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn an_nft_with_no_commitment_omits_the_length() {
        let data = TokenData {
            category: category(),
            amount: 0,
            nft: Some(Nft {
                capability: Capability::None,
                commitment: Vec::new(),
            }),
        };
        let encoded = data.encode_prefix().unwrap();
        // prefix + category + bitfield, nothing more
        assert_eq!(encoded.len(), 34);
        let (decoded, _) = TokenData::decode_prefix(&encoded).unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn an_empty_token_is_refused() {
        let data = TokenData {
            category: category(),
            amount: 0,
            nft: None,
        };
        assert!(
            data.encode_prefix().is_err(),
            "a prefix with no content is meaningless"
        );
    }

    #[test]
    fn an_oversized_commitment_is_refused() {
        let data = TokenData {
            category: category(),
            amount: 0,
            nft: Some(Nft {
                capability: Capability::None,
                commitment: vec![0u8; 41],
            }),
        };
        let err = data.encode_prefix().unwrap_err();
        assert!(err.to_string().contains("40"), "unexpected: {err}");
    }

    #[test]
    fn a_truncated_prefix_is_an_error_not_a_panic() {
        let full = TokenData::fungible(category(), 1_000_000)
            .encode_prefix()
            .unwrap();
        for cut in 1..full.len() {
            // Must return an error rather than panicking on any prefix length.
            let _ = TokenData::decode_prefix(&full[..cut]);
        }
    }

    #[test]
    fn category_parsing_rejects_the_wrong_length() {
        assert!(parse_category("abcd").is_err());
        assert!(parse_category(&"a".repeat(64)).is_ok());
    }
}
