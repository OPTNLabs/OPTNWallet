// Classic BCH transaction parsing used by the BIP37 scanner.

use super::{double_sha256, read_u32, read_u64, read_varint, take};
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct TxInput {
    pub prev_txid: [u8; 32],
    pub prev_vout: u32,
}
#[derive(Debug, Clone)]
pub struct TxOutput {
    pub value: u64,
    pub script: Vec<u8>,
}
#[derive(Debug, Clone)]
pub struct Tx {
    pub txid: [u8; 32],
    pub raw: Vec<u8>,
    pub inputs: Vec<TxInput>,
    pub outputs: Vec<TxOutput>,
}

pub fn parse_tx(data: &[u8]) -> Result<Tx, String> {
    let mut pos = 0usize;
    let _version = read_u32(data, &mut pos)?;
    let in_count = read_varint(data, &mut pos)? as usize;
    let mut inputs = Vec::with_capacity(in_count.min(1 << 16));
    for _ in 0..in_count {
        let prev_txid = take(data, &mut pos, 32)?.try_into().unwrap();
        let prev_vout = read_u32(data, &mut pos)?;
        let script_len = read_varint(data, &mut pos)? as usize;
        take(data, &mut pos, script_len)?;
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
    let raw = data[..pos].to_vec();
    let txid = double_sha256(&raw);
    Ok(Tx {
        txid,
        raw,
        inputs,
        outputs,
    })
}

pub fn p2pkh_hash(script: &[u8]) -> Option<[u8; 20]> {
    if script.len() == 25
        && script[0] == 0x76
        && script[1] == 0xa9
        && script[2] == 0x14
        && script[23] == 0x88
        && script[24] == 0xac
    {
        let mut h = [0u8; 20];
        h.copy_from_slice(&script[3..23]);
        Some(h)
    } else {
        None
    }
}

pub struct TxMatch {
    pub owned_outputs: Vec<(u32, u64, [u8; 20])>,
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

    #[test]
    fn matches_p2pkh_output() {
        let mine = [0x11u8; 20];
        let mut raw = Vec::new();
        raw.extend_from_slice(&1u32.to_le_bytes());
        raw.push(1);
        raw.extend_from_slice(&[9u8; 32]);
        raw.extend_from_slice(&7u32.to_le_bytes());
        raw.push(0);
        raw.extend_from_slice(&0xffff_ffffu32.to_le_bytes());
        raw.push(1);
        raw.extend_from_slice(&500u64.to_le_bytes());
        let mut script = vec![0x76, 0xa9, 0x14];
        script.extend_from_slice(&mine);
        script.extend_from_slice(&[0x88, 0xac]);
        raw.push(script.len() as u8);
        raw.extend_from_slice(&script);
        raw.extend_from_slice(&0u32.to_le_bytes());
        let tx = parse_tx(&raw).unwrap();
        let watched: HashSet<[u8; 20]> = [mine].into_iter().collect();
        let m = match_tx(&tx, &watched);
        assert_eq!(m.owned_outputs, vec![(0, 500, mine)]);
    }
}
