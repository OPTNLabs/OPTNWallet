// Transaction parsing + UTXO extraction for BIP37 SPV — Phase 3d.
//
// A merkleblock proves which txids are in a block; the node also sends the
// matching `tx` messages. Here we deserialize those txs (BCH has no segwit, so
// the serialization is the classic version/inputs/outputs/locktime) and derive,
// for the scripts the wallet watches:
//   - new outputs we own  -> UTXOs to add
//   - inputs that spend our outpoints -> UTXOs to remove
// The caller applies these to its persistent UTXO/history index.

use std::collections::HashSet;

use super::{double_sha256, read_u32, read_u64, read_varint, take};

pub struct TxInput {
    pub prev_txid: [u8; 32], // internal little-endian
    pub prev_vout: u32,
}

pub struct TxOutput {
    pub value: u64,
    pub script: Vec<u8>,
}

pub struct Tx {
    pub txid: [u8; 32], // internal little-endian (double-SHA256 of the tx bytes)
    pub inputs: Vec<TxInput>,
    pub outputs: Vec<TxOutput>,
}

/// Deserialize one transaction. Returns the tx and, via txid, the double-SHA256
/// over exactly the bytes consumed (so it's correct even if `data` carries more).
pub fn parse_tx(data: &[u8]) -> Result<Tx, String> {
    let mut pos = 0usize;
    let _version = read_u32(data, &mut pos)?;

    let in_count = read_varint(data, &mut pos)? as usize;
    let mut inputs = Vec::with_capacity(in_count.min(1 << 16));
    for _ in 0..in_count {
        let prev_txid: [u8; 32] = take(data, &mut pos, 32)?.try_into().unwrap();
        let prev_vout = read_u32(data, &mut pos)?;
        let script_len = read_varint(data, &mut pos)? as usize;
        take(data, &mut pos, script_len)?; // scriptSig — not needed here
        let _sequence = read_u32(data, &mut pos)?;
        inputs.push(TxInput {
            prev_txid,
            prev_vout,
        });
    }

    let out_count = read_varint(data, &mut pos)? as usize;
    let mut outputs = Vec::with_capacity(out_count.min(1 << 16));
    for _ in 0..out_count {
        let value = read_u64(data, &mut pos)?;
        let script_len = read_varint(data, &mut pos)? as usize;
        let script = take(data, &mut pos, script_len)?.to_vec();
        outputs.push(TxOutput { value, script });
    }

    let _locktime = read_u32(data, &mut pos)?;
    let txid = double_sha256(&data[..pos]);
    Ok(Tx {
        txid,
        inputs,
        outputs,
    })
}

/// If `script` is a standard P2PKH (OP_DUP OP_HASH160 <20> OP_EQUALVERIFY
/// OP_CHECKSIG), return the 20-byte public-key hash.
pub fn p2pkh_hash(script: &[u8]) -> Option<[u8; 20]> {
    if script.len() == 25
        && script[0] == 0x76 // OP_DUP
        && script[1] == 0xa9 // OP_HASH160
        && script[2] == 0x14 // push 20
        && script[23] == 0x88 // OP_EQUALVERIFY
        && script[24] == 0xac
    // OP_CHECKSIG
    {
        let mut h = [0u8; 20];
        h.copy_from_slice(&script[3..23]);
        Some(h)
    } else {
        None
    }
}

/// What a tx means for a wallet watching `watched` pubkey-hashes.
pub struct TxMatch {
    /// (vout, value, pubkey_hash) for outputs paying us — UTXOs to add.
    pub owned_outputs: Vec<(u32, u64, [u8; 20])>,
    /// (prev_txid, prev_vout) each input consumes — remove if it's one of ours.
    pub spent_outpoints: Vec<([u8; 32], u32)>,
}

pub fn match_tx(tx: &Tx, watched: &HashSet<[u8; 20]>) -> TxMatch {
    let owned_outputs = tx
        .outputs
        .iter()
        .enumerate()
        .filter_map(|(i, o)| {
            p2pkh_hash(&o.script)
                .filter(|h| watched.contains(h))
                .map(|h| (i as u32, o.value, h))
        })
        .collect();
    let spent_outpoints = tx
        .inputs
        .iter()
        .map(|i| (i.prev_txid, i.prev_vout))
        .collect();
    TxMatch {
        owned_outputs,
        spent_outpoints,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    // Real transaction (Bitcoin block 170, the first non-coinbase spend). Its
    // serialization is identical under BCH rules, so it validates the parser +
    // txid against a known value.
    const TX_170: &str = "0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd370400000000484730440220\
4e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d09\
01ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b\
8a0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84cc\
f9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000";

    #[test]
    fn parses_real_tx_and_txid() {
        let tx = parse_tx(&hex(TX_170)).unwrap();
        let txid: String = tx.txid.iter().rev().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            txid,
            "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16"
        );
        assert_eq!(tx.inputs.len(), 1);
        assert_eq!(tx.outputs.len(), 2);
        assert_eq!(tx.outputs[0].value, 1_000_000_000);
        assert_eq!(tx.outputs[1].value, 4_000_000_000);
    }

    #[test]
    fn matches_watched_p2pkh_output_and_ignores_others() {
        let mine = [0x11u8; 20];
        let theirs = [0x22u8; 20];
        // Build a tx with one input and two P2PKH outputs: one to us, one not.
        let p2pkh = |h: &[u8; 20]| {
            let mut s = vec![0x76, 0xa9, 0x14];
            s.extend_from_slice(h);
            s.extend_from_slice(&[0x88, 0xac]);
            s
        };
        let mut raw = Vec::new();
        raw.extend_from_slice(&1u32.to_le_bytes()); // version
        raw.push(1); // 1 input
        raw.extend_from_slice(&[9u8; 32]); // prev txid
        raw.extend_from_slice(&7u32.to_le_bytes()); // prev vout
        raw.push(0); // empty scriptSig
        raw.extend_from_slice(&0xffff_ffffu32.to_le_bytes()); // sequence
        raw.push(2); // 2 outputs
        raw.extend_from_slice(&500u64.to_le_bytes());
        let s0 = p2pkh(&mine);
        raw.push(s0.len() as u8);
        raw.extend_from_slice(&s0);
        raw.extend_from_slice(&999u64.to_le_bytes());
        let s1 = p2pkh(&theirs);
        raw.push(s1.len() as u8);
        raw.extend_from_slice(&s1);
        raw.extend_from_slice(&0u32.to_le_bytes()); // locktime

        let tx = parse_tx(&raw).unwrap();
        let watched: HashSet<[u8; 20]> = [mine].into_iter().collect();
        let m = match_tx(&tx, &watched);
        assert_eq!(m.owned_outputs, vec![(0u32, 500u64, mine)]);
        assert_eq!(m.spent_outpoints, vec![([9u8; 32], 7u32)]);
    }
}
