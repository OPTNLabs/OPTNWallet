//! The wallet's entry point into this crate.
//!
//! Only compiled for wasm32, so native, riscv64 and armv7 builds never see
//! wasm-bindgen at all.
//!
//! The surface mirrors `src/services/RpaService.ts` deliberately, name for
//! name, so the TypeScript side becomes a thin call-through rather than a
//! translation. Anything that needs a shape richer than a string is returned as
//! JSON: it keeps this boundary free of serde-wasm-bindgen, and the wallet is
//! going to hand these values to JS anyway.
//!
//! Byte arrays cross as `Vec<u8>` (JS `Uint8Array`). Lengths are checked here
//! rather than trusted, because a wrong-length key from JS would otherwise
//! reach the curve code as a silently wrong value.

use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::connect;
use zeroize::Zeroize;

use crate::network::Network;
use crate::rpa;

/// Shared Rust ceiling for the legacy untrusted iframe bridge.
#[wasm_bindgen(js_name = addonLegacyGuestCallAllowed)]
pub fn addon_legacy_guest_call_allowed(module: &str, method: &str) -> bool {
    crate::addon::legacy_guest_call_allowed(module, method)
}

/// Deferred to `Network`'s own parser rather than a second list here.
///
/// Two lists drift: this one knew mainnet and chipnet only, so the wallet's
/// web surface could not name testnet3, testnet4 or regtest even after the
/// typed core could. `FromStr` refuses an unknown or ambiguous name, which is
/// the behaviour this boundary wants anyway.
fn network_from(name: &str) -> Result<Network, JsValue> {
    name.parse::<Network>()
        .map_err(|error| JsValue::from_str(&error))
}

fn array33(bytes: &[u8], what: &str) -> Result<[u8; 33], JsValue> {
    <[u8; 33]>::try_from(bytes)
        .map_err(|_| JsValue::from_str(&format!("{what} must be 33 bytes, got {}", bytes.len())))
}

fn array32(bytes: &[u8], what: &str) -> Result<[u8; 32], JsValue> {
    <[u8; 32]>::try_from(bytes)
        .map_err(|_| JsValue::from_str(&format!("{what} must be 32 bytes, got {}", bytes.len())))
}

fn err(e: crate::error::CliError) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// Inputs of a raw transaction as JSON `{txid, vout}` records. Txids use
/// display order, matching the shared coin-hold record. This does not sign.
#[wasm_bindgen(js_name = transactionOutpoints)]
pub fn transaction_outpoints(raw_tx_hex: &str) -> Result<String, JsValue> {
    if !raw_tx_hex.len().is_multiple_of(2)
        || !raw_tx_hex.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(JsValue::from_str("invalid transaction hex"));
    }
    let raw: Vec<u8> = (0..raw_tx_hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&raw_tx_hex[index..index + 2], 16))
        .collect::<Result<_, _>>()
        .map_err(|_| JsValue::from_str("invalid transaction hex"))?;
    let transaction = crate::tx::decode(&raw).map_err(err)?;
    if transaction.inputs.is_empty() {
        return Err(JsValue::from_str("transaction has no inputs"));
    }
    let outpoints: Vec<_> = transaction
        .inputs
        .into_iter()
        .map(|(mut txid, vout, _)| {
            txid.reverse();
            serde_json::json!({ "txid": crate::coins::hex_encode(&txid), "vout": vout })
        })
        .collect();
    serde_json::to_string(&outpoints).map_err(|error| JsValue::from_str(&error.to_string()))
}

/// `m/44'/<coin>'/<account>'/3/0` and `/3/1`, as a JSON object.
#[wasm_bindgen(js_name = rpaKeyPaths)]
pub fn rpa_key_paths(coin_type: u32, account: u32) -> String {
    format!(
        r#"{{"scan":"{}","spend":"{}"}}"#,
        rpa::scan_path(coin_type, account),
        rpa::spend_path(coin_type, account)
    )
}

/// Derive scan/spend private and compressed public keys in the shared core.
///
/// The packed result is `scan_priv(32) || scan_pub(33) || spend_priv(32) ||
/// spend_pub(33)`. A fixed byte layout avoids serializing private keys into
/// JavaScript strings, which are immutable and cannot be wiped by the caller.
#[wasm_bindgen(js_name = deriveRpaKeys)]
pub fn derive_rpa_keys(
    mnemonic: &str,
    passphrase: &str,
    scan_path: &str,
    spend_path: &str,
) -> Result<js_sys::Uint8Array, JsValue> {
    let keys =
        rpa::derive_keys_from_paths(mnemonic, passphrase, scan_path, spend_path).map_err(err)?;
    let mut packed = [0u8; 130];
    packed[0..32].copy_from_slice(&keys.scan_privkey);
    packed[32..65].copy_from_slice(&keys.scan_pubkey);
    packed[65..97].copy_from_slice(&keys.spend_privkey);
    packed[97..130].copy_from_slice(&keys.spend_pubkey);

    // Copy into caller-owned JS memory, then erase the Rust/WASM transfer
    // buffer. The adapter erases this returned array after taking its slices.
    let output = js_sys::Uint8Array::new_with_length(packed.len() as u32);
    output.copy_from(&packed);
    packed.zeroize();
    Ok(output)
}

/// Encode a scan/spend pair as a `cashcode:` string.
///
/// There is no `legacy` argument. The legacy `paycode:` prefix is a different
/// implementation that OPTN does not support, and an encoder able to stamp it
/// would be a way to manufacture the very strings `decodeCashcode` refuses.
#[wasm_bindgen(js_name = encodeCashcode)]
pub fn encode_cashcode(
    scan_pubkey: &[u8],
    spend_pubkey: &[u8],
    network: &str,
    prefix_bits: u8,
) -> Result<String, JsValue> {
    Ok(rpa::encode(
        &array33(scan_pubkey, "scan pubkey")?,
        &array33(spend_pubkey, "spend pubkey")?,
        network_from(network)?,
        prefix_bits,
    ))
}

/// Decode a Cash Code. Returns JSON, or throws with the reason the code was
/// rejected — including a legacy `paycode:`, which throws rather than
/// decoding. There is no `legacy` field on the result: nothing that decodes
/// here is legacy.
#[wasm_bindgen(js_name = decodeCashcode)]
pub fn decode_cashcode(code: &str) -> Result<String, JsValue> {
    let c = rpa::decode(code).map_err(err)?;
    let hex = |b: &[u8]| -> String { b.iter().map(|x| format!("{x:02x}")).collect() };
    Ok(format!(
        r#"{{"version":{},"prefixBits":{},"scanPubkey":"{}","spendPubkey":"{}","expiry":{},"prefix":"{}"}}"#,
        c.version,
        c.prefix_bits,
        hex(&c.scan_pubkey),
        hex(&c.spend_pubkey),
        c.expiry,
        c.prefix,
    ))
}

/// Sign and grind an assembled RPA payment, in the shared core.
///
/// The desktop sender used to run its own grind: its own signing, its own
/// serialization, its own SHA-256, and its own 100_000 ceiling, in parallel
/// with the CLI's. Two implementations of the same protocol step is precisely
/// the failure this crate exists to prevent, and the failure mode is quiet —
/// a sender that grinds differently produces a payment that is on chain,
/// valid, and invisible to the recipient scanning for it.
///
/// The caller still assembles the transaction, because output ordering and
/// review are the wallet's concern. Everything from signing onwards is here.
///
/// `raw_tx` is the assembled transaction with the stealth output already in
/// place. `prevout_values` and the concatenated `prevout_scripts` (split by
/// `prevout_script_lens`) describe the outputs being spent, in input order,
/// because a sighash needs the value and script of the coin it spends and
/// neither is present in the transaction itself. `privkeys` is 32 bytes per
/// input, in the same order.
///
/// Returns `{"exhausted":true}` rather than throwing when the budget runs
/// out: that is a reshape signal, and the wallet should reselect coins.
#[wasm_bindgen(js_name = grindRpaTransaction)]
pub fn grind_rpa_transaction(
    raw_tx: &[u8],
    prevout_values: &[u64],
    prevout_scripts: &[u8],
    prevout_script_lens: &[u32],
    privkeys: &[u8],
    scan_pubkey: &[u8],
    prefix_bits: u8,
) -> Result<String, JsValue> {
    let decoded = crate::tx::decode(raw_tx).map_err(err)?;
    let n = decoded.inputs.len();
    if prevout_values.len() != n || prevout_script_lens.len() != n {
        return Err(JsValue::from_str(
            "one prevout value and script is needed per input",
        ));
    }
    if privkeys.len() != n * 32 {
        return Err(JsValue::from_str(
            "one 32-byte private key is needed per input",
        ));
    }

    let mut scripts = Vec::with_capacity(n);
    let mut at = 0usize;
    for len in prevout_script_lens {
        let len = *len as usize;
        if at + len > prevout_scripts.len() {
            return Err(JsValue::from_str(
                "prevout scripts are shorter than declared",
            ));
        }
        scripts.push(prevout_scripts[at..at + len].to_vec());
        at += len;
    }

    let inputs = decoded
        .inputs
        .iter()
        .zip(prevout_values)
        .zip(scripts)
        .map(
            |(((txid, vout, _seq), value), script_pubkey)| crate::tx::Utxo {
                txid: *txid,
                vout: *vout,
                value: *value,
                script_pubkey,
            },
        )
        .collect();
    let outputs = decoded
        .outputs
        .iter()
        .map(|o| crate::tx::Output::new(o.value, o.script_pubkey.clone()))
        .collect();

    let mut transaction = crate::tx::Transaction::new(inputs, outputs);
    transaction.version = decoded.version;
    transaction.locktime = decoded.locktime;

    let mut keys = Vec::with_capacity(n);
    for i in 0..n {
        keys.push(
            k256::ecdsa::SigningKey::from_slice(&privkeys[i * 32..(i + 1) * 32])
                .map_err(|e| JsValue::from_str(&format!("input {i} key is not valid: {e}")))?,
        );
    }

    let scan = array33(scan_pubkey, "scan pubkey")?;
    match rpa::grind_transaction(&mut transaction, &keys, &scan, prefix_bits).map_err(err)? {
        Some(g) => {
            let hex: String = g.raw.iter().map(|b| format!("{b:02x}")).collect();
            Ok(format!(
                r#"{{"exhausted":false,"rawHex":"{}","grindTries":{},"sequence":{}}}"#,
                hex, g.grind_tries, g.sequence
            ))
        }
        None => Ok(r#"{"exhausted":true}"#.to_string()),
    }
}

/// How many nSequence values to try before reshaping the transaction.
///
/// Exported so the wallet grinds as hard as the CLI does. Both previously
/// hardcoded 100_000, which at 16 bits exhausts about a fifth of the time.
#[wasm_bindgen(js_name = grindBudget)]
pub fn grind_budget(prefix_bits: u8) -> Result<u32, JsValue> {
    rpa::grind_budget(prefix_bits).map_err(err)
}

/// The nSequence for grind attempt `offset`, kept BIP68-final.
#[wasm_bindgen(js_name = grindSequence)]
pub fn grind_sequence(offset: u32) -> Result<u32, JsValue> {
    rpa::grind_sequence(offset).map_err(err)
}

#[wasm_bindgen(js_name = isLegacyPaycode)]
pub fn is_legacy_paycode(candidate: &str) -> bool {
    rpa::is_legacy_paycode(candidate)
}

/// The message to show for a legacy PayCode. Exported rather than duplicated
/// in TypeScript so the wallet and the CLI refuse it in the same words.
#[wasm_bindgen(js_name = legacyPaycodeRejection)]
pub fn legacy_paycode_rejection() -> String {
    rpa::LEGACY_PAYCODE_REJECTION.to_string()
}

/// True if the string is a Cash Code this wallet can pay. A legacy
/// `paycode:` is not, and returns false — use `isLegacyPaycode` to tell the
/// user why their string was refused.
#[wasm_bindgen(js_name = looksLikeRpa)]
pub fn looks_like_rpa(candidate: &str) -> bool {
    rpa::looks_like_rpa(candidate)
}

/// Why this code must not be paid on-chain, or `undefined` if it may be.
#[wasm_bindgen(js_name = sendBlockReason)]
pub fn send_block_reason(code: &str) -> Result<Option<String>, JsValue> {
    let c = rpa::decode(code).map_err(err)?;
    Ok(rpa::send_block_reason(&c))
}

/// ECDH plus the outpoint, per the reference implementation. `txid` is the
/// display (big-endian) form, as block explorers show it.
#[wasm_bindgen(js_name = sharedSecret)]
pub fn shared_secret(
    privkey: &[u8],
    counterpart_pubkey: &[u8],
    txid: &str,
    vout: u32,
) -> Result<Vec<u8>, JsValue> {
    rpa::shared_secret(
        &array32(privkey, "private key")?,
        &array33(counterpart_pubkey, "counterpart pubkey")?,
        txid,
        vout,
    )
    .map(|s| s.to_vec())
    .map_err(err)
}

/// The one-time P2PKH a sender pays: CKD_pub of the spend key, hashed
/// compressed.
#[wasm_bindgen(js_name = paymentAddress)]
pub fn payment_address(
    spend_pubkey: &[u8],
    secret: &[u8],
    network: &str,
    index: u32,
) -> Result<String, JsValue> {
    rpa::payment_address(
        &array33(spend_pubkey, "spend pubkey")?,
        &array32(secret, "shared secret")?,
        network_from(network)?,
        index,
    )
    .map(|a| a.encode())
    .map_err(err)
}

/// The private key that spends a payment at `index`.
#[wasm_bindgen(js_name = spendingKey)]
pub fn spending_key(spend_privkey: &[u8], secret: &[u8], index: u32) -> Result<Vec<u8>, JsValue> {
    rpa::spending_key(
        &array32(spend_privkey, "spend private key")?,
        &array32(secret, "shared secret")?,
        index,
    )
    .map(|k| k.to_vec())
    .map_err(err)
}

/// The hex a sender grinds the input hash to match.
#[wasm_bindgen(js_name = grindString)]
pub fn grind_string(scan_pubkey: &[u8], prefix_bits: u8) -> Result<String, JsValue> {
    rpa::grind_string(&array33(scan_pubkey, "scan pubkey")?, prefix_bits).map_err(err)
}

/// Payments to this wallet inside one raw transaction, as a JSON array.
///
/// Takes `scanPrivkey` and `spendPubkey` only -- the spend private key is not
/// needed to find a payment, and requiring it here would destroy the split the
/// spec asks for (REQ-5) between detecting and spending.
#[wasm_bindgen(js_name = scanTransaction)]
pub fn scan_transaction(
    raw_tx: &[u8],
    scan_privkey: &[u8],
    spend_pubkey: &[u8],
    network: &str,
) -> Result<String, JsValue> {
    let matches = rpa::scan_transaction(
        raw_tx,
        &array32(scan_privkey, "scan private key")?,
        &array33(spend_pubkey, "spend pubkey")?,
        network_from(network)?,
    )
    .map_err(err)?;

    let items: Vec<String> = matches
        .iter()
        .map(|m| {
            format!(
                r#"{{"outputIndex":{},"address":"{}","valueSats":{},"prevoutHash":"{}","prevoutIndex":{},"senderPubkey":"{}"}}"#,
                m.output_index,
                m.address,
                m.value,
                m.prevout_txid,
                m.prevout_index,
                // The other half of the ECDH, so a wallet can rebuild the
                // spending key later without refetching this transaction.
                // Public: it is already in the scriptSig on chain.
                m.sender_pubkey_hex
            )
        })
        .collect();
    Ok(format!("[{}]", items.join(",")))
}

// ---------------------------------------------------------------------------
// CashFusion primitives.
//
// The browser-side P2P round calls these exports through a thin TypeScript
// adapter. The protocol math therefore has one Rust implementation shared with
// the desktop backend and pinned by test-vectors/fusion.json.
//
// Randomness stays on the JS side. The core takes nonces and blinding factors
// as parameters, so callers pass values from crypto.getRandomValues rather than
// this crate pulling in a getrandom shim for wasm32.
// ---------------------------------------------------------------------------

fn scalar_from(bytes: &[u8], what: &str) -> Result<k256::Scalar, JsValue> {
    use k256::elliptic_curve::PrimeField;
    let array = array32(bytes, what)?;
    let scalar =
        Option::<k256::Scalar>::from(k256::Scalar::from_repr(array.into())).ok_or_else(|| {
            JsValue::from_str(&format!("{what} is not a canonical scalar (must be < n)"))
        })?;
    if bool::from(scalar.is_zero()) {
        return Err(JsValue::from_str(&format!("{what} must be non-zero")));
    }
    Ok(scalar)
}

/// Whether bytes are one non-zero canonical secp256k1 scalar.
#[wasm_bindgen(js_name = fusionScalarIsCanonical)]
pub fn fusion_scalar_is_canonical(bytes: &[u8]) -> bool {
    scalar_from(bytes, "scalar").is_ok()
}

/// Add packed 32-byte non-zero canonical scalars modulo the group order.
#[wasm_bindgen(js_name = fusionScalarSum)]
pub fn fusion_scalar_sum(packed: &[u8]) -> Result<Vec<u8>, JsValue> {
    if packed.is_empty() || !packed.len().is_multiple_of(32) {
        return Err(JsValue::from_str(
            "packed scalars must contain one or more 32-byte values",
        ));
    }
    let mut total = k256::Scalar::ZERO;
    for chunk in packed.as_chunks::<32>().0 {
        total += scalar_from(chunk, "scalar")?;
    }
    Ok(total.to_bytes().to_vec())
}

/// Verify a 64-byte BCH Schnorr signature. False on any malformed input.
#[wasm_bindgen(js_name = fusionVerifySchnorr)]
pub fn fusion_verify_schnorr(
    pubkey: &[u8],
    signature: &[u8],
    message: &[u8],
) -> Result<bool, JsValue> {
    let sig = <[u8; 64]>::try_from(signature).map_err(|_| {
        JsValue::from_str(&format!(
            "signature must be 64 bytes, got {}",
            signature.len()
        ))
    })?;
    let msg = array32(message, "message")?;
    Ok(crate::fusion::schnorr::verify(pubkey, &sig, &msg))
}

/// The 65-byte uncompressed Pedersen commitment `amount*H + nonce*G`.
#[wasm_bindgen(js_name = fusionPedersenCommit)]
pub fn fusion_pedersen_commit(amount: u64, nonce: &[u8]) -> Result<Vec<u8>, JsValue> {
    let nonce = scalar_from(nonce, "pedersen nonce")?;
    Ok(crate::fusion::pedersen::commit_bytes(amount, &nonce).to_vec())
}

/// The commitment for a signed amount: an input commits `+value-fee`, an output
/// `-value-fee`, a blank `0`.
#[wasm_bindgen(js_name = fusionPedersenCommitSigned)]
pub fn fusion_pedersen_commit_signed(amount: i64, nonce: &[u8]) -> Result<Vec<u8>, JsValue> {
    let nonce = scalar_from(nonce, "pedersen nonce")?;
    Ok(
        crate::fusion::pedersen::encode_uncompressed(
            &crate::fusion::pedersen::commit_point_signed(amount, &nonce),
        )
        .to_vec(),
    )
}

/// The compressed nothing-up-my-sleeve generator H, for callers that check it.
#[wasm_bindgen(js_name = fusionPedersenH)]
pub fn fusion_pedersen_h() -> Vec<u8> {
    use k256::elliptic_curve::group::GroupEncoding;
    crate::fusion::pedersen::h_point()
        .to_affine()
        .to_bytes()
        .to_vec()
}

/// Check packed 65-byte uncompressed commitments against one signed amount and
/// the sum of their nonces. Malformed points fail closed.
#[wasm_bindgen(js_name = fusionPedersenBalanceHolds)]
pub fn fusion_pedersen_balance_holds(
    packed_commitments: &[u8],
    excess_fee: i64,
    total_nonce: &[u8],
) -> Result<bool, JsValue> {
    use k256::ProjectivePoint;

    if packed_commitments.is_empty() || !packed_commitments.len().is_multiple_of(65) {
        return Ok(false);
    }
    let mut sum = ProjectivePoint::IDENTITY;
    for encoded in packed_commitments.as_chunks::<65>().0 {
        let point = match crate::fusion::schnorr::parse_point(encoded) {
            Ok(point) => point,
            Err(_) => return Ok(false),
        };
        sum += point;
    }
    let nonce = scalar_from(total_nonce, "pedersen total nonce")?;
    Ok(sum == crate::fusion::pedersen::commit_point_signed(excess_fee, &nonce))
}

/// Compressed public key for an issuer's non-zero canonical round secret.
#[wasm_bindgen(js_name = fusionBlindIssuerPublicKey)]
pub fn fusion_blind_issuer_public_key(secret: &[u8]) -> Result<Vec<u8>, JsValue> {
    Ok(crate::fusion::schnorr::pubkey_compressed(scalar_from(secret, "issuer secret")?).to_vec())
}

/// Compressed one-shot nonce point published for a credential slot.
#[wasm_bindgen(js_name = fusionBlindIssuerNoncePoint)]
pub fn fusion_blind_issuer_nonce_point(nonce: &[u8]) -> Result<Vec<u8>, JsValue> {
    Ok(crate::fusion::schnorr::pubkey_compressed(scalar_from(nonce, "issuer nonce")?).to_vec())
}

/// Sign one blinded challenge with caller-owned issuer secret and nonce.
#[wasm_bindgen(js_name = fusionBlindIssuerSign)]
pub fn fusion_blind_issuer_sign(
    secret: &[u8],
    nonce: &[u8],
    challenge: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let mut issuer = crate::fusion::schnorr::BlindIssuer::from_parts(
        scalar_from(secret, "issuer secret")?,
        vec![scalar_from(nonce, "issuer nonce")?],
    )
    .map_err(|e| JsValue::from_str(&e))?;
    issuer
        .sign(0, &array32(challenge, "blinded challenge")?)
        .map(|response| response.to_vec())
        .map_err(|e| JsValue::from_str(&e))
}

/// The 32-byte blinded challenge to send to the issuer. `a` and `b` must be
/// fresh uniform scalars from the caller's CSPRNG and must never be reused.
///
/// There is no handle to keep: `fusionFinalizeBlindSignature` takes the same
/// five inputs again and rebuilds the request, so nothing on the JS side owns
/// Rust memory it would have to free.
#[wasm_bindgen(js_name = fusionBlindRequest)]
pub fn fusion_blind_request(
    round_pubkey: &[u8],
    r_point: &[u8],
    message: &[u8],
    a: &[u8],
    b: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let msg = array32(message, "message")?;
    let request = crate::fusion::schnorr::BlindSignatureRequest::new_with_blinding(
        round_pubkey,
        r_point,
        msg,
        scalar_from(a, "blinding factor a")?,
        scalar_from(b, "blinding factor b")?,
    )
    .map_err(|e| JsValue::from_str(&e))?;
    Ok(request.request().to_vec())
}

/// Complete a blinded signature. Takes the same inputs the request was built
/// from plus the issuer's 32-byte response, and returns the 64-byte signature.
/// Always verifies before returning, so a cheating issuer is an error here
/// rather than a rejected signature later in the round.
#[wasm_bindgen(js_name = fusionFinalizeBlindSignature)]
pub fn fusion_finalize_blind_signature(
    round_pubkey: &[u8],
    r_point: &[u8],
    message: &[u8],
    a: &[u8],
    b: &[u8],
    issuer_response: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let msg = array32(message, "message")?;
    let request = crate::fusion::schnorr::BlindSignatureRequest::new_with_blinding(
        round_pubkey,
        r_point,
        msg,
        scalar_from(a, "blinding factor a")?,
        scalar_from(b, "blinding factor b")?,
    )
    .map_err(|e| JsValue::from_str(&e))?;
    let response = array32(issuer_response, "issuer response")?;
    request
        .finalize(&response, true)
        .map(|sig| sig.to_vec())
        .map_err(|e| JsValue::from_str(&e))
}

// ---------------------------------------------------------------------------
// CashConnect signing.
//
// Entry points only; the implementation lives in `connect`. These arrived on
// dev while the RPA and fusion bindings above were being built here. The two
// sets are disjoint, so keeping either side alone would have dropped the
// other's exports from the wallet.
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = connectSigningSerialization)]
pub fn signing_serialization(
    context_json: &str,
    covered: &[u8],
    mode: u8,
) -> Result<Vec<u8>, String> {
    connect::signing_serialization(&connect::parse_context(context_json)?, covered, mode)
}

#[wasm_bindgen(js_name = connectSignInput)]
pub fn sign_input(
    context_json: &str,
    private_key: Vec<u8>,
    covered: &[u8],
    mode: u8,
) -> Result<Vec<u8>, String> {
    // Parse failure must erase the transferred WASM key buffer too.
    let mut key = Zeroizing::new(private_key);
    let context = connect::parse_context(context_json)?;
    connect::sign_input(&context, std::mem::take(&mut *key), covered, mode)
}

#[wasm_bindgen(js_name = connectPublicKey)]
pub fn public_key(private_key: Vec<u8>) -> Result<Vec<u8>, String> {
    connect::public_key(private_key)
}

#[wasm_bindgen(js_name = connectSignP2pkh)]
pub fn sign_p2pkh(context_json: &str, private_key: Vec<u8>, mode: u8) -> Result<Vec<u8>, String> {
    let mut key = Zeroizing::new(private_key);
    let context = connect::parse_context(context_json)?;
    connect::sign_p2pkh(&context, std::mem::take(&mut *key), mode)
}

#[wasm_bindgen(js_name = connectP2pkhLock)]
pub fn p2pkh_lock(public_key: &[u8]) -> Result<Vec<u8>, String> {
    connect::p2pkh_lock(public_key)
}

// ---------------------------------------------------------------------------
// Ledger Bitcoin Cash APDUs.
//
// Exposed so `src/services/hardware/ledgerBchApdu.ts` becomes a call-through
// instead of a second encoder. Ledger ships no signer kit for this chain, so
// the app-binder is ours -- and two copies of it are two things that can
// disagree with the device about which address a path holds.
// ---------------------------------------------------------------------------

fn ledger_format(name: &str) -> Result<crate::ledger::AddressFormat, JsValue> {
    use crate::ledger::AddressFormat;
    match name {
        "legacy" => Ok(AddressFormat::Legacy),
        "p2sh" => Ok(AddressFormat::P2sh),
        "bech32" => Ok(AddressFormat::Bech32),
        "cashaddr" => Ok(AddressFormat::Cashaddr),
        other => Err(JsValue::from_str(&format!(
            "unknown Ledger address format '{other}'"
        ))),
    }
}

/// The P2 value for an address encoding. `cashaddr` is 3.
#[wasm_bindgen(js_name = ledgerAddressFormat)]
pub fn ledger_address_format(name: &str) -> Result<u8, JsValue> {
    Ok(ledger_format(name)?.code())
}

/// A BIP32 path as the Bitcoin app expects it: count byte, then big-endian
/// u32 per level with the high bit set on hardened levels.
#[wasm_bindgen(js_name = ledgerEncodeBip32Path)]
pub fn ledger_encode_bip32_path(path: &str) -> Result<Vec<u8>, JsValue> {
    crate::ledger::encode_bip32_path(path).map_err(err)
}

/// GET WALLET PUBLIC KEY, as JSON so the renderer can frame it.
///
/// `format` defaults to cashaddr when empty: a Ledger asked for the app
/// default returns a legacy address, which is a real address on the same
/// chain that no modern Bitcoin Cash wallet displays.
#[wasm_bindgen(js_name = ledgerGetWalletPublicKey)]
pub fn ledger_get_wallet_public_key(
    path: &str,
    verify: bool,
    format: &str,
) -> Result<String, JsValue> {
    let format = if format.is_empty() {
        crate::ledger::AddressFormat::default()
    } else {
        ledger_format(format)?
    };
    let apdu = crate::ledger::build_get_wallet_public_key(path, verify, format).map_err(err)?;
    let hex = |bytes: &[u8]| -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() };
    Ok(format!(
        r#"{{"cla":{},"ins":{},"p1":{},"p2":{},"data":"{}","apdu":"{}"}}"#,
        apdu.cla,
        apdu.ins,
        apdu.p1,
        apdu.p2,
        hex(&apdu.data),
        hex(&apdu.to_bytes()),
    ))
}

/// Read the device's reply. Every length is checked against what arrived, so
/// a truncated reply is refused rather than read as a short address.
#[wasm_bindgen(js_name = ledgerParseWalletPublicKey)]
pub fn ledger_parse_wallet_public_key(response: &[u8]) -> Result<String, JsValue> {
    let parsed = crate::ledger::parse_wallet_public_key(response).map_err(err)?;
    Ok(format!(
        r#"{{"publicKey":"{}","address":"{}","chainCode":"{}"}}"#,
        parsed.public_key, parsed.address, parsed.chain_code,
    ))
}

/// A status word as something the holder can act on. Empty string is success.
#[wasm_bindgen(js_name = ledgerStatusWord)]
pub fn ledger_status_word(status: u16) -> String {
    crate::ledger::describe_status_word(status).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Block explorer routing (#75 row 15)
//
// The renderer used to hold its own copy of the presets and build these URLs
// itself, with no notion of the connection policy -- so a holder on "own
// infrastructure only" could open a transaction and hand its txid to a public
// website. These entry points make the Rust the only place that decides.
// ---------------------------------------------------------------------------

fn explorer_object<'a>(
    kind: &str,
    value: &'a str,
) -> Result<crate::explorer::ExplorerObject<'a>, JsValue> {
    match kind {
        "tx" | "txid" | "transaction" => Ok(crate::explorer::ExplorerObject::Transaction(value)),
        "address" => Ok(crate::explorer::ExplorerObject::Address(value)),
        "block" => Ok(crate::explorer::ExplorerObject::Block(value)),
        other => Err(JsValue::from_str(&format!(
            "not something an explorer can show: {other}"
        ))),
    }
}

fn explorer_policy(name: &str) -> crate::explorer::ExplorerPolicy {
    crate::explorer::ExplorerPolicy::for_chain_policy(name)
}

/// Quote a string as JSON. serde_json rather than a hand-rolled escaper: the
/// presets are all plain ASCII today, so a homemade one would look correct
/// forever and break the first time a label carried a quote.
fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// Every shipped preset, as JSON, so the settings picker lists exactly what
/// the router will accept.
#[wasm_bindgen(js_name = explorerPresets)]
pub fn explorer_presets() -> String {
    let entries: Vec<String> = crate::explorer::PRESETS
        .iter()
        .map(|entry| {
            let mut fields = vec![
                format!("\"id\":{}", json_string(entry.id)),
                format!("\"label\":{}", json_string(entry.label)),
                format!("\"tx\":{}", json_string(entry.tx)),
                format!("\"address\":{}", json_string(entry.address)),
            ];
            if let Some(block) = entry.block {
                fields.push(format!("\"block\":{}", json_string(block)));
            }
            if let Some(tx) = entry.chipnet_tx {
                fields.push(format!("\"chipnetTx\":{}", json_string(tx)));
            }
            if let Some(address) = entry.chipnet_address {
                fields.push(format!("\"chipnetAddress\":{}", json_string(address)));
            }
            format!("{{{}}}", fields.join(","))
        })
        .collect();
    format!("[{}]", entries.join(","))
}

/// The preset used when the holder has not chosen one.
#[wasm_bindgen(js_name = explorerDefaultPresetId)]
pub fn explorer_default_preset_id() -> String {
    crate::explorer::DEFAULT_PRESET_ID.to_string()
}

/// What a chain connection policy means for explorer links:
/// `public-allowed`, `user-owned-only` or `disabled`.
#[wasm_bindgen(js_name = explorerPolicyForChainPolicy)]
pub fn explorer_policy_for_chain_policy(policy: &str) -> String {
    match explorer_policy(policy) {
        crate::explorer::ExplorerPolicy::PublicAllowed => "public-allowed",
        crate::explorer::ExplorerPolicy::UserOwnedOnly => "user-owned-only",
        crate::explorer::ExplorerPolicy::Disabled => "disabled",
    }
    .to_string()
}

/// A link to one of the shipped public explorers, or an error explaining why
/// the policy refuses it.
#[wasm_bindgen(js_name = explorerPresetUrl)]
pub fn explorer_preset_url(
    preset_id: &str,
    network: &str,
    kind: &str,
    value: &str,
    chain_policy: &str,
) -> Result<String, JsValue> {
    crate::explorer::explorer_url(
        &crate::explorer::ExplorerChoice::Preset(preset_id.to_string()),
        network_from(network)?,
        explorer_object(kind, value)?,
        explorer_policy(chain_policy),
    )
    .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// A link to the holder's own explorer, from the templates they supplied.
#[wasm_bindgen(js_name = explorerCustomUrl)]
pub fn explorer_custom_url(
    tx_template: &str,
    address_template: &str,
    network: &str,
    kind: &str,
    value: &str,
    chain_policy: &str,
) -> Result<String, JsValue> {
    crate::explorer::explorer_url(
        &crate::explorer::ExplorerChoice::Custom {
            tx: tx_template.to_string(),
            address: address_template.to_string(),
        },
        network_from(network)?,
        explorer_object(kind, value)?,
        explorer_policy(chain_policy),
    )
    .map_err(|error| JsValue::from_str(&error.to_string()))
}
