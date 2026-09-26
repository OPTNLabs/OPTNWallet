//! Offline review of the exact parent outputs committed by a P2PKH PSBT.
//! Token conservation follows https://cashtokens.org/docs/spec/chip/#token-validation-algorithm.

use super::*;
use crate::{
    token::{Capability, Nft, TokenData, MAX_FUNGIBLE_AMOUNT},
    tx,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReviewedOutput {
    pub satoshis: u64,
    pub locking_bytecode_hex: String,
    #[serde(serialize_with = "serialize_token")]
    pub token: Option<TokenData>,
}

fn serialize_token<S: serde::Serializer>(
    token: &Option<TokenData>,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    token.as_ref().map(|t| serde_json::json!({"category":t.category_hex(), "amount":t.amount.to_string(), "nft":t.nft})).serialize(serializer)
}

/// Inventories, not inferred NFT identities: mutable/minting NFTs can change
/// commitment, so equal counts do not prove that no NFT was destroyed/replaced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CategoryReview {
    pub category: String,
    pub genesis: bool,
    /// Decimal strings keep large FT amounts exact across renderer boundaries.
    pub input_fungible: String,
    pub output_fungible: String,
    pub burned_fungible: String,
    pub input_nfts: Vec<Nft>,
    pub output_nfts: Vec<Nft>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct P2pkhReview {
    pub fee_satoshis: u64,
    /// In unsigned transaction input order, with parent hashes checked.
    pub spent_outputs: Vec<ReviewedOutput>,
    pub outputs: Vec<ReviewedOutput>,
    /// Eligible parent txids in display order. Eligibility alone is not genesis.
    pub genesis_candidates: Vec<String>,
    pub categories: Vec<CategoryReview>,
}

/// Validate and review before approval/signing. Chipnet, complete parents,
/// P2PKH inputs, explicit 0x41 only. No I/O, chain-state claims, or approval.
pub fn review_p2pkh(raw: &[u8], network: Network) -> Result<P2pkhReview> {
    if network != Network::Chipnet {
        return Err(CliError::Usage("PSBT review is chipnet-only".into()));
    }
    review_maps(&parse_maps(raw)?)
}

fn invalid(message: &str) -> CliError {
    CliError::Protocol(format!("PSBT review: {message}"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn reviewed(output: &tx::DecodedOutput) -> ReviewedOutput {
    ReviewedOutput {
        satoshis: output.value,
        locking_bytecode_hex: hex(&output.script_pubkey),
        token: output.token.clone(),
    }
}

pub(super) fn review_maps(maps: &ParsedMaps) -> Result<P2pkhReview> {
    if let Some(version) = field_value(&maps.global, GLOBAL_VERSION) {
        if version != compact_size(PSBT_VERSION_145) && version != [0, 0, 0, 0] {
            return Err(invalid("unsupported PSBT version"));
        }
    }
    let transaction = tx::decode(&maps.psbt.unsigned_tx)?;
    if transaction.inputs.is_empty() || transaction.outputs.is_empty() {
        return Err(invalid("empty transaction"));
    }
    let mut spent = Vec::with_capacity(transaction.inputs.len());
    let mut seen = BTreeSet::new();
    let mut genesis = BTreeSet::new();
    for (index, (txid, vout, sequence)) in transaction.inputs.iter().enumerate() {
        let fields = &maps.inputs[index];
        let metadata = &maps.psbt.inputs[index];
        if !seen.insert((*txid, *vout))
            || metadata.sighash_type != Some(SIGHASH_ALL_FORKID)
            || metadata.origins.len() != 1
            || fields.iter().any(|(k, _)| {
                matches!(
                    k[0],
                    IN_PARTIAL_SIG | IN_WITNESS_UTXO | IN_REDEEM_SCRIPT | 0x05 | 0x07 | 0x08
                )
            })
        {
            return Err(invalid(
                "requires unique P2PKH inputs, one origin, and explicit 0x41",
            ));
        }
        let mut display_txid = *txid;
        display_txid.reverse();
        if field_value(fields, IN_PREVIOUS_TXID).is_some_and(|v| v != display_txid)
            || field_value(fields, IN_OUTPUT_INDEX).is_some_and(|v| v != vout.to_le_bytes())
            || field_value(fields, IN_SEQUENCE).is_some_and(|v| v != sequence.to_le_bytes())
        {
            return Err(invalid("input metadata disagrees with transaction"));
        }
        let parent = field_value(fields, IN_NON_WITNESS_UTXO)
            .ok_or_else(|| invalid("full parent transaction required"))?;
        if tx::double_sha256(parent) != *txid {
            return Err(invalid("parent transaction hash mismatch"));
        }
        let parent = tx::decode(parent)?;
        let output = parent
            .outputs
            .get(*vout as usize)
            .ok_or_else(|| invalid("parent output index out of range"))?;
        let script = &output.script_pubkey;
        if script.len() != 25
            || script[..3] != [0x76, 0xa9, 0x14]
            || script[23..] != [0x88, 0xac]
            || script[3..23] != crate::hd::hash160(&metadata.origins[0].pubkey)
        {
            return Err(invalid("parent is not P2PKH for the committed public key"));
        }
        if *vout == 0 {
            genesis.insert(display_txid);
        }
        spent.push(reviewed(output));
    }
    for (fields, output) in maps.outputs.iter().zip(&transaction.outputs) {
        let prefix = output
            .token
            .as_ref()
            .map(TokenData::encode_prefix)
            .transpose()?;
        // Unlike optional v0 amount/script metadata, v145 token metadata must
        // exist exactly when tokens exist, and describe the exact same bytes.
        if field_value(fields, OUT_CASHTOKEN) != prefix.as_deref()
            || fields
                .iter()
                .any(|(k, _)| matches!(k[0], OUT_REDEEM_SCRIPT | 0x01))
            || field_value(fields, OUT_AMOUNT).is_some_and(|v| v != output.value.to_le_bytes())
            || field_value(fields, OUT_SCRIPT).is_some_and(|v| v != output.script_pubkey)
        {
            return Err(invalid("output metadata disagrees with transaction"));
        }
        for (key, value) in fields.iter().filter(|(k, _)| k[0] == OUT_BIP32_DERIVATION) {
            let origin = key_origin(0, key, value)?;
            let script = &output.script_pubkey;
            if script.len() != 25
                || script[..3] != [0x76, 0xa9, 0x14]
                || script[23..] != [0x88, 0xac]
                || script[3..23] != crate::hd::hash160(&origin.pubkey)
            {
                return Err(invalid("output origin does not control its P2PKH script"));
            }
        }
    }
    let outputs: Vec<_> = transaction.outputs.iter().map(reviewed).collect();
    let sum = |items: &[ReviewedOutput]| {
        items.iter().try_fold(0u64, |sum, o| {
            sum.checked_add(o.satoshis)
                .filter(|value| *value <= 2_100_000_000_000_000)
                .ok_or_else(|| invalid("BCH value outside monetary range"))
        })
    };
    let fee_satoshis = sum(&spent)?
        .checked_sub(sum(&outputs)?)
        .ok_or_else(|| invalid("outputs exceed input BCH"))?;
    let mut categories: BTreeMap<[u8; 32], (Vec<&TokenData>, Vec<&TokenData>)> = BTreeMap::new();
    for token in spent.iter().filter_map(|o| o.token.as_ref()) {
        categories.entry(token.category).or_default().0.push(token);
    }
    for token in outputs.iter().filter_map(|o| o.token.as_ref()) {
        categories.entry(token.category).or_default().1.push(token);
    }
    let categories = categories
        .into_iter()
        .map(|(category, (inputs, outputs))| {
            let total = |tokens: &[&TokenData]| {
                tokens.iter().try_fold(0u64, |sum, t| {
                    sum.checked_add(t.amount)
                        .ok_or_else(|| invalid("FT sum overflow"))
                })
            };
            let input_amount = total(&inputs)?;
            let output_amount = total(&outputs)?;
            let is_genesis = genesis.contains(&category);
            if output_amount > input_amount && !(is_genesis && output_amount <= MAX_FUNGIBLE_AMOUNT)
            {
                return Err(invalid(
                    "FT inflation: minting NFTs cannot create fungible supply",
                ));
            }
            let input_nfts: Vec<_> = inputs.iter().filter_map(|t| t.nft.clone()).collect();
            let output_nfts: Vec<_> = outputs.iter().filter_map(|t| t.nft.clone()).collect();
            if !is_genesis
                && !input_nfts
                    .iter()
                    .any(|n| n.capability == Capability::Minting)
            {
                let mut mutable = input_nfts
                    .iter()
                    .filter(|n| n.capability == Capability::Mutable)
                    .count();
                let mut immutable: BTreeMap<&[u8], usize> = BTreeMap::new();
                for nft in input_nfts
                    .iter()
                    .filter(|n| n.capability == Capability::None)
                {
                    *immutable.entry(&nft.commitment).or_default() += 1;
                }
                // Reserve mutable successors first, independently of output order.
                mutable = mutable
                    .checked_sub(
                        output_nfts
                            .iter()
                            .filter(|n| n.capability == Capability::Mutable)
                            .count(),
                    )
                    .ok_or_else(|| invalid("unauthorized mutable NFT creation"))?;
                for nft in &output_nfts {
                    match nft.capability {
                        Capability::Minting => {
                            return Err(invalid("unauthorized minting authority"))
                        }
                        Capability::Mutable => {}
                        Capability::None => {
                            let available = immutable.entry(&nft.commitment).or_default();
                            if *available > 0 {
                                *available -= 1;
                            } else {
                                mutable = mutable.checked_sub(1).ok_or_else(|| {
                                    invalid("unauthorized NFT creation or mutation")
                                })?;
                            }
                        }
                    }
                }
            }
            Ok(CategoryReview {
                category: hex(&category),
                genesis: is_genesis && inputs.is_empty() && !outputs.is_empty(),
                input_fungible: input_amount.to_string(),
                output_fungible: output_amount.to_string(),
                burned_fungible: input_amount.saturating_sub(output_amount).to_string(),
                input_nfts,
                output_nfts,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(P2pkhReview {
        fee_satoshis,
        spent_outputs: spent,
        outputs,
        genesis_candidates: genesis.iter().map(|c| hex(c)).collect(),
        categories,
    })
}

#[cfg(test)]
mod tests {
    use super::super::tests::encode_maps;
    use super::*;

    fn decode(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    #[test]
    fn token_display_and_signed_return_cannot_disagree_with_approved_transaction() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test-vectors/seedcash-cashtokens.json"
        ))
        .unwrap();
        let case = fixtures["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == "mega-mix-genesis-mint-mutate-ft-nft-burn")
            .unwrap();
        let original = decode(case["psbt_hex"].as_str().unwrap());
        let signed = decode(case["signed_psbt_hex"].as_str().unwrap());
        assert!(finalize_cash_tokens_p2pkh(&original, &signed, Network::Chipnet).is_ok());
        for missing in [false, true] {
            let mut before = parse_maps(&original).unwrap();
            let mut after = parse_maps(&signed).unwrap();
            for maps in [&mut before, &mut after] {
                let fields = &mut maps.outputs[0];
                if missing {
                    fields.retain(|(key, _)| key[0] != OUT_CASHTOKEN);
                } else {
                    fields
                        .iter_mut()
                        .find(|(key, _)| key[0] == OUT_CASHTOKEN)
                        .unwrap()
                        .1[1] ^= 1;
                }
            }
            assert!(review_p2pkh(&encode_maps(&before), Network::Chipnet).is_err());
            assert!(finalize_cash_tokens_p2pkh(
                &encode_maps(&before),
                &encode_maps(&after),
                Network::Chipnet
            )
            .is_err());
        }
        let mut returned = parse_maps(&signed).unwrap();
        for fields in &mut returned.inputs {
            fields.reverse();
        }
        returned.global.reverse();
        for fields in &mut returned.outputs {
            fields.reverse();
        }
        assert!(
            finalize_cash_tokens_p2pkh(&original, &encode_maps(&returned), Network::Chipnet)
                .is_ok()
        );
        // Keeping metadata but replacing a signed token transaction is refused.
        returned
            .global
            .iter_mut()
            .find(|(k, _)| k[0] == GLOBAL_UNSIGNED_TX)
            .unwrap()
            .1[0] ^= 1;
        assert!(
            finalize_cash_tokens_p2pkh(&original, &encode_maps(&returned), Network::Chipnet)
                .is_err()
        );
    }
}
