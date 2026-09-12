//! BCH compact-filter contents, as BCHD actually builds them.
//!
//! This is **not** Bitcoin Core's BIP158. Both constructions can detect a
//! spend: Core's final revision does it by including the previous *output
//! script*, while BCH kept the earlier form and includes the serialized spent
//! *outpoint*. The problem is not that one of them cannot see spends -- it is
//! that they watch for different bytes, so a client built to Core's rules
//! queries the wrong entries against a BCH filter and matches nothing.
//!
//! `BuildBasicFilter` in `gcash/bchutil` (`gcs/builder/builder.go`, pinned by
//! `gcash/bchd` at `v0.0.0-20260423044137-a3c041e4cc77`) adds, in order:
//!
//! * for every transaction **except the coinbase**, each input's serialized
//!   `PreviousOutPoint`, skipping any that serializes empty;
//! * for **every** transaction including the coinbase, each output's
//!   `PkScript`, skipping empty ones.
//!
//! The filter key is the block hash. A mempool filter is the same construction
//! with a zero key over a synthetic block whose first transaction is an empty
//! placeholder, which is why unconfirmed matching is a separate path from
//! confirmed-history verification rather than a special case of it.
//!
//! Keeping this explicit is the point: it is the definition a wallet's local
//! matching has to mirror, and it stays true whether or not SHV is available.

use std::collections::BTreeSet;

use optn_runtime::chain_service::ChainBackendError;

use super::{read_u32, read_varint, take};

/// Serialized outpoint: 32-byte txid then 4-byte little-endian index, which is
/// what `PreviousOutPoint.Serialize` writes and therefore what lands in the
/// filter.
pub fn serialize_outpoint(txid: &[u8; 32], vout: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(36);
    out.extend_from_slice(txid);
    out.extend_from_slice(&vout.to_le_bytes());
    out
}

/// What a wallet watches for, in the two shapes a BCH basic filter can carry.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WatchSet {
    pub scripts: Vec<Vec<u8>>,
    pub outpoints: BTreeSet<([u8; 32], u32)>,
}

impl WatchSet {
    /// The filter query entries for this watch set: raw scripts and serialized
    /// outpoints, exactly the byte strings `AddEntry` receives on the node.
    pub fn query_entries(&self) -> Vec<Vec<u8>> {
        let mut entries: Vec<Vec<u8>> = self
            .scripts
            .iter()
            .filter(|script| !script.is_empty())
            .cloned()
            .collect();
        entries.extend(
            self.outpoints
                .iter()
                .map(|(txid, vout)| serialize_outpoint(txid, *vout)),
        );
        entries
    }
}

/// Rebuild the entry set BCHD would have put in a block's basic filter.
///
/// Used to check a served filter against the block it claims to describe, and
/// as the reference the wallet's own matching is held to. Parsing is
/// deliberately strict: a block that does not decode cleanly produces an error
/// rather than a partial entry set that would look like a non-match.
pub fn basic_filter_entries(block: &[u8]) -> Result<Vec<Vec<u8>>, ChainBackendError> {
    let mut pos = 80usize;
    if block.len() < 80 {
        return Err(ChainBackendError::InvalidResponse(
            "block shorter than 80 bytes".into(),
        ));
    }
    let count = read_varint(block, &mut pos)?;
    if count == 0 || count > 10_000_000 {
        return Err(ChainBackendError::InvalidResponse(
            "invalid block transaction count".into(),
        ));
    }
    let mut entries = Vec::new();
    for index in 0..count {
        // The coinbase input spends the null outpoint, which BCHD never adds.
        let is_coinbase = index == 0;
        collect_transaction_entries(block, &mut pos, is_coinbase, &mut entries)?;
    }
    Ok(entries)
}

fn collect_transaction_entries(
    data: &[u8],
    pos: &mut usize,
    is_coinbase: bool,
    entries: &mut Vec<Vec<u8>>,
) -> Result<(), ChainBackendError> {
    take(data, pos, 4)?; // version
    let input_count = read_varint(data, pos)?;
    if input_count > 1_000_000 {
        return Err(ChainBackendError::InvalidResponse(
            "too many tx inputs".into(),
        ));
    }
    for _ in 0..input_count {
        let prev_txid: [u8; 32] = take(data, pos, 32)?.try_into().expect("fixed slice");
        let vout = read_u32(data, pos)?;
        if !is_coinbase {
            entries.push(serialize_outpoint(&prev_txid, vout));
        }
        let script_len = usize::try_from(read_varint(data, pos)?)
            .map_err(|_| ChainBackendError::InvalidResponse("script length overflow".into()))?;
        take(data, pos, script_len)?;
        take(data, pos, 4)?; // sequence
    }
    let output_count = read_varint(data, pos)?;
    if output_count > 1_000_000 {
        return Err(ChainBackendError::InvalidResponse(
            "too many tx outputs".into(),
        ));
    }
    for _ in 0..output_count {
        take(data, pos, 8)?; // value
        let script_len = usize::try_from(read_varint(data, pos)?)
            .map_err(|_| ChainBackendError::InvalidResponse("script length overflow".into()))?;
        let script = take(data, pos, script_len)?;
        // BCHD skips empty output scripts, so a wallet must not expect one.
        if !script.is_empty() {
            entries.push(script.to_vec());
        }
    }
    take(data, pos, 4)?; // locktime
    Ok(())
}

#[cfg(test)]
pub(crate) mod fixtures {
    //! Deterministic block builders shared by the filter vectors.

    use optn_core::header_hash::sha256d;

    pub fn varint(value: u64) -> Vec<u8> {
        if value < 0xfd {
            vec![value as u8]
        } else if value <= 0xffff {
            let mut out = vec![0xfd];
            out.extend_from_slice(&(value as u16).to_le_bytes());
            out
        } else {
            let mut out = vec![0xfe];
            out.extend_from_slice(&(value as u32).to_le_bytes());
            out
        }
    }

    pub struct TxIn {
        pub prev_txid: [u8; 32],
        pub vout: u32,
    }

    pub struct TxOut {
        pub value: u64,
        pub script: Vec<u8>,
    }

    pub fn transaction(inputs: &[TxIn], outputs: &[TxOut]) -> Vec<u8> {
        let mut raw = Vec::new();
        raw.extend_from_slice(&2u32.to_le_bytes());
        raw.extend_from_slice(&varint(inputs.len() as u64));
        for input in inputs {
            raw.extend_from_slice(&input.prev_txid);
            raw.extend_from_slice(&input.vout.to_le_bytes());
            raw.extend_from_slice(&varint(0)); // empty scriptSig
            raw.extend_from_slice(&0xffff_ffffu32.to_le_bytes());
        }
        raw.extend_from_slice(&varint(outputs.len() as u64));
        for output in outputs {
            raw.extend_from_slice(&output.value.to_le_bytes());
            raw.extend_from_slice(&varint(output.script.len() as u64));
            raw.extend_from_slice(&output.script);
        }
        raw.extend_from_slice(&0u32.to_le_bytes());
        raw
    }

    /// A coinbase: one input spending the null outpoint.
    pub fn coinbase(outputs: &[TxOut]) -> Vec<u8> {
        transaction(
            &[TxIn {
                prev_txid: [0u8; 32],
                vout: 0xffff_ffff,
            }],
            outputs,
        )
    }

    pub fn block(transactions: &[Vec<u8>]) -> Vec<u8> {
        let mut raw = vec![0u8; 80];
        raw[0..4].copy_from_slice(&1u32.to_le_bytes());
        raw.extend_from_slice(&varint(transactions.len() as u64));
        for tx in transactions {
            raw.extend_from_slice(tx);
        }
        raw
    }

    pub fn txid(tx: &[u8]) -> [u8; 32] {
        sha256d(tx)
    }

    /// P2PKH for a made-up 20-byte hash, so scripts in the vectors look like
    /// scripts rather than arbitrary bytes.
    pub fn p2pkh(tag: u8) -> Vec<u8> {
        let mut script = vec![0x76, 0xa9, 0x14];
        script.extend_from_slice(&[tag; 20]);
        script.extend_from_slice(&[0x88, 0xac]);
        script
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    /// Receive: the wallet is paid, so its output script is in the filter.
    #[test]
    fn a_receive_is_matched_by_the_output_script() {
        let ours = p2pkh(0x11);
        let theirs = p2pkh(0x22);
        let receive = transaction(
            &[TxIn {
                prev_txid: [9u8; 32],
                vout: 0,
            }],
            &[
                TxOut {
                    value: 50_000,
                    script: ours.clone(),
                },
                TxOut {
                    value: 10_000,
                    script: theirs,
                },
            ],
        );
        let raw = block(&[
            coinbase(&[TxOut {
                value: 1,
                script: p2pkh(0xcb),
            }]),
            receive,
        ]);
        let entries = basic_filter_entries(&raw).expect("block parses");

        assert!(entries.contains(&ours), "our output script is an entry");

        let watch = WatchSet {
            scripts: vec![ours],
            outpoints: BTreeSet::new(),
        };
        assert!(
            watch
                .query_entries()
                .iter()
                .any(|entry| entries.contains(entry)),
            "a receive-only wallet matches this block"
        );
    }

    /// Spend: the wallet's coin is consumed, so the *serialized outpoint* is in
    /// the filter -- where Core's BIP158 would instead have carried the
    /// previous output's script.
    #[test]
    fn a_spend_is_matched_by_the_serialized_outpoint() {
        let ours = p2pkh(0x11);
        let funding = transaction(
            &[TxIn {
                prev_txid: [9u8; 32],
                vout: 0,
            }],
            &[TxOut {
                value: 50_000,
                script: ours.clone(),
            }],
        );
        let funding_txid = txid(&funding);
        let spend = transaction(
            &[TxIn {
                prev_txid: funding_txid,
                vout: 0,
            }],
            &[TxOut {
                value: 40_000,
                script: p2pkh(0x33),
            }],
        );
        let raw = block(&[
            coinbase(&[TxOut {
                value: 1,
                script: p2pkh(0xcb),
            }]),
            spend,
        ]);
        let entries = basic_filter_entries(&raw).expect("block parses");

        let expected = serialize_outpoint(&funding_txid, 0);
        assert!(
            entries.contains(&expected),
            "the spent outpoint is an entry"
        );
        // Our script appears nowhere in the spending block's own outputs, so
        // the outpoint is the only thing here that identifies the spend. Core
        // would have covered this case with the previous output's script
        // instead; BCH covers it with this outpoint, and a client has to query
        // whichever one the filter was actually built from.
        assert!(!entries.contains(&ours));

        let watch = WatchSet {
            scripts: vec![ours],
            outpoints: BTreeSet::from([(funding_txid, 0)]),
        };
        assert!(watch
            .query_entries()
            .iter()
            .any(|entry| entries.contains(entry)));
    }

    /// Restore: a rescanning wallet watches both shapes across a range, and
    /// must match the funding block and the spending block.
    #[test]
    fn a_restore_matches_both_the_funding_and_the_spending_block() {
        let ours = p2pkh(0x11);
        let funding = transaction(
            &[TxIn {
                prev_txid: [9u8; 32],
                vout: 0,
            }],
            &[TxOut {
                value: 50_000,
                script: ours.clone(),
            }],
        );
        let funding_txid = txid(&funding);
        let spend = transaction(
            &[TxIn {
                prev_txid: funding_txid,
                vout: 0,
            }],
            &[TxOut {
                value: 40_000,
                script: p2pkh(0x33),
            }],
        );
        let cb = coinbase(&[TxOut {
            value: 1,
            script: p2pkh(0xcb),
        }]);
        let funding_block = basic_filter_entries(&block(&[cb.clone(), funding])).unwrap();
        let spending_block = basic_filter_entries(&block(&[cb, spend])).unwrap();

        let watch = WatchSet {
            scripts: vec![ours],
            outpoints: BTreeSet::from([(funding_txid, 0)]),
        };
        let entries = watch.query_entries();
        for (label, block_entries) in [("funding", funding_block), ("spending", spending_block)] {
            assert!(
                entries.iter().any(|entry| block_entries.contains(entry)),
                "restore must match the {label} block"
            );
        }
    }

    /// The coinbase spends the null outpoint and BCHD never adds it, so a
    /// client must not expect a filter to lead it there.
    #[test]
    fn the_coinbase_outpoint_is_never_an_entry() {
        let raw = block(&[coinbase(&[TxOut {
            value: 1,
            script: p2pkh(0xcb),
        }])]);
        let entries = basic_filter_entries(&raw).expect("block parses");

        let null_outpoint = serialize_outpoint(&[0u8; 32], 0xffff_ffff);
        assert!(!entries.contains(&null_outpoint));
        // The coinbase *output* script is still an entry.
        assert!(entries.contains(&p2pkh(0xcb)));
        assert_eq!(entries.len(), 1);
    }

    /// An empty output script is skipped, so watching for one can never match.
    #[test]
    fn empty_output_scripts_are_skipped() {
        let tx = transaction(
            &[TxIn {
                prev_txid: [7u8; 32],
                vout: 1,
            }],
            &[
                TxOut {
                    value: 0,
                    script: Vec::new(),
                },
                TxOut {
                    value: 5,
                    script: p2pkh(0x44),
                },
            ],
        );
        let raw = block(&[
            coinbase(&[TxOut {
                value: 1,
                script: p2pkh(0xcb),
            }]),
            tx,
        ]);
        let entries = basic_filter_entries(&raw).expect("block parses");

        assert!(!entries.iter().any(|entry| entry.is_empty()));
        assert!(entries.contains(&p2pkh(0x44)));
        assert!(entries.contains(&serialize_outpoint(&[7u8; 32], 1)));

        // A watch set cannot smuggle an empty script into a query either.
        let watch = WatchSet {
            scripts: vec![Vec::new()],
            outpoints: BTreeSet::new(),
        };
        assert!(watch.query_entries().is_empty());
    }

    #[test]
    fn a_malformed_block_is_an_error_not_an_empty_entry_set() {
        let raw = block(&[coinbase(&[TxOut {
            value: 1,
            script: p2pkh(0xcb),
        }])]);
        assert!(basic_filter_entries(&raw[..40]).is_err(), "short header");
        for cut in 81..raw.len() {
            assert!(
                basic_filter_entries(&raw[..cut]).is_err(),
                "truncating to {cut} must not look like a clean non-match"
            );
        }
    }
}
