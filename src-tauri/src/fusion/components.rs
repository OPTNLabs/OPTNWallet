// CashFusion round — Phase 1.3: component + commitment construction.
//
// Turns the wallet's chosen inputs and fresh outputs into the `PlayerCommit`
// the player sends after `StartRound`, exactly as Electron Cash gen_components /
// run_round build it. Each component (input / output / blank) gets:
//   - a random 32-byte salt;   comp.salt_commitment = sha256(salt)
//   - a Pedersen commitment to its SIGNED amount (input +value-fee,
//     output -value-fee, blank 0), so the player's amounts sum to its excess fee
//   - a fresh communication keypair (compressed pubkey → InitialCommitment)
//   - InitialCommitment { salted_component_hash = sha256(salt||compser),
//                         amount_commitment (65-byte Pedersen point),
//                         communication_key }
//   - a blind-signature request over sha256(serialized component)
// The commitments are then SORTED by their serialized bytes to forget the
// input/output/blank ordering (a privacy step from the reference).
//
// This builds and commits only; it does not open covert connections, submit
// components, sign, or broadcast — those are milestones 1.4+.

use prost::Message;
use sha2::{Digest, Sha256};

use super::pb;
use super::pedersen;
use super::schnorr::{self, BlindSignatureRequest};

/// Electron Cash util.py fee/size formulas — must match exactly or the server
/// rejects the player's declared excess_fee.
fn component_fee(size: u64, feerate: u64) -> u64 {
    (size * feerate).div_ceil(1000) // sat/kB, rounded up — == reference (x+999)//1000
}
fn size_of_input(pubkey_len: usize) -> u64 {
    108 + pubkey_len as u64 // 141 for a compressed pubkey
}
fn size_of_output(script_len: usize) -> u64 {
    9 + script_len as u64 // 34 for P2PKH
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// One wallet input the player contributes (P2PKH). `prev_txid` is display hex
/// (big-endian, as shown in explorers); it is reversed for the wire.
#[derive(Debug, Clone)]
pub struct FusionInput {
    pub prev_txid: String,
    pub prev_index: u32,
    pub pubkey: Vec<u8>,
    pub value: u64,
}

/// One fusion output (a fresh HD/RPA address's scriptpubkey + value).
#[derive(Debug, Clone)]
pub struct FusionOutput {
    pub scriptpubkey: Vec<u8>,
    pub value: u64,
}

/// Everything produced for a round's commit phase. `player_commit` goes on the
/// wire; the rest is state the later phases need (finalizing blind sigs,
/// submitting components covertly, and building blame proofs).
pub struct RoundCommit {
    pub player_commit: pb::PlayerCommit,
    /// The phase-9 routing seed; its SHA256 is committed in `player_commit`.
    pub random_number: [u8; 32],
    /// Per sorted component, in the same order as `player_commit.initial_commitments`.
    pub requests: Vec<BlindSignatureRequest>,
    pub components_sorted: Vec<Vec<u8>>,
    /// (salt, pedersen_nonce) per sorted component — for the blame `Proof`.
    pub proofs: Vec<([u8; 32], [u8; 32])>,
    /// Canonical big-endian communication private scalar per sorted component.
    pub communication_private_keys: Vec<[u8; 32]>,
    pub excess_fee: u64,
}

fn hex_to_bytes(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("odd-length hex".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| "bad hex".to_string()))
        .collect()
}

/// Build the `PlayerCommit` (and retained state) for a round.
///
/// `num_components` and `feerate` come from the server; `round_pubkey` and
/// `blind_nonce_points` come from `StartRound` (one nonce point per component).
pub fn build_round_commit(
    inputs: &[FusionInput],
    outputs: &[FusionOutput],
    num_components: usize,
    feerate: u64,
    round_pubkey: &[u8],
    blind_nonce_points: &[Vec<u8>],
) -> Result<RoundCommit, String> {
    if inputs.len() + outputs.len() > num_components {
        return Err("more inputs+outputs than the tier's component count".into());
    }
    if blind_nonce_points.len() != num_components {
        return Err("blind nonce point count must equal num_components".into());
    }
    let num_blanks = num_components - inputs.len() - outputs.len();

    // (serialized Component, signed commit amount)
    let mut built: Vec<(Vec<u8>, i64)> = Vec::with_capacity(num_components);

    for inp in inputs {
        let mut txid = hex_to_bytes(&inp.prev_txid)?;
        if txid.len() != 32 {
            return Err("prev_txid must be 32 bytes".into());
        }
        txid.reverse(); // display (big-endian) -> wire (little-endian)
        let fee = component_fee(size_of_input(inp.pubkey.len()), feerate);
        let comp = pb::Component {
            salt_commitment: Vec::new(), // filled per-component below
            component: Some(pb::component::Component::Input(pb::InputComponent {
                prev_txid: txid,
                prev_index: inp.prev_index,
                pubkey: inp.pubkey.clone(),
                amount: inp.value,
            })),
        };
        built.push((
            encode_component_placeholder(comp),
            inp.value as i64 - fee as i64,
        ));
    }

    for out in outputs {
        let fee = component_fee(size_of_output(out.scriptpubkey.len()), feerate);
        let comp = pb::Component {
            salt_commitment: Vec::new(),
            component: Some(pb::component::Component::Output(pb::OutputComponent {
                scriptpubkey: out.scriptpubkey.clone(),
                amount: out.value,
            })),
        };
        built.push((
            encode_component_placeholder(comp),
            -(out.value as i64) - fee as i64,
        ));
    }

    for _ in 0..num_blanks {
        let comp = pb::Component {
            salt_commitment: Vec::new(),
            component: Some(pb::component::Component::Blank(pb::BlankComponent {})),
        };
        built.push((encode_component_placeholder(comp), 0));
    }

    // Per-component commitments. Rebuild each Component WITH its salt_commitment
    // set, serialize that (this is the exact bytes signed + hashed), commit to
    // its amount, and generate its communication key.
    struct Row {
        commit_ser: Vec<u8>, // serialized InitialCommitment (sort key)
        comp_ser: Vec<u8>,   // serialized Component (with salt_commitment)
        salt: [u8; 32],
        nonce: [u8; 32],
        nonce_scalar: k256::Scalar,
        communication_private_key: [u8; 32],
    }
    let mut rows: Vec<Row> = Vec::with_capacity(num_components);
    let mut excess: i64 = 0;

    for (comp_no_salt, commit_amount) in built {
        let salt = pedersen::random_32();
        // Re-decode, set salt_commitment, re-encode to get the canonical component bytes.
        let mut comp = pb::Component::decode(comp_no_salt.as_slice())
            .map_err(|e| format!("component re-decode: {e}"))?;
        comp.salt_commitment = sha256(&salt).to_vec();
        let comp_ser = comp.encode_to_vec();

        let commitment = pedersen::commit(commit_amount);
        excess += commit_amount;

        let (comm_privkey, comm_pub) = schnorr::gen_keypair();

        let init = pb::InitialCommitment {
            salted_component_hash: {
                let mut h = Sha256::new();
                h.update(salt);
                h.update(&comp_ser);
                let d: [u8; 32] = h.finalize().into();
                d.to_vec()
            },
            amount_commitment: commitment.p_uncompressed.to_vec(),
            communication_key: comm_pub.to_vec(),
        };
        rows.push(Row {
            commit_ser: init.encode_to_vec(),
            comp_ser,
            salt,
            nonce: commitment.nonce.to_bytes().into(),
            nonce_scalar: commitment.nonce,
            communication_private_key: comm_privkey.to_bytes().into(),
        });
    }

    if excess < 0 {
        return Err("excess fee is negative — outputs+fees exceed inputs".into());
    }
    let excess_fee = excess as u64;

    // Sort by serialized commitment to forget original order.
    rows.sort_by(|a, b| a.commit_ser.cmp(&b.commit_ser));

    // pedersen_total_nonce = Σ nonces mod n.
    let total_nonce = rows
        .iter()
        .fold(k256::Scalar::ZERO, |acc, r| acc + r.nonce_scalar);

    // One blind-sig request per component, over sha256(component), paired with
    // the server's nonce point at the same index.
    let mut requests = Vec::with_capacity(num_components);
    let mut blind_sig_requests = Vec::with_capacity(num_components);
    for (i, r) in rows.iter().enumerate() {
        let msg = sha256(&r.comp_ser);
        let req = BlindSignatureRequest::new(round_pubkey, &blind_nonce_points[i], msg)?;
        blind_sig_requests.push(req.request().to_vec());
        requests.push(req);
    }

    let random_number = pedersen::random_32();

    let player_commit = pb::PlayerCommit {
        initial_commitments: rows.iter().map(|r| r.commit_ser.clone()).collect(),
        excess_fee,
        pedersen_total_nonce: {
            let b: [u8; 32] = total_nonce.to_bytes().into();
            b.to_vec()
        },
        random_number_commitment: sha256(&random_number).to_vec(),
        blind_sig_requests,
    };

    Ok(RoundCommit {
        player_commit,
        random_number,
        requests,
        components_sorted: rows.iter().map(|r| r.comp_ser.clone()).collect(),
        proofs: rows.iter().map(|r| (r.salt, r.nonce)).collect(),
        communication_private_keys: rows.iter().map(|r| r.communication_private_key).collect(),
        excess_fee,
    })
}

/// Serialize a Component before its salt_commitment is set (placeholder empty),
/// so it can be re-decoded and finalized per-component. Kept as a helper to make
/// the two-pass build read clearly.
fn encode_component_placeholder(comp: pb::Component) -> Vec<u8> {
    comp.encode_to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::elliptic_curve::sec1::FromEncodedPoint;
    use k256::elliptic_curve::PrimeField;
    use k256::{AffinePoint, EncodedPoint, ProjectivePoint, Scalar};

    fn parse_uncompressed(b: &[u8]) -> ProjectivePoint {
        let ep = EncodedPoint::from_bytes(b).unwrap();
        ProjectivePoint::from(
            Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&ep)).unwrap(),
        )
    }

    // A stub round signer: round key x, and one nonce k per component.
    struct RoundSigner {
        x: Scalar,
        ks: Vec<Scalar>,
    }
    impl RoundSigner {
        fn new(n: usize) -> Self {
            Self {
                x: pedersen::random_nonce(),
                ks: (0..n).map(|_| pedersen::random_nonce()).collect(),
            }
        }
        fn pubkey(&self) -> Vec<u8> {
            schnorr::compressed(&(ProjectivePoint::GENERATOR * self.x)).to_vec()
        }
        fn nonce_points(&self) -> Vec<Vec<u8>> {
            self.ks
                .iter()
                .map(|k| schnorr::compressed(&(ProjectivePoint::GENERATOR * k)).to_vec())
                .collect()
        }
        fn sign(&self, i: usize, ebytes: &[u8; 32]) -> [u8; 32] {
            let e = schnorr::scalar_reduce(*ebytes);
            (self.ks[i] + e * self.x).to_bytes().into()
        }
    }

    fn p2pkh(hash20: u8) -> Vec<u8> {
        // OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG — 25 bytes.
        let mut s = vec![0x76, 0xa9, 0x14];
        s.extend_from_slice(&[hash20; 20]);
        s.extend_from_slice(&[0x88, 0xac]);
        s
    }

    #[test]
    fn canonical_input_component_matches_electron_cash_protobuf_wire_vector() {
        // fusion.proto is vendored from Electron Cash. Lock the exact proto2
        // field order, integer encoding, and wire-order txid so a future model
        // or serializer change cannot silently fork component credentials.
        let component = pb::Component {
            salt_commitment: vec![0x11; 32],
            component: Some(pb::component::Component::Input(pb::InputComponent {
                prev_txid: vec![0xaa; 32],
                prev_index: 3,
                pubkey: vec![0x02; 33],
                amount: 200_000,
            })),
        };
        assert_eq!(
            hex::encode(component.encode_to_vec()),
            concat!(
                "0a20",
                "1111111111111111111111111111111111111111111111111111111111111111",
                "124b0a20",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "10031a21",
                "020202020202020202020202020202020202020202020202020202020202020202",
                "20c09a0c"
            )
        );
    }

    #[test]
    fn commitments_sum_to_excess_fee_the_servers_balance_check() {
        let feerate = 1000u64;
        let inputs = vec![FusionInput {
            prev_txid: "aa".repeat(32),
            prev_index: 0,
            pubkey: vec![0x02; 33],
            value: 100_000,
        }];
        let outputs = vec![FusionOutput {
            scriptpubkey: p2pkh(1),
            value: 50_000,
        }];
        let num_components = 6;
        let signer = RoundSigner::new(num_components);

        let rc = build_round_commit(
            &inputs,
            &outputs,
            num_components,
            feerate,
            &signer.pubkey(),
            &signer.nonce_points(),
        )
        .unwrap();

        // Expected excess: (100000 - 50000) - input_fee - output_fee.
        let in_fee = (size_of_input(33) * feerate).div_ceil(1000); // size 141
        let out_fee = (size_of_output(25) * feerate).div_ceil(1000); // size 34
        assert_eq!(rc.excess_fee, 100_000 - 50_000 - in_fee - out_fee);

        // THE server-side balance check: Σ amount_commitments == excess_fee*H + total_nonce*G.
        let sum = rc
            .player_commit
            .initial_commitments
            .iter()
            .map(|cs| {
                let c = pb::InitialCommitment::decode(cs.as_slice()).unwrap();
                parse_uncompressed(&c.amount_commitment)
            })
            .fold(ProjectivePoint::IDENTITY, |acc, p| acc + p);

        let nonce_bytes: [u8; 32] = rc
            .player_commit
            .pedersen_total_nonce
            .clone()
            .try_into()
            .unwrap();
        let total_nonce = Option::<Scalar>::from(Scalar::from_repr(nonce_bytes.into())).unwrap();
        let expected = pedersen::h_point() * Scalar::from(rc.excess_fee)
            + ProjectivePoint::GENERATOR * total_nonce;
        assert_eq!(
            sum, expected,
            "Pedersen sum must equal excess_fee*H + Σnonce*G"
        );
    }

    #[test]
    fn blind_requests_finalize_to_valid_component_signatures() {
        let feerate = 1000u64;
        let inputs = vec![FusionInput {
            prev_txid: "bb".repeat(32),
            prev_index: 3,
            pubkey: vec![0x03; 33],
            value: 200_000,
        }];
        let outputs = vec![FusionOutput {
            scriptpubkey: p2pkh(9),
            value: 120_000,
        }];
        let num_components = 5;
        let signer = RoundSigner::new(num_components);

        let rc = build_round_commit(
            &inputs,
            &outputs,
            num_components,
            feerate,
            &signer.pubkey(),
            &signer.nonce_points(),
        )
        .unwrap();

        // Each request, when signed by the round signer and finalized, must be a
        // valid BCH Schnorr sig over sha256(component) under round_pubkey.
        for (i, req) in rc.requests.iter().enumerate() {
            let s = signer.sign(i, &req.request());
            let sig = req.finalize(&s, true).expect("finalize");
            let msg = sha256(&rc.components_sorted[i]);
            assert!(schnorr::verify(&signer.pubkey(), &sig, &msg));
        }
    }

    #[test]
    fn commitments_are_sorted_and_counts_line_up() {
        let signer = RoundSigner::new(4);
        let rc = build_round_commit(
            &[FusionInput {
                prev_txid: "cc".repeat(32),
                prev_index: 0,
                pubkey: vec![0x02; 33],
                value: 500_000,
            }],
            &[FusionOutput {
                scriptpubkey: p2pkh(2),
                value: 100_000,
            }],
            4,
            1000,
            &signer.pubkey(),
            &signer.nonce_points(),
        )
        .unwrap();

        assert_eq!(rc.player_commit.initial_commitments.len(), 4);
        assert_eq!(rc.player_commit.blind_sig_requests.len(), 4);
        assert_eq!(rc.components_sorted.len(), 4);
        let mut sorted = rc.player_commit.initial_commitments.clone();
        sorted.sort();
        assert_eq!(
            sorted, rc.player_commit.initial_commitments,
            "must be sorted"
        );
        assert_eq!(rc.player_commit.random_number_commitment.len(), 32);
        assert_eq!(
            rc.player_commit.random_number_commitment,
            sha256(&rc.random_number)
        );
        assert_eq!(rc.communication_private_keys.len(), 4);
        assert_eq!(rc.player_commit.pedersen_total_nonce.len(), 32);
    }

    #[test]
    fn rejects_too_many_components() {
        let signer = RoundSigner::new(1);
        let r = build_round_commit(
            &[FusionInput {
                prev_txid: "dd".repeat(32),
                prev_index: 0,
                pubkey: vec![0x02; 33],
                value: 10,
            }],
            &[FusionOutput {
                scriptpubkey: p2pkh(1),
                value: 5,
            }],
            1,
            1000,
            &signer.pubkey(),
            &signer.nonce_points(),
        );
        assert!(r.is_err());
    }
}
