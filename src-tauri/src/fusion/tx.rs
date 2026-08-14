// CashFusion round — Phase 1.5: build the CoinJoin tx + sign our inputs.
//
// After the covert phase the server shares the full ordered component list; every
// player rebuilds the SAME transaction from it (tx_from_components) and signs
// only the inputs it contributed, submitting each 64-byte BCH-Schnorr signature
// covertly. The server assembles the fully-signed tx and broadcasts.
//
// Matched to Electron Cash util.py tx_from_components + the standard BCH BIP143
// (FORKID) sighash:
//   outputs[0] = OP_RETURN | 0x04 | FUSE_ID(4) | 0x20 | session_hash(32), value 0
//   then each output component (scriptpubkey, amount); inputs in component order.
//   sighash type = 0x41 (SIGHASH_ALL | SIGHASH_FORKID); sighash = dSHA256(preimage).
//
// Building only depends on the components, so it is fully unit-testable offline;
// on-chain validity is confirmed by broadcast (milestone 1.7 orchestration).

use prost::Message;
use ripemd::Ripemd160;
use sha2::{Digest, Sha256};

use super::pb;

/// FUSE_ID (protocol.py) — tags the session OP_RETURN so fusions are identifiable.
const FUSE_ID: [u8; 4] = *b"FUZ\x00";
/// SIGHASH_ALL | SIGHASH_FORKID.
const SIGHASH: u32 = 0x41;

fn sha256(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}
fn dsha256(b: &[u8]) -> [u8; 32] {
    sha256(&sha256(b))
}
fn hash160(b: &[u8]) -> [u8; 20] {
    Ripemd160::digest(sha256(b)).into()
}

/// CompactSize varint.
fn varint(n: u64, out: &mut Vec<u8>) {
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

/// A P2PKH scriptPubKey/scriptCode: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG.
fn p2pkh_script(hash160: &[u8; 20]) -> Vec<u8> {
    let mut s = Vec::with_capacity(25);
    s.extend_from_slice(&[0x76, 0xa9, 0x14]);
    s.extend_from_slice(hash160);
    s.extend_from_slice(&[0x88, 0xac]);
    s
}

#[derive(Debug, Clone)]
struct TxInput {
    prev_txid_wire: [u8; 32], // little-endian (wire) order, as stored in the component
    prev_index: u32,
    pubkey: Vec<u8>,
    value: u64,
}
#[derive(Debug, Clone)]
struct TxOutput {
    value: u64,
    script: Vec<u8>,
}

/// The CoinJoin transaction rebuilt from the shared component list, plus which
/// component index each input came from (so a player can find its own inputs).
pub struct FusionTx {
    version: u32,
    inputs: Vec<TxInput>,
    outputs: Vec<TxOutput>,
    /// input position i -> component index in all_components.
    pub input_component_idx: Vec<usize>,
}

impl FusionTx {
    /// Build the transaction from the ordered, serialized component list and the
    /// verified session hash (goes in the OP_RETURN marker).
    pub fn from_components(
        all_components: &[Vec<u8>],
        session_hash: &[u8; 32],
    ) -> Result<Self, String> {
        let mut inputs = Vec::new();
        let mut outputs = Vec::new();
        let mut input_component_idx = Vec::new();

        // Output 0: the session OP_RETURN marker.
        let mut op_return = vec![0x6a, 0x04];
        op_return.extend_from_slice(&FUSE_ID);
        op_return.push(0x20);
        op_return.extend_from_slice(session_hash);
        outputs.push(TxOutput {
            value: 0,
            script: op_return,
        });

        for (i, ser) in all_components.iter().enumerate() {
            let comp = pb::Component::decode(ser.as_slice())
                .map_err(|e| format!("component {i} decode: {e}"))?;
            match comp.component {
                Some(pb::component::Component::Input(inp)) => {
                    if inp.prev_txid.len() != 32 {
                        return Err(format!("component {i}: bad prevout length"));
                    }
                    let mut txid = [0u8; 32];
                    txid.copy_from_slice(&inp.prev_txid);
                    inputs.push(TxInput {
                        prev_txid_wire: txid,
                        prev_index: inp.prev_index,
                        pubkey: inp.pubkey,
                        value: inp.amount,
                    });
                    input_component_idx.push(i);
                }
                Some(pb::component::Component::Output(out)) => {
                    outputs.push(TxOutput {
                        value: out.amount,
                        script: out.scriptpubkey,
                    });
                }
                Some(pb::component::Component::Blank(_)) => {}
                None => return Err(format!("component {i}: empty")),
            }
        }
        Ok(Self {
            version: 1,
            inputs,
            outputs,
            input_component_idx,
        })
    }

    /// Build the explicit P2P-v3 transaction profile: version 2 and no
    /// Electron Cash FUZ marker. Display-order txids are converted to wire order.
    pub fn from_p2p(inputs: &[P2pInput], outputs: &[P2pOutput]) -> Result<Self, String> {
        if inputs.is_empty() || outputs.is_empty() {
            return Err("P2P Fusion requires at least one input and output".into());
        }
        let inputs = inputs
            .iter()
            .map(|input| {
                let mut txid = input.prev_txid;
                txid.reverse();
                Ok(TxInput {
                    prev_txid_wire: txid,
                    prev_index: input.prev_index,
                    pubkey: input.pubkey.clone(),
                    value: input.value,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let outputs = outputs
            .iter()
            .map(|output| TxOutput {
                value: output.value,
                script: output.script.clone(),
            })
            .collect();
        Ok(Self {
            version: 2,
            input_component_idx: Vec::new(),
            inputs,
            outputs,
        })
    }

    fn hash_prevouts(&self) -> [u8; 32] {
        let mut buf = Vec::with_capacity(self.inputs.len() * 36);
        for inp in &self.inputs {
            buf.extend_from_slice(&inp.prev_txid_wire);
            buf.extend_from_slice(&inp.prev_index.to_le_bytes());
        }
        dsha256(&buf)
    }
    fn hash_sequence(&self) -> [u8; 32] {
        // All sequences are 0xffffffff.
        let mut buf = Vec::with_capacity(self.inputs.len() * 4);
        for _ in &self.inputs {
            buf.extend_from_slice(&0xffff_ffffu32.to_le_bytes());
        }
        dsha256(&buf)
    }
    fn hash_outputs(&self) -> [u8; 32] {
        let mut buf = Vec::new();
        for out in &self.outputs {
            buf.extend_from_slice(&out.value.to_le_bytes());
            varint(out.script.len() as u64, &mut buf);
            buf.extend_from_slice(&out.script);
        }
        dsha256(&buf)
    }

    /// The BIP143 (FORKID) sighash for input `i`: dSHA256 of the preimage.
    pub fn sighash(&self, i: usize) -> Result<[u8; 32], String> {
        let inp = self.inputs.get(i).ok_or("input index out of range")?;
        let script_code = p2pkh_script(&hash160(&inp.pubkey));

        let mut pre = Vec::with_capacity(256);
        pre.extend_from_slice(&self.version.to_le_bytes());
        pre.extend_from_slice(&self.hash_prevouts());
        pre.extend_from_slice(&self.hash_sequence());
        // outpoint
        pre.extend_from_slice(&inp.prev_txid_wire);
        pre.extend_from_slice(&inp.prev_index.to_le_bytes());
        // scriptCode (length-prefixed)
        varint(script_code.len() as u64, &mut pre);
        pre.extend_from_slice(&script_code);
        // amount + sequence
        pre.extend_from_slice(&inp.value.to_le_bytes());
        pre.extend_from_slice(&0xffff_ffffu32.to_le_bytes());
        // hashOutputs + locktime + sighash type
        pre.extend_from_slice(&self.hash_outputs());
        pre.extend_from_slice(&0u32.to_le_bytes()); // locktime = 0
        pre.extend_from_slice(&SIGHASH.to_le_bytes());

        Ok(dsha256(&pre))
    }

    pub fn num_inputs(&self) -> usize {
        self.inputs.len()
    }
    /// The compressed/uncompressed pubkey declared for input `i`.
    pub fn input_pubkey(&self, i: usize) -> Option<&[u8]> {
        self.inputs.get(i).map(|inp| inp.pubkey.as_slice())
    }

    /// Serialize the fully-signed transaction. `input_sigs[i]` is the 64-byte
    /// Schnorr signature for input i (the SIGHASH byte 0x41 is appended here, and
    /// the P2PKH scriptSig `push(sig||0x41) push(pubkey)` is built).
    pub fn serialize(&self, input_sigs: &[Vec<u8>]) -> Result<Vec<u8>, String> {
        if input_sigs.len() != self.inputs.len() {
            return Err("signature count != input count".into());
        }
        let mut tx = Vec::new();
        tx.extend_from_slice(&self.version.to_le_bytes());
        varint(self.inputs.len() as u64, &mut tx);
        for (inp, sig) in self.inputs.iter().zip(input_sigs) {
            if sig.len() != 64 {
                return Err("each input signature must be 64 bytes".into());
            }
            tx.extend_from_slice(&inp.prev_txid_wire);
            tx.extend_from_slice(&inp.prev_index.to_le_bytes());
            // scriptSig: push(sig || 0x41) then push(pubkey)
            let mut script_sig = Vec::with_capacity(2 + 65 + inp.pubkey.len());
            script_sig.push(65); // len(sig 64 + sighash byte 1)
            script_sig.extend_from_slice(sig);
            script_sig.push(0x41);
            script_sig.push(inp.pubkey.len() as u8);
            script_sig.extend_from_slice(&inp.pubkey);
            varint(script_sig.len() as u64, &mut tx);
            tx.extend_from_slice(&script_sig);
            tx.extend_from_slice(&0xffff_ffffu32.to_le_bytes()); // sequence
        }
        varint(self.outputs.len() as u64, &mut tx);
        for out in &self.outputs {
            tx.extend_from_slice(&out.value.to_le_bytes());
            varint(out.script.len() as u64, &mut tx);
            tx.extend_from_slice(&out.script);
        }
        tx.extend_from_slice(&0u32.to_le_bytes()); // locktime
        Ok(tx)
    }

    /// The txid (display hex, big-endian) of the fully-signed transaction.
    pub fn txid(&self, input_sigs: &[Vec<u8>]) -> Result<String, String> {
        let raw = self.serialize(input_sigs)?;
        let mut h = dsha256(&raw);
        h.reverse();
        Ok(h.iter().map(|b| format!("{b:02x}")).collect())
    }

    /// Component index (into all_components) that input `i` came from.
    pub fn input_component_index(&self, i: usize) -> Option<usize> {
        self.input_component_idx.get(i).copied()
    }

    pub fn unsigned_template_hash(&self) -> [u8; 32] {
        let mut tx = Vec::new();
        tx.extend_from_slice(&self.version.to_le_bytes());
        varint(self.inputs.len() as u64, &mut tx);
        for input in &self.inputs {
            tx.extend_from_slice(&input.prev_txid_wire);
            tx.extend_from_slice(&input.prev_index.to_le_bytes());
            tx.push(0);
            tx.extend_from_slice(&0xffff_ffffu32.to_le_bytes());
        }
        varint(self.outputs.len() as u64, &mut tx);
        for output in &self.outputs {
            tx.extend_from_slice(&output.value.to_le_bytes());
            varint(output.script.len() as u64, &mut tx);
            tx.extend_from_slice(&output.script);
        }
        tx.extend_from_slice(&0u32.to_le_bytes());
        dsha256(&tx)
    }
}

#[derive(Debug, Clone)]
pub struct P2pInput {
    pub prev_txid: [u8; 32],
    pub prev_index: u32,
    pub pubkey: Vec<u8>,
    pub value: u64,
}

#[derive(Debug, Clone)]
pub struct P2pOutput {
    pub script: Vec<u8>,
    pub value: u64,
}

#[cfg(test)]
mod tests {
    use super::super::components::{build_round_commit, FusionInput, FusionOutput};
    use super::super::pedersen;
    use super::super::schnorr;
    use super::*;
    use k256::elliptic_curve::sec1::ToEncodedPoint;
    use k256::ProjectivePoint;

    fn p2pkh_out(tag: u8) -> Vec<u8> {
        p2pkh_script(&[tag; 20])
    }

    // Build a serialized input Component directly (bypassing commitments) for the
    // tx-shape tests.
    fn input_component(txid_wire: [u8; 32], vout: u32, pubkey: Vec<u8>, amount: u64) -> Vec<u8> {
        pb::Component {
            salt_commitment: vec![0u8; 32],
            component: Some(pb::component::Component::Input(pb::InputComponent {
                prev_txid: txid_wire.to_vec(),
                prev_index: vout,
                pubkey,
                amount,
            })),
        }
        .encode_to_vec()
    }
    fn output_component(script: Vec<u8>, amount: u64) -> Vec<u8> {
        pb::Component {
            salt_commitment: vec![0u8; 32],
            component: Some(pb::component::Component::Output(pb::OutputComponent {
                scriptpubkey: script,
                amount,
            })),
        }
        .encode_to_vec()
    }

    #[test]
    fn op_return_marker_is_first_output_and_well_formed() {
        let session = [0x5au8; 32];
        let comps = vec![output_component(p2pkh_out(1), 10_000)];
        let tx = FusionTx::from_components(&comps, &session).unwrap();
        assert_eq!(tx.outputs.len(), 2); // OP_RETURN + 1 output
        let s = &tx.outputs[0].script;
        assert_eq!(tx.outputs[0].value, 0);
        assert_eq!(s[0], 0x6a); // OP_RETURN
        assert_eq!(s[1], 0x04); // push 4
        assert_eq!(&s[2..6], b"FUZ\x00"); // FUSE_ID
        assert_eq!(s[6], 0x20); // push 32
        assert_eq!(&s[7..39], &session);
    }

    #[test]
    fn inputs_map_back_to_their_component_indices() {
        let session = [1u8; 32];
        let comps = vec![
            output_component(p2pkh_out(9), 5_000), // idx 0 -> output
            input_component([0xaa; 32], 0, vec![0x02; 33], 9_000), // idx 1 -> input
            input_component([0xbb; 32], 1, vec![0x03; 33], 8_000), // idx 2 -> input
        ];
        let tx = FusionTx::from_components(&comps, &session).unwrap();
        assert_eq!(tx.num_inputs(), 2);
        assert_eq!(tx.input_component_idx, vec![1, 2]);
        assert_eq!(tx.outputs.len(), 2); // OP_RETURN + 1
    }

    #[test]
    fn signs_own_input_and_the_signature_verifies_against_the_sighash() {
        // A real key/pubkey for the input, so the scriptCode hash160 is consistent.
        let priv_k = pedersen::random_nonce();
        let pubkey = schnorr::pubkey_compressed(priv_k).to_vec();

        let session = [7u8; 32];
        let comps = vec![
            input_component([0xcd; 32], 2, pubkey.clone(), 100_000),
            output_component(p2pkh_out(4), 90_000),
        ];
        let tx = FusionTx::from_components(&comps, &session).unwrap();

        let sighash = tx.sighash(0).unwrap();
        let sig = schnorr::sign(priv_k, &sighash);
        // The submitted 64-byte signature must verify under the input's pubkey.
        assert!(schnorr::verify(&pubkey, &sig, &sighash));
    }

    #[test]
    fn sighash_changes_with_the_session_hash() {
        // Different session_hash -> different OP_RETURN -> different hashOutputs ->
        // different sighash. This is what binds every player to the same tx.
        let pubkey = vec![0x02u8; 33];
        let make = |sess: [u8; 32]| {
            let c = vec![
                input_component([0xcd; 32], 0, pubkey.clone(), 50_000),
                output_component(p2pkh_out(4), 40_000),
            ];
            FusionTx::from_components(&c, &sess)
                .unwrap()
                .sighash(0)
                .unwrap()
        };
        assert_ne!(make([1u8; 32]), make([2u8; 32]));
    }

    #[test]
    fn full_flow_components_to_signed_input() {
        // End-to-end within our own code: build a PlayerCommit's components (1.3),
        // treat them as the shared list, rebuild the tx, and sign the input.
        let priv_k = pedersen::random_nonce();
        let pubkey = schnorr::pubkey_compressed(priv_k).to_vec();

        // Stub round signer for the blind requests (unused for tx, but build_round_commit needs it).
        let x = pedersen::random_nonce();
        let round_pub = schnorr::compressed(&(ProjectivePoint::GENERATOR * x)).to_vec();
        let nonce_pts: Vec<Vec<u8>> = (0..4)
            .map(|_| {
                let k = pedersen::random_nonce();
                let p = ProjectivePoint::GENERATOR * k;
                p.to_affine().to_encoded_point(true).as_bytes().to_vec()
            })
            .collect();

        let rc = build_round_commit(
            &[FusionInput {
                prev_txid: "cd".repeat(32),
                prev_index: 0,
                pubkey: pubkey.clone(),
                value: 100_000,
            }],
            &[FusionOutput {
                scriptpubkey: p2pkh_out(4),
                value: 90_000,
            }],
            4,
            1000,
            &round_pub,
            &nonce_pts,
        )
        .unwrap();

        // The server would share components; here use ours as the list.
        let tx = FusionTx::from_components(&rc.components_sorted, &[9u8; 32]).unwrap();
        assert_eq!(tx.num_inputs(), 1);
        let sighash = tx.sighash(0).unwrap();
        let sig = schnorr::sign(priv_k, &sighash);
        assert!(schnorr::verify(&pubkey, &sig, &sighash));
    }

    #[test]
    fn server_profile_remains_version_one_with_the_fuz_marker() {
        let tx = FusionTx::from_components(
            &[input_component([0x11; 32], 0, vec![0x02; 33], 10_000)],
            &[0x44; 32],
        )
        .unwrap();
        let raw = tx.serialize(&[vec![0x55; 64]]).unwrap();
        assert_eq!(&raw[..4], &1u32.to_le_bytes());
        assert_eq!(&tx.outputs[0].script[2..6], b"FUZ\0");
    }

    #[test]
    fn p2p_v3_profile_is_version_two_without_a_marker_and_uses_wire_txid_order() {
        let mut display_txid = [0u8; 32];
        for (index, byte) in display_txid.iter_mut().enumerate() {
            *byte = index as u8;
        }
        let tx = FusionTx::from_p2p(
            &[P2pInput {
                prev_txid: display_txid,
                prev_index: 3,
                pubkey: vec![0x02; 33],
                value: 10_000,
            }],
            &[P2pOutput {
                script: vec![0x51],
                value: 9_000,
            }],
        )
        .unwrap();
        let raw = tx.serialize(&[vec![0x55; 64]]).unwrap();
        assert_eq!(&raw[..4], &2u32.to_le_bytes());
        assert_eq!(tx.outputs.len(), 1);
        assert_eq!(
            &raw[5..37],
            display_txid.iter().rev().copied().collect::<Vec<_>>()
        );
    }
}
