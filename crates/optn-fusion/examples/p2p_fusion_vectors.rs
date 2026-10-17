//! Writes `test-vectors/p2p-fusion-rust.json`: what a Rust P2P CashFusion peer
//! sends, for the TypeScript peers to accept
//! (`src/platform/desktop/nostr/__tests__/p2pRustInterop.test.ts`).
//!
//!     cargo run -p optn-fusion --example p2p_fusion_vectors
//!
//! The other direction, Rust reproducing the TypeScript, is
//! `test-vectors/p2p-fusion.json`.

use std::collections::HashMap;

use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use optn_fusion::p2p::assemble::{assemble, finalize, sign_own_inputs, Contribution};
use optn_fusion::p2p::credentials::{plan_credentials, total_slots, Issuer};
use optn_fusion::p2p::onion::{encode_authorized_output, to_base64, wrap};
use optn_fusion::p2p::wire::{
    AuthorizedOutput, Body, InputRef, OutputRef, PoolNetwork, RoundMessage, SlotResponse,
};
use serde_json::json;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A fixed valid secret per seed.
fn secret(seed: u8) -> [u8; 32] {
    let mut bytes = [seed; 32];
    bytes[0] = 0x10;
    bytes
}

fn scalar(seed: u8) -> k256::Scalar {
    Option::from(k256::Scalar::from_repr(secret(seed).into())).expect("valid scalar")
}

fn x_only(seed: u8) -> String {
    let point = (k256::ProjectivePoint::GENERATOR * scalar(seed))
        .to_affine()
        .to_encoded_point(true);
    hex(&point.as_bytes()[1..33])
}

fn compressed(seed: u8) -> String {
    hex(&optn_core::fusion::schnorr::pubkey_compressed(scalar(seed)))
}

fn p2pkh(seed: u8) -> String {
    format!("76a914{}88ac", hex(&[seed; 20]))
}

fn main() -> Result<(), String> {
    let now_unix = 1_800_000_000u64;
    let session = hex(&[0x5a; 32]);
    let mut participants: Vec<String> = (1..=4).map(x_only).collect();
    participants.sort();
    let me = participants[1].clone();

    // A contribution, its credentials from a Rust issuer, and the onion.
    let inputs = vec![
        InputRef {
            prev_txid: hex(&[0xa1; 32]),
            prev_index: 9,
            value: 120_000,
            pubkey: compressed(11),
        },
        InputRef {
            prev_txid: hex(&[0xa1; 32]),
            prev_index: 10,
            value: 80_000,
            pubkey: compressed(12),
        },
    ];
    let outputs = vec![
        OutputRef {
            script: p2pkh(21),
            value: 110_000,
        },
        OutputRef {
            script: p2pkh(22),
            value: 89_000,
        },
    ];
    let contribution = Contribution {
        inputs: inputs.clone(),
        outputs: outputs.clone(),
    };
    let mut issuer = Issuer::create(total_slots(participants.len()))?;
    let plan = plan_credentials(
        &contribution,
        &participants,
        &me,
        &issuer.pubkey_hex,
        &issuer.r_points_hex,
        1_000,
    )?;
    let responses: Vec<SlotResponse> = plan
        .requests
        .iter()
        .map(|request| {
            Ok(SlotResponse {
                index: request.index,
                s: issuer.sign(request.index, &request.e)?,
            })
        })
        .collect::<Result<_, String>>()?;
    let credentials: Vec<String> = plan
        .pending
        .iter()
        .zip(&responses)
        .map(|(pending, response)| pending.finalize(&response.s))
        .collect::<Result<_, String>>()?;
    let authorized: Vec<AuthorizedOutput> = outputs
        .iter()
        .enumerate()
        .map(|(i, output)| AuthorizedOutput {
            script: output.script.clone(),
            value: output.value,
            credential_serial: plan.output_serials[i].clone(),
            credential_sig: credentials[inputs.len() + i].clone(),
            salt_commitment: plan.output_salt_commitments[i].clone(),
        })
        .collect();
    let peeler_seeds = [31u8, 32, 33];
    let peelers: Vec<String> = peeler_seeds.iter().map(|&seed| x_only(seed)).collect();
    let payload = encode_authorized_output(&authorized[0])?;
    let onion = to_base64(&wrap(&payload, &peelers)?);

    // A transaction the Rust signer signed.
    let tx = assemble([(&inputs[..], &outputs[..])])?;
    let keys: HashMap<String, [u8; 32]> = [11u8, 12]
        .iter()
        .map(|&seed| (compressed(seed), secret(seed)))
        .collect();
    let sigs = sign_own_inputs(&tx, &keys)?;
    let (tx_hex, txid) = finalize(&tx, &sigs)?;

    // One message of every kind a Rust peer sends.
    let bodies = vec![
        Body::RoundProposal {
            network: PoolNetwork::Chipnet,
            tier: 100_000,
            epoch: 3,
            participants: participants.clone(),
        },
        Body::RoundAck {
            network: PoolNetwork::Chipnet,
            tier: 100_000,
            epoch: 3,
        },
        Body::RoundShrink {
            network: PoolNetwork::Chipnet,
            tier: 100_000,
            epoch: 3,
            remaining: participants.clone(),
        },
        Body::RoundStart {
            network: PoolNetwork::Chipnet,
            tier: 100_000,
            epoch: 3,
            participants: participants.clone(),
        },
        Body::Abort {
            reason: "cancelled".into(),
        },
        Body::CredentialParams {
            round_pubkey: issuer.pubkey_hex.clone(),
            blind_nonce_points: issuer.r_points_hex.clone(),
        },
        Body::CredentialRequest {
            requests: plan.requests.clone(),
            amount_commitments: plan.amount_commitments.clone(),
            component_commitments: plan.component_commitments.clone(),
            pedersen_total_nonce: plan.pedersen_total_nonce.clone(),
            excess_fee: plan.excess_fee,
            input_count: inputs.len() as u32,
            output_count: outputs.len() as u32,
        },
        Body::CredentialResponse {
            responses: responses.clone(),
        },
        Body::Inputs {
            inputs: vec![inputs[0].clone()],
            credential_sigs: vec![credentials[0].clone()],
            salt_commitments: vec![plan.input_salt_commitments[0].clone()],
        },
        Body::Outputs {
            outputs: authorized.clone(),
        },
        Body::OnionOutput {
            onion: onion.clone(),
            mix_order: peelers.clone(),
        },
        Body::OnionDeclare { output_count: 2 },
        Body::ComponentsReady {},
        Body::Assembled {
            inputs: tx.inputs.clone(),
            outputs: tx.outputs.clone(),
        },
        Body::Signature { sigs: sigs.clone() },
        Body::Final {
            txid: txid.clone(),
            tx_hex: tx_hex.clone(),
        },
    ];
    let messages: Vec<String> = bodies
        .into_iter()
        .map(|body| RoundMessage::new(&session, body, now_unix).to_json())
        .collect();

    let document = json!({
        "$comment": "Generated by `cargo run -p optn-fusion --example p2p_fusion_vectors` from the Rust P2P CashFusion code. \
                     src/platform/desktop/nostr/__tests__/p2pRustInterop.test.ts checks that the TypeScript peers accept every value. \
                     Regenerate only on purpose.",
        "nowUnix": now_unix,
        "session": session,
        "participants": participants,
        "messages": messages,
        "onion": {
            "peelerSecrets": peeler_seeds.iter().map(|&seed| hex(&secret(seed))).collect::<Vec<_>>(),
            "peelers": peelers,
            "payload": payload,
            "blob": onion,
        },
        "credentials": {
            "issuerPubkey": issuer.pubkey_hex,
            "inputs": inputs,
            "inputCredentials": credentials[..inputs.len()],
            "inputSaltCommitments": plan.input_salt_commitments,
            "outputs": authorized,
            "amountCommitments": plan.amount_commitments,
            "pedersenTotalNonce": plan.pedersen_total_nonce,
            "excessFee": plan.excess_fee,
        },
        "finalTx": {
            "contribution": { "inputs": inputs, "outputs": outputs },
            "assembled": { "inputs": tx.inputs, "outputs": tx.outputs },
            "sigs": sigs,
            "txHex": tx_hex,
            "txid": txid,
        },
    });
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-vectors/p2p-fusion-rust.json"
    );
    let text = serde_json::to_string_pretty(&document).map_err(|error| error.to_string())? + "\n";
    std::fs::write(path, text).map_err(|error| error.to_string())?;
    println!(
        "wrote test-vectors/p2p-fusion-rust.json ({} messages)",
        messages.len()
    );
    Ok(())
}
