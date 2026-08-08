//! Native fail-closed signing boundary for the explicit `p2p-v3` profile.

use std::collections::{HashMap, HashSet};

use k256::elliptic_curve::PrimeField;
use k256::Scalar;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::schnorr;
use super::tx::{FusionTx, P2pInput, P2pOutput};

const MAX_INPUTS: usize = 500;
const MAX_OUTPUTS: usize = 500;
const MAX_SCRIPT_BYTES: usize = 10_000;
const MAX_TEMPLATE_BYTES: usize = 200 * 1024;
const MAX_FEERATE: u64 = 100_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct P2pSignInput {
    pub prev_txid: String,
    pub prev_index: u32,
    pub pubkey: String,
    pub value: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct P2pSignOutput {
    pub script: String,
    pub value: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct P2pOwnedInput {
    pub prev_txid: String,
    pub prev_index: u32,
    pub pubkey: String,
    pub value: u64,
    pub private_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct P2pOwnedOutput {
    pub script: String,
    pub value: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct P2pSignRequest {
    pub protocol: String,
    pub network: String,
    pub session: String,
    pub transcript_hash: String,
    pub template_hash: String,
    pub inputs: Vec<P2pSignInput>,
    pub outputs: Vec<P2pSignOutput>,
    pub owned_inputs: Vec<P2pOwnedInput>,
    pub owned_outputs: Vec<P2pOwnedOutput>,
    /// Satoshis per 1,000 bytes, matching Electron Cash's component fee unit.
    pub feerate: u64,
    pub max_fee: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pInputSignature {
    pub outpoint: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pSignResponse {
    pub protocol: &'static str,
    pub template_hash: String,
    pub fee: u64,
    pub signatures: Vec<P2pInputSignature>,
}

fn decode_hex<const N: usize>(value: &str, label: &str) -> Result<[u8; N], String> {
    if value.len() != N * 2 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{label} must be {} hex characters", N * 2));
    }
    let mut out = [0u8; N];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| format!("{label} is invalid hex"))?;
    }
    Ok(out)
}

fn decode_vec(value: &str, label: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0
        || value.len() > max_bytes.saturating_mul(2)
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format!("{label} is invalid or oversized hex"));
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| format!("{label} is invalid hex"))
        })
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn outpoint(txid: &str, index: u32) -> String {
    format!("{}:{index}", txid.to_ascii_lowercase())
}

fn wipe_string(value: &mut String) {
    // SAFETY: replacing bytes with zero preserves UTF-8 validity and length.
    unsafe { value.as_bytes_mut().fill(0) };
}

struct SecretScalar(Scalar);

impl Drop for SecretScalar {
    fn drop(&mut self) {
        // A volatile overwrite prevents the compiler from eliding this bounded
        // best-effort wipe. k256 signing still necessarily takes Scalar by value.
        unsafe { std::ptr::write_volatile(&mut self.0, Scalar::ZERO) };
    }
}

fn bound_template_hash(
    network: &str,
    session: &[u8; 32],
    transcript: &[u8; 32],
    unsigned_tx_hash: &[u8; 32],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"OPTN-P2P-FUSION-V3\0");
    hasher.update(network.as_bytes());
    hasher.update([0]);
    hasher.update(session);
    hasher.update(transcript);
    hasher.update(unsigned_tx_hash);
    hasher.finalize().into()
}

pub fn sign_p2p(mut request: P2pSignRequest) -> Result<P2pSignResponse, String> {
    if request.protocol != "p2p-v3" {
        return Err("unsupported P2P Fusion protocol".into());
    }
    if !matches!(request.network.as_str(), "mainnet" | "chipnet") {
        return Err("unsupported P2P Fusion network".into());
    }
    if request.feerate == 0 || request.feerate > MAX_FEERATE {
        return Err("P2P Fusion fee rate is outside policy bounds".into());
    }
    let session = decode_hex::<32>(&request.session, "session")?;
    let transcript = decode_hex::<32>(&request.transcript_hash, "transcript hash")?;
    let expected_template = decode_hex::<32>(&request.template_hash, "template hash")?;
    if request.inputs.is_empty()
        || request.inputs.len() > MAX_INPUTS
        || request.outputs.is_empty()
        || request.outputs.len() > MAX_OUTPUTS
        || request.owned_inputs.is_empty()
        || request.owned_inputs.len() > request.inputs.len()
        || request.owned_outputs.is_empty()
        || request.owned_outputs.len() > request.outputs.len()
    {
        return Err("P2P Fusion request has invalid input/output bounds".into());
    }

    // Bound attacker-controlled aggregate material before allocating decoded
    // scripts or constructing the canonical transaction.
    let template_hex_chars = request
        .inputs
        .iter()
        .try_fold(0usize, |total, input| {
            total
                .checked_add(input.prev_txid.len())
                .and_then(|n| n.checked_add(input.pubkey.len()))
        })
        .and_then(|total| {
            request
                .outputs
                .iter()
                .try_fold(total, |n, output| n.checked_add(output.script.len()))
        })
        .and_then(|total| {
            request
                .owned_outputs
                .iter()
                .try_fold(total, |n, output| n.checked_add(output.script.len()))
        })
        .ok_or("P2P Fusion template size overflow")?;
    if template_hex_chars > MAX_TEMPLATE_BYTES.saturating_mul(2) {
        return Err("P2P Fusion template exceeds size limit".into());
    }

    let mut seen_inputs = HashSet::new();
    let mut input_total = 0u64;
    let mut canonical_inputs = Vec::with_capacity(request.inputs.len());
    let mut declared = HashMap::new();
    for input in &request.inputs {
        let txid = decode_hex::<32>(&input.prev_txid, "input txid")?;
        let pubkey = decode_vec(&input.pubkey, "input pubkey", 65)?;
        if pubkey.len() != 33 {
            return Err("P2P Fusion requires compressed input pubkeys".into());
        }
        let key = outpoint(&input.prev_txid, input.prev_index);
        if !seen_inputs.insert(key.clone()) {
            return Err("duplicate P2P Fusion input outpoint".into());
        }
        input_total = input_total
            .checked_add(input.value)
            .ok_or("input value overflow")?;
        declared.insert(key, (pubkey.clone(), input.value));
        canonical_inputs.push(P2pInput {
            prev_txid: txid,
            prev_index: input.prev_index,
            pubkey,
            value: input.value,
        });
    }

    let mut output_total = 0u64;
    let mut canonical_outputs = Vec::with_capacity(request.outputs.len());
    let mut output_multiset = HashMap::<(Vec<u8>, u64), usize>::new();
    for output in &request.outputs {
        let script = decode_vec(&output.script, "output script", MAX_SCRIPT_BYTES)?;
        if script.is_empty() {
            return Err("P2P Fusion output script is empty".into());
        }
        output_total = output_total
            .checked_add(output.value)
            .ok_or("output value overflow")?;
        if output_multiset
            .insert((script.clone(), output.value), 1)
            .is_some()
        {
            return Err("duplicate exact P2P Fusion output".into());
        }
        canonical_outputs.push(P2pOutput {
            script,
            value: output.value,
        });
    }
    let fee = input_total
        .checked_sub(output_total)
        .ok_or("outputs exceed inputs")?;
    // Keep the native boundary aligned with Electron Cash/P2P sizing:
    // 10 bytes overhead + 108+pubkey bytes per input + 9+script bytes per output.
    let estimated_size = canonical_inputs
        .iter()
        .try_fold(10u64, |size, input| {
            size.checked_add(108u64.checked_add(input.pubkey.len() as u64)?)
        })
        .and_then(|size| {
            canonical_outputs.iter().try_fold(size, |size, output| {
                size.checked_add(9u64.checked_add(output.script.len() as u64)?)
            })
        })
        .ok_or("P2P Fusion fee size overflow")?;
    let required_fee = estimated_size
        .checked_mul(request.feerate)
        .and_then(|scaled| scaled.checked_add(999))
        .map(|scaled| scaled / 1_000)
        .ok_or("P2P Fusion required fee overflow")?;
    let maximum_policy_fee = required_fee
        .checked_mul(3)
        .ok_or("P2P Fusion maximum fee overflow")?;
    if fee < required_fee {
        return Err(format!(
            "P2P Fusion fee {fee} is below required minimum {required_fee}"
        ));
    }
    if fee > maximum_policy_fee || fee > request.max_fee {
        return Err(format!(
            "P2P Fusion fee {fee} exceeds policy maximum {} or caller maximum {}",
            maximum_policy_fee, request.max_fee
        ));
    }

    let mut claimed_outputs = HashMap::<(Vec<u8>, u64), usize>::new();
    for output in &request.owned_outputs {
        let script = decode_vec(&output.script, "owned output script", MAX_SCRIPT_BYTES)?;
        *claimed_outputs.entry((script, output.value)).or_default() += 1;
    }
    if claimed_outputs.is_empty()
        || claimed_outputs
            .iter()
            .any(|(output, count)| output_multiset.get(output).copied().unwrap_or(0) < *count)
    {
        return Err("not every owned output is present in the P2P template".into());
    }

    let tx = FusionTx::from_p2p(&canonical_inputs, &canonical_outputs)?;
    let actual_template = bound_template_hash(
        &request.network,
        &session,
        &transcript,
        &tx.unsigned_template_hash(),
    );
    if actual_template != expected_template {
        return Err("P2P Fusion template hash mismatch".into());
    }

    let mut seen_owned = HashSet::new();
    let mut signatures = Vec::with_capacity(request.owned_inputs.len());
    for owned in &mut request.owned_inputs {
        let key = outpoint(&owned.prev_txid, owned.prev_index);
        if !seen_owned.insert(key.clone()) {
            return Err("duplicate owned P2P Fusion input".into());
        }
        let (declared_pubkey, declared_value) = declared
            .get(&key)
            .ok_or("owned input is absent from P2P template")?;
        let owned_pubkey = decode_vec(&owned.pubkey, "owned pubkey", 65)?;
        if &owned_pubkey != declared_pubkey {
            return Err("owned input pubkey differs from P2P template".into());
        }
        if owned.value != *declared_value {
            return Err("owned input value differs from P2P template".into());
        }
        let decoded_private = decode_hex::<32>(&owned.private_key, "private key");
        wipe_string(&mut owned.private_key);
        let mut private_bytes = decoded_private?;
        let parsed_private = Option::<Scalar>::from(Scalar::from_repr(private_bytes.into()))
            .filter(|scalar| !bool::from(scalar.is_zero()))
            .map(SecretScalar);
        private_bytes.fill(0);
        let private = parsed_private.ok_or("private key is outside secp256k1 range")?;
        if schnorr::pubkey_compressed(private.0).as_slice() != owned_pubkey.as_slice() {
            return Err("private key does not own the declared input pubkey".into());
        }
        let input_index = request
            .inputs
            .iter()
            .position(|input| outpoint(&input.prev_txid, input.prev_index) == key)
            .ok_or("owned input index is missing")?;
        let signature = schnorr::sign(private.0, &tx.sighash(input_index)?);
        signatures.push(P2pInputSignature {
            outpoint: key,
            signature: hex(&signature),
        });
    }

    Ok(P2pSignResponse {
        protocol: "p2p-v3",
        template_hash: hex(&actual_template),
        fee,
        signatures,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> P2pSignRequest {
        let private = Scalar::from(7u64);
        let pubkey = hex(&schnorr::pubkey_compressed(private));
        let inputs = vec![P2pSignInput {
            prev_txid: "11".repeat(32),
            prev_index: 1,
            pubkey: pubkey.clone(),
            value: 10_000,
        }];
        let outputs = vec![P2pSignOutput {
            script: "51".into(),
            value: 9_550,
        }];
        let tx = FusionTx::from_p2p(
            &[P2pInput {
                prev_txid: [0x11; 32],
                prev_index: 1,
                pubkey: schnorr::pubkey_compressed(private).to_vec(),
                value: 10_000,
            }],
            &[P2pOutput {
                script: vec![0x51],
                value: 9_550,
            }],
        )
        .unwrap();
        let session = [0x22; 32];
        let transcript = [0x33; 32];
        P2pSignRequest {
            protocol: "p2p-v3".into(),
            network: "chipnet".into(),
            session: hex(&session),
            transcript_hash: hex(&transcript),
            template_hash: hex(&bound_template_hash(
                "chipnet",
                &session,
                &transcript,
                &tx.unsigned_template_hash(),
            )),
            inputs,
            outputs,
            owned_inputs: vec![P2pOwnedInput {
                prev_txid: "11".repeat(32),
                prev_index: 1,
                pubkey,
                value: 10_000,
                private_key: hex(&private.to_bytes()),
            }],
            owned_outputs: vec![P2pOwnedOutput {
                script: "51".into(),
                value: 9_550,
            }],
            feerate: 1_000,
            max_fee: 1_500,
        }
    }

    #[test]
    fn signs_only_the_exact_owned_input() {
        let response = sign_p2p(request()).unwrap();
        assert_eq!(response.protocol, "p2p-v3");
        assert_eq!(response.fee, 450);
        assert_eq!(response.signatures.len(), 1);
        assert_eq!(
            response.signatures[0].outpoint,
            format!("{}:1", "11".repeat(32))
        );
        assert_eq!(
            response.signatures[0].signature,
            concat!(
                "be893b080b5106225141488e78c16adfa32d8547dfbd6a6db350eee6f22d8f53",
                "f9f95936b7f23dddc3d4b87f59faaa87be7f1918613fcb61110320fe3b08fdae"
            )
        );
    }

    #[test]
    fn rejects_protocol_template_fee_output_and_key_substitution() {
        let mut bad = request();
        bad.protocol = "p2p-v2".into();
        assert!(sign_p2p(bad).is_err());
        let mut bad = request();
        bad.template_hash = "00".repeat(32);
        assert!(sign_p2p(bad).is_err());
        let mut bad = request();
        bad.session = "44".repeat(32);
        assert!(sign_p2p(bad).is_err());
        let mut bad = request();
        bad.transcript_hash = "55".repeat(32);
        assert!(sign_p2p(bad).is_err());
        let mut bad = request();
        bad.network = "mainnet".into();
        assert!(sign_p2p(bad).is_err());
        let mut bad = request();
        bad.max_fee = 449;
        assert!(sign_p2p(bad).is_err());
        let mut bad = request();
        bad.owned_outputs[0].script = "52".into();
        assert!(sign_p2p(bad).is_err());
        let mut bad = request();
        bad.owned_inputs[0].private_key = "01".repeat(32);
        assert!(sign_p2p(bad).is_err());
    }

    #[test]
    fn rejects_duplicate_or_incomplete_inputs() {
        let mut bad = request();
        bad.inputs.push(bad.inputs[0].clone());
        assert!(sign_p2p(bad).is_err());
        let mut bad = request();
        bad.owned_inputs[0].prev_index = 2;
        assert!(sign_p2p(bad).is_err());
    }

    #[test]
    fn rejects_owned_input_value_substitution() {
        let mut bad = request();
        bad.owned_inputs[0].value -= 1;
        assert!(sign_p2p(bad)
            .unwrap_err()
            .contains("owned input value differs"));
    }

    #[test]
    fn request_deserialization_rejects_unknown_fields() {
        let json = serde_json::json!({
            "protocol": "p2p-v3",
            "network": "chipnet",
            "session": "22".repeat(32),
            "transcriptHash": "33".repeat(32),
            "templateHash": "44".repeat(32),
            "inputs": [],
            "outputs": [],
            "ownedInputs": [],
            "ownedOutputs": [],
            "feerate": 1000,
            "maxFee": 1000,
            "unexpected": true
        });
        assert!(serde_json::from_value::<P2pSignRequest>(json).is_err());
    }

    #[test]
    fn rejects_duplicate_exact_outputs_before_signing() {
        let mut bad = request();
        bad.outputs.push(bad.outputs[0].clone());
        assert!(sign_p2p(bad)
            .unwrap_err()
            .contains("duplicate exact P2P Fusion output"));
    }

    #[test]
    fn secret_string_wipe_preserves_allocation_and_zeros_bytes() {
        let mut secret = "01".repeat(32);
        let pointer = secret.as_ptr();
        wipe_string(&mut secret);
        assert_eq!(secret.as_ptr(), pointer);
        assert!(secret.as_bytes().iter().all(|byte| *byte == 0));
    }

    #[test]
    fn rejects_reduced_owned_output_value_even_with_matching_template_hash() {
        let mut bad = request();
        bad.outputs[0].value = 9_540;
        let tx = FusionTx::from_p2p(
            &[P2pInput {
                prev_txid: [0x11; 32],
                prev_index: 1,
                pubkey: decode_vec(&bad.inputs[0].pubkey, "pubkey", 65).unwrap(),
                value: 10_000,
            }],
            &[P2pOutput {
                script: vec![0x51],
                value: 9_540,
            }],
        )
        .unwrap();
        bad.template_hash = hex(&bound_template_hash(
            "chipnet",
            &[0x22; 32],
            &[0x33; 32],
            &tx.unsigned_template_hash(),
        ));
        assert!(sign_p2p(bad)
            .unwrap_err()
            .contains("not every owned output"));
    }

    #[test]
    fn rejects_excess_owned_output_count_and_aggregate_template_size() {
        let mut too_many_owned = request();
        too_many_owned
            .owned_outputs
            .push(too_many_owned.owned_outputs[0].clone());
        assert!(sign_p2p(too_many_owned)
            .unwrap_err()
            .contains("invalid input/output bounds"));

        let mut oversized = request();
        oversized.outputs[0].script = "51".repeat(MAX_TEMPLATE_BYTES + 1);
        assert!(sign_p2p(oversized)
            .unwrap_err()
            .contains("template exceeds size limit"));
    }

    #[test]
    fn rejects_fee_below_native_minimum_before_signing() {
        let mut bad = request();
        bad.outputs[0].value = 9_900;
        bad.owned_outputs[0].value = 9_900;
        let tx = FusionTx::from_p2p(
            &[P2pInput {
                prev_txid: [0x11; 32],
                prev_index: 1,
                pubkey: decode_vec(&bad.inputs[0].pubkey, "pubkey", 65).unwrap(),
                value: 10_000,
            }],
            &[P2pOutput {
                script: vec![0x51],
                value: 9_900,
            }],
        )
        .unwrap();
        bad.template_hash = hex(&bound_template_hash(
            "chipnet",
            &[0x22; 32],
            &[0x33; 32],
            &tx.unsigned_template_hash(),
        ));
        assert!(sign_p2p(bad)
            .unwrap_err()
            .contains("below required minimum"));
    }
}
