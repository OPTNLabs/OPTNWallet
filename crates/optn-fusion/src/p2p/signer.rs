//! The production signer: the native `p2p-v3` signing boundary
//! (`crate::p2p_sign`), reached exactly as the desktop reaches it
//! (`FusionP2pService.ts` `nativeSignP2pInputs`).
//!
//! The boundary rebuilds the whole template, repeats the owned input and
//! output checks and the fee bounds, and binds the signature request to a
//! transcript of the round, so a signature is released only for the
//! transaction this peer approved.

use std::collections::HashMap;

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::assemble::{Assembled, Contribution, MAX_FEE_FACTOR};
use super::wire::{InputSig, PoolNetwork};
use super::{hex, unhex_array};
use crate::p2p_sign::{
    sign_p2p, P2pOwnedInput, P2pOwnedOutput, P2pSignInput, P2pSignOutput, P2pSignRequest,
};

/// What the round transcript commits to, in the order the TypeScript writes
/// it.
#[derive(Serialize)]
struct Transcript<'a> {
    protocol: &'static str,
    network: &'static str,
    session: &'a str,
    tier: u64,
    feerate: u64,
    participants: Vec<String>,
    inputs: Vec<TranscriptInput>,
    outputs: Vec<TranscriptOutput>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptInput {
    prev_txid: String,
    prev_index: u32,
    value: u64,
    pubkey: String,
}

#[derive(Serialize)]
struct TranscriptOutput {
    script: String,
    value: u64,
}

/// The round a signature is for.
pub struct SigningRound<'a> {
    pub network: PoolNetwork,
    pub session: &'a str,
    pub participants: &'a [String],
    pub tier: u64,
    pub feerate: u64,
}

/// Sign this wallet's inputs of `tx` through the native boundary. `keys`
/// maps each owned input's compressed pubkey (hex) to its secret.
pub fn sign_native(
    tx: &Assembled,
    mine: &Contribution,
    keys: &HashMap<String, [u8; 32]>,
    round: &SigningRound<'_>,
) -> Result<Vec<InputSig>, String> {
    let session = round.session.to_ascii_lowercase();
    let session_bytes =
        unhex_array::<32>(&session).ok_or("P2P Fusion signing session must be 32-byte hex.")?;
    let mut participants: Vec<String> = round
        .participants
        .iter()
        .map(|key| key.to_ascii_lowercase())
        .collect();
    participants.sort();
    let transcript = Transcript {
        protocol: "p2p-v3",
        network: round.network.as_str(),
        session: &session,
        tier: round.tier,
        feerate: round.feerate,
        participants,
        inputs: tx
            .inputs
            .iter()
            .map(|input| TranscriptInput {
                prev_txid: input.prev_txid.to_ascii_lowercase(),
                prev_index: input.prev_index,
                value: input.value,
                pubkey: input.pubkey.to_ascii_lowercase(),
            })
            .collect(),
        outputs: tx
            .outputs
            .iter()
            .map(|output| TranscriptOutput {
                script: output.script.to_ascii_lowercase(),
                value: output.value,
            })
            .collect(),
    };
    let transcript_hash: [u8; 32] = Sha256::digest(
        serde_json::to_string(&transcript)
            .map_err(|error| error.to_string())?
            .as_bytes(),
    )
    .into();
    let mut template = Sha256::new();
    template.update(b"OPTN-P2P-FUSION-V3\0");
    template.update(round.network.as_str().as_bytes());
    template.update([0]);
    template.update(session_bytes);
    template.update(transcript_hash);
    template.update(tx.fusion_tx()?.unsigned_template_hash());
    let template_hash: [u8; 32] = template.finalize().into();

    let declared: HashMap<String, &super::wire::InputRef> = tx
        .inputs
        .iter()
        .map(|input| {
            (
                format!(
                    "{}:{}",
                    input.prev_txid.to_ascii_lowercase(),
                    input.prev_index
                ),
                input,
            )
        })
        .collect();
    let owned_inputs = mine
        .inputs
        .iter()
        .map(|input| {
            let outpoint = format!(
                "{}:{}",
                input.prev_txid.to_ascii_lowercase(),
                input.prev_index
            );
            let actual = declared
                .get(&outpoint)
                .filter(|actual| {
                    actual.value == input.value && actual.pubkey.eq_ignore_ascii_case(&input.pubkey)
                })
                .ok_or("P2P Fusion template changed a wallet-owned input.")?;
            let secret = keys
                .get(&actual.pubkey)
                .or_else(|| keys.get(&input.pubkey))
                .ok_or("P2P Fusion native signer is missing an owned key.")?;
            Ok(P2pOwnedInput {
                prev_txid: input.prev_txid.to_ascii_lowercase(),
                prev_index: input.prev_index,
                pubkey: input.pubkey.to_ascii_lowercase(),
                value: input.value,
                private_key: hex(secret),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let request = P2pSignRequest {
        protocol: "p2p-v3".into(),
        network: round.network.as_str().into(),
        session: session.clone(),
        transcript_hash: hex(&transcript_hash),
        template_hash: hex(&template_hash),
        inputs: tx
            .inputs
            .iter()
            .map(|input| P2pSignInput {
                prev_txid: input.prev_txid.to_ascii_lowercase(),
                prev_index: input.prev_index,
                pubkey: input.pubkey.to_ascii_lowercase(),
                value: input.value,
            })
            .collect(),
        outputs: tx
            .outputs
            .iter()
            .map(|output| P2pSignOutput {
                script: output.script.to_ascii_lowercase(),
                value: output.value,
            })
            .collect(),
        owned_inputs,
        owned_outputs: mine
            .outputs
            .iter()
            .map(|output| P2pOwnedOutput {
                script: output.script.to_ascii_lowercase(),
                value: output.value,
            })
            .collect(),
        feerate: round.feerate,
        max_fee: tx.minimum_fee(round.feerate) * MAX_FEE_FACTOR,
    };
    let response = sign_p2p(request)?;
    if response.protocol != "p2p-v3" || response.template_hash != hex(&template_hash) {
        return Err("Native P2P Fusion signer returned an invalid response.".into());
    }
    let signatures: HashMap<String, String> = response
        .signatures
        .into_iter()
        .map(|signature| (signature.outpoint.to_ascii_lowercase(), signature.signature))
        .collect();
    mine.inputs
        .iter()
        .map(|input| {
            let outpoint = format!(
                "{}:{}",
                input.prev_txid.to_ascii_lowercase(),
                input.prev_index
            );
            let signature = signatures
                .get(&outpoint)
                .filter(|signature| signature.len() == 128)
                .ok_or("Native P2P Fusion signer omitted an owned input.")?;
            Ok(InputSig {
                prev_txid: input.prev_txid.clone(),
                prev_index: input.prev_index,
                unlocking_bytecode: format!(
                    "41{signature}4121{}",
                    input.pubkey.to_ascii_lowercase()
                ),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::assemble::{assemble, finalize, verify_final};
    use super::super::wire::{InputRef, OutputRef};
    use super::*;
    use k256::elliptic_curve::PrimeField;

    fn pubkey_of(secret: [u8; 32]) -> String {
        let scalar = Option::<k256::Scalar>::from(k256::Scalar::from_repr(secret.into())).unwrap();
        hex(&optn_core::fusion::schnorr::pubkey_compressed(scalar))
    }

    #[test]
    fn the_native_boundary_signs_an_approved_round_and_the_result_verifies() {
        let mine_secret = [3u8; 32];
        let theirs_secret = [4u8; 32];
        let mine = Contribution {
            inputs: vec![InputRef {
                prev_txid: hex(&[0xaa; 32]),
                prev_index: 1,
                value: 100_000,
                pubkey: pubkey_of(mine_secret),
            }],
            outputs: vec![OutputRef {
                script: format!("76a914{}88ac", hex(&[1; 20])),
                value: 99_700,
            }],
        };
        let theirs = Contribution {
            inputs: vec![InputRef {
                prev_txid: hex(&[0xbb; 32]),
                prev_index: 0,
                value: 50_000,
                pubkey: pubkey_of(theirs_secret),
            }],
            outputs: vec![OutputRef {
                script: format!("76a914{}88ac", hex(&[2; 20])),
                value: 49_700,
            }],
        };
        let tx = assemble([
            (&mine.inputs[..], &mine.outputs[..]),
            (&theirs.inputs[..], &theirs.outputs[..]),
        ])
        .unwrap();
        let participants = vec![hex(&[5; 32]), hex(&[6; 32])];
        let round = SigningRound {
            network: PoolNetwork::Chipnet,
            session: &hex(&[7; 32]),
            participants: &participants,
            tier: 100_000,
            feerate: 1_000,
        };
        let mut sigs = sign_native(
            &tx,
            &mine,
            &HashMap::from([(pubkey_of(mine_secret), mine_secret)]),
            &round,
        )
        .unwrap();
        sigs.extend(
            sign_native(
                &tx,
                &theirs,
                &HashMap::from([(pubkey_of(theirs_secret), theirs_secret)]),
                &round,
            )
            .unwrap(),
        );
        let (tx_hex, txid) = finalize(&tx, &sigs).unwrap();
        assert_eq!(verify_final(&tx, &tx_hex, &txid).unwrap(), txid);

        // A template that shortens my output is refused before any signature.
        let mut cheated = tx.clone();
        let index = cheated
            .outputs
            .iter()
            .position(|output| output.value == 99_700)
            .unwrap();
        cheated.outputs[index].value -= 1_000;
        assert!(sign_native(
            &cheated,
            &mine,
            &HashMap::from([(pubkey_of(mine_secret), mine_secret)]),
            &round
        )
        .is_err());
    }
}
